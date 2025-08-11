import 'dotenv/config';

function required(name: string, value: string | undefined) {
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

function bool(envVal: string | undefined, defaultVal: boolean) {
    if (envVal == null) return defaultVal;
    const v = envVal.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'n', 'off', ''].includes(v)) return false;
    return defaultVal; // fallback if unexpected
}

export const config = {
    env: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',

    kashflow: {
        username: required('KASHFLOW_USERNAME', process.env.KASHFLOW_USERNAME),
        password: required('KASHFLOW_PASSWORD', process.env.KASHFLOW_PASSWORD),
        memorableWord: required('KASHFLOW_MEMORABLE_WORD', process.env.KASHFLOW_MEMORABLE_WORD),
        baseUrl: 'https://api.kashflow.com/v2',
        timeoutMs: 30000,
    },

    ssh: {
        host: required('SSH_HOST', process.env.SSH_HOST),
        port: parseInt(process.env.SSH_PORT || '22', 10),
        username: required('SSH_USERNAME', process.env.SSH_USERNAME),
        password: required('SSH_PASSWORD', process.env.SSH_PASSWORD),
        dstHost: process.env.SSH_DST_HOST || '127.0.0.1',
        dstPort: parseInt(process.env.SSH_DST_PORT || '27017', 10),
        localHost: process.env.SSH_LOCAL_HOST || '127.0.0.1',
        localPort: parseInt(process.env.SSH_LOCAL_PORT || '27018', 10),
    },

    mongo: {
        dbName: required('MONGO_DB_NAME', process.env.MONGO_DB_NAME),
        user: process.env.MONGO_USER,
        pass: process.env.MONGO_PASSWORD,
        host: process.env.MONGO_HOST || '127.0.0.1',
        port: parseInt(process.env.MONGO_PORT || '27017', 10),
    },

    cron: process.env.CRON_SCHEDULE || '0 * * * *',

    flags: {
        cronEnabled: bool(process.env.CRON_ENABLED, true),
        runOnce: bool(process.env.RUN_ONCE, false),
        progressLogs: bool(process.env.PROGRESS_LOGS, true),
        directDb: bool(process.env.DIRECT_DB, false), // connect directly to Mongo (no SSH tunnel)
        upsertLogs: bool(process.env.UPSERT_LOGS, false), // verbose per-document upsert debug logs
        // Perform a full traversal (no early stop) for incremental entities every N hours to enable safe soft delete of removed records
        fullRefreshHours: parseInt(process.env.FULL_REFRESH_HOURS || '24', 10),
        // After a full refresh completes, soft delete any incremental-entity docs not seen in that refresh (lastSeenRun mismatch)
        incrementalSoftDelete: bool(process.env.INCREMENTAL_SOFT_DELETE, true),
    },

    metrics: {
        enabled: bool(process.env.METRICS_ENABLED, true),
        port: parseInt(process.env.PORT || process.env.METRICS_PORT || '3000', 10),
        authUser: process.env.METRICS_AUTH_USER,
        authPass: process.env.METRICS_AUTH_PASS
    },
};

export default config;
