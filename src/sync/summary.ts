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

export function markSyncStart() {
  inProgress = true;
  progressStart = performance.now();
}

export function setLastSummary(summary: SyncSummary) {
  lastSummary = summary;
  inProgress = false;
}

export function getLastSummary() {
  return { lastSummary, inProgress, startedAt: progressStart };
}
