import { z } from 'zod';

export const PaymentState = {
  INITIATED: 'INITIATED',
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  SETTLED: 'SETTLED',
  DECLINED: 'DECLINED',
  VOIDED: 'VOIDED',
  EXPIRED: 'EXPIRED',
} as const;

export type PaymentState = typeof PaymentState[keyof typeof PaymentState];

export const VALID_TRANSITIONS: Record<PaymentState, PaymentState[]> = {
  [PaymentState.INITIATED]: [PaymentState.PENDING, PaymentState.DECLINED, PaymentState.EXPIRED],
  [PaymentState.PENDING]: [PaymentState.AUTHORIZED, PaymentState.DECLINED, PaymentState.EXPIRED],
  [PaymentState.AUTHORIZED]: [PaymentState.CAPTURED, PaymentState.VOIDED, PaymentState.DECLINED, PaymentState.EXPIRED],
  [PaymentState.CAPTURED]: [PaymentState.SETTLED, PaymentState.DECLINED],
  [PaymentState.SETTLED]: [],
  [PaymentState.DECLINED]: [],
  [PaymentState.VOIDED]: [],
  [PaymentState.EXPIRED]: [],
};

export const PaymentIntentSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3).toUpperCase(),
  description: z.string().max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // New: allow choosing provider at creation time (paystack | mock)
  provider: z.enum(['paystack', 'mock']).optional(),
  // Customer email is required by Paystack for transaction initialization
  customer_email: z.string().email().optional(),
});

export type CreatePaymentIntentInput = z.infer<typeof PaymentIntentSchema>;

// Extended fields stored on the intent for real providers
export interface PaystackDetails {
  reference?: string;
  access_code?: string;
  authorization_url?: string;
  status?: string;           // 'success' | 'failed' | 'abandoned' etc from Paystack
  gateway_response?: string;
  paid_at?: string;
  channel?: string;
  fees?: number;
}

export interface StateTransition {
  state: PaymentState;
  at: string;
}

export interface PaymentIntent {
  id: string;
  idempotency_key: string;
  amount: number;
  currency: string;
  state: PaymentState;
  active_provider?: string;
  vault_token?: string;
  retry_count: number;
  description?: string;
  metadata?: Record<string, unknown>;

  // Paystack integration fields (populated when active_provider === 'paystack')
  paystack?: PaystackDetails;

  created_at: string;
  updated_at: string;

  initiated_at?: string;
  pending_at?: string;
  authorized_at?: string;
  captured_at?: string;
  settled_at?: string;
  completed_at?: string;
  success_at?: string;
  declined_at?: string;
  voided_at?: string;
  expired_at?: string;

  state_history: StateTransition[];
}

export interface IdempotencyRecord {
  key: string;
  intent_id: string;
  created_at: string;
}

export interface PaymentIntentResponse extends PaymentIntent {
  is_replay?: boolean;
}
