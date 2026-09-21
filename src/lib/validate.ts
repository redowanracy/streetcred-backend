import { z } from 'zod';
import { badRequest } from './errors';

/** Parses untrusted input, turning schema failures into a 400 with field details. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest('VALIDATION_ERROR', 'Request is invalid', fields);
  }
  return result.data;
}

export const uuidParam = z.object({ id: z.uuid() });
export const catalogIdParam = z.object({ id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/) });
