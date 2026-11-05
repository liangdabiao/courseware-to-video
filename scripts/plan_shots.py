# -*- coding: utf-8 -*-
"""
plan_shots.py — 把课件教案编排成镜头脚本

用法：
  python plan_shots.py --course course.json --out script.json [--profile core|full]
                       [--overrides overrides.json]

输入 course.json（由 extract_course.mjs 产出）：
  meta / mainline{q,chain[]} / units[] / steps[]{q,act,expect,points,concl,exam,eq}

输出：
  script.json  镜头脚本（给 capture_3d.mjs + Remotion 用）
  讲稿.md      逐拍讲稿表格（先稿后片：讲稿是第一交付物）

编排原则（见 references/teaching-script.md）：
  1. 先稿后片：讲稿先写出来，自检通过再抓画面。
  2. 问题驱动：开场用 mainline.q 悬念；每一步由课件自己的 q 引出，**先问再答**；
     结尾回扣开场的问题。
  3. 覆盖度优先：课件的 points / expect / eq / exam 全部要上屏，
     不因为"不好表现"就漏讲（多点用要点条 sweep 掉，不占整拍）。
  4. 用真数字：expect.text 里的实测数值必须原样出现在数据卡上，不能只说"很快"。
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

# --------------------------------------------------------------------------
# 单位：TTS 不能直接读 "m/s"（会读成字母），必须换成中文单位
# 顺序有意义：长单位在前，避免 "m³/s" 被 "m" 先吃掉
# --------------------------------------------------------------------------
UNIT_TTS = [
    ("m³/s", "立方米每秒"),
    ("m^3/s", "立方米每秒"),
    ("mm/s", "毫米每秒"),
    ("cm/s", "厘米每秒"),
    ("km/h", "千米每小时"),
    ("m³", "立方米"),
    ("cm³", "立方厘米"),
    ("m/s", "米每秒"),
    ("km", "千米"),
    ("mm", "毫米"),
    ("cm", "厘米"),
    ("m", "米"),
]

NUM_UNIT = r"(?:m³/s|m\^3/s|mm/s|cm/s|km/h|m/s|m³|cm³|km|mm|cm|m|s|%)"
NUM_RE = re.compile(rf"([0-9]+(?:\.[0-9]+)?)\s*({NUM_UNIT})?")


# --------------------------------------------------------------------------
# 文本规范化
# --------------------------------------------------------------------------

def units_to_speech(text: str) -> str:
    """把单位符号换成 TTS 能读的中文。"""
    if not text:
        return ""
    out = text
    for a, b in UNIT_TTS:
        out = out.replace(a, b)
    return out


def clean_for_tts(text: str) -> str:
    """旁白文本清洗：去掉朗读会出错的符号、括号注、参考资料页码。"""
    if not text:
        return ""
    out = text
    out = out.replace("_", " ")                       # 下划线不读
    out = re.sub(r"[（(](?:示意|教材[^）)]*|图[^）)]*|对照[^）)]*)[）)]", "", out)
    out = out.replace("「", "").replace("」", "").replace("『", "").replace("』", "")
    out = out.replace("×", "乘以").replace("÷", "除以")
    out = out.replace("≤", "小于等于").replace("≥", "大于等于")
    out = out.replace("＝", "等于").replace("→", "到").replace("->", "到")
    out = out.replace("·", "，").replace("～", "到").replace("~", "到")
    out = out.replace("<", "小于").replace(">", "大于")
    out = re.sub(r"\bD_max\b", "最大粒径", out)
    out = re.sub(r"\s+", " ", out)
    out = re.sub(r"[，、]{2,}", "，", out)
    out = out.strip(" ，,、")
    return out


def clean_for_screen(text: str) -> str:
    """上屏文本清洗：只去首尾空白，保留符号与单位原样（数字要能被核对）。"""
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()


# --------------------------------------------------------------------------
# expect.text → 数据卡条目
# --------------------------------------------------------------------------

def _label_tail(text: str) -> tuple[str, str]:
    """把标签尾巴（如"的卵石"）并到标签上。"""
    return text


def parse_expect(text: str) -> list[dict]:
    """把 expect.text 拆成可上屏的数据条目。

    例："流速 3.38 m/s；能搬动 152.0 mm 的卵石；冲淤判据＝「以向下侵蚀为主」"
      → [{label:'流速', value:'3.38 m/s'},
         {label:'能搬动的卵石', value:'152.0 mm'},
         {label:'冲淤判据', value:'以向下侵蚀为主'}]

    每条带 raw（原始片段），旁白直接用 raw 念，避免把标签拼成病句。
    """
    items: list[dict] = []
    if not text:
        return items

    def strip_lead(t: str) -> str:
        t = t.strip(" 　,，、")
        t = re.sub(r"^或", "", t)
        return t.strip()

    # 数值之间的间隔：只允许单位 + 箭头类词，不允许夹中文散文
    # （这样 "5 s 汛期来了 → 11.9 mm" 不会被误判成数值链）
    GAP = re.compile(
        r"^\s*(?:m³/s|mm|cm|km|m|s|%|ms)?\s*"
        r"(?:→|->|推进到|增加到|减少到|降到|升到|变成|到)?\s*"
        r"(?:m³/s|mm|cm|km|m|s|%|ms)?\s*$"
    )
    ARROW_WORDS = re.compile(r"推进到|增加到|减少到|降到|升到|变成|→|->|到")

    def parse_segment(seg: str) -> list[dict]:
        seg = clean_for_screen(seg)
        if not seg:
            return []

        # 判据式："冲淤判据＝「以向下侵蚀为主」"
        m = re.match(r"^(.+?)\s*[＝=]\s*[「『\"']?(.+?)[」』\"']?$", seg)
        if m and not re.search(r"\d", m.group(2)):
            return [{"label": clean_for_screen(m.group(1)),
                     "value": clean_for_screen(m.group(2)),
                     "kind": "judge", "raw": seg}]

        matches = list(NUM_RE.finditer(seg))

        has_arrow = bool(ARROW_WORDS.search(seg))

        # 箭头 + 多个数值：判断是不是"数值链"（10 → 60 → 200）
        if has_arrow and len(matches) >= 2:
            gaps_ok = all(
                GAP.match(seg[matches[i].end(): matches[i + 1].start()])
                for i in range(len(matches) - 1)
            )
            if gaps_ok:
                label = clean_for_screen(seg[: matches[0].start()])
                span = seg[matches[0].start(): matches[-1].end()]
                value = ARROW_WORDS.sub("→", span)
                value = re.sub(r"\s*→\s*", " → ", value).strip()
                label = re.sub(r"[从上中的里]$", "", label).strip() or "数值"
                return [{"label": label, "value": value,
                         "kind": "value", "raw": seg}]

        # 箭头 + 单个数值："动作 → 结果"
        if "→" in seg:
            left, right = seg.rsplit("→", 1)
            right = right.strip()
            label = strip_lead(left)
            value = right
            tail_m = re.match(r"^(.*?)(\s*[（(][^）)]*[）)])\s*$", right)
            if tail_m:
                value = tail_m.group(1).strip()
                tail = tail_m.group(2).strip()
            else:
                tail = ""
            if not label:
                label = "结果"
            if tail:
                value = f"{value} {tail}"
            return [{"label": label, "value": value, "kind": "value", "raw": seg}]

        if not matches:
            return [{"label": "", "value": seg, "kind": "note", "raw": seg}]

        first, last = matches[0], matches[-1]
        label = clean_for_screen(seg[: first.start()])
        tail = clean_for_screen(seg[last.end():])

        value = clean_for_screen(seg[first.start(): last.end()])

        if tail:
            if tail.startswith("的"):
                label = (label + tail).replace(" 的", "的")
            else:
                value = f"{value} {tail}"

        label = re.sub(r"[从上中的里]$", "", label).strip()
        if not label:
            label = "数值"
        return [{"label": label, "value": value, "kind": "value", "raw": seg}]

    for seg in re.split(r"[；;]", text):
        seg = clean_for_screen(seg)
        if not seg:
            continue

        # 一句里多个箭头且有逗号 → 拆成多条
        # （例："推到老年期 → 8.1 mm，或调来水量 → 7.8 mm"）
        if seg.count("→") >= 2 and re.search(r"[，,]", seg):
            subs = [x for x in re.split(r"[，,]", seg) if x.strip()]
            if len(subs) > 1:
                for sub in subs:
                    items.extend(parse_segment(sub))
                continue

        items.extend(parse_segment(seg))

    return items


def speak_item(item: dict) -> str:
    """数据条目 → 能直接念的一句话（优先用原始片段，避免拼成病句）。"""
    raw = item.get("raw")
    if raw:
        return clean_for_tts(raw)
    label = item.get("label", "")
    value = item.get("value", "")
    if not label:
        return clean_for_tts(value)
    return clean_for_tts(f"{label}是{value}")


def pick_evidence(items: list[dict]) -> dict | None:
    """挑一条最适合做旁白证据的数据（要带数字）。"""
    for it in items:
        if it.get("kind") == "value" and re.search(r"\d", it.get("value", "")):
            return it
    for it in items:
        if it.get("kind") == "judge":
            return it
    return None


def split_cards(items: list[dict], limit: int = 3) -> list[dict]:
    """挑出适合做成数据卡的条目：优先带数字的，其次判据，最后备注。"""
    scored = []
    for idx, it in enumerate(items):
        k = it.get("kind")
        rank = {"value": 0, "judge": 1, "note": 2, "unit": 3, "chain": 4, "exam": 5}.get(k, 6)
        scored.append((rank, idx, it))
    scored.sort(key=lambda x: (x[0], x[1]))
    picked = [it for _, _, it in scored[:limit]]
    # 恢复原顺序，读起来更自然
    order = {id(it): i for i, it in enumerate(items)}
    picked.sort(key=lambda it: order[id(it)])
    return picked


def overflow_notes(items: list[dict], limit: int = 3) -> list[str]:
    """没进数据卡但带数字的条目 → 转成要点条，保证数值不丢。"""
    kept = {id(x) for x in split_cards(items)}
    out = []
    for it in items:
        if id(it) in kept:
            continue
        if it.get("kind") == "note":
            continue
        v = it.get("value", "")
        if re.search(r"\d", v):
            label = it.get("label", "")
            txt = f"{label} {v}".strip() if label else v
            out.append(re.sub(r"^或", "", txt).strip())
        if len(out) >= limit:
            break
    return out


def first_sentence(text: str) -> str:
    if not text:
        return ""
    parts = re.split(r"(?<=[。！？])", text)
    for p in parts:
        if p.strip():
            return p.strip()
    return text.strip()


# --------------------------------------------------------------------------
# 镜头生成
# --------------------------------------------------------------------------

K_TITLE, K_ASK, K_ANSWER, K_CONCL, K_CHAIN, K_END = (
    "title", "ask", "answer", "concl", "chain", "end",
)


def unit_of(step: dict, units: list[dict]) -> dict | None:
    u = step.get("unit")
    if u is None or u == "" or u == -1:
        return None
    if isinstance(u, str):
        try:
            u = int(u)
        except ValueError:
            return None
    return units[u] if 0 <= u < len(units) else None


def build_capture_actions(step: dict, mode: str, ov: dict) -> list[dict]:
    """把课件的 act 翻译成抓画面时执行的动作。"""
    act = step.get("act") or {}
    kind = act.get("kind")
    key = act.get("key")
    demo = act.get("demo")

    custom = (ov.get("actions") or {}).get(str(step["index"]))
    if custom:
        return custom

    if kind == "slider" and key is not None:
        to = demo if demo is not None else act.get("to")
        if to is None:
            return []
        if mode == "motion":
            return [{"type": "tween", "key": key, "to": to, "seconds": 1.8}]
        return [{"type": "set", "key": key, "value": to}]
    if kind == "toggle" and key is not None:
        return [{"type": "toggle", "key": key}]
    if kind == "switch" and key is not None:
        return [{"type": "switch", "key": key, "value": demo if demo is not None else True}]
    if kind == "orbit":
        return [{"type": "orbit", "seconds": 4.0}] if mode == "motion" else []
    if kind == "custom":
        return [{"type": "demo"}]
    return []


def make_headline(step: dict, items: list[dict]) -> str:
    """大字：优先用 expect 里的"冲淤判据"（那才是这一步的教学结论），
    其次用 eq 公式，最后退回 points[0] 的前半句。"""
    for it in items:
        if it.get("kind") == "judge":
            return it["value"]
    eq = clean_for_screen(step.get("eq") or "")
    if eq:
        return eq
    pts = step.get("points") or []
    if pts:
        return clip_sentence(pts[0].split("——")[0].split("。")[0], 20)
    return clean_for_screen(step.get("tag", ""))


def clip_sentence(sent: str, max_len: int) -> str:
    if not sent:
        return ""
    s = sent.strip()
    if len(s) <= max_len:
        return s
    cut = s[:max_len]
    for mark in ("；", "。", "，", "、"):
        idx = cut.rfind(mark)
        if idx > max_len * 0.45:
            return cut[: idx + 1].rstrip("，、")
    return cut


def answer_narration(step: dict, items: list[dict], ov: dict) -> str:
    custom = (ov.get("narration") or {}).get(f"answer_{step['index']}")
    if custom:
        return clean_for_tts(custom)
    pts = step.get("points") or []
    reason = first_sentence(pts[0]) if pts else ""
    ev = pick_evidence(items)
    evidence = speak_item(ev) if ev else ""
    # 证据里的数字如果已经在 reason 里出现，就不重复
    if reason and evidence:
        nums = set(re.findall(r"[0-9]+(?:\.[0-9]+)?", reason))
        if nums and all(n in nums for n in re.findall(r"[0-9]+(?:\.[0-9]+)?", evidence)):
            evidence = ""
    text = "。".join(x for x in [reason.rstrip("。"), evidence.rstrip("。")] if x) + "。"
    if not text.strip("。"):
        text = step.get("concl") or ""
    return clean_for_tts(clip_sentence(text, 48))


def concl_narration(step: dict, ov: dict) -> str:
    custom = (ov.get("narration") or {}).get(f"concl_{step['index']}")
    if custom:
        return clean_for_tts(custom)
    concl = step.get("concl") or ""
    exam = re.sub(r"^考点[：:]\s*", "", step.get("exam") or "")
    text = "。".join(x for x in [concl.rstrip("。"), exam.rstrip("。")] if x) + "。"
    return clean_for_tts(clip_sentence(text, 48))


def plan(course: dict, profile: str = "core", overrides: dict | None = None) -> dict:
    ov = overrides or {}
    meta = course.get("meta") or {}
    mainline = course.get("mainline") or {}
    units = course.get("units") or []
    steps = course.get("steps") or []

    shots: list[dict] = []

    def add(**kw):
        kw.setdefault("id", f"s{len(shots) + 1:02d}")
        shots.append(kw)

    # ---------------- 开场：悬念 ----------------
    title_q = clean_for_screen(mainline.get("q") or "")
    hook = (ov.get("narration") or {}).get("title")
    if not hook:
        hook = f"{title_q}先别急着背结论，我们从这块沙盘开始，一段一段把它挖出来。"
    add(
        kind=K_TITLE, step=0,
        narration=clean_for_tts(hook),
        headline=clean_for_screen(meta.get("title", "")),
        sub=" · ".join(x for x in [meta.get("subject", ""), meta.get("locate", "")] if x),
        q=title_q,
        badge=clean_for_screen(meta.get("type", "")),
        data=[], formula="", bullets=[],
        capture={"step": 0, "mode": "still", "actions": [], "settle_ms": 1400},
        note="开场：主线悬念",
    )

    # ---------------- 每一步 ----------------
    content_steps = [s for s in steps if s.get("q") or s.get("tag")]
    for step in content_steps:
        i = step["index"]
        u = unit_of(step, units)
        tag = clean_for_screen(step.get("tag", ""))
        q = clean_for_screen(step.get("q") or "")
        exp = step.get("expect")
        exp_text = exp.get("text", "") if isinstance(exp, dict) else (exp or "")
        items = parse_expect(exp_text)

        # -- 提问卡 --
        add(
            kind=K_ASK, step=i,
            narration=clean_for_tts((ov.get("narration") or {}).get(f"ask_{i}", q)),
            headline=q,
            sub=clean_for_screen(u.get("brief", "")) if u else "",
            badge=tag,
            unit_no=clean_for_screen(u.get("no", "")) if u else "",
            data=([{"label": "", "value": u.get("name", ""), "kind": "unit"}] if u else []),
            formula="", bullets=[],
            capture={"step": i, "mode": "still",
                     "actions": build_capture_actions(step, "still", ov),
                     "settle_ms": 1200},
            note=f"第 {i + 1} 步 · 提问",
        )

        # -- 答案卡：动手演示 + 真数字 --
        pts = step.get("points") or []
        add(
            kind=K_ANSWER, step=i,
            narration=answer_narration(step, items, ov),
            headline=make_headline(step, items),
            sub=clean_for_screen((step.get("act") or {}).get("text", "")),
            badge=tag,
            unit_no=clean_for_screen(u.get("no", "")) if u else "",
            data=split_cards(items),
            formula=clean_for_screen(step.get("eq") or ""),
            eq_note=clean_for_screen(step.get("eqCal") or ""),
            bullets=(overflow_notes(items)
                     + [clean_for_screen(p) for p in pts[1:3]]),
            capture={"step": i, "mode": "motion",
                     "actions": build_capture_actions(step, "motion", ov),
                     "motion_ms": 3600, "settle_ms": 1000},
            note=f"第 {i + 1} 步 · 动手演示与读数",
        )

        # -- 结论卡（full profile） --
        if profile == "full":
            add(
                kind=K_CONCL, step=i,
                narration=concl_narration(step, ov),
                headline=make_headline(step, items),
                sub=clean_for_screen(step.get("concl", "")),
                badge=tag,
                unit_no=clean_for_screen(u.get("no", "")) if u else "",
                data=[],
                formula=clean_for_screen(step.get("eq") or ""),
                eq_note=clean_for_screen(step.get("exam") or ""),
                bullets=[],
                capture={"step": i, "mode": "still",
                         "actions": build_capture_actions(step, "still", ov),
                         "settle_ms": 1200},
                note=f"第 {i + 1} 步 · 结论与考点",
            )

    # ---------------- 因果链回扣 ----------------
    chain = [
        {"k": clean_for_screen(c.get("k", "")), "t": clean_for_screen(c.get("t", ""))}
        for c in (mainline.get("chain") or [])
    ]
    chain_hook = (ov.get("narration") or {}).get("chain")
    if not chain_hook:
        if chain:
            chain_hook = "把这几步串成一条链：" + "、".join(c["k"] for c in chain) + "，一环扣一环。"
        else:
            chain_hook = "把这几步串起来看。"
    add(
        kind=K_CHAIN, step=0,
        narration=clean_for_tts(chain_hook),
        headline="一条因果链",
        sub=clean_for_screen((ov.get("end_sub") or "")),
        badge="串联",
        data=[{"label": c["k"], "value": c["t"], "kind": "chain"} for c in chain],
        formula="", bullets=[],
        capture={"step": 0, "mode": "still", "actions": [], "settle_ms": 1200},
        note="收尾：因果链回扣",
    )

    # ---------------- 结尾 ----------------
    last = content_steps[-1] if content_steps else {}
    exam_bits = [
        clean_for_screen(re.sub(r"^考点[：:]\s*", "", s.get("exam", "")))
        for s in content_steps if s.get("exam")
    ]
    end_hook = (ov.get("narration") or {}).get("end")
    if not end_hook:
        end_hook = "考点就这几个，能用读数判断，才算真会了。"
    add(
        kind=K_END, step=0,
        narration=clean_for_tts(end_hook),
        headline=clean_for_screen(ov.get("end_headline") or "本节考点"),
        sub=clean_for_screen(ov.get("end_sub") or ""),
        badge="完",
        data=[{"label": "", "value": e, "kind": "exam"} for e in exam_bits[:4]],
        formula="", bullets=[],
        capture={"step": 0, "mode": "still", "actions": [], "settle_ms": 1200},
        note="结尾：考点清单",
    )

    project = {
        "title": clean_for_screen(meta.get("title", "")),
        "subject": clean_for_screen(meta.get("subject", "")),
        "slug": clean_for_screen(meta.get("slug", "")),
        "locate": clean_for_screen(meta.get("locate", "")),
        "width": 1080,
        "height": 1920,
        "fps": 30,
        "credit": ov.get("credit") or "铜匠实验室 lab.tongjiang.app · CC BY-NC 4.0",
        "source_html": course.get("source_html", ""),
    }
    return {"project": project, "shots": shots}


# --------------------------------------------------------------------------
# 讲稿（先稿后片的第一交付物）
# --------------------------------------------------------------------------

def write_script_md(script: dict, path: Path) -> None:
    p = script["project"]
    lines = [
        f"# {p['title']} · 短视频讲稿",
        "",
        f"- 课件：`{p.get('source_html','')}`",
        f"- 画幅：{p['width']}×{p['height']} @ {p['fps']}fps",
        f"- 镜头数：{len(script['shots'])}",
        f"- 署名：{p['credit']}",
        "",
        "## 逐拍讲稿",
        "",
        "| 拍号 | 画面 | 旁白逐字稿 |",
        "|---|---|---|",
    ]
    for sh in script["shots"]:
        v = sh.get("note", "")
        v += "（3D 演示运动）" if sh.get("capture", {}).get("mode") == "motion" else "（3D 静帧）"
        if sh.get("headline"):
            v += f"／大字：{sh['headline']}"
        if sh.get("data"):
            d = "；".join(
                (f"{x.get('label','')} {x.get('value','')}".strip() if x.get("label")
                 else x.get("value", ""))
                for x in sh["data"]
            )
            v += f"／数据卡：{d}"
        if sh.get("formula"):
            v += f"／公式：{sh['formula']}"
        if sh.get("bullets"):
            v += "／要点：" + "；".join(sh["bullets"])
        lines.append(f"| {sh['id']} | {v} | {sh.get('narration','')} |")

    lines += [
        "", "## 讲稿自检", "", "```",
        "1. 覆盖度：steps[].points / expect / eq / exam 是否全部上屏",
        "2. 准确性：expect 里的数值是否原样出现（数据卡不改数）",
        "3. 问题链：开场有问题；每步先问再答；结尾回扣",
        "4. 节奏：单拍旁白 ≤50 字",
        "5. 署名：CC BY-NC 4.0 署名是否在片尾",
        "```", "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def self_check(script: dict, course: dict | None = None) -> list[str]:
    """讲稿自检：把硬性规则跑一遍，有问题就报出来。"""
    issues: list[str] = []
    shots = script["shots"]
    for sh in shots:
        n = len(sh.get("narration", ""))
        if n > 50:
            issues.append(f"{sh['id']} 旁白 {n} 字，超过 50 字上限")
        if not sh.get("narration", "").strip():
            issues.append(f"{sh['id']} 没有旁白")
        if "_" in sh.get("narration", ""):
            issues.append(f"{sh['id']} 旁白含下划线，TTS 会读错")
    kinds = {s["kind"] for s in shots}
    if K_TITLE not in kinds:
        issues.append("缺少开场悬念卡")
    if K_CHAIN not in kinds:
        issues.append("缺少因果链回扣卡")

    # 覆盖度：课件里每个数值都要在数据卡里出现
    if course:
        shown = " ".join(
            " ".join(
                [str(x.get("label", "")) + " " + str(x.get("value", ""))
                 for x in sh.get("data", [])]
                + [str(b) for b in sh.get("bullets", [])]
            )
            for sh in shots
        ) + " " + " ".join(
            str(sh.get("formula", "")) + " " + str(sh.get("eq_note", ""))
            for sh in shots
        )
        for st in course.get("steps", []):
            exp = st.get("expect")
            txt = exp.get("text", "") if isinstance(exp, dict) else (exp or "")
            for num in re.findall(r"[0-9]+(?:\.[0-9]+)?", txt):
                if num not in shown:
                    issues.append(f"第 {st['index']} 步的数值 {num} 没有上屏")
    return issues


def main() -> None:
    ap = argparse.ArgumentParser(description="把课件教案编排成镜头脚本")
    ap.add_argument("--course", required=True, help="course.json")
    ap.add_argument("--out", required=True, help="script.json 输出路径")
    ap.add_argument("--script-md", default=None, help="讲稿.md 输出路径（默认与 out 同目录）")
    ap.add_argument("--profile", choices=["core", "full"], default="core")
    ap.add_argument("--overrides", default=None, help="人工微调 overrides.json")
    args = ap.parse_args()

    course = json.loads(Path(args.course).read_text(encoding="utf-8"))
    ov = {}
    if args.overrides and Path(args.overrides).exists():
        ov = json.loads(Path(args.overrides).read_text(encoding="utf-8"))

    script = plan(course, args.profile, ov)
    out = Path(args.out)
    out.write_text(json.dumps(script, ensure_ascii=False, indent=2), encoding="utf-8")

    md = Path(args.script_md) if args.script_md else out.with_name("讲稿.md")
    write_script_md(script, md)

    issues = self_check(script, course)
    print(f"镜头数: {len(script['shots'])}")
    for sh in script["shots"]:
        print(f"  {sh['id']} {sh['kind']:<7} step={sh['step']:<2} "
              f"{len(sh.get('narration','')):>2}字  {sh.get('headline','')[:28]}")
    print()
    print(f"→ {out}")
    print(f"→ {md}")
    if issues:
        print("\n⚠ 自检发现问题:")
        for i in issues:
            print("  -", i)
    else:
        print("\n✓ 讲稿自检通过")


if __name__ == "__main__":
    main()
