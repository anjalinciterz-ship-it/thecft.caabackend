/* One-off data fix, kept in the repo so it can be re-run or reviewed.

   The Mind & Life collection teaches several of the Accelerator's videos. Those
   rows carry the Accelerator's guid but, in this database, no videoSource, so
   playback signs the embed against Mind & Life's own Bunny library, which does
   not hold the file, and Bunny answers 404. Pointing the rows at the course that
   actually owns the library is the whole fix; no guid is invented or changed.

     node scripts/fix-mindlife-video-sources.mjs          # report only
     node scripts/fix-mindlife-video-sources.mjs --apply  # write it
*/
import { connectDatabase, disconnectDatabase } from '../src/db.js';
import { Course, Lesson } from '../src/models/index.js';

const MINDLIFE = 'the-mind-life-transformation-collection';
const ACCELERATOR = '10-part-consciousness-accelerator';
const apply = process.argv.includes('--apply');

await connectDatabase();

const mindlife = await Course.findOne({ slug: MINDLIFE });
const accelerator = await Course.findOne({ slug: ACCELERATOR });
if (!mindlife || !accelerator) throw new Error(`Missing course rows: mindlife=${!!mindlife} accelerator=${!!accelerator}`);

const ownedGuids = new Set((await Lesson.find({ course: accelerator._id, videoGuid: { $ne: null } }).select('videoGuid')).map((l) => l.videoGuid));
console.log(`accelerator library ${accelerator.bunnyLibraryId || '(env default)'} owns ${ownedGuids.size} video guids`);

// Borrowed = a Mind & Life lesson whose file lives in the Accelerator's library.
const borrowed = await Lesson.find({ course: mindlife._id, videoGuid: { $in: [...ownedGuids] } }).sort({ position: 1 });
const stale = borrowed.filter((l) => String(l.videoSource || '') !== String(accelerator._id));
console.log(`mindlife library ${mindlife.bunnyLibraryId || '(env default)'}: ${borrowed.length} borrowed lessons, ${stale.length} without the correct videoSource`);
for (const l of stale) console.log(`  - ${l.title}  guid=${l.videoGuid}  videoSource=${l.videoSource || 'null'}`);

if (!stale.length) {
  console.log('\nNothing to change.');
  await disconnectDatabase();
  process.exit(0);
}

if (!apply) {
  console.log(`\nDRY RUN. Re-run with --apply to set videoSource on ${stale.length} lessons.`);
  await disconnectDatabase();
  process.exit(0);
}

const result = await Lesson.updateMany(
  { _id: { $in: stale.map((l) => l._id) } },
  { $set: { videoSource: accelerator._id } }
);
console.log(`\napplied: ${result.modifiedCount} updated`);

const after = await Lesson.countDocuments({ course: mindlife._id, videoGuid: { $in: [...ownedGuids] }, videoSource: { $ne: accelerator._id } });
console.log(`verified: ${after} borrowed lessons still point at the wrong library`);
await disconnectDatabase();
