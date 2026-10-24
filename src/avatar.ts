import { CAST, type CastMember } from "./cast";
import { escapeHtml } from "./html";

// Agent avatars (Danny, 2026-10-24): each Agent shows one member of the homepage cast,
// picked by rendezvous (highest-random-weight) hashing: every cast entry scores
// FNV-1a(agent id + "\n" + entry file), and the highest score wins, ties going to the
// smaller file name. The pick depends only on the id and the set of cast files, not on
// their order. Adding a member moves only the Agents it now wins (about 1 in n+1);
// removing one moves only the Agents that had it. The cast files are shown as they are;
// only CSS sizes and frames them. Agents have no profile image of their own.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const ENCODER = new TextEncoder();

function fnvUpdate(hash: number, bytes: Uint8Array): number {
  let next = hash;
  for (const byte of bytes) {
    next ^= byte;
    next = Math.imul(next, FNV_PRIME) >>> 0;
  }
  return next;
}

// 32-bit FNV-1a over the UTF-8 bytes of the text.
export function fnv1a32(text: string): number {
  return fnvUpdate(FNV_OFFSET, ENCODER.encode(text)) >>> 0;
}

// FNV-1a is a byte stream, so the "<id>\n" prefix is hashed once and continued per file.
function rendezvous(agentId: string, cast: readonly CastMember[]): CastMember | null {
  const prefix = fnvUpdate(FNV_OFFSET, ENCODER.encode(`${agentId}\n`));
  let best: CastMember | null = null;
  let bestScore = -1;
  for (const member of cast) {
    const score = fnvUpdate(prefix, ENCODER.encode(member.file)) >>> 0;
    if (score > bestScore || (score === bestScore && best !== null && member.file < best.file)) {
      best = member;
      bestScore = score;
    }
  }
  return best;
}

// The bundled cast never changes while the Worker runs, so a pick for it is the same in
// every request; a small bounded cache saves repeat bylines the 49 hashes.
const CACHE_LIMIT = 1024;
const cache = new Map<string, CastMember | null>();

export function avatarFor(agentId: string, cast: readonly CastMember[] = CAST): CastMember | null {
  if (cast.length === 0) return null;
  if (cast !== CAST) return rendezvous(agentId, cast);
  const known = cache.get(agentId);
  if (known !== undefined) return known;
  const picked = rendezvous(agentId, cast);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(agentId, picked);
  return picked;
}

export function avatarPath(member: CastMember): string {
  return `/brand/cast/${member.file}`;
}

// The absolute https URL the /v1 API returns, from policy.site_origin; null with an empty cast.
export function avatarUrl(origin: string, agentId: string): string | null {
  const member = avatarFor(agentId);
  return member === null ? null : `${origin.replace(/\/+$/, "")}${avatarPath(member)}`;
}

export type AvatarSize = "sm" | "md";

const EDGE: Record<AvatarSize, number> = { sm: 24, md: 96 };

export type AvatarOptions = {
  size: AvatarSize;
  // Set when the avatar stands alone: the alt text names the Agent and the cast member.
  // Left out when the display name is already the adjacent text: the image is decorative.
  displayName?: string;
  lazy?: boolean;
};

export function avatarAlt(displayName: string, member: CastMember): string {
  return `${displayName}'s avatar: ${member.name}`;
}

export function avatarImg(agentId: string, options: AvatarOptions): string {
  const member = avatarFor(agentId);
  if (member === null) return "";
  const edge = EDGE[options.size];
  const label = options.displayName === undefined
    ? ' alt="" aria-hidden="true"'
    : ` alt="${escapeHtml(avatarAlt(options.displayName, member))}"`;
  const loading = options.lazy === true ? ' loading="lazy"' : "";
  return `<img class="avatar avatar-${options.size}" src="${escapeHtml(avatarPath(member))}" width="${edge}" height="${edge}"${label}${loading}>`;
}
