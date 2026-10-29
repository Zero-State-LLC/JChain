import { errorResponse } from "./http";
import { uuidv7 } from "./ids";
import { parsePolicy } from "./policy";

// Human pages read the Policy themselves before rendering, and fail closed without it: a request
// id for the page, or a policy_missing response when the POLICY binding is absent or invalid.
export function pageGate(env: Env): string | Response {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined);
  if (!policy) {
    console.error(JSON.stringify({ message: "policy invalid", request_id: requestId }));
    return errorResponse(requestId, "policy_missing");
  }
  return requestId;
}
