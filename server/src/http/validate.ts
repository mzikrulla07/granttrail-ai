/** Input validation helpers built on zod. Invalid input → 400 with field-level messages. */
import type { z } from 'zod';
import { AppError } from './errors.js';

export function parseInput<S extends z.ZodType>(schema: S, input: unknown, what = 'request'): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError(400, 'VALIDATION_FAILED', `The ${what} contains invalid values.`, details);
  }
  return r.data;
}
