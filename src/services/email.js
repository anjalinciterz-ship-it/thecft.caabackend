import { Resend } from 'resend';
import { env } from '../config/env.js';
import { EmailMessage } from '../models/index.js';

let client;
const resend = () => client || (client = new Resend(env.RESEND_API_KEY));

const shell = (title, body) => `<!doctype html><html><body style="margin:0;background:#120A24;padding:24px;font-family:Georgia,serif;color:#F8F5EF">
  <div style="max-width:560px;margin:0 auto;background:#1c1030;border:1px solid rgba(232,185,95,.35);border-radius:14px;padding:28px">
    <p style="margin:0 0 6px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#E8B95F">Mind Life Academy</p>
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#F8F5EF">${title}</h1>
    <div style="font-size:15px;line-height:1.65;color:#EDE7F5">${body}</div>
    <p style="margin:26px 0 0;font-size:12px;color:#b9aecb">vaibhavbuilds.space · help@vaibhavbuilds.space</p>
  </div>
</body></html>`;

const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** A one-time code must not linger in the mail log once the message has gone out. */
async function redact(record, template) {
  // A magic link is a credential in URL form, so it is treated exactly like a code.
  if (!['otp_code', 'magic_link'].includes(template)) return;
  record.html = '';
  record.text = template === 'magic_link'
    ? 'Sign-in link redacted after delivery.'
    : 'Verification code redacted after delivery.';
}

const templates = {
  order_paid: ({ student, order, courses }) => ({
    subject: `Your ${courses[0]?.title || 'course'} access is open`,
    html: shell(
      'Payment confirmed',
      `<p>Hello ${student.firstName || 'friend'},</p>
       <p>Your payment of <strong>${(order.totalMinor / 100).toFixed(2)} ${order.currency}</strong> is confirmed
       and your access is live on the same account you just paid with.</p>
       <p><strong>You can start now:</strong></p><ul>${courses.map((c) => `<li>${c.title}</li>`).join('')}</ul>
       <p>Sign in and open <em>My learning</em>. Keep the lessons to yourself, every frame you watch carries your own
       email, so a copy floating around the internet is traceable back to one account.</p>
       <p style="font-size:13px;color:#b9aecb">Order ${order.orderNumber} · ${(student.email || '').toUpperCase()}</p>`
    )
  }),
  purchase_admin_notice: ({ student, order, courses }) => ({
    subject: `Paid: ${courses[0]?.title || 'order'}, ${student.email}`,
    html: shell(
      'New purchase',
      `<p><strong>${(order.totalMinor / 100).toFixed(2)} ${order.currency}</strong> · order ${order.orderNumber}</p>
       <table style="font-size:14px;border-collapse:collapse">
         <tr><td style="padding:2px 10px 2px 0;color:#b9aecb">Name</td><td>${student.name || ''}</td></tr>
         <tr><td style="padding:2px 10px 2px 0;color:#b9aecb">Email</td><td>${student.email}</td></tr>
         <tr><td style="padding:2px 10px 2px 0;color:#b9aecb">Courses</td><td>${courses.map((c) => c.title).join(', ')}</td></tr>
         <tr><td style="padding:2px 10px 2px 0;color:#b9aecb">Provider</td><td>${order.provider} · ${order.providerSessionId || ''}</td></tr>
       </table>`
    )
  }),
  entitlement_granted: ({ student, course }) => ({
    subject: `You have access to ${course.title}`,
    html: shell(
      'Access opened',
      `<p>Hello ${student.firstName || 'friend'}, your place in <strong>${course.title}</strong> is ready.</p>
       <p>Sign in to begin. Access is lifetime and stays on this email address.</p>`
    )
  }),
  otp_code: ({ otp }) => ({
    subject: otp?.purpose === 'signup' ? 'Finish creating your Mind Life account' : 'Your Mind Life verification code',
    html: shell(
      'Verification code',
      `<p style="font-size:34px;letter-spacing:.26em;color:#E8B95F;font-family:monospace">${otp?.code || ''}</p>
       <p>It expires in ${otp?.minutes || 10} minutes and works once. If you did not ask for this code, no further action is needed.</p>`
    )
  }),
  magic_link: ({ magic }) => ({
    subject: 'Your Mind Life sign-in link',
    html: shell(
      'Sign in with one click',
      `<p>Press the button below and you are in, no password, no code to copy.</p>
       <p style="margin:26px 0"><a href="${magic?.url || '#'}"
          style="display:inline-block;padding:14px 26px;border-radius:999px;background:#E8B95F;color:#120A24;
                 font-family:Georgia,serif;font-size:16px;font-weight:700;text-decoration:none">Sign in to Mind Life</a></p>
       <p>The link works once and expires in ${magic?.minutes || 10} minutes. Open it on this device; if the button
       does not appear, paste the address into your browser.</p>
       <p style="font-size:13px;word-break:break-all;color:#b9aecb">${magic?.url || ''}</p>
       <p style="font-size:13px;color:#b9aecb">If you did not ask for this, nothing else is needed, the link cannot
       open your account without your mail inbox.</p>`
    )
  })
};

export async function sendEmail({ template, to, student, order, courses, course, otp, magic, orderRef, studentRef }) {
  const built = templates[template];
  if (!built) throw new Error(`Unknown email template: ${template}`);
  const { subject, html } = built({ student, order, courses, course, otp, magic });
  const record = await EmailMessage.create({
    template,
    to: String(to).toLowerCase(),
    from: env.EMAIL_FROM,
    subject,
    html,
    text: strip(html),
    provider: env.EMAIL_PROVIDER,
    order: orderRef,
    student: studentRef,
    status: 'queued'
  });

  if (env.EMAIL_PROVIDER !== 'resend' || !env.RESEND_API_KEY) {
    record.status = 'skipped';
    record.error = 'Email provider is mock; nothing was sent.';
    await redact(record, template);
    await record.save();
    console.log(`[email:mock] ${template} -> ${record.to} (${subject})`);
    return record;
  }

  try {
    // The SDK answers with { data, error } instead of throwing, so a rejected
    // send looks like a resolved promise unless the error field is read.
    const sent = await resend().emails.send({ from: env.EMAIL_FROM, to: record.to, subject, html });
    if (sent?.error) throw new Error(sent.error.message || 'The email provider rejected the message.');
    record.providerId = sent?.data?.id;
    record.status = 'sent';
    record.sentAt = new Date();
    console.log(`[email:sent] ${template} -> ${record.to} (${subject}) id=${record.providerId}`);
  } catch (err) {
    record.status = 'failed';
    record.error = err.message;
    console.error(`[email:failed] ${template} -> ${record.to}: ${err.message}`);
  }
  // A failed send keeps its body so an admin can retry it; a delivered code does not.
  if (record.status === 'sent') await redact(record, template);
  await record.save();
  return record;
}

export const emailStatus = () => ({
  provider: env.EMAIL_PROVIDER,
  configured: env.resendConfigured,
  from: env.EMAIL_FROM,
  adminNotify: env.ADMIN_NOTIFY_EMAIL || null
});
