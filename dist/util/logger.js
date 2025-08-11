import pino from 'pino';
const level = process.env.LOG_LEVEL || 'info';
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
    }
});
export default logger;
