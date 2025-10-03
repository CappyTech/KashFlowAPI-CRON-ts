import { getWithRetry } from '../../kashflow/client.js';
import logger from '../../util/logger.js';

export interface Supplier {
    Id: number;
    Code: string;
    Name: string;
    LastUpdatedDate?: string;
}

export interface Paged<T> { items: T[]; page: number; perpage: number; total: number; nextPageUrl?: string }

export async function fetchSuppliers(page = 1, perpage = 250) {
    // Allowed sortby: Name, Code, TotalPaidAmount, OutstandingBalance
    const raw = await getWithRetry<any>('/suppliers', { page, perpage, sortby: 'Name', order: 'Asc' });
    if (page === 1) {
        const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
        logger.info({ keys, rawType: Array.isArray(raw) ? 'array' : typeof raw }, 'Suppliers raw response shape');
    }
    let items: any = [];
    if (Array.isArray(raw)) items = raw;
    else items = raw.Data ?? raw.data ?? raw.items ?? raw.Items ?? raw.Suppliers ?? raw.suppliers ?? [];
    const metaData = raw?.MetaData ?? raw?.metadata ?? raw?.meta ?? {};
    const nextPageUrl = metaData?.NextPageUrl ?? metaData?.nextPageUrl ?? null;
    if (!Array.isArray(items)) items = [];
    const meta = {
        page: Number(raw?.page ?? raw?.Page ?? page) || page,
        perpage: perpage,
        total: Number(metaData?.TotalRecords ?? metaData?.totalRecords ?? raw?.total ?? raw?.Total ?? 0) || 0,
    };
    const hasNextByCount = items.length === meta.perpage && (meta.total === 0 || (meta.page * meta.perpage) < meta.total);
    logger.info({ page: meta.page, perpage: meta.perpage, total: meta.total, count: items.length, hasNextByCount, nextPageUrl: !!nextPageUrl }, 'Fetched suppliers page');
    return { items: items as Supplier[], ...meta, nextPageUrl: nextPageUrl ?? undefined } as Paged<Supplier>;
}
