import { acquireStartupLock } from "../../src/node/daemon.js";

const rootPath = process.argv[2];
if (!rootPath) throw new Error("A project root is required.");

await acquireStartupLock(rootPath);
process.stdout.write("ready\n");
await new Promise<never>(() => undefined);
