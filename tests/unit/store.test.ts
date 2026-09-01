import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/node/artifact.js";
import {
  FEEDBACK_LEASE_MILLISECONDS,
  MAX_FEEDBACK_EVENTS,
  RevisionConflictError,
  SessionStore,
  SessionStoreProcessTerminationRequiredError,
  SubmissionConflictError,
} from "../../src/node/store.js";
import { parseReviewDraft } from "../../src/node/validation.js";
import { pinStateBoundary } from "../../src/node/state-boundary.js";

async function acknowledgeFeedbackSequence(
  store: SessionStore,
  sessionId: string,
  sequence: number,
  consumerId: string,
): Promise<void> {
  const leased = store.leaseNextUndelivered(sessionId, sequence - 1, consumerId);
  if (!leased.delivery || leased.delivery.sequence !== sequence) {
    throw new Error(`Expected feedback sequence ${sequence} to be available for acknowledgement.`);
  }
  await store.markDelivered(sessionId, sequence, consumerId, leased.leaseId);
}

async function withMockedNow<Value>(
  now: number,
  work: () => Value | Promise<Value>,
): Promise<Value> {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return await work();
  } finally {
    Date.now = originalNow;
  }
}

describe("session store", () => {
  it.skipIf(process.platform === "win32")("refuses a replacement state tree when startup passes a pinned boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-expected-state-boundary-"));
    const initial = new SessionStore(root);
    await initial.initialize();
    const boundary = await pinStateBoundary(root);
    const stateDirectory = join(root, ".agent-html-render");
    const originalState = join(root, "original-agent-html-render-state");
    await rename(stateDirectory, originalState);
    await mkdir(stateDirectory);

    await expect(new SessionStore(root, { expectedStateBoundary: boundary }).initialize()).rejects.toThrow(
      ".agent-html-render state directory",
    );
    expect(await readdir(stateDirectory)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects a state directory symlink before writing runtime files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-link-root-"));
    const outside = await mkdtemp(join(tmpdir(), "agent-html-render-state-link-outside-"));
    await symlink(outside, join(root, ".agent-html-render"), "dir");

    await expect(new SessionStore(root).initialize()).rejects.toThrow("must not be a symbolic link");
  });

  it.skipIf(process.platform === "win32")("rejects a sessions directory symlink before persisting reviews", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-sessions-link-root-"));
    const outside = await mkdtemp(join(tmpdir(), "agent-html-render-sessions-link-outside-"));
    await mkdir(join(root, ".agent-html-render"));
    await symlink(outside, join(root, ".agent-html-render", "sessions"), "dir");

    await expect(new SessionStore(root).initialize()).rejects.toThrow("sessions directory must not be a symbolic link");
  });

  it.skipIf(process.platform === "win32")("does not write session snapshots through the old predictable temp path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-session-temp-link-"));
    const artifactPath = join(root, "review.html");
    const victimPath = join(root, "victim.txt");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    await writeFile(victimPath, "keep victim");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    const oldTemporaryPath = join(store.sessionsDirectory, `${session.id}.json.tmp`);
    await symlink(victimPath, oldTemporaryPath);

    await store.updateDraft(
      session.id,
      { message: "Persist safely.", annotations: [] },
      session.revision,
      session.contentHash,
    );

    expect(await readFile(victimPath, "utf8")).toBe("keep victim");
    expect((await lstat(oldTemporaryPath)).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("does not redirect snapshots after the pinned sessions directory is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-session-directory-swap-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    const movedSessions = join(root, ".agent-html-render", "sessions-original");
    await rename(store.sessionsDirectory, movedSessions);
    await mkdir(store.sessionsDirectory);
    await writeFile(join(store.sessionsDirectory, "sentinel.txt"), "keep replacement sessions");

    await expect(store.updateDraft(
      session.id,
      { message: "Do not redirect this private note.", annotations: [] },
      session.revision,
      session.contentHash,
    )).rejects.toThrow("changed after Agent HTML Render pinned it");

    expect(await readdir(store.sessionsDirectory)).toEqual(["sentinel.txt"]);
    expect(await readFile(join(store.sessionsDirectory, "sentinel.txt"), "utf8"))
      .toBe("keep replacement sessions");
    expect(await readFile(join(movedSessions, `${session.id}.json`), "utf8"))
      .not.toContain("Do not redirect this private note.");
  });

  it("commits session snapshots with private permissions despite a stale permissive temp file", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-session-temp-mode-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    const oldTemporaryPath = join(store.sessionsDirectory, `${session.id}.json.tmp`);
    await writeFile(oldTemporaryPath, "stale", { mode: 0o644 });
    await chmod(oldTemporaryPath, 0o644);

    await store.updateDraft(
      session.id,
      { message: "Keep credentials private.", annotations: [] },
      session.revision,
      session.contentHash,
    );

    const sessionPath = join(store.sessionsDirectory, `${session.id}.json`);
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
    expect((await stat(oldTemporaryPath)).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === "win32")("repairs a restored session snapshot to mode 0600 before loading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-session-restored-mode-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    const sessionPath = join(store.sessionsDirectory, `${session.id}.json`);
    await chmod(sessionPath, 0o644);

    const restored = new SessionStore(root);
    await restored.initialize();

    expect(restored.get(session.id)?.id).toBe(session.id);
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("fails restart clearly when a session snapshot has another filesystem link", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-session-hardlink-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    await store.sendFeedback(
      session.id,
      { message: "Keep this pending.", annotations: [] },
      false,
      session.revision,
      session.contentHash,
      "hardlink-pending",
    );
    const sessionPath = join(store.sessionsDirectory, `${session.id}.json`);
    const otherName = join(root, "session-other-name.json");
    await link(sessionPath, otherName);

    await expect(new SessionStore(root).initialize()).rejects.toThrow("one filesystem link");
    expect(JSON.parse(await readFile(otherName, "utf8"))).toMatchObject({
      id: session.id,
      feedbackEvents: [{ sequence: 1 }],
    });
  });

  it.skipIf(process.platform === "win32")("rejects a multiply linked state ignore file without changing its other name", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-ignore-hardlink-"));
    const stateDirectory = join(root, ".agent-html-render");
    const victimPath = join(root, "victim.txt");
    await mkdir(stateDirectory);
    await writeFile(victimPath, "/keep-victim\n");
    await link(victimPath, join(stateDirectory, ".gitignore"));

    await expect(new SessionStore(root).initialize()).rejects.toThrow("one filesystem link");
    expect(await readFile(victimPath, "utf8")).toBe("/keep-victim\n");
  });

  it("persists drafts, revisions, delivery cursors, and final status", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-store-"));
    const artifactPath = join(root, "review.html");
    const initial = "<h1>First revision</h1>";
    await writeFile(artifactPath, initial);
    const store = new SessionStore(root);
    await store.initialize();
    const stateIgnore = await readFile(join(root, ".agent-html-render", ".gitignore"), "utf8");
    expect(stateIgnore).toContain("/daemon.json");
    expect(stateIgnore).toContain("/sessions/");
    expect(stateIgnore).toContain("/demo-plan.html");
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(initial),
    });
    const lifecycle: string[] = [];
    store.onReview(session.id, (event) => lifecycle.push(event.type));

    const secondHash = contentHash("<h1>Second revision</h1>");
    await store.bumpRevision(session.id, secondHash);
    await store.updateDraft(session.id, { message: "Keep it concise.", annotations: [] }, 2, secondHash);
    const delivery = await store.sendFeedback(
      session.id,
      store.get(session.id)?.draft ?? { message: "", annotations: [] },
      true,
      2,
      secondHash,
      "lifecycle-final",
    );

    expect(delivery.sequence).toBe(1);
    expect(delivery.status).toBe("ended");
    expect(delivery.revision).toBe(2);
    expect(store.getPublicState(session.id)?.latestFeedback).toEqual({
      sequence: 1,
      submissionId: "lifecycle-final",
      status: "ended",
      sentAt: delivery.sentAt,
      revision: 2,
    });
    expect(lifecycle).toContain("feedback-submitted");
    expect(store.nextUndelivered(session.id, 0)?.sequence).toBe(1);
    await acknowledgeFeedbackSequence(store, session.id, 1, "lifecycle-consumer");
    expect(store.nextUndelivered(session.id, 0)).toBeUndefined();
    expect(store.getPublicState(session.id)?.deliveredFeedbackSequence).toBe(1);
    expect(lifecycle).toContain("feedback-delivered");

    const restored = new SessionStore(root);
    await restored.initialize();
    expect(restored.get(session.id)?.status).toBe("ended");
    expect(restored.get(session.id)?.deliveredFeedbackSequence).toBe(1);
  });

  it("rejects a state snapshot that would exceed the reader limit without changing disk or memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-write-limit-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const seed = new SessionStore(root);
    await seed.initialize();
    const session = await seed.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    const sessionPath = join(seed.sessionsDirectory, `${session.id}.json`);
    const baseline = await readFile(sessionPath, "utf8");
    const bounded = new SessionStore(root, {
      maxSessionStateBytes: Buffer.byteLength(baseline, "utf8") + 64,
    });
    await bounded.initialize();

    await expect(
      bounded.updateDraft(
        session.id,
        { message: "x".repeat(1_000), annotations: [] },
        session.revision,
        session.contentHash,
      ),
    ).rejects.toThrow("exceeds the bounded state-file limit");

    expect(await readFile(sessionPath, "utf8")).toBe(baseline);
    expect(bounded.get(session.id)?.draft).toEqual({
      message: "",
      requeuedMessageSequences: [],
      annotations: [],
    });
  });

  it("surfaces an oversized persisted session instead of silently omitting it on restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-read-limit-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    const sessionPath = join(store.sessionsDirectory, `${session.id}.json`);
    const persistedBytes = (await stat(sessionPath)).size;

    await expect(
      new SessionStore(root, { maxSessionStateBytes: persistedBytes - 1 }).initialize(),
    ).rejects.toThrow("exceeds the bounded state-file limit");
  });

  it("fails before restore when the session file-count budget is exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-count-limit-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    const sessionPath = join(store.sessionsDirectory, `${session.id}.json`);
    await copyFile(sessionPath, join(store.sessionsDirectory, "ordinary-copy-a.json"));
    await copyFile(sessionPath, join(store.sessionsDirectory, "ordinary-copy-b.json"));

    await expect(new SessionStore(root, { maxSessionRestoreFiles: 2 }).initialize())
      .rejects.toThrow("3 session files and exceeds the bounded restore limit of 2");
  });

  it("fails before parsing when aggregate session restore bytes exceed the budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-aggregate-limit-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    const sessionPath = join(store.sessionsDirectory, `${session.id}.json`);
    const sessionBytes = (await stat(sessionPath)).size;
    await copyFile(sessionPath, join(store.sessionsDirectory, "ordinary-copy.json"));

    await expect(new SessionStore(root, { maxSessionRestoreBytes: sessionBytes * 2 - 1 }).initialize())
      .rejects.toThrow("exceeds the aggregate restore limit");
  });

  it("serializes concurrent creates so accepted state stays within the restart file budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-live-count-limit-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const options = { maxSessionRestoreFiles: 1 };
    const store = new SessionStore(root, options);
    await store.initialize();
    const create = () => store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });

    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("restart-safe limit of 1") }),
    });
    expect(store.list()).toHaveLength(1);
    expect((await readdir(store.sessionsDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);

    const restarted = new SessionStore(root, options);
    await restarted.initialize();
    expect(restarted.list()).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "admits a recovery transfer as one quota-checked batch without a partial replacement",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-recovery-quota-"));
      const nestedPath = join(root, "nested");
      const originalPath = join(root, "nested-original");
      const artifactPath = join(nestedPath, "review.html");
      const initial = "<p>Original</p>";
      await mkdir(nestedPath);
      await writeFile(artifactPath, initial);
      const options = { maxSessionRestoreFiles: 1 };
      const store = new SessionStore(root, options);
      await store.initialize();
      const source = await store.create({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "nested/review.html",
        contentHash: contentHash(initial),
      });
      await store.updateDraft(
        source.id,
        { message: "Preserve this draft.", annotations: [] },
        source.revision,
        source.contentHash,
      );
      await rename(nestedPath, originalPath);
      await mkdir(nestedPath);
      const replacement = "<p>Replacement</p>";
      await writeFile(artifactPath, replacement);

      await expect(store.createRecoverySession({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "nested/review.html",
        contentHash: contentHash(replacement),
      }, source.id)).rejects.toThrow("create 2 session files");
      expect(store.list()).toHaveLength(1);
      expect(store.get(source.id)).toMatchObject({
        status: "open",
        draft: { message: "Preserve this draft." },
      });
      expect((await readdir(store.sessionsDirectory)).filter((name) => name.endsWith(".json")))
        .toEqual([`${source.id}.json`]);

      const restarted = new SessionStore(root, options);
      await restarted.initialize();
      expect(restarted.list()).toHaveLength(1);
      expect(restarted.get(source.id)?.draft.message).toBe("Preserve this draft.");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a recovery transfer when an intermediate durable state would exceed restart bytes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-html-render-recovery-prefix-quota-"));
      const nestedPath = join(root, "nested");
      const originalPath = join(root, "nested-original");
      const artifactPath = join(nestedPath, "review.html");
      const initial = "<p>Original</p>";
      await mkdir(nestedPath);
      await writeFile(artifactPath, initial);
      const seed = new SessionStore(root);
      await seed.initialize();
      const source = await seed.create({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "nested/review.html",
        contentHash: contentHash(initial),
      });
      await seed.updateDraft(
        source.id,
        { message: "x".repeat(8_000), annotations: [] },
        source.revision,
        source.contentHash,
      );
      const sourcePath = join(seed.sessionsDirectory, `${source.id}.json`);
      const sourceBytes = (await stat(sourcePath)).size;
      const options = { maxSessionRestoreBytes: sourceBytes + 5_000 };
      const bounded = new SessionStore(root, options);
      await bounded.initialize();
      await rename(nestedPath, originalPath);
      await mkdir(nestedPath);
      const replacement = "<p>Replacement</p>";
      await writeFile(artifactPath, replacement);

      await expect(bounded.createRecoverySession({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "nested/review.html",
        contentHash: contentHash(replacement),
      }, source.id)).rejects.toThrow("at a durable commit step");
      expect((await readdir(bounded.sessionsDirectory)).filter((name) => name.endsWith(".json")))
        .toEqual([`${source.id}.json`]);
      expect(bounded.get(source.id)).toMatchObject({
        status: "open",
        draft: { message: "x".repeat(8_000) },
      });

      const restarted = new SessionStore(root, options);
      await restarted.initialize();
      expect(restarted.get(source.id)?.draft.message).toBe("x".repeat(8_000));

      const unbounded = new SessionStore(root);
      await unbounded.initialize();
      await unbounded.createRecoverySession({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "nested/review.html",
        contentHash: contentHash(replacement),
      }, source.id);
      const finalBytes = (await Promise.all(
        (await readdir(unbounded.sessionsDirectory))
          .filter((name) => name.endsWith(".json"))
          .map((name) => stat(join(unbounded.sessionsDirectory, name))),
      )).reduce((total, details) => total + details.size, 0);
      expect(finalBytes).toBeLessThanOrEqual(options.maxSessionRestoreBytes);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a recovery prefix restartable when the second durable write fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-html-render-recovery-second-write-"));
      const nestedPath = join(root, "nested");
      const originalPath = join(root, "nested-original");
      const artifactPath = join(nestedPath, "review.html");
      const initial = "<p>Original</p>";
      await mkdir(nestedPath);
      await writeFile(artifactPath, initial);
      const seed = new SessionStore(root);
      await seed.initialize();
      const source = await seed.create({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "nested/review.html",
        contentHash: contentHash(initial),
      });
      await seed.updateDraft(
        source.id,
        { message: "x".repeat(8_000), annotations: [] },
        source.revision,
        source.contentHash,
      );
      const sourcePath = join(seed.sessionsDirectory, `${source.id}.json`);
      const sourceBytes = (await stat(sourcePath)).size;
      const options = { maxSessionRestoreBytes: sourceBytes * 2 + 1_024 };
      const bounded = new SessionStore(root, options);
      await bounded.initialize();
      const blockingLink = join(root, "recovery-source-hard-link.json");
      await link(sourcePath, blockingLink);
      await rename(nestedPath, originalPath);
      await mkdir(nestedPath);
      const replacement = "<p>Replacement</p>";
      await writeFile(artifactPath, replacement);

      await expect(bounded.createRecoverySession({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "nested/review.html",
        contentHash: contentHash(replacement),
      }, source.id)).rejects.toThrow("one filesystem link");
      const durableEntries = (await readdir(bounded.sessionsDirectory))
        .filter((name) => name.endsWith(".json"));
      expect(durableEntries).toHaveLength(2);
      const durableBytes = (await Promise.all(
        durableEntries.map((name) => stat(join(bounded.sessionsDirectory, name))),
      )).reduce((total, details) => total + details.size, 0);
      expect(durableBytes).toBeLessThanOrEqual(options.maxSessionRestoreBytes);

      await unlink(blockingLink);
      const restarted = new SessionStore(root, options);
      await restarted.initialize();
      const recovered = restarted.list().find((session) => session.recoveredFromSessionId === source.id);
      expect(recovered?.draft.message).toBe("x".repeat(8_000));
      expect(restarted.get(source.id)).toMatchObject({
        status: "superseded",
        supersededBySessionId: recovered?.id,
        draft: { message: "" },
      });
    },
  );

  it.skipIf(process.platform === "win32").each([
    { label: "file-count", limits: { maxSessionRestoreFiles: 1 } },
    { label: "aggregate-byte", limits: { maxSessionRestoreBytes: 2_000 } },
  ])(
    "retires after a post-commit $label boundary failure instead of admitting a retry",
    async ({ limits }) => {
      const root = await mkdtemp(join(tmpdir(), "agent-html-render-post-commit-boundary-"));
      const artifactPath = join(root, "review.html");
      const stateDirectory = join(root, ".agent-html-render");
      const parkedStateDirectory = join(root, "parked-agent-html-render-state");
      const html = "<p>Review</p>";
      await writeFile(artifactPath, html);
      let swapped = false;
      const store = new SessionStore(root, {
        ...limits,
        synchronizeDirectory: async () => {
          if (swapped) return;
          swapped = true;
          await rename(stateDirectory, parkedStateDirectory);
          await mkdir(stateDirectory);
          throw new Error("injected post-rename state replacement");
        },
      });
      await store.initialize();

      await expect(store.create({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "review.html",
        contentHash: contentHash(html),
      })).rejects.toBeInstanceOf(SessionStoreProcessTerminationRequiredError);
      await rm(stateDirectory, { recursive: true, force: true });
      await rename(parkedStateDirectory, stateDirectory);
      expect((await readdir(store.sessionsDirectory)).filter((name) => name.endsWith(".json")))
        .toHaveLength(1);

      await expect(store.create({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "review.html",
        contentHash: contentHash(html),
      })).rejects.toBeInstanceOf(SessionStoreProcessTerminationRequiredError);
      expect((await readdir(store.sessionsDirectory)).filter((name) => name.endsWith(".json")))
        .toHaveLength(1);

      const restarted = new SessionStore(root, limits);
      await restarted.initialize();
      expect(restarted.list()).toHaveLength(1);
    },
  );

  it("rejects a live write before it can exceed the aggregate restart budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-live-byte-limit-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const options = { maxSessionRestoreBytes: 1 };
    const store = new SessionStore(root, options);
    await store.initialize();

    await expect(store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    })).rejects.toThrow("restart-safe aggregate limit of 1 byte");
    expect(store.list()).toEqual([]);
    expect((await readdir(store.sessionsDirectory)).filter((name) => name.endsWith(".json"))).toEqual([]);

    const restarted = new SessionStore(root, options);
    await restarted.initialize();
    expect(restarted.list()).toEqual([]);
  });

  it("keeps the previous durable snapshot when an update would cross the aggregate restart budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-live-update-limit-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const seed = new SessionStore(root);
    await seed.initialize();
    const session = await seed.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    const sessionPath = join(seed.sessionsDirectory, `${session.id}.json`);
    const baseline = await readFile(sessionPath, "utf8");
    const options = { maxSessionRestoreBytes: Buffer.byteLength(baseline, "utf8") + 64 };
    const bounded = new SessionStore(root, options);
    await bounded.initialize();

    await expect(bounded.updateDraft(
      session.id,
      { message: "x".repeat(1_000), annotations: [] },
      session.revision,
      session.contentHash,
    )).rejects.toThrow("restart-safe aggregate limit");
    expect(await readFile(sessionPath, "utf8")).toBe(baseline);
    expect(bounded.get(session.id)?.draft.message).toBe("");

    const restarted = new SessionStore(root, options);
    await restarted.initialize();
    expect(restarted.get(session.id)?.draft.message).toBe("");
  });

  it.skipIf(process.platform !== "linux")(
    "restores hundreds of ordinary session files below a low descriptor limit",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-low-fd-"));
      const artifactPath = join(root, "review.html");
      const html = "<p>Review</p>";
      await writeFile(artifactPath, html);
      const store = new SessionStore(root);
      await store.initialize();
      const session = await store.create({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "review.html",
        contentHash: contentHash(html),
      });
      const sessionPath = join(store.sessionsDirectory, `${session.id}.json`);
      for (let index = 0; index < 200; index += 1) {
        await copyFile(
          sessionPath,
          join(store.sessionsDirectory, `ordinary-copy-${index.toString().padStart(3, "0")}.json`),
        );
      }

      const output = execFileSync(
        "bash",
        [
          "-c",
          'ulimit -n 64; exec "$0" --import tsx "$1" "$2"',
          process.execPath,
          resolve("tests/fixtures/restore-session-store.ts"),
          root,
        ],
        { cwd: resolve("."), encoding: "utf8", timeout: 15_000 },
      );
      expect(JSON.parse(output)).toEqual({ restoredSessions: 1 });
    },
  );

  it("refuses to resume a legacy session that has no pinned filesystem identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-legacy-session-"));
    const artifactPath = join(root, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: contentHash(html),
    });
    await store.sendFeedback(
      session.id,
      { message: "Legacy reviewer note.", annotations: [] },
      false,
      1,
      contentHash(html),
      "new-field-to-remove",
    );

    const statePath = join(root, ".agent-html-render", "sessions", `${session.id}.json`);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      rootDevice?: string;
      rootInode?: string;
      parentDevice?: string;
      parentInode?: string;
      draft: { requeuedMessageSequences?: number[] };
      feedbackEvents: Array<{
        submissionId?: string;
        feedback: { requeuedMessageSequences?: number[] };
      }>;
      feedbackMessageDecisions?: Record<string, string>;
    };
    delete persisted.rootDevice;
    delete persisted.rootInode;
    delete persisted.parentDevice;
    delete persisted.parentInode;
    delete persisted.draft.requeuedMessageSequences;
    delete persisted.feedbackMessageDecisions;
    for (const event of persisted.feedbackEvents) {
      delete event.submissionId;
      delete event.feedback.requeuedMessageSequences;
    }
    await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const restored = new SessionStore(root);
    await restored.initialize();
    expect(restored.get(session.id)).toBeUndefined();
  });

  it("restores a session with its pinned identity after the artifact parent is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-parent-session-"));
    const plans = join(root, "plans");
    const parked = join(root, "plans-original");
    const replacement = join(root, "replacement");
    await mkdir(plans);
    await mkdir(replacement);
    const artifactPath = join(plans, "review.html");
    await writeFile(artifactPath, "<p>Original</p>");
    await writeFile(join(replacement, "review.html"), "<p>Replacement</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "plans/review.html",
      contentHash: contentHash("<p>Original</p>"),
    });

    await rename(plans, parked);
    await rename(replacement, plans);

    const restored = new SessionStore(root);
    await restored.initialize();
    expect(restored.get(session.id)).toMatchObject({
      id: session.id,
      parentDevice: session.parentDevice,
      parentInode: session.parentInode,
      artifactPath,
    });
  });

  it("reconciles a crash after a recovered session commit into one durable draft transfer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-recovery-reconcile-"));
    const parent = join(root, "plans");
    const parked = join(root, "plans-original");
    await mkdir(parent);
    const artifactPath = join(parent, "review.html");
    const html = "<p>Review</p>";
    await writeFile(artifactPath, html);
    const store = new SessionStore(root);
    await store.initialize();
    const source = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "plans/review.html",
      contentHash: contentHash(html),
    });
    await store.updateDraft(
      source.id,
      { message: "Transfer this note once.", annotations: [] },
      source.revision,
      source.contentHash,
    );
    const sourceWithDraft = store.get(source.id);
    if (!sourceWithDraft) throw new Error("recovery source fixture is missing");
    await rename(parent, parked);
    await mkdir(parent);
    await writeFile(artifactPath, html);

    const replacement = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "plans/review.html",
      contentHash: contentHash(html),
      recoveredDraft: {
        draft: sourceWithDraft.draft,
        baseRevision: sourceWithDraft.draftBaseRevision,
        baseContentHash: sourceWithDraft.draftBaseContentHash,
        sourceSessionId: source.id,
      },
    });
    expect(store.get(source.id)?.status).toBe("open");

    const restored = new SessionStore(root);
    await restored.initialize();

    expect(restored.get(source.id)).toMatchObject({
      status: "superseded",
      supersededBySessionId: replacement.id,
      draft: { message: "", annotations: [] },
    });
    expect(restored.get(replacement.id)).toMatchObject({
      recoveredFromSessionId: source.id,
      draft: { message: "Transfer this note once." },
      draftRecoveryRequired: true,
    });
  });

  it("preserves custom state ignore rules while adding private runtime paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-state-ignore-"));
    const stateDirectory = join(root, ".agent-html-render");
    await writeFile(join(root, "review.html"), "<p>Review</p>");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, ".gitignore"), "/custom-private-file\n");

    const store = new SessionStore(root);
    await store.initialize();

    const stateIgnore = await readFile(join(stateDirectory, ".gitignore"), "utf8");
    expect(stateIgnore).toContain("/custom-private-file");
    expect(stateIgnore).toContain("/daemon.json");
    expect(stateIgnore).toContain("/daemon.json.*.tmp");
    expect(stateIgnore).toContain("/sessions/");
  });

  it("keeps runtime secrets out of Git while leaving authored HTML trackable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-git-ignore-"));
    await writeFile(join(root, "review.html"), "<p>Review</p>");
    execFileSync("git", ["init", "--quiet", root]);
    const store = new SessionStore(root);
    await store.initialize();
    await writeFile(join(store.stateDirectory, "daemon.json"), '{"token":"private"}\n');
    await writeFile(join(store.stateDirectory, "decision.html"), "<p>Track me</p>");
    await store.create({
      rootPath: root,
      artifactPath: join(root, "review.html"),
      artifactRelativePath: "review.html",
      contentHash: contentHash("<p>Review</p>"),
    });

    const status = execFileSync("git", ["-C", root, "status", "--short", "--untracked-files=all"], {
      encoding: "utf8",
    });
    expect(status).toContain(".agent-html-render/decision.html");
    expect(status).not.toContain("daemon.json");
    expect(status).not.toContain("sessions/");
    expect(status).not.toContain(".agent-html-render/.gitignore");
  });

  it("ignores a persisted session whose artifact boundary was tampered with", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-store-boundary-"));
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
    const statePath = join(root, ".agent-html-render", "sessions", `${session.id}.json`);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { rootPath: string };
    persisted.rootPath = "/tmp/not-the-project";
    await writeFile(statePath, `${JSON.stringify(persisted)}\n`);

    const restored = new SessionStore(root);
    await restored.initialize();
    expect(restored.get(session.id)).toBeUndefined();
  });

  it("rejects feedback from a stale revision without discarding the draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-stale-draft-"));
    const artifactPath = join(root, "review.html");
    const firstHash = contentHash("<p>First</p>");
    const secondHash = contentHash("<p>Second</p>");
    await writeFile(artifactPath, "<p>First</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: firstHash,
    });
    const draft = { message: "Keep this note.", annotations: [] };
    await store.updateDraft(session.id, draft, 1, firstHash);
    await store.bumpRevision(session.id, secondHash);

    await expect(store.sendFeedback(session.id, draft, false, 1, firstHash, "stale-send")).rejects.toBeInstanceOf(
      RevisionConflictError,
    );
    expect(store.getPublicState(session.id)).toMatchObject({
      revision: 2,
      draft,
      draftBaseRevision: 1,
      draftBaseContentHash: firstHash,
    });
  });

  it("replays one immutable submission without duplicating feedback, including after restart and end", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-idempotent-send-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: hash,
    });
    const draft = { message: "Ready to implement.", annotations: [] };
    let submittedEvents = 0;
    store.onReview(session.id, (event) => {
      if (event.type === "feedback-submitted") submittedEvents += 1;
    });

    const first = await store.sendFeedback(session.id, draft, true, 1, hash, "final-submission");
    const replay = await store.sendFeedback(session.id, draft, true, 1, hash, "final-submission");

    expect(replay).toEqual(first);
    expect(store.get(session.id)?.feedbackEvents).toHaveLength(1);
    expect(submittedEvents).toBe(1);
    await expect(
      store.sendFeedback(
        session.id,
        { message: "Different content.", annotations: [] },
        true,
        1,
        hash,
        "final-submission",
      ),
    ).rejects.toBeInstanceOf(SubmissionConflictError);

    const restored = new SessionStore(root);
    await restored.initialize();
    await expect(
      restored.sendFeedback(session.id, draft, true, 1, hash, "final-submission"),
    ).resolves.toEqual(first);
    expect(restored.get(session.id)?.feedbackEvents).toHaveLength(1);
  });

  it("tracks, requeues, and resolves whole-artifact reviewer messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-message-review-"));
    const artifactPath = join(root, "review.html");
    const firstHash = contentHash("<p>First</p>");
    const secondHash = contentHash("<p>Second</p>");
    await writeFile(artifactPath, "<p>First</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: firstHash,
    });
    await store.sendFeedback(
      session.id,
      { message: "Keep the entire rollout reversible.\n\nShow the rollback trigger.", annotations: [] },
      false,
      1,
      firstHash,
      "general-first",
    );
    await store.bumpRevision(session.id, secondHash);
    await store.updateDraft(session.id, { message: "Independent note.", annotations: [] }, 2, secondHash);

    const needsWork = await store.reviewFeedbackMessage(session.id, 1, "needs-work", true);
    expect(needsWork.feedbackHistory[0]).toMatchObject({
      reviewerMessageDecision: "needs-work",
      requeuedMessageSequences: [],
    });
    expect(needsWork.draft).toMatchObject({
      message: "Independent note.\n\nKeep the entire rollout reversible.\n\nShow the rollback trigger.",
      requeuedMessageSequences: [1],
    });

    const needsWorkAgain = await store.reviewFeedbackMessage(session.id, 1, "needs-work", true);
    expect(needsWorkAgain.draft.requeuedMessageSequences).toEqual([1]);
    const resolved = await store.reviewFeedbackMessage(session.id, 1, "resolved", false);
    expect(resolved.feedbackHistory[0]?.reviewerMessageDecision).toBe("resolved");
    expect(resolved.draft).toMatchObject({ message: "Independent note.", requeuedMessageSequences: [] });
  });

  it("rejects a whole-note requeue that would exceed the draft message bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-message-bound-"));
    const artifactPath = join(root, "review.html");
    const firstHash = contentHash("<p>First</p>");
    const secondHash = contentHash("<p>Second</p>");
    await writeFile(artifactPath, "<p>First</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: firstHash,
    });
    await store.sendFeedback(
      session.id,
      { message: "x".repeat(7_999), annotations: [] },
      false,
      1,
      firstHash,
      "general-at-bound",
    );
    await store.bumpRevision(session.id, secondHash);
    await store.updateDraft(session.id, { message: "Keep me.", annotations: [] }, 2, secondHash);

    await expect(store.reviewFeedbackMessage(session.id, 1, "needs-work", true)).rejects.toThrow(
      "8,000 character limit",
    );
    expect(store.getPublicState(session.id)?.draft).toMatchObject({
      message: "Keep me.",
      requeuedMessageSequences: [],
    });
    expect(store.getPublicState(session.id)?.feedbackHistory[0]?.reviewerMessageDecision).toBe("pending");
  });

  it("does not partially remove manually edited requeued prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-message-edit-"));
    const artifactPath = join(root, "review.html");
    const firstHash = contentHash("<p>First</p>");
    const secondHash = contentHash("<p>Second</p>");
    await writeFile(artifactPath, "<p>First</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: firstHash,
    });
    await store.sendFeedback(
      session.id,
      { message: "Keep X", annotations: [] },
      false,
      1,
      firstHash,
      "general-to-edit",
    );
    await store.bumpRevision(session.id, secondHash);
    await store.reviewFeedbackMessage(session.id, 1, "needs-work", true);
    await store.updateDraft(
      session.id,
      { message: "Keep X, but add Y.", requeuedMessageSequences: [1], annotations: [] },
      2,
      secondHash,
    );

    const resolved = await store.reviewFeedbackMessage(session.id, 1, "resolved", false);
    expect(resolved.draft).toMatchObject({
      message: "Keep X, but add Y.",
      requeuedMessageSequences: [],
    });
  });

  it("never evicts pending feedback and prunes acknowledged history only when making room", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-retention-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: hash,
    });

    for (let index = 0; index < MAX_FEEDBACK_EVENTS; index += 1) {
      await store.sendFeedback(
        session.id,
        { message: `Feedback ${index + 1}`, annotations: [] },
        false,
        1,
        hash,
        `retention-${index + 1}`,
      );
    }
    await expect(
      store.sendFeedback(session.id, { message: "One too many", annotations: [] }, false, 1, hash, "retention-overflow"),
    ).rejects.toThrow("waiting for the agent");
    expect(store.get(session.id)?.feedbackEvents).toHaveLength(MAX_FEEDBACK_EVENTS);

    await acknowledgeFeedbackSequence(store, session.id, 1, "retention-consumer");
    const next = await store.sendFeedback(
      session.id,
      { message: "After acknowledgement", annotations: [] },
      false,
      1,
      hash,
      "retention-after-ack",
    );
    expect(next.sequence).toBe(MAX_FEEDBACK_EVENTS + 1);
    expect(store.get(session.id)?.feedbackEvents.map((event) => event.sequence)).toEqual(
      Array.from({ length: MAX_FEEDBACK_EVENTS }, (_, index) => index + 2),
    );
    await expect(
      store.sendFeedback(
        session.id,
        { message: "Feedback 1", annotations: [] },
        false,
        1,
        hash,
        "retention-1",
      ),
    ).resolves.toMatchObject({ sequence: 1, submissionId: "retention-1" });
    await expect(
      store.sendFeedback(
        session.id,
        { message: "Changed replay", annotations: [] },
        false,
        1,
        hash,
        "retention-1",
      ),
    ).rejects.toBeInstanceOf(SubmissionConflictError);
    const restored = new SessionStore(root);
    await restored.initialize();
    await expect(
      restored.sendFeedback(
        session.id,
        { message: "Feedback 1", annotations: [] },
        false,
        1,
        hash,
        "retention-1",
      ),
    ).resolves.toMatchObject({ sequence: 1, submissionId: "retention-1" });
  });

  it("tracks review decisions and requeues unresolved change requests once", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-change-review-"));
    const artifactPath = join(root, "review.html");
    const firstHash = contentHash("<h2 id=phase>Private beta</h2>");
    const secondHash = contentHash("<h2 id=phase>Public beta</h2>");
    await writeFile(artifactPath, "<h2 id=phase>Private beta</h2>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: firstHash,
    });
    const annotation = {
      id: "phase-note",
      comment: "Remove the private beta phase.",
      createdAt: "2026-08-30T00:00:00.000Z",
      target: {
        kind: "element" as const,
        tag: "h2",
        stableId: "phase",
        stableAttribute: "id" as const,
        cssPath: "#phase",
        domPath: [0],
        text: "Private beta",
        headingPath: ["Private beta"],
      },
    };
    await store.sendFeedback(
      session.id,
      { message: "", annotations: [annotation] },
      false,
      1,
      firstHash,
      "annotation-first",
    );
    await acknowledgeFeedbackSequence(store, session.id, 1, "annotation-review-consumer");
    await store.bumpRevision(session.id, secondHash);

    const reviewed = await store.reviewFeedback(session.id, 1, annotation.id, "needs-work", true);
    expect(reviewed.feedbackHistory[0]?.annotations[0]?.decision).toBe("needs-work");
    expect(reviewed.draft.annotations[0]).toMatchObject({
      comment: annotation.comment,
      requeuedFrom: { sequence: 1, annotationId: annotation.id },
    });

    const reviewedAgain = await store.reviewFeedback(session.id, 1, annotation.id, "needs-work", true);
    expect(reviewedAgain.draft.annotations).toHaveLength(1);
    const resolved = await store.reviewFeedback(session.id, 1, annotation.id, "resolved", false);
    expect(resolved.feedbackHistory[0]?.annotations[0]?.decision).toBe("resolved");
    expect(resolved.draft.annotations).toEqual([]);
  });

  it("keeps a manually edited requeued annotation independent from its source decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-annotation-edit-"));
    const artifactPath = join(root, "review.html");
    const firstHash = contentHash("<p>First</p>");
    const secondHash = contentHash("<p>Second</p>");
    await writeFile(artifactPath, "<p>First</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({ rootPath: root, artifactPath, artifactRelativePath: "review.html", contentHash: firstHash });
    const annotation = {
      id: "source",
      comment: "Original request",
      createdAt: "2026-08-30T00:00:00.000Z",
      target: { kind: "element" as const, tag: "p", cssPath: "p", domPath: [0], text: "First", headingPath: [] },
    };
    await store.sendFeedback(session.id, { message: "", annotations: [annotation] }, false, 1, firstHash, "source-send");
    await store.bumpRevision(session.id, secondHash);
    const requeued = await store.reviewFeedback(session.id, 1, annotation.id, "needs-work", true);
    const edited = structuredClone(requeued.draft);
    edited.annotations[0]!.comment = "Reviewer-authored revision";
    await store.updateDraft(session.id, edited, 2, secondHash);

    const resolved = await store.reviewFeedback(session.id, 1, annotation.id, "resolved", false);
    expect(resolved.draft.annotations).toHaveLength(1);
    expect(resolved.draft.annotations[0]?.comment).toBe("Reviewer-authored revision");
  });

  it("rejects oversized derived markdown without changing or orphaning the persisted draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-markdown-bound-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({ rootPath: root, artifactPath, artifactRelativePath: "review.html", contentHash: hash });
    const draft = parseReviewDraft({
      message: "",
      annotations: Array.from({ length: 100 }, (_, index) => ({
        id: `large-${index}`,
        comment: "c\n".repeat(1_999),
        createdAt: "2026-08-30T00:00:00.000Z",
        target: {
          kind: "element",
          tag: "p",
          cssPath: `#${"x".repeat(1_998)}`,
          domPath: [index],
          text: "t\n".repeat(300),
          headingPath: Array.from({ length: 6 }, () => "h".repeat(160)),
        },
      })),
    });
    await store.updateDraft(session.id, draft, 1, hash);

    await expect(store.sendFeedback(session.id, draft, false, 1, hash, "oversized-markdown")).rejects.toThrow(
      "delivery limit",
    );
    expect(store.getPublicState(session.id)?.draft).toEqual(draft);
    expect(store.get(session.id)?.feedbackEvents).toEqual([]);
    const restored = new SessionStore(root);
    await restored.initialize();
    expect(restored.getPublicState(session.id)?.draft).toEqual(draft);
  });

  it("publishes state only after persistence and isolates throwing notification listeners", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-persist-failure-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({ rootPath: root, artifactPath, artifactRelativePath: "review.html", contentHash: hash });
    const draft = { message: "Keep this draft.", annotations: [] };
    await store.updateDraft(session.id, draft, 1, hash);
    const sessionsDirectory = join(root, ".agent-html-render", "sessions");
    const savedDirectory = `${sessionsDirectory}-saved`;
    await rename(sessionsDirectory, savedDirectory);
    await writeFile(sessionsDirectory, "blocked");

    await expect(store.sendFeedback(session.id, draft, false, 1, hash, "persist-fails")).rejects.toThrow();
    expect(store.getPublicState(session.id)?.draft).toEqual({ ...draft, requeuedMessageSequences: [] });
    expect(store.get(session.id)?.feedbackEvents).toEqual([]);
    await unlink(sessionsDirectory);
    await rename(savedDirectory, sessionsDirectory);

    store.onReview(session.id, () => {
      throw new Error("disconnected listener");
    });
    await expect(store.sendFeedback(session.id, draft, false, 1, hash, "persist-fails")).resolves.toMatchObject({
      sequence: 1,
      submissionId: "persist-fails",
    });
    expect(store.get(session.id)?.feedbackEvents).toHaveLength(1);
    const restored = new SessionStore(root);
    await restored.initialize();
    expect(restored.get(session.id)?.feedbackEvents).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("treats rename as the commit point when directory sync fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-post-rename-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root, {
      synchronizeDirectory: async () => {
        throw new Error("injected directory sync failure");
      },
    });
    await store.initialize();
    const session = await store.create({ rootPath: root, artifactPath, artifactRelativePath: "review.html", contentHash: hash });
    const draft = { message: "Commit exactly once", annotations: [] };
    await store.updateDraft(session.id, draft, 1, hash);

    await expect(
      store.sendFeedback(session.id, draft, false, 1, hash, "post-rename"),
    ).resolves.toMatchObject({ sequence: 1, submissionId: "post-rename" });
    expect(store.get(session.id)?.feedbackEvents).toHaveLength(1);
    expect(store.getPublicState(session.id)?.draft.message).toBe("");

    const restored = new SessionStore(root);
    await restored.initialize();
    expect(restored.get(session.id)?.feedbackEvents).toHaveLength(1);
    expect(restored.replayFeedback(session.id, draft, false, 1, hash, "post-rename")?.sequence).toBe(1);
  });

  it("requires exact lease credentials before the store can durably acknowledge feedback", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-feedback-exact-store-ack-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: hash,
    });
    await store.sendFeedback(
      session.id,
      { message: "Keep this pending without an exact grant.", annotations: [] },
      false,
      1,
      hash,
      "exact-store-ack",
    );

    const sessionPath = join(store.sessionsDirectory, `${session.id}.json`);
    const snapshotBeforeInvalidCalls = await readFile(sessionPath, "utf8");
    for (const invalidCursor of [undefined, null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        Reflect.apply(store.leaseNextUndelivered, store, [session.id, invalidCursor, "cursor-verifier"]),
      ).toThrow("requires a non-negative integer cursor");
    }
    for (const invalidTimestamp of [
      null,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER - FEEDBACK_LEASE_MILLISECONDS + 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() =>
        Reflect.apply(store.leaseNextUndelivered, store, [session.id, 0, "timestamp-verifier", invalidTimestamp]),
      ).toThrow("do not accept caller-supplied timestamps or extra arguments");
    }
    for (const invalidStoreClock of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER - FEEDBACK_LEASE_MILLISECONDS + 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      await expect(withMockedNow(invalidStoreClock, () =>
        store.leaseNextUndelivered(session.id, 0, "timestamp-verifier")))
        .rejects.toThrow("requires a non-negative integer lease timestamp");
    }
    const invalidConsumers: unknown[] = [undefined, null, 0, {}, "", ".leading", "a".repeat(121)];
    for (const [index, invalidConsumer] of invalidConsumers.entries()) {
      expect(() =>
        Reflect.apply(store.leaseNextUndelivered, store, [session.id, 0, invalidConsumer]),
      ).toThrow("requires a valid consumer ID");
      const verifierConsumer = `invalid-lease-verifier-${index}`;
      const verifierLease = store.leaseNextUndelivered(session.id, 0, verifierConsumer);
      if (!verifierLease.delivery) throw new Error("An invalid consumer reserved the pending feedback batch.");
      await expect(
        store.releaseFeedbackLease(session.id, 1, verifierConsumer, verifierLease.leaseId),
      ).resolves.toBe(true);
    }

    await expect(Reflect.apply(store.markDelivered, store, [session.id, 1]))
      .rejects.toThrow("requires a valid consumer ID");
    await expect(Reflect.apply(store.markDelivered, store, [session.id, 1, "partial-consumer"]))
      .rejects.toThrow("requires an exact 32-character base64url lease ID");
    expect(store.get(session.id)?.deliveredFeedbackSequence).toBe(0);
    expect(store.nextUndelivered(session.id, 0)?.sequence).toBe(1);
    expect(await readFile(sessionPath, "utf8")).toBe(snapshotBeforeInvalidCalls);

    const restored = new SessionStore(root);
    await restored.initialize();
    expect(restored.get(session.id)?.deliveredFeedbackSequence).toBe(0);
    expect(restored.get(session.id)?.deliveryAcknowledgements).toEqual([]);
    const leased = restored.leaseNextUndelivered(session.id, 0, "exact-store-consumer");
    if (!leased.delivery) throw new Error("Expected the pending feedback to receive an exact grant.");
    expect(leased.delivery.sequence).toBe(1);
    for (const leaseMutation of [
      restored.releaseFeedbackLease,
      restored.renewFeedbackLease,
      restored.markDelivered,
    ]) {
      await expect(
        Reflect.apply(leaseMutation, restored, [session.id, 0, "exact-store-consumer", leased.leaseId]),
      ).rejects.toThrow("requires a positive integer sequence");
      await expect(
        Reflect.apply(leaseMutation, restored, [session.id, 1, ".invalid", leased.leaseId]),
      ).rejects.toThrow("requires a valid consumer ID");
      await expect(
        Reflect.apply(leaseMutation, restored, [session.id, 1, "exact-store-consumer", "invalid"]),
      ).rejects.toThrow("requires an exact 32-character base64url lease ID");
      const repeated = restored.leaseNextUndelivered(session.id, 0, "exact-store-consumer");
      expect(repeated).toMatchObject({ delivery: { sequence: 1 }, leaseId: leased.leaseId });
    }
    for (const timedLeaseMutation of [
      restored.releaseFeedbackLease,
      restored.renewFeedbackLease,
      restored.markDelivered,
    ]) {
      await expect(
        Reflect.apply(timedLeaseMutation, restored, [
          session.id,
          1,
          "exact-store-consumer",
          leased.leaseId,
          Number.MAX_SAFE_INTEGER,
        ]),
      ).rejects.toThrow("do not accept caller-supplied timestamps or extra arguments");
      for (const invalidStoreClock of [Number.NaN, Number.MAX_SAFE_INTEGER]) {
        await expect(
          withMockedNow(invalidStoreClock, () =>
            Reflect.apply(timedLeaseMutation, restored, [
              session.id,
              1,
              "exact-store-consumer",
              leased.leaseId,
            ])),
        ).rejects.toThrow("requires a non-negative integer lease timestamp");
      }
    }
    await restored.markDelivered(session.id, 1, "exact-store-consumer", leased.leaseId);

    const committed = new SessionStore(root);
    await committed.initialize();
    expect(committed.get(session.id)?.deliveredFeedbackSequence).toBe(1);
    expect(committed.get(session.id)?.deliveryAcknowledgements).toHaveLength(1);
    expect(committed.nextUndelivered(session.id, 0)).toBeUndefined();
  });

  it("leases each pending feedback batch to one concurrent agent consumer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-feedback-lease-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({ rootPath: root, artifactPath, artifactRelativePath: "review.html", contentHash: hash });
    await store.sendFeedback(session.id, { message: "First", annotations: [] }, false, 1, hash, "leased-send-1");
    await store.sendFeedback(session.id, { message: "Second", annotations: [] }, false, 1, hash, "leased-send-2");

    const now = Date.now();
    const firstLease = await withMockedNow(now, () =>
      store.leaseNextUndelivered(session.id, 0, "consumer-a"));
    if (!firstLease.delivery) throw new Error("Expected the first feedback lease.");
    expect(firstLease.delivery.sequence).toBe(1);
    expect((await withMockedNow(now + 1, () =>
      store.leaseNextUndelivered(session.id, 1, "consumer-b"))).delivery).toBeUndefined();
    expect((await withMockedNow(now + 2, () =>
      store.leaseNextUndelivered(session.id, 0, "consumer-c"))).delivery).toBeUndefined();
    const repeatedLease = await withMockedNow(now + 3, () =>
      store.leaseNextUndelivered(session.id, 0, "consumer-a"));
    expect(repeatedLease).toMatchObject({ delivery: { sequence: 1 }, leaseId: firstLease.leaseId });
    expect(await withMockedNow(now + 3, () =>
      store.releaseFeedbackLease(session.id, 2, "consumer-a", firstLease.leaseId))).toBe(false);
    expect(await withMockedNow(now + 3, () =>
      store.releaseFeedbackLease(session.id, 1, "consumer-b", firstLease.leaseId))).toBe(false);
    await expect(
      Reflect.apply(store.markDelivered, store, [session.id, 1]),
    ).rejects.toThrow("requires a valid consumer ID");
    expect(await withMockedNow(now + 3, () =>
      store.releaseFeedbackLease(session.id, 1, "consumer-a", firstLease.leaseId))).toBe(true);
    const secondConsumerLease = await withMockedNow(now + 4, () =>
      store.leaseNextUndelivered(session.id, 0, "consumer-b"));
    if (!secondConsumerLease.delivery) throw new Error("Expected the released feedback to be leased again.");
    expect(secondConsumerLease.delivery.sequence).toBe(1);
    expect(secondConsumerLease.leaseId).not.toBe(firstLease.leaseId);
    await store.markDelivered(session.id, 1, "consumer-b", secondConsumerLease.leaseId);
    expect((await withMockedNow(now + 4, () =>
      store.leaseNextUndelivered(session.id, 1, "consumer-b"))).delivery?.sequence).toBe(2);
  });

  it("rejects a delayed release after the same consumer renews an expired lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-feedback-lease-renewal-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({ rootPath: root, artifactPath, artifactRelativePath: "review.html", contentHash: hash });
    await store.sendFeedback(session.id, { message: "Renew me", annotations: [] }, false, 1, hash, "renew-send");

    const now = Date.now();
    const original = await withMockedNow(now, () =>
      store.leaseNextUndelivered(session.id, 0, "same-consumer"));
    const renewedAt = now + FEEDBACK_LEASE_MILLISECONDS + 1;
    if (!original.delivery) throw new Error("Expected the original feedback lease grant.");
    expect(await withMockedNow(renewedAt, () =>
      store.renewFeedbackLease(session.id, 1, "same-consumer", original.leaseId))).toBeUndefined();
    const renewed = await withMockedNow(renewedAt, () =>
      store.leaseNextUndelivered(session.id, 0, "same-consumer"));
    if (!renewed.delivery) throw new Error("Expected the renewed feedback lease grant.");
    expect(renewed.leaseId).not.toBe(original.leaseId);
    expect(await withMockedNow(renewedAt, () =>
      store.releaseFeedbackLease(session.id, 1, "same-consumer", original.leaseId))).toBe(false);
    expect((await withMockedNow(renewedAt + 1, () =>
      store.leaseNextUndelivered(session.id, 0, "same-consumer"))).leaseId)
      .toBe(renewed.leaseId);
    await store.markDelivered(session.id, 1, "same-consumer", renewed.leaseId);
    expect(store.get(session.id)?.deliveredFeedbackSequence).toBe(1);
  });

  it("rejects an expired exact-grant acknowledgement before replacement and lets a fresh grant commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-expired-ack-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: hash,
    });
    await store.sendFeedback(
      session.id,
      { message: "Deliver only under a live grant.", annotations: [] },
      false,
      1,
      hash,
      "expired-ack-send",
    );

    const expired = await withMockedNow(Date.now() - FEEDBACK_LEASE_MILLISECONDS - 1, () =>
      store.leaseNextUndelivered(session.id, 0, "expired-consumer"));
    if (!expired.delivery) throw new Error("Expected an already-expired test grant.");
    await expect(
      store.markDelivered(session.id, 1, "expired-consumer", expired.leaseId),
    ).rejects.toThrow("current unexpired delivery lease");
    expect(store.get(session.id)?.deliveredFeedbackSequence).toBe(0);

    const successor = store.leaseNextUndelivered(session.id, 0, "fresh-consumer");
    if (!successor.delivery) throw new Error("Expected a fresh successor grant.");
    expect(successor.delivery.sequence).toBe(1);
    expect(successor.leaseId).not.toBe(expired.leaseId);
    await store.markDelivered(session.id, 1, "fresh-consumer", successor.leaseId);
    expect(store.get(session.id)?.deliveredFeedbackSequence).toBe(1);
    await expect(
      store.markDelivered(session.id, 1, "fresh-consumer", successor.leaseId),
    ).resolves.toBeUndefined();
    await expect(
      store.markDelivered(session.id, 1, "expired-consumer", expired.leaseId),
    ).rejects.toThrow("acknowledged by a different delivery grant");
  });

  it("orders an expired acknowledgement behind a synchronously claimed successor grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-expired-ack-race-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({
      rootPath: root,
      artifactPath,
      artifactRelativePath: "review.html",
      contentHash: hash,
    });
    await store.sendFeedback(
      session.id,
      { message: "Let only the successor win this race.", annotations: [] },
      false,
      1,
      hash,
      "expired-ack-race-send",
    );

    const expired = await withMockedNow(Date.now() - FEEDBACK_LEASE_MILLISECONDS - 1, () =>
      store.leaseNextUndelivered(session.id, 0, "expired-racer"));
    if (!expired.delivery) throw new Error("Expected the expired racing grant.");
    const expiredAcknowledgement = store.markDelivered(
      session.id,
      1,
      "expired-racer",
      expired.leaseId,
    );
    const successor = store.leaseNextUndelivered(session.id, 0, "successor-racer");
    if (!successor.delivery) throw new Error("Expected the synchronous successor grant.");
    expect(successor.delivery.sequence).toBe(1);
    expect(successor.leaseId).not.toBe(expired.leaseId);

    await expect(expiredAcknowledgement).rejects.toThrow("current unexpired delivery lease");
    expect(store.get(session.id)?.deliveredFeedbackSequence).toBe(0);
    await store.markDelivered(session.id, 1, "successor-racer", successor.leaseId);
    expect(store.get(session.id)?.deliveredFeedbackSequence).toBe(1);
  });

  it("renews only the exact live grant and durably rejects a superseded writer acknowledgement", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-feedback-lease-renew-ack-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    const session = await store.create({ rootPath: root, artifactPath, artifactRelativePath: "review.html", contentHash: hash });
    await store.sendFeedback(session.id, { message: "Apply once", annotations: [] }, false, 1, hash, "renew-ack-send");

    const now = Date.now();
    const original = await withMockedNow(now, () =>
      store.leaseNextUndelivered(session.id, 0, "consumer-a"));
    if (!original.delivery) throw new Error("Expected the original delivery grant.");
    const wrongLeaseId = `${original.leaseId.slice(0, -1)}${original.leaseId.endsWith("A") ? "B" : "A"}`;
    expect(await withMockedNow(now + 1, () =>
      store.renewFeedbackLease(session.id, 1, "consumer-a", wrongLeaseId))).toBeUndefined();
    const renewedAt = now + FEEDBACK_LEASE_MILLISECONDS - 1;
    const renewedUntil = await withMockedNow(renewedAt, () =>
      store.renewFeedbackLease(session.id, 1, "consumer-a", original.leaseId));
    expect(renewedUntil).toBe(renewedAt + FEEDBACK_LEASE_MILLISECONDS);
    expect((await withMockedNow(now + FEEDBACK_LEASE_MILLISECONDS + 1, () =>
      store.leaseNextUndelivered(session.id, 0, "consumer-b"))).delivery).toBeUndefined();

    const replacement = await withMockedNow((renewedUntil ?? 0) + 1, () =>
      store.leaseNextUndelivered(session.id, 0, "consumer-b"));
    if (!replacement.delivery) throw new Error("Expected a replacement grant after renewed expiry.");
    expect(replacement.leaseId).not.toBe(original.leaseId);
    await store.markDelivered(session.id, 1, "consumer-b", replacement.leaseId);
    await expect(
      store.markDelivered(session.id, 1, "consumer-a", original.leaseId),
    ).rejects.toThrow("acknowledged by a different delivery grant");
    await expect(
      store.markDelivered(session.id, 1, "consumer-b", replacement.leaseId),
    ).resolves.toBeUndefined();
    expect(store.get(session.id)?.deliveryAcknowledgements).toEqual([
      { sequence: 1, grantDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    ]);
    expect(JSON.stringify(store.get(session.id))).not.toContain(replacement.leaseId);

    const restored = new SessionStore(root);
    await restored.initialize();
    await expect(
      restored.markDelivered(session.id, 1, "consumer-b", replacement.leaseId),
    ).resolves.toBeUndefined();
    await expect(
      restored.markDelivered(session.id, 1, "consumer-a", original.leaseId),
    ).rejects.toThrow("acknowledged by a different delivery grant");
  });

  it("serializes release behind acknowledgement and pins the exact lease while persistence is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-feedback-lease-ack-race-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    let gateSynchronization = false;
    let signalSynchronization = (): void => undefined;
    const synchronizationStarted = new Promise<void>((resolvePromise) => {
      signalSynchronization = resolvePromise;
    });
    let continueSynchronization = (): void => undefined;
    const synchronizationGate = new Promise<void>((resolvePromise) => {
      continueSynchronization = resolvePromise;
    });
    const store = new SessionStore(root, {
      synchronizeDirectory: async () => {
        if (!gateSynchronization) return;
        signalSynchronization();
        await synchronizationGate;
      },
    });
    await store.initialize();
    const session = await store.create({ rootPath: root, artifactPath, artifactRelativePath: "review.html", contentHash: hash });
    await store.sendFeedback(session.id, { message: "Exactly once", annotations: [] }, false, 1, hash, "race-send");
    const now = Date.now();
    const leased = await withMockedNow(now, () =>
      store.leaseNextUndelivered(session.id, 0, "consumer-a"));
    if (!leased.delivery) throw new Error("Expected feedback to be leased before acknowledgement.");

    gateSynchronization = true;
    const acknowledgement = store.markDelivered(session.id, 1, "consumer-a", leased.leaseId);
    await synchronizationStarted;
    let releaseSettled = false;
    const release = store.releaseFeedbackLease(session.id, 1, "consumer-a", leased.leaseId)
      .finally(() => { releaseSettled = true; });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(releaseSettled).toBe(false);
    expect((await withMockedNow(now + FEEDBACK_LEASE_MILLISECONDS + 1, () =>
      store.leaseNextUndelivered(session.id, 0, "consumer-b"))).delivery).toBeUndefined();
    expect((await withMockedNow(now + FEEDBACK_LEASE_MILLISECONDS + 1, () =>
      store.leaseNextUndelivered(session.id, 0, "consumer-a"))).delivery).toBeUndefined();

    continueSynchronization();
    await acknowledgement;
    await expect(release).resolves.toBe(false);
    expect(store.get(session.id)?.deliveredFeedbackSequence).toBe(1);
    expect(store.leaseNextUndelivered(session.id, 0, "consumer-b").delivery).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "unpins an acknowledgement after a proven pre-commit persistence failure",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-html-render-ack-pre-commit-rollback-"));
      const artifactPath = join(root, "review.html");
      const hash = contentHash("<p>Review</p>");
      await writeFile(artifactPath, "<p>Review</p>");
      const store = new SessionStore(root);
      await store.initialize();
      const session = await store.create({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "review.html",
        contentHash: hash,
      });
      await store.sendFeedback(
        session.id,
        { message: "Retry after a pre-commit failure.", annotations: [] },
        false,
        1,
        hash,
        "ack-pre-commit-rollback",
      );
      const leased = store.leaseNextUndelivered(session.id, 0, "retrying-consumer");
      if (!leased.delivery) throw new Error("Expected the pre-commit test grant.");
      const sessionPath = join(store.sessionsDirectory, `${session.id}.json`);
      const blockingLink = join(root, "linked-session-snapshot.json");
      await link(sessionPath, blockingLink);

      await expect(
        store.markDelivered(session.id, 1, "retrying-consumer", leased.leaseId),
      ).rejects.toThrow("one filesystem link");
      expect(store.get(session.id)?.deliveredFeedbackSequence).toBe(0);
      await expect(
        store.releaseFeedbackLease(session.id, 1, "retrying-consumer", leased.leaseId),
      ).resolves.toBe(true);

      await unlink(blockingLink);
      const retry = store.leaseNextUndelivered(session.id, 0, "retrying-consumer");
      if (!retry.delivery) throw new Error("Expected a retry grant after the pre-commit failure.");
      expect(retry.delivery.sequence).toBe(1);
      expect(retry.leaseId).not.toBe(leased.leaseId);
      await store.markDelivered(session.id, 1, "retrying-consumer", retry.leaseId);
      expect(store.get(session.id)?.deliveredFeedbackSequence).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the acknowledgement pin and retires every lease operation after a post-commit boundary failure",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-html-render-ack-post-commit-retirement-"));
      const artifactPath = join(root, "review.html");
      const stateDirectory = join(root, ".agent-html-render");
      const parkedStateDirectory = join(root, "committed-agent-html-render-state");
      const hash = contentHash("<p>Review</p>");
      await writeFile(artifactPath, "<p>Review</p>");
      let gateAcknowledgementSync = false;
      let signalAcknowledgementSync = (): void => undefined;
      const acknowledgementSyncStarted = new Promise<void>((resolvePromise) => {
        signalAcknowledgementSync = resolvePromise;
      });
      let continueAcknowledgementSync = (): void => undefined;
      const acknowledgementSyncGate = new Promise<void>((resolvePromise) => {
        continueAcknowledgementSync = resolvePromise;
      });
      const store = new SessionStore(root, {
        synchronizeDirectory: async () => {
          if (!gateAcknowledgementSync) return;
          gateAcknowledgementSync = false;
          await rename(stateDirectory, parkedStateDirectory);
          await mkdir(stateDirectory);
          signalAcknowledgementSync();
          await acknowledgementSyncGate;
        },
      });
      await store.initialize();
      const session = await store.create({
        rootPath: root,
        artifactPath,
        artifactRelativePath: "review.html",
        contentHash: hash,
      });
      await store.sendFeedback(
        session.id,
        { message: "Retire after this durable acknowledgement.", annotations: [] },
        false,
        1,
        hash,
        "ack-post-commit-retirement",
      );
      const leased = store.leaseNextUndelivered(session.id, 0, "committing-consumer");
      if (!leased.delivery) throw new Error("Expected the committing delivery grant.");

      gateAcknowledgementSync = true;
      const acknowledgement = store.markDelivered(
        session.id,
        1,
        "committing-consumer",
        leased.leaseId,
      );
      await acknowledgementSyncStarted;
      let releaseSettled = false;
      let renewalSettled = false;
      const release = store.releaseFeedbackLease(
        session.id,
        1,
        "committing-consumer",
        leased.leaseId,
      );
      const renewal = store.renewFeedbackLease(
        session.id,
        1,
        "committing-consumer",
        leased.leaseId,
      );
      void release.then(
        () => { releaseSettled = true; },
        () => { releaseSettled = true; },
      );
      void renewal.then(
        () => { renewalSettled = true; },
        () => { renewalSettled = true; },
      );
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(releaseSettled).toBe(false);
      expect(renewalSettled).toBe(false);
      expect((await withMockedNow(Date.now() + FEEDBACK_LEASE_MILLISECONDS + 1, () =>
        store.leaseNextUndelivered(session.id, 0, "premature-successor"))).delivery).toBeUndefined();

      continueAcknowledgementSync();
      await expect(acknowledgement).rejects.toBeInstanceOf(
        SessionStoreProcessTerminationRequiredError,
      );
      await expect(release).rejects.toBeInstanceOf(SessionStoreProcessTerminationRequiredError);
      await expect(renewal).rejects.toBeInstanceOf(SessionStoreProcessTerminationRequiredError);
      expect(store.get(session.id)?.deliveredFeedbackSequence).toBe(0);
      expect(() => store.leaseNextUndelivered(session.id, 0, "post-failure-successor"))
        .toThrow(SessionStoreProcessTerminationRequiredError);
      await expect(
        store.markDelivered(session.id, 1, "committing-consumer", leased.leaseId),
      ).rejects.toBeInstanceOf(SessionStoreProcessTerminationRequiredError);

      const durableSnapshot = JSON.parse(
        await readFile(
          join(parkedStateDirectory, "sessions", `${session.id}.json`),
          "utf8",
        ),
      ) as { deliveredFeedbackSequence: number };
      expect(durableSnapshot.deliveredFeedbackSequence).toBe(1);
      await rm(stateDirectory, { recursive: true, force: true });
      await rename(parkedStateDirectory, stateDirectory);
      const restarted = new SessionStore(root);
      await restarted.initialize();
      expect(restarted.get(session.id)?.deliveredFeedbackSequence).toBe(1);
      await expect(
        restarted.markDelivered(session.id, 1, "committing-consumer", leased.leaseId),
      ).resolves.toBeUndefined();
      const staleLeaseId = `${leased.leaseId.slice(0, -1)}${leased.leaseId.endsWith("A") ? "B" : "A"}`;
      await expect(
        restarted.markDelivered(session.id, 1, "committing-consumer", staleLeaseId),
      ).rejects.toThrow("acknowledged by a different delivery grant");
    },
  );

  it("bounds retained fully delivered ended sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-session-retention-"));
    const artifactPath = join(root, "review.html");
    const hash = contentHash("<p>Review</p>");
    await writeFile(artifactPath, "<p>Review</p>");
    const store = new SessionStore(root);
    await store.initialize();
    for (let index = 0; index < 51; index += 1) {
      const session = await store.create({ rootPath: root, artifactPath, artifactRelativePath: "review.html", contentHash: hash });
      await store.sendFeedback(session.id, { message: `End ${index}`, annotations: [] }, true, 1, hash, `end-${index}`);
      await acknowledgeFeedbackSequence(store, session.id, 1, `ended-retention-consumer-${index}`);
    }
    expect(store.list()).toHaveLength(50);
    expect((await readdir(join(root, ".agent-html-render", "sessions"))).filter((name) => name.endsWith(".json"))).toHaveLength(50);
  });
});
