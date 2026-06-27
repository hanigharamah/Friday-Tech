import { prisma, lockWallet } from '../lib/db.js';
import { getCurrentPrice } from './pricing.js';
import { roundHalfUp } from '../lib/money.js';
import { remainingVolumeAllowance, checkVelocity } from './limits.js';
import { fuelGradeDisplay, gradeColorHint, displayTime, sarDisplay } from '../lib/format.js';
import { FuelGrade } from '@prisma/client';

const MAX_SINGLE_FILL_ML = parseInt(process.env.MAX_SINGLE_FILL_ML ?? '120000', 10);
const MIN_FILL_ML = parseInt(process.env.MIN_FILL_ML ?? '1000', 10);
const AUTH_TTL_SECONDS = parseInt(process.env.AUTH_TTL_SECONDS ?? '300', 10);
const MAX_AUTH_PER_HOUR = parseInt(process.env.MAX_AUTH_PER_HOUR ?? '5', 10);

export async function authorize(params: {
  tagUid: string;
  stationCode: string;
  grade: FuelGrade;
}) {
  const { tagUid, stationCode, grade } = params;

  const tag = await prisma.rfidTag.findUnique({
    where: { tagUid },
    include: { vehicle: { include: { user: { include: { wallets: true } } } } },
  });

  if (!tag) {
    throw Object.assign(new Error('RFID tag not recognized. Please check the tag and try again.'), { statusCode: 404 });
  }
  if (tag.status !== 'ACTIVE') {
    const reason = tag.status === 'SUSPENDED'
      ? 'This tag has been suspended. Contact support to re-activate it.'
      : 'This tag has been reported lost. Contact support if this is an error.';
    throw Object.assign(new Error(reason), { statusCode: 422 });
  }

  const vehicle = tag.vehicle;
  if (vehicle.status !== 'ACTIVE') {
    throw Object.assign(
      new Error('This vehicle has been suspended. Contact support to resolve this.'),
      { statusCode: 422 }
    );
  }
  if (vehicle.allowedGrade !== grade) {
    const vehicleFuel = fuelGradeDisplay(vehicle.allowedGrade).display;
    const pumpFuel = fuelGradeDisplay(grade).display;
    throw Object.assign(
      new Error(`Misfuel prevented. This vehicle is configured for ${vehicleFuel}, but the pump is set to ${pumpFuel}. Please select the correct pump.`),
      { statusCode: 422 }
    );
  }

  await checkVelocity(vehicle.id, MAX_AUTH_PER_HOUR);

  const station = await prisma.station.findUnique({ where: { code: stationCode } });
  if (!station) {
    throw Object.assign(new Error('Station not found. Please try a different pump.'), { statusCode: 404 });
  }

  const wallet = vehicle.user.wallets[0];
  if (!wallet) {
    throw Object.assign(new Error('No wallet found for this account. Please contact support.'), { statusCode: 422 });
  }

  const price = await getCurrentPrice(grade);

  const allowanceMl = await remainingVolumeAllowance(
    vehicle.id,
    vehicle.dailyLitreLimitMl,
    vehicle.weeklyLitreLimitMl
  );

  return await prisma.$transaction(async (tx) => {
    const locked = await lockWallet(tx, wallet.id);

    const existingAuth = await tx.authorization.findFirst({
      where: {
        vehicleId: vehicle.id,
        status: 'AUTHORIZED',
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (existingAuth) {
      throw Object.assign(
        new Error('A fill is already in progress for this vehicle. Please wait for it to complete.'),
        { statusCode: 409 }
      );
    }

    const available = locked.balance_halalas - locked.held_halalas;
    if (available <= 0n) {
      throw Object.assign(
        new Error('Your wallet balance is too low to start a fill. Please top up and try again.'),
        { statusCode: 422 }
      );
    }

    const rawMaxMl = (available * 1000n) / price.pricePerLitreHalalas;

    let maxMillilitres = rawMaxMl > BigInt(MAX_SINGLE_FILL_ML)
      ? MAX_SINGLE_FILL_ML
      : Number(rawMaxMl);

    if (allowanceMl !== null) {
      maxMillilitres = Math.min(maxMillilitres, allowanceMl);
    }

    if (maxMillilitres < MIN_FILL_ML) {
      const reason = allowanceMl !== null && allowanceMl < MIN_FILL_ML
        ? 'You have reached your daily or weekly volume limit. Your limit resets tomorrow.'
        : 'Your wallet balance is too low for a minimum fill. Please top up and try again.';
      throw Object.assign(new Error(reason), { statusCode: 422 });
    }

    const reservedHalalas = roundHalfUp(price.pricePerLitreHalalas, BigInt(maxMillilitres));

    const expiresAt = new Date(Date.now() + AUTH_TTL_SECONDS * 1000);

    const auth = await tx.authorization.create({
      data: {
        walletId: wallet.id,
        vehicleId: vehicle.id,
        stationId: station.id,
        grade,
        pricePerLitreHalalas: price.pricePerLitreHalalas,
        maxMillilitres,
        reservedHalalas,
        status: 'AUTHORIZED',
        expiresAt,
      },
    });

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { heldHalalas: { increment: reservedHalalas } },
    });

    await tx.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        type: 'HOLD',
        amountHalalas: -reservedHalalas,
        authorizationId: auth.id,
        reference: `auth:${auth.id}`,
      },
    });

    const fuelType = fuelGradeDisplay(grade);
    const colorHint = gradeColorHint(grade);
    const pricePerLitre = sarDisplay(price.pricePerLitreHalalas / 10n);

    return {
      authorization_id: auth.id,
      status: 'AUTHORIZED',
      status_display: 'Ready to fill',
      status_color: '#30D158',
      fuel_type: fuelType,
      color_hint: colorHint,
      station_name: station.name,
      max_litres: (maxMillilitres / 1000).toFixed(3),
      max_millilitres: maxMillilitres,
      price_per_litre_sar: pricePerLitre,
      price_per_litre_halalas: price.pricePerLitreHalalas.toString(),
      reserved_sar: sarDisplay(reservedHalalas),
      expires_at: expiresAt.toISOString(),
      display_time: displayTime(expiresAt),
    };
  });
}
