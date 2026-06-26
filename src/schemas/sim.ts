import { z } from 'zod';

export const PumpScanSchema = z.object({
  tag_uid: z.string().min(1),
  station_code: z.string().min(1),
  grade: z.enum(['GASOLINE_91', 'GASOLINE_95', 'DIESEL']),
  target_millilitres: z.number().int().positive().optional(), // how much to dispense; defaults to max
});

export const PumpDispenseSchema = z.object({
  millilitres: z.number().int().positive().optional(), // override target
});

export const GatewayChargeSchema = z.object({
  wallet_id: z.string().uuid(),
  amount_halalas: z.number().int().positive(),
  method: z.enum(['APPLE_PAY', 'CARD']),
  outcome: z.enum(['success', 'declined', 'insufficient_funds', 'timeout']).default('success'),
});

export const BankTransferSchema = z.object({
  virtual_iban: z.string().min(1),
  amount_sar: z.number().positive(), // SAR — what bank systems send
  bank_reference: z.string().min(1).optional(), // auto-generated if omitted
});
