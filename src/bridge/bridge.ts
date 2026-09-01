import {
  createTargetResolutionContext,
  MAX_TEXT_SELECTION_LENGTH,
  normalizedText,
  prepareTargetResolutionBatch,
  resolveTarget,
  targetFromElement,
  targetFromRange,
} from "../shared/anchors.js";
import { isBridgeToParentMessage, isParentToBridgeMessage } from "../shared/guards.js";
import type {
  BridgeAnnotationMarker,
  BridgeConfiguration,
  BridgeOverlay,
  BridgeOverlayRect,
  BridgeToParentPayload,
  BridgeToParentMessage,
  ParentToBridgeMessage,
} from "../shared/protocol.js";

declare global {
  interface Window {
    __AGENT_HTML_RENDER_BRIDGE__?: BridgeConfiguration;
  }
}

interface PaintedAnchor {
  marker: BridgeAnnotationMarker;
  element: Element;
  range?: Range;
}

const MAX_KEYBOARD_TARGET_SCAN = 50_000;
const MAX_KEYBOARD_TARGET_ADVANCES = 2_048;
const MAX_RENDERED_TEXT_LENGTH = 1_200;
const MAX_RENDERED_TEXT_WORK = 50_000;
const MAX_RENDERED_VISIBILITY_CHECKS = 8_192;
const MAX_VISIBILITY_ANCESTORS = 256;
const MAX_VISIBILITY_RECTS = 256;
const MAX_DIRECT_TEXT_CHILDREN = 2_048;
const MAX_POINTER_TRANSPARENT_OCCLUDERS = 2_048;
const INTRINSIC_PAINT_TAGS = new Set(["canvas", "embed", "iframe", "img", "object", "svg", "video"]);
const KEYBOARD_TARGET_TAGS = new Set([
  "a",
  "address",
  "blockquote",
  "button",
  "canvas",
  "caption",
  "dd",
  "details",
  "dt",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "iframe",
  "img",
  "input",
  "label",
  "legend",
  "li",
  "math",
  "option",
  "output",
  "p",
  "pre",
  "progress",
  "select",
  "summary",
  "svg",
  "td",
  "textarea",
  "th",
  "time",
  "video",
]);
const NON_TARGET_TAGS = new Set(["base", "link", "meta", "noscript", "script", "style", "template", "title"]);
const EMPTY_TEXT_KEYBOARD_TARGET_TAGS = new Set([
  "a",
  "button",
  "canvas",
  "hr",
  "iframe",
  "img",
  "input",
  "math",
  "progress",
  "select",
  "svg",
  "textarea",
  "video",
]);

type KeyboardTextRangeResult =
  | { kind: "range"; range: Range }
  | { kind: "empty" | "too-long" | "unavailable" };

type VisibilityMode = "document" | "viewport";

interface FragmentRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface VisibleFragmentOptions {
  mode: VisibilityMode;
  sourceIsText?: boolean;
  requireComplete?: boolean;
  requireHitTest?: boolean;
}

interface RenderedTextBudget {
  remainingNodes: number;
  remainingTextUnits: number;
  remainingVisibilityChecks: number;
}

type TextSliceVisibility = "full" | "none" | "partial";

interface PointerTransparentOccluder {
  element: Element;
  interiorPaint: boolean;
  pseudoRects: FragmentRect[] | null;
}

function start(): void {
  const candidate = window.__AGENT_HTML_RENDER_BRIDGE__;
  if (!candidate || !document.body) return;
  const configuration: BridgeConfiguration = candidate;

  let selectionMode = false;
  let hoveredElement: Element | null = null;
  let keyboardElement: Element | null = null;
  let selectedElement: Element | null = null;
  let selectedRange: Range | null = null;
  let lastTextSelectionAt = 0;
  let layoutFrame: number | undefined;
  const paintedAnchors = new Map<string, PaintedAnchor>();
  let pointerTransparentOccluders: PointerTransparentOccluder[] | null | undefined;
  let pseudoCoverCache = new WeakMap<Element, FragmentRect[] | null>();
  let resolutionContext = createBridgeResolutionContext();
  let recaptureContext = createBridgeResolutionContext();

  function post(message: BridgeToParentPayload): void {
    const candidate = {
      source: "agent-html-render-bridge",
      token: configuration.token,
      ...message,
    } satisfies BridgeToParentMessage;
    if (isBridgeToParentMessage(candidate, configuration.token)) {
      window.parent.postMessage(candidate, configuration.parentOrigin);
    }
  }

  function rectangle(element: Element, range?: Range): BridgeOverlayRect | null {
    const source = range && !range.collapsed
      ? boundedClientRects(range.getClientRects())
      : boundedClientRects(element.getClientRects());
    if (!source) return null;
    const fragments = visibleFragmentRects(source, element, {
      mode: "viewport",
      sourceIsText: Boolean(range),
      requireHitTest: true,
    });
    if (fragments.length === 0) return null;
    const left = Math.min(...fragments.map((fragment) => fragment.left));
    const top = Math.min(...fragments.map((fragment) => fragment.top));
    const right = Math.max(...fragments.map((fragment) => fragment.right));
    const bottom = Math.max(...fragments.map((fragment) => fragment.bottom));
    const width = right - left;
    const height = bottom - top;
    return width > 0 && height > 0 ? { left, top, width, height } : null;
  }

  function currentOverlays(): BridgeOverlay[] {
    const overlays: BridgeOverlay[] = [];
    const activeHover = keyboardElement?.isConnected ? keyboardElement : hoveredElement;
    if (selectionMode && activeHover?.isConnected) {
      const rect = rectangle(activeHover);
      if (rect) overlays.push({ id: "hover", kind: "hover", rect });
    }
    if (selectedElement?.isConnected) {
      const rect = rectangle(selectedElement, selectedRange ?? undefined);
      if (rect) overlays.push({ id: "selection", kind: "selection", rect });
    }
    for (const [id, painted] of paintedAnchors) {
      if (!painted.element.isConnected) continue;
      const rect = rectangle(painted.element, painted.range);
      if (!rect) continue;
      overlays.push({
        id,
        kind: "annotation",
        rect,
        label: painted.marker.label,
        tone: painted.marker.tone,
      });
    }
    return overlays;
  }

  function postLayout(): void {
    layoutFrame = undefined;
    post({ type: "overlay-layout", overlays: currentOverlays() });
  }

  function scheduleLayout(): void {
    if (layoutFrame !== undefined) return;
    layoutFrame = window.requestAnimationFrame(postLayout);
  }

  function invalidateVisibilityIndex(): void {
    pointerTransparentOccluders = undefined;
    pseudoCoverCache = new WeakMap();
  }

  function elementFromEvent(event: Event): Element | null {
    const target = event.composedPath()[0] ?? event.target;
    return target instanceof Element ? target : null;
  }

  function boundedClientRects(rectangles: DOMRectList): FragmentRect[] | null {
    if (rectangles.length > MAX_VISIBILITY_RECTS) return null;
    const output: FragmentRect[] = [];
    for (let index = 0; index < rectangles.length; index += 1) {
      const rect = rectangles.item(index);
      if (!rect) continue;
      const values = [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height];
      if (!values.every(Number.isFinite)) return null;
      if (rect.width <= 0 || rect.height <= 0 || rect.right <= rect.left || rect.bottom <= rect.top) continue;
      output.push({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      });
    }
    return output;
  }

  function intersectRect(
    source: FragmentRect,
    boundary: FragmentRect,
    clipX = true,
    clipY = true,
  ): FragmentRect | null {
    const left = clipX ? Math.max(source.left, boundary.left) : source.left;
    const top = clipY ? Math.max(source.top, boundary.top) : source.top;
    const right = clipX ? Math.min(source.right, boundary.right) : source.right;
    const bottom = clipY ? Math.min(source.bottom, boundary.bottom) : source.bottom;
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function viewportRect(): FragmentRect {
    return {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  function documentRect(): FragmentRect {
    const root = document.documentElement;
    const body = document.body;
    const width = Math.max(window.innerWidth, root.scrollWidth, root.clientWidth, body.scrollWidth, body.clientWidth);
    const height = Math.max(window.innerHeight, root.scrollHeight, root.clientHeight, body.scrollHeight, body.clientHeight);
    return {
      left: -window.scrollX,
      top: -window.scrollY,
      right: width - window.scrollX,
      bottom: height - window.scrollY,
      width,
      height,
    };
  }

  function hasEffectiveVisibility(element: Element): boolean {
    let current: Element | null = element;
    let depth = 0;
    while (current && depth < MAX_VISIBILITY_ANCESTORS) {
      const style = window.getComputedStyle(current);
      const opacity = Number.parseFloat(style.opacity);
      const transparentFilter = /opacity\(0(?:\.0+)?%?\)/iu.test(style.filter.replace(/\s+/gu, ""));
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.contentVisibility === "hidden" ||
        (Number.isFinite(opacity) && opacity <= 0) ||
        transparentFilter
      ) return false;
      current = current.parentElement;
      depth += 1;
    }
    return current === null;
  }

  function hasFixedPosition(element: Element): boolean {
    let current: Element | null = element;
    let depth = 0;
    while (current && depth < MAX_VISIBILITY_ANCESTORS) {
      if (window.getComputedStyle(current).position === "fixed") return true;
      current = current.parentElement;
      depth += 1;
    }
    return current !== null;
  }

  function hasUnsupportedPaintClip(style: CSSStyleDeclaration): boolean {
    const clipPath = style.clipPath || style.getPropertyValue("-webkit-clip-path");
    const legacyClip = style.clip;
    const masks = [
      style.getPropertyValue("mask-image"),
      style.getPropertyValue("-webkit-mask-image"),
      style.getPropertyValue("mask-border-source"),
      style.getPropertyValue("-webkit-mask-box-image-source"),
    ];
    return (
      (clipPath.trim() !== "" && clipPath.trim() !== "none") ||
      (legacyClip.trim() !== "" && legacyClip.trim() !== "auto") ||
      masks.some((value) => value.trim() !== "" && value.trim() !== "none")
    );
  }

  function clipsBothAxes(style: CSSStyleDeclaration): boolean {
    return /(?:^|\s)(?:paint|strict|content)(?:\s|$)/u.test(style.contain);
  }

  function clipsOverflow(value: string): boolean {
    return value !== "visible";
  }

  function clippingBoundary(element: Element, style: CSSStyleDeclaration): FragmentRect | null {
    if (style.transform !== "none" || !(element instanceof HTMLElement)) return null;
    const bounds = element.getBoundingClientRect();
    const scaleX = element.offsetWidth > 0 ? bounds.width / element.offsetWidth : 1;
    const scaleY = element.offsetHeight > 0 ? bounds.height / element.offsetHeight : 1;
    const left = bounds.left + element.clientLeft * scaleX;
    const top = bounds.top + element.clientTop * scaleY;
    const right = left + element.clientWidth * scaleX;
    const bottom = top + element.clientHeight * scaleY;
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function fullyContains(outer: FragmentRect, inner: FragmentRect): boolean {
    const tolerance = 0.5;
    return (
      outer.left <= inner.left + tolerance &&
      outer.top <= inner.top + tolerance &&
      outer.right >= inner.right - tolerance &&
      outer.bottom >= inner.bottom - tolerance
    );
  }

  function samplePoints(rect: FragmentRect): readonly (readonly [number, number])[] {
    return [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + rect.width / 4, rect.top + rect.height / 4],
      [rect.left + (rect.width * 3) / 4, rect.top + rect.height / 4],
      [rect.left + rect.width / 4, rect.top + (rect.height * 3) / 4],
      [rect.left + (rect.width * 3) / 4, rect.top + (rect.height * 3) / 4],
    ] as const;
  }

  function targetAtPoint(element: Element, x: number, y: number, sourceIsText: boolean): boolean {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    let hit: Element | null;
    try {
      hit = document.elementFromPoint(x, y);
    } catch {
      return false;
    }
    const pointerTransparentTarget = window.getComputedStyle(element).pointerEvents === "none";
    const topmostBranch =
      hit === element ||
      (!sourceIsText && Boolean(hit && element.contains(hit))) ||
      (pointerTransparentTarget && Boolean(hit && hit.contains(element)));
    return topmostBranch && !hasPointerTransparentCoverAtPoint(element, x, y);
  }

  function rectPassesHitTest(
    element: Element,
    rect: FragmentRect,
    requireComplete: boolean,
    sourceIsText: boolean,
  ): boolean {
    const points = samplePoints(rect);
    return requireComplete
      ? points.every(([x, y]) => targetAtPoint(element, x, y, sourceIsText))
      : points.some(([x, y]) => targetAtPoint(element, x, y, sourceIsText));
  }

  function rectPassesPseudoCoverage(
    element: Element,
    rect: FragmentRect,
    requireComplete: boolean,
  ): boolean {
    const points = samplePoints(rect);
    return requireComplete
      ? points.every(([x, y]) => !hasCoveringPseudoAtPoint(element, x, y))
      : points.some(([x, y]) => !hasCoveringPseudoAtPoint(element, x, y));
  }

  function visibleFragmentRects(
    sourceRects: readonly FragmentRect[],
    element: Element,
    options: VisibleFragmentOptions,
  ): FragmentRect[] {
    if (sourceRects.length === 0 || !hasEffectiveVisibility(element)) return [];
    const initialBoundary = options.mode === "viewport" || hasFixedPosition(element)
      ? viewportRect()
      : documentRect();
    let fragments: FragmentRect[] = [];
    for (const source of sourceRects) {
      const clipped = intersectRect(source, initialBoundary);
      if (!clipped) {
        if (options.requireComplete) return [];
        continue;
      }
      if (options.requireComplete && !fullyContains(clipped, source)) return [];
      fragments.push(clipped);
    }
    if (fragments.length === 0) return [];

    let current: Element | null = element;
    let depth = 0;
    while (current && depth < MAX_VISIBILITY_ANCESTORS) {
      const style = window.getComputedStyle(current);
      if (hasUnsupportedPaintClip(style)) return [];
      const appliesOwnOverflow = options.sourceIsText || current !== element;
      const containPaint = clipsBothAxes(style);
      const clipX = containPaint || (appliesOwnOverflow && clipsOverflow(style.overflowX));
      const clipY = containPaint || (appliesOwnOverflow && clipsOverflow(style.overflowY));
      if (clipX || clipY) {
        const boundary = clippingBoundary(current, style);
        if (!boundary) return [];
        const next: FragmentRect[] = [];
        for (const source of fragments) {
          const clipped = intersectRect(source, boundary, clipX, clipY);
          if (!clipped) {
            if (options.requireComplete) return [];
            continue;
          }
          if (options.requireComplete && !fullyContains(clipped, source)) return [];
          next.push(clipped);
        }
        fragments = next;
        if (fragments.length === 0) return [];
      }
      current = current.parentElement;
      depth += 1;
    }
    if (current !== null) return [];
    if (options.requireComplete) {
      if (!fragments.every((rect) => rectPassesPseudoCoverage(element, rect, true))) return [];
    } else {
      fragments = fragments.filter((rect) => rectPassesPseudoCoverage(element, rect, false));
      if (fragments.length === 0) return [];
    }
    if (options.requireHitTest) {
      if (options.requireComplete) {
        return fragments.every((rect) => rectPassesHitTest(element, rect, true, Boolean(options.sourceIsText)))
          ? fragments
          : [];
      }
      fragments = fragments.filter((rect) =>
        rectPassesHitTest(element, rect, false, Boolean(options.sourceIsText))
      );
    }
    return fragments;
  }

  function transparentPaint(value: string): boolean {
    const compact = value.trim().toLowerCase().replace(/\s+/gu, "");
    return (
      compact === "transparent" ||
      /^rgba\([^)]*,0(?:\.0+)?%?\)$/u.test(compact) ||
      /\/0(?:\.0+)?%?\)$/u.test(compact)
    );
  }

  function pseudoHasOpaqueInterior(style: CSSStyleDeclaration): boolean {
    const content = style.content.trim().toLowerCase();
    if (
      content === "" ||
      content === "none" ||
      content === "normal" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) return false;
    const opacity = Number.parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.999) return false;
    return (
      opaqueColor(style.backgroundColor) ||
      (style.backgroundImage.trim() !== "" && style.backgroundImage !== "none")
    );
  }

  function pixelValue(value: string): number | null {
    const compact = value.trim().toLowerCase();
    if (compact === "0") return 0;
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)px$/u.test(compact)) return null;
    const parsed = Number.parseFloat(compact);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function establishesContainingBlock(style: CSSStyleDeclaration): boolean {
    return (
      style.position !== "static" ||
      style.transform !== "none" ||
      style.perspective !== "none" ||
      style.filter !== "none" ||
      /(?:^|\s)(?:layout|paint|strict|content)(?:\s|$)/u.test(style.contain)
    );
  }

  function pseudoContainingBlock(element: Element, position: string): FragmentRect | null {
    if (position === "fixed") {
      let ancestor = element.parentElement;
      let depth = 0;
      while (ancestor && depth < MAX_VISIBILITY_ANCESTORS) {
        const style = window.getComputedStyle(ancestor);
        if (
          style.transform !== "none" ||
          style.perspective !== "none" ||
          style.filter !== "none" ||
          /(?:^|\s)(?:paint|strict|content)(?:\s|$)/u.test(style.contain)
        ) return clippingBoundary(ancestor, style);
        ancestor = ancestor.parentElement;
        depth += 1;
      }
      return ancestor ? null : viewportRect();
    }

    let current: Element | null = element;
    let depth = 0;
    while (current && depth < MAX_VISIBILITY_ANCESTORS) {
      const style = window.getComputedStyle(current);
      if (establishesContainingBlock(style)) return clippingBoundary(current, style);
      current = current.parentElement;
      depth += 1;
    }
    return current ? null : documentRect();
  }

  function boxSide(style: CSSStyleDeclaration, prefix: "border" | "margin" | "padding", side: string): number {
    const suffix = prefix === "border" ? `-${side}-width` : `-${side}`;
    return pixelValue(style.getPropertyValue(`${prefix}${suffix}`)) ?? 0;
  }

  function transformedRect(rect: FragmentRect, style: CSSStyleDeclaration): FragmentRect[] | null {
    if (style.transform === "none") return [rect];
    try {
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D) return null;
      const originValues = style.transformOrigin.trim().split(/\s+/u);
      const originX = pixelValue(originValues[0] ?? "");
      const originY = pixelValue(originValues[1] ?? "");
      if (originX === null || originY === null) return null;
      const corners = [
        [0, 0],
        [rect.width, 0],
        [0, rect.height],
        [rect.width, rect.height],
      ] as const;
      const points = corners.map(([x, y]) => {
        const transformed = new DOMPoint(x - originX, y - originY).matrixTransform(matrix);
        return {
          x: rect.left + originX + transformed.x,
          y: rect.top + originY + transformed.y,
        };
      });
      if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
      const left = Math.min(...points.map((point) => point.x));
      const top = Math.min(...points.map((point) => point.y));
      const right = Math.max(...points.map((point) => point.x));
      const bottom = Math.max(...points.map((point) => point.y));
      if (right <= left || bottom <= top) return [];
      return [{ left, top, right, bottom, width: right - left, height: bottom - top }];
    } catch {
      return null;
    }
  }

  function pseudoCoverRect(element: Element, style: CSSStyleDeclaration): FragmentRect[] | null {
    if (!pseudoHasOpaqueInterior(style) || !hasOpaqueCompositePaint(element)) return [];
    const parsedZIndex = Number.parseInt(style.zIndex, 10);
    if (Number.isFinite(parsedZIndex) && parsedZIndex < 0) return [];
    if (style.position !== "absolute" && style.position !== "fixed") {
      const displaced =
        style.transform !== "none" ||
        [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft].some(
          (value) => (pixelValue(value) ?? 0) < 0,
        );
      return displaced ? null : [];
    }
    if (hasUnsupportedPaintClip(style)) return null;
    const containingBlock = pseudoContainingBlock(element, style.position);
    if (!containingBlock) return null;

    const marginLeft = boxSide(style, "margin", "left");
    const marginRight = boxSide(style, "margin", "right");
    const marginTop = boxSide(style, "margin", "top");
    const marginBottom = boxSide(style, "margin", "bottom");
    const leftOffset = pixelValue(style.left);
    const rightOffset = pixelValue(style.right);
    const topOffset = pixelValue(style.top);
    const bottomOffset = pixelValue(style.bottom);
    const horizontalExtras = style.boxSizing === "border-box"
      ? 0
      : boxSide(style, "padding", "left") +
        boxSide(style, "padding", "right") +
        boxSide(style, "border", "left") +
        boxSide(style, "border", "right");
    const verticalExtras = style.boxSizing === "border-box"
      ? 0
      : boxSide(style, "padding", "top") +
        boxSide(style, "padding", "bottom") +
        boxSide(style, "border", "top") +
        boxSide(style, "border", "bottom");
    const computedWidth = pixelValue(style.width);
    const computedHeight = pixelValue(style.height);
    const width = computedWidth === null
      ? leftOffset !== null && rightOffset !== null
        ? containingBlock.width - leftOffset - rightOffset - marginLeft - marginRight
        : null
      : computedWidth + horizontalExtras;
    const height = computedHeight === null
      ? topOffset !== null && bottomOffset !== null
        ? containingBlock.height - topOffset - bottomOffset - marginTop - marginBottom
        : null
      : computedHeight + verticalExtras;
    if (width === null || height === null) return null;
    if (width <= 0 || height <= 0) return [];

    const left = leftOffset !== null
      ? containingBlock.left + leftOffset + marginLeft
      : rightOffset !== null
        ? containingBlock.right - rightOffset - marginRight - width
        : null;
    const top = topOffset !== null
      ? containingBlock.top + topOffset + marginTop
      : bottomOffset !== null
        ? containingBlock.bottom - bottomOffset - marginBottom - height
        : null;
    if (left === null || top === null) return null;
    const values = [left, top, width, height];
    if (!values.every(Number.isFinite)) return null;
    return transformedRect({ left, top, right: left + width, bottom: top + height, width, height }, style);
  }

  function pseudoCoverRects(element: Element): FragmentRect[] | null {
    const cached = pseudoCoverCache.get(element);
    if (cached !== undefined) return cached;
    let result: FragmentRect[] | null = null;
    try {
      const before = pseudoCoverRect(element, window.getComputedStyle(element, "::before"));
      const after = pseudoCoverRect(element, window.getComputedStyle(element, "::after"));
      result = before && after ? [...before, ...after] : null;
    } catch {}
    pseudoCoverCache.set(element, result);
    return result;
  }

  function pointInside(rect: FragmentRect, x: number, y: number): boolean {
    return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
  }

  function hasCoveringPseudoAtPoint(element: Element, x: number, y: number): boolean {
    let current: Element | null = element;
    let depth = 0;
    while (current && depth < MAX_VISIBILITY_ANCESTORS) {
      const rectangles = pseudoCoverRects(current);
      if (!rectangles) return true;
      if (rectangles.some((rect) => pointInside(rect, x, y))) {
        if (current === element) return true;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return true;
        if (coverWinsBrowserHitTest(current, element, x, y)) return true;
      }
      current = current.parentElement;
      depth += 1;
    }
    return current !== null;
  }

  function opaqueColor(value: string): boolean {
    const compact = value.trim().toLowerCase().replace(/\s+/gu, "");
    if (!compact || transparentPaint(compact)) return false;
    const commaAlpha = compact.match(/^rgba\([^)]*,([0-9.]+)%?\)$/u)?.[1];
    if (commaAlpha !== undefined) {
      const alpha = Number.parseFloat(commaAlpha);
      const opaque = compact.endsWith("%)") ? 100 : 1;
      return Number.isFinite(alpha) && alpha >= opaque;
    }
    const slashAlpha = compact.match(/\/([0-9.]+)%?\)$/u)?.[1];
    if (slashAlpha !== undefined) {
      const alpha = Number.parseFloat(slashAlpha);
      const opaque = compact.endsWith("%)") ? 100 : 1;
      return Number.isFinite(alpha) && alpha >= opaque;
    }
    return compact.startsWith("rgb(") || compact.startsWith("color(") || compact.startsWith("hsl(");
  }

  function hasOpaqueCompositePaint(element: Element): boolean {
    let current: Element | null = element;
    let depth = 0;
    while (current && depth < MAX_VISIBILITY_ANCESTORS) {
      const style = window.getComputedStyle(current);
      const opacity = Number.parseFloat(style.opacity);
      if (Number.isFinite(opacity) && opacity < 0.999) return false;
      for (const match of style.filter.matchAll(/opacity\(([^)]+)\)/giu)) {
        const value = (match[1] ?? "").trim();
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed)) return false;
        if (value.endsWith("%") ? parsed < 99.9 : parsed < 0.999) return false;
      }
      current = current.parentElement;
      depth += 1;
    }
    return current === null;
  }

  function hasOpaqueBoxInterior(element: Element, style: CSSStyleDeclaration): boolean {
    if (
      !hasEffectiveVisibility(element) ||
      !hasOpaqueCompositePaint(element) ||
      style.pointerEvents !== "none"
    ) return false;
    const intrinsicallyPainted = INTRINSIC_PAINT_TAGS.has(element.localName.toLowerCase());
    return (
      opaqueColor(style.backgroundColor) ||
      (style.backgroundImage.trim() !== "" && style.backgroundImage !== "none") ||
      intrinsicallyPainted
    );
  }

  function pointerTransparentOccluderIndex(): PointerTransparentOccluder[] | null {
    if (pointerTransparentOccluders !== undefined) return pointerTransparentOccluders;
    const output: PointerTransparentOccluder[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let current = walker.nextNode();
    let visited = 0;
    while (current && visited < MAX_KEYBOARD_TARGET_SCAN) {
      visited += 1;
      if (current instanceof Element) {
        const style = window.getComputedStyle(current);
        if (style.pointerEvents === "none") {
          const interiorPaint = hasOpaqueBoxInterior(current, style);
          const pseudoRects = pseudoCoverRects(current);
          if (!interiorPaint && pseudoRects?.length === 0) {
            current = walker.nextNode();
            continue;
          }
          if (output.length >= MAX_POINTER_TRANSPARENT_OCCLUDERS) {
            pointerTransparentOccluders = null;
            return null;
          }
          output.push({ element: current, interiorPaint, pseudoRects });
        }
      }
      current = walker.nextNode();
    }
    if (current) {
      pointerTransparentOccluders = null;
      return null;
    }
    pointerTransparentOccluders = output;
    return output;
  }

  function paintProbeSelector(element: Element): string | null {
    const parts: string[] = [];
    let current: Element | null = element;
    let depth = 0;
    while (current && current !== document.documentElement && depth < MAX_VISIBILITY_ANCESTORS) {
      const parent: Element | null = current.parentElement;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.children, current) as number;
      if (index < 0) return null;
      parts.unshift(`:nth-child(${index + 1})`);
      current = parent;
      depth += 1;
    }
    if (current !== document.documentElement) return null;
    return parts.length > 0 ? `:root > ${parts.join(" > ")}` : ":root";
  }

  function coverWinsBrowserHitTest(cover: Element, target: Element, x: number, y: number): boolean {
    const coverSelector = paintProbeSelector(cover);
    const targetSelector = paintProbeSelector(target);
    if (!coverSelector || !targetSelector) return true;
    const previousSheets = [...document.adoptedStyleSheets];
    try {
      const probeSheet = new CSSStyleSheet();
      probeSheet.replaceSync(`${coverSelector}, ${targetSelector} { pointer-events: auto !important; }`);
      document.adoptedStyleSheets = [...previousSheets, probeSheet];
      if (
        window.getComputedStyle(cover).pointerEvents === "none" ||
        window.getComputedStyle(target).pointerEvents === "none"
      ) return true;
      const hit = document.elementFromPoint(x, y);
      if (hit === target) return false;
      if (hit && target.contains(hit)) {
        return target.contains(cover) && (hit === cover || cover.contains(hit));
      }
      return hit === cover || Boolean(hit && cover.contains(hit));
    } catch {
      return true;
    } finally {
      try {
        document.adoptedStyleSheets = previousSheets;
      } catch {}
    }
  }

  function hasPointerTransparentCoverAtPoint(
    target: Element,
    x: number,
    y: number,
  ): boolean {
    const index = pointerTransparentOccluderIndex();
    if (!index) return true;
    return index.some((candidate) => {
      const cover = candidate.element;
      const bounds = cover.getBoundingClientRect();
      const interiorCovers = candidate.interiorPaint && pointInside({
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      }, x, y);
      const pseudoCovers = !candidate.pseudoRects || candidate.pseudoRects.some((rect) => pointInside(rect, x, y));
      if (!interiorCovers && !pseudoCovers) return false;
      if (cover === target) return pseudoCovers;
      if (cover.contains(target) && !pseudoCovers) return false;
      return coverWinsBrowserHitTest(cover, target, x, y);
    });
  }

  function hasVisibleTextPaint(element: Element): boolean {
    const style = window.getComputedStyle(element);
    if (transparentPaint(style.color)) return false;
    const textFill = style.getPropertyValue("-webkit-text-fill-color");
    if (textFill && transparentPaint(textFill)) return false;
    if (element.closest("svg")) {
      const fill = style.fill.trim().toLowerCase();
      if (fill === "none" || transparentPaint(fill)) return false;
    }
    return true;
  }

  function isRendered(element: Element): boolean {
    const source = boundedClientRects(element.getClientRects());
    return Boolean(source && visibleFragmentRects(source, element, { mode: "document" }).length > 0);
  }

  function isVisibleInViewport(element: Element): boolean {
    const source = boundedClientRects(element.getClientRects());
    return Boolean(
      source &&
      visibleFragmentRects(source, element, { mode: "viewport", requireHitTest: true }).length > 0
    );
  }

  function recaptureVisibilityMode(element: Element, range?: Range): VisibilityMode {
    const source = range && !range.collapsed
      ? boundedClientRects(range.getClientRects())
      : boundedClientRects(element.getClientRects());
    if (!source) return "viewport";
    return visibleFragmentRects(source, element, {
      mode: "viewport",
      sourceIsText: Boolean(range),
    }).length > 0
      ? "viewport"
      : "document";
  }

  function textSliceVisibility(
    node: Text,
    parent: Element,
    mode: VisibilityMode,
    start: number,
    end: number,
  ): TextSliceVisibility {
    try {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const rectangles = range.getClientRects();
      if (rectangles.length > MAX_VISIBILITY_RECTS) return "partial";
      const source = boundedClientRects(rectangles);
      if (!source || source.length === 0) return "none";
      const visible = visibleFragmentRects(source, parent, {
        mode,
        sourceIsText: true,
        requireHitTest: mode === "viewport",
      });
      if (visible.length === 0) return "none";
      return visibleFragmentRects(source, parent, {
        mode,
        sourceIsText: true,
        requireComplete: true,
        requireHitTest: mode === "viewport",
      }).length > 0
        ? "full"
        : "partial";
    } catch {
      return "none";
    }
  }

  function isRenderedTextNode(
    node: Text,
    mode: VisibilityMode,
    start = 0,
    end = (node.nodeValue ?? "").length,
  ): boolean {
    const parent = node.parentElement;
    const value = node.nodeValue ?? "";
    return Boolean(
      parent &&
      hasVisibleTextPaint(parent) &&
      start >= 0 &&
      end > start &&
      end <= value.length &&
      textSliceVisibility(node, parent, mode, start, end) === "full"
    );
  }

  interface VisibleTextSlice {
    start: number;
    end: number;
  }

  function collectVisibleTextSlices(
    node: Text,
    parent: Element,
    mode: VisibilityMode,
    start: number,
    end: number,
    budget: RenderedTextBudget,
    output: VisibleTextSlice[],
  ): void {
    if (start >= end || budget.remainingVisibilityChecks <= 0 || output.length >= MAX_VISIBILITY_RECTS) return;
    budget.remainingVisibilityChecks -= 1;
    const visibility = textSliceVisibility(node, parent, mode, start, end);
    if (visibility === "none") return;
    const value = node.nodeValue ?? "";
    const oneCodePoint = end - start === 1 || (end - start === 2 && (value.codePointAt(start) ?? 0) > 0xffff);
    if (visibility === "full" || oneCodePoint) {
      const previous = output.at(-1);
      if (previous?.end === start) previous.end = end;
      else output.push({ start, end });
      return;
    }
    let middle = start + Math.floor((end - start) / 2);
    const code = value.charCodeAt(middle);
    const previousCode = value.charCodeAt(middle - 1);
    if (code >= 0xdc00 && code <= 0xdfff && previousCode >= 0xd800 && previousCode <= 0xdbff) middle += 1;
    if (middle <= start || middle >= end) return;
    collectVisibleTextSlices(node, parent, mode, start, middle, budget, output);
    collectVisibleTextSlices(node, parent, mode, middle, end, budget, output);
  }

  function visibleTextSlices(
    node: Text,
    mode: VisibilityMode,
    start: number,
    end: number,
    budget: RenderedTextBudget,
  ): VisibleTextSlice[] {
    const parent = node.parentElement;
    if (!parent || !hasVisibleTextPaint(parent) || start < 0 || end <= start) return [];
    const output: VisibleTextSlice[] = [];
    collectVisibleTextSlices(node, parent, mode, start, end, budget, output);
    return output;
  }

  function renderedTextForElement(
    element: Element,
    mode: VisibilityMode,
    sharedBudget?: RenderedTextBudget,
  ): string {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const budget = sharedBudget ?? {
      remainingNodes: MAX_KEYBOARD_TARGET_SCAN,
      remainingTextUnits: MAX_RENDERED_TEXT_WORK,
      remainingVisibilityChecks: MAX_RENDERED_VISIBILITY_CHECKS,
    };
    let output = "";
    let pendingWhitespace = false;
    while (budget.remainingNodes > 0 && budget.remainingTextUnits > 0) {
      const candidate = walker.nextNode();
      if (!candidate) break;
      budget.remainingNodes -= 1;
      if (!(candidate instanceof Text)) continue;
      const value = candidate.nodeValue ?? "";
      const inspectedLength = Math.min(value.length, budget.remainingTextUnits);
      budget.remainingTextUnits -= inspectedLength;
      if (!value.slice(0, inspectedLength).trim()) continue;
      const slices = visibleTextSlices(candidate, mode, 0, inspectedLength, budget);
      let previousEnd: number | undefined;
      for (const slice of slices) {
        if (previousEnd !== undefined && slice.start > previousEnd && output.length > 0) pendingWhitespace = true;
        for (let index = slice.start; index < slice.end && output.length < MAX_RENDERED_TEXT_LENGTH; index += 1) {
          const character = value[index] ?? "";
          if (/\s/u.test(character)) {
            pendingWhitespace = output.length > 0;
          } else {
            if (pendingWhitespace && output.length < MAX_RENDERED_TEXT_LENGTH) output += " ";
            pendingWhitespace = false;
            if (output.length < MAX_RENDERED_TEXT_LENGTH) output += character;
          }
        }
        previousEnd = slice.end;
      }
      if (slices.length === 0 && output.length > 0) pendingWhitespace = true;
      else if ((slices.at(-1)?.end ?? inspectedLength) < inspectedLength && output.length > 0) pendingWhitespace = true;
      if (output.length >= MAX_RENDERED_TEXT_LENGTH) break;
    }
    return output;
  }

  function renderedHeadingLabel(element: Element, budget: RenderedTextBudget): string | undefined {
    const mode = recaptureVisibilityMode(element);
    if (mode === "viewport" && !isVisibleInViewport(element)) return undefined;
    const label = renderedTextForElement(element, mode, budget);
    return label || undefined;
  }

  function createBridgeResolutionContext(): ReturnType<typeof createTargetResolutionContext> {
    const context = createTargetResolutionContext();
    const headingBudget: RenderedTextBudget = {
      remainingNodes: MAX_KEYBOARD_TARGET_SCAN,
      remainingTextUnits: MAX_RENDERED_TEXT_WORK,
      remainingVisibilityChecks: MAX_RENDERED_VISIBILITY_CHECKS,
    };
    context.headingLabelForElement = (element) => renderedHeadingLabel(element, headingBudget);
    return context;
  }

  function targetFromRenderedElement(
    element: Element,
    mode: VisibilityMode = "viewport",
    context?: Parameters<typeof targetFromElement>[2],
  ): ReturnType<typeof targetFromElement> {
    const target = targetFromElement(element, document.body, context ?? createBridgeResolutionContext());
    const displayText = renderedTextForElement(element, mode);
    const textQuote = target.textQuote && normalizedText(target.textQuote.exact) === displayText
      ? { exact: target.textQuote.exact, prefix: "", suffix: "" }
      : undefined;
    return { ...target, text: displayText, displayText, textQuote };
  }

  function directTextVisibility(element: Element): { hasText: boolean; hasVisibleText: boolean } {
    let hasText = false;
    const budget: RenderedTextBudget = {
      remainingNodes: MAX_DIRECT_TEXT_CHILDREN,
      remainingTextUnits: MAX_RENDERED_TEXT_WORK,
      remainingVisibilityChecks: MAX_RENDERED_VISIBILITY_CHECKS,
    };
    const count = Math.min(element.childNodes.length, MAX_DIRECT_TEXT_CHILDREN);
    for (let index = 0; index < count && budget.remainingNodes > 0 && budget.remainingTextUnits > 0; index += 1) {
      budget.remainingNodes -= 1;
      const node = element.childNodes.item(index);
      if (!(node instanceof Text)) continue;
      const value = node.nodeValue ?? "";
      const start = value.search(/\S/u);
      if (start < 0) continue;
      hasText = true;
      let end = value.length;
      while (end > start && /\s/u.test(value[end - 1] ?? "")) end -= 1;
      const inspectedEnd = Math.min(end, start + budget.remainingTextUnits);
      budget.remainingTextUnits -= inspectedEnd - start;
      const slices = visibleTextSlices(node, "document", start, inspectedEnd, budget);
      if (slices.some((slice) => value.slice(slice.start, slice.end).trim())) {
        return { hasText: true, hasVisibleText: true };
      }
    }
    return { hasText, hasVisibleText: false };
  }

  function isKeyboardTarget(element: Element): boolean {
    const tag = element.localName.toLowerCase();
    if (NON_TARGET_TAGS.has(tag)) return false;
    if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
    const directText = directTextVisibility(element);
    const meaningful =
      KEYBOARD_TARGET_TAGS.has(tag) ||
      element.hasAttribute("aria-label") ||
      element.hasAttribute("role") ||
      element.hasAttribute("title") ||
      directText.hasText;
    if (
      directText.hasText &&
      !directText.hasVisibleText &&
      !element.hasAttribute("aria-label") &&
      !element.hasAttribute("aria-labelledby") &&
      !element.hasAttribute("title") &&
      !EMPTY_TEXT_KEYBOARD_TARGET_TAGS.has(tag)
    ) return false;
    return meaningful && isRendered(element);
  }

  function scanKeyboardTargets(
    walker: TreeWalker,
    direction: "next" | "previous",
    keepLast = false,
  ): Element | null {
    let visited = 0;
    let last: Element | null = null;
    while (visited < MAX_KEYBOARD_TARGET_SCAN) {
      const node = direction === "next" ? walker.nextNode() : walker.previousNode();
      if (!node) break;
      visited += 1;
      if (!(node instanceof Element) || !isKeyboardTarget(node)) continue;
      if (!keepLast) return node;
      last = node;
    }
    return last;
  }

  function firstKeyboardTarget(): Element | null {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    return scanKeyboardTargets(walker, "next");
  }

  function lastKeyboardTarget(): Element | null {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    return scanKeyboardTargets(walker, "next", true);
  }

  function adjacentKeyboardTarget(direction: 1 | -1): Element | null {
    if (!keyboardElement?.isConnected || !document.body.contains(keyboardElement)) {
      return direction === 1 ? firstKeyboardTarget() : lastKeyboardTarget();
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = keyboardElement;
    const adjacent = scanKeyboardTargets(walker, direction === 1 ? "next" : "previous");
    return adjacent ?? (direction === 1 ? firstKeyboardTarget() : lastKeyboardTarget());
  }

  function announceKeyboardTarget(element: Element): boolean {
    element.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant" as ScrollBehavior,
    });
    if (!isKeyboardTarget(element) || !isVisibleInViewport(element)) return false;
    let target = targetFromRenderedElement(element);
    if (!target.displayText && !target.label && !EMPTY_TEXT_KEYBOARD_TARGET_TAGS.has(target.tag)) {
      element.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant" as ScrollBehavior,
      });
      if (!isKeyboardTarget(element) || !isVisibleInViewport(element)) return false;
      target = targetFromRenderedElement(element);
      if (!target.displayText && !target.label && !EMPTY_TEXT_KEYBOARD_TARGET_TAGS.has(target.tag)) return false;
    }
    keyboardElement = element;
    hoveredElement = null;
    scheduleLayout();
    post({ type: "keyboard-target-changed", target });
    return true;
  }

  function moveKeyboardTarget(direction: 1 | -1 | "first" | "last"): Element | null {
    invalidateVisibilityIndex();
    let target = direction === "first"
      ? firstKeyboardTarget()
      : direction === "last"
        ? lastKeyboardTarget()
        : adjacentKeyboardTarget(direction);
    const step: 1 | -1 = direction === -1 || direction === "last" ? -1 : 1;
    const seen = new Set<Element>();
    while (target && seen.size < MAX_KEYBOARD_TARGET_ADVANCES && !seen.has(target)) {
      seen.add(target);
      if (announceKeyboardTarget(target)) return target;
      keyboardElement = target;
      target = adjacentKeyboardTarget(step);
    }
    keyboardElement = null;
    scheduleLayout();
    post({ type: "keyboard-target-unavailable" });
    return null;
  }

  function textRangeForElement(element: Element): KeyboardTextRangeResult {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let firstNode: Text | null = null;
    let firstOffset = 0;
    let lastNode: Text | null = null;
    let lastOffset = 0;
    let firstGlobalOffset = 0;
    let lastGlobalOffset = 0;
    let globalOffset = 0;
    let hiddenTextAfterStart = false;
    let visited = 0;
    let exhausted = false;
    while (visited < MAX_KEYBOARD_TARGET_SCAN) {
      const candidate = walker.nextNode();
      if (!candidate) {
        exhausted = true;
        break;
      }
      visited += 1;
      if (!(candidate instanceof Text)) continue;
      const value = candidate.nodeValue ?? "";
      const start = value.search(/\S/u);
      if (start < 0) {
        globalOffset += value.length;
        continue;
      }
      let end = value.length;
      while (end > start && /\s/u.test(value[end - 1] ?? "")) end -= 1;
      const rendered = isRenderedTextNode(candidate, "viewport", start, end);
      if (!rendered) {
        if (firstNode) hiddenTextAfterStart = true;
        globalOffset += value.length;
        continue;
      }
      if (hiddenTextAfterStart) return { kind: "unavailable" };
      if (!firstNode) {
        firstNode = candidate;
        firstOffset = start;
        firstGlobalOffset = globalOffset + start;
      }
      lastNode = candidate;
      lastOffset = end;
      lastGlobalOffset = globalOffset + end;
      if (lastGlobalOffset - firstGlobalOffset > MAX_TEXT_SELECTION_LENGTH) return { kind: "too-long" };
      globalOffset += value.length;
    }
    if (!exhausted) return { kind: "unavailable" };
    if (!firstNode || !lastNode) return { kind: "empty" };
    const range = document.createRange();
    range.setStart(firstNode, firstOffset);
    range.setEnd(lastNode, lastOffset);
    return range.toString().trim() ? { kind: "range", range } : { kind: "empty" };
  }

  function rangeTextIsVisible(range: Range, mode: VisibilityMode): boolean {
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let candidate: Node | null = root instanceof Text ? root : walker.nextNode();
    let visited = 0;
    let hasText = false;
    while (candidate) {
      if (visited >= MAX_KEYBOARD_TARGET_SCAN || !(candidate instanceof Text)) return false;
      visited += 1;
      let intersects = false;
      try {
        intersects = range.intersectsNode(candidate);
      } catch {
        return false;
      }
      if (intersects) {
        const value = candidate.nodeValue ?? "";
        const start = candidate === range.startContainer ? range.startOffset : 0;
        const end = candidate === range.endContainer ? range.endOffset : value.length;
        if (start < 0 || end < start || end > value.length) return false;
        if (value.slice(start, end).trim()) {
          hasText = true;
          if (!isRenderedTextNode(candidate, mode, start, end)) return false;
        }
      }
      candidate = walker.nextNode();
    }
    return hasText;
  }

  function targetFromRenderedRange(
    range: Range,
    mode: VisibilityMode,
    context?: Parameters<typeof targetFromRange>[2],
  ): ReturnType<typeof targetFromRange> | null {
    if (!rangeTextIsVisible(range, mode)) return null;
    const target = targetFromRange(range, document.body, context ?? createBridgeResolutionContext());
    const exact = target.textQuote?.exact ?? range.toString();
    return {
      ...target,
      text: exact,
      displayText: normalizedText(exact),
      textQuote: { exact, prefix: "", suffix: "" },
    };
  }

  function rejectInvisibleSelection(): void {
    lastTextSelectionAt = Date.now();
    post({ type: "selection-rejected", reason: "keyboard-text-unavailable" });
  }

  function selectElement(element: Element, requireKeyboardPresentation = false): boolean {
    invalidateVisibilityIndex();
    if (!isVisibleInViewport(element)) {
      rejectInvisibleSelection();
      return false;
    }
    const target = targetFromRenderedElement(element);
    if (
      requireKeyboardPresentation &&
      !target.displayText &&
      !target.label &&
      !EMPTY_TEXT_KEYBOARD_TARGET_TAGS.has(target.tag)
    ) {
      rejectInvisibleSelection();
      return false;
    }
    keyboardElement = null;
    hoveredElement = null;
    selectedElement = element;
    selectedRange = null;
    scheduleLayout();
    post({ type: "target-selected", target });
    return true;
  }

  function selectText(range: Range): boolean {
    invalidateVisibilityIndex();
    if (range.toString().length > MAX_TEXT_SELECTION_LENGTH) {
      lastTextSelectionAt = Date.now();
      post({
        type: "selection-rejected",
        reason: "text-selection-too-long",
        maximum: MAX_TEXT_SELECTION_LENGTH,
      });
      return false;
    }
    const target = targetFromRenderedRange(range, "viewport");
    if (!target) {
      rejectInvisibleSelection();
      return false;
    }
    const parent =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    if (!parent) return false;
    keyboardElement = null;
    hoveredElement = null;
    selectedElement = parent;
    selectedRange = range.cloneRange();
    scheduleLayout();
    post({ type: "target-selected", target });
    lastTextSelectionAt = Date.now();
    return true;
  }

  function selectKeyboardTarget(exactText: boolean): void {
    invalidateVisibilityIndex();
    const element = keyboardElement?.isConnected ? keyboardElement : moveKeyboardTarget(1);
    if (!element) return;
    if (exactText) {
      const result = textRangeForElement(element);
      if (result.kind === "range") {
        if (selectText(result.range)) {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(result.range);
        }
        return;
      }
      if (result.kind === "too-long") {
        post({
          type: "selection-rejected",
          reason: "text-selection-too-long",
          maximum: MAX_TEXT_SELECTION_LENGTH,
        });
      } else {
        post({ type: "selection-rejected", reason: "keyboard-text-unavailable" });
      }
      return;
    }
    selectElement(element, true);
  }

  function resolveAnnotations(markers: BridgeAnnotationMarker[], paintMarkers: boolean): void {
    invalidateVisibilityIndex();
    const resolutions: Array<{
      id: string;
      resolution: "attached" | "unresolved";
      currentTarget?: ReturnType<typeof targetFromElement>;
    }> = [];
    try {
      prepareTargetResolutionBatch(
        document.body,
        markers.map((marker) => marker.annotation.target),
        resolutionContext,
      );
    } catch {
      // Per-marker resolution below still fails closed if batch indexing cannot run.
    }
    markers.forEach((marker) => {
      let resolved: ReturnType<typeof resolveTarget>;
      try {
        resolved = resolveTarget(document.body, marker.annotation.target, resolutionContext);
      } catch {
        resolved = null;
      }
      if (!resolved || !isRendered(resolved.element)) {
        resolutions.push({ id: marker.id, resolution: "unresolved" });
        return;
      }
      const recaptureMode = recaptureVisibilityMode(resolved.element, resolved.range);
      if (recaptureMode === "viewport" && !isVisibleInViewport(resolved.element)) {
        resolutions.push({ id: marker.id, resolution: "unresolved" });
        return;
      }
      const currentTarget = resolved.range
        ? targetFromRenderedRange(resolved.range, recaptureMode, recaptureContext)
        : targetFromRenderedElement(resolved.element, recaptureMode, recaptureContext);
      if (!currentTarget) {
        resolutions.push({ id: marker.id, resolution: "unresolved" });
        return;
      }
      if (paintMarkers) {
        paintedAnchors.set(marker.id, {
          marker,
          element: resolved.element,
          ...(resolved.range ? { range: resolved.range } : {}),
        });
      }
      resolutions.push({ id: marker.id, resolution: "attached", currentTarget });
    });
    post({ type: "anchor-resolutions", resolutions });
    if (paintMarkers) scheduleLayout();
  }

  function showAnnotations(markers: BridgeAnnotationMarker[]): void {
    paintedAnchors.clear();
    resolutionContext = createBridgeResolutionContext();
    recaptureContext = createBridgeResolutionContext();
    resolveAnnotations(markers, true);
  }

  function preventNavigation(event: Event): void {
    const element = elementFromEvent(event);
    const link = event.composedPath().find((candidate): candidate is Element => {
      if (!(candidate instanceof Element)) return false;
      const tag = candidate.localName.toLowerCase();
      if (tag !== "a" && tag !== "area") return false;
      return candidate.hasAttribute("href") || candidate.hasAttributeNS("http://www.w3.org/1999/xlink", "href");
    }) ?? element?.closest("a[href], area[href]");
    if (!link) return;
    const destination = (
      link.getAttribute("href") ??
      link.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
      ""
    ).trim();
    const target = link.getAttribute("target")?.trim().toLowerCase() ?? "";
    let sameDocumentFragment = false;
    if (
      destination.startsWith("#") &&
      !link.hasAttribute("download") &&
      !link.hasAttribute("ping") &&
      (!target || target === "_self")
    ) {
      try {
        const current = new URL(window.location.href);
        const resolved = new URL(destination, document.baseURI);
        current.hash = "";
        resolved.hash = "";
        sameDocumentFragment = current.href === resolved.href;
      } catch {
        sameDocumentFragment = false;
      }
    }
    if (sameDocumentFragment) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  document.addEventListener(
    "pointermove",
    (event) => {
      if (!selectionMode) return;
      invalidateVisibilityIndex();
      if (keyboardElement) {
        keyboardElement = null;
        post({ type: "keyboard-target-cleared" });
      }
      const element = elementFromEvent(event);
      if (hoveredElement === element) return;
      hoveredElement = element;
      scheduleLayout();
    },
    true,
  );

  document.addEventListener(
    "pointerleave",
    () => {
      hoveredElement = null;
      scheduleLayout();
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    () => {
      if (!selectionMode) return;
      queueMicrotask(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (range.toString().trim()) selectText(range);
      });
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      preventNavigation(event);
      if (!selectionMode) return;
      invalidateVisibilityIndex();
      event.preventDefault();
      event.stopImmediatePropagation();
      if (Date.now() - lastTextSelectionAt < 250) return;
      const element = elementFromEvent(event);
      if (element) selectElement(element);
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!selectionMode || event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key;
      if (key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        selectionMode = false;
        hoveredElement = null;
        keyboardElement = null;
        scheduleLayout();
        post({ type: "selection-cancelled" });
        return;
      }
      if (key === "Tab" || key === "ArrowDown" || key === "ArrowRight") {
        event.preventDefault();
        event.stopImmediatePropagation();
        moveKeyboardTarget(key === "Tab" && event.shiftKey ? -1 : 1);
        return;
      }
      if (key === "ArrowUp" || key === "ArrowLeft") {
        event.preventDefault();
        event.stopImmediatePropagation();
        moveKeyboardTarget(-1);
        return;
      }
      if (key === "Home" || key === "End") {
        event.preventDefault();
        event.stopImmediatePropagation();
        moveKeyboardTarget(key === "Home" ? "first" : "last");
        return;
      }
      if (key === "Enter" || key === " " || key === "Spacebar") {
        event.preventDefault();
        event.stopImmediatePropagation();
        selectKeyboardTarget(key === "Enter" && event.shiftKey);
      }
    },
    true,
  );

  document.addEventListener("auxclick", preventNavigation, true);
  document.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  window.addEventListener("message", (event: MessageEvent<ParentToBridgeMessage>) => {
    if (event.source !== window.parent || event.origin !== configuration.parentOrigin) return;
    const message: unknown = event.data;
    if (!isParentToBridgeMessage(message, configuration.token)) return;
    if (message.type === "set-selection-mode") {
      invalidateVisibilityIndex();
      selectionMode = message.enabled;
      hoveredElement = null;
      keyboardElement = null;
      scheduleLayout();
      post({ type: "selection-mode-ready", enabled: selectionMode });
    } else if (message.type === "show-annotations") {
      showAnnotations(message.markers);
    } else if (message.type === "resolve-annotations") {
      resolveAnnotations(message.markers, false);
    } else if (message.type === "clear-selection") {
      window.getSelection()?.removeAllRanges();
      selectedElement = null;
      selectedRange = null;
      scheduleLayout();
    }
  });

  window.addEventListener("scroll", () => {
    invalidateVisibilityIndex();
    scheduleLayout();
  }, true);
  window.addEventListener("resize", () => {
    invalidateVisibilityIndex();
    scheduleLayout();
  });
  post({ type: "ready" });
  scheduleLayout();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
