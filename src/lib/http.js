export class ApiError extends Error {
  constructor(code, status = 400, message = '', details) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static badRequest(code, message, details) {
    return new ApiError(code, 400, message, details);
  }
  static unauthorized(message = 'Sign in to continue.') {
    return new ApiError('unauthenticated', 401, message);
  }
  static forbidden(message = 'You do not have access to this.') {
    return new ApiError('forbidden', 403, message);
  }
  static notFound(message = 'Not found.') {
    return new ApiError('not_found', 404, message);
  }
  static conflict(code, message, details) {
    return new ApiError(code, 409, message, details);
  }
  static tooManyRequests(message = 'Slow down and try again shortly.') {
    return new ApiError('too_many_requests', 429, message);
  }
  static unavailable(message = 'Temporarily unavailable.') {
    return new ApiError('upstream_unavailable', 503, message);
  }
}

export const ok = (res, data, status = 200) => res.status(status).json({ data });

export const paginated = (res, data, meta) => res.status(200).json({ data, meta });

export const noContent = (res) => res.status(204).end();

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function sendFailure(res, err) {
  if (res.headersSent) return;
  const status = err instanceof ApiError ? err.status : err.status || err.statusCode || 500;
  const code = err instanceof ApiError ? err.code : err.code || 'internal_error';
  if (status >= 500) console.error('[api]', code, err);
  res.status(status).json({
    error: {
      code,
      message: status >= 500 && code === 'internal_error' ? 'Something went wrong.' : err.message,
      ...(err.details ? { details: err.details } : {})
    }
  });
}
