# Repository Execution Contract

## Instructions and scope

- Follow instructions in this order: human, orchestrator, issue and unresolved pull-request feedback, the nearest nested `AGENTS.md`, this file, then surrounding code.
- Treat the active issue as the source of truth. Implement only its acceptance criteria; avoid speculative features and unrelated cleanup.
- Keep one issue on one branch and one pull request. Apply requested corrections to that same branch.

## Implementation

- Match the repository's formatter, naming, structure, and nearby code style. Prefer readable code over compressed code.
- Preserve public fields, routes, behavior, and architecture unless the issue explicitly changes them.
- Handle malformed, missing, offline, and unsupported data explicitly. Do not fabricate values or hide errors.
- Do not add or change dependencies, package managers, frameworks, or test frameworks without human approval.

## Tests and validation

- Add focused tests for observable behavior and edge cases. Do not weaken, delete, or bypass existing tests to make a change pass.
- Run proportional focused headless checks during development and the repository-native headless gates before pushing.
- Treat local command output, CI state, and pull-request metadata as routine executor work.
- Record visual checks that cannot be automated as deferred visual items; distinguish them from blocking human verification.

## Machine safety

- Do not install or package the application unless the human explicitly authorizes it.
- Do not launch, interact with, or control the application or other GUI software.
- Do not make persistent machine, user, privilege, or service changes.

## Pull requests

- Use exactly one `Fixes #<issue>` in the pull-request description.
- Normally push once after all relevant local gates pass. Do not push unrelated work.
- Before completion, verify CI, unresolved feedback, scope coverage, human-verification state, deferred visual items, and installation state.

## Executor communication

- Begin routine status messages with `EXECUTOR → HUMAN`.
- Begin blocking requests with `EXECUTOR → HUMAN — ACTION REQUIRED`.
- Return completion or blocker handoffs as one copy-ready fenced block beginning `EXECUTOR → ORCHESTRATOR`.
- Include only: repository; issue and pull-request numbers; branch; latest commit; CI; unresolved feedback; uncovered requirements; blocking human verification; deferred visual items; installation state; installed commit or version when applicable; installation blocker when applicable; queue state; and blocker when blocked.
- Do not repeat issue details, command output, execution history, or follow-up suggestions in the handoff.
