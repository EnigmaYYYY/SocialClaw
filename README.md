<div align="center">

# SocialClaw

[中文](./README.md) | [English](./README_EN.md)

</div>

SocialClaw 是一个“看得见聊天界面”的 AI 社交军师。它会直接观察聊天窗口、构建个性化记忆与画像，并在真实对话过程中实时给出更贴近上下文的回复建议。

如果这个项目对你有帮助，欢迎 star🌟。

## 我们为什么做 SocialClaw

SocialClaw 不是一个单纯的回复生成器。

它同时把这几件事串了起来：

- 从真实聊天界面做屏幕理解
- 从聊天记录构建个性化记忆和画像
- 基于“你是谁、对方是谁、发生过什么”来给建议
- 通过人格 skill 控制建议风格和社交策略

它想解决的不是“怎么生成一句话”，而是“怎么生成更像你、也更懂对方的一句话”。

在这个 AI 助手越来越盛行的时代，我们更希望 AI 用来**提升用户自己**，而不是直接替代用户。

所以 SocialClaw 的核心理念是：

- 不主动替用户发送消息
- 通过建议的方式辅助用户思考和表达
- 尽可能解释为什么这样回复更合适
- 让用户在长期使用中潜移默化地提升沟通能力

我们更认同的是“授人以鱼，不如授人以渔”。

## 这个项目最突出的优势

### 个性化记忆与画像系统

SocialClaw 会从聊天记录中同时构建 **用户画像** 和 **联系人画像**。

这里面包括：

- 用户的说话习惯与表达风格
- 联系人的身份、特征和偏好
- 双方关系中的事件与上下文记忆
- 在建议生成时参与检索和判断的长期记忆

这也是 SocialClaw 最值得突出的地方之一。更好的社交建议，不只来自当前这一条消息，而是来自：

- 你平时怎么说话
- 对方是什么样的人
- 你们之间已经发生过什么

### 内置且可扩展的人格 Skill 系统

人格 skill 是 SocialClaw 的核心增强能力之一。

项目默认内嵌了一批人格 skill，用户也可以上传新的 skill，进一步控制建议的风格和策略。

这类 skill 的典型用途包括：

- 构建导师风格的建议增强
- 模拟上司、同事、合作伙伴的沟通风格
- 给不同社交场景配置不同的话术策略
- 在同一轮对话上做多种风格对比

这让 SocialClaw 不只是“一个统一口吻的助手”，而是一个可控的社交建议增强平台。

### 屏幕感知的实时建议能力

SocialClaw 不依赖平台 webhook，而是通过 VLM 直接理解聊天界面截图，把屏幕内容转成结构化消息，再驱动后续记忆同步和建议生成。

### 对 OpenAI-compatible 与代理生态友好

Assistant、VLM 和记忆侧模型都围绕 OpenAI-compatible 接口设计，方便接入标准 provider、自建网关，或者 CLIProxyAPI 这类代理。

## 隐私与安全

SocialClaw 强调本地优先。

当前项目中的聊天记录文件、记忆文件、画像数据和运行时缓存，默认都放在用户本地环境中，由用户自己掌控。

这意味着：

- 敏感聊天内容不会被项目额外托管到一个中心化平台
- 用户可以自己管理本地文件和数据生命周期
- 更适合对隐私、安全和可控性要求较高的使用场景

当然，模型调用本身仍然取决于你接入的 provider 或代理，所以最终隐私边界也取决于你自己的模型部署选择。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 屏幕感知监控 | 监控聊天窗口变化，并从截图里提取结构化消息 |
| 个性化记忆与画像 | 构建用户记忆、联系人记忆、画像更新与检索上下文 |
| 实时回复建议 | 结合当前对话与长期记忆生成候选回复 |
| 人格 skill 增强 | 通过内置或自定义 skill 调整建议风格和策略 |
| 历史聊天导入与回填 | 导入旧聊天数据并重建记忆系统 |
| 可操作的前端设置 | 在 UI 中直接配置模型、stream 策略、记忆操作与监控行为 |

## 当前最适合的使用场景

SocialClaw 目前最适合这类对话场景：

- 回复频率不需要特别快
- 回复内容需要稍微思考、斟酌和组织
- 你希望结合历史上下文、人设风格、关系记忆来做更稳妥的表达

比较典型的例子包括：

- 职场沟通
- 关系维护
- 较重要的私聊回复
- 需要拿捏语气、分寸和策略的对话

## 当前不太适合的场景

由于项目当前依赖视觉模型做聊天界面解析，所以它并不适合回复节奏特别快的场景。

比如：

- 高频即时对打式聊天
- 秒级连续回复的群聊场景
- 需要极低延迟反馈的实时沟通

换句话说，SocialClaw 更适合“值得想一想再回”的聊天，而不是“必须马上回”的聊天。

## 先看这些文档

| 文档 | 适合什么时候看 |
| --- | --- |
| [模型配置指南](docs/model/model-configuration-guide.md) | 配 Assistant、VLM、Embedding、Rerank、CLIProxyAPI，理解 `.env` 和 UI 设置 |
| [记忆操作指南](docs/memory/memory-operations-guide.md) | 导入旧聊天、回填记忆、查看画像、重建记忆、编辑资料 |
| [EverMemOS 记忆构建与检索指南](docs/memory/evermemos-memory-build-retrieval-guide.md) | 理解记忆如何被构建、存储、检索并参与回复生成 |
| [旧聊天记录采集指南](docs/chat_record/old-chat-record-acquisition.md) | 获取和导入历史微信聊天记录 |
| [视觉监控调试指南](docs/visual_monitor/visual-monitor-debugging-guide.md) | 调 ROI、截图频率、识别调试和视觉链路排查 |

## 快速开始

### 推荐顺序

现在推荐走 **CLI-first + UI-first** 的启动路径：

- CLI 负责检查环境、生成本地启动配置、拉起前后端
- 设置页面负责填写 Assistant / VLM / EverMemOS 的模型接口与 API key
- 根目录 `.env` 和 `memory/evermemos/.env` 默认只作为 bootstrap / advanced 配置入口，不再要求第一次使用就手工填满

### 1. 克隆仓库

```bash
git clone https://github.com/EnigmaYYYY/SocialClaw.git
cd SocialClaw
```

### 2. 准备运行环境

先准备 Visual Monitor 的 Conda 环境：

```bash
conda create -n social_copilot python=3.12 -y
conda activate social_copilot
pip install -r social_copilot/visual_monitor/requirements.txt
```

再安装 EverMemOS 运行环境：

```bash
cd memory/evermemos
uv sync
cd ../..
```

最后安装前端依赖：

```bash
cd social_copilot/frontend
npm install
cd ../..
```

### 3. 初始化本地启动配置

```bash
npm run doctor
npm run init
```

这一步会：

- 检查 Node / Docker / `uv` / Python 路径
- 自动生成缺失的 `.env` 和 `memory/evermemos/.env`
- 生成本地 CLI 配置 `.socialclaw/config.json`

在 macOS 下，CLI 默认会优先使用：

```bash
/Applications/miniconda3/envs/social_copilot/bin/python
```

如果你的 Visual Monitor Python 路径不同，直接编辑 `.socialclaw/config.json` 即可。

### 4. 一键启动整套服务

```bash
npm run start
```

这条命令会一键拉起：

- EverMemOS Docker 依赖
- EverMemOS API
- Visual Monitor API
- Electron 前端开发进程

停止整套服务：

```bash
npm run stop
```

### 5. 在设置页填写模型配置

启动后进入主界面的设置页，填写：

- Assistant 模型地址 / API key / 模型名
- 视觉模型地址 / API key / 模型名
- EverMemOS LLM / Vectorize / Rerank 模型配置

保存后，这些配置会：

- 持久化到本地应用设置
- 同步到运行中的 Visual Monitor 后端
- 同步到运行中的 EverMemOS 后端

也就是说，**默认使用路径下，模型配置不再要求你第一次启动前就手工改两份 `.env`**。

## CLI 命令

### 直接用 npm 安装 CLI

如果后续你通过 npm 全局安装这个 launcher，可以直接这样用：

```bash
npm install -g socialclaw
socialclaw init
socialclaw doctor
socialclaw start
socialclaw stop
```

这里的 `socialclaw init` 会在默认路径下 bootstrap 一份项目工作目录，并记住它的位置。  
如果你想指定路径：

```bash
socialclaw init --project-dir /your/path/SocialClaw
```

之后即使你不在仓库目录里，也可以继续直接运行 `socialclaw doctor/start/stop`。

### Git clone 后直接使用

如果你是直接 clone 仓库，本地用法保持不变：

```bash
npm run doctor
npm run init
npm run start
npm run stop
```

### Windows

如果你通过 npm 全局安装，命令名就是：

```powershell
socialclaw doctor
socialclaw init
socialclaw start
socialclaw stop
```

在当前仓库内，本地等价命令是：

```powershell
npm run doctor
npm run init
npm run start
npm run stop
```

Windows 现有底层脚本仍然可直接使用：

```powershell
scripts\start_social_stack.cmd
```

或者：

```powershell
.\scripts\start_social_stack.ps1
```

### macOS / shell 环境

当前 CLI 在 macOS / shell 下会包装现有脚本：

- 后端底层脚本：`./scripts/start_socialclaw.sh`
- 前端底层命令：`cd social_copilot/frontend && npm run dev`

如果你只想启动后端，也可以：

```bash
node ./bin/socialclaw.js start --backend-only
```

停止时：

```bash
node ./bin/socialclaw.js stop
```

## 手动启动方式

如果你想自己控制每个服务，再走手动方式：

1. 先准备 Visual Monitor 的 Conda 环境
2. 在 `memory/evermemos` 里准备 `.env` 并启动 Docker 依赖
3. 启动 EverMemOS API，默认 `127.0.0.1:1995`
4. 启动 Visual Monitor API，默认 `127.0.0.1:18777`
5. 在 `social_copilot/frontend` 中启动 Electron 前端
6. 进入设置页面填写 Assistant、VLM 和 EverMemOS 模型配置
7. 只有在需要 headless / 高级控制时，再去编辑根目录 `.env`

## 最低环境要求

| 依赖 | 说明 |
| --- | --- |
| Python 3.12 | EverMemOS 依赖 `>=3.12,<3.13` |
| Conda | 推荐用于 Visual Monitor 运行环境 |
| Node.js 20+ | Electron 前端需要 |
| Docker | EverMemOS 数据存储依赖 |
| OpenAI-compatible 文本模型 | Assistant 和记忆侧 LLM 工作流使用 |
| VLM 接口 | 用于截图识别 |
| Embedding + Rerank 服务 | 用于记忆检索和排序 |

## 它的工作链路

1. Visual Monitor 监控聊天窗口，并把截图转成结构化消息。
2. 前端负责协调事件轮询、记忆同步、画像更新和建议生成。
3. EverMemOS 更新长期记忆和联系人画像，随后建议生成使用“当前消息 + 长期上下文”产出候选回复。

也就是这样一条链：

- 屏幕出现新消息
- 截图被解析成聊天事件
- 记忆和画像被更新
- 当前会话收到回复建议

## 模型配置为什么重要

SocialClaw 实际上分了三类模型角色：

- Assistant 模型：负责回复建议
- Vision 模型：负责截图识别
- 记忆侧 LLM：负责记忆提取、画像生成与检索编排

因为整体走 OpenAI-compatible 协议，所以你可以自由混搭不同 provider 或代理。一个常见方案是：

- 用 CLIProxyAPI 或其他代理承担 Assistant / VLM
- 用本地或远程 embedding 服务做向量检索
- 用独立 rerank 服务做排序增强

同时，设置页已经支持 Assistant 和 VLM 的 `stream / non_stream` 调用策略切换，这一点对代理兼容性很有帮助。

## 配置入口

默认推荐把 **设置页面** 作为模型配置主入口。

根目录 `.env` 和 `memory/evermemos/.env` 现在更适合这些场景：

- headless / 脚本化启动
- 高级用户做统一环境变量管理
- 不通过 UI 的服务侧调试

最关键的配置分组：

| 配置组 | 变量 |
| --- | --- |
| Assistant | `SOCIAL_COPILOT_ASSISTANT_*` |
| Vision / VLM | `SOCIAL_COPILOT_VISION_*` 和 `SOCIAL_COPILOT_VLM_*` |
| EverMemOS / 记忆侧 | `SOCIAL_COPILOT_EVERMEMOS_*` 和 `LLM_*` |
| Embedding | `VECTORIZE_*` |
| Rerank | `RERANK_*` |
| 数据存储 | `REDIS_*`, `MONGODB_*`, `ES_*`, `MILVUS_*` |

详细 provider 和模型设置请直接看 [模型配置指南](docs/model/model-configuration-guide.md)。

## 仓库结构

```text
SocialClaw/
├── README.md
├── README_EN.md
├── LICENSE
├── .env.example
├── scripts/
│   ├── start_social_stack.cmd
│   ├── start_social_stack.ps1
│   ├── stop_social_stack.cmd
│   ├── stop_social_stack.ps1
│   ├── start_socialclaw.sh
│   └── stop_socialclaw.sh
├── social_copilot/
│   ├── frontend/
│   ├── visual_monitor/
│   ├── agent/
│   └── agent_runtime/
├── memory/
│   └── evermemos/
└── docs/
```

## TODO / Roadmap

我们接下来还希望继续优化这些部分：

- 继续增强个性化记忆系统，让更多长期沉淀能力能更自然地转化成 skill
- 优化 UI 界面与交互体验，让配置、建议查看、记忆管理更顺手
- 支持用户直接在 UI 中查看和调整聊天记录文件内容
- 继续优化 persona skill 的使用体验、导入体验和管理体验
- 提升视觉链路在真实使用中的稳定性与可解释性

也欢迎大家：

- 提出宝贵意见
- 提交 issue 和改进建议
- 一起参与共创和迭代
- 贡献新的 persona skill、工作流或产品想法

## 开源协议

本项目使用 [MIT License](./LICENSE)。

## 致谢

SocialClaw 的设计、实现或灵感参考了以下项目：

- [EverOS / EverMemOS](https://github.com/EverMind-AI/EverOS.git)，记忆系统构建来源
- [kkclaw](https://github.com/kk43994/kkclaw.git)，悬浮球 UI 设计灵感来源
- [awesome-persona-distill-skills](https://github.com/xixu-me/awesome-persona-distill-skills)，默认人格 skill 搜集参考来源
