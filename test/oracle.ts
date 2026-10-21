/** Independent SHA-256 oracle. Intentionally not imported from production code. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function includesText(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(needle);
}

export function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([entryKey, entry]) => entryKey === key || hasKey(entry, key));
  }
  return false;
}
