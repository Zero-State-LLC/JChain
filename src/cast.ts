import manifest from "../public/brand/cast/cast.json";

// The homepage mascot: a rotating cast. The manifest is bundled at build time;
// public/brand/cast/README.md says how to add a member.

export type CastMember = {
  file: string;
  name: string;
  alt: string;
  // Provenance: where the art came from, who made it, and the license it is used under.
  source: string;
  author: string;
  license: string;
  // Intrinsic size of the file; 1600x1280 (5:4) when not given.
  width: number;
  height: number;
};

const FILE = /^[a-z0-9][a-z0-9-]*\.(?:webp|svg)$/;
const SOURCE = /^https:\/\/[^\s"<>]+$/;
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 1280;
const HOUR_MS = 3_600_000;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > max ? null : trimmed;
}

function dimension(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 4096 ? value : null;
}

// Entries that are malformed or lack provenance are dropped, so a bad edit falls back
// to the remaining cast, or to the text hero when none is left.
export function parseCast(raw: unknown): CastMember[] {
  if (!Array.isArray(raw)) return [];
  const cast: CastMember[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const file = text(record.file, 120);
    const name = text(record.name, 80);
    const alt = text(record.alt, 500);
    const source = text(record.source, 500);
    const author = text(record.author, 200);
    const license = text(record.license, 200);
    const width = dimension(record.width, DEFAULT_WIDTH);
    const height = dimension(record.height, DEFAULT_HEIGHT);
    if (file === null || !FILE.test(file) || name === null || alt === null) continue;
    if (source === null || !SOURCE.test(source) || author === null || license === null) continue;
    if (width === null || height === null) continue;
    cast.push({ file, name, alt, source, author, license, width, height });
  }
  return cast;
}

export const CAST: readonly CastMember[] = parseCast(manifest as unknown);

// One member per UTC hour: the hour index since the epoch, modulo the cast size.
export function castForHour(cast: readonly CastMember[], now: Date): CastMember | null {
  if (cast.length === 0) return null;
  const hour = Math.floor(now.getTime() / HOUR_MS);
  const index = ((hour % cast.length) + cast.length) % cast.length;
  return cast[index] ?? null;
}
