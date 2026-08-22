import { createHash, randomBytes } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BridgeConfiguration } from "../shared/protocol.js";

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export interface ResolvedArtifact {
  rootPath: string;
  artifactPath: string;
  artifactRelativePath: string;
}

export async function resolveArtifact(rootInput: string, artifactInput: string): Promise<ResolvedArtifact> {
  const rootPath = await realpath(resolve(rootInput));
  const candidate = resolve(rootPath, artifactInput);
  const artifactPath = await realpath(candidate);
  const artifactRelativePath = relative(rootPath, artifactPath);
  const escapesRoot =
    artifactRelativePath === ".." ||
    artifactRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(artifactRelativePath);
  if (escapesRoot) throw new Error("The artifact must be inside the selected project root.");
  if (extname(artifactPath).toLowerCase() !== ".html") {
    throw new Error("AgentLens only reviews .html artifacts.");
  }
  const details = await stat(artifactPath);
  if (!details.isFile()) throw new Error("The artifact path must point to a file.");
  if (details.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`The artifact exceeds the ${MAX_ARTIFACT_BYTES} byte v1 limit.`);
  }
  return { rootPath, artifactPath, artifactRelativePath };
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readArtifact(artifactPath: string): Promise<{ content: string; hash: string }> {
  const content = await readFile(artifactPath, "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) {
    throw new Error(`The artifact exceeds the ${MAX_ARTIFACT_BYTES} byte v1 limit.`);
  }
  return { content, hash: contentHash(content) };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function metaAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim().toLowerCase();
}

function stripPolicyMeta(html: string): string {
  return html.replace(/<meta\b[^>]*>/gi, (tag) => {
    const httpEquiv = metaAttribute(tag, "http-equiv");
    const name = metaAttribute(tag, "name");
    return httpEquiv === "content-security-policy" || httpEquiv === "refresh" || name === "referrer"
      ? ""
      : tag;
  });
}

export function renderSandboxedArtifact(
  html: string,
  configuration: BridgeConfiguration,
  bridgeSource: string,
): string {
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
    `<script nonce="${nonce}">window.__AGENTLENS_BRIDGE__=${safeJson(configuration)};\n${bridgeSource}\n</script>`,
  ].join("\n");
  const withoutCsp = stripPolicyMeta(html);
  if (/<head(?:\s[^>]*)?>/i.test(withoutCsp)) {
    return withoutCsp.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n${injection}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(withoutCsp)) {
    return withoutCsp.replace(/<html(?:\s[^>]*)?>/i, (root) => `${root}\n<head>${injection}</head>`);
  }
  return `<!doctype html><html><head>${injection}</head><body>${withoutCsp}</body></html>`;
}
