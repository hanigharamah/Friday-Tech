import { prisma } from '../lib/db.js';
import { FuelGrade } from '@prisma/client';

export async function getCurrentPrice(grade: FuelGrade): Promise<{
  id: string;
  pricePerLitreHalalas: bigint;
}> {
  const price = await prisma.fuelPrice.findFirst({
    where: {
      grade,
      effectiveFrom: { lte: new Date() },
    },
    orderBy: { effectiveFrom: 'desc' },
  });

  if (!price) throw new Error(`No price found for grade ${grade}`);
  return price;
}
