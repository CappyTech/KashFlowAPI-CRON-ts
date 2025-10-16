import { ServerResponse, IncomingMessage } from 'node:http';
import { pageShell, h1 } from '../metrics/html.js';

// For now, reuse existing inline HTML from metrics.ts root route to avoid behavior change.
export function renderDashboard(_req: IncomingMessage, res: ServerResponse, html: string) {
  res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}
