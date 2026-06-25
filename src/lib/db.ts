import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

/**
 * Locks a wallet row for the duration of a transaction using
 * SELECT ... FOR UPDATE. This prevents concurrent authorizations
 * from reading a stale balance and overspending the wallet.
 *
 * Without this lock, two concurrent requests could both read
 * balance=1000, both compute max_ml based on that, and both reserve
 * funds — resulting in total reservations exceeding the balance.
 */
export async function lockWallet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  walletId: string
): Promise<{ id: string; balance_halalas: bigint; held_halalas: bigint }> {
  const rows = await tx.$queryRaw<{ id: string; balance_halalas: bigint; held_halalas: bigint }[]>`
    SELECT id, balance_halalas, held_halalas
    FROM wallets
    WHERE id = ${walletId}
    FOR UPDATE
  `;
  if (!rows[0]) throw new Error(`Wallet ${walletId} not found`);
  return rows[0];
}
