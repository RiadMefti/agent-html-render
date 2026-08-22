# AgentLens

[![CI](https://github.com/RiadMefti/agentlens/actions/workflows/ci.yml/badge.svg)](https://github.com/RiadMefti/agentlens/actions/workflows/ci.yml)

Point at the exact part. Tell the agent what should change.

AgentLens is a local HTML review loop for coding agents. An agent writes an ordinary HTML file, AgentLens opens it in a safe review surface, and you attach comments to elements or exact text. The agent receives bounded, structured feedback and revises the same file.

It works with Codex, Claude Code, OpenCode, and any other agent that can run a CLI. There is no account, hosted artifact format, or vendor-specific runtime.

## Why AgentLens

- **Ordinary HTML.** Agents use the web platform instead of a proprietary artifact schema.
- **Precise feedback.** Comments retain stable IDs, DOM paths, CSS paths, text quotes, and heading context.
- **Visible handoff.** The shell shows when feedback is sending, queued, picked up by the agent, or followed by a new revision.
- **Local first.** The server binds to loopback, session state stays in the project, and artifacts run in a sandboxed iframe.
- **Vendor neutral.** One review command and one portable skill work across coding-agent hosts.

## Use in a project

AgentLens requires Node.js 20.19 or newer.

```bash
npx --yes --prefer-online @rimef/agentlens@latest install-skill
```

This installs the canonical skill at `.agents/skills/agentlens` for Codex and OpenCode, then links `.claude/skills/agentlens` to it for Claude Code. Existing, different skills are never overwritten.

The skill invokes `@rimef/agentlens@latest` through `npx`, so there is no global installation to maintain. npm checks for the current release and reuses its local cache when possible. The unscoped `agentlens` package on npm is unrelated to this project.

Now ask your agent for a reviewable artifact:

> Create a reviewable rollout plan with AgentLens. Keep the HTML self-contained and wait for my feedback.

The agent will create an HTML file, run the review command, and pause while you annotate it.

## Review loop

```text
agent writes HTML
        ↓
AgentLens opens a local review
        ↓
you select elements or text and send comments
        ↓
the agent receives structured feedback and revises the file
        ↺
```

Use **Send to Agent** for another revision or **Send & End** to close the session. The activity strip distinguishes these states:

- feedback is being saved;
- feedback is queued but no agent command has picked it up;
- the agent command received the batch and AgentLens is waiting for a revision;
- a new revision is ready to inspect;
- delivery failed and the draft is still available to retry.

## Use the CLI directly

Any self-contained HTML file inside the project can be reviewed:

```bash
npx --yes --prefer-online @rimef/agentlens@latest review examples/plan.html
```

| Command | Purpose |
| --- | --- |
| `agentlens review <file.html>` | Open or resume a review and wait for one feedback batch |
| `agentlens status` | Show the local daemon and active sessions without exposing secrets |
| `agentlens stop` | Stop the project-local daemon |
| `agentlens install-skill` | Install the portable project skill |

Use `--format markdown` when an agent prefers readable feedback instead of JSON. Use `--no-open` in headless environments and open the printed loopback URL manually.

## Artifact contract

- HTML remains ordinary, portable, and self-contained.
- Project design systems and user direction take precedence. The bundled minimal theme is only a fallback.
- Important regions should use stable `data-agentlens-id` values so annotations survive revisions.
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
- Session files are written under `.agentlens/` with private permissions and are ignored by Git.

AgentLens v0.1 is intentionally local and single-reviewer. It does not provide accounts, cloud sync, hosted sharing, or multiplayer review.

## Development

```bash
git clone https://github.com/RiadMefti/agentlens.git
cd agentlens
npm ci
npm run test:all
npm pack --dry-run
```

`test:all` runs type checking, unit tests, the production Chromium review flow, and local smoke checks for Codex, Claude Code, and OpenCode. The three agent CLIs must be installed for the host smoke check.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development expectations. Please report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/RiadMefti/agentlens/security/advisories/new), not a public issue.

## License

MIT © Riad Mefti and AgentLens contributors.
