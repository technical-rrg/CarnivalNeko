/**
 * LoadingController - Màn hình tải game (Loading View).
 *
 * ★ PREFAB MODE — Guide-first (GuideView.prefab tách riêng, KHÔNG chờ Base):
 *   1. onLoad: CDN ∥ MainBundle → preload guide frames + GuideView.prefab
 *   2. start: Login ∥ Guide frames ∥ GuideView.prefab
 *   3. → bar 100% → hiện GuideView.prefab → MỚI kick Base nền
 *   4. GUIDE_COMPLETE → await Base → GameRoot
 *
 * ★ TWO-SCENE MODE (legacy):
 *   - Điền targetScene, bật useScenePreload, bật handleServerLogin
 */

import { _decorator, Component, Node, ProgressBar, UIOpacity, tween, Tween, Vec3, Label, director, instantiate, assetManager, AssetManager, Prefab, game, UITransform, view } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { NetworkManager } from '../manager/NetworkManager';
import { WalletManager } from '../manager/WalletManager';
import { GameData } from '../data/GameData';
import { USE_REAL_API, ServerConfig } from '../data/ServerConfig';
import { CdnAssetManager } from '../core/CdnAssetManager';
import { LocalizationManager } from '../core/LocalizationManager';
import { FontManager } from '../manager/FontManager';
import { Log } from '../core/Logger';
import { DebugLanguageSwitcher } from './DebugLanguageSwitcher';
import { isEditorPreview } from '../core/DebugEnv';
import { GuideFrameLoader } from '../core/GuideFrameLoader';
import { GuideShellLoader } from '../core/GuideShellLoader';
import { GameEntryController } from './GameEntryController';

const { ccclass, property } = _decorator;

@ccclass('LoadingController')
export class LoadingController extends Component {

    @property({ type: Node, tooltip: 'Logo node của nhà phát triển (sẽ có hiệu ứng nhịp thở)' })
    logoNode: Node | null = null;

    @property({ type: ProgressBar, tooltip: 'Thanh loading bar (ProgressBar component)' })
    loadingBar: ProgressBar | null = null;

    @property({ type: UIOpacity, tooltip: 'UIOpacity của LoadingView để fade-out khi xong' })
    uiOpacity: UIOpacity | null = null;

    @property({ tooltip: 'Thời gian hiển thị 1% ban đầu (giây). 0 = không chờ, load prefab ngay.' })
    loadingDuration: number = 0;

    @property({ type: Label, tooltip: 'Note' })
    noteLabel: Label | null = null;

    // ─── TWO-SCENE LOADING MODE ───

    @property({
        tooltip: '[Two-scene mode] Tên scene game sẽ preload và chuyển sang (vd: "game").\n' +
                 'Để trống = chế độ một scene (LoadingController chỉ fade-out rồi emit LOADING_COMPLETE).'
    })
    targetScene: string = '';

    @property({
        tooltip: '[Two-scene mode] Khi true: dùng director.preloadScene() thay vì fake timer.\n' +
                 'Thanh loading sẽ phản ánh tiến độ tải asset thực tế (0→90%).\n' +
                 'Yêu cầu targetScene được điền.'
    })
    useScenePreload: boolean = false;

    @property({
        tooltip: '[Two-scene mode] Khi true: LoadingController tự gọi Login+Enter ở đây,\n' +
                 'không cần GameManager. Kết quả được lưu vào GameData để game scene đọc.\n' +
                 'Dùng khi loading.scene không có GameManager component.'
    })
    handleServerLogin: boolean = false;

    // ─── PREFAB MODE ───

    @property({
        tooltip: '[Prefab mode] Tên AssetBundle chứa prefab (vd: "prefabs").\n' +
                 'Phải khớp với tên bundle được đánh dấu isBundle trong Cocos Editor.',
    })
    gameBundleName: string = 'prefabs';

    @property({
        tooltip: '[Prefab mode] Tên prefab bên trong bundle (vd: "GameScene", không cần .prefab extension).\n' +
                 'Nếu set, LoadingController load bundle rồi instantiate prefab vào cùng scene.\n' +
                 'Hoạt động ở cả editor preview lẫn web build.\n' +
                 'Font sẽ không bị mất khi game start.\n' +
                 'Ưu tiên cao hơn targetScene khi cả hai đều được set.',
    })
    gamePrefabPath: string = '';

    @property({
        type: Node,
        tooltip: '[Prefab mode] Node parent để gắn gamePrefab vào.\n' +
                 'Thường là Canvas của loading.scene.\n' +
                 'Để trống = dùng scene root (director.getScene()).'
    })
    gameContainer: Node | null = null;

    @property({
        tooltip: '[Prefab mode] Phần trăm (0-1) khi bắt đầu load prefab ngay (mặc định 0.01 = 1%).\n' +
                 'Ví dụ: 0.01 = 1%, 0.05 = 5%'
    })
    prefabLoadPercent: number = 0.01;

    @property({
        tooltip: '[Prefab mode] Phần trăm (0-1) khi bar bắt đầu animate mượt mà sau khi prefab load xong (mặc định 0.02 = 2%).\n' +
                 'Ví dụ: 0.02 = 2%, 0.05 = 5%'
    })
    barFillStartPercent: number = 0.02;

    // ─── THREE-PHASE LOADING ───

    @property({
        tooltip: '[Three-phase] Bar dừng tại đây sau khi Login + CDN xong. (0-1, mặc định 0.33 = 33%)'
    })
    phaseLoginEnd: number = 0.33;

    @property({
        tooltip: '[Three-phase] Bar dừng tại đây sau khi load AssetBundle xong. (0-1, mặc định 0.66 = 66%)'
    })
    phaseBundleEnd: number = 0.66;

    @property({
        tooltip: '[Three-phase] Bar crawl tới đây (0-1) trong lúc Login ∥ Base ∥ GuideFrames chạy song song. Mặc định 0.99'
    })
    prePrefabBarEnd: number = 1;

    @property({
        tooltip: '[Three-phase] Giây crawl tối đa mỗi phase. 0 = không crawl, chờ Login+Base xong rồi fill ngay.'
    })
    phaseCrawlSecs: number = 0;

    @property({
        tooltip: 'Thời gian animate bar tới 100% (giây). 0 = snap ngay.'
    })
    barFillToFullSecs: number = 0;

    @property({
        tooltip: 'Giữ bar ở 100% (giây) trước GuideView. 0 = không chờ.'
    })
    barHoldAtFullSecs: number = 0;

    private _elapsed: number = 0;
    private _loadCb: (() => void) | null = null;
    /** Bar đã tới 1% (fake timer xong) - bắt đầu load prefab */
    private _barDone: boolean = false;
    /** Server đã trả ENTER_SUCCESS hoặc login done internally chưa */
    private _serverReady: boolean = false;
    /** 0→1%: Fake timer, 1%: Load prefab, 2→100%: Animate */
    private _preloadDone: boolean = false;
    /** Prefab Base đã sẵn (download + attach) — không còn gate bar 100% ở Guide-first */
    private _prefabReady: boolean = false;
    /** Guide frames + GuideView.prefab sẵn — gate bar 100% (Guide-first) */
    private _guideReady: boolean = false;
    /** Prefab asset đã load — dùng để instantiate ngay lập tức khi bar 100% */
    private _loadedPrefab: any = null;
    /** Bar đã animate từ 2% tới 100% chưa */
    private _animatingToFull: boolean = false;
    /** Symbols / heavy gate — Guide-first: nhả khi Guide shell sẵn */
    private _heavyInitDone: boolean = false;
    /** Node Base đã instantiate và ẩn sẵn */
    private _instantiatedGameNode: Node | null = null;

    /** Promise load font sớm từ onLoad() — để _loadCdnAssets() await thay vì tải lại */
    private _earlyFontPromise: Promise<import('cc').TTFFont | null> | null = null;
    /** CDN kick-off sớm từ onLoad — không block bundle/prefab */
    private _cdnPromise: Promise<void> | null = null;
    /** Bundle kick-off sớm — chạy song song với login */
    private _bundlePromise: Promise<AssetManager.Bundle | null> | null = null;
    /** Base.prefab asset download — kick ngay khi Bundle ready (chưa instantiate) */
    private _baseAssetPromise: Promise<Prefab | null> | null = null;
    /** Base instantiate + attach (internal — dùng bởi _ensureBaseReady) */
    private _basePromise: Promise<void> | null = null;
    /** Wrapper Base nền + post-hooks (warm GameRoot) — await khi Guide xong */
    private _baseBgPromise: Promise<void> | null = null;
    /** Guard: tránh fill bar 100% nhiều lần */
    private _fillStarted: boolean = false;
    /** Three-phase boot: đang crawl — hoãn _tryFillToFull đến khi crawl xong */
    private _bootCrawlActive: boolean = false;
    /** Đang chờ GUIDE_COMPLETE để attach Base / show GameRoot */
    private _awaitingGuideComplete: boolean = false;
    /** User đã Continue — giữ màn đen đến khi Base/GameRoot sẵn rồi mới FadeIn */
    private _holdingBlackForBase: boolean = false;

    /** Guard: _onLoadComplete đã chạy một lần rồi, không chạy lại */
    private _completed: boolean = false;

    /** HTML overlay sync: PNG bám node Logo, GIF bám node Logo2 trong loading.scene */
    private _htmlLogoNode: Node | null = null;
    private _htmlLogo2Node: Node | null = null;
    /** Flag: HTML overlay đã ẩn — ngăn _syncHtmlLoadingOverlay chạy lại */
    private _htmlOverlayHidden: boolean = false;
    /** ResizeObserver trên GameCanvas để sync overlay ngay khi canvas thay đổi kích thước */
    private _canvasResizeObserver: ResizeObserver | null = null;

    // ─── LIFECYCLE ───

    onLoad(): void {
        // Khóa 60 FPS sớm nhất (trước khi vào game scene).
        game.frameRate = 60;

        // ★ Khởi tạo ngôn ngữ sớm nhất có thể — trước khi bất kỳ Label nào render.
        //   Đọc DEV_FORCE_LANG (từ ServerConfig) hoặc localStorage 'supernova_lang'.
        LocalizationManager.instance.loadSavedLanguage();
        if (isEditorPreview()) DebugLanguageSwitcher.mount();

        // ★ Bắt đầu tải font + CDN + MainBundle ngay — song song với login ở start().
        this._earlyLoadFont();
        this._cdnPromise = this._loadCdnAssets().catch((err) => {
            Log.w('[Loading] Early CDN load failed (non-blocking):', err);
        });
        // Guide-first: preload frames + GuideView.prefab — tuyệt đối không kick Base.
        if (this.gameBundleName) {
            this._bundlePromise = this._loadBundleAsync()
                .catch((err) => {
                    Log.err('[Loading] Early bundle load failed:', err);
                    return null;
                })
                .then((bundle) => {
                    if (bundle && this.gamePrefabPath && this.handleServerLogin) {
                        void GuideFrameLoader.preload(bundle);
                        void GuideShellLoader.preload(bundle);
                    }
                    return bundle;
                });
        }

        // Lắng nghe ENTER_SUCCESS từ server (hoặc mock) — điều kiện để unlock LOADING_COMPLETE
        EventBus.instance.on(GameEvents.ENTER_SUCCESS, this._onServerReady, this);
        // Guide-first: Continue → kick Base ngay (song song FadeOut); GUIDE_COMPLETE → chờ xong rồi FadeIn
        EventBus.instance.on(GameEvents.GUIDE_CONTINUE, this._onGuideContinueKickBase, this);
        EventBus.instance.on(GameEvents.GUIDE_COMPLETE, this._onGuideCompleteAfterShell, this);
        if (this.noteLabel) {
          //  this.noteLabel.string = L('UI_START_LOADING_1');
        }

            if (typeof document !== 'undefined') {
                    document.addEventListener('visibilitychange', () => {
                        if (document.visibilityState === 'hidden') {
                            // Resume ngay để engine không dừng game loop
                            game.resume();
                        }
                    });
                }
        view.on('canvas-resize', this._syncHtmlLoadingOverlay, this);

        // ★ ResizeObserver trên GameCanvas: phát hiện thay đổi kích thước DOM sớm hơn canvas-resize
        if (typeof document !== 'undefined' && typeof ResizeObserver !== 'undefined') {
            const canvas = document.getElementById('GameCanvas');
            if (canvas) {
                this._canvasResizeObserver = new ResizeObserver(() => {
                    this._syncHtmlLoadingOverlay();
                });
                this._canvasResizeObserver.observe(canvas);
            }
        }
    }

    start(): void {
        // Two-scene mode: nếu đã login xong ở loading.scene thì bỏ qua toàn bộ.
        // GameManager (isGameScene=true) sẽ emit LOADING_COMPLETE sau khi guide.
        if (GameData.instance.isEntered) {
            this.node.active = false;
            return;
        }

        if (this.loadingBar) this.loadingBar.progress = 0;
        if (this.uiOpacity) this.uiOpacity.opacity = 255;

        // Logo: hiệu ứng nhịp thở nhẹ
        if (this.logoNode) {
            tween(this.logoNode)
                .to(0.9, { scale: new Vec3(1.06, 1.06, 1) }, { easing: 'sineInOut' })
                .to(0.9, { scale: new Vec3(1.00, 1.00, 1) }, { easing: 'sineInOut' })
                .union()
                .repeatForever()
                .start();
        }

        this._resolveHtmlOverlayNodes();
        // ★ Defer sang frame tiếp theo để canvas kích thước ổn định (đặc biệt portrait mobile)
        this.scheduleOnce(() => this._syncHtmlLoadingOverlay(), 0);

        this._startLoadingBar();
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        view.off('canvas-resize', this._syncHtmlLoadingOverlay, this);
        if (this._canvasResizeObserver) {
            this._canvasResizeObserver.disconnect();
            this._canvasResizeObserver = null;
        }
        if (this._loadCb) {
            this.unschedule(this._loadCb);
            this._loadCb = null;
        }
    }

    private _resolveHtmlOverlayNodes(): void {
        if (!this._htmlLogoNode?.isValid) {
            this._htmlLogoNode = this._findNodeByName(this.node, 'Logo');
        }
        if (!this._htmlLogo2Node?.isValid) {
            this._htmlLogo2Node = this._findNodeByName(this.node, 'Logo2');
        }
    }

    private _findNodeByName(root: Node | null, name: string): Node | null {
        if (!root) return null;
        if (root.name === name) return root;
        for (const child of root.children) {
            const found = this._findNodeByName(child, name);
            if (found) return found;
        }
        return null;
    }

    private _syncHtmlLoadingOverlay(): void {
        if (this._htmlOverlayHidden) return;
        if (typeof document === 'undefined') return;
        const overlay = document.getElementById('sn-loading-overlay');
        if (!overlay || overlay.classList.contains('hidden')) return;

        this._resolveHtmlOverlayNodes();
        this._applyHtmlImageToNode('sn-loading-logo', this._htmlLogoNode);
        this._applyHtmlImageToNode('sn-loading-gif', this._htmlLogo2Node, 1.5);
    }

    private _applyHtmlImageToNode(elementId: string, targetNode: Node | null, scale: number = 1): void {
        if (typeof document === 'undefined' || !targetNode?.activeInHierarchy) return;

        const element = document.getElementById(elementId) as HTMLElement | null;
        const canvas = document.getElementById('GameCanvas') as HTMLCanvasElement | null;
        const transform = targetNode.getComponent(UITransform);
        if (!element || !canvas || !transform) return;

        const canvasRect = canvas.getBoundingClientRect();
        const visibleSize = view.getVisibleSize();
        if (canvasRect.width <= 0 || canvasRect.height <= 0 || visibleSize.width <= 0 || visibleSize.height <= 0) return;

        const worldRect = transform.getBoundingBoxToWorld();
        const centerX = worldRect.x + worldRect.width * 0.5;
        const centerY = worldRect.y + worldRect.height * 0.5;

        const cssLeft = canvasRect.left + centerX / visibleSize.width * canvasRect.width;
        const cssTop = canvasRect.top + (1 - centerY / visibleSize.height) * canvasRect.height;
        const cssWidth = worldRect.width / visibleSize.width * canvasRect.width * scale;
        const cssHeight = worldRect.height / visibleSize.height * canvasRect.height * scale;

        element.style.position = 'fixed';
        element.style.left = `${cssLeft}px`;
        element.style.top = `${cssTop}px`;
        element.style.width = `${cssWidth}px`;
        element.style.height = `${cssHeight}px`;
        element.style.maxWidth = 'none';
        element.style.maxHeight = 'none';
        element.style.transform = 'translate(-50%, -50%)';
        element.style.objectFit = 'contain';
        element.style.transition = 'opacity 0.3s ease';
        element.style.opacity = '1';
    }

    private _hideHtmlOverlay(): void {
        if (this._htmlOverlayHidden) return;
        this._htmlOverlayHidden = true;
        try { (window as any).snHideLoadingOverlay?.(); } catch (_) {}
        view.off('canvas-resize', this._syncHtmlLoadingOverlay, this);
    }

    // ─── SERVER READY (single-scene mode) ───

    private _onServerReady(): void {
        this._serverReady = true;
        // ENTER_SUCCESS đã fire → real data sẵn sàng → áp vào symbols ngay
        this._applySymbolsIfReady();
        if (this._barDone) {
            this._tryFillToFull();
        }
    }

    /**
     * ★ GameRoot inactive → KHÔNG gọi applyInitialSymbols ở đây.
     * ReelController chưa onLoad → _restPositions undefined → crash setPosition.
     * Symbols được apply bởi GameEntryController sau khi GameRoot.active = true.
     */
    private _applySymbolsIfReady(): void {
        if (this._heavyInitDone || !this._instantiatedGameNode || !this._serverReady) return;
        this._heavyInitDone = true;
        this._tryFillToFull();
        Log.d('[LoadingController] Heavy gate released — symbols deferred until GameRoot active');
    }

    // ─── LOADING BAR ───

    private _startLoadingBar(): void {
        // Prefab mode không cần preloadScene — prefab đã bundled trong main bundle
        if (this.useScenePreload && this.targetScene && !this.gamePrefabPath) {
            this._startScenePreload();
        } else if (this.handleServerLogin && this.gamePrefabPath) {
            // ★ THREE-PHASE MODE: Login ∥ Base ∥ GuideFrames song song → 100%
            this._runThreePhaseLoading();
        } else {
            this._startFakeTimer();
        }
    }

    // ─── SCENE PRELOAD (two-scene mode) ───

    private _startScenePreload(): void {
        director.preloadScene(
            this.targetScene,
            (finished: number, total: number) => {
                // Map preload progress → 0 to 85% (leave buffer for server + fill animation)
                const p = total > 0 ? (finished / total) * 0.85 : 0;
                if (this.loadingBar) {
                    this.loadingBar.progress = Math.max(this.loadingBar.progress, p);
                }
                this._syncHtmlLoadingOverlay();
            },
            (err) => {
                if (err) Log.err('[LoadingController] Preload scene error:', err);
                this._onPreloadComplete();
            }
        );
    }

    private _onPreloadComplete(): void {
        this._preloadDone = true;
        if (this.loadingBar) this.loadingBar.progress = 0.9;

        if (this.handleServerLogin) {
            // Two-scene: handle login ourselves, no GameManager in loading scene
            this._doServerLogin();
        } else {
            // Single-scene or GameManager present: emit gate event as usual
            EventBus.instance.emit(GameEvents.LOADING_GATE_REACHED);
            if (this._serverReady) {
                this._heavyInitDone = true; // Không có prefab → không cần heavy init
                this._fillToFull();
            } else {
                this._barDone = true;
            }
        }
    }

    // ─── SERVER LOGIN (two-scene mode, handleServerLogin = true) ───

    private async _doServerLogin(): Promise<void> {
        const net  = NetworkManager.instance;
        const data = GameData.instance;

        // CDN đã kick từ onLoad — không await ở đây (chạy song song với login)
        if (!this._cdnPromise) {
            this._cdnPromise = this._loadCdnAssets().catch((err) => {
                Log.w('[LoadingController] CDN load error (non-blocking):', err);
            });
        }

        try {
            if (USE_REAL_API) {
                const urlParams  = new (window.URLSearchParams)(window.location.search);
                const gpToken    = urlParams.get('gp');
                const loginParams = gpToken ? { gp: gpToken } : undefined;

                await net.login(loginParams);
                const enterResp = await net.enterGame();

                WalletManager.instance.balance = enterResp.cash;
                data.player.betIndex = enterResp.betIndex;

                net.startHeartBeat();
                net.startJackpotPolling();
            } else {
                // Mock: chạy login+enter thật (MockAdapter) để GameManager không gọi lại
                const session = await net.login();
                data.setServerSession(session);
                WalletManager.instance.balance = session.cash;

                const enterResp = await net.enterGame();
                WalletManager.instance.balance = enterResp.cash;
                data.player.betIndex = enterResp.betIndex;
                data.isLoggedIn = true;
                data.isEntered  = true;
            }
        } catch (err) {
            Log.err('[LoadingController] Server error during login:', err);
        }

        this._serverReady = true;
        this._tryFillToFull();
    }

    // ─── CDN ASSETS ───

    /**
     * Tải locale-online.json và font TTF từ CDN.
     * - Nếu CDN_BASE = null → bỏ qua, dùng local data.
     * - Nếu fetch lỗi → fallback local, không block game.
     */
    private async _loadCdnAssets(): Promise<void> {
        const cdnBase = ServerConfig.CDN_BASE;
        if (!cdnBase) {
            Log.d('[CDN] CDN_BASE không được set — dùng local bundled assets.');
            return;
        }

        Log.d(`[CDN] Bắt đầu tải từ: ${cdnBase}`);
        const cdn = CdnAssetManager.instance;
        cdn.init(cdnBase);

        // 1. Fetch manifest
        const manifest = await cdn.fetchManifest();
        if (!manifest) {
            Log.w('[CDN] Không lấy được manifest — thử load locale trực tiếp (không version check).');
        }

        // 2. Load locale + font song song
        //    Font: dùng promise đã kick off từ onLoad() (tránh download lại).
        const currentLang = LocalizationManager.instance.currentLanguage;
        const fontPromise = this._earlyFontPromise ?? cdn.loadFont(currentLang);
        this._earlyFontPromise = null;

        const localePromise = ServerConfig.USE_CDN_LOCALE ? cdn.loadLocale() : Promise.resolve(null);
        const [locale, font] = await Promise.all([
            localePromise,
            fontPromise,
        ]);

        // 3. Apply locale
        if (!ServerConfig.USE_CDN_LOCALE) {
            Log.d('[CDN] USE_CDN_LOCALE = false — dùng local bundled locale (.ts files).');
        } else if (locale) {
            LocalizationManager.instance.loadOnlineLocalesFromData(locale);
            const langCount   = Object.keys(locale).length;
            const sampleKey   = Object.keys(locale)[0];
            const keyCount    = sampleKey ? Object.keys(locale[sampleKey]).length : 0;
            Log.d(`[CDN] ✅ Locale loaded: ${langCount} ngôn ngữ, ~${keyCount} keys/lang`);
        } else {
            Log.d('[CDN] ⚠️ Locale không tải được — dùng local bundled locale.');
        }

        // 4. Apply font ngôn ngữ hiện tại
        if (font) {
            FontManager.instance?.applyRemoteFonts({ [currentLang]: font });
            Log.d(`[CDN] ✅ Font loaded: ${currentLang}`);
        } else {
            Log.d(`[CDN] ⚠️ Font "${currentLang}" không tải được — dùng font bundled trong build.`);
        }

        Log.d('[CDN] Hoàn tất.');
    }

    // ─── EARLY FONT LOAD ───

    /**
     * Kick off tải font ngay từ onLoad() — trước khi loading bar bắt đầu.
     * Nếu font đã có trong browser HTTP cache → trả về gần như ngay lập tức.
     * Kết quả được _loadCdnAssets() await sau, không cần download lại.
     */
    private _earlyLoadFont(): void {
        const cdnBase = ServerConfig.CDN_BASE;
        if (!cdnBase) return;

        const cdn = CdnAssetManager.instance;
        cdn.init(cdnBase);

        const lang = LocalizationManager.instance.currentLanguage;
        Log.d(`[CDN] Early font pre-load: ${lang}`);
        // Không await manifest — URL không có ?v= nhưng browser cache vẫn hoạt động.
        const promise = cdn.loadFont(lang);
        this._earlyFontPromise = promise;

        // Apply font NGAY khi promise resolve (không đợi login/CDN assets load).
        // Nếu font đã có trong browser HTTP cache → gần như tức thì, trước cả khi
        // loading bar bắt đầu chạy → noteLabel và tất cả labels đúng font ngay lập tức.
        promise.then((font) => {
            if (!font) return;
            const fm = FontManager.instance;
            if (fm) {
                fm.applyRemoteFonts({ [lang]: font });
                Log.d(`[CDN] Early font applied immediately: ${lang}`);
            } else {
                // FontManager chưa có (rare race) — lưu vào CDN cache, FontManager.onLoad()
                // sẽ tự re-apply qua hasCachedFonts khi nó khởi tạo.
                Log.d(`[CDN] Early font ready (FontManager not yet init): ${lang}`);
            }
        });
    }

    // ─── FAKE TIMER (single-scene mode, useScenePreload = false) ───

    private _startFakeTimer(): void {
        if (this.loadingDuration <= 0) {
            if (this.loadingBar) this.loadingBar.progress = this.prefabLoadPercent;
            this._syncHtmlLoadingOverlay();
            this._onBarReachedLimit();
            return;
        }
        this._elapsed = 0;
        const interval = 1 / 30;
        // Nhanh tới prefabLoadPercent% để hiển thị loading ngay, rồi load prefab
        const BAR_GATE = this.prefabLoadPercent;

        this._loadCb = () => {
            this._elapsed += interval;
            const t = Math.min(this._elapsed / this.loadingDuration, 1);
            const eased = t * t * (3 - 2 * t);
            const progress = eased * BAR_GATE;
            if (this.loadingBar) this.loadingBar.progress = progress;
            this._syncHtmlLoadingOverlay();

            if (t >= 1.0) {
                this.unschedule(this._loadCb!);
                this._loadCb = null;
                this._onBarReachedLimit();
            }
        };

        this.schedule(this._loadCb, interval);
    }

    /** Bar đã tới 1% - bắt đầu load prefab ngay */
    private _onBarReachedLimit(): void {
        this._syncHtmlLoadingOverlay();
        if (this.handleServerLogin) {
            if (this.gamePrefabPath) {
                // Prefab mode: dừng bar ở 1%, load prefab ngay
                // Khi prefab xong → animate bar từ 2% → 100%
                this._startPrefabLoadAtOnce();
                // Server login chạy song song (background)
                this._doServerLogin();
            } else {
                this._barDone = true;
                this._doServerLogin();
            }
        } else {
            this._barDone = true;
            EventBus.instance.emit(GameEvents.LOADING_GATE_REACHED);
            if (this._serverReady) {
                this._heavyInitDone = true; // Không có prefab → không cần heavy init
                this._fillToFull();
            }
        }
    }

    /**
     * Load prefab ngay từ 1%, không cập nhật progress bar.
     * Khi prefab load xong → set bar = 2% rồi animate mượt từ 2% → 100%.
     */
    private _startPrefabLoadAtOnce(): void {
        Log.d(`[LoadingController] Loading prefab at 1%: ${this.gameBundleName}/${this.gamePrefabPath}`);

        const onBundleReady = (bundle: AssetManager.Bundle) => {
            bundle.load(
                this.gamePrefabPath,
                Prefab,
                (finished: number, total: number) => {
                    // Không cập nhật bar - giữ ở 1%
                },
                (err, prefab) => {
                    if (err) {
                        Log.err(`[LoadingController] Prefab load failed: ${this.gameBundleName}/${this.gamePrefabPath}`, err);
                    } else {
                        this._loadedPrefab = prefab;
                        // active=true NGAY ĐỂ LIFECYCLE CHẠY (onLoad/start của SMC, SymbolView...).
                        // GameRoot inactive đến khi warm / reveal (fade bằng fill đen).
                        const gameNode = instantiate(prefab);
                        this._attachGamePrefab(gameNode);
                    }
                    // Prefab đã instantiate — đánh dấu ready, nhưng CHỜ ENTER_SUCCESS + GPU
                    // _applySymbolsIfReady() sẽ chạy khi ENTER_SUCCESS fire (hoặc đã fire)
                    this._prefabReady = true;
                    this._barDone = true;
                    if (this.loadingBar) {
                        this.loadingBar.progress = this.barFillStartPercent;
                    }
                    this._syncHtmlLoadingOverlay();
                    this._applySymbolsIfReady();
                    this._tryFillToFull();
                }
            );
        };

        const existing = assetManager.getBundle(this.gameBundleName);
        if (existing) {
            onBundleReady(existing);
        } else {
            assetManager.loadBundle(this.gameBundleName, (err, bundle) => {
                if (err) {
                    Log.err(`[LoadingController] Bundle load failed: ${this.gameBundleName}`, err);
                    this._heavyInitDone = true;
                    this._prefabReady = true;
                    this._barDone = true;
                    if (this.loadingBar) {
                        this.loadingBar.progress = this.barFillStartPercent;
                    }
                    this._tryFillToFull();
                    return;
                }
                onBundleReady(bundle!);
            });
        }
    }

    /**
     * Guide-first gate: server + Guide shell (frames + GuideView.prefab).
     * Base load nền — không block bar 100%.
     */
    private _tryFillToFull(): void {
        if (this._fillStarted || this._animatingToFull) return;
        if (this._bootCrawlActive) return;
        const guideDone = !this.gamePrefabPath || this._guideReady;
        const heavyDone = !this.gamePrefabPath || this._heavyInitDone;
        if (this._serverReady && guideDone && heavyDone) {
            this._fillStarted = true;
            this._fillToFull();
        }
    }

    // ─── THREE-PHASE LOADING (Guide-first) ───

    /**
     * Login ∥ GuideShell — Base download/instantiate chạy nền, không await.
     */
    private async _runThreePhaseLoading(): Promise<void> {
        this._bootCrawlActive = true;
        if (this.loadingBar) this.loadingBar.progress = 0;
        GameData.instance.guideFirstBoot = true;
        GameData.instance.isBaseReady = false;

        if (!this._bundlePromise) {
            this._bundlePromise = this._loadBundleAsync()
                .catch((err) => {
                    Log.err('[LoadingController] Bundle load failed:', err);
                    return null;
                })
                .then((bundle) => {
                    if (bundle && this.gamePrefabPath) {
                        void GuideFrameLoader.preload(bundle);
                        void GuideShellLoader.preload(bundle);
                    }
                    return bundle;
                });
        }
        if (!this._cdnPromise) {
            this._cdnPromise = this._loadCdnAssets().catch((err) => {
                Log.w('[LoadingController] CDN load error (non-blocking):', err);
            });
        }

        const loginPromise = this._doServerLogin();
        const guidePromise = this._ensureGuideViewReady();

        // Chỉ chờ Login + GuideView.prefab — KHÔNG chờ Base
        await Promise.all([loginPromise, guidePromise]);

        this._guideReady = true;
        this._heavyInitDone = true;
        this._serverReady = true;
        this._bootCrawlActive = false;

        // ★ Không kick Base ở đây — chỉ kick SAU khi GuideView.show()
        if (this._fillStarted && this.loadingBar && this.loadingBar.progress < 0.99) {
            this._fillStarted = false;
            this._animatingToFull = false;
        }

        this._tryFillToFull();
    }

    /** Preload guide frames + GuideView.prefab (tách riêng), attach inactive. */
    private async _ensureGuideViewReady(): Promise<void> {
        try {
            const bundle = await this._bundlePromise;
            if (!bundle) {
                Log.err('[LoadingController] No bundle — cannot load GuideView');
                return;
            }
            const [frames, prefab] = await Promise.all([
                GuideFrameLoader.preload(bundle),
                GuideShellLoader.preload(bundle),
            ]);
            if (!frames) Log.w('[LoadingController] Guide frames preload returned null');
            if (!prefab) {
                Log.err('[LoadingController] GuideView.prefab missing in MainBundle');
                return;
            }
            const parent = this.gameContainer ?? director.getScene();
            if (!parent) {
                Log.e('[LoadingController] No parent for GuideView');
                return;
            }
            const node = await GuideShellLoader.attach(parent);
            Log.d(`[LoadingController] GuideView.prefab ready (inactive)=${!!node}`);
        } catch (err) {
            Log.err('[LoadingController] GuideView load error:', err);
        }
    }

    /** Base download + instantiate nền trong lúc xem Guide. */
    private _startBaseBackgroundLoad(): Promise<void> {
        if (this._baseBgPromise) return this._baseBgPromise;

        this._baseBgPromise = (async () => {
            try {
                const bundle = await this._bundlePromise;
                if (!bundle || !this.gamePrefabPath) {
                    this._prefabReady = true;
                    GameData.instance.isBaseReady = true;
                    return;
                }
                await this._ensureBaseReady(bundle);

                GameData.instance.isBaseReady = true;
                this._prefabReady = true;
                Log.d('[LoadingController] Base ready in background');

                if (GameData.instance.isGuideShowing || this._awaitingGuideComplete) {
                    this._warmGameRootDuringGuide();
                    // Shell luôn trên Base. Sau Continue: ép đen; lúc xem Guide: chỉ bringToFront.
                    if (this._holdingBlackForBase) {
                        GuideShellLoader.holdBlackOnTop();
                    } else {
                        GuideShellLoader.bringToFront();
                    }
                }
            } catch (err) {
                Log.err('[LoadingController] Base background load error:', err);
                this._prefabReady = true;
                GameData.instance.isBaseReady = true;
            }
        })();

        return this._baseBgPromise;
    }

    /** Base vừa attach lúc Guide đang hiện → warm GameRoot (dưới Guide shell). */
    private _warmGameRootDuringGuide(): void {
        const base = this._instantiatedGameNode;
        if (!base?.isValid) return;
        base.active = true;
        const gec = base.getComponent(GameEntryController)
            ?? base.getComponentInChildren(GameEntryController);
        gec?.notifyBaseReadyDuringGuide();
    }

    /** Idempotent: chỉ download Prefab asset (chưa instantiate). */
    private _ensureBaseAssetLoad(bundle: AssetManager.Bundle): Promise<Prefab | null> {
        if (this._baseAssetPromise) return this._baseAssetPromise;
        if (this._loadedPrefab) {
            this._baseAssetPromise = Promise.resolve(this._loadedPrefab as Prefab);
            return this._baseAssetPromise;
        }

        Log.d(`[LoadingController] Download Base asset: ${this.gamePrefabPath}`);
        this._baseAssetPromise = new Promise<Prefab | null>((resolve) => {
            let settled = false;
            const settle = (value: Prefab | null) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const timer = setTimeout(() => {
                Log.err('[LoadingController] Base asset load timeout 45s');
                settle(null);
            }, 45_000);

            bundle.load(this.gamePrefabPath, Prefab, (err: Error | null, prefab: Prefab) => {
                clearTimeout(timer);
                if (err || !prefab) {
                    Log.err(`[LoadingController] Prefab load failed: ${this.gamePrefabPath}`, err);
                    settle(null);
                    return;
                }
                this._loadedPrefab = prefab;
                settle(prefab);
            });
        });
        return this._baseAssetPromise;
    }

    /**
     * Download (nếu chưa) + instantiate/attach Base.
     * try/catch để Promise luôn resolve — tránh bar kẹt ~80%.
     */
    private _ensureBaseReady(bundle: AssetManager.Bundle): Promise<void> {
        if (this._basePromise) return this._basePromise;

        this._basePromise = (async () => {
            const prefab = await this._ensureBaseAssetLoad(bundle);
            if (!prefab) {
                this._prefabReady = true;
                return;
            }
            if (this._instantiatedGameNode) {
                this._prefabReady = true;
                return;
            }
            try {
                const gameNode = instantiate(prefab);
                this._attachGamePrefab(gameNode);
            } catch (err) {
                Log.err('[LoadingController] Base instantiate failed:', err);
            }
            this._prefabReady = true;
            this._applySymbolsIfReady();
            this._tryFillToFull();
        })();

        return this._basePromise;
    }

    /**
     * Bar crawl (legacy two-scene). phaseCrawlSecs=0 → await operation, không tween bar.
     */
    private _phaseWithCrawl(from: number, to: number, operation: () => Promise<void>): Promise<void> {
        if (this.phaseCrawlSecs <= 0 || !this.loadingBar) {
            return operation().catch((err) => {
                Log.err('[PhaseWithCrawl] Operation error:', err);
            });
        }
        this._syncHtmlLoadingOverlay();
        return new Promise<void>((resolve) => {
            let resolved = false;

            const finish = () => {
                if (resolved) return;
                resolved = true;
                if (this._fillStarted || this._animatingToFull) {
                    resolve();
                    return;
                }
                Tween.stopAllByTarget(this.loadingBar!);
                const cur = this.loadingBar!.progress;
                const fillSecs = Math.max(0, (to - cur) * 0.5);
                if (fillSecs <= 0) {
                    this.loadingBar!.progress = to;
                    resolve();
                    return;
                }
                tween(this.loadingBar!)
                    .to(fillSecs, { progress: to }, { easing: 'sineOut' })
                    .call(() => resolve())
                    .start();
            };

            const crawlSecs = this.phaseCrawlSecs;
            tween(this.loadingBar)
                .to(crawlSecs, { progress: to }, { easing: 'sineOut' })
                .start();

            operation().then(finish).catch((err) => {
                Log.err('[PhaseWithCrawl] Operation error:', err);
                finish();
            });
        });
    }

    /** Wrap assetManager.loadBundle vào Promise */
    private _loadBundleAsync(): Promise<AssetManager.Bundle> {
        return new Promise<AssetManager.Bundle>((resolve, reject) => {
            const existing = assetManager.getBundle(this.gameBundleName);
            if (existing) {
                resolve(existing);
                return;
            }
            assetManager.loadBundle(this.gameBundleName, (err, bundle) => {
                if (err || !bundle) {
                    Log.err(`[LoadingController] Bundle load failed: ${this.gameBundleName}`, err);
                    reject(err ?? new Error('Bundle is null'));
                } else {
                    Log.d(`[LoadingController] Bundle loaded: ${this.gameBundleName}`);
                    resolve(bundle);
                }
            });
        });
    }

    /** Tắt GameRoot + GuideView TRƯỚC addChild — tránh onLoad GameRoot chạy khi prefab mặc định active. */
    private _prepareBootShell(gameNode: Node): void {
        const gameRoot = gameNode.getChildByName('GameRoot');
        if (gameRoot) gameRoot.active = false;
        const guide = gameNode.getChildByName('GuideView');
        if (guide) guide.active = false;
    }

    private _attachGamePrefab(gameNode: Node): void {
        this._prepareBootShell(gameNode);
        // Guide-first: attach inactive — caller bật khi warm / resume / sau Guide
        gameNode.active = !GameData.instance.guideFirstBoot;
        const parent = this.gameContainer ?? director.getScene()!;
        parent.addChild(gameNode);
        this._instantiatedGameNode = gameNode;
        Log.d(`[LoadingController] Prefab attached (active=${gameNode.active}): ${this.gamePrefabPath}`);
    }

    /** Load prefab asset từ bundle rồi instantiate (ẩn), lưu vào _instantiatedGameNode */
    private _loadAndInstantiatePrefab(bundle: AssetManager.Bundle): Promise<void> {
        return new Promise<void>((resolve) => {
            bundle.load(this.gamePrefabPath, Prefab, (err: Error | null, prefab: Prefab) => {
                if (err || !prefab) {
                    Log.err(`[LoadingController] Prefab load failed: ${this.gamePrefabPath}`, err);
                } else {
                    const gameNode = instantiate(prefab);
                    this._attachGamePrefab(gameNode);
                }
                this._prefabReady = true;
                this._applySymbolsIfReady();
                this._tryFillToFull();
                resolve();
            });
        });
    }

    /** Snap/fill 100% rồi emit LOADING_COMPLETE + LOADING_BAR_100. */
    private _fillToFull(): void {
        if (this._animatingToFull) return;
        this._animatingToFull = true;

        const completeBoot = () => {
            if (this.loadingBar) {
                Tween.stopAllByTarget(this.loadingBar);
                this.loadingBar.progress = 1.0;
                this._syncHtmlLoadingOverlay();
            }
            void this._finishBootAndEmitBar100();
        };

        if (!this.loadingBar) {
            completeBoot();
            return;
        }

        this.node.active = true;
        if (this.uiOpacity) this.uiOpacity.opacity = 255;

        const fillSecs = this.barFillToFullSecs;
        const holdSecs = this.barHoldAtFullSecs;
        if (fillSecs <= 0 && holdSecs <= 0) {
            completeBoot();
            return;
        }

        Tween.stopAllByTarget(this.loadingBar);
        tween(this.loadingBar)
            .to(Math.max(0, fillSecs), { progress: 1.0 }, { easing: 'sineOut' })
            .delay(Math.max(0, holdSecs))
            .call(completeBoot)
            .start();
    }

    /** Await guide-first complete (có thể chờ Base nếu resume/skip) rồi mới BAR_100. */
    private async _finishBootAndEmitBar100(): Promise<void> {
        await this._onLoadCompleteAsync();

        // Giữ Loading trên Base/GameRoot trong lúc BAR_100 handlers init (skipIntro)
        this._bringLoadingToFront();
        EventBus.instance.emit(GameEvents.LOADING_BAR_100);

        // skipIntro: chờ GameRoot (Reel + data + BG + Transition) xong mới ẩn Loading
        const skipIntro = this._readSkipIntro();
        let canDismissLoading = true;
        if (skipIntro && !GameData.instance.isResumingFreeSpin) {
            const base = this._instantiatedGameNode;
            const gec = base?.getComponent(GameEntryController)
                ?? base?.getComponentInChildren(GameEntryController)
                ?? null;
            if (gec) {
                Log.d('[LoadingController] skipIntro — hold Loading until GameRoot ready');
                try {
                    await gec.waitSkipIntroEnter();
                } catch (err) {
                    Log.err('[LoadingController] Keep Loading visible — GameRoot preparation failed', err);
                    return;
                }
                // Reveal và tắt Loading chạy liên tục, không await ở giữa:
                // renderer không có cơ hội vẽ GameView trước khi dữ liệu hoàn chỉnh.
                canDismissLoading = gec.revealPreparedSkipIntro();
                Log.d(`[LoadingController] skipIntro — atomic reveal ready=${canDismissLoading}`);
            } else {
                canDismissLoading = false;
                Log.err('[LoadingController] Keep Loading visible — GameEntryController missing');
            }
        }

        if (!canDismissLoading) return;
        this._hideHtmlOverlay();
        this.node.active = false;
    }

    /** Đưa Loading lên trên cùng — che Base/GameRoot đang warm dưới. */
    private _bringLoadingToFront(): void {
        if (!this.node?.isValid || !this.node.parent) return;
        this.node.setSiblingIndex(this.node.parent.children.length - 1);
    }

    private _onLoadComplete(): void {
        void this._onLoadCompleteAsync();
    }

    private async _onLoadCompleteAsync(): Promise<void> {
        if (this._completed) {
            Log.w('[LoadingController] _onLoadComplete called again — ignored (already completed)');
            return;
        }

        if (this.gamePrefabPath && !this._heavyInitDone) {
            await new Promise<void>((r) => this.scheduleOnce(() => r(), 0));
            return this._onLoadCompleteAsync();
        }

        this._completed = true;
        EventBus.instance.off(GameEvents.ENTER_SUCCESS, this._onServerReady, this);

        if (this.gamePrefabPath) {
            await this._completePrefabGuideFirst();
            return;
        }

        if (this.targetScene) {
            GameData.instance.isFromLoadingScene = true;
            this._hideHtmlOverlay();
            this.node.active = false;
            const doLoad = () => director.loadScene(this.targetScene!);
            if (typeof document !== 'undefined' && document.fonts?.ready) {
                await document.fonts.ready;
            }
            doLoad();
            return;
        }

        this._hideHtmlOverlay();
        this.node.active = false;
        EventBus.instance.emit(GameEvents.LOADING_COMPLETE);
    }

    /** Detect resume flags from enter response (same logic as trước). */
    private _detectResumeFromEnter(): void {
        if (!USE_REAL_API) return;
        const rawLast = GameData.instance.rawEnterLastSpinResponse;
        if (!rawLast) {
            Log.e('[GAME-ENTER] LoadingController → NO rawEnterLastSpinResponse');
            return;
        }
        const lastStage: number = rawLast.NextStage ?? rawLast.stageType ?? 0;
        const remainFS: number = rawLast.RemainFreeSpinCount ?? rawLast.remainFreeSpinCount ?? 0;
        const stageNames: Record<number, string> = {
            0: 'SPIN', 3: 'FREE_SPIN_START', 4: 'FREE_SPIN', 5: 'FREE_SPIN_RE_TRIGGER',
            8: 'BUY_FREE_SPIN_START', 9: 'BUY_FREE_SPIN',
            100: 'NEED_CLAIM', 101: 'FREE_SPIN_END', 107: 'BUY_FREE_SPIN_END',
        };
        const stageName = stageNames[lastStage] || `UNKNOWN(${lastStage})`;
        Log.e(`[GAME-ENTER] LoadingController → stage=${lastStage}(${stageName}), remainFS=${remainFS}`);

        const isFreeSpin = (lastStage >= 3 && lastStage <= 9) && remainFS > 0;
        const isTopUp = lastStage === 12 || lastStage === 13;
        const isNeedClaim = lastStage >= 100;
        if (isFreeSpin || isTopUp || isNeedClaim) {
            GameData.instance.isResumingFreeSpin = true;
            Log.e(`[RESUME-DEBUG] LoadingController → isResumingFreeSpin=true (stage=${stageName})`);
        }
    }

    private _readSkipIntro(): boolean {
        try {
            const saved = localStorage.getItem('setting_intro_on');
            if (saved !== null) return saved === 'false';
        } catch (_) {}
        return false;
    }

    /**
     * Guide-first complete:
     *   - resume / skipIntro → await Base → GEC path thường
     *   - normal → show GuideShell ngay, Base nền
     */
    private async _completePrefabGuideFirst(): Promise<void> {
        this._detectResumeFromEnter();
        GameData.instance.isFromLoadingScene = true;

        const isResuming = GameData.instance.isResumingFreeSpin;
        const skipIntro = this._readSkipIntro();

        if (isResuming || skipIntro) {
            Log.d(`[LoadingController] Guide-first bypass Guide (resume=${isResuming}, skip=${skipIntro}) → await Base+GameRoot`);
            await this._startBaseBackgroundLoad();
            const base = this._instantiatedGameNode;
            if (base) {
                base.active = true;
                // Che Base trong lúc warm GameRoot — tránh lộ Reel/data chưa init
                this._bringLoadingToFront();
                // skipIntro: init Reel + data + BG dưới Loading trước BAR_100
                if (skipIntro && !isResuming) {
                    const gec = base.getComponent(GameEntryController)
                        ?? base.getComponentInChildren(GameEntryController);
                    if (gec) {
                        await gec.prepareGameRootBackground();
                        Log.d('[LoadingController] skipIntro — GameRoot Reels/data/BG ready under Loading');
                    }
                }
            } else {
                Log.err('[LoadingController] Base missing after await — cannot enter game');
            }
            EventBus.instance.emit(GameEvents.LOADING_COMPLETE);
            return;
        }

        // ★ Loading → màn đen → FadeIn Guide xong → mới kick Base
        if (!GuideShellLoader.instance) {
            Log.err('[LoadingController] GuideView.prefab missing — fallback await Base');
            await this._startBaseBackgroundLoad();
            GameData.instance.guideFirstBoot = false;
            if (this._instantiatedGameNode) this._instantiatedGameNode.active = true;
            EventBus.instance.emit(GameEvents.LOADING_COMPLETE);
            return;
        }

        GameData.instance.isGuideShowing = true;
        this._awaitingGuideComplete = true;
        this._holdingBlackForBase = false;

        // 1) Ẩn Loading → màn đen (Guide OverLay giữ đen, chưa fade)
        this._hideHtmlOverlay();
        if (this.uiOpacity) this.uiOpacity.opacity = 0;
        this.node.active = false;

        GuideShellLoader.show(true); // deferEntranceFade — giữ đen, chưa fade
        Log.d('[LoadingController] ★ Black → FadeIn Guide (Base chưa load)');

        // 2) FadeIn Guide trước — KHÔNG kick Base trong lúc đen / đang fade
        await new Promise<void>((r) => this.scheduleOnce(() => r(), 0));

        GuideShellLoader.getController()?.beginEntranceFade(() => {
            // 3) Fade xong hẳn (overlay đã ẩn) → mới load Base nền
            Log.d('[LoadingController] ★ Guide fade-in DONE — kick Base load NOW');
            void this._startBaseBackgroundLoad();
        });
        Log.d('[LoadingController] ★ Guide entrance fade started');

        EventBus.instance.emit(GameEvents.LOADING_COMPLETE);
    }

    /**
     * Continue vừa bấm → kick Base ngay (chạy song song FadeOut → đen).
     * Không reveal; chỉ preload để rút ngắn thời gian giữ màn đen.
     */
    private _onGuideContinueKickBase(): void {
        if (!this._awaitingGuideComplete) return;
        this._holdingBlackForBase = true;
        Log.d('[LoadingController] GUIDE_CONTINUE — kick Base load under FadeOut/black');
        void this._startBaseBackgroundLoad();
    }

    /**
     * GuideView FadeOut xong (màn đen) → chờ Base + GameRoot sẵn hết → mới FadeIn.
     */
    private async _onGuideCompleteAfterShell(): Promise<void> {
        if (!this._awaitingGuideComplete) return;
        this._awaitingGuideComplete = false;
        this._holdingBlackForBase = true;

        // ★ Giữ màn đen — KHÔNG FadeIn cho đến khi Base + prep xong
        GuideShellLoader.holdBlackOnTop();
        Log.d('[LoadingController] GUIDE_COMPLETE — hold black, await Base fully ready');

        await this._startBaseBackgroundLoad();

        const base = this._instantiatedGameNode;
        if (!base?.isValid) {
            Log.err('[LoadingController] Base missing after Guide — cannot enter');
            this._holdingBlackForBase = false;
            GuideShellLoader.dismiss();
            return;
        }

        // Base vừa attach có thể nhảy lên trên shell — ép lại đen trên cùng
        GuideShellLoader.holdBlackOnTop();
        base.active = true;

        const shared = GuideShellLoader.sharedNode;
        const gec = base.getComponent(GameEntryController)
            ?? base.getComponentInChildren(GameEntryController);

        if (gec) {
            // Prep GameRoot/BG/Transition dưới đen → rồi mới FadeIn
            await gec.enterFromExternalGuide(shared, () => GuideShellLoader.fadeRevealAndDismiss());
        } else {
            Log.err('[LoadingController] GameEntryController missing on Base');
            const gameRoot = base.getChildByName('GameRoot');
            if (shared && gameRoot) {
                shared.setParent(gameRoot, false);
                shared.active = true;
            }
            if (gameRoot) gameRoot.active = true;
            EventBus.instance.emit(GameEvents.GAME_ENTRY_EFFECT);
            GuideShellLoader.dismiss();
        }
        this._holdingBlackForBase = false;
    }
}
