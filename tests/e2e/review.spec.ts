import { expect, test } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createFeedbackEnvelope, formatFeedbackMarkdown } from "../../src/node/feedback.js";
import type { RunningServer } from "../../src/node/server.js";
import { FEEDBACK_LEASE_MILLISECONDS } from "../../src/node/store.js";

type ProductionServerModule = Pick<typeof import("../../src/node/server.js"), "startServer">;
type ProductionDaemonModule = Pick<typeof import("../../src/node/daemon.js"), "acquireStartupLock">;
type StartupLockRelease = Awaited<ReturnType<ProductionDaemonModule["acquireStartupLock"]>>;

interface CliDelivery {
  sequence: number;
  markdown: string;
  feedback: {
    status: "feedback" | "ended";
    session: { artifactRelativePath: string };
    reviewerMessage: string;
    annotations: Array<{ comment: string }>;
  };
}

interface ReviewRun {
  child: ReturnType<typeof spawn>;
  ready: Promise<string>;
  completion: Promise<CliDelivery>;
  stdout: () => string;
  stderr: () => string;
}

let server: RunningServer | undefined;
let coordinatorRelease: StartupLockRelease | undefined;
let rootPath: string;
let artifactPath: string;
let artifactSource: string;
const execFileAsync = promisify(execFile);

function redacted(value: string): string {
  return value.replace(/access=[^\s]+/gu, "access=[redacted]");
}

function withMockedNow<Value>(now: number, work: () => Value): Value {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return work();
  } finally {
    Date.now = originalNow;
  }
}

function launchReview(
  relativeArtifactPath = "plan.html",
  timeoutMilliseconds = 15_000,
  environment: NodeJS.ProcessEnv = {},
): ReviewRun {
  const child = spawn(
    process.execPath,
    [
      resolve("dist/node/cli.js"),
      "review",
      relativeArtifactPath,
      "--root",
      rootPath,
      "--no-open",
      "--format",
      "json",
    ],
    { cwd: rootPath, env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let signalReady: ((status: string) => void) | undefined;
  const ready = new Promise<string>((resolvePromise) => {
    signalReady = resolvePromise;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.includes("Waiting for Send to Agent or Send & End")) {
      signalReady?.(stderr);
      signalReady = undefined;
    }
  });
  const completion = new Promise<CliDelivery>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `Agent HTML Render CLI did not exit. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(redacted(stderr))}`,
        ),
      );
    }, timeoutMilliseconds);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Agent HTML Render CLI exited ${code}: ${redacted(stderr)}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as CliDelivery);
      } catch (error) {
        reject(new Error(`Agent HTML Render CLI returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
  return { child, ready, completion, stdout: () => stdout, stderr: () => stderr };
}

function backpressureAnnotations(idPrefix: string) {
  return Array.from({ length: 30 }, (_, index) => ({
    id: `${idPrefix}-${index}`,
    comment: "c".repeat(4_000),
    createdAt: "2026-08-31T00:00:00.000Z",
    target: {
      kind: "element" as const,
      tag: "p",
      cssPath: `main > p:nth-of-type(${index + 1})`,
      domPath: [index],
      text: "x".repeat(1_200),
      headingPath: [],
    },
  }));
}

async function queueBackpressuredFeedback(
  session: { id: string; secret: string; revision: number; contentHash: string },
  message: string,
  submissionId: string,
): Promise<void> {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const response = await fetch(
    `${server.origin}/api/review/${encodeURIComponent(session.id)}/send?access=${encodeURIComponent(session.secret)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: { message, annotations: backpressureAnnotations(submissionId) },
        end: true,
        baseRevision: session.revision,
        baseContentHash: session.contentHash,
        submissionId,
      }),
    },
  );
  expect(response.status, await response.text()).toBe(200);
}

async function createBrowserSession(
  relativePath: string,
  source: string,
): Promise<{ id: string; reviewUrl: string }> {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  await writeFile(join(rootPath, relativePath), source);
  const response = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: { authorization: "Bearer e2e-agent-token", "content-type": "application/json" },
    body: JSON.stringify({ artifactPath: relativePath }),
  });
  expect(response.status).toBe(200);
  const created = (await response.json()) as { session: { id: string; reviewUrl: string } };
  return created.session;
}

test.beforeAll(async () => {
  rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-e2e-"));
  artifactPath = join(rootPath, "plan.html");
  artifactSource = (await readFile(resolve("examples/plan.html"), "utf8")).replace(
    "</head>",
    "<script>window.__artifactScriptRan = true;</script></head>",
  );
  await writeFile(artifactPath, artifactSource);
  const productionServerUrl = pathToFileURL(resolve("dist/node/server.js")).href;
  const productionDaemonUrl = pathToFileURL(resolve("dist/node/daemon.js")).href;
  const productionServer = await import(productionServerUrl) as ProductionServerModule;
  const productionDaemon = await import(productionDaemonUrl) as ProductionDaemonModule;
  coordinatorRelease = await productionDaemon.acquireStartupLock(rootPath);
  server = await productionServer.startServer({
    rootPath,
    token: "e2e-agent-token",
    startupCoordinatorId: coordinatorRelease.ownerId,
  });
  await mkdir(join(rootPath, ".agent-html-render"), { recursive: true });
  await writeFile(
    join(rootPath, ".agent-html-render", "daemon.json"),
    `${JSON.stringify({
      protocolVersion: "1",
      pid: process.pid,
      rootPath,
      rootDevice: server.rootDevice,
      rootInode: server.rootInode,
      stateDevice: server.stateDevice,
      stateInode: server.stateInode,
      startupCoordinatorId: coordinatorRelease.ownerId,
      packageVersion: server.packageVersion,
      buildId: server.buildId,
      port: server.port,
      token: "e2e-agent-token",
      startedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
});

test.afterAll(async () => {
  try {
    await server?.close();
  } finally {
    await coordinatorRelease?.();
  }
});

test("keeps a valid control-bearing artifact filename inside one trusted CLI status line", async ({ page }) => {
  test.skip(process.platform === "win32", "Windows filenames cannot contain LF.");
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const relativeArtifactPath = "plan\tpart\n[agent-html-render] FORGED\u2028next\u2029.html";
  await writeFile(join(rootPath, relativeArtifactPath), artifactSource);

  const review = launchReview(relativeArtifactPath);
  const statusOutput = await review.ready;
  const statusLines = statusOutput.split("\n").filter((line) => line.startsWith("[agent-html-render]"));
  expect(statusLines).toHaveLength(3);
  expect(statusLines[0]).toBe(
    "[agent-html-render] Reviewing plan\\u{0009}part\\u{000a}" +
      "[agent-html-render] FORGED\\u{2028}next\\u{2029}.html",
  );
  expect(statusOutput).not.toContain("\n[agent-html-render] FORGED.html\n");

  await expect.poll(() =>
    server?.store.list().some((candidate) => candidate.artifactRelativePath === relativeArtifactPath),
  ).toBe(true);
  const session = server.store.list().find(
    (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
  );
  if (!session) throw new Error("The control-bearing artifact session was not created.");

  const status = await execFileAsync(
    process.execPath,
    [resolve("dist/node/cli.js"), "status", "--root", rootPath],
    { cwd: rootPath, encoding: "utf8", timeout: 10_000 },
  );
  const statusReport = JSON.parse(status.stdout) as { sessions: Array<{ artifactRelativePath: string }> };
  expect(statusReport.sessions.some(
    (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
  )).toBe(true);

  await page.goto(`${server.origin}/session/${session.id}?access=${encodeURIComponent(session.secret)}`);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const reviewerMessage = "The filename\u2028remains\u2029ordinary artifact data with literal \\u{2028}.";
  await page.getByTestId("reviewer-message").fill(reviewerMessage);
  await page.getByTestId("send-end").click();
  const delivery = await review.completion;
  expect(delivery).toMatchObject({
    feedback: {
      status: "ended",
      session: { artifactRelativePath: relativeArtifactPath },
      reviewerMessage,
    },
  });
  expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(delivery.sequence);
});

test("fully writes a large bounded feedback batch before acknowledging it", async () => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const relativeArtifactPath = "large-feedback-output.html";
  await writeFile(join(rootPath, relativeArtifactPath), artifactSource);
  const review = launchReview(relativeArtifactPath);
  await review.ready;
  await expect.poll(() =>
    server?.store.list().some((candidate) => candidate.artifactRelativePath === relativeArtifactPath),
  ).toBe(true);
  const session = server.store.list().find(
    (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
  );
  if (!session) throw new Error("The large-output review session was not created.");

  const annotations = Array.from({ length: 30 }, (_, index) => {
    const commentPrefix = `Annotation ${index}: `;
    return {
      id: `large-annotation-${index}`,
      comment: commentPrefix + "c".repeat(4_000 - commentPrefix.length),
      createdAt: "2026-08-31T00:00:00.000Z",
      target: {
        kind: "element" as const,
        tag: "p",
        cssPath: `main > p:nth-of-type(${index + 1})`,
        domPath: [index],
        text: "x".repeat(1_200),
        headingPath: [],
      },
    };
  });
  const send = await fetch(
    `${server.origin}/api/review/${encodeURIComponent(session.id)}/send?access=${encodeURIComponent(session.secret)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: { message: "m".repeat(8_000), annotations },
        end: true,
        baseRevision: session.revision,
        baseContentHash: session.contentHash,
        submissionId: "large-output-submission",
      }),
    },
  );
  expect(send.status, await send.text()).toBe(200);

  const delivery = await review.completion;
  expect(delivery.feedback.annotations).toHaveLength(30);
  expect(delivery.feedback.annotations[0]?.comment).toHaveLength(4_000);
  expect(delivery.feedback.reviewerMessage).toHaveLength(8_000);
  expect(delivery.markdown.length).toBeGreaterThan(150_000);
  expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(delivery.sequence);
});

test("renews a backpressured delivery beyond the lease TTL without duplicating it", async () => {
  test.setTimeout(90_000);
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const relativeArtifactPath = "renewed-backpressure-output.html";
  await writeFile(join(rootPath, relativeArtifactPath), artifactSource);
  let paused: ReviewRun | undefined;
  let competitor: ReviewRun | undefined;
  try {
    paused = launchReview(relativeArtifactPath, 75_000);
    await paused.ready;
    const session = server.store.list().find(
      (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
    );
    if (!session) throw new Error("The renewed-output review session was not created.");
    paused.child.stdout?.pause();
    const annotations = Array.from({ length: 30 }, (_, index) => {
      const commentPrefix = `Renewed annotation ${index}: `;
      return {
        id: `renewed-annotation-${index}`,
        comment: commentPrefix + "c".repeat(4_000 - commentPrefix.length),
        createdAt: "2026-08-31T00:00:00.000Z",
        target: {
          kind: "element" as const,
          tag: "p",
          cssPath: `main > p:nth-of-type(${index + 1})`,
          domPath: [index],
          text: "x".repeat(1_200),
          headingPath: [],
        },
      };
    });
    const firstSend = await fetch(
      `${server.origin}/api/review/${encodeURIComponent(session.id)}/send?access=${encodeURIComponent(session.secret)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft: { message: "Keep this delivery exclusive while stdout is paused.", annotations },
          end: false,
          baseRevision: session.revision,
          baseContentHash: session.contentHash,
          submissionId: "renewed-backpressure-first",
        }),
      },
    );
    expect(firstSend.status, await firstSend.text()).toBe(200);

    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 31_500));
    expect(paused.child.exitCode).toBeNull();
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(0);
    competitor = launchReview(relativeArtifactPath, 40_000);
    await competitor.ready;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000));
    expect(competitor.stdout()).toBe("");
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(0);

    paused.child.stdout?.resume();
    const firstDelivery = await paused.completion;
    expect(firstDelivery.sequence).toBe(1);
    expect(firstDelivery.feedback.reviewerMessage).toBe(
      "Keep this delivery exclusive while stdout is paused.",
    );
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(1);

    const current = server.store.get(session.id);
    if (!current) throw new Error("The renewed-output session disappeared before its second send.");
    const secondSend = await fetch(
      `${server.origin}/api/review/${encodeURIComponent(session.id)}/send?access=${encodeURIComponent(session.secret)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft: { message: "Deliver only after the renewed batch.", annotations: [] },
          end: true,
          baseRevision: current.revision,
          baseContentHash: current.contentHash,
          submissionId: "renewed-backpressure-second",
        }),
      },
    );
    expect(secondSend.status, await secondSend.text()).toBe(200);
    const secondDelivery = await competitor.completion;
    expect(secondDelivery.sequence).toBe(2);
    expect(secondDelivery.feedback.reviewerMessage).toBe("Deliver only after the renewed batch.");
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(2);
  } finally {
    for (const run of [paused, competitor]) {
      if (!run) continue;
      void run.completion.catch(() => undefined);
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    }
  }
});

test("terminates a permanently blocked writer at the bounded output deadline without releasing early", async () => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const relativeArtifactPath = "bounded-output-termination.html";
  await writeFile(join(rootPath, relativeArtifactPath), artifactSource);
  const review = launchReview(relativeArtifactPath, 8_000, {
    AGENT_HTML_RENDER_TEST_MODE: "1",
    AGENT_HTML_RENDER_TEST_FEEDBACK_OUTPUT_MAXIMUM_MS: "500",
  });
  void review.completion.catch(() => undefined);
  try {
    await review.ready;
    const session = server.store.list().find(
      (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
    );
    if (!session) throw new Error("The bounded-output review session was not created.");
    review.child.stdout?.pause();

    const startedAt = Date.now();
    await queueBackpressuredFeedback(
      session,
      "Terminate this writer if the downstream reader stays paused.",
      "bounded-output-termination",
    );
    await expect.poll(() => review.child.exitCode, { timeout: 3_000 }).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(review.stderr()).toContain("terminating immediately without releasing the lease early");
    expect(review.stderr()).toContain("Feedback output did not complete within the bounded 0.5-second");
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(0);
    expect(server.store.leaseNextUndelivered(session.id, 0, "premature-successor").delivery)
      .toBeUndefined();

    review.child.stdout?.resume();
    await expect(review.completion).rejects.toThrow("exited 1");
    const activeStore = server.store;
    const replacement = withMockedNow(Date.now() + FEEDBACK_LEASE_MILLISECONDS + 1, () =>
      activeStore.leaseNextUndelivered(session.id, 0, "post-expiry-successor"));
    expect(replacement.delivery?.sequence).toBe(1);
    if (!replacement.delivery) throw new Error("Feedback did not become available after lease expiry.");
    await server.store.markDelivered(
      session.id,
      replacement.delivery.sequence,
      "post-expiry-successor",
      replacement.leaseId,
    );
  } finally {
    review.child.stdout?.resume();
    if (review.child.exitCode === null && review.child.signalCode === null) review.child.kill("SIGKILL");
  }
});

test("terminates a blocked writer immediately when exact lease renewal is rejected", async () => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const relativeArtifactPath = "rejected-renewal-termination.html";
  await writeFile(join(rootPath, relativeArtifactPath), artifactSource);
  const daemonMetadataPath = join(rootPath, ".agent-html-render", "daemon.json");
  const originalMetadata = await readFile(daemonMetadataPath, "utf8");
  let renewalRequests = 0;
  const proxy = createServer((request, response) => {
    if (request.method === "POST" && request.url?.endsWith("/renew-lease")) {
      renewalRequests += 1;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"renewed":false}');
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: server?.port,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${server?.port ?? 0}` },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.once("error", (error) => response.destroy(error));
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise<void>((resolvePromise, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const proxyAddress = proxy.address() as AddressInfo;
  const metadata = JSON.parse(originalMetadata) as Record<string, unknown>;
  metadata.port = proxyAddress.port;
  await writeFile(daemonMetadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });

  const review = launchReview(relativeArtifactPath, 8_000, {
    AGENT_HTML_RENDER_TEST_MODE: "1",
    AGENT_HTML_RENDER_TEST_FEEDBACK_LEASE_RENEWAL_INTERVAL_MS: "100",
    AGENT_HTML_RENDER_TEST_FEEDBACK_OUTPUT_MAXIMUM_MS: "5000",
  });
  void review.completion.catch(() => undefined);
  try {
    await review.ready;
    const session = server.store.list().find(
      (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
    );
    if (!session) throw new Error("The rejected-renewal review session was not created.");
    review.child.stdout?.pause();

    const startedAt = Date.now();
    await queueBackpressuredFeedback(
      session,
      "Terminate this blocked writer when its exact renewal is rejected.",
      "rejected-renewal-termination",
    );
    await expect.poll(() => review.child.exitCode, { timeout: 3_000 }).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(renewalRequests).toBe(1);
    expect(review.stderr()).toContain("no longer recognizes this command's exact feedback delivery lease");
    expect(review.stderr()).toContain("terminating immediately without releasing the lease early");
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(0);
    expect(server.store.leaseNextUndelivered(session.id, 0, "premature-successor").delivery)
      .toBeUndefined();

    review.child.stdout?.resume();
    await expect(review.completion).rejects.toThrow("exited 1");
    const activeStore = server.store;
    const replacement = withMockedNow(Date.now() + FEEDBACK_LEASE_MILLISECONDS + 1, () =>
      activeStore.leaseNextUndelivered(session.id, 0, "post-renewal-expiry-successor"));
    expect(replacement.delivery?.sequence).toBe(1);
    if (!replacement.delivery) throw new Error("Rejected-renewal feedback did not remain queued.");
    await server.store.markDelivered(
      session.id,
      replacement.delivery.sequence,
      "post-renewal-expiry-successor",
      replacement.leaseId,
    );
  } finally {
    review.child.stdout?.resume();
    if (review.child.exitCode === null && review.child.signalCode === null) review.child.kill("SIGKILL");
    await writeFile(daemonMetadataPath, originalMetadata, { mode: 0o600 });
    await new Promise<void>((resolvePromise) => {
      proxy.close(() => resolvePromise());
      proxy.closeAllConnections();
    });
  }
});

test("rejects a completed writer after its exact grant is superseded", async () => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const relativeArtifactPath = "superseded-output-grant.html";
  await writeFile(join(rootPath, relativeArtifactPath), artifactSource);
  const staleWriter = launchReview(relativeArtifactPath);
  try {
    await staleWriter.ready;
    const session = server.store.list().find(
      (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
    );
    if (!session) throw new Error("The superseded-output review session was not created.");
    staleWriter.child.stdout?.pause();
    const annotations = Array.from({ length: 30 }, (_, index) => ({
      id: `superseded-output-${index}`,
      comment: "c".repeat(4_000),
      createdAt: "2026-08-31T00:00:00.000Z",
      target: {
        kind: "element" as const,
        tag: "p",
        cssPath: `main > p:nth-of-type(${index + 1})`,
        domPath: [index],
        text: "x".repeat(1_200),
        headingPath: [],
      },
    }));
    const send = await fetch(
      `${server.origin}/api/review/${encodeURIComponent(session.id)}/send?access=${encodeURIComponent(session.secret)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft: { message: "Do not let this stale writer report success.", annotations },
          end: true,
          baseRevision: session.revision,
          baseContentHash: session.contentHash,
          submissionId: "superseded-output-send",
        }),
      },
    );
    expect(send.status, await send.text()).toBe(200);

    const activeStore = server.store;
    const replacement = withMockedNow(Date.now() + 30_001, () =>
      activeStore.leaseNextUndelivered(session.id, 0, "forced-successor"));
    if (!replacement.delivery) throw new Error("The stale writer did not hold the original lease.");
    staleWriter.child.stdout?.resume();
    let failure: Error | undefined;
    try {
      await staleWriter.completion;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    expect(failure?.message).toContain("was written completely");
    expect(failure?.message).toContain("exclusive delivery lease could not be retained");
    expect(JSON.parse(staleWriter.stdout())).toMatchObject({ sequence: 1 });
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(0);

    await server.store.markDelivered(
      session.id,
      replacement.delivery.sequence,
      "forced-successor",
      replacement.leaseId,
    );
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(1);
  } finally {
    void staleWriter.completion.catch(() => undefined);
    if (staleWriter.child.exitCode === null && staleWriter.child.signalCode === null) {
      staleWriter.child.kill("SIGKILL");
    }
  }
});

test("does not acknowledge feedback when stdout closes before delivery", async () => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const relativeArtifactPath = "closed-feedback-output.html";
  await writeFile(join(rootPath, relativeArtifactPath), artifactSource);
  const review = launchReview(relativeArtifactPath);
  await review.ready;
  await expect.poll(() =>
    server?.store.list().some((candidate) => candidate.artifactRelativePath === relativeArtifactPath),
  ).toBe(true);
  const session = server.store.list().find(
    (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
  );
  if (!session) throw new Error("The closed-output review session was not created.");
  review.child.stdout?.destroy();

  const send = await fetch(
    `${server.origin}/api/review/${encodeURIComponent(session.id)}/send?access=${encodeURIComponent(session.secret)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: { message: "Retry this feedback after repairing stdout.", annotations: [] },
        end: true,
        baseRevision: session.revision,
        baseContentHash: session.contentHash,
        submissionId: "closed-output-submission",
      }),
    },
  );
  expect(send.status, await send.text()).toBe(200);

  let failure: Error | undefined;
  try {
    await review.completion;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  expect(failure?.message).toContain("exited 1");
  expect(failure?.message).toContain("could not be written completely and was not acknowledged");
  expect(failure?.message).not.toContain("Emitted 'error' event");
  expect(failure?.message).not.toContain("node:events");
  expect(server.store.get(session.id)?.feedbackEvents).toHaveLength(1);
  expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(0);

  const retryStartedAt = Date.now();
  const retry = launchReview(relativeArtifactPath);
  await retry.ready;
  const delivery = await retry.completion;
  expect(Date.now() - retryStartedAt).toBeLessThan(5_000);
  expect(delivery.feedback.reviewerMessage).toBe("Retry this feedback after repairing stdout.");
  expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(delivery.sequence);
});

test("reports when failed-output lease release cannot be confirmed", async () => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const relativeArtifactPath = "unconfirmed-release-output.html";
  await writeFile(join(rootPath, relativeArtifactPath), artifactSource);
  const daemonMetadataPath = join(rootPath, ".agent-html-render", "daemon.json");
  const originalMetadata = await readFile(daemonMetadataPath, "utf8");
  const proxy = createServer((request, response) => {
    if (request.url?.endsWith("/release-lease")) {
      request.resume();
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: server?.port,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502);
      response.end(String(error));
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise<void>((resolvePromise, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => {
      proxy.off("error", reject);
      resolvePromise();
    });
  });
  const proxyAddress = proxy.address() as AddressInfo;
  const metadata = JSON.parse(originalMetadata) as Record<string, unknown>;
  metadata.port = proxyAddress.port;
  await writeFile(daemonMetadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });

  let review: ReviewRun | undefined;
  try {
    review = launchReview(relativeArtifactPath);
    await review.ready;
    await expect.poll(() =>
      server?.store.list().some((candidate) => candidate.artifactRelativePath === relativeArtifactPath),
    ).toBe(true);
    const session = server.store.list().find(
      (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
    );
    if (!session) throw new Error("The unconfirmed-release review session was not created.");
    review.child.stdout?.destroy();

    const send = await fetch(
      `${server.origin}/api/review/${encodeURIComponent(session.id)}/send?access=${encodeURIComponent(session.secret)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft: { message: "Keep this queued when lease cleanup times out.", annotations: [] },
          end: true,
          baseRevision: session.revision,
          baseContentHash: session.contentHash,
          submissionId: "unconfirmed-release-submission",
        }),
      },
    );
    expect(send.status, await send.text()).toBe(200);

    const failureStartedAt = Date.now();
    let failure: Error | undefined;
    try {
      await review.completion;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    expect(Date.now() - failureStartedAt).toBeLessThan(3_000);
    expect(failure?.message).toContain("could not be written completely and was not acknowledged");
    expect(failure?.message).toContain("lease release could not be confirmed within 500 ms");
    expect(failure?.message).toContain("may remain unavailable for up to 30 seconds");
    expect(failure?.message).not.toContain("Emitted 'error' event");
    expect(failure?.message).not.toContain("node:events");
    expect(server.store.get(session.id)?.feedbackEvents).toHaveLength(1);
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(0);
    expect(server.store.leaseNextUndelivered(session.id, 0, "competing-consumer").delivery)
      .toBeUndefined();
  } finally {
    if (review?.child.exitCode === null && review.child.signalCode === null) review.child.kill("SIGKILL");
    await writeFile(daemonMetadataPath, originalMetadata, { mode: 0o600 });
    await new Promise<void>((resolvePromise) => {
      proxy.close(() => resolvePromise());
      proxy.closeAllConnections();
    });
  }
});

test("completes a safe two-revision annotation loop", async ({ page }) => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const firstReview = launchReview();
  await firstReview.ready;
  await expect.poll(() =>
    server?.store.list().some((candidate) => candidate.artifactRelativePath === "plan.html"),
  ).toBe(true);
  const session = server.store.list().find((candidate) => candidate.artifactRelativePath === "plan.html");
  if (!session) throw new Error("Agent HTML Render CLI did not create a review session.");
  const reviewUrl = `${server.origin}/session/${session.id}?access=${encodeURIComponent(session.secret)}`;
  let eventRequestCount = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/events")) eventRequestCount += 1;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(reviewUrl);
  await page.waitForTimeout(1_200);
  expect(eventRequestCount).toBeLessThanOrEqual(2);

  await expect(page.getByText("agent-html-render", { exact: true })).toBeVisible();
  const annotateButton = page.getByRole("button", { name: "Annotate" });
  await expect(annotateButton).toHaveAttribute("aria-pressed", "false");
  await expect(annotateButton).toHaveCSS("border-top-width", "1px");
  await expect(annotateButton).toHaveCSS("border-top-style", "solid");
  await expect(page.getByRole("button", { name: "Interact" })).toHaveCount(0);
  await expect(page.locator("header").getByTestId("review-activity")).toBeVisible();
  await expect(page.getByTestId("revision")).toHaveText("r1");

  const artifact = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(artifact.getByRole("heading", { name: "Authentication rollout" })).toBeVisible();
  const authoredScriptRan = await artifact.locator("body").evaluate(() =>
    Boolean((window as Window & { __artifactScriptRan?: boolean }).__artifactScriptRan),
  );
  expect(authoredScriptRan).toBe(false);

  await artifact.locator("body").evaluate((body) => {
    const link = document.createElement("a");
    link.href = "https://example.com/should-not-open";
    link.textContent = "External test link";
    body.append(link);
  });
  await artifact.getByRole("link", { name: "External test link" }).click();
  await expect(artifact.getByRole("heading", { name: "Authentication rollout" })).toBeVisible();
  await annotateButton.click();
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCSS("background-color", "rgb(23, 23, 23)");

  await artifact.getByRole("heading", { name: "Invite returning users" }).click();
  await expect(page.getByTestId("selection-card")).toBeVisible();
  await expect(page.getByTestId("selection-card")).toContainText("Invite returning users");
  await page.getByTestId("annotation-comment").fill("Clarify when the enrollment invitation appears.");
  await writeFile(
    artifactPath,
    artifactSource.replace("Authentication rollout", "Authentication rollout plan"),
  );
  await expect(page.getByTestId("revision")).toHaveText("r2", { timeout: 10_000 });
  await page.screenshot({ path: "/tmp/agent-html-render-annotation-composer.png", fullPage: true });
  await page.getByTestId("add-annotation").click();
  await expect(page.getByTestId("selection-card")).toHaveCount(0);
  const marker = page.getByRole("button", { name: "Edit annotation 1" });
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(page.getByRole("dialog", { name: "Edit annotation" })).toBeVisible();
  await expect(page.getByTestId("annotation-comment")).toHaveValue(
    "Clarify when the enrollment invitation appears.",
  );
  await page.getByTestId("annotation-comment").fill("Show the invitation after the dashboard loads.");
  await page.screenshot({ path: "/tmp/agent-html-render-annotation-edit.png", fullPage: true });
  await page.getByTestId("save-annotation").click();
  await expect(page.getByTestId("selection-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Review (1)" }).click();
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Keep notes for revision 2" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(page.getByTestId("queued-annotation")).toContainText("Show the invitation after the dashboard loads.");
  await page.getByRole("button", { name: "Edit annotation 1" }).click();
  await expect(page.getByRole("dialog", { name: "Edit annotation" })).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolvePromise) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise()));
  }));
  await expect(page.getByTestId("annotation-comment")).toBeFocused();
  await expect(page.getByTestId("annotation-comment")).toHaveValue("Show the invitation after the dashboard loads.");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("selection-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review (1)" })).toBeFocused();
  await page.getByRole("button", { name: "Review (1)" }).click();
  await page.getByRole("button", { name: "Edit annotation 1" }).click();
  await expect(page.getByTestId("annotation-comment")).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("selection-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review (1)" })).toBeFocused();
  await page.getByRole("button", { name: "Review (1)" }).click();
  await page.screenshot({ path: "/tmp/agent-html-render-review-dialog.png", fullPage: true });
  await page.setViewportSize({ width: 786, height: 900 });
  await expect(page.getByRole("dialog", { name: "Review" })).toBeVisible();
  await page.screenshot({ path: "/tmp/agent-html-render-review-dialog-compact.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(page.getByTestId("revision-conflict")).toContainText(
    "These notes started on revision 1",
  );
  await expect(page.getByTestId("send-feedback")).toBeDisabled();
  await page.getByRole("button", { name: "Keep notes for revision 2" }).click();
  await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
  await expect(page.getByTestId("send-feedback")).toBeEnabled();

  await page.route(
    "**/api/review/*/send?*",
    async (route) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      await route.continue();
    },
    { times: 1 },
  );
  await page.getByTestId("send-feedback").click();
  await expect(page.getByTestId("review-activity")).toContainText("Sending feedback");
  await expect.poll(() => server?.store.get(session.id)?.deliveredFeedbackSequence).toBe(1);
  await expect(page.getByTestId("review-activity")).toContainText("Agent received feedback");
  await expect(page.getByTestId("review-activity")).toContainText("Waiting for revision 3");
  await expect(page.getByTestId("waiting-feedback")).toContainText("Waiting for the agent’s update");
  await expect(page.getByTestId("waiting-feedback")).toContainText("The agent received feedback 1");
  await page.screenshot({ path: "/tmp/agent-html-render-waiting.png", fullPage: true });
  const firstDelivery = await firstReview.completion;
  expect(firstDelivery.sequence).toBe(1);
  expect(firstDelivery.feedback.status).toBe("feedback");
  expect(firstDelivery.feedback.annotations[0]?.comment).toBe(
    "Show the invitation after the dashboard loads.",
  );
  await expect(page.getByTestId("queued-annotation")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("review-activity")).toContainText("Agent received feedback");
  await expect(page.getByTestId("waiting-feedback")).toBeVisible();

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByTestId("reviewer-message").fill("Keep the revised timeline concise.");
  await page.route(
    "**/api/review/*/send?*",
    (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Delivery unavailable."}' }),
    { times: 1 },
  );
  await page.getByTestId("send-feedback").click();
  await expect(page.getByTestId("review-activity")).toContainText("Send rejected");
  await expect(page.getByTestId("review-activity")).toContainText("Your notes are still here");
  await expect(page.getByTestId("reviewer-message")).toHaveValue("Keep the revised timeline concise.");

  await page.getByTestId("send-feedback").click();
  await expect(page.getByTestId("review-activity")).toContainText("Feedback queued");
  await expect(page.getByTestId("review-activity")).toContainText("Waiting for an agent review command");
  await expect(page.getByTestId("waiting-feedback")).toContainText("Waiting for the agent");
  await expect(page.getByTestId("waiting-feedback")).toContainText("Feedback 2 is saved");
  expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(1);

  const queuedReview = launchReview();
  await queuedReview.ready;
  await expect(page.getByTestId("review-activity")).toContainText("Agent received feedback");
  await expect(page.getByTestId("waiting-feedback")).toContainText("Waiting for the agent’s update");
  const queuedDelivery = await queuedReview.completion;
  expect(queuedDelivery.sequence).toBe(2);
  expect(queuedDelivery.feedback.reviewerMessage).toBe("Keep the revised timeline concise.");

  const revisedSource = artifactSource.replace(
    "Invite returning users",
    "Invite users at the right moment",
  );
  await writeFile(artifactPath, revisedSource);
  await expect(page.getByTestId("revision")).toHaveText("r3", { timeout: 10_000 });
  await expect(page.getByTestId("review-activity")).toContainText("Revision 3 ready");
  await expect(page.getByTestId("waiting-feedback")).toHaveCount(0);
  await expect(artifact.getByRole("heading", { name: "Invite users at the right moment" })).toBeVisible();

  const previousFeedbackMarker = page.getByRole("button", { name: "Review feedback F1.1" });
  await expect(previousFeedbackMarker).toBeVisible();
  await page.getByRole("button", { name: "Review (2)" }).click();
  const generalNoteReview = page.getByTestId("general-note-review-item");
  await expect(generalNoteReview).toContainText("Keep the revised timeline concise.");
  await generalNoteReview.getByRole("button", { name: "Still needs work" }).click();
  await expect(generalNoteReview.getByRole("button", { name: "Requeued" })).toBeDisabled();
  await expect(page.getByTestId("reviewer-message")).toHaveValue("Keep the revised timeline concise.");
  await generalNoteReview.getByRole("button", { name: "Resolved" }).click();
  await expect(generalNoteReview.getByText("resolved", { exact: true })).toBeVisible();
  await expect(page.getByTestId("reviewer-message")).toHaveValue("");
  const changeReviewItem = page.getByTestId("change-review-item");
  await expect(changeReviewItem).toContainText("Show the invitation after the dashboard loads.");
  await expect(changeReviewItem).toContainText("Invite returning users");
  await expect(changeReviewItem).toContainText("Invite users at the right moment");
  await page.screenshot({ path: "/tmp/agent-html-render-review-changes.png", fullPage: true });
  await changeReviewItem.getByRole("button", { name: "Still needs work" }).click();
  await expect(changeReviewItem.getByRole("button", { name: "Requeued" })).toBeDisabled();
  await expect(page.getByTestId("queued-annotation")).toContainText(
    "Show the invitation after the dashboard loads.",
  );
  await changeReviewItem.getByRole("button", { name: "Resolved" }).click();
  await expect(changeReviewItem.getByText("resolved", { exact: true })).toBeVisible();
  await expect(page.getByTestId("queued-annotation")).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(previousFeedbackMarker).toHaveCount(0);

  await page.screenshot({ path: "/tmp/agent-html-render-review-ui.png", fullPage: true });

  const finalReview = launchReview();
  await finalReview.ready;
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByTestId("reviewer-message").fill("This revision is ready to implement.");
  await page.getByTestId("send-end").click();
  await expect.poll(() => server?.store.get(session.id)?.deliveredFeedbackSequence).toBe(3);
  const finalDelivery = await finalReview.completion;
  expect(finalDelivery.sequence).toBe(3);
  expect(finalDelivery.feedback.status).toBe("ended");
  expect(finalDelivery.feedback.reviewerMessage).toBe("This revision is ready to implement.");
  await expect(page.getByRole("heading", { name: "Review complete" })).toBeVisible();
});

test("supports keyboard-only element and exact-text annotation on static HTML", async ({ page }) => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const session = await createBrowserSession(
    "keyboard-static.html",
    `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8"><title>Keyboard review</title>
          <style>
            #pseudo-covered { position: relative; min-height: 32px; }
            #pseudo-covered::after { content: ""; position: absolute; inset: 0; background: white; }
          </style>
        </head>
        <body>
          <main>
            <div style="height: 1px; overflow: clip"><p style="margin-top: 40px">OVERFLOW_CLIP_TOKEN</p></div>
            <div style="height: 1px; overflow: hidden"><p style="margin-top: 40px">OVERFLOW_HIDDEN_TOKEN</p></div>
            <h2 style="clip-path: inset(50%)">CLIP_PATH_TOKEN</h2>
            <h2 style="mask-image: linear-gradient(transparent, transparent)">MASK_TOKEN</h2>
            <div style="opacity: 0"><h2>Invisible transparent heading</h2></div>
            <h2 style="position: fixed; left: -10000px; top: -10000px">Invisible offscreen heading</h2>
            <h2 style="content-visibility: hidden">Invisible content heading</h2>
            <section style="position: relative; height: 32px">
              <h2 style="position: absolute; inset: 0; margin: 0">OCCLUDED_SIBLING_TOKEN</h2>
              <div aria-hidden="true" style="position: absolute; inset: 0; z-index: 5; background: white"></div>
            </section>
            <section style="position: relative; height: 32px">
              <h2 style="position: absolute; inset: 0; margin: 0">OCCLUDED_POINTER_NONE_TOKEN</h2>
              <div aria-hidden="true" style="position: absolute; inset: 0; z-index: 5; pointer-events: none; background: white"></div>
            </section>
            <section style="position: relative; height: 32px">
              <div aria-hidden="true" style="position: absolute; inset: 0; pointer-events: none; background: white"></div>
              <h2 style="margin: 0">OCCLUDED_PRECEDING_POSITIONED_TOKEN</h2>
            </section>
            <h2 id="pseudo-covered">OCCLUDED_PSEUDO_TOKEN</h2>
            <h1>Keyboard review heading</h1>
            <section style="position: relative; height: 32px">
              <h2 style="position: absolute; inset: 0; margin: 0">OCCLUDED_HEADING_CONTEXT_TOKEN</h2>
              <div aria-hidden="true" style="position: absolute; inset: 0; z-index: 5; pointer-events: none; background: white"></div>
            </section>
            <section style="position: relative; height: 32px">
              <div aria-hidden="true" style="position: absolute; inset: 0; z-index: 100; pointer-events: none; background: white"></div>
              <div style="position: relative; z-index: 50; height: 32px">
                <h2 style="position: absolute; inset: 0; z-index: 1000; margin: 0">OCCLUDED_NESTED_STACKING_TOKEN</h2>
              </div>
            </section>
            <p>Exact keyboard passage for the reviewer.</p>
            <p style="pointer-events: none">Visible pointer-transparent paragraph.</p>
            <p>Visible <span style="display: none">HIDDEN_DISPLAY_TOKEN</span><span style="visibility: hidden">HIDDEN_VISIBILITY_TOKEN</span><span style="position: fixed; left: -10000px; top: -10000px">OFFSCREEN_CHILD_TOKEN</span> tail</p>
            <p id="tall-paragraph" style="width: 180px; line-height: 20px">${"TALL_VISIBLE_TEXT ".repeat(180)}</p>
            <div style="height: 120px; overflow: auto">
              <p id="nested-tall-paragraph" style="width: 160px; line-height: 20px">${"NESTED_VISIBLE_TEXT ".repeat(120)}</p>
            </div>
            <div role="button">After tall prose</div>
          </main>
        </body>
      </html>`,
  );
  await page.goto(session.reviewUrl);
  const frameElement = page.getByTestId("artifact-frame");
  const artifact = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(artifact.getByRole("heading", { name: "Keyboard review heading" })).toBeVisible();
  expect(
    await artifact.locator("body").evaluate(() =>
      document.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ).length
    ),
  ).toBe(0);

  const annotate = page.getByRole("button", { name: "Annotate" });
  const activateAnnotationWithKeyboard = async (): Promise<void> => {
    await page.evaluate(() => new Promise<void>((resolvePromise) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise()));
    }));
    await annotate.press("Enter");
    await expect(frameElement).toBeFocused();
  };
  await activateAnnotationWithKeyboard();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("selection-card")).toContainText("Keyboard review heading");
  await expect(page.getByTestId("annotation-comment")).toBeFocused();
  await page.getByTestId("annotation-comment").fill("Clarify the keyboard-selected heading.");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("selection-card")).toHaveCount(0);

  await activateAnnotationWithKeyboard();
  await page.keyboard.press("Tab");
  await expect(page.locator(".selection-hint")).toContainText("Keyboard target: Keyboard review heading");
  await expect(page.locator(".selection-hint")).toHaveAttribute(
    "aria-label",
    /Keyboard target: Keyboard review heading.*Tab or arrow keys move/u,
  );
  await expect(page.locator(".bridge-overlay-hover")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".selection-hint")).toContainText(
    "Keyboard target: Exact keyboard passage for the reviewer.",
  );
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".selection-hint")).toContainText("Keyboard target: Keyboard review heading");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".selection-hint")).toContainText(
    "Keyboard target: Exact keyboard passage for the reviewer.",
  );
  await page.keyboard.press("Tab");
  await expect(page.locator(".selection-hint")).toContainText(
    "Keyboard target: Visible pointer-transparent paragraph.",
  );
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByTestId("selection-card")).toContainText("Exact keyboard passage for the reviewer.");
  await expect(page.getByTestId("selection-card")).toContainText("Text selection");
  await page.getByTestId("selection-card").getByRole("button", { name: "Cancel" }).click();

  await activateAnnotationWithKeyboard();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(".selection-hint")).toContainText("Keyboard target: Visible tail");
  await expect(page.locator(".selection-hint")).not.toContainText("HIDDEN_DISPLAY_TOKEN");
  await expect(page.locator(".selection-hint")).not.toContainText("HIDDEN_VISIBILITY_TOKEN");
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByTestId("selection-card")).toHaveCount(0);
  await expect(page.locator(".selection-hint")).toContainText(
    "visible text cannot be represented as one bounded exact selection",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("selection-card")).toContainText("Visible tail");
  await expect(page.getByTestId("selection-card")).not.toContainText("HIDDEN_DISPLAY_TOKEN");
  await expect(page.getByTestId("selection-card")).not.toContainText("HIDDEN_VISIBILITY_TOKEN");
  await expect(page.getByTestId("selection-card")).not.toContainText("OFFSCREEN_CHILD_TOKEN");
  await page.getByTestId("annotation-comment").fill("Keep only the visible sentence context.");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => server?.store.get(session.id)?.draft.annotations.length).toBe(2);

  const persisted = server.store.get(session.id);
  if (!persisted) throw new Error("keyboard session was not persisted");
  const agentMarkdown = formatFeedbackMarkdown(
    createFeedbackEnvelope(persisted, "feedback", "2026-08-31T00:00:00.000Z"),
  );
  const persistedAndDelivered = `${JSON.stringify(persisted.draft)}\n${agentMarkdown}`;
  for (const hiddenToken of [
    "OVERFLOW_CLIP_TOKEN",
    "OVERFLOW_HIDDEN_TOKEN",
    "CLIP_PATH_TOKEN",
    "MASK_TOKEN",
    "Invisible transparent heading",
    "Invisible offscreen heading",
    "Invisible content heading",
    "OCCLUDED_SIBLING_TOKEN",
    "OCCLUDED_POINTER_NONE_TOKEN",
    "OCCLUDED_PRECEDING_POSITIONED_TOKEN",
    "OCCLUDED_PSEUDO_TOKEN",
    "OCCLUDED_HEADING_CONTEXT_TOKEN",
    "OCCLUDED_NESTED_STACKING_TOKEN",
    "HIDDEN_DISPLAY_TOKEN",
    "HIDDEN_VISIBILITY_TOKEN",
    "OFFSCREEN_CHILD_TOKEN",
  ]) {
    expect(persistedAndDelivered).not.toContain(hiddenToken);
  }
  expect(persisted.draft.annotations[1]?.target.text).toBe("Visible tail");
  expect(persisted.draft.annotations[1]?.target.headingPath).toEqual(["Keyboard review heading"]);

  await activateAnnotationWithKeyboard();
  await page.keyboard.press("End");
  await expect(page.locator(".selection-hint")).toContainText("After tall prose");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".selection-hint")).toContainText("NESTED_VISIBLE_TEXT");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".selection-hint")).toContainText("TALL_VISIBLE_TEXT");
  await expect(page.locator(".bridge-overlay-hover")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("selection-card")).toContainText("TALL_VISIBLE_TEXT");
  await page.getByTestId("selection-card").getByRole("button", { name: "Cancel" }).click();

  await activateAnnotationWithKeyboard();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".selection-hint")).toContainText("TALL_VISIBLE_TEXT");
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByTestId("selection-card")).toHaveCount(0);
  await expect(page.locator(".selection-hint")).toContainText(
    "visible text cannot be represented as one bounded exact selection",
  );
  await page.keyboard.press("Escape");
  await expect(annotate).toBeFocused();

  await activateAnnotationWithKeyboard();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".selection-hint")).toContainText("NESTED_VISIBLE_TEXT");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("selection-card")).toContainText("NESTED_VISIBLE_TEXT");
  await page.getByTestId("selection-card").getByRole("button", { name: "Cancel" }).click();

  await annotate.click();
  await artifact.locator("#tall-paragraph").click({ position: { x: 12, y: 12 } });
  await expect(page.getByTestId("selection-card")).toContainText("TALL_VISIBLE_TEXT");
  await page.getByTestId("selection-card").getByRole("button", { name: "Cancel" }).click();

  await activateAnnotationWithKeyboard();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("selection-card")).toContainText("Keyboard review heading");
  await page.getByTestId("selection-card").getByRole("button", { name: "Cancel" }).click();

  await activateAnnotationWithKeyboard();
  await page.keyboard.press("Escape");
  await expect(annotate).toBeFocused();
  await expect(annotate).toHaveAttribute("aria-pressed", "false");

  expect(
    await artifact.locator("body").evaluate((body) => ({
      bodyTabindex: body.getAttribute("tabindex"),
      headingTabindex: body.querySelector("h1")?.getAttribute("tabindex") ?? null,
    })),
  ).toEqual({ bodyTabindex: null, headingTabindex: null });
});

test("keeps visible decorations annotatable while rejecting an opaque cover", async ({ page }) => {
  const created = await createBrowserSession(
    "decorative-visibility.html",
    `<!doctype html><html><head><style>
      body { padding: 24px; }
      h1, h2, p { margin: 0; }
      .row { position: relative; height: 40px; margin: 12px 0; }
      .row > h2 { position: absolute; inset: 0; }
      .decoration { position: absolute; inset: 0; pointer-events: none; }
      #dot-heading { position: relative; }
      #dot-heading::before {
        content: "";
        position: absolute;
        left: -14px;
        top: 50%;
        width: 7px;
        height: 7px;
        background: #171717;
        border-radius: 50%;
        transform: translateY(-50%);
      }
      #identity-heading { position: relative; margin-top: 12px; }
      #identity-heading::before {
        content: "";
        position: absolute;
        left: -14px;
        top: 8px;
        width: 7px;
        height: 7px;
        background: #171717;
        transform: scale(1);
      }
      #late-cover { position: absolute; inset: 0; z-index: 20; pointer-events: none; background: white; opacity: 0; }
      #border-decoration { border: 2px solid #171717; }
      #shadow-decoration { box-shadow: 0 0 0 3px #171717; }
      #layered-row::after { content: ""; position: absolute; inset: 0; background: white; }
      #layered-heading { z-index: 2; }
      #opaque-decoration { z-index: 100; background: white; }
    </style></head><body><main>
      <h1 id="dot-heading">Visible dotted heading<span id="late-cover" aria-hidden="true"></span></h1>
      <h2 id="identity-heading">Visible identity-transform heading</h2>
      <section class="row">
        <h2 id="border-heading">Visible bordered heading</h2>
        <div id="border-decoration" class="decoration" aria-hidden="true"></div>
      </section>
      <section class="row">
        <h2 id="shadow-heading">Visible shadowed heading</h2>
        <div id="shadow-decoration" class="decoration" aria-hidden="true"></div>
      </section>
      <section id="layered-row" class="row">
        <h2 id="layered-heading">Visible layered heading</h2>
      </section>
      <section class="row">
        <h2 id="covered-heading">DECORATION_TRUE_COVER_TOKEN</h2>
        <div id="opaque-decoration" class="decoration" aria-hidden="true"></div>
      </section>
      <p>After visible decorations</p>
    </main></body></html>`,
  );
  await page.goto(created.reviewUrl);
  const frameElement = page.getByTestId("artifact-frame");
  const artifact = page.frameLocator('[data-testid="artifact-frame"]');
  const annotate = page.getByRole("button", { name: "Annotate" });
  const activateAnnotationWithKeyboard = async (): Promise<void> => {
    await page.evaluate(() => new Promise<void>((resolvePromise) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise()));
    }));
    await annotate.press("Enter");
    await expect(frameElement).toBeFocused();
  };

  await activateAnnotationWithKeyboard();
  for (const label of [
    "Visible dotted heading",
    "Visible identity-transform heading",
    "Visible bordered heading",
    "Visible shadowed heading",
    "Visible layered heading",
    "After visible decorations",
  ]) {
    await page.keyboard.press("Tab");
    await expect(page.locator(".selection-hint")).toContainText(`Keyboard target: ${label}`);
  }
  await expect(page.locator(".selection-hint")).not.toContainText("DECORATION_TRUE_COVER_TOKEN");
  await page.keyboard.press("Escape");

  for (const [selector, label] of [
    ["#dot-heading", "Visible dotted heading"],
    ["#identity-heading", "Visible identity-transform heading"],
    ["#border-heading", "Visible bordered heading"],
    ["#shadow-heading", "Visible shadowed heading"],
    ["#layered-heading", "Visible layered heading"],
  ] as const) {
    await annotate.click();
    await expect(frameElement).toBeFocused();
    await artifact.locator(selector).click({ position: { x: 20, y: 16 } });
    await expect(page.getByTestId("selection-card")).toContainText(label);
    await page.getByTestId("selection-card").getByRole("button", { name: "Cancel" }).click();
  }

  const stylesBefore = await artifact.locator("#covered-heading, #opaque-decoration").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("style")),
  );
  await annotate.click();
  await expect(frameElement).toBeFocused();
  await artifact.locator("#covered-heading").click({ position: { x: 20, y: 16 } });
  await expect(page.getByTestId("selection-card")).toHaveCount(0);
  await expect(page.locator(".selection-hint")).not.toContainText("DECORATION_TRUE_COVER_TOKEN");
  expect(await artifact.locator("#covered-heading, #opaque-decoration").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("style")),
  )).toEqual(stylesBefore);

  await page.keyboard.press("Escape");
  await activateAnnotationWithKeyboard();
  await page.keyboard.press("Tab");
  await expect(page.locator(".selection-hint")).toContainText("Keyboard target: Visible dotted heading");
  await artifact.locator("#late-cover").evaluate((cover) => {
    (cover as HTMLElement).style.opacity = "1";
  });
  await expect.poll(() => artifact.locator("#late-cover").evaluate((cover) => getComputedStyle(cover).opacity)).toBe("1");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("selection-card")).toHaveCount(0);
});

test("fails closed when an attached target is occluded before anchor recapture", async ({ page }) => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const created = await createBrowserSession(
    "occluded-recapture.html",
    `<!doctype html><html><body>
      <section id="target-shell" style="position: relative; min-height: 48px">
        <div style="position: relative; z-index: 50; min-height: 48px">
          <h1 id="recapture-target" style="position: absolute; inset: 0; z-index: 1000; margin: 0">Visible recapture target</h1>
        </div>
      </section>
    </body></html>`,
  );
  await page.goto(created.reviewUrl);
  const artifact = page.frameLocator('[data-testid="artifact-frame"]');
  const target = artifact.locator("#recapture-target");
  await page.getByRole("button", { name: "Annotate" }).click();
  await expect(page.getByTestId("artifact-frame")).toBeFocused();
  await target.click();
  await page.getByTestId("annotation-comment").fill("Keep this anchor bound to visible reviewer intent.");
  await page.getByTestId("add-annotation").click();
  await expect.poll(() => server?.store.get(created.id)?.draft.annotations.length).toBe(1);
  const record = server.store.get(created.id);
  const annotation = record?.draft.annotations[0];
  if (!record || !annotation) throw new Error("Recapture annotation was not persisted.");

  await page.evaluate(() => {
    const captureWindow = window as typeof window & { __anchorRecaptureMessages?: unknown[] };
    captureWindow.__anchorRecaptureMessages = [];
    window.addEventListener("message", (event) => {
      const candidate = event.data as { source?: unknown; type?: unknown };
      if (candidate?.source === "agent-html-render-bridge" && candidate.type === "anchor-resolutions") {
        captureWindow.__anchorRecaptureMessages?.push(candidate);
      }
    });
  });
  await target.evaluate((heading) => {
    heading.append(document.createTextNode(" RECAPTURE_HIDDEN_TOKEN"));
    const cover = document.createElement("div");
    cover.setAttribute("aria-hidden", "true");
    Object.assign(cover.style, {
      position: "absolute",
      inset: "0",
      zIndex: "100",
      pointerEvents: "none",
      background: "white",
    });
    heading.parentElement?.parentElement?.append(cover);
  });
  await page.getByTestId("artifact-frame").evaluate(
    (frame, payload) => {
      (frame as HTMLIFrameElement).contentWindow?.postMessage(payload, "*");
    },
    {
      source: "agent-html-render-shell",
      token: record.bridgeToken,
      type: "show-annotations",
      markers: [{ id: `draft:${annotation.id}`, label: "1", tone: "draft", annotation }],
    },
  );

  await expect.poll(() => page.evaluate(() => {
    const captureWindow = window as typeof window & { __anchorRecaptureMessages?: unknown[] };
    return captureWindow.__anchorRecaptureMessages?.length ?? 0;
  })).toBeGreaterThan(0);
  const recaptureMessages = await page.evaluate(() => {
    const captureWindow = window as typeof window & { __anchorRecaptureMessages?: unknown[] };
    return captureWindow.__anchorRecaptureMessages ?? [];
  });
  expect(JSON.stringify(recaptureMessages)).not.toContain("RECAPTURE_HIDDEN_TOKEN");
  expect(recaptureMessages).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "anchor-resolutions",
      resolutions: [expect.objectContaining({ id: `draft:${annotation.id}`, resolution: "unresolved" })],
    }),
  ]));
  await page.getByRole("button", { name: "Review (1)", exact: true }).click();
  await expect(page.getByTestId("queued-annotation")).toContainText("Unresolved");
  await expect(page.locator(".bridge-overlay-annotation")).toHaveCount(0);
});

test("surfaces and gates notes recovered onto a replacement artifact", async ({ page }) => {
  test.skip(process.platform === "win32", "parent inode replacement coverage requires POSIX semantics");
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const nestedPath = join(rootPath, "recovered-parent");
  const parkedPath = join(rootPath, "recovered-parent-original");
  await mkdir(nestedPath);
  const relativeArtifactPath = "recovered-parent/decision.html";
  const source = "<!doctype html><title>Recovered decision</title><main><h1>Recovered decision</h1></main>";
  const original = await createBrowserSession(relativeArtifactPath, source);
  const originalRecord = server.store.get(original.id);
  if (!originalRecord) throw new Error("replacement recovery fixture session is missing");
  await server.store.updateDraft(
    original.id,
    { message: "Preserve this decision note.", annotations: [] },
    originalRecord.revision,
    originalRecord.contentHash,
  );
  await rename(nestedPath, parkedPath);
  await mkdir(nestedPath);
  await writeFile(join(rootPath, relativeArtifactPath), source);

  const replacementResponse = await fetch(`${server.origin}/api/agent/sessions`, {
    method: "POST",
    headers: { authorization: "Bearer e2e-agent-token", "content-type": "application/json" },
    body: JSON.stringify({ artifactPath: relativeArtifactPath, newSession: true }),
  });
  expect(replacementResponse.status).toBe(200);
  const replacement = (await replacementResponse.json()) as { session: { reviewUrl: string } };
  await page.route(/\/api\/review\/[^/]+\/events(?:\?|$)/u, (route) => route.abort());
  await page.goto(replacement.session.reviewUrl);
  await expect(page.frameLocator('[data-testid="artifact-frame"]').getByRole("heading", { name: "Recovered decision" })).toBeVisible();
  await page.getByRole("button", { name: "Review (1)" }).click();
  await expect(page.getByTestId("reviewer-message")).toHaveValue("Preserve this decision note.");
  await expect(page.getByTestId("revision-conflict")).toContainText(
    "recovered from the preserved session for a replaced artifact",
  );
  const reviewerMessage = page.getByTestId("reviewer-message");
  await reviewerMessage.click();
  await expect.poll(() => reviewerMessage.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.outlineStyle}:${style.outlineWidth}`;
  })).toBe("solid:1px");
  await expect(page.getByTestId("send-feedback")).toBeDisabled();
  await page.getByRole("button", { name: "Keep recovered notes for revision 1" }).click();
  await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
  await expect(page.getByTestId("send-feedback")).toBeEnabled();
});

test("keeps the trusted review plane visible and blocks forged bridge navigation", async ({ page }) => {
  const session = await createBrowserSession(
    "hostile.html",
    `<!doctype html><!-- <head> --><html><head>
    <meta http-equiv="refr&#x65;sh" content="0; url=/escaped">
    <style>
      body { padding-top: 100px; }
      [data-agent-html-render-bridge="hover"],
      [data-agent-html-render-bridge="selection"],
      [data-agent-html-render-bridge="annotation"],
      .bridge-overlay,
      [class*="bridge-overlay"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    </style></head><body>
      <h1 data-agent-html-render-bridge="forged">Forged bridge heading</h1>
      <a data-agent-html-render-bridge="forged" href="about:blank#escaped">Forged external link</a>
      <svg width="220" height="32" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <a xlink:href="about:blank#svg-escaped"><text x="0" y="22">SVG external link</text></a>
      </svg>
      <a href="#local-target">Local fragment</a>
      <p id="local-target">Local target</p>
    </body></html>`,
  );
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(session.reviewUrl);
  const artifact = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(artifact.getByRole("heading", { name: "Forged bridge heading" })).toBeVisible();
  const artifactFrame = page.frames().find((frame) => frame !== page.mainFrame());
  if (!artifactFrame) throw new Error("artifact frame is missing");
  const originalUrl = artifactFrame.url();

  const forgedLink = artifact.getByRole("link", { name: "Forged external link" });
  await forgedLink.click();
  await forgedLink.press("Enter");
  await forgedLink.click({ button: "middle" });
  await expect.poll(() => artifactFrame.url()).toBe(originalUrl);
  const svgLink = artifact.locator("svg a");
  await svgLink.click();
  await svgLink.press("Enter");
  await svgLink.click({ button: "middle" });
  await expect.poll(() => artifactFrame.url()).toBe(originalUrl);
  await artifact.getByRole("link", { name: "Local fragment" }).click();
  await expect.poll(() => artifactFrame.url()).toBe(`${originalUrl}#local-target`);

  await page.getByRole("button", { name: "Annotate" }).click();
  await artifact.getByRole("heading", { name: "Forged bridge heading" }).hover();
  await expect(page.locator(".bridge-overlay-hover")).toBeVisible();
  await artifact.getByRole("heading", { name: "Forged bridge heading" }).click();
  await expect(page.getByTestId("selection-card")).toContainText("Forged bridge heading");
  await page.getByTestId("annotation-comment").fill("Keep this review marker trustworthy.");
  await page.getByTestId("add-annotation").click();
  await expect(page.getByRole("button", { name: "Edit annotation 1" })).toBeVisible();
  await expect(artifact.locator('[data-agent-html-render-bridge="forged"]')).toHaveCount(2);
});

test("reuses one submission ID after a committed response is lost", async ({ page }) => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const session = await createBrowserSession(
    "response-loss.html",
    "<!doctype html><html><body><h1>Response loss</h1></body></html>",
  );
  let stateRequests = 0;
  const submissionIds: string[] = [];
  await page.route("**/api/review/*/events?*", (route) => route.abort("failed"));
  await page.route("**/api/review/*/state?*", (route) => {
    stateRequests += 1;
    if (stateRequests === 2) void route.abort("failed");
    else void route.continue();
  });
  page.on("request", (request) => {
    if (!request.url().includes("/send?") || request.method() !== "POST") return;
    const body = request.postDataJSON() as { submissionId?: string };
    if (body.submissionId) submissionIds.push(body.submissionId);
  });
  await page.goto(session.reviewUrl);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByTestId("reviewer-message").fill("Commit this feedback exactly once.");
  await page.route(
    "**/api/review/*/send?*",
    async (route) => {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("failed");
    },
    { times: 1 },
  );

  await page.getByTestId("send-feedback").click();
  await expect(page.getByTestId("review-activity")).toContainText("Delivery unconfirmed");
  await expect(page.getByTestId("ambiguous-send")).toContainText("reuse this exact batch");
  await expect(page.getByTestId("reviewer-message")).toHaveValue("Commit this feedback exactly once.");
  await expect(page.getByTestId("reviewer-message")).toBeDisabled();
  await expect(page.getByTestId("send-end")).toBeDisabled();
  await expect(page.getByTestId("send-feedback")).toHaveText("Retry same feedback");
  expect(server.store.get(session.id)?.feedbackEvents).toHaveLength(1);

  await page.getByTestId("send-feedback").click();
  await expect(page.getByRole("dialog", { name: "Review" })).toHaveCount(0);
  expect(server.store.get(session.id)?.feedbackEvents).toHaveLength(1);
  expect(server.store.get(session.id)?.feedbackEvents[0]?.feedback.reviewerMessage).toBe(
    "Commit this feedback exactly once.",
  );
  expect(submissionIds).toHaveLength(2);
  expect(submissionIds[1]).toBe(submissionIds[0]);
});

test("retries the frozen submission when a locked annotation resolution changes", async ({ page }) => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const created = await createBrowserSession(
    "resolution-retry.html",
    "<!doctype html><html><body><h1 id=review-target>Frozen retry target</h1></body></html>",
  );
  let stateRequests = 0;
  await page.route("**/api/review/*/events?*", (route) => route.abort("failed"));
  await page.route("**/api/review/*/state?*", (route) => {
    stateRequests += 1;
    if (stateRequests === 2) void route.abort("failed");
    else void route.continue();
  });
  await page.goto(created.reviewUrl);
  const artifact = page.frameLocator('[data-testid="artifact-frame"]');
  const heading = artifact.getByRole("heading", { name: "Frozen retry target" });
  await expect(heading).toBeVisible();
  await page.getByRole("button", { name: "Annotate" }).click();
  await heading.hover();
  await expect(page.locator(".bridge-overlay-hover")).toBeVisible();
  await heading.click();
  await page.getByTestId("annotation-comment").fill("Keep this request immutable.");
  await page.getByTestId("add-annotation").click();
  await page.getByRole("button", { name: "Review (1)" }).click();
  await page.route(
    "**/api/review/*/send?*",
    async (route) => {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page.getByTestId("send-feedback").click();
  await expect(page.getByTestId("send-feedback")).toHaveText("Retry same feedback");
  const session = server.store.get(created.id);
  const delivery = session?.feedbackEvents[0];
  const annotation = delivery?.feedback.annotations[0];
  if (!session || !delivery?.submissionId || !annotation) {
    throw new Error("Frozen retry test feedback was not committed.");
  }

  await artifact.locator("body").evaluate(
    (_body, message) => window.parent.postMessage(message, "*"),
    {
      source: "agent-html-render-bridge",
      token: session.bridgeToken,
      type: "anchor-resolutions",
      resolutions: [{ id: `draft:${annotation.id}`, resolution: "unresolved" }],
    },
  );
  await expect(page.getByTestId("queued-annotation")).toContainText("Unresolved");
  await page.getByTestId("send-feedback").click();

  await expect(page.getByRole("dialog", { name: "Review" })).toHaveCount(0);
  expect(server.store.get(created.id)?.feedbackEvents).toHaveLength(1);
  expect(server.store.get(created.id)?.feedbackEvents[0]?.submissionId).toBe(delivery.submissionId);
  expect(server.store.get(created.id)?.feedbackEvents[0]?.feedback.annotations[0]?.resolution).toBe("attached");
});

test("keeps an unsaved local draft when another reviewer publishes a draft", async ({ page }) => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const created = await createBrowserSession(
    "draft-ownership.html",
    "<!doctype html><html><body><h1>Draft ownership</h1></body></html>",
  );
  await page.route("**/api/review/*/draft?*", (route) => route.abort("failed"));
  await page.goto(created.reviewUrl);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const reviewerMessage = page.getByTestId("reviewer-message");
  await reviewerMessage.fill("Unsaved note owned by this tab.");
  await page.waitForTimeout(650);

  const state = server.store.getPublicState(created.id);
  if (!state) throw new Error("Draft ownership test session is missing.");
  const access = new URL(created.reviewUrl).searchParams.get("access");
  if (!access) throw new Error("Draft ownership test access token is missing.");
  const response = await fetch(
    `${server.origin}/api/review/${encodeURIComponent(created.id)}/draft?access=${encodeURIComponent(access)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: { message: "Remote tab draft.", annotations: [] },
        baseRevision: state.revision,
        baseContentHash: state.contentHash,
        clientId: "remote-e2e-reviewer",
      }),
    },
  );
  expect(response.status).toBe(200);
  await expect.poll(() => server?.store.getPublicState(created.id)?.draft.message).toBe("Remote tab draft.");
  await page.waitForTimeout(250);
  await expect(reviewerMessage).toHaveValue("Unsaved note owned by this tab.");
});

test("explains the bounded exact-text selection contract without selecting the containing element", async ({ page }) => {
  const created = await createBrowserSession(
    "bounded-selection.html",
    `<!doctype html><html><body><p>${"x".repeat(1_201)}</p></body></html>`,
  );
  await page.goto(created.reviewUrl);
  await page.getByRole("button", { name: "Annotate" }).click();
  const artifact = page.frameLocator('[data-testid="artifact-frame"]');
  await artifact.locator("p").evaluate((paragraph) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection?.removeAllRanges();
    selection?.addRange(range);
    paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  await expect(page.getByRole("alert")).toContainText("limited to 1,200 characters");
  await expect(page.getByRole("alert")).toContainText("annotate its containing element");
  await expect(page.getByTestId("selection-card")).toHaveCount(0);
});

test("keeps annotation guidance transparent to artifact pointer input", async ({ page }) => {
  const created = await createBrowserSession(
    "selection-hint-hit-test.html",
    `<!doctype html><html><head><style>body{margin:0}h1{margin:24px 0;text-align:center;width:100%}</style></head>
    <body><h1>Selectable beneath guidance</h1></body></html>`,
  );
  await page.setViewportSize({ width: 1_280, height: 720 });
  await page.goto(created.reviewUrl);
  const artifact = page.frameLocator('[data-testid="artifact-frame"]');
  const heading = artifact.getByRole("heading", { name: "Selectable beneath guidance" });
  await expect(heading).toBeVisible();
  await page.getByRole("button", { name: "Annotate" }).click();
  await heading.hover();
  await expect(page.locator(".bridge-overlay-hover")).toBeVisible();
  await heading.click();
  await expect(page.getByTestId("selection-card")).toContainText("Selectable beneath guidance");
});

test("bounds an unresponsive acknowledgement inside the renewed delivery lease", async () => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const relativeArtifactPath = "bounded-acknowledgement.html";
  await writeFile(
    join(rootPath, relativeArtifactPath),
    "<!doctype html><html><body><h1>Bound acknowledgement attempts</h1></body></html>",
  );
  const daemonMetadataPath = join(rootPath, ".agent-html-render", "daemon.json");
  const originalMetadata = await readFile(daemonMetadataPath, "utf8");
  let heldAcknowledgements = 0;
  const proxy = createServer((request, response) => {
    if (request.method === "POST" && request.url?.endsWith("/ack")) {
      heldAcknowledgements += 1;
      request.resume();
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: server?.port,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${server?.port ?? 0}` },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.once("error", (error) => response.destroy(error));
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise<void>((resolvePromise, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const proxyAddress = proxy.address() as AddressInfo;
  const metadata = JSON.parse(originalMetadata) as Record<string, unknown>;
  metadata.port = proxyAddress.port;
  await writeFile(daemonMetadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });

  let review: ReviewRun | undefined;
  try {
    review = launchReview(relativeArtifactPath, 12_000);
    await review.ready;
    const session = server.store.list().find(
      (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
    );
    if (!session) throw new Error("The bounded-acknowledgement review session was not created.");
    const send = await fetch(
      `${server.origin}/api/review/${encodeURIComponent(session.id)}/send?access=${encodeURIComponent(session.secret)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft: { message: "Do not hang beyond the exact delivery grant.", annotations: [] },
          end: true,
          baseRevision: session.revision,
          baseContentHash: session.contentHash,
          submissionId: "bounded-acknowledgement",
        }),
      },
    );
    expect(send.status, await send.text()).toBe(200);

    const acknowledgementStartedAt = Date.now();
    let failure: Error | undefined;
    try {
      await review.completion;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    expect(Date.now() - acknowledgementStartedAt).toBeLessThan(10_000);
    expect(heldAcknowledgements).toBe(3);
    expect(failure?.message).toContain("acknowledgement could not be confirmed after 3 attempts");
    expect(JSON.parse(review.stdout())).toMatchObject({
      sequence: 1,
      feedback: { reviewerMessage: "Do not hang beyond the exact delivery grant." },
    });
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(0);
    expect(server.store.leaseNextUndelivered(session.id, 0, "premature-ack-successor").delivery)
      .toBeUndefined();

    const activeStore = server.store;
    const replacement = withMockedNow(Date.now() + FEEDBACK_LEASE_MILLISECONDS + 1, () =>
      activeStore.leaseNextUndelivered(session.id, 0, "post-ack-expiry-successor"));
    expect(replacement.delivery?.sequence).toBe(1);
    if (!replacement.delivery) throw new Error("Unacknowledged feedback did not remain queued.");
    await server.store.markDelivered(
      session.id,
      replacement.delivery.sequence,
      "post-ack-expiry-successor",
      replacement.leaseId,
    );
  } finally {
    if (review?.child.exitCode === null && review.child.signalCode === null) review.child.kill("SIGKILL");
    await writeFile(daemonMetadataPath, originalMetadata, { mode: 0o600 });
    proxy.closeAllConnections();
    await new Promise<void>((resolvePromise) => proxy.close(() => resolvePromise()));
  }
});

test("exits successfully when an acknowledgement commits but its response never finishes", async ({ page }) => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const relativeArtifactPath = "ack-response-loss.html";
  await writeFile(
    join(rootPath, relativeArtifactPath),
    "<!doctype html><html><body><h1>Acknowledgement response loss</h1></body></html>",
  );
  let droppedAcknowledgements = 0;
  const proxy = createServer((request, response) => {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: server?.port,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${server?.port ?? 0}` },
      },
      (upstreamResponse) => {
        const dropAcknowledgement =
          droppedAcknowledgements === 0 &&
          request.method === "POST" &&
          Boolean(request.url?.endsWith("/ack"));
        if (dropAcknowledgement) {
          droppedAcknowledgements += 1;
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          response.flushHeaders();
          upstreamResponse.resume();
          return;
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.once("error", (error) => response.destroy(error));
    request.pipe(upstream);
  });
  await new Promise<void>((resolvePromise, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const proxyAddress = proxy.address() as AddressInfo;
  const writeDaemonMetadata = async (port: number): Promise<void> => {
    await writeFile(
      join(rootPath, ".agent-html-render", "daemon.json"),
      `${JSON.stringify({
        protocolVersion: "1",
        pid: process.pid,
        rootPath,
        rootDevice: server?.rootDevice,
        rootInode: server?.rootInode,
        stateDevice: server?.stateDevice,
        stateInode: server?.stateInode,
        startupCoordinatorId: coordinatorRelease?.ownerId,
        packageVersion: server?.packageVersion,
        buildId: server?.buildId,
        port,
        token: "e2e-agent-token",
        startedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
  };

  try {
    await writeDaemonMetadata(proxyAddress.port);
    const review = launchReview(relativeArtifactPath);
    await review.ready;
    await expect.poll(() =>
      server?.store.list().some((candidate) => candidate.artifactRelativePath === relativeArtifactPath),
    ).toBe(true);
    const session = server.store.list().find(
      (candidate) => candidate.artifactRelativePath === relativeArtifactPath,
    );
    if (!session) throw new Error("Acknowledgement response-loss session is missing.");
    await page.goto(`${server.origin}/session/${session.id}?access=${encodeURIComponent(session.secret)}`);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByTestId("reviewer-message").fill("Acknowledge this batch exactly once.");
    await page.getByTestId("send-feedback").click();

    await expect(review.completion).resolves.toMatchObject({
      sequence: 1,
      feedback: { reviewerMessage: "Acknowledge this batch exactly once." },
    });
    expect(droppedAcknowledgements).toBe(1);
    expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(1);
  } finally {
    await writeDaemonMetadata(server.port);
    await new Promise<void>((resolvePromise) => proxy.close(() => resolvePromise()));
  }
});
