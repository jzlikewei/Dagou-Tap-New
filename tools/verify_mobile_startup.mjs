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

const layoutSandbox = {};
vm.runInNewContext(
  `
  ${extractConst('PHONE_MAX_SHORT_EDGE')}
  ${extractFunction('isPhoneDevice')}
  ${extractFunction('isPortraitViewport')}
  ${extractFunction('shouldBlockPhoneLandscape')}
  globalThis.mobileLayoutApi = {
    phone(coarsePointer, width, height) {
      return isPhoneDevice(coarsePointer, width, height);
    },
    portrait(width, height) {
      return isPortraitViewport(width, height);
    },
    blocked(enabled, phone, portrait) {
      return shouldBlockPhoneLandscape(enabled, phone, portrait);
    },
  };
  `,
  layoutSandbox,
);

const layout = layoutSandbox.mobileLayoutApi;
assert.equal(layout.phone(true, 430, 932), true, 'a coarse 430px device is a phone');
assert.equal(layout.phone(true, 768, 1024), false, 'an iPad must keep its regular layout');
assert.equal(layout.phone(false, 390, 844), false, 'a fine pointer desktop is not a phone');
assert.equal(layout.portrait(390, 844), true);
assert.equal(layout.portrait(844, 390), false);
assert.equal(layout.blocked(true, true, true), true);
assert.equal(layout.blocked(false, true, true), false);
assert.equal(layout.blocked(true, false, true), false);
assert.equal(layout.blocked(true, true, false), false);

const audioSandbox = {
  clearTimeout,
  window: { setTimeout },
};
vm.runInNewContext(
  `
  const AUDIO_CONTEXT_RESUME_TIMEOUT_MS = 20;
  let ctx;
  ${extractFunction('resumeAudioContextForStart')}
  globalThis.audioStartApi = {
    resume(fakeContext) {
      ctx = fakeContext;
      return resumeAudioContextForStart();
    },
  };
  `,
  audioSandbox,
);

let resumeCalls = 0;
await audioSandbox.audioStartApi.resume({
  state: 'running',
  resume() { resumeCalls++; },
});
assert.equal(resumeCalls, 0, 'a running context must not be resumed again');

const resumableContext = {
  state: 'suspended',
  async resume() {
    resumeCalls++;
    this.state = 'running';
  },
};
await audioSandbox.audioStartApi.resume(resumableContext);
assert.equal(resumableContext.state, 'running');

await assert.rejects(
  audioSandbox.audioStartApi.resume({
    state: 'suspended',
    resume() { return new Promise(() => {}); },
  }),
  /timed out/,
  'a stalled Safari resume call must return control to the retry overlay',
);

assert.match(
  htmlSource,
  /id="mobile-display-settings-section"[\s\S]*id="force-landscape-setting"/,
  'phone settings must expose the force-landscape switch',
);
assert.match(
  htmlSource,
  /id="phone-landscape-gate"[\s\S]*id="phone-landscape-disable"/,
  'the portrait gate must preserve a way to disable the preference',
);
assert.match(
  htmlSource,
  /main\.js\?v=20260721-ipad-unlock-landscape/,
  'the fixed startup script must use a fresh cache key',
);
assert.match(
  mainSource,
  /window\.localStorage\.getItem\(FORCE_PHONE_LANDSCAPE_KEY\)/,
  'the landscape preference must be restored on the same device',
);
assert.match(
  extractFunction('requestPhoneLandscapeLock'),
  /orientation\.lock\('landscape'\)/,
  'supported phone browsers must receive an orientation-lock request',
);
assert.match(
  mainSource,
  /overlay\.addEventListener\('pointerup',[\s\S]*?void start\(\);[\s\S]*?\}\);/,
  'audio startup must run from the touch pointerup activation',
);

const pointerDownStart = mainSource.indexOf("stage.addEventListener('pointerdown'");
const pointerDownEnd = mainSource.indexOf('}, { passive: false });', pointerDownStart);
assert.ok(pointerDownStart >= 0 && pointerDownEnd > pointerDownStart);
assert.doesNotMatch(
  mainSource.slice(pointerDownStart, pointerDownEnd),
  /\bstart\(\)/,
  'pointerdown must not create the Safari resume promise before media activation',
);
assert.match(
  extractFunction('start'),
  /startPromise = null;[\s\S]*音频未启动 · 再点一次重试/,
  'a failed startup must clear the shared promise and expose a retry',
);

console.log('Mobile startup verification passed:');
console.log('- iPad stays outside the phone-only force-landscape flow');
console.log('- portrait phones can be gated and retain a disable control');
console.log('- iPad audio resumes from pointerup with timeout and retry recovery');
