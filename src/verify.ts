import { buildServer } from './server';

async function run() {
  const app = await buildServer();

  const IDEMPOTENCY_KEY = 'test-key-abc-12345';

  const res1 = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { 'idempotency-key': IDEMPOTENCY_KEY },
    payload: {
      amount: 2599,
      currency: 'usd',
      description: 'Test subscription payment',
    },
  });

  console.log('POST #1 (new):', res1.statusCode);
  const body1 = JSON.parse(res1.body);
  console.log('  id:', body1.id);
  console.log('  state:', body1.state);
  console.log('  pending_at:', body1.pending_at);
  console.log('  completed_at:', body1.completed_at);
  console.log('  success_at:', body1.success_at);
  console.log('  is_replay:', body1.is_replay);
  console.log('  active_provider:', body1.active_provider);

  if (!body1.pending_at) {
    throw new Error('FAIL: pending_at should be set immediately on creation (ingest to PENDING)');
  }
  if (body1.completed_at || body1.success_at) {
    throw new Error('FAIL: should not have completed/success yet');
  }

  const res2 = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { 'idempotency-key': IDEMPOTENCY_KEY },
    payload: {
      amount: 2599,
      currency: 'usd',
      description: 'Test subscription payment',
    },
  });

  console.log('\nPOST #2 (replay with same key):', res2.statusCode);
  const body2 = JSON.parse(res2.body);
  console.log('  id (must match):', body2.id);
  console.log('  is_replay:', body2.is_replay);

  if (res2.statusCode !== 200) throw new Error('Expected 200 on replay');
  if (body2.id !== body1.id) throw new Error('FAIL: replay must return same intent id');
  if (!body2.is_replay) throw new Error('FAIL: is_replay flag should be true');
  if (body2.pending_at !== body1.pending_at) throw new Error('FAIL: timestamps must be stable on replay');

  const res3 = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { 'idempotency-key': 'another-unique-key-67890' },
    payload: { amount: 1000, currency: 'EUR' },
  });
  const body3 = JSON.parse(res3.body);
  console.log('\nPOST #3 (different key):', res3.statusCode, 'id:', body3.id);
  if (body3.id === body1.id) throw new Error('Different keys must produce different ids');

  const processRes = await app.inject({
    method: 'POST',
    url: `/v1/payment-intents/${body1.id}/process`,
  });
  console.log('\nPOST /process (happy path):', processRes.statusCode);
  const processed = JSON.parse(processRes.body).intent || JSON.parse(processRes.body);
  console.log('  final state:', processed.state);
  console.log('  pending_at :', processed.pending_at);
  console.log('  authorized_at:', processed.authorized_at);
  console.log('  captured_at:', processed.captured_at);
  console.log('  settled_at :', processed.settled_at);
  console.log('  completed_at:', processed.completed_at);
  console.log('  success_at  :', processed.success_at);

  if (processed.state !== 'SETTLED') {
    throw new Error('FAIL: process should reach SETTLED');
  }
  if (!processed.pending_at) throw new Error('FAIL: pending_at lost');
  if (!processed.completed_at) throw new Error('FAIL: completed_at must be set on CAPTURED/SETTLED');
  if (!processed.success_at) throw new Error('FAIL: success_at must be set on successful completion');

  const reprocess = await app.inject({
    method: 'POST',
    url: `/v1/payment-intents/${body1.id}/process`,
  });
  console.log('\nRe-process (should 409):', reprocess.statusCode);

  const declineKey = 'decline-test-key';
  const createDecline = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { 'idempotency-key': declineKey },
    payload: { amount: 5000, currency: 'GBP' },
  });
  const toDecline = JSON.parse(createDecline.body);
  const declineRes = await app.inject({
    method: 'POST',
    url: `/v1/payment-intents/${toDecline.id}/decline`,
  });
  const declined = JSON.parse(declineRes.body);
  console.log('\nDeclined intent state:', declined.state);
  console.log('  declined_at:', declined.declined_at);
  console.log('  success_at:', declined.success_at);
  if (!declined.declined_at) throw new Error('FAIL: declined_at must be populated');
  if (declined.success_at || declined.completed_at) {
    throw new Error('FAIL: declined path must not set success/completed timestamps');
  }

  console.log('\n✅ ALL VERIFICATIONS PASSED');
  console.log('   - Idempotency keys correctly dedup requests (same key => same intent + replay flag)');
  console.log('   - pending_at is populated at PENDING transition time');
  console.log('   - completed_at + success_at populated exactly when reaching success states (CAPTURED/SETTLED)');
  console.log('   - declined path correctly avoids success timestamps\n');

  await app.close();
}

run().catch((e) => {
  console.error('VERIFICATION FAILED:', e);
  process.exit(1);
});
