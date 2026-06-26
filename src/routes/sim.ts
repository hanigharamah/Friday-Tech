import { FastifyInstance } from 'fastify';
import { PumpScanSchema, PumpDispenseSchema, GatewayChargeSchema, BankTransferSchema } from '../schemas/sim.js';
import { pumpScan, pumpDispense, pumpAbort, getSession, PumpSession } from '../simulators/pump.js';
import { simulateCharge } from '../simulators/gateway.js';
import { simulateBankTransfer } from '../simulators/bank.js';
import { FuelGrade } from '@prisma/client';

function formatSession(session: PumpSession) {
  return {
    session_id: session.id,
    authorization_id: session.authorizationId,
    tag_uid: session.tagUid,
    station_code: session.stationCode,
    grade: session.grade,
    max_millilitres: session.maxMillilitres,
    status: session.status,
    created_at: session.createdAt.toISOString(),
    auth: session.authResult,
    settle: session.settleResult,
    reversal: session.reversalResult,
  };
}

export async function simRoutes(app: FastifyInstance) {
  // ── Pump terminal simulator ─────────────────────────────────────────────────

  app.post('/v1/sim/pump/scan', async (request, reply) => {
    const parse = PumpScanSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }
    const { tag_uid, station_code, grade, target_millilitres } = parse.data;
    try {
      const session = await pumpScan({
        tagUid: tag_uid,
        stationCode: station_code,
        grade: grade as FuelGrade,
        targetMillilitres: target_millilitres,
      });
      return reply.status(200).send(formatSession(session));
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.get('/v1/sim/pump/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return reply.status(200).send(formatSession(getSession(id)));
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.post('/v1/sim/pump/:id/dispense', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = PumpDispenseSchema.safeParse(request.body ?? {});
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }
    try {
      const session = await pumpDispense(id, parse.data.millilitres);
      return reply.status(200).send(formatSession(session));
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.post('/v1/sim/pump/:id/abort', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const session = await pumpAbort(id);
      return reply.status(200).send(formatSession(session));
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // ── Payment gateway simulator ───────────────────────────────────────────────

  app.post('/v1/sim/gateway/charge', async (request, reply) => {
    const parse = GatewayChargeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }
    const { wallet_id, amount_halalas, method, outcome } = parse.data;
    try {
      const result = await simulateCharge({ walletId: wallet_id, amountHalalas: amount_halalas, method, outcome });
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // ── Bank transfer simulator ─────────────────────────────────────────────────

  app.post('/v1/sim/bank/transfer', async (request, reply) => {
    const parse = BankTransferSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }
    const { virtual_iban, amount_sar, bank_reference } = parse.data;
    try {
      const result = await simulateBankTransfer({
        virtualIban: virtual_iban,
        amountSar: amount_sar,
        bankReference: bank_reference,
      });
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });
}
