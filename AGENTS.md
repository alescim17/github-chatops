# Agent operating policy

Be concise, but preserve authority, safety, evidence and request-recovery
semantics.

Before substantial work read:

- [Project stateless orchestration](docs/ORCHESTRATION_PROTOCOL.md)
- [RepoRelay operator authority protocol](docs/OPERATOR_PROTOCOL.md)
- [Typed read plane](docs/READ_PLANE.md)
- [README](README.md)

## Project delivery

Plan implementation in a GitHub Issue before changing source, workflow or
protocol behavior. Use an issue-derived branch and a reviewable PR to `main`.
Merge/install only under explicit repository-owner authorization.

## Project control versus command transport

These are different mechanisms:

- Issue #42 — **REPORELAY CONTROL**: bounded current project-development
  orchestration pointer/cache;
- Issue #39 — active RepoRelay command bus: command/receipt transport;
- Issue #3 — historical command bus: readable receipt/recovery authority only.

Never send a RepoRelay command to #42. Never use #39 as a project backlog or
conversation-memory store.

Native GitHub and the installed operator protocol remain authority. Control-state
fields are restart hints until fresh-read.

## Execution and prompt routing

Every delegated operational prompt must include the `PROMPT_ROUTE` fields from
`docs/ORCHESTRATION_PROTOCOL.md`: recipient, model, reasoning,
`CHAT=NEW|EXISTING`, execution environment and reason.

Use ChatGPT Web Sol High for orchestration, Sol Extra High in a NEW chat for
independent review, and cost-aware Codex routing for implementation. Terra/Luna
are Codex/Work choices when available, not standard Chat selectors.

Use Codex Local only when required execution capability cannot be faithfully
provided by Web/Codex Web. Missing tool/runtime access is not fixed by increasing
reasoning.

## RepoRelay self-hosting boundary

When ChatGPT Web operates this configured target, follow
`docs/OPERATOR_PROTOCOL.md`: native reads first, RepoRelay normal fenced writes,
fresh independent read-after-write, no blind replay, and active bus #39.

Do not weaken expected-state fences, public/private separation, target isolation,
request identity or recovery semantics to simplify project orchestration.

## Session rollover

The Orchestrator must proactively recommend a new chat before stale context harms
precision. First reconcile #42 from fresh native authority and preserve any unique
local state. Then emit the exact ready-to-paste restart sentence and bootstrap
prompt defined in `docs/ORCHESTRATION_PROTOCOL.md`; do not require a long
transcript handoff.
