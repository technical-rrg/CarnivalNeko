const fs = require('fs');
const path = require('path');

const prefab = fs.readFileSync('assets/bundle/Base.prefab', 'utf8');
const uuidToMeta = new Map();

function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.meta')) {
      try {
        const m = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (m.uuid) uuidToMeta.set(m.uuid, p);
        if (m.subMetas) {
          for (const v of Object.values(m.subMetas)) {
            if (v && v.uuid) uuidToMeta.set(v.uuid, p);
          }
        }
      } catch (_) {}
    }
  }
}
walk('assets');

const folderRefs = new Map();
const assetRefs = new Map();
const re = /"__uuid__":\s*"([^"]+)"/g;
let m;
while ((m = re.exec(prefab)) !== null) {
  const base = m[1].split('@')[0];
  const meta = uuidToMeta.get(m[1]) || uuidToMeta.get(base);
  if (!meta || !meta.includes('newAnimations')) continue;
  const rel = meta.replace(/\\/g, '/').replace(/\.meta$/, '');
  const folder = rel.split('newAnimations/')[1].split('/')[0];
  folderRefs.set(folder, (folderRefs.get(folder) || 0) + 1);
  assetRefs.set(rel, (assetRefs.get(rel) || 0) + 1);
}

function folderSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += folderSize(p);
    else if (/\.(png|jpg|jpeg|webp|prefab|mtl)$/i.test(e.name)) total += fs.statSync(p).size;
  }
  return total;
}

console.log('=== newAnimations in Base.prefab ===\n');
console.log('By subfolder (UUID ref count):');
[...folderRefs.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => {
    const sz = folderSize(path.join('assets/bundle/newAnimations', k));
    console.log(`  ${String(v).padStart(3)} refs  ${(sz / 1024).toFixed(0).padStart(5)} KB  ${k}`);
  });

console.log('\nTop referenced assets:');
[...assetRefs.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k.replace(/.*newAnimations\//, '')}`));

// Check importer types in newAnimations
const types = {};
walk('assets/bundle/newAnimations');
function walkTypes(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkTypes(p);
    else if (e.name.endsWith('.meta') && !e.name.endsWith('.prefab.meta') && !e.name.endsWith('.png.meta')) {
      try {
        const m = JSON.parse(fs.readFileSync(p, 'utf8'));
        types[m.importer] = (types[m.importer] || 0) + 1;
      } catch (_) {}
    }
  }
}
walkTypes('assets/bundle/newAnimations');
console.log('\nImporter types in newAnimations:');
Object.entries(types).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v}  ${k}`));
