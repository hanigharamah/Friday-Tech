import { FastifyInstance } from 'fastify';
import { dailyReconciliation, walletStatement, vehicleConsumption } from '../modules/reports.js';

export async function reportRoutes(app: FastifyInstance) {
  // Daily reconciliation — totals for topups, fills, authorizations, outstanding holds
  app.get('/v1/reports/reconciliation', async (request, reply) => {
    const { date } = request.query as { date?: string };
    try {
      const report = await dailyReconciliation(date);
      return reply.status(200).send(report);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // Wallet statement — enriched ledger entries with human-readable descriptions
  app.get('/v1/wallets/:id/statement', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { from, to } = request.query as { from?: string; to?: string };
    try {
      const statement = await walletStatement(id, from, to);
      return reply.status(200).send(statement);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // Vehicle consumption — fill history and totals for a vehicle
  app.get('/v1/vehicles/:id/consumption', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { from, to } = request.query as { from?: string; to?: string };
    try {
      const report = await vehicleConsumption(id, from, to);
      return reply.status(200).send(report);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });
}
