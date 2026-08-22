import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startServer, type RunningServer } from "../../src/node/server.js";

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
