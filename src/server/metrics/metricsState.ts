export let totalRuns = 0;
export let totalFailures = 0;
export let lastDurationMs = 0;

export function noteRun(success: boolean, durationMs: number) {
  totalRuns += 1;
  if (!success) totalFailures += 1;
  lastDurationMs = durationMs;
}

export function getCounters() {
  return { totalRuns, totalFailures, lastDurationMs };
}
