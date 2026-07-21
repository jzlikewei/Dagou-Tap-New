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
  ${extractConst('DEFAULT_DJ_SETTINGS')}
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
    deckCount: DEFAULT_DJ_SETTINGS.deckCount,
    deckSfxIds: [...DEFAULT_DJ_SETTINGS.deckSfxIds],
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
assert.deepEqual(
  [0, 1, 2].map(slot =>
    clone(landscapeThree).zones.find(zone => zone.deckSlot === slot).sfxId
  ),
  ['dagou', 'hajimi', 'dingdong'],
  'three-deck mode must default to dog, cat, and chicken from left to right',
);
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

const gridVisibilitySandbox = {};
vm.runInNewContext(
  `
  let cols = 8;
  let rows = 3;
  const zones = [];
  const performanceSettings = { djMode: true, showGrid: false };
  const classState = new Map();
  const keyGrid = {
    style: { setProperty() {} },
    classList: {
      toggle(name, enabled) { classState.set(name, Boolean(enabled)); },
    },
    replaceChildren() {},
  };
  const document = {
    createDocumentFragment() { return { appendChild() {} }; },
    createElement() {
      return {
        className: '',
        dataset: {},
        classList: { add() {} },
        appendChild() {},
      };
    },
  };
  ${extractFunction('renderKeyGrid')}

  globalThis.gridVisibilityApi = {
    render(showGrid) {
      performanceSettings.showGrid = showGrid;
      renderKeyGrid();
      return Object.fromEntries(classState);
    },
  };
  `,
  gridVisibilitySandbox,
);

assert.deepEqual(
  clone(gridVisibilitySandbox.gridVisibilityApi.render(false)),
  { 'is-visible': false, 'is-dj-grid': true },
  'DJ mode must let the grid setting hide fine cell boundaries',
);
assert.deepEqual(
  clone(gridVisibilitySandbox.gridVisibilityApi.render(true)),
  { 'is-visible': true, 'is-dj-grid': true },
  'DJ mode must let the grid setting show fine cell boundaries',
);

const touchTrailSandbox = {};
vm.runInNewContext(
  `
  const C = { amber: '#ffb400', teal: '#16c2a3', blue: '#3e7bfa' };
  const TOUCH_TRAIL_COLORS = Object.freeze([C.amber, C.teal, C.blue]);
  const SFX_EMOJIS = Object.freeze({ dagou: '🐶', dingdong: '🐔', hajimi: '🐱' });
  const TOUCH_TRAIL_MAX_POINTS = 10;
  const TOUCH_TRAIL_POINT_GAP = 8;
  const TOUCH_TRAIL_EXIT_MOMENTUM_WINDOW = 0.12;
  const touchTrails = new Map();
  const zones = [
    { deckSlot: 0, sfxId: 'dagou' },
    { deckSlot: 1, sfxId: 'hajimi' },
    { deckSlot: 2, sfxId: 'dingdong' },
  ];
  function zoneIndex(clientX) {
    return clientX < 400 ? 0 : clientX < 700 ? 1 : 2;
  }
  function getStageMetrics() {
    return { width: 1000, height: 500, left: 100, top: 50 };
  }
  function touchTrailNow() { return 99; }
  ${extractFunction('getTouchTrailPoint')}
  ${extractFunction('getTouchTrailAppearance')}
  ${extractFunction('beginTouchTrail')}
  ${extractFunction('moveTouchTrail')}
  ${extractFunction('pulseTouchTrail')}
  ${extractFunction('releaseTouchTrail')}
  ${extractFunction('releaseAllTouchTrails')}

  function snapshot(pointerId) {
    const trail = touchTrails.get(pointerId);
    return trail ? {
      x: trail.x,
      y: trail.y,
      sampleX: trail.sampleX,
      color: trail.color,
      emoji: trail.emoji,
      pulseAt: trail.pulseAt,
      releasedAt: trail.releasedAt,
      exitX: trail.exitX,
      exitY: trail.exitY,
      pointCount: trail.points.length,
    } : null;
  }

  globalThis.touchTrailApi = {
    begin: beginTouchTrail,
    move: moveTouchTrail,
    pulse: pulseTouchTrail,
    release: releaseTouchTrail,
    releaseAll: releaseAllTouchTrails,
    snapshot,
    size() { return touchTrails.size; },
  };
  `,
  touchTrailSandbox,
);

const touchTrailApi = touchTrailSandbox.touchTrailApi;
touchTrailApi.begin(1, 200, 100, 1);
touchTrailApi.move(1, 204, 100, 1.01);
assert.deepEqual(clone(touchTrailApi.snapshot(1)), {
  x: 104,
  y: 50,
  sampleX: 100,
  color: '#ffb400',
  emoji: '🐶',
  pulseAt: 1,
  releasedAt: null,
  exitX: 0,
  exitY: -1,
  pointCount: 1,
});
touchTrailApi.move(1, 208, 100, 1.02);
assert.equal(
  touchTrailApi.snapshot(1).pointCount,
  2,
  'small pointer moves must accumulate into a visible trail sample',
);
touchTrailApi.move(1, 550, 300, 1.15);
assert.equal(touchTrailApi.snapshot(1).color, '#16c2a3');
assert.equal(touchTrailApi.snapshot(1).emoji, '🐱');
touchTrailApi.move(1, 800, 300, 1.2);
assert.deepEqual(clone(touchTrailApi.snapshot(1)), {
  x: 700,
  y: 250,
  sampleX: 700,
  color: '#3e7bfa',
  emoji: '🐔',
  pulseAt: 1,
  releasedAt: null,
  exitX: 0,
  exitY: -1,
  pointCount: 10,
});
touchTrailApi.begin(2, 250, 130, 1.2);
touchTrailApi.begin(3, 200, 100, 1.2);
touchTrailApi.move(3, 280, 100, 1.3);
touchTrailApi.release(3, 1.31);
touchTrailApi.pulse(1, 1.3);
touchTrailApi.release(1, 1.4);
touchTrailApi.releaseAll(1.5);
assert.equal(touchTrailApi.size(), 3);
assert.equal(touchTrailApi.snapshot(1).pulseAt, 1.3);
assert.equal(touchTrailApi.snapshot(1).releasedAt, 1.4);
assert.equal(touchTrailApi.snapshot(2).releasedAt, 1.5);
assert.deepEqual(
  clone({
    exitX: touchTrailApi.snapshot(3).exitX,
    exitY: touchTrailApi.snapshot(3).exitY,
  }),
  { exitX: 1, exitY: 0 },
  'emoji release must keep the latest swipe direction for its fly-out',
);
assert.match(
  extractFunction('drawTouchTrails'),
  /performanceSettings\.djMode\s*&&\s*djSettings\.trailStyle === 'emoji'/,
  'emoji trails must stay scoped to DJ mode',
);
assert.match(
  extractFunction('drawTouchEmoji'),
  /fillText\(emoji, 0, 0\)/,
  'emoji trails must draw the sound-matched glyph on the touch canvas',
);
assert.match(
  extractFunction('drawTouchTrails'),
  /TOUCH_TRAIL_EXIT_DISTANCE \* exitProgress/,
  'emoji release must accelerate away from the finger while fading',
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
  function releaseTouchTrail() {}
  function releaseAllTouchTrails() {}
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
console.log('- the grid setting controls DJ cell boundaries while deck structure remains active');
console.log('- multi-pointer touch trails follow movement, cap history, pulse, and release independently');
console.log('- emoji trails map each deck sound and fly along the last swipe on release');
