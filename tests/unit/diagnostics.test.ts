import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { diagnoseProject, runtimeIsSupported } from "../../src/node/diagnostics.js";
import { acquireStartupLock } from "../../src/node/daemon.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("reports a clean project without starting a daemon or exposing credentials", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-"));
  temporaryDirectories.push(rootPath);

  const report = await diagnoseProject(rootPath);

  expect(report.node.supported).toBe(true);
  expect(report.platform).toEqual({ name: process.platform, supported: process.platform === "linux" });
  expect(report.project).toMatchObject({ rootPath, writable: true });
  expect(report.daemon).toMatchObject({ recorded: false, running: false, compatible: false });
  expect(report.state.validBoundary).toBe(true);
  expect(report.skills.canonicalInstalled).toBe(false);
  expect(report.recommendations).toContain(
    "Run agent-html-render install-skill before asking an agent to start reviews.",
  );
  expect(JSON.stringify(report)).not.toContain("token");
});

test("matches the supported Node engine lines", () => {
  expect(runtimeIsSupported("22.22.1")).toBe(false);
  expect(runtimeIsSupported("22.22.2")).toBe(true);
  expect(runtimeIsSupported("23.11.0")).toBe(false);
  expect(runtimeIsSupported("24.14.9")).toBe(false);
  expect(runtimeIsSupported("24.15.0")).toBe(true);
  expect(runtimeIsSupported("25.0.0")).toBe(false);
  expect(runtimeIsSupported("26.0.0")).toBe(true);
});

test.skipIf(process.platform === "win32")("reports a stale startup lock as a read-only readiness blocker", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-stale-lock-"));
  temporaryDirectories.push(rootPath);
  const stateDirectory = join(rootPath, ".agent-html-render");
  const lockPath = join(stateDirectory, "daemon.lock");
  await mkdir(stateDirectory);
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: 2_147_483_647, owner: "interrupted-startup", createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
    { mode: 0o600 },
  );

  const report = await diagnoseProject(rootPath);

  expect(report.ok).toBe(false);
  expect(report.coreReady).toBe(false);
  expect(report.state.validBoundary).toBe(true);
  expect(report.state.startupLock).toEqual({ path: lockPath, status: "stale", pid: 2_147_483_647 });
  expect(report.recommendations).toContain(
    `After verifying that no Agent HTML Render process is starting in this project, remove the stale startup lock at ${lockPath} and retry.`,
  );
});

test.skipIf(process.platform === "win32")("blocks on an old live-PID legacy lock without mistaking PID reuse for readiness", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-live-legacy-lock-"));
  temporaryDirectories.push(rootPath);
  const stateDirectory = join(rootPath, ".agent-html-render");
  const lockPath = join(stateDirectory, "daemon.lock");
  const source = `${JSON.stringify({
    pid: process.pid,
    owner: "possibly-reused-live-pid",
    createdAt: "2000-01-01T00:00:00.000Z",
  })}\n`;
  await mkdir(stateDirectory);
  await writeFile(lockPath, source, { mode: 0o600 });

  const report = await diagnoseProject(rootPath);

  expect(report.ok).toBe(false);
  expect(report.coreReady).toBe(false);
  expect(report.state.validBoundary).toBe(true);
  expect(report.state.startupLock).toEqual({ path: lockPath, status: "active", pid: process.pid });
  expect(report.recommendations).toContain(
    `Wait for the current startup to finish. If it does not, verify that no Agent HTML Render process is starting in this project, then remove the legacy startup lock at ${lockPath} and retry.`,
  );
  expect(await readFile(lockPath, "utf8")).toBe(source);
});

test.skipIf(process.platform === "win32")("reports a held kernel startup coordinator as not ready", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-busy-coordinator-"));
  temporaryDirectories.push(rootPath);
  const release = await acquireStartupLock(rootPath);
  try {
    const report = await diagnoseProject(rootPath);

    expect(report.ok).toBe(false);
    expect(report.coreReady).toBe(false);
    expect(report.state.startupCoordinator).toEqual({ status: "busy" });
    expect(report.state.startupLock.status).toBe("missing");
    expect(report.recommendations).toContain(
      "Wait for the current Agent HTML Render startup to finish. If it remains busy, stop the hung Agent HTML Render command and retry.",
    );
  } finally {
    await release();
  }

  const releasedReport = await diagnoseProject(rootPath);
  expect(releasedReport.coreReady).toBe(true);
  expect(releasedReport.state.startupCoordinator).toEqual({ status: "idle" });
});

test.skipIf(process.platform !== "linux")("refuses to recommend replacement beside an unhealthy recorded live PID", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-unhealthy-live-pid-"));
  temporaryDirectories.push(rootPath);
  const stateDirectory = join(rootPath, ".agent-html-render");
  await mkdir(stateDirectory);
  const rootDetails = await stat(rootPath, { bigint: true });
  await writeFile(join(stateDirectory, "daemon.json"), `${JSON.stringify({
    protocolVersion: "1",
    packageVersion: "0.0.0-stale",
    buildId: "sha256:stale",
    pid: process.pid,
    rootPath,
    rootDevice: rootDetails.dev.toString(),
    rootInode: rootDetails.ino.toString(),
    port: 9,
    token: "unhealthy-live-pid-token",
    startedAt: "2000-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });

  const report = await diagnoseProject(rootPath);

  expect(report.coreReady).toBe(false);
  expect(report.daemon).toMatchObject({
    recorded: true,
    running: false,
    compatible: false,
    processAlive: true,
  });
  expect(report.recommendations).toContain(
    `The recorded daemon process ${process.pid} is still alive but not current and healthy. After verifying that PID belongs to this project, stop it before retrying; Agent HTML Render will not start a replacement beside it.`,
  );
  expect(report.recommendations.some((recommendation) => recommendation.includes("replace stale daemon state"))).toBe(false);
});

test.skipIf(process.platform === "win32")("reports a state symlink as an unsafe project boundary", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-link-root-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-link-outside-"));
  temporaryDirectories.push(rootPath, outside);
  await symlink(outside, join(rootPath, ".agent-html-render"), "dir");

  const report = await diagnoseProject(rootPath);

  expect(report.ok).toBe(false);
  expect(report.state.validBoundary).toBe(false);
  expect(report.daemon.recorded).toBe(false);
  expect(report.recommendations).toContain(
    "Repair private-file permissions or move linked, multiply linked, or non-regular .agent-html-render state entries aside before retrying.",
  );
});

test.skipIf(process.platform === "win32")("reports nested state symlinks that runtime initialization rejects", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-nested-root-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-nested-outside-"));
  temporaryDirectories.push(rootPath, outside);
  const stateDirectory = join(rootPath, ".agent-html-render");
  await mkdir(stateDirectory);
  await symlink(outside, join(stateDirectory, "sessions"), "dir");

  const sessionsReport = await diagnoseProject(rootPath);
  expect(sessionsReport.ok).toBe(false);
  expect(sessionsReport.state.validBoundary).toBe(false);

  await rm(join(stateDirectory, "sessions"));
  await writeFile(join(outside, "ignore-target"), "outside");
  await symlink(join(outside, "ignore-target"), join(stateDirectory, ".gitignore"));
  const ignoreReport = await diagnoseProject(rootPath);
  expect(ignoreReport.ok).toBe(false);
  expect(ignoreReport.state.validBoundary).toBe(false);
});

test.skipIf(process.platform === "win32")("reports multiply linked state files as an invalid boundary", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-hardlink-root-"));
  temporaryDirectories.push(rootPath);
  const stateDirectory = join(rootPath, ".agent-html-render");
  const otherName = join(rootPath, "other-name.txt");
  await mkdir(stateDirectory);
  await writeFile(otherName, "/keep\n");
  await link(otherName, join(stateDirectory, ".gitignore"));

  const report = await diagnoseProject(rootPath);

  expect(report.ok).toBe(false);
  expect(report.state.validBoundary).toBe(false);
});

test.skipIf(process.platform === "win32")("reports linked session snapshots and permissive private files", async () => {
  const linkedRoot = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-session-hardlink-"));
  temporaryDirectories.push(linkedRoot);
  const linkedSessions = join(linkedRoot, ".agent-html-render", "sessions");
  await mkdir(linkedSessions, { recursive: true });
  const sessionPath = join(linkedSessions, "session.json");
  await writeFile(sessionPath, "{}\n", { mode: 0o600 });
  await link(sessionPath, join(linkedRoot, "session-other-name.json"));

  const linkedReport = await diagnoseProject(linkedRoot);
  expect(linkedReport.ok).toBe(false);
  expect(linkedReport.state.validBoundary).toBe(false);

  const modeRoot = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-private-mode-"));
  temporaryDirectories.push(modeRoot);
  const modeState = join(modeRoot, ".agent-html-render");
  const modeSessions = join(modeState, "sessions");
  await mkdir(modeSessions, { recursive: true });
  const permissiveSession = join(modeSessions, "session.json");
  await writeFile(permissiveSession, "{}\n", { mode: 0o644 });
  await chmod(permissiveSession, 0o644);

  const sessionModeReport = await diagnoseProject(modeRoot);
  expect(sessionModeReport.state.validBoundary).toBe(false);

  await chmod(permissiveSession, 0o600);
  const permissiveMetadata = join(modeState, "daemon.json");
  await writeFile(permissiveMetadata, "{}\n", { mode: 0o644 });
  await chmod(permissiveMetadata, 0o644);
  const metadataModeReport = await diagnoseProject(modeRoot);
  expect(metadataModeReport.state.validBoundary).toBe(false);
});

test.skipIf(process.platform === "win32")("reports unsafe randomized daemon metadata temporaries", async () => {
  const linkedRoot = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-random-temp-link-"));
  temporaryDirectories.push(linkedRoot);
  const linkedState = join(linkedRoot, ".agent-html-render");
  const victim = join(linkedRoot, "temporary-victim.json");
  await mkdir(linkedState);
  await writeFile(victim, "keep", { mode: 0o600 });
  await symlink(victim, join(linkedState, `daemon.json.${"a".repeat(24)}.tmp`));

  const linkedReport = await diagnoseProject(linkedRoot);
  expect(linkedReport.state.validBoundary).toBe(false);

  const modeRoot = await mkdtemp(join(tmpdir(), "agent-html-render-doctor-random-temp-mode-"));
  temporaryDirectories.push(modeRoot);
  const modeState = join(modeRoot, ".agent-html-render");
  await mkdir(modeState);
  const temporary = join(modeState, `daemon.json.${"b".repeat(24)}.tmp`);
  await writeFile(temporary, "{}\n", { mode: 0o644 });
  await chmod(temporary, 0o644);

  const modeReport = await diagnoseProject(modeRoot);
  expect(modeReport.state.validBoundary).toBe(false);
});
