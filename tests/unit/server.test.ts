import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRuntimeBuildIdentity } from "../../src/node/build.js";
import { inspectDaemonHealth, type DaemonMetadata } from "../../src/node/daemon.js";
import { startServer, type RunningServer } from "../../src/node/server.js";
import { EXPLICIT_FEEDBACK_ACK_CAPABILITY, FEEDBACK_ACK_HEADER } from "../../src/shared/protocol.js";

const temporaryDirectories: string[] = [];
const runningServers: RunningServer[] = [];

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
});

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

  const firstSend = await fetch(reviewEndpoint("/send"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft: { message: "Revise this.", annotations: [] }, end: false }),
  });
  expect(firstSend.status).toBe(200);
  const finalSend = await fetch(reviewEndpoint("/send"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft: { message: "", annotations: [] }, end: true }),
  });
  expect(finalSend.status).toBe(200);

  const waitHeaders = {
    authorization: "Bearer delivery-test-token",
    [FEEDBACK_ACK_HEADER]: EXPLICIT_FEEDBACK_ACK_CAPABILITY,
  };
  const firstWait = await fetch(`${server.origin}/api/agent/sessions/${created.id}/wait?after=0`, {
    headers: waitHeaders,
  });
  expect(firstWait.status).toBe(200);
  expect(((await firstWait.json()) as { sequence: number }).sequence).toBe(1);
  expect(server.store.get(created.id)?.deliveredFeedbackSequence).toBe(0);

  const outOfOrderAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ sequence: 2 }),
  });
  expect(outOfOrderAck.status).toBe(400);

  const retry = await fetch(`${server.origin}/api/agent/sessions/${created.id}/wait?after=0`, {
    headers: waitHeaders,
  });
  expect(((await retry.json()) as { sequence: number }).sequence).toBe(1);
  const firstAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ sequence: 1 }),
  });
  expect(firstAck.status).toBe(200);

  const resumed = await createSession();
  expect(resumed).toMatchObject({ id: created.id, status: "ended", cursor: 1 });
  const finalWait = await fetch(`${server.origin}/api/agent/sessions/${created.id}/wait?after=1`, {
    headers: waitHeaders,
  });
  const finalDelivery = (await finalWait.json()) as { sequence: number; feedback: { status: string } };
  expect(finalDelivery).toMatchObject({ sequence: 2, feedback: { status: "ended" } });
  expect(server.store.get(created.id)?.deliveredFeedbackSequence).toBe(1);

  const finalAck = await fetch(`${server.origin}/api/agent/sessions/${created.id}/ack`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ sequence: 2 }),
  });
  expect(finalAck.status).toBe(200);
  expect(server.store.get(created.id)?.deliveredFeedbackSequence).toBe(2);
});
