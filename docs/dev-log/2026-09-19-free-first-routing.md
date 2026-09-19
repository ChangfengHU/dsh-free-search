# Free-first search routing

## Outcome

- Ordinary searches use free/keyless engines first.
- Managed `vyibc-firecrawl` is first for explicit `quality-first` searches and
  remains the final escalation for `free-first` searches.
- Explicit engine selection stays authoritative; automatic routing does not
  consume unrelated configured paid API keys.
- `minimumSources` makes insufficient evidence trigger the next eligible
  engine instead of accepting a partial result silently.
- Managed Firecrawl uses the registered MCP tool when available and the same
  authenticated MCP endpoint when an older DSH profile did not register it.

## Verification

- `pnpm test`: 5/5 routing and adapter tests passed.
- `node --check lib/index.js`: passed.
- Production raw-search smoke test: `free-first` used Bing and returned three
  sources; `quality-first` used `vyibc-firecrawl` and returned three sources.
