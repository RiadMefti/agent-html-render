import { acquireStartupLock } from "../../src/node/daemon.js";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";

const rootPath = process.argv[2];
if (!rootPath) throw new Error("A project root is required.");
const holdMilliseconds = Number.parseInt(process.argv[3] ?? "75", 10);
if (!Number.isSafeInteger(holdMilliseconds) || holdMilliseconds < 0 || holdMilliseconds > 5_000) {
  throw new Error("The critical-section hold must be between 0 and 5000 milliseconds.");
}

const release = await acquireStartupLock(rootPath);
const criticalPath = join(rootPath, ".agent-html-render", "startup-critical-section");
const critical = await open(criticalPath, "wx", 0o600);
try {
  await new Promise<void>((resolve) => setTimeout(resolve, holdMilliseconds));
} finally {
  await critical.close();
  await unlink(criticalPath);
  await release();
}
