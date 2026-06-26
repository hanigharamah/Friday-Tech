import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { simulateBankTransfer } from '../src/simulators/bank.js';

const prisma = new PrismaClient();

async function createFixture() {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { name: 'Bank User', email: `bank-${uid}@t.com`, virtualIban: `SA-BNK-${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: 0n, heldHalalas: 0n },
  });
  return { user, wallet };
}

describe('Bank transfer simulator — credits', () => {
  it('credits wallet and returns CREDITED status', async () => {
    const { user, wallet } = await createFixture();

    const result = await simulateBankTransfer({
      virtualIban: user.virtualIban,
      amountSar: 100,
    });

    expect(result.status).toBe('CREDITED');
    expect(result.amount_halalas).toBe('10000'); // 100 SAR × 100
    expect(result.wallet_id).toBe(wallet.id);

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(10_000n);
  });

  it('SAR conversion: 500 SAR = 50,000 halalas', async () => {
    const { user, wallet } = await createFixture();

    await simulateBankTransfer({ virtualIban: user.virtualIban, amountSar: 500 });

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(50_000n);
  });

  it('SAR conversion: 1.5 SAR = 150 halalas', async () => {
    const { user, wallet } = await createFixture();

    await simulateBankTransfer({ virtualIban: user.virtualIban, amountSar: 1.5 });

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(150n);
  });

  it('auto-generates bank_reference when omitted', async () => {
    const { user } = await createFixture();

    const result = await simulateBankTransfer({ virtualIban: user.virtualIban, amountSar: 50 });

    expect(result.status).toBe('CREDITED');
    expect(result.bank_reference).toMatch(/^BNK-/);
  });

  it('writes a TOPUP_CREDIT ledger entry', async () => {
    const { user, wallet } = await createFixture();

    await simulateBankTransfer({ virtualIban: user.virtualIban, amountSar: 200 });

    const entry = await prisma.ledgerEntry.findFirst({
      where: { walletId: wallet.id, type: 'TOPUP_CREDIT' },
    });
    expect(entry).not.toBeNull();
    expect(entry!.amountHalalas).toBe(20_000n);
  });
});

describe('Bank transfer simulator — deduplication', () => {
  it('deduplicates on bank_reference — second call returns DUPLICATE', async () => {
    const { user, wallet } = await createFixture();
    const ref = `DEDUP-${Date.now()}`;

    const first = await simulateBankTransfer({ virtualIban: user.virtualIban, amountSar: 50, bankReference: ref });
    expect(first.status).toBe('CREDITED');

    const second = await simulateBankTransfer({ virtualIban: user.virtualIban, amountSar: 50, bankReference: ref });
    expect(second.status).toBe('DUPLICATE');

    // Balance only credited once
    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(5_000n);
  });
});

describe('Bank transfer simulator — error cases', () => {
  it('unknown virtual IBAN throws 404', async () => {
    await expect(
      simulateBankTransfer({ virtualIban: 'SA-NONEXISTENT-99999', amountSar: 10 })
    ).rejects.toThrow(/IBAN not found/i);
  });
});
