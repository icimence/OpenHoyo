# UIGF 导入、导出与统计

实现依据：[UIGF v4.2 标准](https://uigf.org/zh/standards/uigf.html)及其[官方文档源码](https://github.com/UIGF-org/UIGF-org.github.io/blob/main/docs/zh/standards/uigf.md)。

- 原神 `hk4e` 导入兼容 v4.0、v4.1、v4.2；导出标记为 v4.2。其他游戏分区忽略，不宣称支持其他游戏。
- `time` 是 `timezone` 下的当地时间，不是固定 UTC。每条记录独立保存时区；导出统一转换为 UTC+8，显示与活动期匹配也统一到 UTC+8。
- `gacha_type` 保留原始类型；`uigf_gacha_type` 中 400 合并为 301，共享角色活动池保底。
- 记录 ID 用字符串导出，Rust / SQLite 用 i64 保存，避免经过 JS 浮点数造成精度损失。
- 获取、导入和旧存档读取共用 `gacha_item` 解析层。已有有效 `item_id` 优先；空 ID 按名称、类型、星级唯一反查，并在入库时保存，不再等到导出才确定身份。
- 数据库的 `name`、`item_type`、`rank_type` 保留来源快照；展示和导出根据已知 ID 使用规范元数据，未知新物品使用来源字段兜底。已知 ID 与来源字段冲突时记录诊断日志，不覆盖原始快照。
- 获取到的物品暂时无法识别时仍保存记录，日志标记待识别；后续元数据更新后，读取存档即可补齐可唯一识别的空 ID。仍待识别的记录会阻止完整导出，避免再次产生缺失物品身份的文件。
- 导入前验证全部账号的物品、池类型、ID、时间和时区。没有可识别物品信息时拒绝导入，不把未知记录静默当三星；未知新物品若带有效名称、类型及星级，仍可导入。
- 完整文件重新导入可修复同一账号内已存在但缺失信息的记录；正常重复记录仍幂等。导入报告区分新增、修复和跳过。

旧数据库增加 `timezone` 列时，按旧版约定迁移：非空物品 ID 的导入记录为 UTC+0，空物品 ID 的国服接口记录为 UTC+8。此约定只用于首次旧表迁移；之后按独立时区列解释时间，补齐 ID 不改变原始时间或时区。旧数据来源本身存在歧义时无法仅凭 ID 判断；完整文件重导可更新无法识别的缺损记录的时区。

重复导入按实际写入结果报告新增、修复和跳过。已能完整识别的 ID-only 记录保持幂等，导出产生的规范名称等派生字段不会被反写为新的来源快照；缺损记录只补空缺，已有身份冲突则跳过并记录警告。

旧版导出可能将 `item_id` 写为空，并省略名称和星级。这些信息已经不在文件里，无法可靠推断具体角色/武器。需要在仍保有完整记录的电脑端使用修复后的版本重新导出，再在手机端导入；不需要先删除手机存档。不要根据祈愿 ID 猜测抽出的物品。

统计按统一时区的时间排序，同秒按 ID 排序；未知星级单独计数。存在未知物品或异常保底区间时，页面显示待核对提示，不显示可靠的保底剩余数。手机总览一次显示一个卡池，五星记录随页面滚动，展示名称、抽数、日期；桌面保留多池并列。

## 与 Snap Hutao Remastered 的字段对照

参考版本固定为 [`3b7475ed`](https://github.com/SnapHutaoRemasteringProject/Snap.Hutao.Remastered/tree/3b7475ed3eca4aedf9cb81d94741bfbe6fa189f5)。

| 字段 | 参考项目 | OpenHoyo |
| --- | --- | --- |
| `id` | 祈愿记录 ID，数据库使用 `long`，文件写字符串 | 数据库使用 `i64`，文件写字符串；与物品 ID 分开保存 |
| `item_id` | 获取记录时按名称和类型反查元数据并保存；导入要求非零 ID | 获取/导入入库时优先保存原始有效 ID，否则唯一反查并保存；旧空 ID 可补齐，绝不根据记录 ID 猜测 |
| `name` / `item_type` / `rank_type` | 主要由物品 ID 对应的元数据在导出时填写 | 数据库保留来源快照；显示、统计和导出共用规范解析结果，未知 ID 由来源字段兜底 |
| `gacha_type` / `uigf_gacha_type` | 原始池类型 / 保底分组，400 归并为 301 | 同样保留 400，并用 301 统计共享保底 |
| `time` / `timezone` | 导入时构造带偏移的 `DateTimeOffset`，导出按 UID 所属区服转换 | 分别保存当地时间和偏移；导出、统计和所有历史日期统一到 UTC+8，表示同一时刻 |
| `count` | 导出固定为字符串 `"1"` | 同样固定为字符串 `"1"` |

相关源码：[获取时反查物品 ID](https://github.com/SnapHutaoRemasteringProject/Snap.Hutao.Remastered/blob/3b7475ed3eca4aedf9cb81d94741bfbe6fa189f5/src/Snap.Hutao.Remastered/Snap.Hutao.Remastered/Service/GachaLog/GachaLogFetchContext.cs)、[导入存储模型](https://github.com/SnapHutaoRemasteringProject/Snap.Hutao.Remastered/blob/3b7475ed3eca4aedf9cb81d94741bfbe6fa189f5/src/Snap.Hutao.Remastered/Snap.Hutao.Remastered/Model/Entity/GachaItem.cs)、[导出元数据填写](https://github.com/SnapHutaoRemasteringProject/Snap.Hutao.Remastered/blob/3b7475ed3eca4aedf9cb81d94741bfbe6fa189f5/src/Snap.Hutao.Remastered/Snap.Hutao.Remastered/Service/UIGF/AbstractUIGF40ExportService.cs)。

名称的来源快照保持原文，在拼接 HTML 文本或属性时统一转义 `&<>"'`。未知新物品若有有效 ID 及完整来源字段，仍可无损往返，无需删掉名称中的特殊字符。

后端回归覆盖获取后即入库 ID、同名消歧、来源冲突保留、未知物品保存与兜底、旧空 ID 补齐、UIGF 各版本及多时区往返、损坏记录重导修复、旧库重复迁移、损坏文件写库前拒绝、混合批次 ID 的统计顺序。真实文件不提交到仓库；可用 `UIGF_SAMPLE` 指定外部文件运行相应 ignored 测试。
