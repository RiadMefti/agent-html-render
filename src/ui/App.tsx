import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BridgeToParentMessage,
  DraftAnnotation,
  FeedbackDelivery,
  FeedbackReceipt,
  ParentToBridgeMessage,
  ParentToBridgePayload,
  PublicSessionState,
  ReviewEvent,
  ReviewDraft,
  TargetDescriptor,
} from "../shared/protocol.js";
import { isBridgeToParentMessage, isReviewEvent } from "../shared/guards.js";

const EMPTY_DRAFT: ReviewDraft = { message: "", annotations: [] };

type ActivityKind = "ready" | "sending" | "queued" | "working" | "updated" | "failed" | "offline" | "ended";

interface ReviewActivity {
  kind: ActivityKind;
  label: string;
  detail: string;
  meta: string;
}

function feedbackReceipt(delivery: FeedbackDelivery): FeedbackReceipt {
  return {
    sequence: delivery.sequence,
    status: delivery.feedback.status,
    sentAt: delivery.feedback.sentAt,
    revision: delivery.feedback.session.revision,
  };
}

function sentTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function reviewActivity(
  session: PublicSessionState,
  connected: boolean,
  busy: boolean,
  sendError: string | null,
): ReviewActivity {
  if (session.status === "ended") {
    return {
      kind: "ended",
      label: "Review complete",
      detail: "Final feedback was sent. This session will not reopen automatically.",
      meta: `r${session.revision}`,
    };
  }
  if (busy) {
    return {
      kind: "sending",
      label: "Sending feedback",
      detail: "Agent HTML Render is saving and delivering your notes. They will stay in the drawer until this succeeds.",
      meta: `r${session.revision}`,
    };
  }
  if (sendError) {
    return {
      kind: "failed",
      label: "Send failed",
      detail: `${sendError} Your notes are still here; retry when ready.`,
      meta: `r${session.revision}`,
    };
  }
  if (!connected) {
    return {
      kind: "offline",
      label: "Reconnecting",
      detail: "Live revision updates are paused. Agent HTML Render is retrying the local connection.",
      meta: `r${session.revision}`,
    };
  }

  const latest = session.latestFeedback;
  if (!latest) {
    return {
      kind: "ready",
      label: "Ready to review",
      detail: "Select an element or text, add a note, then send the batch to the agent.",
      meta: `r${session.revision}`,
    };
  }
  if (session.revision > latest.revision) {
    return {
      kind: "updated",
      label: `Revision ${session.revision} ready`,
      detail: `The artifact changed after feedback ${latest.sequence}. Review the update or send another note.`,
      meta: `r${session.revision}`,
    };
  }
  if (session.deliveredFeedbackSequence >= latest.sequence) {
    return {
      kind: "working",
      label: "Agent received feedback",
      detail: `Feedback ${latest.sequence} is with the agent. Waiting for revision ${latest.revision + 1}; this page will update automatically.`,
      meta: sentTime(latest.sentAt),
    };
  }
  return {
    kind: "queued",
    label: "Feedback queued",
    detail: `Feedback ${latest.sequence} is saved. Waiting for an agent review command to pick it up.`,
    meta: sentTime(latest.sentAt),
  };
}

function parseReviewEvent(event: Event): ReviewEvent | undefined {
  try {
    const value: unknown = JSON.parse((event as MessageEvent<string>).data);
    return isReviewEvent(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sessionLocation(): { sessionId: string; access: string } {
  const match = window.location.pathname.match(/^\/session\/([^/]+)$/);
  const sessionId = match?.[1];
  const access = new URLSearchParams(window.location.search).get("access");
  if (!sessionId || !access) throw new Error("The Agent HTML Render session URL is incomplete.");
  return { sessionId: decodeURIComponent(sessionId), access };
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({ error: response.statusText }))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with HTTP ${response.status}.`);
  return body;
}

function targetTitle(target: TargetDescriptor): string {
  if (target.label) return target.label;
  if (target.text) return target.text;
  return `<${target.tag}>`;
}

function targetMeta(target: TargetDescriptor): string {
  const parts = [target.kind === "text" ? "Text selection" : `<${target.tag}>`];
  if (target.role) parts.push(target.role);
  if (target.stableId) parts.push(`#${target.stableId}`);
  return parts.join(" · ");
}

export function App(): React.JSX.Element {
  const location = useMemo(sessionLocation, []);
  const accessQuery = useMemo(() => `access=${encodeURIComponent(location.access)}`, [location.access]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const saveInFlight = useRef<Promise<void>>(Promise.resolve());
  const [session, setSession] = useState<PublicSessionState | null>(null);
  const [draft, setDraft] = useState<ReviewDraft>(EMPTY_DRAFT);
  const [selectedTarget, setSelectedTarget] = useState<TargetDescriptor | null>(null);
  const [comment, setComment] = useState("");
  const [selectionMode, setSelectionMode] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const stateUrl = `/api/review/${encodeURIComponent(location.sessionId)}/state?${accessQuery}`;

  const sendToBridge = useCallback(
    (message: ParentToBridgePayload) => {
      if (!session || !iframeRef.current?.contentWindow) return;
      iframeRef.current.contentWindow.postMessage(
        { source: "agent-html-render-shell", token: session.bridgeToken, ...message } satisfies ParentToBridgeMessage,
        "*",
      );
    },
    [session],
  );

  const showDraftTargets = useCallback(
    (nextDraft: ReviewDraft) => {
      sendToBridge({ type: "show-annotations", annotations: nextDraft.annotations });
    },
    [sendToBridge],
  );

  const persistDraft = useCallback(
    async (nextDraft: ReviewDraft) => {
      await jsonRequest(`/api/review/${encodeURIComponent(location.sessionId)}/draft?${accessQuery}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nextDraft),
      });
    },
    [accessQuery, location.sessionId],
  );

  useEffect(() => {
    let active = true;
    void jsonRequest<PublicSessionState>(stateUrl)
      .then((nextSession) => {
        if (!active) return;
        setSession(nextSession);
        setDraft(nextSession.draft);
      })
      .catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      active = false;
    };
  }, [stateUrl]);

  useEffect(() => {
    const source = new EventSource(`/api/review/${encodeURIComponent(location.sessionId)}/events?${accessQuery}`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("revision", (event) => {
      const revision = parseReviewEvent(event);
      if (!revision || revision.type !== "revision") {
        setError("Agent HTML Render received an invalid revision update.");
        return;
      }
      setSession((current) =>
        current
          ? {
              ...current,
              revision: revision.revision,
              contentHash: revision.contentHash,
              updatedAt: revision.updatedAt,
            }
          : current,
      );
      setSendError(null);
      setNotice(null);
    });
    source.addEventListener("status", (event) => {
      const status = parseReviewEvent(event);
      if (!status || status.type !== "status") {
        setError("Agent HTML Render received an invalid session update.");
        return;
      }
      setSession((current) =>
        current ? { ...current, status: status.status, updatedAt: status.updatedAt } : current,
      );
    });
    source.addEventListener("feedback-submitted", (event) => {
      const submitted = parseReviewEvent(event);
      if (!submitted || submitted.type !== "feedback-submitted") {
        setError("Agent HTML Render received an invalid feedback receipt.");
        return;
      }
      setSession((current) =>
        current
          ? {
              ...current,
              latestFeedback: submitted.receipt,
              updatedAt: submitted.updatedAt,
            }
          : current,
      );
      setSendError(null);
    });
    source.addEventListener("feedback-delivered", (event) => {
      const delivered = parseReviewEvent(event);
      if (!delivered || delivered.type !== "feedback-delivered") {
        setError("Agent HTML Render received an invalid delivery update.");
        return;
      }
      setSession((current) =>
        current
          ? {
              ...current,
              deliveredFeedbackSequence: Math.max(current.deliveredFeedbackSequence, delivered.sequence),
              updatedAt: delivered.updatedAt,
            }
          : current,
      );
    });
    return () => source.close();
  }, [accessQuery, location.sessionId]);

  useEffect(() => {
    if (!session) return;
    const listener = (event: MessageEvent<BridgeToParentMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message: unknown = event.data;
      if (!isBridgeToParentMessage(message, session.bridgeToken)) return;
      if (message.type === "ready") {
        sendToBridge({ type: "set-selection-mode", enabled: selectionMode });
        showDraftTargets(draft);
      } else if (message.type === "target-selected") {
        setSelectedTarget(message.target);
        setComment("");
        setPanelOpen(true);
      } else if (message.type === "anchor-resolutions") {
        setDraft((current) => ({
          ...current,
          annotations: current.annotations.map((annotation) => {
            const match = message.resolutions.find((resolution) => resolution.id === annotation.id);
            return match ? { ...annotation, resolution: match.resolution } : annotation;
          }),
        }));
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [draft, selectionMode, sendToBridge, session, showDraftTargets]);

  useEffect(() => {
    sendToBridge({ type: "set-selection-mode", enabled: selectionMode });
  }, [selectionMode, sendToBridge]);

  useEffect(() => {
    if (!session || session.status === "ended") return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const operation = saveInFlight.current.catch(() => undefined).then(() => persistDraft(draft));
      saveInFlight.current = operation;
      void operation.catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    }, 450);
    return () => window.clearTimeout(saveTimer.current);
  }, [draft, persistDraft, session]);

  const updateDraft = useCallback(
    (nextDraft: ReviewDraft) => {
      setDraft(nextDraft);
      showDraftTargets(nextDraft);
    },
    [showDraftTargets],
  );

  const addAnnotation = (): void => {
    if (!selectedTarget || !comment.trim()) return;
    const annotation: DraftAnnotation = {
      id: crypto.randomUUID(),
      comment: comment.trim(),
      createdAt: new Date().toISOString(),
      target: selectedTarget,
      resolution: "attached",
    };
    const nextDraft = { ...draft, annotations: [...draft.annotations, annotation] };
    updateDraft(nextDraft);
    setSelectedTarget(null);
    setComment("");
    sendToBridge({ type: "clear-selection" });
    setNotice("Annotation added to the queue.");
  };

  const clearSelection = (): void => {
    setSelectedTarget(null);
    setComment("");
    sendToBridge({ type: "clear-selection" });
  };

  const removeAnnotation = (id: string): void => {
    updateDraft({ ...draft, annotations: draft.annotations.filter((annotation) => annotation.id !== id) });
  };

  const sendFeedback = async (end: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    setSendError(null);
    setNotice(null);
    try {
      window.clearTimeout(saveTimer.current);
      await saveInFlight.current.catch(() => undefined);
      const delivery = await jsonRequest<FeedbackDelivery>(
        `/api/review/${encodeURIComponent(location.sessionId)}/send?${accessQuery}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ draft, end }),
        },
      );
      setDraft(EMPTY_DRAFT);
      setSelectedTarget(null);
      setComment("");
      showDraftTargets(EMPTY_DRAFT);
      const receipt = feedbackReceipt(delivery);
      setSession((current) =>
        current
          ? {
              ...current,
              latestFeedback: receipt,
              status: end ? "ended" : current.status,
              updatedAt: receipt.sentAt,
            }
          : current,
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setSendError(message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !session) {
    return (
      <main className="fatal-state">
        <div className="fatal-copy">
          <span className="state-brand">agent-html-render</span>
          <h1>Review unavailable</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="loading-state">
        <span className="state-brand">agent-html-render</span>
        <p>Opening Agent HTML Render…</p>
      </main>
    );
  }

  const artifactUrl = `/api/review/${encodeURIComponent(session.id)}/artifact?${accessQuery}&revision=${session.revision}`;
  const ended = session.status === "ended";
  const activity = reviewActivity(session, connected, busy, sendError);

  return (
    <main className="review-app">
      <header className="topbar">
        <div className="brand">
          <strong>agent-html-render</strong>
          <span aria-hidden="true">/</span>
          <span className="current-artifact" title={session.artifactRelativePath}>
            {session.artifactRelativePath}
          </span>
        </div>
        <nav className="review-nav" aria-label="Review controls">
          <span className="session-status">
            {connected ? "Live" : "Reconnecting"} · <span data-testid="revision">r{session.revision}</span>
          </span>
          <button
            className={`nav-action ${selectionMode ? "active" : ""}`}
            type="button"
            disabled={ended}
            onClick={() => setSelectionMode(true)}
          >
            Annotate
          </button>
          <button
            className={`nav-action ${selectionMode ? "" : "active"}`}
            type="button"
            disabled={ended}
            onClick={() => setSelectionMode(false)}
          >
            Interact
          </button>
          <button
            className={`nav-action ${panelOpen ? "active" : ""}`}
            type="button"
            aria-expanded={panelOpen}
            aria-controls="review-panel"
            onClick={() => setPanelOpen((current) => !current)}
          >
            Review{draft.annotations.length > 0 ? ` ${draft.annotations.length}` : ""}
          </button>
        </nav>
      </header>

      <section className="workspace">
        <div
          className="review-activity"
          data-state={activity.kind}
          data-testid="review-activity"
          role={activity.kind === "failed" ? "alert" : "status"}
          aria-live={activity.kind === "failed" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <strong>{activity.label}</strong>
          <span>{activity.detail}</span>
          <small>{activity.meta}</small>
        </div>
        <div className="artifact-stage">
          <div className="stage-heading">
            <span>{session.artifactName}</span>
            <span>
            {selectionMode ? "Click an element or select text to annotate" : "Interaction mode: artifact controls are active"}
            </span>
          </div>
          <iframe
            ref={iframeRef}
            key={session.revision}
            data-testid="artifact-frame"
            className="artifact-frame"
            title={`Review of ${session.artifactName}`}
            src={artifactUrl}
            sandbox="allow-scripts"
            onLoad={() => {
              sendToBridge({ type: "set-selection-mode", enabled: selectionMode });
              showDraftTargets(draft);
            }}
          />
          {ended ? (
            <div className="ended-overlay">
              <div>
                <span className="state-brand">agent-html-render</span>
                <h1>Review complete</h1>
                <p>Final feedback was sent to the agent.</p>
              </div>
            </div>
          ) : null}
        </div>

        <aside id="review-panel" className={`review-panel ${panelOpen ? "open" : ""}`} aria-label="Review feedback">
          <div className="panel-heading">
            <div>
              <h1>Review</h1>
              <p>{draft.annotations.length} annotation{draft.annotations.length === 1 ? "" : "s"}</p>
            </div>
            <button className="quiet-action" type="button" onClick={() => setPanelOpen(false)}>
              Close
            </button>
          </div>

          {selectedTarget ? (
            <section className="selection-editor" data-testid="selection-card">
              <span className="section-label">Selection</span>
              <div className="selection-title">
                <strong>{targetTitle(selectedTarget)}</strong>
                <small>{targetMeta(selectedTarget)}</small>
              </div>
              {selectedTarget.headingPath.length > 0 ? (
                <p className="selection-path">{selectedTarget.headingPath.join(" / ")}</p>
              ) : null}
              <label className="field" htmlFor="annotation-comment">
                <span>Comment</span>
                <textarea
                  id="annotation-comment"
                  data-testid="annotation-comment"
                  value={comment}
                  maxLength={4_000}
                  placeholder="What should change?"
                  onChange={(event) => setComment(event.target.value)}
                />
              </label>
              <div className="selection-actions">
                <button className="quiet-action" type="button" onClick={clearSelection}>
                  Cancel
                </button>
                <button
                  className="primary-action"
                  data-testid="add-annotation"
                  type="button"
                  disabled={!comment.trim()}
                  onClick={addAnnotation}
                >
                  Add to queue
                </button>
              </div>
            </section>
          ) : (
            <section className="empty-selection">
              <span className="section-label">Selection</span>
              <p>Select an element or exact text in the artifact. Its context will be attached here.</p>
            </section>
          )}

          <section className="annotation-list" aria-label="Queued annotations">
            <div className="list-heading">
              <span className="section-label">Annotations</span>
              {draft.annotations.length > 0 ? <span>{draft.annotations.length}</span> : null}
            </div>
            {draft.annotations.length === 0 ? <p className="empty-list">Nothing queued yet.</p> : null}
            {draft.annotations.map((annotation, index) => (
              <article className="annotation-row" key={annotation.id} data-testid="queued-annotation">
                <div className="annotation-number">{String(index + 1).padStart(2, "0")}</div>
                <div className="annotation-copy">
                  <div className="annotation-target">
                    <span>{targetMeta(annotation.target)}</span>
                    <i className={annotation.resolution === "unresolved" ? "unresolved" : "attached"}>
                      {annotation.resolution === "unresolved" ? "Unresolved" : "Attached"}
                    </i>
                  </div>
                  <strong>{targetTitle(annotation.target)}</strong>
                  <p>{annotation.comment}</p>
                </div>
                <button
                  className="remove-button"
                  type="button"
                  aria-label={`Remove annotation ${index + 1}`}
                  onClick={() => removeAnnotation(annotation.id)}
                >
                  ×
                </button>
              </article>
            ))}
          </section>

          <label className="field general-note" htmlFor="reviewer-message">
            <span>General note</span>
            <textarea
              id="reviewer-message"
              data-testid="reviewer-message"
              value={draft.message}
              maxLength={8_000}
              disabled={ended}
              placeholder="Optional feedback about the whole artifact…"
              onChange={(event) => setDraft((current) => ({ ...current, message: event.target.value }))}
            />
          </label>

          {error ? <p className="feedback-status error-banner">{error}</p> : null}
          {notice ? <p className="feedback-status notice-banner">{notice}</p> : null}

          <footer className="panel-actions">
            <button
              className="primary-action send-button"
              data-testid="send-feedback"
              type="button"
              disabled={busy || ended || (draft.annotations.length === 0 && !draft.message.trim())}
              onClick={() => void sendFeedback(false)}
            >
              {busy ? "Sending…" : "Send to Agent"}
            </button>
            <button
              className="quiet-action end-button"
              data-testid="send-end"
              type="button"
              disabled={busy || ended}
              onClick={() => void sendFeedback(true)}
            >
              Send &amp; End
            </button>
          </footer>
        </aside>
        {panelOpen ? (
          <button
            className="panel-backdrop"
            type="button"
            aria-label="Close review panel"
            onClick={() => setPanelOpen(false)}
          />
        ) : null}
      </section>
    </main>
  );
}
