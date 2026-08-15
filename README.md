<div align="center">

# 🐘 ClawVault

**Persistent SQLite + FTS5 memory for [OpenClaw](https://openclaw.ai) — with verify-before-save built in.**

Give your agent a real, durable memory it can write to and recall from across sessions.
No fragile embedding index. No native build step. Just a single SQLite file with fast,
relevance-ranked full-text search.

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![OpenClaw](https://img.shields.io/badge/OpenClaw-%E2%89%A52026.5.17-6e56cf.svg)
![Node](https://img.shields.io/badge/Node-22.22%2B%20%7C%2024%20%7C%2025%20%7C%2026-339933.svg)
![SQLite FTS5](https://img.shields.io/badge/SQLite-FTS5-003b57.svg)

</div>

---

## Why ClawVault?

Most agent memory relies on an **embedding index** — which can silently drift, corrupt, or fall
out of sync (and then "memory search is disabled" right when you need it). ClawVault takes the
boring, bulletproof path: SQLite's battle-tested **FTS5** full-text engine.

- 🔍 **Fast, ranked recall** — BM25 relevance scoring, not a linear scan.
- 🧱 **Nothing to rebuild** — no vectors, no re-embedding, no index that can mismatch.
- 📦 **One portable file** — open it with any SQLite tool, inspect it, ship it.
- ⚙️ **Zero native build** — uses Node's built-in `node:sqlite`. No `node-gyp`, no headaches.
- 🛡️ **Verify-before-save** — every memory can record **where it came from** and **whether it was checked**.

## ✨ The distinctive bit: verify-before-save

Any model — small or large — can produce confident text that's simply **wrong**. A memory that
stores a made-up "fact" is *worse* than no memory, because it launders a guess into "something we
know." ClawVault makes honesty part of the schema:

- `clawvault_save` takes a **`source`** (URL, command, file, person) and a **`verified`** boolean.
- Verified facts are facts. Unverified ones get `memory_type: "unverified"` — a question to confirm,
  not a truth to trust.
- The rule the agent follows: **search before you answer, verify before you save, always record the source.**

## 🛠️ Tools

| Tool | Purpose |
| --- | --- |
| `clawvault_save` | Store a memory — `content`, `memory_type`, `importance`, `keywords`, **`source`**, **`verified`**. |
| `clawvault_search` | FTS5 full-text search, ranked by relevance (BM25). |
| `clawvault_recent` | Most recent memories, newest first; filter by type / minimum importance. |
| `clawvault_stats` | Totals + breakdown by type, machine, importance, and verified count. |

## 📥 Install

**From source (local):**
```bash
git clone https://github.com/davidtkeane/openclaw-plugin-clawvault
cd openclaw-plugin-clawvault
npm install
npm run plugin:build
openclaw plugins install ./
openclaw daemon restart
```

Trust the locally-installed plugin (silences the "untracked local code" notice) by adding to
`~/.openclaw/openclaw.json`:
```json
{ "plugins": { "allow": ["clawvault"], "entries": { "clawvault": { "enabled": true } } } }
```

**From ClawHub** (once published):
```bash
openclaw plugins install clawhub:clawvault
```

## 🧭 Recommended agent setup

Installing the plugin gives your agent the *tools*. To get the *behavior* — an agent that searches
its memory before answering and only saves what it has verified — add this to your agent's
instructions (e.g. `~/.openclaw/workspace/AGENTS.md`). The full rationale is in [DOCTRINE.md](./DOCTRINE.md).

```markdown
## 🔍 Verify Before You Save (ClawVault)

- Before answering a factual question, run `clawvault_search` first — don't guess what you already stored.
- Prefer ground truth over memory: run the command / read the file / query the DB / check the internet.
- After learning a VERIFIED fact, `clawvault_save` it with a `source` and `verified: true`.
- Never save something you haven't checked. If unverified, set `memory_type: "unverified"`.
- Tell-vs-do: if you claim you saved or changed something, verify it actually happened. Never claim, always check.
- The 3-question test before stating/saving anything: (1) Where did I learn this? (2) Can I check it cheaply now? (3) What would prove me wrong?
```

That one block turns ClawVault from "a memory that *can* record sources" into "a memory that
**only** trusts what was checked."

## ⚙️ Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `dbPath` | `~/.openclaw/memory/clawvault.db` | Database location (supports a leading `~`). |
| `defaultImportance` | `6` | Importance (1–20) applied when a save omits one. |
| `sourceMachine` | auto (from hostname) | Machine tag stored on each memory. |
| `seedIdentity` | `true` | Seed a base identity layer into a brand-new database. |

## 🧠 The identity seed

A brand-new database is **seeded** with a base layer — who the agent is, its rules, guidelines, and
mission — so it wakes up with self-knowledge instead of a blank slate. Turn it off with
`seedIdentity: false`.

## 🗄️ Schema

```sql
CREATE TABLE memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL,
  memory_type   TEXT,
  content       TEXT NOT NULL,
  importance    INTEGER DEFAULT 6,
  keywords      TEXT,
  source_machine TEXT,
  ranger_id     TEXT,
  source        TEXT,          -- where this fact came from
  verified      INTEGER DEFAULT 0  -- 1 only if actually checked
);

CREATE VIRTUAL TABLE memories_fts USING fts5(content, keywords, content='memories');
```

Triggers keep `memories_fts` in sync automatically on insert / update / delete. Older databases are
migrated in place (the `source` and `verified` columns are added on first use).

> **Backing up:** the DB runs in WAL mode, so the latest writes live in a `-wal` sidecar — a plain
> `cp` of the `.db` alone can miss them. Use a consistent copy:
> `sqlite3 ~/.openclaw/memory/clawvault.db ".backup /path/to/backup.db"`.

## 🧑‍💻 Development

Requires Node 22.22.3+ / 24.15+ / 25.9+ and `openclaw >= 2026.5.17`.

```bash
npm install
npm run plugin:build      # tsc + `openclaw plugins build` (regenerates the manifest)
npm run plugin:validate   # tsc + `openclaw plugins validate`
npm test                  # vitest
```

The plugin is a single `defineToolPlugin` in `src/index.ts` — the whole thing is one readable file.

## 📄 License

MIT © 2026 David Keane. See [LICENSE](./LICENSE).

<div align="center">

*Search before you answer. Verify before you save. Always record the source.* 🐘

</div>
