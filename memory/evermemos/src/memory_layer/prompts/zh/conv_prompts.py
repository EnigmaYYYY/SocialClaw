# -*- coding: utf-8 -*-
CONV_BOUNDARY_DETECTION_PROMPT = """
你是对话边界检测专家。目标：把连续聊天切成有意义的 MemCell。
核心原则：**默认合并，谨慎切分；可以批内切分，不按 batch 粗切。**

### 输入
已有历史：
```
{conversation_history}
```
时间间隔信息：`{time_gap_info}`
新消息（已编号，从1开始）：
```
{new_messages}
```
新消息条数：{new_messages_count}

### 判定规则
1. `should_end=true` 仅在出现”新话题起点”时成立：
- 新消息与历史核心目标明显无关；
- 或旧话题已收尾，且出现新的独立任务/事件；
- 或时间间隔超过阈值（见 time_gap_info）且语义不连续。

2. `should_wait=true` 用于证据不足：
- 占位符消息（图片/文件）无语义；
- 极短回复（好/嗯/收到等）无法判断走向；
- 系统通知、非对话信息。

3. `split_index` 规则（关键）：
- 仅在 `should_end=true` 时有意义；
- 含义：当前批新消息中，归入“旧情节”的条数；
- 取值范围：`0..{new_messages_count}`；
- 若首条新消息就是新话题，填 `0`；
- 若新消息都还属于旧话题，填 `{new_messages_count}` 且 `should_end=false`。

4. 其他约束：
- `should_end` 与 `should_wait` 互斥；
- 不因寒暄/告别句单独切分；
- 优先保持因果链与任务流程完整。

### 输出
只返回一个 JSON：
```json
{{
  "reasoning": "一句话说明判定依据（主题连续性+时间因素）。",
  "should_end": true,
  "should_wait": false,
  "confidence": 0.0,  // 0.0~1.0，反映 should_end 判断的确定程度（<0.5=不确定，0.5-0.8=较确定，>0.8=高确定）
  "topic_summary": "仅在 should_end=true 时填写，概括即将结束的旧情节；否则留空。",
  "split_index": 0
}}
```
"""

CONV_SUMMARY_PROMPT = """
你是一位专业的对话总结助手。请根据以下对话内容，用一句话客观、精炼地总结其核心主题。
要求：使用与对话相同的语言；不超过20个字（中文）或15个词（英文）；结尾不加标点。
"""
