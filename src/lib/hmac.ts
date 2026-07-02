import { createHmac, timingSafeEqual } from 'crypto';

export function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifySignature(
  secret: string,
  payload: string,
  providedSignature: string
): boolean {
  const expected = signPayload(secret, payload);
  try {
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(providedSignature, 'hex')
    );
  } catch {
    return false;
  }
}
