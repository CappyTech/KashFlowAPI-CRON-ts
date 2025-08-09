import http from 'node:http';
import logger from '../util/logger.js';
import { getLastSummary } from '../sync/summary.js';
import { runSync } from '../sync/run.js';
import { SyncSummaryModel } from '../db/models.js';
import { config } from '../config.js';

// Minimal in-memory counters (extend later as needed)
let totalRuns = 0;
let totalFailures = 0;
let lastDurationMs = 0;

export function noteRun(success: boolean, durationMs: number) {
  totalRuns += 1;
  if (!success) totalFailures += 1;
  lastDurationMs = durationMs;
}

export function startMetricsServer() {
  const server = http.createServer((req, res) => {
    if (!req.url) { res.statusCode = 400; return res.end('Bad request'); }
  // After this point, req.url is guaranteed non-undefined
  const url = req.url as string;
  const acceptHeader = req.headers.accept ?? '';
  if (url === '/' || url.startsWith('/index.html')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>KashFlow Sync Dashboard</title>
<style>
body { font-family: system-ui, Arial, sans-serif; margin: 1.5rem; background:#0f1115; color:#eee; }
h1 { margin-top:0; }
table { border-collapse: collapse; width:100%; margin-top:1rem; }
th, td { border:1px solid #333; padding:6px 8px; text-align:left; font-size:0.9rem; }
th { background:#1d2229; }
tbody tr:nth-child(even){ background:#181c22; }
.ok { color:#6cc644; }
.fail { color:#ff5555; }
.progress { color:#f0ad4e; }
code { background:#181c22; padding:2px 4px; border-radius:4px; }
small { color:#aaa; }
</style>
</head>
<body>
<h1>KashFlow Sync Dashboard</h1>
<div id="status">Loading...</div>
<table id="entities" style="display:none;">
  <thead>
    <tr>
      <th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration (ms)</th>
    </tr>
  </thead>
  <tbody></tbody>
</table>
<div style="margin:1rem 0; display:flex; gap:0.75rem; flex-wrap:wrap;">
  <button id="triggerBtn">Trigger Sync Now</button>
  <button id="historyBtn">Show History</button>
  <button data-link="/metrics" class="navBtn" title="Open Prometheus metrics" type="button">Metrics</button>
  <button data-link="/sync-summary" class="navBtn" title="Open raw JSON summary" type="button">JSON Summary</button>
  <button data-link="/summaries" class="navBtn" title="Open summaries list JSON" type="button">Summaries JSON</button>
  <span id="triggerResult" style="align-self:center;"></span>
</div>
<div id="history" style="display:none; margin-top:1rem;">
  <h2 style="margin:0 0 0.5rem;">Recent Sync History</h2>
  <table id="historyTable" style="width:100%; border-collapse:collapse;">
    <thead><tr><th>Start</th><th>End</th><th>Dur</th><th>Success</th><th>Error</th><th>Entities</th></tr></thead>
    <tbody></tbody>
  </table>
</div>
<p><a href="/metrics" target="_blank">Raw Prometheus metrics</a> | <a href="/sync-summary" target="_blank">Raw JSON summary</a></p>
<script>
// duration formatter (shared)
function human(ms){
  if(ms < 1000) return ms + ' ms';
  const sec = ms/1000;
  if(sec < 60) return sec.toFixed(sec < 10 ? 2 : 1) + ' s';
  const m = Math.floor(sec/60);
  const s = Math.floor(sec % 60);
  const remMs = Math.floor(ms % 1000);
  if(sec < 3600) return m + 'm ' + s + 's' + (remMs? ' ' + remMs + 'ms':'');
  const h = Math.floor(m/60);
  const mm = m % 60;
  return h + 'h ' + mm + 'm ' + s + 's';
}
async function fetchJson(url){
  const r = await fetch(url, { headers: { 'Accept':'application/json' } });
  const text = await r.text();
  if(!r.ok) throw new Error('HTTP '+r.status+' body: '+text.slice(0,120));
  try { return JSON.parse(text); } catch(e){ throw new Error('Parse error for '+url+' first chars: '+text.slice(0,40)); }
}
async function load() {
  try {
    const data = await fetchJson('/sync-summary?format=json');
    const root = document.getElementById('status');
    const tbl = document.getElementById('entities');
    if(!data || !data.lastSummary){
      root.innerHTML = '<span class="progress">No completed sync yet.</span>' + (data.inProgress ? ' <span class="progress">(A sync is in progress)</span>' : '');
      tbl.style.display='none';
      return;
    }
    const s = data.lastSummary;
    const durRaw = s.durationMs;
    const durHuman = human(durRaw);
    const started = new Date(s.start).toLocaleString();
    const ended = new Date(s.end).toLocaleString();
    root.innerHTML = 'Last Sync: <strong>' + (s.success?'<span class="ok">SUCCESS</span>':'<span class="fail">FAIL</span>') + '</strong>' +
      ' | Start: <code>' + started + '</code>' +
      ' | End: <code>' + ended + '</code>' +
      ' | Duration: <code title="' + durRaw.toLocaleString() + ' ms">' + durHuman + '</code>' +
      (data.inProgress ? ' | <span class="progress">Current sync running...</span>' : '') +
      (s.error ? '<br/><small>Error: ' + s.error.replace(/</g,'&lt;') + '</small>' : '');
    const tbody = tbl.querySelector('tbody');
    tbody.innerHTML='';
    (s.entities||[]).forEach(e => {
      const tr = document.createElement('tr');
      function cell(v){ const td=document.createElement('td'); td.textContent = (v===undefined||v===null)?'':String(v); return td; }
  const isIncremental = (e.lastMax !== undefined) || (e.newMax !== undefined) || (e.upserted !== undefined);
  const processedVal = e.processed !== undefined ? e.processed : (isIncremental ? 'n/a' : 0);
  const upsertedVal = e.upserted !== undefined ? e.upserted : (isIncremental ? 0 : 'n/a');
  const softDeletedVal = e.softDeleted !== undefined ? e.softDeleted : (isIncremental ? 'n/a' : 0);
  const lastMaxNewMaxVal = (e.lastMax !== undefined || e.newMax !== undefined) ? (String(e.lastMax||0)+'->'+String(e.newMax||0)) : 'n/a';
  tr.appendChild(cell(e.entity ?? ''));
  tr.appendChild(cell(e.pages !== undefined ? e.pages : 0));
  tr.appendChild(cell(e.fetched !== undefined ? e.fetched : 0));
  tr.appendChild(cell(processedVal));
  tr.appendChild(cell(upsertedVal));
  tr.appendChild(cell(e.total !== undefined ? e.total : 0));
  tr.appendChild(cell(softDeletedVal));
  tr.appendChild(cell(lastMaxNewMaxVal));
  // humanize entity duration
  const msVal = e.ms || 0;
  const tdDur = cell(human(msVal));
  tdDur.title = msVal + ' ms';
  tr.appendChild(tdDur);
      tbody.appendChild(tr);
    });
    tbl.style.display='table';
  } catch(err){
    document.getElementById('status').innerHTML = '<span class=fail>Load error:</span> '+err.message;
  }
}
load();
setInterval(load, 5000);
const btn = document.getElementById('triggerBtn');
const historyBtn = document.getElementById('historyBtn');
const historyDiv = document.getElementById('history');
// wire nav buttons
document.querySelectorAll('.navBtn').forEach(function(b){
  b.addEventListener('click', function(){
    const url = b.getAttribute('data-link');
    if (url) window.open(url, '_blank');
  });
});
historyBtn.addEventListener('click', async ()=>{
  if(historyDiv.style.display==='none'){ historyDiv.style.display='block'; await loadHistory(); historyBtn.textContent='Hide History'; }
  else { historyDiv.style.display='none'; historyBtn.textContent='Show History'; }
});
async function loadHistory(){
  try {
    const list = await fetchJson('/summaries?limit=25&format=json');
    const tbody = document.querySelector('#historyTable tbody');
    tbody.innerHTML='';
    list.forEach(s => {
      const tr = document.createElement('tr');
      function td(v){ const d=document.createElement('td'); d.textContent=v; return d; }
      tr.appendChild(td(new Date(s.start).toLocaleString()));
      tr.appendChild(td(new Date(s.end).toLocaleString()));
      tr.appendChild(td(human(s.durationMs)));
      tr.appendChild(td(s.success? '✔':'✖'));
      tr.appendChild(td(s.error? s.error.substring(0,40):''));
      tr.appendChild(td(s.entities.length));
      tr.style.cursor='pointer';
      tr.addEventListener('click', ()=>{ window.open('/summary/'+s._id, '_blank'); });
      tbody.appendChild(tr);
    });
  } catch(e){
    const tbody = document.querySelector('#historyTable tbody');
    tbody.innerHTML='<tr><td colspan="6">Error loading history: '+e.message+'</td></tr>';
  }
}
btn.addEventListener('click', async () => {
  btn.disabled = true;
  const out = document.getElementById('triggerResult');
  out.textContent = 'Triggering...';
  try {
    const r = await fetch('/trigger-sync', { method: 'POST' });
    const txt = await r.text();
    if (r.ok) {
      out.textContent = 'Started: ' + txt;
    } else {
      out.textContent = 'Failed: ' + txt;
    }
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  } finally {
    setTimeout(()=>{ btn.disabled = false; }, 3000);
  }
});
</script>
</body>
</html>`);
  }
  if (url.startsWith('/metrics')) {
    const u = new URL(url, 'http://x');
      const wantHtmlParam = ['html','true','1'].includes((u.searchParams.get('view')||'').toLowerCase()) || ['html'].includes((u.searchParams.get('format')||'').toLowerCase());
      const accept = acceptHeader;
      const preferHtml = wantHtmlParam || (accept.includes('text/html') && !accept.includes('text/plain'));
      const wantPromPlain = ['prom','plain','text'].includes((u.searchParams.get('format')||'').toLowerCase());
      const { lastSummary, inProgress } = getLastSummary();
      const buildLines = () => {
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
          }
        }
        return lines;
      };
      if (!preferHtml || wantPromPlain) {
        const lines = buildLines();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        return res.end(lines.join('\n') + '\n');
      }
      // HTML view
      const lines = buildLines();
      res.statusCode = 200;
      res.setHeader('Content-Type','text/html; charset=utf-8');
      const esc = (s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const entityRows = (lastSummary?.entities||[]).map(e=>`<tr><td>${e.entity}</td><td>${e.pages??0}</td><td>${e.fetched??0}</td><td>${e.upserted??'n/a'}</td><td>${e.total??0}</td><td>${e.softDeleted??'n/a'}</td><td>${(e.lastMax!==undefined||e.newMax!==undefined)?(e.lastMax||0)+"->"+(e.newMax||0):'n/a'}</td><td>${e.ms}</td></tr>`).join('');
      return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Metrics</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}pre{background:#181c22;padding:10px;overflow:auto;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:4px 6px;font-size:.75rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}code{background:#181c22;padding:2px 4px;border-radius:4px;}</style></head><body>
      <h1>Metrics</h1>
      <div><a href="/">&larr; Dashboard</a> | <a href="/metrics?format=prom" target="_blank">Plain Text</a> | <a href="/sync-summary">Latest Summary</a></div>
      <h2>High-level</h2>
      <ul>
        <li>Total Runs: <strong>${totalRuns}</strong></li>
        <li>Total Failures: <strong>${totalFailures}</strong></li>
        <li>Last Duration (ms): <strong>${lastDurationMs}</strong></li>
        <li>In Progress: <strong>${inProgress? 'yes':'no'}</strong></li>
  <li>Last Success: <strong>${lastSummary ? (lastSummary.success ? 'yes' : 'no') : 'n/a'}</strong></li>
      </ul>
      <h2>Entities (Last Run)</h2>
      <table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Ms</th></tr></thead><tbody>${entityRows||'<tr><td colspan="8">No data</td></tr>'}</tbody></table>
      <h2>Raw Exposition</h2>
      <pre>${esc(lines.join('\n'))}</pre>
      <script>setInterval(()=>{fetch('/metrics?format=prom').then(r=>r.text()).then(t=>{document.querySelector('pre').textContent=t;});},5000);</script>
      </body></html>`);
  } else if (url.startsWith('/sync-summary')) {
      const data = getLastSummary();
  const wantsJson = (acceptHeader.includes('application/json') && !acceptHeader.includes('text/html')) || url.includes('?format=json');
      if (wantsJson) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(data));
      }
      const humanServer = (ms:number)=>{
        if(ms < 1000) return ms + ' ms';
        const sec = ms/1000;
        if(sec < 60) return sec.toFixed(sec < 10 ? 2 : 1) + ' s';
        const m = Math.floor(sec/60);
        const s = Math.floor(sec % 60);
        const remMs = Math.floor(ms % 1000);
        if(sec < 3600) return m + 'm ' + s + 's' + (remMs? ' ' + remMs + 'ms':'');
        const h = Math.floor(m/60);
        const mm = m % 60;
        return h + 'h ' + mm + 'm ' + s + 's';
      };
      res.statusCode = 200;
      res.setHeader('Content-Type','text/html; charset=utf-8');
      const { lastSummary, inProgress } = data as any;
      if (!lastSummary) {
        return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sync Summary</title></head><body style="font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;">
        <h1>Sync Summary</h1>
        <p>No completed sync yet. ${inProgress? 'In progress...' : ''}</p>
        <p><a href="/">&larr; Dashboard</a></p>
        </body></html>`);
      }
      const started = lastSummary.start ? new Date(lastSummary.start).toLocaleString():'';
      const ended = lastSummary.end ? new Date(lastSummary.end).toLocaleString():'';
      const duration = humanServer(lastSummary.durationMs||0);
      const rows = (lastSummary.entities||[]).map((e:any)=>{
        const incr = (e.lastMax !== undefined) || (e.newMax !== undefined) || (e.upserted !== undefined);
        const processedVal = e.processed !== undefined ? e.processed : (incr ? 'n/a':'0');
        const upsertedVal = e.upserted !== undefined ? e.upserted : (incr ? '0':'n/a');
        const softDeletedVal = e.softDeleted !== undefined ? e.softDeleted : (incr ? 'n/a':'0');
        const lastMaxNewMaxVal = (e.lastMax !== undefined || e.newMax !== undefined) ? `${e.lastMax||0}->${e.newMax||0}` : 'n/a';
        return `<tr>
          <td>${e.entity}</td><td>${e.pages ?? 0}</td><td>${e.fetched ?? 0}</td><td>${processedVal}</td><td>${upsertedVal}</td><td>${e.total ?? 0}</td><td>${softDeletedVal}</td><td>${lastMaxNewMaxVal}</td><td title="${e.ms} ms">${humanServer(e.ms)}</td><td>${e.stoppedReason||''}</td>
        </tr>`;}).join('');
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Latest Sync Summary</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:6px 8px;font-size:.8rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}code{background:#181c22;padding:2px 4px;border-radius:4px;}</style></head><body>
      <h1>Latest Sync Summary</h1>
      <div>Status: ${lastSummary.success?'<span style="color:#6cc644">SUCCESS</span>':'<span style="color:#ff5555">FAIL</span>'}</div>
      <div>Start: <code>${started}</code> | End: <code>${ended}</code> | Duration: <code>${duration}</code> ${inProgress? ' | <em>In Progress</em>':''}</div>
      ${lastSummary.error? `<div style="color:#ff5555">Error: ${lastSummary.error}</div>`:''}
      <div style="margin-top:.5rem"><a href="/">&larr; Dashboard</a> | <a href="/sync-summary?format=json" target="_blank">Raw JSON</a> | <a href="/summaries">All Summaries</a></div>
      <table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody>${rows}</tbody></table>
      </body></html>`);
      return;
    } else if (url.startsWith('/summaries')) {
      const u = new URL(url, 'http://x');
      const limit = Math.min(200, parseInt(u.searchParams.get('limit') || '25', 10));
      const wantsJson = (acceptHeader.includes('application/json') && !acceptHeader.includes('text/html')) || url.includes('format=json');
      (async () => {
        try {
          const docs = await SyncSummaryModel.find({}, { entities: 1, start: 1, end: 1, durationMs: 1, success: 1, error: 1 }).sort({ start: -1 }).limit(limit).lean();
          if (wantsJson) {
            res.statusCode = 200; res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(docs));
          }
          const humanServer = (ms:number)=>{ if(ms<1000) return ms+' ms'; const sec=ms/1000; if(sec<60) return sec.toFixed(sec<10?2:1)+' s'; const m=Math.floor(sec/60); const s=Math.floor(sec%60); if(sec<3600) return m+'m '+s+'s'; const h=Math.floor(m/60); const mm=m%60; return h+'h '+mm+'m '+s+'s'; };
          const rows = docs.map(d=>{
            const started = d.start? new Date(d.start as any).toLocaleString():'';
            const ended = d.end? new Date(d.end as any).toLocaleString():'';
            return `<tr data-id="${d._id}"><td>${started}</td><td>${ended}</td><td>${humanServer(d.durationMs||0)}</td><td>${d.success? '✔':'✖'}</td><td>${d.error? (''+d.error).substring(0,40):''}</td><td>${(d.entities||[]).length}</td></tr>`;
          }).join('');
          res.statusCode = 200;
          res.setHeader('Content-Type','text/html; charset=utf-8');
          res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sync Summaries</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:6px 8px;font-size:.8rem;text-align:left;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}tr{cursor:pointer;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}</style></head><body>
          <h1>Sync Summaries</h1>
          <div><a href="/">&larr; Dashboard</a> | <a href="/summaries?format=json" target="_blank">Raw JSON</a></div>
          <table><thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Success</th><th>Error</th><th>Entities</th></tr></thead><tbody>${rows}</tbody></table>
          <script>document.querySelectorAll('tr[data-id]').forEach(function(r){r.addEventListener('click',function(){window.location='/summary/'+r.getAttribute('data-id');});});</script>
          </body></html>`);
        } catch(e){ res.statusCode=500; res.end('Error'); }
      })();
      return;
    } else if (url.startsWith('/summary/')) {
      const id = url.split('/').pop();
      (async () => {
        try {
          const doc = await SyncSummaryModel.findById(id).lean();
          if(!doc){ res.statusCode=404; return res.end('Not found'); }
          const wantsJson = acceptHeader.includes('application/json') && !acceptHeader.includes('text/html');
          if (wantsJson || url.includes('?format=json')) {
            res.statusCode=200; res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(doc));
          }
          // Build HTML UI
          res.statusCode=200; res.setHeader('Content-Type','text/html; charset=utf-8');
          const esc = (s:string)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
          const humanServer = (ms:number)=>{
            if(ms < 1000) return ms + ' ms';
            const sec = ms/1000;
            if(sec < 60) return sec.toFixed(sec < 10 ? 2 : 1) + ' s';
            const m = Math.floor(sec/60);
            const s = Math.floor(sec % 60);
            const remMs = Math.floor(ms % 1000);
            if(sec < 3600) return m + 'm ' + s + 's' + (remMs? ' ' + remMs + 'ms':'');
            const h = Math.floor(m/60);
            const mm = m % 60;
            return h + 'h ' + mm + 'm ' + s + 's';
          };
          const rows = (doc.entities||[]).map((e:any)=>{
            const incr = (e.lastMax !== undefined) || (e.newMax !== undefined) || (e.upserted !== undefined);
            const processedVal = e.processed !== undefined ? e.processed : (incr ? 'n/a':'0');
            const upsertedVal = e.upserted !== undefined ? e.upserted : (incr ? '0':'n/a');
            const softDeletedVal = e.softDeleted !== undefined ? e.softDeleted : (incr ? 'n/a':'0');
            const lastMaxNewMaxVal = (e.lastMax !== undefined || e.newMax !== undefined) ? `${e.lastMax||0}->${e.newMax||0}` : 'n/a';
            return `<tr>
              <td>${esc(e.entity)}</td>
              <td>${e.pages ?? 0}</td>
              <td>${e.fetched ?? 0}</td>
              <td>${processedVal}</td>
              <td>${upsertedVal}</td>
              <td>${e.total ?? 0}</td>
              <td>${softDeletedVal}</td>
              <td>${lastMaxNewMaxVal}</td>
              <td title="${e.ms} ms">${humanServer(e.ms)}</td>
              <td>${e.stoppedReason || ''}</td>
            </tr>`;
          }).join('');
          const started = doc.start ? new Date(doc.start as any).toLocaleString() : '';
          const ended = doc.end ? new Date(doc.end as any).toLocaleString() : '';
          const success = doc.success;
          const duration = humanServer(doc.durationMs || 0);
          const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sync Summary ${esc(id||'')}</title>
          <style>
          body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.5rem;}
          a{color:#6cc6ff;text-decoration:none;} a:hover{text-decoration:underline;}
          table{border-collapse:collapse;width:100%;margin-top:1rem;}
          th,td{border:1px solid #333;padding:6px 8px;font-size:0.85rem;text-align:left;}
          th{background:#1d2229;}
          tbody tr:nth-child(even){background:#181c22;}
          .ok{color:#6cc644;font-weight:600;} .fail{color:#ff5555;font-weight:600;}
          code{background:#181c22;padding:2px 4px;border-radius:4px;}
          .meta{margin-bottom:0.75rem;}
          .badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:0.7rem;background:#222;margin-left:4px;}
          </style></head><body>
          <h1>Sync Summary</h1>
          <div class="meta">ID: <code>${esc(id||'')}</code> <span class="badge">${success? 'SUCCESS':'FAIL'}</span></div>
          <div class="meta">Start: <code>${started}</code> | End: <code>${ended}</code> | Duration: <code>${duration}</code></div>
          ${doc.error ? `<div class="meta fail">Error: ${esc(doc.error)}</div>`:''}
          <div><a href="/" style="margin-right:1rem;">&larr; Dashboard</a><a href="/summary/${esc(id||'')}?format=json" target="_blank">Raw JSON</a></div>
          <table>
            <thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          </body></html>`;
          return res.end(html);
        } catch(e){ res.statusCode=500; res.end('Error'); }
      })();
      return;
  } else if (url.startsWith('/trigger-sync')) {
      // Local-only manual trigger
      const remote = req.socket.remoteAddress;
      const allowed = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!allowed) {
        res.statusCode = 403; return res.end('Forbidden');
      }
      if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed'); }
      const { inProgress } = getLastSummary();
      if (inProgress) { res.statusCode = 409; return res.end('Sync already in progress'); }
      runSync().then(() => {
        const { lastSummary } = getLastSummary();
        if (lastSummary) noteRun(lastSummary.success, lastSummary.durationMs);
      }).catch(err => {
        logger.error({ err }, 'Manual sync failed');
      });
      res.statusCode = 202; return res.end('Sync triggered');
    } else {
      res.statusCode = 404;
      return res.end('Not found');
    }
  });
  server.listen(config.metrics.port, () => {
    logger.info({ port: config.metrics.port }, 'Metrics server listening');
  });
  return server;
}
