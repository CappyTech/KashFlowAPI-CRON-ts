import { IncomingMessage, ServerResponse } from 'node:http';
import { UpsertLogModel } from '../../db/models.js';
import { pageShell, h1 } from '../metrics/html.js';

function parseQuery(urlStr: string) {
  const u = new URL(urlStr, 'http://x');
  const limit = Math.max(1, Math.min(500, Number(u.searchParams.get('limit') || '100')));
  const entity = u.searchParams.get('entity') || undefined;
  const key = u.searchParams.get('key') || undefined;
  const sinceStr = u.searchParams.get('since') || undefined;
  let since: Date | undefined = undefined;
  if (sinceStr) {
    const t = Date.parse(sinceStr);
    if (!Number.isNaN(t)) since = new Date(t);
  }
  return { limit, entity, key, since, url: u };
}

export async function handleUpserts(req: IncomingMessage, res: ServerResponse, accept: string) {
  const { limit, entity, key, since, url } = parseQuery(req.url!);
  const format = (url.searchParams.get('format') || '').toLowerCase();
  const wantsJson = format === 'json' || (accept.includes('application/json') && !accept.includes('text/html'));

  const q: any = {};
  if (entity) q.entity = entity;
  if (key) q.key = key;
  if (since) q.ts = { $gte: since };

  const docs = await UpsertLogModel.find(q).sort({ ts: -1 }).limit(limit).lean();

  if (wantsJson) {
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(docs));
  }

  const rows = (docs || []).map(d => {
    const when = d.ts ? new Date(d.ts).toLocaleString() : '';
    const ch = Array.isArray(d.changedFields) ? d.changedFields.join(', ') : '';
    const changesSummary = ch || (d.changes ? Object.keys(d.changes).join(', ') : '');
    return `<tr><td>${when}</td><td>${d.entity || ''}</td><td>${d.key || ''}</td><td>${d.op || ''}</td><td>${changesSummary}</td></tr>`;
  }).join('');

  const html = pageShell('Upserts', `
    ${h1('Recent Upserts')}
    <div><a href="/">&larr; Dashboard</a> | <a href="/upserts?format=json">JSON</a></div>
    <form method="GET" action="/upserts" style="margin:.5rem 0; display:flex; gap:.5rem; flex-wrap:wrap;">
      <label>Entity <input type="text" name="entity" value="${entity || ''}" /></label>
      <label>Key <input type="text" name="key" value="${key || ''}" /></label>
      <label>Since <input type="text" name="since" placeholder="YYYY-MM-DD" value="${since ? since.toISOString().slice(0,10) : ''}" /></label>
      <label>Limit <input type="number" min="1" max="500" name="limit" value="${limit}" /></label>
      <button type="submit">Apply</button>
    </form>
    <table>
      <thead><tr><th>When</th><th>Entity</th><th>Key</th><th>Op</th><th>Changed</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `);
  res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(html);
}
