import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installProjectSkill } from "../../src/node/install.js";

describe("portable skill installer", () => {
  it("installs one canonical skill and a Claude-compatible adapter without overwriting", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentlens-install-"));
    const source = resolve("skills/agentlens");

    const first = await installProjectSkill(root, source);
    expect(first.canonicalStatus).toBe("installed");
    expect(["linked", "copied"]).toContain(first.claudeStatus);
    expect(await readFile(join(first.canonicalPath, "SKILL.md"), "utf8")).toContain("# AgentLens review loop");
    expect((await lstat(first.claudePath)).isSymbolicLink() || (await lstat(first.claudePath)).isDirectory()).toBe(
      true,
    );

    const second = await installProjectSkill(root, source);
    expect(second.canonicalStatus).toBe("present");
    expect(second.claudeStatus).toBe("present");

    await writeFile(join(first.canonicalPath, "SKILL.md"), "user-owned skill");
    await expect(installProjectSkill(root, source)).rejects.toThrow("different skill already exists");
  });
});
