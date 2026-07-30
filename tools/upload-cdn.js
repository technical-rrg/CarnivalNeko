#!/usr/bin/env node
/**
 * upload-cdn.js — Upload font WOFF2 + locale-online.json lên AWS S3 / CloudFront CDN.
 *
 * ★ CÁCH DÙNG:
 *   node tools/upload-cdn.js [--dry-run]
 *
 *   Flags:
 *     --dry-run   Chỉ liệt kê file sẽ upload, không thực sự gửi lên S3.
 *
 * ★ BIẾN MÔI TRƯỜNG (bắt buộc):
 *   AWS_ACCESS_KEY_ID       AWS access key
 *   AWS_SECRET_ACCESS_KEY   AWS secret key
 *   AWS_REGION              S3 region, ví dụ: ap-southeast-1
 *   S3_BUCKET               Tên bucket, ví dụ: supernova-cdn
 *   S3_PREFIX               Prefix/folder trong bucket, ví dụ: supernova/v1
 *                           (để trống = root của bucket)
 *
 * ★ FILES ĐƯỢC UPLOAD:
 *   build/fonts/font_*.woff2       → {prefix}/fonts/font_*.woff2
 *   assets/Font/*-subset.ttf       → {prefix}/fonts/*-subset.ttf
 *   assets/scripts/data/locales/locale-online.json  → {prefix}/locale-online.json
 *
 * ★ YÊU CẦU:
 *   npm install --save-dev @aws-sdk/client-s3 @aws-sdk/lib-storage
 *
 * ★ VÍ DỤ .env (dùng với dotenv hoặc set trực tiếp trong terminal):
 *   AWS_ACCESS_KEY_ID=AKIA...
 *   AWS_SECRET_ACCESS_KEY=...
 *   AWS_REGION=ap-southeast-1
 *   S3_BUCKET=supernova-cdn
 *   S3_PREFIX=supernova/v1
 *
 * ★ URL SAU KHI UPLOAD (ví dụ CloudFront):
 *   https://d1234567890.cloudfront.net/supernova/v1/locale-online.json
 *   https://d1234567890.cloudfront.net/supernova/v1/fonts/font_ko.woff2
 *
 * ★ CONFIG TRONG GAME (LocalizationManager.ts):
 *   LocalizationManager.instance.loadOnlineLocale(
 *     'https://d1234567890.cloudfront.net/supernova/v1/locale-online.json'
 *   );
 */

const fs = require('fs');
const path = require('path');

// ─── REQUIRE AWS SDK ─────────────────────────────────────────────────────────

let S3Client, PutObjectCommand;
try {
    ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
} catch {
    console.error(
        '[upload-cdn] ❌ @aws-sdk/client-s3 chưa được cài.\n' +
        '   Chạy: npm install --save-dev @aws-sdk/client-s3\n'
    );
    process.exit(1);
}

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(__dirname, '..');
const BUILD_FONTS = path.join(ROOT, 'build', 'fonts');
const CC_FONTS    = path.join(ROOT, 'assets', 'Font');
const LOCALE_JSON = path.join(ROOT, 'assets', 'scripts', 'data', 'locales', 'locale-online.json');

const DRY_RUN = process.argv.includes('--dry-run');

/** Lấy biến môi trường bắt buộc, exit nếu thiếu */
function requireEnv(name) {
    const val = process.env[name];
    if (!val) {
        console.error(`[upload-cdn] ❌ Biến môi trường "${name}" chưa được set.`);
        process.exit(1);
    }
    return val;
}

const REGION = requireEnv('AWS_REGION');
const BUCKET = requireEnv('S3_BUCKET');
const PREFIX = (process.env.S3_PREFIX || '').replace(/\/$/, ''); // bỏ trailing slash

/** Tạo S3 key từ prefix + sub-path */
function s3Key(subPath) {
    return PREFIX ? `${PREFIX}/${subPath}` : subPath;
}

// ─── MIME MAP ────────────────────────────────────────────────────────────────

const MIME = {
    '.woff2': 'font/woff2',
    '.ttf':   'font/ttf',
    '.json':  'application/json',
};

function mimeFor(filePath) {
    return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ─── COLLECT FILES ───────────────────────────────────────────────────────────

/**
 * Trả về danh sách { localPath, s3Key, contentType } cần upload.
 */
function collectFiles() {
    const files = [];

    // 1. WOFF2 fonts từ build/fonts/
    if (fs.existsSync(BUILD_FONTS)) {
        for (const name of fs.readdirSync(BUILD_FONTS)) {
            if (name.endsWith('.woff2')) {
                files.push({
                    localPath:   path.join(BUILD_FONTS, name),
                    s3Key:       s3Key(`fonts/${name}`),
                    contentType: 'font/woff2',
                });
            }
        }
    } else {
        console.warn(`[upload-cdn] ⚠  build/fonts/ không tồn tại — bỏ qua WOFF2.`);
        console.warn(`              Chạy "node tools/subset-fonts.js" trước để tạo font.`);
    }

    // 2. Subset TTF từ assets/Font/ (dùng trực tiếp trong Cocos nếu load dynamic)
    if (fs.existsSync(CC_FONTS)) {
        for (const name of fs.readdirSync(CC_FONTS)) {
            if (name.endsWith('-subset.ttf')) {
                files.push({
                    localPath:   path.join(CC_FONTS, name),
                    s3Key:       s3Key(`fonts/${name}`),
                    contentType: 'font/ttf',
                });
            }
        }
    }

    // 3. locale-online.json
    if (fs.existsSync(LOCALE_JSON)) {
        files.push({
            localPath:   LOCALE_JSON,
            s3Key:       s3Key('locale-online.json'),
            contentType: 'application/json',
        });
    } else {
        console.warn(`[upload-cdn] ⚠  locale-online.json không tồn tại.`);
        console.warn(`              Chạy "node tools/convert-localization-xlsx.js <xlsx>" trước.`);
    }

    return files;
}

// ─── UPLOAD ──────────────────────────────────────────────────────────────────

async function uploadFile(client, { localPath, s3Key: key, contentType }) {
    const body = fs.readFileSync(localPath);
    const size = (body.length / 1024).toFixed(1);

    if (DRY_RUN) {
        console.log(`[dry-run] s3://${BUCKET}/${key}  (${size} KB)`);
        return;
    }

    await client.send(new PutObjectCommand({
        Bucket:       BUCKET,
        Key:          key,
        Body:         body,
        ContentType:  contentType,
        // Cache-Control: fonts không đổi nhiều → cache dài; JSON cập nhật thường xuyên hơn
        CacheControl: contentType === 'application/json'
            ? 'public, max-age=300, stale-while-revalidate=60'
            : 'public, max-age=31536000, immutable',
    }));

    console.log(`[upload-cdn] ✅ ${key}  (${size} KB)`);
}

async function main() {
    const files = collectFiles();

    if (files.length === 0) {
        console.warn('[upload-cdn] Không có file nào để upload.');
        process.exit(0);
    }

    console.log(`\n[upload-cdn] Sẽ upload ${files.length} file lên s3://${BUCKET}/${PREFIX || '(root)'}`);
    if (DRY_RUN) {
        console.log('[upload-cdn] --- DRY RUN MODE ---\n');
    }

    const client = new S3Client({ region: REGION });

    let ok = 0;
    let fail = 0;

    for (const file of files) {
        try {
            await uploadFile(client, file);
            ok++;
        } catch (err) {
            console.error(`[upload-cdn] ❌ FAIL ${file.s3Key}: ${err.message}`);
            fail++;
        }
    }

    console.log(`\n[upload-cdn] Hoàn tất: ${ok} thành công, ${fail} thất bại.`);

    if (!DRY_RUN && ok > 0) {
        const base = PREFIX
            ? `https://<cloudfront-domain>/${PREFIX}`
            : `https://<cloudfront-domain>`;
        console.log(`\n★ URL CDN mẫu để dùng trong game:`);
        console.log(`  Locale JSON : ${base}/locale-online.json`);
        console.log(`  Font WOFF2  : ${base}/fonts/font_ko.woff2`);
        console.log(`\n★ Set trong LocalizationManager.ts:`);
        console.log(`  loadOnlineLocale('${base}/locale-online.json')`);
    }

    if (fail > 0) process.exit(1);
}

main().catch(err => {
    console.error('[upload-cdn] Fatal:', err);
    process.exit(1);
});
