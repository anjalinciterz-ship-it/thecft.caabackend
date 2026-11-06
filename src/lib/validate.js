import { ApiError } from './http.js';

export function validate(schema, payload, { status = 422, code = 'validation_failed' } = {}) {
  const result = schema.safeParse(payload ?? {});
  if (result.success) return result.data;
  throw new ApiError(code, status, result.error.issues[0]?.message || 'Check the submitted values.', {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      field: issue.path.join('.'),
      message: issue.message
    }))
  });
}
