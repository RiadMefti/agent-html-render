# Agent HTML Render

[![CI](https://github.com/RiadMefti/agent-html-render/actions/workflows/ci.yml/badge.svg)](https://github.com/RiadMefti/agent-html-render/actions/workflows/ci.yml)

Point at the exact part. Tell the agent what should change.

Agent HTML Render is a local visual review loop for coding agents. An agent writes an ordinary HTML file, Agent HTML Render opens it in a safe review surface, and you attach comments to elements or exact text. The agent receives bounded, structured feedback and revises the same file.

It works with Codex, Claude Code, OpenCode, and any other agent that can run a CLI. There is no account, hosted artifact format, proprietary schema, or vendor-specific runtime.

## Why Agent HTML Render

- **Ordinary HTML.** Agents use the web platform instead of a proprietary artifact format.
- **Precise feedback.** Comments retain stable IDs, DOM paths, CSS paths, text quotes, and heading context.
- **Visible handoff.** The shell shows when feedback is sending, queued, received by the agent, or followed by a revision.
- **Local first.** The server binds to loopback, session state stays in the project, and artifacts run in a sandboxed iframe.
- **Vendor neutral.** One review command and one portable skill work across coding-agent hosts.

## Quick start

Agent HTML Render requires Node.js 20.19 or newer. Install its project skill without installing a global package:

```bash
npx --yes --prefer-online agent-html-render@latest install-skill
```

This installs the canonical skill at `.agents/skills/agent-html-render` for Codex and OpenCode, then links `.claude/skills/agent-html-render` to it for Claude Code. Existing, different skills are never overwritten.

The npm package, executable, and skill all use `agent-html-render`. The skill invokes `agent-html-render@latest` through `npx`, so there is no global installation to maintain. npm checks for the current release and reuses its local cache when possible.

Now ask your agent:

> Create a reviewable rollout plan with Agent HTML Render. Keep the HTML self-contained and wait for my feedback.

The agent creates an HTML file, starts the review command, and waits while you annotate it.

## Review loop

```text
agent writes HTML
        ↓
Agent HTML Render opens a local review
        ↓
you select elements or text and send comments
        ↓
the agent receives structured feedback and revises the file
        ↺
```

Use **Send to Agent** for another revision or **Send & End** to close the session. The activity strip distinguishes these states:

- feedback is being saved;
- feedback is queued but no agent command has picked it up;
- the agent command received the batch and Agent HTML Render is waiting for a revision;
- a new revision is ready to inspect;
- delivery failed and the draft remains available to retry.

## CLI

Review any self-contained HTML file inside the project:

```bash
npx --yes --prefer-online agent-html-render@latest review examples/plan.html
```

| Command | Purpose |
| --- | --- |
| `agent-html-render review <file.html>` | Open or resume a review and wait for one feedback batch |
| `agent-html-render status` | Show the local daemon and active sessions without exposing secrets |
| `agent-html-render stop` | Stop the project-local daemon |
| `agent-html-render install-skill` | Install the portable project skill |

Use `--format markdown` when an agent prefers readable feedback instead of JSON. Use `--no-open` in headless environments and open the printed loopback URL manually.

## Artifact contract

- HTML remains ordinary, portable, and self-contained.
- Project design systems and user direction take precedence. The bundled minimal theme is only a fallback.
- Important regions should use stable `data-agent-html-render-id` values so annotations survive revisions.
- Inline CSS is supported. Authored scripts, forms, frames, navigation, and network requests are blocked by default.
- Reviewable artifacts must be `.html` files inside the project and no larger than 5 MB.

## Feedback contract

Each send returns a revision-bound envelope on stdout:

```json
{
  "sequence": 1,
  "feedback": {
    "status": "feedback",
    "session": { "revision": 1 },
    "reviewerMessage": "Tighten the rollout scope.",
    "annotations": [
      {
        "comment": "Remove the private beta phase.",
        "resolution": "attached",
        "target": { "stableId": "rollout-beta", "text": "Private beta" }
      }
    ]
  }
}
```

Reviewer instructions are separated from artifact excerpts. Artifact text is explicitly labeled as untrusted reference context before it reaches the agent.

## Security model

- The daemon listens only on `127.0.0.1`.
- Agent and reviewer access use separate random secrets.
- Canonical path checks keep artifacts inside the project root.
- The artifact iframe has no same-origin access.
- A restrictive CSP blocks authored scripts and network access; only the nonce-protected selection bridge runs.
- Runtime messages and feedback payloads are validated and bounded.
- Session files are written under `.agent-html-render/` with private permissions and are ignored by Git.

Agent HTML Render v0.2 is intentionally local and single-reviewer. It does not provide accounts, cloud sync, hosted sharing, or multiplayer review.

## Migrating from AgentLens or the AgentRender preview

Agent HTML Render replaces the former `@rimef/agentlens` package and `agentlens` command. It also replaces the short-lived, unpublished AgentRender preview.

1. Run `npx --yes --prefer-online agent-html-render@latest install-skill` in the project.
2. Verify the new `.agents/skills/agent-html-render` skill, then remove legacy `agentlens` or `agentrender` skill entries if they contain no custom work.
3. Start new reviews with `npx --yes --prefer-online agent-html-render@latest review <file.html>`.

Existing `data-agentlens-id` and pre-release `data-agentrender-id` anchors remain readable and reattach when changed to the equivalent `data-agent-html-render-id`. In-progress `.agentlens/` and `.agentrender/` daemon sessions are not imported because their URLs contain version-specific bearer credentials. Stop the old daemon and reopen the artifact with Agent HTML Render. Do not delete either directory without checking it for user-authored HTML first.

## Development

```bash
git clone https://github.com/RiadMefti/agent-html-render.git
cd agent-html-render
npm ci
npm run test:all
npm pack --dry-run
```

`test:all` runs type checking, unit tests, the production Chromium review flow, and strict local smoke checks for Codex, Claude Code, and OpenCode. The three agent CLIs must be installed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development expectations. Please report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/RiadMefti/agent-html-render/security/advisories/new), not a public issue.

## License

MIT © Riad Mefti and Agent HTML Render contributors.
