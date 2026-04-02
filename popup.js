// popup.js — AI MarkMaster Popup 逻辑

const DEFAULT_CATEGORIES = [
    "社交媒体", "影音娱乐", "游戏电竞", "购物消费", "新闻资讯",
    "开发编程", "设计创作", "学习教育", "工具效率", "云服务",
    "搜索导航", "图书阅读", "成人内容", "资源下载", "其他"
];

const $apiKey = document.getElementById("apiKey");
const $categories = document.getElementById("categories");
const $enableToggle = document.getElementById("enableToggle");
const $saveBtn = document.getElementById("saveBtn");
const $saveMsg = document.getElementById("saveMsg");
const $logList = document.getElementById("logList");

const $searchInput = document.getElementById("searchInput");
const $searchResults = document.getElementById("searchResults");

const $aiSearchInput = document.getElementById("aiSearchInput");
const $aiSearchBtn = document.getElementById("aiSearchBtn");
const $aiSearchResults = document.getElementById("aiSearchResults");

const $organizeBtn = document.getElementById("organizeBtn");
const $organizeMsg = document.getElementById("organizeMsg");

const $folderRecheckBtn = document.getElementById("folderRecheckBtn");
const $folderRecheckMsg = document.getElementById("folderRecheckMsg");

const $recentHistoryList = document.getElementById("recentHistoryList");
const $refreshHistoryBtn = document.getElementById("refreshHistoryBtn");

const $pendingList = document.getElementById("pendingList");
const $refreshPendingBtn = document.getElementById("refreshPendingBtn");

let categoriesCache = [...DEFAULT_CATEGORIES];
let allBookmarksCache = [];
let searchDebounceTimer = null;
let lastSearchItems = [];

function sendRuntimeMessage(payload) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (response?.error) {
                reject(new Error(response.error));
                return;
            }
            resolve(response || {});
        });
    });
}

function withDebounce(fn, delay = 140) {
    return (...args) => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => fn(...args), delay);
    };
}

function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function showMsg(text, isError = false) {
    $saveMsg.textContent = text;
    $saveMsg.style.color = isError ? "#e74c3c" : "#3f658f";
    setTimeout(() => { $saveMsg.textContent = ""; }, 2200);
}

function isBookmarkNotFoundError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    return (
        msg.includes("can't find bookmark for id") ||
        msg.includes("cannot find bookmark for id") ||
        msg.includes("书签不存在") ||
        (msg.includes("bookmark") && msg.includes("id") && msg.includes("find"))
    );
}

function openSecureUrl(urlStr, { clearSearch = false } = {}) {
    try {
        const parsedUrl = new URL(urlStr);
        const protocol = parsedUrl.protocol.toLowerCase();

        if (protocol === "javascript:" || protocol === "data:" || protocol === "vbscript:" || protocol === "file:") {
            showMsg("⚠️ 出于安全策略，系统禁止扩展内执行此类小书签或本地链接", true);
            return;
        }
        chrome.tabs.create({ url: urlStr });
        if (clearSearch) {
            clearSearchUI(true);
        }
    } catch (e) {
        if (!urlStr.startsWith("http") && !urlStr.startsWith("ftp")) {
            showMsg("⚠️ 无法识别的书签链接格式", true);
            return;
        }
        chrome.tabs.create({ url: urlStr });
        if (clearSearch) {
            clearSearchUI(true);
        }
    }
}

function clearSearchUI(refocus = false) {
    $searchInput.value = "";
    $searchResults.style.display = "none";
    $searchResults.innerHTML = "";
    lastSearchItems = [];
    if (refocus) {
        $searchInput.focus();
        $searchInput.select();
    }
}

function tokenize(text) {
    return (text || "")
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
        .filter((token) => token && token.length >= 1);
}

function extractDomain(url) {
    try {
        return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
        return "";
    }
}

function buildBookmarkCache(tree) {
    const cache = [];

    function walk(node, path) {
        if (node.url) {
            const domain = extractDomain(node.url);
            cache.push({
                id: node.id,
                title: node.title || "",
                url: node.url,
                titleLower: (node.title || "").toLowerCase(),
                urlLower: (node.url || "").toLowerCase(),
                domain,
                domainLower: domain,
                pathLower: path.join("/").toLowerCase(),
                dateAdded: node.dateAdded || 0
            });
            return;
        }

        const nextPath = node.title ? [...path, node.title] : path;
        for (const child of (node.children || [])) {
            walk(child, nextPath);
        }
    }

    tree.forEach((root) => walk(root, []));
    return cache;
}

async function refreshBookmarkCache() {
    const tree = await new Promise((resolve) => chrome.bookmarks.getTree(resolve));
    allBookmarksCache = buildBookmarkCache(tree);
}

function scoreBookmark(item, queryLower, queryTokens) {
    let score = 0;

    if (item.titleLower === queryLower) score += 120;
    if (item.titleLower.includes(queryLower)) score += 60;
    if (item.domainLower === queryLower) score += 55;
    if (item.domainLower.includes(queryLower)) score += 40;
    if (item.urlLower.includes(queryLower)) score += 28;
    if (item.pathLower.includes(queryLower)) score += 14;

    let tokenMatchedCount = 0;
    for (const token of queryTokens) {
        let matched = false;
        if (item.titleLower.startsWith(token)) {
            score += 18;
            matched = true;
        } else if (item.titleLower.includes(token)) {
            score += 10;
            matched = true;
        }

        if (item.domainLower.startsWith(token)) {
            score += 14;
            matched = true;
        } else if (item.domainLower.includes(token)) {
            score += 9;
            matched = true;
        }

        if (item.urlLower.includes(token)) {
            score += 6;
            matched = true;
        }

        if (matched) tokenMatchedCount += 1;
    }

    if (queryTokens.length > 0 && tokenMatchedCount === queryTokens.length) {
        score += 24;
    }

    if (item.dateAdded) {
        const ageMs = Date.now() - item.dateAdded;
        if (ageMs < 7 * 24 * 60 * 60 * 1000) score += 4;
        else if (ageMs < 30 * 24 * 60 * 60 * 1000) score += 2;
    }

    return score;
}

function renderSearchItems(links, container, closeText) {
    if (!links || links.length === 0) {
        container.innerHTML = '<p class="empty">未找到匹配的书签</p>';
        container.style.display = "block";
        return;
    }

    container.innerHTML = `
        <div class="close-float-btn">${closeText}</div>
    ` + links.map((b) => `
        <div class="search-item" data-url="${escapeHtml(b.url)}" title="${escapeHtml(b.title)}\n${escapeHtml(b.url)}">
            <span class="s-title">${escapeHtml(b.title)}</span>
            <div class="s-url">${escapeHtml(b.url)}</div>
            ${b.reason ? `<div class="ai-reason">💡 ${escapeHtml(b.reason)}</div>` : ""}
        </div>
    `).join("");
    container.style.display = "block";
}

async function runSmartSearch(rawQuery) {
    const queryLower = rawQuery.trim().toLowerCase();
    if (!queryLower) {
        clearSearchUI(false);
        return;
    }

    if (allBookmarksCache.length === 0) {
        await refreshBookmarkCache();
    }

    const queryTokens = tokenize(queryLower);
    const scored = allBookmarksCache
        .map((item) => ({
            title: item.title,
            url: item.url,
            score: scoreBookmark(item, queryLower, queryTokens)
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40);

    let links = scored;

    if (links.length === 0) {
        const fallback = await new Promise((resolve) => {
            chrome.bookmarks.search(queryLower, (results) => {
                resolve((results || []).filter((x) => x.url).slice(0, 30));
            });
        });
        links = fallback;
    }

    lastSearchItems = links;
    renderSearchItems(links, $searchResults, "🔽 收起检索结果");
}

const debouncedSearch = withDebounce((query) => {
    runSmartSearch(query).catch((err) => {
        console.error("智能搜索失败:", err);
        $searchResults.innerHTML = `<p class="empty text-error">❌ ${escapeHtml(err.message || "搜索失败")}</p>`;
        $searchResults.style.display = "block";
    });
}, 120);

$searchInput.addEventListener("input", (e) => {
    const query = e.target.value;
    if (!query.trim()) {
        clearSearchUI(false);
        return;
    }
    debouncedSearch(query);
});

$searchInput.addEventListener("focus", () => {
    if ($searchInput.value) {
        $searchInput.select();
    }
});

$searchInput.addEventListener("click", () => {
    if ($searchInput.value) {
        $searchInput.select();
    }
});

$searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && lastSearchItems.length > 0) {
        e.preventDefault();
        openSecureUrl(lastSearchItems[0].url, { clearSearch: true });
    }
});

$searchResults.addEventListener("click", (e) => {
    if (e.target.closest(".close-float-btn")) {
        $searchResults.style.display = "none";
        return;
    }
    const item = e.target.closest(".search-item");
    if (item && item.dataset.url) {
        openSecureUrl(item.dataset.url, { clearSearch: true });
    }
});

$aiSearchBtn.addEventListener("click", async () => {
    const query = $aiSearchInput.value.trim();
    if (!query) return;

    const apiKey = $apiKey.value.trim();
    if (!apiKey) {
        $aiSearchResults.style.display = "block";
        $aiSearchResults.innerHTML = '<p class="empty text-error">⚠️ 需先点开下方【⚙️ 插件设置】填写 API Key 才能调用 AI</p>';
        return;
    }

    $aiSearchBtn.disabled = true;
    $aiSearchBtn.textContent = "🤖 AI 思考中...";
    $aiSearchResults.style.display = "block";
    $aiSearchResults.innerHTML = '<p class="empty">正在翻阅数千条书签，请稍候...</p>';

    try {
        const response = await sendRuntimeMessage({ action: "aiSearch", query });
        const links = response.results || [];
        if (links.length === 0) {
            $aiSearchResults.innerHTML = '<p class="empty">AI 未能在你的书签中找到匹配项</p>';
        } else {
            renderSearchItems(links, $aiSearchResults, "🔽 收起 AI 推荐");
        }
    } catch (err) {
        $aiSearchResults.innerHTML = `<p class="empty text-error">❌ ${escapeHtml(err.message || "请求失败")}</p>`;
    } finally {
        $aiSearchBtn.disabled = false;
        $aiSearchBtn.textContent = "✨ 呼叫 AI 帮我找";
    }
});

$aiSearchResults.addEventListener("click", (e) => {
    if (e.target.closest(".close-float-btn")) {
        $aiSearchResults.style.display = "none";
        return;
    }
    const item = e.target.closest(".search-item");
    if (item && item.dataset.url) {
        openSecureUrl(item.dataset.url, { clearSearch: false });
    }
});

function renderRecentHistory(items) {
    if (!items || items.length === 0) {
        $recentHistoryList.innerHTML = '<p class="empty">暂无可展示的浏览记录</p>';
        return;
    }

    $recentHistoryList.innerHTML = items.map((item) => `
        <div class="mini-item" data-url="${escapeHtml(item.url)}" title="${escapeHtml(item.title || item.url)}\n${escapeHtml(item.url)}">
            <div class="mini-item-title">${escapeHtml(item.title || item.url)}</div>
            <div class="mini-item-url">${escapeHtml(item.url)}</div>
        </div>
    `).join("");
}

async function loadRecentHistory() {
    if (!chrome.history || !chrome.history.search) {
        $recentHistoryList.innerHTML = '<p class="empty text-error">当前环境不支持读取浏览历史</p>';
        return;
    }

    $recentHistoryList.innerHTML = '<p class="empty">正在读取最近浏览记录...</p>';

    try {
        const items = await new Promise((resolve) => {
            chrome.history.search(
                { text: "", startTime: Date.now() - 14 * 24 * 60 * 60 * 1000, maxResults: 20 },
                (results) => resolve((results || []).filter((item) => item.url && !item.url.startsWith("chrome://")))
            );
        });

        const sorted = items
            .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0))
            .slice(0, 12)
            .map((item) => ({ title: item.title || "", url: item.url }));

        renderRecentHistory(sorted);
    } catch (err) {
        $recentHistoryList.innerHTML = `<p class="empty text-error">❌ ${escapeHtml(err.message || "读取历史失败")}</p>`;
    }
}

$recentHistoryList.addEventListener("click", (e) => {
    const item = e.target.closest(".mini-item");
    if (item?.dataset.url) {
        openSecureUrl(item.dataset.url, { clearSearch: false });
    }
});

$refreshHistoryBtn.addEventListener("click", () => {
    loadRecentHistory();
});

$saveBtn.addEventListener("click", () => {
    const apiKey = $apiKey.value.trim();
    const categories = $categories.value
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean);
    const enabled = $enableToggle.checked;

    if (!apiKey) {
        showMsg("⚠️ 请输入 API Key", true);
        return;
    }

    if (categories.length === 0) {
        showMsg("⚠️ 至少需要一个分类", true);
        return;
    }

    chrome.storage.sync.set({ apiKey, categories, enabled }, () => {
        categoriesCache = categories;
        showMsg("✅ 已保存！");
        renderPendingBookmarkList(lastPendingBookmarksCache);
    });
});

function renderLogs(logs) {
    if (!logs || logs.length === 0) {
        $logList.innerHTML = '<p class="empty">暂无记录，保存一个书签试试</p>';
        return;
    }

    $logList.innerHTML = logs
        .map((log) => {
            const confidenceText = typeof log.confidence === "number"
                ? ` · 置信度 ${Math.round(log.confidence * 100)}%`
                : "";
            const reasonHtml = log.reason ? `<div class="log-reason">${escapeHtml(log.reason)}</div>` : "";

            return `
    <div class="log-item">
      <span class="log-title">${escapeHtml(log.title)}</span>
      <span class="log-category">${escapeHtml(log.category)}</span>
      <div class="log-time">${escapeHtml(log.time)}${confidenceText}</div>
      ${reasonHtml}
    </div>`;
        })
        .join("");
}

function updateOrganizeBtn(state) {
    if (!state || !state.isProcessing) {
        $organizeBtn.disabled = false;
        $organizeBtn.textContent = "🧹 一键整理历史旧书签";
        $organizeMsg.textContent = state?.message || "";
    } else {
        $organizeBtn.disabled = true;
        $organizeBtn.textContent = `🚀 正在整理... ${state.progress ? `(${state.progress}/${state.total})` : ''}`;
        $organizeMsg.textContent = state.message || "请勿关闭浏览器，可关闭此面板...";
    }
}

$organizeBtn.addEventListener("click", () => {
    const apiKey = $apiKey.value.trim();
    if (!apiKey) {
        showMsg("⚠️ 请先填写并保存 API Key", true);
        return;
    }

    if (confirm("📢 这将会扫描并整理你浏览器中所有未分类在指定目录下的书签。可能会持续较长时间，\n确认要开始吗？")) {
        chrome.runtime.sendMessage({ action: "startFullOrganize" }, (response) => {
            if (chrome.runtime.lastError || (response && response.error)) {
                $organizeMsg.textContent = "❌ 启动失败: " + (response?.error || chrome.runtime.lastError.message);
                $organizeMsg.style.color = "#e74c3c";
            }
        });
    }
});

function updateFolderRecheckUI(state) {
    if (!state || !state.isProcessing) {
        $folderRecheckBtn.disabled = false;
        $folderRecheckBtn.textContent = "♻️ 一键重整全部文件夹";
        $folderRecheckMsg.textContent = state?.message || "";
        return;
    }

    $folderRecheckBtn.disabled = true;
    $folderRecheckBtn.textContent = `♻️ 全量重整中 ${state.progress ? `(${state.progress}/${state.total})` : ""}`;
    const folderText = state.folderTotal ? ` 文件夹:${state.folderDone || 0}/${state.folderTotal}` : "";
    $folderRecheckMsg.textContent = `${state.message || "处理中..."}${folderText} 保留:${state.kept || 0} 重分:${state.moved || 0} 待人工:${state.pending || 0}`;
}

$folderRecheckBtn.addEventListener("click", async () => {
    if (!confirm("📂 将自动扫描并重整全部文件夹。\n分类正确的保持不动，疑似错误会自动重分。\n确认开始吗？")) {
        return;
    }

    try {
        await sendRuntimeMessage({ action: "startAllFoldersReorganize" });
    } catch (err) {
        $folderRecheckMsg.textContent = `❌ 启动失败: ${err.message || "未知错误"}`;
    }
});

let lastPendingBookmarksCache = [];

function renderPendingBookmarkList(bookmarks) {
    if (!bookmarks || bookmarks.length === 0) {
        $pendingList.innerHTML = '<p class="empty">暂无待人工分类项目</p>';
        return;
    }

    const categoryOptions = categoriesCache.map((cat) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join("");

    $pendingList.innerHTML = bookmarks.map((item) => `
        <div class="pending-item" data-id="${escapeHtml(item.id)}" data-url="${escapeHtml(item.url)}">
            <div class="pending-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
            <div class="pending-url">${escapeHtml(item.url)}</div>
            <div class="pending-actions">
                <select class="pending-category-select">${categoryOptions}</select>
                <button class="pending-apply-btn" type="button">归类</button>
                <button class="pending-open-btn" type="button">打开</button>
            </div>
        </div>
    `).join("");
}

async function loadPendingBookmarks() {
    $pendingList.innerHTML = '<p class="empty">正在加载待人工分类...</p>';
    try {
        const response = await sendRuntimeMessage({ action: "getPendingBookmarks", limit: 60 });
        lastPendingBookmarksCache = response.bookmarks || [];
        renderPendingBookmarkList(lastPendingBookmarksCache);
    } catch (err) {
        $pendingList.innerHTML = `<p class="empty text-error">❌ ${escapeHtml(err.message || "加载失败")}</p>`;
    }
}

$refreshPendingBtn.addEventListener("click", () => {
    loadPendingBookmarks();
});

$pendingList.addEventListener("click", async (e) => {
    const item = e.target.closest(".pending-item");
    if (!item) return;

    if (e.target.closest(".pending-open-btn")) {
        openSecureUrl(item.dataset.url, { clearSearch: false });
        return;
    }

    if (e.target.closest(".pending-apply-btn")) {
        const bookmarkId = item.dataset.id;
        const categorySelect = item.querySelector(".pending-category-select");
        const category = categorySelect?.value;
        if (!bookmarkId || !category) return;

        const btn = e.target.closest(".pending-apply-btn");
        btn.disabled = true;
        btn.textContent = "处理中...";

        try {
            await sendRuntimeMessage({
                action: "manualClassifyBookmark",
                bookmarkId,
                category
            });

            item.remove();
            if (!$pendingList.querySelector(".pending-item")) {
                $pendingList.innerHTML = '<p class="empty">暂无待人工分类项目</p>';
            }
        } catch (err) {
            if (isBookmarkNotFoundError(err)) {
                item.remove();
                if (!$pendingList.querySelector(".pending-item")) {
                    $pendingList.innerHTML = '<p class="empty">暂无待人工分类项目</p>';
                }
                showMsg("⚠️ 该书签已不存在，列表已自动刷新", true);
                loadPendingBookmarks();
                return;
            }
            btn.disabled = false;
            btn.textContent = "归类";
            showMsg(`❌ ${err.message || "人工分类失败"}`, true);
        }
    }
});

chrome.storage.onChanged.addListener((changes) => {
    if (changes.recentLogs) {
        renderLogs(changes.recentLogs.newValue);
    }
    if (changes.processingState) {
        updateOrganizeBtn(changes.processingState.newValue);
    }
    if (changes.folderRecheckState) {
        updateFolderRecheckUI(changes.folderRecheckState.newValue);
    }
});

function initSearchBoxBehavior() {
    setTimeout(() => {
        $searchInput.focus();
        $searchInput.select();
    }, 40);
}

async function init() {
    const items = await new Promise((resolve) => {
        chrome.storage.sync.get(
            { apiKey: "", categories: DEFAULT_CATEGORIES, enabled: true, recentLogs: [] },
            (result) => resolve(result)
        );
    });

    $apiKey.value = items.apiKey;
    $categories.value = (items.categories || DEFAULT_CATEGORIES).join("\n");
    $enableToggle.checked = !!items.enabled;
    categoriesCache = items.categories || DEFAULT_CATEGORIES;
    renderLogs(items.recentLogs || []);

    const localState = await new Promise((resolve) => {
        chrome.storage.local.get(["processingState", "folderRecheckState"], (result) => resolve(result));
    });

    updateOrganizeBtn(localState.processingState);
    updateFolderRecheckUI(localState.folderRecheckState);

    await Promise.all([
        refreshBookmarkCache(),
        loadRecentHistory(),
        loadPendingBookmarks()
    ]);

    initSearchBoxBehavior();
}

init().catch((err) => {
    console.error("Popup 初始化失败:", err);
    showMsg(`❌ 初始化失败: ${err.message || "未知错误"}`, true);
});
