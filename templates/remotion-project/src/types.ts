/**
 * types.ts — 课件转短视频的数据结构
 *
 * 画面源：课件自己的 3D 渲染（静帧 PNG / 运动片段 MP4）
 * 讲稿源：课件自己的教案（q / act / expect / points / concl / eq）
 */

export type ShotKind =
  | 'title'   // 开场悬念
  | 'ask'     // 提问卡
  | 'answer'  // 答案卡（动手演示 + 真数字）
  | 'concl'   // 结论卡
  | 'chain'   // 因果链回扣
  | 'end';    // 结尾考点

export type DataItem = {
  label: string;
  value: string;
  kind?: 'value' | 'judge' | 'note' | 'unit' | 'chain' | 'exam';
};

/**
 * 录制期间采到的实时读数曲线。
 * 由 capture_3d.mjs 在录运动片段时同步读 window.__lab.live() 得到。
 * 有了它，讲解层可以放"随画面滚动的数字"，让读数跟着参数一起变。
 */
export type TrackSample = {
  t: number;          // 相对录制开始的毫秒
  [key: string]: number;
};

export type TrackField = {
  key: string;
  min: number;
  max: number;
  from: number;
  to: number;
};

export type Track = {
  id: string;
  step: number;
  duration_ms: number;
  fields: TrackField[];
  samples: TrackSample[];
};

export type CaptureSpec = {
  step: number;
  mode: 'still' | 'motion';
  actions: unknown[];
  motion_ms?: number;
  settle_ms?: number;
  fit_scale?: number;
};

export type Shot = {
  id: string;
  kind: ShotKind;
  step: number;
  narration: string;
  headline: string;
  sub?: string;
  q?: string;
  badge?: string;
  unit_no?: string;
  data?: DataItem[];
  formula?: string;
  eq_note?: string;
  bullets?: string[];
  note?: string;
  capture: CaptureSpec;
  // 由 apply_timeline 回填
  duration_sec?: number;
  narration_audio?: string | null;
  // 抓帧产物
  image?: string | null;
  clip?: string | null;
  // 读数轨（动态数字）
  track?: Track | null;
};

export type Project = {
  title: string;
  subject: string;
  slug: string;
  locate: string;
  width: number;
  height: number;
  fps: number;
  credit: string;
  source_html?: string;
};

export type Script = {
  project: Project;
  shots: Shot[];
};
