# Artifact contract between phases

<!-- harness:enforced -->
Each phase boundary is an edge in the flow, and every edge carries one named artifact. A phase is
not done until its artifact exists in this shape — "I finished the phase" without the artifact is
not a valid handoff. This is what lets a phase be re-entered (from a Verify failure or an
escalation) without re-deriving context from scratch.

## Analyze → Plan: the analysis report

Produced by Phase 1, or by either special-case entry point (issue triage, PR review comments) —
all three must emit this exact shape so Plan never has to know which door the task came in
through.

- `kind`: what the request is — `bug`, `feature`, `refactor`, `question`, `investigation`, or
  `chore`.
- `findings`: by kind. Bug: the root cause, with file references. Feature: current behavior and
  where the change fits. Refactor: what the current code does, as a list (it becomes the
  acceptance criteria). Question: the answer. Investigation: what was found. Chore: what needs
  doing and where.
- `proposed_change`: the scope of the change, in enough detail to plan tasks from. May be empty
  for a question or an investigation, or when the recommendation is to change nothing; required
  for the other kinds unless `options` are given and the human picks one.
- `out_of_scope`: what is deliberately left alone.
- `evidence`: by kind. Bug: the reproduction, or why it is unreproducible. Feature: prior art in
  the code and docs. Question: sources. Otherwise: the evidence the findings rest on.
- `open_questions`: anything still unresolved (should be empty after the stop gate clears).
- `options` (optional): alternative approaches, each with an `id`, `title`, `summary`, and
  `tradeoffs`, when there is a real design choice.
- `recommendation` (optional): the `id` of the option you recommend.

Any kind can end at the stop gate: the analysis itself is then the deliverable and no plan follows.

## Plan → Delegate: the task list

Produced by Phase 2. One entry per task:

- `spec`: approach, files/entry points, constraints, pinned skill rules, non-goals.
- `verification_commands`: what the executor must run and pass before reporting done.
- `executor_tier`: trivial, implementer, or coordinator-direct (see [delegate.md](delegate.md)).
  Escalation is never a value here — it's a bounded Q&A call layered onto whichever tier is
  executing the task, not an executor tier for the task itself.
- `workspace`: main tree or isolated worktree.
- `dependencies`: which other tasks must land first, if any.
- `merge_plan`: required whenever more than one task runs in a worktree — merge order and who
  resolves a conflict (see [plan.md](plan.md)).

## Delegate → Supervise: the delegation packet

Produced by Phase 3, one per dispatched task: the task's `spec` and `verification_commands`
unchanged, plus the standing instructions every delegation carries — report what changed and what
was verified, and stop and report on any spec gap instead of improvising scope.

## Supervise → Verify: the reviewed diff

Produced by Phase 4, after every parallel task has merged per its `merge_plan` (or, when the task
had no parallelism, after the coordinator's own self-review of its single diff — see
[supervise.md](supervise.md)):

- `merged_diff`: the final integrated change, not a per-task diff.
- `overrides`: any subagent solution the coordinator replaced, and why. Empty when the coordinator
  executed directly and found nothing to override.
- `tests_kept` / `tests_cut`: which added tests survived critical review, and why the cut ones
  were removed.

## Verify → Supervise or Verify → Analyze: the failure record

Produced by Phase 5 whenever verification fails. This is the artifact that makes the retry cap in
[verify.md](verify.md) enforceable without relying on memory across turns — the coordinator has no
state other than what it writes down, so this record must be stated explicitly in the report each
time, not tracked silently:

- `attempt_number`: how many times this task (the same originating request, regardless of how the
  diagnosis has changed) has failed Verify. 1 on the first failure, 2 on the second, and so on.
- `failure_class`: gate failure / spec mismatch, or wrong-root-cause — this is what selects the
  destination in verify.md's "On failure" section.
- `destination`: Supervise or Analyze.
- `escalation_answer`: present only after `attempt_number` reaches 2 and Escalation tier has been
  consulted — carries the decision that informed the next attempt.

When `attempt_number` would advance past 2 with an `escalation_answer` already on record, Verify's
terminal step applies instead of producing another failure record: stop and report to the user.

## Verify → Deliver: the verification evidence

Produced by Phase 5:

- `gates_run`: build, test, lint, formatter results — pass/fail, not "should pass".
- `functional_proof`: the actual observed values from exercising the real flow, not adjectives.
- `retry_count`: how many Verify cycles this task has been through (see the retry cap in
  [verify.md](verify.md)); carried through so Deliver's report can note if the fix took more than
  one pass.

## Escalate: question in, answer out

Every escalation call (from Analyze, Supervise, or Verify) carries the same minimal pair, never
the whole task:

- **Question in:** the specific judgment call, the relevant code/evidence, the hypothesis so far,
  and why it's uncertain.
- **Answer out:** the decision and its rationale. Control and ownership return to the phase that
  asked; the answer is folded into that phase's own artifact (e.g., an escalation answered during
  Analyze becomes part of `findings`, not a separate deliverable).
<!-- /harness:enforced -->

## Why this matters

A phase that can't produce its artifact isn't actually done, no matter how much work happened —
this is what stops "I looked into it" from silently standing in for a real analysis report, and
what lets Verify send a task back to Phase 1 or Phase 4 without the receiving phase having to
guess what's missing.

<!-- harness:enforced -->
The same explicit-restatement convention that carries `attempt_number` across Verify failures
applies to every other "more than once" trigger in the flow — e.g. a repeated spec gap in
[escalate.md](escalate.md) — since none of these counters persist except as text written into the
conversation.
<!-- /harness:enforced -->
