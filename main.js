'use strict';
/* ============================================================
 * 大狗Tap —— 仿 Mikutap：点击/拖动屏幕，狗叫会卡在节拍上
 * 背景音轨：Web Audio 实时合成的劲爆鼓组 + 洗脑和弦循环
 * 视觉（仿 Mikutap）：
 *   · 全屏几何特效，以屏幕正中心为原点铺满全屏
 *   · 新特效叠在旧特效之上，旧特效随即退场
 *   · 固定米白背景；限定调色板：主色黄 + 次色灰（极少点缀色）
 *   · 特效带常驻动效（旋转 / 漂浮 / 环绕 / 波动）并随节拍轻微脉动（只做大小/形状变化，不变色）
 * ============================================================ */

/* ---------- 节奏常量 ---------- */
const BPM = 128;          // 激情劲爆的速度
const SPB = 60 / BPM;     // 每拍秒数
const S16 = SPB / 4;      // 16 分音符（调度步长）
const S8  = SPB / 2;      // 8 分音符（点击量化的最小节奏点）
const MASTER_GAIN = 0.85;
const RHYTHM_GAME_MIN_BARS = 32;       // 32 小节正好 1 分钟
const RHYTHM_GAME_MAX_BARS = 96;       // 96 小节正好 3 分钟
const RHYTHM_GAME_CUE_LEAD = 1.2;
const RHYTHM_GAME_PERFECT_WINDOW = 0.11;
const RHYTHM_GAME_GOOD_WINDOW = 0.24;
const RHYTHM_GAME_MISS_WINDOW = 0.3;
const RHYTHM_GAME_PHRASE_BARS = 4;
const RHYTHM_GAME_SLIDE_CUE_LEAD = 0.32;
const RHYTHM_GAME_SLIDE_GOOD_WINDOW = 0.32;
const RHYTHM_GAME_AUTOPLAY_LOOKAHEAD = 0.025;
const RHYTHM_GAME_AUTOPLAY_TAP_DURATION = 0.08;
const RHYTHM_GAME_AUTOPLAY_INPUT_PREFIX = 'rhythm-autoplay:';
const RHYTHM_GAME_PHRASE_TEMPLATES = Object.freeze({
  dagou: Object.freeze([
    Object.freeze({
      id: 'dagou-call',
      text: '大狗叫',
      rows: Object.freeze([0, 1, 2]),
      steps: Object.freeze([0, 2, 4]),
    }),
    Object.freeze({
      id: 'dagou-chant',
      text: '大狗大狗叫叫叫',
      rows: Object.freeze([0, 1, 0, 1, 2, 2, 2]),
      steps: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
    }),
  ]),
  dingdong: Object.freeze([
    Object.freeze({
      id: 'dingdong-chant',
      text: '叮咚叮咚鸡',
      rows: Object.freeze([0, 1, 0, 1, 2]),
      steps: Object.freeze([0, 1, 2, 3, 4]),
    }),
    Object.freeze({
      id: 'dingdong-call',
      text: '叮咚鸡',
      rows: Object.freeze([0, 1, 2]),
      steps: Object.freeze([0, 2, 4]),
    }),
  ]),
  hajimi: Object.freeze([
    Object.freeze({
      id: 'hajimi-call',
      text: '哈基米',
      rows: Object.freeze([0, 1, 2]),
      steps: Object.freeze([0, 2, 4]),
    }),
    Object.freeze({
      id: 'hajimi-chant',
      text: '哈基哈基米米米',
      rows: Object.freeze([0, 1, 0, 1, 2, 2, 2]),
      steps: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
    }),
  ]),
});
const DEFAULT_PERFORMANCE_SETTINGS = Object.freeze({
  djMode: true,
  pianoMode: false,
  rhythmSnap: true,
  showGrid: false,
  spatialAudio: false,
});
const DEFAULT_DJ_SETTINGS = Object.freeze({
  deckCount: 3,
  deckSfxIds: Object.freeze(['dagou', 'hajimi', 'dingdong']),
  trailStyle: 'normal',
});

/* ---------- 全局状态 ---------- */
let ctx = null;           // AudioContext
let master = null;        // 总线增益
let bgmBus = null;        // 循环音乐总线
let sfxBus = null;        // 狗叫音效总线
let noiseBuf = null;      // 白噪声（鼓组用）
let started = false;
let startPromise = null;
let bgmMuted = false;
let sfxMuted = false;
const performanceSettings = { ...DEFAULT_PERFORMANCE_SETTINGS };
let performanceSettingsSaving = false;

let startTime = 0;        // 第 0 步对应的 audio 时间
let nextNoteTime = 0;     // 调度器下一个音符时间
let stepCount = 0;        // 16 分步进计数（0..63 循环 = 4 小节）

const SFX_SAMPLE_SETS = Object.freeze({
  dagou: Object.freeze({ da: 'da', gou: 'gou', jiao: 'jiao' }),
  hajimi: Object.freeze({ da: 'ha', gou: 'ji', jiao: 'mi' }),
  dingdong: Object.freeze({
    da: 'dingdongji_ding',
    gou: 'dingdongji_dong',
    jiao: 'dingdongji_ji',
  }),
});
const CHARACTER_IMAGE_SETS = Object.freeze({
  dagou: Object.freeze({
    close: 'Image/dagou_close_mouth.png',
    open: 'Image/dagou_open_mouth.png',
    alt: '大狗',
  }),
  dingdong: Object.freeze({
    close: 'Image/dingdongji_close_mouth.png',
    open: 'Image/dingdongji_open_mouth.png',
    alt: '叮咚鸡',
  }),
  hajimi: Object.freeze({
    close: 'Image/maodie_close_mouth.png',
    open: 'Image/maodie_open_mouth.png',
    alt: '哈基米',
  }),
});
const SFX_LABELS = Object.freeze({
  dagou: '大狗叫',
  dingdong: '叮咚鸡',
  hajimi: '哈基米',
});
const SFX_EMOJIS = Object.freeze({
  dagou: '🐶',
  dingdong: '🐔',
  hajimi: '🐱',
});
const LOADING_MESSAGES = Object.freeze(['狗叫加载中', '基米哈气中']);
const DJ_DECK_LABELS = Object.freeze(['LEFT', 'CENTER', 'RIGHT']);
const DJ_ACTIVE_SLOTS = Object.freeze({
  2: Object.freeze([0, 2]),
  3: Object.freeze([0, 1, 2]),
});
const DJ_KEY_GROUPS = Object.freeze([
  Object.freeze([
    Object.freeze([{ code: 'Digit1', label: '1' }, { code: 'Digit2', label: '2' }, { code: 'Digit3', label: '3' }, { code: 'Digit4', label: '4' }]),
    Object.freeze([{ code: 'KeyQ', label: 'Q' }, { code: 'KeyW', label: 'W' }, { code: 'KeyE', label: 'E' }, { code: 'KeyR', label: 'R' }]),
    Object.freeze([{ code: 'KeyA', label: 'A' }, { code: 'KeyS', label: 'S' }, { code: 'KeyD', label: 'D' }, { code: 'KeyF', label: 'F' }]),
  ]),
  Object.freeze([
    Object.freeze([{ code: 'Digit5', label: '5' }, { code: 'Digit6', label: '6' }, { code: 'Digit7', label: '7' }, { code: 'Digit8', label: '8' }]),
    Object.freeze([{ code: 'KeyT', label: 'T' }, { code: 'KeyY', label: 'Y' }, { code: 'KeyU', label: 'U' }, { code: 'KeyI', label: 'I' }]),
    Object.freeze([{ code: 'KeyG', label: 'G' }, { code: 'KeyH', label: 'H' }, { code: 'KeyJ', label: 'J' }, { code: 'KeyK', label: 'K' }]),
  ]),
  Object.freeze([
    Object.freeze([{ code: 'Digit9', label: '9' }, { code: 'Digit0', label: '0' }, { code: 'Minus', label: '-' }, { code: 'Equal', label: '=' }]),
    Object.freeze([{ code: 'KeyO', label: 'O' }, { code: 'KeyP', label: 'P' }, { code: 'BracketLeft', label: '[' }, { code: 'BracketRight', label: ']' }]),
    Object.freeze([{ code: 'KeyL', label: 'L' }, { code: 'Semicolon', label: ';' }, { code: 'Quote', label: "'" }, { code: 'Backslash', label: '\\' }]),
  ]),
]);
const HAJIMI_ATLAS_URL =
  'Image/donghaidihuang_atlas.webp?v=20260721-beat-synced';
const HAJIMI_STATIC_ICON_URL = 'Image/maodie_close_mouth.png';
const HAJIMI_ANIMATION_ICON_URL = 'Image/donghaidihuang_icon.webp';
const HAJIMI_ANIMATION_BEATS = 9;
const HAJIMI_FRAMES_PER_BEAT = 12;
const HAJIMI_ATLAS_COLUMNS = 12;
const HAJIMI_ATLAS_FRAME_WIDTH = 360;
const HAJIMI_ATLAS_FRAME_HEIGHT = 514;
const HAJIMI_ANIMATION_FRAME_COUNT =
  HAJIMI_ANIMATION_BEATS * HAJIMI_FRAMES_PER_BEAT;
const RUNTIME_SAMPLE_NAMES = Object.freeze(
  [...new Set(Object.values(SFX_SAMPLE_SETS).flatMap(Object.values))]
);
const buffers = {};       // 解码后的音效样本
const sustainLoops = {};  // 从原样本中实时构建的 WSOLA 延音纹理
let selectedSfxId = 'dagou';
const djSettings = {
  deckCount: DEFAULT_DJ_SETTINGS.deckCount,
  deckSfxIds: [...DEFAULT_DJ_SETTINGS.deckSfxIds],
  trailStyle: DEFAULT_DJ_SETTINGS.trailStyle,
};
const rhythmGame = {
  phase: 'idle',
  notes: [],
  duration: 0,
  startAt: 0,
  nextCueIndex: 0,
  nextMissIndex: 0,
  visibleNotes: new Set(),
  activeHolds: new Map(),
  autoplay: false,
  nextAutoplayIndex: 0,
  autoplayTapReleases: [],
  totalJudgements: 0,
  score: 0,
  combo: 0,
  maxCombo: 0,
  perfect: 0,
  good: 0,
  miss: 0,
  wrong: 0,
  countdownText: '',
};
let djSettingsSaving = false;
let djLandscape = true;
let djDecks = [];
const keyboardZoneByCode = new Map();
const pressedKeyboardCodes = new Set();
let hajimiAnimationEnabled = false;
let hajimiAnimationReady = false;
let hajimiAnimationRequested = false;
let hajimiAnimationFrame = -1;
let hajimiAnimationEpochBeat = 0;

// 每条纹理由多个波形相似的语音帧重叠生成。帧位置按黄金分割序列变化，
// 再在目标附近寻找相关度最高的波形，避免固定短片段形成可辨识的循环节。
const SUSTAIN_REGIONS = {
  da: {
    enabled: false,
    regionStart: 0.065, regionEnd: 0.168,
    frame: 0.052, overlap: 0.026, search: 0.007,
    wrapBlend: 0.040, textureDuration: 7.31, seed: 0.17,
  },
  gou: {
    enabled: false,
    regionStart: 0.055, regionEnd: 0.140,
    frame: 0.048, overlap: 0.024, search: 0.006,
    wrapBlend: 0.036, textureDuration: 7.73, seed: 0.43,
  },
  jiao: {
    enabled: true,
    regionStart: 0.125, regionEnd: 0.290,
    frame: 0.100, overlap: 0.050, search: 0.012,
    wrapBlend: 0.040, textureDuration: 12.37, seed: 0.71,
    preferFrameEntry: true,
  },
  mi: {
    enabled: true,
    regionStart: 0.245, regionEnd: 0.345,
    frame: 0.070, overlap: 0.035, search: 0.008,
    wrapBlend: 0.028, textureDuration: 12.11, seed: 0.29,
    preferFrameEntry: true,
  },
  dingdongji_ji: {
    enabled: true,
    regionStart: 0.120, regionEnd: 0.310,
    frame: 0.100, overlap: 0.050, search: 0.012,
    wrapBlend: 0.040, textureDuration: 11.83, seed: 0.53,
    preferFrameEntry: true,
  },
};
const SUSTAIN_CLAIM_LEAD = 0.008; // 提前声明长音，避免多指延音短暂重叠
const RELEASE_SCHEDULE_LEAD = 0.006;
const EMERGENCY_FADE = 0.018;
const SPATIAL_DECK_PANS = Object.freeze([-0.72, 0, 0.72]);
const SPATIAL_FIELD_SHIFT = 0.3;
const SPATIAL_FOCUS_GAIN = 0.12;
const HRTF_X_SPREAD = 1.25;
const HRTF_FIELD_SHIFT = 0.48;
const HRTF_BASE_DISTANCE = 1.15;
const HRTF_DEPTH_SHIFT = 0.5;
const GRAVITY_DEAD_ZONE = 3;
const GRAVITY_FULL_TILT = 15;
const GRAVITY_SMOOTHING = 0.2;
const SOUND_FIELD_KEY_POSITIONS = Object.freeze({
  KeyZ: -1,
  Slash: 1,
  KeyB: 0,
});

const liveVoices = new Set();
const liveSpatialOutputs = new Set();
let voiceSerial = 0;
const activeSustainVoices = new Map();
let mouthVoice = null;
let spatialControlMode = 'manual';
let soundFieldPosition = 0;
let manualSoundFieldPosition = 0;
let gravityBaseline = null;
let lastGravityTilt = null;
let gravityListenerActive = false;
let gravityPermissionPending = false;
let gravitySensorTimer = 0;

let cols = 4, rows = 3;   // 分区网格（纯逻辑分区，无可见格子）
let zones = [];           // 每个分区的音色配置

let mouthTimer = 0;       // 闭嘴定时器
let mouthPopped = false;  // 狗是否处于"叫"的弹起状态（弹簧目标值）
let barkPop = 0;          // 叫弹跳的当前量 0..1（欠阻尼弹簧，可过冲）
let barkPopVel = 0;       // 弹簧速度（每次触发新声音时施加冲量）
const BARK_KICK = 5.2;    // 单次触发给弹簧的冲量（果断起跳）
const BARK_KICK_MAX = 9;  // 连打时冲量累积上限，防止爆炸
let holding = false;      // 是否正在长按延音（驱动 Q 弹成长 / 变红 / 抖动）
let holdLevel = 0;        // 长按累积程度 0..1（缓慢增长、松手快速回落）
let jellyScale = 1;       // 果冻层当前缩放（欠阻尼弹簧，带 Q 弹过冲）
let jellyVel = 0;         // 弹簧速度
let lastTick = 0;         // 上一帧时间（求 dt 用）
const INPUT_LOOKAHEAD = 0.12;
const INPUT_QUEUE_LOOKAHEAD = 0.03;
const inputQueue = [];     // 滑动经过的分区按进入顺序排到连续八分音符
const inputVisualTimers = new Set();
let inputSerial = 0;
let lastCommittedInputTime = -Infinity;
const lastCommittedDjInputTimes = new Map();
const pointers = new Map();// pointerId -> { zone, voice, pendingEntryId, lastX, lastY }
const touchTrails = new Map(); // pointerId -> 跟手圆环、尾迹点与退场状态
const CONTROLS_IDLE_MS = 2000;
const CONTROLS_HOVER_IDLE_MS = 250;
const AUDIO_CONTEXT_RESUME_TIMEOUT_MS = 4000;
const MOBILE_TOUCH_MAX_SHORT_EDGE = 1024;
const CREATOR_MID = '357762853';
const CREATOR_URL = `https://space.bilibili.com/${CREATOR_MID}`;
const FEATURED_BVID = 'BV1kNKU6REBg';
const FEATURED_VIDEO_URL = `https://www.bilibili.com/video/${FEATURED_BVID}/`;
const NAVIGATION_MUTE_KEY = 'dagou-navigation-muted';
const LANDSCAPE_PERFORMANCE_KEY = 'dagou-force-phone-landscape-v1';
const TOY_CLOUD_KEYS = Object.freeze({
  sfxUnlocked: 'dagou_sfx_unlocked_v1',
  settingsSeen: 'dagou_settings_seen_v1',
  dingdongNewSeen: 'dagou_dingdong_new_seen_v1',
  hajimiNewSeen: 'dagou_hajimi_new_seen_v1',
  pianoMode: 'dagou_piano_mode_v1',
  rhythmSnap: 'dagou_rhythm_snap_v1',
  showGrid: 'dagou_show_grid_v1',
  spatialAudio: 'dagou_spatial_audio_v1',
  djMode: 'dagou_dj_mode_v1',
  djDeckCount: 'dagou_dj_deck_count_v1',
  djDeckLeft: 'dagou_dj_deck_left_v1',
  djDeckCenter: 'dagou_dj_deck_center_v1',
  djDeckRight: 'dagou_dj_deck_right_v1',
  djTrailStyle: 'dagou_dj_trail_style_v1',
});
const TOY_CLOUD_KEY_LIST = Object.freeze(Object.values(TOY_CLOUD_KEYS));
const TOY_REQUIRED_ABILITIES = Object.freeze([
  'getUserProfile',
  'getCloudStorage',
  'setCloudStorage',
  'navigate',
]);
const LOCKED_SFX_IDS = new Set(['dingdong', 'hajimi']);
const DEBUG_UNLOCK_SFX = true; // 临时调试：发布前改回 false，恢复 Toy 云端锁定。
let controlsIdleTimer = 0;
let navigationMuted = false;
let landscapePerformanceEnabled = false;
let landscapeGateVisible = false;
let landscapeFullscreenOwned = false;
let landscapeRequestPending = false;
let landscapeRequestSerial = 0;

try {
  navigationMuted =
    window.sessionStorage.getItem(NAVIGATION_MUTE_KEY) === '1';
} catch (error) {
  console.warn('[大狗Tap] 无法读取导航临时静音状态。', error);
}

try {
  landscapePerformanceEnabled =
    window.localStorage.getItem(LANDSCAPE_PERFORMANCE_KEY) === '1';
} catch (error) {
  console.warn('[大狗Tap] 无法读取横屏演奏设置。', error);
}

/* ---------- DOM ---------- */
const stage     = document.getElementById('stage');
const fxCanvas  = document.getElementById('fx');
const touchFxCanvas = document.getElementById('touch-fx');
const dogEl     = document.getElementById('dog');
const dogInner  = document.getElementById('dog-inner');
const dogJelly  = document.getElementById('dog-jelly');
const dogCloseImage = document.getElementById('dog-close');
const dogOpenImage = document.getElementById('dog-open');
const dogAnimationCanvas = document.getElementById('dog-animation');
const dogAnimationAtlas = document.getElementById('dog-animation-atlas');
const dogAnimation2d = dogAnimationCanvas.getContext('2d', { alpha: true });
const overlay   = document.getElementById('overlay');
const keyGrid   = document.getElementById('key-grid');
const flashLayer = document.getElementById('zoneflash');
const djStage = document.getElementById('dj-stage');
const rhythmGameLayer = document.getElementById('rhythm-game-layer');
const rhythmGameCues = document.getElementById('rhythm-game-cues');
const rhythmGameHud = document.getElementById('rhythm-game-hud');
const rhythmGameAutoBadge = document.getElementById('rhythm-game-auto-badge');
const rhythmGameScore = document.getElementById('rhythm-game-score');
const rhythmGameCombo = document.getElementById('rhythm-game-combo');
const rhythmGameTime = document.getElementById('rhythm-game-time');
const rhythmGameEnd = document.getElementById('rhythm-game-end');
const rhythmGameCountdown = document.getElementById('rhythm-game-countdown');
const rhythmGameJudgement = document.getElementById('rhythm-game-judgement');
const rhythmGameResults = document.getElementById('rhythm-game-results');
const rhythmGameResultGrade = document.getElementById('rhythm-game-result-grade');
const rhythmGameResultTitle = document.getElementById('rhythm-game-result-title');
const rhythmGameResultScore = document.getElementById('rhythm-game-result-score');
const rhythmGameResultAccuracy = document.getElementById('rhythm-game-result-accuracy');
const rhythmGameResultCombo = document.getElementById('rhythm-game-result-combo');
const rhythmGameResultHits = document.getElementById('rhythm-game-result-hits');
const rhythmGameResultMisses = document.getElementById('rhythm-game-result-misses');
const rhythmGameBack = document.getElementById('rhythm-game-back');
const rhythmGameRetry = document.getElementById('rhythm-game-retry');
const subEl     = overlay.querySelector('.sub');
const fx2d      = fxCanvas.getContext('2d');
const touchFx2d = touchFxCanvas.getContext('2d');
const topControls = document.getElementById('top-controls');
const musicToggle = document.getElementById('music-toggle');
const sfxToggle = document.getElementById('sfx-toggle');
const spatialAudioToggle = document.getElementById('spatial-audio-toggle');
const settingsButton = document.getElementById('settings-button');
const updateDot = document.getElementById('update-dot');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsPanel = document.getElementById('settings-panel');
const settingsClose = document.getElementById('settings-close');
const authorHomeButton = document.getElementById('author-home-button');
const videoCard = document.getElementById('video-card');
const videoPlay = videoCard.querySelector('.video-play');
const sfxOptions = [...document.querySelectorAll('.sfx-option')];
const hajimiOptionImage = document.getElementById('hajimi-option-image');
const performanceSettingButtons = [
  ...document.querySelectorAll('[data-setting]'),
];
const pianoModeSetting = document.getElementById('piano-mode-setting');
const pianoModeDescription = pianoModeSetting.querySelector('.setting-description');
const djSettingsPanel = document.getElementById('dj-settings');
const djCountButtons = [...document.querySelectorAll('[data-dj-count]')];
const djTrailStyleButtons = [
  ...document.querySelectorAll('[data-dj-trail-style]'),
];
const djDeckAssignmentRows = [
  ...document.querySelectorAll('.dj-deck-assignment[data-dj-slot]'),
];
const djSfxChoiceButtons = [...document.querySelectorAll('[data-dj-sfx]')];
const rhythmGameLaunch = document.getElementById('rhythm-game-launch');
const rhythmGameLaunchDescription = document.getElementById(
  'rhythm-game-launch-description'
);
const rhythmGameLaunchAction = document.getElementById(
  'rhythm-game-launch-action'
);
const rhythmGameAutoplayLaunch = document.getElementById(
  'rhythm-game-autoplay-launch'
);
const rhythmGameAutoplayAction = document.getElementById(
  'rhythm-game-autoplay-action'
);
const spatialAudioSettingsPanel = document.getElementById(
  'spatial-audio-settings'
);
const spatialModeButtons = [
  ...document.querySelectorAll('[data-spatial-mode]'),
];
const soundFieldControl = document.getElementById('sound-field-control');
const soundFieldModeLabel = document.getElementById('sound-field-mode-label');
const soundFieldSlider = document.getElementById('sound-field-slider');
const soundFieldCenterButton = document.getElementById('sound-field-center');
const performanceSettingsStatus = document.getElementById(
  'performance-settings-status'
);
const mobileDisplaySettingsSection = document.getElementById(
  'mobile-display-settings-section'
);
const landscapePerformanceSetting = document.getElementById(
  'landscape-performance-setting'
);
const landscapeGate = document.getElementById('landscape-gate');
const landscapeGateRetry = document.getElementById('landscape-gate-retry');
const landscapeGateDisable = document.getElementById(
  'landscape-gate-disable'
);
const toyNotice = document.getElementById('toy-notice');
const authorLink = document.getElementById('author-link');
const djAuthorLink = document.getElementById('dj-author-link');
const reduceUiMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function isMobileTouchDevice(
  hasCoarsePointer = window.matchMedia('(any-pointer: coarse)').matches,
  screenWidth = window.screen?.width ?? window.innerWidth,
  screenHeight = window.screen?.height ?? window.innerHeight
) {
  const shortEdge = Math.min(Number(screenWidth), Number(screenHeight));
  return hasCoarsePointer && Number.isFinite(shortEdge) &&
    shortEdge <= MOBILE_TOUCH_MAX_SHORT_EDGE;
}

function isPortraitViewport(
  width = window.innerWidth,
  height = window.innerHeight
) {
  return Number(height) > Number(width);
}

function shouldShowLandscapeGate(
  enabled = landscapePerformanceEnabled,
  mobileDevice = isMobileTouchDevice(),
  portrait = isPortraitViewport()
) {
  return enabled && mobileDevice && portrait;
}

function saveLandscapePerformancePreference() {
  try {
    window.localStorage.setItem(
      LANDSCAPE_PERFORMANCE_KEY,
      landscapePerformanceEnabled ? '1' : '0'
    );
  } catch (error) {
    console.warn('[大狗Tap] 无法保存横屏演奏设置。', error);
  }
}

async function requestLandscapeFullscreen() {
  if (document.fullscreenElement) return true;
  const fullscreenTarget = document.documentElement;
  if (typeof fullscreenTarget?.requestFullscreen !== 'function') return false;
  try {
    await fullscreenTarget.requestFullscreen();
    landscapeFullscreenOwned =
      document.fullscreenElement === fullscreenTarget;
    return landscapeFullscreenOwned;
  } catch (error) {
    console.info('[大狗Tap] 浏览器未进入全屏。', error);
    return false;
  }
}

async function requestLandscapeOrientationLock() {
  const orientation = window.screen?.orientation;
  if (typeof orientation?.lock !== 'function') return false;
  try {
    await orientation.lock('landscape');
    return true;
  } catch (error) {
    console.info('[大狗Tap] 浏览器要求手动旋转手机。', error);
    return false;
  }
}

async function requestLandscapeExperience() {
  if (landscapeRequestPending || !landscapePerformanceEnabled) return false;
  const requestSerial = ++landscapeRequestSerial;
  landscapeRequestPending = true;
  try {
    const fullscreenTarget = document.documentElement;
    if (
      !document.fullscreenElement &&
      typeof fullscreenTarget?.requestFullscreen === 'function'
    ) {
      await requestLandscapeFullscreen();
    }
    if (
      requestSerial !== landscapeRequestSerial ||
      !landscapePerformanceEnabled
    ) {
      await releaseLandscapeExperience();
      return false;
    }

    const locked = await requestLandscapeOrientationLock();
    if (
      requestSerial !== landscapeRequestSerial ||
      !landscapePerformanceEnabled
    ) {
      await releaseLandscapeExperience();
      return false;
    }
    return locked;
  } finally {
    landscapeRequestPending = false;
  }
}

function releaseLandscapeOrientationLock() {
  const orientation = window.screen?.orientation;
  if (typeof orientation?.unlock !== 'function') return;
  try {
    orientation.unlock();
  } catch (error) {
    console.info('[大狗Tap] 浏览器未持有横屏锁定。', error);
  }
}

async function releaseLandscapeFullscreen() {
  if (!landscapeFullscreenOwned) return;
  landscapeFullscreenOwned = false;
  if (
    !document.fullscreenElement ||
    typeof document.exitFullscreen !== 'function'
  ) return;
  try {
    await document.exitFullscreen();
  } catch (error) {
    console.info('[大狗Tap] 浏览器未退出全屏。', error);
  }
}

async function releaseLandscapeExperience() {
  releaseLandscapeOrientationLock();
  await releaseLandscapeFullscreen();
}

function renderLandscapePerformancePreference() {
  const mobileDevice = isMobileTouchDevice();
  const gateVisible = shouldShowLandscapeGate(
    landscapePerformanceEnabled,
    mobileDevice,
    isPortraitViewport()
  );
  const wasVisible = landscapeGateVisible;
  landscapeGateVisible = gateVisible;

  mobileDisplaySettingsSection.hidden = !mobileDevice;
  landscapePerformanceSetting.disabled =
    !mobileDevice || landscapeRequestPending;
  landscapePerformanceSetting.setAttribute(
    'aria-checked',
    String(mobileDevice && landscapePerformanceEnabled)
  );
  landscapeGate.classList.toggle('is-visible', gateVisible);
  landscapeGate.setAttribute('aria-hidden', String(!gateVisible));
  landscapeGate.inert = !gateVisible;
  landscapeGateRetry.disabled = landscapeRequestPending;
  stage.inert = gateVisible;

  if (gateVisible && !wasVisible) {
    stopActivePerformanceInput();
    requestAnimationFrame(() => {
      landscapeGateRetry.focus({ preventScroll: true });
    });
  } else if (
    !gateVisible &&
    wasVisible &&
    landscapeGate.contains(document.activeElement)
  ) {
    document.activeElement.blur();
  }
}

async function setLandscapePerformance(enabled) {
  if (!isMobileTouchDevice()) return;
  landscapePerformanceEnabled = enabled === true;
  saveLandscapePerformancePreference();

  if (landscapePerformanceEnabled) {
    if (settingsOpen) closeSettings();
    const landscapeRequest = requestLandscapeExperience();
    renderLandscapePerformancePreference();
    await landscapeRequest;
    renderLandscapePerformancePreference();
    return;
  }

  landscapeRequestSerial++;
  renderLandscapePerformancePreference();
  await releaseLandscapeExperience();
  renderLandscapePerformancePreference();
}

function showControls() {
  if (pointers.size > 0 || isAnyCharacterHolding()) return;
  topControls.classList.add('is-visible');
}

function hideControlsUntilIdle() {
  topControls.classList.remove('is-visible');
  topControls.classList.remove('is-revealing-fast');
  clearTimeout(controlsIdleTimer);
  controlsIdleTimer = setTimeout(showControls, CONTROLS_IDLE_MS);
}

function accelerateControlsReveal() {
  if (
    topControls.classList.contains('is-visible') ||
    pointers.size > 0 ||
    isAnyCharacterHolding()
  ) return;
  topControls.classList.add('is-revealing-fast');
  clearTimeout(controlsIdleTimer);
  controlsIdleTimer = setTimeout(showControls, CONTROLS_HOVER_IDLE_MS);
}

function setBusMuted(bus, muted) {
  if (!ctx || !bus) return;
  const now = ctx.currentTime;
  bus.gain.cancelScheduledValues(now);
  bus.gain.setTargetAtTime(muted ? 0 : 1, now, 0.015);
}

function setNavigationMute(muted) {
  navigationMuted = muted;

  try {
    if (muted) {
      window.sessionStorage.setItem(NAVIGATION_MUTE_KEY, '1');
    } else {
      window.sessionStorage.removeItem(NAVIGATION_MUTE_KEY);
    }
  } catch (error) {
    console.warn('[大狗Tap] 无法保存导航临时静音状态。', error);
  }

  if (!ctx || !master) return;
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, now, 0.015);
}

function restoreAfterNavigation() {
  if (navigationMuted) setNavigationMute(false);
}

function updateMuteButton(button, muted, label) {
  const action = muted ? '开启' : '关闭';
  button.classList.toggle('is-muted', muted);
  button.setAttribute('aria-pressed', String(muted));
  button.setAttribute('aria-label', `${action}${label}`);
  button.title = `${action}${label}`;
}

function toggleMusic() {
  bgmMuted = !bgmMuted;
  setBusMuted(bgmBus, bgmMuted);
  updateMuteButton(musicToggle, bgmMuted, '音乐');
}

function toggleSoundEffects() {
  sfxMuted = !sfxMuted;
  setBusMuted(sfxBus, sfxMuted);
  updateMuteButton(sfxToggle, sfxMuted, '音效');

  if (sfxMuted) {
    dogInner.classList.remove('bark-image');
    for (const deck of djDecks) deck.inner.classList.remove('bark-image');
  } else if (mouthVoice) {
    dogInner.classList.add('bark-image');
  }
  if (!sfxMuted) {
    for (const deck of djDecks) {
      if (deck.mouthVoice) deck.inner.classList.add('bark-image');
    }
  }
}

function setRhythmScale(element, pulse, amount) {
  element.style.setProperty(
    '--rhythm-scale',
    (1 + pulse * amount).toFixed(4)
  );
}

/* 两行文字拆成等距字符；Created by 整体跟拍，
   MarkCup 每拍只放大一个字母，并按 M → a → … → p 循环。 */
const authorNameLetters = [];
for (const line of authorLink.querySelectorAll('.author-label, .author-name')) {
  const text = line.textContent;
  line.textContent = '';
  for (const char of text) {
    const letter = document.createElement('span');
    letter.className = 'author-letter';
    letter.textContent = char === ' ' ? ' ' : char;   // 空格转为 nbsp，避免 inline-block 中塌陷
    line.appendChild(letter);
    if (line.classList.contains('author-name')) {
      authorNameLetters.push(letter);
    }
  }
}

function updateAuthorNameLetters(beatIndex, pulse) {
  const activeIndex = authorNameLetters.length
    ? ((beatIndex % authorNameLetters.length) + authorNameLetters.length) %
      authorNameLetters.length
    : -1;

  for (let i = 0; i < authorNameLetters.length; i++) {
    const scale = i === activeIndex ? 1 + pulse * 0.24 : 1;
    authorNameLetters[i].style.transform = `scale(${scale.toFixed(4)})`;
  }
}

function updateUiRhythm(beatPosition) {
  if (!Number.isFinite(beatPosition)) {
    setRhythmScale(musicToggle, 0, 0.075);
    setRhythmScale(sfxToggle, 0, 0.075);
    setRhythmScale(spatialAudioToggle, 0, 0.075);
    setRhythmScale(settingsButton, 0, 0.075);
    setRhythmScale(updateDot, 0, 0.4);
    setRhythmScale(videoPlay, 0, 0.12);
    authorLink.style.setProperty('--author-rhythm-scale', '1');
    authorLink.style.setProperty('--author-lift', '0px');
    updateAuthorNameLetters(-1, 0);
    return;
  }

  const phase = ((beatPosition % 1) + 1) % 1;
  const beatIndex = Math.floor(beatPosition);
  const pulse = reduceUiMotion ? 0 : Math.pow(1 - phase, 4.5);
  let musicPulse = 0;
  let sfxPulse = 0;

  if (!bgmMuted && !sfxMuted) {
    if (((beatIndex % 2) + 2) % 2 === 0) musicPulse = pulse;
    else sfxPulse = pulse;
  } else if (!bgmMuted) {
    musicPulse = pulse;
  } else if (!sfxMuted) {
    sfxPulse = pulse;
  }

  setRhythmScale(musicToggle, musicPulse, 0.075);
  setRhythmScale(sfxToggle, sfxPulse, 0.075);
  setRhythmScale(spatialAudioToggle, pulse, 0.075);
  setRhythmScale(settingsButton, pulse, 0.075);
  setRhythmScale(updateDot, pulse, 0.4);
  setRhythmScale(videoPlay, pulse, 0.12);
  authorLink.style.setProperty(
    '--author-rhythm-scale',
    (1 + pulse * 0.032).toFixed(4)
  );
  authorLink.style.setProperty(
    '--author-lift',
    `${(-pulse * 1.4).toFixed(3)}px`
  );
  updateAuthorNameLetters(beatIndex, pulse);
}

async function navigateWithToy(type, id, fallbackUrl, label) {
  try {
    if (window.toy && typeof window.toy.navigate === 'function') {
      await window.toy.navigate({ type, id });
      return;
    }
  } catch (error) {
    console.warn(`[大狗Tap] Toy ${label}导航不可用，改用浏览器跳转。`, error);
  }
  window.location.assign(fallbackUrl);
}

function openCreatorSpace() {
  setNavigationMute(true);
  return navigateWithToy('space', CREATOR_MID, CREATOR_URL, '主页');
}

let videoUnlockPending = false;

async function openFeaturedVideo() {
  if (videoUnlockPending) return;
  videoUnlockPending = true;
  videoCard.setAttribute('aria-busy', 'true');

  try {
    const state = await toyStateReady;
    if (!state.environmentAvailable || !state.toy) {
      setNavigationMute(true);
      window.location.assign(FEATURED_VIDEO_URL);
      return;
    }

    let unlockedNow = false;
    if (state.cloudReadable && !state.sfxUnlocked) {
      try {
        await state.toy.setCloudStorage({
          [TOY_CLOUD_KEYS.sfxUnlocked]: '1',
        });
      } catch (error) {
        markToyCloudUnavailable(state);
        console.warn('[大狗Tap] 音效解锁状态写入失败。', error);
        showToyNotice(
          '解锁失败，请确认已登录哔哩哔哩后刷新重试。',
          true
        );
        return;
      }

      state.sfxUnlocked = true;
      unlockedNow = true;
      renderToyCloudState();
    }

    try {
      setNavigationMute(true);
      await state.toy.navigate({ type: 'video', id: FEATURED_BVID });
    } catch (error) {
      setNavigationMute(false);
      console.warn('[大狗Tap] Toy 视频导航失败。', error);
      showToyNotice(
        unlockedNow
          ? '已完成解锁，但视频打开失败，请稍后重试。'
          : '视频打开失败，请稍后重试。',
        true
      );
    }
  } finally {
    videoUnlockPending = false;
    videoCard.removeAttribute('aria-busy');
  }
}

for (const button of topControls.querySelectorAll('button')) {
  button.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') accelerateControlsReveal();
  });
  button.addEventListener('click', (event) => {
    const pinnedSettingsButton =
      button === settingsButton &&
      topControls.classList.contains('has-update-dot');
    if (!topControls.classList.contains('is-visible') && !pinnedSettingsButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      accelerateControlsReveal();
    }
  }, { capture: true });
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('pointermove', (event) => event.stopPropagation());
  button.addEventListener('pointerup', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => event.stopPropagation());
}
musicToggle.addEventListener('click', toggleMusic);
sfxToggle.addEventListener('click', toggleSoundEffects);

/* ---------- 设置菜单与 Toy 云状态 ---------- */
let settingsOpen = false;
let toyNoticeTimer = 0;
const toyCloudState = {
  toy: null,
  initialized: false,
  environmentAvailable: false,
  cloudReadable: false,
  sfxUnlocked: DEBUG_UNLOCK_SFX,
  settingsSeen: false,
  newSeen: {
    dingdong: false,
    hajimi: false,
  },
  locallyChanged: {
    settingsSeen: false,
    dingdong: false,
    hajimi: false,
  },
};
const PERFORMANCE_SETTING_KEYS = Object.freeze({
  djMode: TOY_CLOUD_KEYS.djMode,
  pianoMode: TOY_CLOUD_KEYS.pianoMode,
  rhythmSnap: TOY_CLOUD_KEYS.rhythmSnap,
  showGrid: TOY_CLOUD_KEYS.showGrid,
  spatialAudio: TOY_CLOUD_KEYS.spatialAudio,
});
const DJ_DECK_CLOUD_KEYS = Object.freeze([
  TOY_CLOUD_KEYS.djDeckLeft,
  TOY_CLOUD_KEYS.djDeckCenter,
  TOY_CLOUD_KEYS.djDeckRight,
]);

function showToyNotice(message, isError = false) {
  clearTimeout(toyNoticeTimer);
  toyNotice.textContent = message;
  toyNotice.classList.toggle('is-error', isError);
  toyNotice.classList.add('is-visible');
  toyNotice.setAttribute('aria-hidden', 'false');
  toyNoticeTimer = setTimeout(() => {
    toyNotice.classList.remove('is-visible');
    toyNotice.setAttribute('aria-hidden', 'true');
  }, 4800);
}

function clearQueuedPerformanceInput() {
  inputQueue.length = 0;
  lastCommittedInputTime = -Infinity;
  lastCommittedDjInputTimes.clear();
  clearInputVisualTimers();
  for (const state of pointers.values()) state.pendingEntryId = null;
}

function stopActivePerformanceInput() {
  clearQueuedPerformanceInput();
  pressedKeyboardCodes.clear();
  releaseAllTouchTrails();
  pointers.clear();
  if (!ctx) return;
  for (const voice of [...liveVoices]) forceStopVoice(voice);
}

function clampSoundFieldPosition(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-1, Math.min(1, number));
}

function getDeckBaseSpatialPan(deckId) {
  if (typeof deckId !== 'string' || !deckId.startsWith('dj-')) return 0;
  const slot = Number(deckId.slice(3));
  return SPATIAL_DECK_PANS[slot] ?? 0;
}

function getSpatialOutputTargets(deckId) {
  const basePan = getDeckBaseSpatialPan(deckId);
  if (!performanceSettings.spatialAudio) {
    return { enabled: false, pan: 0, gain: 1, x: 0, y: 0, z: -1 };
  }
  const focus = basePan * soundFieldPosition;
  return {
    enabled: true,
    pan: clampSoundFieldPosition(
      basePan + soundFieldPosition * SPATIAL_FIELD_SHIFT
    ),
    gain: Math.max(
      0.82,
      Math.min(
        1.18,
        1 + basePan * soundFieldPosition * SPATIAL_FOCUS_GAIN
      )
    ),
    x: basePan * HRTF_X_SPREAD + soundFieldPosition * HRTF_FIELD_SHIFT,
    y: 0,
    z: -(HRTF_BASE_DISTANCE - focus * HRTF_DEPTH_SHIFT),
  };
}

function setSpatialAudioParam(param, value, immediate = false) {
  if (!param || !ctx) return;
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  if (immediate) param.setValueAtTime(value, now);
  else param.setTargetAtTime(value, now, 0.035);
}

function updateSpatialOutput(output, immediate = false) {
  if (!output) return;
  const targets = getSpatialOutputTargets(output.deckId);
  setSpatialAudioParam(
    output.dryGain.gain,
    targets.enabled ? 0 : 1,
    immediate
  );
  setSpatialAudioParam(
    output.spatialGain.gain,
    targets.enabled ? targets.gain : 0,
    immediate
  );
  if (output.pannerKind === 'hrtf') {
    if (output.panner.positionX && output.panner.positionZ) {
      setSpatialAudioParam(output.panner.positionX, targets.x, immediate);
      setSpatialAudioParam(output.panner.positionY, targets.y, immediate);
      setSpatialAudioParam(output.panner.positionZ, targets.z, immediate);
    } else if (typeof output.panner.setPosition === 'function') {
      output.panner.setPosition(targets.x, targets.y, targets.z);
    }
  } else if (output.pannerKind === 'stereo') {
    setSpatialAudioParam(output.panner.pan, targets.pan, immediate);
  }
}

function updateLiveSpatialOutputs(immediate = false) {
  for (const output of liveSpatialOutputs) {
    updateSpatialOutput(output, immediate);
  }
}

function renderSoundFieldPosition() {
  const percent = Math.round(soundFieldPosition * 100);
  soundFieldSlider.value = String(percent);
  const valueText = percent === 0
    ? '居中'
    : `${Math.abs(percent)}% 偏${percent < 0 ? '左' : '右'}`;
  soundFieldSlider.setAttribute('aria-valuetext', valueText);
}

function renderSpatialAudioControls() {
  const enabled = performanceSettings.spatialAudio;
  const gravityMode = spatialControlMode === 'gravity';
  const toggleAction = enabled ? '关闭' : '开启';
  spatialAudioToggle.setAttribute('aria-label', `${toggleAction} 3D 音效`);
  spatialAudioToggle.title = `${toggleAction} 3D 音效`;
  spatialAudioSettingsPanel.classList.toggle('is-visible', enabled);
  spatialAudioSettingsPanel.setAttribute('aria-hidden', String(!enabled));
  stage.classList.toggle('is-spatial-audio', enabled);
  stage.classList.toggle('is-spatial-gravity', enabled && gravityMode);
  soundFieldControl.setAttribute('aria-hidden', String(!enabled));
  soundFieldSlider.disabled = !enabled || gravityMode;
  soundFieldModeLabel.textContent = gravityMode
    ? 'HRTF · 重力'
    : 'HRTF · 手动';
  soundFieldCenterButton.textContent = gravityMode ? '校准' : '回中';

  for (const button of spatialModeButtons) {
    const selected = button.dataset.spatialMode === spatialControlMode;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-checked', String(selected));
    button.disabled = !enabled || gravityPermissionPending;
  }
  renderSoundFieldPosition();
}

function setSoundFieldPosition(value, rememberManual = false) {
  soundFieldPosition = clampSoundFieldPosition(value);
  if (rememberManual) manualSoundFieldPosition = soundFieldPosition;
  renderSoundFieldPosition();
  updateLiveSpatialOutputs();
}

function stopGravitySoundField() {
  clearTimeout(gravitySensorTimer);
  gravitySensorTimer = 0;
  if (gravityListenerActive) {
    window.removeEventListener('deviceorientation', handleDeviceOrientation);
  }
  gravityListenerActive = false;
  gravityBaseline = null;
  lastGravityTilt = null;
}

function activateManualSoundField() {
  stopGravitySoundField();
  spatialControlMode = 'manual';
  setSoundFieldPosition(manualSoundFieldPosition, true);
  renderSpatialAudioControls();
}

function screenRelativeTilt(event) {
  const angle = Number(
    window.screen?.orientation?.angle ?? window.orientation ?? 0
  );
  const normalizedAngle = ((angle % 360) + 360) % 360;
  if (normalizedAngle === 90) return Number(event.beta);
  if (normalizedAngle === 270) return -Number(event.beta);
  return Number(event.gamma);
}

function getGravitySoundFieldTarget(delta) {
  const magnitude = Math.abs(delta);
  if (magnitude <= GRAVITY_DEAD_ZONE) return 0;
  return Math.sign(delta) * clampSoundFieldPosition(
    (magnitude - GRAVITY_DEAD_ZONE) /
    (GRAVITY_FULL_TILT - GRAVITY_DEAD_ZONE)
  );
}

function handleDeviceOrientation(event) {
  if (spatialControlMode !== 'gravity' || !performanceSettings.spatialAudio) {
    return;
  }
  const tilt = screenRelativeTilt(event);
  if (!Number.isFinite(tilt)) return;

  clearTimeout(gravitySensorTimer);
  gravitySensorTimer = 0;
  lastGravityTilt = tilt;
  if (!Number.isFinite(gravityBaseline)) gravityBaseline = tilt;

  const delta = tilt - gravityBaseline;
  const target = getGravitySoundFieldTarget(delta);
  setSoundFieldPosition(
    soundFieldPosition + (target - soundFieldPosition) * GRAVITY_SMOOTHING
  );
}

function fallBackToManualSoundField(message) {
  activateManualSoundField();
  showToyNotice(message, true);
}

async function enableGravitySoundField() {
  if (!performanceSettings.spatialAudio || gravityPermissionPending) return;
  const OrientationEvent = window.DeviceOrientationEvent;
  if (typeof OrientationEvent !== 'function') {
    fallBackToManualSoundField('当前设备无法使用重力感应，已切换为手动拖动。');
    return;
  }

  gravityPermissionPending = true;
  renderSpatialAudioControls();
  try {
    if (typeof OrientationEvent.requestPermission === 'function') {
      const permission = await OrientationEvent.requestPermission();
      if (permission !== 'granted') {
        fallBackToManualSoundField(
          '重力感应权限没有开启，已切换为手动拖动。'
        );
        return;
      }
    }

    stopGravitySoundField();
    spatialControlMode = 'gravity';
    soundFieldPosition = 0;
    gravityListenerActive = true;
    window.addEventListener('deviceorientation', handleDeviceOrientation);
    gravitySensorTimer = setTimeout(() => {
      if (spatialControlMode === 'gravity' && lastGravityTilt === null) {
        fallBackToManualSoundField(
          '没有读取到重力感应数据，已切换为手动拖动。'
        );
      }
    }, 2200);
  } catch (error) {
    console.warn('[大狗Tap] 重力感应启动失败。', error);
    fallBackToManualSoundField(
      '重力感应启动失败，已切换为手动拖动。'
    );
  } finally {
    gravityPermissionPending = false;
    renderSpatialAudioControls();
  }
}

function centerSoundField() {
  if (spatialControlMode === 'gravity') {
    gravityBaseline = Number.isFinite(lastGravityTilt) ? lastGravityTilt : null;
    setSoundFieldPosition(0);
    return;
  }
  setSoundFieldPosition(0, true);
}

function getActiveDjSlots() {
  return DJ_ACTIVE_SLOTS[djSettings.deckCount] ?? DJ_ACTIVE_SLOTS[2];
}

function createDjDeckVisual(slot) {
  const sfxId = djSettings.deckSfxIds[slot];
  const images = CHARACTER_IMAGE_SETS[sfxId];
  const element = document.createElement('section');
  element.className = 'dj-deck';
  element.dataset.deckId = `dj-${slot}`;

  const label = document.createElement('div');
  label.className = 'dj-deck-label';
  const deckName = document.createElement('strong');
  deckName.textContent = DJ_DECK_LABELS[slot];
  const sfxName = document.createElement('span');
  sfxName.textContent = SFX_LABELS[sfxId];
  label.append(deckName, sfxName);

  const character = document.createElement('div');
  character.className = 'dj-character';
  const inner = document.createElement('div');
  inner.className = 'dj-character-inner';
  inner.classList.toggle('is-hajimi', sfxId === 'hajimi');
  const jelly = document.createElement('div');
  jelly.className = 'dj-character-jelly';
  const closeImage = document.createElement('img');
  closeImage.className = 'dj-character-close';
  closeImage.src = images.close;
  closeImage.alt = images.alt;
  closeImage.draggable = false;
  const openImage = document.createElement('img');
  openImage.className = 'dj-character-open';
  openImage.src = images.open;
  openImage.alt = '';
  openImage.draggable = false;
  jelly.append(closeImage, openImage);
  inner.appendChild(jelly);
  character.appendChild(inner);
  element.append(label, character);

  return {
    id: `dj-${slot}`,
    slot,
    sfxId,
    element,
    character,
    inner,
    jelly,
    mouthTimer: 0,
    mouthVoice: null,
    mouthPopped: false,
    barkPop: 0,
    barkPopVel: 0,
    holding: false,
    holdLevel: 0,
    jellyScale: 1,
    jellyVel: 0,
  };
}

function renderDjStage() {
  const enabled = performanceSettings.djMode;
  stage.classList.toggle('is-dj-mode', enabled);
  djStage.setAttribute('aria-hidden', String(!enabled));
  if (!enabled) {
    for (const deck of djDecks) clearTimeout(deck.mouthTimer);
    djStage.replaceChildren();
    djDecks = [];
    return;
  }

  const previousDecks = new Map(djDecks.map(deck => [deck.slot, deck]));
  const nextDecks = getActiveDjSlots().map((slot) => {
    const previous = previousDecks.get(slot);
    return previous?.sfxId === djSettings.deckSfxIds[slot]
      ? previous
      : createDjDeckVisual(slot);
  });
  const retainedDecks = new Set(nextDecks);
  for (const deck of previousDecks.values()) {
    if (!retainedDecks.has(deck)) clearTimeout(deck.mouthTimer);
  }
  djDecks = nextDecks;
  djStage.classList.toggle('is-landscape', djLandscape);
  djStage.classList.toggle('is-portrait', !djLandscape);
  djStage.style.setProperty('--dj-deck-count', String(djDecks.length));
  djStage.replaceChildren(...djDecks.map(deck => deck.element));
}

function getDjDeck(deckId) {
  return djDecks.find(deck => deck.id === deckId) ?? null;
}

function getRhythmGameZoneKey(zone) {
  if (!zone || !Number.isInteger(zone.deckSlot)) return '';
  return `${zone.deckSlot}:${zone.localRow}:${zone.localColumn}`;
}

function createRhythmGameChart(activeZones, rng = Math.random) {
  const nextRandom = () => {
    const value = Number(rng());
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(0.999999999, value));
  };
  const playableZones = activeZones
    .map((zone, zoneIndex) => ({
      zoneIndex,
      zoneKey: getRhythmGameZoneKey(zone),
      deckSlot: zone.deckSlot,
      localRow: zone.localRow,
      localColumn: zone.localColumn,
      sfxId: zone.sfxId,
      keyboardLabel: zone.keyboardLabel,
    }))
    .filter(zone => zone.zoneKey);
  if (playableZones.length === 0) {
    return { barCount: 0, duration: 0, totalJudgements: 0, notes: [] };
  }

  const minimumPhraseGroups = Math.ceil(
    RHYTHM_GAME_MIN_BARS / RHYTHM_GAME_PHRASE_BARS
  );
  const maximumPhraseGroups = Math.floor(
    RHYTHM_GAME_MAX_BARS / RHYTHM_GAME_PHRASE_BARS
  );
  const phraseGroupCount = minimumPhraseGroups + Math.floor(
    nextRandom() * (maximumPhraseGroups - minimumPhraseGroups + 1)
  );
  const barCount = phraseGroupCount * RHYTHM_GAME_PHRASE_BARS;
  const barDuration = SPB * 4;
  const chartDuration = barCount * barDuration;
  const deckSlots = [...new Set(playableZones.map(zone => zone.deckSlot))];
  const zonesByDeckRow = new Map();
  for (const zone of playableZones) {
    const key = `${zone.deckSlot}:${zone.localRow}`;
    const rowZones = zonesByDeckRow.get(key) ?? [];
    rowZones.push(zone);
    zonesByDeckRow.set(key, rowZones);
  }
  for (const rowZones of zonesByDeckRow.values()) {
    rowZones.sort((left, right) => left.localColumn - right.localColumn);
  }

  const notes = [];
  let eventSerial = 0;
  let phraseSerial = 0;
  const templateCounters = new Map();
  const deckStates = new Map(deckSlots.map(deckSlot => [
    deckSlot,
    {
      column: Math.floor(nextRandom() * 4),
      direction: nextRandom() < 0.5 ? -1 : 1,
    },
  ]));

  const getZone = (deckSlot, localRow, localColumn) => {
    const rowZones = zonesByDeckRow.get(`${deckSlot}:${localRow}`) ?? [];
    return rowZones.find(zone => zone.localColumn === localColumn) ?? null;
  };

  const getDeckSfxId = (deckSlot) => playableZones.find(
    zone => zone.deckSlot === deckSlot
  )?.sfxId ?? 'dagou';

  const advanceDeckColumn = (deckSlot, forceMove = false) => {
    const state = deckStates.get(deckSlot);
    if (!state) return 0;
    const shouldMove = forceMove || nextRandom() >= 0.22;
    if (!shouldMove) return state.column;
    let nextColumn = state.column + state.direction;
    if (nextColumn < 0 || nextColumn > 3) {
      state.direction *= -1;
      nextColumn = state.column + state.direction;
    }
    state.column = Math.max(0, Math.min(3, nextColumn));
    if (!forceMove && nextRandom() < 0.2) state.direction *= -1;
    return state.column;
  };

  const nextPhraseTemplate = (deckSlot) => {
    const sfxId = getDeckSfxId(deckSlot);
    const templates = RHYTHM_GAME_PHRASE_TEMPLATES[sfxId] ??
      RHYTHM_GAME_PHRASE_TEMPLATES.dagou;
    const counter = templateCounters.get(sfxId) ?? 0;
    templateCounters.set(sfxId, counter + 1);
    return templates[counter % templates.length];
  };

  const appendNote = (target, time, options = {}) => {
    if (!target) return null;
    const kind = options.kind === 'hold' ? 'hold' : 'tap';
    const duration = kind === 'hold' ? Math.max(0, options.duration ?? 0) : 0;
    const slideTargets = kind === 'hold'
      ? (options.slideTargets ?? []).map(slideTarget => ({ ...slideTarget }))
      : [];
    const holdTickTimes = [];
    if (kind === 'hold' && slideTargets.length === 0) {
      for (let tickTime = time + SPB; tickTime < time + duration - 0.01; tickTime += SPB) {
        holdTickTimes.push(tickTime);
      }
    }
    const note = {
      id: 0,
      eventId: ++eventSerial,
      chordId: options.chordId ?? null,
      kind,
      time,
      duration,
      endTime: time + duration,
      holdTickTimes,
      nextHoldTickIndex: 0,
      slideTargets,
      nextSlideIndex: 0,
      zoneKey: target.zoneKey,
      currentZoneKey: target.zoneKey,
      displayZoneKey: target.zoneKey,
      deckSlot: target.deckSlot,
      localRow: target.localRow,
      localColumn: target.localColumn,
      sfxId: target.sfxId,
      keyboardLabel: target.keyboardLabel,
      displayKeyboardLabel: target.keyboardLabel,
      phraseId: options.phraseId ?? null,
      phraseText: options.phraseText ?? null,
      phraseRole: options.phraseRole ?? null,
      phraseTokenIndex: options.phraseTokenIndex ?? null,
      status: 'pending',
      judgement: null,
      releaseJudgement: null,
      inputId: null,
      judgedAt: null,
      element: null,
      kindElement: null,
      keyElement: null,
    };
    notes.push(note);
    return note;
  };

  const appendPhrase = (
    deckSlot,
    startStep,
    template,
    { role = 'lead', chordAtStart = null, variation = false } = {}
  ) => {
    const state = deckStates.get(deckSlot);
    if (!state) return [];
    if (variation) state.direction *= -1;
    const phraseId = `phrase-${++phraseSerial}-${template.id}`;
    const phraseNotes = [];
    for (let index = 0; index < template.rows.length; index++) {
      if (index > 0) {
        const repeatedSyllable = template.rows[index] === template.rows[index - 1];
        advanceDeckColumn(deckSlot, repeatedSyllable);
      }
      const target = getZone(deckSlot, template.rows[index], state.column);
      const note = appendNote(
        target,
        (startStep + template.steps[index]) * S8,
        {
          chordId: index === 0 ? chordAtStart : null,
          phraseId,
          phraseText: template.text,
          phraseRole: role,
          phraseTokenIndex: index,
        }
      );
      if (note) phraseNotes.push(note);
    }
    return phraseNotes;
  };

  const appendAccent = (deckSlot, step, chordId, phraseRole) => {
    const state = deckStates.get(deckSlot);
    if (!state) return null;
    const target = getZone(deckSlot, 2, state.column);
    const note = appendNote(target, step * S8, { chordId, phraseRole });
    advanceDeckColumn(deckSlot);
    return note;
  };

  const appendSlideHold = (deckSlot, startStep, phraseGroup) => {
    const state = deckStates.get(deckSlot);
    if (!state) return null;
    const startTarget = getZone(deckSlot, 2, state.column);
    const slideTargets = [];
    for (const stepOffset of [2, 4]) {
      const column = advanceDeckColumn(deckSlot, true);
      const target = getZone(deckSlot, 2, column);
      if (target) {
        slideTargets.push({
          ...target,
          time: (startStep + stepOffset) * S8,
        });
      }
    }
    return appendNote(startTarget, startStep * S8, {
      kind: 'hold',
      duration: 6 * S8,
      slideTargets,
      phraseId: `legato-${phraseGroup}`,
      phraseText: '连音链',
      phraseRole: 'legato',
    });
  };

  const firstDeckIndex = Math.floor(nextRandom() * deckSlots.length);
  const deckDirection = nextRandom() < 0.5 ? -1 : 1;
  const wrapDeckIndex = index => (
    (index % deckSlots.length) + deckSlots.length
  ) % deckSlots.length;
  for (let phraseGroup = 0; phraseGroup < phraseGroupCount; phraseGroup++) {
    const groupStartStep = phraseGroup * RHYTHM_GAME_PHRASE_BARS * 8;
    const leadIndex = wrapDeckIndex(
      firstDeckIndex + phraseGroup * deckDirection
    );
    const responseIndex = wrapDeckIndex(leadIndex + deckDirection);
    const leadDeck = deckSlots[leadIndex];
    const responseDeck = deckSlots[responseIndex];
    const leadTemplate = nextPhraseTemplate(leadDeck);
    const responseTemplate = nextPhraseTemplate(responseDeck);

    appendPhrase(leadDeck, groupStartStep, leadTemplate, { role: 'theme' });
    appendPhrase(leadDeck, groupStartStep + 8, leadTemplate, {
      role: 'variation',
      variation: true,
    });

    const answerChordId = `chord-answer-${phraseGroup}`;
    appendAccent(
      leadDeck,
      groupStartStep + 16,
      answerChordId,
      'answer-accent'
    );
    appendPhrase(responseDeck, groupStartStep + 16, responseTemplate, {
      role: 'answer',
      chordAtStart: answerChordId,
    });

    const cadenceStartStep = groupStartStep + 24;
    if (phraseGroup % 2 === 0) {
      appendSlideHold(leadDeck, cadenceStartStep, phraseGroup);
      const responseState = deckStates.get(responseDeck);
      for (const [index, stepOffset] of [2, 4].entries()) {
        if (!responseState) continue;
        const target = getZone(responseDeck, index, responseState.column);
        appendNote(target, (cadenceStartStep + stepOffset) * S8, {
          phraseRole: 'legato-answer',
        });
        advanceDeckColumn(responseDeck);
      }
    } else {
      const cadenceChordId = `chord-cadence-${phraseGroup}`;
      appendAccent(
        responseDeck,
        cadenceStartStep,
        cadenceChordId,
        'cadence-accent'
      );
      appendPhrase(leadDeck, cadenceStartStep, leadTemplate, {
        role: 'cadence',
        chordAtStart: cadenceChordId,
        variation: true,
      });
    }
  }

  notes.sort((left, right) =>
    left.time - right.time || left.eventId - right.eventId
  );
  notes.forEach((note, index) => {
    note.id = index + 1;
  });

  const totalJudgements = notes.reduce(
    (total, note) => total + (
      note.kind === 'hold'
        ? 2 + note.holdTickTimes.length + note.slideTargets.length
        : 1
    ),
    0
  );

  return {
    barCount,
    phraseGroupCount,
    duration: chartDuration,
    totalJudgements,
    notes,
  };
}

function classifyRhythmGameTiming(offsetSeconds) {
  const distance = Math.abs(Number(offsetSeconds));
  if (!Number.isFinite(distance)) return null;
  if (distance <= RHYTHM_GAME_PERFECT_WINDOW) return 'perfect';
  if (distance <= RHYTHM_GAME_GOOD_WINDOW) return 'good';
  return null;
}

function classifyRhythmGameSlideTiming(offsetSeconds) {
  const distance = Math.abs(Number(offsetSeconds));
  if (!Number.isFinite(distance)) return null;
  if (distance <= RHYTHM_GAME_PERFECT_WINDOW) return 'perfect';
  if (distance <= RHYTHM_GAME_SLIDE_GOOD_WINDOW) return 'good';
  return null;
}

function getRhythmGameGrade(accuracy) {
  if (accuracy >= 0.96) return 'S';
  if (accuracy >= 0.9) return 'A';
  if (accuracy >= 0.78) return 'B';
  if (accuracy >= 0.65) return 'C';
  return 'D';
}

function formatRhythmGameTime(seconds) {
  const wholeSeconds = Math.max(0, Math.ceil(Number(seconds) || 0));
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function isRhythmGameActive() {
  return rhythmGame.phase === 'countdown' || rhythmGame.phase === 'playing';
}

function isRhythmGameVisible() {
  return isRhythmGameActive() || rhythmGame.phase === 'results';
}

function shouldQuantizePerformanceInput() {
  return performanceSettings.rhythmSnap && !isRhythmGameActive();
}

function renderRhythmGameLaunch() {
  const active = isRhythmGameVisible();
  const disabled = !performanceSettings.djMode || djSettingsSaving || active;
  rhythmGameLaunch.setAttribute(
    'aria-pressed',
    String(active && !rhythmGame.autoplay)
  );
  rhythmGameLaunch.disabled = disabled;
  rhythmGameLaunchAction.textContent = active && !rhythmGame.autoplay
    ? '进行中'
    : '手动开始';
  rhythmGameAutoplayLaunch.setAttribute(
    'aria-pressed',
    String(active && rhythmGame.autoplay)
  );
  rhythmGameAutoplayLaunch.classList.toggle(
    'is-active',
    active && rhythmGame.autoplay
  );
  rhythmGameAutoplayLaunch.disabled = disabled;
  rhythmGameAutoplayAction.textContent = active && rhythmGame.autoplay
    ? '演奏中'
    : '自动演奏';
  rhythmGameLaunchDescription.textContent =
    `当前难度：${djSettings.deckCount} Deck · ` +
    `${djSettings.deckCount * 12} 区域 · 四小节乐句 · 1–3 分钟`;
}

function clearRhythmGameCues() {
  for (const note of rhythmGame.visibleNotes) {
    note.element = null;
    note.kindElement = null;
    note.keyElement = null;
  }
  rhythmGame.visibleNotes.clear();
  rhythmGameCues.replaceChildren();
}

function resolveRhythmGameZoneIndex(note) {
  const zoneKey = note.displayZoneKey ?? note.zoneKey;
  return zones.findIndex(
    zone => getRhythmGameZoneKey(zone) === zoneKey
  );
}

function setRhythmGameCueTarget(note, target) {
  if (!note || !target?.zoneKey) return;
  note.displayZoneKey = target.zoneKey;
  note.displayKeyboardLabel = target.keyboardLabel ?? '';
  if (note.keyElement) {
    note.keyElement.textContent = note.displayKeyboardLabel;
  }
}

function getRhythmGameZoneCenter(zoneIndexValue) {
  const { width, height, left, top } = getStageMetrics();
  const column = zoneIndexValue % cols;
  const row = Math.floor(zoneIndexValue / cols);
  return {
    x: left + (column + 0.5) * width / cols,
    y: top + (row + 0.5) * height / rows,
  };
}

function isRhythmGameAutoplayInput(inputId) {
  return typeof inputId === 'string' &&
    inputId.startsWith(RHYTHM_GAME_AUTOPLAY_INPUT_PREFIX);
}

function positionRhythmGameCue(note) {
  if (!note.element) return false;
  const zone = resolveRhythmGameZoneIndex(note);
  if (zone < 0) return false;
  note.element.style.gridColumn = String(zone % cols + 1);
  note.element.style.gridRow = String(Math.floor(zone / cols) + 1);
  return true;
}

function createRhythmGameCue(note) {
  const element = document.createElement('div');
  element.className = 'rhythm-game-note';
  element.classList.toggle('is-hold', note.kind === 'hold');
  element.classList.toggle(
    'is-slide',
    note.kind === 'hold' && note.slideTargets.length > 0
  );
  element.setAttribute('aria-hidden', 'true');
  const target = document.createElement('div');
  target.className = 'rhythm-game-note-target';
  const emoji = document.createElement('span');
  emoji.className = 'rhythm-game-note-emoji';
  emoji.textContent = SFX_EMOJIS[note.sfxId] ?? '♪';
  const key = document.createElement('span');
  key.className = 'rhythm-game-note-key';
  key.textContent = note.displayKeyboardLabel ?? note.keyboardLabel ?? '';
  const kind = document.createElement('span');
  kind.className = 'rhythm-game-note-kind';
  kind.textContent = note.kind === 'hold' ? '按住' : '';
  target.append(emoji, key, kind);
  element.appendChild(target);
  note.element = element;
  note.kindElement = kind;
  note.keyElement = key;
  rhythmGame.visibleNotes.add(note);
  positionRhythmGameCue(note);
  rhythmGameCues.appendChild(element);
}

function removeRhythmGameCue(note) {
  note.element?.remove();
  note.element = null;
  note.kindElement = null;
  note.keyElement = null;
  rhythmGame.visibleNotes.delete(note);
}

function completeRhythmGameCue(note, judgement, elapsed) {
  if (!note.element) createRhythmGameCue(note);
  note.status = 'done';
  note.judgedAt = elapsed;
  note.element?.classList.remove(
    'is-due',
    'is-holding',
    'is-release-due',
    'is-slide-due'
  );
  note.element?.classList.add('is-judged', `is-${judgement}`);
  note.element?.style.setProperty('--rhythm-note-opacity', '1');
  note.element?.style.setProperty('--rhythm-note-scale', '1');
  if (note.kindElement) {
    note.kindElement.textContent = judgement === 'miss' ? '中断' : '完成';
  }
}

function activateRhythmGameHoldCue(note, judgement, inputId) {
  if (!note.element) createRhythmGameCue(note);
  note.status = 'holding';
  note.judgement = judgement;
  note.inputId = inputId;
  note.currentZoneKey = note.zoneKey;
  note.nextSlideIndex = 0;
  setRhythmGameCueTarget(note, note);
  note.element?.classList.remove('is-due');
  note.element?.classList.add('is-holding');
  note.element?.style.setProperty('--rhythm-note-opacity', '1');
  note.element?.style.setProperty('--rhythm-note-scale', '1');
  if (note.kindElement) note.kindElement.textContent = '按住';
  rhythmGame.activeHolds.set(inputId, note);
}

function showRhythmGameJudgement(text, kind) {
  rhythmGameJudgement.className = '';
  rhythmGameJudgement.textContent = text;
  void rhythmGameJudgement.offsetWidth;
  rhythmGameJudgement.classList.add('is-visible', `is-${kind}`);
}

function updateRhythmGameHud(elapsed) {
  rhythmGameScore.textContent = String(rhythmGame.score).padStart(6, '0');
  rhythmGameCombo.textContent = String(rhythmGame.combo);
  rhythmGameTime.textContent = formatRhythmGameTime(
    rhythmGame.duration - Math.max(0, elapsed)
  );
}

function awardRhythmGameHit(
  judgement,
  perfectScore = 1000,
  goodScore = 650,
  announce = true
) {
  rhythmGame.combo++;
  rhythmGame.maxCombo = Math.max(rhythmGame.maxCombo, rhythmGame.combo);
  if (judgement === 'perfect') {
    rhythmGame.perfect++;
    rhythmGame.score += perfectScore + Math.min(50, rhythmGame.combo - 1) * 10;
    if (announce) showRhythmGameJudgement('完美', 'perfect');
  } else {
    rhythmGame.good++;
    rhythmGame.score += goodScore + Math.min(50, rhythmGame.combo - 1) * 5;
    if (announce) showRhythmGameJudgement('良好', 'good');
  }
}

function addRhythmGameMisses(count = 1, message = '漏拍') {
  rhythmGame.miss += Math.max(0, Number(count) || 0);
  rhythmGame.combo = 0;
  showRhythmGameJudgement(message, 'miss');
}

function recordRhythmGameMiss(note, elapsed) {
  note.judgement = 'miss';
  if (note.kind === 'hold') {
    note.releaseJudgement = 'miss';
    note.nextHoldTickIndex = note.holdTickTimes.length;
    note.nextSlideIndex = note.slideTargets.length;
    addRhythmGameMisses(
      2 + note.holdTickTimes.length + note.slideTargets.length,
      note.slideTargets.length > 0 ? '连音漏拍' : '长按漏拍'
    );
  } else {
    addRhythmGameMisses();
  }
  completeRhythmGameCue(note, 'miss', elapsed);
}

function scoreDueRhythmGameHoldTicks(note, elapsed) {
  while (
    note.nextHoldTickIndex < note.holdTickTimes.length &&
    note.holdTickTimes[note.nextHoldTickIndex] <= elapsed
  ) {
    awardRhythmGameHit('perfect', 420, 420, false);
    note.nextHoldTickIndex++;
  }
}

function finishRhythmGameHold(note, judgement, elapsed) {
  if (!note || note.status !== 'holding') return;
  scoreDueRhythmGameHoldTicks(note, Math.min(elapsed, note.endTime));
  const remainingTicks = note.holdTickTimes.length - note.nextHoldTickIndex;
  const remainingSlides = note.slideTargets.length - note.nextSlideIndex;
  const remainingHoldJudgements = remainingTicks + remainingSlides;
  if (remainingHoldJudgements > 0) {
    note.nextHoldTickIndex = note.holdTickTimes.length;
    note.nextSlideIndex = note.slideTargets.length;
    addRhythmGameMisses(
      remainingHoldJudgements,
      note.slideTargets.length > 0 ? '连音中断' : '长按中断'
    );
  }

  rhythmGame.activeHolds.delete(note.inputId);
  const releaseJudgement = remainingHoldJudgements > 0 ? null : judgement;
  note.releaseJudgement = releaseJudgement;
  if (releaseJudgement) {
    awardRhythmGameHit(releaseJudgement, 800, 520, false);
    showRhythmGameJudgement(
      releaseJudgement === 'perfect' ? '松手完美' : '松手良好',
      releaseJudgement
    );
    completeRhythmGameCue(note, releaseJudgement, elapsed);
  } else {
    addRhythmGameMisses(1, '长按中断');
    completeRhythmGameCue(note, 'miss', elapsed);
  }
}

function releaseRhythmGameHold(inputId, cancelled = false) {
  const note = rhythmGame.activeHolds.get(inputId);
  if (!note || !ctx) return false;
  const elapsed = ctx.currentTime - rhythmGame.startAt;
  const judgement = cancelled
    ? null
    : classifyRhythmGameTiming(elapsed - note.endTime);
  finishRhythmGameHold(note, judgement, elapsed);
  updateRhythmGameHud(elapsed);
  return true;
}

function handleRhythmGameHoldZoneChange(inputId, nextZoneIndex) {
  const note = rhythmGame.activeHolds.get(inputId);
  if (!note) return false;
  const nextZoneKey = getRhythmGameZoneKey(zones[nextZoneIndex]);
  if (nextZoneKey === note.currentZoneKey) return true;
  const slideTarget = note.slideTargets[note.nextSlideIndex];
  if (!slideTarget || nextZoneKey !== slideTarget.zoneKey || !ctx) {
    releaseRhythmGameHold(inputId, true);
    return false;
  }

  const elapsed = ctx.currentTime - rhythmGame.startAt;
  const judgement = classifyRhythmGameSlideTiming(
    elapsed - slideTarget.time
  );
  if (!judgement) {
    releaseRhythmGameHold(inputId, true);
    return false;
  }

  note.currentZoneKey = nextZoneKey;
  note.nextSlideIndex++;
  setRhythmGameCueTarget(note, slideTarget);
  awardRhythmGameHit(judgement, 760, 500, false);
  showRhythmGameJudgement(
    judgement === 'perfect' ? '滑音完美' : '滑音良好',
    judgement
  );
  updateRhythmGameHud(elapsed);
  return true;
}

function judgeRhythmGameInput(zoneIndexValue, inputId) {
  if (!isRhythmGameActive() || !ctx) return false;
  if (rhythmGame.autoplay && !isRhythmGameAutoplayInput(inputId)) return false;
  const zone = zones[zoneIndexValue];
  const zoneKey = getRhythmGameZoneKey(zone);
  if (!zoneKey) return false;
  const elapsed = ctx.currentTime - rhythmGame.startAt;
  if (elapsed < -RHYTHM_GAME_GOOD_WINDOW) return false;

  let matchedNote = null;
  let matchedOffset = Infinity;
  for (const note of rhythmGame.notes) {
    if (note.status !== 'pending') continue;
    if (note.time > elapsed + RHYTHM_GAME_GOOD_WINDOW) break;
    if (note.zoneKey !== zoneKey) continue;
    const offset = elapsed - note.time;
    if (
      Math.abs(offset) <= RHYTHM_GAME_GOOD_WINDOW &&
      Math.abs(offset) < Math.abs(matchedOffset)
    ) {
      matchedNote = note;
      matchedOffset = offset;
    }
  }

  const judgement = matchedNote
    ? classifyRhythmGameTiming(matchedOffset)
    : null;
  if (!matchedNote || !judgement) {
    rhythmGame.combo = 0;
    rhythmGame.wrong++;
    showRhythmGameJudgement('偏离', 'wrong');
    updateRhythmGameHud(elapsed);
    return false;
  }

  awardRhythmGameHit(judgement);
  if (matchedNote.kind === 'hold') {
    activateRhythmGameHoldCue(matchedNote, judgement, inputId);
  } else {
    matchedNote.judgement = judgement;
    completeRhythmGameCue(matchedNote, judgement, elapsed);
  }
  updateRhythmGameHud(elapsed);
  return true;
}

function startRhythmGameAutoplayNote(note) {
  if (!note || note.status !== 'pending') return false;
  const zoneIndexValue = resolveRhythmGameZoneIndex(note);
  if (zoneIndexValue < 0) return false;
  const inputId = `${RHYTHM_GAME_AUTOPLAY_INPUT_PREFIX}${note.id}`;
  if (!judgeRhythmGameInput(zoneIndexValue, inputId)) return false;

  const center = getRhythmGameZoneCenter(zoneIndexValue);
  beginTouchTrail(inputId, center.x, center.y);
  const state = {
    zone: -1,
    voice: null,
    pendingEntryId: null,
    lastX: center.x,
    lastY: center.y,
  };
  pointers.set(inputId, state);
  enterZone(inputId, state, zoneIndexValue);
  if (note.kind === 'tap') {
    rhythmGame.autoplayTapReleases.push({
      inputId,
      time: note.time + RHYTHM_GAME_AUTOPLAY_TAP_DURATION,
    });
  }
  return true;
}

function updateRhythmGameAutoplay(elapsed) {
  if (!rhythmGame.autoplay) return;

  for (let index = rhythmGame.autoplayTapReleases.length - 1; index >= 0; index--) {
    const release = rhythmGame.autoplayTapReleases[index];
    if (release.time - elapsed > RHYTHM_GAME_AUTOPLAY_LOOKAHEAD) continue;
    rhythmGame.autoplayTapReleases.splice(index, 1);
    endInput(release.inputId, true);
  }

  for (const [inputId, note] of [...rhythmGame.activeHolds.entries()]) {
    if (!isRhythmGameAutoplayInput(inputId)) continue;
    let slideTarget = note.slideTargets[note.nextSlideIndex];
    while (
      slideTarget &&
      slideTarget.time - elapsed <= RHYTHM_GAME_AUTOPLAY_LOOKAHEAD
    ) {
      const zoneIndexValue = resolveRhythmGameZoneIndex(slideTarget);
      const state = pointers.get(inputId);
      if (zoneIndexValue < 0 || !state) break;
      const previousSlideIndex = note.nextSlideIndex;
      const center = getRhythmGameZoneCenter(zoneIndexValue);
      moveTouchTrail(inputId, center.x, center.y);
      enterZone(inputId, state, zoneIndexValue);
      state.lastX = center.x;
      state.lastY = center.y;
      if (note.nextSlideIndex === previousSlideIndex) break;
      slideTarget = note.slideTargets[note.nextSlideIndex];
    }
    if (note.endTime - elapsed <= RHYTHM_GAME_AUTOPLAY_LOOKAHEAD) {
      endInput(inputId, true);
    }
  }

  while (
    rhythmGame.nextAutoplayIndex < rhythmGame.notes.length &&
    rhythmGame.notes[rhythmGame.nextAutoplayIndex].time - elapsed <=
      RHYTHM_GAME_AUTOPLAY_LOOKAHEAD
  ) {
    const note = rhythmGame.notes[rhythmGame.nextAutoplayIndex];
    rhythmGame.nextAutoplayIndex++;
    if (note.status === 'pending') startRhythmGameAutoplayNote(note);
  }
}

function resetRhythmGame() {
  clearRhythmGameCues();
  rhythmGame.activeHolds.clear();
  rhythmGame.phase = 'idle';
  rhythmGame.notes = [];
  rhythmGame.duration = 0;
  rhythmGame.startAt = 0;
  rhythmGame.nextCueIndex = 0;
  rhythmGame.nextMissIndex = 0;
  rhythmGame.autoplay = false;
  rhythmGame.nextAutoplayIndex = 0;
  rhythmGame.autoplayTapReleases = [];
  rhythmGame.totalJudgements = 0;
  rhythmGame.score = 0;
  rhythmGame.combo = 0;
  rhythmGame.maxCombo = 0;
  rhythmGame.perfect = 0;
  rhythmGame.good = 0;
  rhythmGame.miss = 0;
  rhythmGame.wrong = 0;
  rhythmGame.countdownText = '';
  rhythmGameHud.hidden = true;
  rhythmGameAutoBadge.hidden = true;
  rhythmGameCountdown.textContent = '';
  rhythmGameJudgement.textContent = '';
  rhythmGameJudgement.className = '';
  rhythmGameLayer.classList.remove('is-visible', 'is-results', 'is-autoplay');
  rhythmGameLayer.setAttribute('aria-hidden', 'true');
  rhythmGameLayer.inert = true;
  stage.classList.remove('is-rhythm-game');
  renderRhythmGameLaunch();
  renderKeyGrid();
}

function leaveRhythmGame(showNotice = false) {
  if (!isRhythmGameVisible()) return;
  stopActivePerformanceInput();
  resetRhythmGame();
  showControls();
  if (showNotice) showToyNotice('已退出音游模式');
}

function finishRhythmGame() {
  if (!isRhythmGameActive()) return;
  stopActivePerformanceInput();
  clearRhythmGameCues();
  rhythmGame.phase = 'results';
  rhythmGameHud.hidden = true;
  rhythmGameCountdown.textContent = '';
  rhythmGameJudgement.textContent = '';
  rhythmGameJudgement.className = '';
  rhythmGameLayer.classList.add('is-results');
  const hits = rhythmGame.perfect + rhythmGame.good;
  const accuracy = rhythmGame.totalJudgements > 0
    ? hits / rhythmGame.totalJudgements
    : 0;
  rhythmGameResultTitle.textContent = rhythmGame.autoplay
    ? '自动演奏完成'
    : '谱面完成';
  rhythmGameResultGrade.textContent = getRhythmGameGrade(accuracy);
  rhythmGameResultScore.textContent = rhythmGame.score.toLocaleString('zh-CN');
  rhythmGameResultAccuracy.textContent = `${Math.round(accuracy * 100)}%`;
  rhythmGameResultCombo.textContent = String(rhythmGame.maxCombo);
  rhythmGameResultHits.textContent = `${rhythmGame.perfect} / ${rhythmGame.good}`;
  rhythmGameResultMisses.textContent = String(rhythmGame.miss);
  renderRhythmGameLaunch();
  renderKeyGrid();
  rhythmGameRetry.focus({ preventScroll: true });
}

async function startRhythmGame({ autoplay = false } = {}) {
  if (!performanceSettings.djMode || isRhythmGameActive()) return false;
  if (rhythmGame.phase === 'results') resetRhythmGame();
  const ready = await start();
  if (!ready || !performanceSettings.djMode || !ctx) return false;

  stopActivePerformanceInput();
  const chart = createRhythmGameChart(zones);
  if (chart.notes.length === 0) {
    showToyNotice('当前 Deck 没有可用区域。', true);
    return false;
  }
  clearRhythmGameCues();
  rhythmGame.phase = 'countdown';
  rhythmGame.notes = chart.notes;
  rhythmGame.duration = chart.duration;
  rhythmGame.totalJudgements = chart.totalJudgements;
  const barDuration = SPB * 4;
  rhythmGame.startAt = startTime + Math.ceil(
    (ctx.currentTime + 2.4 - startTime) / barDuration
  ) * barDuration;
  rhythmGame.nextCueIndex = 0;
  rhythmGame.nextMissIndex = 0;
  rhythmGame.autoplay = Boolean(autoplay);
  rhythmGame.nextAutoplayIndex = 0;
  rhythmGame.autoplayTapReleases = [];
  rhythmGame.activeHolds.clear();
  rhythmGame.score = 0;
  rhythmGame.combo = 0;
  rhythmGame.maxCombo = 0;
  rhythmGame.perfect = 0;
  rhythmGame.good = 0;
  rhythmGame.miss = 0;
  rhythmGame.wrong = 0;
  rhythmGame.countdownText = '';
  rhythmGameCues.style.setProperty('--rhythm-game-cols', String(cols));
  rhythmGameCues.style.setProperty('--rhythm-game-rows', String(rows));
  rhythmGameLayer.classList.add('is-visible');
  rhythmGameLayer.classList.remove('is-results');
  rhythmGameLayer.classList.toggle('is-autoplay', rhythmGame.autoplay);
  rhythmGameLayer.setAttribute('aria-hidden', 'false');
  rhythmGameLayer.inert = false;
  rhythmGameHud.hidden = false;
  rhythmGameAutoBadge.hidden = !rhythmGame.autoplay;
  stage.classList.add('is-rhythm-game');
  closeSettings();
  renderRhythmGameLaunch();
  renderKeyGrid();
  updateRhythmGameHud(ctx.currentTime - rhythmGame.startAt);
  return true;
}

function updateRhythmGame(audioNow) {
  if (!isRhythmGameActive()) return;
  const elapsed = audioNow - rhythmGame.startAt;
  rhythmGameCues.style.setProperty('--rhythm-game-cols', String(cols));
  rhythmGameCues.style.setProperty('--rhythm-game-rows', String(rows));

  let countdownText = '';
  if (elapsed < -3) countdownText = '准备';
  else if (elapsed < 0) countdownText = String(Math.ceil(-elapsed));
  else if (elapsed < 0.42) countdownText = '开始';
  if (countdownText !== rhythmGame.countdownText) {
    rhythmGame.countdownText = countdownText;
    rhythmGameCountdown.textContent = countdownText;
  }
  if (elapsed >= 0 && rhythmGame.phase === 'countdown') {
    rhythmGame.phase = 'playing';
  }

  while (
    rhythmGame.nextCueIndex < rhythmGame.notes.length &&
    rhythmGame.notes[rhythmGame.nextCueIndex].time - elapsed <= RHYTHM_GAME_CUE_LEAD
  ) {
    createRhythmGameCue(rhythmGame.notes[rhythmGame.nextCueIndex]);
    rhythmGame.nextCueIndex++;
  }

  updateRhythmGameAutoplay(elapsed);

  while (
    rhythmGame.nextMissIndex < rhythmGame.notes.length &&
    rhythmGame.notes[rhythmGame.nextMissIndex].time + RHYTHM_GAME_MISS_WINDOW < elapsed
  ) {
    const note = rhythmGame.notes[rhythmGame.nextMissIndex];
    if (note.status === 'pending') recordRhythmGameMiss(note, elapsed);
    rhythmGame.nextMissIndex++;
  }

  for (const note of new Set(rhythmGame.activeHolds.values())) {
    scoreDueRhythmGameHoldTicks(note, Math.min(elapsed, note.endTime));
    const slideTarget = note.slideTargets[note.nextSlideIndex];
    if (
      slideTarget &&
      elapsed > slideTarget.time + RHYTHM_GAME_SLIDE_GOOD_WINDOW
    ) {
      finishRhythmGameHold(note, null, elapsed);
      continue;
    }
    if (elapsed > note.endTime + RHYTHM_GAME_GOOD_WINDOW) {
      finishRhythmGameHold(note, null, elapsed);
    }
  }

  for (const note of [...rhythmGame.visibleNotes]) {
    if (!positionRhythmGameCue(note)) {
      removeRhythmGameCue(note);
      continue;
    }
    if (note.status === 'done') {
      if (elapsed - note.judgedAt > 0.3) removeRhythmGameCue(note);
      continue;
    }
    if (note.status === 'holding') {
      const remaining = note.endTime - elapsed;
      const progress = Math.max(0, Math.min(1, remaining / note.duration));
      note.element.style.setProperty(
        '--rhythm-hold-progress',
        `${(progress * 100).toFixed(1)}%`
      );
      note.element.style.setProperty('--rhythm-note-scale', '1');
      note.element.style.setProperty('--rhythm-note-opacity', '1');
      const slideTarget = note.slideTargets[note.nextSlideIndex];
      const slideUntil = slideTarget ? slideTarget.time - elapsed : Infinity;
      const showSlideTarget =
        slideTarget && slideUntil <= RHYTHM_GAME_SLIDE_CUE_LEAD;
      if (showSlideTarget) {
        setRhythmGameCueTarget(note, slideTarget);
        positionRhythmGameCue(note);
        const slideApproach = Math.max(
          0,
          Math.min(1, 1 - slideUntil / RHYTHM_GAME_SLIDE_CUE_LEAD)
        );
        note.element.style.setProperty(
          '--rhythm-note-scale',
          (1.34 - slideApproach * 0.34).toFixed(3)
        );
      }
      const slideDue = Boolean(
        slideTarget && Math.abs(slideUntil) <= RHYTHM_GAME_PERFECT_WINDOW
      );
      const releaseDue =
        !slideTarget && Math.abs(remaining) <= RHYTHM_GAME_GOOD_WINDOW;
      note.element.classList.toggle('is-slide-due', slideDue);
      note.element.classList.toggle('is-release-due', releaseDue);
      if (note.kindElement) {
        note.kindElement.textContent = showSlideTarget
          ? '滑到'
          : releaseDue
            ? '松开'
            : '按住';
      }
      continue;
    }
    const until = note.time - elapsed;
    const approach = Math.max(
      0,
      Math.min(1, 1 - until / RHYTHM_GAME_CUE_LEAD)
    );
    const scale = until >= 0
      ? 1.72 - approach * 0.72
      : 1 + Math.min(0.14, -until * 0.5);
    const opacity = Math.max(0.28, Math.min(1, 0.28 + approach * 0.9));
    note.element.style.setProperty('--rhythm-note-scale', scale.toFixed(3));
    note.element.style.setProperty('--rhythm-note-opacity', opacity.toFixed(3));
    note.element.classList.toggle(
      'is-due',
      Math.abs(until) <= RHYTHM_GAME_PERFECT_WINDOW
    );
  }

  updateRhythmGameHud(elapsed);
  if (
    elapsed >= rhythmGame.duration &&
    rhythmGame.nextMissIndex >= rhythmGame.notes.length &&
    rhythmGame.activeHolds.size === 0
  ) {
    finishRhythmGame();
  }
}

function isAnyCharacterHolding() {
  return holding || djDecks.some(deck => deck.holding);
}

function renderKeyGrid() {
  keyGrid.style.setProperty('--key-grid-cols', String(cols));
  keyGrid.style.setProperty('--key-grid-rows', String(rows));
  keyGrid.classList.toggle(
    'is-visible',
    performanceSettings.showGrid || isRhythmGameActive()
  );
  keyGrid.classList.toggle('is-dj-grid', performanceSettings.djMode);

  const fragment = document.createDocumentFragment();
  for (const zone of zones) {
    const cell = document.createElement('div');
    cell.className = 'key-grid-cell';
    cell.dataset.sample = zone.sample;
    if (zone.note) cell.dataset.note = zone.note;
    if (performanceSettings.djMode) {
      cell.dataset.deckId = zone.deckId;
      if (zone.deckIndex > 0 && zone.localColumn === 0 && djLandscape) {
        cell.classList.add('is-deck-start-landscape');
      }
      if (zone.deckIndex > 0 && zone.localRow === 0 && !djLandscape) {
        cell.classList.add('is-deck-start-portrait');
      }
      const key = document.createElement('span');
      key.className = 'key-grid-key';
      key.textContent = zone.keyboardLabel;
      cell.appendChild(key);
    }
    fragment.appendChild(cell);
  }
  keyGrid.replaceChildren(fragment);
}

function applyPerformanceSettings(previousSettings) {
  if (
    previousSettings &&
    previousSettings.rhythmSnap !== performanceSettings.rhythmSnap
  ) {
    // 切换量化方式时丢弃尚未发声的旧队列，避免旧模式的声音滞后冒出。
    clearQueuedPerformanceInput();
  }

  if (
    previousSettings &&
    previousSettings.djMode !== performanceSettings.djMode
  ) {
    if (isRhythmGameVisible()) resetRhythmGame();
    stopActivePerformanceInput();
  }

  if (
    previousSettings &&
    previousSettings.spatialAudio !== performanceSettings.spatialAudio
  ) {
    if (!performanceSettings.spatialAudio) activateManualSoundField();
    updateLiveSpatialOutputs();
  }

  if (
    zones.length === 0 ||
    !previousSettings ||
    previousSettings.pianoMode !== performanceSettings.pianoMode ||
    previousSettings.djMode !== performanceSettings.djMode
  ) {
    buildGrid();
  } else {
    renderKeyGrid();
  }
}

function normalizePerformanceSettings(nextSettings, preferredMode = 'djMode') {
  const normalized = {};
  for (const key of Object.keys(DEFAULT_PERFORMANCE_SETTINGS)) {
    normalized[key] = nextSettings?.[key] === true;
  }
  if (normalized.djMode && normalized.pianoMode) {
    if (preferredMode === 'pianoMode') normalized.djMode = false;
    else normalized.pianoMode = false;
  }
  return normalized;
}

function replacePerformanceSettings(nextSettings, preferredMode = 'djMode') {
  const previousSettings = { ...performanceSettings };
  Object.assign(
    performanceSettings,
    normalizePerformanceSettings(nextSettings, preferredMode)
  );
  applyPerformanceSettings(previousSettings);
}

function getToggledPerformanceSettings(settingName) {
  const nextSettings = {
    ...performanceSettings,
    [settingName]: !performanceSettings[settingName],
  };
  return normalizePerformanceSettings(
    nextSettings,
    nextSettings[settingName] ? settingName : 'djMode'
  );
}

function getChangedPerformanceCloudItems(nextSettings) {
  const items = {};
  for (const [settingName, cloudKey] of Object.entries(
    PERFORMANCE_SETTING_KEYS
  )) {
    if (nextSettings[settingName] === performanceSettings[settingName]) continue;
    items[cloudKey] = nextSettings[settingName] ? '1' : '0';
  }
  return items;
}

function resetPerformanceSettingsToDefaults() {
  replaceDjSettings(DEFAULT_DJ_SETTINGS, false);
  replacePerformanceSettings({
    ...DEFAULT_PERFORMANCE_SETTINGS,
    djMode:
      DEFAULT_PERFORMANCE_SETTINGS.djMode &&
      (DEBUG_UNLOCK_SFX || toyCloudState.sfxUnlocked),
  });
}

function replaceDjSettings(nextSettings, rebuild = true) {
  const deckCount = nextSettings?.deckCount === 3 ? 3 : 2;
  const trailStyle = nextSettings?.trailStyle === 'emoji' ? 'emoji' : 'normal';
  const deckSfxIds = DEFAULT_DJ_SETTINGS.deckSfxIds.map((fallback, slot) => {
    const candidate = nextSettings?.deckSfxIds?.[slot];
    return SFX_SAMPLE_SETS[candidate] ? candidate : fallback;
  });
  const layoutChanged =
    deckCount !== djSettings.deckCount ||
    deckSfxIds.some((sfxId, slot) => sfxId !== djSettings.deckSfxIds[slot]);
  const trailStyleChanged = trailStyle !== djSettings.trailStyle;

  djSettings.deckCount = deckCount;
  djSettings.deckSfxIds = deckSfxIds;
  djSettings.trailStyle = trailStyle;
  if (trailStyleChanged) releaseAllTouchTrails();
  if (layoutChanged && rebuild) {
    if (isRhythmGameVisible()) resetRhythmGame();
    stopActivePerformanceInput();
    buildGrid();
  }
  renderDjSettings();
}

function markToyCloudUnavailable(state = toyCloudState) {
  state.cloudReadable = false;
  renderToyCloudState();
}

function readCloudPerformanceSettings(cloud) {
  const settings = { ...DEFAULT_PERFORMANCE_SETTINGS };
  for (const [settingName, cloudKey] of Object.entries(PERFORMANCE_SETTING_KEYS)) {
    const value = cloud[cloudKey];
    if (value === '1') settings[settingName] = true;
    else if (value === '0') settings[settingName] = false;
  }
  return settings;
}

function readCloudDjSettings(cloud) {
  const storedDeckCount = Number(cloud[TOY_CLOUD_KEYS.djDeckCount]);
  return {
    deckCount: storedDeckCount === 2 || storedDeckCount === 3
      ? storedDeckCount
      : DEFAULT_DJ_SETTINGS.deckCount,
    trailStyle:
      cloud[TOY_CLOUD_KEYS.djTrailStyle] === 'emoji' ? 'emoji' : 'normal',
    deckSfxIds: DJ_DECK_CLOUD_KEYS.map((key, slot) => {
      const sfxId = cloud[key];
      return SFX_SAMPLE_SETS[sfxId]
        ? sfxId
        : DEFAULT_DJ_SETTINGS.deckSfxIds[slot];
    }),
  };
}

function renderDjSettings() {
  const visible = performanceSettings.djMode;
  djSettingsPanel.classList.toggle('is-visible', visible);
  djSettingsPanel.setAttribute('aria-hidden', String(!visible));

  for (const button of djCountButtons) {
    const selected = Number(button.dataset.djCount) === djSettings.deckCount;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-checked', String(selected));
    button.disabled = djSettingsSaving;
  }

  for (const button of djTrailStyleButtons) {
    const selected = button.dataset.djTrailStyle === djSettings.trailStyle;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-checked', String(selected));
    button.disabled = djSettingsSaving;
  }

  for (const row of djDeckAssignmentRows) {
    const slot = Number(row.dataset.djSlot);
    row.classList.toggle('is-hidden', djSettings.deckCount === 2 && slot === 1);
    for (const button of row.querySelectorAll('[data-dj-sfx]')) {
      const selected = button.dataset.djSfx === djSettings.deckSfxIds[slot];
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-checked', String(selected));
      button.disabled = djSettingsSaving;
    }
  }
  renderRhythmGameLaunch();
}

function renderPerformanceSettings() {
  const cloudAvailable =
    toyCloudState.initialized &&
    toyCloudState.environmentAvailable &&
    toyCloudState.cloudReadable;

  for (const button of performanceSettingButtons) {
    const settingName = button.dataset.setting;
    button.setAttribute(
      'aria-checked',
      String(performanceSettings[settingName] === true)
    );
    button.disabled =
      !toyCloudState.initialized ||
      performanceSettingsSaving ||
      djSettingsSaving;
  }
  pianoModeDescription.textContent = performanceSettings.djMode
    ? '开启后退出 DJ，开放一个八度音阶'
    : '开放一个八度的音阶';
  renderDjSettings();
  renderSpatialAudioControls();

  performanceSettingsStatus.classList.toggle(
    'is-error',
    toyCloudState.initialized && !cloudAvailable
  );
  if (performanceSettingsSaving || djSettingsSaving) {
    performanceSettingsStatus.textContent = '正在保存到哔哩哔哩云端…';
  } else if (!toyCloudState.initialized) {
    performanceSettingsStatus.textContent = '正在读取哔哩哔哩云端设置…';
  } else if (cloudAvailable) {
    performanceSettingsStatus.textContent = '设置已通过哔哩哔哩云端同步';
  } else {
    performanceSettingsStatus.textContent = '云存储不可用，本次设置仅在当前页面有效';
  }
}

function renderToyCloudState() {
  const showUpdateDot = !toyCloudState.settingsSeen;
  updateDot.classList.toggle('is-hidden', !showUpdateDot);
  topControls.classList.toggle('has-update-dot', showUpdateDot);

  for (const option of sfxOptions) {
    const sfxId = option.dataset.sfx;
    const isCloudLockedOption = LOCKED_SFX_IDS.has(sfxId);
    const locked = isCloudLockedOption && !toyCloudState.sfxUnlocked;
    option.classList.toggle('is-locked', locked);

    if (isCloudLockedOption) {
      const label = sfxId === 'dingdong' ? '叮咚鸡' : '哈基米';
      option.setAttribute('aria-label', locked ? `${label}，未解锁` : label);
      option.classList.toggle('is-new-hidden', toyCloudState.newSeen[sfxId]);
    }
  }
  renderHajimiCharacterControl();
  renderPerformanceSettings();
}

async function detectToyEnvironment() {
  // Toy SDK 通过父页面握手；独立打开的网页直接使用本地设置，避免等待握手超时。
  if (window.self === window.top) return null;

  const toy = window.toy;
  if (
    !toy ||
    typeof toy.isSupport !== 'function' ||
    TOY_REQUIRED_ABILITIES.some((ability) => typeof toy[ability] !== 'function')
  ) {
    return null;
  }

  try {
    const support = await Promise.all(
      TOY_REQUIRED_ABILITIES.map((ability) => toy.isSupport(ability))
    );
    if (support.some((available) => available !== true)) return null;

    const profile = await toy.getUserProfile();
    const nickname = typeof profile?.nickname === 'string'
      ? profile.nickname.trim()
      : '';
    const avatar = typeof profile?.avatar === 'string'
      ? profile.avatar.trim()
      : '';
    if (!nickname || !avatar) return null;

    return toy;
  } catch (error) {
    console.warn('[大狗Tap] Toy 站内环境检测失败。', error);
    return null;
  }
}

async function initializeToyCloudState() {
  const toy = await detectToyEnvironment();
  if (!toy) {
    toyCloudState.initialized = true;
    resetPerformanceSettingsToDefaults();
    renderToyCloudState();
    return toyCloudState;
  }

  toyCloudState.toy = toy;
  toyCloudState.environmentAvailable = true;

  try {
    const cloud = await toy.getCloudStorage(TOY_CLOUD_KEY_LIST);
    if (!cloud || typeof cloud !== 'object') {
      throw new Error('Toy 云存储返回值无效');
    }
    toyCloudState.cloudReadable = true;
    toyCloudState.sfxUnlocked =
      DEBUG_UNLOCK_SFX || cloud[TOY_CLOUD_KEYS.sfxUnlocked] === '1';
    replaceDjSettings(readCloudDjSettings(cloud), false);
    const cloudPerformanceSettings = readCloudPerformanceSettings(cloud);
    if (!toyCloudState.sfxUnlocked) cloudPerformanceSettings.djMode = false;
    let modeCorrection = null;
    if (cloudPerformanceSettings.djMode && cloudPerformanceSettings.pianoMode) {
      if (cloud[TOY_CLOUD_KEYS.djMode] === '1') {
        cloudPerformanceSettings.pianoMode = false;
        modeCorrection = { [TOY_CLOUD_KEYS.pianoMode]: '0' };
      } else {
        cloudPerformanceSettings.djMode = false;
        modeCorrection = { [TOY_CLOUD_KEYS.djMode]: '0' };
      }
    }
    replacePerformanceSettings(cloudPerformanceSettings);
    if (modeCorrection) {
      try {
        await toy.setCloudStorage(modeCorrection);
      } catch (error) {
        markToyCloudUnavailable(toyCloudState);
        console.warn('[大狗Tap] 演奏模式冲突修正失败。', error);
      }
    }

    if (!toyCloudState.locallyChanged.settingsSeen) {
      toyCloudState.settingsSeen =
        cloud[TOY_CLOUD_KEYS.settingsSeen] === '1';
    }
    if (!toyCloudState.locallyChanged.dingdong) {
      toyCloudState.newSeen.dingdong =
        cloud[TOY_CLOUD_KEYS.dingdongNewSeen] === '1';
    }
    if (!toyCloudState.locallyChanged.hajimi) {
      toyCloudState.newSeen.hajimi =
        cloud[TOY_CLOUD_KEYS.hajimiNewSeen] === '1';
    }
  } catch (error) {
    // 读取不可用时，演奏设置整体保持默认值。
    toyCloudState.cloudReadable = false;
    resetPerformanceSettingsToDefaults();
    console.warn('[大狗Tap] Toy 云状态读取失败。', error);
  }

  toyCloudState.initialized = true;
  renderToyCloudState();
  return toyCloudState;
}

function persistSeenState(items) {
  void toyStateReady.then(async (state) => {
    if (!state.environmentAvailable || !state.cloudReadable || !state.toy) return;

    try {
      await state.toy.setCloudStorage(items);
    } catch (error) {
      markToyCloudUnavailable(state);
      console.warn('[大狗Tap] 提醒状态写入失败。', error);
      showToyNotice(
        '状态保存失败，请确认已登录哔哩哔哩后刷新重试。',
        true
      );
    }
  });
}

function markSettingsSeen() {
  if (toyCloudState.settingsSeen) return;
  toyCloudState.settingsSeen = true;
  toyCloudState.locallyChanged.settingsSeen = true;
  renderToyCloudState();
  persistSeenState({ [TOY_CLOUD_KEYS.settingsSeen]: '1' });
}

function markSfxNewSeen(sfxId) {
  if (!LOCKED_SFX_IDS.has(sfxId) || toyCloudState.newSeen[sfxId]) return;
  toyCloudState.newSeen[sfxId] = true;
  toyCloudState.locallyChanged[sfxId] = true;
  renderToyCloudState();
  const key = sfxId === 'dingdong'
    ? TOY_CLOUD_KEYS.dingdongNewSeen
    : TOY_CLOUD_KEYS.hajimiNewSeen;
  persistSeenState({ [key]: '1' });
}

function markAllSfxNewSeen() {
  const items = {};
  for (const sfxId of LOCKED_SFX_IDS) {
    if (toyCloudState.newSeen[sfxId]) continue;
    toyCloudState.newSeen[sfxId] = true;
    toyCloudState.locallyChanged[sfxId] = true;
    const key = sfxId === 'dingdong'
      ? TOY_CLOUD_KEYS.dingdongNewSeen
      : TOY_CLOUD_KEYS.hajimiNewSeen;
    items[key] = '1';
  }

  if (Object.keys(items).length === 0) return;
  renderToyCloudState();
  persistSeenState(items);
}

async function requireToyCloudContext() {
  const state = await toyStateReady;
  if (!state.environmentAvailable || !state.toy) {
    showToyNotice('请在哔哩哔哩内打开', true);
    return null;
  }
  if (!state.cloudReadable) {
    showToyNotice(
      '云端状态读取失败，请确认已登录哔哩哔哩后刷新重试。',
      true
    );
    return null;
  }
  return state;
}

function renderHajimiCharacterControl() {
  const option = sfxOptions.find((item) => item.dataset.sfx === 'hajimi');
  if (!option) return;

  const isSelected = selectedSfxId === 'hajimi';
  option.classList.toggle('is-character-toggle', isSelected);
  option.classList.toggle(
    'is-animation-active',
    isSelected && hajimiAnimationEnabled
  );
  hajimiOptionImage.src = isSelected && hajimiAnimationEnabled
    ? HAJIMI_ANIMATION_ICON_URL
    : HAJIMI_STATIC_ICON_URL;

  if (option.classList.contains('is-locked')) return;
  const currentVisual = hajimiAnimationEnabled
    ? `东海帝皇循环动画${hajimiAnimationReady ? '' : '（加载中）'}`
    : '哈基米形象';
  const label = isSelected
    ? `哈基米音效已启用，点击切换形象；当前为${currentVisual}`
    : '哈基米';
  option.setAttribute('aria-label', label);
  option.title = label;
}

function getAudioBeatPosition() {
  return started && ctx && startTime > 0 && ctx.currentTime >= startTime
    ? (ctx.currentTime - startTime) / SPB
    : null;
}

function alignHajimiAnimationToBeat() {
  const beatPosition = getAudioBeatPosition();
  hajimiAnimationEpochBeat = Number.isFinite(beatPosition)
    ? Math.ceil(beatPosition - 0.03)
    : 0;
  hajimiAnimationFrame = -1;
}

function renderHajimiAnimationFrame(beatPosition) {
  if (!hajimiAnimationReady) return;
  const relativeBeat = Number.isFinite(beatPosition)
    ? beatPosition - hajimiAnimationEpochBeat
    : 0;
  const loopBeat = relativeBeat > 0
    ? relativeBeat % HAJIMI_ANIMATION_BEATS
    : 0;
  const frameIndex = Math.min(
    HAJIMI_ANIMATION_FRAME_COUNT - 1,
    Math.floor(loopBeat * HAJIMI_FRAMES_PER_BEAT)
  );
  if (frameIndex === hajimiAnimationFrame) return;
  hajimiAnimationFrame = frameIndex;

  const sourceX =
    (frameIndex % HAJIMI_ATLAS_COLUMNS) * HAJIMI_ATLAS_FRAME_WIDTH;
  const sourceY =
    Math.floor(frameIndex / HAJIMI_ATLAS_COLUMNS) * HAJIMI_ATLAS_FRAME_HEIGHT;
  dogAnimation2d.clearRect(
    0,
    0,
    HAJIMI_ATLAS_FRAME_WIDTH,
    HAJIMI_ATLAS_FRAME_HEIGHT
  );
  dogAnimation2d.drawImage(
    dogAnimationAtlas,
    sourceX,
    sourceY,
    HAJIMI_ATLAS_FRAME_WIDTH,
    HAJIMI_ATLAS_FRAME_HEIGHT,
    0,
    0,
    HAJIMI_ATLAS_FRAME_WIDTH,
    HAJIMI_ATLAS_FRAME_HEIGHT
  );
}

function applyHajimiAnimationVisibility() {
  const showAnimation =
    selectedSfxId === 'hajimi' &&
    hajimiAnimationEnabled &&
    hajimiAnimationReady;
  dogInner.classList.toggle('is-hajimi-animation', showAnimation);
  dogAnimationCanvas.setAttribute('aria-hidden', String(!showAnimation));
  if (showAnimation) renderHajimiAnimationFrame(getAudioBeatPosition());
  const characterImages = CHARACTER_IMAGE_SETS[selectedSfxId]
    ?? CHARACTER_IMAGE_SETS.dagou;
  dogCloseImage.alt = showAnimation ? '' : characterImages.alt;
  renderHajimiCharacterControl();
}

function ensureHajimiAnimationLoaded() {
  if (hajimiAnimationReady || hajimiAnimationRequested) return;
  hajimiAnimationRequested = true;
  dogAnimationAtlas.src = HAJIMI_ATLAS_URL;
}

function toggleHajimiCharacter() {
  if (selectedSfxId !== 'hajimi') return;
  hajimiAnimationEnabled = !hajimiAnimationEnabled;
  if (hajimiAnimationEnabled) {
    alignHajimiAnimationToBeat();
    ensureHajimiAnimationLoaded();
    if (!hajimiAnimationReady) showToyNotice('正在加载东海帝皇动画…');
  }
  applyHajimiAnimationVisibility();
}

function selectSfxOption(option) {
  selectedSfxId = SFX_SAMPLE_SETS[option.dataset.sfx]
    ? option.dataset.sfx
    : 'dagou';
  hajimiAnimationEnabled = false;
  const characterImages = CHARACTER_IMAGE_SETS[selectedSfxId]
    ?? CHARACTER_IMAGE_SETS.dagou;
  dogCloseImage.src = characterImages.close;
  dogCloseImage.alt = characterImages.alt;
  dogOpenImage.src = characterImages.open;
  dogInner.classList.toggle('is-hajimi', selectedSfxId === 'hajimi');
  for (const other of sfxOptions) {
    const selected = other === option;
    other.classList.toggle('is-active', selected);
    other.setAttribute('aria-checked', String(selected));
  }
  if (selectedSfxId === 'hajimi') ensureHajimiAnimationLoaded();
  applyHajimiAnimationVisibility();
}

function activateSfxOption(option) {
  if (option.dataset.sfx === 'hajimi' && selectedSfxId === 'hajimi') {
    toggleHajimiCharacter();
    return;
  }
  selectSfxOption(option);
}

function resolveSfxSample(sample, sfxId = selectedSfxId) {
  return SFX_SAMPLE_SETS[sfxId]?.[sample] ?? sample;
}

renderToyCloudState();
const toyStateReady = initializeToyCloudState();

dogAnimationAtlas.addEventListener('load', () => {
  hajimiAnimationReady = true;
  if (hajimiAnimationEnabled) alignHajimiAnimationToBeat();
  applyHajimiAnimationVisibility();
});
dogAnimationAtlas.addEventListener('error', () => {
  const wasWaitingForAnimation = hajimiAnimationEnabled;
  hajimiAnimationEnabled = false;
  hajimiAnimationReady = false;
  hajimiAnimationRequested = false;
  dogAnimationAtlas.removeAttribute('src');
  applyHajimiAnimationVisibility();
  if (wasWaitingForAnimation) {
    showToyNotice('东海帝皇动画加载失败，请稍后重试。', true);
  }
});

async function handlePerformanceSettingClick(button) {
  if (performanceSettingsSaving) return;
  const settingName = button.dataset.setting;
  const cloudKey = PERFORMANCE_SETTING_KEYS[settingName];
  if (!cloudKey) return;

  const state = await toyStateReady;
  const nextSettings = getToggledPerformanceSettings(settingName);
  const nextValue = nextSettings[settingName];
  if (settingName === 'djMode' && nextValue && !state.sfxUnlocked) {
    if (!state.environmentAvailable || !state.toy) {
      showToyNotice('请在哔哩哔哩内打开并解锁音效后使用 DJ 模式', true);
    } else if (!state.cloudReadable) {
      showToyNotice('云端状态读取失败，请刷新后重试。', true);
    } else {
      showToyNotice('DJ 模式需要多套音效，请先点击开发视频完成解锁。');
    }
    return;
  }
  if (!state.environmentAvailable || !state.cloudReadable || !state.toy) {
    replacePerformanceSettings(nextSettings, settingName);
    renderToyCloudState();
    showToyNotice('云存储不可用，本次设置仅在当前页面有效。');
    return;
  }

  performanceSettingsSaving = true;
  renderPerformanceSettings();
  try {
    await state.toy.setCloudStorage(
      getChangedPerformanceCloudItems(nextSettings)
    );
    replacePerformanceSettings(nextSettings, settingName);
  } catch (error) {
    // 写入失败后降级为本地会话设置，保留用户刚刚选择的值。
    markToyCloudUnavailable(state);
    replacePerformanceSettings(nextSettings, settingName);
    console.warn('[大狗Tap] 演奏设置写入失败。', error);
    showToyNotice('云存储不可用，本次设置仅在当前页面有效。');
  } finally {
    performanceSettingsSaving = false;
    renderToyCloudState();
  }
}

for (const button of performanceSettingButtons) {
  button.addEventListener('click', () => {
    void handlePerformanceSettingClick(button);
  });
}

landscapePerformanceSetting.addEventListener('click', () => {
  void setLandscapePerformance(!landscapePerformanceEnabled);
});
landscapeGateRetry.addEventListener('click', () => {
  const landscapeRequest = requestLandscapeExperience();
  renderLandscapePerformancePreference();
  void landscapeRequest.then(() => renderLandscapePerformancePreference());
});
landscapeGateDisable.addEventListener('click', () => {
  void setLandscapePerformance(false);
});

soundFieldSlider.addEventListener('input', () => {
  if (spatialControlMode !== 'manual') return;
  setSoundFieldPosition(Number(soundFieldSlider.value) / 100, true);
});
soundFieldCenterButton.addEventListener('click', centerSoundField);
for (const button of spatialModeButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.spatialMode;
    if (mode === spatialControlMode || gravityPermissionPending) return;
    if (mode === 'gravity') void enableGravitySoundField();
    else activateManualSoundField();
  });
}
for (const eventName of [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'click',
]) {
  soundFieldControl.addEventListener(
    eventName,
    (event) => event.stopPropagation()
  );
}
window.addEventListener('orientationchange', () => {
  window.setTimeout(renderLandscapePerformancePreference, 0);
  if (spatialControlMode === 'gravity') {
    gravityBaseline = null;
    lastGravityTilt = null;
    setSoundFieldPosition(0);
  }
});
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement !== document.documentElement) {
    landscapeFullscreenOwned = false;
  }
  renderLandscapePerformancePreference();
});

async function persistDjSettings(nextSettings, cloudItems) {
  if (djSettingsSaving) return;
  const state = await toyStateReady;
  if (!state.environmentAvailable || !state.cloudReadable || !state.toy) {
    replaceDjSettings(nextSettings);
    renderToyCloudState();
    showToyNotice('云存储不可用，本次 DJ 设置仅在当前页面有效。');
    return;
  }

  djSettingsSaving = true;
  renderToyCloudState();
  try {
    await state.toy.setCloudStorage(cloudItems);
    replaceDjSettings(nextSettings);
  } catch (error) {
    markToyCloudUnavailable(state);
    replaceDjSettings(nextSettings);
    console.warn('[大狗Tap] DJ 设置写入失败。', error);
    showToyNotice('云存储不可用，本次 DJ 设置仅在当前页面有效。');
  } finally {
    djSettingsSaving = false;
    renderToyCloudState();
  }
}

for (const button of djCountButtons) {
  button.addEventListener('click', () => {
    const deckCount = Number(button.dataset.djCount) === 3 ? 3 : 2;
    if (deckCount === djSettings.deckCount) return;
    void persistDjSettings(
      { ...djSettings, deckCount },
      { [TOY_CLOUD_KEYS.djDeckCount]: String(deckCount) }
    );
  });
}

for (const button of djTrailStyleButtons) {
  button.addEventListener('click', () => {
    const trailStyle = button.dataset.djTrailStyle === 'emoji'
      ? 'emoji'
      : 'normal';
    if (trailStyle === djSettings.trailStyle) return;
    void persistDjSettings(
      { ...djSettings, trailStyle },
      { [TOY_CLOUD_KEYS.djTrailStyle]: trailStyle }
    );
  });
}

for (const button of djSfxChoiceButtons) {
  button.addEventListener('click', () => {
    const row = button.closest('.dj-deck-assignment');
    const slot = Number(row?.dataset.djSlot);
    const sfxId = button.dataset.djSfx;
    if (!Number.isInteger(slot) || !SFX_SAMPLE_SETS[sfxId]) return;
    if (djSettings.deckSfxIds[slot] === sfxId) return;
    if (LOCKED_SFX_IDS.has(sfxId) && !toyCloudState.sfxUnlocked) {
      showToyNotice('该音效尚未解锁，请先点击开发视频完成解锁。');
      return;
    }

    const deckSfxIds = [...djSettings.deckSfxIds];
    deckSfxIds[slot] = sfxId;
    void persistDjSettings(
      { ...djSettings, deckSfxIds },
      { [DJ_DECK_CLOUD_KEYS[slot]]: sfxId }
    );
  });
}

rhythmGameLaunch.addEventListener('click', () => {
  void startRhythmGame({ autoplay: false });
});
rhythmGameAutoplayLaunch.addEventListener('click', () => {
  void startRhythmGame({ autoplay: true });
});
rhythmGameEnd.addEventListener('click', () => leaveRhythmGame(true));
rhythmGameBack.addEventListener('click', () => leaveRhythmGame());
rhythmGameRetry.addEventListener('click', () => {
  void startRhythmGame({ autoplay: rhythmGame.autoplay });
});
for (const container of [rhythmGameHud, rhythmGameResults]) {
  for (const eventName of [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'click',
  ]) {
    container.addEventListener(eventName, event => event.stopPropagation());
  }
}

function openSettings() {
  if (settingsOpen) return;
  if (isRhythmGameVisible()) {
    showToyNotice('请先退出当前音游谱面');
    return;
  }
  markSettingsSeen();
  settingsOpen = true;
  settingsOverlay.inert = false;
  settingsOverlay.classList.add('is-open');
  settingsOverlay.setAttribute('aria-hidden', 'false');
  settingsClose.focus({ preventScroll: true });
}

function closeSettings() {
  if (!settingsOpen) return;
  markAllSfxNewSeen();
  settingsOpen = false;
  settingsOverlay.inert = true;
  settingsOverlay.classList.remove('is-open');
  settingsOverlay.setAttribute('aria-hidden', 'true');
  settingsButton.focus({ preventScroll: true });
}

function handleAuthorHomeClick() {
  if (!settingsOpen) return;
  openCreatorSpace();
}

settingsButton.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
/* 点击面板外的半透明背景关闭；面板上的事件全部拦截，不穿透到游戏区 */
settingsOverlay.addEventListener('pointerdown', (event) => {
  if (event.target === settingsOverlay) closeSettings();
});
for (const eventName of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
  settingsOverlay.addEventListener(eventName, (event) => event.stopPropagation());
}
settingsPanel.addEventListener('click', (event) => event.stopPropagation());
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSettings();
});

authorHomeButton.addEventListener('click', handleAuthorHomeClick);
videoCard.addEventListener('click', openFeaturedVideo);

async function handleSfxOptionClick(option) {
  const sfxId = option.dataset.sfx;
  if (!LOCKED_SFX_IDS.has(sfxId)) {
    activateSfxOption(option);
    return;
  }

  markSfxNewSeen(sfxId);
  if (toyCloudState.sfxUnlocked) {
    activateSfxOption(option);
    return;
  }

  const state = await requireToyCloudContext();
  if (!state) return;
  if (!state.sfxUnlocked) {
    showToyNotice(
      '该音效尚未解锁，请点击上方开发视频，观看一次即可解锁。'
    );
    return;
  }

  activateSfxOption(option);
}

/* 三套音效都保留 da / gou / jiao 的语义位置，只替换实际播放采样。 */
for (const option of sfxOptions) {
  option.addEventListener('click', () => {
    void handleSfxOptionClick(option);
  });
}

for (const link of [authorLink, djAuthorLink]) {
  for (const eventName of ['pointerdown', 'pointermove', 'pointerup']) {
    link.addEventListener(eventName, (event) => event.stopPropagation());
  }
  link.addEventListener('click', (event) => event.stopPropagation());
}
authorLink.addEventListener('click', (event) => {
  event.preventDefault();
  openCreatorSpace();
});

document.addEventListener(
  'pointerdown',
  (event) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('#music-toggle, #sfx-toggle, #spatial-audio-toggle')
    ) {
      return;
    }
    restoreAfterNavigation();
  },
  { capture: true }
);

/* ---------- 和弦走向：C - G - Am - F（简单洗脑） ---------- */
const CHORDS = [
  { bass: 65.41, notes: [261.63, 329.63, 392.00, 523.25] }, // C
  { bass: 49.00, notes: [196.00, 246.94, 293.66, 392.00] }, // G
  { bass: 55.00, notes: [220.00, 261.63, 329.63, 440.00] }, // Am
  { bass: 43.65, notes: [174.61, 220.00, 261.63, 349.23] }, // F
];
const HAT_VEL = [0.34, 0.16, 0.42, 0.16];

// tools/analyze_pitch.py 实测所得：高能量、高置信度有声帧 MIDI 的加权中位数。
// 每段原音音高不一致，因此每个按键都从各自锚点反推固定目标音的 playbackRate。
const BARK_SOURCE_MIDI = Object.freeze({
  da: 71.1950846771,
  gou: 65.5950930881,
  jiao: 71.1226079346,
  ha: 72.6652936920031,
  ji: 67.55506219280217,
  mi: 65.47641325112846,
  dingdongji_ding: 68.72369809072657,
  dingdongji_dong: 68.20736701647688,
  dingdongji_ji: 69.48535473104747,
});

// ha_new 的 A5 跨度较大；普通模式使用全四档复测后的 minimax 补偿锚点。
// 钢琴模式仍使用上方实测锚点，避免影响 C4–C5 的既有校准。
const BARK_NORMAL_SOURCE_MIDI = Object.freeze({
  ha: 72.732,
});

// 固定 A 小调五声音阶（A–C–D–E–G）。大狗叫与叮咚鸡的第三档是最接近
// 原声的音；哈基米移除旧最低档、将原前三档后移，因此第四档最接近原声。
const BARK_TARGET_MIDI = Object.freeze({
  da: Object.freeze([79, 76, 72, 69]),    // G5, E5, C5, A4
  gou: Object.freeze([72, 69, 67, 64]),   // C5, A4, G4, E4
  jiao: Object.freeze([79, 76, 72, 69]),  // G5, E5, C5, A4
  ha: Object.freeze([81, 79, 76, 72]),    // A5, G5, E5, C5
  ji: Object.freeze([74, 72, 69, 67]),    // D5, C5, A4, G4
  mi: Object.freeze([72, 69, 67, 64]),    // C5, A4, G4, E4
  dingdongji_ding: Object.freeze([74, 72, 69, 67]), // D5, C5, A4, G4
  dingdongji_dong: Object.freeze([74, 72, 69, 67]), // D5, C5, A4, G4
  dingdongji_ji: Object.freeze([74, 72, 69, 67]),   // D5, C5, A4, G4
});

// 20 ms 有声帧门限 RMS，以 da.wav 为响度基准。Web Audio 使用浮点链路，
// 较大的音色补偿会先经过现有 DynamicsCompressor，再输出到设备。
const SFX_SAMPLE_GAIN = Object.freeze({
  da: 1.0000000000,
  gou: 1.012898017161218,
  jiao: 0.953577156471302,
  ha: 1.283378415934229,
  ji: 1.4777851484035351,
  mi: 1.4846115949156913,
  dingdongji_ding: 2.5889190244772604,
  dingdongji_dong: 2.3637451111911507,
  dingdongji_ji: 2.3501763429894065,
});

// 钢琴模式使用 C 大调白键。前七键严格覆盖 C4–B4，第八键以 C5
// 闭合一个完整八度（do–re–mi–fa–sol–la–si–do）。
const PIANO_SCALE = Object.freeze([
  Object.freeze({ midi: 60, note: 'C4', solfege: 'do' }),
  Object.freeze({ midi: 62, note: 'D4', solfege: 're' }),
  Object.freeze({ midi: 64, note: 'E4', solfege: 'mi' }),
  Object.freeze({ midi: 65, note: 'F4', solfege: 'fa' }),
  Object.freeze({ midi: 67, note: 'G4', solfege: 'sol' }),
  Object.freeze({ midi: 69, note: 'A4', solfege: 'la' }),
  Object.freeze({ midi: 71, note: 'B4', solfege: 'si' }),
  Object.freeze({ midi: 72, note: 'C5', solfege: 'do' }),
]);

/* ============================================================
 * 主色调色板（全页面只用这几支颜色）
 * ==========================================================*/
const C = {
  cream: '#fff2dc',   // 背景 · 米白（固定不变）
  amber: '#ffb400',   // 主色 · 黄
  gray:  '#87837e',   // 次要 · 灰
  coral: '#ff5a5f',   // 点缀（少量）
  teal:  '#16c2a3',   // 点缀（少量）
  blue:  '#3e7bfa',   // 点缀（少量）
};
const ACCENTS = [C.coral, C.teal, C.blue];
const TOUCH_TRAIL_COLORS = Object.freeze([C.amber, C.teal, C.blue]);

/* 形状取色：约 62% 主色黄，28% 灰，10% 点缀色 */
function pickColor(rng) {
  const r = rng();
  if (r < 0.62) return C.amber;
  if (r < 0.9) return C.gray;
  return ACCENTS[(rng() * ACCENTS.length) | 0];
}

/* ---------- 12 个全屏特效（均以屏幕正中心为原点，铺满全屏） ---------- */
const EFFECTS = [
  'rings',    // 同心环爆发
  'poly',     // 多边形绽放
  'spiral',   // 螺旋弹珠
  'rays',     // 放射光芒
  'confetti', // 几何纸屑
  'zigzag',   // 折线穿越
  'pop',      // 弹性几何雨
  'cross',    // 巨大十字
  'orbit',    // 环绕轨道
  'wave',     // 波浪丝带
  'stars',    // 星星弹跳
  'grid',     // 旋转线栅
];

/* ============================================================
 * 音频初始化
 * ==========================================================*/
function initAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  master = ctx.createGain();
  master.gain.value = navigationMuted ? 0 : MASTER_GAIN;
  bgmBus = ctx.createGain();
  bgmBus.gain.value = bgmMuted ? 0 : 1;
  sfxBus = ctx.createGain();
  sfxBus.gain.value = sfxMuted ? 0 : 1;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 24;
  comp.ratio.value = 5;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;

  bgmBus.connect(master);
  sfxBus.connect(master);
  master.connect(comp);
  comp.connect(ctx.destination);

  // 1 秒白噪声
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function loadSamples() {
  for (const n of RUNTIME_SAMPLE_NAMES) {
    const encoded = AUDIO_B64[n];
    if (typeof encoded !== 'string' || encoded.length === 0) {
      throw new Error(`Missing embedded audio sample: ${n}`);
    }
    buffers[n] = await ctx.decodeAudioData(b64ToArrayBuffer(encoded));
    sustainLoops[n] = SUSTAIN_REGIONS[n]?.enabled
      ? buildSustainTexture(buffers[n], SUSTAIN_REGIONS[n])
      : null;
  }
}

function monoMix(source) {
  const mono = new Float32Array(source.length);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const data = source.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i];
  }
  const scale = 1 / source.numberOfChannels;
  for (let i = 0; i < mono.length; i++) mono[i] *= scale;
  return mono;
}

function bestWsolaStart(
  input,
  output,
  outputStart,
  overlapFrames,
  regionMin,
  regionMax,
  target,
  searchFrames,
  previousStart
) {
  const candidateStep = 8;
  const compareStep = 4;
  const lo = Math.max(regionMin, target - searchFrames);
  const hi = Math.min(regionMax, target + searchFrames);
  let bestStart = Math.max(regionMin, Math.min(regionMax, target));
  let bestScore = -Infinity;

  for (let start = lo; start <= hi; start += candidateStep) {
    let dot = 0, energyOut = 0, energyIn = 0;
    for (let i = 0; i < overlapFrames; i += compareStep) {
      const a = output[outputStart + i];
      const b = input[start + i];
      dot += a * b;
      energyOut += a * a;
      energyIn += b * b;
    }

    if (energyOut < 1e-9 || energyIn < 1e-9) continue;
    let score = dot / Math.sqrt(energyOut * energyIn);

    // 相关度接近时偏向不同位置，减少连续使用同一组声带周期。
    const distance = Math.abs(start - previousStart);
    if (distance < overlapFrames * 0.18) score -= 0.06;
    score -= Math.abs(Math.log(Math.sqrt(energyIn / energyOut))) * 0.04;

    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  return bestStart;
}

/* WSOLA 风格的延音纹理：
 * 1. 在稳定元音区内以低差异序列选择不同帧；
 * 2. 用波形相关度微调每一帧的相位；
 * 3. 用 raised-cosine 重叠相加，得到数秒长且无短周期的纹理；
 * 4. 记录每次淡化结束的位置，松手时可从那里逐采样接回原音。 */
function buildSustainTexture(source, region) {
  const sr = source.sampleRate;
  const regionMin = Math.max(0, Math.round(region.regionStart * sr));
  const regionEnd = Math.min(source.length, Math.round(region.regionEnd * sr));
  const frameFrames = Math.round(region.frame * sr);
  const overlapFrames = Math.round(region.overlap * sr);
  const hopFrames = frameFrames - overlapFrames;
  const searchFrames = Math.round(region.search * sr);
  const wrapFrames = Math.round(region.wrapBlend * sr);
  const regionMax = regionEnd - frameFrames;

  if (
    regionMin >= regionMax ||
    overlapFrames <= 1 ||
    hopFrames <= 1 ||
    wrapFrames >= frameFrames
  ) {
    throw new Error('Invalid sustain region');
  }

  const requestedFrames = Math.ceil(region.textureDuration * sr);
  const workingLength = requestedFrames + frameFrames + wrapFrames;
  const channels = Array.from(
    { length: source.numberOfChannels },
    () => new Float32Array(workingLength)
  );
  const inputMono = monoMix(source);
  const outputMono = new Float32Array(workingLength);
  const releaseFrames = [];

  // 第一帧从稳定区后段进入，第二帧固定到最晚安全位置，
  // 让原始起音自然走到成熟元音后再交给纹理。
  const entryStart = regionMax;
  const firstStart = Math.max(regionMin, entryStart - overlapFrames);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    channels[ch].set(
      source.getChannelData(ch).subarray(firstStart, firstStart + frameFrames),
      0
    );
  }
  outputMono.set(
    inputMono.subarray(firstStart, firstStart + frameFrames),
    0
  );

  let previousStart = firstStart;
  let lastFilled = frameFrames;
  for (
    let step = 1, outputStart = hopFrames;
    outputStart + frameFrames <= workingLength;
    step++, outputStart += hopFrames
  ) {
    let candidateStart;
    if (step === 1) {
      candidateStart = entryStart;
    } else {
      const golden = (region.seed + step * 0.618033988749895) % 1;
      let target = Math.round(regionMin + golden * (regionMax - regionMin));

      // 若目标仍贴着上一帧，移到稳定区的另一侧再做相关搜索。
      if (Math.abs(target - previousStart) < overlapFrames * 0.2) {
        const span = regionMax - regionMin;
        target = Math.round(
          regionMin + ((target - regionMin + span * 0.47) % span)
        );
      }

      candidateStart = bestWsolaStart(
        inputMono,
        outputMono,
        outputStart,
        overlapFrames,
        regionMin,
        regionMax,
        target,
        searchFrames,
        previousStart
      );
    }

    for (let i = 0; i < overlapFrames; i++) {
      const p = i / (overlapFrames - 1);
      const mix = 0.5 - 0.5 * Math.cos(Math.PI * p);
      outputMono[outputStart + i] =
        outputMono[outputStart + i] * (1 - mix) +
        inputMono[candidateStart + i] * mix;

      for (let ch = 0; ch < source.numberOfChannels; ch++) {
        const output = channels[ch];
        const input = source.getChannelData(ch);
        output[outputStart + i] =
          output[outputStart + i] * (1 - mix) +
          input[candidateStart + i] * mix;
      }
    }

    outputMono.set(
      inputMono.subarray(
        candidateStart + overlapFrames,
        candidateStart + frameFrames
      ),
      outputStart + overlapFrames
    );
    for (let ch = 0; ch < source.numberOfChannels; ch++) {
      channels[ch].set(
        source.getChannelData(ch).subarray(
          candidateStart + overlapFrames,
          candidateStart + frameFrames
        ),
        outputStart + overlapFrames
      );
    }

    releaseFrames.push({
      textureFrame: outputStart + overlapFrames,
      sourceFrame: candidateStart + overlapFrames,
    });
    previousStart = candidateStart;
    lastFilled = outputStart + frameFrames;
  }

  // 环形淡化只在数秒至十余秒纹理的最外层发生；
  // 日常听到的是内部不断变化的 WSOLA 帧，不再是几十毫秒短循环。
  const textureFrames = lastFilled - wrapFrames;
  const loopBuffer = ctx.createBuffer(
    source.numberOfChannels,
    textureFrames,
    sr
  );
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const input = channels[ch];
    const output = loopBuffer.getChannelData(ch);
    output.set(input.subarray(0, textureFrames));
    for (let i = 0; i < wrapFrames; i++) {
      const p = i / (wrapFrames - 1);
      const mix = 0.5 - 0.5 * Math.cos(Math.PI * p);
      const tail = input[textureFrames + i];
      const head = input[i];
      output[i] = tail * (1 - mix) + head * mix;
    }
  }

  const validReleaseFrames = releaseFrames.filter(
    point =>
      point.textureFrame >= wrapFrames &&
      point.textureFrame < textureFrames
  );
  if (wrapFrames < hopFrames) {
    validReleaseFrames.push({
      textureFrame: wrapFrames,
      sourceFrame: firstStart + wrapFrames,
    });
    validReleaseFrames.sort((a, b) => a.textureFrame - b.textureFrame);
  }
  const attackPoint = region.preferFrameEntry
    ? validReleaseFrames.find(point => point.textureFrame >= frameFrames)
    : validReleaseFrames[0];
  if (!attackPoint) throw new Error('Sustain texture has no release points');

  return {
    buffer: loopBuffer,
    attackOffset: attackPoint.textureFrame / sr,
    tailOffset: attackPoint.sourceFrame / sr,
    releasePoints: validReleaseFrames.map(point => ({
      textureOffset: point.textureFrame / sr,
      sourceOffset: point.sourceFrame / sr,
    })),
  };
}

/* ============================================================
 * 鼓组 / 贝斯 / 和弦 合成音色
 * ==========================================================*/
function kick(t) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
  g.gain.setValueAtTime(0.95, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  o.connect(g); g.connect(bgmBus);
  o.start(t); o.stop(t + 0.26);
}

function snare(t, vol = 0.5) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  n.connect(f); f.connect(g); g.connect(bgmBus);
  n.start(t); n.stop(t + 0.18);
  // 军鼓腔体
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(240, t);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(vol * 0.5, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(g2); g2.connect(bgmBus);
  o.start(t); o.stop(t + 0.1);
}

function hat(t, vol, decay) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  n.connect(f); f.connect(g); g.connect(bgmBus);
  n.start(t); n.stop(t + decay + 0.02);
}

function crash(t) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 5000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
  n.connect(f); f.connect(g); g.connect(bgmBus);
  n.start(t); n.stop(t + 1.3);
}

function stab(t, freqs) {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(2600, t);
  f.frequency.exponentialRampToValueAtTime(600, t + 0.28);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  f.connect(g); g.connect(bgmBus);
  for (const fr of freqs) {
    for (const det of [-6, 5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fr;
      o.detune.value = det;
      o.connect(f);
      o.start(t); o.stop(t + 0.3);
    }
  }
}

function bass(t, fr, vol) {
  const o = ctx.createOscillator(); o.type = 'square';
  o.frequency.value = fr * 2;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + S8 * 0.9);
  o.connect(f); f.connect(g); g.connect(bgmBus);
  o.start(t); o.stop(t + S8);
}

/* ============================================================
 * 循环音轨调度器（lookahead 模式）
 * ==========================================================*/
function scheduleStep(s, t) {
  const bar = (s / 16) | 0;   // 第几小节 0..3
  const pos = s % 16;         // 小节内 16 分位置
  const ch = CHORDS[bar];

  if (bar === 0 && pos === 0) crash(t);            // 循环开头镲片
  if (pos % 4 === 0) kick(t);                      // 四踩地板鼓
  if (pos === 4 || pos === 12) snare(t);           // 2、4 拍军鼓
  if (bar === 3 && pos === 14) snare(t, 0.3);      // 末尾加花
  hat(t, HAT_VEL[pos % 4], pos === 14 ? 0.12 : 0.04);
  if (pos % 4 === 2) stab(t, ch.notes);            // 反拍和弦刺
  if (pos % 2 === 0) bass(t, ch.bass, pos % 4 === 0 ? 0.4 : 0.26);
}

function scheduler() {
  const horizon = ctx.currentTime + INPUT_LOOKAHEAD;
  while (nextNoteTime < horizon) {
    scheduleStep(stepCount, nextNoteTime);
    nextNoteTime += S16;
    stepCount = (stepCount + 1) % 64;
  }
  scheduleQueuedInputs(ctx.currentTime + INPUT_QUEUE_LOOKAHEAD);
}

/* ============================================================
 * 点击量化：下一个 8 分节奏点
 * ==========================================================*/
function quantize(unit) {
  const now = ctx.currentTime;
  const k = Math.ceil((now + 0.02 - startTime) / unit);
  let t = startTime + k * unit;
  if (t < now) t += unit;
  return t;
}

function barkPlaybackRate(sample, pitchTier, fixedTargetMidi) {
  const sourceMidi = Number.isFinite(fixedTargetMidi)
    ? BARK_SOURCE_MIDI[sample]
    : (BARK_NORMAL_SOURCE_MIDI[sample] ?? BARK_SOURCE_MIDI[sample]);
  const targetMidi = Number.isFinite(fixedTargetMidi)
    ? fixedTargetMidi
    : BARK_TARGET_MIDI[sample]?.[pitchTier];
  if (!Number.isFinite(sourceMidi) || !Number.isFinite(targetMidi)) {
    throw new Error(`No fixed pitch target for ${sample}, tier ${pitchTier}`);
  }
  return Math.pow(2, (targetMidi - sourceMidi) / 12);
}

function safeStop(source, when = ctx.currentTime) {
  if (!source) return;
  try { source.stop(when); } catch (_) { /* 已经结束或尚未启动均可忽略 */ }
}

function createSpatialOutput(deckId) {
  const input = ctx.createGain();
  const dryGain = ctx.createGain();
  const spatialGain = ctx.createGain();
  let panner = null;
  let pannerKind = 'none';

  input.connect(dryGain);
  dryGain.connect(sfxBus);
  input.connect(spatialGain);

  if (typeof ctx.createPanner === 'function') {
    panner = ctx.createPanner();
    pannerKind = 'hrtf';
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 10;
    panner.rolloffFactor = 0.35;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    spatialGain.connect(panner);
    panner.connect(sfxBus);
  } else if (typeof ctx.createStereoPanner === 'function') {
    panner = ctx.createStereoPanner();
    pannerKind = 'stereo';
    spatialGain.connect(panner);
    panner.connect(sfxBus);
  } else {
    spatialGain.connect(sfxBus);
  }

  const output = {
    deckId,
    input,
    dryGain,
    spatialGain,
    panner,
    pannerKind,
  };
  liveSpatialOutputs.add(output);
  updateSpatialOutput(output, true);
  return output;
}

function disconnectSpatialOutput(output) {
  if (!output) return;
  liveSpatialOutputs.delete(output);
  try { output.input.disconnect(); } catch (_) { /* 节点可能已断开 */ }
  try { output.dryGain.disconnect(); } catch (_) { /* 节点可能已断开 */ }
  try { output.spatialGain.disconnect(); } catch (_) { /* 节点可能已断开 */ }
  if (output.panner) {
    try { output.panner.disconnect(); } catch (_) { /* 节点可能已断开 */ }
  }
}

function cleanupVoice(voice) {
  if (!voice || voice.cleaned) return;
  voice.cleaned = true;
  clearTimeout(voice.cleanupTimer);
  liveVoices.delete(voice);

  const scopeId = voice.deckId ?? 'solo';
  if (activeSustainVoices.get(scopeId) === voice) {
    activeSustainVoices.delete(scopeId);
  }
  unlockMouth(voice, 0);

  for (const node of [
    voice.drySource, voice.dryGain,
    voice.loopSource, voice.loopGain,
    voice.tailSource, voice.tailGain,
  ]) {
    if (!node) continue;
    try { node.disconnect(); } catch (_) { /* 节点可能已断开 */ }
  }
  disconnectSpatialOutput(voice.spatialOutput);
}

function createTailSource(voice, boundary, sourceOffset) {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = voice.sourceBuffer;
  source.playbackRate.setValueAtTime(voice.rate, boundary);
  gain.gain.setValueAtTime(voice.sampleGain, boundary);
  source.connect(gain);
  gain.connect(voice.spatialOutput.input);
  source.start(boundary, sourceOffset);

  voice.tailSource = source;
  voice.tailGain = gain;
  voice.tailEndAt =
    boundary + (voice.sourceBuffer.duration - sourceOffset) / voice.rate;
  source.onended = () => cleanupVoice(voice);
}

function playPressVoice(name, rate, when, deckId = null) {
  const sourceBuffer = buffers[name];
  const sustain = sustainLoops[name];
  const sampleGain = SFX_SAMPLE_GAIN[name] ?? 1;

  // 前两个音节只走原始一次性播放；第三音节可进入延音纹理。
  if (!sustain) {
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const spatialOutput = createSpatialOutput(deckId);
    source.buffer = sourceBuffer;
    source.playbackRate.setValueAtTime(rate, when);
    gain.gain.setValueAtTime(sampleGain, when);
    source.connect(gain);
    gain.connect(spatialOutput.input);
    source.onended = () => {
      try { source.disconnect(); } catch (_) { /* 节点可能已断开 */ }
      try { gain.disconnect(); } catch (_) { /* 节点可能已断开 */ }
      disconnectSpatialOutput(spatialOutput);
    };
    source.start(when);
    return null;
  }

  const handoffAt = when + sustain.tailOffset / rate;
  const spatialOutput = createSpatialOutput(deckId);

  // 完整原音始终先启动；短按只需取消未来的静音事件即可保持原效果。
  const drySource = ctx.createBufferSource();
  const dryGain = ctx.createGain();
  drySource.buffer = sourceBuffer;
  drySource.playbackRate.setValueAtTime(rate, when);
  dryGain.gain.setValueAtTime(sampleGain, when);
  dryGain.gain.setValueAtTime(0, handoffAt);
  drySource.connect(dryGain);
  dryGain.connect(spatialOutput.input);

  // 延音源从原音尾段起点开始，起音源在同一采样时刻静音。
  const loopSource = ctx.createBufferSource();
  const loopGain = ctx.createGain();
  loopSource.buffer = sustain.buffer;
  loopSource.loop = true;
  loopSource.playbackRate.setValueAtTime(rate, handoffAt);
  loopGain.gain.setValueAtTime(sampleGain, handoffAt);
  loopSource.connect(loopGain);
  loopGain.connect(spatialOutput.input);

  const voice = {
    id: ++voiceSerial,
    name,
    deckId,
    rate,
    sampleGain,
    when,
    handoffAt,
    visualEndAt: when + 0.28,
    sourceBuffer,
    sustain,
    drySource,
    dryGain,
    loopSource,
    loopGain,
    spatialOutput,
    tailSource: null,
    tailGain: null,
    tailEndAt: 0,
    rateTimeline: [{ time: handoffAt, rate }],
    held: true,
    claimed: false,
    released: false,
    stopped: false,
    cleaned: false,
    mode: 'pending',
    cleanupTimer: 0,
  };

  liveVoices.add(voice);
  drySource.onended = () => {
    if (voice.mode === 'short') cleanupVoice(voice);
  };

  drySource.start(when);
  loopSource.start(handoffAt, sustain.attackOffset);
  return voice;
}

function texturePositionAt(voice, now) {
  const start = voice.handoffAt;
  if (now <= start) return voice.sustain.attackOffset;

  let position = voice.sustain.attackOffset;
  let cursor = start;
  let rate = voice.rateTimeline[0].rate;
  for (let i = 1; i < voice.rateTimeline.length; i++) {
    const event = voice.rateTimeline[i];
    if (event.time >= now) break;
    position += (event.time - cursor) * rate;
    cursor = event.time;
    rate = event.rate;
  }
  return position + (now - cursor) * rate;
}

function textureRateAt(voice, now) {
  let rate = voice.rateTimeline[0].rate;
  for (let i = 1; i < voice.rateTimeline.length; i++) {
    const event = voice.rateTimeline[i];
    if (event.time > now) break;
    rate = event.rate;
  }
  return rate;
}

function isRetunableSustainVoice(voice) {
  return Boolean(
    voice &&
    (
      voice.name === 'jiao' ||
      voice.name === 'mi' ||
      voice.name === 'dingdongji_ji'
    ) &&
    voice.mode === 'sustain' &&
    voice.held &&
    !voice.released &&
    !voice.stopped &&
    !voice.cleaned
  );
}

function retuneSustainVoice(voice, rate, when = ctx.currentTime) {
  if (!isRetunableSustainVoice(voice)) return false;

  const now = ctx.currentTime;
  const changeAt = Math.max(now, voice.handoffAt, when);
  const playbackRate = voice.loopSource.playbackRate;
  playbackRate.cancelScheduledValues(changeAt);
  playbackRate.setValueAtTime(rate, changeAt);

  // 记录精确的变速时间；队列预调度不会让音高提前改变，收尾也能正确积分纹理位置。
  voice.rateTimeline = voice.rateTimeline.filter(event => event.time < changeAt);
  voice.rateTimeline.push({ time: changeAt, rate });
  voice.rate = rate;
  return true;
}

function nextTextureRelease(voice, now) {
  const sustain = voice.sustain;
  const duration = sustain.buffer.duration;
  const absolutePosition = texturePositionAt(voice, now);
  const rate = textureRateAt(voice, now);
  const minimumPosition =
    absolutePosition + RELEASE_SCHEDULE_LEAD * rate;
  let best = null;

  for (const point of sustain.releasePoints) {
    const turns = Math.max(
      0,
      Math.ceil((minimumPosition - point.textureOffset) / duration - 1e-7)
    );
    const targetPosition = point.textureOffset + turns * duration;
    if (!best || targetPosition < best.targetPosition) {
      best = { ...point, targetPosition };
    }
  }

  if (!best) throw new Error('Sustain texture has no release point');
  return {
    boundary: now + (best.targetPosition - absolutePosition) / rate,
    sourceOffset: best.sourceOffset,
  };
}

function claimSustainVoice(voice) {
  if (!voice || !voice.held || voice.released || voice.claimed) return;

  const scopeId = voice.deckId ?? 'solo';
  const previous = activeSustainVoices.get(scopeId);
  if (previous && previous !== voice) releaseVoice(previous, true);

  voice.claimed = true;
  voice.mode = 'sustain';
  activeSustainVoices.set(scopeId, voice);
  lockMouth(voice);
}

function updateSustainClaims(audioNow) {
  const due = [];
  for (const voice of liveVoices) {
    if (
      voice.held &&
      !voice.released &&
      !voice.claimed &&
      audioNow + SUSTAIN_CLAIM_LEAD >= voice.handoffAt
    ) {
      due.push(voice);
    }
  }

  // 每台 Deck 各自保留一个长音；同一 Deck 的后触发声音接管前一个。
  due.sort((a, b) => a.id - b.id);
  for (const voice of due) claimSustainVoice(voice);
}

function releaseVoice(voice, musical = true) {
  if (!voice || voice.released || voice.stopped || voice.cleaned) return;

  const now = ctx.currentTime;
  voice.held = false;
  voice.released = true;

  const scopeId = voice.deckId ?? 'solo';
  if (activeSustainVoices.get(scopeId) === voice) {
    activeSustainVoices.delete(scopeId);
  }

  if (!musical) {
    forceStopVoice(voice);
    return;
  }

  // 在自然接管点之前松手：让完整原音继续，短按路径与原版一致。
  if (now < voice.handoffAt) {
    voice.mode = 'short';
    voice.dryGain.gain.cancelScheduledValues(now);
    voice.dryGain.gain.setValueAtTime(voice.sampleGain, now);
    safeStop(voice.loopSource, now);

    if (isMouthVoice(voice)) {
      const remainMs = Math.max(0, (voice.visualEndAt - now) * 1000);
      unlockMouth(voice, remainMs);
    }
    return;
  }

  voice.mode = 'tail';
  const releaseRate = textureRateAt(voice, now);
  voice.loopSource.playbackRate.cancelScheduledValues(now);
  voice.loopSource.playbackRate.setValueAtTime(releaseRate, now);
  voice.rateTimeline = voice.rateTimeline.filter(event => event.time <= now);
  voice.rate = releaseRate;
  const release = nextTextureRelease(voice, now);

  // 在最近的 WSOLA 淡化结束点接回与该帧对应的原音尾段。
  voice.loopGain.gain.setValueAtTime(0, release.boundary);
  safeStop(voice.loopSource, release.boundary + 0.01);
  createTailSource(voice, release.boundary, release.sourceOffset);

  const remainMs = Math.max(0, (voice.tailEndAt - now) * 1000);
  if (isMouthVoice(voice)) unlockMouth(voice, remainMs);
  else openMouth(remainMs, voice.deckId);
}

function fadeGain(gainNode, now, stopAt) {
  if (!gainNode) return;
  const param = gainNode.gain;
  const value = Math.max(0, param.value);
  param.cancelScheduledValues(now);
  param.setValueAtTime(value, now);
  param.linearRampToValueAtTime(0, stopAt);
}

function forceStopVoice(voice) {
  if (!voice || voice.stopped || voice.cleaned) return;

  const now = ctx.currentTime;
  const stopAt = now + EMERGENCY_FADE;
  voice.held = false;
  voice.released = true;
  voice.stopped = true;
  voice.mode = 'stopped';

  const scopeId = voice.deckId ?? 'solo';
  if (activeSustainVoices.get(scopeId) === voice) {
    activeSustainVoices.delete(scopeId);
  }
  fadeGain(voice.dryGain, now, stopAt);
  fadeGain(voice.loopGain, now, stopAt);
  fadeGain(voice.tailGain, now, stopAt);
  safeStop(voice.drySource, stopAt);
  safeStop(voice.loopSource, stopAt);
  safeStop(voice.tailSource, stopAt);

  if (isMouthVoice(voice)) unlockMouth(voice, EMERGENCY_FADE * 1000);
  voice.cleanupTimer = setTimeout(
    () => cleanupVoice(voice),
    (EMERGENCY_FADE + 0.05) * 1000
  );
}

/* ============================================================
 * 分区（纯逻辑，无可见格子）
 * ==========================================================*/
function buildGrid() {
  const { width, height } = getStageMetrics();
  const landscape = width >= height;
  if (zones.length > 0 && landscape !== djLandscape && pointers.size > 0) {
    for (const inputId of [...rhythmGame.activeHolds.keys()]) {
      releaseRhythmGameHold(inputId, true);
    }
    stopActivePerformanceInput();
  }
  djLandscape = landscape;
  zones = [];
  keyboardZoneByCode.clear();

  if (performanceSettings.djMode) {
    const activeSlots = getActiveDjSlots();
    cols = landscape ? activeSlots.length * 4 : 4;
    rows = landscape ? 3 : activeSlots.length * 3;
    const rowMap = [
      { n: 'da', s: '大' },
      { n: 'gou', s: '狗' },
      { n: 'jiao', s: '叫' },
    ];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const deckIndex = landscape ? Math.floor(c / 4) : Math.floor(r / 3);
        const localRow = landscape ? r : r % 3;
        const localColumn = landscape ? c % 4 : c;
        const deckSlot = activeSlots[deckIndex];
        const key = DJ_KEY_GROUPS[deckSlot][localRow][localColumn];
        const zone = {
          sample: rowMap[localRow].n,
          syllable: rowMap[localRow].s,
          pitchTier: localColumn,
          targetMidi: undefined,
          note: undefined,
          solfege: undefined,
          deckId: `dj-${deckSlot}`,
          deckSlot,
          deckIndex,
          sfxId: djSettings.deckSfxIds[deckSlot],
          localRow,
          localColumn,
          keyboardCode: key.code,
          keyboardLabel: key.label,
        };
        keyboardZoneByCode.set(key.code, zones.length);
        zones.push(zone);
      }
    }
  } else if (landscape) {
    cols = performanceSettings.pianoMode ? 8 : 4;
    rows = 3;
    // 横屏：纵向依次 da / gou / jiao；钢琴模式横向 do 到高音 do。
    const rowMap = [{ n: 'da', s: '大' }, { n: 'gou', s: '狗' }, { n: 'jiao', s: '叫' }];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pianoKey = performanceSettings.pianoMode ? PIANO_SCALE[c] : null;
        zones.push({
          sample: rowMap[r].n,
          syllable: rowMap[r].s,
          pitchTier: c,
          targetMidi: pianoKey?.midi,
          note: pianoKey?.note,
          solfege: pianoKey?.solfege,
          deckId: null,
          sfxId: selectedSfxId,
        });
      }
    }
  } else {
    cols = 3;
    rows = performanceSettings.pianoMode ? 8 : 4;
    // 竖屏：横向依次 da / gou / jiao；钢琴模式纵向从高音 do 降到 do。
    const colMap = [{ n: 'da', s: '大' }, { n: 'gou', s: '狗' }, { n: 'jiao', s: '叫' }];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pianoIndex = performanceSettings.pianoMode
          ? PIANO_SCALE.length - 1 - r
          : r;
        const pianoKey = performanceSettings.pianoMode
          ? PIANO_SCALE[pianoIndex]
          : null;
        zones.push({
          sample: colMap[c].n,
          syllable: colMap[c].s,
          pitchTier: pianoIndex,
          targetMidi: pianoKey?.midi,
          note: pianoKey?.note,
          solfege: pianoKey?.solfege,
          deckId: null,
          sfxId: selectedSfxId,
        });
      }
    }
  }

  if (typeof renderDjStage === 'function') renderDjStage();
  if (typeof renderKeyGrid === 'function') renderKeyGrid();
}

function zoneIndex(x, y) {
  const { width, height, left, top } = getStageMetrics();
  const localX = x - left;
  const localY = y - top;
  const c = Math.min(cols - 1, Math.max(0, Math.floor(localX / width * cols)));
  const r = Math.min(rows - 1, Math.max(0, Math.floor(localY / height * rows)));
  return r * cols + c;
}

/* 返回一条指针线段实际穿过的全部格子，避免快速移动时浏览器只上报首尾格。 */
function zonesAlongSegment(x0, y0, x1, y1) {
  const { width, height, left, top } = getStageMetrics();
  const dx = x1 - x0;
  const dy = y1 - y0;
  const times = [0, 1];

  if (Math.abs(dx) > 1e-7) {
    for (let c = 1; c < cols; c++) {
      const t = (left + width * c / cols - x0) / dx;
      if (t > 0 && t < 1) times.push(t);
    }
  }
  if (Math.abs(dy) > 1e-7) {
    for (let r = 1; r < rows; r++) {
      const t = (top + height * r / rows - y0) / dy;
      if (t > 0 && t < 1) times.push(t);
    }
  }

  times.sort((a, b) => a - b);
  const uniqueTimes = times.filter(
    (t, i) => i === 0 || Math.abs(t - times[i - 1]) > 1e-7
  );
  const result = [];
  const appendAt = (t) => {
    const zi = zoneIndex(x0 + dx * t, y0 + dy * t);
    if (result[result.length - 1] !== zi) result.push(zi);
  };

  appendAt(0);
  for (let i = 1; i < uniqueTimes.length; i++) {
    appendAt((uniqueTimes[i - 1] + uniqueTimes[i]) / 2);
  }
  appendAt(1);
  return result;
}

/* ============================================================
 * 工具：随机数 / 缓动 / 颜色 / 路径
 * ==========================================================*/
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = t => t * t * (3 - 2 * t);
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutBack = t => { const c = 1.70158, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
const easeOutElastic = t =>
  t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;

function tracePoly(g, x, y, r, sides, rot) {
  g.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * 2 * Math.PI) / sides;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
}

function traceStar(g, x, y, r, points, rot) {
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 ? r * 0.46 : r;
    const a = rot + (i * Math.PI) / points;
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
}

/* 画一个小几何体（特效的基本粒子） */
function drawPiece(g, kind, color, x, y, r, rot) {
  if (r <= 0) return;
  g.save();
  g.translate(x, y);
  g.rotate(rot || 0);
  switch (kind) {
    case 'circle':
      g.fillStyle = color;
      g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
      break;
    case 'ring':
      g.strokeStyle = color;
      g.lineWidth = Math.max(2, r * 0.3);
      g.beginPath(); g.arc(0, 0, r, 0, 7); g.stroke();
      break;
    case 'square':
      g.fillStyle = color;
      g.fillRect(-r, -r, r * 2, r * 2);
      break;
    case 'triangle':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.2, 3, -Math.PI / 2); g.fill();
      break;
    case 'diamond':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.15, 4, 0); g.fill();
      break;
    case 'hexagon':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.1, 6, 0); g.fill();
      break;
    case 'star':
      g.fillStyle = color;
      traceStar(g, 0, 0, r * 1.25, 5, -Math.PI / 2); g.fill();
      break;
    case 'cross': {
      g.fillStyle = color;
      const w = r * 0.62;
      g.fillRect(-r, -w / 2, r * 2, w);
      g.fillRect(-w / 2, -r, w, r * 2);
      break;
    }
  }
  g.restore();
}

function drawTouchEmoji(g, emoji, x, y, size, alpha, rotation = 0) {
  if (size <= 0 || alpha <= 0) return;
  g.save();
  g.translate(x, y);
  g.rotate(rotation);
  g.globalAlpha = alpha;
  g.font = `${size.toFixed(1)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(111, 106, 99, .28)';
  g.shadowBlur = Math.min(8, size * 0.18);
  g.fillText(emoji, 0, 0);
  g.restore();
}

function drawTouchTrails(now) {
  touchFx2d.clearRect(0, 0, fxW, fxH);
  const emojiMode =
    performanceSettings.djMode && djSettings.trailStyle === 'emoji';

  for (const [pointerId, trail] of touchTrails) {
    trail.points = trail.points.filter(
      point => now - point.at < TOUCH_TRAIL_POINT_LIFE
    );
    const releaseProgress = trail.releasedAt === null
      ? 0
      : clamp01((now - trail.releasedAt) / TOUCH_TRAIL_RELEASE);
    if (releaseProgress >= 1) {
      touchTrails.delete(pointerId);
      continue;
    }

    const releaseAlpha = 1 - smooth(releaseProgress);
    const pointCount = trail.points.length;
    trail.points.forEach((point, index) => {
      const age = clamp01((now - point.at) / TOUCH_TRAIL_POINT_LIFE);
      const order = pointCount > 0 ? (index + 1) / pointCount : 1;
      const alpha = (1 - smooth(age)) * (0.18 + order * 0.58) * releaseAlpha;
      if (emojiMode) {
        const distanceFromHead = pointCount - 1 - index;
        if (distanceFromHead > 0 && distanceFromHead % 2 === 1) return;
        drawTouchEmoji(
          touchFx2d,
          point.emoji,
          point.x,
          Math.max(14, point.y - 18),
          (12 + order * 10) * (1 - age * 0.3),
          alpha,
          Math.sin(now * 3 + index) * 0.08
        );
        return;
      }

      const size = (2.5 + order * 4.5) * (1 - age * 0.38);
      touchFx2d.globalAlpha = alpha;
      drawPiece(
        touchFx2d,
        TOUCH_TRAIL_SHAPES[index % TOUCH_TRAIL_SHAPES.length],
        point.color,
        point.x,
        point.y,
        size,
        now * 2.2 + index * 0.7
      );
    });

    const intro = easeOutBack(clamp01((now - trail.startedAt) / 0.12));
    const pulse = 1 - clamp01((now - trail.pulseAt) / 0.18);
    if (emojiMode) {
      const releasePop = Math.sin(
        Math.min(1, releaseProgress / 0.5) * Math.PI / 2
      );
      const exitProgress = releaseProgress * releaseProgress;
      const exitDistance = TOUCH_TRAIL_EXIT_DISTANCE * exitProgress;
      const emojiX = trail.x + trail.exitX * exitDistance;
      const emojiY = Math.max(24, trail.y - 30) + trail.exitY * exitDistance;
      touchFx2d.save();
      touchFx2d.globalAlpha = 0.58 * releaseAlpha;
      touchFx2d.fillStyle = trail.color;
      touchFx2d.beginPath();
      touchFx2d.arc(trail.x, trail.y, 4 + pulse * 2.5, 0, Math.PI * 2);
      touchFx2d.fill();
      touchFx2d.restore();
      drawTouchEmoji(
        touchFx2d,
        trail.emoji,
        emojiX,
        emojiY,
        (34 + pulse * 8 + releasePop * 7) * intro,
        releaseAlpha,
        Math.sin(now * 5 + trail.x * 0.01) * 0.07
          + trail.exitX * releaseProgress * 0.22
      );
      continue;
    }

    const radius = (24 + pulse * 9 + releaseProgress * 18) * intro;
    touchFx2d.save();
    touchFx2d.globalAlpha = releaseAlpha;
    touchFx2d.strokeStyle = trail.color;
    touchFx2d.lineWidth = 3 + pulse * 1.8;
    touchFx2d.shadowColor = trail.color;
    touchFx2d.shadowBlur = 10 + pulse * 7;
    touchFx2d.beginPath();
    touchFx2d.arc(trail.x, trail.y, radius, 0, Math.PI * 2);
    touchFx2d.stroke();

    touchFx2d.globalAlpha = 0.28 * releaseAlpha;
    touchFx2d.lineWidth = 2;
    touchFx2d.beginPath();
    touchFx2d.arc(trail.x, trail.y, radius + 7 + pulse * 4, 0, Math.PI * 2);
    touchFx2d.stroke();

    touchFx2d.globalAlpha = 0.92 * releaseAlpha;
    drawPiece(
      touchFx2d,
      'diamond',
      trail.color,
      trail.x,
      trail.y,
      5.5 * intro * (1 + pulse * 0.32),
      Math.PI / 4 + now * 0.8
    );
    touchFx2d.restore();
  }

  touchFx2d.globalAlpha = 1;
}

/* ============================================================
 * 全屏特效引擎（仿 Mikutap）
 *  - 每次触发生成一个全屏特效实例，叠在旧特效之上
 *  - 旧特效播放退场动画后移除
 *  - 页面背景平滑过渡到新特效的落幕背景色
 * ==========================================================*/
const FX_IN = 0.55;    // 入场时长（秒）
const FX_OUT = 0.4;    // 退场时长（秒）
const TOUCH_TRAIL_MAX_POINTS = 10;
const TOUCH_TRAIL_POINT_GAP = 8;
const TOUCH_TRAIL_POINT_LIFE = 0.32;
const TOUCH_TRAIL_RELEASE = 0.2;
const TOUCH_TRAIL_EXIT_MOMENTUM_WINDOW = 0.12;
const TOUCH_TRAIL_EXIT_DISTANCE = 120;
const TOUCH_TRAIL_SHAPES = Object.freeze(['circle', 'diamond', 'square']);

let fxW = 0, fxH = 0;  // 画布尺寸（CSS 像素）
let fxList = [];       // 活跃特效（数组顺序 = 叠放顺序）
let beatP = 0;         // 节拍脉冲 0..1（tick 每帧更新）

function nowSec() { return ctx ? ctx.currentTime : performance.now() / 1000; }
const prog = (t, delay, dur = FX_IN) => clamp01((t - delay) / dur);
const cx0 = () => fxW / 2, cy0 = () => fxH / 2;   // 网页容器正中心

function getStageMetrics() {
  const rect = stage.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width || stage.clientWidth || 1),
    height: Math.max(1, rect.height || stage.clientHeight || 1),
    left: rect.left,
    top: rect.top,
  };
}

function touchTrailNow() {
  return performance.now() / 1000;
}

function getTouchTrailPoint(clientX, clientY) {
  const { width, height, left, top } = getStageMetrics();
  return {
    x: Math.max(0, Math.min(width, clientX - left)),
    y: Math.max(0, Math.min(height, clientY - top)),
  };
}

function getTouchTrailAppearance(clientX, clientY) {
  const zone = zones[zoneIndex(clientX, clientY)];
  return {
    color: Number.isInteger(zone?.deckSlot)
      ? TOUCH_TRAIL_COLORS[zone.deckSlot]
      : C.amber,
    emoji: SFX_EMOJIS[zone?.sfxId] ?? SFX_EMOJIS.dagou,
  };
}

function beginTouchTrail(pointerId, clientX, clientY, at = touchTrailNow()) {
  const point = getTouchTrailPoint(clientX, clientY);
  const { color, emoji } = getTouchTrailAppearance(clientX, clientY);
  touchTrails.set(pointerId, {
    x: point.x,
    y: point.y,
    sampleX: point.x,
    sampleY: point.y,
    color,
    emoji,
    startedAt: at,
    updatedAt: at,
    sampleAt: at,
    pulseAt: at,
    releasedAt: null,
    exitX: 0,
    exitY: -1,
    points: [{ ...point, color, emoji, at }],
  });
}

function moveTouchTrail(pointerId, clientX, clientY, at = touchTrailNow()) {
  const trail = touchTrails.get(pointerId);
  if (!trail || trail.releasedAt !== null) return;

  const point = getTouchTrailPoint(clientX, clientY);
  const { color, emoji } = getTouchTrailAppearance(clientX, clientY);
  const dx = point.x - trail.sampleX;
  const dy = point.y - trail.sampleY;
  const distance = Math.hypot(dx, dy);
  const steps = Math.min(
    TOUCH_TRAIL_MAX_POINTS,
    Math.floor(distance / TOUCH_TRAIL_POINT_GAP)
  );

  for (let index = 1; index <= steps; index++) {
    const progress = index / steps;
    trail.points.push({
      x: trail.sampleX + dx * progress,
      y: trail.sampleY + dy * progress,
      color,
      emoji,
      at: trail.sampleAt + (at - trail.sampleAt) * progress,
    });
  }
  if (steps > 0) {
    trail.sampleX = point.x;
    trail.sampleY = point.y;
    trail.sampleAt = at;
  }
  if (trail.points.length > TOUCH_TRAIL_MAX_POINTS) {
    trail.points.splice(0, trail.points.length - TOUCH_TRAIL_MAX_POINTS);
  }

  trail.x = point.x;
  trail.y = point.y;
  trail.color = color;
  trail.emoji = emoji;
  trail.updatedAt = at;
}

function pulseTouchTrail(pointerId, at = touchTrailNow()) {
  const trail = touchTrails.get(pointerId);
  if (trail && trail.releasedAt === null) trail.pulseAt = at;
}

function releaseTouchTrail(pointerId, at = touchTrailNow()) {
  const trail = touchTrails.get(pointerId);
  if (!trail || trail.releasedAt !== null) return;

  const momentumPoint = trail.points.find(
    point => at - point.at <= TOUCH_TRAIL_EXIT_MOMENTUM_WINDOW
  );
  const momentumX = momentumPoint ? trail.x - momentumPoint.x : 0;
  const momentumY = momentumPoint ? trail.y - momentumPoint.y : 0;
  const momentumDistance = Math.hypot(momentumX, momentumY);
  if (momentumDistance >= TOUCH_TRAIL_POINT_GAP) {
    trail.exitX = momentumX / momentumDistance;
    trail.exitY = momentumY / momentumDistance;
  }
  trail.releasedAt = at;
}

function releaseAllTouchTrails(at = touchTrailNow()) {
  for (const pointerId of touchTrails.keys()) releaseTouchTrail(pointerId, at);
}

function fxResize() {
  const previousWidth = fxW;
  const previousHeight = fxH;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const { width, height } = getStageMetrics();
  fxW = width;
  fxH = height;
  const sceneUnit = fxW >= fxH ? fxH / 2 : fxW / 1.5;
  stage.style.setProperty('--scene-unit', `${sceneUnit}px`);
  for (const [canvas, context] of [
    [fxCanvas, fx2d],
    [touchFxCanvas, touchFx2d],
  ]) {
    canvas.width = Math.round(fxW * dpr);
    canvas.height = Math.round(fxH * dpr);
    canvas.style.width = fxW + 'px';
    canvas.style.height = fxH + 'px';
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  if (previousWidth > 0 && previousHeight > 0) {
    const scaleX = fxW / previousWidth;
    const scaleY = fxH / previousHeight;
    for (const trail of touchTrails.values()) {
      trail.x *= scaleX;
      trail.y *= scaleY;
      trail.sampleX *= scaleX;
      trail.sampleY *= scaleY;
      for (const point of trail.points) {
        point.x *= scaleX;
        point.y *= scaleY;
      }
    }
  }
  // 活跃特效重新对齐网页容器正中心
  for (const e of fxList) { e.cx = cx0(); e.cy = cy0(); }
}

/* ---------- 各特效的随机参数预生成（出生即定型，之后纯函数绘制） ----------
 * 中心化特效最大直径 ≈ 0.85~0.92 倍屏幕短边；
 * 零散小元件（纸屑 / 星星 / 几何雨）则随机散布全屏任意位置 */
const BUILD = {
  rings(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 7; i++) inst.shapes.push({
      delay: i * 0.05,
      rEnd: minD * (0.13 + rng() * 0.29),   // 最大直径 ≈ 0.84 短边
      w: 5 + rng() * 9,
      color: pickColor(rng),
    });
    inst.dotR = minD * 0.07;
  },
  poly(inst, rng) {
    const sides = 3 + (rng() * 5 | 0);
    const minD = Math.min(fxW, fxH);
    [[0.46, C.amber, 0], [0.3, C.gray, 0.09], [0.17, C.amber, 0.18]].forEach(([s, color, d], i) =>
      inst.shapes.push({
        sides, delay: d, color,
        rEnd: minD * s,                       // 最大直径 ≈ 0.92 短边
        w: minD * (0.034 - i * 0.007),
      }));
  },
  spiral(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 36; i++) inst.shapes.push({
      ang: i * 0.55,
      rad: 6 + i * minD * 0.0125,             // 最大直径 ≈ 0.88 短边
      size: minD * (0.009 + i * 0.0008),
      delay: i * 0.018,
      color: pickColor(rng),
    });
  },
  rays(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const n = 13 + (rng() * 4 | 0);
    inst.r0 = minD * 0.06;
    for (let i = 0; i < n; i++) inst.shapes.push({
      ang: (i / n) * 2 * Math.PI + rng() * 0.15,
      w: 0.09 + rng() * 0.13,
      len: minD * (0.36 + rng() * 0.1),       // 最大直径 ≈ 0.92 短边
      delay: rng() * 0.12,
      color: rng() < 0.12 ? ACCENTS[(rng() * 3) | 0] : (i % 2 ? C.gray : C.amber),
    });
  },
  confetti(inst, rng) {
    const maxD = Math.hypot(fxW, fxH);
    const minD = Math.min(fxW, fxH);
    const kinds = ['square', 'circle', 'triangle', 'diamond'];
    for (let i = 0; i < 30; i++) inst.shapes.push({
      ang: rng() * 2 * Math.PI,
      dist: maxD * (0.12 + rng() * 0.46),
      size: minD * (0.026 + rng() * 0.05),
      spin: inst.dir * (1 + rng() * 2) * 2.2,
      delay: rng() * 0.18,
      kind: kinds[(rng() * 4) | 0],
      color: pickColor(rng),
    });
  },
  zigzag(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const horiz = rng() < 0.5;
    const n = 5 + (rng() * 3 | 0);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      if (horiz) pts.push({
        x: -fxW * 0.08 + f * fxW * 1.16,
        y: fxH * (i % 2 ? 0.72 + rng() * 0.14 : 0.14 + rng() * 0.14),
      });
      else pts.push({
        x: fxW * (i % 2 ? 0.7 + rng() * 0.16 : 0.14 + rng() * 0.16),
        y: -fxH * 0.08 + f * fxH * 1.16,
      });
    }
    const lens = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      lens.push(l); total += l;
    }
    inst.shapes.push({ pts, lens, total, w: minD * (0.026 + rng() * 0.024), color: C.amber });
  },
  pop(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const kinds = ['circle', 'square', 'ring', 'triangle', 'hexagon'];
    for (let i = 0; i < 16; i++) inst.shapes.push({
      x: fxW * (0.06 + rng() * 0.88),
      y: fxH * (0.06 + rng() * 0.88),
      size: minD * (0.036 + rng() * 0.06),
      delay: rng() * 0.28,
      rot: rng() * Math.PI,
      kind: kinds[(rng() * kinds.length) | 0],
      color: pickColor(rng),
    });
  },
  cross(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const size = minD * (0.6 + rng() * 0.25);   // 臂长 0.6~0.85 短边
    inst.shapes.push({
      size,
      w: size * (0.14 + rng() * 0.08),
      color: rng() < 0.2 ? ACCENTS[(rng() * 3) | 0] : C.amber,
    });
  },
  orbit(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const kinds = ['circle', 'square', 'triangle', 'ring'];
    const n = 10;
    for (let i = 0; i < n; i++) inst.shapes.push({
      ang0: (i / n) * 2 * Math.PI,
      rad: minD * (0.18 + rng() * 0.24),        // 轨道直径 ≤ 0.84 短边
      speed: inst.dir * (0.45 + rng() * 0.5),
      size: minD * (0.026 + rng() * 0.032),
      delay: rng() * 0.15,
      kind: kinds[i % 4],
      color: pickColor(rng),
    });
    inst.coreR = minD * 0.055;
  },
  wave(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 4; i++) inst.shapes.push({
      y0: fxH * (0.14 + i * 0.24) + (rng() - 0.5) * fxH * 0.08,
      amp: minD * (0.03 + rng() * 0.05),
      wl: fxW * (0.45 + rng() * 0.4),
      speed: inst.dir * (1 + rng() * 1.2),
      th: minD * (0.07 + rng() * 0.06),
      side: i % 2 ? 1 : -1,
      delay: i * 0.08,
      color: rng() < 0.12 ? ACCENTS[(rng() * 3) | 0] : (i % 2 ? C.gray : C.amber),
    });
  },
  stars(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 12; i++) inst.shapes.push({
      x: fxW * (0.07 + rng() * 0.86),
      y: fxH * (0.07 + rng() * 0.86),
      r: minD * (0.034 + rng() * 0.055),
      delay: rng() * 0.25,
      rot: rng() * Math.PI,
      color: pickColor(rng),
    });
  },
  grid(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const n = 11;
    const radius = minD * (0.4 + rng() * 0.04);   // 直径 0.8~0.88 短边
    const lines = [];
    for (let i = 0; i < n; i++) lines.push({
      y: (i - (n - 1) / 2) * (radius * 2 / n),
      w: 4.5 + ((i * 7) % 3) * 4,
      delay: i * 0.045,
      color: i % 2 ? C.gray : C.amber,
    });
    inst.shapes.push({ radius, lines });
  },
};

/* ---------- 各特效的绘制（t = 出生至今秒数，fade = 退场透明度） ----------
 * beatP 为节拍脉冲：所有特效随节拍轻微缩放 / 增粗（颜色固定不随节拍变化） */
const DRAW = {
  /* 同心环爆发：圆环扩张后呼吸胀缩，随节拍增粗（律动只做运动，不变色） */
  rings(g, inst, t, fade) {
    const minD = Math.min(fxW, fxH);
    inst.shapes.forEach((s, i) => {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) return;
      const r = k * s.rEnd * (1 + 0.04 * Math.sin(t * 1.4 + i)) + beatP * minD * 0.012;
      g.globalAlpha = (1 - k * 0.5) * fade;
      g.strokeStyle = s.color;
      g.lineWidth = s.w * (1 + beatP * 0.5);
      g.beginPath(); g.arc(inst.cx, inst.cy, r, 0, 7); g.stroke();
    });
    const dk = easeOutBack(prog(t, 0));
    if (dk > 0) {
      g.globalAlpha = fade;
      g.fillStyle = C.amber;
      g.beginPath(); g.arc(inst.cx, inst.cy, inst.dotR * dk * (1 + beatP * 0.2), 0, 7); g.fill();
    }
  },

  /* 多边形绽放：三层多边形描边放大并旋转，随节拍胀缩 */
  poly(g, inst, t, fade) {
    const minD = Math.min(fxW, fxH);
    inst.shapes.forEach((s, i) => {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) return;
      const r = k * s.rEnd * (1 + beatP * 0.035 + 0.03 * Math.sin(t * 1.1 + i * 1.9));
      const rot = inst.rot0 + inst.dir * (1 - k) * 1.3 + t * 0.18 * inst.dir;
      g.globalAlpha = (1 - k * 0.3) * fade;
      g.strokeStyle = s.color;
      g.lineWidth = s.w * (1 + beatP * 0.4) + beatP * minD * 0.0015;
      tracePoly(g, inst.cx, inst.cy, r, s.sides, rot);
      g.stroke();
    });
  },

  /* 螺旋弹珠：圆点沿螺旋线依次弹出，整体旋转，随节拍跳动 */
  spiral(g, inst, t, fade) {
    const rot = inst.rot0 + t * 0.45 * inst.dir + beatP * 0.05 * inst.dir;
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const a = s.ang + rot;
      const r = s.rad * k * (1 + beatP * 0.04) + Math.sin(t * 1.5 + i * 0.5) * 4;
      const x = inst.cx + Math.cos(a) * r;
      const y = inst.cy + Math.sin(a) * r;
      const sz = s.size * k * (1 + beatP * 0.25);
      g.globalAlpha = fade;
      drawPiece(g, i % 6 === 5 ? 'square' : 'circle', s.color, x, y, sz, a);
    });
  },

  /* 放射光芒：楔形光刃旋出，缓慢自转，随节拍伸长 */
  rays(g, inst, t, fade) {
    for (const s of inst.shapes) {
      const k = easeOutCubic(prog(t, s.delay, 0.5));
      if (k <= 0) continue;
      const rot = inst.rot0 + inst.dir * (1 - k) * 0.8 + t * 0.14 * inst.dir;
      const len = s.len * k * (1 + beatP * 0.09);
      const a = s.ang + rot;
      g.globalAlpha = 0.88 * fade;
      g.fillStyle = s.color;
      g.beginPath();
      g.moveTo(inst.cx, inst.cy);
      g.arc(inst.cx, inst.cy, inst.r0 + len, a - s.w, a + s.w);
      g.closePath(); g.fill();
    }
  },

  /* 几何纸屑：小几何体从中心炸开，漂浮 + 随节拍颠簸 */
  confetti(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const x = inst.cx + Math.cos(s.ang) * s.dist * k * (1 + beatP * 0.025);
      const y = inst.cy + Math.sin(s.ang) * s.dist * k * (1 + beatP * 0.025)
        + Math.sin(t * 2.2 + i * 1.3) * 6;
      const sz = s.size * k * (1 + beatP * 0.18);
      const rot = s.spin * k + t * 0.6 * inst.dir;
      g.globalAlpha = fade;
      drawPiece(g, s.kind, s.color, x, y, sz, rot);
    });
  },

  /* 折线穿越：粗折线横扫全屏（带灰色重影），端点圆点随节拍猛跳 */
  zigzag(g, inst, t, fade) {
    const s = inst.shapes[0];
    const k = easeOutCubic(prog(t, 0, 0.6));
    if (k <= 0) return;
    g.save();
    g.translate(0, Math.sin(t * 1.6) * 7);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // 灰色重影
    g.save();
    g.translate(0, s.w * 2.1);
    g.globalAlpha = 0.4 * fade;
    g.strokeStyle = C.gray;
    g.lineWidth = s.w * (1 + beatP * 0.2);
    strokePartial(g, s.pts, s.lens, k * s.total);
    g.stroke();
    g.restore();
    // 主折线
    g.globalAlpha = fade;
    g.strokeStyle = s.color;
    g.lineWidth = s.w * (1 + beatP * 0.3);
    const tip = strokePartial(g, s.pts, s.lens, k * s.total);
    g.stroke();
    g.fillStyle = C.gray;
    g.beginPath(); g.arc(tip.x, tip.y, s.w * (1.1 + beatP * 0.45), 0, 7); g.fill();
    g.restore();
  },

  /* 弹性几何雨：几何体在随机位置 Q 弹冒出，浮动 + 随节拍缩放 */
  pop(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const y = s.y + Math.sin(t * 2 + i * 1.7) * 7;
      const sz = s.size * k * (1 + beatP * 0.2);
      g.globalAlpha = 0.96 * fade;
      drawPiece(g, s.kind, s.color, s.x, y, sz, s.rot + t * 0.4 * inst.dir + beatP * 0.08 * inst.dir);
    });
  },

  /* 巨大十字：横竖两臂依次弹出并旋转定格，随节拍轻微胀缩 */
  cross(g, inst, t, fade) {
    const s = inst.shapes[0];
    const k1 = easeOutBack(prog(t, 0));
    const k2 = easeOutBack(prog(t, 0.13));
    if (k1 <= 0) return;
    g.save();
    g.translate(inst.cx, inst.cy);
    g.rotate(inst.rot0 + inst.dir * (1 - k1) * 1.6 + Math.sin(t * 1.3) * 0.07 + beatP * 0.02 * inst.dir);
    const pulse = 1 + beatP * 0.12;
    g.scale(pulse, pulse);
    const L = s.size / 2, w = s.w / 2;
    g.globalAlpha = fade;
    g.fillStyle = s.color;
    g.fillRect(-L * k1, -w, L * 2 * k1, w * 2);
    if (k2 > 0) g.fillRect(-w, -L * k2, w * 2, L * 2 * k2);
    g.globalAlpha = 0.6 * fade;
    g.strokeStyle = C.gray;
    g.lineWidth = Math.max(2, s.w * 0.28);
    g.beginPath(); g.arc(0, 0, s.size * 0.68 * k1 * (1 + beatP * 0.08), 0, 7); g.stroke();
    g.restore();
  },

  /* 环绕轨道：几何体沿轨道持续环绕中心公转，轨道随节拍收缩膨胀 */
  orbit(g, inst, t, fade) {
    inst.shapes.forEach(s => {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) return;
      const a = s.ang0 + t * s.speed + inst.dir * (1 - k) * 1.8;
      const R = s.rad * k * (1 + beatP * 0.09);
      const x = inst.cx + Math.cos(a) * R;
      const y = inst.cy + Math.sin(a) * R;
      g.globalAlpha = fade;
      drawPiece(g, s.kind, s.color, x, y, s.size * (0.6 + 0.4 * k) * (1 + beatP * 0.15), t * 1.2 * inst.dir);
    });
    const ck = easeOutBack(prog(t, 0));
    if (ck > 0) {
      g.globalAlpha = fade;
      drawPiece(g, 'circle', C.amber, inst.cx, inst.cy,
        inst.coreR * ck * (1 + beatP * 0.2), 0);
    }
  },

  /* 波浪丝带：四条波浪带交替滑入，持续起伏，振幅随节拍加大 */
  wave(g, inst, t, fade) {
    const step = Math.max(14, fxW / 28);
    for (const s of inst.shapes) {
      const k = easeOutCubic(prog(t, s.delay, 0.6));
      if (k <= 0) continue;
      const off = (1 - k) * (fxW + 120) * s.side;
      const amp = s.amp * (0.6 + 0.4 * k) * (1 + beatP * 0.3);
      g.globalAlpha = 0.9 * fade;
      g.fillStyle = s.color;
      g.beginPath();
      for (let x = -60; x <= fxW + 60; x += step) {
        const y = s.y0 + Math.sin((x / s.wl) * Math.PI * 2 + t * s.speed) * amp;
        x === -60 ? g.moveTo(x + off, y) : g.lineTo(x + off, y);
      }
      for (let x = fxW + 60; x >= -60; x -= step) {
        const y = s.y0 + s.th * (1 + beatP * 0.12)
          + Math.sin((x / s.wl) * Math.PI * 2 + t * s.speed + 0.9) * amp;
        g.lineTo(x + off, y);
      }
      g.closePath(); g.fill();
    }
  },

  /* 星星弹跳：星星弹性冒出并闪烁自转，随节拍闪烁加剧 */
  stars(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutElastic(prog(t, s.delay));
      if (k <= 0) return;
      const tw = 1 + 0.15 * Math.sin(t * 3.2 + i * 2.1) + beatP * 0.18;
      g.globalAlpha = 0.97 * fade;
      drawPiece(g, 'star', s.color, s.x, s.y, s.r * k * tw, s.rot + t * 0.7 * inst.dir);
    });
  },

  /* 旋转线栅：圆形视窗内平行线逐条展开，整体旋转，随节拍胀缩增粗 */
  grid(g, inst, t, fade) {
    const s = inst.shapes[0];
    const R = s.radius * (1 + beatP * 0.06 + 0.03 * Math.sin(t * 1.3));
    g.save();
    g.translate(inst.cx, inst.cy);
    g.rotate(inst.rot0 + t * 0.22 * inst.dir + beatP * 0.025 * inst.dir);
    g.beginPath(); g.arc(0, 0, R, 0, 7); g.clip();
    for (const ln of s.lines) {
      const k = easeOutCubic(prog(t, ln.delay));
      if (k <= 0) continue;
      g.globalAlpha = 0.92 * fade;
      g.strokeStyle = ln.color;
      g.lineWidth = ln.w * (1 + beatP * 0.35);
      g.beginPath();
      g.moveTo(-R * k, ln.y);
      g.lineTo(R * k, ln.y);
      g.stroke();
    }
    g.restore();
    const ok = easeOutBack(prog(t, 0));
    if (ok > 0) {
      g.globalAlpha = fade;
      g.strokeStyle = C.amber;
      g.lineWidth = 6 * (1 + beatP * 0.35);
      g.beginPath(); g.arc(inst.cx, inst.cy, R * ok, 0, 7); g.stroke();
    }
  },
};

/* 折线按可见长度部分描边，返回当前端点 */
function strokePartial(g, pts, lens, vis) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = lens[i - 1];
    if (acc + seg <= vis) {
      g.lineTo(pts[i].x, pts[i].y);
      acc += seg;
    } else {
      const f = seg > 0 ? (vis - acc) / seg : 0;
      const tx = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f;
      const ty = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f;
      g.lineTo(tx, ty);
      return { x: tx, y: ty };
    }
  }
  return pts[pts.length - 1];
}

/* 生成一个特效实例；DJ 模式从对应 Deck 中心发散。 */
function buildEffect(type, origin = null) {
  const rng = mulberry32((Math.random() * 1e9) | 0);
  const inst = {
    type,
    cx: origin?.x ?? cx0(), cy: origin?.y ?? cy0(),
    t0: 0, state: 'in', outT0: 0,
    rot0: rng() * Math.PI * 2,
    dir: rng() < 0.5 ? -1 : 1,
    shapes: [],
  };
  BUILD[type](inst, rng);
  return inst;
}

function getDeckEffectOrigin(deckId) {
  const deck = getDjDeck(deckId);
  if (!deck) return null;
  const deckRect = deck.element.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  return {
    x: deckRect.left - stageRect.left + deckRect.width / 2,
    y: deckRect.top - stageRect.top + deckRect.height / 2,
  };
}

/* 同一 Deck 的新特效接替旧特效，多台 Deck 可以同时保留各自画面。 */
function spawnEffect(zi, when, deckId = null) {
  const type = EFFECTS[zi % EFFECTS.length];
  const now = nowSec();
  const effectScope = deckId ?? 'solo';

  for (const e of fxList) {
    if (e.scope === effectScope && e.state !== 'out') {
      e.state = 'out';
      e.outT0 = now;
    }
  }
  while (fxList.length > 12) fxList.shift();   // 多台 Deck 快速连打时兜底清理

  const inst = buildEffect(type, deckId ? getDeckEffectOrigin(deckId) : null);
  inst.scope = effectScope;
  inst.t0 = Math.min(when, now + 0.05);       // 尽量贴节拍，最多延迟 50ms
  fxList.push(inst);
}

/* 每帧绘制：固定米白背景 → 各特效（按叠放顺序） */
function fxFrame(now) {
  fx2d.clearRect(0, 0, fxW, fxH);

  for (let i = fxList.length - 1; i >= 0; i--) {
    const inst = fxList[i];
    let outK = 0;
    if (inst.state === 'out') {
      outK = clamp01((now - inst.outT0) / FX_OUT);
      if (outK >= 1) { fxList.splice(i, 1); continue; }   // 退场完毕，移除
    }
    const t = now - inst.t0;
    if (t < 0) continue;                                  // 等待节拍点

    // 常驻特效整体随节拍呼吸；退场特效整体淡出 + 缩小
    const fade = 1 - smooth(outK);
    const sc = inst.state === 'out' ? 1 - 0.22 * outK : 1 + beatP * 0.02;
    fx2d.save();
    fx2d.translate(inst.cx, inst.cy);
    fx2d.scale(sc, sc);
    fx2d.translate(-inst.cx, -inst.cy);
    DRAW[inst.type](fx2d, inst, t, fade);
    fx2d.restore();
  }
}

/* ---------- 张嘴 / 闭嘴（JS 弹簧驱动，快速果断带 Q 弹） ---------- */
function isMouthVoice(voice) {
  if (!voice) return false;
  const deck = voice.deckId ? getDjDeck(voice.deckId) : null;
  return deck ? deck.mouthVoice === voice : mouthVoice === voice;
}

function openMouth(holdMs, deckId = null) {
  const deck = deckId ? getDjDeck(deckId) : null;
  if (deck) {
    deck.mouthPopped = true;
    deck.inner.classList.toggle('bark-image', !sfxMuted);
    clearTimeout(deck.mouthTimer);
    deck.mouthTimer = setTimeout(() => {
      if (!deck.mouthVoice) {
        deck.mouthPopped = false;
        deck.inner.classList.remove('bark-image');
      }
    }, holdMs);
    return;
  }

  mouthPopped = true;
  dogInner.classList.toggle('bark-image', !sfxMuted);
  clearTimeout(mouthTimer);
  mouthTimer = setTimeout(() => {
    if (!mouthVoice) {
      mouthPopped = false;
      dogInner.classList.remove('bark-image');
    }
  }, holdMs);
}

function lockMouth(voice) {
  const deck = voice.deckId ? getDjDeck(voice.deckId) : null;
  if (deck) {
    deck.mouthVoice = voice;
    clearTimeout(deck.mouthTimer);
    deck.mouthPopped = true;
    deck.inner.classList.toggle('bark-image', !sfxMuted);
    deck.holding = true;
    return;
  }

  mouthVoice = voice;
  clearTimeout(mouthTimer);
  mouthPopped = true;
  dogInner.classList.toggle('bark-image', !sfxMuted);
  holding = true;   // 开始长按果冻动画（变大 / 变红 / 高频抖动）
}

function unlockMouth(voice, holdMs) {
  const deck = voice.deckId ? getDjDeck(voice.deckId) : null;
  if (deck) {
    if (deck.mouthVoice !== voice) return;
    deck.mouthVoice = null;
    deck.holding = false;
    openMouth(holdMs, deck.id);
    return;
  }

  if (mouthVoice !== voice) return;
  mouthVoice = null;
  holding = false;  // 松手：果冻动画 Q 弹回落
  openMouth(holdMs);
}

function kickCharacter(deckId = null) {
  const deck = deckId ? getDjDeck(deckId) : null;
  if (deck) {
    deck.barkPopVel = Math.min(deck.barkPopVel + BARK_KICK, BARK_KICK_MAX);
    return;
  }
  barkPopVel = Math.min(barkPopVel + BARK_KICK, BARK_KICK_MAX);
}

/* ============================================================
 * 激活分区（点击或拖动经过）
 * ==========================================================*/
/* 分区按钮闪光：被激活的分区短暂显示半透明白色再淡出 */
function flashZone(zi) {
  const r = (zi / cols) | 0, c = zi % cols;
  const el = document.createElement('div');
  el.className = 'zone-flash';
  el.style.left   = `calc(${c * 100 / cols}% + 3px)`;
  el.style.top    = `calc(${r * 100 / rows}% + 3px)`;
  el.style.width  = `calc(${100 / cols}% - 6px)`;
  el.style.height = `calc(${100 / rows}% - 6px)`;
  el.addEventListener('animationend', () => el.remove());
  flashLayer.appendChild(el);
}

function reflowQueuedInputTimes() {
  if (!shouldQuantizePerformanceInput()) {
    const now = ctx?.currentTime ?? 0;
    for (const entry of inputQueue) entry.when = now;
    return;
  }

  const quantizedWhen = quantize(S8);
  if (performanceSettings.djMode) {
    const nextTimes = new Map();
    for (const entry of inputQueue) {
      const scopeId = entry.deckId ?? 'solo';
      let when = nextTimes.get(scopeId) ?? quantizedWhen;
      const committed = lastCommittedDjInputTimes.get(scopeId);
      if (Number.isFinite(committed)) when = Math.max(when, committed + S8);
      entry.when = when;
      nextTimes.set(scopeId, when + S8);
    }
    inputQueue.sort((a, b) => a.when - b.when || a.id - b.id);
    return;
  }

  let when = quantizedWhen;
  if (Number.isFinite(lastCommittedInputTime)) {
    when = Math.max(when, lastCommittedInputTime + S8);
  }
  for (const entry of inputQueue) {
    entry.when = when;
    when += S8;
  }
}

function removeQueuedSample(sample, deckId = null) {
  // 自由节奏下每次输入都必须发声，不能用吸附模式的同音节去重规则。
  if (!shouldQuantizePerformanceInput()) return;
  for (let i = inputQueue.length - 1; i >= 0; i--) {
    const entry = inputQueue[i];
    if (entry.sample !== sample || entry.deckId !== deckId) continue;

    inputQueue.splice(i, 1);
    const state = pointers.get(entry.pointerId);
    if (state && state.pendingEntryId === entry.id) {
      state.pendingEntryId = null;
    }
  }
}

function enqueueActivation(zi, pointerId) {
  hideControlsUntilIdle();
  const z = zones[zi];
  const sfxId = performanceSettings.djMode ? z.sfxId : selectedSfxId;
  removeQueuedSample(z.sample, z.deckId);
  const entry = {
    id: ++inputSerial,
    kind: 'press',
    pointerId,
    zone: zi,
    deckId: z.deckId,
    sample: z.sample,
    audioSample: resolveSfxSample(z.sample, sfxId),
    pitchTier: z.pitchTier,
    targetMidi: z.targetMidi,
    when: 0,
  };
  inputQueue.push(entry);
  reflowQueuedInputTimes();
  flashZone(zi);
  return entry;
}

function enqueueSustainRetune(zi, pointerId, voice) {
  hideControlsUntilIdle();
  const z = zones[zi];
  removeQueuedSample(z.sample, z.deckId);
  const entry = {
    id: ++inputSerial,
    kind: 'sustain-retune',
    pointerId,
    zone: zi,
    deckId: z.deckId,
    sample: z.sample,
    audioSample: voice?.name ?? resolveSfxSample(z.sample),
    pitchTier: z.pitchTier,
    targetMidi: z.targetMidi,
    voice,
    when: 0,
  };
  inputQueue.push(entry);
  reflowQueuedInputTimes();
  flashZone(zi);
  return entry;
}

function commitUnsnappedInput(entry) {
  if (shouldQuantizePerformanceInput()) return;
  const queuedIndex = inputQueue.indexOf(entry);
  if (queuedIndex >= 0) inputQueue.splice(queuedIndex, 1);
  entry.when = ctx.currentTime;
  lastCommittedInputTime = entry.when;
  if (entry.deckId) lastCommittedDjInputTimes.set(entry.deckId, entry.when);
  playQueuedInput(entry);
}

function scheduleActivationVisual(zi, when, deckId = null) {
  const waitMs = Math.max(0, (when - ctx.currentTime) * 1000);
  const timer = setTimeout(() => {
    inputVisualTimers.delete(timer);
    openMouth(280, deckId);
    kickCharacter(deckId);
    spawnEffect(zi, ctx.currentTime, deckId);
  }, waitMs);
  inputVisualTimers.add(timer);
}

function playQueuedInput(entry) {
  const audioSample = entry.audioSample ?? resolveSfxSample(entry.sample);
  const rate = barkPlaybackRate(
    audioSample,
    entry.pitchTier,
    entry.targetMidi
  );
  if (entry.kind === 'sustain-retune') {
    if (retuneSustainVoice(entry.voice, rate, entry.when)) {
      scheduleActivationVisual(entry.zone, entry.when, entry.deckId);
    }
    return;
  }

  const state = pointers.get(entry.pointerId);
  const stillHeld =
    state &&
    state.zone === entry.zone &&
    state.pendingEntryId === entry.id;
  const voice = playPressVoice(audioSample, rate, entry.when, entry.deckId);

  if (stillHeld) {
    state.pendingEntryId = null;
    state.voice = voice;
  } else if (voice) {
    // 已滑过或已松手的 jiao 只保留短音，不进入未来的长音循环。
    releaseVoice(voice, true);
  }
  scheduleActivationVisual(entry.zone, entry.when, entry.deckId);
}

function scheduleQueuedInputs(horizon) {
  while (inputQueue.length && inputQueue[0].when < horizon) {
    const entry = inputQueue.shift();
    lastCommittedInputTime = entry.when;
    if (entry.deckId) lastCommittedDjInputTimes.set(entry.deckId, entry.when);
    playQueuedInput(entry);
  }
}

function cancelQueuedInputs(pointerId) {
  for (let i = inputQueue.length - 1; i >= 0; i--) {
    if (inputQueue[i].pointerId === pointerId) inputQueue.splice(i, 1);
  }
  reflowQueuedInputTimes();
}

function clearInputVisualTimers() {
  for (const timer of inputVisualTimers) clearTimeout(timer);
  inputVisualTimers.clear();
}

function updateDjDeckCharacter(deck, now, dt, sway) {
  deck.character.style.transform =
    `translate(${(sway * 3).toFixed(2)}px, ${(-7 * beatP).toFixed(2)}px)` +
    ` rotate(${(sway * 1.8).toFixed(2)}deg)` +
    ` scale(${(1 + 0.05 * beatP).toFixed(4)}, ${(1 - 0.04 * beatP).toFixed(4)})`;

  const popTarget = deck.mouthPopped ? 1 : 0;
  deck.barkPopVel += (popTarget - deck.barkPop) * 320 * dt;
  deck.barkPopVel *= Math.exp(-13 * dt);
  deck.barkPopVel = Math.max(-10, Math.min(10, deck.barkPopVel));
  deck.barkPop += deck.barkPopVel * dt;
  deck.inner.style.transform =
    `scale(${(1 + 0.17 * deck.barkPop).toFixed(4)})` +
    ` rotate(${(-3.5 * deck.barkPop).toFixed(2)}deg)`;

  const holdTarget = deck.holding ? 1 : 0;
  const tau = deck.holding ? 1.1 : 0.22;
  deck.holdLevel +=
    (holdTarget - deck.holdLevel) * (1 - Math.exp(-dt / tau));
  const scaleTarget = 1 + 0.16 * deck.holdLevel;
  deck.jellyVel += (scaleTarget - deck.jellyScale) * 55 * dt;
  deck.jellyVel *= Math.exp(-7 * dt);
  deck.jellyScale += deck.jellyVel * dt;

  const amp = 5 * deck.holdLevel;
  const jx =
    (Math.sin(now * 120 + deck.slot) +
      Math.sin(now * 197 + 1.7 + deck.slot) * 0.6) * amp * 0.55;
  const jy =
    (Math.cos(now * 128 + 0.6 + deck.slot) +
      Math.sin(now * 233 + 3.1 + deck.slot) * 0.6) * amp * 0.55;
  const jr =
    (Math.sin(now * 108 + 2.2 + deck.slot) +
      Math.sin(now * 181 + deck.slot) * 0.5) * 2.2 * deck.holdLevel;
  deck.jelly.style.transform =
    `translate(${jx.toFixed(2)}px, ${jy.toFixed(2)}px)` +
    ` rotate(${jr.toFixed(2)}deg) scale(${deck.jellyScale.toFixed(4)})`;
  deck.jelly.style.filter = deck.holdLevel > 0.004
    ? `hue-rotate(${(-42 * deck.holdLevel).toFixed(1)}deg)` +
      ` saturate(${(1 + 0.7 * deck.holdLevel).toFixed(3)})` +
      ` brightness(${(1 + 0.04 * deck.holdLevel).toFixed(3)})`
    : '';
}

/* ============================================================
 * 节拍动画循环：大狗律动（压缩 + 晃动）+ 长按果冻动画 + 全屏特效
 * ==========================================================*/
function tick() {
  requestAnimationFrame(tick);
  const now = nowSec();
  const dt = Math.min(0.05, Math.max(0.001, now - lastTick));
  lastTick = now;
  const uiBeatPosition = getAudioBeatPosition();
  updateUiRhythm(uiBeatPosition);
  if (started && ctx) updateRhythmGame(ctx.currentTime);
  if (hajimiAnimationEnabled && hajimiAnimationReady) {
    renderHajimiAnimationFrame(uiBeatPosition);
  }

  if (started && ctx) {
    const t = ctx.currentTime;
    updateSustainClaims(t);
    const phase = (((t - startTime) / SPB) % 1 + 1) % 1;  // 当前拍内相位 0..1
    beatP = Math.pow(1 - phase, 2.4);                      // 拍头强、迅速衰减

    // 大狗律动：拍头向上跳 + 上下压缩（压扁拉伸），叠加两拍一周期的左右晃动
    const sway = Math.sin(((t - startTime) / (SPB * 2)) * Math.PI * 2);
    if (performanceSettings.djMode) {
      for (const deck of djDecks) updateDjDeckCharacter(deck, now, dt, sway);
    } else {
      dogEl.style.transform =
        `translate(${(sway * 5).toFixed(2)}px, ${(-9 * beatP).toFixed(2)}px)` +
        ` rotate(${(sway * 2.4).toFixed(2)}deg)` +
        ` scale(${(1 + 0.06 * beatP).toFixed(4)}, ${(1 - 0.05 * beatP).toFixed(4)})`;
    }
  }

  /* ---------- 叫弹跳弹簧 ----------
   * 高刚度(320) + 低阻尼(13)：约 90ms 快速冲起、带过冲后果断定住；
   * 张嘴期间维持弹起，闭嘴快速弹回；每次队列发声时注入冲量，
   * 嘴张着也会重新弹一下。 */
  if (!performanceSettings.djMode) {
    const popTarget = mouthPopped ? 1 : 0;
    barkPopVel += (popTarget - barkPop) * 320 * dt;
    barkPopVel *= Math.exp(-13 * dt);
    barkPopVel = Math.max(-10, Math.min(10, barkPopVel));
    barkPop += barkPopVel * dt;
    dogInner.style.transform =
      `scale(${(1 + 0.17 * barkPop).toFixed(4)}) rotate(${(-3.5 * barkPop).toFixed(2)}deg)`;

  /* ---------- 长按果冻动画 ----------
   * holdLevel 缓慢累积（约 1.1s 时间常数），松手后快速回落；
   * 缩放走欠阻尼弹簧，起步和收尾都带 Q 弹过冲；
   * 抖动为 ~19Hz 高频，幅度随 holdLevel 增大并封顶。 */
    const holdTarget = holding ? 1 : 0;
    const tau = holding ? 1.1 : 0.22;
    holdLevel += (holdTarget - holdLevel) * (1 - Math.exp(-dt / tau));

    const scaleTarget = 1 + 0.16 * holdLevel;                // 逐渐变大（最大 1.16，弹簧过冲略超）
    jellyVel += (scaleTarget - jellyScale) * 55 * dt;
    jellyVel *= Math.exp(-7 * dt);
    jellyScale += jellyVel * dt;

    const amp = 6 * holdLevel;                               // 抖动幅度渐大，封顶 6px
    const jx = (Math.sin(now * 120) + Math.sin(now * 197 + 1.7) * 0.6) * amp * 0.55;
    const jy = (Math.cos(now * 128 + 0.6) + Math.sin(now * 233 + 3.1) * 0.6) * amp * 0.55;
    const jr = (Math.sin(now * 108 + 2.2) + Math.sin(now * 181) * 0.5) * 2.4 * holdLevel;
    dogJelly.style.transform =
      `translate(${jx.toFixed(2)}px, ${jy.toFixed(2)}px)` +
      ` rotate(${jr.toFixed(2)}deg) scale(${jellyScale.toFixed(4)})`;

  // 颜色逐渐变红（黄色图 hue-rotate 负角度 → 红，辅以饱和提升）
    if (holdLevel > 0.004) {
      dogJelly.style.filter =
        `hue-rotate(${(-42 * holdLevel).toFixed(1)}deg)` +
        ` saturate(${(1 + 0.7 * holdLevel).toFixed(3)})` +
        ` brightness(${(1 + 0.04 * holdLevel).toFixed(3)})`;
    } else {
      dogJelly.style.filter = '';
    }
  }

  fxFrame(now);
  drawTouchTrails(touchTrailNow());
}

/* ============================================================
 * 指针交互：跨格补全 + 节奏队列；jiao 长音在原纹理上直接切换音高
 * ==========================================================*/
function retuneHeldJiao(pointerId, state, zi) {
  const z = zones[zi];
  if (!z || z.sample !== 'jiao' || !state.voice) return false;
  if ((state.voice.deckId ?? null) !== (z.deckId ?? null)) return false;
  if (!isRetunableSustainVoice(state.voice)) return false;

  state.zone = zi;
  state.pendingEntryId = null;
  const entry = enqueueSustainRetune(zi, pointerId, state.voice);
  commitUnsnappedInput(entry);
  return true;
}

function enterZone(pointerId, state, zi) {
  if (zi === state.zone) return;
  handleRhythmGameHoldZoneChange(pointerId, zi);
  pulseTouchTrail(pointerId);
  if (retuneHeldJiao(pointerId, state, zi)) return;

  if (state.voice) {
    releaseVoice(state.voice, true);
    state.voice = null;
  }

  state.zone = zi;
  const entry = enqueueActivation(zi, pointerId);
  state.pendingEntryId = entry.id;
  commitUnsnappedInput(entry);
}

function tryActivate(pointerId, x, y, state) {
  if (!state) {
    state = {
      zone: -1,
      voice: null,
      pendingEntryId: null,
      lastX: x,
      lastY: y,
    };
    // 自由节奏会在 enterZone 内立即播放，先注册状态才能正确接管 jiao 长音。
    pointers.set(pointerId, state);
    enterZone(pointerId, state, zoneIndex(x, y));
    return state;
  }

  for (const zi of zonesAlongSegment(state.lastX, state.lastY, x, y)) {
    enterZone(pointerId, state, zi);
  }
  state.lastX = x;
  state.lastY = y;
  return state;
}

stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (rhythmGame.autoplay && isRhythmGameActive()) return;
  beginTouchTrail(e.pointerId, e.clientX, e.clientY);
  if (!started || !buffers.da) {
    pointers.set(e.pointerId, {
      zone: -1,
      voice: null,
      pendingEntryId: null,
      lastX: e.clientX,
      lastY: e.clientY,
    });
    hideControlsUntilIdle();
    return;
  }
  judgeRhythmGameInput(zoneIndex(e.clientX, e.clientY), e.pointerId);
  try { stage.setPointerCapture(e.pointerId); } catch (_) { /* 某些旧浏览器不支持 */ }
  pointers.set(
    e.pointerId,
    tryActivate(e.pointerId, e.clientX, e.clientY, null)
  );
}, { passive: false });

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();
  moveTouchTrail(e.pointerId, e.clientX, e.clientY);
  if (!started || !buffers.da) return;
  pointers.set(
    e.pointerId,
    tryActivate(
      e.pointerId,
      e.clientX,
      e.clientY,
      pointers.get(e.pointerId)
    )
  );
}, { passive: false });

function endInput(pointerId, musical) {
  releaseTouchTrail(pointerId);
  releaseRhythmGameHold(pointerId, !musical);
  const state = pointers.get(pointerId);
  if (state && state.voice) {
    if (musical) releaseVoice(state.voice, true);
    else forceStopVoice(state.voice);
  }
  if (!musical) cancelQueuedInputs(pointerId);
  pointers.delete(pointerId);
  if (pointers.size === 0) hideControlsUntilIdle();
}

function endPointer(e, musical) {
  endInput(e.pointerId, musical);
  try {
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  } catch (_) { /* 指针捕获可能已经自动释放 */ }
}

window.addEventListener('pointerup', (e) => endPointer(e, true));
window.addEventListener('pointercancel', (e) => endPointer(e, false));

function routeRhythmGameKeyboardSlide(zoneIndexValue) {
  const zone = zones[zoneIndexValue];
  const zoneKey = getRhythmGameZoneKey(zone);
  if (!zoneKey) return false;
  for (const [inputId, note] of rhythmGame.activeHolds.entries()) {
    if (!inputId.startsWith('keyboard:') || note.slideTargets.length === 0) {
      continue;
    }
    if (zone.deckSlot !== note.deckSlot) continue;
    const state = pointers.get(inputId);
    if (!state) return false;
    const slideTarget = note.slideTargets[note.nextSlideIndex];
    if (slideTarget?.zoneKey === zoneKey) {
      enterZone(inputId, state, zoneIndexValue);
    } else {
      releaseRhythmGameHold(inputId, true);
    }
    return true;
  }
  return false;
}

function beginKeyboardInput(code) {
  const zi = keyboardZoneByCode.get(code);
  if (!Number.isInteger(zi)) return;
  if (routeRhythmGameKeyboardSlide(zi)) return;
  const pointerId = `keyboard:${code}`;
  if (pointers.has(pointerId)) return;
  judgeRhythmGameInput(zi, pointerId);
  const state = {
    zone: -1,
    voice: null,
    pendingEntryId: null,
    lastX: 0,
    lastY: 0,
  };
  pointers.set(pointerId, state);
  enterZone(pointerId, state, zi);
}

function handleKeyboardDown(event) {
  if (handleSoundFieldKeyboard(event)) return;
  if (
    !performanceSettings.djMode ||
    settingsOpen ||
    (rhythmGame.autoplay && isRhythmGameActive()) ||
    !keyboardZoneByCode.has(event.code)
  ) return;

  event.preventDefault();
  if (event.repeat || pressedKeyboardCodes.has(event.code)) return;
  pressedKeyboardCodes.add(event.code);
  hideControlsUntilIdle();
  void start().then((ready) => {
    if (ready && pressedKeyboardCodes.has(event.code)) {
      beginKeyboardInput(event.code);
    }
  });
}

function handleSoundFieldKeyboard(event) {
  const position = SOUND_FIELD_KEY_POSITIONS[event.code];
  if (
    position === undefined ||
    !performanceSettings.spatialAudio ||
    settingsOpen ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) return false;

  event.preventDefault();
  if (event.repeat) return true;
  if (spatialControlMode !== 'manual') activateManualSoundField();
  setSoundFieldPosition(position, true);
  return true;
}

function handleKeyboardUp(event) {
  const pointerId = `keyboard:${event.code}`;
  if (!pressedKeyboardCodes.has(event.code) && !pointers.has(pointerId)) return;
  event.preventDefault();
  pressedKeyboardCodes.delete(event.code);
  endInput(pointerId, true);
}

function handleWindowBlur() {
  for (const inputId of [...rhythmGame.activeHolds.keys()]) {
    releaseRhythmGameHold(inputId, true);
  }
  stopActivePerformanceInput();
}

window.addEventListener('keydown', handleKeyboardDown);
window.addEventListener('keyup', handleKeyboardUp);
window.addEventListener('blur', handleWindowBlur);

window.addEventListener('contextmenu', (e) => e.preventDefault());

/* ============================================================
 * 启动
 * ==========================================================*/
async function resumeAudioContextForStart() {
  if (ctx.state === 'running') return;
  let timeoutId = 0;
  try {
    await Promise.race([
      Promise.resolve(ctx.resume()),
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error('AudioContext resume timed out'));
        }, AUDIO_CONTEXT_RESUME_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
  if (ctx.state !== 'running') {
    throw new Error(`AudioContext remained ${ctx.state}`);
  }
}

async function start() {
  if (startPromise) return startPromise;
  started = true;
  startPromise = (async () => {
    try {
      hideControlsUntilIdle();
      subEl.textContent = LOADING_MESSAGES[
        Math.floor(Math.random() * LOADING_MESSAGES.length)
      ];

      if (!ctx) initAudio();
      await resumeAudioContextForStart();
      await loadSamples();

      startTime = ctx.currentTime + 0.12;
      nextNoteTime = startTime;
      lastCommittedInputTime = -Infinity;
      lastCommittedDjInputTimes.clear();
      inputQueue.length = 0;
      stepCount = 0;
      setInterval(scheduler, 25);

      overlay.classList.add('hide');
      return true;
    } catch (error) {
      started = false;
      startPromise = null;
      overlay.classList.remove('hide');
      subEl.textContent = '音频未启动 · 再点一次重试';
      console.error('[大狗Tap] 音频启动失败。', error);
      return false;
    }
  })();
  return startPromise;
}

// 触摸设备在 pointerup/click 才获得媒体播放所需的用户激活。
overlay.addEventListener('pointerup', (event) => {
  event.preventDefault();
  void start();
});

let resizeTimer = 0;
function handleLayoutResize() {
  renderLandscapePerformancePreference();
  fxResize();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildGrid, 150);
}
window.addEventListener('resize', handleLayoutResize);
if (window.ResizeObserver) {
  const stageResizeObserver = new ResizeObserver(handleLayoutResize);
  stageResizeObserver.observe(stage);
}

buildGrid();
fxResize();
renderLandscapePerformancePreference();
updateMuteButton(musicToggle, bgmMuted, '音乐');
updateMuteButton(sfxToggle, sfxMuted, '音效');
showControls();
requestAnimationFrame(tick);
