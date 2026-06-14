import 'dotenv/config';
import { buildServer } from './server';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = await buildServer();

  try {
    await app.listen({ port: PORT, host: HOST });
    const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    const hasPaystack = !!process.env.PAYSTACK_SECRET_KEY;
    console.log(`\n🚀 HydraSwitch is running`);
    console.log(`\n   👉  Open the simple UI for non-technical testing:`);
    console.log(`       ${url}`);
    console.log(`\n   Paystack: ${hasPaystack ? 'ENABLED ✓ (real test transactions)' : 'DISABLED (mock provider only — add PAYSTACK_SECRET_KEY)'}`);
    console.log(`\n   API endpoints (for developers):`);
    console.log(`   • POST   ${url}/v1/payment-intents            (Idempotency-Key header required)`);
    console.log(`   • POST   ${url}/v1/payment-intents/:id/initialize-paystack`);
    console.log(`   • POST   ${url}/v1/payment-intents/:id/verify-paystack`);
    console.log(`   • POST   ${url}/v1/payment-intents/:id/process   (mock instant success path)`);
    console.log(`   • POST   ${url}/dev/reset                      (clears demo data)`);
    console.log(`\n   Press Ctrl+C to stop.\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
