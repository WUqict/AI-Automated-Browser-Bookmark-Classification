# 更新日志 Changelog

## 2026-04-02

### 修复 Fixed

- 修复“待人工分类”中偶发 `Can't find bookmark for id.` 报错。
- 为失效书签 ID（书签已移动或删除）增加后台兜底，返回友好错误提示。
- 手动归类流程在 `move/update` 阶段补充异常处理，避免原始 Chrome 错误直出。
- Popup 在遇到失效书签时会自动移除该条目并刷新待人工分类列表。

