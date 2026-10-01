# Phase 2 — Plan

Turn the approved analysis into an executable plan. The quality bar: an implementer-tier model
must be able to execute each task without asking questions.

## Pin the spec

Write the spec down before delegating anything. It contains:

- The decided approach — including decisions already made, so the implementer does not relitigate
  them.
- Files to touch, and the entry points to start from.
- Constraints: style rules, patterns to follow (point at existing code), performance or
  compatibility requirements.
- The language, framework, and format skills covering the files this task touches. Load them in
  this phase, before any code is written, and copy the rules that bind this task into the spec —
  control flow, test structure, logging, comment style. A skill loaded at verification does not
  prevent violations, it converts them into rework.
- When the change replaces working code (rewrite, port, engine swap, dependency change), enumerate
  what the replaced code currently does by reading that code, not the request, and make that list
  the acceptance criteria. Keybindings, auto-inserts, defaults, and error messages all count.
  Anything on the list you intend to drop is a removal that needs the user's go before you write
  the replacement — never a simplification you report afterward.
- Sample data, demo fixtures, and shipped defaults must be generic. Never promote a real person's,
  client's, or the user's own data to the default state of the project, even when the source
  material came from them — carry it as a private example instead.
- Verification commands the implementer must run locally (build, tests, lint).
- Explicit non-goals: what the task must NOT change. This is what keeps subagents from wandering.

## Split into tasks

- One task = one self-contained unit an implementer can finish and verify on its own.
- Mark which tasks are independent and which consume another task's output. Parallelize the
  independent ones; sequence the rest. When in doubt, sequence — a merge conflict between two
  parallel subagents costs more than the parallelism saves.
- Documentation updates belong to the task that changes the behavior, not to a separate task.
- Give each task the `paths` it may change: folders (`src/segments/`), files, or globs
  (`src/**/*_test.go`). Keep independent tasks' paths disjoint; the harness runs non-overlapping
  independent tasks in parallel, each in its own worktree.
<!-- harness:enforced -->
  Independent tasks whose paths overlap are rejected: add a dependency between them or merge them.
<!-- /harness:enforced -->

## Decide the workspace per task

- Main working tree: only when the task truly must run there (e.g. it needs local services or
  state that is not in git, set `requires_main_tree`), or when you will review and commit the
  result in the current session. Uncommitted changes are not a reason: worktrees start from a
  snapshot of them and the results are applied back onto the main tree.
- Isolated worktree: everything else, especially parallel tasks — they must never share a
  working tree. When there are 2+ independent groups of files/folders, split them into separate
  sub-agent tasks with non-overlapping `paths` so they run in parallel.

## Plan the merge

When any tasks run in parallel worktrees, name the integration step now, before delegating:

<!-- harness:enforced -->
- The order branches merge back (`merge_plan.order`) is optional (plan order is the default); when
  given, it must list exactly the tasks that end up in worktrees.
<!-- /harness:enforced -->
- Who executes that merge and resolves any conflict it surfaces: the coordinator, at integration
  time in Phase 4 — never an implementer, since an isolated worktree branch never sees another
  task's branch and so can never hit or resolve a conflict against it. (`merge_plan.conflict_owner`
  is required to be non-empty; who you name there is still your judgment call.)
<!-- harness:enforced -->
- That Verify (Phase 5) only runs once, on the merged state, after every parallel task has landed
  — never per-branch. A per-task green run is not the gate.
<!-- /harness:enforced -->

<!-- harness:enforced -->
## Output of this phase

A task list where each entry names its executor tier (see Phase 3), its workspace, its
dependencies, the paths it may change, and carries its pinned spec.
<!-- /harness:enforced -->

<!-- harness:enforced -->
## Stop gate

Report the plan — the task list with specs, executor tiers, workspaces, dependencies, and
verification commands, plus the merge plan — and wait for a go before delegating. Skip the gate
only when the user gave the go for implementation in the request itself ("do it", "fix it and
commit", "implement with Sonnet"); approving the analysis at Phase 1's own gate is not, by itself,
a go for this one. A revision sent back from this gate goes back through Plan and then through
this gate again, not straight to Delegate.
<!-- /harness:enforced -->
