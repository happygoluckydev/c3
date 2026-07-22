#!/usr/bin/env node
// ccc: カタログ構築バッチ
// 目的: プラグイン/エージェント/スキル/MCP の情報を一括クロールして catalog.jsonl に保存する。
// クレジット消費を抑えるため LLM は使わない(HTTP 取得のみ)。週1回程度の実行を想定。
// 実行: node build-index.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR, CATALOG, META, parseFrontmatter, loadConfig, resolveProvider, embedTexts, writeVectors } from './embed.mjs';

// インストール時オプション(install.sh --no-fulltext / --vectors <provider>)は config.json 経由で効く
const cfg = loadConfig();
const errors = [];

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
    return (j.plugins || []).map((p) => ({
        kind: 'plugin',
        name: p.name,
        description: p.description || '',
        source: 'wshobson/agents',
        tags: [p.category].filter(Boolean),
        install: `/plugin marketplace add wshobson/agents してから /plugin install ${p.name}@claude-code-workflows`,
    }));
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
        out.push({
            kind: 'agent',
            name: m[1].trim(),
            description: m[3].trim(),
            source: 'VoltAgent/awesome-claude-code-subagents',
            install: `https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/${m[2]} を確認の上 ~/.claude/agents/ に保存`,
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
        out.push({
            kind: 'skill',
            name: m[1].trim(),
            description: m[3].trim(),
            source: 'VoltAgent/awesome-agent-skills',
            install: `${m[2]} を確認の上、SKILL.md を ~/.claude/skills/<名前>/ に保存`,
        });
    }
    return out;
}

// --- ソース: aitmpl (davila7/claude-code-templates) コンポーネントカタログ ---
// components.json 1ファイル(約2MB)に 800+ のコミュニティスキルが説明付きで入っている
async function indexAitmplSkills() {
    const j = await fetchJson('https://raw.githubusercontent.com/davila7/claude-code-templates/main/docs/components.json');
    return (j.skills || []).filter((s) => s.path).map((s) => ({
        kind: 'skill',
        // name はカテゴリ間で重複があるため path (例: security/security-audit) を名前として使う
        name: s.path,
        description: (s.description || '').slice(0, 300),
        source: 'aitmpl.com',
        // keywords はカタログ側が付けた検索語。タグに合流させ検索再現率を上げる
        tags: [s.category, ...(Array.isArray(s.keywords) ? s.keywords : [])].filter(Boolean).slice(0, 12),
        install: `npx claude-code-templates@latest --skill="${s.path}" --yes`,
    }));
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
            // 導入コマンドはトランスポート種別から組み立てる(remote 優先、なければ npm パッケージ)
            const remote = (s.remotes || [])[0];
            const pkg = (s.packages || [])[0];
            let install = 'レジストリ参照: https://registry.modelcontextprotocol.io';
            if (remote) {
                install = `claude mcp add --transport ${remote.type === 'sse' ? 'sse' : 'http'} <任意の名前> ${remote.url}`;
            } else if (pkg) {
                const id = pkg.identifier || pkg.name || '';
                if (id) install = `claude mcp add <任意の名前> -- npx -y ${id}`;
            }
            byName.set(s.name, {
                kind: 'mcp',
                name: s.name,
                description: s.description || '',
                source: 'registry.modelcontextprotocol.io',
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
    // installed → 公式 → コミュニティ → レジストリ。ソース追加時は優先度に合う位置へ挿入する
    const jobs = [
        ['installed-agents', indexInstalledAgents],
        ['installed-skills', indexInstalledSkills],
        ['wshobson', indexWshobson],
        ['anthropics-skills', indexAnthropicSkills],
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

    // kind+name で重複排除(先勝ち = jobs の並び順が優先度になる)
    const seen = new Set();
    const unique = entries.filter((e) => {
        const k = `${e.kind}:${e.name}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    // 軽量インストール(--no-fulltext): 本文語彙を落としてカタログを約半分にする
    if (cfg.fulltext === false) for (const e of unique) delete e.fulltext;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CATALOG, unique.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // ベクトル構築(--vectors <provider>): 名前+タグ+説明文を埋め込む。
    // 本文全文は埋め込まない(ルーティング用途では説明文で十分、コストも1/10以下)
    let vectors = false;
    const prov = resolveProvider(cfg);
    if (prov && prov.missingKey) {
        errors.push(`vectors: 環境変数 ${prov.missingKey} が未設定のため埋め込みをスキップ(語彙検索のみで動作)`);
    } else if (prov) {
        try {
            const texts = unique.map((e) => `${e.name}. ${(e.tags || []).join(' ')}. ${e.description}`.slice(0, 1500));
            const vecs = await embedTexts(texts, prov);
            writeVectors(vecs, { provider: prov.name, model: prov.model, builtAt: new Date().toISOString() });
            vectors = true;
        } catch (e) { errors.push(`vectors: ${e.message}`); }
    }

    const counts = {};
    for (const e of unique) counts[e.kind] = (counts[e.kind] || 0) + 1;
    const meta = { builtAt: new Date().toISOString(), total: unique.length, counts, fulltext: cfg.fulltext !== false, vectors, errors };
    fs.writeFileSync(META, JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2));
})();
