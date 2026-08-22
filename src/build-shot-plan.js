'use strict';
// Turns the approved storyboard into an ordered list of Higgsfield generation
// specs — one per shot. This is the bridge between "what to shoot" (storyboard)
// and "how to generate it" (Higgsfield MCP generate_video inputs).
//
// The orchestrating agent reads work/shot-plan.json and, for each shot, invokes
// the Higgsfield MCP tool with spec.higgsfield, saving the returned clip to
// work/clips/<id>.mp4. No generation happens here — this only builds the specs.

const fs = require('fs');
const path = require('path');
const { ROOT, abs, loadConfig } = require('./lib/config');

// Motion preset -> natural-language camera direction for the video prompt.
const MOTION_PROMPT = {
  dolly_in: 'slow smooth dolly forward into the room, steadicam, constant speed',
  dolly_out: 'slow smooth dolly backward, steadicam, constant speed',
  push_in: 'gentle push-in toward the hero feature, gimbal-stable',
  pull_back: 'gentle pull-back revealing the full space, gimbal-stable',
  orbit_left: 'slow orbit to the left around the room center, level horizon',
  orbit_right: 'slow orbit to the right around the room center, level horizon',
  crane_up: 'smooth crane up, revealing ceiling height, verticals true',
  crane_down: 'smooth crane down to eye level, verticals true',
  reveal: 'slow forward reveal through the doorway into the space',
  track_forward: 'smooth forward tracking shot down the room, steadicam',
};

function buildSpec(shot, cfg) {
  const motionPreset = shot.motion?.preset || 'dolly_in';
  const speed = shot.motion?.speed ?? 0.8;
  const intensity = shot.motion?.intensity ?? 0.5;
  const composition = shot.framing?.compositionPrompt || '';
  const cameraLine = MOTION_PROMPT[motionPreset] || MOTION_PROMPT.dolly_in;

  const prompt = [
    'Professional real-estate walkthrough of a luxury home.',
    cameraLine + '.',
    composition ? composition + '.' : '',
    'Photorealistic, natural interior lighting, no people, no warping, straight lines stay straight, cinematic but restrained.',
  ].filter(Boolean).join(' ');

  return {
    id: shot.id,
    room: shot.room,
    sourcePhoto: shot.sourcePhoto,
    durationSec: shot.durationSec,
    isHero: Boolean(shot.isHero),
    caption: shot.caption || null,
    transitionIn: shot.transitionIn || { type: 'hard_cut', durationSec: 0 },
    // Direct input for Higgsfield MCP generate_video (image-to-video).
    higgsfield: {
      startImage: shot.sourcePhoto,
      prompt,
      motion: { preset: motionPreset, speed, intensity },
      seconds: cfg.higgsfield?.clipSeconds ?? 5,
      aspect: cfg.higgsfield?.aspect ?? '16:9',
      modelHint: cfg.higgsfield?.videoModelHint ?? 'recommend at runtime',
    },
    // Where the orchestrator must save the returned clip.
    outClip: path.join('work', 'clips', `${shot.id}.mp4`),
  };
}

function build(storyboardPath) {
  const cfg = loadConfig();
  const sbPath = storyboardPath || cfg.paths.storyboard;
  const sb = JSON.parse(fs.readFileSync(abs(sbPath), 'utf8'));
  const plan = {
    listingId: sb.listingId,
    propertySize: sb.propertySize,
    brand: sb.brand || null,
    musicBed: sb.musicBed || null,
    shots: sb.shots.map((s) => buildSpec(s, cfg)),
  };
  return plan;
}

if (require.main === module) {
  const sbArg = process.argv[2];
  const plan = build(sbArg);
  const outDir = abs('work');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'shot-plan.json');
  fs.writeFileSync(out, JSON.stringify(plan, null, 2));
  console.log(`Wrote ${plan.shots.length} shot spec(s) -> ${path.relative(ROOT, out)}`);
  console.log('Next: for each shot, call Higgsfield generate_video with spec.higgsfield, save to spec.outClip.');
}

module.exports = { build, buildSpec, MOTION_PROMPT };
