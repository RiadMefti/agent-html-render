import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ChangeReviewDecision,
  FeedbackDelivery,
  FeedbackHistoryEntry,
  FeedbackReceipt,
  PublicSessionState,
  ReviewDraft,
  ReviewEvent,
  SessionStatus,
} from "../shared/protocol.js";
import {
  assertFeedbackConsumerId,
  assertFeedbackLeaseId,
  PROTOCOL_VERSION,
} from "../shared/protocol.js";
import { resolveRoot, validateArtifactPath } from "./artifact.js";
import { createFeedbackEnvelope, formatFeedbackMarkdown } from "./feedback.js";
import {
  assertPinnedDirectories,
  assertPinnedDirectory,
  pinDirectoryIdentity,
  type PinnedDirectoryIdentity,
  type PinnedStateBoundary,
} from "./state-boundary.js";
import { persistedSessionSchema } from "./validation.js";

export const STATE_GITIGNORE = [
  "/daemon.json",
  "/daemon.json.tmp",
  "/daemon.json.*.tmp",
  "/daemon.lock",
  "/daemon.lock.retired-*",
  "/daemon.log",
  "/skill-backups/",
  "/sessions/",
  "/demo-plan.html",
  "/.gitignore",
].join("\n") + "\n";

export const MAX_FEEDBACK_EVENTS = 50;
export const MAX_SUBMISSION_RECORDS = 2_048;
export const FEEDBACK_LEASE_MILLISECONDS = 30_000;
export const MAX_RETAINED_ENDED_SESSIONS = 50;
export const ENDED_SESSION_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_SESSION_RESTORE_FILES = 2_048;
export const MAX_SESSION_RESTORE_BYTES = 256 * 1024 * 1024;
const MAX_REVIEWER_MESSAGE_LENGTH = 8_000;
const MAX_REQUEUED_MESSAGE_SOURCES = 50;
const MAX_FEEDBACK_MARKDOWN_LENGTH = 1_000_000;
export const MAX_SESSION_STATE_BYTES = 128 * 1024 * 1024;
const SESSION_RESTORE_CONCURRENCY = 8;
const SESSION_DIRECTORY_NON_STATE_ENTRY_ALLOWANCE = 64;

function assertFeedbackCursor(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Feedback delivery requires a non-negative integer cursor.");
  }
}

function assertFeedbackSequence(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Feedback delivery requires a positive integer sequence.");
  }
}

function assertFeedbackLeaseTimestamp(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(value + FEEDBACK_LEASE_MILLISECONDS)
  ) {
    throw new Error(
      "Feedback delivery requires a non-negative integer lease timestamp that can be safely extended by the lease TTL.",
    );
  }
}

function assertNoCallerSuppliedLeaseClock(actualArguments: number, expectedArguments: number): void {
  if (actualArguments > expectedArguments) {
    throw new Error(
      "Feedback lease operations use the store clock and do not accept caller-supplied timestamps or extra arguments.",
    );
  }
}

class SessionStateBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStateBoundaryError";
  }
}

export class SessionStateSizeError extends Error {
  constructor(
    readonly size: number,
    readonly maximum: number,
  ) {
    super(
      `The persisted review session is ${size} bytes and exceeds the bounded state-file limit of ${maximum} bytes. End or split this review before restarting Agent HTML Render.`,
    );
    this.name = "SessionStateSizeError";
  }
}

export class SessionStateRestoreLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStateRestoreLimitError";
  }
}

export class SessionStoreProcessTerminationRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionStoreProcessTerminationRequiredError";
  }
}

export interface SubmissionRecord {
  submissionId: string;
  requestDigest: string;
  receipt: FeedbackReceipt;
}

interface FeedbackLease {
  sequence: number;
  consumerId: string;
  leaseId: string;
  expiresAt: number;
  acknowledging: boolean;
}

export interface DeliveryAcknowledgement {
  sequence: number;
  grantDigest: string;
}

export type FeedbackLeaseResult =
  | { delivery: FeedbackDelivery; leaseId: string; retryAt: number }
  | { delivery?: undefined; leaseId?: undefined; retryAt?: number };

export interface SessionStoreOptions {
  synchronizeDirectory?: (directory: string) => Promise<void>;
  maxSessionStateBytes?: number;
  maxSessionRestoreFiles?: number;
  maxSessionRestoreBytes?: number;
  expectedStateBoundary?: PinnedStateBoundary;
}

interface PinnedSessionStorageBoundary {
  root: PinnedDirectoryIdentity;
  state: PinnedDirectoryIdentity;
  sessions: PinnedDirectoryIdentity;
}

export interface SessionStorageIdentityInspection {
  current: boolean;
  stateDevice: string;
  stateInode: string;
  sessionsDevice: string;
  sessionsInode: string;
}

async function synchronizeDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function mapWithConcurrency<Value, Result>(
  values: readonly Value[],
  concurrency: number,
  work: (value: Value, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await work(values[index] as Value, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  if (failed) throw failure;
  return results;
}

async function requireRegularSingleLinkOrMissing(path: string, description: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) {
      throw new Error(`${description} must be a regular file with one filesystem link.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicReplaceRegularFile(
  directory: string,
  target: string,
  snapshot: string,
  description: string,
  assertBoundary?: () => Promise<void>,
  onCommit?: () => void,
): Promise<void> {
  const temporary = join(
    directory,
    `.${basename(target)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let temporaryCreated = false;
  try {
    await assertBoundary?.();
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    temporaryCreated = true;
    try {
      await assertBoundary?.();
      const [opened, current] = await Promise.all([handle.stat(), lstat(temporary)]);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1 ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      ) throw new Error(`${description} temporary file changed before it was written.`);
      await assertBoundary?.();
      await handle.writeFile(snapshot, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertBoundary?.();
    await requireRegularSingleLinkOrMissing(target, description);
    await assertBoundary?.();
    await rename(temporary, target);
    temporaryCreated = false;
    onCommit?.();
    await assertBoundary?.();
  } finally {
    if (temporaryCreated) {
      try {
        await assertBoundary?.();
        await unlink(temporary);
      } catch {
        // Never redirect cleanup into a replacement state directory.
      }
    }
  }
}

async function readPrivateSessionFile(
  path: string,
  maximumBytes = MAX_SESSION_STATE_BYTES,
  assertBoundary?: () => Promise<void>,
): Promise<{ source: string; size: number }> {
  const description = `The persisted review session ${path}`;
  await assertBoundary?.();
  const pathDetails = await lstat(path);
  if (pathDetails.isSymbolicLink() || !pathDetails.isFile() || pathDetails.nlink !== 1) {
    throw new SessionStateBoundaryError(
      `${description} must be a regular file with one filesystem link. Move the unexpected entry aside before restarting Agent HTML Render.`,
    );
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new SessionStateBoundaryError(`${description} could not be opened without following links: ${String(error)}`);
  }
  try {
    await assertBoundary?.();
    let opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new SessionStateBoundaryError(`${description} must remain a single-link regular file.`);
    }
    if (opened.size > maximumBytes) {
      throw new SessionStateSizeError(opened.size, maximumBytes);
    }
    if ((opened.mode & 0o777) !== 0o600) {
      try {
        await assertBoundary?.();
        await handle.chmod(0o600);
        opened = await handle.stat();
      } catch (error) {
        throw new SessionStateBoundaryError(`${description} could not be restricted to mode 0600: ${String(error)}`);
      }
    }
    const source = await handle.readFile("utf8");
    await assertBoundary?.();
    const [completed, currentPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !completed.isFile() ||
      completed.nlink !== 1 ||
      (completed.mode & 0o777) !== 0o600 ||
      currentPath.isSymbolicLink() ||
      !currentPath.isFile() ||
      currentPath.nlink !== 1 ||
      (currentPath.mode & 0o777) !== 0o600 ||
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.size !== opened.size ||
      completed.mtimeMs !== opened.mtimeMs ||
      completed.ctimeMs !== opened.ctimeMs ||
      currentPath.dev !== opened.dev ||
      currentPath.ino !== opened.ino
    ) {
      throw new SessionStateBoundaryError(`${description} changed while it was being restored.`);
    }
    return { source, size: opened.size };
  } finally {
    await handle.close();
  }
}

export async function ensureStateGitignore(
  stateDirectory: string,
  assertBoundary?: () => Promise<void>,
): Promise<void> {
  const path = join(stateDirectory, ".gitignore");
  let existing = "";
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) {
      throw new Error("The .agent-html-render/.gitignore path must be a regular file with one filesystem link.");
    }
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const existingRules = new Set(
    existing
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missingRules = STATE_GITIGNORE.trim().split("\n").filter((rule) => !existingRules.has(rule));
  if (missingRules.length === 0) return;
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  await atomicReplaceRegularFile(
    stateDirectory,
    path,
    `${existing}${separator}${missingRules.join("\n")}\n`,
    "The .agent-html-render/.gitignore path",
    assertBoundary,
  );
  await assertBoundary?.();
  await synchronizeDirectory(stateDirectory);
}

export async function ensureStateDirectory(
  rootPath: string,
  expectedRoot?: PinnedDirectoryIdentity,
  expectedState?: PinnedDirectoryIdentity,
): Promise<string> {
  const rootIdentity = expectedRoot ?? await pinDirectoryIdentity(rootPath, "The selected project root");
  if (rootIdentity.path !== rootPath) {
    throw new Error("The selected project root path changed before private state initialization.");
  }
  const stateDirectory = join(rootPath, ".agent-html-render");
  if (expectedState) {
    if (expectedState.path !== stateDirectory) {
      throw new Error("The pinned private-state path does not belong to the selected project root.");
    }
    await assertPinnedDirectories([
      [rootIdentity, "The selected project root"],
      [expectedState, "The .agent-html-render state directory"],
    ]);
  } else {
    await assertPinnedDirectory(rootIdentity, "The selected project root");
    await mkdir(stateDirectory, { recursive: true });
    await assertPinnedDirectory(rootIdentity, "The selected project root");
  }
  const stateIdentity = await pinDirectoryIdentity(
    stateDirectory,
    "The .agent-html-render state directory",
  );
  if (
    expectedState &&
    (stateIdentity.device !== expectedState.device || stateIdentity.inode !== expectedState.inode)
  ) throw new Error("The .agent-html-render state directory changed before private state initialization.");
  const assertBoundary = async (): Promise<void> => {
    await assertPinnedDirectories([
      [rootIdentity, "The selected project root"],
      [stateIdentity, "The .agent-html-render state directory"],
    ]);
  };
  await ensureStateGitignore(stateDirectory, assertBoundary);
  await assertBoundary();
  return stateDirectory;
}

export interface SessionRecord {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  secret: string;
  bridgeToken: string;
  rootPath: string;
  rootDevice: string;
  rootInode: string;
  parentDevice: string;
  parentInode: string;
  artifactPath: string;
  artifactRelativePath: string;
  artifactName: string;
  revision: number;
  contentHash: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  draft: ReviewDraft;
  draftBaseRevision: number;
  draftBaseContentHash: string;
  draftRecoveryRequired: boolean;
  recoveredFromSessionId?: string;
  recoverySourceDigest?: string;
  supersededBySessionId?: string;
  feedbackEvents: FeedbackDelivery[];
  feedbackDecisions: Record<string, ChangeReviewDecision>;
  feedbackMessageDecisions: Record<string, ChangeReviewDecision>;
  submissionRecords: SubmissionRecord[];
  deliveredFeedbackSequence: number;
  deliveryAcknowledgements: DeliveryAcknowledgement[];
}

export interface CreateSessionInput {
  rootPath: string;
  rootDevice?: string;
  rootInode?: string;
  parentDevice?: string;
  parentInode?: string;
  artifactPath: string;
  artifactRelativePath: string;
  contentHash: string;
  recoveredDraft?: {
    draft: ReviewDraft;
    baseRevision: number;
    baseContentHash: string;
    sourceSessionId: string;
  };
}

function emptyDraft(): ReviewDraft {
  return { message: "", requeuedMessageSequences: [], annotations: [] };
}

function cloneDraft(draft: ReviewDraft): ReviewDraft {
  return {
    message: draft.message,
    requeuedMessageSequences: [...(draft.requeuedMessageSequences ?? [])],
    annotations: structuredClone(draft.annotations),
  };
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function draftIsEmpty(draft: ReviewDraft): boolean {
  return !draft.message.trim() && draft.annotations.length === 0;
}

function recoverySourceDigest(
  draft: ReviewDraft,
  baseRevision: number,
  baseContentHash: string,
): string {
  return createHash("sha256")
    .update(canonicalJson({ draft: cloneDraft(draft), baseRevision, baseContentHash }))
    .digest("hex");
}

export class RevisionConflictError extends Error {
  constructor(
    readonly currentRevision: number,
    readonly currentContentHash: string,
  ) {
    super(`Revision changed while you were reviewing. Review revision ${currentRevision} before sending.`);
    this.name = "RevisionConflictError";
  }
}

export class SubmissionConflictError extends Error {
  constructor() {
    super("This feedback submission ID was already used with different content.");
    this.name = "SubmissionConflictError";
  }
}

function feedbackReceipt(delivery: FeedbackDelivery): FeedbackReceipt {
  return {
    sequence: delivery.sequence,
    ...(delivery.submissionId ? { submissionId: delivery.submissionId } : {}),
    status: delivery.feedback.status,
    sentAt: delivery.feedback.sentAt,
    revision: delivery.feedback.session.revision,
  };
}

function feedbackDecisionKey(sequence: number, annotationId: string): string {
  return `${sequence}:${annotationId}`;
}

function deliveryGrantDigest(sequence: number, consumerId: string, leaseId: string): string {
  return createHash("sha256")
    .update(canonicalJson({ sequence, consumerId, leaseId }))
    .digest("hex");
}

function submissionRequestDigest(
  draft: ReviewDraft,
  end: boolean,
  baseRevision: number,
  baseContentHash: string,
): string {
  return createHash("sha256")
    .update(canonicalJson({ draft: cloneDraft(draft), end, baseRevision, baseContentHash }))
    .digest("hex");
}

function annotationSourceDigest(annotation: Pick<ReviewDraft["annotations"][number], "comment">): string {
  return createHash("sha256")
    .update(canonicalJson({ comment: annotation.comment }))
    .digest("hex");
}

function removeRequeuedMessageText(message: string, original: string): string {
  const source = message.trim();
  const needle = original.trim();
  let index = source.lastIndexOf(needle);
  while (index >= 0) {
    const before = source.slice(0, index);
    const after = source.slice(index + needle.length);
    const startsAtBlock = index === 0 || before.endsWith("\n\n");
    const endsAtBlock = after.length === 0 || after.startsWith("\n\n");
    if (startsAtBlock && endsAtBlock) {
      return [before.trim(), after.trim()].filter(Boolean).join("\n\n");
    }
    if (index === 0) break;
    index = source.lastIndexOf(needle, index - 1);
  }
  return message;
}

function feedbackHistory(session: SessionRecord): FeedbackHistoryEntry[] {
  return session.feedbackEvents.map((delivery) => ({
    sequence: delivery.sequence,
    status: delivery.feedback.status,
    sentAt: delivery.feedback.sentAt,
    revision: delivery.feedback.session.revision,
    contentHash: delivery.feedback.session.contentHash,
    reviewerMessage: delivery.feedback.reviewerMessage,
    reviewerMessageDecision: delivery.feedback.reviewerMessage.trim()
      ? (session.feedbackMessageDecisions[String(delivery.sequence)] ?? "pending")
      : null,
    requeuedMessageSequences: [...delivery.feedback.requeuedMessageSequences],
    delivered: delivery.sequence <= session.deliveredFeedbackSequence,
    annotations: delivery.feedback.annotations.map((annotation) => ({
      annotation: structuredClone(annotation),
      decision: session.feedbackDecisions[feedbackDecisionKey(delivery.sequence, annotation.id)] ?? "pending",
    })),
  }));
}

function publicState(session: SessionRecord): PublicSessionState {
  const latestDelivery = session.feedbackEvents.at(-1);
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: session.id,
    artifactName: session.artifactName,
    artifactRelativePath: session.artifactRelativePath,
    revision: session.revision,
    contentHash: session.contentHash,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    bridgeToken: session.bridgeToken,
    draft: structuredClone(session.draft),
    draftBaseRevision: session.draftBaseRevision,
    draftBaseContentHash: session.draftBaseContentHash,
    draftRecoveryRequired: session.draftRecoveryRequired,
    latestFeedback: latestDelivery ? feedbackReceipt(latestDelivery) : null,
    deliveredFeedbackSequence: session.deliveredFeedbackSequence,
    feedbackHistory: feedbackHistory(session),
  };
}

export class SessionStore extends EventEmitter {
  readonly stateDirectory: string;
  readonly sessionsDirectory: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly feedbackLeases = new Map<string, FeedbackLease>();
  private readonly persistedSessionSizes = new Map<string, number>();
  private readonly synchronizeDirectory: (directory: string) => Promise<void>;
  private readonly maxSessionStateBytes: number;
  private readonly maxSessionRestoreFiles: number;
  private readonly maxSessionRestoreBytes: number;
  private readonly expectedStateBoundary: PinnedStateBoundary | undefined;
  private storageBoundary: PinnedSessionStorageBoundary | undefined;
  private storageMutationQueue = Promise.resolve();
  private persistedSessionBytes = 0;
  private terminalFailure: SessionStoreProcessTerminationRequiredError | undefined;

  constructor(readonly rootPath: string, options: SessionStoreOptions = {}) {
    super();
    this.stateDirectory = join(rootPath, ".agent-html-render");
    this.sessionsDirectory = join(this.stateDirectory, "sessions");
    this.synchronizeDirectory = options.synchronizeDirectory ?? synchronizeDirectory;
    this.maxSessionStateBytes = options.maxSessionStateBytes ?? MAX_SESSION_STATE_BYTES;
    this.maxSessionRestoreFiles = options.maxSessionRestoreFiles ?? MAX_SESSION_RESTORE_FILES;
    this.maxSessionRestoreBytes = options.maxSessionRestoreBytes ?? MAX_SESSION_RESTORE_BYTES;
    this.expectedStateBoundary = options.expectedStateBoundary;
    if (!Number.isSafeInteger(this.maxSessionStateBytes) || this.maxSessionStateBytes < 1) {
      throw new Error("The session state-file limit must be a positive safe integer number of bytes.");
    }
    if (!Number.isSafeInteger(this.maxSessionRestoreFiles) || this.maxSessionRestoreFiles < 1) {
      throw new Error("The session restore file-count limit must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.maxSessionRestoreBytes) || this.maxSessionRestoreBytes < 1) {
      throw new Error("The aggregate session restore limit must be a positive safe integer number of bytes.");
    }
  }

  async inspectStorageIdentity(): Promise<SessionStorageIdentityInspection> {
    const boundary = this.storageBoundary;
    if (!boundary) throw new Error("The private session store has not been initialized.");
    let current = true;
    try {
      await this.assertStorageIdentity();
    } catch {
      current = false;
    }
    return {
      current,
      stateDevice: boundary.state.device,
      stateInode: boundary.state.inode,
      sessionsDevice: boundary.sessions.device,
      sessionsInode: boundary.sessions.inode,
    };
  }

  async initialize(): Promise<void> {
    const selectedRoot = await resolveRoot(this.rootPath);
    const expectedBoundary = this.expectedStateBoundary;
    if (expectedBoundary && expectedBoundary.root.path !== this.rootPath) {
      throw new Error("The pinned private-state boundary belongs to another project root.");
    }
    if (expectedBoundary) await assertPinnedDirectories([
      [expectedBoundary.root, "The selected project root"],
      [expectedBoundary.state, "The .agent-html-render state directory"],
    ]);
    const rootIdentity = expectedBoundary?.root ??
      await pinDirectoryIdentity(this.rootPath, "The selected project root");
    if (
      rootIdentity.device !== selectedRoot.rootDevice ||
      rootIdentity.inode !== selectedRoot.rootInode
    ) throw new Error("The selected project root changed while private state was initialized.");
    await ensureStateDirectory(this.rootPath, rootIdentity, expectedBoundary?.state);
    const stateIdentity = await pinDirectoryIdentity(
      this.stateDirectory,
      "The .agent-html-render state directory",
    );
    if (
      expectedBoundary &&
      (stateIdentity.device !== expectedBoundary.state.device ||
        stateIdentity.inode !== expectedBoundary.state.inode)
    ) throw new Error("The .agent-html-render state directory changed while private state was initialized.");
    await assertPinnedDirectories([
      [rootIdentity, "The selected project root"],
      [stateIdentity, "The .agent-html-render state directory"],
    ]);
    await mkdir(this.sessionsDirectory, { recursive: true });
    const sessionsIdentity = await pinDirectoryIdentity(
      this.sessionsDirectory,
      "The .agent-html-render/sessions directory",
    );
    this.storageBoundary = { root: rootIdentity, state: stateIdentity, sessions: sessionsIdentity };
    await this.assertStorageIdentity();
    const entries: string[] = [];
    let scannedEntries = 0;
    const maximumDirectoryEntries = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.maxSessionRestoreFiles + SESSION_DIRECTORY_NON_STATE_ENTRY_ALLOWANCE,
    );
    await this.assertStorageIdentity();
    const sessionDirectory = await opendir(this.sessionsDirectory);
    for await (const entry of sessionDirectory) {
      scannedEntries += 1;
      if (scannedEntries > maximumDirectoryEntries) {
        throw new SessionStateRestoreLimitError(
          `The private review state directory contains more than ${maximumDirectoryEntries} entries and cannot be scanned within its startup budget. Move stale temporary or ended-session files out of ${this.sessionsDirectory} before restarting Agent HTML Render.`,
        );
      }
      if (!entry.name.endsWith(".json")) continue;
      if (entries.length >= this.maxSessionRestoreFiles) {
        throw new SessionStateRestoreLimitError(
          `The private review state contains at least ${entries.length + 1} session files and exceeds the bounded restore limit of ${this.maxSessionRestoreFiles}. Move old ended-session files out of ${this.sessionsDirectory} before restarting Agent HTML Render.`,
        );
      }
      entries.push(entry.name);
    }
    await this.assertStorageIdentity();
    entries.sort((left, right) => left.localeCompare(right));
    const preflightSizes = await mapWithConcurrency(
      entries,
      SESSION_RESTORE_CONCURRENCY,
      async (entryName) => {
        await this.assertStorageIdentity();
        return (await lstat(join(this.sessionsDirectory, entryName), { bigint: true })).size;
      },
    );
    const preflightBytes = preflightSizes.reduce((total, size) => total + size, 0n);
    if (preflightBytes > BigInt(this.maxSessionRestoreBytes)) {
      throw new SessionStateRestoreLimitError(
        `The private review state requires ${preflightBytes.toString()} bytes and exceeds the aggregate restore limit of ${this.maxSessionRestoreBytes} bytes. Move old ended-session files out of ${this.sessionsDirectory} before restarting Agent HTML Render.`,
      );
    }
    this.persistedSessionSizes.clear();
    this.persistedSessionBytes = Number(preflightBytes);
    for (const [index, entryName] of entries.entries()) {
      this.persistedSessionSizes.set(entryName, Number(preflightSizes[index]));
    }
    let restoredBytes = 0;
    const restoredSessions = await mapWithConcurrency(
      entries,
      SESSION_RESTORE_CONCURRENCY,
      async (entryName): Promise<SessionRecord | undefined> => {
        try {
          const sessionPath = join(this.sessionsDirectory, entryName);
          const snapshot = await readPrivateSessionFile(
            sessionPath,
            this.maxSessionStateBytes,
            () => this.assertStorageIdentity(),
          );
          restoredBytes += snapshot.size;
          const preflightSize = this.persistedSessionSizes.get(entryName) ?? 0;
          this.persistedSessionSizes.set(entryName, snapshot.size);
          this.persistedSessionBytes += snapshot.size - preflightSize;
          if (restoredBytes > this.maxSessionRestoreBytes) {
            throw new SessionStateRestoreLimitError(
              `The private review state grew beyond the aggregate restore limit of ${this.maxSessionRestoreBytes} bytes while it was being restored. Stop concurrent state changes and move old ended-session files aside before restarting Agent HTML Render.`,
            );
          }
          const candidate = persistedSessionSchema.parse(JSON.parse(snapshot.source));
          if (entryName !== `${candidate.id}.json`) return undefined;
          if (
            candidate.rootDevice === undefined ||
            candidate.rootInode === undefined ||
            candidate.parentDevice === undefined ||
            candidate.parentInode === undefined
          ) {
            // Pre-identity sessions cannot prove their original root and parent directory.
            return undefined;
          }
          const artifactRelativePath = validateArtifactPath(this.rootPath, candidate.artifactPath);
          if (
            candidate.rootPath !== this.rootPath ||
            candidate.rootDevice !== selectedRoot.rootDevice ||
            candidate.rootInode !== selectedRoot.rootInode ||
            candidate.artifactRelativePath !== artifactRelativePath ||
            candidate.artifactName !== basename(candidate.artifactPath)
          ) {
            return undefined;
          }
          return {
            ...candidate,
            rootDevice: candidate.rootDevice,
            rootInode: candidate.rootInode,
            parentDevice: candidate.parentDevice,
            parentInode: candidate.parentInode,
            submissionRecords: candidate.submissionRecords.length > 0
              ? candidate.submissionRecords
              : candidate.feedbackEvents.flatMap((delivery) =>
                  delivery.submissionId
                    ? [{
                        submissionId: delivery.submissionId,
                        requestDigest: submissionRequestDigest(
                          {
                            message: delivery.feedback.reviewerMessage,
                            requeuedMessageSequences: delivery.feedback.requeuedMessageSequences,
                            annotations: delivery.feedback.annotations,
                          },
                          delivery.feedback.status === "ended",
                          delivery.feedback.session.revision,
                          delivery.feedback.session.contentHash,
                        ),
                        receipt: feedbackReceipt(delivery),
                      }]
                    : [],
                ),
          };
        } catch (error) {
          if (
            error instanceof SessionStateBoundaryError ||
            error instanceof SessionStateSizeError ||
            error instanceof SessionStateRestoreLimitError
          ) throw error;
          // Ignore partial or user-edited state files; a new session can replace them.
          return undefined;
        }
      },
    );
    for (const session of restoredSessions) {
      if (session) this.sessions.set(session.id, session);
    }
    for (const session of this.list()) {
      if (session.recoveredFromSessionId) await this.reconcileRecoveryTransfer(session.id);
    }
    await this.pruneEndedSessions();
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  getPublicState(id: string): PublicSessionState | undefined {
    const session = this.get(id);
    return session ? publicState(session) : undefined;
  }

  findOpenByArtifact(
    artifactPath: string,
    parentDevice?: string,
    parentInode?: string,
  ): SessionRecord | undefined {
    let latest: SessionRecord | undefined;
    for (const session of this.list()) {
      if (
        session.status !== "open" ||
        session.artifactPath !== artifactPath ||
        (parentDevice !== undefined && session.parentDevice !== parentDevice) ||
        (parentInode !== undefined && session.parentInode !== parentInode)
      ) continue;
      if (!latest || session.updatedAt >= latest.updatedAt) latest = session;
    }
    return latest;
  }

  findLatestEndedByArtifact(artifactPath: string): SessionRecord | undefined {
    return this.list()
      .filter((session) => session.status === "ended" && session.artifactPath === artifactPath)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  findPendingByArtifact(artifactPath: string): SessionRecord | undefined {
    let candidate: { session: SessionRecord; sentAt: string } | undefined;
    for (const session of this.list()) {
      if (session.artifactPath !== artifactPath) continue;
      const pending = session.feedbackEvents.find((event) => event.sequence > session.deliveredFeedbackSequence);
      if (!pending) continue;
      if (!candidate || pending.feedback.sentAt < candidate.sentAt) {
        candidate = { session, sentAt: pending.feedback.sentAt };
      }
    }
    return candidate?.session;
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const session = await this.buildSession(input);
    await this.persist(session);
    this.sessions.set(session.id, session);
    return session;
  }

  private async buildSession(input: CreateSessionInput): Promise<SessionRecord> {
    const selectedRoot = await resolveRoot(this.rootPath);
    const parentDetails = await stat(dirname(input.artifactPath), { bigint: true });
    if (
      selectedRoot.rootPath !== input.rootPath ||
      (input.rootDevice !== undefined && input.rootDevice !== selectedRoot.rootDevice) ||
      (input.rootInode !== undefined && input.rootInode !== selectedRoot.rootInode) ||
      !parentDetails.isDirectory() ||
      (input.parentDevice !== undefined && input.parentDevice !== parentDetails.dev.toString()) ||
      (input.parentInode !== undefined && input.parentInode !== parentDetails.ino.toString())
    ) {
      throw new Error("The selected project root or artifact parent changed before the review session opened.");
    }
    const now = new Date().toISOString();
    const recovered = input.recoveredDraft;
    if (
      recovered &&
      (!Number.isSafeInteger(recovered.baseRevision) ||
        recovered.baseRevision < 1 ||
        !/^[a-f0-9]{64}$/u.test(recovered.baseContentHash) ||
        !recovered.sourceSessionId ||
        recovered.sourceSessionId.length > 120)
    ) {
      throw new Error("Recovered review notes must retain a valid source revision and content hash.");
    }
    const session: SessionRecord = {
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      secret: randomBytes(24).toString("base64url"),
      bridgeToken: randomBytes(24).toString("base64url"),
      rootPath: input.rootPath,
      rootDevice: selectedRoot.rootDevice,
      rootInode: selectedRoot.rootInode,
      parentDevice: parentDetails.dev.toString(),
      parentInode: parentDetails.ino.toString(),
      artifactPath: input.artifactPath,
      artifactRelativePath: input.artifactRelativePath,
      artifactName: basename(input.artifactPath),
      revision: 1,
      contentHash: input.contentHash,
      status: "open",
      createdAt: now,
      updatedAt: now,
      draft: recovered ? cloneDraft(recovered.draft) : emptyDraft(),
      draftBaseRevision: recovered?.baseRevision ?? 1,
      draftBaseContentHash: recovered?.baseContentHash ?? input.contentHash,
      draftRecoveryRequired: Boolean(recovered),
      ...(recovered
        ? {
            recoveredFromSessionId: recovered.sourceSessionId,
            recoverySourceDigest: recoverySourceDigest(
              recovered.draft,
              recovered.baseRevision,
              recovered.baseContentHash,
            ),
          }
        : {}),
      feedbackEvents: [],
      feedbackDecisions: {},
      feedbackMessageDecisions: {},
      submissionRecords: [],
      deliveredFeedbackSequence: 0,
      deliveryAcknowledgements: [],
    };
    return session;
  }

  async createRecoverySession(
    input: Omit<CreateSessionInput, "recoveredDraft">,
    sourceSessionId: string,
  ): Promise<SessionRecord> {
    return this.withSessionLock(sourceSessionId, async () => {
      const source = this.requireOpen(sourceSessionId);
      if (
        source.artifactPath !== input.artifactPath ||
        (input.parentDevice !== undefined && input.parentDevice === source.parentDevice &&
          input.parentInode === source.parentInode)
      ) {
        throw new Error("Recovered review notes can only move to a replacement of the same artifact path.");
      }
      if (draftIsEmpty(source.draft)) {
        throw new Error("The preserved review session has no unsent notes to recover.");
      }
      const replacement = await this.buildSession({
        ...input,
        recoveredDraft: {
          draft: source.draft,
          baseRevision: source.draftBaseRevision,
          baseContentHash: source.draftBaseContentHash,
          sourceSessionId: source.id,
        },
      });
      const supersededSource = this.buildSupersededRecoverySource(source, replacement);
      await this.persistBatch(
        [replacement, supersededSource],
        (committed, index) => {
          if (index === 0) this.sessions.set(committed.id, committed);
        },
      );
      this.publishSupersededRecoverySource(supersededSource);
      return replacement;
    });
  }

  async reconcileRecoveryTransfer(replacementSessionId: string): Promise<boolean> {
    const replacement = this.sessions.get(replacementSessionId);
    const sourceSessionId = replacement?.recoveredFromSessionId;
    if (!replacement || !sourceSessionId || !replacement.recoverySourceDigest) return false;
    return this.withSessionLock(sourceSessionId, async () => {
      const source = this.sessions.get(sourceSessionId);
      if (!source) return false;
      if (source.status === "superseded") {
        return source.supersededBySessionId === replacement.id;
      }
      if (
        source.status !== "open" ||
        source.artifactPath !== replacement.artifactPath ||
        (source.parentDevice === replacement.parentDevice && source.parentInode === replacement.parentInode) ||
        source.createdAt > replacement.createdAt ||
        recoverySourceDigest(
          source.draft,
          source.draftBaseRevision,
          source.draftBaseContentHash,
        ) !== replacement.recoverySourceDigest
      ) return false;
      await this.persistSupersededRecoverySource(source, replacement);
      return true;
    });
  }

  async updateDraft(
    id: string,
    draft: ReviewDraft,
    baseRevision: number,
    baseContentHash: string,
    clientId?: string,
    confirmRecovery = false,
  ): Promise<SessionRecord> {
    return this.withSessionLock(id, async () => {
      const current = this.requireOpen(id);
      if (baseRevision > current.revision || (baseRevision === current.revision && baseContentHash !== current.contentHash)) {
        throw new RevisionConflictError(current.revision, current.contentHash);
      }
      if (
        confirmRecovery &&
        (baseRevision !== current.revision || baseContentHash !== current.contentHash)
      ) throw new RevisionConflictError(current.revision, current.contentHash);
      const next = structuredClone(current);
      next.draft = cloneDraft(draft);
      next.draftBaseRevision = baseRevision;
      next.draftBaseContentHash = baseContentHash;
      if (confirmRecovery) next.draftRecoveryRequired = false;
      next.updatedAt = new Date().toISOString();
      await this.persist(next);
      this.sessions.set(id, next);
      this.emitReview(id, {
        type: "draft",
        draft: cloneDraft(draft),
        baseRevision,
        baseContentHash,
        ...(clientId ? { clientId } : {}),
        updatedAt: next.updatedAt,
      });
      return next;
    });
  }

  async bumpRevision(id: string, hash: string): Promise<SessionRecord> {
    return this.withSessionLock(id, async () => {
      const current = this.requireSession(id);
      if (current.contentHash === hash || current.status !== "open") return current;
      const next = structuredClone(current);
      next.contentHash = hash;
      next.revision += 1;
      if (draftIsEmpty(next.draft)) {
        next.draftBaseRevision = next.revision;
        next.draftBaseContentHash = hash;
        next.draftRecoveryRequired = false;
      }
      next.updatedAt = new Date().toISOString();
      await this.persist(next);
      this.sessions.set(id, next);
      this.emitReview(id, {
        type: "revision",
        revision: next.revision,
        contentHash: hash,
        updatedAt: next.updatedAt,
      });
      return next;
    });
  }

  replayFeedback(
    id: string,
    draft: ReviewDraft,
    end: boolean,
    baseRevision: number,
    baseContentHash: string,
    submissionId: string,
  ): FeedbackReceipt | undefined {
    const session = this.requireSession(id);
    const record = session.submissionRecords.find((candidate) => candidate.submissionId === submissionId);
    if (!record) return undefined;
    const requestDigest = submissionRequestDigest(draft, end, baseRevision, baseContentHash);
    if (record.requestDigest !== requestDigest) {
      throw new SubmissionConflictError();
    }
    return structuredClone(record.receipt);
  }

  async sendFeedback(
    id: string,
    draft: ReviewDraft,
    end: boolean,
    baseRevision: number,
    baseContentHash: string,
    submissionId: string,
  ): Promise<FeedbackReceipt> {
    return this.withSessionLock(id, async () => {
      const replay = this.replayFeedback(id, draft, end, baseRevision, baseContentHash, submissionId);
      if (replay) return replay;
      const current = this.requireOpen(id);
      if (current.draftRecoveryRequired || baseRevision !== current.revision || baseContentHash !== current.contentHash) {
        throw new RevisionConflictError(current.revision, current.contentHash);
      }
      if (
        current.submissionRecords.length >= MAX_SUBMISSION_RECORDS ||
        (!end && current.submissionRecords.length >= MAX_SUBMISSION_RECORDS - 1)
      ) {
        throw new Error(
          `This review reached its bounded submission history. Send & End, then start a new review session.`,
        );
      }

      const next = structuredClone(current);
      next.draft = cloneDraft(draft);
      next.draftBaseRevision = baseRevision;
      next.draftBaseContentHash = baseContentHash;
      while (
        next.feedbackEvents.length >= MAX_FEEDBACK_EVENTS &&
        (next.feedbackEvents[0]?.sequence ?? Number.POSITIVE_INFINITY) <= next.deliveredFeedbackSequence
      ) {
        const removed = next.feedbackEvents.shift();
        if (removed) delete next.feedbackMessageDecisions[String(removed.sequence)];
        for (const annotation of removed?.feedback.annotations ?? []) {
          delete next.feedbackDecisions[feedbackDecisionKey(removed?.sequence ?? 0, annotation.id)];
        }
      }
      if (next.feedbackEvents.length >= MAX_FEEDBACK_EVENTS) {
        throw new Error(
          `Too many feedback batches are waiting for the agent. Deliver the pending feedback before sending another batch.`,
        );
      }
      const sentAt = new Date().toISOString();
      const feedback = createFeedbackEnvelope(next, end ? "ended" : "feedback", sentAt);
      const sequence = (next.feedbackEvents.at(-1)?.sequence ?? next.deliveredFeedbackSequence) + 1;
      const markdown = formatFeedbackMarkdown(feedback);
      if (markdown.length > MAX_FEEDBACK_MARKDOWN_LENGTH) {
        throw new Error(
          "This feedback batch expands beyond the 1,000,000 character delivery limit. Shorten or split the notes before sending.",
        );
      }
      const delivery: FeedbackDelivery = { sequence, submissionId, feedback, markdown };
      const receipt = feedbackReceipt(delivery);
      next.feedbackEvents.push(delivery);
      next.submissionRecords.push({
        submissionId,
        requestDigest: submissionRequestDigest(draft, end, baseRevision, baseContentHash),
        receipt,
      });
      next.draft = emptyDraft();
      next.draftBaseRevision = next.revision;
      next.draftBaseContentHash = next.contentHash;
      next.draftRecoveryRequired = false;
      next.updatedAt = sentAt;
      if (end) next.status = "ended";
      await this.persist(next);
      this.sessions.set(id, next);
      this.emitReview(id, { type: "feedback-submitted", receipt, updatedAt: sentAt });
      this.emitSafely(`feedback:${id}`, delivery);
      this.emitReview(id, {
        type: "draft",
        draft: emptyDraft(),
        baseRevision: next.draftBaseRevision,
        baseContentHash: next.draftBaseContentHash,
        updatedAt: sentAt,
      });
      if (end) this.emitReview(id, { type: "status", status: "ended", updatedAt: sentAt });
      return receipt;
    });
  }

  nextUndelivered(id: string, after: number): FeedbackDelivery | undefined {
    const session = this.requireSession(id);
    if (after > session.deliveredFeedbackSequence) return undefined;
    const cursor = Math.max(after, session.deliveredFeedbackSequence);
    return session.feedbackEvents.find((event) => event.sequence > cursor);
  }

  leaseNextUndelivered(
    id: string,
    after: number,
    consumerId: string,
  ): FeedbackLeaseResult {
    assertNoCallerSuppliedLeaseClock(arguments.length, 3);
    assertFeedbackCursor(after);
    assertFeedbackConsumerId(consumerId);
    const now = Date.now();
    assertFeedbackLeaseTimestamp(now);
    this.assertOperational();
    const delivery = this.nextUndelivered(id, after);
    if (!delivery) return {};
    const existing = this.feedbackLeases.get(id);
    if (existing?.sequence === delivery.sequence && existing.acknowledging) {
      return { retryAt: existing.expiresAt };
    }
    if (existing?.sequence === delivery.sequence && existing.expiresAt > now) {
      return existing.consumerId === consumerId
        ? { delivery, leaseId: existing.leaseId, retryAt: existing.expiresAt }
        : { retryAt: existing.expiresAt };
    }
    const lease: FeedbackLease = {
      sequence: delivery.sequence,
      consumerId,
      leaseId: randomBytes(24).toString("base64url"),
      expiresAt: now + FEEDBACK_LEASE_MILLISECONDS,
      acknowledging: false,
    };
    this.feedbackLeases.set(id, lease);
    return { delivery, leaseId: lease.leaseId, retryAt: lease.expiresAt };
  }

  async releaseFeedbackLease(
    id: string,
    sequence: number,
    consumerId: string,
    leaseId: string,
  ): Promise<boolean> {
    assertNoCallerSuppliedLeaseClock(arguments.length, 4);
    assertFeedbackSequence(sequence);
    assertFeedbackConsumerId(consumerId);
    assertFeedbackLeaseId(leaseId);
    return this.withSessionLock(id, async () => {
      this.assertOperational();
      const now = Date.now();
      assertFeedbackLeaseTimestamp(now);
      const lease = this.feedbackLeases.get(id);
      if (
        !lease ||
        lease.sequence !== sequence ||
        lease.consumerId !== consumerId ||
        lease.leaseId !== leaseId ||
        lease.acknowledging ||
        lease.expiresAt <= (now ?? Date.now())
      ) {
        return false;
      }
      this.feedbackLeases.delete(id);
      return true;
    });
  }

  async renewFeedbackLease(
    id: string,
    sequence: number,
    consumerId: string,
    leaseId: string,
  ): Promise<number | undefined> {
    assertNoCallerSuppliedLeaseClock(arguments.length, 4);
    assertFeedbackSequence(sequence);
    assertFeedbackConsumerId(consumerId);
    assertFeedbackLeaseId(leaseId);
    return this.withSessionLock(id, async () => {
      this.assertOperational();
      const renewedAt = Date.now();
      assertFeedbackLeaseTimestamp(renewedAt);
      const lease = this.feedbackLeases.get(id);
      if (
        !lease ||
        lease.sequence !== sequence ||
        lease.consumerId !== consumerId ||
        lease.leaseId !== leaseId ||
        lease.acknowledging ||
        lease.expiresAt <= renewedAt
      ) {
        return undefined;
      }
      lease.expiresAt = renewedAt + FEEDBACK_LEASE_MILLISECONDS;
      return lease.expiresAt;
    });
  }

  async markDelivered(
    id: string,
    sequence: number,
    consumerId: string,
    leaseId: string,
  ): Promise<void> {
    assertNoCallerSuppliedLeaseClock(arguments.length, 4);
    assertFeedbackSequence(sequence);
    assertFeedbackConsumerId(consumerId);
    assertFeedbackLeaseId(leaseId);
    await this.withSessionLock(id, async () => {
      this.assertOperational();
      const current = this.requireSession(id);
      if (sequence <= current.deliveredFeedbackSequence) {
        const committed = current.deliveryAcknowledgements.find(
          (acknowledgement) => acknowledgement.sequence === sequence,
        );
        if (committed?.grantDigest === deliveryGrantDigest(sequence, consumerId, leaseId)) return;
        throw new Error("This feedback batch was acknowledged by a different delivery grant.");
      }
      const lease = this.feedbackLeases.get(id);
      const acknowledgedAt = Date.now();
      assertFeedbackLeaseTimestamp(acknowledgedAt);
      if (
        !lease ||
        lease.sequence !== sequence ||
        lease.consumerId !== consumerId ||
        lease.leaseId !== leaseId ||
        lease.expiresAt <= acknowledgedAt
      ) {
        throw new Error("This feedback acknowledgement no longer holds the current unexpired delivery lease.");
      }
      const cursor = current.deliveredFeedbackSequence;
      const delivery = current.feedbackEvents.find((event) => event.sequence > cursor);
      if (!delivery || delivery.sequence !== sequence) {
        throw new Error("Feedback must be acknowledged in delivery order.");
      }
      const acknowledgedLeaseId = lease.leaseId;
      const next = structuredClone(current);
      next.deliveredFeedbackSequence = sequence;
      if (next.deliveryAcknowledgements.length >= MAX_SUBMISSION_RECORDS) {
        throw new Error("This review reached its bounded delivery acknowledgement history.");
      }
      next.deliveryAcknowledgements.push({
        sequence,
        grantDigest: deliveryGrantDigest(sequence, consumerId, leaseId),
      });
      next.updatedAt = new Date().toISOString();
      lease.acknowledging = true;
      try {
        await this.persist(next);
      } catch (error) {
        if (!(error instanceof SessionStoreProcessTerminationRequiredError)) {
          const currentLease = this.feedbackLeases.get(id);
          if (currentLease && currentLease.leaseId === acknowledgedLeaseId) {
            currentLease.acknowledging = false;
          }
        }
        throw error;
      }
      this.sessions.set(id, next);
      const currentLease = this.feedbackLeases.get(id);
      if (currentLease && currentLease.leaseId === acknowledgedLeaseId) this.feedbackLeases.delete(id);
      this.emitReview(id, {
        type: "feedback-delivered",
        sequence,
        updatedAt: next.updatedAt,
      });
    });
    await this.pruneEndedSessions();
  }

  async reviewFeedback(
    id: string,
    sequence: number,
    annotationId: string,
    decision: ChangeReviewDecision,
    requeue: boolean,
  ): Promise<PublicSessionState> {
    return this.withSessionLock(id, async () => {
      const current = this.requireOpen(id);
      const next = structuredClone(current);
      const delivery = next.feedbackEvents.find((event) => event.sequence === sequence);
      const annotation = delivery?.feedback.annotations.find((candidate) => candidate.id === annotationId);
      if (!delivery || !annotation) throw new Error("Unknown feedback annotation.");
      if (next.revision <= delivery.feedback.session.revision) {
        throw new Error("Review this feedback after the artifact has a newer revision.");
      }
      if (requeue && decision !== "needs-work") {
        throw new Error("Only feedback that still needs work can be requeued.");
      }
      let draftChanged = false;
      if (requeue) {
        if (next.draftBaseRevision !== next.revision || next.draftBaseContentHash !== next.contentHash) {
          throw new RevisionConflictError(next.revision, next.contentHash);
        }
        const alreadyQueued = next.draft.annotations.some(
          (candidate) =>
            candidate.requeuedFrom?.sequence === sequence &&
            candidate.requeuedFrom.annotationId === annotationId,
        ) || next.feedbackEvents.some((event) =>
          event.feedback.annotations.some(
            (candidate) =>
              candidate.requeuedFrom?.sequence === sequence &&
              candidate.requeuedFrom.annotationId === annotationId,
          ),
        );
        if (!alreadyQueued) {
          if (next.draft.annotations.length >= 100) {
            throw new Error("The review draft already contains the maximum of 100 annotations.");
          }
          next.draft.annotations.push({
            id: randomUUID(),
            comment: annotation.comment,
            createdAt: new Date().toISOString(),
            target: structuredClone(annotation.target),
            requeuedFrom: {
              sequence,
              annotationId,
              sourceDigest: annotationSourceDigest(annotation),
            },
          });
          draftChanged = true;
        }
      } else if (decision !== "needs-work") {
        const remainingAnnotations = next.draft.annotations.filter((candidate) => {
          const provenance = candidate.requeuedFrom;
          if (provenance?.sequence !== sequence || provenance.annotationId !== annotationId) return true;
          return !provenance.sourceDigest || annotationSourceDigest(candidate) !== provenance.sourceDigest;
        });
        draftChanged = remainingAnnotations.length !== next.draft.annotations.length;
        next.draft.annotations = remainingAnnotations;
      }
      next.feedbackDecisions[feedbackDecisionKey(sequence, annotationId)] = decision;
      next.updatedAt = new Date().toISOString();
      await this.persist(next);
      this.sessions.set(id, next);
      this.emitReview(id, {
        type: "feedback-reviewed",
        sequence,
        subject: "annotation",
        annotationId,
        decision,
        updatedAt: next.updatedAt,
      });
      if (draftChanged) {
        this.emitReview(id, {
          type: "draft",
          draft: structuredClone(next.draft),
          baseRevision: next.draftBaseRevision,
          baseContentHash: next.draftBaseContentHash,
          updatedAt: next.updatedAt,
        });
      }
      return publicState(next);
    });
  }

  async reviewFeedbackMessage(
    id: string,
    sequence: number,
    decision: ChangeReviewDecision,
    requeue: boolean,
  ): Promise<PublicSessionState> {
    return this.withSessionLock(id, async () => {
      const current = this.requireOpen(id);
      const next = structuredClone(current);
      const delivery = next.feedbackEvents.find((event) => event.sequence === sequence);
      const reviewerMessage = delivery?.feedback.reviewerMessage.trim() ?? "";
      if (!delivery || !reviewerMessage) throw new Error("Unknown feedback reviewer message.");
      if (next.revision <= delivery.feedback.session.revision) {
        throw new Error("Review this feedback after the artifact has a newer revision.");
      }
      if (requeue && decision !== "needs-work") {
        throw new Error("Only feedback that still needs work can be requeued.");
      }

      let draftChanged = false;
      const requeuedSequences = new Set(next.draft.requeuedMessageSequences ?? []);
      if (requeue) {
        if (next.draftBaseRevision !== next.revision || next.draftBaseContentHash !== next.contentHash) {
          throw new RevisionConflictError(next.revision, next.contentHash);
        }
        const alreadySent = next.feedbackEvents.some((event) =>
          event.feedback.requeuedMessageSequences.includes(sequence),
        );
        if (!requeuedSequences.has(sequence) && !alreadySent) {
          if (requeuedSequences.size >= MAX_REQUEUED_MESSAGE_SOURCES) {
            throw new Error(`The review draft already contains the maximum of ${MAX_REQUEUED_MESSAGE_SOURCES} requeued notes.`);
          }
          const nextMessage = next.draft.message.trim()
            ? `${next.draft.message.trim()}\n\n${reviewerMessage}`
            : reviewerMessage;
          if (nextMessage.length > MAX_REVIEWER_MESSAGE_LENGTH) {
            throw new Error("The review draft general note exceeds the 8,000 character limit.");
          }
          next.draft.message = nextMessage;
          requeuedSequences.add(sequence);
          draftChanged = true;
        }
      } else if (decision !== "needs-work" && requeuedSequences.delete(sequence)) {
        next.draft.message = removeRequeuedMessageText(next.draft.message, reviewerMessage);
        draftChanged = true;
      }
      next.draft.requeuedMessageSequences = Array.from(requeuedSequences).sort((left, right) => left - right);
      next.feedbackMessageDecisions[String(sequence)] = decision;
      next.updatedAt = new Date().toISOString();
      await this.persist(next);
      this.sessions.set(id, next);
      this.emitReview(id, {
        type: "feedback-reviewed",
        sequence,
        subject: "message",
        decision,
        updatedAt: next.updatedAt,
      });
      if (draftChanged) {
        this.emitReview(id, {
          type: "draft",
          draft: structuredClone(next.draft),
          baseRevision: next.draftBaseRevision,
          baseContentHash: next.draftBaseContentHash,
          updatedAt: next.updatedAt,
        });
      }
      return publicState(next);
    });
  }

  async refreshContentHash(id: string, hash: string): Promise<SessionRecord> {
    return this.bumpRevision(id, hash);
  }

  onReview(id: string, listener: (event: ReviewEvent) => void): () => void {
    const eventName = `review:${id}`;
    this.on(eventName, listener);
    return () => this.off(eventName, listener);
  }

  onFeedback(id: string, listener: (event: FeedbackDelivery) => void): () => void {
    const eventName = `feedback:${id}`;
    this.on(eventName, listener);
    return () => this.off(eventName, listener);
  }

  private emitReview(id: string, event: ReviewEvent): void {
    this.emitSafely(`review:${id}`, event);
  }

  private emitSafely(eventName: string, value: unknown): void {
    for (const listener of this.rawListeners(eventName)) {
      try {
        Reflect.apply(listener, this, [value]);
      } catch {
        // A disconnected SSE/long-poll consumer cannot roll back a durable commit.
      }
    }
  }

  private async withSessionLock<Value>(id: string, work: () => Promise<Value>): Promise<Value> {
    const previous = this.mutationQueues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(work);
    const settled = operation.then(() => undefined, () => undefined);
    this.mutationQueues.set(id, settled);
    try {
      return await operation;
    } finally {
      if (this.mutationQueues.get(id) === settled) this.mutationQueues.delete(id);
    }
  }

  private assertOperational(): void {
    if (this.terminalFailure) throw this.terminalFailure;
  }

  private async withStorageLock<Value>(work: () => Promise<Value>): Promise<Value> {
    const previous = this.storageMutationQueue;
    const operation = previous.catch(() => undefined).then(() => {
      if (this.terminalFailure) throw this.terminalFailure;
      return work();
    });
    const settled = operation.then(() => undefined, () => undefined);
    this.storageMutationQueue = settled;
    return operation;
  }

  private terminateAfterCommittedWrite(error: unknown): SessionStoreProcessTerminationRequiredError {
    this.terminalFailure ??= new SessionStoreProcessTerminationRequiredError(
      "A persisted review session committed, but post-commit state verification failed. The daemon process must terminate before another state change.",
      { cause: error },
    );
    return this.terminalFailure;
  }

  private async assertStorageIdentity(): Promise<void> {
    const boundary = this.storageBoundary;
    if (!boundary) throw new Error("The private session store has not been initialized.");
    await assertPinnedDirectories([
      [boundary.root, "The selected project root"],
      [boundary.state, "The .agent-html-render state directory"],
      [boundary.sessions, "The .agent-html-render/sessions directory"],
    ]);
  }

  private async pruneEndedSessions(now = Date.now()): Promise<void> {
    await this.withStorageLock(() => this.pruneEndedSessionsUnlocked(now));
  }

  private async pruneEndedSessionsUnlocked(now = Date.now()): Promise<void> {
    const cutoff = now - ENDED_SESSION_RETENTION_MILLISECONDS;
    const eligible = this.list()
      .filter((session) => {
        const latestSequence = session.feedbackEvents.at(-1)?.sequence ?? session.deliveredFeedbackSequence;
        return (session.status === "ended" || session.status === "superseded") &&
          session.deliveredFeedbackSequence >= latestSequence;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const expired = eligible.filter(
      (session, index) => index >= MAX_RETAINED_ENDED_SESSIONS || Date.parse(session.updatedAt) < cutoff,
    );
    for (const session of expired) {
      this.sessions.delete(session.id);
      this.feedbackLeases.delete(session.id);
      const entryName = `${session.id}.json`;
      try {
        const target = join(this.sessionsDirectory, entryName);
        await this.assertStorageIdentity();
        await requireRegularSingleLinkOrMissing(target, "The persisted review session path");
        await this.assertStorageIdentity();
        await unlink(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.sessions.set(session.id, session);
          throw error;
        }
      }
      const removedBytes = this.persistedSessionSizes.get(entryName) ?? 0;
      this.persistedSessionSizes.delete(entryName);
      this.persistedSessionBytes -= removedBytes;
    }
  }

  private async persistSupersededRecoverySource(
    source: SessionRecord,
    replacement: SessionRecord,
  ): Promise<void> {
    const next = this.buildSupersededRecoverySource(source, replacement);
    await this.persist(next);
    this.publishSupersededRecoverySource(next);
  }

  private buildSupersededRecoverySource(
    source: SessionRecord,
    replacement: SessionRecord,
  ): SessionRecord {
    const next = structuredClone(source);
    next.status = "superseded";
    next.supersededBySessionId = replacement.id;
    next.draft = emptyDraft();
    next.draftBaseRevision = next.revision;
    next.draftBaseContentHash = next.contentHash;
    next.draftRecoveryRequired = false;
    next.updatedAt = new Date().toISOString();
    return next;
  }

  private publishSupersededRecoverySource(next: SessionRecord): void {
    this.sessions.set(next.id, next);
    this.emitReview(next.id, { type: "status", status: "superseded", updatedAt: next.updatedAt });
    this.emitReview(next.id, {
      type: "draft",
      draft: emptyDraft(),
      baseRevision: next.draftBaseRevision,
      baseContentHash: next.draftBaseContentHash,
      updatedAt: next.updatedAt,
    });
  }

  private requireSession(id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown Agent HTML Render session.");
    return session;
  }

  private requireOpen(id: string): SessionRecord {
    const session = this.requireSession(id);
    if (session.status === "superseded") {
      throw new Error("This Agent HTML Render session moved to a replacement artifact review.");
    }
    if (session.status !== "open") throw new Error("This Agent HTML Render session has ended.");
    return session;
  }

  private snapshotForSession(session: SessionRecord): {
    session: SessionRecord;
    entryName: string;
    snapshot: string;
    snapshotBytes: number;
  } {
    const serializable = JSON.parse(JSON.stringify(session)) as unknown;
    persistedSessionSchema.parse(serializable);
    const snapshot = `${JSON.stringify(serializable, null, 2)}\n`;
    const snapshotBytes = Buffer.byteLength(snapshot, "utf8");
    if (snapshotBytes > this.maxSessionStateBytes) {
      throw new SessionStateSizeError(snapshotBytes, this.maxSessionStateBytes);
    }
    return { session, entryName: `${session.id}.json`, snapshot, snapshotBytes };
  }

  private async persistBatch(
    sessions: readonly SessionRecord[],
    onCommit?: (session: SessionRecord, index: number) => void,
  ): Promise<void> {
    const snapshots = sessions.map((session) => this.snapshotForSession(session));
    await this.withStorageLock(async () => {
      await this.pruneEndedSessionsUnlocked();
      const projectedSizes = new Map(this.persistedSessionSizes);
      let projectedBytes = this.persistedSessionBytes;
      for (const candidate of snapshots) {
        const previousBytes = projectedSizes.get(candidate.entryName);
        projectedBytes += candidate.snapshotBytes - (previousBytes ?? 0);
        projectedSizes.set(candidate.entryName, candidate.snapshotBytes);
        const projectedFiles = projectedSizes.size;
        if (projectedFiles > this.maxSessionRestoreFiles) {
          throw new SessionStateRestoreLimitError(
            `Saving this review would create ${projectedFiles} session files at a durable commit step and exceed the restart-safe limit of ${this.maxSessionRestoreFiles}. End and deliver older reviews, then retry.`,
          );
        }
        if (projectedBytes > this.maxSessionRestoreBytes) {
          throw new SessionStateRestoreLimitError(
            `Saving this review would require ${projectedBytes} persisted bytes at a durable commit step and exceed the restart-safe aggregate limit of ${this.maxSessionRestoreBytes} bytes. End and deliver older reviews or shorten the current review, then retry.`,
          );
        }
      }
      for (const [index, candidate] of snapshots.entries()) {
        let committed = false;
        try {
          await atomicReplaceRegularFile(
            this.sessionsDirectory,
            join(this.sessionsDirectory, candidate.entryName),
            candidate.snapshot,
            "The persisted review session path",
            () => this.assertStorageIdentity(),
            () => {
              committed = true;
              const previousBytes = this.persistedSessionSizes.get(candidate.entryName) ?? 0;
              this.persistedSessionSizes.set(candidate.entryName, candidate.snapshotBytes);
              this.persistedSessionBytes += candidate.snapshotBytes - previousBytes;
              onCommit?.(candidate.session, index);
            },
          );
          if (process.platform !== "win32") {
            await this.assertStorageIdentity();
            try {
              await this.synchronizeDirectory(this.sessionsDirectory);
            } catch {
              // Rename is the observable commit point. Directory-sync failure alone cannot roll
              // it back, so keep the commit published and verify the pinned boundary once more.
            }
            await this.assertStorageIdentity();
          }
        } catch (error) {
          if (committed) throw this.terminateAfterCommittedWrite(error);
          throw error;
        }
      }
    });
  }

  private async persist(session: SessionRecord): Promise<void> {
    await this.persistBatch([session]);
  }
}
