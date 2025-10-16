import { IncomingMessage, ServerResponse } from 'node:http';
import { getLastSummary, setNextCron, setNextFullRefresh } from '../../sync/summary.js';
import { getState } from '../../sync/state.js';
import { SyncSummaryModel, UpsertLogModel } from '../../db/models.js';
import { config } from '../../config.js';
import logger from '../../util/logger.js';
import { h1, pageShell } from './html.js';
import { getCounters } from './metricsState.js';
import { runSync } from '../../sync/run.js';

export async function handleMetrics(req: IncomingMessage, res: ServerResponse, accept: string) {
  const { lastSummary, inProgress, nextCronTs, nextFullRefreshTs } = getLastSummary();
  const { totalRuns, totalFailures, lastDurationMs } = getCounters();
  const u = new URL(req.url || '/', 'http://x');
  const format = (u.searchParams.get('format') || '').toLowerCase();
  const preferHtml = format === 'html' || (!format && accept.includes('text/html') && !accept.includes('text/plain'));
  const lines: string[] = [];
  lines.push('# HELP sync_runs_total Total sync runs');
  lines.push('# TYPE sync_runs_total counter');
  lines.push(`sync_runs_total ${totalRuns}`);
  lines.push('# HELP sync_failures_total Total failed sync runs');
  lines.push('# TYPE sync_failures_total counter');
  lines.push(`sync_failures_total ${totalFailures}`);
  lines.push('# HELP sync_last_duration_ms Duration of last completed sync in ms');
  lines.push('# TYPE sync_last_duration_ms gauge');
  lines.push(`sync_last_duration_ms ${lastDurationMs}`);
  lines.push('# HELP sync_last_success 1 if last sync succeeded, else 0');
  lines.push('# TYPE sync_last_success gauge');
  lines.push(`sync_last_success ${lastSummary ? (lastSummary.success ? 1 : 0) : 0}`);
  lines.push('# HELP sync_in_progress 1 if a sync is currently running');
  lines.push('# TYPE sync_in_progress gauge');
  lines.push(`sync_in_progress ${inProgress ? 1 : 0}`);
  const nowMs = Date.now();
  lines.push('# HELP sync_now_timestamp_seconds Current server time in seconds');
  lines.push('# TYPE sync_now_timestamp_seconds gauge');
  lines.push(`sync_now_timestamp_seconds ${Math.floor(nowMs / 1000)}`);
  if (lastSummary) {
    const startTs = Date.parse(lastSummary.start);
    const endTs = Date.parse(lastSummary.end);
    lines.push('# HELP sync_last_start_timestamp_seconds Start time of last sync');
    lines.push('# TYPE sync_last_start_timestamp_seconds gauge');
    lines.push(`sync_last_start_timestamp_seconds ${Math.floor(startTs / 1000)}`);
    lines.push('# HELP sync_last_end_timestamp_seconds End time of last sync');
    lines.push('# TYPE sync_last_end_timestamp_seconds gauge');
    lines.push(`sync_last_end_timestamp_seconds ${Math.floor(endTs / 1000)}`);
    lines.push('# HELP sync_time_since_last_success_seconds Seconds since last sync finished');
    lines.push('# TYPE sync_time_since_last_success_seconds gauge');
    lines.push(`sync_time_since_last_success_seconds ${(nowMs - endTs) / 1000}`);
  }
  if (nextCronTs) {
    lines.push('# HELP sync_next_cron_timestamp_seconds Next cron fire (predicted)');
    lines.push('# TYPE sync_next_cron_timestamp_seconds gauge');
    lines.push(`sync_next_cron_timestamp_seconds ${Math.floor(nextCronTs / 1000)}`);
  }
  if (nextFullRefreshTs) {
    lines.push('# HELP sync_next_full_refresh_timestamp_seconds Next full refresh timestamp');
    lines.push('# TYPE sync_next_full_refresh_timestamp_seconds gauge');
    lines.push(`sync_next_full_refresh_timestamp_seconds ${Math.floor(nextFullRefreshTs / 1000)}`);
  }
  try {
    const lastFull = await getState<number>('incremental:lastFullRefreshTs');
    if (lastFull) {
      lines.push('# HELP sync_last_full_refresh_timestamp_seconds Last full refresh (incrementals)');
      lines.push('# TYPE sync_last_full_refresh_timestamp_seconds gauge');
      lines.push(`sync_last_full_refresh_timestamp_seconds ${Math.floor(lastFull / 1000)}`);
    }
  } catch {}
  if (lastSummary) {
    for (const e of lastSummary.entities) {
      const lbl = `entity="${e.entity}"`;
      if (typeof e.fetched === 'number') lines.push(`sync_entity_fetched_total{${lbl}} ${e.fetched}`);
      if (typeof e.upserted === 'number') lines.push(`sync_entity_upserted_total{${lbl}} ${e.upserted}`);
      if (typeof e.processed === 'number') lines.push(`sync_entity_processed_total{${lbl}} ${e.processed}`);
      if (typeof e.pages === 'number') lines.push(`sync_entity_pages_total{${lbl}} ${e.pages}`);
      if (typeof e.total === 'number') lines.push(`sync_entity_api_total{${lbl}} ${e.total}`);
      if (typeof e.softDeleted === 'number') lines.push(`sync_entity_soft_deleted_total{${lbl}} ${e.softDeleted}`);
      if (typeof e.newMax === 'number') lines.push(`sync_entity_newmax{${lbl}} ${e.newMax}`);
      if (typeof e.lastMax === 'number') lines.push(`sync_entity_lastmax{${lbl}} ${e.lastMax}`);
      lines.push(`sync_entity_duration_ms{${lbl}} ${e.ms}`);
      lines.push(`sync_entity_full_refresh{${lbl}} ${e.fullRefresh ? 1 : 0}`);
      if (e.stoppedReason) {
        const reason = String(e.stoppedReason).replace(/\"/g, '');
        lines.push(`sync_entity_stop_reason{${lbl},reason="${reason}"} 1`);
      }
      if (typeof e.softDeleted === 'number' && typeof e.total === 'number' && e.total > 0) {
        const ratio = e.softDeleted / e.total;
        lines.push(`sync_entity_soft_delete_ratio{${lbl}} ${ratio}`);
      }
    }
  }
  try {
    const since = new Date(Date.now() - 3600_000);
    const entities = ['customers', 'suppliers', 'invoices', 'quotes', 'projects', 'purchases'];
    lines.push(`# HELP upsert_logs_hour_total Upsert log entries in the last hour per entity`);
    lines.push('# TYPE upsert_logs_hour_total gauge');
    for (const ent of entities) {
      const c = await UpsertLogModel.countDocuments({ entity: ent, ts: { $gte: since } });
      lines.push(`upsert_logs_hour_total{entity="${ent}"} ${c}`);
    }
  } catch {}
  try {
    const flags = config.flags || {} as Record<string, any>;
    for (const [k, v] of Object.entries(flags)) {
      if (typeof v === 'boolean') {
        lines.push(`# HELP config_flag_${k} Config flag ${k}`);
        lines.push(`# TYPE config_flag_${k} gauge`);
        lines.push(`config_flag_${k} ${v ? 1 : 0}`);
      }
    }
  } catch {}
  try {
    const mu = process.memoryUsage();
    lines.push('# HELP process_resident_memory_bytes Resident set size in bytes');
    lines.push('# TYPE process_resident_memory_bytes gauge');
    lines.push(`process_resident_memory_bytes ${mu.rss}`);
    lines.push('# HELP process_heap_used_bytes V8 heap used bytes');
    lines.push('# TYPE process_heap_used_bytes gauge');
    lines.push(`process_heap_used_bytes ${mu.heapUsed}`);
    lines.push('# HELP process_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE process_uptime_seconds gauge');
    lines.push(`process_uptime_seconds ${process.uptime()}`);
  } catch {}
  if (!preferHtml || format === 'prom' || format === 'text') {
    res.statusCode = 200; res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    return res.end(lines.join('\n') + '\n');
  }
  const entityRows = (lastSummary?.entities || []).map(e => `<tr><td>${e.entity}${e.fullRefresh ? ' *' : ''}</td><td>${e.pages ?? 0}</td><td>${e.fetched ?? 0}</td><td>${e.processed ?? ((e.lastMax !== undefined || e.newMax !== undefined) ? 'n/a' : 0)}</td><td>${e.upserted ?? 'n/a'}</td><td>${e.total ?? 0}</td><td>${e.softDeleted ?? 'n/a'}</td><td>${(e.lastMax !== undefined || e.newMax !== undefined) ? (e.lastMax || 0) + '->' + (e.newMax || 0) : 'n/a'}</td><td>${e.ms}</td><td>${e.stoppedReason || ''}</td></tr>`).join('');
  const extra = pageShell('Metrics', `${h1('Metrics')}<div><a href="/">&larr; Dashboard</a> | <a href="/metrics?format=prom" >Plain Text</a></div><h2>High-level</h2><ul><li>Total Runs: <strong>${totalRuns}</strong></li><li>Total Failures: <strong>${totalFailures}</strong></li><li>Last Duration: <strong>${lastDurationMs}</strong></li><li>In Progress: <strong>${inProgress ? 'yes' : 'no'}</strong></li><li>Last Success: <strong>${lastSummary ? (lastSummary.success ? 'yes' : 'no') : 'n/a'}</strong></li></ul><h2>Entities (Last Run)</h2><table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody>${entityRows || '<tr><td colspan=10>No data</td></tr>'}</tbody></table>`);
  res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(extra);
}

export async function handleTriggerSync(req: IncomingMessage, res: ServerResponse) {
  const remote = req.socket.remoteAddress;
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const allowed = isLocal || !!config.metrics.allowRemoteTrigger;
  if (!allowed) { res.statusCode = 403; return res.end('Forbidden'); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed'); }
  const { inProgress } = getLastSummary();
  if (inProgress) { res.statusCode = 409; return res.end('Sync already in progress'); }
  runSync().catch(err => logger.error({ err }, 'Manual sync failed'));
  res.statusCode = 202; return res.end('Sync triggered');
}
