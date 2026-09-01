import type {
  BridgeToParentMessage,
  DraftAnnotation,
  FeedbackReceipt,
  ParentToBridgeMessage,
  PublicSessionState,
  RangeAnchor,
  ReviewDraft,
  ReviewEvent,
  TargetDescriptor,
  TextQuote,
} from "./protocol.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function integerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

function boundedFiniteNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function path(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item) => Number.isInteger(item) && item >= 0)
  );
}

function textQuote(value: unknown): value is TextQuote {
  const candidate = record(value);
  return Boolean(
    candidate &&
      boundedString(candidate.exact, 1_200) &&
      boundedString(candidate.prefix, 240) &&
      boundedString(candidate.suffix, 240),
  );
}

function rangeAnchor(value: unknown): value is RangeAnchor {
  const candidate = record(value);
  return Boolean(
    candidate &&
      path(candidate.startPath) &&
      Number.isInteger(candidate.startOffset) &&
      (candidate.startOffset as number) >= 0 &&
      (candidate.startOffset as number) <= 10_000_000 &&
      path(candidate.endPath) &&
      Number.isInteger(candidate.endOffset) &&
      (candidate.endOffset as number) >= 0 &&
      (candidate.endOffset as number) <= 10_000_000,
  );
}

export function isTargetDescriptor(value: unknown): value is TargetDescriptor {
  const candidate = record(value);
  if (!candidate) return false;
  if (candidate.kind !== "element" && candidate.kind !== "text") return false;
  if (
    !boundedString(candidate.tag, 80) ||
    !boundedString(candidate.cssPath, 2_000) ||
    !path(candidate.domPath) ||
    !boundedString(candidate.text, 1_200) ||
    (candidate.displayText !== undefined && !boundedString(candidate.displayText, 1_200)) ||
    !Array.isArray(candidate.headingPath) ||
    candidate.headingPath.length > 12 ||
    !candidate.headingPath.every((item) => boundedString(item, 240))
  ) {
    return false;
  }
  if (candidate.role !== undefined && !boundedString(candidate.role, 120)) return false;
  if (candidate.label !== undefined && !boundedString(candidate.label, 240)) return false;
  if (
    candidate.semanticSignature !== undefined &&
    (typeof candidate.semanticSignature !== "string" || !/^a11y-v1:[a-f0-9]{64}$/u.test(candidate.semanticSignature))
  ) return false;
  if (
    candidate.textSignature !== undefined &&
    (typeof candidate.textSignature !== "string" || !/^text-v1:[a-f0-9]{64}$/u.test(candidate.textSignature))
  ) return false;
  if (candidate.identityUnresolvable !== undefined && candidate.identityUnresolvable !== true) return false;
  if (candidate.stableId !== undefined && !boundedString(candidate.stableId, 300)) return false;
  if (
    candidate.stableAttribute !== undefined &&
    candidate.stableAttribute !== "data-agent-html-render-id" &&
    candidate.stableAttribute !== "data-agentrender-id" &&
    candidate.stableAttribute !== "data-agentlens-id" &&
    candidate.stableAttribute !== "id"
  ) {
    return false;
  }
  if (candidate.textQuote !== undefined && !textQuote(candidate.textQuote)) return false;
  if (candidate.range !== undefined && !rangeAnchor(candidate.range)) return false;
  return true;
}

export function isDraftAnnotation(value: unknown): value is DraftAnnotation {
  const candidate = record(value);
  const requeuedFrom = candidate ? record(candidate.requeuedFrom) : undefined;
  return Boolean(
    candidate &&
      boundedString(candidate.id, 120) &&
      boundedString(candidate.comment, 4_000) &&
      candidate.comment.trim() &&
      boundedString(candidate.createdAt, 80) &&
      isTargetDescriptor(candidate.target) &&
      (candidate.resolution === undefined ||
        candidate.resolution === "attached" ||
        candidate.resolution === "unresolved") &&
      (candidate.requeuedFrom === undefined ||
        (requeuedFrom &&
          integerAtLeast(requeuedFrom.sequence, 1) &&
          boundedString(requeuedFrom.annotationId, 120) &&
          (requeuedFrom.sourceDigest === undefined ||
            (typeof requeuedFrom.sourceDigest === "string" && /^[a-f0-9]{64}$/u.test(requeuedFrom.sourceDigest))))),
  );
}

export function isReviewDraft(value: unknown): value is ReviewDraft {
  const candidate = record(value);
  return Boolean(
    candidate &&
      boundedString(candidate.message, 8_000) &&
      (candidate.requeuedMessageSequences === undefined ||
        (Array.isArray(candidate.requeuedMessageSequences) &&
          candidate.requeuedMessageSequences.length <= 50 &&
          candidate.requeuedMessageSequences.every((sequence) => integerAtLeast(sequence, 1)))) &&
      Array.isArray(candidate.annotations) &&
      candidate.annotations.length <= 100 &&
      candidate.annotations.every(isDraftAnnotation),
  );
}

export function isFeedbackReceipt(value: unknown): value is FeedbackReceipt {
  const candidate = record(value);
  return Boolean(
    candidate &&
      integerAtLeast(candidate.sequence, 1) &&
      (candidate.submissionId === undefined || boundedString(candidate.submissionId, 120)) &&
      (candidate.status === "feedback" || candidate.status === "ended") &&
      boundedString(candidate.sentAt, 80) &&
      integerAtLeast(candidate.revision, 1),
  );
}

function isFeedbackHistory(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((item) => {
      const entry = record(item);
      return Boolean(
        entry &&
          integerAtLeast(entry.sequence, 1) &&
          (entry.status === "feedback" || entry.status === "ended") &&
          boundedString(entry.sentAt, 80) &&
          integerAtLeast(entry.revision, 1) &&
          typeof entry.contentHash === "string" &&
          /^[a-f0-9]{64}$/u.test(entry.contentHash) &&
          boundedString(entry.reviewerMessage, 8_000) &&
          (entry.reviewerMessageDecision === null ||
            entry.reviewerMessageDecision === "pending" ||
            entry.reviewerMessageDecision === "resolved" ||
            entry.reviewerMessageDecision === "needs-work" ||
            entry.reviewerMessageDecision === "dismissed") &&
          Array.isArray(entry.requeuedMessageSequences) &&
          entry.requeuedMessageSequences.length <= 50 &&
          entry.requeuedMessageSequences.every((sequence) => integerAtLeast(sequence, 1)) &&
          typeof entry.delivered === "boolean" &&
          Array.isArray(entry.annotations) &&
          entry.annotations.length <= 100 &&
          entry.annotations.every((value) => {
            const historyAnnotation = record(value);
            return Boolean(
              historyAnnotation &&
                isDraftAnnotation(historyAnnotation.annotation) &&
                (historyAnnotation.decision === "pending" ||
                  historyAnnotation.decision === "resolved" ||
                  historyAnnotation.decision === "needs-work" ||
                  historyAnnotation.decision === "dismissed"),
            );
          }),
      );
    })
  );
}

export function isPublicSessionState(value: unknown): value is PublicSessionState {
  const candidate = record(value);
  return Boolean(
    candidate &&
      candidate.protocolVersion === "1" &&
      boundedString(candidate.id, 120) &&
      boundedString(candidate.artifactName, 512) &&
      boundedString(candidate.artifactRelativePath, 4_096) &&
      integerAtLeast(candidate.revision, 1) &&
      typeof candidate.contentHash === "string" &&
      /^[a-f0-9]{64}$/u.test(candidate.contentHash) &&
      (candidate.status === "open" || candidate.status === "ended" || candidate.status === "superseded") &&
      boundedString(candidate.createdAt, 80) &&
      boundedString(candidate.updatedAt, 80) &&
      boundedString(candidate.bridgeToken, 256) &&
      isReviewDraft(candidate.draft) &&
      integerAtLeast(candidate.draftBaseRevision, 1) &&
      typeof candidate.draftBaseContentHash === "string" &&
      /^[a-f0-9]{64}$/u.test(candidate.draftBaseContentHash) &&
      typeof candidate.draftRecoveryRequired === "boolean" &&
      (candidate.latestFeedback === null || isFeedbackReceipt(candidate.latestFeedback)) &&
      integerAtLeast(candidate.deliveredFeedbackSequence, 0) &&
      isFeedbackHistory(candidate.feedbackHistory),
  );
}

export function isReviewEvent(value: unknown): value is ReviewEvent {
  const candidate = record(value);
  if (!candidate || !boundedString(candidate.updatedAt, 80)) return false;
  if (candidate.type === "revision") {
    return (
      integerAtLeast(candidate.revision, 1) &&
      typeof candidate.contentHash === "string" &&
      /^[a-f0-9]{64}$/u.test(candidate.contentHash)
    );
  }
  if (candidate.type === "status") {
    return candidate.status === "open" || candidate.status === "ended" || candidate.status === "superseded";
  }
  if (candidate.type === "draft") {
    return (
      isReviewDraft(candidate.draft) &&
      integerAtLeast(candidate.baseRevision, 1) &&
      typeof candidate.baseContentHash === "string" &&
      /^[a-f0-9]{64}$/u.test(candidate.baseContentHash) &&
      (candidate.clientId === undefined || boundedString(candidate.clientId, 120))
    );
  }
  if (candidate.type === "feedback-submitted") return isFeedbackReceipt(candidate.receipt);
  if (candidate.type === "feedback-delivered") return integerAtLeast(candidate.sequence, 1);
  if (candidate.type === "feedback-reviewed") {
    const common =
      integerAtLeast(candidate.sequence, 1) &&
      (candidate.decision === "pending" ||
        candidate.decision === "resolved" ||
        candidate.decision === "needs-work" ||
        candidate.decision === "dismissed");
    return Boolean(
      common &&
        (candidate.subject === "message" ||
          (candidate.subject === "annotation" && boundedString(candidate.annotationId, 120))),
    );
  }
  return false;
}

export function isBridgeToParentMessage(value: unknown, token: string): value is BridgeToParentMessage {
  const candidate = record(value);
  if (!candidate || candidate.source !== "agent-html-render-bridge" || candidate.token !== token) return false;
  if (candidate.type === "ready") return true;
  if (candidate.type === "selection-mode-ready") return typeof candidate.enabled === "boolean";
  if (candidate.type === "selection-rejected") {
    return candidate.reason === "keyboard-text-unavailable" ||
      (candidate.reason === "text-selection-too-long" && candidate.maximum === 1_200);
  }
  if (candidate.type === "target-selected") return isTargetDescriptor(candidate.target);
  if (candidate.type === "keyboard-target-changed") return isTargetDescriptor(candidate.target);
  if (
    candidate.type === "keyboard-target-cleared" ||
    candidate.type === "keyboard-target-unavailable" ||
    candidate.type === "selection-cancelled"
  ) return true;
  if (candidate.type === "annotation-activated") return boundedString(candidate.annotationId, 256);
  if (candidate.type === "overlay-layout") {
    return (
      Array.isArray(candidate.overlays) &&
      candidate.overlays.length <= 152 &&
      candidate.overlays.every((value) => {
        const overlay = record(value);
        const rect = overlay ? record(overlay.rect) : undefined;
        return Boolean(
          overlay &&
            boundedString(overlay.id, 256) &&
            (overlay.kind === "hover" || overlay.kind === "selection" || overlay.kind === "annotation") &&
            rect &&
            boundedFiniteNumber(rect.left, 0, 100_000) &&
            boundedFiniteNumber(rect.top, 0, 100_000) &&
            boundedFiniteNumber(rect.width, 0, 100_000) &&
            boundedFiniteNumber(rect.height, 0, 100_000) &&
            (overlay.label === undefined || boundedString(overlay.label, 12)) &&
            (overlay.tone === undefined || overlay.tone === "draft" || overlay.tone === "history") &&
            (overlay.kind === "annotation"
              ? boundedString(overlay.label, 12) && (overlay.tone === "draft" || overlay.tone === "history")
              : overlay.label === undefined && overlay.tone === undefined),
        );
      })
    );
  }
  if (candidate.type !== "anchor-resolutions" || !Array.isArray(candidate.resolutions)) return false;
  return (
    candidate.resolutions.length <= 150 &&
    candidate.resolutions.every((value) => {
      const resolution = record(value);
      return Boolean(
        resolution &&
          boundedString(resolution.id, 256) &&
          (resolution.resolution === "attached" || resolution.resolution === "unresolved") &&
          (resolution.currentTarget === undefined || isTargetDescriptor(resolution.currentTarget)),
      );
    })
  );
}

export function isParentToBridgeMessage(value: unknown, token: string): value is ParentToBridgeMessage {
  const candidate = record(value);
  if (!candidate || candidate.source !== "agent-html-render-shell" || candidate.token !== token) return false;
  if (candidate.type === "clear-selection") return true;
  if (candidate.type === "set-selection-mode") return typeof candidate.enabled === "boolean";
  return (
    (candidate.type === "show-annotations" || candidate.type === "resolve-annotations") &&
    Array.isArray(candidate.markers) &&
    candidate.markers.length <= 150 &&
    candidate.markers.every((value) => {
      const marker = record(value);
      return Boolean(
        marker &&
          boundedString(marker.id, 256) &&
          boundedString(marker.label, 12) &&
          (marker.tone === "draft" || marker.tone === "history") &&
          isDraftAnnotation(marker.annotation),
      );
    })
  );
}
