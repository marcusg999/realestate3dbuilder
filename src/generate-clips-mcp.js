'use strict';
// MCP-based clip generation via Higgsfield MCP server connection.
// This script reads work/shot-plan.json and calls the Higgsfield MCP server's
// generate_video tool for each shot, saving results to work/clips/<id>.mp4.
//
// Requirements:
//   - Higgsfield MCP server must be running and accessible
//   - MCP_SERVER_URL environment variable (or use default stdio connection)
//
// Usage:
//   node src/generate-clips-mcp.js              # generate missing clips
//   node src/generate-clips-mcp.js --dry-run    # preview what would be generated
//   node src/generate-clips-mcp.js --force      # regenerate all clips
//   node src/generate-clips-mcp.js --only kitchen-island

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { abs, loadConfig } = require('./lib/config');

// Load the shot plan
function loadPlan() {
  const p = abs('work/shot-plan.json');
  if (!fs.existsSync(p)) {
    console.error('No shot plan found. Build it first: node src/build-shot-plan.js');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Select which shots to generate based on flags
function selectShots(plan, { only, force }) {
  let shots = plan.shots;
  if (only) shots = shots.filter((s) => s.id === only);
  if (!force) shots = shots.filter((s) => !fs.existsSync(abs(s.outClip)));
  return shots;
}

// Call the Higgsfield MCP generate_video tool
// This assumes you have a Higgsfield MCP server connection available.
// The MCP protocol expects JSON-RPC messages over stdio or HTTP.
async function callMCPGenerateVideo(shot) {
  const spec = shot.higgsfield;
  
  // Read the source image as base64 for MCP transmission
  const imagePath = abs(spec.startImage);
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Source image not found: ${spec.startImage}`);
  }
  
  const imageBuffer = fs.readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  const imageMimeType = spec.startImage.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  // Build the MCP tool call payload
  // This matches the Higgsfield MCP server's generate_video tool signature
  const mcpRequest = {
    jsonrpc: '2.0',
    id: `generate-${shot.id}-${Date.now()}`,
    method: 'tools/call',
    params: {
      name: 'generate_video',
      arguments: {
        mode: 'image2video',
        prompt: spec.prompt,
        image: imageBase64,
        image_mime_type: imageMimeType,
        duration: spec.seconds || 5,
        aspect_ratio: spec.aspect || '16:9',
        model: spec.modelHint || 'turbo',
        motion_preset: spec.motion?.preset || 'dolly_in',
        motion_speed: spec.motion?.speed ?? 0.8,
        motion_intensity: spec.motion?.intensity ?? 0.5,
      }
    }
  };

  // Call the MCP server
  // NOTE: This is a simplified example. You'll need to adapt this to your actual
  // MCP server connection method (stdio, HTTP, WebSocket, etc.)
  const mcpServerUrl = process.env.MCP_SERVER_URL || 'stdio';
  
  if (mcpServerUrl === 'stdio') {
    return await callMCPViaStdio(mcpRequest);
  } else {
    return await callMCPViaHTTP(mcpServerUrl, mcpRequest);
  }
}

// Call MCP via stdio (spawning the MCP server process)
async function callMCPViaStdio(request) {
  return new Promise((resolve, reject) => {
    const mcpServerCommand = process.env.MCP_SERVER_COMMAND || 'npx';
    const mcpServerArgs = (process.env.MCP_SERVER_ARGS || '-y @higgsfield/mcp-server').split(' ');
    
    const child = spawn(mcpServerCommand, mcpServerArgs, {
      stdio: ['pipe', 'pipe', 'inherit']
    });

    let stdout = '';
    let response = null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      
      // Parse JSON-RPC response line by line
      const lines = stdout.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (line) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === request.id) {
              response = parsed;
            }
          } catch (e) {
            // Not JSON, skip
          }
        }
      }
      // Keep the last incomplete line
      stdout = lines[lines.length - 1];
    });

    child.on('close', (code) => {
      if (response && response.result) {
        resolve(response.result);
      } else if (response && response.error) {
        reject(new Error(`MCP error: ${response.error.message}`));
      } else {
        reject(new Error(`MCP server exited with code ${code}, no valid response`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn MCP server: ${err.message}`));
    });

    // Send the request
    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();
  });
}

// Call MCP via HTTP
async function callMCPViaHTTP(baseUrl, request) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP HTTP error ${response.status}: ${text}`);
  }

  const result = await response.json();
  
  if (result.error) {
    throw new Error(`MCP error: ${result.error.message}`);
  }

  return result.result;
}

// Download the generated video from the MCP result
async function downloadVideo(mcpResult, destPath) {
  // The MCP result should contain a video URL or base64-encoded video
  let videoUrl = null;
  let videoBase64 = null;

  if (mcpResult.content) {
    // Standard MCP tool response format
    for (const item of mcpResult.content) {
      if (item.type === 'resource' && item.resource) {
        if (item.resource.uri && item.resource.uri.startsWith('http')) {
          videoUrl = item.resource.uri;
        } else if (item.resource.blob) {
          videoBase64 = item.resource.blob;
        }
      } else if (item.type === 'text' && item.text) {
        // Try to extract URL from text
        const urlMatch = item.text.match(/https?:\/\/[^\s]+\.mp4/);
        if (urlMatch) {
          videoUrl = urlMatch[0];
        }
      }
    }
  } else if (mcpResult.video_url) {
    // Direct field (non-standard, but common)
    videoUrl = mcpResult.video_url;
  } else if (mcpResult.url) {
    videoUrl = mcpResult.url;
  }

  if (videoUrl) {
    // Download from URL
    const response = await fetch(videoUrl);
    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return buffer.length;
  } else if (videoBase64) {
    // Decode base64
    const buffer = Buffer.from(videoBase64, 'base64');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return buffer.length;
  } else {
    throw new Error('MCP result contains no video URL or base64 data');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

  const cfg = loadConfig();
  const plan = loadPlan();

  // Validate --only argument
  if (only && !plan.shots.some((s) => s.id === only)) {
    console.error(`No shot with id "${only}" in the current plan.`);
    console.error(`Available ids: ${plan.shots.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  const shots = selectShots(plan, { only, force });
  
  if (!shots.length) {
    console.log(only
      ? `"${only}" already has a clip — pass --force to regenerate it.`
      : 'Nothing to generate — every clip already exists (use --force to regenerate).');
    return;
  }

  if (dryRun) {
    console.log(`DRY RUN — ${shots.length} clip(s) would be generated via MCP:\n`);
    for (const s of shots) {
      console.log(`  ${s.id}  (${s.room || ''})`);
      console.log(`    image : ${s.sourcePhoto}`);
      console.log(`    out   : ${s.outClip}`);
      console.log(`    prompt: ${s.higgsfield.prompt}`);
      console.log(`    motion: ${s.higgsfield.motion.preset} (speed: ${s.higgsfield.motion.speed}, intensity: ${s.higgsfield.motion.intensity})`);
      console.log(`    model : ${s.higgsfield.modelHint || 'turbo'}\n`);
    }
    return;
  }

  console.log(`Generating ${shots.length} clip(s) via Higgsfield MCP...\n`);
  console.log(`MCP connection: ${process.env.MCP_SERVER_URL || 'stdio (default)'}\n`);

  let ok = 0;
  for (const shot of shots) {
    try {
      process.stdout.write(`  • ${shot.id}: calling MCP generate_video... `);
      const mcpResult = await callMCPGenerateVideo(shot);
      
      process.stdout.write('downloading... ');
      const bytes = await downloadVideo(mcpResult, abs(shot.outClip));
      
      console.log(`✓ done (${Math.round(bytes / 1024)} KB)`);
      ok += 1;
    } catch (err) {
      console.log('✗ FAILED');
      console.error(`    ${err.message}`);
      process.exitCode = 1;
      
      // Continue with next shot rather than stopping entirely
    }
  }

  console.log(`\n${ok}/${shots.length} clip(s) generated successfully.`);
  if (ok > 0) {
    console.log('Next: node src/assemble.js');
  }
}

main().catch((e) => {
  console.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
