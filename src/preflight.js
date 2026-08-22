'use strict';
// Preflight: the gate that decides whether the pipeline can run for real.
// Codifies the manual check "are the inputs actually present?" so that when
// assets land, `node src/preflight.js` flips inputsReady -> true and the
// gauntlet can start. Until then it reports exactly what is missing.

const fs = require('fs');
const path = require('path');
const { ROOT, loadConfig, abs } = require('./lib/config');
const ffmpeg = require('./lib/ffmpeg');

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

function countImages(dir) {
  const d = abs(dir);
  if (!fs.existsSync(d)) return 0;
  return fs.readdirSync(d).filter((f) => IMAGE_RE.test(f)).length;
}

function check() {
  const cfg = loadConfig();
  const p = cfg.paths;
  const results = [];
  const add = (name, ok, detail, blocker = true) =>
    results.push({ name, ok, detail, blocker });

  // The quality bar
  const refCount = countImages(p.referenceFrames);
  add('Reference frames (quality bar)', refCount > 0,
    refCount > 0 ? `${refCount} frame(s) in ${p.referenceFrames}` :
    `none in ${p.referenceFrames} — critic cannot compare against the bar`);

  const matterportFile = abs(p.matterportUrlFile);
  const hasMatterport = fs.existsSync(matterportFile) &&
    fs.readFileSync(matterportFile, 'utf8').trim().length > 0;
  add('Matterport sample URL', hasMatterport,
    hasMatterport ? 'present' : `add a sample URL to ${p.matterportUrlFile}`, false);

  // Build inputs
  const photoCount = countImages(p.listingPhotos);
  add('Listing photos (source imagery)', photoCount > 0,
    photoCount > 0 ? `${photoCount} photo(s)` : `none in ${p.listingPhotos} — nothing to animate`);

  const floorCount = countImages(p.floorplan) +
    (fs.existsSync(abs(p.floorplan)) ? fs.readdirSync(abs(p.floorplan)).filter((f) => /\.pdf$/i.test(f)).length : 0);
  add('Floor plan', floorCount > 0,
    floorCount > 0 ? `${floorCount} file(s)` : `none in ${p.floorplan}`, false);

  const storyboard = abs(p.storyboard);
  const hasStoryboard = fs.existsSync(storyboard);
  add('Approved storyboard', hasStoryboard,
    hasStoryboard ? p.storyboard : `missing ${p.storyboard} (see inputs/storyboard.example.json)`);

  // Tooling
  add('ffmpeg + ffprobe', ffmpeg.available(),
    ffmpeg.available() ? 'resolved' : 'install ffmpeg or set FFMPEG_BIN');

  const blockers = results.filter((r) => r.blocker && !r.ok);
  const inputsReady = blockers.length === 0;
  return { inputsReady, results, blockers };
}

function format(report) {
  const lines = [];
  lines.push(report.inputsReady
    ? '✅ Preflight PASSED — inputs ready. The gauntlet can run.'
    : '⛔ Preflight BLOCKED — missing required inputs (see below).');
  lines.push('');
  for (const r of report.results) {
    const icon = r.ok ? '✅' : (r.blocker ? '❌' : '⚠️ ');
    lines.push(`  ${icon} ${r.name}: ${r.detail}`);
  }
  if (!report.inputsReady) {
    lines.push('');
    lines.push('Add the missing inputs, then re-run: node src/preflight.js');
  }
  return lines.join('\n');
}

if (require.main === module) {
  const report = check();
  // Persist into state.json so the progress page reflects readiness.
  try {
    const state = require('./lib/state');
    const s = state.load();
    s.inputsReady = report.inputsReady;
    s.preflight = report;
    state.save(s);
  } catch (e) { /* non-fatal */ }
  console.log(format(report));
  process.exit(report.inputsReady ? 0 : 1);
}

module.exports = { check, format };
