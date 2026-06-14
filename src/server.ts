import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  PaymentIntentSchema,
  PaymentState,
  PaymentIntent,
  PaymentIntentResponse,
  CreatePaymentIntentInput,
} from './types';
import {
  getPaymentIntent,
  getPaymentIntentByIdempotencyKey,
  savePaymentIntent,
  updatePaymentIntent,
  recordIdempotencyKey,
  listPaymentIntents,
  loadStore,
  clearStoreForTesting,
} from './store';
import {
  createInitialIntent,
  markAsPending,
  transitionTo,
  simulateSuccessPath,
  getAllowedNextStates,
} from './stateMachine';
import { getDefaultProvider, Paystack } from './providers';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const IDEMPOTENCY_REPLAY_HEADER = 'idempotency-replay';

const TERMINAL_STATES = new Set<PaymentState>([
  PaymentState.SETTLED,
  PaymentState.DECLINED,
  PaymentState.VOIDED,
  PaymentState.EXPIRED,
]);

function getIdempotencyKey(req: FastifyRequest): string | undefined {
  const h = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];
  if (!h) return undefined;
  if (Array.isArray(h)) return h[0];
  return h;
}

function isoNow(): string {
  return new Date().toISOString();
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
      },
    },
  });

  loadStore();

  await app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/public/',
  });

  app.get('/', async (_req, reply) => {
    return reply.sendFile('index.html', path.join(__dirname, '../public'));
  });

  app.get('/public', async (_req, reply) => {
    return reply.sendFile('index.html', path.join(__dirname, '../public'));
  });

  app.get('/health', async () => ({ status: 'ok', time: isoNow() }));

  const CreateBodySchema = PaymentIntentSchema;

  app.post('/v1/payment-intents', async (req: FastifyRequest, reply: FastifyReply) => {
    const idempotencyKey = getIdempotencyKey(req);

    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return reply.code(400).send({
        error: 'Idempotency-Key header is required',
        message: `Provide a unique ${IDEMPOTENCY_HEADER} for safe retries`,
      });
    }

    const existing = getPaymentIntentByIdempotencyKey(idempotencyKey.trim());
    if (existing) {
      const response: PaymentIntentResponse = {
        ...existing,
        is_replay: true,
      };
      reply.header(IDEMPOTENCY_REPLAY_HEADER, 'true');
      return reply.code(200).send(response);
    }

    let input: CreatePaymentIntentInput;
    try {
      input = CreateBodySchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'ValidationError', issues: err.issues });
      }
      throw err;
    }

    const vaultToken = (req.body as any)?.vault_token || `tok_${uuidv4().replace(/-/g, '')}`;

    // Choose provider: paystack (real) when secret key present, otherwise mock
    const requestedProvider = (input as any).provider || (req.body as any)?.provider;
    const activeProvider = requestedProvider === 'mock' ? 'mock' : getDefaultProvider();

    const intentId = uuidv4();
    let intent = createInitialIntent({
      id: intentId,
      idempotency_key: idempotencyKey.trim(),
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      metadata: input.metadata,
      vault_token: vaultToken,
      active_provider: activeProvider,
    });

    // Store customer email (Paystack requires it for initialize)
    const emailFromBody = (input as any).customer_email || (req.body as any)?.customer_email;
    if (emailFromBody) {
      intent.metadata = intent.metadata || {};
      (intent.metadata as any).customer_email = emailFromBody;
    }

    intent = markAsPending(intent);

    savePaymentIntent(intent);
    recordIdempotencyKey(idempotencyKey.trim(), intent.id);

    const response: PaymentIntentResponse = { ...intent, is_replay: false };
    return reply.code(201).send(response);
  });

  app.get('/v1/payment-intents/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const { id } = req.params;
    const intent = getPaymentIntent(id);
    if (!intent) {
      return reply.code(404).send({ error: 'NotFound', message: 'Payment intent not found' });
    }
    return reply.send(intent);
  });

  app.get('/v1/payment-intents', async (req, reply) => {
    const limit = Number((req.query as any)?.limit) || 20;
    return reply.send(listPaymentIntents(Math.min(limit, 100)));
  });

  const TransitionSchema = z.object({
    state: z.enum([
      PaymentState.PENDING,
      PaymentState.AUTHORIZED,
      PaymentState.CAPTURED,
      PaymentState.SETTLED,
      PaymentState.DECLINED,
      PaymentState.VOIDED,
      PaymentState.EXPIRED,
    ]),
  });

  app.post('/v1/payment-intents/:id/transition', async (req, reply) => {
    const { id } = req.params as { id: string };
    const intent = getPaymentIntent(id);
    if (!intent) {
      return reply.code(404).send({ error: 'NotFound' });
    }

    let body: { state: PaymentState };
    try {
      body = TransitionSchema.parse(req.body);
    } catch (e) {
      return reply.code(400).send({ error: 'Invalid transition payload' });
    }

    try {
      const updated = transitionTo(intent, body.state);
      updatePaymentIntent(updated);
      return reply.send(updated);
    } catch (e: any) {
      return reply.code(409).send({ error: 'InvalidTransition', message: e.message });
    }
  });

  app.post('/v1/payment-intents/:id/process', async (req, reply) => {
    const { id } = req.params as { id: string };
    const intent = getPaymentIntent(id);
    if (!intent) {
      return reply.code(404).send({ error: 'NotFound' });
    }

    if (TERMINAL_STATES.has(intent.state)) {
      return reply.code(409).send({
        error: 'AlreadyTerminal',
        message: `Cannot process intent already in ${intent.state}`,
        intent,
      });
    }

    const processed = simulateSuccessPath(intent);
    updatePaymentIntent(processed);

    return reply.send({
      message: 'Processed through success path',
      intent: processed,
    });
  });

  app.post('/v1/payment-intents/:id/decline', async (req, reply) => {
    const { id } = req.params as { id: string };
    const intent = getPaymentIntent(id);
    if (!intent) return reply.code(404).send({ error: 'NotFound' });

    if (TERMINAL_STATES.has(intent.state)) {
      return reply.code(409).send({ error: 'AlreadyTerminal', intent });
    }

    try {
      const updated = transitionTo(intent, PaymentState.DECLINED);
      updatePaymentIntent(updated);
      return reply.send(updated);
    } catch (e: any) {
      return reply.code(409).send({ error: 'InvalidTransition', message: e.message });
    }
  });

  // ===================== PAYSTACK REAL INTEGRATION =====================
  // Real calls to Paystack so the orchestration demonstrates actual PSP handoff,
  // customer checkout, and verification back into our state machine + timestamps.

  app.post('/v1/payment-intents/:id/initialize-paystack', async (req, reply) => {
    const { id } = req.params as { id: string };
    const intent = getPaymentIntent(id);
    if (!intent) return reply.code(404).send({ error: 'NotFound' });

    if (intent.active_provider !== 'paystack') {
      return reply.code(400).send({ error: 'NotPaystackProvider', message: 'This intent is not configured for Paystack' });
    }
    if (TERMINAL_STATES.has(intent.state)) {
      return reply.code(409).send({ error: 'AlreadyTerminal', intent });
    }

    const email = (intent.metadata as any)?.customer_email || 'customer@hydraswitch.test';
    const amountInSmallest = intent.amount;

    try {
      const reference = Paystack.generatePaystackReference(intent.id);
      const initData = await Paystack.initializeTransaction({
        amount: amountInSmallest,
        currency: intent.currency,
        email,
        reference,
        metadata: { intent_id: intent.id, ...(intent.metadata || {}) },
      });

      intent.paystack = {
        reference: initData.reference,
        access_code: initData.access_code,
        authorization_url: initData.authorization_url,
        status: 'initialized',
      };

      const updated = transitionTo(intent, PaymentState.AUTHORIZED);
      updatePaymentIntent(updated);

      return reply.send({
        message: 'Paystack transaction initialized',
        intent: updated,
        paystack_checkout_url: initData.authorization_url,
      });
    } catch (e: any) {
      return reply.code(502).send({ error: 'PaystackError', message: e.message });
    }
  });

  app.post('/v1/payment-intents/:id/verify-paystack', async (req, reply) => {
    const { id } = req.params as { id: string };
    const intent = getPaymentIntent(id);
    if (!intent) return reply.code(404).send({ error: 'NotFound' });

    if (!intent.paystack?.reference) {
      return reply.code(400).send({ error: 'NoPaystackReference', message: 'Call /initialize-paystack first' });
    }
    if (TERMINAL_STATES.has(intent.state)) {
      return reply.code(409).send({ error: 'AlreadyTerminal', intent });
    }

    try {
      const verified = await Paystack.verifyTransaction(intent.paystack.reference);

      intent.paystack = {
        ...intent.paystack,
        status: verified.status,
        gateway_response: verified.gateway_response,
        paid_at: verified.paid_at || undefined,
        channel: verified.channel,
        fees: verified.fees,
      };

      let finalIntent = intent;

      if (verified.status === 'success') {
        if (intent.state !== PaymentState.CAPTURED) {
          finalIntent = transitionTo(intent, PaymentState.CAPTURED);
        }
        finalIntent = transitionTo(finalIntent, PaymentState.SETTLED);
      } else {
        finalIntent = transitionTo(intent, PaymentState.DECLINED);
      }

      updatePaymentIntent(finalIntent);

      return reply.send({
        message: `Paystack verification: ${verified.status}`,
        verified,
        intent: finalIntent,
      });
    } catch (e: any) {
      return reply.code(502).send({ error: 'PaystackVerifyError', message: e.message });
    }
  });

  // ===================== END PAYSTACK INTEGRATION =====================

  app.get('/v1/payment-intents/:id/allowed-transitions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const intent = getPaymentIntent(id);
    if (!intent) return reply.code(404).send({ error: 'NotFound' });
    return reply.send({ current: intent.state, allowed: getAllowedNextStates(intent.state) });
  });

  app.get('/v1/providers/health', async () => ({
    providers: [
      { id: 'stripe', status: 'UP', circuit_state: 'CLOSED', failure_rate: 0.01 },
      { id: 'adyen', status: 'UP', circuit_state: 'CLOSED', failure_rate: 0.03 },
      { id: 'paypal', status: 'DEGRADED', circuit_state: 'HALF_OPEN', failure_rate: 0.12 },
    ],
  }));

  app.post('/dev/reset', async (_req, reply) => {
    clearStoreForTesting();
    loadStore();
    return reply.send({ ok: true, message: 'Demo data wiped' });
  });

  return app;
}
