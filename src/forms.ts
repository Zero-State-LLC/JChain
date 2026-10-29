// The request body readers every route shares. A JSON body needs an application/json content
// type and must be one object. An HTML form body needs application/x-www-form-urlencoded, and a
// repeated field is malformed. Anything else is { ok: false }, which routes answer as malformed.

export type FormResult = { ok: true; value: Record<string, string> } | { ok: false };
export type JsonResult = { ok: true; value: Record<string, unknown> } | { ok: false };

function hasType(request: Request, prefix: string): boolean {
  const type = request.headers.get("content-type");
  return type !== null && type.toLowerCase().startsWith(prefix);
}

// URL-encoded HTML form bodies. A repeated field is malformed.
export async function readForm(request: Request): Promise<FormResult> {
  if (!hasType(request, "application/x-www-form-urlencoded")) return { ok: false };
  let text: string;
  try {
    text = new TextDecoder().decode(await request.arrayBuffer());
  } catch {
    return { ok: false };
  }
  const params = new URLSearchParams(text);
  const value: Record<string, string> = {};
  for (const [key, item] of params.entries()) {
    if (Object.hasOwn(value, key)) return { ok: false };
    value[key] = item;
  }
  return { ok: true, value };
}

export async function readJsonObject(request: Request): Promise<JsonResult> {
  if (!hasType(request, "application/json")) return { ok: false };
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  return { ok: true, value: parsed as Record<string, unknown> };
}

// For a route that takes the same fields from a page form or from JSON. `form` says which,
// for routes that answer a form with a page and JSON with JSON.
export async function readFormOrJson(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown>; form: boolean } | { ok: false }> {
  if (hasType(request, "application/json")) {
    const body = await readJsonObject(request);
    return body.ok ? { ...body, form: false } : body;
  }
  if (hasType(request, "application/x-www-form-urlencoded")) {
    const body = await readForm(request);
    return body.ok ? { ...body, form: true } : body;
  }
  return { ok: false };
}
