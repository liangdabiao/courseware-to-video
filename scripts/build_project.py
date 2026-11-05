#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_project.py — 组装 Remotion 渲染工程

用法：
    python build_project.py --script script.json --project build/river-step

做的事：
  1. 把 templates/remotion-project 的源码/配置复制到工作目录
     （node_modules 不复制，用目录联接 junction 指回模板，省磁盘和时间）
  2. media/ → public/media，audio/ → public/audio，字体 → public/fonts
  3. script.json → 工程根目录（src/script.ts 从 '../script.json' 读）

node_modules 用 junction 的原因：模板里已经装好了 remotion 4.0.487，
每个项目都拷一份几百 MB 太浪费；junction 在 Windows 上不需要管理员权限。
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

COPY_FILES = ["package.json", "remotion.config.ts", "tsconfig.json"]


def copy_tree(src: Path, dst: Path, skip: set[str] | None = None) -> None:
    skip = skip or set()
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name in skip:
            continue
        target = dst / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)


def link_or_copy(src: Path, dst: Path) -> str:
    """优先建目录联接（junction），失败就退回复制。"""
    if dst.exists() or dst.is_symlink():
        return "已存在"
    if sys.platform.startswith("win"):
        r = subprocess.run(["cmd", "/c", "mklink", "/J", str(dst), str(src)],
                           capture_output=True, encoding="utf-8", errors="replace")
        if r.returncode == 0:
            return "junction"
    shutil.copytree(src, dst)
    return "复制"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True)
    ap.add_argument("--project", required=True)
    ap.add_argument("--template", default="")
    ap.add_argument("--media", default="media")
    ap.add_argument("--audio", default="audio")
    args = ap.parse_args()

    here = Path(__file__).resolve().parent
    template = Path(args.template).resolve() if args.template else \
        here.parent / "templates" / "remotion-project"
    if not (template / "src").exists():
        print(f"模板不存在: {template}", file=sys.stderr)
        return 2

    spec_path = Path(args.script).resolve()
    root = spec_path.parent
    proj = Path(args.project)
    if not proj.is_absolute():
        proj = root / proj
    proj.mkdir(parents=True, exist_ok=True)

    # 1) 源码与配置
    copy_tree(template / "src", proj / "src")
    for f in COPY_FILES:
        if (template / f).exists():
            shutil.copy2(template / f, proj / f)
    fonts = template / "public" / "fonts"
    if fonts.exists():
        (proj / "public" / "fonts").mkdir(parents=True, exist_ok=True)
        copy_tree(fonts, proj / "public" / "fonts")

    # 2) node_modules
    mode = link_or_copy(template / "node_modules", proj / "node_modules")

    # 3) 素材
    media_dir = root / args.media
    audio_dir = root / args.audio
    for src, sub in ((media_dir, "media"), (audio_dir, "audio")):
        dst = proj / "public" / sub
        dst.mkdir(parents=True, exist_ok=True)
        if src.exists():
            for f in src.iterdir():
                # 只收真正的素材文件，别把中间产物（日志、帧目录）带进 public/
                if f.is_file() and f.suffix.lower() in (".png", ".jpg", ".jpeg", ".mp4", ".mp3", ".wav", ".m4a"):
                    shutil.copy2(f, dst / f.name)
            n = len([f for f in dst.iterdir() if f.is_file()])
            print(f"  {sub}: {n} 个文件")
        else:
            print(f"  ⚠ 找不到 {src}")

    # 4) script.json
    shutil.copy2(spec_path, proj / "script.json")

    script = json.loads(spec_path.read_text(encoding="utf-8"))
    shots = len(script.get("shots", []))
    print(f"\n工程已就绪: {proj}")
    print(f"  node_modules: {mode}")
    print(f"  镜头 {shots} 个 / 画幅 {script['project']['width']}x{script['project']['height']}")
    print(f"\n下一步：")
    print(f"  cd \"{proj}\" && npx remotion render src/index.ts CourseVideo out/course.mp4 "
          f"--codec=h264 --crf=18 --pixel-format=yuv420p --concurrency=1")
    return 0


if __name__ == "__main__":
    sys.exit(main())
