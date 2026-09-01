import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { dirname, resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  EXPLICIT_FEEDBACK_ACK_CAPABILITY,
  FEEDBACK_ACK_HEADER,
  isFeedbackConsumerId,
  type ReviewEvent,
} from "../shared/protocol.js";
import { readArtifact, renderSandboxedArtifact, resolveArtifact, resolveRoot } from "./artifact.js";
import {
  createRuntimeBuildIdentity,
  DEFAULT_BRIDGE_PATH,
  DEFAULT_UI_DIRECTORY,
  readNodeRuntimeSnapshot,
  readUiRuntimeSnapshot,
} from "./build.js";
import {
  RevisionConflictError,
  SessionStore,
  SessionStoreProcessTerminationRequiredError,
  SubmissionConflictError,
  type FeedbackLeaseResult,
  type SessionRecord,
} from "./store.js";
import type { PinnedStateBoundary } from "./state-boundary.js";
import {
  parseChangeReviewBody,
  parseDraftBody,
  parseFeedbackAckBody,
  parseFeedbackLeaseReleaseBody,
  parseFeedbackLeaseRenewalBody,
  parseSendBody,
} from "./validation.js";

const LONG_POLL_MILLISECONDS = 25_000;
const SSE_HEARTBEAT_MILLISECONDS = 15_000;
const WATCHER_READY_TIMEOUT_MILLISECONDS = 5_000;
const WATCHER_CLOSE_TIMEOUT_MILLISECONDS = 250;
const SERVER_CLEANUP_TIMEOUT_MILLISECONDS = 750;
const STARTUP_COORDINATOR_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

export interface StartServerOptions {
  rootPath: string;
  port?: number;
  token?: string;
  uiDirectory?: string;
  bridgeSource?: string;
  expectedStateBoundary?: PinnedStateBoundary;
  startupCoordinatorId?: string;
  watcherFactory?: typeof chokidar.watch;
}

export interface AgentSessionSummary {
  id: string;
  status: "open" | "ended" | "superseded";
  artifactRelativePath: string;
  revision: number;
  deliveredFeedbackSequence: number;
  connectedReviewers: number;
  reviewUrl: string;
}

export interface RunningServer {
  rootPath: string;
  rootDevice: string;
  rootInode: string;
  stateDevice: string;
  stateInode: string;
  sessionsDevice: string;
  sessionsInode: string;
  port: number;
  origin: string;
  token: string;
  packageVersion: string;
  buildId: string;
  store: SessionStore;
  watchedSessionIds: () => string[];
  closed: Promise<boolean>;
  close: () => Promise<void>;
}

export class ServerProcessTerminationRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServerProcessTerminationRequiredError";
  }
}

interface WatcherRegistration {
  watcher: FSWatcher;
  refresh: (changedPath: string) => void;
  handleError: (error: unknown) => void;
  active: boolean;
  inFlight: Set<Promise<void>>;
  cleanup?: Promise<void>;
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

function rawQueryParameters(request: Request): URLSearchParams {
  const queryStart = request.originalUrl.indexOf("?");
  return new URLSearchParams(queryStart >= 0 ? request.originalUrl.slice(queryStart + 1) : "");
}

function hasStructuredQueryParameterAlias(parameters: URLSearchParams, name: string): boolean {
  return Array.from(parameters.keys()).some(
    (key) =>
      key.startsWith(`${name}[`) || key.startsWith(`${name}.`) || key.startsWith(`${name}\0`),
  );
}

function parseCursor(parameters: URLSearchParams): number | undefined {
  if (hasStructuredQueryParameterAlias(parameters, "after")) return undefined;
  const values = parameters.getAll("after");
  if (values.length === 0) return 0;
  if (values.length !== 1) return undefined;
  const value = values[0];
  if (!value || value.length > 16 || !/^[0-9]+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
  const selectedRoot = await resolveRoot(await realpath(resolve(options.rootPath)));
  const { rootPath } = selectedRoot;
  const token = options.token ?? randomBytes(24).toString("base64url");
  const uiDirectory = options.uiDirectory ?? DEFAULT_UI_DIRECTORY;
  if (
    options.startupCoordinatorId !== undefined &&
    !STARTUP_COORDINATOR_ID_PATTERN.test(options.startupCoordinatorId)
  ) throw new Error("The startup coordinator identity is invalid.");
  const [uiSnapshot, bridgeSource, nodeRuntimeSources] = await Promise.all([
    readUiRuntimeSnapshot(uiDirectory),
    options.bridgeSource === undefined ? readFile(DEFAULT_BRIDGE_PATH, "utf8") : options.bridgeSource,
    readNodeRuntimeSnapshot(),
  ]);
  const uiIndexHtml = uiSnapshot.indexHtml;
  const runtimeBuild = createRuntimeBuildIdentity(
    uiIndexHtml,
    bridgeSource,
    uiSnapshot.assets,
    nodeRuntimeSources,
  );
  const watcherFactory = options.watcherFactory ?? chokidar.watch;

  const store = new SessionStore(rootPath, {
    ...(options.expectedStateBoundary
      ? { expectedStateBoundary: options.expectedStateBoundary }
      : {}),
  });
  await store.initialize();
  const initializedRoot = await resolveRoot(rootPath);
  if (
    initializedRoot.rootDevice !== selectedRoot.rootDevice ||
    initializedRoot.rootInode !== selectedRoot.rootInode
  ) {
    throw new Error("The selected project root changed while Agent HTML Render was starting.");
  }
  const watchers = new Map<string, WatcherRegistration>();
  const retiringWatchers = new Set<WatcherRegistration>();
  const inFlightMutations = new Set<Promise<unknown>>();
  const connectedReviewers = new Map<string, number>();
  const app = express();
  const httpServer: HttpServer = createServer(app);
  let origin = "";
  let closing = false;
  let resolveClosed = (_clean: boolean): void => undefined;
  const closed = new Promise<boolean>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  let sessionOpenQueue = Promise.resolve();
  let terminalCleanupFailure: unknown;
  let terminalCloseScheduled = false;

  const settleWithinTimeout = async (
    work: Promise<unknown>,
    milliseconds: number,
    timeoutMessage: string,
  ): Promise<void> => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolvePromise, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(timeoutMessage));
          }, milliseconds);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const detachWatcherCallbacks = (registration: WatcherRegistration): void => {
    registration.active = false;
    registration.watcher.off("add", registration.refresh);
    registration.watcher.off("change", registration.refresh);
  };

  const settleWatcherRegistration = async (registration: WatcherRegistration): Promise<void> => {
    if (registration.cleanup) {
      await registration.cleanup;
      return;
    }
    const cleanup = settleWithinTimeout(
      Promise.all([
        registration.watcher.close(),
        Promise.allSettled(Array.from(registration.inFlight)),
      ]),
      WATCHER_CLOSE_TIMEOUT_MILLISECONDS,
      "A filesystem watcher and its in-flight revision work did not settle within 250 milliseconds.",
    );
    registration.cleanup = cleanup;
    try {
      await cleanup;
      registration.watcher.off("error", registration.handleError);
    } finally {
      if (registration.cleanup === cleanup) registration.cleanup = undefined;
    }
  };

  const scheduleProcessTerminalClose = (error: unknown): void => {
    terminalCleanupFailure ??= error;
    if (terminalCloseScheduled) return;
    terminalCloseScheduled = true;
    setTimeout(() => void close().catch(() => undefined), 0).unref();
  };

  const trackMutation = <Value>(work: () => Promise<Value>): Promise<Value> => {
    if (closing) return Promise.reject(new Error("Agent HTML Render is stopping and cannot accept new state changes."));
    const operation = work().catch((error: unknown) => {
      if (error instanceof SessionStoreProcessTerminationRequiredError) {
        scheduleProcessTerminalClose(error);
      }
      throw error;
    });
    inFlightMutations.add(operation);
    void operation
      .finally(() => inFlightMutations.delete(operation))
      .catch(() => undefined);
    return operation;
  };

  const mutatingAsyncRoute = (
    handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
  ): ((request: Request, response: Response, next: NextFunction) => void) =>
    asyncRoute((request, response, next) => trackMutation(() => handler(request, response, next)));

  const serializeSessionOpen = async <Value>(work: () => Promise<Value>): Promise<Value> => {
    const previous = sessionOpenQueue;
    let release = (): void => undefined;
    sessionOpenQueue = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

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
    deliveredFeedbackSequence: session.deliveredFeedbackSequence,
    connectedReviewers: connectedReviewers.get(session.id) ?? 0,
    reviewUrl: `${origin}/session/${session.id}?access=${encodeURIComponent(session.secret)}`,
  });

  const sessionMatchesArtifactParent = (
    session: SessionRecord,
    artifact: { parentDevice: string; parentInode: string },
  ): boolean =>
    session.parentDevice === artifact.parentDevice && session.parentInode === artifact.parentInode;

  const draftHasReviewerIntent = (session: SessionRecord): boolean =>
    Boolean(session.draft.message.trim()) ||
    session.draft.annotations.length > 0 ||
    (session.draft.requeuedMessageSequences?.length ?? 0) > 0;

  const closeWatcher = async (sessionId: string): Promise<void> => {
    const registration = watchers.get(sessionId);
    if (!registration) return;
    watchers.delete(sessionId);
    detachWatcherCallbacks(registration);
    retiringWatchers.add(registration);
    try {
      await settleWatcherRegistration(registration);
      retiringWatchers.delete(registration);
    } catch (error) {
      scheduleProcessTerminalClose(error);
      throw new ServerProcessTerminationRequiredError(
        "A filesystem watcher could not retire cleanly; the daemon process must terminate before ownership is released.",
        { cause: error },
      );
    }
  };

  const ensureWatcher = async (session: SessionRecord): Promise<void> => {
    if (closing || terminalCleanupFailure) {
      throw new Error("Agent HTML Render is stopping and cannot create another filesystem watcher.");
    }
    if (watchers.has(session.id) || session.status !== "open") return;
    const watcher = watcherFactory(dirname(session.artifactPath), {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    let registration: WatcherRegistration;
    let watcherReady = false;
    const refresh = (changedPath: string): void => {
      if (!registration.active || resolve(changedPath) !== session.artifactPath) return;
      const operation = trackMutation(async () => {
        const { hash } = await readArtifact(session);
        if (!registration.active) return;
        await store.bumpRevision(session.id, hash);
      })
        .catch(() => undefined);
      registration.inFlight.add(operation);
      void operation.finally(() => registration.inFlight.delete(operation));
    };
    const handleError = (error: unknown): void => {
      if (!watcherReady || !registration.active) return;
      watchers.delete(session.id);
      detachWatcherCallbacks(registration);
      retiringWatchers.add(registration);
      scheduleProcessTerminalClose(error);
    };
    registration = { watcher, refresh, handleError, active: true, inFlight: new Set() };
    watcher.on("add", refresh);
    watcher.on("change", refresh);
    watcher.on("error", handleError);
    watchers.set(session.id, registration);
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const cleanup = (): void => {
          clearTimeout(timeout);
          watcher.off("ready", onReady);
          watcher.off("error", onError);
        };
        const onReady = (): void => {
          watcherReady = true;
          cleanup();
          resolvePromise();
        };
        const onError = (error: unknown): void => {
          cleanup();
          reject(error);
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("A filesystem watcher did not become ready within 5 seconds."));
        }, WATCHER_READY_TIMEOUT_MILLISECONDS);
        watcher.once("ready", onReady);
        watcher.once("error", onError);
      });
    } catch (error) {
      watchers.delete(session.id);
      detachWatcherCallbacks(registration);
      retiringWatchers.add(registration);
      try {
        await settleWatcherRegistration(registration);
        retiringWatchers.delete(registration);
      } catch (cleanupError) {
        scheduleProcessTerminalClose(cleanupError);
        throw new ServerProcessTerminationRequiredError(
          "A failed filesystem watcher could not be closed; the daemon process must terminate before ownership is released.",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
      throw error;
    }
  };

  const restoredSessionParentIsCurrent = async (session: SessionRecord): Promise<boolean> => {
    try {
      const parentPath = dirname(session.artifactPath);
      const [currentRoot, currentParentPath, parentDetails] = await Promise.all([
        resolveRoot(rootPath),
        realpath(parentPath),
        stat(parentPath, { bigint: true }),
      ]);
      return (
        currentRoot.rootPath === session.rootPath &&
        currentRoot.rootDevice === session.rootDevice &&
        currentRoot.rootInode === session.rootInode &&
        currentParentPath === parentPath &&
        parentDetails.isDirectory() &&
        parentDetails.dev.toString() === session.parentDevice &&
        parentDetails.ino.toString() === session.parentInode &&
        resolve(rootPath, session.artifactRelativePath) === session.artifactPath
      );
    } catch {
      return false;
    }
  };

  app.get(
    "/api/health",
    requireAgentToken,
    asyncRoute(async (_request, response) => {
      let rootIdentityCurrent = false;
      try {
        const currentRoot = await resolveRoot(rootPath);
        rootIdentityCurrent =
          currentRoot.rootDevice === selectedRoot.rootDevice &&
          currentRoot.rootInode === selectedRoot.rootInode;
      } catch {
        rootIdentityCurrent = false;
      }
      const storageIdentity = await store.inspectStorageIdentity();
      response.json({
        name: "agent-html-render",
        protocolVersion: "1",
        capabilities: [EXPLICIT_FEEDBACK_ACK_CAPABILITY],
        packageVersion: runtimeBuild.packageVersion,
        buildId: runtimeBuild.buildId,
        rootPath,
        rootDevice: selectedRoot.rootDevice,
        rootInode: selectedRoot.rootInode,
        rootIdentityCurrent,
        stateDevice: storageIdentity.stateDevice,
        stateInode: storageIdentity.stateInode,
        sessionsDevice: storageIdentity.sessionsDevice,
        sessionsInode: storageIdentity.sessionsInode,
        stateIdentityCurrent: storageIdentity.current,
        ...(options.startupCoordinatorId
          ? { startupCoordinatorId: options.startupCoordinatorId }
          : {}),
        pid: process.pid,
      });
    }),
  );

  app.post(
    "/api/agent/sessions",
    requireAgentToken,
    mutatingAsyncRoute(async (request, response) => {
      const requestedRoot = typeof request.body?.rootPath === "string" ? request.body.rootPath : rootPath;
      const artifactInput = request.body?.artifactPath;
      if (typeof artifactInput !== "string") {
        response.status(400).json({ error: "artifactPath is required." });
        return;
      }
      const result = await serializeSessionOpen(async () => {
        const artifact = await resolveArtifact(requestedRoot, artifactInput);
        if (
          artifact.rootPath !== rootPath ||
          artifact.rootDevice !== selectedRoot.rootDevice ||
          artifact.rootInode !== selectedRoot.rootInode
        ) {
          return { wrongRoot: true } as const;
        }
        const newSession = request.body?.newSession === true;
        const pendingSession = store.findPendingByArtifact(artifact.artifactPath);
        let session: SessionRecord | undefined;
        let artifactAvailable = true;
        let warning: string | undefined;
        if (pendingSession && !sessionMatchesArtifactParent(pendingSession, artifact)) {
          // Preserve already-committed reviewer intent. The CLI can deliver and acknowledge
          // this batch without pretending that the replacement artifact belongs to the old
          // session or opening an unusable review URL.
          session = pendingSession;
          await closeWatcher(pendingSession.id);
          artifactAvailable = false;
          warning =
            "The artifact parent changed after this feedback was sent. Delivering the pending feedback without reopening the old artifact; run review --new afterward to review the replacement.";
        } else {
          const { hash } = await readArtifact(artifact);
          session = pendingSession ?? store.findOpenByArtifact(
            artifact.artifactPath,
            artifact.parentDevice,
            artifact.parentInode,
          );
          if (session) {
            if (session.recoveredFromSessionId) {
              await store.reconcileRecoveryTransfer(session.id);
              await closeWatcher(session.recoveredFromSessionId);
            }
            session = await store.refreshContentHash(session.id, hash);
          } else {
            const replacedOpenSession = store.findOpenByArtifact(artifact.artifactPath);
            if (replacedOpenSession && !newSession) {
              await closeWatcher(replacedOpenSession.id);
              return {
                changedParentSessionId: replacedOpenSession.id,
                recoverableDraft: draftHasReviewerIntent(replacedOpenSession),
              } as const;
            }
            const ended = store.findLatestEndedByArtifact(artifact.artifactPath);
            if (ended && !newSession) return { endedSessionId: ended.id } as const;
            const recoverNotes = Boolean(replacedOpenSession && draftHasReviewerIntent(replacedOpenSession));
            session = recoverNotes && replacedOpenSession
              ? await store.createRecoverySession({ ...artifact, contentHash: hash }, replacedOpenSession.id)
              : await store.create({ ...artifact, contentHash: hash });
            if (replacedOpenSession) await closeWatcher(replacedOpenSession.id);
            if (recoverNotes) {
              warning =
                `Recovered unsent notes from preserved session ${replacedOpenSession?.id}. ` +
                "Those notes moved here once; review the replacement artifact, then explicitly keep them for its current revision before sending.";
            }
          }
        }
        if (artifactAvailable) await ensureWatcher(session);
        return {
          session: summary(session),
          cursor: session.deliveredFeedbackSequence,
          artifactAvailable,
          ...(warning ? { warning } : {}),
        } as const;
      });
      if ("wrongRoot" in result) {
        response.status(400).json({ error: "This daemon belongs to a different project root." });
        return;
      }
      if ("endedSessionId" in result) {
        response.status(409).json({
          error: "The previous review ended. Start a new review explicitly with --new.",
          endedSessionId: result.endedSessionId,
        });
        return;
      }
      if ("changedParentSessionId" in result) {
        response.status(409).json({
          code: "artifact_parent_changed",
          error:
            result.recoverableDraft
              ? "The artifact parent changed since this open review began. Restore the original directory to resume it, or rerun with --new to open the replacement with the preserved unsent notes; you must review and explicitly rebase them before sending."
              : "The artifact parent changed since this open review began. Restore the original directory to resume it, or rerun with --new to start a separate review; the original session remains preserved.",
          existingSessionId: result.changedParentSessionId,
          recoverableDraft: result.recoverableDraft,
        });
        return;
      }
      response.json(result);
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
      if (request.header(FEEDBACK_ACK_HEADER) !== EXPLICIT_FEEDBACK_ACK_CAPABILITY) {
        response.status(428).json({
          error:
            `Feedback delivery requires ${FEEDBACK_ACK_HEADER}: ${EXPLICIT_FEEDBACK_ACK_CAPABILITY} ` +
            "and a separate exact-grant acknowledgement.",
        });
        return;
      }
      const parameters = rawQueryParameters(request);
      const after = parseCursor(parameters);
      if (after === undefined) {
        response.status(400).json({
          error: "Feedback delivery requires after to be a complete non-negative safe-integer decimal cursor.",
        });
        return;
      }
      const consumerValues = parameters.getAll("consumer");
      const requestedConsumerId =
        !hasStructuredQueryParameterAlias(parameters, "consumer") && consumerValues.length === 1
          ? consumerValues[0]
          : undefined;
      if (!isFeedbackConsumerId(requestedConsumerId)) {
        response.status(400).json({
          error:
            "Feedback delivery requires a valid consumer query parameter: 1-120 letters, digits, periods, " +
            "underscores, colons, or hyphens, beginning with a letter or digit.",
        });
        return;
      }
      const consumerId = requestedConsumerId;

      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        clearInterval(retryInterval);
        unsubscribe();
      };
      const finish = (leased?: FeedbackLeaseResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const delivery = leased?.delivery;
        if (!delivery) {
          response.status(204).end();
          return;
        }
        const leaseId = leased.leaseId;
        response.json({ ...delivery, leaseId });
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error instanceof SessionStoreProcessTerminationRequiredError) {
          scheduleProcessTerminalClose(error);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) response.status(500).json({ error: message });
      };
      const attemptDelivery = (): void => {
        if (settled) return;
        try {
          const leased = store.leaseNextUndelivered(id, after, consumerId);
          if (leased.delivery) finish(leased);
        } catch (error) {
          fail(error);
        }
      };
      const unsubscribe = store.onFeedback(id, attemptDelivery);
      const timeout = setTimeout(() => finish(), LONG_POLL_MILLISECONDS);
      const retryInterval = setInterval(attemptDelivery, 250);
      response.on("close", () => {
        if (!settled) {
          settled = true;
          cleanup();
        }
      });
      attemptDelivery();
    }),
  );

  app.post(
    "/api/agent/sessions/:id/ack",
    requireAgentToken,
    mutatingAsyncRoute(async (request, response) => {
      const id = routeParameter(request.params.id);
      if (!store.get(id)) {
        response.status(404).json({ error: "Unknown Agent HTML Render session." });
        return;
      }
      const { sequence, consumerId, leaseId } = parseFeedbackAckBody(request.body);
      await store.markDelivered(id, sequence, consumerId, leaseId);
      response.json({ deliveredFeedbackSequence: store.get(id)?.deliveredFeedbackSequence ?? 0 });
    }),
  );

  app.post(
    "/api/agent/sessions/:id/renew-lease",
    requireAgentToken,
    mutatingAsyncRoute(async (request, response) => {
      const id = routeParameter(request.params.id);
      if (!store.get(id)) {
        response.status(404).json({ error: "Unknown Agent HTML Render session." });
        return;
      }
      const { sequence, consumerId, leaseId } = parseFeedbackLeaseRenewalBody(request.body);
      const expiresAt = await store.renewFeedbackLease(id, sequence, consumerId, leaseId);
      response.json({
        renewed: expiresAt !== undefined,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
    }),
  );

  app.post(
    "/api/agent/sessions/:id/release-lease",
    requireAgentToken,
    mutatingAsyncRoute(async (request, response) => {
      const id = routeParameter(request.params.id);
      if (!store.get(id)) {
        response.status(404).json({ error: "Unknown Agent HTML Render session." });
        return;
      }
      const { sequence, consumerId, leaseId } = parseFeedbackLeaseReleaseBody(request.body);
      response.json({ released: await store.releaseFeedbackLease(id, sequence, consumerId, leaseId) });
    }),
  );

  app.post("/api/agent/stop", requireAgentToken, (_request, response) => {
    response.json({ status: "stopping" });
    setTimeout(() => void close().catch(() => undefined), 20).unref();
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
    mutatingAsyncRoute(async (request, response) => {
      const session = requireReviewSession(request, response);
      if (!session) return;
      const { content, hash } = await readArtifact(session);
      await store.refreshContentHash(session.id, hash);
      const transformed = renderSandboxedArtifact(
        content,
        { sessionId: session.id, token: session.bridgeToken, parentOrigin: origin },
        bridgeSource,
      );
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Security-Policy", transformed.contentSecurityPolicy);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.send(transformed.html);
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
    const unsubscribe = store.onReview(session.id, (event: ReviewEvent) => {
      sendSse(response, event.type, event);
      sendSse(response, "state", store.getPublicState(session.id));
    });
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
    mutatingAsyncRoute(async (request, response) => {
      const session = requireReviewSession(request, response);
      if (!session) return;
      const { draft, baseRevision, baseContentHash, clientId, confirmRecovery } = parseDraftBody(request.body);
      await store.updateDraft(session.id, draft, baseRevision, baseContentHash, clientId, confirmRecovery);
      response.json({ draft, baseRevision, baseContentHash });
    }),
  );

  app.post(
    "/api/review/:id/send",
    mutatingAsyncRoute(async (request, response) => {
      const session = requireReviewSession(request, response);
      if (!session) return;
      const { draft, end, baseRevision, baseContentHash, submissionId } = parseSendBody(request.body);
      const replay = store.replayFeedback(session.id, draft, end, baseRevision, baseContentHash, submissionId);
      if (replay) {
        response.json(replay);
        return;
      }
      const { hash } = await readArtifact(session);
      await store.refreshContentHash(session.id, hash);
      const delivery = await store.sendFeedback(
        session.id,
        draft,
        end,
        baseRevision,
        baseContentHash,
        submissionId,
      );
      if (end) {
        try {
          await closeWatcher(session.id);
        } catch {
          // Feedback is already durable. Return the receipt while terminal cleanup
          // keeps lifetime ownership until the process exits.
        }
      }
      response.json(delivery);
    }),
  );

  app.patch(
    "/api/review/:id/feedback/:sequence/annotations/:annotationId",
    mutatingAsyncRoute(async (request, response) => {
      const session = requireReviewSession(request, response);
      if (!session) return;
      const sequence = Number.parseInt(routeParameter(request.params.sequence), 10);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        response.status(400).json({ error: "Feedback sequence must be a positive integer." });
        return;
      }
      const annotationId = routeParameter(request.params.annotationId);
      const { decision, requeue } = parseChangeReviewBody(request.body);
      const state = await store.reviewFeedback(session.id, sequence, annotationId, decision, requeue);
      response.json({ state });
    }),
  );

  app.patch(
    "/api/review/:id/feedback/:sequence/message",
    mutatingAsyncRoute(async (request, response) => {
      const session = requireReviewSession(request, response);
      if (!session) return;
      const sequence = Number.parseInt(routeParameter(request.params.sequence), 10);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        response.status(400).json({ error: "Feedback sequence must be a positive integer." });
        return;
      }
      const { decision, requeue } = parseChangeReviewBody(request.body);
      const state = await store.reviewFeedbackMessage(session.id, sequence, decision, requeue);
      response.json({ state });
    }),
  );

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected Agent HTML Render server error.";
    const status =
      error instanceof RevisionConflictError ||
      error instanceof SubmissionConflictError ||
      message.includes("Unknown Agent HTML Render session") ||
      message.includes("has ended") ||
      message.includes("moved to a replacement")
        ? 409
        : 400;
    if (!response.headersSent) {
      response.status(status).json({
        error: message,
        ...(error instanceof RevisionConflictError
          ? {
              code: "revision_conflict",
              currentRevision: error.currentRevision,
              currentContentHash: error.currentContentHash,
            }
          : error instanceof SubmissionConflictError
            ? { code: "submission_conflict" }
            : {}),
      });
    }
  });

  const close = async (): Promise<void> => {
    if (closing) {
      if (!(await closed)) {
        throw new ServerProcessTerminationRequiredError(
          "Agent HTML Render server cleanup did not complete; the daemon process must terminate.",
        );
      }
      return;
    }
    closing = true;
    const registrations = Array.from(new Set([
      ...watchers.values(),
      ...retiringWatchers,
    ]));
    watchers.clear();
    for (const registration of registrations) detachWatcherCallbacks(registration);
    const cleanupTasks: Promise<unknown>[] = [];
    if (httpServer.listening) {
      cleanupTasks.push(settleWithinTimeout(
        new Promise<void>((resolvePromise, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolvePromise()));
          httpServer.closeAllConnections();
        }),
        SERVER_CLEANUP_TIMEOUT_MILLISECONDS,
        "The HTTP listener did not close within 750 milliseconds.",
      ));
    }
    cleanupTasks.push(...registrations.map((registration) =>
      settleWatcherRegistration(registration)
        .then(() => retiringWatchers.delete(registration))));
    cleanupTasks.push(settleWithinTimeout(
      Promise.allSettled(Array.from(inFlightMutations)),
      SERVER_CLEANUP_TIMEOUT_MILLISECONDS,
      "In-flight state changes did not settle within 750 milliseconds.",
    ));
    let closeFailure = terminalCleanupFailure;
    try {
      const cleanupResults = await Promise.allSettled(cleanupTasks);
      const failedCleanup = cleanupResults.find((result) => result.status === "rejected");
      closeFailure ??= terminalCleanupFailure;
      if (!closeFailure && failedCleanup?.status === "rejected") closeFailure = failedCleanup.reason;
    } finally {
      resolveClosed(closeFailure === undefined && terminalCleanupFailure === undefined);
    }
    if (closeFailure || terminalCleanupFailure) {
      throw new ServerProcessTerminationRequiredError(
        "Agent HTML Render server cleanup did not complete; the daemon process must terminate.",
        { cause: closeFailure ?? terminalCleanupFailure },
      );
    }
  };

  let listeningPort: number | undefined;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(options.port ?? 0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolvePromise();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Agent HTML Render could not determine its listening port.");
    }
    listeningPort = address.port;
    origin = `http://127.0.0.1:${listeningPort}`;
    for (const session of store.list()) {
      if (await restoredSessionParentIsCurrent(session)) await ensureWatcher(session);
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      if (error instanceof ServerProcessTerminationRequiredError) throw error;
      throw new ServerProcessTerminationRequiredError(
        "Agent HTML Render startup cleanup did not complete; the daemon process must terminate.",
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    throw error;
  }
  if (listeningPort === undefined) throw new Error("Agent HTML Render did not bind a listening port.");
  const storageIdentity = await store.inspectStorageIdentity();

  return {
    rootPath,
    rootDevice: selectedRoot.rootDevice,
    rootInode: selectedRoot.rootInode,
    stateDevice: storageIdentity.stateDevice,
    stateInode: storageIdentity.stateInode,
    sessionsDevice: storageIdentity.sessionsDevice,
    sessionsInode: storageIdentity.sessionsInode,
    port: listeningPort,
    origin,
    token,
    packageVersion: runtimeBuild.packageVersion,
    buildId: runtimeBuild.buildId,
    store,
    watchedSessionIds: () => Array.from(watchers.keys()),
    closed,
    close,
  };
}
