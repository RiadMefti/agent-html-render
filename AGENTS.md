# AgentLens engineering notes

- Keep the product local-first, vendor-neutral, and lean. Agents produce ordinary HTML; do not introduce a proprietary artifact schema or host-specific runtime.
- Use `../agent-orchestrator/apps/web/src/styles/` as the visual source of truth for the AgentLens review shell: `#fafafa` background, `#171717` text, system typography, flat text actions, hairline separators, and restrained dialogs. Do not add decorative gradients, logo tiles, pills, or card-heavy layouts.
- Do not impose the review shell's layout on agent-authored artifacts. User direction and project design systems win; the bundled `agent-orchestrator` theme is only their default visual grammar.
- Preserve sandboxing, loopback-only transport, runtime message validation, bounded feedback, stable multi-anchor resolution, and explicit separation of reviewer intent from untrusted artifact text.
- Before handoff, run type checking, unit tests, the production browser test, the three-host smoke check, and a package dry-run.
