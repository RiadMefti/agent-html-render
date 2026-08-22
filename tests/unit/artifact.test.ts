import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_ARTIFACT_BYTES,
  renderSandboxedArtifact,
  resolveArtifact,
} from "../../src/node/artifact.js";

describe("artifact boundary", () => {
  it("accepts only canonical HTML files inside the project root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentrender-artifact-"));
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
    const root = await mkdtemp(join(tmpdir(), "agentrender-limits-"));
    await writeFile(join(root, "notes.txt"), "notes");
    await writeFile(join(root, "large.html"), "x".repeat(MAX_ARTIFACT_BYTES + 1));

    await expect(resolveArtifact(root, "notes.txt")).rejects.toThrow(".html");
    await expect(resolveArtifact(root, "large.html")).rejects.toThrow("limit");
  });

  it("injects only the nonce bridge and replaces artifact CSP declarations", () => {
    const rendered = renderSandboxedArtifact(
      `<!doctype html><html><head>
        <meta http-equiv="Content-Security-Policy" content="default-src *">
        <meta content="0; url=https://example.com" http-equiv="refresh">
        <meta content="unsafe-url" name="referrer">
        <script>window.authored = true</script>
      </head><body><p>safe</p></body></html>`,
      { sessionId: "session", token: "token<unsafe", parentOrigin: "http://127.0.0.1:3000" },
      "window.bridgeLoaded = true;",
    );

    expect(rendered).toContain("default-src 'none'");
    expect(rendered).toContain("connect-src 'none'");
    expect(rendered).toContain("navigate-to 'none'");
    expect(rendered).toContain('name="referrer" content="no-referrer"');
    expect(rendered).toContain("window.bridgeLoaded = true");
    expect(rendered).toContain("token\\u003cunsafe");
    expect(rendered).not.toContain("default-src *");
    expect(rendered).not.toContain("example.com");
    expect(rendered).not.toContain("unsafe-url");
    expect(rendered.match(/nonce=/g)).toHaveLength(1);
    expect(rendered).toContain("<script>window.authored = true</script>");
  });
});
