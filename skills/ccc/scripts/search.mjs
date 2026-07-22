#!/usr/bin/env node
// ccc: ローカルカタログ検索(RAG の Retrieval 部分)
// 埋め込み API を使わず IDF 加重キーワードマッチで代替する。
// カタログの説明文は短文なので、これで実用上十分な精度が出る(コストゼロが優先)。
// 使い方: node search.mjs "<英語キーワード スペース区切り>" [--kind agent|plugin|mcp] [--top 10]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const query = args.filter((a) => !a.startsWith('--'))[0] || '';
function opt(name, dflt) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const kindFilter = opt('kind', null);
const top = parseInt(opt('top', '10'), 10);

const CATALOG = path.join(os.homedir(), '.claude', 'ccc', 'catalog.jsonl');
if (!fs.existsSync(CATALOG)) {
    console.error('catalog.jsonl がありません。先に build-index.mjs を実行してください。');
    process.exit(1);
}
const docs = fs.readFileSync(CATALOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const tokenize = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) || []);
const qTokens = [...new Set(tokenize(query))];
if (qTokens.length === 0) {
    console.error('検索キーワード(英語)を指定してください');
    process.exit(1);
}

// IDF: ありふれた語(code, ai など)の寄与を下げ、固有語(stripe, pdf など)を重くする
const df = new Map();
const fields = docs.map((d) => ({
    name: new Set(tokenize(d.name)),
    desc: new Set(tokenize(d.description)),
    tags: new Set(tokenize((d.tags || []).join(' '))),
}));
for (const f of fields) {
    for (const t of new Set([...f.name, ...f.desc, ...f.tags])) df.set(t, (df.get(t) || 0) + 1);
}
const N = docs.length;
const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));

// フィールド重み: 名前ヒット > タグ > 説明文。tf は短文なので 0/1 で扱う
const results = docs.map((d, i) => {
    let score = 0;
    for (const t of qTokens) {
        if (fields[i].name.has(t)) score += 3 * idf(t);
        else if (fields[i].tags.has(t)) score += 2 * idf(t);
        else if (fields[i].desc.has(t)) score += idf(t);
    }
    return { score: Math.round(score * 100) / 100, d };
})
    .filter((r) => r.score > 0 && (!kindFilter || r.d.kind === kindFilter))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

for (const { score, d } of results) {
    console.log(JSON.stringify({
        score,
        kind: d.kind,
        name: d.name,
        source: d.source,
        install: d.install,
        description: (d.description || '').slice(0, 160),
    }));
}
