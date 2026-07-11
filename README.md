# 玻璃厂情绪整合

## 项目简介

玻璃厂情绪整合是一个面向心理陪伴场景的多模态情绪表达产品。用户可以通过摄像头镜像、语音倾诉或文字输入表达当下状态，系统会将表达内容转化为情绪意象、玻璃碎片、金缮作品和 15 秒情绪音乐，形成一次完整的“看见-表达-重组-安放”体验。

项目围绕情绪表达与心理陪伴完成了完整产品链路，核心流程、前端交互、Node 本地服务、语音转写接入、意象提炼接口与音乐生成模块均由本团队整合实现。

## 核心功能

1. 镜像识别：通过 MediaPipe Face Landmarker 在浏览器本地识别面部表情，不上传用户画面。
2. 语音倾诉：支持麦克风录音，经服务端代理调用 OpenAI 兼容语音转写接口。
3. 文字降级：语音不可用时，可直接打字完成同一流程。
4. 情绪意象：Node 服务调用 LLM 从用户表达中提炼意象、主情绪和强度。
5. 玻璃作品：前端将意象渲染为玻璃碎片，并通过金缮流程组合成作品。
6. 情绪音乐：Python 音乐模块根据情绪和强度生成 15 秒音乐；LLM 不可用时使用兜底音乐池。

## 技术架构

```text
Browser
  ├─ public/factory.html          主交互流程
  ├─ public/voice-input.js        录音与转写封装
  ├─ public/emotion-engine.js     本地表情识别
  └─ public/music-engine.js       前端音频播放壳

Node.js
  └─ server.js                    静态资源服务 + Session API + LLM/STT 代理

Python
  ├─ services/music_service.py    本地音乐生成 HTTP 子服务
  └─ ember_music/                 情绪音乐生成模块与兜底 wav 池
```

## 目录结构

| 路径 | 说明 |
|---|---|
| `server.js` | Node 本地服务入口，默认监听 `5173` |
| `public/` | 前端页面和浏览器端模块，默认首页为 `factory.html` |
| `services/` | Python 本地服务封装 |
| `ember_music/` | 音乐生成模块、依赖清单和兜底音频 |
| `docs/` | 接口文档、产品设计稿、开发文档 |
| `data/` | 本地运行产物目录，不提交运行数据 |

## 依赖清单

基础环境：

- Node.js 18 或更高版本
- Python 3.10 或更高版本
- Chrome / Edge 浏览器

Python 依赖见：

```text
ember_music/requirements.txt
```

安装示例：

```bash
python3 -m venv .venv
.venv/bin/pip install -r ember_music/requirements.txt
```

前端使用原生 HTML/CSS/JS，无构建工具；浏览器端会从 CDN 加载 MediaPipe 与 Rive 相关资源。

## 本地运行

在仓库根目录执行：

```bash
node server.js
```

浏览器打开：

```text
http://localhost:5173/
```

默认首页为主流程：

```text
public/factory.html
```

`server.js` 会自动尝试启动音乐子服务：

```text
http://127.0.0.1:5174
```

如果 Python 虚拟环境或音乐依赖不可用，主流程仍可运行，音乐功能会降级。

## 环境变量

LLM 和语音转写均通过服务端代理调用，API Key 不写入前端代码。

```bash
export LLM_API_KEY="your_api_key"
export LLM_BASE_URL="https://api.openai-next.com/v1"
export LLM_MODEL="gpt-4o-mini"

export EMBER_OPENAI_KEY="your_api_key"
export EMBER_OPENAI_BASE_URL="https://api.openai-next.com/v1"
export EMBER_LLM_MODEL="gpt-4o"
```

说明：

- `LLM_API_KEY`：用于意象提炼、作品命名、结束语和语音转写代理。
- `EMBER_OPENAI_KEY`：用于音乐生成模块。
- 如果未配置 Key，项目会尽量走本地兜底逻辑，不阻塞主体验。

## 常用页面

| 地址 | 说明 |
|---|---|
| `/` | 主流程，等价于 `/factory.html` |
| `/transcript-test.html` | 语音转写调试页 |
| `/index.html` | 早期表情识别入口 |
| `/svg-face.html` | SVG 表情实时驱动页面 |
| `/rive-face.html` | Rive 角色驱动实验 |

## 运行产物

以下目录只在本地运行时生成，不纳入版本库：

```text
data/transcripts/
data/audio/
.venv/
__pycache__/
```

## 原创声明

本仓库内容为本团队围绕“情绪表达与心理陪伴”主题完成的原创增量开发。项目未直接复制已有完整开源项目；如使用第三方库或模型服务，均仅作为基础能力依赖，并在代码和文档中保留其调用边界。

使用到的主要第三方能力包括：

- MediaPipe Face Landmarker：浏览器端面部关键点与表情系数识别。
- Rive runtime：二维角色动画实验页。
- OpenAI 兼容接口：LLM 文本生成与语音转写。
- NumPy / SciPy：音乐生成模块中的音频合成与 wav 输出。
