#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const skillPath = resolve(repositoryRoot, "skills/agent-html-render/SKILL.md");
const themePath = resolve(repositoryRoot, "skills/agent-html-render/references/theme.md");
const cliEntry = resolve(repositoryRoot, "dist/node/cli.js");
const installEntry = resolve(repositoryRoot, "dist/node/install.js");

function run(command, args, cwd, options = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function commandAvailable(command) {
  const result = run(command, ["--help"], repositoryRoot);
  if (result.error?.code === "ENOENT") return false;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} --help exited ${result.status}: ${result.stderr}`);
  return true;
}

function commandVersion(command) {
  const result = run(command, ["--version"], repositoryRoot);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} --version exited ${result.status}: ${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/u)[0] || "version unknown";
}

async function installFixture(projectRoot) {
  const git = run("git", ["init", "--quiet", projectRoot], repositoryRoot);
  if (git.error) throw git.error;
  if (git.status !== 0) throw new Error(`Git fixture initialization failed: ${git.stderr}`);
  const previousBundleRoot = await mkdtemp(join(tmpdir(), "agent-html-render-previous-skill-"));
  const previousBundle = join(previousBundleRoot, "agent-html-render");
  try {
    await cp(resolve(repositoryRoot, "skills", "agent-html-render"), previousBundle, { recursive: true });
    const previousSkillPath = join(previousBundle, "SKILL.md");
    await writeFile(
      previousSkillPath,
      `${await readFile(previousSkillPath, "utf8")}\n<!-- previous managed smoke version -->\n`,
    );
    const { installProjectSkill } = await import(pathToFileURL(installEntry).href);
    await installProjectSkill(projectRoot, previousBundle);
    const result = run(process.execPath, [cliEntry, "install-skill", "--root", projectRoot], repositoryRoot);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Skill fixture upgrade failed: ${result.stderr}`);
  } finally {
    await rm(previousBundleRoot, { recursive: true, force: true });
  }
}

async function validateInstalledLayout(projectRoot) {
  const canonical = join(projectRoot, ".agents", "skills", "agent-html-render");
  const claude = join(projectRoot, ".claude", "skills", "agent-html-render");
  const backupDirectory = join(projectRoot, ".agent-html-render", "skill-backups");
  const [canonicalSkill, claudeSkill, receipt, claudeDetails, backups, agentsEntries, claudeEntries] = await Promise.all([
    readFile(join(canonical, "SKILL.md"), "utf8"),
    readFile(join(claude, "SKILL.md"), "utf8"),
    readFile(join(canonical, ".agent-html-render-managed.json"), "utf8"),
    lstat(claude),
    readdir(backupDirectory),
    readdir(join(projectRoot, ".agents", "skills")),
    readdir(join(projectRoot, ".claude", "skills")),
  ]);
  if (!canonicalSkill.includes("# Agent HTML Render review loop") || canonicalSkill !== claudeSkill) {
    throw new Error("The installed canonical and host adapter skill instructions do not match.");
  }
  if (!JSON.parse(receipt).files?.["SKILL.md"]) throw new Error("The managed skill receipt is incomplete.");
  if (process.platform !== "win32" && !claudeDetails.isSymbolicLink()) {
    throw new Error("The Claude adapter should be a symlink on this platform.");
  }
  if (backups.length !== 1 || !backups[0]?.startsWith("agents-agent-html-render-")) {
    throw new Error("The upgraded managed skill did not retain exactly one rollback outside host discovery roots.");
  }
  if (agentsEntries.some((entry) => entry.includes("backup")) || claudeEntries.some((entry) => entry.includes("backup"))) {
    throw new Error("A managed rollback was left inside a host skill-discovery root.");
  }
}

async function codexDiscoversSkill(projectRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let initialized = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Codex skills/list timed out: ${stderr}`));
    }, 15_000);
    child.once("error", (error) => finish(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && !initialized) {
          initialized = true;
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(
            `${JSON.stringify({
              id: 2,
              method: "skills/list",
              params: { cwds: [projectRoot], forceReload: true },
            })}\n`,
          );
        } else if (message.id === 2) {
          const skills = message.result?.data?.flatMap((entry) => entry.skills ?? []) ?? [];
          const match = skills.find((skill) => skill.name === "agent-html-render");
          finish(
            match ? undefined : new Error(`Codex skills/list did not discover agent-html-render: ${line}`),
            Boolean(match),
          );
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "agent-html-render-smoke", version: "1.0.0" },
          capabilities: null,
        },
      })}\n`,
    );
  });
}

function opencodeDiscoversSkill(projectRoot) {
  const result = run("opencode", ["--print-logs", "--log-level", "DEBUG", "--pure", "debug", "skill"], projectRoot, {
    env: { ...process.env, OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`opencode debug skill exited ${result.status}: ${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes("agent-html-render")) {
    throw new Error("OpenCode did not discover agent-html-render from the installed project skill.");
  }
  const rollbackDuplicate = output.split(/\r?\n/u).find((line) =>
    line.includes("duplicate skill name") &&
    line.includes("name=agent-html-render") &&
    line.includes("skill-backups")
  );
  if (rollbackDuplicate) {
    throw new Error(`OpenCode discovered an Agent HTML Render rollback as a live skill: ${rollbackDuplicate}`);
  }
}

function claudeAdapterSmoke(projectRoot) {
  const result = run("claude", ["doctor"], projectRoot);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`claude doctor exited ${result.status}: ${result.stderr}`);
}

async function validatePortableSkill() {
  const [skill, theme] = await Promise.all([readFile(skillPath, "utf8"), readFile(themePath, "utf8")]);
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
  if (!/^name:\s*agent-html-render\s*$/mu.test(frontmatter)) throw new Error("Skill name is missing or invalid.");
  if (!/^description:\s*\S.+$/mu.test(frontmatter)) throw new Error("Skill description is missing.");
  if (!skill.includes("references/theme.md")) throw new Error("The theme reference is not discoverable.");
  if (!skill.includes("npx --yes --prefer-offline agent-html-render@0.5.0 review")) {
    throw new Error("The portable skill does not invoke its pinned npm release through npx.");
  }
  if (!theme.includes("--background: #fafafa")) throw new Error("The shared theme tokens are incomplete.");
}

function agentHtmlRenderCliSmoke() {
  const result = run(process.execPath, [cliEntry, "--help"], repositoryRoot);
  if (result.error) throw result.error;
  if (
    result.status !== 0 ||
    !result.stdout.includes("agent-html-render review") ||
    !result.stdout.includes("agent-html-render demo") ||
    !result.stdout.includes("agent-html-render doctor")
  ) {
    throw new Error("The built Agent HTML Render CLI did not return its complete command contract.");
  }
}

function doctorSmoke(projectRoot) {
  const result = run(process.execPath, [cliEntry, "doctor", "--root", projectRoot, "--format", "json"], repositoryRoot);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`agent-html-render doctor exited ${result.status}: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  if (!report.ok || !report.skills?.canonicalInstalled || report.daemon?.running) {
    throw new Error(`Agent HTML Render doctor returned an unexpected report: ${result.stdout}`);
  }
  if (result.stdout.includes('"token"')) throw new Error("Agent HTML Render doctor exposed a daemon credential.");
}

await validatePortableSkill();
agentHtmlRenderCliSmoke();
const projectRoot = await mkdtemp(join(tmpdir(), "agent-html-render-host-smoke-"));
const results = [];
try {
  await installFixture(projectRoot);
  await validateInstalledLayout(projectRoot);
  doctorSmoke(projectRoot);
  for (const command of ["codex", "claude", "opencode"]) {
    if (!commandAvailable(command)) {
      results.push({ command, status: "missing", detail: "not installed" });
      continue;
    }
    try {
      const version = commandVersion(command);
      if (command === "codex") await codexDiscoversSkill(await realpath(projectRoot));
      else if (command === "opencode") opencodeDiscoversSkill(projectRoot);
      else claudeAdapterSmoke(projectRoot);
      results.push({
        command,
        status: "ready",
        detail:
          command === "claude"
            ? `adapter resolved and doctor passed (${version}); actual skill invocation is a release checklist gate`
            : `project skill discovered by host (${version})`,
      });
    } catch (error) {
      results.push({
        command,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}

for (const host of results) {
  const mark = host.status === "ready" ? "✓" : host.status === "missing" ? "○" : "×";
  process.stdout.write(`${mark} ${host.command}: ${host.detail}\n`);
}
process.stdout.write("✓ portable Agent HTML Render skill: valid shared SKILL.md + theme reference\n");
process.stdout.write("✓ upgraded skill layout: canonical, managed, Claude-compatible, and rollback-isolated\n");
process.stdout.write("✓ Agent HTML Render CLI: review, demo, and doctor contracts available\n");
process.stdout.write("✓ Agent HTML Render doctor: project readiness report is safe and actionable\n");

const failures = results.filter((host) => host.status === "failed" || (strict && host.status === "missing"));
if (failures.length > 0) process.exitCode = 1;
