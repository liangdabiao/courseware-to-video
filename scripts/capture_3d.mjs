/**
 * capture_3d.mjs — 抓课件自己的 3D 画面（静帧 + 运动片段）
 *
 * 用法：
 *   node capture_3d.mjs --script script.json --out <dir>
 *                       [--width 1080] [--height 1920] [--fit-scale 0.92]
 *
 * 输入 script.json 的每个 shot 带一个 capture 块：
 *   {
 *     "id": "s03",
 *     "capture": {
 *       "step": 1,                  // 课件第几步（0 起）
 *       "mode": "still" | "motion",
 *       "actions": [                // 动作序列（可空）
 *         {"type": "demo"},                          // 复现课件作者设计的演示
 *         {"type": "set",    "key": "stage", "value": 0},
 *         {"type": "toggle", "key": "flood"},
 *         {"type": "tween",  "key": "reach", "to": 1, "seconds": 1.6},
 *         {"type": "sweep",  "key": "V", "via": [0, 5, 10, 15, 20.9], "hold": 600},
 *         {"type": "orbit",  "seconds": 4},
 *         {"type": "wait",   "ms": 900}
 *       ],
 *       "settle_ms": 1200,          // 状态变化后的稳定等待
 *       "motion_ms": 4000,          // motion 模式下的录制时长
 *       "fit_scale": 0.92           // 画面占比微调（<1 拉近）
 *     }
 *   }
 *
 * 输出：
 *   <out>/<shot_id>.png   静帧
 *   <out>/<shot_id>.mp4   运动片段（screencast 抓帧 → ffmpeg 编码）
 *   <out>/_tracks/<shot_id>.json  录制期间采到的实时读数曲线（给 Remotion 做动态数字）
 *
 * 三个必须做对的地方（都是实测踩出来的）：
 *  1. 必须 GPU：--use-angle=d3d11 --enable-gpu，软件渲染只有 2.6fps。
 *  2. 必须先在**原生 16:9** 下录下每一步的相机，再切画幅。
 *     课件的 resize 处理器在非 16:9 下会把相机 target 的 y 算错
 *     （16:9 下 y=4.4，9:16 下变成 71.6），画面直接飘走。
 *  3. 隐藏 UI 时只能用 `body *{visibility:hidden}` + 单独放开 #gl。
 *     课件有**两个** canvas（#gl 主画面 + #chart 读数图表），
 *     放行所有 canvas 会让图表漏进画面右下角。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  launchChrome, Page, Lab, sleep, framesToMp4, NATIVE_ASPECT,
} from './lib_cdp.mjs';

function parseArgs(argv) {
  const args = {
    script: null, out: null, width: 1080, height: 1920, html: null,
    fitScale: 1, autofit: true, fillWidth: 0.90, fillHeight: 0.86,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--script') args.script = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--html') args.html = argv[++i];
    else if (a === '--width') args.width = parseInt(argv[++i], 10);
    else if (a === '--height') args.height = parseInt(argv[++i], 10);
    else if (a === '--fit-scale') args.fitScale = parseFloat(argv[++i]);
    else if (a === '--fill-width') args.fillWidth = parseFloat(argv[++i]);
    else if (a === '--fill-height') args.fillHeight = parseFloat(argv[++i]);
    else if (a === '--no-autofit') args.autofit = false;
  }
  if (!args.script) {
    console.error(
      '用法: node capture_3d.mjs --script script.json --out <dir> [--html course.html]',
    );
    process.exit(2);
  }
  return args;
}

/** 执行一串动作，返回可读日志。 */
async function runActions(page, actions, stepIndex) {
  const log = [];
  if (!actions || !actions.length) return log;

  // orbit 走后台：这样"边转边调参数"能同时发生，而不是排队。
  const bg = [];

  for (const a of actions) {
    const t = a.type;
    if (t === 'set') {
      await page.evaluate(
        `window.__lab.set(${JSON.stringify(a.key)}, ${JSON.stringify(a.value)})`,
      );
      log.push(`set ${a.key}=${JSON.stringify(a.value)}`);
    } else if (t === 'toggle') {
      await page.evaluate(`window.__lab.toggle(${JSON.stringify(a.key)})`);
      log.push(`toggle ${a.key}`);
    } else if (t === 'switch') {
      await page.evaluate(
        `window.__lab.setSwitch(${JSON.stringify(a.key)}, ${JSON.stringify(a.value)})`,
      );
      log.push(`switch ${a.key}=${JSON.stringify(a.value)}`);
    } else if (t === 'demo') {
      const r = await Lab.runDemo(page, stepIndex);
      log.push(`demo → ${r}`);
    } else if (t === 'orbit') {
      await page.evaluate(`(function(){
        var c = window.__lab.controls;
        if (!c) return 0;
        c.autoRotate = true; c.autoRotateSpeed = ${a.speed || 1.5};
        return 1;
      })()`);
      const secs = a.seconds || 3;
      bg.push(
        (async () => {
          await sleep(secs * 1000);
          await page.evaluate(`(function(){
            var c = window.__lab.controls;
            if (c) c.autoRotate = false;
            return 1;
          })()`);
        })(),
      );
      log.push(`orbit ${secs}s（后台）`);
    } else if (t === 'tween') {
      // 课件的 set 是瞬时的；tween 用多次逼近产生连续运动
      const dur = (a.seconds || 1.5) * 1000;
      const steps = Math.max(8, Math.round(dur / 40));
      const cur = JSON.parse(
        await page.evaluate(
          `JSON.stringify(window.__lab.live()[${JSON.stringify(a.key)}] ?? null)`,
        ),
      );
      const from = cur === null ? (a.from ?? 0) : cur;
      const to = a.to;
      for (let i = 1; i <= steps; i++) {
        const v = from + ((to - from) * i) / steps;
        await page.evaluate(
          `window.__lab.set(${JSON.stringify(a.key)}, ${v})`,
        );
        await sleep(dur / steps);
      }
      log.push(`tween ${a.key}: ${from} → ${to}`);
    } else if (t === 'sweep') {
      // 连续扫过一串取值，每档停一下 —— 让学生看清"参数变了会怎样"。
      // via 可以是 [a, b, c]（逐档）也可以是 [a, b] + {"back": true}（来回）。
      const via = Array.isArray(a.via) ? a.via : [];
      const hold = a.hold ?? 700;
      const back = !!a.back;
      const seq = back ? [...via, ...via.slice(0, -1).reverse()] : via;
      for (const v of seq) {
        await page.evaluate(
          `window.__lab.set(${JSON.stringify(a.key)}, ${JSON.stringify(v)})`,
        );
        await sleep(hold);
      }
      log.push(`sweep ${a.key}: ${seq.join(' → ')}`);
    } else if (t === 'hold') {
      await sleep(a.ms || 800);
      log.push(`hold ${a.ms || 800}ms`);
    } else if (t === 'wait') {
      await sleep(a.ms || 500);
      log.push(`wait ${a.ms || 500}ms`);
    } else if (t === 'eval') {
      const r = await page.evaluate(a.code);
      log.push(`eval → ${JSON.stringify(r)}`);
    }
  }

  await Promise.all(bg);
  return log;
}

/**
 * 一次读出"所有实时读数"。
 *
 * live() 里有课件的内部状态（Vread / 液面 / 离子计数 / 颜色），
 * 但**主读数（这里是 pH）在 HUD 的 DOM 元素里**，不在 live() 中。
 * 所以两处都读：live 给结构化数值，HUD 给主读数。
 *
 * 读 DOM 只取 innerText 的第一行纯数字部分，避免把 "锥形瓶 pH" 这种标题混进来。
 */
const PROBE_EXPR = `(function(){
  // 注意：必须用 textContent，不能用 innerText。
  // 抓帧时我们把整个 UI 设成 visibility:hidden，
  // 而 innerText 对隐藏元素返回空串 —— pH 就这么丢的。
  //
  // 但 textContent 又会把所有子 div 拼成一行（没有换行），
  // 于是"锥形瓶 pH 达标 12.65"里的数字和标题混在一起。
  // 解法：读 innerText 的**换行版**取标题行，
  //      数值优先从课件给的纯数字元素里取（rateEl / subs[i].el）。
  function numOf(el){
    if (!el) return null;
    var raw = String(el.textContent || '');
    // 纯数字元素（rateEl / subs.el）直接 parse
    var direct = raw.match(/^\\s*(-?\\d+(?:\\.\\d+)?)\\s*$/);
    if (direct) return parseFloat(direct[1]);
    // 退化：找最后一个独立的数字（前面不是数字字符）
    var all = raw.match(/-?\\d+(?:\\.\\d+)?/g);
    if (!all || !all.length) return null;
    return parseFloat(all[all.length - 1]);
  }
  function titleOf(el){
    if (!el) return null;
    // 用 innerText 的第一行（标题），但隐藏元素下 innerText 为空，
    // 所以用第一个 class="lb"/子 div 的 textContent
    var lb = el.querySelector ? el.querySelector('.lb, .label, .t') : null;
    if (lb) return String(lb.textContent || '').trim();
    var first = el.firstElementChild;
    if (first) return String(first.textContent || '').trim();
    return null;
  }

  var out = {};
  try { var l = window.__lab.live() || {}; for (var k in l) out[k] = l[k]; } catch(e) {}

  try {
    var h = window.__lab.hud || {};
    var main = numOf(h.rateEl);          // 纯数字元素 = 主读数值
    if (main !== null) {
      out.__main = main;
      var mt = titleOf(h.kpiEl);
      if (mt) out['__main:label'] = mt;
    }
    // 副读数：数值在 <b> 标签里（结构：<div class=lb>标题</div><b>数值</b>…），
    // 容器里还有标题与说明文字，直接读容器会取错数字。
    var subs = h.subs || [];
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      var el = s.el || s.value || s.node;
      if (!el) continue;
      var b = el.querySelector ? el.querySelector('b') : null;
      var v = numOf(b || el);
      if (v !== null) out['__sub' + i] = v;
    }
  } catch(e) {}
  return JSON.stringify(out);
})()`;

/**
 * 读数采样器：在录制期间持续读 window.__lab.live()，
 * 得到"时间 → 关键读数"的曲线。
 *
 * 为什么必须采样：课件把 pH、滴定管读数、离子计数都写在 live() 里，
 * 但渲染出来的是 3D 画面，数字在课件自己的 UI 上（已被隐藏）。
 * 采下来后，Remotion 就能在讲解层做"随画面滚动的数字"，
 * 让观众看到读数跟着参数一起变 —— 这才是"动态"。
 */
function makeSampler(page, {intervalMs = 110} = {}) {
  const samples = [];
  let running = true;
  let busy = false;

  const tick = async () => {
    while (running) {
      if (!busy) {
        busy = true;
        try {
          const raw = await page.evaluate(PROBE_EXPR);
          const obj = JSON.parse(raw);
          samples.push({t: Date.now(), v: obj});
        } catch {
          // 页面正在导航/异常时忽略这一帧
        }
        busy = false;
      }
      await sleep(intervalMs);
    }
  };
  const done = tick();
  return {
    samples,
    async stop() {
      running = false;
      await done;
    },
  };
}

/**
 * 从采样里挑出适合上屏的读数（数值型、且变化明显）。
 *
 * 标签从课件自己的 CONSOLE 里取 —— 那里写着"锥形瓶 pH""滴定管末读数"
 * 这类中文名，比自己猜字段名靠谱得多。
 */
function pickTrackFields(samples, labels = {}) {
  if (!samples.length) return [];
  const keys = new Set();
  for (const s of samples) {
    for (const k of Object.keys(s.v || {})) {
      const val = s.v[k];
      if (typeof val === 'number' && Number.isFinite(val)) keys.add(k);
    }
  }
  const out = [];
  for (const k of keys) {
    const vals = samples.map((s) => s.v[k]);
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    if (Math.abs(mx - mn) < 1e-9) continue;  // 没变化的量不上屏
    out.push({
      key: k,
      label: labels[k] || null,
      unit: labels[k + ':unit'] || null,
      min: mn,
      max: mx,
      from: vals[0],
      to: vals[vals.length - 1],
    });
  }
  // 排序：主读数（__main）和副读数（__sub*）是课件明确展示给学生的，
  // 优先保留；其余按变化量排。
  const rank = (k) => {
    if (k === '__main') return 0;
    if (k.startsWith('__sub')) return 1;
    if (k === '__rate') return 2;
    return 3;
  };
  // 主读数的标签：CONSOLE 里的中文名优先，HUD 现场取的兜底
  for (const f of out) {
    if (f.key === '__main') {
      f.label = labels['__main'] || labels['__main:label'] || null;
      f.unit = labels['__main:unit'] || null;
    }
  }
  out.sort((a, b) => {
    const ra = rank(a.key);
    const rb = rank(b.key);
    if (ra !== rb) return ra - rb;
    return Math.abs(b.to - b.from) - Math.abs(a.to - a.from);
  });
  // 主读数最多 4 个（主 + 3 副），其余字段最多再带 2 个
  const main = out.filter((f) => rank(f.key) < 3).slice(0, 4);
  const extra = out.filter((f) => rank(f.key) >= 3).slice(0, 2);
  return [...main, ...extra];
}

/**
 * 从课件的 CONSOLE 里读读数的中文标签。
 * CONSOLE.main.label 是主读数名，CONSOLE.subs[].label 是副读数名。
 */
async function readLabels(page) {
  try {
    const raw = await page.evaluate(`(function(){
      var c = window.__lab.CONSOLE || {};
      var out = {};
      if (c.main && c.main.label) {
        out['__main'] = c.main.label;
        if (c.main.unit) out['__main:unit'] = c.main.unit;
      }
      (c.subs || []).forEach(function(s, i) {
        if (s.label) out['__sub' + i] = s.label;
      });
      // HUD 现场的主读数标题（比 CONSOLE 更贴近当下显示）
      try {
        var h = window.__lab.hud || {};
        var kpi = h.kpiEl;
        var lb = kpi && kpi.querySelector ? kpi.querySelector('.lb') : null;
        if (lb && lb.textContent) out['__main:label'] = String(lb.textContent).trim();
      } catch(e) {}
      (c.sliders || []).forEach(function(s) {
        if (s.key && s.label) {
          out[s.key] = s.label;
          if (s.unit) out[s.key + ':unit'] = s.unit;
        }
      });
      return JSON.stringify(out);
    })()`);
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const scriptPath = path.resolve(args.script);
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const outDir = path.resolve(args.out || path.join(path.dirname(scriptPath), 'capture'));
  fs.mkdirSync(outDir, {recursive: true});

  const htmlPath = path.resolve(args.html || script.source_html);
  if (!fs.existsSync(htmlPath)) {
    console.error('课件文件不存在: ' + htmlPath);
    process.exit(2);
  }

  const shots = (script.shots || script.scenes || []).filter((s) => s.capture);
  console.log(`课件: ${htmlPath}`);
  console.log(`镜头: ${shots.length}  画布: ${args.width}x${args.height}  输出: ${outDir}`);
  console.log('');

  const browser = await launchChrome({width: 1920, height: 1080});
  const page = new Page(browser);
  const results = [];

  try {
    await page.open();
    await page.setViewport(1920, 1080, 1);
    await page.navigate('file:///' + htmlPath.replace(/\\/g, '/'));
    const waited = await Lab.ready(page);
    console.log(`运行时就绪 ${waited}ms`);

    // ---- 1. 原生 16:9 下录下每一步的相机（后面换画幅要靠它重建）----
    await sleep(2500);
    const stepCount = await page.evaluate('window.__lab.STEPS.length');
    const native = await Lab.recordNativeCameras(page, stepCount);
    console.log(`已记录 ${Object.keys(native).length} 步原生相机`);

    // ---- 2. 切到目标画幅并隐藏 UI ----
    await page.setViewport(args.width, args.height, 1);
    await page.evaluate('window.dispatchEvent(new Event("resize"))');
    await sleep(1800);
    const hideMsg = await page.hideUi();
    console.log(`UI: ${hideMsg}`);
    await sleep(600);

    // ---- 3. 自动取景：让主体按目标占比填满画面 ----
    // 课件在 9:16 下如果只是等比缩放距离，主体会缩得很小、四周大片空白。
    // 这里用"量 ink bbox → 反算距离"的办法，把主体拉到目标占比。
    const fitMap = {};
    if (args.autofit) {
      const need = [...new Set(shots.map((s) => s.capture.step ?? 0))];
      console.log(`自动取景: ${need.length} 步，目标宽度占比 ${args.fillWidth}`);
      for (const st of need) {
        await Lab.goto(page, st, {instant: true});
        await sleep(900);
        await Lab.applyNativeCamera(page, native[st], {fitScale: 1});
        await sleep(700);

        let mul = 1;
        let ink = null;
        for (let iter = 0; iter < 4; iter++) {
          const buf = await page.screenshot({format: 'jpeg', quality: 70});
          ink = await page.measureInk(buf.toString('base64'));
          if (!ink.ok) break;
          const fracW = ink.bw / ink.w;
          const fracH = ink.bh / ink.h;
          // 屏幕尺寸 ∝ 1/距离 → 想把主体放大 s 倍，距离要除以 s。
          // 宽高两个方向都要装得下，取小的那个放大倍数。
          const s = Math.min(args.fillWidth / fracW, args.fillHeight / fracH);
          if (Math.abs(s - 1) < 0.04) break;
          mul = Math.max(0.25, Math.min(4, mul / s));
          await Lab.setCameraDistance(page, native[st], mul);
          await sleep(600);
        }
        // 循环可能是因为迭代次数用尽而退出，最后一次改的距离没被实测过，
        // 这里补测一次，保证"报告的占比"就是"最终相机的占比"。
        {
          const buf = await page.screenshot({format: 'jpeg', quality: 70});
          const m = await page.measureInk(buf.toString('base64'));
          if (m.ok) ink = m;
        }
        // 循环可能是因为迭代次数用尽而退出，最后一次改的距离没被实测过，
        // 这里补测一次，保证"报告的占比"就是"最终相机的占比"。
        {
          const buf = await page.screenshot({format: 'jpeg', quality: 70});
          const m = await page.measureInk(buf.toString('base64'));
          if (m.ok) ink = m;
        }
        fitMap[st] = {
          mul,
          ink: ink && {
            fracW: +(ink.bw / ink.w).toFixed(3),
            fracH: +(ink.bh / ink.h).toFixed(3),
          },
        };
        console.log(
          `  step${st}: 距离×${mul.toFixed(2)} 宽占比${fitMap[st].ink ? fitMap[st].ink.fracW : '?'}` +
          ` 高占比${fitMap[st].ink ? fitMap[st].ink.fracH : '?'}`,
        );
      }
    }

    // 读数标签（中文名来自课件自己的 CONSOLE）
    const labels = await readLabels(page);
    console.log(
      '读数标签: ' +
        (Object.keys(labels).length
          ? Object.entries(labels)
              .filter(([k]) => !k.endsWith(':unit'))
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')
          : '（课件未提供）'),
    );

    for (const shot of shots) {
      const cap = shot.capture;
      const step = cap.step ?? 0;
      const t0 = Date.now();

      await Lab.goto(page, step, {instant: true});
      await sleep(900);
      // 等课件自己的过渡彻底结束，再用原生基准重建相机
      const fitScale = fitMap[step] ? fitMap[step].mul : (cap.fit_scale ?? args.fitScale);
      const camInfo = await Lab.applyNativeCamera(page, native[step], {fitScale});
      await sleep(cap.settle_ms ?? 1000);

      let file = null;
      let note = '';
      if (cap.mode === 'motion') {
        // 先开录，再执行动作，运动才会被录进去
        const rec = await page.startRecord({quality: 82});
        const sampler = makeSampler(page);
        const rt0 = Date.now();
        await sleep(200);
        const log = await runActions(page, cap.actions, step);
        const target = cap.motion_ms ?? 4000;
        const remain = target - (Date.now() - rt0);
        if (remain > 200) await sleep(remain);
        const {frames, fps} = await rec.stop();
        await sampler.stop();
        if (!frames.length) {
          console.error(`  ✗ ${shot.id}: 没有抓到帧`);
        } else {
          file = path.join(outDir, `${shot.id}.mp4`);
          await framesToMp4(frames, file, Math.max(20, Math.round(fps)));
          note = `motion ${frames.length}帧 @${fps.toFixed(1)}fps | ${log.join('; ')}`;
        }
        // 读数曲线：给 Remotion 做"随画面滚动的数字"
        const fields = pickTrackFields(sampler.samples, labels);
        if (fields.length) {
          const t0 = sampler.samples.length ? sampler.samples[0].t : rt0;
          const track = {
            id: shot.id,
            step,
            duration_ms: Math.max(1, Date.now() - t0),
            fields,
            samples: sampler.samples.map((sm) => {
              const o = {t: sm.t - t0};
              for (const f of fields) o[f.key] = sm.v[f.key];
              return o;
            }),
          };
          const trackDir = path.join(outDir, '_tracks');
          fs.mkdirSync(trackDir, {recursive: true});
          fs.writeFileSync(
            path.join(trackDir, `${shot.id}.json`),
            JSON.stringify(track),
            'utf8',
          );
          note += ` | 读数轨 ${fields.map((f) => f.key).join(',')}`;
        }
      } else {
        const before = await Lab.live(page);
        const log = await runActions(page, cap.actions, step);
        await sleep(500);
        const after = await Lab.live(page);
        const buf = await page.screenshot({format: 'png'});
        file = path.join(outDir, `${shot.id}.png`);
        fs.writeFileSync(file, buf);
        note =
          `still ${(buf.length / 1024).toFixed(0)}KB | 状态变化=${before !== after}` +
          (log.length ? ` | ${log.join('; ')}` : '');
      }

      const size =
        file && fs.existsSync(file)
          ? (fs.statSync(file).size / 1024).toFixed(0) + 'KB'
          : 'FAILED';
      console.log(
        `  ${shot.id} step=${step} ${cap.mode} ${size} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${note}`,
      );
      results.push({
        id: shot.id, step, mode: cap.mode,
        file: file ? path.basename(file) : null,
        size_kb: file ? Math.round(fs.statSync(file).size / 1024) : 0,
        cam: camInfo, note,
      });
    }
    fs.writeFileSync(
      path.join(outDir, '_capture_log.json'),
      JSON.stringify(results, null, 2),
      'utf8',
    );
    console.log('\n完成。');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
