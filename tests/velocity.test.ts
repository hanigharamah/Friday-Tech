import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authorize } from '../src/modules/authorization.js';

const prisma = new PrismaClient();

async function createFixture() {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { name: 'Velocity', email: `vel-${uid}@t.com`, virtualIban: `SA-VEL-${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: 500_000n, heldHalalas: 0n },
  });
  const vehicle = await prisma.vehicle.create({
    data: { userId: user.id, plate: `VEL-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
  });
  const tag = await prisma.rfidTag.create({
    data: { tagUid: `VEL-T-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
  });
  const station = await prisma.station.create({
    data: { code: `VEL-S-${uid}`, name: 'Velocity Station' },
  });
  await prisma.fuelPrice.create({
    data: { grade: 'GASOLINE_95', pricePerLitreHalalas: 150n, effectiveFrom: new Date(Date.now() - 1000) },
  });
  return { user, wallet, vehicle, tag, station, uid };
}

describe('Velocity rule', () => {
  it('rejects when vehicle exceeds MAX_AUTH_PER_HOUR authorizations in last hour', async () => {
    const { vehicle, tag, station } = await createFixture();

    // MAX_AUTH_PER_HOUR defaults to 5 in test env
    // Seed 5 authorizations in the last hour directly
    const stationRow = await prisma.station.findFirst({ where: { code: station.code } });
    const walletRow = await prisma.wallet.findFirst({ where: { userId: vehicle.userId } });

    for (let i = 0; i < 5; i++) {
      await prisma.authorization.create({
        data: {
          walletId: walletRow!.id,
          vehicleId: vehicle.id,
          stationId: stationRow!.id,
          grade: 'GASOLINE_95',
          pricePerLitreHalalas: 150n,
          maxMillilitres: 1_000,
          reservedHalalas: 150n,
          status: 'SETTLED',
          expiresAt: new Date(Date.now() + 300_000),
          createdAt: new Date(Date.now() - 10_000), // 10 seconds ago — within the hour
        },
      });
    }

    // 6th authorization should be rejected by velocity rule
    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/velocity/i);
  });

  it('allows authorization when previous ones are outside the 1-hour window', async () => {
    const { vehicle, tag, station } = await createFixture();

    const stationRow = await prisma.station.findFirst({ where: { code: station.code } });
    const walletRow = await prisma.wallet.findFirst({ where: { userId: vehicle.userId } });

    // Seed 5 authorizations from 2 hours ago (outside the window)
    for (let i = 0; i < 5; i++) {
      await prisma.authorization.create({
        data: {
          walletId: walletRow!.id,
          vehicleId: vehicle.id,
          stationId: stationRow!.id,
          grade: 'GASOLINE_95',
          pricePerLitreHalalas: 150n,
          maxMillilitres: 1_000,
          reservedHalalas: 150n,
          status: 'SETTLED',
          expiresAt: new Date(Date.now() + 300_000),
          createdAt: new Date(Date.now() - 7_200_000), // 2 hours ago
        },
      });
    }

    // Should succeed — old auths are outside the 1-hour window
    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    expect(auth.authorization_id).toBeDefined();
  });
});
