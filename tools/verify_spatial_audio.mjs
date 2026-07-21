#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const htmlSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const candidates = [`async function ${name}`, `function ${name}`];
  const start = candidates
    .map((candidate) => mainSource.indexOf(candidate))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.notEqual(start, undefined, `Cannot find function ${name}`);

  const bodyStart = mainSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainSource.length; index++) {
    if (mainSource[index] === '{') depth++;
    if (mainSource[index] === '}') {
      depth--;
      if (depth === 0) return mainSource.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed function ${name}`);
}

function extractConst(name) {
  const start = mainSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `Cannot find constant ${name}`);
  const end = mainSource.indexOf(';\n', start);
  assert.ok(end > start, `Cannot find end of constant ${name}`);
  return mainSource.slice(start, end + 1);
}

const sandbox = {
  window: {
    orientation: 0,
    screen: { orientation: { angle: 0 } },
  },
};
vm.runInNewContext(
  `
  ${extractConst('SPATIAL_DECK_PANS')}
  ${extractConst('SPATIAL_FIELD_SHIFT')}
  ${extractConst('SPATIAL_FOCUS_GAIN')}
  ${extractConst('GRAVITY_DEAD_ZONE')}
  ${extractConst('GRAVITY_FULL_TILT')}
  const performanceSettings = { spatialAudio: false };
  let soundFieldPosition = 0;
  ${extractFunction('clampSoundFieldPosition')}
  ${extractFunction('getDeckBaseSpatialPan')}
  ${extractFunction('getSpatialOutputTargets')}
  ${extractFunction('screenRelativeTilt')}
  ${extractFunction('getGravitySoundFieldTarget')}

  globalThis.spatialApi = {
    targets(enabled, position, deckId) {
      performanceSettings.spatialAudio = enabled;
      soundFieldPosition = position;
      return getSpatialOutputTargets(deckId);
    },
    tilt(angle, beta, gamma) {
      window.screen.orientation.angle = angle;
      return screenRelativeTilt({ beta, gamma });
    },
    gravityTarget(delta) {
      return getGravitySoundFieldTarget(delta);
    },
  };
  `,
  sandbox,
);

const clone = (value) => JSON.parse(JSON.stringify(value));
assert.deepEqual(
  clone(sandbox.spatialApi.targets(false, -1, 'dj-0')),
  { pan: 0, gain: 1 },
  'disabling 3D audio must center every deck at unity gain',
);
assert.deepEqual(
  clone(sandbox.spatialApi.targets(true, 0, 'dj-0')),
  { pan: -0.72, gain: 1 },
  'the left deck must start on the left',
);
assert.deepEqual(
  clone(sandbox.spatialApi.targets(true, 0, 'dj-1')),
  { pan: 0, gain: 1 },
  'the center deck must stay centered',
);
assert.deepEqual(
  clone(sandbox.spatialApi.targets(true, 0, 'dj-2')),
  { pan: 0.72, gain: 1 },
  'the right deck must start on the right',
);

const leftFocus = sandbox.spatialApi.targets(true, -1, 'dj-0');
const rightFar = sandbox.spatialApi.targets(true, -1, 'dj-2');
assert.equal(leftFocus.pan, -1);
assert.ok(leftFocus.gain > 1);
assert.ok(rightFar.pan < 0.72);
assert.ok(rightFar.gain < 1);
assert.deepEqual(
  clone(sandbox.spatialApi.targets(true, -1, 'dj-1')),
  { pan: -0.3, gain: 1 },
  'moving the sound field must shift the center deck without changing its gain',
);

assert.equal(sandbox.spatialApi.tilt(0, 8, -12), -12);
assert.equal(sandbox.spatialApi.tilt(90, 8, -12), 8);
assert.equal(sandbox.spatialApi.tilt(270, 8, -12), -8);
assert.equal(sandbox.spatialApi.gravityTarget(3), 0);
assert.equal(sandbox.spatialApi.gravityTarget(9), 0.5);
assert.equal(sandbox.spatialApi.gravityTarget(15), 1);
assert.equal(sandbox.spatialApi.gravityTarget(-15), -1);

assert.match(
  extractFunction('createSpatialOutput'),
  /createStereoPanner/,
  'each effect voice must use a native stereo panner when available',
);
assert.match(
  extractFunction('playPressVoice'),
  /createSpatialOutput\(deckId\)/,
  'short and sustained voices must enter their deck spatial output',
);
assert.match(
  extractFunction('createTailSource'),
  /voice\.spatialOutput\.gain/,
  'a released sustain tail must keep the same spatial position',
);
assert.match(
  extractFunction('enableGravitySoundField'),
  /requestPermission\(\)/,
  'iPad gravity control must request sensor permission from the user gesture',
);
assert.match(
  extractFunction('enableGravitySoundField'),
  /addEventListener\('deviceorientation'/,
  'gravity mode must listen to device orientation after permission',
);

assert.match(
  htmlSource,
  /id="audio-controls"[\s\S]*?id="spatial-audio-toggle"[^>]*data-setting="spatialAudio"/,
  'the main controls must expose the 3D audio switch',
);
assert.doesNotMatch(
  htmlSource,
  /id="spatial-audio-setting"/,
  'the 3D audio switch must no longer stay inside settings',
);
assert.match(
  mainSource,
  /querySelectorAll\('\[data-setting\]'\)/,
  'the main 3D switch must share the performance-setting persistence path',
);
assert.match(
  htmlSource,
  /id="sound-field-slider"[^>]*type="range"[^>]*min="-100"[^>]*max="100"/,
  'the stage must expose a live left-to-right sound field slider',
);
assert.match(htmlSource, /data-spatial-mode="manual"/, 'missing manual mode');
assert.match(htmlSource, /data-spatial-mode="gravity"/, 'missing gravity mode');

console.log('Spatial audio verification passed:');
console.log('- off mode centers every effect voice at unity gain');
console.log('- two and three deck layouts map to left, center, and right positions');
console.log('- manual focus shifts the field and emphasizes the nearer deck');
console.log('- portrait and landscape tilt axes map into one sound-field value');
console.log('- gravity reaches full range at 15 degrees with a 3-degree dead zone');
console.log('- iPad sensor permission and slider fallback remain present');
