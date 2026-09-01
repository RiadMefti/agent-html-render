import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PACKAGE_VERSION } from "../shared/version.js";
import {
  assertPinnedDirectories,
  assertPinnedDirectory,
  pinDirectoryIdentity,
  StateDirectoryBoundaryError,
  type PinnedDirectoryIdentity,
} from "./state-boundary.js";
import { ensureStateDirectory } from "./store.js";

const MANAGED_RECEIPT = ".agent-html-render-managed.json";

interface ManagedReceipt {
  format: 1;
  packageVersion: string;
  files: Record<string, string>;
  directories?: string[];
}

interface SkillTree {
  files: string[];
  directories: string[];
}

interface SkillSnapshot {
  files: Record<string, string>;
  directories: string[];
}

type BoundaryCheck = () => Promise<void>;

const uncheckedBoundary: BoundaryCheck = async () => undefined;

export interface SkillInstallResult {
  canonicalPath: string;
  claudePath: string;
  canonicalStatus: "installed" | "updated" | "present";
  claudeStatus: "linked" | "copied" | "updated" | "present";
  legacyPaths: string[];
  warnings: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureLocalDirectoryPath(
  rootPath: string,
  directory: string,
  assertBoundary: BoundaryCheck = uncheckedBoundary,
): Promise<void> {
  await assertBoundary();
  const relativePath = relative(rootPath, directory);
  let current = rootPath;
  for (const segment of relativePath.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`The skill install path must stay in regular directories inside ${rootPath}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  await assertBoundary();
  await mkdir(directory, { recursive: true });
  await assertBoundary();
  if ((await realpath(directory)) !== directory) {
    throw new Error(`The skill install path must stay inside ${rootPath}.`);
  }
}

async function skillTree(root: string, directory = root): Promise<SkillTree> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(directory, entry.name);
    if (directory === root && entry.name === MANAGED_RECEIPT) {
      const details = await lstat(absolutePath);
      if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
        throw new Error("The managed skill receipt must be a regular file with one filesystem link.");
      }
      continue;
    }
    if (entry.isDirectory()) {
      directories.push(relative(root, absolutePath).replaceAll("\\", "/"));
      const nested = await skillTree(root, absolutePath);
      files.push(...nested.files);
      directories.push(...nested.directories);
    }
    else if (entry.isFile()) files.push(relative(root, absolutePath).replaceAll("\\", "/"));
    else throw new Error(`The managed skill contains an unsupported filesystem entry: ${absolutePath}`);
  }
  return { files, directories };
}

async function skillHashes(directory: string, files: readonly string[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const content = await readFile(join(directory, file));
        return [file, createHash("sha256").update(content).digest("hex")] as const;
      }),
    ),
  );
}

async function skillSnapshot(directory: string): Promise<SkillSnapshot> {
  const tree = await skillTree(directory);
  return { files: await skillHashes(directory, tree.files), directories: tree.directories };
}

function sameHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length && leftEntries.every(([file, hash]) => right[file] === hash);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function directoriesImpliedByFiles(files: Record<string, string>): string[] {
  const directories = new Set<string>();
  for (const file of Object.keys(files)) {
    const segments = file.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
  }
  return Array.from(directories).sort((left, right) => left.localeCompare(right));
}

async function matchingBundledSkillSnapshot(source: string, target: string): Promise<SkillSnapshot | undefined> {
  try {
    const [expected, actual] = await Promise.all([skillSnapshot(source), skillSnapshot(target)]);
    return sameHashes(expected.files, actual.files) && samePaths(expected.directories, actual.directories)
      ? expected
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeManagedReceipt(
  directory: string,
  files?: Record<string, string>,
  directories?: string[],
  assertBoundary: BoundaryCheck = uncheckedBoundary,
): Promise<void> {
  await assertBoundary();
  const snapshot = files && directories ? { files, directories } : await skillSnapshot(directory);
  await assertBoundary();
  const receipt: ManagedReceipt = {
    format: 1,
    packageVersion: PACKAGE_VERSION,
    files: snapshot.files,
    directories: snapshot.directories,
  };
  const target = join(directory, MANAGED_RECEIPT);
  const temporary = join(directory, `.${MANAGED_RECEIPT}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    await assertBoundary();
    try {
      const targetDetails = await lstat(target);
      if (targetDetails.isSymbolicLink() || !targetDetails.isFile() || targetDetails.nlink !== 1) {
        throw new Error("The managed skill receipt must be a regular file with one filesystem link.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    temporaryCreated = true;
    try {
      await assertBoundary();
      const [opened, current] = await Promise.all([handle.stat(), lstat(temporary)]);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1 ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      ) throw new Error("The managed skill receipt temporary file changed before it was written.");
      await assertBoundary();
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertBoundary();
    try {
      const targetDetails = await lstat(target);
      if (targetDetails.isSymbolicLink() || !targetDetails.isFile() || targetDetails.nlink !== 1) {
        throw new Error("The managed skill receipt must be a regular file with one filesystem link.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await assertBoundary();
    await rename(temporary, target);
    temporaryCreated = false;
    await assertBoundary();
  } finally {
    if (temporaryCreated) {
      try {
        await assertBoundary();
        await rm(temporary, { force: true });
      } catch {
        // Never redirect cleanup into a replacement skill directory.
      }
    }
  }
}

async function managedTargetIsUnchanged(
  target: string,
  assertBoundary: BoundaryCheck = uncheckedBoundary,
): Promise<boolean> {
  try {
    await assertBoundary();
    const receiptPath = join(target, MANAGED_RECEIPT);
    const receiptDetails = await lstat(receiptPath);
    if (receiptDetails.isSymbolicLink() || !receiptDetails.isFile() || receiptDetails.nlink !== 1) return false;
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Partial<ManagedReceipt>;
    if (receipt.format !== 1 || !receipt.files || typeof receipt.files !== "object") return false;
    const current = await skillSnapshot(target);
    await assertBoundary();
    const expectedDirectories = Array.isArray(receipt.directories) && receipt.directories.every((path) => typeof path === "string")
      ? [...receipt.directories].sort((left, right) => left.localeCompare(right))
      : directoriesImpliedByFiles(receipt.files);
    return sameHashes(receipt.files, current.files) && samePaths(expectedDirectories, current.directories);
  } catch (error) {
    if (error instanceof StateDirectoryBoundaryError) throw error;
    return false;
  }
}

async function copyManagedSkill(
  source: string,
  target: string,
  assertBoundary: BoundaryCheck = uncheckedBoundary,
): Promise<void> {
  await assertBoundary();
  try {
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    await assertBoundary();
    throw error;
  }
  await assertBoundary();
  const targetIdentity = await pinDirectoryIdentity(target, "The staged managed skill directory");
  const assertTarget = async (): Promise<void> => {
    await assertBoundary();
    await assertPinnedDirectory(targetIdentity, "The staged managed skill directory");
  };
  await writeManagedReceipt(target, undefined, undefined, assertTarget);
  await assertTarget();
}

async function retainCommittedManagedBackup(
  backup: string,
  backupIdentity: PinnedDirectoryIdentity,
  assertBoundary: BoundaryCheck,
): Promise<string> {
  const assertBackup = async (): Promise<void> => {
    await assertBoundary();
    await assertPinnedDirectory(backupIdentity, "The managed skill backup");
  };
  await assertBackup();
  const unchanged = await managedTargetIsUnchanged(backup, assertBackup);
  await assertBackup();
  // A process may still hold an ordinary file handle opened before the atomic
  // directory replacement. POSIX does not expose a portable way to prove that no
  // such editor can save later, so deleting the old inode here could make that save
  // unreachable. Retain the verified tree and tell the user exactly what remains.
  return unchanged
    ? `The prior managed skill was retained at ${backup} to protect saves from editors that still have old files open. Remove it after those editors are closed.`
    : `The prior managed skill changed during the update and was retained at ${backup}. Review it before removing it.`;
}

async function replaceManagedSkill(
  source: string,
  target: string,
  targetIdentity: PinnedDirectoryIdentity,
  backupDirectory: string,
  backupKind: "agents" | "claude",
  assertBoundary: BoundaryCheck,
): Promise<string | undefined> {
  const parent = dirname(target);
  const temporary = join(parent, `.agent-html-render-${randomUUID()}`);
  const backup = join(backupDirectory, `${backupKind}-agent-html-render-${randomUUID()}`);
  const assertTarget = async (): Promise<void> => {
    await assertBoundary();
    await assertPinnedDirectory(targetIdentity, "The managed skill target");
  };
  let targetMoved = false;
  let replacementPublished = false;
  let committedBackupIdentity: PinnedDirectoryIdentity | undefined;
  try {
    await copyManagedSkill(source, temporary, assertTarget);
    if (!await managedTargetIsUnchanged(target, assertTarget)) {
      throw new Error(`The managed skill changed while Agent HTML Render was preparing its update: ${target}`);
    }
    await assertTarget();
    await rename(target, backup);
    targetMoved = true;
    await assertBoundary();
    const backupIdentity = await pinDirectoryIdentity(backup, "The managed skill backup");
    committedBackupIdentity = backupIdentity;
    if (
      backupIdentity.device !== targetIdentity.device ||
      backupIdentity.inode !== targetIdentity.inode
    ) {
      throw new StateDirectoryBoundaryError(
        "The managed skill target changed while Agent HTML Render was moving it into a private backup.",
      );
    }
    const assertBackup = async (): Promise<void> => {
      await assertBoundary();
      await assertPinnedDirectory(backupIdentity, "The managed skill backup");
    };
    if (!await managedTargetIsUnchanged(backup, assertBackup)) {
      throw new Error(`The managed skill changed while Agent HTML Render was preparing its update: ${target}`);
    }
    await assertBackup();
    if (await pathExists(target)) {
      throw new Error(`A different skill appeared at ${target} while Agent HTML Render was updating.`);
    }
    await assertBackup();
    await rename(temporary, target);
    replacementPublished = true;
    await assertBoundary();
  } catch (error) {
    if (targetMoved && !replacementPublished) {
      try {
        await assertBoundary();
        if (!await pathExists(target)) await rename(backup, target);
      } catch {
        // A changed boundary is never repaired through its replacement pathname.
      }
    }
    try {
      await assertBoundary();
      await rm(temporary, { recursive: true, force: true });
    } catch {
      // Never redirect staged-skill cleanup into a replacement project.
    }
    throw error;
  }
  if (!replacementPublished || !committedBackupIdentity) {
    throw new Error("The managed skill replacement did not reach its commit point.");
  }
  return retainCommittedManagedBackup(backup, committedBackupIdentity, assertBoundary);
}

async function installManagedCopy(
  source: string,
  target: string,
  assertBoundary: BoundaryCheck,
): Promise<void> {
  const temporary = join(dirname(target), `.agent-html-render-${randomUUID()}`);
  let published = false;
  try {
    await copyManagedSkill(source, temporary, assertBoundary);
    await assertBoundary();
    if (await pathExists(target)) {
      throw new Error(`A different skill appeared at ${target} while Agent HTML Render was installing.`);
    }
    await assertBoundary();
    await rename(temporary, target);
    published = true;
    await assertBoundary();
  } finally {
    if (!published) {
      try {
        await assertBoundary();
        await rm(temporary, { recursive: true, force: true });
      } catch {
        // Never redirect staged-skill cleanup into a replacement project.
      }
    }
  }
}

async function installCanonical(
  source: string,
  target: string,
  backupDirectory: string,
  assertBoundary: BoundaryCheck,
  warnings: string[],
): Promise<"installed" | "updated" | "present"> {
  await assertBoundary();
  if (await pathExists(target)) {
    const details = await lstat(target);
    if (details.isSymbolicLink()) {
      throw new Error(`The canonical Agent HTML Render skill must not be a symbolic link: ${target}`);
    }
    if (!details.isDirectory()) {
      throw new Error(`A different skill already exists at ${target}. Move it aside before installing Agent HTML Render.`);
    }
    const targetIdentity = await pinDirectoryIdentity(target, "The canonical managed skill target");
    const assertTarget = async (): Promise<void> => {
      await assertBoundary();
      await assertPinnedDirectory(targetIdentity, "The canonical managed skill target");
    };
    const matchingSnapshot = await matchingBundledSkillSnapshot(source, target);
    if (matchingSnapshot) {
      await assertTarget();
      await writeManagedReceipt(
        target,
        matchingSnapshot.files,
        matchingSnapshot.directories,
        assertTarget,
      );
      return "present";
    }
    await assertTarget();
    if (await managedTargetIsUnchanged(target, assertTarget)) {
      const warning = await replaceManagedSkill(
        source,
        target,
        targetIdentity,
        backupDirectory,
        "agents",
        assertBoundary,
      );
      if (warning) warnings.push(warning);
      return "updated";
    }
    throw new Error(
      `A different skill already exists at ${target}. Move it aside before installing Agent HTML Render.`,
    );
  }
  await assertBoundary();
  await installManagedCopy(source, target, assertBoundary);
  return "installed";
}

async function installAdapter(
  source: string,
  canonicalPath: string,
  target: string,
  backupDirectory: string,
  assertBoundary: BoundaryCheck,
  warnings: string[],
): Promise<"linked" | "copied" | "updated" | "present"> {
  await assertBoundary();
  if (await pathExists(target)) {
    const details = await lstat(target);
    if (details.isSymbolicLink()) {
      const linkedTarget = await realpath(target);
      await assertBoundary();
      if (linkedTarget === (await realpath(canonicalPath))) return "present";
      throw new Error(`A different skill link already exists at ${target}. Move it aside before installing Agent HTML Render.`);
    }
    if (!details.isDirectory()) {
      throw new Error(`A different skill already exists at ${target}. Move it aside before installing Agent HTML Render.`);
    }
    const targetIdentity = await pinDirectoryIdentity(target, "The Claude managed skill target");
    const assertTarget = async (): Promise<void> => {
      await assertBoundary();
      await assertPinnedDirectory(targetIdentity, "The Claude managed skill target");
    };
    const matchingSnapshot = await matchingBundledSkillSnapshot(source, target);
    if (matchingSnapshot) {
      await assertTarget();
      await writeManagedReceipt(
        target,
        matchingSnapshot.files,
        matchingSnapshot.directories,
        assertTarget,
      );
      return "present";
    }
    await assertTarget();
    if (await managedTargetIsUnchanged(target, assertTarget)) {
      const warning = await replaceManagedSkill(
        source,
        target,
        targetIdentity,
        backupDirectory,
        "claude",
        assertBoundary,
      );
      if (warning) warnings.push(warning);
      return "updated";
    }
    throw new Error(
      `A different skill already exists at ${target}. Move it aside before installing Agent HTML Render.`,
    );
  }
  const temporaryLink = join(dirname(target), `.agent-html-render-adapter-${randomUUID()}`);
  let linkPublished = false;
  try {
    await assertBoundary();
    if (await pathExists(target)) {
      throw new Error(`A different skill appeared at ${target} while Agent HTML Render was installing.`);
    }
    await assertBoundary();
    const linkTarget = process.platform === "win32" ? canonicalPath : relative(dirname(target), canonicalPath);
    await symlink(linkTarget, temporaryLink, process.platform === "win32" ? "junction" : "dir");
    await assertBoundary();
    if (await pathExists(target)) {
      throw new Error(`A different skill appeared at ${target} while Agent HTML Render was installing.`);
    }
    await assertBoundary();
    await rename(temporaryLink, target);
    linkPublished = true;
    await assertBoundary();
    return "linked";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(code)) throw error;
    await installManagedCopy(source, target, assertBoundary);
    return "copied";
  } finally {
    if (!linkPublished) {
      try {
        await assertBoundary();
        await rm(temporaryLink, { recursive: true, force: true });
      } catch {
        // Never redirect adapter cleanup into a replacement project.
      }
    }
  }
}

export async function installProjectSkill(rootPath: string, sourceDirectory: string): Promise<SkillInstallResult> {
  await readFile(join(sourceDirectory, "SKILL.md"), "utf8");
  const canonicalSource = await realpath(sourceDirectory);
  const canonicalRoot = await realpath(rootPath);
  const [rootIdentity, sourceIdentity] = await Promise.all([
    pinDirectoryIdentity(canonicalRoot, "The project root for skill installation"),
    pinDirectoryIdentity(canonicalSource, "The bundled skill source"),
  ]);
  const assertRootAndSource = async (): Promise<void> => {
    await assertPinnedDirectories([
      [rootIdentity, "The project root for skill installation"],
      [sourceIdentity, "The bundled skill source"],
    ]);
  };
  const canonicalPath = join(canonicalRoot, ".agents", "skills", "agent-html-render");
  const claudePath = join(canonicalRoot, ".claude", "skills", "agent-html-render");
  await assertRootAndSource();
  const stateDirectory = await ensureStateDirectory(canonicalRoot, rootIdentity);
  await assertRootAndSource();
  const backupDirectory = join(stateDirectory, "skill-backups");
  const canonicalParentPath = dirname(canonicalPath);
  const claudeParentPath = dirname(claudePath);
  await ensureLocalDirectoryPath(canonicalRoot, canonicalParentPath, assertRootAndSource);
  const canonicalParentIdentity = await pinDirectoryIdentity(
    canonicalParentPath,
    "The .agents/skills install directory",
  );
  const assertCanonicalBoundary = async (): Promise<void> => {
    await assertRootAndSource();
    await assertPinnedDirectory(canonicalParentIdentity, "The .agents/skills install directory");
  };
  await ensureLocalDirectoryPath(canonicalRoot, claudeParentPath, assertCanonicalBoundary);
  const claudeParentIdentity = await pinDirectoryIdentity(
    claudeParentPath,
    "The .claude/skills install directory",
  );
  const assertHostParentsBoundary = async (): Promise<void> => {
    await assertPinnedDirectories([
      [rootIdentity, "The project root for skill installation"],
      [sourceIdentity, "The bundled skill source"],
      [canonicalParentIdentity, "The .agents/skills install directory"],
      [claudeParentIdentity, "The .claude/skills install directory"],
    ]);
  };
  await ensureLocalDirectoryPath(canonicalRoot, backupDirectory, assertHostParentsBoundary);
  const backupDirectoryIdentity = await pinDirectoryIdentity(
    backupDirectory,
    "The managed skill backup directory",
  );
  const assertInstallBoundary = async (): Promise<void> => {
    await assertPinnedDirectories([
      [rootIdentity, "The project root for skill installation"],
      [sourceIdentity, "The bundled skill source"],
      [canonicalParentIdentity, "The .agents/skills install directory"],
      [claudeParentIdentity, "The .claude/skills install directory"],
      [backupDirectoryIdentity, "The managed skill backup directory"],
    ]);
  };
  await assertInstallBoundary();
  const legacyCandidates = [
    join(canonicalRoot, ".agents", "skills", "agentlens"),
    join(canonicalRoot, ".claude", "skills", "agentlens"),
    join(canonicalRoot, ".agents", "skills", "agentrender"),
    join(canonicalRoot, ".claude", "skills", "agentrender"),
  ];
  const warnings: string[] = [];
  const canonicalStatus = await installCanonical(
    canonicalSource,
    canonicalPath,
    backupDirectory,
    assertInstallBoundary,
    warnings,
  );
  const claudeStatus = await installAdapter(
    canonicalSource,
    canonicalPath,
    claudePath,
    backupDirectory,
    assertInstallBoundary,
    warnings,
  );
  const legacyPaths: string[] = [];
  for (const candidate of legacyCandidates) {
    await assertInstallBoundary();
    if (await pathExists(candidate)) legacyPaths.push(candidate);
  }
  await assertInstallBoundary();
  return {
    canonicalPath,
    claudePath,
    canonicalStatus,
    claudeStatus,
    legacyPaths,
    warnings,
  };
}
