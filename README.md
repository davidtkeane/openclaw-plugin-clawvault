# ClawVault 🐘

Persistent **SQLite + FTS5** memory for [OpenClaw](https://openclaw.ai). Give your
agent a real, durable memory it can write to and recall from across sessions —
backed by a plain SQLite database with a full-text search index, so there is no
fragile embedding index to fall out of sync.

## Why

OpenClaw's built-in memory relies on an embedding index that can drift. ClawVault
uses SQLite's battle-tested **FTS5** full-text engine instead: fast, relevance-ranked
(BM25) recall with nothing to rebuild. The store is a single file you can open with
any SQLite tool.

> **Backing up:** the DB runs in WAL mode, so the latest writes live in a `-wal`
> sidecar — a plain `cp` of the `.db` alone can miss them. Use a consistent copy:
> `sqlite3 ~/.openclaw/memory/clawvault.db ".backup /path/to/backup.db"`.

## Tools

| Tool | Purpose |
| --- | --- |
| `clawvault_save` | Store a memory (content, type, importance, keywords). |
| `clawvault_search` | FTS5 full-text search, ranked by relevance. |
| `clawvault_recent` | Most recent memories, newest first. |
| `clawvault_stats` | Totals and breakdown by type / machine / importance. |

## Storage

A single SQLite database (default `~/.openclaw/memory/clawvault.db`) using Node's
built-in `node:sqlite` — **no native build step**. Schema:

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  memory_type TEXT,
  content TEXT NOT NULL,
  importance INTEGER DEFAULT 6,
  keywords TEXT,
  source_machine TEXT,
  ranger_id TEXT
);
CREATE VIRTUAL TABLE memories_fts USING fts5(content, keywords, content='memories');
```

Triggers keep `memories_fts` in sync automatically on insert/update/delete.

A brand-new database is **seeded** with a base identity layer (who the agent is,
its rules, guidelines, and mission) so it starts with self-knowledge. Disable with
`seedIdentity: false`.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `dbPath` | `~/.openclaw/memory/clawvault.db` | Database location (supports `~`). |
| `defaultImportance` | `6` | Importance applied when a save omits one. |
| `sourceMachine` | auto (from hostname) | Machine tag stored on each memory. |
| `seedIdentity` | `true` | Seed the base identity layer into a fresh DB. |

## Develop

Requires Node 22.22.3+ / 24.15+ / 25.9+ and `openclaw >= 2026.5.17`.

```bash
npm install
npm run plugin:build      # tsc + openclaw plugins build
npm run plugin:validate   # tsc + openclaw plugins validate
npm test                  # vitest metadata test
```

## License

MIT
