import { prisma, lockWallet } from '../lib/db.js';

/**
 * Reverses an AUTHORIZED authorization — used when a vehicle is reported
 * stolen and the owner wants to cancel an in-progress hold immediately.
 *
 * Option A behaviour: an authorization that has already been SETTLED is
 * not reversed here (the fuel has already flowed). Only AUTHORIZED holds
 * can be reversed. The caller should also suspend the tag via PATCH /v1/tags/:id
 * to block future fills.
 */
export async function reverseAuthorization(authorizationId: string) {
  const auth = await prisma.authorization.findUnique({
    where: { id: authorizationId },
  });

  if (!auth) throw Object.assign(new Error('Authorization not found'), { statusCode: 404 });
  if (auth.status !== 'AUTHORIZED') {
    throw Object.assign(
      new Error(`Cannot reverse authorization in status ${auth.status} — only AUTHORIZED holds can be reversed`),
      { statusCode: 422 }
    );
  }

  return await prisma.$transaction(async (tx) => {
    await lockWallet(tx, auth.walletId);

    // Re-check status inside the transaction — another request may have settled
    // or expired this authorization between our initial read and the lock
    const current = await tx.authorization.findUnique({
      where: { id: auth.id },
      select: { status: true },
    });
    if (current?.status !== 'AUTHORIZED') {
      throw Object.assign(
        new Error(`Authorization is now ${current?.status} — cannot reverse`),
        { statusCode: 422 }
      );
    }

    await tx.authorization.update({
      where: { id: auth.id },
      data: { status: 'REVERSED' },
    });

    await tx.wallet.update({
      where: { id: auth.walletId },
      data: { heldHalalas: { decrement: auth.reservedHalalas } },
    });

    await tx.ledgerEntry.create({
      data: {
        walletId: auth.walletId,
        type: 'REVERSAL',
        amountHalalas: auth.reservedHalalas, // positive — funds returned to available
        authorizationId: auth.id,
        reference: `reverse:${auth.id}`,
      },
    });

    return {
      authorization_id: auth.id,
      status: 'REVERSED',
      released_halalas: auth.reservedHalalas.toString(),
    };
  });
}
