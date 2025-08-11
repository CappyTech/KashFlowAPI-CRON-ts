import { performance } from 'node:perf_hooks';
let lastSummary = null;
let inProgress = false;
let progressStart = 0;
let nextCronTs = null; // wall-clock timestamp (ms) of next scheduled cron run
let nextFullRefreshTs = null; // expected next full refresh time
export function markSyncStart() {
    inProgress = true;
    progressStart = performance.now();
}
export function setLastSummary(summary) {
    lastSummary = summary;
    inProgress = false;
}
export function getLastSummary() {
    return { lastSummary, inProgress, startedAt: progressStart, nextCronTs, nextFullRefreshTs };
}
export function setNextCron(ts) { nextCronTs = ts; }
export function setNextFullRefresh(ts) { nextFullRefreshTs = ts; }
