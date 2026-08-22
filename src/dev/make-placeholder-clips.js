'use strict';
// DEV ONLY — generates local ffmpeg test clips (NOT Higgsfield, no credits) so
// the assembly + compare pipeline can be exercised end-to-end without any assets.
// These are throwaway color/gradient clips labeled with the room name. Real runs
// replace work/clips/<id>.mp4 with Higgsfield renders.

const fs = require('fs');
const path = require('path');
const { abs, loadConfig } = require('../lib/config');
const { ffmpeg } = require('../lib/ffmpeg');
const { build } = require('../build-shot-plan');

const COLORS = ['0x1f2937', '0x334155', '0x475569', '0x1e3a5f', '0x3f3f46', '0x27303f'];

function make(storyboardPath) {
  const cfg = loadConfig();
  const plan = build(storyboardPath || 'inputs/storyboard.example.json');
  const dir = abs('work/clips');
  fs.mkdirSync(dir, { recursive: true });
  const v = cfg.video;

  plan.shots.forEach((shot, i) => {
    const color = COLORS[i % COLORS.length];
    const dur = Math.max(shot.durationSec + 1, 6); // a bit longer than needed so trims work
    const out = path.join(dir, `${shot.id}.mp4`);
    // gradient + slow drift + room label, so frames are visually distinct per shot
    const vf = `drawtext=text='${(shot.room || shot.id).replace(/'/g, '')} [PLACEHOLDER]':fontcolor=white@0.85:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2`;
    ffmpeg([
      '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${v.width}x${v.height}:d=${dur}:r=${v.fps}`,
      '-vf', vf, '-c:v', v.codec, '-crf', '20', '-preset', 'ultrafast', '-pix_fmt', v.pixFmt,
      '-t', String(dur), out,
    ]);
    process.stdout.write(`  clip: ${shot.id}.mp4 (${dur}s)\n`);
  });
  console.log(`Generated ${plan.shots.length} placeholder clip(s) in work/clips/`);
}

if (require.main === module) make(process.argv[2]);
module.exports = { make };
