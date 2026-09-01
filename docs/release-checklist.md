# Public release checklist

Use this checklist for a public `0.5.x` release. CI is necessary but does not replace the host and registry evidence below.

## Local verification

1. Run `npm ci` from a clean checkout.
2. Run `npm run test:all`.
3. Run `npm audit --omit=dev`.
4. Run `npm pack --dry-run` and inspect the file list and package size.
5. Record the operating system, Node version, Chromium version, and the Codex, Claude Code, and OpenCode versions printed by the host smoke check.

## Host evidence

The strict smoke script proves actual project-skill discovery in Codex and OpenCode. It proves the installed Claude adapter resolves and that `claude doctor` accepts the project, but it does not invoke the skill through Claude's model runtime.

From a disposable repository with the release candidate skill installed, run this authenticated manual check:

```bash
claude --print --tools="" "/agent-html-render Do not run commands or start a review. Read the invoked skill and return only the exact pinned npx command prefix it requires."
```

The response must contain the release's exact `agent-html-render@<version>` pin and `--prefer-offline`. Record the Claude version and redacted result in the release notes. Do not record credentials, local review URLs, or artifact contents.

## Pilot evidence

Complete the descriptive five-developer scorecard in `docs/dogfood.md` or a private copy. A public beta requires no lost or duplicated feedback, no silently wrong target attachment, successful general-note and element-level verification across at least two revisions, and actual end-to-end use in Codex, Claude Code, and OpenCode.

Do not turn this pilot into a causal productivity or ROI claim.

## Registry sequencing

1. Confirm the changelog, package version, bundled skill pin, and documentation all name the same release.
2. Publish the package before creating the GitHub tag or release announcement.
3. In a clean temporary directory, verify `npx --yes --prefer-online agent-html-render@latest --version` reports the new version.
4. Start `npx --yes --prefer-online agent-html-render@latest demo --no-open` and confirm it prints a loopback review URL and waits for feedback; then end the disposable review normally.
5. Only after those checks pass, create the Git tag/release and merge or publish documentation that presents the new commands as available through `@latest`.

If the registry verification fails, stop the release and correct the dist-tag or package before publishing announcements.
