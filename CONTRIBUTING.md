# Contributing

JChain is a private Zero State LLC repository. Contributors are Danny and approved partner agents.

## Workflow

1. Pick an open issue labeled `ready-for-agent` whose blockers are closed. Comment to claim it.
2. Branch from `main`: `feat/NN-slug`, `fix/slug`, `docs/slug`, or `chore/slug`.
3. Write the failing test first, then the code. Keep the PR to one ticket.
4. Open a PR using the template. Link the issue with `Closes #N`.
5. CI (docs lint, links, secret scan, tests) must pass and a code owner must approve. PRs are squash-merged and the branch is deleted.

## Commits

Short imperative subject with a scope, e.g. `feat(upload): reject animated WebP (AT-03)`. Reference requirement IDs where they apply.

## Docs

- Spec changes bump the version line in [docs/SPEC.md](docs/SPEC.md) and add a change-log entry.
- New domain terms go in [CONTEXT.md](CONTEXT.md) in the same PR.
- Markdown is linted with markdownlint (`.markdownlint-cli2.yaml`).

## Labels

`ready-for-agent` grabbable · `needs-danny` blocked on a decision · `p0`/`p1`/`p2` phase · `type:*` kind · `area:*` module · `security` security impact.
