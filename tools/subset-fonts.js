#!/usr/bin/env node
/**
 * subset-fonts.js — Subset NotoSans fonts for each language using pyftsubset.
 *
 * Usage:  node tools/subset-fonts.js
 *
 * Source fonts: FontBase/{src} trước, fallback assets/Font/{src}
 * Glyphs: locales + LocalizationStringTable.xlsx + prefab/scene _string
 * Output: assets/Font/{lang}-subset.ttf  +  build/fonts/font_{lang}.woff2
 *
 * Requirements:
 *   pip install fonttools brotli   (provides pyftsubset + woff2 support)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── CONFIG ────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'assets');
const FONT_BASE_DIR = path.join(ROOT, 'FontBase');
const FONT_DIR = path.join(ASSETS_DIR, 'Font');
const LOCALES_DIR = path.join(ASSETS_DIR, 'scripts', 'data', 'locales');
const TEMP_DIR = path.join(ROOT, 'temp');
const XLSX_FILE = path.join(ROOT, 'LocalizationStringTable.xlsx');
const OUTPUT_DIR = path.join(ROOT, 'build', 'fonts');
const DEBUG_FILE = path.join(OUTPUT_DIR, 'text_debug.txt');

/** Excel column index → language (khớp convert-localization-xlsx.js) */
const XLSX_COL_MAP = {
    2: 'en', 3: 'ko', 4: 'zh-cn', 5: 'zh-tw', 6: 'fil',
    7: 'ja', 8: 'th', 9: 'sg', 10: 'ms', 11: 'vi',
};

/** CJK / Thai: giữ hinting để nét ExtraBold không bị gầy ở size UI */
const KEEP_HINTING_LANGS = new Set(['zh-cn', 'zh-tw', 'ja', 'ko', 'th']);

/**
 * Subset TTF files are copied here so Cocos Creator can import them directly.
 * Naming: {lang}-subset.ttf  (e.g. en-subset.ttf, ko-subset.ttf)
 */
const CC_FONT_DIR = FONT_DIR; // same assets/Font/ folder CC already watches

/** Characters always included in every subset */
const COMMON_CHARS = '0123456789.,!?-+*/=%:() ';

/**
 * Language → source font file → output font file
 * Matches FontManager.ts mapping.
 */
const LANG_FONT_MAP = {
    //           src font (FontBase/ rồi fallback assets/Font/)        CC TTF subset name           WOFF2 name (web)
    en:      { src: 'English.ttf',                               ttf: 'en-subset.ttf',         woff2: 'font_en.woff2'    },
    fil:     { src: 'English.ttf',                               ttf: 'fil-subset.ttf',        woff2: 'font_fil.woff2'   },
    ko:      { src: 'noto-sans-kr-korean-800-normal.ttf',        ttf: 'ko-subset.ttf',         woff2: 'font_ko.woff2'    },
    'zh-cn': { src: 'NotoSansSC-ExtraBold.ttf',                  ttf: 'zh-cn-subset.ttf',      woff2: 'font_zh-cn.woff2' },
    'zh-tw': { src: 'NotoSansTC-ExtraBold.ttf',                  ttf: 'zh-tw-subset.ttf',      woff2: 'font_zh-tw.woff2' },
    ja:      { src: 'noto-sans-jp-bold.ttf',                     ttf: 'ja-subset.ttf',         woff2: 'font_ja.woff2'    },
    th:      { src: 'NotoSansThai_Condensed-ExtraBold.ttf',      ttf: 'th-subset.ttf',         woff2: 'font_th.woff2'    },
    sg:      { src: 'English.ttf',                               ttf: 'sg-subset.ttf',         woff2: 'font_sg.woff2'    },
    ms:      { src: 'English.ttf',                               ttf: 'ms-subset.ttf',         woff2: 'font_ms.woff2'    },
    vi:      { src: 'NotoSans-Bold.ttf',                         ttf: 'vi-subset.ttf',         woff2: 'font_vi.woff2'    },
};

// ─── HELPERS ───────────────────────────────────────────────────────────────────

/** Recursively walk a directory and return all file paths matching a predicate */
function walkDir(dir, predicate, result = []) {
    if (!fs.existsSync(dir)) return result;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkDir(full, predicate, result);
        } else if (predicate(entry.name)) {
            result.push(full);
        }
    }
    return result;
}

/** Extract unique codepoints from a string, returns a Set<number> */
function extractCodepoints(text) {
    const cps = new Set();
    for (const ch of text) {
        cps.add(ch.codePointAt(0));
    }
    return cps;
}

/** Merge a Set<number> into another */
function mergeInto(target, source) {
    for (const cp of source) target.add(cp);
}

// ─── STEP 1: Collect text per language ─────────────────────────────────────────

function collectLocaleTexts() {
    const langTexts = {};
    for (const lang of Object.keys(LANG_FONT_MAP)) {
        langTexts[lang] = '';
    }

    // 1a. TypeScript locale files  (assets/scripts/data/locales/{lang}.ts)
    for (const lang of Object.keys(LANG_FONT_MAP)) {
        const tsFile = path.join(LOCALES_DIR, `${lang}.ts`);
        if (fs.existsSync(tsFile)) {
            const content = fs.readFileSync(tsFile, 'utf-8');
            // Extract all string values from the object literal
            const values = extractTsLocaleValues(content);
            langTexts[lang] += values;
        }
    }

    // 1b. JSON locale files  (temp/locale_{lang}.json)
    for (const lang of Object.keys(LANG_FONT_MAP)) {
        const jsonFile = path.join(TEMP_DIR, `locale_${lang}.json`);
        if (fs.existsSync(jsonFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
                langTexts[lang] += Object.values(data).join('');
            } catch (e) {
                console.warn(`  ⚠ Failed to parse ${jsonFile}: ${e.message}`);
            }
        }
    }

    // 1c. Online locale JSON (assets/scripts/data/locales/locale-online.json)
    const onlineFile = path.join(LOCALES_DIR, 'locale-online.json');
    if (fs.existsSync(onlineFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(onlineFile, 'utf-8'));
            // Structure: { lang: { key: value } } or flat
            for (const [lang, dict] of Object.entries(data)) {
                const normalizedLang = lang.toLowerCase();
                if (langTexts[normalizedLang] !== undefined && typeof dict === 'object') {
                    langTexts[normalizedLang] += Object.values(dict).join('');
                }
            }
        } catch (e) {
            console.warn(`  ⚠ Failed to parse locale-online.json: ${e.message}`);
        }
    }

    // 1d. Excel nguồn — đảm bảo glyph mới chưa convert vào .ts vẫn được subset
    collectXlsxTexts(langTexts);

    return langTexts;
}

/** Đọc trực tiếp LocalizationStringTable.xlsx — không phụ thuộc convert .ts */
function collectXlsxTexts(langTexts) {
    if (!fs.existsSync(XLSX_FILE)) {
        console.warn('  ⚠ LocalizationStringTable.xlsx không có — bỏ qua');
        return;
    }
    let XLSX;
    try {
        XLSX = require('xlsx');
    } catch (e) {
        console.warn('  ⚠ Chưa cài package "xlsx" — bỏ qua Excel:', e.message);
        return;
    }
    const wb = XLSX.readFile(XLSX_FILE);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
        header: 1, raw: false, defval: '',
    });
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        for (const [col, lang] of Object.entries(XLSX_COL_MAP)) {
            if (langTexts[lang] === undefined) continue;
            const val = row[parseInt(col, 10)];
            if (val) langTexts[lang] += String(val);
        }
    }
}

/** Parse TS locale file and return all string values concatenated */
function extractTsLocaleValues(content) {
    const values = [];
    // Match patterns like:  key: 'value',  or  key: "value",
    // Handles multiline via [\s\S] and escaped quotes
    const regex = /:\s*'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = regex.exec(content)) !== null) {
        values.push(m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'"));
    }
    return values.join('');
}

// ─── STEP 2: Collect text from assets (shared across all languages) ────────────

function collectAssetTexts() {
    let allText = '';
    // Chỉ lấy text UI trên prefab/scene — KHÔNG quét .ts/.js (log/comment có emoji).
    const prefabFiles = walkDir(ASSETS_DIR, name => name.endsWith('.prefab'));
    for (const f of prefabFiles) {
        allText += extractPrefabSceneStrings(f);
    }
    const sceneFiles = walkDir(ASSETS_DIR, name => name.endsWith('.scene'));
    for (const f of sceneFiles) {
        allText += extractPrefabSceneStrings(f);
    }
    return allText;
}

/** Extract "_string" field values from .prefab / .scene (Cocos Creator JSON) */
function extractPrefabSceneStrings(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        const strings = [];
        extractFieldRecursive(data, '_string', strings);
        // Also grab "_N$string" which some Cocos versions use
        extractFieldRecursive(data, '_N$string', strings);
        return strings.join('');
    } catch {
        return '';
    }
}

function extractFieldRecursive(obj, fieldName, result) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        for (const item of obj) extractFieldRecursive(item, fieldName, result);
        return;
    }
    for (const [key, val] of Object.entries(obj)) {
        if (key === fieldName && typeof val === 'string') {
            result.push(val);
        } else if (typeof val === 'object') {
            extractFieldRecursive(val, fieldName, result);
        }
    }
}

// ─── STEP 3: Build codepoint sets ──────────────────────────────────────────────

function buildCodepointSets(langTexts, sharedText) {
    const commonCps = extractCodepoints(COMMON_CHARS);
    const sharedCps = extractCodepoints(sharedText);

    const result = {};
    for (const [lang, text] of Object.entries(langTexts)) {
        const cps = new Set();
        mergeInto(cps, commonCps);
        mergeInto(cps, sharedCps);
        mergeInto(cps, extractCodepoints(text));
        result[lang] = cps;
    }
    return result;
}

// ─── STEP 4: Write unicodes file & run pyftsubset ──────────────────────────────

function codepointsToUnicodeStr(cps) {
    return Array.from(cps)
        .sort((a, b) => a - b)
        .map(cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'))
        .join(',');
}

function resolveSrcFont(fileName) {
    const candidates = [
        path.join(FONT_BASE_DIR, fileName),
        path.join(FONT_DIR, fileName),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

function subsetFlags(lang) {
    const flags = [
        '--desubroutinize',
        '--layout-features=kern,liga,calt,ccmp,mark,mkmk,locl',
    ];
    if (!KEEP_HINTING_LANGS.has(lang)) {
        flags.unshift('--no-hinting');
    }
    return flags;
}

function runSubset(lang, cpSet) {
    const config = LANG_FONT_MAP[lang];
    const srcFont = resolveSrcFont(config.src);
    // TTF subset → assets/Font/{lang}-subset.ttf  (for Cocos Creator)
    const outTTF   = path.join(CC_FONT_DIR, config.ttf);
    // WOFF2       → build/fonts/font_{lang}.woff2 (for web deployment)
    const outWOFF2 = path.join(OUTPUT_DIR,  config.woff2);

    if (!srcFont) {
        console.error(`  ✗ Source font not found: ${config.src}`);
        console.error(`     searched: ${path.join(FONT_BASE_DIR, config.src)}`);
        console.error(`               ${path.join(FONT_DIR, config.src)}`);
        return false;
    }

    const unicodes = codepointsToUnicodeStr(cpSet);

    // Write unicode list to temp file (avoids command-line length limits)
    const unicodeFile = path.join(OUTPUT_DIR, `_unicodes_${lang}.txt`);
    fs.writeFileSync(unicodeFile, unicodes, 'utf-8');

    const origStat = fs.statSync(srcFont);
    const srcLabel = path.relative(ROOT, srcFont);
    console.log(`  → ${lang}: ${cpSet.size} codepoints | src ${srcLabel} (${(origStat.size / 1024).toFixed(0)}KB)`);

    // ── 4a. Subset TTF (Cocos Creator) ──────────────────────────────────────
    const cmdTTF = [
        'pyftsubset',
        `"${srcFont}"`,
        `--unicodes-file="${unicodeFile}"`,
        `--output-file="${outTTF}"`,
        ...subsetFlags(lang),
    ].join(' ');

    let okTTF = false;
    try {
        execSync(cmdTTF, { stdio: 'pipe' });
        const stat = fs.statSync(outTTF);
        const ratio = ((1 - stat.size / origStat.size) * 100).toFixed(1);
        console.log(`    ✓ TTF  → ${config.ttf}  (${(stat.size / 1024).toFixed(0)}KB, −${ratio}%)  ← drag this into FontManager`);
        okTTF = true;
    } catch (e) {
        console.error(`    ✗ TTF subset failed:`, e.stderr?.toString() || e.message);
    }

    // ── 4b. Subset WOFF2 (web deployment) ───────────────────────────────────
    const cmdWOFF2 = [
        'pyftsubset',
        `"${srcFont}"`,
        `--unicodes-file="${unicodeFile}"`,
        `--output-file="${outWOFF2}"`,
        '--flavor=woff2',
        ...subsetFlags(lang),
    ].join(' ');

    let okWOFF2 = false;
    try {
        execSync(cmdWOFF2, { stdio: 'pipe' });
        const stat = fs.statSync(outWOFF2);
        const ratio = ((1 - stat.size / origStat.size) * 100).toFixed(1);
        console.log(`    ✓ WOFF2 → ${config.woff2} (${(stat.size / 1024).toFixed(0)}KB, −${ratio}%)  ← web deployment`);
        okWOFF2 = true;
    } catch (e) {
        console.error(`    ✗ WOFF2 subset failed:`, e.stderr?.toString() || e.message);
    }

    return okTTF && okWOFF2;
}

// ─── STEP 5: Write debug file ──────────────────────────────────────────────────

function writeDebugFile(langCpSets) {
    const lines = [];
    lines.push('=== Font Subset Debug Report ===');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    for (const [lang, cpSet] of Object.entries(langCpSets)) {
        const config = LANG_FONT_MAP[lang];
        const chars = Array.from(cpSet)
            .sort((a, b) => a - b)
            .map(cp => String.fromCodePoint(cp))
            .join('');

        lines.push(`── ${lang} (${config.src} → CC: ${config.ttf} / Web: ${config.woff2}) ──`);
        lines.push(`Codepoints: ${cpSet.size}`);
        lines.push(`Characters: ${chars}`);
        lines.push('');
    }

    fs.writeFileSync(DEBUG_FILE, lines.join('\n'), 'utf-8');
    console.log(`\n  Debug file: ${DEBUG_FILE}`);
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

function main() {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   SuperNova Font Subset Tool         ║');
    console.log('╚══════════════════════════════════════╝\n');

    // Ensure output directory exists
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Step 1: Collect locale texts per language
    console.log('[1/4] Collecting locale texts…');
    const langTexts = collectLocaleTexts();
    for (const [lang, text] of Object.entries(langTexts)) {
        console.log(`  ${lang}: ${text.length} chars raw`);
    }

    // Step 2: Collect shared UI texts (prefab/scene only)
    console.log('\n[2/4] Scanning prefab/scene _string fields…');
    const sharedText = collectAssetTexts();
    console.log(`  Shared asset text: ${sharedText.length} chars raw`);

    // Step 3: Build unique codepoint sets
    console.log('\n[3/4] Building codepoint sets…');
    const langCpSets = buildCodepointSets(langTexts, sharedText);
    for (const [lang, cpSet] of Object.entries(langCpSets)) {
        console.log(`  ${lang}: ${cpSet.size} unique codepoints`);
    }

    // Step 4: Run pyftsubset for each language
    console.log('\n[4/4] Running pyftsubset (TTF for Cocos Creator + WOFF2 for web)…');
    let success = 0;
    let fail = 0;
    for (const lang of Object.keys(LANG_FONT_MAP)) {
        if (runSubset(lang, langCpSets[lang])) {
            success++;
        } else {
            fail++;
        }
    }

    // Step 5: Debug file
    writeDebugFile(langCpSets);

    // Cleanup temp unicode files
    for (const lang of Object.keys(LANG_FONT_MAP)) {
        const f = path.join(OUTPUT_DIR, `_unicodes_${lang}.txt`);
        if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    console.log('\n─── Sau khi chạy xong: ──────────────────────────────────');
    console.log('  1. Mở Cocos Creator → assets/Font/ sẽ thấy các file *-subset.ttf');
    console.log('  2. Drag từng file vào FontManager Inspector:');
    for (const [lang, cfg] of Object.entries(LANG_FONT_MAP)) {
        console.log(`     ${lang.padEnd(6)} → ${cfg.ttf}`);
    }
    console.log('─────────────────────────────────────────────────────────\n');

    console.log(`✓ Done: ${success} succeeded, ${fail} failed\n`);
    process.exit(fail > 0 ? 1 : 0);
}

main();
