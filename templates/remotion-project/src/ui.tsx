import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import type {CSSProperties} from 'react';
import {COLORS, FONT} from './theme';

/** 入场：轻微上浮 + 淡入 */
export const enterUp = (frame: number, delay = 0, span = 14) => {
  const p = interpolate(frame - delay, [0, span], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return {
    opacity: p,
    transform: `translateY(${(1 - p) * 22}px)`,
  };
};

/** 出场：淡出 */
export const exitFade = (frame: number, total: number, span = 10) => {
  const p = interpolate(frame, [total - span, total], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return {opacity: p};
};

export const cardShadow =
  '0 2px 6px rgba(23,32,42,0.05), 0 12px 32px rgba(23,32,42,0.07)';

/** 章节徽标（步骤编号 / 单元编号） */
export const Badge: React.FC<{
  children: React.ReactNode;
  tone?: 'accent' | 'hot' | 'green' | 'plain';
  style?: CSSProperties;
}> = ({children, tone = 'accent', style}) => {
  const map = {
    accent: {bg: COLORS.accentSoft, fg: COLORS.accent},
    hot: {bg: COLORS.hotSoft, fg: COLORS.hot},
    green: {bg: COLORS.greenSoft, fg: COLORS.green},
    plain: {bg: '#FFFFFF', fg: COLORS.inkSoft},
  }[tone];
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 18px',
        borderRadius: 999,
        background: map.bg,
        color: map.fg,
        fontFamily: FONT,
        fontSize: 30,
        fontWeight: 700,
        letterSpacing: '0.02em',
        lineHeight: 1,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** 字幕条：把旁白原文放在画面下方（逐句出现） */
export const Caption: React.FC<{
  text: string;
  frame: number;
  delay?: number;
}> = ({text, frame, delay = 0}) => {
  const p = interpolate(frame - delay, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  if (!text) return null;
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 10}px)`,
        background: 'rgba(255,255,255,0.92)',
        border: `1px solid ${COLORS.line}`,
        borderRadius: 18,
        padding: '18px 26px',
        fontFamily: FONT,
        fontSize: 34,
        lineHeight: 1.5,
        color: COLORS.ink,
        fontWeight: 500,
        letterSpacing: '0.01em',
      }}
    >
      {text}
    </div>
  );
};

/**
 * 字幕条：把旁白原文放在画面下方。
 *
 * 做法是"渐进高亮"而不是"逐句替换"——所有分句都在容器里，
 * 当前读到的句子加深、后面的淡化。这样字幕框高度恒定，画面不会跳动。
 */
export const splitCaption = (text: string): string[] => {
  if (!text) return [];
  const rough = text
    .split(/(?<=[，。；：？！、])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (rough.length <= 1) return rough;
  // 太碎的合并一下，最多 4 句
  const merged: string[] = [];
  let buf = '';
  for (const s of rough) {
    buf += s;
    if (buf.length >= 12) {
      merged.push(buf);
      buf = '';
    }
  }
  if (buf) {
    if (merged.length) merged[merged.length - 1] += buf;
    else merged.push(buf);
  }
  return merged.slice(0, 4);
};

export const CaptionTrack: React.FC<{
  text: string;
  frame: number;
  durationInFrames: number;
}> = ({text, frame, durationInFrames}) => {
  const segs = splitCaption(text);
  if (!segs.length) return null;
  const per = durationInFrames / segs.length;
  const active = Math.min(segs.length - 1, Math.floor(frame / per));

  const p = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        opacity: p,
        background: 'rgba(255,255,255,0.94)',
        border: `1px solid ${COLORS.line}`,
        borderRadius: 18,
        padding: '18px 26px',
        fontFamily: FONT,
        fontSize: 33,
        lineHeight: 1.5,
        color: COLORS.ink,
        letterSpacing: '0.01em',
        minHeight: 96,
        boxShadow: cardShadow,
      }}
    >
      {segs.map((s, i) => (
        <span
          key={i}
          style={{
            color: i <= active ? COLORS.ink : COLORS.inkFaint,
            fontWeight: i === active ? 700 : 500,
          }}
        >
          {s}
        </span>
      ))}
    </div>
  );
};

/** 数据卡：label + value */
export const DataCard: React.FC<{
  label: string;
  value: string;
  delay?: number;
  frame: number;
  emphasis?: boolean;
}> = ({label, value, delay = 0, frame, emphasis}) => {
  const p = interpolate(frame - delay, [0, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 16}px)`,
        background: COLORS.paper,
        border: `1px solid ${COLORS.line}`,
        borderLeft: `6px solid ${emphasis ? COLORS.hot : COLORS.accent}`,
        borderRadius: 14,
        padding: '16px 20px',
        minWidth: 0,
        flex: '1 1 0',
      }}
    >
      {label ? (
        <div
          style={{
            fontFamily: FONT,
            fontSize: 24,
            color: COLORS.inkSoft,
            fontWeight: 600,
            marginBottom: 6,
            lineHeight: 1.25,
          }}
        >
          {label}
        </div>
      ) : null}
      <div
        style={{
          fontFamily: FONT,
          fontSize: label ? 38 : 32,
          color: emphasis ? COLORS.hot : COLORS.ink,
          fontWeight: 800,
          lineHeight: 1.2,
          letterSpacing: '0.01em',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </div>
    </div>
  );
};

/** 公式条 */
export const FormulaBar: React.FC<{
  text: string;
  frame: number;
  delay?: number;
}> = ({text, frame, delay = 0}) => {
  const p = interpolate(frame - delay, [0, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  if (!text) return null;
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 14}px)`,
        background: COLORS.accentSoft,
        borderRadius: 14,
        padding: '18px 22px',
        fontFamily: FONT,
        fontSize: 32,
        fontWeight: 700,
        color: COLORS.accent,
        lineHeight: 1.35,
        textAlign: 'center',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  );
};

/** 要点条（小字补充） */
export const BulletList: React.FC<{
  items: string[];
  frame: number;
  delay?: number;
}> = ({items, frame, delay = 0}) => {
  const p = interpolate(frame - delay, [0, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  if (!items.length) return null;
  return (
    <div style={{opacity: p, display: 'flex', flexDirection: 'column', gap: 10}}>
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            gap: 12,
            fontFamily: FONT,
            fontSize: 27,
            color: COLORS.ink,
            lineHeight: 1.45,
          }}
        >
          <span
            style={{
              flex: '0 0 auto',
              width: 8,
              height: 8,
              borderRadius: 999,
              background: COLORS.accent,
              marginTop: 13,
            }}
          />
          <span>{it}</span>
        </div>
      ))}
    </div>
  );
};

/** 顶部栏：课程名 + 步骤进度 */
export const TopBar: React.FC<{
  title: string;
  subject: string;
  stepLabel?: string;
  progress?: number;
}> = ({title, subject, stepLabel, progress}) => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}
    >
      <div style={{minWidth: 0}}>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 34,
            fontWeight: 800,
            color: COLORS.ink,
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 24,
            color: COLORS.inkFaint,
            fontWeight: 600,
            marginTop: 4,
          }}
        >
          {subject}
        </div>
      </div>
      {stepLabel ? (
        <div
          style={{
            flex: '0 0 auto',
            fontFamily: FONT,
            fontSize: 26,
            fontWeight: 700,
            color: COLORS.accent,
            background: COLORS.accentSoft,
            borderRadius: 999,
            padding: '9px 18px',
          }}
        >
          {stepLabel}
        </div>
      ) : null}
      {typeof progress === 'number' ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            bottom: -14,
            height: 5,
            width: `${Math.max(2, Math.min(100, progress * 100))}%`,
            background: COLORS.accent,
            borderRadius: 999,
          }}
        />
      ) : null}
    </div>
  );
};

/** 片尾署名（CC BY-NC 必须出现） */
export const Credit: React.FC<{text: string}> = ({text}) => (
  <div
    style={{
      fontFamily: FONT,
      fontSize: 22,
      color: COLORS.inkFaint,
      fontWeight: 600,
      textAlign: 'center',
      lineHeight: 1.4,
    }}
  >
    {text}
  </div>
);

/** 淡入淡出整镜 */
export const ShotFade: React.FC<{
  frame: number;
  durationInFrames: number;
  children: React.ReactNode;
}> = ({frame, durationInFrames, children}) => {
  const {fps} = useVideoConfig();
  const fade = Math.min(12, Math.floor(durationInFrames / 4));
  const p = interpolate(
    frame,
    [0, fade, durationInFrames - fade, durationInFrames],
    [0, 1, 1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  void fps;
  return <div style={{opacity: p, width: '100%', height: '100%'}}>{children}</div>;
};
