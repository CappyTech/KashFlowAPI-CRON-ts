import axios, { AxiosInstance } from 'axios';
import logger from '../util/logger.js';
import { config } from '../config.js';

export type PaperlessDocument = {
  id: number;
  title: string;
  correspondent?: number | null;
  created?: string;
  added?: string;
  tags?: number[];
  download_url?: string; // convenience
  preview_url?: string;
  original_file_name?: string;
  archive_filename?: string;
  content?: string;
};

function client(): AxiosInstance | null {
  if (!config.paperless?.enabled) return null;
  if (!config.paperless.baseUrl || !config.paperless.token) {
    logger.warn('Paperless enabled but baseUrl/token missing');
    return null;
  }
  return axios.create({
    baseURL: config.paperless.baseUrl.replace(/\/$/, '') + '/api',
    timeout: config.paperless.timeoutMs || 15000,
    headers: { Authorization: `Token ${config.paperless.token}` },
  });
}

export async function findDocumentByPurchaseNumber(number: number): Promise<PaperlessDocument | null> {
  const c = client();
  if (!c) return null;
  try {
    // Search term: the purchase number, relying on Paperless full-text search (q=)
    const r = await c.get('/documents/', { params: { q: String(number), page_size: 5, ordering: '-created' } });
    const results = r.data?.results || [];
    if (!Array.isArray(results) || !results.length) return null;
    const doc = results[0];
    // Normalize URLs for convenience if present
    if (doc && typeof doc === 'object') {
      const base = config.paperless!.baseUrl!.replace(/\/$/, '');
      if (doc.download_url && !/^https?:/i.test(doc.download_url)) doc.download_url = base + doc.download_url;
      if (doc.preview_url && !/^https?:/i.test(doc.preview_url)) doc.preview_url = base + doc.preview_url;
    }
    return doc as PaperlessDocument;
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'Paperless query failed');
    return null;
  }
}
