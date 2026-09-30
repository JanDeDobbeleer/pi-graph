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
/change <task>                 start a run (Analyze first)
/change triage <issue>          start a run at the issue-triage entry — bare "look at/triage issue
                                 #n"; the analysis itself can be the deliverable, ended at the gate
/change review <pr>             start a run at the pr-review-comments entry — "handle the review
                                 comments on PR #n"
/change <task> --approved       skip the approval gate if Analyze has no open questions
/change <task> --push           allow push, PR creation, and PR/issue replies for this run
                                 (--approved and --push combine, and go before the task/issue/pr)
/change allow-push               allow push/PR/replies mid-run, without restarting it
/change status                   show the active run's phase and failure count
/change show                     re-print the current analysis/plan/review (re-opens the active
                                 gate, analysis or plan, when there's UI)
/change approve                  approve the analysis or the plan (whichever gate is open),
                                 continue to Plan or Delegate respectively (an analysis with
                                 no proposed change needs /change choose or /change done)
/change choose <option-id>      pick one of the analysis's options and approve it (analysis gate)
/change done                     end the run at the analysis gate: the analysis is the
                                 deliverable, nothing is implemented
/change revise <feedback>        send the analysis or plan (whichever gate is open) back to
                                 Analyze/Plan with feedback
/change abort                    stop the run and clean up worktrees
/change cleanup                  remove any leftover worktrees for the active run
/change watch [pr]               watch a PR's checks (explicit; also restarts a stalled/timed-out watch)
/change resume                   re-send the current phase's instructions (or re-open the active
                                 gate) after an interruption, resetting the transient-retry counter;
                                 on a stopped run, reopen the phase it stopped in (with your
                                 confirmation) and reset the Verify retry count
/change amend-gate approve|reject  decide a pending required-gate amendment (asked for by the model
                                 with `amend_gate` when there is no UI to confirm in)
```

Analyze works for any request, not only bugs. The model first classifies it as one of six kinds
and reports accordingly:

| Kind | Findings | Evidence | Change expected |
|---|---|---|---|
| `bug` | "Root cause" | "Reproduction" | yes |
| `feature` | "Current behavior and where it fits" | "Prior art" | yes, or options to pick from |
| `refactor` | "What the current code does" (a list; it becomes the acceptance criteria) | "Evidence" | yes |
| `question` | "Answer" | "Sources" | no |
| `investigation` | "Findings" | "Evidence" | no |
| `chore` | "What needs doing" | "Evidence" | yes |

The analysis also carries `proposed_change`, `out_of_scope`, `open_questions`, and, when there is a
real design choice, `options` (each with `id`, `title`, `summary`, `tradeoffs`) plus a
`recommendation` (an option id). `proposed_change` may be empty for a question or investigation, or
when the recommendation is to change nothing; for the other kinds it is required unless options
are given. The rendered analysis starts `# Analysis — <kind>` with an editable `Kind:` line, and
its findings and evidence sections use the kind's headings (the parser accepts any kind's heading,
plus the neutral "Findings"/"Evidence"). Sessions saved before this change (with `root_cause` and
`repro_status`) migrate on restore to `kind: bug`, `findings`, `evidence`.

At the Analyze approval gate ("Review the `<kind>` analysis above"), the human picks one of: **Go
with `<id>` — `<title>`** (one entry per option, the recommended one marked; records the choice and
continues to Plan, like `/change choose <id>`); **Approve** and **Approve and allow push/PR**
(same as approve, plus `/change allow-push`; only offered when a change is proposed or an option
was chosen); **Edit the analysis myself** (opens an editor pre-filled with the analysis — the edits
become the approved artifact, recorded as `analysisEditedByHuman`); **Send feedback to revise**
(same as `/change revise`); **Done — no implementation** (any kind: end the run here with the
analysis as the deliverable; same as `/change done`); or **Stop the run**. A `--approved` run
skips the gate only when the analysis has a proposed change (or a recommendation to take), no open
questions, and no earlier Verify failure; a question or investigation always stops at the gate.

Plan ends with its own gate, right after `submit_plan`, mirroring the analysis gate: **Approve —
start delegation**; **Edit the plan myself** (opens an editor pre-filled with the plan as JSON,
preceded by a short comment explaining the fields — the edits become the approved plan, recorded as
`planEditedByHuman`, and packets are rebuilt from it); **Send feedback to revise** (back to Plan
with the feedback); or **Stop**. Both gates are skipped only when the run was started with
`/change --approved` (`state.preApproved`); `/change approve`, `/change revise <feedback>`, and
`/change show` all work against whichever gate — analysis or plan — is currently open.

Supervise can hand a stuck implementer a decision without restarting it: `resume_task` (params
`task_id`, `answer`) resumes that task in its own workspace. Implementers report a blocking
ambiguity with a `SPEC GAP:` line; a task also has a per-task time budget — an implementer that
exceeds it is killed and marked stalled. A second `SPEC GAP:` on the same task escalates
automatically instead of asking Supervise to keep deciding.

Each phase's instructions (the stripped skill references) go to the model in full, but the
transcript shows them as a one-line `code-changes · <Phase> phase` header; expand tool output to
read them. The analysis, final report, hook failures and CI failures always render in full.

## What is enforced

| Gate | Mechanism |
|------|-----------|
| Only the current phase's tools are callable | `tool_call` handler + `pi.setActiveTools(...)` per phase |
| Analyze/Plan/awaiting_plan_approval/Delegate/CI are read-only (no edit/write, bash restricted) | `isReadOnlyCommand` allowlist in `gates.ts`, including directory-navigation commands (`cd`, `pushd`/`popd`, `Set-Location`/`sl`, `Push-Location`/`Pop-Location`) |
| Analyze and Plan can still fetch external context (issues, PRs, docs) | read-only `gh` (issue/pr/run/workflow/release `view`/`list`, `pr diff`/`checks`, `repo view`, `search`, `label list`, read-only `api`), `curl`/`Invoke-WebRequest` GETs, and `git fetch`/`git ls-remote` are allowed by `isReadOnlyCommand`; any registered read-only tools from other extensions (web fetch/search, MCP bridges) are also activated — see `readOnlyTools` below |
| A phase cannot be left without its artifact | one `submit_*` tool per edge; validation throws until the artifact is complete |
| The human approves (or revises) the analysis | `agent_settled` gate: `ctx.ui.select` when Analyze finishes, or `/change approve|revise` |
| The human approves (or revises) the plan | `agent_settled` gate: `ctx.ui.select` when Plan finishes, or `/change approve|revise`; skipped only when the run started with `/change --approved` |
| A transient provider error pi's own retry doesn't cover (e.g. `499`) doesn't kill the run | `agent_before_settle` catches `outcome: "error"`, matches `isTransientProviderError` (`retry.ts`), and retries up to 3 times with backoff before asking the user to `/change resume` |
| Verify's "pass" needs real gate results | `run_gates` records exit codes; `submit_verification` rejects "pass" unless every required command is on record and green |
| Verify's "pass" needs green stop hooks | `submit_verification` runs the repo's Stop hooks itself right before checking "pass"; any hook that blocks rejects the pass (named, with its reason) |
| Verify's "pass" is refused while a CI failure is unclassified | `state.ciFailure` must be cleared by a `submit_verification` **fail** first |
| A second Verify failure escalates, a third stops | retry counter in `WorkflowState.failures`, not in the prompt |
| Delivery uses conventional commits | commit subjects collected from `git log <baseRef>..HEAD` and validated against the conventional-commit grammar |
| A PR's checks are watched before a run completes | Deliver routes to a "ci" phase instead of "done" when a PR is known; the harness polls `gh pr checks` and only transitions the run once they resolve |
| State survives resume/fork | `pi.appendEntry(STATE_ENTRY, state)` on every transition, restored on `session_start` |
| Push, PR creation, and PR/issue replies are blocked unless allowed | `WorkflowState.pushAllowed` (set by `--push` at start or `/change allow-push` mid-run), enforced in `gates.ts`/`delivery` |
| Staging must be explicit | `git add -A` / `git add .` / `git commit -a` are rejected by `isReadOnlyCommand`'s sibling staging check in `gates.ts` |
| Every sub-agent task declares the `paths` it may change, and independent tasks may not overlap | `validatePlan` in `artifacts.ts` rejects a plan where a trivial/implementer task has no `paths`, where a path is absolute or contains `..`, or where two independent (no transitive dependency either way) sub-agent tasks have overlapping paths (`paths.ts`); coordinator-direct tasks run later in Supervise and are exempt |
| Independent tasks with disjoint paths run in parallel, decided by the harness | `effectiveWorkspace` (`planning.ts`) moves such "main" tasks into worktrees; `runDelegation` runs them concurrently, capped by `maxParallel` |
| An implementer that strays outside its declared paths is flagged | after every implementer run `delegate.ts` diffs the changed files against the task's `paths`; strays land in `TaskRun.out_of_scope` and as a spec-gap line (so a repeat escalates), and Supervise's prompt lists them |
| A repeated implementer spec gap escalates automatically | `TaskRun.spec_gaps` count tracked in `state.ts`/`delegate.ts`; a second `SPEC GAP:` on the same task triggers `escalate.ts` without waiting for Supervise to ask |
| A stalled implementer is killed and surfaced, not left hanging | per-task time budget enforced in `delegate.ts`; `TaskRun.stalled` flips true and Supervise is prompted to `resume_task` |

## Skill and harness

`skills/code-changes/` stays the standalone source of truth: read on its own — by Claude Code,
GitHub Copilot, or any other agent that doesn't load this pi extension — it describes the full
workflow in Markdown and works unmodified.

Sections of that Markdown describe flow this harness now enforces in code, which would otherwise
duplicate (or drift from) the code, or actively contradict a model that's being told by both. Those
sections are wrapped in `<!-- harness:enforced -->` … `<!-- /harness:enforced -->` markers, on their
own lines. A standalone Markdown reader ignores HTML comments, so the guidance still reads
normally; `readReference`/`stripEnforced` in `extensions/code-changes/prompts.ts` strip the marked
blocks before a reference file is injected into a phase prompt (`readReference(name, { harness:
false })` opts back into the raw file — used only by the guard test that checks the source file
itself still has its standalone content).

The markers must wrap only rules the code enforces — never judgment or craft guidance a model still
has to apply. What's wrapped, per file, and what enforces it:

| Reference file | Wrapped | Enforced by |
|---|---|---|
| `analyze.md` | "Output of this phase" (the schema is a tool now), "Stop gate" | `AnalysisSchema` in `artifacts.ts`; the `agent_end` approval gate in `index.ts` |
| `plan.md` | "Output of this phase"; the once-on-merged-state part of "Plan the merge"; the "overlapping independent tasks are rejected" sentence of the `paths` bullet (the rest of that bullet, the `merge_plan` guidance, and the workspace decision stay visible) | `PlanSchema`/`validatePlan` in `artifacts.ts` |
| `delegate.md` | Everything except the executor-tier bullets (which tier fits which task, "delegate anyway when there's real parallelism") | Tier choice is still a Plan-time judgment call; the rest (what a delegation carries, what's never delegated downward) is standing instructions the harness already sends (`STANDING_INSTRUCTIONS` in `artifacts.ts`) or enforces via `PHASE_TOOLS` |
| `supervise.md` | "Integrate before reviewing" | `delegate.ts`'s squash-merge per `merge_plan`; only an actual conflict is left for the model to resolve |
| `verify.md` | "Retry cap"; the routing half of "On failure" (the → destination, not the gate-failure/spec-mismatch/wrong-root-cause definitions, which the model still classifies) | `state.failures`/`applyVerification` in `artifacts.ts` |
| `escalate.md` | The "Verify sent the same task back twice" and "repeated spec gap" trigger bullets | Both fire automatically from `state.failures` / `TaskRun.spec_gaps` instead of the model tracking a count in prose |
| `deliver.md` | The conventional-commit-format bullet | `CONVENTIONAL_COMMIT`/`validateCommitSubjects` in `artifacts.ts` |
| `artifacts.md` | Everything except a short "Why this matters" | The field lists are TypeBox tool schemas now (`artifacts.ts`); the file is no longer injected into any phase prompt at all |
| `SKILL.md` | Not injected (never read by this extension) | One added, unwrapped note tells a human/agent running under the harness not to re-run the skill's own flow manually |

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

## Gates: shell, plan-time check, unrunnable gates

- **Same shell as the model's `bash` tool.** `run_gates` runs each command with `bash -c` inside the
  repo, in the shell pi's own `bash` tool resolves (`getShellConfig` from pi: `shellPath` in pi's
  `settings.json`, Git for Windows in `Program Files`, `/bin/bash`, ...). If pi has none, it falls
  back to the resolver the Stop hooks use (`CLAUDE_CODE_GIT_BASH_PATH`, Git Bash derived from
  `git`, any bash on PATH that isn't the System32/WindowsApps WSL stub), and last to the platform
  shell (`cmd.exe` / `sh`). Previously gates ran through `cmd.exe` on Windows, so a plan that
  worked in the model's bash (`grep ... || true`) failed in Verify. The `run_gates` table has a
  `shell` column and every `GateResult` records it. The shell logic lives in `shell.ts`.
- **Plan-time check.** On `submit_plan`, the first word of each segment of every verification
  command (split on `&&`, `||`, `;`, `|`, quote-aware; builtins, keywords and `A=b` assignments
  skipped) is looked up in the gate shell with `command -v` (or `where` for cmd.exe), in one
  invocation with a 5 s timeout (`gatecheck.ts`). A missing program rejects the plan, naming the
  command, the program and the shell, so the model can rewrite the gate while it is still cheap.
  If the check itself can't run, the plan is accepted with a warning.
- **Unrunnable gates.** A failed gate whose exit code is 127, or whose output says the program or
  path doesn't exist (`is not recognized`, `command not found`, `cannot find the path`, ...), or
  that failed to spawn, is marked `runnable: false`. `run_gates` reports it as `NOT RUNNABLE
  (environment)` and points at `amend_gate`. If every failing required gate is unrunnable,
  `submit_verification fail` records a `harness` failure: it routes to Supervise but does **not**
  count toward the retry cap (the second-failure escalation and third-failure stop only count
  real failures). A pass still needs every required gate runnable and green.
- **`amend_gate`** (Supervise and Verify; params `gate`, optional `replacement`, `reason`; omit
  `replacement` to remove the gate). Required gates are frozen at plan time, so this is the only
  way to change one, and it always needs the user: `ctx.ui.confirm` when there is a UI, otherwise
  the request is stored as pending and the user runs `/change amend-gate approve|reject`. The
  replacement goes through the same plan-time program check. Approved amendments are recorded in
  `state.gateAmendments`, applied by `requiredGateCommands`, and listed in the Deliver prompt so
  the report says so. The model is told never to use it to weaken a meaningful check.

## Stopped runs and follow-up runs

- **Reopen a stopped run.** When a run stops (a third Verify failure, a failed escalation, `/change
  abort`, "Stop the run" at a gate), the phase it stopped in is remembered (`stoppedFrom`).
  `/change status` then says `Stopped — /change resume to reopen <phase>`. `/change resume`
  confirms with the stop reason, reopens that phase, and restarts the Verify retry count (earlier
  failures stay in the history but no longer count; the marker is persisted with a
  `code-changes-resume` entry).
- **Carry context into the next run.** `/change <task>` right after a run finished or stopped in the
  same session attaches a compact summary of it (task, kind, findings, proposed change, delivery
  report or stop reason, files changed) as `state.previousRun`; the new run's Analyze prompt shows
  it under "Previous run in this session".

## Transient provider errors

pi's own agent-level retry (`pi-ai`'s `RETRYABLE_PROVIDER_ERROR_PATTERN`) already covers the common
transient cases — 429/500/502/503/504, network errors, timeouts — but not everything a gateway can
return mid-stream, e.g. `499 status code (no body)`. Without a second layer, one of those kills the
whole `/change` run.

- While a `/change` run owns a model-driven phase (Analyze, Plan, Delegate, Supervise, Verify,
  Deliver) and the turn ends with `outcome: "error"`, `agent_before_settle` looks at the last
  assistant message's `errorMessage` and, if it matches `isTransientProviderError` (`retry.ts`) and
  the run hasn't already retried 3 times for this phase (`WorkflowState.transientRetries`, reset on
  every phase transition), waits a backoff (`2000 * 2^(n-1)` ms, abortable) and feeds the model a
  short retry-feedback message so the turn continues automatically. The user sees an info
  notification each time.
- Quota/billing/auth/validation errors (`insufficient_quota`, `401`/`403`, "context length
  exceeded", ...) are never treated as transient, even if they happen to also match a transient
  pattern.
- Once the cap is reached, a warning notification points at `/change resume`, which resets the
  retry counter and re-sends the current phase's instructions (or re-opens the active gate),
  telling the model to continue from where it stopped without redoing finished work.

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
  },
  "readOnlyTools": ["mcp__docs__*"],
  "maxParallel": 4
}
```

Defaults (from `models.ts`) are shown above. `"session"` (or omitting a tier) keeps whatever model
the session is already using instead of switching. An unresolvable model reference falls back to
the current model and triggers a one-time warning.

`maxParallel` (integer 1..16, default 4; the project file wins over the user file, invalid values
are ignored) caps how many implementer processes run at the same time during Delegate.

`readOnlyTools` names (glob patterns with `*` allowed) other registered extensions' read-only tools
— web fetch/search, MCP documentation bridges, and similar — that should be activated on top of the
phase's built-in tool set in Analyze, Plan, Supervise, and Verify (never Delegate, CI, or
awaiting_approval, which don't do research). The default list already covers the common names
(`web_fetch`, `webfetch`, `fetch`, `web_search`, `websearch`, `search`); user config and project
config both add to that list rather than replacing it, and an entry that names `edit`, `write`,
`bash`, `powershell`, or any workflow tool is ignored so it can never widen what a read-only phase
can actually do.

## Gate decisions and suggestions

Every human decision at the analysis and plan approval gates is recorded. This covers approve,
choose an option, edit, revise (with the feedback), done, and stop/abort, from the dialog or from
a `/change` command. Each record holds the artifact exactly as the human saw it, the review round,
and any suggestion shown. It is written in two places:

- a `code-changes-gate-decision` entry in the session
- one JSON line in `~/.pi/agent/code-changes/gate-decisions.jsonl`, across projects

Every gate is decided by a human, so each record is a ground-truth label for "would the human take
this artifact as submitted?". That is the data any automated gate decision has to be measured
against before it can be trusted.

```json
{
  "gateLog": "~/.pi/agent/code-changes/gate-decisions.jsonl",
  "gateAdvisor": {
    "provider": "jev",
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "model": "jev-latest",
    "endpoint": "https://api.typesafe.ai/v1/systemone",
    "timeoutMs": 4000,
    "gates": ["analysis", "plan"]
  }
}
```

`gateLog` takes a path (relative to the config file's base: the repo for the project file, home
for the user file) or `false` to turn off the file (session entries are still written).

`gateAdvisor` is off unless configured and its API key variable is set. When it is on, the gate
asks [Jev](https://typesafe.ai/), TypeSafe's typed-decision model, which choice the human is likely
to make. The suggestion moves to the top of the dialog, marked `◂ suggested by Jev (88%)`. Without
a UI, it is added to the hint as the matching `/change` command. The human still decides.
Guardrails:

- Jev is never offered "Approve and allow push/PR"; push is a permission, not a judgment.
- Jev is never offered approve or choose while the analysis has open questions.
- Advice is cached per artifact, so re-opening a gate does not call Jev again.
- An error or timeout means no suggestion; it never blocks the gate.
- The request sends the task and the artifact text (the analysis or the plan) to TypeSafe.

Each logged decision records the suggestion and whether it was followed. Jev's confidence is
uncalibrated, so fit a threshold on this log before relying on it.

## Parallel delegation

The harness, not the model, decides which tasks run in parallel.

- **`paths`**: every trivial/implementer task in the plan lists the repo-relative folders, files or
  globs it may change (`"src/segments/"`, `"website/docs/segments/cloud/gcp.mdx"`,
  `"src/**/*_test.go"`; `/` separators, Windows `\` is normalized). Absolute, drive-letter and `..`
  paths are rejected. Coordinator-direct tasks may omit them.
- **Overlap rule**: two tasks that are *independent* (neither transitively depends on the other) must
  not be able to change the same files. The check is conservative: equal patterns, a directory and
  anything under it, and globs whose static prefix (up to the first glob character, cut at the last
  `/`) is prefix-related all count as overlapping; `**`, `.` and an empty pattern mean everything.
  `src/a` and `src/ab` are siblings, not overlapping. An overlapping pair is rejected at
  `submit_plan` (and when the human edits the plan): add a dependency between the tasks or merge them.
- **Auto-worktree**: a task the plan leaves in the `main` workspace is moved into a git worktree
  (`effectiveWorkspace`) when it shares a dependency wave with at least one independent sub-agent
  task and does not set `requires_main_tree`. A task that depends on a moved task is moved along with
  it, so its worktree can merge those branches in; a task that (transitively) feeds a
  `requires_main_tree` task stays in the main tree. Moved runs have `TaskRun.auto_worktree = true`
  and a line in the merge log (`task X moved to a worktree to run in parallel with Y`). The plan
  approval view leads with an **Execution** overview: per wave a table of task, tier and model, workspace and paths (parallel or sequential, which tasks moved), heads-ups (model fallbacks, uncommitted main-tree changes), then merge order, gates and delivery.
- **`requires_main_tree`**: set it only when a task needs the uncommitted changes in the main tree;
  worktrees branch from `HEAD` and do not see them. It is never moved.
- **`merge_plan`** is optional. Since the harness decides the final workspaces, when it is omitted the
  worktree branches are merged in plan order. When present, `merge_plan.order` must list exactly the
  tasks that end up in worktrees (computed with the same `effectiveWorkspace`), and `conflict_owner`
  must be non-empty.
- **Concurrency cap**: at most `maxParallel` (default 4) implementer processes run at once. The
  main-tree tasks of a wave run one after another and count as one slot.
- **Scope check**: after each implementer run the harness lists the files it changed. For a
  worktree, that is everything since the commit the worktree's own work started from (committed,
  staged, unstaged and untracked). For the main tree, it is the files that are new or changed
  compared with a snapshot taken just before the run, so files that were already dirty do not count.
  Files not matching the task's `paths` go into `TaskRun.out_of_scope` and one spec-gap line,
  `changed files outside its declared paths: a, b`. The run is not failed. `resume_task` recomputes
  the check.

## Delegation details

- Each worktree task gets its own `git worktree add -b pi-cc/<run-id>/<task-id> <path> HEAD`, in the
  OS temp dir.
- Tasks run wave-by-wave by dependency order: worktree tasks in a wave run in parallel (up to
  `maxParallel`), main-tree tasks in a wave run sequentially in the main working tree.
- Each dispatched task runs in a fresh, session-less child `pi` process (`--no-extensions
  --no-session --mode json`), so it never re-loads this extension or any other project extension.
- After every wave, successful worktree branches are squash-merged back into the main tree in
  `merge_plan.order` (or plan order), stopping at the first conflict so Supervise can resolve it.
- Worktrees are removed on `/change abort`, `/change cleanup`, and successful delivery - not
  automatically at any other point, so a failed run can still be inspected.

## Known limits

- Bash is still available (read-write) in Supervise, Verify, and Deliver, since those phases need
  it to run builds, tests, and git. Only Analyze/Plan/Delegate are hard-gated to read-only, and only
  `edit`/`write` are blocked outright in Analyze. A model can still misuse bash to write files in
  the later phases — the gate is a strong deterrent and an audit trail, not a sandbox.
- A main-tree task that depends on a worktree task you declared (`workspace: "worktree"`) only sees
  that dependency's changes after the final merge step (once every wave has run), because worktree
  branches only land in the main tree at the end. Plan tasks accordingly, or put both in the same
  workspace when one needs to see the other's files mid-run. (Tasks the harness moves itself are
  handled: their dependents move with them.)
- The overlap check compares declared `paths`; it cannot know what an implementer actually edits.
  The scope check flags strays after the fact, and a real conflict still surfaces at merge time.

## Development

```
npm install
npm test
npm run typecheck
```

The extension's logic lives in `extensions/code-changes/{state,artifacts,paths,planning,gates,models,escalate,runner,delegate,hooks,ci}.ts`
(pure functions, unit-tested) with `index.ts` and `prompts.ts` as the pi-facing glue. The bundled
skill (`skills/code-changes/`) is a copy of the oh-my-posh `code-changes` skill and works standalone
without this extension, describing the same workflow in Markdown for agents that don't load pi
extensions.
