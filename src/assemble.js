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
// Deterministic de-shake with ffmpeg vid.stab (two passes). Removes the
// residual jitter AI image-to-video leaves in, regardless of the prompt. Auto-
// zoom hides the stabilization borders so there are no black edges. Returns the
// stabilized clip path (or the original if stabilization is disabled).
function stabilizeClip(clip, id, cfg) {
  const s = cfg.stabilize;
  if (!s || s.enabled === false) return clip;
  const v = cfg.video;
  const dir = abs('work/stab');
  fs.mkdirSync(dir, { recursive: true });
  const trf = path.join(dir, `${id}.trf`);
  const out = path.join(dir, `${id}.mp4`);
  // Pass 1: analyze motion.
  ffmpeg(['-y', '-i', clip, '-vf',
    `vidstabdetect=shakiness=${s.shakiness ?? 8}:accuracy=${s.accuracy ?? 15}:result=${trf}`,
    '-f', 'null', '-']);
  // Pass 2: apply smoothing (+ light unsharp to recover softness from the zoom).
  ffmpeg(['-y', '-i', clip, '-vf',
    `vidstabtransform=input=${trf}:smoothing=${s.smoothing ?? 24}:optzoom=1:zoom=0:crop=black,unsharp=5:5:0.6:3:3:0.3`,
    '-an', '-c:v', v.codec, '-crf', String(v.crf), '-preset', v.preset, '-pix_fmt', v.pixFmt, out]);
  return out;
}

function buildSegment(shot, cfg, opts) {
  const v = cfg.video;
  const clip = abs(shot.outClip);
  if (!fs.existsSync(clip)) throw new Error(`missing rendered clip for shot '${shot.id}': ${clip}`);

  const segDir = abs('work/graded');
  fs.mkdirSync(segDir, { recursive: true });
  const segPath = path.join(segDir, `${shot.id}.mp4`);

  const src = stabilizeClip(clip, shot.id, cfg);

  const vf = [
    `scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease`,
    `pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${v.fps}`,
  ];

  // Color consistency knob
  const colorParams = (opts.colorByShot && opts.colorByShot[shot.id]) || null;
  if (colorParams) vf.push(normalizeFilter(colorParams));

  // Per-room captions are OFF by default (config.drawRoomCaptions). The only
  // on-screen text is the closing end card.
  if (cfg.drawRoomCaptions && shot.caption && shot.caption.text && shot.caption.style !== 'none') {
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
    '-y', '-i', src,
    '-t', String(shot.durationSec),
    '-vf', vf.join(','),
    '-an',
    '-c:v', v.codec, '-crf', String(v.crf), '-preset', v.preset, '-pix_fmt', v.pixFmt,
    segPath,
  ];
  ffmpeg(args);
  return { id: shot.id, path: segPath, dur: shot.durationSec, transitionIn: shot.transitionIn };
}

// Closing end card: a branded slate with the listing agent / price / address.
// Text is written to files and referenced via drawtext textfile= so commas,
// apostrophes and $ need no escaping. Rendered as its own segment.
function buildEndCard(endCard, cfg) {
  const v = cfg.video;
  const dur = endCard.durationSec ?? 5;
  const bg = endCard.bg || (cfg.brand && cfg.brand.primaryColor) || '#0b0e13';
  const font = cfg.captionFont;
  const dir = abs('work/graded');
  fs.mkdirSync(dir, { recursive: true });

  const agentLine = endCard.agent
    ? `${endCard.agent}${endCard.phone ? '   •   Contact: ' + endCard.phone : ''}`
    : (endCard.lines && endCard.lines[0]) || '';
  const price = endCard.price || (endCard.lines && endCard.lines[1]) || '';
  const address = endCard.address || (endCard.lines && endCard.lines[2]) || '';

  const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, String(text)); return p; };
  const fAgent = write('__ec_agent.txt', agentLine);
  const fPrice = write('__ec_price.txt', price);
  const fAddr = write('__ec_addr.txt', address);

  // Background image of the home. Falls back to a flat brand slate if none.
  const homeImg = endCard.image && fs.existsSync(abs(endCard.image)) ? abs(endCard.image) : null;
  const P = { w: 1240, h: 480, x: (v.width - 1240) / 2, y: (v.height - 480) / 2 - 12, r: 44 };
  const f = (n) => path.join(dir, n);

  if (homeImg) {
    // Frosted-glass card over a photo of the home (multi-pass ffmpeg).
    ffmpeg(['-y', '-i', homeImg, '-vf', `scale=${v.width}:${v.height}:force_original_aspect_ratio=increase,crop=${v.width}:${v.height},eq=brightness=-0.05:saturation=1.06`, '-frames:v', '1', f('__ec_bg.png')]);
    ffmpeg(['-y', '-i', f('__ec_bg.png'), '-vf', 'gblur=sigma=30,eq=brightness=0.05', '-frames:v', '1', f('__ec_blur.png')]);
    ffmpeg(['-y', '-i', f('__ec_blur.png'), '-vf', `crop=${P.w}:${P.h}:${P.x}:${P.y}`, '-frames:v', '1', f('__ec_crop.png')]);
    ffmpeg(['-y', '-i', f('__ec_crop.png'), '-f', 'lavfi', '-i', `color=white:s=${P.w}x${P.h}`, '-filter_complex', '[1]format=rgba,colorchannelmixer=aa=0.55[w];[0][w]overlay,format=rgb24', '-frames:v', '1', f('__ec_tint.png')]);
    ffmpeg(['-y', '-f', 'lavfi', '-i', `color=black:s=${P.w}x${P.h}`, '-vf', `format=gray,geq=lum='236*lte(hypot(X-clip(X,${P.r},${P.w - P.r}),Y-clip(Y,${P.r},${P.h - P.r})),${P.r})'`, '-frames:v', '1', f('__ec_mask.png')]);
    ffmpeg(['-y', '-i', f('__ec_tint.png'), '-i', f('__ec_mask.png'), '-filter_complex', '[0][1]alphamerge', '-frames:v', '1', f('__ec_panel.png')]);
    ffmpeg(['-y', '-i', f('__ec_mask.png'), '-vf', 'gblur=sigma=18', '-frames:v', '1', f('__ec_smask.png')]);
    ffmpeg(['-y', '-f', 'lavfi', '-i', `color=black:s=${P.w}x${P.h}`, '-i', f('__ec_smask.png'), '-filter_complex', '[0][1]alphamerge,format=rgba,colorchannelmixer=aa=0.45', '-frames:v', '1', f('__ec_shadow.png')]);
    ffmpeg(['-y', '-i', f('__ec_bg.png'), '-i', f('__ec_shadow.png'), '-i', f('__ec_panel.png'), '-filter_complex', `[0][1]overlay=${P.x}:${P.y + 12}[a];[a][2]overlay=${P.x}:${P.y}[b]`, '-map', '[b]', '-frames:v', '1', f('__ec_comp.png')]);
    const dt = [
      `drawtext=fontfile=${font}:textfile=${fPrice}:fontcolor=0x0e1116:fontsize=100:x=(w-tw)/2:y=(h-th)/2`,
      `drawtext=fontfile=${font}:textfile=${fAgent}:fontcolor=0x1c2530:fontsize=44:x=(w-tw)/2:y=h/2-132`,
      `drawtext=fontfile=${font}:textfile=${fAddr}:fontcolor=0x33404f:fontsize=38:x=(w-tw)/2:y=h/2+98`,
      'fade=t=in:st=0:d=0.6',
    ].join(',');
    const seg = f('__endcard.mp4');
    ffmpeg(['-y', '-loop', '1', '-t', String(dur), '-i', f('__ec_comp.png'), '-vf', `${dt},fps=${v.fps},format=${v.pixFmt}`,
      '-an', '-c:v', v.codec, '-crf', String(v.crf), '-preset', v.preset, seg]);
    return { id: '__endcard', path: seg, dur, transitionIn: { type: 'dissolve', durationSec: 0.6 } };
  }

  // Fallback: flat brand slate with white text (no home image available).
  const dt = [
    `drawtext=fontfile=${font}:textfile=${fPrice}:fontcolor=white:fontsize=104:x=(w-tw)/2:y=(h-th)/2`,
    `drawtext=fontfile=${font}:textfile=${fAgent}:fontcolor=0xF2F2F2:fontsize=46:x=(w-tw)/2:y=h/2-120`,
    `drawtext=fontfile=${font}:textfile=${fAddr}:fontcolor=0xB9C0CC:fontsize=40:x=(w-tw)/2:y=h/2+96`,
    'fade=t=in:st=0:d=0.6',
  ].join(',');
  const seg = f('__endcard.mp4');
  ffmpeg(['-y', '-f', 'lavfi', '-i', `color=c=${bg}:s=${v.width}x${v.height}:d=${dur}:r=${v.fps}`,
    '-vf', dt, '-an', '-c:v', v.codec, '-crf', String(v.crf), '-preset', v.preset, '-pix_fmt', v.pixFmt, seg]);
  return { id: '__endcard', path: seg, dur, transitionIn: { type: 'dissolve', durationSec: 0.6 } };
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
  cfg.brand = plan.brand || cfg.brand; // let the end card read the brand color
  const segments = shots.map((s) => buildSegment(s, cfg, opts));

  // Closing end card (agent / price / address), if the listing provides one.
  // Default its background to the opening/hero photo of the home.
  const endCard = opts.endCard || plan.endCard;
  if (endCard) {
    if (!endCard.image && shots.length) endCard.image = shots[0].sourcePhoto;
    segments.push(buildEndCard(endCard, cfg));
  }

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
