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

const layoutSandbox = {};
vm.runInNewContext(
  `
  ${extractConst('MOBILE_TOUCH_MAX_SHORT_EDGE')}
  ${extractFunction('isMobileTouchDevice')}
  ${extractFunction('isPortraitViewport')}
  ${extractFunction('shouldShowLandscapeGate')}
  globalThis.mobileLayoutApi = {
    mobile(hasCoarsePointer, width, height) {
      return isMobileTouchDevice(hasCoarsePointer, width, height);
    },
    portrait(width, height) {
      return isPortraitViewport(width, height);
    },
    gated(enabled, mobileDevice, portrait) {
      return shouldShowLandscapeGate(enabled, mobileDevice, portrait);
    },
  };
  `,
  layoutSandbox,
);

const layout = layoutSandbox.mobileLayoutApi;
assert.equal(layout.mobile(true, 430, 932), true, 'an iPhone must expose landscape play');
assert.equal(layout.mobile(true, 768, 1024), true, 'an iPad must expose landscape play');
assert.equal(layout.mobile(true, 1024, 1366), true, 'a large iPad must remain in range');
assert.equal(layout.mobile(false, 390, 844), false, 'a fine-pointer desktop is not mobile');
assert.equal(layout.mobile(true, 1200, 1920), false, 'a coarse large display stays outside mobile UI');
assert.equal(layout.portrait(390, 844), true);
assert.equal(layout.portrait(844, 390), false);
assert.equal(layout.gated(true, true, true), true);
assert.equal(layout.gated(false, true, true), false);
assert.equal(layout.gated(true, false, true), false);
assert.equal(layout.gated(true, true, false), false);

const landscapeEvents = [];
const landscapeDocument = {
  fullscreenElement: null,
  async exitFullscreen() {
    landscapeEvents.push('exit-fullscreen');
    this.fullscreenElement = null;
  },
};
landscapeDocument.documentElement = {
  async requestFullscreen() {
    landscapeEvents.push('request-fullscreen');
    landscapeDocument.fullscreenElement = landscapeDocument.documentElement;
  },
};
const landscapeSandbox = {
  console: { info() {} },
  document: landscapeDocument,
  window: {
    screen: {
      orientation: {
        async lock(value) { landscapeEvents.push(`lock:${value}`); },
        unlock() { landscapeEvents.push('unlock'); },
      },
    },
  },
};
vm.runInNewContext(
  `
  let landscapePerformanceEnabled = true;
  let landscapeFullscreenOwned = false;
  let landscapeRequestPending = false;
  let landscapeRequestSerial = 0;
  ${extractFunction('requestLandscapeFullscreen')}
  ${extractFunction('requestLandscapeOrientationLock')}
  ${extractFunction('requestLandscapeExperience')}
  ${extractFunction('releaseLandscapeOrientationLock')}
  ${extractFunction('releaseLandscapeFullscreen')}
  ${extractFunction('releaseLandscapeExperience')}
  globalThis.landscapeApi = {
    request: requestLandscapeExperience,
    release: releaseLandscapeExperience,
    ownsFullscreen() { return landscapeFullscreenOwned; },
    setEnabled(value) {
      landscapePerformanceEnabled = value === true;
      if (!landscapePerformanceEnabled) landscapeRequestSerial++;
    },
  };
  `,
  landscapeSandbox,
);

await landscapeSandbox.landscapeApi.request();
assert.deepEqual(
  landscapeEvents,
  ['request-fullscreen', 'lock:landscape'],
  'landscape play must enter fullscreen before requesting the orientation lock',
);
assert.equal(landscapeSandbox.landscapeApi.ownsFullscreen(), true);
await landscapeSandbox.landscapeApi.release();
assert.deepEqual(
  landscapeEvents,
  ['request-fullscreen', 'lock:landscape', 'unlock', 'exit-fullscreen'],
  'disabling landscape play must release its lock and owned fullscreen session',
);
assert.equal(landscapeSandbox.landscapeApi.ownsFullscreen(), false);

landscapeEvents.length = 0;
landscapeDocument.fullscreenElement = { userOwned: true };
await landscapeSandbox.landscapeApi.request();
await landscapeSandbox.landscapeApi.release();
assert.deepEqual(
  landscapeEvents,
  ['lock:landscape', 'unlock'],
  'landscape play must leave an existing fullscreen session open',
);
landscapeDocument.fullscreenElement = null;

landscapeEvents.length = 0;
let finishFullscreenRequest;
landscapeDocument.documentElement.requestFullscreen = () => {
  landscapeEvents.push('request-fullscreen');
  return new Promise((resolve) => {
    finishFullscreenRequest = () => {
      landscapeDocument.fullscreenElement = landscapeDocument.documentElement;
      resolve();
    };
  });
};
landscapeSandbox.landscapeApi.setEnabled(true);
const cancelledRequest = landscapeSandbox.landscapeApi.request();
landscapeSandbox.landscapeApi.setEnabled(false);
finishFullscreenRequest();
await cancelledRequest;
assert.deepEqual(
  landscapeEvents,
  ['request-fullscreen', 'unlock', 'exit-fullscreen'],
  'disabling during the fullscreen request must cancel the later orientation lock',
);

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
  /id="mobile-display-settings-section"[\s\S]*id="landscape-performance-setting"/,
  'mobile settings must expose landscape play on phones and tablets',
);
assert.match(
  htmlSource,
  /id="landscape-gate"[\s\S]*id="landscape-gate-retry"[\s\S]*id="landscape-gate-disable"/,
  'the portrait gate must preserve automatic retry and disable controls',
);
assert.match(
  htmlSource,
  /main\.js\?v=20260722-rhythm-phrases/,
  'the fixed startup script must use a fresh cache key',
);
assert.match(
  mainSource,
  /window\.localStorage\.getItem\(LANDSCAPE_PERFORMANCE_KEY\)/,
  'the landscape preference must be restored on the same device',
);
assert.match(
  extractFunction('requestLandscapeOrientationLock'),
  /orientation\.lock\('landscape'\)/,
  'supported mobile browsers must receive an orientation-lock request',
);
assert.match(
  mainSource,
  /document\.addEventListener\('fullscreenchange'/,
  'manual fullscreen exit must update the landscape experience state',
);
assert.match(
  htmlSource,
  /重力只移动音场，不改变屏幕方向/,
  '3D gravity copy must stay independent from display orientation',
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
console.log('- iPhone and iPad both expose the landscape-play preference');
console.log('- landscape play requests fullscreen before the orientation lock');
console.log('- portrait fallback retains automatic retry and disable controls');
console.log('- iPad audio resumes from pointerup with timeout and retry recovery');
