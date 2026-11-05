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
