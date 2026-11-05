/**
 * extract_course.mjs — 从课件 HTML 里抽出完整教案
 *
 * 用法：
 *   node extract_course.mjs <course.html> [--out course.json] [--shot shot.json]
 *
 * 原理：不解析压缩后的 JS，而是**真跑一遍课件**（无头 Chrome），
 * 从运行时暴露的 window.__lab 读出结构化数据：
 *   __lab.C        课程配置（meta / mainline / units / steps）
 *   __lab.STEPS    步骤数组（每步含 q / act / expect / points / concl / exam）
 *   __lab.CONSOLE  中控台读数定义
 *
 * 输出的 course.json 就是"课件已经完成的讲解内容"，后续镜头规划直接用它。
 */

import fs from 'node:fs';
import path from 'node:path';
import {launchChrome, Page, Lab, sleep} from './lib_cdp.mjs';

function parseArgs(argv) {
  const args = {html: null, out: null, width: 1080, height: 1920, portrait: true};
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--width') args.width = parseInt(argv[++i], 10);
    else if (a === '--height') args.height = parseInt(argv[++i], 10);
    else if (a === '--landscape') args.portrait = false;
    else rest.push(a);
  }
  args.html = rest[0];
  if (!args.html) {
    console.error('用法: node extract_course.mjs <course.html> [--out course.json]');
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const htmlPath = path.resolve(args.html);
  if (!fs.existsSync(htmlPath)) {
    console.error('课件文件不存在: ' + htmlPath);
    process.exit(2);
  }
  const outPath = path.resolve(args.out || path.join(process.cwd(), 'course.json'));

  console.log('课件: ' + htmlPath);
  const browser = await launchChrome({width: args.width, height: args.height});
  const page = new Page(browser);
  try {
    await page.open();
    await page.setViewport(args.width, args.height, 1);
    const url = 'file:///' + htmlPath.replace(/\\/g, '/');
    console.log('加载: ' + url);
    await page.navigate(url);

    const waited = await Lab.ready(page);
    console.log(`运行时就绪: ${waited}ms`);
    // three.js 场景需要一点时间完成首帧渲染与相机归位
    await sleep(2500);

    const [stepsRaw, configRaw, consoleRaw, metaRaw] = await Promise.all([
      Lab.steps(page),
      Lab.config(page),
      Lab.console(page),
      Lab.meta(page),
    ]);

    const steps = JSON.parse(stepsRaw);
    const config = JSON.parse(configRaw);
    const consoleDef = consoleRaw ? JSON.parse(consoleRaw) : null;
    const meta = JSON.parse(metaRaw);

    const course = {
      source_html: htmlPath,
      extracted_at: new Date().toISOString(),
      meta: config.meta || {},
      mainline: config.mainline || {},
      units: config.units || [],
      console: consoleDef,
      runtime_meta: meta,
      steps: (steps || []).map((s, i) => ({
        index: i,
        no: s.no || '',
        tag: s.tag || '',
        unit: s.unit || '',
        q: s.q || '',
        act: s.act || null,
        expect: s.expect || null,
        points: s.points || [],
        concl: s.concl || '',
        exam: s.exam || '',
        ref: s.ref || '',
        eq: s.eq || null,
        eqCal: s.eqCal || null,
        layers: s.layers || [],
        chain: s.chain || null,
        start: s.start === undefined ? null : s.start,
      })),
    };

    // 统计，方便人工核对
    const withPoints = course.steps.filter((s) => s.points.length).length;
    const withAct = course.steps.filter((s) => s.act && s.act.kind).length;
    const withExpect = course.steps.filter(
      (s) => s.expect && (s.expect.text || s.expect.text === 0),
    ).length;
    const withConcl = course.steps.filter((s) => s.concl).length;
    const withExam = course.steps.filter((s) => s.exam).length;

    fs.writeFileSync(outPath, JSON.stringify(course, null, 2), 'utf8');

    console.log('');
    console.log('=== 提取结果 ===');
    console.log('标题      :', course.meta.title || '(无)');
    console.log('学科      :', course.meta.subject || '(无)');
    console.log('主线问题  :', course.mainline.q || '(无)');
    console.log('步骤数    :', course.steps.length);
    console.log(
      `  带讲解要点 points: ${withPoints} / 带动手动作 act: ${withAct} / ` +
        `带观察结果 expect: ${withExpect} / 带结论 concl: ${withConcl} / 带考点 exam: ${withExam}`,
    );
    console.log('输出      : ' + outPath);
    console.log('');
    course.steps.forEach((s) => {
      console.log(
        `  [${s.index}] ${s.no ? s.no + ' ' : ''}${s.tag}` +
          (s.q ? `  Q: ${s.q.slice(0, 40)}` : '') +
          (s.act ? `  act:${s.act.kind}` : ''),
      );
    });
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
