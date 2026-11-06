import { Router } from 'express';
import { z } from 'zod';
import { ContactMessage } from '../models/index.js';
import { asyncHandler, ok } from '../lib/http.js';
import { validate } from '../lib/validate.js';

export const router = Router();

const contactSchema = z.object({
  name: z.string().trim().min(1, 'Your name is needed.'),
  email: z.string().trim().email('A usable email address is needed.'),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  topic: z.string().trim().max(120).optional().or(z.literal('')),
  message: z.string().trim().min(1, 'Write a message first.'),
  source: z.string().trim().max(40).optional()
});

// The page posts FormData, so field values arrive as strings.
const coerce = (payload) =>
  Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value : String(value ?? '')])
  );

router.post(
  '/contact',
  asyncHandler(async (req, res) => {
    const payload = validate(contactSchema, coerce(req.body));
    const idempotencyKey = req.get('Idempotency-Key') || null;
    if (idempotencyKey) {
      const seen = await ContactMessage.findOne({ idempotencyKey });
      if (seen) return ok(res, { contact: { id: String(seen._id), status: seen.status }, duplicate: true });
    }
    const saved = await ContactMessage.create({ ...payload, idempotencyKey });
    ok(res, { contact: { id: String(saved._id), status: saved.status } });
  })
);

export default router;
