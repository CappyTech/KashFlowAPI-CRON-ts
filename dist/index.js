import logger from './util/logger.js';
import { startSshTunnel, stopSshTunnel } from './sshTunnel.js';
import { connectMongoose, disconnectMongoose } from './db/mongoose.js';
import { runSync } from './sync/run.js';
import cron from 'node-cron';
import { config } from './config.js';
import { startMetricsServer } from './server/metrics.js';
import { getLastSummary, setNextCron, setNextFullRefresh } from './sync/summary.js';
import { noteRun } from './server/metrics.js';
import { getState } from './sync/state.js';
async function bootstrap() {
    try {
        if (!config.flags.directDb) {
            await startSshTunnel();
        }
        else {
            logger.info('DIRECT_DB enabled; not establishing SSH tunnel');
        }
        await connectMongoose();
        if (config.metrics.enabled) {
            startMetricsServer();
        }
        if (config.flags.runOnce) {
            logger.info('RUN_ONCE is true; skipping cron and exiting');
            await disconnectMongoose();
            if (!config.flags.directDb)
                await stopSshTunnel();
            process.exit(0);
            return;
        }
        if (config.flags.cronEnabled) {
            // Schedule hourly, no overlapping thanks to mutex in run
            let running = false;
            const schedule = cron.schedule(config.cron, async () => {
                if (running) {
                    logger.warn('Previous run still in progress; skipping this tick');
                    return;
                }
                running = true;
                try {
                    await runSync();
                    const { lastSummary } = getLastSummary();
                    if (lastSummary)
                        noteRun(lastSummary.success, lastSummary.durationMs);
                    // After run, compute next cron timestamp
                    try {
                        const parserMod = await import('cron-parser');
                        const parseExpression = parserMod.parseExpression || (parserMod.default && parserMod.default.parseExpression);
                        if (parseExpression) {
                            const it = parseExpression(config.cron, { currentDate: new Date() });
                            setNextCron(it.next().getTime());
                        }
                        else {
                            logger.warn('cron-parser parseExpression not found');
                        }
                    }
                    catch (e) {
                        logger.warn({ err: e }, 'Failed to compute next cron ts');
                    }
                    // Update next full refresh target based on last full refresh state
                    const fullRefreshHours = config.flags.fullRefreshHours || 24;
                    const lastFull = (await getState('incremental:lastFullRefreshTs')) || 0;
                    const target = lastFull ? (lastFull + fullRefreshHours * 3600_000) : Date.now();
                    setNextFullRefresh(target);
                }
                finally {
                    running = false;
                }
            });
            // initial next cron prediction
            try {
                const parserMod = await import('cron-parser');
                const parseExpression = parserMod.parseExpression || (parserMod.default && parserMod.default.parseExpression);
                if (parseExpression) {
                    const it = parseExpression(config.cron, { currentDate: new Date() });
                    setNextCron(it.next().getTime());
                }
            }
            catch (e) {
                logger.warn({ err: e }, 'Initial next cron compute failed');
            }
            // initial full refresh target
            const fullRefreshHours = config.flags.fullRefreshHours || 24;
            const lastFull = (await getState('incremental:lastFullRefreshTs')) || 0;
            const target = lastFull ? (lastFull + fullRefreshHours * 3600_000) : Date.now();
            setNextFullRefresh(target);
            logger.info({ schedule: config.cron }, 'Cron scheduled');
        }
        else {
            logger.info('CRON_ENABLED is false; cron is disabled');
        }
    }
    catch (err) {
        logger.error({ err }, 'Fatal during bootstrap');
        if (!config.flags.directDb)
            await stopSshTunnel();
        await disconnectMongoose();
        process.exit(1);
    }
}
bootstrap();
process.on('SIGINT', async () => {
    logger.info('Shutting down');
    await disconnectMongoose();
    if (!config.flags.directDb)
        await stopSshTunnel();
    process.exit(0);
});
