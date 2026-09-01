import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BridgeAnnotationMarker,
  BridgeOverlay,
  BridgeToParentMessage,
  ChangeReviewDecision,
  DraftAnnotation,
  FeedbackReceipt,
  ParentToBridgeMessage,
  ParentToBridgePayload,
  PublicSessionState,
  ReviewEvent,
  ReviewDraft,
  TargetDescriptor,
} from "../shared/protocol.js";
import { isBridgeToParentMessage, isPublicSessionState, isReviewEvent } from "../shared/guards.js";

const EMPTY_DRAFT: ReviewDraft = { message: "", requeuedMessageSequences: [], annotations: [] };
const MAX_PAINTED_MARKERS = 150;

type ActivityKind = "ready" | "sending" | "queued" | "working" | "updated" | "failed" | "unconfirmed" | "offline" | "ended";
type SendErrorKind = "rejected" | "unconfirmed";

interface ReviewActivity {
  kind: ActivityKind;
  label: string;
  detail: string;
}

interface PendingSubmission {
  submissionId: string;
  draft: ReviewDraft;
  end: boolean;
  baseRevision: number;
  baseContentHash: string;
}

function reviewActivity(
  session: PublicSessionState,
  connected: boolean,
  busy: boolean,
  sendError: string | null,
  sendErrorKind: SendErrorKind | null,
): ReviewActivity {
  if (session.status === "superseded") {
    return {
      kind: "ended",
      label: "Review moved",
      detail: "Recovered notes moved to the replacement artifact review. Reopen the review from your agent.",
    };
  }
  if (session.status === "ended") {
    return {
      kind: "ended",
      label: "Review complete",
      detail: "Final feedback was sent. This session will not reopen automatically.",
    };
  }
  if (busy) {
    return {
      kind: "sending",
      label: "Sending feedback",
      detail: "Your notes stay in the review dialog until delivery succeeds.",
    };
  }
  if (sendError) {
    return {
      kind: sendErrorKind === "rejected" ? "failed" : "unconfirmed",
      label: sendErrorKind === "rejected" ? "Send rejected" : "Delivery unconfirmed",
      detail: sendErrorKind === "rejected"
        ? `${sendError} Your notes are still here; adjust them and try again.`
        : `${sendError} The exact batch is locked for an idempotent retry.`,
    };
  }
  if (!connected) {
    return {
      kind: "offline",
      label: "Reconnecting",
      detail: "Live revision updates are paused. Agent HTML Render is retrying the local connection.",
    };
  }

  const latest = session.latestFeedback;
  if (!latest) {
    return {
      kind: "ready",
      label: "Ready to review",
      detail: "Use the artifact normally, or choose Annotate to comment on an exact part.",
    };
  }
  if (session.revision > latest.revision) {
    return {
      kind: "updated",
      label: `Revision ${session.revision} ready`,
      detail: `The agent changed the artifact after feedback ${latest.sequence}. Review the update or add another note.`,
    };
  }
  if (session.deliveredFeedbackSequence >= latest.sequence) {
    return {
      kind: "working",
      label: "Agent received feedback",
      detail: `Waiting for revision ${latest.revision + 1}. This page will update when it arrives.`,
    };
  }
  return {
    kind: "queued",
    label: "Feedback queued",
    detail: `Feedback ${latest.sequence} is saved. Waiting for an agent review command to pick it up.`,
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

function parseSessionStateEvent(event: Event): PublicSessionState | undefined {
  try {
    const value: unknown = JSON.parse((event as MessageEvent<string>).data);
    return isPublicSessionState(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function draftMarkerId(annotationId: string): string {
  return `draft:${annotationId}`;
}

function historyMarkerId(sequence: number, annotationId: string): string {
  return `history:${sequence}:${annotationId}`;
}

function historyMessageId(sequence: number): string {
  return `history-message:${sequence}`;
}

function requeuedAnnotationKey(sequence: number, annotationId: string): string {
  return `${sequence}:${annotationId}`;
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
  if (!response.ok) throw new ConfirmedRequestError(body.error ?? `Request failed with HTTP ${response.status}.`);
  return body;
}

class ConfirmedRequestError extends Error {
  override readonly name = "ConfirmedRequestError";
}

function targetTitle(target: TargetDescriptor): string {
  if (target.label) return target.label;
  if (target.displayText) return target.displayText;
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
  const annotateTriggerRef = useRef<HTMLButtonElement>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const reviewDialogRef = useRef<HTMLElement>(null);
  const reviewCloseRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const annotationCommentRef = useRef<HTMLTextAreaElement>(null);
  const annotationReturnFocusRef = useRef<{
    element: HTMLElement | null;
    fallback: "annotate" | "review";
  } | null>(null);
  const annotationFocusRestoreFrame = useRef<number | null>(null);
  const skipDialogFocusRestore = useRef(false);
  const clientId = useRef(crypto.randomUUID());
  const draftRef = useRef<ReviewDraft>(EMPTY_DRAFT);
  const reviewerHasEditedDraft = useRef(false);
  const compositionInProgress = useRef(false);
  const newestStateTimestamp = useRef("");
  const saveTimer = useRef<number | undefined>(undefined);
  const saveInFlight = useRef<Promise<void>>(Promise.resolve());
  const pendingSubmission = useRef<PendingSubmission | null>(null);
  const completedSubmissionId = useRef<string | null>(null);
  const [session, setSession] = useState<PublicSessionState | null>(null);
  const [draft, setDraft] = useState<ReviewDraft>(EMPTY_DRAFT);
  const [selectedTarget, setSelectedTarget] = useState<TargetDescriptor | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionWarning, setSelectionWarning] = useState<string | null>(null);
  const [keyboardTarget, setKeyboardTarget] = useState<TargetDescriptor | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendErrorKind, setSendErrorKind] = useState<SendErrorKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyTargets, setHistoryTargets] = useState<Record<string, TargetDescriptor | null>>({});
  const [reviewingChange, setReviewingChange] = useState<string | null>(null);
  const [activeHistoryMarker, setActiveHistoryMarker] = useState<string | null>(null);
  const [bridgeOverlays, setBridgeOverlays] = useState<BridgeOverlay[]>([]);
  const selectionModeRef = useRef(selectionMode);
  selectionModeRef.current = selectionMode;

  const stateUrl = `/api/review/${encodeURIComponent(location.sessionId)}/state?${accessQuery}`;

  const closeReview = useCallback(() => {
    if (busy || reviewingChange !== null) return;
    setReviewOpen(false);
    setActiveHistoryMarker(null);
  }, [busy, reviewingChange]);

  const rememberAnnotationReturnFocus = useCallback((fallback: "annotate" | "review") => {
    if (annotationFocusRestoreFrame.current !== null) {
      window.cancelAnimationFrame(annotationFocusRestoreFrame.current);
      annotationFocusRestoreFrame.current = null;
    }
    annotationReturnFocusRef.current = {
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      fallback,
    };
  }, []);

  const restoreAnnotationFocus = useCallback(() => {
    const destination = annotationReturnFocusRef.current;
    annotationReturnFocusRef.current = null;
    if (!destination) return;
    if (annotationFocusRestoreFrame.current !== null) {
      window.cancelAnimationFrame(annotationFocusRestoreFrame.current);
    }
    annotationFocusRestoreFrame.current = window.requestAnimationFrame(() => {
      annotationFocusRestoreFrame.current = null;
      const previous = destination.element;
      if (
        previous?.isConnected &&
        !previous.closest("[inert]") &&
        !previous.matches(":disabled")
      ) {
        previous.focus();
        return;
      }
      const fallback = destination.fallback === "review"
        ? reviewTriggerRef.current
        : annotateTriggerRef.current;
      if (fallback?.isConnected && !fallback.disabled) fallback.focus();
      else reviewTriggerRef.current?.focus();
    });
  }, []);

  useEffect(() => () => {
    if (annotationFocusRestoreFrame.current !== null) {
      window.cancelAnimationFrame(annotationFocusRestoreFrame.current);
    }
  }, []);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const sendToBridge = useCallback(
    (message: ParentToBridgePayload) => {
      if (!session || !iframeRef.current?.contentWindow) return;
      iframeRef.current.contentWindow.postMessage(
        { source: "agent-html-render-shell", token: session.bridgeToken, ...message } satisfies ParentToBridgeMessage,
        "*",
      );
    },
    [session?.bridgeToken],
  );

  const showReviewTargets = useCallback(
    (nextDraft: ReviewDraft) => {
      const requeuedAnnotations = new Set(
        [
          ...nextDraft.annotations,
          ...(session?.feedbackHistory.flatMap((entry) =>
            entry.annotations.map(({ annotation }) => annotation)
          ) ?? []),
        ].flatMap((annotation) =>
          annotation.requeuedFrom
            ? [requeuedAnnotationKey(annotation.requeuedFrom.sequence, annotation.requeuedFrom.annotationId)]
            : [],
        ),
      );
      const draftMarkers: BridgeAnnotationMarker[] = nextDraft.annotations.map((annotation, index) => ({
        id: draftMarkerId(annotation.id),
        label: String(index + 1),
        tone: "draft",
        annotation,
      }));
      const historyMarkers: BridgeAnnotationMarker[] = (session?.feedbackHistory ?? []).flatMap((entry) =>
        entry.revision < (session?.revision ?? 0)
          ? entry.annotations.flatMap(({ annotation, decision }, index) =>
              decision === "resolved" ||
              decision === "dismissed" ||
              (decision === "needs-work" && requeuedAnnotations.has(requeuedAnnotationKey(entry.sequence, annotation.id)))
                ? []
                : [{
                    id: historyMarkerId(entry.sequence, annotation.id),
                    label: `F${entry.sequence}.${index + 1}`.slice(0, 12),
                    tone: "history" as const,
                    annotation,
                  }],
            )
          : [],
      );
      const visibleHistoryCount = Math.max(0, MAX_PAINTED_MARKERS - draftMarkers.length);
      const visibleHistoryMarkers = visibleHistoryCount > 0
        ? historyMarkers.slice(-visibleHistoryCount)
        : [];
      const hiddenHistoryMarkers = historyMarkers.slice(
        0,
        Math.max(0, historyMarkers.length - visibleHistoryMarkers.length),
      );
      sendToBridge({ type: "show-annotations", markers: [...draftMarkers, ...visibleHistoryMarkers] });
      for (let index = 0; index < hiddenHistoryMarkers.length; index += MAX_PAINTED_MARKERS) {
        sendToBridge({
          type: "resolve-annotations",
          markers: hiddenHistoryMarkers.slice(index, index + MAX_PAINTED_MARKERS),
        });
      }
    },
    [sendToBridge, session?.feedbackHistory, session?.revision],
  );

  const openAnnotationEditor = useCallback(
    (annotation: DraftAnnotation) => {
      rememberAnnotationReturnFocus("review");
      if (reviewOpen) skipDialogFocusRestore.current = true;
      compositionInProgress.current = true;
      setSelectedTarget(annotation.target);
      setEditingAnnotationId(annotation.id);
      setComment(annotation.comment);
      setSelectionMode(false);
      setKeyboardTarget(null);
      setReviewOpen(false);
      setNotice(null);
      sendToBridge({ type: "clear-selection" });
    },
    [rememberAnnotationReturnFocus, reviewOpen, sendToBridge],
  );

  const activateAnnotationMarker = useCallback(
    (markerId: string) => {
      const draftId = markerId.startsWith("draft:") ? markerId.slice("draft:".length) : "";
      const annotation = draft.annotations.find((candidate) => candidate.id === draftId);
      if (annotation) openAnnotationEditor(annotation);
      else if (markerId.startsWith("history:")) {
        setActiveHistoryMarker(markerId);
        setReviewOpen(true);
      }
    },
    [draft.annotations, openAnnotationEditor],
  );

  const persistDraft = useCallback(
    async (
      nextDraft: ReviewDraft,
      baseRevision: number,
      baseContentHash: string,
      confirmRecovery = false,
    ) => {
      await jsonRequest(`/api/review/${encodeURIComponent(location.sessionId)}/draft?${accessQuery}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft: nextDraft,
          baseRevision,
          baseContentHash,
          clientId: clientId.current,
          confirmRecovery,
        }),
      });
    },
    [accessQuery, location.sessionId],
  );

  const acceptSessionState = useCallback((nextSession: PublicSessionState) => {
    if (newestStateTimestamp.current && nextSession.updatedAt < newestStateTimestamp.current) return;
    newestStateTimestamp.current = nextSession.updatedAt;
    setSession((current) =>
      (reviewerHasEditedDraft.current || compositionInProgress.current || pendingSubmission.current !== null) && current
        ? {
            ...nextSession,
            draft: draftRef.current,
            draftBaseRevision: current.draftBaseRevision,
            draftBaseContentHash: current.draftBaseContentHash,
          }
        : nextSession,
    );
    if (
      !reviewerHasEditedDraft.current &&
      !compositionInProgress.current &&
      pendingSubmission.current === null
    ) {
      setDraft(nextSession.draft);
    }
  }, []);

  const completeSubmission = useCallback(
    (submissionId: string, receipt: FeedbackReceipt): boolean => {
      if (pendingSubmission.current?.submissionId !== submissionId) return false;
      pendingSubmission.current = null;
      completedSubmissionId.current = submissionId;
      draftRef.current = EMPTY_DRAFT;
      reviewerHasEditedDraft.current = false;
      compositionInProgress.current = false;
      setDraft(EMPTY_DRAFT);
      setSelectedTarget(null);
      setEditingAnnotationId(null);
      setComment("");
      setSelectionMode(false);
      setSelectionWarning(null);
      setReviewOpen(false);
      setError(null);
      setSendError(null);
      setSendErrorKind(null);
      setSession((current) =>
        current
          ? {
              ...current,
              latestFeedback: receipt,
              status: receipt.status === "ended" ? "ended" : current.status,
              updatedAt: receipt.sentAt,
            }
          : current,
      );
      return true;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    void jsonRequest<unknown>(stateUrl)
      .then((value) => {
        if (!active) return;
        if (!isPublicSessionState(value)) {
          throw new Error("Agent HTML Render received an invalid session state.");
        }
        acceptSessionState(value);
      })
      .catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      active = false;
    };
  }, [acceptSessionState, stateUrl]);

  useEffect(() => {
    const source = new EventSource(`/api/review/${encodeURIComponent(location.sessionId)}/events?${accessQuery}`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("state", (event) => {
      const nextSession = parseSessionStateEvent(event);
      if (!nextSession) {
        setError("Agent HTML Render received an invalid session snapshot.");
        return;
      }
      acceptSessionState(nextSession);
      const receipt = nextSession.latestFeedback;
      if (receipt?.submissionId) completeSubmission(receipt.submissionId, receipt);
    });
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
              ...(!compositionInProgress.current &&
                !draftRef.current.message.trim() &&
                draftRef.current.annotations.length === 0
                ? {
                    draftBaseRevision: revision.revision,
                    draftBaseContentHash: revision.contentHash,
                  }
                : {}),
              updatedAt: revision.updatedAt,
            }
          : current,
      );
      if (!pendingSubmission.current) setSendError(null);
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
      if (
        submitted.receipt.submissionId &&
        completeSubmission(submitted.receipt.submissionId, submitted.receipt)
      ) {
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
    source.addEventListener("draft", (event) => {
      const nextDraft = parseReviewEvent(event);
      if (!nextDraft || nextDraft.type !== "draft") {
        setError("Agent HTML Render received an invalid draft update.");
        return;
      }
      if (nextDraft.clientId === clientId.current) return;
      if (
        reviewerHasEditedDraft.current ||
        compositionInProgress.current ||
        pendingSubmission.current !== null
      ) {
        return;
      }
      reviewerHasEditedDraft.current = false;
      setDraft(nextDraft.draft);
      setSession((current) =>
        current
          ? {
              ...current,
              draft: nextDraft.draft,
              draftBaseRevision: nextDraft.baseRevision,
              draftBaseContentHash: nextDraft.baseContentHash,
              updatedAt: nextDraft.updatedAt,
            }
          : current,
      );
    });
    return () => source.close();
  }, [acceptSessionState, accessQuery, completeSubmission, location.sessionId]);

  useEffect(() => {
    if (!session) return;
    const listener = (event: MessageEvent<BridgeToParentMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message: unknown = event.data;
      if (!isBridgeToParentMessage(message, session.bridgeToken)) return;
      if (message.type === "ready") {
        sendToBridge({ type: "set-selection-mode", enabled: selectionMode });
        showReviewTargets(draft);
      } else if (message.type === "selection-mode-ready") {
        if (message.enabled && selectionModeRef.current) iframeRef.current?.contentWindow?.focus();
      } else if (message.type === "target-selected") {
        rememberAnnotationReturnFocus("annotate");
        compositionInProgress.current = true;
        setSelectionWarning(null);
        setKeyboardTarget(null);
        setSelectionMode(false);
        setSelectedTarget(message.target);
        setEditingAnnotationId(null);
        setComment("");
      } else if (message.type === "keyboard-target-changed") {
        setSelectionWarning(null);
        setKeyboardTarget(message.target);
      } else if (message.type === "keyboard-target-cleared") {
        setSelectionWarning(null);
        setKeyboardTarget(null);
      } else if (message.type === "keyboard-target-unavailable") {
        setKeyboardTarget(null);
        setSelectionWarning(
          "No keyboard-selectable target is available. Add a whole-artifact note from Review instead.",
        );
      } else if (message.type === "selection-cancelled") {
        compositionInProgress.current = false;
        setSelectionMode(false);
        setSelectionWarning(null);
        setKeyboardTarget(null);
        setSelectedTarget(null);
        setEditingAnnotationId(null);
        setComment("");
        sendToBridge({ type: "clear-selection" });
        window.requestAnimationFrame(() => annotateTriggerRef.current?.focus());
      } else if (message.type === "selection-rejected") {
        setSelectedTarget(null);
        setEditingAnnotationId(null);
        setComment("");
        setSelectionWarning(
          message.reason === "text-selection-too-long"
            ? `Text selections are limited to ${message.maximum.toLocaleString()} characters. Select a smaller passage or annotate its containing element.`
            : "This target's visible text cannot be represented as one bounded exact selection. Annotate the element instead.",
        );
      } else if (message.type === "annotation-activated") {
        activateAnnotationMarker(message.annotationId);
      } else if (message.type === "anchor-resolutions") {
        setDraft((current) => {
          let changed = false;
          const annotations = current.annotations.map((annotation) => {
            const match = message.resolutions.find(
              (resolution) => resolution.id === draftMarkerId(annotation.id),
            );
            if (!match || annotation.resolution === match.resolution) return annotation;
            changed = true;
            return { ...annotation, resolution: match.resolution };
          });
          return changed ? { ...current, annotations } : current;
        });
        setHistoryTargets((current) => {
          const next = { ...current };
          let changed = false;
          for (const resolution of message.resolutions) {
            if (!resolution.id.startsWith("history:")) continue;
            const target = resolution.resolution === "attached" ? (resolution.currentTarget ?? null) : null;
            if (next[resolution.id] !== target) {
              next[resolution.id] = target;
              changed = true;
            }
          }
          return changed ? next : current;
        });
      } else if (message.type === "overlay-layout") setBridgeOverlays(message.overlays);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [activateAnnotationMarker, draft, rememberAnnotationReturnFocus, selectionMode, sendToBridge, session, showReviewTargets]);

  const reviewTargetsKey = useMemo(
    () => JSON.stringify(draft.annotations.map(({ id, target, requeuedFrom }) => ({ id, target, requeuedFrom }))),
    [draft.annotations],
  );

  useEffect(() => {
    showReviewTargets(draft);
  }, [reviewTargetsKey, showReviewTargets]);

  useEffect(() => {
    setHistoryTargets({});
    setBridgeOverlays([]);
  }, [session?.revision]);

  useEffect(() => {
    if (!reviewOpen || !activeHistoryMarker) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => document.getElementById(activeHistoryMarker)?.focus());
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [activeHistoryMarker, reviewOpen]);

  useEffect(() => {
    if (!reviewOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = [
      document.querySelector<HTMLElement>(".topbar"),
      document.querySelector<HTMLElement>(".artifact-stage"),
      document.querySelector<HTMLElement>(".annotation-composer"),
    ].filter((element): element is HTMLElement => Boolean(element));
    for (const element of background) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    }
    const focusFrame = window.requestAnimationFrame(() => reviewCloseRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      for (const element of background) {
        element.removeAttribute("inert");
        element.removeAttribute("aria-hidden");
      }
      if (skipDialogFocusRestore.current) {
        skipDialogFocusRestore.current = false;
        return;
      }
      const previousFocus = previousFocusRef.current;
      window.requestAnimationFrame(() => {
        if (previousFocus?.isConnected) previousFocus.focus();
        else reviewTriggerRef.current?.focus();
      });
    };
  }, [reviewOpen]);

  useEffect(() => {
    if (!selectedTarget) return;
    const focusFrame = window.requestAnimationFrame(() => annotationCommentRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [editingAnnotationId, selectedTarget]);

  useEffect(() => {
    sendToBridge({ type: "set-selection-mode", enabled: selectionMode });
    if (!selectionMode) {
      setKeyboardTarget(null);
    }
  }, [selectionMode, sendToBridge]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (reviewOpen) {
        closeReview();
        return;
      }
      if (selectionMode || selectedTarget) {
        setSelectionMode(false);
        setSelectionWarning(null);
        setKeyboardTarget(null);
        setSelectedTarget(null);
        setEditingAnnotationId(null);
        setComment("");
        sendToBridge({ type: "clear-selection" });
        if (selectedTarget) restoreAnnotationFocus();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeReview, restoreAnnotationFocus, reviewOpen, selectedTarget, selectionMode, sendToBridge]);

  const trapDialogFocus = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") return;
    const dialog = reviewDialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute("hidden"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (!session || session.status !== "open" || !reviewerHasEditedDraft.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const operation = saveInFlight.current
        .catch(() => undefined)
        .then(() => persistDraft(draft, session.draftBaseRevision, session.draftBaseContentHash))
        .then(() => {
          if (draftRef.current === draft) reviewerHasEditedDraft.current = false;
        });
      saveInFlight.current = operation;
      void operation.catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    }, 450);
    return () => window.clearTimeout(saveTimer.current);
  }, [draft, persistDraft, session]);

  const updateDraft = useCallback(
    (nextDraft: ReviewDraft) => {
      pendingSubmission.current = null;
      reviewerHasEditedDraft.current = true;
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      showReviewTargets(nextDraft);
    },
    [showReviewTargets],
  );

  const saveAnnotation = (): void => {
    if (!selectedTarget || !comment.trim()) return;
    const trimmedComment = comment.trim();
    const nextDraft = editingAnnotationId
      ? {
          ...draft,
          annotations: draft.annotations.map((annotation) =>
            annotation.id === editingAnnotationId
              ? {
                  ...annotation,
                  comment: trimmedComment,
                  ...(annotation.requeuedFrom && annotation.comment !== trimmedComment
                    ? { requeuedFrom: undefined }
                    : {}),
                }
              : annotation,
          ),
        }
      : {
          ...draft,
          annotations: [
            ...draft.annotations,
            {
              id: crypto.randomUUID(),
              comment: trimmedComment,
              createdAt: new Date().toISOString(),
              target: selectedTarget,
              resolution: "attached" as const,
            },
          ],
        };
    updateDraft(nextDraft);
    compositionInProgress.current = false;
    setSelectedTarget(null);
    setEditingAnnotationId(null);
    setComment("");
    setSelectionMode(false);
    setSelectionWarning(null);
    setKeyboardTarget(null);
    sendToBridge({ type: "clear-selection" });
    restoreAnnotationFocus();
    const editedRequeuedAnnotation = editingAnnotationId
      ? draft.annotations.find((annotation) =>
          annotation.id === editingAnnotationId &&
          annotation.comment !== trimmedComment &&
          annotation.requeuedFrom,
        )
      : undefined;
    setNotice(
      editedRequeuedAnnotation
        ? "Annotation updated as an independent note; its requeue link was removed."
        : editingAnnotationId
          ? "Annotation updated."
          : "Annotation queued.",
    );
  };

  const clearSelection = (): void => {
    compositionInProgress.current = false;
    if (!reviewerHasEditedDraft.current && !draft.message.trim() && draft.annotations.length === 0) {
      setSession((current) =>
        current
          ? {
              ...current,
              draftBaseRevision: current.revision,
              draftBaseContentHash: current.contentHash,
            }
          : current,
      );
    }
    setSelectedTarget(null);
    setEditingAnnotationId(null);
    setComment("");
    setSelectionMode(false);
    setSelectionWarning(null);
    setKeyboardTarget(null);
    sendToBridge({ type: "clear-selection" });
    restoreAnnotationFocus();
  };

  const toggleSelectionMode = (): void => {
    if (selectionMode || selectedTarget) {
      clearSelection();
      return;
    }
    setReviewOpen(false);
    setSelectionMode(true);
    setSelectionWarning(null);
    setKeyboardTarget(null);
    setNotice(null);
  };

  const removeAnnotation = (id: string): void => {
    updateDraft({ ...draft, annotations: draft.annotations.filter((annotation) => annotation.id !== id) });
    if (editingAnnotationId === id) clearSelection();
    setNotice("Annotation removed.");
  };

  const sendFeedback = async (end: boolean): Promise<void> => {
    if (!session) return;
    let attemptedSubmission: PendingSubmission | null = null;
    setBusy(true);
    setError(null);
    setSendError(null);
    setSendErrorKind(null);
    setNotice(null);
    try {
      window.clearTimeout(saveTimer.current);
      await saveInFlight.current.catch(() => undefined);
      const existingSubmission = pendingSubmission.current;
      const submission =
        existingSubmission
          ? existingSubmission
          : {
              submissionId: crypto.randomUUID(),
              draft: structuredClone(draft),
              end,
              baseRevision: session.draftBaseRevision,
              baseContentHash: session.draftBaseContentHash,
            };
      attemptedSubmission = submission;
      pendingSubmission.current = submission;
      const receipt = await jsonRequest<FeedbackReceipt>(
        `/api/review/${encodeURIComponent(location.sessionId)}/send?${accessQuery}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(submission),
        },
      );
      if (receipt.submissionId !== submission.submissionId) {
        throw new Error("Agent HTML Render received a mismatched feedback receipt.");
      }
      completeSubmission(submission.submissionId, receipt);
    } catch (reason) {
      const attempted = attemptedSubmission;
      let reconciled = attempted !== null && completedSubmissionId.current === attempted.submissionId;
      if (attempted && !reconciled) {
        try {
          const value = await jsonRequest<unknown>(stateUrl);
          if (isPublicSessionState(value)) {
            acceptSessionState(value);
            const receipt = value.latestFeedback;
            if (receipt?.submissionId === attempted.submissionId) {
              completeSubmission(attempted.submissionId, receipt);
              reconciled = true;
            }
          }
        } catch {
          // The immutable submission remains available for an idempotent retry.
        }
      }
      if (!reconciled) {
        const message = reason instanceof Error ? reason.message : String(reason);
        const confirmedRejection = reason instanceof ConfirmedRequestError;
        if (confirmedRejection) pendingSubmission.current = null;
        setError(message);
        setSendError(message);
        setSendErrorKind(confirmedRejection ? "rejected" : "unconfirmed");
      }
    } finally {
      setBusy(false);
    }
  };

  const rebaseDraft = async (): Promise<void> => {
    if (!session) return;
    pendingSubmission.current = null;
    setBusy(true);
    setError(null);
    try {
      window.clearTimeout(saveTimer.current);
      await saveInFlight.current.catch(() => undefined);
      await persistDraft(draft, session.revision, session.contentHash, true);
      reviewerHasEditedDraft.current = false;
      setSession((current) =>
        current
          ? {
              ...current,
              draftBaseRevision: current.revision,
              draftBaseContentHash: current.contentHash,
              draftRecoveryRequired: false,
            }
          : current,
      );
      setSendError(null);
      setSendErrorKind(null);
      setNotice(`Notes now apply to revision ${session.revision}.`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setSendError(message);
    } finally {
      setBusy(false);
    }
  };

  const unlockAmbiguousSubmission = (): void => {
    pendingSubmission.current = null;
    setError(null);
    setSendError(null);
    setSendErrorKind(null);
    setNotice("Draft unlocked. The earlier batch may already be queued; verify delivery before sending a new batch.");
  };

  const reviewChange = async (
    sequence: number,
    annotationId: string,
    decision: ChangeReviewDecision,
  ): Promise<void> => {
    if (!session) return;
    const changeId = historyMarkerId(sequence, annotationId);
    setReviewingChange(changeId);
    setError(null);
    try {
      window.clearTimeout(saveTimer.current);
      await saveInFlight.current.catch(() => undefined);
      if (reviewerHasEditedDraft.current) {
        await persistDraft(draftRef.current, session.draftBaseRevision, session.draftBaseContentHash);
        reviewerHasEditedDraft.current = false;
      }
      const result = await jsonRequest<{ state: unknown }>(
        `/api/review/${encodeURIComponent(location.sessionId)}/feedback/${sequence}/annotations/${encodeURIComponent(annotationId)}?${accessQuery}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, requeue: decision === "needs-work" }),
        },
      );
      if (!isPublicSessionState(result.state)) {
        throw new Error("Agent HTML Render received an invalid change-review state.");
      }
      pendingSubmission.current = null;
      reviewerHasEditedDraft.current = false;
      setDraft(result.state.draft);
      draftRef.current = result.state.draft;
      acceptSessionState(result.state);
      setNotice(
        decision === "needs-work"
          ? "Feedback requeued for the agent."
          : decision === "resolved"
            ? "Change marked resolved."
            : "Feedback dismissed.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReviewingChange(null);
    }
  };

  const reviewMessage = async (sequence: number, decision: ChangeReviewDecision): Promise<void> => {
    if (!session) return;
    const changeId = historyMessageId(sequence);
    setReviewingChange(changeId);
    setError(null);
    try {
      window.clearTimeout(saveTimer.current);
      await saveInFlight.current.catch(() => undefined);
      if (reviewerHasEditedDraft.current) {
        await persistDraft(draftRef.current, session.draftBaseRevision, session.draftBaseContentHash);
        reviewerHasEditedDraft.current = false;
      }
      const result = await jsonRequest<{ state: unknown }>(
        `/api/review/${encodeURIComponent(location.sessionId)}/feedback/${sequence}/message?${accessQuery}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, requeue: decision === "needs-work" }),
        },
      );
      if (!isPublicSessionState(result.state)) {
        throw new Error("Agent HTML Render received an invalid message-review state.");
      }
      pendingSubmission.current = null;
      reviewerHasEditedDraft.current = false;
      setDraft(result.state.draft);
      draftRef.current = result.state.draft;
      acceptSessionState(result.state);
      setNotice(
        decision === "needs-work"
          ? "General note requeued for the agent."
          : decision === "resolved"
            ? "General note marked resolved."
            : "General note dismissed.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReviewingChange(null);
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
  const ended = session.status !== "open";
  const ambiguousSubmission = sendErrorKind === "unconfirmed" ? pendingSubmission.current : null;
  const reviewMutationInProgress = busy || reviewingChange !== null;
  const draftLocked = reviewMutationInProgress || ambiguousSubmission !== null;
  const reviewableHistory = session.feedbackHistory.filter(
    (entry) =>
      entry.revision < session.revision &&
      (entry.annotations.length > 0 || Boolean(entry.reviewerMessage.trim())),
  );
  const requeuedAnnotations = new Set(
    [
      ...draft.annotations,
      ...session.feedbackHistory.flatMap((entry) =>
        entry.annotations.map(({ annotation }) => annotation)
      ),
    ].flatMap((annotation) =>
      annotation.requeuedFrom
        ? [requeuedAnnotationKey(annotation.requeuedFrom.sequence, annotation.requeuedFrom.annotationId)]
        : [],
    ),
  );
  const requeuedMessages = new Set(
    [
      ...(draft.requeuedMessageSequences ?? []),
      ...session.feedbackHistory.flatMap((entry) => entry.requeuedMessageSequences),
    ],
  );
  const outstandingChanges = reviewableHistory.reduce(
    (count, entry) =>
      count +
      (entry.reviewerMessageDecision === "pending" ||
      (entry.reviewerMessageDecision === "needs-work" && !requeuedMessages.has(entry.sequence))
        ? 1
        : 0) +
      entry.annotations.filter(
        ({ annotation, decision }) =>
          decision === "pending" ||
          (decision === "needs-work" &&
            !requeuedAnnotations.has(requeuedAnnotationKey(entry.sequence, annotation.id))),
      ).length,
    0,
  );
  const queuedRequests = draft.annotations.length + (draft.message.trim() ? 1 : 0);
  const reviewCount = queuedRequests + outstandingChanges;
  const draftStale =
    ambiguousSubmission === null &&
    (draft.annotations.length > 0 || Boolean(draft.message.trim())) &&
    (session.draftRecoveryRequired ||
      session.draftBaseRevision !== session.revision ||
      session.draftBaseContentHash !== session.contentHash);
  const activity = reviewActivity(session, connected, busy, sendError, sendErrorKind);
  const waitingFeedback = session.latestFeedback
    ? activity.kind === "working"
      ? {
          title: "Waiting for the agent’s update",
          detail: `The agent received feedback ${session.latestFeedback.sequence}. This view will refresh when the artifact changes.`,
        }
      : activity.kind === "queued"
        ? {
            title: "Waiting for the agent",
            detail: `Feedback ${session.latestFeedback.sequence} is saved. It will be delivered when the agent connects.`,
          }
        : null
    : null;
  const keyboardInstructions =
    "Keyboard: Tab or arrow keys move; Enter or Space selects an element; Shift+Enter selects its exact text; Escape cancels.";
  const keyboardTargetTitle = keyboardTarget
    ? targetTitle(keyboardTarget).replace(/\s+/gu, " ").slice(0, 120)
    : null;
  const selectionPrompt = selectionWarning ??
    (keyboardTargetTitle ? `Keyboard target: ${keyboardTargetTitle}` : "Select an element or exact text to annotate");

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
        <div
          className="review-activity"
          data-state={activity.kind}
          data-testid="review-activity"
          role={activity.kind === "failed" || activity.kind === "unconfirmed" ? "alert" : "status"}
          aria-live={activity.kind === "failed" || activity.kind === "unconfirmed" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <strong>{activity.label}</strong>
          <span title={activity.detail}>{activity.detail}</span>
        </div>
        <nav className="review-nav" aria-label="Review controls">
          <span className="session-status">
            <span data-testid="revision">r{session.revision}</span> · {connected ? "Live" : "Reconnecting"}
          </span>
          <span className="review-action-group">
            <button
              ref={annotateTriggerRef}
              className={`nav-action ${selectionMode ? "active" : ""}`}
              type="button"
              disabled={ended || draftLocked}
              aria-pressed={selectionMode}
              onClick={toggleSelectionMode}
            >
              {selectionMode ? "Cancel" : "Annotate"}
            </button>
            <button
              ref={reviewTriggerRef}
              className={`nav-action ${reviewOpen ? "active" : ""}`}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={reviewOpen}
              aria-controls="review-dialog"
              aria-label={reviewCount > 0 ? `Review (${reviewCount})` : "Review"}
              onClick={() => setReviewOpen(true)}
            >
              Review{reviewCount > 0 ? <span className="review-count">{reviewCount}</span> : null}
            </button>
          </span>
        </nav>
      </header>

      <section className="workspace">
        <div className="artifact-stage">
          {selectionMode && !selectedTarget && !ended ? (
            <div
              className="selection-hint"
              role={selectionWarning ? "alert" : "status"}
              aria-live={selectionWarning ? "assertive" : "polite"}
              aria-atomic="true"
              aria-label={`${selectionPrompt}. ${keyboardInstructions}`}
            >
              <span>{selectionPrompt}</span>
              <small>
                {selectionWarning
                  ? "Try again or press Esc"
                  : "Tab/arrows move · Enter selects · Shift+Enter selects text · Esc cancels"}
              </small>
            </div>
          ) : null}
          {waitingFeedback && !selectedTarget && !ended ? (
            <div
              className="waiting-feedback"
              data-state={activity.kind}
              data-testid="waiting-feedback"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="waiting-indicator" aria-hidden="true" />
              <span className="waiting-copy">
                <strong>{waitingFeedback.title}</strong>
                <span>{waitingFeedback.detail}</span>
              </span>
            </div>
          ) : null}
          <iframe
            ref={iframeRef}
            key={session.revision}
            data-testid="artifact-frame"
            className="artifact-frame"
            title={`Review of ${session.artifactName}`}
            tabIndex={0}
            src={artifactUrl}
            sandbox="allow-scripts"
            onLoad={() => {
              setBridgeOverlays([]);
              sendToBridge({ type: "set-selection-mode", enabled: selectionMode });
              showReviewTargets(draft);
            }}
          />
          <div className="review-overlay-layer" data-testid="review-overlay-layer">
            {bridgeOverlays.map((overlay) => (
              <div
                className={`bridge-overlay bridge-overlay-${overlay.kind}${overlay.tone ? ` bridge-overlay-${overlay.tone}` : ""}`}
                key={overlay.id}
                aria-hidden={overlay.kind === "annotation" ? undefined : true}
                style={{
                  left: overlay.rect.left,
                  top: overlay.rect.top,
                  width: overlay.rect.width,
                  height: overlay.rect.height,
                }}
              >
                {overlay.kind === "annotation" && overlay.label ? (
                  <button
                    type="button"
                    data-testid="artifact-annotation-marker"
                    disabled={draftLocked}
                    title={`${overlay.tone === "history" ? "Review feedback" : "Edit annotation"} ${overlay.label}`}
                    aria-label={`${overlay.tone === "history" ? "Review feedback" : "Edit annotation"} ${overlay.label}`}
                    onClick={() => activateAnnotationMarker(overlay.id)}
                  >
                    {overlay.label}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {ended ? (
            <div className="ended-overlay">
              <div>
                <span className="state-brand">agent-html-render</span>
                <h1>{session.status === "superseded" ? "Review moved" : "Review complete"}</h1>
                <p>
                  {session.status === "superseded"
                    ? "Recovered notes moved to the replacement artifact review. Reopen it from your agent."
                    : "Final feedback was sent to the agent."}
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {selectedTarget && !ended ? (
          <section
            className="annotation-composer"
            data-testid="selection-card"
            role="dialog"
            aria-label={editingAnnotationId ? "Edit annotation" : "Add annotation"}
          >
            <div className="selection-title">
              <div>
                <span className="section-label">{editingAnnotationId ? "Editing annotation" : "Selected"}</span>
                <strong>{targetTitle(selectedTarget)}</strong>
              </div>
              <small>{targetMeta(selectedTarget)}</small>
            </div>
            {selectedTarget.headingPath.length > 0 ? (
              <p className="selection-path">{selectedTarget.headingPath.join(" / ")}</p>
            ) : null}
            <label className="field" htmlFor="annotation-comment">
              <span>Comment</span>
              <textarea
                autoFocus
                ref={annotationCommentRef}
                id="annotation-comment"
                data-testid="annotation-comment"
                value={comment}
                maxLength={4_000}
                placeholder="What should change?"
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && comment.trim()) {
                    event.preventDefault();
                    saveAnnotation();
                  }
                }}
              />
            </label>
            <div className="selection-actions">
              {editingAnnotationId ? (
                <button
                  className="quiet-action delete-action"
                  type="button"
                  onClick={() => removeAnnotation(editingAnnotationId)}
                >
                  Remove
                </button>
              ) : null}
              <button className="quiet-action" type="button" onClick={clearSelection}>
                Cancel
              </button>
              <button
                className="primary-action"
                data-testid={editingAnnotationId ? "save-annotation" : "add-annotation"}
                type="button"
                disabled={!comment.trim()}
                onClick={saveAnnotation}
              >
                {editingAnnotationId ? "Save changes" : "Add annotation"}
              </button>
            </div>
          </section>
        ) : null}

        {reviewOpen ? (
          <div
            className="dialog-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeReview();
            }}
          >
            <section
              ref={reviewDialogRef}
              id="review-dialog"
              className="review-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="review-title"
              onKeyDown={trapDialogFocus}
            >
              <header className="dialog-header">
                <div>
                  <h1 id="review-title">Review</h1>
                  <p>
                    {queuedRequests} queued · {outstandingChanges} change
                    {outstandingChanges === 1 ? "" : "s"} to verify
                  </p>
                </div>
                <button
                  ref={reviewCloseRef}
                  className="quiet-action"
                  type="button"
                  disabled={reviewMutationInProgress}
                  onClick={closeReview}
                >
                  Close
                </button>
              </header>

              <div className="dialog-body">
                {reviewableHistory.length > 0 ? (
                  <section className="change-review" aria-label="Review changes" data-testid="change-review">
                    <div className="list-heading">
                      <span className="section-label">Review changes</span>
                      <span>{outstandingChanges} open</span>
                    </div>
                    <p className="revision-timeline" aria-label="Revision timeline">
                      {session.feedbackHistory.slice(-4).map((entry) => (
                        <span key={entry.sequence}>r{entry.revision} feedback {entry.sequence} → </span>
                      ))}
                      <strong>r{session.revision} ready</strong>
                    </p>
                    {[...reviewableHistory].reverse().map((entry) => (
                      <section className="feedback-batch" key={entry.sequence}>
                        <header className="feedback-batch-heading">
                          <strong>Feedback {entry.sequence}</strong>
                          <span>r{entry.revision} → r{session.revision}{entry.delivered ? " · received" : " · queued"}</span>
                        </header>
                        {entry.reviewerMessage.trim() && entry.reviewerMessageDecision ? (
                          <article className="change-row message-change-row" data-testid="general-note-review-item">
                            <div className="change-row-heading">
                              <span className="annotation-number">F{entry.sequence}.note</span>
                              <span>Whole artifact</span>
                              <i data-decision={entry.reviewerMessageDecision}>
                                {entry.reviewerMessageDecision === "needs-work"
                                  ? "Still needs work"
                                  : entry.reviewerMessageDecision}
                              </i>
                            </div>
                            <strong>{entry.reviewerMessage}</strong>
                            <div className="change-actions" aria-label={`Verify general note from feedback ${entry.sequence}`}>
                              <button
                                type="button"
                                aria-pressed={entry.reviewerMessageDecision === "resolved"}
                                disabled={
                                  draftLocked ||
                                  entry.reviewerMessageDecision === "resolved"
                                }
                                onClick={() => void reviewMessage(entry.sequence, "resolved")}
                              >
                                Resolved
                              </button>
                              <button
                                type="button"
                                aria-pressed={entry.reviewerMessageDecision === "needs-work"}
                                disabled={
                                  draftLocked ||
                                  (entry.reviewerMessageDecision === "needs-work" && requeuedMessages.has(entry.sequence))
                                }
                                onClick={() => void reviewMessage(entry.sequence, "needs-work")}
                              >
                                {entry.reviewerMessageDecision === "needs-work" && requeuedMessages.has(entry.sequence)
                                  ? "Requeued"
                                  : "Still needs work"}
                              </button>
                              <button
                                type="button"
                                aria-pressed={entry.reviewerMessageDecision === "dismissed"}
                                disabled={
                                  draftLocked ||
                                  entry.reviewerMessageDecision === "dismissed"
                                }
                                onClick={() => void reviewMessage(entry.sequence, "dismissed")}
                              >
                                Dismiss
                              </button>
                            </div>
                          </article>
                        ) : null}
                        {entry.annotations.map(({ annotation, decision }, index) => {
                          const markerId = historyMarkerId(entry.sequence, annotation.id);
                          const requeued = requeuedAnnotations.has(
                            requeuedAnnotationKey(entry.sequence, annotation.id),
                          );
                          const currentTarget = historyTargets[markerId];
                          const anchorState =
                            currentTarget === undefined ? "Checking target…" : currentTarget ? "Reattached" : "Unresolved";
                          return (
                            <article
                              id={markerId}
                              className={`change-row ${activeHistoryMarker === markerId ? "active" : ""}`}
                              key={annotation.id}
                              tabIndex={-1}
                              data-testid="change-review-item"
                            >
                              <div className="change-row-heading">
                                <span className="annotation-number">F{entry.sequence}.{index + 1}</span>
                                <span>{targetMeta(annotation.target)} · {anchorState}</span>
                                <i data-decision={decision}>
                                  {decision === "needs-work" ? "Still needs work" : decision}
                                </i>
                              </div>
                              <strong>{annotation.comment}</strong>
                              <dl className="target-comparison">
                                <div>
                                  <dt>Earlier</dt>
                                  <dd>{targetTitle(annotation.target)}</dd>
                                </div>
                                <div>
                                  <dt>Current</dt>
                                  <dd>
                                    {currentTarget === undefined
                                      ? "Resolving against this revision…"
                                      : currentTarget
                                        ? targetTitle(currentTarget)
                                        : "The target no longer attaches."}
                                  </dd>
                                </div>
                              </dl>
                              <div className="change-actions" aria-label={`Verify feedback ${entry.sequence}.${index + 1}`}>
                                <button
                                  type="button"
                                  aria-pressed={decision === "resolved"}
                                  disabled={draftLocked || decision === "resolved"}
                                  onClick={() => void reviewChange(entry.sequence, annotation.id, "resolved")}
                                >
                                  Resolved
                                </button>
                                <button
                                  type="button"
                                  aria-pressed={decision === "needs-work"}
                                  disabled={draftLocked || (decision === "needs-work" && requeued)}
                                  onClick={() => void reviewChange(entry.sequence, annotation.id, "needs-work")}
                                >
                                  {decision === "needs-work" && requeued ? "Requeued" : "Still needs work"}
                                </button>
                                <button
                                  type="button"
                                  aria-pressed={decision === "dismissed"}
                                  disabled={draftLocked || decision === "dismissed"}
                                  onClick={() => void reviewChange(entry.sequence, annotation.id, "dismissed")}
                                >
                                  Dismiss
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </section>
                    ))}
                  </section>
                ) : null}

                <section className="annotation-list" aria-label="Queued annotations">
                  <div className="list-heading">
                    <span className="section-label">Annotations</span>
                    {draft.annotations.length > 0 ? <span>{draft.annotations.length}</span> : null}
                  </div>
                  {draft.annotations.length === 0 ? <p className="empty-list">Nothing queued yet.</p> : null}
                  {draft.annotations.map((annotation, index) => (
                    <article className="annotation-row" key={annotation.id} data-testid="queued-annotation">
                      <div className="annotation-number">{String(index + 1).padStart(2, "0")}</div>
                      <button
                        className="annotation-copy annotation-edit"
                        type="button"
                        disabled={ended || draftLocked}
                        aria-label={`Edit annotation ${index + 1}`}
                        onClick={() => openAnnotationEditor(annotation)}
                      >
                        <span className="annotation-target">
                          <span>{targetMeta(annotation.target)}</span>
                          <span className="annotation-meta">
                            <i className={annotation.resolution === "unresolved" ? "unresolved" : "attached"}>
                              {annotation.resolution === "unresolved" ? "Unresolved" : "Attached"}
                            </i>
                            <span className="edit-cue" aria-hidden="true">Edit</span>
                          </span>
                        </span>
                        <strong>{targetTitle(annotation.target)}</strong>
                        <span className="annotation-comment">{annotation.comment}</span>
                      </button>
                      <button
                        className="remove-button"
                        type="button"
                        disabled={ended || draftLocked}
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
                    disabled={ended || draftLocked}
                    placeholder="Optional feedback about the whole artifact…"
                    onChange={(event) => {
                      if ((draft.requeuedMessageSequences?.length ?? 0) > 0) {
                        setNotice("Edited text is now an independent general note; its requeue link was removed.");
                      }
                      updateDraft({
                        ...draft,
                        message: event.target.value,
                        requeuedMessageSequences: [],
                      });
                    }}
                  />
                </label>

                {draftStale ? (
                  <div className="revision-conflict" role="alert" data-testid="revision-conflict">
                    <p>
                      {session.draftRecoveryRequired
                        ? `These notes were recovered from the preserved session for a replaced artifact. Close this dialog and check revision ${session.revision} before sending.`
                        : `These notes started on revision ${session.draftBaseRevision}. Close this dialog and check revision ${session.revision} before sending.`}
                    </p>
                    <button className="quiet-action" type="button" disabled={reviewMutationInProgress} onClick={() => void rebaseDraft()}>
                      {session.draftRecoveryRequired ? "Keep recovered notes" : "Keep notes"} for revision {session.revision}
                    </button>
                  </div>
                ) : null}

                {ambiguousSubmission && !draftStale ? (
                  <div className="ambiguous-send" role="alert" data-testid="ambiguous-send">
                    <p>
                      Delivery could not be confirmed. Retry the same action to reuse this exact batch without duplicating it.
                    </p>
                    <button
                      className="quiet-action"
                      type="button"
                      disabled={reviewMutationInProgress}
                      onClick={unlockAmbiguousSubmission}
                    >
                      Unlock draft instead
                    </button>
                  </div>
                ) : null}

                {error ? <p className="feedback-status error-banner">{error}</p> : null}
                {notice ? <p className="feedback-status notice-banner">{notice}</p> : null}
              </div>

              <footer className="dialog-actions">
                <button
                  className="quiet-action end-button"
                  data-testid="send-end"
                  type="button"
                  disabled={
                    reviewMutationInProgress ||
                    ended ||
                    draftStale ||
                    (ambiguousSubmission !== null && !ambiguousSubmission.end)
                  }
                  onClick={() => void sendFeedback(true)}
                >
                  {ambiguousSubmission?.end ? "Retry Send & End" : "Send & End"}
                </button>
                <button
                  className="primary-action send-button"
                  data-testid="send-feedback"
                  type="button"
                  disabled={
                    reviewMutationInProgress ||
                    ended ||
                    draftStale ||
                    ambiguousSubmission?.end === true ||
                    (draft.annotations.length === 0 && !draft.message.trim())
                  }
                  onClick={() => void sendFeedback(false)}
                >
                  {busy ? "Sending…" : ambiguousSubmission ? "Retry same feedback" : "Send to Agent"}
                </button>
              </footer>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}
