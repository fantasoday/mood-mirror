const http = require("node:http");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env.local");
  if (!fsSync.existsSync(envPath)) return;

  const text = fsSync.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = normalized.indexOf("=");
    if (eq <= 0) continue;

    const key = normalized.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;

    let value = normalized.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadLocalEnv();

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
    : `用户留下了「${summarySource}」。`;

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

async function callLLM(systemPrompt, userContent, { maxTokens = 900, temperature = 0.8, retries = 1, model = LLM_MODEL, responseFormat = null } = {}) {
  if (!LLM_API_KEY) throw new Error("LLM_API_KEY/EMBER_OPENAI_KEY 未配置");

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const payload = {
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      };
      if (responseFormat) payload.response_format = responseFormat;
      const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify(payload),
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

const IMAGERY_SYSTEM_PROMPT = `你是一位温柔的心理陪伴者。用户刚刚倾诉了一段心事。请按内容丰富度提炼 5-12 个「意象词」——必须是单个词汇或很短的名词，不要输出句子、问题、多个词拼在一起的短语。必须来自用户自己的话，不要发明用户没提到的内容。用户说得越多，意象数量应该越多；至少 5 个，越丰富越好。
每个意象给出：
- word: 单个意象词（2-4 个字优先，如"加班"、"妈妈"、"电话"、"压力"、"房间"、"考试"、"失眠"、"分手"；不要输出"天气怎么样你吃饭了吗"这种句子）
- essence: 一句不超过 20 字的温柔注解（描述它承载了什么，不评判、不建议）
- color: 一个柔和的十六进制颜色（低饱和玻璃质感，与该意象的情绪气质匹配）
- weight: 1-5 的整数，它在这段倾诉里的分量
同时给出对整段倾诉的判断：
- dominantEmotion: 主情绪，必须是【愤怒/厌恶/恐惧/喜悦/平静/悲伤/惊讶】之一
- overallIntensity: 0-100 的整数，情绪强度
- aiSummary: 不超过 60 字的情绪核心描述（第三人称，温柔、不评判）
只输出 JSON：{"imagery":[{"word":"…","essence":"…","color":"#AABBCC","weight":3}],"dominantEmotion":"…","overallIntensity":50,"aiSummary":"…"}
如果文本太短提炼不出意象，imagery 输出空数组，其余字段照常给出。`;

// 实时分析：用户还在说/打字时快速反馈，用 gpt-4o-mini 图快
const LIVE_ANALYZE_SYSTEM_PROMPT = `你是实时倾听用户倾诉的陪伴者。文本可能不完整，可能带 *叹气* *哭泣* *沉默* *颤抖* *深呼吸* 等非语言标记——这些是强烈情绪信号，请显著提高 intensity。

你要输出 JSON：
- emotion: 主情绪，必须是【愤怒/厌恶/恐惧/喜悦/平静/悲伤/惊讶】之一
- intensity: 0-100 整数，情绪强度（有哭声/颤抖/叹气 → 至少 60）
- summary: ≤30 字的第三人称概要（"她因分手而心痛" 这种），温柔具体
- worries: **情绪锚点**数组，每项 {word, weight}

【情绪锚点的严格定义】不是抽取名词，而是挑出用户情绪里那些带着重量的事物。每个候选词都必须同时通过 3 个检查：

Q1 具象或情感明确吗？可以是能画出画面的具体事物（"妈妈"、"深夜"、"电话"），或带明确情绪的抽象词（"孤独"、"愧疚"、"心痛"）。**排除**：分析、展示、方式、功能、界面、系统、设计、内容、方面、问题、情况、时候、事情、地方、样子、感觉、心情、情绪、想法、体会、状态、没事、还行、可以、其实、然后、就是、这个、那个、什么。

Q2 有情绪重量吗？用户提到它时带着难过/愤怒/怀念/害怕/欣慰，不是随口一说的背景词。

Q3 是记忆锚点吗？五年后回想这段情绪，还会想到这个词吗？

三个都过 → 入选。

【数量】目标 5 个左右，最少 3、最多 8。用户话少（<50 字）给 3-4 个；中等（50-150 字）给 4-6 个；长（>150 字）给 6-8 个。**不要硬凑**。

【weight】1-5 的整数，这个锚点在情绪里的分量。核心创伤/最沉的事 = 5；顺带提到但有情绪 = 2-3。用来决定它在画面里的位置（重的居中，轻的边缘）。

【词形】2-4 字。多余的字砍掉（"妈妈的电话" → "电话" 或 "妈妈"，选情绪更重的那个）。

只输出 JSON：{"emotion":"…","intensity":0,"summary":"…","worries":[{"word":"…","weight":5}]}`;



const NAMING_SYSTEM_PROMPT = `根据用户提供的意象和情绪，为一件金缮玻璃艺术品起 3 个名字。
要求：每个 4-10 个字；诗意、轻盈、略带超现实的无意义感；不要出现"治愈""伤痛""心理""情绪"这类直白词；可以把意象词与器物或自然物（灯、翼、星、舟、铃、雾、屿、汽水、苔）做陌生化组合。
只输出 JSON：{"names":["…","…","…"]}`;

const CLOSING_SYSTEM_PROMPT = `用户倾诉了一段心事，并把这份情绪做成了一件玻璃作品。请写一句不超过 40 字的回应。
要求：必须引用或呼应用户自己说过的具体内容；温柔、具体、不评判；不下诊断，不说"你应该"，不用通用安慰语（如"一切都会好起来"）。
只输出 JSON：{"reply":"…"}`;

// 终局总结：走完整个流程后（命名之后），拿完整对话 + 情绪 + 作品名，出一句凝练的"这次情绪的墓志铭"。
// 用于档案馆里的回忆卡片，帮用户日后回望时想起当时的自己。
const FINAL_SUMMARY_SYSTEM_PROMPT = `用户倾诉了一段情绪，最终把它做成了一件玻璃作品并起了名字。请为这份记忆写一句 15-30 字的凝练总结，放在多年后她回望时的档案馆里。

要求：
- 第三人称（她/他/那个人），像别人在描述"这个人当时的样子"。
- 必须点出情绪的具体载体（分手/加班/妈妈的电话/深夜失眠 等用户提到的具体事物），不许用"某件事""这段情绪"这种泛指。
- 呼应作品名（如"她把关于分手的深夜心痛，做成了《静夜灯》"）。
- 不评判、不安慰、不下诊断、不用通用心灵鸡汤。
- 语气如时间胶囊：像多年后翻到旧物时那种平静的追忆。

只输出 JSON：{"summary":"…"}`;

function mergeImagery(existing, incoming) {
  const merged = Array.isArray(existing) ? [...existing] : [];
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (!item || typeof item.word !== "string" || !item.word.trim()) continue;
    const word = cleanImageryWord(item.word);
    if (!word) continue;
    const clean = {
      word,
      essence: trimText(item.essence, 40),
      color: /^#[0-9a-fA-F]{6}$/.test(item.color || "") ? item.color : "#8FA8C0",
      weight: clamp(Number(item.weight) || 3, 1, 5),
    };
    const found = merged.find((m) =>
      m.word === clean.word ||
      m.word.includes(clean.word) ||
      clean.word.includes(m.word)
    );
    if (found) {
      if (clean.word.length > found.word.length + 1 && found.word.length <= 4) {
        Object.assign(found, clean);
      }
    }
    else merged.push(clean);
  }
  return merged.slice(0, 10);
}

const LOCAL_IMAGERY_COLORS = [
  "#8FA8C0", "#A7B8A0", "#B6A8CC", "#C7A98B", "#8BB9BC",
  "#C29AA0", "#9EADC8", "#B9B28A", "#A7C1B5", "#B0A0B8",
];

const LOCAL_STOP_WORDS = new Set([
  "然后", "就是", "觉得", "感觉", "可能", "因为", "所以", "但是", "如果", "这个", "那个",
  "其实", "真的", "有点", "一直", "还是", "没有", "不是", "可以", "今天", "现在", "时候",
  "自己", "我们", "你们", "他们", "以后", "之前", "之后", "什么", "怎么", "为什么", "你好",
  "怎么样", "了吗", "吗", "呢", "吧", "啊", "呀", "到了", "需要", "我要", "我想", "我需要",
]);

const LOCAL_KEYWORD_PATTERNS = [
  "压力", "项目", "演示", "老板", "消息", "团队", "进度", "截止", "工作", "加班",
  "考试", "学校", "作业", "同学", "老师", "家", "房间", "小灯", "电话", "妈妈",
  "爸爸", "朋友", "伴侣", "孩子", "身体", "心里", "睡眠", "失眠", "晚上", "夜晚",
  "天气", "公园", "糖葫芦", "大餐", "早餐", "午餐", "晚餐", "餐厅", "吃饭", "饭", "钱", "房租", "医院", "焦虑", "担心", "害怕", "委屈",
  "孤独", "难过", "愤怒", "开心", "期待", "离开", "失去", "争吵", "沉默",
];

function hashText(text) {
  let hash = 0;
  for (const char of String(text || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function cleanImageryWord(text, { allowUnknownNoun = false } = {}) {
  const compact = trimText(String(text || "")
    .replace(/[“”"'`（）()【】[\]{}<>《》]/g, "")
    .replace(/[，。！？!?；;：:\s]+/g, "")
    .replace(/(怎么样|了吗|怎么了|为什么|怎么办|可以吗|好不好|是不是|有没有|的时候|感觉|觉得|到了|然后|就是)/g, "")
    .trim(), 16);
  if (!compact) return "";
  if (LOCAL_STOP_WORDS.has(compact)) return "";

  const hits = LOCAL_KEYWORD_PATTERNS.filter((word) => compact.includes(word));
  if (hits.length) {
    return hits.sort((a, b) => b.length - a.length || compact.indexOf(a) - compact.indexOf(b))[0];
  }

  if (/^(我|你|他|她|它|我们|你们|他们|她们|它们)/.test(compact)) return "";
  if (/(需要|想要|想|要|会|能|去|来|说|问|吃|喝|看|听|做|加|拿|给|让)$/.test(compact)) return "";
  if (/(吗|呢|吧|啊|呀|嘛)$/.test(compact)) return "";

  const possessive = compact.match(/([\u4e00-\u9fa5]{2,4})的/);
  if (possessive && !LOCAL_STOP_WORDS.has(possessive[1])) return possessive[1];

  if (/^[\u4e00-\u9fa5]{2,4}(感|声|灯|雨|风|门|窗|园|餐|家|房|路|桥|海|山|夜|梦|火|光|信|书|饭|钱|病|痛|泪|笑|气|心)$/.test(compact)) {
    return compact;
  }

  if (allowUnknownNoun && /^[\u4e00-\u9fa5]{2,6}$/.test(compact)) {
    return compact;
  }

  return "";
}

function localImageryFromText(text) {
  const normalized = trimText(text, 4000);
  if (!normalized) {
    return [
      { word: "说不清的感觉", essence: "还没有完全成形", color: "#8FA8C0", weight: 2 },
      { word: "心里的一角", essence: "等待被看见", color: "#B0A8CC", weight: 2 },
    ];
  }

  const targetCount = clamp(Math.ceil(normalized.length / 28), 3, 10);
  const candidates = [];
  const seen = new Set();
  const clauses = normalized
    .split(/[。！？!?；;\n]+|(?:，|,|、)/)
    .map((part) => part.trim())
    .filter(Boolean);

  function addCandidate(raw, score = 3, options = {}) {
    const word = cleanImageryWord(raw, options);
    if (word.length < 2 || word.length > 6) return;
    if (LOCAL_STOP_WORDS.has(word)) return;
    if (/^(你?好)+$/.test(word)) return;
    if (seen.has(word)) return;
    seen.add(word);
    candidates.push({
      word,
      score,
      essence: word.length <= 4 ? "反复出现的词" : "这段话里的一个画面",
    });
  }

  for (const clause of clauses) {
    const clean = clause.replace(/\s+/g, "");
    if (clean.length < 2) continue;

    const quoted = clause.match(/[“"']([^“”"']{2,12})[”"']/);
    if (quoted) addCandidate(quoted[1], 5);

    for (const keyword of LOCAL_KEYWORD_PATTERNS) {
      if (clean.includes(keyword)) addCandidate(keyword, 4);
    }

    const subjectNoun = clean.match(/^([\u4e00-\u9fa5]{2,6}?)(?:很|真|特别|超级|非常)?(?:好吃|难吃|好玩|好看|重要|烦|累|痛|冷|热|香|甜|苦|酸|开心|难过|可怕|舒服|沉重|轻松)/);
    if (subjectNoun) addCandidate(subjectNoun[1], 5, { allowUnknownNoun: true });

    const objectNoun = clean.match(/(?:想吃|爱吃|喜欢|讨厌|买了|吃了|去了|看到|看见|听到|想起|梦到|怀念|失去)([\u4e00-\u9fa5]{2,6})/);
    if (objectNoun) addCandidate(objectNoun[1], 5, { allowUnknownNoun: true });

    const emotionCarrier = clean.match(/([\u4e00-\u9fa5]{2,6})(?:让我|使我|令我)(?:开心|难过|焦虑|担心|害怕|生气|放松|安心|委屈)/);
    if (emotionCarrier) addCandidate(emotionCarrier[1], 5, { allowUnknownNoun: true });

    const nounish = clause.match(/(?:关于|因为|想到|担心|害怕|喜欢|讨厌|期待|失去|离开)([\u4e00-\u9fa5]{2,6})/);
    if (nounish) addCandidate(nounish[1], 4, { allowUnknownNoun: true });
  }

  const selected = candidates
    .sort((a, b) => b.score - a.score || a.word.length - b.word.length)
    .slice(0, targetCount);

  if (!selected.length) return localImageryFromText("");

  return selected.map((item, index) => ({
    word: item.word,
    essence: item.essence,
    color: LOCAL_IMAGERY_COLORS[(hashText(item.word) + index) % LOCAL_IMAGERY_COLORS.length],
    weight: clamp(item.score, 1, 5),
  }));
}

// ==== 音乐异步任务（内存表，进程重启即失效，落盘结果在 record.music）====
const musicJobs = new Map(); // sessionId -> { status, startedAt, result, error }

async function startMusicJob(record) {
  const sessionId = record.sessionId;
  const existing = musicJobs.get(sessionId);
  if (existing && existing.status !== "failed") return existing;

  // 旧版音乐生成在这里调用 services/music_service.py，再由 ember_music 生成/兜底 wav。
  // 当前已切到前端 public/song-engine.js 本地作曲，避免 API key 和网络依赖。
  const job = {
    status: "failed",
    startedAt: Date.now(),
    result: null,
    error: "server music generation disabled; browser song-engine handles offline music",
  };
  musicJobs.set(sessionId, job);
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
  try {
    const response = await fetch(`${LLM_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": contentType, Authorization: `Bearer ${LLM_API_KEY}` },
      body,
      signal: AbortSignal.timeout(60000),
    });
    const text = await response.text();

    if (!response.ok) {
      let upstream = null;
      try { upstream = JSON.parse(text); } catch (_) {}
      sendJson(res, 200, {
        ok: false,
        fallback: true,
        error: upstream?.error?.message || upstream?.error || text.slice(0, 200) || "语音转写上游服务暂不可用",
        upstreamCode: upstream?.error?.code || null,
      });
      return;
    }

    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") || "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(text);
  } catch (error) {
    sendJson(res, 503, {
      ok: false,
      fallback: true,
      error: error.name === "TimeoutError" ? "语音转写上游超时" : "语音转写上游服务暂不可用",
    });
  }
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

  // 保存一段倾诉录音（可多段），落盘到 data/audio/，记录进 session.voiceRecordings
  const audioMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/audio$/);
  if (req.method === "POST" && audioMatch) {
    const record = await readRecord(audioMatch[1]);
    const body = await readRawBody(req);
    if (!body || body.length < 1200) {
      sendJson(res, 400, { ok: false, error: "录音为空" });
      return;
    }
    const contentType = req.headers["content-type"] || "audio/webm";
    const ext = contentType.includes("mp4") ? "m4a" : (contentType.includes("wav") ? "wav" : "webm");
    const audioDir = path.join(ROOT, "data", "audio");
    await fs.mkdir(audioDir, { recursive: true });
    const filename = `${record.sessionId}-${Date.now()}.${ext}`;
    await fs.writeFile(path.join(audioDir, filename), body);
    record.voiceRecordings = record.voiceRecordings || [];
    record.voiceRecordings.push({
      at: localIsoString(),
      path: `/data/audio/${filename}`,
      bytes: body.length,
      mime: contentType,
    });
    await writeRecord(record);
    sendJson(res, 201, { ok: true, path: `/data/audio/${filename}` });
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
      record.videoTranscript = body.replace
        ? text
        : trimText([record.videoTranscript, text].filter(Boolean).join(" "));
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

  // ---- 实时情感分析（gpt-4o-mini 图快，2-4 秒返回）----
  const liveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/live-analyze$/);
  if (req.method === "POST" && liveMatch) {
    const body = await readBody(req);
    const text = trimText(String(body.text || ""), 2000);
    if (text.length < 3) {
      sendJson(res, 200, { ok: false, fallback: true, reason: "text too short" });
      return;
    }
    try {
      const savedModel = LLM_MODEL;
      const out = await callLLM(
        LIVE_ANALYZE_SYSTEM_PROMPT,
        `【示例 1】用户："最近晚上睡不着，想到分手就心痛"
输出：{"emotion":"悲伤","intensity":78,"summary":"她因分手而心痛，深夜难眠","worries":[{"word":"分手","weight":5},{"word":"失眠","weight":4},{"word":"心痛","weight":4},{"word":"深夜","weight":2}]}
（4 个锚点：分手是核心 5、失眠和心痛承载感受 4、深夜是场景 2。没有"最近""想到""晚上"这类流水词。）

【示例 2】用户："*叹气* 老板今天在会上又当众说我做的方案有问题，气死了。想到还要跟他共事这么多年就觉得压抑"
输出：{"emotion":"愤怒","intensity":72,"summary":"她被老板当众否定，感到压抑","worries":[{"word":"老板","weight":5},{"word":"当众","weight":4},{"word":"叹气","weight":3},{"word":"压抑","weight":4},{"word":"共事","weight":2}]}
（5 个锚点，都带情绪重量。"方案""问题""会上"是背景，不入选。）

【示例 3】用户："没事，就是有点累"
输出：{"emotion":"悲伤","intensity":45,"summary":"她说没事，但透着疲惫","worries":[{"word":"累","weight":4},{"word":"没事","weight":3},{"word":"隐忍","weight":3}]}
（只 3 个，用户话少不硬凑。"没事"入选是因为它本身是一种情绪信号——欲言又止。）

【现在】用户实时倾诉（可能带非语言标记）：\n${text}\n请严格按上面标准输出情绪锚点（3-8 个，每个 {word, weight}）：`,
        { maxTokens: 700, temperature: 0.4, retries: 1, responseFormat: { type: "json_object" } }
      );
      const emotion = EMOTIONS_7.includes(out.emotion) ? out.emotion : "平静";
      const intensity = Number.isFinite(Number(out.intensity))
        ? clamp(Number(out.intensity), 0, 100) : 0;
      const summary = trimText(out.summary, 120);
      const worries = Array.isArray(out.worries)
        ? out.worries
            .map((w) => {
              const raw = typeof w === "string" ? { word: w, weight: 3 } : (w || {});
              const word = String(raw.word || "").replace(/[\s\p{P}]/gu, "");
              const weight = clamp(Number(raw.weight) || 3, 1, 5);
              return word.length >= 2 && word.length <= 4 ? { word, weight } : null;
            })
            .filter(Boolean)
            // 去重（同一个词只保留权重最高的）
            .reduce((acc, cur) => {
              const found = acc.find((x) => x.word === cur.word);
              if (!found) acc.push(cur);
              else if (cur.weight > found.weight) found.weight = cur.weight;
              return acc;
            }, [])
            .slice(0, 8)
        : [];
      // 不再本地扩展——上限 8，宁少勿滥。少于 3 只是提示 LLM 输出有问题，不硬凑。
      // 顺便写进 record，让下游熔炉/命名/结语能吃到最新的情绪
      try {
        const record = await readRecord(liveMatch[1]);
        record.llmAnalysis = {
          ...(record.llmAnalysis || {}),
          dominantEmotion: emotion,
          overallIntensity: intensity,
          aiSummary: summary || record.llmAnalysis?.aiSummary,
        };
        refreshDerivedFields(record);
        await writeRecord(record);
      } catch (_) { /* record 不存在也不影响返回 */ }
      sendJson(res, 200, { ok: true, emotion, intensity, summary, worries });
    } catch (error) {
      console.warn(`[live-analyze] LLM 失败: ${error.message}`);
      sendJson(res, 200, { ok: false, fallback: true, error: error.message });
    }
    return;
  }

  // ---- 意象提炼（可多次调用，增量合并）----
  const imageryMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/imagery$/);
  if (req.method === "POST" && imageryMatch) {
    const record = await readRecord(imageryMatch[1]);
    const text = trimText([record.textInput, record.videoTranscript].filter(Boolean).join(" "), 4000);
    const localImagery = localImageryFromText(text);
    if (text.length < 6) {
      record.imagery = mergeImagery(record.imagery, localImagery);
      refreshDerivedFields(record);
      await writeRecord(record);
      sendJson(res, 200, {
        ok: true,
        fallback: true,
        reason: "text too short",
        imagery: record.imagery || [],
        dominantEmotion: record.dominantEmotion,
        overallIntensity: record.overallIntensity,
      });
      return;
    }
    try {
      const out = await callLLM(IMAGERY_SYSTEM_PROMPT, `用户的倾诉内容：\n${text}`);
      const llmImagery = Array.isArray(out.imagery) && out.imagery.length ? out.imagery : [];
      record.imagery = mergeImagery(record.imagery, [...llmImagery, ...localImagery]);
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
      record.imagery = mergeImagery(record.imagery, localImagery);
      refreshDerivedFields(record);
      await writeRecord(record);
      sendJson(res, 200, {
        ok: false,
        fallback: true,
        imagery: record.imagery || [],
        dominantEmotion: record.dominantEmotion,
        overallIntensity: record.overallIntensity,
      });
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

  // ---- 终局总结（档案馆的"当时的自己"）：POST 触发生成，GET 拿缓存 ----
  const finalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/final-summary$/);
  if (finalMatch) {
    const record = await readRecord(finalMatch[1]);
    if (req.method === "GET") {
      sendJson(res, 200, { ok: true, summary: record.finalSummary || null });
      return;
    }
    if (req.method === "POST") {
      // 已有缓存直接返回，除非请求 body 里带 force:true
      const body = await readBody(req).catch(() => ({}));
      if (record.finalSummary && !body.force) {
        sendJson(res, 200, { ok: true, summary: record.finalSummary, cached: true });
        return;
      }
      const artworkName = record.artwork?.name || record.artworkName || "未命名";
      const anchor = (record.imagery || []).map((i) => i.word).filter(Boolean)[0] || "那一刻";
      const summary = `那时的自己，把「${trimText(anchor, 12)}」安放进了《${trimText(artworkName, 20)}》。`;
      record.finalSummary = summary;
      await writeRecord(record);
      sendJson(res, 200, { ok: true, summary, local: true });
      return;
    }
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

// 旧版 Python 音乐服务已停用：当前音乐由 public/song-engine.js 在浏览器端本地生成。
// 如需回退旧链路，可临时取消下一行注释。
// if (process.env.EMBER_EXTERNAL !== "1") startMusicService();

server.listen(PORT, () => {
  console.log(`Ember local server running at http://localhost:${PORT}/`);
  console.log(`Transcript records will be saved in ${DATA_DIR}`);
});
