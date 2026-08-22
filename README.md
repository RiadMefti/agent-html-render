# Agent HTML Render

[![CI](https://github.com/RiadMefti/agent-html-render/actions/workflows/ci.yml/badge.svg)](https://github.com/RiadMefti/agent-html-render/actions/workflows/ci.yml)

Point to the exact part. Tell the agent what to change.

Agent HTML Render opens agent-written HTML in a local browser. Comment on an element or exact text, send one feedback batch, and review the next revision on the same page.

It works with Codex, Claude Code, OpenCode, and any other agent that can run a CLI. Artifacts stay as ordinary HTML, and reviews need no account or hosted service.

## Install the project skill

Agent HTML Render requires Node.js 20.19 or newer. Run this once in each repository:

```bash
npx --yes --prefer-online agent-html-render@latest install-skill
```

The command writes the shared skill to `.agents/skills/agent-html-render` for Codex and OpenCode, then links Claude Code to it from `.claude/skills/agent-html-render`. It leaves an existing, different skill untouched.

The skill runs `agent-html-render@latest` through `npx`. There is no global install or manual update step.

Ask your agent:

> Create a reviewable rollout plan with Agent HTML Render. Keep the HTML self-contained and wait for my feedback.

## How a review works

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

Use **Send to Agent** for another revision or **Send & End** to close the session. The header shows whether feedback is saving, waiting for an agent command, received by the agent, or followed by a new revision. A failed send leaves the draft ready to retry.

The artifact stays interactive. Choose **Annotate** to select an element or exact text, then open **Review** to inspect and send the batch. Click a numbered marker or its row in **Review** to edit or remove an annotation.

After **Send to Agent**, a small status message says whether the feedback is still queued or has reached the agent. It disappears when the next revision arrives.

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

## HTML artifacts

- HTML remains ordinary, portable, and self-contained.
- Follow the user's direction or the project's design system. The bundled theme is a fallback.
- Give important regions stable `data-agent-html-render-id` values so annotations survive revisions.
- Inline CSS is supported. Authored scripts, forms, frames, navigation, and network requests are blocked by default.
- Reviewable artifacts must be `.html` files inside the project and no larger than 5 MB.

## Feedback output

Each send writes a revision-bound envelope to stdout:

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

Annotations include stable IDs, DOM and CSS paths, text quotes, and heading context so they can reattach after revisions. Feedback stays queued until the agent command acknowledges it, so rerunning an interrupted command does not lose the batch.

Reviewer instructions and artifact excerpts stay separate. The output labels artifact text as untrusted reference context.

## Security model

- The daemon listens only on `127.0.0.1`.
- Agent and reviewer access use separate random secrets.
- Canonical path checks keep artifacts inside the project root.
- The artifact iframe has no same-origin access.
- A restrictive CSP blocks authored scripts and network access; only the nonce-protected selection bridge runs.
- Runtime messages and feedback payloads are validated and bounded.
- Session files are written under `.agent-html-render/` with private permissions and are ignored by Git.

Agent HTML Render v0.3 supports one reviewer on the local machine. Accounts, cloud sync, hosted sharing, and multiplayer review are out of scope.

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

`test:all` runs type checking, unit tests, the production Chromium flow, and local smoke checks for Codex, Claude Code, and OpenCode. All three agent CLIs must be installed.

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending a patch. Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/RiadMefti/agent-html-render/security/advisories/new).

## License

MIT © Riad Mefti and Agent HTML Render contributors.
