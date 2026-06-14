import fs from 'fs';
import path from 'path';
import { PaymentIntent, IdempotencyRecord, PaymentState } from './types';

const DATA_DIR = path.resolve(__dirname, '../data');
const INTENTS_FILE = path.join(DATA_DIR, 'payment_intents.json');
const IDEMPOTENCY_FILE = path.join(DATA_DIR, 'idempotency_keys.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadJson<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    }
  } catch (e) {
    console.warn(`Failed to load ${filePath}, using fallback`, e);
  }
  return fallback;
}

function saveJson(filePath: string, data: unknown) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

let paymentIntents: Map<string, PaymentIntent> = new Map();
let idempotencyKeys: Map<string, IdempotencyRecord> = new Map();

export function loadStore() {
  ensureDataDir();

  const savedIntents = loadJson<Record<string, PaymentIntent>>(INTENTS_FILE, {});
  paymentIntents = new Map(Object.entries(savedIntents));

  const savedKeys = loadJson<Record<string, IdempotencyRecord>>(IDEMPOTENCY_FILE, {});
  idempotencyKeys = new Map(Object.entries(savedKeys));

  console.log(`[store] Loaded ${paymentIntents.size} payment intents, ${idempotencyKeys.size} idempotency keys`);
}

export function persistStore() {
  const intentsObj: Record<string, PaymentIntent> = {};
  for (const [id, intent] of paymentIntents) {
    intentsObj[id] = intent;
  }
  saveJson(INTENTS_FILE, intentsObj);

  const keysObj: Record<string, IdempotencyRecord> = {};
  for (const [key, rec] of idempotencyKeys) {
    keysObj[key] = rec;
  }
  saveJson(IDEMPOTENCY_FILE, keysObj);
}

export function getPaymentIntent(id: string): PaymentIntent | undefined {
  return paymentIntents.get(id);
}

export function getPaymentIntentByIdempotencyKey(key: string): PaymentIntent | undefined {
  const record = idempotencyKeys.get(key);
  if (!record) return undefined;
  return paymentIntents.get(record.intent_id);
}

export function savePaymentIntent(intent: PaymentIntent): void {
  paymentIntents.set(intent.id, intent);
  if (!idempotencyKeys.has(intent.idempotency_key)) {
    idempotencyKeys.set(intent.idempotency_key, {
      key: intent.idempotency_key,
      intent_id: intent.id,
      created_at: intent.created_at,
    });
  }
  persistStore();
}

export function updatePaymentIntent(intent: PaymentIntent): void {
  intent.updated_at = new Date().toISOString();
  paymentIntents.set(intent.id, intent);
  persistStore();
}

export function recordIdempotencyKey(key: string, intentId: string): void {
  const now = new Date().toISOString();
  idempotencyKeys.set(key, {
    key,
    intent_id: intentId,
    created_at: now,
  });
  persistStore();
}

export function listPaymentIntents(limit = 50): PaymentIntent[] {
  return Array.from(paymentIntents.values())
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export function clearStoreForTesting() {
  paymentIntents.clear();
  idempotencyKeys.clear();
  try {
    if (fs.existsSync(INTENTS_FILE)) fs.unlinkSync(INTENTS_FILE);
    if (fs.existsSync(IDEMPOTENCY_FILE)) fs.unlinkSync(IDEMPOTENCY_FILE);
  } catch {}
}
