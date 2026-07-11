# 玻璃厂情绪整合 Demo

一个本地运行的情绪表达与音乐生成原型：浏览器端采集镜像/语音/文字，Node 本地服务保存 session、调用 LLM 提炼意象，并托管 Python 音乐生成子服务。

## 目录结构

| 路径 | 说明 |
|---|---|
| `server.js` | Node 本地服务入口，默认监听 `5173`，提供静态页面和 `/api/*` |
| `public/` | 浏览器页面与前端模块，默认首页是 `public/factory.html` |
| `services/music_service.py` | 音乐生成 HTTP 子服务，由 `server.js` 自动拉起 |
| `ember_music/` | 余烬 Ember 音乐生成包与兜底 wav 池 |
| `docs/` | 接口文档、产品设计稿、开发说明 |
| `data/` | 本地运行产物目录，`transcripts/` 和 `audio/` 不提交 |

## 本地启动

```bash
cd /Users/fan/code/Heal
node server.js
```

然后打开：

```text
http://localhost:5173/
```

`server.js` 会自动尝试启动音乐子服务：

```text
http://127.0.0.1:5174
```

如果 `.venv` 或音乐依赖不可用，主流程仍可运行，音乐功能会降级。

## 环境变量

LLM 和语音转写都通过服务端代理，key 不进入前端代码。

```bash
export LLM_API_KEY="..."
export LLM_BASE_URL="https://api.openai-next.com/v1"
export LLM_MODEL="gpt-4o-mini"

export EMBER_OPENAI_KEY="..."
export EMBER_OPENAI_BASE_URL="https://api.openai-next.com/v1"
export EMBER_LLM_MODEL="gpt-4o"
```

`LLM_API_KEY`/`EMBER_OPENAI_KEY` 缺失时，LLM 相关功能会走本地兜底或返回可降级错误。

## 常用页面

| 地址 | 说明 |
|---|---|
| `/` | 主流程，等价于 `/factory.html` |
| `/transcript-test.html` | 语音/转写调试页 |
| `/index.html` | 早期表情 Demo 入口 |
| `/svg-face.html` | SVG 表情实时驱动 |
| `/rive-face.html` | Rive 角色驱动实验 |

## 运行产物

以下目录只在本地运行时生成，不纳入版本库：

```text
data/transcripts/
data/audio/
```
