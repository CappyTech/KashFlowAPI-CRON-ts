// Placeholder for state management using the requested "mongo-connect" store.
// We'll implement a simple collection-based store now and swap to mongo-connect if you confirm the exact package.
import mongoose from '../db/mongoose.js';
const schema = new mongoose.Schema({
    _id: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed },
    updatedAt: { type: Date, default: Date.now },
}, { collection: 'app_state', versionKey: false });
schema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});
const StateModel = mongoose.model('State', schema);
export async function getState(key) {
    const doc = await StateModel.findById(key).lean();
    return doc?.value ?? undefined;
}
export async function setState(key, value) {
    await StateModel.findByIdAndUpdate(key, { value, updatedAt: new Date() }, { upsert: true, setDefaultsOnInsert: true });
}
