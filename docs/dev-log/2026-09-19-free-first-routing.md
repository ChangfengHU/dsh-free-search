# Free-first search routing

## Outcome

- Ordinary searches use free/keyless engines first.
- Tavily and Firecrawl are direct Web Providers, not MCP services. Tavily is
  first for `quality-first`; Firecrawl remains the final escalation for
  `free-first`.
- Provider credentials live in Fleet Vault pools. Search starts at a random
  eligible key, rotates after authentication/quota failures and cools failed
  keys down for five minutes.
- `minimumSources` makes insufficient evidence trigger the next eligible
  engine instead of accepting a partial result silently.
- Settings now exposes a top-level Web section with batch key import, redacted
  fingerprints, provider health and manual refresh. Firecrawl can report exact
  official credit usage; Tavily reports key validity because its public API
  does not expose remaining credits.

## Verification

- `pnpm test`: 5/5 routing and provider-pool tests passed.
- `node --check lib/index.js`: passed.
- Production Vault bridge: 9 Tavily keys, 0 Firecrawl keys, no secret field or
  key prefix returned to the browser.
- Manual Tavily refresh: 9/9 keys valid; one live Tavily search returned two
  sources.
- Browser verification at 1440x1000: Settings > Web loaded the provider cards,
  both key-pool panels and the existing routing configuration.
