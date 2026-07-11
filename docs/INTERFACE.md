# 语音转文字模块 · 接口文档

项目目录：`/tmp/glassworks-voice/`

| 文件 | 作用 |
|---|---|
| `voice-input.js` | 核心模块，`VoiceInput` 类，零依赖，`<script>` 引入即用 |
| `demo.html` | 可独立运行的演示页（第3幕语音入口样式，已按视觉规范配色），含 `EMOTION_PALETTE` 色板数据 |
| `README.md` | 服务商配置速查（key/model/baseUrl 对照表） |
| `INTERFACE.md` | 本文档 |

本地测试：`python3 -m http.server 8765`（麦克风要求 localhost 或 HTTPS）→ http://localhost:8765/demo.html

---

## 1. VoiceInput 类

### 构造

```js
const voice = new VoiceInput({
  // ---- 后端选择 ----
  provider: 'auto',        // 'openai' | 'dashscope' | 'webspeech' | 'auto'
                           // auto：有 key 走 openai，无 key 走浏览器内置
  apiKey:   'sk-xxx',      // 云端后端必填
  baseUrl:  'https://api.openai.com/v1',   // 仅 openai 兼容后端生效
  model:    'whisper-1',

  // ---- 行为 ----
  language:   'zh',        // 转写语言
  maxSeconds: 60,          // 超过自动停止，防误触长录

  // ---- 回调（都可选）----
  onStateChange: (s) => {},  // 'idle' | 'recording' | 'transcribing' | 'error'
  onVolume:      (v) => {},  // 0~1 实时音量，约 80ms 一次，驱动 UI 光效
  onPartial:     (t) => {},  // 流式中间文本，仅 webspeech 后端有
});
```

### 方法

| 方法 | 返回 | 说明 |
|---|---|---|
| `await voice.start()` | `void` | 请求麦克风并开始录音。授权被拒 / 无可用后端时 **throw**，必须 catch 并给"直接打字"降级提示 |
| `await voice.stop()` | `{ text, mood }` | 停止录音并转写。`text`：转写文本（空串=没听清）；`mood`：语气标签，**仅 dashscope 后端**返回（`平静/难过/生气/开心/疲惫`），其他后端恒为 `null`。转写失败 throw |
| `voice.cancel()` | `void` | 放弃本次录音，不转写不产生费用（用于手指滑出按钮等场景） |
| `voice.state` | `string` | 当前状态，同 onStateChange 的值 |
| `VoiceInput.webSpeechSupported()` | `bool` | 静态方法：浏览器是否支持内置识别（无 key 降级可用性检测） |

### 服务商配置速查

| 你们拿到的 key | provider | model | baseUrl |
|---|---|---|---|
| OpenAI | `openai` | `whisper-1` 或 `gpt-4o-transcribe` | `https://api.openai.com/v1` |
| SiliconFlow | `openai` | `FunAudioLLM/SenseVoiceSmall` | `https://api.siliconflow.cn/v1` |
| Groq | `openai` | `whisper-large-v3` | `https://api.groq.com/openai/v1` |
| 阿里云百炼 | `dashscope` | `qwen2.5-omni-7b` | 不用填（代码内置） |
| 没有 key | `webspeech` | 不用填 | 不用填（仅 Chrome/Edge） |

---

## 2. 接入第 3 幕（表达性书写）的标准写法

```html
<script src="voice-input.js"></script>
<script>
const voice = new VoiceInput({
  provider: 'openai',
  apiKey: API_KEY,
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'FunAudioLLM/SenseVoiceSmall',
  onStateChange: (s) => {
    hint.textContent = { recording: '我在听…', transcribing: '正在把你的话变成文字…' }[s] || '';
  },
  onVolume: (v) => micBtn.style.setProperty('--vol', v),  // 金色光晕呼吸
});

// 按住说话（pointer 事件同时覆盖鼠标和触屏）
micBtn.onpointerdown = (e) => {
  micBtn.setPointerCapture(e.pointerId);
  voice.start().catch(() => hint.textContent = '麦克风不可用（直接打字也可以）');
};
micBtn.onpointerup = async () => {
  try {
    const { text, mood } = await voice.stop();
    if (text) writingInput.value += (writingInput.value ? ' ' : '') + text;  // 追加不覆盖
    else hint.textContent = '好像没有听清，再试一次？';
    if (mood && mood !== '不确定') suggestEmotion(mood);  // 仅作预选"猜测"，用户可否定
  } catch (e) {
    hint.textContent = '转写没有成功（直接打字也可以）';
  }
};
micBtn.onpointercancel = () => voice.cancel();
</script>
```

要点：
- **语音永远是打字的补充**，所有失败分支都落回"直接打字也可以"。
- `mood` 只能用于**预选**情绪 chip，不能当结论展示（"机器永远猜测"原则）。
- 转写文本填入后用户可任意编辑，提交时以输入框内容为准，与语音无关。

---

## 3. 情绪色板接口（demo.html 内，可拷走跨幕复用）

```js
// 五套色板，key 与第3幕粗粒度情绪一致
EMOTION_PALETTE = {
  '平静': { glass:'#9DB39C', crack:'#4A5F49', gold:'#D9C289', ambient:'#DCE6D8', card:'#F5F3EC' },
  '开心': { glass:'#E8B96B', crack:'#B8823D', gold:'#F4C842', ambient:'#FCE4D6', card:'#FFF7EE' },
  '难过': { glass:'#7A8FA8', crack:'#3E4A5F', gold:'#D4A574', ambient:'#B8C5D6', card:'#EEF2F7' },
  '生气': { glass:'#C97455', crack:'#6B2E20', gold:'#E5A83A', ambient:'#F0C4A8', card:'#F8ECE0' },
  '惊讶': { glass:'#B8A5D4', crack:'#4A3E6B', gold:'#E8CE8A', ambient:'#E4DCF0', card:'#F4F0F9' },
};

applyEmotion('难过');   // 把整套色板写入 CSS 变量：--glass --crack --gold --ambient --card
```

页面样式全部引用这五个 CSS 变量，所以第4幕玻璃、第5幕金缮、第6幕卡片只要调一次 `applyEmotion()` 就整体换色。

---

## 4. 隐私与安全（已内置，别改掉）

- 录音仅存内存，`stop()` 转写后立即丢弃（不落盘、不留存）。
- `webspeech` 后端会把音频发给浏览器厂商（Google）服务器，**演示/自测可用，正式版建议只走带 key 的云端**。
- **key 不要硬编码发布**：黑客松现场填没问题；若公开部署，把 `baseUrl` 指向自己的转发接口，key 放服务端。
- 60 秒自动截断。
