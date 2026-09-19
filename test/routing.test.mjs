import assert from "node:assert/strict";
import test from "node:test";

import {
  VYIBC_FIRECRAWL_ENGINE,
  buildEngineChain,
  searchVyibcFirecrawl,
} from "../lib/index.js";

test("free-first exhausts free engines before managed Firecrawl", () => {
  const chain = buildEngineChain("bing", "free-first");
  assert.equal(chain[0], "bing");
  assert.equal(chain.at(-1), VYIBC_FIRECRAWL_ENGINE);
  assert.ok(chain.indexOf("ddg") < chain.indexOf(VYIBC_FIRECRAWL_ENGINE));
  assert.ok(chain.indexOf("exa") < chain.indexOf(VYIBC_FIRECRAWL_ENGINE));
  assert.ok(!chain.includes("perplexity"), "unselected paid engines must not be called automatically");
});

test("quality-first starts with managed Firecrawl and then falls back free", () => {
  const chain = buildEngineChain("bing", "quality-first");
  assert.equal(chain[0], VYIBC_FIRECRAWL_ENGINE);
  assert.equal(chain[1], "bing");
  assert.ok(!chain.includes("deepseek-official"));
});

test("an explicitly selected paid engine stays first without entering automatic paid fallbacks", () => {
  const chain = buildEngineChain("perplexity", "free-first");
  assert.equal(chain[0], "perplexity");
  assert.ok(!chain.includes("deepseek-official"));
  assert.equal(chain.at(-1), VYIBC_FIRECRAWL_ENGINE);
});

test("managed Firecrawl adapter calls the registered MCP tool and normalizes sources", async () => {
  let call;
  const tools = {
    async execute(input) {
      call = input;
      return {
        isError: false,
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            data: {
              data: {
                web: [{
                  url: "https://example.com/a",
                  title: "A",
                  description: "evidence",
                  publishedDate: "2026-09-19",
                }],
              },
            },
          }),
        }],
      };
    },
  };

  const result = await searchVyibcFirecrawl(tools, "unused-token", "query", 5, { days: 7 });
  assert.equal(call.name, "mcp__vyibc-firecrawl__search");
  assert.deepEqual(call.arguments.sources, ["web"]);
  assert.equal(call.arguments.tbs, "qdr:w");
  assert.deepEqual(result.sources, [{
    url: "https://example.com/a",
    title: "A",
    snippet: "evidence",
    publishedAt: "2026-09-19",
  }]);
});

test("managed Firecrawl falls back to its authenticated MCP endpoint when ToolRuntime did not register it", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, init) => {
    request = init;
    return {
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, data: { data: { web: [{ url: "https://example.com/fallback" }] } } }),
          }],
        },
      }),
    };
  };
  try {
    const tools = {
      execute: async () => ({
        isError: true,
        content: [{ type: "text", text: 'Error: unknown tool "mcp__vyibc-firecrawl__search"' }],
      }),
    };
    const result = await searchVyibcFirecrawl(tools, "secret-token", "query", 5, null);
    assert.equal(request.headers.Authorization, "Bearer secret-token");
    const rpc = JSON.parse(request.body);
    assert.equal(rpc.params.name, "vyibc-firecrawl_search");
    assert.equal(result.sources[0].url, "https://example.com/fallback");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
