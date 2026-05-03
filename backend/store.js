// Mongoose write-through store — in-memory cache with async persistence.
// Falls back to pure in-memory when MONGO_URI is not set.
import mongoose from 'mongoose';

const { Schema, model } = mongoose;

// Single flexible schema — _id is the business key (UUID / hex string)
const flexSchema = new Schema({ _id: String }, { strict: false, versionKey: false });

function getModel(name) {
  return mongoose.models[name] ?? model(name, flexSchema, name);
}

/**
 * MongoMap — drop-in Map replacement backed by Mongoose.
 *
 * All reads are synchronous (in-memory cache — no latency change for routes).
 * Writes (set / delete) fire async upserts to MongoDB.
 * In-place property mutations (deal.status = 'LOCKED') are captured via
 * Proxy and batched into a single save per microtask.
 */
class MongoMap {
  constructor(collectionName) {
    this._name = collectionName;
    this._map  = new Map();
  }

  _persist(key, value) {
    if (mongoose.connection.readyState !== 1) return;
    const m = getModel(this._name);
    let doc;
    if (typeof value === 'object' && value !== null) {
      const { __pendingSave: _p, _id: _i, ...data } = value;
      doc = { _id: key, ...data };
    } else {
      doc = { _id: key, __primitiveValue: value };
    }
    m.replaceOne({ _id: key }, doc, { upsert: true })
     .catch(e => console.error(`[Mongoose] ${this._name}.set(${key}):`, e.message));
  }

  _proxy(key, obj) {
    const self = this;
    return new Proxy(obj, {
      set(target, prop, val) {
        target[prop] = val;
        if (!target.__pendingSave) {
          target.__pendingSave = true;
          Promise.resolve().then(() => {
            delete target.__pendingSave;
            self._persist(key, target);
          });
        }
        return true;
      },
    });
  }

  get(key) {
    const v = this._map.get(key);
    if (v == null || typeof v !== 'object') return v;
    return this._proxy(key, v);
  }

  set(key, value) {
    this._map.set(key, value);
    this._persist(key, value);
    return this;
  }

  delete(key) {
    const existed = this._map.delete(key);
    if (existed && mongoose.connection.readyState === 1) {
      getModel(this._name).deleteOne({ _id: key })
        .catch(e => console.error(`[Mongoose] ${this._name}.delete(${key}):`, e.message));
    }
    return existed;
  }

  has(key)             { return this._map.has(key); }
  values()             { return this._map.values(); }
  entries()            { return this._map.entries(); }
  keys()               { return this._map.keys(); }
  get size()           { return this._map.size; }
  [Symbol.iterator]()  { return this._map[Symbol.iterator](); }

  async _load() {
    if (mongoose.connection.readyState !== 1) return;
    const docs = await getModel(this._name).find({}).lean();
    for (const { _id, __primitiveValue, ...rest } of docs) {
      this._map.set(_id, __primitiveValue !== undefined ? __primitiveValue : rest);
    }
    console.log(`[Mongoose] ${this._name}: loaded ${docs.length} docs`);
  }
}

// ── Exported collections ──────────────────────────────────────────────────────

export const agents       = new MongoMap('agents');
export const apiKeys      = new MongoMap('apiKeys');
export const offers       = new MongoMap('offers');
export const deals        = new MongoMap('deals');
export const listings     = new MongoMap('listings');
export const negotiations = new MongoMap('negotiations');

// ── DB init (called once before server starts) ────────────────────────────────

export async function initDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI environment variable is required');

  await mongoose.connect(uri, { dbName: 'phantom' });
  console.log('[Mongoose] Connected to', mongoose.connection.db.databaseName);

  await Promise.all([
    agents._load(),
    apiKeys._load(),
    offers._load(),
    deals._load(),
    listings._load(),
    negotiations._load(),
  ]);
}


