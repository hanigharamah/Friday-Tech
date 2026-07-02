import { createHash } from 'crypto';
import { prisma } from './db.js';

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export async function checkIdempotency(
  key: string,
  scope: string,
  requestHash: string
): Promise<{ hit: true; response: unknown } | { hit: false }> {
  const existing = await prisma.idempotencyKey.findUnique({
    where: { key },
  });
  if (existing && existing.scope === scope) {
    return { hit: true, response: JSON.parse(existing.responseJson) };
  }
  return { hit: false };
}

export async function storeIdempotency(
  key: string,
  scope: string,
  requestHash: string,
  response: unknown
): Promise<void> {
  await prisma.idempotencyKey.upsert({
    where: { key },
    create: {
      key,
      scope,
      requestHash,
      responseJson: JSON.stringify(response),
    },
    update: {},
  });
}
