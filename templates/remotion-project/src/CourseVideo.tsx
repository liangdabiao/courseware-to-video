/**
 * CourseVideo.tsx — 成片主合成
 *
 * 每个镜头一个 Sequence，Sequence 的时长 = 该镜头旁白的实际时长
 * （由 apply_timeline.py 从音频回填），所以画面与旁白天然同步。
 */

import React from 'react';
import {AbsoluteFill, Audio, Series, staticFile} from 'remotion';
import {FPS, framesOf, script, totalFrames} from './script';
import {Scene} from './Scene';
import {COLORS} from './theme';

/** 把 "第 3 步 · 动手演示与读数" 拆成 ("第 3 步", "动手演示与读数") */
const splitNote = (note?: string): [string, string] => {
  if (!note) return ['', ''];
  const m = note.match(/^(第\s*\d+\s*步)\s*[·・:：-]?\s*(.*)$/);
  if (m) return [m[1], m[2]];
  return ['', note];
};

export const CourseVideo: React.FC = () => {
  const shots = script.shots;
  return (
    <AbsoluteFill style={{backgroundColor: COLORS.bg}}>
      <Series>
        {shots.map((shot, i) => {
          const dur = framesOf(shot);
          const [stepPart, rest] = splitNote(shot.note);
          const isWrap = shot.kind === 'chain' || shot.kind === 'end';
          const stepLabel =
            shot.kind === 'title' || isWrap
              ? ''
              : stepPart || `第 ${shot.step + 1} 步`;
          const progress = shots.length > 1 ? i / (shots.length - 1) : 1;
          const chipNote = shot.kind === 'title' ? '' : rest;
          const shotWithNote = {...shot, note: chipNote};

          return (
            <Series.Sequence
              key={shot.id}
              durationInFrames={dur}
              name={`${shot.id} ${shot.kind}`}
            >
              {shot.narration_audio ? (
                <Audio src={staticFile(`audio/${shot.narration_audio}`)} />
              ) : null}
              <Scene
                shot={shotWithNote}
                index={i}
                durationInFrames={dur}
                projectTitle={script.project.title}
                projectSubject={script.project.subject}
                stepLabel={stepLabel}
                progress={progress}
                credit={script.project.credit}
                fps={FPS}
              />
            </Series.Sequence>
          );
        })}
      </Series>
    </AbsoluteFill>
  );
};

export {FPS, totalFrames};
