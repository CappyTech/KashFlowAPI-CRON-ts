import { getWithRetry } from '../../kashflow/client.js';
import logger from '../../util/logger.js';
export async function fetchSuppliers(page = 1, perpage = 250) {
    // Allowed sortby: Name, Code, TotalPaidAmount, OutstandingBalance
    const raw = await getWithRetry('/suppliers', { page, perpage, sortby: 'Name', order: 'Asc' });
    if (page === 1) {
        const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
        logger.info({ keys, rawType: Array.isArray(raw) ? 'array' : typeof raw }, 'Suppliers raw response shape');
    }
    let items = [];
    if (Array.isArray(raw))
        items = raw;
    else
        items = raw.Data ?? raw.data ?? raw.items ?? raw.Items ?? raw.Suppliers ?? raw.suppliers ?? [];
    const metaData = raw?.MetaData ?? raw?.metadata ?? raw?.meta ?? {};
    const nextPageUrl = metaData?.NextPageUrl ?? metaData?.nextPageUrl ?? null;
    if (!Array.isArray(items))
        items = [];
    const meta = {
        page: Number(raw?.page ?? raw?.Page ?? page) || page,
        perpage: perpage,
        total: Number(metaData?.TotalRecords ?? metaData?.totalRecords ?? raw?.total ?? raw?.Total ?? 0) || 0,
    };
    logger.info({ page: meta.page, perpage: meta.perpage, total: meta.total, count: items.length }, 'Fetched suppliers page');
    return { items: items, ...meta, nextPageUrl: nextPageUrl ?? undefined };
}
