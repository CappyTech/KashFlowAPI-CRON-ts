import { getWithRetry } from '../../kashflow/client.js';
import logger from '../../util/logger.js';

export interface Purchase {
    Id: number;
    Number: number;
    SupplierCode?: string;
    IssuedDate?: string;
    DueDate?: string;
    PaidDate?: string | null;
    Status?: string;
}

export interface Paged<T> { items: T[]; page: number; perpage: number; total: number; nextPageUrl?: string }

// Allowed sortby (per docs): Number, Supplierreference, SupplierName, PurchaseDate, PaymentDueDate, GrossAmount, NetAmount, Status, PaidDate
export async function fetchPurchases(page = 1, perpage = 100, params: Partial<Record<string, string | number>> = {}) {
    const raw = await getWithRetry<any>('/purchases', { page, perpage, sortby: 'Number', order: 'Asc', ...params });
    if (page === 1) {
        const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
        logger.info({ keys, rawType: Array.isArray(raw) ? 'array' : typeof raw }, 'Purchases raw response shape');
    }
    let items: any = [];
    if (Array.isArray(raw)) items = raw;
    else items = raw.Data ?? raw.data ?? raw.items ?? raw.Items ?? [];
    const metaData = raw?.MetaData ?? raw?.metadata ?? raw?.meta ?? {};
    const nextPageUrl = metaData?.NextPageUrl ?? metaData?.nextPageUrl ?? null;
    if (!Array.isArray(items)) items = [];
    const meta = {
        page: Number(raw?.page ?? raw?.Page ?? page) || page,
        perpage: perpage,
        total: Number(metaData?.TotalRecords ?? metaData?.totalRecords ?? raw?.total ?? raw?.Total ?? 0) || 0,
    };
    logger.info({ page: meta.page, perpage: meta.perpage, total: meta.total, count: items.length }, 'Fetched purchases page');
    return { items: items as Purchase[], ...meta, nextPageUrl: nextPageUrl ?? undefined } as Paged<Purchase>;
}
