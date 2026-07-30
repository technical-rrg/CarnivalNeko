/**
 * serve-build.js — Local server để test build đã nén (.gz / .br)
 *
 * Sử dụng:
 *   node tools/serve-build.js
 *   node tools/serve-build.js --platform web-mobile
 *   node tools/serve-build.js --port 8080
 *
 * Rồi mở: http://localhost:3000
 *
 * Server tự ưu tiên: .br → .gz → file gốc
 * Đặt đúng Content-Encoding + Content-Type cho từng file.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Config ────────────────────────────────────────────────
const args        = process.argv.slice(2);
const portIdx     = args.indexOf('--port');
const PORT        = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3000;
const platformIdx = args.indexOf('--platform');
const platform    = platformIdx !== -1 ? args[platformIdx + 1] : 'web-desktop';
const buildDirIdx = args.indexOf('--build-dir');
const BUILD_DIR   = buildDirIdx !== -1
    ? path.resolve(args[buildDirIdx + 1])
    : path.resolve(__dirname, '..', 'build', platform);

// ─── MIME types ────────────────────────────────────────────
const MIME = {
    '.html' : 'text/html; charset=utf-8',
    '.js'   : 'application/javascript',
    '.json' : 'application/json',
    '.css'  : 'text/css',
    '.png'  : 'image/png',
    '.jpg'  : 'image/jpeg',
    '.jpeg' : 'image/jpeg',
    '.webp' : 'image/webp',
    '.gif'  : 'image/gif',
    '.ico'  : 'image/x-icon',
    '.ttf'  : 'font/ttf',
    '.woff' : 'font/woff',
    '.woff2': 'font/woff2',
    '.wav'  : 'audio/wav',
    '.mp3'  : 'audio/mpeg',
    '.ogg'  : 'audio/ogg',
    '.atlas': 'text/plain',
    '.bin'  : 'application/octet-stream',
    '.wasm' : 'application/wasm',
};

// ─── Server ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    // Decode URL, strip query string
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(BUILD_DIR, urlPath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    // Check Accept-Encoding từ browser
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const supportsBrotli = acceptEncoding.includes('br');
    const supportsGzip   = acceptEncoding.includes('gzip');

    // Tìm file phù hợp theo thứ tự ưu tiên: .br → .gz → gốc
    let servePath    = filePath;
    let encoding     = null;

    if (supportsBrotli && fs.existsSync(filePath + '.br')) {
        servePath = filePath + '.br';
        encoding  = 'br';
    } else if (supportsGzip && fs.existsSync(filePath + '.gz')) {
        servePath = filePath + '.gz';
        encoding  = 'gzip';
    }

    // Kiểm tra file tồn tại
    if (!fs.existsSync(servePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404 Not Found: ${urlPath}`);
        return;
    }

    // Headers
    const headers = {
        'Content-Type'                : contentType,
        'Access-Control-Allow-Origin' : '*',
        'Cache-Control'               : 'no-cache',   // test mode — không cache
    };
    if (encoding) headers['Content-Encoding'] = encoding;

    // Serve
    res.writeHead(200, headers);
    fs.createReadStream(servePath).pipe(res);

    // Log
    const label = encoding ? `[${encoding.toUpperCase()}]` : '[raw]  ';
    const size  = fs.statSync(servePath).size;
    console.log(`  ${label} ${urlPath.padEnd(70)} ${formatBytes(size)}`);
});

function formatBytes(b) {
    if (b < 1024)      return b + ' B';
    if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
    return (b/1024/1024).toFixed(2) + ' MB';
}

server.listen(PORT, () => {
    console.log('');
    console.log('══════════════════════════════════════════════════');
    console.log('  Local Build Server — Compressed Asset Test');
    console.log('══════════════════════════════════════════════════');
    console.log(`  Build dir : ${BUILD_DIR}`);
    console.log(`  URL       : http://localhost:${PORT}`);
    console.log(`  Platform  : ${platform}`);
    console.log('');
    console.log('  Browser sẽ nhận: Brotli → Gzip → Raw (ưu tiên theo thứ tự)');
    console.log('  Ctrl+C để dừng server');
    console.log('══════════════════════════════════════════════════');
    console.log('');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} đang bị chiếm. Thử: node tools/serve-build.js --port 8080`);
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
});
