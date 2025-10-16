import { IncomingMessage, ServerResponse } from 'node:http';
import { getLogBuffer, logEvents } from '../../util/logger.js';
import { pageShell, h1 } from '../metrics/html.js';

export async function handleLogs(req: IncomingMessage, res: ServerResponse, accept: string) {
  const wantsJson = (req.url||'').includes('format=json') || (accept.includes('application/json') && !accept.includes('text/html'));
  if (wantsJson) {
    const list = getLogBuffer(200);
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(list));
  }
  const html = pageShell('Logs', `${h1('Logs')}<div><a href="/">&larr; Dashboard</a> | <a href="/logs?format=json">JSON</a></div><p>Use the dashboard Live Logs panel for streaming.</p>`);
  res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(html);
}

export async function handleLogsStream(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const listener = (rec: any) => {
    try { res.write(`data: ${JSON.stringify(rec)}\n\n`); } catch { /* ignore */ }
  };
  logEvents.on('log', listener);
  // Send initial ping to keep some proxies happy
  try { res.write(': ping\n\n'); } catch {}
  res.on('close', () => { logEvents.off('log', listener); });
}
