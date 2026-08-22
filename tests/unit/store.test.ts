import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/node/artifact.js";
import { SessionStore } from "../../src/node/store.js";

describe("session store", () => {
  it("persists drafts, revisions, delivery cursors, and final status", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentlens-store-"));
    const artifactPath = join(root, "review.html");
    const initial = "<h1>First revision</h1>";
    await writeFile(artifactPath, initial);
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(initial),
    });
    const lifecycle: string[] = [];
    store.onReview(session.id, (event) => lifecycle.push(event.type));

    await store.updateDraft(session.id, { message: "Keep it concise.", annotations: [] });
    await store.bumpRevision(session.id, contentHash("<h1>Second revision</h1>"));
    const delivery = await store.sendFeedback(session.id, store.get(session.id)?.draft ?? { message: "", annotations: [] }, true);

    expect(delivery.sequence).toBe(1);
    expect(delivery.feedback.status).toBe("ended");
    expect(delivery.feedback.session.revision).toBe(2);
    expect(store.getPublicState(session.id)?.latestFeedback).toEqual({
      sequence: 1,
      status: "ended",
      sentAt: delivery.feedback.sentAt,
      revision: 2,
    });
    expect(lifecycle).toContain("feedback-submitted");
    expect(store.nextUndelivered(session.id, 0)?.sequence).toBe(1);
    await store.markDelivered(session.id, 1);
    expect(store.nextUndelivered(session.id, 0)).toBeUndefined();
    expect(store.getPublicState(session.id)?.deliveredFeedbackSequence).toBe(1);
    expect(lifecycle).toContain("feedback-delivered");

    const restored = new SessionStore(root);
    await restored.initialize();
    expect(restored.get(session.id)?.status).toBe("ended");
    expect(restored.get(session.id)?.deliveredFeedbackSequence).toBe(1);
  });

  it("ignores a persisted session whose artifact boundary was tampered with", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentlens-store-boundary-"));
    const artifactPath = join(root, "review.html");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash("<p>Review</p>"),
    });
    const statePath = join(root, ".agentlens", "sessions", `${session.id}.json`);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { rootPath: string };
    persisted.rootPath = "/tmp/not-the-project";
    await writeFile(statePath, `${JSON.stringify(persisted)}\n`);

    const restored = new SessionStore(root);
    await restored.initialize();
    expect(restored.get(session.id)).toBeUndefined();
  });
});
