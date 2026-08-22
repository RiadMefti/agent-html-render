import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  FeedbackDelivery,
  FeedbackReceipt,
  PublicSessionState,
  ReviewDraft,
  ReviewEvent,
  SessionStatus,
} from "../shared/protocol.js";
import { PROTOCOL_VERSION } from "../shared/protocol.js";
import { resolveArtifact } from "./artifact.js";
import { createFeedbackEnvelope, formatFeedbackMarkdown } from "./feedback.js";
import { persistedSessionSchema } from "./validation.js";

export interface SessionRecord {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  secret: string;
  bridgeToken: string;
  rootPath: string;
  artifactPath: string;
  artifactRelativePath: string;
  artifactName: string;
  revision: number;
  contentHash: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  draft: ReviewDraft;
  feedbackEvents: FeedbackDelivery[];
  deliveredFeedbackSequence: number;
}

export interface CreateSessionInput {
  rootPath: string;
  artifactPath: string;
  artifactRelativePath: string;
  contentHash: string;
}

function emptyDraft(): ReviewDraft {
  return { message: "", annotations: [] };
}

function feedbackReceipt(delivery: FeedbackDelivery): FeedbackReceipt {
  return {
    sequence: delivery.sequence,
    status: delivery.feedback.status,
    sentAt: delivery.feedback.sentAt,
    revision: delivery.feedback.session.revision,
  };
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
    latestFeedback: latestDelivery ? feedbackReceipt(latestDelivery) : null,
    deliveredFeedbackSequence: session.deliveredFeedbackSequence,
  };
}

export class SessionStore extends EventEmitter {
  readonly stateDirectory: string;
  readonly sessionsDirectory: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(readonly rootPath: string) {
    super();
    this.stateDirectory = join(rootPath, ".agentrender");
    this.sessionsDirectory = join(this.stateDirectory, "sessions");
  }

  async initialize(): Promise<void> {
    await mkdir(this.sessionsDirectory, { recursive: true });
    const entries = await readdir(this.sessionsDirectory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            const parsed = persistedSessionSchema.parse(
              JSON.parse(await readFile(join(this.sessionsDirectory, entry.name), "utf8")),
            ) as SessionRecord;
            const artifact = await resolveArtifact(this.rootPath, parsed.artifactPath);
            if (
              parsed.rootPath !== this.rootPath ||
              parsed.artifactPath !== artifact.artifactPath ||
              parsed.artifactRelativePath !== artifact.artifactRelativePath ||
              parsed.artifactName !== basename(artifact.artifactPath)
            ) {
              return;
            }
            this.sessions.set(parsed.id, parsed);
          } catch {
            // Ignore partial or user-edited state files; a new session can replace them.
          }
        }),
    );
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

  findOpenByArtifact(artifactPath: string): SessionRecord | undefined {
    return this.list().find((session) => session.status === "open" && session.artifactPath === artifactPath);
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      secret: randomBytes(24).toString("base64url"),
      bridgeToken: randomBytes(24).toString("base64url"),
      rootPath: input.rootPath,
      artifactPath: input.artifactPath,
      artifactRelativePath: input.artifactRelativePath,
      artifactName: basename(input.artifactPath),
      revision: 1,
      contentHash: input.contentHash,
      status: "open",
      createdAt: now,
      updatedAt: now,
      draft: emptyDraft(),
      feedbackEvents: [],
      deliveredFeedbackSequence: 0,
    };
    this.sessions.set(session.id, session);
    await this.persist(session);
    return session;
  }

  async updateDraft(id: string, draft: ReviewDraft): Promise<SessionRecord> {
    const session = this.requireOpen(id);
    session.draft = structuredClone(draft);
    session.updatedAt = new Date().toISOString();
    await this.persist(session);
    this.emitReview(id, { type: "draft", draft: structuredClone(draft), updatedAt: session.updatedAt });
    return session;
  }

  async bumpRevision(id: string, hash: string): Promise<SessionRecord> {
    const session = this.requireSession(id);
    if (session.contentHash === hash || session.status === "ended") return session;
    session.contentHash = hash;
    session.revision += 1;
    session.updatedAt = new Date().toISOString();
    await this.persist(session);
    this.emitReview(id, {
      type: "revision",
      revision: session.revision,
      contentHash: hash,
      updatedAt: session.updatedAt,
    });
    return session;
  }

  async sendFeedback(id: string, draft: ReviewDraft, end: boolean): Promise<FeedbackDelivery> {
    const session = this.requireOpen(id);
    session.draft = structuredClone(draft);
    const sentAt = new Date().toISOString();
    const feedback = createFeedbackEnvelope(session, end ? "ended" : "feedback", sentAt);
    const sequence = (session.feedbackEvents.at(-1)?.sequence ?? 0) + 1;
    const delivery: FeedbackDelivery = {
      sequence,
      feedback,
      markdown: formatFeedbackMarkdown(feedback),
    };
    session.feedbackEvents.push(delivery);
    if (session.feedbackEvents.length > 50) session.feedbackEvents.splice(0, session.feedbackEvents.length - 50);
    session.draft = emptyDraft();
    session.updatedAt = sentAt;
    if (end) session.status = "ended";
    await this.persist(session);
    this.emitReview(id, {
      type: "feedback-submitted",
      receipt: feedbackReceipt(delivery),
      updatedAt: sentAt,
    });
    this.emit(`feedback:${id}`, delivery);
    this.emitReview(id, { type: "draft", draft: emptyDraft(), updatedAt: sentAt });
    if (end) this.emitReview(id, { type: "status", status: "ended", updatedAt: sentAt });
    return delivery;
  }

  nextUndelivered(id: string, after: number): FeedbackDelivery | undefined {
    const session = this.requireSession(id);
    const cursor = Math.max(after, session.deliveredFeedbackSequence);
    return session.feedbackEvents.find((event) => event.sequence > cursor);
  }

  async markDelivered(id: string, sequence: number): Promise<void> {
    const session = this.requireSession(id);
    if (sequence <= session.deliveredFeedbackSequence) return;
    session.deliveredFeedbackSequence = sequence;
    session.updatedAt = new Date().toISOString();
    await this.persist(session);
    this.emitReview(id, {
      type: "feedback-delivered",
      sequence,
      updatedAt: session.updatedAt,
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
    this.emit(`review:${id}`, event);
  }

  private requireSession(id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown AgentRender session.");
    return session;
  }

  private requireOpen(id: string): SessionRecord {
    const session = this.requireSession(id);
    if (session.status !== "open") throw new Error("This AgentRender session has ended.");
    return session;
  }

  private async persist(session: SessionRecord): Promise<void> {
    const target = join(this.sessionsDirectory, `${session.id}.json`);
    const temporary = `${target}.tmp`;
    const snapshot = `${JSON.stringify(session, null, 2)}\n`;
    const previous = this.pendingWrites.get(session.id) ?? Promise.resolve();
    const current = previous.then(async () => {
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, target);
    });
    this.pendingWrites.set(session.id, current);
    try {
      await current;
    } finally {
      if (this.pendingWrites.get(session.id) === current) this.pendingWrites.delete(session.id);
    }
  }
}
