# pi-graph

The `code-changes` skill — analyze, plan, delegate, supervise, verify, deliver — packaged as a
[pi](https://pi.dev/) extension. The skill stays the source of truth for what each phase does; this
package adds enforcement: a model cannot edit code before a human approves the analysis, cannot
report a passing Verify without green gates it actually ran, and cannot loop past a second failed
attempt without an escalation on record.

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
                                              Deliver ─▶ PR known? ─▶ CI (watched) ─┬─▶ pass/none ─▶ Done
                                                              │                     └─▶ fail ─▶ back to Verify (classify, fix, re-verify, re-deliver)
                                                              └─▶ no PR ─▶ Done
```

Each edge is a typed artifact the model must submit through a dedicated tool (`submit_analysis`,
`submit_plan`, `run_delegation`, `submit_review`, `run_gates` + `submit_verification`,
`submit_delivery`) before the harness lets the phase advance. The `escalate` tool is a bounded
side-call, not a new owner — the answer folds back into the phase that asked.

## Install

```
# personal use, every repo
pi install git:github.com/JanDeDobbeleer/pi-graph@v1

# project-local, committed to .pi/settings.json
pi install -l git:github.com/JanDeDobbeleer/pi-graph@v1

# development, from inside this repo
pi -e ./extensions/code-changes/index.ts
```

## Usage

```
/change <task>              start a run (Analyze first)
/change --approved <task>   start a run that skips the approval gate if Analyze has no open questions
/change status               show the active run's phase and failure count
/change approve               approve the analysis, continue to Plan
/change revise <feedback>     send the analysis back to Analyze with feedback
/change abort                  stop the run and clean up worktrees
/change cleanup                 remove any leftover worktrees for the active run
/change watch [pr]              watch a PR's checks (explicit; also restarts a stalled/timed-out watch)
```

## What is enforced

| Gate | Mechanism |
|------|-----------|
| Only the current phase's tools are callable | `tool_call` handler + `pi.setActiveTools(...)` per phase |
| Analyze/Plan/Delegate/CI are read-only (no edit/write, bash restricted) | `isReadOnlyCommand` allowlist in `gates.ts` |
| A phase cannot be left without its artifact | one `submit_*` tool per edge; validation throws until the artifact is complete |
| The human approves (or revises) the analysis | `agent_end` gate: `ctx.ui.select` when Analyze finishes, or `/change approve|revise` |
| Verify's "pass" needs real gate results | `run_gates` records exit codes; `submit_verification` rejects "pass" unless every required command is on record and green |
| Verify's "pass" needs green stop hooks | `submit_verification` runs the repo's Stop hooks itself right before checking "pass"; any hook that blocks rejects the pass (named, with its reason) |
| Verify's "pass" is refused while a CI failure is unclassified | `state.ciFailure` must be cleared by a `submit_verification` **fail** first |
| A second Verify failure escalates, a third stops | retry counter in `WorkflowState.failures`, not in the prompt |
| Delivery uses conventional commits | commit subjects collected from `git log <baseRef>..HEAD` and validated against the conventional-commit grammar |
| A PR's checks are watched before a run completes | Deliver routes to a "ci" phase instead of "done" when a PR is known; the harness polls `gh pr checks` and only transitions the run once they resolve |
| State survives resume/fork | `pi.appendEntry(STATE_ENTRY, state)` on every transition, restored on `session_start` |

## Stop hooks

Many repos already define an "agent finished its turn" check for Claude Code or GitHub Copilot:

- Claude Code: `Stop` hooks in `.claude/settings.json` / `.claude/settings.local.json`.
- GitHub Copilot CLI: `agentStop` hooks in every `.github/hooks/*.json`.

This extension reads those files directly — there is no separate, proprietary hook config of its
own — and runs whichever one a repo defines, on every settling turn (`agent_before_settle`), whether
or not a `/change` run is active:

- **Discovery** happens once per session (`session_start`), cached, and is refreshed whenever a new
  `/change <task>` run starts. When a repo defines hooks under **both** `.claude/` and
  `.github/hooks/`, Copilot's `agentStop` wins outright and the Claude hooks are skipped (repos like
  oh-my-posh register the same program under both, and the Copilot CLI itself also reads
  `.claude/settings.json`; running both would duplicate the check).
- **Precedence / merge**: `.claude/settings.json`'s `Stop` hooks run first, then
  `.claude/settings.local.json`'s (append, not override); every `.github/hooks/*.json` file is
  read, sorted by filename.
- **Harness emulation**: each hook is spawned exactly the way its own harness would — the same stdin
  JSON shape (`hook_event_name`, `cwd`, `stop_hook_active`, ...), the same block contract (`exit 2`
  with the reason on stderr, or `exit 0` with `{"decision":"block","reason":...}` on stdout), and
  `${CLAUDE_PROJECT_DIR}` expansion for Claude-format commands. A repo's existing hook program (e.g.
  oh-my-posh's `.agents/hooks/main.go`) behaves the same under this extension as it does under the
  real Claude Code / Copilot CLI.
- **When it runs**: skipped in read-only phases (Analyze/Plan/Delegate/CI — nothing could have
  changed there), skipped when the turn aborted or errored, skipped when no hooks are configured,
  and skipped outside Supervise/Verify/Deliver when `git status --porcelain` is clean (nothing to
  check). Otherwise it always runs in Supervise/Verify/Deliver, and outside those phases whenever
  the tree is dirty.
- **Loop cap**: a blocked stop feeds the model's own feedback back in and lets it try again
  (`agent_before_settle` returning `{ continue: true, entries: [...] }`), exactly like Claude Code's
  own `stop_hook_active` loop. After two consecutive blocks the harness gives up and notifies the
  user instead of continuing indefinitely (`StopHookGuard`).
- **Verify integration**: `submit_verification` additionally runs the hooks itself, fresh, right
  before accepting a "pass" (never with `stop_hook_active`), and rejects the pass — naming the hook
  and its reason — if any of them blocked. Their results are folded into Verify's gate evidence as
  `hook(<source>): <command>` entries.
- **Windows bash**: the first `bash` found by a naive `PATH` scan on Windows is very often
  `C:\Windows\System32\bash.exe` — the WSL launcher stub — which would run a repo's hook *inside
  WSL* against the WSL filesystem, not the Windows checkout the harness is actually operating on.
  This extension resolves the same Git Bash Claude Code itself uses: `CLAUDE_CODE_GIT_BASH_PATH` if
  set, else Git Bash derived from `git`'s own location on `PATH` (`...\Git\cmd`, `...\Git\bin`, or
  `...\Git\mingw64\bin` → `...\Git\bin\bash.exe`), else any `bash.exe` on `PATH` that isn't under
  `%SystemRoot%\System32`/`SysWOW64` or `WindowsApps`.

## CI watching

Whenever a PR is created, linked, or code is pushed to a branch with an open PR, the harness watches
that PR's checks for the pushed commit using the `gh` CLI (`gh pr checks`), so a run never reports
success while CI is still red.

- **Triggers**: a `git push` / `gh pr create` bash or powershell call, a GitHub PR URL appearing in
  a tool result's output, a PR URL pasted into a chat message, or the explicit `/change watch [pr]`
  command. Only **open** PRs are watched. If the PR's current head differs from local `HEAD` (the
  push hasn't landed on GitHub yet), the watch still starts — `watchChecks` reports the mismatch as
  "stale" once it sees it, and a later push for the same PR number supersedes the earlier watch.
- **Inside a `/change` run**: `submit_delivery` routes Deliver to a new **ci** phase instead of
  **done** whenever a PR is known (detected during Deliver, or resolved for the current branch at
  submit time). The model is idle in this phase — only read-only inspection tools are available —
  while the harness polls in the background and resumes the run once the checks resolve:
  - **pass** → the run completes (**done**).
  - **none** (no checks configured) → the run completes (**done**), noted in the delivery report.
  - **fail** → routes back to **Verify** with the failure attached (`state.ciFailure`); the model
    must classify it via `submit_verification` **fail** (`gate_failure`/`spec_mismatch` → Supervise,
    `wrong_root_cause` → Analyze — the normal retry cap still applies), fix it, verify green again
    locally, and Deliver/push again, which starts a fresh watch. A `submit_verification` **pass** is
    refused while `state.ciFailure` is set.
  - **timeout/error** → the run stays in **ci**; `/change watch` restarts the watch, `/change abort`
    stops it.
- **Outside a `/change` run** (e.g. the user just pushes during a normal session): a CI failure is
  posted back to the model as a follow-up turn so it can fix it, capped at 2 automatic fix cycles per
  PR per session — after that the harness only notifies instead of prompting another turn.
- Requires an authenticated `gh` (GitHub CLI); without it, `resolvePr`/`gh pr checks` simply find
  nothing to watch, and a run without a detected PR completes normally at **done**.

## Model tiers

Configure per-tier models in `~/.pi/agent/code-changes.json` (personal) or `.pi/code-changes.json`
(project, takes precedence):

```json
{
  "tiers": {
    "escalation": "anthropic/claude-fable-5-1",
    "coordinator": "session",
    "implementer": "anthropic/claude-sonnet-5",
    "trivial": "anthropic/claude-haiku-4-5"
  }
}
```

Defaults (from `models.ts`) are shown above. `"session"` (or omitting a tier) keeps whatever model
the session is already using instead of switching. An unresolvable model reference falls back to
the current model and triggers a one-time warning.

## Delegation details

- Each worktree task gets its own `git worktree add -b pi-cc/<run-id>/<task-id> <path> HEAD`, in the
  OS temp dir.
- Tasks run wave-by-wave by dependency order: worktree tasks in a wave run in parallel, main-tree
  tasks in a wave run sequentially in the main working tree.
- Each dispatched task runs in a fresh, session-less child `pi` process (`--no-extensions
  --no-session --mode json`), so it never re-loads this extension or any other project extension.
- After every wave, successful worktree branches are squash-merged back into the main tree in
  `merge_plan.order` (or plan order), stopping at the first conflict so Supervise can resolve it.
- Worktrees are removed on `/change abort`, `/change cleanup`, and successful delivery — not
  automatically at any other point, so a failed run can still be inspected.

## Known limits

- Bash is still available (read-write) in Supervise, Verify, and Deliver, since those phases need
  it to run builds, tests, and git. Only Analyze/Plan/Delegate are hard-gated to read-only, and only
  `edit`/`write` are blocked outright in Analyze. A model can still misuse bash to write files in
  the later phases — the gate is a strong deterrent and an audit trail, not a sandbox.
- A main-tree task that depends on a worktree task only sees that dependency's changes after the
  final merge step (once every wave has run), because worktree branches only land in the main tree
  at the end. Plan tasks accordingly, or put both in the same workspace when one needs to see the
  other's files mid-run.

## Development

```
npm install
npm test
npm run typecheck
```

The extension's logic lives in `extensions/code-changes/{state,artifacts,gates,models,escalate,runner,delegate,hooks,ci}.ts`
(pure functions, unit-tested) with `index.ts` and `prompts.ts` as the pi-facing glue. The bundled
skill (`skills/code-changes/`) is a copy of the oh-my-posh `code-changes` skill and works standalone
without this extension, describing the same workflow in Markdown for agents that don't load pi
extensions.
