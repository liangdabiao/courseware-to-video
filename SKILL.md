---
name: courseware-to-video
description: 把「3D 交互课件」自动转成竖屏讲解短视频。用户给一个课件 HTML（带 window.__lab 运行时 API 的实验/沙盘类课件），本 skill 会自动抽取课件自带的教案（提问/演示/读数/结论/考点）、无头抓取课件自己的 3D 画面（静帧 + 真实运动片段）、生成中文旁白，最后用 Remotion 合成成 1080x1920 的成片。触发词：课件转视频、课件做成短视频、把课件讲成视频、courseware to video、3D 课件讲解视频。
---

# courseware-to-video — 课件转短视频讲解视频

## 这个 skill 解决什么

用户手里有一个**已经做好的 3D 交互课件**（HTML + three.js，能拖、能调参数、有读数）。
用户想要一条**竖屏短视频**讲清这个课件在讲什么。

最省力也最忠实的做法**不是重新画动画**，而是：

1. **读课件自己的教案**——课件里已经写了每一步的提问、演示动作、读数、结论、考点，
   程序化抽出来就是现成的讲稿骨架。
2. **用课件自己的画面**——无头打开课件，按讲稿一步步操作它，把 3D 画面抓下来。
   静帧当插图，运动片段当演示动画。
3. **只加"讲解层"**——Remotion 在 3D 画面上加字幕、数据卡、公式、因果链、片尾署名。

成片因此天然是"课件自己的画面 + 课件自己的内容"，不存在二次创作的失真。

## 前置条件（必查）

课件必须暴露 `window.__lab` 运行时 API。先跑：

```bash
node scripts/extract_course.mjs <课件.html> --out course.json
```

如果报 `window.__lab 未就绪`，说明这个课件不是本 skill 支持的类型，
**停下来告诉用户**，不要瞎猜着做。

支持的 API 面（tongjiang-lab 全系 54 个课件实测一致，见 `references/courseware-api.md`）：

| 能力 | API |
|---|---|
| 步骤总数 | `__lab.STEPS.length` |
| 步骤内容 | `__lab.STEPS[i]` → `{q, act, expect, points, concl, exam, eq, tag}` |
| 跳步 | `__lab.goto(i, {instant:true})` |
| 改状态 | `__lab.set(k,v)` / `__lab.toggle(k)` / `__lab.setSwitch(k,v)` |
| 读当前状态 | `__lab.live()` |
| 重放作者演示 | `__lab.STEPS[i].act.demo(__lab.ctx)` |
| 相机 | `__lab.camera` / `__lab.controls` / `__lab.camCfg` |

**`act.demo` 必须传 `__lab.ctx`**：它是函数对象，直接传数字会 undefined，
传 `ctx` 后作者设计的动画会完整复现。

## 流水线

### 1. 抽取教案

```bash
node scripts/extract_course.mjs <课件.html> --out course.json
```

产出 `course.json`：课件配置 + 全部步骤（提问/动作/读数/结论/考点）。

### 2. 规划镜头与讲稿

```bash
python scripts/plan_shots.py --course course.json --out script.json \
    --script-md 讲稿.md --profile core
```

产出 `script.json`（项目元信息 + 逐镜数据/讲稿）和 `讲稿.md`（人读版）。
脚本自带 `self_check`：单拍旁白 ≤50 字、数值覆盖度、问题链完整性，
不通过会直接报错。

镜头类型：`title`（开场悬念）/ `ask`（提问）/ `answer`（答案+读数）/
`concl`（结论）/ `chain`（因果链回扣）/ `end`（考点清单）。

### 3. 抓 3D 画面

```bash
node scripts/capture_3d.mjs --script script.json --out media \
    --width 1200 --height 800 --html <课件.html>
```

产出 `media/<shot_id>.png`（静帧）和 `media/<shot_id>.mp4`（运动片段）。

抓帧有三条硬约束，**改代码前先读 `references/pipeline.md`**：

- 必须 GPU（`--use-angle=d3d11`），软件渲染只有 2.6fps。
- 必须先在原生 16:9 下记录每一步的相机，再切画幅重建（课件的 resize
  处理器在非 16:9 下会把相机 target 的 y 算错，画面直接飘走）。
- 隐藏 UI 只能用 `body *{visibility:hidden}` + 单独放开 `#gl`。
  课件有**两个** canvas，放行所有 canvas 会把读数图表漏进画面。

### 4. 合成旁白

```bash
python scripts/gen_tts.py script.json --out audio --voice zh-CN-XiaoyiNeural
```

edge-tts，语速 +22%，双向裁静音，3 次重试，0 字节坏分片自动重做。
人工要改旁白就写 `overrides.json`：

```json
{"narration": {"s05": "改写后的旁白"}}
```

### 5. 回填时间轴

```bash
python scripts/apply_timeline.py script.json --audio audio --media media
```

把音频真实时长 + 0.35s 留白写回每个镜头，同时登记 `image`/`clip`。
画面与旁白因此天然同步。

### 6. 组装并渲染

```bash
python scripts/build_project.py --script script.json --project build/<slug>
cd build/<slug>
npx remotion render src/index.ts CourseVideo out/course.mp4 \
    --codec=h264 --crf=18 --pixel-format=yuv420p --concurrency=1
```

### 7. 体检（**不能省**）

```bash
python scripts/verify_media.py build/<slug>/out/course.mp4 --expect-sec 89.2
```

查三件事：媒体结构（分辨率/帧率/流）、时长是否与时间轴一致、
**音频波形体检**（0.5s 窗 RMS，有声窗占比 >95%，静音段都 <2s）。

> ⚠️ 音轨损坏时 `ffprobe` 的时长依然是对的、媒体校验也可能 PASS，
> 只有把波形拿出来量才抓得住。这一步不能跳。

## 一键跑完

```bash
bash scripts/run_ep.sh <课件.html> <slug>
```

## 交付

成片 mp4 + `讲稿.md` + `script.json`。
**必须保留片尾署名**（课件的许可要求，CC BY-NC 4.0 之类）。

## 常见坑

| 症状 | 原因 | 处理 |
|---|---|---|
| 画面飘到底部 / 被裁 | 非 16:9 画幅下相机 target.y 算错 | 先在原生画幅记录相机再重建 |
| 图表漏进画面右下角 | 放行了所有 canvas | 只放开 `renderer.domElement` |
| 主体撑满 99% | 固定亮度阈值把灰色背景算成内容 | 四边条带中位数估背景 + 色差判 ink |
| 主体溢出画幅 | 自动取景只看宽度 | 宽高两个方向都算，取小的放大倍数 |
| 静帧太小 | 没有自动取景 | 跑 auto-fit 迭代收敛到目标占比 |
| TTS 偶发 0 字节 | edge-tts 网络抖动 | 重试 3 次 + 产物 <1KB 视为失败 |
| 讲完话画面就切走 | 镜头时长没按音频走 | `apply_timeline.py` 回填真实时长 |
| 渲染很慢 / 卡住 | 并发太高 | `--concurrency=1`，一次只跑一个渲染 |
