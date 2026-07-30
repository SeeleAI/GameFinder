# Phase 6B V2：Agentic Mod 安装与本地经验学习架构

> 状态：架构基线已固定；M1–M3 已实现并通过本地回归，M4 实现与真实验收进行中
>
> 固定日期：2026-07-27
>
> 目标仓库：`GameFinder`
>
> 目标组件：`install-game-mods` Skill、`nexus-mods-server` 安装模块
>
> 替代范围：V1 的 Adapter 中心规划层、静态 Game Profile 门槛、未知包阻塞策略
>
> 保留范围：V1 的校验、staging、路径策略、冻结计划、事务、备份、回滚、记录与卸载基础
> 首个真实验收：Stardew Valley Mod 2697 及其必需依赖 SMAPI 2400

## 目录

1. 架构决策
2. 问题与目标
3. 系统边界和总体流程
4. V2 对象模型
5. Method Store
6. Agentic Installation Planner
7. Dynamic Game Context
8. 通用操作中间表示
9. Contract V2
10. MCP 工具边界
11. `install-game-mods` Skill V2 工作流
12. 依赖、验证与卸载
13. V1 迁移方案
14. 测试与验收
15. 实施里程碑

## 1. 架构决策

以下决策在开始 V2 重构前固定：

1. **未知 Mod 不以缺少预编写 Adapter 为默认阻塞理由。**
2. **Agent 负责根据证据推导候选安装方法，MCP 负责验证、冻结和执行受约束操作。**
3. **Adapter 不再是安装规划的必经入口。** 内置 Adapter 可以继续存在，但只作为高置信 Method Provider 或专用验证器。
4. **Game Profile 不再是识别未知游戏实例的硬前提。** 系统可以生成本次会话使用的 Dynamic Game Context。
5. **安装成功后沉淀结构化 Installation Method。** 经验存入 MCP 管理的本地状态库，不自动修改 Skill、仓库代码或内置 Profile。
6. **不恢复旧 Recipe。** Installation Method、Install Plan 和 Installation Record 必须继续保持职责分离。
7. **学习不能扩大执行权限。** Learned Method 只能组合通用引擎已经支持的操作，不能创建任意命令或绕过路径策略。
8. **真正需要开发代码的单位是通用执行能力，而不是某个 Mod。** 只有遇到现有 Operation Catalog 无法表达的新副作用语义时，才扩展引擎。
9. **所有必需依赖使用同一套方法发现和安装流程。** Loader、框架和前置 Mod 不能因为类型不同而被默认交还给用户手动处理。
10. **显式 `$install-game-mods` 调用仍是生产入口。** 自动触发不是硬验收要求。

这里的“自学习”指本机上的结构化经验积累，不指训练或修改语言模型权重。

## 2. 问题与目标

### 2.1 V1 的根本问题

V1 把两类不同问题绑定在一起：

- **理解问题**：这个 Archive 是什么、作者要求如何安装、目标位置在哪里、如何验证。
- **执行问题**：哪些文件可以写入、如何备份、如何回滚、如何留下可卸载记录。

V1 要求理解问题必须由预注册 Adapter 和 Game Profile 解决。结果是：

```text
未知包
  → ADAPTER_NOT_FOUND
  → 等待开发新 Adapter
  → 才能生成 Install Plan
```

该流程适合封闭、预配置的企业部署系统，不适合需要覆盖大量游戏和未知 Mod 的个人 Agent 工具。

### 2.2 V2 目标

- 首次遇到未知 Mod、Loader 或前置组件时，主动收集证据并尝试推导安装方法。
- 把 Agent 的推理转换成结构化、可审阅的候选方案。
- 在不要求编写代码的情况下，用通用操作完成大多数文件型和标准安装器型 Mod。
- 成功后保存可复用经验；后续任务优先检索和验证该经验。
- 继续保证安装计划可冻结、写入可事务化、结果可验证、失败可恢复。
- 保留足以支持更新、修复、卸载和状态协调的 Installation Record。
- 让一个新通用操作解锁一类安装机制，而不是创建一个单 Mod Adapter。

### 2.3 非目标

V2 不承诺无条件静默安装任何程序。以下情况仍可能要求额外批准或人工检查：

- 证据互相冲突，无法确定作者意图。
- 安装器的副作用范围无法描述或观察。
- 需要修改操作系统级驱动、服务、账户权限或安全设置。
- 需要购买 DLC、更新游戏、接受第三方许可或登录外部服务。
- 需要用户选择主观配置、兼容分支或互斥组件。
- 当前 Operation Catalog 完全无法表达所需操作。

这些情况返回的是“需要选择、需要批准或暂不支持的能力”，而不是“请先为这个 Mod 开发 Adapter”。

## 3. 系统边界和总体流程

```mermaid
flowchart TD
    A["已验证 Archive 或 Bundle"] --> B["Evidence Collector"]
    C["Nexus 元数据、README、官方说明"] --> B
    D["游戏目录、版本、Loader、现有安装"] --> E["Dynamic Game Context Builder"]
    B --> F["Evidence Pack"]
    E --> G["Game Context"]
    F --> H["Method Resolver"]
    G --> H
    I["Method Store"] --> H
    J["Built-in Method Providers"] --> H
    H -->|高置信匹配| K["Method Binding"]
    H -->|无可用方法| L["Agentic Installation Planner"]
    F --> L
    G --> L
    L --> M["Method Draft + Install Proposal"]
    K --> N["Proposal Validator"]
    M --> N
    N --> O["Frozen Install Plan V2"]
    O --> P["用户审阅和批准"]
    P --> Q["Transaction Engine"]
    Q --> R["Static / Runtime Verification"]
    R --> S["Installation Record"]
    R --> T["Method Outcome"]
    T --> I
    S --> U["Update / Verify / Uninstall"]
```

权限边界：

| 组件 | 可以推理 | 可以生成候选操作 | 可以写游戏目录 |
|---|---:|---:|---:|
| Skill / Agent | 是 | 是 | 否 |
| Evidence Collector | 否 | 否 | 否 |
| Method Store / Resolver | 否 | 是 | 否 |
| Proposal Validator | 否 | 否 | 否 |
| Transaction Engine | 否 | 否 | 是 |

Agent 不能使用 shell、Python、浏览器下载脚本或普通文件工具绕过 MCP 执行安装。Agent 的自由度止于提交结构化 Proposal。

## 4. V2 对象模型

V2 保持“事实、方法、计划、执行、结果”分离。

### 4.1 Evidence Pack

Evidence Pack 是一次候选安装分析的只读事实集合：

- Archive 和 receipt 身份、大小、SHA-256。
- Bundle node、依赖关系、安装顺序和来源身份。
- Archive inventory、目录树、文件类型和安全检查。
- 机器可读 manifest、配置、FOMOD 元数据。
- Archive 内 README 和安装说明。
- Nexus description、Requirements、作者说明和当前文件元数据。
- 官方 Loader 或游戏文档。
- 当前 Game Context。
- 已有 Installation Record、冲突和依赖满足状态。
- 每条结论的来源、抓取时间和内容哈希。

Evidence Pack 是不可变、可寻址的临时对象。它不能包含 Agent 未经来源支持的推断。

### 4.2 Installation Method

Installation Method 是可复用安装知识，不是一次执行记录。

概念字段：

```yaml
schemaVersion: 2
methodId: uuid
revision: 1
state: draft | session_approved | local_verified | promoted | quarantined | deprecated
scope:
  operatingSystems: [win32]
  gameSelectors: []
  loaderSelectors: []
  sourceSelectors: []
  packageSignals: []
  negativeSignals: []
resolution:
  packageRootRules: []
  componentSelectionRules: []
  targetMappings: []
operationsTemplate: []
preconditions: []
verificationTemplate:
  staticChecks: []
  runtimeChecks: []
reversibilityRequirements: []
provenance:
  origin: agent_learned | built_in | imported
  evidenceRefs: []
  derivedFromInstallationIds: []
confidence:
  deterministicSignals: []
  successfulApplications: 0
  failedApplications: 0
  lastVerifiedAt: null
```

Method 不保存：

- 本次绝对游戏路径。
- 本次 staging 路径。
- 本次 `planId` 或 transaction。
- 实际写入结果。
- `installed_at`、备份位置和卸载状态。

这些属于 Install Plan、Transaction Journal 和 Installation Record。

### 4.3 Method Draft

当 Method Store 没有可信匹配时，Agentic Planner 生成 Method Draft。

Draft 必须：

- 引用 Evidence Pack 中的具体证据。
- 区分“观察事实”和“推导结论”。
- 声明适用范围，不能默认泛化到所有游戏或所有版本。
- 只使用 Operation Catalog 中的操作。
- 声明安装前置条件、验证方式和可逆性要求。
- 对所有不确定选择显式建模。

Draft 通过 Proposal Validator 不代表已经学会。只有成功执行并达到规定验证等级后，才能晋升为 `local_verified`。

### 4.4 Install Proposal

Install Proposal 是 Agent 或 Method Resolver 提交给确定性引擎的候选计划。

它包含：

- Evidence Pack 和 Game Context 绑定。
- Method 来源或 Method Draft。
- 选择的 package root、组件和目标映射。
- 具体 Operation Draft。
- 前置条件、冲突策略和验证规则。
- 风险等级、未解决选择和所需批准。

Proposal 可以被拒绝、要求补证或要求用户选择。它不能被执行。

### 4.5 Install Plan V2

Proposal 通过验证后才能冻结成 Install Plan V2。

Install Plan V2 固定：

- Archive、receipt、Evidence Pack 和 Game Context hash。
- Method revision 或 Agent Proposal hash。
- 所有具体源路径、目标路径、参数和预期状态。
- 依赖满足状态。
- 每项操作的可逆性等级。
- 静态和运行时验证要求。
- 风险摘要和批准内容。
- `planId`、`planHash` 和过期时间。

Apply 仍然只接受 `planId`。

### 4.6 Method Outcome

Method Outcome 把一次实际结果反馈给 Method Store：

- Method revision 和匹配证据。
- Installation Record 或失败 transaction。
- 静态、运行时验证等级。
- 实际操作偏差。
- 回滚或恢复结果。
- 失败原因是否由方法本身导致。

失败不能覆盖历史 Method。Store 追加 Outcome，并据此降低置信、隔离 revision 或创建新 revision。

## 5. Method Store

### 5.1 存储位置

默认存储：

```text
%LOCALAPPDATA%\GameModToolkit\
├── methods\
│   ├── drafts\
│   ├── session-approved\
│   ├── local-verified\
│   ├── promoted\
│   ├── quarantined\
│   ├── outcomes\
│   └── index\
├── game-contexts\
├── evidence\
├── plans\
├── transactions\
├── installations\
└── backups\
```

普通安装不能自动修改：

- `skills/install-game-mods/`
- 仓库内 TypeScript Adapter。
- 内置 Profile 或 Method。
- Git 工作树。

### 5.2 方法状态

```text
draft
  → session_approved
  → local_verified
  → promoted

任何状态
  → quarantined
  → deprecated
```

- `draft`：尚未执行，只能用于生成需完整审阅的 Proposal。
- `session_approved`：用户批准用于当前计划，不允许跨任务静默复用。
- `local_verified`：至少一次符合要求的安装验证成功，可在相同证据范围内优先匹配。
- `promoted`：经过跨版本或跨样本回归验证，可作为内置高置信候选。
- `quarantined`：出现方法相关失败、证据漂移或不一致，停止自动匹配。
- `deprecated`：保留历史记录，不再生成新计划。

### 5.3 匹配算法

Method Resolver 按以下顺序匹配：

1. 排除操作系统、游戏、Loader 或明确负面信号不匹配的方法。
2. 优先匹配机器可读 manifest、入口文件和稳定目录结构。
3. 比较来源身份、Archive 布局指纹和版本约束。
4. 比较 Dynamic Game Context 的目标根和 Loader 状态。
5. 检查 Method 所需 Operation 是否仍受当前引擎支持。
6. 检查 Method revision 是否被隔离、弃用或存在失败 Outcome。
7. 返回证据充分度，不只返回一个模型置信分。

匹配结果：

```text
verified_match
candidate_match
ambiguous
evidence_stale
no_match
```

只有 `verified_match` 可以直接实例化为 Proposal；它仍需经过确定性验证和用户批准。其余状态进入 Agentic Planner 或要求具体选择。

### 5.4 晋升和失效

Method 晋升必须绑定实际 Outcome，不接受“Agent 认为正确”作为成功证据。

默认晋升要求：

- 事务成功提交。
- 静态验证通过。
- 所需运行时验证已通过，或 Method 明确声明运行时验证不适用。
- 没有超出声明范围的写入。
- Installation Record 可用于生成合法的 Current-State Inspection。

出现以下情况时重新验证或隔离：

- Archive 布局指纹改变。
- 游戏、Loader 或安装器主版本跨越 Method 约束。
- 目标路径策略改变。
- 运行时验证失败。
- 发现未声明写入。
- 后续卸载或更新暴露所有权错误。

### 5.5 经验泛化

Method 默认从窄作用域开始：

```text
确切 Archive 布局
  → 同一 Mod 的兼容版本
  → 同一 Loader 的同类包
  → 跨游戏通用机制
```

每次扩大作用域都生成新 revision，并要求新的验证 Outcome。系统不得因为一次成功就把单 Mod 规则泛化成通用规则。

## 6. Agentic Installation Planner

### 6.1 职责

当 Method Resolver 没有 `verified_match` 时，Planner：

1. 读取 Evidence Pack 和 Dynamic Game Context。
2. 确定缺失证据。
3. 使用 Nexus MCP、受控浏览器或官方文档补充安装说明。
4. 识别包根、组件、依赖和目标映射。
5. 选择 Operation Catalog 中的最小操作集合。
6. 设计静态和运行时验证。
7. 生成 Method Draft 和 Install Proposal。

Planner 不执行任何写入。

### 6.2 证据优先级

从高到低：

1. 包内机器可读 manifest 和标准安装元数据。
2. 当前文件版本对应的作者安装说明。
3. 官方游戏、Loader 或框架文档。
4. Archive 的明确目录结构与入口文件。
5. 当前游戏实例和已安装 Loader 的可验证结构。
6. 已成功验证、作用域匹配的本地 Method。
7. 社区教程或管理器惯例。
8. 文件名和关键词启发式。

第 7、8 项不能单独支持写入或执行进程。

### 6.3 缺失信息处理

Planner 先尝试补证，不把每个未知点都立即交给用户。

只有当一个选择会改变写入结果且无法从证据确定时，才询问用户，例如：

- 普通版还是兼容版。
- 是否安装可选纹理包。
- 多个游戏实例中选择哪个。
- 是否批准中等风险的受控安装器操作。

### 6.4 失败与重试

如果验证或执行失败：

1. 停止剩余依赖链。
2. 使用 Transaction Journal 回滚或进入 `recovery_required`。
3. 保存失败 Evidence 和 Method Outcome。
4. 判断是环境问题、版本问题、证据不足还是 Method 错误。
5. 允许 Agent 基于新证据生成修订 Draft。
6. 新计划必须重新展示和批准。

失败方法不会自动成为经验。

## 7. Dynamic Game Context

### 7.1 目的

V1 Game Profile 同时承担游戏知识、实例发现和写入权限，导致未知游戏无法进入规划。

V2 拆分为：

- **Game Definition**：可选的内置或已验证游戏知识。
- **Game Instance Facts**：本机只读探测结果。
- **Path Policy**：本次安装允许和禁止的路径。
- **Dynamic Game Context**：以上信息在一次安装中的不可变快照。

### 7.2 Context 来源

Dynamic Game Context 可以由以下证据构建：

- 用户明确提供的游戏根目录。
- Steam、GOG、Epic 等本机 manifest。
- 游戏可执行文件和版本信息。
- 当前目录结构。
- Loader manifest、入口程序和日志位置。
- 内置 Game Definition。
- 本地已验证 Context。
- 作者安装说明中的目标路径约定。

未知游戏不要求先提交仓库 Profile。

### 7.3 Path Policy

Path Policy 必须区分：

- `writableRoots`
- `protectedRoots`
- `liveModRoots`
- `managedStateRoots`
- `observableRoots`
- `processSideEffectRoots`

动态生成的 writable root 必须有证据并在计划审批中展示。游戏根目录不能自动整体视为可写。

### 7.4 Context 状态

```text
observed
  → session_approved
  → local_verified
  → built_in
```

- `observed` 只支持分析。
- `session_approved` 可用于当前计划。
- `local_verified` 可以在相同安装实例上复用，但每次仍重新探测关键路径。
- `built_in` 是仓库内维护的通用定义。

Context 漂移时重新生成，不直接修改旧对象。

## 8. 通用操作中间表示

### 8.1 保留的文件操作

V1 操作继续保留：

- `ensure_directory`
- `install_new_file`
- `replace_file`
- `install_tree`
- `replace_managed_tree`
- `remove_empty_directory`

每项操作继续要求 expected pre-state、expected post-state、路径校验和可逆性声明。

### 8.2 V2 扩展原则

新能力必须先定义为受约束 Operation，并同时实现：

- 输入 schema。
- 路径和参数策略。
- pre-state 捕获。
- 执行器。
- post-state 验证。
- 失败和中断恢复。
- Installation Record 表达。
- 后续卸载或人工恢复语义。
- 单元、沙箱和故障注入测试。

Method 和 Agent 都不能创造 Operation 名称。

### 8.3 受控安装器操作

为覆盖 SMAPI 等框架安装器，V2 需要通用的 `run_bundled_installer` 能力，而不是单 Mod Adapter。

概念字段：

```yaml
kind: run_bundled_installer
entry:
  source: verified_staging
  relativePath: ...
  runtime: native | dotnet | fixed-script-runner
arguments: []
workingDirectory: ...
environmentPolicy: minimal
timeoutMs: ...
allowedExitCodes: [0]
declaredWriteRoots: []
preStateSnapshots: []
postConditions: []
```

约束：

- 入口必须来自已验证 staging 或明确受信任的本机 runtime。
- 禁止自由格式 shell command。
- 参数是结构化数组，并经过逐项验证。
- 不继承无关环境变量。
- 必须设置超时、进程树控制和输出捕获。
- 必须声明预计写入根并在执行前快照。
- 执行后比较副作用范围。
- 无法限制或观察副作用时，计划必须标为高风险并要求额外批准，或进入辅助人工步骤。

该 Operation 一旦实现，应能服务多个官方 Loader 或标准安装器。

### 8.4 能力等级

| 等级 | 类型 | 默认行为 |
|---|---|---|
| A | 可逆文件操作 | 正常生成计划并审批 |
| B | 受控安装器、结构化配置修改 | 显示副作用范围和额外风险后审批 |
| C | 不透明系统级副作用 | 尝试补证；不能证明时进入人工检查点 |
| D | Operation Catalog 无法表达 | 报告缺失的通用能力，不要求开发单 Mod Adapter |

## 9. Contract V2

### 9.1 版本策略

- 新对象使用 `schemaVersion: 2`。
- V1 已提交 Installation Record 保持只读兼容。
- V1 未执行 Install Plan 是短期对象，不迁移；重新规划为 V2。
- V1 Adapter ID 可以保存在 V2 provenance 中，但不再是必填执行身份。

### 9.2 Install Plan V2 概念结构

```yaml
schemaVersion: 2
planId: uuid
planHash: sha256
status: planned
createdAt: ...
expiresAt: ...

source:
  archive: ...
  receipt: ...
  bundleId: ...
  bundleNodeId: ...

evidenceBinding:
  evidencePackId: uuid
  evidencePackHash: sha256

gameBinding:
  gameContextId: uuid
  gameContextHash: sha256
  gameRoot: ...

strategyBinding:
  origin: built_in_method | learned_method | agent_proposal
  methodId: null
  methodRevision: null
  proposalHash: sha256

selection:
  packageUnitId: ...
  packageRoot: ...
  selectedComponents: []

operations: []
conflicts: []
preconditions: []
verificationRequirements: []
reversibility:
  level: full | bounded | manual_recovery
  backupRequirements: []
risk:
  level: low | medium | high
  reasons: []
approval:
  requiresExplicitConfirmation: true
  approvalDigest: sha256
preconditionStateHash: sha256
```

### 9.3 Installation Record V2

Record 除 V1 实际结果外，新增：

- Evidence Pack 和 Game Context 绑定摘要。
- Method/Proposal provenance。
- Method revision。
- 实际执行的受控进程身份、参数摘要、输出回执和副作用观察。
- 计划与实际操作偏差。
- Method Outcome 引用。
- 依赖 Installation ID 和 dependent Installation ID。

卸载仍以实际 operation outcomes、pre-state、post-state、ownership 和 backup 为权威，不以 Method 为权威。

### 9.4 错误分类调整

以下 V1 错误不再直接终止流程：

- `ADAPTER_NOT_FOUND` → `METHOD_RESEARCH_REQUIRED`
- `GAME_PROFILE_NOT_FOUND` → `GAME_CONTEXT_REQUIRED`
- `DEPENDENCY_MISSING` → 继续处理 Bundle 中对应依赖；只有物料或方法缺失时再分类

V2 新增：

- `EVIDENCE_INSUFFICIENT`
- `EVIDENCE_CONFLICT`
- `METHOD_AMBIGUOUS`
- `METHOD_STALE`
- `METHOD_QUARANTINED`
- `PROPOSAL_INVALID`
- `OPERATION_CAPABILITY_MISSING`
- `PROCESS_SIDE_EFFECT_SCOPE_UNPROVEN`
- `VERIFICATION_REQUIREMENT_UNSATISFIED`
- `USER_CHOICE_REQUIRED`

Agent 根据结构化 next action 继续补证、询问选择或重新规划，不能解析自然语言猜测。

## 10. MCP 工具边界

### 10.1 只读证据和上下文

- `prepare_install_evidence(bundlePath?, archivePath?, receiptPath?, bundleNodeId?)`
- `get_install_evidence(evidencePackId)`
- `probe_game_context(gameRoot, gameHint?)`
- `get_game_context(gameContextId)`
- `query_install_methods(evidencePackId, gameContextId)`
- `get_install_method(methodId, revision?)`

### 10.2 Proposal 和计划

- `submit_install_proposal(evidencePackId, gameContextId, proposal)`
- `validate_install_proposal(proposalId)`
- `freeze_install_plan(proposalId)`
- `get_install_plan(planId)`

`submit_install_proposal` 只写 Manager 状态，不写游戏目录。

### 10.3 执行、验证和恢复

- `apply_mod_install(planId)`
- `verify_mod_install(installationId, level?)`
- `get_install_status(kind, id)`
- `find_installed_nexus_mod(modUrl, gameRoot?, versionConstraint?)`
- `rollback_mod_install(transactionId)`

Apply 继续只接受 `planId`。

### 10.4 学习

- `record_method_outcome(installationId | transactionId)`
- `promote_install_method(methodId, revision, targetState)`
- `quarantine_install_method(methodId, revision, reason)`
- `list_install_methods(filters?)`
- `inspect_install_method_history(methodId)`

普通成功安装可以自动生成 `local_verified` 候选，但不能自动晋升为仓库内置方法。

### 10.5 Bundle 编排

Bundle 保持 dependency-first 顺序。对每个尚未满足节点：

1. 准备 Evidence Pack。
2. 查询 Method。
3. 必要时 Agent 推导 Draft。
4. 验证、冻结、审批、执行和验证。
5. 记录依赖 Installation ID。
6. 只有依赖达到要求的验证等级后才处理 dependent。

## 11. `install-game-mods` Skill V2 工作流

Skill 保持精简，详细 schema 和 MCP SOP 放入 references，避免把每个游戏或 Mod 的经验写进 SKILL.md。

生产流程：

1. 显式接收一个 Bundle，或一个 Archive/receipt。
2. 验证输入和 dependency order。
3. 构建 Dynamic Game Context。
4. 对每个未满足节点准备 Evidence Pack。
5. 查询 Method Store 和 built-in providers。
6. 有 verified match 时实例化 Proposal。
7. 没有 verified match 时主动研究并生成 Method Draft。
8. 把 Proposal 交给 MCP 验证；按结构化错误补证或询问必要选择。
9. 展示证据、来源、具体写入、受控进程、风险、回滚和验证方式。
10. 等待用户批准冻结 Plan。
11. 只通过 `planId` 执行。
12. 完成静态和所需运行时验证。
13. 写 Installation Record 和 Method Outcome。
14. 成功后沉淀本地 Method；继续处理依赖链。

Skill 不应回复：

> 当前没有这个 Mod 的 Adapter，请先开发 Adapter。

应回复为以下一种：

- 已找到并验证可复用安装方法。
- 已根据证据推导候选方法，请审阅计划。
- 仍缺少某条具体证据或用户选择。
- 当前缺少某项通用 Operation 能力。
- 安装器副作用范围无法证明，需要高风险批准或人工检查点。

## 12. 依赖、验证与卸载

### 12.1 依赖闭包

Download Bundle 是安装输入物料的权威集合。Install 阶段：

- 重新验证每个 Archive 和 receipt。
- 探测已经满足的依赖。
- 对未满足依赖使用同一 Method 流程。
- 保存依赖 Installation ID。
- 禁止在前置依赖失败后继续安装 dependent。

Loader 不再因为缺少预写 Adapter 而默认阻塞。

### 12.2 验证等级

```text
material_verified
  → plan_validated
  → transaction_committed
  → static_verified
  → runtime_verified
```

每个 Method 声明 dependent 所需的最低验证等级。例如普通 SMAPI Mod 在安装前要求 SMAPI 至少达到 `static_verified`；最终验收要求 Mod 达到 `runtime_verified`。

### 12.3 卸载

Method 只帮助解释安装机制，不能作为卸载事实。

Uninstall Planner 继续读取：

- Installation Record。
- 实际 operation outcomes。
- pre-state、post-state 和 backup。
- 当前磁盘状态。
- ownership 和 dependent 关系。

受控安装器如果无法产生可证明的反操作，Record 必须声明 `manual_recovery` 或受限卸载能力，不能虚构完整回滚。

## 13. V1 迁移方案

### 13.1 原样保留

- Download Plan、Archive receipt 和 Bundle Manifest。
- Input Verifier。
- Archive Inspector。
- Staging Manager。
- Path Policy 的路径穿越、保护根和规范化逻辑。
- 文件哈希、树哈希和 Conflict Detector。
- Plan Store 的不可变发布、TTL 和 stale 检查。
- Transaction Engine、Instance Lock 和 Process Guard。
- Backup Store、Transaction Journal 和 Recovery Manager。
- Installation Record、State Inspector、Uninstall Planner 和 Uninstall Engine。

### 13.2 重构

| V1 | V2 |
|---|---|
| Package Analysis | Evidence Pack 的 Archive 分析部分 |
| Adapter Registry | Method Resolver + Built-in Method Providers |
| Adapter Planner | Agentic Planner 或 Method Instantiator |
| 必填 `adapterId` | `strategyBinding` |
| 注册 Game Profile | Dynamic Game Context + 可选 Game Definition |
| Adapter static/runtime verifier | Method Verification Template + 通用 Verifier |
| `ADAPTER_NOT_FOUND` 阻塞 | `METHOD_RESEARCH_REQUIRED` |

### 13.3 退役

- “未知安装机制必须先开发 Adapter”的规则。
- “普通安装不能学习可复用方法”的非目标。
- “缺少注册 Profile 就不能分析”的门槛。
- Skill 中遇到 Loader Runtime 且无 Adapter 就立即结束的 SOP。
- 把 `adapterId` 作为 Transaction Engine 执行所必需的代码身份。

### 13.4 兼容策略

- V1 已提交 Record 保持可验证和可卸载。
- V1 Adapter 可以包装为只读 Built-in Method Provider。
- `smapi-folder-mod` 的已有逻辑可以首先转成内置 Method，不再作为唯一入口。
- V1 临时 Plan 不迁移；重新生成 V2 Plan。
- Contract V2 重构期间保留 V1 测试作为事务底层回归集。

## 14. 测试与验收

### 14.1 Contract 和 Store

- Method revision 不可变。
- 状态晋升和隔离符合状态机。
- Outcome 只能追加，不能覆盖历史。
- Evidence、Context、Proposal 和 Plan hash 绑定正确。
- Method 作用域漂移会降级或阻止匹配。

### 14.2 Agentic Planner

- 未知标准文件包能在没有 Adapter 时生成合法 Proposal。
- Proposal 中每个关键判断都能追溯到 Evidence。
- 不支持的 Operation 被 Validator 拒绝。
- 歧义只询问真正影响安装结果的选择。
- 失败 Outcome 不会被晋升为已验证 Method。

### 14.3 Dynamic Game Context

- 未注册游戏可以从明确 game root 构建 observed Context。
- 动态 writable root 必须有证据并经过批准。
- protected root 永远不能被 Method 或 Agent 覆盖。
- Context 漂移导致计划 stale。

### 14.4 事务回归

- V1 文件操作、冲突、备份、回滚和恢复测试全部保持通过。
- V2 strategyBinding 不削弱 plan hash 和 apply-by-ID。
- 受控进程异常、超时和未声明副作用有故障注入测试。

### 14.5 Stardew Valley 冷启动验收

初始条件：

- Method Store 中没有 SMAPI 2400 或 Mod 2697 的方法。
- 不注册 SMAPI 专用安装 Adapter。
- 使用已经通过 Download Skill 生成的完整 Bundle。
- 用户提供或确认 Stardew Valley game root。

要求：

1. 系统自行识别 SMAPI 是必需 Loader Runtime。
2. Agent 根据 Archive、Nexus 和官方证据推导 SMAPI 候选安装方法。
3. MCP 验证并冻结 SMAPI Install Plan。
4. 用户批准后，系统安装并静态验证 SMAPI。
5. 系统继续推导或识别 Mod 2697 的 SMAPI 文件夹安装方法。
6. 用户批准后安装 Mod 2697。
7. 两个节点分别生成 Installation Record，并记录 dependency relationship。
8. SMAPI 日志确认 Mod 被识别和加载。
9. 两个成功方法进入 `local_verified`。
10. 失败路径可以回滚或明确进入 `recovery_required`。
11. Record 足以派生安全 Uninstall Plan。

### 14.6 暖启动学习验收

在新的独立任务中，用相同或兼容证据再次处理：

- Method Resolver 能找到本地已验证方法。
- 不重复完整的开放式安装研究。
- 重新验证 Archive、Context、版本范围和磁盘 pre-state。
- 仍展示并批准具体 Install Plan。
- 经验复用不绕过确定性校验。

### 14.7 泛化验收

选择第二个未预编写 Adapter 的标准 SMAPI Mod：

- 系统应复用已验证的 SMAPI 文件夹机制。
- 不应创建单 Mod Method，除非其布局确实是已知例外。
- Archive 布局或说明不一致时应退回 Agentic Planner。

满足冷启动、暖启动和泛化验收后，才认为 V2 的“自学习安装”目标成立。

## 15. 实施里程碑

不继续沿用不断增长的 6B-x 子阶段。V2 使用四个里程碑：

### M1：Contract V2 与只读学习基础

- 定义 Evidence Pack、Dynamic Game Context、Installation Method、Proposal 和 Plan V2。
- 实现 Method Store、状态机、索引和 Outcome。
- 将 V1 Adapter/Profile 映射为兼容 Provider。
- 不执行真实游戏写入。

实施结果（2026-07-27）：

- 新增独立 `src/install/v2` 命名空间，未切换 V1 apply 路径。
- Contract V2 已覆盖 Evidence Pack、Dynamic Game Context、Game Definition、Installation Method、Install Proposal、Install Plan V2、受控安装器 Operation、Method Outcome 和 Provider Candidate。
- Method Store 已实现不可变 revision、受约束状态转换、原子索引、启动重建、Outcome 追加、哈希校验和查询过滤。
- `LegacyV1CompatibilityProvider` 已把 V1 Adapter 匹配结果映射为只读候选，并把 V1 Game Profile 映射为 V2 Game Definition；兼容候选不具有独占规划权。
- 定向 M1 测试与全量测试通过；M1 没有新增 MCP 写工具，也没有触碰真实游戏目录。

### M2：Agentic 文件型安装闭环

- 实现 Evidence 和 Context MCP 工具。
- 实现 Method 查询、Proposal 验证和冻结。
- 用现有文件 Operation 完成“无预编写 Adapter”的沙箱安装。
- 更新 `install-game-mods` Skill V2。

实施结果（2026-07-27）：

- 新增不可变 `Evidence Pack`、`Dynamic Game Context`、`Install Proposal`、`Install Plan V2` 与 V2→V1 执行桥的持久化 Store，并在每次读取时校验内容哈希。
- 新增 `probe_game_context`、`prepare_install_evidence`、`query_install_methods`、`submit_install_proposal`、`freeze_install_plan`、`apply_agentic_install_plan` 等 Contract V2 MCP 工具。
- `Method Resolver` 可同时查询 Method Store 与只读 V1 Compatibility Provider；没有候选 Method 时明确进入 `agent_proposal`，不再返回“必须开发 Adapter”。
- 新增通用 `agentic-v2-file-method` 兼容执行器。它不参加 V1 匹配，只负责把已通过 V2 Validator 的文件 Operation 交给既有锁、备份、Journal、验证和回滚引擎。
- M2 Validator 只接受被选 Package Root 到声明 writable root 内的 `install_tree`，拒绝 protected root、`layered_path` 所有权和未实现的 Operation。
- `install-game-mods` 已切换到 Evidence → Context → Method/Agent Proposal → Plan → 明确审批 → apply-by-ID 的 V2 SOP。
- 新增端到端测试证明：未注册游戏、无候选 Method、无预编写 Game/Mod Adapter 时，Agent Proposal 可以冻结计划；冻结前不修改游戏；批准后通过事务引擎完成文件型安装和静态验证。
- `run_bundled_installer` 仍按设计返回 `OPERATION_CAPABILITY_MISSING`，留给 M3 的受控进程执行能力；这不等价于要求开发 Mod 专用 Adapter。

M2 独立 Session 收尾修正（2026-07-27）：

- `query_install_methods` 同时返回稳定的 `operationCapabilities`、`proposalReadiness` 和 `contextAdvisories`，使 Agent 无需提交无效 Proposal 来探测 M3 能力。
- Evidence 没有 selectable package unit 时返回 `stop_before_proposal`，明确禁止虚构 `packageUnitId`、`packageRoot`、entry hash 或 Evidence ID。
- 显式 Context 与已注册 Game Profile 的 Nexus domain/身份重合时返回 `reprobe_with_legacy_profile`，要求用稳定 `legacyProfileId` 重建 Context 与 Evidence。
- 对 schema 合法的 `run_bundled_installer` Proposal，Validator 在 package selection 前稳定返回 `OPERATION_CAPABILITY_MISSING`；schema 不完整的调用仍由 MCP 输入校验拒绝。
- Skill 改为严格服从 `recommendedAction`：安装器缺少 package unit 时直接保留 Evidence/Context 并停止，不再重复提交 capability-probe Proposal。

### M3：受控安装器与依赖闭环

- 实现 `run_bundled_installer` 通用能力。
- 增加进程约束、副作用观察、快照和恢复测试。
- 让 Bundle 中 Loader Runtime 与普通 Mod 使用同一编排流程。

实施结果（2026-07-28）：

- Package Analyzer 可从无 manifest 的 ZIP 中识别高信号 `.exe` / `.js` bundled installer，生成 `executable-installer` Package Unit；Evidence Collector 只对被识别的候选入口流式计算 SHA-256，避免 Agent 虚构入口或 hash。
- `query_install_methods` 已将 `run_bundled_installer` 标记为 M3 可用，并以 `construct_agent_installer_proposal`、`canSubmitInstallerProposal` 暴露稳定 readiness；真正没有 Package Unit 或存在未满足 Bundle 前序依赖时仍返回 `stop_before_proposal`。
- M3 Validator 只接受单个安装器 Operation，强制 Evidence 中的精确 entry/hash、固定 runtime、`minimal` 环境、高风险分类、至少一个 postcondition，以及带真实 Evidence/Context ID 的最小声明写入根；protected root 永远不可声明。
- Freeze 会再次验证 Archive、staging entry hash 与工作目录，自动抓取声明根的 `preStateSnapshots` 和 Plan precondition hash，并将完整进程参数、允许退出码、timeout、冲突、可逆性和 approval digest 冻结进不可变 Plan。
- Controlled Installer Engine 使用无 shell 子进程、最小环境、固定参数、timeout/process-tree 终止、实例锁和敏感进程检查；执行前为所有既有声明根创建内容寻址备份。
- 引擎在进程前后比较完整 game-root 文件树。未声明变更不能成为成功结果：声明根会尽可能恢复，无法证明 game-root 已完整恢复时写入 V2 Installation Record 的 `recovery_required`。
- 新增持久化 installer journal。服务重启或进程中断后不会静默重跑同一 Plan；后续 apply 会根据 Journal 恢复声明根，并在副作用观察不完整时保持 `recovery_required`。
- `prepare_install_evidence` 可直接接收 `bundlePath + bundleNodeId`，由服务器验证 Bundle/receipt/Archive/hash 和 `installOrder`，不再要求 Agent 手工抄出 Archive 路径。成功的 Loader Runtime Record 会自动满足后续节点；未满足前序节点返回 `DEPENDENCY_MISSING`。
- 注册 Game Profile 的 Loader Runtime 安装成功后会重新 probe Dynamic Game Context；后续 Bundle 节点因此能看到新 loader 状态，而不是沿用安装前 Context。
- 定向回归覆盖：正常执行、非零退出恢复既有目录、未声明副作用、持久 Journal 中断恢复、注册 Profile loader 重新探测、Bundle loader Record 接续，以及原 M2 文件型路径不回归。

### M4：真实学习验收

- 完成 Stardew Valley 冷启动验收。
- 完成新任务中的暖启动复用。
- 完成第二个 SMAPI Mod 的泛化验收。
- 验证 Installation Record 到 Uninstall Plan 的完整交接。

实施进度（2026-07-28）：

- 成功的 `agent_proposal` 现在会从实际 Proposal、Plan、Evidence、Context 和 Installation Record 派生结构化 Method，依次写入 `draft`、`session_approved`、`local_verified` revision，并追加不可变的成功 Method Outcome。安装已提交但学习写入失败时会返回独立 warning，不会伪装成安装失败。
- 新增 `instantiate_install_method`。它只接受当前 Evidence/Context 下的精确 `verified_match`、Method revision/hash 和 package unit，重新解析当前入口 hash、game root 与包名模板，再经过普通 Proposal Validator；Method 复用不会绕过 Plan freeze 和人工审批。
- Method Resolver 改为按 package unit 计算匹配，避免多组件 Archive 中“一个 unit 命中、所有 unit 都被授权”的错误扩大。
- 沙箱验收已证明：首次 Agent 文件安装沉淀 `local_verified` Method；全新 `AgenticInstallService` 实例能从同一 Method Store 暖启动；第二个不同标准 SMAPI Mod 能复用包根与目标模板，并向同一 Method revision 追加 Outcome。
- `InstallService` 已接通既有 Uninstall Planner/Engine。Agentic 文件型 Installation Record 可冻结独立 Uninstall Plan，并通过实际 operation outcomes、ownership、pre/post state 和当前磁盘状态完成卸载；Method 不参与推导卸载事实。
- 真实 Bundle 的 SMAPI 2400 节点已经通过 Archive/receipt/Bundle hash、Dynamic Game Context、Package Unit、entry SHA-256、最小声明写入根和 postconditions 校验，并冻结出高风险受控安装器 Plan。
- 用户批准后，旧 Plan 通过原有 `redirected_stdio` 路径执行。SMAPI 的 `--no-prompt` 路径仍会调用 `Console.Clear()`；由于重定向执行没有真实控制台，进程异常退出。引擎没有观察到写入，完整恢复了声明根，并留下 `rolled_back` Installation Record。该结果证明问题位于通用进程终端能力，而不是 SMAPI 专用安装知识。
- Contract、Proposal、Plan、Installation Record 与可学习 Method 模板现支持可选 `terminalMode`：默认 `redirected_stdio`，只有证据证明需要控制台时才选择 `pseudoterminal`。旧对象缺少该字段时仍按默认模式解释，保持既有 hash/Record 兼容。
- `pseudoterminal` 当前由 Windows ConPTY 和可选 `node-pty` 依赖提供；它只提供真实控制台语义和有界、去控制序列的合并输出，不发送按键，不回答交互式选择，也不放宽参数、环境、超时、写入根、副作用观察、备份、Journal 或恢复约束。
- `query_install_methods.operationCapabilities` 公开两种 terminal mode 的宿主可用性。Validator 只允许 Windows MCP 宿主与 Windows Dynamic Game Context 使用 ConPTY，并在冻结前以 `OPERATION_CAPABILITY_MISSING` 拒绝不支持的组合。
- 定向回归覆盖 ConPTY 控制台检测成功、终端输出净化、terminal mode 写入 Method、超时进程树终止与声明根回滚，以及非 Windows Context 的冻结前拒绝。
- 旧失败 Plan 及其 Installation Record 保持不可变且不会重跑。能力完成后必须从当前 Bundle、Context 与 Evidence 重新生成并展示一个新的 SMAPI Plan，仍需用户对新 `planId` 单独批准。

真实冷启动验收结果（2026-07-28）：

- 新 SMAPI Plan `b2f0ba10-7c4d-4099-96d7-4673f06b5408` 通过 `pseudoterminal` 执行官方 `SMAPI.Installer.exe --install --game-path ... --no-prompt`。进程退出码为 0、未超时、静态验证通过、未声明变更为 0，Journal 状态为 `committed`，Installation ID 为 `e497b4ba-2cd0-4751-a0e2-20fe87bbabf1`。
- SMAPI Agent Proposal 已沉淀为 `local_verified` Method `b6b9b43c-ad2e-48e7-94dc-e0876b85411b` revision 3；Method 模板保留 `terminalMode: pseudoterminal`。用户随后在游戏中确认 SMAPI 正常启动。本阶段按用户决定不新增运行时验证持久化对象。
- 真实 Mod 2697 的 `manifest.json` 带 UTF-8 BOM。旧 Analyzer 在 `JSON.parse` 前未处理 BOM，导致 Archive 虽有标准 Manifest 与 EntryDll，却返回空 `packageUnits`。`package-analyzer@3` 现在只移除一个前导 `U+FEFF` 后解析，并继续执行原有 schema、EntryDll 存在性和 Archive 路径约束；真实 Archive 已识别为 `loader-plugin`，包根为 `SkipFishingMinigameDotnet5`，无歧义。
- Mod 2697 Plan `ad43e1ec-205b-4b12-ae72-289591e21c09` 将固定 tree hash 的两文件包安装到 `Mods/SkipFishingMinigameDotnet5`。Installation ID `5e2e0987-a802-45c5-b7b1-0a6ac025cec9` 静态验证通过，复核时目标 tree hash 未变化；用户随后在 SMAPI 中确认 `SkipFishingMinigame` 成功加载。
- 2697 Agent Proposal 已沉淀为通用 `local_verified` SMAPI 文件夹 Method `25f91f3b-ca76-4327-993a-a6c3217824db` revision 3。新的正式 stdio MCP 进程对同一 Evidence/Context 查询返回 `select_verified_method`，并精确命中该 Method，证明持久 Method Store 能在新服务进程中完成暖启动解析。
- 正式 stdio 验收从当前 `dist/index.js` 启动独立 MCP 进程：42 个工具可列出，Contract V2 核心工具全部存在，`health_check` 通过，ConPTY capability 为 `available`，带 `terminalMode` 的两个已验证 Method 均可读取。旧任务内的热加载前 MCP 进程已停止；新任务应重新建立 MCP transport，不再复用旧进程内存。
- Manager state 审计通过：`locks` 与 `staging` 均为空；没有 SMAPI Installer、游戏、staging 或验收客户端残留进程；旧失败 Plan 保持 `rolled_back`，新 SMAPI Plan 保持 `installed/committed`，2697 文件事务保持静态验证通过。
- Bundle `27609156-029d-4ee3-90eb-ac0511a658ef` 已分别保存 `nexus:stardewvalley:2400` 与 `nexus:stardewvalley:2697` 的 completion Record，两个节点均绑定到各自成功 Installation ID。

第二个真实标准 SMAPI Mod `UI Info Suite 2`（Nexus 7098）已完成盲测：独立 Session 未获得 Method ID 或预期答案，自主查询后选择 `select_verified_method`，通过 `instantiate_install_method` 复用 `25f91f3b-ca76-4327-993a-a6c3217824db` revision 3，冻结、审批、执行并静态验证成功。游戏内运行验证也由用户确认通过；Method Store 没有生成 7098 专用重复 Method，只向原 Method 追加成功 Outcome。

依赖下载验收同时暴露出本地 Installation Record 只能按 UUID 精确读取，Agent 会尝试猜测历史 ID。现新增 `find_installed_nexus_mod`：按 canonical Nexus Mod URL、精确游戏目录与显式数字版本约束统一检索文件事务和受控安装器记录。文件事务会重新校验所有 owned files，并将运行后额外生成的配置数据降为 dependency-presence warning；受控安装器记录会解析 Evidence、Context、fileId 与 Bundle 中的版本，但必须再用相同 game root 做 Loader 探测，才允许写入 `satisfiedNodeIds`。真实状态验收已正确找到 SMAPI 4.5.2/fileId 160380 和 UI Info Suite 2 2.3.7/fileId 116310，且不再需要已知 Installation UUID。

当前剩余的 M4 验收项只有：从 2697 的真实 Installation Record 冻结但不执行 Uninstall Plan。沙箱中的暖启动、第二 Mod 泛化和卸载闭环已经通过。

### M4 收尾：Installation Dependency Snapshot（2026-07-28）

卸载规划前新增统一的本地依赖事实层。该层不修改现有文件事务
Installation Record 或受控安装器 Installation Record，而是为两类记录保存同一格式的
`Installation Dependency Snapshot`：

- 以 dependent Installation ID 为主键，采用不可变 revision 和 current pointer；
- 保存 dependent 的 Nexus node、record kind、game root 和 Dynamic Game Context；
- 保存每个 required dependency 的 Nexus node、直接或传递关系、版本约束，以及已解析到的本地 dependency Installation ID；
- 绑定 Evidence Pack、Bundle Manifest 与 frozen Download Plan 的 ID 和 hash；
- 使用 canonical JSON hash 校验每个 Snapshot；
- 标记 `complete` 或 `partial`，禁止把缺少 dependency-aware Bundle 的单 Archive 安装解释为“确定没有依赖”。

依赖边统一采用 `dependent -> dependency` 方向。Uninstall Planner 的正式入口对目标节点执行反向
dependent 查询；只要同一 game root 中仍有活动 Installation Snapshot 要求目标节点，就必须
拒绝卸载。规划和执行两个时点都会重新检查，避免 Plan 审批期间新增 dependent 后仍被执行。
卸载检查只读取冻结的本地事实，不在危险操作前临时查询 Nexus。

新增内部/本地 MCP 能力：

- `get_installation_dependency_snapshot(installationId)`：读取并校验快照，同时返回要求该节点的 dependent；
- `reconcile_installation_dependencies()`：从历史 Bundle Completion、V2 Plan、Evidence、
  Bundle Manifest 与 Download Plan 回填缺失快照；只写 Manager metadata，不改游戏；
- 每次新的 `apply_agentic_install_plan` 成功提交后自动捕获 Snapshot。若捕获失败，安装结果保持
  committed，但返回独立 warning，不能静默丢失卸载前置事实。

### M4 收尾：正式卸载入口与 Skill（2026-07-29）

普通文件事务型 Mod 的卸载闭环已从内部引擎提升为正式 MCP 工作流：

- `inspect_mod_uninstall(installationId)`：检查当前文件状态、活动 dependents 与阻塞原因；
- `plan_mod_uninstall(installationId)`：重新检查后冻结不可变 Uninstall Plan，不修改游戏；
- `get_mod_uninstall_plan(uninstallPlanId)`：读取精确动作、retained paths、revision、hash 与 expiry；
- `apply_mod_uninstall(uninstallPlanId)`：仅接受已展示的 Plan ID，并在执行前再次检查 dependents；
- `verify_mod_uninstall(installationId)`：验证 Record 终态、owned files 删除结果和 backup 恢复结果。

独立 `uninstall-game-mods` Skill 固定为
resolve Installation ID → inspect → plan → read exact Plan → explicit approval → apply → verify。
Skill 不处理手工安装、Vortex/untracked Mod、受控安装器、Loader/runtime 或级联卸载，也禁止使用
shell 删除绕过事务引擎。

真实 2697 运行后会在原两文件 `exclusive_tree` 中生成 `config.json`。State Inspector 现按
`install_tree` 的实际 owned file set 逐项核验：owned file 未变化而仅出现额外文件时归类为
`unmanaged_extra` 并保留；owned DLL/manifest 的缺失或修改仍按原规则报告并在需要时阻塞。

真实卸载复盘后补充两项状态契约：

- Uninstall Plan 保持不可变，原 `status: planned` 明确定义为创建状态；当前生命周期由 TTL、
  Installation Record 与最新匹配 Transaction Journal 派生为
  `planned/stale/applying/committed/failed/recovery_required`，不会因重写 Plan 而破坏 hash；
- State Inspection、Uninstall Plan、apply result 与 verify result 均返回精确
  `retainedFilePaths`。父目录仍通过 `retainedPaths` 报告，运行时生成的 `config.json` 等文件
  不再只显示为一个模糊目录。

`prepare_install_evidence` 也改为从 frozen Download Plan 的真实 edge closure 生成 dependencies，
不再仅使用 Bundle `installOrder` 的前缀。因此通过 `satisfiedNodeIds` 复用的 SMAPI 等依赖仍会进入
Evidence 和后续 Snapshot。

定向测试覆盖：

- 直接与传递依赖闭包；
- Snapshot hash、不可变 revision、current pointer 与反向 dependent 查询；
- 单 Archive 的 partial Snapshot；
- MCP 工具发布；
- 原有 Contract V1/V2、下载、受控安装器和学习复用回归。

### M4 收尾：无歧义下载与 Portable Tool（2026-07-28）

Download Plan 继续作为文件选择、依赖闭包、Bundle 和审计的强制机器契约，但不再等同于每次都要
单独人工批准。`download-nexus-mods` 将 Plan 分为：

- `auto_safe`：准确 Mod、无歧义 active MAIN、无结构 blocker，且没有超出明确安装/前置依赖授权的文件；
- `review_required`：存在版本、平台、Loader、额外文件、非 MAIN 文件、手工依赖或其他实质选择；
- `blocked`：依赖环、遍历截断、不可用节点、缺少证明等结构问题，人工同意也不能绕过。

`plan_mod_download` 接收由明确用户意图推导的
`authorizationScope=root_only | root_and_required_dependencies`，并由 MCP 返回确定性的
`review.classification` 和 reasons；Skill 只能服从该结果，不能自行把
`review_required` 降级成 `auto_safe`。

因此“下载并安装一个无依赖、唯一 MAIN 文件的准确 Mod”会保留完整 Download Plan 校验，但不再浪费
一个“批准下载”回合。Install Plan 的目标写入/执行审批边界本次不变。

Package Analyzer 升级为 `package-analyzer@4`。当安全 ZIP 没有受支持 Manifest、没有安装器信号，
并且恰好只有一个 `.exe` 时，Analyzer 生成有证据约束的 `self-contained-folder` Package Unit：

- 单文件根目录使用 `packageRoot="."`；
- `query_install_methods` 返回 `construct_agent_file_proposal`，不再以 `PACKAGE_UNIT_MISSING` 停止；
- 只允许通过 `install_tree` 部署完整 Archive，安装过程不得运行 EXE；
- 作者文档仍必须证明目标位置，实际游戏内容目录继续保持 protected；
- 学习到的 Method 额外绑定 portable entry 文件名，避免对同一游戏所有未知文件包过度泛化。

真实 Tarnished Tool 9277/fileId 48456 Archive 已通过只读验收：Analyzer 从唯一
`TarnishedTool.exe` 生成 `self-contained-folder`、`packageRoot="."` 和确定性 Package Unit。
沙箱端到端验收进一步证明该 Unit 能冻结为 `install_tree`、部署到全新独占目录、完成静态校验和
Installation Record，同时没有执行 payload。

### M4 收尾：Root-overlay 文件映射（2026-07-28）

`package-analyzer@5` 为以下安全 ZIP 生成 `root-overlay` Package Unit：

- 没有受支持的 Manifest；
- 没有受支持的安装器；
- 没有便携 EXE 候选；
- 至少包含一个普通文件。

该 Unit 使用 `packageRoot="."`，只证明完整 Archive 是一个可选择、受 Evidence 约束的源文件树，不证明目标根目录。Analyzer 保留 `unknown-package-type` ambiguity，要求 Agent 通过作者说明和 Dynamic Game Context 证明每个映射。

V2 文件 Proposal 和冻结桥现支持：

- `ensure_directory`：保证目录存在；已存在的共享目录不被重新创建或声明所有权；
- `install_new_file`：只写入不存在的目标，记录精确文件所有权；
- `replace_file`：只替换已存在的普通文件，必须是 high-risk Proposal，并保存可验证 preimage backup；
- `install_tree`：继续只用于一个完整源树到全新目录，不用于合并共享目录。

所有源文件必须精确存在于 Evidence inventory 且位于所选 Package Unit。所有目标逐项通过 writable/protected root 校验；目标父目录必须已存在，或由更早的 `ensure_directory` 操作创建。冻结阶段读取现有 Installation Records，拒绝替换其他受管安装拥有的路径。

静态验证把 `ensure_directory` 解释为“目录仍存在”，而不要求其内容永久为空；实际文件仍由各自的 file operation outcome 负责验证和卸载。成功的多文件 Agent Proposal 会学习为一个多操作 Method。对 `root-overlay`，Method 同时绑定游戏身份、Package 类型、完整源路径信号和 Nexus Mod source identity，避免无关文件树误复用。

真实归档验收使用 Nexus `eldenring:117` 与 `eldenring:4177`：

1. Elden Mod Loader 生成 `root-overlay`，冻结为一个目录保证和两个新文件操作；
2. Free Lock-On Camera 生成 `root-overlay`，在共享 `Game/mods` 下冻结为两个目录保证和三个新文件操作；
3. 两个事务均通过静态验证并产生 `local_verified` Method；
4. Loader 的多操作 Method 在第二个临时游戏实例中通过 fresh Evidence、Context、Plan 和审批链成功复用。

每个里程碑完成后单独提交和验收。M4 通过后，V1 规划层代码才能正式标记为退役。
