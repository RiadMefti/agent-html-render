# Agent HTML Render default theme

Use these defaults only when the user and project provide no design direction. They come from the `agent-orchestrator` interface and do not prescribe a page layout.

## Tokens

```css
:root {
  color-scheme: light;
  --background: #fafafa;
  --text: #171717;
  --muted: #858585;
  --quiet: #a6a6a6;
  --faint: #e9e9e9;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--text);
  background: var(--background);
  font-family: var(--font);
  -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; }
:focus-visible { outline: 1px solid var(--text); outline-offset: 2px; }
```

## Visual grammar

- Prefer plain typography, whitespace, and 1px separators over decorative containers.
- Use a centered reading width near `940px` for documents. Choose another layout for diagrams, comparisons, dashboards, or other structures that need it.
- Set primary headings around `28–42px`, weight `550`, with restrained negative letter spacing. Keep body copy around `13–15px` with generous line height.
- Use `--muted` for context and secondary copy, `--quiet` for placeholders, and `--faint` for rules.
- Keep actions transparent and text-led. A primary action may use a 1px bottom border; it does not need a filled button.
- For dialogs, use `#fafafa`, a `1px solid #dcdcdc` border, and at most `0 18px 60px rgb(0 0 0 / 6%)` shadow.
- Avoid gradients, ornamental logo tiles, pill badges, oversized hero type, and repeated rounded cards unless the user or project asks for them.

Adapt the theme to the artifact. Do not copy an application shell or force each subject into the same components.
