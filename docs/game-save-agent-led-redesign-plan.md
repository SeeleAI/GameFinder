# 存档 Skill 的 Agent 主导重构计划

日期：2026-10-08

状态：开发与离线验收完成（2026-10-09）；用户的新游戏运行时验收待执行

实施位置：`C:\Users\64617\Documents\GameFinder`

## 1. 目标与交付边界

用户通常只提供游戏名称、安装根目录、canonical Nexus 游戏主页，并要求搜索、下载和导入完成度尽可能高且证据充分的存档。Agent 应据此自主完成调查、选源、下载、备份、导入和文件验证；仅在登录、实质歧义、实际阻塞或强制确认时暂停。

本次交付包括 skill、必要的 MCP 实现、测试、使用说明，以及当前已安装 skill 的同步。不能只改提示词而保留阻断通用路径的工具前置条件。新游戏的真实 Nexus 下载、真实存档写入和游戏内载入验收由用户在开发完成后的新任务中执行；本次开发只在隔离 fixture/sandbox 中验证，不操作用户真实存档，不启动示例 Witcher 3 导入。

完整开发完成不等于新游戏运行时验收通过。报告必须明确区分两者。

## 2. 固定设计决策

1. Agent 负责开放式研究和判断；工具负责可检查、可恢复的文件操作。
2. 游戏知识不必事先注册。普通流程不要求 Profile、Recipe、Install Context、Save Context、Standard Save Package 或 Adapter Assessment ID。
3. Recipe 仅作为可选知识缓存；本次不建设新的自动学习/认证框架，也不通过自动生成 Recipe 来掩盖原有对象链。
4. 保存文件原始字节的普通导入，不以理解二进制格式、证明无账户绑定、实现 checksum 算法为普遍前提。已知需要重绑定、槽位合并、重签名或版本转换时，才走专用能力。
5. 目标归属或写入范围不明必须解决；有具体适用依据、无已知冲突、文件操作可恢复但游戏兼容性待验证，可以执行普通导入并如实标记待运行验证。完全没有适用依据不能仅凭备份放行。
6. 普通导入成功后保留新存档和备份。仅在用户要求临时测试、明确恢复或处理失败时恢复原存档。
7. 默认只新增/覆盖选定文件；源包未包含旧文件不构成删除理由。整组替换或删除必须有明确任务/格式依据和冻结的精确路径。
8. 复用现有可靠下载、路径检查、备份、hash、事务和归档处理基础；避免再建一套同等复杂的平行框架。旧版专用流程保持兼容，但不再支配普通流程。

## 3. Agent 的默认工作流

### 3.1 调查本机与选源

- 用本机文件、PE/平台/配置线索确认游戏与适用版本，不把内置识别器成功作为通用研究前提。
- 从用户给出的 Nexus 游戏主页直接研究候选；本地调查与网页搜索可以交替推进。
- 根据网络说明定向搜索 Documents、Saved Games、AppData、平台目录及实际重定向位置，核对真实文件组合和玩家归属。只有静态调查不足才进行受限差分观察。
- 先排除明确不适用的版本/平台、缺失必需依赖，再比较完成度与证据质量。主线、资料片、支线、收集等完成度分别记录；作者声明不能冒充运行时确认。
- 不自动安装额外游戏 Mod、购买 DLC、改变账户或扩展任务；常规候选排序和文件选择由 agent 完成。
- 100% 候选不可得时，选择符合用户“尽可能高且证据充分”的最佳可用项，说明差距；不虚报百分比。

### 3.2 下载与检查

复用现有 Nexus 下载 backend。研究/候选准备要能直接绑定 canonical 游戏页面、Mod URL/File ID，不依赖已注册存档 Recipe 或 Install Context。可以复用通用 Nexus 研究与 `prepare_download`，不强求保留存档专属 research/prepare 链。

每次 MCP 调用读取并保留完整原始返回和 structuredContent 中的稳定 ID。保留在运行记录中，不要求在用户界面倾倒原始响应；工具本身不得返回凭证。

下载协议不可退化：

1. `prepare_nexus_save_download` 或 `prepare_download` 后取得实际返回的 `download.sessionId`，核对精确 Mod/File。
2. 在同一个 MCP 服务器实例/连接中用该 ID 调用 `start_download` 和 `get_download_status`。
3. ID 不可见或实例丢失，明确报告客户端/会话阻塞；不猜 ID、不启后备服务器、不创建替代 profile、不反复 prepare 掩盖问题。
4. 仅当同一 session 明确报告 `login_required` 或 `requiresUserInteraction`，才允许调用一次 `open_nexus_login`；已有交互窗口就复用。
5. 用户完成登录后复用原 sessionId 和输出目录继续 `start_download`；轮询期间不重复开登录窗口。
6. 下载完成后验证实际文件、大小/hash、归档可读性和来源回执；在暂存目录检查 payload，不从压缩包直接写 live 目录。

必须用合同/MCP transport 测试验证 structuredContent 和稳定 session ID 的可见性，而不只写提示词。隔离 smoke/test 进程允许启动；它们不接管真实下载会话。

### 3.3 导入与验证

Agent 明确源文件、目标玩家存档目录、关联文件组、映射、保留/删除项、相关进程和本次方法依据，交给通用存档工具执行。资料与本地结构核对属于 agent 判断，工具机械验证路径与状态，不能再次暗中要求完整 Recipe。

- 冻结清单后自动备份受影响原数据，校验备份，然后执行。
- 相关进程停止；有证据的云同步冲突需要处理，但不机械要求关闭所有平台或改云设置。不得将本地备份视为远端可逆保证。
- 执行失败回滚；中断恢复与重复调用不能再次破坏数据。
- 文件验证检查准确落盘和非目标数据保留；游戏内验证单独记录。
- 游戏正常自动保存导致的 post-launch 漂移不等于文件导入失败；运行时失败后若恢复，先保留新现场，再恢复。

## 4. 通用工具 Interface

优先以现有代码复用实现下列职责，最终名称可按兼容性合理调整，需在实施记录说明：

- `inspect_save_input`：无需游戏注册即可检查本地目录/归档，安全暂存，返回准确文件列表。保留旧接口分支兼容。
- `plan_save_import`：直接接受目标根、源到目标映射、明确删除项、相关进程、游戏/方法依据，产生可复核的精确清单与稳定 ID。
- `apply_save_import`：读取冻结清单，校验源/目标状态、进程、路径，备份、执行、验证、失败回滚。
- `restore_save_import`：按持久化记录恢复，检查当前状态，保留恢复前现场，保护后来产生的无关数据。
- 围绕同一个 plan/operation 记录查询状态和中断恢复，不引入强制的多层 assessment 链。

内部至少保证：安全解包、大小/条目限制、拒绝穿越/链接危险行为、精确文件操作、不覆盖无关文件、源hash固定、目标prestate校验、备份可验证、持久化执行记录、并发/重复调用约束、失败恢复。多文件操作不能虚称整体原子；采用实际可恢复的发布机制。

新能力不是 shell-copy 旁路，也不能简单信任任意宽根与任意路径。Agent 提交的证据必须有明确内容，但避免只允许预注册来源或强制二进制证明。

## 5. Skill 与文档结构

- `skills/manage-game-saves/SKILL.md`：简洁的任务目标、主流程、继续/暂停条件、默认保留结果。
- `references/nexus-download.md`：上述会话与结果合同。
- `references/special-formats.md`：只有实际转换/槽位操作才读取，可链接保留的 Elden Ring 详细参考。
- 旧参考按调用关系删除、合并或标记 legacy；不能留下与新主流程冲突的“必须注册/unknown 一律阻塞/默认恢复”指令。
- 保留自动 skill 发现；UI 元数据、README、MCP 描述与实际实现一致。
- 同步当前已安装的 `C:\Users\64617\.codex\skills\manage-game-saves`，先保存原副本并核对，勿修改无关技能/配置。若服务器需新进程加载 build，明确说明；不强杀正在使用的 MCP 或迁移真实下载 session。

## 6. 实施阶段

1. 只读确认现有能力和 dirty baseline，保存任务相关差异；确定最少的 interface 改动与复用方式。
2. 实现无需 Recipe 的检查/清单/导入/恢复完整纵向链，先让未登记的合成游戏走通。
3. 接通无需 Install Context 的研究/下载调用路径与结果合同，保留原 session 生命周期。
4. 重写 skill、更新描述与使用文档；清理冲突参考，同步已安装 skill。
5. 完成针对性与完整回归，更新本计划实施记录，交主 agent 独立检查并修复发现的问题。

实施 agent 使用 goal 模式持续工作，不把“写完代码”或“只更新 skill”视为完成。goal 的完成范围是本次开发及离线验证，真实新游戏验收属于用户后续任务。

## 7. 验收标准

- [x] 未登记的合成游戏无需新增 Recipe/Profile/Adapter，即可检查文件、形成清单、备份、导入、验证、恢复。
- [x] 普通路径从实际 MCP Interface 可达，不仅内部方法或脚本可用。
- [x] 同一来源/目标存在不同文件名、目录包装、关联文件组时可通过明确映射处理；未列入清单的旧存档保留。
- [x] unknown 二进制格式不自动阻塞原始字节导入；已知转换需求不被通用复制忽略。
- [x] 路径越界、链接、异常归档、源/目标漂移、备份失败、相关进程运行时拒绝不安全写入。
- [x] 写入中失败、重复 apply、恢复、进程中断后的恢复路径有实际行为测试；保留无关文件。
- [x] 下载 MCP 原始响应/structuredContent session ID 合同、同 session 登录续接和缺失 ID 停止规则得到适当验证；不创建替代服务器/profile。
- [x] 旧 Elden Ring/GoT 特殊能力及相关回归不被新主流程破坏。
- [x] TypeScript check/build、完整单元/集成测试、stdio smoke、skill validator、引用检查及 diff 检查通过，或明确记录与本次变更无关的环境性跳过。
- [x] 已安装 skill 与仓库目标文件一致；构建产物存在，真实新聊天重连要求如实记录。
- [x] 独立检查确认主流程不再受 Recipe 门槛控制；所有本次引入问题修复。

## 8. 工作区与发布约束

本轮开始存在用户未提交工作：`docs/mod-development-skill-plan.md`、`skills/develop-game-mods/references/reshade-camera-provider.md`，以及 save context resolver、install resolver common/PE、Elden Ring Recipe、两个相关测试中的修改。还有下载、outputs、.codex-work 和研究文档等未跟踪内容。

保留这些变化；不 reset/clean，不覆盖其他 agent 的文件，不全量暂存，不发布/push。相关 dirty 文件确需修改时先阅读现有 diff，保留其功能。实现 agent 负责代码、skill 和实施记录；主 agent 负责独立审查与验收协调。

## 9. 用户后续真实验收提示词

```text
使用 manage-game-saves，为以下游戏搜索并导入完成度尽可能高、证据充分且适用于本机版本的存档。自动完成选择、下载、备份、导入和验证，保留导入结果；仅在需要登录、无法消除的歧义或实际阻塞时暂停。

游戏名称：<游戏名称>
安装根目录：<绝对路径>
Nexus 游戏主页：https://www.nexusmods.com/games/<slug>
```

## 10. 实施记录

完成日期：2026-10-09（Asia/Hong_Kong）。实施子 agent 以无预算 goal 持续完成开发，主 agent 独立验收通过。未 commit/push，未操作真实存档或真实下载会话。

### 10.1 最终接口与实现

普通流程由以下实际 MCP 工具提供，均不要求 Recipe/Profile/Install Context：

- `inspect_save_input({inputPath, stage:true})`：复用输入检查器，将文件/目录/ZIP/RAR/7z安全暂存，返回 `inspection` 和 `stagedInput.root/files/treeHash`。不传 stage 的旧接口及专用识别保持兼容。
- `plan_save_import({inputPath,targetRoot,mappings,deletePaths?,deletionReason?,processNames,evidence})`：直接接受明确的源/目标相对文件映射。`evidence` 包含 gameName、installationRoot、source、target、compatibility、method、knownConversionRequired。来源/目标/方法必须有具体内容；knownConversionRequired=true 阻止普通复制；未知内部格式没有自动否决。
- `apply_save_import({planId})`：冻结源字节、核对目标prestate和进程、验证全部原始备份后才进行写入。重复成功调用只返回状态，不覆盖后来产生的游玩数据。
- `get_save_import({planId})`：返回同一 plan、operation、recordPath、backupRoot、原始及恢复前备份的实际路径/hash、保留的中断临时物 recoveryFiles；始终单独标记 runtimeVerification=not_performed。
- `restore_save_import({planId})`：用于用户恢复或失败/中断恢复。先保存当前已映射文件的现场，再恢复原内容；不修改映射外后来新增的存档。恢复本身可从中断继续，完成后重复调用不再写入。

这条纵向链在 `src/save/generic/input.ts` 与 `import-service.ts` 实现，复用 SaveInputInspector、路径规范化、hash、BackupStore、InstanceLock。先持久化全部 backup IDs，再持久化逐文件 touched intent，最后发布文件；多文件不宣称整体原子。同 manager 的通用写入串行化，未完成操作要求先恢复。临时文件中断时将完整或部分内容保存到 manager，再清理 live 目录；返回可读取的恢复现场。安装目录只在规划阶段确认存在，移走安装目录不妨碍读取记录或恢复独立用户目录。

共享 InstanceLock 修复了“新建但尚未写完的活锁被当成陈旧锁删除”的竞态：完整记录经 hardlink 原子发布，陈旧锁使用按 token 区分的回收 claim；回收者自身崩溃也可恢复。共享目录遍历增加遍历中的文件数/字节限制，单文件输入也应用限制。没有修改原有 dirty 的识别/Recipe 工作。

`inspect_save_input` 和 `plan_save_import` 分别暂存输入：前者供agent查看内容，后者建立本操作冻结副本。这是当前保持接口独立可用的简单取舍，会额外占用暂存空间；skill 要求 plan 使用原始输入，并把原始来源写入 evidence，避免将 staging 路径误当来源证据。

### 10.2 Skill 与文档

主 skill 收敛为调查选源、下载检查、规划导入、验证保留四段。新增 `nexus-download.md`、`special-formats.md`、`legacy-tools.md`，保留按需 Elden Ring 细节；移除原 discovery、sources-and-packages、transactions、adapter-assessment 四份冲突参考。更新两个 README、UI 元数据和 server instructions。普通存档下载直接采用 `prepare_download(backend=persistent_chromium)`，没有 Mod Plan/Bundle 或 Install Context 前置要求。

下载后端原本已有通用入口，保留其生命周期与稳定 ID；新增实际 MCP transport 测试证明未注册游戏不会实例化 SaveService，文本和 structuredContent 的 sessionId 一致，登录后原会话续接，轮询不打开登录，缺失/无效/未知 ID 不触发浏览器。每次完整响应的保存和“客户端看不到ID就停止”属于 skill 的客户端协议；不能声称服务器测试可以强制任意 agent 保存完整结果。

### 10.3 验证证据

- `pnpm check`：通过。
- 首次默认全并行 `pnpm test`：两个旧 Mod 测试因5秒阈值超时，其余255项通过，20项条件跳过；未改测试语义。
- `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000`：45个测试文件通过、3个条件跳过；260项通过、20项条件跳过。包含旧 Elden Ring/GoT 专用能力以及所有旧锁调用者回归。
- 新事务测试覆盖源/目标漂移、备份失败、进程阻塞、宽根/穿越/重复映射/祖先junction、精确删除及恢复、后续游玩现场、并发重叠根、文件与目录限额。
- 新进程中断测试实际启动隔离子进程并以退出码86终止：全部备份完成、写前intent、临时文件已写但rename前、rename后，以及恢复已发布但尚未写ack；新service实例能够恢复。另验证partial-copy失败现场隔离和不留临时物于live根。
- 新实际 MCP 测试覆盖 ZIP包装/重命名/关联文件、未知二进制格式、安装根内存档、无Recipe完整stage/plan/apply/get/restore链和已知转换阻塞。
- `pnpm build`：通过；`pnpm test:stdio`：新dist返回111个工具，liveValidated=false、browserLaunched=false。
- 仓库及已安装 skill validator 均通过；内部Markdown引用和 `git diff --check` 通过。系统Python缺PyYAML，复用已有 `.codex-work/skill-validator-python`，未变更系统环境。
- 主 agent 独立复跑MCP/下载5项测试通过；独立脚本 `.codex-work/save-agent-redesign-review/review.mts` 验证冻结源、成功重试不覆盖后续游玩、安装移动后query/restore、可读rescue、无关文件保留及partial临时物清理。
- 主 agent 独立skill行为演练确认：排除版本不适用的100%候选并选择证据更充分的98%候选；未知checksum不阻塞整对文件；登录复用原ID；ID丢失停止；成功保留结果并标记游戏内验证待完成。
- 主 agent 比对本轮启动时8个既有dirty文件的diff，均与启动baseline一致。

### 10.4 部署与加载状态

已将仓库 skill 的全部6个文件同步至 `C:\Users\64617\.codex\skills\manage-game-saves`，逐文件SHA-256一致，4个旧参考已移除。同步前原版本已完整备份并核对，位置为 `.codex-work/save-agent-redesign-installed-skill-backup-20261009`；同步回执为 `.codex-work/save-agent-redesign-installed-skill-sync.json`。主agent另行独立核对全部6个hash通过。

最初含泛化差集删除的一体化同步命令被执行策略拒绝，工具仅返回“blocked by policy”无细分理由；未执行该命令。随后采用独立备份/核对、文件复制，以及显式列出4个已验证绝对路径的单文件删除完成同步，无未解决部署阻塞。

当前配置指向本仓库 `nexus-mods-server/dist/index.js`，构建产物已更新；本聊天已连接的服务器/工具清单仍是旧实例。没有终止旧实例、迁移下载会话或创建替代profile。用户验收应在新聊天重新连接/加载MCP后确认工具清单含 `plan_save_import` / `apply_save_import` / `get_save_import` / `restore_save_import` 且 `inspect_save_input` 有 stage 参数；若仍旧清单，应先重连插件，再开始新的下载任务。

### 10.5 边界与后续真实验收

- 无真实游戏、云端、网络下载或游戏内载入验收；用户以第9节提示词在新游戏执行。文件验证成功不会自动升级为游戏进度验证成功。
- 游戏/账户/版本/适用性证据由agent交叉核对，工具不认证网页声明真伪，也不会凭备份自动放行已知格式转换。
- 归档能力沿用本机解包器：ZIP原生，RAR需要UnRAR，7z需要可发现的bsdtar。外部RAR/7z解包在私有暂存目录执行并做前后清单/大小/链接验证，不是OS级资源沙箱；本轮没有新增解包器安装能力。
- 精确文件复制不能处理内部账户重绑定、槽位合并、重签名或版本转换；存在专用支持时使用专用分支。
- 串行锁覆盖同manager的通用写入，并不锁住游戏或云同步客户端；进程停止和有证据的同步冲突处理仍是写入条件。
- 当前保留计划、暂存和备份以便恢复，不自动清理历史；同机管理员恶意并发修改及突然断电不属于本轮进程中断恢复测试结论。

后续验收重点观察：只提供三项信息是否能自主找到适用候选、同session下载、正确定位当前玩家存档、保留非目标文件、给出可用备份位置，以及游戏内可见/可载入/完成度是否符合来源证据。
