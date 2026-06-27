import { prisma } from '../lib/db.js';

function generateVirtualIban(): string {
  // SA (2) + check digits (2) + account number (20) = 24 chars
  const ts = Date.now().toString().slice(-13); // 13 digits
  const rnd = Math.floor(Math.random() * 1e7).toString().padStart(7, '0'); // 7 digits
  return `SA00${ts}${rnd}`; // 4 + 13 + 7 = 24
}

export async function createUser(params: {
  name: string;
  email: string;
  virtualIban?: string;
}) {
  const { name, email } = params;
  const virtualIban = params.virtualIban ?? generateVirtualIban();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw Object.assign(new Error('Email already registered'), { statusCode: 409 });

  return await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { name, email, virtualIban } });
    const wallet = await tx.wallet.create({
      data: { userId: user.id, balanceHalalas: 0n, heldHalalas: 0n },
    });
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        virtual_iban: user.virtualIban,
        created_at: user.createdAt.toISOString(),
      },
      wallet: {
        id: wallet.id,
        balance_halalas: '0',
        available_halalas: '0',
        currency: wallet.currency,
      },
    };
  });
}
