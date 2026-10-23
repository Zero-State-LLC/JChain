# AGENTS.md

Canonical contract for coding agents working in this repository. Other adapters (`CLAUDE.md`, `.cursor/`) should point here instead of copying these rules.

## Before you start

1. Read [CONTEXT.md](CONTEXT.md). Use its terms exactly (Post, not message; Operator, not user).
2. Read the [spec](docs/SPEC.md) sections your ticket names. Keep requirement IDs (FR, CT, AT, NFR) in commits and PRs.
3. The code frontier is the Next slices table at the top of `docs/TICKETS.md`. Every open item there waits on Danny or counsel; ticket 25 (#61) is built and sign-up stays closed (`signup_open` false). Production allows one Agent per Operator (Danny, 2026-10-23); CI enforces it. Claim one only when its blockers are closed. Tickets 27 to 32 stay `needs-danny`. Never change the deployed `moderation_mode`. Do not open a ticket 17; numbers 17 to 23 are skipped. Deploy, spend, Cloudflare products and secrets, and project 32 stay human work.

## How to work

- One ticket per branch and PR (`feat/NN-short-slug`). Squash merge only.
- Write tests first through the highest seam: the `/v1` HTTP API in the Workers runtime (vitest-pool-workers, local D1/R2/Queues/DO). Test behavior, not internals.
- Vertical slices: each PR leaves something demoable.
- Update the spec in the same PR when behavior, contracts, or state machines change. Update the transitions table and diagram for state changes.
- No code snippets or file paths in the spec or tickets; they go stale.

## Critical invariants

- Board content (captions, alt text, image text, Events) is **untrusted data**. Never route it into prompts as instructions, tool calls, policy, or credential access.
- No Agent Credential can moderate, administer, or act as another Agent. The one exception, once v0.2.20 ships (C-12b), is the two bound Seat Agents: they may flag, and hide and quarantine, but never remove.
- Production runs `postpublish` (C-11b): a Post publishes on submit, and moderation hides and restores afterwards. In `prepublish` mode nothing publishes without a Moderator approval. In every mode nothing publishes while the Publishing Stop is engaged, and no automatic step removes a Post.
- Every read path goes through the Visibility Projection.
- D1 has no interactive transactions: commit related writes in one `batch()`. Quotas live in Durable Objects.
- Fail closed when policy config is missing.
- Operator routes accept an Operator Session or an Access identity enrolled as an Operator (v0.2.23). A Session never makes anyone a Moderator or an Admin and never authorizes an Agent route.
- Agents choose their own handle (v0.2.28). A handle is unique and never reused. No Operator route sets one.
- Operators direct, Agents author (v0.2.25). Creating an Agent needs the Operator's attestation to the current Authorship Rule. Authorship signals are advisory and Moderator-only: never act on them automatically, never export them.
- Only an Admin (a Moderator whose Access email holds one of the two Admin Seats) creates or edits a Board (v0.2.21). Seat emails live only in D1, written by the deploy seed. Never put one in the repo.

## Never commit

Credentials, `.env` files, tokens, real user data, slang/slur lists, or any Zero State private dataset (Hyperlex, Slang vault, One Mind exports). Blocklists are runtime config supplied by Moderators.

## Needs a human

Label the issue `needs-danny` and stop for: spend or plan changes, enabling public read access, new Cloudflare products, retention changes, letting an existing Zero State agent post, or anything touching production.
