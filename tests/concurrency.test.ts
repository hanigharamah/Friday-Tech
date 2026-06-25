import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authorize } from '../src/modules/authorization.js';

const prisma = new PrismaClient();

describe('Concurrent authorizations — no overspend', () => {
  it('N parallel authorizations on one wallet never exceed available balance', async () => {
    const N = 10;
    const uid = Date.now().toString(36);

    const user = await prisma.user.create({
      data: { name: 'Conc', email: `conc-${uid}@t.com`, virtualIban: `SA-CONC-${uid}` },
    });

    // Wallet holds 1 000 halalas — enough for ~6.67 L at 150 h/L
    const wallet = await prisma.wallet.create({
      data: { userId: user.id, balanceHalalas: 1_000n, heldHalalas: 0n },
    });

    // Create N vehicles each with their own RFID tag
    const tags = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const vehicle = await prisma.vehicle.create({
          data: {
            userId: user.id,
            plate: `CONC-${i}-${uid}`,
            allowedGrade: 'GASOLINE_95',
            status: 'ACTIVE',
          },
        });
        return prisma.rfidTag.create({
          data: { tagUid: `CONC-T-${i}-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
        });
      })
    );

    const station = await prisma.station.create({
      data: { code: `CONC-STN-${uid}`, name: 'Concurrency Station' },
    });
    await prisma.fuelPrice.create({
      data: { grade: 'GASOLINE_95', pricePerLitreHalalas: 150n, effectiveFrom: new Date(Date.now() - 1000) },
    });

    // Fire all N authorizations concurrently
    const results = await Promise.allSettled(
      tags.map((tag) =>
        authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' })
      )
    );

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    // At least one should succeed (there IS balance)
    expect(successes.length).toBeGreaterThan(0);

    // The invariant: heldHalalas ≤ balanceHalalas at all times
    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(w.heldHalalas).toBeLessThanOrEqual(w.balanceHalalas);
    expect(w.heldHalalas).toBeGreaterThanOrEqual(0n);

    // Each authorization's reservedHalalas must also be ≤ available at time of creation.
    // Cross-check by summing all HOLD ledger entries (negative sign).
    const holdEntries = await prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id, type: 'HOLD' },
    });
    const totalHeld = holdEntries.reduce((acc, e) => acc - e.amountHalalas, 0n); // entries are negative
    expect(totalHeld).toBe(w.heldHalalas);

    console.log(`Concurrency: ${successes.length}/${N} succeeded, ${failures.length} rejected`);
  });
});
