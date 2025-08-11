import 'dotenv/config';
import mongoose from '../db/mongoose.js';
import { CustomerModel, SupplierModel, InvoiceModel, QuoteModel, ProjectModel, PurchaseModel } from '../db/models.js';
import { v4 as uuidv4 } from 'uuid';

async function backfill(model: any, name: string) {
  const missing = await model.find({ $or: [ { uuid: { $exists: false } }, { uuid: null }, { uuid: '' } ] }, { _id: 1 }).lean();
  let updated = 0;
  for (const doc of missing) {
    await model.updateOne({ _id: doc._id }, { $set: { uuid: uuidv4(), updatedAt: new Date() } });
    updated += 1;
    if (updated % 500 === 0) console.log(`[${name}] updated ${updated}`);
  }
  console.log(`[${name}] backfilled ${updated} UUIDs`);
}

async function main() {
  try {
    await (await import('../db/mongoose.js')).connectMongoose();
    await backfill(CustomerModel, 'customers');
    await backfill(SupplierModel, 'suppliers');
    await backfill(InvoiceModel, 'invoices');
    await backfill(QuoteModel, 'quotes');
    await backfill(ProjectModel, 'projects');
    await backfill(PurchaseModel, 'purchases');
  // Ensure indexes reflect new UUID values
  await CustomerModel.syncIndexes();
  await SupplierModel.syncIndexes();
  await InvoiceModel.syncIndexes();
  await QuoteModel.syncIndexes();
  await ProjectModel.syncIndexes();
  await PurchaseModel.syncIndexes();
  } catch (e) {
    console.error('Backfill failed', e);
  } finally {
    await (await import('../db/mongoose.js')).disconnectMongoose();
    process.exit(0);
  }
}

main();
