import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installProjectSkill } from "../../src/node/install.js";

describe("portable skill installer", () => {
  it("installs one canonical skill and a Claude-compatible adapter without overwriting", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-install-"));
    const source = resolve("skills/agent-html-render");

    const first = await installProjectSkill(root, source);
    expect(first.canonicalStatus).toBe("installed");
    expect(["linked", "copied"]).toContain(first.claudeStatus);
    expect(await readFile(join(first.canonicalPath, "SKILL.md"), "utf8")).toContain("# Agent HTML Render review loop");
    expect(first.legacyPaths).toEqual([]);
    expect((await lstat(first.claudePath)).isSymbolicLink() || (await lstat(first.claudePath)).isDirectory()).toBe(
      true,
    );

    const second = await installProjectSkill(root, source);
    expect(second.canonicalStatus).toBe("present");
    expect(second.claudeStatus).toBe("present");

    await writeFile(join(first.canonicalPath, "SKILL.md"), "user-owned skill");
    await expect(installProjectSkill(root, source)).rejects.toThrow("different skill already exists");
  });

  it("reports legacy AgentLens and AgentRender skills without deleting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-legacy-install-"));
    const source = resolve("skills/agent-html-render");
    const legacyAgentLensPath = join(root, ".agents", "skills", "agentlens");
    const previewAgentRenderPath = join(root, ".claude", "skills", "agentrender");
    await mkdir(legacyAgentLensPath, { recursive: true });
    await mkdir(previewAgentRenderPath, { recursive: true });
    await writeFile(join(legacyAgentLensPath, "SKILL.md"), "legacy user-owned skill");
    await writeFile(join(previewAgentRenderPath, "SKILL.md"), "preview user-owned skill");

    const result = await installProjectSkill(root, source);
    expect(result.legacyPaths).toEqual(expect.arrayContaining([legacyAgentLensPath, previewAgentRenderPath]));
    expect(await readFile(join(legacyAgentLensPath, "SKILL.md"), "utf8")).toBe("legacy user-owned skill");
    expect(await readFile(join(previewAgentRenderPath, "SKILL.md"), "utf8")).toBe("preview user-owned skill");
  });
});
