#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// ccc: ローカルカタログ検索(RAG の Retrieval 部分)
// 埋め込み API を使わず IDF 加重キーワードマッチで代替する。
// カタログの説明文は短文なので、これで実用上十分な精度が出る(コストゼロが優先)。
//
// トークン節約のための2段構成:
//   1段目 --all : 全種別を1回で検索し、タブ区切りの軽量一覧を返す(往復1回・installは返さない)
//   2段目 --get : 採用候補に絞って完全な情報(install等)を JSON で返す
// 旧 --kind 単発モードは 2026-07-22 の /simplify で削除(リポジトリ内に呼び出し元がなく、
// 位置引数パースと第3の出力形式を維持するだけのコストになっていたため)。
//
// 使い方:
//   node search.mjs --all "<英語キーワード>" [--task "<タスク原文>"]
//   node search.mjs --get "<name1,name2,...>"
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOG, META, loadConfig, resolveProvider, embedTexts, readVectors } from './embed.mjs';

const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-index.mjs');

const args = process.argv.slice(2);
function opt(name) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
const allQuery = opt('all');
// --task: ユーザーのタスク原文(日本語可)。呼び出しモデルのキーワード生成品質に
// 依存しないよう、原文からも機械的に語彙を取り(ASCII技術語)、ベクトル検索の
// クエリには原文を優先して使う(埋め込みは多言語対応のため)。
// モデル差(haiku/fable等)で提示候補が揺れる問題への対策
const taskText = opt('task');
const getNames = opt('get');

if (!allQuery && !getNames) {
    console.error('使い方: --all "<keywords>" [--task "<原文>"] / --get "<names>"');
    process.exit(1);
}

// --- カタログの存在と鮮度 ---
// --get は鮮度不問(直前の --all が確認済みの前提)。存在だけを要求する。
// --all は、無ければ同期構築(初回のみ)、古いだけなら手元のカタログで即応答して
// 再構築はデタッチしたバックグラウンドへ(クエリを分単位でブロックしないため)
if (!fs.existsSync(CATALOG)) {
    if (getNames) {
        console.error('catalog.jsonl がありません。先に --all を実行してください。');
        process.exit(1);
    }
    console.error('catalog missing — building now (HTTP only, no LLM)...');
    execFileSync(process.execPath, [BUILD], { stdio: ['ignore', 'ignore', 'inherit'] });
} else if (allQuery && isStale()) {
    console.error('catalog stale — serving current copy, rebuilding in background');
    spawn(process.execPath, [BUILD], { detached: true, stdio: 'ignore' }).unref();
}
function isStale() {
    try {
        return Date.now() - Date.parse(JSON.parse(fs.readFileSync(META, 'utf8')).builtAt) > 7 * 24 * 60 * 60 * 1000;
    } catch { return true; }
}

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
// キーワード由来と原文由来を分けて持つ(検索には合成、トレースには内訳を出す)
const kwTokens = [...new Set(tokenize(allQuery))];
const taskTokens = [...new Set(tokenize(taskText || ''))].filter((t) => !kwTokens.includes(t));
const qTokens = [...kwTokens, ...taskTokens];
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
    // fulltext: SKILL.md やエージェント定義の本文(あるソースのみ)。
    // 説明文に現れない語彙(具体的なAPI名・ファイル形式等)での取りこぼしを防ぐ
    body: new Set(tokenize(d.fulltext || '')),
}));
for (const f of fields) {
    // 4フィールド合成の使い捨て Set を作らず、seen ガードで1文書1カウントにする
    const seen = new Set();
    for (const set of [f.name, f.desc, f.tags, f.body]) {
        for (const t of set) {
            if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) || 0) + 1); }
        }
    }
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
// 透明性トレース用: 実際に使われた検索モードを記録し --all の # 行で報告する
let searchMode = cfg.fulltext === false ? 'lexical(lite)' : 'lexical+fulltext';
const vec = (prov && !prov.missingKey) ? readVectors(docs.length) : null;
if (vec) {
    try {
        // 原文があればそれを埋め込む: 多言語埋め込みは日本語原文を直接理解するため、
        // モデルが生成したキーワードの良し悪しに検索品質が左右されない
        const [q] = await embedTexts([taskText || allQuery], prov);
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

// --- --all 出力: 種別ごとの上限を設けたタブ区切り軽量出力 ---
// install や score は返さない(候補選定に不要。詳細は --get で取る)
//
// 先頭の # 行 = 透明性トレース。提案の根拠(いつのカタログを・どのクエリで・
// 何件中何件見せているか)を機械出力し、呼び出し側 LLM はこれを転記するだけにする。
// LLM の自己申告に頼らないことが透明性の担保になる

// 既知種別の表示上限。カタログ側に新しい kind が増えても自動で表示対象になる(既定5件)
const CAPS = { agent: 5, plugin: 5, skill: 6, mcp: 5 };
const byKind = new Map();
for (const r of scored) {
    if (!byKind.has(r.d.kind)) byKind.set(r.d.kind, []);
    byKind.get(r.d.kind).push(r.d);
}
// 表示順: 既知種別の固定順 → データにだけ存在する新種別
const kinds = [...new Set([...Object.keys(CAPS), ...byKind.keys()])];

let builtAt = '不明';
let totalStr = '';
try {
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    builtAt = meta.builtAt;
    totalStr = ` ${meta.total}件(` + Object.entries(meta.counts).map(([k, v]) => `${k} ${v}`).join(' / ') + ')';
} catch { /* meta 欠損でも検索自体は続行 */ }
console.log(`# catalog: ${builtAt} 構築,${totalStr}`);
console.log(`# mode: ${searchMode}`);
console.log(`# query: keywords[${kwTokens.join(' ')}]` + (taskTokens.length ? ` + 原文由来[${taskTokens.join(' ')}]` : ' (原文由来の追加トークンなし)'));
console.log(`# hits: ${kinds.map((k) => `${k} ${(byKind.get(k) || []).length}`).join(' / ')} → 表示 ${kinds.map((k) => `${k} ${Math.min(CAPS[k] ?? 5, (byKind.get(k) || []).length)}`).join(' / ')}`);
console.log('kind\tname\tsource\tdescription');
for (const kind of kinds) {
    for (const d of (byKind.get(kind) || []).slice(0, CAPS[kind] ?? 5)) {
        const desc = (d.description || '').replace(/[\t\n]/g, ' ').slice(0, 90);
        console.log(`${d.kind}\t${d.name}\t${d.source}\t${desc}`);
    }
}
