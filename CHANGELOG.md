# Changelog

All notable changes to AgentRender are documented here.

## 0.2.0 — 2026-08-22

- Renamed the project, repository, package, CLI, review shell, and portable skill from AgentLens to AgentRender.
- Published the canonical unscoped package as `agentrender`, designed to run through `npx agentrender@latest`.
- Moved project-local state and default artifacts to `.agentrender/` and stable artifact anchors to `data-agentrender-id`.
- Preserved resolution of legacy `data-agentlens-id` anchors and added explicit migration guidance for existing projects.
- Deprecated `@rimef/agentlens` in favor of `agentrender`.

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
