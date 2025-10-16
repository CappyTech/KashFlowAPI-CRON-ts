import http from 'node:http';

import logger from '../util/logger.js';
import { config } from '../config.js';
import { getLastSummary, setNextCron, setNextFullRefresh } from '../sync/summary.js';
import { SyncSummaryModel } from '../db/models.js';
import { getState } from '../sync/state.js';
import { APP_VERSION } from '../version.js';
import { handleMetrics, handleTriggerSync } from './metrics/routes.js';
import { handleSyncSummary, handleSummaries, handleSummary } from '../server/controllers/summariesController.js';
import { getCounters, noteRun as noteRunCounters } from './metrics/metricsState.js';
import { handleLogs, handleLogsStream } from '../server/controllers/logsController.js';
import { handleUpserts } from '../server/controllers/upsertsController.js';

export const noteRun = noteRunCounters;

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
      (function(){
      try {
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
        if (miniLogEl.textContent.length > 200000) { // trim if grows too large
          miniLogEl.textContent = miniLogEl.textContent.slice(-150000);
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
      } catch(e) {
        try {
          var s = document.getElementById('status');
          if (s) { s.innerHTML = '<span class="fail">UI script error: '+ String((e && e.message) || e) +'</span>'; }
        } catch {}
      }
      })();
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
        return handleMetrics(req, res, accept as string);
      })();
    }

    // /sync-summary (latest)
    else if (url.startsWith('/sync-summary')) {
      return handleSyncSummary(req, res, accept as string);
    }

    // /summaries list
    else if (url.startsWith('/summaries')) {
      return handleSummaries(req, res, accept as string);
    }

    // /summary/:id
    else if (url.startsWith('/summary/')) {
      return handleSummary(req, res, accept as string);
    }

    // /trigger-sync (local only)
    else if (url.startsWith('/trigger-sync')) {
      return handleTriggerSync(req, res);
    }

    // /logs (HTML/JSON)
    else if (url.startsWith('/logs') && !url.startsWith('/logs/stream')) {
      return handleLogs(req, res, accept as string);
    }

    // /logs/stream (SSE)
    else if (url.startsWith('/logs/stream')) {
      return handleLogsStream(req, res);
    }

    // /upserts (HTML/JSON)
    else if (url.startsWith('/upserts')) {
      return handleUpserts(req, res, accept as string);
    }

    else {
      res.statusCode = 404; res.end('Not found');
    }
  });
  server.listen(config.metrics.port, () => logger.info({ port: config.metrics.port }, 'Metrics server listening'));
  return server;
}
