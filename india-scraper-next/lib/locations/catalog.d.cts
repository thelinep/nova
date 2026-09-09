export class InputError extends Error {}
export type LocationRecord = { id: string; corpus: string; dataset: string; name: string; category: string; state: string; city: string; district: string; latitude: number | null; longitude: number | null; sourceRecord: Record<string, unknown> };
export type SearchResult = { total: number; limit: number; offset: number; hasMore: boolean; records: LocationRecord[] };
export type Summary = { total: number; campaign: number; global: number; executionReady: number; categories: {corpus: string; category: string; count: number}[]; states: {corpus: string; state: string; count: number}[]; manifestSha256: string };
export function search(params: URLSearchParams, filename?: string): Promise<SearchResult>;
export function summary(filename?: string): Promise<Summary>;
export function parseQuery(params: URLSearchParams): unknown;
export function manifest(): Record<string, unknown>;
