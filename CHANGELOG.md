# Changelog

All notable changes to Agent HTML Render are documented here.

## 0.5.0 — 2026-08-30

- Added Review Changes history with earlier and currently resolved targets plus Resolved, Still needs work, and Dismiss decisions.
- Bound drafts and sends to an explicit artifact revision so mid-review file changes cannot silently misapply feedback.
- Added repeatable `demo`, actionable `doctor`, and explicit `review --new` flows.
- Restored supported Node 22 coverage from 22.22.2 onward, alongside Node 24.15+ and Node 26.
- Made project skill installs safely upgrade unchanged managed files while preserving user-owned edits, pinning both host install directories against project-root replacement, and retaining a reported rollback tree under `.agent-html-render/skill-backups/` so old-editor saves remain recoverable without exposing the rollback as another host skill.
- Verified real project-skill discovery in Codex and OpenCode plus Claude Code adapter/doctor compatibility; direct Claude invocation remains an explicit release gate.
- Added kernel-held local daemon startup coordination, bounded private logs, safe local Git ignore rules, feedback retention that never evicts pending batches, and bounded cleanup of fully delivered ended sessions.
- Sent the artifact CSP as an HTTP header, tightened stable-anchor ambiguity handling, and improved dialog focus management.
- Moved trusted review overlays out of artifact-controlled DOM, blocked HTML and SVG navigation without breaking local fragments, and isolated each POSIX artifact read in a parent/root-identity-pinned process.
- Added a lifetime-bounded idempotency journal, serialized copy-on-write feedback commits, renewable exact-grant delivery leases, and durable grant-digest acknowledgement records so response loss, write failure, expiry, and concurrent agent commands cannot falsely report another consumer's batch as their own; capability-less waits plus malformed values, duplicate exact keys, structured bracket/dot aliases, NUL-tainted names, and oversized cursor text are rejected before listener and lease allocation without blocking unrelated same-prefix query names, and every shipped store lease operation independently enforces the shared bounded credential grammar, rejects caller-supplied clocks and extra arguments, and validates internal TTL arithmetic instead of retaining malformed-input reservations or an implicit commit path.
- Made whole-artifact reviewer notes first-class Review Changes entries with the same resolve, requeue, and dismiss workflow as annotations.
- Added bounded keyboard target traversal with a shared visible-fragment proof across viewport reachability, ancestor overflow, clipping, masks, topmost paint hit-testing (including geometrically sampled 2D-transformed pseudo-elements and pointer-transparent covers across nested stacking contexts), trusted outlines, heading context, anchor recapture, and saved feedback; decorative borders, shadows, and non-covering pseudo-elements remain annotatable, final keyboard/text selection revalidates changing paint, and partially visible prose keeps a bounded proven-visible label, while Shift+Enter exact-text selection still fails closed across clipped or hidden content. An explicit bridge acknowledgement makes the initial keyboard handoff race-free without changing authored layout or `tabindex`.
- Added architecture and migration examples plus a local five-developer dogfood protocol.
- Kept the live event stream stable across state updates and protected unsaved local edits from remote draft events.
- Made stable-scoped annotations fail closed when their intended region disappears, strengthened labelled-control matching, fixed adjacent text-range boundaries, and exposed a clear 1,200-character exact-selection limit.
- Reconciled committed acknowledgement responses against the exact durable grant digest before the CLI exits, prevented future cursors from stealing active or renewing leases, rejected expired and superseded-writer acknowledgements inside the serialized store boundary, and kept disk and memory coherent when a post-rename directory sync reports failure.
- Made clean-checkout type checking independent of generated output and taught `doctor` to reject nested symlinks inside the private state boundary.
- Required one unique stable-ID claimant regardless of tag or legacy namespace, preserved escaped stable scopes, and bounded accessible-name traversal before allocation.
- Pinned each review to its original parent-directory identity while preserving ordinary final-file atomic saves.
- Made daemon metadata and managed-skill receipts atomic no-follow writes, and treated user-added links or special entries as protected skill changes.
- Kept ambiguous retries byte-for-byte bound to their original submission and made annotation guidance transparent to pointer input.
- Made parent-directory replacement recovery explicit without losing drafts or committed feedback, and gave every bounded `aria-labelledby` reference an independent chance to identify its control.
- Extended managed-skill receipts to cover directory entries, including safe migration from file-only receipts, so user-added empty directories block replacement.
- Made session snapshots random exclusive atomic writes, pinned root/state/session directory identities before every private-state mutation, and rejected linked daemon metadata, session state, Git-ignore files, and daemon logs before reading or writing credentials.
- Kept stale-parent sessions recoverable after daemon restarts, made linked session snapshots an actionable startup/doctor failure, and normalized restored credential files to mode `0600`.
- Preserved both common context and distinguishing reference text in bounded accessible names, preventing long shared prefixes from redirecting reordered controls.
- Retained daemon discovery metadata at shutdown for replacement under the next coordinated startup, avoiding a pathname race that could remove a newly published daemon record.
- Added bounded SHA-256 accessible-name identities and unique semantic fallback matching so long `aria-label`, `aria-labelledby`, `alt`, `title`, and associated-label collisions fail closed instead of following stale DOM positions.
- Moved unsent drafts once into explicitly opened replacement sessions with a mandatory reviewer rebase, durably superseding the source session while keeping committed feedback first in line.
- Restored file watchers only for sessions whose pinned parent identity is still current, preventing stale readers from accumulating after daemon restarts.
- Replaced pathname-based startup ownership with a Linux abstract-socket listener retained for the daemon lifetime and released automatically on exit, so missing metadata or state replacement cannot admit a second daemon; added READY/nonce/acknowledgement transfer ordering, let concurrent commands join once compatible metadata appears, carried the pinned state identity into child initialization, and fail closed on other operating systems until they have a collision-free primitive; legacy lock files remain read-only.
- Taught `doctor` to probe the live kernel coordinator, inspect the runtime's exact randomized daemon-metadata temporary-file pattern, and report every legacy startup lock as a read-only readiness blocker, including old records whose PID may have been reused.
- Made same-boundary/tag anchor batches order-independent across lazily built semantic and text identity modes, incrementally indexed stable IDs in one bounded traversal shared across bridge messages, capped over-budget live collections before materialization, cached repeated stable-selector uniqueness and heading paths under shared batch budgets (including recapture), bounded identity/accessibility/quote work, and isolated per-marker failures.
- Reconciled one-time recovered-draft transfers after restart, restored annotation-editor focus on entry and exit, made concurrent kernel-coordinator contention retry safely, required both recorded-process exit and endpoint closure before replacement, and made restored-watcher startup failure close every watcher and bound HTTP listener.
- Bound daemon health to a per-start lifetime-coordinator identity, included executable Node modules in runtime compatibility, and revalidated pinned state/session identities on every health check. Watcher callbacks now retire before bounded teardown, in-flight watcher persistence and mutating requests drain before a clean close, failed retirements cannot return as inert registrations, and a detached daemon retains coordinator ownership until process-terminal cleanup, so stale same-version daemons, replaced state trees, hung watchers, and delayed state writes cannot overlap a successor.
- Preflighted explicit aggregate session count and byte budgets and restored snapshots with bounded concurrency, preventing restart-time file-descriptor and memory fan-out while retaining ordinary ended-session pruning.
- Enforced those same restart budgets transactionally across concurrent live commits and every ordered durable prefix of a recovery transfer, advancing accounting at each rename commit and process-terminally retiring after post-commit boundary uncertainty. Retirement preserves an in-flight acknowledgement pin and rejects lease issue, renewal, release, acknowledgement, and later durable mutations, so interruption, a later write failure, or a restored state path cannot admit state the successor rejects.
- Included active daemon-log maintenance in the bounded shutdown proof and established one monotonic absolute three-second stop deadline before the request, with remaining-time-bounded probes and final event-loop-turn observations so a retired process cannot truncate a successor's diagnostic log, a successor cannot start early, and valid near-cutoff cleanup is not falsely rejected.
- Kept untrusted filenames, diagnostic fields, and error text inside visibly encoded CLI records, emitted terminal-safe JSON without changing its values, escaped Unicode line separators before Markdown quoting, and preserved exact artifact paths and stable identifiers in feedback.
- Completed backpressure-aware stdout delivery before durable feedback acknowledgement, preventing a large bounded JSON or Markdown batch from being partially written and then consumed; the CLI renews the opaque exact grant during a bounded 120-second output window and once before acknowledgement, bounds all three acknowledgement attempts inside that renewed lease, and reconciles response loss by exact durable grant digest. Stale writers cannot claim a newer grant's commit, stale releases are inert, closed readers get bounded exact-grant cleanup, and renewal loss or an output deadline terminates a blocked writer without releasing early so it cannot resume after a successor becomes eligible.

## 0.4.0 — 2026-08-22

- Tightened the README, bundled skill, contribution guide, security policy, issue templates, package summary, and review status copy.
- Updated stale `0.2.x` references.
- Raised the minimum runtime to Node.js 24.15 LTS and moved CI coverage to Node 24 and Node 26.
- Updated jsdom from 29.1.1 to 30.0.1 for the test suite.

## 0.3.1 — 2026-08-22

- Let agents add diagrams when they clarify the artifact, with inline SVG suggested as an annotatable option instead of a required framework.
- Snapshot review-shell assets in daemon memory and replace stale daemons whenever their package version, UI shell, or artifact bridge differs from the invoking CLI, so npm cache refreshes cannot break active or future reviews.
- Show a lightweight loading fallback instead of a blank dark page if the review application cannot mount.

## 0.3.0 — 2026-08-22

- Made the Annotate and Review controls visually distinct, with compact bordered buttons and an explicit active state.
- Made queued annotations editable from both their numbered artifact marker and the Review list, with save and remove actions.
- Added a non-blocking waiting indicator after feedback is sent, distinguishing saved feedback from feedback already received by the agent.

## 0.2.2 — 2026-08-22

- Replaced the persistent review drawer and Annotate/Interact tabs with default artifact interaction, a focused annotation composer, and a compact review dialog.
- Moved revision and delivery activity into the primary header so the artifact keeps the full workspace.
- Changed agent feedback delivery to explicit acknowledgement, preventing a dropped long-poll connection from consuming reviewer feedback.
- Made pending feedback resumable in order, including feedback queued immediately before an ended session.
- Added compatibility detection so `@latest` replaces older daemons that do not support acknowledged delivery.

## 0.2.1 — 2026-08-22

- Fixed review-shell delivery when `npx` runs Agent HTML Render from npm's hidden cache directory.
- Added a regression test covering packaged execution from `.npm/_npx/` paths.

## 0.2.0 — 2026-08-22

- Renamed the project, repository, package, CLI, review shell, and portable skill from AgentLens to Agent HTML Render.
- Published the canonical unscoped package and executable as `agent-html-render`, designed to run through `npx agent-html-render@latest`.
- Moved project-local state and default artifacts to `.agent-html-render/` and stable artifact anchors to `data-agent-html-render-id`.
- Preserved resolution of legacy `data-agentlens-id` and pre-release `data-agentrender-id` anchors, with explicit migration guidance for existing projects.
- Deprecated `@rimef/agentlens` in favor of `agent-html-render`.

## Earlier AgentLens releases

## 0.1.2 — 2026-08-22

- Published the CLI as `@rimef/agentlens`.
- Switched project usage and the bundled skill to `npx @latest`, removing the global-installation requirement.

## 0.1.1 — 2026-08-22

- Fixed global installation by shipping a prebuilt release archive instead of compiling a Git dependency during installation.

## 0.1.0 — 2026-08-22

- Added the local HTML review daemon and `agentlens review` loop.
- Added element and text annotations with stable multi-anchor resolution.
- Added JSON and Markdown feedback with explicit reviewer/untrusted-content separation.
- Added live revisions, resumable sessions, and visible delivery lifecycle states.
- Added the portable Codex, Claude Code, and OpenCode project skill installer.
- Added iframe sandboxing, restrictive CSP, loopback-only transport, path containment, private session files, and bounded runtime validation.
