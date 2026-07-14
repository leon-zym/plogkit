# Issue 跟踪器：GitHub

本仓库的 Issue 和 PRD 存放在 GitHub Issues 中。所有操作使用 `gh` CLI。

## 约定

- 创建：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- 读取：`gh issue view <number> --comments`，同时获取标签，并按需用 `jq` 过滤评论。
- 列出：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需添加 `--label` 和 `--state`。
- 评论：`gh issue comment <number> --body "..."`
- 添加或移除标签：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

仓库由 `git remote -v` 推断；在本仓库目录中运行时，`gh` 会自动识别。

## 是否将 Pull Request 纳入分诊入口

**否。**

如以后设为“是”，外部 PR 将使用与 Issue 相同的标签和状态，并通过对应的 `gh pr` 命令操作。

GitHub 的 Issue 与 PR 共用编号空间。遇到 `#42` 之类的编号时，先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`。

## 当 skill 要求“发布到 issue tracker”

创建 GitHub Issue。

## 当 skill 要求“获取相关 ticket”

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。一个 map Issue 对应多个 child Issue。

- Map：带有 `wayfinder:map` 标签的单个 Issue，正文包含 Notes、Decisions-so-far 和 Fog。
- Child ticket：作为 GitHub sub-issue 关联到 map；若仓库未启用 sub-issue，则加入 map 的任务列表，并在 child 正文顶部写入 `Part of #<map>`。标签使用 `wayfinder:<type>`。
- Blocking：优先使用 GitHub 原生 Issue dependencies；不可用时，在 child 正文顶部写入 `Blocked by: #<n>, #<n>`。
- Frontier query：按 map 顺序查找无未关闭 blocker 且无人认领的首个开放 child。
- Claim：`gh issue edit <n> --add-assignee @me`。
- Resolve：评论答案、关闭 child，并在 map 的 Decisions-so-far 中追加上下文链接。
