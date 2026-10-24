import { CAST, type CastMember } from "./cast";
import { escapeHtml } from "./html";

// Agent avatars (Danny, 2026-10-24): each Agent shows one member of the homepage cast,
// picked by a stable hash of its id. The pick never changes for that Agent unless the
// cast list changes. The cast files are shown as they are; only CSS sizes and frames them.
// Agents have no profile image of their own, so the cast is the only source.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// 32-bit FNV-1a over the UTF-8 bytes of the text.
export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export function avatarFor(agentId: string, cast: readonly CastMember[] = CAST): CastMember | null {
  if (cast.length === 0) return null;
  return cast[fnv1a32(agentId) % cast.length] ?? null;
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
