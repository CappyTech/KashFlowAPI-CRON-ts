import axios, { AxiosError } from 'axios';
import pRetry, { AbortError } from 'p-retry';
import { StatusCodes } from 'http-status-codes';
import { config } from '../config.js';
import logger from '../util/logger.js';
import { getSessionToken, invalidateSessionToken } from './auth.js';

export const api = axios.create({
    baseURL: config.kashflow.baseUrl,
    timeout: config.kashflow.timeoutMs,
});

api.interceptors.request.use(async (req) => {
    const token = await getSessionToken();
    req.headers = req.headers || {};
    req.headers['Authorization'] = `KfToken ${token}`;
    return req;
});

api.interceptors.response.use(
    (res) => res,
    async (error: AxiosError) => {
        if (error.response?.status === StatusCodes.UNAUTHORIZED) {
            invalidateSessionToken();
        }
        throw error;
    }
);

export async function getWithRetry<T>(url: string, params?: Record<string, any>): Promise<T> {
    let attempt = 0;
    return pRetry(
        async () => {
            attempt += 1;
            try {
                const resp = await api.get<T>(url, { params });
                return resp.data as T;
            } catch (err) {
                const ax = err as AxiosError;
                const status = ax.response?.status;
                const code = ax.code;
                // 5xx are transient
                if (status && status >= 500) {
                    logger.warn({ status, url, attempt }, 'Server error, retrying');
                    throw err;
                }
                // 429 - Too Many Requests: respect Retry-After if present
                if (status === 429) {
                    const ra = ax.response?.headers?.['retry-after'];
                    let waitMs = 2000;
                    if (ra) {
                        const secs = Number(ra);
                        if (!Number.isNaN(secs) && secs > 0) {
                            waitMs = secs * 1000;
                        } else {
                            const when = new Date(String(ra));
                            const delta = when.getTime() - Date.now();
                            if (!Number.isNaN(when.getTime()) && delta > 0) waitMs = Math.max(2000, delta);
                        }
                    }
                    logger.warn({ status, url, attempt, waitMs }, 'Rate limited, retrying');
                    await new Promise(r => setTimeout(r, waitMs));
                    throw err;
                }
                // Timeouts and common network errors
                if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
                    logger.warn({ code, url, attempt }, 'Network error, retrying');
                    throw err;
                }
                // Non-retriable
                throw new AbortError(ax);
            }
        },
        { retries: 5, factor: 2, minTimeout: 1000, randomize: true }
    );
}
