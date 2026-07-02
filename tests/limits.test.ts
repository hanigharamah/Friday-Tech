import { describe, it, expect } from 'vitest';
import { PrismaClient, FuelGrade } from '@prisma/client';
import { authorize } from '../src/modules/authorization.js';
import { settle } from '../src/modules/settlement.js';

const prisma = new PrismaClient();

interface FixtureOpts {
  grade?: FuelGrade;
  pricePerLitreHalalas?: bigint;
  balanceHalalas?: bigint;
  dailyLitreLimitMl?: number | null;
  weeklyLitreLimitMl?: number | null;
}

async function createFixture(opts: FixtureOpts = {}) {
  const grade = opts.grade ?? 'GASOLINE_95';
  const price = opts.pricePerLitreHalalas ?? 150n;
  const balance = opts.balanceHalalas ?? 500_000n; // 5000 SAR — big enough not to be the constraint
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);

  const user = await prisma.user.create({
    data: { name: 'Limits', email: `lim-${uid}@t.com`, virtualIban: `SA-LIM-${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: balance, heldHalalas: 0n },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      userId: user.id,
      plate: `LIM-${uid}`,
      allowedGrade: grade,
      status: 'ACTIVE',
      dailyLitreLimitMl: opts.dailyLitreLimitMl ?? null,
      weeklyLitreLimitMl: opts.weeklyLitreLimitMl ?? null,
    },
  });
  const tag = await prisma.rfidTag.create({
    data: { tagUid: `LIM-T-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
  });
  const station = await prisma.station.create({
    data: { code: `LIM-S-${uid}`, name: 'Limits Station' },
  });
  await prisma.fuelPrice.create({
    data: { grade, pricePerLitreHalalas: price, effectiveFrom: new Date(Date.now() - 1000) },
  });
  return { user, wallet, vehicle, tag, station, uid };
}

// Authorize and settle helper
async function doFill(tagUid: string, stationCode: string, grade: FuelGrade, ml: number) {
  const auth = await authorize({ tagUid, stationCode, grade });
  const actual = Math.min(ml, auth.max_millilitres);
  return settle({ authorizationId: auth.authorization_id, millilitresDispensed: actual });
}

// ─── Daily limit ───────────────────────────────────────────────────────────────

describe('Daily volume limit', () => {
  it('caps max_millilitres when approaching the daily limit', async () => {
    // 60 L daily limit; vehicle already used 50 L → only 10 L left
    const { vehicle, tag, station } = await createFixture({ dailyLitreLimitMl: 60_000 });

    // Seed a past transaction consuming 50 L
    const pastAuth = await prisma.authorization.create({
      data: {
        walletId: (await prisma.wallet.findFirst({ where: { userId: vehicle.userId } }))!.id,
        vehicleId: vehicle.id,
        stationId: (await prisma.station.findFirst({ where: { code: station.code } }))!.id,
        grade: 'GASOLINE_95',
        pricePerLitreHalalas: 150n,
        maxMillilitres: 50_000,
        reservedHalalas: 7_500n,
        status: 'SETTLED',
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    await prisma.transaction.create({
      data: {
        authorizationId: pastAuth.id,
        millilitresDispensed: 50_000,
        capturedHalalas: 7_500n,
        createdAt: new Date(), // within 24-hour window
      },
    });

    // New authorize should be capped at 10 000 ml (10 L remaining)
    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    expect(auth.max_millilitres).toBeLessThanOrEqual(10_000);
  });

  it('rejects when daily limit is fully consumed', async () => {
    const { vehicle, tag, station } = await createFixture({ dailyLitreLimitMl: 10_000 });

    // Seed a past transaction consuming all 10 L
    const pastAuth = await prisma.authorization.create({
      data: {
        walletId: (await prisma.wallet.findFirst({ where: { userId: vehicle.userId } }))!.id,
        vehicleId: vehicle.id,
        stationId: (await prisma.station.findFirst({ where: { code: station.code } }))!.id,
        grade: 'GASOLINE_95',
        pricePerLitreHalalas: 150n,
        maxMillilitres: 10_000,
        reservedHalalas: 1_500n,
        status: 'SETTLED',
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    await prisma.transaction.create({
      data: {
        authorizationId: pastAuth.id,
        millilitresDispensed: 10_000,
        capturedHalalas: 1_500n,
        createdAt: new Date(),
      },
    });

    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/limit/i);
  });
});

// ─── Weekly limit ──────────────────────────────────────────────────────────────

describe('Weekly volume limit', () => {
  it('caps max_millilitres against the weekly limit', async () => {
    const { vehicle, tag, station } = await createFixture({ weeklyLitreLimitMl: 200_000 });

    // Seed 180 L used this week
    const pastAuth = await prisma.authorization.create({
      data: {
        walletId: (await prisma.wallet.findFirst({ where: { userId: vehicle.userId } }))!.id,
        vehicleId: vehicle.id,
        stationId: (await prisma.station.findFirst({ where: { code: station.code } }))!.id,
        grade: 'GASOLINE_95',
        pricePerLitreHalalas: 150n,
        maxMillilitres: 180_000,
        reservedHalalas: 27_000n,
        status: 'SETTLED',
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    await prisma.transaction.create({
      data: {
        authorizationId: pastAuth.id,
        millilitresDispensed: 180_000,
        capturedHalalas: 27_000n,
        createdAt: new Date(),
      },
    });

    // Only 20 L left in weekly budget
    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    expect(auth.max_millilitres).toBeLessThanOrEqual(20_000);
  });
});

// ─── MAX_SINGLE_FILL_ML ────────────────────────────────────────────────────────

describe('MAX_SINGLE_FILL_ML cap', () => {
  it('caps max_millilitres at 120 L even with huge balance', async () => {
    const { tag, station } = await createFixture({ balanceHalalas: 100_000_000n }); // 1M SAR

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    expect(auth.max_millilitres).toBeLessThanOrEqual(120_000);
  });
});

// ─── Misfuel ───────────────────────────────────────────────────────────────────

describe('Misfuel prevention', () => {
  it('rejects DIESEL grade for a GASOLINE_95 vehicle', async () => {
    const uid = Date.now().toString(36);
    const user = await prisma.user.create({
      data: { name: 'MF', email: `mf2-${uid}@t.com`, virtualIban: `SA-MF2-${uid}` },
    });
    await prisma.wallet.create({ data: { userId: user.id, balanceHalalas: 50_000n, heldHalalas: 0n } });
    const vehicle = await prisma.vehicle.create({
      data: { userId: user.id, plate: `MF2-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
    });
    const tag = await prisma.rfidTag.create({
      data: { tagUid: `MF2-T-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
    });
    const station = await prisma.station.create({ data: { code: `MF2-S-${uid}`, name: 'MF2' } });
    await prisma.fuelPrice.create({
      data: { grade: 'DIESEL', pricePerLitreHalalas: 65n, effectiveFrom: new Date(Date.now() - 1000) },
    });

    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'DIESEL' })
    ).rejects.toThrow(/misfuel/i);
  });
});

// ─── Tag status ────────────────────────────────────────────────────────────────

describe('Tag status checks', () => {
  it('rejects SUSPENDED tag', async () => {
    const { tag, station } = await createFixture();
    await prisma.rfidTag.update({ where: { id: tag.id }, data: { status: 'SUSPENDED' } });

    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/suspended/i);
  });

  it('rejects LOST tag', async () => {
    const { tag, station } = await createFixture();
    await prisma.rfidTag.update({ where: { id: tag.id }, data: { status: 'LOST' } });

    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/lost/i);
  });
});

// ─── Vehicle status ────────────────────────────────────────────────────────────

describe('Vehicle status checks', () => {
  it('rejects SUSPENDED vehicle', async () => {
    const { vehicle, tag, station } = await createFixture();
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status: 'SUSPENDED' } });

    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/suspended/i);
  });
});
