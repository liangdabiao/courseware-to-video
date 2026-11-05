# 流水线详解与踩坑记录

## 全景

```
课件.html ──extract_course──▶ course.json ──plan_shots──▶ script.json + 讲稿.md
                                    │                              │
                                    │                    ┌─────────┴─────────┐
                                    │                    ▼                   ▼
                                    │            capture_3d.mjs           gen_tts.py
                                    │                    │                   │
                                    │                    ▼                   ▼
                                    │                media/*.png|mp4      audio/*.mp3
                                    │                    └─────────┬─────────┘
                                    │                              ▼
                                    │                     apply_timeline.py
                                    │                              │
                                    └──────────────────────────────▼
                                                   build_project.py → Remotion → mp4
```

---

## 抓帧（capture_3d.mjs）

### 1. 必须 GPU

```
--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist
```

软件渲染（swiftshader）实测：2.6 fps @1080p、5.6 fps @540p。
d3d11 硬件加速：60 fps @1080p。运动片段靠它才录得动。

### 2. 相机在非 16:9 画幅下会飘 —— 必须"原生取基准再重建"

课件的 resize 处理器在非 16:9 画幅下把 `controls.target.y` 算错：

| 画幅 | `controls.target.y` |
|---|---|
| 16:9 | 4.4 ✅ |
| 9:16 | 71.6 ❌ 画面飘到底部 |

正确顺序：

1. 在 **1920×1080** 下 `goto(i)`，记录每步的 `{pos, tgt, fov}`；
2. 切到目标画幅；
3. 按基准重建：`target = nat.tgt`，方向不变，距离 × `nativeAspect / currentAspect`。

three.js 相机 fov 是**垂直**的，水平视野 ∝ aspect，画幅变窄就得把相机拉远。

### 3. 隐藏 UI：只放开 `#gl`

课件里有**两个** canvas：

- `#gl` —— three.js 主画面（要）
- `#chart` —— 读数图表（不要）

放行所有 canvas 会让图表漏进画面右下角。正确做法：

```js
st.textContent = 'body *{visibility:hidden !important;}';
main.style.setProperty('visibility', 'visible', 'important'); // main = renderer.domElement
```

### 4. 自动取景：宽高都要算

three.js 透视投影下，主体屏幕尺寸 ∝ 1/距离。量一次 ink bbox 就能反算距离。

但**背景不是白色**（实测灰色 227）。固定亮度阈值会把整个背景算成内容，
于是 auto-fit 全部撑到 99.8%。改成：

1. 用四边条带的中位数估背景色（对渐变背景也稳）；
2. 有内容 = `chroma > 9 || dLum > 11`（色差大**或**明度差大）。

放大倍数取宽高两个方向里较小的那个：

```
s = min(fillWidth / fracW, fillHeight / fracH)
mul = mul / s          // 距离 ∝ 1/主体大小
```

只看宽度的话，又宽又扁的主体（比如一条长河）会溢出画幅上下。

### 5. 运动片段：用管道喂 ffmpeg，不要落中间文件

```
ffmpeg -f image2pipe -framerate N -c:v mjpeg -i - ... out.mp4
```

早先的写法是「写 250 个 jpg → ffmpeg 读目录 → 删目录」，
每次都撞上 safe-delete 钩子的批量删除阈值，整轮被拦。
管道输入没有临时文件，也就没有删除动作。

录制时长要从**开录那一刻**算起（不是从 `goto` 算起），否则动作播完就只剩静止尾巴。

---

## 讲稿（plan_shots.py）

### 讲稿方法论

课件自带的 `points / expect / concl / eq` 就是现成的教学骨架，
但**照书念**会变成读 PPT。转换规则：

- 一个**问题**串起一组条目，不是一条资料对一张卡；
- 开场用悬念提问，每个概念由一个具体问题引出；
- 结尾回扣开头（`chain` 镜头做因果链回扣）。

### 版式函数

| 函数 | 用途 |
|---|---|
| `ask()` | 提问拍 |
| `reveal()` | 验证拍（答案 + 真数字） |
| `conclusion()` | 结论拍（✓真 / ●半真 / ✗没依据 三档判定） |
| `sweep()` | 扫过拍（同组剩余条目一次扫完） |

### 自检（`self_check`）

- 单拍旁白 ≤ 50 字；
- 数值覆盖度：`expect` 里的数字必须在上屏数据卡或要点里出现；
- 问题链完整：每个 `answer` 前面必须有一个 `ask`。

数值解析踩过的坑：

- `3.38 m/s` 被切成 `3.38 m /s` → 数值正则要覆盖 `m/s`；
- `10.0 → 60.0 → 200.0` 中间值丢失 → 用 `GAP` 正则判断"数值链"，
  只允许单位 + 箭头词，不允许夹中文散文；
- `第 5 s 汛期来了 → 11.9 mm` 被误判成数值链 → `GAP` 排除含中文散文的间隔。

---

## 旁白（gen_tts.py）

- edge-tts `zh-CN-XiaoyiNeural`，语速 `+22%`；
- **双向**裁静音：
  `silenceremove → areverse → silenceremove → areverse`（只裁开头会留死寂尾巴）；
- 重试 3 次，产物 < 1KB 视为失败；
- 断点续跑：已有且 > 0.3 s 的 mp3 跳过。

TTS 前清洗：`_` → 空格、`→` → 到、`×` → 乘以、`≤` → 小于等于、`「」` 去掉。

---

## 时间轴（apply_timeline.py）

镜头时长 = **音频真实时长 + 0.35 s 留白**（下限 2.2 s）。
不用估的时长，否则会出现"话没说完画面就切走"。

---

## 合成（Remotion）

- 竖屏 1080×1920 @ 30 fps；
- 3D 舞台 968×645（3:2），抓帧也按 3:2 抓，`objectFit: cover` 严丝合缝；
- 静帧给 Ken Burns（1.00 → 1.05 慢推），运动片段直接播；
- 字幕条用"渐进高亮"（当前句加深、后面淡化），高度恒定不跳版；
- 结尾必须带署名（课件许可要求）。

渲染：

```
npx remotion render src/index.ts CourseVideo out/course.mp4 \
    --codec=h264 --crf=18 --pixel-format=yuv420p --concurrency=1
```

`--concurrency=1`：Windows temp 目录竞争会导致音频混合失败。
**绝对不要同时跑多个 remotion render。**

---

## 交付前自检

1. `ffprobe` 看时长是否与时间轴一致；
2. 抽帧看有没有墨迹越界、有没有 UI 残留；
3. 音频波形体检：提取 wav 算 0.5 s 窗 RMS，
   **有声窗占比 > 95%**，静音段都是句间停顿（< 2 s）。
   ⚠️ `ffprobe` 时长一致 + 媒体校验 PASS **都查不出音轨损坏**，
   这一步不能省。
