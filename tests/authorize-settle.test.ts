import { describe, it, expect } from 'vitest';
import { PrismaClient, FuelGrade } from '@prisma/client';
import { authorize } from '../src/modules/authorization.js';
import { settle } from '../src/modules/settlement.js';

const prisma = new PrismaClient();

interface FixtureOpts {
  balanceHalalas?: bigint;
  pricePerLitreHalalas?: bigint;
  grade?: FuelGrade;
}

async function createFixture(opts: FixtureOpts = {}) {
  const balance = opts.balanceHalalas ?? 50_000n;
  const price = opts.pricePerLitreHalalas ?? 150n;
  const grade = opts.grade ?? 'GASOLINE_95';
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);

  const user = await prisma.user.create({
    data: { name: 'Test', email: `${uid}@t.com`, virtualIban: `SA${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: balance, heldHalalas: 0n },
  });
  const vehicle = await prisma.vehicle.create({
    data: { userId: user.id, plate: `PLT-${uid}`, allowedGrade: grade, status: 'ACTIVE' },
  });
  const tag = await prisma.rfidTag.create({
    data: { tagUid: `TAG-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
  });
  const station = await prisma.station.create({
    data: { code: `STN-${uid}`, name: 'Test Station' },
  });
  await prisma.fuelPrice.create({
    data: { grade, pricePerLitreHalalas: price, effectiveFrom: new Date(Date.now() - 1000) },
  });
  return { user, wallet, vehicle, tag, station, uid };
}

// ─── Happy path ────────────────────────────────────────────────────────────────

describe('Happy path: authorize → full settle', () => {
  it('balances and ledger reconcile after full settle', async () => {
    // 150 h/L, 15 000 h balance ≈ 100 L max
    const { wallet, tag, station } = await createFixture({ balanceHalalas: 15_000n, pricePerLitreHalalas: 150n });

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    expect(auth.authorization_id).toBeDefined();

    // Held must be positive after authorize
    const w1 = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w1.heldHalalas).toBeGreaterThan(0n);

    // HOLD ledger entry is negative (funds moved to hold)
    const holdEntry = await prisma.ledgerEntry.findFirstOrThrow({
      where: { walletId: wallet.id, type: 'HOLD' },
    });
    expect(holdEntry.amountHalalas).toBeLessThan(0n);

    // Settle exactly 10 L
    const receipt = await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 10_000 });
    expect(receipt.captured_halalas).toBe('1500'); // 10 L × 150 h

    // Held back to 0; balance decremented by captured amount
    const w2 = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w2.heldHalalas).toBe(0n);
    expect(w2.balanceHalalas).toBe(15_000n - 1_500n);

    // Ledger invariant: HOLD(-reserved) + RELEASE(+released) must net to CAPTURE(-captured)
    // i.e. the hold/release pair accounts for exactly the amount that was spent.
    const entries = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } });
    const holdAndRelease = entries
      .filter(e => e.type === 'HOLD' || e.type === 'RELEASE')
      .reduce((acc, e) => acc + e.amountHalalas, 0n);
    const captureSum = entries
      .filter(e => e.type === 'CAPTURE')
      .reduce((acc, e) => acc + e.amountHalalas, 0n);
    expect(holdAndRelease).toBe(captureSum); // both equal -1500
  });
});

// ─── Partial settle ────────────────────────────────────────────────────────────

describe('Partial settle releases the difference', () => {
  it('releases (reserved - captured) back to available', async () => {
    const { wallet, tag, station } = await createFixture({ balanceHalalas: 30_000n, pricePerLitreHalalas: 150n });

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    const authRow = await prisma.authorization.findUniqueOrThrow({ where: { id: auth.authorization_id } });
    const reserved = authRow.reservedHalalas;

    // Settle only 5 L
    const receipt = await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 5_000 });

    const captured = 750n; // 5 L × 150 h
    const released = reserved - captured;

    expect(BigInt(receipt.captured_halalas)).toBe(captured);
    expect(BigInt(receipt.released_halalas)).toBe(released);

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.heldHalalas).toBe(0n);
    expect(w.balanceHalalas).toBe(30_000n - captured);
  });
});

// ─── Expiry ────────────────────────────────────────────────────────────────────

describe('Expiry', () => {
  it('rejects settle on an expired authorization', async () => {
    const { tag, station } = await createFixture({ balanceHalalas: 15_000n });

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    await prisma.authorization.update({
      where: { id: auth.authorization_id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(
      settle({ authorizationId: auth.authorization_id, millilitresDispensed: 1_000 })
    ).rejects.toThrow(/expired/i);
  });
});

// ─── State machine ─────────────────────────────────────────────────────────────

describe('Authorization state machine', () => {
  it('cannot settle an already-settled authorization', async () => {
    const { tag, station } = await createFixture({ balanceHalalas: 15_000n });

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 5_000 });

    await expect(
      settle({ authorizationId: auth.authorization_id, millilitresDispensed: 5_000 })
    ).rejects.toThrow(/settled/i);
  });
});

// ─── Insufficient balance ──────────────────────────────────────────────────────

describe('Insufficient balance', () => {
  it('rejects when available balance cannot cover MIN_FILL_ML', async () => {
    // 1 halala at 150 h/L → 0.006 ml → below MIN_FILL_ML (1000 ml)
    const { tag, station } = await createFixture({ balanceHalalas: 1n });

    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/balance is too low|insufficient/i);
  });
});

// ─── Misfuel guard ─────────────────────────────────────────────────────────────

describe('Misfuel prevention', () => {
  it('rejects authorize when grade does not match vehicle allowed_grade', async () => {
    // Vehicle is GASOLINE_95 but we request DIESEL
    const uid = Date.now().toString(36);
    const user = await prisma.user.create({
      data: { name: 'Misfuel', email: `misfuel-${uid}@t.com`, virtualIban: `SA-MF-${uid}` },
    });
    await prisma.wallet.create({ data: { userId: user.id, balanceHalalas: 50_000n, heldHalalas: 0n } });
    const vehicle = await prisma.vehicle.create({
      data: { userId: user.id, plate: `MF-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
    });
    const tag = await prisma.rfidTag.create({
      data: { tagUid: `MF-TAG-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
    });
    const station = await prisma.station.create({ data: { code: `MF-STN-${uid}`, name: 'Misfuel Station' } });
    await prisma.fuelPrice.create({
      data: { grade: 'DIESEL', pricePerLitreHalalas: 65n, effectiveFrom: new Date(Date.now() - 1000) },
    });

    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'DIESEL' })
    ).rejects.toThrow(/misfuel/i);
  });
});

// ─── Overspend guard ───────────────────────────────────────────────────────────

describe('Overspend guard', () => {
  it('settle rejects when millilitres_dispensed > max_millilitres', async () => {
    const { tag, station, wallet } = await createFixture({ balanceHalalas: 15_000n, pricePerLitreHalalas: 150n });

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    await expect(
      settle({ authorizationId: auth.authorization_id, millilitresDispensed: auth.max_millilitres + 1 })
    ).rejects.toThrow(/exceed/i);
  });
});
