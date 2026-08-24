/**
 * TransitionController - Hiệu ứng transition giữa Guide và GameView.
 *
 * Flow Guide (mặc định — useSimpleSpineTransition):
 *   Guide fade đen → Transition fade in → gán spine + play "1"
 *   → GameView sẵn bên dưới → fade spine color.a 255→0 → TRANSITION_DONE
 *
 * Flow legacy (useSimpleSpineTransition = false):
 *   icon bay tới Pot → handoff chest → TRANSITION_DONE
 */

import { _decorator, Component, UIOpacity, tween, Tween, Node, Vec3, ParticleSystem, easing, sp, screen, assetManager, view } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { SKIP_GUIDE_TRANSITION } from '../data/ServerConfig';
import { SoundManager } from '../manager/SoundManager';
import { Log } from '../core/Logger';
import { PotController } from './PotController';
import { OrientationLayout } from './OrientationLayout';

const { ccclass, property } = _decorator;

const MAIN_BUNDLE = 'MainBundle';

@ccclass('TransitionController')
export class TransitionController extends Component {

    @property({ type: UIOpacity, tooltip: 'UIOpacity của root Transition (legacy / fallback fade)' })
    uiOpacity: UIOpacity | null = null;

    @property({
        type: Node,
        tooltip: 'Overlay nền tối (kéo node Overlay/Background vào).\nCần có UIOpacity — nếu chưa có sẽ tự add lúc runtime.',
    })
    overlayNode: Node | null = null;

    @property({ type: Node, tooltip: 'Icon node để hiển thị hiệu ứng bay' })
    iconNode: Node | null = null;

    @property({ type: Node, tooltip: 'Target node - nơi icon bay vào' })
    targetNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node (chứa nhiều particle con) - hiển thị khi iconNode zoom tới max (mặc định inactive)' })
    effectNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node 2 - hiển thị particle khi icon bay tới đích (mặc định inactive)' })
    effectNode2: Node | null = null;

    @property({ tooltip: 'Thời gian zoom in của icon (giây)' })
    iconZoomInDuration: number = 0.3;

    @property({ tooltip: 'Thời gian giữ Pot trên màn hình trước khi bay về đích (giây)' })
    holdBeforeFlyDuration: number = 1.0;

    @property({ tooltip: 'Thời gian icon bay vào target (giây) — gồm nhún → bay lên → hạ xuống' })
    iconFlyDuration: number = 2.0;

    @property({ tooltip: 'Độ nhún xuống nhẹ trước khi bay (local Y, pixel)' })
    flyDipOffset: number = 70;

    @property({ tooltip: 'Độ cao bay phía trên Pot trước khi hạ xuống (local Y, pixel)' })
    flyArcHeight: number = 200;

    @property({ tooltip: 'Thời gian zoom out của icon (giây)' })
    iconZoomOutDuration: number = 0.3;

    @property({ tooltip: 'Thời gian fade in overlay khi mở (giây)' })
    fadeInDuration: number = 0.2;

    @property({ tooltip: 'Thời gian giữ sau khi icon tới đích, trước khi fade overlay (giây)' })
    holdDuration: number = 1.0;

    @property({ tooltip: 'Thời gian overlay fade out trước khi ẩn (giây)' })
    fadeOutDuration: number = 0.9;

    @property({ type: Node, tooltip: 'Flash node (Sprite) — fade alpha khi ẩn, không tắt ngay' })
    flashNode: Node | null = null;

    @property({ tooltip: 'Thời gian flash fade out (giây)' })
    flashFadeOutDuration: number = 0.3;

    @property({
        tooltip: 'Guide intro: fade + spine Anim (Transition_L). false = chest bay vào Pot (legacy).',
    })
    useSimpleSpineTransition: boolean = true;

    @property({
        type: Node,
        tooltip: 'Node Anim (Spine Transition_L). Để trống = dùng iconNode hoặc child "Anim".',
    })
    animNode: Node | null = null;

    @property({ tooltip: 'Fallback tên clip khi lấy duration (prefab tự play defaultAnimation).' })
    spineAnimName: string = '1';

    @property({ type: sp.Skeleton, tooltip: 'Spine màn NGANG (Anim_L / Transition_L). Lazy-load nếu chưa gán data.' })
    spineLandscape: sp.Skeleton | null = null;

    @property({ type: sp.Skeleton, tooltip: 'Spine màn DỌC (Anim_P / Transition_P). Lazy-load nếu chưa gán data.' })
    spinePortrait: sp.Skeleton | null = null;

    @property({ tooltip: 'Path SkeletonData landscape trong MainBundle (không extension).' })
    skeletonPathLandscape: string = 'newSpine/Transition_L/Anim-Transition_L';

    @property({ tooltip: 'Path SkeletonData portrait trong MainBundle (không extension).' })
    skeletonPathPortrait: string = 'newSpine/Transition_P/Anim-Transition_P';

    private _isPlaying: boolean = false;
    private _finishCb: (() => void) | null = null;
    private _pendingPot: PotController | null = null;
    private _guideCompleteCb: (() => void) | null = null;
    private _simpleSpineDoneCb: (() => void) | null = null;
    /** true khi clip spine guide đang chạy — xoay màn lúc này bỏ qua, không swap spine. */
    private _simpleSpinePlaying: boolean = false;
    private _activeSimpleIsLandscape: boolean | null = null;
    private _simpleSpinePlayGen: number = 0;
    /** Tween target cho fade spine alpha (không dùng UIOpacity). */
    private _spineFade = { a: 255 };
    /** GameRoot — set opacity 255 khi Transition che kín, trước spine alpha fade. */
    private _gameRootRef: Node | null = null;
    private _skelDataLandscape: sp.SkeletonData | null = null;
    private _skelDataPortrait: sp.SkeletonData | null = null;
    private _loadingLandscape: Promise<sp.SkeletonData | null> | null = null;
    private _loadingPortrait: Promise<sp.SkeletonData | null> | null = null;

    /** true từ lúc bắt đầu dip/fly đến khi hạ cánh */
    private _flyActive: boolean = false;
    /** true sau khi icon đã hạ cánh (hold / fade) */
    private _hasLanded: boolean = false;
    private _landedSkel: sp.Skeleton | null = null;

    private readonly _targetLocalPos = new Vec3();
    private readonly _abovePotPos = new Vec3();
    private readonly _targetLocalScale = new Vec3();
    private readonly _midScale = new Vec3();

    // ─── LIFECYCLE ───

    onLoad(): void {
        // Không set active=false ở đây — lần đầu bật node (triggerGuideTransition) sẽ chạy onLoad
        // và nếu tắt lại thì Transition không hiện. TransitionLoader giữ inactive sau instantiate.
        this._autoBindSimpleSpines();
        this._holdSimpleSpinesUntilPlay();
        void this._ensureSimpleSkeletonData(this._isLandscape());
        EventBus.instance.on(GameEvents.GUIDE_COMPLETE, this._onGuideComplete, this);
        screen.on('window-resize', this._onScreenChange, this);
        screen.on('orientation-change', this._onScreenChange, this);
    }

    onDestroy(): void {
        this._cleanupRunningTweens();
        this.unschedule(this._retargetFlyAfterLayout);
        this.unschedule(this._retargetFlyAfterLayoutLate);
        screen.off('window-resize', this._onScreenChange, this);
        screen.off('orientation-change', this._onScreenChange, this);
        EventBus.instance.offTarget(this);
    }

    /**
     * Xoay màn:
     * - Simple spine: bỏ qua nếu anim đang chạy; trước khi play thì startSpine tự chọn đúng orientation.
     * - Legacy chest fly: retarget Pot như cũ.
     */
    private _onScreenChange(): void {
        if (!this._isPlaying) return;

        if (this.useSimpleSpineTransition) {
            if (this._simpleSpinePlaying) {
                Log.d('[TransitionController] orientation ignored — simple spine anim playing');
            }
            return;
        }

        this._forceTargetLayoutNow();
        this.unschedule(this._retargetFlyAfterLayout);
        this.unschedule(this._retargetFlyAfterLayoutLate);
        this.scheduleOnce(this._retargetFlyAfterLayout, 0);
        this.scheduleOnce(this._retargetFlyAfterLayoutLate, 0.05);
    }

    private _retargetFlyAfterLayoutLate = (): void => {
        this._retargetFlyAfterLayout();
    };

    /** Refresh target từ Pot + apply OrientationLayout trên chuỗi parent. */
    private _forceTargetLayoutNow(): void {
        this._refreshTargetFromPot();
        let cur: Node | null = this.targetNode;
        for (let i = 0; i < 8 && cur?.isValid; i++) {
            const layout = cur.getComponent(OrientationLayout);
            if (layout) layout.applyOrientation();
            cur = cur.parent;
        }
    }

    private _refreshTargetFromPot(): void {
        const pot = this._pendingPot?.isValid ? this._pendingPot : this._findPotController();
        if (!pot?.isValid) return;
        const t = pot.getTransitionTargetNode();
        if (t?.isValid) this.targetNode = t;
        this._pendingPot = pot;
    }

    private _retargetFlyAfterLayout = (): void => {
        if (!this._isPlaying || !this.iconNode?.isValid) return;

        this._forceTargetLayoutNow();
        if (!this.targetNode?.isValid) return;

        this._computeFlyTarget();

        // Đã hạ cánh: snap icon + effect về Pot mới
        if (this._hasLanded) {
            this.iconNode.setPosition(this._targetLocalPos);
            this.iconNode.setScale(this._targetLocalScale);
            if (this.effectNode2?.isValid && this.effectNode2.active) {
                this.effectNode2.setWorldPosition(this.targetNode.getWorldPosition());
            }
            Log.d('[TransitionController] snap landed chest to new Pot pos after rotate');
            return;
        }

        // Đang bay: dừng tween cũ, bay tiếp từ vị trí hiện tại tới Pot mới (bỏ nhún)
        if (this._flyActive) {
            this._startChestFlyPath(0.45, true);
            Log.d(
                `[TransitionController] retarget fly → local(${this._targetLocalPos.x.toFixed(1)}, ${this._targetLocalPos.y.toFixed(1)})`,
            );
        }
        // Zoom / hold: _startChestFlyPath sẽ _computeFlyTarget lại khi bắt đầu bay
    };

    /** Gọi từ TransitionLoader sau wire Pot. */
    setGameRootRef(node: Node | null): void {
        this._gameRootRef = node;
    }

    /** GameRoot opacity 255 — phải gọi TRƯỚC khi spine alpha fade để GameView lộ dần bên dưới. */
    private _showGameRootUnderTransition(): void {
        const root = this._gameRootRef;
        if (root?.isValid) {
            let op = root.getComponent(UIOpacity);
            if (!op) op = root.addComponent(UIOpacity);
            Tween.stopAllByTarget(op);
            op.opacity = 255;
        }
        EventBus.instance.emit(GameEvents.GAME_VIEW_READY_UNDER_TRANSITION);
    }

    // ─── TRANSITION EFFECT ───

    private _onGuideComplete(): void {
        // Guide-first / skip Transition: GameEntryController xử lý vào game
        if (GameData.instance.guideFirstBoot || SKIP_GUIDE_TRANSITION) return;
        this._startGuideTransition();
    }

    triggerGuideTransition(onComplete?: () => void): void {
        this._guideCompleteCb = onComplete ?? null;
        this._startGuideTransition();
    }

    private _startGuideTransition(): void {
        if (this._isPlaying) return;
        this._isPlaying = true;
        this._autoBindSimpleSpines();
        this._holdSimpleSpinesUntilPlay();
        this.node.active = true;

        if (this.useSimpleSpineTransition) {
            this._holdSimpleSpinesUntilPlay();
            this._playSimpleSpineTransition();
            return;
        }

        this._resetOverlayOpacity(255);
        SoundManager.instance?.playNormalIntro();
        this.playIconFlyAnimation();
    }

    // ─── SIMPLE SPINE (Guide → GameView) ───────────────────────────────────

    private _isLandscape(): boolean {
        const ds = view.getDesignResolutionSize();
        if (ds.width > 0 && ds.height > 0) return ds.width > ds.height;
        const ws = screen.windowSize;
        return ws.width > ws.height;
    }

    private _autoBindSimpleSpines(): void {
        if (!this.spineLandscape?.isValid) {
            const node = this.node.getChildByName('Anim_L')
                ?? this.node.getChildByName('Anim')
                ?? this._resolveAnimNode();
            this.spineLandscape = node?.getComponent(sp.Skeleton)
                ?? node?.getComponentInChildren(sp.Skeleton)
                ?? null;
        }
        if (!this.spinePortrait?.isValid) {
            const node = this.node.getChildByName('Anim_P')
                ?? this.node.getChildByName('Anim');
            this.spinePortrait = node?.getComponent(sp.Skeleton)
                ?? node?.getComponentInChildren(sp.Skeleton)
                ?? null;
        }
        if (this.spineLandscape?.isValid && !this.spinePortrait?.isValid) {
            this.spinePortrait = this.spineLandscape;
        }
    }

    private _resolveAnimNode(): Node | null {
        if (this.animNode?.isValid) return this.animNode;
        if (this.iconNode?.isValid) return this.iconNode;
        return this.node.getChildByName('Anim');
    }

    private _skeletonPathFor(isLandscape: boolean): string {
        const raw = isLandscape ? this.skeletonPathLandscape : this.skeletonPathPortrait;
        return (raw || '').trim();
    }

    private _hideInactiveSimpleSpine(active: sp.Skeleton | null, inactive: sp.Skeleton | null): void {
        const shared = !!active && active === inactive;
        if (inactive?.isValid && !shared) {
            this._suppressSkeletonAutoPlay(inactive);
            inactive.node.active = false;
        }
    }

    /** Tắt spine + xóa track/defaultAnimation — tránh prefab Transition_L auto-play khi bật Transition. */
    private _suppressSkeletonAutoPlay(skel: sp.Skeleton): void {
        skel.setCompleteListener(null);
        skel.clearTracks();
        try {
            (skel as unknown as { defaultAnimation?: string }).defaultAnimation = '';
        } catch {
            /* ignore */
        }
    }

    private _holdSimpleSpinesUntilPlay(): void {
        this._autoBindSimpleSpines();
        const seen = new Set<sp.Skeleton>();
        for (const skel of [this.spineLandscape, this.spinePortrait]) {
            if (!skel?.isValid || seen.has(skel)) continue;
            seen.add(skel);
            this._suppressSkeletonAutoPlay(skel);
            skel.node.active = false;
        }
    }

    private _ensureSimpleSkeletonData(isLandscape: boolean): Promise<sp.SkeletonData | null> {
        const cached = isLandscape ? this._skelDataLandscape : this._skelDataPortrait;
        if (cached) return Promise.resolve(cached);

        const inflight = isLandscape ? this._loadingLandscape : this._loadingPortrait;
        if (inflight) return inflight;

        const path = this._skeletonPathFor(isLandscape);
        if (!path) return Promise.resolve(null);

        const bundle = assetManager.getBundle(MAIN_BUNDLE);
        if (!bundle) {
            Log.w(`[TransitionController] Bundle '${MAIN_BUNDLE}' missing — cannot load ${path}`);
            return Promise.resolve(null);
        }

        const promise = new Promise<sp.SkeletonData | null>((resolve) => {
            bundle.load(path, sp.SkeletonData, (err, data) => {
                if (isLandscape) this._loadingLandscape = null;
                else this._loadingPortrait = null;

                if (err || !data) {
                    Log.w(`[TransitionController] SkeletonData load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                if (isLandscape) this._skelDataLandscape = data;
                else this._skelDataPortrait = data;
                resolve(data);
            });
        });

        if (isLandscape) this._loadingLandscape = promise;
        else this._loadingPortrait = promise;
        return promise;
    }

    /** Chọn + gán SkeletonData đúng ngang/dọc, rồi play clip "1" một lần. */
    private async _prepareActiveSimpleSpine(): Promise<sp.Skeleton | null> {
        this._autoBindSimpleSpines();
        const isLandscape = this._isLandscape();
        let active = isLandscape ? this.spineLandscape : this.spinePortrait;
        let inactive = isLandscape ? this.spinePortrait : this.spineLandscape;
        if (!active?.isValid) {
            active = this.spineLandscape ?? this.spinePortrait;
            inactive = active === this.spineLandscape ? this.spinePortrait : this.spineLandscape;
        }

        if (!active?.isValid) {
            Log.w('[TransitionController] simple spine — thiếu Skeleton component');
            return null;
        }

        this._hideInactiveSimpleSpine(active, inactive);
        active.node.active = false;
        this._suppressSkeletonAutoPlay(active);

        let data = await this._ensureSimpleSkeletonData(isLandscape);
        if (!data && !isLandscape) {
            Log.w('[TransitionController] portrait spine missing — fallback landscape');
            data = await this._ensureSimpleSkeletonData(true);
        }
        if (!data && isLandscape && active.skeletonData) {
            data = active.skeletonData;
        }

        if (data && active.skeletonData !== data) {
            active.skeletonData = data;
        }

        active.node.active = true;
        this._activeSimpleIsLandscape = isLandscape;

        if (data) {
            this._startSimpleSpineClipOnce(active);
        }

        return active;
    }

    /**
     * Runtime gán SkeletonData không tự play defaultAnimation (đặc biệt portrait lazy-load).
     * Gọi đúng một lần ngay sau khi data sẵn sàng trên skeleton active.
     */
    private _startSimpleSpineClipOnce(skel: sp.Skeleton): string {
        const clip = (this.spineAnimName || '1').trim() || '1';
        skel.clearTracks();
        skel.setAnimation(0, clip, false);
        return clip;
    }

    /** Clip đang chạy hoặc spineAnimName — dùng cho duration fallback. */
    private _getPlayingAnimName(skel: sp.Skeleton): string {
        try {
            const track = skel.getCurrent(0);
            const name = track?.animation?.name;
            if (name) return name;
        } catch {
            /* spine chưa init */
        }
        try {
            const def = (skel as unknown as { defaultAnimation?: string }).defaultAnimation;
            if (def) return def;
        } catch {
            /* ignore */
        }
        const preferred = (this.spineAnimName || '1').trim();
        try {
            const find = (skel as unknown as { findAnimation?: (n: string) => unknown }).findAnimation;
            if (typeof find === 'function' && find.call(skel, preferred)) return preferred;
        } catch {
            /* spine chưa init */
        }
        return preferred;
    }

    private _getSpineDuration(skel: sp.Skeleton, animName: string): number {
        try {
            const find = (skel as unknown as { findAnimation?: (n: string) => { duration?: number } }).findAnimation;
            if (typeof find === 'function') {
                const anim = find.call(skel, animName);
                if (typeof anim?.duration === 'number' && anim.duration > 0) return anim.duration;
            }
        } catch {
            /* ignore */
        }
        return 2.7;
    }

    private _ensureRootOpacity(): UIOpacity | null {
        if (this.uiOpacity?.isValid) return this.uiOpacity;
        let op = this.node.getComponent(UIOpacity);
        if (!op) op = this.node.addComponent(UIOpacity);
        this.uiOpacity = op;
        return op;
    }

    /** Fade in Transition → gán spine + play "1" → fade out spine alpha 255→0. */
    private _playSimpleSpineTransition(): void {
        this._cleanupRunningTweens();
        this._simpleSpinePlaying = false;
        this._activeSimpleIsLandscape = null;
        this._holdSimpleSpinesUntilPlay();
        SoundManager.instance?.playNormalIntro();

        if (this.effectNode?.isValid) this.effectNode.active = false;
        if (this.effectNode2?.isValid) this.effectNode2.active = false;
        if (this.flashNode?.isValid) this.flashNode.active = false;

        this._resetOverlayOpacity(255);
        const rootOp = this._ensureRootOpacity();
        if (rootOp) {
            tween(rootOp).stop();
            rootOp.opacity = 0;
        }

        const startSpine = () => {
            this._showGameRootUnderTransition();
            void this._playSimpleSpineAnim();
        };

        const fadeIn = Math.max(0, this.fadeInDuration);
        if (rootOp && fadeIn > 0) {
            tween(rootOp)
                .to(fadeIn, { opacity: 255 }, { easing: easing.sineOut })
                .call(startSpine)
                .start();
        } else {
            if (rootOp) rootOp.opacity = 255;
            startSpine();
        }

        Log.d('[TransitionController] simple spine transition — fade in → Anim');
    }

    private async _playSimpleSpineAnim(): Promise<void> {
        const playGen = ++this._simpleSpinePlayGen;
        const skel = await this._prepareActiveSimpleSpine();
        if (playGen !== this._simpleSpinePlayGen || !this._isPlaying || !this.isValid) return;

        if (!skel?.isValid) {
            Log.w('[TransitionController] simple spine — không có Skeleton hợp lệ');
            this._fadeOutSimpleTransition();
            return;
        }

        this._simpleSpinePlaying = true;
        const clip = this._getPlayingAnimName(skel) || (this.spineAnimName || '1').trim() || '1';

        const onSpineDone = () => {
            if (playGen !== this._simpleSpinePlayGen) return;
            this._simpleSpinePlaying = false;
            skel.setCompleteListener(null);
            this.unschedule(this._simpleSpineDoneCb!);
            this._simpleSpineDoneCb = null;
            this._fadeOutSimpleTransition();
        };

        skel.setCompleteListener(() => {
            if (playGen !== this._simpleSpinePlayGen) return;
            onSpineDone();
        });

        this.unschedule(this._simpleSpineDoneCb);
        this._simpleSpineDoneCb = onSpineDone;
        const dur = this._getSpineDuration(skel, clip);
        this.scheduleOnce(this._simpleSpineDoneCb, dur + 0.15);

        Log.d(
            `[TransitionController] simple spine play clip="${clip}" ` +
            `${this._activeSimpleIsLandscape ? 'LANDSCAPE' : 'PORTRAIT'}`,
        );
    }

    /** Spine color.a 255→0 — GameView lộ dần bên dưới (Spine không ăn UIOpacity). */
    private _fadeOutSimpleTransition(): void {
        const duration = Math.max(0.05, this.fadeOutDuration);

        this._showGameRootUnderTransition();

        const finish = () => {
            this._setSimpleSpineAlpha(0);
            this._simpleSpinePlaying = false;
            this._activeSimpleIsLandscape = null;
            this._simpleSpinePlayGen++;
            this.node.active = false;
            this._isPlaying = false;
            EventBus.instance.emit(GameEvents.TRANSITION_DONE);
            Log.d('[TransitionController] simple spine done → TRANSITION_DONE');

            const cb = this._guideCompleteCb;
            this._guideCompleteCb = null;
            cb?.();
        };

        Tween.stopAllByTarget(this._spineFade);
        this._spineFade.a = 255;
        this._setSimpleSpineAlpha(255);
        tween(this._spineFade)
            .to(duration, { a: 0 }, {
                easing: easing.sineInOut,
                onUpdate: () => this._setSimpleSpineAlpha(this._spineFade.a),
            })
            .call(finish)
            .start();

        Log.d(`[TransitionController] fade out spine alpha 255→0 (${duration}s)`);
    }

    private _setSimpleSpineAlpha(a: number): void {
        const alpha = Math.max(0, Math.min(255, Math.round(a)));
        const seen = new Set<sp.Skeleton>();
        const apply = (skel: sp.Skeleton | null) => {
            if (!skel?.isValid || seen.has(skel)) return;
            seen.add(skel);
            const c = skel.color.clone();
            c.a = alpha;
            skel.color = c;
        };
        apply(this.spineLandscape);
        apply(this.spinePortrait);
        const anim = this._resolveAnimNode();
        apply(anim?.getComponent(sp.Skeleton) ?? anim?.getComponentInChildren(sp.Skeleton) ?? null);
        apply(this.iconNode?.getComponent(sp.Skeleton) ?? null);
    }

    /**
     * Resume / không chạy fly: chuyển chest sang Pot anchor, không duplicate spine load.
     * Gọi sau ensureLoaded() khi bỏ qua GUIDE_COMPLETE animation.
     */
    handoffChestToPot(pot: PotController): void {
        if (!this.iconNode?.isValid || !pot?.isValid) return;
        this.targetNode = pot.getTransitionTargetNode();
        this._cleanupRunningTweens();

        const skel = this.iconNode.getComponent(sp.Skeleton);
        if (skel) {
            const level = GameData.instance.potLevel ?? 0;
            skel.setAnimation(0, `Idle_LV${level}`, true);
        }

        this._handoffChestToPot(pot);
        this.node.active = false;
        this._isPlaying = false;
        Log.d('[TransitionController] handoffChestToPot (no fly)');
    }

    playIconFlyAnimation(): void {
        if (!this.iconNode || !this.targetNode) {
            this._isPlaying = false;
            return;
        }
        this._cleanupRunningTweens();
        this._pendingPot = this._findPotController();
        this._flyActive = false;
        this._hasLanded = false;

        // targetNode = Pot anchor (empty) — iconNode bay tới rồi reparent SAU khi overlay ẩn
        this.iconNode.active = true;
        this.iconNode.setScale(new Vec3(0, 0, 0));

        // 1. Mới vào: play loop Idle_LV6 trên icon spine
        const skel = this.iconNode.getComponent(sp.Skeleton);
        this._landedSkel = skel;
        if (skel) {
            skel.setAnimation(0, 'Idle_LV6', true);
        }

        // 2. Mới vào: play particle effectNode
        if (this.effectNode) {
            this.effectNode.active = true;
            for (const ps of this.effectNode.getComponentsInChildren(ParticleSystem)) {
                ps.stop(); ps.play();
            }
        }

        this._resetFlashNode();

        const uiOpacity = this.iconNode.getComponent(UIOpacity);
        if (uiOpacity) uiOpacity.opacity = 255;

        tween(this.iconNode)
            // Zoom nhanh ra 0 → 1.3
            .to(this.iconZoomInDuration, { scale: new Vec3(1.3, 1.3, 1.3) })
            // Bounce nhẹ nhảy về 1
            .to(this.iconZoomOutDuration, { scale: new Vec3(1, 1, 1) })
            // Giữ yên trước khi bay
            .delay(this.holdBeforeFlyDuration)
            // Bắt đầu bay: target lấy lúc này (sau hold / có thể đã xoay)
            .call(() => {
                if (this.effectNode) {
                    for (const ps of this.effectNode.getComponentsInChildren(ParticleSystem)) ps.stop();
                    this.effectNode.active = false;
                }
                this._fadeOutFlashNode();
                this._startChestFlyPath();
            })
            .start();
    }

    /**
     * Bay tới Pot. Gọi lúc bắt đầu fly (và khi retarget sau xoay màn)
     * để luôn dùng targetNode world pos mới nhất.
     * @param skipDip true khi retarget giữa chừng — bỏ đoạn nhún, bay thẳng tới Pot mới.
     */
    private _startChestFlyPath(durationScale: number = 1, skipDip: boolean = false): void {
        if (!this.iconNode?.isValid || this._hasLanded) return;

        // Luôn lấy lại Pot anchor mới nhất (sau xoay màn)
        this._refreshTargetFromPot();
        if (!this.targetNode?.isValid) return;

        this._computeFlyTarget();
        this._flyActive = true;

        const flyDur = Math.max(0.05, this.iconFlyDuration * Math.max(0.2, durationScale));
        // Clone end values — Cocos snapshot props lúc tạo tween
        const above = this._abovePotPos.clone();
        const land = this._targetLocalPos.clone();
        const midScale = this._midScale.clone();
        const landScale = this._targetLocalScale.clone();

        Tween.stopAllByTarget(this.iconNode);
        let tw = tween(this.iconNode);

        if (!skipDip) {
            const startPos = this.iconNode.position.clone();
            const dipPos = new Vec3(startPos.x, startPos.y - Math.max(0, this.flyDipOffset), startPos.z);
            const dipT = flyDur * 0.18;
            const arcT = flyDur * 0.47;
            const landT = flyDur - dipT - arcT;
            tw = tw
                .to(dipT, { position: dipPos }, { easing: easing.sineOut })
                .to(arcT, { position: above, scale: midScale }, { easing: easing.cubicOut })
                .to(landT, { position: land, scale: landScale }, { easing: easing.cubicIn });
        } else {
            const arcT = flyDur * 0.55;
            const landT = flyDur - arcT;
            tw = tw
                .to(arcT, { position: above, scale: midScale }, { easing: easing.cubicOut })
                .to(landT, { position: land, scale: landScale }, { easing: easing.cubicIn });
        }

        tw.call(() => this._onChestLanded()).start();
    }

    /** Tính lại target local pos/scale theo targetNode hiện tại (sau xoay màn). */
    private _computeFlyTarget(): void {
        if (!this.iconNode?.isValid || !this.targetNode?.isValid) return;

        const targetWorldPos = this.targetNode.getWorldPosition();
        if (this.iconNode.parent) {
            this.iconNode.parent.inverseTransformPoint(this._targetLocalPos, targetWorldPos);
        } else {
            Vec3.copy(this._targetLocalPos, targetWorldPos);
        }

        const targetWorldScale = new Vec3();
        this.targetNode.getWorldScale(targetWorldScale);
        const iconParentWorldScale = new Vec3(1, 1, 1);
        if (this.iconNode.parent) {
            this.iconNode.parent.getWorldScale(iconParentWorldScale);
        }
        this._targetLocalScale.set(
            targetWorldScale.x / iconParentWorldScale.x,
            targetWorldScale.y / iconParentWorldScale.y,
            targetWorldScale.z / iconParentWorldScale.z,
        );

        this._abovePotPos.set(
            this._targetLocalPos.x,
            this._targetLocalPos.y + Math.max(0, this.flyArcHeight),
            this._targetLocalPos.z,
        );
        this._midScale.set(
            1 + (this._targetLocalScale.x - 1) * 0.45,
            1 + (this._targetLocalScale.y - 1) * 0.45,
            1 + (this._targetLocalScale.z - 1) * 0.45,
        );
    }

    private _onChestLanded(): void {
        if (this._hasLanded) return;
        this._hasLanded = true;
        this._flyActive = false;

        const skel = this._landedSkel;
        if (skel?.isValid) {
            const potLevel = GameData.instance.potLevel;
            skel.setAnimation(0, `LV6_transition_LV${potLevel}`, false);
        }
        if (this.effectNode2 && this.targetNode?.isValid) {
            this.effectNode2.setWorldPosition(this.targetNode.getWorldPosition());
            this.effectNode2.active = true;
            for (const ps of this.effectNode2.getComponentsInChildren(ParticleSystem)) {
                ps.stop(); ps.play();
            }
        }
        this._beginHideSequence();
    }

    /**
     * Giữ effect → fade overlay → ẩn Transition → mới handoff Pot → TRANSITION_DONE.
     */
    private _beginHideSequence(): void {
        this._finishCb = () => {
            this._finishCb = null;
            this._fadeOutOverlayThenHide();
        };
        this.scheduleOnce(this._finishCb, Math.max(0, this.holdDuration));
    }

    private _fadeOutOverlayThenHide(): void {
        const overlayOpacity = this._ensureOverlayOpacity();
        const duration = Math.max(0.05, this.fadeOutDuration);

        const finishHide = () => {
            // Ẩn Transition trước → rồi mới gán spine sang Pot (tránh Pot nhận spine quá sớm)
            this.node.active = false;
            this._isPlaying = false;
            this._handoffChestToPot(this._pendingPot ?? this._findPotController());
            this._pendingPot = null;
            EventBus.instance.emit(GameEvents.TRANSITION_DONE);
            Log.d('[TransitionController] overlay faded → hidden → chest handoff → TRANSITION_DONE');
        };

        if (!overlayOpacity) {
            finishHide();
            return;
        }

        tween(overlayOpacity).stop();
        tween(overlayOpacity)
            .to(duration, { opacity: 0 }, { easing: easing.sineIn })
            .call(finishHide)
            .start();
    }

    private _ensureOverlayOpacity(): UIOpacity | null {
        const node = this.overlayNode?.isValid ? this.overlayNode : null;
        if (!node) {
            // Fallback: dùng uiOpacity root nếu chưa gán overlayNode
            return this.uiOpacity?.isValid ? this.uiOpacity : this.node.getComponent(UIOpacity);
        }
        let op = node.getComponent(UIOpacity);
        if (!op) {
            op = node.addComponent(UIOpacity);
        }
        return op;
    }

    private _resetOverlayOpacity(value: number): void {
        const op = this._ensureOverlayOpacity();
        if (op) {
            tween(op).stop();
            op.opacity = value;
        }
        if (this.overlayNode?.isValid) {
            this.overlayNode.active = true;
        }
    }

    private _ensureFlashOpacity(): UIOpacity | null {
        const node = this.flashNode?.isValid ? this.flashNode : null;
        if (!node) return null;
        let op = node.getComponent(UIOpacity);
        if (!op) op = node.addComponent(UIOpacity);
        return op;
    }

    private _resetFlashNode(): void {
        const node = this.flashNode?.isValid ? this.flashNode : null;
        if (!node) return;
        const op = this._ensureFlashOpacity();
        if (op) {
            tween(op).stop();
            op.opacity = 255;
        }
        node.active = true;
    }

    /** Fade alpha flashNode rồi mới active = false (không tắt đột ngột). */
    private _fadeOutFlashNode(): void {
        const node = this.flashNode?.isValid ? this.flashNode : null;
        if (!node || !node.active) return;

        const op = this._ensureFlashOpacity();
        const duration = Math.max(0.05, this.flashFadeOutDuration);

        if (!op) {
            node.active = false;
            return;
        }

        tween(op).stop();
        tween(op)
            .to(duration, { opacity: 0 }, { easing: easing.sineOut })
            .call(() => {
                if (node.isValid) node.active = false;
            })
            .start();
    }

    private _findPotController(): PotController | null {
        if (!this.targetNode?.isValid) return null;
        return this.targetNode.getComponent(PotController)
            ?? this.targetNode.parent?.getComponent(PotController)
            ?? null;
    }

    /** Handoff chest → PotController.adoptChestFromTransition (potSpine). */
    private _handoffChestToPot(pot: PotController | null): void {
        if (!this.iconNode?.isValid) return;

        const uiOpacity = this.iconNode.getComponent(UIOpacity);
        if (uiOpacity) {
            tween(uiOpacity).stop();
            uiOpacity.opacity = 255;
        }

        if (pot?.isValid) {
            pot.adoptChestFromTransition(this.iconNode);
            Log.d('[TransitionController] chest handoff → Pot.potSpine');
            return;
        }

        // Fallback nếu chưa wire PotController
        if (this.targetNode?.isValid) {
            this.iconNode.setParent(this.targetNode, true);
            this.iconNode.active = true;
            Log.w('[TransitionController] PotController not found — fallback reparent only');
        }
    }

    private _cleanupRunningTweens(): void {
        if (this._finishCb) {
            this.unschedule(this._finishCb);
            this._finishCb = null;
        }
        if (this._simpleSpineDoneCb) {
            this.unschedule(this._simpleSpineDoneCb);
            this._simpleSpineDoneCb = null;
        }
        this._simpleSpinePlaying = false;
        this._simpleSpinePlayGen++;
        Tween.stopAllByTarget(this._spineFade);
        this.unschedule(this._retargetFlyAfterLayout);
        this.unschedule(this._retargetFlyAfterLayoutLate);
        this._flyActive = false;
        this._hasLanded = false;
        this._landedSkel = null;
        if (this.iconNode?.isValid) {
            Tween.stopAllByTarget(this.iconNode);
            const uiOpacity = this.iconNode.getComponent(UIOpacity);
            if (uiOpacity) Tween.stopAllByTarget(uiOpacity);
        }
        const overlayOp = this.overlayNode?.isValid
            ? this.overlayNode.getComponent(UIOpacity)
            : (this.uiOpacity?.isValid ? this.uiOpacity : null);
        if (overlayOp) tween(overlayOp).stop();
        const rootOp = this.uiOpacity?.isValid ? this.uiOpacity : this.node.getComponent(UIOpacity);
        if (rootOp) tween(rootOp).stop();
        const flashOp = this.flashNode?.isValid ? this.flashNode.getComponent(UIOpacity) : null;
        if (flashOp) tween(flashOp).stop();
        for (const fx of [this.effectNode, this.effectNode2]) {
            if (!fx?.isValid) continue;
            for (const ps of fx.getComponentsInChildren(ParticleSystem)) {
                ps.stop();
            }
            fx.active = false;
        }
    }
}
