# F08 本地草稿库

- 状态：已确认
- 关联：[ADR 0022](../adr/0022-draft-aggregate-current-editing-session.md)、[ADR 0025](../adr/0025-recoverable-draft-persistence-maintenance.md)、[ADR 0027](../adr/0027-draft-root-record.md)、[ADR 0028](../adr/0028-draft-deletion-tombstone.md)、[ADR 0029](../adr/0029-draft-library-pre-release-baseline-reset.md)、[ADR 0030](../adr/0030-draft-library-enumeration-snapshot.md)
- 实施跟踪：[Issue #9](https://github.com/leon-zym/plogkit/issues/9)

## 概述

首页同时承担新建入口与草稿库浏览：上方 Banner 提供“选择照片”，下方 Grid 展示设备本地保存的草稿。用户可以打开历史草稿继续编辑、删除不再需要的草稿，并在持久事实损坏时识别和移除异常条目。

## 范围

- 冷启动恢复、枚举、排序并展示全部草稿。
- 通过首页 Banner 创建至少包含一张导入资产的新草稿。
- 正常草稿打开、同进程会话保留与跨草稿切换。
- 完整构图缩略图、两种全局显示方式与生成失败降级。
- 单草稿确认删除、当前编辑会话删除 barrier 与恢复性物理清理。
- 损坏草稿的明确展示、删除入口与草稿库整体读取失败处理。

## 非目标

- 空白草稿、草稿命名或重命名、搜索、筛选、复制和文件夹。
- 草稿数量上限、自动删除旧草稿或基于存储压力的淘汰策略。
- 多选、批量删除、清空草稿库、回收站、最近删除或删除撤销。
- “继续上次编辑”快捷入口、持久化最近草稿定位器或启动后自动进入 Editor。
- 云备份、云同步、跨设备草稿、账户和网络能力。
- 持久草稿版本历史、跨进程修改同一草稿或权威全局草稿索引。

## 需求与场景

### 需求 1：首页与新建入口

#### Scenario: 首页同时展示新建入口与草稿库

- GIVEN 用户启动应用
- WHEN 草稿库完成冷启动读取
- THEN 首页上方展示 Banner 与“选择照片”按钮
- AND 下方以 Grid 展示已有草稿
- AND 应用不自动进入 Editor，也不展示“继续上次编辑”快捷入口

#### Scenario: 空草稿库不重复新建入口

- GIVEN 设备本地没有草稿
- WHEN 用户进入首页
- THEN Banner 仍展示“选择照片”按钮
- AND 下方 Grid 保持为空，不展示空状态插画、占位草稿或第二个新建按钮

#### Scenario: 从首页创建草稿

- GIVEN 用户位于首页
- WHEN 用户点击 Banner 中的“选择照片”并至少成功导入一张照片
- THEN 应用创建新的草稿并进入该草稿的 Editor
- AND 草稿同时记录创建时间与初始最近编辑时间
- AND Grid 内不提供额外新建入口

（注：取消、全部失败、部分成功、图片上限与初始 aggregate 发布场景由 [F07](F07-image-import.md) 定义。）

### 需求 2：Grid、排序与加载

#### Scenario: 以纯缩略图 Grid 展示草稿

- GIVEN 草稿库包含多个草稿
- WHEN 首页展示 Grid
- THEN 手机每行展示 3 个无边框正方形 item，item 之间保留小间距
- AND 大屏设备在保持合理最小 item 宽度的前提下自适应增加列数
- AND item 不展示草稿名称、创建时间、最近编辑时间、照片数量或 `DraftId`
- AND Grid 使用虚拟化列表，不对草稿数量设置人为上限

#### Scenario: 按最近编辑时间排序

- GIVEN 多个草稿均有最近编辑时间
- WHEN 草稿库构建列表快照
- THEN 草稿按最近编辑时间倒序排列
- AND 相同时间使用稳定次序，重复进入首页时列表不抖动

#### Scenario: 新文档版本更新排序时间

- GIVEN 一个已有草稿
- WHEN 普通编辑、成功撤销或成功重做形成不同的统一文档并保存成功
- THEN 草稿根记录中的最近编辑时间与新文档版本一同提交
- AND 该草稿按新的最近编辑时间参与排序
- AND no-op 撤销、no-op 重做或相同文档保存不更新时间

#### Scenario: 非编辑活动不改变排序

- GIVEN 一个已有草稿
- WHEN 用户只打开或浏览草稿、返回首页、导出、重建缩略图或执行非活跃维护
- THEN 草稿的最近编辑时间不变
- AND 这些活动本身不改变 Grid 顺序

#### Scenario: 缺少最近编辑时间的条目置顶

- GIVEN 一个条目无法取得可信的最近编辑时间
- WHEN 草稿库构建列表快照
- THEN 该条目排在所有具有最近编辑时间的草稿之前
- AND 多个缺失时间的条目仍使用稳定次序

#### Scenario: 冷启动一次构建完整快照

- GIVEN 应用进程刚启动
- WHEN 草稿库加载
- THEN 应用枚举全部草稿，先收敛可恢复持久状态，再完成完整性校验与排序
- AND 该过程不读取原图 bytes、不解码或重建草稿缩略图
- AND 完整快照就绪前 Grid 展示加载状态，不把加载误认为空草稿库

#### Scenario: 同进程返回首页不重复扫盘

- GIVEN 草稿库已在当前进程构建列表快照
- WHEN create、save 或 delete transaction 成功
- THEN Draft Library 更新同一进程内的列表快照
- WHEN 用户随后返回首页
- THEN 首页直接读取该快照，不重新枚举全部草稿

### 需求 3：草稿缩略图与显示方式

#### Scenario: 为完整构图提供两种缩略图表示

- GIVEN 草稿的最新统一文档保存成功
- WHEN 草稿库异步生成草稿缩略图
- THEN 生成适合正方形裁切铺满的表示与保持作品原始比例的表示
- AND 两种表示均来自包含图片、拼接、背景和文字的完整构图，不以第一张原图代替
- AND 生成失败不改变统一文档保存结果或最近编辑时间
- AND 旧任务不得覆盖更新文档的缩略图，也不得为已提交删除的草稿重新发布文件

#### Scenario: 切换全局显示方式

- GIVEN 草稿库已有可用缩略图
- WHEN 用户点击首页的菜单图标并展开“显示方式”
- THEN 菜单提供“正方形”和“原始比例”两个选项
- AND “正方形”在无边框正方形容器中以 `cover` 裁切铺满
- AND “原始比例”在相同正方形容器中以 `contain` 完整展示
- AND 选择作为设备本地全局偏好保存并作用于全部草稿
- AND 默认显示方式为“正方形”

#### Scenario: 正常草稿缺少缩略图

- GIVEN 草稿 aggregate 完整可读，但所需缩略图缺失、损坏或尚未生成
- WHEN Grid 展示该草稿
- THEN item 使用中性的生成中占位图，不展示损坏警告
- AND 草稿库在后台异步重建两种缩略图
- AND 不临时使用第一张原图冒充完整构图缩略图

### 需求 4：打开、切换与返回

#### Scenario: 点击正常草稿进入编辑

- GIVEN Grid 中有一个正常草稿 item
- WHEN 用户点击该 item
- THEN 应用以该 item 的 `DraftId` 打开 Current Editing Session 并进入 Editor
- AND Editor 导航显式携带目标 `DraftId`，不依赖最近草稿定位器

#### Scenario: 同进程重新打开同一草稿

- GIVEN 用户从 Editor 返回首页时只 flush、没有切换或删除当前草稿
- WHEN 用户再次点击同一 `DraftId` 的 item
- THEN 应用复用当前编辑会话
- AND 保留该会话内的 undo/redo history

#### Scenario: 打开其他草稿失败

- GIVEN 当前有一个活跃编辑会话
- WHEN 用户从 Grid 打开另一草稿，但当前 flush 或目标读取失败
- THEN 应用不进入目标 Editor
- AND 原当前编辑会话及其最新状态保持不变

#### Scenario: 返回首页按编辑结果处理滚动位置

- GIVEN 用户从 Grid 中打开一个草稿
- WHEN 该草稿形成新的已保存文档版本后返回首页
- THEN Grid 滚动到顶部并展示最新编辑的草稿
- WHEN 用户只查看草稿、没有形成新保存版本便返回
- THEN Grid 保留原滚动位置

### 需求 5：删除草稿

#### Scenario: 长按并确认删除正常草稿

- GIVEN Grid 中有一个正常草稿
- WHEN 用户长按 item
- THEN 应用打开包含“删除草稿”的操作菜单
- WHEN 用户选择删除并在确认弹窗中确认
- THEN 草稿立即从 Grid 消失
- AND 不提供短时撤销、回收站或最近删除入口

#### Scenario: 删除当前编辑会话绑定的草稿

- GIVEN 用户返回首页后，目标草稿仍绑定当前编辑会话
- WHEN 用户确认删除该草稿
- THEN Current Editing Session 阻止新编辑与 autosave，并先 flush 最新文档
- AND flush 成功后提交删除、结束当前编辑会话并永久失效旧 handle
- AND 应用停留在首页，不自动打开其他草稿

#### Scenario: 删除当前草稿前 flush 失败

- GIVEN 当前草稿仍有未成功保存的修改
- WHEN 用户确认删除，但 flush 失败
- THEN 删除不提交，草稿保持完整可见
- AND 原当前编辑会话恢复可用

#### Scenario: 物理清理中断不使草稿重新出现

- GIVEN 用户删除草稿的待删除标记已成功提交
- WHEN 物理目录清理失败或进程终止
- THEN 删除结果保持成立，草稿不再出现在 Grid 中且不能重新打开
- AND 后续冷启动或安全维护入口继续幂等清理

### 需求 6：损坏草稿与整体读取失败

#### Scenario: 可恢复提交中断不误报损坏

- GIVEN 草稿根记录或 catalog 的保存曾在替换过程中终止
- WHEN 草稿库冷启动枚举该草稿
- THEN 应用先按 `current`、`backup`、`temp` 协议收敛到最后一个完整版本
- AND 只有收敛后仍无法通过完整性校验才把条目标记为损坏草稿

#### Scenario: 在 Grid 中展示损坏草稿

- GIVEN 一个草稿经过自动恢复后仍无法安全打开
- WHEN Grid 展示该条目
- THEN 有旧草稿缩略图时继续使用旧图，否则使用损坏占位图
- AND 两种情况都叠加半透明警告遮罩与警告图标
- AND 损坏草稿不以残缺内容进入 Editor

#### Scenario: 点击损坏草稿只允许删除

- GIVEN Grid 中有一个损坏草稿
- WHEN 用户点击该 item
- THEN 应用提示“草稿已损坏”并询问是否删除
- AND 不提供同进程手动重试或强制打开

#### Scenario: 草稿库整体读取失败

- GIVEN 应用无法枚举草稿根目录或无法产生可靠列表快照
- WHEN 首页加载草稿库
- THEN 应用显示页面级读取失败提示与“重试”按钮
- AND 不把旧快照、空 Grid 或全部损坏 item 当作本次可靠结果

### 需求 7：可访问性

#### Scenario: 纯缩略图 item 仍可被辅助技术理解和操作

- GIVEN Grid 不显示可见 metadata 或常驻操作按钮
- WHEN 辅助技术聚焦一个正常或损坏 item
- THEN item 提供本地化的 `accessibilityLabel`、明确状态与打开或删除操作
- AND 所有交互元素具有稳定 `testID`
