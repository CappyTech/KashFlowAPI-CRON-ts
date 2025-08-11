import { getWithRetry } from '../../kashflow/client.js';
import logger from '../../util/logger.js';
// Default sortby is Number per docs
export async function fetchQuotes(page = 1, perpage = 100, params = {}) {
    const raw = await getWithRetry('/quotes', { page, perpage, sortby: 'Number', order: 'Asc', ...params });
    if (page === 1) {
        const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
        logger.info({ keys, rawType: Array.isArray(raw) ? 'array' : typeof raw }, 'Quotes raw response shape');
    }
    let items = [];
    if (Array.isArray(raw))
        items = raw;
    else
        items = raw.Data ?? raw.data ?? raw.items ?? raw.Items ?? [];
    const metaData = raw?.MetaData ?? raw?.metadata ?? raw?.meta ?? {};
    const nextPageUrl = metaData?.NextPageUrl ?? metaData?.nextPageUrl ?? null;
    if (!Array.isArray(items))
        items = [];
    const meta = {
        page: Number(raw?.page ?? raw?.Page ?? page) || page,
        perpage: perpage,
        total: Number(metaData?.TotalRecords ?? metaData?.totalRecords ?? raw?.total ?? raw?.Total ?? 0) || 0,
    };
    logger.info({ page: meta.page, perpage: meta.perpage, total: meta.total, count: items.length }, 'Fetched quotes page');
    return { items: items, ...meta, nextPageUrl: nextPageUrl ?? undefined };
}
