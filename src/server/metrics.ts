import http from 'node:http';

import logger, { getLogBuffer, logEvents } from '../util/logger.js';
import { config } from '../config.js';
import { getLastSummary, setNextCron, setNextFullRefresh } from '../sync/summary.js';
import { runSync } from '../sync/run.js';
import { SyncSummaryModel, UpsertLogModel } from '../db/models.js';
import { getState } from '../sync/state.js';
import { APP_VERSION } from '../version.js';

let totalRuns = 0;
let totalFailures = 0;
let lastDurationMs = 0;

export function noteRun(success: boolean, durationMs: number) {
  totalRuns += 1;
  if (!success) totalFailures += 1;
  lastDurationMs = durationMs;
}

function human(ms: number) {
  if (ms < 1000) return ms + ' ms';
  const sec = ms / 1000;
  if (sec < 60) return sec.toFixed(sec < 10 ? 2 : 1) + ' s';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const remMs = Math.floor(ms % 1000);
  if (sec < 3600) return m + 'm ' + s + 's' + (remMs ? ' ' + remMs + 'ms' : '');
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h + 'h ' + mm + 'm ' + s + 's';
}

function h1(title: string) {
  return `<h1>${title} <small style="font-size:.55em;opacity:.65;">v${APP_VERSION}</small></h1>`;
}

export function startMetricsServer() {
  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    // Log route access when response finishes
    res.on('finish', () => {
      try {
        logger.info({ method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - startedAt }, 'route');
      } catch { /* swallow logging errors */ }
    });
    // HTTP Basic Auth for all endpoints
    const user = config.metrics.authUser;
    const pass = config.metrics.authPass;
    // Health endpoint (no auth) for container orchestration
    if (req.url === '/health') {
      res.statusCode = 200; return res.end('ok');
    }
    if (user && pass) {
      const auth = req.headers['authorization'];
      if (!auth || !auth.startsWith('Basic ')) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm="Metrics"');
        return res.end('Authentication required');
      }
      const b64 = auth.split(' ')[1];
      let decoded = '';
      try { decoded = Buffer.from(b64, 'base64').toString(); } catch { }
      const [u, p] = decoded.split(':');
      if (u !== user || p !== pass) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm="Metrics"');
        return res.end('Invalid credentials');
      }
    }
    if (!req.url) { res.statusCode = 400; return res.end('Bad request'); }
    const url = req.url;
    const accept = req.headers.accept || '';

    // Root dashboard
    if (url === '/' || url.startsWith('/index.html')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>KashFlow Sync Dashboard</title>
    <style>
      body { font-family: system-ui, Arial, sans-serif; margin: 1.3rem; background: #0f1115; color: #eee; }
      h1 { margin: 0 0 .75rem; }
      table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
      th, td { border: 1px solid #333; padding: 6px 8px; font-size: .8rem; text-align: left; }
      th { background: #1d2229; }
      tbody tr:nth-child(even) { background: #181c22; }
      .ok { color: #6cc644; }
      .fail { color: #ff5555; }
      .progress { color: #f0ad4e; }
  .sync-active-badge { display:inline-block; margin-left:.5rem; padding:2px 6px; font-size:.55rem; letter-spacing:.5px; background:#f0ad4e; color:#000; border-radius:4px; font-weight:600; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%{opacity:1;} 50%{opacity:.35;} 100%{opacity:1;} }
      button { background: #1d2229; color: #eee; border: 1px solid #333; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: .75rem; }
      button:hover { background: #242a32; }
      code { background: #181c22; padding: 2px 4px; border-radius: 4px; }
      a { color: #6cc6ff; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    ${h1('KashFlow Sync Dashboard')}
    <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:.5rem;">
      <button type="button" id="triggerBtn">Trigger Sync</button>
      <button type="button" id="historyBtn">Show History</button>
      <button type="button" class="navBtn" data-link="/metrics">Metrics</button>
      <button type="button" class="navBtn" data-link="/upserts">Upserts</button>
      <button type="button" class="navBtn" data-link="/sync-summary">Latest Summary</button>
      <button type="button" class="navBtn" data-link="/summaries">All Summaries</button>
      <button type="button" class="navBtn" data-link="/timers">Timers</button>
      <button type="button" class="navBtn" data-link="/logs">Logs</button>
      <button type="button" class="navBtn" data-link="/logs?format=json">Logs JSON</button>
      <span id="triggerResult" style="align-self:center;font-size:.75rem;"></span>
    </div>
  <div id="status">Loading...</div>
  <div id="syncIndicator" style="display:none;margin-top:.25rem;"><span class="sync-active-badge">SYNC IN PROGRESS</span></div>
    <div id="timers" style="margin-top:.5rem;font-size:.7rem;opacity:.85;">
      <span id="nextCron">Next cron: calculating...</span> | <span id="nextFull">Next full refresh: calculating...</span>
    </div>
    <table id="entities" style="display:none;">
      <thead>
        <tr>
          <th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <div id="legend" style="display:none;font-size:.6rem;opacity:.7;margin-top:.25rem;">* full refresh traversal</div>
    <div id="history" style="display:none;margin-top:1rem;">
      <h2 style="margin:0 0 .4rem;font-size:1rem;">Recent Sync History</h2>
      <table id="historyTable">
        <thead>
          <tr><th>Start</th><th>End</th><th>Duration</th><th>Success</th><th>Error</th><th>Entities</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <p style="margin-top:1rem;font-size:.75rem;">Shortcuts: <a href="/metrics">/metrics</a> · <a href="/sync-summary">/sync-summary</a> · <a href="/summaries">/summaries</a> · <a href="/upserts">/upserts</a> · <a href="/logs">/logs</a></p>
    <div id="miniLogs" style="margin-top:1rem;">
      <h2 style="margin:0 0 .4rem;font-size:1rem;">Live Logs <small id="miniStatus" style="opacity:.7"></small></h2>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.4rem;">
        <button type="button" id="miniShowBtn">Show</button>
        <button type="button" id="miniPauseBtn">Pause</button>
        <button type="button" id="miniClearBtn">Clear</button>
        <button type="button" id="miniDownloadBtn">Download Tail</button>
      </div>
      <pre id="miniLog" style="display:none;max-height:240px;overflow:auto;background:#181c22;padding:6px;border-radius:4px;"></pre>
    </div>
    <script>
      // --- Dashboard Client Logic (restored) ---
      const statusEl = document.getElementById('status');
      const entitiesTable = document.getElementById('entities');
      const legendEl = document.getElementById('legend');
      const triggerBtn = document.getElementById('triggerBtn');
      const triggerResult = document.getElementById('triggerResult');
      const historyBtn = document.getElementById('historyBtn');
      const historyDiv = document.getElementById('history');
      const historyTableBody = document.querySelector('#historyTable tbody');
      const nextCronEl = document.getElementById('nextCron');
      const nextFullEl = document.getElementById('nextFull');
      // Mini log elements
      const miniLogWrap = document.getElementById('miniLogs');
      const miniLogEl = document.getElementById('miniLog');
      const miniShowBtn = document.getElementById('miniShowBtn');
      const miniPauseBtn = document.getElementById('miniPauseBtn');
      const miniClearBtn = document.getElementById('miniClearBtn');
      const miniDownloadBtn = document.getElementById('miniDownloadBtn');
      const miniStatus = document.getElementById('miniStatus');

      let miniEventSource = null;
      let miniPaused = false;
      let miniVisible = false;
      let miniCount = 0;

  function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');}
      async function fetchJson(url){
        const r = await fetch(url, { headers:{Accept:'application/json'} });
        const txt = await r.text();
        if (!r.ok) throw new Error('HTTP '+r.status+' '+txt.slice(0,120));
        try { return JSON.parse(txt); } catch { throw new Error('Parse fail '+url); }
      }
      function human(ms){
        if (ms < 1000) return ms + ' ms';
        const sec = ms / 1000;
        if (sec < 60) return sec.toFixed(sec < 10 ? 2 : 1) + ' s';
        const m = Math.floor(sec/60), s = Math.floor(sec%60), rem = ms%1000;
        if (sec < 3600) return m+'m '+s+'s'+(rem?(' '+rem+'ms'):'');
        const h = Math.floor(m/60), mm = m%60;
        return h+'h '+mm+'m '+s+'s';
      }
  function relative(ts){ if(!ts) return '(unknown)'; const diff = ts - Date.now(); if (diff <= 0) return 'due'; const m = Math.floor(diff/60000); if (m > 120) return Math.round(m/60)+'h'; if (m>0) return m+'m'; return Math.round(diff/1000)+'s'; }

  function updateTimersUI(){
        try {
          const cronTs = Number(nextCronEl.dataset.ts||'');
            if (cronTs) nextCronEl.textContent = 'Next cron: '+ new Date(cronTs).toLocaleString() + ' ('+relative(cronTs)+')';
          const fullTs = Number(nextFullEl.dataset.ts||'');
            if (fullTs) nextFullEl.textContent = 'Next full refresh: '+ new Date(fullTs).toLocaleString() + ' ('+relative(fullTs)+')';
        } catch {}
      }
  setInterval(updateTimersUI, 5000);

  async function loadSummary(){
        try {
          const data = await fetchJson('/sync-summary?format=json');
          try { if (data.nextCronTs) nextCronEl.dataset.ts = String(data.nextCronTs); if (data.nextFullRefreshTs) nextFullEl.dataset.ts = String(data.nextFullRefreshTs); } catch {}
          const indicator = document.getElementById('syncIndicator');
          if (data.inProgress) { indicator.style.display='block'; } else { indicator.style.display='none'; }
          if (!data.lastSummary){
            statusEl.innerHTML = '<span class="progress">No completed sync yet.</span>' + (data.inProgress ? ' <span class=progress>(sync running)</span>' : '');
            entitiesTable.style.display='none'; legendEl.style.display='none'; return;
          }
          const s = data.lastSummary;
          statusEl.innerHTML = 'Last Sync: ' + (s.success?'<span class=ok>SUCCESS</span>':'<span class=fail>FAIL</span>')
            +' | Start: <code>'+ new Date(s.start).toLocaleString() +'</code>'
            +' | End: <code>'+ new Date(s.end).toLocaleString() +'</code>'
            +' | Duration: <code title="'+s.durationMs+' ms">'+human(s.durationMs)+'</code>'
            +(data.inProgress? ' | <span class=progress>Current sync running...</span>':'')
            +(s.error? '<br/><small style="color:#ff5555">'+escHtml(s.error)+'</small>':'');
          const body = entitiesTable.querySelector('tbody');
          body.innerHTML='';
          let anyFull=false;
          (s.entities||[]).forEach(e=>{
            const tr=document.createElement('tr');
            function td(v){ const d=document.createElement('td'); d.textContent=v; return d; }
            const incr = (e.lastMax!==undefined)||(e.newMax!==undefined)||(e.upserted!==undefined);
            const processed = e.processed!==undefined?e.processed:(incr?'n/a':0);
            const upserted = e.upserted!==undefined?e.upserted:(incr?0:'n/a');
            const soft = e.softDeleted!==undefined?e.softDeleted:(incr?'n/a':0);
            const range = (e.lastMax!==undefined||e.newMax!==undefined)?(e.lastMax||0)+'->'+(e.newMax||0):'n/a';
            const nameCell=(e.entity||'')+(e.fullRefresh?' *':'');
            if (e.fullRefresh) anyFull=true;
            tr.appendChild(td(nameCell));
            tr.appendChild(td(e.pages??0));
            tr.appendChild(td(e.fetched??0));
            tr.appendChild(td(processed));
            tr.appendChild(td(upserted));
            tr.appendChild(td(e.total??0));
            tr.appendChild(td(soft));
            tr.appendChild(td(range));
            tr.appendChild(td(human(e.ms||0)));
            tr.appendChild(td(e.stoppedReason||''));
            body.appendChild(tr);
          });
          entitiesTable.style.display='table';
          legendEl.style.display = anyFull ? 'block':'none';
        } catch (e){ /* silent */ }
      }
  loadSummary();
  setInterval(loadSummary, 15000);

  async function loadHistory(){
        try {
          const docs = await fetchJson('/summaries?limit=25&format=json');
          historyTableBody.innerHTML = (docs||[]).map(d=>{
            const start=d.start?new Date(d.start).toLocaleString():'';
            const end=d.end?new Date(d.end).toLocaleString():'';
            return '<tr><td>'+start+'</td><td>'+end+'</td><td>'+human(d.durationMs||0)+'</td><td>'+(d.success?'✔':'✖')+'</td><td>'+(d.error?escHtml(String(d.error)).slice(0,60):'')+'</td><td>'+((d.entities||[]).length)+'</td></tr>';
          }).join('');
        } catch {}
      }

  historyBtn.addEventListener('click', async () => {
        const show = historyDiv.style.display === 'none';
        historyDiv.style.display = show ? 'block':'none';
        historyBtn.textContent = show ? 'Hide History':'Show History';
        if (show) await loadHistory();
      });

  triggerBtn.addEventListener('click', async () => {
        triggerBtn.disabled = true; const prev = triggerBtn.textContent; triggerBtn.textContent='Triggering...'; triggerResult.textContent='';
        try { const r = await fetch('/trigger-sync',{method:'POST'}); const txt = await r.text(); triggerResult.style.color = r.ok?'#6cc644':'#ff5555'; triggerResult.textContent = (r.ok?'OK ':'FAIL ')+txt; }
        catch(e){ triggerResult.style.color='#ff5555'; triggerResult.textContent='Error '+e.message; }
        finally { triggerBtn.disabled=false; triggerBtn.textContent=prev; setTimeout(()=>triggerResult.textContent='', 15000); }
      });

  function ensureMiniStream(){
        if (miniEventSource) return;
        miniEventSource = new EventSource('/logs/stream');
        miniEventSource.onmessage = ev => {
          if (miniPaused || !miniVisible) return;
            try { const rec = JSON.parse(ev.data); appendMini(rec); } catch {}
        };
        miniEventSource.onerror = () => { /* let browser retry */ };
      }
  function miniSetStatus(){ miniStatus.textContent = (miniPaused?'[PAUSED] ':'') + miniCount + ' entries'; }
  function formatLog(rec){
        try {
          const ts = rec && rec.ts ? new Date(rec.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
          let msg = rec && rec.msg ? rec.msg : '';
          if (rec && rec.data !== undefined) {
            try { msg += ' '+ JSON.stringify(rec.data); } catch {}
          }
          if (!msg) { msg = JSON.stringify(rec); }
          return '['+ts+'] '+msg;
        } catch { return '[?] '+String(rec); }
      }
  function appendMini(rec){
        if (!miniVisible) return;
        const line = formatLog(rec);
        miniLogEl.textContent += line + '\n';
        miniCount++;
        if (miniLogEl.textContent.length > 200_000) { // trim if grows too large
          miniLogEl.textContent = miniLogEl.textContent.slice(-150_000);
        }
        miniLogEl.scrollTop = miniLogEl.scrollHeight;
        miniSetStatus();
      }
  miniShowBtn.addEventListener('click', async () => {
        miniVisible = !miniVisible;
        miniLogEl.style.display = miniVisible ? 'block':'none';
        miniShowBtn.textContent = miniVisible ? 'Hide':'Show';
        if (miniVisible) {
          // initial tail
          try { const tail = await fetchJson('/logs?format=json'); (tail||[]).forEach(r=>appendMini(r)); } catch {}
          ensureMiniStream();
        }
      });
  miniPauseBtn.addEventListener('click', () => { miniPaused = !miniPaused; miniPauseBtn.textContent = miniPaused ? 'Resume':'Pause'; miniSetStatus(); });
  miniClearBtn.addEventListener('click', () => { miniLogEl.textContent=''; miniCount=0; miniSetStatus(); });
  miniDownloadBtn.addEventListener('click', async () => {
        try {
          const list = await fetchJson('/logs?format=json');
          const blob = new Blob([JSON.stringify(list,null,2)],{type:'application/json'});
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download='logs-tail.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
        } catch(e){ /* ignore */ }
      });
  miniSetStatus();

      // Navigation buttons
      document.querySelectorAll('.navBtn').forEach(b=>b.addEventListener('click',()=>{ const l=b.getAttribute('data-link'); if(l) window.location.href=l; }));
    </script>
  </body>
</html>`);
    }

    // /metrics (Prometheus or HTML)
    else if (url.startsWith('/metrics')) {
      (async () => {
        const u = new URL(url, 'http://x');
        const format = (u.searchParams.get('format') || '').toLowerCase();
        const preferHtml = format === 'html' || (!format && accept.includes('text/html') && !accept.includes('text/plain'));
        const { lastSummary, inProgress, nextCronTs, nextFullRefreshTs } = getLastSummary();
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
        // Timestamps
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
        // Last full refresh state
        try {
          const lastFull = await getState<number>('incremental:lastFullRefreshTs');
          if (lastFull) {
            lines.push('# HELP sync_last_full_refresh_timestamp_seconds Last full refresh (incrementals)');
            lines.push('# TYPE sync_last_full_refresh_timestamp_seconds gauge');
            lines.push(`sync_last_full_refresh_timestamp_seconds ${Math.floor(lastFull / 1000)}`);
          }
        } catch { }
        // Entity metrics
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
              const reason = String(e.stoppedReason).replace(/"/g, '');
              lines.push(`sync_entity_stop_reason{${lbl},reason="${reason}"} 1`);
            }
            if (typeof e.softDeleted === 'number' && typeof e.total === 'number' && e.total > 0) {
              const ratio = e.softDeleted / e.total;
              lines.push(`sync_entity_soft_delete_ratio{${lbl}} ${ratio}`);
            }
          }
        }
        // Rolling stats (last 50 summaries)
        try {
          const recent = await SyncSummaryModel.find({}, { durationMs: 1, success: 1 }).sort({ start: -1 }).limit(50).lean();
          if (recent.length) {
            const durations = recent.map(r => r.durationMs).filter(Boolean) as number[];
            if (durations.length) {
              const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
              const sorted = [...durations].sort((a, b) => a - b);
              const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length) - 1)];
              lines.push('# HELP sync_recent_avg_duration_ms Mean duration (last 50 runs)');
              lines.push('# TYPE sync_recent_avg_duration_ms gauge');
              lines.push(`sync_recent_avg_duration_ms ${avg}`);
              lines.push('# HELP sync_recent_p95_duration_ms 95th percentile duration (last 50 runs)');
              lines.push('# TYPE sync_recent_p95_duration_ms gauge');
              lines.push(`sync_recent_p95_duration_ms ${p95}`);
            }
            // Success / failure streaks
            let successStreak = 0, failureStreak = 0;
            for (const r of recent) { if (r.success) { if (failureStreak === 0) successStreak++; else break; } else { if (successStreak === 0) failureStreak++; else break; } }
            lines.push('# HELP sync_success_streak Current consecutive success count');
            lines.push('# TYPE sync_success_streak gauge');
            lines.push(`sync_success_streak ${successStreak}`);
            lines.push('# HELP sync_failure_streak Current consecutive failure count');
            lines.push('# TYPE sync_failure_streak gauge');
            lines.push(`sync_failure_streak ${failureStreak}`);
          }
        } catch { }
        // Upsert logs last hour per entity (approx activity rate)
        try {
          const since = new Date(Date.now() - 3600_000);
          const entities = ['customers', 'suppliers', 'invoices', 'quotes', 'projects', 'purchases'];
          lines.push(`# HELP upsert_logs_hour_total Upsert log entries in the last hour per entity`);
          lines.push('# TYPE upsert_logs_hour_total gauge');
          for (const ent of entities) {
            const c = await UpsertLogModel.countDocuments({ entity: ent, ts: { $gte: since } });
            lines.push(`upsert_logs_hour_total{entity="${ent}"} ${c}`);
          }
        } catch { }
        // Config flags (boolean only)
        try {
          const flags = config.flags || {} as Record<string, any>;
          for (const [k, v] of Object.entries(flags)) {
            if (typeof v === 'boolean') {
              lines.push(`# HELP config_flag_${k} Config flag ${k}`);
              lines.push(`# TYPE config_flag_${k} gauge`);
              lines.push(`config_flag_${k} ${v ? 1 : 0}`);
            }
          }
        } catch { }
        // Process metrics
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
          const v = process.versions.node.replace(/"/g, '');
          lines.push('# HELP node_version_info Node.js version info (value is 1)');
          lines.push('# TYPE node_version_info gauge');
          lines.push(`node_version_info{version="${v}"} 1`);
          // App version metric
          lines.push('# HELP app_version Application version (value is 1)');
          lines.push('# TYPE app_version gauge');
          lines.push(`app_version{version="${APP_VERSION}"} 1`);
        } catch { }
        if (!preferHtml || format === 'prom' || format === 'text') {
          res.statusCode = 200; res.setHeader('Content-Type', 'text/plain; version=0.0.4');
          return res.end(lines.join('\n') + '\n');
        }
        const entityRows = (lastSummary?.entities || []).map(e => `<tr><td>${e.entity}${e.fullRefresh ? ' *' : ''}</td><td>${e.pages ?? 0}</td><td>${e.fetched ?? 0}</td><td>${e.processed ?? ((e.lastMax !== undefined || e.newMax !== undefined) ? 'n/a' : 0)}</td><td>${e.upserted ?? 'n/a'}</td><td>${e.total ?? 0}</td><td>${e.softDeleted ?? 'n/a'}</td><td>${(e.lastMax !== undefined || e.newMax !== undefined) ? (e.lastMax || 0) + '->' + (e.newMax || 0) : 'n/a'}</td><td>${human(e.ms || 0)}</td><td>${e.stoppedReason || ''}</td></tr>`).join('');
        res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const extraSummary = lastSummary ? `<p>Time since last run: <strong>${human(Date.now() - Date.parse(lastSummary.end))}</strong> | Success streak: <strong>${lines.find(l => l.startsWith('sync_success_streak'))?.split(' ').pop()}</strong> | Failure streak: <strong>${lines.find(l => l.startsWith('sync_failure_streak'))?.split(' ').pop()}</strong>${nextCronTs ? ` | Next cron: <code>${new Date(nextCronTs).toLocaleString()}</code>` : ''}${nextFullRefreshTs ? ` | Next full refresh: <code>${new Date(nextFullRefreshTs).toLocaleString()}</code>` : ''}</p>` : '';
        return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Metrics</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:4px 6px;font-size:.7rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}pre{background:#181c22;padding:8px;overflow:auto;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}</style></head><body>${h1('Metrics')}<div><a href="/">&larr; Dashboard</a> | <a href="/metrics?format=prom" >Plain Text</a></div><h2>High-level</h2><ul><li>Total Runs: <strong>${totalRuns}</strong></li><li>Total Failures: <strong>${totalFailures}</strong></li><li>Last Duration: <strong>${human(lastDurationMs)}</strong></li><li>In Progress: <strong>${inProgress ? 'yes' : 'no'}</strong></li><li>Last Success: <strong>${lastSummary ? (lastSummary.success ? 'yes' : 'no') : 'n/a'}</strong></li></ul>${extraSummary}<h2>Entities (Last Run)</h2><table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody>${entityRows || '<tr><td colspan=10>No data</td></tr>'}</tbody></table><div style="font-size:.6rem;opacity:.7;margin-top:.3rem;">* full refresh traversal</div><h2>Raw</h2><pre>${lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('\n')}</pre><script>setInterval(()=>{fetch('/metrics?format=prom').then(r=>r.text()).then(t=>{document.querySelector('pre').textContent=t;});},5000);</script></body></html>`);
      })();
    }

    // /sync-summary (latest)
    else if (url.startsWith('/sync-summary')) {
      const wantsJson = url.includes('format=json') || (accept.includes('application/json') && !accept.includes('text/html'));
      const data = getLastSummary(); // Fetch the last summary
      if (wantsJson) { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(data)); }
      const { lastSummary, inProgress } = data;
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!lastSummary) return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sync Summary</title></head><body style="font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;">${h1('Sync Summary')}<p>No completed sync yet. ${inProgress ? 'In progress...' : ''}</p><p><a href="/">&larr; Dashboard</a></p></body></html>`);
      const rows = (lastSummary.entities || []).map((e: any) => { const incr = (e.lastMax !== undefined) || (e.newMax !== undefined) || (e.upserted !== undefined); const proc = e.processed !== undefined ? e.processed : (incr ? 'n/a' : 0); const ups = e.upserted !== undefined ? e.upserted : (incr ? 0 : 'n/a'); const soft = e.softDeleted !== undefined ? e.softDeleted : (incr ? 'n/a' : 0); const range = (e.lastMax !== undefined || e.newMax !== undefined) ? `${e.lastMax || 0}->${e.newMax || 0}` : 'n/a'; return `<tr><td>${e.entity}</td><td>${e.pages || 0}</td><td>${e.fetched || 0}</td><td>${proc}</td><td>${ups}</td><td>${e.total || 0}</td><td>${soft}</td><td>${range}</td><td title="${e.ms} ms">${human(e.ms)}</td><td>${e.stoppedReason || ''}</td></tr>`; }).join('');
      return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Latest Sync Summary</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:6px 8px;font-size:.75rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}</style></head><body>${h1('Latest Sync Summary')}<div>Status: ${lastSummary.success ? '<span style="color:#6cc644">SUCCESS</span>' : '<span style="color:#ff5555">FAIL</span>'}</div><div>Start: <code>${new Date(lastSummary.start).toLocaleString()}</code> | End: <code>${new Date(lastSummary.end).toLocaleString()}</code> | Duration: <code>${human(lastSummary.durationMs || 0)}</code> ${inProgress ? ' | <em>In Progress</em>' : ''}</div>${lastSummary.error ? `<div style=\"color:#ff5555\">Error: ${lastSummary.error}</div>` : ''}<div style="margin-top:.5rem"><a href="/">&larr; Dashboard</a> | <a href="/sync-summary?format=json" >Raw JSON</a> | <a href="/summaries">All Summaries</a></div><table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
    }

    // /summaries list
    else if (url.startsWith('/summaries')) {
      const u = new URL(url, 'http://x');
      const limit = Math.min(200, parseInt(u.searchParams.get('limit') || '25', 10));
      const wantsJson = url.includes('format=json') || (accept.includes('application/json') && !accept.includes('text/html'));
      (async () => {
        try {
          const docs = await SyncSummaryModel.find({}, { entities: 1, start: 1, end: 1, durationMs: 1, success: 1, error: 1 }).sort({ start: -1 }).limit(limit).lean();
          if (wantsJson) { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(docs)); }
          const rows = docs.map(d => { const started = d.start ? new Date(d.start as any).toLocaleString() : ''; const ended = d.end ? new Date(d.end as any).toLocaleString() : ''; return `<tr data-id="${d._id}"><td>${started}</td><td>${ended}</td><td>${human(d.durationMs || 0)}</td><td>${d.success ? '✔' : '✖'}</td><td>${d.error ? String(d.error).substring(0, 40) : ''}</td><td>${(d.entities || []).length}</td></tr>`; }).join('');
          res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sync Summaries</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:6px 8px;font-size:.75rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}tr{cursor:pointer;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}</style></head><body>${h1('Sync Summaries')}<div><a href="/">&larr; Dashboard</a> | <a href="/summaries?format=json" >Raw JSON</a></div><table><thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Success</th><th>Error</th><th>Entities</th></tr></thead><tbody>${rows}</tbody></table><script>document.querySelectorAll('tr[data-id]').forEach(r=>r.addEventListener('click',()=>{window.location='/summary/'+r.getAttribute('data-id');}));</script></body></html>`);
        } catch (e) { res.statusCode = 500; res.end('Error'); }
      })();
    }

    // /summary/:id
    else if (url.startsWith('/summary/')) {
      const id = url.split('/').pop();
      (async () => {
        try {
          const doc = await SyncSummaryModel.findById(id).lean();
          if (!doc) { res.statusCode = 404; return res.end('Not found'); }
          const wantsJson = url.includes('format=json') || (accept.includes('application/json') && !accept.includes('text/html'));
          if (wantsJson) { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(doc)); }
          const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
          const rows = (doc.entities || []).map((e: any) => { const incr = (e.lastMax !== undefined) || (e.newMax !== undefined) || (e.upserted !== undefined); const processed = e.processed !== undefined ? e.processed : (incr ? 'n/a' : 0); const upserted = e.upserted !== undefined ? e.upserted : (incr ? 0 : 'n/a'); const soft = e.softDeleted !== undefined ? e.softDeleted : (incr ? 'n/a' : 0); const range = (e.lastMax !== undefined || e.newMax !== undefined) ? `${e.lastMax || 0}->${e.newMax || 0}` : 'n/a'; return `<tr><td>${esc(e.entity)}</td><td>${e.pages ?? 0}</td><td>${e.fetched ?? 0}</td><td>${processed}</td><td>${upserted}</td><td>${e.total ?? 0}</td><td>${soft}</td><td>${range}</td><td>${human(e.ms || 0)}</td><td>${e.stoppedReason || ''}</td></tr>`; }).join('');
          res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sync Summary ${esc(id || '')}</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.3rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:6px 8px;font-size:.75rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}</style></head><body>${h1('Sync Summary')}<div>ID: <code>${esc(id || '')}</code> | Start: <code>${doc.start ? new Date(doc.start as any).toLocaleString() : ''}</code> | End: <code>${doc.end ? new Date(doc.end as any).toLocaleString() : ''}</code> | Duration: <code>${human(doc.durationMs || 0)}</code> | Success: <strong>${doc.success ? 'yes' : 'no'}</strong></div>${doc.error ? `<div style=\"color:#ff5555\">Error: ${esc(doc.error)} </div>` : ''}<div style="margin-top:.4rem"><a href="/">&larr; Dashboard</a> | <a href="/summary/${esc(id || '')}?format=json" >Raw JSON</a></div><table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
        } catch (e) { res.statusCode = 500; res.end('Error'); }
      })();
    }

    // /trigger-sync (local only)
    else if (url.startsWith('/trigger-sync')) {
      const remote = req.socket.remoteAddress;
      const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      const allowed = isLocal || !!config.metrics.allowRemoteTrigger;
      if (!allowed) { res.statusCode = 403; return res.end('Forbidden'); }
      if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed'); }
      const { inProgress } = getLastSummary();
      if (inProgress) { res.statusCode = 409; return res.end('Sync already in progress'); }
      runSync().then(() => { const { lastSummary } = getLastSummary(); if (lastSummary) noteRun(lastSummary.success, lastSummary.durationMs); }).catch(err => logger.error({ err }, 'Manual sync failed'));
      res.statusCode = 202; return res.end('Sync triggered');
    }

    else {
      res.statusCode = 404; res.end('Not found');
    }
  });
  server.listen(config.metrics.port, () => logger.info({ port: config.metrics.port }, 'Metrics server listening'));
  return server;
}
