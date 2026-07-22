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
  ${extractConst('HRTF_X_SPREAD')}
  ${extractConst('HRTF_FIELD_SHIFT')}
  ${extractConst('HRTF_BASE_DISTANCE')}
  ${extractConst('HRTF_DEPTH_SHIFT')}
  ${extractConst('GRAVITY_DEAD_ZONE')}
  ${extractConst('GRAVITY_FULL_TILT')}
  ${extractConst('SOUND_FIELD_KEY_POSITIONS')}
  const performanceSettings = { spatialAudio: false };
  let soundFieldPosition = 0;
  let settingsOpen = false;
  let djRecorderOpen = false;
  let spatialControlMode = 'manual';
  let transportBusy = false;
  let shortcutPosition = null;
  let manualActivations = 0;
  function activateManualSoundField() {
    spatialControlMode = 'manual';
    manualActivations++;
  }
  function setSoundFieldPosition(value) {
    shortcutPosition = value;
  }
  function isDjTransportBusy() { return transportBusy; }
  ${extractFunction('clampSoundFieldPosition')}
  ${extractFunction('getDeckBaseSpatialPan')}
  ${extractFunction('getSpatialOutputTargets')}
  ${extractFunction('screenRelativeTilt')}
  ${extractFunction('getGravitySoundFieldTarget')}
  ${extractFunction('handleSoundFieldKeyboard')}

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
    shortcut(code, options = {}) {
      performanceSettings.spatialAudio = options.enabled !== false;
      settingsOpen = options.settingsOpen === true;
      transportBusy = options.transportBusy === true;
      spatialControlMode = options.mode ?? 'manual';
      shortcutPosition = null;
      manualActivations = 0;
      let prevented = false;
      const handled = handleSoundFieldKeyboard({
        code,
        repeat: options.repeat === true,
        metaKey: options.metaKey === true,
        ctrlKey: options.ctrlKey === true,
        altKey: options.altKey === true,
        preventDefault() { prevented = true; },
      });
      return {
        handled,
        prevented,
        position: shortcutPosition,
        mode: spatialControlMode,
        manualActivations,
      };
    },
  };
  `,
  sandbox,
);

const clone = (value) => JSON.parse(JSON.stringify(value));
assert.deepEqual(
  clone(sandbox.spatialApi.targets(false, -1, 'dj-0')),
  { enabled: false, pan: 0, gain: 1, x: 0, y: 0, z: -1 },
  'disabling 3D audio must select the uncolored bypass',
);
const leftCenter = sandbox.spatialApi.targets(true, 0, 'dj-0');
assert.equal(leftCenter.enabled, true);
assert.equal(leftCenter.pan, -0.72);
assert.equal(leftCenter.gain, 1);
assert.ok(Math.abs(leftCenter.x + 0.9) < 1e-12);
assert.equal(leftCenter.z, -1.15);
assert.deepEqual(
  clone(sandbox.spatialApi.targets(true, 0, 'dj-1')),
  { enabled: true, pan: 0, gain: 1, x: 0, y: 0, z: -1.15 },
  'the center deck must stay centered',
);
const rightCenter = sandbox.spatialApi.targets(true, 0, 'dj-2');
assert.equal(rightCenter.pan, 0.72);
assert.ok(Math.abs(rightCenter.x - 0.9) < 1e-12);
assert.equal(rightCenter.z, -1.15);

const leftFocus = sandbox.spatialApi.targets(true, -1, 'dj-0');
const rightFar = sandbox.spatialApi.targets(true, -1, 'dj-2');
assert.equal(leftFocus.pan, -1);
assert.ok(leftFocus.gain > 1);
assert.ok(leftFocus.x < leftCenter.x);
assert.ok(leftFocus.z > leftCenter.z);
assert.ok(rightFar.pan < 0.72);
assert.ok(rightFar.gain < 1);
assert.ok(rightFar.z < rightCenter.z);
assert.deepEqual(
  clone(sandbox.spatialApi.targets(true, -1, 'dj-1')),
  { enabled: true, pan: -0.3, gain: 1, x: -0.48, y: 0, z: -1.15 },
  'moving the sound field must shift the center deck without changing its depth',
);

assert.equal(sandbox.spatialApi.tilt(0, 8, -12), -12);
assert.equal(sandbox.spatialApi.tilt(90, 8, -12), 8);
assert.equal(sandbox.spatialApi.tilt(270, 8, -12), -8);
assert.equal(sandbox.spatialApi.gravityTarget(3), 0);
assert.equal(sandbox.spatialApi.gravityTarget(9), 0.5);
assert.equal(sandbox.spatialApi.gravityTarget(15), 1);
assert.equal(sandbox.spatialApi.gravityTarget(-15), -1);
assert.deepEqual(clone(sandbox.spatialApi.shortcut('KeyZ')), {
  handled: true,
  prevented: true,
  position: -1,
  mode: 'manual',
  manualActivations: 0,
});
assert.equal(sandbox.spatialApi.shortcut('Slash').position, 1);
assert.equal(sandbox.spatialApi.shortcut('KeyB').position, 0);
assert.deepEqual(clone(sandbox.spatialApi.shortcut('KeyB', { mode: 'gravity' })), {
  handled: true,
  prevented: true,
  position: 0,
  mode: 'manual',
  manualActivations: 1,
});
assert.equal(sandbox.spatialApi.shortcut('KeyX').handled, false);
assert.equal(
  sandbox.spatialApi.shortcut('KeyZ', { enabled: false }).handled,
  false,
);
assert.equal(
  sandbox.spatialApi.shortcut('KeyZ', { settingsOpen: true }).handled,
  false,
);
assert.equal(
  sandbox.spatialApi.shortcut('KeyZ', { transportBusy: true }).handled,
  false,
);

assert.match(
  extractFunction('createSpatialOutput'),
  /createPanner/,
  'each effect voice must use a native spatial panner when available',
);
assert.match(
  extractFunction('createSpatialOutput'),
  /panningModel = 'HRTF'/,
  'the native spatial panner must use the HRTF model',
);
assert.match(
  extractFunction('createSpatialOutput'),
  /dryGain\.connect\(sfxBus\)/,
  'the original signal must keep a direct bypass around HRTF',
);
assert.match(
  extractFunction('updateSpatialOutput'),
  /output\.dryGain\.gain[\s\S]*output\.spatialGain\.gain[\s\S]*positionZ/,
  '3D switching must crossfade the bypass and update source depth',
);
assert.match(
  extractFunction('playPressVoice'),
  /createSpatialOutput\(deckId\)/,
  'short and sustained voices must enter their deck spatial output',
);
assert.match(
  extractFunction('createTailSource'),
  /voice\.spatialOutput\.input/,
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
assert.match(
  htmlSource,
  /id="spatial-audio-setting"[^>]*data-setting="spatialAudio"[\s\S]*?id="spatial-audio-settings"/,
  'settings must expose the same 3D audio switch above its detail controls',
);
assert.equal(
  [...htmlSource.matchAll(/data-setting="spatialAudio"/g)].length,
  2,
  'the top bar and settings menu must each expose one 3D audio switch',
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
assert.match(
  htmlSource,
  /id="sound-field-slider"[^>]*aria-keyshortcuts="Z \/ B"/,
  'the slider must announce its three PC shortcuts',
);
assert.match(htmlSource, /data-spatial-mode="manual"/, 'missing manual mode');
assert.match(htmlSource, /data-spatial-mode="gravity"/, 'missing gravity mode');

console.log('Spatial audio verification passed:');
console.log('- off mode bypasses HRTF and preserves the original signal path');
console.log('- two and three deck layouts map to stable three-dimensional positions');
console.log('- manual focus shifts the field and moves the nearer deck forward');
console.log('- portrait and landscape tilt axes map into one sound-field value');
console.log('- gravity reaches full range at 15 degrees with a 3-degree dead zone');
console.log('- iPad sensor permission and slider fallback remain present');
console.log('- Z, slash, and B move the PC sound field left, right, and center');
