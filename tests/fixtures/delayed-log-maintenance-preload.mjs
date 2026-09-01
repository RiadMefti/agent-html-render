import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { SessionStore } from "../../dist/node/store.js";

const logPath = process.env.AGENT_HTML_RENDER_TEST_LOG_PATH;
const markerPath = process.env.AGENT_HTML_RENDER_TEST_LOG_MARKER;
if (!logPath || !markerPath) {
  throw new Error("The delayed log-maintenance fixture requires log and marker paths.");
}

function optionalDelay(name) {
  const source = process.env[name];
  if (source === undefined) return undefined;
  const milliseconds = Number(source);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error(`${name} must be a non-negative integer number of milliseconds.`);
  }
  return milliseconds;
}

const logDelayMilliseconds = optionalDelay("AGENT_HTML_RENDER_TEST_LOG_DELAY_MS");
const logWaitForPath = process.env.AGENT_HTML_RENDER_TEST_LOG_WAIT_FOR;
const bumpMarkerPath = process.env.AGENT_HTML_RENDER_TEST_BUMP_MARKER;
const bumpDelayMilliseconds = optionalDelay("AGENT_HTML_RENDER_TEST_BUMP_DELAY_MS");
if ((bumpMarkerPath === undefined) !== (bumpDelayMilliseconds === undefined)) {
  throw new Error("The delayed watcher fixture requires both its marker and delay.");
}

const delay = (milliseconds) => new Promise((resolvePromise) => {
  setTimeout(resolvePromise, milliseconds);
});

async function waitForPath(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fs.promises.access(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

if (bumpMarkerPath !== undefined && bumpDelayMilliseconds !== undefined) {
  const originalBumpRevision = SessionStore.prototype.bumpRevision;
  SessionStore.prototype.bumpRevision = async function delayedWatcherRevision(...arguments_) {
    await fs.promises.writeFile(bumpMarkerPath, `${process.pid}\n`, "utf8");
    await delay(bumpDelayMilliseconds);
    return originalBumpRevision.apply(this, arguments_);
  };
}

const originalOpen = fs.promises.open.bind(fs.promises);
let delayed = false;
fs.promises.open = async (path, ...arguments_) => {
  if (!delayed && resolve(String(path)) === resolve(logPath)) {
    delayed = true;
    await fs.promises.writeFile(markerPath, `${process.pid}\n`, "utf8");
    if (logWaitForPath !== undefined) await waitForPath(logWaitForPath);
    if (logDelayMilliseconds === undefined) {
      await new Promise(() => undefined);
    } else {
      await delay(logDelayMilliseconds);
    }
  }
  return originalOpen(path, ...arguments_);
};
syncBuiltinESMExports();

const originalSetInterval = globalThis.setInterval;
let accelerated = false;
globalThis.setInterval = ((callback, milliseconds, ...arguments_) => {
  const delay = !accelerated && milliseconds === 10_000 ? 50 : milliseconds;
  if (milliseconds === 10_000) accelerated = true;
  return originalSetInterval(callback, delay, ...arguments_);
});
