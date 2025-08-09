import { performance } from 'node:perf_hooks';

export interface EntitySummaryBase {
  entity: string;
  pages?: number;
  fetched: number;
  processed?: number; // same as fetched for full traversals
  upserted?: number;
  total?: number;
  softDeleted?: number;
  lastMax?: number;
  newMax?: number;
  reachedOld?: boolean;
  stoppedReason?: string;
  unpaged?: boolean;
  fullRefresh?: boolean; // indicates run included a scheduled full refresh traversal for incremental entities
  ms: number;
}

export interface SyncSummary {
  start: string; // ISO
  end: string; // ISO
  durationMs: number;
  success: boolean;
  error?: string;
  entities: EntitySummaryBase[];
}

let lastSummary: SyncSummary | null = null;
let inProgress = false;
let progressStart = 0;
let nextCronTs: number | null = null; // wall-clock timestamp (ms) of next scheduled cron run
let nextFullRefreshTs: number | null = null; // expected next full refresh time

export function markSyncStart() {
  inProgress = true;
  progressStart = performance.now();
}

export function setLastSummary(summary: SyncSummary) {
  lastSummary = summary;
  inProgress = false;
}

export function getLastSummary() {
  return { lastSummary, inProgress, startedAt: progressStart, nextCronTs, nextFullRefreshTs };
}

export function setNextCron(ts: number) { nextCronTs = ts; }
export function setNextFullRefresh(ts: number) { nextFullRefreshTs = ts; }
