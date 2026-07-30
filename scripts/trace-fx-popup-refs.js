const fs = require('fs');
const path = require('path');

const PREFAB = 'assets/bundle/Base.prefab';
const TARGET = 'newAnimations/fx-popup';

const uuidToInfo = new Map();

function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.meta')) {
      try {
        const m = JSON.parse(fs.readFileSync(p, 'utf8'));
        const rel = p.replace(/\\/g, '/').replace(/\.meta$/, '');
        if (!rel.includes(TARGET)) continue;
        if (m.uuid) {
          uuidToInfo.set(m.uuid, { rel, type: m.importer || 'asset' });
        }
        if (m.subMetas) {
          for (const v of Object.values(m.subMetas)) {
            if (v?.uuid) uuidToInfo.set(v.uuid, { rel, type: v.importer || 'sub' });
          }
        }
      } catch (_) {}
    }
  }
}
walk('assets');

const prefab = JSON.parse(fs.readFileSync(PREFAB, 'utf8'));

// Build node id -> name, parent chain
const nodes = new Map();
const comps = new Map();
for (const obj of prefab) {
  if (!obj || obj.__id__ == null) continue;
  if (obj.__type__ === 'cc.Node') {
    nodes.set(obj.__id__, {
      name: obj._name || '',
      parent: obj._parent?.__id__,
      active: obj._active,
      components: (obj._components || []).map((c) => c.__id__),
    });
  } else {
    comps.set(obj.__id__, obj);
  }
}

function nodePath(id) {
  const parts = [];
  let cur = id;
  let guard = 0;
  while (cur != null && guard++ < 50) {
    const n = nodes.get(cur);
    if (!n) break;
    parts.unshift(n.name || `#${cur}`);
    cur = n.parent;
  }
  return parts.join(' / ');
}

function findNodeForComp(compId) {
  for (const [nid, n] of nodes) {
    if (n.components.includes(compId)) return nid;
  }
  return null;
}

// Find all UUID refs to fx-popup assets
const hits = [];
const prefabStr = fs.readFileSync(PREFAB, 'utf8');
const re = /"__uuid__":\s*"([^"]+)"/g;
let m;
while ((m = re.exec(prefabStr)) !== null) {
  const raw = m[1];
  const base = raw.split('@')[0];
  const info = uuidToInfo.get(raw) || uuidToInfo.get(base);
  if (!info) continue;
  hits.push({ uuid: raw, asset: info.rel.replace(/.*newAnimations\//, 'fx-popup/') });
}

// Dedupe by uuid, count occurrences
const byUuid = new Map();
for (const h of hits) {
  const key = h.uuid;
  if (!byUuid.has(key)) byUuid.set(key, { ...h, count: 0 });
  byUuid.get(key).count++;
}

console.log('=== fx-popup UUID refs in Base.prefab ===\n');
console.log('Total UUID occurrences:', hits.length);
console.log('Unique fx-popup assets referenced:\n');
[...byUuid.values()]
  .sort((a, b) => b.count - a.count)
  .forEach((x) => console.log(`  ${String(x.count).padStart(3)}x  ${x.asset}`));

// Find ParticleSystem / Material refs
console.log('\n=== Components using fx-popup assets ===\n');
const compHits = new Map();

function scanObj(obj, compId, pathKeys = '') {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => scanObj(v, compId, `${pathKeys}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__uuid__' && typeof v === 'string') {
      const base = v.split('@')[0];
      const info = uuidToInfo.get(v) || uuidToInfo.get(base);
      if (info) {
        const nodeId = findNodeForComp(compId);
        const key = `${obj.__type__ || 'unknown'} @ ${nodePath(nodeId)}`;
        if (!compHits.has(key)) compHits.set(key, { type: obj.__type__, node: nodePath(nodeId), assets: new Set(), count: 0 });
        compHits.get(key).count++;
        compHits.get(key).assets.add(info.rel.split('/').pop());
      }
    } else if (typeof v === 'object') {
      scanObj(v, compId, `${pathKeys}.${k}`);
    }
  }
}

for (const [compId, comp] of comps) {
  if (!comp.__type__) continue;
  scanObj(comp, compId);
}

[...compHits.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .forEach(([key, v]) => {
    console.log(`${v.count} refs`);
    console.log(`  Node: ${v.node}`);
    console.log(`  Type: ${v.type}`);
    console.log(`  Assets: ${[...v.assets].join(', ')}`);
    console.log('');
  });

// List top-level nodes that contain fx-popup refs (aggregate by ancestor)
const nodeHits = new Map();
for (const [compId, comp] of comps) {
  let hasFx = false;
  const str = JSON.stringify(comp);
  for (const uuid of uuidToInfo.keys()) {
    if (str.includes(uuid)) { hasFx = true; break; }
  }
  if (!hasFx) continue;
  const nodeId = findNodeForComp(compId);
  if (nodeId == null) continue;
  // climb to meaningful parent (depth 3-5)
  let cur = nodeId;
  for (let i = 0; i < 4; i++) {
    const p = nodes.get(cur)?.parent;
    if (p == null) break;
    cur = p;
  }
  const p = nodePath(cur);
  nodeHits.set(p, (nodeHits.get(p) || 0) + 1);
}

console.log('=== Grouped by ancestor node (approx) ===\n');
[...nodeHits.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([p, c]) => console.log(`  ${String(c).padStart(3)} refs  ${p}`));
