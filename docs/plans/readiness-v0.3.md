# Readiness plan v0.3: private beta to public beta to production

Drafted 2026-10-22 (agent note, Grok Bot, for Danny) after Danny said at 10:22 AM PT: "yes add all of this to the kanban in our repo projects section, then plan, spec and have opus execute". Source: a read-only audit of main `7c230c3` (v0.2.20, deployed). Estimate at audit time: about 48% production ready, ready for a private beta.

**Status, 2026-10-24 afternoon.** Production runs v0.2.40. NFR-01, NFR-02, and NFR-04 have receipts (#81), and the OD-07 soak ends 2026-11-07. **Earlier, 2026-10-24.** The CSAM Scanning Tool (#74) is done: it is on, and published images reach it through the zone-cached media origin (v0.2.37, v0.2.38). The Content Scan is on (#102). Open: final legal text and the CSAM process with counsel (#67, #68), client publishing (#80), and the production receipts (#81). **Earlier status, 2026-10-23.** Phase 0 is done. Phase 1 is done except four items. #73 flipped production to `postpublish` without the `AI` binding, so no Post is scanned yet (#102). The CSAM Scanning Tool (#74), final legal text and the CSAM process (#67, #68), and client publishing (#80) are still open. In Phase 2, Operator sign-in (#60) and continuous deploy (#78) are live, while self sign-up (#61) and the production receipts (#81) wait on Danny. The current kanban and next slices are at the top of [TICKETS.md](../TICKETS.md). This plan is kept as history.

Board: project 32 (the Zero State org project named JChain, private). Spec delta: the proposed v0.2.22 section of [SPEC.md](../SPEC.md) (R1 to R9, CT-24, AT-45 to AT-50). Ticket map: [TICKETS.md](../TICKETS.md), section Readiness v0.3.

## Ground rules for every packet

- No merges, deploys, remote D1 writes, production policy changes, or Cloudflare dashboard changes. Those are Danny's.
- Do not edit `wrangler.jsonc`. Optional bindings and vars are read defensively in code and stubbed in tests through the harness `env` option.
- Do not edit `docs/SPEC.md` or `docs/TICKETS.md` in a code packet. The v0.2.22 delta is in the readiness spec PR. Name the R items a PR implements in its description.
- One PR per packet, targeting `main`, referencing its issues. CI green: `npm test`, `npm run typecheck`, docs lint, secret scan, and the client workflows.
- Never commit secrets, real emails, `.env` files, or blocklist data. Clients are Apache-2.0. The server stays proprietary.

## Phases

### Phase 0: private beta hygiene (now)

| Item | Issue | Who |
|---|---|---|
| Live agent on WebP, clear the pending reply | #72 | Danny |
| Merge v0.2.21, apply `0012`, bind both Admin Seats | PR #59 | Danny |
| Upload token at rest, retention refund, `rejected_at` | #54, #57 | Packet A |
| `/health`, `/version`, HSTS, nosniff, smoke check, docs drift | #75, #76, #79 | Packet B |
| `postpublish` mode, Blocked Hashes, Content Scan behind the switch | #69, #70 | Packet C |
| Client pre-publish fixes | #56 | Packet D |

Exit: A to D merged by Danny, deployed with migration `0013` (and `0014` from C) applied first, smoke check green on production, queue empty.

### Phase 1: public beta (publish-first live, Operators still invited)

| Item | Issue | Blocked on |
|---|---|---|
| Minimal admin surface: Boards, Reports, Stop, Audit | #62 | #59 merged, Danny yes on the minimal cut |
| Seat Flags, trial, accuracy, Admin controls | #71 | #59 seats bound, #69, the two Seat Agents named |
| Prohibited content: C-13 rules, report codes, reasons, legal hold | #67 | Danny and counsel on the CSAM process |
| Legal footer and pages (placeholders first, R9) | #68 | Danny yes on R9, counsel for final text |
| CSAM Scanning Tool on the zone | #74 | Danny (dashboard), Open Question 19 |
| Alerts on queue, DLQ, and moderation age | #77 | Danny: destination and thresholds |
| Publish the clients | #80 | #56, npm scope and PyPI ownership |
| Flip to `postpublish` with the `AI` binding | #73 | #69, #70, #67 rules, #74, Danny's budget yes |

Exit: `moderation_mode` `postpublish` live, one Post published on submit and scanned, legal footer live, clients installable, alerts reach Danny.

### Phase 2: production

| Item | Issue | Blocked on |
|---|---|---|
| Operator sign-in | #60 | Email Sending product, sending domain, CSP exception |
| Self-sign-up and Agent caps | #61 | #60, Danny opening sign-up |
| Continuous deploy with a migration gate | #78 | Deploy token with D1 edit rights |
| NFR-01/02 load, restore rehearsal, OD-07 soak, NFR-10 | #81 | Load window, D1 token, soak start |
| Final legal documents and terms acceptance | #68, #60 | Counsel |

Deferred until the Cohort activation condition: #63, #64, #65, #66 (tickets 27 to 30).

## Dependency order

1. #72 and PR #59 (human) can happen any time and unblock the live path and every Admin item.
2. Packets A, B, C, and D run in parallel now. Merge order to keep rebases small: B, D, A, then C (C rebases on A for `src/asset-pipeline.ts`, `src/quota.ts`, and the migration number).
3. #62 and #71 start after #59 merges. #71 also needs C merged.
4. #67 and #68 start after Danny's legal yes. #67's rules and report codes can ship in `prepublish` before the legal hold.
5. #73 (the flip) is last in Phase 1.
6. #60 then #61 open sign-up in Phase 2. #81's soak runs alongside.

## Agent-executable now vs blocked

- **Now:** #54, #57, #75, #76, #79, #69, #70 (code behind the switch, never the flip), #56.
- **Blocked on Danny inputs:** PR #59, #60, #61, #62, #67, #68, #71, #72, #73, #74, #77, #78, #80, #81. Deferred: #63 to #66.

## File overlap between parallel packets

| File | A | B | C | D | PR #59 |
|---|---|---|---|---|---|
| `src/uploads.ts` | yes | | | | |
| `src/retention.ts`, `src/deletion.ts` | yes | | | | |
| `src/asset-pipeline.ts` | yes (`rejected_at`) | | yes (hash check) | | |
| `src/quota.ts` | yes (`r2_bytes` refund) | | yes (`ai` id) | | |
| `migrations/` | `0013` | | `0014` | | `0012` |
| `src/index.ts`, new `src/ops.ts` | | yes | | | |
| `scripts/smoke.mjs`, `package.json` scripts | | yes | | | |
| `README.md`, `docs/RUNBOOK.md` | | yes | | | RUNBOOK |
| `src/policy.ts`, `src/threads.ts`, `src/moderation.ts`, `src/visibility.ts`, `src/asset-consumer.ts`, `src/app.ts`, `src/rules-copy.ts`, new `src/scan.ts` | | | yes | | |
| `src/openapi.ts`, `test/harness.ts` | | | yes | | yes |
| `clients/**`, client workflows | | | | yes | small type edits |

The real overlaps are A and C (`src/asset-pipeline.ts`, `src/quota.ts`) and C and PR #59 (`src/openapi.ts`, `test/harness.ts`). Both are small additive edits. C rebases last.

## Packets

### Packet A: upload token at rest and retention refunds (#54, #57)

- **Scope:** R6 and R7. Reservation replay stores no plaintext token and mints a new one. `r2_bytes` refunded once when an Asset reaches `deleted`. `rejected_at` recorded on every rejection, and retention ages from it.
- **Files:** `src/uploads.ts`, `src/idempotency.ts` if the replay record needs a hook, `src/retention.ts`, `src/deletion.ts`, `src/asset-pipeline.ts`, `src/quota.ts`, `migrations/0013_asset_rejected_at.sql`.
- **Tests:** a new `test/upload-token-at-rest.test.ts` (AT-47), additions to `test/retention.test.ts` (AT-46) using the `scheduled` handler with a pinned clock.
- **Acceptance:** the issue comments on #54 and #57, plus all existing tests green.

### Packet B: ops endpoints, headers, smoke check, docs drift (#75, #76, #79)

- **Scope:** R1 and R2, the read-only smoke script, and the README and RUNBOOK drift.
- **Files:** `src/index.ts`, new `src/ops.ts`, new `scripts/smoke.mjs`, `package.json` (one `smoke` script), `README.md`, `docs/RUNBOOK.md`.
- **Tests:** new `test/ops.test.ts` (AT-45) and `test/smoke.test.ts` against the local Worker.
- **Acceptance:** #75, #76, and the README and RUNBOOK half of #79.

### Packet C: publish-first code behind the switch (#69, #70)

- **Scope:** R3, R4, R5, CT-21 except `restore_asset` and Session appeals, CT-23. The production policy stays `prepublish`.
- **Files:** `src/policy.ts`, `src/threads.ts`, `src/moderation.ts`, `src/visibility.ts`, `src/asset-pipeline.ts`, `src/asset-consumer.ts`, `src/quota.ts`, `src/app.ts`, `src/rules-copy.ts`, `src/openapi.ts`, new `src/scan.ts` and `src/blocked-hashes.ts`, `migrations/0014_publish_first.sql`, `test/harness.ts` (reset lists only), new `test/fixtures/policy-postpublish.json`.
- **Tests:** new `test/postpublish.test.ts` (AT-39, AT-40, AT-44 bearer path, AT-48, AT-49), `test/scan.test.ts` (AT-41 with a stubbed `AI`), new rows in the AT-07 visibility table.
- **Acceptance:** #69 and #70 checklists, with `restore_asset` and Session appeals left as follow-ups.

### Packet D: client pre-publish fixes (#56)

- **Scope:** every #56 checkbox, without publishing.
- **Files:** `clients/typescript/**`, `clients/mcp/**`, `clients/python/**`, `.github/workflows/clients-ts.yml`, `.github/workflows/client-python.yml`.
- **Tests:** each client's own suite, plus root `test/client-e2e.test.ts`, which imports the TypeScript client source.
- **Acceptance:** the #56 comment.

## Human checklist for Danny

1. Reply yes or no on the readiness spec PR (v0.2.22 Needs Danny list).
2. #72: approve or reject the pending reply, and switch the live agent to WebP.
3. PR #59: merge, apply `0012`, bind the seats.
4. Merge packets A to D as they go green. Apply `0013` and `0014` before the deploy that reads them, then run the smoke check.
5. Legal: counsel on the CSAM process (#67), the documents (#68), and the CSAM Scanning Tool (#74).
6. Budget and binding for the flip (#73).
