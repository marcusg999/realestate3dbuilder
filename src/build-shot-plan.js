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
  dolly_in: 'flies slowly and smoothly forward, gliding deeper into the space',
  dolly_out: 'drifts slowly and smoothly backward, opening up the space',
  push_in: 'pushes in slowly and smoothly toward the focal point',
  pull_back: 'drifts slowly backward and eases slightly to one side, smoothly revealing the full space',
  orbit_left: 'arcs slowly to the left in a smooth, wide sweep around the space, level horizon',
  orbit_right: 'arcs slowly to the right in a smooth, wide sweep around the space, level horizon',
  truck_left: 'glides smoothly sideways to the left across the space, level horizon',
  truck_right: 'glides smoothly sideways to the right across the space, level horizon',
  crane_up: 'cranes up smoothly while drifting forward, revealing the height of the space, verticals true',
  crane_down: 'cranes down smoothly to eye level while easing forward, verticals true',
  // Arrival shot: a forward push that ENDS at the front door / threshold.
  reveal: 'flies slowly forward up the walkway and arrives right at the front door, a smooth gliding forward push that ends at the threshold, moving forward the whole time',
  track_forward: 'tracks slowly and smoothly forward through the space, a fluid gliding move',
};

function buildSpec(shot, cfg) {
  const motionPreset = shot.motion?.preset || 'dolly_in';
  const speed = shot.motion?.speed ?? 0.8;
  const intensity = shot.motion?.intensity ?? 0.5;
  const composition = shot.framing?.compositionPrompt || '';
  const cameraLine = MOTION_PROMPT[motionPreset] || MOTION_PROMPT.dolly_in;

  const prompt = [
    // Framed as a professional drone/gimbal shot — this is what makes Kling
    // produce smooth, floating, drone-like motion instead of handheld wobble.
    'Cinematic aerial drone shot of a luxury home, filmed on a professional gimbal drone.',
    'The camera ' + cameraLine + '.',
    composition ? composition + '.' : '',
    'Ultra-stabilized and floating, absolutely smooth with zero camera shake or wobble, constant slow velocity, gentle ease-in and ease-out.',
    'Photorealistic, natural lighting, no people, no warping, straight lines stay straight, walls and furniture do not bend, cinematic and restrained.',
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
    // Per-property closing card (agent / price / address). Rendered as the
    // final ~5s of the assembled video; changes with every listing.
    endCard: sb.endCard || null,
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
