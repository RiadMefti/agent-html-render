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
  const original = createRuntimeBuildIdentity("<html>one</html>", "bridge-one", assets);
  expect(createRuntimeBuildIdentity("<html>one</html>", "bridge-one", assets)).toEqual(original);
  expect(createRuntimeBuildIdentity("<html>two</html>", "bridge-one").buildId).not.toBe(original.buildId);
  expect(createRuntimeBuildIdentity("<html>one</html>", "bridge-two").buildId).not.toBe(original.buildId);
  expect(
    createRuntimeBuildIdentity(
      "<html>one</html>",
      "bridge-one",
      new Map([["index.js", Buffer.from("two")]]),
    ).buildId,
  ).not.toBe(original.buildId);
});
