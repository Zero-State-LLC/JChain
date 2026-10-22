import { describe, expect, it } from "vitest";
import { JChainError, connectAgent, type ConnectCode } from "../src/index.js";

const CREDENTIAL = `jc_${"x".repeat(43)}`;
const DEVICE = `dc_${"d".repeat(43)}`;

function scripted(replies: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("no reply scripted");
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers });
  };
  return { fetch, calls };
}

const STARTED = {
  device_code: DEVICE,
  user_code: "BCDF-GHJK",
  verification_uri: "https://j-chain.net/operator/connect",
  verification_uri_complete: "https://j-chain.net/operator/connect?code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
};

describe("connectAgent", () => {
  it("shows the code, waits, slows down on 429, and returns the Credential", async () => {
    const { fetch, calls } = scripted([
      { status: 201, body: STARTED },
      { body: { state: "pending" } },
      { status: 429, body: { error: { code: "rate_limited", message: "slow" } }, headers: { "retry-after": "12" } },
      { body: { state: "approved", agent_id: "a1", credential: CREDENTIAL } },
    ]);
    const shown: ConnectCode[] = [];
    const waits: number[] = [];
    const result = await connectAgent({
      displayName: "Ada",
      declaredModel: "m",
      fetch,
      sleep: async (ms) => { waits.push(ms); },
      onCode: (code) => { shown.push(code); },
    });
    expect(result).toEqual({ agentId: "a1", credential: CREDENTIAL });
    expect(shown[0]?.userCode).toBe("BCDF-GHJK");
    expect(calls[0]).toEqual({ url: "https://j-chain.net/v1/connect", body: { display_name: "Ada", declared_model: "m" } });
    expect(calls[1]).toEqual({ url: "https://j-chain.net/v1/connect/token", body: { device_code: DEVICE } });
    expect(waits).toEqual([5000, 5000, 12000]);
  });

  it("throws on deny and on expiry", async () => {
    for (const [state, code] of [["denied", "connect_denied"], ["expired", "connect_expired"]] as const) {
      const { fetch } = scripted([{ status: 201, body: STARTED }, { body: { state } }]);
      await expect(connectAgent({ displayName: "Ada", declaredModel: "m", fetch, sleep: async () => {}, onCode: () => {} }))
        .rejects.toMatchObject({ code });
    }
    const { fetch } = scripted([{ status: 422, body: { error: { code: "validation_failed", message: "bad" } } }]);
    await expect(connectAgent({ displayName: "", declaredModel: "m", fetch, sleep: async () => {}, onCode: () => {} }))
      .rejects.toBeInstanceOf(JChainError);
  });
});
