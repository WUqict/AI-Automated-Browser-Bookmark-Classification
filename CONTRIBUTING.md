# Contributing Guide

感谢你愿意为 AI MarkMaster 做贡献。

## 开始之前

- 新功能或较大改动，请先开一个 Issue 讨论目标和范围。
- Bug 修复可直接提交 PR，但建议附上复现步骤。

## 开发流程

1. Fork 本仓库并创建分支。
2. 在分支上完成修改，保持提交粒度清晰。
3. 提交 PR，并在描述中说明：
   - 背景和目标
   - 具体改动
   - 风险与兼容性
   - 测试方式

## 代码规范

- 使用 UTF-8 编码。
- 缩进 2 空格。
- 保持函数职责单一，避免过长函数。
- 增加注释时请解释“为什么”，避免解释显而易见的“做了什么”。

## 提交前自检

```bash
node --check background.js
node --check popup.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

## PR 评审建议

- 保持变更聚焦，避免一次 PR 混入多个无关主题。
- 涉及行为变化时，补充截图或录屏（尤其是 popup UI）。
- 涉及分类策略变化时，补充至少 3 个真实示例。

欢迎任何形式的改进：代码、文档、测试、Issue 整理都很有价值。
