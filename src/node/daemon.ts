import { spawn, type ChildProcess, type SendHandle } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { createConnection, createServer, Server } from "node:net";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { EXPLICIT_FEEDBACK_ACK_CAPABILITY } from "../shared/protocol.js";
import {
  readCurrentRuntimeBuildIdentity,
  type RuntimeBuildIdentity,
} from "./build.js";
import { resolveRoot } from "./artifact.js";
import {
  ServerProcessTerminationRequiredError,
  startServer,
  type RunningServer,
} from "./server.js";
import { ensureStateDirectory } from "./store.js";
import {
  assertPinnedDirectory,
  assertPinnedStateBoundary,
  pinDirectoryIdentity,
  pinStateBoundary,
  type PinnedDirectoryIdentity,
  type PinnedStateBoundary,
} from "./state-boundary.js";

export interface DaemonMetadata {
  protocolVersion: "1";
  packageVersion?: string;
  buildId?: string;
  pid: number;
  rootPath: string;
  rootDevice?: string;
  rootInode?: string;
  stateDevice?: string;
  stateInode?: string;
  startupCoordinatorId?: string;
  port: number;
  token: string;
  startedAt: string;
}

const START_TIMEOUT_MILLISECONDS = 12_000;
const LOCK_WAIT_MILLISECONDS = 15_000;
const COORDINATOR_PROBE_TIMEOUT_MILLISECONDS = 500;
const COORDINATOR_TRANSFER_TIMEOUT_MILLISECONDS = 5_000;
const DAEMON_STOP_REQUEST_TIMEOUT_MILLISECONDS = 1_000;
const DAEMON_STOP_COMPLETION_TIMEOUT_MILLISECONDS = 2_000;
const DAEMON_STOP_FINAL_OBSERVATION_WINDOW_MILLISECONDS = 100;
export const DAEMON_STOP_TOTAL_TIMEOUT_MILLISECONDS =
  DAEMON_STOP_REQUEST_TIMEOUT_MILLISECONDS + DAEMON_STOP_COMPLETION_TIMEOUT_MILLISECONDS;
export const DAEMON_STOP_TOTAL_TIMEOUT_SECONDS =
  DAEMON_STOP_TOTAL_TIMEOUT_MILLISECONDS / 1_000;
const MAX_DAEMON_LOG_BYTES = 512 * 1024;
const DAEMON_LOG_MAINTENANCE_DRAIN_MILLISECONDS = 750;
const MAX_DAEMON_METADATA_BYTES = 64 * 1024;
const MAX_STARTUP_LOCK_BYTES = 4 * 1024;
const STARTUP_COORDINATOR_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

export function agentHtmlRenderStateDirectory(rootPath: string): string {
  return join(rootPath, ".agent-html-render");
}

export function daemonMetadataPath(rootPath: string): string {
  return join(agentHtmlRenderStateDirectory(rootPath), "daemon.json");
}

export function daemonLockPath(rootPath: string): string {
  return join(agentHtmlRenderStateDirectory(rootPath), "daemon.lock");
}

export function daemonLogPath(rootPath: string): string {
  return join(agentHtmlRenderStateDirectory(rootPath), "daemon.log");
}

export async function readDaemonMetadata(rootPath: string): Promise<DaemonMetadata | undefined> {
  const selectedRoot = await resolveRoot(rootPath);
  const stateDirectory = agentHtmlRenderStateDirectory(selectedRoot.rootPath);
  const path = daemonMetadataPath(selectedRoot.rootPath);
  try {
    const stateDetails = await lstat(stateDirectory);
    if (
      stateDetails.isSymbolicLink() ||
      !stateDetails.isDirectory() ||
      (await realpath(stateDirectory)) !== stateDirectory
    ) {
      throw new Error("The .agent-html-render state directory must be a local regular directory.");
    }
    const targetDetails = await lstat(path);
    if (targetDetails.isSymbolicLink() || !targetDetails.isFile() || targetDetails.nlink !== 1) {
      throw new Error("The .agent-html-render/daemon.json path must be a regular file with one filesystem link.");
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    let source: string;
    try {
      let opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_DAEMON_METADATA_BYTES) return undefined;
      if ((opened.mode & 0o777) !== 0o600) {
        await handle.chmod(0o600);
        opened = await handle.stat();
      }
      source = await handle.readFile("utf8");
      const completed = await handle.stat();
      if (
        completed.dev !== opened.dev ||
        completed.ino !== opened.ino ||
        completed.size !== opened.size ||
        completed.mtimeMs !== opened.mtimeMs ||
        completed.ctimeMs !== opened.ctimeMs
      ) {
        return undefined;
      }
    } finally {
      await handle.close();
    }
    const parsed = JSON.parse(source) as Partial<DaemonMetadata>;
    if (
      parsed.protocolVersion === "1" &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      parsed.rootPath === selectedRoot.rootPath &&
      parsed.rootDevice === selectedRoot.rootDevice &&
      parsed.rootInode === selectedRoot.rootInode &&
      Number.isSafeInteger(parsed.port) &&
      (parsed.port ?? 0) > 0 &&
      (parsed.port ?? 0) <= 65_535 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0 &&
      parsed.token.length <= 512 &&
      typeof parsed.startedAt === "string" &&
      (parsed.packageVersion === undefined || typeof parsed.packageVersion === "string") &&
      (parsed.buildId === undefined || typeof parsed.buildId === "string") &&
      (parsed.stateDevice === undefined || typeof parsed.stateDevice === "string") &&
      (parsed.stateInode === undefined || typeof parsed.stateInode === "string") &&
      (parsed.startupCoordinatorId === undefined ||
        (typeof parsed.startupCoordinatorId === "string" &&
          STARTUP_COORDINATOR_ID_PATTERN.test(parsed.startupCoordinatorId)))
    ) {
      const completedRoot = await resolveRoot(selectedRoot.rootPath);
      if (
        completedRoot.rootPath !== selectedRoot.rootPath ||
        completedRoot.rootDevice !== selectedRoot.rootDevice ||
        completedRoot.rootInode !== selectedRoot.rootInode
      ) return undefined;
      return parsed as DaemonMetadata;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && error instanceof Error && error.message.includes("must be")) throw error;
    return undefined;
  }
  return undefined;
}

async function boundaryForDaemonMetadata(
  metadata: DaemonMetadata,
  boundary?: PinnedStateBoundary,
): Promise<PinnedStateBoundary> {
  if (boundary) {
    await assertPinnedStateBoundary(boundary);
    if (
      boundary.root.path !== metadata.rootPath ||
      (metadata.rootDevice !== undefined && boundary.root.device !== metadata.rootDevice) ||
      (metadata.rootInode !== undefined && boundary.root.inode !== metadata.rootInode)
    ) throw new Error("Daemon metadata does not match the pinned project root.");
    return boundary;
  }
  const root = await pinDirectoryIdentity(metadata.rootPath, "The selected project root");
  if (
    (metadata.rootDevice !== undefined && root.device !== metadata.rootDevice) ||
    (metadata.rootInode !== undefined && root.inode !== metadata.rootInode)
  ) throw new Error("The selected project root changed before daemon metadata could be written.");
  await ensureStateDirectory(metadata.rootPath, root);
  return pinStateBoundary(metadata.rootPath, root);
}

export async function writeDaemonMetadata(
  metadata: DaemonMetadata,
  boundary?: PinnedStateBoundary,
): Promise<void> {
  const pinnedBoundary = await boundaryForDaemonMetadata(metadata, boundary);
  const target = daemonMetadataPath(metadata.rootPath);
  const stateDirectory = agentHtmlRenderStateDirectory(metadata.rootPath);
  const temporary = join(stateDirectory, `daemon.json.${randomBytes(12).toString("hex")}.tmp`);
  let temporaryCreated = false;
  try {
    await assertPinnedStateBoundary(pinnedBoundary);
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    temporaryCreated = true;
    try {
      await assertPinnedStateBoundary(pinnedBoundary);
      const [opened, current] = await Promise.all([handle.stat(), lstat(temporary)]);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1 ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      ) throw new Error("The daemon metadata temporary file changed before it was written.");
      await assertPinnedStateBoundary(pinnedBoundary);
      await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertPinnedStateBoundary(pinnedBoundary);
    try {
      const targetDetails = await lstat(target);
      if (targetDetails.isSymbolicLink() || !targetDetails.isFile() || targetDetails.nlink !== 1) {
        throw new Error("The .agent-html-render/daemon.json path must be a regular file with one filesystem link.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await assertPinnedStateBoundary(pinnedBoundary);
    await rename(temporary, target);
    temporaryCreated = false;
    await assertPinnedStateBoundary(pinnedBoundary);
  } finally {
    if (temporaryCreated) {
      try {
        await assertPinnedStateBoundary(pinnedBoundary);
        await unlink(temporary);
      } catch {
        // Never redirect cleanup into a replacement state directory.
      }
    }
  }
}

export function removeDaemonMetadataIfOwnedSync(
  _metadataFile: string,
  _ownerPid: number,
  _boundary?: PinnedStateBoundary,
): void {
  // A synchronous pathname unlink cannot be coupled atomically to the inode that
  // was validated. Keep stale metadata instead; the next startup removes or
  // replaces it while holding the kernel startup coordinator, so an exiting
  // daemon cannot erase a newly published daemon's discovery record.
}

export function daemonProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface StartupLock {
  pid: number;
  owner: string;
  createdAt: string;
}

interface CheckedStartupLock {
  lock?: StartupLock;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function startupLockBoundaryError(): Error {
  return new Error(
    "The .agent-html-render/daemon.lock path must be a private regular file with one filesystem link (mode 0600).",
  );
}

class StartupLockInitializationRaceError extends Error {
  constructor() {
    super("The daemon startup lock was still being initialized.");
    this.name = "StartupLockInitializationRaceError";
  }
}

function isPrivateLinkedStartupLock(details: Stats): boolean {
  return !details.isSymbolicLink() &&
    details.isFile() &&
    details.nlink === 1 &&
    (details.mode & 0o777) === 0o600 &&
    details.size <= MAX_STARTUP_LOCK_BYTES;
}

async function retryVerifiedStartupLockTurnover(path: string): Promise<never> {
  try {
    const current = await lstat(path);
    if (isPrivateLinkedStartupLock(current)) throw new StartupLockInitializationRaceError();
    throw startupLockBoundaryError();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StartupLockInitializationRaceError();
    }
    throw error;
  }
}

async function readCheckedStartupLock(path: string): Promise<CheckedStartupLock> {
  const pathDetails = await lstat(path);
  if (!isPrivateLinkedStartupLock(pathDetails)) throw startupLockBoundaryError();
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size > MAX_STARTUP_LOCK_BYTES
    ) throw startupLockBoundaryError();
    if (opened.nlink === 0) await retryVerifiedStartupLockTurnover(path);
    if (opened.dev !== pathDetails.dev || opened.ino !== pathDetails.ino) {
      await retryVerifiedStartupLockTurnover(path);
    }
    const source = await handle.readFile("utf8");
    const completed = await handle.stat();
    if (
      !completed.isFile() ||
      completed.nlink > 1 ||
      (completed.mode & 0o777) !== 0o600 ||
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.size > MAX_STARTUP_LOCK_BYTES
    ) throw startupLockBoundaryError();
    if (completed.nlink === 0) await retryVerifiedStartupLockTurnover(path);
    let current: Stats;
    try {
      current = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StartupLockInitializationRaceError();
      }
      throw error;
    }
    if (!isPrivateLinkedStartupLock(current)) throw startupLockBoundaryError();
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new StartupLockInitializationRaceError();
    }
    if (
      completed.size !== opened.size ||
      completed.mtimeMs !== opened.mtimeMs ||
      completed.ctimeMs !== opened.ctimeMs ||
      current.size !== completed.size ||
      current.mtimeMs !== completed.mtimeMs ||
      current.ctimeMs !== completed.ctimeMs
    ) throw new StartupLockInitializationRaceError();
    let lock: StartupLock | undefined;
    try {
      const parsed = JSON.parse(source) as Partial<StartupLock>;
      if (
        Number.isSafeInteger(parsed.pid) &&
        (parsed.pid ?? 0) > 0 &&
        typeof parsed.owner === "string" &&
        parsed.owner.length > 0 &&
        parsed.owner.length <= 256 &&
        typeof parsed.createdAt === "string"
      ) {
        lock = parsed as StartupLock;
      }
    } catch {
      // A bounded, private, single-link malformed lock is reported once stale.
    }
    return {
      ...(lock ? { lock } : {}),
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
    };
  } finally {
    await handle.close();
  }
}

function staleStartupLockError(path: string, pid?: number): Error {
  const owner = pid === undefined
    ? " with incomplete ownership metadata"
    : ` recorded for process ${pid}`;
  return new Error(
    `A stale Agent HTML Render startup lock${owner} remains at ${path}. ` +
    "It was left in place because automatically deleting a stale pathname can remove a newer owner's lock. " +
    "After verifying that no Agent HTML Render process is starting in this project, remove that one file and retry.",
  );
}

function startupLockIsStale(existing: CheckedStartupLock, now = Date.now()): boolean {
  const createdAt = existing.lock ? Date.parse(existing.lock.createdAt) : Number.NaN;
  const createdAtIsPlausible = Number.isFinite(createdAt) && createdAt <= now + 1_000;
  const age = createdAtIsPlausible ? now - createdAt : now - existing.mtimeMs;
  return ((!existing.lock || !createdAtIsPlausible) && age > 1_000) ||
    Boolean(existing.lock && !daemonProcessIsAlive(existing.lock.pid) && age > 1_000);
}

export type StartupLockStatus = "missing" | "initializing" | "active" | "stale" | "unsafe";

export interface StartupLockInspection {
  path: string;
  status: StartupLockStatus;
  pid?: number;
}

export async function inspectStartupLock(rootPath: string): Promise<StartupLockInspection> {
  const path = daemonLockPath(rootPath);
  try {
    const existing = await readCheckedStartupLock(path);
    if (startupLockIsStale(existing)) {
      return { path, status: "stale", ...(existing.lock ? { pid: existing.lock.pid } : {}) };
    }
    if (!existing.lock || !daemonProcessIsAlive(existing.lock.pid)) return { path, status: "initializing" };
    return { path, status: "active", pid: existing.lock.pid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, status: "missing" };
    if (error instanceof StartupLockInitializationRaceError) return { path, status: "initializing" };
    return { path, status: "unsafe" };
  }
}

interface StartupCoordinatorEndpoint {
  path: string;
}

export type StartupCoordinatorStatus = "idle" | "busy" | "unavailable" | "unsupported";

export interface StartupCoordinatorInspection {
  status: StartupCoordinatorStatus;
}

export interface StartupCoordinatorRelease {
  (): Promise<void>;
  readonly ownerId: string;
}

export interface StartupLockRelease {
  (): Promise<void>;
  readonly ownerId: string;
  transferTo(child: ChildProcess, nonce: string): Promise<void>;
}

const STARTUP_COORDINATOR_TRANSFER = "agent-html-render/startup-coordinator/v1";
const STARTUP_COORDINATOR_READY = "agent-html-render/startup-coordinator-ready/v1";
const STARTUP_COORDINATOR_ACK = "agent-html-render/startup-coordinator-ack/v1";
export const STARTUP_COORDINATOR_NONCE_ENV = "AGENT_HTML_RENDER_STARTUP_COORDINATOR_NONCE";

export function startupCoordinatorIsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux";
}

function startupCoordinatorEndpoint(root: PinnedDirectoryIdentity): StartupCoordinatorEndpoint {
  if (!startupCoordinatorIsSupported()) {
    throw new Error("Agent HTML Render startup coordination currently requires Linux abstract sockets.");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([root.path, root.device, root.inode]))
    .digest();
  const identity = digest.toString("hex");
  return { path: `\0agent-html-render-${identity}` };
}

interface StartupCoordinatorProbe extends StartupCoordinatorInspection {
  ownerId?: string;
}

async function probeStartupCoordinatorEndpoint(
  endpoint: StartupCoordinatorEndpoint,
): Promise<StartupCoordinatorProbe> {
  return new Promise<StartupCoordinatorProbe>((resolvePromise) => {
    const socket = createConnection({ path: endpoint.path });
    let settled = false;
    let connected = false;
    let response = "";
    const finish = (status: StartupCoordinatorStatus, ownerId?: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise({ status, ...(ownerId ? { ownerId } : {}) });
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      connected = true;
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > 129) finish("busy");
    });
    socket.once("end", () => {
      const ownerId = response.trim();
      finish("busy", STARTUP_COORDINATOR_ID_PATTERN.test(ownerId) ? ownerId : undefined);
    });
    socket.once("close", () => {
      if (connected) {
        const ownerId = response.trim();
        finish("busy", STARTUP_COORDINATOR_ID_PATTERN.test(ownerId) ? ownerId : undefined);
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (connected) finish("busy");
      else finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "idle" : "unavailable");
    });
    socket.setTimeout(COORDINATOR_PROBE_TIMEOUT_MILLISECONDS, () => {
      finish(connected ? "busy" : "unavailable");
    });
  });
}

export async function inspectStartupCoordinator(rootInput: string): Promise<StartupCoordinatorInspection> {
  if (!startupCoordinatorIsSupported()) return { status: "unsupported" };
  const rootPath = await realpath(resolve(rootInput));
  const root = await pinDirectoryIdentity(rootPath, "The selected project root");
  const { status } = await probeStartupCoordinatorEndpoint(startupCoordinatorEndpoint(root));
  await assertPinnedDirectory(root, "The selected project root");
  return { status };
}

async function tryAcquireStartupCoordinator(
  endpoint: StartupCoordinatorEndpoint,
  ownerId: string,
): Promise<Server | undefined> {
  const server = createServer((socket) => socket.end(`${ownerId}\n`));
  return new Promise<Server | undefined>((resolvePromise, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      if (error.code === "EADDRINUSE") resolvePromise(undefined);
      else reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolvePromise(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path: endpoint.path, exclusive: true });
  });
}

async function closeStartupCoordinator(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

function startupCoordinatorMessageMatches(message: unknown, type: string, nonce: string): boolean {
  return typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    (message as Record<string, unknown>).type === type &&
    (message as Record<string, unknown>).nonce === nonce;
}

async function transferStartupCoordinator(
  child: ChildProcess,
  server: Server,
  nonce: string,
  ownerId: string,
): Promise<void> {
  if (!child.send || !child.connected) {
    throw new Error("The daemon child did not open its private startup coordination channel.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    let ready = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolvePromise();
    };
    const onMessage = (message: unknown): void => {
      if (!ready && startupCoordinatorMessageMatches(message, STARTUP_COORDINATOR_READY, nonce)) {
        ready = true;
        try {
          child.send?.(
            { type: STARTUP_COORDINATOR_TRANSFER, nonce, ownerId },
            server,
            { keepOpen: true },
            (error) => {
              if (error) finish(error);
            },
          );
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (ready && startupCoordinatorMessageMatches(message, STARTUP_COORDINATOR_ACK, nonce)) finish();
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (): void => finish(new Error("The daemon child exited before accepting startup ownership."));
    const timeout = setTimeout(() => {
      finish(new Error("The daemon child did not accept startup ownership within 5 seconds."));
    }, COORDINATOR_TRANSFER_TIMEOUT_MILLISECONDS);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  if (child.connected) {
    try {
      child.disconnect();
    } catch (error) {
      if (child.connected) throw error;
    }
  }
}

export async function receiveTransferredStartupCoordinator(): Promise<StartupCoordinatorRelease> {
  const nonce = process.env[STARTUP_COORDINATOR_NONCE_ENV];
  delete process.env[STARTUP_COORDINATOR_NONCE_ENV];
  if (!nonce || nonce.length < 32 || nonce.length > 128 || !process.send || !process.connected) {
    throw new Error("The daemon child did not receive a valid private startup coordination channel.");
  }
  return new Promise<StartupCoordinatorRelease>((resolvePromise, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onDisconnect = (): void => {
      finishWithError(new Error("The daemon parent exited before transferring startup ownership."));
    };
    const onMessage = (message: unknown, handle: SendHandle): void => {
      if (!startupCoordinatorMessageMatches(message, STARTUP_COORDINATOR_TRANSFER, nonce)) return;
      const ownerId = isRecord(message) && typeof message.ownerId === "string"
        ? message.ownerId
        : "";
      if (!STARTUP_COORDINATOR_ID_PATTERN.test(ownerId)) {
        if (handle instanceof Server) void closeStartupCoordinator(handle).catch(() => undefined);
        finishWithError(new Error("The daemon parent transferred an invalid startup coordinator identity."));
        return;
      }
      if (!(handle instanceof Server) || !handle.listening) {
        if (handle instanceof Server) void closeStartupCoordinator(handle).catch(() => undefined);
        finishWithError(new Error("The daemon parent transferred an invalid startup coordinator."));
        return;
      }
      settled = true;
      cleanup();
      handle.on("connection", (socket) => socket.end(`${ownerId}\n`));
      process.send?.({ type: STARTUP_COORDINATOR_ACK, nonce }, () => undefined);
      let released = false;
      const release = (async () => {
        if (released) return;
        released = true;
        await closeStartupCoordinator(handle);
      }) as StartupCoordinatorRelease;
      Object.defineProperty(release, "ownerId", { value: ownerId, enumerable: true });
      resolvePromise(release);
    };
    const timeout = setTimeout(() => {
      finishWithError(new Error("The daemon parent did not transfer startup ownership within 5 seconds."));
    }, COORDINATOR_TRANSFER_TIMEOUT_MILLISECONDS);
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    try {
      process.send?.({ type: STARTUP_COORDINATOR_READY, nonce }, () => undefined);
    } catch (error) {
      finishWithError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function legacyStartupLockError(inspection: StartupLockInspection): Error {
  if (inspection.status === "stale") return staleStartupLockError(inspection.path, inspection.pid);
  if (inspection.status === "unsafe") return startupLockBoundaryError();
  return new Error(
    `A legacy Agent HTML Render startup lock is still present at ${inspection.path}. ` +
    "Wait for the current startup to finish. If it does not, verify that no Agent HTML Render process is starting, " +
    "then remove that one file and retry.",
  );
}

export function acquireStartupLock(
  rootPath: string,
  expectedRoot?: PinnedDirectoryIdentity,
): Promise<StartupLockRelease>;
export function acquireStartupLock(
  rootPath: string,
  expectedRoot: PinnedDirectoryIdentity | undefined,
  contentionResolved: () => Promise<boolean>,
): Promise<StartupLockRelease | undefined>;
export async function acquireStartupLock(
  rootPath: string,
  expectedRoot?: PinnedDirectoryIdentity,
  contentionResolved?: () => Promise<boolean>,
): Promise<StartupLockRelease | undefined> {
  if (!startupCoordinatorIsSupported()) {
    throw new Error("Agent HTML Render startup coordination currently requires Linux abstract sockets.");
  }
  const rootIdentity = expectedRoot ?? await pinDirectoryIdentity(rootPath, "The selected project root");
  await ensureStateDirectory(rootPath, rootIdentity);
  const boundary = await pinStateBoundary(rootPath, rootIdentity);
  const endpoint = startupCoordinatorEndpoint(rootIdentity);
  const deadline = Date.now() + LOCK_WAIT_MILLISECONDS;
  let legacyBlocker: StartupLockInspection | undefined;
  while (Date.now() < deadline) {
    await assertPinnedStateBoundary(boundary);
    if (contentionResolved && await contentionResolved()) return undefined;
    const legacy = await inspectStartupLock(rootPath);
    if (legacy.status !== "missing") {
      legacyBlocker = legacy;
      if (legacy.status === "stale" || legacy.status === "unsafe") {
        throw legacyStartupLockError(legacy);
      }
      await delay(20);
      continue;
    }
    const ownerId = randomBytes(24).toString("base64url");
    const server = await tryAcquireStartupCoordinator(endpoint, ownerId);
    if (!server) {
      await delay(20);
      continue;
    }
    try {
      await assertPinnedStateBoundary(boundary);
      const publishedLegacy = await inspectStartupLock(rootPath);
      if (publishedLegacy.status !== "missing") {
        legacyBlocker = publishedLegacy;
        await closeStartupCoordinator(server);
        if (publishedLegacy.status === "stale" || publishedLegacy.status === "unsafe") {
          throw legacyStartupLockError(publishedLegacy);
        }
        await delay(20);
        continue;
      }
    } catch (error) {
      await closeStartupCoordinator(server).catch(() => undefined);
      throw error;
    }
    let released = false;
    let transferred = false;
    const release = (async () => {
      if (released) return;
      released = true;
      await closeStartupCoordinator(server);
    }) as StartupLockRelease;
    Object.defineProperty(release, "ownerId", { value: ownerId, enumerable: true });
    release.transferTo = async (child, nonce) => {
      if (released) throw new Error("Startup ownership was already released.");
      if (transferred) throw new Error("Startup ownership was already transferred.");
      if (!/^[A-Za-z0-9_-]{32,128}$/u.test(nonce)) {
        throw new Error("The startup ownership transfer nonce is invalid.");
      }
      await transferStartupCoordinator(child, server, nonce, ownerId);
      transferred = true;
    };
    return release;
  }
  if (legacyBlocker) throw legacyStartupLockError(legacyBlocker);
  throw new Error(
    "This project's local startup coordinator is still busy. Wait for the current Agent HTML Render command to finish, then retry; if no command is running, use doctor for diagnostics.",
  );
}

async function boundaryForDaemonState(
  rootPath: string,
  boundary?: PinnedStateBoundary,
): Promise<PinnedStateBoundary> {
  if (boundary) {
    if (boundary.root.path !== rootPath) throw new Error("The daemon state boundary belongs to another project root.");
    await assertPinnedStateBoundary(boundary);
    return boundary;
  }
  const root = await pinDirectoryIdentity(rootPath, "The selected project root");
  await ensureStateDirectory(rootPath, root);
  return pinStateBoundary(rootPath, root);
}

async function openDaemonLog(
  rootPath: string,
  boundary: PinnedStateBoundary,
): Promise<Awaited<ReturnType<typeof open>>> {
  const path = daemonLogPath(rootPath);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  await assertPinnedStateBoundary(boundary);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
    0o600,
  );
  try {
    await assertPinnedStateBoundary(boundary);
    const [details, current] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !details.isFile() ||
      details.nlink !== 1 ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== details.dev ||
      current.ino !== details.ino
    ) {
      throw new Error("The .agent-html-render/daemon.log path must be a regular file with one filesystem link.");
    }
    if ((details.mode & 0o777) !== 0o600) {
      await assertPinnedStateBoundary(boundary);
      await handle.chmod(0o600);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function enforceDaemonLogLimit(
  rootPath: string,
  boundary?: PinnedStateBoundary,
): Promise<void> {
  const pinnedBoundary = await boundaryForDaemonState(rootPath, boundary);
  const handle = await openDaemonLog(rootPath, pinnedBoundary);
  try {
    if ((await handle.stat()).size > MAX_DAEMON_LOG_BYTES) {
      await assertPinnedStateBoundary(pinnedBoundary);
      await handle.truncate(0);
    }
  } finally {
    await handle.close();
  }
}

async function prepareDaemonLog(
  rootPath: string,
  boundary: PinnedStateBoundary,
): Promise<Awaited<ReturnType<typeof open>>> {
  const handle = await openDaemonLog(rootPath, boundary);
  try {
    if ((await handle.stat()).size > MAX_DAEMON_LOG_BYTES) {
      await assertPinnedStateBoundary(boundary);
      await handle.truncate(0);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export interface DaemonInspection {
  healthy: boolean;
  compatible: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inspectDaemonHealth(
  metadata: DaemonMetadata,
  body: unknown,
  expectedBuild?: RuntimeBuildIdentity,
): DaemonInspection {
  if (!isRecord(body)) return { healthy: false, compatible: false };
  const healthy = body.rootPath === metadata.rootPath && body.pid === metadata.pid;
  const rootIdentityCurrent =
    body.rootIdentityCurrent === true &&
    typeof body.rootDevice === "string" &&
    typeof body.rootInode === "string" &&
    (metadata.rootDevice === undefined || metadata.rootDevice === body.rootDevice) &&
    (metadata.rootInode === undefined || metadata.rootInode === body.rootInode);
  const stateIdentityCurrent =
    body.stateIdentityCurrent === true &&
    typeof body.stateDevice === "string" &&
    typeof body.stateInode === "string" &&
    metadata.stateDevice !== undefined &&
    metadata.stateInode !== undefined &&
    metadata.stateDevice === body.stateDevice &&
    metadata.stateInode === body.stateInode;
  const coordinatorIdentityCurrent =
    typeof body.startupCoordinatorId === "string" &&
    STARTUP_COORDINATOR_ID_PATTERN.test(body.startupCoordinatorId) &&
    metadata.startupCoordinatorId !== undefined &&
    metadata.startupCoordinatorId === body.startupCoordinatorId;
  const compatible =
    healthy &&
    rootIdentityCurrent &&
    stateIdentityCurrent &&
    coordinatorIdentityCurrent &&
    expectedBuild !== undefined &&
    body.protocolVersion === metadata.protocolVersion &&
    Array.isArray(body.capabilities) &&
    body.capabilities.includes(EXPLICIT_FEEDBACK_ACK_CAPABILITY) &&
    body.packageVersion === expectedBuild.packageVersion &&
    body.buildId === expectedBuild.buildId;
  return { healthy, compatible };
}

export async function inspectDaemon(
  metadata: DaemonMetadata,
  expectedBuild?: RuntimeBuildIdentity,
): Promise<DaemonInspection> {
  try {
    const response = await fetch(`http://127.0.0.1:${metadata.port}/api/health`, {
      headers: { authorization: `Bearer ${metadata.token}` },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return { healthy: false, compatible: false };
    const body: unknown = await response.json();
    const inspection = inspectDaemonHealth(metadata, body, expectedBuild);
    if (!inspection.compatible) return inspection;
    if (
      metadata.rootDevice === undefined ||
      metadata.rootInode === undefined ||
      !isRecord(body) ||
      typeof body.startupCoordinatorId !== "string"
    ) return { ...inspection, compatible: false };
    const coordinator = await probeStartupCoordinatorEndpoint(startupCoordinatorEndpoint({
      path: metadata.rootPath,
      device: metadata.rootDevice,
      inode: metadata.rootInode,
    }));
    return {
      ...inspection,
      compatible:
        coordinator.status === "busy" &&
        coordinator.ownerId === body.startupCoordinatorId,
    };
  } catch {
    return { healthy: false, compatible: false };
  }
}

async function daemonEndpointAcceptsConnections(
  metadata: DaemonMetadata,
  deadline: number,
): Promise<boolean> {
  const remainingMilliseconds = deadline - performance.now();
  if (remainingMilliseconds <= 0) return true;
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port: metadata.port });
    let settled = false;
    const finish = (accepting: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(accepting);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code !== "ECONNREFUSED");
    });
    socket.setTimeout(Math.max(1, Math.min(250, remainingMilliseconds)), () => finish(true));
  });
}

async function daemonOwnershipIsGone(metadata: DaemonMetadata, deadline: number): Promise<boolean> {
  if (performance.now() >= deadline || daemonProcessIsAlive(metadata.pid)) return false;
  const endpointAcceptsConnections = await daemonEndpointAcceptsConnections(metadata, deadline);
  if (performance.now() >= deadline) return false;
  if (endpointAcceptsConnections || daemonProcessIsAlive(metadata.pid)) return false;
  return performance.now() < deadline;
}

export async function stopDaemonWithinTimeout(metadata: DaemonMetadata): Promise<boolean> {
  const shutdownDeadline = performance.now() + DAEMON_STOP_TOTAL_TIMEOUT_MILLISECONDS;
  try {
    await daemonRequest(metadata, "/api/agent/stop", {
      method: "POST",
      signal: AbortSignal.timeout(DAEMON_STOP_REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch {
    // Another contender may have completed shutdown after this request failed.
  }
  while (performance.now() < shutdownDeadline) {
    if (await daemonOwnershipIsGone(metadata, shutdownDeadline)) return true;
    const remainingMilliseconds = shutdownDeadline - performance.now();
    if (remainingMilliseconds <= 0) return false;
    if (remainingMilliseconds <= DAEMON_STOP_FINAL_OBSERVATION_WINDOW_MILLISECONDS) {
      await yieldToEventLoop();
    } else {
      await delay(Math.min(
        50,
        remainingMilliseconds - DAEMON_STOP_FINAL_OBSERVATION_WINDOW_MILLISECONDS,
      ));
    }
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

export async function ensureDaemon(rootInput: string): Promise<DaemonMetadata> {
  const selectedRoot = await resolveRoot(await realpath(resolve(rootInput)));
  const rootPath = selectedRoot.rootPath;
  const rootIdentity: PinnedDirectoryIdentity = {
    path: rootPath,
    device: selectedRoot.rootDevice,
    inode: selectedRoot.rootInode,
  };
  const expectedBuild = await readCurrentRuntimeBuildIdentity();
  const existing = await readDaemonMetadata(rootPath);
  const inspection = existing ? await inspectDaemon(existing, expectedBuild) : undefined;
  if (existing && inspection?.compatible) return existing;
  if (existing && !inspection?.healthy && daemonProcessIsAlive(existing.pid)) {
    throw new Error(
      `The recorded Agent HTML Render daemon process ${existing.pid} is still alive but is not healthy, so no replacement was started. After verifying that PID belongs to this project, stop it and retry.`,
    );
  }
  if (
    existing &&
    inspection?.healthy &&
    !(await stopDaemonWithinTimeout(existing))
  ) {
    throw new Error(
      `The running Agent HTML Render daemon (process ${existing.pid}) did not stop within ${DAEMON_STOP_TOTAL_TIMEOUT_SECONDS} seconds, so no replacement was started. Stop that process and retry.`,
    );
  }
  let compatibleDuringContention: DaemonMetadata | undefined;
  const releaseLock = await acquireStartupLock(rootPath, rootIdentity, async () => {
    const candidate = await readDaemonMetadata(rootPath);
    if (candidate && (await inspectDaemon(candidate, expectedBuild)).compatible) {
      compatibleDuringContention = candidate;
      return true;
    }
    return false;
  });
  if (!releaseLock) {
    if (compatibleDuringContention) return compatibleDuringContention;
    throw new Error("Daemon startup contention resolved without compatible daemon metadata.");
  }
  const startupDeadline = Date.now() + START_TIMEOUT_MILLISECONDS;
  try {
    const boundary = await pinStateBoundary(rootPath, rootIdentity);
    const current = await readDaemonMetadata(rootPath);
    const currentInspection = current ? await inspectDaemon(current, expectedBuild) : undefined;
    if (current && currentInspection?.compatible) return current;
    if (current && !currentInspection?.healthy && daemonProcessIsAlive(current.pid)) {
      throw new Error(
        `The recorded Agent HTML Render daemon process ${current.pid} is still alive but is not healthy, so no replacement was started. After verifying that PID belongs to this project, stop it and retry.`,
      );
    }
    if (current && currentInspection?.healthy) {
      if (!(await stopDaemonWithinTimeout(current))) {
        throw new Error(
          `The running Agent HTML Render daemon (process ${current.pid}) did not stop within ${DAEMON_STOP_TOTAL_TIMEOUT_SECONDS} seconds, so no replacement was started. Stop that process and retry.`,
        );
      }
    }
    if (current) {
      const metadataPath = daemonMetadataPath(rootPath);
      await assertPinnedStateBoundary(boundary);
      const details = await lstat(metadataPath);
      if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) {
        throw new Error("The .agent-html-render/daemon.json path must be a regular file with one filesystem link.");
      }
      await assertPinnedStateBoundary(boundary);
      await unlink(metadataPath);
    }

    const entryPath = process.argv[1];
    if (!entryPath) throw new Error("Agent HTML Render could not determine its CLI entry point.");
    const coordinatorNonce = randomBytes(32).toString("base64url");
    const log = await prepareDaemonLog(rootPath, boundary);
    await assertPinnedStateBoundary(boundary);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        [...process.execArgv, entryPath, "__daemon", "--root", rootPath],
        {
          cwd: rootPath,
          detached: process.platform !== "win32",
          stdio: ["ignore", log.fd, log.fd, "ipc"],
          env: {
            ...process.env,
            AGENT_HTML_RENDER_DAEMON: "1",
            AGENT_HTML_RENDER_ROOT_DEVICE: rootIdentity.device,
            AGENT_HTML_RENDER_ROOT_INODE: rootIdentity.inode,
            AGENT_HTML_RENDER_STATE_DEVICE: boundary.state.device,
            AGENT_HTML_RENDER_STATE_INODE: boundary.state.inode,
            [STARTUP_COORDINATOR_NONCE_ENV]: coordinatorNonce,
          },
        },
      );
    } finally {
      await log.close();
    }
    let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
    });
    try {
      await releaseLock.transferTo(child, coordinatorNonce);
      await assertPinnedStateBoundary(boundary);
    } catch (error) {
      child.kill();
      throw error;
    }
    child.unref();

    while (Date.now() < startupDeadline) {
      if (childExit) {
        throw new Error(
          `Agent HTML Render daemon exited during startup (${childExit.signal ?? `code ${childExit.code ?? 1}`}). See ${daemonLogPath(rootPath)}.`,
        );
      }
      await assertPinnedStateBoundary(boundary);
      const metadata = await readDaemonMetadata(rootPath);
      if (metadata && (await inspectDaemon(metadata, expectedBuild)).compatible) return metadata;
      await delay(100);
    }
    child.kill();
    throw new Error(
      `Agent HTML Render daemon did not become ready within 12 seconds. See ${daemonLogPath(rootPath)}.`,
    );
  } finally {
    await releaseLock();
  }
}

export async function runDaemon(
  rootInput: string,
  startupCoordinatorId: string,
): Promise<RunningServer> {
  if (!STARTUP_COORDINATOR_ID_PATTERN.test(startupCoordinatorId)) {
    throw new Error("The daemon did not receive a valid startup coordinator identity.");
  }
  const selectedRoot = await resolveRoot(await realpath(resolve(rootInput)));
  const rootPath = selectedRoot.rootPath;
  const expectedDevice = process.env.AGENT_HTML_RENDER_ROOT_DEVICE;
  const expectedInode = process.env.AGENT_HTML_RENDER_ROOT_INODE;
  const expectedStateDevice = process.env.AGENT_HTML_RENDER_STATE_DEVICE;
  const expectedStateInode = process.env.AGENT_HTML_RENDER_STATE_INODE;
  if (
    (expectedDevice !== undefined && expectedDevice !== selectedRoot.rootDevice) ||
    (expectedInode !== undefined && expectedInode !== selectedRoot.rootInode)
  ) throw new Error("The selected project root changed before the daemon process started.");
  const boundary = await pinStateBoundary(rootPath, {
    device: selectedRoot.rootDevice,
    inode: selectedRoot.rootInode,
  });
  if (
    (expectedStateDevice !== undefined && expectedStateDevice !== boundary.state.device) ||
    (expectedStateInode !== undefined && expectedStateInode !== boundary.state.inode)
  ) throw new Error("The .agent-html-render state directory changed before the daemon process started.");
  const token = randomBytes(24).toString("base64url");
  const server = await startServer({
    rootPath,
    token,
    expectedStateBoundary: boundary,
    startupCoordinatorId,
  });
  if (
    server.rootDevice !== selectedRoot.rootDevice ||
    server.rootInode !== selectedRoot.rootInode
  ) {
    await server.close();
    throw new Error("The selected project root changed while the daemon process started.");
  }
  const metadata: DaemonMetadata = {
    protocolVersion: "1",
    packageVersion: server.packageVersion,
    buildId: server.buildId,
    pid: process.pid,
    rootPath,
    rootDevice: server.rootDevice,
    rootInode: server.rootInode,
    stateDevice: server.stateDevice,
    stateInode: server.stateInode,
    startupCoordinatorId,
    port: server.port,
    token,
    startedAt: new Date().toISOString(),
  };
  try {
    await writeDaemonMetadata(metadata, boundary);
  } catch (error) {
    try {
      await server.close();
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }
  let activeLogMaintenance: Promise<void> | undefined;
  const maintainLog = (): void => {
    if (activeLogMaintenance) return;
    const operation = enforceDaemonLogLimit(rootPath, boundary).catch(() => undefined);
    activeLogMaintenance = operation;
    void operation.finally(() => {
      if (activeLogMaintenance === operation) activeLogMaintenance = undefined;
    });
  };
  const logMaintenance = setInterval(() => {
    maintainLog();
  }, 10_000);
  logMaintenance.unref();

  let logMaintenanceStopped = false;
  const stopLogMaintenance = (): void => {
    if (logMaintenanceStopped) return;
    logMaintenanceStopped = true;
    clearInterval(logMaintenance);
  };
  const logMaintenanceClosed = async (): Promise<boolean> => {
    stopLogMaintenance();
    const active = activeLogMaintenance;
    if (!active) return true;
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        active.then(() => true),
        new Promise<false>((resolvePromise) => {
          timeout = setTimeout(
            () => resolvePromise(false),
            DAEMON_LOG_MAINTENANCE_DRAIN_MILLISECONDS,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const daemonClosed = (async (): Promise<boolean> => {
    const serverClean = await server.closed;
    const logClean = await logMaintenanceClosed();
    return serverClean && logClean;
  })();
  const close = async (): Promise<void> => {
    stopLogMaintenance();
    let serverFailure: unknown;
    try {
      await server.close();
    } catch (error) {
      serverFailure = error;
    }
    const clean = await daemonClosed;
    if (serverFailure) throw serverFailure;
    if (!clean) {
      throw new ServerProcessTerminationRequiredError(
        "Daemon log maintenance did not settle; the daemon process must terminate before ownership is released.",
      );
    }
  };
  const runningServer: RunningServer = { ...server, closed: daemonClosed, close };
  process.once("SIGINT", () => void close().catch(() => undefined));
  process.once("SIGTERM", () => void close().catch(() => undefined));
  return runningServer;
}

export async function daemonRequest(
  metadata: DaemonMetadata,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${metadata.token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${metadata.port}${path}`, { ...init, headers });
}

export async function currentDaemon(rootInput: string): Promise<DaemonMetadata | undefined> {
  const rootPath = await realpath(resolve(rootInput));
  const metadata = await readDaemonMetadata(rootPath);
  return metadata && (await inspectDaemon(metadata)).healthy ? metadata : undefined;
}
