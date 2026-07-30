'use strict';

/**
 * font-tools — Cocos Creator 3.x Editor Extension
 *
 * Chạy tools/subset-fonts.js ngay trong Editor để:
 *   • Tạo subset TTF → assets/Font/{lang}-subset.ttf  (drag vào FontManager)
 *   • Tạo subset WOFF2 → build/fonts/font_{lang}.woff2 (web deployment)
 *
 * Yêu cầu: pip install fonttools brotli
 *
 * Để Enable: Extensions → Extension Manager → bật "font-tools"
 * Để dùng:   Extensions → 🔤 Subset Fonts
 */

const path = require('path');
const fs   = require('fs');
const { execFile, exec } = require('child_process');

// ─── Extension lifecycle ──────────────────────────────────────────────────────

let projectRoot = '';

exports.load = function () {
    projectRoot = path.join(__dirname, '..', '..');
    console.log('[FontTools] Loaded. Project root:', projectRoot);
};

exports.unload = function () {};

// ─── Message handler ──────────────────────────────────────────────────────────

exports.methods = {
    subsetFonts() {
        _ensurePyftsubsetThenRun();
    },
};

// ─── Orchestrator ─────────────────────────────────────────────────────────────

function _ensurePyftsubsetThenRun() {
    // 1. Thử tìm pyftsubset qua nhiều cách (bỏ qua PATH stale của Cocos Creator)
    findPyftsubsetDir((scriptsDir) => {
        if (scriptsDir) {
            console.log('[FontTools] pyftsubset found at:', scriptsDir);
            _runSubsetFonts(scriptsDir);
            return;
        }

        // 2. Chưa cài — tự động chạy pip install
        console.log('[FontTools] pyftsubset chưa được cài — đang chạy pip install tự động...');
        exec('pip install fonttools brotli', { cwd: projectRoot }, (pipErr, _pipOut, pipStderr) => {
            if (pipErr) {
                Editor.Dialog.error(
                    `Tự động cài đặt thất bại:\n${(pipStderr || pipErr.message).trim()}\n\nCài đặt thủ công:\n  pip install fonttools brotli`,
                    { title: 'Font Tools — Lỗi' }
                );
                return;
            }
            console.log('[FontTools] pip install fonttools brotli hoàn tất.');

            // 3. Tìm lại sau khi cài đặt
            findPyftsubsetDir((scriptsDir2) => {
                if (!scriptsDir2) {
                    Editor.Dialog.error(
                        'Đã cài đặt nhưng không tìm thấy pyftsubset.\nThử khởi động lại Cocos Creator.',
                        { title: 'Font Tools — Lỗi' }
                    );
                    return;
                }
                _runSubsetFonts(scriptsDir2);
            });
        });
    });
}

// ─── Run subset-fonts.js với PATH augmented ───────────────────────────────────

function _runSubsetFonts(extraPathDir) {
    const scriptPath = path.join(projectRoot, 'tools', 'subset-fonts.js');
    if (!fs.existsSync(scriptPath)) {
        Editor.Dialog.error(
            `Không tìm thấy script:\n${scriptPath}`,
            { title: 'Font Tools — Lỗi' }
        );
        return;
    }

    Editor.Dialog.info(
        'Đang subset fonts...\n\nQuá trình có thể mất 10-30 giây.\nKiểm tra Console để xem tiến trình.',
        { title: 'Font Tools' }
    );
    console.log('[FontTools] ▶ Starting font subset... (extraPath:', extraPathDir || 'none', ')');

    // Inject thư mục chứa pyftsubset vào PATH để subset-fonts.js cũng tìm thấy
    const env = extraPathDir
        ? { ...process.env, PATH: extraPathDir + path.delimiter + (process.env.PATH || '') }
        : process.env;

    const node = process.execPath;
    execFile(node, [scriptPath], { cwd: projectRoot, env }, (err, stdout, stderr) => {
        if (stdout) console.log('[FontTools]', stdout);
        if (stderr) console.warn('[FontTools] stderr:', stderr);

        if (err && err.code !== 0) {
            const errLines = (stderr || stdout || err.message)
                .split('\n')
                .filter(l => l.includes('✗') || l.toLowerCase().includes('error'))
                .slice(0, 5)
                .join('\n');

            Editor.Dialog.error(
                `Subset fonts thất bại!\n\n${errLines || err.message}\n\nXem Console để biết chi tiết.`,
                { title: 'Font Tools — Lỗi' }
            );
            return;
        }

        const fontDir  = path.join(projectRoot, 'assets', 'Font');
        const subsetFiles = fs.existsSync(fontDir)
            ? fs.readdirSync(fontDir).filter(f => f.endsWith('-subset.ttf'))
            : [];

        const buildDir = path.join(projectRoot, 'build', 'fonts');
        const woff2Files = fs.existsSync(buildDir)
            ? fs.readdirSync(buildDir).filter(f => f.endsWith('.woff2'))
            : [];

        const debugFile = path.join(buildDir, 'text_debug.txt');
        const hasDebug  = fs.existsSync(debugFile);

        Editor.Dialog.info(
            `✅ Subset fonts hoàn tất!\n\n` +
            `📁 assets/Font/  →  ${subsetFiles.length} file TTF subset:\n` +
            subsetFiles.map(f => `   • ${f}`).join('\n') +
            `\n\n📁 build/fonts/  →  ${woff2Files.length} file WOFF2 (web)` +
            (hasDebug ? '\n\n📄 text_debug.txt đã được tạo' : '') +
            `\n\n➡ Bước tiếp theo:\n` +
            `   Mở Inspector của FontManager node\n` +
            `   Drag các file *-subset.ttf vào đúng slot ngôn ngữ`,
            { title: 'Font Tools — Hoàn tất' }
        );

        console.log('[FontTools] ✓ Done.');

        if (Editor.Message) {
            Editor.Message.send('asset-db', 'refresh-asset', `db://assets/Font`);
        }
    });
}

// ─── Helper: tìm thư mục chứa pyftsubset qua nhiều phương pháp ──────────────
//
// Trả về thư mục (string) hoặc null nếu fonttools chưa được cài.

function findPyftsubsetDir(callback) {
    const pyScript = [
        'import shutil,os,sys;',
        'p=shutil.which("pyftsubset");',
        'd=os.path.dirname(sys.executable);',
        'win=os.path.join(d,"Scripts","pyftsubset.exe");',
        'u=os.path.join(d,"bin","pyftsubset");',
        'found=p or (win if os.path.exists(win) else None) or (u if os.path.exists(u) else None);',
        'print(os.path.dirname(found) if found else "")',
    ].join('');

    const methods = [];

    // 1. python
    methods.push((cb) => {
        execFile('python', ['-c', pyScript], (err, stdout) => cb(err, stdout));
    });

    // 2. py (Windows launcher)
    methods.push((cb) => {
        execFile('py', ['-c', pyScript], (err, stdout) => cb(err, stdout));
    });

    // 3. python3
    methods.push((cb) => {
        execFile('python3', ['-c', pyScript], (err, stdout) => cb(err, stdout));
    });

    // 4. where / which (shell)
    methods.push((cb) => {
        const cmd = process.platform === 'win32' ? 'where pyftsubset' : 'which pyftsubset';
        exec(cmd, (err, stdout) => cb(err, stdout));
    });

    let i = 0;
    function next() {
        if (i >= methods.length) {
            callback(null);
            return;
        }
        methods[i++]((err, stdout) => {
            if (!err && stdout) {
                const dir = _extractPyftsubsetDir(stdout.trim());
                if (dir) { callback(dir); return; }
            }
            next();
        });
    }
    next();
}

/** Trích xuất thư mục từ output của where/which hoặc Python script */
function _extractPyftsubsetDir(raw) {
    if (!raw) return null;
    const line = raw.split('\n')[0].trim();
    if (!line) return null;
    // Nếu là đường dẫn file (where/which), lấy dirname
    const lower = line.toLowerCase();
    if (lower.endsWith('pyftsubset.exe') || lower.endsWith('pyftsubset')) {
        return path.dirname(line);
    }
    // Nếu đã là thư mục từ Python script
    if (fs.existsSync(line) && fs.statSync(line).isDirectory()) {
        const hasExe = fs.existsSync(path.join(line, 'pyftsubset.exe'));
        const hasBin = fs.existsSync(path.join(line, 'pyftsubset'));
        if (hasExe || hasBin) return line;
    }
    // Fallback: line chính là thư mục (Python script trả về dirname)
    return line;
}
