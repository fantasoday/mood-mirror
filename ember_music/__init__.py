"""
余烬 Ember · 音乐生成模块

对开发暴露的唯一入口：generate_music()
"""
from .generator import generate_music, GenerateResult, healthcheck
from .mapping import EMOTIONS, intensity_to_band

__all__ = [
    "generate_music", "GenerateResult", "healthcheck",
    "EMOTIONS", "intensity_to_band",
]
__version__ = "1.0.0"
