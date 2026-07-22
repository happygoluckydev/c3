// SPDX-License-Identifier: MIT
// ccc: 共有モジュール — パス定数・設定・フロントマターパーサ・埋め込みプロバイダ・ベクトルIO
// (元は埋め込み専用だったが、パス/パーサの三重定義が起きたため共有ライブラリに昇格。2026-07-22 /simplify)
// - API キーは環境変数からのみ読む。設定ファイル・カタログ・ログには絶対に書かない
// - ベクトルは L2 正規化して Float32Array バイナリで保存(JSON だと約4倍に膨らむため)
// - 依存ライブラリなし(REST 直叩き)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ~/.claude/ccc は1つのデータストア。パスの定義はここだけに置く(分散定義は split-brain の元)
export const DATA_DIR = path.join(os.homedir(), '.claude', 'ccc');
export const CATALOG = path.join(DATA_DIR, 'catalog.jsonl');
export const META = path.join(DATA_DIR, 'meta.json');
export const VEC_BIN = path.join(DATA_DIR, 'vectors.bin');
export const VEC_META = path.join(DATA_DIR, 'vectors.json');
const CONFIG = path.join(DATA_DIR, 'config.json');

// config.json が無い場合の既定値 = 従来挙動(本文索引あり・ベクトルなし)
const DEFAULTS = { fulltext: true, vectors: { provider: 'none' } };

// 書き込み→リネームにすることで、書き込み中のクラッシュで catalog.jsonl / vectors.* が
// 壊れた状態のまま次回の search.mjs に読まれることを防ぐ(Codex版 c2 からの逆輸入)
export function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

// YAML フロントマターの簡易パーサ(name/description のみ。依存を増やさないため本格パースはしない)。
// fmLen: フロントマター部の文字数(prune の常駐税推計用)。body: 本文(検索語彙用)。
// build-index と prune で別実装が育ち始めたため一本化した
export function parseFrontmatter(txt) {
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const out = { fmLen: m ? m[0].length : 0, body: m ? txt.slice(m[0].length).trim() : txt.trim() };
    if (!m) return out;
    for (const line of m[1].split(/\r?\n/)) {
        const mm = line.match(/^(name|description)\s*:\s*(.*)$/);
        if (mm) out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
}

// ファイルを読んで JSON.parse するだけの使い捨て try/catch が loadConfig 以外にも
// (readVectors, search.mjs の isStale/トレース用meta読込に)独立に生えていて、
// 「壊れている場合は警告する」という方針が loadConfig にしか適用されていなかったため
// 共有ヘルパーに一本化した(/code-review で発見・修正)。
// ファイル未作成(ENOENT)は通常運用として無警告。それ以外(壊れたJSON等)は黙って
// フォールバックし続けると気づきにくいので警告を出す。
export function readJsonSafe(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
        if (e.code !== 'ENOENT') console.error(`ccc: ${file} の内容が不正なため無視します: ${e.message}`);
        return null;
    }
}

export function loadConfig() {
    return { ...DEFAULTS, ...(readJsonSafe(CONFIG) || {}) };
}

// --- 埋め込みプロバイダ定義 ---
// プロバイダ追加はこのテーブルに1エントリ足すだけ(URL/リクエスト/レスポンス整形込み)。
// インストーラ側はプロバイダ名を検証しない(未知名は初回ビルド時に resolveProvider が明確に落とす)
// ため、ここが唯一の編集箇所になる
const openaiStyle = (url) => ({
    request: (chunk, p) => [url, { Authorization: `Bearer ${p.key}` }, { model: p.model, input: chunk }],
    extract: (j) => j.data.map((d) => d.embedding),
});
const PROVIDERS = {
    gemini: {
        keyEnv: 'GEMINI_API_KEY', model: 'text-embedding-004', batch: 100,
        request: (chunk, p) => [
            `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:batchEmbedContents?key=${p.key}`,
            {},
            { requests: chunk.map((t) => ({ model: `models/${p.model}`, content: { parts: [{ text: t }] } })) },
        ],
        extract: (j) => j.embeddings.map((e) => e.values),
    },
    voyage: { keyEnv: 'VOYAGE_API_KEY', model: 'voyage-3.5-lite', batch: 128, ...openaiStyle('https://api.voyageai.com/v1/embeddings') },
    openai: { keyEnv: 'OPENAI_API_KEY', model: 'text-embedding-3-small', batch: 256, ...openaiStyle('https://api.openai.com/v1/embeddings') },
};

// 戻り値: null(無効) / {missingKey}(キー未設定) / {name,key,model,batch,request,extract}(利用可)
export function resolveProvider(cfg) {
    const v = cfg.vectors || {};
    if (!v.provider || v.provider === 'none') return null;
    const p = PROVIDERS[v.provider];
    if (!p) throw new Error(`unknown embedding provider: ${v.provider} (対応: ${Object.keys(PROVIDERS).join('/')})`);
    const keyEnv = v.apiKeyEnv || p.keyEnv;
    const key = process.env[keyEnv];
    if (!key) return { name: v.provider, missingKey: keyEnv };
    return { name: v.provider, key, model: v.model || p.model, batch: p.batch, request: p.request, extract: p.extract };
}

async function post(url, headers, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`embedding API -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
}

// texts -> 正規化済み number[][]。正規化済みなので cosine 類似度は内積で計算できる
export async function embedTexts(texts, p) {
    const out = [];
    for (let i = 0; i < texts.length; i += p.batch) {
        const chunk = texts.slice(i, i + p.batch);
        const [url, headers, body] = p.request(chunk, p);
        const j = await post(url, headers, body);
        for (const v of p.extract(j)) out.push(normalize(v));
        if (texts.length > p.batch) process.stderr.write(`embedded ${Math.min(i + p.batch, texts.length)}/${texts.length}\n`);
    }
    return out;
}

function normalize(v) {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
}

export function writeVectors(vecs, meta) {
    const dims = vecs[0] ? vecs[0].length : 0;
    const arr = new Float32Array(vecs.length * dims);
    vecs.forEach((v, i) => arr.set(v, i * dims));
    writeAtomic(VEC_BIN, Buffer.from(arr.buffer));
    writeAtomic(VEC_META, JSON.stringify({ ...meta, dims, count: vecs.length }));
}

// expectedCount: カタログ行数。再構築後・再埋め込み前の不整合時に
// ~15MB の .bin 読込を無駄にしないため、meta だけ先に読んで検証する。
// サイズ整合性チェックも同じ理由で fs.statSync(バイト数だけ取得)で先に済ませ、
// 破損/中途半端な書き込みのときに ~15MB を丸読みしてから捨てることのないようにする
// (旧実装は readFileSync してからサイズを見ていたため無駄読みが発生していた。/code-review で発見・修正)
export function readVectors(expectedCount) {
    const meta = readJsonSafe(VEC_META);
    if (!meta || !meta.dims || (expectedCount != null && meta.count !== expectedCount)) return null;
    const expectedBytes = meta.dims * meta.count * Float32Array.BYTES_PER_ELEMENT;
    try {
        if (fs.statSync(VEC_BIN).size !== expectedBytes) return null;
        const buf = fs.readFileSync(VEC_BIN);
        return { meta, arr: new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4) };
    } catch (e) {
        if (e.code !== 'ENOENT') console.error(`ccc: ${VEC_BIN} の読み込みに失敗しました: ${e.message}`);
        return null;
    }
}
