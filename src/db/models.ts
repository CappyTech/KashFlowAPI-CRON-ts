import mongoose from './mongoose.js';
import { v4 as uuidv4 } from 'uuid';

const common = {
    createdAt: { type: Date },
    updatedAt: { type: Date },
    deletedAt: { type: Date, default: null },
    lastSeenRun: { type: String, index: true },
};

const customerSchema = new mongoose.Schema(
    {
        uuid: { type: String, unique: true, required: true, default: uuidv4 },
        Id: Number,
        Code: String,
        Name: String,
        DisplayName: String,
        Note: String,
        CreatedDate: Date,
        LastUpdatedDate: Date,
        FirstInvoiceDate: Date,
        LastInvoiceDate: Date,
        InvoiceCount: Number,
        InvoicedNetAmount: Number,
        InvoicedVATAmount: Number,
        OutstandingBalance: Number,
        TotalPaidAmount: Number,
        DiscountRate: Number,
        DefaultNominalCode: Number,
        DefaultCustomerReference: String,
        VATNumber: String,
        IsRegisteredInEC: Boolean,
        IsRegisteredOutsideEC: Boolean,
        IsArchived: Boolean,
        ReceivesWholesalePricing: Boolean,
        ApplyWHT: Boolean,
        WHTRate: Number,
        PaymentTerms: mongoose.Schema.Types.Mixed,
        Currency: mongoose.Schema.Types.Mixed,
        Contacts: [mongoose.Schema.Types.Mixed],
        Addresses: [mongoose.Schema.Types.Mixed],
        DeliveryAddresses: [mongoose.Schema.Types.Mixed],
        CustomCheckBoxes: [mongoose.Schema.Types.Mixed],
        CustomTextBoxes: [mongoose.Schema.Types.Mixed],
        ...common,
    },
    { collection: 'customers', strict: false }
);
customerSchema.index({ Code: 1 }, { unique: true });
export const CustomerModel = mongoose.model('Customer', customerSchema);

const supplierSchema = new mongoose.Schema(
    {
        uuid: { type: String, unique: true, required: true, default: uuidv4 },
        Id: Number,
        Code: String,
        Name: String,
        Note: String,
        CreatedDate: Date,
        LastUpdatedDate: Date,
        FirstPurchaseDate: Date,
        LastPurchaseDate: Date,
        OutstandingBalance: Number,
        TotalPaidAmount: Number,
        DefaultNominalCode: Number,
        VATNumber: String,
        // Some APIs expose a differently cased field as well
        VatNumber: String,
        IsRegisteredInEC: Boolean,
        IsArchived: Boolean,
        // REST can return string values like "Domestic"; normalize to string
        TradeBorderType: { type: String, set: (v: unknown) => (v == null ? (v as any) : String(v)) },
        // Additional flags/fields for VAT/CIS/withholding and source attribution
        IsCISReverseCharge: Boolean,
        ApplyWithholdingTax: Boolean,
        IsVatRateEnabled: Boolean,
        DefaultVatRate: Number,
        VatExempt: Boolean,
        DoesSupplierHasTransactionsInVATReturn: Boolean,
        SourceName: String,
        PaymentTerms: mongoose.Schema.Types.Mixed,
        Currency: mongoose.Schema.Types.Mixed,
        Contacts: [mongoose.Schema.Types.Mixed],
        Address: mongoose.Schema.Types.Mixed,
        DeliveryAddresses: [mongoose.Schema.Types.Mixed],
        // Additional fields requested
        // Some tenants expose a boolean "uses default PDF theme" flag; keep both variants for compatibility
        UsesDefaultPdfTheme: Boolean,
        UsesDefaultPdftTheme: Boolean,
        DefaultPdfTheme: Number,
        PaymentMethod: Number,
        CreateSupplierCodeIfDuplicate: Boolean,
        CreateSupplierNameIfEmptyOrNull: Boolean,
        UniqueEntityNumber: String,
        WithholdingTaxRate: Number,
        WithholdingTaxReferences: mongoose.Schema.Types.Mixed,
    // Additional fields seen in detail response
    BankAccount: mongoose.Schema.Types.Mixed,
    BilledNetAmount: Number,
    BilledVatAmount: Number,
        ...common,
    },
    { collection: 'suppliers', strict: false }
);
supplierSchema.index({ Code: 1 }, { unique: true });
export const SupplierModel = mongoose.model('Supplier', supplierSchema);

const invoiceSchema = new mongoose.Schema(
    {
        uuid: { type: String, unique: true, required: true, default: uuidv4 },
        Id: Number,
        Number: { type: Number, required: true },
        CustomerId: Number,
        CustomerName: String,
        CustomerReference: String,
        Currency: mongoose.Schema.Types.Mixed,
        NetAmount: Number,
        GrossAmount: Number,
        VATAmount: Number,
        AmountPaid: Number,
        TotalPaidAmount: Number,
        Paid: Number,
        IssuedDate: Date,
        DueDate: Date,
        PaidDate: Date,
        LastPaymentDate: Date,
        Status: { type: String, set: (v: unknown) => (v == null ? (v as any) : String(v)) },
        LineItems: [mongoose.Schema.Types.Mixed],
        PaymentLines: [mongoose.Schema.Types.Mixed],
        DeliveryAddress: mongoose.Schema.Types.Mixed,
        Address: mongoose.Schema.Types.Mixed,
        UseCustomDeliveryAddress: Boolean,
        Permalink: String,
        PackingSlipPermalink: String,
        ReminderLetters: [mongoose.Schema.Types.Mixed],
        PreviousNumber: Number,
        NextNumber: Number,
        OverdueDays: Number,
        ...common,
    },
    { collection: 'invoices', strict: false }
);
invoiceSchema.index({ Number: 1 }, { unique: true });
export const InvoiceModel = mongoose.model('Invoice', invoiceSchema);

const quoteSchema = new mongoose.Schema(
    {
        uuid: { type: String, unique: true, required: true, default: uuidv4 },
        Id: Number,
        Number: { type: Number, required: true },
        CustomerId: Number,
        CustomerName: String,
        CustomerReference: String,
        Currency: mongoose.Schema.Types.Mixed,
        NetAmount: Number,
        GrossAmount: Number,
        VATAmount: Number,
        AmountPaid: Number,
        Paid: Number,
        Date: Date,
        Status: { type: String, set: (v: unknown) => (v == null ? (v as any) : String(v)) },
        LineItems: [mongoose.Schema.Types.Mixed],
        DeliveryAddress: mongoose.Schema.Types.Mixed,
        Address: mongoose.Schema.Types.Mixed,
        UseCustomDeliveryAddress: Boolean,
        Permalink: String,
        PreviousNumber: Number,
        NextNumber: Number,
        ...common,
    },
    { collection: 'quotes', strict: false }
);
quoteSchema.index({ Number: 1 }, { unique: true });
export const QuoteModel = mongoose.model('Quote', quoteSchema);

const purchaseSchema = new mongoose.Schema(
    {
        uuid: { type: String, unique: true, required: true, default: uuidv4 },
        Id: Number,
        Number: { type: Number, required: true },
        SupplierId: Number,
        SupplierCode: String,
        SupplierName: String,
        SupplierReference: String,
        Currency: mongoose.Schema.Types.Mixed,
        NetAmount: Number,
        GrossAmount: Number,
        VATAmount: Number,
        AmountPaid: Number,
        TotalPaidAmount: Number,
        Paid: Number,
        IssuedDate: Date,
        DueDate: Date,
        PaidDate: Date,
        Status: { type: String, set: (v: unknown) => (v == null ? (v as any) : String(v)) },
        LineItems: [mongoose.Schema.Types.Mixed],
        PaymentLines: [mongoose.Schema.Types.Mixed],
        DeliveryAddress: mongoose.Schema.Types.Mixed,
        Address: mongoose.Schema.Types.Mixed,
        UseCustomDeliveryAddress: Boolean,
        Permalink: String,
        PreviousNumber: Number,
        NextNumber: Number,
        OverdueDays: Number,
        AdditionalFieldValue: String,
        FileCount: Number,
        IsWhtDeductionToBeApplied: Boolean,
        PurchaseInECMemberState: Boolean,
        StockManagementApplicable: Boolean,
        ReadableString: String,
        SubmissionDate: Date,
        TaxMonth: Number,
        TaxYear: Number,
        // Linked Paperless-ngx document metadata
        Paperless: {
            Id: Number,
            Title: String,
            DownloadUrl: String,
            PreviewUrl: String,
            OriginalFileName: String,
        },
        ...common,
    },
    { collection: 'purchases', strict: false }
);
purchaseSchema.index({ Number: 1 }, { unique: true });
export const PurchaseModel = mongoose.model('Purchase', purchaseSchema);

const projectSchema = new mongoose.Schema(
    {
        uuid: { type: String, unique: true, required: true, default: uuidv4 },
        Id: Number,
        Number: Number,
        Name: String,
        Description: String,
        Reference: String,
        CustomerCode: String,
        CustomerName: String,
        StartDate: Date,
        EndDate: Date,
        Status: { type: String, set: (v: unknown) => (v == null ? (v as any) : String(v)) },
        StatusName: String,
        Note: String,
        ActualJournalsAmount: Number,
        ActualPurchasesAmount: Number,
        ActualSalesAmount: Number,
        TargetPurchasesAmount: Number,
        TargetSalesAmount: Number,
        ActualPurchasesVATAmount: Number,
        ActualSalesVATAmount: Number,
        WorkInProgressAmount: Number,
        ExcludeVAT: Number,
        AssociatedQuotesCount: Number,
        ...common,
    },
    { collection: 'projects', strict: false }
);
projectSchema.index({ Number: 1 }, { unique: true });
export const ProjectModel = mongoose.model('Project', projectSchema);

// Sync summaries (historical)
const syncSummarySchema = new mongoose.Schema(
    {
        start: { type: Date, index: true },
        end: { type: Date },
        durationMs: { type: Number },
        success: { type: Boolean },
        error: { type: String },
        entities: [
            {
                entity: String,
                pages: Number,
                fetched: Number,
                processed: Number,
                upserted: Number,
                total: Number,
                softDeleted: Number,
                lastMax: Number,
                newMax: Number,
                reachedOld: Boolean,
                stoppedReason: String,
                unpaged: Boolean,
                ms: Number,
            },
        ],
        createdAt: { type: Date, default: () => new Date() },
    },
    { collection: 'sync_summaries', strict: true }
);
syncSummarySchema.index({ start: -1 });
export const SyncSummaryModel = mongoose.model('SyncSummary', syncSummarySchema);

// Upsert logs (per-document audit)
const upsertLogSchema = new mongoose.Schema(
    {
        entity: { type: String, index: true }, // e.g., customers, suppliers, invoices
        key: { type: String, index: true },    // unique identifying key value (Code or Number)
        op: { type: String, enum: ['insert', 'update'], index: true },
        runId: { type: String, index: true },  // ISO timestamp of sync iteration segment
        ts: { type: Date, default: () => new Date(), index: true },
        // optional diffs / metadata (kept flexible)
        modifiedCount: { type: Number },
        upsertedId: { type: String },
        changedFields: { type: [String], index: false },
        changes: { type: mongoose.Schema.Types.Mixed }, // { field: { before, after } }
    },
    { collection: 'upsert_logs', strict: true }
);
upsertLogSchema.index({ entity: 1, ts: -1 });
// Removed standalone runId index because runId field already has index: true, to avoid duplicate index warning
export const UpsertLogModel = mongoose.model('UpsertLog', upsertLogSchema);

