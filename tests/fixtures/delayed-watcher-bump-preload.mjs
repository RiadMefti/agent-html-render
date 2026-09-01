import { writeFile } from "node:fs/promises";
import { SessionStore } from "../../dist/node/store.js";

const markerPath = process.env.AGENT_HTML_RENDER_TEST_BUMP_MARKER;
if (!markerPath) throw new Error("The delayed watcher-bump fixture requires a marker path.");

SessionStore.prototype.bumpRevision = async function delayedWatcherRevision() {
  await writeFile(markerPath, `${process.pid}\n`, "utf8");
  await new Promise(() => undefined);
};
