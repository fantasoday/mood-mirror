"""
21 首兜底歌单索引 + 抽取
- 每次调用返回一个 (path, title) 元组
- 同一 (emotion, band) 有 1-N 首（当前 1 首/档），随机抽以避免用户重复听到同一首
"""
import os
import random
from typing import Optional

# 兜底 wav 库位置（生产可通过 EMBER_FALLBACK_DIR 覆盖；默认指向包内 fallback_wavs/）
_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FALLBACK_DIR = os.path.join(_PKG_DIR, "fallback_wavs")

# 21 首索引：{emotion: {band: [{"filename": str, "title": str}]}}
# 命名规范：{情绪}_{L|M|H}_{诗意名}.wav
FALLBACK_INDEX = {
    "愤怒": {
        "L": [{"filename": "愤怒_L_余烟未散.wav", "title": "余烟未散"}],
        "M": [{"filename": "愤怒_M_锐.wav", "title": "锐"}],
        "H": [{"filename": "愤怒_H_焰颅.wav", "title": "焰颅"}],
    },
    "悲伤": {
        "L": [{"filename": "悲伤_L_落雪.wav", "title": "落雪"}],
        "M": [{"filename": "悲伤_M_空巢.wav", "title": "空巢"}],
        "H": [{"filename": "悲伤_H_泣墟.wav", "title": "泣墟"}],
    },
    "恐惧": {
        "L": [{"filename": "恐惧_L_微芒.wav", "title": "微芒"}],
        "M": [{"filename": "恐惧_M_幽径.wav", "title": "幽径"}],
        "H": [{"filename": "恐惧_H_骨风.wav", "title": "骨风"}],
    },
    "厌恶": {
        "L": [{"filename": "厌恶_L_苦涩.wav", "title": "苦涩"}],
        "M": [{"filename": "厌恶_M_蚀痕.wav", "title": "蚀痕"}],
        "H": [{"filename": "厌恶_H_腐潮.wav", "title": "腐潮"}],
    },
    "惊讶": {
        "L": [{"filename": "惊讶_L_微光乍.wav", "title": "微光乍"}],
        "M": [{"filename": "惊讶_M_云开.wav", "title": "云开"}],
        "H": [{"filename": "惊讶_H_惊涛.wav", "title": "惊涛"}],
    },
    "喜悦": {
        "L": [{"filename": "喜悦_L_微笑.wav", "title": "微笑"}],
        "M": [{"filename": "喜悦_M_花信.wav", "title": "花信"}],
        "H": [{"filename": "喜悦_H_春潮.wav", "title": "春潮"}],
    },
    "平静": {
        "L": [{"filename": "平静_L_湖心.wav", "title": "湖心"}],
        "M": [{"filename": "平静_M_苔.wav", "title": "苔"}],
        "H": [{"filename": "平静_H_长夏.wav", "title": "长夏"}],
    },
}


def get_fallback_dir() -> str:
    """兜底 wav 库路径。优先读环境变量 EMBER_FALLBACK_DIR。"""
    return os.environ.get("EMBER_FALLBACK_DIR", DEFAULT_FALLBACK_DIR)


def pick_fallback(emotion: str, band: str, seed: Optional[int] = None) -> dict:
    """
    抽一首兜底。
    返回 {"path": absolute_path, "title": str, "filename": str}
    seed: 可传入用户 session_id 的 hash，让同一会话结果稳定；None 则完全随机。
    """
    if emotion not in FALLBACK_INDEX:
        raise ValueError(f"未知情绪 '{emotion}'")
    if band not in FALLBACK_INDEX[emotion]:
        raise ValueError(f"未知强度档 '{band}'（应为 L/M/H）")
    candidates = FALLBACK_INDEX[emotion][band]
    rng = random.Random(seed) if seed is not None else random
    chosen = rng.choice(candidates)
    path = os.path.join(get_fallback_dir(), chosen["filename"])
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"兜底 wav 不存在：{path}\n"
            f"请设置环境变量 EMBER_FALLBACK_DIR 指向 21 首兜底目录，"
            f"或运行 ember_fallback_21.py 生成。"
        )
    return {"path": path, "title": chosen["title"], "filename": chosen["filename"]}


def verify_pool() -> list:
    """启动时自检：21 首 wav 是否都存在。返回缺失文件列表。"""
    missing = []
    for emotion, bands in FALLBACK_INDEX.items():
        for band, songs in bands.items():
            for s in songs:
                p = os.path.join(get_fallback_dir(), s["filename"])
                if not os.path.isfile(p):
                    missing.append(s["filename"])
    return missing
