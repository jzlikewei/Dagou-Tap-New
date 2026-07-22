#!/usr/bin/env node

// Executes the production phrase generator and timing helpers so the
// Fixed one-minute duration, 1–3 lanes, vocal motifs, doubles, and legato chains.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const htmlSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const candidates = [`async function ${name}(`, `function ${name}(`];
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
  const end = mainSource.indexOf(';', start);
  assert.ok(end > start, `Cannot find end of constant ${name}`);
  return mainSource.slice(start, end + 1);
}

const sandbox = {};
vm.runInNewContext(
  `
  const BPM = 128;
  const SPB = 60 / BPM;
  const S8 = SPB / 2;
  ${extractConst('RHYTHM_GAME_BAR_COUNT')}
  ${extractConst('RHYTHM_GAME_PHRASE_BARS')}
  ${extractConst('RHYTHM_GAME_PERFECT_WINDOW')}
  ${extractConst('RHYTHM_GAME_GOOD_WINDOW')}
  ${extractConst('RHYTHM_GAME_SLIDE_GOOD_WINDOW')}
  ${extractConst('RHYTHM_GAME_AUTOPLAY_TAP_DURATION')}
  ${extractConst('RHYTHM_GAME_AUTOPLAY_CONNECTED_DURATION')}
  ${extractConst('RHYTHM_GAME_PHRASE_TAIL_MIN_STEPS')}
  ${extractConst('RHYTHM_GAME_PHRASE_TAIL_MAX_STEPS')}
  ${extractConst('RHYTHM_GAME_PHRASE_TEMPLATES')}
  ${extractFunction('getRhythmGameZoneKey')}
  ${extractFunction('createRhythmGameChart')}
  ${extractFunction('classifyRhythmGameTiming')}
  ${extractFunction('classifyRhythmGameSlideTiming')}
  ${extractFunction('getRhythmGameGrade')}
  ${extractFunction('formatRhythmGameTime')}

  globalThis.rhythmGameApi = {
    SPB,
    S8,
    RHYTHM_GAME_BAR_COUNT,
    RHYTHM_GAME_AUTOPLAY_TAP_DURATION,
    RHYTHM_GAME_AUTOPLAY_CONNECTED_DURATION,
    createRhythmGameChart,
    classifyRhythmGameTiming,
    classifyRhythmGameSlideTiming,
    getRhythmGameGrade,
    formatRhythmGameTime,
  };
  `,
  sandbox,
);

const api = sandbox.rhythmGameApi;
const plain = value => JSON.parse(JSON.stringify(value));

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeZones(deckSlots) {
  const sfxIds = ['dagou', 'hajimi', 'dingdong'];
  const notes = [];
  for (const deckSlot of deckSlots) {
    for (let localRow = 0; localRow < 3; localRow++) {
      for (let localColumn = 0; localColumn < 4; localColumn++) {
        notes.push({
          deckSlot,
          localRow,
          localColumn,
          sfxId: sfxIds[deckSlot],
          keyboardLabel: `${deckSlot}${localRow}${localColumn}`,
        });
      }
    }
  }
  return notes;
}

function verifyChart(deckSlots, seed) {
  const zones = makeZones(deckSlots);
  const chart = plain(api.createRhythmGameChart(zones, seededRandom(seed)));
  assert.equal(chart.duration, 60);
  assert.equal(chart.barCount, api.RHYTHM_GAME_BAR_COUNT);
  assert.equal(chart.duration, chart.barCount * api.SPB * 4);
  assert.equal(chart.barCount % 4, 0);
  assert.equal(chart.phraseGroupCount, chart.barCount / 4);
  assert.ok(chart.notes.length > 0);
  assert.ok(chart.notes.some(note => note.kind === 'hold'));
  if (deckSlots.length > 1) {
    assert.ok(chart.notes.some(note => note.chordId));
  }

  const zoneKeys = new Set(zones.map(zone =>
    `${zone.deckSlot}:${zone.localRow}:${zone.localColumn}`
  ));
  let previousTime = -Infinity;
  for (const note of chart.notes) {
    assert.ok(zoneKeys.has(note.zoneKey));
    assert.ok(deckSlots.includes(note.deckSlot));
    assert.ok(note.localRow >= 0 && note.localRow < 3);
    assert.ok(note.localColumn >= 0 && note.localColumn < 4);
    assert.ok(note.time >= previousTime);
    assert.ok(Math.abs(note.time / api.S8 - Math.round(note.time / api.S8)) < 1e-8);
    assert.ok(['short', 'connected', 'sustain', 'legato'].includes(
      note.articulation
    ));
    previousTime = note.time;
    if (note.kind === 'hold') {
      assert.equal(note.localRow, 2);
      assert.ok(note.duration >= api.S8 * 2);
      assert.ok(note.endTime <= chart.duration + 1e-8);
      assert.ok([0, 2].includes(note.slideTargets.length));
      assert.ok(['sustain', 'legato'].includes(note.articulation));
      if (
        note.slideTargets.length === 0 &&
        note.duration > api.SPB + 0.01
      ) {
        assert.ok(note.holdTickTimes.length > 0);
      }
      let previousColumn = note.localColumn;
      for (const slideTarget of note.slideTargets) {
        assert.equal(slideTarget.deckSlot, note.deckSlot);
        assert.equal(slideTarget.localRow, 2);
        assert.equal(Math.abs(slideTarget.localColumn - previousColumn), 1);
        assert.ok(slideTarget.time > note.time);
        assert.ok(slideTarget.time < note.endTime);
        previousColumn = slideTarget.localColumn;
      }
    } else {
      assert.ok(note.autoplayDuration >= api.RHYTHM_GAME_AUTOPLAY_TAP_DURATION);
      if (note.articulation === 'connected') {
        assert.equal(
          note.autoplayDuration,
          api.RHYTHM_GAME_AUTOPLAY_CONNECTED_DURATION
        );
      }
    }
  }

  const phraseRows = new Map([
    ['大狗叫', [0, 1, 2]],
    ['大狗大狗叫叫叫', [0, 1, 0, 1, 2, 2, 2]],
    ['大狗叫叫', [0, 1, 2, 2]],
    ['大狗大狗叫', [0, 1, 0, 1, 2]],
    ['叮咚叮咚鸡', [0, 1, 0, 1, 2]],
    ['叮咚鸡', [0, 1, 2]],
    ['叮咚鸡鸡', [0, 1, 2, 2]],
    ['叮叮咚鸡', [0, 0, 1, 2]],
    ['哈基米', [0, 1, 2]],
    ['哈基哈基米米米', [0, 1, 0, 1, 2, 2, 2]],
    ['哈基米米', [0, 1, 2, 2]],
    ['哈基哈基米', [0, 1, 0, 1, 2]],
  ]);
  const phraseInstances = new Map();
  for (const note of chart.notes.filter(note => note.phraseId && note.phraseTokenIndex !== null)) {
    const phraseNotes = phraseInstances.get(note.phraseId) ?? [];
    phraseNotes.push(note);
    phraseInstances.set(note.phraseId, phraseNotes);
  }
  assert.ok(phraseInstances.size >= chart.phraseGroupCount * 3);
  for (const phraseNotes of phraseInstances.values()) {
    phraseNotes.sort((left, right) => left.phraseTokenIndex - right.phraseTokenIndex);
    const expectedRows = phraseRows.get(phraseNotes[0].phraseText);
    assert.deepEqual(phraseNotes.map(note => note.localRow), expectedRows);
    assert.ok(phraseNotes.every(note => note.deckSlot === phraseNotes[0].deckSlot));
    for (let index = 1; index < phraseNotes.length; index++) {
      assert.ok(
        Math.abs(
          phraseNotes[index].localColumn - phraseNotes[index - 1].localColumn
        ) <= 1
      );
      assert.ok(phraseNotes[index].time > phraseNotes[index - 1].time);
    }
  }

  const chordGroups = new Map();
  for (const note of chart.notes.filter(note => note.chordId)) {
    const group = chordGroups.get(note.chordId) ?? [];
    group.push(note);
    chordGroups.set(note.chordId, group);
  }
  for (const group of chordGroups.values()) {
    assert.equal(group.length, 2);
    assert.equal(group[0].time, group[1].time);
    assert.notEqual(group[0].deckSlot, group[1].deckSlot);
  }

  const holds = chart.notes.filter(note => note.kind === 'hold');
  assert.ok(holds.length >= chart.phraseGroupCount * 2);
  assert.ok(holds.length <= chart.phraseGroupCount * 3);
  assert.ok(
    holds.reduce((total, note) => total + note.duration, 0) >=
      chart.duration * 0.24
  );
  assert.ok(chart.notes.some(note => note.articulation === 'connected'));
  assert.ok(holds.some(note => note.slideTargets.length === 2));
  assert.ok(holds.some(note => note.slideTargets.length === 0));
  for (const hold of holds) {
    const overlapping = chart.notes.filter(note =>
      note.id !== hold.id &&
      note.time > hold.time &&
      note.time < hold.endTime - 1e-8
    );
    assert.ok(overlapping.every(note => note.deckSlot !== hold.deckSlot));
    assert.ok(overlapping.every(note => !note.chordId));
  }

  const eventTimes = [...new Set(chart.notes.map(note => note.time))];
  for (const time of eventTimes) {
    const heldContacts = holds.filter(
      hold => hold.time <= time && hold.endTime > time
    ).length;
    const tapContacts = chart.notes.filter(
      note => note.kind === 'tap' && note.time === time
    ).length;
    assert.ok(heldContacts + tapContacts <= 2);
  }

  const expectedJudgements = chart.notes.reduce(
    (total, note) => total + (
      note.kind === 'hold'
        ? 2 + note.holdTickTimes.length + note.slideTargets.length
        : 1
    ),
    0
  );
  assert.equal(chart.totalJudgements, expectedJudgements);
  const sectionRoles = new Set(
    chart.notes.map(note => String(note.phraseRole ?? '').split('-')[0])
  );
  for (const role of ['theme', 'dialogue', 'lift', 'resolve']) {
    assert.ok(sectionRoles.has(role));
  }
  return chart;
}

const oneLaneChart = verifyChart([0], 0x1d1d1d1d);
const twoLaneChart = verifyChart([0, 2], 0x2d2d2d2d);
const threeLaneChart = verifyChart([0, 1, 2], 0x3d3d3d3d);
for (const chart of [twoLaneChart, threeLaneChart]) {
  const phraseTexts = new Set(chart.notes.map(note => note.phraseText));
  assert.ok(phraseTexts.has('大狗叫'));
  assert.ok(phraseTexts.has('大狗大狗叫叫叫'));
  assert.ok(phraseTexts.has('叮咚叮咚鸡'));
}
for (let seed = 1; seed <= 12; seed++) {
  verifyChart([0], seed * 0x10101);
  verifyChart([0, 2], seed * 0x10203);
  verifyChart([0, 1, 2], seed * 0x30405);
}
assert.ok(new Set(oneLaneChart.notes.map(note => note.zoneKey)).size <= 12);
assert.ok(new Set(twoLaneChart.notes.map(note => note.zoneKey)).size <= 24);
assert.ok(new Set(threeLaneChart.notes.map(note => note.zoneKey)).size <= 36);
assert.equal(
  plain(api.createRhythmGameChart(makeZones([0]), () => 0)).duration,
  60,
);
assert.equal(
  plain(api.createRhythmGameChart(makeZones([0, 1, 2]), () => 0.999999)).duration,
  60,
);

assert.equal(api.classifyRhythmGameTiming(0), 'perfect');
assert.equal(api.classifyRhythmGameTiming(0.11), 'perfect');
assert.equal(api.classifyRhythmGameTiming(-0.24), 'good');
assert.equal(api.classifyRhythmGameTiming(0.241), null);
assert.equal(api.classifyRhythmGameSlideTiming(0.11), 'perfect');
assert.equal(api.classifyRhythmGameSlideTiming(-0.32), 'good');
assert.equal(api.classifyRhythmGameSlideTiming(0.321), null);
assert.equal(api.getRhythmGameGrade(0.96), 'S');
assert.equal(api.getRhythmGameGrade(0.9), 'A');
assert.equal(api.getRhythmGameGrade(0.78), 'B');
assert.equal(api.getRhythmGameGrade(0.65), 'C');
assert.equal(api.getRhythmGameGrade(0.64), 'D');
assert.equal(api.formatRhythmGameTime(60), '1:00');
assert.equal(api.formatRhythmGameTime(59.2), '1:00');

const holdSandbox = {};
vm.runInNewContext(
  `
  const RHYTHM_GAME_PERFECT_WINDOW = 0.11;
  const RHYTHM_GAME_GOOD_WINDOW = 0.24;
  const rhythmGame = {
    startAt: 10,
    activeHolds: new Map(),
    score: 0,
    combo: 0,
    maxCombo: 0,
    perfect: 0,
    good: 0,
    miss: 0,
  };
  const ctx = { currentTime: 10 };
  function showRhythmGameJudgement() {}
  function updateRhythmGameHud() {}
  function completeRhythmGameCue(note, judgement, elapsed) {
    note.status = 'done';
    note.completedAs = judgement;
    note.judgedAt = elapsed;
  }
  ${extractFunction('classifyRhythmGameTiming')}
  ${extractFunction('awardRhythmGameHit')}
  ${extractFunction('addRhythmGameMisses')}
  ${extractFunction('scoreDueRhythmGameHoldTicks')}
  ${extractFunction('finishRhythmGameHold')}
  ${extractFunction('releaseRhythmGameHold')}

  function run(releaseAt, cancelled = false) {
    rhythmGame.activeHolds.clear();
    rhythmGame.score = 0;
    rhythmGame.combo = 0;
    rhythmGame.maxCombo = 0;
    rhythmGame.perfect = 0;
    rhythmGame.good = 0;
    rhythmGame.miss = 0;
    const note = {
      status: 'holding',
      inputId: 'finger-1',
      endTime: 2,
      holdTickTimes: [0.5, 1, 1.5],
      nextHoldTickIndex: 0,
      slideTargets: [],
      nextSlideIndex: 0,
      releaseJudgement: null,
    };
    rhythmGame.activeHolds.set(note.inputId, note);
    awardRhythmGameHit('perfect', 1000, 650, false);
    ctx.currentTime = rhythmGame.startAt + releaseAt;
    releaseRhythmGameHold(note.inputId, cancelled);
    return {
      status: note.status,
      completedAs: note.completedAs,
      releaseJudgement: note.releaseJudgement,
      perfect: rhythmGame.perfect,
      good: rhythmGame.good,
      miss: rhythmGame.miss,
      combo: rhythmGame.combo,
      maxCombo: rhythmGame.maxCombo,
      activeHoldCount: rhythmGame.activeHolds.size,
    };
  }
  globalThis.holdApi = { run };
  `,
  holdSandbox,
);

assert.deepEqual(plain(holdSandbox.holdApi.run(2.05)), {
  status: 'done',
  completedAs: 'perfect',
  releaseJudgement: 'perfect',
  perfect: 5,
  good: 0,
  miss: 0,
  combo: 5,
  maxCombo: 5,
  activeHoldCount: 0,
});
assert.deepEqual(plain(holdSandbox.holdApi.run(0.8)), {
  status: 'done',
  completedAs: 'miss',
  releaseJudgement: null,
  perfect: 2,
  good: 0,
  miss: 3,
  combo: 0,
  maxCombo: 2,
  activeHoldCount: 0,
});
assert.deepEqual(plain(holdSandbox.holdApi.run(2.3)), {
  status: 'done',
  completedAs: 'miss',
  releaseJudgement: null,
  perfect: 4,
  good: 0,
  miss: 1,
  combo: 0,
  maxCombo: 4,
  activeHoldCount: 0,
});

const slideSandbox = {};
vm.runInNewContext(
  `
  const RHYTHM_GAME_PERFECT_WINDOW = 0.11;
  const RHYTHM_GAME_SLIDE_GOOD_WINDOW = 0.32;
  const acceptedHits = [];
  const releasedInputs = [];
  const rhythmGame = {
    startAt: 10,
    activeHolds: new Map(),
  };
  const ctx = { currentTime: 11.05 };
  const zones = [
    { deckSlot: 0, localRow: 2, localColumn: 0 },
    { deckSlot: 0, localRow: 2, localColumn: 1 },
    { deckSlot: 0, localRow: 2, localColumn: 3 },
  ];
  function setRhythmGameCueTarget(note, target) {
    note.displayZoneKey = target.zoneKey;
  }
  function awardRhythmGameHit(judgement) { acceptedHits.push(judgement); }
  function showRhythmGameJudgement() {}
  function updateRhythmGameHud() {}
  function releaseRhythmGameHold(inputId) {
    releasedInputs.push(inputId);
    rhythmGame.activeHolds.delete(inputId);
  }
  ${extractFunction('getRhythmGameZoneKey')}
  ${extractFunction('classifyRhythmGameSlideTiming')}
  ${extractFunction('handleRhythmGameHoldZoneChange')}

  const acceptedNote = {
    currentZoneKey: '0:2:0',
    nextSlideIndex: 0,
    slideTargets: [{
      zoneKey: '0:2:1',
      time: 1,
      keyboardLabel: 'S',
    }],
  };
  rhythmGame.activeHolds.set('finger:accepted', acceptedNote);
  const accepted = handleRhythmGameHoldZoneChange('finger:accepted', 1);

  const rejectedNote = {
    currentZoneKey: '0:2:0',
    nextSlideIndex: 0,
    slideTargets: [{ zoneKey: '0:2:1', time: 1 }],
  };
  rhythmGame.activeHolds.set('finger:rejected', rejectedNote);
  const rejected = handleRhythmGameHoldZoneChange('finger:rejected', 2);

  globalThis.slideResult = {
    accepted,
    acceptedHits,
    acceptedIndex: acceptedNote.nextSlideIndex,
    acceptedZoneKey: acceptedNote.currentZoneKey,
    rejected,
    releasedInputs,
  };
  `,
  slideSandbox,
);

assert.deepEqual(plain(slideSandbox.slideResult), {
  accepted: true,
  acceptedHits: ['perfect'],
  acceptedIndex: 1,
  acceptedZoneKey: '0:2:1',
  rejected: false,
  releasedInputs: ['finger:rejected'],
});

for (const id of [
  'rhythm-game-mode-setting',
  'rhythm-game-settings',
  'rhythm-game-launch',
  'rhythm-game-autoplay-launch',
  'rhythm-game-auto-badge',
  'rhythm-game-cues',
  'rhythm-game-hud',
  'rhythm-game-results',
]) {
  assert.match(htmlSource, new RegExp(`id="${id}"`));
}
for (const laneCount of [1, 2, 3]) {
  assert.match(
    htmlSource,
    new RegExp(`data-rhythm-lane-count="${laneCount}"`),
  );
}
assert.match(
  mainSource,
  /async function startRhythmGame\(\{ autoplay = false \} = \{\}\) \{[\s\S]*?performanceSettings\.rhythmGameMode/,
);
assert.match(
  extractFunction('renderRhythmGameLaunch'),
  /fixed|固定 1:00|rhythmGameSettings\.laneCount/,
);
assert.match(
  htmlSource,
  /#stage\.is-rhythm-game #fx \{ opacity: \.9; \}/,
);
assert.match(
  htmlSource,
  /#stage\.is-rhythm-game #touch-fx \{ opacity: \.76; \}/,
);
assert.match(
  htmlSource,
  /#stage\.is-rhythm-game \.zone-flash[\s\S]*rhythmZoneFade \.38s/,
);
assert.match(
  htmlSource,
  /\.rhythm-zone-image[\s\S]*rhythmZoneImagePop \.38s/,
);
assert.match(
  extractFunction('drawTouchTrails'),
  /drawRhythmGameTouchFeedback\(now, characterMode\)/,
);
assert.match(
  extractFunction('drawRhythmGameTouchFeedback'),
  /const radius = 8 \+ easeOutCubic\(pulseProgress\) \* 18[\s\S]*drawTouchRing\([\s\S]*if \(characterMode\)/,
);
assert.match(
  extractFunction('scheduleActivationVisual'),
  /const quietFeedback = isRhythmGameActive\(\)[\s\S]*spawnRhythmGameEffect\(zi, ctx\.currentTime, deckId\)/,
);
assert.match(
  extractConst('RHYTHM_GAME_EFFECTS'),
  /'confetti'[\s\S]*'zigzag'[\s\S]*'pop'[\s\S]*'stars'/,
);
assert.match(
  extractFunction('spawnRhythmGameEffect'),
  /Math\.floor\(Math\.random\(\) \* RHYTHM_GAME_EFFECTS\.length\)[\s\S]*scale: RHYTHM_GAME_EFFECT_SCALE[\s\S]*life: RHYTHM_GAME_EFFECT_LIFE/,
);
assert.match(
  extractFunction('flashZone'),
  /CHARACTER_IMAGE_SETS\[sfxId\][\s\S]*image\.src = character\.open[\s\S]*el\.appendChild\(image\)/,
);
assert.match(
  extractFunction('fxFrame'),
  /const sc = inst\.scale \* exitScale/,
);
assert.match(
  mainSource,
  /async function startRhythmGame\([\s\S]*?clearPerformanceVisualEffects\(\)/,
);
assert.match(
  extractFunction('enterZone'),
  /handleRhythmGameHoldZoneChange\(pointerId, zi\)/,
);
assert.match(
  extractFunction('endInput'),
  /releaseRhythmGameHold\(pointerId, !musical\)/,
);
assert.match(
  extractFunction('beginKeyboardInput'),
  /judgeRhythmGameInput\(zi, pointerId\)/,
);
assert.match(
  extractFunction('beginKeyboardInput'),
  /routeRhythmGameKeyboardSlide\(zi\)/,
);
assert.match(
  extractFunction('routeRhythmGameKeyboardSlide'),
  /slideTarget\?\.zoneKey === zoneKey/,
);
assert.match(
  mainSource,
  /judgeRhythmGameInput\(zoneIndex\(e\.clientX, e\.clientY\), e\.pointerId\)/,
);

const autoplaySandbox = {};
vm.runInNewContext(
  `
  const RHYTHM_GAME_AUTOPLAY_LOOKAHEAD = 0.025;
  const RHYTHM_GAME_AUTOPLAY_INPUT_PREFIX = 'rhythm-autoplay:';
  const started = [];
  const ended = [];
  const rhythmGame = {
    autoplay: true,
    nextAutoplayIndex: 0,
    notes: [
      { id: 1, time: 1, status: 'pending' },
      { id: 2, time: 1.2, status: 'pending' },
    ],
    autoplayTapReleases: [
      { inputId: 'rhythm-autoplay:tap', time: 0.9 },
    ],
    activeHolds: new Map([
      ['rhythm-autoplay:hold', {
        endTime: 1,
        slideTargets: [],
        nextSlideIndex: 0,
      }],
      ['rhythm-autoplay:slide', {
        endTime: 1.5,
        slideTargets: [{ time: 1, zoneKey: '0:2:1' }],
        nextSlideIndex: 0,
      }],
      ['finger:manual', {
        endTime: 1,
        slideTargets: [],
        nextSlideIndex: 0,
      }],
    ]),
  };
  const pointers = new Map([
    ['rhythm-autoplay:slide', { zone: 0, lastX: 0, lastY: 0 }],
  ]);
  const moved = [];
  function endInput(inputId, musical) {
    ended.push({ inputId, musical });
    rhythmGame.activeHolds.delete(inputId);
  }
  function resolveRhythmGameZoneIndex() { return 7; }
  function getRhythmGameZoneCenter() { return { x: 70, y: 30 }; }
  function moveTouchTrail(inputId, x, y) { moved.push({ inputId, x, y }); }
  function enterZone(inputId, state, zoneIndexValue) {
    state.zone = zoneIndexValue;
    rhythmGame.activeHolds.get(inputId).nextSlideIndex++;
  }
  function startRhythmGameAutoplayNote(note) {
    started.push(note.id);
    note.status = 'done';
  }
  ${extractFunction('isRhythmGameAutoplayInput')}
  ${extractFunction('updateRhythmGameAutoplay')}

  updateRhythmGameAutoplay(0.98);
  globalThis.autoplayResult = {
    started,
    ended,
    nextAutoplayIndex: rhythmGame.nextAutoplayIndex,
    pendingReleases: rhythmGame.autoplayTapReleases.length,
    manualHoldKept: rhythmGame.activeHolds.has('finger:manual'),
    slideAdvanced: rhythmGame.activeHolds.get('rhythm-autoplay:slide')?.nextSlideIndex,
    moved,
  };
  `,
  autoplaySandbox,
);

assert.deepEqual(plain(autoplaySandbox.autoplayResult), {
  started: [1],
  ended: [
    { inputId: 'rhythm-autoplay:tap', musical: true },
    { inputId: 'rhythm-autoplay:hold', musical: true },
  ],
  nextAutoplayIndex: 1,
  pendingReleases: 0,
  manualHoldKept: true,
  slideAdvanced: 1,
  moved: [{ inputId: 'rhythm-autoplay:slide', x: 70, y: 30 }],
});
assert.match(
  extractFunction('startRhythmGameAutoplayNote'),
  /judgeRhythmGameInput\(zoneIndexValue, inputId\)/,
);
assert.match(
  extractFunction('startRhythmGameAutoplayNote'),
  /beginTouchTrail\(inputId, center\.x, center\.y\)/,
);
assert.match(
  extractFunction('startRhythmGameAutoplayNote'),
  /enterZone\(inputId, state, zoneIndexValue\)/,
);
assert.match(
  extractFunction('startRhythmGameAutoplayNote'),
  /note\.autoplayDuration \?\? RHYTHM_GAME_AUTOPLAY_TAP_DURATION/,
);

console.log('Rhythm game verification passed:');
console.log('- every generated chart stays fixed at one minute on the 128 BPM grid');
console.log('- 大狗叫、大狗大狗叫叫叫、叮咚叮咚鸡 keep their exact syllable order');
console.log('- theme, dialogue, lift, and resolve sections rotate phrase roles and grooves');
console.log('- phrase pitches move only to the same or an adjacent column');
console.log('- one, two, and three lane layouts target complete 4 × 3 cell sets');
console.log('- double notes use two different lanes at one timestamp');
console.log('- each four-bar section carries two or three sustained phrase endings');
console.log('- connected taps use longer AUTO gates while true holds retain release judgement');
console.log('- sustained holds and legato chains stay on the sustain row');
console.log('- generated charts never require more than two simultaneous contacts');
console.log('- rhythm mode randomizes four short-range effects and colors the full hit cell with its character');
console.log('- press, slide checkpoints, release timing, pointer, and keyboard hooks are present');
console.log('- AUTO mode schedules short presses, slides, double notes, and timed releases');
