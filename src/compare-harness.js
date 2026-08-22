'use strict';
// Blind-compare harness for the critic. Each round it:
//   1) Extracts evenly-spaced frames from OUR render.
//   2) Gathers the reference-frame bar.
//   3) Emits a BLIND set: frames copied to work/compare-frames/ with neutral
//      names (item-01..N) and labels stripped, plus a sealed answer key the
//      critic must not open until after judging.
//
// The critic subagent opens the blind items, decides which look like a
// professional property walkthrough, then reveals the key to see whether it
// picked OURS. This keeps the judgement honest (no "ours" label to anchor on).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, abs, loadConfig } = require('./lib/config');
const { ffmpeg, durationSec } = require('./lib/ffmpeg');

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

function extractOursFrames(videoPath, n, outDir) {
  const total = durationSec(videoPath);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (total * (i + 0.5)) / n; // avoid first/last frame edge cases
    const p = path.join(outDir, `_ours-${String(i + 1).padStart(2, '0')}.png`);
    ffmpeg(['-y', '-ss', String(round(t)), '-i', videoPath, '-frames:v', '1', '-q:v', '2', p]);
    out.push(p);
  }
  return out;
}

function gatherRefFrames(refDir) {
  const d = abs(refDir);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => IMAGE_RE.test(f)).map((f) => path.join(d, f));
}

// Build the blind set. Returns { dir, items:[{blind, src, origin}], keyPath }.
function build({ n = 6, videoPath, refDir } = {}) {
  const cfg = loadConfig();
  const outDir = abs(cfg.paths.compareFrames);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const vid = abs(videoPath || cfg.paths.assembledVideo);
  if (!fs.existsSync(vid)) throw new Error(`no render to compare: ${vid}`);
  const ours = extractOursFrames(vid, n, outDir);
  const refs = gatherRefFrames(refDir || cfg.paths.referenceFrames);
  if (!refs.length) throw new Error('no reference frames present — cannot compare against the bar');

  const pool = [
    ...ours.map((p) => ({ src: p, origin: 'ours' })),
    ...refs.map((p) => ({ src: p, origin: 'reference' })),
  ];
  shuffle(pool);

  const items = pool.map((item, i) => {
    const blindName = `item-${String(i + 1).padStart(2, '0')}${path.extname(item.src)}`;
    const dest = path.join(outDir, blindName);
    fs.copyFileSync(item.src, dest);
    return { blind: blindName, origin: item.origin, src: path.relative(ROOT, item.src) };
  });

  // remove the temp _ours frames so only neutral item-NN remain visible
  for (const p of ours) fs.rmSync(p, { force: true });

  const keyPath = path.join(outDir, 'ANSWER-KEY.sealed.json');
  fs.writeFileSync(keyPath, JSON.stringify({
    note: 'Do NOT open until after judging. Maps blind item -> origin.',
    key: items,
  }, null, 2));

  const readme = [
    'BLIND COMPARE SET',
    '=================',
    `Items: ${items.length} (mix of OUR render frames and the reference bar).`,
    'Open every item-NN image. For each, decide: does this look like a frame from a',
    'professional property walkthrough a listing agent would send a high-end client?',
    'Rank them. Only after ranking, open ANSWER-KEY.sealed.json to see which were ours.',
    'OURS WINS ONLY IF our frames are picked over the reference frames blind.',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'README.txt'), readme);

  return { dir: path.relative(ROOT, outDir), items, keyPath: path.relative(ROOT, keyPath) };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
}
function round(v) { return Math.round(v * 1000) / 1000; }

if (require.main === module) {
  const res = build({ n: Number(process.argv[2]) || 6 });
  console.log(`Blind set -> ${res.dir} (${res.items.length} items). Key: ${res.keyPath}`);
}

module.exports = { build };
