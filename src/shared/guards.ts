import type {
  BridgeToParentMessage,
  DraftAnnotation,
  FeedbackReceipt,
  ParentToBridgeMessage,
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
    !Array.isArray(candidate.headingPath) ||
    candidate.headingPath.length > 12 ||
    !candidate.headingPath.every((item) => boundedString(item, 240))
  ) {
    return false;
  }
  if (candidate.role !== undefined && !boundedString(candidate.role, 120)) return false;
  if (candidate.label !== undefined && !boundedString(candidate.label, 240)) return false;
  if (candidate.stableId !== undefined && !boundedString(candidate.stableId, 300)) return false;
  if (
    candidate.stableAttribute !== undefined &&
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
  return Boolean(
    candidate &&
      boundedString(candidate.id, 120) &&
      boundedString(candidate.comment, 4_000) &&
      candidate.comment.trim() &&
      boundedString(candidate.createdAt, 80) &&
      isTargetDescriptor(candidate.target) &&
      (candidate.resolution === undefined ||
        candidate.resolution === "attached" ||
        candidate.resolution === "unresolved"),
  );
}

export function isReviewDraft(value: unknown): value is ReviewDraft {
  const candidate = record(value);
  return Boolean(
    candidate &&
      boundedString(candidate.message, 8_000) &&
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
      (candidate.status === "feedback" || candidate.status === "ended") &&
      boundedString(candidate.sentAt, 80) &&
      integerAtLeast(candidate.revision, 1),
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
  if (candidate.type === "status") return candidate.status === "open" || candidate.status === "ended";
  if (candidate.type === "draft") return isReviewDraft(candidate.draft);
  if (candidate.type === "feedback-submitted") return isFeedbackReceipt(candidate.receipt);
  if (candidate.type === "feedback-delivered") return integerAtLeast(candidate.sequence, 1);
  return false;
}

export function isBridgeToParentMessage(value: unknown, token: string): value is BridgeToParentMessage {
  const candidate = record(value);
  if (!candidate || candidate.source !== "agentlens-bridge" || candidate.token !== token) return false;
  if (candidate.type === "ready") return true;
  if (candidate.type === "target-selected") return isTargetDescriptor(candidate.target);
  if (candidate.type !== "anchor-resolutions" || !Array.isArray(candidate.resolutions)) return false;
  return (
    candidate.resolutions.length <= 100 &&
    candidate.resolutions.every((value) => {
      const resolution = record(value);
      return Boolean(
        resolution &&
          boundedString(resolution.id, 120) &&
          (resolution.resolution === "attached" || resolution.resolution === "unresolved"),
      );
    })
  );
}

export function isParentToBridgeMessage(value: unknown, token: string): value is ParentToBridgeMessage {
  const candidate = record(value);
  if (!candidate || candidate.source !== "agentlens-shell" || candidate.token !== token) return false;
  if (candidate.type === "clear-selection") return true;
  if (candidate.type === "set-selection-mode") return typeof candidate.enabled === "boolean";
  return (
    candidate.type === "show-annotations" &&
    Array.isArray(candidate.annotations) &&
    candidate.annotations.length <= 100 &&
    candidate.annotations.every(isDraftAnnotation)
  );
}
