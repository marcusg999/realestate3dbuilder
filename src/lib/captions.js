'use strict';
// Builds ffmpeg drawtext filter fragments for the caption / lower-third piece.
// Tunable via config/pieces.json -> captions.knobs. Kept as pure string builders so
// the critic can diff exact styling between rounds.

function escapeText(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019");
}

// position -> (x,y) expressions inside title-safe margins (5%).
function pos(position, sizeExpr) {
  const margin = 'w*0.05';
  switch (position) {
    case 'bottom_center': return { x: '(w-text_w)/2', y: `h-0.10*h` };
    case 'top_left': return { x: margin, y: 'h*0.06' };
    case 'bottom_left':
    default: return { x: margin, y: 'h-0.14*h' };
  }
}

// style: minimal_lower_third | corner_label | none
// opts: { text, style, sizePct, position, font, fade:{inSec,outSec,holdSec}, startSec, primaryColor }
function drawtext(opts) {
  const {
    text, style = 'minimal_lower_third', sizePct = 3.2, position = 'bottom_left',
    font = null, fade = { inSec: 0.3, outSec: 0.3, holdSec: 2.0 }, startSec = 0.4,
    videoHeight = 1080,
  } = opts;
  if (!text || style === 'none') return null;

  const fontsize = Math.round((sizePct / 100) * videoHeight);
  const { x, y } = pos(position);
  const tIn = startSec;
  const tHold = tIn + (fade.inSec || 0.3);
  const tOut = tHold + (fade.holdSec || 2.0);
  const tEnd = tOut + (fade.outSec || 0.3);

  // Smooth alpha envelope: fade in, hold, fade out.
  const alpha =
    `if(lt(t,${tIn}),0,` +
    `if(lt(t,${tHold}),(t-${tIn})/${(fade.inSec || 0.3)},` +
    `if(lt(t,${tOut}),1,` +
    `if(lt(t,${tEnd}),1-(t-${tOut})/${(fade.outSec || 0.3)},0))))`;

  const parts = [
    `text='${escapeText(text)}'`,
    `x=${x}`, `y=${y}`,
    `fontsize=${fontsize}`,
    `fontcolor=white@1.0`,
    `alpha='${alpha}'`,
    `shadowcolor=black@0.6`, `shadowx=2`, `shadowy=2`,
  ];
  if (font) parts.push(`fontfile=${font}`);
  if (style === 'minimal_lower_third') {
    // subtle backing box for legibility over bright rooms
    parts.push('box=1', 'boxcolor=black@0.28', 'boxborderw=28');
  }
  return `drawtext=${parts.join(':')}`;
}

module.exports = { drawtext };
