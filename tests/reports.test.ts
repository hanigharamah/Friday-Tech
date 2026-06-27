import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { dailyReconciliation, walletStatement, vehicleConsumption } from '../src/modules/reports.js';
import { authorize } from '../src/modules/authorization.js';
import { settle } from '../src/modules/settlement.js';
import { appTopup } from '../src/modules/topup.js';

const prisma = new PrismaClient();

async function createFixture() {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { name: 'Report User', email: `rpt-${uid}@t.com`, virtualIban: `SA-RPT-${uid}` },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceHalalas: 200_000n, heldHalalas: 0n },
  });
  const vehicle = await prisma.vehicle.create({
    data: { userId: user.id, plate: `RPT-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
  });
  const tag = await prisma.rfidTag.create({
    data: { tagUid: `RPT-T-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
  });
  const station = await prisma.station.create({
    data: { code: `RPT-S-${uid}`, name: 'Report Station' },
  });
  await prisma.fuelPrice.create({
    data: { grade: 'GASOLINE_95', pricePerLitreHalalas: 150n, effectiveFrom: new Date(Date.now() - 1000) },
  });
  return { user, wallet, vehicle, tag, station, uid };
}

// ── Daily reconciliation ─────────────────────────────────────────────────────

describe('Daily reconciliation report', () => {
  it('returns zero counts when no activity today', async () => {
    const report = await dailyReconciliation();

    expect(report.topups.count).toBe(0);
    expect(report.topups.total_sar).toBe('0.00');
    expect(report.fills.count).toBe(0);
    expect(report.fills.total_sar).toBe('0.00');
  });

  it('counts topups by source correctly', async () => {
    const { wallet } = await createFixture();

    await appTopup({ walletId: wallet.id, amountHalalas: 10_000n, method: 'APPLE_PAY', idempotencyKey: `k1-${wallet.id}` });
    await appTopup({ walletId: wallet.id, amountHalalas: 5_000n, method: 'CARD', idempotencyKey: `k2-${wallet.id}` });

    const report = await dailyReconciliation();

    expect(report.topups.count).toBeGreaterThanOrEqual(2);
    expect(report.topups.by_source.app.count).toBeGreaterThanOrEqual(2);
  });

  it('counts fills by grade', async () => {
    const { tag, station } = await createFixture();

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 20_000 });

    const report = await dailyReconciliation();

    expect(report.fills.count).toBeGreaterThanOrEqual(1);
    expect(report.fills.by_grade['GASOLINE_95']).toBeDefined();
    expect(parseFloat(report.fills.by_grade['GASOLINE_95'].total_litres)).toBeGreaterThanOrEqual(20);
  });

  it('tracks authorization status breakdown', async () => {
    const { tag, station } = await createFixture();

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 10_000 });

    const report = await dailyReconciliation();

    expect(report.authorizations.settled).toBeGreaterThanOrEqual(1);
  });
});

// ── Wallet statement ──────────────────────────────────────────────────────────

describe('Wallet statement', () => {
  it('shows enriched CAPTURE entry with grade, litres, station name', async () => {
    const { wallet, tag, station } = await createFixture();

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 30_000 });

    const stmt = await walletStatement(wallet.id);

    const capture = stmt.entries.find((e) => e.type === 'CAPTURE');
    expect(capture).toBeDefined();
    expect(capture!.description).toContain('Gasoline 95');
    expect(capture!.description).toContain('30.000 L');
    expect(capture!.description).toContain('Report Station');
    expect(capture!.amount_sar).toBe('-45.00'); // 30 L × 150 h = 4500 h = 45 SAR
  });

  it('shows enriched TOPUP_CREDIT entry with payment method', async () => {
    const { wallet } = await createFixture();

    await appTopup({ walletId: wallet.id, amountHalalas: 20_000n, method: 'APPLE_PAY', idempotencyKey: `stmt-k-${wallet.id}` });

    const stmt = await walletStatement(wallet.id);

    const topup = stmt.entries.find((e) => e.type === 'TOPUP_CREDIT');
    expect(topup).toBeDefined();
    expect(topup!.description).toContain('Apple Pay');
    expect(topup!.amount_sar).toBe('200.00');
  });

  it('only returns TOPUP_CREDIT, CAPTURE, REVERSAL — no HOLD or RELEASE clutter', async () => {
    const { wallet, tag, station } = await createFixture();

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 10_000 });

    const stmt = await walletStatement(wallet.id);

    const types = stmt.entries.map((e) => e.type);
    expect(types).not.toContain('HOLD');
    expect(types).not.toContain('RELEASE');
  });

  it('returns 404 for unknown wallet', async () => {
    await expect(walletStatement('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/i);
  });
});

// ── Vehicle consumption ───────────────────────────────────────────────────────

describe('Vehicle consumption report', () => {
  it('returns fill history with litres and SAR amounts', async () => {
    const { vehicle, tag, station } = await createFixture();

    const auth1 = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await settle({ authorizationId: auth1.authorization_id, millilitresDispensed: 40_000 });

    const auth2 = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await settle({ authorizationId: auth2.authorization_id, millilitresDispensed: 20_000 });

    const report = await vehicleConsumption(vehicle.id);

    expect(report.plate).toBe(vehicle.plate);
    expect(report.grade).toBe('GASOLINE_95');
    expect(report.fills.length).toBe(2);
    expect(report.summary.total_fills).toBe(2);
    expect(report.summary.total_litres).toBe('60.000');
    expect(report.summary.total_sar).toBe('90.00'); // 60 L × 150 h = 9000 h = 90 SAR
  });

  it('shows station name in each fill', async () => {
    const { vehicle, tag, station } = await createFixture();

    const auth = await authorize({ tagUid: tag.tagUid, stationCode: station.code, grade: 'GASOLINE_95' });
    await settle({ authorizationId: auth.authorization_id, millilitresDispensed: 10_000 });

    const report = await vehicleConsumption(vehicle.id);

    expect(report.fills[0].station).toBe('Report Station');
  });

  it('returns empty fills with zero summary when no history', async () => {
    const { vehicle } = await createFixture();

    const report = await vehicleConsumption(vehicle.id);

    expect(report.fills).toHaveLength(0);
    expect(report.summary.total_fills).toBe(0);
    expect(report.summary.total_litres).toBe('0.000');
    expect(report.summary.total_sar).toBe('0.00');
  });

  it('returns 404 for unknown vehicle', async () => {
    await expect(vehicleConsumption('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/i);
  });
});
