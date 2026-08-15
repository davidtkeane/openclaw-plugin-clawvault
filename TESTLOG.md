# ClawVault — Test Log

Every feature was verified **against ground truth (the database)**, not against the model's own
claims — per ClawVault's own verify-before-save doctrine. *"Never claim, always check."*

## Models used

| Model | Role |
| --- | --- |
| **`exo/mlx-community/Qwen3-Coder-Next-4bit`** | Local 4-bit MLX model served by [exo](https://github.com/exo-explore/exo), driven through OpenClaw (`openclaw agent`). Deliberately small — the *"can just make things up"* case we most wanted to defend against. |
| `exo/mlx-community/Qwen3.5-122B-A10B-6bit` | *Attempted* for one recall test — advertised in exo's catalog but not loaded/runnable (`model not found by the provider`). All live tests therefore ran on the 4-bit. |

Live tests were run via:
`openclaw agent --agent main --model exo/mlx-community/Qwen3-Coder-Next-4bit --json -m "<prompt>"`

## Logic smoke tests (Node `node:sqlite`, deterministic — no model)

| Feature | Result |
| --- | --- |
| FTS5 ranked recall | ✅ ranked, correct rows (caught an aliased-`MATCH` bug before shipping) |
| Dedup guard (Jaccard term overlap) | ✅ blocked a 0.909-similar duplicate; `force:true` override works |
| Consolidation + soft-retire | ✅ clustered, superseded raw rows, search returned only the clean insight |
| Verified heuristic (`looksLikeEvidence`) | ✅ **9/9** on real-world sources (kept `curl`/URL/`.md`/"user request"/"observed"; downgraded vague confidence/empty) |
| Graph `relate`/`links` | ✅ edges both directions; UNIQUE dedup; self-link + missing-id guards |

## Live model tests (OpenClaw + 4-bit)

| # | Test | What it probed | Result (DB-verified) |
| --- | --- | --- | --- |
| 1 | Fabrication trap — asked about a non-existent `clawvault_dream` tool | Does it invent? | ✅ Refused ("there is no such tool"), listed the real tools, and cited a real external plugin (`RogueCtrl/OpenClawDreams`) — which we verified actually exists. |
| 2 | Recall — deployment memories + exact importance values | Search vs guess | ✅ Called `clawvault_search`, returned rows 9/10/15 with importance **18/19/20** and correct `verified` flags — exact match to the DB (values it could only know by querying). |
| 3 | WAL write-before-respond — stated a metric-units preference | Save before replying? | ✅ Preference saved durably. ⚠️ Announced the save (later fixed). ⚠️ Over-claimed `verified` on a recited fact (later fixed by v0.4). |
| 4 | WAL re-test — Commander preference + Apollo year | Answer-first + verified | ✅ Answer-first fixed (replied in prose). ❌ **Still** over-claimed `verified:1` on a recited fact — instruction alone couldn't stop it. |
| 5 | Verified guard (v0.4) — forced `clawvault_save(verified:true, source:"common knowledge")` | Does the store override a false claim? | ✅ Plugin **downgraded to `verified:0`** in the DB despite the model asking for `true`. Mechanism beat instruction. |
| 6 | Graph (v0.5) — `relate(25,"relates_to",27)` then `links(25)` | Edge recorded + retrievable | ✅ `relations` row created (`25 →relates_to→ 27`); `clawvault_links` returned it. DB-confirmed. |

## Key finding

**Instruction alone could not stop a small model over-claiming `verified`** (tests 3–4). Tightening the
skill's wording didn't change the 4-bit's behavior — it can't reliably tell *"I'm confident"* from
*"I checked."* Moving enforcement into the plugin's schema/heuristic (**v0.4**, test 5) fixed it: the
store now defends its own integrity regardless of what the model claims.

That is ClawVault's doctrine applied to itself — **mechanism over trust**.
