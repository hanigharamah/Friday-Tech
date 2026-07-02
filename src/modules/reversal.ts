import { prisma, lockWallet } from '../lib/db.js';
import { displayTime, sarDisplay } from '../lib/format.js';

export async function reverseAuthorization(authorizationId: string) {
  const auth = await prisma.authorization.findUnique({
    where: { id: authorizationId },
  });

  if (!auth) throw Object.assign(new Error('Authorization not found'), { statusCode: 404 });
  if (auth.status !== 'AUTHORIZED') {
    throw Object.assign(
      new Error(`This authorization is already ${auth.status.toLowerCase()} and cannot be reversed.`),
      { statusCode: 422 }
    );
  }

  return await prisma.$transaction(async (tx) => {
    await lockWallet(tx, auth.walletId);

    const current = await tx.authorization.findUnique({
      where: { id: auth.id },
      select: { status: true },
    });
    if (current?.status !== 'AUTHORIZED') {
      throw Object.assign(
        new Error(`This authorization is now ${current?.status?.toLowerCase()} and cannot be reversed.`),
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
        amountHalalas: auth.reservedHalalas,
        authorizationId: auth.id,
        reference: `reverse:${auth.id}`,
      },
    });

    const updatedWallet = await tx.wallet.findUnique({
      where: { id: auth.walletId },
      select: { balanceHalalas: true, heldHalalas: true },
    });
    const walletBalance = updatedWallet!.balanceHalalas;
    const now = new Date();

    return {
      authorization_id: auth.id,
      status: 'REVERSED',
      amount_released_sar: sarDisplay(auth.reservedHalalas),
      released_halalas: auth.reservedHalalas.toString(),
      wallet_balance_sar: sarDisplay(walletBalance),
      assurance: 'No further fills can be made with this tag until it is re-activated.',
      display_time: displayTime(now),
      reversed_at: now.toISOString(),
    };
  });
}
