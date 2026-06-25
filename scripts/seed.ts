import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { signPayload } from '../src/lib/hmac.js';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // User
  const user = await prisma.user.create({
    data: {
      name: 'Ahmed Al-Harbi',
      email: 'ahmed@example.com',
      virtualIban: 'SA0380000000608010167519',
    },
  });

  // Wallet with 500 SAR (50,000 halalas)
  const wallet = await prisma.wallet.create({
    data: {
      userId: user.id,
      balanceHalalas: 50000n,
      heldHalalas: 0n,
    },
  });

  // Initial topup ledger entry
  await prisma.ledgerEntry.create({
    data: {
      walletId: wallet.id,
      type: 'TOPUP_CREDIT',
      amountHalalas: 50000n,
      reference: 'seed:initial',
    },
  });

  // Vehicle 1 — GASOLINE_95
  const vehicle95 = await prisma.vehicle.create({
    data: {
      userId: user.id,
      plate: 'ABC-1234',
      allowedGrade: 'GASOLINE_95',
      status: 'ACTIVE',
    },
  });

  // RFID tag for vehicle 1
  await prisma.rfidTag.create({
    data: {
      tagUid: 'WAIE-04F3A19C',
      vehicleId: vehicle95.id,
      status: 'ACTIVE',
    },
  });

  // Vehicle 2 — DIESEL
  const vehicleDiesel = await prisma.vehicle.create({
    data: {
      userId: user.id,
      plate: 'XYZ-5678',
      allowedGrade: 'DIESEL',
      status: 'ACTIVE',
    },
  });

  // RFID tag for vehicle 2
  await prisma.rfidTag.create({
    data: {
      tagUid: 'WAIE-0D1C2B3A',
      vehicleId: vehicleDiesel.id,
      status: 'ACTIVE',
    },
  });

  // Station
  await prisma.station.create({
    data: {
      code: 'RUH-014',
      name: 'Aldrees Riyadh North',
    },
  });

  // Fuel prices (in halalas per litre)
  // 91: 1.25 SAR/L = 125 halalas/L
  // 95: 1.50 SAR/L = 150 halalas/L
  // Diesel: 0.65 SAR/L = 65 halalas/L
  const now = new Date();
  await prisma.fuelPrice.createMany({
    data: [
      { grade: 'GASOLINE_91', pricePerLitreHalalas: 125n, effectiveFrom: now },
      { grade: 'GASOLINE_95', pricePerLitreHalalas: 150n, effectiveFrom: now },
      { grade: 'DIESEL', pricePerLitreHalalas: 65n, effectiveFrom: now },
    ],
  });

  console.log('Seed complete!');
  console.log('User:', user.id);
  console.log('Wallet:', wallet.id);
  console.log('Vehicle 95:', vehicle95.id);
  console.log('Vehicle Diesel:', vehicleDiesel.id);

  // Show example authorize payload
  console.log('\nExample authorize payload:');
  console.log(JSON.stringify({ tag_uid: 'WAIE-04F3A19C', station_code: 'RUH-014', grade: 'GASOLINE_95' }, null, 2));

  // Show example bank webhook signature
  const body = JSON.stringify({ bank_reference: 'BNK-REF-001', virtual_iban: 'SA0380000000608010167519', amount_halalas: 10000 });
  const sig = signPayload(process.env.BANK_WEBHOOK_SECRET ?? 'test_secret', body);
  console.log('\nExample bank webhook body:', body);
  console.log('Signature:', sig);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
