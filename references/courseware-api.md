# 课件运行时 API（`window.__lab`）

tongjiang-lab 全系 54 个课件实测一致。任何新课件先跑一遍
`node scripts/extract_course.mjs --html <课件.html> --out course.json` 验证。

## 顶层对象

```js
window.__lab = {
  C,        // 课程配置：标题、单元、说明等
  STEPS,    // 步骤数组，每一步就是一个教学节拍
  CONSOLE,  // 中控台读数定义
  ctx,      // 课件的运行时上下文（作者自定义）
  camera,   // THREE.PerspectiveCamera
  renderer, // THREE.WebGLRenderer
  controls, // 轨道控制器
  world,    // 场景根节点
  camCfg,   // 相机配置（homeBox / fov 等）
}
```

## 步骤结构 `__lab.STEPS[i]`

```js
{
  index: 0,
  tag: '认识沙盘',            // 小节名
  q: '一条河从山里流到海，一路上留下了什么？',   // 提问
  act: {kind, key, demo},    // 演示动作
  expect: ['流速 3.38 m/s', ...],  // 期望读数
  points: ['…'],             // 讲解要点
  concl: '…',                // 本步结论
  exam: '…',                 // 考核题
  eq: '公式文字',             // 公式/判据
}
```

`act` 的三种形态：

| 形态 | 含义 | 复现方式 |
|---|---|---|
| `{kind:'set', key, value}` | 滑块/参数设值 | `__lab.set(key, value)` |
| `{kind:'toggle', key}` | 开关 | `__lab.toggle(key)` |
| `{kind:'switch', key, demo}` | 分段开关 | `__lab.setSwitch(key, demo)` |
| `{demo: fn}` | **作者写的动画函数** | `act.demo(__lab.ctx)` |

> ⚠️ `act.demo` 是**函数对象**。直接传数字/字符串会得到 undefined；
> 必须传 `__lab.ctx`，作者设计的动画才会完整复现。

## 方法

| 方法 | 说明 |
|---|---|
| `goto(i, {instant})` | 跳到第 i 步。`instant:true` 跳过过渡动画 |
| `set(k, v)` | 改一个连续参数（滑块） |
| `toggle(k)` | 切换一个布尔开关 |
| `setSwitch(k, v)` | 切换分段开关 |
| `live()` | 返回当前状态快照（用于判断画面是否真的变了） |
| `layers()` | 图层信息 |
| `freeRect()` / `bannerRect()` | 自由区/横幅区矩形 |
| `unitScreenRect` | 单元屏幕矩形 |
| `frameHome` | 回到初始视角 |
| `matAt(x, y)` | 按屏幕坐标拾取物体 |

## 相机

```js
__lab.camera.position   // THREE.Vector3
__lab.camera.fov
__lab.controls.target   // 轨道中心
__lab.camCfg.homeBox    // 模型的包围盒 {min:[x,y,z], max:[...]}
```

**换画幅时必须重建相机**，原因见 `pipeline.md` 的「相机在非 16:9 下会飘」。

## 就绪判定

不要用固定 `sleep 12s`。用轮询：

```js
typeof window.__lab === 'object'
```

实测就绪耗时 1.2 ~ 2.4 s。
