# Security policy

## Supported versions

AgentRender is currently in its `0.2.x` development line. Security fixes are applied to the latest release only.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/RiadMefti/agentrender/security/advisories/new). Do not include an active AgentRender review URL, daemon token, session file, or sensitive reviewed artifact in a public issue.

Include the affected version, operating system, reproduction steps, expected impact, and any suggested mitigation. Reports will be acknowledged as soon as practical and coordinated disclosure is preferred.

## Security boundaries

AgentRender is designed to protect the reviewer from untrusted agent-authored HTML while keeping transport local to the machine. Its main guarantees are:

- loopback-only HTTP transport;
- separate random secrets for agent and reviewer access;
- canonical project-root path containment;
- sandboxed artifact rendering with a restrictive CSP;
- bounded and runtime-validated messages and feedback;
- explicit separation of reviewer instructions from untrusted artifact excerpts.

AgentRender is not a security boundary against another local user or process that can read the project directory, process memory, or browser profile. Review URLs are bearer credentials for their local session and should be treated as sensitive.
