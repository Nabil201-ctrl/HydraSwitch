/**
 * Paystack Provider Integration for HydraSwitch
 *
 * This implements the real calls to Paystack's API so that the orchestration
 * layer can initialize transactions and verify their status.
 *
 * Docs: https://paystack.com/docs/api/
 */

const PAYSTACK_BASE = 'https://api.paystack.co';

export interface InitializeParams {
  amount: number;           // in smallest currency unit (kobo for NGN)
  currency?: string;        // NGN, GHS, ZAR, etc. Default NGN
  email: string;
  reference?: string;       // optional, we can generate one
  metadata?: Record<string, unknown>;
  callback_url?: string;
}

export interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
}

export interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data: {
    id: number;
    domain: string;
    status: string;           // 'success' | 'failed' | 'abandoned'
    reference: string;
    amount: number;
    currency: string;
    paid_at: string | null;
    created_at: string;
    channel: string;
    gateway_response: string;
    fees: number;
    authorization?: any;
    customer?: any;
    metadata?: any;
  };
}

function getPaystackSecretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new Error('PAYSTACK_SECRET_KEY is not set in environment. Add it to .env');
  }
  return key;
}

async function paystackFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const secret = getPaystackSecretKey();

  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Paystack API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Initialize a transaction on Paystack.
 * This is the main entry point for sending a payment to Paystack.
 */
export async function initializeTransaction(params: InitializeParams): Promise<PaystackInitializeResponse['data']> {
  const body = {
    email: params.email,
    amount: params.amount, // Paystack expects amount in kobo (smallest unit)
    currency: params.currency || 'NGN',
    reference: params.reference,
    metadata: params.metadata,
    callback_url: params.callback_url,
  };

  const result = await paystackFetch<PaystackInitializeResponse>('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!result.status) {
    throw new Error(result.message || 'Paystack initialization failed');
  }

  return result.data;
}

/**
 * Verify a transaction using the reference returned from initialize.
 * Call this after the customer completes (or abandons) the payment on Paystack's page.
 */
export async function verifyTransaction(reference: string): Promise<PaystackVerifyResponse['data']> {
  const result = await paystackFetch<PaystackVerifyResponse>(`/transaction/verify/${reference}`);

  if (!result.status) {
    throw new Error(result.message || 'Paystack verification failed');
  }

  return result.data;
}

/**
 * Helper to generate a good reference (idempotent friendly).
 */
export function generatePaystackReference(intentId: string): string {
  return `hs_${intentId.replace(/-/g, '')}_${Date.now()}`;
}
