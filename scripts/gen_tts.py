#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_tts.py — 把 script.json 里每个镜头的旁白合成成 mp3

用法：
    python gen_tts.py script.json --out audio [--voice zh-CN-XiaoyiNeural]
                                 [--rate "+22%"] [--overrides overrides.json]
                                 [--only s03,s07]

要点（都是实测踩出来的）：
  - edge-tts 偶发 NoAudioReceived / 0 字节坏分片 → 重试 3 次，产物 <1KB 视为失败。
  - 裁首尾静音要**双向**（silenceremove → areverse → silenceremove → areverse），
    只裁开头会在结尾留一段死寂。
  - 语速 +22%（中文讲解片的甜区）。太慢拖沓，太快听不清数字。
  - 断点续跑：已存在且时长 > 0.3s 的 mp3 直接跳过。

产出：
    <out>/<shot_id>.mp3
    <out>/_tts_log.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path

try:
    import edge_tts
except ImportError:  # pragma: no cover
    print("缺少 edge-tts：pip install edge-tts", file=sys.stderr)
    raise

# 双向裁静音
TRIM = (
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,"
    "areverse,"
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,"
    "areverse"
)

DEFAULT_VOICE = "zh-CN-XiaoyiNeural"


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True,
                          encoding="utf-8", errors="replace")


def probe_duration(path: Path) -> float:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "csv=p=0", str(path)])
    return float(out.stdout.strip())


def clean(text: str) -> str:
    """TTS 前最后一道清洗：只清朗读会出错的符号。"""
    if not text:
        return ""
    out = text.replace("_", " ")
    out = out.replace("「", "").replace("」", "").replace("『", "").replace("』", "")
    out = out.replace("（", "，").replace("）", "，")
    out = re.sub(r"[，、]{2,}", "，", out)
    out = re.sub(r"\s+", " ", out)
    return out.strip(" ，,、")


async def tts_once(text: str, out: Path, voice: str, rate: str) -> None:
    """带重试的 edge-tts。"""
    last = None
    for attempt in range(3):
        try:
            com = edge_tts.Communicate(text, voice, rate=rate)
            await com.save(str(out))
            if out.exists() and out.stat().st_size > 1000:
                return
            size = out.stat().st_size if out.exists() else 0
            raise RuntimeError(f"TTS 产物过小: {size}B")
        except Exception as exc:  # noqa: BLE001
            last = exc
            await asyncio.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"TTS 三次失败: {text[:24]}… -> {last}") from last


async def synth(text: str, out: Path, voice: str, rate: str) -> float:
    raw = out.with_suffix(".raw.mp3")
    await tts_once(text, raw, voice, rate)
    run(["ffmpeg", "-y", "-i", str(raw), "-af", TRIM,
         "-c:a", "libmp3lame", "-q:a", "2", str(out)])
    raw.unlink(missing_ok=True)
    return probe_duration(out)


async def main_async(args: argparse.Namespace) -> int:
    spec_path = Path(args.script).resolve()
    root = spec_path.parent
    script = json.loads(spec_path.read_text(encoding="utf-8"))
    out_dir = (root / args.out).resolve() if not Path(args.out).is_absolute() else Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    overrides = {}
    if args.overrides:
        op = Path(args.overrides)
        if not op.is_absolute():
            op = root / op
        if op.exists():
            overrides = json.loads(op.read_text(encoding="utf-8"))
    ov_narration = overrides.get("narration", {})

    only = set(x.strip() for x in args.only.split(",") if x.strip()) if args.only else None

    log = []
    total = 0.0
    for shot in script["shots"]:
        sid = shot["id"]
        if only and sid not in only:
            continue
        text = ov_narration.get(sid) or shot.get("narration") or ""
        text = clean(text)
        if not text:
            print(f"  – {sid} 无旁白，跳过")
            continue

        out = out_dir / f"{sid}.mp3"
        if out.exists() and not args.force:
            try:
                dur = probe_duration(out)
                if dur > 0.3:
                    print(f"  = {sid} 已存在 {dur:.2f}s，跳过")
                    log.append({"id": sid, "file": out.name, "dur": round(dur, 3),
                                "text": text, "skipped": True})
                    total += dur
                    continue
            except Exception:  # noqa: BLE001
                pass

        dur = await synth(text, out, args.voice, args.rate)
        print(f"  ✓ {sid} {dur:.2f}s  {text[:34]}…")
        log.append({"id": sid, "file": out.name, "dur": round(dur, 3), "text": text})
        total += dur

    (out_dir / "_tts_log.json").write_text(
        json.dumps({"voice": args.voice, "rate": args.rate, "total_sec": round(total, 2),
                    "items": log}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"\n合计 {total:.1f}s，共 {len(log)} 条")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("script", help="script.json")
    ap.add_argument("--out", default="audio", help="音频输出目录（相对 script.json）")
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--rate", default="+22%")
    ap.add_argument("--overrides", default="", help="overrides.json（人工精修旁白）")
    ap.add_argument("--only", default="", help="只合成这些拍号，逗号分隔")
    ap.add_argument("--force", action="store_true", help="已有音频也重做")
    args = ap.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
