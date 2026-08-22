# AgentRender default theme

Use this visual grammar when neither the user nor the project supplies one. It comes from the `agent-orchestrator` interface and is deliberately a theme rather than a page template.

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
- Use centered reading widths near `940px` when the content is document-like; choose another layout when the subject calls for it.
- Set primary headings around `28–42px`, weight `550`, with restrained negative letter spacing. Keep body copy around `13–15px` with generous line height.
- Use `--muted` for context and secondary copy, `--quiet` for placeholders, and `--faint` for rules.
- Keep actions transparent and text-led. A primary action may use a 1px bottom border; it does not need a filled button.
- When a dialog is useful, use `#fafafa`, a `1px solid #dcdcdc` border, and at most `0 18px 60px rgb(0 0 0 / 6%)` shadow.
- Avoid gradients, ornamental logo tiles, pill badges, oversized hero type, and repeated rounded cards unless the content or the user's design direction genuinely calls for them.

Adapt these choices to the artifact. Do not reproduce an application shell or force every subject into the same component arrangement.
