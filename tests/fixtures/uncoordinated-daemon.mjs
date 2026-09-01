import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { startServer } from "../../dist/node/server.js";
import { writeDaemonMetadata } from "../../dist/node/daemon.js";

const rootPath = process.argv[2];
if (!rootPath) throw new Error("A project root is required.");
const exitDelaySource = process.env.AGENT_HTML_RENDER_TEST_EXIT_DELAY_MS;
const exitDelayMilliseconds = exitDelaySource === undefined ? 0 : Number(exitDelaySource);
if (!Number.isSafeInteger(exitDelayMilliseconds) || exitDelayMilliseconds < 0) {
  throw new Error("AGENT_HTML_RENDER_TEST_EXIT_DELAY_MS must be a non-negative integer.");
}
const startupCoordinatorId = randomBytes(24).toString("base64url");
const server = await startServer({
  rootPath: resolve(rootPath),
  startupCoordinatorId,
});
await writeDaemonMetadata({
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
  token: server.token,
  startedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify({ pid: process.pid, port: server.port })}\n`);
await server.closed;
if (exitDelayMilliseconds > 0) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, exitDelayMilliseconds));
}
