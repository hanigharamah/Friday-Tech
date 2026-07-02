import { prisma } from '../lib/db.js';
import { verifySignature } from '../lib/hmac.js';

export async function appTopup(params: {
  walletId: string;
  amountHalalas: bigint;
  method: string;
  idempotencyKey: string;
}) {
  const { walletId, amountHalalas, method, idempotencyKey } = params;

  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });

  return await prisma.$transaction(async (tx) => {
    await tx.wallet.update({
      where: { id: walletId },
      data: { balanceHalalas: { increment: amountHalalas } },
    });

    await tx.ledgerEntry.create({
      data: {
        walletId,
        type: 'TOPUP_CREDIT',
        amountHalalas,
        reference: `topup:${idempotencyKey}:${method}`,
      },
    });

    return {
      wallet_id: walletId,
      amount_halalas: amountHalalas.toString(),
      method,
      idempotency_key: idempotencyKey,
    };
  });
}

export async function bankWebhookTopup(params: {
  bankReference: string;
  virtualIban: string;
  amountHalalas: bigint;
}) {
  const { bankReference, virtualIban, amountHalalas } = params;

  const user = await prisma.user.findUnique({
    where: { virtualIban },
    include: { wallets: true },
  });
  if (!user) throw Object.assign(new Error('Virtual IBAN not found'), { statusCode: 404 });

  const wallet = user.wallets[0];
  if (!wallet) throw Object.assign(new Error('No wallet for this IBAN'), { statusCode: 422 });

  return await prisma.$transaction(async (tx) => {
    // Check for duplicate — dedupe on bank_reference
    const existing = await tx.processedBankTransfer.findUnique({
      where: { bankReference },
    });
    if (existing) return null; // already processed

    await tx.processedBankTransfer.create({
      data: { bankReference, walletId: wallet.id, amountHalalas },
    });

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceHalalas: { increment: amountHalalas } },
    });

    await tx.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        type: 'TOPUP_CREDIT',
        amountHalalas,
        reference: `bank:${bankReference}`,
      },
    });

    return {
      wallet_id: wallet.id,
      bank_reference: bankReference,
      amount_halalas: amountHalalas.toString(),
    };
  });
}

// Re-export for use in routes (not actually used in module but exported for completeness)
export { verifySignature };
