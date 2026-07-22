# c3 — Claude Code Concierge

> **Don't reinvent the wheel.** The Claude Code ecosystem already ships thousands of plugins, agents, skills, and MCP servers. The hard part isn't building your own — it's knowing what already exists. c3 checks *before* you build.

**/ccc** (or **/c3**) tells you the best combination of Claude Code **plugins, subagents, skills, and MCP servers** for whatever task you describe — using a **local RAG catalog** so that each recommendation costs almost zero tokens.

```
/ccc I want to build a Stripe subscription billing page
```

→ Returns a prioritized proposal table (what to reuse, what to install, what *not* to install) with ready-to-run install commands.

## Demo

![c3 demo: running /ccc and getting a prioritized reuse-first recommendation](./assets/demo-en.gif)

## Why

c3 was born from a habit worth automating: every time you're about to hand-roll a subagent, a prompt, or an integration, someone in the ecosystem has probably already built — and debugged — a better one. Reuse beats rebuild, which is why c3's recommendation policy literally starts with *"no addition needed — reuse what you already have."* The catalog even indexes your own `~/.claude/agents` and `~/.claude/skills` first.

But checking the ecosystem by hand (or letting an LLM web-research it) costs real time and 100k+ tokens per question. c3 splits the work:

| Phase | Frequency | Cost |
|---|---|---|
| **Crawl** — build `~/.claude/ccc/catalog.jsonl` from public sources | on first use; then when stale (>7 days), in the background | HTTP only, no LLM calls |
| **Retrieve** — IDF-weighted keyword search over the catalog | every request | milliseconds, zero API cost |
| **Propose** — Claude synthesizes the combination | every request | a few thousand tokens |

Default path: no embedding API, no npm dependencies — Node.js standard library only. Optional `--vectors` mode adds a REST embedding call (still no npm packages).

## How it works

### Architecture

```mermaid
flowchart TB
    subgraph sources["Catalog sources — crawled via HTTP only, no LLM"]
        A1["~/.claude/agents<br/>installed agents"]
        A2["~/.claude/skills<br/>installed skills"]
        B1["wshobson/agents<br/>marketplace.json"]
        B2["VoltAgent lists<br/>subagents + skills"]
        B3["anthropics/skills<br/>official skills"]
        B4["aitmpl.com<br/>components.json"]
        B5["MCP Registry<br/>v0/servers API"]
    end

    CRON["optional weekly cron /<br/>Task Scheduler"] --> BUILD
    BUILD["build-index.mjs<br/>parse + dedupe, official first"]
    EMB["embed.mjs — optional<br/>Gemini / Voyage / OpenAI via REST"]

    subgraph store["~/.claude/ccc/"]
        CFG["config.json<br/>fulltext / vectors mode"]
        CAT["catalog.jsonl<br/>~5,000 entries"]
        VEC["vectors.bin — optional<br/>L2-normalized float32"]
        META["meta.json<br/>builtAt, counts"]
    end

    SEARCH["search.mjs<br/>IDF lexical + optional RRF hybrid"]
    CLAUDE["Claude Code<br/>/ccc or /c3 skill"]

    sources --> BUILD
    CFG -.-> BUILD
    CFG -.-> SEARCH
    BUILD --> CAT
    BUILD --> META
    BUILD --> EMB --> VEC
    CAT --> SEARCH
    VEC --> SEARCH
    CLAUDE -->|"--all / --get"| SEARCH
    SEARCH --> CLAUDE
```

### Query flow

```mermaid
sequenceDiagram
    participant U as User
    participant C as Claude (/ccc skill)
    participant S as search.mjs
    participant B as build-index.mjs

    U->>C: /ccc "task description"
    C->>C: extract 4–8 English keywords
    C->>S: node search.mjs --all "keywords" --task "原文"
    S->>S: freshness check (meta.json)
    alt catalog missing
        S->>B: sync rebuild (HTTP only, no LLM)
        B-->>S: fresh catalog
    else catalog older than 7 days
        S-->>S: serve current catalog
        S->>B: rebuild in background
    end
    S->>S: IDF-weighted lexical scoring
    opt vectors enabled and API key set
        S->>S: embed query, cosine over vectors.bin, RRF fusion
    end
    S-->>C: compact TSV (per-kind caps: agent 5 / plugin 5 / skill 6 / mcp 5)
    C->>C: pick 3–5 finalists by priority policy<br/>(reuse > plugin > skill > MCP > standalone agent)
    C->>S: node search.mjs --get "finalists"
    S-->>C: full JSON with install commands
    C-->>U: proposal table + rationale + security notes
```

## Catalog sources

- Your already-installed agents and skills (`~/.claude/agents/`, `~/.claude/skills/`) — reuse comes first
- [wshobson/agents](https://github.com/wshobson/agents) plugin marketplace (94 plugins)
- [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) (100+ agents)
- [anthropics/skills](https://github.com/anthropics/skills) — official Anthropic skills
- [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) — vendor & community skills
- [aitmpl.com](https://github.com/davila7/claude-code-templates) components catalog (800+ community skills)
- [Official MCP Registry](https://registry.modelcontextprotocol.io) (~2,300 active servers)

Source counts above are approximate (as noted in the indexer). Add sources by editing `skills/ccc/scripts/build-index.mjs` (one function per source).

Catalog builds a local search index on your machine. In default fulltext mode, that local `catalog.jsonl` can include names, tags, descriptions, and clipped body text from installed agents/skills and selected public skill sources (up to 4,000 chars per entry); `--no-fulltext` skips body indexing. That does **not** re-license those upstream projects — each plugin, agent, skill, or MCP server remains under its own license and terms. c3 points you at candidates; you still follow each project's license when you install or reuse it. Public endpoints and upstream ToS can change; the indexer may then skip or drop a source.

## Install

**Prerequisites**: [Node.js](https://nodejs.org/) (for catalog build/search) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

```sh
git clone https://github.com/happygoluckydev/c3.git
cd c3
sh install.sh        # Windows PowerShell: ./install.ps1
```

This copies the skill to `~/.claude/skills/ccc/` and the `/c3` command alias to `~/.claude/commands/`, and writes `~/.claude/ccc/config.json`. Restart your Claude Code session, then run `/ccc <task>` or `/c3 <task>`.

### Install options

| sh | PowerShell | Effect |
|---|---|---|
| (default) | (default) | Lexical search incl. document bodies (fulltext). Zero external services. |
| `--no-fulltext` | `-NoFulltext` | Lite: skip body indexing — catalog ~half the size, slightly lower recall. |
| `--vectors gemini\|voyage\|openai` | `-Vectors gemini` | Hybrid search: lexical + embedding ranks fused with RRF. Needs `GEMINI_API_KEY` / `VOYAGE_API_KEY` / `OPENAI_API_KEY`. Embedding cost ≈ $0.01 per full rebuild (5k short texts); queries are one embed call each. |

Options are stored in `~/.claude/ccc/config.json` — edit it (or re-run the installer) to switch modes. If the vector provider's API key is missing, search falls back to lexical mode.

#### Optional `--vectors`: what leaves your machine

Default install is **local-only** (lexical / fulltext). With `--vectors`, the chosen provider receives:

- **Catalog rebuild**: names, tags, and descriptions for embedding (not fulltext bodies)
- **Each `/ccc` query**: the search query string (keywords / task text) for one embed call

API keys stay in your environment variables. Review the provider's terms and data policies before enabling. For confidential task text, keep the default lexical mode (no external embed calls).

## Keeping the catalog fresh

On `/ccc`, `search.mjs` builds the catalog synchronously if it is missing. If it exists but is older than 7 days, the current catalog is used immediately and a rebuild starts in the background (HTTP only, no LLM).

To refresh on a fixed schedule instead:

```sh
sh setup-schedule.sh      # macOS/Linux: weekly cron job (Mon 09:00)
```

```powershell
./setup-schedule.ps1      # Windows: weekly scheduled task (Mon 09:00)
```

## Recommendation policy

Proposals follow a strict priority order (see `skills/ccc/SKILL.md`):

1. **No addition needed** — built-in features or already-installed agents/skills win
2. **Plugins** — maintained bundles of agents + skills + commands
3. **Skills** — procedural knowledge alone is enough; official skills preferred
4. **MCP servers** — only when external service access is truly required (they cost resident context)
5. **Standalone community agents** — to fill remaining gaps

Community-made definition files can carry prompt-injection risks — c3 always reminds you to read them before installing.

### Optional: prune unused agents

If you want to inventory unused installed agents and estimate resident context cost:

```sh
node ~/.claude/skills/ccc/scripts/prune.mjs          # dry-run report
node ~/.claude/skills/ccc/scripts/prune.mjs --apply  # archive unused to ~/.claude/agents-archive/
```

## 日本語

![c3 の操作イメージ: /ccc を実行して優先順位付きの提案を得る](./assets/demo-ja.gif)

**「車輪の再発明をしたくない」から生まれたツールです。** 自作のエージェントやスキルを書き始める前に、エコシステムに既にある数千のプラグイン・エージェント・スキル・MCP サーバーから「もう存在するもの」を探して提案します。タスクを伝えると「追加不要（手元の資産の再利用）→ プラグイン → スキル → MCP → コミュニティ製エージェント」の優先順で最適な組み合わせを提案する Claude Code スキルです。

クロールは HTTP のみ（LLM 不使用）。カタログが無い初回は同期構築、7 日超で古い場合は手元のカタログで即応答しつつバックグラウンド再構築します。提案時の検索はローカルのみなのでクレジット消費を最小化できます。導入は Node.js がある環境で `install.sh`（または `install.ps1`）を実行し、新しいセッションで `/ccc <やりたいこと>` を実行してください。

MIT は **本リポジトリのコード／ドキュメントのみ**に適用されます。カタログが指す第三者のプラグイン・エージェント・スキル・MCP は各プロジェクトのライセンス・利用条件に従ってください。既定のローカル検索では、`catalog.jsonl` に名前・タグ・説明文に加えて agent/skill 本文の一部（最大 4,000 文字）が保存される場合があります。`--vectors` を有効にした場合、外部 Embedding API に送信されるのは名前・タグ・説明文とクエリで、fulltext 本文は送信されません。機密タスクでは既定のローカル検索を推奨します。

## License

[MIT License](./LICENSE) (`SPDX-License-Identifier: MIT`)

Copyright holder: see [AUTHORS](./AUTHORS) (`Copyright (c) 2026 happygoluckydev` in `LICENSE`). Author: [happyg01uckydev](https://x.com/happyg01uckydev).

The MIT license covers **this repository's code and documentation only**. Catalog entries that c3 discovers or recommends (third-party plugins, agents, skills, MCP servers, and any locally indexed metadata or clipped body text) remain under **their own licenses and terms** — c3 does not re-license them. Install copies the notice into `~/.claude/skills/ccc/LICENSE` with the skill. Major scripts carry an `SPDX-License-Identifier: MIT` header for machine-readable reuse.
