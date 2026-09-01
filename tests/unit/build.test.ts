import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createRuntimeBuildIdentity } from "../../src/node/build.js";
import { PACKAGE_VERSION } from "../../src/shared/version.js";

test("keeps the CLI version synchronized with the npm package", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version?: unknown };
  expect(packageJson.version).toBe(PACKAGE_VERSION);
});

test("changes the runtime identity when either served runtime changes", () => {
  const assets = new Map([["index.js", Buffer.from("one")]]);
  const nodeRuntime = new Map([["node/daemon.js", Buffer.from("runtime-one")]]);
  const original = createRuntimeBuildIdentity("<html>one</html>", "bridge-one", assets, nodeRuntime);
  expect(createRuntimeBuildIdentity("<html>one</html>", "bridge-one", assets, nodeRuntime)).toEqual(original);
  expect(createRuntimeBuildIdentity("<html>two</html>", "bridge-one", assets, nodeRuntime).buildId)
    .not.toBe(original.buildId);
  expect(createRuntimeBuildIdentity("<html>one</html>", "bridge-two", assets, nodeRuntime).buildId)
    .not.toBe(original.buildId);
  expect(
    createRuntimeBuildIdentity(
      "<html>one</html>",
      "bridge-one",
      new Map([["index.js", Buffer.from("two")]]),
      nodeRuntime,
    ).buildId,
  ).not.toBe(original.buildId);
  expect(
    createRuntimeBuildIdentity(
      "<html>one</html>",
      "bridge-one",
      assets,
      new Map([["node/daemon.js", Buffer.from("runtime-two")]]),
    ).buildId,
  ).not.toBe(original.buildId);
});
