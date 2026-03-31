# AI MarkMaster Extension

[简体中文](#简体中文) | [English](#english)

## 简体中文

AI MarkMaster 是一个 Chrome 扩展，使用 DeepSeek AI 自动整理书签，支持自动分类、低置信度保护、历史重整和语义检索。

### 功能亮点

- 自动分类：新建书签后自动识别并移动到目标文件夹。
- 低置信度保护：不确定结果会进入 `待二次判断`，避免误分。
- 智能检索：支持标题/域名/路径模糊搜索 + AI 语义检索。
- 历史重整：支持一键整理历史书签和按文件夹重整。
- 规则学习：高置信度结果会逐步沉淀域名规则，减少重复判断。

### 截图展示

#### 使用效果

![使用效果](assets/screenshots/usage-demo.gif)

### 安装使用

1. 克隆或下载本仓库。
2. 打开 Chrome，访问 `chrome://extensions/`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择本项目目录。
5. 打开扩展弹窗，填写 DeepSeek API Key。

### 隐私与权限

- 权限：`bookmarks`、`history`、`storage`、`notifications`。
- 网络：访问 DeepSeek API，以及目标网页公开 HTML 信号（用于分类）。
- API Key 当前存储在 `chrome.storage.sync`（便于多设备同步）。
- 自动分类/重整：发送当前书签及必要页面信号（标题、域名等）。
- AI 检索：发送本地书签样本（当前实现最多约 1000 条标题+URL）用于语义匹配。

### 开发检查

```bash
node --check background.js
node --check popup.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

### 项目结构

```text
.
├─ background.js
├─ popup.html
├─ popup.css
├─ popup.js
├─ manifest.json
├─ icons/
├─ assets/
│  └─ screenshots/
├─ docs/
│  └─ ROADMAP.zh-CN.md
└─ .github/
```

更多规划见 [docs/ROADMAP.zh-CN.md](docs/ROADMAP.zh-CN.md)。

## English

AI MarkMaster is a Chrome extension that organizes bookmarks with DeepSeek AI. It supports auto-categorization, low-confidence protection, historical re-organization, and semantic search.

### Highlights

- Auto categorize newly created bookmarks.
- Low-confidence results go to `待二次判断` to avoid wrong moves.
- Fuzzy local search + AI semantic search.
- One-click re-organization for old bookmarks or specific folders.
- Domain rule learning from high-confidence results.

### Screenshots

#### Usage Demo

![Usage Demo](assets/screenshots/usage-demo.gif)

### Quick Start

1. Clone this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable Developer mode.
4. Click “Load unpacked” and select this project folder.
5. Open the extension popup and set your DeepSeek API key.

### Privacy & Permissions

- Permissions: `bookmarks`, `history`, `storage`, `notifications`.
- Network access: DeepSeek API + public page HTML signals for classification.
- API key is currently stored in `chrome.storage.sync`.
- Auto classify/reorganize sends current bookmark data and minimal page signals.
- AI search sends a local bookmark sample (up to ~1000 title+URL items).

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

[MIT](LICENSE)
