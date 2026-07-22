#!/usr/bin/env node
// ccc: ローカルカタログ検索(RAG の Retrieval 部分)
// 埋め込み API を使わず IDF 加重キーワードマッチで代替する。
// カタログの説明文は短文なので、これで実用上十分な精度が出る(コストゼロが優先)。
//
// トークン節約のための2段構成 (2026-07-22 改修):
//   1段目 --all : 全種別を1回で検索し、タブ区切りの軽量一覧を返す(往復1回・installは返さない)
//   2段目 --get : 採用候補に絞って完全な情報(install等)を JSON で返す
// 旧 --kind 単発モードも互換のため残す。
//
// 使い方:
//   node search.mjs --all "<英語キーワード>"            # agent/plugin/skill/mcp 横断・軽量出力
//   node search.mjs --get "<name1,name2,...>"           # 名前完全一致で詳細取得
//   node search.mjs "<キーワード>" --kind skill --top 8  # 旧: 単一種別 JSON 出力
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveProvider, embedTexts, readVectors } from './embed.mjs';

const DATA_DIR = path.join(os.homedir(), '.claude', 'ccc');
const CATALOG = path.join(DATA_DIR, 'catalog.jsonl');
const META = path.join(DATA_DIR, 'meta.json');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// --- 鮮度確認と自動再構築を検索に内蔵する(LLM往復を1回分削減するため) ---
function ensureFreshCatalog() {
    let stale = true;
    try {
        const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
        // 7日以内なら再構築しない(クロールは HTTP のみだが数十秒かかるため)
        stale = (Date.now() - Date.parse(meta.builtAt)) > 7 * 24 * 60 * 60 * 1000;
    } catch { /* meta 無し・破損 → 再構築 */ }
    if (!stale && fs.existsSync(CATALOG)) return;
    console.error('catalog is stale or missing — rebuilding (HTTP only, no LLM)...');
    execFileSync(process.execPath, [path.join(SCRIPT_DIR, 'build-index.mjs')], { stdio: ['ignore', 'ignore', 'inherit'] });
}

const args = process.argv.slice(2);
function opt(name) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const allQuery = opt('all');
// --task: ユーザーのタスク原文(日本語可)。呼び出しモデルのキーワード生成品質に
// 依存しないよう、原文からも機械的に語彙を取り(ASCII技術語)、ベクトル検索の
// クエリには原文を優先して使う(埋め込みは多言語対応のため)。
// モデル差(haiku/fable等)で提示候補が揺れる問題への対策(2026-07-22)
const taskText = opt('task');
const getNames = opt('get');
const kindFilter = opt('kind');
const top = parseInt(opt('top') || '10', 10);
const legacyQuery = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));

ensureFreshCatalog();
const docs = fs.readFileSync(CATALOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// --- --get: 名前完全一致で詳細を返す(採用候補のみに使う想定) ---
if (getNames) {
    const wanted = new Set(getNames.split(',').map((s) => s.trim().toLowerCase()));
    for (const d of docs) {
        // fulltext は検索語彙専用。出力するとトークン節約が台無しになるため必ず落とす
        if (wanted.has(String(d.name).toLowerCase())) {
            const { fulltext, ...rest } = d;
            console.log(JSON.stringify(rest));
        }
    }
    process.exit(0);
}

const tokenize = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) || []);
const query = [allQuery || legacyQuery, taskText].filter(Boolean).join(' ');
const qTokens = [...new Set(tokenize(query))];
if (qTokens.length === 0) {
    console.error('使い方: --all "<keywords>" [--task "<原文>"] / --get "<names>" / "<keywords>" --kind <k>');
    process.exit(1);
}

// IDF: ありふれた語(code, ai など)の寄与を下げ、固有語(stripe, pdf など)を重くする
const df = new Map();
const fields = docs.map((d) => ({
    name: new Set(tokenize(d.name)),
    desc: new Set(tokenize(d.description)),
    tags: new Set(tokenize((d.tags || []).join(' '))),
    // fulltext: SKILL.md やエージェント定義の本文(あるソースのみ)。
    // 説明文に現れない語彙(具体的なAPI名・ファイル形式等)での取りこぼしを防ぐ
    body: new Set(tokenize(d.fulltext || '')),
}));
for (const f of fields) {
    for (const t of new Set([...f.name, ...f.desc, ...f.tags, ...f.body])) df.set(t, (df.get(t) || 0) + 1);
}
const N = docs.length;
const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));

// フィールド重み: 名前ヒット > タグ > 説明文 > 本文。tf は短文なので 0/1 で扱う
let scored = docs.map((d, i) => {
    let score = 0;
    for (const t of qTokens) {
        if (fields[i].name.has(t)) score += 3 * idf(t);
        else if (fields[i].tags.has(t)) score += 2 * idf(t);
        else if (fields[i].desc.has(t)) score += idf(t);
        else if (fields[i].body.has(t)) score += 0.5 * idf(t);
    }
    return { score, d };
}).filter((r) => r.score > 0);
scored.sort((a, b) => b.score - a.score);

// --- ベクトル検索が有効(--vectors インストール + キー設定 + vectors.bin あり)なら RRF で融合 ---
// 語彙検索で0点の候補もベクトル側から拾えるようになる(同義語・言い換え対策)。
// 失敗時は警告して語彙検索のみで続行(検索が API 障害で死なないこと優先)
const cfg = loadConfig();
const prov = resolveProvider(cfg);
const vec = (prov && !prov.missingKey) ? readVectors() : null;
// 透明性トレース用: 実際に使われた検索モードを記録し --all の # 行で報告する
let searchMode = cfg.fulltext === false ? 'lexical(lite)' : 'lexical+fulltext';
if (vec && vec.meta.count === docs.length && vec.meta.dims > 0) {
    try {
        // 原文があればそれを埋め込む: 多言語埋め込みは日本語原文を直接理解するため、
        // モデルが生成したキーワードの良し悪しに検索品質が左右されない
        const [q] = await embedTexts([taskText || query], prov);
        const { dims } = vec.meta;
        const sims = new Array(docs.length);
        for (let i = 0; i < docs.length; i++) {
            let s = 0;
            const off = i * dims;
            for (let k = 0; k < dims; k++) s += vec.arr[off + k] * q[k];
            sims[i] = { i, s };
        }
        sims.sort((a, b) => b.s - a.s);
        // RRF: score = Σ 1/(60+順位)。60 は RRF の標準定数
        const fused = new Map();
        scored.slice(0, 100).forEach((r, idx) => fused.set(r.d, 1 / (60 + idx)));
        sims.slice(0, 100).forEach(({ i }, idx) => {
            fused.set(docs[i], (fused.get(docs[i]) || 0) + 1 / (60 + idx));
        });
        scored = [...fused.entries()].map(([d, score]) => ({ score, d }));
        scored.sort((a, b) => b.score - a.score);
        searchMode += ` + vector RRF(${vec.meta.provider}/${vec.meta.model})`;
    } catch (e) { console.error(`vector search failed, lexical only: ${e.message}`); }
}

if (allQuery) {
    // --all: 種別ごとの上限を設けたタブ区切り軽量出力。
    // install や score は返さない(候補選定に不要。詳細は --get で取る)
    //
    // 先頭の # 行 = 透明性トレース。提案の根拠(いつのカタログを・どのクエリで・
    // 何件中何件見せているか)を機械出力し、呼び出し側 LLM はこれを転記するだけにする。
    // LLM の自己申告に頼らないことが透明性の担保になる(2026-07-22)
    let builtAt = '不明';
    let totalStr = '';
    try {
        const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
        builtAt = meta.builtAt;
        totalStr = ` ${meta.total}件(` + Object.entries(meta.counts).map(([k, v]) => `${k} ${v}`).join(' / ') + ')';
    } catch { /* meta 欠損でも検索自体は続行 */ }
    const kwTokens = [...new Set(tokenize(allQuery))];
    const taskTokens = [...new Set(tokenize(taskText || ''))].filter((t) => !kwTokens.includes(t));
    const CAPS = { agent: 5, plugin: 5, skill: 6, mcp: 5 };
    const hits = {};
    for (const k of Object.keys(CAPS)) hits[k] = scored.filter((r) => r.d.kind === k).length;
    console.log(`# catalog: ${builtAt} 構築,${totalStr}`);
    console.log(`# mode: ${searchMode}`);
    console.log(`# query: keywords[${kwTokens.join(' ')}]` + (taskTokens.length ? ` + 原文由来[${taskTokens.join(' ')}]` : ' (原文由来の追加トークンなし)'));
    console.log(`# hits: ${Object.entries(hits).map(([k, v]) => `${k} ${v}`).join(' / ')} → 表示 ${Object.entries(CAPS).map(([k, v]) => `${k} ${Math.min(v, hits[k])}`).join(' / ')}`);
    console.log('kind\tname\tsource\tdescription');
    for (const kind of Object.keys(CAPS)) {
        for (const { d } of scored.filter((r) => r.d.kind === kind).slice(0, CAPS[kind])) {
            const desc = (d.description || '').replace(/[\t\n]/g, ' ').slice(0, 90);
            console.log(`${d.kind}\t${d.name}\t${d.source}\t${desc}`);
        }
    }
    process.exit(0);
}

// 旧単一種別モード(互換)
for (const { score, d } of scored.filter((r) => !kindFilter || r.d.kind === kindFilter).slice(0, top)) {
    console.log(JSON.stringify({
        score: Math.round(score * 100) / 100,
        kind: d.kind,
        name: d.name,
        source: d.source,
        install: d.install,
        description: (d.description || '').slice(0, 160),
    }));
}
