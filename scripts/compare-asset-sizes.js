const fs = require('fs');

function fmt(n) {
  return (n / 1024).toFixed(1) + 'KB';
}
function pct(a, b) {
  if (!b) return 'deleted';
  return ((1 - a / b) * 100).toFixed(0) + '%';
}
function stat(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

const items = [
  ['anim-logo.png', 2095367, stat('assets/bundle/newSpine/anim-logo/anim-logo.png')],
  ['anim-longspin.png', 3950314, stat('assets/bundle/newSpine/anim-longspin/anim-longspin.png')],
  ['Flash.png', 918802, stat('assets/bundle/newTextures/transition/Flash.png')],
  ['BG landscape', 3422360, stat('assets/bundle/newTextures/mainUI/Bg-maingame-landscape.jpg')],
  ['BG portrait', 3084761, stat('assets/bundle/newTextures/mainUI/Bg-maingame-portrait.jpg')],
  ['BG freespin landscape', 3283257, stat('assets/bundle/newTextures/mainUI/Bg-freespins-landscape.jpg')],
  ['BG freespin portrait', 3025656, stat('assets/bundle/newTextures/mainUI/Bg-freespins-portrait.jpg')],
  ['Group 87 2.png (removed from Base)', 443118, 0],
];

console.log('=== Image compression (git HEAD → hiện tại) ===\n');
console.log('Asset'.padEnd(34), 'Before'.padStart(9), 'Now'.padStart(9), 'Saved'.padStart(7));
for (const [name, before, now] of items) {
  console.log(name.padEnd(34), fmt(before).padStart(9), fmt(now).padStart(9), pct(now, before).padStart(7));
}

console.log('\n=== Base.prefab image deps ===');
console.log('Trước lazy-load BG:  ~13.1 MB (có landscape 3.3MB embed)');
console.log('Sau lazy-load BG:    ~9.44 MB (không còn BG trong Base)');
console.log('Boot tiết kiệm ngay: ~3.3 MB tại instantiate');
