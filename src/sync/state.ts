// Placeholder for state management using the requested "mongo-connect" store.
// We'll implement a simple collection-based store now and swap to mongo-connect if you confirm the exact package.
import mongoose from '../db/mongoose.js';

export interface StateDoc extends mongoose.Document {
    _id: string;
    value: any;
    updatedAt: Date;
}

const schema = new mongoose.Schema<StateDoc>(
    {
        _id: { type: String, required: true },
        value: { type: mongoose.Schema.Types.Mixed },
        updatedAt: { type: Date, default: Date.now },
    },
    { collection: 'app_state', versionKey: false }
);

schema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});

const StateModel = mongoose.model<StateDoc>('State', schema);

export async function getState<T = any>(key: string): Promise<T | undefined> {
    const doc = await StateModel.findById(key).lean();
    return (doc?.value as T) ?? undefined;
}

export async function setState<T = any>(key: string, value: T): Promise<void> {
    await StateModel.findByIdAndUpdate(
        key,
        { value, updatedAt: new Date() },
        { upsert: true, setDefaultsOnInsert: true }
    );
}
