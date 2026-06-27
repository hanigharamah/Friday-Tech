import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import {
  CreateVehicleSchema,
  CreateTagSchema,
  UpdateVehicleStatusSchema,
  UpdateTagStatusSchema,
} from '../schemas/vehicle.js';
import { expireStaleAuthorizations } from '../modules/expiry.js';
import { fuelGradeDisplay, gradeColorHint } from '../lib/format.js';

function formatVehicle(v: {
  id: string;
  plate: string;
  allowedGrade: string;
  status: string;
  makeModel: string | null;
  tankCapacityMl: number | null;
  dailyLitreLimitMl: number | null;
  weeklyLitreLimitMl: number | null;
}) {
  const fuelType = fuelGradeDisplay(v.allowedGrade);
  const colorHint = gradeColorHint(v.allowedGrade);
  return {
    id: v.id,
    plate: v.plate,
    make_model: v.makeModel ?? null,
    tank_capacity_ml: v.tankCapacityMl ?? null,
    status: v.status,
    fuel_type: fuelType,
    color_hint: colorHint,
    daily_litre_limit_ml: v.dailyLitreLimitMl ?? null,
    weekly_litre_limit_ml: v.weeklyLitreLimitMl ?? null,
  };
}

export async function vehicleRoutes(app: FastifyInstance) {
  app.post('/v1/vehicles', async (request, reply) => {
    const parse = CreateVehicleSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }

    const {
      user_id,
      plate,
      allowed_grade,
      daily_litre_limit_ml,
      weekly_litre_limit_ml,
      make_model,
      tank_capacity_ml,
      tag_uid,
    } = parse.data;

    const user = await prisma.user.findUnique({ where: { id: user_id } });
    if (!user) return reply.status(404).send({ error: 'User not found' });

    const vehicle = await prisma.vehicle.create({
      data: {
        userId: user_id,
        plate,
        allowedGrade: allowed_grade,
        status: 'ACTIVE',
        dailyLitreLimitMl: daily_litre_limit_ml ?? null,
        weeklyLitreLimitMl: weekly_litre_limit_ml ?? null,
        makeModel: make_model ?? null,
        tankCapacityMl: tank_capacity_ml ?? null,
      },
    });

    let tag = null;
    if (tag_uid) {
      tag = await prisma.rfidTag.create({
        data: { tagUid: tag_uid, vehicleId: vehicle.id, status: 'ACTIVE' },
      });
    }

    return reply.status(201).send({ vehicle: formatVehicle(vehicle), tag });
  });

  app.patch('/v1/vehicles/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = UpdateVehicleStatusSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }

    const vehicle = await prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) return reply.status(404).send({ error: 'Vehicle not found' });

    const updated = await prisma.vehicle.update({
      where: { id },
      data: { status: parse.data.status },
    });

    return reply.status(200).send(formatVehicle(updated));
  });

  app.post('/v1/vehicles/:id/tags', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = CreateTagSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }

    const vehicle = await prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) return reply.status(404).send({ error: 'Vehicle not found' });

    try {
      const tag = await prisma.rfidTag.create({
        data: { tagUid: parse.data.tag_uid, vehicleId: id, status: 'ACTIVE' },
      });
      return reply.status(201).send(tag);
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.status(409).send({ error: 'Tag UID already registered' });
      }
      throw err;
    }
  });

  app.patch('/v1/tags/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = UpdateTagStatusSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }

    const tag = await prisma.rfidTag.findUnique({ where: { id } });
    if (!tag) return reply.status(404).send({ error: 'Tag not found' });

    const updated = await prisma.rfidTag.update({
      where: { id },
      data: { status: parse.data.status },
    });

    return reply.status(200).send(updated);
  });

  app.post('/v1/admin/expire-authorizations', async (_request, reply) => {
    const result = await expireStaleAuthorizations();
    return reply.status(200).send(result);
  });
}
