import { prisma, lockWallet } from '../lib/db.js';
import { getCurrentPrice } from './pricing.js';
import { roundHalfUp } from '../lib/money.js';
import { remainingVolumeAllowance, checkVelocity } from './limits.js';
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

  if (!tag) throw Object.assign(new Error('RFID tag not found'), { statusCode: 404 });
  if (tag.status !== 'ACTIVE') {
    throw Object.assign(
      new Error(`RFID tag is ${tag.status.toLowerCase()} — authorization denied`),
      { statusCode: 422 }
    );
  }

  const vehicle = tag.vehicle;
  if (vehicle.status !== 'ACTIVE') {
    throw Object.assign(new Error('Vehicle is suspended — authorization denied'), { statusCode: 422 });
  }
  if (vehicle.allowedGrade !== grade) {
    throw Object.assign(
      new Error(`Misfuel: vehicle is configured for ${vehicle.allowedGrade}, pump requested ${grade}`),
      { statusCode: 422 }
    );
  }

  // Velocity check: reject if too many authorizations in the last hour
  await checkVelocity(vehicle.id, MAX_AUTH_PER_HOUR);

  const station = await prisma.station.findUnique({ where: { code: stationCode } });
  if (!station) throw Object.assign(new Error('Station not found'), { statusCode: 404 });

  const wallet = vehicle.user.wallets[0];
  if (!wallet) throw Object.assign(new Error('No wallet found for user'), { statusCode: 422 });

  const price = await getCurrentPrice(grade);

  // Volume limit check (outside the wallet lock — read-only, non-critical timing)
  const allowanceMl = await remainingVolumeAllowance(
    vehicle.id,
    vehicle.dailyLitreLimitMl,
    vehicle.weeklyLitreLimitMl
  );

  return await prisma.$transaction(async (tx) => {
    const locked = await lockWallet(tx, wallet.id);

    const available = locked.balance_halalas - locked.held_halalas;
    if (available <= 0n) {
      throw Object.assign(new Error('Insufficient balance'), { statusCode: 422 });
    }

    // floor(available * 1000 / price) = max ml the wallet can cover
    const rawMaxMl = (available * 1000n) / price.pricePerLitreHalalas;

    // Apply caps in order: wallet, single-fill max, volume allowance
    let maxMillilitres = rawMaxMl > BigInt(MAX_SINGLE_FILL_ML)
      ? MAX_SINGLE_FILL_ML
      : Number(rawMaxMl);

    if (allowanceMl !== null) {
      maxMillilitres = Math.min(maxMillilitres, allowanceMl);
    }

    if (maxMillilitres < MIN_FILL_ML) {
      const reason = allowanceMl !== null && allowanceMl < MIN_FILL_ML
        ? 'Daily or weekly volume limit reached'
        : 'Insufficient balance for minimum fill';
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

    return {
      authorization_id: auth.id,
      max_millilitres: maxMillilitres,
      max_litres: (maxMillilitres / 1000).toFixed(3),
      price_per_litre_halalas: price.pricePerLitreHalalas.toString(),
      expires_at: expiresAt,
    };
  });
}
