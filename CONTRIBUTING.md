# Contributing to Agent HTML Render

Thanks for helping improve Agent HTML Render. Keep contributions local-first, vendor-neutral, and small enough to review.

## Development setup

Agent HTML Render requires Node.js 20.19 or newer.

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

The host smoke check expects Codex, Claude Code, and OpenCode to be available on `PATH`. If you cannot run one of them, state that clearly in the pull request.

## Engineering expectations

- Agents produce ordinary HTML. Do not add a proprietary artifact schema or a host-specific runtime.
- Preserve loopback-only transport, sandboxing, canonical path checks, runtime validation, bounded payloads, and reviewer/artifact trust separation.
- Keep the review shell visually restrained: `#fafafa`, `#171717`, system typography, hairline separators, and flat text actions.
- Do not impose the shell layout or fallback theme on agent-authored artifacts.
- Add focused tests for behavior changes. Security-boundary changes need both positive and negative coverage.
- Do not commit `dist/`, `.agent-html-render/`, legacy `.agentlens/` or `.agentrender/`, browser reports, credentials, or local review URLs containing access tokens.

## Pull requests

Keep each pull request focused. Explain the user-visible outcome, security implications, and verification performed. Screenshots are useful for review-shell changes, but avoid including private artifact content.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
