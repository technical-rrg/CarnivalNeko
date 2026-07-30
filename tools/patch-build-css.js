/**
 * post-build CSS patch for super-html common builds
 *
 * Replaces the inline <style> block in all generated HTML files under
 * build/super-html/ with the correct CSS so the game fills the browser
 * window without scrollbars on any screen size.
 *
 * Root cause: design resolution 1920×1080 (fitHeight). On viewports narrower
 * than 16:9, or when cc_exact_fit_screen doesn't kick in fast enough, the
 * canvas overflows. Using position:fixed on #GameDiv + overflow:hidden ensures
 * the canvas is always clipped to the viewport and Cocos reads the right size.
 *
 * Usage:
 *   node tools/patch-build-css.js              → patch all platforms
 *   node tools/patch-build-css.js common        → patch only common/
 *   node tools/patch-build-css.js common google → patch multiple
 */

const fs   = require('fs');
const path = require('path');

// ─── Target CSS + resize JS (matches static/index.html template) ─────────────
const CORRECT_STYLE =
  'html{-ms-touch-action:none;width:100%;height:100%;overflow:hidden}' +
  'body,canvas,div{display:block;outline:0;-webkit-tap-highlight-color:transparent;' +
  'user-select:none;-moz-user-select:none;-webkit-user-select:none;' +
  '-ms-user-select:none;-khtml-user-select:none;-webkit-tap-highlight-color:transparent}' +
  'input::-webkit-inner-spin-button,input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}' +
  'body{position:fixed;top:0;left:0;width:100%;height:100%;padding:0;border:0;margin:0;overflow:hidden;' +
  'font-size:0;line-height:0;cursor:default;color:transparent;background-color:#000;text-align:center;' +
  'font-family:Helvetica,Verdana,Arial,sans-serif;display:flex;justify-content:center;align-items:center}' +
  'canvas{background-color:rgba(0,0,0,0)}' +
  '#GameDiv{overflow:hidden;flex-shrink:0}' +
  '#Cocos3dGameContainer{width:100%;height:100%;overflow:hidden}' +
  '#GameCanvas{width:100%;height:100%}';

// JS resize handler injected right after </style>
// Supports both landscape (16:9 → 1920×1080) and portrait (9:16 → 1080×1920).
// On portrait phones the GameDiv is sized to the 9:16 ratio so Cocos draws at
// 1080×1920 instead of squeezing the landscape canvas into the portrait viewport.
const RESIZE_SCRIPT =
  '<script type="text/javascript">' +
  '(function(){' +
  'var R_LAND=16/9,R_PORT=9/16;' +
  'function fit(){' +
  'var vw=window.innerWidth,vh=window.innerHeight,w,h;' +
  'var R=vh>vw?R_PORT:R_LAND;' +
  'if(vw/vh>R){h=vh;w=Math.round(vh*R);}else{w=vw;h=Math.round(vw/R);}' +
  "var d=document.getElementById('GameDiv');" +
  "if(d){d.style.width=w+'px';d.style.height=h+'px';}}" +
  "document.addEventListener('DOMContentLoaded',fit);" +
  "window.addEventListener('resize',fit);" +
  "window.addEventListener('orientationchange',function(){setTimeout(fit,200);});" +
  "}());</" + 'script>';

const CORRECT_BLOCK = `<style>${CORRECT_STYLE}</style>\n${RESIZE_SCRIPT}`;

// Sentinel: unique string only present after our patch
const PATCH_SENTINEL = "d.style.width=w+'px';";

// ─── Regex to match the entire <style>…</style> block (+ optional previous resize script) ──
// The block is on a single line in super-html output.
const STYLE_BLOCK_RE = /<style>[\/\s\S]*?<\/style>(?:\s*<script[^>]*>[\s\S]*?d\.style\.width[\s\S]*?<\/script>)?/;

// ─── Web-desktop override CSS (injected into <head> to override external CSS) ─
const WEB_DESKTOP_OVERRIDE_CSS =
  'html{overflow:hidden;width:100%;height:100%}' +
  'body{position:fixed!important;top:0!important;left:0!important;width:100%!important;height:100%!important;' +
  'padding:0!important;border:0!important;margin:0!important;overflow:hidden!important;' +
  'background-color:#000!important;display:flex!important;justify-content:center!important;align-items:center!important}' +
  '.header,.footer{display:none!important}' +
  '#GameDiv{overflow:hidden!important;flex-shrink:0!important;border:none!important;' +
  'border-radius:0!important;box-shadow:none!important}' +
  '#Cocos3dGameContainer,#GameCanvas{width:100%!important;height:100%!important}';

const WEB_DESKTOP_INJECT = `<style>${WEB_DESKTOP_OVERRIDE_CSS}</style>\n${RESIZE_SCRIPT}`;

// ─── HTML Loading Overlay (web-desktop) ──────────────────────────────────────
// 2 ảnh loading-gif.gif và loading-logo.png đặt cùng thư mục index.html.
// Đối tác thay 2 file này để tuỳ chỉnh — không cần sửa code.
// overlay là transparent nên canvas Cocos hiện xuyên qua, 2 ảnh float phía trên.
// Khi game ready, LoadingController gọi window.snHideLoadingOverlay() → fade out.
// Vị trí khớp Cocos canvas 1920×1080 (gốc tâm, Y hướng lên):
//   GIF  (0,  136) → top = (540-136)/1080 = 37.4%
//   Logo (0, -245) → top = (540+245)/1080 = 72.7%
const LOADING_OVERLAY_STYLE =
  '#sn-loading-overlay{' +
    'position:fixed;inset:0;z-index:9999;background:transparent;' +
    'pointer-events:none;transition:opacity 0.5s ease' +
  '}' +
  '#sn-loading-overlay.hidden{opacity:0}' +
  '#sn-loading-gif,#sn-loading-logo{opacity:0;object-fit:contain}';

const LOADING_OVERLAY_SCRIPT =
  '<script type="text/javascript">' +
  'window.snHideLoadingOverlay=function(){' +
    "var o=document.getElementById('sn-loading-overlay');" +
    'if(!o)return;' +
    "o.style.transition='none';" +
    "o.style.opacity='0';" +
    "o.classList.add('hidden');" +
    "o.addEventListener('transitionend',function(){if(o.parentNode)o.parentNode.removeChild(o);},{once:true});" +
    'setTimeout(function(){if(o.parentNode)o.parentNode.removeChild(o);},800);' +
  '};' +
  '</' + 'script>';

// Early-init script: positions overlay images using same fit() logic as runtime sync,
// runs synchronously right after overlay div → zero visible time with CSS fallback.
// Node data: [worldCenterX, worldCenterY, designW, designH, displayScale]
//   GIF  (0,  136.2) → worldCenter=(960, 676.2),   size=375×292, scale=1.5
//   Logo (0, -242.059)→ worldCenter=(960, 297.941), size=290×150, scale=1
const LOADING_INIT_SCRIPT =
  '<script type="text/javascript">' +
  '(function(){' +
  'var DW=1920,DH=1080,' +
  "imgs={'sn-loading-gif':[960,714,375,292,1.5],'sn-loading-logo':[960,297.941,290,150,1]};" +
  'function pos(){' +
    'var vw=window.innerWidth,vh=window.innerHeight,R=vh>vw?9/16:16/9,cw,ch;' +
    'if(vw/vh>R){ch=vh;cw=vh*R;}else{cw=vw;ch=vw/R;}' +
    'var ox=(vw-cw)/2,oy=(vh-ch)/2;' +
    'for(var id in imgs){' +
      'var n=imgs[id],el=document.getElementById(id);' +
      'if(!el)continue;' +
      'var ew=n[2]/DW*cw*n[4],eh=n[3]/DH*ch*n[4],lx=ox+n[0]/DW*cw,ty=oy+(1-n[1]/DH)*ch;' +
      "el.style.cssText='position:fixed;opacity:0;width:'+ew+'px;height:'+eh+'px;left:'+lx+'px;top:'+ty+'px;transform:translate(-50%,-50%);object-fit:contain;max-width:none;max-height:none;';" +
    '}' +
  '}' +
  'pos();' +
  "window.addEventListener('resize',pos);" +
  "window.addEventListener('orientationchange',function(){setTimeout(pos,200);});" +
  '}());' +
  '</' + 'script>';

const LOADING_OVERLAY_HTML =
  '<div id="sn-loading-overlay">' +
    '<img id="sn-loading-gif"  src="https://downloads.realreelsgaming.com/Icons/rrlogo.png"         alt="Loading" onerror="this.style.display=\'none\'"/>' +
    '<img id="sn-loading-logo" src="https://downloads.realreelsgaming.com/Icons/rrlogo_text.png" alt="Logo"    onerror="this.style.display=\'none\'"/>' +
  '</div>';

// Sentinel để tránh inject 2 lần
const OVERLAY_SENTINEL = 'sn-loading-overlay';

// ─── Custom Favicon ──────────────────────────────────────────────────────────
// Place your icon at: tools/favicon.png (or .ico, .svg)
// The tool reads it at startup, converts to base64 data URL, and injects into
// all built HTML files. Works for both web-desktop and super-html (single-file).
//
// Supported formats: .png, .ico, .svg, .jpg, .jpeg, .gif, .webp
// Recommended: 64×64 or 128×128 PNG with transparency.

const FAVICON_SEARCH_NAMES = ['favicon.png', 'favicon.ico', 'favicon.svg', 'favicon.jpg', 'favicon.gif', 'favicon.webp'];
const MIME_MAP = { '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function buildFaviconLink() {
  for (const name of FAVICON_SEARCH_NAMES) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) {
      const ext = path.extname(name).toLowerCase();
      const mime = MIME_MAP[ext] || 'image/png';
      if (ext === '.svg') {
        // SVG: URL-encode (smaller & no base64 overhead)
        const svg = fs.readFileSync(p, 'utf-8').replace(/\n/g, '').replace(/\s{2,}/g, ' ');
        const encoded = encodeURIComponent(svg);
        console.log(`  [favicon] using custom SVG: tools/${name}`);
        return `<link rel="icon" type="${mime}" href="data:${mime},${encoded}">`;
      }
      // Binary formats: base64
      const b64 = fs.readFileSync(p).toString('base64');
      console.log(`  [favicon] using custom icon: tools/${name} (${(b64.length * 0.75 / 1024).toFixed(1)} KB)`);
      return `<link rel="icon" type="${mime}" href="data:${mime};base64,${b64}">`;
    }
  }
  // No custom icon found → no favicon link (browser shows default globe)
  console.log('  [favicon] no custom icon in tools/ → browser default globe');
  return null;
}

const CUSTOM_FAVICON_LINK = buildFaviconLink();
// Sentinel to detect our favicon has been injected (works for both custom & fallback)
const FAVICON_SENTINEL = CUSTOM_FAVICON_LINK ? 'data:image/' : null;

// ─── Game title ──────────────────────────────────────────────────────────────
const GAME_TITLE = 'Fortune of Ra - Secret Treasure';

function patchGameTitle(content) {
  let patched = content.replace(/<title>Cocos Creator \| /g, '<title>');
  patched = patched.replace(/<title>[^<]*<\/title>/i, `<title>${GAME_TITLE}</title>`);
  patched = patched.replace(
    /<h1(\s[^>]*class=["']header["'][^>]*)>[^<]*<\/h1>/i,
    `<h1$1>${GAME_TITLE}</h1>`
  );
  return patched;
}

function patchFavicon(content) {
  // Remove all existing favicon links
  let patched = content.replace(/\s*<link\s+rel=["'](?:shortcut\s+)?icon["'][^>]*>/gi, '');
  if (CUSTOM_FAVICON_LINK && (!FAVICON_SENTINEL || !patched.includes(FAVICON_SENTINEL))) {
    patched = patched.replace('</head>', `  ${CUSTOM_FAVICON_LINK}\n</head>`);
  }
  return patched;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const BUILD_DIR = path.resolve(__dirname, '../build');

function patchContent(content, filePath) {
  const contentWithTitle = patchGameTitle(content);
  const contentWithFavicon = patchFavicon(contentWithTitle);
  if (content.includes(PATCH_SENTINEL)) {
    if (contentWithFavicon !== content) {
      fs.writeFileSync(filePath, contentWithFavicon, 'utf-8');
      console.log(`  [title/favicon] ${path.relative(process.cwd(), filePath)}`);
    } else {
      console.log(`  [skip]    ${path.relative(process.cwd(), filePath)} (already patched)`);
    }
    return;
  }
  const patched = patchFavicon(content.replace(STYLE_BLOCK_RE, CORRECT_BLOCK));
  if (patched !== content) {
    fs.writeFileSync(filePath, patched, 'utf-8');
    console.log(`  [patched] ${path.relative(process.cwd(), filePath)}`);
  } else {
    console.log(`  [skip]    ${path.relative(process.cwd(), filePath)} (no <style> block found)`);
  }
}

function patchDir(dir) {
  if (!fs.existsSync(dir)) {
    console.warn(`  [warn] directory not found: ${dir}`);
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      patchDir(full);
    } else if (entry.endsWith('.html')) {
      patchFile(full);
    }
  }
}

// ─── Web-desktop specific patch ───────────────────────────────────────────────
// web-desktop uses an external CSS file + has fixed inline style on #GameDiv.
// Strategy: inject an override <style> block before </head> and strip the
// hardcoded inline style from #GameDiv so the resize script can control it.
function patchWebDesktopFile(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); }
  catch (e) { console.error(`  [error]   ${filePath}: ${e.message}`); return; }

  let patched = patchGameTitle(content);

  // 0b. Replace Cocos favicon with an inline globe favicon.
  // Deleting favicon.ico alone is not reliable because browsers cache /favicon.ico per URL.
  patched = patchFavicon(patched);

  // Remove the generated Cocos favicon file as well, so direct /favicon.ico requests cannot show it.
  const faviconPath = path.join(path.dirname(filePath), 'favicon.ico');
  if (fs.existsSync(faviconPath)) {
    fs.unlinkSync(faviconPath);
    console.log(`  [favicon] deleted ${faviconPath}`);
  }

  // CSS + resize patch — skip nếu đã patch (nhưng vẫn check title/favicon)
  if (content.includes(PATCH_SENTINEL) && content.includes(OVERLAY_SENTINEL)) {
    // Overlay already exists → update image src to new URLs
    patched = patched.replace(
      /<img id="sn-loading-gif"[^>]*>/,
      '<img id="sn-loading-gif"  src="https://downloads.realreelsgaming.com/Icons/rrlogo.png"         alt="Loading" onerror="this.style.display=\'none\'"/>'
    );
    patched = patched.replace(
      /<img id="sn-loading-logo"[^>]*>/,
      '<img id="sn-loading-logo" src="https://downloads.realreelsgaming.com/Icons/rrlogo_text.png" alt="Logo"    onerror="this.style.display=\'none\'"/>'
    );

    if (patched !== content) {
      fs.writeFileSync(filePath, patched, 'utf-8');
      console.log(`  [updated] ${path.relative(process.cwd(), filePath)} (overlay src updated)`);
    } else {
      console.log(`  [skip]    ${path.relative(process.cwd(), filePath)} (already patched)`);
    }
    return;
  }

  // 1. Remove hardcoded inline style from #GameDiv (e.g. style="width: 1920px; height: 1080px;")
  patched = patched.replace(/(<div\s+id="GameDiv"[^>]*?)\s+style="[^"]*"([^>]*>)/, '$1$2');

  // 2. Inject override <style> + resize script before </head>
  patched = patched.replace('</head>', `  ${WEB_DESKTOP_INJECT}\n  <style>${LOADING_OVERLAY_STYLE}</style>\n  ${LOADING_OVERLAY_SCRIPT}\n  </head>`);

  // 3. Inject HTML overlay div + hide script right after <body> opening tags
  if (!patched.includes(OVERLAY_SENTINEL)) {
    patched = patched.replace(
      /(<h1\s[^>]*class="header"[^>]*>.*?<\/h1>)/,
      `$1\n    ${LOADING_OVERLAY_HTML}\n    ${LOADING_INIT_SCRIPT}`
    );
  } else {
    // Overlay already exists → update image src to new URLs
    patched = patched.replace(
      /<img id="sn-loading-gif"[^>]*>/,
      '<img id="sn-loading-gif"  src="https://downloads.realreelsgaming.com/Icons/rrlogo.png"         alt="Loading" onerror="this.style.display=\'none\'"/>'
    );
    patched = patched.replace(
      /<img id="sn-loading-logo"[^>]*>/,
      '<img id="sn-loading-logo" src="https://downloads.realreelsgaming.com/Icons/rrlogo_text.png" alt="Logo"    onerror="this.style.display=\'none\'"/>'
    );
  }

  if (patched !== content) {
    fs.writeFileSync(filePath, patched, 'utf-8');
    console.log(`  [patched] ${path.relative(process.cwd(), filePath)}`);
  } else {
    console.log(`  [skip]    ${path.relative(process.cwd(), filePath)} (no changes made)`);
  }
}

function patchWebDesktopDir(dir) {
  if (!fs.existsSync(dir)) {
    console.warn(`  [warn] directory not found: ${dir}`);
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      patchWebDesktopDir(full);
    } else if (entry.endsWith('.html')) {
      patchWebDesktopFile(full);
    }
  }
}

function patchFile(filePath) {
  const stat = fs.statSync(filePath);
  const SIZE_LIMIT = 40 * 1024 * 1024; // 40 MB — read directly; above → streaming
  if (stat.size <= SIZE_LIMIT) {
    try {
      patchContent(fs.readFileSync(filePath, 'utf-8'), filePath);
    } catch (e) {
      console.error(`  [error]   ${filePath}: ${e.message}`);
    }
  } else {
    console.log(`  [large]   ${path.relative(process.cwd(), filePath)} (${(stat.size / 1e6).toFixed(1)} MB) — streaming`);
    patchLargeFile(filePath);
  }
}

/**
 * Streaming patch for very large HTML files (single-bundle > 40 MB).
 * The entire HTML including inline <style> is typically on very few lines;
 * we read in 8 MB chunks, locate the style block, patch it, write out.
 */
function patchLargeFile(filePath) {
  const tmpPath = filePath + '.patch.tmp';
  const CHUNK  = 8 * 1024 * 1024;
  const fd     = fs.openSync(filePath, 'r');
  const stat   = fs.statSync(filePath);
  const fdOut  = fs.openSync(tmpPath, 'w');

  let buf      = Buffer.alloc(CHUNK);
  let carry    = '';          // leftover between chunks (for tag spanning boundary)
  let patched  = false;
  let offset   = 0;

  while (offset < stat.size) {
    const bytesRead = fs.readSync(fd, buf, 0, CHUNK, offset);
    offset += bytesRead;
    let chunk = carry + buf.slice(0, bytesRead).toString('utf-8');
    carry = '';

    if (!patched) {
      if (chunk.includes(PATCH_SENTINEL)) {
        // Already patched in this chunk — write as-is
        patched = true;
        fs.writeSync(fdOut, Buffer.from(chunk, 'utf-8'));
        console.log(`  [skip-large] ${path.relative(process.cwd(), filePath)} (already patched)`);
        continue;
      }
      // Check if the style block might be split across chunk boundary
      const closeStyle = chunk.lastIndexOf('</style>');
      if (closeStyle === -1 && offset < stat.size) {
        // </style> not in this chunk yet — keep last 50 chars as carry for next round
        carry = chunk.slice(-50);
        chunk = chunk.slice(0, -50);
      } else {
        // Patch here
        const pChunk = chunk.replace(STYLE_BLOCK_RE, CORRECT_BLOCK);
        if (pChunk !== chunk) { patched = true; }
        fs.writeSync(fdOut, Buffer.from(pChunk, 'utf-8'));
        continue;
      }
    }
    fs.writeSync(fdOut, Buffer.from(chunk, 'utf-8'));
  }
  // Flush carry
  if (carry) fs.writeSync(fdOut, Buffer.from(carry, 'utf-8'));

  fs.closeSync(fd);
  fs.closeSync(fdOut);
  fs.renameSync(tmpPath, filePath);

  if (patched) {
    console.log(`  [patched-large] ${path.relative(process.cwd(), filePath)}`);
  } else {
    console.log(`  [skip-large]    ${path.relative(process.cwd(), filePath)} (no <style> found or already patched)`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
const targets = process.argv.slice(2);

if (targets.length === 0) {
  // Patch both super-html and web-desktop by default
  console.log(`Patching ALL platforms in:\n  ${BUILD_DIR}\n`);
  patchDir(path.join(BUILD_DIR, 'super-html'));
  patchWebDesktopDir(path.join(BUILD_DIR, 'web-desktop'));
} else {
  for (const t of targets) {
    if (t === 'web-desktop') {
      const dir = path.join(BUILD_DIR, t);
      console.log(`Patching: ${dir}`);
      patchWebDesktopDir(dir);
    } else if (t === 'super-html') {
      const dir = path.join(BUILD_DIR, t);
      console.log(`Patching: ${dir}`);
      patchDir(dir);
    } else {
      // backwards compat: treat as platform name under super-html
      const dir = path.join(BUILD_DIR, 'super-html', t);
      console.log(`Patching: ${dir}`);
      patchDir(dir);
    }
  }
}

console.log('\nDone.');
