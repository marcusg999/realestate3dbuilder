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
// Bias toward DYNAMIC lateral movement (trucking / sideways dolly, arcing)
// rather than only pushing straight forward — it makes the space read as 3D.
// Every line describes a fluid, motorized-dolly / gimbal move; the shared
// stabilization clause in buildSpec enforces "no shake".
const MOTION_PROMPT = {
  dolly_in: 'the camera glides forward into the room on a motorized dolly while drifting gently to one side, revealing depth, constant slow speed',
  dolly_out: 'the camera glides smoothly backward on a motorized dolly, easing to one side to open up the space, constant slow speed',
  push_in: 'the camera pushes in slowly toward the hero feature while trucking a touch sideways, parallax revealing the room in three dimensions',
  pull_back: 'the camera pulls back smoothly and arcs slightly to the side, gradually revealing the full space',
  orbit_left: 'the camera arcs left in a slow, wide semicircle around the room, sweeping laterally past foreground into depth, level horizon',
  orbit_right: 'the camera arcs right in a slow, wide semicircle around the room, sweeping laterally past foreground into depth, level horizon',
  truck_left: 'the camera trucks smoothly to the left, sliding sideways across the room to sweep the space, level horizon',
  truck_right: 'the camera trucks smoothly to the right, sliding sideways across the room to sweep the space, level horizon',
  crane_up: 'the camera cranes up smoothly while drifting forward, revealing ceiling height, verticals true',
  crane_down: 'the camera cranes down smoothly to eye level while easing sideways, verticals true',
  reveal: 'the camera slides laterally through the doorway and arcs into the space, a smooth reveal with strong parallax',
  track_forward: 'the camera tracks forward down the room on rails while gently weaving side to side, fluid Steadicam glide',
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
    // Stabilization + realism clause on EVERY shot. The camera-shake and
    // warping language here is deliberate and load-bearing — keep it.
    'Locked-off gimbal on a fluid motorized dolly: perfectly smooth, stabilized motion, rock steady, absolutely no camera shake, no handheld jitter, no wobble, constant velocity with gentle ease-in and ease-out.',
    'Photorealistic, natural interior lighting, no people, no warping, straight lines stay straight, walls and furniture do not bend, cinematic and restrained.',
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
