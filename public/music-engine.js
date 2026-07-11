/**
 * music-engine.js — 玻璃厂 · 前端音频壳
 *
 * 职责（音乐的"生成"在后端 ember_music，本文件不做作曲）：
 *   1. 播放后端生成的 wav：MusicEngine.play(url) / stop()
 *   2. 三个界面音效（Web Audio 合成，不加载文件）：chime() 碎片浮现风铃、
 *      crack() 敲碎闷响、furnace() 熔炉低频轰鸣
 *   3. 全局静音开关：MusicEngine.muted（存 localStorage）
 *
 * 硬约束（与 ember_music/README 对齐）：音效克制、无 vibrato、无 tanh 削波。
 */
class MusicEngine {
  constructor() {
    this._ctx = null;
    this._audio = null; // 当前播放的 <audio>
    this.muted = localStorage.getItem('glassworks_muted') === '1';
  }

  get ctx() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
    return this._ctx;
  }

  setMuted(m) {
    this.muted = m;
    localStorage.setItem('glassworks_muted', m ? '1' : '0');
    if (this._audio) this._audio.muted = m;
  }

  /* ---------- 后端 wav 播放 ---------- */

  /** 播放后端生成的音乐，返回 audio 元素；onEnd 可选 */
  play(url, onEnd) {
    this.stop();
    const audio = new Audio(url);
    audio.muted = this.muted;
    audio.volume = 0.9;
    if (onEnd) audio.addEventListener('ended', onEnd, { once: true });
    audio.play().catch(() => {});
    this._audio = audio;
    return audio;
  }

  stop() {
    if (this._audio) { this._audio.pause(); this._audio = null; }
  }

  /* ---------- 合成音效 ---------- */

  /** 单个正弦音，attack/release 包络，无颤音 */
  _tone(freq, { start = 0, dur = 0.8, gain = 0.08, type = 'sine' } = {}) {
    if (this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** 碎片浮现：两声清脆玻璃风铃（高音五声音阶随机取） */
  chime() {
    const notes = [1567.98, 1760, 2093, 2349.3]; // G6 A6 C7 D7
    const a = notes[Math.floor(Math.random() * notes.length)];
    const b = notes[Math.floor(Math.random() * notes.length)];
    this._tone(a, { dur: 1.4, gain: 0.05 });
    this._tone(b, { start: 0.12, dur: 1.8, gain: 0.035 });
  }

  /** 敲碎：低沉闷响（不是爽快的碎裂声——克制）+ 一点玻璃细响 */
  crack() {
    if (this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    // 低频 thud
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t0);
    osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.25);
    g.gain.setValueAtTime(0.22, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.35);
    // 玻璃细响（短噪声经带通）
    const len = ctx.sampleRate * 0.15;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3800; bp.Q.value = 2;
    const ng = ctx.createGain(); ng.gain.value = 0.05;
    src.connect(bp).connect(ng).connect(ctx.destination);
    src.start(t0 + 0.02);
  }

  /** 熔炉：低频轰鸣，持续 durSec 秒后自然淡出，返回可提前 stop 的句柄 */
  furnace(durSec = 12) {
    if (this.muted) return { stop() {} };
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // 布朗噪声，听感像炉火
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.14, t0 + 1.5);
    g.gain.setValueAtTime(0.14, t0 + durSec - 2);
    g.gain.linearRampToValueAtTime(0.0001, t0 + durSec);
    src.connect(lp).connect(g).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + durSec + 0.1);
    return { stop() { try { g.gain.cancelScheduledValues(0); g.gain.value = 0; src.stop(); } catch (_) {} } };
  }
}

if (typeof module !== 'undefined') module.exports = { MusicEngine };
