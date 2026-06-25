import { z } from 'zod';

export const AuthorizeBodySchema = z.object({
  tag_uid: z.string().min(1),
  station_code: z.string().min(1),
  grade: z.enum(['GASOLINE_91', 'GASOLINE_95', 'DIESEL']),
});

export type AuthorizeBody = z.infer<typeof AuthorizeBodySchema>;
