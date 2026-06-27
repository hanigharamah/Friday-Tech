import { prisma } from '../lib/db.js';

/**
 * Returns settled millilitres for a vehicle within a rolling window.
 * Uses Transaction.createdAt (settle time), not authorization time.
 */
async function settledVolumeInWindow(vehicleId: string, since: Date): Promise<number> {
  const result = await prisma.transaction.aggregate({
    where: {
      authorization: { vehicleId },
      createdAt: { gte: since },
    },
    _sum: { millilitresDispensed: true },
  });
  return result._sum.millilitresDispensed ?? 0;
}

/**
 * Computes the remaining millilitres the vehicle is allowed, given its
 * daily and weekly limits. Returns null when no limits are configured.
 * Caller should cap max_millilitres against this value before authorizing.
 */
export async function remainingVolumeAllowance(
  vehicleId: string,
  dailyLimitMl: number | null,
  weeklyLimitMl: number | null
): Promise<number | null> {
  let remaining: number | null = null;

  if (dailyLimitMl !== null) {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const used = await settledVolumeInWindow(vehicleId, since);
    const left = Math.max(0, dailyLimitMl - used);
    remaining = remaining === null ? left : Math.min(remaining, left);
  }

  if (weeklyLimitMl !== null) {
    const since = new Date(Date.now() - 7 * 24 * 3_600_000);
    const used = await settledVolumeInWindow(vehicleId, since);
    const left = Math.max(0, weeklyLimitMl - used);
    remaining = remaining === null ? left : Math.min(remaining, left);
  }

  return remaining;
}

/**
 * Enforces a velocity limit: rejects if the vehicle has >= maxPerHour
 * authorizations (any status) in the last 60 minutes.
 */
export async function checkVelocity(vehicleId: string, maxPerHour: number): Promise<void> {
  const since = new Date(Date.now() - 3_600_000);
  const oldest = await prisma.authorization.findFirst({
    where: { vehicleId, createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  const count = await prisma.authorization.count({
    where: { vehicleId, createdAt: { gte: since } },
  });
  if (count >= maxPerHour) {
    const retryAt = oldest
      ? new Date(oldest.createdAt.getTime() + 3_600_000)
      : new Date(Date.now() + 3_600_000);
    const retryTime = retryAt.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    throw Object.assign(
      new Error(`You've reached the fill limit for this hour. You can fill up again after ${retryTime}.`),
      { statusCode: 429, retry_after: retryAt.toISOString() }
    );
  }
}
