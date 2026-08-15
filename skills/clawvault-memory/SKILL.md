---
name: clawvault-memory
description: Durable-memory workflow for the ClawVault plugin. Activate whenever the user asks you to remember, recall, "what did we…", or when a fact is worth keeping across sessions. Enforces search-before-answer and verify-before-save so memory holds checked facts, not guesses.
metadata: { "openclaw": { "emoji": "🐘", "homepage": "https://github.com/davidtkeane/openclaw-plugin-clawvault" } }
---

# ClawVault Memory Skill 🐘

ClawVault is a persistent SQLite + FTS5 memory. This skill is the *discipline* for using
it well: an agent that searches before it answers, verifies before it saves, and never lets
a made-up "fact" into long-term memory.

> Requires the **ClawVault plugin** (`openclaw plugins install clawhub:clawvault` or from
> [GitHub](https://github.com/davidtkeane/openclaw-plugin-clawvault)), which provides the
> `clawvault_*` tools this skill drives.

## When to activate

- The user says **"remember this"**, "save that", "note that", or "don't forget…"
- The user asks **"what did we…"**, "what do you know about…", "did we already…"
- You learn a durable fact, decision, or preference worth keeping across sessions
- You're about to state a fact you're not certain of

## The workflow

### 1. Search before you answer
Before answering a factual question about past work, the user, or this system, call
**`clawvault_search`** first. Don't guess what you may already have stored.

```
clawvault_search({ query: "exo qwen models openclaw" })
```

### 2. Verify before you save
Only save what you have actually checked. Prefer **ground truth** over memory:
run the command, read the file, query the DB, or check the internet. Then save with a
**source** and **verified: true**.

```
clawvault_save({
  content: "exo serves Qwen models to OpenClaw on 127.0.0.1:52415",
  memory_type: "fact",
  source: "curl http://127.0.0.1:52415/v1/models",
  verified: true
})
```

If you could **not** verify it, save it as a question to confirm — never as truth:

```
clawvault_save({ content: "…", memory_type: "unverified" })
```

### 3. Don't repeat yourself
`clawvault_save` refuses a near-duplicate and returns the existing id. Don't force a
copy — update or consolidate instead.

### 4. Consolidate when memory gets noisy
Use **`clawvault_consolidate`** to gather related memories on a topic, distil them into one
durable `insight`, then save it with `supersedes:[ids]` to soft-retire the raw rows.

```
clawvault_consolidate({ topic: "clawvault deployment" })
// …synthesize the returned cluster, then:
clawvault_save({ content: "<synthesis>", memory_type: "insight", verified: true, supersedes: [9,10,11] })
```

## The rules (verify-before-save)

1. Never present a guess as a fact. If unchecked, say *"I'm not certain — let me verify."*
2. Prefer ground truth (run/read/fetch) over your own memory.
3. Record the **source** on every saved fact. A memory with no source is a hypothesis.
4. Only verified facts become memories; unverified → `memory_type: "unverified"`.
5. Tell-vs-do: if you claim you saved something, verify it actually landed. **Never claim, always check.**

## The 3-question test
Before stating **or** saving any claim: (1) Where did I learn this? (2) Can I check it cheaply now?
(3) What would prove me wrong? If the honest answer to #1 is "it just feels right" — stop and verify.

## Tools this skill uses
- `clawvault_save` — store a memory (with `source`, `verified`, dedup guard, `supersedes`)
- `clawvault_search` — FTS5 relevance-ranked recall
- `clawvault_recent` — timeline of recent memories
- `clawvault_consolidate` — cluster related memories to synthesize into one insight
- `clawvault_stats` — totals, verified count, superseded count
