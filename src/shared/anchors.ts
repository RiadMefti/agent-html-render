import type { RangeAnchor, TargetDescriptor, TextQuote } from "./protocol.js";

const MAX_TARGET_TEXT = 600;
const MAX_QUOTE_CONTEXT = 80;

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

export function normalizedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeCss(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0)?.toString(16)} `);
}

export function nodePath(node: Node, root: Node): number[] {
  const path: number[] = [];
  let current: Node | null = node;

  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) return [];
    const index = Array.prototype.indexOf.call(parent.childNodes, current) as number;
    if (index < 0) return [];
    path.unshift(index);
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

export function cssPathForElement(element: Element): string {
  const explicitId = element.getAttribute("data-agentlens-id");
  if (explicitId) return `[data-agentlens-id="${escapeCss(explicitId)}"]`;
  if (element.id) return `#${escapeCss(element.id)}`;

  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current.tagName.toLowerCase() !== "html") {
    const ancestorAgentLensId = current.getAttribute("data-agentlens-id");
    if (current !== element && ancestorAgentLensId) {
      segments.unshift(`[data-agentlens-id="${escapeCss(ancestorAgentLensId)}"]`);
      break;
    }
    if (current !== element && current.id) {
      segments.unshift(`#${escapeCss(current.id)}`);
      break;
    }
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      segments.unshift(tag);
      break;
    }

    const sameTagSiblings = Array.from(parent.children).filter(
      (sibling) => sibling.tagName === current?.tagName,
    );
    if (sameTagSiblings.length > 1) {
      const position = sameTagSiblings.indexOf(current) + 1;
      segments.unshift(`${tag}:nth-of-type(${position})`);
    } else {
      segments.unshift(tag);
    }
    current = parent;
    if (tag === "body") break;
  }
  return segments.join(" > ");
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

function labelForElement(element: Element): string | undefined {
  const direct =
    element.getAttribute("aria-label") ??
    element.getAttribute("alt") ??
    element.getAttribute("title");
  if (direct) return bounded(normalizedText(direct), 200);

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const document = element.ownerDocument;
    const label = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (normalizedText(label)) return bounded(normalizedText(label), 200);
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const labels = element.labels ? Array.from(element.labels) : [];
    const label = normalizedText(labels.map((item) => item.textContent ?? "").join(" "));
    if (label) return bounded(label, 200);
  }
  return undefined;
}

export function headingPathForElement(element: Element): string[] {
  const headings = Array.from(element.ownerDocument.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  const stack: string[] = [];
  for (const heading of headings) {
    if (heading === element || (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
      const level = Number.parseInt(heading.tagName.slice(1), 10);
      stack.length = Math.max(0, level - 1);
      stack[level - 1] = bounded(normalizedText(heading.textContent), 160);
      stack.length = level;
      if (heading === element) break;
    }
  }
  return stack.filter(Boolean);
}

function elementTextQuote(element: Element): TextQuote | undefined {
  const exact = bounded((element.textContent ?? "").trim(), MAX_TARGET_TEXT);
  if (!exact) return undefined;
  const prefix = bounded((element.previousElementSibling?.textContent ?? "").trim(), MAX_QUOTE_CONTEXT);
  const suffix = bounded((element.nextElementSibling?.textContent ?? "").trim(), MAX_QUOTE_CONTEXT);
  return { exact, prefix, suffix };
}

function commonElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

export function textQuoteForRange(range: Range, root: Node): TextQuote {
  const exact = bounded(range.toString(), MAX_TARGET_TEXT);
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

export function targetFromElement(element: Element, root: Element): TargetDescriptor {
  const stableAttribute = element.hasAttribute("data-agentlens-id")
    ? "data-agentlens-id"
    : element.id
      ? "id"
      : undefined;
  const stableId = stableAttribute ? element.getAttribute(stableAttribute) ?? undefined : undefined;
  const role = element.getAttribute("role") ?? implicitRole(element);
  const label = labelForElement(element);
  const text = bounded(normalizedText(element.textContent), MAX_TARGET_TEXT);
  const descriptor: TargetDescriptor = {
    kind: "element",
    tag: element.tagName.toLowerCase(),
    cssPath: cssPathForElement(element),
    domPath: nodePath(element, root),
    text,
    headingPath: headingPathForElement(element),
  };
  if (role) descriptor.role = role;
  if (label) descriptor.label = label;
  if (stableId) descriptor.stableId = stableId;
  if (stableAttribute) descriptor.stableAttribute = stableAttribute;
  const textQuote = elementTextQuote(element);
  if (textQuote) descriptor.textQuote = textQuote;
  return descriptor;
}

export function targetFromRange(range: Range, root: Element): TargetDescriptor {
  const element = commonElement(range.commonAncestorContainer) ?? root;
  const base = targetFromElement(element, root);
  const rangeAnchor: RangeAnchor = {
    startPath: nodePath(range.startContainer, root),
    startOffset: range.startOffset,
    endPath: nodePath(range.endContainer, root),
    endOffset: range.endOffset,
  };
  return {
    ...base,
    kind: "text",
    text: bounded(range.toString(), MAX_TARGET_TEXT),
    textQuote: textQuoteForRange(range, root),
    range: rangeAnchor,
  };
}

interface TextMapEntry {
  node: Text;
  start: number;
  end: number;
}

function mappedText(root: Node): { text: string; entries: TextMapEntry[] } {
  const document = root.ownerDocument ?? (root as Document);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const entries: TextMapEntry[] = [];
  let text = "";
  let current = walker.nextNode();
  while (current) {
    const value = current.nodeValue ?? "";
    const start = text.length;
    text += value;
    entries.push({ node: current as Text, start, end: text.length });
    current = walker.nextNode();
  }
  return { text, entries };
}

function rangeAtOffsets(root: Node, start: number, end: number, entries: TextMapEntry[]): Range | null {
  const startEntry = entries.find((entry) => start >= entry.start && start <= entry.end);
  const endEntry = [...entries].reverse().find((entry) => end >= entry.start && end <= entry.end);
  if (!startEntry || !endEntry) return null;
  const range = (root.ownerDocument ?? (root as Document)).createRange();
  range.setStart(startEntry.node, Math.min(start - startEntry.start, startEntry.node.length));
  range.setEnd(endEntry.node, Math.min(end - endEntry.start, endEntry.node.length));
  return range;
}

export function findTextQuote(root: Node, quote: TextQuote): Range | null {
  if (!quote.exact) return null;
  const { text, entries } = mappedText(root);
  const candidates: number[] = [];
  let position = text.indexOf(quote.exact);
  while (position >= 0) {
    candidates.push(position);
    position = text.indexOf(quote.exact, position + 1);
  }
  if (candidates.length === 0) return null;

  const score = (start: number): number => {
    const prefix = text.slice(Math.max(0, start - quote.prefix.length), start);
    const suffixStart = start + quote.exact.length;
    const suffix = text.slice(suffixStart, suffixStart + quote.suffix.length);
    return (quote.prefix && prefix.endsWith(quote.prefix) ? 1 : 0) +
      (quote.suffix && suffix.startsWith(quote.suffix) ? 1 : 0);
  };
  candidates.sort((left, right) => score(right) - score(left));
  const start = candidates[0];
  if (start === undefined) return null;
  return rangeAtOffsets(root, start, start + quote.exact.length, entries);
}

export interface ResolvedTarget {
  element: Element;
  range?: Range;
  strategy: "stable-id" | "range-path" | "text-quote" | "css-path" | "dom-path";
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

function sameSelectedText(range: Range, target: TargetDescriptor): boolean {
  const expected = normalizedText(target.textQuote?.exact ?? target.text);
  return Boolean(expected) && normalizedText(range.toString()) === expected;
}

function matchingElement(element: Element, target: TargetDescriptor, pathIsStable: boolean): boolean {
  if (element.tagName.toLowerCase() !== target.tag.toLowerCase()) return false;
  if (pathIsStable) return true;
  const currentText = normalizedText(element.textContent);
  const expectedText = normalizedText(target.text).replace(/…$/, "");
  if (expectedText && (currentText === expectedText || currentText.includes(expectedText))) return true;
  const currentLabel = labelForElement(element);
  if (target.label && currentLabel === target.label) return true;
  const currentRole = element.getAttribute("role") ?? implicitRole(element);
  const headingPath = headingPathForElement(element);
  return Boolean(
    target.role &&
      currentRole === target.role &&
      target.headingPath.length > 0 &&
      headingPath.at(-1) === target.headingPath.at(-1),
  );
}

export function resolveTarget(root: Element, target: TargetDescriptor): ResolvedTarget | null {
  if (target.kind === "text") {
    if (target.range) {
      const range = rangeFromAnchor(root, target.range);
      const element = range ? commonElement(range.commonAncestorContainer) : null;
      if (range && element && sameSelectedText(range, target)) {
        return { element, range, strategy: "range-path" };
      }
    }
    if (target.textQuote) {
      const range = findTextQuote(root, target.textQuote);
      const element = range ? commonElement(range.commonAncestorContainer) : null;
      if (range && element) return { element, range, strategy: "text-quote" };
    }
    return null;
  }

  if (target.stableId && target.stableAttribute) {
    const selector = `[${target.stableAttribute}="${escapeCss(target.stableId)}"]`;
    const element = root.matches(selector) ? root : root.querySelector(selector);
    if (element && element.tagName.toLowerCase() === target.tag.toLowerCase()) {
      return { element, strategy: "stable-id" };
    }
  }

  if (target.cssPath) {
    try {
      const element = root.matches(target.cssPath) ? root : root.querySelector(target.cssPath);
      const pathIsStable = /(?:data-agentlens-id|#[a-zA-Z_-])/.test(target.cssPath);
      if (element && matchingElement(element, target, pathIsStable)) {
        return { element, strategy: "css-path" };
      }
    } catch {
      // A stale or malformed selector is allowed to fall through to the DOM path.
    }
  }

  if (target.textQuote) {
    const range = findTextQuote(root, target.textQuote);
    const element = range ? commonElement(range.commonAncestorContainer) : null;
    if (range && element && element.tagName.toLowerCase() === target.tag.toLowerCase()) {
      return { element, range, strategy: "text-quote" };
    }
  }

  const node = resolveNodePath(root, target.domPath);
  const element = node ? commonElement(node) : null;
  return element && matchingElement(element, target, false) ? { element, strategy: "dom-path" } : null;
}
