# F08 本地草稿库

- 状态：已确认
- 关联：[ADR 0022](../adr/0022-draft-aggregate-current-editing-session.md)、[ADR 0029](../adr/0029-draft-library-pre-release-baseline-reset.md)、[ADR 0031](../adr/0031-draft-publication-record.md)、[ADR 0032](../adr/0032-draft-library-load-barrier.md)、[ADR 0033](../adr/0033-per-draft-deletion-marker.md)、[ADR 0034](../adr/0034-draft-content-revision.md)、[ADR 0035](../adr/0035-draft-thumbnail-generation.md)
- 实施跟踪：[Issue #9](https://github.com/leon-zym/plogkit/issues/9)

## 概述

首页同时承担新建入口与草稿库浏览：上方 Banner 提供“选择照片”，下方 Grid 展示设备本地保存的草稿。用户可以打开历史草稿继续编辑、删除不再需要的草稿，并在持久事实损坏时识别和移除异常条目。

## 范围

- 冷启动恢复、枚举、排序并展示全部草稿。
- 通过首页 Banner 创建至少包含一张导入资产的新草稿。
- 正常草稿打开、同进程会话保留与跨草稿切换。
- 完整构图缩略图、两种全局显示方式与生成失败降级。
- 单草稿确认删除、当前编辑会话删除协调与恢复性物理清理。
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

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 用户启动应用
- THEN 首页上方立即展示 Banner 与“选择照片”按钮
- AND 应用不自动进入 Editor，也不展示“继续上次编辑”快捷入口
- WHEN 草稿库完成冷启动读取
- THEN 下方以 Grid 展示已有草稿

#### Scenario: 空草稿库不重复新建入口

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 设备本地没有草稿
- WHEN 草稿库完成冷启动读取
- THEN Banner 仍展示“选择照片”按钮
- AND 下方 Grid 保持为空，不展示空状态插画、占位草稿或第二个新建按钮

#### Scenario: 从首页创建草稿

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 用户位于首页
- WHEN 用户点击 Banner 中的“选择照片”并至少成功导入一张照片
- THEN 应用成功创建新草稿后进入该草稿的 Editor
- AND 草稿同时记录创建时间与初始最近编辑时间
- AND Grid 内不提供额外新建入口

（注：取消、全部失败、部分成功与图片上限由 [F07](F07-image-import.md) 定义。）

#### Scenario: 创建新草稿不覆盖已有草稿

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 草稿库已有一个可正常打开的草稿
- WHEN 用户从首页成功创建另一个草稿
- THEN 新草稿进入 Editor
- AND 原草稿及其统一文档和本地素材保持完整，仍可从 Grid 打开

#### Scenario: 创建失败不留下可见草稿

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 用户开始创建一个草稿
- WHEN 创建在成功提交前失败或进程终止
- THEN 本次未完成创建不会在当前进程或下次启动时显示为正常或损坏草稿
- AND 用户原有草稿保持不变

### 需求 2：Grid、排序与加载

#### Scenario: 以纯缩略图 Grid 展示草稿

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 草稿库包含多个草稿
- WHEN 首页展示 Grid
- THEN 手机每行展示 3 个无边框正方形 item，item 之间保留小间距
- AND 大屏设备在保持合理最小 item 宽度的前提下自适应增加列数
- AND item 不展示草稿名称、创建时间、最近编辑时间、照片数量或内部身份
- AND Grid 使用虚拟化列表，不对草稿数量设置人为上限

#### Scenario: 按最近编辑时间排序

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 多个草稿均有最近编辑时间
- WHEN 首页展示草稿
- THEN 草稿按最近编辑时间倒序排列
- AND 相同时间使用稳定次序，重复进入首页时列表不抖动

#### Scenario: 新内容修订更新排序时间

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 一个已有草稿
- WHEN 普通编辑、成功撤销或成功重做形成不同的统一文档并保存成功
- THEN 最近编辑时间与新内容修订一同提交
- AND 该草稿按新的最近编辑时间参与排序
- AND no-op 撤销、no-op 重做、相同文档保存或保存失败不更新时间

#### Scenario: 非编辑活动不改变排序

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 一个已有草稿
- WHEN 用户只打开或浏览草稿、返回首页、导出、重建缩略图或执行维护
- THEN 草稿的最近编辑时间不变
- AND 这些活动本身不改变 Grid 顺序

#### Scenario: 缺少最近编辑时间的条目置顶

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 一个损坏草稿无法取得可信的最近编辑时间
- WHEN 首页展示草稿
- THEN 该条目排在所有具有最近编辑时间的草稿之前
- AND 多个缺失时间的条目仍使用稳定次序

#### Scenario: 冷启动只安装完整可靠结果

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 应用进程刚启动
- WHEN 草稿库加载
- THEN 完整、排序稳定且已区分正常与损坏条目的结果就绪前，Grid 持续展示加载状态
- AND 应用不把加载中间结果误认为空草稿库，也不逐项跳变为损坏状态

#### Scenario: 加载与创建并发不丢失草稿

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 冷启动读取尚未完成，用户已经开始选择照片
- WHEN 至少一张照片导入成功
- THEN 应用在可靠草稿库状态就绪后完成创建
- AND 新草稿与所有原有草稿都保留，不被迟到的加载结果覆盖

#### Scenario: 同进程返回首页不重复加载

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 草稿库已经在当前进程成功加载
- WHEN 创建、保存或删除成功后用户返回首页
- THEN 首页立即反映最新草稿、顺序或删除结果
- AND 不再次显示全库加载状态

### 需求 3：草稿缩略图与显示方式

#### Scenario: 为完整构图提供两种缩略图表示

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 草稿产生新的已保存内容修订
- WHEN 应用异步生成草稿缩略图
- THEN 生成适合正方形裁切铺满的表示与保持作品原始比例的表示
- AND 两种表示均来自包含图片、拼接、背景和文字的完整构图，不以第一张原图代替
- AND 生成失败不改变统一文档保存结果或最近编辑时间

#### Scenario: 两种缩略图按同一内容修订切换

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 新内容修订的两种缩略图正在生成
- WHEN 只有其中一种完成，或草稿再次形成更新内容
- THEN Grid 不混合展示不同内容修订的两种缩略图
- AND 只有同一内容修订的两种表示都可用时才一起切换

#### Scenario: 切换全局显示方式

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 草稿库已有可用缩略图
- WHEN 用户点击首页的菜单图标并展开“显示方式”
- THEN 菜单提供“正方形”和“原始比例”两个选项
- AND “正方形”在无边框正方形容器中以 `cover` 裁切铺满
- AND “原始比例”在相同正方形容器中以 `contain` 完整展示
- AND 选择作为设备本地全局偏好保存并作用于全部草稿
- AND 默认显示方式为“正方形”

#### Scenario: 最新缩略图尚不可用时降级

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 草稿完整可读，但最新内容修订的缩略图尚未生成或生成失败
- WHEN Grid 展示该草稿
- THEN 有旧的完整缩略图对时继续显示旧图，不展示过期或损坏警告
- AND 没有旧图时使用中性静态占位图，不持续显示无法结束的加载动画
- AND 不临时使用第一张原图冒充完整构图缩略图

### 需求 4：打开、切换与返回

#### Scenario: 点击正常草稿进入编辑

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN Grid 中有多个正常草稿
- WHEN 用户点击其中一个 item
- THEN 应用打开用户所选草稿并进入 Editor
- AND 不会因上次编辑过其他草稿而打开错误内容

#### Scenario: 同进程重新打开同一草稿

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 用户从 Editor 返回首页时只保存、没有切换或删除当前草稿
- WHEN 用户再次点击同一草稿
- THEN 应用复用当前编辑会话
- AND 保留该会话内的 undo/redo history

#### Scenario: 打开其他草稿失败

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 当前有一个活跃编辑会话
- WHEN 用户打开另一草稿，但当前保存或目标读取失败
- THEN 应用不进入目标 Editor
- AND 原当前编辑会话及其最新状态保持不变

#### Scenario: 返回首页按内容修订处理滚动位置

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 用户从 Grid 中打开一个草稿
- WHEN 该草稿形成新的已保存内容修订后返回首页
- THEN Grid 滚动到顶部并展示最新编辑的草稿
- WHEN 用户只查看草稿、没有形成新保存版本便返回
- THEN Grid 保留原滚动位置

### 需求 5：删除草稿

#### Scenario: 长按并确认删除正常草稿

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN Grid 中有一个正常草稿
- WHEN 用户长按 item
- THEN 应用打开包含“删除草稿”的操作菜单
- WHEN 用户选择删除并在确认弹窗中确认，且删除成功
- THEN 草稿从 Grid 消失且不能重新打开
- AND 不提供短时撤销、回收站或最近删除入口

#### Scenario: 删除当前编辑会话绑定的草稿

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 用户返回首页后，目标草稿仍绑定当前编辑会话
- WHEN 用户确认删除该草稿
- THEN 应用阻止该会话产生新的编辑与自动保存，并先保存最新文档
- AND 保存及删除成功后结束当前编辑会话，使旧 Editor 永久不可继续使用
- AND 应用停留在首页，不自动打开其他草稿

#### Scenario: 删除当前草稿前保存失败

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 当前草稿仍有未成功保存的修改
- WHEN 用户确认删除，但保存失败
- THEN 删除不提交，草稿保持完整可见
- AND 原当前编辑会话恢复可用并保留修改

#### Scenario: 无法确认删除结果

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 用户已经确认删除一个草稿
- WHEN 存储故障使应用无法判断删除是否成功
- THEN 首页显示页面级存储失败提示与“重试”按钮，不展示猜测的列表结果
- AND 若目标绑定当前编辑会话，该会话保持不可编辑，直到重试得到确定结果

#### Scenario: 删除后的物理清理中断不使草稿重新出现

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 应用已经确认删除成功
- WHEN 物理文件清理失败或进程终止
- THEN 删除结果保持成立，草稿不会重新出现在 Grid 中且不能重新打开
- AND 后续冷启动或安全维护入口继续清理

### 需求 6：损坏草稿与整体读取失败

#### Scenario: 可恢复保存中断不误报损坏

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 草稿保存曾在替换过程中终止
- WHEN 用户下次进入草稿库
- THEN 应用恢复到中断前或已经完整提交的新版本
- AND 不展示部分写入的内容，只有恢复后仍无法通过完整性校验才标记为损坏草稿

#### Scenario: 已确认损坏的单个草稿不阻塞列表

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 一个草稿已经被可靠确认无法安全打开，其他草稿正常
- WHEN 首页完成加载
- THEN 正常草稿和该损坏草稿同时出现在可靠 Grid 中
- AND 单项损坏不升级为整个页面读取失败

#### Scenario: 在 Grid 中展示损坏草稿

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 一个草稿经过自动恢复后仍无法安全打开
- WHEN Grid 展示该条目
- THEN 有旧草稿缩略图时继续使用旧图，否则使用损坏占位图
- AND 两种情况都叠加半透明警告遮罩与警告图标
- AND 损坏草稿不以残缺内容进入 Editor

#### Scenario: 点击损坏草稿只允许删除

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN Grid 中有一个损坏草稿
- WHEN 用户点击该 item
- THEN 应用提示“草稿已损坏”并询问是否删除
- AND 不提供同进程手动重试或强制打开

#### Scenario: 无法可靠读取任一必需事实时整体失败

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN 应用无法枚举草稿库，或任一草稿的必需事实因 I/O 故障无法可靠判定
- WHEN 首页加载草稿库
- THEN 应用显示页面级读取失败提示与“重试”按钮
- AND 不把该草稿误报为损坏，也不把旧快照、空 Grid 或部分结果当作本次可靠结果

### 需求 7：可访问性

#### Scenario: 纯缩略图 item 仍可被辅助技术区分和操作

- 状态：已确认（待 [Issue #9](https://github.com/leon-zym/plogkit/issues/9)）
- GIVEN Grid 不显示可见 metadata 或常驻操作按钮
- WHEN 辅助技术聚焦一个正常或损坏 item
- THEN 本地化无障碍信息包含当前位置与总数、可用时的最近编辑时间、照片数量，以及正常、正在生成缩略图或损坏状态
- AND 正常 item 提供打开与删除操作提示，损坏 item 仅提供删除操作提示，且不暴露内部身份
- AND 所有交互元素具有稳定 `testID`
