"""
LLM 生成的配置——凭据、模型、超时。
所有值可通过环境变量覆盖。
"""
import os

# ==== API 通道（openai-next，中国大陆走 FlClash 代理）====
API_KEY = os.environ.get("EMBER_OPENAI_KEY", "")
BASE_URL = os.environ.get("EMBER_OPENAI_BASE_URL", "https://api.openai-next.com/v1")

# ==== 模型选择 ====
# 产品决策：4o 音质通过验收，mini 密度不达标不用。
MODEL = os.environ.get("EMBER_LLM_MODEL", "gpt-4o")

# ==== 超时（LLM 端到端上限，超时自动降级到兜底）====
# 4o 单次 openai-next 中转约 15-60s，端到端 5 次调用 (1 蓝图 + 4 声部并行) 约 30-70s。
# 上限 90s 覆盖 P99；应用侧游戏窗口 30-90s 也大致对齐。
LLM_TIMEOUT_SEC = float(os.environ.get("EMBER_LLM_TIMEOUT", "90"))

# ==== 单次 LLM 调用 socket 超时（一个 stage 卡住的兜底）====
LLM_CALL_TIMEOUT_SEC = float(os.environ.get("EMBER_LLM_CALL_TIMEOUT", "60"))

# ==== 计价（打日志用）====
PRICING = {
    "gpt-4o-mini": (0.15 / 1e6, 0.60 / 1e6),   # ($/token) in, out
    "gpt-4o":      (2.50 / 1e6, 10.00 / 1e6),
}
