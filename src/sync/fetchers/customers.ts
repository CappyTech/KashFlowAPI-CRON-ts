import { getWithRetry } from '../../kashflow/client.js';
import logger from '../../util/logger.js';

export interface Customer {
    Id: number;
    Code: string;
    Name: string;
    LastUpdatedDate?: string;
}

export interface Paged<T> { items: T[]; page: number; perpage: number; total: number; nextPageUrl?: string }

export async function fetchCustomers(page = 1, perpage = 100, nextUrl?: string) {
    // KashFlow supports page/perpage; allowed sortby: Code, Name, TotalPaidAmount, OutstandingBalance
    const raw = nextUrl
        ? await getWithRetry<any>(nextUrl)
        : await getWithRetry<any>('/customers', { page, perpage, sortby: 'Code', order: 'Asc' });
    if (page === 1) {
        const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
        logger.info({ keys, rawType: Array.isArray(raw) ? 'array' : typeof raw }, 'Customers raw response shape');
    }
    let items: any = [];
    if (Array.isArray(raw)) items = raw;
    else items = raw.Data ?? raw.data ?? raw.items ?? raw.Items ?? raw.customers ?? raw.Customers ?? raw.CustomersList ?? [];
    const metaData = raw?.MetaData ?? raw?.metadata ?? raw?.meta ?? {};
    const nextPageUrl = metaData?.NextPageUrl ?? metaData?.nextPageUrl ?? null;
    if (!Array.isArray(items)) items = [];
    const meta = {
        page: Number(raw?.page ?? raw?.Page ?? page) || page,
        perpage: perpage,
        total: Number(metaData?.TotalRecords ?? metaData?.totalRecords ?? raw?.total ?? raw?.Total ?? raw?.totalCount ?? raw?.TotalCount ?? 0) || 0,
    };
    logger.info({ page: meta.page, perpage: meta.perpage, total: meta.total, count: items.length }, 'Fetched customers page');
    return { items: items as Customer[], ...meta, nextPageUrl: nextPageUrl ?? undefined } as Paged<Customer>;
}

// Single: GET /customers/{code} → full customer details
export async function fetchCustomerDetailByCode(code: string) {
    const raw = await getWithRetry<any>(`/customers/${encodeURIComponent(code)}`);
    return raw;
}
