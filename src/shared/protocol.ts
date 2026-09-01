export const PROTOCOL_VERSION = "1" as const;
export const EXPLICIT_FEEDBACK_ACK_CAPABILITY = "explicit-feedback-ack-v1" as const;
export const FEEDBACK_ACK_HEADER = "x-agent-html-render-feedback-ack" as const;

const FEEDBACK_CONSUMER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/u;
const FEEDBACK_LEASE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/u;

export function isFeedbackConsumerId(value: unknown): value is string {
  return typeof value === "string" && FEEDBACK_CONSUMER_ID_PATTERN.test(value);
}

export function isFeedbackLeaseId(value: unknown): value is string {
  return typeof value === "string" && FEEDBACK_LEASE_ID_PATTERN.test(value);
}

export function assertFeedbackConsumerId(value: unknown): asserts value is string {
  if (!isFeedbackConsumerId(value)) {
    throw new Error(
      "Feedback delivery requires a valid consumer ID: 1-120 letters, digits, periods, underscores, " +
      "colons, or hyphens, beginning with a letter or digit.",
    );
  }
}

export function assertFeedbackLeaseId(value: unknown): asserts value is string {
  if (!isFeedbackLeaseId(value)) {
    throw new Error("Feedback delivery requires an exact 32-character base64url lease ID.");
  }
}

export type SessionStatus = "open" | "ended" | "superseded";
export type FeedbackStatus = "feedback" | "ended";
export type AnchorResolution = "attached" | "unresolved";
export type ChangeReviewDecision = "pending" | "resolved" | "needs-work" | "dismissed";
export type StableAttribute =
  | "data-agent-html-render-id"
  | "data-agentrender-id"
  | "data-agentlens-id"
  | "id";

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface RangeAnchor {
  startPath: number[];
  startOffset: number;
  endPath: number[];
  endOffset: number;
}

export interface TargetDescriptor {
  kind: "element" | "text";
  tag: string;
  role?: string;
  label?: string;
  semanticSignature?: string;
  textSignature?: string;
  identityUnresolvable?: boolean;
  stableId?: string;
  stableAttribute?: StableAttribute;
  cssPath: string;
  domPath: number[];
  text: string;
  displayText?: string;
  textQuote?: TextQuote;
  headingPath: string[];
  range?: RangeAnchor;
}

export interface DraftAnnotation {
  id: string;
  comment: string;
  createdAt: string;
  target: TargetDescriptor;
  resolution?: AnchorResolution;
  requeuedFrom?: {
    sequence: number;
    annotationId: string;
    sourceDigest?: string;
  };
}

export interface ReviewDraft {
  message: string;
  requeuedMessageSequences?: number[];
  annotations: DraftAnnotation[];
}

export interface PublicSessionState {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  artifactName: string;
  artifactRelativePath: string;
  revision: number;
  contentHash: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  bridgeToken: string;
  draft: ReviewDraft;
  draftBaseRevision: number;
  draftBaseContentHash: string;
  draftRecoveryRequired: boolean;
  latestFeedback: FeedbackReceipt | null;
  deliveredFeedbackSequence: number;
  feedbackHistory: FeedbackHistoryEntry[];
}

export interface FeedbackHistoryAnnotation {
  annotation: DraftAnnotation;
  decision: ChangeReviewDecision;
}

export interface FeedbackHistoryEntry {
  sequence: number;
  status: FeedbackStatus;
  sentAt: string;
  revision: number;
  contentHash: string;
  reviewerMessage: string;
  reviewerMessageDecision: ChangeReviewDecision | null;
  requeuedMessageSequences: number[];
  delivered: boolean;
  annotations: FeedbackHistoryAnnotation[];
}

export interface FeedbackSessionReference {
  id: string;
  artifactName: string;
  artifactRelativePath: string;
  revision: number;
  contentHash: string;
}

export interface FeedbackEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  status: FeedbackStatus;
  sentAt: string;
  session: FeedbackSessionReference;
  reviewerMessage: string;
  requeuedMessageSequences: number[];
  annotations: DraftAnnotation[];
}

export interface FeedbackDelivery {
  sequence: number;
  submissionId?: string;
  feedback: FeedbackEnvelope;
  markdown: string;
}

export interface FeedbackReceipt {
  sequence: number;
  submissionId?: string;
  status: FeedbackStatus;
  sentAt: string;
  revision: number;
}

export type ReviewEvent =
  | { type: "revision"; revision: number; contentHash: string; updatedAt: string }
  | { type: "status"; status: SessionStatus; updatedAt: string }
  | {
      type: "draft";
      draft: ReviewDraft;
      baseRevision: number;
      baseContentHash: string;
      clientId?: string;
      updatedAt: string;
    }
  | { type: "feedback-submitted"; receipt: FeedbackReceipt; updatedAt: string }
  | { type: "feedback-delivered"; sequence: number; updatedAt: string }
  | {
      type: "feedback-reviewed";
      sequence: number;
      subject: "annotation";
      annotationId: string;
      decision: ChangeReviewDecision;
      updatedAt: string;
    }
  | {
      type: "feedback-reviewed";
      sequence: number;
      subject: "message";
      decision: ChangeReviewDecision;
      updatedAt: string;
    };

export interface BridgeAnnotationMarker {
  id: string;
  label: string;
  tone: "draft" | "history";
  annotation: DraftAnnotation;
}

export interface BridgeConfiguration {
  sessionId: string;
  token: string;
  parentOrigin: string;
}

export interface BridgeOverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BridgeOverlay {
  id: string;
  kind: "hover" | "selection" | "annotation";
  rect: BridgeOverlayRect;
  label?: string;
  tone?: "draft" | "history";
}

export type BridgeToParentMessage =
  | { source: "agent-html-render-bridge"; token: string; type: "ready" }
  | {
      source: "agent-html-render-bridge";
      token: string;
      type: "selection-mode-ready";
      enabled: boolean;
    }
  | {
      source: "agent-html-render-bridge";
      token: string;
      type: "selection-rejected";
      reason: "text-selection-too-long";
      maximum: number;
    }
  | {
      source: "agent-html-render-bridge";
      token: string;
      type: "selection-rejected";
      reason: "keyboard-text-unavailable";
    }
  | {
      source: "agent-html-render-bridge";
      token: string;
      type: "target-selected";
      target: TargetDescriptor;
    }
  | {
      source: "agent-html-render-bridge";
      token: string;
      type: "keyboard-target-changed";
      target: TargetDescriptor;
    }
  | {
      source: "agent-html-render-bridge";
      token: string;
      type: "keyboard-target-cleared" | "keyboard-target-unavailable" | "selection-cancelled";
    }
  | {
      source: "agent-html-render-bridge";
      token: string;
      type: "annotation-activated";
      annotationId: string;
    }
  | {
      source: "agent-html-render-bridge";
      token: string;
      type: "anchor-resolutions";
      resolutions: Array<{ id: string; resolution: AnchorResolution; currentTarget?: TargetDescriptor }>;
    }
  | {
      source: "agent-html-render-bridge";
      token: string;
      type: "overlay-layout";
      overlays: BridgeOverlay[];
    };

export type ParentToBridgeMessage =
  | {
      source: "agent-html-render-shell";
      token: string;
      type: "set-selection-mode";
      enabled: boolean;
    }
  | {
      source: "agent-html-render-shell";
      token: string;
      type: "show-annotations";
      markers: BridgeAnnotationMarker[];
    }
  | {
      source: "agent-html-render-shell";
      token: string;
      type: "resolve-annotations";
      markers: BridgeAnnotationMarker[];
    }
  | {
      source: "agent-html-render-shell";
      token: string;
      type: "clear-selection";
    };

type WithoutBridgeEnvelope<T> = T extends unknown ? Omit<T, "source" | "token"> : never;

export type BridgeToParentPayload = WithoutBridgeEnvelope<BridgeToParentMessage>;
export type ParentToBridgePayload = WithoutBridgeEnvelope<ParentToBridgeMessage>;

export const EMPTY_DRAFT: ReviewDraft = Object.freeze({
  message: "",
  requeuedMessageSequences: [],
  annotations: [],
});
