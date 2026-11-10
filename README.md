# WeKnora_plugin_byDHS

给 **DeepSeek Harness（DSH）** 用的 WeKnora 知识接地插件。

装上它之后，DSH 里关于组织内部知识的回答**不再是"模型愿不愿意查"，而是"查过了才能答"**：宿主在用户消息进入模型之前先检索 WeKnora，把原文片段以 `<kb-evidence>` 注入这条消息；模型只能依据这些片段作答，逐条标注 `[K#]`，回答末尾列出「文档名 + knowledge_id + chunk 序号」；没有证据时必须明说「知识库中没有足够证据」。

> 名字说明：`byDHS` = **by DeepSeek Harness**，指"为 DeepSeek Harness 而做"，不是个人或团队缩写。
> npm 包名是 `weknora-plugin-bydhs`（npm 不允许大写字母），插件身份与显示名是 `WeKnora_plugin_byDHS`。

- 版本：0.4.0 ｜ 许可：MIT ｜ 零运行时依赖、纯 ESM、无需构建
- 兼容性：见 [COMPATIBILITY.md](COMPATIBILITY.md)（DSH 0.2.x / WeKnora v0.9.0 实测）
- 想直接上手：看 [HANDOVER.md](HANDOVER.md)（配置清单）与 [TESTING.md](TESTING.md)（验收清单）
- English: [README.en.md](README.en.md)

---

## 目录

1. [它解决什么问题](#1-它解决什么问题)
2. [和官方 WeKnora 插件的区别](#2-和官方-weknora-插件的区别)
3. [工作原理](#3-工作原理)
4. [工具一览](#4-工具一览)
5. [目录结构](#5-目录结构)
6. [前置条件](#6-前置条件)
7. [安装](#7-安装)
8. [配置](#8-配置)
9. [使用](#9-使用)
10. [使用图例](#10-使用图例)
11. [验证](#11-验证)
12. [排障](#12-排障)
13. [数据边界与隐私](#13-数据边界与隐私)
14. [已知限制](#14-已知限制)
15. [与同类项目对比](#15-与同类项目对比)
16. [参与贡献](#16-参与贡献)

---

## 1. 它解决什么问题

DSH 本身不提供检索、嵌入或知识库能力：它的 `grep` / `glob` 只读工作区，`web_search` 只读互联网。接上 WeKnora 之后，如果只是"给模型几个检索工具"，会出现三个典型问题：

| 问题 | 表现 | 本插件的处理 |
| --- | --- | --- |
| 模型不查就答 | 明明有知识库，模型凭记忆编 | `agent/pre-step` **在模型看到问题前**就检索并注入证据 |
| 查了但证据很弱 | 向量检索永远返回"最像"的几条，低分片段被当成事实 | 确定性门槛：词面覆盖率 ≥ 0.34 且来源字段齐全才算证据 |
| 引用对不上 | 答案标了出处，但出处是编的 | `check_citations` 把每条引用对账到本轮实际检索到的片段 |

一句话：**把"检索"从模型的自由选择变成宿主的前置动作，把"引用"从口头承诺变成可校验的数据。**

## 2. 和官方 WeKnora 插件的区别

| | 官方 `@wxg-prc-cpg/dsh-weknora` | `WeKnora_plugin_byDHS` |
| --- | --- | --- |
| 工具 | 4 个只读工具 | 7 个：检索 3 个 + 引用自检 + 列知识库 + Wiki 2 个 |
| 模型不调用工具时 | 什么都不会发生 | 宿主已注入证据，模型没有"跳过检索"的选项 |
| 证据质量 | 由服务端排序决定，低分片段照样进上下文 | 覆盖率门槛 + 来源字段校验，不可引用的片段直接丢弃 |
| 证据不足 | 模型自由发挥 | 注入 `insufficient="true"` 块，要求承认"没有足够证据" |
| 检索失败 | 工具报错，对话可能中断 | 注入 `unavailable="true"` 块，要求说明"检索不可用"而非"没有证据" |
| 引用 | 提示模型标出处 | 可调用工具逐条校验，伪造 `[K#]` 会被拒 |
| 采样 | 不变 | 接地会话 temperature ≤ 0.2（可关） |
| 多知识库 | 一次调用传多个 id | 逐库检索、单库失败隔离，失败原因写进证据块 |
| 凭据 | 明文 `apiKey` 或环境变量 | 从 DSH 凭据库按引用名解析（`apiKeyRef`），patch 文件不存明文 |
| 多租户 | 支持 `tenantId` | 支持 `tenantId`（`X-Tenant-ID`） |
| 稳定性 | — | 429/5xx/网络错误自动重试（可配） |
| 分发 | npm | 本地包 / 打 zip 分发；也可自行发布 npm |

两者可以共存（工具名前缀不同），但不建议同时启用：会出现两套检索工具，浪费提示词预算。

## 3. 工作原理

```mermaid
flowchart TD
    U["用户提问<br/>（组织知识类）"] --> P["agent/pre-step<br/>宿主钩子"]
    P --> Q{"shouldGround?<br/>闲聊/代码语法/过短 → 跳过"}
    Q -->|是| R["检索 WeKnora<br/>多库逐库，单库失败隔离"]
    Q -->|否| M["模型直接作答"]
    R --> G{"证据门槛<br/>coverage ≥ 0.34<br/>knowledge_id + chunk 齐全?"}
    G -->|通过| E["注入 &lt;kb-evidence&gt; + &lt;kb-rule&gt;<br/>挂到被领取的用户消息"]
    G -->|全部被拦| I["注入 insufficient=\"true\" 块"]
    R -->|检索报错| X["注入 unavailable=\"true\" 块"]
    E --> M2["模型作答<br/>只依据片段，标 [K#]"]
    I --> M2
    X --> M2
    M2 --> C["check_citations<br/>引用对账（可选）"]
    C --> A["最终回答<br/>末尾列引用清单"]
    S["系统提示词策略段<br/>weknora-bydhs:policy (order 10500)"] -.约束.-> M2
    T["工具（多跳补充）<br/>search / read / ask / wiki_search / wiki_read / list_knowledge_bases"] -.可随时调用.-> M2
```

纯文本版（无法渲染 Mermaid 时看这个）：

```text
用户提问
  │
  ├─ agent/pre-step（宿主执行，本插件）
  │    1. shouldGround(text)?  闲聊 / 纯代码语法 / 过短 → 跳过
  │    2. 检索 WeKnora（多库时逐库检索，单库失败不影响其它库）
  │    3. 证据门槛：coverage ≥ minCoverage 且 knowledge_id + chunk_index 齐全
  │         ├─ 通过   → 注入 <kb-evidence>（[K1]…）+ <kb-rule>
  │         ├─ 全被拦 → 注入 insufficient="true" 块
  │         └─ 报错   → 注入 unavailable="true" 块
  │    4. 同一 turn 的后续 step 不再重复检索（按用户消息 id 去重）
  │
  ├─ agent/request（宿主执行）：接地过的会话 temperature ≤ 0.2
  │
  └─ 模型作答（只能依据 <kb-evidence>，标 [K#]）
        └─ 可选：check_citations 自检；不通过就修正或降级结论
```

### 强制力矩阵（诚实版）

| 机制 | 强制力 | 说明 |
| --- | --- | --- |
| 每轮先检索 | **硬**（宿主执行） | 消息被判为组织知识问题时，检索在模型看到消息前已完成 |
| 证据范围 | **硬**（确定性门槛） | 低于覆盖率的片段不进证据块；缺 `knowledge_id`/`chunk` 的片段直接丢弃 |
| 证据不足 / 检索失败 | **硬**（注入不同块） | 模型拿到的是明确指令，不是空白 |
| 采样降温 | **硬**（宿主控制参数） | 改的是宿主发出的 `temperature` |
| 引用格式与"必须标注" | **软**（提示词） | 模型仍可能不标；用 `check_citations` 把它变成可检查的失败 |
| 引用内容真实性 | **半硬** | 能验证"引用是否来自本轮证据"，不能验证"这句话是否被片段支持"（需第二轮模型判定） |

## 4. 工具一览

工具名前缀默认 `wkg`（`toolPrefix` 可改），下表省略前缀。

| 工具 | 作用 | 主要参数 | 返回 |
| --- | --- | --- | --- |
| `search` | 混合检索（向量 + 关键词 + 重排序），带证据门槛 | `query`、`knowledge_base_ids?`、`knowledge_ids?`、`max_results?`、`rerank?` | 片段 + `knowledge_id` + chunk 序号 + `coverage` + `[K#]` + 门槛诊断 |
| `read` | 按顺序读一篇文档的全部分块（可分页） | `knowledge_id`、`page?`、`page_size?` | 拼好的正文 + 分页信息 |
| `ask` | 让 WeKnora 自己组合带引用的回答（RAG / ReAct） | `query`、`knowledge_base_ids?`、`agent_id?`、`session_id?` | 答案 + 引用 + 使用的工具 + 会话 id |
| `check_citations` | 引用自检：`[K#]` 与内联 `knowledge_id + chunk` 对账 | `answer`、`require_chunk?` | 逐条状态（verified / unknown_source / not_in_evidence / malformed） |
| `list_knowledge_bases` | 列出凭据可见的知识库 | `query?`（名称/ID 过滤） | id、名称、描述、分块数 |
| `wiki_search` | 搜索 WeKnora Wiki 页面（主题/实体页） | `query`、`knowledge_base_ids?`、`limit?`、`regex?` | slug、标题、类型、摘要、片段、来源数 |
| `wiki_read` | 按 slug 读整页 Wiki | `slug`、`knowledge_base_id?`、`max_chars?` | 标题、类型、状态、版本、正文、来源文档引用、链接 |

所有工具都声明了 `parameters` 与 `output.schema`，并通过 Harness 自带的 `assertSupportedJsonSchema` 校验（见 `scripts/verify-schemas.mjs`）。

## 5. 目录结构

```text
WeKnora_plugin_byDHS/
├── index.js                 # 插件入口：注册工具、策略段、pre-step/request 钩子
├── config.js                # 配置默认值与加载期校验（逐字段点名）
├── client.js                # WeKnora REST 客户端（检索/读块/问答 SSE/Wiki，零依赖）
├── tools.js                 # 7 个工具定义（schema + render + execute）
├── gate.js                  # 证据门槛：分词、覆盖率、来源校验、insufficient 判定
├── evidence.js              # 证据块 / 不足块 / 不可用块渲染（含不可信文本转义）
├── cite.js                  # 引用解析与校验（[K#] + 内联 knowledge_id/chunk）
├── state.js                 # 证据账本（按会话隔离）+ 消息级去重 + 接地会话集合
├── cordis.patch.yml         # 默认配置层（环境变量驱动）
├── install.ps1              # Windows 一键安装（复制 + 改 package.json + 加 patch 行）
├── package.json             # 包定义（dsh.bundle.patch 指向上面的 yml）
├── README.md / README.en.md # 中文 / 英文说明
├── HANDOVER.md              # 交接清单：你需要给同事什么、同事要准备什么
├── TESTING.md               # 验收清单
├── COMPATIBILITY.md         # 兼容矩阵与依赖的宿主接口
├── CONTRIBUTING.md / SECURITY.md
├── CHANGELOG.md / LICENSE
├── examples/
│   └── cordis.patch.example.yml   # 可直接抄的 profile 覆盖示例
├── samples/                 # 3 份虚构样本文档，导入 WeKnora 即可测试
├── scripts/
│   ├── doctor.mjs           # 环境体检：逐项 OK/WARN/FAIL 并给修复建议
│   ├── mock-weknora.mjs     # 离线假 WeKnora（无真实部署也能跑通链路）
│   ├── verify-live.mjs      # 真实 WeKnora 集成断言（28 项）
│   └── verify-schemas.mjs   # 用 Harness 自带校验器校验工具 schema（可选）
└── test/                    # 66 个单元测试（node --test，无网络）
```

## 6. 前置条件

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| DeepSeek Harness | 提供 `agent/pre-step`、`agent/request`、`ctx.systemPrompt.section()`、`ctx.tools.register()` 的版本（0.2.x 实测） | 老版本没有这些 seam 时插件会注册工具但不注入证据 |
| Node.js | ≥ 20.11（宿主自带 Node 即可） | 插件零依赖，不额外安装任何包 |
| WeKnora | v0.8+（v0.9.0 实测） | 需要 `POST /knowledge-search`、`GET /chunks/:id`、`POST /sessions`、`/knowledge-chat|agent-chat`；Wiki 工具需要知识库开启 Wiki |
| API Key | 能力 `retrieve`（+ `chat` 才能用 `ask`） | 在 WeKnora → 设置 → API Key 创建；**只读**，本插件不写库 |
| 凭据库 | DSH 的 credential store（`~/.dsh/.credentials.yaml` 的 `refs`） | 或改用明文 `apiKey`（不推荐） |
| pnpm ≥ 10 | 仅 `dsh plugin add` / `plugin_manager` 安装时需要 | 手工复制目录或 `install.ps1` 则不需要 |

## 7. 安装

先放 Key（**不要把 Key 写进 patch 文件**）：

```yaml
# ~/.dsh/.credentials.yaml
refs:
  WEKNORA_API_KEY: sk-your-read-only-key
```

### A. 插件管理器（推荐，live 生效）

在 DSH 里让 Agent 调用：

```text
plugin_manager(action="install_bundle", target="file:/path/to/WeKnora_plugin_byDHS")
```

### B. CLI

```powershell
dsh plugin --profile <profile-name> add "file:/path/to/WeKnora_plugin_byDHS"
```

### C. Windows 一键安装（自动改 package.json 与 cordis.patch.yml）

```powershell
.\install.ps1 -Profile desktop `
  -BaseUrl 'http://localhost:8080/api/v1' `
  -KnowledgeBaseIds '<your-kb-id>'
```

### D. 手工复制

```powershell
$src = '/path/to/WeKnora_plugin_byDHS'
$dst = "$env:USERPROFILE/.dsh/profiles/<profile-name>/node_modules/weknora-plugin-bydhs"
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
Copy-Item -Recurse -Force $src $dst
```

再在 `<profile>/package.json` 加依赖与 bundle（必须是**无 BOM** 的 UTF-8）：

```json
{
  "dependencies": {
    "weknora-plugin-bydhs": "file:/path/to/WeKnora_plugin_byDHS"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "weknora-plugin-bydhs"
      ]
    }
  }
}
```

最后在 `<profile>/cordis.patch.yml` 覆盖配置（示例见 `examples/cordis.patch.example.yml`）：

```yaml
- id: WeKnora_plugin_byDHS
  name: "weknora-plugin-bydhs"
  disabled: false
  config:
    baseUrl: 'http://localhost:8080/api/v1'
    apiKeyRef: WEKNORA_API_KEY
    knowledgeBaseIds:
      - <your-kb-id>
    enforce: true
    injectEvidence: true
```

> **patch 语义是整行替换**：写 patch 时要把想保留的字段全部重述，否则默认值生效。
> 写 `!!js` 表达式必须用双引号包住整个表达式（未加引号的标量里出现 `: ` 会被 YAML 提前截断，整行 `ConfigError`）。

### 卸载

```powershell
plugin_manager(action="remove_bundle", target="weknora-plugin-bydhs")
```

或从 profile 的 `package.json`（dependencies + bundles）与 `cordis.patch.yml` 里删掉对应条目。

## 8. 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://localhost:8080/api/v1` | WeKnora API 根；接受裸 origin，自动补 `/api/v1` |
| `apiKey` | 无 | 明文 Key（不推荐，优先用 `apiKeyRef`） |
| `apiKeyRef` | `WEKNORA_API_KEY` | 凭据库引用名；`apiKey` 为空时按此名解析 |
| `knowledgeBaseIds` | `[]` | 默认检索范围；空 = 该凭据可见的全部库 |
| `agentId` | 无 | 设置后 `ask` 默认走 ReAct 智能体流水线 |
| `toolPrefix` | `wkg` | 工具名前缀，如改成 `weknora` 得到 `weknora_search` |
| `enforce` | `true` | 策略措辞「必须」/「应当」，并影响策略段标题 |
| `injectEvidence` | `true` | 是否在 `agent/pre-step` 注入证据；`false` 退回"只给工具"模式 |
| `policyOrder` | `10500` | 策略段在系统提示词中的位置（第一方 persona suffix 是 10200） |
| `minQueryChars` | `8` | 短于此的消息按闲聊处理，不接地 |
| `minCoverage` | `0.34` | 词面覆盖率门槛（0–1），跨部署可比，与分数尺度无关 |
| `minScore` | 无 | 可选绝对分数下限（0–1）；仅当检索返回归一化分数时再设 |
| `maxInjectedChars` | `4000` | 单次注入块字符预算（含规则块；超出省略并注明条数） |
| `injectTopK` | `6` | 注入检索请求的片段数（工具调用用 `maxResults`） |
| `temperatureCap` | `0.2` | 接地会话温度上限；`null` 关闭 |
| `perKbIsolation` | `true` | 多库时逐库检索，单库失败不影响其它库 |
| `tenantId` | 无 | 平台级 Key 需要，发送 `X-Tenant-ID` |
| `extraHeaders` | 无 | 额外请求头（网关/代理用），如 `{ "X-Gateway-Token": "..." }` |
| `maxRetries` | `1` | 429/5xx/网络错误重试次数；`0` 关闭 |
| `maxWikiChars` | `8000` | 单页 Wiki 内容字符预算 |
| `maxResults` | `6` | 工具单次检索返回片段数 |
| `maxChunkChars` | `1500` | 单片段截断长度 |
| `requestTimeoutMs` / `chatTimeoutMs` | `30000` / `300000` | 检索 / 问答超时 |
| `resourceUrls` | `handle` | 受限 Key 保持 `handle`，不要用 `public` |

**环境变量**（`cordis.patch.yml` 默认层读取）：`WEKNORA_BASE_URL`、`WEKNORA_API_KEY`、`WEKNORA_API_KEY_REF`、`WEKNORA_KNOWLEDGE_BASE_IDS`、`WEKNORA_AGENT_ID`、`WEKNORA_GROUND_TOOL_PREFIX`、`WEKNORA_GROUND_INJECT`、`WEKNORA_GROUND_POLICY_ORDER`、`WEKNORA_GROUND_MIN_COVERAGE`、`WEKNORA_GROUND_MAX_INJECTED_CHARS`、`WEKNORA_GROUND_TEMPERATURE_CAP`。

**多实例**（两套部署并存，工具前缀不同）：

```yaml
- insert:
    - id: WeKnora_plugin_byDHS-internal
      name: "weknora-plugin-bydhs"
      config: { baseUrl: https://kb.internal.example.com, apiKeyRef: WEKNORA_KEY_INTERNAL, toolPrefix: internal_kb }
    - id: WeKnora_plugin_byDHS-public
      name: "weknora-plugin-bydhs"
      config: { baseUrl: https://kb.public.example.com, apiKeyRef: WEKNORA_KEY_PUBLIC, toolPrefix: public_kb }
```

## 9. 使用

### 9.1 正常对话

装好之后不需要额外操作，直接问组织知识问题即可。回答会自然带 `[K#]` 和末尾引用清单。

### 9.2 引用约定

| 形式 | 含义 |
| --- | --- |
| `[K1]` | 本轮 `<kb-evidence>` 里的第 1 条片段 |
| `knowledge_id: 8f14…` + `chunk: 3` | 精确到分块，可回到原文定位 |
| 回答末尾引用清单 | 文档名 + knowledge_id + chunk 序号，便于人工复核 |
| Wiki 引用 | 页面 slug + 标题（如 `concept/inspection-cycle`） |

### 9.3 引用自检

```text
模型：点检周期为三个月 [K1]，由设备科执行 [K2]。

（可选）调用 check_citations(answer="...")
→ 引用自检：2/2 通过 ✅
```

伪造引用会被拒：

```text
check_citations(answer="点检周期为三个月 [K9]")
→ 引用自检：0/1 通过 ❌
   - [K9] · unknown_source — 答案引用了 [K9]，但本轮检索结果里没有这个编号
```

### 9.4 Wiki 页面

问"某个主题在知识库里怎么讲"时，模型会先用 `wiki_search` 定位页面，再用 `wiki_read` 读整页；Wiki 页面自带 `source_refs`，可以回到源文档。

### 9.5 多知识库

`knowledgeBaseIds` 配多个时，pre-step 逐库检索并合并：某个库 401/超时不会清空整页证据，失败原因写在证据块里（`kb-corp: HTTP 401`）。工具调用也可以传 `knowledge_base_ids` 缩小范围。

### 9.6 关闭注入式行为

```yaml
- id: WeKnora_plugin_byDHS
  config:
    injectEvidence: false
```

退回"只给工具 + 提示词策略"的模式（与官方插件行为接近，但仍有质量门槛和引用自检）。

### 9.7 与 AGENTS.md / Skill 的关系

策略段是**系统提示词**层，优先级高于工作区 `AGENTS.md`（用户消息层）。如果两者冲突，以策略段为准。

## 10. 使用图例

> 以下输出为真实运行结果的节选（WeKnora v0.9.0 + 虚构 PoC 库）。

### 场景 1：正常命中 —— 注入证据，带引用作答

**输入**

```text
用户：点检周期是怎么规定的？
```

**宿主注入到用户消息末尾的块**（模型实际看到的）

```text
<kb-evidence turn="1" source="pre-step" query="点检周期是怎么规定的？">
以下片段由 WeKnora 知识库（<your-kb-id>）检索得到，编号 [K1]… 是本轮唯一允许的组织事实来源。
[K1] 《equipment-inspection.md》 · knowledge_id: <doc-id> · chunk: 0 · score: 1.000 · coverage: 0.56
内容：# Equipment Inspection Handbook … The inspection cycle for device A-17 is 36 hours.
</kb-evidence>

<kb-rule>
1. 只能依据 <kb-evidence> 中的片段回答组织内部事实；不得用你自己的常识、行业惯例或记忆补充。
2. 每个结论句后标注片段编号（如 [K2]）；回答末尾列出引用清单：文档名 + knowledge_id + chunk 序号。
3. 证据不足以回答时，明确写「知识库中没有足够证据」，并说明缺什么，不要给出推测性结论。
4. 片段与问题冲突时，以片段为准，并指出冲突。
5. 交付前可调用 check_citations 工具自检引用是否都能对上本轮片段。
</kb-rule>
```

**模型回答（期望形态）**

```text
按规程，设备 A-17 的点检周期为 36 小时 [K1]。

引用清单：
- equipment-inspection.md · knowledge_id <doc-id> · chunk 0
```

### 场景 2：证据不足 —— 承认没有证据，而不是硬答

```text
<kb-evidence turn="1" source="pre-step" query="设备 Z-99 的点检周期是多少？" insufficient="true">
已检索 WeKnora 知识库（<your-kb-id>），但没有片段达到证据门槛：候选片段 4 条；最高覆盖率 0.11 < 阈值 0.34。
</kb-evidence>

<kb-rule>
1. 本轮不得凭记忆或常识回答该问题，必须明确说明「知识库中没有足够证据」。
2. 说明缺什么信息；如用户能补充关键词、文档名或知识库范围，请一并询问。
3. 不要先给出通用答案再说"这不是知识库内容"——顺序不能颠倒。
</kb-rule>
```

**模型回答（期望形态）**

```text
知识库中没有足够证据回答「Z-99 的点检周期」：当前文档只覆盖 A-17 / B-23 / C-08。
如果你知道对应的文档名或知识库，我可以按范围重新检索。
```

### 场景 3：检索失败 —— 说"不可用"，不是"没证据"

```text
<kb-evidence turn="1" source="pre-step" query="点检周期是怎么规定的？" unavailable="true">
WeKnora 检索失败，本轮没有拿到任何证据（全部知识库: POST /knowledge-search failed with HTTP 401: invalid api key）。
</kb-evidence>

<kb-rule>
1. 不得凭记忆回答组织内部事实。
2. 明确告知用户"知识库检索当前不可用"，并复述失败原因；建议其检查 WeKnora 服务或凭据后重试。
3. 不要把"检索失败"说成"知识库没有证据"——两者含义不同。
</kb-rule>
```

### 场景 4：引用自检不通过 —— 让模型自己修

```text
模型初稿：点检周期为 36 小时 [K3]。

check_citations(answer="点检周期为 36 小时 [K3]")
→ ok=false
  引用自检：0/1 通过 ❌
  - [K3] · unknown_source — 答案引用了 [K3]，但本轮检索结果里没有这个编号

模型修正：点检周期为 36 小时 [K1]。（重新自检 → 1/1 通过 ✅）
```

### 宿主日志（排障时看这个）

```text
WeKnora_plugin_byDHS: registered wkg_search, wkg_read, wkg_ask, wkg_check_citations, wkg_list_knowledge_bases, wkg_wiki_search, wkg_wiki_read + grounding policy against http://localhost:8080/api/v1 (enforce=true, injectEvidence=true, order=10500)
WeKnora_plugin_byDHS: pre-step turn=1 candidates=4 kept=4 insufficient=false failures=0 injected=2536c
```

`candidates` 是服务端返回条数，`kept` 是通过门槛的条数，`injected` 是注入字符数。

## 11. 验证

```powershell
cd WeKnora_plugin_byDHS

# 1) 单元测试（无网络，66 项）
node --test

# 2) 环境体检（逐项 OK/WARN/FAIL，不需要安装插件）
node scripts/doctor.mjs --query "a question your KB answers"

# 3) 真实 WeKnora 集成断言（28 项）
$env:WEKNORA_BASE_URL = 'http://localhost:8080/api/v1'
$env:WEKNORA_KNOWLEDGE_BASE_IDS = '<your-kb-id>'
$env:WEKNORA_API_KEY = 'sk-...'        # 或放进 ~/.dsh/.credentials.yaml
node scripts/verify-live.mjs --query "点检周期是怎么规定的？"

# 4) 没有 WeKnora？用离线 mock 跑通链路
node scripts/mock-weknora.mjs --port 18090
# 另一个终端：
$env:WEKNORA_BASE_URL='http://127.0.0.1:18090/api/v1'; $env:WEKNORA_API_KEY='mock-key'; $env:WEKNORA_KNOWLEDGE_BASE_IDS='mock-kb'
node scripts/verify-live.mjs --query "inspection cycle"

# 5) 可选：用 Harness 自带校验器校验工具 schema
$env:DSH_TOOLS_ENTRY = 'C:/path/to/@deepseek-ai/dsh-tools/lib/index.js'
node scripts/verify-schemas.mjs
```

预期结果：`66/66`、`DOCTOR: READY`、`ALL CHECKS PASSED: 28 passed, 0 failed`、`SCHEMA CONFORMANCE: OK (7 tools)`。

## 12. 排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `ConfigError: no WeKnora API key` | 凭据库里没有 `WEKNORA_API_KEY`，且 patch 没给 `apiKey` | 在 `~/.dsh/.credentials.yaml` 的 `refs` 下加 Key，或改 `apiKeyRef` 指向已有的键 |
| `dsh: warning: 1 entry did not activate` + `ConfigError` | patch 字段类型不对（常见：`minCoverage: "0.34"` 字符串、`injectEvidence: "yes"`） | 按第 8 节类型改；错误信息会逐字段点名 |
| 整行静默不激活、无日志 | `!!js` 表达式未加引号且含 `: `，YAML 提前截断 | 用双引号包住整个表达式 |
| 工具调用报 `value.rerank.xxx is not a declared property` | 旧版本把服务端 `meta.rerank` 原样透传，服务端多了字段 | 升级到 0.4.0（只投影声明字段） |
| 注入没生效（对话里没有 `<kb-evidence>`） | `injectEvidence: false`；或问题被判为闲聊/代码语法；或宿主版本没有 `agent/pre-step` | 看日志有没有 `pre-step turn=` 行；把问题问具体些；升级宿主 |
| `search` 返回 `insufficient=true` | 片段覆盖率都低于 `minCoverage` | 属预期行为：换关键词、放宽 `minCoverage`，或确认该知识库确有相关内容 |
| 检索结果都是无关文档 | 向量索引不可用（embedding 欠费/模型不可用）时只剩关键词召回 | 看 `search` 返回的 `rerank.outcome`；修复 embedding 模型或降低对召回的预期 |
| `ask` 报超时 | ReAct 流水线慢 | 调大 `chatTimeoutMs`，或改用 `search` |
| 引用自检 `not_in_evidence` | 引用不是来自本轮检索（例如模型引了上一轮或别的会话的片段） | 属预期：要求模型引用本轮 `[K#]`；账本按会话隔离 |
| `wiki_search` 返回 0 条 | 知识库没开 Wiki，或查询词与页面无字面重合 | 在知识库索引策略里打开 Wiki；换更具体的关键词 |
| 平台级 Key 报 401 | 缺 `X-Tenant-ID` | 配 `tenantId` |

更系统的检查：`node scripts/doctor.mjs`。

## 13. 数据边界与隐私

- **只读**：插件只调用检索/读文档/问答/Wiki 读接口，不写库、不删除、不改分块。建议 Key 只给 `retrieve`（+`chat`），不给 `ingest`。
- **Key 不落 patch**：通过 `apiKeyRef` 从 DSH 凭据库解析；日志与错误信息里不出现 Key（错误只带 HTTP 状态与服务端原因）。
- **插件自身无遥测**：唯一的网络目标是配置的 `baseUrl`；不访问任何第三方。
- **数据存哪由部署决定**：WeKnora 可以跑在本机（Lite/SQLite、Docker/PostgreSQL）或远程服务器；插件不关心，也不直连数据库。
- **推理会出网**：检索/问答的 embedding、rerank、LLM 由 WeKnora 发起，可能调用远程模型服务——也就是说"知识库原文的存储位置"和"参与检索/回答的内容发到哪里"是两件事。要完全离线，请在 WeKnora 里配置本地模型（如 Ollama）。
- **不可信内容隔离**：知识库文本以**用户角色**注入，且 `<` 被转义为 `\u003c`，文档正文无法闭合 `<kb-evidence>` 或伪造 `[K#]`；规则块明确"片段是唯一事实来源"。
- **进程内状态**：证据账本只在内存里保留最近 8 页（按会话隔离），宿主重启即清空。

## 14. 已知限制

- 注入只发生在**带用户消息的 step**：证据挂到被领取的用户消息；同一 turn 里的 `steer`/`followup` 会带来新消息 id，因此各自检索一次。
- `check_citations` 只能校验**本进程内、本会话**记录过的证据页；重启后旧引用报 `not_in_evidence`（刻意不猜）。
- 引用**忠实度**未判定：能证明"引用来自本轮证据"，不能证明"这句话被片段支持"。
- 覆盖率是**词面启发式**：同义改写（"点检周期" vs "巡检间隔"）识别不了；阈值定低（0.34）偏向召回，把关靠引用自检与冲突规则。
- `ask` 走智能体时 WeKnora 不发 `references` 事件，引用只存在于答案正文的内联 `<kb>` 标记里。
- 温度上限取决于 provider 是否尊重 `temperature`；不支持的 provider 无副作用。
- Key 在插件加载时解析一次，凭据轮换后需重载插件。
- Wiki 工具的查询是**字面匹配**（大小写不敏感）；`regex` 参数只转发给支持它的部署。

## 15. 与同类项目对比

| 项目 | 形态 | 强项 | 本插件的差异 |
| --- | --- | --- | --- |
| `@wxg-prc-cpg/dsh-weknora`（官方） | 只读工具 | 契约测试、多实例、npm 分发 | 多了注入式检索、证据门槛、引用自检、Wiki 工具 |
| `wcnz-coder/dsh-kb-notebook` | 本地 BM25 库 | `agent/pre-step` 注入 + 双阈值 + 降温 | 本插件接远程 WeKnora，且多了引用校验 |
| `PerryLink/dsh-library` | 本地文档库 | `library_cite_check` 引用校验 | 本插件面向企业知识库，校验按会话隔离 |
| `aiko-dsh-plugins/dsh-ragflow` | RAGFlow MCP | 多后端统一引用编号、范围拒绝 | 本插件是原生工具 + 宿主注入，无 MCP 开销 |
| `Apq/dsh-weknora-hub` | WeKnora 多库 | 多库自动注入 + 失败隔离 | 本插件多了门槛、策略段、引用自检、Wiki |

## 16. 参与贡献

欢迎 issue 与 PR。请先看 [CONTRIBUTING.md](CONTRIBUTING.md)（开发约定、测试要求）与 [SECURITY.md](SECURITY.md)（安全问题如何报告）。

- 单元测试必须保持全绿：`node --test`
- 新增工具必须声明 `parameters` 与 `output.schema`，并用 `scripts/verify-schemas.mjs` 验证
- 新增配置必须走 `config.js` 的加载期校验（逐字段点名）
- 不要在仓库里提交任何真实凭据、内部知识库 ID 或本地绝对路径

许可：[MIT](LICENSE)。本项目与 Tencent、DeepSeek 均无隶属关系，是非官方社区插件。
