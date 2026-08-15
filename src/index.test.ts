import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("clawvault", () => {
  it("declares its tool metadata", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "clawvault_save",
      "clawvault_search",
      "clawvault_recent",
      "clawvault_consolidate",
      "clawvault_relate",
      "clawvault_links",
      "clawvault_stats",
    ]);
  });

  it("uses the clawvault plugin id", () => {
    expect(getToolPluginMetadata(entry)?.id).toBe("clawvault");
  });
});
