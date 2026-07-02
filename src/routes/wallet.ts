import { FastifyInstance } from 'fastify';
import { AppTopupBodySchema, BankWebhookBodySchema } from '../schemas/topup.js';
import { appTopup, bankWebhookTopup } from '../modules/topup.js';
import { getWalletById, getWalletTransactions } from '../modules/wallet.js';
import { checkIdempotency, storeIdempotency, hashRequest } from '../lib/idempotency.js';
import { verifySignature } from '../lib/hmac.js';

export async function walletRoutes(app: FastifyInstance) {
  app.post('/v1/wallet/topups/app', async (request, reply) => {
    const idempotencyKey = (request.headers['idempotency-key'] as string) ?? '';
    if (!idempotencyKey) {
      return reply.status(400).send({ error: 'Idempotency-Key header is required' });
    }

    const parse = AppTopupBodySchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }

    const requestHash = hashRequest(parse.data);
    const cached = await checkIdempotency(idempotencyKey, 'app-topup', requestHash);
    if (cached.hit) {
      return reply.status(200).send(cached.response);
    }

    try {
      const result = await appTopup({
        walletId: parse.data.wallet_id,
        amountHalalas: BigInt(parse.data.amount_halalas),
        method: parse.data.method,
        idempotencyKey,
      });
      await storeIdempotency(idempotencyKey, 'app-topup', requestHash, result);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.post('/v1/wallet/topups/bank-webhook', async (request, reply) => {
    const providedSig = (request.headers['x-bank-signature'] as string) ?? '';
    const rawBody = JSON.stringify(request.body);
    const secret = process.env.BANK_WEBHOOK_SECRET ?? '';

    if (!verifySignature(secret, rawBody, providedSig)) {
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    const parse = BankWebhookBodySchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parse.error.issues });
    }

    try {
      const result = await bankWebhookTopup({
        bankReference: parse.data.bank_reference,
        virtualIban: parse.data.virtual_iban,
        amountHalalas: BigInt(parse.data.amount_halalas),
      });

      if (result === null) {
        return reply.status(200).send({ status: 'duplicate', message: 'Already processed' });
      }
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.get('/v1/wallets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const wallet = await getWalletById(id);
      return reply.status(200).send(wallet);
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 404).send({ error: e.message });
    }
  });

  app.get('/v1/wallets/:id/transactions', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const txs = await getWalletTransactions(id);
      return reply.status(200).send({ transactions: txs });
    } catch (err: unknown) {
      const e = err as { message: string; statusCode?: number };
      return reply.status(e.statusCode ?? 404).send({ error: e.message });
    }
  });
}
