import { INSTRUCTIONS } from "./rules-copy";

const REPLY_TEXT = "Noted.";
const MAX_PAGES = 1000;

export type Transport = (
  pathname: string,
  options: { bearer: string; method?: string; body?: unknown; headers?: Record<string, string> },
) => Promise<Response>;

type EventItem = {
  event_id: string;
  type: string;
  resource_id: string;
  occurred_at: string;
};

type VisiblePost = {
  thread_id: string;
  caption: string;
  alt_text: string | null;
};

export type ClientRun = {
  replies: Array<{ event_id: string; post_id: string }>;
  quoted: Array<{ caption: string; alt_text: string | null }>;
};

export async function runReferenceClient(transport: Transport, credential: string): Promise<ClientRun> {
  const board = await boardId(transport, credential);
  const rules = await readJson(await transport(`/v1/boards/${board}/rules`, { bearer: credential }));
  if (rules.instructions !== INSTRUCTIONS) return { replies: [], quoted: [] };
  const events = dedupe(sort(await allEvents(transport, credential)));
  const withdrawn = new Set(
    events.filter((event) => event.type === "post.withdrawn").map((event) => event.resource_id),
  );
  const replies: ClientRun["replies"] = [];
  const quoted: ClientRun["quoted"] = [];
  for (const event of events) {
    if (event.type !== "post.published" || withdrawn.has(event.resource_id)) continue;
    const post = await findPost(transport, credential, board, event.resource_id);
    if (post === null) continue;
    quoted.push({ caption: post.caption, alt_text: post.alt_text });
    if (post.caption === REPLY_TEXT) continue;
    const created = await readJson(await transport(`/v1/threads/${post.thread_id}/posts`, {
      bearer: credential,
      method: "POST",
      headers: { "idempotency-key": event.event_id },
      body: { text: REPLY_TEXT },
    }));
    if (typeof created.post_id === "string") {
      replies.push({ event_id: event.event_id, post_id: created.post_id });
    }
  }
  return { replies, quoted };
}

async function boardId(transport: Transport, credential: string): Promise<string> {
  const listed = await readJson(await transport("/v1/boards", { bearer: credential }));
  const items = listed.items;
  if (!Array.isArray(items) || items.length === 0) throw new Error("no board");
  const first = items[0];
  if (typeof first !== "object" || first === null || typeof (first as { id?: unknown }).id !== "string") {
    throw new Error("no board");
  }
  return (first as { id: string }).id;
}

async function allEvents(transport: Transport, credential: string): Promise<EventItem[]> {
  const collected: EventItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const path = after === null
      ? "/v1/events?limit=100"
      : `/v1/events?limit=100&after=${encodeURIComponent(after)}`;
    const body = await readJson(await transport(path, { bearer: credential }));
    if (!Array.isArray(body.items)) return collected;
    for (const item of body.items) {
      if (isEvent(item)) collected.push(item);
    }
    after = typeof body.next_cursor === "string" ? body.next_cursor : null;
    if (after === null) return collected;
  }
  throw new Error("event cursor did not end");
}

async function findPost(
  transport: Transport,
  credential: string,
  board: string,
  resourceId: string,
): Promise<VisiblePost | null> {
  let threadCursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const path = threadCursor === null
      ? `/v1/boards/${board}/threads?limit=100`
      : `/v1/boards/${board}/threads?limit=100&cursor=${encodeURIComponent(threadCursor)}`;
    const listed = await readJson(await transport(path, { bearer: credential }));
    if (!Array.isArray(listed.items)) return null;
    for (const item of listed.items) {
      if (typeof item !== "object" || item === null) continue;
      const threadId = (item as { thread_id?: unknown }).thread_id;
      if (typeof threadId !== "string") continue;
      const found = await findInThread(transport, credential, threadId, resourceId);
      if (found !== null) return found;
    }
    threadCursor = typeof listed.next_cursor === "string" ? listed.next_cursor : null;
    if (threadCursor === null) return null;
  }
  throw new Error("thread cursor did not end");
}

async function findInThread(
  transport: Transport,
  credential: string,
  threadId: string,
  resourceId: string,
): Promise<VisiblePost | null> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const path = cursor === null
      ? `/v1/threads/${threadId}/posts?limit=100`
      : `/v1/threads/${threadId}/posts?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const listed = await readJson(await transport(path, { bearer: credential }));
    if (!Array.isArray(listed.items)) return null;
    for (const item of listed.items) {
      if (typeof item !== "object" || item === null) continue;
      const row = item as { post_id?: unknown; caption?: unknown; alt_text?: unknown };
      if (row.post_id !== resourceId || typeof row.caption !== "string") continue;
      const alt = row.alt_text;
      return {
        thread_id: threadId,
        caption: row.caption,
        alt_text: typeof alt === "string" ? alt : null,
      };
    }
    cursor = typeof listed.next_cursor === "string" ? listed.next_cursor : null;
    if (cursor === null) return null;
  }
  throw new Error("post cursor did not end");
}

function sort(events: EventItem[]): EventItem[] {
  return [...events].sort((left, right) => {
    if (left.occurred_at < right.occurred_at) return -1;
    if (left.occurred_at > right.occurred_at) return 1;
    if (left.event_id < right.event_id) return -1;
    if (left.event_id > right.event_id) return 1;
    return 0;
  });
}

function dedupe(events: EventItem[]): EventItem[] {
  const seen = new Set<string>();
  const kept: EventItem[] = [];
  for (const event of events) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    kept.push(event);
  }
  return kept;
}

function isEvent(value: unknown): value is EventItem {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<EventItem>;
  return typeof event.event_id === "string"
    && typeof event.type === "string"
    && typeof event.resource_id === "string"
    && typeof event.occurred_at === "string";
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  if (response.status >= 400) throw new Error(`reference client request failed ${response.status}`);
  return body;
}
