import { IncomingMessage, ServerResponse } from 'node:http';
import { SyncSummaryModel } from '../../db/models.js';
import { getLastSummary } from '../../sync/summary.js';
import { pageShell, h1 } from '../metrics/html.js';
import { human } from '../metrics/human.js';

export async function handleSyncSummary(req: IncomingMessage, res: ServerResponse, accept: string) {
  const wantsJson = (req.url||'').includes('format=json') || (accept.includes('application/json') && !accept.includes('text/html'));
  const data = getLastSummary();
  if (wantsJson) { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(data)); }
  const { lastSummary, inProgress } = data;
  res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!lastSummary) return res.end(pageShell('Sync Summary', `${h1('Sync Summary')}<p>No completed sync yet. ${inProgress ? 'In progress...' : ''}</p><p><a href="/">&larr; Dashboard</a></p>`));
  const rows = (lastSummary.entities || []).map((e: any) => { const incr = (e.lastMax !== undefined) || (e.newMax !== undefined) || (e.upserted !== undefined); const proc = e.processed !== undefined ? e.processed : (incr ? 'n/a' : 0); const ups = e.upserted !== undefined ? e.upserted : (incr ? 0 : 'n/a'); const soft = e.softDeleted !== undefined ? e.softDeleted : (incr ? 'n/a' : 0); const range = (e.lastMax !== undefined || e.newMax !== undefined) ? `${e.lastMax || 0}->${e.newMax || 0}` : 'n/a'; return `<tr><td>${e.entity}</td><td>${e.pages || 0}</td><td>${e.fetched || 0}</td><td>${proc}</td><td>${ups}</td><td>${e.total || 0}</td><td>${soft}</td><td>${range}</td><td title="${e.ms} ms">${human(e.ms)}</td><td>${e.stoppedReason || ''}</td></tr>`; }).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Latest Sync Summary</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:6px 8px;font-size:.75rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}</style></head><body>${h1('Latest Sync Summary')}<div>Status: ${lastSummary.success ? '<span style="color:#6cc644">SUCCESS</span>' : '<span style="color:#ff5555">FAIL</span>'}</div><div>Start: <code>${new Date(lastSummary.start).toLocaleString()}</code> | End: <code>${new Date(lastSummary.end).toLocaleString()}</code> | Duration: <code>${human(lastSummary.durationMs || 0)}</code> ${inProgress ? ' | <em>In Progress</em>' : ''}</div>${lastSummary.error ? `<div style=\"color:#ff5555\">Error: ${lastSummary.error}</div>` : ''}<div style="margin-top:.5rem"><a href="/">&larr; Dashboard</a> | <a href="/sync-summary?format=json" >Raw JSON</a> | <a href="/summaries">All Summaries</a></div><table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  return res.end(html);
}

export async function handleSummaries(req: IncomingMessage, res: ServerResponse, accept: string) {
  const u = new URL(req.url||'/', 'http://x');
  const limit = Math.min(200, parseInt(u.searchParams.get('limit') || '25', 10));
  const wantsJson = (req.url||'').includes('format=json') || (accept.includes('application/json') && !accept.includes('text/html'));
  try {
    const docs = await SyncSummaryModel.find({}, { entities: 1, start: 1, end: 1, durationMs: 1, success: 1, error: 1 }).sort({ start: -1 }).limit(limit).lean();
    if (wantsJson) { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(docs)); }
    const rows = docs.map(d => { const started = d.start ? new Date(d.start as any).toLocaleString() : ''; const ended = d.end ? new Date(d.end as any).toLocaleString() : ''; return `<tr data-id="${d._id}"><td>${started}</td><td>${ended}</td><td>${human(d.durationMs || 0)}</td><td>${d.success ? '✔' : '✖'}</td><td>${d.error ? String(d.error).substring(0, 40) : ''}</td><td>${(d.entities || []).length}</td></tr>`; }).join('');
    const html = pageShell('Sync Summaries', `${h1('Sync Summaries')}<div><a href="/">&larr; Dashboard</a> | <a href="/summaries?format=json" >Raw JSON</a></div><table><thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Success</th><th>Error</th><th>Entities</th></tr></thead><tbody>${rows}</tbody></table><script>document.querySelectorAll('tr[data-id]').forEach(r=>r.addEventListener('click',()=>{window.location='/summary/'+r.getAttribute('data-id');}));</script>`);
    res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  } catch (e) { res.statusCode = 500; return res.end('Error'); }
}

export async function handleSummary(req: IncomingMessage, res: ServerResponse, _accept: string) {
  const id = (req.url||'').split('/').pop();
  try {
    const doc = await SyncSummaryModel.findById(id).lean();
    if (!doc) { res.statusCode = 404; return res.end('Not found'); }
    const wantsJson = (req.url||'').includes('format=json');
    if (wantsJson) { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(doc)); }
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const rows = (doc.entities || []).map((e: any) => { const incr = (e.lastMax !== undefined) || (e.newMax !== undefined) || (e.upserted !== undefined); const processed = e.processed !== undefined ? e.processed : (incr ? 'n/a' : 0); const upserted = e.upserted !== undefined ? e.upserted : (incr ? 0 : 'n/a'); const soft = e.softDeleted !== undefined ? e.softDeleted : (incr ? 'n/a' : 0); const range = (e.lastMax !== undefined || e.newMax !== undefined) ? `${e.lastMax || 0}->${e.newMax || 0}` : 'n/a'; return `<tr><td>${esc(e.entity)}</td><td>${e.pages ?? 0}</td><td>${e.fetched ?? 0}</td><td>${processed}</td><td>${upserted}</td><td>${e.total ?? 0}</td><td>${soft}</td><td>${range}</td><td>${human(e.ms || 0)}</td><td>${e.stoppedReason || ''}</td></tr>`; }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sync Summary ${esc(id || '')}</title><style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.3rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:6px 8px;font-size:.75rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}</style></head><body>${h1('Sync Summary')}<div>ID: <code>${esc(id || '')}</code> | Start: <code>${doc.start ? new Date(doc.start as any).toLocaleString() : ''}</code> | End: <code>${doc.end ? new Date(doc.end as any).toLocaleString() : ''}</code> | Duration: <code>${human(doc.durationMs || 0)}</code> | Success: <strong>${doc.success ? 'yes' : 'no'}</strong></div>${doc.error ? `<div style=\"color:#ff5555\">Error: ${esc(doc.error)} </div>` : ''}<div style="margin-top:.4rem"><a href="/">&larr; Dashboard</a> | <a href="/summary/${esc(id || '')}?format=json" >Raw JSON</a></div><table><thead><tr><th>Entity</th><th>Pages</th><th>Fetched</th><th>Processed</th><th>Upserted</th><th>API Total</th><th>Soft Deleted</th><th>LastMax→NewMax</th><th>Duration</th><th>Stop Reason</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  } catch (e) { res.statusCode = 500; return res.end('Error'); }
}
