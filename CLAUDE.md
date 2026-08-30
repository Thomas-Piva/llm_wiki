# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this fork is

Upstream (`nashsu/llm_wiki`) is a Tauri desktop app: an LLM reads your documents and builds a
structured markdown wiki. This fork adds a **headless deployment** — the same engine running on a
server with no GUI, serving a web UI and MCP — and is in production on a client's box.

Branch: `vps-web`. Remote `origin` is the fork, `upstream` is nashsu.

## Commands

```bash
npm run typecheck      # tsc --build — walks project references. THE one that matters.
npm run test:mocks     # the real test command: 2012 tests, excludes real-llm and mcp-server
npm run mcp:test       # mcp-server has its own runner (node:test on compiled dist)
npm run build          # typecheck + vite build — what CI runs before packaging
npm run dev            # vite dev server
npx vitest run <file>  # one file, while iterating
```

### Two ways to be fooled by a green check

**`npx tsc --noEmit -p tsconfig.json` is not the typecheck.** It passes on code that
`npm run typecheck` (`tsc --build`) rejects, because the latter follows project references. Three
type errors once reached a tagged release this way. Use `npm run typecheck`.

**`npx vitest run` (bare) is not the test suite.** It collects `*.real-llm.test.ts`, which need
network and fail without it, plus `mcp-server/**` and a few `tools/headless-ingest` files written
for `node:test`, which vitest cannot execute at all. The result looks like "6 failures and 16
broken files" permanently. `npm run test:mocks` excludes all of that and is **fully green**; run
`npm run mcp:test` alongside it.

And a duplicate import can pass `tsc` and still break the vite transform, taking a dozen test
files down. If tests fail to *collect*, read the transform error before touching the tests.

## Architecture: one engine, three ways in

The engine is roughly 7% of the code (identity, index, retrieval, ingest); the rest is scaffolding
that works. Three deployments share it:

| | entry point | invoke goes to |
|---|---|---|
| **Desktop** | Tauri, `src-tauri/src/` (19 command modules) | Rust |
| **Headless** | `tools/headless-ingest/run.ts`, `light-backend.ts` | `invoke-shim.ts` |
| **Web UI** | browser → `POST /invoke` on light-backend | `web-invoke.ts` |

`invoke(cmd, args)` is the seam. Everything that touches the vault or the index goes through it,
which is why a change to storage or embedding usually means one file, not many.

### ⛔ `invoke-shim.ts` and `web-invoke.ts` are two separate implementations

They dispatch the same command names with different code. A rule added to one covers **one of the
two ways into the vault**. This has bitten twice: vault write policy applied only to the shim, and
`search_project` in the web path ran keyword-only while the API path did hybrid search. When you
add or change a command, check whether the other file has it too.

### The index

LanceDB on disk at `<vault>/.llm-wiki/lancedb`, table `wiki_chunks_v2`, behind
`tools/headless-ingest/vector-store.ts`. No service, no port. Replaced an external R2R deployment:
same corpus, p50 1848 ms → 7 ms.

Two things about it are load-bearing:

- **Compaction without `cleanupOlderThan` does nothing.** The weight is version history, not data
  — measured 3.3 GB of manifests against 84 MB of rows, because each manifest lists every
  fragment, so keeping them costs O(N²). `vectorCompact()` passes it; call it periodically during
  long write runs, never per page.
- **`page_id` has two conventions.** The desktop app writes the **basename**; the headless backfill
  writes the **path relative to `wiki/`**. Both are accepted on read (`pageIndex` in
  `vault-api.ts`). The path is the better key — 104 of 10,942 files in the production vault share a
  basename, and the short key silently lets those pairs overwrite each other.

### Search

`ricercaIbrida()` in `vault-api.ts` runs ripgrep and the vector lane together and merges by path.
Exported deliberately: the local API, the MCP server and the web UI all call it. Do not write a
fourth.

### Vault write policy

Applied at the single write choke point in both shims: every wiki page gets a stable `id:` and a
`visibility:` label if it lacks one, and deleting a wiki page is refused and logged
(`VAULT_APPEND_ONLY=0` opts out). See `note-policy.ts`.

`visibility` is also a column on the chunk table, and search **pre-filters** on it — before the
vector scan, not after. Filtering afterwards loses results exactly on the selective queries where
permissions are the point.

## Reasoning: the one deliberate divergence from upstream

`src/lib/llm-providers.ts` sends `{ enabled: false }` for OpenRouter when reasoning is off.
Upstream sends `{ effort: "none" }`. **Keep ours.**

`effort` is per-model and models advertise which values they accept; `deepseek-v4-flash-0731`,
which a client's vault runs on, lists only max/high/low. Sending "none" leans on a value it never
claimed. Measured when it happened: 6.3s → 15.0s per call, 0 → 109 reasoning tokens, no error.

`src/lib/__tests__/llm-providers.test.ts` guards this and goes red if a merge reintroduces
`effort`. Upstream's `57c5576` adds a second OpenRouter branch ending in `return body` that makes
ours dead code — it merges **without a conflict**, so nothing warns you. After any upstream merge,
grep `llm-providers.ts` for a duplicate OpenRouter branch before trusting the tests.

## Merging upstream

`git checkout --ours/--theirs` replaces the **whole file**, not the conflicting hunk. Used as a
shortcut on 17 files it silently dropped this fork's side on 4 of them. Resolve hunks; for JSON
(the i18n bundles) merge programmatically rather than by hand.

## Production deployment (client box)

Headless services under systemd; the app is a **copy** at `/opt/llm-wiki-headless/llm_wiki`, not a
git checkout, so deploys are file copies — see `fortezza-kb/deploy/ship_code.sh`, which verifies
each file arrived by grepping for a string that must exist in it. Shipping a new file without its
dependencies once killed the ingest queue with `Export named 'isDerivedPage' not found`; derive the
file list from `git status`, not from memory.

Bun runs the TypeScript directly there — no build step for the server. Only `mcp-server` is
compiled (`dist/`).

A `systemd.path` unit indexes pages within a second of them appearing. **inotify is not
recursive**: it watches directories, not their branches, so the unit names folders explicitly.
