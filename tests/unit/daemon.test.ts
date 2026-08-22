import { expect, test } from "vitest";
import { inspectDaemonHealth, type DaemonMetadata } from "../../src/node/daemon.js";
import type { RuntimeBuildIdentity } from "../../src/node/build.js";
import { EXPLICIT_FEEDBACK_ACK_CAPABILITY } from "../../src/shared/protocol.js";

const metadata: DaemonMetadata = {
  protocolVersion: "1",
  packageVersion: "0.3.1",
  buildId: "sha256:current",
  pid: 4321,
  rootPath: "/tmp/example-project",
  port: 4040,
  token: "test-token",
  startedAt: "2026-08-22T00:00:00.000Z",
};

const expectedBuild: RuntimeBuildIdentity = {
  packageVersion: "0.3.1",
  buildId: "sha256:current",
};

const compatibleHealth = {
  protocolVersion: "1",
  capabilities: [EXPLICIT_FEEDBACK_ACK_CAPABILITY],
  packageVersion: expectedBuild.packageVersion,
  buildId: expectedBuild.buildId,
  rootPath: metadata.rootPath,
  pid: metadata.pid,
};

test("accepts only the exact running package build", () => {
  expect(inspectDaemonHealth(metadata, compatibleHealth, expectedBuild)).toEqual({
    healthy: true,
    compatible: true,
  });

  expect(
    inspectDaemonHealth(metadata, { ...compatibleHealth, packageVersion: "0.3.0" }, expectedBuild),
  ).toEqual({ healthy: true, compatible: false });

  expect(
    inspectDaemonHealth(metadata, { ...compatibleHealth, buildId: "sha256:stale" }, expectedBuild),
  ).toEqual({ healthy: true, compatible: false });
});

test("replaces healthy legacy daemons that have no build identity", () => {
  const legacyHealth = {
    protocolVersion: "1",
    capabilities: [EXPLICIT_FEEDBACK_ACK_CAPABILITY],
    rootPath: metadata.rootPath,
    pid: metadata.pid,
  };
  expect(inspectDaemonHealth(metadata, legacyHealth, expectedBuild)).toEqual({
    healthy: true,
    compatible: false,
  });
});

test("does not treat an unrelated process as a healthy daemon", () => {
  expect(
    inspectDaemonHealth(metadata, { ...compatibleHealth, pid: metadata.pid + 1 }, expectedBuild),
  ).toEqual({ healthy: false, compatible: false });
  expect(inspectDaemonHealth(metadata, null, expectedBuild)).toEqual({
    healthy: false,
    compatible: false,
  });
});
