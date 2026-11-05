/**
 * Scene.tsx — 单个镜头的画面
 *
 * 画面语言（竖屏 1080x1920）：
 *   顶部   课程名 + 学科 + 步骤徽标
 *   中上   课件自己的 3D 画面（静帧带轻微 Ken Burns / 运动片段直接播）
 *   中下   讲解内容（提问 / 数据卡 / 公式 / 要点 / 因果链 / 考点清单）
 *   底部   字幕条（旁白渐进高亮）+ 署名
 *
 * 所有文案都来自课件自带的教案（extract_course.mjs 抽出来的
 * q / expect / points / concl / eq），这里只负责"排版"。
 */

import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import type {CSSProperties} from 'react';
import {COLORS, FONT, PAD, STAGE} from './theme';
import {
  Badge,
  BulletList,
  CaptionTrack,
  Credit,
  DataCard,
  FormulaBar,
  ShotFade,
  TopBar,
  cardShadow,
  enterUp,
} from './ui';
import type {DataItem, Shot} from './types';

/** 静帧的慢推镜头，避免画面完全静止 */
const kenBurns = (frame: number, duration: number): string => {
  const p = interpolate(frame, [0, Math.max(1, duration)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const s = 1 + 0.05 * p;
  const x = (p - 0.5) * 16;
  const y = (0.5 - p) * 12;
  return `scale(${s}) translate(${x}px, ${y}px)`;
};

/** 3D 画面区 */
const Stage: React.FC<{
  shot: Shot;
  frame: number;
  durationInFrames: number;
  style?: CSSProperties;
}> = ({shot, frame, durationInFrames, style}) => {
  const fill: CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  };
  return (
    <div
      style={{
        position: 'relative',
        width: STAGE.w,
        height: STAGE.h,
        borderRadius: STAGE.r,
        overflow: 'hidden',
        background: COLORS.sceneBg,
        boxShadow: cardShadow,
        flex: '0 0 auto',
        ...style,
      }}
    >
      {shot.clip ? (
        <OffthreadVideo
          src={staticFile(`media/${shot.clip}`)}
          style={fill}
          muted
        />
      ) : shot.image ? (
        <Img
          src={staticFile(`media/${shot.image}`)}
          style={{...fill, transform: kenBurns(frame, durationInFrames)}}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: STAGE.r,
          border: `1px solid ${COLORS.line}`,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
};

/** 步骤/章节小标签行 */
const ChipRow: React.FC<{shot: Shot; frame: number}> = ({shot, frame}) => {
  if (!shot.badge && !shot.note) return null;
  return (
    <div
      style={{
        ...enterUp(frame, 4),
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
      }}
    >
      {shot.badge ? <Badge tone="accent">{shot.badge}</Badge> : null}
      {shot.note ? (
        <div
          style={{
            fontFamily: FONT,
            fontSize: 24,
            color: COLORS.inkFaint,
            fontWeight: 600,
          }}
        >
          {shot.note}
        </div>
      ) : null}
    </div>
  );
};

/** 大标题 */
const Headline: React.FC<{text: string; frame: number; size?: number}> = ({
  text,
  frame,
  size = 46,
}) => {
  if (!text) return null;
  return (
    <div
      style={{
        ...enterUp(frame),
        fontFamily: FONT,
        fontSize: size,
        fontWeight: 800,
        color: COLORS.ink,
        lineHeight: 1.28,
        letterSpacing: '0.01em',
      }}
    >
      {text}
    </div>
  );
};

/** 数据卡组：两列网格，最后一张若落单则占满整行 */
const DataCards: React.FC<{
  items: DataItem[];
  frame: number;
}> = ({items, frame}) => {
  if (!items.length) return null;
  const col = (i: number) => ({
    ...enterUp(frame, 6 + i * 4),
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 14,
  });
  const rows: DataItem[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
      {rows.map((row, ri) => (
        <div key={ri} style={col(ri)}>
          {row.map((d, i) => (
            <DataCard
              key={i}
              label={d.label || ''}
              value={d.value}
              frame={frame}
              delay={6 + ri * 4}
              emphasis={d.kind === 'judge'}
            />
          ))}
        </div>
      ))}
    </div>
  );
};

/** 提问块 */
const AskBlock: React.FC<{shot: Shot; frame: number}> = ({shot, frame}) => {
  const q = shot.q || shot.headline;
  return (
    <div
      style={{
        ...enterUp(frame),
        background: COLORS.paper,
        borderRadius: 22,
        border: `1px solid ${COLORS.line}`,
        borderLeft: `8px solid ${COLORS.accent}`,
        boxShadow: cardShadow,
        padding: '34px 32px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 18}}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 999,
            background: COLORS.accent,
            color: '#FFFFFF',
            fontFamily: FONT,
            fontSize: 40,
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
          }}
        >
          ?
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 28,
            fontWeight: 700,
            color: COLORS.accent,
            letterSpacing: '0.04em',
          }}
        >
          先想一想
        </div>
      </div>
      <div
        style={{
          fontFamily: FONT,
          fontSize: 48,
          fontWeight: 800,
          color: COLORS.ink,
          lineHeight: 1.35,
        }}
      >
        {q}
      </div>
    </div>
  );
};

/** 因果链 */
const ChainBlock: React.FC<{items: DataItem[]; frame: number}> = ({
  items,
  frame,
}) => {
  if (!items.length) return null;
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
      {items.map((it, i) => (
        <div key={i} style={enterUp(frame, 6 + i * 5)}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              background: COLORS.paper,
              border: `1px solid ${COLORS.line}`,
              borderRadius: 16,
              padding: '18px 22px',
              boxShadow: cardShadow,
            }}
          >
            <div
              style={{
                flex: '0 0 auto',
                minWidth: 104,
                textAlign: 'center',
                padding: '10px 16px',
                borderRadius: 12,
                background: COLORS.accentSoft,
                color: COLORS.accent,
                fontFamily: FONT,
                fontSize: 30,
                fontWeight: 800,
              }}
            >
              {it.label}
            </div>
            <div
              style={{
                fontFamily: FONT,
                fontSize: 30,
                color: COLORS.ink,
                lineHeight: 1.4,
                fontWeight: 600,
              }}
            >
              {it.value}
            </div>
          </div>
          {i < items.length - 1 ? (
            <div
              style={{
                width: 4,
                height: 18,
                margin: '6px auto 0',
                background: COLORS.line,
                borderRadius: 2,
              }}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
};

/** 考点清单（结尾） */
const ExamBlock: React.FC<{items: DataItem[]; frame: number}> = ({
  items,
  frame,
}) => {
  if (!items.length) return null;
  return (
    <div
      style={{
        ...enterUp(frame),
        background: COLORS.greenSoft,
        border: `1px solid ${COLORS.green}`,
        borderRadius: 20,
        padding: '26px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            ...enterUp(frame, 6 + i * 5),
            display: 'flex',
            gap: 16,
            alignItems: 'flex-start',
          }}
        >
          <div
            style={{
              flex: '0 0 auto',
              width: 38,
              height: 38,
              borderRadius: 10,
              background: COLORS.green,
              color: '#FFFFFF',
              fontFamily: FONT,
              fontSize: 24,
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 4,
            }}
          >
            {i + 1}
          </div>
          <div
            style={{
              fontFamily: FONT,
              fontSize: 30,
              color: COLORS.ink,
              lineHeight: 1.45,
              fontWeight: 600,
            }}
          >
            {it.value}
          </div>
        </div>
      ))}
    </div>
  );
};

/** 标题页：整幅 3D 画面 + 暗色蒙版 + 大标题 */
const TitleScene: React.FC<{
  shot: Shot;
  frame: number;
  durationInFrames: number;
  credit: string;
}> = ({shot, frame, durationInFrames, credit}) => {
  return (
    <AbsoluteFill style={{background: '#0E1620'}}>
      {shot.image ? (
        <>
          {/* 背景：同一张图虚化铺满，避免大面积死黑 */}
          <Img
            src={staticFile(`media/${shot.image}`)}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(26px)',
              transform: 'scale(1.12)',
            }}
          />
          {/* 前景：完整入画（contain），沙盘不被裁 */}
          <Img
            src={staticFile(`media/${shot.image}`)}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 170,
              height: 1080,
              width: '100%',
              objectFit: 'contain',
              transform: kenBurns(frame, durationInFrames),
            }}
          />
        </>
      ) : null}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(11,18,26,0.88) 0%, rgba(11,18,26,0.18) 30%, rgba(11,18,26,0.55) 62%, rgba(11,18,26,0.96) 100%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD,
          bottom: 300,
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        <div style={enterUp(frame, 6)}>
          <Badge tone="hot">{shot.badge || '开始'}</Badge>
        </div>
        <div
          style={{
            ...enterUp(frame, 12),
            fontFamily: FONT,
            fontSize: 82,
            fontWeight: 900,
            color: '#FFFFFF',
            lineHeight: 1.16,
            letterSpacing: '0.01em',
          }}
        >
          {shot.headline}
        </div>
        {shot.sub ? (
          <div
            style={{
              ...enterUp(frame, 20),
              fontFamily: FONT,
              fontSize: 33,
              color: 'rgba(255,255,255,0.82)',
              fontWeight: 600,
              lineHeight: 1.4,
            }}
          >
            {shot.sub}
          </div>
        ) : null}
      </div>
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD,
          bottom: 168,
        }}
      >
        <CaptionTrack
          text={shot.narration}
          frame={frame}
          durationInFrames={durationInFrames}
        />
      </div>
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD,
          bottom: 84,
        }}
      >
        <Credit text={credit} />
      </div>
    </AbsoluteFill>
  );
};

/** 常规镜头 */
const BodyScene: React.FC<{
  shot: Shot;
  frame: number;
  durationInFrames: number;
  projectTitle: string;
  projectSubject: string;
  stepLabel: string;
  progress: number;
  credit: string;
}> = ({
  shot,
  frame,
  durationInFrames,
  projectTitle,
  projectSubject,
  stepLabel,
  progress,
  credit,
}) => {
  const data = shot.data || [];
  const cards = data.filter((d) => d.kind === 'value' || d.kind === 'judge');
  const notes = data.filter((d) => d.kind === 'note').map((d) => d.value);
  const chains = data.filter((d) => d.kind === 'chain');
  const exams = data.filter((d) => d.kind === 'exam');
  const bullets = [...notes, ...(shot.bullets || [])];

  return (
    <AbsoluteFill style={{background: COLORS.bg}}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          padding: PAD,
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
          fontFamily: FONT,
        }}
      >
        <div style={{position: 'relative', flex: '0 0 auto', paddingBottom: 14}}>
          <TopBar
            title={projectTitle}
            subject={projectSubject}
            stepLabel={stepLabel}
            progress={progress}
          />
        </div>

        <Stage shot={shot} frame={frame} durationInFrames={durationInFrames} />

        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
            overflow: 'hidden',
          }}
        >
          {shot.kind === 'ask' ? (
            <div
              style={{
                flex: '1 1 auto',
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: 20,
              }}
            >
              <ChipRow shot={shot} frame={frame} />
              <AskBlock shot={shot} frame={frame} />
            </div>
          ) : shot.kind === 'chain' ? (
            <>
              <Headline text={shot.headline} frame={frame} />
              <ChipRow shot={shot} frame={frame} />
              <ChainBlock items={chains} frame={frame} />
            </>
          ) : shot.kind === 'end' ? (
            <div
              style={{
                flex: '1 1 auto',
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: 18,
              }}
            >
              <Headline text={shot.headline} frame={frame} />
              <ChipRow shot={shot} frame={frame} />
              <ExamBlock items={exams} frame={frame} />
            </div>
          ) : (
            <>
              <Headline text={shot.headline} frame={frame} />
              <ChipRow shot={shot} frame={frame} />
              {shot.formula && shot.formula !== shot.headline ? (
                <FormulaBar text={shot.formula} frame={frame} delay={8} />
              ) : null}
              <DataCards items={cards} frame={frame} />
              {shot.eq_note ? (
                <div
                  style={{
                    ...enterUp(frame, 16),
                    fontFamily: FONT,
                    fontSize: 24,
                    color: COLORS.inkFaint,
                    fontWeight: 600,
                    lineHeight: 1.4,
                  }}
                >
                  {shot.eq_note}
                </div>
              ) : null}
              <BulletList items={bullets} frame={frame} delay={18} />
            </>
          )}
        </div>

        {shot.kind === 'ask' ? null : (
          <div style={{flex: '0 0 auto'}}>
            <CaptionTrack
              text={shot.narration}
              frame={frame}
              durationInFrames={durationInFrames}
            />
          </div>
        )}
        <div style={{flex: '0 0 auto'}}>
          <Credit text={credit} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Scene: React.FC<{
  shot: Shot;
  index: number;
  durationInFrames: number;
  projectTitle: string;
  projectSubject: string;
  stepLabel: string;
  progress: number;
  credit: string;
}> = ({
  shot,
  index,
  durationInFrames,
  projectTitle,
  projectSubject,
  stepLabel,
  progress,
  credit,
}) => {
  const frame = useCurrentFrame();
  return (
    <ShotFade frame={frame} durationInFrames={durationInFrames}>
      {shot.kind === 'title' ? (
        <TitleScene
          shot={shot}
          frame={frame}
          durationInFrames={durationInFrames}
          credit={credit}
        />
      ) : (
        <BodyScene
          shot={shot}
          frame={frame}
          durationInFrames={durationInFrames}
          projectTitle={projectTitle}
          projectSubject={projectSubject}
          stepLabel={stepLabel}
          progress={progress}
          credit={credit}
        />
      )}
      <span style={{display: 'none'}}>{index}</span>
    </ShotFade>
  );
};
