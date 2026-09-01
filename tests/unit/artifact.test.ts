import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  MAX_ARTIFACT_BYTES,
  readArtifact,
  renderSandboxedArtifact,
  resolveArtifact,
} from "../../src/node/artifact.js";

describe("artifact boundary", () => {
  it("accepts only canonical HTML files inside the project root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-artifact-"));
    const root = join(parent, "project");
    await mkdir(root);
    await writeFile(join(root, "review.html"), "<!doctype html><p>Review</p>");
    await writeFile(join(parent, "outside.html"), "<p>Outside</p>");
    await symlink(join(parent, "outside.html"), join(root, "escape.html"));

    await expect(resolveArtifact(root, "review.html")).resolves.toMatchObject({
      artifactRelativePath: "review.html",
    });
    await expect(resolveArtifact(root, "../outside.html")).rejects.toThrow("inside");
    await expect(resolveArtifact(root, "escape.html")).rejects.toThrow("inside");
  });

  it("rejects non-HTML and oversized files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-limits-"));
    await writeFile(join(root, "notes.txt"), "notes");
    await writeFile(join(root, "large.html"), "x".repeat(MAX_ARTIFACT_BYTES + 1));

    await expect(resolveArtifact(root, "notes.txt")).rejects.toThrow(".html");
    await expect(resolveArtifact(root, "large.html")).rejects.toThrow("limit");
  });

  it.skipIf(process.platform === "win32")("fails closed when a validated artifact is replaced by a symlink", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-read-swap-"));
    const root = join(parent, "project");
    const artifactPath = join(root, "review.html");
    const outsidePath = join(parent, "outside.html");
    await mkdir(root);
    await writeFile(artifactPath, "<p>Inside</p>");
    await writeFile(outsidePath, "<p>Outside sentinel</p>");
    const artifact = await resolveArtifact(root, "review.html");

    await rm(artifactPath);
    await symlink(outsidePath, artifactPath);

    await expect(readArtifact(artifact)).rejects.toThrow("inside the selected project root");
  });

  it.skipIf(process.platform === "win32")("fails closed when a validated parent directory is swapped", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-parent-swap-"));
    const root = join(parent, "project");
    const insideDirectory = join(root, "plans");
    const movedDirectory = join(root, "plans-old");
    const outsideDirectory = join(parent, "outside");
    await mkdir(insideDirectory, { recursive: true });
    await mkdir(outsideDirectory);
    await writeFile(join(insideDirectory, "review.html"), "<p>Inside</p>");
    await writeFile(join(outsideDirectory, "review.html"), "<p>Outside sentinel</p>");
    const artifact = await resolveArtifact(root, "plans/review.html");

    await rename(insideDirectory, movedDirectory);
    await symlink(outsideDirectory, insideDirectory, "dir");

    await expect(readArtifact(artifact)).rejects.toThrow("inside the selected project root");
  });

  it.skipIf(process.platform === "win32")("fails closed when a validated parent is replaced by another directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-parent-identity-"));
    const root = join(parent, "project");
    const originalDirectory = join(root, "plans");
    const parkedDirectory = join(root, "plans-original");
    const replacementDirectory = join(root, "replacement");
    await mkdir(originalDirectory, { recursive: true });
    await mkdir(replacementDirectory);
    await writeFile(join(originalDirectory, "review.html"), "<p>Original</p>");
    await writeFile(join(replacementDirectory, "review.html"), "<p>Replacement</p>");
    const artifact = await resolveArtifact(root, "plans/review.html");

    await rename(originalDirectory, parkedDirectory);
    await rename(replacementDirectory, originalDirectory);

    await expect(readArtifact(artifact)).rejects.toThrow("artifact parent changed");
  });

  it.skipIf(process.platform === "win32")("never returns outside bytes while a parent alternates between a directory and symlink", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-parent-race-"));
    const root = join(parent, "project");
    const insideDirectory = join(root, "plans");
    const parkedDirectory = join(root, "plans-safe");
    const outsideDirectory = join(parent, "outside");
    await mkdir(insideDirectory, { recursive: true });
    await mkdir(outsideDirectory);
    await writeFile(join(insideDirectory, "review.html"), "<p>Inside</p>");
    await writeFile(join(outsideDirectory, "review.html"), "<p>Outside sentinel</p>");
    const artifact = await resolveArtifact(root, "plans/review.html");

    const toggle = async (): Promise<void> => {
      for (let index = 0; index < 30; index += 1) {
        await rename(insideDirectory, parkedDirectory);
        await symlink(outsideDirectory, insideDirectory, "dir");
        await rm(insideDirectory);
        await rename(parkedDirectory, insideDirectory);
      }
    };
    const reads = Promise.all(
      Array.from({ length: 30 }, () =>
        readArtifact(artifact).then(({ content }) => content, () => "rejected"),
      ),
    );
    const [, outcomes] = await Promise.all([toggle(), reads]);

    expect(outcomes).not.toContain("<p>Outside sentinel</p>");
    expect(outcomes).toContain("<p>Inside</p>");
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO swap without waiting for a writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-fifo-swap-"));
    const artifactPath = join(root, "review.html");
    await writeFile(artifactPath, "<p>Inside</p>");
    const artifact = await resolveArtifact(root, "review.html");
    await rm(artifactPath);
    execFileSync("mkfifo", [artifactPath]);

    let readError: unknown;
    const read = readArtifact(artifact).then(
      () => "resolved" as const,
      (error: unknown) => {
        readError = error;
        return "rejected" as const;
      },
    );
    const outcome = await Promise.race([read, delay(250, "timeout" as const)]);
    if (outcome === "timeout") {
      await writeFile(artifactPath, "unblock").catch(() => undefined);
      await read;
    }

    expect(outcome).toBe("rejected");
    expect(readError).toBeInstanceOf(Error);
    expect((readError as Error).message).toContain("regular file");
  });

  it("fails closed when the selected root is replaced at the same pathname", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-root-swap-"));
    const root = join(parent, "project");
    const movedRoot = join(parent, "project-old");
    const replacementRoot = join(parent, "replacement");
    await mkdir(root);
    await mkdir(replacementRoot);
    await writeFile(join(root, "review.html"), "<p>Inside</p>");
    await writeFile(join(replacementRoot, "review.html"), "<p>Replacement sentinel</p>");
    const artifact = await resolveArtifact(root, "review.html");

    await rename(root, movedRoot);
    await rename(replacementRoot, root);

    await expect(readArtifact(artifact)).rejects.toThrow("project root changed");
  });

  it("preserves ordinary atomic replacement inside the selected root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-atomic-save-"));
    const artifactPath = join(root, "review.html");
    const replacementPath = join(root, "replacement.html");
    await writeFile(artifactPath, "<p>First</p>");
    const artifact = await resolveArtifact(root, "review.html");
    await writeFile(replacementPath, "<p>Second</p>");
    await rename(replacementPath, artifactPath);

    await expect(readArtifact(artifact)).resolves.toMatchObject({ content: "<p>Second</p>" });
  });

  it("bounds a replacement before returning any artifact bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-bounded-replacement-"));
    const artifactPath = join(root, "review.html");
    const replacementPath = join(root, "replacement.html");
    await writeFile(artifactPath, "<p>Small</p>");
    const artifact = await resolveArtifact(root, "review.html");
    await writeFile(replacementPath, "x".repeat(MAX_ARTIFACT_BYTES + 1));
    await rename(replacementPath, artifactPath);

    await expect(readArtifact(artifact)).rejects.toThrow("limit");
  });

  it("injects only the nonce bridge and replaces artifact CSP declarations", () => {
    const rendered = renderSandboxedArtifact(
      `<!doctype html><html><head>
        <meta http-equiv="Content-Security-Policy" content="default-src *">
        <meta content="0; url=https://example.com" http-equiv="refr&#x65;sh">
        <meta content="unsafe-url" name="referrer">
        <base href="https://example.com/" target="_top">
        <script>window.authored = true</script>
      </head><body><p>safe</p></body></html>`,
      { sessionId: "session", token: "token<unsafe", parentOrigin: "http://127.0.0.1:3000" },
      "window.bridgeLoaded = true;",
    );

    expect(rendered.contentSecurityPolicy).toContain("default-src 'none'");
    expect(rendered.contentSecurityPolicy).toContain("connect-src 'none'");
    expect(rendered.contentSecurityPolicy).toContain("navigate-to 'none'");
    expect(rendered.html).toContain(rendered.contentSecurityPolicy);
    expect(rendered.html).toContain('name="referrer" content="no-referrer"');
    expect(rendered.html).toContain("window.bridgeLoaded = true");
    expect(rendered.html).toContain("token\\u003cunsafe");
    expect(rendered.html).not.toContain("default-src *");
    expect(rendered.html).not.toContain("example.com");
    expect(rendered.html).not.toContain("unsafe-url");
    expect(rendered.html.match(/nonce=/g)).toHaveLength(1);
    expect(rendered.html).toContain("<script>window.authored = true</script>");
  });

  it("injects into the parsed head before hostile authored markup", () => {
    const rendered = renderSandboxedArtifact(
      "<!doctype html><!-- <head> --><html><script>window.authored = true</script><head></head><body></body></html>",
      { sessionId: "session", token: "token", parentOrigin: "http://127.0.0.1:3000" },
      'window.bridgeLoaded = "</script><p id=breakout>breakout</p>";',
    );

    expect(rendered.html.indexOf("Content-Security-Policy")).toBeLessThan(rendered.html.indexOf("window.authored = true"));
    expect(rendered.html.indexOf("window.bridgeLoaded")).toBeLessThan(
      rendered.html.indexOf("window.authored = true"),
    );
    expect(rendered.html).toContain("<!-- <head> -->");
    expect(rendered.html).toContain(String.raw`<\/script><p id=breakout>`);
    expect(rendered.contentSecurityPolicy).toContain("script-src 'nonce-");
  });
});
