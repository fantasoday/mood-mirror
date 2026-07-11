# 情绪疗愈 · 卡通脸 Demo

摄像头本地识别面部微表情 → 用卡通形象反映情绪。**画面全程在浏览器本地处理，不上传任何图像**（符合"不直接展示用户面部"的隐私设计）。

技术栈：MediaPipe **Face Landmarker**（输出 52 个 blendshape 系数 + 478 个关键点，含虹膜）→ 驱动卡通脸。

## 文件

| 文件 | 说明 |
|---|---|
| `emotion-engine.js` | 共用识别引擎：摄像头、模型、blendshape 平滑、情绪分类、头部姿态/视线 |
| `svg-face.html` | **第一版：SVG 卡通脸**，开箱即用，无需素材 |
| `rive-face.html` | **第二版：Rive 二维动画**，需加载一个 `.riv` 角色 |
| `index.html` | 入口页，两版对比 |

## 运行（必须用本地服务器）

摄像头需要 `https` 或 `localhost`，直接双击 `file://` 打开会失败。任选一种：

```bash
# Python（Mac 自带）
cd /Users/fan/code/Heal
python3 -m http.server 8000

# 或 Node
npx serve .
```

然后浏览器打开 **http://localhost:8000/** ，点「开启摄像头」并允许权限。
建议用 **Chrome / Edge**（GPU 推理更稳）。首次会联网下载 MediaPipe 模型（约几 MB），之后有缓存。

## 两版对比要点（给 UI 组员看）

- **SVG 版**：脸的每个部件（眼、眉、嘴、腮红、瞳孔、歪头）都由代码实时控制，
  改风格 = 改 SVG 里的形状 + `svg-face.html` 里的 `render()` 参数，改动成本极低，适合快速试视觉方向。
- **Rive 版**：动画由设计师在 Rive 编辑器里做好，观感更精致、更"活"，
  代价是需要一个绑定好输入（inputs）的 `.riv` 角色文件。

### Rive 版怎么快速拿到角色

代码里做了**通用驱动台**：识别和情绪判断已就绪，你只要：

1. 去 **Rive Community / Marketplace**（https://rive.app/community）搜 `face` / `avatar` / `emotion`，
   找一个带 **State Machine + 数值/布尔输入** 的免费角色，下载 `.riv`。
2. 在 `rive-face.html` 页面点「加载 .riv 文件」或粘贴 URL。
3. 页面会**自动列出角色的所有 inputs**，并按名字猜测映射（可下拉手动改）：
   - 数值输入（number）← `smile / jawOpen / blink / browUp …`（0~1，默认 ×100）
   - 布尔输入（boolean）← 信号超过阈值
   - 触发输入（trigger）← 情绪切换时触发

> 想效果和 SVG 版一样"表情精准"，最好让设计组员在 Rive 里做一个输入命名清晰的脸
> （如 `smile`、`mouthOpen`、`eyeBlink`、`browRaise`），映射会几乎自动对上。

## 可调参数（优化视觉时常用）

- `emotion-engine.js`
  - `smoothing`：平滑系数，越小越平滑越"稳"，越大越灵敏（默认 0.35）
  - `scores` 里的权重：调各情绪的判定灵敏度
  - `EMOTION_META`：每种情绪的 emoji / 疗愈文案 / 背景配色
- `svg-face.html` 的 `render()`：眼睛开合、眉毛角度、嘴型、腮红、头部幅度的映射系数

## 情绪分类说明

当前用 blendshape 加权打分（happy / sad / surprised / angry / neutral），黑客松够用。
若要更准，可把 `signals` 向量喂给一个小分类器（几十行的逻辑回归即可），或后续接多模态大模型做更细的情绪描述。

## 常见问题

- **黑屏 / 不动**：确认用 `localhost` 打开、已允许摄像头、用 Chrome。打开页面里「显示摄像头（调试）」看是否有画面。
- **识别不到脸**：光线亮一点、正对镜头、离近些。
- **表情反了（歪头/视线方向）**：`svg-face.html` 里给 `yaw / gazeX / rollDeg` 的符号取反即可。
