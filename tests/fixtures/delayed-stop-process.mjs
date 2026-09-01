import { createServer } from "node:http";

const delaySource = process.argv[2];
const exitDelayMilliseconds = Number(delaySource);
if (!Number.isSafeInteger(exitDelayMilliseconds) || exitDelayMilliseconds < 0) {
  throw new Error("A non-negative integer exit delay is required.");
}

const server = createServer((request, response) => {
  if (request.url === "/api/agent/stop") {
    response.statusCode = 204;
    response.end();
    setTimeout(() => {
      server.closeAllConnections();
      server.close(() => process.exit(0));
    }, exitDelayMilliseconds);
    return;
  }
  response.statusCode = 404;
  response.end();
});

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("The delayed-stop fixture did not bind a port.");
process.stdout.write(`${JSON.stringify({ pid: process.pid, port: address.port })}\n`);
