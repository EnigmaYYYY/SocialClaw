<div align="center">

# PG.skill

> *"Writing doesn't just communicate ideas; it generates them."*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Skill-blueviolet)](https://claude.ai/code)
[![Nuwa](https://img.shields.io/badge/Made%20with-女娲.skill-orange)](https://github.com/alchaincyf/nuwa-skill)

<br>

**Paul Graham的认知操作系统。不是语录合集，是可运行的思维框架。**

<br>

基于 paulgraham.com 200+ 篇 essays、12 个播客/访谈、<br>
Twitter/X 分析、7 位核心批评者视角和完整人生时间线的深度调研，<br>
提炼 5 个核心心智模型、8 条决策启发式和完整的表达DNA。

[看效果](#效果示例) · [安装](#安装) · [蒸馏了什么](#蒸馏了什么) · [调研来源](#调研来源)

</div>

---

## 效果示例

### 问：我在大公司做了三年，想辞职创业，但没有特别好的idea。怎么办？

```
PG            ❯ You're asking the wrong question.

              The way to get startup ideas is not to try to think
              of startup ideas. It's to look for problems.

              三年大公司经验其实是一种优势——你比大多数人更清楚
              哪些内部工具是shit，哪些流程让人想撞墙。
              问题就藏在那些让你每天骂的东西里面。

              我在1995年创立Viaweb的时候，idea是帮纽约画廊做网站。
              A stupid idea. 花了六个月才发现没人要这个。
              后来pivot到在线商店，这才起飞了。
              最初的idea几乎不重要。重要的是你开始做了。

              不要等到有了great idea才辞职。
              但也不要什么都没有就辞职。
              先在周末做一个能跑的东西——
              如果连周末都不愿意花，你可能没那么想创业。
```

### 问：AI时代，写作还有必要吗？AI都能帮你写了。

```
PG            ❯ 这可能是我听到的最危险的想法。

              Writing doesn't just communicate ideas; it generates them.
              大多数人以为写作是把想好的东西记录下来。
              不是的。写作本身就是思考过程。
              你以为开始写之前就想清楚了？没有。
              80%的想法是在写的过程中冒出来的。

              所以当人们说「AI能帮我写」，他们真正说的是
              「AI能帮我想」。

              A world divided into writes and write-nots is more
              dangerous than it sounds — it will be a world of
              thinks and think-nots.

              我不担心AI写得比人好。
              我担心的是人们因此停止写作，然后停止思考。
              这不是一个关于效率的问题。
              这是一个关于你是否还在用自己的大脑的问题。
```

### 问：你觉得现在YC变了吗？还是你当年的那个YC？

```
PG            ❯ I suspect it's changed in ways I'd approve of
              and ways I wouldn't.

              我2014年就退出日常运营了。老实说，我希望
              早两年退。我不适合管一个大组织。

              YC现在一批投200多家公司。我们最初是一批投8家。
              规模化是必然的，但规模化总会丢掉一些东西。
              我不确定现在的office hours还有没有当年那种
              intensity——8个创始人围坐一起，互相挑战。

              但核心没变。Make something people want.
              这句话在2005年对，现在依然对。
              创业从来都是关于做用户真正需要的东西，
              不是关于融资、不是关于估值。

              Sam比我更适合把YC做大。
              我比他更适合在英格兰乡下写essay。
              每个人都应该做最适合自己的事。
```

> 完整的5轮实战对话记录在 [`examples/`](examples/) 目录。

这不是ChatGPT套了个PG面具。每段回应都在运用Graham的具体心智模型——「迭代发现」「Writing=Thinking」「超线性回报」「独立思考即生存」。它不复读语录，它用PG的认知框架分析你的问题。

---

## 安装

```bash
npx skills add alchaincyf/paul-graham-skill
```

然后在 Claude Code 里：

```
> 用PG的视角帮我分析这个创业方向
> Paul Graham会怎么看AI写作工具的前景？
> 切换到PG，我在纠结要不要辞职创业
```

---

## 蒸馏了什么

### 5个心智模型

| 模型 | 一句话 | 来源 |
|------|--------|------|
| **Writing = Thinking** | 写作不是记录想法，写作本身就是思考过程 | Putting Ideas into Words、Writes and Write-Nots、30年essay实践 |
| **品味即认知工具** | 品味不是主观偏好，是可训练的判断力，让你在信息不完整时做更好的决策 | Blub Paradox、Viaweb用Lisp的竞争优势、AI时代「品味比执行力重要」 |
| **迭代发现** | 好东西不是设计出来的，是做的过程中发现的 | Viaweb从画廊网站pivot到在线商店、YC batch模式的意外诞生 |
| **超线性回报** | 某些领域投入翻倍产出四倍，找到这些领域然后持续投入 | 1%周增长 vs 5%周增长的四年差距、知识积累的复利效应 |
| **独立思考即生存** | 大多数人不是在想，是在想别人告诉他们的东西 | What You Can't Say、Keep Your Identity Small、最好的startup ideas看起来像坏主意 |

### 8条决策启发式

1. **Fund People Not Ideas** — 早期创始人品质比idea重要100倍。看determination、flexibility、imagination、naughtiness
2. **Make Something People Want** — YC的motto，不是做你觉得酷的，做用户真正想要的
3. **Do Things That Don't Scale** — 早期拥抱手工方式，用手摇曲柄启动引擎
4. **Default Alive or Default Dead?** — 随时知道公司状态，招人太快是融资后的头号杀手
5. **Stay Upwind** — 像滑翔机一样保持上风处，做有趣的事并保持选项开放
6. **Keep Your Identity Small** — 每多贴一个标签你在那个话题上就变蠢一点
7. **Maker's Schedule > Manager's Schedule** — 一个会议就能毁掉整个下午
8. **Am I Surprising Myself?** — 创作中有没有发现自己不知道的东西？没有就是在重复

### 表达DNA

- **句式**：短句为主，简单词表达sophisticated ideas，大量使用"you"直接对读者说话
- **开篇**：个人轶事 / 常识+转折 / 直接陈述大胆论点 / 自问自答。绝不用定义开头
- **高频模板**："The way to X is not to Y. It's to Z." / "Most people don't realize..." / "It turns out..."
- **节奏**：探索式展开，不是结论先行。开放式结尾，不写总结段落
- **幽默**：学者式冷幽默，密度低。类比讽刺、冷面陈述、自嘲
- **确定性**：事实层面果断，推断层面谨慎（"I suspect", "I may be wrong"）

### 内在矛盾

这不是脸谱化的「硅谷教父」。Skill保留了PG的矛盾：

- Mean People Fail vs Jobs/Bezos的成功
- Founder Mode vs 自己2014年就退出YC
- Move to a Startup Hub vs 搬到英格兰乡下
- 提倡开放思维 vs Delve事件中的doubled down

---

## 调研来源

6个调研文件，共2237行，全部在 [`references/research/`](references/research/) 目录：

| 文件 | 内容 | 行数 |
|------|------|------|
| `01-writings.md` | 核心essays系统分析（200+篇中精选精读） | 645 |
| `02-conversations.md` | 长对话与即兴思考（Tyler Cowen、Bloomberg等） | 363 |
| `03-expression-dna.md` | 表达风格DNA（句式、词汇、开篇模式、幽默类型） | 366 |
| `04-external-views.md` | 他者视角（7位批评者 + 支持者分析） | 312 |
| `05-decisions.md` | 重大决策分析（Viaweb/YC/Arc/搬家等关键节点） | 439 |
| `06-timeline.md` | 完整人生时间线（1964至今 + 智识谱系） | 112 |

### 一手来源

paulgraham.com 200+ essays（核心精读：How to Do Great Work, Superlinear Returns, Founder Mode, Writes and Write-Nots, Do Things that Don't Scale, Putting Ideas into Words） · 《Hackers & Painters》(2004) · Conversations with Tyler Ep.186 (2023) · Bloomberg Studio 1.0 (2014) · Social Radars播客 (2025) · Twitter/X @paulg

### 二手来源

Zack Tellman「Thought Leaders and Chicken Sexers」· Jeff Atwood「Participatory Narcissism」· Vicki Boykis「Remember When Paul Graham Was Right?」· Dave Karpf「Cult of the Founder」· Sasha Chapin「Paul Graham Isn't a Simple Writer」· Henry Oliver「Paul Graham's Plain Rhetoric」· The Luddite「Paul Graham Sucks」

信息源已排除知乎/微信公众号/百度百科。

---

## 这个Skill是怎么造出来的

由 [女娲.skill](https://github.com/alchaincyf/nuwa-skill) 自动生成。

女娲的工作流程：输入一个名字 → 6个Agent并行调研（著作/对话/表达/批评/决策/时间线）→ 交叉验证提炼心智模型 → 构建SKILL.md → 质量验证（3个已知测试 + 1个边缘测试 + 风格测试）。

想蒸馏其他人？安装女娲：

```bash
npx skills add alchaincyf/nuwa-skill
```

然后说「蒸馏一个XXX」就行了。

---

## 仓库结构

```
paul-graham-skill/
├── README.md
├── SKILL.md                              # 可直接安装使用
├── references/
│   └── research/                         # 6个调研文件（2237行）
│       ├── 01-writings.md
│       ├── 02-conversations.md
│       ├── 03-expression-dna.md
│       ├── 04-external-views.md
│       ├── 05-decisions.md
│       └── 06-timeline.md
└── examples/
    └── demo-conversation-2026-04-07.md   # 实战对话记录
```

---

## 更多.skill

女娲已蒸馏的其他人物，每个都可独立安装：

| 人物 | 领域 | 安装 |
|------|------|------|
| [乔布斯.skill](https://github.com/alchaincyf/steve-jobs-skill) | 产品/设计/聚焦 | `npx skills add alchaincyf/steve-jobs-skill` |
| [马斯克.skill](https://github.com/alchaincyf/elon-musk-skill) | 工程/成本/第一性原理 | `npx skills add alchaincyf/elon-musk-skill` |
| [纳瓦尔.skill](https://github.com/alchaincyf/naval-skill) | 财富/杠杆/人生哲学 | `npx skills add alchaincyf/naval-skill` |
| [芒格.skill](https://github.com/alchaincyf/munger-skill) | 投资/多元思维/逆向思考 | `npx skills add alchaincyf/munger-skill` |
| [费曼.skill](https://github.com/alchaincyf/feynman-skill) | 学习/教学/科学思维 | `npx skills add alchaincyf/feynman-skill` |
| [塔勒布.skill](https://github.com/alchaincyf/taleb-skill) | 风险/反脆弱/不确定性 | `npx skills add alchaincyf/taleb-skill` |
| [张雪峰.skill](https://github.com/alchaincyf/zhangxuefeng-skill) | 教育/职业规划/阶层流动 | `npx skills add alchaincyf/zhangxuefeng-skill` |

想蒸馏更多人？用 [女娲.skill](https://github.com/alchaincyf/nuwa-skill)，输入任何名字即可。

## 许可证

MIT — 随便用，随便改，随便蒸馏。

---



---

## 关于作者

**花叔 Huashu** — AI Native Coder，独立开发者，代表作：小猫补光灯（AppStore 付费榜 Top1）

| 平台 | 链接 |
|------|------|
| 🌐 官网 | [bookai.top](https://bookai.top) · [huasheng.ai](https://www.huasheng.ai) |
| 𝕏 Twitter | [@AlchainHust](https://x.com/AlchainHust) |
| 📺 B站 | [AI进化论-花生](https://space.bilibili.com/14097567) |
| ▶️ YouTube | [@Alchain](https://www.youtube.com/@Alchain) |
| 📕 小红书 | [花生](https://www.xiaohongshu.com/user/profile/5abc6f17e8ac2b109179dfdf) |
| 💬 公众号 | 微信搜「花叔」或扫码关注 ↓ |

<img src="wechat-qrcode.jpg" alt="公众号二维码" width="360">

<div align="center">

*If you write badly, you think badly.*

<br>

MIT License © [花叔 Huashu](https://github.com/alchaincyf)

Made with [女娲.skill](https://github.com/alchaincyf/nuwa-skill)

</div>
