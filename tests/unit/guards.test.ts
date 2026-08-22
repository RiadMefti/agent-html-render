import { describe, expect, it } from "vitest";
import {
  isBridgeToParentMessage,
  isParentToBridgeMessage,
  isReviewEvent,
} from "../../src/shared/guards.js";

const target = {
  kind: "element" as const,
  tag: "h2",
  cssPath: '[data-agentlens-id="phase"] > h2',
  domPath: [1, 2],
  text: "Offer",
  headingPath: ["Rollout", "Offer"],
};

describe("bridge message guards", () => {
  it("accepts bounded messages with the expected channel token", () => {
    expect(
      isBridgeToParentMessage(
        { source: "agentlens-bridge", token: "token", type: "target-selected", target },
        "token",
      ),
    ).toBe(true);
    expect(
      isParentToBridgeMessage(
        {
          source: "agentlens-shell",
          token: "token",
          type: "show-annotations",
          annotations: [
            {
              id: "annotation",
              comment: "Rename this phase.",
              createdAt: "2026-08-22T00:00:00.000Z",
              target,
            },
          ],
        },
        "token",
      ),
    ).toBe(true);
  });

  it("rejects spoofed, malformed, and oversized bridge payloads", () => {
    expect(
      isBridgeToParentMessage(
        { source: "agentlens-bridge", token: "wrong", type: "target-selected", target },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agentlens-bridge",
          token: "token",
          type: "target-selected",
          target: { ...target, headingPath: null },
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isParentToBridgeMessage(
        {
          source: "agentlens-shell",
          token: "token",
          type: "show-annotations",
          annotations: Array.from({ length: 101 }, () => ({})),
        },
        "token",
      ),
    ).toBe(false);
  });

  it("validates bounded review lifecycle events", () => {
    expect(
      isReviewEvent({
        type: "feedback-submitted",
        receipt: {
          sequence: 2,
          status: "feedback",
          sentAt: "2026-08-22T00:00:00.000Z",
          revision: 3,
        },
        updatedAt: "2026-08-22T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isReviewEvent({
        type: "feedback-delivered",
        sequence: 2,
        updatedAt: "2026-08-22T00:00:01.000Z",
      }),
    ).toBe(true);
    expect(
      isReviewEvent({
        type: "feedback-delivered",
        sequence: -1,
        updatedAt: "2026-08-22T00:00:01.000Z",
      }),
    ).toBe(false);
  });
});
