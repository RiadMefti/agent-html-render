import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireStartupLock,
  inspectStartupCoordinator,
  STARTUP_COORDINATOR_NONCE_ENV,
} from "../../src/node/daemon.js";

interface DemoDelivery {
  sequence: number;
  feedback: { status: "feedback" | "ended"; reviewerMessage: string };
}

interface DemoRun {
  child: ChildProcess;
  ready: Promise<string>;
  completion: Promise<DemoDelivery>;
}

function redact(value: string): string {
  return value.replace(/access=[^\s]+/gu, "access=[redacted]");
}

function launchDemo(rootPath: string): DemoRun {
  const child = spawn(
    process.execPath,
    [resolve("dist/node/cli.js"), "demo", "--root", rootPath, "--no-open", "--format", "json"],
    { cwd: rootPath, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let readySettled = false;
  let resolveReady = (_url: string): void => undefined;
  let rejectReady = (_error: Error): void => undefined;
  const ready = new Promise<string>((resolvePromise, reject) => {
    resolveReady = resolvePromise;
    rejectReady = reject;
  });
  const readyTimeout = setTimeout(() => {
    rejectReady(new Error(`Demo did not print a review URL: ${redact(stderr)}`));
  }, 20_000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/session\/[^\s]+/u);
    if (match?.[0] && !readySettled) {
      readySettled = true;
      clearTimeout(readyTimeout);
      resolveReady(match[0]);
    }
  });
  const completion = new Promise<DemoDelivery>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Demo did not finish. stdout=${stdout} stderr=${redact(stderr)}`));
    }, 25_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(readyTimeout);
      rejectReady(error);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(readyTimeout);
      if (code !== 0) {
        const error = new Error(`Demo exited ${code}: ${redact(stderr)}`);
        rejectReady(error);
        reject(error);
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as DemoDelivery);
      } catch (error) {
        reject(new Error(`Demo returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
  return { child, ready, completion };
}

test("keeps untrusted command text inside one prefixed error record", () => {
  const forgedCommand = "unknown\n[agent-html-render] forged";
  const result = spawnSync(process.execPath, [resolve("dist/node/cli.js"), forgedCommand], {
    encoding: "utf8",
    timeout: 10_000,
  });

  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(
    "[agent-html-render] Unknown command: unknown\\u{000a}[agent-html-render] forged\n",
  );
  expect(result.stderr.split("\n").filter((line) => line.startsWith("[agent-html-render]"))).toHaveLength(1);
  expect(result.stderr).toContain("Usage:\n");
});

test("explains a closed stdout pipe with actionable context", async () => {
  const child = spawn(process.execPath, [resolve("dist/node/cli.js"), "--help"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.destroy();

  const [code] = await once(child, "close") as [number | null];
  expect(code, stderr).toBe(1);
  expect(stderr).toContain("Could not write the complete response to stdout");
  expect(stderr).toContain("downstream reader may have closed the pipe");
  expect(stderr).not.toContain("Emitted 'error' event");
  expect(stderr).not.toContain("node:events");
});

test("keeps filesystem fields inside doctor and install records while JSON stays exact", async () => {
  test.skip(process.platform === "win32", "Windows filenames cannot contain LF.");
  const parent = await mkdtemp(join(tmpdir(), "agent-html-render-terminal-fields-e2e-"));
  const rootPath = join(parent, "project\tpart\n[agent-html-render] FORGED\u2028next\u2029");
  await mkdir(rootPath);
  try {
    const doctorText = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "doctor", "--root", rootPath],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );
    const visibleStatePath = join(rootPath, ".agent-html-render").replace(
      /[\t\n\u2028\u2029]/gu,
      (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}}`,
    );
    expect(doctorText.stdout).toContain(`Private state: ${visibleStatePath}`);
    expect(doctorText.stdout).not.toContain("\n[agent-html-render] FORGED");

    const doctorJson = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "doctor", "--root", rootPath, "--format", "json"],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );
    const report = JSON.parse(doctorJson.stdout) as { state: { directory: string; logPath: string } };
    expect(report.state.directory).toBe(join(rootPath, ".agent-html-render"));
    expect(report.state.logPath).toBe(join(rootPath, ".agent-html-render", "daemon.log"));
    expect(doctorJson.stdout).toContain("\\u2028");
    expect(doctorJson.stdout).not.toContain("\\u{2028}");

    const install = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "install-skill", "--root", rootPath],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain("\\u{0009}");
    expect(install.stdout).toContain("\\u{000a}[agent-html-render] FORGED\\u{2028}next\\u{2029}");
    expect(install.stdout).not.toContain("\n[agent-html-render] FORGED");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("doctor fails read-only with guidance for a stale startup lock", async () => {
  test.skip(process.platform === "win32", "Secure startup locking is POSIX-only in this beta.");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-stale-e2e-"));
  try {
    const stateDirectory = join(rootPath, ".agent-html-render");
    const lockPath = join(stateDirectory, "daemon.lock");
    await mkdir(stateDirectory);
    const lock = `${JSON.stringify({
      pid: 2_147_483_647,
      owner: "interrupted-startup",
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`;
    await writeFile(lockPath, lock, { mode: 0o600 });

    const doctor = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "doctor", "--root", rootPath, "--format", "json"],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );

    expect(doctor.status, doctor.stderr).toBe(1);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      ok: false,
      coreReady: false,
      state: { startupLock: { path: lockPath, status: "stale", pid: 2_147_483_647 } },
    });
    expect(doctor.stdout).toContain("remove the stale startup lock");
    expect(await readFile(lockPath, "utf8")).toBe(lock);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("doctor reports a live kernel startup coordinator as busy", async () => {
  test.skip(process.platform !== "linux", "The production coordinator gate uses Linux abstract sockets.");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-coordinator-e2e-"));
  const holder = spawn(
    process.execPath,
    ["--import", "tsx", resolve("tests/fixtures/startup-lock-holder.ts"), rootPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    if (!holder.stdout) throw new Error("The coordinator holder did not expose stdout.");
    await once(holder.stdout, "data");
    const doctor = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "doctor", "--root", rootPath, "--format", "json"],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );

    expect(doctor.status, doctor.stderr).toBe(1);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      ok: false,
      coreReady: false,
      state: {
        startupCoordinator: { status: "busy" },
        startupLock: { status: "missing" },
      },
    });
    expect(doctor.stdout).toContain("Wait for the current Agent HTML Render startup to finish");
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, "exit");
      holder.kill("SIGKILL");
      await exited;
    }
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("a failed daemon with a hanging watcher exits before releasing lifetime ownership", async () => {
  test.skip(process.platform !== "linux", "The production coordinator gate uses Linux abstract sockets.");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-watcher-orphan-e2e-"));
  const artifactPath = join(rootPath, "plan.html");
  let release: Awaited<ReturnType<typeof acquireStartupLock>> | undefined;
  let parentHandleReleased = false;
  let child: ChildProcess | undefined;
  try {
    await writeFile(artifactPath, "<!doctype html><title>Original watcher state</title>");
    const productionServer = await import(
      pathToFileURL(resolve("dist/node/server.js")).href
    ) as Pick<typeof import("../../src/node/server.js"), "startServer">;
    const seeder = await productionServer.startServer({
      rootPath,
      token: "watcher-orphan-seed-token",
    });
    const createResponse = await fetch(`${seeder.origin}/api/agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer watcher-orphan-seed-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ artifactPath: "plan.html" }),
    });
    expect(createResponse.status).toBe(200);
    const sessionId = seeder.store.list()[0]?.id;
    if (!sessionId) throw new Error("The watcher-orphan fixture did not create a session.");
    await seeder.close();
    await writeFile(artifactPath, "<!doctype html><title>Changed after seed</title>");

    const [rootDetails, stateDetails] = await Promise.all([
      stat(rootPath, { bigint: true }),
      stat(join(rootPath, ".agent-html-render"), { bigint: true }),
    ]);
    release = await acquireStartupLock(rootPath);
    const nonce = randomBytes(32).toString("base64url");
    child = spawn(
      process.execPath,
      [
        "--import",
        resolve("tests/fixtures/hanging-watcher-preload.mjs"),
        resolve("dist/node/cli.js"),
        "__daemon",
        "--root",
        rootPath,
      ],
      {
        cwd: rootPath,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          AGENT_HTML_RENDER_DAEMON: "1",
          AGENT_HTML_RENDER_ROOT_DEVICE: rootDetails.dev.toString(),
          AGENT_HTML_RENDER_ROOT_INODE: rootDetails.ino.toString(),
          AGENT_HTML_RENDER_STATE_DEVICE: stateDetails.dev.toString(),
          AGENT_HTML_RENDER_STATE_INODE: stateDetails.ino.toString(),
          AGENT_HTML_RENDER_TEST_WATCH_ARTIFACT: artifactPath,
          [STARTUP_COORDINATOR_NONCE_ENV]: nonce,
        },
      },
    );
    await release.transferTo(child, nonce);
    await release();
    parentHandleReleased = true;
    expect(await inspectStartupCoordinator(rootPath)).toEqual({ status: "busy" });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise, reject) => {
        if (child && (child.exitCode !== null || child.signalCode !== null)) {
          resolvePromise({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        const timeout = setTimeout(() => {
          reject(new Error("The failed daemon remained alive after watcher cleanup timed out."));
        }, 5_000);
        child?.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolvePromise({ code, signal });
        });
      },
    );
    expect(exit).toEqual({ code: 1, signal: null });
    expect(await inspectStartupCoordinator(rootPath)).toEqual({ status: "idle" });
    const persisted = JSON.parse(
      await readFile(join(rootPath, ".agent-html-render", "sessions", `${sessionId}.json`), "utf8"),
    ) as { revision: number };
    expect(persisted.revision).toBe(1);

    const successor = await acquireStartupLock(rootPath);
    await successor();
  } finally {
    if (release && !parentHandleReleased) await release().catch(() => undefined);
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("a delayed watcher write cannot outlive clean ownership or overlap a successor", async () => {
  test.skip(process.platform !== "linux", "The production coordinator gate uses Linux abstract sockets.");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-watcher-write-e2e-"));
  const artifactPath = join(rootPath, "plan.html");
  const bumpMarker = join(rootPath, "watcher-bump-started");
  let release: Awaited<ReturnType<typeof acquireStartupLock>> | undefined;
  let parentHandleReleased = false;
  let child: ChildProcess | undefined;
  let successor: DemoRun | undefined;
  try {
    await writeFile(artifactPath, "<!doctype html><title>Original watcher revision</title>");
    const productionServer = await import(
      pathToFileURL(resolve("dist/node/server.js")).href
    ) as Pick<typeof import("../../src/node/server.js"), "startServer">;
    const seeder = await productionServer.startServer({
      rootPath,
      token: "watcher-write-seed-token",
    });
    const createResponse = await fetch(`${seeder.origin}/api/agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer watcher-write-seed-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ artifactPath: "plan.html" }),
    });
    expect(createResponse.status).toBe(200);
    const sessionId = seeder.store.list()[0]?.id;
    if (!sessionId) throw new Error("The delayed watcher-write fixture did not create a session.");
    await seeder.close();

    const [rootDetails, stateDetails] = await Promise.all([
      stat(rootPath, { bigint: true }),
      stat(join(rootPath, ".agent-html-render"), { bigint: true }),
    ]);
    release = await acquireStartupLock(rootPath);
    const nonce = randomBytes(32).toString("base64url");
    child = spawn(
      process.execPath,
      [
        "--import",
        resolve("tests/fixtures/delayed-watcher-bump-preload.mjs"),
        resolve("dist/node/cli.js"),
        "__daemon",
        "--root",
        rootPath,
      ],
      {
        cwd: rootPath,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          AGENT_HTML_RENDER_DAEMON: "1",
          AGENT_HTML_RENDER_ROOT_DEVICE: rootDetails.dev.toString(),
          AGENT_HTML_RENDER_ROOT_INODE: rootDetails.ino.toString(),
          AGENT_HTML_RENDER_STATE_DEVICE: stateDetails.dev.toString(),
          AGENT_HTML_RENDER_STATE_INODE: stateDetails.ino.toString(),
          AGENT_HTML_RENDER_TEST_BUMP_MARKER: bumpMarker,
          [STARTUP_COORDINATOR_NONCE_ENV]: nonce,
        },
      },
    );
    await release.transferTo(child, nonce);
    await release();
    parentHandleReleased = true;
    await expect.poll(async () => {
      try {
        return (JSON.parse(
          await readFile(join(rootPath, ".agent-html-render", "daemon.json"), "utf8"),
        ) as { pid: number }).pid;
      } catch {
        return 0;
      }
    }, { timeout: 5_000 }).toBe(child.pid);
    expect(await inspectStartupCoordinator(rootPath)).toEqual({ status: "busy" });

    await writeFile(artifactPath, "<!doctype html><title>Delayed watcher revision</title>");
    await expect.poll(async () => {
      try {
        await access(bumpMarker);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 5_000 }).toBe(true);
    expect(await inspectStartupCoordinator(rootPath)).toEqual({ status: "busy" });

    const stopCommand = spawn(
      process.execPath,
      [resolve("dist/node/cli.js"), "stop", "--root", rootPath],
      { cwd: rootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stopStderr = "";
    stopCommand.stderr.setEncoding("utf8");
    stopCommand.stderr.on("data", (chunk: string) => {
      stopStderr += chunk;
    });
    const [stopCode] = await once(stopCommand, "close") as [number | null];
    expect(stopCode, stopStderr).toBe(0);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise, reject) => {
        if (child && (child.exitCode !== null || child.signalCode !== null)) {
          resolvePromise({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        const timeout = setTimeout(() => reject(new Error("The delayed watcher daemon did not exit.")), 5_000);
        child?.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolvePromise({ code, signal });
        });
      },
    );
    expect(exit).toEqual({ code: 1, signal: null });
    expect(await inspectStartupCoordinator(rootPath)).toEqual({ status: "idle" });
    const persisted = JSON.parse(
      await readFile(join(rootPath, ".agent-html-render", "sessions", `${sessionId}.json`), "utf8"),
    ) as { revision: number };
    expect(persisted.revision).toBe(1);

    successor = launchDemo(rootPath);
    void successor.completion.catch(() => undefined);
    await successor.ready;
    const successorMetadata = JSON.parse(
      await readFile(join(rootPath, ".agent-html-render", "daemon.json"), "utf8"),
    ) as { pid: number };
    expect(successorMetadata.pid).not.toBe(child.pid);
    expect(child.exitCode).toBe(1);
    const successorStop = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "stop", "--root", rootPath],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );
    expect(successorStop.status, successorStop.stderr).toBe(0);
  } finally {
    if (release && !parentHandleReleased) await release().catch(() => undefined);
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    if (successor?.child.exitCode === null) successor.child.kill("SIGTERM");
    spawnSync(process.execPath, [resolve("dist/node/cli.js"), "stop", "--root", rootPath], {
      cwd: rootPath,
      encoding: "utf8",
      timeout: 10_000,
    });
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("in-flight daemon log maintenance cannot outlive lifetime ownership", async () => {
  test.skip(process.platform !== "linux", "The production coordinator gate uses Linux abstract sockets.");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-log-maintenance-e2e-"));
  const logPath = join(rootPath, ".agent-html-render", "daemon.log");
  const maintenanceMarker = join(rootPath, "log-maintenance-started");
  let release: Awaited<ReturnType<typeof acquireStartupLock>> | undefined;
  let parentHandleReleased = false;
  let child: ChildProcess | undefined;
  let successor: DemoRun | undefined;
  try {
    await mkdir(join(rootPath, ".agent-html-render"));
    await writeFile(logPath, "initial daemon log\n", { mode: 0o600 });
    const [rootDetails, stateDetails] = await Promise.all([
      stat(rootPath, { bigint: true }),
      stat(join(rootPath, ".agent-html-render"), { bigint: true }),
    ]);
    release = await acquireStartupLock(rootPath);
    const nonce = randomBytes(32).toString("base64url");
    child = spawn(
      process.execPath,
      [
        "--import",
        resolve("tests/fixtures/delayed-log-maintenance-preload.mjs"),
        resolve("dist/node/cli.js"),
        "__daemon",
        "--root",
        rootPath,
      ],
      {
        cwd: rootPath,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          AGENT_HTML_RENDER_DAEMON: "1",
          AGENT_HTML_RENDER_ROOT_DEVICE: rootDetails.dev.toString(),
          AGENT_HTML_RENDER_ROOT_INODE: rootDetails.ino.toString(),
          AGENT_HTML_RENDER_STATE_DEVICE: stateDetails.dev.toString(),
          AGENT_HTML_RENDER_STATE_INODE: stateDetails.ino.toString(),
          AGENT_HTML_RENDER_TEST_LOG_PATH: logPath,
          AGENT_HTML_RENDER_TEST_LOG_MARKER: maintenanceMarker,
          [STARTUP_COORDINATOR_NONCE_ENV]: nonce,
        },
      },
    );
    await release.transferTo(child, nonce);
    await release();
    parentHandleReleased = true;
    await expect.poll(async () => {
      try {
        return (JSON.parse(
          await readFile(join(rootPath, ".agent-html-render", "daemon.json"), "utf8"),
        ) as { pid: number }).pid;
      } catch {
        return 0;
      }
    }, { timeout: 5_000 }).toBe(child.pid);
    await expect.poll(async () => {
      try {
        await access(maintenanceMarker);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 5_000 }).toBe(true);

    const stopCommand = spawn(
      process.execPath,
      [resolve("dist/node/cli.js"), "stop", "--root", rootPath],
      { cwd: rootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stopStderr = "";
    stopCommand.stderr.setEncoding("utf8");
    stopCommand.stderr.on("data", (chunk: string) => {
      stopStderr += chunk;
    });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(child.exitCode).toBeNull();
    expect(await inspectStartupCoordinator(rootPath)).toEqual({ status: "busy" });

    const [stopCode] = await once(stopCommand, "close") as [number | null];
    expect(stopCode, stopStderr).toBe(0);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise, reject) => {
        if (child && (child.exitCode !== null || child.signalCode !== null)) {
          resolvePromise({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        const timeout = setTimeout(() => reject(new Error("The delayed log daemon did not exit.")), 5_000);
        child?.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolvePromise({ code, signal });
        });
      },
    );
    expect(exit).toEqual({ code: 1, signal: null });
    expect(await inspectStartupCoordinator(rootPath)).toEqual({ status: "idle" });

    successor = launchDemo(rootPath);
    void successor.completion.catch(() => undefined);
    await successor.ready;
    const successorMetadata = JSON.parse(
      await readFile(join(rootPath, ".agent-html-render", "daemon.json"), "utf8"),
    ) as { pid: number };
    expect(successorMetadata.pid).not.toBe(child.pid);
    expect(child.exitCode).toBe(1);
    const successorStop = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "stop", "--root", rootPath],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );
    expect(successorStop.status, successorStop.stderr).toBe(0);
  } finally {
    if (release && !parentHandleReleased) await release().catch(() => undefined);
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    if (successor?.child.exitCode === null) successor.child.kill("SIGTERM");
    spawnSync(process.execPath, [resolve("dist/node/cli.js"), "stop", "--root", rootPath], {
      cwd: rootPath,
      encoding: "utf8",
      timeout: 10_000,
    });
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("stop covers composed watcher and log-maintenance cleanup bounds", async () => {
  test.skip(process.platform !== "linux", "The production coordinator gate uses Linux abstract sockets.");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-composed-shutdown-e2e-"));
  const artifactPath = join(rootPath, "plan.html");
  const logPath = join(rootPath, ".agent-html-render", "daemon.log");
  const maintenanceMarker = join(rootPath, "log-maintenance-started");
  const bumpMarker = join(rootPath, "watcher-bump-started");
  let release: Awaited<ReturnType<typeof acquireStartupLock>> | undefined;
  let parentHandleReleased = false;
  let child: ChildProcess | undefined;
  try {
    await writeFile(artifactPath, "<!doctype html><title>Original composed shutdown</title>");
    const productionServer = await import(
      pathToFileURL(resolve("dist/node/server.js")).href
    ) as Pick<typeof import("../../src/node/server.js"), "startServer">;
    const seeder = await productionServer.startServer({
      rootPath,
      token: "composed-shutdown-seed-token",
    });
    const createResponse = await fetch(`${seeder.origin}/api/agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer composed-shutdown-seed-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ artifactPath: "plan.html" }),
    });
    expect(createResponse.status).toBe(200);
    const sessionId = seeder.store.list()[0]?.id;
    if (!sessionId) throw new Error("The composed-shutdown fixture did not create a session.");
    await seeder.close();
    await writeFile(logPath, "initial daemon log\n", { mode: 0o600 });

    const [rootDetails, stateDetails] = await Promise.all([
      stat(rootPath, { bigint: true }),
      stat(join(rootPath, ".agent-html-render"), { bigint: true }),
    ]);
    release = await acquireStartupLock(rootPath);
    const nonce = randomBytes(32).toString("base64url");
    child = spawn(
      process.execPath,
      [
        "--import",
        resolve("tests/fixtures/delayed-log-maintenance-preload.mjs"),
        resolve("dist/node/cli.js"),
        "__daemon",
        "--root",
        rootPath,
      ],
      {
        cwd: rootPath,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          AGENT_HTML_RENDER_DAEMON: "1",
          AGENT_HTML_RENDER_ROOT_DEVICE: rootDetails.dev.toString(),
          AGENT_HTML_RENDER_ROOT_INODE: rootDetails.ino.toString(),
          AGENT_HTML_RENDER_STATE_DEVICE: stateDetails.dev.toString(),
          AGENT_HTML_RENDER_STATE_INODE: stateDetails.ino.toString(),
          AGENT_HTML_RENDER_TEST_LOG_PATH: logPath,
          AGENT_HTML_RENDER_TEST_LOG_MARKER: maintenanceMarker,
          AGENT_HTML_RENDER_TEST_LOG_WAIT_FOR: bumpMarker,
          AGENT_HTML_RENDER_TEST_LOG_DELAY_MS: "1200",
          AGENT_HTML_RENDER_TEST_BUMP_MARKER: bumpMarker,
          AGENT_HTML_RENDER_TEST_BUMP_DELAY_MS: "500",
          [STARTUP_COORDINATOR_NONCE_ENV]: nonce,
        },
      },
    );
    await release.transferTo(child, nonce);
    await release();
    parentHandleReleased = true;
    await expect.poll(async () => {
      try {
        return (JSON.parse(
          await readFile(join(rootPath, ".agent-html-render", "daemon.json"), "utf8"),
        ) as { pid: number }).pid;
      } catch {
        return 0;
      }
    }, { timeout: 5_000 }).toBe(child.pid);
    await expect.poll(async () => {
      try {
        await access(maintenanceMarker);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 5_000 }).toBe(true);

    await writeFile(artifactPath, "<!doctype html><title>Updated composed shutdown</title>");
    await expect.poll(async () => {
      try {
        await access(bumpMarker);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 5_000 }).toBe(true);

    const stopStartedAt = Date.now();
    const stopCommand = spawn(
      process.execPath,
      [resolve("dist/node/cli.js"), "stop", "--root", rootPath],
      { cwd: rootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stopStderr = "";
    stopCommand.stderr.setEncoding("utf8");
    stopCommand.stderr.on("data", (chunk: string) => {
      stopStderr += chunk;
    });
    const [stopCode] = await once(stopCommand, "close") as [number | null];
    const stopMilliseconds = Date.now() - stopStartedAt;
    expect(stopCode, stopStderr).toBe(0);
    expect(stopMilliseconds).toBeGreaterThan(1_000);
    expect(stopMilliseconds).toBeLessThan(2_500);
    expect(child.exitCode).toBe(0);
    expect(await inspectStartupCoordinator(rootPath)).toEqual({ status: "idle" });
    const persisted = JSON.parse(
      await readFile(join(rootPath, ".agent-html-render", "sessions", `${sessionId}.json`), "utf8"),
    ) as { revision: number };
    expect(persisted.revision).toBe(2);
  } finally {
    if (release && !parentHandleReleased) await release().catch(() => undefined);
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("fails promptly without spawning a replacement when a stale daemon will not stop", async () => {
  test.skip(process.platform === "win32", "The production daemon gate is POSIX-only in this beta.");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-stale-daemon-stop-e2e-"));
  const stateDirectory = join(rootPath, ".agent-html-render");
  await mkdir(stateDirectory);
  const rootDetails = await stat(rootPath, { bigint: true });
  const stalePid = process.pid;
  let stopAcknowledged = false;
  const staleServer = createHttpServer((request, response) => {
    if (request.url === "/api/agent/stop") {
      stopAcknowledged = true;
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.url === "/api/health" && !stopAcknowledged) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        rootPath,
        pid: stalePid,
        rootIdentityCurrent: true,
        rootDevice: rootDetails.dev.toString(),
        rootInode: rootDetails.ino.toString(),
        protocolVersion: "1",
        capabilities: [],
        packageVersion: "0.0.0-stale",
        buildId: "sha256:stale",
      }));
    }
    // After acknowledging stop, deliberately keep the process/listener alive and health unanswered.
  });
  await new Promise<void>((resolvePromise, reject) => {
    staleServer.once("error", reject);
    staleServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = staleServer.address();
  if (!address || typeof address === "string") throw new Error("The stale-daemon fixture did not bind a port.");
  await writeFile(join(stateDirectory, "daemon.json"), `${JSON.stringify({
    protocolVersion: "1",
    packageVersion: "0.0.0-stale",
    buildId: "sha256:stale",
    pid: stalePid,
    rootPath,
    rootDevice: rootDetails.dev.toString(),
    rootInode: rootDetails.ino.toString(),
    port: address.port,
    token: "stale-test-token",
    startedAt: "2000-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });

  const child = spawn(
    process.execPath,
    [resolve("dist/node/cli.js"), "demo", "--root", rootPath, "--no-open", "--format", "json"],
    { cwd: rootPath, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    const startedAt = Date.now();
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`The stale-daemon replacement command hung: ${stderr}`));
      }, 8_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolvePromise({ code, signal });
      });
    });
    expect(exit).toEqual({ code: 1, signal: null });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(stopAcknowledged).toBe(true);
    expect(stderr).toContain("did not stop within 3 seconds, so no replacement was started");
    expect(await readFile(join(stateDirectory, "daemon.json"), "utf8")).toContain("0.0.0-stale");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    staleServer.closeAllConnections();
    await new Promise<void>((resolvePromise) => staleServer.close(() => resolvePromise()));
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("stop honors the absolute window after a prompt acknowledgement", async () => {
  test.skip(process.platform !== "linux", "The production coordinator gate uses Linux process ownership checks.");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-delayed-stop-e2e-"));
  const fixture = spawn(
    process.execPath,
    [resolve("tests/fixtures/uncoordinated-daemon.mjs"), rootPath],
    {
      cwd: resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_HTML_RENDER_TEST_EXIT_DELAY_MS: "2500" },
    },
  );
  try {
    if (!fixture.stdout) throw new Error("The delayed-stop fixture did not expose stdout.");
    await once(fixture.stdout, "data");
    const startedAt = Date.now();
    const stopCommand = spawn(
      process.execPath,
      [resolve("dist/node/cli.js"), "stop", "--root", rootPath],
      { cwd: rootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stopStderr = "";
    stopCommand.stderr.setEncoding("utf8");
    stopCommand.stderr.on("data", (chunk: string) => {
      stopStderr += chunk;
    });
    const [stopCode] = await once(stopCommand, "close") as [number | null];
    const stopMilliseconds = Date.now() - startedAt;
    expect(stopCode, stopStderr).toBe(0);
    expect(stopMilliseconds).toBeGreaterThanOrEqual(2_400);
    expect(stopMilliseconds).toBeLessThan(3_500);
    expect(fixture.exitCode).toBe(0);
  } finally {
    if (fixture.exitCode === null && fixture.signalCode === null) {
      const exited = once(fixture, "exit");
      fixture.kill("SIGKILL");
      await exited;
    }
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("replaces a same-build daemon that does not own the lifetime coordinator", async () => {
  test.skip(process.platform !== "linux", "The production coordinator gate uses Linux abstract sockets.");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-uncoordinated-e2e-"));
  const fixture = spawn(
    process.execPath,
    [resolve("tests/fixtures/uncoordinated-daemon.mjs"), rootPath],
    {
      cwd: resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_HTML_RENDER_TEST_EXIT_DELAY_MS: "2930" },
    },
  );
  let demo: DemoRun | undefined;
  try {
    if (!fixture.stdout) throw new Error("The uncoordinated daemon fixture did not expose stdout.");
    const [readyChunk] = await once(fixture.stdout, "data") as [Buffer];
    const oldDaemon = JSON.parse(readyChunk.toString("utf8")) as { pid: number; port: number };
    const before = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "doctor", "--root", rootPath, "--format", "json"],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );
    expect(before.status, before.stderr).toBe(1);
    expect(JSON.parse(before.stdout)).toMatchObject({
      coreReady: false,
      daemon: { running: true, compatible: false, pid: oldDaemon.pid, port: oldDaemon.port },
      state: { startupCoordinator: { status: "idle" } },
    });

    const replacementStartedAt = Date.now();
    demo = launchDemo(rootPath);
    void demo.completion.catch(() => undefined);
    await demo.ready;
    expect(Date.now() - replacementStartedAt).toBeGreaterThanOrEqual(2_850);
    const replacementMetadata = JSON.parse(
      await readFile(join(rootPath, ".agent-html-render", "daemon.json"), "utf8"),
    ) as { pid: number; port: number; startupCoordinatorId?: string };
    expect(replacementMetadata.pid).not.toBe(oldDaemon.pid);
    expect(replacementMetadata.port).not.toBe(oldDaemon.port);
    expect(replacementMetadata.startupCoordinatorId).toMatch(/^[A-Za-z0-9_-]{32,128}$/u);
    const after = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "doctor", "--root", rootPath, "--format", "json"],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );
    expect(after.status, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({
      coreReady: true,
      daemon: { running: true, compatible: true },
      state: { startupCoordinator: { status: "busy" } },
    });
  } finally {
    if (demo?.child.exitCode === null) demo.child.kill("SIGTERM");
    spawnSync(process.execPath, [resolve("dist/node/cli.js"), "stop", "--root", rootPath], {
      cwd: rootPath,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (fixture.exitCode === null && fixture.signalCode === null) {
      const exited = once(fixture, "exit");
      fixture.kill("SIGKILL");
      await exited;
    }
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("reports live private-state replacement and recovers after a verified restart", async () => {
  test.skip(process.platform !== "linux", "The production coordinator gate uses Linux abstract sockets.");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-live-state-e2e-"));
  const runs: DemoRun[] = [];
  const stopDaemon = () => spawnSync(
    process.execPath,
    [resolve("dist/node/cli.js"), "stop", "--root", rootPath],
    { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
  );
  try {
    const first = launchDemo(rootPath);
    runs.push(first);
    void first.completion.catch(() => undefined);
    await first.ready;
    const stateDirectory = join(rootPath, ".agent-html-render");
    const movedStateDirectory = join(rootPath, ".agent-html-render-before-replacement");
    await rename(stateDirectory, movedStateDirectory);
    await cp(movedStateDirectory, stateDirectory, { recursive: true, preserveTimestamps: true });

    const staleDoctor = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "doctor", "--root", rootPath, "--format", "json"],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );
    expect(staleDoctor.status, staleDoctor.stderr).toBe(1);
    expect(JSON.parse(staleDoctor.stdout)).toMatchObject({
      coreReady: false,
      daemon: { running: true, compatible: false },
      state: { startupCoordinator: { status: "busy" } },
    });
    expect(staleDoctor.stdout).toContain("no longer matches its pinned private state");
    const stopped = stopDaemon();
    expect(stopped.status, stopped.stderr).toBe(0);

    const recovered = launchDemo(rootPath);
    runs.push(recovered);
    void recovered.completion.catch(() => undefined);
    await recovered.ready;
    const recoveredDoctor = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "doctor", "--root", rootPath, "--format", "json"],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );
    expect(recoveredDoctor.status, recoveredDoctor.stderr).toBe(0);
    expect(JSON.parse(recoveredDoctor.stdout)).toMatchObject({
      coreReady: true,
      daemon: { running: true, compatible: true },
      state: { startupCoordinator: { status: "busy" } },
    });
    expect(stopDaemon().status).toBe(0);
  } finally {
    for (const run of runs) {
      void run.completion.catch(() => undefined);
      if (run.child.exitCode === null) run.child.kill("SIGTERM");
    }
    stopDaemon();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("runs a repeatable zero-setup demo under concurrent CLI starts", async ({ page }) => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-demo-e2e-"));
  const activeRuns: DemoRun[] = [];
  let daemonStopped = false;
  const stopDaemon = () =>
    spawnSync(process.execPath, [resolve("dist/node/cli.js"), "stop", "--root", rootPath], {
      cwd: rootPath,
      encoding: "utf8",
      timeout: 10_000,
    });
  try {
    const git = spawnSync("git", ["init", "--quiet", rootPath], { encoding: "utf8" });
    expect(git.status, git.stderr).toBe(0);

    const first = launchDemo(rootPath);
    const second = launchDemo(rootPath);
    activeRuns.push(first, second);
    const [firstUrl, secondUrl] = await Promise.all([first.ready, second.ready]);
    expect(new URL(secondUrl).pathname).toBe(new URL(firstUrl).pathname);
    const runningDoctor = spawnSync(
      process.execPath,
      [resolve("dist/node/cli.js"), "doctor", "--root", rootPath, "--format", "json"],
      { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
    );
    expect(runningDoctor.status, runningDoctor.stderr).toBe(0);
    expect(JSON.parse(runningDoctor.stdout)).toMatchObject({
      coreReady: true,
      daemon: { running: true, compatible: true, processAlive: true },
      state: { startupCoordinator: { status: "busy" } },
    });

    await page.goto(firstUrl);
    const artifact = page.frameLocator('[data-testid="artifact-frame"]');
    await expect(artifact.getByRole("heading", { name: "Authentication rollout" })).toBeVisible();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByTestId("reviewer-message").fill("The demo is clear.");
    await page.getByTestId("send-end").click();

    const winner = await Promise.race([
      first.completion.then((delivery) => ({ run: first, delivery })),
      second.completion.then((delivery) => ({ run: second, delivery })),
    ]);
    expect(winner.delivery.feedback).toMatchObject({ status: "ended", reviewerMessage: "The demo is clear." });
    const waitingRun = winner.run === first ? second : first;
    const duplicate = await Promise.race([
      waitingRun.completion.then(() => true),
      new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 750)),
    ]);
    expect(duplicate).toBe(false);
    void waitingRun.completion.catch(() => undefined);
    waitingRun.child.kill("SIGTERM");
    expect(await readFile(join(rootPath, ".agent-html-render", "demo-plan.html"), "utf8")).toContain(
      "Authentication rollout",
    );
    const ignored = spawnSync(
      "git",
      ["-C", rootPath, "check-ignore", ".agent-html-render/demo-plan.html"],
      { encoding: "utf8" },
    );
    expect(ignored.status, ignored.stderr).toBe(0);
    await expect(access(join(rootPath, ".agent-html-render", "daemon.lock"))).rejects.toThrow();
    if (process.platform !== "win32") {
      const daemonLog = await stat(join(rootPath, ".agent-html-render", "daemon.log"));
      expect(daemonLog.mode & 0o777).toBe(0o600);
    }

    const repeated = launchDemo(rootPath);
    activeRuns.push(repeated);
    const repeatedUrl = await repeated.ready;
    expect(new URL(repeatedUrl).pathname).not.toBe(new URL(firstUrl).pathname);
    await page.goto(repeatedUrl);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByTestId("reviewer-message").fill("The repeated demo is ready.");
    await page.getByTestId("send-end").click();
    await expect(repeated.completion).resolves.toMatchObject({
      feedback: { status: "ended", reviewerMessage: "The repeated demo is ready." },
    });
    const stopped = stopDaemon();
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("daemon stopped");
    daemonStopped = true;
  } finally {
    for (const run of activeRuns) {
      void run.completion.catch(() => undefined);
      if (run.child.exitCode === null) run.child.kill("SIGTERM");
    }
    if (!daemonStopped) stopDaemon();
    await rm(rootPath, { recursive: true, force: true });
  }
});
