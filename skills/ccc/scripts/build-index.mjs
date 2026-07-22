#!/usr/bin/env node
// ccc: カタログ構築バッチ
// 目的: プラグイン/エージェント/MCP の情報を一括クロールして catalog.jsonl に保存する。
// クレジット消費を抑えるため LLM・埋め込み API は使わない(HTTP 取得のみ)。週1回程度の実行を想定。
// 実行: node build-index.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT_DIR = path.join(os.homedir(), '.claude', 'ccc');
const entries = [];
const errors = [];

async function fetchJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'ccc' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
}
async function fetchText(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'ccc' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.text();
}

// YAML フロントマターから name/description だけを抜く簡易パーサ。
// 依存ライブラリを増やさないため本格的な YAML パースはしない(この2キーで十分)。
function parseFrontmatter(txt) {
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const out = {};
    if (!m) return out;
    for (const line of m[1].split(/\r?\n/)) {
        const mm = line.match(/^(name|description)\s*:\s*(.*)$/);
        if (mm) out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
}

// --- ソース1: 導入済みユーザーエージェント (~/.claude/agents) ---
// 「既に持っているもの」を最優先で提案するために必ずカタログに含める
function indexInstalledAgents() {
    const dir = path.join(os.homedir(), '.claude', 'agents');
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try {
            const fm = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
            entries.push({
                kind: 'agent',
                name: fm.name || f.replace(/\.md$/, ''),
                description: fm.description || '',
                source: 'installed',
                install: '導入済み (~/.claude/agents)',
            });
        } catch (e) { errors.push(`installed:${f}: ${e.message}`); }
    }
}

// --- ソース1b: 導入済みユーザースキル (~/.claude/skills/*/SKILL.md) ---
// エージェント同様「既に持っているもの」の再利用を最優先で提案するため必ず含める
function indexInstalledSkills() {
    const dir = path.join(os.homedir(), '.claude', 'skills');
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir)) {
        const skillMd = path.join(dir, d, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        try {
            const fm = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
            entries.push({
                kind: 'skill',
                name: fm.name || d,
                description: fm.description || '',
                source: 'installed',
                install: '導入済み (~/.claude/skills)',
            });
        } catch (e) { errors.push(`installed-skill:${d}: ${e.message}`); }
    }
}

// --- ソース1c: anthropics/skills 公式スキル集 ---
// 件数が少ない(20件弱)ため tree API で SKILL.md を列挙し raw で frontmatter を個別取得する。
// この方式は件数が増えるとリクエスト数が膨らむので、大規模ソースには使わないこと。
async function indexAnthropicSkills() {
    const tree = await fetchJson('https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1');
    const paths = (tree.tree || [])
        .map((t) => t.path)
        .filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p));
    for (const p of paths) {
        try {
            const txt = await fetchText(`https://raw.githubusercontent.com/anthropics/skills/main/${p}`);
            const fm = parseFrontmatter(txt);
            const slug = p.split('/')[1];
            entries.push({
                kind: 'skill',
                name: fm.name || slug,
                description: fm.description || '',
                source: 'anthropics/skills',
                tags: ['official'],
                install: `https://github.com/anthropics/skills/tree/main/skills/${slug} を ~/.claude/skills/${slug}/ に保存`,
            });
        } catch (e) { errors.push(`anthropics-skills:${p}: ${e.message}`); }
    }
}

// --- ソース1d: VoltAgent/awesome-agent-skills (ベンダー公式+コミュニティのスキルリスト) ---
// README の「- **[name](url)** - 説明」形式の行から抽出する(1リクエスト)。
// Microsoft 等ベンダー公式チーム製とコミュニティ製が混在するため tags で区別しない(URL で判断可能)
async function indexVoltAgentSkills() {
    const txt = await fetchText('https://raw.githubusercontent.com/VoltAgent/awesome-agent-skills/main/README.md');
    const re = /^\s*-\s*\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*[-–—]\s*(.+)$/gm;
    let m;
    while ((m = re.exec(txt)) !== null) {
        entries.push({
            kind: 'skill',
            name: m[1].trim(),
            description: m[3].trim(),
            source: 'VoltAgent/awesome-agent-skills',
            install: `${m[2]} を確認の上、SKILL.md を ~/.claude/skills/<名前>/ に保存`,
        });
    }
}

// --- ソース1e: aitmpl (davila7/claude-code-templates) コンポーネントカタログ ---
// components.json 1ファイル(約2MB)に 800+ のコミュニティスキルが説明付きで入っている。
// name はカテゴリ重複があるため path (例: security/security-audit) を名前として使う
async function indexAitmplSkills() {
    const j = await fetchJson('https://raw.githubusercontent.com/davila7/claude-code-templates/main/docs/components.json');
    for (const s of j.skills || []) {
        if (!s.path) continue;
        entries.push({
            kind: 'skill',
            name: s.path,
            description: (s.description || '').slice(0, 300),
            source: 'aitmpl.com',
            tags: [s.category].filter(Boolean),
            install: `npx claude-code-templates@latest --skill="${s.path}" --yes`,
        });
    }
}

// --- ソース2: wshobson/agents 公式マーケットプレイス (94 プラグイン) ---
// marketplace.json 1ファイルで全プラグインの説明が取れるので低コスト
async function indexWshobson() {
    const j = await fetchJson('https://raw.githubusercontent.com/wshobson/agents/main/.claude-plugin/marketplace.json');
    for (const p of j.plugins || []) {
        entries.push({
            kind: 'plugin',
            name: p.name,
            description: p.description || '',
            source: 'wshobson/agents',
            tags: [p.category].filter(Boolean),
            install: `/plugin marketplace add wshobson/agents してから /plugin install ${p.name}@claude-code-workflows`,
        });
    }
}

// --- ソース3: VoltAgent/awesome-claude-code-subagents (100+ エージェント) ---
// 各 .md を個別フェッチすると100リクエスト超になるため README の一覧行から抽出する
async function indexVoltAgent() {
    const txt = await fetchText('https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/README.md');
    const re = /^\s*[-*]\s*\[\*{0,2}([^\]*]+)\*{0,2}\]\(([^)]+\.md)\)\s*[-–—:]\s*(.+)$/gm;
    let m;
    while ((m = re.exec(txt)) !== null) {
        entries.push({
            kind: 'agent',
            name: m[1].trim(),
            description: m[3].trim(),
            source: 'VoltAgent/awesome-claude-code-subagents',
            install: `https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/${m[2]} を確認の上 ~/.claude/agents/ に保存`,
        });
    }
}

// --- ソース4: MCP 公式レジストリ (registry.modelcontextprotocol.io) ---
async function indexMcpRegistry() {
    // 同一サーバーのバージョン違いが並ぶため name で後勝ち上書きして重複排除する
    const byName = new Map();
    let cursor = null;
    // 60ページ(約6000件)で打ち切り。レジストリ全量が必要なわけではなく検索母集団として十分
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
                const transport = remote.type === 'sse' ? 'sse' : 'http';
                install = `claude mcp add --transport ${transport} <任意の名前> ${remote.url}`;
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
    for (const v of byName.values()) entries.push(v);
}

(async () => {
    indexInstalledAgents();
    indexInstalledSkills();
    // リモートソースは1つ失敗しても他を続行する(ネットワーク・スキーマ変更に耐える)
    const jobs = [
        ['wshobson', indexWshobson],
        ['voltagent', indexVoltAgent],
        ['anthropics-skills', indexAnthropicSkills],
        // 非公式スキルは公式より後に登録する(kind+name 重複時は先勝ちで公式が残る)
        ['voltagent-skills', indexVoltAgentSkills],
        ['aitmpl-skills', indexAitmplSkills],
        ['mcp-registry', indexMcpRegistry],
    ];
    for (const [label, fn] of jobs) {
        try { await fn(); } catch (e) { errors.push(`${label}: ${e.message}`); }
    }
    // kind+name で最終重複排除(先勝ち = installed が最優先で残る)
    const seen = new Set();
    const unique = entries.filter((e) => {
        const k = `${e.kind}:${e.name}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'catalog.jsonl'), unique.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const counts = {};
    for (const e of unique) counts[e.kind] = (counts[e.kind] || 0) + 1;
    const meta = { builtAt: new Date().toISOString(), total: unique.length, counts, errors };
    fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2));
})();
