import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { DatabaseSync } from "node:sqlite";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * ClawVault — a persistent SQLite + FTS5 memory for OpenClaw.
 *
 * Tools: clawvault_save, clawvault_search, clawvault_recent, clawvault_stats.
 * Storage is a plain SQLite database (Node's built-in node:sqlite — no native
 * build step) with an FTS5 full-text index for fast, relevance-ranked recall.
 */

const RANGER_ID = "AIRanger_Claude";
const DEFAULT_DB = join(homedir(), ".openclaw", "memory", "clawvault.db");

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
});

type Config = {
  dbPath?: string;
  defaultImportance?: number;
  sourceMachine?: string;
  seedIdentity?: boolean;
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
      "ClawVault is Ranger's persistent SQLite+FTS5 memory for OpenClaw. Use clawvault_save to remember things, clawvault_search to recall them, clawvault_recent for a timeline, and clawvault_stats for an overview.",
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
      verified INTEGER DEFAULT 0
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
  // Migrate databases created before the source/verified columns existed.
  const cols = (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("source")) db.exec("ALTER TABLE memories ADD COLUMN source TEXT");
  if (!cols.includes("verified")) db.exec("ALTER TABLE memories ADD COLUMN verified INTEGER DEFAULT 0");
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

/** Turn free text into a safe FTS5 MATCH expression: each word quoted, implicit AND. */
function toMatch(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.map((t) => `"${t}"`).join(" ");
}

export default defineToolPlugin({
  id: "clawvault",
  name: "ClawVault",
  description:
    "Persistent SQLite + FTS5 memory for OpenClaw. Save memories and recall them across sessions with fast, relevance-ranked full-text search.",
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: "clawvault_save",
      label: "ClawVault Save",
      description:
        "Save a memory to ClawVault (persistent SQLite memory). Use for facts, decisions, preferences, rules, and anything worth remembering across sessions.",
      parameters: Type.Object({
        content: Type.String({ description: "The memory text to store." }),
        memory_type: Type.Optional(
          Type.String({ description: "Category, e.g. fact, decision, preference, rule, identity." }),
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
        source_machine: Type.Optional(Type.String({ description: "Override the machine tag for this memory." })),
      }),
      execute: (params, config: Config) => {
        const db = getDb(config);
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
        return {
          saved: true,
          id: Number(res.lastInsertRowid),
          timestamp: now,
          importance,
          source_machine: machine,
          source: params.source ?? null,
          verified: Boolean(verified),
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
      }),
      execute: (params, config: Config) => {
        const db = getDb(config);
        const match = toMatch(params.query);
        const limit = Math.max(1, Math.min(params.limit ?? 10, 100));
        if (!match) return { query: params.query, count: 0, results: [] as MemoryRow[] };
        const sql =
          "SELECT m.id, m.timestamp, m.memory_type, m.importance, m.keywords, m.source_machine, m.source, m.verified, m.content, memories_fts.rank AS score " +
          "FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid " +
          "WHERE memories_fts MATCH ?" +
          (params.memory_type ? " AND m.memory_type = ?" : "") +
          " ORDER BY memories_fts.rank LIMIT ?";
        const args = params.memory_type ? [match, params.memory_type, limit] : [match, limit];
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
      }),
      execute: (params, config: Config) => {
        const db = getDb(config);
        const limit = Math.max(1, Math.min(params.limit ?? 10, 100));
        const clauses: string[] = [];
        const args: Array<string | number> = [];
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
            `SELECT id, timestamp, memory_type, importance, keywords, source_machine, source, verified, content FROM memories ${where} ORDER BY id DESC LIMIT ?`,
          )
          .all(...args, limit) as unknown as MemoryRow[];
        return { count: rows.length, results: rows };
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
        const byType = db
          .prepare(
            "SELECT COALESCE(memory_type,'(none)') AS memory_type, COUNT(*) AS n FROM memories GROUP BY memory_type ORDER BY n DESC",
          )
          .all();
        const byMachine = db
          .prepare(
            "SELECT COALESCE(source_machine,'(none)') AS source_machine, COUNT(*) AS n FROM memories GROUP BY source_machine ORDER BY n DESC",
          )
          .all();
        const topImportance = db
          .prepare(
            "SELECT id, importance, memory_type, substr(content,1,80) AS preview FROM memories ORDER BY importance DESC, id DESC LIMIT 5",
          )
          .all();
        return { db: resolveDbPath(config), total, verified: verifiedCount, byType, byMachine, topImportance };
      },
    }),
  ],
});
