import { pathToFileURL } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../src/db.js';
import { Course, Lesson, Module, User } from '../src/models/index.js';

// Catalogue verified against Bunny library 788236 on 2026-11-05 (audit/bunny-videos.json).
// Lesson 4 is 9ba13055-…; the 33f644f2-… id in the spreadsheet belongs to Lesson 3.
const acceleratorVideos = [
  { title: 'Welcome and how to use this course', guid: '30498c3e-c0ab-4854-923a-7f2224d65079', seconds: 310, preview: true, module: 'Before you begin' },
  { title: 'Lesson 1 Introduction', guid: 'dd2049b3-9535-4dde-b635-4c6f416d5a36', seconds: 577, module: 'Lesson 1 – Introduction' },
  { title: 'Lesson 2 The Whys, “Wise”', guid: '4fbc21c0-44a0-46aa-966f-139fadf72da5', seconds: 518, module: 'Lesson 2 – The Whys, “Wise”' },
  { title: 'Lesson 3 The Quickening', guid: '33f644f2-a346-463b-bef9-3a25f6078ab4', seconds: 389, module: 'Lesson 3 – The Quickening' },
  { title: 'Lesson 4 Integrity and Love', guid: '9ba13055-8bdf-4b83-8b16-7e5e2885584e', seconds: 408, module: 'Lesson 4 – Integrity and Love' },
  { title: 'Lesson 5 Love and Freedom', guid: '333a1dce-0284-4716-bb0d-a0549b77e9ce', seconds: 605, module: 'Lesson 5 – Love and Freedom' },
  { title: 'Lesson 6 Presence and the Spiral of Life', guid: 'd9b9dd66-724f-46ee-9ace-5f3eef4e1f26', seconds: 622, module: 'Lesson 6 – Presence & The Spiral of Life' },
  { title: 'Lesson 7 Love and Your Three Part System', guid: 'ceb88acf-80fe-43c7-a3ab-7af0be31f396', seconds: 565, module: 'Lesson 7 – Love & Your Three Part System' },
  { title: 'Lesson 8 Beingness', guid: '4c02846d-dbde-4177-842c-12aaa6c8fb12', seconds: 426, module: 'Lesson 8 – Beingness' },
  { title: 'Lesson 9', guid: '856c79aa-8c41-4eee-9199-f87a06e5b358', seconds: 2128, module: 'Lesson 9' },
  { title: 'Lesson 10', guid: 'abf37a21-c8a0-48e0-905e-7e657245fb8a', seconds: 2282, module: 'Lesson 10' }
];

const courses = [
  {
    legacyId: 'accelerator',
    slug: '10-part-consciousness-accelerator',
    title: '10-Part Consciousness Accelerator',
    shortDescription: 'A step-by-step journey to expand your awareness and create a more fulfilling life.',
    description:
      'Join this accelerator course to form a deeper and more meaningful understanding of our world and increase your consciousness by opening the doors to your heart to the love that is waiting for you.',
    badge: 'Bestseller',
    level: 'Beginner Friendly',
    lengthLabel: '10 Modules',
    gradient: 'linear-gradient(135deg,#3a2a63,#7a5cd6)',
    categories: ['consciousness', 'life-transformation'],
    priceMinor: 19900,
    currency: 'USD',
    availableForPurchase: true,
    publicationStatus: 'published',
    banner: { url: '/images/courses/accelerator-banner.webp', width: 1669, height: 942 },
    outcomes: [
      'Greater self-awareness',
      'Practical tools and guidance',
      'Inner peace and emotional balance',
      'A more fulfilling and purposeful life'
    ],
    whoFor: [
      'New to consciousness work and want a structured, step-by-step starting point.',
      'Looking for a short daily practice rather than long classes.',
      'Want a guided exercise to integrate every lesson.'
    ],
    faqs: [
      { q: 'How is the Accelerator structured?', a: 'Ten lessons, each with its own video and guided exercise, plus two recorded Q&A sessions with Zalah. The program is designed around short daily sessions of about 12 minutes across 10 days.' },
      { q: 'How do I enrol and pay?', a: 'The Enroll Now button enrols you right here on this site, and the program opens in My Courses. The price is $199 USD.' },
      { q: 'Do I need any experience first?', a: 'No. The Accelerator is labelled beginner friendly and starts from the foundations of awareness and presence.' }
    ]
  },
  {
    legacyId: 'mindlife',
    slug: 'the-mind-life-transformation-collection',
    title: 'The Mind & Life Transformation Collection',
    shortDescription: 'Practical tools and timeless wisdom for a calmer, clearer and more meaningful life.',
    description:
      'Explore a unique combination of emotional insight, life philosophy and meditation psychology. This collection is designed to help you better understand yourself, your thoughts, and your connection with the world around you.',
    badge: 'Bundle',
    level: 'All Levels',
    lengthLabel: 'Collection',
    gradient: 'linear-gradient(135deg,#c9973e,#5b3fa6)',
    categories: ['mindfulness', 'life-transformation'],
    priceMinor: 29900,
    currency: 'USD',
    availableForPurchase: false,
    publicationStatus: 'published',
    banner: { url: '/images/courses/mindlife-banner.webp', width: 1670, height: 942 }
  },
  {
    legacyId: 'sa1',
    slug: 'spiritual-awakening-1',
    title: 'Spiritual Awakening 1',
    shortDescription: 'Start your journey towards a deeper connection with yourself and the universe.',
    description:
      'The first stage of the Spiritual Awakening pathway. These teachings are designed to help you build a stable meditation practice, understand the mechanics of consciousness, and begin living from a place of greater awareness.',
    badge: 'Most Popular',
    level: 'Level 1',
    lengthLabel: 'Self-Paced',
    gradient: 'linear-gradient(135deg,#5b3fa6,#c9973e)',
    categories: ['spiritual-growth'],
    priceMinor: 100000,
    currency: 'USD',
    availableForPurchase: false,
    publicationStatus: 'published',
    banner: { url: '/images/courses/sa1-banner.webp', width: 1670, height: 941 }
  },
  {
    legacyId: 'sa2',
    slug: 'spiritual-awakening-2',
    title: 'Spiritual Awakening 2',
    shortDescription: 'Go deeper into your transformation with advanced teachings and practices.',
    description:
      'The second stage of the pathway. SA2 deepens the work begun in SA1: detachment, stillness, worthiness, self-love and sacredness, taught in the live School class format.',
    badge: 'Advanced',
    level: 'Level 2',
    lengthLabel: 'Self-Paced',
    gradient: 'linear-gradient(135deg,#2f2258,#5b3fa6)',
    categories: ['spiritual-growth'],
    priceMinor: 200000,
    currency: 'USD',
    availableForPurchase: false,
    publicationStatus: 'published',
    banner: { url: '/images/courses/sa2-banner.webp', width: 1670, height: 942 }
  },
  {
    legacyId: 'complete',
    slug: 'the-complete-awakening-consciousness-transformation-program',
    title: 'The Complete Awakening & Consciousness Transformation Program',
    shortDescription: 'A complete path to transform your life and awaken your higher self.',
    description:
      'An all-in-one transformation system designed for deep personal growth. This bundle integrates step-by-step consciousness acceleration with spiritual awakening practices to help you reach your highest potential.',
    badge: 'Complete Path',
    level: 'Advanced',
    lengthLabel: 'Full Program',
    gradient: 'linear-gradient(135deg,#1a1033,#7a5cd6)',
    categories: ['consciousness', 'spiritual-growth', 'life-transformation'],
    priceMinor: 219900,
    currency: 'USD',
    availableForPurchase: false,
    publicationStatus: 'published',
    bundleLegacy: ['accelerator', 'sa1', 'sa2'],
    banner: { url: '/images/courses/complete-banner.webp', width: 1671, height: 941 }
  }
];

const upsertCourse = async (data) => {
  const { bundleLegacy, ...rest } = data;
  const course = await Course.findOneAndUpdate({ slug: data.slug }, { $set: rest, $setOnInsert: { accessPolicy: 'lifetime' } }, { new: true, upsert: true });
  if (bundleLegacy) {
    const ids = (await Course.find({ legacyId: { $in: bundleLegacy } }).select('_id')).map((c) => c._id);
    course.bundleIncludes = ids;
    await course.save();
  }
  console.log(`course  ${course.slug} (${course.currency} ${course.priceMinor / 100}) purchase=${course.availableForPurchase}`);
  return course;
};

const seedAcceleratorLessons = async (course) => {
  const byTitle = new Map();
  for (const [index, video] of acceleratorVideos.entries()) {
    const moduleTitle = video.module;
    if (!byTitle.has(moduleTitle)) {
      const module = await Module.findOneAndUpdate(
        { course: course._id, title: moduleTitle },
        { $set: { position: index, publicationStatus: 'published' } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      byTitle.set(moduleTitle, module);
    }
    const module = byTitle.get(moduleTitle);
    await Lesson.findOneAndUpdate(
      { course: course._id, module: module._id, title: video.title },
      {
        $set: {
          position: index,
          lessonType: 'video',
          videoGuid: video.guid,
          durationSeconds: video.seconds,
          isPreview: Boolean(video.preview),
          completion: { rule: 'watched' },
          publicationStatus: 'published'
        }
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }
  const count = await Lesson.countDocuments({ course: course._id, publicationStatus: 'published' });
  console.log(`lessons ${count} published for ${course.slug} (intro is the free preview)`);
};

const promote = async (email) => {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    console.error(`No account found for ${email}. Ask them to sign in once, then re-run this command.`);
    process.exitCode = 1;
    return;
  }
  user.role = 'admin';
  await user.save();
  console.log(`${email} is now an administrator.`);
};

export const seedCatalog = async () => {
  const byLegacy = new Map();
  for (const data of courses) {
    const course = await upsertCourse(data);
    byLegacy.set(data.legacyId, course);
  }
  // The collection names teachings that are not uploaded yet, so link only what exists.
  await seedAcceleratorLessons(byLegacy.get('accelerator'));
};

export const run = async () => {
  const args = process.argv.slice(2);
  await connectDatabase();
  if (args[0] === '--promote') {
    if (!args[1]) throw new Error('Usage: node scripts/seed.js --promote someone@example.com');
    await promote(args[1]);
  } else {
    await seedCatalog();
    console.log('Seed complete.');
  }
  await disconnectDatabase();
};

// Only the CLI seeds on import; the verification harness calls seedCatalog itself.
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  run().catch(async (err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  });
}
