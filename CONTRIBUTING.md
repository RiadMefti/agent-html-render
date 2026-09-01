# Contributing to Agent HTML Render

Keep changes local-first, vendor-neutral, and small enough to review.

## Development setup

Agent HTML Render requires Linux for the full daemon workflow plus Node.js 22.22.2+ on Node 22, Node.js 24.15+ on Node 24, or Node.js 26.

```bash
npm ci
npm run build
```

Run a local review from the repository root:

```bash
node dist/node/cli.js review examples/plan.html
```

## Before opening a pull request

Run the complete local verification:

```bash
npm run test:all
npm pack --dry-run
```

The host smoke check expects Codex, Claude Code, and OpenCode on `PATH`. List any host you could not test in the pull request.

## Engineering expectations

- Agents produce ordinary HTML. Do not add a proprietary artifact schema or a host-specific runtime.
- Preserve loopback-only transport, sandboxing, canonical path checks, runtime validation, bounded payloads, and reviewer/artifact trust separation.
- Keep the review shell visually restrained: `#fafafa`, `#171717`, system typography, hairline separators, and flat text actions.
- Do not impose the shell layout or fallback theme on agent-authored artifacts.
- Add focused tests for behavior changes. Security-boundary changes need both positive and negative coverage.
- Do not commit `dist/`, `.agent-html-render/`, legacy `.agentlens/` or `.agentrender/`, browser reports, credentials, or local review URLs containing access tokens.

## Pull requests

Keep each pull request focused. Explain what changes for the user, note any security impact, and list the checks you ran. Include screenshots for review-shell changes when they help, but remove private artifact content.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
