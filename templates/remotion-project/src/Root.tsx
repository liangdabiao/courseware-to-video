import React from 'react';
import {Composition} from 'remotion';
import {CourseVideo} from './CourseVideo';
import {FPS, script, totalFrames} from './script';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CourseVideo"
      component={CourseVideo}
      durationInFrames={totalFrames}
      fps={FPS}
      width={script.project.width}
      height={script.project.height}
    />
  );
};
