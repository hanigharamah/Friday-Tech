import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authorize } from '../src/modules/authorization.js';
import { settle } from '../src/modules/settlement.js';
import { appTopup } from '../src/modules/topup.js';
import { checkIdempotency, storeIdempotency, hashRequest } from '../src/lib/idempotency.js';

const prisma = new PrismaClient();

async function createFixture() {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { name: 'Idem', email: `idem-${uid}@t.com`, virtualIban: `SA-IDEM-${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: 50_000n, heldHalalas: 0n },
  });
  const vehicle = await prisma.vehicle.create({
    data: { userId: user.id, plate: `IDEM-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
  });
  const tag = await prisma.rfidTag.create({
    data: { tagUid: `IDEM-T-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
  });
  const station = await prisma.station.create({ data: { code: `IDEM-S-${uid}`, name: 'Idem Station' } });
  await prisma.fuelPrice.create({
    data: { grade: 'GASOLINE_95', pricePerLitreHalalas: 150n, effectiveFrom: new Date(Date.now() - 1000) },
  });
  return { user, wallet, tag, station, uid };
}

// ─── Settle idempotency ────────────────────────────────────────────────────────

describe('Idempotent settle', () => {
  it('replay returns the stored receipt with no second debit', async () => {
    const { wallet, tag, station, uid } = await createFixture();

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    const body = { authorization_id: auth.authorization_id, millilitres_dispensed: 5_000 };
    const key = `settle-${uid}`;

    // First real call
    const result1 = await settle({ authorizationId: body.authorization_id, millilitresDispensed: body.millilitres_dispensed });
    await storeIdempotency(key, 'settle', hashRequest(body), result1);

    // Replay — must hit cache
    const cached = await checkIdempotency(key, 'settle', hashRequest(body));
    expect(cached.hit).toBe(true);
    if (cached.hit) {
      expect(cached.response).toEqual(result1);
    }

    // Only one CAPTURE entry must exist
    const captures = await prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id, type: 'CAPTURE' },
    });
    expect(captures).toHaveLength(1);

    // Wallet debited exactly once
    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(50_000n - 750n); // 5 L × 150 h
  });
});

// ─── App topup idempotency ─────────────────────────────────────────────────────

describe('Idempotent app topup', () => {
  it('replay does not double-credit the wallet', async () => {
    const { wallet, uid } = await createFixture();
    const key = `topup-${uid}`;
    const body = { wallet_id: wallet.id, amount_halalas: 10_000, method: 'CARD' };

    const result1 = await appTopup({ walletId: wallet.id, amountHalalas: 10_000n, method: 'CARD', idempotencyKey: key });
    await storeIdempotency(key, 'app-topup', hashRequest(body), result1);

    // Replay
    const cached = await checkIdempotency(key, 'app-topup', hashRequest(body));
    expect(cached.hit).toBe(true);

    // Simulate what the route would do: return cached response, skip second topup
    if (!cached.hit) {
      await appTopup({ walletId: wallet.id, amountHalalas: 10_000n, method: 'CARD', idempotencyKey: key });
    }

    const credits = await prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id, type: 'TOPUP_CREDIT' },
    });
    expect(credits).toHaveLength(1);

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(50_000n + 10_000n);
  });
});
