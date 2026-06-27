/**
 * Stolen car scenarios.
 *
 * A stolen car still has its RFID tag attached. The thief can drive to a
 * petrol station and trigger a fill against the owner's wallet. These tests
 * cover every theft flow and verify the system's defences at each stage.
 */
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authorize } from '../src/modules/authorization.js';
import { settle } from '../src/modules/settlement.js';
import { reverseAuthorization } from '../src/modules/reversal.js';

const prisma = new PrismaClient();

async function createFixture() {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { name: 'Owner', email: `owner-${uid}@t.com`, virtualIban: `SA-OWN-${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: 50_000n, heldHalalas: 0n },
  });
  const vehicle = await prisma.vehicle.create({
    data: { userId: user.id, plate: `OWN-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
  });
  const tag = await prisma.rfidTag.create({
    data: { tagUid: `OWN-T-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
  });
  const station = await prisma.station.create({
    data: { code: `OWN-S-${uid}`, name: 'Test Station' },
  });
  await prisma.fuelPrice.create({
    data: { grade: 'GASOLINE_95', pricePerLitreHalalas: 150n, effectiveFrom: new Date(Date.now() - 1000) },
  });
  return { user, wallet, vehicle, tag, station, uid };
}

// ─── Scenario 1: Thief fuels before owner notices ──────────────────────────────

describe('Scenario 1: Thief fuels before owner notices', () => {
  it('authorization succeeds — system has no way to know the car is stolen yet', async () => {
    const { tag, station } = await createFixture();

    // From the system's perspective this is a normal fill
    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    expect(auth.authorization_id).toBeDefined();

    const receipt = await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 30_000 });
    expect(receipt.captured_halalas).toBe('4500'); // 30 L × 150 h
  });
});

// ─── Scenario 2: Owner reports stolen — blocks before thief reaches pump ───────

describe('Scenario 2: Owner suspends tag before thief reaches pump', () => {
  it('new authorize is rejected after tag is suspended', async () => {
    const { tag, station } = await createFixture();

    // Owner reports car stolen → suspends the tag
    await prisma.rfidTag.update({ where: { id: tag.id }, data: { status: 'SUSPENDED' } });

    // Thief arrives at pump — rejected
    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/suspended/i);
  });

  it('LOST status also blocks the tag', async () => {
    const { tag, station } = await createFixture();

    await prisma.rfidTag.update({ where: { id: tag.id }, data: { status: 'LOST' } });

    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/lost/i);
  });
});

// ─── Scenario 3: Owner suspends tag while thief is mid-fill (Option A) ─────────

describe('Scenario 3: Tag suspended while fill is in progress (Option A)', () => {
  it('current settle completes; new authorize is blocked', async () => {
    const { wallet, tag, station } = await createFixture();

    // Thief authorized before owner noticed
    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    // Owner reports stolen — tag suspended
    await prisma.rfidTag.update({ where: { id: tag.id }, data: { status: 'SUSPENDED' } });

    // Settle still works (Option A: current fill completes)
    const receipt = await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 20_000 });
    expect(receipt.captured_halalas).toBe('3000');

    // Thief tries another fill — blocked
    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/suspended/i);

    // Damage is capped: only the first fill went through
    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.balanceHalalas).toBe(50_000n - 3_000n);
  });
});

// ─── Scenario 4: Owner triggers emergency reversal ─────────────────────────────

describe('Scenario 4: Emergency authorization reversal', () => {
  it('reverses an in-progress hold — funds released, wallet restored', async () => {
    const { wallet, tag, station } = await createFixture();

    // Thief authorized at pump
    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    const wAfterAuth = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    const heldAmount = wAfterAuth.heldHalalas;
    expect(heldAmount).toBeGreaterThan(0n);

    // Owner calls emergency reversal + suspends tag simultaneously
    await prisma.rfidTag.update({ where: { id: tag.id }, data: { status: 'SUSPENDED' } });
    const reversal = await reverseAuthorization(auth.authorization_id);

    expect(reversal.status).toBe('REVERSED');
    expect(BigInt(reversal.released_halalas)).toBe(heldAmount);

    // Wallet fully restored — no funds lost
    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.heldHalalas).toBe(0n);
    expect(w.balanceHalalas).toBe(50_000n);

    // REVERSAL ledger entry confirms the release
    const entry = await prisma.ledgerEntry.findFirst({
      where: { walletId: wallet.id, type: 'REVERSAL' },
    });
    expect(entry).not.toBeNull();
    expect(entry!.amountHalalas).toBe(heldAmount); // positive — returned
  });

  it('cannot reverse an already-settled authorization', async () => {
    const { tag, station } = await createFixture();

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 10_000 });

    // Too late — fuel already flowed
    await expect(reverseAuthorization(auth.authorization_id)).rejects.toThrow(/settled/i);
  });

  it('cannot reverse an already-reversed authorization', async () => {
    const { tag, station } = await createFixture();

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await reverseAuthorization(auth.authorization_id);

    await expect(reverseAuthorization(auth.authorization_id)).rejects.toThrow(/reversed/i);
  });
});

// ─── Scenario 5: Cloned tag — only one active fill per tag ────────────────────

describe('Scenario 5: Cloned tag — one active authorization per vehicle', () => {
  it('rejects a second concurrent authorization for the same vehicle', async () => {
    const { tag, station } = await createFixture();

    // Real car (or clone 1) authorizes at pump A
    const auth1 = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    expect(auth1.authorization_id).toBeDefined();

    // Clone (same tag UID resolves to same vehicle) tries pump B simultaneously
    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/fill is already in progress|active authorization/i);
  });

  it('allows a new fill after the first is settled', async () => {
    const { tag, station } = await createFixture();

    const auth1 = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await settle({ authorizationId: auth1.authorization_id, millilitresDispensed: 10_000 });

    // Now the vehicle is free — second fill allowed
    const auth2 = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    expect(auth2.authorization_id).toBeDefined();
    expect(auth2.authorization_id).not.toBe(auth1.authorization_id);
  });

  it('allows a new fill after the first is reversed', async () => {
    const { tag, station } = await createFixture();

    const auth1 = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await reverseAuthorization(auth1.authorization_id);

    const auth2 = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    expect(auth2.authorization_id).toBeDefined();
  });

  it('allows a new fill after the first has expired', async () => {
    const { tag, station } = await createFixture();

    const auth1 = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    // Force expiry
    await prisma.authorization.update({
      where: { id: auth1.authorization_id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    // Expired auth is no longer "active" — new fill allowed
    const auth2 = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    expect(auth2.authorization_id).toBeDefined();
  });
});

// ─── Scenario 6: Rapid drain before owner reacts ──────────────────────────────

describe('Scenario 6: Rapid drain — velocity rule limits damage window', () => {
  it('thief is blocked after MAX_AUTH_PER_HOUR consecutive fills', async () => {
    const { vehicle, tag, station } = await createFixture();

    const stationRow = await prisma.station.findFirstOrThrow({ where: { code: station.code } });
    const walletRow = await prisma.wallet.findFirstOrThrow({ where: { userId: vehicle.userId } });

    // Seed 5 already-settled fills in the last hour (velocity limit = 5)
    for (let i = 0; i < 5; i++) {
      await prisma.authorization.create({
        data: {
          walletId: walletRow.id,
          vehicleId: vehicle.id,
          stationId: stationRow.id,
          grade: 'GASOLINE_95',
          pricePerLitreHalalas: 150n,
          maxMillilitres: 1_000,
          reservedHalalas: 150n,
          status: 'SETTLED',
          expiresAt: new Date(Date.now() + 300_000),
          createdAt: new Date(Date.now() - 10_000),
        },
      });
    }

    // 6th attempt — blocked by velocity rule
    await expect(
      authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
    ).rejects.toThrow(/fill limit|velocity/i);
  });
});
