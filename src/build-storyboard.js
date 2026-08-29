'use strict';
// Builds inputs/storyboard.json from whatever photos are actually in
// inputs/listing-photos/ — so sourcePhoto paths ALWAYS match real files and you
// never have to hand-match filenames. Each photo becomes a shot with a room
// label + a sensible camera move inferred from its filename. Edit the result in
// the dashboard afterward if you want; then Build shot plan -> Generate.
//
// Usage:
//   node src/build-storyboard.js                 # -> inputs/storyboard.json (midHome)
//   node src/build-storyboard.js --size estate   # smallHome | midHome | estate
//   node src/build-storyboard.js --force         # overwrite an existing storyboard

const fs = require('fs');
const path = require('path');
const { ROOT, abs, loadConfig } = require('./lib/config');

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

// filename keyword -> { motion, hero, room-ish }. First match wins; order matters.
// Bias toward DYNAMIC lateral moves (truck / orbit / reveal) over plain
// forward pushes — a sideways sweep reads as 3D and shows more of each room.
const RULES = [
  { re: /(exterior|facade|front|aerial|drone|elevation|curb)/i, motion: 'truck_right', hero: true },
  { re: /(dusk|twilight|night|rear|back|yard|pool|patio|deck)/i, motion: 'pull_back', hero: true },
  { re: /(foyer|entry|entrance|hall|corridor|stair)/i, motion: 'reveal', hero: false },
  { re: /(kitchen|pantry)/i, motion: 'truck_left', hero: true },
  { re: /(living|great|family|lounge|den)/i, motion: 'orbit_left', hero: true },
  { re: /(dining)/i, motion: 'orbit_right', hero: false },
  { re: /(primary|master|suite)/i, motion: 'truck_right', hero: true },
  { re: /(bed)/i, motion: 'truck_left', hero: false },
  { re: /(bath|ensuite|powder|spa|shower)/i, motion: 'reveal', hero: false },
  { re: /(office|study|library|gym|theater|theatre|media|bar|wine|laundry|mud)/i, motion: 'orbit_right', hero: false },
];
const CYCLE = ['truck_left', 'orbit_left', 'truck_right', 'reveal', 'orbit_right', 'dolly_in'];

function baseName(file) { return file.replace(IMAGE_RE, ''); }

function slug(name) {
  return baseName(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'shot';
}

// "04-kitchen.jpg" -> "Kitchen"; "primary-suite.jpg" -> "Primary Suite"
function roomLabel(name) {
  const words = baseName(name)
    .replace(/^[\s\-_]*\d+[\s\-_]*/, '')   // drop a leading ordering number
    .replace(/[\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return 'Room';
  return words.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function classify(name) {
  for (const r of RULES) if (r.re.test(name)) return r;
  return null;
}

function build({ size = 'midHome', photosDir } = {}) {
  const cfg = loadConfig();
  const dir = abs(photosDir || cfg.paths.listingPhotos);
  if (!fs.existsSync(dir)) throw new Error(`no listing-photos dir: ${cfg.paths.listingPhotos}`);
  const files = fs.readdirSync(dir).filter((f) => IMAGE_RE.test(f) && !f.startsWith('.')).sort();
  if (!files.length) throw new Error(`no photos in ${cfg.paths.listingPhotos} — drop listing photos there first`);

  const usedIds = new Set();
  const shots = files.map((file, i) => {
    const rule = classify(file);
    const motion = rule ? rule.motion : CYCLE[i % CYCLE.length];
    const isHero = rule ? rule.hero : false;
    let id = slug(file);
    while (usedIds.has(id)) id = `${id}-${i}`;
    usedIds.add(id);

    const first = i === 0;
    const last = i === files.length - 1;
    // Smooth room-to-room transitions: longer crossfades, no hard cuts mid-tour.
    // Alternate a soft directional wipe with a dissolve so it flows, not chops.
    const transitionIn = first
      ? { type: 'hard_cut', durationSec: 0 }
      : (i % 2 === 0 ? { type: 'through_doorway_match', durationSec: 0.7 } : { type: 'dissolve', durationSec: 0.6 });

    return {
      id,
      room: roomLabel(file),
      sourcePhoto: `${cfg.paths.listingPhotos}/${file}`,
      motion: { preset: motion, speed: 0.7, intensity: 0.5 },
      durationSec: isHero || first || last ? 5.0 : 4.0,
      framing: { crop: 'reframe_16x9', compositionPrompt: '' },
      caption: { text: roomLabel(file), style: 'minimal_lower_third' },
      transitionIn,
      isHero,
    };
  });

  return {
    listingId: 'listing',
    propertySize: size,
    brand: { agentName: 'Your Brokerage', primaryColor: '#0e1116', logo: '' },
    musicBed: null,
    shots,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const sizeIdx = args.indexOf('--size');
  const size = sizeIdx >= 0 ? args[sizeIdx + 1] : 'midHome';
  const force = args.includes('--force');
  const cfg = loadConfig();
  const out = abs(cfg.paths.storyboard);
  if (fs.existsSync(out) && !force) {
    console.error(`${cfg.paths.storyboard} already exists. Re-run with --force to overwrite, or edit it in the dashboard.`);
    process.exit(1);
  }
  try {
    const sb = build({ size });
    fs.writeFileSync(out, JSON.stringify(sb, null, 2));
    console.log(`Wrote ${sb.shots.length}-shot storyboard -> ${path.relative(ROOT, out)}`);
    for (const s of sb.shots) console.log(`  ${s.id.padEnd(20)} ${s.room.padEnd(16)} ${s.motion.preset}`);
    console.log('\nNext: Build shot plan -> Generate clips -> Assemble.');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { build, roomLabel, classify };
