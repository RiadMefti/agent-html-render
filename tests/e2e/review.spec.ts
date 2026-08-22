import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer, type RunningServer } from "../../dist/node/server.js";

interface CliDelivery {
  sequence: number;
  feedback: {
    status: "feedback" | "ended";
    reviewerMessage: string;
    annotations: Array<{ comment: string }>;
  };
}

interface ReviewRun {
  ready: Promise<void>;
  completion: Promise<CliDelivery>;
}

let server: RunningServer | undefined;
let rootPath: string;
let artifactPath: string;
let artifactSource: string;

function redacted(value: string): string {
  return value.replace(/access=[^\s]+/gu, "access=[redacted]");
}

function launchReview(): ReviewRun {
  const child = spawn(
    process.execPath,
    [
      resolve("dist/node/cli.js"),
      "review",
      "plan.html",
      "--root",
      rootPath,
      "--no-open",
      "--format",
      "json",
    ],
    { cwd: rootPath, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let signalReady: (() => void) | undefined;
  const ready = new Promise<void>((resolvePromise) => {
    signalReady = resolvePromise;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.includes("Waiting for Send to Agent or Send & End")) signalReady?.();
  });
  const completion = new Promise<CliDelivery>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `Agent HTML Render CLI did not exit. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(redacted(stderr))}`,
        ),
      );
    }, 15_000);
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
  return { ready, completion };
}

test.beforeAll(async () => {
  rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-e2e-"));
  artifactPath = join(rootPath, "plan.html");
  artifactSource = await readFile(resolve("examples/plan.html"), "utf8");
  await writeFile(artifactPath, artifactSource);
  server = await startServer({ rootPath, token: "e2e-agent-token" });
  await mkdir(join(rootPath, ".agent-html-render"), { recursive: true });
  await writeFile(
    join(rootPath, ".agent-html-render", "daemon.json"),
    `${JSON.stringify({
      protocolVersion: "1",
      pid: process.pid,
      rootPath,
      port: server.port,
      token: "e2e-agent-token",
      startedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
});

test.afterAll(async () => {
  await server?.close();
});

test("completes a safe two-revision annotation loop", async ({ page }) => {
  if (!server) throw new Error("Agent HTML Render test server did not start.");
  const firstReview = launchReview();
  await firstReview.ready;
  await expect.poll(() => server?.store.list().length).toBe(1);
  const session = server.store.list()[0];
  if (!session) throw new Error("Agent HTML Render CLI did not create a review session.");
  const reviewUrl = `${server.origin}/session/${session.id}?access=${encodeURIComponent(session.secret)}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(reviewUrl);

  await expect(page.getByText("agent-html-render", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Annotate" })).toHaveClass(/active/);
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
  await page.getByRole("button", { name: "Interact" }).click();
  await artifact.getByRole("link", { name: "External test link" }).click();
  await expect(artifact.getByRole("heading", { name: "Authentication rollout" })).toBeVisible();
  await page.getByRole("button", { name: "Annotate" }).click();

  await artifact.getByRole("heading", { name: "Invite returning users" }).click();
  await expect(page.getByTestId("selection-card")).toBeVisible();
  await expect(page.getByTestId("selection-card")).toContainText("Invite returning users");
  await page.getByTestId("annotation-comment").fill("Clarify when the enrollment invitation appears.");
  await page.getByTestId("add-annotation").click();
  await expect(page.getByTestId("queued-annotation")).toContainText(
    "Clarify when the enrollment invitation appears.",
  );

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
  await expect(page.getByTestId("review-activity")).toContainText("Waiting for revision 2");
  const firstDelivery = await firstReview.completion;
  expect(firstDelivery.sequence).toBe(1);
  expect(firstDelivery.feedback.status).toBe("feedback");
  expect(firstDelivery.feedback.annotations[0]?.comment).toBe(
    "Clarify when the enrollment invitation appears.",
  );
  await expect(page.getByTestId("queued-annotation")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("review-activity")).toContainText("Agent received feedback");

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByTestId("reviewer-message").fill("Keep the revised timeline concise.");
  await page.route(
    "**/api/review/*/send?*",
    (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Delivery unavailable."}' }),
    { times: 1 },
  );
  await page.getByTestId("send-feedback").click();
  await expect(page.getByTestId("review-activity")).toContainText("Send failed");
  await expect(page.getByTestId("review-activity")).toContainText("Your notes are still here");
  await expect(page.getByTestId("reviewer-message")).toHaveValue("Keep the revised timeline concise.");

  await page.getByTestId("send-feedback").click();
  await expect(page.getByTestId("review-activity")).toContainText("Feedback queued");
  await expect(page.getByTestId("review-activity")).toContainText("Waiting for an agent review command");
  expect(server.store.get(session.id)?.deliveredFeedbackSequence).toBe(1);

  const queuedReview = launchReview();
  await queuedReview.ready;
  await expect(page.getByTestId("review-activity")).toContainText("Agent received feedback");
  const queuedDelivery = await queuedReview.completion;
  expect(queuedDelivery.sequence).toBe(2);
  expect(queuedDelivery.feedback.reviewerMessage).toBe("Keep the revised timeline concise.");

  const revisedSource = artifactSource.replace(
    "Invite returning users",
    "Invite users at the right moment",
  );
  await writeFile(artifactPath, revisedSource);
  await expect(page.getByTestId("revision")).toHaveText("r2", { timeout: 10_000 });
  await expect(page.getByTestId("review-activity")).toContainText("Revision 2 ready");
  await expect(artifact.getByRole("heading", { name: "Invite users at the right moment" })).toBeVisible();

  await page.screenshot({ path: "/tmp/agent-html-render-review-ui.png", fullPage: true });

  const finalReview = launchReview();
  await finalReview.ready;
  await page.getByTestId("reviewer-message").fill("This revision is ready to implement.");
  await page.getByTestId("send-end").click();
  await expect.poll(() => server?.store.get(session.id)?.deliveredFeedbackSequence).toBe(3);
  const finalDelivery = await finalReview.completion;
  expect(finalDelivery.sequence).toBe(3);
  expect(finalDelivery.feedback.status).toBe("ended");
  expect(finalDelivery.feedback.reviewerMessage).toBe("This revision is ready to implement.");
  await expect(page.getByRole("heading", { name: "Review complete" })).toBeVisible();
});
