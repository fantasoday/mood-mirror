// emotion-engine.js
// 共用的情绪识别引擎：MediaPipe Face Landmarker
// - 只在本地运行，不上传任何画面
// - 输出 blendshape 系数、平滑信号、情绪分类、头部姿态/视线
//
// 用法：
//   import { EmotionEngine } from "./emotion-engine.js";
//   const engine = new EmotionEngine({ video, onFrame, onStatus });
//   await engine.init();   // 需在用户点击后调用（浏览器要求手势才能开摄像头）

// 注意：@mediapipe/tasks-vision@0.10.14 的 wasm loader 有已知回归
// （加载时报 "dbg is not a function"）。这里改用稳定版 0.10.8。
// import 只能用字符串字面量，所以版本号写死在这一行；WASM_URL 用同一版本。
import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/vision_bundle.mjs";

const MP_VERSION = "0.10.8"; // 必须和上面 import 的版本一致
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class EmotionEngine {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video   用于承载摄像头画面的 <video>（可隐藏）
   * @param {(data:object)=>void} opts.onFrame  每帧回调
   * @param {(msg:string)=>void} opts.onStatus  状态文字回调
   * @param {number} [opts.smoothing=0.35]  平滑系数（越小越平滑）
   */
  constructor({ video, onFrame, onStatus, smoothing = 0.35 } = {}) {
    this.video = video;
    this.onFrame = onFrame || (() => {});
    this.onStatus = onStatus || (() => {});
    this.smoothing = smoothing;
    this.landmarker = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.smooth = {}; // 平滑后的 blendshape
    this._fps = 0;
    this._lastT = 0;
  }

  async init() {
    try {
      this.onStatus("加载模型中…");
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      const makeOpts = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });
      try {
        this.landmarker = await FaceLandmarker.createFromOptions(
          fileset,
          makeOpts("GPU")
        );
      } catch (gpuErr) {
        // 某些机器/浏览器 GPU 代理不可用，降级到 CPU
        console.warn("GPU 代理失败，改用 CPU：", gpuErr);
        this.onStatus("GPU 不可用，改用 CPU…");
        this.landmarker = await FaceLandmarker.createFromOptions(
          fileset,
          makeOpts("CPU")
        );
      }

      this.onStatus("开启摄像头…");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      this.video.srcObject = stream;
      await this.video.play();

      this.onStatus("运行中");
      this.running = true;
      this._loop();
    } catch (e) {
      console.error(e);
      this.onStatus("出错了：" + (e?.message || e));
      throw e;
    }
  }

  stop() {
    this.running = false;
    const s = this.video?.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();
    if (
      this.video.currentTime !== this.lastVideoTime &&
      this.video.videoWidth > 0
    ) {
      this.lastVideoTime = this.video.currentTime;
      // FPS
      if (this._lastT) this._fps = 1000 / (now - this._lastT || 1);
      this._lastT = now;
      try {
        const res = this.landmarker.detectForVideo(this.video, now);
        this._process(res);
      } catch (e) {
        // 偶发的时间戳异常忽略即可
      }
    }
    requestAnimationFrame(() => this._loop());
  }

  _process(res) {
    const cats = res.faceBlendshapes?.[0]?.categories;
    const lms = res.faceLandmarks?.[0];
    if (!cats) {
      this.onFrame({ present: false, fps: this._fps });
      return;
    }

    const raw = {};
    for (const c of cats) raw[c.categoryName] = c.score;

    // 指数平滑
    const a = this.smoothing;
    for (const k in raw) {
      this.smooth[k] =
        this.smooth[k] == null ? raw[k] : this.smooth[k] * (1 - a) + raw[k] * a;
    }
    const g = (n) => this.smooth[n] ?? 0;

    const signals = {
      smile: (g("mouthSmileLeft") + g("mouthSmileRight")) / 2,
      frown: (g("mouthFrownLeft") + g("mouthFrownRight")) / 2,
      jawOpen: g("jawOpen"),
      browUp: Math.max(
        g("browInnerUp"),
        (g("browOuterUpLeft") + g("browOuterUpRight")) / 2
      ),
      browInnerUp: g("browInnerUp"),
      browDown: (g("browDownLeft") + g("browDownRight")) / 2,
      blinkL: g("eyeBlinkLeft"),
      blinkR: g("eyeBlinkRight"),
      blink: (g("eyeBlinkLeft") + g("eyeBlinkRight")) / 2,
      eyeWide: (g("eyeWideLeft") + g("eyeWideRight")) / 2,
      pucker: g("mouthPucker"),
      cheek: (g("cheekSquintLeft") + g("cheekSquintRight")) / 2,
      mouthPress: (g("mouthPressLeft") + g("mouthPressRight")) / 2,
      // 补充：难过/生气相关的肌肉信号
      noseSneer: (g("noseSneerLeft") + g("noseSneerRight")) / 2,
      mouthLowerDown: (g("mouthLowerDownLeft") + g("mouthLowerDownRight")) / 2,
      mouthStretch: (g("mouthStretchLeft") + g("mouthStretchRight")) / 2,
    };

    // 粗粒度情绪打分（黑客松够用，之后可换成小模型分类）
    const scores = {
      happy: signals.smile * 1.3 + signals.cheek * 0.4,
      surprised:
        signals.jawOpen * 0.7 + signals.eyeWide * 0.9 + signals.browUp * 0.5,
      // 提高「难过」灵敏度：撇嘴 + 内眉上扬 + 下唇下拉都计入，权重加大
      sad:
        signals.frown * 2.2 +
        signals.browInnerUp * 1.3 +
        signals.mouthLowerDown * 0.8,
      // 提高「生气」灵敏度：压眉 + 抿嘴用力 + 皱鼻，权重加大
      angry:
        signals.browDown * 2.6 +
        signals.mouthPress * 1.2 +
        signals.noseSneer * 0.9,
      neutral: 0.13, // 阈值调低，情绪更容易盖过「平静」
    };
    let emotion = "neutral";
    let best = -1;
    for (const k in scores) {
      if (scores[k] > best) {
        best = scores[k];
        emotion = k;
      }
    }

    const head = this._head(lms);

    this.onFrame({
      present: true,
      raw,
      smooth: this.smooth,
      signals,
      emotion,
      scores,
      head,
      landmarks: lms,
      fps: this._fps,
    });
  }

  // 头部姿态 + 视线（用关键点几何近似，够卡通用）
  _head(lms) {
    if (!lms) return { yaw: 0, pitch: 0, roll: 0, gazeX: 0, gazeY: 0 };
    const L = lms[33]; // 左眼外角
    const R = lms[263]; // 右眼外角
    const nose = lms[1]; // 鼻尖
    const midX = (L.x + R.x) / 2;
    const midY = (L.y + R.y) / 2;
    const eyeDist = Math.hypot(R.x - L.x, R.y - L.y) || 0.001;

    const yaw = (nose.x - midX) / eyeDist; // 左右转头
    const pitch = (nose.y - midY) / eyeDist; // 上下点头
    const roll = Math.atan2(R.y - L.y, R.x - L.x); // 歪头（弧度）

    // 视线：用虹膜中心相对眼角的位置（模型默认输出 478 点含虹膜）
    let gazeX = 0;
    let gazeY = 0;
    if (lms.length >= 478) {
      const li = lms[468]; // 左虹膜中心
      const ri = lms[473]; // 右虹膜中心
      const lgx =
        (li.x - (lms[33].x + lms[133].x) / 2) /
        (Math.abs(lms[133].x - lms[33].x) || 0.001);
      const rgx =
        (ri.x - (lms[263].x + lms[362].x) / 2) /
        (Math.abs(lms[362].x - lms[263].x) || 0.001);
      gazeX = (lgx + rgx) / 2;
      const lgy =
        (li.y - (lms[159].y + lms[145].y) / 2) /
        (Math.abs(lms[145].y - lms[159].y) || 0.001);
      const rgy =
        (ri.y - (lms[386].y + lms[374].y) / 2) /
        (Math.abs(lms[374].y - lms[386].y) || 0.001);
      gazeY = (lgy + rgy) / 2;
    }
    return {
      yaw: clamp(yaw, -1, 1),
      pitch: clamp(pitch, -1, 1),
      roll,
      gazeX: clamp(gazeX, -1.5, 1.5),
      gazeY: clamp(gazeY, -1.5, 1.5),
    };
  }
}

// 给两版渲染复用的常量
export const EMOTION_META = {
  happy: { label: "开心", emoji: "😊", msg: "感受到你的好心情，把它留住 ✨", bg: ["#FFE29F", "#FFA99F"] },
  sad: { label: "难过", emoji: "🥺", msg: "没关系，慢慢来，我陪着你 🫂", bg: ["#A1C4FD", "#C2E9FB"] },
  surprised: { label: "惊讶", emoji: "😮", msg: "发生了什么有趣的事吗？", bg: ["#A0F1EA", "#C7F9E3"] },
  angry: { label: "生气", emoji: "😤", msg: "深呼吸，先陪自己坐一会儿 🌊", bg: ["#FBC2C4", "#F6A6A6"] },
  neutral: { label: "平静", emoji: "🙂", msg: "此刻很平静，试着感受呼吸的节奏 🍃", bg: ["#E0C3FC", "#D3E4CD"] },
};

export { clamp };
