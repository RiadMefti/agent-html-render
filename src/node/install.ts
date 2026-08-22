import { cp, lstat, mkdir, readFile, rename, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

export interface SkillInstallResult {
  canonicalPath: string;
  claudePath: string;
  canonicalStatus: "installed" | "present";
  claudeStatus: "linked" | "copied" | "present";
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

async function sameBundledSkill(source: string, target: string): Promise<boolean> {
  try {
    const files = ["SKILL.md", join("references", "theme.md")];
    const comparisons = await Promise.all(
      files.map(async (file) => {
        const [expected, actual] = await Promise.all([
          readFile(join(source, file), "utf8"),
          readFile(join(target, file), "utf8"),
        ]);
        return expected === actual;
      }),
    );
    return comparisons.every(Boolean);
  } catch {
    return false;
  }
}

async function installCanonical(source: string, target: string): Promise<"installed" | "present"> {
  if (await pathExists(target)) {
    if (await sameBundledSkill(source, target)) return "present";
    throw new Error(
      `A different skill already exists at ${target}. Move it aside before installing AgentLens.`,
    );
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.agentlens-${randomUUID()}`);
  await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
  await rename(temporary, target);
  return "installed";
}

async function installClaudeLink(
  source: string,
  canonicalPath: string,
  target: string,
): Promise<"linked" | "copied" | "present"> {
  if (await pathExists(target)) {
    if (await sameBundledSkill(source, target)) return "present";
    throw new Error(
      `A different skill already exists at ${target}. Move it aside before installing AgentLens.`,
    );
  }
  await mkdir(dirname(target), { recursive: true });
  try {
    const linkTarget = process.platform === "win32" ? canonicalPath : relative(dirname(target), canonicalPath);
    await symlink(linkTarget, target, process.platform === "win32" ? "junction" : "dir");
    return "linked";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(code)) throw error;
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
    return "copied";
  }
}

export async function installProjectSkill(rootPath: string, sourceDirectory: string): Promise<SkillInstallResult> {
  await readFile(join(sourceDirectory, "SKILL.md"), "utf8");
  const canonicalPath = join(rootPath, ".agents", "skills", "agentlens");
  const claudePath = join(rootPath, ".claude", "skills", "agentlens");
  const canonicalStatus = await installCanonical(sourceDirectory, canonicalPath);
  const claudeStatus = await installClaudeLink(sourceDirectory, canonicalPath, claudePath);
  return { canonicalPath, claudePath, canonicalStatus, claudeStatus };
}
