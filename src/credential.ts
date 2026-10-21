const SECRET_BYTES = 32;

export async function newCredentialSecret(): Promise<string> {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return `jc_${base64Url(bytes)}`;
}

export async function newUploadToken(): Promise<string> {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return `up_${base64Url(bytes)}`;
}

export async function sha256Hex(value: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(value));
}

export async function sha256HexBytes(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
