import { getWithRetry } from '../../kashflow/client.js';
import logger from '../../util/logger.js';

export interface NominalSummary {
  Id: number;
  Code: number;
  Name?: string;
  Type?: string;
  NomType?: number;
  Sa103Code?: number;
  DefaultProduct?: any;
  Disallowed?: boolean;
  ComplianceCode?: string;
  Archived?: boolean;
  DigitalService?: boolean;
  IsProduct?: number;
  AutoFillLineItem?: boolean;
  Price?: number;
  WholeSalePrice?: number;
  VATRate?: number;
  VATExempt?: boolean;
  Description?: string;
  Special?: number;
  Classification?: string;
  ControlAccountClassification?: string;
  AllowDelete?: boolean;
  PlOption?: number;
  BsOption?: number;
  IRISCoAName?: string;
  IsIRISCoA?: boolean;
  ManageStockLevel?: boolean;
  QuantityInStock?: number;
  StockWarningQuantity?: number;
}

export interface Paged<T> { items: T[]; page: number; perpage: number; total: number; nextPageUrl?: string }

export async function fetchNominals(page = 1, perpage = 250, nextUrl?: string) {
  const raw = nextUrl
    ? await getWithRetry<any>(nextUrl)
    : await getWithRetry<any>('/nominals', { page, perpage, order: 'Asc' });
  if (page === 1) {
    const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
    logger.info({ keys, rawType: Array.isArray(raw) ? 'array' : typeof raw }, 'Nominals raw response shape');
  }
  let items: any = [];
  if (Array.isArray(raw)) items = raw; else items = raw.Data ?? raw.data ?? raw.items ?? raw.Items ?? raw.records ?? [];
  const metaData = raw?.MetaData ?? raw?.metadata ?? raw?.meta ?? {};
  const nextPageUrl = metaData?.NextPageUrl ?? metaData?.nextPageUrl ?? null;
  if (!Array.isArray(items)) items = [];
  const meta = {
    page: Number(raw?.page ?? raw?.Page ?? page) || page,
    perpage: perpage,
    total: Number(metaData?.TotalRecords ?? metaData?.totalRecords ?? raw?.total ?? raw?.Total ?? 0) || 0,
  };
  const hasNextByCount = items.length === meta.perpage && (meta.total === 0 || (meta.page * meta.perpage) < meta.total);
  logger.info({ page: meta.page, perpage: meta.perpage, total: meta.total, count: items.length, hasNextByCount, nextPageUrl: !!nextPageUrl }, 'Fetched nominals page');
  return { items: items as NominalSummary[], ...meta, nextPageUrl: nextPageUrl ?? undefined } as Paged<NominalSummary>;
}

// Optional detail by id if needed; list appears to carry full objects already
export async function fetchNominalDetailById(id: number) {
  const raw = await getWithRetry<any>(`/nominals/${id}`);
  return raw;
}
