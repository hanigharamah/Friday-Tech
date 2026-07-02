import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

beforeAll(async () => {
  // Create test DB if it doesn't exist, then run migrations
  const dbUrl = process.env.DATABASE_URL!;
  const match = dbUrl.match(/^(postgresql:\/\/[^/]+\/)(\w+)(\?.*)?$/);
  if (match) {
    const adminUrl = match[1] + 'postgres' + (match[3] ?? '');
    const dbName = match[2];
    try {
      execSync(`psql "${adminUrl}" -c "CREATE DATABASE ${dbName};"`, { stdio: 'pipe' });
    } catch {
      // DB already exists — fine
    }
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env },
    stdio: 'inherit',
  });
}, 60_000);

afterEach(async () => {
  // Truncate all tables in reverse FK order between tests
  await prisma.$executeRaw`
    TRUNCATE TABLE
      idempotency_keys,
      processed_bank_transfers,
      ledger_entries,
      transactions,
      authorizations,
      fuel_prices,
      rfid_tags,
      vehicles,
      stations,
      wallets,
      users
    RESTART IDENTITY CASCADE
  `;
});

afterAll(async () => {
  await prisma.$disconnect();
});
