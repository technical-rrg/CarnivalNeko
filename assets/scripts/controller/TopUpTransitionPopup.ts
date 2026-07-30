import { _decorator, Component, Node, tween, UIOpacity, BlockInputEvents, Tween, sp, Sprite, Color, screen, assetManager, view } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { Log } from '../core/Logger';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

const BUNDLE_NAME = 'MainBundle';

export enum TransitionMode {
    FreeSpin = 0,
    TopUp = 1,
    PickGame = 2,
}

@ccclass('TopUpTransitionPopup')
export class TopUpTransitionPopup extends Component {

    @property({ type: Node, tooltip: 'Fill đen phủ toàn màn hình — fade in/out bằng UIOpacity (không fade alpha content).' })
    overlayNode: Node | null = null;

    @property({ type: Node, tooltip: 'Node effect transition (chứa spine) — hiện full opacity, không fade alpha.' })
    effectNode: Node | null = null;

    @property({ type: sp.Skeleton, tooltip: 'Spine màn NGANG — để trống skeletonData, lazy-load khi show.' })
    spineLandscape: sp.Skeleton | null = null;

    @property({ type: sp.Skeleton, tooltip: 'Spine màn DỌC — để trống skeletonData, lazy-load khi show.' })
    spinePortrait: sp.Skeleton | null = null;

    @property({ tooltip: 'Path SkeletonData landscape trong MainBundle (không extension).' })
    skeletonPathLandscape: string = 'newAnimations/Anim-Transition-Feature/TransitionFeature-Landscape';

    @property({ tooltip: 'Path SkeletonData portrait trong MainBundle (không extension).' })
    skeletonPathPortrait: string = 'newAnimations/Anim-Transition-Feature/TransitionFeature-Portrait';

    @property({ group: { name: 'Anim Landscape', id: 'anim-l' }, tooltip: 'Tên anim PickGame — màn ngang.' })
    animPickGameLandscape: string = 'Pickgame';

    @property({ group: { name: 'Anim Landscape', id: 'anim-l' }, tooltip: 'Tên anim FreeSpin — màn ngang.' })
    animFreeSpinLandscape: string = 'freespins';

    @property({ group: { name: 'Anim Landscape', id: 'anim-l' }, tooltip: 'Tên anim TopUp — màn ngang.' })
    animTopUpLandscape: string = 'Topupbonus';

    @property({ group: { name: 'Anim Portrait', id: 'anim-p' }, tooltip: 'Tên anim PickGame — màn dọc.' })
    animPickGamePortrait: string = 'Pickgame';

    @property({ group: { name: 'Anim Portrait', id: 'anim-p' }, tooltip: 'Tên anim FreeSpin — màn dọc.' })
    animFreeSpinPortrait: string = 'Freespins';

    @property({ group: { name: 'Anim Portrait', id: 'anim-p' }, tooltip: 'Tên anim TopUp — màn dọc.' })
    animTopUpPortrait: string = 'Topupbonus';

    @property({ tooltip: 'Thời gian giữ effect ở giữa SAU khi fade-in xong (giây).' })
    duration: number = 1.0;

    @property({ tooltip: 'Fade-in fill đen: Normal → đen kín (giây).' })
    fadeDuration: number = 0.35;

    @property({ tooltip: 'Fade-out fill đen: đen tan → lộ Transition / đóng popup (giây).' })
    fadeOutDuration: number = 0.5;

    private _closed: boolean = false;
    private _readyEmitted: boolean = false;
    private _doneEmitted: boolean = false;
    private _currentMode: TransitionMode = TransitionMode.TopUp;
    private _showGen: number = 0;
    /** Huỷ apply spine async cũ khi có play mới (tránh race landscape ghi đè portrait). */
    private _playGen: number = 0;
    /** Orientation đang dùng cho spine hiện tại — null khi popup đóng. */
    private _activeIsLandscape: boolean | null = null;

    private _skelDataLandscape: sp.SkeletonData | null = null;
    private _skelDataPortrait: sp.SkeletonData | null = null;
    private _loadingLandscape: Promise<sp.SkeletonData | null> | null = null;
    private _loadingPortrait: Promise<sp.SkeletonData | null> | null = null;

    onLoad(): void {
        if (!this.node.getComponent(BlockInputEvents)) {
            this.node.addComponent(BlockInputEvents);
        }
        EventBus.instance.on(GameEvents.TOPUP_TRANSITION_SHOW, this._show, this);
        screen.on('window-resize', this._onOrientationChange, this);
        screen.on('orientation-change', this._onOrientationChange, this);
        this.node.active = false;
        if (this.overlayNode) this.overlayNode.active = false;
        if (this.effectNode) this.effectNode.active = false;
        this._hideAllSpines();
        this._currentMode = TransitionMode.TopUp;
    }

    onDestroy(): void {
        screen.off('window-resize', this._onOrientationChange, this);
        screen.off('orientation-change', this._onOrientationChange, this);
        EventBus.instance.offTarget(this);
    }

    private _ensureOpacity(node: Node): UIOpacity {
        return node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    }

    /** Sprite fill đen đặc (a=255) — fade chỉ qua UIOpacity, không đụng color.a. */
    private _prepareBlackFill(node: Node): UIOpacity {
        const spr = node.getComponent(Sprite);
        if (spr) spr.color = new Color(0, 0, 0, 255);
        return this._ensureOpacity(node);
    }

    private _stopFadeTweens(): void {
        if (this.overlayNode) {
            Tween.stopAllByTarget(this.overlayNode);
            const overlayOp = this.overlayNode.getComponent(UIOpacity);
            if (overlayOp) Tween.stopAllByTarget(overlayOp);
        }
        if (this.effectNode) {
            Tween.stopAllByTarget(this.effectNode);
            const effectOp = this.effectNode.getComponent(UIOpacity);
            if (effectOp) Tween.stopAllByTarget(effectOp);
        }
    }

    /**
     * Dùng design resolution (ResponsiveController: portrait = 1080x1920, landscape = 1920x1080).
     * Không dùng windowSize — trên một số máy/browser window vẫn ngang dù design đã dọc.
     */
    private _isLandscape(): boolean {
        const ds = view.getDesignResolutionSize();
        if (ds.width > 0 && ds.height > 0) {
            // 1080x1920 → portrait; 1920x1080 → landscape
            return ds.width > ds.height;
        }
        const ws = screen.windowSize;
        return ws.width > ws.height;
    }

    private _skeletonPathFor(isLandscape: boolean): string {
        const raw = isLandscape ? this.skeletonPathLandscape : this.skeletonPathPortrait;
        return (raw || '').trim();
    }

    private _hideAllSpines(): void {
        if (this.spineLandscape) {
            this.spineLandscape.clearTracks();
            this.spineLandscape.node.active = false;
        }
        if (this.spinePortrait && this.spinePortrait !== this.spineLandscape) {
            this.spinePortrait.clearTracks();
            this.spinePortrait.node.active = false;
        }
    }

    /** Prefab share 1 Skeleton — xoá data cũ để lần show không giữ Landscape khi đang Portrait. */
    private _clearSharedSkeletonData(): void {
        const shared = !!this.spineLandscape && this.spineLandscape === this.spinePortrait;
        if (!shared || !this.spineLandscape) return;
        this.spineLandscape.clearTracks();
        this.spineLandscape.skeletonData = null!;
    }

    private _getAnimName(mode: TransitionMode, isLandscape: boolean): string {
        if (isLandscape) {
            switch (mode) {
                case TransitionMode.PickGame: return (this.animPickGameLandscape || '').trim();
                case TransitionMode.FreeSpin: return (this.animFreeSpinLandscape || '').trim();
                default: return (this.animTopUpLandscape || '').trim();
            }
        }
        switch (mode) {
            case TransitionMode.PickGame: return (this.animPickGamePortrait || '').trim();
            case TransitionMode.FreeSpin: return (this.animFreeSpinPortrait || '').trim();
            default: return (this.animTopUpPortrait || '').trim();
        }
    }

    private _ensureSkeletonData(isLandscape: boolean): Promise<sp.SkeletonData | null> {
        const cached = isLandscape ? this._skelDataLandscape : this._skelDataPortrait;
        if (cached) {
            Log.d(`[TopUpTransitionPopup] Cache hit ${isLandscape ? 'LANDSCAPE' : 'PORTRAIT'} → ${this._skeletonPathFor(isLandscape)}`);
            return Promise.resolve(cached);
        }

        const inflight = isLandscape ? this._loadingLandscape : this._loadingPortrait;
        if (inflight) return inflight;

        const path = this._skeletonPathFor(isLandscape);
        if (!path) {
            Log.w(`[TopUpTransitionPopup] Empty skeleton path (${isLandscape ? 'landscape' : 'portrait'})`);
            return Promise.resolve(null);
        }

        // Chặn nhầm path: portrait mode không được load file Landscape và ngược lại
        const lower = path.toLowerCase();
        if (isLandscape && lower.includes('portrait')) {
            Log.e(`[TopUpTransitionPopup] Path SAI — landscape nhưng path có Portrait: ${path}`);
        }
        if (!isLandscape && lower.includes('landscape')) {
            Log.e(`[TopUpTransitionPopup] Path SAI — portrait nhưng path có Landscape: ${path}`);
        }

        const bundle = assetManager.getBundle(BUNDLE_NAME);
        if (!bundle) {
            Log.w(`[TopUpTransitionPopup] Bundle '${BUNDLE_NAME}' missing — cannot lazy-load ${path}`);
            return Promise.resolve(null);
        }

        Log.d(`[TopUpTransitionPopup] Loading SkeletonData ${isLandscape ? 'LANDSCAPE' : 'PORTRAIT'} → ${path}`);

        const promise = new Promise<sp.SkeletonData | null>((resolve) => {
            bundle.load(path, sp.SkeletonData, (err, data) => {
                if (isLandscape) this._loadingLandscape = null;
                else this._loadingPortrait = null;

                if (err || !data) {
                    Log.w(`[TopUpTransitionPopup] SkeletonData load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                if (isLandscape) this._skelDataLandscape = data;
                else this._skelDataPortrait = data;
                Log.d(`[TopUpTransitionPopup] Loaded OK: ${path}`);
                resolve(data);
            });
        });

        if (isLandscape) this._loadingLandscape = promise;
        else this._loadingPortrait = promise;
        return promise;
    }

    /** Xoay màn khi popup đang mở → đổi spine ngang/dọc, giữ tiến độ anim nếu có. */
    private _onOrientationChange(): void {
        if (this._closed || !this.node.active) return;
        // Effect chưa reveal vẫn cho preload/swap data theo orientation mới
        const isLandscape = this._isLandscape();
        if (this._activeIsLandscape === isLandscape) return;
        void this._playSpineForMode(this._currentMode, this._showGen, true);
    }

    private _readActiveTrackTime(): number {
        // Prefab có thể gán chung 1 Skeleton cho cả 2 slot — đọc từ component đang active
        const current = this._activeIsLandscape === true
            ? this.spineLandscape
            : this._activeIsLandscape === false
                ? this.spinePortrait
                : (this.spineLandscape ?? this.spinePortrait);
        const track = current?.getCurrent(0);
        return track?.trackTime ?? 0;
    }

    /**
     * Lấy SkeletonData đúng orientation.
     * Không dùng active.skeletonData làm nguồn chính — prefab đang share 1 Skeleton,
     * skeletonData cũ (orientation trước) sẽ chặn việc load/swap sang file kia.
     */
    private async _resolveSkeletonData(
        active: sp.Skeleton,
        isLandscape: boolean,
    ): Promise<sp.SkeletonData | null> {
        const cached = isLandscape ? this._skelDataLandscape : this._skelDataPortrait;
        if (cached) return cached;

        const loaded = await this._ensureSkeletonData(isLandscape);
        if (loaded) return loaded;

        // Fallback: 2 spine riêng + data gán sẵn trong Editor
        const shared = this.spineLandscape === this.spinePortrait;
        if (!shared && active.skeletonData) {
            if (isLandscape) this._skelDataLandscape = active.skeletonData;
            else this._skelDataPortrait = active.skeletonData;
            return active.skeletonData;
        }
        return null;
    }

    /**
     * @param preserveProgress true khi đổi orientation giữa chừng — seek anim tới cùng thời điểm.
     */
    private async _playSpineForMode(
        mode: TransitionMode,
        showGen: number,
        preserveProgress: boolean = false,
    ): Promise<void> {
        const playGen = ++this._playGen;
        const isLandscape = this._isLandscape();
        const path = this._skeletonPathFor(isLandscape);
        const active = isLandscape ? this.spineLandscape : this.spinePortrait;
        const inactive = isLandscape ? this.spinePortrait : this.spineLandscape;
        const resumeAt = preserveProgress ? this._readActiveTrackTime() : 0;
        const shared = !!active && active === inactive;
        const ds = view.getDesignResolutionSize();
        const ws = screen.windowSize;

        Log.d(
            `[TopUpTransitionPopup] Play spine → ${isLandscape ? 'LANDSCAPE' : 'PORTRAIT'} path=${path} ` +
            `design=${ds.width}x${ds.height} window=${ws.width}x${ws.height}`,
        );

        // Chỉ ẩn spine kia khi là 2 component khác nhau
        if (inactive && !shared) {
            inactive.clearTracks();
            inactive.node.active = false;
        }

        if (!active) {
            Log.w(`[TopUpTransitionPopup] Missing spine (${isLandscape ? 'landscape' : 'portrait'})`);
            return;
        }

        const data = await this._resolveSkeletonData(active, isLandscape);

        // Stale async (play mới hơn đã chạy) / popup đóng / orientation đổi lúc load
        if (playGen !== this._playGen) return;
        if (this._closed || showGen !== this._showGen || !active.isValid) return;
        if (this._isLandscape() !== isLandscape) {
            void this._playSpineForMode(mode, showGen, preserveProgress);
            return;
        }

        if (!data) {
            Log.w(`[TopUpTransitionPopup] No skeletonData for ${isLandscape ? 'landscape' : 'portrait'} (${path})`);
            return;
        }

        // Prefab share 1 Skeleton: luôn clear + gán lại để không giữ asset orientation cũ
        active.clearTracks();
        if (active.skeletonData !== data) {
            active.skeletonData = null!;
            active.skeletonData = data;
        }

        const animName = this._getAnimName(mode, isLandscape);
        active.node.active = true;
        active.clearTrack(0);
        this._activeIsLandscape = isLandscape;

        if (animName && active.findAnimation(animName)) {
            const entry = active.setAnimation(0, animName, false);
            if (entry && resumeAt > 0) {
                const duration = (entry.animation as { duration?: number } | null)?.duration ?? 0;
                entry.trackTime = duration > 0 ? Math.min(resumeAt, Math.max(0, duration - 0.001)) : resumeAt;
            }
            // Chỉ play SFX lần đầu show — không play lại khi đổi orientation giữa chừng.
            if (!preserveProgress) {
                SoundManager.instance?.playPickGame();
            }
            Log.d(`[TopUpTransitionPopup] Spine OK ${isLandscape ? 'landscape' : 'portrait'} → "${animName}" @${resumeAt.toFixed(2)}s`);
        } else {
            Log.w(`[TopUpTransitionPopup] Missing anim "${animName}" on ${isLandscape ? 'landscape' : 'portrait'} spine`);
        }
    }

    private _forceClose(): void {
        if (this._closed) return;
        this._closed = true;
        this._activeIsLandscape = null;
        this._playGen++;
        this.unscheduleAllCallbacks();
        this._stopFadeTweens();
        this._hideAllSpines();
        this._clearSharedSkeletonData();

        if (this.effectNode) {
            this.effectNode.active = false;
            const effectOp = this.effectNode.getComponent(UIOpacity);
            if (effectOp) effectOp.opacity = 255;
        }

        if (this.overlayNode) {
            this.overlayNode.active = false;
            const overlayOp = this.overlayNode.getComponent(UIOpacity);
            if (overlayOp) overlayOp.opacity = 255;
        }

        this.node.active = false;
        this._emitDone();
    }

    /** Overlay đã phủ kín — cho phép đổi UI mode bên dưới. */
    private _emitReady(): void {
        if (this._closed || this._readyEmitted) return;
        this._readyEmitted = true;
        EventBus.instance.emit(GameEvents.TOPUP_TRANSITION_READY, this._currentMode);
    }

    /** Mode mới (PickGame…) setup dưới overlay — gọi trước khi tan đen để tránh hiện 2 lần. */
    private _emitDone(): void {
        if (this._doneEmitted) return;
        this._doneEmitted = true;
        EventBus.instance.emit(GameEvents.TOPUP_TRANSITION_DONE);
    }

    /** Đưa TransitionPopup lên trên cùng parent — tránh bị PickGame/popup khác che mất fade. */
    private _bringToFront(): void {
        const parent = this.node.parent;
        if (!parent) return;
        this.node.setSiblingIndex(parent.children.length - 1);
    }

    /**
     * Sau fade-in (màn đã đen kín):
     * 1) READY — đổi UI dưới overlay
     * 2) Bật effect/spine DƯỚI overlay
     * 3) Fade overlay 255→0 — đen mất dần, Transition hiện ra từ từ
     * 4) Hold → fade-out đóng
     */
    private _revealEffectAndHold(mode: TransitionMode, showGen: number, holdTime: number): void {
        if (this._closed || showGen !== this._showGen) return;

        // Đổi UI khi đang đen kín — không lộ Normal/PickGame
        this._emitReady();

        const target = this.effectNode;
        const overlay = this.overlayNode;
        const revealFade = Math.max(0.05, this.fadeOutDuration);

        if (target) {
            target.active = true;
            const targetOp = this._ensureOpacity(target);
            targetOp.opacity = 255;
            // Effect dưới Overlay — overlay tan ra sẽ lộ Transition dần
            target.setSiblingIndex(0);
        }

        if (overlay) {
            overlay.active = true;
            overlay.setSiblingIndex(this.node.children.length - 1);
        }

        // Delay 1 frame: chờ ResponsiveController apply design size sau xoay, rồi mới chọn spine
        this.scheduleOnce(() => {
            if (this._closed || showGen !== this._showGen) return;
            void this._playSpineForMode(mode, showGen);
        }, 0);

        if (overlay) {
            const overlayOp = this._prepareBlackFill(overlay);
            overlayOp.opacity = 255;
            tween(overlayOp)
                .to(revealFade, { opacity: 0 }, { easing: 'sineIn' })
                .call(() => {
                    if (this._closed || showGen !== this._showGen) return;
                    this.scheduleOnce(() => this._fadeOutAndClose(), holdTime);
                })
                .start();
        } else {
            this.scheduleOnce(() => this._fadeOutAndClose(), holdTime);
        }
    }

    private _show(mode: TransitionMode = TransitionMode.TopUp): void {
        this._closed = false;
        this._readyEmitted = false;
        this._doneEmitted = false;
        this._activeIsLandscape = null;
        this._showGen++;
        this._playGen++; // invalidate mọi _playSpineForMode đang await
        const showGen = this._showGen;
        this.unscheduleAllCallbacks();
        this._stopFadeTweens();
        this._currentMode = mode;

        const fadeIn = Math.max(0.05, this.fadeDuration);
        const holdTime = Math.max(0.15, this.duration);

        this.node.active = true;
        this._bringToFront();

        // Ẩn effect trong lúc đen phủ vào từ Normal
        if (this.effectNode) {
            this.effectNode.active = false;
            this._hideAllSpines();
        }
        // Xoá skeletonData cũ trên shared Skeleton (tránh show Landscape khi đang Portrait)
        this._clearSharedSkeletonData();

        // Preload orientation hiện tại trước, chiều kia sau — giảm race gắn nhầm asset
        const nowLandscape = this._isLandscape();
        void this._ensureSkeletonData(nowLandscape);
        void this._ensureSkeletonData(!nowLandscape);

        if (this.overlayNode) {
            this.overlayNode.active = true;
            this.overlayNode.setSiblingIndex(this.node.children.length - 1);

            const overlayOp = this._prepareBlackFill(this.overlayNode);
            overlayOp.opacity = 0;
            // Bước 1: Normal → đen kín
            tween(overlayOp)
                .to(fadeIn, { opacity: 255 }, { easing: 'sineOut' })
                .call(() => this._revealEffectAndHold(mode, showGen, holdTime))
                .start();
        } else {
            this._revealEffectAndHold(mode, showGen, holdTime);
        }

        // Fallback READY nếu tween bị interrupt
        this.scheduleOnce(() => this._emitReady(), fadeIn + 0.05);
    }

    /**
     * Đóng: KHÔNG phủ đen lại (đã tan đen lúc reveal Transition).
     * DONE trước → PickGame setup dưới Transition → fade effect → lộ PickGame.
     */
    private _fadeOutAndClose(): void {
        if (this._closed) return;

        const fadeOut = Math.max(0.05, this.fadeOutDuration);
        this._bringToFront();

        // Overlay giữ trong suốt — tránh nháy đen thêm lần nữa
        if (this.overlayNode) {
            const overlayOp = this.overlayNode.getComponent(UIOpacity);
            if (overlayOp) {
                Tween.stopAllByTarget(overlayOp);
                overlayOp.opacity = 0;
            }
        }

        // PickGame/UI sẵn dưới Transition trước khi effect tan
        this._emitDone();

        const target = this.effectNode;
        if (target?.active) {
            target.setSiblingIndex(this.node.children.length - 1);
            const effectOp = this._ensureOpacity(target);
            Tween.stopAllByTarget(effectOp);
            effectOp.opacity = 255;
            tween(effectOp)
                .to(fadeOut, { opacity: 0 }, { easing: 'sineIn' })
                .call(() => this._forceClose())
                .start();
        } else {
            this._forceClose();
        }
    }
}
