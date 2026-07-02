import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

const prisma = new PrismaClient();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function createUser() {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { name: 'VM User', email: `vm-${uid}@t.com`, virtualIban: `SA-VM-${uid}` },
  });
  await prisma.wallet.create({ data: { userId: user.id, balanceHalalas: 50_000n, heldHalalas: 0n } });
  return user;
}

// ─── Create vehicle ────────────────────────────────────────────────────────────

describe('POST /v1/vehicles', () => {
  it('creates a vehicle with an attached tag', async () => {
    const user = await createUser();
    const uid = Date.now().toString(36);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      body: {
        user_id: user.id,
        plate: `NEW-${uid}`,
        allowed_grade: 'GASOLINE_95',
        tag_uid: `NEW-TAG-${uid}`,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.vehicle.plate).toBe(`NEW-${uid}`);
    expect(body.tag.tagUid).toBe(`NEW-TAG-${uid}`);
    expect(body.tag.status).toBe('ACTIVE');
  });

  it('creates a vehicle without a tag', async () => {
    const user = await createUser();
    const uid = Date.now().toString(36);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      body: { user_id: user.id, plate: `NOTAG-${uid}`, allowed_grade: 'DIESEL' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().tag).toBeNull();
  });

  it('creates vehicle with daily and weekly volume limits', async () => {
    const user = await createUser();
    const uid = Date.now().toString(36);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      body: {
        user_id: user.id,
        plate: `LIM-${uid}`,
        allowed_grade: 'GASOLINE_91',
        daily_litre_limit_ml: 60_000,
        weekly_litre_limit_ml: 300_000,
      },
    });

    expect(res.statusCode).toBe(201);
    const v = res.json().vehicle;
    expect(v.daily_litre_limit_ml).toBe(60_000);
    expect(v.weekly_litre_limit_ml).toBe(300_000);
  });

  it('rejects invalid grade', async () => {
    const user = await createUser();
    const uid = Date.now().toString(36);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      body: { user_id: user.id, plate: `BAD-${uid}`, allowed_grade: 'KEROSENE' },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ─── Suspend vehicle ───────────────────────────────────────────────────────────

describe('PATCH /v1/vehicles/:id', () => {
  it('suspends an active vehicle', async () => {
    const user = await createUser();
    const uid = Date.now().toString(36);
    const vehicle = await prisma.vehicle.create({
      data: { userId: user.id, plate: `SUSP-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/vehicles/${vehicle.id}`,
      body: { status: 'SUSPENDED' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('SUSPENDED');

    const v = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(v.status).toBe('SUSPENDED');
  });

  it('re-activates a suspended vehicle', async () => {
    const user = await createUser();
    const uid = Date.now().toString(36);
    const vehicle = await prisma.vehicle.create({
      data: { userId: user.id, plate: `REACT-${uid}`, allowedGrade: 'DIESEL', status: 'SUSPENDED' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/vehicles/${vehicle.id}`,
      body: { status: 'ACTIVE' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });
});

// ─── Add tag to vehicle ────────────────────────────────────────────────────────

describe('POST /v1/vehicles/:id/tags', () => {
  it('adds a tag to an existing vehicle', async () => {
    const user = await createUser();
    const uid = Date.now().toString(36);
    const vehicle = await prisma.vehicle.create({
      data: { userId: user.id, plate: `ADDTAG-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicle.id}/tags`,
      body: { tag_uid: `ADDED-TAG-${uid}` },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('rejects duplicate tag UID', async () => {
    const user = await createUser();
    const uid = Date.now().toString(36);
    const vehicle = await prisma.vehicle.create({
      data: { userId: user.id, plate: `DUPTAG-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
    });
    await prisma.rfidTag.create({ data: { tagUid: `DUP-TAG-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' } });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicle.id}/tags`,
      body: { tag_uid: `DUP-TAG-${uid}` },
    });

    expect(res.statusCode).toBe(409);
  });
});

// ─── Update tag status ─────────────────────────────────────────────────────────

describe('PATCH /v1/tags/:id', () => {
  it('suspends a tag', async () => {
    const user = await createUser();
    const uid = Date.now().toString(36);
    const vehicle = await prisma.vehicle.create({
      data: { userId: user.id, plate: `TS-${uid}`, allowedGrade: 'GASOLINE_95', status: 'ACTIVE' },
    });
    const tag = await prisma.rfidTag.create({
      data: { tagUid: `TS-TAG-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tags/${tag.id}`,
      body: { status: 'SUSPENDED' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('SUSPENDED');
  });

  it('marks a tag as LOST', async () => {
    const user = await createUser();
    const uid = Date.now().toString(36);
    const vehicle = await prisma.vehicle.create({
      data: { userId: user.id, plate: `TL-${uid}`, allowedGrade: 'DIESEL', status: 'ACTIVE' },
    });
    const tag = await prisma.rfidTag.create({
      data: { tagUid: `TL-TAG-${uid}`, vehicleId: vehicle.id, status: 'ACTIVE' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tags/${tag.id}`,
      body: { status: 'LOST' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('LOST');
  });
});
