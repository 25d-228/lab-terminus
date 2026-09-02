# Repository Execution Contract

## Instructions and scope

- Apply instructions in this exact order: the current `HUMAN → EXECUTOR` message; the current `ORCHESTRATOR → EXECUTOR` handoff; the active issue and unresolved pull-request feedback; the nearest applicable nested `AGENTS.md`; this root contract; then surrounding code.
- A current `HUMAN → EXECUTOR` or `ORCHESTRATOR → EXECUTOR` message may explicitly authorize an application build, package, or installation for its named task. That authorization does not carry to another task, issue, or branch.
- Treat the active issue as the source of truth. Implement only its acceptance criteria and requested review corrections.
- Keep one issue on one branch and one pull request. Apply review corrections to that same branch and pull request.

## Implementation

- Practice YAGNI. Do not add speculative options, abstractions, wrappers, hooks, configuration, infrastructure, documentation, cleanup, or compatibility layers.
- Match the repository formatter and nearby maintained naming, structure, and style. Preserve public fields, routes, behavior, and architecture unless the issue explicitly changes them.
- Keep source, markup, configuration, and CSS readable. Use clear multi-line formatting; do not compress code merely to reduce the diff.
- Give functions and variables names that describe their role. Keep functions focused, use direct control flow, and extract a helper only when it improves reuse or clarity.
- Write comments only for non-obvious constraints, intent, or invariants. Do not narrate the code, and update or remove stale comments.

## Errors and dependencies

- Handle malformed, missing, offline, unsupported, and partial data explicitly. Preserve useful diagnostics; do not fabricate values, hide failures, or add silent failure paths.
- Do not add or change dependencies, package managers, frameworks, or test frameworks without explicit authorization from the current human or orchestrator instructions.

## Tests and validation

- Add focused deterministic tests for changed observable behavior, boundary cases, failure paths, and touched contracts. Do not test private implementation details when public behavior is available.
- Do not weaken, delete, skip, or bypass existing tests to make a change pass.
- Run proportional focused headless checks during development and the relevant repository-native gates before pushing. For a review correction, rerun only gates affected by that correction and let CI run the authoritative full suite.
- Treat routine local output, CI state, and pull-request metadata as executor work rather than human verification.

## Machine safety and human verification

- Executors must use the existing checkout when it is safe to do so.
- If an alternate clone or Git worktree is required, create it only under the operating system temporary directory or a tool-managed temporary directory.
- Do not create an alternate workspace beside the repository or under the repository's parent directory, including with a name such as `lab-terminus-issue-<number>`.
- A temporary workspace must not contain the only copy of uncommitted work and should be removed when it is no longer needed.
- Do not run an application build, package, or installation command unless a current controlling message explicitly authorizes it for the named task. Compilation performed by repository-native test or check commands remains validation, not installation authorization.
- Do not launch, interact with, or control the application or other GUI software. Do not make persistent machine, user, privilege, or service changes.
- Classify human verification as blocking only when required acceptance evidence cannot be obtained through authorized headless checks and requires human action. Record low-risk visual checks separately as deferred visual-verification items.
- Always report installation state in the final handoff. If installation occurred, report the installed commit or version; if authorized installation is blocked, report the blocker; if it was not authorized, report `Not authorized`.

## Pull requests

- Use exactly one `Fixes #<issue>` in the pull-request description.
- Normally push once after relevant local gates pass. Do not push unrelated work.
- Before completion, verify CI, unresolved feedback, scope coverage, human-verification state, deferred visual items, and installation state.

## Executor communication

- Begin routine status messages with `EXECUTOR → HUMAN`.
- Begin blocking requests with `EXECUTOR → HUMAN — ACTION REQUIRED`.
- Return completion or blocker handoffs as one copy-ready fenced block beginning `EXECUTOR → ORCHESTRATOR`.
- Include only: repository; issue and pull-request numbers; branch; latest commit; CI; unresolved feedback; uncovered requirements; blocking human verification; deferred visual items; installation state; installed commit or version when applicable; installation blocker when applicable; queue state; and blocker when blocked.
- Do not repeat issue details, command output, execution history, or follow-up suggestions in the handoff.
