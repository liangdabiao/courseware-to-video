#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
apply_timeline.py — 把音频真实时长回填到 script.json

用法：
    python apply_timeline.py script.json --audio audio [--tail 0.35] [--min 2.2]

每个镜头的时间轴 = 旁白时长 + 尾巴留白。
留白给"讲完最后一句后画面还停一下"，不至于话没说完就切走。

顺带把图片/视频产物的文件名写回 shot.image / shot.clip，
这样 Remotion 侧只要 staticFile('media/' + shot.image) 就能拿到。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, encoding="utf-8", errors="replace")
    return float(out.stdout.strip())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("script")
    ap.add_argument("--audio", default="audio")
    ap.add_argument("--media", default="media")
    ap.add_argument("--tail", type=float, default=0.35, help="讲完后的留白（秒）")
    ap.add_argument("--min", type=float, default=2.2, help="单镜最短时长（秒）")
    args = ap.parse_args()

    spec_path = Path(args.script).resolve()
    root = spec_path.parent
    script = json.loads(spec_path.read_text(encoding="utf-8"))

    audio_dir = Path(args.audio)
    if not audio_dir.is_absolute():
        audio_dir = root / audio_dir
    media_dir = Path(args.media)
    if not media_dir.is_absolute():
        media_dir = root / media_dir

    total = 0.0
    missing = []
    for shot in script["shots"]:
        sid = shot["id"]
        mp3 = audio_dir / f"{sid}.mp3"
        if mp3.exists():
            dur = probe_duration(mp3)
            shot["narration_audio"] = mp3.name
            shot["duration_sec"] = round(max(args.min, dur + args.tail), 3)
        else:
            missing.append(sid)
            shot["narration_audio"] = None
            shot["duration_sec"] = round(args.min, 3)

        # 抓帧产物：静帧优先，其次运动片段
        png = media_dir / f"{sid}.png"
        mp4 = media_dir / f"{sid}.mp4"
        if png.exists():
            shot["image"] = png.name
            shot["clip"] = None
        elif mp4.exists():
            shot["clip"] = mp4.name
            shot["image"] = None
        else:
            shot["image"] = None
            shot["clip"] = None

        # 读数轨（capture_3d.mjs 在录运动片段时采的实时读数曲线）
        # 有了它，讲解层可以放"随画面滚动的数字"。
        track_path = media_dir / "_tracks" / f"{sid}.json"
        if track_path.exists():
            try:
                track = json.loads(track_path.read_text(encoding="utf-8"))
                if track.get("samples"):
                    shot["track"] = track
                else:
                    shot["track"] = None
            except json.JSONDecodeError:
                shot["track"] = None
        else:
            shot["track"] = None

        total += shot["duration_sec"]

    script["project"]["duration_sec"] = round(total, 2)
    spec_path.write_text(json.dumps(script, ensure_ascii=False, indent=2),
                         encoding="utf-8")

    n_track = sum(1 for sh in script["shots"] if sh.get("track"))
    print(f"镜头 {len(script['shots'])} 个，成片约 {total:.1f}s "
          f"({int(total // 60)} 分 {total % 60:.0f} 秒)"
          f"｜动态读数镜 {n_track} 个")
    if missing:
        print(f"⚠ 缺音频 {len(missing)} 个: {', '.join(missing)}")
    else:
        print("音频齐备")
    return 0


if __name__ == "__main__":
    sys.exit(main())
