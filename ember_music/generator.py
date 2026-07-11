"""
余烬 Ember · 音乐生成主入口
对外暴露 generate_music()，接手开发只需关注这里。

v1.0：LLM 实时生成（gpt-4o）+ 兜底降级；开关 use_llm=True 生效。
"""
import os
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutTimeout
from dataclasses import dataclass, asdict
from typing import Optional

from .mapping import EMOTIONS, intensity_to_band, EMOTION_RECIPE
from .fallback import pick_fallback, verify_pool
from .synth import synth_song, save_wav, DURATION
from .config import LLM_TIMEOUT_SEC, MODEL


@dataclass
class GenerateResult:
    """generate_music() 的返回结构"""
    path: str            # 生成的 wav 文件绝对路径
    title: str           # 诗意中文名（4-8 字无标点）
    emotion: str         # 回传的情绪标签
    intensity: int       # 回传的强度
    band: str            # L / M / H
    duration_sec: float  # 15.0
    source: str          # "llm" | "fallback"
    elapsed_sec: float   # 从调用到返回的耗时
    llm_meta: Optional[dict] = None  # {model, tokens_in, tokens_out, cost_usd, blueprint}

    def to_dict(self) -> dict:
        return asdict(self)


def generate_music(
    emotion: str,
    intensity: int,
    ai_summary: str = "",
    text_input: str = "",
    voice_features: Optional[dict] = None,
    output_dir: str = ".",
    use_llm: bool = True,                # v1.0 默认开启 LLM 实时生成
    llm_timeout_sec: float = LLM_TIMEOUT_SEC,
    session_id: Optional[str] = None,
) -> GenerateResult:
    """
    生成一首 15 秒纯乐器音乐。

    参数：
        emotion:         前半段传入的情绪标签（7 类中文之一）
        intensity:       0-100
        ai_summary:      AI 情绪摘要（喂给 LLM prompt）
        text_input:      用户原始文字（LLM 会截取前 500 字作为补充上下文）
        voice_features:  {crying, sighing, voice_speed, voice_volume}（v1.1 前忽略）
        output_dir:      wav 输出目录
        use_llm:         True=实时生成，失败自动降级到兜底；False=直接兜底
        llm_timeout_sec: LLM 端到端超时（默认从 config 读），超时自动降级
        session_id:      用于兜底抽取的稳定种子（可选）

    返回：GenerateResult
    抛错：
        ValueError    — 情绪/强度非法
        FileNotFoundError — 兜底路径的 wav 文件缺失（LLM 也失败时才可能触发）
    """
    t0 = time.time()

    # 参数校验
    if emotion not in EMOTIONS:
        raise ValueError(f"emotion 必须是 {EMOTIONS} 之一，收到 '{emotion}'")
    band = intensity_to_band(intensity)  # 内部会校验 0-100

    os.makedirs(output_dir, exist_ok=True)

    # ==== LLM 生成路径 ====
    if use_llm:
        # ai_summary 与截断后的 text_input 拼作为情绪上下文喂给 LLM
        summary = ai_summary or ""
        if text_input:
            snippet = text_input[:500]
            summary = f"{summary}\n用户原话（截取）：{snippet}" if summary else snippet
        try:
            result = _try_llm_generate(
                emotion, intensity, band, summary, output_dir,
                llm_timeout_sec, t0,
            )
            if result is not None:
                return result
        except Exception as e:
            # LLM 任何异常都吞掉，走兜底（不 raise 出去让前端 500）
            print(f"[ember_music] LLM 生成失败 → 降级到兜底: "
                  f"{type(e).__name__}: {e}")

    # ==== 兜底路径 ====
    seed = hash(session_id) if session_id else None
    fb = pick_fallback(emotion, band, seed=seed)

    # 复制到 output_dir 加时间戳前缀避免文件名冲突
    stamped = f"{int(time.time()*1000)}_{uuid.uuid4().hex[:6]}_{fb['filename']}"
    out_path = os.path.join(output_dir, stamped)
    shutil.copy2(fb["path"], out_path)

    return GenerateResult(
        path=os.path.abspath(out_path),
        title=fb["title"],
        emotion=emotion,
        intensity=intensity,
        band=band,
        duration_sec=DURATION,
        source="fallback",
        elapsed_sec=time.time() - t0,
    )


def _try_llm_generate(
    emotion, intensity, band, summary, output_dir, timeout_sec, t0,
) -> Optional[GenerateResult]:
    """
    调 llm_gen.generate_song → synth_song → save wav。
    超时/异常返回 None（由上层降级到 fallback）。
    """
    from . import llm_gen  # 延迟 import，兜底路径不强依赖 openai

    # 端到端 timeout：把 llm_gen.generate_song 塞进 executor
    with ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(llm_gen.generate_song, emotion, intensity, summary)
        try:
            song = fut.result(timeout=timeout_sec)
        except FutTimeout:
            print(f"[ember_music] LLM 端到端超时 (>{timeout_sec}s) → 降级")
            return None

    # 合成
    audio = synth_song(song)

    # 落盘
    title = song["title"]
    fname = f"{int(time.time()*1000)}_{uuid.uuid4().hex[:6]}_{emotion}_{title}.wav"
    out_path = os.path.join(output_dir, fname)
    save_wav(audio, out_path)

    meta = song.get("_meta", {})
    return GenerateResult(
        path=os.path.abspath(out_path),
        title=title,
        emotion=emotion,
        intensity=intensity,
        band=band,
        duration_sec=DURATION,
        source="llm",
        elapsed_sec=time.time() - t0,
        llm_meta={
            "model": meta.get("model"),
            "tokens_in": meta.get("tokens_in"),
            "tokens_out": meta.get("tokens_out"),
            "cost_usd": meta.get("cost_usd"),
            "llm_elapsed_sec": meta.get("elapsed_sec"),
        },
    )


def healthcheck() -> dict:
    """
    模块自检——启动服务时调一次，返回诊断信息。
    """
    missing = verify_pool()
    llm_config_ok = True
    llm_error = None
    try:
        from .config import API_KEY, BASE_URL
        if not API_KEY or not BASE_URL:
            llm_config_ok = False
            llm_error = "API_KEY 或 BASE_URL 未配置"
    except Exception as e:
        llm_config_ok = False
        llm_error = str(e)

    return {
        "module_version": "1.0.0",
        "fallback_pool_ok": len(missing) == 0,
        "fallback_missing": missing,
        "llm_enabled": True,
        "llm_model": MODEL,
        "llm_config_ok": llm_config_ok,
        "llm_config_error": llm_error,
        "supported_emotions": list(EMOTIONS),
    }
