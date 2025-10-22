# KashFlow API Fetching Guide

A concise, agent-friendly reference for fetching and syncing data from the KashFlow REST API.

---

## Conventions

* **List endpoints**: return a paginated object

  ```json
  { 
    "Data": [...], 
    "MetaData": { "NextPageUrl": "..." } 
  }
  ```
* **Single-item endpoints**: return a **bare object** with full details.
* **Key fields for upsert**:

  * Quotes → `Number`
  * Customers → `Code`
  * Invoices → `Number`
  * Projects → `Number`
  * Purchases → `Number`

---

## Endpoints & Shapes

### Quotes

* **List**: `GET /quotes`
  → `{ Data: QuoteSummary[], MetaData }`
  *(summaries; `Currency`, `LineItems` often `null`)*
* **Single**: `GET /quotes/{number}`
  → `Quote` *(full: `Currency`, `LineItems`, `Permalink`, `NextNumber`/`PreviousNumber`)*

### Customers

* **List**: `GET /customers?...`
  → `{ Data: CustomerSummary[], MetaData }`
* **Single**: `GET /customers/{code}`
  → `Customer` *(full: addresses, custom fields, `EnvelopeUrl`)*

### Invoices

* **List**: `GET /invoices?...`
  → `{ Data: InvoiceSummary[], MetaData }`
  *(summaries; `LineItems`, `PaymentLines` often `null`)*
* **Single**: `GET /invoices/{number}`
  → `Invoice` *(full: `LineItems`, `PaymentLines`, `ReminderLetters`, `Permalink`)*

### Projects

* **List**: `GET /projects?customerCode={code}`
  → `ProjectSummary[]` *(bare array, no `{Data, MetaData}`)*
* **Single**: `GET /project/{number}`
  → `Project` *(full details)*

### Purchases

* **List**: `GET /purchases?...`
  → `{ Data: PurchaseSummary[], MetaData }`
* **Single**: `GET /purchases/{number}`
  → `Purchase` *(full: `LineItems`, `PaymentLines`, `Permalink`)*

### Suppliers

* **List**: `GET /suppliers?...`
  → `{ Data: SupplierSummary[], MetaData }`
  *(summaries; some flags only present in single)*
* **Single**: `GET /suppliers/{code}`
  → `Supplier` *(full: VAT/CIS/WHT flags, PDF theme flags, bank account, billed amounts, etc.)*

---

## Standard Fetch Pattern

1. **Iterate list pages**

   * Start with `?page=1&perpage=100&sortby=Number&order=Asc` (or `Code` for customers).
   * Follow `MetaData.NextPageUrl` until `null`.
   * If the API supports numeric paging reliably, incrementing `page` is acceptable;
     prefer using `NextPageUrl` when available to future‑proof against server-side paging nuances.
   * For **Projects**, loop until the returned array is empty (no pagination wrapper).

2. **Collect identifiers**

   * Store each item’s key (`Number` or `Code`).

3. **Fetch details per ID**

   * Call the **single endpoint** for canonical, complete data.
  * Purchases: when available, a `Permalink` may be used as a shortcut to fetch
    full details (works as a relative URL under the API base). If missing, fall back to `/{number}`.

4. **Upsert**

   * Use the key as a unique identifier.
   * Persist progress (last page URL + last processed ID).

5. **Reliability controls**

   * **Bounded concurrency**: 5–12 workers.
   * **Retries**: on 429/5xx with exponential backoff; honor `Retry-After`.
   * **Jitter**: small random delay between page requests.

6. **Incremental syncs**

   * Re-run periodically.
   * Only refetch details for **new/changed IDs**.
   * If no “updated since” filter, rely on increasing `Number` or compare hashes/ETags.

---

## Data Hygiene & Quirks

* **Dates**: may or may not include timezone offsets—parse both safely.
* **Formatting**: padded `CustomerCode`, stray slashes/spacing in samples—normalize before use.
* **Nulls**: expect `LineItems`, `PaymentLines`, `Currency` to be `null` in summaries.
* **Endpoint names**: note `/project/{number}` (singular) vs `/projects`.

---

## Recommended Defaults

* `perpage=100` (or maximum allowed). For large payloads (e.g., invoices), a smaller page size may reduce timeouts.
* `sortby=Number&order=Asc` (or `Code` for customers). For incremental runs, `order=Desc` can minimize pages before hitting the last seen key.
* Concurrency: `8`
* Backoff: `1s → 2s → 4s` (max), respect `Retry-After`
* Telemetry: track pages scanned, items discovered, successes/failures, run duration

---

## TL;DR

* Page through list endpoints to collect IDs.
* Fetch single endpoints for full details.
* Upsert by unique key.
* Add concurrency, retries, and progress persistence.
* Result: complete, resumable, API-friendly syncs.
