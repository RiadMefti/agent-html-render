import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { startServer, type RunningServer } from "./server.js";

export interface DaemonMetadata {
  protocolVersion: "1";
  pid: number;
  rootPath: string;
  port: number;
  token: string;
  startedAt: string;
}

const START_TIMEOUT_MILLISECONDS = 12_000;

export function agentRenderStateDirectory(rootPath: string): string {
  return join(rootPath, ".agentrender");
}

export function daemonMetadataPath(rootPath: string): string {
  return join(agentRenderStateDirectory(rootPath), "daemon.json");
}

async function readMetadata(rootPath: string): Promise<DaemonMetadata | undefined> {
  try {
    const parsed = JSON.parse(await readFile(daemonMetadataPath(rootPath), "utf8")) as Partial<DaemonMetadata>;
    if (
      parsed.protocolVersion === "1" &&
      typeof parsed.pid === "number" &&
      typeof parsed.rootPath === "string" &&
      typeof parsed.port === "number" &&
      typeof parsed.token === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as DaemonMetadata;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function writeMetadata(metadata: DaemonMetadata): Promise<void> {
  const target = daemonMetadataPath(metadata.rootPath);
  const temporary = `${target}.tmp`;
  await mkdir(agentRenderStateDirectory(metadata.rootPath), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function metadataIsHealthy(metadata: DaemonMetadata): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${metadata.port}/api/health`, {
      headers: { authorization: `Bearer ${metadata.token}` },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { rootPath?: string; pid?: number };
    return body.rootPath === metadata.rootPath && body.pid === metadata.pid;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function ensureDaemon(rootInput: string): Promise<DaemonMetadata> {
  const rootPath = await realpath(resolve(rootInput));
  const existing = await readMetadata(rootPath);
  if (existing && (await metadataIsHealthy(existing))) return existing;
  if (existing) await unlink(daemonMetadataPath(rootPath)).catch(() => undefined);

  await mkdir(agentRenderStateDirectory(rootPath), { recursive: true });
  const entryPath = process.argv[1];
  if (!entryPath) throw new Error("AgentRender could not determine its CLI entry point.");
  const child = spawn(
    process.execPath,
    [...process.execArgv, entryPath, "__daemon", "--root", rootPath],
    {
      cwd: rootPath,
      detached: process.platform !== "win32",
      stdio: "ignore",
      env: { ...process.env, AGENTRENDER_DAEMON: "1" },
    },
  );
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    const metadata = await readMetadata(rootPath);
    if (metadata && (await metadataIsHealthy(metadata))) return metadata;
    await delay(100);
  }
  throw new Error("AgentRender daemon did not become ready within 12 seconds.");
}

export async function runDaemon(rootInput: string): Promise<RunningServer> {
  const rootPath = await realpath(resolve(rootInput));
  const token = randomBytes(24).toString("base64url");
  const server = await startServer({ rootPath, token });
  const metadata: DaemonMetadata = {
    protocolVersion: "1",
    pid: process.pid,
    rootPath,
    port: server.port,
    token,
    startedAt: new Date().toISOString(),
  };
  await writeMetadata(metadata);
  const metadataFile = daemonMetadataPath(rootPath);

  const removeOwnMetadataSync = (): void => {
    try {
      if (!existsSync(metadataFile)) return;
      const parsed = JSON.parse(readFileSync(metadataFile, "utf8")) as Partial<DaemonMetadata>;
      if (parsed.pid === process.pid) unlinkSync(metadataFile);
    } catch {
      // Stale metadata is harmless; the next CLI call performs a health check.
    }
  };

  const stop = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    removeOwnMetadataSync();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("exit", removeOwnMetadataSync);
  return server;
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
  const metadata = await readMetadata(rootPath);
  return metadata && (await metadataIsHealthy(metadata)) ? metadata : undefined;
}
