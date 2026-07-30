/**
 * post-build-compress.js
 *
 * Nén Gzip (.gz) và Brotli (.br) cho toàn bộ assets trong build/web-desktop
 * trước khi upload lên S3.
 *
 * Sử dụng:
 *   node tools/post-build-compress.js
 *   node tools/post-build-compress.js --platform web-mobile
 *   node tools/post-build-compress.js --build-dir path/to/custom/build
 *
 * Sau khi chạy, upload lên S3 với header:
 *   .gz files → Content-Encoding: gzip
 *   .br files → Content-Encoding: br
 *
 * Backend cần set đúng Content-Encoding khi serve file,
 * HOẶC đổi tên file gốc → .js.gz và server trả header tương ứng.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Config ────────────────────────────────────────────────

// Parse CLI args
const args = process.argv.slice(2);
const platformIdx = args.indexOf('--platform');
const platform = platformIdx !== -1 ? args[platformIdx + 1] : 'web-desktop';
const buildDirIdx = args.indexOf('--build-dir');
const BUILD_DIR = buildDirIdx !== -1
    ? path.resolve(args[buildDirIdx + 1])
    : path.resolve(__dirname, '..', 'build', platform);

// File types to compress (text-based assets benefit most from compression)
const COMPRESS_EXTENSIONS = new Set(['.js', '.json', '.css', '.html', '.atlas', '.ttf']);

// File types to SKIP compression (already compressed formats)
const SKIP_EXTENSIONS = new Set(['.gz', '.br', '.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.ogg', '.wasm', '.bin']);

// Compression level (1-9 for gzip, 1-11 for brotli)
const GZIP_LEVEL    = 9;   // max compression
const BROTLI_LEVEL  = 11;  // max compression (slow but best ratio)

// Whether to also generate Brotli (requires modern server support)
const ENABLE_BROTLI = true;

// Whether to keep original uncompressed file alongside .gz/.br
const KEEP_ORIGINAL = true;

// ─── Stats ─────────────────────────────────────────────────

let stats = {
    scanned:   0,
    skipped:   0,
    compressed: 0,
    errors:    0,
    originalBytes: 0,
    gzipBytes:  0,
    brotliBytes: 0,
};

// ─── Helpers ───────────────────────────────────────────────

function formatBytes(bytes) {
    if (bytes < 1024)       return bytes + ' B';
    if (bytes < 1024*1024)  return (bytes/1024).toFixed(1) + ' KB';
    return (bytes/1024/1024).toFixed(2) + ' MB';
}

function gzipFile(srcPath) {
    return new Promise((resolve, reject) => {
        const src  = fs.createReadStream(srcPath);
        const dest = fs.createWriteStream(srcPath + '.gz');
        const gz   = zlib.createGzip({ level: GZIP_LEVEL });
        src.pipe(gz).pipe(dest);
        dest.on('finish', resolve);
        dest.on('error', reject);
        src.on('error', reject);
    });
}

function brotliFile(srcPath) {
    return new Promise((resolve, reject) => {
        const input = fs.readFileSync(srcPath);
        zlib.brotliCompress(input, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_LEVEL }
        }, (err, result) => {
            if (err) return reject(err);
            fs.writeFileSync(srcPath + '.br', result);
            resolve();
        });
    });
}

async function processFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    stats.scanned++;

    // Skip already-compressed formats
    if (SKIP_EXTENSIONS.has(ext)) {
        stats.skipped++;
        return;
    }

    // Skip files that already have compressed versions (don't re-compress)
    if (fs.existsSync(filePath + '.gz') && fs.existsSync(filePath + '.br')) {
        stats.skipped++;
        return;
    }

    if (!COMPRESS_EXTENSIONS.has(ext)) {
        stats.skipped++;
        return;
    }

    try {
        const originalSize = fs.statSync(filePath).size;
        stats.originalBytes += originalSize;

        // Gzip
        await gzipFile(filePath);
        const gzSize = fs.statSync(filePath + '.gz').size;
        stats.gzipBytes += gzSize;

        // Brotli (better compression, requires server support)
        if (ENABLE_BROTLI) {
            await brotliFile(filePath);
            const brSize = fs.statSync(filePath + '.br').size;
            stats.brotliBytes += brSize;
        }

        const saving = ((1 - gzSize / originalSize) * 100).toFixed(1);
        console.log(`  ✓ ${path.relative(BUILD_DIR, filePath).padEnd(60)} ${formatBytes(originalSize).padStart(8)} → gz:${formatBytes(gzSize)} (${saving}% saved)`);
        stats.compressed++;

    } catch (err) {
        console.error(`  ✗ ERROR: ${filePath} — ${err.message}`);
        stats.errors++;
    }
}

function walkDir(dirPath, fileList = []) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            walkDir(fullPath, fileList);
        } else if (entry.isFile()) {
            // Skip already-compressed output files
            if (!fullPath.endsWith('.gz') && !fullPath.endsWith('.br')) {
                fileList.push(fullPath);
            }
        }
    }
    return fileList;
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
    console.log('');
    console.log('══════════════════════════════════════════════════');
    console.log('  Post-Build Compress — Gzip + Brotli');
    console.log('══════════════════════════════════════════════════');
    console.log(`  Build dir : ${BUILD_DIR}`);
    console.log(`  Gzip level: ${GZIP_LEVEL} | Brotli: ${ENABLE_BROTLI ? 'YES level=' + BROTLI_LEVEL : 'NO'}`);
    console.log('');

    if (!fs.existsSync(BUILD_DIR)) {
        console.error(`ERROR: Build directory not found: ${BUILD_DIR}`);
        console.error(`Run Cocos Creator build first, then run this script.`);
        process.exit(1);
    }

    const allFiles = walkDir(BUILD_DIR);
    console.log(`  Found ${allFiles.length} files to scan...\n`);

    for (const file of allFiles) {
        await processFile(file);
    }

    // ─── Summary ─────────────────────────────────────────
    console.log('');
    console.log('══════════════════════════════════════════════════');
    console.log('  SUMMARY');
    console.log('══════════════════════════════════════════════════');
    console.log(`  Scanned   : ${stats.scanned} files`);
    console.log(`  Compressed: ${stats.compressed} files`);
    console.log(`  Skipped   : ${stats.skipped} files`);
    console.log(`  Errors    : ${stats.errors}`);
    console.log('');
    console.log(`  Original  : ${formatBytes(stats.originalBytes)}`);
    console.log(`  Gzip (.gz): ${formatBytes(stats.gzipBytes)}  (${((1 - stats.gzipBytes/stats.originalBytes)*100).toFixed(1)}% reduction)`);
    if (ENABLE_BROTLI) {
        console.log(`  Brotli(.br): ${formatBytes(stats.brotliBytes)}  (${((1 - stats.brotliBytes/stats.originalBytes)*100).toFixed(1)}% reduction)`);
    }
    console.log('');

    if (stats.errors > 0) {
        console.error(`  ⚠ ${stats.errors} file(s) failed to compress.`);
        process.exit(1);
    }

    console.log('  ✅ Done! Upload .gz and .br files to S3.');
    console.log('');
    console.log('  S3 / Server config needed:');
    console.log('  - Serve .js.gz  with header: Content-Encoding: gzip,  Content-Type: application/javascript');
    console.log('  - Serve .js.br  with header: Content-Encoding: br,    Content-Type: application/javascript');
    console.log('  - Serve .json.gz with header: Content-Encoding: gzip, Content-Type: application/json');
    console.log('  - Serve .json.br with header: Content-Encoding: br,   Content-Type: application/json');
    console.log('  OR: Ask backend to enable auto-gzip on S3 + CloudFront');
    console.log('');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
