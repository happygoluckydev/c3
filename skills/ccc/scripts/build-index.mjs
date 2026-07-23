#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// ccc: カタログ構築バッチ
// 目的: プラグイン/エージェント/スキル/MCP の情報を一括クロールして catalog.jsonl に保存する。
// クレジット消費を抑えるため LLM は使わない(HTTP 取得のみ)。週1回程度の実行を想定。
// 実行: node build-index.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR, CATALOG, META, CATALOG_SCHEMA_VERSION, parseFrontmatter, loadConfig, resolveProvider, embedTexts, writeVectors, writeAtomic, withCatalogMetadata } from './embed.mjs';

// インストール時オプション(install.sh --no-fulltext / --vectors <provider>)は config.json 経由で効く
const cfg = loadConfig();
const errors = [];

// 収録対象は「配布物(plugin)」と「実行時の機能種別(skill / hook / LSP など)」を
// 分ける。plugin は複数の機能を束ねる配布形式であり、他の kind と同列の能力ではない。
const OFFICIAL_MARKETPLACE = {
    repo: 'anthropics/claude-plugins-official',
    name: 'claude-plugins-official',
    url: 'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json',
};

async function fetchOk(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'ccc' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res;
}
const fetchJson = (url) => fetchOk(url).then((r) => r.json());
const fetchText = (url) => fetchOk(url).then((r) => r.text());

// 本文(検索語彙用)は先頭4000字で打ち切り:
// カタログ肥大を防ぎつつ、冒頭に重要語が集まる md 文書では再現率への影響が小さい
const clipBody = (body) => body.slice(0, 4000);
// セグメントの先頭は英数字(パストラバーサル対策で "." "-" 単独始まりを排除)、
// 以降は英数字/アンダースコア/ハイフン/ドットを許容する(バージョン付きパス
// "tools/v1.2-migrate" のようなドット入りの正当な path を弾いていたため緩和。
// /code-review で発見・修正)
const SAFE_CATALOG_PATH = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;

function safeCatalogPath(value, source) {
    const s = String(value || '').trim();
    if (!SAFE_CATALOG_PATH.test(s)) {
        errors.push(`${source}: skipped unsafe path ${JSON.stringify(s).slice(0, 120)}`);
        return null;
    }
    return s;
}

// aitmpl.com の path 用の SAFE_CATALOG_PATH は許可制(allowlist)で URL やパッケージ名には
// 厳しすぎる。install: 文字列に外部データを埋め込む他のソース(プラグイン名・README中の
// URL・MCPレジストリのURL/パッケージID)向けに、シェルメタ文字/制御文字だけを拒否する
// denylist 版を用意する(safeCatalogPath は aitmpl 専用のまま残す。
// /code-review で発見: このガードが aitmpl.com にしか適用されていなかった)
const UNSAFE_INSTALL_CHARS = /[;&|`$()<>\n\r"'\\]/;

function safeForInstallString(value, source) {
    const s = String(value || '').trim();
    if (!s || UNSAFE_INSTALL_CHARS.test(s)) {
        errors.push(`${source}: skipped unsafe value ${JSON.stringify(s).slice(0, 120)}`);
        return null;
    }
    return s;
}

// 公開マーケットプレイスの分類名はソースごとに少しずつ異なる。検索・集計に使える
// 粗いドメインへ正規化し、元の分類名は tags に残す。
function normalizeDomain(category) {
    const c = String(category || '').trim().toLowerCase();
    const aliases = {
        database: 'data', data: 'data', analytics: 'data',
        deployment: 'infrastructure', infrastructure: 'infrastructure', monitoring: 'infrastructure',
        development: 'development', security: 'security', testing: 'testing',
        design: 'design', productivity: 'productivity',
        documentation: 'documents', documents: 'documents',
        communication: 'communication', automation: 'automation',
        business: 'business', research: 'research', learning: 'research',
    };
    return aliases[c] || (c ? 'other' : undefined);
}

function marketplaceInstall(pluginName, marketplaceName, marketplaceSource = marketplaceName) {
    return `/plugin marketplace add ${marketplaceSource} してから /plugin install ${pluginName}@${marketplaceName}`;
}

function pluginTags(plugin, extraTags = []) {
    const upstreamTags = Array.isArray(plugin.tags)
        ? plugin.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean)
        : [];
    const author = typeof plugin.author === 'object' ? plugin.author.name : plugin.author;
    const authoredByAnthropic = String(author || '').trim().toLowerCase() === 'anthropic';
    return [...new Set([
        ...upstreamTags,
        ...extraTags,
        ...(authoredByAnthropic ? ['anthropic-authored'] : []),
    ].filter(Boolean))];
}

function officialPluginReadme(plugin) {
    if (typeof plugin.source === 'string' && plugin.source.startsWith('./')) {
        const relative = safeCatalogPath(plugin.source.slice(2), OFFICIAL_MARKETPLACE.repo);
        if (relative) return `https://github.com/${OFFICIAL_MARKETPLACE.repo}/tree/main/${relative}`;
    }
    const homepage = plugin.homepage
        ? safeForInstallString(plugin.homepage, OFFICIAL_MARKETPLACE.repo)
        : null;
    return homepage || 'Claude Code のプラグイン詳細を確認';
}

function marketplaceEntry(plugin, { source, marketplace, marketplaceSource, extraTags = [] }) {
    const name = safeForInstallString(plugin.name, source);
    if (!name) return null;
    const category = String(plugin.category || '').trim();
    const domain = normalizeDomain(category);
    return {
        kind: 'plugin',
        name,
        description: plugin.description || '',
        source,
        tags: [...new Set([category, domain, ...pluginTags(plugin, extraTags)].filter(Boolean))],
        domain,
        availability: 'installable',
        packaging: 'plugin',
        install: marketplaceInstall(name, marketplace, marketplaceSource),
    };
}

function componentEntry(kind, name, description, plugin, { tags = [], execution, install, prerequisites, availability = 'installable' } = {}) {
    return {
        kind,
        name,
        description,
        source: OFFICIAL_MARKETPLACE.repo,
        tags: [...new Set([
            kind,
            normalizeDomain(plugin.category),
            ...pluginTags(plugin, ['anthropic-curated', ...tags]),
        ].filter(Boolean))],
        domain: normalizeDomain(plugin.category),
        availability,
        packaging: 'plugin-component',
        execution,
        parentPlugin: plugin.name,
        install: install || marketplaceInstall(plugin.name, OFFICIAL_MARKETPLACE.name, OFFICIAL_MARKETPLACE.repo),
        ...(prerequisites && prerequisites.length ? { prerequisites } : {}),
    };
}

// --- ソース: 導入済みユーザーエージェント (~/.claude/agents) ---
// 「既に持っているもの」を最優先で提案するために必ずカタログに含める
function indexInstalledAgents() {
    const out = [];
    const dir = path.join(os.homedir(), '.claude', 'agents');
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try {
            const fm = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
            out.push({
                kind: 'agent',
                name: fm.name || f.replace(/\.md$/, ''),
                description: fm.description || '',
                source: 'installed',
                availability: 'installed',
                packaging: 'standalone',
                execution: 'isolated-agent',
                install: '導入済み (~/.claude/agents)',
                fulltext: clipBody(fm.body),
            });
        } catch (e) { errors.push(`installed:${f}: ${e.message}`); }
    }
    return out;
}

// --- ソース: 導入済みユーザースキル (~/.claude/skills/*/SKILL.md) ---
function indexInstalledSkills() {
    const out = [];
    const dir = path.join(os.homedir(), '.claude', 'skills');
    if (!fs.existsSync(dir)) return out;
    for (const d of fs.readdirSync(dir)) {
        const skillMd = path.join(dir, d, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        try {
            const fm = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
            out.push({
                kind: 'skill',
                name: fm.name || d,
                description: fm.description || '',
                source: 'installed',
                availability: 'installed',
                packaging: 'standalone',
                execution: 'prompt',
                install: '導入済み (~/.claude/skills)',
                fulltext: clipBody(fm.body),
            });
        } catch (e) { errors.push(`installed-skill:${d}: ${e.message}`); }
    }
    return out;
}

// --- ソース: wshobson/agents 公式マーケットプレイス (94 プラグイン) ---
// marketplace.json 1ファイルで全プラグインの説明が取れるので低コスト
async function indexWshobson() {
    const j = await fetchJson('https://raw.githubusercontent.com/wshobson/agents/main/.claude-plugin/marketplace.json');
    const out = [];
    for (const p of j.plugins || []) {
        // p.name は install: 文字列にそのまま埋め込むため、コピペ実行可能な形になる前に検証する
        // (/code-review で発見: このガードが aitmpl.com にしか適用されていなかった)
        const name = safeForInstallString(p.name, 'wshobson/agents');
        if (!name) continue;
        out.push({
            kind: 'plugin',
            name,
            description: p.description || '',
            source: 'wshobson/agents',
            tags: [p.category].filter(Boolean),
            availability: 'installable',
            packaging: 'plugin',
            install: `/plugin marketplace add wshobson/agents してから /plugin install ${name}@claude-code-workflows`,
        });
    }
    return out;
}

// --- ソース: Anthropic公式・コミュニティのプラグインマーケットプレイス ---
// marketplace.json は配布単位(plugin)を列挙する最も安定した一次情報。個別リポジトリを
// 推測してクロールせず、Claude Code がそのままインストールする定義だけを採用する。
async function indexMarketplace(url, { source, marketplaceSource, extraTags = [] }) {
    const j = await fetchJson(url);
    const marketplace = safeForInstallString(j.name, source);
    if (!marketplace) return [];
    const out = [];
    for (const plugin of j.plugins || []) {
        const entry = marketplaceEntry(plugin, { source, marketplace, marketplaceSource, extraTags });
        if (entry) out.push(entry);
    }
    return out;
}

// 公式ディレクトリは plugin の説明だけでなく、LSP を marketplace.json で明示している。
// Hook は公式リポジトリ内の hooks.json を読む。これにより plugin という包装だけでなく、
// 実際に使える機能種別でも検索できる。
async function indexOfficialMarketplace() {
    const j = await fetchJson(OFFICIAL_MARKETPLACE.url);
    const marketplace = safeForInstallString(j.name, OFFICIAL_MARKETPLACE.repo);
    if (!marketplace) return [];
    const plugins = (j.plugins || []).filter((p) => safeForInstallString(p.name, OFFICIAL_MARKETPLACE.repo));
    const out = [];
    for (const plugin of plugins) {
        const entry = marketplaceEntry(plugin, {
            source: OFFICIAL_MARKETPLACE.repo,
            marketplace,
            marketplaceSource: OFFICIAL_MARKETPLACE.repo,
            extraTags: ['anthropic-curated'],
        });
        if (entry) out.push(entry);

        // lspServers は公式 marketplace に明示された構造化データなので、個別ソース取得なしで
        // 正確に LSP カテゴリを作れる。
        if (plugin.lspServers) {
            const servers = typeof plugin.lspServers === 'object' && !Array.isArray(plugin.lspServers)
                ? Object.keys(plugin.lspServers)
                : [plugin.name];
            for (const server of servers) {
                const config = typeof plugin.lspServers === 'object' && !Array.isArray(plugin.lspServers)
                    ? plugin.lspServers[server]
                    : null;
                const command = config && typeof config === 'object' && typeof config.command === 'string'
                    ? (safeForInstallString(config.command, `${OFFICIAL_MARKETPLACE.repo}:${plugin.name}:lsp`) || '')
                    : '';
                const setup = officialPluginReadme(plugin);
                const prerequisite = command
                    ? `${command} を PATH 上で実行できるように言語サーバーを別途インストール`
                    : '言語サーバーの実行ファイルを別途インストール';
                out.push(componentEntry(
                    'lsp',
                    `${plugin.name}:${server}`,
                    `${plugin.description || plugin.name} Language Server Protocol integration for code intelligence. Prerequisite: ${prerequisite}.`,
                    plugin,
                    {
                        tags: ['code-intelligence', 'language-server'],
                        execution: 'external-service',
                        prerequisites: [prerequisite],
                        install: `${marketplaceInstall(plugin.name, marketplace, OFFICIAL_MARKETPLACE.repo)}; 次に ${prerequisite}。設定手順: ${setup}`,
                    },
                ));
            }
        }

        // Output style は現行公式マーケットプレイスでは専用 plugin として配布されている。
        // 表記揺れを許容しつつ、説明・名前が明示するものだけを採用して誤分類を避ける。
        if (/output[- ]style/i.test(`${plugin.name} ${plugin.description || ''}`)) {
            out.push(componentEntry(
                'output-style',
                plugin.name,
                plugin.description || 'Claude Code output style plugin.',
                plugin,
                { tags: ['presentation', 'response-format'], execution: 'prompt' },
            ));
        }

        // CLAUDE.md を扱う plugin は、永続コンテキストを再利用する候補として別カテゴリ化する。
        if (/claude[ .-]?md/i.test(`${plugin.name} ${plugin.description || ''}`)) {
            out.push(componentEntry(
                'context',
                plugin.name,
                plugin.description || 'Claude Code persistent context plugin.',
                plugin,
                { tags: ['claude-md', 'persistent-context'], execution: 'prompt' },
            ));
        }
    }

    // リポジトリ内 plugin の hooks.json は marketplace の source が ./ で始まるものだけを
    // 対象にする。外部リポジトリを無差別に追わず、Anthropic 管理リポジトリの公開内容だけを
    // 取得するため、更新時のコストとサプライチェーン上の面積を抑えられる。
    try {
        const tree = await fetchJson('https://api.github.com/repos/anthropics/claude-plugins-official/git/trees/main?recursive=1');
        const treePaths = new Set((tree.tree || []).map((t) => t.path));
        const directPlugins = plugins.filter((p) => typeof p.source === 'string' && p.source.startsWith('./'));
        const hooks = await Promise.allSettled(directPlugins.map(async (plugin) => {
            const relative = safeCatalogPath(plugin.source.slice(2), OFFICIAL_MARKETPLACE.repo);
            if (!relative) return [];
            const hookPath = `${relative}/hooks/hooks.json`;
            if (!treePaths.has(hookPath)) return [];
            const config = await fetchJson(`https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/${hookPath}`);
            return Object.keys(config.hooks || {}).map((event) => componentEntry(
                'hook',
                `${plugin.name}:${event}`,
                `${plugin.description || plugin.name} — ${event} lifecycle hook.`,
                plugin,
                { tags: ['lifecycle', event], execution: 'deterministic-hook' },
            ));
        }));
        hooks.forEach((r, i) => {
            if (r.status === 'fulfilled') out.push(...r.value);
            else errors.push(`official-hooks:${directPlugins[i].name}: ${r.reason && r.reason.message}`);
        });
    } catch (e) {
        // tree API が一時的に失敗しても、既に取得済みの公式 plugin/LSP/Output Style を捨てない。
        errors.push(`official-hooks: ${e.message}`);
    }
    return out;
}

async function indexOfficialCommunityPlugins() {
    return indexMarketplace(
        'https://raw.githubusercontent.com/anthropics/claude-plugins-community/main/.claude-plugin/marketplace.json',
        {
            source: 'anthropics/claude-plugins-community',
            marketplaceSource: 'anthropics/claude-plugins-community',
            extraTags: ['community'],
        },
    );
}

async function indexKnowledgeWorkPlugins() {
    return indexMarketplace(
        'https://raw.githubusercontent.com/anthropics/knowledge-work-plugins/main/.claude-plugin/marketplace.json',
        {
            source: 'anthropics/knowledge-work-plugins',
            marketplaceSource: 'anthropics/knowledge-work-plugins',
            extraTags: ['anthropic-published', 'knowledge-work'],
        },
    );
}

// --- ソース: Claude Code標準機能とローカルの永続コンテキスト ---
// 「追加不要」を根拠付きで提案するための builtin と、既にある CLAUDE.md/rules を index 化する。
// 本文は機密情報を含み得るので、context は存在と配置だけを保持し本文を保存しない。
function indexBuiltinAndContext() {
    const out = [
        {
            kind: 'builtin',
            name: 'Claude Code built-in tools and skills',
            description: 'Built-in file, search, shell, web, and bundled skill capabilities. Prefer these when no extension is needed.',
            source: 'claude-code built-in',
            tags: ['official', 'builtin', 'no-install'],
            availability: 'built-in',
            packaging: 'built-in',
            execution: 'prompt',
            sourceClass: 'official',
            install: '追加不要 (Claude Code 組み込み)',
        },
        {
            kind: 'monitor',
            name: 'Claude Code plugin monitor configuration',
            description: 'Official plugin component for background monitor configurations. No official installable monitor plugin is currently declared; use this when authoring a plugin is required.',
            source: 'claude-code plugin API',
            tags: ['official', 'monitor', 'background', 'plugin-component'],
            availability: 'authoring-required',
            packaging: 'plugin-component',
            execution: 'background-monitor',
            sourceClass: 'official',
            install: '公式プラグイン仕様に従い monitors/monitors.json を作成',
        },
    ];
    const candidates = [
        { file: path.join(os.homedir(), '.claude', 'CLAUDE.md'), scope: 'user' },
        { file: path.join(process.cwd(), 'CLAUDE.md'), scope: 'project' },
        { file: path.join(process.cwd(), 'CLAUDE.local.md'), scope: 'project-local' },
        { file: path.join(process.cwd(), '.claude', 'CLAUDE.md'), scope: 'project' },
    ];
    for (const { file, scope } of candidates) {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
        out.push({
            kind: 'context',
            name: `${scope}:${path.basename(file)}`,
            description: `Already-installed ${scope} persistent Claude Code context.`,
            source: 'installed',
            tags: ['context', 'claude-md', scope],
            availability: 'installed',
            packaging: 'standalone',
            execution: 'prompt',
            install: `導入済み (${file})`,
        });
    }
    return out;
}

// --- ソース: anthropics/skills 公式スキル集 ---
// 件数が少ない(20件弱)ため tree API で列挙し raw を並列取得(逐次だと件数×往復時間かかる)。
// リクエスト数が膨らむので大規模ソースにはこの方式を使わないこと
async function indexAnthropicSkills() {
    const tree = await fetchJson('https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1');
    const paths = (tree.tree || [])
        .map((t) => t.path)
        .filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p));
    const settled = await Promise.allSettled(paths.map(async (p) => {
        const fm = parseFrontmatter(await fetchText(`https://raw.githubusercontent.com/anthropics/skills/main/${p}`));
        const slug = p.split('/')[1];
        return {
            kind: 'skill',
            name: fm.name || slug,
            description: fm.description || '',
            source: 'anthropics/skills',
            tags: ['official'],
            availability: 'installable',
            packaging: 'standalone',
            execution: 'prompt',
            install: `https://github.com/anthropics/skills/tree/main/skills/${slug} を ~/.claude/skills/${slug}/ に保存`,
            fulltext: clipBody(fm.body),
        };
    }));
    const out = [];
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled') out.push(r.value);
        else errors.push(`anthropics-skills:${paths[i]}: ${r.reason && r.reason.message}`);
    });
    return out;
}

// --- ソース: VoltAgent/awesome-claude-code-subagents (100+ エージェント) ---
// 各 .md を個別フェッチすると100リクエスト超になるため README の一覧行から抽出する
async function indexVoltAgent() {
    const txt = await fetchText('https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/README.md');
    const out = [];
    const re = /^\s*[-*]\s*\[\*{0,2}([^\]*]+)\*{0,2}\]\(([^)]+\.md)\)\s*[-–—:]\s*(.+)$/gm;
    let m;
    while ((m = re.exec(txt)) !== null) {
        // m[2] は正規表現 [^)]+ で拾うため空白・バッククォート・$()等も一致し得る。
        // install: に埋め込む前に検証する(/code-review で発見・修正)
        const relPath = safeForInstallString(m[2], 'VoltAgent/awesome-claude-code-subagents');
        if (!relPath) continue;
        out.push({
            kind: 'agent',
            name: m[1].trim(),
            description: m[3].trim(),
            source: 'VoltAgent/awesome-claude-code-subagents',
            availability: 'copy-and-adapt',
            packaging: 'standalone',
            execution: 'isolated-agent',
            install: `https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/${relPath} を確認の上 ~/.claude/agents/ に保存`,
        });
    }
    return out;
}

// --- ソース: VoltAgent/awesome-agent-skills (ベンダー公式+コミュニティのスキルリスト) ---
// README の「- **[name](url)** - 説明」形式の行から抽出する(1リクエスト)
async function indexVoltAgentSkills() {
    const txt = await fetchText('https://raw.githubusercontent.com/VoltAgent/awesome-agent-skills/main/README.md');
    const out = [];
    const re = /^\s*-\s*\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*[-–—]\s*(.+)$/gm;
    let m;
    while ((m = re.exec(txt)) !== null) {
        // m[2] は正規表現 [^)]+ で拾う URL。install: に埋め込む前に検証する(/code-review で発見・修正)
        const url = safeForInstallString(m[2], 'VoltAgent/awesome-agent-skills');
        if (!url) continue;
        out.push({
            kind: 'skill',
            name: m[1].trim(),
            description: m[3].trim(),
            source: 'VoltAgent/awesome-agent-skills',
            availability: 'copy-and-adapt',
            packaging: 'standalone',
            execution: 'prompt',
            install: `${url} を確認の上、SKILL.md を ~/.claude/skills/<名前>/ に保存`,
        });
    }
    return out;
}

// --- ソース: aitmpl (davila7/claude-code-templates) コンポーネントカタログ ---
// components.json 1ファイル(約2MB)に 800+ のコミュニティスキルが説明付きで入っている
async function indexAitmplSkills() {
    const j = await fetchJson('https://raw.githubusercontent.com/davila7/claude-code-templates/main/docs/components.json');
    const out = [];
    for (const s of (j.skills || [])) {
        const skillPath = safeCatalogPath(s.path, 'aitmpl.com');
        if (!skillPath) continue;
        out.push({
            kind: 'skill',
            // name はカテゴリ間で重複があるため path (例: security/security-audit) を名前として使う
            name: skillPath,
            description: (s.description || '').slice(0, 300),
            source: 'aitmpl.com',
            // keywords はカタログ側が付けた検索語。タグに合流させ検索再現率を上げる
            tags: [s.category, ...(Array.isArray(s.keywords) ? s.keywords : [])].filter(Boolean).slice(0, 12),
            availability: 'installable',
            packaging: 'standalone',
            execution: 'prompt',
            install: `npx claude-code-templates@latest --skill=${skillPath} --yes`,
        });
    }
    return out;
}

// --- ソース: MCP 公式レジストリ (registry.modelcontextprotocol.io) ---
async function indexMcpRegistry() {
    // レジストリは同一サーバーのバージョン違いが古い順に並ぶため、name 後勝ち(=最新版)で潰す。
    // グローバル重複排除は「先勝ち」(優先度順)なので、この後勝ち要件はここでしか処理できない
    const byName = new Map();
    let cursor = null;
    // 60ページ(約6000件)で打ち切り。検索母集団として十分
    for (let page = 0; page < 60; page++) {
        const url = new URL('https://registry.modelcontextprotocol.io/v0/servers');
        url.searchParams.set('limit', '100');
        if (cursor) url.searchParams.set('cursor', cursor);
        const j = await fetchJson(url.toString());
        for (const row of j.servers || []) {
            const s = row.server || row;
            const meta = (row._meta || {})['io.modelcontextprotocol.registry/official'] || {};
            if (meta.status && meta.status !== 'active') continue;
            // 導入コマンドはトランスポート種別から組み立てる(remote 優先、なければ npm パッケージ)。
            // remote.url / パッケージIDは外部データなので install: に埋め込む前に検証し、
            // 不正な場合は安全な汎用文言にフォールバックする(/code-review で発見・修正)
            const remote = (s.remotes || [])[0];
            const pkg = (s.packages || [])[0];
            let install = 'レジストリ参照: https://registry.modelcontextprotocol.io';
            const remoteUrl = remote && safeForInstallString(remote.url, 'mcp-registry');
            const pkgId = pkg && safeForInstallString(pkg.identifier || pkg.name || '', 'mcp-registry');
            if (remoteUrl) {
                install = `claude mcp add --transport ${remote.type === 'sse' ? 'sse' : 'http'} <任意の名前> ${remoteUrl}`;
            } else if (pkgId) {
                install = `claude mcp add <任意の名前> -- npx -y ${pkgId}`;
            }
            byName.set(s.name, {
                kind: 'mcp',
                name: s.name,
                description: s.description || '',
                source: 'registry.modelcontextprotocol.io',
                availability: 'installable',
                packaging: 'standalone',
                execution: 'external-service',
                install,
            });
        }
        cursor = j.metadata && j.metadata.nextCursor;
        if (!cursor) break;
    }
    return [...byName.values()];
}

(async () => {
    // ソース一覧。配列の順序 = 重複排除(kind+name 先勝ち)の優先度そのもの:
    // builtin/installed → Anthropic公式 → 公式コミュニティ → オープンコミュニティ → レジストリ。
    // plugin は配布形式、hook/LSP/monitor/output-style/context は機能種別として並存する。
    const jobs = [
        ['builtin-and-context', indexBuiltinAndContext],
        ['installed-agents', indexInstalledAgents],
        ['installed-skills', indexInstalledSkills],
        ['anthropic-official-marketplace', indexOfficialMarketplace],
        ['anthropic-community-marketplace', indexOfficialCommunityPlugins],
        ['anthropic-knowledge-work-marketplace', indexKnowledgeWorkPlugins],
        ['anthropics-skills', indexAnthropicSkills],
        ['wshobson', indexWshobson],
        ['voltagent-agents', indexVoltAgent],
        ['voltagent-skills', indexVoltAgentSkills],
        ['aitmpl-skills', indexAitmplSkills],
        ['mcp-registry', indexMcpRegistry],
    ];
    // 各ソースは独立なので並列にクロールする(逐次=所要時間の合計、並列=最遅ソースの時間)。
    // 連結は jobs の定義順で行うため、完了順に関わらず優先度は保たれる。1つ失敗しても他は続行
    const settled = await Promise.allSettled(jobs.map(([, fn]) => Promise.resolve().then(fn)));
    const entries = [];
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled') entries.push(...r.value);
        else errors.push(`${jobs[i][0]}: ${(r.reason && r.reason.message) || r.reason}`);
    });

    // kind+name で重複排除(先勝ち = jobs の並び順が優先度になる)。照合は大小文字無視。
    const seen = new Set();
    const unique = entries.filter((e) => {
        const k = `${e.kind}:${e.name}`.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    }).map((e) => withCatalogMetadata({ ...e, id: `${e.kind}:${e.name}` }));
    // 軽量インストール(--no-fulltext): 本文語彙を落としてカタログを約半分にする
    if (cfg.fulltext === false) for (const e of unique) delete e.fulltext;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 書き込み中のクラッシュで catalog.jsonl が壊れないよう一時ファイル→rename する
    // (Codex版 c2 からの逆輸入。meta.json は小さく壊れても re-run で自己修復するため対象外)
    writeAtomic(CATALOG, unique.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // ベクトル構築(--vectors <provider>): 名前+タグ+説明文を埋め込む。
    // 本文全文は埋め込まない(ルーティング用途では説明文で十分、コストも1/10以下)
    let vectors = false;
    const prov = resolveProvider(cfg);
    if (prov && prov.missingKey) {
        errors.push(`vectors: 環境変数 ${prov.missingKey} が未設定のため埋め込みをスキップ(語彙検索のみで動作)`);
    } else if (prov) {
        try {
            const texts = unique.map((e) => `${e.name}. ${(e.tags || []).join(' ')}. ${e.domain || ''} ${e.availability || ''} ${e.packaging || ''} ${e.execution || ''}. ${e.description}`.slice(0, 1500));
            const vecs = await embedTexts(texts, prov);
            writeVectors(vecs, { provider: prov.name, model: prov.model, builtAt: new Date().toISOString() });
            vectors = true;
        } catch (e) { errors.push(`vectors: ${e.message}`); }
    }

    const counts = {};
    for (const e of unique) counts[e.kind] = (counts[e.kind] || 0) + 1;
    const meta = { schemaVersion: CATALOG_SCHEMA_VERSION, builtAt: new Date().toISOString(), total: unique.length, counts, fulltext: cfg.fulltext !== false, vectors, errors };
    writeAtomic(META, JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2));
})();
