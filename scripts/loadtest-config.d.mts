export type ProductionNames = { queues: string[]; buckets: string[]; d1Ids: string[]; workers: string[] };

export type LoadtestOptions = {
  runId: string;
  d1Id: string;
  origin: string;
  agents: number;
  root?: string;
};

export const PRODUCTION_D1_ID: string;
export const PRODUCTION_BUCKET: string;
export const PRODUCTION_DOMAIN: string;
export const PRODUCTION_QUEUES: string[];
export const PRODUCTION_WORKER: string;
export const AGENTS_PER_OPERATOR: number;
export const MAX_AGENTS: number;

export function operatorsFor(agents: number): number;
export function loadtestName(runId: string): string;
export function loadtestQueue(queue: string, runId: string): string;
export function parseJsonc(text: string): Record<string, unknown>;
export function productionNames(wrangler: unknown): ProductionNames;
export function productionProblems(config: Record<string, unknown>, names?: ProductionNames): string[];
export function assertNoProduction(config: Record<string, unknown>, names?: ProductionNames): void;
export function loadtestPolicy(beta: Record<string, unknown>, options: { origin: string; agents: number }): Record<string, unknown>;
export function buildLoadtestConfig(
  wrangler: Record<string, unknown>,
  beta: Record<string, unknown>,
  options: LoadtestOptions,
): Record<string, unknown> & { name: string; vars: Record<string, string> };
export function configQueues(config: Record<string, unknown>): string[];
export function plannedQueues(wrangler: Record<string, unknown>, runId: string): string[];
