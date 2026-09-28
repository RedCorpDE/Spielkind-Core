import { createHmac, timingSafeEqual } from 'node:crypto';

export class StripeSignatureError extends Error {
  constructor(message = 'Invalid Stripe webhook signature.') {
    super(message);
    this.name = 'StripeSignatureError';
  }
}

function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') timestamp = Number(value);
    if (key === 'v1' && /^[a-f0-9]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (!Number.isInteger(timestamp) || !signatures.length) throw new StripeSignatureError();
  return { timestamp: timestamp as number, signatures };
}

export function verifyStripeWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string;
  secret: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): void {
  const { timestamp, signatures } = parseSignatureHeader(input.signatureHeader);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) {
    throw new StripeSignatureError('Stripe webhook signature timestamp is outside the tolerance window.');
  }
  const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.rawBody}`, 'utf8').digest();
  const valid = signatures.some((signature) => {
    const actual = Buffer.from(signature, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  if (!valid) throw new StripeSignatureError();
}
