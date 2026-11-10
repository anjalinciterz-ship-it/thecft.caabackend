import { pathToFileURL } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../src/db.js';
import { Course, Lesson, Module, User } from '../src/models/index.js';

// Bunny Stream video GUIDs from the new library (2026-11-07).
const acceleratorVideos = [
  { title: 'Intro video', guid: 'b47a3fad-0d9c-422b-bdd2-be9c9795790e', seconds: 310, preview: true, module: 'Before you begin' },
  { title: 'Lesson 1', guid: '1f46d6a3-24c4-44a1-9740-cacb0af0bd5d', seconds: 577, module: 'Lesson 1' },
  { title: 'Lesson 2', guid: 'cd2e72a0-6640-40fd-9f19-f17cc128c4b6', seconds: 518, module: 'Lesson 2' },
  { title: 'Lesson 3', guid: '44a71b0e-45ac-48c6-9cd0-df14924bc27a', seconds: 389, module: 'Lesson 3' },
  { title: 'Lesson 4', guid: 'b2cbb95a-8b2d-4d45-965c-748f4a2e4ae8', seconds: 408, module: 'Lesson 4' },
  { title: 'Lesson 5', guid: 'dc413302-085c-40bd-a230-aa9db1ba667e', seconds: 605, module: 'Lesson 5' },
  { title: 'Lesson 6', guid: 'ca0acd72-2398-48a7-8f9e-6816283dd4db', seconds: 622, module: 'Lesson 6' },
  { title: 'Lesson 7', guid: 'd778cd2f-14a3-4b2f-9fba-484fc04d15f6', seconds: 565, module: 'Lesson 7' },
  { title: 'Lesson 8', guid: '6eb60363-a7e9-4087-a986-78e1fd776141', seconds: 426, module: 'Lesson 8' },
  { title: 'Lesson 9', guid: '8dd92716-289a-431b-b279-f701abd81ed0', seconds: 2128, module: 'Lesson 9' },
  { title: 'Lesson 10', guid: 'd5887192-7bbf-4a72-b674-22287fd3af66', seconds: 2282, module: 'Lesson 10' }
];

const sa1Videos = [
  { title: 'Intro', guid: 'b1fd24e6-825d-44e4-ac97-4a0642a78c59', seconds: 300, preview: true, module: 'Introduction' },
  { title: 'Class 1', guid: '14052a48-5ced-465b-b36b-cdfdf0b906fb', seconds: 1800, module: 'Class 1' },
  { title: 'Class 2', guid: '2098e37c-cb67-4e97-b656-dca18c1dc301', seconds: 1800, module: 'Class 2' },
  { title: 'Class 3', guid: 'cde54fb2-80ce-45ac-b6cb-0994024cf969', seconds: 1800, module: 'Class 3' },
  { title: 'Class 4', guid: 'b25f2728-68e1-472c-b73e-1e553c4df83d', seconds: 1800, module: 'Class 4' },
  { title: 'Class 5', guid: '6130f2ec-1054-4e70-b854-43328b6dd842', seconds: 1800, module: 'Class 5' },
  { title: 'Class 6', guid: '8a8cdebf-0886-4e30-a3b5-c1dcb1091323', seconds: 1800, module: 'Class 6' },
  { title: 'Class 7', guid: '90e2c677-bb8a-49dc-96db-700fc5032c7f', seconds: 1800, module: 'Class 7' },
  { title: 'Class 8', guid: 'd52ccd4c-4b8c-44ca-8e19-94939115214d', seconds: 1800, module: 'Class 8' },
  { title: 'Class 9', guid: 'eb0414e1-eaad-48f2-8e75-8547d4127a5e', seconds: 1800, module: 'Class 9' },
  { title: 'Class 10', guid: 'bf17236e-71a5-41a0-9f2b-d7f36fd3de9b', seconds: 1800, module: 'Class 10' },
  { title: 'Class 11', guid: '139c8019-538d-4cb0-b24a-7f421afc3c34', seconds: 1800, module: 'Class 11' }
];

const sa2Videos = [
  { title: 'Intro', guid: '23f5a317-13d9-439b-8729-f676647a05b1', seconds: 300, preview: true, module: 'Introduction' },
  { title: 'Class 1', guid: '557087c1-e35e-4f3f-afa1-b09d4501c625', seconds: 1800, module: 'Class 1' },
  { title: 'Class 2', guid: '4ed043ac-8650-4c70-a090-2cb2b417b083', seconds: 1800, module: 'Class 2' },
  { title: 'Class 3', guid: 'defaf28b-6f61-431b-9281-8227cff3be55', seconds: 1800, module: 'Class 3' },
  { title: 'Class 4', guid: 'e2940373-8454-4700-9916-9fdcae22af97', seconds: 1800, module: 'Class 4' },
  { title: 'Class 5', guid: '44cabd1d-b5bd-467b-b2ad-094a7d9fd301', seconds: 1800, module: 'Class 5' },
  { title: 'Class 6', guid: '8cac1250-e842-4c0d-a25f-b946c000551a', seconds: 1800, module: 'Class 6' },
  { title: 'Class 7', guid: '07291140-5f97-47d7-899b-eebe27aa9336', seconds: 1800, module: 'Class 7' },
  { title: 'Class 8', guid: '5d47e362-571a-4e0b-9514-8287f8681f3a', seconds: 1800, module: 'Class 8' },
  { title: 'Class 9', guid: '659117f6-d292-4ba8-b79d-c47c9be58038', seconds: 1800, module: 'Class 9' },
  { title: 'Class 10', guid: '58f03a45-cb2f-4903-af8a-91b4f56b15ff', seconds: 1800, module: 'Class 10' },
  { title: 'Class 11', guid: 'ab44bde2-0992-4e56-a560-4b81c820c745', seconds: 1800, module: 'Class 11' }
];

// Mind & Life teaches its own four videos plus the whole Accelerator, so the
// borrowed rows name the course whose library holds them.
const borrowed = acceleratorVideos.map((video) => ({ ...video, source: 'accelerator' }));
const mindlifeOwnVideos = [
  { title: "Valentine's Day Memoir", guid: 'd4521fb0-b1c2-4cf0-bef4-2945cda899ae', seconds: 1800, module: "Valentine's Day Memoir" },
  { title: 'Earth Day Webinar', guid: '155f9457-f1da-4f4f-9c49-70d1e5b6ffe3', seconds: 1800, module: 'Earth Day Webinar' },
  { title: 'Life is Like a Swimming Pool', guid: '9114dabe-d86d-4834-95cd-c41af994c595', seconds: 1800, module: 'Life is Like a Swimming Pool' },
  { title: 'Psychology Of Meditation', guid: '67d78740-47cd-4693-b52d-90aba37989c4', seconds: 1800, module: 'Psychology Of Meditation' }
];
const mindlifeVideos = [borrowed[0], ...mindlifeOwnVideos, ...borrowed.slice(1)];

// Each course plays out of its own Bunny library, and the token key that signs
// those embeds is a secret, so it comes from backend/.env and never from this file.
const bunnySigningKeys = {
  accelerator: process.env.BUNNY_SIGNING_KEY_ACCELERATOR || '',
  mindlife: process.env.BUNNY_SIGNING_KEY_MINDLIFE || '',
  sa1: process.env.BUNNY_SIGNING_KEY_SA1 || '',
  sa2: process.env.BUNNY_SIGNING_KEY_SA2 || ''
};

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
    bunnyLibraryId: '802324',
    bunnySigningKey: bunnySigningKeys.accelerator,
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
    availableForPurchase: true,
    publicationStatus: 'published',
    banner: { url: '/images/courses/mindlife-banner.webp', width: 1670, height: 942 },
    bunnyLibraryId: '802549',
    bunnySigningKey: bunnySigningKeys.mindlife
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
    availableForPurchase: true,
    publicationStatus: 'published',
    banner: { url: '/images/courses/sa1-banner.webp', width: 1670, height: 941 },
    bunnyLibraryId: '802325',
    bunnySigningKey: bunnySigningKeys.sa1
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
    availableForPurchase: true,
    publicationStatus: 'published',
    banner: { url: '/images/courses/sa2-banner.webp', width: 1670, height: 942 },
    bunnyLibraryId: '802326',
    bunnySigningKey: bunnySigningKeys.sa2
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
    availableForPurchase: true,
    publicationStatus: 'published',
    bundleLegacy: ['accelerator', 'sa1', 'sa2'],
    features: ['All videos from all three courses', '4 free 1-on-1 sessions with Zalah'],
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

const seedCourseLessons = async (course, videos, label, byLegacy = new Map()) => {
  const byTitle = new Map();
  for (const [index, video] of videos.entries()) {
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
    const source = video.source ? byLegacy.get(video.source) : null;
    if (video.source && !source) throw new Error(`Lesson "${video.title}" borrows from ${video.source}, which is not seeded yet.`);
    await Lesson.findOneAndUpdate(
      { course: course._id, module: module._id, title: video.title },
      {
        $set: {
          position: index,
          lessonType: 'video',
          videoGuid: video.guid,
          videoSource: source ? source._id : null,
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
  console.log(`lessons ${count} published for ${course.slug} (${label})`);
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
  await seedCourseLessons(byLegacy.get('accelerator'), acceleratorVideos, 'intro is the free preview');
  await seedCourseLessons(byLegacy.get('sa1'), sa1Videos, 'intro is the free preview');
  await seedCourseLessons(byLegacy.get('sa2'), sa2Videos, 'intro is the free preview');
  await seedCourseLessons(byLegacy.get('mindlife'), mindlifeVideos, 'intro is the free preview, plus 4 Mind & Life videos and Accelerator lessons 1-10', byLegacy);
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
