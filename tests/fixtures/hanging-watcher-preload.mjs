import { EventEmitter } from "node:events";
import chokidar from "chokidar";

const artifactPath = process.env.AGENT_HTML_RENDER_TEST_WATCH_ARTIFACT;
if (!artifactPath) throw new Error("The hanging-watcher fixture requires an artifact path.");

chokidar.watch = () => {
  const watcher = new EventEmitter();
  watcher.close = () => new Promise(() => undefined);
  queueMicrotask(() => watcher.emit("error", new Error("simulated restored watcher failure")));
  setInterval(() => watcher.emit("change", artifactPath), 50);
  return watcher;
};
