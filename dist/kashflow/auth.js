import axios from 'axios';
import { config } from '../config.js';
import logger from '../util/logger.js';
let sessionToken = null;
let lastAuthAt = 0;
export async function getSessionToken() {
    const now = Date.now();
    if (sessionToken && now - lastAuthAt < 45 * 60 * 1000)
        return sessionToken;
    // Step 1: POST to get TemporaryToken
    const postResp = await axios.post(`${config.kashflow.baseUrl}/sessiontoken`, {
        username: config.kashflow.username,
        password: config.kashflow.password,
    }, { timeout: config.kashflow.timeoutMs });
    const tempToken = postResp.data?.TemporaryToken;
    const rawList = postResp.data?.MemorableWordList;
    let positions = [];
    if (Array.isArray(rawList)) {
        positions = rawList
            .map((x) => (typeof x === 'number' ? x : x?.Position ?? x?.position ?? x?.pos))
            .filter((n) => Number.isFinite(n));
    }
    if (!tempToken || !positions?.length) {
        throw new Error('Unexpected session token POST response');
    }
    const mw = String(config.kashflow.memorableWord);
    const list = positions.map((pos) => {
        if (pos < 1 || pos > mw.length) {
            throw new Error(`Memorable word position out of range: ${pos} (word length ${mw.length})`);
        }
        return { Position: pos, Value: mw.charAt(pos - 1) };
    });
    logger.info({ positions: list.map((x) => ({ Position: x.Position, Value: '' })), mwLength: mw.length }, 'KashFlow requested memorable word positions');
    // Step 2: PUT with letters
    let putResp;
    try {
        putResp = await axios.put(`${config.kashflow.baseUrl}/sessiontoken`, {
            TemporaryToken: tempToken,
            MemorableWordList: list,
        }, { timeout: config.kashflow.timeoutMs });
    }
    catch (e) {
        const data = e?.response?.data;
        logger.error({ status: e?.response?.status, data }, 'KashFlow session token PUT failed');
        throw e;
    }
    sessionToken = putResp.data.SessionToken;
    lastAuthAt = now;
    logger.info('Obtained KashFlow session token');
    return sessionToken;
}
export function invalidateSessionToken() {
    sessionToken = null;
}
