/**
 * LiveReadout.tsx — 随画面滚动的实时读数
 *
 * 为什么需要它：
 *   课件把 pH、滴定管读数、离子计数都写在 window.__lab.live() 里，
 *   但渲染出来的是 3D 画面，数字原本在课件自己的 UI 上（抓帧时被隐藏了）。
 *   capture_3d.mjs 在录运动片段时同步采下了这些读数，
 *   这里按当前播放进度取样，把数字"接回"到画面上 ——
 *   于是观众看到的是「参数一边调，读数一边变」，而不是一张静止的图。
 *
 * 呈现：
 *   - 数字本身随时间滚动（不是整段跳变）
 *   - 右侧一条变化趋势条，看得出是升是降
 *   - 字段名用中文标签（由 script.json 的 track_labels 提供），没有就用原 key
 */

import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';
import {COLORS, FONT} from './theme';
import type {Track, TrackField} from './types';

/** 读数字段的中文标签与单位 */
export const TRACK_LABELS: Record<string, {label: string; unit?: string}> = {
  Vread: {label: '滴定管读数', unit: 'mL'},
  levelML: {label: '液面高度', unit: 'mL'},
  ph: {label: 'pH'},
  pH: {label: 'pH'},
  temp: {label: '温度', unit: '℃'},
  V: {label: '体积', unit: 'mL'},
  c: {label: '浓度', unit: 'mol/L'},
  v: {label: '流速', unit: 'm/s'},
  d: {label: '粒径', unit: 'mm'},
  D: {label: '粒径', unit: 'mm'},
  t: {label: '时间', unit: 's'},
  T: {label: '温度', unit: 'K'},
  I: {label: '电流', unit: 'A'},
  U: {label: '电压', unit: 'V'},
  R: {label: '电阻', unit: 'Ω'},
  P: {label: '功率', unit: 'W'},
  E: {label: '能量', unit: 'J'},
  m: {label: '质量', unit: 'g'},
  n: {label: '物质的量', unit: 'mol'},
  q: {label: '电荷', unit: 'C'},
  F: {label: '力', unit: 'N'},
  a: {label: '加速度', unit: 'm/s²'},
  v0: {label: '初速度', unit: 'm/s'},
};

/** 按播放进度在采样点之间做线性插值。 */
const sampleAt = (track: Track, ms: number): Record<string, number> => {
  const ss = track.samples;
  if (!ss.length) return {};
  if (ms <= ss[0].t) return {...ss[0]};
  if (ms >= ss[ss.length - 1].t) return {...ss[ss.length - 1]};
  for (let i = 1; i < ss.length; i++) {
    if (ss[i].t >= ms) {
      const a = ss[i - 1];
      const b = ss[i];
      const span = b.t - a.t || 1;
      const r = (ms - a.t) / span;
      const out: Record<string, number> = {};
      for (const k of Object.keys(b)) {
        if (k === 't') continue;
        const av = typeof a[k] === 'number' ? (a[k] as number) : b[k];
        const bv = typeof b[k] === 'number' ? (b[k] as number) : av;
        out[k] = av + (bv - av) * r;
      }
      return out;
    }
  }
  return {...ss[ss.length - 1]};
};

/** 数字格式化：整数值不带小数点，小数保留原精度。 */
const fmt = (v: number, field: TrackField): string => {
  if (!Number.isFinite(v)) return '—';
  const span = Math.abs(field.max - field.min);
  if (span >= 100) return v.toFixed(0);
  if (span >= 1) return v.toFixed(2);
  if (span >= 0.01) return v.toFixed(3);
  return v.toFixed(4);
};

/** 单条读数 */
const ReadoutRow: React.FC<{
  field: TrackField;
  value: number;
  frame: number;
  delay: number;
}> = ({field, value, frame, delay}) => {
  // 优先用轨里带的标签（抓帧时从课件 CONSOLE 读的中文名），
  // 没有才退回内置表。
  const meta =
    field.label || TRACK_LABELS[field.key]
      ? {label: field.label || TRACK_LABELS[field.key].label,
         unit: field.unit || TRACK_LABELS[field.key]?.unit}
      : {label: field.key};
  const span = Math.abs(field.max - field.min) || 1;
  // 进度条：从 field.from 走到 field.to
  const p = Math.max(0, Math.min(1, (value - field.from) / (field.to - field.from || 1)));
  const up = field.to >= field.from;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 14px',
        background: COLORS.paper,
        borderRadius: 14,
        boxShadow: cardShadow,
        borderLeft: `5px solid ${up ? COLORS.hot : COLORS.accent}`,
      }}
    >
      <div style={{flex: '0 0 auto', minWidth: 118}}>
        <div style={{fontSize: 19, color: COLORS.inkSoft, fontWeight: 600, lineHeight: 1.25}}>
          {meta.label}
        </div>
      </div>
      <div
        style={{
          flex: '1 1 auto',
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'flex-end',
          gap: 6,
        }}
      >
        <span
          style={{
            fontSize: 32,
            fontWeight: 800,
            color: COLORS.ink,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.01em',
          }}
        >
          {fmt(value, field)}
        </span>
        {meta.unit ? (
          <span style={{fontSize: 19, color: COLORS.inkFaint, fontWeight: 700}}>
            {meta.unit}
          </span>
        ) : null}
      </div>
      {/* 趋势条 */}
      <div
        style={{
          flex: '0 0 auto',
          width: 78,
          height: 8,
          borderRadius: 4,
          background: COLORS.line,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${interpolate(p, [0, 1], [0, 100], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })}%`,
            background: up
              ? `linear-gradient(90deg, ${COLORS.accent}, ${COLORS.hot})`
              : `linear-gradient(90deg, ${COLORS.accent}, ${COLORS.green})`,
            borderRadius: 4,
          }}
        />
      </div>
    </div>
  );
};

/**
 * 读数面板：贴在 3D 画面下沿，随播放进度滚动。
 * track 为空时整块不渲染（不影响其它镜头）。
 */
export const LiveReadout: React.FC<{
  track: Track | null | undefined;
  fps: number;
  clipOffsetFrames?: number;
  max?: number;
}> = ({track, fps, clipOffsetFrames = 0, max = 3}) => {
  const frame = useCurrentFrame();
  if (!track || !track.samples.length || !track.fields.length) return null;

  // 画面内的播放进度（毫秒）。运动片段从它自己的第一帧开始。
  const local = Math.max(0, frame - clipOffsetFrames);
  const ms = (local / fps) * 1000;
  const cur = sampleAt(track, ms);

  const fields = track.fields.slice(0, max);
  const shown = fields.filter((f) => typeof cur[f.key] === 'number');
  if (!shown.length) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontFamily: FONT,
      }}
    >
      {shown.map((f, i) => (
        <ReadoutRow
          key={f.key}
          field={f}
          value={cur[f.key]}
          frame={frame}
          delay={i * 3}
        />
      ))}
    </div>
  );
};
