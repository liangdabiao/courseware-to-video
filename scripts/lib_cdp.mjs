/**
 * lib_cdp.mjs — 无 puppeteer 的 Chrome DevTools Protocol 客户端
 *
 * 供 extract_course.mjs（提取教案）与 capture_3d.mjs（抓 3D 画面）共用。
 *
 * 实测要点（见 references/courseware-api.md）：
 *  - 必须开 GPU：`--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`
 *    swiftshader 软件渲染只有 2.6fps@1080p，d3d11 有 60fps。
 *  - 就绪判定用轮询 `typeof window.__lab === 'object'`，实测 ~1.2s；
 *    固定 sleep 12s 是纯浪费。
 *  - 去掉 UI：把 body 下非 canvas 元素 visibility:hidden → 干净全幅画面。
 *  - 竖屏 9:16 不能直接 resize（模型会被裁），需按 camCfg.homeBox
 *    二分法求相机距离，让模型完整入画。
 */

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    '找不到 Chrome。已尝试：\n' + CHROME_CANDIDATES.map((p) => '  ' + p).join('\n'),
  );
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 课件的原生画幅（所有课件都按 16:9 调过相机）。
 * 换画幅时用它来换算相机距离。
 */
export const NATIVE_ASPECT = 16 / 9;

/**
 * 启动 Chrome 并返回 {browser, close()}。
 */
export async function launchChrome(opts = {}) {
  const {
    width = 1080,
    height = 1920,
    port = 9222 + Math.floor(Math.random() * 500),
    userDataDir = path.join(os.tmpdir(), `cwv-chrome-${port}`),
    gpu = true,
  } = opts;

  const exe = findChrome();
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${userDataDir}`,
  ];
  if (gpu) {
    args.push('--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist');
  } else {
    args.push('--enable-unsafe-swiftshader', '--use-angle=swiftshader');
  }

  const child = spawn(exe, [...args, 'about:blank'], {stdio: 'ignore'});

  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      version = await res.json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) {
    child.kill();
    throw new Error('Chrome 启动超时（无法连上 CDP 端口 ' + port + '）');
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', reject, {once: true});
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });

  function send(method, params = {}, sessionId) {
    const id = ++nextId;
    const payload = {id, method, params};
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 120000);
    });
  }

  const close = async () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(200);
  };

  return {send, close, listeners, chromePath: exe, port};
}

/**
 * 一个页面（tab）。所有 evaluate 都带 sessionId 路由。
 */
export class Page {
  constructor(browser) {
    this.browser = browser;
    this.sessionId = null;
  }

  async open(url) {
    const {targetId} = await this.browser.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await this.browser.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    this.sessionId = sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    if (url) await this.navigate(url);
    return this;
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  async setViewport(width, height, deviceScaleFactor = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    });
  }

  async navigate(url) {
    await this.send('Page.navigate', {url});
  }

  /**
   * 在页面里执行表达式并取回值。异常会被包装成 Error。
   */
  async evaluate(expression, {awaitPromise = true} = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg =
        (d.exception && (d.exception.description || d.exception.value)) ||
        d.text ||
        JSON.stringify(d).slice(0, 400);
      throw new Error('页面表达式异常: ' + msg);
    }
    return res.result.value;
  }

  /**
   * 轮询直到表达式为真。返回等待毫秒数。
   */
  async waitFor(expression, {timeout = 45000, interval = 200, label = expression} = {}) {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try {
        ok = await this.evaluate(`!!(${expression})`);
      } catch {
        ok = false;
      }
      if (ok) return Date.now() - t0;
      if (Date.now() - t0 > timeout) {
        throw new Error(`等待超时(${timeout}ms): ${label}`);
      }
      await sleep(interval);
    }
  }

  /**
   * 隐藏课件自带的 UI 外壳，只留 3D 主画布。
   *
   * 注意：课件里有**两个** canvas —— `#gl`（three.js 主画布）和 `#chart`（读数图表）。
   * 上一版用 `canvas{visibility:visible!important}` 会把图表也放出来（右下角那个
   * 小曲线图）。这里改成只放行 renderer.domElement（= #gl）。
   */
  async hideUi() {
    return this.evaluate(`(function(){
      var main = (window.__lab && window.__lab.renderer && window.__lab.renderer.domElement)
        || document.getElementById('gl');
      if (!main) return 'no-canvas';
      var st = document.getElementById('cwv-hide-style');
      if (!st) {
        st = document.createElement('style');
        st.id = 'cwv-hide-style';
        document.head.appendChild(st);
      }
      st.textContent = 'body *{visibility:hidden !important;}';
      main.style.setProperty('visibility', 'visible', 'important');
      return 'hidden, main canvas=' + (main.id || main.tagName);
    })()`);
  }

  /** 静帧截图（PNG/JPEG）。 */
  async screenshot({format = 'png', quality = 95, clip = null} = {}) {
    const params = {format};
    if (format === 'jpeg' || format === 'webp') params.quality = quality;
    if (clip) params.clip = {...clip, scale: clip.scale ?? 1};
    const res = await this.send('Page.captureScreenshot', params);
    return Buffer.from(res.data, 'base64');
  }

  /**
   * 测一张截图里"有内容"的像素范围（ink bbox）。
   *
   * 用途：自动把模型调整到画面合适的占比。
   * 原理：three.js 透视投影下，主体屏幕尺寸 ∝ 1/距离，
   * 所以量一次 ink bbox 就能算出距离该乘多少。
   *
   * 背景色**不是白色**（实测是灰色 227），所以不能用固定亮度阈值，
   * 那样会把整个背景都算成内容。改成：
   *   1) 用四边条带的中位数估背景色（对渐变背景也稳）
   *   2) 有内容 = 与背景的色差大（chroma 高）**或** 明度差大
   * 实现在浏览器里做（2D canvas + getImageData），避免 node 端图像解码依赖。
   */
  async measureInk(b64) {
    return this.evaluate(
      `(async function(){
        var img = new Image();
        img.src = 'data:image/png;base64,' + ${JSON.stringify(b64)};
        await img.decode();
        var W = img.naturalWidth, H = img.naturalHeight;
        var c = document.createElement('canvas');
        c.width = W; c.height = H;
        var g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        var d = g.getImageData(0, 0, W, H).data;
        function px(x, y) {
          var i = (y * W + x) * 4;
          return [d[i], d[i+1], d[i+2]];
        }
        // --- 1) 用四边条带估背景色 ---
        var samples = [];
        for (var x = 0; x < W; x += 4) {
          samples.push(px(x, 0)); samples.push(px(x, 1));
          samples.push(px(x, H-1)); samples.push(px(x, H-2));
        }
        for (var y = 0; y < H; y += 4) {
          samples.push(px(0, y)); samples.push(px(1, y));
          samples.push(px(W-1, y)); samples.push(px(W-2, y));
        }
        function median(arr) {
          arr.sort(function(a,b){return a-b;});
          return arr[Math.floor(arr.length/2)];
        }
        var bg = [
          median(samples.map(function(s){return s[0];})),
          median(samples.map(function(s){return s[1];})),
          median(samples.map(function(s){return s[2];})),
        ];
        var bgLum = 0.299*bg[0] + 0.587*bg[1] + 0.114*bg[2];
        // --- 2) 找与背景差异大的像素 ---
        var minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
        for (var y = 0; y < H; y += 2) {
          for (var x = 0; x < W; x += 2) {
            var i = (y * W + x) * 4;
            var r = d[i], gg = d[i+1], b = d[i+2];
            var mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
            var chroma = mx - mn;                       // 与背景的色度差
            var lum = 0.299*r + 0.587*gg + 0.114*b;
            var dLum = Math.abs(lum - bgLum);          // 与背景的明度差
            if (chroma > 9 || dLum > 11) {
              n++;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) return {ok:false, w:W, h:H, bg:bg};
        return {
          ok:true, w:W, h:H, bg:bg, count:n,
          x0:minX, y0:minY, x1:maxX, y1:maxY,
          bw:maxX-minX, bh:maxY-minY,
        };
      })()`,
    );
  }

  /**
   * 开始录屏。返回一个 handle，调用 handle.stop() 拿到 {frames, fps}。
   *
   * 为什么要拆成 start/stop：录制期间必须执行"推动画面的动作"，
   * 所以开始录 → 干活 → 停止录 的顺序不能用一个 await 包起来。
   */
  async startRecord({format = 'jpeg', quality = 85, maxWidth, maxHeight} = {}) {
    const frames = [];
    const self = this;   // stop() 是对象字面量里的方法，this 会丢失
    const handler = (msg) => {
      if (msg.method === 'Page.screencastFrame') {
        frames.push(msg.params.data);
        self.send('Page.screencastFrameAck', {sessionId: msg.params.sessionId}).catch(
          () => {},
        );
      }
    };
    this.browser.listeners.push(handler);
    const params = {format, quality, everyNthFrame: 1};
    if (maxWidth) params.maxWidth = maxWidth;
    if (maxHeight) params.maxHeight = maxHeight;
    await this.send('Page.startScreencast', params);
    const t0 = Date.now();
    return {
      frames,
      async stop() {
        await self.send('Page.stopScreencast');
        await sleep(300);
        const idx = self.browser.listeners.indexOf(handler);
        if (idx >= 0) self.browser.listeners.splice(idx, 1);
        return {frames, fps: frames.length / ((Date.now() - t0) / 1000)};
      },
    };
  }
}

/**
 * 课件控制 API（window.__lab）的封装。
 * 所有方法在课件未加载时都会失败，调用前请先 waitForApp。
 */
export const Lab = {
  /** 等待课件运行时就绪。 */
  async ready(page, timeout = 45000) {
    return page.waitFor(`typeof window.__lab === 'object'`, {
      timeout,
      label: 'window.__lab',
    });
  },

  /** 跳到第 i 步。instant=true 表示不做过渡动画。 */
  async goto(page, i, {instant = true} = {}) {
    return page.evaluate(`window.__lab.goto(${i}, {instant: ${instant ? 'true' : 'false'}})`);
  },

  /** 读回某个 step 的纯数据（函数会被转成字符串）。 */
  async step(page, i) {
    return page.evaluate(
      `(function(){
        var s = window.__lab.STEPS[${i}];
        return JSON.stringify(s, function(k, v){
          if (typeof v === 'function') return '[fn] ' + String(v).slice(0, 400);
          return v;
        });
      })()`,
    );
  },

  /** 全部 step 的纯数据。 */
  async steps(page) {
    return page.evaluate(
      `JSON.stringify(window.__lab.STEPS, function(k, v){
         if (typeof v === 'function') return '[fn] ' + String(v).slice(0, 400);
         return v;
       })`,
    );
  },

  /** 课程配置 C。 */
  async config(page) {
    return page.evaluate(
      `JSON.stringify(window.__lab.C, function(k, v){
         if (typeof v === 'function') return '[fn] ' + String(v).slice(0, 400);
         return v;
       })`,
    );
  },

  /** 中控台读数定义。 */
  async console(page) {
    return page.evaluate(
      `JSON.stringify(window.__lab.CONSOLE || null, function(k, v){
         if (typeof v === 'function') return '[fn]';
         return v;
       })`,
    );
  },

  /** 作者设计的演示动作。custom 类必须传 ctx。 */
  async runDemo(page, i) {
    return page.evaluate(
      `(function(){
        try {
          var a = window.__lab.STEPS[${i}].act;
          if (!a) return 'no-act';
          if (typeof a.demo === 'function') {
            var r = a.demo(window.__lab.ctx);
            return Promise.resolve(r).then(function(){return 'demo-ok';},
              function(e){return 'demo-reject:'+e;});
          }
          if (a.demo !== undefined && a.demo !== null && a.key) {
            window.__lab.set(a.key, a.demo);
            return 'set ' + a.key + '=' + a.demo;
          }
          if (a.kind === 'toggle' && a.key) {
            window.__lab.toggle(a.key);
            return 'toggle ' + a.key;
          }
          if (a.kind === 'switch' && a.key && a.demo !== undefined) {
            window.__lab.setSwitch(a.key, a.demo);
            return 'switch ' + a.key + '=' + a.demo;
          }
          return 'kind=' + a.kind + ' (无可重放动作)';
        } catch (e) { return 'ERR:' + e.message; }
      })()`,
    );
  },

  /** 当前状态指纹（用于判断画面是否真的变了）。 */
  async live(page) {
    return page.evaluate('JSON.stringify(window.__lab.live())');
  },

  /**
   * 竖屏相机拟合：沿当前视线方向二分求解相机距离，
   * 让 camCfg.homeBox 的 8 个角点投影后完全落在画面内。
   *
   * FRAC=0.90 留一点边距；实测 river-step 竖屏拟合后模型完整入画。
   */
  async fitPortrait(page, {frac = 0.9} = {}) {
    return page.evaluate(
      `(function(){
        var L = window.__lab;
        if (!L || !L.camCfg || !L.camCfg.homeBox) return {ok:false, reason:'no camCfg.homeBox'};
        var c = L.camera, t = L.controls.target;
        var V = c.position.constructor;
        var box = L.camCfg.homeBox;
        var pts = [];
        [box.min[0], box.max[0]].forEach(function(x){
          [box.min[1], box.max[1]].forEach(function(y){
            [box.min[2], box.max[2]].forEach(function(z){ pts.push(new V(x, y, z)); });
          });
        });
        var ctr = new V(
          (box.min[0]+box.max[0])/2,
          (box.min[1]+box.max[1])/2,
          (box.min[2]+box.max[2])/2);
        var dir = c.position.clone().sub(t).normalize();
        function spread(dist){
          c.position.copy(ctr.clone().add(dir.clone().multiplyScalar(dist)));
          c.lookAt(ctr);
          c.updateMatrixWorld(true);
          c.matrixWorldInverse.copy(c.matrixWorld).invert();
          var mx = 0, my = 0;
          for (var i = 0; i < pts.length; i++) {
            var v = pts[i].clone().project(c);
            mx = Math.max(mx, Math.abs(v.x));
            my = Math.max(my, Math.abs(v.y));
          }
          return {mx:mx, my:my};
        }
        var lo = 0.5, hi = 600;
        for (var i = 0; i < 48; i++) {
          var mid = (lo + hi) / 2;
          var s = spread(mid);
          if (Math.max(s.mx, s.my) > ${frac}) lo = mid; else hi = mid;
        }
        var s = spread(hi);
        L.controls.target.copy(ctr);
        c.position.copy(ctr.clone().add(dir.clone().multiplyScalar(hi)));
        c.lookAt(ctr);
        c.updateMatrixWorld(true);
        return {ok:true, dist:+hi.toFixed(2), mx:+s.mx.toFixed(3), my:+s.my.toFixed(3)};
      })()`,
    );
  },

  /**
   * 读出课件自带的相机/场景元信息（做审计用）。
   */
  async meta(page) {
    return page.evaluate(
      `JSON.stringify({
        aspect: window.__lab.camera ? window.__lab.camera.aspect : null,
        camCfg: window.__lab.camCfg || null,
        freeRect: (function(){ try { return window.__lab.freeRect(); } catch(e){ return null; } })(),
        layers: (function(){ try { return window.__lab.layers(); } catch(e){ return null; } })(),
        units: (function(){ try { return window.__lab.C ? window.__lab.C.units : null; } catch(e){ return null; } })()
      })`,
    );
  },

  /**
   * 记录课件在**原生画幅**下每一步的相机状态。
   *
   * 为什么必须先在原生画幅下记录：课件的 resize 处理器在非 16:9 画幅下
   * 会把 controls.target 的 y 坐标算错（实测 16:9 下 target.y=4.4，
   * 9:16 下变成 71.6），导致画面飘到画布底部或被裁。
   * 所以策略是：**原生画幅取基准 → 换画幅后按基准重建相机**。
   */
  async recordNativeCameras(page, stepCount) {
    const cams = {};
    for (let i = 0; i < stepCount; i++) {
      await Lab.goto(page, i, {instant: true});
      await sleep(700);
      cams[i] = JSON.parse(
        await page.evaluate(
          `JSON.stringify({
            pos: window.__lab.camera.position.toArray(),
            tgt: window.__lab.controls.target.toArray(),
            fov: window.__lab.camera.fov,
          })`,
        ),
      );
    }
    return cams;
  },

  /**
   * 按原生基准重建相机，适配当前画幅。
   *
   * 原理：three.js 相机 fov 是**垂直**的，水平视野 ∝ aspect。
   * 画幅变窄时若不把相机拉远，水平方向就会裁掉内容。
   * 所以距离按 nativeAspect/currentAspect 线性放大；
   * fitScale 可再乘一个系数做微调（<1 = 拉近，画面更大）。
   */
  async applyNativeCamera(page, native, {fitScale = 1} = {}) {
    return page.evaluate(
      `(function(){
        var L = window.__lab, c = L.camera, t = L.controls.target;
        var nat = ${JSON.stringify(native)};
        if (!nat || !nat.pos) return {ok:false};
        t.set(nat.tgt[0], nat.tgt[1], nat.tgt[2]);
        var V = c.position.constructor;
        var dir = new V(nat.pos[0]-nat.tgt[0], nat.pos[1]-nat.tgt[1], nat.pos[2]-nat.tgt[2]);
        var dist = dir.length();
        var ASP = ${NATIVE_ASPECT} / Math.max(0.001, c.aspect);
        var sc = ASP * ${fitScale};
        c.position.copy(t.clone().add(dir.normalize().multiplyScalar(dist * sc)));
        c.lookAt(t);
        c.updateMatrixWorld(true);
        c.updateProjectionMatrix();
        return {ok:true, aspect:+c.aspect.toFixed(3), dist:+(dist*sc).toFixed(1),
                tgt:t.toArray().map(function(v){return +v.toFixed(2);})};
      })()`,
    );
  },

  /**
   * 在原生相机基准上，直接设定一个"距离倍数"（不依赖 fitScale 绝对值）。
   * distMul 相对的是"按画幅适配后的距离"。
   */
  async setCameraDistance(page, native, distMul) {
    return page.evaluate(
      `(function(){
        var L = window.__lab, c = L.camera, t = L.controls.target;
        var nat = ${JSON.stringify(native)};
        t.set(nat.tgt[0], nat.tgt[1], nat.tgt[2]);
        var V = c.position.constructor;
        var dir = new V(nat.pos[0]-nat.tgt[0], nat.pos[1]-nat.tgt[1], nat.pos[2]-nat.tgt[2]);
        var dist = dir.length();
        var ASP = ${NATIVE_ASPECT} / Math.max(0.001, c.aspect);
        c.position.copy(t.clone().add(dir.normalize().multiplyScalar(dist * ASP * ${distMul})));
        c.lookAt(t);
        c.updateMatrixWorld(true);
        c.updateProjectionMatrix();
        return {ok:true, dist:+(dist*ASP*${distMul}).toFixed(2)};
      })()`,
    );
  },
};

/**
 * 把 base64 帧数组写成 mp4（用 ffmpeg）。
 *
 * 关键实现选择：**通过管道喂给 ffmpeg，不落中间 jpg 文件**。
 * 早先的写法是"写 f%05d.jpg → ffmpeg 读目录 → 删目录"，
 * 结果每次都撞上 safe-delete 钩子的批量删除阈值（一帧一个文件，
 * 一个片段就 250+ 个文件，整轮被拦）。
 * 管道输入既没有临时文件，也就没有删除动作。
 */
export function framesToMp4(frames, outPath, fps = 30) {
  const proc = spawn(
    'ffmpeg',
    [
      '-y',
      '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outPath,
    ],
    {stdio: ['pipe', 'ignore', 'pipe']},
  );
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('ffmpeg 退出码 ' + code + '\n' + err.slice(-800))),
    );
  });
  for (const b64 of frames) {
    proc.stdin.write(Buffer.from(b64, 'base64'));
  }
  proc.stdin.end();
  return done.then(() => outPath);
}
