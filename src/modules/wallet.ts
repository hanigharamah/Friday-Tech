import { prisma } from '../lib/db.js';

export async function getWalletById(walletId: string) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
  });
  if (!wallet) throw new Error(`Wallet ${walletId} not found`);

  const available = wallet.balanceHalalas - wallet.heldHalalas;
  return {
    id: wallet.id,
    balance_halalas: wallet.balanceHalalas.toString(),
    held_halalas: wallet.heldHalalas.toString(),
    available_halalas: available.toString(),
    currency: wallet.currency,
  };
}

export async function getWalletTransactions(walletId: string) {
  const entries = await prisma.ledgerEntry.findMany({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    include: { authorization: true },
  });

  return entries.map((e) => ({
    id: e.id,
    type: e.type,
    amount_halalas: e.amountHalalas.toString(),
    reference: e.reference,
    authorization_id: e.authorizationId,
    created_at: e.createdAt,
  }));
}
