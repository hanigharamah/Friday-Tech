import { z } from 'zod';

export const AppTopupBodySchema = z.object({
  wallet_id: z.string().uuid(),
  amount_halalas: z.number().int().positive(),
  method: z.enum(['APPLE_PAY', 'CARD']),
});

export type AppTopupBody = z.infer<typeof AppTopupBodySchema>;

export const BankWebhookBodySchema = z.object({
  bank_reference: z.string().min(1),
  virtual_iban: z.string().min(1),
  amount_halalas: z.number().int().positive(),
});

export type BankWebhookBody = z.infer<typeof BankWebhookBodySchema>;
