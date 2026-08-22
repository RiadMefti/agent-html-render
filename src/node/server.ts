import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  EXPLICIT_FEEDBACK_ACK_CAPABILITY,
  FEEDBACK_ACK_HEADER,
  type FeedbackDelivery,
  type ReviewEvent,
} from "../shared/protocol.js";
import { readArtifact, renderSandboxedArtifact, resolveArtifact } from "./artifact.js";
import {
  createRuntimeBuildIdentity,
  DEFAULT_BRIDGE_PATH,
  DEFAULT_UI_DIRECTORY,
  readUiRuntimeSnapshot,
} from "./build.js";
import { SessionStore, type SessionRecord } from "./store.js";
import { parseFeedbackAckBody, parseReviewDraft, parseSendBody } from "./validation.js";

const LONG_POLL_MILLISECONDS = 25_000;
const SSE_HEARTBEAT_MILLISECONDS = 15_000;

export interface StartServerOptions {
  rootPath: string;
  port?: number;
  token?: string;
  uiDirectory?: string;
  bridgeSource?: string;
}

export interface AgentSessionSummary {
  id: string;
  status: "open" | "ended";
  artifactRelativePath: string;
  revision: number;
  connectedReviewers: number;
  reviewUrl: string;
}

export interface RunningServer {
  rootPath: string;
  port: number;
  origin: string;
  token: string;
  packageVersion: string;
  buildId: string;
  store: SessionStore;
  close: () => Promise<void>;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

function parseCursor(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function sessionAccess(request: Request): string {
  const queryAccess = request.query.access;
  if (typeof queryAccess === "string") return queryAccess;
  return request.header("x-agent-html-render-access") ?? "";
}

function routeParameter(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function sendSse(response: Response, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const rootPath = await realpath(resolve(options.rootPath));
  const token = options.token ?? randomBytes(24).toString("base64url");
  const uiDirectory = options.uiDirectory ?? DEFAULT_UI_DIRECTORY;
  const [uiSnapshot, bridgeSource] = await Promise.all([
    readUiRuntimeSnapshot(uiDirectory),
    options.bridgeSource === undefined ? readFile(DEFAULT_BRIDGE_PATH, "utf8") : options.bridgeSource,
  ]);
  const uiIndexHtml = uiSnapshot.indexHtml;
  const runtimeBuild = createRuntimeBuildIdentity(uiIndexHtml, bridgeSource, uiSnapshot.assets);

  const store = new SessionStore(rootPath);
  await store.initialize();
  const watchers = new Map<string, FSWatcher>();
  const connectedReviewers = new Map<string, number>();
  const app = express();
  const httpServer: HttpServer = createServer(app);
  let origin = "";
  let closing = false;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb", strict: true }));
  app.use((_request, response, next) => {
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  const requireAgentToken = (request: Request, response: Response, next: NextFunction): void => {
    const supplied = request.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!secureEqual(supplied, token)) {
      response.status(401).json({ error: "Invalid daemon token." });
      return;
    }
    next();
  };

  const requireReviewSession = (request: Request, response: Response): SessionRecord | undefined => {
    const session = store.get(routeParameter(request.params.id));
    if (!session || !secureEqual(sessionAccess(request), session.secret)) {
      response.status(404).json({ error: "Unknown review session." });
      return undefined;
    }
    return session;
  };

  const summary = (session: SessionRecord): AgentSessionSummary => ({
    id: session.id,
    status: session.status,
    artifactRelativePath: session.artifactRelativePath,
    revision: session.revision,
    connectedReviewers: connectedReviewers.get(session.id) ?? 0,
    reviewUrl: `${origin}/session/${session.id}?access=${encodeURIComponent(session.secret)}`,
  });

  const ensureWatcher = (session: SessionRecord): void => {
    if (watchers.has(session.id) || session.status === "ended") return;
    const watcher = chokidar.watch(session.artifactPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    watcher.on("change", () => {
      void readArtifact(session.artifactPath)
        .then(({ hash }) => store.bumpRevision(session.id, hash))
        .catch(() => undefined);
    });
    watchers.set(session.id, watcher);
  };

  app.get("/api/health", requireAgentToken, (_request, response) => {
    response.json({
      name: "agent-html-render",
      protocolVersion: "1",
      capabilities: [EXPLICIT_FEEDBACK_ACK_CAPABILITY],
      packageVersion: runtimeBuild.packageVersion,
      buildId: runtimeBuild.buildId,
      rootPath,
      pid: process.pid,
    });
  });

  app.post(
    "/api/agent/sessions",
    requireAgentToken,
    asyncRoute(async (request, response) => {
      const requestedRoot = typeof request.body?.rootPath === "string" ? request.body.rootPath : rootPath;
      const artifactInput = request.body?.artifactPath;
      if (typeof artifactInput !== "string") {
        response.status(400).json({ error: "artifactPath is required." });
        return;
      }
      const artifact = await resolveArtifact(requestedRoot, artifactInput);
      if (artifact.rootPath !== rootPath) {
        response.status(400).json({ error: "This daemon belongs to a different project root." });
        return;
      }
      const { hash } = await readArtifact(artifact.artifactPath);
      let session = store.findPendingByArtifact(artifact.artifactPath) ?? store.findOpenByArtifact(artifact.artifactPath);
      if (session) {
        session = await store.refreshContentHash(session.id, hash);
      } else {
        session = await store.create({ ...artifact, contentHash: hash });
      }
      ensureWatcher(session);
      response.json({
        session: summary(session),
        cursor: session.deliveredFeedbackSequence,
      });
    }),
  );

  app.get("/api/agent/sessions", requireAgentToken, (_request, response) => {
    response.json({ sessions: store.list().map(summary) });
  });

  app.get(
    "/api/agent/sessions/:id/wait",
    requireAgentToken,
    asyncRoute(async (request, response) => {
      const id = routeParameter(request.params.id);
      if (!store.get(id)) {
        response.status(404).json({ error: "Unknown Agent HTML Render session." });
        return;
      }
      const after = parseCursor(request.query.after);
      const explicitAcknowledgement = request.header(FEEDBACK_ACK_HEADER) === EXPLICIT_FEEDBACK_ACK_CAPABILITY;
      const immediate = store.nextUndelivered(id, after);
      if (immediate) {
        if (!explicitAcknowledgement) await store.markDelivered(id, immediate.sequence);
        response.json(immediate);
        return;
      }

      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        unsubscribe();
      };
      const finish = (delivery?: FeedbackDelivery): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!delivery) {
          response.status(204).end();
          return;
        }
        if (explicitAcknowledgement) {
          response.json(delivery);
          return;
        }
        void store
          .markDelivered(id, delivery.sequence)
          .then(() => response.json(delivery))
          .catch((error: unknown) => response.status(500).json({ error: String(error) }));
      };
      const unsubscribe = store.onFeedback(id, (delivery) => {
        if (delivery.sequence > after) finish(delivery);
      });
      const timeout = setTimeout(() => finish(), LONG_POLL_MILLISECONDS);
      response.on("close", () => {
        if (!settled) {
          settled = true;
          cleanup();
        }
      });
    }),
  );

  app.post(
    "/api/agent/sessions/:id/ack",
    requireAgentToken,
    asyncRoute(async (request, response) => {
      const id = routeParameter(request.params.id);
      if (!store.get(id)) {
        response.status(404).json({ error: "Unknown Agent HTML Render session." });
        return;
      }
      const { sequence } = parseFeedbackAckBody(request.body);
      await store.markDelivered(id, sequence);
      response.json({ deliveredFeedbackSequence: store.get(id)?.deliveredFeedbackSequence ?? 0 });
    }),
  );

  app.post("/api/agent/stop", requireAgentToken, (_request, response) => {
    response.json({ status: "stopping" });
    setTimeout(() => void close(), 20).unref();
  });

  app.use("/assets", (request, response) => {
    const relativePath = request.path.replace(/^\/+/, "");
    const asset = uiSnapshot.assets.get(relativePath);
    if (!asset) {
      response.status(404).json({ error: "Unknown review-shell asset." });
      return;
    }
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.type(relativePath).send(asset);
  });

  app.get("/session/:id", (request, response) => {
    const session = requireReviewSession(request, response);
    if (!session) return;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    response.type("html").send(uiIndexHtml);
  });

  app.get("/api/review/:id/state", (request, response) => {
    const session = requireReviewSession(request, response);
    if (!session) return;
    response.setHeader("Cache-Control", "no-store");
    response.json(store.getPublicState(session.id));
  });

  app.get(
    "/api/review/:id/artifact",
    asyncRoute(async (request, response) => {
      const session = requireReviewSession(request, response);
      if (!session) return;
      const { content, hash } = await readArtifact(session.artifactPath);
      await store.refreshContentHash(session.id, hash);
      const transformed = renderSandboxedArtifact(
        content,
        { sessionId: session.id, token: session.bridgeToken, parentOrigin: origin },
        bridgeSource,
      );
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.send(transformed);
    }),
  );

  app.get("/api/review/:id/events", (request, response) => {
    const session = requireReviewSession(request, response);
    if (!session) return;
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const currentCount = connectedReviewers.get(session.id) ?? 0;
    connectedReviewers.set(session.id, currentCount + 1);
    sendSse(response, "state", store.getPublicState(session.id));
    const unsubscribe = store.onReview(session.id, (event: ReviewEvent) => sendSse(response, event.type, event));
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), SSE_HEARTBEAT_MILLISECONDS);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      const nextCount = Math.max(0, (connectedReviewers.get(session.id) ?? 1) - 1);
      if (nextCount === 0) connectedReviewers.delete(session.id);
      else connectedReviewers.set(session.id, nextCount);
    };
    response.on("close", cleanup);
  });

  app.put(
    "/api/review/:id/draft",
    asyncRoute(async (request, response) => {
      const session = requireReviewSession(request, response);
      if (!session) return;
      const draft = parseReviewDraft(request.body);
      await store.updateDraft(session.id, draft);
      response.json({ draft });
    }),
  );

  app.post(
    "/api/review/:id/send",
    asyncRoute(async (request, response) => {
      const session = requireReviewSession(request, response);
      if (!session) return;
      const { draft, end } = parseSendBody(request.body);
      const delivery = await store.sendFeedback(session.id, draft, end);
      if (end) {
        const watcher = watchers.get(session.id);
        if (watcher) {
          await watcher.close();
          watchers.delete(session.id);
        }
      }
      response.json(delivery);
    }),
  );

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected Agent HTML Render server error.";
    const status = message.includes("Unknown Agent HTML Render session") || message.includes("has ended") ? 409 : 400;
    if (!response.headersSent) response.status(status).json({ error: message });
  });

  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolvePromise();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Agent HTML Render could not determine its listening port.");
  origin = `http://127.0.0.1:${address.port}`;
  for (const session of store.list()) ensureWatcher(session);

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.all(Array.from(watchers.values(), (watcher) => watcher.close()));
    watchers.clear();
    await new Promise<void>((resolvePromise, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolvePromise()));
      httpServer.closeAllConnections();
    });
  };

  return {
    rootPath,
    port: address.port,
    origin,
    token,
    packageVersion: runtimeBuild.packageVersion,
    buildId: runtimeBuild.buildId,
    store,
    close,
  };
}
