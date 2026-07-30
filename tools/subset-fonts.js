#!/usr/bin/env node
/**
 * subset-fonts.js — Subset NotoSans fonts for each language using pyftsubset.
 *
 * Usage:  node tools/subset-fonts.js
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
const FONT_DIR = path.join(ASSETS_DIR, 'Font');
const LOCALES_DIR = path.join(ASSETS_DIR, 'scripts', 'data', 'locales');
const TEMP_DIR = path.join(ROOT, 'temp');
const OUTPUT_DIR = path.join(ROOT, 'build', 'fonts');
const DEBUG_FILE = path.join(OUTPUT_DIR, 'text_debug.txt');

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
    //           src font (in assets/Font/)                           CC TTF subset name           WOFF2 name (web)
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

    return langTexts;
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

    // 2a. TypeScript & JavaScript files — extract string literals
    const codeFiles = walkDir(ASSETS_DIR, name =>
        (name.endsWith('.ts') || name.endsWith('.js')) &&
        !name.endsWith('.d.ts') &&
        !name.endsWith('.meta')
    );
    for (const f of codeFiles) {
        // Skip locale .ts files (already processed per-language)
        if (f.includes(path.join('data', 'locales'))) continue;
        const content = fs.readFileSync(f, 'utf-8');
        allText += extractStringLiterals(content);
    }

    // 2b. JSON files in assets (not .meta)
    const jsonFiles = walkDir(ASSETS_DIR, name =>
        name.endsWith('.json') && !name.endsWith('.meta')
    );
    for (const f of jsonFiles) {
        // Skip locale json already handled
        if (f.includes(path.join('data', 'locales'))) continue;
        try {
            const content = fs.readFileSync(f, 'utf-8');
            allText += extractJsonStringValues(content);
        } catch (e) { /* skip */ }
    }

    // 2c. .prefab files — extract _string fields
    const prefabFiles = walkDir(ASSETS_DIR, name => name.endsWith('.prefab'));
    for (const f of prefabFiles) {
        allText += extractPrefabSceneStrings(f);
    }

    // 2d. .scene files — extract _string fields
    const sceneFiles = walkDir(ASSETS_DIR, name => name.endsWith('.scene'));
    for (const f of sceneFiles) {
        allText += extractPrefabSceneStrings(f);
    }

    return allText;
}

/** Extract string literals from TypeScript/JS source */
function extractStringLiterals(code) {
    const parts = [];
    // Single-quoted strings
    const sq = /'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = sq.exec(code)) !== null) {
        parts.push(m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'"));
    }
    // Double-quoted strings
    const dq = /"((?:[^"\\]|\\.)*)"/g;
    while ((m = dq.exec(code)) !== null) {
        parts.push(m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    }
    // Template literals (backtick) — simple version, no nested
    const tl = /`([^`]*)`/g;
    while ((m = tl.exec(code)) !== null) {
        parts.push(m[1]);
    }
    return parts.join('');
}

/** Extract all string values from JSON content */
function extractJsonStringValues(content) {
    try {
        const data = JSON.parse(content);
        return collectJsonStrings(data).join('');
    } catch {
        return '';
    }
}

function collectJsonStrings(obj, result = []) {
    if (typeof obj === 'string') {
        result.push(obj);
    } else if (Array.isArray(obj)) {
        for (const item of obj) collectJsonStrings(item, result);
    } else if (obj && typeof obj === 'object') {
        for (const val of Object.values(obj)) collectJsonStrings(val, result);
    }
    return result;
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

function runSubset(lang, cpSet) {
    const config = LANG_FONT_MAP[lang];
    const srcFont = path.join(FONT_DIR, config.src);
    // TTF subset → assets/Font/{lang}-subset.ttf  (for Cocos Creator)
    const outTTF   = path.join(CC_FONT_DIR, config.ttf);
    // WOFF2       → build/fonts/font_{lang}.woff2 (for web deployment)
    const outWOFF2 = path.join(OUTPUT_DIR,  config.woff2);

    if (!fs.existsSync(srcFont)) {
        console.error(`  ✗ Source font not found: ${srcFont}`);
        return false;
    }

    const unicodes = codepointsToUnicodeStr(cpSet);

    // Write unicode list to temp file (avoids command-line length limits)
    const unicodeFile = path.join(OUTPUT_DIR, `_unicodes_${lang}.txt`);
    fs.writeFileSync(unicodeFile, unicodes, 'utf-8');

    const origStat = fs.statSync(srcFont);
    console.log(`  → ${lang}: ${cpSet.size} codepoints | src ${(origStat.size / 1024).toFixed(0)}KB`);

    // ── 4a. Subset TTF (Cocos Creator) ──────────────────────────────────────
    const cmdTTF = [
        'pyftsubset',
        `"${srcFont}"`,
        `--unicodes-file="${unicodeFile}"`,
        `--output-file="${outTTF}"`,
        '--no-hinting',
        '--desubroutinize',
        '--layout-features=kern,liga,calt,ccmp,mark,mkmk,locl',
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
        '--no-hinting',
        '--desubroutinize',
        '--layout-features=kern,liga,calt,ccmp,mark,mkmk,locl',
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

    // Step 2: Collect shared asset texts
    console.log('\n[2/4] Scanning asset files (.ts, .js, .json, .prefab, .scene)…');
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
