#!/usr/bin/env node

// Executes the DJ grid, keyboard lifecycle, and per-deck sustain helpers
// extracted from main.js so the production data model stays under test.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');

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

const gridSandbox = {};
vm.runInNewContext(
  `
  ${extractConst('DJ_ACTIVE_SLOTS')}
  ${extractConst('DJ_KEY_GROUPS')}
  let cols = 4;
  let rows = 3;
  let zones = [];
  let djLandscape = true;
  const keyboardZoneByCode = new Map();
  const pointers = new Map();
  const performanceSettings = { djMode: true, pianoMode: true };
  const djSettings = {
    deckCount: 2,
    deckSfxIds: ['dagou', 'dingdong', 'hajimi'],
  };
  let stageMetrics = { width: 1200, height: 800 };
  let stopCalls = 0;
  function getStageMetrics() { return stageMetrics; }
  function stopActivePerformanceInput() {
    stopCalls++;
    pointers.clear();
  }
  function renderDjStage() {}
  function renderKeyGrid() {}
  ${extractFunction('getActiveDjSlots')}
  ${extractFunction('buildGrid')}

  function snapshot() {
    return {
      cols,
      rows,
      landscape: djLandscape,
      activeSlots: [...getActiveDjSlots()],
      zones: zones.map(zone => ({ ...zone })),
      keyboardEntries: [...keyboardZoneByCode.entries()],
    };
  }

  globalThis.gridApi = {
    build(width, height, deckCount) {
      stageMetrics = { width, height };
      djSettings.deckCount = deckCount;
      buildGrid();
      return snapshot();
    },
    addPointer() { pointers.set(7, { zone: 0 }); },
    stopCalls() { return stopCalls; },
  };
  `,
  gridSandbox,
);

const gridApi = gridSandbox.gridApi;
const clone = value => JSON.parse(JSON.stringify(value));
const expectedCodes = [
  [
    ['Digit1', 'Digit2', 'Digit3', 'Digit4'],
    ['KeyQ', 'KeyW', 'KeyE', 'KeyR'],
    ['KeyA', 'KeyS', 'KeyD', 'KeyF'],
  ],
  [
    ['Digit5', 'Digit6', 'Digit7', 'Digit8'],
    ['KeyT', 'KeyY', 'KeyU', 'KeyI'],
    ['KeyG', 'KeyH', 'KeyJ', 'KeyK'],
  ],
  [
    ['Digit9', 'Digit0', 'Minus', 'Equal'],
    ['KeyO', 'KeyP', 'BracketLeft', 'BracketRight'],
    ['KeyL', 'Semicolon', 'Quote', 'Backslash'],
  ],
];
const expectedLabels = [
  [
    ['1', '2', '3', '4'],
    ['Q', 'W', 'E', 'R'],
    ['A', 'S', 'D', 'F'],
  ],
  [
    ['5', '6', '7', '8'],
    ['T', 'Y', 'U', 'I'],
    ['G', 'H', 'J', 'K'],
  ],
  [
    ['9', '0', '-', '='],
    ['O', 'P', '[', ']'],
    ['L', ';', "'", '\\'],
  ],
];

function assertDeckLayout(rawLayout, expected) {
  const layout = clone(rawLayout);
  assert.equal(layout.cols, expected.cols);
  assert.equal(layout.rows, expected.rows);
  assert.equal(layout.landscape, expected.landscape);
  assert.deepEqual(layout.activeSlots, expected.slots);
  assert.equal(layout.zones.length, expected.slots.length * 12);
  assert.equal(layout.keyboardEntries.length, expected.slots.length * 12);

  const keyboardMap = new Map(layout.keyboardEntries);
  const samples = ['da', 'gou', 'jiao'];
  for (const [deckIndex, slot] of expected.slots.entries()) {
    const deckZones = layout.zones.filter(zone => zone.deckSlot === slot);
    assert.equal(deckZones.length, 12, `deck ${slot} must retain a 4 × 3 grid`);
    assert.ok(deckZones.every(zone => zone.deckIndex === deckIndex));

    for (let localRow = 0; localRow < 3; localRow++) {
      for (let localColumn = 0; localColumn < 4; localColumn++) {
        const zone = deckZones.find(item =>
          item.localRow === localRow && item.localColumn === localColumn
        );
        assert.ok(zone, `missing deck ${slot} cell ${localRow}:${localColumn}`);
        assert.equal(zone.deckId, `dj-${slot}`);
        assert.equal(zone.sample, samples[localRow]);
        assert.equal(zone.pitchTier, localColumn);
        assert.equal(zone.keyboardCode, expectedCodes[slot][localRow][localColumn]);
        assert.equal(zone.keyboardLabel, expectedLabels[slot][localRow][localColumn]);
        assert.equal(
          keyboardMap.get(zone.keyboardCode),
          layout.zones.findIndex(item => item.keyboardCode === zone.keyboardCode),
        );
      }
    }
  }
}

const landscapeTwo = gridApi.build(1200, 800, 2);
assertDeckLayout(landscapeTwo, {
  cols: 8,
  rows: 3,
  landscape: true,
  slots: [0, 2],
});
assert.equal(
  clone(landscapeTwo).keyboardEntries.some(([code]) => code === 'Digit5'),
  false,
  'two-deck mode must leave the center keyboard group inactive',
);

const portraitTwo = gridApi.build(800, 1200, 2);
assertDeckLayout(portraitTwo, {
  cols: 4,
  rows: 6,
  landscape: false,
  slots: [0, 2],
});

const landscapeThree = gridApi.build(1200, 800, 3);
assertDeckLayout(landscapeThree, {
  cols: 12,
  rows: 3,
  landscape: true,
  slots: [0, 1, 2],
});
assert.equal(
  new Set(clone(landscapeThree).keyboardEntries.map(([code]) => code)).size,
  36,
  'three-deck mode must expose 36 unique physical keys',
);

const portraitThree = gridApi.build(800, 1200, 3);
assertDeckLayout(portraitThree, {
  cols: 4,
  rows: 9,
  landscape: false,
  slots: [0, 1, 2],
});

gridApi.build(1200, 800, 3);
const stopsBeforeRotation = gridApi.stopCalls();
gridApi.addPointer();
gridApi.build(800, 1200, 3);
assert.equal(
  gridApi.stopCalls(),
  stopsBeforeRotation + 1,
  'rotating the active layout must release input tied to the old grid',
);

const keyboardSandbox = {};
vm.runInNewContext(
  `
  const performanceSettings = { djMode: true };
  let settingsOpen = false;
  const keyboardZoneByCode = new Map([
    ['Digit1', 0],
    ['KeyA', 8],
  ]);
  const pressedKeyboardCodes = new Set();
  const pointers = new Map();
  const inputQueue = [];
  const inputVisualTimers = new Set();
  const lastCommittedDjInputTimes = new Map();
  const liveVoices = new Set();
  let lastCommittedInputTime = -Infinity;
  let ctx = { currentTime: 1 };
  let enterCount = 0;
  let hiddenCount = 0;
  let startCount = 0;
  const released = [];
  const forceStopped = [];
  function hideControlsUntilIdle() { hiddenCount++; }
  function start() { startCount++; return Promise.resolve(); }
  function enterZone(pointerId, state, zone) {
    enterCount++;
    state.zone = zone;
    state.voice = { id: pointerId };
  }
  function releaseVoice(voice) { released.push(voice.id); }
  function forceStopVoice(voice) { forceStopped.push(voice.id); }
  function cancelQueuedInputs() {}
  function clearInputVisualTimers() { inputVisualTimers.clear(); }
  ${extractFunction('clearQueuedPerformanceInput')}
  ${extractFunction('stopActivePerformanceInput')}
  ${extractFunction('endInput')}
  ${extractFunction('beginKeyboardInput')}
  ${extractFunction('handleKeyboardDown')}
  ${extractFunction('handleKeyboardUp')}
  ${extractFunction('handleWindowBlur')}

  globalThis.keyboardApi = {
    keyDown: handleKeyboardDown,
    keyUp: handleKeyboardUp,
    blur: handleWindowBlur,
    setDjMode(value) { performanceSettings.djMode = value; },
    setSettingsOpen(value) { settingsOpen = value; },
    seedBlurState() {
      inputQueue.push({ id: 7 });
      inputVisualTimers.add(1);
      lastCommittedInputTime = 4;
      lastCommittedDjInputTimes.set('dj-0', 4);
      pressedKeyboardCodes.add('KeyA');
      pointers.set('keyboard:KeyA', { pendingEntryId: 7 });
      liveVoices.add({ id: 'live' });
    },
    state() {
      return {
        pressed: [...pressedKeyboardCodes],
        pointers: [...pointers.keys()],
        queueLength: inputQueue.length,
        timerCount: inputVisualTimers.size,
        lastCommittedInputTime,
        djCommitCount: lastCommittedDjInputTimes.size,
        enterCount,
        hiddenCount,
        startCount,
        released: [...released],
        forceStopped: [...forceStopped],
      };
    },
  };
  `,
  keyboardSandbox,
);

const keyboardApi = keyboardSandbox.keyboardApi;
function keyboardEvent(code, repeat = false) {
  return {
    code,
    repeat,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

const firstDown = keyboardEvent('KeyA');
keyboardApi.keyDown(firstDown);
await Promise.resolve();
assert.equal(firstDown.prevented, true);
assert.deepEqual(clone(keyboardApi.state()).pressed, ['KeyA']);
assert.deepEqual(clone(keyboardApi.state()).pointers, ['keyboard:KeyA']);
assert.equal(keyboardApi.state().enterCount, 1);

const repeatedDown = keyboardEvent('KeyA', true);
keyboardApi.keyDown(repeatedDown);
await Promise.resolve();
assert.equal(repeatedDown.prevented, true);
assert.equal(keyboardApi.state().enterCount, 1);

const keyUp = keyboardEvent('KeyA');
keyboardApi.keyUp(keyUp);
assert.equal(keyUp.prevented, true);
assert.deepEqual(clone(keyboardApi.state()).pressed, []);
assert.deepEqual(clone(keyboardApi.state()).pointers, []);
assert.deepEqual(clone(keyboardApi.state()).released, ['keyboard:KeyA']);

keyboardApi.setSettingsOpen(true);
const settingsDown = keyboardEvent('Digit1');
keyboardApi.keyDown(settingsDown);
await Promise.resolve();
assert.equal(settingsDown.prevented, false);
assert.equal(keyboardApi.state().enterCount, 1);

keyboardApi.setSettingsOpen(false);
keyboardApi.setDjMode(false);
const soloDown = keyboardEvent('Digit1');
keyboardApi.keyDown(soloDown);
await Promise.resolve();
assert.equal(soloDown.prevented, false);
assert.equal(keyboardApi.state().enterCount, 1);

keyboardApi.setDjMode(true);
keyboardApi.seedBlurState();
keyboardApi.blur();
const blurredState = clone(keyboardApi.state());
assert.equal(blurredState.queueLength, 0);
assert.equal(blurredState.timerCount, 0);
assert.equal(blurredState.lastCommittedInputTime, null);
assert.equal(blurredState.djCommitCount, 0);
assert.deepEqual(blurredState.pressed, []);
assert.deepEqual(blurredState.pointers, []);
assert.deepEqual(blurredState.forceStopped, ['live']);

const sustainSandbox = {};
vm.runInNewContext(
  `
  const activeSustainVoices = new Map();
  const liveVoices = new Set();
  const released = [];
  const locked = [];
  const SUSTAIN_CLAIM_LEAD = 0;
  function releaseVoice(voice) {
    voice.held = false;
    voice.released = true;
    const scopeId = voice.deckId ?? 'solo';
    if (activeSustainVoices.get(scopeId) === voice) {
      activeSustainVoices.delete(scopeId);
    }
    released.push(voice.id);
  }
  function lockMouth(voice) { locked.push(voice.id); }
  ${extractFunction('claimSustainVoice')}
  ${extractFunction('updateSustainClaims')}

  function makeVoice(id, deckId) {
    return {
      id,
      deckId,
      held: true,
      released: false,
      claimed: false,
      handoffAt: 1,
      mode: 'pending',
    };
  }
  const leftFirst = makeVoice(1, 'dj-0');
  const right = makeVoice(2, 'dj-2');
  liveVoices.add(leftFirst);
  liveVoices.add(right);
  updateSustainClaims(1);

  const leftSecond = makeVoice(3, 'dj-0');
  liveVoices.add(leftSecond);
  updateSustainClaims(1);

  globalThis.sustainResult = {
    active: [...activeSustainVoices.entries()].map(([deckId, voice]) => [deckId, voice.id]),
    released,
    locked,
    leftFirstReleased: leftFirst.released,
    rightReleased: right.released,
  };
  `,
  sustainSandbox,
);

assert.deepEqual(clone(sustainSandbox.sustainResult), {
  active: [['dj-2', 2], ['dj-0', 3]],
  released: [1],
  locked: [1, 2, 3],
  leftFirstReleased: true,
  rightReleased: false,
});

console.log('DJ mode verification passed:');
console.log('- two and three decks keep complete 4 × 3 grids in both orientations');
console.log('- all 36 physical keys map to the intended deck, syllable, and pitch tier');
console.log('- keyboard press, repeat suppression, release, settings guard, and blur cleanup work');
console.log('- layout rotation releases input tied to the previous grid');
console.log('- different decks sustain together while the newest voice wins within one deck');
