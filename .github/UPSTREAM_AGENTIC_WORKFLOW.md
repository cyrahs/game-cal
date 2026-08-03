# Upstream Agentic Review v2

`upstream-review-v2.yml` replaces the archived v1 workflow with one bounded remediation
loop. The workflow discovers and confirms upstream findings, creates an Issue, lets a
repair agent produce a low-risk parser patch, validates it, updates one draft PR,
performs an independent exact-head review and runtime replay, and then enables native
squash auto-merge.

## Attempt loop

The maximum is selected when manually dispatching the workflow. The default is four
candidate generations: one initial candidate plus three revisions. Every attempt uses
the same reusable `upstream-agentic-attempt.yml` implementation.

The following outcomes share one structured `feedback.json` protocol and consume one
code attempt:

- safeguard, parser, typecheck, or build failure;
- independent review requesting changes;
- original finding remaining unresolved in the exact-head runtime replay.

Installation, runner, GitHub, or model transport failures fail the attempt as
infrastructure errors and never become code feedback. A blocked or incomplete cycle
ends with a failing terminal guard; it cannot appear green.

## Required repository policy

The default branch protection must have all of the following:

- required status `upstream-agentic/validate`;
- conversation resolution required;
- administrators included;
- force pushes and branch deletion disabled.

Repository settings must enable squash merge and pull-request auto-merge. The workflow
does not use administrator bypass. Branch protection intentionally does not require a
review so a single maintainer can merge their own ordinary PRs after the required status
passes. Agentic remediation PRs still cannot reach auto-merge until the workflow submits
and verifies an exact-head review from the independent reviewer token.

`upstream-agentic-pr-gate.yml` produces the same required
`upstream-agentic/validate` context for every pull request into `main`. Agentic repair
PRs also receive an exact-head commit status with that context from the bounded attempt
validator. This prevents the required status from blocking ordinary human PRs that do
not originate from the remediation workflow.

## Required secrets

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `OPENAI_REASONING_EFFORT`
- `UPSTREAM_REVIEW_APPROVAL_TOKEN`

`UPSTREAM_REVIEW_APPROVAL_TOKEN` must belong to an identity different from
`github-actions[bot]`, whose repository role is `write`, `maintain`, or `admin`, and be
able to submit the exact-head approval verified by the workflow. For a fine-grained token,
the minimal repository permissions are Administration (read), Commit statuses (read),
Contents (read), Metadata (read), and Pull requests (write). It is only exposed to the
review-submission and policy-verification steps. Repair, validation, code-review model,
and runtime-review model jobs never receive it.

The recommended production replacement is a short-lived installation token from a
dedicated Reviewer GitHub App. The built-in `GITHUB_TOKEN` remains the Writer/Merger
identity and cannot submit the independent approval.

## Security boundary

The repair agent has workspace write access but GitHub read-only permissions and no
GitHub token in its environment. Its cumulative patch is restricted to mapped game
parsers and the agent-owned regression test, limited to 512 KiB, and cannot create,
delete, rename, change type, or change mode of files.

The validator reconstructs the cumulative patch from the immutable base and executes:

1. `pnpm test:upstream-review`
2. `pnpm test:game-parsers`
3. `pnpm typecheck`
4. `pnpm build`

Every gate records an explicit `executed` flag. A missing or skipped gate is classified
as failure. Only a validated candidate is committed and pushed.

Review and runtime evidence bind the cycle, attempt, base SHA, exact head SHA, result
tree, finding fingerprint, and a canonical SHA-256 context digest. GitHub approval is
submitted with the exact `commit_id`. Finalization rechecks the exact head, approval,
required status, immutable base, merged state, and merge commit before closing the
Issue.

## Archived implementation

The former workflows are preserved as non-executable historical snapshots:

- `.github/workflow-archive/upstream-review.v1.yml.disabled`
- `.github/workflow-archive/upstream-review-pr-rework.v1.yml.disabled`

They remain covered by legacy safeguard tests but are outside `.github/workflows`, so
GitHub does not register or execute them.
