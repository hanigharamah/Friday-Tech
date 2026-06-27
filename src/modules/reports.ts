import { prisma } from '../lib/db.js';
import { displayTime } from '../lib/format.js';

function sarStr(halalas: bigint): string {
  const sign = halalas < 0n ? '-' : '';
  const abs = halalas < 0n ? -halalas : halalas;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${cents}`;
}

function parseRange(from?: string, to?: string): { from: Date | undefined; to: Date | undefined } {
  return {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  };
}

function dayBounds(dateStr?: string): { from: Date; to: Date } {
  const d = dateStr ? new Date(dateStr + 'T00:00:00.000Z') : new Date();
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const to = new Date(from.getTime() + 86_400_000 - 1);
  return { from, to };
}

// ── Daily reconciliation report ───────────────────────────────────────────────

export async function dailyReconciliation(dateStr?: string) {
  const { from, to } = dayBounds(dateStr);
  const label = dateStr ?? from.toISOString().slice(0, 10);

  const [topupEntries, transactions, authGroups, outstanding] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { type: 'TOPUP_CREDIT', createdAt: { gte: from, lte: to } },
    }),
    prisma.transaction.findMany({
      where: { createdAt: { gte: from, lte: to } },
      include: { authorization: { select: { grade: true } } },
    }),
    prisma.authorization.groupBy({
      by: ['status'],
      where: { createdAt: { gte: from, lte: to } },
      _count: true,
    }),
    prisma.authorization.aggregate({
      where: { status: 'AUTHORIZED', expiresAt: { gt: new Date() } },
      _count: true,
      _sum: { reservedHalalas: true },
    }),
  ]);

  const topupBySource = { app: { count: 0, total: 0n }, bank: { count: 0, total: 0n }, gateway: { count: 0, total: 0n } };
  for (const e of topupEntries) {
    if (e.reference.startsWith('bank:')) {
      topupBySource.bank.count++;
      topupBySource.bank.total += e.amountHalalas;
    } else if (e.reference.startsWith('gateway:')) {
      topupBySource.gateway.count++;
      topupBySource.gateway.total += e.amountHalalas;
    } else {
      topupBySource.app.count++;
      topupBySource.app.total += e.amountHalalas;
    }
  }

  const byGrade: Record<string, { count: number; total_halalas: bigint; total_ml: number }> = {};
  for (const tx of transactions) {
    const g = tx.authorization.grade;
    if (!byGrade[g]) byGrade[g] = { count: 0, total_halalas: 0n, total_ml: 0 };
    byGrade[g].count++;
    byGrade[g].total_halalas += tx.capturedHalalas;
    byGrade[g].total_ml += tx.millilitresDispensed;
  }

  const authStatusMap = Object.fromEntries(authGroups.map((r) => [r.status.toLowerCase(), r._count]));
  const totalTopup = topupEntries.reduce((s, e) => s + e.amountHalalas, 0n);
  const totalCaptured = transactions.reduce((s, t) => s + t.capturedHalalas, 0n);
  const totalMl = transactions.reduce((s, t) => s + t.millilitresDispensed, 0);

  return {
    date: label,
    period: { from: from.toISOString(), to: to.toISOString() },
    topups: {
      count: topupEntries.length,
      total_sar: sarStr(totalTopup),
      by_source: {
        app: { count: topupBySource.app.count, total_sar: sarStr(topupBySource.app.total) },
        bank_transfer: { count: topupBySource.bank.count, total_sar: sarStr(topupBySource.bank.total) },
        gateway: { count: topupBySource.gateway.count, total_sar: sarStr(topupBySource.gateway.total) },
      },
    },
    fills: {
      count: transactions.length,
      total_litres: (totalMl / 1000).toFixed(3),
      total_sar: sarStr(totalCaptured),
      by_grade: Object.fromEntries(
        Object.entries(byGrade).map(([grade, d]) => [
          grade,
          { count: d.count, total_litres: (d.total_ml / 1000).toFixed(3), total_sar: sarStr(d.total_halalas) },
        ])
      ),
    },
    authorizations: {
      authorized: authStatusMap['authorized'] ?? 0,
      settled: authStatusMap['settled'] ?? 0,
      expired: authStatusMap['expired'] ?? 0,
      reversed: authStatusMap['reversed'] ?? 0,
    },
    outstanding_holds: {
      count: outstanding._count,
      total_sar: sarStr(outstanding._sum.reservedHalalas ?? 0n),
    },
  };
}

// ── Wallet statement ──────────────────────────────────────────────────────────

export async function walletStatement(walletId: string, from?: string, to?: string) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });

  const range = parseRange(from, to);
  const dateFilter: Record<string, Date> = {};
  if (range.from) dateFilter.gte = range.from;
  if (range.to) dateFilter.lte = range.to;

  const entries = await prisma.ledgerEntry.findMany({
    where: {
      walletId,
      ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
      type: { in: ['TOPUP_CREDIT', 'CAPTURE', 'REVERSAL'] },
    },
    include: {
      authorization: {
        include: { station: true, transaction: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    wallet_id: walletId,
    generated_at: new Date().toISOString(),
    current_balance_sar: sarStr(wallet.balanceHalalas),
    available_sar: sarStr(wallet.balanceHalalas - wallet.heldHalalas),
    entries: entries.map((e) => {
      let description = '';
      if (e.type === 'TOPUP_CREDIT') {
        if (e.reference.startsWith('bank:')) description = 'Bank transfer — wallet top-up';
        else if (e.reference.startsWith('gateway:')) {
          const method = e.reference.split(':')[2] === 'APPLE_PAY' ? 'Apple Pay' : 'Card';
          description = `Top-up via ${method}`;
        } else {
          const method = e.reference.split(':')[2] === 'APPLE_PAY' ? 'Apple Pay' : 'Card';
          description = `Top-up via ${method}`;
        }
      } else if (e.type === 'CAPTURE' && e.authorization) {
        const auth = e.authorization;
        const litres = auth.transaction
          ? (auth.transaction.millilitresDispensed / 1000).toFixed(3)
          : '?.???';
        const grade = auth.grade === 'DIESEL' ? 'Diesel' : `Gasoline ${auth.grade.split('_')[1]}`;
        const station = auth.station?.name ?? auth.station?.code ?? 'Unknown station';
        description = `Fuel fill — ${grade} · ${litres} L · ${station}`;
      } else if (e.type === 'REVERSAL') {
        description = 'Authorization cancelled — funds returned';
      }

      return {
        id: e.id,
        type: e.type,
        description,
        amount_sar: sarStr(e.amountHalalas),
        amount_halalas: e.amountHalalas.toString(),
        display_time: displayTime(e.createdAt),
        created_at: e.createdAt.toISOString(),
      };
    }),
  };
}

// ── Vehicle consumption report ────────────────────────────────────────────────

export async function vehicleConsumption(vehicleId: string, from?: string, to?: string) {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    include: { user: { select: { name: true } } },
  });
  if (!vehicle) throw Object.assign(new Error('Vehicle not found'), { statusCode: 404 });

  const range = parseRange(from, to);
  const dateFilter: Record<string, Date> = {};
  if (range.from) dateFilter.gte = range.from;
  if (range.to) dateFilter.lte = range.to;

  const txs = await prisma.transaction.findMany({
    where: {
      authorization: { vehicleId },
      ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
    },
    include: { authorization: { include: { station: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const totalMl = txs.reduce((s, t) => s + t.millilitresDispensed, 0);
  const totalHalalas = txs.reduce((s, t) => s + t.capturedHalalas, 0n);

  return {
    vehicle_id: vehicleId,
    plate: vehicle.plate,
    grade: vehicle.allowedGrade,
    owner: vehicle.user.name,
    generated_at: new Date().toISOString(),
    fills: txs.map((tx) => ({
      date: tx.createdAt.toISOString(),
      display_time: displayTime(tx.createdAt),
      station: tx.authorization.station?.name ?? tx.authorization.station?.code ?? 'Unknown',
      litres: (tx.millilitresDispensed / 1000).toFixed(3),
      amount_sar: sarStr(tx.capturedHalalas),
    })),
    summary: {
      total_fills: txs.length,
      total_litres: (totalMl / 1000).toFixed(3),
      total_sar: sarStr(totalHalalas),
    },
  };
}
