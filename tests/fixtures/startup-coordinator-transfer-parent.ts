import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  acquireStartupLock,
  STARTUP_COORDINATOR_NONCE_ENV,
} from "../../src/node/daemon.js";

const rootPath = process.argv[2];
if (!rootPath) throw new Error("A project root is required.");
const holdMilliseconds = process.argv[3] ?? "1500";
const childFixture = resolve("tests/fixtures/startup-coordinator-transfer-child.ts");
const nonce = randomBytes(32).toString("base64url");
const release = await acquireStartupLock(rootPath);
const child = spawn(process.execPath, ["--import", "tsx", childFixture, holdMilliseconds], {
  detached: true,
  stdio: ["ignore", "ignore", "ignore", "ipc"],
  env: { ...process.env, [STARTUP_COORDINATOR_NONCE_ENV]: nonce },
});
await release.transferTo(child, nonce);
child.unref();
process.stdout.write(`${child.pid ?? 0}\n`);
process.exit(0);
