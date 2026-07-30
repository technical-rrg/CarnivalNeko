param(
    [string]$Platform = "web-desktop",
    [string]$SplashImage = "splash-logo.png"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path $PSScriptRoot -Parent
$buildDir    = Join-Path $projectRoot "build\$Platform"
$indexPath   = Join-Path $buildDir "index.html"

if (-not (Test-Path $indexPath)) {
    Write-Error "Build output not found: $indexPath"
    exit 1
}

$splashSrc = Join-Path $projectRoot "build-templates\$Platform\$SplashImage"
if (Test-Path $splashSrc) {
    Copy-Item $splashSrc (Join-Path $buildDir $SplashImage) -Force
    Write-Host "[PATCH] Copied $SplashImage"
}

$html = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)

# Fix title: remove "Cocos Creator | " prefix and set game name
$gameTitle = 'Fortune of Ra - Secret Treasure'
$html = $html -replace '<title>Cocos Creator \| ', '<title>'
$html = $html -replace '<title>[^<]*</title>', "<title>$gameTitle</title>"
$html = $html -replace '<h1([^>]*class="header"[^>]*)>[^<]*</h1>', "<h1`$1>$gameTitle</h1>"

if ($html.Contains('id="splash-overlay"')) {
    Write-Host "[PATCH] Already patched, skipping."
    exit 0
}

$NL = [System.Environment]::NewLine

$css = '    <style id="splash-style">
      #GameDiv { position: relative; }
      #splash-overlay {
        position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        background: #000; display: flex; flex-direction: column;
        justify-content: center; align-items: center;
        z-index: 9999; pointer-events: none; }
      #splash-logo { max-width: 280px; max-height: 160px; margin-bottom: 32px;
        animation: splash-breathe 1.8s ease-in-out infinite; }
      @keyframes splash-breathe {
        0%,100%{ transform:scale(1); opacity:0.9; }
        50%{ transform:scale(1.04); opacity:1; } }
      #splash-bar-track { width:220px; height:4px;
        background:rgba(255,255,255,0.12); border-radius:2px; overflow:hidden; }
      #splash-bar { width:0%; height:100%;
        background:linear-gradient(90deg,#f7971e,#ffd200);
        border-radius:2px; transition:width 0.3s ease; }
      #splash-text { color:rgba(255,255,255,0.45); font-family:Arial,sans-serif;
        font-size:12px; margin-top:14px; }
    </style>'

$html = $html.Replace('</head>', $css + $NL + '  </head>')

$splashDiv = '      <div id="splash-overlay">
        <img id="splash-logo" src="IMGNAME" alt="" onerror="this.style.display=''none''"/>
        <div id="splash-bar-track"><div id="splash-bar"></div></div>
        <div id="splash-text">Loading...</div>
      </div>'
$splashDiv = $splashDiv.Replace('IMGNAME', $SplashImage)

$canvasIdx = $html.IndexOf('</canvas>')
if ($canvasIdx -ge 0) {
    $divIdx = $html.IndexOf('</div>', $canvasIdx)
    if ($divIdx -ge 0) {
        $insertAt = $divIdx + 6
        $html = $html.Substring(0, $insertAt) + $NL + $splashDiv + $html.Substring($insertAt)
    }
}

$js = '<script>
(function(){
  var bar=document.getElementById("splash-bar");
  var overlay=document.getElementById("splash-overlay");
  if(!bar||!overlay) return;
  var progress=0,checkReady;
  var timer=setInterval(function(){
    progress+=(90-progress)*0.03;
    bar.style.width=Math.min(progress,90)+"%";
  },50);
  window.__removeSplash=function(){
    clearInterval(timer);clearInterval(checkReady);
    bar.style.width="100%";
    setTimeout(function(){
      overlay.style.transition="opacity 0.4s ease";
      overlay.style.opacity="0";
      setTimeout(function(){if(overlay.parentNode)overlay.remove();},500);
    },200);
  };
  checkReady=setInterval(function(){
    try{if(window.cc&&window.cc.director&&window.cc.director.getScene())window.__removeSplash();}catch(e){}
  },150);
  setTimeout(function(){
    clearInterval(timer);clearInterval(checkReady);
    if(overlay&&overlay.parentNode){
      overlay.style.transition="opacity 0.4s ease";overlay.style.opacity="0";
      setTimeout(function(){if(overlay.parentNode)overlay.remove();},500);
    }
  },15000);
})();
</script>'

$html = $html.Replace('</body>', $js + $NL + '</body>')

[System.IO.File]::WriteAllText($indexPath, $html, [System.Text.Encoding]::UTF8)
Write-Host "[PATCH] OK: Splash injected into $indexPath"
