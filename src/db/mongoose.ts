import mongoose from 'mongoose';
import logger from '../util/logger.js';
import { config } from '../config.js';
import { getTunnelLocalPort } from '../sshTunnel.js';

function sanitizeMongoUri(uri: string): string {
    // Remove credentials between scheme and '@'
    const match = uri.match(/^(mongodb(?:\+srv)?:\/\/)([^@]+)@(.+)$/i);
    if (match) {
        return `${match[1]}***@${match[3]}`;
    }
    return uri;
}

export async function connectMongoose() {
    let host: string;
    let port: number;
    if (config.flags.directDb) {
        host = config.mongo.host;
        port = config.mongo.port;
    } else {
        host = config.ssh.localHost;
        port = getTunnelLocalPort();
    }
    const creds = config.mongo.user && config.mongo.pass ? `${encodeURIComponent(config.mongo.user)}:${encodeURIComponent(config.mongo.pass)}@` : '';
    const uri = `mongodb://${creds}${host}:${port}/${config.mongo.dbName}?authSource=admin`;
    const safeUri = sanitizeMongoUri(uri);
    logger.info({ uri: safeUri, direct: config.flags.directDb }, config.flags.directDb ? 'Connecting to MongoDB directly' : 'Connecting to MongoDB via SSH local forward');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    logger.info('MongoDB connected');
}

export async function disconnectMongoose() {
    await mongoose.disconnect();
}

export default mongoose;
