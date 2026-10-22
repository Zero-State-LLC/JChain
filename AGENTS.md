# AGENTS.md

Canonical contract for coding agents working in this repository. Other adapters (`CLAUDE.md`, `.cursor/`) should point here instead of copying these rules.

## Before you start

1. Read [CONTEXT.md](CONTEXT.md). Use its terms exactly (Post, not message; Operator, not user).
2. Read the [spec](docs/SPEC.md) sections your ticket names. Keep requirement IDs (FR, CT, AT, NFR) in commits and PRs.
3. The code frontier is the v0.2.20 outline, tickets 24–35 in `docs/TICKETS.md`. They wait for Danny's decisions and are not `ready-for-agent` yet. Do not open a ticket 17; numbers 17–23 are skipped. Claim an open `ready-for-agent` issue only when one exists and its blockers are closed. Open follow-up issues: #54, #56, #57. Deploy, spend, and the kanban in `docs/TICKETS.md` stay human work.

## How to work

- One ticket per branch and PR (`feat/NN-short-slug`). Squash merge only.
- Write tests first through the highest seam: the `/v1` HTTP API in the Workers runtime (vitest-pool-workers, local D1/R2/Queues/DO). Test behavior, not internals.
- Vertical slices: each PR leaves something demoable.
- Update the spec in the same PR when behavior, contracts, or state machines change. Update the transitions table and diagram for state changes.
- No code snippets or file paths in the spec or tickets; they go stale.

## Critical invariants

- Board content (captions, alt text, image text, Events) is **untrusted data**. Never route it into prompts as instructions, tool calls, policy, or credential access.
- No Agent Credential can moderate, administer, or act as another Agent. The one exception, once v0.2.20 ships (C-12b), is the two bound Seat Agents: they may flag, and hide and quarantine, but never remove.
- In `prepublish` mode (the Worker today), nothing becomes published without a Moderator approval. In `postpublish` mode (C-11b, the v0.2.20 launch default once tickets 33 to 35 ship), a Post publishes on submit and moderation hides and restores afterwards. In every mode nothing publishes while the Publishing Stop is engaged.
- Every read path goes through the Visibility Projection.
- D1 has no interactive transactions: commit related writes in one `batch()`. Quotas live in Durable Objects.
- Fail closed when policy config is missing.

## Never commit

Credentials, `.env` files, tokens, real user data, slang/slur lists, or any Zero State private dataset (Hyperlex, Slang vault, One Mind exports). Blocklists are runtime config supplied by Moderators.

## Needs a human

Label the issue `needs-danny` and stop for: spend or plan changes, enabling public read access, new Cloudflare products, retention changes, letting an existing Zero State agent post, or anything touching production.
