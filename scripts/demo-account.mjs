// One shared preview login: an email, a password, and every published course
// already open, so a prospective buyer can judge the whole library without
// paying. Re-running it is safe, it repairs the same account instead of making
// a second one.
//
//   DEMO_EMAIL=preview@example.com DEMO_PASSWORD='somethinglong' node scripts/demo-account.mjs
//   node scripts/demo-account.mjs --remove
//
// The password is only ever read from the environment. It never goes in a
// command argument, where it would sit in the shell history, and it is never
// printed.
import { pathToFileURL } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../src/db.js';
import { Course, Entitlement, Order, User } from '../src/models/index.js';

const email = (process.env.DEMO_EMAIL || '').trim().toLowerCase();
const password = process.env.DEMO_PASSWORD || '';

// A preview account is handed out in a chat message, so a short or common
// password is a real risk. This is the same floor the signup form enforces.
const weak = (value) =>
  value.length < 10 || !/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-z0-9]/.test(value);

async function remove() {
  const found = await User.findOne({ email });
  if (!found) {
    console.log(`No account for ${email}, nothing to remove.`);
    return;
  }
  const granted = await Entitlement.deleteMany({ student: found._id });
  const orders = await Order.deleteMany({ student: found._id, paymentStatus: 'pending' });
  await found.deleteOne();
  console.log(`Removed ${email}, ${granted.deletedCount} course grant(s) and ${orders.deletedCount} unfinished order(s).`);
}

async function create() {
  if (!email) throw new Error('DEMO_EMAIL is required.');
  if (!password) throw new Error('DEMO_PASSWORD is required.');
  if (weak(password)) {
    throw new Error('DEMO_PASSWORD is too weak for an account you will hand out: use 10+ characters with upper, lower, a digit and a symbol.');
  }

  const courses = await Course.find({ publicationStatus: 'published' }).sort({ title: 1 });
  if (!courses.length) throw new Error('The catalog has no published courses. Run npm run seed first.');

  let user = await User.findOne({ email });
  if (user) {
    console.log(`Updating the existing account ${email}.`);
  } else {
    user = new User({ firstName: 'Preview', lastName: 'Viewer', email });
    console.log(`Creating ${email}.`);
  }
  // The preview has to behave like a paid member everywhere, and the checkout,
  // the profile and the receipt mail all key off a verified email.
  user.status = 'active';
  user.role = 'student';
  user.emailVerified = true;
  user.termsAcceptedAt = user.termsAcceptedAt || new Date();
  await user.setPassword(password);

  const granted = [];
  for (const course of courses) {
    await Entitlement.findOneAndUpdate(
      { student: user._id, course: course._id },
      {
        $set: { status: 'active', source: 'admin_grant', accessUntil: null, revokedAt: null, revokedBy: null, revokeReason: null },
        $setOnInsert: { grantedAt: new Date() }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    granted.push(`${course.title} (${course.priceMinor / 100})`);
  }

  console.log(`\n${email} now opens ${granted.length} courses:`);
  granted.forEach((g) => console.log(`  - ${g}`));
  console.log('\nSign-in needs password login switched on, so set AUTH_PASSWORD_ENABLED=true where this server runs.');
}

export const run = async () => {
  const args = process.argv.slice(2);
  await connectDatabase();
  if (args.includes('--remove')) await remove();
  else await create();
  await disconnectDatabase();
};

// Only the CLI acts on import; harnesses import run() when they want it.
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  run().catch(async (err) => {
    console.error('[demo-account] failed:', err.message);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });
}
