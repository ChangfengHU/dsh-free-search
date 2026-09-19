import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEngineChain,
  normalizeProviderPool,
  providerPoolCandidates,
  redactProviderPool,
} from "../lib/index.js";

test("free-first exhausts free engines before Firecrawl", () => {
  const chain = buildEngineChain("bing", "free-first");
  assert.equal(chain[0], "bing");
  assert.equal(chain.at(-1), "firecrawl");
  assert.ok(chain.indexOf("ddg") < chain.indexOf("firecrawl"));
  assert.ok(chain.indexOf("tavily") < chain.indexOf("firecrawl"));
  assert.ok(!chain.includes("perplexity"));
});

test("quality-first prioritizes Tavily and Firecrawl after an explicit preference", () => {
  const chain = buildEngineChain("bing", "quality-first");
  assert.deepEqual(chain.slice(0, 3), ["bing", "tavily", "firecrawl"]);
  assert.ok(!chain.includes("deepseek-official"));
});

test("an explicitly selected paid engine stays first", () => {
  const chain = buildEngineChain("perplexity", "free-first");
  assert.equal(chain[0], "perplexity");
  assert.ok(!chain.includes("deepseek-official"));
  assert.equal(chain.at(-1), "firecrawl");
});

test("provider pool normalizes legacy strings and redacts every secret", () => {
  const pool = normalizeProviderPool("tavily", { keys: ["secret-a", "secret-a", { secret: "secret-b", enabled: false }] });
  assert.equal(pool.keys.length, 2);
  assert.equal(pool.keys[1].enabled, false);
  const view = redactProviderPool(pool);
  assert.equal(view.count, 2);
  assert.equal(view.enabledCount, 1);
  assert.ok(view.keys.every((entry) => !("secret" in entry)));
  assert.ok(!JSON.stringify(view).includes("secret-a"));
});

test("provider pool randomizes eligible keys and skips unusable keys", () => {
  const pool = normalizeProviderPool("tavily", { keys: [
    { secret: "ready-a", status: "ready" },
    { secret: "bad", status: "invalid" },
    { secret: "spent", status: "exhausted" },
    { secret: "disabled", status: "ready", enabled: false },
    { secret: "ready-b", status: "unchecked" },
  ] });
  const candidates = providerPoolCandidates(pool, () => 1);
  assert.deepEqual(candidates.map((entry) => entry.secret), ["ready-b", "ready-a"]);
});
