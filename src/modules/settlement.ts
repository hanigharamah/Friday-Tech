import { prisma, lockWallet } from '../lib/db.js';
import { roundHalfUp } from '../lib/money.js';
import { fuelGradeDisplay, displayTime, sarDisplay } from '../lib/format.js';

function buildFillReference(date: Date, txId: string): string {
  const dateStr = date.toISOString().slice(0, 10);
  const suffix = txId.replace(/-/g, '').slice(-4).toUpperCase();
  return `FILL-${dateStr}-${suffix}`;
}

export async function settle(params: {
  authorizationId: string;
  millilitresDispensed: number;
}) {
  const { authorizationId, millilitresDispensed } = params;

  const auth = await prisma.authorization.findUnique({
    where: { id: authorizationId },
    include: { station: true },
  });

  if (!auth) throw Object.assign(new Error('Authorization not found'), { statusCode: 404 });
  if (auth.status !== 'AUTHORIZED') {
    throw Object.assign(
      new Error(`Cannot settle: this authorization is already ${auth.status.toLowerCase()}.`),
      { statusCode: 422 }
    );
  }
  if (new Date() > auth.expiresAt) {
    throw Object.assign(new Error('This authorization has expired. Please tap the tag again to start a new fill.'), { statusCode: 422 });
  }
  if (millilitresDispensed > auth.maxMillilitres) {
    throw Object.assign(
      new Error(`Dispensed volume (${(millilitresDispensed / 1000).toFixed(3)} L) exceeds the authorized maximum (${(auth.maxMillilitres / 1000).toFixed(3)} L).`),
      { statusCode: 422 }
    );
  }

  return await prisma.$transaction(async (tx) => {
    const locked = await lockWallet(tx, auth.walletId);

    const captured = roundHalfUp(auth.pricePerLitreHalalas, BigInt(millilitresDispensed));
    const released = auth.reservedHalalas - captured;

    await tx.wallet.update({
      where: { id: auth.walletId },
      data: {
        balanceHalalas: { decrement: captured },
        heldHalalas: { decrement: auth.reservedHalalas },
      },
    });

    await tx.authorization.update({
      where: { id: auth.id },
      data: { status: 'SETTLED' },
    });

    const txRecord = await tx.transaction.create({
      data: {
        authorizationId: auth.id,
        millilitresDispensed,
        capturedHalalas: captured,
      },
    });

    await tx.ledgerEntry.createMany({
      data: [
        {
          walletId: auth.walletId,
          type: 'CAPTURE',
          amountHalalas: -captured,
          authorizationId: auth.id,
          reference: `settle:${txRecord.id}`,
        },
        {
          walletId: auth.walletId,
          type: 'RELEASE',
          amountHalalas: released,
          authorizationId: auth.id,
          reference: `release:${txRecord.id}`,
        },
      ],
    });

    // Read updated wallet for new balance
    const updatedWallet = await tx.wallet.findUnique({
      where: { id: auth.walletId },
      select: { balanceHalalas: true, heldHalalas: true },
    });
    const newBalance = updatedWallet!.balanceHalalas;

    // Spend insights: fills and spend this month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [monthFills, monthSpend] = await Promise.all([
      tx.transaction.count({
        where: {
          authorization: { walletId: auth.walletId },
          createdAt: { gte: monthStart },
        },
      }),
      tx.transaction.aggregate({
        where: {
          authorization: { walletId: auth.walletId },
          createdAt: { gte: monthStart },
        },
        _sum: { capturedHalalas: true },
      }),
    ]);

    const fuelType = fuelGradeDisplay(auth.grade);
    const fillRef = buildFillReference(txRecord.createdAt, txRecord.id);
    const stationName = auth.station?.name ?? 'Unknown station';
    const litresStr = (millilitresDispensed / 1000).toFixed(3);
    const pricePerLitreSar = sarDisplay(auth.pricePerLitreHalalas);
    const capturedSar = sarDisplay(captured);
    const releasedSar = sarDisplay(released);
    const newBalanceSar = sarDisplay(newBalance);
    const monthSpendSar = sarDisplay(monthSpend._sum.capturedHalalas ?? 0n);

    return {
      transaction_id: txRecord.id,
      authorization_id: auth.id,
      fill_reference: fillRef,
      display_time: displayTime(txRecord.createdAt),
      created_at: txRecord.createdAt.toISOString(),
      receipt: {
        headline: `SAR ${capturedSar} charged`,
        subheadline: `${litresStr} L of ${fuelType.display} at ${stationName}`,
        station_name: stationName,
        fuel_type: fuelType,
        quantity_litres: litresStr,
        unit_price_sar: pricePerLitreSar,
        amount_charged_sar: capturedSar,
        amount_released_sar: releasedSar,
        new_balance_sar: newBalanceSar,
        fill_reference: fillRef,
        display_time: displayTime(txRecord.createdAt),
      },
      insights: {
        fills_this_month: monthFills,
        spent_this_month_sar: monthSpendSar,
      },
      millilitres_dispensed: millilitresDispensed,
      litres_dispensed: litresStr,
      captured_halalas: captured.toString(),
      released_halalas: released.toString(),
      grade: auth.grade,
    };
  });
}
