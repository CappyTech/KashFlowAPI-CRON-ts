import http from 'node:http';
import logger, { getLogBuffer, logEvents } from '../util/logger.js';
import { getLastSummary, setNextCron, setNextFullRefresh } from '../sync/summary.js';
import { runSync } from '../sync/run.js';
import { SyncSummaryModel, UpsertLogModel } from '../db/models.js';
import { config } from '../config.js';
import { getState } from '../sync/state.js';
// JSON import (tsconfig has resolveJsonModule true)
import pkg from '../../package.json';
const APP_VERSION: string = (pkg as any)?.version || 'dev';

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

export function startMetricsServer() {
  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    // Inject version into all HTML <h1> tags automatically (non-invasive)
    const _end = res.end;
    (res as any).end = function(chunk: any, encoding?: any, cb?: any) {
      try {
        if (typeof chunk === 'string' && chunk.includes('<h1') && !chunk.includes('v'+APP_VERSION)) {
          chunk = chunk.replace(/<h1([^>]*)>([^<]+)/, (m, attrs, text) => `<h1${attrs}>${text} <small style="font-size:.55em;opacity:.65;">v${APP_VERSION}</small>`);
        }
      } catch { /* ignore */ }
      return _end.call(this, chunk, encoding, cb);
    };
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
      return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>KashFlow Sync Dashboard</title><style>
      body{font-family:system-ui,Arial,sans-serif;margin:1.3rem;background:#0f1115;color:#eee;}
      h1{margin:0 0 .75rem;}
      table{border-collapse:collapse;width:100%;margin-top:1rem;}
      th,td{border:1px solid #333;padding:6px 8px;font-size:.8rem;text-align:left;}
      th{background:#1d2229;}
      tbody tr:nth-child(even){background:#181c22;}
      .ok{color:#6cc644;} .fail{color:#ff5555;} .progress{color:#f0ad4e;}
      button{background:#1d2229;color:#eee;border:1px solid #333;padding:6px 10px;border-radius:4px;cursor:pointer;font-size:.75rem;}
      button:hover{background:#242a32;} code{background:#181c22;padding:2px 4px;border-radius:4px;}
      a{color:#6cc6ff;text-decoration:none;} a:hover{text-decoration:underline;}
      </style></head><body>
      <h1>KashFlow Sync Dashboard</h1>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:.5rem;">
        <button id="triggerBtn">Trigger Sync</button>
        <button id="historyBtn">Show History</button>
        <button class="navBtn" data-link="/metrics">Metrics</button>
        <button class="navBtn" data-link="/upserts">Upserts</button>
        <button class="navBtn" data-link="/sync-summary">Latest Summary</button>
        <button class="navBtn" data-link="/summaries">All Summaries</button>
        <button class="navBtn" data-link="/timers">Timers</button>
  <button class="navBtn" data-link="/logs">Logs</button>
  <button class="navBtn" data-link="/logs?format=json">Logs JSON</button>
        <span id="triggerResult" style="align-self:center;font-size:.75rem;"></span>
      </div>
      <div id="status">Loading...</div>
      <div id="timers" style="margin-top:.5rem;font-size:.7rem;opacity:.85;">
        <span id="nextCron">Next cron: calculating...</span> | <span id="nextFull">Next full refresh: calculating...</span>
      </div>
  <table id="entities" style="display:none;"><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody></tbody></table>
  <div id="legend" style="display:none;font-size:.6rem;opacity:.7;margin-top:.25rem;">* full refresh traversal</div>
      <div id="history" style="display:none;margin-top:1rem;">
        <h2 style="margin:0 0 .4rem;font-size:1rem;">Recent Sync History</h2>
        <table id="historyTable"><thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Success</th><th>Error</th><th>Entities</th></tr></thead><tbody></tbody></table>
      </div>
      <p style="margin-top:1rem;font-size:.75rem;">Shortcuts: <a href="/metrics">/metrics</a> · <a href="/sync-summary">/sync-summary</a> · <a href="/summaries">/summaries</a> · <a href="/upserts">/upserts</a> · <a href="/logs">/logs</a></p>
      <div id="miniLogs" style="margin-top:1rem;">
        <h2 style="margin:0 0 .4rem;font-size:1rem;">Live Logs <small id="miniStatus" style="opacity:.7"></small></h2>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.4rem;">
          <button id="miniShowBtn">Show</button>
          <button id="miniPauseBtn">Pause</button>
          <button id="miniClearBtn">Clear</button>
          <button id="miniDownloadBtn">Download Tail</button>
        </div>
        <pre id="miniLog" style="display:none;max-height:240px;overflow:auto;background:#181c22;padding:6px;border-radius:4px;"></pre>
      </div>
      <script>
      async function fetchJson(u){const r=await fetch(u,{headers:{Accept:'application/json'}});const t=await r.text();if(!r.ok)throw new Error('HTTP '+r.status+' '+t.slice(0,80));try{return JSON.parse(t);}catch(e){throw new Error('Parse '+u);}}
      function human(ms){if(ms<1000)return ms+' ms';const s=ms/1000;if(s<60)return s.toFixed(s<10?2:1)+' s';const m=Math.floor(s/60),sec=Math.floor(s%60),rem=ms%1000;if(s<3600)return m+'m '+sec+'s'+(rem?' '+rem+'ms':'');const h=Math.floor(m/60),mm=m%60;return h+'h '+mm+'m '+sec+'s';}
  async function load(){
    try {
      const data = await fetchJson('/sync-summary?format=json');
      // Set timers from summary payload if present (fast path)
      try {
        if (data.nextCronTs) document.getElementById('nextCron').dataset.ts = String(data.nextCronTs);
        if (data.nextFullRefreshTs) document.getElementById('nextFull').dataset.ts = String(data.nextFullRefreshTs);
      } catch(_){}
      const status = document.getElementById('status');
      const tbl = document.getElementById('entities');
      if (!data.lastSummary) {
        status.innerHTML = '<span class="progress">No completed sync yet.</span>' + (data.inProgress ? ' <span class=progress>(sync running)</span>' : '');
        tbl.style.display = 'none';
        document.getElementById('legend').style.display = 'none';
      } else {
        const s = data.lastSummary;
        status.innerHTML = 'Last Sync: ' + (s.success ? '<span class=ok>SUCCESS</span>' : '<span class=fail>FAIL</span>') + ' | Start: <code>' + new Date(s.start).toLocaleString() + '</code> | End: <code>' + new Date(s.end).toLocaleString() + '</code> | Duration: <code title="' + s.durationMs + ' ms">' + human(s.durationMs) + '</code>' + (data.inProgress ? ' | <span class=progress>Current sync running...</span>' : '') + (s.error ? '<br/><small style="color:#ff5555">' + s.error.replace(/</g,'&lt;') + '</small>' : '');
        const body = tbl.querySelector('tbody');
        body.innerHTML='';
        let anyFull=false;
        (s.entities||[]).forEach(e=>{
          const tr=document.createElement('tr');
            function td(v){const d=document.createElement('td');d.textContent=v;return d;}
            const incr=(e.lastMax!==undefined)||(e.newMax!==undefined)||(e.upserted!==undefined);
            const processed=e.processed!==undefined?e.processed:(incr?'n/a':0);
            const upserted=e.upserted!==undefined?e.upserted:(incr?0:'n/a');
            const soft=e.softDeleted!==undefined?e.softDeleted:(incr?'n/a':0);
            const range=(e.lastMax!==undefined||e.newMax!==undefined)?(e.lastMax||0)+'->'+(e.newMax||0):'n/a';
            const nameCell=(e.entity||'')+(e.fullRefresh?' *':'');
            if(e.fullRefresh) anyFull=true;
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
        tbl.style.display='table';
        document.getElementById('legend').style.display= anyFull ? 'block':'none';
      }
    } catch(e) {
      document.getElementById('status').innerHTML='<span class=fail>Error loading:</span> '+e.message;
    }
    // Timers fetch (independent) with immediate update
    try {
      const timers = await fetchJson('/timers');
      const nextCronEl=document.getElementById('nextCron');
      const nextFullEl=document.getElementById('nextFull');
      if (timers.cronEnabled===false) {
        nextCronEl.textContent='Cron disabled';
        delete nextCronEl.dataset.ts;
      } else if (timers.nextCronTs) {
        nextCronEl.dataset.ts=String(timers.nextCronTs);
      }
      if (timers.nextFullRefreshTs) { nextFullEl.dataset.ts=String(timers.nextFullRefreshTs); }
      tickTimers(); // immediate update
    } catch(e) {
      setTimeout(()=>{ if(!document.getElementById('nextCron').dataset.ts) attemptTimersRetry(); }, 2000);
    }
  }
  let timersRetryCount=0;
  async function attemptTimersRetry(){
    if (document.getElementById('nextCron').dataset.ts) return; // already resolved
    if (timersRetryCount>5) return; // give up after a few silent retries
    timersRetryCount++;
    try { const timers=await fetchJson('/timers'); const nC=document.getElementById('nextCron'); const nF=document.getElementById('nextFull'); if (timers.cronEnabled===false){ nC.textContent='Cron disabled'; delete nC.dataset.ts; return; } if(timers.nextCronTs){ nC.dataset.ts=String(timers.nextCronTs);} if(timers.nextFullRefreshTs){ nF.dataset.ts=String(timers.nextFullRefreshTs);} tickTimers(); } catch(e){ setTimeout(attemptTimersRetry, 2000); }
  }
  function tickTimers(){const now=Date.now();const OVERDUE_MS=60000;function fmt(diff){if(diff<=0)return 'due';const s=Math.floor(diff/1000);if(s<60)return s+'s';const m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';const h=Math.floor(m/60);return h+'h '+(m%60)+'m';}const nC=document.getElementById('nextCron');const nF=document.getElementById('nextFull');if(nC&&nC.dataset.ts){const diff=parseInt(nC.dataset.ts)-now;nC.textContent='Next cron: '+fmt(diff);nC.style.color= diff<=0 && Math.abs(diff)>OVERDUE_MS ? '#ff5555':'inherit';}if(nF&&nF.dataset.ts){const diff=parseInt(nF.dataset.ts)-now;nF.textContent='Next full refresh: '+fmt(diff);nF.style.color= diff<=0 ? '#f0ad4e':'inherit';} }
  setInterval(tickTimers,1000);
      async function loadHistory(){try{const list=await fetchJson('/summaries?limit=25&format=json');const body=document.querySelector('#historyTable tbody');body.innerHTML='';list.forEach(s=>{const tr=document.createElement('tr');function td(v){const d=document.createElement('td');d.textContent=v;return d;}tr.appendChild(td(new Date(s.start).toLocaleString()));tr.appendChild(td(new Date(s.end).toLocaleString()));tr.appendChild(td(human(s.durationMs)));tr.appendChild(td(s.success?'✔':'✖'));tr.appendChild(td(s.error? s.error.substring(0,40):''));tr.appendChild(td((s.entities||[]).length));tr.style.cursor='pointer';tr.addEventListener('click',()=>{window.open('/summary/'+s._id,'_blank');});body.appendChild(tr);});}catch(e){const body=document.querySelector('#historyTable tbody');body.innerHTML='<tr><td colspan=6>Error: '+e.message+'</td></tr>';}}
      load();setInterval(load,5000);
      document.getElementById('triggerBtn').addEventListener('click',async(ev)=>{const out=document.getElementById('triggerResult');out.textContent='Triggering...';try{const r=await fetch('/trigger-sync',{method:'POST'});const txt=await r.text();out.textContent=r.ok?'Started: '+txt:'Failed: '+txt;}catch(e){out.textContent='Error:'+e.message;} });
      // Mini logs widget
      (function(){
        const miniLogEl=document.getElementById('miniLog');
        const miniStatus=document.getElementById('miniStatus');
        const miniShowBtn=document.getElementById('miniShowBtn');
        const miniPauseBtn=document.getElementById('miniPauseBtn');
        const miniClearBtn=document.getElementById('miniClearBtn');
        const miniDownloadBtn=document.getElementById('miniDownloadBtn');
        let miniShown=false, miniPaused=false, miniCount=0; let miniSSE=null;
        function miniSetStatus(){ miniStatus.textContent=(miniShown?'[VISIBLE] ':'[HIDDEN] ')+(miniPaused?'[PAUSED] ':'')+miniCount+' entries'; }
        function miniSafeStringify(obj){ const seen=new WeakSet(); try { return JSON.stringify(obj, (k,v)=>{ if(typeof v==='object'&&v){ if(seen.has(v)) return '[Circular]'; seen.add(v);} return v; }); } catch(_) { return String(obj); } }
        function miniLine(r){ const ts=r&&r.ts? new Date(r.ts).toLocaleTimeString(): new Date().toLocaleTimeString(); const m=(r&&r.msg)? r.msg: ''; let d=''; if(r&&r.data!=null){ d=' '+miniSafeStringify(r.data);} if(!m&&!d){ try{ d=' '+miniSafeStringify(r);}catch(_){}} return '['+ts+'] '+m+d; }
        function miniAppend(t){ if(!t||!miniShown||miniPaused) return; miniLogEl.textContent+=t+'\n'; miniLogEl.scrollTop=miniLogEl.scrollHeight; miniCount++; miniSetStatus(); }
        async function miniDownload(){ try { const r=await fetch('/logs?format=json'); const list=await r.json(); const blob=new Blob([JSON.stringify(list,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='logs-tail.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000); } catch(e){ miniAppend('[download] Error '+e.message); } }
        async function miniInit(){ try { const r=await fetch('/logs?format=json'); const list=await r.json(); (list||[]).slice(-50).forEach(rec=> miniAppend(miniLine(rec))); } catch(_){ /* ignore */ } miniSSE=new EventSource('/logs/stream'); miniSSE.onmessage=(ev)=>{ try{ const rec=JSON.parse(ev.data); miniAppend(miniLine(rec)); }catch(_){ } }; }
        miniShowBtn.addEventListener('click',()=>{ miniShown=!miniShown; miniLogEl.style.display=miniShown?'block':'none'; miniShowBtn.textContent=miniShown?'Hide':'Show'; miniSetStatus(); if(miniShown && !miniSSE) miniInit(); });
        miniPauseBtn.addEventListener('click',()=>{ miniPaused=!miniPaused; miniPauseBtn.textContent=miniPaused?'Resume':'Pause'; miniSetStatus(); });
        miniClearBtn.addEventListener('click',()=>{ miniLogEl.textContent=''; miniCount=0; miniSetStatus(); });
        miniDownloadBtn.addEventListener('click', miniDownload);
        miniSetStatus();
      })();
      const histBtn=document.getElementById('historyBtn');const histDiv=document.getElementById('history');histBtn.addEventListener('click',async()=>{if(histDiv.style.display==='none'){histDiv.style.display='block';histBtn.textContent='Hide History';await loadHistory();}else{histDiv.style.display='none';histBtn.textContent='Show History';}});
      // Simple same-tab navigation (no popups)
      document.querySelectorAll('.navBtn').forEach(b=>b.addEventListener('click',()=>{
        const l=b.getAttribute('data-link');
        if(l) window.location.href = l;
      }));
      </script></body></html>`);
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
        lines.push(`sync_now_timestamp_seconds ${Math.floor(nowMs/1000)}`);
        if (lastSummary) {
          const startTs = Date.parse(lastSummary.start);
            const endTs = Date.parse(lastSummary.end);
            lines.push('# HELP sync_last_start_timestamp_seconds Start time of last sync');
            lines.push('# TYPE sync_last_start_timestamp_seconds gauge');
            lines.push(`sync_last_start_timestamp_seconds ${Math.floor(startTs/1000)}`);
            lines.push('# HELP sync_last_end_timestamp_seconds End time of last sync');
            lines.push('# TYPE sync_last_end_timestamp_seconds gauge');
            lines.push(`sync_last_end_timestamp_seconds ${Math.floor(endTs/1000)}`);
            lines.push('# HELP sync_time_since_last_success_seconds Seconds since last sync finished');
            lines.push('# TYPE sync_time_since_last_success_seconds gauge');
            lines.push(`sync_time_since_last_success_seconds ${(nowMs - endTs)/1000}`);
        }
        if (nextCronTs) {
          lines.push('# HELP sync_next_cron_timestamp_seconds Next cron fire (predicted)');
          lines.push('# TYPE sync_next_cron_timestamp_seconds gauge');
          lines.push(`sync_next_cron_timestamp_seconds ${Math.floor(nextCronTs/1000)}`);
        }
        if (nextFullRefreshTs) {
          lines.push('# HELP sync_next_full_refresh_timestamp_seconds Next full refresh timestamp');
            lines.push('# TYPE sync_next_full_refresh_timestamp_seconds gauge');
            lines.push(`sync_next_full_refresh_timestamp_seconds ${Math.floor(nextFullRefreshTs/1000)}`);
        }
        // Last full refresh state
        try {
          const lastFull = await getState<number>('incremental:lastFullRefreshTs');
          if (lastFull) {
            lines.push('# HELP sync_last_full_refresh_timestamp_seconds Last full refresh (incrementals)');
            lines.push('# TYPE sync_last_full_refresh_timestamp_seconds gauge');
            lines.push(`sync_last_full_refresh_timestamp_seconds ${Math.floor(lastFull/1000)}`);
          }
        } catch {}
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
              const reason = String(e.stoppedReason).replace(/"/g,'');
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
          const recent = await SyncSummaryModel.find({}, { durationMs:1, success:1 }).sort({ start:-1 }).limit(50).lean();
          if (recent.length) {
            const durations = recent.map(r=>r.durationMs).filter(Boolean) as number[];
            if (durations.length) {
              const avg = durations.reduce((a,b)=>a+b,0)/durations.length;
              const sorted = [...durations].sort((a,b)=>a-b);
              const p95 = sorted[Math.min(sorted.length-1, Math.floor(0.95*sorted.length)-1)];
              lines.push('# HELP sync_recent_avg_duration_ms Mean duration (last 50 runs)');
              lines.push('# TYPE sync_recent_avg_duration_ms gauge');
              lines.push(`sync_recent_avg_duration_ms ${avg}`);
              lines.push('# HELP sync_recent_p95_duration_ms 95th percentile duration (last 50 runs)');
              lines.push('# TYPE sync_recent_p95_duration_ms gauge');
              lines.push(`sync_recent_p95_duration_ms ${p95}`);
            }
            // Success / failure streaks
            let successStreak=0, failureStreak=0;
            for (const r of recent) { if (r.success) { if (failureStreak===0) successStreak++; else break; } else { if (successStreak===0) failureStreak++; else break; } }
            lines.push('# HELP sync_success_streak Current consecutive success count');
            lines.push('# TYPE sync_success_streak gauge');
            lines.push(`sync_success_streak ${successStreak}`);
            lines.push('# HELP sync_failure_streak Current consecutive failure count');
            lines.push('# TYPE sync_failure_streak gauge');
            lines.push(`sync_failure_streak ${failureStreak}`);
          }
        } catch {}
        // Upsert logs last hour per entity (approx activity rate)
        try {
          const since = new Date(Date.now() - 3600_000);
          const entities = ['customers','suppliers','invoices','quotes','projects','purchases'];
          for (const ent of entities) {
            const c = await UpsertLogModel.countDocuments({ entity: ent, ts: { $gte: since } });
            lines.push(`# HELP upsert_logs_hour_total Upsert log entries in the last hour per entity`);
            lines.push('# TYPE upsert_logs_hour_total gauge');
            lines.push(`upsert_logs_hour_total{entity="${ent}"} ${c}`);
          }
        } catch {}
        // Config flags (boolean only)
        try {
          const flags = config.flags || {} as Record<string, any>;
          for (const [k,v] of Object.entries(flags)) {
            if (typeof v === 'boolean') {
              lines.push(`# HELP config_flag_${k} Config flag ${k}`);
              lines.push(`# TYPE config_flag_${k} gauge`);
              lines.push(`config_flag_${k} ${v?1:0}`);
            }
          }
        } catch {}
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
          const v = process.versions.node.replace(/"/g,'');
          lines.push('# HELP node_version_info Node.js version info (value is 1)');
          lines.push('# TYPE node_version_info gauge');
          lines.push(`node_version_info{version="${v}"} 1`);
          // App version metric
          lines.push('# HELP app_version Application version (value is 1)');
          lines.push('# TYPE app_version gauge');
          lines.push(`app_version{version="${APP_VERSION}"} 1`);
        } catch {}
        if (!preferHtml || format === 'prom' || format === 'text') {
          res.statusCode = 200; res.setHeader('Content-Type', 'text/plain; version=0.0.4');
          return res.end(lines.join('\n') + '\n');
        }
        const entityRows = (lastSummary?.entities || []).map(e => `<tr><td>${e.entity}${e.fullRefresh?' *':''}</td><td>${e.pages ?? 0}</td><td>${e.fetched ?? 0}</td><td>${e.processed ?? ( (e.lastMax!==undefined||e.newMax!==undefined)?'n/a':0)}</td><td>${e.upserted ?? 'n/a'}</td><td>${e.total ?? 0}</td><td>${e.softDeleted ?? 'n/a'}</td><td>${(e.lastMax !== undefined || e.newMax !== undefined) ? (e.lastMax || 0) + '->' + (e.newMax || 0) : 'n/a'}</td><td>${human(e.ms || 0)}</td><td>${e.stoppedReason || ''}</td></tr>`).join('');
        res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const extraSummary = lastSummary ? `<p>Time since last run: <strong>${human(Date.now()-Date.parse(lastSummary.end))}</strong> | Success streak: <strong>${lines.find(l=>l.startsWith('sync_success_streak'))?.split(' ').pop()}</strong> | Failure streak: <strong>${lines.find(l=>l.startsWith('sync_failure_streak'))?.split(' ').pop()}</strong>${nextCronTs?` | Next cron: <code>${new Date(nextCronTs).toLocaleString()}</code>`:''}${nextFullRefreshTs?` | Next full refresh: <code>${new Date(nextFullRefreshTs).toLocaleString()}</code>`:''}</p>` : '';
        return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Metrics</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:4px 6px;font-size:.7rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}pre{background:#181c22;padding:8px;overflow:auto;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}</style></head><body><h1>Metrics</h1><div><a href="/">&larr; Dashboard</a> | <a href="/metrics?format=prom" >Plain Text</a></div><h2>High-level</h2><ul><li>Total Runs: <strong>${totalRuns}</strong></li><li>Total Failures: <strong>${totalFailures}</strong></li><li>Last Duration: <strong>${human(lastDurationMs)}</strong></li><li>In Progress: <strong>${inProgress ? 'yes' : 'no'}</strong></li><li>Last Success: <strong>${lastSummary ? (lastSummary.success ? 'yes' : 'no') : 'n/a'}</strong></li></ul>${extraSummary}<h2>Entities (Last Run)</h2><table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody>${entityRows || '<tr><td colspan=10>No data</td></tr>'}</tbody></table><div style="font-size:.6rem;opacity:.7;margin-top:.3rem;">* full refresh traversal</div><h2>Raw</h2><pre>${lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('\n')}</pre><script>setInterval(()=>{fetch('/metrics?format=prom').then(r=>r.text()).then(t=>{document.querySelector('pre').textContent=t;});},5000);</script></body></html>`);
      })();
    }

    // /sync-summary (latest)
    else if (url.startsWith('/sync-summary')) {
      const wantsJson = url.includes('format=json') || (accept.includes('application/json') && !accept.includes('text/html'));
      const data = getLastSummary(); // Fetch the last summary
      if (wantsJson) { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(data)); }
      const { lastSummary, inProgress } = data;
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!lastSummary) return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sync Summary</title></head><body style="font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;"><h1>Sync Summary</h1><p>No completed sync yet. ${inProgress ? 'In progress...' : ''}</p><p><a href="/">&larr; Dashboard</a></p></body></html>`);
      const rows = (lastSummary.entities || []).map((e: any) => { const incr = (e.lastMax !== undefined) || (e.newMax !== undefined) || (e.upserted !== undefined); const proc = e.processed !== undefined ? e.processed : (incr ? 'n/a' : 0); const ups = e.upserted !== undefined ? e.upserted : (incr ? 0 : 'n/a'); const soft = e.softDeleted !== undefined ? e.softDeleted : (incr ? 'n/a' : 0); const range = (e.lastMax !== undefined || e.newMax !== undefined) ? `${e.lastMax || 0}->${e.newMax || 0}` : 'n/a'; return `<tr><td>${e.entity}</td><td>${e.pages || 0}</td><td>${e.fetched || 0}</td><td>${proc}</td><td>${ups}</td><td>${e.total || 0}</td><td>${soft}</td><td>${range}</td><td title="${e.ms} ms">${human(e.ms)}</td><td>${e.stoppedReason || ''}</td></tr>`; }).join('');
      return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Latest Sync Summary</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:6px 8px;font-size:.75rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}</style></head><body><h1>Latest Sync Summary</h1><div>Status: ${lastSummary.success ? '<span style="color:#6cc644">SUCCESS</span>' : '<span style="color:#ff5555">FAIL</span>'}</div><div>Start: <code>${new Date(lastSummary.start).toLocaleString()}</code> | End: <code>${new Date(lastSummary.end).toLocaleString()}</code> | Duration: <code>${human(lastSummary.durationMs || 0)}</code> ${inProgress ? ' | <em>In Progress</em>' : ''}</div>${lastSummary.error ? `<div style="color:#ff5555">Error: ${lastSummary.error}</div>` : ''}<div style="margin-top:.5rem"><a href="/">&larr; Dashboard</a> | <a href="/sync-summary?format=json" >Raw JSON</a> | <a href="/summaries">All Summaries</a></div><table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
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
          return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sync Summaries</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:6px 8px;font-size:.75rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}tr{cursor:pointer;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}</style></head><body><h1>Sync Summaries</h1><div><a href="/">&larr; Dashboard</a> | <a href="/summaries?format=json" >Raw JSON</a></div><table><thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Success</th><th>Error</th><th>Entities</th></tr></thead><tbody>${rows}</tbody></table><script>document.querySelectorAll('tr[data-id]').forEach(r=>r.addEventListener('click',()=>{window.location='/summary/'+r.getAttribute('data-id');}));</script></body></html>`);
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
          return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sync Summary ${esc(id || '')}</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.3rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:6px 8px;font-size:.75rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}</style></head><body><h1>Sync Summary</h1><div>ID: <code>${esc(id || '')}</code> | Start: <code>${doc.start ? new Date(doc.start as any).toLocaleString() : ''}</code> | End: <code>${doc.end ? new Date(doc.end as any).toLocaleString() : ''}</code> | Duration: <code>${human(doc.durationMs || 0)}</code> | Success: <strong>${doc.success ? 'yes' : 'no'}</strong></div>${doc.error ? `<div style=\"color:#ff5555\">Error: ${esc(doc.error)} </div>` : ''}<div style="margin-top:.4rem"><a href="/">&larr; Dashboard</a> | <a href="/summary/${esc(id || '')}?format=json" >Raw JSON</a></div><table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
        } catch (e) { res.statusCode = 500; res.end('Error'); }
      })();
    }

    // /upserts
    else if (url.startsWith('/upserts')) {
      const u = new URL(url, 'http://x');
      const limit = Math.min(500, parseInt(u.searchParams.get('limit') || '100', 10));
      const entity = u.searchParams.get('entity') || undefined;
      const op = u.searchParams.get('op') || undefined; // insert/update
      const runId = u.searchParams.get('runId') || undefined;
      const sinceParam = u.searchParams.get('since');
      const wantsJson = url.includes('format=json') || (accept.includes('application/json') && !accept.includes('text/html'));
      const query: any = {};
      if (entity) query.entity = entity;
      if (op) query.op = op;
      if (runId) query.runId = runId;
      if (sinceParam) {
        if (/^\d+$/.test(sinceParam)) { const mins = parseInt(sinceParam, 10); query.ts = { $gte: new Date(Date.now() - mins * 60000) }; }
        else { const d = new Date(sinceParam); if (!isNaN(d.getTime())) query.ts = { $gte: d }; }
      }
      (async () => {
        try {
          const docs = await UpsertLogModel.find(query).sort({ ts: -1 }).limit(limit).lean();
          if (wantsJson) { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(docs)); }
          const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
          const formatVal = (v: any) => {
            if (v === undefined) return '<em style="color:#666">undefined</em>';
            if (v === null) return '<em style="color:#666">null</em>';
            if (typeof v === 'string') {
              const escStr = esc(v);
              return escStr.length > 160 ? escStr.slice(0, 160) + '…' : escStr;
            }
            try { const j = esc(JSON.stringify(v)); return j.length > 160 ? j.slice(0, 160) + '…' : j; } catch { return esc(String(v)); }
          };
          const buildDiffTable = (changes: any) => {
            const keys = Object.keys(changes || {});
            if (!keys.length) return '<div style="font-size:.65rem;color:#888">(no field-level changes captured)</div>';
            return `<table class="diffTable"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${keys.map(k => {
              const c = changes[k] || {}; const before = c.before; const after = c.after;
              const cls = before === after ? '' : (before === undefined ? 'added' : (after === undefined ? 'removed' : 'changed'));
              return `<tr class="${cls}"><td>${esc(k)}</td><td>${formatVal(before)}</td><td>${formatVal(after)}</td></tr>`;
            }).join('')}</tbody></table>`;
          };
          const rows = (docs || []).map(d => {
            const ts = d.ts ? new Date(d.ts as any).toLocaleString() : '';
            const changedPreviewArr = (d.changedFields || []).slice(0, 4);
            const changedPreview = esc(changedPreviewArr.join(', ')) + ((d.changedFields || []).length > 4 ? '…' : '');
            const diffHtml = buildDiffTable(d.changes || {});
            return `<tr data-row="main"><td>${ts}</td><td>${esc(d.entity || '')}</td><td>${esc(d.key || '')}</td><td>${esc(d.op || '')}</td><td>${esc(d.runId || '')}</td><td>${d.modifiedCount ?? ''}</td><td>${changedPreview}</td><td><button class="diff-btn" data-id="${d._id}">View</button></td></tr><tr id="diff-${d._id}" class="diff" style="display:none"><td colspan="8">${diffHtml}</td></tr>`;
          }).join('') || '<tr><td colspan="8">No records</td></tr>';
          res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Upsert Logs</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:4px 6px;font-size:.7rem;vertical-align:top;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}form{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem;}label{font-size:.65rem;display:flex;flex-direction:column;gap:2px;}input,select{background:#181c22;border:1px solid #333;color:#eee;padding:4px 6px;border-radius:4px;font-size:.7rem;}button{background:#2a2f38;color:#eee;border:1px solid #444;padding:3px 8px;border-radius:4px;cursor:pointer;}button:hover{background:#353c47;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}table.diffTable{width:auto;margin:.4rem 0;font-size:.65rem;}table.diffTable th,table.diffTable td{border:1px solid #2d323a;padding:2px 4px;}table.diffTable tr.changed{background:#2d2530;}table.diffTable tr.added{background:#1e3524;}table.diffTable tr.removed{background:#35241e;}tr.diff td{background:#14171d;} .diff-btn{min-width:48px;} .diff-btn.open{background:#444;} .sticky{position:sticky;top:0;background:#0f1115;} .flash{animation:flash 1s ease-in-out;}@keyframes flash{0%{background:#264;}100%{background:transparent;}}</style></head><body><h1>Upsert Logs</h1><div><a href="/">&larr; Dashboard</a> | <a href="/upserts?format=json${entity ? `&entity=${encodeURIComponent(entity)}` : ''}${op ? `&op=${encodeURIComponent(op)}` : ''}${runId ? `&runId=${encodeURIComponent(runId)}` : ''}${sinceParam ? `&since=${encodeURIComponent(sinceParam)}` : ''}${limit !== 100 ? `&limit=${limit}` : ''}">Raw JSON</a></div><form method="GET" action="/upserts"><label>Entity<select name="entity"><option value="">(all)</option>${['customers', 'suppliers', 'purchases', 'invoices', 'quotes', 'projects'].map(e => `<option value="${e}"${entity === e ? ' selected' : ''}>${e}</option>`).join('')}</select></label><label>Op<select name="op"><option value="">(all)</option><option value="insert"${op === 'insert' ? ' selected' : ''}>insert</option><option value="update"${op === 'update' ? ' selected' : ''}>update</option></select></label><label>Run ID<input name="runId" value="${esc(runId || '')}" placeholder="ISO runId"/></label><label>Since (mins/ISO)<input name="since" value="${esc(sinceParam || '')}" placeholder="60"/></label><label>Limit<input type="number" name="limit" min="1" max="500" value="${limit}"/></label><button type="submit">Filter</button></form><table><thead><tr><th>Time</th><th>Entity</th><th>Key</th><th>Op</th><th>RunId</th><th>Mod</th><th>Changed Fields</th><th>Diff</th></tr></thead><tbody>${rows}</tbody></table><script>(function(){function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');}function fmt(v){if(v===undefined)return '<em style=\"color:#666\">undefined</em>';if(v===null)return '<em style=\"color:#666\">null</em>';if(typeof v==='string'){var e=esc(v);return e.length>160?e.slice(0,160)+'…':e;}try{var j=esc(JSON.stringify(v));return j.length>160?j.slice(0,160)+'…':j;}catch{return esc(String(v));}}function diffTable(changes){var k=Object.keys(changes||{});if(!k.length)return '<div style=\"font-size:.65rem;color:#888\">(no field-level changes captured)</div>';return '<table class=\"diffTable\"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>'+k.map(function(f){var c=changes[f]||{};var before=c.before;var after=c.after;var cls=(before===after)?'':(before===undefined?'added':(after===undefined?'removed':'changed'));return '<tr class=\"'+cls+'\"><td>'+esc(f)+'</td><td>'+fmt(before)+'</td><td>'+fmt(after)+'</td></tr>';}).join('')+'</tbody></table>';}
function buildRows(list){return (list||[]).map(function(d){var ts=d.ts?new Date(d.ts).toLocaleString():'';var changedPrev=(d.changedFields||[]).slice(0,4).join(', ')+(((d.changedFields||[]).length>4)?'…':'');var diffHtml=diffTable(d.changes||{});return '<tr data-row=\"main\"><td>'+ts+'</td><td>'+(d.entity||'')+'</td><td>'+(d.key||'')+'</td><td>'+(d.op||'')+'</td><td>'+(d.runId||'')+'</td><td>'+(d.modifiedCount||'')+'</td><td>'+changedPrev+'</td><td><button class=\"diff-btn\" data-id=\"'+d._id+'\">View</button></td></tr><tr id=\"diff-'+d._id+'\" class=\"diff\" style=\"display:none\"><td colspan=\"8\">'+diffHtml+'</td></tr>';}).join('')||'<tr><td colspan=\"8\">No records</td></tr>';}
const tableBody=document.querySelector('table tbody');
function refresh(){var p=new URL(window.location.href);if(p.searchParams.get('runId'))return;var openIds=[].slice.call(document.querySelectorAll('tr.diff')).filter(function(r){return r.style.display!=='none';}).map(function(r){return r.id;});var jsonUrl=p.pathname+p.search+(p.search?'&':'?')+'format=json';fetch(jsonUrl).then(r=>r.json()).then(list=>{tableBody.innerHTML=buildRows(list);openIds.forEach(function(rowId){var row=document.getElementById(rowId);if(row){row.style.display='table-row';var id=rowId.replace(/^diff-/,'');var btn=document.querySelector('button.diff-btn[data-id="'+id+'"]');if(btn){btn.textContent='Hide';btn.classList.add('open');}}});}).catch(()=>{});}setInterval(refresh,15000);document.addEventListener('click',function(e){var t=e.target; if(!t) return; if(t.getAttribute && t.getAttribute('data-id') && t.classList.contains('diff-btn')){var id=t.getAttribute('data-id');var row=document.getElementById('diff-'+id); if(row){var open=row.style.display!=='none';row.style.display=open?'none':'table-row';t.textContent=open?'View':'Hide';t.classList.toggle('open',!open);} }});})();</script></body></html>`);
        } catch (e) { res.statusCode = 500; res.end('Error'); }
      })();
    }

    // /timers (JSON only)
    else if (url.startsWith('/timers')) {
      const u = new URL(url, 'http://x');
      const wantsJson = u.searchParams.get('format') === 'json' || accept.includes('application/json');
      (async () => {
        let { nextCronTs, nextFullRefreshTs, inProgress } = getLastSummary() as any;
        const cronEnabled = !!config.flags.cronEnabled;
        // Predict cron if enabled and not yet set
        if (cronEnabled && !nextCronTs) {
          try { const parserMod: any = await import('cron-parser'); const it = parserMod.parseExpression(config.cron, { currentDate: new Date() }); nextCronTs = it.next().getTime(); setNextCron(nextCronTs); } catch (e) { }
        }
        // Predict next full refresh if not set (based on last full refresh state value)
        if (!nextFullRefreshTs) {
          try {
            const fullRefreshHours = config.flags.fullRefreshHours || 24;
            const lastFull = (await getState<number>('incremental:lastFullRefreshTs')) || 0;
            const target = lastFull ? (lastFull + fullRefreshHours * 3600_000) : Date.now();
            nextFullRefreshTs = target; setNextFullRefresh(target);
          } catch {}
        }
        const now = Date.now();
        const OVERDUE_THRESHOLD_MS = 60_000;
        const data = { now, cronEnabled, nextCronTs: cronEnabled ? (nextCronTs || null) : null, nextCronInMs: (cronEnabled && nextCronTs) ? (nextCronTs - now) : null, cronOverdue: (cronEnabled && nextCronTs) ? (now - nextCronTs) > OVERDUE_THRESHOLD_MS : null, nextFullRefreshTs: nextFullRefreshTs || null, nextFullRefreshInMs: nextFullRefreshTs ? (nextFullRefreshTs - now) : null, fullRefreshDue: nextFullRefreshTs ? now >= nextFullRefreshTs : null, inProgress };
        if (wantsJson) {
          res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(data));
        }
        res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Timers</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}h1{margin:0 0 .75rem;}table{border-collapse:collapse;}td{padding:4px 8px;border:1px solid #333;font-size:.75rem;}a{color:#6cc6ff;text-decoration:none;}</style></head><body><h1>Timers</h1><p><a href="/">&larr; Dashboard</a></p><table><tbody><tr><td>Now</td><td>${new Date(data.now).toLocaleString()}</td></tr><tr><td>Next Cron</td><td>${cronEnabled ? (data.nextCronTs ? new Date(data.nextCronTs).toLocaleString() : '(unknown)') : 'Cron disabled'}${data.cronOverdue ? ' <span style="color:#ff5555">OVERDUE</span>' : ''}</td></tr><tr><td>Next Full Refresh</td><td>${data.nextFullRefreshTs ? new Date(data.nextFullRefreshTs).toLocaleString() : '(unknown)'}${data.fullRefreshDue ? ' <span style="color:#f0ad4e">DUE</span>' : ''}</td></tr><tr><td>In Progress</td><td>${data.inProgress ? 'yes' : 'no'}</td></tr></tbody></table><pre style="background:#181c22;padding:6px;margin-top:1rem;">${JSON.stringify(data, null, 2).replace(/</g, '&lt;')}</pre></body></html>`);
      })();
    }

    // /logs (tail JSON) and /logs/stream (SSE)
    else if (url.startsWith('/logs')) {
      if (url.startsWith('/logs/stream')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        // send initial tail
        const tail = getLogBuffer(200);
        for (const r of tail) {
          res.write(`data: ${JSON.stringify(r)}\n\n`);
        }
        const onLog = (rec: any) => {
          try { res.write(`data: ${JSON.stringify(rec)}\n\n`); } catch { }
        };
        logEvents.on('log', onLog);
        req.on('close', () => { logEvents.off('log', onLog); });
        return; // keep connection open
      }
      const wantsJson = url.includes('format=json') || (accept.includes('application/json') && !accept.includes('text/html'));
      if (wantsJson) {
        res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(getLogBuffer(200)));
      }
      // Simple HTML viewer (improved rendering)
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Logs</title><style>body{font-family:system-ui,Arial;background:#0f1115;color:#eee;margin:1.2rem;}pre{background:#181c22;padding:8px;border-radius:6px;max-height:70vh;overflow:auto;}#log{white-space:pre-wrap;}button{background:#1d2229;color:#eee;border:1px solid #333;padding:4px 8px;margin-right:6px;border-radius:4px;font-size:.7rem;cursor:pointer;}button:hover{background:#242a32;}small{opacity:.7;}#actions{margin:.5rem 0 .75rem;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;}#statusLine{font-size:.65rem;}</style></head><body><h1>Live Logs</h1><div><a href="/">&larr; Dashboard</a> | <a href="/logs?format=json" target>Raw JSON</a></div><div id="actions"><button id="pauseBtn">Pause</button><button id="clearBtn">Clear</button><button id="triggerBtn">Trigger Sync</button><button id="downloadBtn">Download Tail</button><span id="statusLine"></span></div><pre id="log"></pre><script>(function(){const el=document.getElementById('log');const pauseBtn=document.getElementById('pauseBtn');const clearBtn=document.getElementById('clearBtn');const triggerBtn=document.getElementById('triggerBtn');const downloadBtn=document.getElementById('downloadBtn');const statusLine=document.getElementById('statusLine');let paused=false;let received=0;function setStatus(){statusLine.textContent=(paused?'[PAUSED] ':'')+received+' entries';}function safeStringify(obj){const seen=new WeakSet();try{return JSON.stringify(obj,function(k,v){if(typeof v==='object'&&v!==null){if(seen.has(v))return '[Circular]';seen.add(v);}return v;});}catch(_){return String(obj);} }function line(r){const ts=r&&r.ts?new Date(r.ts).toLocaleTimeString():new Date().toLocaleTimeString();const m=(r&&r.msg)?r.msg:'';let d='';if(r&&r.data!=null){d=' '+safeStringify(r.data);}if(!m&&!d){try{d=' '+safeStringify(r);}catch(_){}}return '['+ts+'] '+m+d;}function append(t){if(!t||paused)return;el.textContent+=t+'\n';el.scrollTop=el.scrollHeight;received++;setStatus();}fetch('/logs?format=json').then(r=>r.json()).then(list=>{try{(list||[]).forEach(rec=>{append(line(rec));});}catch(_){/*ignore*/}}).catch(()=>{});const s=new EventSource('/logs/stream');s.onmessage=(ev)=>{try{const rec=JSON.parse(ev.data);append(line(rec));}catch(_){}};pauseBtn.addEventListener('click',()=>{paused=!paused;pauseBtn.textContent=paused?'Resume':'Pause';setStatus();});clearBtn.addEventListener('click',()=>{el.textContent='';received=0;setStatus();});triggerBtn.addEventListener('click',async()=>{triggerBtn.disabled=true;triggerBtn.textContent='Triggering...';try{const r=await fetch('/trigger-sync',{method:'POST'});const txt=await r.text();append('[manual] '+(r.ok?'OK ':'Fail ')+txt);}catch(e){append('[manual] Error '+e.message);}finally{triggerBtn.disabled=false;triggerBtn.textContent='Trigger Sync';}});downloadBtn.addEventListener('click',async()=>{try{const r=await fetch('/logs?format=json');const list=await r.json();const blob=new Blob([JSON.stringify(list,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='logs-tail.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);}catch(e){append('[download] Error '+e.message);}});setStatus();})();</script></body></html>`);
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
