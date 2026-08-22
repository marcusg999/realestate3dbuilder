'use strict';
const { spawnSync } = require('child_process');
const { resolveFfmpeg } = require('./config');

// Thin wrappers around the resolved ffmpeg/ffprobe binaries.
function run(bin, args, { quiet = true } = {}) {
  if (!bin) throw new Error('ffmpeg/ffprobe not found. Install ffmpeg or set FFMPEG_BIN / config/pipeline.config.json.');
  const res = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || '').split('\n').slice(-20).join('\n');
    throw new Error(`ffmpeg failed (${res.status}): ${bin} ${args.join(' ')}\n${msg}`);
  }
  if (!quiet && res.stderr) process.stderr.write(res.stderr);
  return res.stdout;
}

function ffmpeg(args, opts) {
  const { ffmpeg } = resolveFfmpeg();
  return run(ffmpeg, args, opts);
}

function ffprobe(args, opts) {
  const { ffprobe } = resolveFfmpeg();
  return run(ffprobe, args, opts);
}

// Duration in seconds of a media file.
function durationSec(file) {
  const out = ffprobe([
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]);
  return parseFloat(out.trim());
}

function available() {
  const { ffmpeg, ffprobe } = resolveFfmpeg();
  return Boolean(ffmpeg && ffprobe);
}

module.exports = { ffmpeg, ffprobe, durationSec, available };
