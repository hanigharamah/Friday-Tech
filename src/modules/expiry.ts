import { prisma, lockWallet } from '../lib/db.js';

/**
 * Finds all AUTHORIZED authorizations past their expiresAt, transitions
 * them to EXPIRED, decrements wallet.held_halalas, and writes a REVERSAL
 * ledger entry to release the hold.
 *
 * Safe to run concurrently or repeatedly — the FOR UPDATE lock prevents
 * double-processing, and the status check inside the transaction ensures
 * only AUTHORIZED rows are touched.
 */
export async function expireStaleAuthorizations(): Promise<{ expired: number }> {
  const stale = await prisma.authorization.findMany({
    where: { status: 'AUTHORIZED', expiresAt: { lt: new Date() } },
    select: { id: true, walletId: true, reservedHalalas: true },
  });

  let expired = 0;

  for (const auth of stale) {
    try {
      await prisma.$transaction(async (tx) => {
        await lockWallet(tx, auth.walletId);

        // Re-check status inside the transaction in case another worker raced us
        const current = await tx.authorization.findUnique({
          where: { id: auth.id },
          select: { status: true },
        });
        if (current?.status !== 'AUTHORIZED') return;

        await tx.authorization.update({
          where: { id: auth.id },
          data: { status: 'EXPIRED' },
        });

        await tx.wallet.update({
          where: { id: auth.walletId },
          data: { heldHalalas: { decrement: auth.reservedHalalas } },
        });

        await tx.ledgerEntry.create({
          data: {
            walletId: auth.walletId,
            type: 'REVERSAL',
            amountHalalas: auth.reservedHalalas,
            authorizationId: auth.id,
            reference: `expire:${auth.id}`,
          },
        });
      });
      expired++;
    } catch (err) {
      console.error(`Failed to expire authorization ${auth.id}:`, err);
    }
  }

  return { expired };
}
