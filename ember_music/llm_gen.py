"""
LLM 音乐生成主逻辑（v5 提示词工程完整落地）

流程：
  Stage 1 (蓝图)      — 1 次 LLM 调用：title/key/chord_timeline/motif/instruments/dynamics_curve
  Stage 2 (4 声部并行) — 4 次 LLM 调用：lead / harmony / bass / decoration
  规则补两声部        — 用 primitives 的 make_pad + make_arpeggio 按 chord_timeline 铺 pad + arp
  GM → 白名单音色映射
  返回 song dict（交给 synth.synth_song 渲染）

产品决策（已锁定，见 handoff）：
  - 只用 gpt-4o（mini 密度不达标）
  - 只用 ember_music.synth.ALLOWED_TIMBRES 里的 11 种音色
  - 全曲 15 秒纯乐器无环境音
"""
import json
import time
import concurrent.futures as cf
from typing import Optional

from openai import OpenAI

from .synth import ALLOWED_TIMBRES, DURATION
from .primitives import make_pad, make_arpeggio, _note
from .config import API_KEY, BASE_URL, MODEL, LLM_CALL_TIMEOUT_SEC, PRICING


# ==================== 情绪配方（喂给 Stage 1 prompt） ====================
# 与 mapping.py::EMOTION_RECIPE 是分工的：那份给人类和未来产品文案看，
# 这份是 LLM 硬约束（GM 号 / BPM 数值 / velocity 数值）。

_LLM_RECIPE = {
    "愤怒": {"mode": "小调（A minor / D minor / E minor）",
             "bpm": [130, 110, 80],
             "instr_lead": [42], "instr_harmony": [0, 24], "instr_bass": [43],
             "instr_decoration": [40, 41],
             "chord_style": "小调力量进行 i-VII-VI-V 或 i-iv-VI-V",
             "melody_char": "前段强重音+切分+下行动机；后段级进上行走向和缓",
             "rhythm_flavor": "前段【切分强击】【快速十六】；后段【叹息型】【长音+装饰】",
             "dynamics": {"attack": 105, "release": 55}},
    "悲伤": {"mode": "小调（A minor / D minor / F minor）",
             "bpm": [55, 60, 70],
             "instr_lead": [42], "instr_harmony": [88], "instr_bass": [43],
             "instr_decoration": [73, 40],
             "chord_style": "小调抒情 i-VI-III-VII 或 i-iv-i-V",
             "melody_char": "长音、叹息式下行、级进为主、留白多；后段逐步上行透光",
             "rhythm_flavor": "全程【呼吸型】【叹息型】【长音+装饰】",
             "dynamics": {"attack": 72, "release": 45}},
    "恐惧": {"mode": "小调带半音色彩（A minor / E minor）",
             "bpm": [100, 85, 75],
             "instr_lead": [40, 41], "instr_harmony": [42], "instr_bass": [43],
             "instr_decoration": [73],
             "chord_style": "小二度色彩 i-bII-i 或 i-#iv°-V",
             "melody_char": "颤音、震音、大跳后回落、休止密集；后段趋于空灵",
             "rhythm_flavor": "前段【快速十六】【切分弱起】+密集休止；后段【呼吸型】",
             "dynamics": {"attack": 82, "release": 40}},
    "厌恶": {"mode": "起始不协和 → 转化段回归 C major 或 F major",
             "bpm": [90, 88, 85],
             "instr_lead": [41], "instr_harmony": [24, 0], "instr_bass": [43],
             "instr_decoration": [0, 71],
             "chord_style": "初段小七/挂留/增，转化段大调 I-V-vi-IV",
             "melody_char": "初段未解决音，转化段级进解决到主音",
             "rhythm_flavor": "初段【走位】【切分弱起】；后段【稳态四分】",
             "dynamics": {"attack": 68, "release": 55}},
    "惊讶": {"mode": "大调（C major / G major）",
             "bpm": [110, 105, 100],
             "instr_lead": [0, 40], "instr_harmony": [24], "instr_bass": [43],
             "instr_decoration": [46, 73],
             "chord_style": "明亮 I-IV-V-I，转化段 I-vi-IV-V",
             "melody_char": "上行询问动机、跳进后级进解决",
             "rhythm_flavor": "前段【上行连奏】【附点摇摆】；后段【稳态八分】",
             "dynamics": {"attack": 92, "release": 60}},
    "喜悦": {"mode": "大调（C major / G major / D major）",
             "bpm": [100, 105, 110],
             "instr_lead": [0, 42], "instr_harmony": [24, 0], "instr_bass": [43],
             "instr_decoration": [73, 46],
             "chord_style": "经典 I-V-vi-IV 或 vi-IV-I-V",
             "melody_char": "明亮短促动机、上行大跳后级进、律动清晰",
             "rhythm_flavor": "全程【附点摇摆】【稳态八分】【上行连奏】",
             "dynamics": {"attack": 90, "release": 70}},
    "平静": {"mode": "大调（C major / F major）",
             "bpm": [70, 70, 70],
             "instr_lead": [1, 73], "instr_harmony": [46], "instr_bass": [43],
             "instr_decoration": [73, 40],
             "chord_style": "温和 I-vi-IV-V 或加七 IMaj7-vi7-IVMaj7-V7",
             "melody_char": "全程级进、长音、留白丰富",
             "rhythm_flavor": "全程【稳态四分】【呼吸型】【长音+装饰】",
             "dynamics": {"attack": 62, "release": 45}},
}


# ==================== GM Program → 白名单音色映射 ====================
# 覆盖 v5 情绪配方里所有出现过的 GM 号；未识别的按 role 回落。

_GM_TO_TIMBRE = {
    0: "piano", 1: "warm_piano", 2: "piano", 3: "warm_piano",
    24: "nylon_guitar", 25: "nylon_guitar", 26: "nylon_guitar",
    27: "nylon_guitar", 29: "nylon_guitar", 30: "nylon_guitar",
    32: "contrabass", 33: "contrabass", 34: "contrabass",
    35: "contrabass", 36: "contrabass", 43: "contrabass",
    40: "violin", 41: "viola", 42: "cello",
    45: "harp", 46: "harp", 47: "harp",
    48: "warm_pad", 49: "warm_pad", 50: "warm_pad", 51: "warm_pad",
    56: "violin", 57: "cello",
    60: "viola", 61: "cello", 62: "cello", 63: "cello",
    68: "clarinet", 71: "clarinet",
    72: "flute", 73: "flute", 74: "flute", 75: "flute",
    88: "warm_pad", 89: "warm_pad", 90: "warm_pad", 91: "warm_pad",
    94: "warm_pad", 95: "warm_pad",
}
_ROLE_DEFAULT = {"lead": "piano", "harmony": "warm_piano",
                 "bass": "contrabass", "decoration": "flute"}


def gm_to_timbre(program, role: str = "") -> str:
    """GM 号 → 白名单音色。program 可为 int 或 [int]（GPT 偶尔会包一层）。"""
    if isinstance(program, (list, tuple)):
        program = program[0] if program else None
    try:
        p = int(program)
    except (TypeError, ValueError):
        return _ROLE_DEFAULT.get(role, "piano")
    t = _GM_TO_TIMBRE.get(p)
    if t is not None:
        return t
    return _ROLE_DEFAULT.get(role, "piano")


# ==================== OpenAI 客户端 ====================

_client_singleton: Optional[OpenAI] = None


def _client() -> OpenAI:
    global _client_singleton
    if _client_singleton is None:
        _client_singleton = OpenAI(api_key=API_KEY, base_url=BASE_URL,
                                   timeout=LLM_CALL_TIMEOUT_SEC)
    return _client_singleton


def _llm_json(system: str, user: str, temperature: float) -> tuple:
    """调 LLM 强制 JSON 输出，返回 (parsed_dict, usage_dict)。"""
    resp = _client().chat.completions.create(
        model=MODEL,
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": user}],
    )
    text = resp.choices[0].message.content
    usage = {"in": resp.usage.prompt_tokens, "out": resp.usage.completion_tokens}
    return json.loads(text), usage


# ==================== Stage 1: 蓝图 ====================

_STAGE1_SYSTEM = "你是过程式音乐作曲家。只输出 JSON，不加任何说明文字。"

_STAGE1_USER = """根据【产品敲定的情绪配方】和用户描述，输出 15 秒作曲蓝图 JSON。

【情绪 · {emotion}】强度 {intensity}/100
- 调式方向：{mode}
- BPM 曲线：0s={bpm0} → 7.5s={bpm1} → 15s={bpm2}
- Lead 主旋律 GM 号（从中选 1 个）：{instr_lead}
- Harmony 和声 GM 号：{instr_harmony}
- Bass 低音 GM 号：{instr_bass}
- Decoration 装饰 GM 号（8s 后进入）：{instr_decoration}
- 和弦风格：{chord_style}
- 旋律特征:{melody_char}
- 节奏风味：{rhythm_flavor}

【用户情绪描述】{ai_summary}

【硬约束】
- 15 秒过程式结构：0-7.5s 情绪段，7.5-8.5s pivot 过渡，8.5-15s 转化段
- chord_timeline 覆盖 0-15s，共 7-8 个和弦，每个 1.5-2.5s
- motif 是 3-5 个音符的核心动机，在 appearances 时刻反复出现
- 严禁不必要的不协和音程；旋律以级进为主

只输出下面结构的 JSON（数值示例仅参考，你要根据配方填合适的值）：
{{
  "title": "4-8 字诗意中文，无标点",
  "key": "具体调如 A minor",
  "key_end": "转化段调",
  "scale_notes_midi": [调内音 MIDI 数组，如 [60,62,63,65,67,68,70,72]],
  "chord_timeline": [
    {{"t_start": 0.0, "t_end": 2.0, "chord": "Am", "chord_notes_midi": [45,48,52,57], "bass_root_midi": 33}}
  ],
  "motif": {{
    "character": "文字描述动机性格",
    "notes_midi": [60, 63, 62],
    "durations_beats": [1.0, 0.5, 1.5],
    "appearances": [
      {{"t": 1.0, "transpose_semitones": 0}},
      {{"t": 4.0, "transpose_semitones": 0}},
      {{"t": 9.0, "transpose_semitones": 3}}
    ]
  }},
  "instruments": {{
    "lead":       {{"gm_program": <从 instr_lead 选>, "midi_range": [60, 84]}},
    "harmony":    {{"gm_program": <从 instr_harmony 选>, "midi_range": [48, 72]}},
    "bass":       {{"gm_program": <从 instr_bass 选>, "midi_range": [30, 55]}},
    "decoration": {{"gm_program": <从 instr_decoration 选>, "midi_range": [72, 96]}}
  }},
  "dynamics_curve": [
    {{"t": 0.0, "velocity": {atk}}},
    {{"t": 7.5, "velocity": {mid}}},
    {{"t": 15.0, "velocity": {rel}}}
  ]
}}"""


def _stage1_blueprint(emotion, intensity, ai_summary):
    r = _LLM_RECIPE[emotion]
    user = _STAGE1_USER.format(
        emotion=emotion, intensity=intensity, mode=r["mode"],
        bpm0=r["bpm"][0], bpm1=r["bpm"][1], bpm2=r["bpm"][2],
        instr_lead=r["instr_lead"], instr_harmony=r["instr_harmony"],
        instr_bass=r["instr_bass"], instr_decoration=r["instr_decoration"],
        chord_style=r["chord_style"], melody_char=r["melody_char"],
        rhythm_flavor=r["rhythm_flavor"], ai_summary=ai_summary,
        atk=r["dynamics"]["attack"],
        mid=(r["dynamics"]["attack"] + r["dynamics"]["release"]) // 2,
        rel=r["dynamics"]["release"],
    )
    return _llm_json(_STAGE1_SYSTEM, user, temperature=0.85)


# ==================== Stage 2: 4 声部（并行调用） ====================

_STAGE2_SYSTEM = "你是过程式音乐编曲师，只负责一个声部。只输出 JSON，不加任何说明文字。"

_STAGE2_BASE = """15 秒过程式音乐，你负责的声部：**{role}**

【调】{key} → {key_end}，调内音 MIDI = {scale}
【和弦时间轴】{chord_timeline_compact}
【乐器 midi_range】{midi_range}
【力度曲线】{dyn_curve}——按时间线性插值，你输出的 velocity ±5 抖动即可
"""

_STAGE2_MOTIF = """
【主题动机（必须严格复现）】
- 音符 MIDI：{motif_pitches}
- 时值（拍）：{motif_durs}
- 出现时刻：{motif_appearances}
必须在每个 appearances[i].t 时刻严格重现动机（可按 transpose_semitones 移调）。
"""

_STAGE2_TAIL = """
【全局硬约束（违反即失败）】
- 所有 note.end > note.start，所有 end ≤ 15.0
- 所有 pitch ∈ midi_range，velocity ∈ [1, 127]
- 严禁 32 分音符（时值 < 0.125s）
- 严禁两音同起同高

只输出：{{"notes": [{{"pitch": 整数, "start": 秒, "end": 秒, "velocity": 整数}}, ...]}}
"""

_LEAD_EXTRA = """
【硬约束（Lead 专属）】
1. 至少 45 个音符
2. 相邻两音半音差 ≤5（禁大跳）；跳进 3-5 半音后下一音必须反向级进回归
3. 严禁 3 个及以上连续半音爬升
4. 严禁连续 6 个及以上等时值
5. 时值至少混用 5 种：从 {{0.125, 0.1875, 0.25, 0.375, 0.5, 0.75, 1.0, 1.5, 2.0}} 选
6. 前 7.5 秒平均每秒 3-5 个音符（密），后 7.5 秒每秒 1-3 个（疏）
7. 7.5-8.5s 过渡区必须有 0.3s+ 休止（呼吸）
8. 动机在 appearances 指定时刻严格出现
"""

_HARMONY_EXTRA = """
【硬约束（Harmony 专属）】
1. 至少 40 个音符
2. 每个音必须是当前和弦音或调内音
3. 大部分是分解和弦（同和弦 3 音循环），少量柱式和弦
4. 前 7.5s 每秒 2-4 音，7.5-8.5s 减半（呼吸），8.5-15s 每秒 1-3 音
5. velocity 比 Lead 低 15-25
6. 音区不与 Lead 撞：优先落在 midi_range 中低端
7. 时值至少混用 3 种
"""

_BASS_EXTRA = """
【硬约束（Bass 专属）】
1. 至少 30 个音符
2. 每个和弦时段段首必须敲根音（bass_root_midi）
3. 段中可加根音的五度（+7 半音）或八度（±12）
4. 节奏必须周期性稳定
5. 前段 velocity 比 Lead 低 10-20，后段低 20-35
6. 音区严格在 midi_range 内
"""

_DECORATION_EXTRA = """
【硬约束（Decoration 专属）】
1. 12-18 个音符
2. 所有 start ≥ 8.0，所有 end ≤ 15.0
3. 稀疏点缀，长音为主（时值 0.5-2.0 秒）
4. 每个音必须是当前和弦音或调内音
5. 相邻音半音差 ≤5，级进为主
6. velocity 40-70（比 Lead 轻）
7. 相邻音间隔 ≥ 0.3s
"""

_ROLE_EXTRAS = {
    "lead":       (_LEAD_EXTRA, 0.7),
    "harmony":    (_HARMONY_EXTRA, 0.5),
    "bass":       (_BASS_EXTRA, 0.5),
    "decoration": (_DECORATION_EXTRA, 0.75),
}


def _compact_chords(chord_timeline):
    return " | ".join(
        f"{c['t_start']:.1f}-{c['t_end']:.1f}:{c['chord']}"
        f"({','.join(map(str, c['chord_notes_midi']))})/bass{c['bass_root_midi']}"
        for c in chord_timeline
    )


def _stage2_role(role, blueprint):
    inst = blueprint["instruments"][role]
    body = _STAGE2_BASE.format(
        role=role, key=blueprint["key"], key_end=blueprint["key_end"],
        scale=blueprint["scale_notes_midi"],
        chord_timeline_compact=_compact_chords(blueprint["chord_timeline"]),
        midi_range=inst["midi_range"],
        dyn_curve=blueprint["dynamics_curve"],
    )
    if role == "lead":
        m = blueprint["motif"]
        body += _STAGE2_MOTIF.format(
            motif_pitches=m["notes_midi"],
            motif_durs=m["durations_beats"],
            motif_appearances=m["appearances"],
        )
    extra, temp = _ROLE_EXTRAS[role]
    body += extra + _STAGE2_TAIL
    return _llm_json(_STAGE2_SYSTEM, body, temperature=temp)


# ==================== 规则补 pad + arpeggio ====================

def _build_pad_and_arp(blueprint):
    chords = blueprint["chord_timeline"]

    pad_notes = []
    for c in chords:
        tones = c["chord_notes_midi"]
        dur = c["t_end"] - c["t_start"]
        pad_notes += make_pad(tones, c["t_start"], dur + 0.3, 50, 'warm_pad')

    arp_notes = []
    for i, c in enumerate(chords):
        base = c["chord_notes_midi"]
        hi = sorted(set([n + 12 if n < 55 else n for n in base]))
        hi = hi + [hi[0] + 12, hi[1] + 12] if len(hi) >= 2 else hi
        dur = c["t_end"] - c["t_start"]
        pattern = ['updown', 'broken', 'up', 'updown'][i % 4]
        arp_notes += make_arpeggio(hi, c["t_start"], dur, 0.375, 44, 'harp',
                                   pattern=pattern, vel_jitter=5)

    return (
        {"role": "pad", "timbre": "warm_pad", "notes": pad_notes},
        {"role": "arpeggio", "timbre": "harp", "notes": arp_notes},
    )


# ==================== 音符规整 ====================

def _as_int(v, default=0):
    """把 GPT 可能返回的 [int] / str / int 统一成 int。"""
    if isinstance(v, (list, tuple)):
        v = v[0] if v else default
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _as_float(v, default=0.0):
    if isinstance(v, (list, tuple)):
        v = v[0] if v else default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _clip_notes(notes, midi_range):
    lo, hi = midi_range
    out = []
    for n in notes:
        if not isinstance(n, dict):
            continue
        p = _as_int(n.get("pitch"), -1)
        s = _as_float(n.get("start"), -1)
        e = _as_float(n.get("end"), -1)
        v = _as_int(n.get("velocity"), 60)
        if p < 0 or s < 0 or e < 0 or e <= s:
            continue
        e = min(e, DURATION); s = max(s, 0.0)
        if e - s < 0.05: continue
        p = max(lo, min(hi, p))
        v = max(1, min(127, v))
        out.append(_note(p, s, e, v))
    return out


# ==================== 对外主入口 ====================

def generate_song(emotion: str, intensity: int, ai_summary: str = "") -> dict:
    """
    调 LLM 生成 song dict（不合成，交给 synth.synth_song）。

    返回：
        {
          "title": str,             # 4-8 字诗意中文
          "emotion": str,
          "instruments": [
            {"role": str, "timbre": str, "notes": [...]}  # 6 声部
          ],
          "_meta": {"elapsed_sec": float, "tokens_in": int, "tokens_out": int,
                    "cost_usd": float, "model": str, "blueprint": dict}
        }

    抛错：任何 LLM 失败/JSON 解析失败都会向上抛，由调用侧（generator.py）
          决定是重试还是降级到 fallback。
    """
    t0 = time.time()
    usage_total = {"in": 0, "out": 0}

    # Stage 1
    bp, u1 = _stage1_blueprint(emotion, intensity, ai_summary)
    usage_total["in"] += u1["in"]; usage_total["out"] += u1["out"]

    # Stage 2 × 4（并行）
    parts = {}
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(_stage2_role, role, bp): role
                for role in ("lead", "harmony", "bass", "decoration")}
        for fut in cf.as_completed(futs):
            role = futs[fut]
            data, u = fut.result()
            usage_total["in"] += u["in"]; usage_total["out"] += u["out"]
            parts[role] = data.get("notes", [])

    # 4 声部规整
    instruments = []
    for role in ("lead", "harmony", "bass", "decoration"):
        inst = bp["instruments"][role]
        notes = _clip_notes(parts[role], inst["midi_range"])
        instruments.append({
            "role": role,
            "timbre": gm_to_timbre(inst["gm_program"], role),
            "notes": notes,
        })

    # 规则补 pad + arpeggio（v2 风格 6 声部完整）
    pad_inst, arp_inst = _build_pad_and_arp(bp)
    instruments = [pad_inst, arp_inst] + instruments

    # 白名单守卫（万一 GM 映射漏出 non-whitelist，此处兜住）
    for inst in instruments:
        if inst["timbre"] not in ALLOWED_TIMBRES:
            inst["timbre"] = _ROLE_DEFAULT.get(inst["role"], "piano")

    in_price, out_price = PRICING.get(MODEL, (0.0, 0.0))
    cost = usage_total["in"] * in_price + usage_total["out"] * out_price

    return {
        "title": bp.get("title", "无题"),
        "emotion": emotion,
        "instruments": instruments,
        "_meta": {
            "elapsed_sec": time.time() - t0,
            "tokens_in": usage_total["in"],
            "tokens_out": usage_total["out"],
            "cost_usd": cost,
            "model": MODEL,
            "blueprint": bp,
        },
    }
