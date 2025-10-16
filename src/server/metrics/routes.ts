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
