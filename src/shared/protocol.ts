export const PROTOCOL_VERSION = "1" as const;

export type SessionStatus = "open" | "ended";
export type FeedbackStatus = "feedback" | "ended";
export type AnchorResolution = "attached" | "unresolved";
export type StableAttribute = "data-agentrender-id" | "data-agentlens-id" | "id";

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
  stableId?: string;
  stableAttribute?: StableAttribute;
  cssPath: string;
  domPath: number[];
  text: string;
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
}

export interface ReviewDraft {
  message: string;
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
  latestFeedback: FeedbackReceipt | null;
  deliveredFeedbackSequence: number;
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
  annotations: DraftAnnotation[];
}

export interface FeedbackDelivery {
  sequence: number;
  feedback: FeedbackEnvelope;
  markdown: string;
}

export interface FeedbackReceipt {
  sequence: number;
  status: FeedbackStatus;
  sentAt: string;
  revision: number;
}

export type ReviewEvent =
  | { type: "revision"; revision: number; contentHash: string; updatedAt: string }
  | { type: "status"; status: SessionStatus; updatedAt: string }
  | { type: "draft"; draft: ReviewDraft; updatedAt: string }
  | { type: "feedback-submitted"; receipt: FeedbackReceipt; updatedAt: string }
  | { type: "feedback-delivered"; sequence: number; updatedAt: string };

export interface BridgeConfiguration {
  sessionId: string;
  token: string;
  parentOrigin: string;
}

export type BridgeToParentMessage =
  | { source: "agentrender-bridge"; token: string; type: "ready" }
  | {
      source: "agentrender-bridge";
      token: string;
      type: "target-selected";
      target: TargetDescriptor;
    }
  | {
      source: "agentrender-bridge";
      token: string;
      type: "anchor-resolutions";
      resolutions: Array<{ id: string; resolution: AnchorResolution }>;
    };

export type ParentToBridgeMessage =
  | {
      source: "agentrender-shell";
      token: string;
      type: "set-selection-mode";
      enabled: boolean;
    }
  | {
      source: "agentrender-shell";
      token: string;
      type: "show-annotations";
      annotations: DraftAnnotation[];
    }
  | {
      source: "agentrender-shell";
      token: string;
      type: "clear-selection";
    };

type WithoutBridgeEnvelope<T> = T extends unknown ? Omit<T, "source" | "token"> : never;

export type BridgeToParentPayload = WithoutBridgeEnvelope<BridgeToParentMessage>;
export type ParentToBridgePayload = WithoutBridgeEnvelope<ParentToBridgeMessage>;

export const EMPTY_DRAFT: ReviewDraft = Object.freeze({
  message: "",
  annotations: [],
});
