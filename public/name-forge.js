/**
 * name-forge.js — 工艺品命名库 v2（本地，无 API）
 *
 * 命名公式：情绪 → 颜色（中国传统色，看得见的具体颜色）→ 颜色 + 器物 + 少量点缀。
 * 名字必须一眼能想象出来是什么样子，文采来自色名本身，不玩抽象句式。
 *
 * 例：悲伤 → 「雾蓝的小舟」「委屈烧成的黛蓝琉璃」「月白盏」
 *     喜悦 → 「琥珀色的铃」「杏黄琉璃星」
 *     愤怒 → 「赤陶色的灯」「余烬红的锚」
 *
 * 用法（factory.html）：
 *   NameForge.generate({ words, emotion, count: 3 })
 */
(function () {
  /* ---------- 情绪 → 颜色（与视觉规范情绪色板同一体系，用传统色名表达） ---------- */
  const COLORS = {
    "悲伤": ["雾蓝", "黛蓝", "月白", "青灰", "烟青", "雨过天青"],
    "愤怒": ["赤陶", "绯红", "余烬红", "琥珀红", "胭脂", "火漆红"],
    "恐惧": ["鸦青", "墨蓝", "夜灰", "深海蓝", "石青"],
    "厌恶": ["苍苔", "灰绿", "竹月", "秋香", "艾绿"],
    "惊讶": ["藕荷", "紫藤", "星紫", "暮紫", "淡藤"],
    "喜悦": ["琥珀", "杏黄", "蜜橘", "暖金", "橘光", "鹅黄"],
    "平静": ["天青", "苔绿", "竹青", "青瓷", "月白", "湖绿"],
  };
  const COLOR_FALLBACK = ["天青", "月白", "琥珀"];

  /* ---------- 器物：具体、拿得起来的东西（玻璃厂语境优先） ---------- */
  const VESSELS = [
    "小舟", "灯", "铃", "盏", "星", "屿", "镜", "月牙",
    "琉璃珠", "小瓶", "风铃", "灯笼", "小塔", "贝壳", "羽毛",
  ];
  // 情绪专属器物（少量，加进池子）
  const EMO_VESSELS = {
    "悲伤": ["泊灯", "深水灯"],
    "愤怒": ["锚", "火漆印"],
    "恐惧": ["护身符", "小灯塔"],
    "厌恶": ["净瓶", "小篱"],
    "惊讶": ["流星", "万花筒"],
    "喜悦": ["铃铛", "糖纸星"],
    "平静": ["座钟", "小湖"],
  };

  /* ---------- 句式 ----------
   * 分两组：带颜色的 / 不带颜色的。
   * 每批 3 个候选里只出 1~2 个带色的，其余用素句式，避免"全是颜色"的新模板腔。
   */
  const COLOR_TEMPLATES = [
    (c) => `${c.color}的${c.vessel}`,               // 雾蓝的小舟
    (c) => `${c.color}色${c.vessel}`,               // 琥珀色风铃
    (c) => `${c.color}琉璃${c.short}`,              // 黛蓝琉璃星
    (c) => `${c.word}烧成的${c.color}${c.short}`,   // 委屈烧成的月白盏
    (c) => `盛着${c.word}的${c.color}${c.short}`,   // 盛着想念的雾蓝瓶
  ];
  const PLAIN_TEMPLATES = [
    (c) => `${c.word}烧成的${c.vessel}`,            // 委屈烧成的小舟
    (c) => `盛着${c.word}的${c.vessel}`,            // 盛着想念的灯笼
    (c) => `金缝${c.short}`,                        // 金缝盏（金缮）
    (c) => `带金纹的${c.vessel}`,                   // 带金纹的风铃
    (c) => `${c.word}${c.short}`,                   // 委屈盏 / 想念铃
    (c) => `今天的${c.vessel}`,                     // 今天的小塔
  ];
  // 琉璃/组合句式里用的单字器物（避免"琉璃小舟"太长）
  const SHORT_VESSELS = ["星", "盏", "灯", "铃", "舟", "瓶", "镜", "珠"];

  /* ---------- 历史避让 ---------- */
  const LS_KEY = "nameForgeHistory";
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || { names: [] }; }
    catch (_) { return { names: [] }; }
  }
  function saveHistory(h) {
    h.names = h.names.slice(-30);
    try { localStorage.setItem(LS_KEY, JSON.stringify(h)); } catch (_) {}
  }

  /* ---------- 工具 ---------- */
  const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function drawDistinct(arr, n) {
    const pool = arr.slice();
    const out = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return out;
  }
  function cleanWord(w) {
    w = String(w || "").trim().replace(/[。，、！？.!?]/g, "");
    if (!w) return "";
    return w.length > 6 ? "" : w;   // 太长的意象词不硬塞进名字
  }

  /* ---------- 主入口 ---------- */
  function generate({ words = [], emotion = "", count = 3 } = {}) {
    const history = loadHistory();
    const seen = new Set(history.names);

    const colorPool = COLORS[emotion] || COLOR_FALLBACK;
    const vesselPool = VESSELS.concat(EMO_VESSELS[emotion] || []);
    const cleanWords = words.map(cleanWord).filter(Boolean);
    if (!cleanWords.length) cleanWords.push("此刻");

    // 本批带色数量：1 或 2（不会 0，颜色是情绪的转译；不会 3，避免全彩腔）
    const colorCount = 1 + Math.floor(Math.random() * 2);
    // slots[k] = true 表示第 k 个用带色句式；随机分布位置
    const slots = drawDistinct([0, 1, 2].slice(0, count), Math.min(colorCount, count));

    // 同批：颜色、器物都不重复
    const chosenColors = drawDistinct(colorPool, count);
    const chosenVessels = drawDistinct(vesselPool, count);
    const chosenShorts = drawDistinct(SHORT_VESSELS, count);
    // 同批句式不重复（带色/素句各自记）
    const usedColorTpl = new Set(), usedPlainTpl = new Set();

    const names = [];
    for (let k = 0; k < count; k++) {
      const useColor = slots.includes(k);
      const pool = useColor ? COLOR_TEMPLATES : PLAIN_TEMPLATES;
      const usedSet = useColor ? usedColorTpl : usedPlainTpl;
      let name = null;
      for (let attempt = 0; attempt < 10 && !name; attempt++) {
        const idx = Math.floor(Math.random() * pool.length);
        if (usedSet.has(idx) && attempt < 5) continue;   // 前几次尽量换句式
        const ctx = {
          color: chosenColors[k] || rand(colorPool),
          vessel: chosenVessels[k] || rand(vesselPool),
          short: chosenShorts[k] || rand(SHORT_VESSELS),
          word: rand(cleanWords),
        };
        const candidate = pool[idx](ctx);
        if (candidate.length > 10 || seen.has(candidate) || names.includes(candidate)) continue;
        name = candidate;
        usedSet.add(idx);
      }
      if (name) names.push(name);
    }
    while (names.length < count) {
      const fb = `${rand(colorPool)}的${rand(vesselPool)}`;
      if (!names.includes(fb)) names.push(fb);
    }

    history.names.push(...names);
    saveHistory(history);
    return names.slice(0, count);
  }

  window.NameForge = { generate };
})();
