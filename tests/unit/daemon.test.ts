import { expect, test } from "vitest";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import {
  acquireStartupLock,
  DAEMON_STOP_TOTAL_TIMEOUT_SECONDS,
  daemonLockPath,
  daemonMetadataPath,
  daemonLogPath,
  enforceDaemonLogLimit,
  inspectDaemonHealth,
  readDaemonMetadata,
  removeDaemonMetadataIfOwnedSync,
  stopDaemonWithinTimeout,
  startupCoordinatorIsSupported,
  writeDaemonMetadata,
  type DaemonMetadata,
} from "../../src/node/daemon.js";
import type { RuntimeBuildIdentity } from "../../src/node/build.js";
import { EXPLICIT_FEEDBACK_ACK_CAPABILITY } from "../../src/shared/protocol.js";
import { PACKAGE_VERSION } from "../../src/shared/version.js";
import { pinStateBoundary } from "../../src/node/state-boundary.js";

const metadata: DaemonMetadata = {
  protocolVersion: "1",
  packageVersion: PACKAGE_VERSION,
  buildId: "sha256:current",
  pid: 4321,
  rootPath: "/tmp/example-project",
  rootDevice: "1",
  rootInode: "2",
  stateDevice: "3",
  stateInode: "4",
  startupCoordinatorId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  port: 4040,
  token: "test-token",
  startedAt: "2026-08-22T00:00:00.000Z",
};

const expectedBuild: RuntimeBuildIdentity = {
  packageVersion: PACKAGE_VERSION,
  buildId: "sha256:current",
};

const execFileAsync = promisify(execFile);

test("limits startup coordination to collision-free supported platforms", () => {
  expect(startupCoordinatorIsSupported("linux")).toBe(true);
  expect(startupCoordinatorIsSupported("darwin")).toBe(false);
  expect(startupCoordinatorIsSupported("freebsd")).toBe(false);
  expect(startupCoordinatorIsSupported("win32")).toBe(false);
});

test("bounds shutdown of an unresponsive stale daemon", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server did not bind a TCP port.");
  const startedAt = Date.now();
  try {
    await expect(stopDaemonWithinTimeout({ ...metadata, port: address.port })).resolves.toBe(false);
    const stopMilliseconds = Date.now() - startedAt;
    expect(DAEMON_STOP_TOTAL_TIMEOUT_SECONDS).toBe(3);
    expect(stopMilliseconds).toBeGreaterThanOrEqual(2_900);
    expect(stopMilliseconds).toBeLessThan(3_200);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    });
  }
});

test("confirms a daemon has stopped before replacement can continue", async () => {
  const server = createHttpServer((request, response) => {
    if (request.url === "/api/agent/stop") {
      response.statusCode = 204;
      response.end();
      setImmediate(() => server.close());
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server did not bind a TCP port.");

  await expect(stopDaemonWithinTimeout({
    ...metadata,
    pid: 2_147_483_647,
    port: address.port,
  })).resolves.toBe(true);
});

test("allows the full composed cleanup window after a stop acknowledgement", async () => {
  const server = createHttpServer((request, response) => {
    if (request.url === "/api/agent/stop") {
      response.statusCode = 204;
      response.end();
      setTimeout(() => server.close(), 2_500);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server did not bind a TCP port.");

  const startedAt = Date.now();
  await expect(stopDaemonWithinTimeout({
    ...metadata,
    pid: 2_147_483_647,
    port: address.port,
  })).resolves.toBe(true);
  const stopMilliseconds = Date.now() - startedAt;
  expect(stopMilliseconds).toBeGreaterThanOrEqual(2_400);
  expect(stopMilliseconds).toBeLessThan(3_000);
});

test("rejects endpoint closure after the absolute stop deadline", async () => {
  let resolveClosed = (): void => undefined;
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  const server = createHttpServer((request, response) => {
    if (request.url === "/api/agent/stop") {
      response.statusCode = 204;
      response.end();
      setTimeout(() => server.close(() => resolveClosed()), 3_005);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server did not bind a TCP port.");

  const startedAt = Date.now();
  await expect(stopDaemonWithinTimeout({
    ...metadata,
    pid: 2_147_483_647,
    port: address.port,
  })).resolves.toBe(false);
  const stopMilliseconds = Date.now() - startedAt;
  expect(stopMilliseconds).toBeGreaterThanOrEqual(2_900);
  expect(stopMilliseconds).toBeLessThan(3_200);
  await closed;
});

test.each([
  { exitDelayMilliseconds: 2_955, expected: true, label: "just before" },
  { exitDelayMilliseconds: 3_005, expected: false, label: "just after" },
])("observes real process ownership disappearing $label the cutoff", async ({
  exitDelayMilliseconds,
  expected,
}) => {
  const child = spawn(
    process.execPath,
    [resolve("tests/fixtures/delayed-stop-process.mjs"), String(exitDelayMilliseconds)],
    { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    if (!child.stdout) throw new Error("The delayed-stop fixture did not expose stdout.");
    const [readyChunk] = await once(child.stdout, "data") as [Buffer];
    const ready = JSON.parse(readyChunk.toString("utf8")) as { pid: number; port: number };
    const startedAt = Date.now();
    await expect(stopDaemonWithinTimeout({
      ...metadata,
      pid: ready.pid,
      port: ready.port,
    })).resolves.toBe(expected);
    const stopMilliseconds = Date.now() - startedAt;
    expect(stopMilliseconds).toBeGreaterThanOrEqual(2_850);
    expect(stopMilliseconds).toBeLessThan(3_200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
});

test("does not treat a stop acknowledgement or failed health response as process exit", async () => {
  const sockets = new Set<Socket>();
  const server = createHttpServer((request, response) => {
    if (request.url === "/api/agent/stop") {
      response.statusCode = 204;
      response.end();
    }
    // Keep the listener and every other request alive without a response.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server did not bind a TCP port.");
  try {
    await expect(stopDaemonWithinTimeout({
      ...metadata,
      pid: process.pid,
      port: address.port,
    })).resolves.toBe(false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
});

async function metadataForRoot(rootPath: string): Promise<DaemonMetadata> {
  const canonicalRoot = await realpath(rootPath);
  const details = await stat(canonicalRoot, { bigint: true });
  return {
    ...metadata,
    rootPath: canonicalRoot,
    rootDevice: details.dev.toString(),
    rootInode: details.ino.toString(),
  };
}

const compatibleHealth = {
  protocolVersion: "1",
  capabilities: [EXPLICIT_FEEDBACK_ACK_CAPABILITY],
  packageVersion: expectedBuild.packageVersion,
  buildId: expectedBuild.buildId,
  rootPath: metadata.rootPath,
  rootDevice: metadata.rootDevice,
  rootInode: metadata.rootInode,
  rootIdentityCurrent: true,
  stateDevice: metadata.stateDevice,
  stateInode: metadata.stateInode,
  stateIdentityCurrent: true,
  startupCoordinatorId: metadata.startupCoordinatorId,
  pid: metadata.pid,
};

test("accepts only the exact running package build", () => {
  expect(inspectDaemonHealth(metadata, compatibleHealth, expectedBuild)).toEqual({
    healthy: true,
    compatible: true,
  });

  expect(
    inspectDaemonHealth(metadata, { ...compatibleHealth, packageVersion: "0.3.1" }, expectedBuild),
  ).toEqual({ healthy: true, compatible: false });

  expect(
    inspectDaemonHealth(metadata, { ...compatibleHealth, buildId: "sha256:stale" }, expectedBuild),
  ).toEqual({ healthy: true, compatible: false });

  expect(
    inspectDaemonHealth(metadata, { ...compatibleHealth, rootIdentityCurrent: false }, expectedBuild),
  ).toEqual({ healthy: true, compatible: false });

  expect(
    inspectDaemonHealth(metadata, { ...compatibleHealth, stateIdentityCurrent: false }, expectedBuild),
  ).toEqual({ healthy: true, compatible: false });

  expect(
    inspectDaemonHealth(
      metadata,
      { ...compatibleHealth, startupCoordinatorId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      expectedBuild,
    ),
  ).toEqual({ healthy: true, compatible: false });
});

test("replaces healthy legacy daemons that have no build identity", () => {
  const legacyHealth = {
    protocolVersion: "1",
    capabilities: [EXPLICIT_FEEDBACK_ACK_CAPABILITY],
    rootPath: metadata.rootPath,
    pid: metadata.pid,
  };
  expect(inspectDaemonHealth(metadata, legacyHealth, expectedBuild)).toEqual({
    healthy: true,
    compatible: false,
  });
});

test("does not treat an unrelated process as a healthy daemon", () => {
  expect(
    inspectDaemonHealth(metadata, { ...compatibleHealth, pid: metadata.pid + 1 }, expectedBuild),
  ).toEqual({ healthy: false, compatible: false });
  expect(inspectDaemonHealth(metadata, null, expectedBuild)).toEqual({
    healthy: false,
    compatible: false,
  });
});

test.skipIf(process.platform === "win32")("does not follow daemon metadata temporary or target links", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-metadata-"));
  const stateDirectory = join(rootPath, ".agent-html-render");
  const temporaryVictim = join(rootPath, "temporary-victim.txt");
  const targetVictim = join(rootPath, "target-victim.txt");
  await mkdir(stateDirectory);
  await writeFile(temporaryVictim, "keep temporary victim");
  await symlink(temporaryVictim, join(stateDirectory, "daemon.json.tmp"));
  const localMetadata = await metadataForRoot(rootPath);

  await writeDaemonMetadata(localMetadata);
  expect(await readFile(temporaryVictim, "utf8")).toBe("keep temporary victim");
  expect(JSON.parse(await readFile(daemonMetadataPath(rootPath), "utf8"))).toMatchObject({ rootPath });

  const linkedRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-target-"));
  await mkdir(join(linkedRoot, ".agent-html-render"));
  await writeFile(targetVictim, "keep target victim");
  await symlink(targetVictim, daemonMetadataPath(linkedRoot));
  await expect(readDaemonMetadata(linkedRoot)).rejects.toThrow("one filesystem link");
  await expect(writeDaemonMetadata(await metadataForRoot(linkedRoot))).rejects.toThrow("regular file");
  expect(await readFile(targetVictim, "utf8")).toBe("keep target victim");
});

test.skipIf(process.platform === "win32")("rejects multiply linked daemon metadata and logs without changing the other name", async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-metadata-hardlink-"));
  const metadataState = join(metadataRoot, ".agent-html-render");
  const metadataVictim = join(metadataRoot, "metadata-victim.json");
  await mkdir(metadataState);
  await writeFile(metadataVictim, `${JSON.stringify({ ...metadata, rootPath: metadataRoot })}\n`);
  await link(metadataVictim, daemonMetadataPath(metadataRoot));

  await expect(readDaemonMetadata(metadataRoot)).rejects.toThrow("one filesystem link");
  expect(await readFile(metadataVictim, "utf8")).toContain(metadataRoot);

  const logRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-log-hardlink-"));
  const logState = join(logRoot, ".agent-html-render");
  const logVictim = join(logRoot, "log-victim.txt");
  await mkdir(logState);
  await writeFile(logVictim, "keep log victim");
  await link(logVictim, daemonLogPath(logRoot));

  await expect(enforceDaemonLogLimit(logRoot)).rejects.toThrow("one filesystem link");
  expect(await readFile(logVictim, "utf8")).toBe("keep log victim");
});

test.skipIf(process.platform === "win32")("repairs daemon metadata permissions before returning credentials", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-mode-"));
  await mkdir(join(rootPath, ".agent-html-render"));
  const localMetadata = await metadataForRoot(rootPath);
  await writeDaemonMetadata(localMetadata);
  const path = daemonMetadataPath(rootPath);
  await chmod(path, 0o644);

  await expect(readDaemonMetadata(rootPath)).resolves.toMatchObject({ rootPath, token: metadata.token });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test.skipIf(process.platform === "win32")("does not redirect daemon metadata, log, or cleanup writes after root replacement", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-root-write-swap-"));
  const rootPath = join(temporaryDirectory, "project");
  const movedRoot = join(temporaryDirectory, "project-old");
  const replacementRoot = join(temporaryDirectory, "replacement");
  await mkdir(join(rootPath, ".agent-html-render"), { recursive: true });
  await mkdir(join(replacementRoot, ".agent-html-render"), { recursive: true });
  const pinned = await pinStateBoundary(rootPath);
  const localMetadata = await metadataForRoot(rootPath);
  await writeDaemonMetadata(localMetadata, pinned);

  await rename(rootPath, movedRoot);
  await rename(replacementRoot, rootPath);
  const replacementMetadata = daemonMetadataPath(rootPath);
  const replacementLog = daemonLogPath(rootPath);
  await writeFile(replacementMetadata, `${JSON.stringify(localMetadata)}\n`, { mode: 0o600 });
  await writeFile(replacementLog, "b".repeat(600 * 1024), { mode: 0o600 });

  await expect(writeDaemonMetadata({ ...localMetadata, token: "must-not-cross-roots" }, pinned))
    .rejects.toThrow("changed after Agent HTML Render pinned it");
  await expect(enforceDaemonLogLimit(rootPath, pinned))
    .rejects.toThrow("changed after Agent HTML Render pinned it");
  removeDaemonMetadataIfOwnedSync(replacementMetadata, localMetadata.pid, pinned);

  expect(await readFile(replacementMetadata, "utf8")).not.toContain("must-not-cross-roots");
  expect((await stat(replacementLog)).size).toBe(600 * 1024);
  expect(await readFile(daemonMetadataPath(movedRoot), "utf8")).toContain(localMetadata.token);
});

test("rejects valid private daemon metadata copied from a different project root", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-root-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-root-b-"));
  await mkdir(join(firstRoot, ".agent-html-render"));
  await mkdir(join(secondRoot, ".agent-html-render"));
  await writeDaemonMetadata(await metadataForRoot(secondRoot));
  await writeFile(
    daemonMetadataPath(firstRoot),
    await readFile(daemonMetadataPath(secondRoot)),
    { mode: 0o600 },
  );

  await expect(readDaemonMetadata(firstRoot)).resolves.toBeUndefined();
  await expect(readDaemonMetadata(secondRoot)).resolves.toMatchObject({ rootPath: secondRoot });
});

test.skipIf(process.platform === "win32")("shutdown leaves metadata for the next locked startup", async () => {
  const linkedRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-cleanup-link-"));
  const linkedState = join(linkedRoot, ".agent-html-render");
  const linkedVictim = join(linkedRoot, "metadata-victim.json");
  await mkdir(linkedState);
  await writeFile(linkedVictim, `${JSON.stringify({ ...metadata, rootPath: linkedRoot })}\n`, { mode: 0o600 });
  const linkedPath = daemonMetadataPath(linkedRoot);
  await symlink(linkedVictim, linkedPath);

  removeDaemonMetadataIfOwnedSync(linkedPath, metadata.pid);
  expect((await lstat(linkedPath)).isSymbolicLink()).toBe(true);
  expect(await readFile(linkedVictim, "utf8")).toContain(linkedRoot);

  const hardlinkRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-cleanup-hardlink-"));
  await mkdir(join(hardlinkRoot, ".agent-html-render"));
  const hardlinkPath = daemonMetadataPath(hardlinkRoot);
  await writeFile(hardlinkPath, `${JSON.stringify({ ...metadata, rootPath: hardlinkRoot })}\n`, { mode: 0o600 });
  const otherName = join(hardlinkRoot, "metadata-other-name.json");
  await link(hardlinkPath, otherName);

  removeDaemonMetadataIfOwnedSync(hardlinkPath, metadata.pid);
  expect((await lstat(hardlinkPath)).isFile()).toBe(true);
  expect((await lstat(otherName)).isFile()).toBe(true);

  const regularRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-cleanup-regular-"));
  await mkdir(join(regularRoot, ".agent-html-render"));
  const regularPath = daemonMetadataPath(regularRoot);
  await writeFile(regularPath, `${JSON.stringify({ ...metadata, rootPath: regularRoot })}\n`, { mode: 0o600 });
  removeDaemonMetadataIfOwnedSync(regularPath, metadata.pid);
  expect((await lstat(regularPath)).isFile()).toBe(true);

  await unlink(regularPath);
  await writeFile(
    regularPath,
    `${JSON.stringify({ ...metadata, rootPath: regularRoot, pid: metadata.pid + 1, token: "new-daemon" })}\n`,
    { mode: 0o600 },
  );
  removeDaemonMetadataIfOwnedSync(regularPath, metadata.pid);
  expect(await readFile(regularPath, "utf8")).toContain("new-daemon");
});

test.skipIf(process.platform === "win32")("startup locking refuses linked, multiply linked, and permissive entries", async () => {
  const linkedRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-lock-link-"));
  const linkedState = join(linkedRoot, ".agent-html-render");
  const linkedVictim = join(linkedRoot, "lock-victim.json");
  await mkdir(linkedState);
  await writeFile(linkedVictim, "keep linked victim", { mode: 0o600 });
  await symlink(linkedVictim, daemonLockPath(linkedRoot));
  await expect(acquireStartupLock(linkedRoot)).rejects.toThrow("private regular file with one filesystem link");
  expect((await lstat(daemonLockPath(linkedRoot))).isSymbolicLink()).toBe(true);
  expect(await readFile(linkedVictim, "utf8")).toBe("keep linked victim");

  const hardlinkRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-lock-hardlink-"));
  await mkdir(join(hardlinkRoot, ".agent-html-render"));
  const hardlinkVictim = join(hardlinkRoot, "lock-victim.json");
  await writeFile(hardlinkVictim, "keep hardlink victim", { mode: 0o600 });
  await link(hardlinkVictim, daemonLockPath(hardlinkRoot));
  await expect(acquireStartupLock(hardlinkRoot)).rejects.toThrow("one filesystem link");
  expect(await readFile(hardlinkVictim, "utf8")).toBe("keep hardlink victim");

  const modeRoot = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-lock-mode-"));
  await mkdir(join(modeRoot, ".agent-html-render"));
  const modePath = daemonLockPath(modeRoot);
  await writeFile(modePath, "{}\n", { mode: 0o644 });
  await chmod(modePath, 0o644);
  await expect(acquireStartupLock(modeRoot)).rejects.toThrow("mode 0600");
  expect((await stat(modePath)).mode & 0o777).toBe(0o644);
});

test.skipIf(process.platform === "win32")("startup locking fails closed without deleting a stale regular lock", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-lock-stale-"));
  const stateDirectory = join(rootPath, ".agent-html-render");
  await mkdir(stateDirectory);
  await writeFile(
    daemonLockPath(rootPath),
    `${JSON.stringify({ pid: 2_147_483_647, owner: "stale-owner", createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
    { mode: 0o600 },
  );

  const path = daemonLockPath(rootPath);
  const before = await stat(path);
  await expect(acquireStartupLock(rootPath)).rejects.toThrow(
    "automatically deleting a stale pathname can remove a newer owner's lock",
  );
  const after = await stat(path);
  expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ owner: "stale-owner" });
});

test.skipIf(process.platform === "win32")("never age-evicts a valid startup lock whose owner is alive", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-lock-live-"));
  const stateDirectory = join(rootPath, ".agent-html-render");
  await mkdir(stateDirectory);
  const path = daemonLockPath(rootPath);
  await writeFile(
    path,
    `${JSON.stringify({ pid: process.pid, owner: "live-owner", createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
    { mode: 0o600 },
  );

  const acquiring = acquireStartupLock(rootPath);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ owner: "live-owner" });
  await unlink(path);
  const release = await acquiring;
  await release();
});

test.skipIf(process.platform === "win32")("serializes ordinary concurrent startup lock contenders without initialization errors", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-lock-contention-"));
  let activeOwners = 0;
  let maximumOwners = 0;

  for (let round = 0; round < 5; round += 1) {
    await Promise.all(Array.from({ length: 32 }, async () => {
      const release = await acquireStartupLock(rootPath);
      activeOwners += 1;
      maximumOwners = Math.max(maximumOwners, activeOwners);
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      activeOwners -= 1;
      await release();
    }));
  }

  expect(maximumOwners).toBe(1);
  await expect(lstat(daemonLockPath(rootPath))).rejects.toMatchObject({ code: "ENOENT" });
}, 15_000);

test.skipIf(process.platform === "win32")("serializes multiprocess contenders beyond the former retry window", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-lock-processes-"));
  const stateDirectory = join(rootPath, ".agent-html-render");
  await mkdir(stateDirectory);
  const contender = resolve("tests/fixtures/startup-lock-contender.ts");

  for (let round = 0; round < 2; round += 1) {
    await Promise.all(Array.from({ length: 24 }, () =>
      execFileAsync(process.execPath, ["--import", "tsx", contender, rootPath, "75"])
    ));
    await expect(lstat(daemonLockPath(rootPath))).rejects.toMatchObject({ code: "ENOENT" });
  }

  expect((await readdir(stateDirectory)).filter((entry) => entry.includes("daemon.lock"))).toEqual([]);
}, 60_000);

test.skipIf(process.platform === "win32")("startup lock release leaves a replacement link untouched", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-daemon-lock-release-"));
  const stateDirectory = join(rootPath, ".agent-html-render");
  await mkdir(stateDirectory);
  const release = await acquireStartupLock(rootPath);
  const victim = join(rootPath, "replacement-victim.json");
  await writeFile(victim, "keep replacement victim", { mode: 0o600 });
  await symlink(victim, daemonLockPath(rootPath));

  await release();

  expect((await lstat(daemonLockPath(rootPath))).isSymbolicLink()).toBe(true);
  expect(await readFile(victim, "utf8")).toBe("keep replacement victim");
});
