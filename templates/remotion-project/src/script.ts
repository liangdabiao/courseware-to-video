import rawScript from '../script.json';
import type {Script} from './types';

export const script = rawScript as unknown as Script;

export const FPS = script.project.fps ?? 30;

/** 每个镜头的帧数。优先用 apply_timeline 回填的 duration_sec。 */
export const framesOf = (shot: Script['shots'][number]): number =>
  Math.max(1, Math.round((shot.duration_sec ?? 4) * FPS));

export const totalFrames = script.shots.reduce(
  (sum, shot) => sum + framesOf(shot),
  0,
);

/** 镜头在成片里的起始帧。 */
export const offsets = script.shots.reduce<number[]>((acc, shot, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + framesOf(script.shots[i - 1]));
  return acc;
}, []);
