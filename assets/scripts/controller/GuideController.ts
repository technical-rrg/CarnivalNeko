/**
 * GuideController - Màn hình Hướng dẫn (Guide View).
 *
 * Setup trong Editor:
 *   1. Tạo Node "GuideView" (bắt đầu inactive).
 *   2. Gắn component này vào GuideView.
 *   3. Dưới GuideView tạo:
 *        - OverLay      : Sprite đen full màn (kéo vào overlayNode)
 *        - guidePanel   : Node chứa nội dung hướng dẫn
 *        - continueArea : Button "CLICK TO CONTINUE"
 *   4. Kéo các node vào slot tương ứng.
 *
 * Flow:
 *   LOADING_BAR_100 → OverLay đen phủ màn → fade out dần → lộ Guide
 *   → click continueArea → OverLay fade in → emit GUIDE_COMPLETE → deactivate
 */

import { _decorator, Component, Node, tween, Layout, screen, Label, Sprite, SpriteFrame, Vec3, CCString, Button, ParticleSystem, UITransform, Tween, Color } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { SoundManager } from '../manager/SoundManager';
import { SettingPopup } from './SettingPopup';
import { Log } from '../core/Logger';
import { GuideFrameLoader, GUIDE_PORTRAIT_PATHS, GUIDE_LANDSCAPE_PATHS } from '../core/GuideFrameLoader';

const { ccclass, property } = _decorator;

@ccclass('GuideController')
export class GuideController extends Component {

    @property({ type: SettingPopup, tooltip: '(Tuỳ chọn) SettingPopup để kiểm tra introEnabled — nếu tắt thì skip guide' })
    settingPopup: SettingPopup | null = null;

    @property({ type: Node, tooltip: 'Panel guide chứa nội dung hướng dẫn' })
    guidePanel: Node | null = null;


    // ─── Background Carousel ───
    @property({ type: [Node], tooltip: 'Background nodes (mỗi node có Sprite; spriteFrame set động theo orientation)' })
    bgNodes: Node[] = [];

    @property({ type: [SpriteFrame], tooltip: 'Sprite frames PORTRAIT (match index bgNodes). Để trống = giữ spriteFrame gốc trên node.' })
    bgPortraitFrames: SpriteFrame[] = [];

    @property({ type: [SpriteFrame], tooltip: 'Sprite frames LANDSCAPE (match index bgNodes). Để trống = giữ spriteFrame gốc trên node.' })
    bgLandscapeFrames: SpriteFrame[] = [];

    @property({ type: Label, tooltip: 'Label hiển thị title/guide text — đổi theo từng background' })
    guideTitleLabel: Label | null = null;

    @property({ type: [CCString], tooltip: 'Localization keys cho guideTitleLabel (match index với bgNodes)' })
    guideTitleKeys: string[] = [];

    // ─── Tab Icons ───
    @property({ type: [Node], tooltip: 'Tab icon nodes (mỗi node có Sprite component)' })
    tabIcons: Node[] = [];

    @property({ type: SpriteFrame, tooltip: 'Sprite frame NORMAL cho TẤT CẢ tab icons' })
    tabIconNormalFrame: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'Sprite frame FOCUS cho TẤT CẢ tab icons (active state)' })
    tabIconFocusFrame: SpriteFrame | null = null;

    @property({ tooltip: 'Thời gian giữ mỗi background (giây) trước khi chuyển' })
    carouselInterval: number = 2.0;

    @property({ tooltip: 'Thời gian transition slide (giây)' })
    slideDuration: number = 0.35;

    @property({ tooltip: 'Delay (giây) sau fade-in trước carousel. 0 = bắt đầu ngay.' })
    carouselDelay: number = 0;

    @property({ type: Button, tooltip: 'Button "CLICK TO CONTINUE" ở dưới cùng màn hình' })
    continueArea: Button | null = null;

    @property({ type: Label, tooltip: 'Label sẽ được áp dụng hiệu ứng zoom in/out (thay vì toàn bộ continueArea)' })
    continueLabel: Label | null = null;

    @property({ type: [Label], tooltip: '2 Label node để hiển thị hướng dẫn (liên tục cập nhật theo ngôn ngữ)' })
    guideLabels: Label[] = [];

    
    @property({
        type: [CCString],
        displayName: 'Guide Label Keys',
        tooltip: 'Localization key cho mỗi guideLabel (phải match index, tương ứng với mảng guideLabels)',
    })
    guideLabelKeys: string[] = [];

    @property({
        type: Node,
        tooltip: 'Overlay nền đen full màn (kéo node OverLay vào). Cần Sprite đen — fade out khi vào từ Loading.',
    })
    overlayNode: Node | null = null;

    @property({ tooltip: 'Thời gian OverLay fade out khi vào từ Loading (giây). 0 = lộ Guide ngay.' })
    overlayFadeDuration: number = 0.5;

    @property({ tooltip: 'Thời gian OverLay fade → đen khi click Continue (giây).' })
    overlayFadeOutDuration: number = 0.35;

    @property({
        tooltip: 'Thời gian OverLay fade đen → trong suốt khi lộ GameRoot sau Continue (giây).',
    })
    overlayRevealDuration: number = 0.7;

    @property({
        tooltip: 'Giữ màn đen sau khi fade Continue xong (giây). Thường 0.',
    })
    overlayHoldBlackSecs: number = 0;

    @property({ type: [ParticleSystem], tooltip: '2 Particle system trên Guide — sẽ dừng khi fade out và play lại khi fade in' })
    particles: ParticleSystem[] = [];

    @property({ type: Node, tooltip: 'Node chứa RandomParticleSpawner — sẽ ẩn khi click Continue' })
    randomParticleSpawnerNode: Node | null = null;

    @property({ tooltip: 'Scale min cho zoom effect của continueArea' })
    zoomMinScale: number = 0.9;

    @property({ tooltip: 'Scale max cho zoom effect của continueArea' })
    zoomMaxScale: number = 1.08;

    @property({ tooltip: 'Thời gian một chu kỳ zoom in/out (giây)' })
    zoomDuration: number = 0.8;

    /** Guard: đã bị dismiss (người dùng click Continue) — từ chối mọi onEnable sau đó */
    private _dismissed: boolean = false;
    /** Lần onEnable tới: giữ màn đen, chờ beginEntranceFade() (Guide-first: fade xong mới kick Base). */
    private _deferEntranceFade: boolean = false;
    private _entranceStarted: boolean = false;

    // ─── Carousel State ───
    private _currentBgIndex: number = 0;
    private _isTransitioning: boolean = false;
    private _carouselActive: boolean = false;
    private _prevTween: Tween<Node> | null = null;
    private _nextTween: Tween<Node> | null = null;
    private _guideFramesPromise: Promise<void> | null = null;
    private _overlayTween: Tween<Sprite> | null = null;

    private static readonly _BLACK_OPAQUE = new Color(0, 0, 0, 255);
    private static readonly _BLACK_CLEAR = new Color(0, 0, 0, 0);

    /** Gọi trước GuideShellLoader.show() — onEnable chỉ giữ đen, không fade. */
    static markDeferEntranceFade(node: Node | null): void {
        const gc = node?.getComponent(GuideController);
        if (gc) gc._deferEntranceFade = true;
    }

    // ─── LIFECYCLE ───

    onLoad(): void {
        EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, this._setGuideLabels, this);
        screen.on('window-resize', this._applyGuideLayout, this);
        screen.on('orientation-change', this._applyGuideLayout, this);
        // Apply cache từ LoadingController preload (nếu đã sẵn)
        this._applyCachedFrames();
        this._ensureGuideFrames();
    }

    start(): void {
        // Đảm bảo bgNodes được position đúng SAU KHI toàn bộ scene load xong
        this._setupBgNodes();
    }

    onEnable(): void {
        // Guard: nếu đã dismiss rồi thì từ chối — ai đó đang cố re-activate GuideView sai
        if (this._dismissed) {
            Log.d('[GuideController] onEnable blocked — already dismissed');
            this.scheduleOnce(() => { this.node.active = false; }, 0);
            return;
        }

        try {
            this._setupBgNodes();
            if (this.guidePanel) this.guidePanel.active = true;
            this._setGuideLabels();
            this._showOverlayOnTop(GuideController._BLACK_OPAQUE);

            void this._ensureGuideFrames().then(() => {
                if (!this.node.active || this._dismissed) return;
                this._applyGuideLayout();
            });

            // Guide-first: giữ đen, chờ LoadingController gọi beginEntranceFade()
            if (this._deferEntranceFade) {
                this._deferEntranceFade = false;
                return;
            }
            this.beginEntranceFade();
        } catch (err) {
            Log.err('[GuideController] onEnable failed', err);
        }
    }

    /**
     * Fade đen → lộ Guide. onComplete chạy SAU khi fade xong + overlay ẩn
     * (LoadingController dùng để kick Base — tránh load lúc còn đen/fade).
     */
    beginEntranceFade(onComplete?: () => void): void {
        if (this._dismissed || !this.node.active || this._entranceStarted) {
            onComplete?.();
            return;
        }
        this._entranceStarted = true;
        Log.d('[GuideController] beginEntranceFade — fade in Guide');
        this._showOverlayOnTop(GuideController._BLACK_OPAQUE);
        this._fadeOverlay(GuideController._BLACK_OPAQUE, GuideController._BLACK_CLEAR, this.overlayFadeDuration, () => {
            if (!this.node.active || this._dismissed) {
                onComplete?.();
                return;
            }
            this._hideOverlay();
            this._onGuideReady();
            // 1 frame sau khi overlay ẩn — chắc chắn không còn đen mờ
            this.scheduleOnce(() => onComplete?.(), 0);
        });
    }

    /**
     * Giữ full màn đen trong lúc chờ Base/GameRoot sẵn (sau FadeOut Continue).
     * LoadingController gọi trong lúc await Base — tránh lộ nội dung Guide/Base sớm.
     */
    holdBlackOverlay(): void {
        if (!this.node.active) return;
        const overlay = this._resolveOverlayNode();
        for (const child of this.node.children) {
            if (child !== overlay) child.active = false;
        }
        this._showOverlayOnTop(GuideController._BLACK_OPAQUE);
        Log.d('[GuideController] holdBlackOverlay — waiting for Base');
    }

    /**
     * Sau Continue + GameRoot sẵn dưới lớp đen: fade đen → trong suốt để lộ game.
     * Ẩn nội dung Guide trước để không lộ slide khi overlay trong suốt.
     */
    beginRevealFade(onComplete?: () => void): void {
        if (!this.node.active) {
            onComplete?.();
            return;
        }
        Log.d(`[GuideController] beginRevealFade — reveal GameRoot (${this.overlayRevealDuration}s)`);

        // Chỉ giữ OverLay — ẩn slide / UI Guide
        this.holdBlackOverlay();
        this._fadeOverlay(
            GuideController._BLACK_OPAQUE,
            GuideController._BLACK_CLEAR,
            this.overlayRevealDuration,
            () => {
                this._hideOverlay();
                onComplete?.();
            },
        );
    }

    private _resolveOverlayNode(): Node | null {
        if (this.overlayNode?.isValid) return this.overlayNode;
        this.overlayNode = this.node.getChildByName('OverLay')
            ?? this.node.getChildByName('Overlay');
        return this.overlayNode;
    }

    private _overlaySprite(): Sprite | null {
        const node = this._resolveOverlayNode();
        if (!node) return null;
        let sp = node.getComponent(Sprite);
        if (!sp) {
            Log.w('[GuideController] OverLay thiếu Sprite — không fade được');
        }
        return sp;
    }

    /** Đưa OverLay lên trên cùng + bật full màn đen che nội dung Guide. */
    private _showOverlayOnTop(color: Color): void {
        const node = this._resolveOverlayNode();
        const sp = this._overlaySprite();
        if (!node || !sp) return;
        node.active = true;
        node.setSiblingIndex(this.node.children.length - 1);
        sp.color = color.clone();
    }

    private _hideOverlay(): void {
        this._stopOverlayTween();
        const node = this._resolveOverlayNode();
        if (node) node.active = false;
    }

    private _stopOverlayTween(): void {
        if (this._overlayTween) {
            this._overlayTween.stop();
            this._overlayTween = null;
        }
    }

    private _fadeOverlay(from: Color, to: Color, duration: number, onDone: () => void): void {
        const sp = this._overlaySprite();
        if (!sp || duration <= 0) {
            if (sp) sp.color = to.clone();
            onDone();
            return;
        }

        this._stopOverlayTween();
        sp.color = new Color(from.r, from.g, from.b, from.a);
        const target = new Color(to.r, to.g, to.b, to.a);
        this._overlayTween = tween(sp)
            .to(duration, { color: target })
            .call(() => {
                this._overlayTween = null;
                onDone();
            })
            .start() as Tween<Sprite>;
    }

    private _onGuideReady(): void {
        if (this.continueArea) {
            Log.d('[GuideController] continueArea node active:', this.continueArea.node.active,
                '| interactable:', this.continueArea.interactable,
                '| node name:', this.continueArea.node.name);
        } else {
            Log.w('[GuideController] continueArea is NULL — chưa assign trong Editor!');
        }

        for (const ps of this.particles) { if (ps) { ps.clear(); ps.play(); } }
        this._bindClicks();
        this._bindTabIconClicks();
        this._startCarouselAfterDelay();
    }

    private _startCarouselAfterDelay(): void {
        if (this.carouselDelay <= 0) {
            this._delayedStartCarousel();
        } else {
            this.scheduleOnce(this._delayedStartCarousel, this.carouselDelay);
        }
    }

    onDisable(): void {
        this._stopOverlayTween();
        Log.d('[GuideController] onDisable — node deactivated. _dismissed=' + this._dismissed);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        screen.off('window-resize', this._applyGuideLayout, this);
        screen.off('orientation-change', this._applyGuideLayout, this);
    }

    // ─── LOCALIZATION ───

    /** Gán text cho guideLabels dựa trên guideLabelKeys */
    private _setGuideLabels(): void {
        if (!this.guideLabels || !this.guideLabelKeys) return;
        for (let i = 0; i < this.guideLabels.length; i++) {
            const label = this.guideLabels[i];
            const key = this.guideLabelKeys[i];
            if (label && key) {
                label.string = L(key);
            }
        }
    }

    // ─── ORIENTATION ───

    /** Điều chỉnh Layout của guidePanel + update sprite frame các bg theo hướng màn hình */
    private _applyGuideLayout(): void {
        if (!this.guidePanel) return;
        const layout = this.guidePanel.getComponent(Layout);
        if (!layout) return;
        const size = screen.windowSize;
        const isPortrait = size.height > size.width;
        layout.type = isPortrait ? Layout.Type.VERTICAL : Layout.Type.HORIZONTAL;
        this._updateBgSprites(isPortrait);
    }

    /** Cập nhật spriteFrame cho tất cả bgNodes theo orientation (nếu có assign). */
    private _updateBgSprites(isPortrait: boolean): void {
        const frames = isPortrait ? this.bgPortraitFrames : this.bgLandscapeFrames;
        if (!frames || frames.length === 0 || frames.every((f) => !f)) return;
        for (let i = 0; i < this.bgNodes.length; i++) {
            const node = this.bgNodes[i];
            if (!node) continue;
            const frame = frames[i];
            if (!frame) continue;
            const sprite = node.getComponent(Sprite);
            if (sprite) sprite.spriteFrame = frame;
        }
    }

    private _applyCachedFrames(): boolean {
        const cached = GuideFrameLoader.cached;
        if (!cached) return false;
        this.bgPortraitFrames = cached.portrait.slice();
        this.bgLandscapeFrames = cached.landscape.slice();
        return true;
    }

    /** Reuse GuideFrameLoader cache — LoadingController preload trước bar 100%. */
    private _ensureGuideFrames(): Promise<void> {
        if (this._applyCachedFrames()) return Promise.resolve();
        const needPortrait = !this.bgPortraitFrames || this.bgPortraitFrames.length < GUIDE_PORTRAIT_PATHS.length
            || this.bgPortraitFrames.some((f) => !f);
        const needLandscape = !this.bgLandscapeFrames || this.bgLandscapeFrames.length < GUIDE_LANDSCAPE_PATHS.length
            || this.bgLandscapeFrames.some((f) => !f);
        if (!needPortrait && !needLandscape) return Promise.resolve();
        if (this._guideFramesPromise) return this._guideFramesPromise;

        this._guideFramesPromise = GuideFrameLoader.preload().then((frames) => {
            if (frames) this._applyCachedFrames();
            else Log.w('[GuideController] Guide frame load failed');
        });
        return this._guideFramesPromise;
    }

    /** Force ẩn HTML loading overlay ngay lập tức — tránh overlay còn sót khi GuideView hiện */
    private _forceHideHtmlOverlay(): void {
        if (typeof document === 'undefined') return;
        const overlay = document.getElementById('sn-loading-overlay') as HTMLElement | null;
        if (!overlay) return;
        overlay.style.transition = 'none';
        overlay.style.opacity = '0';
        overlay.classList.add('hidden');
        setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 50);
        const gif = document.getElementById('sn-loading-gif') as HTMLElement | null;
        const logo = document.getElementById('sn-loading-logo') as HTMLElement | null;
        if (gif) { gif.style.opacity = '0'; gif.style.transition = 'none'; }
        if (logo) { logo.style.opacity = '0'; logo.style.transition = 'none'; }
    }

    // ─── CLICK HANDLERS ───

    private _startContinueAreaZoom(): void {
        const node = this.continueLabel ? this.continueLabel.node : this.continueArea?.node;
        if (!node) return;
        const minScale = new Vec3(this.zoomMinScale, this.zoomMinScale, 1);
        const maxScale = new Vec3(this.zoomMaxScale, this.zoomMaxScale, 1);
        tween(node)
            .to(this.zoomDuration / 2, { scale: maxScale })
            .to(this.zoomDuration / 2, { scale: minScale })
            .union()
            .repeatForever()
            .start();
    }

    private _stopContinueAreaZoom(): void {
        const node = this.continueLabel ? this.continueLabel.node : this.continueArea?.node;
        if (!node) return;
        tween(node).stop();
        node.scale = new Vec3(1, 1, 1);
    }

    private _bindClicks(): void {
        this._forceHideHtmlOverlay(); // ★ Đảm bảo HTML overlay đã biến mất trước khi user click
        if (!this.continueArea) {
            Log.w('[GuideController] _bindClicks: continueArea is null!');
            return;
        }
        Log.d('[GuideController] _bindClicks — interactable:', this.continueArea.interactable,
            '| node active:', this.continueArea.node.active,
            '| node parent active:', this.continueArea.node.parent?.active);
       // this._startContinueAreaZoom();
        this.continueArea.node.on('click', this._onContinue, this);
    }
    

    private _unbindClicks(): void {
        if (!this.continueArea) return;
        Log.d('[GuideController] _unbindClicks');
        this._stopContinueAreaZoom();
        this.continueArea.node.off('click', this._onContinue, this);
    }

    private _startCarousel(): void {
        if (this._carouselActive || this.bgNodes.length === 0) return;
        this._carouselActive = true;
        this._currentBgIndex = 0;
        this._setupBgNodes();
        this._showBg(0, false);
    }

    private _stopCarousel(): void {
        this._carouselActive = false;
        this.unschedule(this._transitionToNext);
        this.unschedule(this._delayedStartCarousel);
        if (this._prevTween) { this._prevTween.stop(); this._prevTween = null; }
        if (this._nextTween) { this._nextTween.stop(); this._nextTween = null; }
        this._isTransitioning = false;
    }

    private _setupBgNodes(): void {
        if (this._prevTween) { this._prevTween.stop(); this._prevTween = null; }
        if (this._nextTween) { this._nextTween.stop(); this._nextTween = null; }
        if (!this.bgNodes) this.bgNodes = [];
        for (let i = 0; i < this.bgNodes.length; i++) {
            const node = this.bgNodes[i];
            if (!node) {
                Log.w(`[GuideController] _setupBgNodes — bgNodes[${i}] is NULL!`);
                continue;
            }
            node.setPosition(i === 0 ? Vec3.ZERO : new Vec3(5000, 0, 0));
            node.active = (i === 0); // ★ chỉ bg[0] active khi mới vào
            Log.d(`[GuideController] _setupBgNodes — bgNodes[${i}] name=${node.name} pos=${i===0?'ZERO':'(5000,0,0)'} active=${i===0}`);
        }
        if (this.bgNodes.length === 0) {
            Log.w(`[GuideController] _setupBgNodes — WARNING: no bgNodes assigned!`);
        }
    }

    private _activateAllBgNodes(): void {
        for (let i = 0; i < this.bgNodes.length; i++) {
            const node = this.bgNodes[i];
            if (!node) continue;
            node.setPosition(i === 0 ? Vec3.ZERO : new Vec3(5000, 0, 0));
            node.active = true;
        }
    }

    private _delayedStartCarousel(): void {
        Log.d(`[GuideController] ${this.carouselDelay}s delay done — activating all bg + starting carousel`);
        this._activateAllBgNodes();
        this._startCarousel();
    }

    private _showBg(index: number, animated: boolean): void {
        if (index < 0 || index >= this.bgNodes.length) return;
        if (this._isTransitioning) return;

        const prevIndex = this._currentBgIndex;
        this._currentBgIndex = index;

        this._updateTitle(index);
        this._updateTabIcons();
        const size = screen.windowSize;
        this._updateBgSprites(size.height > size.width);

        if (!animated || prevIndex === index) {
            if (this._prevTween) { this._prevTween.stop(); this._prevTween = null; }
            if (this._nextTween) { this._nextTween.stop(); this._nextTween = null; }
            for (let i = 0; i < this.bgNodes.length; i++) {
                const node = this.bgNodes[i];
                if (node) {
                    node.setPosition(i === index ? Vec3.ZERO : new Vec3(5000, 0, 0));
                    node.active = true; // đảm bảo node active nếu trước đó inactive
                }
            }
            this._scheduleNext();
            return;
        }

        this._isTransitioning = true;
        const prevNode = this.bgNodes[prevIndex];
        const nextNode = this.bgNodes[index];
        if (!prevNode || !nextNode) {
            this._isTransitioning = false;
            this._scheduleNext();
            return;
        }

        const uiTrans = prevNode.getComponent(UITransform);
        const slideDist = uiTrans ? uiTrans.contentSize.width : (screen.windowSize.width || 1280);

        if (this._prevTween) { this._prevTween.stop(); this._prevTween = null; }
        if (this._nextTween) { this._nextTween.stop(); this._nextTween = null; }

        nextNode.setPosition(new Vec3(slideDist, 0, 0));
        nextNode.active = true; // ★ active SAU setPosition, ở vị trí ngoài màn hình

        let finished = 0;
        const onFinish = (): void => {
            finished++;
            if (finished >= 2) {
                this._prevTween = null;
                this._nextTween = null;
                prevNode.setPosition(new Vec3(5000, 0, 0));
                nextNode.setPosition(Vec3.ZERO);
                this._isTransitioning = false;
                this._scheduleNext();
            }
        };

        this._prevTween = tween(prevNode)
            .set({ position: Vec3.ZERO })
            .to(this.slideDuration, { position: new Vec3(-slideDist, 0, 0) }, { easing: 'cubicInOut' })
            .call(onFinish)
            .start() as Tween<Node>;

        this._nextTween = tween(nextNode)
            .set({ position: new Vec3(slideDist, 0, 0) })
            .to(this.slideDuration, { position: Vec3.ZERO }, { easing: 'cubicInOut' })
            .call(onFinish)
            .start() as Tween<Node>;
    }

    private _scheduleNext(): void {
        if (!this._carouselActive) return;
        this.unschedule(this._transitionToNext);
        this.scheduleOnce(this._transitionToNext, this.carouselInterval);
    }

    private _transitionToNext(): void {
        if (!this._carouselActive || this._isTransitioning || this.bgNodes.length === 0) return;
        const nextIndex = (this._currentBgIndex + 1) % this.bgNodes.length;
        this._showBg(nextIndex, true);
    }

    private _updateTitle(index: number): void {
        if (!this.guideTitleLabel) return;
        const key = this.guideTitleKeys[index];
        this.guideTitleLabel.string = key ? L(key) : '';
    }

    private _updateTabIcons(): void {
        for (let i = 0; i < this.tabIcons.length; i++) {
            const icon = this.tabIcons[i];
            if (!icon) continue;
            const sprite = icon.getComponent(Sprite);
            if (!sprite) continue;
            const isFocus = (i === this._currentBgIndex);
            const frame = isFocus ? this.tabIconFocusFrame : this.tabIconNormalFrame;
            if (frame) sprite.spriteFrame = frame;
        }
    }

    private _bindTabIconClicks(): void {
        for (let i = 0; i < this.tabIcons.length; i++) {
            const icon = this.tabIcons[i];
            if (!icon) continue;
            icon.off(Node.EventType.TOUCH_END);
            icon.on(Node.EventType.TOUCH_END, () => {
                if (this._isTransitioning || i === this._currentBgIndex) return;
                this.unschedule(this._transitionToNext);
                this._showBg(i, true);
            }, this);
        }
    }

    private _onContinue(): void {
        this._stopCarousel();
        this._forceHideHtmlOverlay(); // ★ Đảm bảo overlay không còn khi chuyển sang game
        Log.d('[GuideController] _onContinue FIRED! Setting _dismissed=true');
        SoundManager.instance?.playButtonClick();
        this._unbindClicks();
        this._dismissed = true;  // ★ Đánh dấu đã dismiss — từ chối mọi onEnable tiếp theo

        // Emit ngay lập tức để GameEntryController ẩn sharedNode trước khi GuideView fade
        EventBus.instance.emit(GameEvents.GUIDE_CONTINUE);
        
        // Ẩn RandomParticleSpawner node ngay lập tức
        if (this.randomParticleSpawnerNode) {
            this.randomParticleSpawnerNode.active = false;
        }

        const finish = () => {
            // Giữ GuideView + overlay đen — LoadingController dismiss sau khi GameRoot bắt đầu fade in
            const hold = Math.max(0, this.overlayHoldBlackSecs);
            const emit = () => EventBus.instance.emit(GameEvents.GUIDE_COMPLETE);
            if (hold <= 0) emit();
            else this.scheduleOnce(emit, hold);
        };

        for (const ps of this.particles) { if (ps) ps.clear(); }
        if (this.randomParticleSpawnerNode) {
            this.randomParticleSpawnerNode.active = false;
        }

        const sp = this._overlaySprite();
        if (!sp) {
            finish();
            return;
        }

        this._showOverlayOnTop(GuideController._BLACK_CLEAR);
        this._fadeOverlay(
            GuideController._BLACK_CLEAR,
            GuideController._BLACK_OPAQUE,
            this.overlayFadeOutDuration,
            finish,
        );
    }
}
