import { startSshTunnel, stopSshTunnel } from '../sshTunnel.js';
import { connectMongoose, disconnectMongoose } from '../db/mongoose.js';
import { CustomerModel, SupplierModel, InvoiceModel, QuoteModel, PurchaseModel, ProjectModel } from '../db/models.js';
import logger from '../util/logger.js';

type Coll = 'customers' | 'suppliers' | 'invoices' | 'quotes' | 'purchases' | 'projects';

function parseArgs() {
    const args = process.argv.slice(2);
    const out: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('--')) {
            const key = a.replace(/^--/, '');
            const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
            out[key] = val;
        }
    }
    return out;
}

async function run() {
    const opts = parseArgs();
    const collection = (opts.collection as Coll) || 'customers';
    const code = opts.code;
    const number = opts.number ? Number(opts.number) : undefined;
    const limit = opts.limit ? Number(opts.limit) : 1;

    try {
        await startSshTunnel();
        await connectMongoose();

        if (collection === 'customers') {
            const count = await CustomerModel.countDocuments();
            const query: any = code ? { Code: code } : {};
            const docs = await CustomerModel.find(query).sort({ updatedAt: -1 }).limit(limit).lean();
            logger.info({ collection, count, picked: docs.length }, 'Collection overview');
            for (const doc of docs) {
                const anyDoc: any = doc as any;
                const preview = {
                    Id: anyDoc.Id,
                    Code: anyDoc.Code,
                    Name: anyDoc.Name,
                    CreatedDate: anyDoc.CreatedDate,
                    FirstInvoiceDate: anyDoc.FirstInvoiceDate,
                    LastInvoiceDate: anyDoc.LastInvoiceDate,
                    LastUpdatedDate: anyDoc.LastUpdatedDate,
                    Currency: anyDoc.Currency,
                    PaymentTerms: anyDoc.PaymentTerms,
                    Contacts0: Array.isArray(anyDoc.Contacts) ? anyDoc.Contacts[0] : undefined,
                    Addresses0: Array.isArray(anyDoc.Addresses) ? anyDoc.Addresses[0] : undefined,
                    DeliveryAddresses0: Array.isArray(anyDoc.DeliveryAddresses) ? anyDoc.DeliveryAddresses[0] : undefined,
                    CustomCheckBoxes0: Array.isArray(anyDoc.CustomCheckBoxes) ? anyDoc.CustomCheckBoxes[0] : undefined,
                    CustomTextBoxes0: Array.isArray(anyDoc.CustomTextBoxes) ? anyDoc.CustomTextBoxes[0] : undefined,
                    keys: Object.keys(anyDoc).slice(0, 30),
                };
                logger.info(preview, 'Customer sample');
            }
        } else if (collection === 'suppliers') {
            const count = await SupplierModel.countDocuments();
            const query: any = code ? { Code: code } : {};
            const docs = await SupplierModel.find(query).sort({ updatedAt: -1 }).limit(limit).lean();
            logger.info({ collection, count, picked: docs.length }, 'Collection overview');
            for (const doc of docs) logger.info({ Id: doc.Id, Code: doc.Code, Name: doc.Name, LastUpdatedDate: doc.LastUpdatedDate, keys: Object.keys(doc).slice(0, 30) }, 'Supplier sample');
        } else if (collection === 'invoices') {
            const count = await InvoiceModel.countDocuments();
            const query: any = number ? { Number: number } : {};
            const docs = await InvoiceModel.find(query).sort({ Number: -1 }).limit(limit).lean();
            logger.info({ collection, count, picked: docs.length }, 'Collection overview');
            for (const doc of docs) {
                const anyDoc: any = doc as any;
                logger.info({ Number: anyDoc.Number, CustomerCode: anyDoc.CustomerCode, IssuedDate: anyDoc.IssuedDate, DueDate: anyDoc.DueDate, PaidDate: anyDoc.PaidDate, LastPaymentDate: anyDoc.LastPaymentDate, Status: anyDoc.Status, uuid: anyDoc.uuid, keys: Object.keys(anyDoc).slice(0, 30) }, 'Invoice sample');
            }
        } else if (collection === 'purchases') {
            const count = await PurchaseModel.countDocuments();
            const query: any = number ? { Number: number } : {};
            const docs = await PurchaseModel.find(query).sort({ Number: -1 }).limit(limit).lean();
            logger.info({ collection, count, picked: docs.length }, 'Collection overview');
            for (const doc of docs) {
                const anyDoc: any = doc as any;
                logger.info({ Number: anyDoc.Number, SupplierCode: anyDoc.SupplierCode, IssuedDate: anyDoc.IssuedDate, DueDate: anyDoc.DueDate, PaidDate: anyDoc.PaidDate, Status: anyDoc.Status, keys: Object.keys(anyDoc).slice(0, 30) }, 'Purchase sample');
            }
        } else if (collection === 'quotes') {
            const count = await QuoteModel.countDocuments();
            const query: any = number ? { Number: number } : {};
            const docs = await QuoteModel.find(query).sort({ Number: -1 }).limit(limit).lean();
            logger.info({ collection, count, picked: docs.length }, 'Collection overview');
            for (const doc of docs) {
                const anyDoc: any = doc as any;
                logger.info({ Number: anyDoc.Number, CustomerCode: anyDoc.CustomerCode, Date: anyDoc.Date, NetAmount: anyDoc.NetAmount, GrossAmount: anyDoc.GrossAmount, keys: Object.keys(anyDoc).slice(0, 30) }, 'Quote sample');
            }
        } else if (collection === 'projects') {
            const count = await ProjectModel.countDocuments();
            const query: any = number ? { Number: number } : {};
            const docs = await ProjectModel.find(query).sort({ Number: -1 }).limit(limit).lean();
            logger.info({ collection, count, picked: docs.length }, 'Collection overview');
            for (const doc of docs) {
                const anyDoc: any = doc as any;
                logger.info({ Number: anyDoc.Number, Name: anyDoc.Name, CustomerId: anyDoc.CustomerId, StartDate: anyDoc.StartDate, EndDate: anyDoc.EndDate, Status: anyDoc.Status, keys: Object.keys(anyDoc).slice(0, 30) }, 'Project sample');
            }
        } else {
            logger.warn({ collection }, 'Unknown collection');
        }
    } catch (err) {
        logger.error({ err }, 'Inspect failed');
        process.exitCode = 1;
    } finally {
        await disconnectMongoose();
        await stopSshTunnel();
    }
}

run();
