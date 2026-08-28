'use strict';
// Final assembly engine. Consumes rendered clips (work/clips/<id>.mp4) named by
// the shot plan and produces the assembled walkthrough (output/walkthrough.mp4).
//
// Pipeline per run:
//   1) Per-shot segment pass: scale/pad to WxH, set fps, trim to storyboard
//      duration (pacing), color-normalize (consistency), burn caption.
//   2) Stitch pass: hard cuts -> concat; any timed transition -> xfade chain.
//   3) Optional music bed with fades.
//
// Everything is driven by the shot plan + config, so each judgeable piece
// (pacing, color, captions, transitions, assembly) maps to real knobs here.

const fs = require('fs');
const path = require('path');
const { ROOT, abs, loadConfig, loadPieces } = require('./lib/config');
const { ffmpeg, durationSec } = require('./lib/ffmpeg');
const { drawtext } = require('./lib/captions');
const { resolve: resolveTransition } = require('./lib/transitions');
const { normalizeFilter } = require('./lib/color');

function pieceParams(id) {
  const pieces = loadPieces().pieces;
  const p = pieces.find((x) => x.id === id);
  return (p && p.knobs) || {};
}

function loadShotPlan(planPath) {
  const p = abs(planPath || 'work/shot-plan.json');
  if (!fs.existsSync(p)) throw new Error(`shot plan not found: ${p} (run: node src/build-shot-plan.js)`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---- Stage 1: build one normalized segment per shot ----
function buildSegment(shot, cfg, opts) {
  const v = cfg.video;
  const clip = abs(shot.outClip);
  if (!fs.existsSync(clip)) throw new Error(`missing rendered clip for shot '${shot.id}': ${clip}`);

  const segDir = abs('work/graded');
  fs.mkdirSync(segDir, { recursive: true });
  const segPath = path.join(segDir, `${shot.id}.mp4`);

  const vf = [
    `scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease`,
    `pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${v.fps}`,
  ];

  // Color consistency knob
  const colorParams = (opts.colorByShot && opts.colorByShot[shot.id]) || null;
  if (colorParams) vf.push(normalizeFilter(colorParams));

  // Caption knob
  if (shot.caption && shot.caption.text && shot.caption.style !== 'none') {
    const capCfg = pieceParams('captions');
    const dt = drawtext({
      text: shot.caption.text,
      style: shot.caption.style || 'minimal_lower_third',
      sizePct: capCfg.sizePct?.default ?? 3.2,
      position: (capCfg.position && capCfg.position[0]) || 'bottom_left',
      font: cfg.captionFont || null,
      videoHeight: v.height,
    });
    if (dt) vf.push(dt);
  }

  const args = [
    '-y', '-i', clip,
    '-t', String(shot.durationSec),
    '-vf', vf.join(','),
    '-an',
    '-c:v', v.codec, '-crf', String(v.crf), '-preset', v.preset, '-pix_fmt', v.pixFmt,
    segPath,
  ];
  ffmpeg(args);
  return { id: shot.id, path: segPath, dur: shot.durationSec, transitionIn: shot.transitionIn };
}

// ---- Stage 2a: concat (all hard cuts) ----
function stitchConcat(segments, cfg, outPath) {
  const listFile = path.join(abs('work'), 'concat.txt');
  fs.writeFileSync(listFile, segments.map((s) => `file '${s.path}'`).join('\n'));
  ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath]);
}

// ---- Stage 2b: xfade chain (mixed / timed transitions) ----
function stitchXfade(segments, cfg, outPath) {
  const v = cfg.video;
  // A hard cut inside an otherwise-timed xfade chain is done as a very short
  // xfade. It must be at least a few frames long: a sub-frame duration
  // (e.g. 1/fps) makes ffmpeg's xfade drop the second input and truncate the
  // whole chain at that point. 0.1s reads as an instant cut but keeps the
  // chain's timing correct.
  const cutDur = Math.max(3 / v.fps, 0.1);
  const inputs = [];
  segments.forEach((s) => { inputs.push('-i', s.path); });

  const filters = [];
  let prevLabel = '0:v';
  let cumulative = segments[0].dur;
  for (let i = 1; i < segments.length; i++) {
    const tr = resolveTransition(segments[i].transitionIn);
    const d = tr.kind === 'cut' ? cutDur : tr.durationSec;
    const transition = tr.kind === 'cut' ? 'fade' : tr.transition;
    const offset = Math.max(0, cumulative - d);
    const out = i === segments.length - 1 ? 'outv' : `v${i}`;
    filters.push(`[${prevLabel}][${i}:v]xfade=transition=${transition}:duration=${round(d)}:offset=${round(offset)}[${out}]`);
    prevLabel = out;
    cumulative = cumulative + segments[i].dur - d;
  }

  const args = ['-y', ...inputs, '-filter_complex', filters.join(';'),
    '-map', '[outv]', '-c:v', v.codec, '-crf', String(v.crf), '-preset', v.preset,
    '-pix_fmt', v.pixFmt, outPath];
  ffmpeg(args);
}

// ---- Stage 3: music bed ----
function addMusic(videoPath, musicPath, cfg, outPath) {
  const total = durationSec(videoPath);
  const a = cfg.audio;
  const fadeOutStart = Math.max(0, total - (a.fadeOutSec || 2));
  const af = [
    `volume=${dbToLinear(a.musicGainDb ?? -18)}`,
    `afade=t=in:st=0:d=${a.fadeInSec ?? 1}`,
    `afade=t=out:st=${round(fadeOutStart)}:d=${a.fadeOutSec ?? 2}`,
  ].join(',');
  ffmpeg([
    '-y', '-i', videoPath, '-stream_loop', '-1', '-i', abs(musicPath),
    '-filter_complex', `[1:a]${af}[aout]`,
    '-map', '0:v', '-map', '[aout]', '-shortest',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', outPath,
  ]);
}

// Which shots don't yet have a rendered clip on disk.
function missingClips(shots) {
  return shots.filter((s) => !fs.existsSync(abs(s.outClip)));
}

function assemble(opts = {}) {
  const cfg = loadConfig();
  const plan = loadShotPlan(opts.planPath);
  const shots = plan.shots;
  if (!shots.length) throw new Error('shot plan has no shots');

  // Pre-check ALL clips up front, so we report every missing one at once with
  // clear next steps — rather than dying on the first shot with a stack trace.
  const missing = missingClips(shots);
  if (missing.length) {
    const list = missing.map((s) => `  - ${s.id} -> ${s.outClip}`).join('\n');
    throw new Error(
      `Not ready to assemble: ${missing.length} of ${shots.length} shot clip(s) haven't been generated yet.\n\n` +
      `Missing clips:\n${list}\n\n` +
      `Generate them first, then assemble:\n` +
      `  • Real clips: have the agent run Higgsfield for each shot in work/shot-plan.json\n` +
      `    (use spec.higgsfield, save the result to spec.outClip). Clip generation is not done\n` +
      `    by this dashboard.\n` +
      `  • Local test footage (no assets/credits): run  npm run dev:clips  then assemble again.`
    );
  }

  // Stage 1
  const segments = shots.map((s) => buildSegment(s, cfg, opts));

  // Stage 2
  fs.mkdirSync(abs(cfg.paths.output), { recursive: true });
  const anyTimed = segments.some((s, i) => i > 0 && resolveTransition(s.transitionIn).kind === 'xfade');
  const stitched = anyTimed ? abs('work/stitched.mp4') : abs(cfg.paths.assembledVideo);
  if (anyTimed) stitchXfade(segments, cfg, stitched);
  else stitchConcat(segments, cfg, stitched);

  // Stage 3
  const music = opts.musicBed || plan.musicBed || cfg.audio.musicBed;
  const finalPath = abs(cfg.paths.assembledVideo);
  if (music && fs.existsSync(abs(music))) {
    addMusic(stitched, music, cfg, finalPath);
  } else if (stitched !== finalPath) {
    fs.copyFileSync(stitched, finalPath);
  }

  const total = durationSec(finalPath);
  return { output: finalPath, totalSec: round(total), shots: segments.length };
}

function dbToLinear(db) { return round(Math.pow(10, db / 20)); }
function round(v) { return Math.round(v * 1000) / 1000; }

if (require.main === module) {
  try {
    const res = assemble();
    console.log(`Assembled ${res.shots} shot(s) -> ${path.relative(ROOT, res.output)} (${res.totalSec}s)`);
  } catch (err) {
    console.error('\n' + err.message + '\n');
    process.exit(1);
  }
}

module.exports = { assemble, buildSegment, missingClips };
