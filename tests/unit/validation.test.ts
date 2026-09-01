import { expect, test } from "vitest";
import {
  parseFeedbackAckBody,
  parseFeedbackLeaseReleaseBody,
  parseFeedbackLeaseRenewalBody,
  parseLeasedFeedbackDelivery,
} from "../../src/node/validation.js";
import { isFeedbackConsumerId, isFeedbackLeaseId } from "../../src/shared/protocol.js";

const feedbackDelivery = {
  sequence: 1,
  feedback: {
    protocolVersion: "1",
    status: "feedback",
    sentAt: "2026-08-31T00:00:00.000Z",
    session: {
      id: "session-1",
      artifactName: "plan.html",
      artifactRelativePath: "plan.html",
      revision: 1,
      contentHash: "a".repeat(64),
    },
    reviewerMessage: "Ship it.",
    requeuedMessageSequences: [],
    annotations: [],
  },
  markdown: "# Feedback\n",
};

test("accepts every leading character produced by 24-byte base64url lease IDs", () => {
  const edgeLeaseIds = [0xf8, 0xfc].map((firstByte) =>
    Buffer.concat([Buffer.from([firstByte]), Buffer.alloc(23)]).toString("base64url")
  );
  expect(edgeLeaseIds).toEqual([
    `-${"A".repeat(31)}`,
    `_${"A".repeat(31)}`,
  ]);

  for (const leaseId of edgeLeaseIds) {
    expect(parseFeedbackAckBody({ sequence: 1, consumerId: "consumer-1", leaseId }))
      .toEqual({ sequence: 1, consumerId: "consumer-1", leaseId });
    expect(parseFeedbackLeaseReleaseBody({ sequence: 1, consumerId: "consumer-1", leaseId }))
      .toEqual({ sequence: 1, consumerId: "consumer-1", leaseId });
    expect(parseFeedbackLeaseRenewalBody({ sequence: 1, consumerId: "consumer-1", leaseId }))
      .toEqual({ sequence: 1, consumerId: "consumer-1", leaseId });
    const parsed = parseLeasedFeedbackDelivery({ ...feedbackDelivery, leaseId });
    expect(parsed.leaseId).toBe(leaseId);
    expect(parsed.delivery).toEqual(feedbackDelivery);
    expect(parsed.delivery).not.toHaveProperty("leaseId");
  }
});

test("rejects lease IDs outside the exact generated base64url format", () => {
  for (const leaseId of ["A".repeat(31), "A".repeat(33), `.${"A".repeat(31)}`, `:${"A".repeat(31)}`]) {
    expect(() => parseFeedbackAckBody({ sequence: 1, consumerId: "consumer-1", leaseId })).toThrow();
    expect(() => parseFeedbackLeaseReleaseBody({ sequence: 1, consumerId: "consumer-1", leaseId })).toThrow();
    expect(() => parseFeedbackLeaseRenewalBody({ sequence: 1, consumerId: "consumer-1", leaseId })).toThrow();
    expect(() => parseLeasedFeedbackDelivery({ ...feedbackDelivery, leaseId })).toThrow();
  }
});

test("uses one bounded consumer and lease identity grammar across runtime validation", () => {
  const leaseId = "A".repeat(32);
  for (const consumerId of ["a", "consumer-1", "request:agent.name_2", `a${"b".repeat(119)}`]) {
    expect(isFeedbackConsumerId(consumerId)).toBe(true);
    expect(parseFeedbackAckBody({ sequence: 1, consumerId, leaseId }))
      .toEqual({ sequence: 1, consumerId, leaseId });
  }
  for (const consumerId of [undefined, null, 0, {}, "", ".leading", " space", `a${"b".repeat(120)}`]) {
    expect(isFeedbackConsumerId(consumerId)).toBe(false);
    expect(() => parseFeedbackAckBody({ sequence: 1, consumerId, leaseId })).toThrow();
  }
  expect(isFeedbackLeaseId(leaseId)).toBe(true);
  expect(isFeedbackLeaseId("A".repeat(31))).toBe(false);
});
