import { IncomingMessage, ServerResponse } from 'node:http';
import { getLastSummary, setNextCron, setNextFullRefresh } from '../../sync/summary.js';
import { getState } from '../../sync/state.js';
import { SyncSummaryModel, UpsertLogModel } from '../../db/models.js';
import { config } from '../../config.js';
import logger from '../../util/logger.js';
import { h1, pageShell } from './html.js';
import { runSync } from '../../sync/run.js';

// Prometheus /metrics handler removed per request

export async function handleTriggerSync(req: IncomingMessage, res: ServerResponse) {
  // Determine client IP, optionally honoring proxy headers
  let remote = req.socket.remoteAddress || '';
  if (config.metrics.trustProxy) {
    const xff = String((req.headers['x-forwarded-for'] as string | undefined) || '').split(',')[0].trim();
    if (xff) remote = xff;
  }
  function isLocalOrLan(addr: string): boolean {
    if (!addr) return false;
    const a = addr.toLowerCase();
    if (a === '::1' || a === '127.0.0.1' || a === '::ffff:127.0.0.1') return true;
    // Normalize IPv4-mapped IPv6
    const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
    const ipv4Parts = v4.split('.').map(n => Number(n));
    if (ipv4Parts.length === 4 && ipv4Parts.every(n => Number.isFinite(n) && n >= 0 && n <= 255)) {
      const [p0, p1] = ipv4Parts;
      if (p0 === 10) return true;                            // 10.0.0.0/8
      if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;   // 172.16.0.0/12
      if (p0 === 192 && p1 === 168) return true;             // 192.168.0.0/16
      if (p0 === 169 && p1 === 254) return true;             // 169.254.0.0/16 (link-local)
      return false;
    }
    // Basic IPv6 private/link-local checks
    if (a.startsWith('fe80:')) return true; // link-local
    if (a.startsWith('fc') || a.startsWith('fd')) return true; // ULA fc00::/7
    return false;
  }
  const allowed = isLocalOrLan(remote) || !!config.metrics.allowRemoteTrigger;
  if (!allowed) { res.statusCode = 403; return res.end('Forbidden'); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed'); }
  const { inProgress } = getLastSummary();
  if (inProgress) { res.statusCode = 409; return res.end('Sync already in progress'); }
  runSync().catch(err => logger.error({ err }, 'Manual sync failed'));
  res.statusCode = 202; return res.end('Sync triggered');
}
