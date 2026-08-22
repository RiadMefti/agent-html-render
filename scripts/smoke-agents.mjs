#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const skillPath = resolve(repositoryRoot, "skills/agentlens/SKILL.md");
const themePath = resolve(repositoryRoot, "skills/agentlens/references/theme.md");

function commandSmoke(command) {
  const result = spawnSync(command, ["--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error?.code === "ENOENT") return { status: "missing", detail: "not installed" };
  if (result.error) return { status: "failed", detail: result.error.message };
  if (result.status !== 0) return { status: "failed", detail: `help exited ${result.status}` };
  return { status: "ready", detail: "CLI available" };
}

function agentLensCliSmoke() {
  const entry = resolve(repositoryRoot, "dist/node/cli.js");
  const result = spawnSync(process.execPath, [entry, "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.includes("agentlens review")) {
    throw new Error("The built AgentLens CLI did not return its command contract.");
  }
}

async function validatePortableSkill() {
  const [skill, theme] = await Promise.all([readFile(skillPath, "utf8"), readFile(themePath, "utf8")]);
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
  if (!/^name:\s*agentlens\s*$/mu.test(frontmatter)) throw new Error("Skill name is missing or invalid.");
  if (!/^description:\s*\S.+$/mu.test(frontmatter)) throw new Error("Skill description is missing.");
  if (!skill.includes("references/theme.md")) throw new Error("The theme reference is not discoverable.");
  if (!skill.includes("npx --yes --prefer-online @rimef/agentlens@latest review")) {
    throw new Error("The portable skill does not invoke the current npm package through npx.");
  }
  if (!theme.includes("--background: #fafafa")) throw new Error("The shared theme tokens are incomplete.");
}

await validatePortableSkill();
agentLensCliSmoke();
const hosts = ["codex", "claude", "opencode"].map((command) => ({ command, ...commandSmoke(command) }));
for (const host of hosts) {
  const mark = host.status === "ready" ? "✓" : host.status === "missing" ? "○" : "×";
  process.stdout.write(`${mark} ${host.command}: ${host.detail}\n`);
}
process.stdout.write("✓ portable AgentLens skill: valid shared SKILL.md + theme reference\n");
process.stdout.write("✓ AgentLens CLI: built command contract available\n");

const failures = hosts.filter((host) => host.status === "failed" || (strict && host.status === "missing"));
if (failures.length > 0) process.exitCode = 1;
