import { z } from 'zod';

export function objectInputSchema(validatedSchema: z.ZodTypeAny, objectSchema: z.ZodTypeAny) {
  return objectSchema.superRefine((value, ctx) => {
    const result = validatedSchema.safeParse(value);
    if (result.success) return;
    for (const issue of result.error.issues) ctx.addIssue(issue);
  });
}
