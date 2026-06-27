import { describe, it, expect } from 'vitest';
import { createUser } from '../src/modules/user.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('User creation', () => {
  it('creates user and wallet in one transaction', async () => {
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const result = await createUser({ name: 'Test Owner', email: `owner-${uid}@demo.com` });

    expect(result.user.id).toBeDefined();
    expect(result.user.name).toBe('Test Owner');
    expect(result.user.email).toBe(`owner-${uid}@demo.com`);
    expect(result.user.virtual_iban).toBeDefined();
    expect(result.user.created_at).toBeDefined();

    expect(result.wallet.id).toBeDefined();
    expect(result.wallet.balance_halalas).toBe('0');
    expect(result.wallet.available_halalas).toBe('0');
    expect(result.wallet.currency).toBe('SAR');

    // Wallet is actually in the DB
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: result.wallet.id } });
    expect(wallet.userId).toBe(result.user.id);
  });

  it('auto-generates a valid virtual IBAN when omitted', async () => {
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const result = await createUser({ name: 'IBAN Test', email: `iban-${uid}@demo.com` });

    expect(result.user.virtual_iban).toMatch(/^SA/);
    expect(result.user.virtual_iban.length).toBe(24);
  });

  it('uses provided virtual_iban when supplied', async () => {
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const customIban = `SA0012345678901234567${uid.slice(0, 2)}`;
    const result = await createUser({
      name: 'Custom IBAN',
      email: `custom-${uid}@demo.com`,
      virtualIban: customIban,
    });

    expect(result.user.virtual_iban).toBe(customIban);
  });

  it('rejects duplicate email with 409', async () => {
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const email = `dup-${uid}@demo.com`;

    await createUser({ name: 'First', email });

    await expect(createUser({ name: 'Second', email })).rejects.toThrow(/already registered/i);
  });

  it('two users get separate wallets', async () => {
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const a = await createUser({ name: 'User A', email: `usera-${uid}@demo.com` });
    const b = await createUser({ name: 'User B', email: `userb-${uid}@demo.com` });

    expect(a.wallet.id).not.toBe(b.wallet.id);
    expect(a.user.id).not.toBe(b.user.id);
  });
});
