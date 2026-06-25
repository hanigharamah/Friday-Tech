import { prisma, lockWallet } from '../lib/db.js';
import { roundHalfUp } from '../lib/money.js';

export async function settle(params: {
  authorizationId: string;
  millilitresDispensed: number;
}) {
  const { authorizationId, millilitresDispensed } = params;

  const auth = await prisma.authorization.findUnique({
    where: { id: authorizationId },
  });

  if (!auth) throw Object.assign(new Error('Authorization not found'), { statusCode: 404 });
  if (auth.status !== 'AUTHORIZED') {
    throw Object.assign(
      new Error(`Cannot settle authorization in status ${auth.status}`),
      { statusCode: 422 }
    );
  }
  if (new Date() > auth.expiresAt) {
    throw Object.assign(new Error('Authorization has expired'), { statusCode: 422 });
  }
  if (millilitresDispensed > auth.maxMillilitres) {
    throw Object.assign(
      new Error(`Dispensed ${millilitresDispensed}ml exceeds authorized ${auth.maxMillilitres}ml`),
      { statusCode: 422 }
    );
  }

  return await prisma.$transaction(async (tx) => {
    const locked = await lockWallet(tx, auth.walletId);
    void locked; // used for the FOR UPDATE lock

    const captured = roundHalfUp(auth.pricePerLitreHalalas, BigInt(millilitresDispensed));
    const released = auth.reservedHalalas - captured;

    // Debit balance and release held funds
    await tx.wallet.update({
      where: { id: auth.walletId },
      data: {
        balanceHalalas: { decrement: captured },
        heldHalalas: { decrement: auth.reservedHalalas },
      },
    });

    await tx.authorization.update({
      where: { id: auth.id },
      data: { status: 'SETTLED' },
    });

    const txRecord = await tx.transaction.create({
      data: {
        authorizationId: auth.id,
        millilitresDispensed,
        capturedHalalas: captured,
      },
    });

    await tx.ledgerEntry.createMany({
      data: [
        {
          walletId: auth.walletId,
          type: 'CAPTURE',
          amountHalalas: -captured,
          authorizationId: auth.id,
          reference: `settle:${txRecord.id}`,
        },
        {
          walletId: auth.walletId,
          type: 'RELEASE',
          amountHalalas: released,
          authorizationId: auth.id,
          reference: `release:${txRecord.id}`,
        },
      ],
    });

    return {
      transaction_id: txRecord.id,
      authorization_id: auth.id,
      millilitres_dispensed: millilitresDispensed,
      litres_dispensed: (millilitresDispensed / 1000).toFixed(3),
      captured_halalas: captured.toString(),
      released_halalas: released.toString(),
      grade: auth.grade,
      created_at: txRecord.createdAt.toISOString(),
    };
  });
}
