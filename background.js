// background.js — AI MarkMaster Chrome Extension Service Worker

// ============ 默认分类 ============
const DEFAULT_CATEGORIES = [
  "社交媒体", "影音娱乐", "游戏电竞", "购物消费", "新闻资讯",
  "开发编程", "设计创作", "学习教育", "工具效率", "云服务",
  "搜索导航", "图书阅读", "成人内容", "资源下载", "其他"
];
const LOW_CONFIDENCE_THRESHOLD = 0.7;
const LOW_CONFIDENCE_FOLDER = "待二次判断";
const SIGNAL_FETCH_TIMEOUT_MS = 3000;
const SIGNAL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HTML_SIZE = 200000;
const RULE_MIN_SAMPLES = 5;
const RULE_MIN_RATIO = 0.8;
const MAX_PENDING_FETCH = 60;

// ============ 获取设置 ============
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { apiKey: "", categories: DEFAULT_CATEGORIES, enabled: true, recentLogs: [], domainRules: {}, ruleStats: {} },
      (items) => resolve(items)
    );
  });
}

async function getLocalSettings(defaults) {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (items) => resolve(items));
  });
}

// ============ 保存日志 ============
async function addLog(entry) {
  const { recentLogs } = await getSettings();
  recentLogs.unshift(entry);
  if (recentLogs.length > 20) recentLogs.length = 20;
  chrome.storage.sync.set({ recentLogs });
}

function cleanText(text) {
  if (!text) return "";
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp01(num, fallback = 0.5) {
  if (!Number.isFinite(num)) return fallback;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function tokenize(text) {
  return cleanText(text)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .filter((token) => token && token.length >= 2 && token.length <= 30);
}

function splitMetaKeywords(text) {
  return cleanText(text)
    .toLowerCase()
    .split(/[,，;；|、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item && item.length >= 2 && item.length <= 30);
}

function uniqueList(items) {
  return [...new Set(items)];
}

function pickCategory(category, categories) {
  const safeCategory = cleanText(category);
  if (categories.includes(safeCategory)) return safeCategory;
  if (categories.includes("其他")) return "其他";
  return categories[categories.length - 1] || DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1];
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function getDomainRuleCategory(domain, domainRules, categories) {
  if (!domain || !domainRules) return "";
  const raw = cleanText(domainRules[domain] || "");
  if (raw && categories.includes(raw)) return raw;
  return "";
}

function extractTagText(html, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const matched = html.match(regex);
  return matched ? cleanText(matched[1]) : "";
}

function extractMetaContent(html, names) {
  const target = new Set(names.map((name) => name.toLowerCase()));
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const attrs = {};
    const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let attrMatch;

    while ((attrMatch = attrRegex.exec(tag)) !== null) {
      const key = (attrMatch[1] || "").toLowerCase();
      const value = attrMatch[3] ?? attrMatch[4] ?? attrMatch[5] ?? "";
      attrs[key] = value;
    }

    const nameKey = (attrs.name || attrs.property || attrs["http-equiv"] || "").toLowerCase();
    if (target.has(nameKey) && attrs.content) {
      return cleanText(attrs.content);
    }
  }

  return "";
}

function buildFallbackSignals(url, title, reason = "") {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = { hostname: "", pathname: "" };
  }

  let decodedPath = parsed.pathname || "";
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    // ignore decode failure, keep raw path
  }

  const domain = String(parsed.hostname || "").replace(/^www\./i, "");
  const pathTokens = tokenize(decodedPath).slice(0, 12);
  const keywords = uniqueList([
    ...tokenize(title),
    ...tokenize(domain.replace(/\./g, " ")),
    ...pathTokens
  ]).slice(0, 12);

  return {
    source: "fallback",
    domain,
    path_tokens: pathTokens,
    page_title: "",
    meta_keywords: "",
    meta_description: "",
    og_title: "",
    h1: "",
    keywords,
    fallback_reason: reason
  };
}

async function getCachedSignals(url) {
  const { signalCache = {} } = await getLocalSettings({ signalCache: {} });
  const cached = signalCache[url];
  if (!cached || !cached.fetchedAt || !cached.signals) return null;
  if (Date.now() - cached.fetchedAt > SIGNAL_CACHE_TTL_MS) return null;
  return cached.signals;
}

async function setCachedSignals(url, signals) {
  const { signalCache = {} } = await getLocalSettings({ signalCache: {} });
  signalCache[url] = { fetchedAt: Date.now(), signals };
  chrome.storage.local.set({ signalCache });
}

async function learnDomainRule(domain, category, confidence, categories) {
  if (!domain || !category || confidence < LOW_CONFIDENCE_THRESHOLD) return;

  const settings = await getSettings();
  const domainRules = settings.domainRules || {};
  const ruleStats = settings.ruleStats || {};
  const stat = ruleStats[domain] || { total: 0, byCategory: {} };

  stat.total += 1;
  stat.byCategory[category] = (stat.byCategory[category] || 0) + 1;
  ruleStats[domain] = stat;

  let topCategory = "";
  let topCount = 0;
  for (const [cat, count] of Object.entries(stat.byCategory)) {
    if (count > topCount) {
      topCategory = cat;
      topCount = count;
    }
  }

  if (
    stat.total >= RULE_MIN_SAMPLES &&
    topCategory &&
    categories.includes(topCategory) &&
    topCount / stat.total >= RULE_MIN_RATIO
  ) {
    domainRules[domain] = topCategory;
  }

  chrome.storage.sync.set({ domainRules, ruleStats });
}

async function extractPageSignals(url, bookmarkTitle) {
  const cached = await getCachedSignals(url);
  if (cached) return cached;

  const fallbackSignals = buildFallbackSignals(url, bookmarkTitle, "fetch_not_started");

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SIGNAL_FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow"
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return { ...fallbackSignals, fallback_reason: `http_${response.status}` };
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html")) {
      const failResult = { ...fallbackSignals, fallback_reason: "non_html" };
      await setCachedSignals(url, failResult);
      return failResult;
    }

    const htmlRaw = await response.text();
    const html = htmlRaw.slice(0, MAX_HTML_SIZE);

    const pageTitle = extractTagText(html, "title");
    const metaKeywords = extractMetaContent(html, ["keywords"]);
    const metaDescription = extractMetaContent(html, ["description", "og:description"]);
    const ogTitle = extractMetaContent(html, ["og:title", "twitter:title"]);
    const h1 = extractTagText(html, "h1");

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      parsed = { hostname: "", pathname: "" };
    }

    let decodedPath = parsed.pathname || "";
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {
      // ignore decode failure, keep raw path
    }

    const domain = String(parsed.hostname || "").replace(/^www\./i, "");
    const pathTokens = tokenize(decodedPath).slice(0, 12);
    const keywords = uniqueList([
      ...splitMetaKeywords(metaKeywords),
      ...tokenize(pageTitle),
      ...tokenize(ogTitle),
      ...tokenize(h1),
      ...tokenize(metaDescription).slice(0, 8),
      ...tokenize(domain.replace(/\./g, " ")),
      ...pathTokens
    ]).slice(0, 18);

    const signals = {
      source: "fetched",
      domain,
      path_tokens: pathTokens,
      page_title: pageTitle,
      meta_keywords: metaKeywords,
      meta_description: metaDescription,
      og_title: ogTitle,
      h1,
      keywords
    };
    await setCachedSignals(url, signals);
    return signals;
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : cleanText(err?.message || "fetch_failed");
    return { ...fallbackSignals, fallback_reason: reason };
  }
}

function normalizeAiResult(rawResult, categories, title) {
  const confidenceValue = typeof rawResult?.confidence === "number"
    ? rawResult.confidence
    : Number(rawResult?.confidence);

  const normalizedKeywords = Array.isArray(rawResult?.keywords)
    ? rawResult.keywords.map((item) => cleanText(item)).filter(Boolean).slice(0, 12)
    : [];

  return {
    category: pickCategory(rawResult?.category, categories),
    new_title: cleanText(rawResult?.new_title) || title,
    confidence: clamp01(confidenceValue, 0.5),
    reason: cleanText(rawResult?.reason || ""),
    keywords: normalizedKeywords
  };
}

// ============ 调用 DeepSeek API（结构化输入） ============
async function classifyBookmark(url, title, apiKey, categories, pageSignals) {
  const catStr = categories.join("、");

  const systemPrompt = `你是书签分类助手。你会收到书签和网页信号，请严格从给定分类中选择最匹配的一项。
${catStr}

规则：
1. 只输出 JSON：{"category":"分类名","new_title":"精简标题","confidence":0-1,"reason":"简短理由","keywords":["关键词1","关键词2"]}
2. category 必须从上面的分类列表中选，不允许新增分类。
3. confidence 表示你对分类的置信度，0 到 1。
4. new_title 要简洁，去掉“首页/官网/最新”等冗余词。
5. 如果信息不足，也要给出最可能分类，但降低 confidence。`;

  const userPrompt = `请根据以下结构化信息分类：
${JSON.stringify({
    url,
    bookmark_title: title,
    domain: pageSignals.domain || "",
    path_tokens: pageSignals.path_tokens || [],
    page_title: pageSignals.page_title || "",
    meta_keywords: pageSignals.meta_keywords || "",
    meta_description: pageSignals.meta_description || "",
    og_title: pageSignals.og_title || "",
    h1: pageSignals.h1 || "",
    extracted_keywords: pageSignals.keywords || [],
    signal_source: pageSignals.source || "unknown",
    signal_fallback_reason: pageSignals.fallback_reason || ""
  })}`;

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("API 返回空内容");
  return normalizeAiResult(JSON.parse(content), categories, title);
}

// ============ 调用 DeepSeek API（回退模式） ============
async function classifyBookmarkFallback(url, title, apiKey, categories) {
  const catStr = categories.join("、");

  const systemPrompt = `你是书签分类助手。根据URL和标题，从以下分类中选一个最合适的：
${catStr}

规则：
1. 只输出 JSON：{"category":"分类名","new_title":"精简标题","confidence":0-1,"reason":"简短理由","keywords":["关键词1","关键词2"]}
2. category 必须从上面的列表中选，不要自创。`;

  const userPrompt = `URL: ${url}\n标题: ${title}`;

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("API 返回空内容");
  return normalizeAiResult(JSON.parse(content), categories, title);
}

async function getBookmarksChildren(parentId) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getChildren(parentId, (children) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(children || []);
      }
    });
  });
}

async function getBookmarkNode(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.get(id, (results) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(results?.[0] || null);
      }
    });
  });
}

async function getBookmarkSubTree(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getSubTree(id, (results) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(results?.[0] || null);
      }
    });
  });
}

async function getBookmarkTree() {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree((tree) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(tree || []);
      }
    });
  });
}

async function findFolderByTitle(folderName, parentId = "2") {
  const children = await getBookmarksChildren(parentId);
  return children.find((item) => !item.url && item.title === folderName) || null;
}

async function getAllFolderOptions(limit = 400) {
  const tree = await getBookmarkTree();
  const folders = [];

  function walk(node, pathParts) {
    if (folders.length >= limit) return;
    if (!node.url) {
      const nextParts = node.title ? [...pathParts, node.title] : pathParts;
      if (node.id && node.id !== "0") {
        folders.push({
          id: node.id,
          path: nextParts.join(" / "),
          title: node.title || "未命名文件夹"
        });
      }
      for (const child of (node.children || [])) {
        walk(child, nextParts);
        if (folders.length >= limit) return;
      }
    }
  }

  for (const root of tree) {
    walk(root, []);
    if (folders.length >= limit) break;
  }

  return folders;
}

async function listFolders(parentId = "2") {
  const children = await getBookmarksChildren(parentId);
  return children.filter((item) => !item.url).map((item) => ({ id: item.id, title: item.title }));
}

async function getBookmarksInFolder(folderId) {
  const subtree = await getBookmarkSubTree(folderId);
  if (!subtree) return [];
  const bookmarks = [];

  function traverse(node, currentFolderName) {
    if (node.url) {
      bookmarks.push({
        id: node.id,
        title: node.title || "",
        url: node.url,
        parentId: node.parentId,
        currentFolderName,
        dateAdded: node.dateAdded || 0
      });
      return;
    }

    const nextFolderName = node.title || currentFolderName || "";
    const children = node.children || [];
    for (const child of children) {
      traverse(child, nextFolderName);
    }
  }

  const children = subtree.children || [];
  for (const child of children) {
    traverse(child, subtree.title || "");
  }

  return bookmarks;
}

async function classifyBookmarkSmart(bookmark, settings, categories) {
  const domain = extractDomain(bookmark.url);
  const ruleCategory = getDomainRuleCategory(domain, settings.domainRules, categories);
  const pageSignals = await extractPageSignals(bookmark.url, bookmark.title);

  let result;
  let usedFallbackClassifier = false;
  let usedDomainRule = false;

  if (ruleCategory) {
    usedDomainRule = true;
    result = {
      category: ruleCategory,
      new_title: bookmark.title,
      confidence: 0.99,
      reason: `命中域名规则: ${domain}`,
      keywords: [domain]
    };
  } else {
    try {
      result = await classifyBookmark(
        bookmark.url,
        bookmark.title,
        settings.apiKey,
        categories,
        pageSignals
      );
    } catch (classifyErr) {
      usedFallbackClassifier = true;
      result = await classifyBookmarkFallback(
        bookmark.url,
        bookmark.title,
        settings.apiKey,
        categories
      );
    }
  }

  const suggestedCategory = pickCategory(result.category, categories);
  const confidence = clamp01(Number(result.confidence), 0.5);
  const highConfidence = confidence >= LOW_CONFIDENCE_THRESHOLD;
  const targetFolderName = highConfidence ? suggestedCategory : LOW_CONFIDENCE_FOLDER;
  const newTitle = cleanText(result.new_title) || bookmark.title;

  return {
    suggestedCategory,
    confidence,
    highConfidence,
    targetFolderName,
    newTitle,
    reason: result.reason || "",
    keywords: result.keywords || [],
    pageSignals,
    usedFallbackClassifier,
    usedDomainRule,
    domain
  };
}

async function applyBookmarkClassification(bookmarkId, bookmarkUrl, bookmarkOriginalTitle, detail) {
  const folderId = await findOrCreateFolder(detail.targetFolderName, "2");
  await moveBookmark(bookmarkId, folderId);

  if (detail.highConfidence && detail.newTitle !== bookmarkOriginalTitle) {
    await updateBookmarkTitle(bookmarkId, detail.newTitle);
  }

  await addLog({
    time: new Date().toLocaleString(),
    title: detail.highConfidence ? detail.newTitle : bookmarkOriginalTitle,
    category: detail.highConfidence ? detail.suggestedCategory : `${LOW_CONFIDENCE_FOLDER}（建议:${detail.suggestedCategory}）`,
    url: bookmarkUrl,
    confidence: detail.confidence,
    reason: detail.reason,
    keywords: detail.keywords,
    signalSource: detail.pageSignals.source || "unknown",
    fallbackReason: detail.pageSignals.fallback_reason || "",
    usedFallbackClassifier: detail.usedFallbackClassifier,
    usedDomainRule: detail.usedDomainRule,
    domain: detail.domain
  });
}

// ============ 查找或创建文件夹 ============
async function findOrCreateFolder(folderName, parentId = "1") {
  // parentId "1" = 书签栏, "2" = 其他书签
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getChildren(parentId, (children) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      // 查找已有文件夹
      const existing = children.find(
        (c) => c.title === folderName && !c.url
      );

      if (existing) {
        resolve(existing.id);
      } else {
        // 创建新文件夹
        chrome.bookmarks.create(
          { parentId, title: folderName },
          (newFolder) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(newFolder.id);
            }
          }
        );
      }
    });
  });
}

// ============ 移动书签 ============
async function moveBookmark(bookmarkId, targetFolderId) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.move(bookmarkId, { parentId: targetFolderId }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// ============ 更新书签标题 ============
async function updateBookmarkTitle(bookmarkId, newTitle) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.update(bookmarkId, { title: newTitle }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// ============ 发送通知 ============
function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    silent: true
  });
}

// ============ 防抖：避免短时间内重复处理同一书签 ============
const processingIds = new Set();

// ============ 核心：监听书签创建 ============
chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  // 忽略文件夹（没有 url 的是文件夹）
  if (!bookmark.url) return;

  // 防抖
  if (processingIds.has(id)) return;
  processingIds.add(id);

  const settings = await getSettings();

  // 检查开关
  if (!settings.enabled) {
    processingIds.delete(id);
    return;
  }

  // 检查 API Key
  if (!settings.apiKey) {
    notify("⚠️ AI MarkMaster", "请先在插件设置中填入 DeepSeek API Key");
    processingIds.delete(id);
    return;
  }

  try {
    // 移除 5 秒气泡延时，改为立即进行操作
    chrome.bookmarks.get(id, async (results) => {
      if (chrome.runtime.lastError || !results || results.length === 0) {
        processingIds.delete(id);
        return;
      }
      const latestBm = results[0];
      if (!latestBm.url) {
        processingIds.delete(id);
        return;
      }

      try {
        const categories = settings.categories || DEFAULT_CATEGORIES;
        const detail = await classifyBookmarkSmart(latestBm, settings, categories);
        await applyBookmarkClassification(id, latestBm.url, latestBm.title, detail);

        const percent = Math.round(detail.confidence * 100);
        if (detail.highConfidence) {
          const fromRuleSuffix = detail.usedDomainRule ? "（规则）" : "";
          notify("📌 已分类", `${detail.newTitle} → ${detail.suggestedCategory}${fromRuleSuffix}（${percent}%）`);
        } else {
          notify("🕒 待二次判断", `${latestBm.title}（建议 ${detail.suggestedCategory}，${percent}%）`);
        }

        if (detail.highConfidence && !detail.usedDomainRule && detail.domain) {
          learnDomainRule(detail.domain, detail.suggestedCategory, detail.confidence, categories).catch((err) => {
            console.warn("学习域名规则失败:", err);
          });
        }
      } catch (err) {
        console.error("AI MarkMaster 实时分类失败:", err);
        notify("❌ 分类失败", err.message?.substring(0, 100) || "未知错误");
        await addLog({
          time: new Date().toLocaleString(),
          title: latestBm.title,
          category: "❌ 失败",
          url: latestBm.url,
          error: err.message
        });
      } finally {
        processingIds.delete(id);
      }
    });

  } catch (err) {
    processingIds.delete(id);
  }
});

// ============ 全量一键整理历史书签 ============
// 扁平化提取不在已知分类文件夹中的所有书签
async function extractUnclassifiedBookmarks(categories) {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      const allMarks = [];
      const catSet = new Set(categories);

      function traverse(node, path) {
        if (node.url) {
          // 如果书签所在的父目录刚好在我们的设定分类中，则跳过
          if (!catSet.has(path[path.length - 1])) {
            allMarks.push({ id: node.id, url: node.url, title: node.title });
          }
        } else if (node.children) {
          for (let child of node.children) {
            traverse(child, [...path, node.title || "根节点"]);
          }
        }
      }

      tree.forEach(n => traverse(n, []));
      resolve(allMarks);
    });
  });
}

// 供状态更新
function updateProgress(stateObj) {
  chrome.storage.local.set({ processingState: stateObj });
}

function updateFolderRecheckState(stateObj) {
  chrome.storage.local.set({ folderRecheckState: stateObj });
}

async function doFullOrganize() {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("请先填写 API Key");

  const cats = settings.categories || DEFAULT_CATEGORIES;
  updateProgress({ isProcessing: true, message: "正在扫描书签..." });

  const bookmarks = await extractUnclassifiedBookmarks(cats);
  if (bookmarks.length === 0) {
    updateProgress({ isProcessing: false, message: "🎉 未发现需要整理的书签" });
    return;
  }

  const total = bookmarks.length;
  // 按照比如 20 条一批发送（此处简单为了降低单次请求量可使用 20 的批次）
  const BATCH_SIZE = 20;
  let processedCount = 0;

  updateProgress({ isProcessing: true, message: `开始处理...`, progress: 0, total });

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + BATCH_SIZE);

    // 构造 LLM 所需批次参数
    const batchData = batch.map(b => ({ url: b.url, title: b.title }));
    const systemPrompt = `你是书签整理专家。你的任务是：将一批书签归入指定分类，并精简标题。
可用分类：${cats.join("、")}

规则：
1. category必须从分类中选一个。
2. new_title精简标题。
3. 返回严格的 JSON：{"results": [{"new_title": "精简标题", "category": "分类名"}]}，results 数组长度必须与输入完全对应。`;
    const userPrompt = `请处理以下 ${batchData.length} 条书签：\n${JSON.stringify(batchData)}`;

    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.apiKey}` },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          temperature: 0.1,
          response_format: { type: "json_object" }
        })
      });

      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      const content = JSON.parse(data.choices?.[0]?.message?.content || '{"results":[]}');
      const results = content.results || [];

      // 应用修改
      for (let j = 0; j < batch.length; j++) {
        const bm = batch[j];
        const aiRes = results[j] || { category: "其他", new_title: bm.title };
        const cat = pickCategory(aiRes.category, cats);
        const nTitle = aiRes.new_title || bm.title;

        try {
          const folderId = await findOrCreateFolder(cat, "2");
          await moveBookmark(bm.id, folderId);
          if (nTitle !== bm.title) await updateBookmarkTitle(bm.id, nTitle);
        } catch (e) { console.warn("移动书签失败", bm.url, e); }

        processedCount++;
        updateProgress({ isProcessing: true, message: `🚀 正在清洗书签...`, progress: processedCount, total });
      }

    } catch (err) {
      console.error("批处理失败", err);
      // 若某批失败了，跳过，只记录进度
      processedCount += batch.length;
    }
  }

  updateProgress({ isProcessing: false, message: `🎉 历史书签已全部分类完毕！` });
  notify("✅ 整理完成", `共处理 ${total} 条书签`);
}

async function reorganizeBookmarksInFolder(folder, bookmarks, settings, categories, onItemDone) {
  let kept = 0;
  let moved = 0;
  let pending = 0;

  for (const bookmark of bookmarks) {
    try {
      const detail = await classifyBookmarkSmart(bookmark, settings, categories);
      const parentFolderName = bookmark.currentFolderName || "";
      const shouldKeep = detail.highConfidence && detail.suggestedCategory === parentFolderName;

      if (shouldKeep) {
        kept += 1;
      } else {
        await applyBookmarkClassification(bookmark.id, bookmark.url, bookmark.title, detail);
        moved += 1;
        if (!detail.highConfidence) pending += 1;
      }

      if (detail.highConfidence && !detail.usedDomainRule && detail.domain) {
        learnDomainRule(detail.domain, detail.suggestedCategory, detail.confidence, categories).catch((err) => {
          console.warn("学习域名规则失败:", err);
        });
      }
    } catch (err) {
      console.warn("文件夹重整分类失败:", bookmark.url, err);
      pending += 1;
      const fallbackDetail = {
        suggestedCategory: "其他",
        confidence: 0.2,
        highConfidence: false,
        targetFolderName: LOW_CONFIDENCE_FOLDER,
        newTitle: bookmark.title,
        reason: cleanText(err?.message || "reorganize_failed"),
        keywords: [],
        pageSignals: { source: "fallback", fallback_reason: "reorganize_failed" },
        usedFallbackClassifier: true,
        usedDomainRule: false,
        domain: extractDomain(bookmark.url)
      };
      try {
        await applyBookmarkClassification(bookmark.id, bookmark.url, bookmark.title, fallbackDetail);
        moved += 1;
      } catch (moveErr) {
        console.warn("文件夹重整移动失败:", bookmark.url, moveErr);
      }
    } finally {
      if (typeof onItemDone === "function") {
        onItemDone({ folder, kept, moved, pending });
      }
    }
  }

  return {
    folderId: folder.id,
    folderName: folder.title || "未命名文件夹",
    total: bookmarks.length,
    kept,
    moved,
    pending
  };
}

async function getAutoReorganizeFolders() {
  const roots = ["1", "2", "3"];
  const folders = [];
  for (const rootId of roots) {
    try {
      const children = await getBookmarksChildren(rootId);
      for (const child of children) {
        if (!child.url && child.title !== LOW_CONFIDENCE_FOLDER) {
          folders.push(child);
        }
      }
    } catch (err) {
      console.warn("读取根文件夹失败:", rootId, err);
    }
  }
  return folders;
}

async function doFolderReorganize(folderId) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("请先填写 API Key");

  const targetFolder = await getBookmarkNode(folderId);
  if (!targetFolder || targetFolder.url) throw new Error("目标文件夹不存在");

  const categories = settings.categories || DEFAULT_CATEGORIES;
  const bookmarks = await getBookmarksInFolder(folderId);
  if (bookmarks.length === 0) {
    updateFolderRecheckState({
      isProcessing: false,
      mode: "single",
      message: `🎉 文件夹「${targetFolder.title}」没有可重整的书签`
    });
    return;
  }

  const total = bookmarks.length;
  let processed = 0;
  let kept = 0;
  let moved = 0;
  let pending = 0;

  updateFolderRecheckState({
    isProcessing: true,
    mode: "single",
    folderId,
    folderName: targetFolder.title || "未命名文件夹",
    message: "正在重新校验分类...",
    progress: 0,
    total,
    kept,
    moved,
    pending
  });

  const result = await reorganizeBookmarksInFolder(
    targetFolder,
    bookmarks,
    settings,
    categories,
    ({ kept: localKept, moved: localMoved, pending: localPending }) => {
      processed += 1;
      kept = localKept;
      moved = localMoved;
      pending = localPending;
      updateFolderRecheckState({
        isProcessing: true,
        mode: "single",
        folderId,
        folderName: targetFolder.title || "未命名文件夹",
        message: `正在重整「${targetFolder.title || "未命名文件夹"}」...`,
        progress: processed,
        total,
        kept,
        moved,
        pending
      });
    }
  );

  const finishMsg = `✅ 重整完成：保留 ${result.kept}，重分 ${result.moved}，待人工 ${result.pending}`;
  updateFolderRecheckState({
    isProcessing: false,
    mode: "single",
    folderId,
    folderName: targetFolder.title || "未命名文件夹",
    message: finishMsg,
    progress: total,
    total,
    kept: result.kept,
    moved: result.moved,
    pending: result.pending
  });
  notify("✅ 文件夹重整完成", finishMsg);
}

async function doAllFoldersReorganize() {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("请先填写 API Key");

  const categories = settings.categories || DEFAULT_CATEGORIES;
  const folders = await getAutoReorganizeFolders();
  if (folders.length === 0) {
    updateFolderRecheckState({
      isProcessing: false,
      mode: "all",
      message: "🎉 未找到可重整的文件夹"
    });
    return;
  }

  const jobs = [];
  let total = 0;
  for (const folder of folders) {
    const bookmarks = await getBookmarksInFolder(folder.id);
    if (bookmarks.length > 0) {
      jobs.push({ folder, bookmarks });
      total += bookmarks.length;
    }
  }

  if (jobs.length === 0) {
    updateFolderRecheckState({
      isProcessing: false,
      mode: "all",
      message: "🎉 所有文件夹都没有可重整书签"
    });
    return;
  }

  let processed = 0;
  let kept = 0;
  let moved = 0;
  let pending = 0;
  let folderDone = 0;

  updateFolderRecheckState({
    isProcessing: true,
    mode: "all",
    message: "正在自动重整全部文件夹...",
    progress: 0,
    total,
    kept,
    moved,
    pending,
    folderDone,
    folderTotal: jobs.length
  });

  for (const job of jobs) {
    let folderLocalKept = 0;
    let folderLocalMoved = 0;
    let folderLocalPending = 0;

    const res = await reorganizeBookmarksInFolder(
      job.folder,
      job.bookmarks,
      settings,
      categories,
      ({ kept: localKept, moved: localMoved, pending: localPending }) => {
        processed += 1;
        folderLocalKept = localKept;
        folderLocalMoved = localMoved;
        folderLocalPending = localPending;

        updateFolderRecheckState({
          isProcessing: true,
          mode: "all",
          message: `正在重整全部文件夹... 当前: ${job.folder.title || "未命名文件夹"}`,
          progress: processed,
          total,
          kept: kept + folderLocalKept,
          moved: moved + folderLocalMoved,
          pending: pending + folderLocalPending,
          folderDone,
          folderTotal: jobs.length,
          currentFolder: job.folder.title || "未命名文件夹"
        });
      }
    );

    kept += res.kept;
    moved += res.moved;
    pending += res.pending;
    folderDone += 1;
    updateFolderRecheckState({
      isProcessing: true,
      mode: "all",
      message: `正在重整全部文件夹... 当前: ${job.folder.title || "未命名文件夹"}`,
      progress: processed,
      total,
      kept,
      moved,
      pending,
      folderDone,
      folderTotal: jobs.length,
      currentFolder: job.folder.title || "未命名文件夹"
    });
  }

  const finishMsg = `✅ 全部文件夹重整完成：保留 ${kept}，重分 ${moved}，待人工 ${pending}`;
  updateFolderRecheckState({
    isProcessing: false,
    mode: "all",
    message: finishMsg,
    progress: total,
    total,
    kept,
    moved,
    pending,
    folderDone: jobs.length,
    folderTotal: jobs.length
  });
  notify("✅ 全部文件夹重整完成", finishMsg);
}

async function getPendingBookmarks(limit = MAX_PENDING_FETCH) {
  const pendingFolder = await findFolderByTitle(LOW_CONFIDENCE_FOLDER, "2");
  if (!pendingFolder) return [];

  const bookmarks = await getBookmarksInFolder(pendingFolder.id);
  return bookmarks
    .sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0))
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url,
      currentFolderName: item.currentFolderName,
      dateAdded: item.dateAdded
    }));
}

async function manualClassifyBookmark(bookmarkId, category, newTitle = "") {
  const settings = await getSettings();
  const categories = settings.categories || DEFAULT_CATEGORIES;
  const pickedCategory = pickCategory(category, categories);
  const bookmark = await getBookmarkNode(bookmarkId);
  if (!bookmark || !bookmark.url) throw new Error("书签不存在");

  const targetFolderId = await findOrCreateFolder(pickedCategory, "2");
  await moveBookmark(bookmark.id, targetFolderId);

  const finalTitle = cleanText(newTitle) || bookmark.title;
  if (finalTitle !== bookmark.title) {
    await updateBookmarkTitle(bookmark.id, finalTitle);
  }

  const domain = extractDomain(bookmark.url);
  await addLog({
    time: new Date().toLocaleString(),
    title: finalTitle,
    category: `${pickedCategory}（人工）`,
    url: bookmark.url,
    confidence: 1,
    reason: "人工分类",
    keywords: [],
    signalSource: "manual",
    fallbackReason: "",
    usedFallbackClassifier: false,
    usedDomainRule: false,
    domain
  });

  if (domain) {
    await learnDomainRule(domain, pickedCategory, 1, categories);
  }

  return { success: true, category: pickedCategory, title: finalTitle };
}

// 接收来自 Popup 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startFullOrganize") {
    chrome.storage.local.get("processingState", (items) => {
      if (items.processingState && items.processingState.isProcessing) {
        sendResponse({ error: "已经在处理中了，请稍候。" });
        return;
      }
      doFullOrganize().catch(err => {
        updateProgress({ isProcessing: false, message: `❌ 失败: ${err.message}` });
      });
      sendResponse({ status: "started" });
    });
    return true; // 保持异步响应
  }

  if (request.action === "aiSearch") {
    handleAiSearch(request.query).then(results => sendResponse({ results })).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === "startAllFoldersReorganize") {
    chrome.storage.local.get("folderRecheckState", (items) => {
      if (items.folderRecheckState?.isProcessing) {
        sendResponse({ error: "文件夹重整正在进行中，请稍候" });
        return;
      }

      doAllFoldersReorganize().catch((err) => {
        updateFolderRecheckState({
          isProcessing: false,
          mode: "all",
          message: `❌ 全量重整失败: ${err.message}`
        });
      });
      sendResponse({ status: "started" });
    });
    return true;
  }

  if (request.action === "startFolderReorganize") {
    const folderId = request.folderId;
    if (!folderId) {
      sendResponse({ error: "请选择需要重整的文件夹" });
      return false;
    }

    chrome.storage.local.get("folderRecheckState", (items) => {
      if (items.folderRecheckState?.isProcessing) {
        sendResponse({ error: "文件夹重整正在进行中，请稍候" });
        return;
      }

      doFolderReorganize(folderId).catch((err) => {
        updateFolderRecheckState({
          isProcessing: false,
          folderId,
          message: `❌ 重整失败: ${err.message}`
        });
      });
      sendResponse({ status: "started" });
    });
    return true;
  }

  if (request.action === "getPendingBookmarks") {
    getPendingBookmarks(request.limit || MAX_PENDING_FETCH)
      .then((bookmarks) => sendResponse({ bookmarks }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === "manualClassifyBookmark") {
    manualClassifyBookmark(request.bookmarkId, request.category, request.newTitle || "")
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleAiSearch(query) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("请先填写 API Key");

  // 1. 获取所有的书签
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree(async (tree) => {
      const allMarks = [];
      function traverse(node) {
        if (node.url) allMarks.push({ title: node.title, url: node.url });
        else if (node.children) node.children.forEach(traverse);
      }
      tree.forEach(traverse);

      if (allMarks.length === 0) {
        resolve([]);
        return;
      }

      // 由于书签可能非常多（数千个），为避免超出 Token，这里截取前 1000 个作为样本
      // 在更高级实现中可以使用本地向量数据库，但目前直接发送给大模型也是安全的（deepseek-chat token足够大）
      const sampleMarks = allMarks.slice(0, 1000);

      const systemPrompt = `你是一个书签智能推荐助手。用户会说出他的需求，你需要从下面提供的几百个书签列表（JSON）中，挑选出最匹配该需求的 1 到 5 个书签。
输出严格的 JSON：
{"results": [{"title": "书签标题", "url": "书签URL", "reason": "一句话推荐理由"}]}
如果完全没有相关的，请返回 {"results": []}`;

      const userPrompt = `【书签列表】：\n${JSON.stringify(sampleMarks)}\n\n【用户需求】：${query}`;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒超时

        const res = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.apiKey}` },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            temperature: 0.1,
            response_format: { type: "json_object" }
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          const errText = await res.text();
          let errMsg = `API 请求失败 (${res.status})`;
          if (res.status === 401) errMsg = "API Key 错误或已失效 (401)";
          if (res.status === 402) errMsg = "API 余额不足 (402)";
          if (res.status === 429) errMsg = "请求过于频繁，请稍候重试 (429)";
          throw new Error(errMsg);
        }

        const data = await res.json();
        let contentStr = data.choices?.[0]?.message?.content || '{"results":[]}';
        // 兼容大模型偶尔输出的 Markdown 包裹
        contentStr = contentStr.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

        let content = { results: [] };
        try {
          content = JSON.parse(contentStr);
        } catch (parseErr) {
          console.error("AI 响应 JSON 解析失败:", contentStr);
          throw new Error(`AI 返回格式异形解析失败: ${parseErr.message}`);
        }

        resolve(content.results || []);
      } catch (err) {
        if (err.name === 'AbortError') {
          reject(new Error("请求超时，请检查网络或稍后重试"));
        } else {
          reject(new Error(err.message || "未知网络或解析错误"));
        }
      }
    });
  });
}

// ============ 扩展安装时初始化 ============
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get({ categories: null }, (items) => {
    if (!items.categories) {
      chrome.storage.sync.set({ categories: DEFAULT_CATEGORIES, enabled: true, recentLogs: [], domainRules: {}, ruleStats: {} });
    }
  });
  updateProgress({ isProcessing: false });
  updateFolderRecheckState({ isProcessing: false });
});
