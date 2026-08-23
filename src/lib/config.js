'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// Minimal .env loader (no dependency). Loads ROOT/.env once, without overriding
// vars already set in the environment. Keeps API keys out of shell history.
(function loadDotEnv() {
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* non-fatal */ }
})();

function loadJson(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function abs(rel) {
  if (!rel) return rel;
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

function which(bin) {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf8',
    }).trim().split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

// Resolve ffmpeg/ffprobe: env -> config -> PATH. Returns { ffmpeg, ffprobe } (may be null).
function resolveFfmpeg(config) {
  const cfg = config || loadConfig();
  const ffmpeg =
    process.env.FFMPEG_BIN || cfg.ffmpegBin || which('ffmpeg');
  const ffprobe =
    process.env.FFPROBE_BIN || cfg.ffprobeBin || which('ffprobe');
  return { ffmpeg: ffmpeg || null, ffprobe: ffprobe || null };
}

let _config = null;
function loadConfig() {
  if (!_config) _config = loadJson('config/pipeline.config.json');
  return _config;
}

function loadPieces() {
  return loadJson('config/pieces.json');
}

module.exports = { ROOT, loadJson, abs, which, resolveFfmpeg, loadConfig, loadPieces };
