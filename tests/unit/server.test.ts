import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import type { FSWatcher } from "chokidar";
import { createRuntimeBuildIdentity } from "../../src/node/build.js";
import {
  acquireStartupLock,
  inspectDaemon,
  inspectDaemonHealth,
  type DaemonMetadata,
} from "../../src/node/daemon.js";
import { startServer, type RunningServer } from "../../src/node/server.js";
import {
  FEEDBACK_LEASE_MILLISECONDS,
  SessionStoreProcessTerminationRequiredError,
} from "../../src/node/store.js";
import { EXPLICIT_FEEDBACK_ACK_CAPABILITY, FEEDBACK_ACK_HEADER } from "../../src/shared/protocol.js";

const temporaryDirectories: string[] = [];
const runningServers: RunningServer[] = [];

function withMockedNow<Value>(now: number, work: () => Value): Value {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return work();
  } finally {
    Date.now = originalNow;
  }
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("serves the review shell when npm runs the package from a hidden cache directory", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-server-"));
  temporaryDirectories.push(temporaryDirectory);

  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, ".npm", "_npx", "package", "dist", "ui");
  await mkdir(rootPath, { recursive: true });
  await mkdir(uiDirectory, { recursive: true });
  await writeFile(join(rootPath, "plan.html"), "<!doctype html><title>Plan</title>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");

  const server = await startServer({
    rootPath,
    token: "unit-test-token",
    uiDirectory,
    bridgeSource: "",
  });
  runningServers.push(server);

  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: {
      authorization: "Bearer unit-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  expect(createResponse.status).toBe(200);
  const created = (await createResponse.json()) as { session: { reviewUrl: string } };

  const reviewResponse = await fetch(created.session.reviewUrl);
  expect(reviewResponse.status).toBe(200);
  expect(reviewResponse.headers.get("content-type")).toContain("text/html");
  expect(await reviewResponse.text()).toContain("<title>Review shell</title>");

  const artifactResponse = await fetch(new URL("/api/review/" + new URL(created.session.reviewUrl).pathname.split("/").at(-1) + "/artifact" + new URL(created.session.reviewUrl).search, server.origin));
  expect(artifactResponse.headers.get("content-security-policy")).toContain("default-src 'none'");
});

test("serializes concurrent review opens into one artifact session", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-concurrent-open-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  await mkdir(rootPath, { recursive: true });
  await mkdir(uiDirectory, { recursive: true });
  await writeFile(join(rootPath, "plan.html"), "<!doctype html><title>Plan</title>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");

  const server = await startServer({
    rootPath,
    token: "concurrent-open-token",
    uiDirectory,
    bridgeSource: "",
  });
  runningServers.push(server);
  const open = async (): Promise<{ session: { id: string } }> => {
    const response = await fetch(`${server.origin}/api/agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer concurrent-open-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ artifactPath: "plan.html" }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ session: { id: string } }>;
  };

  const [first, second] = await Promise.all([open(), open()]);
  expect(second.session.id).toBe(first.session.id);
  expect(server.store.list()).toHaveLength(1);
});

test("retires the server when the session store reports post-commit uncertainty", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-store-terminal-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  await mkdir(rootPath);
  await mkdir(uiDirectory);
  await writeFile(join(rootPath, "plan.html"), "<!doctype html><title>Plan</title>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
  const token = "store-terminal-token";
  const server = await startServer({ rootPath, token, uiDirectory, bridgeSource: "" });
  runningServers.push(server);
  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  const created = (await createResponse.json()) as {
    session: { id: string; reviewUrl: string };
  };
  const state = server.store.getPublicState(created.session.id);
  if (!state) throw new Error("The store-terminal fixture session is missing.");
  server.store.updateDraft = async () => {
    throw new SessionStoreProcessTerminationRequiredError("simulated post-commit uncertainty");
  };

  const reviewUrl = new URL(created.session.reviewUrl);
  const response = await fetch(
    `${server.origin}/api/review/${created.session.id}/draft${reviewUrl.search}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: { message: "Do not accept another mutation.", annotations: [] },
        baseRevision: state.revision,
        baseContentHash: state.contentHash,
      }),
    },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "simulated post-commit uncertainty",
  });
  expect(await server.closed).toBe(false);
  runningServers.splice(runningServers.indexOf(server), 1);
});

test("fails a pending delivery wait safely when lease issuance enters terminal retirement", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-wait-terminal-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  await mkdir(rootPath);
  await mkdir(uiDirectory);
  await writeFile(join(rootPath, "plan.html"), "<!doctype html><title>Plan</title>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
  const token = "wait-terminal-token";
  const server = await startServer({ rootPath, token, uiDirectory, bridgeSource: "" });
  runningServers.push(server);
  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  const created = (await createResponse.json()) as { session: { id: string } };
  let leaseAttempts = 0;
  server.store.leaseNextUndelivered = () => {
    leaseAttempts += 1;
    if (leaseAttempts === 1) return {};
    throw new SessionStoreProcessTerminationRequiredError("simulated terminal lease issuance");
  };

  const waitResponse = await fetch(
    `${server.origin}/api/agent/sessions/${created.session.id}/wait?after=0&consumer=terminal-wait-consumer`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        [FEEDBACK_ACK_HEADER]: EXPLICIT_FEEDBACK_ACK_CAPABILITY,
      },
    },
  );
  expect(waitResponse.status).toBe(500);
  expect(await waitResponse.json()).toEqual({ error: "simulated terminal lease issuance" });
  expect(leaseAttempts).toBe(2);
  expect(await server.closed).toBe(false);
  runningServers.splice(runningServers.indexOf(server), 1);
});

test.skipIf(process.platform === "win32")(
  "closes its HTTP listener when a failed restored watcher never settles during close",
  async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-watcher-restore-cleanup-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  await mkdir(rootPath, { recursive: true });
  await mkdir(uiDirectory, { recursive: true });
  await writeFile(join(rootPath, "plan.html"), "<!doctype html><title>Plan</title>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");

  const initial = await startServer({
    rootPath,
    token: "watcher-restore-initial-token",
    uiDirectory,
    bridgeSource: "",
  });
  const createResponse = await fetch(`${initial.origin}/api/agent/sessions`, {
    method: "POST",
    headers: {
      authorization: "Bearer watcher-restore-initial-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  expect(createResponse.status).toBe(200);
  const restoredSessionId = initial.store.list()[0]?.id;
  if (!restoredSessionId) throw new Error("The restored watcher fixture did not create a session.");
  await initial.close();

  const reservation = createHttpServer();
  await new Promise<void>((resolvePromise, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolvePromise);
  });
  const reservedAddress = reservation.address();
  if (!reservedAddress || typeof reservedAddress === "string") throw new Error("The port reservation failed.");
  const port = reservedAddress.port;
  await new Promise<void>((resolvePromise) => reservation.close(() => resolvePromise()));

  let watcherCloseCalls = 0;
  let failedWatcher: FSWatcher | undefined;
  const watcherFactory = (() => {
    const watcher = new EventEmitter() as FSWatcher;
    failedWatcher = watcher;
    watcher.close = () => {
      watcherCloseCalls += 1;
      return new Promise<void>(() => undefined);
    };
    queueMicrotask(() => watcher.emit("error", new Error("simulated restored watcher failure")));
    return watcher;
  }) as typeof import("chokidar").default.watch;

  await expect(startServer({
    rootPath,
    port,
    token: "watcher-restore-failure-token",
    uiDirectory,
    bridgeSource: "",
    watcherFactory,
  })).rejects.toThrow("daemon process must terminate before ownership is released");
  expect(watcherCloseCalls).toBeGreaterThan(0);

  await writeFile(join(rootPath, "plan.html"), "<!doctype html><title>Changed after failure</title>");
  failedWatcher?.emit("change", join(rootPath, "plan.html"));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  const persistedAfterFailure = JSON.parse(
    await readFile(join(rootPath, ".agent-html-render", "sessions", `${restoredSessionId}.json`), "utf8"),
  ) as { revision: number };
  expect(persistedAfterFailure.revision).toBe(1);

  const verifier = createHttpServer();
  await new Promise<void>((resolvePromise, reject) => {
    verifier.once("error", reject);
    verifier.listen(port, "127.0.0.1", resolvePromise);
  });
  await new Promise<void>((resolvePromise) => verifier.close(() => resolvePromise()));
  },
);

test("does not report a clean close until an in-flight watcher revision is durable", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-watcher-drain-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  const artifactPath = join(rootPath, "plan.html");
  await mkdir(rootPath);
  await mkdir(uiDirectory);
  await writeFile(artifactPath, "<!doctype html><title>Revision one</title>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");

  let watcher: FSWatcher | undefined;
  const watcherFactory = (() => {
    const created = new EventEmitter() as FSWatcher;
    created.close = async () => undefined;
    watcher = created;
    queueMicrotask(() => created.emit("ready"));
    return created;
  }) as typeof import("chokidar").default.watch;
  const server = await startServer({
    rootPath,
    token: "watcher-drain-token",
    uiDirectory,
    bridgeSource: "",
    watcherFactory,
  });
  runningServers.push(server);
  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: {
      authorization: "Bearer watcher-drain-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  expect(createResponse.status).toBe(200);
  const sessionId = server.store.list()[0]?.id;
  if (!sessionId || !watcher) throw new Error("The watcher drain fixture did not initialize.");

  const originalBumpRevision = server.store.bumpRevision.bind(server.store);
  let announceBump = (): void => undefined;
  const bumpStarted = new Promise<void>((resolvePromise) => {
    announceBump = resolvePromise;
  });
  let releaseBump = (): void => undefined;
  const bumpGate = new Promise<void>((resolvePromise) => {
    releaseBump = resolvePromise;
  });
  server.store.bumpRevision = async (id, hash) => {
    announceBump();
    await bumpGate;
    return originalBumpRevision(id, hash);
  };

  await writeFile(artifactPath, "<!doctype html><title>Revision two</title>");
  watcher.emit("change", artifactPath);
  await bumpStarted;
  let closeSettled = false;
  const closing = server.close().finally(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
  expect(closeSettled).toBe(false);
  expect(server.store.get(sessionId)?.revision).toBe(1);

  releaseBump();
  await closing;
  expect(await server.closed).toBe(true);
  expect(server.store.get(sessionId)?.revision).toBe(2);
  const persistedAtClose = JSON.parse(
    await readFile(join(rootPath, ".agent-html-render", "sessions", `${sessionId}.json`), "utf8"),
  ) as { revision: number };
  expect(persistedAtClose.revision).toBe(2);
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
  expect(server.store.get(sessionId)?.revision).toBe(2);
  runningServers.splice(runningServers.indexOf(server), 1);
});

test.skipIf(process.platform === "win32")(
  "terminates instead of reviving a detached watcher after transient close failure",
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-watcher-retire-"));
    temporaryDirectories.push(temporaryDirectory);
    const rootPath = join(temporaryDirectory, "project");
    const uiDirectory = join(temporaryDirectory, "ui");
    const nestedPath = join(rootPath, "nested");
    const parkedPath = join(rootPath, "nested-original");
    const replacementPath = join(rootPath, "nested-replacement");
    const artifactPath = join(nestedPath, "plan.html");
    await mkdir(nestedPath, { recursive: true });
    await mkdir(uiDirectory);
    await writeFile(artifactPath, "<!doctype html><title>Original parent</title>");
    await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");

    let watcher: FSWatcher | undefined;
    let watcherCloseCalls = 0;
    const watcherFactory = (() => {
      const created = new EventEmitter() as FSWatcher;
      created.close = async () => {
        watcherCloseCalls += 1;
        if (watcherCloseCalls === 1) throw new Error("simulated transient watcher close failure");
      };
      watcher = created;
      queueMicrotask(() => created.emit("ready"));
      return created;
    }) as typeof import("chokidar").default.watch;
    const token = "watcher-retire-token";
    const server = await startServer({ rootPath, token, uiDirectory, bridgeSource: "", watcherFactory });
    runningServers.push(server);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const open = (): Promise<Response> => fetch(`${server.origin}/api/agent/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ artifactPath: "nested/plan.html" }),
    });
    expect((await open()).status).toBe(200);
    const sessionId = server.store.list()[0]?.id;
    if (!sessionId || !watcher) throw new Error("The watcher retirement fixture did not initialize.");

    await rename(nestedPath, parkedPath);
    await mkdir(nestedPath);
    await writeFile(join(nestedPath, "plan.html"), "<!doctype html><title>Replacement parent</title>");
    const replacementOpen = await open();
    expect(replacementOpen.status).toBe(400);
    expect(await replacementOpen.json()).toMatchObject({
      error: expect.stringContaining("daemon process must terminate"),
    });

    await rename(nestedPath, replacementPath);
    await rename(parkedPath, nestedPath);
    expect(await server.closed).toBe(false);
    expect(server.watchedSessionIds()).toEqual([]);
    expect(watcherCloseCalls).toBeGreaterThanOrEqual(2);
    const restoredOpen = await open().catch(() => undefined);
    expect(restoredOpen?.status).not.toBe(200);
    await writeFile(artifactPath, "<!doctype html><title>Changed after retirement</title>");
    watcher.emit("change", artifactPath);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(server.store.get(sessionId)?.revision).toBe(1);
    runningServers.splice(runningServers.indexOf(server), 1);
  },
);

test("terminates instead of retaining a watcher that errors after readiness", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-watcher-runtime-error-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  const artifactPath = join(rootPath, "plan.html");
  await mkdir(rootPath);
  await mkdir(uiDirectory);
  await writeFile(artifactPath, "<!doctype html><title>Revision one</title>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");

  let watcher: FSWatcher | undefined;
  const watcherFactory = (() => {
    const created = new EventEmitter() as FSWatcher;
    created.close = async () => undefined;
    watcher = created;
    queueMicrotask(() => created.emit("ready"));
    return created;
  }) as typeof import("chokidar").default.watch;
  const server = await startServer({
    rootPath,
    token: "watcher-runtime-error-token",
    uiDirectory,
    bridgeSource: "",
    watcherFactory,
  });
  runningServers.push(server);
  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: {
      authorization: "Bearer watcher-runtime-error-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  expect(createResponse.status).toBe(200);
  const sessionId = server.store.list()[0]?.id;
  if (!sessionId || !watcher) throw new Error("The runtime watcher-error fixture did not initialize.");

  watcher.emit("error", new Error("simulated runtime watcher failure"));
  expect(await server.closed).toBe(false);
  expect(server.watchedSessionIds()).toEqual([]);
  await writeFile(artifactPath, "<!doctype html><title>Revision two</title>");
  watcher.emit("change", artifactPath);
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
  expect(server.store.get(sessionId)?.revision).toBe(1);
  runningServers.splice(runningServers.indexOf(server), 1);
});

test.skipIf(process.platform === "win32")(
  "marks health incompatible when the live private-state directory is replaced",
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-state-health-"));
    temporaryDirectories.push(temporaryDirectory);
    const rootPath = join(temporaryDirectory, "project");
    const uiDirectory = join(temporaryDirectory, "ui");
    const stateDirectory = join(rootPath, ".agent-html-render");
    const movedStateDirectory = join(rootPath, ".agent-html-render-moved");
    const startupCoordinatorId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await mkdir(rootPath, { recursive: true });
    await mkdir(uiDirectory, { recursive: true });
    await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");

    const server = await startServer({
      rootPath,
      token: "state-health-token",
      uiDirectory,
      bridgeSource: "",
      startupCoordinatorId,
    });
    runningServers.push(server);
    const metadata: DaemonMetadata = {
      protocolVersion: "1",
      packageVersion: server.packageVersion,
      buildId: server.buildId,
      pid: process.pid,
      rootPath: server.rootPath,
      rootDevice: server.rootDevice,
      rootInode: server.rootInode,
      stateDevice: server.stateDevice,
      stateInode: server.stateInode,
      startupCoordinatorId,
      port: server.port,
      token: "state-health-token",
      startedAt: "2026-08-30T00:00:00.000Z",
    };
    const expectedBuild = {
      packageVersion: server.packageVersion,
      buildId: server.buildId,
    };
    const readHealth = async (): Promise<unknown> => {
      const response = await fetch(`${server.origin}/api/health`, {
        headers: { authorization: "Bearer state-health-token" },
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    expect(inspectDaemonHealth(metadata, await readHealth(), expectedBuild)).toEqual({
      healthy: true,
      compatible: true,
    });

    await rename(stateDirectory, movedStateDirectory);
    await cp(movedStateDirectory, stateDirectory, { recursive: true, preserveTimestamps: true });
    const replacedHealth = await readHealth();
    expect(replacedHealth).toMatchObject({ stateIdentityCurrent: false });
    expect(inspectDaemonHealth(metadata, replacedHealth, expectedBuild)).toEqual({
      healthy: true,
      compatible: false,
    });
  },
);

test.skipIf(process.platform !== "linux")(
  "requires the health daemon to own the matching lifetime coordinator",
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-coordinator-health-"));
    temporaryDirectories.push(temporaryDirectory);
    const rootPath = join(temporaryDirectory, "project");
    const uiDirectory = join(temporaryDirectory, "ui");
    await mkdir(rootPath, { recursive: true });
    await mkdir(uiDirectory, { recursive: true });
    await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
    const release = await acquireStartupLock(rootPath);
    const server = await startServer({
      rootPath,
      token: "coordinator-health-token",
      uiDirectory,
      bridgeSource: "",
      startupCoordinatorId: release.ownerId,
    });
    runningServers.push(server);
    const metadata: DaemonMetadata = {
      protocolVersion: "1",
      packageVersion: server.packageVersion,
      buildId: server.buildId,
      pid: process.pid,
      rootPath: server.rootPath,
      rootDevice: server.rootDevice,
      rootInode: server.rootInode,
      stateDevice: server.stateDevice,
      stateInode: server.stateInode,
      startupCoordinatorId: release.ownerId,
      port: server.port,
      token: "coordinator-health-token",
      startedAt: "2026-08-30T00:00:00.000Z",
    };
    const expectedBuild = {
      packageVersion: server.packageVersion,
      buildId: server.buildId,
    };
    try {
      await expect(inspectDaemon(metadata, expectedBuild)).resolves.toEqual({
        healthy: true,
        compatible: true,
      });
    } finally {
      await release();
    }
    await expect(inspectDaemon(metadata, expectedBuild)).resolves.toEqual({
      healthy: true,
      compatible: false,
    });
  },
);

test("marks a daemon stale when npx replaces its cached UI assets", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-cache-refresh-"));
  temporaryDirectories.push(temporaryDirectory);

  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, ".npm", "_npx", "package", "dist", "ui");
  const assetsDirectory = join(uiDirectory, "assets");
  const oldIndex = '<!doctype html><script type="module" src="/assets/index-old.js"></script>';
  const newIndex = '<!doctype html><script type="module" src="/assets/index-new.js"></script>';
  const bridgeSource = "window.__agentHtmlRenderBridge = true;";
  await mkdir(rootPath, { recursive: true });
  await mkdir(assetsDirectory, { recursive: true });
  await writeFile(join(rootPath, "plan.html"), "<!doctype html><title>Plan</title>");
  await writeFile(join(uiDirectory, "index.html"), oldIndex);
  await writeFile(join(assetsDirectory, "index-old.js"), "window.oldShell = true;");

  const server = await startServer({
    rootPath,
    token: "cache-refresh-token",
    uiDirectory,
    bridgeSource,
  });
  runningServers.push(server);

  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: {
      authorization: "Bearer cache-refresh-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  const created = (await createResponse.json()) as { session: { reviewUrl: string } };

  await writeFile(join(uiDirectory, "index.html"), newIndex);
  await writeFile(join(assetsDirectory, "index-new.js"), "window.newShell = true;");
  await rm(join(assetsDirectory, "index-old.js"));

  const stalePage = await fetch(created.session.reviewUrl);
  expect(await stalePage.text()).toContain("index-old.js");
  const snapshottedAsset = await fetch(`${server.origin}/assets/index-old.js`);
  expect(snapshottedAsset.status).toBe(200);
  expect(await snapshottedAsset.text()).toContain("oldShell");

  const healthResponse = await fetch(`${server.origin}/api/health`, {
    headers: { authorization: "Bearer cache-refresh-token" },
  });
  const health = await healthResponse.json();
  const expectedBuild = createRuntimeBuildIdentity(
    newIndex,
    bridgeSource,
    new Map([["index-new.js", Buffer.from("window.newShell = true;")]]),
  );
  const metadata: DaemonMetadata = {
    protocolVersion: "1",
    packageVersion: server.packageVersion,
    buildId: server.buildId,
    pid: process.pid,
    rootPath: server.rootPath,
    rootDevice: server.rootDevice,
    rootInode: server.rootInode,
    port: server.port,
    token: "cache-refresh-token",
    startedAt: "2026-08-22T00:00:00.000Z",
  };

  expect(server.buildId).not.toBe(expectedBuild.buildId);
  expect(inspectDaemonHealth(metadata, health, expectedBuild)).toEqual({
    healthy: true,
    compatible: false,
  });
});

test("keeps feedback pending until acknowledgement and resumes an ended session in order", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-delivery-"));
  temporaryDirectories.push(temporaryDirectory);

  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  await mkdir(rootPath, { recursive: true });
  await mkdir(uiDirectory, { recursive: true });
  await writeFile(join(rootPath, "plan.html"), "<!doctype html><title>Plan</title>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");

  const server = await startServer({
    rootPath,
    token: "delivery-test-token",
    uiDirectory,
    bridgeSource: "",
  });
  runningServers.push(server);
  const healthResponse = await fetch(`${server.origin}/api/health`, {
    headers: { authorization: "Bearer delivery-test-token" },
  });
  expect(healthResponse.status).toBe(200);
  expect((await healthResponse.json()) as { capabilities: string[] }).toMatchObject({
    capabilities: [EXPLICIT_FEEDBACK_ACK_CAPABILITY],
    packageVersion: server.packageVersion,
    buildId: server.buildId,
  });
  const agentHeaders = {
    authorization: "Bearer delivery-test-token",
    "content-type": "application/json",
  };

  const createSession = async (): Promise<{ id: string; reviewUrl: string; status: string; cursor: number }> => {
    const response = await fetch(`${server.origin}/api/agent/sessions`, {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({ artifactPath: "plan.html" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { id: string; reviewUrl: string; status: string };
      cursor: number;
    };
    return { ...body.session, cursor: body.cursor };
  };

  const created = await createSession();
  const reviewUrl = new URL(created.reviewUrl);
  const access = reviewUrl.searchParams.get("access");
  expect(access).toBeTruthy();
  const reviewEndpoint = (path: string): string =>
    `${server.origin}/api/review/${encodeURIComponent(created.id)}${path}?access=${encodeURIComponent(access ?? "")}`;

  const stateResponse = await fetch(reviewEndpoint("/state"));
  const state = (await stateResponse.json()) as { revision: number; contentHash: string };

  const firstSend = await fetch(reviewEndpoint("/send"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      draft: { message: "Revise this.", annotations: [] },
      end: false,
      baseRevision: state.revision,
      baseContentHash: state.contentHash,
      submissionId: "first-send",
    }),
  });
  expect(firstSend.status).toBe(200);
  const finalSend = await fetch(reviewEndpoint("/send"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      draft: { message: "", annotations: [] },
      end: true,
      baseRevision: state.revision,
      baseContentHash: state.contentHash,
      submissionId: "final-send",
    }),
  });
  expect(finalSend.status).toBe(200);

  const waitHeaders = {
    authorization: "Bearer delivery-test-token",
    [FEEDBACK_ACK_HEADER]: EXPLICIT_FEEDBACK_ACK_CAPABILITY,
  };
  const waitUrl = (after: number): string =>
    `${server.origin}/api/agent/sessions/${created.id}/wait?after=${after}&consumer=delivery-test-consumer` +
    "&afterburner=ignored&consumerism=ignored";
  const originalLeaseNextUndelivered = server.store.leaseNextUndelivered.bind(server.store);
  const originalOnFeedback = server.store.onFeedback.bind(server.store);
  let waitLeaseAttempts = 0;
  let waitListenerRegistrations = 0;
  server.store.leaseNextUndelivered = (id, after, consumerId) => {
    waitLeaseAttempts += 1;
    return originalLeaseNextUndelivered(id, after, consumerId);
  };
  server.store.onFeedback = (id, listener) => {
    waitListenerRegistrations += 1;
    return originalOnFeedback(id, listener);
  };
  const capabilitylessWait = await fetch(
    `${server.origin}/api/agent/sessions/${created.id}/wait?after=0&consumer=legacy-consumer`,
    {
      headers: { authorization: "Bearer delivery-test-token" },
    },
  );
  expect(capabilitylessWait.status).toBe(428);
  expect(await capabilitylessWait.json()).toEqual({
    error:
      `Feedback delivery requires ${FEEDBACK_ACK_HEADER}: ${EXPLICIT_FEEDBACK_ACK_CAPABILITY} ` +
      "and a separate exact-grant acknowledgement.",
  });
  expect(server.store.get(created.id)?.deliveredFeedbackSequence).toBe(0);
  const consumerError = {
    error:
      "Feedback delivery requires a valid consumer query parameter: 1-120 letters, digits, periods, " +
      "underscores, colons, or hyphens, beginning with a letter or digit.",
  };
  for (const consumerQuery of [
    "",
    "&consumer=",
    "&consumer=%20invalid",
    "&consumer=.invalid",
    `&consumer=${"a".repeat(121)}`,
    "&consumer=first&consumer=second",
    "&consumer%5B0%5D=nested",
    "&consumer=valid-consumer&consumer%5B0%5D=nested",
    "&consumer.0=nested",
    "&consumer%00=nested",
  ]) {
    const invalidConsumerWait = await fetch(
      `${server.origin}/api/agent/sessions/${created.id}/wait?after=0${consumerQuery}`,
      { headers: waitHeaders },
    );
    expect(invalidConsumerWait.status).toBe(400);
    expect(await invalidConsumerWait.json()).toEqual(consumerError);
  }
  expect(server.store.get(created.id)?.deliveredFeedbackSequence).toBe(0);
  const cursorError = {
    error: "Feedback delivery requires after to be a complete non-negative safe-integer decimal cursor.",
  };
  for (const cursorQuery of [
    "after=",
    "after=alphabetic",
    "after=-1",
    "after=1.5",
    "after=1partial",
    "after=1&after=2",
    "after%5B0%5D=0",
    "after%5B%5D=0",
    "after=0&after%5B0%5D=1",
    "after.0=0",
    "after%00=0",
    `after=${"0".repeat(10_000)}`,
    `after=${"9".repeat(121)}`,
  ]) {
    const invalidCursorWait = await fetch(
      `${server.origin}/api/agent/sessions/${created.id}/wait?${cursorQuery}&consumer=cursor-test-consumer`,
      { headers: waitHeaders },
    );
    expect(invalidCursorWait.status).toBe(400);
    expect(await invalidCursorWait.json()).toEqual(cursorError);
  }
  expect(server.store.get(created.id)?.deliveredFeedbackSequence).toBe(0);
  expect(waitLeaseAttempts).toBe(0);
  expect(waitListenerRegistrations).toBe(0);
  const firstWait = await fetch(waitUrl(0), {
    headers: waitHeaders,
  });
  expect(firstWait.status).toBe(200);
  const firstDelivery = (await firstWait.json()) as { sequence: number; leaseId: string };
  expect(firstDelivery.sequence).toBe(1);
  expect(firstDelivery.leaseId).toMatch(/^[a-zA-Z0-9_-]{32}$/u);
  expect(server.store.get(created.id)?.deliveredFeedbackSequence).toBe(0);
  expect(waitLeaseAttempts).toBeGreaterThan(0);
  expect(waitListenerRegistrations).toBe(1);

  const outOfOrderAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 2,
      consumerId: "delivery-test-consumer",
      leaseId: firstDelivery.leaseId,
    }),
  });
  expect(outOfOrderAck.status).toBe(400);

  const retry = await fetch(waitUrl(0), {
    headers: waitHeaders,
  });
  const retryDelivery = (await retry.json()) as { sequence: number; leaseId: string };
  expect(retryDelivery).toEqual(firstDelivery);
  const unauthenticatedRenewal = await fetch(
    `${server.origin}/api/agent/sessions/${created.id}/renew-lease`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sequence: 1,
        consumerId: "delivery-test-consumer",
        leaseId: firstDelivery.leaseId,
      }),
    },
  );
  expect(unauthenticatedRenewal.status).toBe(401);
  const wrongRenewalLeaseId = `${firstDelivery.leaseId.slice(0, -1)}${firstDelivery.leaseId.endsWith("A") ? "B" : "A"}`;
  const wrongRenewal = await fetch(`${server.origin}/api/agent/sessions/${created.id}/renew-lease`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 1,
      consumerId: "delivery-test-consumer",
      leaseId: wrongRenewalLeaseId,
    }),
  });
  expect(await wrongRenewal.json()).toEqual({ renewed: false });
  const exactRenewal = await fetch(`${server.origin}/api/agent/sessions/${created.id}/renew-lease`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 1,
      consumerId: "delivery-test-consumer",
      leaseId: firstDelivery.leaseId,
    }),
  });
  expect(await exactRenewal.json()).toEqual({ renewed: true, expiresAt: expect.any(Number) });
  const missingConsumerAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ sequence: 1, leaseId: firstDelivery.leaseId }),
  });
  expect(missingConsumerAck.status).toBe(400);
  const missingLeaseAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ sequence: 1, consumerId: "delivery-test-consumer" }),
  });
  expect(missingLeaseAck.status).toBe(400);
  const firstAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 1,
      consumerId: "delivery-test-consumer",
      leaseId: firstDelivery.leaseId,
    }),
  });
  expect(firstAck.status).toBe(200);

  const resumed = await createSession();
  expect(resumed).toMatchObject({ id: created.id, status: "ended", cursor: 1 });
  const finalWait = await fetch(
    `${server.origin}/api/agent/sessions/${created.id}/wait?consumer=delivery-test-consumer`,
    { headers: waitHeaders },
  );
  const finalDelivery = (await finalWait.json()) as {
    sequence: number;
    leaseId: string;
    feedback: { status: string };
  };
  expect(finalDelivery).toMatchObject({ sequence: 2, feedback: { status: "ended" } });
  expect(server.store.get(created.id)?.deliveredFeedbackSequence).toBe(1);

  const unauthenticatedRelease = await fetch(
    `${server.origin}/api/agent/sessions/${created.id}/release-lease`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sequence: 2,
        consumerId: "delivery-test-consumer",
        leaseId: finalDelivery.leaseId,
      }),
    },
  );
  expect(unauthenticatedRelease.status).toBe(401);
  const staleLeaseId = `${finalDelivery.leaseId.slice(0, -1)}${finalDelivery.leaseId.endsWith("A") ? "B" : "A"}`;
  const staleRelease = await fetch(`${server.origin}/api/agent/sessions/${created.id}/release-lease`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 2,
      consumerId: "delivery-test-consumer",
      leaseId: staleLeaseId,
    }),
  });
  expect(await staleRelease.json()).toEqual({ released: false });
  const exactRelease = await fetch(`${server.origin}/api/agent/sessions/${created.id}/release-lease`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 2,
      consumerId: "delivery-test-consumer",
      leaseId: finalDelivery.leaseId,
    }),
  });
  expect(await exactRelease.json()).toEqual({ released: true });
  const finalRetry = await fetch(waitUrl(1), { headers: waitHeaders });
  const finalRetryDelivery = (await finalRetry.json()) as { sequence: number; leaseId: string };
  expect(finalRetryDelivery.sequence).toBe(2);
  expect(finalRetryDelivery.leaseId).not.toBe(finalDelivery.leaseId);

  const staleAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 2,
      consumerId: "delivery-test-consumer",
      leaseId: finalDelivery.leaseId,
    }),
  });
  expect(staleAck.status).toBe(400);

  const finalAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 2,
      consumerId: "delivery-test-consumer",
      leaseId: finalRetryDelivery.leaseId,
    }),
  });
  expect(finalAck.status).toBe(200);
  expect(server.store.get(created.id)?.deliveredFeedbackSequence).toBe(2);
  const committedStaleAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 2,
      consumerId: "delivery-test-consumer",
      leaseId: finalDelivery.leaseId,
    }),
  });
  expect(committedStaleAck.status).toBe(400);
  const repeatedExactAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 2,
      consumerId: "delivery-test-consumer",
      leaseId: finalRetryDelivery.leaseId,
    }),
  });
  expect(repeatedExactAck.status).toBe(200);

  const implicitRestart = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  expect(implicitRestart.status).toBe(409);
  expect(await implicitRestart.json()).toMatchObject({
    error: expect.stringContaining("--new"),
    endedSessionId: created.id,
  });

  const explicitRestart = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ artifactPath: "plan.html", newSession: true }),
  });
  expect(explicitRestart.status).toBe(200);
  const restarted = (await explicitRestart.json()) as { session: { id: string; status: string } };
  expect(restarted.session).toMatchObject({ status: "open" });
  expect(restarted.session.id).not.toBe(created.id);
});

test("rejects an expired exact grant at the authenticated acknowledgement route", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-server-expired-ack-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  const artifactPath = join(rootPath, "plan.html");
  const hash = "a".repeat(64);
  await mkdir(rootPath);
  await mkdir(uiDirectory);
  await writeFile(artifactPath, "<!doctype html><p>Review</p>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
  const token = "expired-ack-route-token";
  const server = await startServer({ rootPath, token, uiDirectory, bridgeSource: "" });
  runningServers.push(server);
  const session = await server.store.create({
    rootPath,
    artifactPath,
    artifactRelativePath: "plan.html",
    contentHash: hash,
  });
  await server.store.sendFeedback(
    session.id,
    { message: "Reject this after its grant expires.", annotations: [] },
    false,
    1,
    hash,
    "expired-ack-route-send",
  );
  const expired = withMockedNow(Date.now() - FEEDBACK_LEASE_MILLISECONDS - 1, () =>
    server.store.leaseNextUndelivered(session.id, 0, "expired-route-consumer"));
  if (!expired.delivery) throw new Error("Expected the route's expired test grant.");
  const agentHeaders = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  const expiredAck = await fetch(`${server.origin}/api/agent/sessions/${session.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 1,
      consumerId: "expired-route-consumer",
      leaseId: expired.leaseId,
    }),
  });
  expect(expiredAck.status).toBe(400);
  expect(await expiredAck.json()).toMatchObject({
    error: expect.stringContaining("current unexpired delivery lease"),
  });
  expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(0);

  const successor = server.store.leaseNextUndelivered(session.id, 0, "successor-route-consumer");
  if (!successor.delivery) throw new Error("Expected a fresh route grant after expiry.");
  const successorAck = await fetch(`${server.origin}/api/agent/sessions/${session.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      sequence: 1,
      consumerId: "successor-route-consumer",
      leaseId: successor.leaseId,
    }),
  });
  expect(successorAck.status).toBe(200);
  expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(1);
});

test.skipIf(process.platform === "win32")("fails closed after a reviewed artifact is swapped outside the project", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-server-swap-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  const artifactPath = join(rootPath, "plan.html");
  const outsidePath = join(temporaryDirectory, "outside.html");
  await mkdir(rootPath);
  await mkdir(uiDirectory);
  await writeFile(artifactPath, "<!doctype html><p>Inside</p>");
  await writeFile(outsidePath, "<!doctype html><p>Outside sentinel</p>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
  const server = await startServer({
    rootPath,
    token: "swap-test-token",
    uiDirectory,
    bridgeSource: "",
  });
  runningServers.push(server);
  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: { authorization: "Bearer swap-test-token", "content-type": "application/json" },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  const created = (await createResponse.json()) as { session: { id: string; reviewUrl: string } };
  const state = server.store.getPublicState(created.session.id);
  if (!state) throw new Error("fixture session is missing");
  const reviewUrl = new URL(created.session.reviewUrl);
  const access = reviewUrl.searchParams.get("access") ?? "";
  const reviewEndpoint = (path: string): string =>
    `${server.origin}/api/review/${created.session.id}${path}?access=${encodeURIComponent(access)}`;

  await rm(artifactPath);
  await symlink(outsidePath, artifactPath);

  const artifactResponse = await fetch(reviewEndpoint("/artifact"));
  expect(artifactResponse.status).toBe(400);
  expect(await artifactResponse.text()).not.toContain("Outside sentinel");
  const sendResponse = await fetch(reviewEndpoint("/send"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      draft: { message: "Do not leak outside content.", annotations: [] },
      end: false,
      baseRevision: state.revision,
      baseContentHash: state.contentHash,
      submissionId: "swap-send",
    }),
  });
  expect(sendResponse.status).toBe(400);
  expect(server.store.get(created.session.id)?.feedbackEvents).toEqual([]);
  expect(server.store.getPublicState(created.session.id)).toMatchObject({
    revision: state.revision,
    contentHash: state.contentHash,
  });
});

test.skipIf(process.platform === "win32")("requires explicit recovery after an artifact parent is replaced", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-server-parent-recovery-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  const nestedPath = join(rootPath, "nested");
  const parkedPath = join(rootPath, "nested-original");
  await mkdir(nestedPath, { recursive: true });
  await mkdir(uiDirectory);
  await writeFile(join(nestedPath, "page.html"), "<!doctype html><p>Original parent</p>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
  const server = await startServer({
    rootPath,
    token: "parent-recovery-token",
    uiDirectory,
    bridgeSource: "",
  });
  runningServers.push(server);
  const headers = {
    authorization: "Bearer parent-recovery-token",
    "content-type": "application/json",
  };
  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ artifactPath: "nested/page.html" }),
  });
  const created = (await createResponse.json()) as { session: { id: string; reviewUrl: string } };
  const original = server.store.get(created.session.id);
  if (!original) throw new Error("parent recovery fixture session is missing");
  await server.store.updateDraft(
    original.id,
    { message: "Preserve this draft.", annotations: [] },
    original.revision,
    original.contentHash,
  );

  await rename(nestedPath, parkedPath);
  await mkdir(nestedPath);
  // Keep identical bytes to prove parent-identity recovery still requires an
  // explicit reviewer rebase even when the content hash happens to match.
  await writeFile(join(nestedPath, "page.html"), "<!doctype html><p>Original parent</p>");

  const implicit = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ artifactPath: "nested/page.html" }),
  });
  expect(implicit.status).toBe(409);
  expect(await implicit.json()).toMatchObject({
    code: "artifact_parent_changed",
    existingSessionId: created.session.id,
    recoverableDraft: true,
    error: expect.stringContaining("--new"),
  });
  expect(server.watchedSessionIds()).not.toContain(created.session.id);

  const explicit = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ artifactPath: "nested/page.html", newSession: true }),
  });
  expect(explicit.status).toBe(200);
  const restarted = (await explicit.json()) as {
    session: { id: string; reviewUrl: string };
    artifactAvailable: boolean;
  };
  expect(restarted.artifactAvailable).toBe(true);
  expect(restarted.session.id).not.toBe(created.session.id);
  expect(server.watchedSessionIds()).toEqual([restarted.session.id]);
  expect(server.store.get(created.session.id)).toMatchObject({
    status: "superseded",
    supersededBySessionId: restarted.session.id,
    draft: { message: "", annotations: [] },
  });
  expect(server.store.get(restarted.session.id)).toMatchObject({
    draft: { message: "Preserve this draft." },
    draftBaseRevision: original.revision,
    draftBaseContentHash: original.contentHash,
    draftRecoveryRequired: true,
  });

  const reviewUrl = new URL(restarted.session.reviewUrl);
  const artifactResponse = await fetch(
    `${server.origin}/api/review/${restarted.session.id}/artifact${reviewUrl.search}`,
  );
  expect(artifactResponse.status).toBe(200);
  expect(await artifactResponse.text()).toContain("Original parent");
  const replacementState = server.store.getPublicState(restarted.session.id);
  if (!replacementState) throw new Error("replacement recovery state is missing");
  const blockedSend = await fetch(
    `${server.origin}/api/review/${restarted.session.id}/send${reviewUrl.search}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: replacementState.draft,
        end: false,
        baseRevision: replacementState.revision,
        baseContentHash: replacementState.contentHash,
        submissionId: "recovered-before-confirmation",
      }),
    },
  );
  expect(blockedSend.status).toBe(409);
  const confirmResponse = await fetch(
    `${server.origin}/api/review/${restarted.session.id}/draft${reviewUrl.search}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: replacementState.draft,
        baseRevision: replacementState.revision,
        baseContentHash: replacementState.contentHash,
        confirmRecovery: true,
      }),
    },
  );
  expect(confirmResponse.status).toBe(200);
  expect(server.store.get(restarted.session.id)?.draftRecoveryRequired).toBe(false);

  const confirmed = server.store.getPublicState(restarted.session.id);
  if (!confirmed) throw new Error("confirmed replacement state is missing");
  const endResponse = await fetch(
    `${server.origin}/api/review/${restarted.session.id}/send${reviewUrl.search}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: confirmed.draft,
        end: true,
        baseRevision: confirmed.revision,
        baseContentHash: confirmed.contentHash,
        submissionId: "recovered-end-once",
      }),
    },
  );
  expect(endResponse.status).toBe(200);
  const endedDelivery = server.store.leaseNextUndelivered(
    restarted.session.id,
    0,
    "confirmed-recovery-consumer",
  );
  if (!endedDelivery.delivery) throw new Error("Expected the recovered ended feedback delivery.");
  await server.store.markDelivered(
    restarted.session.id,
    endedDelivery.delivery.sequence,
    "confirmed-recovery-consumer",
    endedDelivery.leaseId,
  );

  const ordinaryAfterEnd = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ artifactPath: "nested/page.html" }),
  });
  expect(ordinaryAfterEnd.status).toBe(409);
  expect(await ordinaryAfterEnd.json()).toMatchObject({ endedSessionId: restarted.session.id });

  const freshResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ artifactPath: "nested/page.html", newSession: true }),
  });
  expect(freshResponse.status).toBe(200);
  const fresh = (await freshResponse.json()) as { session: { id: string } };
  expect(fresh.session.id).not.toBe(restarted.session.id);
  expect(server.store.get(fresh.session.id)).toMatchObject({
    draft: { message: "", annotations: [] },
    draftRecoveryRequired: false,
  });
});

test.skipIf(process.platform === "win32")("delivers pending feedback explicitly when an artifact parent was replaced", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-server-parent-pending-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  const nestedPath = join(rootPath, "nested");
  await mkdir(nestedPath, { recursive: true });
  await mkdir(uiDirectory);
  await writeFile(join(nestedPath, "page.html"), "<!doctype html><p>Original parent</p>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
  const server = await startServer({
    rootPath,
    token: "parent-pending-token",
    uiDirectory,
    bridgeSource: "",
  });
  runningServers.push(server);
  const agentHeaders = {
    authorization: "Bearer parent-pending-token",
    "content-type": "application/json",
  };
  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ artifactPath: "nested/page.html" }),
  });
  const created = (await createResponse.json()) as { session: { id: string; reviewUrl: string } };
  const state = server.store.getPublicState(created.session.id);
  if (!state) throw new Error("pending recovery fixture session is missing");
  const reviewUrl = new URL(created.session.reviewUrl);
  const sendResponse = await fetch(
    `${server.origin}/api/review/${created.session.id}/send${reviewUrl.search}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: { message: "Committed before replacement.", annotations: [] },
        end: false,
        baseRevision: state.revision,
        baseContentHash: state.contentHash,
        submissionId: "parent-pending-send",
      }),
    },
  );
  expect(sendResponse.status).toBe(200);

  await rename(nestedPath, join(rootPath, "nested-original"));
  await mkdir(nestedPath);
  await writeFile(join(nestedPath, "page.html"), "<!doctype html><p>Replacement parent</p>");

  const recoveryResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ artifactPath: "nested/page.html", newSession: true }),
  });
  expect(recoveryResponse.status).toBe(200);
  expect(await recoveryResponse.json()).toMatchObject({
    session: { id: created.session.id },
    artifactAvailable: false,
    warning: expect.stringContaining("pending feedback"),
  });

  const waitResponse = await fetch(
    `${server.origin}/api/agent/sessions/${created.session.id}/wait?after=0&consumer=parent-recovery-agent`,
    {
      headers: {
        authorization: "Bearer parent-pending-token",
        [FEEDBACK_ACK_HEADER]: EXPLICIT_FEEDBACK_ACK_CAPABILITY,
      },
    },
  );
  expect(waitResponse.status).toBe(200);
  const pendingDelivery = (await waitResponse.json()) as { sequence: number; leaseId: string };
  expect(pendingDelivery).toMatchObject({ sequence: 1 });
});

test.skipIf(process.platform === "win32")("recovers pending feedback and drafts after restart with a replaced artifact parent", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-server-parent-restart-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  const nestedPath = join(rootPath, "nested");
  await mkdir(nestedPath, { recursive: true });
  await mkdir(uiDirectory);
  await writeFile(join(nestedPath, "page.html"), "<!doctype html><p>Original parent</p>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
  const token = "parent-restart-token";
  const agentHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const firstServer = await startServer({ rootPath, token, uiDirectory, bridgeSource: "" });
  runningServers.push(firstServer);
  const createResponse = await fetch(`${firstServer.origin}/api/agent/sessions`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ artifactPath: "nested/page.html" }),
  });
  const created = (await createResponse.json()) as { session: { id: string; reviewUrl: string } };
  const initial = firstServer.store.getPublicState(created.session.id);
  if (!initial) throw new Error("restart recovery fixture session is missing");
  const reviewUrl = new URL(created.session.reviewUrl);
  const sendResponse = await fetch(
    `${firstServer.origin}/api/review/${created.session.id}/send${reviewUrl.search}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: { message: "Committed before restart.", annotations: [] },
        end: false,
        baseRevision: initial.revision,
        baseContentHash: initial.contentHash,
        submissionId: "parent-restart-send",
      }),
    },
  );
  expect(sendResponse.status).toBe(200);
  await firstServer.store.updateDraft(
    created.session.id,
    { message: "Unsent draft survives restart.", annotations: [] },
    initial.revision,
    initial.contentHash,
  );
  await firstServer.close();
  runningServers.splice(runningServers.indexOf(firstServer), 1);

  await rename(nestedPath, join(rootPath, "nested-original"));
  await mkdir(nestedPath);
  await writeFile(join(nestedPath, "page.html"), "<!doctype html><p>Replacement parent</p>");

  const secondServer = await startServer({ rootPath, token, uiDirectory, bridgeSource: "" });
  runningServers.push(secondServer);
  expect(secondServer.watchedSessionIds()).not.toContain(created.session.id);
  const recoveryResponse = await fetch(`${secondServer.origin}/api/agent/sessions`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ artifactPath: "nested/page.html" }),
  });
  expect(recoveryResponse.status).toBe(200);
  expect(await recoveryResponse.json()).toMatchObject({
    session: { id: created.session.id },
    artifactAvailable: false,
  });
  expect(secondServer.store.get(created.session.id)?.draft.message).toBe("Unsent draft survives restart.");

  const consumerId = "parent-restart-agent";
  const waitResponse = await fetch(
    `${secondServer.origin}/api/agent/sessions/${created.session.id}/wait?after=0&consumer=${consumerId}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        [FEEDBACK_ACK_HEADER]: EXPLICIT_FEEDBACK_ACK_CAPABILITY,
      },
    },
  );
  expect(waitResponse.status).toBe(200);
  const pendingDelivery = (await waitResponse.json()) as { sequence: number; leaseId: string };
  expect(pendingDelivery).toMatchObject({ sequence: 1 });
  const acknowledgeResponse = await fetch(
    `${secondServer.origin}/api/agent/sessions/${created.session.id}/ack`,
    {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({ sequence: 1, consumerId, leaseId: pendingDelivery.leaseId }),
    },
  );
  expect(acknowledgeResponse.status).toBe(200);

  const replacementResponse = await fetch(`${secondServer.origin}/api/agent/sessions`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ artifactPath: "nested/page.html", newSession: true }),
  });
  expect(replacementResponse.status).toBe(200);
  const replacement = (await replacementResponse.json()) as { session: { id: string }; warning?: string };
  expect(replacement.session.id).not.toBe(created.session.id);
  expect(replacement.warning).toContain("Recovered unsent notes");
  expect(secondServer.store.get(created.session.id)).toMatchObject({
    status: "superseded",
    supersededBySessionId: replacement.session.id,
    draft: { message: "", annotations: [] },
  });
  expect(secondServer.store.get(replacement.session.id)).toMatchObject({
    draft: { message: "Unsent draft survives restart." },
    draftBaseRevision: initial.revision,
    draftBaseContentHash: initial.contentHash,
    draftRecoveryRequired: true,
  });
  expect(secondServer.watchedSessionIds()).toEqual([replacement.session.id]);
});

test.skipIf(process.platform === "win32")("restores the parent watcher while the final artifact is briefly absent", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-server-missing-final-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  const artifactPath = join(rootPath, "plan.html");
  const parkedArtifactPath = join(rootPath, "plan.parked");
  await mkdir(rootPath);
  await mkdir(uiDirectory);
  await writeFile(artifactPath, "<!doctype html><p>Revision one</p>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
  const token = "missing-final-token";
  const firstServer = await startServer({ rootPath, token, uiDirectory, bridgeSource: "" });
  runningServers.push(firstServer);
  const createResponse = await fetch(`${firstServer.origin}/api/agent/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  const created = (await createResponse.json()) as { session: { id: string } };
  await firstServer.close();
  runningServers.splice(runningServers.indexOf(firstServer), 1);
  await rename(artifactPath, parkedArtifactPath);

  const secondServer = await startServer({ rootPath, token, uiDirectory, bridgeSource: "" });
  runningServers.push(secondServer);
  expect(secondServer.watchedSessionIds()).toContain(created.session.id);

  await writeFile(artifactPath, "<!doctype html><p>Revision two</p>");
  await expect.poll(() => secondServer.store.get(created.session.id)?.revision).toBe(2);
});

test("fails closed after the selected project root is replaced at the same path", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-server-root-swap-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const movedRoot = join(temporaryDirectory, "project-old");
  const replacementRoot = join(temporaryDirectory, "replacement");
  const uiDirectory = join(temporaryDirectory, "ui");
  await mkdir(rootPath);
  await mkdir(replacementRoot);
  await mkdir(join(replacementRoot, ".agent-html-render", "sessions"), { recursive: true });
  await writeFile(join(replacementRoot, ".agent-html-render", "sessions", "sentinel.txt"), "keep replacement state");
  await mkdir(uiDirectory);
  await writeFile(join(rootPath, "plan.html"), "<!doctype html><p>Inside</p>");
  await writeFile(join(replacementRoot, "plan.html"), "<!doctype html><p>Replacement sentinel</p>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
  const server = await startServer({
    rootPath,
    token: "root-swap-test-token",
    uiDirectory,
    bridgeSource: "",
  });
  runningServers.push(server);
  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: { authorization: "Bearer root-swap-test-token", "content-type": "application/json" },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  const created = (await createResponse.json()) as { session: { id: string; reviewUrl: string } };
  const initialState = server.store.getPublicState(created.session.id);
  if (!initialState) throw new Error("root replacement fixture session is missing");
  const reviewUrl = new URL(created.session.reviewUrl);
  await rename(rootPath, movedRoot);
  await rename(replacementRoot, rootPath);

  const artifactResponse = await fetch(
    `${server.origin}/api/review/${created.session.id}/artifact${reviewUrl.search}`,
  );
  expect(artifactResponse.status).toBe(400);
  expect(await artifactResponse.text()).not.toContain("Replacement sentinel");

  const draftResponse = await fetch(
    `${server.origin}/api/review/${created.session.id}/draft${reviewUrl.search}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: { message: "Private note from the original root.", annotations: [] },
        baseRevision: initialState.revision,
        baseContentHash: initialState.contentHash,
      }),
    },
  );
  expect(draftResponse.status).not.toBe(200);
  expect(await readdir(join(rootPath, ".agent-html-render", "sessions"))).toEqual(["sentinel.txt"]);
  expect(await readFile(join(rootPath, ".agent-html-render", "sessions", "sentinel.txt"), "utf8"))
    .toBe("keep replacement state");
  expect(await readFile(
    join(movedRoot, ".agent-html-render", "sessions", `${created.session.id}.json`),
    "utf8",
  )).not.toContain("Private note from the original root.");

  const secondOpen = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: { authorization: "Bearer root-swap-test-token", "content-type": "application/json" },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  expect(secondOpen.status).toBe(400);
  expect(server.store.list()).toHaveLength(1);
});

test("makes reviewer submissions idempotent and rejects key reuse with different content", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-server-idempotency-"));
  temporaryDirectories.push(temporaryDirectory);
  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  await mkdir(rootPath);
  await mkdir(uiDirectory);
  await writeFile(join(rootPath, "plan.html"), "<!doctype html><p>Review</p>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");
  const server = await startServer({
    rootPath,
    token: "idempotency-test-token",
    uiDirectory,
    bridgeSource: "",
  });
  runningServers.push(server);
  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: { authorization: "Bearer idempotency-test-token", "content-type": "application/json" },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  const created = (await createResponse.json()) as { session: { id: string; reviewUrl: string } };
  const reviewUrl = new URL(created.session.reviewUrl);
  const access = reviewUrl.searchParams.get("access") ?? "";
  const endpoint = `${server.origin}/api/review/${created.session.id}/send?access=${encodeURIComponent(access)}`;
  const state = server.store.getPublicState(created.session.id);
  if (!state) throw new Error("fixture session is missing");
  const request = {
    draft: { message: "Revise this once.", annotations: [] },
    end: false,
    baseRevision: state.revision,
    baseContentHash: state.contentHash,
    submissionId: "same-operation",
  };
  const send = (body: unknown): Promise<Response> => fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const first = await send(request);
  const retry = await send(request);
  expect(first.status).toBe(200);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(await first.json());
  expect(server.store.get(created.session.id)?.feedbackEvents).toHaveLength(1);

  const conflicting = await send({
    ...request,
    draft: { message: "Different content.", annotations: [] },
  });
  expect(conflicting.status).toBe(409);
  expect(await conflicting.json()).toMatchObject({ code: "submission_conflict" });

  const deliberateSecond = await send({ ...request, submissionId: "new-operation" });
  expect(deliberateSecond.status).toBe(200);
  expect(await deliberateSecond.json()).toMatchObject({ sequence: 2, submissionId: "new-operation" });
  expect(server.store.get(created.session.id)?.feedbackEvents).toHaveLength(2);
});

test("rejects a stale review send after refreshing the artifact from disk", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-html-render-revision-conflict-"));
  temporaryDirectories.push(temporaryDirectory);

  const rootPath = join(temporaryDirectory, "project");
  const uiDirectory = join(temporaryDirectory, "ui");
  await mkdir(rootPath, { recursive: true });
  await mkdir(uiDirectory, { recursive: true });
  await writeFile(join(rootPath, "plan.html"), "<!doctype html><title>Revision one</title>");
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>Review shell</title>");

  const server = await startServer({
    rootPath,
    token: "revision-conflict-token",
    uiDirectory,
    bridgeSource: "",
  });
  runningServers.push(server);
  const createResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: {
      authorization: "Bearer revision-conflict-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ artifactPath: "plan.html" }),
  });
  const created = (await createResponse.json()) as { session: { id: string; reviewUrl: string } };
  const reviewUrl = new URL(created.session.reviewUrl);
  const access = reviewUrl.searchParams.get("access") ?? "";
  const reviewEndpoint = (path: string): string =>
    `${server.origin}/api/review/${created.session.id}${path}?access=${encodeURIComponent(access)}`;
  const firstState = (await (await fetch(reviewEndpoint("/state"))).json()) as {
    revision: number;
    contentHash: string;
  };
  const draft = { message: "Preserve this note.", annotations: [] };
  const draftResponse = await fetch(reviewEndpoint("/draft"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      draft,
      baseRevision: firstState.revision,
      baseContentHash: firstState.contentHash,
      clientId: "server-test",
    }),
  });
  expect(draftResponse.status).toBe(200);

  await writeFile(join(rootPath, "plan.html"), "<!doctype html><title>Revision two</title>");
  const staleSend = await fetch(reviewEndpoint("/send"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      draft,
      end: false,
      baseRevision: firstState.revision,
      baseContentHash: firstState.contentHash,
      submissionId: "stale-send",
    }),
  });
  expect(staleSend.status).toBe(409);
  expect(await staleSend.json()).toMatchObject({
    code: "revision_conflict",
    currentRevision: 2,
  });
  expect(server.store.getPublicState(created.session.id)).toMatchObject({
    revision: 2,
    draft,
    draftBaseRevision: 1,
  });
});
