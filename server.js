const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data", "transcripts");
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// ==== LLM 通道（openai-next，与 ember_music 共用；环境变量可覆盖）====
const LLM_BASE_URL = process.env.LLM_BASE_URL || process.env.EMBER_OPENAI_BASE_URL || "https://api.openai-next.com/v1";
const LLM_API_KEY =
  process.env.LLM_API_KEY ||
  process.env.EMBER_OPENAI_KEY ||
  "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const STT_MODEL = process.env.STT_MODEL || "whisper-1";

// ==== 音乐服务（music_service.py，本进程托管）====
const MUSIC_PORT = Number(process.env.EMBER_PORT || 5174);
const MUSIC_URL = `http://127.0.0.1:${MUSIC_PORT}`;
const EMOTIONS_7 = ["愤怒", "厌恶", "恐惧", "喜悦", "平静", "悲伤", "惊讶"];

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

const EMOTION_KEYWORDS = [
  { emotion: "愤怒", words: ["愤怒", "生气", "火大", "气死", "烦躁", "不甘", "冒犯", "委屈", "批评", "指责", "不公平"] },
  { emotion: "悲伤", words: ["难过", "悲伤", "失落", "孤独", "疲惫", "想哭", "哭", "难受", "心酸", "忽略", "离开"] },
  { emotion: "恐惧", words: ["害怕", "恐惧", "担心", "焦虑", "慌", "紧张", "怕", "不安", "崩溃"] },
  { emotion: "喜悦", words: ["开心", "高兴", "快乐", "兴奋", "满足", "感恩", "喜欢", "期待", "骄傲"] },
  { emotion: "惊讶", words: ["惊讶", "震惊", "意外", "没想到", "突然", "困惑"] },
  { emotion: "厌恶", words: ["厌恶", "恶心", "反感", "讨厌", "排斥"] },
];

function localIsoString(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const pad = (value, length = 2) => String(value).padStart(length, "0");

  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
    ".",
    pad(date.getMilliseconds(), 3),
    sign,
    pad(Math.floor(abs / 60)),
    ":",
    pad(abs % 60),
  ].join("");
}

function emptyRecord({ userId = "local_user", inputMode = "video+text" } = {}) {
  const sessionId = crypto.randomUUID();
  const timestamp = localIsoString();

  return {
    userId,
    sessionId,
    timestamp,
    inputMode,
    textInput: "",
    videoTranscript: "",
    aiSummary: "",
    faceDetected: false,
    videoQuality: "unreadable",
    voiceSpeed: "",
    voiceVolume: "",
    crying: false,
    sighing: false,
    dominantEmotion: "平静",
    overallIntensity: 0,
    musicGenerationInput: {
      text: "",
      dominantEmotion: "平静",
      overallIntensity: 0,
      sourceFields: ["textInput", "videoTranscript", "aiSummary"],
    },
    raw: {
      interimTranscript: "",
      transcriptEvents: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function sanitizeSessionId(sessionId) {
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId || "")) {
    throw Object.assign(new Error("Invalid sessionId"), { status: 400 });
  }
  return sessionId;
}

function recordPath(sessionId) {
  return path.join(DATA_DIR, `${sanitizeSessionId(sessionId)}.json`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function trimText(value, max = 20000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function analyzeText(text) {
  const normalized = trimText(text);
  if (!normalized) {
    return {
      aiSummary: "",
      dominantEmotion: "平静",
      overallIntensity: 0,
    };
  }

  const scores = new Map();
  for (const item of EMOTION_KEYWORDS) {
    let score = 0;
    for (const word of item.words) {
      const matches = normalized.match(new RegExp(word, "g"));
      if (matches) score += matches.length;
    }
    scores.set(item.emotion, score);
  }

  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const [dominantEmotion, hitCount] = sorted[0] || ["平静", 0];
  const punctuationIntensity = (normalized.match(/[!！。…]/g) || []).length;
  const lengthIntensity = Math.min(36, Math.floor(normalized.length / 12));
  const overallIntensity = hitCount
    ? clamp(32 + hitCount * 16 + punctuationIntensity * 4 + lengthIntensity, 1, 100)
    : clamp(8 + lengthIntensity, 0, 35);

  const summarySource = normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
  const aiSummary = hitCount
    ? `用户围绕「${summarySource}」表达，核心情绪偏向${dominantEmotion}。`
    : `用户表达了「${summarySource}」，当前情绪较为平静或尚未清晰命名。`;

  return {
    aiSummary,
    dominantEmotion: hitCount ? dominantEmotion : "平静",
    overallIntensity,
  };
}

function estimateVoiceSpeed(event) {
  if (event.voiceSpeed) return event.voiceSpeed;
  const text = trimText(event.text);
  const durationMs = Number(event.durationMs || 0);
  if (!text || !durationMs) return "";

  const charsPerMinute = text.length / (durationMs / 60000);
  if (charsPerMinute < 140) return "slow";
  if (charsPerMinute > 260) return "fast";
  return "normal";
}

function normalizeVolume(value) {
  if (["low", "normal", "high"].includes(value)) return value;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "";
  if (numberValue < 0.04) return "low";
  if (numberValue > 0.16) return "high";
  return "normal";
}

function refreshDerivedFields(record) {
  const text = trimText([record.textInput, record.videoTranscript].filter(Boolean).join(" "));
  const analysis = analyzeText(text);

  // LLM 已给出的判断（imagery 接口写入）优先于关键词兜底
  const llm = record.llmAnalysis || {};
  record.aiSummary = llm.aiSummary || analysis.aiSummary;
  record.dominantEmotion = llm.dominantEmotion || analysis.dominantEmotion;
  record.overallIntensity = Number.isFinite(llm.overallIntensity)
    ? llm.overallIntensity
    : analysis.overallIntensity;
  record.timestamp = localIsoString();
  record.musicGenerationInput = {
    text: record.aiSummary || text,
    dominantEmotion: record.dominantEmotion,
    overallIntensity: record.overallIntensity,
    sourceFields: ["textInput", "videoTranscript", "aiSummary"],
  };
  record.raw.updatedAt = record.timestamp;
  return record;
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readRecord(sessionId) {
  const content = await fs.readFile(recordPath(sessionId), "utf8");
  return JSON.parse(content);
}

async function writeRecord(record) {
  await ensureDataDir();
  const filePath = recordPath(record.sessionId);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function listRecords() {
  await ensureDataDir();
  const files = await fs.readdir(DATA_DIR);
  const records = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const content = await fs.readFile(path.join(DATA_DIR, file), "utf8");
    const record = JSON.parse(content);
    records.push({
      userId: record.userId,
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      inputMode: record.inputMode,
      dominantEmotion: record.dominantEmotion,
      overallIntensity: record.overallIntensity,
      transcriptLength: record.videoTranscript.length,
    });
  }
  return records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(Object.assign(new Error("Invalid JSON body"), { status: 400, cause: error }));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req, maxBytes = MAX_AUDIO_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ==== LLM 基建 ====
function extractJson(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("LLM 输出中没有 JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callLLM(systemPrompt, userContent, { maxTokens = 900, temperature = 0.8, retries = 1 } = {}) {
  if (!LLM_API_KEY) throw new Error("LLM_API_KEY/EMBER_OPENAI_KEY 未配置");

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
      const data = await response.json();
      return extractJson(data.choices?.[0]?.message?.content);
    } catch (error) {
      lastError = error;
      console.warn(`[llm] 调用失败（第 ${attempt + 1} 次）: ${error.message}`);
    }
  }
  throw lastError;
}

const IMAGERY_SYSTEM_PROMPT = `你是一位温柔的心理陪伴者。用户刚刚倾诉了一段心事。请从中提炼 2-7 个「意象」——具体的、有画面感的名词短语（人、事、物、场景、感觉），必须来自用户自己的话，不要发明用户没提到的内容。
每个意象给出：
- word: 意象短语（2-8 个字，如"加班的深夜"、"妈妈的电话"）
- essence: 一句不超过 20 字的温柔注解（描述它承载了什么，不评判、不建议）
- color: 一个柔和的十六进制颜色（低饱和玻璃质感，与该意象的情绪气质匹配）
- weight: 1-5 的整数，它在这段倾诉里的分量
同时给出对整段倾诉的判断：
- dominantEmotion: 主情绪，必须是【愤怒/厌恶/恐惧/喜悦/平静/悲伤/惊讶】之一
- overallIntensity: 0-100 的整数，情绪强度
- aiSummary: 不超过 60 字的情绪核心描述（第三人称，温柔、不评判）
只输出 JSON：{"imagery":[{"word":"…","essence":"…","color":"#AABBCC","weight":3}],"dominantEmotion":"…","overallIntensity":50,"aiSummary":"…"}
如果文本太短提炼不出意象，imagery 输出空数组，其余字段照常给出。`;

const NAMING_SYSTEM_PROMPT = `根据用户提供的意象和情绪，为一件金缮玻璃艺术品起 3 个名字。
要求：每个 4-10 个字；诗意、轻盈、略带超现实的无意义感；不要出现"治愈""伤痛""心理""情绪"这类直白词；可以把意象词与器物或自然物（灯、翼、星、舟、铃、雾、屿、汽水、苔）做陌生化组合。
只输出 JSON：{"names":["…","…","…"]}`;

const CLOSING_SYSTEM_PROMPT = `用户倾诉了一段心事，并把这份情绪做成了一件玻璃作品。请写一句不超过 40 字的回应。
要求：必须引用或呼应用户自己说过的具体内容；温柔、具体、不评判；不下诊断，不说"你应该"，不用通用安慰语（如"一切都会好起来"）。
只输出 JSON：{"reply":"…"}`;

function mergeImagery(existing, incoming) {
  const merged = Array.isArray(existing) ? [...existing] : [];
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (!item || typeof item.word !== "string" || !item.word.trim()) continue;
    const clean = {
      word: trimText(item.word, 16),
      essence: trimText(item.essence, 40),
      color: /^#[0-9a-fA-F]{6}$/.test(item.color || "") ? item.color : "#8FA8C0",
      weight: clamp(Number(item.weight) || 3, 1, 5),
    };
    const found = merged.find((m) => m.word === clean.word);
    if (found) Object.assign(found, clean);
    else merged.push(clean);
  }
  return merged.slice(0, 7);
}

// ==== 音乐异步任务（内存表，进程重启即失效，落盘结果在 record.music）====
const musicJobs = new Map(); // sessionId -> { status, startedAt, result, error }

async function startMusicJob(record) {
  const sessionId = record.sessionId;
  const existing = musicJobs.get(sessionId);
  if (existing && existing.status !== "failed") return existing;

  const job = { status: "pending", startedAt: Date.now(), result: null, error: null };
  musicJobs.set(sessionId, job);

  (async () => {
    try {
      const response = await fetch(`${MUSIC_URL}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emotion: EMOTIONS_7.includes(record.dominantEmotion) ? record.dominantEmotion : "平静",
          intensity: record.overallIntensity || 0,
          aiSummary: record.aiSummary || "",
          textInput: trimText([record.textInput, record.videoTranscript].filter(Boolean).join(" "), 2000),
          sessionId,
        }),
        signal: AbortSignal.timeout(120000),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "music service error");
      job.status = "ready";
      job.result = data.result;
      const fresh = await readRecord(sessionId);
      fresh.music = {
        url: data.result.url,
        title: data.result.title,
        source: data.result.source,
        emotion: data.result.emotion,
        intensity: data.result.intensity,
        elapsedSec: data.result.elapsed_sec,
      };
      await writeRecord(fresh);
    } catch (error) {
      console.warn(`[music] 生成失败 (${sessionId}): ${error.message}`);
      job.status = "failed";
      job.error = error.message;
    }
  })();

  return job;
}

function musicJobPayload(sessionId, record) {
  const job = musicJobs.get(sessionId);
  if (record.music && record.music.url) return { status: "ready", music: record.music };
  if (!job) return { status: "none" };
  return { status: job.status, error: job.error, music: job.result ? {
    url: job.result.url, title: job.result.title, source: job.result.source,
  } : null };
}

// ==== 语音转写代理（key 不进前端）====
async function handleTranscribeProxy(req, res) {
  if (!LLM_API_KEY) {
    sendJson(res, 503, {
      ok: false,
      fallback: true,
      error: "语音转写服务未配置 LLM_API_KEY/EMBER_OPENAI_KEY",
    });
    return;
  }

  const contentType = req.headers["content-type"] || "";
  const body = await readRawBody(req);
  const response = await fetch(`${LLM_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { "Content-Type": contentType, Authorization: `Bearer ${LLM_API_KEY}` },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") || "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readBody(req);
    const record = emptyRecord({
      userId: trimText(body.userId || "local_user", 120),
      inputMode: body.inputMode || "video+text",
    });
    await writeRecord(record);
    sendJson(res, 201, { ok: true, record });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/records") {
    sendJson(res, 200, { ok: true, records: await listRecords() });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === "GET" && sessionMatch) {
    sendJson(res, 200, { ok: true, record: await readRecord(sessionMatch[1]) });
    return;
  }

  const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (req.method === "PATCH" && transcriptMatch) {
    const body = await readBody(req);
    const record = await readRecord(transcriptMatch[1]);
    const text = trimText(body.text);
    const now = localIsoString();
    const event = {
      id: crypto.randomUUID(),
      at: now,
      text,
      isFinal: Boolean(body.isFinal),
      source: body.source || "speechRecognition",
      confidence: Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : null,
      durationMs: Number.isFinite(Number(body.durationMs)) ? Number(body.durationMs) : null,
      voiceVolume: normalizeVolume(body.voiceVolume),
    };

    if (event.isFinal) {
      record.videoTranscript = trimText([record.videoTranscript, text].filter(Boolean).join(" "));
      record.raw.interimTranscript = "";
    } else {
      record.raw.interimTranscript = text;
    }

    record.voiceSpeed = estimateVoiceSpeed(event) || record.voiceSpeed;
    record.voiceVolume = event.voiceVolume || record.voiceVolume;
    record.raw.transcriptEvents.push(event);
    if (record.raw.transcriptEvents.length > 600) {
      record.raw.transcriptEvents = record.raw.transcriptEvents.slice(-600);
    }

    refreshDerivedFields(record);
    await writeRecord(record);
    sendJson(res, 200, { ok: true, record });
    return;
  }

  const textMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/text$/);
  if (req.method === "PATCH" && textMatch) {
    const body = await readBody(req);
    const record = await readRecord(textMatch[1]);
    record.textInput = trimText(body.textInput);
    refreshDerivedFields(record);
    await writeRecord(record);
    sendJson(res, 200, { ok: true, record });
    return;
  }

  // ---- 意象提炼（可多次调用，增量合并）----
  const imageryMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/imagery$/);
  if (req.method === "POST" && imageryMatch) {
    const record = await readRecord(imageryMatch[1]);
    const text = trimText([record.textInput, record.videoTranscript].filter(Boolean).join(" "), 4000);
    if (text.length < 6) {
      sendJson(res, 200, { ok: true, fallback: true, reason: "text too short", imagery: record.imagery || [] });
      return;
    }
    try {
      const out = await callLLM(IMAGERY_SYSTEM_PROMPT, `用户的倾诉内容：\n${text}`);
      record.imagery = mergeImagery(record.imagery, out.imagery);
      record.llmAnalysis = {
        dominantEmotion: EMOTIONS_7.includes(out.dominantEmotion) ? out.dominantEmotion : undefined,
        overallIntensity: Number.isFinite(Number(out.overallIntensity))
          ? clamp(Number(out.overallIntensity), 0, 100) : undefined,
        aiSummary: trimText(out.aiSummary, 200) || undefined,
      };
      refreshDerivedFields(record);
      await writeRecord(record);
      sendJson(res, 200, {
        ok: true, imagery: record.imagery,
        dominantEmotion: record.dominantEmotion, overallIntensity: record.overallIntensity,
      });
    } catch (error) {
      console.warn(`[imagery] LLM 失败: ${error.message}`);
      sendJson(res, 200, { ok: false, fallback: true, imagery: record.imagery || [] });
    }
    return;
  }

  // ---- 作品命名 ----
  const nameMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artwork-name$/);
  if (req.method === "POST" && nameMatch) {
    const record = await readRecord(nameMatch[1]);
    const imageryWords = (record.imagery || []).map((i) => `${i.word}（${i.essence}）`).join("、");
    try {
      const out = await callLLM(
        NAMING_SYSTEM_PROMPT,
        `意象：${imageryWords || "（无）"}\n主情绪：${record.dominantEmotion}，强度 ${record.overallIntensity}/100`,
        { maxTokens: 200 },
      );
      const names = (Array.isArray(out.names) ? out.names : [])
        .map((n) => trimText(n, 14)).filter(Boolean).slice(0, 3);
      if (!names.length) throw new Error("empty names");
      record.artwork = { ...(record.artwork || {}), candidates: names };
      await writeRecord(record);
      sendJson(res, 200, { ok: true, names });
    } catch (error) {
      console.warn(`[artwork-name] LLM 失败: ${error.message}`);
      sendJson(res, 200, { ok: false, fallback: true });
    }
    return;
  }

  // ---- 结尾具体回应 ----
  const closingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/closing$/);
  if (req.method === "POST" && closingMatch) {
    const body = await readBody(req);
    const record = await readRecord(closingMatch[1]);
    const text = trimText([record.textInput, record.videoTranscript].filter(Boolean).join(" "), 3000);
    try {
      const out = await callLLM(
        CLOSING_SYSTEM_PROMPT,
        `用户的倾诉：\n${text || "（用户没有留下文字）"}\n\n作品名：《${trimText(body.name, 20) || "未命名"}》`,
        { maxTokens: 150 },
      );
      const reply = trimText(out.reply, 80);
      if (!reply) throw new Error("empty reply");
      record.closingReply = reply;
      await writeRecord(record);
      sendJson(res, 200, { ok: true, reply });
    } catch (error) {
      console.warn(`[closing] LLM 失败: ${error.message}`);
      sendJson(res, 200, { ok: false, fallback: true });
    }
    return;
  }

  // ---- 音乐：POST 触发异步生成，GET 轮询 ----
  const musicMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/music$/);
  if (musicMatch) {
    const record = await readRecord(musicMatch[1]);
    if (req.method === "POST") {
      await startMusicJob(record);
      sendJson(res, 202, { ok: true, ...musicJobPayload(record.sessionId, record) });
      return;
    }
    if (req.method === "GET") {
      sendJson(res, 200, { ok: true, ...musicJobPayload(record.sessionId, record) });
      return;
    }
  }

  // ---- 元数据（作品名 / 拼接数据 / 镜像猜测等，白名单合并）----
  const metaMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/meta$/);
  if (req.method === "PATCH" && metaMatch) {
    const body = await readBody(req);
    const record = await readRecord(metaMatch[1]);
    if (typeof body.artworkName === "string") {
      record.artwork = { ...(record.artwork || {}), name: trimText(body.artworkName, 20) };
    }
    if (Array.isArray(body.composition)) {
      record.artwork = { ...(record.artwork || {}), composition: body.composition.slice(0, 60) };
    }
    if (typeof body.mirrorGuess === "string") record.mirrorGuess = trimText(body.mirrorGuess, 10);
    if (typeof body.inputMode === "string") record.inputMode = trimText(body.inputMode, 20);
    record.raw.updatedAt = localIsoString();
    await writeRecord(record);
    sendJson(res, 200, { ok: true, record });
    return;
  }

  sendJson(res, 404, { ok: false, error: "API route not found" });
}

async function serveStatic(req, res, url) {
  const requestPath = decodeURIComponent(url.pathname === "/" ? "/factory.html" : url.pathname);
  const baseDir = requestPath.startsWith("/data/audio/") ? ROOT : PUBLIC_DIR;
  const filePath = path.normalize(path.join(baseDir, requestPath));

  if (!filePath.startsWith(baseDir)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(await fs.readFile(filePath));
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "POST" && url.pathname === "/api/proxy/audio/transcriptions") {
      await handleTranscribeProxy(req, res);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, {
      ok: false,
      error: status === 500 ? "Internal server error" : error.message,
    });
    if (status === 500) console.error(error);
  }
});

// ==== 托管音乐服务子进程（.venv 缺失时跳过，前端自动降级）====
function startMusicService() {
  const python = path.join(ROOT, ".venv", "bin", "python");
  const script = path.join(ROOT, "services", "music_service.py");
  const child = spawn(python, [script], { env: { ...process.env, EMBER_PORT: String(MUSIC_PORT) } });
  child.stdout.on("data", (d) => process.stdout.write(d));
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("error", (e) => console.warn(`[music] 子进程启动失败（音乐功能降级）: ${e.message}`));
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.warn(`[music] 子进程退出 code=${code}`);
  });
  process.on("exit", () => child.kill());
  process.on("SIGINT", () => { child.kill(); process.exit(0); });
  process.on("SIGTERM", () => { child.kill(); process.exit(0); });
  return child;
}

if (process.env.EMBER_EXTERNAL !== "1") startMusicService();

server.listen(PORT, () => {
  console.log(`Ember local server running at http://localhost:${PORT}/`);
  console.log(`Transcript records will be saved in ${DATA_DIR}`);
});
