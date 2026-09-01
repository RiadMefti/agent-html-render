import type { RangeAnchor, StableAttribute, TargetDescriptor, TextQuote } from "./protocol.js";

export const MAX_TEXT_SELECTION_LENGTH = 1_200;
const MAX_TARGET_TEXT = MAX_TEXT_SELECTION_LENGTH;
const MAX_QUOTE_CONTEXT = 80;
const MAX_STABLE_ID = 300;
const MAX_ROLE = 120;
const MAX_CSS_PATH = 2_000;
const MAX_NODE_PATH = 64;
const MAX_TAG = 80;
const MAX_LABEL = 200;
const MAX_LABEL_REFERENCES = 32;
const MAX_LABEL_SCAN_PER_REFERENCE = 512;
const MAX_COMPLETE_LABEL_REFERENCES = 64;
const MAX_SEMANTIC_ATTRIBUTE_LENGTH = 16_384;
const MAX_IDENTITY_CANDIDATE_CHECKS = 2_000;
const MAX_CAPTURE_IDENTITY_TEXT_UNITS = 6 * 1024 * 1024;
const MAX_BATCH_IDENTITY_TEXT_UNITS = 6 * 1024 * 1024;
const MAX_QUOTE_WORK_UNITS = 12 * 1024 * 1024;
const MAX_QUOTE_MATCHES = 100_000;
const MAX_HEADING_ELEMENT_CHECKS = 100_000;
const MAX_HEADING_TEXT_UNITS = 2 * 1024 * 1024;
const MAX_HEADING_LABEL = 160;
const MAX_CAPTURE_NODE_CHECKS = 100_000;
const MAX_CAPTURE_TEXT_UNITS = 6 * 1024 * 1024;
const MAX_SELECTOR_NODE_CHECKS = 1_000_000;
const REVIEW_DATA_ATTRIBUTES = [
  "data-agent-html-render-id",
  "data-agentrender-id",
  "data-agentlens-id",
] as const;

type ReviewDataAttribute = (typeof REVIEW_DATA_ATTRIBUTES)[number];

function reviewDataAttribute(element: Element): ReviewDataAttribute | undefined {
  return REVIEW_DATA_ATTRIBUTES.find((attribute) => element.hasAttribute(attribute));
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function boundedMiddle(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return "…".slice(0, maximum);
  const headLength = Math.ceil((maximum - 1) / 2);
  const tailLength = maximum - 1 - headLength;
  return `${value.slice(0, headLength)}…${tailLength > 0 ? value.slice(-tailLength) : ""}`;
}

function boundedLabel(parts: readonly string[]): string | undefined {
  const normalizedParts = parts.map((part) => normalizedText(part)).filter(Boolean);
  if (normalizedParts.length === 0) return undefined;
  const joined = normalizedParts.join(" ");
  if (joined.length <= MAX_LABEL) return joined;
  const contentBudget = MAX_LABEL - (normalizedParts.length - 1);
  const base = Math.floor(contentBudget / normalizedParts.length);
  let remainder = contentBudget % normalizedParts.length;
  return normalizedParts.map((part) => {
    const allocation = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return boundedMiddle(part, allocation);
  }).join(" ");
}

// A synchronous SHA-256 keeps target capture and resolution deterministic in the
// sandboxed bridge without depending on a host runtime or an asynchronous Web Crypto
// call. The digest is identity evidence, never rendered as reviewer-facing text.
function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, low, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const words = new Uint32Array(64);
  const rotateRight = (input: number, amount: number): number =>
    (input >>> amount) | (input << (32 - amount));

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0;
      const previous2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }
    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

function semanticDigest(source: string, values: readonly string[]): string {
  // JSON length/escaping makes boundaries unambiguous even when artifact text contains
  // control characters. Every value is normalized before hashing, but never persisted.
  return `a11y-v1:${sha256(JSON.stringify([source, ...values.map((value) => normalizedText(value))]))}`;
}

function completeTextSignature(value: string): string {
  return `text-v1:${sha256(JSON.stringify(["element-text", normalizedText(value)]))}`;
}

export function normalizedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

interface NormalizedTextScanBudget {
  remaining: number;
  remainingNodes?: number;
}

function boundedNormalizedTextContent(
  element: Element,
  maximum: number,
  scanBudget?: NormalizedTextScanBudget,
): string {
  const limit = maximum + 1;
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let output = "";
  let pendingSpace = false;
  let current = walker.nextNode();
  while (current && output.length < limit) {
    if (scanBudget?.remainingNodes !== undefined) {
      if (scanBudget.remainingNodes <= 0) return bounded(output, maximum);
      scanBudget.remainingNodes -= 1;
    }
    const value = current.nodeValue ?? "";
    for (let index = 0; index < value.length && output.length < limit; index += 1) {
      if (scanBudget) {
        if (scanBudget.remaining <= 0) return bounded(output, maximum);
        scanBudget.remaining -= 1;
      }
      const character = value[index] ?? "";
      if (/\s/u.test(character)) {
        if (output) pendingSpace = true;
        continue;
      }
      if (pendingSpace && output.length < limit) output += " ";
      pendingSpace = false;
      if (output.length < limit) output += character;
    }
    current = walker.nextNode();
  }
  return bounded(output, maximum);
}

function escapeCss(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return Array.from(value, (character, index) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const firstCodePoint = value.codePointAt(0) ?? 0;
    const control = (codePoint >= 0x1 && codePoint <= 0x1f) || codePoint === 0x7f;
    const leadingDigit = index === 0 && codePoint >= 0x30 && codePoint <= 0x39;
    const secondDigitAfterHyphen =
      index === 1 && firstCodePoint === 0x2d && codePoint >= 0x30 && codePoint <= 0x39;
    if (codePoint === 0) return "�";
    if (control || leadingDigit || secondDigitAfterHyphen) return `\\${codePoint.toString(16)} `;
    if (index === 0 && codePoint === 0x2d && value.length === 1) return "\\-";
    if (
      codePoint >= 0x80 ||
      codePoint === 0x2d ||
      codePoint === 0x5f ||
      (codePoint >= 0x30 && codePoint <= 0x39) ||
      (codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x61 && codePoint <= 0x7a)
    ) {
      return character;
    }
    return `\\${character}`;
  }).join("");
}

interface CaptureAttributeIndexes {
  ariaLabel: Map<string, Element | null>;
  ariaLabelledBy: Map<string, Element | null>;
}

function addUniqueAttributeValue(index: Map<string, Element | null>, value: string, element: Element): void {
  if (index.has(value)) index.set(value, null);
  else index.set(value, element);
}

function captureAttributeIndexes(
  document: Document,
  context: TargetResolutionContext,
): CaptureAttributeIndexes | null {
  const cached = context.semanticCache.captureAttributeIndexes;
  if (cached.has(document)) return cached.get(document) ?? null;
  const root = document.documentElement;
  const indexes: CaptureAttributeIndexes = {
    ariaLabel: new Map(),
    ariaLabelledBy: new Map(),
  };
  if (!root) {
    cached.set(document, indexes);
    return indexes;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let current: Node | null = root;
  while (current) {
    if (context.remainingCaptureNodeChecks <= 0) {
      cached.set(document, null);
      return null;
    }
    context.remainingCaptureNodeChecks -= 1;
    const element = current as Element;
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy && labelledBy.length <= MAX_CSS_PATH) {
      addUniqueAttributeValue(indexes.ariaLabelledBy, labelledBy, element);
    }
    const label = element.getAttribute("aria-label");
    if (label && label.length <= MAX_CSS_PATH) {
      addUniqueAttributeValue(indexes.ariaLabel, label, element);
    }
    current = walker.nextNode();
  }
  cached.set(document, indexes);
  return indexes;
}

function consumeCaptureNodeChecks(context: TargetResolutionContext, amount: number): boolean {
  if (amount > context.remainingCaptureNodeChecks) {
    context.remainingCaptureNodeChecks = 0;
    return false;
  }
  context.remainingCaptureNodeChecks -= amount;
  return true;
}

export function nodePath(
  node: Node,
  root: Node,
  context: TargetResolutionContext = createTargetResolutionContext(),
): number[] {
  const path: number[] = [];
  let current: Node | null = node;

  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) return [];
    if (!consumeCaptureNodeChecks(context, parent.childNodes.length)) return [];
    const index = Array.prototype.indexOf.call(parent.childNodes, current) as number;
    if (index < 0) return [];
    path.unshift(index);
    if (path.length > MAX_NODE_PATH) return [];
    current = parent;
  }

  return current === root ? path : [];
}

export function resolveNodePath(root: Node, path: readonly number[]): Node | null {
  let current: Node = root;
  for (const index of path) {
    const next = current.childNodes.item(index);
    if (!next) return null;
    current = next;
  }
  return current;
}

export function cssPathForElement(
  element: Element,
  context: TargetResolutionContext = createTargetResolutionContext(),
): string {
  const explicitAttribute = reviewDataAttribute(element);
  const explicitId = explicitAttribute ? element.getAttribute(explicitAttribute) : null;
  if (explicitAttribute && explicitId && explicitId.length <= MAX_STABLE_ID) {
    return bounded(`[${explicitAttribute}="${escapeCss(explicitId)}"]`, MAX_CSS_PATH);
  }
  if (element.id && element.id.length <= MAX_STABLE_ID) return bounded(`#${escapeCss(element.id)}`, MAX_CSS_PATH);
  const attributeIndexes = captureAttributeIndexes(element.ownerDocument, context);
  for (const attribute of ["aria-labelledby", "aria-label"] as const) {
    const value = element.getAttribute(attribute);
    if (!value || value.length > MAX_CSS_PATH) continue;
    const selector = `[${attribute}="${escapeCss(value)}"]`;
    if (selector.length > MAX_CSS_PATH) continue;
    const index = attribute === "aria-labelledby"
      ? attributeIndexes?.ariaLabelledBy
      : attributeIndexes?.ariaLabel;
    if (index?.get(value) === element) return selector;
  }

  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current.tagName.toLowerCase() !== "html") {
    const ancestorAttribute = reviewDataAttribute(current);
    const ancestorId = ancestorAttribute ? current.getAttribute(ancestorAttribute) : null;
    if (current !== element && ancestorAttribute && ancestorId && ancestorId.length <= MAX_STABLE_ID) {
      segments.unshift(`[${ancestorAttribute}="${escapeCss(ancestorId)}"]`);
      break;
    }
    if (current !== element && current.id && current.id.length <= MAX_STABLE_ID) {
      segments.unshift(`#${escapeCss(current.id)}`);
      break;
    }
    const tag = bounded(current.tagName.toLowerCase(), MAX_TAG);
    const parent: Element | null = current.parentElement;
    if (!parent) {
      segments.unshift(tag);
      break;
    }

    if (!consumeCaptureNodeChecks(context, parent.children.length)) return "";
    let sameTagCount = 0;
    let position = 0;
    for (let index = 0; index < parent.children.length; index += 1) {
      const sibling = parent.children.item(index);
      if (sibling?.tagName !== current.tagName) continue;
      sameTagCount += 1;
      if (sibling === current) position = sameTagCount;
    }
    if (sameTagCount > 1) {
      segments.unshift(`${tag}:nth-of-type(${position})`);
    } else {
      segments.unshift(tag);
    }
    current = parent;
    if (tag === "body") break;
    if (segments.join(" > ").length > MAX_CSS_PATH) return "";
  }
  const path = segments.join(" > ");
  return path.length <= MAX_CSS_PATH ? path : "";
}

function implicitRole(element: Element): string | undefined {
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "img") return "img";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "form") return "form";
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    return "textbox";
  }
  return undefined;
}

interface CompleteSemanticLabelIdentity {
  complete: true;
  label?: string;
  signature: string;
}

interface UnresolvableSemanticLabelIdentity {
  complete: false;
  label?: string;
}

type SemanticLabelIdentity = CompleteSemanticLabelIdentity | UnresolvableSemanticLabelIdentity;

interface MappedText {
  text: string;
  entries: TextMapEntry[];
  entryByNode: WeakMap<Text, TextMapEntry>;
}

interface QuoteOffsets {
  start: number;
  end: number;
}

type IdentityMode = "semantic" | "text" | "legacy-label" | "legacy-text";
type IdentityIndex = Map<string, Element | null>;

interface IdentityCandidateGroup {
  candidates: readonly Element[];
  indexes: Map<IdentityMode, IdentityIndex | null>;
}

interface HeadingEntry {
  order: number;
  path: readonly string[];
}

interface HeadingIndex {
  elementOrders: WeakMap<Element, number>;
  entries: readonly HeadingEntry[];
}

interface StableSelectorIndexState {
  index: Map<string, Element | null>;
  walker: TreeWalker;
  current: Node | null;
  complete: boolean;
  failed: boolean;
}

interface SemanticIdentityCache {
  labels: WeakMap<Element, SemanticLabelIdentity | null>;
  referencedTextDigests: WeakMap<Element, string>;
  elementTexts: WeakMap<Element, string>;
  elementTextSignatures: WeakMap<Element, string>;
  identityIndexes: WeakMap<Element, Map<string, IdentityCandidateGroup | null>>;
  headingIndexes: WeakMap<Document, HeadingIndex | null>;
  captureAttributeIndexes: WeakMap<Document, CaptureAttributeIndexes | null>;
  stableSelectorIndexes: WeakMap<Element, StableSelectorIndexState>;
  selectorMatches: WeakMap<Element, Map<string, Element | null>>;
  textMaps: WeakMap<Node, MappedText>;
  quoteMatches: WeakMap<Node, Map<string, QuoteOffsets | null>>;
}

interface IdentityTextBudget {
  remainingIdentityTextUnits: number;
}

function createSemanticIdentityCache(): SemanticIdentityCache {
  return {
    labels: new WeakMap<Element, SemanticLabelIdentity | null>(),
    referencedTextDigests: new WeakMap<Element, string>(),
    elementTexts: new WeakMap<Element, string>(),
    elementTextSignatures: new WeakMap<Element, string>(),
    identityIndexes: new WeakMap<Element, Map<string, IdentityCandidateGroup | null>>(),
    headingIndexes: new WeakMap<Document, HeadingIndex | null>(),
    captureAttributeIndexes: new WeakMap<Document, CaptureAttributeIndexes | null>(),
    stableSelectorIndexes: new WeakMap<Element, StableSelectorIndexState>(),
    selectorMatches: new WeakMap<Element, Map<string, Element | null>>(),
    textMaps: new WeakMap<Node, MappedText>(),
    quoteMatches: new WeakMap<Node, Map<string, QuoteOffsets | null>>(),
  };
}

function completeElementText(
  element: Element,
  budget: IdentityTextBudget,
  cache?: SemanticIdentityCache,
): string | undefined {
  if (cache?.elementTexts.has(element)) return cache.elementTexts.get(element);
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const chunks: string[] = [];
  let current = walker.nextNode();
  while (current) {
    const value = current.nodeValue ?? "";
    const cost = value.length + 1;
    if (cost > budget.remainingIdentityTextUnits) return undefined;
    budget.remainingIdentityTextUnits -= cost;
    chunks.push(value);
    current = walker.nextNode();
  }
  const complete = chunks.join("");
  cache?.elementTexts.set(element, complete);
  return complete;
}

function referencedTextDigest(
  element: Element,
  cache: SemanticIdentityCache,
  budget: IdentityTextBudget,
): string | undefined {
  const cached = cache.referencedTextDigests.get(element);
  if (cached) return cached;
  const source = completeElementText(element, budget, cache);
  if (source === undefined) return undefined;
  const digest = semanticDigest("referenced-label-text", [source]);
  cache.referencedTextDigests.set(element, digest);
  return digest;
}

function textSignatureForElement(
  element: Element,
  cache: SemanticIdentityCache,
  budget: IdentityTextBudget,
): string | undefined {
  const cached = cache.elementTextSignatures.get(element);
  if (cached) return cached;
  const source = completeElementText(element, budget, cache);
  if (source === undefined) return undefined;
  const signature = completeTextSignature(source);
  cache.elementTextSignatures.set(element, signature);
  return signature;
}

interface SemanticLabelSource {
  kind: string;
  label?: string;
  signature: string;
}

function labelIdentityForElement(
  element: Element,
  cache: SemanticIdentityCache = createSemanticIdentityCache(),
  budget: IdentityTextBudget = { remainingIdentityTextUnits: MAX_CAPTURE_IDENTITY_TEXT_UNITS },
): SemanticLabelIdentity | undefined {
  if (cache.labels.has(element)) return cache.labels.get(element) ?? undefined;
  const remember = (identity: SemanticLabelIdentity | undefined): SemanticLabelIdentity | undefined => {
    cache.labels.set(element, identity ?? null);
    return identity;
  };
  const sources: SemanticLabelSource[] = [];
  const unresolved = (label?: string): SemanticLabelIdentity => remember({
    complete: false,
    ...(label ? { label } : {}),
  }) as SemanticLabelIdentity;
  const consumeAttribute = (value: string): boolean => {
    if (
      value.length > MAX_SEMANTIC_ATTRIBUTE_LENGTH ||
      value.length > budget.remainingIdentityTextUnits
    ) return false;
    budget.remainingIdentityTextUnits -= value.length;
    return true;
  };
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    if (!consumeAttribute(labelledBy)) return unresolved();
    const document = element.ownerDocument;
    const referencedText = new Map<string, { referenced?: Element; digest: string }>();
    const displayParts: string[] = [];
    const signatureParts: string[] = [];
    let referenceCount = 0;
    for (const match of labelledBy.matchAll(/\S+/gu)) {
      referenceCount += 1;
      if (referenceCount > MAX_COMPLETE_LABEL_REFERENCES) return unresolved(boundedLabel(displayParts));
      const id = match[0];
      if (referencedText.has(id)) continue;
      const referenced = document.getElementById(id) ?? undefined;
      const digest = referenced
        ? referencedTextDigest(referenced, cache, budget)
        : semanticDigest("missing-label-reference", [id]);
      if (digest === undefined) return unresolved(boundedLabel(displayParts));
      referencedText.set(id, { ...(referenced ? { referenced } : {}), digest });
      signatureParts.push(id, digest);
      if (referenced && displayParts.length < MAX_LABEL_REFERENCES) {
        const display = boundedNormalizedTextContent(
          referenced,
          MAX_LABEL_SCAN_PER_REFERENCE,
          {
            remaining: MAX_LABEL_SCAN_PER_REFERENCE,
            remainingNodes: MAX_LABEL_SCAN_PER_REFERENCE,
          },
        );
        if (display) displayParts.push(display);
      }
    }
    const label = boundedLabel(displayParts);
    sources.push({
      kind: "aria-labelledby",
      ...(label ? { label } : {}),
      signature: semanticDigest("aria-labelledby", [labelledBy, ...signatureParts]),
    });
  }

  const addAttributeSource = (kind: string, attribute: string): boolean => {
    if (!element.hasAttribute(attribute)) return true;
    const value = element.getAttribute(attribute) ?? "";
    if (!consumeAttribute(value)) return false;
    const label = boundedLabel([value]);
    sources.push({
      kind,
      ...(label ? { label } : {}),
      signature: semanticDigest(kind, [value]),
    });
    return true;
  };
  if (!addAttributeSource("aria-label", "aria-label")) return unresolved(sources.find((source) => source.label)?.label);
  if (!addAttributeSource("alt", "alt")) return unresolved(sources.find((source) => source.label)?.label);

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const labels = element.labels;
    if (labels && labels.length > 0) {
      if (labels.length > MAX_COMPLETE_LABEL_REFERENCES) {
        return unresolved(sources.find((source) => source.label)?.label);
      }
      const completeParts: string[] = [];
      const displayParts: string[] = [];
      for (let index = 0; index < labels.length; index += 1) {
        const item = labels.item(index);
        if (!item) continue;
        const digest = referencedTextDigest(item, cache, budget);
        if (digest === undefined) return unresolved(sources.find((source) => source.label)?.label);
        completeParts.push(digest);
        if (displayParts.length < MAX_LABEL_REFERENCES) {
          const display = boundedNormalizedTextContent(item, MAX_LABEL_SCAN_PER_REFERENCE, {
            remaining: MAX_LABEL_SCAN_PER_REFERENCE,
            remainingNodes: MAX_LABEL_SCAN_PER_REFERENCE,
          });
          if (display) displayParts.push(display);
        }
      }
      const label = boundedLabel(displayParts);
      sources.push({
        kind: "associated-labels",
        ...(label ? { label } : {}),
        signature: semanticDigest("associated-labels", completeParts),
      });
    }
  }

  if (!addAttributeSource("title", "title")) return unresolved(sources.find((source) => source.label)?.label);
  if (sources.length === 0) return remember(undefined);
  const winner = sources.find((source) => source.label);
  return remember({
    complete: true,
    ...(winner?.label ? { label: winner.label } : {}),
    signature: semanticDigest(
      "accessible-name",
      sources.flatMap((source) => [source.kind, source.signature]),
    ),
  });
}

interface HeadingWorkBudget {
  remainingHeadingElementChecks: number;
  remainingHeadingTextUnits: number;
}

function buildHeadingIndex(
  document: Document,
  budget: HeadingWorkBudget,
  headingLabelForElement?: (element: Element) => string | undefined,
): HeadingIndex | null {
  const root = document.documentElement;
  if (!root) return { elementOrders: new WeakMap(), entries: [] };
  const elementOrders = new WeakMap<Element, number>();
  const entries: HeadingEntry[] = [];
  const stack: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let current: Node | null = root;
  let order = 0;
  while (current) {
    if (budget.remainingHeadingElementChecks <= 0) return null;
    budget.remainingHeadingElementChecks -= 1;
    const element = current as Element;
    elementOrders.set(element, order);
    if (/^H[1-6]$/u.test(element.tagName)) {
      if (budget.remainingHeadingTextUnits <= 0) return null;
      let label: string;
      if (headingLabelForElement) {
        const supplied = headingLabelForElement(element);
        if (supplied === undefined) {
          order += 1;
          current = walker.nextNode();
          continue;
        }
        label = bounded(normalizedText(supplied), MAX_HEADING_LABEL);
        const cost = label.length + 1;
        if (cost > budget.remainingHeadingTextUnits) return null;
        budget.remainingHeadingTextUnits -= cost;
      } else {
        const scanBudget: NormalizedTextScanBudget = {
          remaining: budget.remainingHeadingTextUnits,
          remainingNodes: budget.remainingHeadingElementChecks,
        };
        label = boundedNormalizedTextContent(element, MAX_HEADING_LABEL, scanBudget);
        budget.remainingHeadingTextUnits = scanBudget.remaining;
        budget.remainingHeadingElementChecks = scanBudget.remainingNodes ?? 0;
        if (budget.remainingHeadingTextUnits <= 0) return null;
      }
      const level = Number.parseInt(element.tagName.slice(1), 10);
      stack.length = Math.max(0, level - 1);
      stack[level - 1] = label;
      stack.length = level;
      entries.push({ order, path: stack.filter(Boolean) });
    }
    order += 1;
    current = walker.nextNode();
  }
  return { elementOrders, entries };
}

export function headingPathForElement(
  element: Element,
  context?: TargetResolutionContext,
): string[] {
  const document = element.ownerDocument;
  const cache = context?.semanticCache.headingIndexes ?? new WeakMap<Document, HeadingIndex | null>();
  if (!cache.has(document)) {
    const budget: HeadingWorkBudget = context ?? {
      remainingHeadingElementChecks: MAX_HEADING_ELEMENT_CHECKS,
      remainingHeadingTextUnits: MAX_HEADING_TEXT_UNITS,
    };
    cache.set(document, buildHeadingIndex(document, budget, context?.headingLabelForElement));
  }
  const index = cache.get(document);
  const elementOrder = index?.elementOrders.get(element);
  if (!index || elementOrder === undefined || index.entries.length === 0) return [];
  let low = 0;
  let high = index.entries.length - 1;
  let match: HeadingEntry | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = index.entries[middle];
    if (!entry) break;
    if (entry.order <= elementOrder) {
      match = entry;
      low = middle + 1;
    } else high = middle - 1;
  }
  return match ? [...match.path] : [];
}

function boundedCaptureText(
  element: Element,
  maximum: number,
  context: TargetResolutionContext,
): string {
  const budget: NormalizedTextScanBudget = {
    remaining: context.remainingCaptureTextUnits,
    remainingNodes: context.remainingCaptureNodeChecks,
  };
  const result = boundedNormalizedTextContent(element, maximum, budget);
  context.remainingCaptureTextUnits = budget.remaining;
  context.remainingCaptureNodeChecks = budget.remainingNodes ?? 0;
  return result;
}

function completeBoundedTextContent(
  element: Element,
  maximum: number,
  context: TargetResolutionContext,
): string | undefined {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const chunks: string[] = [];
  const rawLimit = maximum + 1;
  let rawLength = 0;
  let current = walker.nextNode();
  while (current) {
    if (!consumeCaptureNodeChecks(context, 1)) return undefined;
    const value = current.nodeValue ?? "";
    const remainingRaw = rawLimit - rawLength;
    const inspected = Math.min(value.length + 1, remainingRaw + 1);
    if (inspected > context.remainingCaptureTextUnits) {
      context.remainingCaptureTextUnits = 0;
      return undefined;
    }
    context.remainingCaptureTextUnits -= inspected;
    if (value.length > remainingRaw) return undefined;
    chunks.push(value);
    rawLength += value.length;
    current = walker.nextNode();
  }
  const complete = chunks.join("").trim();
  return complete.length <= maximum ? complete : undefined;
}

function elementTextQuote(element: Element, context: TargetResolutionContext): TextQuote | undefined {
  const exact = completeBoundedTextContent(element, MAX_TARGET_TEXT, context);
  if (!exact) return undefined;
  const prefix = element.previousElementSibling
    ? completeBoundedTextContent(element.previousElementSibling, MAX_QUOTE_CONTEXT, context) ?? ""
    : "";
  const suffix = element.nextElementSibling
    ? completeBoundedTextContent(element.nextElementSibling, MAX_QUOTE_CONTEXT, context) ?? ""
    : "";
  return { exact, prefix, suffix };
}

function commonElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

export function textQuoteForRange(
  range: Range,
  root: Node,
  context?: TargetResolutionContext,
): TextQuote {
  const exact = range.toString();
  if (exact.length > MAX_TEXT_SELECTION_LENGTH) {
    throw new Error(`Text selections are limited to ${MAX_TEXT_SELECTION_LENGTH} characters.`);
  }
  if (context) {
    const mapped = mappedText(root, context);
    const offsets = mapped ? mappedRangeOffsets(range, mapped) : undefined;
    return offsets && mapped
      ? {
          exact,
          prefix: mapped.text.slice(Math.max(0, offsets.start - MAX_QUOTE_CONTEXT), offsets.start),
          suffix: mapped.text.slice(offsets.end, offsets.end + MAX_QUOTE_CONTEXT),
        }
      : { exact, prefix: "", suffix: "" };
  }
  const document = range.startContainer.ownerDocument ?? root.ownerDocument ?? (root as Document);
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);
  return {
    exact,
    prefix: before.toString().slice(-MAX_QUOTE_CONTEXT),
    suffix: after.toString().slice(0, MAX_QUOTE_CONTEXT),
  };
}

export function targetFromElement(
  element: Element,
  root: Element,
  context?: TargetResolutionContext,
): TargetDescriptor {
  const captureContext = context ?? createTargetResolutionContext();
  const stableAttribute: StableAttribute | undefined = reviewDataAttribute(element) ?? (element.id ? "id" : undefined);
  const stableIdValue = stableAttribute ? element.getAttribute(stableAttribute) ?? undefined : undefined;
  const stableId = stableIdValue && stableIdValue.length <= MAX_STABLE_ID ? stableIdValue : undefined;
  const roleValue = element.getAttribute("role") ?? implicitRole(element);
  const role = roleValue ? bounded(roleValue, MAX_ROLE) : undefined;
  const semanticCache = captureContext.semanticCache;
  const labelIdentity = labelIdentityForElement(element, semanticCache, captureContext);
  const text = boundedCaptureText(element, MAX_TARGET_TEXT, captureContext);
  const descriptor: TargetDescriptor = {
    kind: "element",
    tag: bounded(element.tagName.toLowerCase(), MAX_TAG),
    cssPath: cssPathForElement(element, captureContext),
    domPath: nodePath(element, root, captureContext),
    text,
    headingPath: headingPathForElement(element, captureContext),
  };
  if (role) descriptor.role = role;
  if (labelIdentity?.label) descriptor.label = labelIdentity.label;
  if (labelIdentity?.complete) descriptor.semanticSignature = labelIdentity.signature;
  if (labelIdentity && !labelIdentity.complete) descriptor.identityUnresolvable = true;
  if (!labelIdentity) {
    const textSignature = textSignatureForElement(element, semanticCache, captureContext);
    if (textSignature) descriptor.textSignature = textSignature;
    else descriptor.identityUnresolvable = true;
  }
  if (stableId) descriptor.stableId = stableId;
  if (stableAttribute && stableId) descriptor.stableAttribute = stableAttribute;
  const textQuote = elementTextQuote(element, captureContext);
  if (textQuote) descriptor.textQuote = textQuote;
  return descriptor;
}

export function targetFromRange(
  range: Range,
  root: Element,
  context?: TargetResolutionContext,
): TargetDescriptor {
  const captureContext = context ?? createTargetResolutionContext();
  const selectedText = range.toString();
  if (selectedText.length > MAX_TEXT_SELECTION_LENGTH) {
    throw new Error(`Text selections are limited to ${MAX_TEXT_SELECTION_LENGTH} characters.`);
  }
  const element = commonElement(range.commonAncestorContainer) ?? root;
  const base = targetFromElement(element, root, captureContext);
  const rangeAnchor: RangeAnchor = {
    startPath: nodePath(range.startContainer, root, captureContext),
    startOffset: range.startOffset,
    endPath: nodePath(range.endContainer, root, captureContext),
    endOffset: range.endOffset,
  };
  return {
    ...base,
    kind: "text",
    text: bounded(selectedText, MAX_TARGET_TEXT),
    textQuote: textQuoteForRange(range, root, captureContext),
    range: rangeAnchor,
  };
}

interface TextMapEntry {
  node: Text;
  start: number;
  end: number;
}

function mappedText(root: Node, context: TargetResolutionContext): MappedText | null {
  const cached = context.semanticCache.textMaps.get(root);
  if (cached) return cached;
  const document = root.ownerDocument ?? (root as Document);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const entries: TextMapEntry[] = [];
  const entryByNode = new WeakMap<Text, TextMapEntry>();
  const chunks: string[] = [];
  let offset = 0;
  let current = walker.nextNode();
  while (current) {
    const value = current.nodeValue ?? "";
    const cost = value.length + 1;
    if (cost > context.remainingQuoteWorkUnits) return null;
    context.remainingQuoteWorkUnits -= cost;
    const start = offset;
    offset += value.length;
    chunks.push(value);
    const entry = { node: current as Text, start, end: offset };
    entries.push(entry);
    entryByNode.set(entry.node, entry);
    current = walker.nextNode();
  }
  const mapped = { text: chunks.join(""), entries, entryByNode };
  context.semanticCache.textMaps.set(root, mapped);
  return mapped;
}

function rangeAtOffsets(root: Node, start: number, end: number, entries: TextMapEntry[]): Range | null {
  const locateStart = (): TextMapEntry | undefined => {
    let low = 0;
    let high = entries.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const entry = entries[middle];
      if (!entry) return undefined;
      if (start < entry.start) high = middle - 1;
      else if (start >= entry.end) low = middle + 1;
      else return entry;
    }
    return undefined;
  };
  const locateEnd = (): TextMapEntry | undefined => {
    let low = 0;
    let high = entries.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const entry = entries[middle];
      if (!entry) return undefined;
      if (end <= entry.start) high = middle - 1;
      else if (end > entry.end) low = middle + 1;
      else return entry;
    }
    return undefined;
  };
  const startEntry = locateStart();
  const endEntry = locateEnd();
  if (!startEntry || !endEntry) return null;
  const range = (root.ownerDocument ?? (root as Document)).createRange();
  range.setStart(startEntry.node, Math.min(start - startEntry.start, startEntry.node.length));
  range.setEnd(endEntry.node, Math.min(end - endEntry.start, endEntry.node.length));
  return range;
}

export function findTextQuote(
  root: Node,
  quote: TextQuote,
  context: TargetResolutionContext = createTargetResolutionContext(),
): Range | null {
  if (!quote.exact) return null;
  let matches = context.semanticCache.quoteMatches.get(root);
  if (!matches) {
    matches = new Map<string, QuoteOffsets | null>();
    context.semanticCache.quoteMatches.set(root, matches);
  }
  const quoteKey = JSON.stringify([quote.exact, quote.prefix, quote.suffix]);
  if (matches.has(quoteKey)) {
    const cached = matches.get(quoteKey);
    return cached ? rangeAtOffsets(root, cached.start, cached.end, context.semanticCache.textMaps.get(root)?.entries ?? []) : null;
  }
  const mapped = mappedText(root, context);
  if (!mapped || mapped.text.length > context.remainingQuoteWorkUnits) {
    matches.set(quoteKey, null);
    return null;
  }
  const { text, entries } = mapped;
  context.remainingQuoteWorkUnits -= text.length;
  let position = text.indexOf(quote.exact);
  let bestStart: number | undefined;
  let bestScore = -1;
  let bestCount = 0;
  while (position >= 0) {
    if (context.remainingQuoteMatches <= 0) {
      matches.set(quoteKey, null);
      return null;
    }
    context.remainingQuoteMatches -= 1;
    const prefix = text.slice(Math.max(0, position - quote.prefix.length), position);
    const suffixStart = position + quote.exact.length;
    const suffix = text.slice(suffixStart, suffixStart + quote.suffix.length);
    const score = (quote.prefix && prefix.endsWith(quote.prefix) ? 1 : 0) +
      (quote.suffix && suffix.startsWith(quote.suffix) ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestStart = position;
      bestCount = 1;
    } else if (score === bestScore) {
      bestCount += 1;
    }
    position = text.indexOf(quote.exact, position + 1);
  }
  if (bestStart === undefined || bestCount !== 1) {
    matches.set(quoteKey, null);
    return null;
  }
  const offsets = { start: bestStart, end: bestStart + quote.exact.length };
  matches.set(quoteKey, offsets);
  return rangeAtOffsets(root, offsets.start, offsets.end, entries);
}

export interface ResolvedTarget {
  element: Element;
  range?: Range;
  strategy: "stable-id" | "range-path" | "text-quote" | "css-path" | "identity" | "dom-path";
}

function rangeFromAnchor(root: Element, anchor: RangeAnchor): Range | null {
  const start = resolveNodePath(root, anchor.startPath);
  const end = resolveNodePath(root, anchor.endPath);
  if (!start || !end) return null;
  const startLength = start.nodeType === Node.TEXT_NODE ? (start.nodeValue ?? "").length : start.childNodes.length;
  const endLength = end.nodeType === Node.TEXT_NODE ? (end.nodeValue ?? "").length : end.childNodes.length;
  if (anchor.startOffset > startLength || anchor.endOffset > endLength) return null;
  try {
    const range = root.ownerDocument.createRange();
    range.setStart(start, anchor.startOffset);
    range.setEnd(end, anchor.endOffset);
    return range;
  } catch {
    return null;
  }
}

function mappedRangeOffsets(range: Range, mapped: MappedText): QuoteOffsets | undefined {
  if (!(range.startContainer instanceof Text) || !(range.endContainer instanceof Text)) return undefined;
  const startEntry = mapped.entryByNode.get(range.startContainer);
  const endEntry = mapped.entryByNode.get(range.endContainer);
  if (!startEntry || !endEntry) return undefined;
  const start = startEntry.start + range.startOffset;
  const end = endEntry.start + range.endOffset;
  return start >= 0 && end >= start && end <= mapped.text.length ? { start, end } : undefined;
}

function sameSelectedText(
  range: Range,
  root: Element,
  target: TargetDescriptor,
  context: TargetResolutionContext,
): boolean {
  const expected = normalizedText(target.textQuote?.exact ?? target.text);
  const mapped = mappedText(root, context);
  const offsets = mapped ? mappedRangeOffsets(range, mapped) : undefined;
  if (!expected || !mapped || !offsets || offsets.end - offsets.start > MAX_TEXT_SELECTION_LENGTH) return false;
  return normalizedText(mapped.text.slice(offsets.start, offsets.end)) === expected;
}

function matchesQuoteContext(
  range: Range,
  root: Element,
  quote: TextQuote | undefined,
  context: TargetResolutionContext,
): boolean {
  if (!quote) return true;
  const mapped = mappedText(root, context);
  if (!mapped) return false;
  const offsets = mappedRangeOffsets(range, mapped);
  if (!offsets) return false;
  return mapped.text.slice(offsets.start, offsets.end) === quote.exact &&
    mapped.text.slice(Math.max(0, offsets.start - quote.prefix.length), offsets.start) === quote.prefix &&
    mapped.text.slice(offsets.end, offsets.end + quote.suffix.length) === quote.suffix;
}

function stableSelectorIsIndexable(selector: string): boolean {
  const value = selector.trim();
  if (value.length === 0 || value.length > MAX_CSS_PATH || firstCssPathSegment(value) !== value) return false;
  return /^(?:#|\[(?:id|data-agent(?:-html-render|render|lens)-id|aria-(?:label|labelledby))=)/u.test(value);
}

function stableSelectorIndexState(
  root: Element,
  context: TargetResolutionContext,
): StableSelectorIndexState {
  const cached = context.semanticCache.stableSelectorIndexes;
  const existing = cached.get(root);
  if (existing) return existing;
  const state: StableSelectorIndexState = {
    index: new Map<string, Element | null>(),
    walker: root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT),
    current: root,
    complete: false,
    failed: false,
  };
  cached.set(root, state);
  return state;
}

function indexStableSelectorsForElement(
  index: Map<string, Element | null>,
  element: Element,
): void {
  for (const attribute of REVIEW_DATA_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (!value || value.length > MAX_STABLE_ID) continue;
    const selector = `[${attribute}="${escapeCss(value)}"]`;
    if (selector.length <= MAX_CSS_PATH) addUniqueAttributeValue(index, selector, element);
  }
  const id = element.getAttribute("id");
  if (id && id.length <= MAX_STABLE_ID) {
    const escaped = escapeCss(id);
    const hashSelector = `#${escaped}`;
    const attributeSelector = `[id="${escaped}"]`;
    if (hashSelector.length <= MAX_CSS_PATH) addUniqueAttributeValue(index, hashSelector, element);
    if (attributeSelector.length <= MAX_CSS_PATH) addUniqueAttributeValue(index, attributeSelector, element);
  }
  for (const attribute of ["aria-label", "aria-labelledby"] as const) {
    const value = element.getAttribute(attribute);
    if (!value || value.length > MAX_CSS_PATH) continue;
    const selector = `[${attribute}="${escapeCss(value)}"]`;
    if (selector.length <= MAX_CSS_PATH) addUniqueAttributeValue(index, selector, element);
  }
}

function stableSelectorMatchFromIndex(
  index: Map<string, Element | null>,
  selectors: readonly string[],
): { ambiguous: boolean; match: Element | null } {
  let match: Element | null = null;
  for (const selector of selectors) {
    const key = selector.trim();
    const candidate = index.get(key);
    if (candidate === null && index.has(key)) return { ambiguous: true, match: null };
    if (!candidate) continue;
    if (match && match !== candidate) return { ambiguous: true, match: null };
    match = candidate;
  }
  return { ambiguous: false, match };
}

function indexedStableSelectorMatch(
  root: Element,
  selectors: readonly string[],
  context: TargetResolutionContext,
): Element | null | undefined {
  if (!selectors.every(stableSelectorIsIndexable)) return undefined;
  const state = stableSelectorIndexState(root, context);
  if (state.failed) return null;
  let indexed = stableSelectorMatchFromIndex(state.index, selectors);
  if (indexed.ambiguous) return null;
  if (state.complete) return indexed.match;
  try {
    while (state.current) {
      if (context.remainingSelectorNodeChecks <= 0) {
        state.failed = true;
        return null;
      }
      context.remainingSelectorNodeChecks -= 1;
      indexStableSelectorsForElement(state.index, state.current as Element);
      state.current = state.walker.nextNode();
      indexed = stableSelectorMatchFromIndex(state.index, selectors);
      if (indexed.ambiguous) return null;
    }
  } catch {
    state.failed = true;
    return null;
  }
  state.complete = true;
  return indexed.match;
}

function uniqueSelectorMatch(
  root: Element,
  selectors: readonly string[],
  context: TargetResolutionContext,
): Element | null {
  const uniqueSelectors = Array.from(new Set(selectors));
  const indexed = indexedStableSelectorMatch(root, uniqueSelectors, context);
  if (indexed !== undefined) return indexed;
  const key = JSON.stringify(uniqueSelectors);
  let matches = context.semanticCache.selectorMatches.get(root);
  if (!matches) {
    matches = new Map();
    context.semanticCache.selectorMatches.set(root, matches);
  }
  if (matches.has(key)) return matches.get(key) ?? null;
  let match: Element | null = null;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let current: Node | null = root;
  try {
    while (current) {
      if (context.remainingSelectorNodeChecks <= 0) {
        matches.set(key, null);
        return null;
      }
      context.remainingSelectorNodeChecks -= 1;
      const element = current as Element;
      if (uniqueSelectors.some((selector) => element.matches(selector))) {
        if (match && match !== element) {
          matches.set(key, null);
          return null;
        }
        match = element;
      }
      current = walker.nextNode();
    }
  } catch {
    matches.set(key, null);
    return null;
  }
  matches.set(key, match);
  return match;
}

function compatibleScopeSelectors(scopeSelector: string): string[] {
  return scopeSelector.startsWith("[data-agentlens-id=")
    ? [
        scopeSelector,
        scopeSelector.replace("[data-agentlens-id=", "[data-agentrender-id="),
        scopeSelector.replace("[data-agentlens-id=", "[data-agent-html-render-id="),
      ]
    : scopeSelector.startsWith("[data-agentrender-id=")
      ? [scopeSelector, scopeSelector.replace("[data-agentrender-id=", "[data-agent-html-render-id=")]
      : [scopeSelector];
}

function compatibleStableIdSelectors(
  attribute: StableAttribute,
  stableId: string,
): string[] {
  const compatibleAttributes: StableAttribute[] =
    attribute === "data-agentlens-id"
      ? ["data-agentlens-id", "data-agentrender-id", "data-agent-html-render-id"]
      : attribute === "data-agentrender-id"
        ? ["data-agentrender-id", "data-agent-html-render-id"]
        : [attribute];
  return compatibleAttributes.map((candidate) => `[${candidate}="${escapeCss(stableId)}"]`);
}

function stableSelectorQueryForTarget(target: TargetDescriptor): string[] {
  if (target.stableId && target.stableAttribute) {
    return compatibleStableIdSelectors(target.stableAttribute, target.stableId);
  }
  const cssPath = target.cssPath.trim();
  if (!/^(?:\[(?:data-agent(?:-html-render|render|lens)-id|aria-(?:label|labelledby))=|#)/u.test(cssPath)) {
    return [];
  }
  return compatibleScopeSelectors(firstCssPathSegment(cssPath));
}

function stableCssContext(
  root: Element,
  target: TargetDescriptor,
  context: TargetResolutionContext,
): { required: boolean; element: Element | null; semantic: boolean } {
  const cssPath = target.cssPath.trim();
  const hasStableScope = /^(?:\[(?:data-agent(?:-html-render|render|lens)-id|aria-(?:label|labelledby))=|#)/u.test(cssPath);
  const semantic = /^\[aria-(?:label|labelledby)=/u.test(cssPath);
  if (!cssPath || !hasStableScope) return { required: false, element: null, semantic: false };
  try {
    const scopeSelector = firstCssPathSegment(cssPath);
    return {
      required: true,
      element: uniqueSelectorMatch(root, compatibleScopeSelectors(scopeSelector), context),
      semantic,
    };
  } catch {
    return { required: true, element: null, semantic };
  }
}

function firstCssPathSegment(path: string): string {
  let escaped = false;
  let quote: "\"" | "'" | null = null;
  let squareDepth = 0;
  let roundDepth = 0;
  for (let index = 0; index < path.length; index += 1) {
    const character = path[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (character === "(") roundDepth += 1;
    else if (character === ")") roundDepth = Math.max(0, roundDepth - 1);
    else if (character === ">" && squareDepth === 0 && roundDepth === 0) {
      return path.slice(0, index).trim();
    }
  }
  return path.trim();
}

export interface TargetResolutionContext {
  readonly semanticCache: SemanticIdentityCache;
  headingLabelForElement?: (element: Element) => string | undefined;
  remainingIdentityCandidateChecks: number;
  remainingIdentityTextUnits: number;
  remainingQuoteWorkUnits: number;
  remainingQuoteMatches: number;
  remainingHeadingElementChecks: number;
  remainingHeadingTextUnits: number;
  remainingCaptureNodeChecks: number;
  remainingCaptureTextUnits: number;
  remainingSelectorNodeChecks: number;
}

export function createTargetResolutionContext(
  maximumCandidateChecks = MAX_IDENTITY_CANDIDATE_CHECKS,
  maximumIdentityTextUnits = MAX_BATCH_IDENTITY_TEXT_UNITS,
  maximumQuoteWorkUnits = MAX_QUOTE_WORK_UNITS,
  maximumQuoteMatches = MAX_QUOTE_MATCHES,
  maximumHeadingElementChecks = MAX_HEADING_ELEMENT_CHECKS,
  maximumHeadingTextUnits = MAX_HEADING_TEXT_UNITS,
  maximumCaptureNodeChecks = MAX_CAPTURE_NODE_CHECKS,
  maximumCaptureTextUnits = MAX_CAPTURE_TEXT_UNITS,
  maximumSelectorNodeChecks = MAX_SELECTOR_NODE_CHECKS,
): TargetResolutionContext {
  const safeLimit = (value: number): number =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    semanticCache: createSemanticIdentityCache(),
    remainingIdentityCandidateChecks: safeLimit(maximumCandidateChecks),
    remainingIdentityTextUnits: safeLimit(maximumIdentityTextUnits),
    remainingQuoteWorkUnits: safeLimit(maximumQuoteWorkUnits),
    remainingQuoteMatches: safeLimit(maximumQuoteMatches),
    remainingHeadingElementChecks: safeLimit(maximumHeadingElementChecks),
    remainingHeadingTextUnits: safeLimit(maximumHeadingTextUnits),
    remainingCaptureNodeChecks: safeLimit(maximumCaptureNodeChecks),
    remainingCaptureTextUnits: safeLimit(maximumCaptureTextUnits),
    remainingSelectorNodeChecks: safeLimit(maximumSelectorNodeChecks),
  };
}

export function prepareTargetResolutionBatch(
  root: Element,
  targets: readonly TargetDescriptor[],
  context: TargetResolutionContext,
): void {
  for (const target of targets) {
    const selectors = stableSelectorQueryForTarget(target);
    if (selectors.length === 0 || !selectors.every(stableSelectorIsIndexable)) continue;
    indexedStableSelectorMatch(root, Array.from(new Set(selectors)), context);
    return;
  }
}

interface TargetIdentity {
  key: string;
  mode: IdentityMode;
}

function targetIdentity(target: TargetDescriptor): TargetIdentity | undefined {
  if (target.identityUnresolvable) return undefined;
  if (target.semanticSignature) {
    return { key: `${target.tag}:semantic:${target.semanticSignature}`, mode: "semantic" };
  }
  if (target.textSignature) return { key: `${target.tag}:text:${target.textSignature}`, mode: "text" };
  if (target.label) return { key: `${target.tag}:legacy-label:${target.label}`, mode: "legacy-label" };
  const legacyText = normalizedText(target.text);
  return legacyText && !legacyText.endsWith("…")
    ? { key: `${target.tag}:legacy-text:${legacyText}`, mode: "legacy-text" }
    : undefined;
}

function targetIdentityMatches(
  element: Element,
  target: TargetDescriptor,
  context: TargetResolutionContext,
): boolean {
  if (target.identityUnresolvable) return false;
  const identity = labelIdentityForElement(element, context.semanticCache, context);
  if (target.semanticSignature) {
    return identity?.complete === true && identity.signature === target.semanticSignature;
  }
  if (target.textSignature) {
    return !identity &&
      textSignatureForElement(element, context.semanticCache, context) === target.textSignature;
  }
  if (target.label) return identity?.complete === true && identity.label === target.label;
  const legacyText = normalizedText(target.text);
  const complete = completeElementText(element, context, context.semanticCache);
  return Boolean(legacyText) &&
    !legacyText.endsWith("…") &&
    complete !== undefined &&
    normalizedText(complete) === legacyText;
}

function addUniqueIdentity(index: IdentityIndex, key: string, element: Element): void {
  if (index.has(key)) index.set(key, null);
  else index.set(key, element);
}

function candidateGroupForTag(
  boundary: Element,
  tag: string,
  context: TargetResolutionContext,
): IdentityCandidateGroup | null {
  const includesBoundary = boundary.tagName.toLowerCase() === tag;
  const remainingDescendants = context.remainingIdentityCandidateChecks - (includesBoundary ? 1 : 0);
  if (remainingDescendants < 0) return null;
  const liveDescendants = boundary.getElementsByTagName(tag);
  // item(limit) asks only for the first over-budget match. In contrast, reading
  // length or Array.from() can enumerate and allocate every same-tag element in a
  // supported multi-megabyte artifact before the bound has a chance to apply.
  if (liveDescendants.item(remainingDescendants)) return null;
  const candidates: Element[] = includesBoundary ? [boundary] : [];
  for (let index = 0; index < remainingDescendants; index += 1) {
    const element = liveDescendants.item(index);
    if (!element) break;
    candidates.push(element);
  }
  context.remainingIdentityCandidateChecks -= candidates.length;
  return { candidates, indexes: new Map() };
}

function ensureSemanticIdentityIndex(
  group: IdentityCandidateGroup,
  tag: string,
  context: TargetResolutionContext,
): IdentityIndex | null {
  if (group.indexes.has("semantic")) return group.indexes.get("semantic") ?? null;
  const index: IdentityIndex = new Map();
  for (const element of group.candidates) {
    const semantic = labelIdentityForElement(element, context.semanticCache, context);
    if (semantic && !semantic.complete) {
      group.indexes.set("semantic", null);
      group.indexes.set("text", null);
      group.indexes.set("legacy-label", null);
      return null;
    }
    if (semantic) addUniqueIdentity(index, `${tag}:semantic:${semantic.signature}`, element);
  }
  group.indexes.set("semantic", index);
  return index;
}

function ensureTextIdentityIndex(
  group: IdentityCandidateGroup,
  tag: string,
  context: TargetResolutionContext,
): IdentityIndex | null {
  if (group.indexes.has("text")) return group.indexes.get("text") ?? null;
  if (!ensureSemanticIdentityIndex(group, tag, context)) return null;
  const index: IdentityIndex = new Map();
  for (const element of group.candidates) {
    const semantic = labelIdentityForElement(element, context.semanticCache, context);
    if (!semantic) {
      const signature = textSignatureForElement(element, context.semanticCache, context);
      if (!signature) {
        group.indexes.set("text", null);
        return null;
      }
      addUniqueIdentity(index, `${tag}:text:${signature}`, element);
    }
  }
  group.indexes.set("text", index);
  return index;
}

function ensureLegacyLabelIdentityIndex(
  group: IdentityCandidateGroup,
  tag: string,
  context: TargetResolutionContext,
): IdentityIndex | null {
  if (group.indexes.has("legacy-label")) return group.indexes.get("legacy-label") ?? null;
  if (!ensureSemanticIdentityIndex(group, tag, context)) return null;
  const index: IdentityIndex = new Map();
  for (const element of group.candidates) {
    const semantic = labelIdentityForElement(element, context.semanticCache, context);
    if (semantic?.label) {
      addUniqueIdentity(index, `${tag}:legacy-label:${semantic.label}`, element);
    }
  }
  group.indexes.set("legacy-label", index);
  return index;
}

function ensureLegacyTextIdentityIndex(
  group: IdentityCandidateGroup,
  tag: string,
  context: TargetResolutionContext,
): IdentityIndex | null {
  if (group.indexes.has("legacy-text")) return group.indexes.get("legacy-text") ?? null;
  ensureSemanticIdentityIndex(group, tag, context);
  const index: IdentityIndex = new Map();
  for (const element of group.candidates) {
    const complete = completeElementText(element, context, context.semanticCache);
    if (complete === undefined) {
      group.indexes.set("legacy-text", null);
      return null;
    }
    addUniqueIdentity(index, `${tag}:legacy-text:${normalizedText(complete)}`, element);
  }
  group.indexes.set("legacy-text", index);
  return index;
}

function ensureIdentityIndex(
  group: IdentityCandidateGroup,
  tag: string,
  mode: IdentityMode,
  context: TargetResolutionContext,
): IdentityIndex | null {
  if (mode === "semantic") return ensureSemanticIdentityIndex(group, tag, context);
  if (mode === "text") return ensureTextIdentityIndex(group, tag, context);
  if (mode === "legacy-label") return ensureLegacyLabelIdentityIndex(group, tag, context);
  return ensureLegacyTextIdentityIndex(group, tag, context);
}

function uniqueIdentityMatch(
  boundary: Element,
  target: TargetDescriptor,
  context: TargetResolutionContext,
  expected?: Element,
): Element | null {
  const identity = targetIdentity(target);
  if (!identity) return null;
  let indexes = context.semanticCache.identityIndexes.get(boundary);
  if (!indexes) {
    indexes = new Map<string, IdentityCandidateGroup | null>();
    context.semanticCache.identityIndexes.set(boundary, indexes);
  }
  const tag = target.tag.toLowerCase();
  if (!indexes.has(tag)) indexes.set(tag, candidateGroupForTag(boundary, tag, context));
  const group = indexes.get(tag) ?? null;
  const index = group ? ensureIdentityIndex(group, tag, identity.mode, context) : null;
  if (!index) return null;
  const match = index.get(identity.key) ?? null;
  return expected && match !== expected ? null : match;
}

type StablePathKind = "none" | "explicit" | "semantic";

function matchingElement(
  element: Element,
  target: TargetDescriptor,
  stablePathKind: StablePathKind,
  semanticBoundary: Element,
  context: TargetResolutionContext,
): boolean {
  if (element.tagName.toLowerCase() !== target.tag.toLowerCase()) return false;
  if (stablePathKind === "explicit") return true;
  if (stablePathKind === "semantic") {
    return targetIdentityMatches(element, target, context);
  }
  if (!uniqueIdentityMatch(semanticBoundary, target, context, element)) return false;
  const currentRole = element.getAttribute("role") ?? implicitRole(element);
  if (target.role && currentRole !== target.role) return false;
  const headingPath = headingPathForElement(element, context);
  if (target.headingPath.length > 0 && headingPath.at(-1) !== target.headingPath.at(-1)) return false;
  if (target.semanticSignature || target.textSignature || target.label) return true;
  const currentText = boundedNormalizedTextContent(element, MAX_TARGET_TEXT);
  const expectedText = normalizedText(target.text);
  if (expectedText && currentText === expectedText) return true;
  return Boolean(
    target.role &&
      currentRole === target.role &&
      target.headingPath.length > 0 &&
      headingPath.at(-1) === target.headingPath.at(-1),
  );
}

function matchingTextContainer(
  element: Element,
  root: Element,
  target: TargetDescriptor,
  stableContext: Element | null,
  semanticBoundary: Element,
  context: TargetResolutionContext,
  identityMode: "strict" | "unique-quote",
): Element | null {
  if (stableContext && target.stableId && target.stableAttribute) {
    return element === stableContext || stableContext.contains(element) ? element : null;
  }
  if (target.identityUnresolvable) return null;
  const boundary = stableContext ?? root;
  if (element !== boundary && !boundary.contains(element)) return null;
  let current: Element | null = element;
  while (current && (current === boundary || boundary.contains(current))) {
    if (current.tagName.toLowerCase() === target.tag.toLowerCase()) {
      const currentRole = current.getAttribute("role") ?? implicitRole(current);
      const currentHeadingPath = headingPathForElement(current, context);
      const identityMatches =
        target.semanticSignature || target.label || identityMode === "strict"
          ? Boolean(uniqueIdentityMatch(semanticBoundary, target, context, current))
          : true;
      if (
        identityMatches &&
        (!target.role || currentRole === target.role) &&
        (target.headingPath.length === 0 || currentHeadingPath.at(-1) === target.headingPath.at(-1))
      ) {
        return current;
      }
    }
    if (current === boundary) break;
    current = current.parentElement;
  }
  return null;
}

export function resolveTarget(
  root: Element,
  target: TargetDescriptor,
  context: TargetResolutionContext = createTargetResolutionContext(),
): ResolvedTarget | null {
  if (target.kind === "text") {
    const stableScope = stableCssContext(root, target, context);
    if (stableScope.required && !stableScope.element) return null;
    const stableContext = stableScope.element;
    const semanticBoundary = stableScope.semantic ? root : stableContext ?? root;
    const quote = target.textQuote ?? { exact: target.text, prefix: "", suffix: "" };
    const quoteRoot = stableContext ?? root;
    if (target.range) {
      const range = rangeFromAnchor(root, target.range);
      const common = range ? commonElement(range.commonAncestorContainer) : null;
      const element = common
        ? matchingTextContainer(common, root, target, stableContext, semanticBoundary, context, "strict")
        : null;
      if (
        range &&
        element &&
        sameSelectedText(range, root, target, context) &&
        matchesQuoteContext(range, root, target.textQuote, context)
      ) {
        return { element, range, strategy: "range-path" };
      }
    }
    const quotedRange = findTextQuote(quoteRoot, quote, context);
    const common = quotedRange ? commonElement(quotedRange.commonAncestorContainer) : null;
    const element = common
      ? matchingTextContainer(common, root, target, stableContext, semanticBoundary, context, "unique-quote")
      : null;
    if (quotedRange && element) {
      return { element, range: quotedRange, strategy: "text-quote" };
    }
    return null;
  }

  if (target.stableId && target.stableAttribute) {
    const selectors = compatibleStableIdSelectors(target.stableAttribute, target.stableId);
    const element = uniqueSelectorMatch(root, selectors, context);
    return element?.tagName.toLowerCase() === target.tag.toLowerCase()
      ? { element, strategy: "stable-id" }
      : null;
  }

  const stableScope = stableCssContext(root, target, context);
  if (stableScope.required && !stableScope.element) return null;
  const stableContext = stableScope.element;
  const semanticBoundary = stableScope.semantic ? root : stableContext ?? root;

  if (target.cssPath) {
    try {
      const element = uniqueSelectorMatch(stableContext ?? root, [target.cssPath], context) ?? undefined;
      const pathIsPositional = /:nth-(?:child|of-type)\(/u.test(target.cssPath);
      const stablePathKind: StablePathKind = pathIsPositional
        ? "none"
        : /^\[aria-(?:label|labelledby)=/u.test(target.cssPath.trim())
          ? "semantic"
          : /^(?:\[data-agent(?:-html-render|render|lens)-id=|#)/u.test(target.cssPath.trim())
            ? "explicit"
            : "none";
      if (
        element &&
        (!stableContext || element === stableContext || stableContext.contains(element)) &&
        matchingElement(element, target, stablePathKind, semanticBoundary, context)
      ) {
        return { element, strategy: "css-path" };
      }
    } catch {
      // A stale or malformed selector is allowed to fall through to the DOM path.
    }
  }

  if (target.textQuote) {
    const range = findTextQuote(stableContext ?? root, target.textQuote, context);
    const element = range ? commonElement(range.commonAncestorContainer) : null;
    const matching = element
      ? matchingTextContainer(element, root, target, stableContext, semanticBoundary, context, "strict")
      : null;
    if (range && matching) {
      return { element: matching, range, strategy: "text-quote" };
    }
  }

  const identityMatch = uniqueIdentityMatch(semanticBoundary, target, context);
  if (identityMatch) return { element: identityMatch, strategy: "identity" };

  const node = resolveNodePath(root, target.domPath);
  const element = node ? commonElement(node) : null;
  return element &&
    (!stableContext || element === stableContext || stableContext.contains(element)) &&
    matchingElement(element, target, "none", semanticBoundary, context)
    ? { element, strategy: "dom-path" }
    : null;
}
