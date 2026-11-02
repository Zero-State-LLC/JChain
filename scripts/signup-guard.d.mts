export const OPEN_SIGNUP_MAX_OPERATORS: number;
export const OPEN_SIGNUP_DECISION: RegExp;
export const SAFETY_MARKERS: Record<string, Record<string, string[]>>;
export const SAFETY_CHECKS: string[];
export function safetyFromSources(sources: Record<string, string | undefined>): Record<string, boolean>;
export function signupProblem(policy: unknown, tickets: unknown, safety: Record<string, boolean> | undefined): string | null;
