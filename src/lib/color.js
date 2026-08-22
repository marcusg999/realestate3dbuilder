'use strict';
// Lighting/color-consistency piece. Two responsibilities:
//  1) Normalize each clip toward a common look (so clips match across rooms).
//  2) Provide a measurable delta the critic can track between rounds.
//
// The normalization filter is intentionally conservative (eq only) so it never
// introduces artifacts of its own; strength scales the correction.

// Build an eq filter that nudges a clip toward target stats.
// params: { strength (0..1), brightness, contrast, saturation, gamma }
function normalizeFilter(params = {}) {
  const s = clamp(params.strength ?? 0.7, 0, 1);
  const brightness = lerp(0, params.brightness ?? 0, s);
  const contrast = lerp(1, params.contrast ?? 1, s);
  const saturation = lerp(1, params.saturation ?? 1, s);
  const gamma = lerp(1, params.gamma ?? 1, s);
  return `eq=brightness=${round(brightness)}:contrast=${round(contrast)}:saturation=${round(saturation)}:gamma=${round(gamma)}`;
}

// signalstats parse helper — caller runs ffprobe/ffmpeg with signalstats and
// passes YAVG/etc here to compute a correction toward the anchor clip.
function correctionToward(anchorStats, clipStats, strength = 0.7) {
  // Simple luma/chroma match. Values are 0..255 (YAVG) and chroma averages.
  const brightness = ((anchorStats.YAVG - clipStats.YAVG) / 255) * strength;
  const contrast = anchorStats.YDIF && clipStats.YDIF
    ? 1 + ((anchorStats.YDIF - clipStats.YDIF) / (clipStats.YDIF || 1)) * 0.5 * strength
    : 1;
  return { strength: 1, brightness, contrast, saturation: 1, gamma: 1 };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function round(v) { return Math.round(v * 1000) / 1000; }

module.exports = { normalizeFilter, correctionToward };
