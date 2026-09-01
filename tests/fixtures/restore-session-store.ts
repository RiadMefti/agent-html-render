import { SessionStore } from "../../src/node/store.js";

const rootPath = process.argv[2];
if (!rootPath) throw new Error("The restore fixture requires a project root.");

const store = new SessionStore(rootPath);
await store.initialize();
process.stdout.write(`${JSON.stringify({ restoredSessions: store.list().length })}\n`);
