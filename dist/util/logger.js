import pino from 'pino';
import { EventEmitter } from 'node:events';
const level = process.env.LOG_LEVEL || 'info';
// Real-time log bus and buffer (for metrics dashboard streaming)
export const logEvents = new EventEmitter();
const LOG_BUFFER_MAX = 500;
const _logBuffer = [];
export function getLogBuffer(limit = 200) {
    const n = Math.max(1, Math.min(limit, LOG_BUFFER_MAX));
    return _logBuffer.slice(-n);
}
function push(rec) {
    _logBuffer.push(rec);
    if (_logBuffer.length > LOG_BUFFER_MAX)
        _logBuffer.shift();
    logEvents.emit('log', rec);
}
// Redaction list: crude patterns for secrets. Can be expanded.
const redactPaths = [
    'kashflow.password',
    'kashflow.memorableWord',
    'ssh.password',
    'mongo.pass',
    'config.kashflow.password',
    'config.kashflow.memorableWord',
    'config.ssh.password',
    'config.mongo.pass',
    'uri',
    '*.uri'
];
export const logger = pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
    redact: {
        paths: redactPaths,
        censor: '***'
    },
    // Capture logs for live streaming without affecting output
    hooks: {
        logMethod(args, method) {
            try {
                // Infer message and data (best-effort)
                let msg = undefined;
                let data = undefined;
                const a = args;
                if (a.length === 1) {
                    if (typeof a[0] === 'string')
                        msg = a[0];
                    else
                        data = a[0];
                }
                else if (a.length >= 2) {
                    if (typeof a[0] === 'object' && typeof a[1] === 'string') {
                        data = a[0];
                        msg = a[1];
                    }
                    else if (typeof a[0] === 'string') {
                        msg = a[0];
                        data = a[1];
                    }
                }
                push({ ts: Date.now(), msg: typeof msg === 'string' ? msg : undefined, data });
            }
            catch { /* ignore */ }
            // proceed with original call
            return method.apply(this, args);
        }
    }
});
export default logger;
