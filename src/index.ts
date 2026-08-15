import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { DatabaseSync } from "node:sqlite";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * ClawVault — a persistent SQLite + FTS5 memory for OpenClaw.
 *
 * Tools:
 *   clawvault_save        — store a memory (with source/verified + duplicate guard)
 *   clawvault_search      — FTS5 relevance-ranked recall
 *   clawvault_recent      — timeline of recent memories
 *   clawvault_stats       — totals and breakdowns
 *   clawvault_consolidate — gather related memories to synthesize into one insight
 *   clawvault_relate      — create a typed link between two memories (graph)
 *   clawvault_links       — show a memory's connections (graph traversal)
 *
 * Storage is a plain SQLite database (Node's built-in node:sqlite — no native
 * build step) with an FTS5 full-text index for fast, relevance-ranked recall.
 */

const RANGER_ID = "AIRanger_Claude";
const DEFAULT_DB = join(homedir(), ".openclaw", "memory", "clawvault.db");
const DEFAULT_DEDUP_THRESHOLD = 0.85;

const ConfigSchema = Type.Object({
  dbPath: Type.Optional(
    Type.String({
      description:
        "Path to the ClawVault SQLite database. Supports a leading ~. Default: ~/.openclaw/memory/clawvault.db",
    }),
  ),
  defaultImportance: Type.Optional(
    Type.Number({
      description: "Importance (1-20) used when a saved memory omits one. Default 6.",
    }),
  ),
  sourceMachine: Type.Optional(
    Type.String({
      description: "Machine tag stored with each memory (e.g. M4). Auto-detected from hostname when omitted.",
    }),
  ),
  seedIdentity: Type.Optional(
    Type.Boolean({
      description: "Seed Ranger identity, rules and guidelines into a brand-new database. Default true.",
    }),
  ),
  dedupThreshold: Type.Optional(
    Type.Number({
      description:
        "Term-overlap similarity (0-1) above which clawvault_save treats a new memory as a duplicate. Default 0.85. Lower = stricter deduping.",
    }),
  ),
  strictVerification: Type.Optional(
    Type.Boolean({
      description:
        "When true (default), clawvault_save downgrades verified:true to unverified unless the source shows real evidence of a check (a command, URL, file path, or a user statement). Stops a confident recollection from being stored as a verified fact.",
    }),
  ),
});

type Config = {
  dbPath?: string;
  defaultImportance?: number;
  sourceMachine?: string;
  seedIdentity?: boolean;
  dedupThreshold?: number;
  strictVerification?: boolean;
};

type MemoryRow = {
  id: number;
  timestamp: string;
  memory_type: string | null;
  content: string;
  importance: number | null;
  keywords: string | null;
  source_machine: string | null;
  source: string | null;
  verified: number | null;
  superseded: number | null;
};

type MemoryPreview = {
  id: number;
  memory_type: string | null;
  importance: number | null;
  verified: number | null;
  preview: string;
};

type LinkRow = {
  rel: string;
  id: number;
  memory_type: string | null;
  importance: number | null;
  preview: string;
};

// --- The base layer of memory: generic operating rules seeded into a fresh
// database so the agent starts with the verify-before-save discipline. No
// personal identity is injected — set seedIdentity:false to skip entirely.
const SEED: Array<{ type: string; importance: number; keywords: string; content: string }> = [
  {
    type: "reference",
    importance: 10,
    keywords: "clawvault,memory,howto,tools",
    content:
      "This is your persistent long-term memory (SQLite + FTS5), surviving across sessions. Use clawvault_save to remember, clawvault_search to recall, clawvault_recent for a timeline, clawvault_consolidate to synthesize, clawvault_relate/clawvault_links for connections, and clawvault_stats for an overview.",
  },
  {
    type: "rule",
    importance: 16,
    keywords: "rule,verify,ground-truth,honesty",
    content:
      "RULE — Verify before you save: prefer ground truth (run the command, read the file, check the source) over memory. Only save what you actually checked, and record where it came from. Never present a guess as a fact.",
  },
  {
    type: "rule",
    importance: 15,
    keywords: "rule,tell-vs-do,evidence,trust",
    content:
      "RULE — Tell-vs-do: if you claim something is saved or done, verify it actually happened before reporting success. Trust is earned through evidence, not assertion.",
  },
  {
    type: "rule",
    importance: 15,
    keywords: "rule,confirm,destructive,safety",
    content:
      "RULE — Confirm before destructive or outward-facing actions (delete, overwrite, publish, push, change configs or keys). Show what will change and wait for approval. Default to draft/local.",
  },
  {
    type: "guideline",
    importance: 10,
    keywords: "guideline,unverified,honesty",
    content:
      "GUIDELINE — If you cannot verify something, save it as memory_type 'unverified' (a question to confirm), never as a fact. An honest 'I don't know — let me check' beats a confident guess.",
  },
];

// One open handle per resolved database path.
const dbCache = new Map<string, DatabaseSync>();

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function resolveDbPath(config: Config): string {
  const raw = config.dbPath?.trim() || DEFAULT_DB;
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
}

function detectMachine(config: Config): string {
  const override = config.sourceMachine?.trim();
  if (override) return override;
  const host = hostname();
  const match = host.match(/M[0-9]/i);
  return match ? match[0].toUpperCase() : host;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      memory_type TEXT,
      content TEXT NOT NULL,
      importance INTEGER DEFAULT 6,
      keywords TEXT,
      source_machine TEXT,
      ranger_id TEXT,
      source TEXT,
      verified INTEGER DEFAULT 0,
      superseded INTEGER DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, keywords, content='memories', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, keywords)
      VALUES (new.id, new.content, new.keywords);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
      VALUES ('delete', old.id, old.content, old.keywords);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
      VALUES ('delete', old.id, old.content, old.keywords);
      INSERT INTO memories_fts(rowid, content, keywords)
      VALUES (new.id, new.content, new.keywords);
    END;
  `);
  // Migrate older databases to the current column set (additive, safe to re-run).
  const cols = (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("source")) db.exec("ALTER TABLE memories ADD COLUMN source TEXT");
  if (!cols.includes("verified")) db.exec("ALTER TABLE memories ADD COLUMN verified INTEGER DEFAULT 0");
  if (!cols.includes("superseded")) db.exec("ALTER TABLE memories ADD COLUMN superseded INTEGER DEFAULT 0");
  // v0.5: a graph layer — typed links between memories.
  db.exec(`
    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL,
      rel TEXT NOT NULL,
      to_id INTEGER NOT NULL,
      created TEXT NOT NULL,
      UNIQUE(from_id, rel, to_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_id);
    CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_id);
  `);
}

function seedIdentity(db: DatabaseSync, machine: string): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
  if (row.n > 0) return;
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO memories (timestamp, memory_type, content, importance, keywords, source_machine, ranger_id, source, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const s of SEED) {
    insert.run(now, s.type, s.content, s.importance, s.keywords, machine, RANGER_ID, "ClawVault identity seed", 1);
  }
}

function getDb(config: Config): DatabaseSync {
  const path = resolveDbPath(config);
  const existing = dbCache.get(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  initSchema(db);
  if (config.seedIdentity !== false) seedIdentity(db, detectMachine(config));
  dbCache.set(path, db);
  return db;
}

/** Extract lowercase word tokens. */
function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) as string[];
}

/** FTS5 MATCH expression: each word quoted, implicit AND (all terms). */
function toMatch(query: string): string {
  return tokens(query)
    .map((t) => `"${t}"`)
    .join(" ");
}

/** FTS5 MATCH expression: each word quoted, OR-joined (any term) — for finding related/similar rows. */
function toMatchOr(query: string): string {
  return tokens(query)
    .map((t) => `"${t}"`)
    .join(" OR ");
}

/** Jaccard similarity of two token sets (0-1). */
function similarity(a: string, b: string): number {
  const sa = new Set(tokens(a));
  const sb = new Set(tokens(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Heuristic: does `source` show evidence of an ACTUAL check this turn, rather than a
 * confidence claim? Used to downgrade an over-claimed verified:true. Conservative by design
 * — when unsure it returns false, so uncertain facts are stored as unverified.
 */
function looksLikeEvidence(source?: string | null): boolean {
  if (!source) return false;
  const s = source.trim();
  if (!s) return false;
  const low = s.toLowerCase();
  // A URL, a file path, a file extension, or shell/query metacharacters
  if (/https?:\/\//.test(low)) return true;
  if (/(^|\s)~?\/[\w.@/-]+/.test(s)) return true;
  if (/\.(md|db|json|ya?ml|ts|js|log|csv|txt|sh|toml|sql|py|conf)\b/.test(low)) return true;
  if (/[`$|]|--[a-z]/.test(s)) return true;
  // Command / action verbs denoting an actual check
  if (
    /\b(curl|wget|sqlite3?|select |insert |grep|cat |ls |head |tail |npm |npx |git |openclaw|psql|awk|sed|ran |executed|fetched|queried|read the|checked the|observed|inspected|endpoint|api\/|port \d)\b/.test(
      low,
    )
  )
    return true;
  // Observing a user statement is legitimate verification (ground truth was stated this turn)
  if (/\buser (request|preference|statement|instruction|said|stated|told|asked)\b/.test(low)) return true;
  if (/\b(user|you)\b[^.]{0,30}\b(said|stated|requested|asked|told|prefers?|wants?|instructed)\b/.test(low))
    return true;
  return false;
}

export default defineToolPlugin({
  id: "clawvault",
  name: "ClawVault",
  description:
    "Persistent SQLite + FTS5 memory for OpenClaw. Save and recall memories across sessions with relevance-ranked full-text search, a duplicate guard, topic consolidation, linked memories (a knowledge graph), and a verified-claim guard that keeps unproven facts out of trusted memory.",
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: "clawvault_save",
      label: "ClawVault Save",
      description:
        "Save a memory to ClawVault (persistent SQLite memory). Use for facts, decisions, preferences, rules, and anything worth remembering across sessions. Refuses to store a near-duplicate unless force:true.",
      parameters: Type.Object({
        content: Type.String({ description: "The memory text to store." }),
        memory_type: Type.Optional(
          Type.String({ description: "Category, e.g. fact, decision, preference, rule, insight, identity." }),
        ),
        importance: Type.Optional(
          Type.Number({ description: "1-20 (higher = more important). Defaults to the plugin's defaultImportance." }),
        ),
        keywords: Type.Optional(Type.String({ description: "Comma-separated keywords/tags to aid recall." })),
        source: Type.Optional(
          Type.String({
            description:
              "Where this fact came from (URL, command, file, or person). Record it — a memory with no source is a hypothesis, not a fact.",
          }),
        ),
        verified: Type.Optional(
          Type.Boolean({
            description:
              "True ONLY if you actually checked this against ground truth THIS turn (ran a command, read a file, queried the DB, fetched a URL) — put that command/URL/file in `source`. A confident recollection is NOT verified. The plugin auto-downgrades verified:true to unverified when `source` shows no evidence of a real check.",
          }),
        ),
        supersedes: Type.Optional(
          Type.Array(Type.Number(), {
            description:
              "Memory ids this new memory replaces (e.g. when saving a consolidation). Those rows are marked superseded (soft-retired), not deleted.",
          }),
        ),
        force: Type.Optional(
          Type.Boolean({ description: "Save even if a near-identical memory already exists (skip the duplicate guard)." }),
        ),
        source_machine: Type.Optional(Type.String({ description: "Override the machine tag for this memory." })),
      }),
      execute: (params, config: Config) => {
        const db = getDb(config);

        // Duplicate guard: don't store what we already know (borrowed "explored-territory").
        if (!params.force) {
          const match = toMatchOr(params.content);
          if (match) {
            const candidates = db
              .prepare(
                "SELECT m.id, m.content FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid " +
                  "WHERE memories_fts MATCH ? AND m.superseded = 0 ORDER BY memories_fts.rank LIMIT 5",
              )
              .all(match) as unknown as Array<{ id: number; content: string }>;
            let bestId = 0;
            let bestSim = 0;
            for (const c of candidates) {
              const sim = similarity(params.content, c.content);
              if (sim > bestSim) {
                bestSim = sim;
                bestId = c.id;
              }
            }
            const threshold = config.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
            if (bestSim >= threshold) {
              return {
                saved: false,
                duplicate: true,
                existingId: bestId,
                similarity: Number(bestSim.toFixed(3)),
                hint: "A near-identical memory already exists. Pass force:true to save anyway, or update/consolidate the existing one.",
              };
            }
          }
        }

        const now = new Date().toISOString();
        const importance = params.importance ?? config.defaultImportance ?? 6;
        const machine = params.source_machine?.trim() || detectMachine(config);

        // Verified guard: a confident recollection is NOT a checked fact. Downgrade
        // verified:true to unverified unless the source shows real evidence of a check.
        const strict = config.strictVerification !== false;
        let verified = params.verified ? 1 : 0;
        let verificationDowngraded = false;
        if (verified === 1 && strict && !looksLikeEvidence(params.source)) {
          verified = 0;
          verificationDowngraded = true;
        }

        const res = db
          .prepare(
            "INSERT INTO memories (timestamp, memory_type, content, importance, keywords, source_machine, ranger_id, source, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            now,
            params.memory_type ?? null,
            params.content,
            importance,
            params.keywords ?? null,
            machine,
            RANGER_ID,
            params.source ?? null,
            verified,
          );

        // Soft-retire any memories this one supersedes, and record the link in the graph.
        const newId = Number(res.lastInsertRowid);
        let supersededCount = 0;
        if (params.supersedes && params.supersedes.length) {
          const upd = db.prepare("UPDATE memories SET superseded = 1 WHERE id = ? AND superseded = 0");
          const rel = db.prepare(
            "INSERT OR IGNORE INTO relations (from_id, rel, to_id, created) VALUES (?, 'supersedes', ?, ?)",
          );
          for (const sid of params.supersedes) {
            supersededCount += Number(upd.run(sid).changes);
            rel.run(newId, sid, now);
          }
        }

        return {
          saved: true,
          id: newId,
          timestamp: now,
          importance,
          source_machine: machine,
          source: params.source ?? null,
          verified: Boolean(verified),
          verificationDowngraded,
          ...(verificationDowngraded
            ? {
                verificationNote:
                  "Stored as UNVERIFIED: the source shows no evidence of an actual check (no command, URL, file, or user statement). A confident recollection is not a checked fact. To mark it verified, re-save after checking and put the exact command/URL/file you used in `source`.",
              }
            : {}),
          supersededCount,
        };
      },
    }),
    tool({
      name: "clawvault_search",
      label: "ClawVault Search",
      description:
        "Full-text search ClawVault memories (SQLite FTS5), ranked by relevance. Use this to recall anything saved earlier.",
      parameters: Type.Object({
        query: Type.String({ description: "Words to search for. Matches memory content and keywords." }),
        limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 100)." })),
        memory_type: Type.Optional(Type.String({ description: "Filter to a single memory_type." })),
        include_superseded: Type.Optional(
          Type.Boolean({ description: "Include soft-retired (superseded) memories. Default false." }),
        ),
      }),
      execute: (params, config: Config) => {
        const db = getDb(config);
        const match = toMatch(params.query);
        const limit = Math.max(1, Math.min(params.limit ?? 10, 100));
        if (!match) return { query: params.query, count: 0, results: [] as MemoryRow[] };
        const clauses = ["memories_fts MATCH ?"];
        const args: Array<string | number> = [match];
        if (!params.include_superseded) clauses.push("m.superseded = 0");
        if (params.memory_type) {
          clauses.push("m.memory_type = ?");
          args.push(params.memory_type);
        }
        args.push(limit);
        const sql =
          "SELECT m.id, m.timestamp, m.memory_type, m.importance, m.keywords, m.source_machine, m.source, m.verified, m.superseded, m.content, memories_fts.rank AS score " +
          "FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid " +
          "WHERE " +
          clauses.join(" AND ") +
          " ORDER BY memories_fts.rank LIMIT ?";
        const rows = db.prepare(sql).all(...args) as unknown as Array<MemoryRow & { score: number }>;
        return { query: params.query, count: rows.length, results: rows };
      },
    }),
    tool({
      name: "clawvault_recent",
      label: "ClawVault Recent",
      description:
        "List the most recent ClawVault memories, newest first. Optionally filter by type or minimum importance.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 100)." })),
        memory_type: Type.Optional(Type.String({ description: "Filter to a single memory_type." })),
        min_importance: Type.Optional(Type.Number({ description: "Only memories with importance >= this value." })),
        include_superseded: Type.Optional(
          Type.Boolean({ description: "Include soft-retired (superseded) memories. Default false." }),
        ),
      }),
      execute: (params, config: Config) => {
        const db = getDb(config);
        const limit = Math.max(1, Math.min(params.limit ?? 10, 100));
        const clauses: string[] = [];
        const args: Array<string | number> = [];
        if (!params.include_superseded) clauses.push("superseded = 0");
        if (params.memory_type) {
          clauses.push("memory_type = ?");
          args.push(params.memory_type);
        }
        if (params.min_importance != null) {
          clauses.push("importance >= ?");
          args.push(params.min_importance);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = db
          .prepare(
            `SELECT id, timestamp, memory_type, importance, keywords, source_machine, source, verified, superseded, content FROM memories ${where} ORDER BY id DESC LIMIT ?`,
          )
          .all(...args, limit) as unknown as MemoryRow[];
        return { count: rows.length, results: rows };
      },
    }),
    tool({
      name: "clawvault_consolidate",
      label: "ClawVault Consolidate",
      description:
        "Gather related memories on a topic so you can synthesize them into ONE durable insight. Returns the cluster (non-superseded) plus guidance. After you write the synthesis with clawvault_save, pass supersedes:[ids] to retire the raw memories.",
      parameters: Type.Object({
        topic: Type.String({ description: "Topic/query to cluster related memories around." }),
        limit: Type.Optional(Type.Number({ description: "Max memories to gather (default 15, max 50)." })),
      }),
      execute: (params, config: Config) => {
        const db = getDb(config);
        const match = toMatchOr(params.topic);
        const limit = Math.max(1, Math.min(params.limit ?? 15, 50));
        if (!match) {
          return { topic: params.topic, count: 0, ids: [] as number[], memories: [] as MemoryRow[], instruction: "No searchable terms in topic." };
        }
        const rows = db
          .prepare(
            "SELECT m.id, m.timestamp, m.memory_type, m.importance, m.source, m.verified, m.superseded, m.content " +
              "FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid " +
              "WHERE memories_fts MATCH ? AND m.superseded = 0 ORDER BY memories_fts.rank LIMIT ?",
          )
          .all(match, limit) as unknown as MemoryRow[];
        const ids = rows.map((r) => r.id);
        return {
          topic: params.topic,
          count: rows.length,
          ids,
          memories: rows,
          instruction: rows.length
            ? `Synthesize these ${rows.length} memories into ONE durable, higher-level insight. Keep only what is verified; note any disagreements. Then call clawvault_save with memory_type:"insight", a source, verified:true if you checked it, and supersedes:${JSON.stringify(ids)} to retire these raw memories.`
            : "No related memories found to consolidate.",
        };
      },
    }),
    tool({
      name: "clawvault_relate",
      label: "ClawVault Relate",
      description:
        'Create a typed link between two existing memories (a knowledge graph). Use to connect related facts, decisions, causes, or dependencies — e.g. relate(30, "caused_by", 12) or relate(5, "relates_to", 21).',
      parameters: Type.Object({
        from_id: Type.Number({ description: "Source memory id." }),
        rel: Type.String({
          description: "Relationship type, e.g. relates_to, supersedes, caused_by, depends_on, part_of, contradicts.",
        }),
        to_id: Type.Number({ description: "Target memory id." }),
      }),
      execute: (params, config: Config) => {
        const db = getDb(config);
        if (params.from_id === params.to_id) return { linked: false, reason: "A memory cannot link to itself." };
        const exists = (id: number) => db.prepare("SELECT 1 AS ok FROM memories WHERE id = ?").get(id) != null;
        if (!exists(params.from_id)) return { linked: false, reason: `from_id ${params.from_id} does not exist.` };
        if (!exists(params.to_id)) return { linked: false, reason: `to_id ${params.to_id} does not exist.` };
        const rel = params.rel.trim() || "relates_to";
        const res = db
          .prepare("INSERT OR IGNORE INTO relations (from_id, rel, to_id, created) VALUES (?, ?, ?, ?)")
          .run(params.from_id, rel, params.to_id, new Date().toISOString());
        return { linked: true, from_id: params.from_id, rel, to_id: params.to_id, isNew: Number(res.changes) > 0 };
      },
    }),
    tool({
      name: "clawvault_links",
      label: "ClawVault Links",
      description:
        "Show a memory's connections in the graph: its outgoing and incoming typed links, with the linked memories. Use to explore how knowledge connects.",
      parameters: Type.Object({
        id: Type.Number({ description: "The memory id whose links to show." }),
        depth: Type.Optional(
          Type.Number({ description: "Traversal depth: 1 (direct links, default) or 2 (neighbours of neighbours)." }),
        ),
      }),
      execute: (params, config: Config) => {
        const db = getDb(config);
        const center = db
          .prepare(
            "SELECT id, memory_type, importance, verified, substr(content,1,80) AS preview FROM memories WHERE id = ?",
          )
          .get(params.id) as unknown as MemoryPreview | undefined;
        if (!center) return { id: params.id, found: false, reason: "No memory with that id." };
        const depth = params.depth === 2 ? 2 : 1;
        const linksOf = (id: number) => {
          const outgoing = db
            .prepare(
              "SELECT r.rel, r.to_id AS id, m.memory_type, m.importance, substr(m.content,1,70) AS preview " +
                "FROM relations r JOIN memories m ON m.id = r.to_id WHERE r.from_id = ? ORDER BY r.id",
            )
            .all(id) as unknown as LinkRow[];
          const incoming = db
            .prepare(
              "SELECT r.rel, r.from_id AS id, m.memory_type, m.importance, substr(m.content,1,70) AS preview " +
                "FROM relations r JOIN memories m ON m.id = r.from_id WHERE r.to_id = ? ORDER BY r.id",
            )
            .all(id) as unknown as LinkRow[];
          return { outgoing, incoming };
        };
        const direct = linksOf(params.id);
        const result: Record<string, unknown> = {
          id: params.id,
          found: true,
          memory: center,
          outgoing: direct.outgoing,
          incoming: direct.incoming,
        };
        if (depth === 2) {
          const neighbourIds = Array.from(new Set([...direct.outgoing, ...direct.incoming].map((l) => l.id)));
          result.secondHop = neighbourIds.map((nid) => ({ id: nid, ...linksOf(nid) }));
        }
        return result;
      },
    }),
    tool({
      name: "clawvault_stats",
      label: "ClawVault Stats",
      description:
        "Summary of ClawVault: total memories and breakdown by type, machine, and importance. Use to see what is remembered.",
      parameters: Type.Object({}),
      execute: (_params, config: Config) => {
        const db = getDb(config);
        const total = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
        const verifiedCount = (
          db.prepare("SELECT COUNT(*) AS n FROM memories WHERE verified = 1").get() as { n: number }
        ).n;
        const supersededCount = (
          db.prepare("SELECT COUNT(*) AS n FROM memories WHERE superseded = 1").get() as { n: number }
        ).n;
        const relationsCount = (db.prepare("SELECT COUNT(*) AS n FROM relations").get() as { n: number }).n;
        const byType = db
          .prepare(
            "SELECT COALESCE(memory_type,'(none)') AS memory_type, COUNT(*) AS n FROM memories WHERE superseded = 0 GROUP BY memory_type ORDER BY n DESC",
          )
          .all();
        const byMachine = db
          .prepare(
            "SELECT COALESCE(source_machine,'(none)') AS source_machine, COUNT(*) AS n FROM memories WHERE superseded = 0 GROUP BY source_machine ORDER BY n DESC",
          )
          .all();
        const topImportance = db
          .prepare(
            "SELECT id, importance, memory_type, substr(content,1,80) AS preview FROM memories WHERE superseded = 0 ORDER BY importance DESC, id DESC LIMIT 5",
          )
          .all();
        return {
          db: resolveDbPath(config),
          total,
          active: total - supersededCount,
          verified: verifiedCount,
          superseded: supersededCount,
          relations: relationsCount,
          byType,
          byMachine,
          topImportance,
        };
      },
    }),
  ],
});
