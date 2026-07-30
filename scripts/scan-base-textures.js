const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'assets');
const PREFAB = path.join(ROOT, 'bundle', 'Base.prefab');

const uuidToMeta = new Map();

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.meta')) {
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
walk(ROOT);

const prefabJson = JSON.parse(fs.readFileSync(PREFAB, 'utf8'));
const prefab = fs.readFileSync(PREFAB, 'utf8');

// Build node id -> name map + spine node names
const nodeNames = new Map();
const spineRefs = [];
for (const obj of prefabJson) {
  if (obj && obj.__type__ === 'cc.Node' && obj._name) {
    nodeNames.set(obj.__id__, obj._name);
  }
  if (obj && obj.__type__ === 'sp.Skeleton' && obj._skeletonData) {
    const nodeId = obj.node && obj.node.__id__;
    spineRefs.push({
      node: nodeNames.get(nodeId) || `node#${nodeId}`,
      uuid: obj._skeletonData.__uuid__,
    });
  }
}

const uuidRe = /"__uuid__":\s*"([^"]+)"/g;
const uuids = new Set();
let m;
while ((m = uuidRe.exec(prefab)) !== null) {
  const raw = m[1];
  const base = raw.split('@')[0];
  uuids.add(raw);
  uuids.add(base);
}

function resolveAsset(uuid) {
  const base = uuid.split('@')[0];
  const metaPath = uuidToMeta.get(uuid) || uuidToMeta.get(base);
  if (!metaPath) return null;
  const assetPath = metaPath.replace(/\.meta$/, '');
  let type = 'unknown';
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    type = meta.importer || 'unknown';
  } catch (_) {}
  return { metaPath, assetPath, uuid: base, type };
}

function getFileSize(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    if (st.isDirectory()) {
      let total = 0;
      for (const f of fs.readdirSync(p)) total += getFileSize(path.join(p, f));
      return total;
    }
  } catch (_) {}
  return 0;
}

function getImageFiles(assetPath) {
  const images = [];
  if (!fs.existsSync(assetPath)) return images;
  const st = fs.statSync(assetPath);
  const isImg = (name) => /\.(png|jpg|jpeg|webp|bmp|tga)$/i.test(name);
  if (st.isFile()) {
    if (isImg(assetPath)) images.push(assetPath);
    else {
      // spine json -> sibling folder images
      const dir = path.dirname(assetPath);
      const base = path.basename(assetPath, path.extname(assetPath));
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isFile() && isImg(ent.name) && ent.name.startsWith(base)) {
          images.push(path.join(dir, ent.name));
        }
      }
    }
    return images;
  }
  function scan(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) scan(p);
      else if (isImg(ent.name)) images.push(p);
    }
  }
  scan(assetPath);
  return images;
}

function rel(p) {
  return path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/');
}

const results = [];
for (const uuid of uuids) {
  const info = resolveAsset(uuid);
  if (!info) continue;
  const imgs = getImageFiles(info.assetPath);
  if (imgs.length === 0) continue;
  const totalSize = imgs.reduce((s, f) => s + getFileSize(f), 0);
  results.push({
    uuid: info.uuid,
    type: info.type,
    asset: rel(info.assetPath),
    images: imgs.map(rel),
    totalSize,
    count: imgs.length,
  });
}

const byAsset = new Map();
for (const r of results) {
  const existing = byAsset.get(r.asset);
  if (!existing || r.totalSize > existing.totalSize) byAsset.set(r.asset, r);
}

const sorted = [...byAsset.values()].sort((a, b) => b.totalSize - a.totalSize);
const fmt = (n) => (n / 1024).toFixed(1) + ' KB';
const fmtMB = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

console.log('=== Heavy textures referenced by Base.prefab ===\n');
console.log('Unique image assets:', sorted.length);

const tiers = { critical: [], heavy: [], medium: [], light: [] };
for (const r of sorted) {
  if (r.totalSize >= 2 * 1024 * 1024) tiers.critical.push(r);
  else if (r.totalSize >= 500 * 1024) tiers.heavy.push(r);
  else if (r.totalSize >= 100 * 1024) tiers.medium.push(r);
  else tiers.light.push(r);
}

function printTier(label, items) {
  if (!items.length) return;
  const total = items.reduce((s, r) => s + r.totalSize, 0);
  console.log(`--- ${label} (${items.length} assets, ${fmtMB(total)}) ---`);
  for (const r of items) {
    const tag = r.type === 'spine-data' ? '[SPINE] ' : '';
    console.log(`  ${fmt(r.totalSize).padStart(10)}  ${tag}${r.asset}`);
    for (const img of r.images.sort((a, b) => getFileSize(path.join(__dirname, '..', b)) - getFileSize(path.join(__dirname, '..', a))).slice(0, 4)) {
      console.log(`             ${fmt(getFileSize(path.join(__dirname, '..', img))).padStart(10)}  ${path.basename(img)}`);
    }
  }
  console.log('');
}

printTier('CRITICAL >= 2MB', tiers.critical);
printTier('HEAVY 500KB-2MB', tiers.heavy);
printTier('MEDIUM 100KB-500KB', tiers.medium);

const allTotal = sorted.reduce((s, r) => s + r.totalSize, 0);
console.log('--- SUMMARY ---');
console.log('Total image payload (unique):', fmtMB(allTotal));
console.log('Unresolved UUIDs:', [...uuids].filter((u) => !resolveAsset(u)).length);

console.log('\n--- SPINE assets in Base.prefab ---');
for (const s of spineRefs) {
  const info = resolveAsset(s.uuid);
  if (!info) {
    console.log(`  ${s.node.padEnd(24)} UNRESOLVED ${s.uuid}`);
    continue;
  }
  const imgs = getImageFiles(info.assetPath);
  const size = imgs.reduce((n, f) => n + getFileSize(f), 0);
  console.log(`  ${s.node.padEnd(24)} ${fmt(size).padStart(10)}  ${rel(info.assetPath)}`);
}

