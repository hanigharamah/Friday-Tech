import { FastifyInstance } from 'fastify';
import { CreateUserSchema } from '../schemas/user.js';
import { createUser } from '../modules/user.js';

export async function userRoutes(app: FastifyInstance) {
  app.post('/v1/users', async (request, reply) => {
    const parse = CreateUserSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }
    try {
      const result = await createUser({
        name: parse.data.name,
        email: parse.data.email,
        virtualIban: parse.data.virtual_iban,
      });
      return reply.status(201).send(result);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });
}
