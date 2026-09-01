#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import open from "open";
import {
  EXPLICIT_FEEDBACK_ACK_CAPABILITY,
  FEEDBACK_ACK_HEADER,
  type FeedbackDelivery,
} from "../shared/protocol.js";
import { PACKAGE_VERSION } from "../shared/version.js";
import {
  currentDaemon,
  DAEMON_STOP_TOTAL_TIMEOUT_SECONDS,
  daemonRequest,
  ensureDaemon,
  receiveTransferredStartupCoordinator,
  runDaemon,
  stopDaemonWithinTimeout,
  type DaemonMetadata,
  type StartupCoordinatorRelease,
} from "./daemon.js";
import {
  ServerProcessTerminationRequiredError,
  type AgentSessionSummary,
} from "./server.js";
import { installProjectSkill } from "./install.js";
import { diagnoseProject, type DoctorReport } from "./diagnostics.js";
import {
  formatTerminalStatusLine,
  terminalJson,
  visibleTerminalLineText,
  visibleTerminalText,
} from "./feedback.js";
import { ensureStateDirectory, FEEDBACK_LEASE_MILLISECONDS } from "./store.js";
import { parseLeasedFeedbackDelivery } from "./validation.js";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILL_DIRECTORY = resolve(MODULE_DIRECTORY, "../../skills/agent-html-render");
const BUNDLED_DEMO_PATH = resolve(MODULE_DIRECTORY, "../../examples/plan.html");
const ACKNOWLEDGEMENT_ATTEMPTS = 3;
const ACKNOWLEDGEMENT_ATTEMPT_TIMEOUT_MILLISECONDS = 2_000;
const FEEDBACK_LEASE_RELEASE_TIMEOUT_MILLISECONDS = 500;
const FEEDBACK_LEASE_RENEWAL_INTERVAL_MILLISECONDS = testDuration(
  "AGENT_HTML_RENDER_TEST_FEEDBACK_LEASE_RENEWAL_INTERVAL_MS",
  Math.floor(FEEDBACK_LEASE_MILLISECONDS / 3),
);
const FEEDBACK_LEASE_RENEWAL_TIMEOUT_MILLISECONDS = 2_000;
const FEEDBACK_OUTPUT_MAXIMUM_MILLISECONDS = testDuration(
  "AGENT_HTML_RENDER_TEST_FEEDBACK_OUTPUT_MAXIMUM_MS",
  120_000,
);
let detachedStartupCoordinator: StartupCoordinatorRelease | undefined;
let detachedTerminationRequired = false;

interface ParsedOptions {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

class FeedbackLeaseRenewalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FeedbackLeaseRenewalError";
  }
}

function testDuration(name: string, fallback: number): number {
  if (process.env.AGENT_HTML_RENDER_TEST_MODE !== "1") return fallback;
  const source = process.env[name];
  if (source === undefined) return fallback;
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > fallback) {
    throw new Error(`${name} must be a positive integer no greater than ${fallback}.`);
  }
  return parsed;
}

function abortSignalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The output operation was aborted before it completed.");
}

async function writeComplete(
  stream: NodeJS.WriteStream,
  value: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortSignalError(signal);
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const detachAbort = (): void => signal?.removeEventListener("abort", onAbort);
    const onError = (error: Error): void => {
      stream.off("error", onError);
      detachAbort();
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onAbort = (): void => {
      if (settled || !signal) return;
      settled = true;
      detachAbort();
      const error = abortSignalError(signal);
      reject(error);
      // Destroying a backpressured Node pipe does not reliably cancel its pending
      // kernel write. The feedback delivery path handles this rejection by
      // terminating the writer process without releasing the lease early.
    };
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      stream.write(value, "utf8", (error?: Error | null) => {
        if (settled) return;
        if (error) {
          // Writable streams may emit the same error after invoking this callback.
          // Retain the once-listener so that later event remains handled.
          settled = true;
          detachAbort();
          reject(error);
          return;
        }
        settled = true;
        stream.off("error", onError);
        detachAbort();
        resolvePromise();
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      stream.off("error", onError);
      detachAbort();
      reject(error);
    }
  });
}

async function writeStdout(value: string, signal?: AbortSignal): Promise<void> {
  try {
    await writeComplete(process.stdout, visibleTerminalText(value), signal);
  } catch (error) {
    if (error instanceof FeedbackLeaseRenewalError) throw error;
    throw standardOutputWriteError(error);
  }
}

function writeStderr(value: string): void {
  writeSync(process.stderr.fd, visibleTerminalText(value));
}

function writeStatusLine(value: string): void {
  writeStderr(formatTerminalStatusLine(value));
}

async function writeJsonStdout(value: unknown, signal?: AbortSignal): Promise<void> {
  try {
    await writeComplete(process.stdout, `${terminalJson(value)}\n`, signal);
  } catch (error) {
    if (error instanceof FeedbackLeaseRenewalError) throw error;
    throw standardOutputWriteError(error);
  }
}

function standardOutputWriteError(error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `Could not write the complete response to stdout; the downstream reader may have closed the pipe: ${reason}`,
    { cause: error },
  );
}

function parseOptions(args: string[]): ParsedOptions {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value?.startsWith("--")) {
      if (value) positionals.push(value);
      continue;
    }
    const [name, inlineValue] = value.split("=", 2);
    if (!name) continue;
    if (inlineValue !== undefined) {
      values.set(name, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith("--") && ["--root", "--format"].includes(name)) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { positionals, values, flags };
}

function assertOptions(
  options: ParsedOptions,
  allowedValues: readonly string[],
  allowedFlags: readonly string[],
  maximumPositionals: number,
): void {
  for (const name of options.values.keys()) {
    if (!allowedValues.includes(name)) throw new Error(`Unknown option: ${name}`);
  }
  for (const name of options.flags) {
    if (allowedValues.includes(name)) throw new Error(`${name} requires a value.`);
    if (!allowedFlags.includes(name)) throw new Error(`Unknown option: ${name}`);
  }
  if (options.positionals.length > maximumPositionals) throw new Error("Too many positional arguments.");
}

function usage(): string {
  return `Agent HTML Render ${PACKAGE_VERSION}

Usage:
  agent-html-render review <file.html> [--root <directory>] [--no-open] [--new] [--format json|markdown]
  agent-html-render demo [--root <directory>] [--no-open] [--format json|markdown]
  agent-html-render doctor [--root <directory>] [--format text|json]
  agent-html-render status [--root <directory>]
  agent-html-render stop [--root <directory>]
  agent-html-render install-skill [--root <directory>]
  agent-html-render --help

The review command opens or resumes a local browser session, waits for the
reviewer to send feedback, prints one feedback batch, and exits.`;
}

function formatDoctorReport(report: DoctorReport): string {
  const mark = (value: boolean): string => (value ? "ok" : "needs attention");
  const lines = [
    "Agent HTML Render doctor",
    "",
    `Node ${report.node.version}: ${mark(report.node.supported)}`,
    `Platform ${report.platform.name}: ${mark(report.platform.supported)}`,
    `Project writable: ${mark(report.project.writable)}`,
    `Daemon: ${report.daemon.running ? (report.daemon.compatible ? "running, current runtime and state" : "running, replacement required") : report.daemon.processAlive ? "unhealthy recorded process still alive" : report.daemon.recorded ? "stale state; replacement needed" : "not running"}`,
    `Shared skill: ${report.skills.canonicalInstalled ? "installed" : "not installed"}`,
    `Claude adapter: ${report.skills.claudeInstalled ? "installed" : "not installed"}`,
    `Agent CLIs: codex=${report.hosts.codex ? "yes" : "no"}, claude=${report.hosts.claude ? "yes" : "no"}, opencode=${report.hosts.opencode ? "yes" : "no"}`,
    `State boundary: ${mark(report.state.validBoundary)}`,
    `Startup coordinator: ${report.state.startupCoordinator.status}`,
    `Startup lock: ${report.state.startupLock.status}`,
    `Agent integration: ${mark(report.agentIntegrationReady)}`,
    `Private state: ${report.state.directory}`,
    `Daemon log: ${report.state.logPath}`,
  ];
  if (report.recommendations.length > 0) {
    lines.push("", "Recommendations:", ...report.recommendations.map((recommendation) => `- ${recommendation}`));
  }
  return `${lines.map(visibleTerminalLineText).join("\n")}\n`;
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({ error: response.statusText }))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Agent HTML Render request failed with HTTP ${response.status}.`);
  return body;
}

async function openSession(
  metadata: DaemonMetadata,
  rootPath: string,
  artifactPath: string,
  newSession: boolean,
): Promise<{
  session: AgentSessionSummary;
  cursor: number;
  artifactAvailable?: boolean;
  warning?: string;
}> {
  const response = await daemonRequest(metadata, "/api/agent/sessions", {
    method: "POST",
    body: JSON.stringify({ rootPath, artifactPath, newSession }),
  });
  return responseJson(response);
}

async function waitForFeedback(
  metadata: DaemonMetadata,
  sessionId: string,
  cursor: number,
  consumerId: string,
): Promise<{ delivery: FeedbackDelivery; leaseId: string }> {
  let currentCursor = cursor;
  for (;;) {
    const response = await daemonRequest(
      metadata,
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/wait?after=${currentCursor}&consumer=${encodeURIComponent(consumerId)}`,
      { headers: { [FEEDBACK_ACK_HEADER]: EXPLICIT_FEEDBACK_ACK_CAPABILITY } },
    );
    if (response.status === 204) continue;
    const leased = parseLeasedFeedbackDelivery(await responseJson<unknown>(response));
    const { delivery } = leased;
    currentCursor = delivery.sequence;
    return leased;
  }
}

async function acknowledgeFeedback(
  metadata: DaemonMetadata,
  sessionId: string,
  sequence: number,
  consumerId: string,
  leaseId: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ACKNOWLEDGEMENT_ATTEMPTS; attempt += 1) {
    try {
      const response = await daemonRequest(metadata, `/api/agent/sessions/${encodeURIComponent(sessionId)}/ack`, {
        method: "POST",
        body: JSON.stringify({ sequence, consumerId, leaseId }),
        signal: AbortSignal.timeout(ACKNOWLEDGEMENT_ATTEMPT_TIMEOUT_MILLISECONDS),
      });
      await responseJson(response);
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < ACKNOWLEDGEMENT_ATTEMPTS) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100 * (attempt + 1)));
      }
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Feedback ${sequence} was printed, but its acknowledgement could not be confirmed after ${ACKNOWLEDGEMENT_ATTEMPTS} attempts: ${reason}`,
  );
}

function terminateUnsafeFeedbackWriter(sequence: number, error: FeedbackLeaseRenewalError): never {
  const reason = error.message;
  try {
    writeStatusLine(
      `Feedback ${sequence} could not be written completely and was not acknowledged. ` +
        "This command can no longer prove that it exclusively owns the delivery while stdout is pending, " +
        "so it is terminating immediately without releasing the lease early. The operating system will " +
        `close the pending writer, and the durably queued feedback may remain unavailable for up to ${FEEDBACK_LEASE_MILLISECONDS / 1_000} seconds: ${reason}`,
    );
  } finally {
    process.exit(1);
  }
}

async function renewFeedbackLease(
  metadata: DaemonMetadata,
  sessionId: string,
  sequence: number,
  consumerId: string,
  leaseId: string,
): Promise<void> {
  try {
    const response = await daemonRequest(
      metadata,
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/renew-lease`,
      {
        method: "POST",
        body: JSON.stringify({ sequence, consumerId, leaseId }),
        signal: AbortSignal.timeout(FEEDBACK_LEASE_RENEWAL_TIMEOUT_MILLISECONDS),
      },
    );
    const body = await responseJson<{ renewed?: unknown; expiresAt?: unknown }>(response);
    if (body.renewed !== true) {
      throw new FeedbackLeaseRenewalError(
        "The daemon no longer recognizes this command's exact feedback delivery lease.",
      );
    }
    if (!Number.isSafeInteger(body.expiresAt) || (body.expiresAt as number) <= 0) {
      throw new FeedbackLeaseRenewalError("The daemon returned an invalid feedback lease-renewal response.");
    }
  } catch (error) {
    if (error instanceof FeedbackLeaseRenewalError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new FeedbackLeaseRenewalError(`The feedback delivery lease could not be renewed: ${reason}`, {
      cause: error,
    });
  }
}

function startFeedbackLeaseRenewal(
  metadata: DaemonMetadata,
  sessionId: string,
  sequence: number,
  consumerId: string,
  leaseId: string,
): { signal: AbortSignal; stop: () => Promise<void> } {
  const stopController = new AbortController();
  const failureController = new AbortController();
  const maximumTimer = setTimeout(() => {
    failureController.abort(
      new FeedbackLeaseRenewalError(
        `Feedback output did not complete within the bounded ${FEEDBACK_OUTPUT_MAXIMUM_MILLISECONDS / 1_000}-second delivery window.`,
      ),
    );
    stopController.abort();
  }, FEEDBACK_OUTPUT_MAXIMUM_MILLISECONDS);
  maximumTimer.unref();
  const completed = (async () => {
    for (;;) {
      try {
        await wait(FEEDBACK_LEASE_RENEWAL_INTERVAL_MILLISECONDS, undefined, {
          signal: stopController.signal,
        });
      } catch {
        if (stopController.signal.aborted) return;
        failureController.abort(
          new FeedbackLeaseRenewalError("The feedback lease-renewal timer failed unexpectedly."),
        );
        return;
      }
      if (stopController.signal.aborted) return;
      try {
        await renewFeedbackLease(metadata, sessionId, sequence, consumerId, leaseId);
      } catch (error) {
        failureController.abort(
          error instanceof FeedbackLeaseRenewalError
            ? error
            : new FeedbackLeaseRenewalError("The feedback delivery lease could not be renewed.", {
                cause: error,
              }),
        );
        return;
      }
    }
  })();
  return {
    signal: failureController.signal,
    stop: async () => {
      clearTimeout(maximumTimer);
      stopController.abort();
      await completed;
      if (failureController.signal.aborted) throw abortSignalError(failureController.signal);
    },
  };
}

async function releaseFeedbackLease(
  metadata: DaemonMetadata,
  sessionId: string,
  sequence: number,
  consumerId: string,
  leaseId: string,
): Promise<boolean> {
  const response = await daemonRequest(
    metadata,
    `/api/agent/sessions/${encodeURIComponent(sessionId)}/release-lease`,
    {
      method: "POST",
      body: JSON.stringify({ sequence, consumerId, leaseId }),
      signal: AbortSignal.timeout(FEEDBACK_LEASE_RELEASE_TIMEOUT_MILLISECONDS),
    },
  );
  const body = await responseJson<{ released?: unknown }>(response);
  if (typeof body.released !== "boolean") {
    throw new Error("The daemon returned an invalid feedback lease-release response.");
  }
  return body.released;
}

async function review(options: ParsedOptions): Promise<void> {
  assertOptions(options, ["--root", "--format"], ["--no-open", "--new"], 1);
  const artifactInput = options.positionals[0];
  if (!artifactInput) throw new Error("review requires an HTML file path.");
  const format = options.values.get("--format") ?? "json";
  if (format !== "json" && format !== "markdown") {
    throw new Error("--format must be either json or markdown.");
  }
  const rootPath = await realpath(resolve(options.values.get("--root") ?? process.cwd()));
  const metadata = await ensureDaemon(rootPath);
  const { session, cursor, artifactAvailable = true, warning } = await openSession(
    metadata,
    rootPath,
    artifactInput,
    options.flags.has("--new"),
  );
  if (artifactAvailable) {
    writeStatusLine(`${session.status === "open" ? "Reviewing" : "Opening"} ${session.artifactRelativePath}`);
    writeStatusLine(session.reviewUrl);
    if (warning) writeStatusLine(warning);
    writeStatusLine("Waiting for Send to Agent or Send & End…");
  } else {
    writeStatusLine(`Recovering feedback for ${session.artifactRelativePath}`);
    writeStatusLine(
      warning ?? "The original artifact is unavailable; only committed feedback will be delivered.",
    );
  }
  if (
    artifactAvailable &&
    !options.flags.has("--no-open") &&
    session.status === "open" &&
    session.connectedReviewers === 0
  ) {
    try {
      await open(session.reviewUrl, { wait: false });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      writeStatusLine(`Could not open a browser automatically (${reason}). Use the URL above.`);
    }
  }
  const consumerId = randomUUID();
  const { delivery, leaseId } = await waitForFeedback(metadata, session.id, cursor, consumerId);
  const renewal = startFeedbackLeaseRenewal(
    metadata,
    session.id,
    delivery.sequence,
    consumerId,
    leaseId,
  );
  let outputCompleted = false;
  let deliveryError: unknown;
  try {
    if (format === "markdown") {
      await writeStdout(`${delivery.markdown}\n`, renewal.signal);
    } else {
      await writeJsonStdout(delivery, renewal.signal);
    }
    outputCompleted = true;
    await renewal.stop();
    // Refresh once more after the writer drains so the exact grant remains
    // exclusive across the immediate acknowledgement handoff.
    await renewFeedbackLease(metadata, session.id, delivery.sequence, consumerId, leaseId);
  } catch (error) {
    deliveryError = error;
    if (!outputCompleted && deliveryError instanceof FeedbackLeaseRenewalError) {
      terminateUnsafeFeedbackWriter(delivery.sequence, deliveryError);
    }
    try {
      await renewal.stop();
    } catch (renewalError) {
      if (!(deliveryError instanceof FeedbackLeaseRenewalError)) deliveryError = renewalError;
    }
    if (!outputCompleted && deliveryError instanceof FeedbackLeaseRenewalError) {
      terminateUnsafeFeedbackWriter(delivery.sequence, deliveryError);
    }
  }
  if (deliveryError !== undefined) {
    const reason = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
    if (outputCompleted) {
      throw new Error(
        `Feedback ${delivery.sequence} was written completely, but its exclusive delivery lease could not be retained before acknowledgement. It was not acknowledged by this command, and the lease was left to expire for up to ${FEEDBACK_LEASE_MILLISECONDS / 1_000} seconds to reduce duplicate retries: ${reason}`,
        { cause: deliveryError },
      );
    }
    let releaseOutcome: string;
    try {
      const released = await releaseFeedbackLease(
        metadata,
        session.id,
        delivery.sequence,
        consumerId,
        leaseId,
      );
      releaseOutcome = released
        ? "Its exact delivery lease was released, making the queued batch available for immediate retry."
        : `Its delivery lease was no longer current and could not be released. This command did not advance the durable cursor; pending feedback may remain unavailable until the active ${FEEDBACK_LEASE_MILLISECONDS / 1_000}-second lease expires.`;
    } catch (releaseError) {
      const releaseReason = releaseError instanceof Error ? releaseError.message : String(releaseError);
      releaseOutcome = `Its exact delivery lease release could not be confirmed within ${FEEDBACK_LEASE_RELEASE_TIMEOUT_MILLISECONDS} ms (${releaseReason}). This command did not advance the durable cursor; pending feedback may remain unavailable for up to ${FEEDBACK_LEASE_MILLISECONDS / 1_000} seconds.`;
    }
    throw new Error(
      `Feedback ${delivery.sequence} could not be written completely and was not acknowledged by this command. It remains durably queued for retry: ${reason}. ${releaseOutcome}`,
      { cause: deliveryError },
    );
  }
  await acknowledgeFeedback(metadata, session.id, delivery.sequence, consumerId, leaseId);
}

async function demo(options: ParsedOptions): Promise<void> {
  assertOptions(options, ["--root", "--format"], ["--no-open"], 0);
  const rootPath = await realpath(resolve(options.values.get("--root") ?? process.cwd()));
  const stateDirectory = join(rootPath, ".agent-html-render");
  const demoPath = join(stateDirectory, "demo-plan.html");
  await ensureStateDirectory(rootPath);
  try {
    await writeFile(demoPath, await readFile(BUNDLED_DEMO_PATH), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await review({
    positionals: [demoPath],
    values: new Map(options.values),
    flags: new Set([...options.flags, "--new"]),
  });
  writeStatusLine("Demo complete. Run agent-html-render install-skill to let coding agents start this loop.");
}

async function doctor(options: ParsedOptions): Promise<void> {
  assertOptions(options, ["--root", "--format"], [], 0);
  const format = options.values.get("--format") ?? "text";
  if (format !== "text" && format !== "json") throw new Error("--format must be either text or json.");
  const rootPath = await realpath(resolve(options.values.get("--root") ?? process.cwd()));
  const report = await diagnoseProject(rootPath);
  if (format === "json") await writeJsonStdout(report);
  else await writeStdout(formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function status(options: ParsedOptions): Promise<void> {
  assertOptions(options, ["--root"], [], 0);
  const rootPath = await realpath(resolve(options.values.get("--root") ?? process.cwd()));
  const metadata = await currentDaemon(rootPath);
  if (!metadata) {
    await writeStdout("Agent HTML Render daemon is not running.\n");
    return;
  }
  const response = await daemonRequest(metadata, "/api/agent/sessions");
  const body = await responseJson<{ sessions: AgentSessionSummary[] }>(response);
  const daemon = {
    running: true,
    protocolVersion: metadata.protocolVersion,
    packageVersion: metadata.packageVersion,
    buildId: metadata.buildId,
    pid: metadata.pid,
    rootPath: metadata.rootPath,
    port: metadata.port,
    startedAt: metadata.startedAt,
  };
  const sessions = body.sessions.map(({ reviewUrl: _reviewUrl, ...session }) => session);
  await writeJsonStdout({ daemon, sessions });
}

async function stop(options: ParsedOptions): Promise<void> {
  assertOptions(options, ["--root"], [], 0);
  const rootPath = await realpath(resolve(options.values.get("--root") ?? process.cwd()));
  const metadata = await currentDaemon(rootPath);
  if (!metadata) {
    await writeStdout("Agent HTML Render daemon is not running.\n");
    return;
  }
  if (!(await stopDaemonWithinTimeout(metadata))) {
    throw new Error(
      `The Agent HTML Render daemon (process ${metadata.pid}) did not stop within ${DAEMON_STOP_TOTAL_TIMEOUT_SECONDS} seconds.`,
    );
  }
  await writeStdout("Agent HTML Render daemon stopped.\n");
}

async function installSkill(options: ParsedOptions): Promise<void> {
  assertOptions(options, ["--root"], [], 0);
  const rootPath = await realpath(resolve(options.values.get("--root") ?? process.cwd()));
  const result = await installProjectSkill(rootPath, BUNDLED_SKILL_DIRECTORY);
  const lines = [
    `Agent HTML Render skill ${result.canonicalStatus} at ${result.canonicalPath}.`,
    `Claude Code adapter ${result.claudeStatus} at ${result.claudePath}.`,
  ];
  if (result.legacyPaths.length > 0) {
    lines.push(
      `Legacy AgentLens or AgentRender skill detected at ${result.legacyPaths.join(", ")}. Remove it after verifying the Agent HTML Render skill.`,
    );
  }
  lines.push(...result.warnings.map((warning) => `Warning: ${warning}`));
  await writeStdout(`${lines.map(visibleTerminalLineText).join("\n")}\n`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    await writeStdout(`${usage()}\n`);
    return;
  }
  if (command === "--version" || command === "-v") {
    await writeStdout(`${PACKAGE_VERSION}\n`);
    return;
  }
  const options = parseOptions(rest);
  if (command === "review") await review(options);
  else if (command === "demo") await demo(options);
  else if (command === "doctor") await doctor(options);
  else if (command === "status") await status(options);
  else if (command === "stop") await stop(options);
  else if (command === "install-skill") await installSkill(options);
  else if (command === "__daemon") {
    const root = options.values.get("--root") ?? process.cwd();
    const startupCoordinator = await receiveTransferredStartupCoordinator();
    detachedStartupCoordinator = startupCoordinator;
    try {
      const server = await runDaemon(root, startupCoordinator.ownerId);
      if (!(await server.closed)) {
        throw new ServerProcessTerminationRequiredError(
          "Filesystem cleanup did not complete; terminating the daemon before lifetime ownership is released.",
        );
      }
    } catch (error) {
      if (error instanceof ServerProcessTerminationRequiredError) {
        detachedTerminationRequired = true;
      }
      throw error;
    }
  } else {
    writeStatusLine(`Unknown command: ${command}`);
    writeStderr(`\n${usage()}\n`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeStatusLine(message);
  process.exitCode = 1;
} finally {
  if (process.env.AGENT_HTML_RENDER_DAEMON === "1" && process.argv[2] === "__daemon") {
    if (detachedTerminationRequired) {
      // The kernel releases the lifetime coordinator as this process exits. Do not
      // open a successor window while a timed-out filesystem handle can still run.
      process.exit(typeof process.exitCode === "number" ? process.exitCode : 1);
    }
    try {
      await detachedStartupCoordinator?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeStatusLine(`Could not release startup ownership cleanly: ${message}`);
      process.exitCode = 1;
    }
  }
}
