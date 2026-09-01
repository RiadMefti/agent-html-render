# Five-developer dogfood pilot

This pilot answers one question: does Agent HTML Render help developers catch ambiguity in agent plans before implementation?

Run it with five developers who already use Codex, Claude Code, or OpenCode. Keep all measurements in this document or a private copy. Do not add product telemetry, upload reviewed artifacts, or collect local review URLs.

## Setup

Ask each participant to use a real repository and one real pre-implementation task. Aim for a mix of:

- an implementation or rollout plan;
- an architecture or API decision;
- a migration with dependencies and rollback points;
- a threat model or trust-boundary review;
- a diagram-heavy proposal.

Have them run `agent-html-render demo`, then `agent-html-render install-skill`, then ask their normal coding agent to create the artifact. Ask every participant to complete one annotation using only the keyboard, but do not tell them the key sequence unless they are blocked; target guidance and discoverability are part of the test.

## Local scorecard

Record one row per participant. Use approximate minutes; the point is to find friction, not surveil exact behavior.

| Participant | Host + version | Task | Demo understood without help? | Keyboard annotation without help? | Minutes to first real review | Approx. added review time | Feedback batches | Requests verified in Review Changes | Reused within 7 days? | Main failure or surprise |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| P1 |  |  |  |  |  |  |  |  |  |  |
| P2 |  |  |  |  |  |  |  |  |  |  |
| P3 |  |  |  |  |  |  |  |  |  |  |
| P4 |  |  |  |  |  |  |  |  |  |  |
| P5 |  |  |  |  |  |  |  |  |  |  |

Also note whether any annotation reattached to the wrong target, whether a draft was lost, and whether the participant accidentally reopened an ended session. Those are trust failures even if the task was completed.

## Debrief questions

Ask immediately after the real review:

1. What did pointing at the artifact make easier than replying in chat?
2. What part of the artifact was still hard to discuss?
3. Did you trust that the agent received the right comment on the right revision? Why?
4. Was Review Changes enough to decide whether the agent addressed the request?
5. When would you deliberately not use this?
6. Would you use it again without being reminded?
7. How would you normally review this with the same host? What did this loop add, and what did it cost?

Capture the participant’s words, not a rewritten interpretation.

## Initial success gates

Treat the pilot as promising when:

- four of five participants complete the demo without explanation;
- four of five complete one positional annotation using only the keyboard without instruction;
- four of five reach a real review in five minutes or less after installation;
- no draft is lost and no annotation silently attaches to an ambiguous target;
- at least three participants use it again on a different task within seven days;
- at least three can name a concrete misunderstanding caught before code was changed.

These are descriptive beta gates, not evidence that the tool caused faster delivery or fewer defects. Do not make productivity or ROI claims from this five-person pilot.

Do not optimize for fewer feedback batches. Multiple batches can mean the review loop is doing useful work. Optimize for clear intent, correct revision binding, confident verification, and voluntary repeat use.

## Turning observations into changes

Group notes under onboarding, artifact quality, annotation, delivery trust, change verification, and host compatibility. Fix repeated trust or data-loss failures before adding surface area. For discoverability problems, change the demo, copy, or defaults and rerun the same task with a new participant.

Publish only aggregate conclusions unless participants explicitly approve sharing their artifacts or quotes.
