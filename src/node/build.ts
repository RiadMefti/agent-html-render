import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "../shared/version.js";

const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIRECTORY = dirname(MODULE_PATH);
const SHARED_MODULE_DIRECTORY = resolve(MODULE_DIRECTORY, "../shared");
const RUNTIME_SOURCE_EXTENSION = extname(MODULE_PATH);
export const DEFAULT_UI_DIRECTORY = resolve(MODULE_DIRECTORY, "../ui");
export const DEFAULT_BRIDGE_PATH = resolve(MODULE_DIRECTORY, "../bridge/bridge.js");

export interface RuntimeBuildIdentity {
  packageVersion: string;
  buildId: string;
}

export interface UiRuntimeSnapshot {
  indexHtml: string;
  assets: ReadonlyMap<string, Buffer>;
}

const MAX_UI_ASSET_COUNT = 256;
const MAX_UI_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_NODE_RUNTIME_FILE_COUNT = 128;
const MAX_NODE_RUNTIME_BYTES = 8 * 1024 * 1024;

async function readUiAssets(
  assetsRoot: string,
  directory: string,
  relativeDirectory: string,
  assets: Map<string, Buffer>,
  budget: { bytes: number },
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === assetsRoot) return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await readUiAssets(assetsRoot, absolutePath, relativePath, assets, budget);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported review-shell asset: ${relativePath}`);
    if (assets.size >= MAX_UI_ASSET_COUNT) throw new Error("The review shell contains too many assets.");
    const content = await readFile(absolutePath);
    budget.bytes += content.byteLength;
    if (budget.bytes > MAX_UI_ASSET_BYTES) throw new Error("The review shell assets exceed 16 MB.");
    assets.set(relativePath, content);
  }
}

export async function readUiRuntimeSnapshot(
  uiDirectory = DEFAULT_UI_DIRECTORY,
): Promise<UiRuntimeSnapshot> {
  const assets = new Map<string, Buffer>();
  await readUiAssets(join(uiDirectory, "assets"), join(uiDirectory, "assets"), "", assets, {
    bytes: 0,
  });
  return {
    indexHtml: await readFile(resolve(uiDirectory, "index.html"), "utf8"),
    assets,
  };
}

export async function readNodeRuntimeSnapshot(): Promise<ReadonlyMap<string, Buffer>> {
  const sources = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const [namespace, directory] of [
    ["node", MODULE_DIRECTORY],
    ["shared", SHARED_MODULE_DIRECTORY],
  ] as const) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(RUNTIME_SOURCE_EXTENSION))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (sources.size >= MAX_NODE_RUNTIME_FILE_COUNT) {
        throw new Error("The Node runtime contains too many executable modules.");
      }
      const content = await readFile(join(directory, entry.name));
      totalBytes += content.byteLength;
      if (totalBytes > MAX_NODE_RUNTIME_BYTES) {
        throw new Error("The Node runtime executable modules exceed 8 MB.");
      }
      sources.set(`${namespace}/${entry.name}`, content);
    }
  }
  return sources;
}

export function createRuntimeBuildIdentity(
  uiIndexHtml: string,
  bridgeSource: string,
  uiAssets: ReadonlyMap<string, Buffer> = new Map(),
  nodeRuntimeSources: ReadonlyMap<string, Buffer> = new Map(),
): RuntimeBuildIdentity {
  const hash = createHash("sha256");
  hash.update("agent-html-render-runtime-v2\0");
  for (const [name, value] of [
    ["package-version", PACKAGE_VERSION],
    ["ui-index", uiIndexHtml],
    ["artifact-bridge", bridgeSource],
  ] as const) {
    hash.update(`${name}\0${Buffer.byteLength(value, "utf8")}\0`);
    hash.update(value, "utf8");
  }
  for (const [relativePath, content] of Array.from(uiAssets).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(`ui-asset\0${Buffer.byteLength(relativePath, "utf8")}\0${relativePath}\0${content.byteLength}\0`);
    hash.update(content);
  }
  for (const [relativePath, content] of Array.from(nodeRuntimeSources).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(`node-runtime\0${Buffer.byteLength(relativePath, "utf8")}\0${relativePath}\0${content.byteLength}\0`);
    hash.update(content);
  }
  return {
    packageVersion: PACKAGE_VERSION,
    buildId: `sha256:${hash.digest("hex")}`,
  };
}

export async function readCurrentRuntimeBuildIdentity(): Promise<RuntimeBuildIdentity> {
  const [uiSnapshot, bridgeSource, nodeRuntimeSources] = await Promise.all([
    readUiRuntimeSnapshot(),
    readFile(DEFAULT_BRIDGE_PATH, "utf8"),
    readNodeRuntimeSnapshot(),
  ]);
  return createRuntimeBuildIdentity(
    uiSnapshot.indexHtml,
    bridgeSource,
    uiSnapshot.assets,
    nodeRuntimeSources,
  );
}
