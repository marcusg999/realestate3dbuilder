'use strict';
// Maps the transitions piece knobs onto ffmpeg xfade transition names.
// hard_cut is handled by concatenation (no xfade); the rest use xfade.

const XFADE = {
  dissolve: 'fade',
  whip_pan_match: 'slideleft',
  through_doorway_match: 'smoothleft',
};

// Returns { kind: 'cut' } or { kind: 'xfade', transition, durationSec }.
function resolve(transition) {
  const type = (transition && transition.type) || 'hard_cut';
  const durationSec = (transition && transition.durationSec) || 0;
  if (type === 'hard_cut' || durationSec <= 0) return { kind: 'cut' };
  return { kind: 'xfade', transition: XFADE[type] || 'fade', durationSec };
}

module.exports = { resolve, XFADE };
