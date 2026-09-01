import { constants } from "node:fs";
import { access, lstat, readdir, realpath } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { readCurrentRuntimeBuildIdentity } from "./build.js";
import {
  agentHtmlRenderStateDirectory,
  daemonProcessIsAlive,
  daemonLogPath,
  inspectStartupCoordinator,
  inspectStartupLock,
  inspectDaemon,
  readDaemonMetadata,
  startupCoordinatorIsSupported,
} from "./daemon.js";

export interface DoctorReport {
  ok: boolean;
  coreReady: boolean;
  agentIntegrationReady: boolean;
  node: { version: string; supported: boolean };
  platform: { name: NodeJS.Platform; supported: boolean };
  project: { rootPath: string; writable: boolean };
  daemon: {
    recorded: boolean;
    running: boolean;
    compatible: boolean;
    processAlive?: boolean;
    pid?: number;
    port?: number;
    packageVersion?: string;
    startedAt?: string;
  };
  skills: {
    canonicalPath: string;
    canonicalInstalled: boolean;
    claudePath: string;
    claudeInstalled: boolean;
  };
  hosts: { codex: boolean; claude: boolean; opencode: boolean };
  state: {
    directory: string;
    validBoundary: boolean;
    gitIgnoreInstalled: boolean;
    logPath: string;
    startupCoordinator: Awaited<ReturnType<typeof inspectStartupCoordinator>>;
    startupLock: Awaited<ReturnType<typeof inspectStartupLock>>;
  };
  recommendations: string[];
}

export function runtimeIsSupported(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0);
  return major === 26;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function directoryIsLocalOrMissing(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isDirectory() && !details.isSymbolicLink() && (await realpath(path)) === path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function regularFileIsLocalOrMissing(path: string, privateFile = false): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isFile() &&
      !details.isSymbolicLink() &&
      details.nlink === 1 &&
      (!privateFile || (details.mode & 0o777) === 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function privateDirectoryEntriesAreSafeOrMissing(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      let details: Awaited<ReturnType<typeof lstat>>;
      try {
        details = await lstat(join(path, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        details.isSymbolicLink() ||
        !details.isFile() ||
        details.nlink !== 1 ||
        (details.mode & 0o777) !== 0o600
      ) return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function matchingPrivateEntriesAreSafeOrMissing(
  path: string,
  pattern: RegExp,
): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (!pattern.test(entry.name)) continue;
      try {
        const details = await lstat(join(path, entry.name));
        if (
          details.isSymbolicLink() ||
          !details.isFile() ||
          details.nlink !== 1 ||
          (details.mode & 0o777) !== 0o600
        ) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function commandExists(command: string): Promise<boolean> {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      try {
        await access(join(directory, `${command}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Continue through PATH without executing an untrusted host command.
      }
    }
  }
  return false;
}

export async function diagnoseProject(rootInput: string): Promise<DoctorReport> {
  const rootPath = await realpath(resolve(rootInput));
  let writable = true;
  try {
    await access(rootPath, constants.R_OK | constants.W_OK);
  } catch {
    writable = false;
  }
  const stateDirectory = agentHtmlRenderStateDirectory(rootPath);
  const baseValidStateBoundary =
    await directoryIsLocalOrMissing(stateDirectory) &&
    await directoryIsLocalOrMissing(join(stateDirectory, "sessions")) &&
    await privateDirectoryEntriesAreSafeOrMissing(join(stateDirectory, "sessions")) &&
    await regularFileIsLocalOrMissing(join(stateDirectory, ".gitignore")) &&
    await regularFileIsLocalOrMissing(join(stateDirectory, "daemon.json"), true) &&
    await regularFileIsLocalOrMissing(join(stateDirectory, "daemon.json.tmp"), true) &&
    await matchingPrivateEntriesAreSafeOrMissing(
      stateDirectory,
      /^daemon\.json\.[a-f0-9]{24}\.tmp$/u,
    ) &&
    await regularFileIsLocalOrMissing(join(stateDirectory, "daemon.lock"), true) &&
    await matchingPrivateEntriesAreSafeOrMissing(
      stateDirectory,
      /^daemon\.lock\.retired-[a-f0-9]{24}$/u,
    ) &&
    await regularFileIsLocalOrMissing(join(stateDirectory, "daemon.log"), true);
  const startupLock = baseValidStateBoundary
    ? await inspectStartupLock(rootPath)
    : { path: join(stateDirectory, "daemon.lock"), status: "unsafe" as const };
  const startupCoordinator = baseValidStateBoundary
    ? await inspectStartupCoordinator(rootPath)
    : { status: "unavailable" as const };
  const validStateBoundary = baseValidStateBoundary && startupLock.status !== "unsafe";
  const metadata = validStateBoundary ? await readDaemonMetadata(rootPath) : undefined;
  const initialDaemonInspection = metadata
    ? await inspectDaemon(metadata)
    : { healthy: false, compatible: false };
  const daemonInspection = metadata && initialDaemonInspection.healthy
    ? await inspectDaemon(metadata, await readCurrentRuntimeBuildIdentity())
    : initialDaemonInspection;
  const canonicalPath = join(rootPath, ".agents", "skills", "agent-html-render");
  const claudePath = join(rootPath, ".claude", "skills", "agent-html-render");
  const [canonicalInstalled, claudeInstalled, gitIgnoreInstalled, codex, claude, opencode] =
    await Promise.all([
      exists(join(canonicalPath, "SKILL.md")),
      exists(join(claudePath, "SKILL.md")),
      validStateBoundary ? exists(join(stateDirectory, ".gitignore")) : false,
      commandExists("codex"),
      commandExists("claude"),
      commandExists("opencode"),
    ]);
  const nodeSupported = runtimeIsSupported(process.versions.node);
  const platformSupported = startupCoordinatorIsSupported();
  const recordedProcessAlive = metadata ? daemonProcessIsAlive(metadata.pid) : false;
  const coordinatorReady = metadata
    ? startupCoordinator.status === "busy" && daemonInspection.compatible
    : startupCoordinator.status === "idle";
  const coreReady = nodeSupported &&
    platformSupported &&
    writable &&
    validStateBoundary &&
    coordinatorReady &&
    startupLock.status === "missing" &&
    (!metadata || daemonInspection.compatible);
  const agentIntegrationReady =
    canonicalInstalled && (codex || opencode || (claude && claudeInstalled));
  const recommendations: string[] = [];
  if (!nodeSupported) {
    recommendations.push("Use Node.js 22.22.2+ in the Node 22 line, Node.js 24.15+ in Node 24, or Node.js 26.");
  }
  if (!platformSupported) {
    recommendations.push("Use Linux for this beta; collision-free startup coordination currently relies on abstract Unix sockets.");
  }
  if (!writable) recommendations.push("Grant the current user write access to the project root.");
  if (!validStateBoundary) {
    recommendations.push(
      "Repair private-file permissions or move linked, multiply linked, or non-regular .agent-html-render state entries aside before retrying.",
    );
  }
  if (startupLock.status === "stale") {
    recommendations.push(
      `After verifying that no Agent HTML Render process is starting in this project, remove the stale startup lock at ${startupLock.path} and retry.`,
    );
  }
  if (startupLock.status === "active" || startupLock.status === "initializing") {
    recommendations.push(
      `Wait for the current startup to finish. If it does not, verify that no Agent HTML Render process is starting in this project, then remove the legacy startup lock at ${startupLock.path} and retry.`,
    );
  }
  if (
    startupCoordinator.status === "busy" &&
    (!metadata || !daemonInspection.healthy)
  ) {
    recommendations.push(
      "Wait for the current Agent HTML Render startup to finish. If it remains busy, stop the hung Agent HTML Render command and retry.",
    );
  }
  if (startupCoordinator.status === "unavailable" && platformSupported) {
    recommendations.push(
      "Restore local loopback socket access, then rerun doctor before starting a review.",
    );
  }
  if (!canonicalInstalled) recommendations.push("Run agent-html-render install-skill before asking an agent to start reviews.");
  if (
    metadata &&
    !daemonInspection.compatible &&
    !recordedProcessAlive &&
    startupCoordinator.status === "idle" &&
    startupLock.status === "missing"
  ) {
    recommendations.push("Run another Agent HTML Render command to stop and replace stale daemon state with the current build.");
  }
  if (
    metadata &&
    recordedProcessAlive &&
    daemonInspection.healthy &&
    !daemonInspection.compatible
  ) {
    recommendations.push(
      `The running daemon process ${metadata.pid} no longer matches its pinned private state, current runtime, or lifetime coordinator. Run agent-html-render stop --root ${rootPath}, then retry.`,
    );
  }
  if (metadata && recordedProcessAlive && !daemonInspection.healthy) {
    recommendations.push(
      `The recorded daemon process ${metadata.pid} is still alive but not current and healthy. After verifying that PID belongs to this project, stop it before retrying; Agent HTML Render will not start a replacement beside it.`,
    );
  }
  if (!codex && !claude && !opencode) recommendations.push("Install at least one supported CLI agent, or invoke the review CLI manually.");

  return {
    ok: coreReady,
    coreReady,
    agentIntegrationReady,
    node: { version: process.versions.node, supported: nodeSupported },
    platform: { name: process.platform, supported: platformSupported },
    project: { rootPath, writable },
    daemon: {
      recorded: metadata !== undefined,
      running: daemonInspection.healthy,
      compatible: daemonInspection.compatible,
      ...(metadata ? { processAlive: recordedProcessAlive } : {}),
      ...(metadata && daemonInspection.healthy
        ? {
            pid: metadata.pid,
            port: metadata.port,
            ...(metadata.packageVersion ? { packageVersion: metadata.packageVersion } : {}),
            startedAt: metadata.startedAt,
          }
        : {}),
    },
    skills: { canonicalPath, canonicalInstalled, claudePath, claudeInstalled },
    hosts: { codex, claude, opencode },
    state: {
      directory: stateDirectory,
      validBoundary: validStateBoundary,
      gitIgnoreInstalled,
      logPath: daemonLogPath(rootPath),
      startupCoordinator,
      startupLock,
    },
    recommendations,
  };
}
