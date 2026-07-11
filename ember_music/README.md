# ember_music · 音乐生成模块（开发速览）

**版本：** 1.0.0
**产品：** 余烬 Ember——AI 情绪音乐生成
**你只需读：** `generator.py` + 本文件 + `DEPLOY.md`

## 一分钟上手

```python
from ember_music import generate_music, healthcheck

# 启动服务时先自检
print(healthcheck())
# {'fallback_pool_ok': True, 'llm_config_ok': True, 'llm_model': 'gpt-4o', ...}

# 每次请求
result = generate_music(
    emotion="悲伤",                # 必填：7 类中文之一
    intensity=65,                  # 必填：0-100
    ai_summary="亲人搬走后的空落感",
    text_input="今天回到家……",     # 可选，LLM 会截取前 500 字
    output_dir="./output",
    use_llm=True,                  # 默认 True；False 直走兜底
    session_id="user_123",         # 可选：让兜底抽取稳定
)

print(result.path)      # 生成的 wav 绝对路径
print(result.title)     # LLM 生成的诗意中文名（如"椅中空梦"）；兜底则为固定名
print(result.source)    # "llm" 或 "fallback"
print(result.elapsed_sec)  # 端到端耗时
print(result.llm_meta)  # {model, tokens_in, tokens_out, cost_usd, ...}
```

返回是 `GenerateResult` dataclass，`.to_dict()` 可 JSON 序列化。

## 目录

```
ember_music/
├── __init__.py           ← 只暴露 generate_music, GenerateResult, healthcheck
├── generator.py          ← ⭐ 主入口，接手开发从这里读起
├── llm_gen.py            ← LLM 生成主逻辑（Stage 1 + Stage 2×4 + GM→白名单映射）
├── synth.py              ← 合成器（11 种白名单音色，稳定不用改）
├── primitives.py         ← 编曲原语（pad / arpeggio / bass / melody 生成器）
├── fallback.py           ← 21 首兜底池索引 + 抽取
├── mapping.py            ← 7 情绪 × 3 强度档 + 作曲配方
├── config.py             ← API key / 模型 / 超时配置（可环境变量覆盖）
├── fallback_wavs/        ← 21 首兜底 wav（打包在包内）
├── requirements.txt
└── DEPLOY.md             ← ⭐ 部署说明（读这个）
```

## 生成路径分支

```
generate_music()
  ├─ use_llm=True (默认)
  │    → _try_llm_generate → llm_gen.generate_song
  │        (Stage 1 蓝图 + Stage 2×4 并行 + 规则补 pad/arp + 合成)
  │    → 成功返回 source="llm"
  │    → 失败/超时 (>90s) 静默降级 ↓
  └─ 兜底路径 → pick_fallback → 复制 wav → source="fallback"
```

**LLM 失败不会 raise 出去** —— 任何异常/超时都自动降级，前端不会看到 500。

## 环境依赖

见 [requirements.txt](requirements.txt)：`openai>=1.30`, `numpy`, `scipy`。

## 硬约束（改代码前必读）

1. **禁用 vibrato**：合成器函数中不得叠加音高 LFO 调制（`sin(2πf·vib·t)` 类），
   用户听感像"转音器"，破坏乐器真实感。
2. **禁用 tanh 失真**：不要用 `np.tanh(x * gain)` 类软削波做失真，电子感重。
3. **音色白名单固定 11 种**（见 `synth.py::ALLOWED_TIMBRES`）：
   `piano / warm_piano / cello / violin / viola / flute / clarinet / harp /
    nylon_guitar / warm_pad / contrabass`。
   LLM 输出的 GM 号会经 `llm_gen.gm_to_timbre` 映射到这 11 种；
   非白名单音色会被 `synth.py` 兜底为 piano。
4. **每首 15 秒**：`synth.DURATION = 15.0`，产品硬定义。
5. **无环境音**：不叠雨/流水/风等 SFX。之前尝试过，产品放弃了。
6. **只用 gpt-4o**：mini 音符密度不达标（v6 测试 -42%），弃用。
