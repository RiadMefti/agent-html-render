import { z } from "zod";
import type { ReviewDraft } from "../shared/protocol.js";

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
  stableId: boundedString(300).optional(),
  stableAttribute: z
    .enum(["data-agent-html-render-id", "data-agentrender-id", "data-agentlens-id", "id"])
    .optional(),
  cssPath: boundedString(2_000),
  domPath: z.array(z.number().int().nonnegative()).max(64),
  text: boundedString(1_200),
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
});

export const reviewDraftSchema = z.object({
  message: z.string().max(8_000),
  annotations: z.array(annotationSchema).max(100),
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
  annotations: z.array(annotationSchema).max(100),
});

const feedbackDeliverySchema = z.object({
  sequence: z.number().int().positive(),
  feedback: feedbackEnvelopeSchema,
  markdown: z.string().max(1_000_000),
});

export const persistedSessionSchema = z.object({
  protocolVersion: z.literal("1"),
  id: boundedString(120),
  secret: boundedString(256),
  bridgeToken: boundedString(256),
  rootPath: boundedString(4_096),
  artifactPath: boundedString(4_096),
  artifactRelativePath: boundedString(4_096),
  artifactName: boundedString(512),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["open", "ended"]),
  createdAt: boundedString(80),
  updatedAt: boundedString(80),
  draft: reviewDraftSchema,
  feedbackEvents: z.array(feedbackDeliverySchema).max(50),
  deliveredFeedbackSequence: z.number().int().nonnegative(),
});

export function parseReviewDraft(input: unknown): ReviewDraft {
  return reviewDraftSchema.parse(input) as ReviewDraft;
}

export function parseSendBody(input: unknown): { draft: ReviewDraft; end: boolean } {
  const parsed = z
    .object({
      draft: reviewDraftSchema,
      end: z.boolean().default(false),
    })
    .parse(input);
  return { draft: parsed.draft as ReviewDraft, end: parsed.end };
}
