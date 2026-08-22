// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  cssPathForElement,
  resolveTarget,
  targetFromElement,
  targetFromRange,
} from "../../src/shared/anchors.js";

describe("durable target anchors", () => {
  it("anchors descendant paths to the nearest stable review region", () => {
    document.body.innerHTML = `
      <main>
        <article data-agentrender-id="phase-offer"><div><h2>Offer</h2></div></article>
      </main>
    `;
    const heading = document.querySelector("h2");
    if (!heading) throw new Error("fixture heading is missing");

    expect(cssPathForElement(heading)).toBe('[data-agentrender-id="phase-offer"] > div > h2');
    const target = targetFromElement(heading, document.body);

    document.body.innerHTML = `
      <main>
        <p>A new introduction.</p>
        <article data-agentrender-id="phase-offer"><div><h2>Invite</h2></div></article>
      </main>
    `;

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.strategy).toBe("css-path");
    expect(resolved?.element.textContent).toBe("Invite");
  });

  it("reattaches legacy AgentLens IDs after an artifact adopts AgentRender IDs", () => {
    document.body.innerHTML = `
      <article data-agentlens-id="phase-offer"><h2>Offer</h2></article>
    `;
    const article = document.querySelector("article");
    if (!article) throw new Error("fixture article is missing");
    const target = targetFromElement(article, document.body);

    document.body.innerHTML = `
      <article data-agentrender-id="phase-offer"><h2>Invite</h2></article>
    `;

    const resolved = resolveTarget(document.body, target);
    expect(resolved?.strategy).toBe("stable-id");
    expect(resolved?.element.textContent).toBe("Invite");
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
