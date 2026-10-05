# Stateless project orchestration

This document governs development of the RepoRelay repository itself. It does NOT
replace `docs/OPERATOR_PROTOCOL.md`, which remains the normative protocol for
operating RepoRelay against configured targets.

Conversation memory is never repository, command or receipt authority.

## Separate control surfaces

Permanent project Control Issue:

`#42 — REPORELAY CONTROL — Current Orchestrator State [KEEP OPEN]`

Transport authority:

- active command bus: #39;
- historical receipt/recovery bus: #3.

#42 is only a bounded development-state pointer/cache. It must never receive
RepoRelay commands merely because it is called CONTROL. #39 must not become a
project backlog/transcript.

Rewrite #42 at material project checkpoints, increment `STATE_VERSION`, and
fresh-read native GitHub before consequential actions. If #42 conflicts with
native authority, native authority wins.

## Bootstrap

A new project Orchestrator:

1. reads current `AGENTS.md`;
2. reads this document;
3. reads #42;
4. reads `docs/OPERATOR_PROTOCOL.md` when command/receipt behavior is relevant;
5. fresh-reads only the repository authority required by `NEXT_ACTION`;
6. reconciles drift before mutation;
7. does not import an old chat transcript to reconstruct routine state.

## Roles

### Orchestrator

Default:

```text
RECIPIENT=ChatGPT Web
MODEL=GPT-5.6 Sol
REASONING=High
CHAT=EXISTING while context is precise; otherwise NEW
EXECUTION=web/GitHub
```

Owns sequencing, issue/PR authority, implementation routing and #42
reconciliation. It does not replace the command protocol.

### Implementer

Use:

- ChatGPT Web + RepoRelay for bounded GitHub-native changes that fit the installed
  fenced write surface;
- Codex Web for repository workspace/search/edit/test loops with no hard local
  dependency;
- Codex Local/Desktop when local Node/tooling, a local test/debug loop, local
  credentials or other machine-bound capabilities are materially required.

Once in Codex Local, use normal local Git/`gh` for repository work unless an
operator-protocol test explicitly requires RepoRelay transport.

Do not use Local merely because one Web wrapper is inconvenient. Missing GitHub
mutation semantics should normally use the installed RepoRelay write plane.

### Independent Reviewer

```text
RECIPIENT=ChatGPT Web
MODEL=GPT-5.6 Sol
REASONING=Extra High
CHAT=NEW
EXECUTION=read-only web/GitHub
```

NEW chat is mandatory. Review exact candidate source, protocol and security
properties without inheriting implementation conclusions.

### Finalizer

```text
RECIPIENT=ChatGPT Web
MODEL=GPT-5.6 Sol
REASONING=High
CHAT=NEW preferred
EXECUTION=web/GitHub
```

Re-read exact head/base/check/review/owner authority. No implicit merge/install or
target mutation authorization.

## Web -> Codex fallback

Escalate execution capability:

1. ChatGPT Web for orchestration/review and bounded fenced GitHub work;
2. Codex Web for repository-heavy work fitting the cloud workspace;
3. Codex Local/Desktop for required local tests/tooling/debug/runtime unavailable
   in Web.

Do not confuse capability absence with reasoning difficulty. Higher reasoning
cannot create missing tools or access.

## Cost-aware Codex/Work model ladder

When available:

- **Luna + Low** — extraction, inventory, formatting, mechanical/repetitive edits,
  simple bounded checks.
- **Terra + Low/Medium** — preferred normal Codex default for ordinary source/docs,
  routine refactors and straightforward test fixes.
- **Sol + Medium** — cross-file implementation, protocol reasoning, debugging and
  non-trivial tests.
- **Sol + High** — difficult work where Medium is insufficient.
- **Astra/Pro-class + Low/Medium first** — rare hard protocol/security/root-cause
  problems.

Terra and Luna are Codex/Work options when available. They are not standard
ChatGPT conversation selectors. Standard Orchestrator Chat stays Sol High;
independent review uses Sol Extra High.

Use higher reasoning only after confirming the blocker is reasoning rather than
missing files, permissions, evidence or execution environment.

## Pro $100 capacity routing snapshot

As of 2026-09-22, when the owner is on ChatGPT Pro $100:

- GPT-6 Pro in Chat is powered by GPT-6 Astra and shares **50 messages/week**
  with GPT-5.6 Sol Pro.
- GPT-6 Astra in Work/Codex consumes the separate included Work/Codex allowance;
  Astra use in Codex Web or Codex Local/Desktop does not spend the 50 Chat Pro
  messages.
- Spend Chat Pro capacity on independent security/protocol review, hard
  architecture and difficult root-cause analysis; keep ordinary transport/lifecycle
  work on Sol High.
- Do not hoard expiring weekly premium Chat capacity when high-value review is
  waiting.

This dated product snapshot is routing guidance, not protocol authority.
Fresh-verify OpenAI plan limits before quota-sensitive decisions and preserve the
capacity-separation principle if plan details change.

When routing **GPT-6 Pro in standard Chat**, use `MODEL=GPT-6 Pro` and
`REASONING=MODEL_DEFAULT` unless the current UI explicitly exposes a separate
reasoning control for that Pro model. Do not map GPT-5.6 Sol `Extra High` onto
GPT-6 Pro: Pro is a model selection, while Medium/High/Extra High are Sol
reasoning levels.

## Prompt routing

Every prompt handed to another execution session begins:

```text
PROMPT_ROUTE
RECIPIENT=<ChatGPT Web | Codex Web | Codex Local/Desktop | explicit other tool>
MODEL=<model>
REASONING=<MODEL_DEFAULT | Low | Medium | High | Extra High | available equivalent>
CHAT=<NEW | EXISTING>
EXECUTION=<web/GitHub | cloud repository | local repository/runtime>
WHY=<one short sentence>
```

## Session reuse and rollover

Continue an existing chat only for the same role/objective while current authority
is easy to isolate. Start a new chat for independent review, objective/role/
architecture changes, or material context degradation.

Before rollover:

1. finish a safe atomic action when practical;
2. fresh-read and reconcile #42;
3. preserve unique local/uncommitted state outside the chat;
4. do not start another substantial tranche.

Then say:

```text
Questa chat sta diventando troppo grande per restare il contesto operativo
principale. Apri una nuova chat nello stesso progetto RepoRelay e incolla il
prompt qui sotto; non serve trasferire la cronologia perché lo stato di sviluppo
è riconciliato su GitHub e il command bus resta un'autorità separata.
```

Then emit:

```text
PROMPT_ROUTE
RECIPIENT=ChatGPT Web
MODEL=GPT-5.6 Sol
REASONING=High
CHAT=NEW
EXECUTION=web/GitHub
WHY=Restart project orchestration from durable repository authority.

REPORELAY ORCHESTRATOR — RESTART FROM GITHUB

Repository: alescim17/github-chatops

Read current AGENTS.md, docs/ORCHESTRATION_PROTOCOL.md and Control Issue #42.
Read docs/OPERATOR_PROTOCOL.md when command/receipt semantics are relevant.
Fresh-read native GitHub authority referenced by CURRENT_STATE and NEXT_ACTION.
Treat stored SHA/tree/status as restart hints until verified.
Keep project Control #42 separate from active command bus #39 and historical #3.
Do not reconstruct routine state from old chats.
Reconcile #42 before mutation if authority drift exists.
```

## Compact handoff

```text
RETURN_TO_ORCHESTRATOR

RESULT=<PASS | CHANGES_REQUIRED | BLOCKED | AUTHORITY_DRIFT | ...>
TASK=<short identifier>
ISSUE=#N
PR=#N|NONE

BASE_HEAD=<sha|N/A>
HEAD=<sha|N/A>
TREE=<sha|N/A>

PHASE_COMPLETED=<short text>
EVIDENCE=<compact PASS/FAIL/UNAVAILABLE summary>
GITHUB_MUTATION=<NONE|description>
TARGET_MUTATION=<NONE|description>

BLOCKERS=<NONE|short text>
OWNER_AUTHORITY_USED=<NONE|exact authority>
NEXT_RECOMMENDED_ACTION=<short text>
CONTROL_STATE_DELTA=<advisory delta; orchestrator must verify>
```

## Token/subscription efficiency

- durable rules remain in repository docs;
- current project pointer state lives in #42, not the chat or command bus;
- fresh-read only what the immediate decision needs;
- Orchestrator: standard Chat Sol High;
- mechanical Codex: Luna Low;
- ordinary Codex: Terra Low/Medium;
- harder Codex: Sol Medium/High;
- independent review: standard Chat Sol Extra High;
- Astra/Pro-class: escalation only;
- Local only when Local capability is materially required.
