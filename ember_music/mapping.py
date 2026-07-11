"""
情绪 → 强度档 / 音乐参数映射
产品定义的 7 类情绪 + 3 档强度是唯一 SSOT。
"""

# 7 类情绪（前半段传入的中文标签）——顺序即产品定义顺序
EMOTIONS = ("愤怒", "厌恶", "恐惧", "喜悦", "平静", "悲伤", "惊讶")


def intensity_to_band(intensity: int) -> str:
    """
    强度 0-100 → 三档 L/M/H
      L (轻)：0-30    柔和/单乐器
      M (中)：31-70   标准/主+副
      H (强)：71-100  多层次全上
    """
    if intensity < 0 or intensity > 100:
        raise ValueError(f"intensity 必须 0-100，收到 {intensity}")
    if intensity <= 30:
        return "L"
    if intensity <= 70:
        return "M"
    return "H"


# 情绪 → 作曲/编曲参数映射 v2（4 声部完整版）
# 供未来 LLM prompt 注入 + 未来的参数化作曲引擎共用
EMOTION_RECIPE = {
    "愤怒": {
        "mode": "小调",
        "bpm_curve": "130 → 80",
        "lead": "cello（低音区强奏 / 高 velocity 换取攻击感，禁 tanh 削波）",
        "harmony": "piano / nylon_guitar",
        "bass": "contrabass",
        "decoration": "violin",
        "rhythm": "切分强击 / 快速十六 → 叹息型",
    },
    "厌恶": {
        "mode": "不协和 → 大调",
        "bpm_curve": "90 → 85",
        "lead": "warm_pad → piano",
        "harmony": "nylon_guitar / piano",
        "bass": "piano LH",
        "decoration": "piano / clarinet",
        "rhythm": "走位 → 稳态四分",
    },
    "恐惧": {
        "mode": "小调 + 半音",
        "bpm_curve": "100 → 75",
        "lead": "violin / viola",
        "harmony": "cello",
        "bass": "cello",
        "decoration": "flute",
        "rhythm": "快速十六 → 呼吸型",
    },
    "喜悦": {
        "mode": "大调",
        "bpm_curve": "100 → 110",
        "lead": "piano / violin",
        "harmony": "nylon_guitar",
        "bass": "contrabass",
        "decoration": "flute / harp",
        "rhythm": "附点摇摆 / 稳态八分",
    },
    "平静": {
        "mode": "大调",
        "bpm_curve": "70 全程",
        "lead": "warm_piano + flute",
        "harmony": "harp",
        "bass": "contrabass",
        "decoration": "violin",
        "rhythm": "稳态四分 / 长音+装饰",
    },
    "悲伤": {
        "mode": "小调",
        "bpm_curve": "55 → 70",
        "lead": "cello",
        "harmony": "warm_pad",
        "bass": "contrabass",
        "decoration": "violin / flute",
        "rhythm": "呼吸型 / 叹息型",
    },
    "惊讶": {
        "mode": "大调",
        "bpm_curve": "110 → 100",
        "lead": "violin (高音区)",
        "harmony": "piano",
        "bass": "contrabass",
        "decoration": "harp / flute",
        "rhythm": "上行连奏 → 稳态八分",
    },
}


# 语音特征修饰规则（未来 LLM prompt 应带上；当前 fallback 阶段不生效）
VOICE_MODIFIERS = {
    "crying": "旋律加颤音表现力（合成器不加 vibrato，用 velocity 曲线抖动）",
    "sighing": "在乐句间加呼吸留白",
    "voice_speed_fast": "BPM 全曲 +10",
    "voice_volume_high": "配器织体加厚 + velocity +10",
}
