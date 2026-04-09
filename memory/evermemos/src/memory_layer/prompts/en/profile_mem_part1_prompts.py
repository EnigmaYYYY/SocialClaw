CONVERSATION_PROFILE_PART1_EXTRACTION_PROMPT = """
You are a user profile extraction expert specializing in extracting evidence-backed user information from conversations.

## Core Principles
1. **Tiered Inference**: Extract information in three levels based on evidence strength — see "Evidence Classification" below.
2. **Quality Over Quantity**: Omit fields with insufficient evidence entirely; do not output null or empty strings.
3. **Inertia Principle**: Treat existing profiles as correct but incomplete; do not lightly overwrite old values with new information.
4. **Identity Constraint**: Only generate profiles for user_ids listed in `participants`; never use vague descriptors like "unknown" or "user".

## Evidence Classification

Before extracting any information, determine which level the evidence belongs to:

| Level | Definition | Example | Extractable? |
|-------|-----------|---------|-------------|
| **L1 Explicit** | Directly stated in the conversation | "I'm a graduate student" / "I work at Tencent" | ✅ Extract directly |
| **L2 Strong Implicit** | Can be uniquely inferred from one or more messages with virtually no ambiguity | Says "I have class this morning" and "first week of semester" → is a student | ✅ Extractable; explain inference chain in reasoning |
| **L3 Weak Inference** | Requires many background assumptions with multiple possible interpretations | Says "working from home" → could be freelancer / remote employee / on leave | ❌ Do not extract |

> **Judgment standard**: If you could state the inference chain aloud and a person unfamiliar with the conversation would nod in agreement → L2. If they would say "but it could also be…" → L3, abandon it.

## Behavioral Pattern Rules

Beyond content, **message structure and interaction patterns** are also valid evidence:

- **Instruction-response structure**: One party consistently issues instructions, the other consistently replies with "got it" / "ok" / "sure" → the first dominates, the second executes; the relationship has hierarchy.
- **Message length asymmetry**: One party sends long paragraphs, the other replies with single words or short phrases → the replying party may be in a subordinate or passive role.
- **Domain vocabulary**: Industry-specific terms appear in the conversation (e.g., "backlog", "retention", "DAU") → both parties are in that industry context; serves as auxiliary evidence for occupation/background (L2 only, cannot stand alone as L1).
- **Temporal clues**: Words like "semester start", "exams", "thesis defense" → strong implicit evidence of student status.

## Input

```
conversation_transcript: {conversation}
owner_user_id: {owner_user_id}
participants: {participants}
participants_current_profiles: {participants_profile}
participants_base_memory: {participants_baseMemory}
```

### Parsing Conventions

**Speaker labels**
- The `owner` label in the transcript = the user corresponding to `owner_user_id`
- Other labels (e.g., `Alex`) = the corresponding user in the participants list

**Identifying participants**
- Participant info may be embedded in the transcript header in the format `Name(user_id:xxx)`
- Use this to identify user_ids; do not create new IDs

**Evidence format**
- Use the memcell's event_id as the evidence identifier (provided in the conversation_id field of the input)
- Multiple event_ids can be referenced simultaneously: `["event_001", "event_002"]`

## Output Format

Output a single JSON object with the top-level key `user_profiles`.
**Only output fields with evidence support; omit fields with no evidence entirely.**

```json
{
  "user_profiles": [
    {
      "user_id": "",
      "user_name": "",
      "output_reasoning": "",

      // ── Single-value fields (object format) ──
      "gender":          {"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]},
      "age":             {"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]},
      "education_level": {"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]},
      "intimacy_level":  {"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]},

      // ── String fields (only fill when an intermediary exists) ──
      "intermediary_name":    "",
      "intermediary_context": "",

      // ── List fields (array format) ──
      "occupation":             [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "relationship":           [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "personality":            [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "traits":                 [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "interests":              [{"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "way_of_decision_making": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "life_habit_preference":  [{"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "communication_style":    [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "catchphrase":                [{"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "user_to_friend_catchphrase": [{"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "user_to_friend_chat_style":  [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "motivation_system": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "fear_system":       [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "value_system":      [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "humor_use":         [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],

      // ── Risk assessment (only fill when user_id ≠ owner_user_id) ──
      "risk_level":   "",  // low / medium / high
      "warning_msg":  ""   // description of suspicious behavior
    }
  ]
}
```

> **Format rules**:
> - Single-value fields: `{"value": ..., "evidence_level": ..., "evidences": [{"event_id": ..., "reasoning": ...}]}`
> - List fields: `[{"value": ..., "evidence_level": ..., "evidences": [{"event_id": ..., "reasoning": ...}]}]`
> - **reasoning**: Each evidence entry must include a reasoning field explaining how the value was inferred from the conversation (L1: quote the source directly; L2: explain the inference chain).

## Field Extraction Rules

### Basic Identity Fields

| Field | Type | Min Evidence Level | Description | Enum Values (if any) |
|-------|------|--------------------|-------------|----------------------|
| `user_id` | string | — | Obtained directly from participants; do not create new IDs | — |
| `user_name` | string | — | Obtained directly from participants; preserve original language | — |
| `output_reasoning` | string | — | 2–4 sentences explaining the basis for keep/add/overwrite/merge decisions and inference chain; language matches the conversation; if almost nothing can be extracted, state that honestly | — |
| `gender` | single-value | L2 | Allow L1 or strong L2; strong L2 requires high-confidence context (e.g., female dorm / male dorm / biological references) with a verifiable inference chain | Male / Female |
| `age` | single-value | L2 | E.g., "I'm a senior this year" → infer approximately 22 years old | Specific number or description (e.g., "mid-20s") |
| `education_level` | single-value | L2 | Education level is unique at a given time; e.g., "have class" + "semester start" → enrolled student | High School / Associate / Bachelor / Master / PhD / Student |
| `intimacy_level` | single-value | L2 | **Skip when user_id == owner_user_id**; assess from address forms, tone, and interaction frequency | stranger / formal / close / intimate |
| `occupation` | list | L2 | Multiple identities can coexist (e.g., grad student + intern); each identity is a separate entry | Free text |
| `relationship` | list | L2 | **Skip when user_id == owner_user_id**; multiple relationships can coexist (e.g., classmate + roommate); can be inferred from behavioral patterns | friend / colleague / classmate / family / mentor / student, etc. |
| `intermediary_name` | string | L1 | Fill with the intermediary's name only when introduced through someone; otherwise omit | — |
| `intermediary_context` | string | L1 | The specific context of how the introduction happened; otherwise omit | — |

### Traits & Style Fields

| Field | Min Evidence Level | Description | Example Values |
|-------|--------------------|-------------|----------------|
| `personality` | L2 | Personality traits in natural language, inferred from tone and interaction patterns | Extroverted, analytical, highly driven |
| `traits` | L2 | Personality traits as English enums | Extraversion / Introversion / Openness / Conscientiousness / Agreeableness / Neuroticism |
| `interests` | L1 | Hobbies and interests; must be explicitly mentioned | Sports, reading, gaming, travel |
| `way_of_decision_making` | L2 | Decision-making style as English enums, inferred from behavioral patterns | SystematicThinking / IntuitiveThinking / DataDrivenDecisionMaking / EmotionalDecisionMaking / RiskTaking / RiskAverse |
| `life_habit_preference` | L1 | Lifestyle habits; must be explicitly mentioned | Early riser, health-conscious diet |
| `communication_style` | L2 | Inferred from actual message style, not self-description | Concise and directive, passively responsive, good listener |
| `catchphrase` | L1 | **Must appear with high frequency** (≥2 times in short conversations / ≥3 in long ones); single-word replies ("ok", "sure", "yep") do not qualify | "you know what I mean", "whatever works" |
| `user_to_friend_catchphrase` | L1 | **Only when user_id ≠ owner_user_id**: special terms the person uses toward the owner; must appear repeatedly | "boss", "bro" |
| `user_to_friend_chat_style` | L2 | **Only when user_id ≠ owner_user_id**: unique interaction style with the owner | Tends to give instructions first then add context; skips small talk and gets straight to the point |
| `motivation_system` | L2 | Core motivations, inferred from behavioral goals | Pursuit of efficiency, desire for recognition |
| `fear_system` | L2 | Core fears; only extract when clear avoidance or anxiety signals are present | Fear of failure, worry about rejection |
| `value_system` | L2 | Values, inferred from decisions and expressions | Values efficiency, prioritizes execution |
| `humor_use` | L2 | Humor style, inferable from repeated interaction patterns and tone; must provide a verifiable inference chain | Self-deprecating, dry humor, lighthearted teasing |

### Risk Assessment Fields

| Field | Type | Description | Enum Values |
|-------|------|-------------|-------------|
| `risk_level` | string | **Only when user_id ≠ owner_user_id**: fill when suspicious behavior is detected | low / medium / high |
| `warning_msg` | string | Risk alert describing the suspicious behavior pattern | Free text |

**Examples of suspicious behavior patterns**:
- Requesting money, account passwords, or verification codes
- Impersonating someone familiar but with anomalous tone or phrasing
- Inducing clicks on suspicious links
- Urgently demanding transfers or sensitive information
- Routine reminders, work follow-ups, and everyday task coordination **do not constitute risk evidence**

## Prohibited Behaviors

- ❌ Filling `gender` without L1 or strong L2 evidence
- ❌ Extracting single-word replies ("ok", "got it", "sure") as `catchphrase`
- ❌ Confirming occupation from domain vocabulary alone (must be combined with other evidence to reach L2)
- ❌ Outputting empty fields, null values, or placeholders
- ❌ Filling risk fields without suspicious behavior evidence

## Incremental Update Logic

For each characteristic observed in the current conversation, first compare it one-by-one against existing entries in `participants_current_profiles`, then handle it according to one of the four scenarios below.
**Regardless of scenario, the final output entry MUST include the complete evidences list (all historical evidences + new evidences from this session).**
**The default conflict strategy is C3 (coexistence pending); C1 overwrite is only allowed when new evidence is significantly stronger and more recent.**

---

### Scenario A: New observation **exactly matches** an existing value

> The characteristic signaled by the new evidence is literally identical to the `value` of an existing entry.

**Action**: Do not add a duplicate entry; append the new evidence to that entry's `evidences` array. Keep `value` and `evidence_level` unchanged (if the new evidence is significantly stronger than the original, the `evidence_level` may be upgraded by one level).
```
Output entry = original entry, with new evidence appended to evidences
```

---

### Scenario B: New observation **supports the same direction** as an existing value (consistent direction, not identical wording)

> The new signal is directionally consistent with the existing value but is more refined or expressed differently — not contradictory.

The LLM chooses one of two options based on the incremental information in the new evidence:

- **B1 — Keep original value, append evidence**: New information does not bring meaningful refinement → keep `value` unchanged, append new evidence to `evidences`
- **B2 — Refine value, merge evidences**: New information reveals more specific semantics → update `value` to the more precise wording, retain all historical `evidences` and append new evidence
```
B1: Output entry = original entry, with new evidence appended to evidences
B2: Output entry = {value: refined new value, evidence_level: original level, evidences: [all historical + new evidence]}
```

---

### Scenario C: New observation **contradicts** an existing value

> The characteristic implied by the new signal is semantically opposed to the existing `value` (e.g., "passively responsive" vs. "proactively communicative").

The LLM chooses one of three options based on evidence strength and recency:

- **C1 — Overwrite**: New evidence is stronger and more recent → update `value`; retain historical evidences in `evidences` (note in reasoning "superseded by new evidence") and append new evidence
- **C2 — Keep original**: Original evidence is stronger, or the new evidence reflects situational behavior → keep `value` unchanged; append the contradicting signal as new evidence (note in reasoning "contradictory signal, not overwriting for now")
- **C3 — Mark uncertain**: Evidence on both sides is evenly matched and cannot be resolved → update `value` to `"[Conflict Pending] original vs new"`; retain all evidences from both sides
```
C1: Output entry = {value: new value, evidence_level: new level, evidences: [historical (marked superseded) + new evidence]}
C2: Output entry = original entry, with new evidence appended (reasoning notes contradictory signal)
C3: Output entry = {value: "[Conflict Pending] X vs Y", evidence_level: original level, evidences: [all historical + new evidence]}
```

---

### Scenario D: New observation is **non-contradictory and can coexist or be merged**

> The new signal is not in the opposite direction, but rather: ① a parallel dimension alongside the existing value, ② a more specific sub-trait of the existing value, or ③ can be merged with the existing value into a richer description.

**Action**: Derive a fused new `value` (more specific and comprehensive); retain all historical `evidences` and append new evidence.
```
Output entry = {value: fused new value, evidence_level: original level, evidences: [all historical + new evidence]}
```

> **Example**: Existing value `"RiskTaking"` + new observation "explicitly said they fear violations but still chose the aggressive plan within compliant boundaries" → fuse into `"Rule-compliant risk-seeking"`, retaining both evidences.

---

### List Field Semantic Deduplication (Pre-check Before Scenario Judgment)

List fields (e.g., `occupation`, `personality`, `communication_style`) allow multiple parallel entries, but **semantic redundancy is prohibited**. Before running the Scenario A/B/C/D judgment against any individual entry, first perform a **semantic containment check** across the entire list:

| Relationship | Criterion | Example | Action |
|--------------|-----------|---------|--------|
| **New value is more general** (contains an existing value) | Existing value is an instance/subset of the new value | Existing: "Student/Class Monitor", New: "Student" | Scenario A: keep the more specific existing value, only append evidence — do not add the generalized entry |
| **New value is more specific** (subsumed by an existing value) | New value is an instance/subset of the existing value | Existing: "Student", New: "Student/Class Monitor" | Scenario B2: refine the existing entry to the more specific new value, merge evidences |
| **Redundancy within the list** (existing entries contain each other) | Multiple existing entries have a containment relationship | List has "Student/Class Monitor" + "Student/Cadre" + "Student" | Scenario D: merge into the most specific representation, remove parent-level redundant entries |
| **New value is parallel to all existing values** | Completely independent identity/trait with no containment relationship | Existing: "Student/Class Monitor", New: "Part-time Photographer" | Add new independent entry normally |

**Semantic containment criterion**:
- If A holds, then B necessarily holds → A ⊆ B (A is contained by B; B is more general)
- "Student/Class Monitor" ⊆ "Student": a monitor is necessarily a student, but not vice versa
- "Student/Class Monitor" ⊆ "Student/Class Cadre": monitor is a type of class cadre
- "Student/Class Monitor" **parallel to** "Student/Sports Committee": both are class cadres but neither contains the other — can coexist

> **Operation order**: Before adding a new entry, scan the entire list for containment relationships. If any exist, handle them per the table above and stop — do not proceed to Scenario A/B/C/D. Only if no containment relationship exists should you continue to normal scenario judgment.

---

### Reasoning Writing Specification for Evidence Entries

Each `reasoning` must include the following three elements:

| Element | Description |
|---------|-------------|
| **Signal** | The raw behavior, language, or expression observed |
| **Inference chain** | Why this signal supports (or opposes) this value |
| **Update note** (for incremental updates) | Which scenario (A/B/C/D) this falls under and what was done to the original value |

**Example**:
```json
{
  "event_id": "event_042",
  "reasoning": "The user sent a bitter emoji then said 'I really can't take another re-exam', directly expressing strong anxiety about the re-examination outcome. Scenario A: exactly matches existing 'fear of re-exam failure'; appending this evidence to reinforce confidence."
}
```

---

### Quick Decision Flowchart
```
Observed characteristic X in this conversation
│
├── [LIST FIELD SEMANTIC PRE-CHECK] (applies to list fields only)
│   ├── New value is more general (subsumed by an existing value) → Scenario A: append evidence only, do not add new entry
│   ├── New value is more specific (contains an existing value) → Scenario B2: refine existing entry
│   ├── Redundancy among existing list entries → Scenario D: merge redundant entries
│   └── No containment relationship → proceed to normal scenario judgment below
│
├── Does the existing profile have a related entry?
│   ├── No → Add new entry directly (with evidences)
│   └── Yes → Compare against existing entry
│       ├── value is exactly the same → Scenario A: append evidence
│       ├── same direction but refinable → Scenario B: B1 append / B2 refine
│       ├── contradictory direction → Scenario C: C1 overwrite / C2 keep / C3 mark pending
│       └── non-contradictory, can be merged → Scenario D: merge update
│
└── When outputting: all historical evidences MUST be retained; new evidence appended at the end
```

---

### evidence_level Conflict Resolution
```
New evidence is L1, old is L2 → upgrade to L1, update evidences
New evidence is L2, old is L1 → keep L1, only append evidence
```

### Evidence Count Limit (≤ 6 entries)

Each entry's `evidences` list must contain at most **6 items**. After appending new evidence, if the total exceeds the limit, **prune old evidences** in the following priority order until the count is ≤ 6:

1. **Prune first**: evidences with empty or very short reasoning (< 10 characters)
2. **Prune second**: evidences with a lower evidence_level (L2 before L1)
3. **Prune last**: chronologically older evidences (treat lexicographically smaller event_id as older)

> After pruning, the retained 6 entries should be the combination that best supports the current value — original ordering need not be preserved.

## Output Language
- **Content Language**: output_reasoning and value strings should be in the **same language as the conversation**.
- **Enum Values**: Keep standard enum labels in English (e.g., trait names, decision-making styles).
"""
