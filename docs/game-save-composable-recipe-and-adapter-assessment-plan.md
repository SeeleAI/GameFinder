# 游戏存档能力泛化、组合式 Recipe 与 Adapter 智能评估开发计划

> Historical document. Its runtime architecture is superseded by [Remove the save Recipe system](remove-save-recipe-system-plan.md). Use the current skill and server README for supported tools.

> 状态：G0–G7 已完成；Ghost of Tsushima 真实纵向验收通过，原 baseline 已恢复
>
> 固定日期：2026-08-19
>
> 目标仓库：`GameFinder`
>
> 目标平台：Windows
>
> 相关既有基线：[`game-save-skill-development-plan.md`](./game-save-skill-development-plan.md)
>
> 第二个真实纵向验收：RUNE 环境下的 `Ghost of Tsushima DIRECTOR'S CUT`

### 实施进度（2026-08-20）

- **G0 已完成**：在独立分支 `codex/save-recipe-generalization` 冻结 V1/Elden Ring 回归基线；新增两个只靠 JSON 声明、共享 `rune-steam-emulator + documents-product-account-subdir + slot-file-set` 的合成游戏 Fixture。
- **G1 已完成**：新增 V2 Resolver/Location/Layout/Recipe/Install Context/Save Context/Standard Save Package/Adapter Assessment/Development Brief 合同及哈希函数；新增 hash-addressed immutable Recipe Store。
- **内置 Recipe 已数据化**：Elden Ring 与 Ghost of Tsushima 使用构建时复制的 JSON Recipe；新增同类游戏无需修改 Recipe Registry TypeScript。
- **安全负向测试已建立**：拒绝路径穿越模式；`undetermined` Adapter Assessment 不能放行 Replacement Plan；数字账户语义仍需由后续 Resolver evidence 决定。
- **G2 已完成**：实现 `steam-library`、`rune-steam-emulator`、`manual-pe` Resolver、自动/显式选择 Registry、PE 版本身份读取和独立 V2 Install Context Store；公开 `probe_save_game_install` 已接受 `resolverHint`/`recipeId` 并可返回 RUNE/manual V2 Context。
- **账户语义已固定**：Steam manifest `LastOwner` 只作为 `steam_id64/probable` 线索；RUNE 显式非零 `AccountId` 只标记为 `emulator_account_id`；注释、缺省或零值不产生账户线索。
- **GOT-01 已完成**：真实只读探测识别 RUNE App ID `2215430`、GoT Recipe、EXE SHA-256 与 PE ProductName/FileVersion，Context hash 验证通过；未读取或写入实际存档。
- **G0–G2 回归结果**：TypeScript check/build 通过；39 个测试文件通过、3 个按配置跳过；228 项测试通过、20 项按配置跳过；stdio smoke 通过（99 tools，未启动浏览器）。
- **兼容桥接**：Steam 继续返回 V1 Context 以保持 Elden Ring M0–M6 链路不回退；RUNE/manual 使用 V2 权威 Context，并生成同 ID 的最小 V1 事务投影以复用既有 backup/restore safety kernel。投影不作为新的游戏知识来源。
- **G3 已完成**：实现 Windows Known Folder/平台候选 Location Strategy、Recipe 驱动的唯一根选择、V2 Save Context Store、Recipe-scoped 有界差分 fallback 与 machine/probe-scoped `local_verified` Recipe record。
- **G4 已完成**：实现通用 Layout materializer、requiredAll/requiredAnyOf、受限通配、槽位索引、精确 managed path 冻结；通过 V2 权威对象 + 同 ID V1 事务投影复用既有 Backup/Restore 内核。
- **G5 已完成**：Inspector 改为 Recipe/unit/layout 驱动；Package V2 保留 source→target、unit、layout、binding 与 provenance；Compatibility V2 去除 `vanilla-main` 硬编码，并在账户证据未知时阻止 Replacement Plan。
- **真实验收**：GOT-01～GOT-12 已完成；Nexus Mod 834/File 2617 已完成下载、标准化、Adapter 验证、真实替换、离线运行时验证和 baseline 恢复。
- **能力边界**：GoT PC v49 只在 magic、版本、三个 PC marker、精确 content size 与 checksum 全部通过时允许 Adapter-backed exact replacement；其它版本或损坏样本保持阻塞。
- **G6 已完成**：实现操作级确定性评估、不可变 Assessment/Development Brief Store、三个 MCP 工具、Compatibility ID/hash 绑定与 Replacement Plan 门禁；备份和 exact restore 不要求 Adapter，`undetermined` 与 `required+missing` 阻止真实替换。
- **GOT-08/09 已完成**：真实 GoT 样本的静态结构、长度字段和账户标识常见编码扫描已冻结为证据；结果仍为 `undetermined`，没有把“未发现明文账户 ID”误判为可直替，真实 save root 未写入。
- **G7 已完成**：实现并注册 `ghost-of-tsushima-pc-v49@1.0.0` 验证 Adapter、V2 Compatibility→V1 安全事务桥和非硬编码 Save Unit replacement；真实导入可见、可载入、可游玩，随后原 baseline 成功恢复并由用户确认。

## 0. 文档目的

现有 M0–M6 已经证明了以下安全基础可以工作：

- 从可信游戏安装身份建立不可变 Game Install Context；
- 从可信存档位置建立精确 Save Context；
- 创建内容寻址、可验证的备份；
- 生成不可变 Restore/Replacement Plan；
- 在真实写入前创建 rescue backup；
- 对写入执行进程守卫、prestate 校验、原子发布、post-state 校验和回滚；
- 对 Elden Ring 执行 SteamID64 重绑定、槽位导入和校验和更新；
- 将静态验证与用户离线运行时验证分离。

但现有实现把四类不同知识集中在一个 `GameSaveProfile` 中：

1. Steam 安装识别经验；
2. 游戏存档位置经验；
3. 存档文件布局经验；
4. Elden Ring 专属二进制格式知识。

结果是：只要换一个游戏或非 Steam 安装环境，整个受管链路就不可达；即使新游戏只是常见的 `auto.sav + manual_*.sav` 文件集合，也容易被误判为需要开发游戏专属 Adapter。

本计划固定下一阶段的泛化方案：

> 将平台/发行方式、位置策略、存档布局、游戏少量事实和二进制 Adapter 分层；相同平台或相同存档风格复用代码，新增同类游戏时只增加或自动学习声明式 Recipe 数据。

## 1. 固定架构决策

以下决策作为实现基线，不在开发过程中随意改变。

1. **Steam 和 RUNE 是安装/发行环境，不是存档格式。** Resolver 负责提供安装身份、App ID、账户线索和平台候选根；不能假设所有同平台游戏使用同一个存档位置。
2. **存档位置与文件布局分离。** `Documents`、`AppData`、`Saved Games`、Steam userdata、RUNE 数据目录属于位置策略；`single-file`、`slot-file-set`、容器和目录树属于布局族。
3. **新增同类游戏不开发 TypeScript。** 游戏名、EXE、App ID、目录别名、Nexus slug 等事实存放在声明式 `GameSaveRecipe` 中。
4. **Recipe 可以内置、导入或本机学习。** 没有内置 Recipe 时，允许由平台 Resolver 和有界差分探测生成 `local_verified` Recipe，不要求先开发新代码。
5. **Profile/Recipe 中的模式不能直接成为写权限。** 创建 Save Context 时必须把模式物化为精确、冻结、已验证的文件列表；备份、恢复和替换只操作冻结后的路径。
6. **数字账户目录不等于 SteamID64。** 只有 Steam manifest、受信 Adapter 或其它明确证据可以建立 `steam_id64` 语义；RUNE 或未知环境中的数字目录默认是 `emulator_account_id`、`opaque_directory_key` 或 `unknown`。
7. **Adapter 是否需要是操作级判断，不是游戏级布尔值。** 同一个游戏的原样备份/恢复可能不需要 Adapter，跨账户槽位导入却可能必须使用 Adapter。
8. **先判断能力缺口属于哪一层。** 安装身份失败应提示 Resolver/Recipe；位置失败应提示 Location Strategy；文件模式失败应提示 Layout Family；只有二进制内部转换缺失才提示专属 Format Adapter。
9. **证据不足不降级为通用直替。** 账户绑定、校验和、版本迁移或容器结构无法证明时返回 `undetermined` 并阻止真实写入。
10. **通用备份/原样恢复不解析游戏二进制。** 只要 Game/Save Context 与精确文件集合可信，备份和恢复可以把存档视为不透明字节。
11. **外部存档标准化不等于兼容。** Standard Save Package 只保证来源、路径、字节和清单可信；Adapter Requirement Assessment 与 Compatibility Assessment 决定能否导入。
12. **既有 Elden Ring 验收不能回退。** V1 不可变记录继续可读；Elden Ring 迁移到组合式 Recipe 后，原有 Adapter、Plan、rescue 和 baseline 语义保持不变。
13. **真实验收最终恢复原 baseline。** 除非用户明确选择保留导入结果，否则 Ghost of Tsushima 验收结束后恢复原存档并验证精确哈希。

## 2. 目标与非目标

### 2.1 目标

- 由一个游戏根目录自动识别 Steam、RUNE 或普通手动安装环境。
- 从平台经验、Windows Known Folders 和游戏身份生成有界存档候选根。
- 对没有内置 Recipe 的游戏执行安全的差分探测，并持久化本机验证知识。
- 用通用 Layout Family 描述相同类型的存档文件集合。
- 新增使用既有 Resolver、Location Strategy 和 Layout Family 的游戏时，只增加 JSON/YAML Recipe 或学习记录。
- 让手动输入和下载输入都由目标 Recipe/Layout 驱动识别，而不是全局硬编码 `ER0000.sl2`。
- 让 Standard Save Package 保留 Recipe、Layout、Save Unit 和绑定证据。
- 自动判断通用能力是否足够、是否建议使用 Adapter、是否必须使用 Adapter、证据是否不足。
- 当 Adapter 必需但缺失时，自动生成可执行的 Adapter Development Brief。
- 对 Ghost of Tsushima 完成 RUNE 安装识别、存档发现、备份、恢复、在线调研下载、标准化、兼容性/Adapter 判断、导入、运行时验证和 baseline 恢复。
- 保留现有所有事务、安全和凭证边界。

### 2.2 非目标

- 不承诺仅凭 EXE 名称无条件识别任意 Windows 游戏。
- 不把 RUNE 数据根误当成所有 RUNE 游戏的真实存档根。
- 不扫描整个磁盘或无界读取用户文件。
- 不从文件扩展名推断游戏身份、账户兼容性或在线安全性。
- 不自动逆向未知加密、签名或专有容器。
- 不允许 Agent 通过任意路径参数跳过 Context、Plan、rescue 或 process guard。
- 不控制 Steam Cloud、RUNE 配置、反作弊或平台登录。
- 不把一次成功运行时验证无限推广到所有版本、账户和来源。
- 不删除已有备份、V1 Context、V1 Plan 或历史验收记录。

## 3. 分层模型

```text
Game Root
   |
   v
DistributionResolver
   |  安装身份、发行环境、App ID、账户线索、平台候选根
   v
Game Install Context V2
   |
   +--> GameSaveRecipeStore
   |       游戏少量事实、组合声明、来源 slug
   |
   v
SaveLocationStrategy[]
   |  静态候选 + 有界差分探测
   v
SaveLayoutFamily
   |  将模式物化为精确 Save Unit 文件
   v
Save Context V2
   |
   +--> Backup / Restore（通用、不透明字节）
   |
   +--> Standard Save Package V2
             |
             v
   Adapter Requirement Assessment
             |
      +------+---------------------+
      |                            |
  通用能力足够                 需要二进制转换
      |                            |
  Generic Replacement        FormatAdapter
      |                            |
      +------------+---------------+
                   v
       Immutable Plan / Rescue / Apply / Verify
```

## 4. 核心组件

### 4.1 DistributionResolver

职责：从用户给出的绝对游戏根目录建立可信安装身份，不负责决定最终存档路径。

统一输出至少包含：

- `resolverId` 和版本；
- `distributionKind`；
- 游戏根目录及指纹；
- 产品身份和稳定 canonical ID；
- 平台 App ID（如果存在）；
- EXE/PE 证据；
- 安装版本证据；
- 账户线索及其语义和置信度；
- 平台专属候选根；
- 已知进程与 lock-sensitive 进程；
- evidence list、confidence 和 context hash。

第一阶段实现三个 Resolver。

#### 4.1.1 `steam-library`

识别证据：

- `steamapps` 目录；
- 匹配的 `appmanifest_<appid>.acf`；
- `installdir` 与给定 game root 的边界关系；
- build ID；
- `LastOwner`；
- Recipe 声明的 EXE/PE anchor；
- 对应 Steam userdata 候选根。

安全约束：

- manifest 与 game root 必须确切匹配；
- `LastOwner` 只能作为账户线索，不能单独选择歧义存档；
- 不把 Steam Cloud 路径等同于实际存档路径。

#### 4.1.2 `rune-steam-emulator`

识别证据：

- `steam_api64.rne` 或其它固定 RUNE anchor；
- `steam_emu.ini`；
- `AppId`；
- 显式配置的 AccountId（如果存在）；
- Recipe 声明的主 EXE；
- PE ProductName、FileDescription、版本和文件哈希；
- RUNE 平台数据候选根。

安全约束：

- 只解析安装身份需要的非秘密字段，不收集或输出凭证；
- 注释、缺省值或随机 AccountId 不升级为真实 SteamID64；
- `distributionKind` 与官方 Steam 安装区分记录；
- RUNE 数据目录只是候选根，游戏原生 Documents/AppData 路径仍须参与发现；
- 不因 RUNE 环境自动关闭或要求关闭无关的 `steam.exe`，process guard 由实际 Recipe/Context 决定。

#### 4.1.3 `manual-pe`

当无 Steam manifest 且不匹配已知发行环境时使用：

- 需要内置/导入 Recipe 或用户选择的候选游戏身份；
- 验证主 EXE、PE ProductName/FileDescription、版本和哈希；
- 不允许仅凭用户提供的游戏名称创建 `confirmed` Context；
- 身份冲突或多个 Recipe 同时匹配时返回歧义。

### 4.2 SaveLocationStrategy

位置策略接收 Install Context、Recipe、Windows 环境和账户线索，输出候选 Save Root 及证据，不输出写权限。

第一阶段策略库：

- `steam-userdata-appid`；
- `rune-public-documents-appid`；
- `documents-product-name`；
- `documents-product-account-subdir`；
- `saved-games-product-name`；
- `appdata-roaming-product-name`；
- `appdata-local-product-name`；
- `appdata-locallow-publisher-product`；
- `game-root-save-directory`；
- `bounded-differential-probe`。

统一模板变量：

```text
{USERPROFILE}
{DOCUMENTS}
{SAVED_GAMES}
{APPDATA}
{LOCALAPPDATA}
{LOCALLOW}
{PUBLIC_DOCUMENTS}
{PLATFORM_APP_ID}
{ACCOUNT_DIRECTORY}
{PRODUCT_NAME}
{PUBLISHER_NAME}
```

位置策略必须返回：

- 候选绝对路径；
- 使用的模板与变量；
- 根边界；
- 账户目录语义；
- 文件系统证据；
- 是否需要差分探测；
- 歧义原因。

### 4.3 SaveLayoutFamily

布局族只描述路径和文件集合，不理解游戏二进制内容。

#### 4.3.1 `single-file`

一个固定或受限模式文件构成完整 Save Unit。

#### 4.3.2 `slot-file-set`

自动存档和多个独立槽位文件构成 Save Unit。

支持：

- 固定文件；
- 受限通配模式；
- 槽位索引提取；
- `requiredAll`；
- `requiredAnyOf`；
- companion/auxiliary 模式；
- 最大匹配数；
- 单层或固定深度约束；
- 源槽位到目标槽位的显式映射。

模式只在 Context 创建/刷新时执行。物化结果必须是排序后的精确相对路径列表，写入阶段禁止重新展开 glob。

#### 4.3.3 `container-with-companions`

一个主容器加备份、索引或云标记文件。Elden Ring Recipe 迁移到此布局族，二进制槽位操作仍由专属 Adapter 提供。

#### 4.3.4 `directory-tree`

整个受限目录树构成 Save Unit。必须设最大深度、最大文件数、最大总大小和 reparse point 阻断。

#### 4.3.5 `profile-plus-slots`

全局 Profile/索引文件加多个槽位文件；用于不能把 Profile 文件遗漏的游戏。

### 4.4 GameSaveRecipe

Recipe 是数据对象，不是新的 service 或 Adapter。

建议 V2 结构：

```json
{
  "schemaVersion": 2,
  "recipeId": "ghost-of-tsushima-directors-cut-windows",
  "recipeVersion": "1.0.0",
  "trust": "built-in | imported | local_verified",
  "game": {
    "canonicalId": "ghost-of-tsushima-directors-cut",
    "displayName": "Ghost of Tsushima DIRECTOR'S CUT",
    "aliases": [],
    "platformAppIds": { "steam": "2215430" }
  },
  "identity": {
    "executableAnchors": ["GhostOfTsushima.exe"],
    "productNames": ["Ghost of Tsushima DIRECTOR'S CUT"]
  },
  "installResolvers": [
    "steam-library",
    "rune-steam-emulator",
    "manual-pe"
  ],
  "locationStrategies": [
    {
      "strategyId": "documents-product-account-subdir",
      "parameters": {
        "productDirectory": "Ghost of Tsushima DIRECTOR'S CUT",
        "accountDirectoryPattern": "^\\d{17}$"
      }
    }
  ],
  "saveUnits": [
    {
      "unitId": "main-saves",
      "layoutFamily": "slot-file-set",
      "requiredAnyOf": ["auto.sav", "manual_*.sav"],
      "managedPatterns": ["auto.sav", "manual_*.sav"],
      "maximumMatches": 100
    }
  ],
  "binding": {
    "policy": "unknown",
    "evidenceScope": null
  },
  "runtime": {
    "processNames": ["GhostOfTsushima.exe"],
    "lockSensitiveProcessNames": ["GhostOfTsushima.exe"]
  },
  "sources": {
    "nexusDomainName": "ghostoftsushima",
    "speedrunGameSlug": null
  }
}
```

Recipe 必须带内容哈希、来源证据、创建/验证时间和适用范围。内置 Recipe 通过代码评审；导入 Recipe 保留来源；学习 Recipe 绑定本机游戏根指纹与 Windows 用户身份哈希。

### 4.5 Save Context V2

Save Context 继续作为所有后续操作的唯一受信入口，并增加：

- `recipeId`、`recipeVersion`、`recipeHash`；
- `resolverId`、`resolverVersion`；
- `distributionKind`；
- 通用 `accountIdentity`，不再只有 `steam_id64`；
- 每个 Save Unit 的 `layoutFamily`；
- 从模式物化的精确路径及各自角色；
- 物化时的目录树哈希；
- 位置策略和布局分类证据；
- Context 有效范围和刷新条件。

账户类型至少包括：

```text
steam_id64
emulator_account_id
platform_account_id
opaque_directory_key
unknown
none
```

### 4.6 Standard Save Package V2

当前 Package 丢失 `unitId`，使 Compatibility Assessor 只能硬编码查找 `vanilla-main`。V2 必须保留：

- `recipeId`、`recipeVersion` 和 Recipe identity hash；
- `game.canonicalId`；
- `unitId`；
- `layoutFamily`；
- 原始 source path 到标准化 relative path 的映射；
- 槽位身份（如果布局族能从文件名可靠得到）；
- 账户绑定类型、值、证据来源和置信度；
- 格式签名、大小分布和其它非破坏性结构证据；
- 下载/手动来源、作者声明和原始字节哈希；
- 安全检查、警告和 manifest hash。

标准化不得自行修改账户、校验和、槽位索引或游戏二进制。

## 5. Recipe 获取与学习

Recipe Store 支持三类来源。

### 5.1 `built-in`

仓库评审过的稳定数据。Elden Ring 和 Ghost of Tsushima 的首个验收 Recipe 属于此类。

### 5.2 `imported`

从可追溯目录数据或研究结果导入。导入器必须：

- 保留来源、版本、许可证/使用约束和内容哈希；
- 只转换路径/布局事实，不把外部“可兼容”声明升级为已验证事实；
- 对超出当前策略能力的条目保留为 unresolved；
- 不直接授权写入。

后续可以接入 Ludusavi manifest 等知识源，但不是本阶段完成 Ghost of Tsushima 验收的硬依赖。

### 5.3 `local_verified`

当没有 Recipe 或静态规则失效时，由有界差分探测生成：

1. Resolver 先确认游戏安装身份；
2. 平台和 Windows 策略提供受限 observation scopes；
3. 用户启动游戏并执行一次最小保存；
4. 系统只比较探测窗口内的变化；
5. 唯一根、唯一布局且未截断时生成 learned Recipe；
6. Recipe 绑定 game root fingerprint、Windows user identity hash、resolver evidence 和 probe hash；
7. 后续成功备份/恢复或运行时验证可以追加 scoped evidence，但不改写旧记录。

### 5.4 有界探测策略

当前 skill 中“没有已注册 Profile 就不能开始探测”的限制需要调整为：

> 探测根可以由受信 Game Recipe 提供，也可以由已确认的 DistributionResolver 加内置 Windows Root Scope Policy 提供。

通用探测必须：

- 只覆盖 Documents、Saved Games、AppData、LocalLow、平台 App ID 根等明确 scope；
- 设置最大根数、深度、条目数、总字节和超时；
- 拒绝 reparse point；
- 默认只读取元数据；仅对探测窗口内变化且满足大小限制的候选计算哈希；
- 不将其它应用同时产生的变化自动归属目标游戏；
- 多个候选根时报告歧义，不按修改时间擅自选择；
- 记录所有被截断和排除的 scope。

## 6. 通用输入识别与标准化

### 6.1 手动输入

`inspect_save_input` V2 必须接收：

- `inputPath`；
- `saveContextId` 或 `recipeId` 二选一；
- 可选目标 `unitId`。

不再由全局函数寻找 `ER0000.sl2`。Inspector 使用 Recipe/Layout Family：

- 安全清点文件、目录、ZIP、RAR、7z；
- 剥离唯一包装目录；
- 将候选与 unit 的模式匹配；
- 输出所有无歧义/有歧义 payload candidate；
- 冻结 source path 到 package relative path 映射；
- 不识别的文件保留为 excluded evidence，不静默加入 payload。

### 6.2 下载输入

Source Snapshot、Candidate 和 Download Receipt 必须保留 `installContextId`、`recipeId` 或等价不可变 Recipe binding。`inspect_downloaded_save` 从 Receipt 继承身份和布局，不要求 Agent 再猜游戏。

### 6.3 布局族识别与游戏 Adapter 的边界

- 文件名、相对路径、槽位编号和精确集合由 Layout Family 处理；
- 文件内部账户 ID、校验和、容器索引、加密和版本迁移由 Format Adapter 处理；
- Layout Family 不能把“没有发现账户 ID”解释为“没有账户绑定”。

## 7. Adapter Requirement Assessment

### 7.1 判断必须针对具体操作

输入至少包含：

- `saveContextId`；
- 可选 `packageId`；
- `intendedOperation`；
- 可选源/目标槽位选择；
- 当前 Recipe、Layout、binding 和 format evidence。

操作类型至少包括：

```text
backup
restore-exact-bytes
replace-whole-unit
import-slot-file
import-container-slot
cross-account-import
version-conversion
```

### 7.2 评估结果

```text
requirement:
  not_required
  recommended
  required
  undetermined

adapterAvailability:
  matched
  missing
  not_applicable

extensionTarget:
  none
  distribution-resolver
  location-strategy
  layout-family
  game-recipe
  format-adapter
```

评估还必须返回：

- `reasonCodes`；
- `genericCapabilitiesSatisfied`；
- `missingCapabilities`；
- 使用的证据及可信等级；
- 适用的游戏/版本/账户/来源 scope；
- 是否允许进入 Compatibility Assessment；
- 是否允许冻结 Replacement Plan；
- `nextAction`；
- assessment hash 和时间。

### 7.3 固定判断规则

#### `not_required`

满足以下情形之一：

- 对已确认 Save Context 做原样备份；
- 从可信 Backup 做同一文件集合的原样恢复；
- 游戏身份、Recipe、unit、layout、format 和账户兼容性均有证据匹配，且只需一对一完整文件替换；
- Recipe/受信验收证明账户仅由外部目录决定，文件内部无需转换。

#### `recommended`

通用整文件/整容器替换可安全完成，但影响范围比用户目标大，例如：

- 为导入一个角色需要覆盖包含多个角色的完整容器；
- 通用替换会覆盖其它槽位，而已有或可开发 Adapter 能只改目标槽位；
- 通用方案可回滚但无法提供更细粒度静态验证。

`recommended` 不阻止用户明确授权的通用方案，但 Plan 必须展示扩大后的真实影响范围。

#### `required`

存在至少一项已证实的内部转换需求：

- 嵌入账户身份需要重绑定；
- 账户/槽位变化后必须更新内部校验和、签名或索引；
- 一个容器中只应导入部分槽位；
- 源/目标布局必须通过专有结构转换；
- 存档版本必须迁移；
- 专有压缩/加密必须安全解析并重建；
- 通用替换已被 scoped runtime evidence 证明不可用，且失败原因指向内部格式。

#### `undetermined`

- 账户绑定未知；
- 校验和/签名未知；
- 文件大小或结构明显不同但没有版本证据；
- 只凭扩展名、作者说明或单次静态观察无法证明兼容；
- 已知 Adapter 的支持范围与当前 build/format 不匹配。

`undetermined` 必须阻止真实 Replacement Plan，但不阻止只读调研、标准化、备份或沙箱分析。

### 7.4 证据等级

从高到低：

1. 当前 build/format 范围内的受信 Adapter 合同；
2. 内置 Recipe 的已验证 binding/format policy；
3. 绑定具体版本、账户关系和来源类型的不可变运行时验收记录；
4. 多份真实样本的结构和差分证据；
5. 文件签名、magic、长度、账户字节和校验和等静态证据；
6. 作者/社区说明，仅作为 claim；
7. 文件名和扩展名，不得单独证明兼容。

找不到可见账户 ID 不能证明不存在绑定；一次同账户成功不能证明跨账户可用；一次 build 成功不能无限推广到未来 build。

### 7.5 Adapter Development Brief

当 `requirement=required` 且 `adapterAvailability=missing` 时，生成不可变 Brief：

- 游戏、平台、build 和 Recipe identity；
- intended operation；
- source/target manifest 与哈希；
- 触发 `required` 的 reason codes；
- 缺失 capability；
- 已知结构证据和未知项；
- 可用本机 fixture 的安全路径引用；
- 禁止改动的 byte ranges/文件/槽位（如果已知）；
- 必须实现的 parse/transform/verify 能力；
- 单元测试、故障注入和真实验收要求；
- baseline 恢复要求。

Brief 只提示开发，不自动生成或执行未经验证的二进制修改逻辑。

## 8. Compatibility Assessment V2

Compatibility Assessor 必须去除以下硬编码：

- 固定查找 `vanilla-main`；
- 只有 `steam_id64` 才能判定账户；
- 所有非 Elden Ring 未知绑定都落入同一分支；
- `adapterHint === context.adapterId` 即代表兼容。

新的判断顺序：

1. 验证 Package 与 Save Context 的游戏 canonical identity；
2. 根据 Package `unitId` 选择目标 Save Unit；
3. 验证 Layout Family 与精确 source-to-target mapping；
4. 验证所有目标都在 materialized managed paths 内；
5. 验证 required file/requiredAnyOf 规则；
6. 评估账户关系；
7. 调用 Adapter Requirement Assessment；
8. 只有 `not_required` 或用户明确接受影响范围的 `recommended` 才能进入通用 Replacement Planning；
9. `required+matched` 路由到 Adapter workflow；
10. `required+missing` 返回 Development Brief；
11. `undetermined` 返回阻塞原因和所需证据。

## 9. MCP 工具调整

### 9.1 保留并扩展现有工具

- `probe_save_game_install`
  - 新增可选 `recipeId`、`resolverHint`；
  - 默认自动匹配 Resolver；
  - 不再固定要求 Steam appmanifest。
- `resolve_save_locations`
  - 使用 Recipe + Location Strategy + Layout Family；
  - 输出 materialized Save Context V2。
- `begin_save_location_probe`
  - 允许由 Resolver + Windows Root Scope Policy 提供有界根；
  - 不再硬要求预注册游戏 Profile。
- `inspect_save_input`
  - 新增 `saveContextId | recipeId` 与可选 `unitId`。
- `inspect_downloaded_save`
  - 从 Receipt/Candidate 继承 Recipe binding。
- `normalize_save_package` / `normalize_downloaded_save_package`
  - 输出 Standard Save Package V2。
- `assess_save_package_compatibility`
  - 内部调用 Adapter Requirement Assessment。

### 9.2 新增只读/本地状态工具

- `list_save_distribution_resolvers`
- `list_save_location_strategies`
- `list_save_layout_families`
- `list_game_save_recipes`
- `get_game_save_recipe`
- `assess_save_adapter_requirement`
- `get_save_adapter_requirement_assessment`
- `get_save_adapter_development_brief`

是否暴露 Recipe promotion 工具留到 learned Recipe 实现阶段评审；首版可以只自动保存 `local_verified`，不允许 Agent 将其直接升级为仓库全局内置知识。

### 9.3 错误与 nextAction

新增/细化错误：

```text
SAVE_INSTALL_RESOLVER_NOT_FOUND
SAVE_INSTALL_IDENTITY_AMBIGUOUS
SAVE_RECIPE_NOT_FOUND
SAVE_RECIPE_AMBIGUOUS
SAVE_LOCATION_STRATEGY_EXHAUSTED
SAVE_LAYOUT_NOT_RECOGNIZED
SAVE_LAYOUT_AMBIGUOUS
SAVE_ACCOUNT_BINDING_UNDETERMINED
SAVE_ADAPTER_REQUIRED
SAVE_ADAPTER_SCOPE_MISMATCH
SAVE_ADAPTER_DEVELOPMENT_REQUIRED
```

每个错误必须把 nextAction 指向正确层级，不能统一提示“开发游戏 Adapter”。

## 10. Skill 调整

`skills/manage-game-saves` 需要同步以下工作流变化：

1. 开始时不再要求一定存在 built-in Game Profile；先运行安装 Resolver。
2. 没有 Recipe 时允许进入有界学习流程。
3. 明确区分 resolver、location、layout、recipe 和 adapter 缺口。
4. 手动输入必须绑定 Save Context/Recipe 后才能识别。
5. 标准化后先检查 Adapter Requirement Assessment，再检查 Compatibility。
6. `undetermined` 时说明缺失证据并停止真实写入，不擅自试拷贝。
7. `required+missing` 时展示 Development Brief，并提示用户另行发起 Adapter 开发任务。
8. `recommended` 时展示通用方案的扩大影响范围；只有用户请求与选择覆盖该范围时才能继续。
9. 保持 backup、rescue、process guard、immutable Plan、rollback 和 runtime verification 规则不变。

## 11. V1 迁移与兼容

### 11.1 合同版本

- 新对象写入 `schemaVersion: 2`；
- V1 parser 和验证路径继续保留；
- 不就地修改任何 V1 Context、Package、Backup、Plan 或 Record；
- Store 使用版本联合 schema 读取旧对象；
- V2 操作引用 V1 对象时必须通过显式转换/桥接记录，不能静默改写。

### 11.2 Elden Ring 迁移

现有 Elden Ring Profile 拆为：

- Resolver：`steam-library`；
- Location Strategy：`appdata-roaming-product-account-subdir`；
- Layout Family：`container-with-companions`；
- Recipe：Elden Ring Windows/Steam 游戏事实；
- Format Adapter：现有 `elden-ring-steam-pc`。

必须继续通过：

- 原 Steam install resolver 测试；
- `ER0000.sl2`、`.bak`、`steam_autocloud.vdf` 发现；
- RAR/7z/ZIP 标准化；
- 同账户完整替换评估；
- 跨账户槽位 Adapter Requirement=`required+matched`；
- 槽位 staging 与允许 byte range 校验；
- rescue、替换、运行时验证与 baseline 恢复。

### 11.3 工具兼容

- 尽量保留现有工具名；
- 新字段保持向后兼容；
- 必须变更的输入通过 V2 工具或明确 deprecation window 处理；
- stdio smoke 必须验证新旧合同都可枚举和调用。

## 12. Ghost of Tsushima 真实验收合同

### 12.1 固定环境

| 项目 | 值 |
|---|---|
| 游戏 | `Ghost of Tsushima DIRECTOR'S CUT` |
| Windows 游戏根目录 | `E:\Program Files (x86)\Ghost of Tsushima DIRECTORS CUT` |
| 主 EXE | `GhostOfTsushima.exe` |
| PE ProductName | `Ghost of Tsushima DIRECTOR'S CUT` |
| 已观察 FileVersion | `1053.7.0809.1937` |
| 已观察 EXE SHA-256 | `a8d5c9d6342b5a86cc6d1039c9ec9446b508e1b6722054de8968fa8018b95364` |
| 平台 App ID | `2215430` |
| 发行环境 | `rune-steam-emulator` |
| 存档父目录 | `C:\Users\64617\Documents\Ghost of Tsushima DIRECTOR'S CUT` |
| 已观察账户目录 | `76561197960271872` |
| 真实存档根 | `C:\Users\64617\Documents\Ghost of Tsushima DIRECTOR'S CUT\76561197960271872` |
| Nexus 游戏主页 | `https://www.nexusmods.com/games/ghostoftsushima` |

上述 EXE 版本、哈希、文件大小和存档哈希是 2026-08-19 的观察值。正式验收开始时重新记录，不把它们无限视为未来版本 allowlist。

### 12.2 当前 baseline 观察

| 文件 | 大小 | 2026-08-19 SHA-256 |
|---|---:|---|
| `auto.sav` | 312,206 B | `399794db2da048f5e16e49040814ccb930f004895f15d5aafad9097372dd84dc` |
| `manual_0000.sav` | 311,960 B | `79db0466bd8de4508e7aeaf1eae3623dd4f38988cf8b9da871ce24beac171b89` |

父目录中的日志和 `Screenshots` 不属于本验收 Save Unit，除非后续证据证明它们是恢复一致性所必需；不得因为位置相邻而自动纳入 managed paths。

### 12.3 验收步骤

#### GOT-01：RUNE 安装识别

- 不依赖 `steamapps` 或 appmanifest；
- Resolver 输出 `rune-steam-emulator`；
- App ID、EXE、PE ProductName 和根目录证据一致；
- 不把 emulator account 自动标记为真实 SteamID64；
- 创建并重新读取 hash-verified Game Install Context V2。

#### GOT-02：静态位置发现

- Recipe 使用 `documents-product-account-subdir`；
- 唯一确认当前账户目录；
- 不选择空的 RUNE local/remote 候选根；
- 发现真实 Documents 存档根；
- 无歧义时不要求用户重复运行差分探测。

#### GOT-03：Layout 物化

- 使用通用 `slot-file-set`；
- 匹配 `auto.sav` 与 `manual_*.sav`；
- Save Context 只保存精确物化路径；
- 账户语义为 emulator/opaque/unknown 中有证据支持的一种，而非 SteamID64；
- `GhostOfTsushima.exe` 被列为 lock-sensitive process。

#### GOT-04：baseline 备份

- 游戏进程停止；
- 创建 `acceptance_baseline` Backup；
- pre/post source snapshot 一致；
- 每个文件进入内容寻址对象库；
- Backup record、tree hash 和对象重新验证通过。

Adapter Requirement 对该操作必须为：

```text
backup -> not_required / not_applicable
```

#### GOT-05：沙箱恢复

- 从 baseline 创建 sandbox Restore Plan；
- 不写真实 save root；
- 恢复文件集合、大小和 SHA-256 与 baseline 一致；
- 验证 preserved/unmanaged 路径策略。

Adapter Requirement：

```text
restore-exact-bytes -> not_required / not_applicable
```

#### GOT-06：在线调研与下载

- 通过 GoT Recipe 的 Nexus slug 调研高完成度候选；
- 来源完成度、版本、DLC 和在线安全保持 author claim；
- 使用已修复的持久 Chromium 下载链路；
- 文本与 structuredContent 都保留可续接 `sessionId`；
- 下载生成并验证 Nexus receipt；
- 不暴露临时 URL、Cookie 或 Profile。

#### GOT-07：下载存档检查与标准化

- Receipt 自动绑定 GoT Recipe；
- `slot-file-set` 识别 `.sav` payload 和包装目录；
- 无关文件不进入 payload；
- Package V2 保留 unit、layout、binding evidence 和源到目标映射；
- 原下载字节不被修改；
- Package 完整重新验证。

#### GOT-08：Adapter Requirement Assessment

必须产生以下三种结果之一，并给出证据：

1. `not_required`：已证明目标 `.sav` 可用通用槽位文件替换；
2. `recommended`：完整替换可行，但专用 Adapter 可以减少影响范围；
3. `required` 或 `undetermined`：账户绑定、校验和、版本或内部结构需要处理/继续调研。

不得因为扩展名相同直接返回 `not_required`。

如果 `required+missing`：

- 自动生成 Adapter Development Brief；
- 暂停真实导入；
- 完成所需 Adapter 后重新生成 Assessment；
- 不复用旧 Assessment 或旧 Replacement Plan。

#### GOT-09：兼容性与目标映射

- Package 游戏、Recipe、unit 和 layout 与目标一致；
- 显示源 `.sav` 到目标 auto/manual 槽位的精确映射；
- 目标已占用且没有明确覆盖授权时返回 `review_required`；
- 未知 binding 返回阻塞；
- 不允许 Package 文件落到 materialized managed paths 之外。

#### GOT-10：真实 Replacement Plan 与应用

- 用户的导入请求已明确覆盖所选目标；
- 游戏和实际 lock-sensitive 平台进程停止；
- Plan 冻结源对象、目标 prestate、所有操作、预期 post-state、preserved paths、rescue unit、review 和 expiry；
- apply 前自动创建并验证 `pre_replacement_rescue`；
- prestate 漂移则停止并生成新 Plan；
- 原子应用；
- post-state 和 record 校验通过；
- 失败时自动按事务结果回滚，不静默换策略。

#### GOT-11：运行时验证

- 用户离线启动游戏；
- 验证目标存档可见、可载入；
- 进行一次正常自动保存后退出；
- 记录用户实际观察，不夸大为完成度或在线安全证明；
- 区分“应用后、首次启动前”的静态验证与“启动后”的运行时证据；若游戏正常自动保存导致哈希变化，记录 post-launch drift，不把它误判为原事务失败，也不为追求旧哈希再次覆盖用户的新状态。

#### GOT-12：baseline 恢复

- 默认恢复 GOT-04 baseline；
- 使用当前 post-play prestate 生成新的 Restore Plan；
- 创建并保留恢复前 rescue；
- 恢复并验证所有 baseline 文件哈希；
- 用户确认原存档可见；
- 最终记录 `original_restored` 或准确的实际结果；用户进入游戏确认后产生的正常自动保存作为新的 live state 保留。

## 13. 测试策略

### 13.1 Resolver 测试

- Steam manifest 正常、缺失、错配、越界安装目录；
- RUNE anchors 正常、配置缺失、App ID 冲突、注释 AccountId、随机账户；
- manual PE ProductName/Recipe 匹配和冲突；
- 同一根匹配多个 Resolver 时的优先级和歧义；
- 不泄露配置中的无关字段。

### 13.2 Location Strategy 测试

- Windows Known Folder 展开；
- Documents/AppData/LocalLow/Steam userdata/RUNE 根；
- 多账户目录；
- 数字目录不自动升级为 SteamID64；
- reparse point、越界、深度、文件数和截断；
- 多根同时有效时返回歧义。

### 13.3 Layout Family 测试

- single-file；
- `auto.sav + manual_*.sav`；
- 槽位编号提取；
- requiredAnyOf；
- 过量匹配；
- 大小写冲突；
- 包装目录；
- container-with-companions；
- directory-tree 边界；
- 模式物化后新增文件导致 Context stale，而不是自动扩大写入范围。

### 13.4 数据驱动复用验收

创建两个合成游戏 Fixture：

- 都使用同一个 Resolver；
- 都使用 `documents-product-account-subdir`；
- 都使用 `slot-file-set`；
- 只通过两份不同 Recipe 数据声明游戏名、EXE 和目录。

验收要求：

> 增加第二个 Fixture 游戏时不修改任何 Resolver、Location Strategy、Layout Family、Inspector、Backup、Restore 或 Replacement TypeScript 代码。

这是本阶段“避免每游戏重复开发”的核心自动化证明。

### 13.5 Package/Compatibility 测试

- Package V2 保留 unitId；
- Inspector 不再全局硬编码 Elden Ring；
- Receipt 到 Recipe binding；
- 源/目标路径越界；
- package 缺少 requiredAnyOf；
- 账户相同、不同、目录作用域、未知；
- Adapter 推荐、必需、未知和缺失；
- 旧 `vanilla-main` 硬编码回归测试必须删除/替换。

### 13.6 Adapter Assessment 测试

- backup 与 exact restore 永远不因不透明格式要求 Adapter；
- 同账户一对一文件映射返回 `not_required`；
- 整容器替换影响过大返回 `recommended`；
- 嵌入账户 + checksum 返回 `required`；
- binding 未知返回 `undetermined`；
- 缺的是布局族时 `extensionTarget=layout-family`，不能误报 format adapter；
- `required+missing` 生成 hash-verified Development Brief；
- Adapter build/format scope 不匹配时不能复用。

### 13.7 事务与故障注入

- 文件在备份中变化；
- Context 物化后目标新增/删除；
- rescue 创建失败；
- staging 写失败；
- apply 中断；
- post-state 不匹配；
- rollback 成功/失败；
- 进程在 plan 后重新启动；
- 旧 Assessment、Package 或 Plan 漂移。

### 13.8 完整回归

- TypeScript check/build；
- 单元与集成测试；
- stdio MCP smoke；
- 现有 Nexus persistent Chromium 测试；
- Elden Ring M0–M6 回归；
- Ghost of Tsushima GOT-01–GOT-12；
- `git diff --check`；
- 文档和日志凭证扫描。

## 14. 实施里程碑

### G0：基线与 Fixture

- 冻结当前 V1 合同和 Elden Ring 回归；
- 建立 Steam、RUNE、manual PE、slot-file-set 合成 Fixture；
- 将当前 GoT EXE/存档观察记录为验收输入，不执行写入。

### G1：合同拆分与 V2 Store

- 新增 Resolver、Strategy、Layout、Recipe、Context V2、Package V2 合同；
- 建立版本联合 parser 和不可变 Store；
- 迁移 Elden Ring 为组合式 Recipe；
- 保持 V1 读取和测试通过。

### G2：通用安装 Resolver

- 实现 `steam-library`；
- 实现 `rune-steam-emulator`；
- 实现 `manual-pe`；
- 更新 `probe_save_game_install`；
- 完成 GOT-01。

### G3：Location Strategy 与 Recipe 学习

- 实现 Windows/Steam/RUNE 第一批位置策略；
- 实现 Resolver 提供 scope 的有界差分探测；
- 实现 `local_verified` Recipe；
- 完成 GOT-02。

### G4：Layout Family 与通用备份恢复

- 实现第一批 Layout Family；
- 物化精确 Save Unit；
- 改造 Backup/Restore 使用 V2 Context；
- 完成 GOT-03–GOT-05；
- 通过数据驱动复用验收。

### G5：Package V2 与通用 Compatibility

- 改造手动/下载 Inspector；
- Source Candidate/Receipt 绑定 Recipe；
- Package 保留 unit/layout/binding；
- 去除 `ER0000.sl2` 和 `vanilla-main` 全局硬编码；
- 完成 GOT-06–GOT-07。

### G6：Adapter Requirement Assessment

- 实现确定性规则引擎；
- 实现 Assessment Store；
- 实现 Development Brief；
- 接入 Compatibility 和 Plan gating；
- 完成 GOT-08–GOT-09。

### G7：Ghost of Tsushima 真实导入与收尾

- 根据 Assessment 走通用路径或先补齐确有必要的 Adapter；
- 完成真实 rescue、导入、静态验证；
- 完成离线运行时验证；
- 恢复 baseline；
- 完成 GOT-10–GOT-12；
- 更新 skill、README、开发计划结果和回归统计。

## 15. 预期代码与资源布局

```text
nexus-mods-server/src/save/
├── install-resolvers/
│   ├── registry.ts
│   ├── steam-library.ts
│   ├── rune-steam-emulator.ts
│   └── manual-pe.ts
├── location-strategies/
│   ├── registry.ts
│   ├── windows-known-folders.ts
│   ├── steam-userdata.ts
│   ├── rune-data-root.ts
│   └── bounded-differential-probe.ts
├── layout-families/
│   ├── registry.ts
│   ├── single-file.ts
│   ├── slot-file-set.ts
│   ├── container-with-companions.ts
│   ├── directory-tree.ts
│   └── profile-plus-slots.ts
├── recipes/
│   ├── registry.ts
│   ├── recipe-store.ts
│   ├── learned-recipe-store.ts
│   └── built-in/
│       ├── elden-ring-windows.json
│       └── ghost-of-tsushima-directors-cut-windows.json
├── adapter-assessment/
│   ├── adapter-requirement-assessor.ts
│   ├── adapter-requirement-store.ts
│   └── adapter-development-brief-store.ts
├── adapters/
│   └── elden-ring-*.ts
└── ...existing transaction/package/source modules...

skills/manage-game-saves/
├── SKILL.md
└── references/
    ├── discovery.md
    ├── sources-and-packages.md
    ├── transactions.md
    ├── adapter-assessment.md
    └── elden-ring.md
```

具体文件可以在实现中按现有代码风格微调，但职责边界不得重新合并回单体 Game Profile。

## 16. 完成定义

本阶段只有同时满足以下条件才完成：

- Steam、RUNE、manual PE Resolver 都有确定性测试；
- 同类新游戏只需 Recipe 数据，不修改核心 TypeScript；
- 无内置 Recipe 时可以安全生成 scoped `local_verified` Recipe；
- Save Context 只包含已物化的精确 managed paths；
- 数字账户目录不会无证据标记为 SteamID64；
- Inspector 不再全局硬编码 Elden Ring 文件名；
- Standard Save Package 保留 unit/layout/recipe/binding；
- Compatibility 不再硬编码 `vanilla-main`；
- Adapter Requirement Assessment 能区分通用层缺口与二进制 Adapter 缺口；
- `undetermined` 会阻止真实写入；
- `required+missing` 会生成 Development Brief；
- backup/restore exact bytes 不要求专属 Adapter；
- Elden Ring M0–M6 完整回归通过；
- Ghost of Tsushima GOT-01–GOT-12 完成；
- 验收结束后原 GoT baseline 被恢复并验证；
- MCP check/build/test/stdio smoke 全部通过；
- skill 文档与实际工具行为一致；
- 输出、日志和记录不含浏览器凭证或临时下载授权。

## 17. 风险与控制

### 17.1 平台类型不能决定存档路径

控制：Resolver 只提供候选和变量；最终位置必须由 Recipe/Strategy、文件系统或差分证据确认。

### 17.2 通用探测范围过宽

控制：Windows Root Scope Policy、深度/条目/字节限制、probe window、reparse 阻断、截断报告和多候选歧义。

### 17.3 通配模式扩大写入范围

控制：模式只在 Context 物化时展开；Plan 只使用冻结精确路径；新增文件使 Context/Plan stale。

### 17.4 RUNE 账户目录被误判为 SteamID64

控制：账户 kind 与目录字符串分离；Resolver evidence 决定语义；数字格式不作为充分证据。

### 17.5 误判“不需要 Adapter”

控制：`not_required` 需要正向证据；未知 binding/checksum 返回 `undetermined`；运行时证据严格限定 scope。

### 17.6 Adapter 泛滥

控制：Assessment 先返回 `extensionTarget`；可由 Resolver、Strategy、Layout 或 Recipe 解决的问题禁止创建游戏专属 Adapter。

### 17.7 V1 数据回归

控制：版本联合 schema、只读旧对象、Elden Ring 全链路回归和不可变迁移桥接。

### 17.8 外部 Recipe 知识过期

控制：Recipe version/hash、来源证据、适用 build、last verified 时间、静态失败自动退化到有界探测。

## 18. 开发结果记录区

实现开始后，每个里程碑追加：

- 完成日期和 commit；
- 新增/修改合同；
- 测试数量与结果；
- 真实验收对象 ID、hash 和安全路径；
- 未解决 blocker；
- 是否改变本计划的固定决策；
- 如有变更，记录原因、替代方案和用户确认。

### G2 实施记录（2026-08-20）

- 完成三个通用 Resolver、Resolver Registry、PE metadata reader、V2 Install Context Store 与公开 MCP probe 接入；当前位于 `codex/save-recipe-generalization` 分支，commit 待阶段提交。
- 合成测试覆盖 Steam manifest/LastOwner、RUNE 默认及显式 AccountId、manual PE fallback、Recipe/Resolver 冲突、V2 Store 往返与 Context hash。
- GOT-01 真实只读证据：`rune-steam-emulator@1.0.0`、App ID `2215430`、Recipe hash `125944e8695f96c073ca485c8b919f01a126aad3236bce7e2224ae5cb3ad74e8`、EXE SHA-256 `a8d5c9d6342b5a86cc6d1039c9ec9446b508e1b6722054de8968fa8018b95364`、PE FileVersion `1053.7.0809.1937`。
- 安全路径：真实验收仅读取 `E:\Program Files (x86)\Ghost of Tsushima DIRECTORS CUT`；没有访问 `Documents` 存档根，没有创建备份、Plan 或写入游戏/存档文件。
- 未解决 blocker：G3 Location Strategy/Save Context V2 尚未实现，因此 RUNE/manual Context 的后续受管链路会在位置解析阶段停止。
- 固定架构决策未改变；Steam V1 返回是明确的临时兼容桥，V2 Steam Resolver 本身已有确定性测试。

### G3–G5 实施记录（2026-08-20）

- 新增 Location Strategy Registry、Windows Known Folder 展开、通用 Layout materializer、V2 Save Context/Package/Compatibility Store，以及 scoped learned Recipe record；新增 Resolver/Strategy/Layout/Recipe 只读枚举工具。
- 数据驱动测试覆盖 RUNE Documents 账户目录、数字目录保持 `opaque_directory_key`、`auto.sav + manual_*.sav` 物化、非 managed 文件排除、bounded differential fallback、baseline backup、sandbox restore、Recipe-driven manual input、Package V2 和未知 binding 阻断。
- GOT-02/03：Install Context `8e9700e5-8de0-4cf6-99ad-3df39fb1539c`；Save Context `87b12429-3704-4238-ba22-63da37095cca`，hash `a8b10533c268490b0ed0223f42903d49a988baa0b6c0464bea17a3113fe9e197`；只物化 `auto.sav` 与 `manual_0000.sav`。
- GOT-04：baseline Backup `0b2dda1b-5929-4e2e-adfd-86b9654824d8`，tree hash `1373a8d44cb1809ef6ab9b33ef7850928578ed548f0099bf051fe8d29d88c9e0`，重新验证通过。
- GOT-05：sandbox Restore Plan `2e930e30-129c-4e04-98a1-911f3367d12b`；Operation Record `45b4c95b-c9aa-4e09-9072-bf68f358de1b`，`staticVerification=passed`；真实存档未改变。
- GOT-06/07：Nexus Mod `834` / File `2617`，下载 SHA-256 `54f0ede74fa32533864f64022dd7fb7f3fb3995cd37bf524acdd93ea2d1d4af9`；Save Receipt `597000be-20cf-4243-bd09-90190bf5e9cc`；Package `savepkg-0a377996fc096ba26d7483beedbba0f62bf61818d42b5a08734057c8b9be0b36`，manifest hash `78774d2c3d76f8faf70940eddc86f9de44525b4cb46a6a24a22cab372cd0081a`。
- 来源验收发现并修复跨游戏 DLC requirement 污染：DLC claims 现在必须匹配目标 `storeAppId`；作者文本仍只作为 progress claim，不自动升级为结构或兼容性证据。
- Compatibility Assessment `f4a74ea7-d478-44ca-8f50-effe876a5029` 冻结两个精确映射；因账户绑定未知返回 `ambiguous`，没有创建 Replacement Plan。
- 安全路径：下载位于 `C:\Users\64617\Documents\GameFinder\.codex-work\acceptance-save-g5\got-mod-834`；sandbox 位于 GameFinder manager root；真实 GoT save root 在本阶段仅被读取和备份。
- 回归：40 个测试文件通过、3 个按配置跳过；231 项测试通过、20 项按配置跳过；TypeScript check/build、stdio smoke 与 `git diff --check` 通过。
- G3–G5 阶段遗留 blocker：当时尚未对 GoT whole-unit replacement 给出操作级 Adapter 判断；该缺口现已由下方 G6 记录解决，结果为 `undetermined`，因此真实替换仍按证据规则阻止。

G6 完成后，当前 MCP 已支持 Ghost of Tsushima 的安装识别、静态位置发现、通用备份/沙箱恢复、在线下载、Package V2 和 Adapter Requirement 判断；当前 `undetermined` 结果明确表示真实导入尚未获授权或具备足够格式证据。

### G6 实施记录（2026-08-20）

- 新增 `adapter-assessment` 确定性规则引擎、hash-verified immutable Assessment Store 与 Development Brief Store；公开 `assess_save_adapter_requirement`、`get_save_adapter_requirement_assessment`、`get_save_adapter_development_brief`。
- 评估按操作区分 `backup`、`restore-exact-bytes`、整单元替换、槽位/容器导入、跨账户导入与版本转换；缺口可指向 Resolver、Location Strategy、Layout Family、Recipe 或 Format Adapter。
- Compatibility V2 现在冻结 Adapter Requirement Assessment ID/hash；Plan 入口重新读取并核对 Context/Package/Assessment scope，旧评估、`undetermined`、`required+missing` 均不能降级到 V1 direct replacement。
- GOT-08：Backup Assessment `245fe844-2fb9-469b-a4b8-9c9e5f87727a`，hash `bb890c553d2db8d7dce647a0cc31a156130ae4901ba144b9e7815e9c299b098a`；Exact Restore Assessment `0db10a4a-c529-493b-ac2e-dff393bd25fe`，hash `9fab429169b657c6266acadefae897e44f326815330058a20b77411693135865`；两者均为 `not_required/not_applicable`。
- GoT whole-unit Assessment `01b8f2fe-d3c3-476c-aece-005db959973c`，hash `f93e1bcdf7c88627b0ca0740e38451bb1367f6c3bfe35e5c76e67c88456c37a6`；结果 `undetermined`，reason codes 为 `ACCOUNT_BINDING_UNKNOWN`、`CHECKSUM_POLICY_UNKNOWN`。
- 静态证据：下载/本地两个对应文件均只有 4-byte common prefix 和 4-byte common suffix，文件长度不同；双方都在 offset 4 以 UInt32LE 记录自身精确长度；源/目标账户目录值在 ASCII、UTF-16LE、UInt64LE 常见编码中均未找到。最后一项明确不构成“无绑定”证明。
- GOT-09 Compatibility `3d3e1232-6062-4860-9b96-187e90069782`，hash `16a3706aae1f9bc14c28e60cfda35fc07b8acb7f60a54fd3ebc112a1f5c30a62`；绑定 Adapter Assessment `93e96ca8-a15c-44a8-b544-61bac9e37513` / `e3e69bc51c82ce498d46583d7c7be1beced8e92c9c3529e35d26494e102b8ff1`，冻结 `auto.sav → auto.sav`、`manual_0000.sav → manual_0000.sav`，状态 `ambiguous`、`replacementPlanAllowed=false`。
- G6 真实验收只读取本地 baseline 与内容寻址的下载对象，并写入 manager-owned Assessment JSON；没有创建 Replacement Plan，没有修改真实 GoT save root。
- G6 完整回归：TypeScript check/build 通过；40 个测试文件通过、3 个按配置跳过；232 项测试通过、20 项按配置跳过；stdio smoke 通过（107 tools，未启动浏览器）；skill frontmatter/reference 手动等价校验与 `git diff --check` 通过。官方 quick validator 因系统 Python 未安装其 `PyYAML` 依赖而未执行，未为校验修改系统环境。
- 当前 blocker 属于二进制内部证据不足，不是 Resolver/Location/Layout/Recipe 缺失。G7 必须先取得可限定 scope 的格式/运行时证据，或按 Development Brief 开发并验证 Adapter，随后重新 Assessment；不得复用本节的阻塞评估。

### G7 实施记录（2026-08-20）

- 根据 MIT 项目 [ghostoftsushima-save-converter](https://github.com/KOVRlN/ghostoftsushima-save-converter) 的 [TECHNICAL.md](https://github.com/KOVRlN/ghostoftsushima-save-converter/blob/main/TECHNICAL.md) 与 [实现源码](https://github.com/KOVRlN/ghostoftsushima-save-converter/blob/main/got_save_converter.py)，实现 `ghost-of-tsushima-pc-v49@1.0.0` 验证 Adapter；它限定 magic `0x14E`、version `49`、精确 content size、三个 PC marker 与加法 checksum。四个真实本地/下载样本均通过独立验证，破坏字段/marker/checksum 的负向测试均被拒绝。
- GoT Recipe 升级到 `1.1.0` 并声明 `game-specific-container` 与该 Adapter。Adapter 只授权其限定范围内的 account-neutral exact-file replacement，不声称支持任意版本、账户重绑定、字段编辑或转换。
- Adapter Requirement Assessment `38e46512-4698-4a43-bd73-d4891141526a` 返回 `required+matched`；Compatibility `c4a3f3e7-bb05-481a-aa5d-53973a07ecef` 返回 `compatible_direct`。V2 Assessment 通过 ID/hash 绑定桥接到既有 rescue、prestate、原子发布、回滚与静态验证内核，没有新增旁路写盘能力。
- GOT-10 Replacement Plan `17610bf0-9dc8-47a4-8f23-b3515faf81bb`，hash `927796cb704a37f7bdd0e48f2bd3a28c8e7a77ceac712086aec95eb1e29958bb`；Operation Record `97387d28-2693-43d0-a210-66b917864f43`，hash `e1df5bc7bc6552750361996b0b57e6121785f620d4cf68159ea22c581cf18682`；替换前 rescue `a1b60d2d-1334-4c09-99a8-00f7484815df`。应用后静态验证通过，用户确认导入存档可见、可载入、可正常游玩；Runtime Verification `66cc0dc6-1d9d-492c-9b77-6a8cf926e336`。
- GOT-12 使用与早期 acceptance baseline 相同 tree hash `1373a8d44cb1809ef6ab9b33ef7850928578ed548f0099bf051fe8d29d88c9e0`、且绑定当前 Context 的替换前 rescue 作为恢复源。Restore Plan `829e47f9-ea63-4825-82bb-91f0a8701bd5`，hash `d5c3646d9a8f841d7b6361f6febc5da6b81610cca4ee23735618e4388e4f163a`；Operation Record `3ee43ebb-9b05-42a0-b739-baa9a984f848`，hash `3a2dd91616087ad4a7d4e0cf45ebc29590d0a14a5b48b1dbf51b85eca2abe683`；恢复前 rescue `4d40a338-cf17-4c7c-bdc5-c9247f867a39`。
- baseline 应用后静态验证通过，用户进入游戏确认原始存档身份；游戏随后正常更新 `auto.sav`，`manual_0000.sav` 仍与 baseline 字节一致。系统保留该 post-launch live state，并以 Runtime Verification `642b3eec-a273-4ace-b81c-78a73a0cfc02` 记录 `original_restored`，未再次覆盖自动保存。
- G7 完整回归：TypeScript check/build 通过；41 个测试文件通过、3 个按配置跳过；234 项测试通过、20 项按配置跳过；stdio smoke 通过（107 tools，未启动浏览器）；`git diff --check` 通过。

### G8 exact whole-unit 语义修复（2026-08-20）

- 修复 G7 验收包文件名恰好同名而未暴露的语义缺口：V2 `replace-whole-unit` 不再按同名 overlay，而是以 Package 文件集合为最终 Save Unit 集合；旧 V1 `direct_replace` 保持 overlay 以兼容历史调用。
- Adapter 分别验证 Package source set 与当前 target set，不再要求 `manual_0028.sav` 必须存在同名本地目标；Compatibility 仍要求每个新目标路径匹配绑定 Recipe 的 `managedPatterns`。
- Replacement Plan 对集合差异冻结 `create-file`、`replace-file`、`delete-file` 和 `preserve-identical`；Plan 执行范围只增加已由 Compatibility 授权并冻结的精确路径。
- Restore 规划重新物化当前 V2 Save Unit，并用当前集合创建恢复前 rescue，因此可从仅含 `manual_0028.sav` 的替换结果精确恢复到原 `auto.sav + manual_0000.sav`，不会遗留新增文件。
- 合成回归直接覆盖目标 `auto.sav + manual_0000.sav`、来源仅 `manual_0028.sav`：计划产生两项删除和一项创建；应用、静态验证、baseline restore 及三次写入后的故障回滚均通过。
