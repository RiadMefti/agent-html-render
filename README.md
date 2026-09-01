# Agent HTML Render

[![CI](https://github.com/RiadMefti/agent-html-render/actions/workflows/ci.yml/badge.svg)](https://github.com/RiadMefti/agent-html-render/actions/workflows/ci.yml)

Review the plan before the agent turns it into code.

Agent HTML Render gives agent-authored technical artifacts a local browser review loop. Point at an element or exact text, explain what should change, and verify the next revision without translating everything back into chat.

It is useful for implementation plans, architecture decisions, migrations, threat models, API comparisons, rollout proposals, and diagrams. The artifact is ordinary HTML. There is no account, cloud service, telemetry, proprietary artifact schema, or host-specific runtime.

## Try it in 30 seconds

Requires Linux and Node.js `22.22.2+` on Node 22, `24.15+` on Node 24, or Node 26. The beta fails closed on other operating systems until they have a collision-free startup coordinator.

```bash
npx --yes --prefer-online agent-html-render@latest demo
```

The demo opens a sample plan. Choose **Annotate**, select an element, add a comment, then open **Review** and choose **Send & End**. For a keyboard-only review, activate **Annotate**, use Tab, Shift+Tab, or the arrow keys to move the visible target outline, press Enter or Space for the element, or Shift+Enter for its exact text; Escape returns to **Annotate**. The generated demo file is kept under `.agent-html-render/` and ignored by Git.

If something is not ready, run:

```bash
npx --yes --prefer-online agent-html-render@latest doctor
```

`doctor` is read-only. It verifies that a running daemon owns the matching lifetime coordinator and still has its pinned private-state directories, reports a live or hung coordinator, and detects a legacy startup lock left by an interrupted older build with the exact path plus safe manual-removal guidance. Any mismatch marks the core workflow unavailable and includes stop/restart guidance.

## Let your coding agent use it

Install the project skill once per repository:

```bash
npx --yes --prefer-online agent-html-render@latest install-skill
```

The installer writes the canonical skill to `.agents/skills/agent-html-render`, which Codex and OpenCode discover, and adds a Claude Code adapter at `.claude/skills/agent-html-render`. Future installs replace an unchanged managed skill as one staged tree and refuse to overwrite user edits or user-added filesystem entries. An update retains the prior managed tree under `.agent-html-render/skill-backups/`, outside every host's skill-discovery root, so a save from an editor that still has an old file open remains recoverable; the command reports the exact path to remove after those editors are closed.

Then ask your agent for a reviewable artifact:

> Create a reviewable migration plan with Agent HTML Render. Show dependencies, rollback points, and open decisions. Wait for my feedback before implementation.

Other useful prompts:

- “Compare these two API designs and make the tradeoffs reviewable.”
- “Create a threat model for this flow. Separate trust boundaries, attack paths, and mitigations.”
- “Turn the rollout plan into a sequence I can annotate before you change code.”
- “Show the proposed architecture and unresolved decisions, then wait for review.”

## The review loop

```text
agent writes ordinary HTML
            ↓
you annotate an element or exact text
            ↓
agent receives one revision-bound feedback batch
            ↓
agent revises the same file
            ↓
you verify each requested change in Review Changes
            ↺
```

The artifact remains fully readable while the review shell stays out of its layout. Keyboard target traversal is bounded and lives in the sandbox bridge: it does not add `tabindex`, controls, or layout to agent-authored HTML, skips effectively transparent, CSS-hidden, clipped, masked, covered, or persistently off-screen targets, and gives the trusted shell only bounded text whose visible fragments survive viewport, ancestor-clipping, and topmost paint checks. Partially visible long prose remains available through its proven-visible fragments. The same proof governs exact selection, outlines, anchor recapture, saved context, and visible heading context, so rejected artifact text does not enter agent feedback. Stable `data-agent-html-render-id` anchors let comments follow content across revisions. Accessible-name anchors retain a bounded SHA-256 identity and fail closed unless the semantic match is unique, so long labels cannot redirect a comment after reordering. Exact-text annotations may span up to 1,200 characters; keyboard exact-text selection still fails closed when hidden or clipped content would make the passage discontinuous. In that case, annotate the containing element instead.

After a new revision arrives, **Review Changes** shows the original request, the earlier target, and the target as it resolves now. Mark each item **Resolved**, **Still needs work**, or **Dismiss**. “Still needs work” adds the original request back to the next feedback batch without duplicating it repeatedly.

Feedback is bound to the revision you reviewed. If the artifact changes while you are writing, sending pauses until you inspect the new revision and explicitly keep the notes. Failed sends preserve the draft. Submitted feedback remains queued until an agent command receives and acknowledges it.

Use **Send to Agent** to request another revision. Use **Send & End** when the artifact is ready. An ended review stays ended; start another intentionally with `review --new`.

## CLI

```bash
npx --yes --prefer-online agent-html-render@latest review examples/plan.html
```

| Command | Purpose |
| --- | --- |
| `agent-html-render demo` | Open the bundled sample with no setup |
| `agent-html-render review <file.html>` | Open or resume a review and wait for one feedback batch |
| `agent-html-render review <file.html> --new` | Start a new session after an ended review, or open a replacement artifact with preserved unsent notes after an explicit parent-directory warning |
| `agent-html-render doctor` | Report runtime, project, daemon, skill, and host readiness |
| `agent-html-render status` | Show safe daemon and session status without credentials |
| `agent-html-render stop` | Stop the project-local daemon |
| `agent-html-render install-skill` | Install or safely update the portable project skill |

Use `--format markdown` for readable agent output instead of JSON. Use `--no-open` in headless environments and open the printed loopback URL manually. `doctor --format json` is suitable for automated environment checks.

## What belongs in an artifact

Use Agent HTML Render when structure or location matters to the feedback. A short answer that works as prose should stay in chat.

- Keep artifacts self-contained and portable.
- Follow the project design system or the user’s direction. The bundled theme is only a fallback.
- Give important regions stable `data-agent-html-render-id` values.
- Prefer semantic HTML and inline CSS. Add inline SVG when relationships are easier to review visually.
- Do not rely on authored JavaScript, forms, frames, navigation, or remote assets; the sandbox blocks them by default.
- Keep reviewable files inside the project, use a `.html` extension, and stay below 5 MB.

See the bundled [rollout plan](examples/plan.html), [architecture decision](examples/architecture-decision.html), and [migration plan](examples/migration-plan.html).

## Why use it alongside chat or Markdown?

Chat and Markdown already handle many plans well, including diagrams. Agent HTML Render is useful when the missing part is a host-neutral review loop: review any agent's rich pre-implementation artifact in a local browser, attach intent to the rendered element rather than a chat or Markdown line, and verify where that target moved on the next revision.

This is also different from previewing a running application. Agent HTML Render is for the reasoning artifact before implementation. It keeps that artifact portable and inspectable rather than turning it into a hosted product-specific object.

## Feedback output

Each send writes a revision-bound envelope to stdout:

```json
{
  "sequence": 1,
  "feedback": {
    "status": "feedback",
    "session": { "revision": 2 },
    "reviewerMessage": "Keep the rollout reversible.",
    "annotations": [
      {
        "comment": "Make this checkpoint block the next phase.",
        "resolution": "attached",
        "target": {
          "stableId": "phase-observe",
          "text": "Establish the baseline"
        }
      }
    ]
  }
}
```

Annotations include stable IDs, DOM and CSS paths, text quotes, and heading context. Reviewer instructions and artifact excerpts remain separate; artifact content is explicitly labeled as untrusted reference context.

## Reliability and security

- The daemon listens only on `127.0.0.1` and is scoped to one project root.
- Agent and reviewer access use separate random secrets.
- Every artifact read runs in an isolated, handle-pinned POSIX reader, is bound to one opened regular file and the original project-root identity, and fails closed if the file, a parent path, or the root itself is swapped.
- If an artifact's parent directory is replaced, the old session and draft remain recoverable across daemon restarts. Committed feedback is delivered first; then explicit `--new` moves unsent notes once into the replacement review, supersedes the source session, and blocks sending until you inspect and rebase them.
- Artifact HTML runs in a sandboxed iframe with an HTTP CSP header; a CSP meta tag is also injected as defense in depth.
- Only the nonce-protected selection bridge executes.
- Runtime messages, drafts, anchors, and feedback are validated and bounded.
- CLI status and line-oriented diagnostic records visibly encode filesystem- and error-derived line controls before adding trusted framing. JSON remains exact, while Markdown preserves exact artifact paths and stable identifiers and keeps untrusted artifact context inside its quoted boundary.
- Feedback commits use serialized copy-on-write persistence. Submission IDs remain replay-safe after visible history is pruned. The delivery endpoint rejects clients that do not advertise the explicit-acknowledgement capability or supply exactly one valid consumer identity, and accepts at most one exact, bounded decimal safe-integer cursor; duplicate exact keys, structured aliases such as `after[...]` or `consumer.*`, NUL-tainted names, and oversized cursor text fail before listener or lease allocation, while unrelated query names remain compatible. Accepted waits always return an opaque grant and never auto-commit on a response write. One shared bounded identity grammar is enforced again by every store lease operation, so a shipped JavaScript caller cannot reserve, renew, release, or commit feedback under malformed credentials. Lease time comes only from the store clock—caller-supplied timestamps and extra arguments are rejected—and the clock plus TTL must remain a safe integer; every acknowledgement requires the exact consumer and grant. A short consumer lease is renewed while bounded stdout delivery remains active, preventing a slower concurrent command from losing the batch at the original expiry. An uncommitted acknowledgement requires the exact grant to still be unexpired inside the serialized store boundary. Each committed cursor stores a private digest of the winning grant, so acknowledgement-response loss remains replay-safe after expiry while an expired or superseded writer cannot report another consumer's commit as its own.
- The CLI completes backpressure-aware feedback output before acknowledging its durable cursor, so a large bounded JSON or Markdown batch cannot be truncated and then consumed. Output is capped at 120 seconds; every grant has an opaque lease ID, and renewal, acknowledgement, and release are serialized and apply only to that exact grant. Each acknowledgement attempt has a two-second deadline and all three attempts finish inside the freshly renewed 30-second lease. If the downstream reader closes, the CLI leaves the durable cursor unchanged and makes a bounded exact-grant release for immediate retry. If renewal is lost or the output deadline arrives while a pipe write is still pending, the CLI reports the failure synchronously and terminates without releasing early, letting the operating system close the writer before the queued batch becomes eligible again.
- Unsaved reviewer edits remain owned by the active browser tab instead of being overwritten by a remote draft event.
- Private daemon/session files use random exclusive atomic writes, repaired `0600` permissions, no-follow single-link regular-file checks, and pinned root/state/session directory identities before mutation (including randomized temporary files, logs, and restore). Startup preflights explicit aggregate session-file and byte budgets, restores with bounded concurrency, and every live commit—including each ordered durable prefix of a recovery transfer—is admitted through the same serialized budgets so accepted state remains restartable. Quota accounting advances at the rename commit point; if later boundary verification becomes uncertain, the store preserves any in-flight acknowledgement pin, rejects subsequent lease issue, renewal, release, acknowledgement, and durable mutations, and retires the daemon before another operation can diverge from the committed snapshot. Project replacement fails closed instead of redirecting notes or credentials, shutdown leaves discovery metadata for replacement by the next coordinated startup, and `doctor` reports boundary violations.
- Fully delivered ended sessions are retained for at most 30 days and 50 sessions; open or pending sessions are never garbage-collected.
- Concurrent CLI starts share one daemon and one artifact session through a kernel-held local coordinator. Ownership is handed to the detached daemon during bootstrap and retained for its lifetime, so parent exit, missing metadata, or state-directory replacement cannot open a second daemon path; it disappears with the daemon and never deletes a pathname. A per-start identity binds authenticated daemon health to that exact coordinator owner, and compatibility hashes the executable Node runtime as well as the UI and artifact bridge, so same-version local rebuilds cannot silently reuse older code. Contending commands can still join once matching metadata, pinned state, and coordinator ownership are all current. Any legacy `daemon.lock` is inspected read-only and blocks startup until explicitly resolved. Watcher callbacks detach before bounded teardown, and watcher-originated persistence, mutating requests, and periodic log maintenance must drain before shutdown is clean; stop verification uses one monotonic absolute three-second window, including remaining-time-bounded endpoint probes and final ownership observations, that covers the request attempt and their composed cleanup before reporting failure. If any old-daemon state work cannot prove quiescence, the detached daemon terminates while retaining ownership so the kernel removes its handles and coordinator before a successor can start. An unresponsive stale daemon blocks replacement instead of allowing two daemons to run.
- Daemon logs are private and size-bounded; `doctor` reports their path without exposing secrets and rejects symlinked state paths.

Agent HTML Render v0.5 supports one reviewer on the local machine. Hosted sharing, accounts, cloud sync, and multiplayer review remain out of scope.

Automated browser, filesystem-boundary, and collision-free daemon-startup coverage currently targets Chromium on Ubuntu. The secure artifact reader fails closed on Windows until a reparse-point-safe handle implementation is available; macOS still needs a collision-free local startup primitive. macOS, Windows, Firefox, and Safari remain compatibility candidates rather than release-gated environments for this beta.

## Migrating from AgentLens or AgentRender

Agent HTML Render replaces the former `@rimef/agentlens` package and the unpublished AgentRender preview.

1. Run `npx --yes --prefer-online agent-html-render@latest install-skill`.
2. Verify `.agents/skills/agent-html-render`, then remove legacy `agentlens` or `agentrender` skill entries if they contain no custom work.
3. Start new reviews with `npx --yes --prefer-online agent-html-render@latest review <file.html>`.

Existing `data-agentlens-id` and `data-agentrender-id` anchors remain readable. In-progress legacy daemon sessions are not imported because their URLs contain version-specific credentials. Check old state directories for user-authored HTML before removing them.

## Development

```bash
git clone https://github.com/RiadMefti/agent-html-render.git
cd agent-html-render
npm ci
npm run test:all
npm pack --dry-run
```

`test:all` runs type checking, unit tests, the production Chromium flow, real project-skill discovery for Codex and OpenCode, and Claude Code adapter plus doctor validation. All three host CLIs are required for the strict smoke check. A public release also requires a recorded direct Claude skill invocation; see the [release checklist](docs/release-checklist.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending a patch. The [dogfood guide](docs/dogfood.md) describes a five-developer pilot that records outcomes locally without product telemetry. Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/RiadMefti/agent-html-render/security/advisories/new).

## License

MIT © Riad Mefti and Agent HTML Render contributors.
