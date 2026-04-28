import crypto from 'node:crypto';

export function signRegiondoRequest(input: {
  timestamp: number;
  publicKey: string;
  secretKey: string;
  queryParams: URLSearchParams;
}): string {
  const message = `${input.timestamp}${input.publicKey}${input.queryParams.toString()}`;
  return crypto.createHmac('sha256', input.secretKey).update(message).digest('hex');
}

export function verifyRegiondoWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}
