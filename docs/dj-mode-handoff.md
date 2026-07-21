# DJ 模式开发交接

## 接手完成记录

2026-07-21 已完成交接清单中的实现收尾：

- 三套原有验证脚本已适配 DJ 数据模型并通过。
- 新增 `tools/verify_dj_mode.mjs`，覆盖横竖屏 Deck 网格、36 键映射、键盘生命周期、旋转清理和多 Deck 长音。
- 页面失焦统一释放队列、按键和活动声音；旋转布局时释放旧网格输入；移除 Deck 时清理嘴部计时器。
- 新增独立多指跟手画布：每个触点显示圆环、短粒子尾迹和跨格脉冲，松手后独立淡出。
- DJ 设置可在普通几何尾迹与 `🐶🐔🐱` 尾迹之间切换，emoji 跟随所在 Deck 当前绑定的音色变化。
- `显示网格` 已改为真正控制 DJ 细网格；Deck 分界由舞台结构独立保留。
- GitHub Pages 等顶层网页会立即进入本地设置模式，DJ 开关不再等待 Toy SDK 父页面握手。
- `tools/README.md` 已补充 DJ 验证命令和键盘布局。
- GitHub Pages 测试分支为 `codex/dj-mode-pages`，测试版临时开启 `DEBUG_UNLOCK_SFX`；正式发布前恢复为 `false`。

## 交接时状态

交接时分支为 `main`，工作树包含 DJ 模式的半成品实现，尚未提交。

已有改动：

- `index.html`：新增 DJ 舞台、设置界面、Deck 角色样式、键帽样式。
- `main.js`：新增 DJ 配置、分区网格、多 Deck 队列、独立长音、键盘输入和云端键。
- 音频文件、图片文件、音高分析工具均保持原样。

当前检查结果：

- `node --check main.js` 通过。
- `git diff --check` 通过。
- 功能级测试仍需适配和执行。
- 本地静态服务器已经关闭。
- 浏览器测试连接时没有可用浏览器实例，视觉和真实交互检查仍需完成。

当前工作树改动规模：

```text
index.html | 246 行变动
main.js    | 772 行变动
```

接手后先保留现有工作树，查看完整差异：

```bash
git status --short
git diff -- index.html main.js
```

## 已确认的产品规格

DJ 模式作为独立演奏模式，由设置页开关启用。

- 支持 2 台或 3 台 Deck。
- 每台 Deck 独立选择大狗叫、叮咚鸡、哈基米。
- 每台 Deck 保留完整 `4 × 3` 网格。
- 三行依次对应 `da / gou / jiao` 语义音节。
- 四列对应现有普通模式的四档固定音高。
- 多根手指可以同时操作不同 Deck。
- 每台 Deck 拥有独立角色、张嘴状态、点击弹跳和长按果冻动画。
- 横屏时 Deck 左右并排。
- 竖屏时 Deck 上下堆叠。
- DJ 模式固定使用普通 `4 × 3` 网格。
- 钢琴模式保留在单音色玩法中；DJ 模式开启期间钢琴设置按钮停用，原设置值继续保留，退出 DJ 模式后恢复生效。
- DJ 模式沿用音效解锁规则。额外音效尚未解锁时，开关会提示先完成开发视频解锁。

当前实现允许多台 Deck 绑定同一种音色。产品若要求各 Deck 音色唯一，需要在设置处理里加入交换或拦截规则。

## 键盘布局

键盘使用 `KeyboardEvent.code` 读取物理位置，中文输入法开启时仍能演奏。

| 音节行 | LEFT | CENTER | RIGHT |
| --- | --- | --- | --- |
| `da` | `1 2 3 4` | `5 6 7 8` | `9 0 - =` |
| `gou` | `Q W E R` | `T Y U I` | `O P [ ]` |
| `jiao` | `A S D F` | `G H J K` | `L ; ' \` |

两台 Deck 使用 LEFT 和 RIGHT 两组键，双手之间留出空区。三台 Deck 使用全部三组键。

键盘行为：

- `keydown` 进入对应网格单元。
- `keyup` 释放对应声音。
- 操作系统的按键重复事件不会触发第二次发声。
- 按住第三行按键可以进入延音。
- 多键同时按下时，各 Deck 独立发声。
- 页面失焦时释放全部键盘状态和活动声音，避免长音残留。
- 设置面板打开期间，演奏按键停止响应。
- 桌面端网格单元显示键帽；触屏设备隐藏键帽文字。

## 数据模型

### DJ 配置

`main.js` 中已经加入：

```js
const DEFAULT_DJ_SETTINGS = {
  deckCount: 2,
  deckSfxIds: ['dagou', 'dingdong', 'hajimi'],
  trailStyle: 'normal',
};
```

Deck 使用三个固定槽位：

```text
槽位 0：LEFT
槽位 1：CENTER
槽位 2：RIGHT
```

激活关系：

```text
2 Deck：[0, 2]
3 Deck：[0, 1, 2]
```

默认两台 Deck 因此使用大狗叫和哈基米；切换到三台后，中间 Deck 使用叮咚鸡。

### 网格

DJ 模式仍使用全局规则网格，使现有的快速滑动补格算法可以继续工作。

横屏：

```text
2 Deck：8 列 × 3 行
3 Deck：12 列 × 3 行
```

竖屏：

```text
2 Deck：4 列 × 6 行
3 Deck：4 列 × 9 行
```

每个 `zone` 增加以下字段：

```text
deckId
deckSlot
deckIndex
sfxId
localRow
localColumn
keyboardCode
keyboardLabel
```

触控坐标仍通过全局 `zoneIndex()` 和 `zonesAlongSegment()` 进入单元。进入队列后，`deckId` 会跟随声音直到释放。

### 输入队列

单音色模式沿用原队列规则。

DJ 模式已经改成以下规则：

- 待调度项目按 `(deckId, sample)` 去重。
- 两台 Deck 的同名音节可以同时留在队列中。
- 每台 Deck 单独记录最近一次提交时间。
- 节奏吸附按 Deck 分组计算，相同拍点上的多指输入可以同时发声。
- 队列最终按 `when` 和 `id` 排序，调度器仍从队首消费。

相关状态：

```js
const lastCommittedDjInputTimes = new Map();
```

### 长音

原代码只有一个全局 `activeSustainVoice`。当前改动替换为：

```js
const activeSustainVoices = new Map();
```

键使用 `deckId`，单音色模式使用 `solo`。每台 Deck 可以维持一个独立长音；同一 Deck 后触发的长音接管前一个。不同 Deck 的长音可以并行。

拖动第三音节时，只允许在同一 Deck 内对当前纹理变调。手指跨过 Deck 边界后会释放旧声音并进入新 Deck。

### 角色状态

单音色模式继续使用原有全局角色状态。

每个 DJ Deck 维护独立状态：

```text
mouthVoice
mouthPopped
barkPop / barkPopVel
holding / holdLevel
jellyScale / jellyVel
mouthTimer
```

DJ 模式中的哈基米使用静态开嘴、闭嘴图片。东海帝皇循环动画仍属于单音色哈基米模式。

## 已落到代码里的内容

### `index.html`

- 提高网格和点击闪光层级，使分区边界覆盖在角色上方。
- 新增桌面键帽元素样式。
- 新增 `#dj-stage` 舞台容器。
- 新增横屏并排、竖屏堆叠布局。
- 新增每台 Deck 的角色、标签、开嘴图和长按动画样式。
- 新增 DJ 模式设置开关。
- 新增 2 Deck / 3 Deck 数量选择。
- 新增 LEFT / CENTER / RIGHT 音色选择。
- 更新 `main.js` 查询参数为 `20260721-dj-mode`，规避旧缓存。

### `main.js`

- `DEFAULT_PERFORMANCE_SETTINGS` 增加 `djMode`。
- 增加默认 DJ 配置、槽位关系、音色名称和三组键盘映射。
- 增加 DJ 云端键：

```text
dagou_dj_mode_v1
dagou_dj_deck_count_v1
dagou_dj_deck_left_v1
dagou_dj_deck_center_v1
dagou_dj_deck_right_v1
```

- 增加 DJ 配置读取、渲染、保存和本地降级逻辑。
- 增加 `renderDjStage()`，按槽位创建 Deck 角色。
- 重写 `buildGrid()` 的 DJ 分支。
- 队列去重增加 `deckId` 维度。
- 节奏吸附增加每台 Deck 的独立时间线。
- 长音归属改为 `activeSustainVoices`。
- `playPressVoice()`、视觉调度、张嘴控制和特效触发开始携带 `deckId`。
- 同一 Deck 的新特效接替旧特效，不同 Deck 可以各自保留一个活动特效。
- 新增键盘按下、松开、失焦清理。
- `start()` 改用共享 `startPromise`，首个键盘输入可以等待音频加载完成后继续触发。
- 模式和 Deck 配置变化时会清理队列、按键和活动声音。

## 仍需完成的工作

### 1. 适配现有验证脚本

`tools/verify_interaction_queue.mjs` 当前在旧断言处停止：

```text
enqueueActivation must replace an older queued item of the same sample
```

断言仍匹配 `removeQueuedSample(z.sample)`，生产代码已经改成：

```js
removeQueuedSample(z.sample, z.deckId);
```

验证脚本需要补充：

- `performanceSettings.djMode`。
- `selectedSfxId`。
- `lastCommittedDjInputTimes`。
- 测试用 `zone.deckId` 和 `zone.sfxId`。
- 两台 Deck 同音节同时入队的用例。
- 同一 Deck 同音节替换的用例。
- 两台 Deck 在同一量化拍点发声的用例。
- 跨 Deck 的长音禁止直接变调用例。

`tools/verify_toy_cloud_flow.mjs` 当前报错：

```text
ReferenceError: replaceDjSettings is not defined
```

该脚本通过字符串提取部分生产函数，接手时需要同步加入：

- `replaceDjSettings`
- `readCloudDjSettings`
- `renderDjSettings`
- DJ 配置常量和 DOM 假对象
- 新增云端键
- `djMode` 默认值和恢复值

还要增加以下流程用例：

- 音效锁定时开启 DJ 模式会显示解锁提示。
- 已解锁时可以开启和关闭 DJ 模式。
- Deck 数量写入云端后重建网格。
- 三个 Deck 音色分别写入对应云端键。
- DJ 模式开启时钢琴按钮停用。
- 退出 DJ 模式后钢琴设置恢复。

`tools/verify_runtime_mapping.mjs` 本次运行前缺少：

```text
tools/tmp/pitch-analysis-report.json
```

先重新生成报告：

```bash
python3 tools/analyze_pitch.py --write-wavs
```

报告生成后还要给该脚本的映射沙箱补充：

- `performanceSettings.djMode = false`
- `keyboardZoneByCode = new Map()`
- `selectedSfxId = 'dagou'`

`buildGrid()` 现在会无条件清空键盘映射，因此缺少 `keyboardZoneByCode` 会在映射验证阶段报错。

### 2. 增加 DJ 专用验证

可以新增 `tools/verify_dj_mode.mjs`，直接提取并执行生产函数，覆盖：

- 横屏两台 Deck 为 `8 × 3`。
- 横屏三台 Deck 为 `12 × 3`。
- 竖屏两台 Deck 为 `4 × 6`。
- 竖屏三台 Deck 为 `4 × 9`。
- 两台模式激活 LEFT 和 RIGHT 槽位。
- 三台模式激活全部槽位。
- 36 个物理键映射到正确槽位、音节和音高列。
- `keydown` 与 `keyup` 共用现有声音生命周期。
- 不同 Deck 的长音可以并存。
- 同一 Deck 只保留最新长音。

### 3. 浏览器检查

本轮尝试连接本地浏览器时，可用浏览器列表为空，因此没有完成真实页面检查。

重新检查时启动静态服务器：

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

页面地址：

```text
http://127.0.0.1:8765/
```

本地页面没有 Toy 环境，DJ 模式会遵循锁定规则。调试时可以在开发者工具里临时执行：

```js
toyCloudState.sfxUnlocked = true;
renderToyCloudState();
replacePerformanceSettings({ ...performanceSettings, djMode: true });
```

需要检查的尺寸：

```text
桌面横屏：1440 × 900
移动横屏：844 × 390
移动竖屏：390 × 844
窄屏竖屏：320 × 568
```

视觉检查项：

- 两台和三台 Deck 的边界清晰。
- 角色位于各自 Deck 中心，尺寸没有互相遮挡。
- 竖屏三台 Deck 的角色、标签和十二个触控单元仍可辨认。
- 设置面板在窄屏下可以滚动到底。
- CENTER 配置在两台模式隐藏，在三台模式出现。
- 桌面显示键帽，触屏隐藏键帽。
- 顶部控制、作者链接和设置面板层级正常。
- 点击闪光覆盖对应单元。
- 每根手指拥有独立圆环和短粒子尾迹，跨格时圆环产生脉冲。
- 各 Deck 张嘴和长按动画独立。

交互检查项：

- 两根手指同时按住不同 Deck 的第三行，两个长音都持续。
- 同一 Deck 的第二根手指接管该 Deck 长音。
- 快速滑动会触发途经的全部单元。
- 跨过 Deck 分界线时，旧声音释放，新 Deck 发声。
- 两个 Deck 同时点击时，节奏吸附落在同一拍点。
- 两台模式只响应 LEFT 和 RIGHT 键组。
- 三台模式响应全部键组。
- 按键抬起和页面失焦都能释放长音。

### 4. 运行时审查

重点检查以下位置：

- `renderDjStage()` 重用 Deck DOM 时，计时器和视觉状态是否保持一致。
- 模式切换调用 `stopActivePerformanceInput()` 后，所有声音是否在 Deck DOM 移除前完成释放。
- 屏幕旋转触发 `buildGrid()` 时，活动指针是否需要主动结束。
- DJ 特效目前仍使用全屏画布，发散中心位于对应 Deck；部分几何形状仍会越过 Deck 边界。若产品要求视觉严格分屏，需要给每台 Deck 增加裁剪区域或独立画布。
- DJ 模式的 `showGrid` 控制 `4 × 3` 细网格，Deck 之间的结构分界始终保留。
- 旧云端数据缺少 DJ 键时会落回两台默认配置。

### 5. 文档和版本

功能验证完成后同步更新：

- `tools/README.md`：加入 DJ 专用验证命令和键盘布局。
- 项目说明：加入 DJ 模式入口、触控方式和键盘表。
- `main.js` 缓存版本：正式发布时换成发布版本号。

## 推荐接手顺序

1. 先适配三个现有验证脚本，让原功能重新全绿。
2. 增加 DJ 网格、队列和键盘映射验证。
3. 启动本地页面检查控制台错误。
4. 完成四组桌面和移动尺寸检查。
5. 用两根手指或合成 Pointer Event 验证独立长音。
6. 修复运行时问题后更新开发文档。
7. 最后检查完整差异并提交。

最终命令：

```bash
git diff --check
node --check main.js
python3 tools/analyze_pitch.py --write-wavs
node tools/verify_runtime_mapping.mjs
node tools/verify_interaction_queue.mjs
node tools/verify_toy_cloud_flow.mjs
node tools/verify_dj_mode.mjs
```

`verify_dj_mode.mjs` 需要先创建，再加入最终命令。
