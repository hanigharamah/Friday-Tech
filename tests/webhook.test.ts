import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { bankWebhookTopup } from '../src/modules/topup.js';
import { signPayload, verifySignature } from '../src/lib/hmac.js';

const prisma = new PrismaClient();

async function createUser() {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { name: 'WH User', email: `wh-${uid}@t.com`, virtualIban: `SA-WH-${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: 0n, heldHalalas: 0n },
  });
  return { user, wallet, uid };
}

// ─── HMAC signature verification ──────────────────────────────────────────────

describe('HMAC signature verification', () => {
  it('accepts a correct signature', () => {
    const payload = '{"test":"data"}';
    const sig = signPayload('my-secret', payload);
    expect(verifySignature('my-secret', payload, sig)).toBe(true);
  });

  it('rejects wrong secret', () => {
    const sig = signPayload('correct-secret', '{"a":1}');
    expect(verifySignature('wrong-secret', '{"a":1}', sig)).toBe(false);
  });

  it('rejects tampered payload', () => {
    const sig = signPayload('s', '{"amount":1000}');
    expect(verifySignature('s', '{"amount":9999}', sig)).toBe(false);
  });

  it('rejects garbled signature string', () => {
    const sig = signPayload('s', '{"a":1}');
    expect(verifySignature('s', '{"a":1}', sig.slice(0, -2) + 'ff')).toBe(false);
  });
});

// ─── Bank webhook deduplication ───────────────────────────────────────────────

describe('Bank webhook deduplication', () => {
  it('credits wallet on first call', async () => {
    const { user, wallet, uid } = await createUser();

    const result = await bankWebhookTopup({
      bankReference: `BNK-${uid}`,
      virtualIban: user.virtualIban,
      amountHalalas: 10_000n,
    });

    expect(result).not.toBeNull();
    expect(result!.amount_halalas).toBe('10000');

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(10_000n);
  });

  it('ignores duplicate bank_reference — wallet credited only once', async () => {
    const { user, wallet, uid } = await createUser();
    const ref = `BNK-DUP-${uid}`;

    await bankWebhookTopup({ bankReference: ref, virtualIban: user.virtualIban, amountHalalas: 10_000n });
    const dup = await bankWebhookTopup({ bankReference: ref, virtualIban: user.virtualIban, amountHalalas: 10_000n });

    expect(dup).toBeNull(); // duplicate suppressed

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(10_000n); // credited only once
  });

  it('rejects unknown virtual IBAN', async () => {
    await expect(
      bankWebhookTopup({ bankReference: 'BNK-X', virtualIban: 'SA-DOES-NOT-EXIST', amountHalalas: 1_000n })
    ).rejects.toThrow(/IBAN/i);
  });
});
