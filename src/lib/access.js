import { Entitlement } from '../models/index.js';

export const activeEntitlementFor = (studentId, courseId) =>
  Entitlement.findOne({ student: studentId, course: courseId, status: 'active' });

export function isAccessible(entitlement, at = new Date()) {
  if (!entitlement) return false;
  if (entitlement.status !== 'active') return false;
  if (!entitlement.accessUntil) return true;
  return entitlement.accessUntil.getTime() > at.getTime();
}

export const accessStateFor = (entitlement, at = new Date()) => {
  if (!entitlement) return 'none';
  return isAccessible(entitlement, at) ? 'full' : 'revoked';
};
