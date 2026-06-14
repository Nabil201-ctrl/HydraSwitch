import * as Paystack from './paystack';

export interface ProviderAdapter {
  name: 'paystack' | 'mock';
  initialize?: (intent: any) => Promise<any>;
  verify?: (intent: any) => Promise<any>;
}

export { Paystack };

export function getDefaultProvider(): 'paystack' | 'mock' {
  const fromEnv = (process.env.DEFAULT_PROVIDER || '').toLowerCase();
  if (fromEnv === 'mock') return 'mock';
  // Default to paystack if a secret key is present, otherwise fall back to mock
  if (process.env.PAYSTACK_SECRET_KEY) return 'paystack';
  return 'mock';
}
