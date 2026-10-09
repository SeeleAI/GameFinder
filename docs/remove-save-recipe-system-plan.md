# 彻底移除存档 Recipe 系统

日期：2026-10-09

状态：开发、离线回归和主 agent 独立验收完成（2026-10-09）；真实新游戏验收待用户执行。

基线：`fe7f9482dec3051628adce2a5a80bdf1149e8f65`。本方案接续 agent-led 重构，取代其中“保留 Recipe 为可选运行时知识”的决定。

## 1. 用户结果

用户提供游戏名字、安装根目录、Nexus 游戏主页，Agent 即可研究位置和适用存档、下载、检查、备份、导入和验证。普通文件导入和独立备份均不要求登记游戏。实际格式转换使用专用算法，转换产物仍通过同一通用事务写入。

唯一主流程：研究与定位 → 下载与检查 → 必要的格式转换 → 明确文件操作 → 备份并执行 → 文件验证／运行时验证 → 必要时恢复。

完成意味着删除旧架构的实现和工具依赖，而不只是隐藏工具、停止调用或把 Recipe 改名。

## 2. 保留与删除

| 范围 | 决策 |
| --- | --- |
| 通用输入检查、冻结来源、明确映射、导入与恢复 | 保留并作为唯一活跃文件事务路线 |
| 独立备份 | 接受明确目录、文件范围和相关进程；提供持久记录、哈希验证和可恢复来源 |
| Elden Ring 二进制解析、账号转换、角色槽合并 | 保留算法和不变量；直接使用文件／分析结果，产出经验证的暂存文件 |
| Nexus 通用研究及下载、持久 Chromium、稳定 sessionId | 保持现有协议和能力 |
| Recipe 注册表、内置 JSON、哈希契约、持久化、学习 store | 删除 |
| Recipe 专属安装识别、位置策略注册、布局注册、Context／Package／Assessment／Replacement 对象链 | 删除；仅提取仍实际使用的路径、格式或事务原语 |
| 作为替代门槛的 Save Profile、自动学习、认证与兼容性注册框架 | 同步退役，不能复制出一套改名后的 Recipe |
| 少量有用的游戏知识 | 放在按需阅读的简短参考资料里，无运行时注册或证据授权作用 |
| 历史设计文档 | 保留历史，醒目标注已被本方案取代；当前说明指向新流程 |
| Mod 安装系统的 Profile、Method、Evidence 等 | 不属于此次存档删除范围，保持不变 |

不新增自动生成 Recipe、游戏知识数据库、通用 Adapter 认证或替代的抽象框架。静态定位不足时，可使用明确目录范围的前后文件观察；它不需要识别注册或安装 Context，也不生成知识登记物。

## 3. 工具与实现形状

实施 agent 先记录现有存档工具的去留清单，再落地以下能力。可以合理复用或调整名字，但必须在文档和测试中统一，避免保留功能重复的两套工具。

- `inspect_save_input`：单文件、目录、ZIP／RAR／7z 检查与暂存；去掉 Recipe／Context 参数及推断契约。
- `plan_save_import`、`apply_save_import`、`get_save_import`、`restore_save_import`：继续使用当前可恢复的通用文件事务；保留现有持久计划兼容性。
- 独立备份：直接接受源目录、显式文件范围、相关进程和描述；冻结一致快照、验证哈希、返回稳定记录 ID 和实际备份路径。读取／验证已存备份无需游戏登记。恢复以备份为来源，走通用导入事务并保留恢复前状态。
- 特殊格式：分析明确源／目标文件，选择角色槽，冻结转换参数，校验后生成暂存产物。禁止仅改成临时制造 Context 或 Package 再调用旧链。
- 历史备份恢复：一个按需使用的读取／导出或迁移入口，把历史记录转换成明确文件清单和可检查的来源，随后由通用事务处理。

Agent 负责位置和版本的证据判断；工具负责明确路径范围、源／目标状态、哈希、写入日志、备份、恢复和真实格式不变量。不要用形式上的证据文本检查替代真实格式验证，也不要用未知二进制格式阻断有依据的整文件导入。

## 4. 历史数据兼容

删除源码不能删除用户存档、已有 backup blobs、operation records、manager 数据或下载内容。

- 新通用导入的既有 planId 和记录继续可读、可恢复。
- 对旧 V1／V2 备份、恢复／替换操作及中断记录，明确列出识别和恢复策略。使用版本化的最小历史记录读取代码即可；不加载 Recipe 注册表，不继续创造旧流程对象。
- 优先利用历史记录中冻结的路径、文件清单和哈希；缺少可靠范围时返回具体缺项，不猜路径或删除项。
- 恢复前验证备份真实文件、完整性、路径边界，并备份当前状态。损坏记录、穿越路径、重解析点、缺失 blobs 不得落地写入。
- 若旧操作有新增／删除路径，需要从操作记录恢复相应范围；不能把全量恢复悄悄变成覆盖拷贝。无完整操作上下文的独立旧备份默认只恢复明确列出的文件，额外删除必须显式提供依据。
- 历史 schema 中为读取旧文件而保留的 `recipeId` 等字段只允许出现在隔离的兼容代码及测试中，不能成为运行依赖。旧不可续执行的计划必须明确失效并引导从已有证据形成新计划。

不要为了所有旧工具名字继续可调用而保留整个 SaveService；允许破坏旧的研究／计划接口，提供简明升级说明。历史数据可恢复是要求，旧编排协议永远不变不是要求。

## 5. 必须保持的行为

1. 未登记游戏、未知二进制、安装根内存档、文件改名、关联文件和多存档候选都能按证据操作。
2. 默认只新增／覆盖映射文件，保留无关文件；明确的整组替换可以删除指定旧文件，并可完整恢复。
3. 冻结来源、目标前态检查、相关进程检查、写前日志、已验证备份、故障恢复、幂等重试和后续游玩内容保护继续有效。
4. 路径穿越、链接逃逸、归档炸弹、源文件变化、磁盘／部分写入故障仍受防护。
5. Elden Ring 的签名、长度、槽位、账号和校验和验证，以及未选择槽字节保持等实际约束不能随着旧链一起删除。覆盖已占用槽仍需要明确选择和对应授权。
6. 转换暂存与写入之间若目标内容变化，必须阻止过期转换覆盖新进度；通用计划的前态必须与转换所基于的目标一致。
7. 下载完整原始结果和 structuredContent 中稳定 ID 的保留、同一 server instance/session 的 start/status/login 恢复、登录窗口只按实际需要打开等行为不变。
8. 文件校验成功和真实游戏加载成功分别报告；默认保留成功导入和备份。

## 6. 开发顺序

1. 在干净 worktree 从基线开始；记录工具／模块依赖、历史数据形状和测试能力清单。
2. 从旧实现提取独立输入检查、必要格式代码与历史恢复读取；补齐直接文件备份和转换入口。
3. 把活跃入口全部接到通用事务；移除旧服务、Recipe／Profile／Context／Package 等已经失去调用者的实现、导出、错误码、构建复制步骤和工具注册。
4. 迁移测试到新公开入口。保留实际行为的测试覆盖；删除只验证退役注册／对象结构的测试，同时在验收记录解释被删覆盖的去向。
5. 精简 skill 和 README，移除日常流程中的旧概念、legacy-tools 引导；仅保留历史恢复和实际特殊格式的按需参考。更新 smoke 工具清单和日常提示词。
6. 全套验证，检查依赖删除完整性；由主 agent 独立验收，完成后再记录开发结果。

## 7. 验收标准

- [x] 活跃源码／工具参数／技能流程中不存在 Recipe／Save Profile 注册、生成、匹配、安装 Context 门槛或等价替代物；剩余历史字段有明确隔离理由。
- [x] 构建产物不再复制或依赖旧 Recipe 资源；从干净输出构建及 STDIO 启动成功。检查旧 dist 残留的处理方式。
- [x] 陌生游戏通过实际 MCP 入口完成检查、计划、导入、状态读取、恢复；独立备份及恢复同样无登记要求。
- [x] 精确替换、未映射文件保留、冲突、并发、部分写入和进程中断、重试保护、源变动等回归通过。
- [x] 专用转换 → 暂存校验 → 通用导入可走通，目标改变会被拒绝，未选择角色不变；失败转换不写入真实目标。
- [x] 合成的历史 V1／V2 备份和操作记录可校验和恢复；包含旧新文件集合不一致、中断操作、恶意／损坏记录的例子。
- [x] Nexus 下载会话契约与 Mod 工作流回归通过；没有误删 Mod Profile／Method 能力。
- [x] 类型检查、构建、适当单元／集成测试、STDIO smoke、skill 结构检查通过；必要时限制测试并发，并如实说明跳过的浏览器／真实游戏测试。
- [x] 独立 skill 行为检查覆盖新游戏、独立备份、历史恢复、特殊格式四类请求；正文只含真正改变决策的约束。
- [x] 提供工具数量前后变化、删除／保留模块摘要、历史数据恢复说明和用户可复制的简短验收提示词。

离线开发不下载真实存档、不写入用户游戏目录、不启动实际游戏或登录浏览器。真实新游戏验收由用户随后执行。

## 8. 工作区与交付

主目录已有未提交修改，包含本次预计删除的旧定位／Recipe 文件。使用从上述已提交基线创建的独立 worktree；主目录原有改动和未跟踪内容保持原样。不要强行合并回存在重叠修改的目录。

实施 agent 在指定 worktree 完整开发，自主修复验证失败，持续工作到验收条件满足。使用之前用户要求的 goal 工作方式；若工具的 goal 状态受父会话限制，则向主 agent 如实报告，不把无法启用该状态当作停止开发的原因。

本轮不自动推送或覆盖主目录未提交修改；完成后交付可审查改动、明确 worktree／分支路径和验证结果。已安装 skill 与 MCP 服务必须在部署新版时一起切换，并保留旧版副本；本轮不单独覆盖已安装 skill，以免其工具调用与主目录旧服务不匹配。旧 MCP 进程继续保持原状，用户重新连接后才加载新工具。

## 9. 日常验收提示词

```text
为下面的游戏搜索并导入完成度尽可能高且证据充分的存档，完成下载、备份、导入和验证，保留导入结果及备份。需登录时打开专用 Chromium 供我操作，仅在确实受阻或存在需要我决定的重要选择时暂停。分别报告文件验证和游戏内验证结果。

游戏名称：
游戏安装根目录：
Nexus Mods 游戏主页：
```

会话 ID 和底层工具协议由 skill 承担，用户日常提示词不再重复这些实现细节。

## 10. 实施结果与范围

实施工作树：`C:\Users\64617\.codex\worktrees\remove-save-recipes\GameFinder`，分支 `codex/remove-save-recipes`。从已提交基线开发，未提交、未推送、未合并主目录。用户主目录的重叠未提交修改、下载与游戏文件保持原状。

存档运行代码收敛为 11 个 TypeScript 文件：通用检查/暂存/事务/备份、两个实际格式算法、一个历史读取器，以及必要路径/JSON/manager-root 原语。删除整个 Recipe、Save Profile、Resolver、Location Strategy、Layout Family、Context、Package、Assessment、Replacement、学习存储、SaveService 和旧 acceptance 脚本。旧输入检查不再推断预定义游戏 payload，也不再创建可继续编排的持久 inspection 对象。Mod 安装的 Profile/Method/Evidence 未改变。

工具总数 **111 → 62**；存档相关 **61 → 12**，其他 50 个工具保留：

| 类别 | 当前工具 |
| --- | --- |
| 通用文件事务（保留 5 个） | `inspect_save_input`, `plan_save_import`, `apply_save_import`, `get_save_import`, `restore_save_import` |
| 独立备份（重写同名 create，新增 2 个） | `create_save_backup`, `get_save_backup`, `prepare_save_backup_restore` |
| 历史恢复（新增 1 个） | `prepare_legacy_save_recovery` |
| Elden Ring 直接文件操作（新增 3 个） | `analyze_elden_ring_save`, `prepare_elden_ring_import`, `get_elden_ring_preparation` |

研究与下载统一使用原有通用 Nexus 工具；退役专用 Save Source/Candidate/Snapshot/Receipt 链和其 Speedrun 包装接口，网页证据仍由 Agent 研究。`prepare_download` 的稳定 sessionId、同实例恢复和 Chromium 登录条件保持不变。

Elden Ring `preparationId` 持久收据绑定源/目标分析哈希、暂存结果、精确目标映射和选择授权；普通计划不能省略收据直接消费转换暂存。规划验证转换所依据的目标前态，执行再次验证冻结前态。转换与通用写入因此没有“重新拍快照后接受过期转换”的窗口。GOT PC v49 的纯格式解析与原测试保留，不再用适配器注册表授权普通整文件导入。

独立恢复允许省略已不存在的 `evidence.installationRoot`；不要求填写虚假安装路径。普通三信息请求仍记录用户提供的安装证据。明确历史原本不存在的文件支持 `mappings: []` 的纯删除恢复计划，仍要求删除理由并保留恢复前状态。

## 11. 历史数据策略

不迁移或删除用户的原 manager 数据。新通用导入继续读取原 schemaVersion 1 的计划/记录，新增可选 preparationId 不改变旧记录 hash。

| 历史数据 | 处理 |
| --- | --- |
| 通用 import plans/records | 原 planId 的 get/apply 幂等/restore 继续有效；后续游玩内容先做救援备份 |
| V1 及旧 V2 backup | V2 实际通过 V1 bridge 写入同一 schemaVersion 1。读取 `backups/records`、CAS references/objects 和文件树哈希，导出已验证文件；不推断额外删除 |
| committed restore/replacement operation | 校验 `records` → `transactions/records` → frozen restore/replacement plan 的关联与 hash；使用 rescueBackupId 恢复前态，原本 absent 的路径明确列入 deletePaths |
| finalized recovery-required transaction | 仅处理当前不同于 prestate 且可由 pre/poststate 确认的路径；未知并发字节阻塞，不猜 touched 集合 |
| rolled-back/failed transaction | 不重放旧事务；若需要可独立选择已验证历史 backup 的明确文件 |
| 仅 journal 的硬中断 | 旧日志只有阶段字符串，可能没有最终 transaction/rescue ID。明确报告缺失项；不声称能续执行，不猜备份或删除范围 |
| 损坏、缺 blob、路径穿越或 junction | 拒绝导出/写入；保留原始记录供调查 |

兼容读取只解析恢复所需字段，并对完整历史原文验证 hash；旧 profile/context/recipe 等剩余数据在 `legacy` 读取边界透传参与完整性校验，不构成注册或运行依赖。历史导出加入当前进程和任务证据后仍走通用 plan/apply，恢复也能撤回。

## 12. 测试迁移与验收记录

| 原覆盖 | 当前去向 |
| --- | --- |
| m0 contracts、m1 context、V2 registry/install resolver 的对象形状/注册测试 | 随已删除协议退役；相对路径、junction、宽范围及 hash 保护在实际输入/事务/历史入口验证 |
| m2 backup/restore | `save-direct-backup` 与 `save-legacy-recovery`，含一致快照、校验、进程、损坏对象、恢复前救援和实际 MCP 往返 |
| m3 package/replacement、V2 layout/transactions | 通用 import 与 MCP 回归，含未知二进制、路径改名、关联文件、精确删除、无关文件保留、并发、部分写入、磁盘/备份失败、真实进程中断和恢复重试 |
| RAR/7z/ZIP 检查 | `save-input-inspection` 保留归档清单安全和 RAR 实际暂存；通用 MCP ZIP 实际输入与原 archive inspector 回归保持 |
| m4 专有 source 包装 | 专用 source/snapshot 协议退役；现有普通 Nexus 研究/下载及 `save-generic-download-mcp` 验证稳定 session、登录后原会话恢复、缺失/未知 ID 拒绝 |
| m5 Elden Ring adapter | `save-direct-formats`，含签名/长度/账号/槽/校验和、未选槽不变、占用授权、收据/暂存篡改、目标漂移和真实 MCP 全流程 |
| GOT 分析 | 原 `save-g7-ghost-of-tsushima-adapter` 重定向纯格式模块，保留测试 |

- 类型检查、清理 dist 后构建通过；dist 无退役 Recipe/Context/Package 模块或资源。
- 全量回归：**37 test files passed，3 skipped；226 tests passed，20 skipped**。随后恢复无安装目录、输入原语清理及归档测试补充的定向回归：**3 files / 24 tests passed**（包含新增 2 个归档行为测试）。没有把两次运行相加冒充一次全量计数。
- STDIO：**62 tools，browserLaunched=false，liveValidated=false**。第一次 smoke 继承现有 API key 环境，发生只读 credential/get_mod 检查并返回 liveValidated=true；没有下载、登录或写游戏文件。清除子进程 API key 后重跑确认离线路径。
- skill 官方结构 validator、引用目标检查、git diff whitespace 检查通过。
- 主 agent 用真正旧版服务创建的记录独立验证：旧通用计划读取/幂等/后续游玩救援/恢复；旧 V2 整组替换救援恢复旧文件、删除新增文件、保留无关内容，并可再撤销这次恢复。
- 独立 skill 行为验收：新游戏（适用98%优于不适用100%）、独立备份、历史恢复、特殊格式四类通过，包含同 session 登录、缺 ID 阻塞、缺 rescue 阻塞与转换漂移重新准备。
- 跳过真实浏览器/真实游戏的集成场景；文件验证不等于游戏可加载。用户新游戏测试仍待执行。

当前聊天的 MCP 配置仍指向主目录旧 dist。本次隔离工作树不自动生效，也没有单独同步已安装 skill；部署时一起构建新版、更新 skill 并重新连接 MCP。不要替换仍承载下载会话的活动实例。

### 已移除的 55 个旧工具名

`analyze_elden_ring_package`, `analyze_elden_ring_save_context`, `analyze_elden_ring_save_path`, `apply_save_replacement`, `apply_save_restore`, `assess_save_adapter_requirement`, `assess_save_package_compatibility`, `begin_save_location_probe`, `complete_save_location_probe`, `download_speedrun_save`, `get_elden_ring_save_analysis`, `get_elden_ring_slot_import_plan`, `get_game_save_recipe`, `get_save_adapter_development_brief`, `get_save_adapter_requirement_assessment`, `get_save_compatibility_assessment`, `get_save_context`, `get_save_game_install_context`, `get_save_input_inspection`, `get_save_replacement_plan`, `get_save_restore_plan`, `get_save_runtime_verification`, `get_save_source_candidate`, `get_save_source_snapshot`, `inspect_downloaded_save`, `inspect_save_backup`, `inspect_standard_save_package`, `list_game_save_profiles`, `list_game_save_recipes`, `list_save_backups`, `list_save_distribution_resolvers`, `list_save_layout_families`, `list_save_location_strategies`, `normalize_downloaded_save_package`, `normalize_save_package`, `plan_elden_ring_slot_import`, `plan_elden_ring_staged_replacement`, `plan_save_replacement`, `plan_save_restore`, `prepare_nexus_save_download`, `probe_save_game_install`, `record_manual_save_download`, `record_nexus_save_download`, `record_save_runtime_verification`, `record_speedrun_save_page_snapshot`, `research_nexus_save_sources`, `research_speedrun_save_sources`, `resolve_save_locations`, `stage_elden_ring_slot_import`, `verify_elden_ring_staged_import`, `verify_save_backup`, `verify_save_download_receipt`, `verify_save_replacement`, `verify_save_restore`, `verify_standard_save_package`.
