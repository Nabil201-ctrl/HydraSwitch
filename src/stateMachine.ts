import { PaymentIntent, PaymentState, VALID_TRANSITIONS, StateTransition } from './types';

const nowIso = () => new Date().toISOString();

function addHistory(intent: PaymentIntent, state: PaymentState): void {
  const transition: StateTransition = { state, at: nowIso() };
  if (!intent.state_history) intent.state_history = [];
  intent.state_history.push(transition);
}

function setTimestampForState(intent: PaymentIntent, state: PaymentState): void {
  const ts = nowIso();

  switch (state) {
    case PaymentState.INITIATED:
      if (!intent.initiated_at) intent.initiated_at = ts;
      break;
    case PaymentState.PENDING:
      intent.pending_at = ts;
      break;
    case PaymentState.AUTHORIZED:
      intent.authorized_at = ts;
      break;
    case PaymentState.CAPTURED:
      intent.captured_at = ts;
      intent.completed_at = ts;
      intent.success_at = ts;
      break;
    case PaymentState.SETTLED:
      intent.settled_at = ts;
      intent.completed_at = ts;
      intent.success_at = ts;
      break;
    case PaymentState.DECLINED:
      intent.declined_at = ts;
      break;
    case PaymentState.VOIDED:
      intent.voided_at = ts;
      break;
    case PaymentState.EXPIRED:
      intent.expired_at = ts;
      break;
  }
}

export function transitionTo(intent: PaymentIntent, nextState: PaymentState): PaymentIntent {
  const current = intent.state;

  if (current === nextState) {
    return intent;
  }

  const allowed = VALID_TRANSITIONS[current] || [];
  if (!allowed.includes(nextState)) {
    throw new Error(`Invalid state transition: ${current} -> ${nextState}`);
  }

  intent.state = nextState;

  setTimestampForState(intent, nextState);

  addHistory(intent, nextState);

  return intent;
}

export function createInitialIntent(params: {
  id: string;
  idempotency_key: string;
  amount: number;
  currency: string;
  description?: string;
  metadata?: Record<string, unknown>;
  vault_token?: string;
  active_provider?: string;
}): PaymentIntent {
  const ts = nowIso();

  const intent: PaymentIntent = {
    id: params.id,
    idempotency_key: params.idempotency_key,
    amount: params.amount,
    currency: params.currency,
    state: PaymentState.INITIATED,
    active_provider: params.active_provider,
    vault_token: params.vault_token,
    retry_count: 0,
    description: params.description,
    metadata: params.metadata,
    created_at: ts,
    updated_at: ts,
    state_history: [],
  };

  setTimestampForState(intent, PaymentState.INITIATED);
  addHistory(intent, PaymentState.INITIATED);

  return intent;
}

export function markAsPending(intent: PaymentIntent, provider?: string): PaymentIntent {
  if (provider) {
    intent.active_provider = provider;
  }
  return transitionTo(intent, PaymentState.PENDING);
}

export function simulateSuccessPath(intent: PaymentIntent): PaymentIntent {
  if (intent.state === PaymentState.INITIATED) {
    transitionTo(intent, PaymentState.PENDING);
  }
  if (intent.state === PaymentState.PENDING) {
    transitionTo(intent, PaymentState.AUTHORIZED);
  }
  if (intent.state === PaymentState.AUTHORIZED) {
    transitionTo(intent, PaymentState.CAPTURED);
  }
  if (intent.state === PaymentState.CAPTURED) {
    transitionTo(intent, PaymentState.SETTLED);
  }
  return intent;
}

export function simulateDecline(intent: PaymentIntent, fromState?: PaymentState): PaymentIntent {
  const target = fromState || intent.state;
  if (target === PaymentState.INITIATED || target === PaymentState.PENDING) {
    return transitionTo(intent, PaymentState.DECLINED);
  }
  if (target === PaymentState.AUTHORIZED) {
    return transitionTo(intent, PaymentState.DECLINED);
  }
  return transitionTo(intent, PaymentState.DECLINED);
}

export function getAllowedNextStates(state: PaymentState): PaymentState[] {
  return VALID_TRANSITIONS[state] || [];
}
