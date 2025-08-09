import type { Server } from 'net';
import type { Client } from 'ssh2';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// tunnel-ssh is CommonJS with a named export `createTunnel`
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTunnel } = require('tunnel-ssh') as {
    createTunnel: (
        tunnelOptions: any,
        serverOptions: any,
        sshOptions: any,
        forwardOptions: any
    ) => Promise<[Server, Client]>
};
import { config } from './config.js';
import logger from './util/logger.js';

let server: Server | null = null;
let sshConn: Client | null = null;
let chosenLocalPort: number | null = null;

export async function startSshTunnel(): Promise<Server> {
    if (config.flags.directDb) {
        logger.info('DIRECT_DB=true; skipping SSH tunnel');
        // Fake values to keep downstream code expecting a port happy
        chosenLocalPort = config.mongo.port;
        // Return a dummy server-like object to satisfy types (not used)
        return {} as Server;
    }
    if (server) return server;
    const sshOptions = {
        host: config.ssh.host,
        port: config.ssh.port,
        username: config.ssh.username,
        password: config.ssh.password,
        readyTimeout: 20000,
    };
    const forwardOptions = { dstAddr: config.ssh.dstHost, dstPort: config.ssh.dstPort };
    const tunnelOptions = { autoClose: true, reconnectOnError: true };

    // Try base port and a few increments if needed
    let lastErr: any;
    for (let offset = 0; offset <= 10; offset++) {
        const port = config.ssh.localPort + offset;
        const serverOptions = { host: config.ssh.localHost, port };
        try {
            const [srv, conn] = await createTunnel(tunnelOptions, serverOptions, sshOptions, forwardOptions);
            server = srv;
            sshConn = conn;
            chosenLocalPort = port;
            logger.info(
                { local: `${serverOptions.host}:${serverOptions.port}`, remote: `${forwardOptions.dstAddr}:${forwardOptions.dstPort}` },
                'SSH tunnel established'
            );
            return server;
        } catch (e: any) {
            lastErr = e;
            if (e?.code === 'EADDRINUSE') {
                logger.warn({ port }, 'Local port in use; trying next');
                continue;
            }
            throw e;
        }
    }
    throw lastErr ?? new Error('Failed to establish SSH tunnel');
}

export async function stopSshTunnel() {
    if (server) {
        try {
            server.close();
            logger.info('SSH tunnel closed');
        } catch (e) {
            logger.warn({ err: e }, 'Error closing SSH tunnel');
        } finally {
            server = null;
        }
    }
    try {
        sshConn?.end();
    } catch { }
    sshConn = null;
}

export function getTunnelLocalPort(): number {
    return chosenLocalPort ?? config.ssh.localPort;
}
