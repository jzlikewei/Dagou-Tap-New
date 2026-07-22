#!/usr/bin/env node

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
  const end = mainSource.indexOf(';\n', start);
  assert.ok(end > start, `Cannot find end of constant ${name}`);
  return mainSource.slice(start, end + 1);
}

assert.match(
  htmlSource,
  /id="dj-recorder-dock"[\s\S]*id="dj-recorder-open"[^>]*>录制&amp;分享</,
  'the stage toolbar must expose one recording and sharing entry',
);
assert.match(
  htmlSource,
  /#dj-recorder-dock\s*\{[\s\S]*?position: absolute;[\s\S]*?left: 50%;[\s\S]*?transform: translateX\(-50%\);/,
  'the recording and sharing entry must stay centered independently',
);
const settingsOverlayIndex = htmlSource.indexOf('id="settings-overlay"');
const recorderDockIndex = htmlSource.indexOf('id="dj-recorder-dock"');
const recorderOverlayIndex = htmlSource.indexOf('id="dj-recorder-overlay"');
assert.ok(
  recorderDockIndex >= 0 && recorderOverlayIndex > recorderDockIndex &&
    recorderOverlayIndex < settingsOverlayIndex,
  'the recording dialog must stay outside the settings overlay',
);
assert.match(
  htmlSource,
  /data-dj-recorder-tab="record"[\s\S]*data-dj-recorder-tab="import"/,
  'the recording dialog must provide recording and import tabs',
);
assert.match(
  htmlSource,
  /data-dj-recording-seconds="30"[^>]*>30 秒<[\s\S]*data-dj-recording-seconds="60"[^>]*>60 秒</,
  'recording duration must default to 30 seconds and offer 60 seconds',
);
assert.match(
  htmlSource,
  /id="dj-recording-code"[^>]*maxlength="32768"/,
  'the import field must enforce the format size limit',
);
assert.match(
  htmlSource,
  /id="dj-recording-share-code"[^>]*readonly/,
  'recorded share codes must remain visible and selectable',
);
assert.match(
  htmlSource,
  /id="dj-recording-loop"[^>]*role="switch"[\s\S]*id="dj-recording-import-play"/,
  'imports must provide loop playback and a dedicated play control',
);
assert.match(
  htmlSource,
  /id="dj-transport-hud"[\s\S]*待机 · 0:30/,
  'the stage transport must show the default 30-second limit',
);
assert.match(
  extractConst('DJ_RECORDING_DEFAULT_SECONDS'),
  /= 30/,
  'recording must default to 30 seconds',
);
assert.match(
  extractConst('DJ_RECORDING_DURATION_OPTIONS'),
  /\[30, 60\]/,
  'recording must support exactly 30 and 60 second choices',
);
assert.match(
  extractConst('DJ_RECORDING_END_WARNING_SECONDS'),
  /= 5/,
  'recording must warn during its final five seconds',
);
assert.match(
  extractFunction('renderDjTransportHud'),
  /remaining <= DJ_RECORDING_END_WARNING_SECONDS[\s\S]*is-ending[\s\S]*即将结束[\s\S]*Math\.ceil\(remaining\)/,
  'the recording HUD must show a visible whole-second countdown',
);
assert.match(
  htmlSource,
  /#dj-transport-hud\.is-ending\s*\{[\s\S]*?animation: djRecordingEndingPulse/,
  'the final recording countdown must receive a prominent visual treatment',
);
assert.match(
  extractFunction('scheduler'),
  /scheduleDjPlaybackEvents\(ctx\.currentTime \+ INPUT_LOOKAHEAD\)/,
  'playback events must use the Web Audio lookahead scheduler',
);
assert.match(
  extractFunction('scheduleDjPlaybackEvents'),
  /isDjPlaybackLoopEnabled\(\)[\s\S]*nextCycleStartAt[\s\S]*playbackIndex = 0/,
  'loop playback must restart imported events on the audio clock',
);
assert.match(
  extractFunction('updateDjTransport'),
  /startAt \+ djTransport\.recordingLimitSeconds/,
  'automatic recording stop must use the selected duration',
);
assert.match(
  extractFunction('playQueuedInput'),
  /recordDjRetune\([\s\S]*recordDjNoteStart\(/,
  'the final scheduled notes and sustain retunes must feed the recorder',
);
assert.match(
  extractFunction('releaseVoice'),
  /releaseAt = ctx\.currentTime[\s\S]*recordDjVoiceRelease\(voice, now\)/,
  'release timing must be recorded on the audio clock',
);
assert.match(
  mainSource,
  /function stopDjPlayback\([\s\S]*?stopDjPlaybackOneShot\(oneShot\)/,
  'manual playback stop must also fade scheduled one-shot samples',
);
assert.match(
  mainSource,
  /stage\.addEventListener\('pointerdown',[\s\S]*djTransport\.phase === 'playing'/,
  'manual stage input must stay blocked during exact playback',
);

const codecSandbox = {
  Uint8Array,
  btoa(binary) {
    return Buffer.from(binary, 'binary').toString('base64');
  },
  atob(encoded) {
    return Buffer.from(encoded, 'base64').toString('binary');
  },
};

vm.runInNewContext(
  `
  ${extractConst('BPM')}
  ${extractConst('DJ_RECORDING_MAX_SECONDS')}
  ${extractConst('DJ_RECORDING_MAX_NOTES')}
  ${extractConst('DJ_RECORDING_MAX_CODE_LENGTH')}
  ${extractConst('DJ_RECORDING_TIME_UNITS_PER_BEAT')}
  ${extractConst('DJ_RECORDING_SNAP_UNITS')}
  ${extractConst('DJ_RECORDING_LOOP_UNITS')}
  ${extractConst('DJ_RECORDING_FORMAT_VERSION')}
  ${extractConst('DJ_RECORDING_SFX_CODES')}
  ${extractConst('DJ_RECORDING_SFX_IDS')}
  ${extractFunction('writeDjRecordingVarUint')}
  ${extractFunction('readDjRecordingVarUint')}
  ${extractFunction('djRecordingCrc32')}
  ${extractFunction('appendDjRecordingCrc')}
  ${extractFunction('verifyDjRecordingCrc')}
  ${extractFunction('compressDjRecordingBytes')}
  ${extractFunction('decompressDjRecordingBytes')}
  ${extractFunction('djRecordingBytesToBase64Url')}
  ${extractFunction('djRecordingBase64UrlToBytes')}
  ${extractFunction('isValidDjRecordingZone')}
  ${extractFunction('writeDjRecordingNotes')}
  ${extractFunction('readDjRecordingNotes')}
  ${extractFunction('encodeDjRecording')}
  ${extractFunction('decodeDjRecording')}
  ${extractFunction('buildDjPlaybackEvents')}

  function encodeLegacyDjRecording(track) {
    const bytes = [];
    const flags =
      (track.rhythmSnap ? 1 : 0) |
      (track.deckCount === 3 ? 2 : 0) |
      (track.trailStyle === 'emoji' ? 4 : 0) |
      (track.spatialAudio ? 8 : 0);
    const sfxCodes = track.deckSfxIds.map(
      sfxId => DJ_RECORDING_SFX_CODES[sfxId]
    );
    bytes.push(flags);
    bytes.push(sfxCodes[0] | sfxCodes[1] << 2 | sfxCodes[2] << 4);
    bytes.push(track.bpm);
    bytes.push(Math.max(0, Math.min(
      255,
      Math.round((track.soundFieldPosition + 1) * 127.5)
    )));
    writeDjRecordingVarUint(bytes, track.phaseUnits);
    writeDjRecordingVarUint(bytes, track.durationUnits);
    writeDjRecordingVarUint(bytes, track.notes.length);
    writeDjRecordingNotes(bytes, track);
    return 'DGT1R.' + djRecordingBytesToBase64Url(
      appendDjRecordingCrc(Uint8Array.from(bytes))
    );
  }

  function inspectDgt2Header(code) {
    const match = code.match(/^DGT2([RZ])\\.([A-Za-z0-9_-]+)$/);
    let raw = djRecordingBase64UrlToBytes(match[2]);
    if (match[1] === 'Z') raw = decompressDjRecordingBytes(raw);
    const bytes = verifyDjRecordingCrc(raw);
    const cursor = { index: 2 };
    if (bytes[0] & 1) cursor.index++;
    else readDjRecordingVarUint(bytes, cursor);
    readDjRecordingVarUint(bytes, cursor);
    return { flags: bytes[0], length: cursor.index };
  }

  globalThis.recordingApi = {
    encode: encodeDjRecording,
    decode: decodeDjRecording,
    encodeLegacy: encodeLegacyDjRecording,
    inspectHeader: inspectDgt2Header,
    events: buildDjPlaybackEvents,
    limits: {
      seconds: DJ_RECORDING_MAX_SECONDS,
      notes: DJ_RECORDING_MAX_NOTES,
      codeLength: DJ_RECORDING_MAX_CODE_LENGTH,
      unitsPerBeat: DJ_RECORDING_TIME_UNITS_PER_BEAT,
    },
  };
  `,
  codecSandbox,
);

const recording = codecSandbox.recordingApi;
const clone = value => JSON.parse(JSON.stringify(value));
const units90Seconds = 196608;

assert.deepEqual(clone(recording.limits), {
  seconds: 90,
  notes: 5000,
  codeLength: 32768,
  unitsPerBeat: 1024,
});

const preciseTrack = {
  version: 2,
  bpm: 128,
  rhythmSnap: true,
  deckCount: 3,
  deckSfxIds: ['dagou', 'hajimi', 'dingdong'],
  trailStyle: 'emoji',
  spatialAudio: true,
  phaseUnits: 3584,
  durationUnits: units90Seconds,
  notes: [
    { startUnits: 0, zone: 0, gateUnits: null, retunes: [] },
    { startUnits: 512, zone: 4, gateUnits: null, retunes: [] },
    {
      startUnits: 1024,
      zone: 8,
      gateUnits: 4096,
      retunes: [
        { offsetUnits: 1024, zone: 9 },
        { offsetUnits: 2048, zone: 11 },
      ],
    },
    {
      startUnits: 1024,
      zone: 20,
      gateUnits: 1024,
      retunes: [],
    },
    { startUnits: 196096, zone: 28, gateUnits: null, retunes: [] },
  ],
};

const preciseCode = recording.encode(preciseTrack);
assert.match(preciseCode, /^DGT2[RZ]\.[A-Za-z0-9_-]+$/);
assert.ok(preciseCode.length <= recording.limits.codeLength);
const preciseHeader = clone(recording.inspectHeader(preciseCode));
assert.equal(preciseHeader.length, 6, 'the snapped 90-second header must use 6 bytes');
assert.equal(preciseHeader.flags & 8, 8, '3D audio must occupy one flag bit');
const decodedPrecise = clone(recording.decode(preciseCode));
assert.equal(decodedPrecise.version, 2);
assert.equal(decodedPrecise.durationUnits, units90Seconds);
assert.equal(decodedPrecise.rhythmSnap, true);
assert.equal(decodedPrecise.deckCount, 3);
assert.deepEqual(decodedPrecise.deckSfxIds, preciseTrack.deckSfxIds);
assert.equal(decodedPrecise.trailStyle, 'emoji');
assert.equal(decodedPrecise.spatialAudio, true);
assert.equal('soundFieldPosition' in decodedPrecise, false);
assert.deepEqual(decodedPrecise.notes, preciseTrack.notes);

const legacyCode = recording.encodeLegacy({
  ...preciseTrack,
  version: 1,
  soundFieldPosition: 0.24,
});
assert.match(legacyCode, /^DGT1R\./);
assert.ok(preciseCode.length < legacyCode.length, 'DGT2 must shorten the DGT1 payload');
const decodedLegacy = clone(recording.decode(legacyCode));
assert.equal(decodedLegacy.version, 1);
assert.equal(decodedLegacy.spatialAudio, true);
assert.equal('soundFieldPosition' in decodedLegacy, false);
assert.deepEqual(decodedLegacy.notes, preciseTrack.notes);

const events = clone(recording.events(decodedPrecise));
assert.deepEqual(
  events.filter(event => event.units === 1024).map(event => event.kind),
  ['press', 'press'],
  'simultaneous notes must remain simultaneous press events',
);
assert.deepEqual(
  events.filter(event => event.noteIndex === 2).map(event => event.kind),
  ['press', 'retune', 'retune', 'release'],
  'a held note must replay its press, pitch changes, and exact release',
);

const repeatingTrack = {
  ...preciseTrack,
  notes: Array.from({ length: 384 }, (_, index) => ({
    startUnits: index * 512,
    zone: [0, 4, 24, 28][index % 4],
    gateUnits: null,
    retunes: [],
  })),
};
const repeatingCode = recording.encode(repeatingTrack);
assert.match(repeatingCode, /^DGT2Z\./, 'repeating phrases must use lossless compression');
assert.ok(
  repeatingCode.length < 1000,
  `a dense 90-second repeating take must stay compact; got ${repeatingCode.length}`,
);
assert.deepEqual(clone(recording.decode(repeatingCode)).notes, repeatingTrack.notes);

const corruptAt = Math.floor(preciseCode.length * 0.7);
const corruptCharacter = preciseCode[corruptAt] === 'A' ? 'B' : 'A';
const corruptCode = preciseCode.slice(0, corruptAt) + corruptCharacter +
  preciseCode.slice(corruptAt + 1);
assert.throws(
  () => recording.decode(corruptCode),
  /checksum|compressed|match|incomplete|trailing/,
  'corrupted recordings must fail validation',
);
assert.throws(
  () => recording.encode({
    ...preciseTrack,
    durationUnits: units90Seconds + 1,
  }),
  /header/,
  'recordings longer than 90 seconds must be rejected',
);
assert.throws(
  () => recording.encode({
    ...preciseTrack,
    deckCount: 2,
    notes: [{ startUnits: 0, zone: 12, gateUnits: null, retunes: [] }],
  }),
  /note/,
  'two-deck recordings must reject center-deck notes',
);

console.log('DJ recording verification passed:');
console.log(`- exact 90-second take round-trips in ${preciseCode.length} characters`);
console.log(`- compact header uses ${preciseHeader.length} bytes and imports DGT1`);
console.log(`- dense repeating take compresses to ${repeatingCode.length} characters`);
console.log('- double presses, holds, retunes, CRC checks, and deck validation pass');
