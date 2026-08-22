import { resolveTarget, targetFromElement, targetFromRange } from "../shared/anchors.js";
import { isParentToBridgeMessage } from "../shared/guards.js";
import type {
  BridgeConfiguration,
  BridgeToParentPayload,
  BridgeToParentMessage,
  DraftAnnotation,
  ParentToBridgeMessage,
} from "../shared/protocol.js";

declare global {
  interface Window {
    __AGENTLENS_BRIDGE__?: BridgeConfiguration;
  }
}

interface PaintedAnchor {
  annotation: DraftAnnotation;
  overlay: HTMLDivElement;
}

function start(): void {
  const candidate = window.__AGENTLENS_BRIDGE__;
  if (!candidate || !document.body) return;
  const configuration: BridgeConfiguration = candidate;

  let selectionMode = true;
  let selectedElement: Element | null = null;
  let selectedRange: Range | null = null;
  let lastTextSelectionAt = 0;
  const paintedAnchors = new Map<string, PaintedAnchor>();

  const hoverOverlay = createOverlay("hover");
  const selectionOverlay = createOverlay("selection");

  function post(message: BridgeToParentPayload): void {
    window.parent.postMessage(
      { source: "agentlens-bridge", token: configuration.token, ...message } satisfies BridgeToParentMessage,
      configuration.parentOrigin,
    );
  }

  function createOverlay(kind: "hover" | "selection" | "annotation", label?: string): HTMLDivElement {
    const overlay = document.createElement("div");
    overlay.dataset.agentlensBridge = kind;
    Object.assign(overlay.style, {
      position: "fixed",
      display: "none",
      pointerEvents: "none",
      zIndex: "2147483646",
      borderRadius: "0",
      boxSizing: "border-box",
      transition: "left 60ms linear, top 60ms linear, width 60ms linear, height 60ms linear",
      border:
        kind === "hover"
          ? "1px solid rgba(133, 133, 133, .95)"
          : kind === "selection"
            ? "1px solid rgba(23, 23, 23, 1)"
            : "1px solid rgba(23, 23, 23, .85)",
      background:
        kind === "hover"
          ? "rgba(250, 250, 250, .08)"
          : kind === "selection"
            ? "rgba(23, 23, 23, .035)"
            : "rgba(23, 23, 23, .025)",
      boxShadow: "none",
    });
    if (label) {
      const pin = document.createElement("span");
      pin.textContent = label;
      Object.assign(pin.style, {
        position: "absolute",
        top: "-21px",
        left: "0",
        display: "grid",
        placeItems: "center",
        width: "20px",
        height: "20px",
        border: "1px solid #171717",
        borderRadius: "0",
        background: "#fafafa",
        color: "#171717",
        font: "500 10px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        boxShadow: "none",
      });
      overlay.append(pin);
    }
    document.body.append(overlay);
    return overlay;
  }

  function paint(overlay: HTMLElement, element: Element, range?: Range): void {
    const rect = range && !range.collapsed ? range.getBoundingClientRect() : element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      overlay.style.display = "none";
      return;
    }
    Object.assign(overlay.style, {
      display: "block",
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function bridgeElement(element: Element | null): boolean {
    return Boolean(element?.closest("[data-agentlens-bridge]"));
  }

  function elementFromEvent(event: Event): Element | null {
    const target = event.composedPath()[0] ?? event.target;
    return target instanceof Element && !bridgeElement(target) ? target : null;
  }

  function selectElement(element: Element): void {
    selectedElement = element;
    selectedRange = null;
    paint(selectionOverlay, element);
    post({ type: "target-selected", target: targetFromElement(element, document.body) });
  }

  function selectText(range: Range): void {
    const parent =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    if (!parent || bridgeElement(parent)) return;
    selectedElement = parent;
    selectedRange = range.cloneRange();
    paint(selectionOverlay, parent, selectedRange);
    post({ type: "target-selected", target: targetFromRange(range, document.body) });
    lastTextSelectionAt = Date.now();
  }

  function repaint(): void {
    if (selectedElement) paint(selectionOverlay, selectedElement, selectedRange ?? undefined);
    for (const { annotation, overlay } of paintedAnchors.values()) {
      const resolved = resolveTarget(document.body, annotation.target);
      if (resolved) paint(overlay, resolved.element, resolved.range);
      else overlay.style.display = "none";
    }
  }

  function showAnnotations(annotations: DraftAnnotation[]): void {
    for (const painted of paintedAnchors.values()) painted.overlay.remove();
    paintedAnchors.clear();
    const resolutions: Array<{ id: string; resolution: "attached" | "unresolved" }> = [];
    annotations.forEach((annotation, index) => {
      const resolved = resolveTarget(document.body, annotation.target);
      if (!resolved) {
        resolutions.push({ id: annotation.id, resolution: "unresolved" });
        return;
      }
      const overlay = createOverlay("annotation", String(index + 1));
      paint(overlay, resolved.element, resolved.range);
      paintedAnchors.set(annotation.id, { annotation, overlay });
      resolutions.push({ id: annotation.id, resolution: "attached" });
    });
    post({ type: "anchor-resolutions", resolutions });
  }

  document.addEventListener(
    "pointermove",
    (event) => {
      if (!selectionMode) return;
      const element = elementFromEvent(event);
      if (!element) {
        hoverOverlay.style.display = "none";
        return;
      }
      paint(hoverOverlay, element);
    },
    true,
  );

  document.addEventListener(
    "pointerleave",
    () => {
      hoverOverlay.style.display = "none";
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
      if (!selectionMode) {
        const element = elementFromEvent(event);
        const link = element?.closest("a[href]");
        const destination = link?.getAttribute("href")?.trim() ?? "";
        if (destination && !destination.startsWith("#")) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (Date.now() - lastTextSelectionAt < 250) return;
      const element = elementFromEvent(event);
      if (element) selectElement(element);
    },
    true,
  );

  window.addEventListener("message", (event: MessageEvent<ParentToBridgeMessage>) => {
    if (event.source !== window.parent || event.origin !== configuration.parentOrigin) return;
    const message: unknown = event.data;
    if (!isParentToBridgeMessage(message, configuration.token)) return;
    if (message.type === "set-selection-mode") {
      selectionMode = message.enabled;
      if (!selectionMode) hoverOverlay.style.display = "none";
    } else if (message.type === "show-annotations") {
      showAnnotations(message.annotations);
    } else if (message.type === "clear-selection") {
      selectedElement = null;
      selectedRange = null;
      selectionOverlay.style.display = "none";
    }
  });

  window.addEventListener("scroll", repaint, true);
  window.addEventListener("resize", repaint);
  post({ type: "ready" });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
