#!/usr/bin/env node
/**
 * generate-cdn-manifest.js
 *
 * Tự động tạo cdn-manifest.json dựa trên:
 *   - assets/scripts/data/locales/locale-online.json
 *   - assets/Font/{en,ko,zh-cn,zh-tw,fil,ja,th,sg,ms,vi}-subset.ttf
 *
 * ★ CÁCH DÙNG:
 *   node tools/generate-cdn-manifest.js
 *
 *   Flags:
 *     --force    Bump version tất cả files kể cả không đổi nội dung.
 *
 * ★ CÁCH HOẠT ĐỘNG:
 *   1. Tính SHA-256 của từng file (locale + 7 fonts).
 *   2. So sánh với lần chạy trước (lưu trong .cdn-hashes.json).
 *   3. File nào hash thay đổi → tăng version (YYYYMMDDNNN).
 *   4. File không đổi → giữ nguyên version cũ.
 *   5. Ghi ra cdn-manifest.json (sẵn sàng gửi cho người upload).
 *
 * ★ OUTPUT:
 *   cdn-manifest.json       ← file cần upload lên CDN
 *   .cdn-hashes.json        ← cache nội bộ, KHÔNG upload, nên gitignore
 *   ../supernova-cdn-export/YYYYMMDD_HHMM/  ← folder export đầy đủ để upload
 *
 * ★ LẦN ĐẦU chạy (chưa có .cdn-hashes.json):
 *   Tất cả files được coi là "mới" → đều có version = hôm nay.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');

/** Danh sách files cần theo dõi */
const TRACKED_FILES = [
    {
        key:      'locale',
        filePath: path.join(ROOT, 'assets', 'scripts', 'data', 'locales', 'locale-online.json'),
        label:    'locale-online.json',
    },
    ...['en', 'ko', 'zh-cn', 'zh-tw', 'fil', 'ja', 'th', 'sg', 'ms', 'vi'].map(lang => ({
        key:      `font_${lang}`,
        filePath: path.join(ROOT, 'assets', 'Font', `${lang}-subset.ttf`),
        label:    `${lang}-subset.ttf`,
        lang,
    })),
];

const MANIFEST_OUT  = path.join(ROOT, 'cdn-manifest.json');
const HASHES_CACHE  = path.join(ROOT, '.cdn-hashes.json');
const FORCE         = process.argv.includes('--force');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** SHA-256 của 1 file, trả hex string */
function sha256File(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Kích thước file tính bằng bytes */
function fileSize(filePath) {
    return fs.statSync(filePath).size;
}

/** Format ngày hôm nay: YYYYMMDD */
function today() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

/**
 * Tạo version string mới: YYYYMMDDNNN
 * Nếu manifest cũ đã có version hôm nay → tăng NNN lên 1.
 */
function nextVersion(oldVersion) {
    const t = today();
    if (!oldVersion || !oldVersion.startsWith(t)) {
        return `${t}001`;
    }
    const seq = parseInt(oldVersion.slice(8), 10) || 0;
    return `${t}${String(seq + 1).padStart(3, '0')}`;
}

/** Load JSON file an toàn, trả {} nếu không tồn tại hoặc parse lỗi */
function loadJson(filePath) {
    if (!fs.existsSync(filePath)) return {};
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

/**
 * Copy manifest + locale + fonts ra folder ngoài project (mirror CDN structure).
 * Cùng logic với extensions/localization-tools/main.js → exportCdnFiles().
 */
function exportCdnFiles(trackedEntries) {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const exportDir = path.join(ROOT, '..', 'supernova-cdn-export', stamp);
    const fontsDir = path.join(exportDir, 'fonts');

    fs.mkdirSync(fontsDir, { recursive: true });

    const copied = [];

    fs.copyFileSync(MANIFEST_OUT, path.join(exportDir, 'cdn-manifest.json'));
    copied.push('cdn-manifest.json');

    for (const entry of trackedEntries) {
        if (!entry.filePath || !fs.existsSync(entry.filePath)) continue;

        if (entry.key === 'locale') {
            fs.copyFileSync(entry.filePath, path.join(exportDir, 'locale-online.json'));
            copied.push('locale-online.json');
            continue;
        }

        if (entry.lang) {
            const filename = `${entry.lang}-subset.ttf`;
            fs.copyFileSync(entry.filePath, path.join(fontsDir, filename));
            copied.push(`fonts/${filename}`);
        }
    }

    return { exportDir, copied };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

function main() {
    console.log('\n[manifest] Đang tạo cdn-manifest.json...\n');

    // Load cache hash cũ và manifest cũ
    const oldHashes   = loadJson(HASHES_CACHE);
    const oldManifest = loadJson(MANIFEST_OUT);

    const newHashes   = {};
    const manifest    = { locale: null, fonts: {} };

    let changed = 0;
    let skipped = 0;
    let missing = 0;
    const presentEntries = [];

    for (const entry of TRACKED_FILES) {
        const { key, filePath, label, lang } = entry;

        // Kiểm tra file tồn tại
        if (!fs.existsSync(filePath)) {
            console.warn(`  ⚠  MISSING  ${label}`);
            console.warn(`             ${filePath}`);
            missing++;
            continue;
        }

        const hash = sha256File(filePath);
        const size = fileSize(filePath);
        newHashes[key] = hash;

        // Lấy version cũ
        let oldVersion = null;
        if (key === 'locale') {
            oldVersion = oldManifest?.locale?.v ?? null;
        } else if (lang) {
            oldVersion = oldManifest?.fonts?.[lang]?.v ?? null;
        }

        // Quyết định version mới
        const hasChanged = FORCE || (oldHashes[key] !== hash);
        const version    = hasChanged ? nextVersion(oldVersion) : (oldVersion ?? nextVersion(null));

        const status = hasChanged ? '🔄 CHANGED' : '✅ unchanged';
        const sizeKb = (size / 1024).toFixed(1);
        console.log(`  ${status.padEnd(14)} ${label.padEnd(22)} v=${version}  (${sizeKb} KB)`);

        if (hasChanged) changed++;
        else skipped++;

        presentEntries.push(entry);

        // Ghi vào manifest
        if (key === 'locale') {
            manifest.locale = { v: version, size };
        } else if (lang) {
            manifest.fonts[lang] = { v: version, size };
        }
    }

    // ─── Summary ─────────────────────────────────────────────────────────────

    console.log('');
    console.log(`  Files changed : ${changed}`);
    console.log(`  Files same    : ${skipped}`);
    if (missing > 0) {
        console.log(`  Files missing : ${missing}  ⚠  (những file này sẽ KHÔNG có trong manifest)`);
    }

    if (changed === 0 && !FORCE) {
        console.log('\n  Tất cả files không thay đổi. Không cần upload CDN.');
        console.log('  (Dùng --force nếu muốn bump version thủ công)');
    }

    // ─── Ghi output ──────────────────────────────────────────────────────────

    fs.writeFileSync(MANIFEST_OUT,  JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(HASHES_CACHE,  JSON.stringify(newHashes, null, 2), 'utf8');

    console.log(`\n  ✅ Đã ghi: cdn-manifest.json`);
    console.log(`  ✅ Đã ghi: .cdn-hashes.json  (internal cache, không upload)`);

    // ─── Preview manifest ─────────────────────────────────────────────────────

    console.log('\n─────────────────────────────────────────');
    console.log('cdn-manifest.json:');
    console.log('─────────────────────────────────────────');
    console.log(JSON.stringify(manifest, null, 2));
    console.log('─────────────────────────────────────────');

    // ─── Nhắc bước tiếp theo ─────────────────────────────────────────────────

    const exported = exportCdnFiles(presentEntries);
    console.log(`\n  ✅ Export folder: ${exported.exportDir}`);
    console.log(`     (${exported.copied.length} files — upload fonts/locale trước, cdn-manifest.json sau cùng)`);

    if (changed > 0 || FORCE) {
        console.log('\n★ BƯỚC TIẾP THEO — Upload folder export lên CDN:');
        console.log('   1. fonts/*.ttf');
        console.log('   2. locale-online.json');
        console.log('   3. cdn-manifest.json  ← SAU CÙNG');
    } else {
        console.log('\n  Không có file đổi nội dung — vẫn export folder đầy đủ nếu CDN server chưa có bộ mới.');
    }

    console.log('');

    if (missing > 0) process.exit(1);
}

main();
