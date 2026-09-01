import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  defaultTreeAdapter,
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterTypes,
} from "parse5";
import type { BridgeConfiguration } from "../shared/protocol.js";

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const ARTIFACT_READ_TIMEOUT_MILLISECONDS = 10_000;

const ARTIFACT_READER_SOURCE = String.raw`
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";

const configuration = JSON.parse(process.argv[1]);
const fail = (message) => {
  process.stderr.write(message);
  process.exitCode = 1;
};

try {
  if (process.platform === "win32") {
    throw new Error("Secure no-follow artifact reads are not available on this platform.");
  }
  const rootReference = configuration.parentDepth === 0
    ? "."
    : Array.from({ length: configuration.parentDepth }, () => "..").join("/");
  const [rootPath, rootDetails, parentPath, parentDetails] = await Promise.all([
    realpath(rootReference),
    stat(rootReference, { bigint: true }),
    realpath("."),
    stat(".", { bigint: true }),
  ]);
  if (
    rootPath !== configuration.rootPath ||
    rootDetails.dev.toString() !== configuration.rootDevice ||
    rootDetails.ino.toString() !== configuration.rootInode
  ) {
    throw new Error("The selected project root changed before the artifact was opened.");
  }
  if (
    parentPath !== configuration.parentPath ||
    parentDetails.dev.toString() !== configuration.parentDevice ||
    parentDetails.ino.toString() !== configuration.parentInode
  ) {
    throw new Error("The artifact parent changed before it could be opened.");
  }

  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const handle = await open(configuration.artifactName, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error("The artifact path must point to a regular file.");
    if (opened.size > BigInt(configuration.maximumBytes)) {
      throw new Error("The artifact exceeds the configured byte limit.");
    }
    const bytes = Buffer.allocUnsafe(configuration.maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > configuration.maximumBytes) throw new Error("The artifact exceeds the configured byte limit.");
    const completed = await handle.stat({ bigint: true });
    if (
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.size !== opened.size ||
      completed.mtimeNs !== opened.mtimeNs ||
      completed.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error("The artifact changed while it was being read.");
    }
    process.stdout.write(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
`;

export interface ResolvedArtifact {
  rootPath: string;
  rootDevice: string;
  rootInode: string;
  parentDevice: string;
  parentInode: string;
  artifactPath: string;
  artifactRelativePath: string;
}

export interface ResolvedRoot {
  rootPath: string;
  rootDevice: string;
  rootInode: string;
}

export interface SandboxedArtifact {
  html: string;
  contentSecurityPolicy: string;
}

function containedRelativePath(rootPath: string, artifactPath: string): string {
  const artifactRelativePath = relative(rootPath, artifactPath);
  const escapesRoot =
    artifactRelativePath === ".." ||
    artifactRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(artifactRelativePath);
  if (escapesRoot) throw new Error("The artifact must be inside the selected project root.");
  return artifactRelativePath;
}

export function validateArtifactPath(rootPath: string, artifactPath: string): string {
  const artifactRelativePath = containedRelativePath(rootPath, artifactPath);
  if (extname(artifactPath).toLowerCase() !== ".html") {
    throw new Error("Agent HTML Render only reviews .html artifacts.");
  }
  return artifactRelativePath;
}

export async function resolveRoot(rootInput: string): Promise<ResolvedRoot> {
  const rootPath = await realpath(resolve(rootInput));
  const details = await stat(rootPath, { bigint: true });
  if (!details.isDirectory()) throw new Error("The selected project root must be a directory.");
  return {
    rootPath,
    rootDevice: details.dev.toString(),
    rootInode: details.ino.toString(),
  };
}

export async function resolveArtifact(rootInput: string, artifactInput: string): Promise<ResolvedArtifact> {
  const root = await resolveRoot(rootInput);
  const { rootPath } = root;
  const candidate = resolve(rootPath, artifactInput);
  const artifactPath = await realpath(candidate);
  const artifactRelativePath = validateArtifactPath(rootPath, artifactPath);
  const [details, parentDetails] = await Promise.all([
    stat(artifactPath),
    stat(dirname(artifactPath), { bigint: true }),
  ]);
  if (!details.isFile()) throw new Error("The artifact path must point to a file.");
  if (!parentDetails.isDirectory()) throw new Error("The artifact parent must be a directory.");
  if (details.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`The artifact exceeds the ${MAX_ARTIFACT_BYTES} byte v1 limit.`);
  }
  return {
    ...root,
    parentDevice: parentDetails.dev.toString(),
    parentInode: parentDetails.ino.toString(),
    artifactPath,
    artifactRelativePath,
  };
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readArtifact(
  artifact: Pick<
    ResolvedArtifact,
    "rootPath" | "rootDevice" | "rootInode" | "parentDevice" | "parentInode" | "artifactPath"
  >,
): Promise<{ content: string; hash: string }> {
  validateArtifactPath(artifact.rootPath, artifact.artifactPath);
  const parentPath = dirname(artifact.artifactPath);
  const parentRelativePath = containedRelativePath(artifact.rootPath, parentPath);
  const parentDepth = parentRelativePath ? parentRelativePath.split(sep).filter(Boolean).length : 0;
  const configuration = JSON.stringify({
    rootPath: artifact.rootPath,
    rootDevice: artifact.rootDevice,
    rootInode: artifact.rootInode,
    parentPath,
    parentDevice: artifact.parentDevice,
    parentInode: artifact.parentInode,
    parentDepth,
    artifactName: basename(artifact.artifactPath),
    maximumBytes: MAX_ARTIFACT_BYTES,
  });
  const bytes = await new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", ARTIFACT_READER_SOURCE, configuration], {
      cwd: parentPath,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputLength = 0;
    let errorLength = 0;
    const timeout = setTimeout(() => child.kill(), ARTIFACT_READ_TIMEOUT_MILLISECONDS);
    child.stdout.on("data", (chunk: Buffer) => {
      outputLength += chunk.length;
      if (outputLength <= MAX_ARTIFACT_BYTES + 1) chunks.push(chunk);
      else child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorLength += chunk.length;
      if (errorLength <= 4_096) errors.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || outputLength > MAX_ARTIFACT_BYTES) {
        const reason = Buffer.concat(errors).toString("utf8").trim();
        reject(new Error(
          `The artifact must remain a regular file inside the selected project root.${reason ? ` ${reason}` : ""}`,
        ));
        return;
      }
      resolvePromise(Buffer.concat(chunks, outputLength));
    });
  });
  const content = bytes.toString("utf8");
  return { content, hash: contentHash(content) };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function isElement(node: DefaultTreeAdapterTypes.ChildNode): node is DefaultTreeAdapterTypes.Element {
  return "tagName" in node;
}

function attribute(element: DefaultTreeAdapterTypes.Element, name: string): string {
  return element.attrs.find((candidate) => candidate.name === name)?.value.trim().toLowerCase() ?? "";
}

function removeArtifactPolicyElements(parent: DefaultTreeAdapterTypes.ParentNode): void {
  for (const child of [...parent.childNodes]) {
    if (isElement(child)) {
      const isBlockedElement =
        child.tagName === "base" ||
        (child.tagName === "meta" &&
          (attribute(child, "http-equiv") === "content-security-policy" ||
            attribute(child, "http-equiv") === "refresh" ||
            attribute(child, "name") === "referrer"));
      if (isBlockedElement) {
        defaultTreeAdapter.detachNode(child);
        continue;
      }
      removeArtifactPolicyElements(child);
      if (child.tagName === "template") {
        removeArtifactPolicyElements((child as DefaultTreeAdapterTypes.Template).content);
      }
    }
  }
}

export function renderSandboxedArtifact(
  html: string,
  configuration: BridgeConfiguration,
  bridgeSource: string,
): SandboxedArtifact {
  const nonce = randomBytes(18).toString("base64url");
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "navigate-to 'none'",
  ].join("; ");
  const injection = [
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="referrer" content="no-referrer">',
    `<script nonce="${nonce}">window.__AGENT_HTML_RENDER_BRIDGE__=${safeJson(configuration)};\n${bridgeSource.replace(/<\/script/giu, "<\\/script")}\n</script>`,
  ].join("\n");
  const document = parse(html);
  removeArtifactPolicyElements(document);
  const htmlElement = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => isElement(node) && node.tagName === "html",
  );
  const head = htmlElement?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => isElement(node) && node.tagName === "head",
  );
  if (!head) throw new Error("Agent HTML Render could not construct an artifact document head.");
  const firstAuthoredNode = head.childNodes[0];
  const injected = parseFragment(head, injection, {});
  for (const node of [...injected.childNodes]) {
    defaultTreeAdapter.detachNode(node);
    if (firstAuthoredNode) defaultTreeAdapter.insertBefore(head, node, firstAuthoredNode);
    else defaultTreeAdapter.appendChild(head, node);
  }
  return { html: serialize(document), contentSecurityPolicy: csp };
}
