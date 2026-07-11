/**
 * voice-input.js — 玻璃厂心灵旅程 · 语音转文字模块
 *
 * 三种后端，按可用性自动降级：
 *   1. openai   — OpenAI 兼容 /audio/transcriptions 接口
 *                 (OpenAI whisper-1 / gpt-4o-transcribe、SiliconFlow SenseVoice、Groq whisper 均可用)
 *   2. dashscope — 阿里云百炼 Qwen-Omni 多模态（走 OpenAI 兼容 chat 接口，音频作为多模态输入，
 *                  可在转写同时让模型顺带输出语气感受，供第3幕命名预选参考）
 *   3. webspeech — 浏览器内置识别，无需 key（Chrome/Edge 可用，作为无 key 降级）
 *
 * 用法：
 *   const voice = new VoiceInput({
 *     provider: 'openai',                          // 'openai' | 'dashscope' | 'webspeech' | 'auto'
 *     apiKey: 'sk-xxx',
 *     baseUrl: 'https://api.openai.com/v1',        // SiliconFlow: https://api.siliconflow.cn/v1
 *     model: 'whisper-1',                          // SiliconFlow: FunAudioLLM/SenseVoiceSmall
 *     language: 'zh',
 *     onStateChange: (s) => {},                    // 'idle'|'recording'|'transcribing'|'error'
 *     onVolume: (v) => {},                         // 0~1 实时音量，可驱动玻璃精灵呼吸光效
 *   });
 *   await voice.start();
 *   const { text, mood } = await voice.stop();     // mood 仅 dashscope 多模态时返回
 *
 * 隐私原则（对应文档"文案与情绪安全原则"）：
 *   录音仅在 start→stop 之间保存在内存，转写完成后立即丢弃，不落盘、不留存。
 */

class VoiceInput {
  constructor(opts = {}) {
    this.provider = opts.provider || 'auto';
    this.apiKey = opts.apiKey || '';
    this.baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = opts.model || 'whisper-1';
    this.language = opts.language || 'zh';
    this.maxSeconds = opts.maxSeconds || 60;
    this.onStateChange = opts.onStateChange || (() => {});
    this.onVolume = opts.onVolume || (() => {});
    this.onPartial = opts.onPartial || (() => {});   // 仅 webspeech 有流式中间结果

    this.state = 'idle';
    this._recorder = null;
    this._chunks = [];
    this._stream = null;
    this._audioCtx = null;
    this._volTimer = null;
    this._maxTimer = null;
    this._webspeech = null;
    this._webspeechResult = '';
    this._fallbackSpeech = null;
    this._fallbackSpeechResult = '';
    this._fallbackSpeechInterim = '';
  }

  _setState(s) { this.state = s; this.onStateChange(s); }

  /** 解析实际使用的 provider（'auto' 时优先用带 key 的云端，其次浏览器内置） */
  _resolveProvider() {
    if (this.provider !== 'auto') return this.provider;
    if (this.apiKey) return 'openai';
    if (VoiceInput.webSpeechSupported()) return 'webspeech';
    throw new Error('没有可用的语音识别后端：请提供 apiKey，或使用支持 Web Speech 的浏览器');
  }

  static webSpeechSupported() {
    return typeof window !== 'undefined' &&
      !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /** 开始录音（webspeech 则开始流式识别） */
  async start() {
    if (this.state === 'recording') return;
    const provider = this._resolveProvider();
    this._activeProvider = provider;

    if (provider === 'webspeech') { this._startWebSpeech(); return; }

    this._stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, channelCount: 1,
    }});

    // 实时音量 → 驱动 UI（玻璃精灵光效）
    this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this._audioCtx.createMediaStreamSource(this._stream);
    const analyser = this._audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    this._volTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
      this.onVolume(Math.min(1, Math.sqrt(sum / buf.length) * 4));
    }, 80);

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
    this._chunks = [];
    this._recorder = new MediaRecorder(this._stream, mime ? { mimeType: mime } : undefined);
    this._recorder.ondataavailable = (e) => { if (e.data.size) this._chunks.push(e.data); };
    this._recorder.start(250);
    this._startFallbackSpeech();
    this._setState('recording');

    // 超长保护
    this._maxTimer = setTimeout(() => {
      if (this.state === 'recording') this.stop().catch(() => {});
    }, this.maxSeconds * 1000);
  }

  /** 停止录音并转写。返回 { text, mood }（mood 仅 dashscope 时可能非空） */
  async stop() {
    if (this._activeProvider === 'webspeech') return this._stopWebSpeech();
    if (this.state !== 'recording') return { text: '', mood: null };

    clearTimeout(this._maxTimer);
    clearInterval(this._volTimer);

    const blob = await new Promise((resolve) => {
      this._recorder.onstop = () =>
        resolve(new Blob(this._chunks, { type: this._recorder.mimeType || 'audio/webm' }));
      this._recorder.stop();
    });
    this._teardownMedia();

    if (blob.size < 1000) { this._setState('idle'); return { text: '', mood: null }; }

    this._setState('transcribing');
    const fallbackPromise = this._stopFallbackSpeech();
    try {
      const result = this._activeProvider === 'dashscope'
        ? await this._transcribeDashScope(blob)
        : await this._transcribeOpenAI(blob);
      await fallbackPromise;
      this._setState('idle');
      return result;
    } catch (err) {
      const fallback = await fallbackPromise;
      if (fallback.text) {
        this._setState('idle');
        return fallback;
      }
      this._setState('error');
      throw err;
    } finally {
      this._chunks = []; // 录音数据即刻丢弃，不留存
    }
  }

  /** 取消：停止并丢弃，不转写 */
  cancel() {
    clearTimeout(this._maxTimer);
    clearInterval(this._volTimer);
    if (this._webspeech) { try { this._webspeech.abort(); } catch (_) {} this._webspeech = null; }
    if (this._fallbackSpeech) { try { this._fallbackSpeech.abort(); } catch (_) {} this._fallbackSpeech = null; }
    if (this._recorder && this._recorder.state !== 'inactive') {
      this._recorder.onstop = null;
      try { this._recorder.stop(); } catch (_) {}
    }
    this._teardownMedia();
    this._chunks = [];
    this._setState('idle');
  }

  _teardownMedia() {
    if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null; }
    if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }
  }

  _startFallbackSpeech() {
    if (!VoiceInput.webSpeechSupported()) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = this.language === 'zh' ? 'zh-CN' : this.language;
    rec.continuous = true;
    rec.interimResults = true;
    this._fallbackSpeechResult = '';
    this._fallbackSpeechInterim = '';
    rec.onresult = (e) => {
      let finals = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finals += t; else interim += t;
      }
      this._fallbackSpeechResult = finals;
      this._fallbackSpeechInterim = interim;
      this.onPartial(finals + interim);
    };
    rec.onerror = () => {};
    try {
      rec.start();
      this._fallbackSpeech = rec;
    } catch (_) {
      this._fallbackSpeech = null;
    }
  }

  _stopFallbackSpeech() {
    return new Promise((resolve) => {
      const rec = this._fallbackSpeech;
      if (!rec) { resolve({ text: '', mood: null, source: 'none' }); return; }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this._fallbackSpeech = null;
        const text = (this._fallbackSpeechResult || this._fallbackSpeechInterim || '').trim();
        resolve({ text, mood: null, source: text ? 'webspeech-fallback' : 'none' });
      };

      rec.onend = finish;
      try { rec.stop(); } catch (_) { finish(); }
      setTimeout(finish, 1200);
    });
  }

  /* ---------- 后端 1：OpenAI 兼容 /audio/transcriptions ---------- */

  async _transcribeOpenAI(blob) {
    const form = new FormData();
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    form.append('file', blob, `speech.${ext}`);
    form.append('model', this.model);
    if (this.language) form.append('language', this.language);

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`转写接口 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return { text: (data.text || '').trim(), mood: null };
  }

  /* ---------- 后端 2：阿里云百炼 Qwen-Omni 多模态 ---------- */
  /* 转写同时让模型给一个粗粒度语气标签，可作为第3幕情绪预选的旁证 */

  async _transcribeDashScope(blob) {
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    const fmt = blob.type.includes('mp4') ? 'mp4' : 'webm';

    const res = await fetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model || 'qwen2.5-omni-7b',
        stream: true, // Omni 系列要求流式
        messages: [
          { role: 'system', content:
            '你是语音转写助手。将用户语音逐字转写为中文文本，不添加任何解释。' +
            '在转写文本后另起一行，输出：mood:<平静|难过|生气|开心|疲惫|不确定>，' +
            '表示说话人语气给你的整体感受。' },
          { role: 'user', content: [
            { type: 'input_audio', input_audio: { data: `data:;base64,${b64}`, format: fmt } },
          ]},
        ],
        modalities: ['text'],
      }),
    });
    if (!res.ok) throw new Error(`DashScope ${res.status}: ${(await res.text()).slice(0, 200)}`);

    // 读 SSE 流拼接文本
    let full = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^data:\s*(.+)$/);
        if (!m || m[1] === '[DONE]') continue;
        try {
          const delta = JSON.parse(m[1]).choices?.[0]?.delta?.content;
          if (delta) full += delta;
        } catch (_) {}
      }
    }

    const moodMatch = full.match(/mood[:：]\s*(\S+)/i);
    const text = full.replace(/mood[:：]\s*\S+/i, '').trim();
    return { text, mood: moodMatch ? moodMatch[1].trim() : null };
  }

  /* ---------- 后端 3：浏览器内置 Web Speech（无 key 降级） ---------- */

  _startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = this.language === 'zh' ? 'zh-CN' : this.language;
    rec.continuous = true;
    rec.interimResults = true;
    this._webspeechResult = '';
    rec.onresult = (e) => {
      let finals = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finals += t; else interim += t;
      }
      this._webspeechResult = finals;
      this.onPartial(finals + interim);
    };
    rec.onerror = (e) => { if (e.error !== 'aborted') this._setState('error'); };
    rec.start();
    this._webspeech = rec;
    this._setState('recording');
    this._maxTimer = setTimeout(() => {
      if (this.state === 'recording') this.stop().catch(() => {});
    }, this.maxSeconds * 1000);
  }

  _stopWebSpeech() {
    clearTimeout(this._maxTimer);
    return new Promise((resolve) => {
      const rec = this._webspeech;
      if (!rec) { resolve({ text: '', mood: null }); return; }
      const finish = () => {
        this._webspeech = null;
        this._setState('idle');
        resolve({ text: this._webspeechResult.trim(), mood: null });
      };
      rec.onend = finish;
      try { rec.stop(); } catch (_) { finish(); }
      setTimeout(finish, 2000); // onend 兜底
    });
  }
}

if (typeof module !== 'undefined') module.exports = { VoiceInput };
