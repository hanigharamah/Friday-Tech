import { prisma } from '../lib/db.js';
import { displayTime, sarDisplay } from '../lib/format.js';

export async function getWalletById(walletId: string) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
  });
  if (!wallet) throw Object.assign(new Error(`Wallet ${walletId} not found`), { statusCode: 404 });

  const available = wallet.balanceHalalas - wallet.heldHalalas;
  return {
    id: wallet.id,
    balance_halalas: wallet.balanceHalalas.toString(),
    balance_sar: sarDisplay(wallet.balanceHalalas),
    held_halalas: wallet.heldHalalas.toString(),
    available_halalas: available.toString(),
    available_sar: sarDisplay(available),
    currency: wallet.currency,
  };
}

export async function getWalletTransactions(walletId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw Object.assign(new Error(`Wallet ${walletId} not found`), { statusCode: 404 });

  const entries = await prisma.ledgerEntry.findMany({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    include: { authorization: true },
  });

  if (entries.length === 0) {
    return {
      wallet_id: walletId,
      entries: [],
      empty_state: {
        title: 'No fills yet',
        message: 'Tap your RFID tag at any Aldrees pump to make your first fill.',
        action: 'Top up your wallet to get started',
      },
    };
  }

  return {
    wallet_id: walletId,
    entries: entries.map((e) => ({
      id: e.id,
      type: e.type,
      amount_halalas: e.amountHalalas.toString(),
      amount_sar: sarDisplay(e.amountHalalas),
      reference: e.reference,
      authorization_id: e.authorizationId,
      display_time: displayTime(e.createdAt),
      created_at: e.createdAt.toISOString(),
    })),
  };
}
