import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_WEBP } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, releaseThread, resetAndSeed } from "./harness";

const MISSING_ID = "01900000-0000-7000-8000-000000000099";
const HIDDEN_STATES = [
  "pending_review",
  "rejected",
  "hidden",
  "flagged",
  "quarantined",
  "removal_pending",
  "removed",
] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("visibility", () => {
  it("hides every non-published state on the feed, thread, profile, browse, and asset bytes", async () => {
    const author = await enroll();
    const other = await enroll("Bea");
    const assetId = await readyAsset(author.credential);
    await expectError(
      await call(`/v1/assets/${assetId}/content?variant=display`, { email: MODERATOR }),
      404,
      "not_found",
    );
    expect((await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: author.credential })).status).toBe(200);
    await expectError(await call(`/v1/assets/${assetId}/content?variant=display`), 404, "not_found");

    const caption = "viz-token-05 caption";
    const opened = await expectSuccess(await openThread(author.credential, threadBody(assetId, {
      title: "viz-token-05 title",
      caption,
    })), 201);
    const threadId = String(opened.thread_id);
    const postId = String(opened.post_id);

    for (const state of HIDDEN_STATES) {
      if (state !== "pending_review") {
        await env.DB.prepare("UPDATE posts SET state = ? WHERE id = ?").bind(state, postId).run();
      }
      await expectAbsent(caption, threadId, postId, author.agentId, author.credential);
      const owner = await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: author.credential });
      const moderator = await call(`/v1/assets/${assetId}/content?variant=display`, { email: MODERATOR });
      const anonymous = await call(`/v1/assets/${assetId}/content?variant=display`);
      const stranger = await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: other.credential });
      if (state === "pending_review") {
        expect(owner.status).toBe(200);
        expect(moderator.status).toBe(200);
        await expectError(anonymous, 404, "not_found");
        await expectError(stranger, 404, "not_found");
        await expectError(
          await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: "not-a-token" }),
          401,
          "credential_invalid",
        );
      } else {
        await expectError(owner, 404, "not_found");
        await expectError(moderator, 404, "not_found");
        await expectError(anonymous, 404, "not_found");
        await expectError(stranger, 404, "not_found");
      }
    }

    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE id = ?").bind(postId).run();
    expect((await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: "not-a-token" })).status).toBe(200);
    const imageReply = await expectSuccess(await reply(author.credential, threadId, {
      asset_id: assetId,
      alt_text: "same asset reply",
      provenance: { source: "human" },
      rights_attestation: "I made this.",
      license: "cc0",
    }), 201);
    await env.DB.prepare("UPDATE posts SET state = 'hidden' WHERE id = ?").bind(imageReply.post_id).run();
    expect((await call(`/v1/assets/${assetId}/content?variant=display`)).status).toBe(200);
    await env.DB.prepare("UPDATE posts SET state = 'hidden' WHERE id = ?").bind(postId).run();
    await expectError(
      await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: author.credential }),
      404,
      "not_found",
    );
    await expectError(await call(`/v1/assets/${assetId}/content?variant=display`), 404, "not_found");
  });

  it("conceals a published Reply on every read path while its Opening Post is not published", async () => {
    const author = await enroll();
    const replier = await enroll("Bea");
    const remixer = await enroll("Cy");
    const openingAsset = await readyAsset(author.credential);
    const replyAsset = await readyAsset(replier.credential);
    const tipAsset = await readyAsset(remixer.credential);
    const opened = await expectSuccess(await openThread(author.credential, threadBody(openingAsset, {
      title: "viz-opening-05 title",
      caption: "viz-opening-05 caption",
    })), 201);
    const threadId = String(opened.thread_id);
    const openingId = String(opened.post_id);
    await act(openingId, "approve");

    const token = "viz-reply-05 leak token";
    const replied = await expectSuccess(await reply(replier.credential, threadId, {
      text: token,
      asset_id: replyAsset,
      alt_text: "reply square",
      provenance: { source: "human" },
      rights_attestation: "I made this.",
      license: "cc0",
    }), 201);
    const replyId = String(replied.post_id);
    await act(replyId, "approve");

    const tip = await expectSuccess(await openThread(remixer.credential, threadBody(tipAsset, {
      title: "viz-tip-05 title",
      caption: "viz-tip-05 caption",
      remix_of_post_id: replyId,
    })), 201);
    const tipThread = String(tip.thread_id);
    await act(String(tip.post_id), "approve");

    // While the Opening Post is published, the Reply shows everywhere.
    const tipPosts = await expectSuccess(await call(`/v1/threads/${tipThread}/posts`, { bearer: author.credential }));
    expect((tipPosts.items as Array<Record<string, unknown>>)[0]?.remix_of_post_id).toBe(replyId);
    expect(await (await call(`/threads/${tipThread}`)).text()).toContain(token);
    expect(JSON.stringify(await expectSuccess(await call(`/v1/agents/${replier.agentId}/posts`, {
      bearer: author.credential,
    })))).toContain(token);
    expect((await call(`/v1/assets/${replyAsset}/content?variant=display`)).status).toBe(200);
    const exported = await expectSuccess(await call("/v1/exports", {
      email: MODERATOR,
      body: { board_id: BOARD_ID, purpose: "archive" },
    }), 201);
    const exportId = String(exported.export_id);
    expect(JSON.stringify(await expectSuccess(await call(`/v1/exports/${exportId}`, { email: MODERATOR })))).toContain(token);
    const visibleEvents = await expectSuccess(await call("/v1/events", { bearer: author.credential }));
    expect(JSON.stringify(visibleEvents.items)).toContain(replyId);
    // One counted vote puts the Thread on Trending (the voter must be at least a day old).
    await env.DB.prepare("UPDATE agents SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").bind(remixer.agentId).run();
    await env.DB.prepare(
      "INSERT INTO votes (post_id, agent_id, value, cast_at) VALUES (?, ?, 1, '2026-01-02T00:00:00Z')",
    ).bind(openingId, remixer.agentId).run();
    expect(JSON.stringify(await expectSuccess(await call("/v1/trending", { bearer: author.credential })))).toContain(threadId);

    for (const state of HIDDEN_STATES) {
      await env.DB.prepare("UPDATE posts SET state = ? WHERE id = ?").bind(state, openingId).run();
      const agentPosts = await expectSuccess(await call(`/v1/agents/${replier.agentId}/posts`, { bearer: author.credential }));
      expect(JSON.stringify(agentPosts)).not.toContain(token);
      expect(JSON.stringify(agentPosts)).not.toContain(replyId);
      const profile = await call(`/agents/${replier.agentId}`);
      expect(profile.status).toBe(200);
      expect(await profile.text()).not.toContain(token);
      const tipItems = (await expectSuccess(await call(`/v1/threads/${tipThread}/posts`, {
        bearer: author.credential,
      }))).items as Array<Record<string, unknown>>;
      expect(tipItems[0]?.remix_of_post_id).toBeNull();
      expect(tipItems[0]?.ancestry).toEqual([]);
      const tipPage = await call(`/threads/${tipThread}`);
      expect(tipPage.status).toBe(200);
      const tipHtml = await tipPage.text();
      expect(tipHtml).toContain("viz-tip-05 caption");
      expect(tipHtml).not.toContain(token);
      expect(tipHtml).not.toContain(replyId);
      await expectError(await call(`/v1/assets/${replyAsset}/content?variant=display`), 404, "not_found");
      await expectError(
        await call(`/v1/assets/${replyAsset}/content?variant=display`, { bearer: author.credential }),
        404,
        "not_found",
      );
      const events = await expectSuccess(await call("/v1/events", { bearer: author.credential }));
      expect((events.items as Array<{ resource_id: string }>).map((item) => item.resource_id)).not.toContain(replyId);
      const stored = await expectSuccess(await call(`/v1/exports/${exportId}`, { email: MODERATOR }));
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(JSON.stringify(stored)).not.toContain(replyId);
      const fresh = await expectSuccess(await call("/v1/exports", {
        email: MODERATOR,
        body: { board_id: BOARD_ID, purpose: "archive" },
      }), 201);
      const freshBody = await expectSuccess(await call(`/v1/exports/${String(fresh.export_id)}`, { email: MODERATOR }));
      expect(JSON.stringify(freshBody)).not.toContain(token);
      const trending = await expectSuccess(await call("/v1/trending", { bearer: author.credential }));
      expect(JSON.stringify(trending)).not.toContain(threadId);
      expect(await (await call("/trending")).text()).not.toContain("viz-opening-05 title");
      await expectError(await call(`/v1/posts/${replyId}/reactions/plus`, {
        method: "PUT",
        bearer: author.credential,
        headers: { "idempotency-key": crypto.randomUUID() },
      }), 404, "not_found");
      // not_found, never forbidden: the same-Operator vote rule must not reveal a concealed Post.
      await expectError(await call(`/v1/posts/${replyId}/vote`, {
        method: "PUT",
        bearer: author.credential,
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { value: "up" },
      }), 404, "not_found");
      await expectError(await reply(remixer.credential, threadId, { text: "viz-05 blocked reply" }), 404, "not_found");
    }

    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE id = ?").bind(openingId).run();
    expect(JSON.stringify(await expectSuccess(await call(`/v1/exports/${exportId}`, { email: MODERATOR })))).toContain(token);
    expect((await call(`/v1/assets/${replyAsset}/content?variant=display`)).status).toBe(200);

    // A locked Thread with a hidden Opening Post answers not_found, not state_conflict.
    await expectSuccess(await call("/v1/moderation/actions", {
      email: MODERATOR,
      body: { target_type: "thread", target_id: threadId, action: "lock", reason_code: "rules" },
    }));
    await expectError(await reply(remixer.credential, threadId, { text: "viz-05 locked reply" }), 409, "state_conflict");
    await env.DB.prepare("UPDATE posts SET state = 'hidden' WHERE id = ?").bind(openingId).run();
    await expectError(await reply(remixer.credential, threadId, { text: "viz-05 locked hidden reply" }), 404, "not_found");
  });

  it("lets the owner and a moderator preview a pending reuse of a rejected asset", async () => {
    const author = await enroll();
    const other = await enroll("Bea");
    const assetId = await readyAsset(author.credential);
    const rejected = await expectSuccess(await openThread(author.credential, threadBody(assetId, {
      title: "Rejected reuse title",
      caption: "rejected reuse caption",
    })), 201);
    await act(String(rejected.post_id), "reject");
    const again = await expectSuccess(await call("/v1/uploads", {
      bearer: author.credential,
      headers: { "idempotency-key": crypto.randomUUID() },
      body: {
        content_type: "image/webp",
        byte_size: VALID_WEBP.byteLength,
        sha256: await sha256HexBytes(VALID_WEBP),
      },
    }));
    expect(again.deduped).toBe(true);
    expect(again.asset_id).toBe(assetId);

    await releaseThread(author.credential);
    const pending = await expectSuccess(await openThread(author.credential, threadBody(assetId, {
      title: "Pending reuse title",
      caption: "pending reuse caption",
    }), "reuse-thread"), 201);
    expect((await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: author.credential })).status).toBe(200);
    expect((await call(`/v1/assets/${assetId}/content?variant=display`, { email: MODERATOR })).status).toBe(200);
    await expectError(await call(`/v1/assets/${assetId}/content?variant=display`), 404, "not_found");
    await expectError(
      await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: other.credential }),
      404,
      "not_found",
    );
    const queue = await (await call("/moderation", { email: MODERATOR })).text();
    expect(queue).toContain("pending reuse caption");
    expect(queue).toContain(`/v1/assets/${assetId}/content?variant=thumb`);
    expect(await (await call("/boards/beta")).text()).not.toContain("Rejected reuse title");
    expect(await (await call("/boards/beta")).text()).not.toContain("Pending reuse title");

    await act(String(pending.post_id), "approve");
    expect((await call(`/v1/assets/${assetId}/content?variant=display`)).status).toBe(200);
    const feed = await (await call("/boards/beta")).text();
    expect(feed).toContain("Pending reuse title");
    expect(feed).not.toContain("Rejected reuse title");
  });

  it("pages published threads and posts with an opaque cursor", async () => {
    const author = await enroll();
    const assetId = await readyAsset(author.credential);
    const older = await expectSuccess(await openThread(author.credential, threadBody(assetId, {
      title: "Older board title",
      caption: "older caption words",
    })), 201);
    await act(String(older.post_id), "approve");
    await releaseThread(author.credential);
    const newer = await expectSuccess(await openThread(author.credential, threadBody(assetId, {
      title: "Newer board title",
      caption: "newer caption words",
    }), "newer-thread"), 201);
    await act(String(newer.post_id), "approve");
    const replyText = "reply words stay off the board list";
    const created = await expectSuccess(await reply(author.credential, String(newer.thread_id), { text: replyText }), 201);
    await act(String(created.post_id), "approve");

    const first = await expectSuccess(await call(`/v1/boards/${BOARD_ID}/threads?limit=1`, { bearer: author.credential }));
    const firstItems = first.items as Array<Record<string, unknown>>;
    expect(firstItems).toHaveLength(1);
    expect(firstItems[0]?.title).toBe("Newer board title");
    expect(Object.keys(firstItems[0] ?? {}).sort()).toEqual(["created_at", "thread_id", "title"]);
    expect(typeof first.next_cursor).toBe("string");

    const second = await expectSuccess(await call(
      `/v1/boards/${BOARD_ID}/threads?limit=1&cursor=${String(first.next_cursor)}`,
      { bearer: author.credential },
    ));
    const secondItems = second.items as Array<Record<string, unknown>>;
    expect(secondItems[0]?.title).toBe("Older board title");
    expect(second.next_cursor).toBeNull();

    await expectError(
      await call(`/v1/boards/${BOARD_ID}/threads?cursor=not-a-cursor`, { bearer: author.credential }),
      400,
      "malformed",
    );
    await expectError(
      await call(`/v1/boards/${BOARD_ID}/threads?cursor=`, { bearer: author.credential }),
      400,
      "malformed",
    );
    await expectError(
      await call(`/v1/boards/${BOARD_ID}/threads?limit=0`, { bearer: author.credential }),
      400,
      "malformed",
    );
    const capped = await expectSuccess(await call(`/v1/boards/${BOARD_ID}/threads?limit=1000`, { bearer: author.credential }));
    expect(capped.items).toHaveLength(2);
    expect(capped.next_cursor).toBeNull();
    expect(JSON.stringify(capped)).not.toContain(replyText);

    const thread = await expectSuccess(await call(`/v1/threads/${String(newer.thread_id)}`, { bearer: author.credential }));
    expect(thread.thread_id).toBe(newer.thread_id);
    expect(thread.board_id).toBe(BOARD_ID);
    expect(thread.state).toBe("open");
    await expectError(await call(`/v1/threads/${MISSING_ID}`, { bearer: author.credential }), 404, "not_found");
    await expectError(await call("/v1/threads/not-a-thread", { bearer: author.credential }), 404, "not_found");

    const posts = await expectSuccess(await call(`/v1/threads/${String(newer.thread_id)}/posts`, { bearer: author.credential }));
    const postItems = posts.items as Array<Record<string, unknown>>;
    expect(postItems.map((item) => item.caption)).toEqual(["newer caption words", replyText]);
    expect(postItems[1]?.title).toBeNull();
    expect(postItems[1]?.provenance).toBeNull();
    expect(postItems[1]?.asset_id).toBeNull();
    expect(Object.keys(postItems[1] ?? {}).sort()).toEqual([
      "alt_text",
      "ancestry",
      "asset_id",
      "author_agent_id",
      "caption",
      "created_at",
      "license",
      "post_id",
      "provenance",
      "remix_of_post_id",
      "rights_attestation",
      "thread_id",
      "title",
    ]);

    const byAgent = await expectSuccess(await call(`/v1/agents/${author.agentId}/posts?limit=1`, { bearer: author.credential }));
    const agentItems = byAgent.items as Array<Record<string, unknown>>;
    expect(agentItems[0]?.caption).toBe(replyText);
    expect(typeof byAgent.next_cursor).toBe("string");
    const agentRest = await expectSuccess(await call(
      `/v1/agents/${author.agentId}/posts?limit=1&cursor=${String(byAgent.next_cursor)}`,
      { bearer: author.credential },
    ));
    expect((agentRest.items as Array<Record<string, unknown>>)[0]?.title).toBe("Newer board title");

    const feed = await (await call("/boards/beta")).text();
    expect(feed).toContain("Newer board title");
    expect(feed).not.toContain(replyText);
    const page = await (await call(`/threads/${String(newer.thread_id)}`)).text();
    expect(page.indexOf("newer caption words")).toBeLessThan(page.indexOf(replyText));
  });
});

describe("moderation actions", () => {
  it("audits reject, hide, and restore and keeps the original publication event", async () => {
    const author = await enroll();
    const assetId = await readyAsset(author.credential);
    const caption = "audit-caption-05";
    const note = "note-only-for-the-audit-row";
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const opened = await expectSuccess(await openThread(author.credential, threadBody(assetId, {
      title: "Audit title",
      caption,
    })), 201);
    const postId = String(opened.post_id);

    const pendingQueue = await (await call("/moderation", { email: MODERATOR })).text();
    expect(pendingQueue).toContain(`value="reject"`);
    expect(pendingQueue).toContain(`value="approve"`);
    expect(pendingQueue).toContain(caption);
    expect(pendingQueue).not.toContain(note);

    await expectError(await act(postId, "hide"), 409, "state_conflict");
    await expectError(await act(MISSING_ID, "reject"), 404, "not_found");
    await expectError(
      await call("/v1/moderation/actions", { bearer: author.credential, body: actionBody(postId, "reject") }),
      403,
      "forbidden",
    );

    const rejected = await expectSuccess(await act(postId, "reject", { private_note: note }));
    expect(rejected.post_id).toBe(postId);
    expect(rejected.state).toBe("rejected");
    expect(rejected.event_id).toBeUndefined();
    expect(JSON.stringify(rejected)).not.toContain(note);
    expect(logs.join("\n")).not.toContain(note);
    const audit = await env.DB.prepare(
      "SELECT actor_email, action, reason_code, private_note, event_id FROM moderation_actions WHERE target_id = ?",
    ).bind(postId).first<{
      actor_email: string;
      action: string;
      reason_code: string;
      private_note: string | null;
      event_id: string | null;
    }>();
    expect(audit).toEqual({
      actor_email: MODERATOR,
      action: "reject",
      reason_code: "rules",
      private_note: note,
      event_id: null,
    });
    await expectError(await act(postId, "reject"), 409, "state_conflict");
    await expectError(await act(postId, "restore"), 409, "state_conflict");
    expect(await actionCount(postId)).toBe(1);
    const afterReject = await (await call("/moderation", { email: MODERATOR })).text();
    expect(afterReject).not.toContain(note);
    expect(afterReject).toContain("No posts are waiting for review.");
    expect(afterReject).toContain(caption);
    expect(afterReject).toContain(`value="remove"`);
    expect(await (await call("/boards/beta")).text()).not.toContain("Audit title");

    await releaseThread(author.credential);
    const second = await expectSuccess(await openThread(author.credential, threadBody(assetId, {
      title: "Hide title",
      caption: "hide-caption-05",
    }), "hide-thread"), 201);
    const hideId = String(second.post_id);
    const approved = await expectSuccess(await act(hideId, "approve"));
    expect(approved.event_id).toMatch(UUID_V7);
    const publishedQueue = await (await call("/moderation", { email: MODERATOR })).text();
    expect(publishedQueue).toContain(`value="hide"`);
    await expectError(await act(hideId, "reject"), 409, "state_conflict");

    const hidden = await expectSuccess(await act(hideId, "hide"));
    expect(hidden.state).toBe("hidden");
    expect(hidden.event_id).toBeUndefined();
    expect(await (await call("/boards/beta")).text()).not.toContain("Hide title");
    expect((await call(`/threads/${String(second.thread_id)}`)).status).toBe(404);
    const hiddenQueue = await (await call("/moderation", { email: MODERATOR })).text();
    expect(hiddenQueue).toContain(`value="restore"`);
    expect(hiddenQueue).toContain("hide-caption-05");
    expect(await eventCount(hideId)).toBe(2);
    const withdrawn = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE resource_id = ? AND type = 'post.withdrawn'",
    ).bind(hideId).first<{ n: number }>();
    expect(Number(withdrawn?.n ?? 0)).toBe(1);

    const restored = await expectSuccess(await act(hideId, "restore"));
    expect(restored.state).toBe("published");
    expect(restored.event_id).toMatch(UUID_V7);
    expect(restored.event_id).not.toBe(approved.event_id);
    expect(await eventCount(hideId)).toBe(3);
    expect(await (await call("/boards/beta")).text()).toContain("Hide title");
    expect(await (await call(`/threads/${String(second.thread_id)}`)).text()).toContain("hide-caption-05");
    await expectError(await act(hideId, "restore"), 409, "state_conflict");

    await act(hideId, "hide");
    await env.DB.prepare("UPDATE assets SET state = 'uploaded' WHERE id = ?").bind(assetId).run();
    await expectError(await act(hideId, "restore"), 409, "state_conflict");
    const stayed = await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(hideId).first<{ state: string }>();
    expect(stayed?.state).toBe("hidden");

    await env.DB.prepare("UPDATE assets SET state = 'ready' WHERE id = ?").bind(assetId).run();
    await act(hideId, "restore");
    const replyText = "text-only restore words";
    const textReply = await expectSuccess(await reply(author.credential, String(second.thread_id), { text: replyText }), 201);
    const textApproved = await expectSuccess(await act(String(textReply.post_id), "approve"));
    await act(String(textReply.post_id), "hide");
    const textRestored = await expectSuccess(await act(String(textReply.post_id), "restore"));
    expect(textRestored.event_id).toMatch(UUID_V7);
    expect(textRestored.event_id).not.toBe(textApproved.event_id);
    expect(await eventCount(String(textReply.post_id))).toBe(3);
    const feed = await (await call("/boards/beta")).text();
    expect(feed).not.toContain(replyText);
    const page = await (await call(`/threads/${String(second.thread_id)}`)).text();
    expect(page).toContain(replyText);
    expect(page).toContain("<h2>Reply</h2>");
  });
});

describe("agent profile", () => {
  it("shows active and suspended agents and only their published posts", async () => {
    const author = await enroll("Ada & Co");
    const assetId = await readyAsset(author.credential);
    const caption = "<script>profile</script>";
    const opened = await expectSuccess(await openThread(author.credential, threadBody(assetId, {
      title: "Profile title",
      caption,
    })), 201);
    const pending = await call(`/agents/${author.agentId}`);
    expect(pending.status).toBe(200);
    expect(pending.headers.get("content-security-policy")).toContain("script-src 'none'");
    const pendingHtml = await pending.text();
    expect(pendingHtml).toContain("Ada &amp; Co");
    expect(pendingHtml).toContain("fixture-model");
    expect(pendingHtml).not.toContain(caption);
    expect(pendingHtml).not.toContain("<script>");

    const profile = await expectSuccess(await call(`/v1/agents/${author.agentId}`, { bearer: author.credential }));
    expect(profile).toMatchObject({
      agent_id: author.agentId,
      display_name: "Ada & Co",
      declared_model: "fixture-model",
      state: "active",
    });

    await act(String(opened.post_id), "approve");
    const shown = await (await call(`/agents/${author.agentId}`)).text();
    expect(shown).toContain("&lt;script&gt;profile&lt;/script&gt;");
    expect(shown).not.toContain("<script>");
    const listed = await expectSuccess(await call(`/v1/agents/${author.agentId}/posts`, { bearer: author.credential }));
    expect((listed.items as Array<Record<string, unknown>>)[0]?.caption).toBe(caption);

    await env.DB.prepare("UPDATE agents SET state = 'suspended' WHERE id = ?").bind(author.agentId).run();
    const suspended = await expectSuccess(await call(`/v1/agents/${author.agentId}`, { email: MODERATOR }));
    expect(suspended.state).toBe("suspended");
    expect(suspended.display_name).toBe("Ada & Co");
    expect((await call(`/agents/${author.agentId}`)).status).toBe(200);
    const suspendedPosts = await expectSuccess(await call(`/v1/agents/${author.agentId}/posts`, { email: OPERATOR }));
    expect((suspendedPosts.items as Array<Record<string, unknown>>)[0]?.caption).toBe(caption);

    await env.DB.prepare("UPDATE agents SET state = 'retired' WHERE id = ?").bind(author.agentId).run();
    await expectError(await call(`/v1/agents/${author.agentId}`, { email: OPERATOR }), 404, "not_found");
    await expectError(await call(`/v1/agents/${author.agentId}/posts`, { email: OPERATOR }), 404, "not_found");
    const retired = await call(`/agents/${author.agentId}`);
    expect(retired.status).toBe(404);
    expect(await retired.text()).not.toContain("Ada &amp; Co");

    await env.DB.prepare("UPDATE agents SET state = 'invited' WHERE id = ?").bind(author.agentId).run();
    await expectError(await call(`/v1/agents/${author.agentId}`, { email: OPERATOR }), 404, "not_found");
    expect((await call(`/agents/${author.agentId}`)).status).toBe(404);
    await expectError(await call(`/v1/agents/${MISSING_ID}`, { email: OPERATOR }), 404, "not_found");
    expect((await call("/agents/not-an-agent")).status).toBe(404);
  });
});

async function expectAbsent(
  caption: string,
  threadId: string,
  postId: string,
  agentId: string,
  bearer: string,
): Promise<void> {
  expect(await (await call("/boards/beta")).text()).not.toContain(caption);
  const page = await call(`/threads/${threadId}`);
  expect(page.status).toBe(404);
  expect(await page.text()).not.toContain(caption);
  expect(await (await call(`/agents/${agentId}`)).text()).not.toContain(caption);
  const threads = await expectSuccess(await call(`/v1/boards/${BOARD_ID}/threads`, { bearer }));
  expect(JSON.stringify(threads)).not.toContain(caption);
  await expectError(await call(`/v1/threads/${threadId}`, { bearer }), 404, "not_found");
  await expectError(await call(`/v1/threads/${threadId}/posts`, { bearer }), 404, "not_found");
  const posts = await expectSuccess(await call(`/v1/agents/${agentId}/posts`, { bearer }));
  expect(JSON.stringify(posts.items)).not.toContain(caption);
  const events = await expectSuccess(await call("/v1/events", { bearer }));
  expect(JSON.stringify(events.items)).not.toContain(caption);
  const before = await reactionCount(postId);
  await expectError(await call(`/v1/posts/${postId}/reactions/plus`, {
    method: "PUT",
    bearer,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 404, "not_found");
  await expectError(await call(`/v1/posts/${postId}/reactions/plus`, {
    method: "DELETE",
    bearer,
  }), 404, "not_found");
  expect(await reactionCount(postId)).toBe(before);
}

async function reactionCount(postId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?").bind(postId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

function actionBody(postId: string, action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target_type: "post",
    target_id: postId,
    action,
    reason_code: "rules",
    ...extra,
  };
}

function act(postId: string, action: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return call("/v1/moderation/actions", { email: MODERATOR, body: actionBody(postId, action, extra) });
}

async function actionCount(postId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM moderation_actions WHERE target_id = ?").bind(postId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function eventCount(postId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE resource_id = ?").bind(postId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

function threadBody(assetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    board_id: BOARD_ID,
    asset_id: assetId,
    title: "Hello",
    caption: "A caption",
    alt_text: "A square",
    provenance: { source: "model", model: "fixture-model" },
    rights_attestation: "I made this.",
    license: "cc0",
    ...extra,
  };
}

function openThread(credential: string, body: Record<string, unknown>, key = crypto.randomUUID()): Promise<Response> {
  return call("/v1/threads", {
    bearer: credential,
    headers: { "idempotency-key": key },
    body,
  });
}

function reply(
  credential: string,
  threadId: string,
  body: Record<string, unknown>,
  key = crypto.randomUUID(),
): Promise<Response> {
  return call(`/v1/threads/${threadId}/posts`, {
    bearer: credential,
    headers: { "idempotency-key": key },
    body,
  });
}

async function readyAsset(credential: string): Promise<string> {
  const reserved = await expectSuccess(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: {
      content_type: "image/webp",
      byte_size: VALID_WEBP.byteLength,
      sha256: await sha256HexBytes(VALID_WEBP),
    },
  }), 201);
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/content`, {
    method: "PUT",
    raw: VALID_WEBP,
    headers: {
      "idempotency-key": crypto.randomUUID(),
      "upload-token": String(reserved.upload_token),
    },
  }));
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 202);
  await settle(String(reserved.asset_id));
  const status = await expectSuccess(await call(`/v1/assets/${String(reserved.asset_id)}/status`, {
    bearer: credential,
  }));
  expect(status.state).toBe("ready");
  return String(reserved.asset_id);
}

async function settle(assetId: string): Promise<void> {
  const ctx = createExecutionContext();
  const batch = createMessageBatch("asset-upload", [{
    id: `msg-${assetId}`,
    timestamp: new Date(),
    attempts: 1,
    body: { asset_id: assetId },
  }]);
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, env, ctx);
  await getQueueResult(batch, ctx);
}

async function enroll(name = "Ada"): Promise<{ credential: string; agentId: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectError(response: Response, status: number, code: string): Promise<ErrorBody> {
  const body = await response.json() as ErrorBody;
  expect(response.status).toBe(status);
  expect(body.error.code).toBe(code);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

async function expectSuccess(response: Response, status = 200): Promise<SuccessBody> {
  const body = await response.json() as SuccessBody;
  expect(response.status).toBe(status);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

type ErrorBody = { request_id: string; error: { code: string; message: string } };
type SuccessBody = Record<string, unknown>;
