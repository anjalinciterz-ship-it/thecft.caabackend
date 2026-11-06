import { User } from '../models/index.js';
import { ApiError } from '../lib/http.js';

export async function attachUser(req, _res, next) {
  const uid = req.session?.uid;
  if (!uid) return next();
  try {
    const user = await User.findById(uid);
    if (!user) {
      req.session?.destroy?.();
      return next();
    }
    if (user.status !== 'active') return next(ApiError.forbidden('This account is suspended.'));
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}
