import { receiveTransferredStartupCoordinator } from "../../src/node/daemon.js";

const holdMilliseconds = Number.parseInt(process.argv[2] ?? "1500", 10);
const receiveDelayMilliseconds = Number.parseInt(process.argv[3] ?? "0", 10);
if (!Number.isSafeInteger(holdMilliseconds) || holdMilliseconds < 0 || holdMilliseconds > 5_000) {
  throw new Error("The coordinator hold must be between 0 and 5000 milliseconds.");
}
if (
  !Number.isSafeInteger(receiveDelayMilliseconds) ||
  receiveDelayMilliseconds < 0 ||
  receiveDelayMilliseconds > 5_000
) throw new Error("The coordinator receive delay must be between 0 and 5000 milliseconds.");

await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, receiveDelayMilliseconds));
const release = await receiveTransferredStartupCoordinator();
await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, holdMilliseconds));
await release();
