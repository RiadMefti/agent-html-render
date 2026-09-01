import { describe, expect, it } from "vitest";
import {
  isBridgeToParentMessage,
  isParentToBridgeMessage,
  isReviewEvent,
} from "../../src/shared/guards.js";

const target = {
  kind: "element" as const,
  tag: "h2",
  cssPath: '[data-agent-html-render-id="phase"] > h2',
  domPath: [1, 2],
  text: "Offer",
  headingPath: ["Rollout", "Offer"],
};

describe("bridge message guards", () => {
  it("accepts bounded messages with the expected channel token", () => {
    expect(
      isBridgeToParentMessage(
        { source: "agent-html-render-bridge", token: "token", type: "target-selected", target },
        "token",
      ),
    ).toBe(true);
    expect(
      isBridgeToParentMessage(
        { source: "agent-html-render-bridge", token: "token", type: "keyboard-target-changed", target },
        "token",
      ),
    ).toBe(true);
    expect(
      isBridgeToParentMessage(
        { source: "agent-html-render-bridge", token: "token", type: "selection-mode-ready", enabled: true },
        "token",
      ),
    ).toBe(true);
    for (const type of [
      "keyboard-target-cleared",
      "keyboard-target-unavailable",
      "selection-cancelled",
    ] as const) {
      expect(
        isBridgeToParentMessage(
          { source: "agent-html-render-bridge", token: "token", type },
          "token",
        ),
      ).toBe(true);
    }
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "selection-rejected",
          reason: "text-selection-too-long",
          maximum: 1_200,
        },
        "token",
      ),
    ).toBe(true);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "selection-rejected",
          reason: "keyboard-text-unavailable",
        },
        "token",
      ),
    ).toBe(true);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "overlay-layout",
          overlays: [
            {
              id: "history:1:annotation",
              kind: "annotation",
              rect: { left: 12, top: 24, width: 180, height: 40 },
              label: "F1.1",
              tone: "history",
            },
          ],
        },
        "token",
      ),
    ).toBe(true);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "annotation-activated",
          annotationId: "annotation",
        },
        "token",
      ),
    ).toBe(true);
    expect(
      isParentToBridgeMessage(
        {
          source: "agent-html-render-shell",
          token: "token",
          type: "show-annotations",
          markers: [
            {
              id: "draft:annotation",
              label: "1",
              tone: "draft",
              annotation: {
                id: "annotation",
                comment: "Rename this phase.",
                createdAt: "2026-08-22T00:00:00.000Z",
                target,
              },
            },
          ],
        },
        "token",
      ),
    ).toBe(true);
    expect(
      isParentToBridgeMessage(
        {
          source: "agent-html-render-shell",
          token: "token",
          type: "resolve-annotations",
          markers: [
            {
              id: "history:1:annotation",
              label: "F1.1",
              tone: "history",
              annotation: {
                id: "annotation",
                comment: "Rename this phase.",
                createdAt: "2026-08-22T00:00:00.000Z",
                target,
              },
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
        { source: "agent-html-render-bridge", token: "token", type: "selection-mode-ready", enabled: "yes" },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "target-selected",
          target: { ...target, semanticSignature: "a11y-v1:not-a-digest" },
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "keyboard-target-changed",
          target: { ...target, domPath: Array.from({ length: 65 }, () => 0) },
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "target-selected",
          target: { ...target, identityUnresolvable: false },
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "target-selected",
          target: { ...target, textSignature: "text-v1:not-a-digest" },
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "keyboard-target-changed",
          target: { ...target, displayText: "x".repeat(1_201) },
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        { source: "agent-html-render-bridge", token: "wrong", type: "target-selected", target },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "selection-rejected",
          reason: "text-selection-too-long",
          maximum: 1_201,
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "overlay-layout",
          overlays: [{ id: "hover", kind: "hover", rect: { left: 0, top: 0, width: Infinity, height: 20 } }],
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "overlay-layout",
          overlays: [{ id: "fake", kind: "annotation", rect: { left: 0, top: 0, width: 20, height: 20 } }],
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "target-selected",
          target: { ...target, headingPath: null },
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isBridgeToParentMessage(
        {
          source: "agent-html-render-bridge",
          token: "token",
          type: "annotation-activated",
          annotationId: "x".repeat(257),
        },
        "token",
      ),
    ).toBe(false);
    expect(
      isParentToBridgeMessage(
        {
          source: "agent-html-render-shell",
          token: "token",
          type: "show-annotations",
          markers: Array.from({ length: 151 }, () => ({})),
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
          submissionId: "submission-2",
          status: "feedback",
          sentAt: "2026-08-22T00:00:00.000Z",
          revision: 3,
        },
        updatedAt: "2026-08-22T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isReviewEvent({
        type: "feedback-reviewed",
        sequence: 2,
        subject: "message",
        decision: "resolved",
        updatedAt: "2026-08-22T00:00:01.000Z",
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
