// Does a hostile form submission get neutralised before it becomes an email?
// The contact template interpolates whatever a stranger typed, so this runs the
// real service against a throwaway database and reads back the html it built.
// Run with: node tests/verify-contact-escape.mjs
import memory from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.SESSION_SIGNING_KEY = 'x'.repeat(32);
process.env.EMAIL_PROVIDER = 'mock';

const mongo = await memory.MongoMemoryServer.create();
await mongoose.connect(mongo.getUri('cft_escape_check'));

const { sendEmail } = await import('../src/services/email.js');

const hostile = {
  name: '<script>alert(1)</script>Mishra',
  email: 'attacker@example.test',
  topic: '</td></tr></table><img src=x onerror=alert(2)>',
  message: 'Hello <b>bold</b> & "quotes" <a href="http://evil.example">click here</a>',
  phone: '<svg/onload=alert(3)>'
};

const record = await sendEmail({ template: 'contact_message', to: 'owner@example.test', contact: hostile });

const checks = [
  ['no raw script tag', !/<script/i.test(record.html)],
  ['no raw img tag', !/<img/i.test(record.html)],
  ['no raw svg tag', !/<svg/i.test(record.html)],
  ['no raw anchor', !/<a href/i.test(record.html)],
  ['ampersand escaped', /&amp;/.test(record.html)],
  ['quotes escaped', /&quot;/.test(record.html)],
  ['subject has no markup', !/[<>]/.test(record.subject)],
  ['addressed to the inbox, not the visitor', record.to === 'owner@example.test']
];

console.log(`subject: ${record.subject}\n`);
let bad = 0;
for (const [label, pass] of checks) {
  if (!pass) bad += 1;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}`);
}
await mongoose.disconnect();
await mongo.stop();
console.log(bad ? `\n${bad} PROBLEM(S)` : '\nthe visitor text cannot inject markup into the email');
process.exit(bad ? 1 : 0);
