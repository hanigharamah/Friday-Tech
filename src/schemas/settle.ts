import { z } from 'zod';

export const SettleBodySchema = z.object({
  authorization_id: z.string().uuid(),
  millilitres_dispensed: z.number().int().positive(),
});

export type SettleBody = z.infer<typeof SettleBodySchema>;
