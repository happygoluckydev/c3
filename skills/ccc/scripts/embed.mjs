// ccc: 埋め込みプロバイダアダプタ + 設定/ベクトルファイル IO (Step2: ベクトル検索用)
// - API キーは環境変数からのみ読む。設定ファイル・カタログ・ログには絶対に書かない
// - ベクトルは L2 正規化して Float32Array バイナリで保存(JSON だと約4倍に膨らむため)
// - 依存ライブラリなし(REST 直叩き)。プロバイダ追加は PROVIDERS に1行足すだけ
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DATA_DIR = path.join(os.homedir(), '.claude', 'ccc');
const CONFIG = path.join(DATA_DIR, 'config.json');
export const VEC_BIN = path.join(DATA_DIR, 'vectors.bin');
export const VEC_META = path.join(DATA_DIR, 'vectors.json');

// config.json が無い場合の既定値 = 従来挙動(本文索引あり・ベクトルなし)
const DEFAULTS = { fulltext: true, vectors: { provider: 'none' } };

const PROVIDERS = {
    gemini: { keyEnv: 'GEMINI_API_KEY', model: 'text-embedding-004', batch: 100 },
    voyage: { keyEnv: 'VOYAGE_API_KEY', model: 'voyage-3.5-lite', batch: 128 },
    openai: { keyEnv: 'OPENAI_API_KEY', model: 'text-embedding-3-small', batch: 256 },
};

export function loadConfig() {
    try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; }
    catch { return DEFAULTS; }
}

// 戻り値: null(無効) / {missingKey}(キー未設定) / {name,key,model,batch}(利用可)
export function resolveProvider(cfg) {
    const name = cfg.vectors && cfg.vectors.provider;
    if (!name || name === 'none') return null;
    const p = PROVIDERS[name];
    if (!p) throw new Error(`unknown embedding provider: ${name}`);
    const keyEnv = (cfg.vectors && cfg.vectors.apiKeyEnv) || p.keyEnv;
    const key = process.env[keyEnv];
    if (!key) return { name, missingKey: keyEnv };
    return { name, key, model: (cfg.vectors && cfg.vectors.model) || p.model, batch: p.batch };
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
        let vecs;
        if (p.name === 'gemini') {
            const j = await post(
                `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:batchEmbedContents?key=${p.key}`,
                {},
                { requests: chunk.map((t) => ({ model: `models/${p.model}`, content: { parts: [{ text: t }] } })) },
            );
            vecs = j.embeddings.map((e) => e.values);
        } else if (p.name === 'voyage') {
            const j = await post('https://api.voyageai.com/v1/embeddings',
                { Authorization: `Bearer ${p.key}` }, { model: p.model, input: chunk });
            vecs = j.data.map((d) => d.embedding);
        } else {
            const j = await post('https://api.openai.com/v1/embeddings',
                { Authorization: `Bearer ${p.key}` }, { model: p.model, input: chunk });
            vecs = j.data.map((d) => d.embedding);
        }
        for (const v of vecs) out.push(normalize(v));
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
    fs.writeFileSync(VEC_BIN, Buffer.from(arr.buffer));
    fs.writeFileSync(VEC_META, JSON.stringify({ ...meta, dims, count: vecs.length }));
}

export function readVectors() {
    try {
        const meta = JSON.parse(fs.readFileSync(VEC_META, 'utf8'));
        const buf = fs.readFileSync(VEC_BIN);
        return { meta, arr: new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4) };
    } catch { return null; }
}
