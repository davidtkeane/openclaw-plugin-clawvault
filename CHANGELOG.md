# Changelog

All notable changes to ClawVault. Format based on [Keep a Changelog](https://keepachangelog.com);
this project follows [Semantic Versioning](https://semver.org).

## Plugin (`openclaw-plugin-clawvault`)

### [0.5.2] — 2026-08-16
**Second SkillSpector pass — safety hardening.**
#### Changed
- The skill no longer tells the agent to auto-edit `AGENTS.md`/`TOOLS.md`; it now **suggests** the user do
  it (closes a prompt-injection / instruction-persistence channel).
- Clarified the privacy wording: ClawVault's *storage* is local and never transmitted; *verifying* a fact
  may use the agent's own web tools (separate from ClawVault) — removes the "nothing leaves the machine"
  contradiction.
- Descriptions now explicitly disclose persistent local storage and retention.

### [0.5.1] — 2026-08-15
**Security & privacy cleanup** (from a SkillSpector / NVIDIA review).
#### Changed
- Pinned all dependencies and bumped **`vitest` 3.2.0 → 4.1.10** (clears a critical advisory),
  `typebox` → 1.3.14, and the `openclaw` dev/peer floor → 2026.7.1-2 (patched host).
- The seed layer is now **generic operating rules** (verify-before-save, tell-vs-do, confirm-before-destructive)
  — no personal identity or persona is injected into a fresh database.
#### Added
- **Privacy & data** section (README + skill): memories are stored locally, nothing leaves the machine,
  and how to disable the seed or delete data.

### [0.5.0] — 2026-08-15
**Linked memories (knowledge graph).**
#### Added
- `relations` table and two tools: **`clawvault_relate(from_id, rel, to_id)`** creates a typed edge
  between two existing memories (`relates_to`, `depends_on`, `caused_by`, `part_of`, `contradicts`…);
  **`clawvault_links(id, depth?)`** shows a memory's outgoing + incoming links (depth 2 = neighbours of
  neighbours).
- Guards: self-link rejected, missing-id rejected, `UNIQUE(from_id, rel, to_id)` dedups edges.
- Consolidation auto-records `supersedes` edges; `clawvault_stats` reports the relation count.

### [0.4.0] — 2026-08-15
**Verified-claim guard — mechanism over trust.**
#### Added
- `clawvault_save` auto-downgrades `verified:true` to unverified unless `source` shows evidence of a
  real check (a command, URL, file path, or a user statement). Returns `verificationDowngraded` + a note.
- `strictVerification` config option (default `true`).
#### Why
- Live tests showed a small model repeatedly stamping *recited* facts as `verified`. Instruction alone
  couldn't fix it; enforcing in the schema did.

### [0.3.0] — 2026-08-15
**Keeping memory clean.**
#### Added
- Duplicate guard: `clawvault_save` refuses a near-identical memory (FTS + term overlap ≥
  `dedupThreshold`, default 0.85) unless `force:true`.
- `clawvault_consolidate` tool; soft-retire via a `superseded` column and `supersedes:[ids]` on save;
  `include_superseded` flag on search/recent.

### [0.2.0] — 2026-08-15
**Provenance.**
#### Added
- `source` and `verified` fields on every memory, with an in-place migration for existing databases.

### [0.1.0] — 2026-08-15
**Initial release.**
#### Added
- Persistent SQLite + FTS5 memory using Node's built-in `node:sqlite` (no native build).
- Tools: `clawvault_save`, `clawvault_search`, `clawvault_recent`, `clawvault_stats`.
- Identity seed layer for a fresh database.

---

## Skill (`clawvault-memory`)

### [1.1.2] — 2026-08-16
#### Changed
- "Graduate lessons" now suggests the user edit `AGENTS.md` rather than the agent auto-editing instruction files.
- Privacy note clarified (local storage vs the agent's separate web tools); description discloses persistence.

### [1.1.1] — 2026-08-15
#### Added
- Privacy note: memories are stored locally; don't save secrets/credentials unless the user asks.
#### Changed
- Removed personal persona from guidance; generic verify-before-save workflow.

### [1.1.0] — 2026-08-15
#### Added
- Self-improving loop: capture errors/corrections/lessons with a stable pattern-key, detect recurrence,
  promote proven lessons, reflect after tasks, review lessons before major work.
- WAL **write-before-respond** rule + silent saves (answer-first).
- Hardened `verified` guidance: reciting from memory is **not** verification.

### [1.0.0] — 2026-08-15
#### Added
- Initial verify-before-save memory workflow skill for the ClawVault plugin.
