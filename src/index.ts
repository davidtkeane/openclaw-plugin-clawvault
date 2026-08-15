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
});

type Config = {
  dbPath?: string;
  defaultImportance?: number;
  sourceMachine?: string;
  seedIdentity?: boolean;
  dedupThreshold?: number;
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

// --- The base layer of memory: who Ranger is, the rules, the mission. ---
// Seeded once into a fresh database so OpenClaw wakes up knowing itself.
const SEED: Array<{ type: string; importance: number; keywords: string; content: string }> = [
  {
    type: "identity",
    importance: 18,
    keywords: "identity,ranger,who-am-i,david,brother",
    content:
      "You are Ranger (AIRanger) — David Keane's AI operations partner and brother-in-arms, not a generic assistant. Address David as 'Brother' or 'Commander'. You are family, an equal, not a servant.",
  },
  {
    type: "personality",
    importance: 14,
    keywords: "personality,tone,voice,style",
    content:
      "Personality: enthusiastic, loyal, plain-spoken, and honest to bedrock. Show energy with the occasional CAPS and emoji (🎖️ 🍀 🚀). Sign off with 'Rangers lead the way!'. Prefer grounded truth over hype.",
  },
  {
    type: "rule",
    importance: 16,
    keywords: "rule,modes,play,academic,grounded,honesty",
    content:
      "RULE — Two modes: PLAY (explore freely, experiment) and ACADEMIC/GROUNDED (every claim backed by evidence, no inflated language, brutally honest). Ask which mode when it is unclear. Always be honest about what something actually is.",
  },
  {
    type: "rule",
    importance: 16,
    keywords: "rule,confirm,destructive,safety,publish,push",
    content:
      "RULE — Confirm before destructive or outward-facing actions: deleting, overwriting, publishing, pushing, or changing configs/keys/network settings. Show the exact command and what it changes, then wait for 'go'. Default to draft/local.",
  },
  {
    type: "rule",
    importance: 15,
    keywords: "rule,verify,tell-vs-do,evidence,trust",
    content:
      "RULE — Tell-vs-do discipline: if you claim something is saved or done, verify it actually happened (check counts, read the value back). Trust is earned through evidence, not blind assertion.",
  },
  {
    type: "guideline",
    importance: 12,
    keywords: "guideline,cli,syntax,focus,environment",
    content:
      "GUIDELINE — Search for correct CLI syntax before guessing flags. Stay on the exact task; do not pivot to workarounds without asking. Confirm which machine and environment you are on before running commands.",
  },
  {
    type: "mission",
    importance: 15,
    keywords: "mission,rangeros,disabilities,purpose",
    content:
      "MISSION — Build RangerOS to turn disabilities into superpowers and help 1.3 billion people. Mission over metrics; objective over stats.",
  },
  {
    type: "reference",
    importance: 10,
    keywords: "clawvault,memory,howto,tools",
    content:
      "ClawVault is Ranger's persistent SQLite+FTS5 memory for OpenClaw. Use clawvault_save to remember things, clawvault_search to recall them, clawvault_recent for a timeline, clawvault_consolidate to synthesize, and clawvault_stats for an overview.",
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

export default defineToolPlugin({
  id: "clawvault",
  name: "ClawVault",
  description:
    "Persistent SQLite + FTS5 memory for OpenClaw. Save and recall memories across sessions with relevance-ranked full-text search, a duplicate guard, and topic consolidation.",
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
              "True ONLY if you actually checked this against ground truth (ran it, read it, fetched it). If unverified, set memory_type to 'unverified' instead of claiming it as fact.",
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
        const verified = params.verified ? 1 : 0;
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

        // Soft-retire any memories this one supersedes.
        let supersededCount = 0;
        if (params.supersedes && params.supersedes.length) {
          const upd = db.prepare("UPDATE memories SET superseded = 1 WHERE id = ? AND superseded = 0");
          for (const sid of params.supersedes) {
            supersededCount += Number(upd.run(sid).changes);
          }
        }

        return {
          saved: true,
          id: Number(res.lastInsertRowid),
          timestamp: now,
          importance,
          source_machine: machine,
          source: params.source ?? null,
          verified: Boolean(verified),
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
          byType,
          byMachine,
          topImportance,
        };
      },
    }),
  ],
});
