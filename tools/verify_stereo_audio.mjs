#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const htmlSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const candidates = [`async function ${name}`, `function ${name}`];
  const start = candidates
    .map(candidate => mainSource.indexOf(candidate))
    .filter(index => index >= 0)
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

const sandbox = {};
vm.runInNewContext(
  `
  ${extractConst('STEREO_PAN_SPREAD')}
  const DJ_DECK_LABELS = ['LEFT', 'CENTER', 'RIGHT'];
  const performanceSettings = {
    spatialAudio: false,
    djMode: true,
    rhythmGameMode: false,
  };
  let activeSlots = [0, 1, 2];
  function isDeckPerformanceMode() {
    return performanceSettings.djMode || performanceSettings.rhythmGameMode;
  }
  function getActiveDeckSlots() { return activeSlots; }
  ${extractFunction('getStereoDeckSlot')}
  ${extractFunction('getStereoPan')}

  globalThis.stereoApi = {
    pan(deckId, options = {}) {
      performanceSettings.spatialAudio = options.enabled !== false;
      performanceSettings.djMode = options.deckMode !== false;
      performanceSettings.rhythmGameMode = false;
      activeSlots = options.activeSlots ?? [0, 1, 2];
      return getStereoPan(deckId);
    },
  };
  `,
  sandbox,
);

const stereo = sandbox.stereoApi;
assert.equal(stereo.pan('dj-0', { enabled: false }), 0);
assert.equal(stereo.pan('dj-0'), -0.8);
assert.equal(stereo.pan('dj-1'), 0);
assert.equal(stereo.pan('dj-2'), 0.8);
assert.equal(stereo.pan('dj-0', { activeSlots: [0, 2] }), -0.8);
assert.equal(stereo.pan('dj-2', { activeSlots: [0, 2] }), 0.8);
assert.equal(stereo.pan('dj-1', { activeSlots: [0, 2] }), 0);
assert.equal(stereo.pan('dj-0', { activeSlots: [0] }), 0);
assert.equal(stereo.pan('dj-0', { deckMode: false }), 0);
assert.equal(stereo.pan(null), 0);
assert.equal(stereo.pan('dj-9'), 0);

assert.match(
  extractFunction('createStereoOutput'),
  /createStereoPanner/,
  'effect voices must use the native two-channel panner when available',
);
assert.doesNotMatch(
  extractFunction('createStereoOutput'),
  /createPanner|HRTF|position[XYZ]|distanceModel/,
  'the output must not create a 3D panner',
);
assert.match(
  extractFunction('createStereoOutput'),
  /input\.connect\(panner\)[\s\S]*panner\.connect\(sfxBus\)[\s\S]*input\.connect\(sfxBus\)/,
  'browsers without StereoPannerNode must keep centered audio',
);
assert.match(
  extractFunction('updateStereoOutput'),
  /setStereoAudioParam\(output\.panner\.pan, getStereoPan\(output\.deckId\), immediate\)/,
  'switching stereo must update only the pan value',
);
assert.match(
  extractFunction('applyPerformanceSettings'),
  /previousSettings\.spatialAudio[\s\S]*updateLiveStereoOutputs\(\)/,
  'the legacy share flag must update every live stereo output',
);
assert.match(
  extractFunction('playPressVoice'),
  /createStereoOutput\(deckId\)/,
  'short and sustained voices must enter their deck stereo output',
);
assert.match(
  extractFunction('createTailSource'),
  /voice\.stereoOutput\.input/,
  'released sustain tails must keep the same deck pan',
);
assert.doesNotMatch(
  mainSource,
  /createPanner|HRTF|AudioListener|ctx\.listener|soundField|SOUND_FIELD|DeviceOrientationEvent|deviceorientation/,
  '3D positioning, sound-field controls, and gravity handling must be gone',
);

assert.match(
  htmlSource,
  /id="stereo-audio-toggle"[^>]*aria-label="开启双声道立体声"[^>]*data-setting="spatialAudio"/,
  'the top bar must expose the stereo switch',
);
assert.match(
  htmlSource,
  /id="stereo-audio-setting"[^>]*data-setting="spatialAudio"[\s\S]*双声道立体声[\s\S]*左、中、右/,
  'settings must describe the fixed left, center, and right layout',
);
assert.equal(
  [...htmlSource.matchAll(/data-setting="spatialAudio"/g)].length,
  2,
  'the top bar and settings must share the legacy persisted flag',
);
assert.doesNotMatch(
  htmlSource,
  /sound-field|3D 音效|3D 音场|HRTF|重力感应/,
  'the removed 3D interface must not remain in the page',
);

console.log('Stereo audio verification passed:');
console.log('- one deck is centered, two decks split left/right');
console.log('- three decks map to left, center, and right');
console.log('- disabling stereo centers every deck');
console.log('- StereoPannerNode is the only directional audio path');
console.log('- the old 3D field, HRTF, listener, and shortcuts are removed');
console.log('- the existing cloud and recording flag remains compatible');
