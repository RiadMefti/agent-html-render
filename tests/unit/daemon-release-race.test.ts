import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  acquireStartupLock,
  daemonProcessIsAlive,
  daemonLockPath,
  inspectStartupCoordinator,
} from "../../src/node/daemon.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

test.skipIf(process.platform === "win32")(
  "kernel coordinator release never mutates a legacy lock pathname introduced while held",
  async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-lock-release-race-"));
    temporaryDirectories.push(rootPath);
    const victimPath = join(rootPath, "replacement-victim.txt");
    await writeFile(victimPath, "keep replacement victim", { mode: 0o600 });
    const release = await acquireStartupLock(rootPath);
    const lockPath = daemonLockPath(rootPath);
    await symlink(victimPath, lockPath);

    await release();

    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(victimPath, "utf8")).toBe("keep replacement victim");
    expect((await readdir(join(rootPath, ".agent-html-render"))).filter((entry) =>
      entry.startsWith("daemon.lock.retired-")
    )).toEqual([]);
  },
);

test.skipIf(process.platform !== "linux")(
  "kernel coordinator is released automatically when its owner is killed",
  async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-lock-crash-release-"));
    temporaryDirectories.push(rootPath);
    const holder = resolve("tests/fixtures/startup-lock-holder.ts");
    const child = spawn(process.execPath, ["--import", "tsx", holder, rootPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = child.stdout;
    if (!stdout) throw new Error("The startup-lock holder did not expose stdout.");
    await once(stdout, "data");

    child.kill("SIGKILL");
    await once(child, "exit");

    const release = await acquireStartupLock(rootPath);
    await release();
    await expect(lstat(daemonLockPath(rootPath))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.skipIf(process.platform !== "linux")(
  "parent exit before child readiness cannot strand a transferred coordinator",
  async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-lock-pre-ready-exit-"));
    temporaryDirectories.push(rootPath);
    const parentFixture = resolve("tests/fixtures/startup-coordinator-pre-ready-parent.ts");
    const parent = spawn(process.execPath, ["--import", "tsx", parentFixture, rootPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!parent.stdout) throw new Error("The pre-ready parent did not expose stdout.");
    const [chunk] = await once(parent.stdout, "data") as [Buffer];
    const childPid = Number.parseInt(chunk.toString("utf8").trim(), 10);
    expect(childPid).toBeGreaterThan(0);

    const parentExited = once(parent, "exit");
    parent.kill("SIGKILL");
    await parentExited;
    expect(await inspectStartupCoordinator(rootPath)).toEqual({ status: "idle" });

    const deadline = Date.now() + 5_000;
    while (daemonProcessIsAlive(childPid) && Date.now() < deadline) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    if (daemonProcessIsAlive(childPid)) process.kill(childPid, "SIGKILL");
    expect(daemonProcessIsAlive(childPid)).toBe(false);
  },
  10_000,
);

test.skipIf(process.platform !== "linux")(
  "transferred coordinator remains held after the parent process exits",
  async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agent-html-render-lock-transfer-release-"));
    temporaryDirectories.push(rootPath);
    const parent = resolve("tests/fixtures/startup-coordinator-transfer-parent.ts");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", parent, rootPath, "1500"],
      { timeout: 8_000 },
    );
    expect(Number.parseInt(stdout.trim(), 10)).toBeGreaterThan(0);
    expect(await inspectStartupCoordinator(rootPath)).toEqual({ status: "busy" });

    const startedAt = Date.now();
    const release = await acquireStartupLock(rootPath);
    expect(Date.now() - startedAt).toBeGreaterThan(250);
    await release();
  },
  10_000,
);
