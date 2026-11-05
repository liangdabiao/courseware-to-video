/**
 * theme.ts — 视觉规范
 *
 * 画面语言：课件的 3D 渲染是浅灰底（#E8EAED）的**技术插画**风格，
 * 所以成片也走"白底 · 深墨字 · 一个强调色"的清爽技术感，
 * 而不是手绘风。配色：
 *   底 #EEF1F4   墨 #17202A   次墨 #5A6875   强调 #1E6FD9（课件的蓝）
 *   强调2 #E8590C（橙，用于数字高亮）
 */

export const COLORS = {
  bg: '#EEF1F4',
  paper: '#FFFFFF',
  ink: '#17202A',
  inkSoft: '#5A6875',
  inkFaint: '#93A1AD',
  accent: '#1E6FD9',
  accentSoft: '#E8F0FC',
  hot: '#E8590C',
  hotSoft: '#FFF1E6',
  green: '#2B8A3E',
  greenSoft: '#E8F6EC',
  line: '#DCE3E9',
  sceneBg: '#E8EAED',
};

export const FONT = "'Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', sans-serif";

export const W = 1080;
export const H = 1920;

/** 安全边距（竖屏 1080x1920） */
export const PAD = 56;

/** 3D 画面区域：给顶部标题和底部数据卡留出空间 */
export const STAGE = {
  x: PAD,
  y: 186,
  w: W - PAD * 2, // 968
  h: 645, // 3:2 —— 抓帧也按 3:2 抓，objectFit:cover 正好严丝合缝
  r: 28,
  /** 抓帧分辨率（比舞台大 1.24 倍，缩下来更锐） */
  capW: 1200,
  capH: 800,
};
