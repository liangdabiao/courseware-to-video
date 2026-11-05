#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
verify_media.py — 成片体检

用法：
    python verify_media.py 成片.mp4 [--expect-sec 89.1]

查三件事：
  1. 媒体结构：分辨率 / 帧率 / 音视频流是否齐全 / 时长
  2. 时长是否与时间轴一致（差 > 1s 报出来）
  3. **音频波形体检**（最关键，ffprobe 查不出来）：
     提取 wav，按 0.5 s 窗算 RMS，统计有声窗占比，
     并列出所有超过 2 s 的静音段。

为什么要第 3 步：
  音轨损坏（后半段全静音、数千条解码错误）时，
  ffprobe 的时长依然是对的，媒体校验也可能 PASS。
  只有把波形拿出来量，才抓得住。
"""
from __future__ import annotations

import argparse
import array
import json
import math
import subprocess
import sys
import wave
from pathlib import Path


def run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError("命令失败: " + " ".join(cmd) + "\n" + r.stderr[-600:])
    return r.stdout


def probe(path: Path) -> dict:
    out = run(["ffprobe", "-v", "error", "-show_format", "-show_streams",
               "-of", "json", str(path)])
    return json.loads(out)


def wav_windows(path: Path, win: float = 0.5):
    """把音轨解成 wav，按窗算 RMS。返回 (窗口数, 每窗 RMS dBFS)。"""
    wav = path.with_suffix(".verify.wav")
    run(["ffmpeg", "-y", "-i", str(path), "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", str(wav)])
    with wave.open(str(wav), "rb") as w:
        n = w.getnframes()
        sr = w.getframerate()
        raw = w.readframes(n)
    wav.unlink(missing_ok=True)

    data = array.array("h")
    data.frombytes(raw)
    step = int(sr * win)
    rms = []
    for i in range(0, len(data) - step + 1, step):
        s = 0
        for v in data[i:i + step]:
            s += v * v
        r = math.sqrt(s / step) / 32768.0
        rms.append(20 * math.log10(r) if r > 1e-9 else -120.0)
    return len(rms), rms


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--expect-sec", type=float, default=None)
    ap.add_argument("--min-voiced", type=float, default=0.95,
                    help="有声窗占比下限")
    ap.add_argument("--max-silence", type=float, default=2.0,
                    help="允许的最长静音秒数")
    args = ap.parse_args()

    video = Path(args.video).resolve()
    if not video.exists():
        print(f"文件不存在: {video}", file=sys.stderr)
        return 2

    info = probe(video)
    dur = float(info["format"]["duration"])
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)

    print("── 媒体结构 ──")
    ok = True
    if not v:
        print("✗ 没有视频流"); ok = False
    else:
        print(f"  视频 {v['width']}x{v['height']}  {v.get('r_frame_rate', '?')}  {v['codec_name']}")
    if not a:
        print("✗ 没有音频流"); ok = False
    else:
        print(f"  音频 {a['codec_name']}  {a.get('sample_rate')}Hz  {a.get('channels')}ch")
    print(f"  时长 {dur:.2f}s  大小 {video.stat().st_size / 1048576:.1f}MB")

    if args.expect_sec is not None:
        diff = abs(dur - args.expect_sec)
        mark = "✓" if diff <= 1.0 else "✗"
        if diff > 1.0:
            ok = False
        print(f"  预期 {args.expect_sec:.2f}s，差 {diff:.2f}s {mark}")

    print("\n── 音频波形体检 ──")
    n, rms = wav_windows(video)
    thr = -45.0
    voiced = [i for i, r in enumerate(rms) if r > thr]
    ratio = len(voiced) / max(1, n)
    # 连续静音段
    silences = []
    run_len = 0
    for i, r in enumerate(rms):
        if r <= thr:
            run_len += 1
        else:
            if run_len:
                silences.append((i - run_len, run_len))
            run_len = 0
    if run_len:
        silences.append((n - run_len, run_len))
    long_sil = [(s, c * 0.5) for s, c in silences if c * 0.5 > args.max_silence]

    print(f"  0.5s 窗 {n} 个，有声 {len(voiced)} 个，占比 {ratio * 100:.1f}%"
          f"（下限 {args.min_voiced * 100:.0f}%）")
    mark = "✓" if ratio >= args.min_voiced else "✗"
    if ratio < args.min_voiced:
        ok = False
    print(f"  {mark}")
    if silences:
        print(f"  静音段 {len(silences)} 处："
              + ", ".join(f"{s * 0.5:.1f}s起{c * 0.5:.1f}s" for s, c in silences[:12])
              + ("…" if len(silences) > 12 else ""))
    if long_sil:
        print(f"  ✗ 超过 {args.max_silence}s 的静音 {len(long_sil)} 处："
              + ", ".join(f"{s * 0.5:.1f}s起{c:.1f}s" for s, c in long_sil[:12]))
        ok = False
    else:
        print(f"  ✓ 没有超过 {args.max_silence}s 的静音")

    print("\n" + ("✅ PASS" if ok else "❌ FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
