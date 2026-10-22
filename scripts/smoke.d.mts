export type SmokeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function runSmoke(baseUrl: string, fetchImpl?: SmokeFetch): Promise<{ ok: boolean; lines: string[] }>;
