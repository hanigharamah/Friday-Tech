import { FastifyInstance } from 'fastify';
import { AuthorizeBodySchema } from '../schemas/authorize.js';
import { SettleBodySchema } from '../schemas/settle.js';
import { authorize } from '../modules/authorization.js';
import { settle } from '../modules/settlement.js';
import { reverseAuthorization } from '../modules/reversal.js';
import { checkIdempotency, storeIdempotency, hashRequest } from '../lib/idempotency.js';
import { FuelGrade } from '@prisma/client';

export async function fuelRoutes(app: FastifyInstance) {
  app.post('/v1/fuel/authorize', async (request, reply) => {
    const parse = AuthorizeBodySchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }

    const { tag_uid, station_code, grade } = parse.data;

    try {
      const result = await authorize({ tagUid: tag_uid, stationCode: station_code, grade: grade as FuelGrade });
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.post('/v1/fuel/settle', async (request, reply) => {
    const idempotencyKey = (request.headers['idempotency-key'] as string) ?? '';
    if (!idempotencyKey) {
      return reply.status(400).send({ error: 'Idempotency-Key header is required' });
    }

    const parse = SettleBodySchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }

    const requestHash = hashRequest(parse.data);

    const cached = await checkIdempotency(idempotencyKey, 'settle', requestHash);
    if (cached.hit) {
      return reply.status(200).send(cached.response);
    }

    try {
      const result = await settle({
        authorizationId: parse.data.authorization_id,
        millilitresDispensed: parse.data.millilitres_dispensed,
      });

      await storeIdempotency(idempotencyKey, 'settle', requestHash, result);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // Emergency reversal — owner reports car stolen and cancels an in-progress hold
  app.post('/v1/fuel/authorizations/:id/reverse', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await reverseAuthorization(id);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });
}
