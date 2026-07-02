import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { pumpScan, pumpDispense, pumpAbort, getSession } from '../src/simulators/pump.js';

const prisma = new PrismaClient();

async function createFixture() {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { name: 'Pump User', email: `pump-${uid}@t.com`, virtualIban: `SA-PUMP-${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: 100_000n, heldHalalas: 0n },
  });
  const vehicle = await prisma.vehicle.create({
    data: { userId: user.id, plate: `PUMP-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
  });
  const tag = await prisma.rfidTag.create({
    data: { tagUid: `PUMP-T-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
  });
  const station = await prisma.station.create({
    data: { code: `PUMP-S-${uid}`, name: 'Sim Station' },
  });
  await prisma.fuelPrice.create({
    data: { grade: 'GASOLINE_95', pricePerLitreHalalas: 150n, effectiveFrom: new Date(Date.now() - 1000) },
  });
  return { user, wallet, vehicle, tag, station };
}

describe('Pump simulator — scan → dispense', () => {
  it('creates an authorized session and settles on dispense', async () => {
    const { tag, station } = await createFixture();

    const session = await pumpScan({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    expect(session.status).toBe('AUTHORIZED');
    expect(session.authorizationId).toBeDefined();
    expect(session.maxMillilitres).toBeGreaterThan(0);

    const dispensed = await pumpDispense(session.id, 20_000);
    expect(dispensed.status).toBe('DISPENSED');
    expect(dispensed.settleResult).not.toBeNull();
    expect((dispensed.settleResult as Record<string, unknown>).captured_halalas).toBe('3000');
  });

  it('target_millilitres caps the authorized max', async () => {
    const { tag, station } = await createFixture();

    const session = await pumpScan({
      tagUid: tag.tagUid,
      stationCode: station.code,
      grade: 'GASOLINE_95',
      targetMillilitres: 10_000,
    });

    expect(session.maxMillilitres).toBe(10_000);

    const dispensed = await pumpDispense(session.id); // dispenses full max
    expect((dispensed.settleResult as Record<string, unknown>).captured_halalas).toBe('1500'); // 10 L × 150 h
  });

  it('dispense without explicit ml uses session max', async () => {
    const { tag, station } = await createFixture();

    const session = await pumpScan({
      tagUid: tag.tagUid,
      stationCode: station.code,
      grade: 'GASOLINE_95',
      targetMillilitres: 5_000,
    });

    const dispensed = await pumpDispense(session.id);
    expect((dispensed.settleResult as Record<string, unknown>).millilitres_dispensed).toBe(5_000);
  });
});

describe('Pump simulator — scan → abort', () => {
  it('abort reverses the hold and restores balance', async () => {
    const { tag, station, wallet } = await createFixture();

    const session = await pumpScan({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    const aborted = await pumpAbort(session.id);
    expect(aborted.status).toBe('ABORTED');
    expect(aborted.reversalResult).not.toBeNull();

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.heldHalalas).toBe(0n);
    expect(w.balanceHalalas).toBe(100_000n);
  });

  it('cannot dispense after abort', async () => {
    const { tag, station } = await createFixture();

    const session = await pumpScan({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await pumpAbort(session.id);

    await expect(pumpDispense(session.id, 10_000)).rejects.toThrow(/ABORTED/);
  });

  it('cannot abort twice', async () => {
    const { tag, station } = await createFixture();

    const session = await pumpScan({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await pumpAbort(session.id);

    await expect(pumpAbort(session.id)).rejects.toThrow(/ABORTED/);
  });
});

describe('Pump simulator — getSession', () => {
  it('returns session by id', async () => {
    const { tag, station } = await createFixture();

    const session = await pumpScan({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    const fetched = getSession(session.id);
    expect(fetched.id).toBe(session.id);
    expect(fetched.status).toBe('AUTHORIZED');
  });

  it('throws 404 for unknown session id', () => {
    expect(() => getSession('nonexistent-session')).toThrow(/not found/i);
  });

  it('status updates to DISPENSED after settle', async () => {
    const { tag, station } = await createFixture();

    const session = await pumpScan({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await pumpDispense(session.id, 10_000);

    const fetched = getSession(session.id);
    expect(fetched.status).toBe('DISPENSED');
  });
});
