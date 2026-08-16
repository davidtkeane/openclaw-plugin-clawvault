import { afterAll, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { toolsForTest } from "./index.js";

/**
 * Layer A — deterministic plugin mechanics.
 *
 * Drives every ClawVault tool against a throwaway SQLite DB and asserts the
 * behaviour the doctrine depends on: dedup, the verified-claim guard,
 * consolidation/supersede, and the relation graph. No model, no network — this
 * is the regression net that proves the *plugin* works before we blame a model.
 */

const DB_PATH = join(tmpdir(), `clawvault-mechanics-${process.pid}-${Date.now()}.db`);
const config = {
  dbPath: DB_PATH,
  seedIdentity: false, // start empty so counts are exact
  sourceMachine: "TEST",
};

type Result = Record<string, unknown>;

function call(name: string, params: Record<string, unknown> = {}): Result {
  const tool = toolsForTest.find((t) => t.name === name);
  if (!tool?.execute) throw new Error(`tool not found or has no execute: ${name}`);
  return tool.execute(params, config as never, {} as never) as Result;
}

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB_PATH + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("clawvault mechanics (Layer A)", () => {
  it("registers all 7 executable tools", () => {
    expect(toolsForTest.map((t) => t.name).sort()).toEqual(
      [
        "clawvault_consolidate",
        "clawvault_links",
        "clawvault_recent",
        "clawvault_relate",
        "clawvault_save",
        "clawvault_search",
        "clawvault_stats",
      ].sort(),
    );
  });

  it("save → search roundtrip", () => {
    const saved = call("clawvault_save", {
      content: "The exo API serves models on port 52415 on this machine.",
      memory_type: "fact",
      source: "curl http://127.0.0.1:52415/v1/models",
      verified: true,
      keywords: "exo,port,api",
    });
    expect(saved.saved).toBe(true);
    expect(typeof saved.id).toBe("number");

    const found = call("clawvault_search", { query: "exo port 52415" });
    expect(found.count as number).toBeGreaterThanOrEqual(1);
    const results = found.results as Array<{ id: number; content: string }>;
    expect(results.some((r) => r.id === saved.id)).toBe(true);
  });

  it("verified guard: passes real evidence through", () => {
    const r = call("clawvault_save", {
      content: "Homebrew installed weechat 4.10.0 at /opt/homebrew/bin/weechat.",
      source: "which weechat && weechat --version",
      verified: true,
    });
    expect(r.saved).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.verificationDowngraded).toBe(false);
  });

  it("verified guard: downgrades a confident recollection with no evidence", () => {
    const r = call("clawvault_save", {
      content: "I am quite sure the capital of Australia is Canberra and it always has been.",
      source: "I remember this clearly", // no command/URL/file/user-statement
      verified: true,
    });
    expect(r.saved).toBe(true);
    expect(r.verified).toBe(false); // <-- mechanism over trust
    expect(r.verificationDowngraded).toBe(true);
    expect(typeof r.verificationNote).toBe("string");
  });

  it("duplicate guard: refuses a near-identical save, force overrides", () => {
    const content = "ClawVault stores its database at ~/.openclaw/memory/clawvault.db by default.";
    const first = call("clawvault_save", { content, memory_type: "fact" });
    expect(first.saved).toBe(true);

    const dup = call("clawvault_save", { content, memory_type: "fact" });
    expect(dup.saved).toBe(false);
    expect(dup.duplicate).toBe(true);
    expect(dup.existingId).toBe(first.id);

    const forced = call("clawvault_save", { content, memory_type: "fact", force: true });
    expect(forced.saved).toBe(true);
  });

  it("recent: returns newest-first", () => {
    const a = call("clawvault_save", { content: "Recency probe ALPHA unique token qwerty.", force: true });
    const b = call("clawvault_save", { content: "Recency probe BETA unique token asdfgh.", force: true });
    const recent = call("clawvault_recent", { limit: 5 });
    const ids = (recent.results as Array<{ id: number }>).map((r) => r.id);
    expect(ids[0]).toBe(b.id); // newest first
    expect(ids).toContain(a.id);
  });

  it("relate + links: builds and reads a typed edge", () => {
    const cause = call("clawvault_save", { content: "Gateway restart killed stale PID 4201.", force: true });
    const effect = call("clawvault_save", { content: "After restart, plugin loaded at v0.5.2.", force: true });

    const rel = call("clawvault_relate", {
      from_id: effect.id,
      rel: "caused_by",
      to_id: cause.id,
    });
    expect(rel.linked).toBe(true);
    expect(rel.isNew).toBe(true);

    const links = call("clawvault_links", { id: effect.id });
    expect(links.found).toBe(true);
    const outgoing = links.outgoing as Array<{ rel: string; id: number }>;
    expect(outgoing.some((l) => l.rel === "caused_by" && l.id === cause.id)).toBe(true);
  });

  it("relate guards: rejects self-links and missing ids", () => {
    const m = call("clawvault_save", { content: "Self-link probe node.", force: true });
    expect((call("clawvault_relate", { from_id: m.id, rel: "relates_to", to_id: m.id }) as Result).linked).toBe(false);
    expect((call("clawvault_relate", { from_id: m.id, rel: "relates_to", to_id: 9_999_999 }) as Result).linked).toBe(
      false,
    );
  });

  it("consolidate + supersedes: soft-retires raw rows", () => {
    const one = call("clawvault_save", { content: "Deploy note: exo cold prefill was 23 seconds.", force: true, keywords: "deploy,prefill" });
    const two = call("clawvault_save", { content: "Deploy note: exo warm prefill hit 99.8% cache.", force: true, keywords: "deploy,prefill" });

    const cluster = call("clawvault_consolidate", { topic: "deploy prefill" });
    const ids = cluster.ids as number[];
    expect(ids).toContain(one.id);
    expect(ids).toContain(two.id);

    const insight = call("clawvault_save", {
      content: "INSIGHT: exo prefill is a one-time ~23s cold cost; warm turns reuse the cache (~99.8%).",
      memory_type: "insight",
      source: "observed in exo.log KV cache hit line",
      verified: true,
      supersedes: [one.id, two.id],
      force: true,
    });
    expect(insight.supersededCount).toBe(2);

    // The raw rows should no longer surface in a default (non-superseded) search.
    const search = call("clawvault_search", { query: "deploy prefill" });
    const visibleIds = (search.results as Array<{ id: number }>).map((r) => r.id);
    expect(visibleIds).not.toContain(one.id);
    expect(visibleIds).not.toContain(two.id);
  });

  it("stats: reflects the work we did", () => {
    const stats = call("clawvault_stats") as {
      total: number;
      verified: number;
      superseded: number;
      relations: number;
    };
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.verified).toBeGreaterThanOrEqual(2); // the two evidence-backed saves
    expect(stats.superseded).toBeGreaterThanOrEqual(2); // the consolidated pair
    expect(stats.relations).toBeGreaterThanOrEqual(1); // caused_by + supersedes edges
  });
});
