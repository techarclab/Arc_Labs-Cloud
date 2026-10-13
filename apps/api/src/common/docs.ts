import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

/** JSON Schema for OpenAPI from the same zod schema the endpoint validates with. */
function jsonSchema(schema: z.ZodTypeAny): Record<string, any> {
  const s = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as Record<string, any>;
  delete s.$schema;
  return s;
}

/**
 * Documents an endpoint in /api/docs: summary plus the request body and/or query
 * parameters, derived from the zod schemas used for validation (so docs can't drift).
 */
export function Doc(summary: string, opts: { body?: z.ZodTypeAny; query?: z.ZodTypeAny; description?: string } = {}) {
  const decorators = [ApiOperation({ summary, description: opts.description })];
  if (opts.body) decorators.push(ApiBody({ schema: jsonSchema(opts.body) }));
  if (opts.query) {
    const s = jsonSchema(opts.query);
    const required = new Set<string>(s.required ?? []);
    for (const [name, prop] of Object.entries<any>(s.properties ?? {})) {
      decorators.push(ApiQuery({ name, required: required.has(name), schema: prop }));
    }
  }
  return applyDecorators(...decorators);
}
