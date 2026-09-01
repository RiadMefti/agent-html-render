// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createTargetResolutionContext,
  cssPathForElement,
  findTextQuote,
  headingPathForElement,
  prepareTargetResolutionBatch,
  resolveTarget,
  targetFromElement,
  targetFromRange,
} from "../../src/shared/anchors.js";

describe("durable target anchors", () => {
  it("computes the browser-side semantic digest as normalized SHA-256", () => {
    document.body.innerHTML = `<button aria-label="  Alpha   Beta  ">Review</button>`;
    const button = document.querySelector("button");
    if (!button) throw new Error("semantic digest fixture is missing");
    const sourceSignature = `a11y-v1:${createHash("sha256")
      .update(JSON.stringify(["aria-label", "Alpha Beta"]))
      .digest("hex")}`;
    const expected = createHash("sha256")
      .update(JSON.stringify(["accessible-name", "aria-label", sourceSignature]))
      .digest("hex");

    expect(targetFromElement(button, document.body).semanticSignature).toBe(`a11y-v1:${expected}`);
  });

  it("anchors descendant paths to the nearest stable review region", () => {
    document.body.innerHTML = `
      <main>
        <article data-agent-html-render-id="phase-offer"><div><h2>Offer</h2></div></article>
      </main>
    `;
    const heading = document.querySelector("h2");
    if (!heading) throw new Error("fixture heading is missing");

    expect(cssPathForElement(heading)).toBe('[data-agent-html-render-id="phase-offer"] > div > h2');
    const target = targetFromElement(heading, document.body);

    document.body.innerHTML = `
      <main>
        <p>A new introduction.</p>
        <article data-agent-html-render-id="phase-offer"><div><h2>Invite</h2></div></article>
      </main>
    `;

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.strategy).toBe("css-path");
    expect(resolved?.element.textContent).toBe("Invite");
  });

  it("reattaches legacy AgentLens IDs after an artifact adopts Agent HTML Render IDs", () => {
    document.body.innerHTML = `
      <article data-agentlens-id="phase-offer"><h2>Offer</h2></article>
    `;
    const article = document.querySelector("article");
    if (!article) throw new Error("fixture article is missing");
    const target = targetFromElement(article, document.body);

    document.body.innerHTML = `
      <article data-agent-html-render-id="phase-offer"><h2>Invite</h2></article>
    `;

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.strategy).toBe("stable-id");
    expect(resolved?.element.textContent).toBe("Invite");
  });

  it("reattaches pre-release AgentRender IDs after an artifact adopts Agent HTML Render IDs", () => {
    document.body.innerHTML = `
      <article data-agentrender-id="phase-offer"><h2>Offer</h2></article>
    `;
    const article = document.querySelector("article");
    if (!article) throw new Error("fixture article is missing");
    const target = targetFromElement(article, document.body);

    document.body.innerHTML = `
      <article data-agent-html-render-id="phase-offer"><h2>Invite</h2></article>
    `;

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.strategy).toBe("stable-id");
    expect(resolved?.element.textContent).toBe("Invite");
  });

  it("fails closed when legacy and current namespaces identify different matching elements", () => {
    document.body.innerHTML = `
      <article data-agentlens-id="phase-offer"><h2>Original</h2></article>
    `;
    const article = document.querySelector("article");
    if (!article) throw new Error("fixture article is missing");
    const target = targetFromElement(article, document.body);

    document.body.innerHTML = `
      <article data-agentlens-id="phase-offer"><h2>Wrong legacy claimant</h2></article>
      <article data-agent-html-render-id="phase-offer"><h2>Current claimant</h2></article>
    `;

    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("deduplicates compatible namespace IDs carried by the same migrated element", () => {
    document.body.innerHTML = `
      <article data-agentlens-id="phase-offer"><h2>Original</h2></article>
    `;
    const article = document.querySelector("article");
    if (!article) throw new Error("fixture article is missing");
    const target = targetFromElement(article, document.body);

    document.body.innerHTML = `
      <article data-agentlens-id="phase-offer" data-agent-html-render-id="phase-offer"><h2>Migrated</h2></article>
    `;

    expect(resolveTarget(document.body, target)?.element.textContent).toBe("Migrated");
  });

  it("does not silently move a positional annotation to the next sibling", () => {
    document.body.innerHTML = `
      <section><p>Keep</p><p>Remove me</p><p>Next item</p></section>
    `;
    const paragraph = document.querySelectorAll("p").item(1);
    const target = targetFromElement(paragraph, document.body);

    paragraph.remove();

    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("does not trust an ambiguous descendant merely because its ancestor has a stable ID", () => {
    document.body.innerHTML = `
      <article data-agent-html-render-id="phase-offer"><div><h2>Offer</h2></div></article>
    `;
    const heading = document.querySelector("h2");
    if (!heading) throw new Error("fixture heading is missing");
    const target = targetFromElement(heading, document.body);

    document.body.innerHTML = `
      <article data-agent-html-render-id="phase-offer"><div><h2>New heading</h2><h2>Invite</h2></div></article>
    `;

    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("does not choose the first element when a stable review ID is duplicated", () => {
    document.body.innerHTML = `<article data-agent-html-render-id="phase"><h2>Offer</h2></article>`;
    const article = document.querySelector("article");
    if (!article) throw new Error("fixture article is missing");
    const target = targetFromElement(article, document.body);

    document.body.innerHTML = `
      <article data-agent-html-render-id="phase"><h2>Invite primary users</h2></article>
      <article data-agent-html-render-id="phase"><h2>Invite secondary users</h2></article>
    `;

    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("caches duplicate stable-selector failure after the second claimant", () => {
    document.body.innerHTML = `<i data-agent-html-render-id="repeated">Target</i>`;
    const original = document.querySelector("i");
    if (!original) throw new Error("stable-selector budget fixture is missing");
    const target = targetFromElement(original, document.body);
    document.body.innerHTML = [
      `<i data-agent-html-render-id="repeated">First</i>`,
      `<i data-agent-html-render-id="repeated">Second</i>`,
      ...Array.from({ length: 1_000 }, () => "<i></i>"),
    ].join("");
    const context = createTargetResolutionContext();
    const before = context.remainingSelectorNodeChecks;

    for (let index = 0; index < 150; index += 1) {
      expect(resolveTarget(document.body, target, context)).toBeNull();
    }

    expect(before - context.remainingSelectorNodeChecks).toBe(3);
  });

  it("batch-indexes distinct stable IDs once so marker order cannot exhaust later targets", () => {
    document.body.innerHTML = [
      ...Array.from(
        { length: 150 },
        (_, index) => `<article data-agent-html-render-id="stable-${index}">Target ${index}</article>`,
      ),
      ...Array.from({ length: 1_850 }, () => "<span>Noise</span>"),
    ].join("");
    const elements = Array.from(document.querySelectorAll("article"));
    const targets = elements.map((element) => targetFromElement(element, document.body));
    const selectorNodeCount = document.body.querySelectorAll("*").length + 1;

    for (const order of [targets, [...targets].reverse()]) {
      const context = createTargetResolutionContext();
      context.remainingSelectorNodeChecks = selectorNodeCount;
      prepareTargetResolutionBatch(document.body, order, context);

      expect(order.map((target) => resolveTarget(document.body, target, context)?.element))
        .toEqual(order === targets ? elements : [...elements].reverse());
      expect(context.remainingSelectorNodeChecks).toBe(0);
    }
  });

  it("continues one stable-ID index across sequential bridge-sized batches", () => {
    document.body.innerHTML = ["a", "b", "c"]
      .map((id) => `<article data-agent-html-render-id="${id}">Target ${id}</article>`)
      .join("");
    const elements = Array.from(document.querySelectorAll("article"));
    const targets = elements.map((element) => targetFromElement(element, document.body));
    const orders = [
      [[targets[0]], [targets[1], targets[2]]],
      [[targets[1], targets[2]], [targets[0]]],
    ];

    for (const chunks of orders) {
      const context = createTargetResolutionContext();
      context.remainingSelectorNodeChecks = 4;
      const resolved = chunks.flatMap((chunk) => {
        const complete = chunk.filter((target): target is NonNullable<typeof target> => Boolean(target));
        prepareTargetResolutionBatch(document.body, complete, context);
        return complete.map((target) => resolveTarget(document.body, target, context)?.element);
      });

      expect(new Set(resolved)).toEqual(new Set(elements));
      expect(context.remainingSelectorNodeChecks).toBe(0);
    }
  });

  it("fails closed when a stable review ID is duplicated across different tags", () => {
    document.body.innerHTML = `<button data-agent-html-render-id="critical">Approve deployment</button>`;
    const button = document.querySelector("button");
    if (!button) throw new Error("fixture button is missing");
    const target = targetFromElement(button, document.body);

    document.body.innerHTML = `
      <section data-agent-html-render-id="critical">Approve deployment</section>
      <button data-agent-html-render-id="critical">Delete production</button>
    `;

    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("fails closed when compatible stable-ID namespaces have different claimants", () => {
    document.body.innerHTML = `<button data-agentlens-id="critical">Approve deployment</button>`;
    const button = document.querySelector("button");
    if (!button) throw new Error("fixture button is missing");
    const target = targetFromElement(button, document.body);

    document.body.innerHTML = `
      <section data-agentlens-id="critical">Approve deployment</section>
      <button data-agent-html-render-id="critical">Delete production</button>
    `;

    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("requires a unique best text quote match", () => {
    document.body.innerHTML = `<p>Repeat this phrase.</p><p>Repeat this phrase.</p>`;

    expect(findTextQuote(document.body, { exact: "Repeat this phrase.", prefix: "", suffix: "" })).toBeNull();
  });

  it("reattaches an exact text selection after surrounding markup changes", () => {
    document.body.innerHTML = `<p>Alpha beta gamma delta omega.</p>`;
    const text = document.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("fixture text is missing");
    const start = text.data.indexOf("gamma");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + "gamma delta".length);
    const target = targetFromRange(range, document.body);

    document.body.innerHTML = `<p>New intro. Alpha beta <em>gamma delta</em> omega.</p>`;

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.strategy).toBe("text-quote");
    expect(resolved?.range?.toString()).toBe("gamma delta");
  });

  it("never reattaches repeated text to the wrong stable review region after reordering", () => {
    document.body.innerHTML = `
      <section data-agent-html-render-id="a"><h2>A</h2><p>Deploy</p></section>
      <section data-agent-html-render-id="b"><h2>B</h2><p>Deploy</p></section>
    `;
    const text = document.querySelector('[data-agent-html-render-id="b"] p')?.firstChild;
    if (!(text instanceof Text)) throw new Error("fixture text is missing");
    const range = document.createRange();
    range.selectNodeContents(text);
    const target = targetFromRange(range, document.body);

    document.body.innerHTML = `
      <section data-agent-html-render-id="b"><h2>B</h2><p>Deploy</p></section>
      <section data-agent-html-render-id="a"><h2>A</h2><p>Deploy</p></section>
    `;

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.element.closest("section")?.getAttribute("data-agent-html-render-id")).not.toBe("a");
    expect(resolved?.element.closest("section")?.getAttribute("data-agent-html-render-id") ?? null).toBe("b");
  });

  it("resolves unchanged descendants and text inside escaped stable IDs", () => {
    document.body.innerHTML = `<section id="phase>one"><p>Deploy carefully</p></section>`;
    const paragraph = document.querySelector("p");
    const text = paragraph?.firstChild;
    if (!paragraph || !(text instanceof Text)) throw new Error("escaped-ID fixture is missing");
    const elementTarget = targetFromElement(paragraph, document.body);
    const range = document.createRange();
    range.selectNodeContents(text);
    const textTarget = targetFromRange(range, document.body);

    expect(elementTarget.cssPath).toContain("\\>");
    expect(resolveTarget(document.body, elementTarget)?.element).toBe(paragraph);
    expect(resolveTarget(document.body, textTarget)?.range?.toString()).toBe("Deploy carefully");
  });

  it("fails closed when a text selection's stable region disappears", () => {
    document.body.innerHTML = `
      <section data-agent-html-render-id="a"><p>Deploy</p></section>
      <section data-agent-html-render-id="b"><p>Deploy</p></section>
    `;
    const text = document.querySelector('[data-agent-html-render-id="b"] p')?.firstChild;
    if (!(text instanceof Text)) throw new Error("fixture text is missing");
    const range = document.createRange();
    range.selectNodeContents(text);
    const target = targetFromRange(range, document.body);

    document.body.innerHTML = `<section data-agent-html-render-id="a"><p>Deploy</p></section>`;
    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("keeps adjacent repeated text inside the selected labelled control", () => {
    document.body.innerHTML = `
      <button aria-label="Delete project A">Delete</button><button aria-label="Delete project B">Delete</button>
    `;
    const text = document.querySelectorAll("button").item(1).firstChild;
    if (!(text instanceof Text)) throw new Error("fixture text is missing");
    const range = document.createRange();
    range.selectNodeContents(text);
    const target = targetFromRange(range, document.body);

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.element.tagName).toBe("BUTTON");
    expect(resolved?.element.getAttribute("aria-label")).toBe("Delete project B");
    expect(resolved?.range?.toString()).toBe("Delete");
  });

  it("never moves a labelled element annotation to a reordered same-text control", () => {
    document.body.innerHTML = `
      <button aria-label="Delete project A">Delete</button>
      <button aria-label="Delete project B">Delete</button>
    `;
    const target = targetFromElement(document.querySelectorAll("button").item(1), document.body);

    document.body.innerHTML = `
      <button aria-label="Delete project B">Delete</button>
      <button aria-label="Delete project A">Delete</button>
    `;
    const resolved = resolveTarget(document.body, target);
    expect(resolved?.element.getAttribute("aria-label") ?? null).not.toBe("Delete project A");
  });

  it("fails closed when genuinely identical content-named siblings reorder", () => {
    document.body.innerHTML = `<div><button>Edit</button><button>Edit</button></div>`;
    const targetButton = document.querySelectorAll("button").item(1);
    const target = targetFromElement(targetButton, document.body);
    document.querySelector("div")?.prepend(targetButton);

    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("uses complete element text identity when bounded text prefixes collide", () => {
    const prefix = "x".repeat(1_300);
    document.body.innerHTML = `<div><p>${prefix} first</p><p>${prefix} second</p></div>`;
    const targetParagraph = document.querySelectorAll("p").item(1);
    const target = targetFromElement(targetParagraph, document.body);
    document.querySelector("div")?.prepend(targetParagraph);

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.element.textContent).toBe(`${prefix} second`);
    expect(resolved?.strategy).toBe("identity");
  });

  it("fails closed when a directly stable element disappears", () => {
    document.body.innerHTML = `
      <button id="delete-a">Delete</button>
      <button id="delete-b">Delete</button>
    `;
    const target = targetFromElement(document.querySelector("#delete-b") as Element, document.body);

    document.body.innerHTML = `<button id="delete-a">Delete</button>`;
    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("fails closed when an element target's stable ancestor disappears after reordering", () => {
    document.body.innerHTML = `
      <section data-agent-html-render-id="a"><p>Deploy</p></section>
      <section data-agent-html-render-id="b"><p>Deploy</p></section>
    `;
    const paragraph = document.querySelector('[data-agent-html-render-id="b"] p');
    if (!paragraph) throw new Error("fixture paragraph is missing");
    const target = targetFromElement(paragraph, document.body);

    document.body.innerHTML = `
      <section data-agent-html-render-id="a"><p>Deploy</p></section>
      <section><p>Deploy</p></section>
    `;
    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("resolves bounded long selections unchanged and rejects selections outside the bridge contract", () => {
    document.body.innerHTML = `<p>${"x".repeat(1_201)}</p>`;
    const text = document.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("fixture text is missing");
    const boundedRange = document.createRange();
    boundedRange.setStart(text, 0);
    boundedRange.setEnd(text, 700);
    const target = targetFromRange(boundedRange, document.body);

    expect(target.textQuote?.exact).toHaveLength(700);
    expect(resolveTarget(document.body, target)?.range?.toString()).toHaveLength(700);

    const oversizedRange = document.createRange();
    oversizedRange.selectNodeContents(text);
    expect(() => targetFromRange(oversizedRange, document.body)).toThrow("limited to 1200 characters");
  });

  it("bounds descriptors before they cross the bridge", () => {
    document.body.innerHTML = `<main><p id="${"x".repeat(5_000_000)}" role="${"r".repeat(500)}">Review</p></main>`;
    const paragraph = document.querySelector("p");
    if (!paragraph) throw new Error("fixture paragraph is missing");

    const target = targetFromElement(paragraph, document.body);
    expect(target.stableId).toBeUndefined();
    expect(target.stableAttribute).toBeUndefined();
    expect(target.role?.length).toBeLessThanOrEqual(120);
    expect(target.cssPath.length).toBeLessThanOrEqual(2_000);
    expect(target.domPath.length).toBeLessThanOrEqual(64);
  });

  it("bounds repeated aria-labelledby references before joining label text", () => {
    const repeatedReferences = Array.from({ length: 1_000 }, () => "large-label").join(" ").slice(0, 1_999);
    document.body.innerHTML = `
      <span id="large-label">${"label ".repeat(10_000)}</span>
      <button aria-labelledby="${repeatedReferences}">Continue</button>
    `;
    const button = document.querySelector("button");
    if (!button) throw new Error("label fixture button is missing");

    const target = targetFromElement(button, document.body);
    expect(target.label).toHaveLength(200);
    expect(target.label).toContain("…");
  });

  it("does not let one aria-labelledby reference erase the distinguishing reference after it", () => {
    document.body.innerHTML = `
      <span id="noise">${" ".repeat(5_000)}</span>
      <span id="project-a">Delete project A</span>
      <span id="project-b">Delete project B</span>
      <div>
        <button aria-labelledby="noise project-a">Delete</button>
        <button aria-labelledby="noise project-b">Delete</button>
      </div>
    `;
    const targetButton = document.querySelectorAll("button").item(1);
    const target = targetFromElement(targetButton, document.body);
    expect(target.label).toBe("Delete project B");

    const controls = document.querySelector("div");
    if (!controls) throw new Error("labelled controls fixture is missing");
    controls.prepend(targetButton);

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.element.getAttribute("aria-labelledby") ?? null).not.toBe("noise project-a");
  });

  it("preserves distinguishing suffix references when accessible names share a long prefix", () => {
    document.body.innerHTML = `
      <span id="common">${"Shared destructive action context ".repeat(16)}</span>
      <span id="project-a">Project A</span>
      <span id="project-b">Project B</span>
      <div>
        <button aria-labelledby="common project-a">Delete</button>
        <button aria-labelledby="common project-b">Delete</button>
      </div>
    `;
    const targetButton = document.querySelectorAll("button").item(1);
    const target = targetFromElement(targetButton, document.body);
    expect(target.label).toContain("Project B");
    expect(target.label?.length).toBeLessThanOrEqual(200);

    const controls = document.querySelector("div");
    if (!controls) throw new Error("long labelled-controls fixture is missing");
    controls.prepend(targetButton);

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.element.getAttribute("aria-labelledby") ?? null).not.toBe("common project-a");
  });

  it("uses a unique aria-labelledby reference when distinguishing text is beyond the scan bound", () => {
    const common = "x".repeat(700);
    document.body.innerHTML = `
      <span id="label-a">${common} Project A</span>
      <span id="label-b">${common} Project B</span>
      <div>
        <button aria-labelledby="label-a">Delete</button>
        <button aria-labelledby="label-b">Delete</button>
      </div>
    `;
    const targetButton = document.querySelectorAll("button").item(1);
    const target = targetFromElement(targetButton, document.body);
    expect(target.cssPath).toBe('[aria-labelledby="label-b"]');

    const controls = document.querySelector("div");
    if (!controls) throw new Error("bounded semantic-selector fixture is missing");
    controls.prepend(targetButton);

    expect(resolveTarget(document.body, target)?.element.getAttribute("aria-labelledby")).toBe("label-b");
  });

  it("uses complete direct accessible-name identity when bounded labels collide", () => {
    const prefix = "shared-prefix-".repeat(30);
    const suffix = "-shared-suffix".repeat(30);
    const labelA = `${prefix}project-a${suffix}`;
    const labelB = `${prefix}project-b${suffix}`;
    document.body.innerHTML = `
      <button aria-label="${labelA}">Delete</button>
      <button aria-label="${labelB}">Delete</button>
    `;
    const target = targetFromElement(document.querySelectorAll("button").item(1), document.body);
    expect(target.label).toHaveLength(200);
    expect(target.semanticSignature).toMatch(/^a11y-v1:[a-f0-9]{64}$/);

    document.body.innerHTML = `
      <button aria-label="${labelB}">Delete</button>
      <button aria-label="${labelA}">Delete</button>
    `;

    expect(resolveTarget(document.body, target)?.element.getAttribute("aria-label")).toBe(labelB);
  });

  it.each(["alt", "title"] as const)(
    "does not redirect a long %s identity through a stale DOM path",
    (attribute) => {
      const prefix = "same-head-".repeat(30);
      const suffix = "-same-tail".repeat(30);
      const valueA = `${prefix}asset-a${suffix}`;
      const valueB = `${prefix}asset-b${suffix}`;
      const tag = attribute === "alt" ? "img" : "button";
      const content = attribute === "alt" ? "" : "Open";
      document.body.innerHTML = `
        <${tag} ${attribute}="${valueA}">${content}</${tag}>
        <${tag} ${attribute}="${valueB}">${content}</${tag}>
      `;
      const target = targetFromElement(document.querySelectorAll(tag).item(1), document.body);

      document.body.innerHTML = `
        <${tag} ${attribute}="${valueB}">${content}</${tag}>
        <${tag} ${attribute}="${valueA}">${content}</${tag}>
      `;

      expect(resolveTarget(document.body, target)?.element.getAttribute(attribute)).toBe(valueB);
    },
  );

  it("hashes the complete aria-labelledby association when IDs and text exceed selector scans", () => {
    const idPrefix = "label-".padEnd(1_980, "x");
    const idA = `${idPrefix}a`;
    const idB = `${idPrefix}b`;
    const textPrefix = "z".repeat(700);
    document.body.innerHTML = `
      <span id="${idA}">${textPrefix} Project A</span>
      <span id="${idB}">${textPrefix} Project B</span>
      <div>
        <button aria-labelledby="${idA}">Delete</button>
        <button aria-labelledby="${idB}">Delete</button>
      </div>
    `;
    const controls = document.querySelector("div");
    const targetButton = document.querySelectorAll("button").item(1);
    if (!controls) throw new Error("long labelledby fixture is missing");
    const target = targetFromElement(targetButton, document.body);
    expect(target.cssPath).not.toContain("aria-labelledby");
    expect(target.label).toBe(targetFromElement(document.querySelectorAll("button").item(0), document.body).label);

    controls.prepend(targetButton);

    expect(resolveTarget(document.body, target)?.element.getAttribute("aria-labelledby")).toBe(idB);
  });

  it("uses accessible-name precedence and detects changes across mixed sources", () => {
    document.body.innerHTML = `
      <span id="project-name">Project B</span>
      <button aria-label="Delete" aria-labelledby="project-name" title="Fallback">Delete</button>
    `;
    const button = document.querySelector("button");
    const referenced = document.querySelector("#project-name");
    if (!button || !referenced) throw new Error("mixed accessible-name fixture is missing");
    const target = targetFromElement(button, document.body);
    expect(target.label).toBe("Project B");
    referenced.textContent = "Project A";

    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("uses associated labels before title while retaining both as safety evidence", () => {
    document.body.innerHTML = `<label>Project B <input title="Fallback"></label>`;
    const input = document.querySelector("input");
    const label = document.querySelector("label");
    if (!input || !label) throw new Error("label/title precedence fixture is missing");
    const target = targetFromElement(input, document.body);
    expect(target.label).toBe("Project B");
    label.firstChild?.replaceWith("Project A ");

    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("bounds semantic scans, bypasses them for exact selectors, and reuses batch results", () => {
    document.body.innerHTML = Array.from(
      { length: 100 },
      (_, index) => `<button aria-label="Action ${index}">Run</button>`,
    ).join("");
    const target = targetFromElement(document.querySelectorAll("button").item(99), document.body);
    const noScan = createTargetResolutionContext(0);
    expect(resolveTarget(document.body, target, noScan)?.element.getAttribute("aria-label")).toBe("Action 99");
    expect(noScan.remainingIdentityCandidateChecks).toBe(0);

    document.body.innerHTML = `<img alt="One"><img alt="Two">`;
    const imageTarget = targetFromElement(document.querySelectorAll("img").item(1), document.body);
    const shared = createTargetResolutionContext(2);
    expect(resolveTarget(document.body, imageTarget, shared)?.element.getAttribute("alt")).toBe("Two");
    expect(shared.remainingIdentityCandidateChecks).toBe(0);
    expect(resolveTarget(document.body, imageTarget, shared)?.element.getAttribute("alt")).toBe("Two");

    const exhausted = createTargetResolutionContext(1);
    expect(resolveTarget(document.body, imageTarget, exhausted)).toBeNull();
  });

  it("rejects an over-budget same-tag collection before materializing it", () => {
    document.body.innerHTML = `<i title="Bounded target">Target</i>`;
    const element = document.querySelector("i");
    if (!element) throw new Error("over-budget candidate fixture is missing");
    const captured = targetFromElement(element, document.body);
    const target = { ...captured, cssPath: "", domPath: [], textQuote: undefined };
    const requestedIndexes: number[] = [];
    const overBudgetElement = document.createElement("i");
    Object.defineProperty(document.body, "getElementsByTagName", {
      configurable: true,
      value: () => ({
        item(index: number): Element | null {
          requestedIndexes.push(index);
          return overBudgetElement;
        },
        get length(): never {
          throw new Error("the full collection length must not be read");
        },
        [Symbol.iterator](): never {
          throw new Error("the over-budget collection must not be iterated");
        },
      }),
    });
    try {
      expect(resolveTarget(document.body, target, createTargetResolutionContext(2))).toBeNull();
      expect(requestedIndexes).toEqual([2]);
    } finally {
      Reflect.deleteProperty(document.body, "getElementsByTagName");
    }
  });

  it("indexes distinct fallback identities once so a valid marker batch is order-independent", () => {
    document.body.innerHTML = Array.from(
      { length: 100 },
      (_, index) => `<img alt="Ordinary image ${index}">`,
    ).join("");
    const images = Array.from(document.querySelectorAll("img"));
    const targets = images.map((image) => targetFromElement(image, document.body));
    const shared = createTargetResolutionContext();

    const resolved = targets.map((target) => resolveTarget(document.body, target, shared)?.element);

    expect(resolved).toEqual(images);
    expect(shared.remainingIdentityCandidateChecks).toBe(1_900);
  });

  it("charges a same-tag candidate set once across semantic and text identity modes", () => {
    document.body.innerHTML = [
      ...Array.from(
        { length: 1_000 },
        (_, index) => `<div title="Panel ${index}">Ordinary panel</div>`,
      ),
      `<div>Text-only target</div>`,
    ].join("");
    const elements = document.querySelectorAll("div");
    const semanticTarget = targetFromElement(elements.item(999), document.body);
    const textTarget = targetFromElement(elements.item(1_000), document.body);

    const semanticFirst = createTargetResolutionContext();
    expect(resolveTarget(document.body, semanticTarget, semanticFirst)?.element).toBe(elements.item(999));
    expect(resolveTarget(document.body, textTarget, semanticFirst)?.element).toBe(elements.item(1_000));
    expect(semanticFirst.remainingIdentityCandidateChecks).toBe(999);

    const textFirst = createTargetResolutionContext();
    expect(resolveTarget(document.body, textTarget, textFirst)?.element).toBe(elements.item(1_000));
    expect(resolveTarget(document.body, semanticTarget, textFirst)?.element).toBe(elements.item(999));
    expect(textFirst.remainingIdentityCandidateChecks).toBe(999);
  });

  it("does not spend a semantic target's budget on unused nested text indexes", () => {
    document.body.innerHTML = `
      <div><div><div>${"x".repeat(1_048_575)}</div></div></div>
      <div title="Distinct target">Target element</div>
    `;
    const targetElement = document.querySelectorAll("div").item(3);
    const target = targetFromElement(targetElement, document.body);
    const context = createTargetResolutionContext();

    expect(target.semanticSignature).toBeTruthy();
    expect(resolveTarget(document.body, target, context)?.element).toBe(targetElement);
    expect(context.remainingIdentityCandidateChecks).toBe(1_996);
    expect(context.remainingIdentityTextUnits).toBeGreaterThan(6_000_000);
  });

  it("indexes text identity only for elements that would capture text identity", () => {
    document.body.innerHTML = `<div>Shared text</div><div title="Labeled">Shared text</div>`;
    const textTarget = targetFromElement(document.querySelectorAll("div").item(0), document.body);

    expect(textTarget.textSignature).toBeTruthy();
    expect(resolveTarget(document.body, textTarget)?.element).toBe(document.querySelectorAll("div").item(0));
  });

  it("builds one bounded heading index for a repeated marker batch", () => {
    document.body.innerHTML = `${Array.from(
      { length: 2_000 },
      (_, index) => `<h2>Section ${index}</h2>`,
    ).join("")}<div>Unique target</div>`;
    const targetElement = document.querySelector("div");
    if (!targetElement) throw new Error("heading batch fixture target is missing");
    const target = targetFromElement(targetElement, document.body);
    const shared = createTargetResolutionContext();

    expect(resolveTarget(document.body, target, shared)?.element).toBe(targetElement);
    const remainingAfterFirst = shared.remainingHeadingElementChecks;
    for (let index = 1; index < 150; index += 1) {
      expect(resolveTarget(document.body, target, shared)?.element).toBe(targetElement);
    }
    expect(shared.remainingHeadingElementChecks).toBe(remainingAfterFirst);

    const bounded = createTargetResolutionContext(
      2_000,
      6 * 1024 * 1024,
      12 * 1024 * 1024,
      100_000,
      10,
      1_000,
    );
    expect(headingPathForElement(targetElement, bounded)).toEqual([]);
    expect(bounded.remainingHeadingElementChecks).toBe(0);
  });

  it("uses the same caller-supplied visible heading labels for capture and resolution", () => {
    document.body.innerHTML = `
      <main>
        <h1>Visible section</h1>
        <h2 id="clipped-heading">Clipped section</h2>
        <p>Unique visible target</p>
      </main>
    `;
    const paragraph = document.querySelector("p");
    if (!paragraph) throw new Error("visible-heading fixture target is missing");
    const visibleHeadingLabel = (element: Element): string | undefined =>
      element.id === "clipped-heading" ? undefined : element.textContent ?? undefined;
    const capture = createTargetResolutionContext();
    capture.headingLabelForElement = visibleHeadingLabel;

    const target = targetFromElement(paragraph, document.body, capture);
    expect(target.headingPath).toEqual(["Visible section"]);

    const resolution = createTargetResolutionContext();
    resolution.headingLabelForElement = visibleHeadingLabel;
    expect(resolveTarget(document.body, target, resolution)?.element).toBe(paragraph);
  });

  it("bounds target recapture text and structural path work independently", () => {
    document.body.innerHTML = `<div title="Stable target">${" ".repeat(20_000)}</div>`;
    const targetElement = document.querySelector("div");
    if (!targetElement) throw new Error("bounded recapture fixture target is missing");
    const textBounded = createTargetResolutionContext(
      2_000,
      6 * 1024 * 1024,
      12 * 1024 * 1024,
      100_000,
      100_000,
      2 * 1024 * 1024,
      100_000,
      1_024,
    );

    const captured = targetFromElement(targetElement, document.body, textBounded);

    expect(captured.semanticSignature).toBeTruthy();
    expect(captured.textQuote).toBeUndefined();
    expect(textBounded.remainingCaptureTextUnits).toBe(0);

    document.body.innerHTML = Array.from(
      { length: 3_000 },
      (_, index) => `<span${index === 2_999 ? ' title="Stable target"' : ""}>${index}</span>`,
    ).join("");
    const last = document.querySelectorAll("span").item(2_999);
    const pathBounded = createTargetResolutionContext(
      2_000,
      6 * 1024 * 1024,
      12 * 1024 * 1024,
      100_000,
      100_000,
      2 * 1024 * 1024,
      10,
      6 * 1024 * 1024,
    );
    const structurallyBounded = targetFromElement(last, document.body, pathBounded);

    expect(structurallyBounded.semanticSignature).toBeTruthy();
    expect(structurallyBounded.cssPath).toBe("");
    expect(structurallyBounded.domPath).toEqual([]);
    expect(pathBounded.remainingCaptureNodeChecks).toBe(0);
  });

  it("tries a valid pinned range before bounded repetitive quote fallback", () => {
    document.body.innerHTML = `<p>${"a".repeat(200_000)}</p>`;
    const text = document.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("repetitive text fixture is missing");
    const range = document.createRange();
    range.setStart(text, 100_000);
    range.setEnd(text, 100_001);
    const target = targetFromRange(range, document.body);

    expect(resolveTarget(document.body, target)?.strategy).toBe("range-path");
    expect(() => resolveTarget(document.body, { ...target, range: undefined })).not.toThrow();
    expect(resolveTarget(document.body, { ...target, range: undefined })).toBeNull();
  });

  it("fails closed without expanding extreme accessible-name reference lists", () => {
    const button = document.createElement("button");
    button.setAttribute("aria-labelledby", "missing ".repeat(100_000));
    button.textContent = "Review";
    document.body.append(button);

    const target = targetFromElement(button, document.body);

    expect(target.identityUnresolvable).toBe(true);
    expect(target.semanticSignature).toBeUndefined();
    expect(resolveTarget(document.body, target)).toBeNull();
  });

  it("uses complete associated-label identity and fails closed for legacy bounded collisions", () => {
    const prefix = "shared field context ".repeat(45);
    const suffix = " shared ending".repeat(20);
    document.body.innerHTML = `
      <div>
        <label>${prefix}account-a${suffix}<input></label>
        <label>${prefix}account-b${suffix}<input></label>
      </div>
    `;
    const container = document.querySelector("div");
    const secondLabel = document.querySelectorAll("label").item(1);
    const target = targetFromElement(document.querySelectorAll("input").item(1), document.body);
    if (!container) throw new Error("associated-label fixture is missing");
    container.prepend(secondLabel);
    expect(resolveTarget(document.body, target)?.element.closest("label")?.textContent).toContain("account-b");

    const legacyTarget = { ...target };
    delete legacyTarget.semanticSignature;
    expect(resolveTarget(document.body, legacyTarget)).toBeNull();
  });

  it("marks a removed text selection unresolved", () => {
    document.body.innerHTML = `<p>Alpha beta gamma delta omega.</p>`;
    const text = document.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("fixture text is missing");
    const range = document.createRange();
    range.setStart(text, 11);
    range.setEnd(text, 22);
    const target = targetFromRange(range, document.body);

    document.body.innerHTML = `<p>Alpha beta omega.</p>`;

    expect(resolveTarget(document.body, target)).toBeNull();
  });
});
