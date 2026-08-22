# Security policy

## Supported versions

Agent HTML Render is currently in its `0.3.x` development line. Security fixes go to the latest release only.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/RiadMefti/agent-html-render/security/advisories/new). Do not include an active Agent HTML Render review URL, daemon token, session file, or sensitive reviewed artifact in a public issue.

Include the affected version, operating system, reproduction steps, expected impact, and any suggested mitigation. We will acknowledge the report and coordinate disclosure with you.

## Security boundaries

The sandbox limits what agent-authored HTML can do, and the daemon listens only on the local machine. The security boundaries are:

- loopback-only HTTP transport;
- separate random secrets for agent and reviewer access;
- canonical project-root path containment;
- sandboxed artifact rendering with a restrictive CSP;
- bounded and runtime-validated messages and feedback;
- explicit separation of reviewer instructions from untrusted artifact excerpts.

Agent HTML Render is not a security boundary against another local user or process that can read the project directory, process memory, or browser profile. Review URLs are bearer credentials for their local session and should be treated as sensitive.
