# AgentRender

[![CI](https://github.com/RiadMefti/agentrender/actions/workflows/ci.yml/badge.svg)](https://github.com/RiadMefti/agentrender/actions/workflows/ci.yml)

Point at the exact part. Tell the agent what should change.

AgentRender is a local visual review loop for coding agents. An agent writes an ordinary HTML file, AgentRender opens it in a safe review surface, and you attach comments to elements or exact text. The agent receives bounded, structured feedback and revises the same file.

It works with Codex, Claude Code, OpenCode, and any other agent that can run a CLI. There is no account, hosted artifact format, proprietary schema, or vendor-specific runtime.

## Why AgentRender

- **Ordinary HTML.** Agents use the web platform instead of a proprietary artifact format.
- **Precise feedback.** Comments retain stable IDs, DOM paths, CSS paths, text quotes, and heading context.
- **Visible handoff.** The shell shows when feedback is sending, queued, received by the agent, or followed by a revision.
- **Local first.** The server binds to loopback, session state stays in the project, and artifacts run in a sandboxed iframe.
- **Vendor neutral.** One review command and one portable skill work across coding-agent hosts.

## Quick start

AgentRender requires Node.js 20.19 or newer. Install its project skill without installing a global package:

```bash
npx --yes --prefer-online agentrender@latest install-skill
```

This installs the canonical skill at `.agents/skills/agentrender` for Codex and OpenCode, then links `.claude/skills/agentrender` to it for Claude Code. Existing, different skills are never overwritten.

The skill invokes `agentrender@latest` through `npx`, so there is no global installation to maintain. npm checks for the current release and reuses its local cache when possible.

Now ask your agent:

> Create a reviewable rollout plan with AgentRender. Keep the HTML self-contained and wait for my feedback.

The agent creates an HTML file, starts the review command, and waits while you annotate it.

## Review loop

```text
agent writes HTML
        ↓
AgentRender opens a local review
        ↓
you select elements or text and send comments
        ↓
the agent receives structured feedback and revises the file
        ↺
```

Use **Send to Agent** for another revision or **Send & End** to close the session. The activity strip distinguishes these states:

- feedback is being saved;
- feedback is queued but no agent command has picked it up;
- the agent command received the batch and AgentRender is waiting for a revision;
- a new revision is ready to inspect;
- delivery failed and the draft remains available to retry.

## CLI

Review any self-contained HTML file inside the project:

```bash
npx --yes --prefer-online agentrender@latest review examples/plan.html
```

| Command | Purpose |
| --- | --- |
| `agentrender review <file.html>` | Open or resume a review and wait for one feedback batch |
| `agentrender status` | Show the local daemon and active sessions without exposing secrets |
| `agentrender stop` | Stop the project-local daemon |
| `agentrender install-skill` | Install the portable project skill |

Use `--format markdown` when an agent prefers readable feedback instead of JSON. Use `--no-open` in headless environments and open the printed loopback URL manually.

## Artifact contract

- HTML remains ordinary, portable, and self-contained.
- Project design systems and user direction take precedence. The bundled minimal theme is only a fallback.
- Important regions should use stable `data-agentrender-id` values so annotations survive revisions.
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
- Session files are written under `.agentrender/` with private permissions and are ignored by Git.

AgentRender v0.2 is intentionally local and single-reviewer. It does not provide accounts, cloud sync, hosted sharing, or multiplayer review.

## Migrating from AgentLens

AgentRender replaces the former `@rimef/agentlens` package and `agentlens` command.

1. Run `npx --yes --prefer-online agentrender@latest install-skill` in the project.
2. Verify the new `.agents/skills/agentrender` skill, then remove legacy `.agents/skills/agentlens` and `.claude/skills/agentlens` entries if they contain no custom work.
3. Start new reviews with `npx --yes --prefer-online agentrender@latest review <file.html>`.

Existing `data-agentlens-id` anchors remain readable and reattach when changed to the equivalent `data-agentrender-id`. In-progress `.agentlens/` daemon sessions are not imported because their URLs contain version-specific bearer credentials. Stop the old daemon and reopen the artifact with AgentRender. Do not delete `.agentlens/` without checking it for user-authored HTML first.

## Development

```bash
git clone https://github.com/RiadMefti/agentrender.git
cd agentrender
npm ci
npm run test:all
npm pack --dry-run
```

`test:all` runs type checking, unit tests, the production Chromium review flow, and strict local smoke checks for Codex, Claude Code, and OpenCode. The three agent CLIs must be installed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development expectations. Please report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/RiadMefti/agentrender/security/advisories/new), not a public issue.

## License

MIT © Riad Mefti and AgentRender contributors.
