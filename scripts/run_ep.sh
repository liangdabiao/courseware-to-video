#!/usr/bin/env bash
# run_ep.sh — 一键把一个课件跑成短视频
#
# 用法：
#   bash run_ep.sh <课件.html> <slug> [工作目录]
#
# 例：
#   bash run_ep.sh /path/to/river-step.html river-step /path/to/work
#
# 脚本路径全部由脚本自身位置推导，clone 到任何机器都能直接跑。
set -e

HTML="${1:?用法: run_ep.sh <课件.html> <slug> [工作目录]}"
SLUG="${2:?用法: run_ep.sh <课件.html> <slug> [工作目录]}"
WORK="${3:-}"

# 脚本自身位置 → 仓库根（scripts/ 的上一级）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPTS="$ROOT/scripts"
TPL="$ROOT/templates/remotion-project"

if [ -z "$WORK" ]; then
  WORK="$ROOT/../_work/$SLUG"
fi

if [ ! -f "$HTML" ]; then
  echo "找不到课件：$HTML" >&2
  exit 1
fi

mkdir -p "$WORK"
cd "$WORK"

echo "=== 1/6 抽取教案 ==="
node "$SCRIPTS/extract_course.mjs" "$HTML" --out course.json

echo "=== 2/6 规划镜头与讲稿 ==="
python "$SCRIPTS/plan_shots.py" --course course.json --out script.json \
     --script-md 讲稿.md --profile core

echo "=== 3/6 抓 3D 画面 ==="
node "$SCRIPTS/capture_3d.mjs" --script script.json --out media \
     --width 1200 --height 800 --html "$HTML"

echo "=== 4/6 合成旁白 ==="
python "$SCRIPTS/gen_tts.py" script.json --out audio --overrides overrides.json

echo "=== 5/6 回填时间轴 ==="
python "$SCRIPTS/apply_timeline.py" script.json --audio audio --media media

echo "=== 6/6 组装并渲染 ==="
python "$SCRIPTS/build_project.py" --script script.json --project "build/$SLUG"
cd "build/$SLUG"
npx remotion render src/index.ts CourseVideo out/course.mp4 \
     --codec=h264 --crf=18 --pixel-format=yuv420p --concurrency=1

echo
python "$SCRIPTS/verify_media.py" "build/$SLUG/out/course.mp4"

echo "完成：$WORK/build/$SLUG/out/course.mp4"
