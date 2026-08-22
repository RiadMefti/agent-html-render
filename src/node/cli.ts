#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import type { FeedbackDelivery } from "../shared/protocol.js";
import {
  currentDaemon,
  daemonRequest,
  ensureDaemon,
  runDaemon,
  type DaemonMetadata,
} from "./daemon.js";
import type { AgentSessionSummary } from "./server.js";
import { installProjectSkill } from "./install.js";

const VERSION = "0.2.1";
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILL_DIRECTORY = resolve(MODULE_DIRECTORY, "../../skills/agent-html-render");

interface ParsedOptions {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

function writeStdout(value: string): void {
  writeSync(process.stdout.fd, value);
}

function writeStderr(value: string): void {
  writeSync(process.stderr.fd, value);
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
  return `Agent HTML Render ${VERSION}

Usage:
  agent-html-render review <file.html> [--root <directory>] [--no-open] [--format json|markdown]
  agent-html-render status [--root <directory>]
  agent-html-render stop [--root <directory>]
  agent-html-render install-skill [--root <directory>]
  agent-html-render --help

The review command opens or resumes a local browser session, waits for the
reviewer to send feedback, prints one bounded response, and exits.`;
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
): Promise<{ session: AgentSessionSummary; cursor: number }> {
  const response = await daemonRequest(metadata, "/api/agent/sessions", {
    method: "POST",
    body: JSON.stringify({ rootPath, artifactPath }),
  });
  return responseJson(response);
}

async function waitForFeedback(
  metadata: DaemonMetadata,
  sessionId: string,
  cursor: number,
): Promise<FeedbackDelivery> {
  let currentCursor = cursor;
  for (;;) {
    const response = await daemonRequest(
      metadata,
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/wait?after=${currentCursor}`,
    );
    if (response.status === 204) continue;
    const delivery = await responseJson<FeedbackDelivery>(response);
    currentCursor = delivery.sequence;
    return delivery;
  }
}

async function review(options: ParsedOptions): Promise<void> {
  assertOptions(options, ["--root", "--format"], ["--no-open"], 1);
  const artifactInput = options.positionals[0];
  if (!artifactInput) throw new Error("review requires an HTML file path.");
  const format = options.values.get("--format") ?? "json";
  if (format !== "json" && format !== "markdown") {
    throw new Error("--format must be either json or markdown.");
  }
  const rootPath = await realpath(resolve(options.values.get("--root") ?? process.cwd()));
  const metadata = await ensureDaemon(rootPath);
  const { session, cursor } = await openSession(metadata, rootPath, artifactInput);
  writeStderr(
    `[agent-html-render] ${session.status === "open" ? "Reviewing" : "Opening"} ${session.artifactRelativePath}\n` +
      `[agent-html-render] ${session.reviewUrl}\n` +
      "[agent-html-render] Waiting for Send to Agent or Send & End…\n",
  );
  if (!options.flags.has("--no-open") && session.connectedReviewers === 0) {
    try {
      await open(session.reviewUrl, { wait: false });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      writeStderr(`[agent-html-render] Could not open a browser automatically (${reason}). Use the URL above.\n`);
    }
  }
  const delivery = await waitForFeedback(metadata, session.id, cursor);
  if (format === "markdown") {
    writeStdout(`${delivery.markdown}\n`);
  } else {
    writeStdout(`${JSON.stringify(delivery, null, 2)}\n`);
  }
}

async function status(options: ParsedOptions): Promise<void> {
  assertOptions(options, ["--root"], [], 0);
  const rootPath = await realpath(resolve(options.values.get("--root") ?? process.cwd()));
  const metadata = await currentDaemon(rootPath);
  if (!metadata) {
    writeStdout("Agent HTML Render daemon is not running.\n");
    return;
  }
  const response = await daemonRequest(metadata, "/api/agent/sessions");
  const body = await responseJson<{ sessions: AgentSessionSummary[] }>(response);
  const daemon = {
    running: true,
    protocolVersion: metadata.protocolVersion,
    pid: metadata.pid,
    rootPath: metadata.rootPath,
    port: metadata.port,
    startedAt: metadata.startedAt,
  };
  const sessions = body.sessions.map(({ reviewUrl: _reviewUrl, ...session }) => session);
  writeStdout(`${JSON.stringify({ daemon, sessions }, null, 2)}\n`);
}

async function stop(options: ParsedOptions): Promise<void> {
  assertOptions(options, ["--root"], [], 0);
  const rootPath = await realpath(resolve(options.values.get("--root") ?? process.cwd()));
  const metadata = await currentDaemon(rootPath);
  if (!metadata) {
    writeStdout("Agent HTML Render daemon is not running.\n");
    return;
  }
  const response = await daemonRequest(metadata, "/api/agent/stop", { method: "POST" });
  await responseJson(response);
  writeStdout("Agent HTML Render daemon stopped.\n");
}

async function installSkill(options: ParsedOptions): Promise<void> {
  assertOptions(options, ["--root"], [], 0);
  const rootPath = await realpath(resolve(options.values.get("--root") ?? process.cwd()));
  const result = await installProjectSkill(rootPath, BUNDLED_SKILL_DIRECTORY);
  writeStdout(
    `Agent HTML Render skill ${result.canonicalStatus} at ${result.canonicalPath}.\n` +
      `Claude Code adapter ${result.claudeStatus} at ${result.claudePath}.\n` +
      (result.legacyPaths.length > 0
        ? `Legacy AgentLens or AgentRender skill detected at ${result.legacyPaths.join(", ")}. Remove it after verifying the Agent HTML Render skill.\n`
        : ""),
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    writeStdout(`${usage()}\n`);
    return;
  }
  if (command === "--version" || command === "-v") {
    writeStdout(`${VERSION}\n`);
    return;
  }
  const options = parseOptions(rest);
  if (command === "review") await review(options);
  else if (command === "status") await status(options);
  else if (command === "stop") await stop(options);
  else if (command === "install-skill") await installSkill(options);
  else if (command === "__daemon") {
    const root = options.values.get("--root") ?? process.cwd();
    await runDaemon(root);
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeStderr(`[agent-html-render] ${message}\n`);
  process.exitCode = 1;
}
