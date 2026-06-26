import { z } from 'zod';

export const CreateVehicleSchema = z.object({
  user_id: z.string().uuid(),
  plate: z.string().min(1),
  allowed_grade: z.enum(['GASOLINE_91', 'GASOLINE_95', 'DIESEL']),
  daily_litre_limit_ml: z.number().int().positive().nullable().optional(),
  weekly_litre_limit_ml: z.number().int().positive().nullable().optional(),
  tag_uid: z.string().min(1).optional(), // optionally attach a tag at creation
});

export const CreateTagSchema = z.object({
  tag_uid: z.string().min(1),
});

export const UpdateVehicleStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

export const UpdateTagStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'LOST']),
});

export type CreateVehicle = z.infer<typeof CreateVehicleSchema>;
export type CreateTag = z.infer<typeof CreateTagSchema>;
