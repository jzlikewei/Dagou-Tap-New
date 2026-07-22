# 大狗Tap DJ版

一个基于 Web Audio API 的全屏节奏演奏网页。默认开启三台 Deck，左、中、右依次使用大狗叫、哈基米、叮咚鸡；支持多点触控、键盘演奏、节奏吸附、跟手特效和 HRTF 3D 音场。

## 在线体验

- [飞书妙搭](https://vrfi1sk8a0.feishuapp.com/app/app_17ajzqck2cj/)
- [GitHub Pages](https://jzlikewei.github.io/Dagou-Tap-New/)

首次进入时点一下开始遮罩，用于解锁浏览器音频。iPad Safari 的音频启动发生在抬手阶段；启动超时后可以再次点击。

当前公开测试版已解锁三套音效，打开 DJ 模式即可直接体验。

## 主要玩法

### DJ 模式

- 默认使用 3 Deck，支持切换为 2 Deck。
- 每台 Deck 都有完整的 `4 × 3` 演奏网格。
- 每台 Deck 可以独立选择大狗叫、哈基米或叮咚鸡。
- 多根手指可以同时演奏不同 Deck。
- 第三行支持长按延音，同一 Deck 内拖动可以连续变调。
- 跟手特效支持普通几何样式与 `🐶🐱🐔` 样式。
- Emoji 松手后会轻微放大，在约 200 毫秒内淡出并沿手势方向飞离。

默认三区顺序：

```text
LEFT       CENTER     RIGHT
大狗叫      哈基米      叮咚鸡
```

### 普通模式与钢琴模式

- 普通模式按固定音阶触发当前音效。
- 钢琴模式提供 C4–C5 的八个白键音阶。
- DJ 模式与钢琴模式互斥，开启其中一个会直接切换演奏模式。
- “强化节奏”会把输入吸附到连续八分音符拍点。
- “显示网格”控制演奏分区的细网格显示。

### 3D 音场

- 顶部工具栏和设置菜单都提供 3D 音效开关，两处状态同步。
- 开启后使用 HRTF 放置左右、前后与远近声源，耳机体验更明显。
- 手动模式通过顶部滑杆移动音场。
- 重力模式通过设备倾斜移动音场；它只改变声音位置，不改变屏幕方向。
- PC 可以用 `Z` 左移、`/` 右移、`B` 回到中央。

### 横屏演奏

- iPhone 和 iPad 的设置菜单会显示“横屏演奏”。
- 开启后先请求页面全屏，再请求系统锁定横屏。
- 浏览器拒绝方向锁定时，页面会提示手动旋转，并保留“尝试自动横屏”和关闭入口。
- 关闭时解除方向锁定，只退出页面自行进入的全屏。
- 该选择保存在当前设备。

## DJ 键盘布局

键盘按物理位置读取，输入法状态不会改变按键映射。

| 音节 | LEFT | CENTER | RIGHT |
| --- | --- | --- | --- |
| 第一行 | `1 2 3 4` | `5 6 7 8` | `9 0 - =` |
| 第二行 | `Q W E R` | `T Y U I` | `O P [ ]` |
| 第三行 | `A S D F` | `G H J K` | <code>L ; ' &#92;</code> |

两台 Deck 使用 LEFT 和 RIGHT；三台 Deck 使用全部三组。按住第三行按键可以延音，多键可以同时触发。

## 本地运行

项目是原生 HTML、CSS 和 JavaScript 静态网页，无需安装运行依赖。

```bash
python3 -m http.server 8765
```

然后访问 [http://127.0.0.1:8765/](http://127.0.0.1:8765/)。

## 项目结构

```text
index.html       页面结构与样式
main.js          音频、演奏模式、交互与设备能力
audio-data.js    网页运行时使用的内嵌音频数据
audio/           原始 WAV 音频
Image/           角色、封面与动画素材
tools/           音频分析、数据构建与自动验证
docs/            音高说明与 DJ 开发交接文档
```

哔哩哔哩 Toy 环境会读取和保存解锁状态及演奏设置。独立网页会自动进入本地模式；横屏演奏偏好使用浏览器本机存储。

## 自动验证

```bash
node --check main.js
node tools/verify_runtime_mapping.mjs
node tools/verify_interaction_queue.mjs
node tools/verify_toy_cloud_flow.mjs
node tools/verify_dj_mode.mjs
node tools/verify_spatial_audio.mjs
node tools/verify_mobile_startup.mjs
```

修改音频或音高映射时，先运行分析和数据构建：

```bash
python3 tools/analyze_pitch.py --write-wavs
node tools/build_audio_data.mjs
```

详细说明见 [开发与音高验证工具](tools/README.md)、[音频与和声说明](docs/audio-pitch-harmony.md) 和 [DJ 模式开发交接](docs/dj-mode-handoff.md)。

## 创作信息

- 原作者：[马克杯 MarkCup](https://space.bilibili.com/357762853)
- 原开发视频：[点击即玩世界上最爽的大狗叫模拟器](https://www.bilibili.com/video/BV1kNKU6REBg/)
- DJ 版改编与功能开发：[jzlikewei](https://github.com/jzlikewei)

页面内持续保留原作者入口与 DJ 版改编信息。
