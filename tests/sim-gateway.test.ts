import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { simulateCharge } from '../src/simulators/gateway.js';

const prisma = new PrismaClient();

async function createFixture() {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { name: 'GW User', email: `gw-${uid}@t.com`, virtualIban: `SA-GW-${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: 0n, heldHalalas: 0n },
  });
  return { wallet };
}

describe('Gateway simulator — success outcomes', () => {
  it('APPLE_PAY success credits the wallet', async () => {
    const { wallet } = await createFixture();

    const result = await simulateCharge({
      walletId: wallet.id,
      amountHalalas: 10_000,
      method: 'APPLE_PAY',
      outcome: 'success',
    });

    expect(result.status).toBe('CAPTURED');
    expect(result.outcome).toBe('success');
    expect(result.charge_id).toMatch(/^GW-/);

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(10_000n);
  });

  it('CARD success credits the wallet and writes a ledger entry', async () => {
    const { wallet } = await createFixture();

    const result = await simulateCharge({
      walletId: wallet.id,
      amountHalalas: 5_000,
      method: 'CARD',
      outcome: 'success',
    });

    expect(result.status).toBe('CAPTURED');

    const entry = await prisma.ledgerEntry.findFirst({
      where: { walletId: wallet.id, type: 'TOPUP_CREDIT' },
    });
    expect(entry).not.toBeNull();
    expect(entry!.amountHalalas).toBe(5_000n);
  });
});

describe('Gateway simulator — failure outcomes', () => {
  it('declined does not credit the wallet', async () => {
    const { wallet } = await createFixture();

    const result = await simulateCharge({
      walletId: wallet.id,
      amountHalalas: 5_000,
      method: 'CARD',
      outcome: 'declined',
    });

    expect(result.status).toBe('FAILED');
    expect(result.outcome).toBe('declined');

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(0n);
  });

  it('insufficient_funds does not credit the wallet', async () => {
    const { wallet } = await createFixture();

    const result = await simulateCharge({
      walletId: wallet.id,
      amountHalalas: 5_000,
      method: 'CARD',
      outcome: 'insufficient_funds',
    });

    expect(result.status).toBe('FAILED');
    expect(result.outcome).toBe('insufficient_funds');

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(0n);
  });

  it('timeout does not credit the wallet', async () => {
    const { wallet } = await createFixture();

    const result = await simulateCharge({
      walletId: wallet.id,
      amountHalalas: 3_000,
      method: 'APPLE_PAY',
      outcome: 'timeout',
    });

    expect(result.status).toBe('FAILED');
    expect(result.outcome).toBe('timeout');

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(0n);
  });

  it('unknown wallet throws 404', async () => {
    await expect(
      simulateCharge({
        walletId: '00000000-0000-0000-0000-000000000000',
        amountHalalas: 1_000,
        method: 'CARD',
        outcome: 'success',
      })
    ).rejects.toThrow(/Wallet not found/i);
  });
});
