# Changelog

All notable changes to Agent HTML Render are documented here.

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
