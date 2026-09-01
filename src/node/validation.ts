import { z } from "zod";
import {
  isFeedbackConsumerId,
  isFeedbackLeaseId,
  type FeedbackDelivery,
  type ReviewDraft,
} from "../shared/protocol.js";

const boundedString = (maximum: number) => z.string().max(maximum);

const textQuoteSchema = z.object({
  exact: boundedString(1_200),
  prefix: boundedString(240),
  suffix: boundedString(240),
});

const rangeAnchorSchema = z.object({
  startPath: z.array(z.number().int().nonnegative()).max(64),
  startOffset: z.number().int().nonnegative().max(10_000_000),
  endPath: z.array(z.number().int().nonnegative()).max(64),
  endOffset: z.number().int().nonnegative().max(10_000_000),
});

const targetDescriptorSchema = z.object({
  kind: z.enum(["element", "text"]),
  tag: boundedString(80),
  role: boundedString(120).optional(),
  label: boundedString(240).optional(),
  semanticSignature: z.string().regex(/^a11y-v1:[a-f0-9]{64}$/).optional(),
  textSignature: z.string().regex(/^text-v1:[a-f0-9]{64}$/).optional(),
  identityUnresolvable: z.literal(true).optional(),
  stableId: boundedString(300).optional(),
  stableAttribute: z
    .enum(["data-agent-html-render-id", "data-agentrender-id", "data-agentlens-id", "id"])
    .optional(),
  cssPath: boundedString(2_000),
  domPath: z.array(z.number().int().nonnegative()).max(64),
  text: boundedString(1_200),
  displayText: boundedString(1_200).optional(),
  textQuote: textQuoteSchema.optional(),
  headingPath: z.array(boundedString(240)).max(12),
  range: rangeAnchorSchema.optional(),
});

const annotationSchema = z.object({
  id: boundedString(120),
  comment: z.string().trim().min(1).max(4_000),
  createdAt: boundedString(80),
  target: targetDescriptorSchema,
  resolution: z.enum(["attached", "unresolved"]).optional(),
  requeuedFrom: z
    .object({
      sequence: z.number().int().positive(),
      annotationId: boundedString(120),
      sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
    .optional(),
});

export const reviewDraftSchema = z.object({
  message: z.string().max(8_000),
  requeuedMessageSequences: z.array(z.number().int().positive()).max(50).default([]),
  annotations: z.array(annotationSchema).max(100),
}).refine((draft) => draft.requeuedMessageSequences.length === 0 || Boolean(draft.message.trim()), {
  message: "A requeued reviewer message must include message text.",
  path: ["requeuedMessageSequences"],
});

const feedbackEnvelopeSchema = z.object({
  protocolVersion: z.literal("1"),
  status: z.enum(["feedback", "ended"]),
  sentAt: boundedString(80),
  session: z.object({
    id: boundedString(120),
    artifactName: boundedString(512),
    artifactRelativePath: boundedString(4_096),
    revision: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  reviewerMessage: z.string().max(8_000),
  requeuedMessageSequences: z.array(z.number().int().positive()).max(50).default([]),
  annotations: z.array(annotationSchema).max(100),
});

const feedbackDeliverySchema = z.object({
  sequence: z.number().int().positive(),
  submissionId: boundedString(120).optional(),
  feedback: feedbackEnvelopeSchema,
  markdown: z.string().max(1_000_000),
});

const deliveryLeaseIdSchema = z.string().refine(isFeedbackLeaseId, "Invalid feedback delivery lease ID.");
const deliveryConsumerIdSchema = z.string().refine(isFeedbackConsumerId, "Invalid feedback consumer ID.");
const feedbackLeaseMutationBodySchema = z.object({
  sequence: z.number().int().positive(),
  consumerId: deliveryConsumerIdSchema,
  leaseId: deliveryLeaseIdSchema,
});
const leasedFeedbackDeliverySchema = feedbackDeliverySchema.extend({ leaseId: deliveryLeaseIdSchema });
const deliveryAcknowledgementSchema = z.object({
  sequence: z.number().int().positive(),
  grantDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

const submissionRecordSchema = z.object({
  submissionId: boundedString(120),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: z.object({
    sequence: z.number().int().positive(),
    submissionId: boundedString(120),
    status: z.enum(["feedback", "ended"]),
    sentAt: boundedString(80),
    revision: z.number().int().positive(),
  }),
}).refine((record) => record.receipt.submissionId === record.submissionId, {
  message: "A submission journal receipt must match its submission ID.",
  path: ["receipt", "submissionId"],
});

export const persistedSessionSchema = z.object({
  protocolVersion: z.literal("1"),
  id: boundedString(120),
  secret: boundedString(256),
  bridgeToken: boundedString(256),
  rootPath: boundedString(4_096),
  rootDevice: z.string().regex(/^\d+$/).max(80).optional(),
  rootInode: z.string().regex(/^\d+$/).max(80).optional(),
  parentDevice: z.string().regex(/^\d+$/).max(80).optional(),
  parentInode: z.string().regex(/^\d+$/).max(80).optional(),
  artifactPath: boundedString(4_096),
  artifactRelativePath: boundedString(4_096),
  artifactName: boundedString(512),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["open", "ended", "superseded"]),
  createdAt: boundedString(80),
  updatedAt: boundedString(80),
  draft: reviewDraftSchema,
  draftBaseRevision: z.number().int().positive().optional(),
  draftBaseContentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  draftRecoveryRequired: z.boolean().default(false),
  recoveredFromSessionId: boundedString(120).optional(),
  recoverySourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  supersededBySessionId: boundedString(120).optional(),
  feedbackEvents: z.array(feedbackDeliverySchema).max(50),
  feedbackDecisions: z
    .record(z.string(), z.enum(["pending", "resolved", "needs-work", "dismissed"]))
    .default({}),
  feedbackMessageDecisions: z
    .record(z.string(), z.enum(["pending", "resolved", "needs-work", "dismissed"]))
    .default({}),
  submissionRecords: z.array(submissionRecordSchema).max(2_048).default([]),
  deliveredFeedbackSequence: z.number().int().nonnegative(),
  deliveryAcknowledgements: z.array(deliveryAcknowledgementSchema).max(2_048).default([]),
}).superRefine((session, context) => {
  if (Boolean(session.recoveredFromSessionId) !== Boolean(session.recoverySourceDigest)) {
    context.addIssue({
      code: "custom",
      message: "A recovered session must retain both its source session and source digest.",
      path: ["recoveredFromSessionId"],
    });
  }
  if (session.status === "superseded" && !session.supersededBySessionId) {
    context.addIssue({
      code: "custom",
      message: "A superseded session must identify its replacement session.",
      path: ["supersededBySessionId"],
    });
  }
  const submissionIds = new Set<string>();
  session.submissionRecords.forEach((record, index) => {
    if (submissionIds.has(record.submissionId)) {
      context.addIssue({
        code: "custom",
        message: "Submission journal IDs must be unique.",
        path: ["submissionRecords", index, "submissionId"],
      });
    }
    submissionIds.add(record.submissionId);
  });
  let previousAcknowledgedSequence = 0;
  session.deliveryAcknowledgements.forEach((acknowledgement, index) => {
    if (
      acknowledgement.sequence <= previousAcknowledgedSequence ||
      acknowledgement.sequence > session.deliveredFeedbackSequence
    ) {
      context.addIssue({
        code: "custom",
        message: "Delivery acknowledgement records must be ordered, unique, and no newer than the durable cursor.",
        path: ["deliveryAcknowledgements", index, "sequence"],
      });
    }
    previousAcknowledgedSequence = acknowledgement.sequence;
  });
}).transform((session) => ({
  ...session,
  draftBaseRevision: session.draftBaseRevision ?? session.revision,
  draftBaseContentHash: session.draftBaseContentHash ?? session.contentHash,
}));

export function parseReviewDraft(input: unknown): ReviewDraft {
  return reviewDraftSchema.parse(input) as ReviewDraft;
}

const draftReferenceSchema = z.object({
  draft: reviewDraftSchema,
  baseRevision: z.number().int().positive(),
  baseContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  clientId: boundedString(120).optional(),
  confirmRecovery: z.boolean().default(false),
});

export function parseDraftBody(input: unknown): {
  draft: ReviewDraft;
  baseRevision: number;
  baseContentHash: string;
  clientId?: string;
  confirmRecovery: boolean;
} {
  const parsed = draftReferenceSchema.parse(input);
  return { ...parsed, draft: parsed.draft as ReviewDraft };
}

export function parseSendBody(input: unknown): {
  draft: ReviewDraft;
  end: boolean;
  baseRevision: number;
  baseContentHash: string;
  submissionId: string;
} {
  const parsed = z
    .object({
      draft: reviewDraftSchema,
      end: z.boolean().default(false),
      baseRevision: z.number().int().positive(),
      baseContentHash: z.string().regex(/^[a-f0-9]{64}$/),
      submissionId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
    })
    .parse(input);
  return { ...parsed, draft: parsed.draft as ReviewDraft };
}

export function parseFeedbackAckBody(input: unknown): {
  sequence: number;
  consumerId: string;
  leaseId: string;
} {
  return feedbackLeaseMutationBodySchema.parse(input);
}

export function parseFeedbackLeaseReleaseBody(input: unknown): {
  sequence: number;
  consumerId: string;
  leaseId: string;
} {
  return feedbackLeaseMutationBodySchema.parse(input);
}

export function parseFeedbackLeaseRenewalBody(input: unknown): {
  sequence: number;
  consumerId: string;
  leaseId: string;
} {
  return feedbackLeaseMutationBodySchema.parse(input);
}

export function parseLeasedFeedbackDelivery(input: unknown): {
  delivery: FeedbackDelivery;
  leaseId: string;
} {
  const { leaseId, ...delivery } = leasedFeedbackDeliverySchema.parse(input);
  return { delivery: delivery as FeedbackDelivery, leaseId };
}

export function parseChangeReviewBody(input: unknown): {
  decision: "pending" | "resolved" | "needs-work" | "dismissed";
  requeue: boolean;
} {
  return z
    .object({
      decision: z.enum(["pending", "resolved", "needs-work", "dismissed"]),
      requeue: z.boolean().default(false),
    })
    .parse(input);
}
