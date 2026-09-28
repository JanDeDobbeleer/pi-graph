# Brief: pi-code-changes

Handoff for a new session. Read this fully before touching code.

## Goal

Turn the oh-my-posh `code-changes` skill into a **native pi extension**, packaged as a **pi package**, so the
same workflow runs in every repository where pi is used, with the phases **enforced by code** instead of only
described in Markdown.

pi: <https://pi.dev/> (docs: <https://pi.dev/docs/latest>, source:
<https://github.com/earendil-works/pi/tree/main/packages/coding-agent>).

The skill stays the source of truth for *what* each phase does. The extension adds *enforcement*: gates the model
cannot talk its way past, artifacts that must exist before an edge is taken, a retry cap held in a real counter.

## Source material

The existing skill lives in the oh-my-posh checkout:

```
D:\oh-my-posh\.agents\skills\code-changes\
├── SKILL.md                     entry point: roles, the flow, stop gate
└── references\
    ├── analyze.md               Phase 1
    ├── plan.md                  Phase 2
    ├── delegate.md              Phase 3
    ├── supervise.md             Phase 4
    ├── verify.md                Phase 5 (retry cap, failure routing)
    ├── deliver.md               Phase 6
    ├── escalate.md              escalation triggers (side-call, never a new owner)
    ├── artifacts.md             the contract: one named artifact per edge
    ├── model-tiers.md           escalation / coordinator / implementer / trivial
    ├── issue-triage.md          alternate Phase 1 entry
    └── pr-review-comments.md    alternate Phase 1 entry
```

Read `SKILL.md` and `references/artifacts.md` first. `artifacts.md` is effectively the type definition for the graph.

## The graph to implement

```
Analyze ─▶ stop gate (human) ─▶ Plan ─▶ Delegate ─┬─▶ task A (worktree) ─┐
   ▲                                              └─▶ task B (worktree) ─┤
   │                                                                     ▼
   │                                     Supervise (merge) ◀── gate failure ──┐
   │                                             │                            │
   │                                             ▼                            │
   └──────────── wrong root cause ────────── Verify ──────────────────────────┘
                                                 │  └─ 2nd failure ─▶ Escalate
                                                 ▼
                                              Deliver
```

Edges and their artifacts (from `artifacts.md`):

| Edge | Artifact | Fields |
|------|----------|--------|
| Analyze → Plan | analysis report | `root_cause`, `proposed_change`, `out_of_scope`, `repro_status`, `open_questions` |
| Plan → Delegate | task list | per task: `spec`, `verification_commands`, `executor_tier`, `workspace`, `dependencies`, `merge_plan` |
| Delegate → Supervise | delegation packet | task `spec` + `verification_commands` + standing instructions |
| Supervise → Verify | reviewed diff | `merged_diff`, `overrides`, `tests_kept`, `tests_cut` |
| Verify → Supervise/Analyze | failure record | `attempt_number`, `failure_class`, `destination`, `escalation_answer` |
| Verify → Deliver | verification evidence | `gates_run`, `functional_proof`, `retry_count` |
| Escalate (side-call) | question in / answer out | question + evidence + hypothesis → decision + rationale |

## How pi maps onto the graph

| Graph concept | pi mechanism |
|---------------|--------------|
| Entry point | `pi.registerCommand("change", …)` — `/change <task>` starts the workflow |
| Node (phase) | extension state `phase`, plus per-phase `pi.setActiveTools([...])` and `pi.setModel(...)` |
| Per-phase instructions | `before_agent_start` injects that phase's reference file into the prompt |
| Hard gate | `tool_call` handler blocks `edit` / `write` / `bash` while in Analyze or awaiting approval |
| Human node | `ctx.ui.confirm(...)` after the analysis report is submitted |
| Typed artifact | one registered tool per artifact (`submit_analysis`, `submit_plan`, …) with a TypeBox schema; the model must call it to leave the phase |
| Edge / routing | `turn_end` / `agent_before_settle` inspect state and send the next phase's prompt (`pi.sendUserMessage`) |
| Retry cap | a counter in extension state, not in the prompt; 2nd failure escalates, 3rd stops and asks the user |
| Escalation | one-shot call on the escalation-tier model (`ctx.modelRegistry.streamSimple` or a short-lived SDK session), answer folded back into the current phase's artifact |
| Fan-out / fan-in | per task: `git worktree add`, then a separate `createAgentSession({ cwd: worktree, model })` run in `Promise.all`; merge per `merge_plan` |
| Persistence | `pi.appendEntry(...)` and tool-result `details`, so state survives session forks and resume |

Sub-agents are **not built into pi**. Look at `examples/extensions/subagent/` in the pi repo for the reference pattern,
and at `examples/extensions/plan-mode/` and `permission-gate.ts` for tool blocking.

**Verify all API names against the real types** before relying on them:
`packages/coding-agent/src/core/extensions/types.ts`, `docs/extensions.md`, `docs/sdk.md`, `docs/packages.md`.
The mapping above was written from the docs, not from running code. Open questions to settle early:

- Exact return shape from `tool_call` to block a call.
- Whether `setModel` / `createAgentSession({ model })` takes a string or a registry model object.
- Whether `agent_before_settle` with `continue: true` or `sendUserMessage` is the right way to chain phases.
- How to run the Supervise/Verify quality gates (`pi.exec`? a bash tool call?) and read their exit code.

## Target repository layout

```
pi-code-changes/
├── package.json                  pi package manifest
├── extensions/
│   └── code-changes/
│       ├── index.ts              registerCommand, event handlers, state machine
│       ├── state.ts              phase enum, workflow state, persistence
│       ├── artifacts.ts          TypeBox schemas + submit_* tools
│       ├── gates.ts              tool_call blocking per phase
│       ├── delegate.ts           worktrees + sub-agent sessions, fan-out/fan-in
│       └── models.ts             tier → provider/model mapping (configurable)
├── skills/
│   └── code-changes/             copy of the oh-my-posh skill (still usable without the extension)
├── README.md
└── BRIEF.md                      this file
```

`package.json` skeleton:

```json
{
  "name": "@jandedobbeleer/pi-code-changes",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

Host-provided pi packages go in `peerDependencies`; real runtime deps in `dependencies`.

## Distribution (how it gets discovered)

pi loads extensions from:

1. `~/.pi/agent/extensions/` — personal, every project
2. `.pi/extensions/` — project-local, committed (subject to project trust)
3. packages listed in `~/.pi/agent/settings.json` or `.pi/settings.json`
4. `pi -e <path|npm:|git:>` — one run only

Plan for this package:

- During development: `pi -e ./extensions/code-changes/index.ts` from inside a test repo.
- Personal use in every repo: `pi install git:github.com/jandedobbeleer/pi-code-changes@v1`
- oh-my-posh contributors: from the oh-my-posh repo run `pi install -l git:github.com/jandedobbeleer/pi-code-changes@v1`,
  which pins it in `.pi/settings.json` (commit that file, not a copy of the code).
- Optional later: publish to npm so the `pi-package` keyword lists it in the pi gallery.

## Suggested milestones

1. **Scaffold** — `package.json`, empty extension that registers `/change` and logs; loads via `pi -e`.
2. **State machine + gate** — phases, `tool_call` blocking in Analyze, `ctx.ui.confirm` stop gate.
3. **Artifacts** — `submit_*` tools with schemas; a phase cannot advance without its artifact.
4. **Per-phase prompts and models** — inject the matching reference file, switch tools and model per phase.
5. **Verify loop** — run gates, failure record, routing (Supervise vs Analyze), retry cap, escalation side-call.
6. **Delegate** — worktrees + parallel sub-agent sessions, merge per `merge_plan`.
7. **Deliver** — conventional commit, outcome-first report.
8. **Package + README** — install instructions, tier/model configuration, try it on oh-my-posh.

Each milestone should be demoable on its own. Milestone 2 alone is already worth showing: the model physically
cannot edit files before the human approves the analysis.

## Context

This came out of the "Graph Engineering" section of the AI-native workshop deck
(`D:\workshop_ai_native\src\sections\graph-engineering.tsx`, slide "Demo: A Graph Written in Markdown"). The point
for the talk: the skill is the graph *written* in Markdown and *followed* by the model; the pi extension is the same
graph *written in code* and *enforced* by the harness.
