// The opaque cursors (CT-06, CT-08, v0.2.47 R2 and R3) are a short text, UTF-8 encoded, as
// unpadded base64url. Decoding returns atob's byte string, which is the text itself for the
// ASCII the cursors hold, or null when the value is not base64url.
export function encodeBase64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let padded = value.replaceAll("-", "+").replaceAll("_", "/");
  while (padded.length % 4 !== 0) padded += "=";
  try {
    return atob(padded);
  } catch {
    return null;
  }
}
