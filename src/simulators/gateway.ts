import { prisma } from '../lib/db.js';

type GatewayOutcome = 'success' | 'declined' | 'insufficient_funds' | 'timeout';

function newChargeId(): string {
  return `GW-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

export async function simulateCharge(params: {
  walletId: string;
  amountHalalas: number;
  method: 'APPLE_PAY' | 'CARD';
  outcome: GatewayOutcome;
}) {
  const { walletId, amountHalalas, method, outcome } = params;

  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });

  const chargeId = newChargeId();

  if (outcome !== 'success') {
    return {
      charge_id: chargeId,
      wallet_id: walletId,
      amount_halalas: amountHalalas,
      method,
      outcome,
      status: 'FAILED',
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.wallet.update({
      where: { id: walletId },
      data: { balanceHalalas: { increment: BigInt(amountHalalas) } },
    });
    await tx.ledgerEntry.create({
      data: {
        walletId,
        type: 'TOPUP_CREDIT',
        amountHalalas: BigInt(amountHalalas),
        reference: `gateway:${chargeId}:${method}`,
      },
    });
  });

  return {
    charge_id: chargeId,
    wallet_id: walletId,
    amount_halalas: amountHalalas,
    method,
    outcome: 'success',
    status: 'CAPTURED',
  };
}
