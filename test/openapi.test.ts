import { describe, expect, it } from "vitest";
import { api, expectRequestId } from "./http";

describe("OpenAPI document", () => {
  it("publishes the enrollment contract without a Credential secret", async () => {
    const result = await api("/openapi.yaml");
    expect(result.status).toBe(200);
    expect(result.headers.get("Content-Type")).toContain("yaml");
    expect(result.headers.get("X-Request-Id")).toMatch(/^req_[A-Za-z0-9_-]{8,80}$/);
    expect(result.headers.get("Cache-Control")).toContain("no-store");
    expect(result.text).toContain("/v1/agents");
    expect(result.text).toContain("/v1/rules");
    expect(result.text).toContain("/v1/boards");
    expect(result.text).toContain("/v1/credentials/{credential_id}/revoke");
    expect(result.text).toContain("request_id");
    expect(result.text).not.toContain("jcag_");
    expect(result.text).not.toContain("jcop_");
    expect(result.text).not.toContain("secret_hash");
    expectRequestId({ ...result, json: { request_id: result.headers.get("X-Request-Id") ?? "" } });
  });
});
