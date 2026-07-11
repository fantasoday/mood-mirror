# ember_music · 部署说明

**给部署开发同学看的。产品交付的完整包结构见 [README.md](README.md)。**

## 1. 依赖安装

```bash
pip install -r requirements.txt
```

依赖：`openai>=1.30`（LLM 通道）、`numpy`、`scipy`（合成器）。

## 2. 环境变量（必配 or 必改）

| 变量 | 用途 | 默认值 | 生产必改？ |
|---|---|---|---|
| `EMBER_OPENAI_KEY` | LLM API key | 交付默认值（openai-next） | **是**——生产必须用你们自己申请的 key，交付默认值会被产品团队共用 |
| `EMBER_OPENAI_BASE_URL` | LLM base URL | `https://api.openai-next.com/v1` | 视 API 通道而定 |
| `EMBER_LLM_MODEL` | 模型名 | `gpt-4o` | 否（产品已锁定 4o，mini 密度不达标） |
| `EMBER_LLM_TIMEOUT` | LLM 端到端秒数 | `90` | 视上游游戏窗口调整 |
| `EMBER_LLM_CALL_TIMEOUT` | 单次 LLM socket 秒数 | `60` | 一般不用改 |
| `EMBER_FALLBACK_DIR` | 兜底 wav 目录 | 包内 `fallback_wavs/` | 若把 wav 迁到独立 CDN/存储需覆盖 |

**注意 openai-next**：在中国大陆需走 HTTP 代理（例如 FlClash 全局模式
`http://127.0.0.1:7890`）。生产机部署建议：

- 走境外/香港 region 直连
- 或部署一层 HTTP 代理转发到 openai-next

Python OpenAI SDK 默认走系统代理，配好代理即可。

## 3. 启动自检

服务启动时**必调一次** `healthcheck()`：

```python
from ember_music import healthcheck
h = healthcheck()
assert h["fallback_pool_ok"], f"兜底 wav 缺失：{h['fallback_missing']}"
assert h["llm_config_ok"],   f"LLM 配置错误：{h['llm_config_error']}"
print(h)
```

返回：
```json
{
  "module_version": "1.0.0",
  "fallback_pool_ok": true,
  "fallback_missing": [],
  "llm_enabled": true,
  "llm_model": "gpt-4o",
  "llm_config_ok": true,
  "llm_config_error": null,
  "supported_emotions": ["愤怒", "厌恶", "恐惧", "喜悦", "平静", "悲伤", "惊讶"]
}
```

`fallback_pool_ok=false` 一定要拒绝启动——兜底缺件会让某档情绪 500。

## 4. 调用示例

```python
from ember_music import generate_music

# 最小调用
r = generate_music(emotion="悲伤", intensity=65, ai_summary="亲人搬走后的空落感")
print(r.path)  # /abs/path/1720684800000_xxx_悲伤_椅中空梦.wav

# 完整调用
r = generate_music(
    emotion="悲伤",
    intensity=65,
    ai_summary="亲人搬走后的空落感",
    text_input="今天回到家，看到那把常坐的椅子还在原位……",
    output_dir="/data/ember/audio_output",
    use_llm=True,
    llm_timeout_sec=90,
    session_id="user_abc123",  # 让兜底抽取稳定，不传则纯随机
)

# result.to_dict() 用来 JSON 序列化返给前端
```

## 5. 成本参考（生产测算前必读）

**gpt-4o 定价**：$2.50 / $10.00 per 1M tokens (in / out)
**单次生成实测**：~3500 tok in + ~3500 tok out ≈ **$0.043/首**

规模测算（假设 10w MAU × 10 首/月）：
- LLM 生成：$4300/月
- 兜底降级（假设 5% 请求走兜底）：$0
- 总：**~$4300/月**

如果预算不允许 4o，两条路：
1. 提高兜底命中率（比如实时生成设阈值：只对付费/VIP 用户开）
2. 换回 mini + 加强 prompt 约束（历史已知 v5 mini 密度不达标，需另做实验）

## 6. 失败模式与降级链

```
用户请求
  → LLM 生成 (可能失败)
      ├ 超时 >90s        ────┐
      ├ API 5xx          ────┤
      ├ JSON 解析失败    ────┤
      ├ 白名单/校验失败  ────┤
      └ openai-next 中断 ────┴─→ 静默降级到兜底
                                  ↓
                             pick_fallback (返回 21 首之一)
                                  ↓
                             wav 缺失 → 抛 FileNotFoundError
                                        (启动 healthcheck 应已拦截)
```

**兜底 wav 必须齐全**。启动 `healthcheck()` 的 `fallback_pool_ok` 是生产健康度指标，
建议接监控告警。

## 7. 观测建议

生产建议记录：

- `result.source`：`"llm"` vs `"fallback"` 比例（LLM 稳定性）
- `result.elapsed_sec`：P50 / P90 / P99（生成延迟分布）
- `result.llm_meta.cost_usd`：成本累加
- `result.llm_meta.tokens_in/out`：token 用量分布
- LLM 失败原因（在 `generator.py::generate_music` 的 print 里）

## 8. 硬约束（改代码前必读）

见 [README.md](README.md) 第 "硬约束" 节。以下几项不要私自改：

- 音色白名单只 11 种
- 每首 15 秒
- 无环境音
- 无 vibrato / 无 tanh 削波

## 9. 联系

产品负责人：EDY
提示词/配方文档：项目根目录 `ember_prompt_v5.md`
交接完整文档：`ember_music_handoff.md`
