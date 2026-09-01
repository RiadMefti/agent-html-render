import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    expect(second.warnings).toEqual([]);

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

  it("upgrades an unchanged managed skill and still protects user edits", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-managed-upgrade-"));
    const root = join(parent, "project");
    const source = join(parent, "bundled-skill");
    await mkdir(root);
    await cp(resolve("skills/agent-html-render"), source, { recursive: true });
    const first = await installProjectSkill(root, source);
    const upgradedSkill = `${await readFile(join(source, "SKILL.md"), "utf8")}\nManaged upgrade.\n`;
    await writeFile(join(source, "SKILL.md"), upgradedSkill);

    const upgraded = await installProjectSkill(root, source);
    expect(upgraded.canonicalStatus).toBe("updated");
    expect(await readFile(join(first.canonicalPath, "SKILL.md"), "utf8")).toBe(upgradedSkill);

    await writeFile(join(first.canonicalPath, "SKILL.md"), `${upgradedSkill}\nUser edit.\n`);
    await writeFile(join(source, "SKILL.md"), `${upgradedSkill}\nAnother managed version.\n`);
    await expect(installProjectSkill(root, source)).rejects.toThrow("different skill already exists");
  });

  it.skipIf(process.platform === "win32")("commits an upgrade and retains a read-only managed backup", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-managed-readonly-cleanup-"));
    const root = join(parent, "project");
    const source = join(parent, "bundled-skill");
    await mkdir(root);
    await cp(resolve("skills/agent-html-render"), source, { recursive: true });
    const first = await installProjectSkill(root, source);
    await chmod(join(first.canonicalPath, "references"), 0o555);
    const originalSkill = await readFile(join(source, "SKILL.md"), "utf8");
    const upgradedSkill = `${originalSkill}\nReadonly cleanup upgrade.\n`;
    await writeFile(join(source, "SKILL.md"), upgradedSkill);

    const upgraded = await installProjectSkill(root, source);

    expect(upgraded.canonicalStatus).toBe("updated");
    expect(upgraded.claudeStatus).toBe("present");
    expect(await readFile(join(first.canonicalPath, "SKILL.md"), "utf8")).toBe(upgradedSkill);
    const backupDirectory = join(root, ".agent-html-render", "skill-backups");
    const backups = (await readdir(backupDirectory)).filter((entry) =>
      entry.startsWith("agents-agent-html-render-")
    );
    expect(backups).toHaveLength(1);
    expect(upgraded.warnings).toEqual([expect.stringContaining(backups[0] ?? "missing-backup")]);
    expect(await readFile(join(backupDirectory, backups[0] ?? "", "SKILL.md"), "utf8"))
      .toBe(originalSkill);
    expect((await readdir(dirname(first.canonicalPath))).some((entry) => entry.includes("backup"))).toBe(false);
    expect((await readdir(join(root, ".claude", "skills"))).some((entry) => entry.includes("backup"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("preserves a save through a file handle opened before upgrade", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-managed-open-editor-"));
    const root = join(parent, "project");
    const source = join(parent, "bundled-skill");
    await mkdir(root);
    await cp(resolve("skills/agent-html-render"), source, { recursive: true });
    const first = await installProjectSkill(root, source);
    const oldHandle = await open(join(first.canonicalPath, "SKILL.md"), "r+");
    const upgradedSkill = `${await readFile(join(source, "SKILL.md"), "utf8")}\nOpen editor upgrade.\n`;
    await writeFile(join(source, "SKILL.md"), upgradedSkill);

    const upgraded = await installProjectSkill(root, source);
    await oldHandle.truncate(0);
    await oldHandle.writeFile("saved from an editor opened before upgrade", "utf8");
    await oldHandle.sync();
    await oldHandle.close();

    const backupDirectory = join(root, ".agent-html-render", "skill-backups");
    const backups = (await readdir(backupDirectory)).filter((entry) =>
      entry.startsWith("agents-agent-html-render-")
    );
    expect(upgraded.canonicalStatus).toBe("updated");
    expect(upgraded.claudeStatus).toBe("present");
    expect(backups).toHaveLength(1);
    expect(await readFile(join(backupDirectory, backups[0] ?? "", "SKILL.md"), "utf8"))
      .toBe("saved from an editor opened before upgrade");
    expect(upgraded.warnings).toEqual([expect.stringContaining(backups[0] ?? "missing-backup")]);
  });

  it.skipIf(process.platform === "win32")("does not redirect a managed upgrade into a replacement project root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-managed-root-swap-"));
    const root = join(parent, "project");
    const movedRoot = join(parent, "project-original");
    const replacementRoot = join(parent, "replacement");
    const source = join(parent, "bundled-skill");
    await mkdir(root);
    await cp(resolve("skills/agent-html-render"), source, { recursive: true });
    await installProjectSkill(root, source);
    await Promise.all(Array.from({ length: 500 }, (_, index) =>
      writeFile(join(source, `upgrade-${index}.txt`), "managed upgrade payload".repeat(500))
    ));
    const replacementTarget = join(replacementRoot, ".agents", "skills", "agent-html-render");
    await mkdir(replacementTarget, { recursive: true });
    await mkdir(join(replacementRoot, ".claude", "skills"), { recursive: true });
    await writeFile(join(replacementTarget, "user.txt"), "keep replacement user skill");

    const installation = installProjectSkill(root, source).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    let swapped = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const entries = await readdir(join(root, ".agents", "skills")).catch(() => [] as string[]);
      if (entries.some((entry) => entry.startsWith(".agent-html-render-") && !entry.includes("backup"))) {
        await rename(root, movedRoot);
        await rename(replacementRoot, root);
        swapped = true;
        break;
      }
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    }
    const result = await installation;

    expect(swapped).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain("changed after Agent HTML Render pinned it");
    const liveReplacementTarget = join(root, ".agents", "skills", "agent-html-render");
    expect(await readdir(liveReplacementTarget)).toEqual(["user.txt"]);
    expect(await readFile(join(liveReplacementTarget, "user.txt"), "utf8")).toBe("keep replacement user skill");
  });

  it.skipIf(process.platform === "win32")("preserves user-added links during a managed upgrade", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-managed-link-"));
    const root = join(parent, "project");
    const source = join(parent, "bundled-skill");
    const userTarget = join(parent, "user-owned.txt");
    await mkdir(root);
    await cp(resolve("skills/agent-html-render"), source, { recursive: true });
    const first = await installProjectSkill(root, source);
    await writeFile(userTarget, "user-owned content");
    const userLink = join(first.canonicalPath, "user-link");
    await symlink(userTarget, userLink);
    await writeFile(join(source, "SKILL.md"), `${await readFile(join(source, "SKILL.md"), "utf8")}\nUpgrade.\n`);

    await expect(installProjectSkill(root, source)).rejects.toThrow("different skill already exists");
    expect((await lstat(userLink)).isSymbolicLink()).toBe(true);
    expect(await readFile(userTarget, "utf8")).toBe("user-owned content");
  });

  it("preserves user-added empty directories during a managed upgrade", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-managed-empty-directory-"));
    const root = join(parent, "project");
    const source = join(parent, "bundled-skill");
    await mkdir(root);
    await cp(resolve("skills/agent-html-render"), source, { recursive: true });
    const first = await installProjectSkill(root, source);
    const userDirectory = join(first.canonicalPath, "user-notes");
    await mkdir(userDirectory);
    await writeFile(join(source, "SKILL.md"), `${await readFile(join(source, "SKILL.md"), "utf8")}\nUpgrade.\n`);

    await expect(installProjectSkill(root, source)).rejects.toThrow("different skill already exists");
    expect((await lstat(userDirectory)).isDirectory()).toBe(true);
  });

  it("migrates file-only managed receipts when their implied directory tree is unchanged", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-managed-receipt-migration-"));
    const root = join(parent, "project");
    const source = join(parent, "bundled-skill");
    await mkdir(root);
    await cp(resolve("skills/agent-html-render"), source, { recursive: true });
    const first = await installProjectSkill(root, source);
    const receiptPath = join(first.canonicalPath, ".agent-html-render-managed.json");
    const legacyReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as { directories?: string[] };
    delete legacyReceipt.directories;
    await writeFile(receiptPath, `${JSON.stringify(legacyReceipt, null, 2)}\n`);
    const upgradedSkill = `${await readFile(join(source, "SKILL.md"), "utf8")}\nUpgrade after migration.\n`;
    await writeFile(join(source, "SKILL.md"), upgradedSkill);

    const upgraded = await installProjectSkill(root, source);
    expect(upgraded.canonicalStatus).toBe("updated");
    expect(await readFile(join(first.canonicalPath, "SKILL.md"), "utf8")).toBe(upgradedSkill);
  });

  it.skipIf(process.platform === "win32")("never writes a managed receipt through a link", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-html-render-receipt-link-"));
    const root = join(parent, "project");
    const source = resolve("skills/agent-html-render");
    const victim = join(parent, "receipt-victim.txt");
    await mkdir(root);
    await writeFile(victim, "keep receipt victim");
    const first = await installProjectSkill(root, source);
    const receiptPath = join(first.canonicalPath, ".agent-html-render-managed.json");
    await rm(receiptPath);
    await symlink(victim, receiptPath);

    await expect(installProjectSkill(root, source)).rejects.toThrow("different skill already exists");
    expect(await readFile(victim, "utf8")).toBe("keep receipt victim");
    expect((await lstat(receiptPath)).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("rejects project skill directories that redirect outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-html-render-install-link-root-"));
    const outside = await mkdtemp(join(tmpdir(), "agent-html-render-install-link-outside-"));
    await symlink(outside, join(root, ".agents"), "dir");

    await expect(installProjectSkill(root, resolve("skills/agent-html-render"))).rejects.toThrow(
      "must stay in regular directories",
    );
  });
});
