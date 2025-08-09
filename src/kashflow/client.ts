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
    return pRetry(
        async () => {
            try {
                const resp = await api.get<T>(url, { params });
                return resp.data as T;
            } catch (err) {
                const ax = err as AxiosError;
                const status = ax.response?.status;
                if (status && status >= 500) {
                    logger.warn({ status, url }, 'Server error, retrying');
                    throw err;
                }
                if (ax.code === 'ECONNABORTED' || ax.code === 'ETIMEDOUT') {
                    logger.warn({ code: ax.code, url }, 'Timeout, retrying');
                    throw err;
                }
                throw new AbortError(ax);
            }
        },
        { retries: 3, factor: 2, minTimeout: 1000 }
    );
}
