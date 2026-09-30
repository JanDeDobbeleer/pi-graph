# Phase 1 — Analyze

Start every task here, no matter how it arrived: issue link, PR number, verbal idea, bug report,
feature request, question — with two exceptions that use a sharper deliverable instead: a bare
"look at/triage issue #n" with no implementation asked for goes to
[issue-triage.md](issue-triage.md), and "handle the review comments on PR #n" goes to
[pr-review-comments.md](pr-review-comments.md). If the request already asks for a fix ("fix issue
#n", "issue #n: users can't log in"), analysis and an implicit go are both present — use this file
directly, not issue-triage.md. No code gets written or edited during this phase.

## Gather the full context

- Issues and PRs: `gh issue view <n> --comments` / `gh pr view <n> --comments`, plus linked
  issues, referenced discussions, and any code the report points at.
- Ideas and verbal requests: restate the goal and constraints in your own words. If the request
  is ambiguous, resolve the ambiguity now — not halfway through implementation.
- Read the actual implementation. Never reason from the issue text, a review comment, a stack
  trace, or the request alone — reports and bot reviewers are frequently wrong.
- Check for prior art: existing helpers, similar segments/modules, and past commits that touched
  the same area (`git log -- <path>`).

## Classify the request

Decide what kind of request this is, then follow that kind's section below. The kind decides what
the report's findings and evidence are, and whether a change is expected at all.

- **bug** — something behaves differently from what it should.
- **feature** — new or extended behavior.
- **refactor** — restructure without changing behavior.
- **question** — the user wants to understand something; the answer is the deliverable.
- **investigation** — the user wants something looked into (performance, feasibility, an
  incident); the findings are the deliverable.
- **chore** — dependency bumps, config, docs, renames, release housekeeping.

When a request mixes kinds, pick the one that drives the change and mention the rest in the
findings. The human reviews the analysis and can redirect it, so a wrong guess is cheap; a
silently wrong classification is not — say which kind you chose.

<!-- kind:bug -->
## Bug

Reproduce the problem when possible. A reproduction turns the analysis from a hypothesis into a
fact and gives Phase 5 its verification case for free. When reproduction is impossible (platform,
hardware, credentials), say so explicitly in the report and mark the fix as unverified-by-repro.

- Find the root cause in the code, not in the report text.
- Distinguish the root cause from the symptom. Fixing where it crashes is not the same as fixing
  why it crashes.
- State what the change should be, which files it touches, and what it deliberately leaves alone.

Findings are the root cause with file references; evidence is the reproduction (or why there is
none).
<!-- /kind:bug -->

<!-- kind:feature -->
## Feature

- Explain how the area works today and where the new behavior fits: entry points, data flow,
  the modules it would touch.
- Look for prior art in the codebase and docs: an existing feature that already does something
  similar, and the conventions it follows. New work should look like it belongs.
- When there is a real design choice, lay out the options with their trade-offs and recommend one.
  Do not present a single approach as the only one when it is not.
- Identify what else changes with it: documentation, schema or config, migrations, tests.

Findings are the current behavior and where the change fits; evidence is the prior art. Put the
options in the report's `options` with one `recommendation`; the human picks at the gate.
<!-- /kind:feature -->

<!-- kind:refactor -->
## Refactor

- Enumerate what the current code does by reading it: every behavior, edge case, and side effect
  the code has today, as a list. That list is the acceptance criteria — the refactor is done
  when all of it still holds. See the refactor rule in [plan.md](plan.md).
- Note the tests that already pin the behavior, and the gaps that would need a characterization
  test first.
- When there are several ways to restructure it, give the options with trade-offs and recommend
  one.

Findings are the list of what the current code does; evidence is where you read it and which
tests pin it.
<!-- /kind:refactor -->

<!-- kind:question -->
## Question

- Answer from the code and docs, with file references, not from memory of how such systems
  usually work.
- Say what you could not confirm.
- No change is needed unless the answer reveals one (a bug, a stale doc); in that case say so and
  propose it, otherwise leave `proposed_change` empty.

Findings are the answer; evidence is the sources you read.
<!-- /kind:question -->

<!-- kind:investigation -->
## Investigation

- State what was looked into and how: commands run, code read, data checked.
- Report what was found, separating facts from inference.
- Recommend next steps. If they involve a change, propose it (or give options); if not, leave
  `proposed_change` empty.

Findings are what was found; evidence is what it rests on.
<!-- /kind:investigation -->

<!-- kind:chore -->
## Chore

- Say what needs doing and where: the files, the commands, the order.
- Chores are usually trivial-tier work (see [model-tiers.md](model-tiers.md)); say so when it
  applies.
- Note anything that could break as a side effect (lockfiles, generated files, CI).

Findings are what needs doing and where; evidence is what confirms it (versions, references).
<!-- /kind:chore -->

## When to escalate

If the cause or the right answer can't be pinned with confidence, or the change looks
architectural, security-sensitive, or irreversible, hand the specific question to the strongest
available model instead of guessing — see [escalate.md](escalate.md). Resume ownership of the
phase once the question is answered.

<!-- harness:enforced -->
## Output of this phase

A short analysis report to the user containing:

1. The kind of request, and the findings for that kind: the root cause (bug), the current behavior
   and where the change fits (feature), what the current code does (refactor), the answer
   (question), what was found (investigation), or what needs doing (chore) — with file references.
2. The proposed change and its scope. It may be empty for a question or an investigation, or when
   the recommendation is to change nothing.
3. Options with trade-offs and a recommendation, when there is a real design choice. Any kind may
   offer them. An option that needs no repository change (existing config or docs already answer
   it) sets `no_change: true`; choosing it ends the run with the analysis as the deliverable.
4. What is intentionally out of scope.
5. Evidence: the reproduction, prior art, or sources the findings rest on.
6. Open questions, if any remain.

This is the `kind` / `findings` / `proposed_change` / `out_of_scope` / `evidence` /
`open_questions` (+ `options`, `recommendation`) artifact defined in [artifacts.md](artifacts.md) —
Plan reads it in that shape regardless of which entry point produced it.
<!-- /harness:enforced -->

<!-- harness:enforced -->
## Stop gate

Report the analysis and wait for the human before doing anything else. This applies every time
this phase is entered — including a return trip from Verify (see [verify.md](verify.md)) — not
only the first time. At the gate the human can approve the proposed change, pick one of the
options, edit the analysis, send feedback for another round, or end the run there: for any kind,
the analysis itself can be the deliverable and no implementation is needed. Skip the gate only when
the user already gave the go in the request itself ("do it", "fix it and commit", "implement with
Sonnet") and the analysis has a change to plan from. A go given for analysis is not a go for
implementation, and a go given for the first pass does not carry forward to a re-diagnosis after a
Verify failure.
<!-- /harness:enforced -->
