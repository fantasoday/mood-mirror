/**
 * song-engine.js — 玻璃厂心灵旅程 · "送你一首歌" 生成作曲引擎 (v4)
 *
 * 每次调用 composeSong(emotion) 都用随机种子现场作一首新歌：
 *   - 和弦进行：从该情绪的进行池随机选 + 随机变位
 *   - 旋律：在调式内按"强拍落和弦音、级进为主、乐句收束解决"的规则随机生成 A/B 两个乐句
 *   - 节奏/速度：BPM 在情绪区间内随机，旋律节奏型随机生成
 *   - 配器：主奏/伴奏/贝斯/鼓 从该情绪的乐器池随机编配（钢琴/吉他/竖琴/贝斯/鼓组/颂钵/风铃/氛围垫）
 * 同一个 spec（含种子）既可实时播放，也可离线渲染导出 mp3/wav —— 听到哪首存的就是哪首。
 *
 * 七情绪：愤怒 悲伤 恐惧 厌恶 惊讶 喜悦 平静
 *
 * 用法：
 *   const spec = composeSong('悲伤');            // 每次都是新歌
 *   const engine = new SongEngine();
 *   await engine.play(spec);                      // 实时播放（需用户手势）
 *   engine.stop();
 *   const { blob, ext } = await exportSong(spec); // 导出 mp3（lamejs CDN 不可用时自动回落 wav）
 */

/* ---------------- 种子随机 ---------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 情绪 → 作曲约束（不是成品，是"作曲规则"） ---------------- */
const EMOTION_RULES = {
  '悲伤': {
    scale: [0, 2, 3, 5, 7, 8, 10], bpm: [54, 68], roots: [43, 45, 46, 48],
    progs: [[0,5,3,4],[0,3,5,4],[5,3,0,4],[0,5,0,4],[0,2,5,4]],
    melInstr: ['piano','piano','harp'], arpInstr: ['piano','harp'],
    melOct: [12, 24], density: 0.35, restProb: 0.22, contourBias: -0.35,
    drums: null, padAmp: [0.5, 0.7], texture: { bowl: 0.3, chime: 0.05 },
    subdiv: [1, 2], arpVel: 0.35, endDeg: [0, 4],
  },
  '喜悦': {
    scale: [0, 2, 4, 5, 7, 9, 11], bpm: [98, 118], roots: [48, 50, 52],
    progs: [[0,4,5,3],[0,5,3,4],[0,3,4,4],[3,4,0,0],[0,4,3,4]],
    melInstr: ['piano','guitar','harp'], arpInstr: ['guitar','guitar','piano','harp'],
    melOct: [12, 12], density: 0.75, restProb: 0.08, contourBias: 0.3,
    drums: 'groove', padAmp: [0.25, 0.4], texture: { bowl: 0, chime: 0.4 },
    subdiv: [2, 2], arpVel: 0.5, endDeg: [0, 2, 4],
  },
  '愤怒': {
    scale: [0, 1, 3, 5, 7, 8, 10], bpm: [86, 100], roots: [43, 45, 46],
    progs: [[0,1,0,6],[0,3,1,0],[0,1,5,0],[0,6,1,0]],
    melInstr: ['guitar','guitar','piano'], arpInstr: ['piano','guitar'],
    melOct: [0, 12], density: 0.8, restProb: 0.1, contourBias: -0.1,
    drums: 'heavy', padAmp: [0.4, 0.55], texture: { bowl: 0.15, chime: 0 },
    subdiv: [2, 2], arpVel: 0.42, endDeg: [0, 0, 4],
  },
  '恐惧': {
    scale: [0, 2, 3, 5, 6, 8, 10], bpm: [58, 72], roots: [45, 47, 48],
    progs: [[0,3,0,5],[0,5,3,0],[0,1,0,3],[0,3,5,3]],
    melInstr: ['piano','harp'], arpInstr: ['harp','piano'],
    melOct: [12, 24], density: 0.3, restProb: 0.35, contourBias: 0,
    drums: 'heartbeat', padAmp: [0.65, 0.85], texture: { bowl: 0.35, chime: 0.1 },
    subdiv: [1, 1], arpVel: 0.3, endDeg: [1, 4, 5],   // 不完全解决 → 悬
    stepChrom: 0.35,
  },
  '厌恶': {
    scale: [0, 2, 3, 5, 6, 9, 10], bpm: [72, 86], roots: [45, 46, 48],
    progs: [[0,3,0,4],[0,4,3,0],[0,2,3,0]],
    melInstr: ['guitar','piano'], arpInstr: ['guitar','piano'],
    melOct: [12, 12], density: 0.5, restProb: 0.3, contourBias: -0.2,
    drums: 'sparse', padAmp: [0.3, 0.45], texture: { bowl: 0.1, chime: 0 },
    subdiv: [1, 2], arpVel: 0.35, endDeg: [0, 2],
  },
  '惊讶': {
    scale: [0, 2, 4, 6, 7, 9, 11], bpm: [88, 106], roots: [48, 50, 52],
    progs: [[0,1,0,1],[0,1,4,1],[0,4,1,0],[0,1,3,4]],
    melInstr: ['piano','harp','guitar'], arpInstr: ['harp','harp','guitar'],
    melOct: [12, 12], density: 0.65, restProb: 0.12, contourBias: 0.2,
    drums: 'light', padAmp: [0.25, 0.4], texture: { bowl: 0, chime: 0.6 },
    subdiv: [2, 2], arpVel: 0.48, endDeg: [0, 2, 4], leapProb: 0.35,
  },
  '平静': {
    scale: [0, 2, 4, 7, 9], bpm: [56, 68], roots: [48, 50],
    progs: [[0,3,1,3],[0,1,3,1],[0,3,0,1],[0,1,0,3]],
    melInstr: ['piano','harp','harp'], arpInstr: ['harp','piano'],
    melOct: [12, 12], density: 0.35, restProb: 0.2, contourBias: 0,
    drums: null, padAmp: [0.45, 0.6], texture: { bowl: 0.3, chime: 0.2 },
    subdiv: [1, 2], arpVel: 0.4, endDeg: [0, 0, 2],
  },
};

/* ---------------- 作曲 ---------------- */

function composeSong(emotion, seed) {
  const rules = EMOTION_RULES[emotion] || EMOTION_RULES['平静'];
  seed = seed >>> 0 || (Math.floor(Math.random() * 0xffffffff) >>> 0);
  const rng = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const range = ([a, b]) => a + rng() * (b - a);

  const L = rules.scale.length;
  const semiOf = (d) => rules.scale[((d % L) + L) % L] + 12 * Math.floor(d / L);

  // 和弦进行：随机选一条，随机做一次"换尾"变体
  let prog = pick(rules.progs).slice();
  if (rng() < 0.4) prog[3] = pick(rules.progs)[3];
  const chords = prog.map(r => [semiOf(r), semiOf(r + 2), semiOf(r + 4)]);

  // 旋律乐句生成：2 小节 = 8 拍
  function genPhrase(isB, endDegs) {
    const beatsTotal = 8;
    const durs = [];
    let left = beatsTotal;
    const tokens = rules.density > 0.6
      ? [0.5, 0.5, 0.5, 1, 1, 1.5, 2]
      : [1, 1, 1.5, 2, 0.5, 3];
    while (left > 0.01) {
      let d = pick(tokens);
      if (d > left) d = left;
      durs.push(d);
      left -= d;
    }
    // 音高：随机游走，强拍吸附和弦音，B 段整体抬高
    const lift = isB ? 2 : 0;
    let deg = pick([0, 2, 4].map(x => x + lift));
    const notes = [];
    let acc = 0;
    let dir = rng() < 0.5 ? 1 : -1;
    for (let i = 0; i < durs.length; i++) {
      const isRest = i > 0 && i < durs.length - 1 && rng() < rules.restProb;
      if (isRest) { notes.push([null, durs[i]]); acc += durs[i]; continue; }
      const barIdx = Math.floor(acc / 4) % chords.length;
      const strong = Math.abs(acc % 2) < 0.01;
      if (i === durs.length - 1) {
        deg = pick(endDegs) + (isB ? Math.round(lift / 2) : 0);   // 收束音
      } else if (strong && rng() < 0.7) {
        // 吸附最近的和弦音（度数空间：根/三/五 = prog度+0/2/4）
        const ct = [prog[barIdx], prog[barIdx] + 2, prog[barIdx] + 4];
        deg = ct.reduce((a, b) => Math.abs(b - deg) < Math.abs(a - deg) ? b : a, ct[0]);
      } else {
        if (rng() < 0.18) dir = -dir;
        const leap = rng() < (rules.leapProb || 0.12) ? (2 + Math.floor(rng() * 3)) : 1;
        deg += dir * leap + (rng() < 0.3 ? Math.round((rng() - 0.5 + rules.contourBias) * 2) : 0);
        deg = Math.max(0 + lift * (isB ? 1 : 0) - 2, Math.min(L * 2 + lift, deg));
      }
      notes.push([semiOf(deg), durs[i]]);
      acc += durs[i];
    }
    return notes;
  }

  const endA = rules.endDeg, endB = rules.endDeg.map(d => d + 1);
  const phrases = { A: genPhrase(false, endA), B: genPhrase(true, endB) };

  // 伴奏分解和弦：随机 pattern
  const subdiv = pick(rules.subdiv.length ? rules.subdiv : [2]);
  const steps = 4 * subdiv;
  const arpPattern = [];
  for (let i = 0; i < steps; i++) {
    if (rng() < 0.15 && i !== 0) { arpPattern.push(null); continue; }
    arpPattern.push(pick([0, 1, 2, 1, 0, 2]));
  }

  // 鼓：按风格生成随机 16 步 pattern
  let drums = null;
  const style = rules.drums;
  if (style === 'groove') {
    drums = { kick: { 0: 0.8 }, snare: {}, shaker: {} };
    for (const s of [6, 8, 10, 11]) if (rng() < 0.5) drums.kick[s] = 0.5 + rng() * 0.3;
    for (const s of [4, 12]) drums.snare[s] = 0.3 + rng() * 0.2;
    for (let s = 2; s < 16; s += 4) if (rng() < 0.8) drums.shaker[s] = 0.15 + rng() * 0.15;
  } else if (style === 'heavy') {
    drums = { kick: { 0: 1 }, snare: {}, shaker: null };
    for (const s of [3, 6, 8, 11, 14]) if (rng() < 0.55) drums.kick[s] = 0.5 + rng() * 0.4;
    for (const s of [4, 12]) drums.snare[s] = 0.55 + rng() * 0.2;
  } else if (style === 'heartbeat') {
    drums = { kick: { 0: 0.7, 2: 0.4 }, snare: null, shaker: null };
  } else if (style === 'sparse') {
    drums = { kick: { 0: 0.6 }, snare: rng() < 0.5 ? { 10: 0.3 } : {}, shaker: null };
  } else if (style === 'light') {
    drums = { kick: { 0: 0.5 }, snare: null, shaker: { 4: 0.2, 12: 0.2 } };
  }

  return {
    emotion, seed,
    bpm: Math.round(range(rules.bpm)),
    root: pick(rules.roots),
    scale: rules.scale.slice(),
    chords, prog,
    phrases,
    form: ['A', 'A', 'B', 'A'],
    melody: { instr: pick(rules.melInstr), oct: pick(rules.melOct), vel: 0.85 },
    arp: { instr: pick(rules.arpInstr), subdiv, pattern: arpPattern, vel: rules.arpVel,
           oct: rng() < 0.25 ? -12 : 0 },
    bassBeats: pick([[0], [0, 2], [0, 1.5, 2], [0, 2, 3.5]].slice(0, rules.density > 0.6 ? 4 : 2)),
    drums,
    padAmp: range(rules.padAmp),
    texture: { ...rules.texture, beat: 0.4 + rng() * 0.5 },
  };
}

/* ---------------- 合成器（ctx 通用：实时 & 离线渲染共用） ---------------- */

const Synth = {
  midiToFreq: (m) => 440 * Math.pow(2, (m - 69) / 12),

  piano(ctx, bus, t, midi, amp) {
    const f0 = Synth.midiToFreq(midi);
    for (const [r, w] of [[1,1],[2.002,0.42],[3.006,0.18],[4.012,0.07],[5.02,0.03]]) {
      const f = f0 * r;
      if (f > ctx.sampleRate / 2.5) continue;
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * w, t + 0.012);
      g.gain.setTargetAtTime(0, t + 0.012, 2.6 / (0.8 + r * 0.5));
      osc.connect(g).connect(bus);
      osc.start(t); osc.stop(t + 8);
    }
    Synth._thump(ctx, bus, t, 900, amp * 0.3, 0.006);
  },

  guitar(ctx, bus, t, midi, amp) {
    const f0 = Synth.midiToFreq(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(6000, f0 * 8), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(600, f0 * 1.6), t + 0.5);
    lp.connect(bus);
    for (const [r, w, det] of [[1,1,0],[1,0.5,3],[2.001,0.4,0],[3.004,0.2,0],[4.01,0.08,0]]) {
      const f = f0 * r;
      if (f > ctx.sampleRate / 2.5) continue;
      const osc = ctx.createOscillator();
      osc.type = 'triangle'; osc.frequency.value = f; osc.detune.value = det;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * w, t + 0.004);
      g.gain.setTargetAtTime(0, t + 0.004, 1.2 / (0.9 + r * 0.7));
      osc.connect(g).connect(lp);
      osc.start(t); osc.stop(t + 5);
    }
    Synth._thump(ctx, bus, t, 2500, amp * 0.5, 0.003);
  },

  harp(ctx, bus, t, midi, amp) {
    const f0 = Synth.midiToFreq(midi);
    for (const [r, w] of [[1,1],[2.0,0.3],[3.0,0.12],[5.0,0.04]]) {
      const f = f0 * r;
      if (f > ctx.sampleRate / 2.5) continue;
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * w, t + 0.003);
      g.gain.setTargetAtTime(0, t + 0.003, 2.2 / r);
      osc.connect(g).connect(bus);
      osc.start(t); osc.stop(t + 7);
    }
  },

  bassNote(ctx, bus, t, midi, vel) {
    const f0 = Synth.midiToFreq(midi);
    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = f0;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine'; osc2.frequency.value = f0 * 2;
    const g = ctx.createGain(), g2 = ctx.createGain();
    g2.gain.value = 0.3;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.3, t + 0.015);
    g.gain.setTargetAtTime(0, t + 0.015, 0.7);
    osc.connect(g); osc2.connect(g2).connect(g); g.connect(bus);
    osc.start(t); osc.stop(t + 3); osc2.start(t); osc2.stop(t + 3);
  },

  kick(ctx, bus, t, vel) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(85, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.5, t + 0.005);
    g.gain.setTargetAtTime(0, t + 0.005, 0.15);
    osc.connect(g).connect(bus);
    osc.start(t); osc.stop(t + 1);
    Synth._thump(ctx, bus, t, 300, vel * 0.2, 0.01);
  },
  snare(ctx, bus, t, vel) { Synth._noise(ctx, bus, t, 'bandpass', 1800, vel * 0.16, 0.09); },
  shaker(ctx, bus, t, vel) { Synth._noise(ctx, bus, t, 'highpass', 6500, vel * 0.1, 0.04); },

  bowl(ctx, bus, t, rootMidi, beat, vol) {
    const f0 = Synth.midiToFreq(rootMidi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.1 * vol, t + 3);
    g.gain.setTargetAtTime(0.0001, t + 7, 5);
    g.connect(bus);
    for (const [f, w] of [[f0,1],[f0+beat,1],[f0*2.93,0.15]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = f;
      const pg = ctx.createGain(); pg.gain.value = w * 0.5;
      osc.connect(pg).connect(g);
      osc.start(t); osc.stop(t + 20);
    }
  },

  chime(ctx, bus, t, rootMidi, vol) {
    const f0 = Synth.midiToFreq(rootMidi + 24 + [0,4,7,12][Math.floor(Math.random()*4)]);
    for (const [r, w] of [[1,1],[2.76,0.4],[5.4,0.15]]) {
      const f = f0 * r;
      if (f > ctx.sampleRate / 2.5) continue;
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05 * vol * w, t + 0.004);
      g.gain.setTargetAtTime(0, t + 0.004, 1.6 / r);
      osc.connect(g).connect(bus);
      osc.start(t); osc.stop(t + 6);
    }
  },

  _thump(ctx, bus, t, freq, amp, decay) {
    const nb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++)
      nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * decay));
    const ns = ctx.createBufferSource(); ns.buffer = nb;
    const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = freq;
    const ng = ctx.createGain(); ng.gain.value = amp;
    ns.connect(nf).connect(ng).connect(bus);
    ns.start(t);
  },
  _noise(ctx, bus, t, type, freq, amp, decay) {
    const nb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.2), ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++)
      nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * decay));
    const ns = ctx.createBufferSource(); ns.buffer = nb;
    const nf = ctx.createBiquadFilter(); nf.type = type; nf.frequency.value = freq;
    const ng = ctx.createGain(); ng.gain.value = amp;
    ns.connect(nf).connect(ng).connect(bus);
    ns.start(t);
  },

  makeIR(ctx, seconds) {
    const len = Math.floor(seconds * ctx.sampleRate);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const n = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.3);
        lp = lp * 0.6 + n * 0.4;
        d[i] = lp;
      }
    }
    return buf;
  },
};

/* ---------------- 小节调度（实时 & 离线共用） ---------------- */

function buildGraph(ctx) {
  const master = ctx.createGain();
  master.gain.value = 0;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 6;
  master.connect(comp).connect(ctx.destination);
  const bus = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 0.62;
  bus.connect(dry).connect(master);
  const conv = ctx.createConvolver();
  conv.buffer = Synth.makeIR(ctx, 2.8);
  const wet = ctx.createGain(); wet.gain.value = 0.5;
  bus.connect(conv).connect(wet).connect(master);
  return { master, bus };
}

function startPad(ctx, bus, spec, t0, duration) {
  const root = Synth.midiToFreq(spec.root);
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.001, t0);
  out.gain.setTargetAtTime(spec.padAmp * 0.12, t0, 3);
  out.connect(bus);
  const nodes = [];
  [1, 1.5, 2].forEach((ratio, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = root * ratio;
    const g = ctx.createGain(); g.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.02 + 0.013 * i;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.3;
    lfo.connect(lfoG).connect(g.gain);
    osc.connect(g).connect(out);
    osc.start(t0); lfo.start(t0);
    if (duration) { osc.stop(t0 + duration); lfo.stop(t0 + duration); }
    nodes.push(osc, lfo);
  });
  return { out, nodes };
}

function barDur(spec) { return (60 / spec.bpm) * 4; }

function scheduleBar(ctx, bus, spec, bi, t0) {
  const spb = 60 / spec.bpm;
  const chord = spec.chords[bi % spec.chords.length];
  const hum = () => (Math.random() - 0.5) * 0.012;

  for (const b of spec.bassBeats)
    Synth.bassNote(ctx, bus, t0 + b * spb + hum(), spec.root - 12 + chord[0], 0.42);

  const stepDur = spb / spec.arp.subdiv;
  spec.arp.pattern.forEach((ci, i) => {
    if (ci === null || i * stepDur >= barDur(spec)) return;
    const midi = spec.root + chord[ci % chord.length] + (spec.arp.oct || 0);
    const play = Synth[spec.arp.instr] || Synth.piano;
    play(ctx, bus, t0 + i * stepDur + hum(), midi, spec.arp.vel * 0.24 * (0.8 + Math.random() * 0.2));
  });

  if (spec.drums) {
    const step = barDur(spec) / 16;
    for (const [inst, hits] of Object.entries(spec.drums)) {
      if (!hits) continue;
      for (const [s, v] of Object.entries(hits))
        Synth[inst](ctx, bus, t0 + (+s) * step + hum() * 0.5, v);
    }
  }

  // 旋律：2 小节前奏后，每 2 小节一乐句 A A B A
  if (bi >= 2 && (bi - 2) % 2 === 0) {
    const name = spec.form[Math.floor((bi - 2) / 2) % spec.form.length];
    const phrase = spec.phrases[name];
    const repeat = Math.floor((bi - 2) / 2 / spec.form.length);
    let at = t0;
    for (const [semi, beats] of phrase) {
      if (semi !== null) {
        const lift = (repeat % 2 === 1 && Math.random() < 0.3) ? 12 : 0;
        const vel = spec.melody.vel * (0.85 + Math.random() * 0.15) * (repeat % 2 ? 0.92 : 1);
        const play = Synth[spec.melody.instr] || Synth.piano;
        play(ctx, bus, at + hum(), spec.root + spec.melody.oct + semi + lift, vel * 0.26);
      }
      at += beats * spb;
    }
  }

  const tex = spec.texture || {};
  if (tex.bowl && Math.random() < tex.bowl) Synth.bowl(ctx, bus, t0, spec.root, tex.beat, 0.5);
  if (tex.chime && Math.random() < tex.chime)
    Synth.chime(ctx, bus, t0 + Math.random() * barDur(spec) * 0.5, spec.root, 0.6);
}

/* ---------------- 实时播放 ---------------- */

class SongEngine {
  constructor() {
    this.ctx = null; this.playing = false; this.spec = null;
    this._pending = null; this._timer = null; this._barIndex = 0; this._barTime = 0;
    this._pad = null;
  }

  /** 必须在用户手势的同步调用栈里执行（点击处理器最前面，任何 await 之前）。
   *  创建并解锁 AudioContext；之后的 play() 可以在异步流程里安全调用。 */
  unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const g = buildGraph(this.ctx);
      this.master = g.master; this.bus = g.bus;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // 播一个 1 帧的静音 buffer，确保 iOS Safari 也解锁
    const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const s = this.ctx.createBufferSource();
    s.buffer = b; s.connect(this.ctx.destination); s.start(0);
  }

  async play(spec) {
    this.unlock();   // 兜底：若调用方忘了在手势里 unlock，这里再试一次
    if (this.ctx.state === 'suspended') {
      // 没有可用的用户激活 → 等待下一次任意点击时恢复，不无限挂起
      await new Promise((resolve) => {
        const tryResume = () => this.ctx.resume().then(() => {
          document.removeEventListener('pointerdown', tryResume);
          resolve();
        }).catch(() => {});
        document.addEventListener('pointerdown', tryResume);
        this.ctx.resume().then(() => {
          document.removeEventListener('pointerdown', tryResume);
          resolve();
        }).catch(() => {});
      });
    }
    if (this.playing) { this._pending = spec; return; }   // 乐句边界换歌
    this.spec = spec; this.playing = true;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0.0001, now);
    this.master.gain.exponentialRampToValueAtTime(0.9, now + 2);
    this._pad = startPad(this.ctx, this.bus, spec, now);
    this._barIndex = 0; this._barTime = now + 0.15;
    this._timer = setInterval(() => this._tick(), 150);
  }

  _tick() {
    const now = this.ctx.currentTime;
    while (this._barTime < now + 1.2) {
      if (this._pending && this._barIndex % 2 === 0) {
        this.spec = this._pending; this._pending = null; this._barIndex = 0;
        const root = Synth.midiToFreq(this.spec.root);
        this._pad.nodes.forEach((n, i) => {
          if (n.frequency && i % 2 === 0) {
            const ratio = [1, 1.5, 2][Math.floor(i / 2)];
            n.frequency.cancelScheduledValues(now);
            n.frequency.setValueAtTime(n.frequency.value, now);
            n.frequency.linearRampToValueAtTime(root * ratio, now + 3);
          }
        });
        this._pad.out.gain.setTargetAtTime(this.spec.padAmp * 0.12, now, 3);
      }
      scheduleBar(this.ctx, this.bus, this.spec, this._barIndex, this._barTime);
      this._barTime += barDur(this.spec);
      this._barIndex++;
    }
  }

  stop(fadeSec = 5) {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this._timer);
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.exponentialRampToValueAtTime(0.0001, now + fadeSec);
    const pad = this._pad;
    setTimeout(() => { try { pad.nodes.forEach(n => n.stop()); pad.out.disconnect(); } catch (_) {} },
      fadeSec * 1000 + 100);
    this._pad = null;
  }

  /** 当前节拍相位（0=拍点，→1=拍尾），用于驱动 UI 律动。未播放返回 null。 */
  beatPhase() {
    if (!this.playing || !this.spec || !this.ctx) return null;
    const spb = 60 / this.spec.bpm;
    // _barTime 是下一个已排程小节的开始，由此反推当前处于本拍的哪个位置
    const beatsUntilNextBar = (this._barTime - this.ctx.currentTime) / spb;
    const phase = ((1 - (beatsUntilNextBar % 1)) % 1 + 1) % 1;
    return { phase, spb };
  }
}

/* ---------------- 离线渲染 & 导出 ---------------- */

async function renderSong(spec, seconds = 90) {
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, Math.floor(sr * seconds), sr);
  const { master, bus } = buildGraph(ctx);
  master.gain.setValueAtTime(0.0001, 0);
  master.gain.exponentialRampToValueAtTime(0.9, 2);
  master.gain.setValueAtTime(0.9, seconds - 6);
  master.gain.exponentialRampToValueAtTime(0.0001, seconds - 0.2);
  startPad(ctx, bus, spec, 0, seconds);
  let t = 0.15, bi = 0;
  while (t < seconds - 4) {          // 结尾留混响尾巴
    scheduleBar(ctx, bus, spec, bi, t);
    t += barDur(spec); bi++;
  }
  return ctx.startRendering();
}

function audioBufferToWav(buffer) {
  const nCh = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
  const bytes = 44 + len * nCh * 2;
  const ab = new ArrayBuffer(bytes), v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, bytes - 8, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nCh * 2, true); v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, len * nCh * 2, true);
  let off = 44;
  const chs = []; for (let c = 0; c < nCh; c++) chs.push(buffer.getChannelData(c));
  for (let i = 0; i < len; i++)
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, chs[c][i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
    }
  return new Blob([ab], { type: 'audio/wav' });
}

let _lamePromise = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve(window.lamejs);
  if (_lamePromise) return _lamePromise;
  _lamePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    s.onload = () => window.lamejs ? resolve(window.lamejs) : reject(new Error('lamejs 加载异常'));
    s.onerror = () => reject(new Error('lamejs 加载失败'));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('lamejs 加载超时')), 10000);
  });
  return _lamePromise;
}

function encodeMp3(buffer, lame, kbps = 128) {
  const sr = buffer.sampleRate;
  const enc = new lame.Mp3Encoder(2, sr, kbps);
  const l = buffer.getChannelData(0), r = buffer.getChannelData(1) || l;
  const toI16 = (f) => {
    const a = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      a[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return a;
  };
  const li = toI16(l), ri = toI16(r);
  const chunks = [], block = 1152;
  for (let i = 0; i < li.length; i += block) {
    const d = enc.encodeBuffer(li.subarray(i, i + block), ri.subarray(i, i + block));
    if (d.length) chunks.push(new Uint8Array(d));
  }
  const end = enc.flush();
  if (end.length) chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: 'audio/mpeg' });
}

/** 导出：优先 mp3，lamejs 不可用时回落 wav。onProgress(阶段文案) 可选。 */
async function exportSong(spec, { seconds = 90, onProgress } = {}) {
  onProgress && onProgress('正在把这首歌完整写下来…');
  const buffer = await renderSong(spec, seconds);
  try {
    onProgress && onProgress('正在装进 mp3…');
    const lame = await loadLame();
    return { blob: encodeMp3(buffer, lame), ext: 'mp3' };
  } catch (_) {
    onProgress && onProgress('mp3 组件不可用，用无损 wav 保存…');
    return { blob: audioBufferToWav(buffer), ext: 'wav' };
  }
}

/* ---------------- 倾诉文本 → 情绪 + 寄语（与 v3 相同） ---------------- */

const EMOTION_KEYWORDS = {
  '愤怒': '生气 愤怒 气死 火大 恨 烦死 凭什么 不公平 欺负 背叛 怒 讨厌他 讨厌她 受够',
  '悲伤': '难过 委屈 失落 孤独 想念 哭 眼泪 疲惫 心疼 遗憾 失去 分手 离开 想他 想她 伤心 沉 撑不住',
  '恐惧': '害怕 恐惧 担心 焦虑 不安 紧张 慌 怕 惶恐 睡不着 万一 失控',
  '厌恶': '恶心 厌恶 反感 嫌弃 受不了 虚伪 恶臭 腻 讨厌这种',
  '惊讶': '没想到 竟然 突然 意外 惊讶 懵 不敢相信 怎么会',
  '喜悦': '开心 高兴 快乐 幸福 喜欢 笑 幸运 期待 心动 太好了 兴奋',
  '平静': '平静 放下 释然 安静 还好 淡淡 接受',
};

const DEDICATIONS = {
  '愤怒': '这团火你没有压下去，也没有烧到别人。它在这首歌里，有节奏地烧。',
  '悲伤': '这首歌不催你好起来。它只是坐在你旁边，陪你把这段慢慢听完。',
  '恐惧': '心跳还在，这首歌跟着它走。你不用现在就不怕。',
  '厌恶': '有些东西你不必接受。这首歌替你保持了一点距离。',
  '惊讶': '生活突然转了个弯。这首歌陪你在弯道上站一会儿。',
  '喜悦': '这份亮晶晶的心情，做成了一首会跳的歌。',
  '平静': '今天的你是稳的。这首歌就照着你的呼吸写。',
};

function analyzeConfessionLocal(text) {
  const t = String(text || '');
  let best = '平静', bestScore = 0;
  for (const [emo, words] of Object.entries(EMOTION_KEYWORDS)) {
    let score = 0;
    for (const w of words.split(' ')) {
      let i = -1;
      while ((i = t.indexOf(w, i + 1)) !== -1) score++;
    }
    if (score > bestScore) { best = emo; bestScore = score; }
  }
  return { emotion: best, dedication: DEDICATIONS[best] };
}

async function analyzeConfessionLLM(text, { apiKey, baseUrl, model }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, temperature: 0.5,
      messages: [
        { role: 'system', content:
`用户刚完成一段情绪倾诉。判断其主导情绪并写一句歌的寄语，只输出 JSON：
{"emotion":"愤怒|悲伤|恐惧|厌恶|惊讶|喜悦|平静 之一",
"dedication":"一句30字内的中文寄语。温柔、具体地呼应用户说的事，但：不评判、不建议、不诊断、不复述敏感细节、不说你应该。语气像把一首写好的歌递给对方。"}
若倾诉中出现自伤他伤的表述，emotion 照常判断，dedication 固定为：这首歌先陪着你。也请让身边的人或专业的声音陪陪你。` },
        { role: 'user', content: String(text).slice(0, 2000) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  const j = JSON.parse(data.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
  const emotion = Object.keys(EMOTION_RULES).includes(j.emotion) ? j.emotion : '平静';
  return { emotion, dedication: String(j.dedication || '').slice(0, 60) || DEDICATIONS[emotion] };
}

if (typeof module !== 'undefined')
  module.exports = { composeSong, SongEngine, exportSong, renderSong,
                     analyzeConfessionLocal, analyzeConfessionLLM };

if (typeof window !== 'undefined') {
  window.composeSong = composeSong;
  window.SongEngine = SongEngine;
  window.exportSong = exportSong;
  window.renderSong = renderSong;
  window.analyzeConfessionLocal = analyzeConfessionLocal;
  window.analyzeConfessionLLM = analyzeConfessionLLM;
  window.audioBufferToWav = audioBufferToWav;
}
