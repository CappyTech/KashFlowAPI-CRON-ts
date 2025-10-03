import { Mutex } from 'async-mutex';
import logger from '../util/logger.js';
import { getState, setState } from './state.js';
import config from '../config.js';
import { fetchCustomers } from './fetchers/customers.js';
import { fetchSuppliers } from './fetchers/suppliers.js';
import { fetchPurchases, fetchPurchaseDetailByPermalink, fetchPurchaseDetailById, fetchPurchaseDetailByNumber } from './fetchers/purchases.js';
import { fetchInvoices } from './fetchers/invoices.js';
import { fetchQuotes } from './fetchers/quotes.js';
import { fetchProjects } from './fetchers/projects.js';
import { CustomerModel, SupplierModel, PurchaseModel, InvoiceModel, QuoteModel, ProjectModel, UpsertLogModel } from '../db/models.js';
import { markSyncStart, setLastSummary, EntitySummaryBase } from './summary.js';
import { SyncSummaryModel } from '../db/models.js';

const mutex = new Mutex();
const DIFF_FIELD_LIMIT = 40;

// Narrow shape for updateOne results (enough to eliminate @ts-ignore usage)
type UpdateResultLike = {
    acknowledged?: boolean;
    matchedCount?: number;
    modifiedCount?: number;
    upsertedCount?: number;
    upsertedId?: unknown;
    upsertedIds?: unknown[];
};

// Shallow-merge specific nested object fields to preserve existing keys when the API omits them.
// Arrays are left as-is (replaced). Only merges plain objects for the provided keys.
function mergeNestedObjects<T extends Record<string, any>>(existing: any | null | undefined, incoming: T, keys: string[]): T {
    if (!existing) return incoming;
    const out = { ...incoming } as Record<string, any>;
    for (const k of keys) {
        const prev = existing?.[k];
        const next = incoming?.[k];
        if (!prev || !next) continue;
        if (Array.isArray(prev) || Array.isArray(next)) continue;
        if (typeof prev === 'object' && typeof next === 'object') {
            out[k] = { ...prev, ...next };
        }
    }
    return out as T;
}

function diffDocs(before: Record<string, any> | null | undefined, after: Record<string, any> | null | undefined) {
    if (!after) return { changedFields: [] as string[], changes: {} as Record<string, { before: any; after: any }> };
    if (!before) {
        const keys = Object.keys(after).slice(0, DIFF_FIELD_LIMIT);
        return {
            changedFields: keys,
            changes: Object.fromEntries(keys.map(k => [k, { before: undefined, after: (after as any)[k] }]))
        };
    }
    const changedFields: string[] = [];
    const changes: Record<string, { before: any; after: any }> = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
        // Skip volatile / metadata fields we don't want to treat as business diffs
        if (['updatedAt', 'createdAt', 'deletedAt', 'lastSeenRun', '_id', '__v'].includes(k)) continue;
        // Skip other underscore-prefixed housekeeping keys (excluding _id/__v already handled above)
        if (k.startsWith('_') && !['_id', '__v'].includes(k)) continue;
        const hasAfter = Object.prototype.hasOwnProperty.call(after, k);
        // If the updated doc does NOT include this key, treat it as untouched (avoid phantom removals like field -> undefined)
        if (!hasAfter) continue;
        const bv = (before as any)[k];
        const av = (after as any)[k];
        // Fast path primitive / reference equality first
        if (bv === av) continue;
        // Fallback deep-ish compare via JSON for simple serialisable values
        try {
            if (JSON.stringify(bv) === JSON.stringify(av)) continue;
        } catch { /* ignore stringify issues and treat as changed */ }
        changedFields.push(k);
        if (changedFields.length >= DIFF_FIELD_LIMIT) {
            changes[k] = { before: bv, after: av }; // capture last triggering field
            break;
        }
        changes[k] = { before: bv, after: av };
    }
    return { changedFields, changes };
}

export async function runSync() {
    return mutex.runExclusive(async () => {
        const start = Date.now();
        const startIso = new Date().toISOString();
        logger.info('Sync started');
        markSyncStart();
        const entities: EntitySummaryBase[] = [];
        let overallError: any = null;
        try {
            // Determine if this run should force a full refresh for incremental entities (option 1 strategy)
            const now = Date.now();
            const fullRefreshHours = config.flags.fullRefreshHours || 24;
            const fullRefreshMs = fullRefreshHours * 3600_000;
            const lastFullRefreshTs = (await getState<number>('incremental:lastFullRefreshTs')) || 0;
            const doFullRefreshIncrementals = (now - lastFullRefreshTs) >= fullRefreshMs;
            if (doFullRefreshIncrementals) {
                logger.info({ fullRefreshHours }, 'Performing scheduled full refresh for incremental entities');
            }

            // === Customers Sync ===
            // Paged full traversal with cursor; soft-delete only when starting at page 1
            const custStart = Date.now();
            const runIdCustomers = new Date().toISOString();
            const lastCursorCust = (await getState<number>('customers:lastPage')) || 0;
            let pageCust = lastCursorCust || 1;
            const perpageCust = 100;
            const fullTraverseCustomers = pageCust === 1;
            let fetchedCust = 0;
            let upsertedCust = 0;
            let totalCust = 0;
            let completedFullCust = false;
            let pagesCust = 0;
            let softDeletedCust = 0;
            let purchasesWithLineItems = 0;
            let purchasesNeedingDetail = 0;
            let detailFromPermalink = 0;
            let detailFromId = 0;
            let detailFromNumber = 0;
            while (true) {
                const res = await fetchCustomers(pageCust, perpageCust);
                const items = res.items || [];
                pagesCust += 1;
                fetchedCust += items.length;
                totalCust = res.total || totalCust;
                if (config.flags.progressLogs) {
                    const pct = totalCust ? Math.min(100, (fetchedCust / totalCust) * 100) : 0;
                    logger.info({ entity: 'customers', page: pageCust, pageSize: items.length, cumulative: fetchedCust, total: totalCust, pct: Number(pct.toFixed(2)) }, 'Customers progress');
                }
                for (const c of items) {
                    const existing = await CustomerModel.findOne({ Code: c.Code }).lean();
                    let updateDoc = {
                        ...c,
                        LastUpdatedDate: c.LastUpdatedDate ? new Date(c.LastUpdatedDate) : undefined,
                        CreatedDate: (c as any).CreatedDate ? new Date((c as any).CreatedDate as any) : (c as any).CreatedDate,
                        FirstInvoiceDate: (c as any).FirstInvoiceDate ? new Date((c as any).FirstInvoiceDate as any) : (c as any).FirstInvoiceDate,
                        LastInvoiceDate: (c as any).LastInvoiceDate ? new Date((c as any).LastInvoiceDate as any) : (c as any).LastInvoiceDate,
                        updatedAt: new Date(),
                        lastSeenRun: runIdCustomers,
                    } as any;
                    updateDoc = mergeNestedObjects(existing, updateDoc, ['Currency', 'PaymentTerms', 'Address', 'DeliveryAddress']);
                    // Preserve uuid so diffDocs doesn't treat it as removed
                    if (existing?.uuid) updateDoc.uuid = existing.uuid;
                    const { changedFields, changes } = diffDocs(existing, updateDoc);
                    const res = await CustomerModel.updateOne(
                        { Code: c.Code },
                        {
                            $set: updateDoc,
                            $setOnInsert: { createdAt: new Date(), deletedAt: null },
                        },
                        { upsert: true, setDefaultsOnInsert: true }
                    );
                    const r1 = res as unknown as UpdateResultLike;
                    const wasInserted = r1.upsertedCount === 1 || (Array.isArray(r1.upsertedIds) && r1.upsertedIds.length > 0) || !!r1.upsertedId;
                    if (wasInserted) upsertedCust += 1; else if (res.modifiedCount) upsertedCust += 1; // treat modifications as upserts for count visibility
                    if (wasInserted || changedFields.length > 0) {
                        try {
                            await UpsertLogModel.create({ entity: 'customers', key: c.Code, op: wasInserted ? 'insert' : 'update', runId: runIdCustomers, modifiedCount: (res as any).modifiedCount, upsertedId: (res as any).upsertedId, changedFields, changes });
                        } catch (e) {
                            if (config.flags.upsertLogs) logger.debug({ err: e }, 'Failed to write customer upsert log');
                        }
                    }
                    if (config.flags.upsertLogs) {
                        logger.debug({ entity: 'customers', code: c.Code, wasInserted, modifiedCount: (res as any).modifiedCount }, 'Customer upsert');
                    }
                }
                if (items.length === 0 && pageCust > 1) {
                    // End reached; mark traversal completed only if started at page 1
                    completedFullCust = fullTraverseCustomers;
                    await setState('customers:lastPage', 0);
                    break;
                }
                await setState('customers:lastPage', pageCust);
                if (res.nextPageUrl) {
                    pageCust += 1;
                } else {
                    // No next page reported: traversal complete
                    completedFullCust = fullTraverseCustomers;
                    await setState('customers:lastPage', 0);
                    break;
                }
            }
            if (fetchedCust > 0 && completedFullCust) {
                const resSD = await CustomerModel.updateMany(
                    { $or: [{ lastSeenRun: { $ne: runIdCustomers } }, { lastSeenRun: { $exists: false } }], deletedAt: null },
                    { $set: { deletedAt: new Date(), updatedAt: new Date() } }
                );
                const rSD = resSD as unknown as UpdateResultLike;
                softDeletedCust = (rSD && (rSD.modifiedCount ?? 0)) as number;
            }
            const custMs = Date.now() - custStart;
            logger.info({ pages: pagesCust, fetched: fetchedCust, processed: fetchedCust, upserted: upsertedCust, total: totalCust, softDeleted: softDeletedCust, ms: custMs }, 'Customers sync completed');
            entities.push({ entity: 'customers', pages: pagesCust, fetched: fetchedCust, processed: fetchedCust, upserted: upsertedCust, total: totalCust, softDeleted: softDeletedCust, ms: custMs });
            // Compare DB vs API totals only when we performed a full traversal (safe for soft-deletes)
            if (completedFullCust) {
                try {
                    const dbCountCust = await CustomerModel.countDocuments({ $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] });
                    if (typeof totalCust === 'number' && totalCust > 0 && dbCountCust !== totalCust) {
                        logger.warn({ dbCountCust, apiTotal: totalCust }, 'Customers count mismatch (Mongo vs API)');
                    } else {
                        logger.info({ dbCountCust, apiTotal: totalCust }, 'Customers count check OK');
                    }
                } catch (e) {
                    logger.warn({ err: e }, 'Customers count check failed');
                }
            }

            // === Suppliers Sync ===
            // Paged traversal, wrap-around if started mid-list
            const supStart = Date.now();
            const runIdSup = new Date().toISOString();
            const lastCursorSup = (await getState<number>('suppliers:lastPage')) || 0;
            let pageSup = lastCursorSup || 1;
            const perpageSup = 250;
            const fullTraverseSuppliers = pageSup === 1;
            let fetchedSup = 0;
            let upsertedSupCount = 0;
            let totalSup = 0;
            const initialPageSup = pageSup;
            let loopedSup = false;
            let completedFullSup = false;
            let pagesSup = 0;
            let softDeletedSup = 0;
            while (true) {
                const res = await fetchSuppliers(pageSup, perpageSup);
                const items = res.items || [];
                pagesSup += 1;
                fetchedSup += items.length;
                totalSup = res.total || totalSup;
                if (config.flags.progressLogs) {
                    const pct = totalSup ? Math.min(100, (fetchedSup / totalSup) * 100) : 0;
                    logger.info({ entity: 'suppliers', page: pageSup, pageSize: items.length, cumulative: fetchedSup, total: totalSup, pct: Number(pct.toFixed(2)), looped: loopedSup }, 'Suppliers progress');
                }
                for (const s of items) {
                    const existingSup = await SupplierModel.findOne({ Code: s.Code }).lean();
                    let updateSup = { ...s, LastUpdatedDate: s.LastUpdatedDate ? new Date(s.LastUpdatedDate) : undefined, updatedAt: new Date(), lastSeenRun: runIdSup } as any;
                    updateSup = mergeNestedObjects(existingSup, updateSup, ['Currency', 'PaymentTerms', 'Address']);
                    if (existingSup?.uuid) updateSup.uuid = (existingSup as any).uuid;
                    const { changedFields: changedFieldsSup, changes: changesSup } = diffDocs(existingSup, updateSup);
                    const res = await SupplierModel.updateOne(
                        { Code: s.Code },
                        { $set: updateSup, $setOnInsert: { createdAt: new Date(), deletedAt: null } },
                        { upsert: true, setDefaultsOnInsert: true }
                    );
                    const r2 = res as unknown as UpdateResultLike;
                    const wasInserted = r2.upsertedCount === 1 || (Array.isArray(r2.upsertedIds) && r2.upsertedIds.length > 0) || !!r2.upsertedId;
                    if (wasInserted) upsertedSupCount += 1; else if (res.modifiedCount) upsertedSupCount += 1;
                    if (wasInserted || changedFieldsSup.length > 0) {
                        try {
                            await UpsertLogModel.create({ entity: 'suppliers', key: s.Code, op: wasInserted ? 'insert' : 'update', runId: runIdSup, modifiedCount: (res as any).modifiedCount, upsertedId: (res as any).upsertedId, changedFields: changedFieldsSup, changes: changesSup });
                        } catch (e) { if (config.flags.upsertLogs) logger.debug({ err: e }, 'Failed to write supplier upsert log'); }
                    }
                    if (config.flags.upsertLogs) {
                        logger.debug({ entity: 'suppliers', code: s.Code, wasInserted, modifiedCount: (res as any).modifiedCount }, 'Supplier upsert');
                    }
                }
                const isPartial = items.length < perpageSup;
                const exhaustedTotal = fetchedSup >= totalSup && totalSup > 0;
                if (items.length === 0 && pageSup > 1) {
                    // Went past the last page; if we haven't looped and didn't start at page 1, wrap to beginning.
                    if (!loopedSup && initialPageSup > 1) {
                        loopedSup = true;
                        pageSup = 1;
                        continue;
                    }
                    completedFullSup = true;
                    await setState('suppliers:lastPage', 0);
                    break;
                }
                // Persist progress for observability (so restarts don’t repeat too much)
                await setState('suppliers:lastPage', pageSup);
                if (res.nextPageUrl) {
                    pageSup += 1;
                } else {
                    // Last page reached; if started mid-list and not yet looped, wrap to page 1 and continue up to initial page - 1
                    if (!loopedSup && initialPageSup > 1 && !(isPartial || exhaustedTotal)) {
                        loopedSup = true;
                        pageSup = 1;
                        continue;
                    }
                    completedFullSup = true;
                    await setState('suppliers:lastPage', 0);
                    break;
                }
                if (isPartial || exhaustedTotal) {
                    completedFullSup = true;
                    await setState('suppliers:lastPage', 0);
                    break;
                }
                if (loopedSup && pageSup >= initialPageSup) {
                    // We’ve completed wrap-around up to the starting page; finish
                    completedFullSup = true;
                    await setState('suppliers:lastPage', 0);
                    break;
                }
            }
            if (fetchedSup > 0 && completedFullSup) {
                const resSD = await SupplierModel.updateMany(
                    { $or: [{ lastSeenRun: { $ne: runIdSup } }, { lastSeenRun: { $exists: false } }], deletedAt: null },
                    { $set: { deletedAt: new Date(), updatedAt: new Date() } }
                );
                const rSupSD = resSD as unknown as UpdateResultLike;
                softDeletedSup = (rSupSD && (rSupSD.modifiedCount ?? 0)) as number;
            }
            const supMs = Date.now() - supStart;
            logger.info({ pages: pagesSup, fetched: fetchedSup, processed: fetchedSup, upserted: upsertedSupCount, total: totalSup, softDeleted: softDeletedSup, ms: supMs }, 'Suppliers sync completed');
            entities.push({ entity: 'suppliers', pages: pagesSup, fetched: fetchedSup, processed: fetchedSup, upserted: upsertedSupCount, total: totalSup, softDeleted: softDeletedSup, ms: supMs });
            // Suppliers traverse fully each run (wrap-around). Compare Mongo vs API totals.
            try {
                const dbCountSup = await SupplierModel.countDocuments({ $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] });
                if (typeof totalSup === 'number' && totalSup > 0 && dbCountSup !== totalSup) {
                    logger.warn({ dbCountSup, apiTotal: totalSup }, 'Suppliers count mismatch (Mongo vs API)');
                } else {
                    logger.info({ dbCountSup, apiTotal: totalSup }, 'Suppliers count check OK');
                }
            } catch (e) {
                logger.warn({ err: e }, 'Suppliers count check failed');
            }

            // === Invoices Sync ===
            // Incremental by max Number, paged
            const invStart = Date.now();
            const runIdInv = new Date().toISOString();
            let lastMaxInv = (await getState<number>('invoices:lastMaxNumber')) || 0;
            if (!lastMaxInv) {
                const doc = await InvoiceModel.findOne({}, { Number: 1 }).sort({ Number: -1 }).lean();
                lastMaxInv = (doc?.Number as number) || 0;
                if (lastMaxInv) await setState('invoices:lastMaxNumber', lastMaxInv);
            }
            let pageInv = 1;
            const perpageInv = 50; // reduce to lower payload size and mitigate timeouts
            let fetchedInv = 0;
            let totalInv = 0;
            let newMaxInv = lastMaxInv;
            let reachedOldInv = false;
            let upsertedInv = 0;
            let pagesInv = 0;
            let stoppedReasonInv: string | undefined;
            while (true) {
                const res = await fetchInvoices(pageInv, perpageInv, { order: 'Desc' });
                const items = res.items || [];
                pagesInv += 1;
                fetchedInv += items.length;
                totalInv = res.total || totalInv;
                for (const i of items) {
                    if (i.Number && i.Number > newMaxInv) newMaxInv = i.Number;
                    if (!doFullRefreshIncrementals && i.Number && i.Number <= lastMaxInv) { reachedOldInv = true; continue; }
                    const existingInv = await InvoiceModel.findOne({ Number: i.Number }).lean();
                    let updateInv = { ...i, IssuedDate: i.IssuedDate ? new Date(i.IssuedDate) : undefined, DueDate: i.DueDate ? new Date(i.DueDate) : undefined, LastPaymentDate: i.LastPaymentDate ? new Date(i.LastPaymentDate) : i.LastPaymentDate, PaidDate: i.PaidDate ? new Date(i.PaidDate) : i.PaidDate, updatedAt: new Date(), lastSeenRun: runIdInv } as any;
                    updateInv = mergeNestedObjects(existingInv, updateInv, ['Currency', 'DeliveryAddress', 'Address']);
                    if (existingInv?.uuid) updateInv.uuid = (existingInv as any).uuid; else updateInv.uuid = `invoice:${i.Number}`; // match $setOnInsert for diff visibility
                    const { changedFields: changedFieldsInv, changes: changesInv } = diffDocs(existingInv, updateInv);
                    const res = await InvoiceModel.updateOne(
                        { Number: i.Number },
                        { $set: updateInv, $setOnInsert: { createdAt: new Date(), deletedAt: null } }, // uuid only in $set to avoid path conflict
                        { upsert: true, setDefaultsOnInsert: true }
                    );
                    upsertedInv += 1;
                    try {
                        const rInv = res as unknown as UpdateResultLike;
                        const wasInserted = rInv.upsertedCount === 1 || !!rInv.upsertedId; if (wasInserted || changedFieldsInv.length > 0) { await UpsertLogModel.create({ entity: 'invoices', key: String(i.Number), op: wasInserted ? 'insert' : 'update', runId: runIdInv, modifiedCount: (rInv as any).modifiedCount, upsertedId: (rInv as any).upsertedId, changedFields: changedFieldsInv, changes: changesInv }); }
                    } catch (e) { if (config.flags.upsertLogs) logger.debug({ err: e }, 'Failed to write invoice upsert log'); }
                }
                if (reachedOldInv) { stoppedReasonInv = 'reachedOld'; break; }
                if (items.length < perpageInv) { stoppedReasonInv = 'partialPage'; break; }
                pageInv += 1;
            }
            if (newMaxInv > lastMaxInv) await setState('invoices:lastMaxNumber', newMaxInv);
            let softDeletedInv = 0;
            if (doFullRefreshIncrementals && config.flags.incrementalSoftDelete) {
                const resSD = await InvoiceModel.updateMany(
                    { $or: [{ lastSeenRun: { $ne: runIdInv } }, { lastSeenRun: { $exists: false } }], deletedAt: null },
                    { $set: { deletedAt: new Date(), updatedAt: new Date() } }
                );
                const rInvSD = resSD as unknown as UpdateResultLike;
                softDeletedInv = (rInvSD && (rInvSD.modifiedCount ?? 0)) as number;
            }
            const invMs = Date.now() - invStart;
            logger.info({ pages: pagesInv, fetched: fetchedInv, upserted: upsertedInv, total: totalInv, lastMax: lastMaxInv, newMax: newMaxInv, reachedOld: reachedOldInv, stoppedReason: stoppedReasonInv, softDeleted: softDeletedInv, fullRefresh: doFullRefreshIncrementals, ms: invMs }, 'Invoices sync completed (incremental)');
            entities.push({ entity: 'invoices', pages: pagesInv, fetched: fetchedInv, upserted: upsertedInv, total: totalInv, lastMax: lastMaxInv, newMax: newMaxInv, reachedOld: reachedOldInv, softDeleted: softDeletedInv, stoppedReason: stoppedReasonInv, fullRefresh: doFullRefreshIncrementals, ms: invMs });

            // === Quotes Sync ===
            // Incremental by max Number, paged
            const qStart = Date.now();
            const runIdQ = new Date().toISOString();
            let lastMaxQ = (await getState<number>('quotes:lastMaxNumber')) || 0;
            if (!lastMaxQ) {
                const doc = await QuoteModel.findOne({}, { Number: 1 }).sort({ Number: -1 }).lean();
                lastMaxQ = (doc?.Number as number) || 0;
                if (lastMaxQ) await setState('quotes:lastMaxNumber', lastMaxQ);
            }
            let pageQ = 1;
            const perpageQ = 100;
            let fetchedQ = 0;
            let totalQ = 0;
            let newMaxQ = lastMaxQ;
            let reachedOldQ = false;
            let upsertedQ = 0;
            let pagesQ = 0;
            let stoppedReasonQ: string | undefined;
            while (true) {
                const res = await fetchQuotes(pageQ, perpageQ, { order: 'Desc' });
                const items = res.items || [];
                pagesQ += 1;
                fetchedQ += items.length;
                totalQ = res.total || totalQ;
                for (const q of items) {
                    if (q.Number && q.Number > newMaxQ) newMaxQ = q.Number;
                    if (!doFullRefreshIncrementals && q.Number && q.Number <= lastMaxQ) { reachedOldQ = true; continue; }
                    const existingQ = await QuoteModel.findOne({ Number: q.Number }).lean();
                    let updateQ = { ...q, Date: q.Date ? new Date(q.Date) : undefined, updatedAt: new Date(), lastSeenRun: runIdQ } as any;
                    updateQ = mergeNestedObjects(existingQ, updateQ, ['Currency', 'DeliveryAddress', 'Address']);
                    if (existingQ?.uuid) updateQ.uuid = (existingQ as any).uuid;
                    const { changedFields: changedFieldsQ, changes: changesQ } = diffDocs(existingQ, updateQ);
                    const res = await QuoteModel.updateOne(
                        { Number: q.Number },
                        { $set: updateQ, $setOnInsert: { createdAt: new Date(), deletedAt: null } },
                        { upsert: true, setDefaultsOnInsert: true }
                    );
                    upsertedQ += 1;
                    try {
                        const rQ = res as unknown as UpdateResultLike;
                        const wasInserted = rQ.upsertedCount === 1 || !!rQ.upsertedId; if (wasInserted || changedFieldsQ.length > 0) { await UpsertLogModel.create({ entity: 'quotes', key: String(q.Number), op: wasInserted ? 'insert' : 'update', runId: runIdQ, modifiedCount: (rQ as any).modifiedCount, upsertedId: (rQ as any).upsertedId, changedFields: changedFieldsQ, changes: changesQ }); }
                    } catch (e) { if (config.flags.upsertLogs) logger.debug({ err: e }, 'Failed to write quote upsert log'); }
                }
                if (reachedOldQ) { stoppedReasonQ = 'reachedOld'; break; }
                if (items.length < perpageQ) { stoppedReasonQ = 'partialPage'; break; }
                pageQ += 1;
            }
            if (newMaxQ > lastMaxQ) await setState('quotes:lastMaxNumber', newMaxQ);
            let softDeletedQ = 0;
            if (doFullRefreshIncrementals && config.flags.incrementalSoftDelete) {
                const resSD = await QuoteModel.updateMany(
                    { $or: [{ lastSeenRun: { $ne: runIdQ } }, { lastSeenRun: { $exists: false } }], deletedAt: null },
                    { $set: { deletedAt: new Date(), updatedAt: new Date() } }
                );
                const rQSD = resSD as unknown as UpdateResultLike;
                softDeletedQ = (rQSD && (rQSD.modifiedCount ?? 0)) as number;
            }
            const qMs = Date.now() - qStart;
            logger.info({ pages: pagesQ, fetched: fetchedQ, upserted: upsertedQ, total: totalQ, lastMax: lastMaxQ, newMax: newMaxQ, reachedOld: reachedOldQ, stoppedReason: stoppedReasonQ, softDeleted: softDeletedQ, fullRefresh: doFullRefreshIncrementals, ms: qMs }, 'Quotes sync completed (incremental)');
            entities.push({ entity: 'quotes', pages: pagesQ, fetched: fetchedQ, upserted: upsertedQ, total: totalQ, lastMax: lastMaxQ, newMax: newMaxQ, reachedOld: reachedOldQ, softDeleted: softDeletedQ, stoppedReason: stoppedReasonQ, fullRefresh: doFullRefreshIncrementals, ms: qMs });

            // === Projects Sync ===
            // Incremental by max Number, paged
            const pjStart = Date.now();
            const runIdPj = new Date().toISOString();
            let lastMaxPj = (await getState<number>('projects:lastMaxNumber')) || 0;
            if (!lastMaxPj) {
                const doc = await ProjectModel.findOne({}, { Number: 1 }).sort({ Number: -1 }).lean();
                lastMaxPj = (doc?.Number as number) || 0;
                if (lastMaxPj) await setState('projects:lastMaxNumber', lastMaxPj);
            }
            let pagePj = 1;
            const perpagePj = 100;
            let fetchedPj = 0;
            let totalPj = 0;
            let newMaxPj = lastMaxPj;
            let reachedOldPj = false;
            let upsertedPj = 0;
            let pagesPj = 0;
            let stoppedReasonPj: string | undefined;
            let unpagedPj = false;
            while (true) {
                const res = await fetchProjects(pagePj, perpagePj, { order: 'Desc' });
                const items = res.items || [];
                pagesPj += 1;
                fetchedPj += items.length;
                totalPj = res.total || totalPj;
                for (const pj of items) {
                    if (pj.Number && pj.Number > newMaxPj) newMaxPj = pj.Number;
                    if (!doFullRefreshIncrementals && pj.Number && pj.Number <= lastMaxPj) { reachedOldPj = true; continue; }
                    const existingPj = await ProjectModel.findOne({ Number: pj.Number }).lean();
                    let updatePj = { ...pj, StartDate: pj.StartDate ? new Date(pj.StartDate) : undefined, EndDate: pj.EndDate ? new Date(pj.EndDate) : undefined, updatedAt: new Date(), lastSeenRun: runIdPj } as any;
                    updatePj = mergeNestedObjects(existingPj, updatePj, ['Address']);
                    if (existingPj?.uuid) updatePj.uuid = (existingPj as any).uuid;
                    const { changedFields: changedFieldsPj, changes: changesPj } = diffDocs(existingPj, updatePj);
                    const res = await ProjectModel.updateOne(
                        { Number: pj.Number },
                        { $set: updatePj, $setOnInsert: { createdAt: new Date(), deletedAt: null } },
                        { upsert: true, setDefaultsOnInsert: true }
                    );
                    upsertedPj += 1;
                    try {
                        const rPj = res as unknown as UpdateResultLike;
                        const wasInserted = rPj.upsertedCount === 1 || !!rPj.upsertedId; if (wasInserted || changedFieldsPj.length > 0) { await UpsertLogModel.create({ entity: 'projects', key: String(pj.Number), op: wasInserted ? 'insert' : 'update', runId: runIdPj, modifiedCount: (rPj as any).modifiedCount, upsertedId: (rPj as any).upsertedId, changedFields: changedFieldsPj, changes: changesPj }); }
                    } catch (e) { if (config.flags.upsertLogs) logger.debug({ err: e }, 'Failed to write project upsert log'); }
                }
                // Stop if:
                // - We reached previously seen records,
                // - The API returned an unpaginated array (single-shot),
                // - Or the batch size is less than requested per-page,
                // - Or we've fetched all items according to total.
                if (reachedOldPj) { stoppedReasonPj = 'reachedOld'; break; }
                if ((res as any).isUnpaged) { unpagedPj = true; stoppedReasonPj = 'unpaged'; break; }
                if (items.length < perpagePj) { stoppedReasonPj = 'partialPage'; break; }
                if (fetchedPj >= totalPj) { stoppedReasonPj = 'exhaustedTotal'; break; }
                pagePj += 1;
            }
            if (newMaxPj > lastMaxPj) await setState('projects:lastMaxNumber', newMaxPj);
            let softDeletedPj = 0;
            if (doFullRefreshIncrementals && config.flags.incrementalSoftDelete) {
                const resSD = await ProjectModel.updateMany(
                    { $or: [{ lastSeenRun: { $ne: runIdPj } }, { lastSeenRun: { $exists: false } }], deletedAt: null },
                    { $set: { deletedAt: new Date(), updatedAt: new Date() } }
                );
                const rPjSD = resSD as unknown as UpdateResultLike;
                softDeletedPj = (rPjSD && (rPjSD.modifiedCount ?? 0)) as number;
            }
            const pjMs = Date.now() - pjStart;
            logger.info({ pages: pagesPj, fetched: fetchedPj, upserted: upsertedPj, total: totalPj, lastMax: lastMaxPj, newMax: newMaxPj, reachedOld: reachedOldPj, stoppedReason: stoppedReasonPj, unpaged: unpagedPj, softDeleted: softDeletedPj, fullRefresh: doFullRefreshIncrementals, ms: pjMs }, 'Projects sync completed (incremental)');
            entities.push({ entity: 'projects', pages: pagesPj, fetched: fetchedPj, upserted: upsertedPj, total: totalPj, lastMax: lastMaxPj, newMax: newMaxPj, reachedOld: reachedOldPj, stoppedReason: stoppedReasonPj, unpaged: unpagedPj, softDeleted: softDeletedPj, fullRefresh: doFullRefreshIncrementals, ms: pjMs });
            
            // === Purchases Sync (LAST) ===
            // Incremental by max Number, paged
            // This is intentionally run last to avoid ordering issues with other entities
            const purStart = Date.now();
            const runIdPur = new Date().toISOString();
            let lastMaxPur = (await getState<number>('purchases:lastMaxNumber')) || 0;
            if (!lastMaxPur) {
                const doc = await PurchaseModel.findOne({}, { Number: 1 }).sort({ Number: -1 }).lean();
                lastMaxPur = (doc?.Number as number) || 0;
                if (lastMaxPur) await setState('purchases:lastMaxNumber', lastMaxPur);
            }
            let pagePur = 1;
            const perpagePur = 100;
            let fetchedPur = 0;
            let totalPur = 0;
            let newMaxPur = lastMaxPur;
            let reachedOldPur = false;
            let upsertedPur = 0;
            let pagesPur = 0;
            let stoppedReasonPur: string | undefined;
            while (true) {
                const res = await fetchPurchases(pagePur, perpagePur, { order: 'Desc' });
                const items = res.items || [];
                pagesPur += 1;
                fetchedPur += items.length;
                totalPur = res.total || totalPur;
                for (const p of items) {
                    if (p.Number && p.Number > newMaxPur) newMaxPur = p.Number;
                    if (!doFullRefreshIncrementals && p.Number && p.Number <= lastMaxPur) { reachedOldPur = true; continue; }
                    const existingPur = await PurchaseModel.findOne({ Number: p.Number }).lean();
                    // Ensure LineItems populated: if not present but Permalink available, fetch detail
                    let fullP: any = p as any;
                    const hasLineItemsAlready = Array.isArray((p as any).LineItems) && (p as any).LineItems.length > 0;
                    if (!hasLineItemsAlready) {
                        purchasesNeedingDetail += 1;
                        const permalink = (p as any).Permalink;
                        let detail: any = null;
                        if (permalink) {
                            try { detail = await fetchPurchaseDetailByPermalink(permalink); if (detail) detailFromPermalink += 1; } catch {/* ignore */}
                        }
                        if (!detail && (p as any).Number) {
                            try { detail = await fetchPurchaseDetailByNumber((p as any).Number); if (detail) detailFromNumber += 1; } catch {/* ignore */}
                        }
                        if (!detail && (p as any).Id) {
                            try { detail = await fetchPurchaseDetailById((p as any).Id); if (detail) detailFromId += 1; } catch {/* ignore */}
                        }
                        if (detail && Array.isArray(detail.LineItems) && detail.LineItems.length) {
                            fullP = { ...p, LineItems: detail.LineItems, PaymentLines: detail.PaymentLines ?? (p as any).PaymentLines };
                        } else if (config.flags.upsertLogs) {
                            logger.debug({ number: p.Number, id: (p as any).Id }, 'Purchase detail enrichment failed or no LineItems returned');
                        }
                    }
                    if (Array.isArray(fullP.LineItems) && fullP.LineItems.length) purchasesWithLineItems += 1;
                    // Build purchase update document, deriving UK TaxYear / TaxMonth from PaidDate if present.
                    // UK tax year runs 6 April (Year N) to 5 April (Year N+1). Tax month 1 = 6 Apr - 5 May, ... month 12 = 6 Mar - 5 Apr.
                    const paidDateObj = p.PaidDate ? new Date(p.PaidDate) : undefined;
                    let taxYear: number | undefined;   // We store the STARTING year of the tax year (e.g. 2024 for 6 Apr 2024 - 5 Apr 2025)
                    let taxMonth: number | undefined;   // 1..12 per HMRC month boundaries
                    if (paidDateObj && !isNaN(paidDateObj.getTime())) {
                        const d = paidDateObj;
                        const y = d.getFullYear();
                        // Determine start year: if before 6 April of this year, belongs to previous start year
                        const thisYearApril6 = new Date(y, 3, 6); // month index 3 = April
                        const startYear = d < thisYearApril6 ? y - 1 : y;
                        taxYear = startYear;
                        // Build boundary starts for each tax month (1..12) then the end sentinel
                        const boundaries: Date[] = [
                            new Date(startYear, 3, 6),  // 1: 6 Apr
                            new Date(startYear, 4, 6),  // 2: 6 May
                            new Date(startYear, 5, 6),  // 3: 6 Jun
                            new Date(startYear, 6, 6),  // 4: 6 Jul
                            new Date(startYear, 7, 6),  // 5: 6 Aug
                            new Date(startYear, 8, 6),  // 6: 6 Sep
                            new Date(startYear, 9, 6),  // 7: 6 Oct
                            new Date(startYear, 10, 6), // 8: 6 Nov
                            new Date(startYear, 11, 6), // 9: 6 Dec
                            new Date(startYear + 1, 0, 6), // 10: 6 Jan
                            new Date(startYear + 1, 1, 6), // 11: 6 Feb
                            new Date(startYear + 1, 2, 6), // 12: 6 Mar
                            new Date(startYear + 1, 3, 6)  // end sentinel (next 6 Apr)
                        ];
                        // Find tax month by locating the last boundary <= date
                        for (let i = 0; i < boundaries.length - 1; i++) {
                            if (d >= boundaries[i] && d < boundaries[i + 1]) { taxMonth = i + 1; break; }
                        }
                        // Safety fallback (should not happen): if not matched but date >= last start boundary
                        if (!taxMonth && d >= boundaries[boundaries.length - 2]) taxMonth = 12;
                    }
                    let updatePurDoc = { ...fullP, IssuedDate: fullP.IssuedDate ? new Date(fullP.IssuedDate) : undefined, DueDate: fullP.DueDate ? new Date(fullP.DueDate) : undefined, PaidDate: paidDateObj ?? fullP.PaidDate, TaxYear: taxYear, TaxMonth: taxMonth, updatedAt: new Date(), lastSeenRun: runIdPur } as any;
                    updatePurDoc = mergeNestedObjects(existingPur, updatePurDoc, ['Currency', 'DeliveryAddress', 'Address']);
                    if (existingPur?.uuid) updatePurDoc.uuid = (existingPur as any).uuid;
                    const { changedFields: changedFieldsPur, changes: changesPur } = diffDocs(existingPur, updatePurDoc);
                    const res = await PurchaseModel.updateOne(
                        { Number: p.Number },
                        { $set: updatePurDoc, $setOnInsert: { createdAt: new Date(), deletedAt: null } },
                        { upsert: true, setDefaultsOnInsert: true }
                    );
                    const rPur = res as unknown as UpdateResultLike;
                    const wasInserted = rPur.upsertedCount === 1 || !!rPur.upsertedId;
                    upsertedPur += 1;
                    try { if (wasInserted || changedFieldsPur.length > 0) { await UpsertLogModel.create({ entity: 'purchases', key: String(p.Number), op: wasInserted ? 'insert' : 'update', runId: runIdPur, modifiedCount: (res as any).modifiedCount, upsertedId: (res as any).upsertedId, changedFields: changedFieldsPur, changes: changesPur }); } } catch (e) { if (config.flags.upsertLogs) logger.debug({ err: e }, 'Failed to write purchase upsert log'); }
                }
                if (reachedOldPur) { stoppedReasonPur = 'reachedOld'; break; }
                if (items.length < perpagePur) { stoppedReasonPur = 'partialPage'; break; }
                pagePur += 1;
            }
            if (newMaxPur > lastMaxPur) await setState('purchases:lastMaxNumber', newMaxPur);
            // Soft delete for purchases only on full refresh runs
            let softDeletedPur = 0;
            if (doFullRefreshIncrementals && config.flags.incrementalSoftDelete) {
                const resSD = await PurchaseModel.updateMany(
                    { $or: [{ lastSeenRun: { $ne: runIdPur } }, { lastSeenRun: { $exists: false } }], deletedAt: null },
                    { $set: { deletedAt: new Date(), updatedAt: new Date() } }
                );
                const rPurSD = resSD as unknown as UpdateResultLike;
                softDeletedPur = (rPurSD && (rPurSD.modifiedCount ?? 0)) as number;
            }
            const purMs = Date.now() - purStart;
            logger.info({ pages: pagesPur, fetched: fetchedPur, upserted: upsertedPur, total: totalPur, lastMax: lastMaxPur, newMax: newMaxPur, reachedOld: reachedOldPur, stoppedReason: stoppedReasonPur, softDeleted: softDeletedPur, fullRefresh: doFullRefreshIncrementals, purchasesWithLineItems, purchasesNeedingDetail, detailFromPermalink, detailFromNumber, detailFromId, lineItemsCoveragePct: purchasesWithLineItems ? Number(((purchasesWithLineItems / Math.max(1, fetchedPur)) * 100).toFixed(2)) : 0, ms: purMs }, 'Purchases sync completed (incremental)');
            entities.push({ entity: 'purchases', pages: pagesPur, fetched: fetchedPur, upserted: upsertedPur, total: totalPur, lastMax: lastMaxPur, newMax: newMaxPur, reachedOld: reachedOldPur, softDeleted: softDeletedPur, stoppedReason: stoppedReasonPur, fullRefresh: doFullRefreshIncrementals, ms: purMs });
            
            // === End of Entity Syncs ===
            // Update last full refresh timestamp if needed
            if (doFullRefreshIncrementals) {
                await setState('incremental:lastFullRefreshTs', now);
            }

        } catch (err) {
            overallError = err;
            logger.error({ err }, 'Sync failed');
        } finally {
            // === Sync Summary and Finalization ===
            const end = Date.now();
            const endIso = new Date().toISOString();
            const summary = {
                start: startIso,
                end: endIso,
                durationMs: end - start,
                success: !overallError,
                error: overallError ? (overallError.message || String(overallError)) : undefined,
                entities,
            };
            setLastSummary(summary);
            try {
                await SyncSummaryModel.create(summary);
            } catch (e) {
                logger.warn({ err: e }, 'Failed to persist sync summary');
            }
        }
    });
}
