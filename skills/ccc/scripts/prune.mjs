#!/usr/bin/env node
// ccc: 導入資産の棚卸し(セッション単位のクレジット効率化)
//
// 背景: 導入済みエージェントの一覧は毎セッション・毎APIコールのシステムプロンプトに
// 載るため、「使っていない資産」は継続的にクレジットを消費する(常駐コンテキスト税)。
// 1プロンプトの節約より、この常駐税の削減の方がセッション単位では効く。
//
// 動作: 全セッション履歴(~/.claude/projects/**/*.jsonl)を走査して
// 実際に起動されたエージェント(Task の subagent_type)を集計し、
// 未使用エージェントと推定常駐税を報告する。
//   node prune.mjs           # ドライラン(報告のみ)
//   node prune.mjs --apply   # 未使用を ~/.claude/agents-archive/ へ退避(削除はしない)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { parseFrontmatter } from './embed.mjs';

const HOME = os.homedir();
const AGENTS_DIR = path.join(HOME, '.claude', 'agents');
const ARCHIVE_DIR = path.join(HOME, '.claude', 'agents-archive');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const apply = process.argv.includes('--apply');

// --- 導入済みエージェントの一覧(frontmatter の name とファイル名の両方で照合する) ---
const installed = [];
for (const f of fs.readdirSync(AGENTS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const fm = parseFrontmatter(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
    installed.push({ file: f, base: f.replace(/\.md$/, ''), name: fm.name || f.replace(/\.md$/, ''), fmLen: fm.fmLen });
}

// --- 全セッション履歴から使用実績を収集 ---
// transcripts は行指向 JSON。行全体を JSON.parse せず正規表現で subagent_type だけ拾う
// (ファイルが数百MBでもストリームで1パス)
async function collectUsedNames() {
    const used = new Set();
    if (!fs.existsSync(PROJECTS_DIR)) return used;
    const files = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.jsonl')) files.push(p);
        }
    })(PROJECTS_DIR);
    const allUsed = () => installed.every((a) => used.has(a.name) || used.has(a.base));
    for (const file of files) {
        // 全員の使用が確定したら以降の走査は結果を変えないため打ち切る
        // (履歴が数百MBあるときの支配的コスト対策)
        if (allUsed()) break;
        const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8') });
        for await (const line of rl) {
            for (const m of line.matchAll(/"subagent_type"\s*:\s*"([^"]+)"/g)) used.add(m[1]);
        }
    }
    return used;
}

const used = await collectUsedNames();
const isUsed = (a) => used.has(a.name) || used.has(a.base);
const unused = installed.filter((a) => !isUsed(a));
const usedList = installed.filter(isUsed);

// 常駐税の概算: エージェント一覧には name+description が載る ≒ frontmatter 長 / 4 トークン。
// 毎セッションの全 API コールにキャッシュ経由でも負荷がかかるため「セッションあたり」で示す
const taxTokens = Math.round(unused.reduce((s, a) => s + a.fmLen, 0) / 4);

console.log(JSON.stringify({
    installed: installed.length,
    used: usedList.map((a) => a.name),
    unusedCount: unused.length,
    estimatedTaxTokensPerSession: taxTokens,
    mode: apply ? 'apply' : 'dry-run',
}, null, 2));

if (apply && unused.length > 0) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    for (const a of unused) fs.renameSync(path.join(AGENTS_DIR, a.file), path.join(ARCHIVE_DIR, a.file));
    console.log(`${unused.length} 体を ${ARCHIVE_DIR} へ退避しました(復元は mv で戻すだけ)。`);
    console.log('カタログの installed 情報を更新するため build-index.mjs を再実行してください。');
}
