import mongoose from './mongoose.js';

const common = {
    createdAt: { type: Date },
    updatedAt: { type: Date },
    deletedAt: { type: Date, default: null },
    lastSeenRun: { type: String, index: true },
};

const customerSchema = new mongoose.Schema(
    {
        Id: { type: Number },
        Code: { type: String },
        Name: { type: String },
        LastUpdatedDate: { type: Date },
        ...common,
    },
    { collection: 'customers', strict: false }
);
customerSchema.index({ Code: 1 }, { unique: true, sparse: true });

export const CustomerModel = mongoose.model('Customer', customerSchema);

const supplierSchema = new mongoose.Schema(
    {
        Id: { type: Number },
        Code: { type: String },
        Name: { type: String },
        LastUpdatedDate: { type: Date },
        ...common,
    },
    { collection: 'suppliers', strict: false }
);
supplierSchema.index({ Code: 1 }, { unique: true, sparse: true });
export const SupplierModel = mongoose.model('Supplier', supplierSchema);

const invoiceSchema = new mongoose.Schema(
    {
        Id: { type: Number },
        Number: { type: Number },
        CustomerCode: { type: String },
        uuid: { type: String, index: true, sparse: true },
        ...common,
    },
    { collection: 'invoices', strict: false }
);
invoiceSchema.index({ Number: 1 }, { unique: true, sparse: true });
export const InvoiceModel = mongoose.model('Invoice', invoiceSchema);

const quoteSchema = new mongoose.Schema(
    {
        Id: { type: Number },
        Number: { type: Number },
        CustomerCode: { type: String },
        ...common,
    },
    { collection: 'quotes', strict: false }
);
quoteSchema.index({ Number: 1 }, { unique: true, sparse: true });
export const QuoteModel = mongoose.model('Quote', quoteSchema);

const purchaseSchema = new mongoose.Schema(
    {
        Id: { type: Number },
        Number: { type: Number },
        SupplierCode: { type: String },
        ...common,
    },
    { collection: 'purchases', strict: false }
);
purchaseSchema.index({ Number: 1 }, { unique: true, sparse: true });
export const PurchaseModel = mongoose.model('Purchase', purchaseSchema);

const projectSchema = new mongoose.Schema(
    {
        Id: { type: Number },
        Number: { type: Number },
        CustomerCode: { type: String },
        ...common,
    },
    { collection: 'projects', strict: false }
);
projectSchema.index({ Number: 1 }, { unique: true, sparse: true });
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

