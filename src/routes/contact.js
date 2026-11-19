import { Router } from 'express';
import { z } from 'zod';
import { ContactMessage } from '../models/index.js';
import { asyncHandler, ok } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { env } from '../config/env.js';
import { sendEmail } from '../services/email.js';

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

// app.js mounts this router at /contact, so the path here is the rest of the url.
// Writing '/contact' made the live endpoint /api/v1/contact/contact and every
// submission from the site answered 404, which the form showed as a plain failure.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const payload = validate(contactSchema, coerce(req.body));
    const idempotencyKey = req.get('Idempotency-Key') || null;
    if (idempotencyKey) {
      const seen = await ContactMessage.findOne({ idempotencyKey });
      if (seen) return ok(res, { contact: { id: String(seen._id), status: seen.status }, duplicate: true });
    }
    const saved = await ContactMessage.create({ ...payload, idempotencyKey });

    // The message is on disk before anything is mailed, so a provider outage can
    // turn this into a logged failure but never into a lost enquiry or a scary
    // error on a form the visitor already filled in.
    const notifyTo = env.CONTACT_NOTIFY_EMAIL || env.ADMIN_NOTIFY_EMAIL;
    if (notifyTo) {
      try {
        await sendEmail({
          template: 'contact_message',
          to: notifyTo,
          contact: { ...payload, source: payload.source || 'site' }
        });
      } catch (err) {
        console.error(`[contact] the notification for ${saved._id} could not be sent: ${err.message}`);
      }
    } else {
      console.warn(`[contact] message ${saved._id} saved but nobody was told; set CONTACT_NOTIFY_EMAIL`);
    }

    ok(res, { contact: { id: String(saved._id), status: saved.status } });
  })
);

export default router;
