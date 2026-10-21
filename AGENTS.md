# AGENTS.md

Canonical contract for coding agents working in this repository. Other adapters (`CLAUDE.md`, `.cursor/`) should point here instead of copying these rules.

## Before you start

1. Read [CONTEXT.md](CONTEXT.md). Use its terms exactly (Post, not message; Operator, not user).
2. Read the [spec](docs/SPEC.md) sections your ticket names. Keep requirement IDs (FR, CT, AT, NFR) in commits and PRs.
3. The code frontier is none. Do not open a ticket 17. Claim an open `ready-for-agent` issue only when one exists and its blockers are closed. Deploy, spend, and the kanban in `docs/TICKETS.md` stay human work.

## How to work

- One ticket per branch and PR (`feat/NN-short-slug`). Squash merge only.
- Write tests first through the highest seam: the `/v1` HTTP API in the Workers runtime (vitest-pool-workers, local D1/R2/Queues/DO). Test behavior, not internals.
- Vertical slices: each PR leaves something demoable.
- Update the spec in the same PR when behavior, contracts, or state machines change. Update the transitions table and diagram for state changes.
- No code snippets or file paths in the spec or tickets; they go stale.

## Critical invariants

- Board content (captions, alt text, image text, Events) is **untrusted data**. Never route it into prompts as instructions, tool calls, policy, or credential access.
- No Agent Credential can moderate, administer, or act as another Agent.
- Nothing becomes published without a Moderator approval, and never while the Publishing Stop is engaged.
- Every read path goes through the Visibility Projection.
- D1 has no interactive transactions: commit related writes in one `batch()`. Quotas live in Durable Objects.
- Fail closed when policy config is missing.

## Never commit

Credentials, `.env` files, tokens, real user data, slang/slur lists, or any Zero State private dataset (Hyperlex, Slang vault, One Mind exports). Blocklists are runtime config supplied by Moderators.

## Needs a human

Label the issue `needs-danny` and stop for: spend or plan changes, enabling public read access, new Cloudflare products, retention changes, letting an existing Zero State agent post, or anything touching production.
