import { getWithRetry } from '../../kashflow/client.js';
import logger from '../../util/logger.js';

export interface ProjectSummary {
    Number: number;
    Name?: string;
    CustomerId?: number;
    CustomerName?: string;
    StartDate?: string;
    EndDate?: string;
    Status?: number;
    StatusName?: string;
}

export interface Paged<T> { items: T[]; page: number; perpage: number; total: number; nextPageUrl?: string; isUnpaged?: boolean }

// The list is ordered by Number asc per docs; projects may not be paginated in all tenants, but handle Data/MetaData if present
export async function fetchProjects(page = 1, perpage = 100, params: Partial<Record<string, string | number>> = {}, nextUrl?: string) {
    const raw = nextUrl
        ? await getWithRetry<any>(nextUrl)
        : await getWithRetry<any>('/projects', { page, perpage, sortby: 'Number', order: 'Asc', ...params });
    if (page === 1) {
        const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
        logger.info({ keys, rawType: Array.isArray(raw) ? 'array' : typeof raw }, 'Projects raw response shape');
    }
    // Projects list may be a plain array (per docs example) or an envelope with Data/MetaData depending on env
    let items: any = [];
    const isUnpaged = Array.isArray(raw);
    if (isUnpaged) items = raw;
    else items = raw.Data ?? raw.data ?? raw.items ?? raw.Items ?? [];
    const metaData = raw?.MetaData ?? raw?.metadata ?? raw?.meta ?? {};
    const nextPageUrl = isUnpaged ? null : (metaData?.NextPageUrl ?? metaData?.nextPageUrl ?? null);
    if (!Array.isArray(items)) items = [];
    const total = isUnpaged ? items.length : (Number(metaData?.TotalRecords ?? raw?.Total ?? items.length) || items.length);
    const effectivePerPage = isUnpaged ? items.length : perpage;
    const meta = { page, perpage: effectivePerPage, total };
    logger.info({ page: meta.page, perpage: meta.perpage, total: meta.total, count: items.length }, 'Fetched projects page');
    return { items: items as ProjectSummary[], ...meta, nextPageUrl: nextPageUrl ?? undefined, isUnpaged } as Paged<ProjectSummary>;
}

// Single: GET /project/{number} → full project details
export async function fetchProjectDetailByNumber(number: number) {
    // Note: endpoint is singular per docs
    const raw = await getWithRetry<any>(`/project/${number}`);
    return raw;
}
