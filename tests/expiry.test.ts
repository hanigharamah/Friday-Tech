import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authorize } from '../src/modules/authorization.js';
import { expireStaleAuthorizations } from '../src/modules/expiry.js';

const prisma = new PrismaClient();

async function createFixture() {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { name: 'Expiry', email: `exp-${uid}@t.com`, virtualIban: `SA-EXP-${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: 50_000n, heldHalalas: 0n },
  });
  const vehicle = await prisma.vehicle.create({
    data: { userId: user.id, plate: `EXP-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
  });
  const tag = await prisma.rfidTag.create({
    data: { tagUid: `EXP-T-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
  });
  const station = await prisma.station.create({
    data: { code: `EXP-S-${uid}`, name: 'Expiry Station' },
  });
  await prisma.fuelPrice.create({
    data: { grade: 'GASOLINE_95', pricePerLitreHalalas: 150n, effectiveFrom: new Date(Date.now() - 1000) },
  });
  return { user, wallet, vehicle, tag, station, uid };
}

describe('Hold-expiry worker', () => {
  it('transitions AUTHORIZED → EXPIRED and releases held funds', async () => {
    const { wallet, tag, station } = await createFixture();

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    // Verify hold is in place
    const w1 = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w1.heldHalalas).toBeGreaterThan(0n);
    const heldBefore = w1.heldHalalas;

    // Force expiry
    await prisma.authorization.update({
      where: { id: auth.authorization_id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const result = await expireStaleAuthorizations();
    expect(result.expired).toBe(1);

    // Authorization is now EXPIRED
    const authRow = await prisma.authorization.findUniqueOrThrow({ where: { id: auth.authorization_id } });
    expect(authRow.status).toBe('EXPIRED');

    // Held is back to 0; balance unchanged
    const w2 = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w2.heldHalalas).toBe(0n);
    expect(w2.balanceHalalas).toBe(50_000n); // balance not debited on expiry

    // REVERSAL ledger entry exists with the released amount
    const reversal = await prisma.ledgerEntry.findFirst({
      where: { walletId: wallet.id, type: 'REVERSAL' },
    });
    expect(reversal).not.toBeNull();
    expect(reversal!.amountHalalas).toBe(heldBefore); // positive — funds returned
  });

  it('is idempotent — running twice does not double-release', async () => {
    const { wallet, tag, station } = await createFixture();

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    await prisma.authorization.update({
      where: { id: auth.authorization_id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    // Run twice
    const r1 = await expireStaleAuthorizations();
    const r2 = await expireStaleAuthorizations();

    expect(r1.expired).toBe(1);
    expect(r2.expired).toBe(0); // second run finds nothing in AUTHORIZED state

    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.heldHalalas).toBe(0n);

    // Only one REVERSAL entry
    const reversals = await prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id, type: 'REVERSAL' },
    });
    expect(reversals).toHaveLength(1);
  });

  it('skips non-expired authorizations', async () => {
    const { tag, station } = await createFixture();

    // Active authorization with future expiry
    await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });

    const result = await expireStaleAuthorizations();
    expect(result.expired).toBe(0);
  });
});
