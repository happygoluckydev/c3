# v0.1 comparison benchmark (20 tasks)

Use the same task with three setups and record whether c3 beat the baseline.

| Setup | What to use |
|---|---|
| A | No c3 — memory / bookmarks only |
| B | Official Claude Code surfaces only (built-ins, installed assets, official marketplace UI) |
| C | c3 (`/ccc` or `/c3`) |

Score each task yes/no:

1. A useful candidate appeared in the top 3
2. It was installable or already available
3. Built-ins / existing assets were preferred when enough
4. License or safety was not misrepresented
5. Research time / tokens dropped meaningfully vs A or B

Continue after v0.1 if at least one holds: ≥5/10 users reuse c3, ≥6/20 tasks beat official-only discovery, research time halves, or license/safety/existing-asset priority is praised.

## Tasks

1. Stripe subscription billing page
2. GitHub PR review comments automation
3. Slack incident notification bot
4. Linear issue triage from chat
5. PDF invoice extraction
6. Spreadsheet cleanup / normalization
7. Google Drive document search
8. Calendar scheduling assistant
9. Postgres schema migration helper
10. CI failure diagnosis for GitHub Actions
11. Security review of an auth change
12. Accessibility pass on a React form
13. Figma-to-code handoff
14. API docs generation from OpenAPI
15. Browser E2E test scaffold
16. Log/metrics dashboard wiring
17. Customer support reply drafting
18. Multi-file refactor with tests
19. Local MCP server for a SaaS API
20. Prune unused installed agents / reduce resident context
