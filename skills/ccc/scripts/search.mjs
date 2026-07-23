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
//   node search.mjs --get "<kind:name1,kind:name2,...>"
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOG, META, CATALOG_SCHEMA_VERSION, loadConfig, resolveProvider, embedTexts, readVectors, readJsonSafe, withCatalogMetadata } from './embed.mjs';

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
    console.error('使い方: --all "<keywords>" [--task "<原文>"] / --get "<kind:name,...>"');
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
    const meta = readJsonSafe(META);
    if (!meta) return true;
    if (meta.schemaVersion !== CATALOG_SCHEMA_VERSION) return true;
    return Date.now() - Date.parse(meta.builtAt) > 7 * 24 * 60 * 60 * 1000;
}

const docs = fs.readFileSync(CATALOG, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [withCatalogMetadata(JSON.parse(l))]; } catch { return []; }
});

// --- --get: 一意な id で詳細を返す(採用候補のみに使う想定) ---
// 旧カタログのために名前指定も維持するが、同名の異なる kind がある場合は曖昧な名前を
// 勝手に展開せず、--all が返す kind:name 形式の id を使うよう明示する。
if (getNames) {
    const requested = [...new Set(getNames.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
    const recordId = (d) => String(d.id || `${d.kind}:${d.name}`).toLowerCase();
    const byId = new Map(docs.map((d) => [recordId(d), d]));
    const byName = new Map();
    for (const d of docs) {
        const name = String(d.name).toLowerCase();
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(d);
    }
    const selected = new Set();
    for (const value of requested) {
        if (byId.has(value)) {
            selected.add(byId.get(value));
            continue;
        }
        const matches = byName.get(value) || [];
        if (matches.length === 1) selected.add(matches[0]);
        else if (matches.length > 1) console.error(`曖昧な名前 ${value}: ${matches.map(recordId).join(', ')}。--get には id を指定してください。`);
    }
    for (const d of docs) {
        // fulltext は検索語彙専用。出力するとトークン節約が台無しになるため必ず落とす
        if (selected.has(d)) {
            const { fulltext, ...rest } = d;
            console.log(JSON.stringify(rest));
        }
    }
    process.exit(0);
}

// ありふれた英単語を除外して IDF/matches のノイズを減らす。文字種も +.#/- まで許容し、
// "c++" "asp.net" "ci/cd" のような固有表記がトークン化で壊れないようにする
// (Codex版 c2 からの逆輸入)。
// 注意点2つ(/code-review で発見・修正):
//  - 単語長フィルタ(旧: length > 1)は "r" のような1文字の正当なキーワードまで
//    落としてしまうため廃止。ノイズ除去は STOP_WORDS のみに任せる。
//  - 文字種を広げた副作用で文末の句点が単語に融着する("Stripe." など)。
//    クエリ側は句点無しで来ることが多く、同じ語が文書側とクエリ側で別トークンになり
//    再現率が落ちるため、末尾のピリオドだけ剥がす(先頭は正規表現で英数字確定なので空文字列化しない)。
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with']);
const tokenize = (s) => (String(s).toLowerCase().match(/[a-z0-9][a-z0-9+.#/-]*/g) || [])
    .map((t) => t.replace(/\.+$/, ''))
    .filter((t) => !STOP_WORDS.has(t));
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
    // availability/packaging と execution などは tags と別の分類軸。
    // 新しい機能種別を名前に依存せず検索できるよう、同じ重みの facet として索引化する。
    // unknown は検索ノイズになるので索引から外す。
    facets: new Set(tokenize([d.domain, d.availability, d.packaging, d.execution]
        .filter((value) => value && value !== 'unknown').join(' '))),
    // fulltext: SKILL.md やエージェント定義の本文(あるソースのみ)。
    // 説明文に現れない語彙(具体的なAPI名・ファイル形式等)での取りこぼしを防ぐ
    body: new Set(tokenize(d.fulltext || '')),
}));
for (const f of fields) {
    // 4フィールド合成の使い捨て Set を作らず、seen ガードで1文書1カウントにする
    const seen = new Set();
    for (const set of [f.name, f.desc, f.tags, f.facets, f.body]) {
        for (const t of set) {
            if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) || 0) + 1); }
        }
    }
}
const N = docs.length;
const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));

// フィールド重み: 名前ヒット > タグ > 説明文 > 本文。tf は短文なので 0/1 で扱う。
// matches: どのトークンがどのフィールドで当たったかを記録し、出力の matched_fields 列で
// 見せる(スコアを鵜呑みにせず根拠を追えるようにする透明性策。Codex版 c2 からの逆輸入)
let scored = docs.map((d, i) => {
    let score = 0;
    const matches = [];
    for (const t of qTokens) {
        if (fields[i].name.has(t)) { score += 3 * idf(t); matches.push(`${t}:name`); }
        else if (fields[i].tags.has(t)) { score += 2 * idf(t); matches.push(`${t}:tag`); }
        else if (fields[i].facets.has(t)) { score += 2 * idf(t); matches.push(`${t}:facet`); }
        else if (fields[i].desc.has(t)) { score += idf(t); matches.push(`${t}:description`); }
        else if (fields[i].body.has(t)) { score += 0.5 * idf(t); matches.push(`${t}:body`); }
    }
    return { score, d, matches };
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
        // 埋め込み次元がベクトルファイルと食い違う場合(プロバイダ/モデル変更後の再構築漏れ等)は
        // 無意味な内積を計算せず、ここで検出して lexical フォールバックに倒す
        // (Codex版 c2 からの逆輸入)
        if (q.length !== dims) throw new Error(`stored vectors have ${dims} dims but ${prov.name}/${prov.model} produced ${q.length}; rebuild the catalog`);
        const sims = new Array(docs.length);
        for (let i = 0; i < docs.length; i++) {
            let s = 0;
            const off = i * dims;
            for (let k = 0; k < dims; k++) s += vec.arr[off + k] * q[k];
            sims[i] = { i, s };
        }
        sims.sort((a, b) => b.s - a.s);
        // matches のルックアップは融合前の scored 全体(上位100件に絞る前)から作る。
        // fused の上位100件だけから作ると、語彙スコア101位以下だがベクトル側でも拾われた
        // 文書の matches が空に落ちてしまう(/code-review で発見・修正)。
        const matchesByDoc = new Map(scored.map((r) => [r.d, r.matches]));
        // RRF: score = Σ 1/(60+順位)。60 は RRF の標準定数。
        // fused はスコアのみを持つ Map<Doc, number> にとどめ、matches は上の matchesByDoc から
        // 融合後にまとめて引く(行オブジェクトを都度 spread してコピーする必要がない)
        const fused = new Map();
        scored.slice(0, 100).forEach((r, idx) => fused.set(r.d, 1 / (60 + idx)));
        sims.slice(0, 100).forEach(({ i }, idx) => {
            fused.set(docs[i], (fused.get(docs[i]) || 0) + 1 / (60 + idx));
        });
        scored = [...fused.entries()].map(([d, score]) => ({ score, d, matches: matchesByDoc.get(d) || [] }));
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
const CAPS = {
    builtin: 3,
    context: 4,
    plugin: 5,
    skill: 6,
    agent: 5,
    hook: 5,
    lsp: 5,
    monitor: 3,
    'output-style': 3,
    mcp: 5,
};
const byKind = new Map();
for (const r of scored) {
    if (!byKind.has(r.d.kind)) byKind.set(r.d.kind, []);
    byKind.get(r.d.kind).push(r);
}
// 表示順: 既知種別の固定順 → データにだけ存在する新種別
const kinds = [...new Set([...Object.keys(CAPS), ...byKind.keys()])];

let builtAt = '不明';
let totalStr = '';
const metaForTrace = readJsonSafe(META);
if (metaForTrace) {
    builtAt = metaForTrace.builtAt;
    totalStr = ` schema=${metaForTrace.schemaVersion || '?'} ${metaForTrace.total}件(` + Object.entries(metaForTrace.counts).map(([k, v]) => `${k} ${v}`).join(' / ') + ')';
}
console.log(`# catalog: ${builtAt} 構築,${totalStr}`);
console.log(`# mode: ${searchMode}`);
console.log(`# query: keywords[${kwTokens.join(' ')}]` + (taskTokens.length ? ` + 原文由来[${taskTokens.join(' ')}]` : ' (原文由来の追加トークンなし)'));
console.log(`# hits: ${kinds.map((k) => `${k} ${(byKind.get(k) || []).length}`).join(' / ')} → 表示 ${kinds.map((k) => `${k} ${Math.min(CAPS[k] ?? 5, (byKind.get(k) || []).length)}`).join(' / ')}`);
console.log('id\tkind\tname\tsource\tmatched_fields\tdescription');
for (const kind of kinds) {
    for (const r of (byKind.get(kind) || []).slice(0, CAPS[kind] ?? 5)) {
        const d = r.d;
        const desc = (d.description || '').replace(/[\t\n]/g, ' ').slice(0, 90);
        console.log(`${d.id || `${d.kind}:${d.name}`}\t${d.kind}\t${d.name}\t${d.source}\t${(r.matches || []).join(',')}\t${desc}`);
    }
}
