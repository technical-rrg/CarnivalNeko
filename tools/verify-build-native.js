/**
 * verify-build-native.js
 *
 * Kiểm tra build Cocos có thiếu native texture (gây 404 trên web) hay không.
 *
 * Usage:
 *   node tools/verify-build-native.js
 *   node tools/verify-build-native.js --platform web-desktop
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const platformIdx = args.indexOf('--platform');
const platform = platformIdx !== -1 ? args[platformIdx + 1] : 'web-desktop';
const buildDirIdx = args.indexOf('--build-dir');
const BUILD_DIR = buildDirIdx !== -1
    ? path.resolve(args[buildDirIdx + 1])
    : path.resolve(__dirname, '..', 'build', platform);

const BUNDLE_DIR = path.join(BUILD_DIR, 'assets', 'MainBundle');

function walk(dir, filterFn, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p, filterFn, out);
        else if (filterFn(p, ent.name)) out.push(p);
    }
    return out;
}

function loadConfig(bundleDir) {
    const configDir = path.join(bundleDir);
    const configFile = fs.readdirSync(configDir).find((f) => f.startsWith('config.') && f.endsWith('.json'));
    if (!configFile) return null;
    return JSON.parse(fs.readFileSync(path.join(configDir, configFile), 'utf8'));
}

function main() {
    console.log('');
    console.log('Verify MainBundle native assets');
    console.log(`Build: ${BUILD_DIR}`);
    console.log('');

    if (!fs.existsSync(BUNDLE_DIR)) {
        console.error(`ERROR: MainBundle not found: ${BUNDLE_DIR}`);
        console.error('Build the project in Cocos Creator first.');
        process.exit(1);
    }

    const config = loadConfig(BUNDLE_DIR);
    if (!config) {
        console.error('ERROR: MainBundle config.*.json not found.');
        process.exit(1);
    }

    const bundleDir = BUNDLE_DIR;
    const importRoot = path.join(bundleDir, config.importBase || 'import');
    const nativeRoot = path.join(bundleDir, config.nativeBase || 'native');

    const imageImports = walk(importRoot, (_, name) => /^[0-9a-f]{9}\.[0-9a-f]+\.json$/i.test(name));

    const missing = [];
    for (const importPath of imageImports) {
        const base = path.basename(importPath).split('.')[0];
        const prefix = base.slice(0, 2);
        let needsNative = false;
        try {
            const data = JSON.parse(fs.readFileSync(importPath, 'utf8'));
            needsNative = Array.isArray(data)
                && data[1] === 0
                && data[0] === 1
                && data[3]
                && data[3][0] === 'cc.ImageAsset'
                && data[5]
                && data[5][0]
                && data[5][0].fmt === '0';
        } catch (_) {
            continue;
        }
        if (!needsNative) continue;

        const nativeMatches = walk(path.join(nativeRoot, prefix), (_, name) => name.startsWith(base + '.'), []);
        if (nativeMatches.length === 0) {
            const packKey = '0' + base.slice(1);
            const packIds = config.packs?.[packKey] || config.packs?.[base] || [];
            const samplePaths = packIds.slice(0, 3).map((id) => config.paths?.[id]?.[0]).filter(Boolean);
            missing.push({
                hash: base,
                import: path.relative(bundleDir, importPath).replace(/\\/g, '/'),
                samples: samplePaths,
            });
        }
    }

    if (missing.length === 0) {
        console.log('OK: All ImageAsset native files are present.');
        process.exit(0);
    }

    console.error(`FAIL: Missing ${missing.length} native texture file(s):\n`);
    for (const item of missing) {
        console.error(`  - assets/MainBundle/native/${item.hash.slice(0, 2)}/${item.hash}.png`);
        console.error(`    import: assets/MainBundle/${item.import}`);
        if (item.samples.length) {
            console.error(`    atlas : ${item.samples.join(', ')}${item.samples.length < 3 ? '' : ' ...'}`);
        }
        console.error('');
    }

    console.error('Likely cause: auto-atlas packed textures were not exported to native/ during build.');
    console.error('Fix:');
    console.error('  1. Close Cocos Creator');
    console.error('  2. Delete folders: build, library, temp');
    console.error('  3. Reopen project, Reimport auto-atlas.pac files');
    console.error('  4. Build Web again, then rerun this script');
    process.exit(1);
}

main();
