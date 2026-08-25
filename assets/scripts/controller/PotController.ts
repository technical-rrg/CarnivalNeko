/**
 * PotController — Quản lý hiển thị hũ Pot (Gold of Fortune) bằng Spine Animation.
 *
 * HŨ CÓ 7 TRẠNG THÁI (Level 0→6) dựa trên PotVisualLevel từ server:
 *   Level 0 : PotVisualLevel = 0 hoặc undefined (mới vào game, chưa có Pot) → idle_LV0
 *   Level 1 : PotVisualLevel = 1            → idle_LV1
 *   Level 2 : PotVisualLevel = 2            → idle_LV2
 *   Level 3 : PotVisualLevel = 3            → idle_LV3
 *   Level 4 : PotVisualLevel = 4            → idle_LV4
 *   Level 5 : PotVisualLevel = 5            → idle_LV5
 *   Level 6 : PotVisualLevel = 6            → idle_LV6
 *
 * SETUP TRONG EDITOR:
 *   1. Tạo Node "Pot" trong scene.
 *   2. Gắn PotController vào Node đó.
 *   3. Node con "Animation" + sp.Skeleton → kéo vào potSpine (KHÔNG gán skeletonData — tránh load Chest 2 lần).
 *      Chest spine thật được Transition handoff vào node Animation sau intro.
 *   4. potSpine vẫn dùng xuyên suốt code (idle, transition, impact…).
 *
 * FLOW:
 *   - POT_LEVEL_CHANGED    → _onLevelChanged → queue + apply (legacy single pot)
 *   - POT_WIN_INTRO        → _onPotWinIntro()→ particle + emit POT_WIN_DONE (level do server)
 *   - Nổ hũ xong (reset)   → level về 0, chạy LV{old}_transition_LV0 → idle_LV0
 *
 * Carnival Neko trail/pot UI dùng CarnivalTrailController + CarnivalPotBoard
 * (burst final FX + LvFinal nằm ở CarnivalPotBoard, không phải PotController).
 * jackpotEffectNode = particle legacy khi POT_WIN_INTRO (single pot).
 */

import {
    _decorator, Component, sp, Node, NodePool, ParticleSystem, instantiate,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { Log } from '../core/Logger';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

@ccclass('PotController')
export class PotController extends Component {

    // ─── INSPECTOR PROPERTIES ──────────────────────────────────────────────

    @property({
        type: sp.Skeleton,
        tooltip: 'Spine Pot trên node Animation. Prefab để trống skeletonData — Transition handoff chest vào đây.',
    })
    potSpine: sp.Skeleton | null = null;

    @property({ type: Node, tooltip: 'Particle effect node khi Pot win (nổ hũ) — active + play khi POT_WIN_INTRO' })
    jackpotEffectNode: Node | null = null;

    @property({ type: Node, tooltip: 'Node particle effect khi particle trúng Pot (legacy single pot)' })
    hitParticleNode: Node | null = null;

    @property({ type: Node, tooltip: 'Node particle effect thay thế (10%) khi particle trúng Pot' })
    hitParticleNode2: Node | null = null;

    @property({ tooltip: 'Delay trước khi emit POT_WIN_DONE sau pot win intro (giây)' })
    winIntroExtraDelay: number = 0.5;

    // ─── INTERNAL ──────────────────────────────────────────────────────────

    private _currentLevel: number = 0;
    private _isTransitioning: boolean = false;
    private _pendingLevel: number | null = null;
    private _gameReady: boolean = false;
    private _wasActiveBeforePickGame: boolean = true;
    /** Chờ TransitionPopup xong rồi mới ẩn Pot */
    private _pendingPickGameHide: boolean = false;
    private _hitParticlePool: NodePool | null = null;
    private _hitParticlePool2: NodePool | null = null;
    private readonly MAX_HIT_POOL_SIZE = 5;
    /** Node "Animation" trên Pot — giữ ref sau khi potSpine trỏ sang chest con. */
    private _animationNode: Node | null = null;
    /** Fallback nếu spine setCompleteListener không bao giờ fire (thiếu anim / skeleton lỗi). */
    private _transitionFallbackCb: (() => void) | null = null;
    /** Chặn complete + fallback gọi _finishTransition 2 lần. */
    private _transitionAwaitingEnd: boolean = false;
    private static readonly TRANSITION_FALLBACK_SEC = 2.5;
    /** Hủy impact fallback/complete khi bắt đầu level transition (tránh Idle cắt transition). */
    private _impactFallbackCb: (() => void) | null = null;
    private _impactEarlyCb: (() => void) | null = null;
    private _impactActive: boolean = false;
    /** Queue transition từng bước (LV0→1→2…) khi server nhảy nhiều level. */
    private _pendingTransitionSteps: number[] = [];
    private _transitionTargetLevel: number = 0;

    // ─── LIFECYCLE ─────────────────────────────────────────────────────────

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.POT_LEVEL_CHANGED,    this._onLevelChanged,  this);
        bus.on(GameEvents.POT_WIN_INTRO,        this._onPotWinIntro,   this);
        bus.on(GameEvents.TRANSITION_DONE,     this._onTransitionDone, this);
        bus.on(GameEvents.FREE_SPIN_END,         this._onFreeSpinEnd,      this);
        bus.on(GameEvents.GAME_READY,            () => { this._gameReady = true; }, this);
        bus.on(GameEvents.PICK_GAME_OPEN,        this._onPickGameOpen,    this);
        bus.on(GameEvents.PICK_GAME_ENTRY_DONE,  this._onPickGameEntryDone, this);
        bus.on(GameEvents.PICK_GAME_CLOSE,       this._onPickGameClose,   this);
        bus.on(GameEvents.TOPUP_TRANSITION_READY, this._onTopUpTransitionReady, this);
        bus.on(GameEvents.TOPUP_TRANSITION_DONE, this._onTopUpTransitionDone, this);
        if (this.potSpine?.node) {
            this._animationNode = this.potSpine.node;
        }
        this._prepareEmptyPotSpine();
        // Tạo pool cho hit particle để tránh instantiate/destroy liên tục
        this._initHitPool(this.hitParticleNode, (pool) => { this._hitParticlePool = pool; });
        this._initHitPool(this.hitParticleNode2, (pool) => { this._hitParticlePool2 = pool; });
    }

    private _initHitPool(prefab: Node | null, setPool: (pool: NodePool) => void): void {
        if (!prefab) return;
        const pool = new NodePool();
        const n = instantiate(prefab);
        n.active = false;
        pool.put(n);
        setPool(pool);
    }

    start(): void {
        const data = GameData.instance;
        this._currentLevel = this._normalizeLevel(data.potLevel);
        // Chỉ _showLevel nếu pot spine đã active (sau TRANSITION_DONE)
        const spine = this._getPotSpine();
        if (spine?.node?.active) {
            this._showLevel(this._currentLevel, false);
        }
        Log.d(`[PotController] start() — visualLevel=${this._currentLevel}, data.potLevel=${data.potLevel}, wildTrailCount=${data.wildTrailCount}`);
    }

    onEnable(): void {
        if (!this._gameReady) return;
        this._activateAnimationNode();
        const spine = this._getPotSpine();
        if (spine?.node && !spine.node.active) {
            spine.node.active = true;
            this._showLevel(this._currentLevel, false);
            Log.d('[PotController] Shown onEnable');
        }
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        this._cancelImpact(true);
        this._clearTransitionFallback();
        this._clearHitPool(this._hitParticlePool);
        this._clearHitPool(this._hitParticlePool2);
        this._hitParticlePool = null;
        this._hitParticlePool2 = null;
    }

    private _clearHitPool(pool: NodePool | null): void {
        if (!pool) return;
        while (pool.size() > 0) {
            const n = pool.get();
            if (n && n.isValid) n.destroy();
        }
        pool.clear();
    }

    // ─── EVENT HANDLERS ────────────────────────────────────────────────────

    /** Legacy hit particle helper (kept for pot impact VFX reuse). */
    playHitParticle(): void {
        const useRare = this.hitParticleNode2 && Math.random() < 0.1;
        const pool = useRare ? this._hitParticlePool2 : this._hitParticlePool;
        const prefab = useRare ? this.hitParticleNode2 : this.hitParticleNode;
        Log.d(`[PotController] playHitParticle — useRare=${useRare}, prefab=${prefab ? 'SET' : 'NULL'}, pool=${pool ? 'SET' : 'NULL'}`);
        if (!prefab || !pool) {
            Log.w('[PotController] hitParticleNode or pool is null — no hit effect');
            return;
        }
        const hitNode = pool.size() > 0 ? pool.get()! : instantiate(prefab);
        Log.d(`[PotController] playHitParticle — got hitNode from pool, isValid=${hitNode?.isValid}`);
        hitNode.setParent(this.node);
        hitNode.setPosition(0, 0, 0);
        hitNode.active = true;
        this._playAllChildParticles(hitNode);
        // Trả về pool sau 1 giây (particle đã chạy xong). Giới hạn pool size = MAX_HIT_POOL_SIZE.
        this.scheduleOnce(() => {
            if (!hitNode.isValid) return;
            hitNode.active = false;
            hitNode.removeFromParent();
            for (const ps of hitNode.getComponentsInChildren(ParticleSystem)) {
                ps.stop();
            }
            if (pool.size() >= this.MAX_HIT_POOL_SIZE) {
                hitNode.destroy();
            } else {
                pool.put(hitNode);
            }
        }, 3.0);

        // ★ Play impact animation trên pot spine theo level hiện tại
        void this.playImpactAsync();
    }

    /**
     * Play `LV{level}_Impact` rồi về idle.
     * @param earlyResolveSec Resolve sớm hơn trước khi anim kết thúc (để caller bắn effect overlap).
     *                        Anim vẫn chạy hết rồi mới về idle.
     */
    playImpactAsync(earlyResolveSec: number = 0): Promise<void> {
        return new Promise((resolve) => {
            const potSpine = this._getPotSpine();
            if (!potSpine || !potSpine.node?.active || this._isTransitioning) {
                resolve();
                return;
            }
            const level = this._currentLevel;
            if (level <= 0) {
                resolve();
                return;
            }
            const animName = `LV${level}_Impact`;
            if (!this._hasSpineAnim(potSpine, animName)) {
                Log.w(`[PotController] missing impact anim "${animName}" — skip`);
                resolve();
                return;
            }

            this._cancelImpact(false);

            let resolved = false;
            const resolveOnce = () => {
                if (resolved) return;
                resolved = true;
                resolve();
            };

            let finished = false;
            const finishAnim = () => {
                if (finished || !this._impactActive) return;
                finished = true;
                this._impactActive = false;
                if (this._impactFallbackCb) {
                    this.unschedule(this._impactFallbackCb);
                    this._impactFallbackCb = null;
                }
                if (this._impactEarlyCb) {
                    this.unschedule(this._impactEarlyCb);
                    this._impactEarlyCb = null;
                }
                // Đang (hoặc sắp) transition level → không đè Idle lên transition
                if (this._isTransitioning) {
                    resolveOnce();
                    return;
                }
                if (potSpine.isValid) potSpine.setCompleteListener(null);
                this._playIdle(this._currentLevel);
                resolveOnce();
            };
            this._impactFallbackCb = () => {
                Log.w(`[PotController] impact complete fallback → ${animName}`);
                finishAnim();
            };

            const animDur = this._getSpineAnimDuration(potSpine, animName);
            const early = Math.max(0, earlyResolveSec);
            if (early > 0 && animDur > early) {
                this._impactEarlyCb = () => resolveOnce();
                this.scheduleOnce(this._impactEarlyCb, animDur - early);
            }

            this._impactActive = true;
            Log.d(`[PotController] playImpactAsync — ${animName} early=${early}`);
            potSpine.setCompleteListener((entry) => {
                if (entry?.animation?.name && entry.animation.name !== animName) return;
                finishAnim();
            });
            this.scheduleOnce(this._impactFallbackCb, Math.max(2.0, animDur + 0.5));
            potSpine.timeScale = 1;
            try {
                potSpine.setAnimation(0, animName, false);
            } catch (e) {
                Log.w(`[PotController] impact setAnimation failed "${animName}"`, e);
                finishAnim();
            }
        });
    }

    private _getSpineAnimDuration(potSpine: sp.Skeleton, animName: string): number {
        try {
            const find = (potSpine as any).findAnimation;
            if (typeof find === 'function') {
                const anim = find.call(potSpine, animName);
                const dur = anim?.duration;
                if (typeof dur === 'number' && dur > 0) return dur;
            }
        } catch {
            /* ignore */
        }
        return 0.5;
    }

    /**
     * POT_LEVEL_CHANGED: queue + apply (legacy single pot; Carnival dùng CarnivalPotBoard).
     */
    private _onLevelChanged(payload: { level: number; total: number }): void {
        const newLevel = this._normalizeLevel(payload.level);
        Log.d(`[PotController] _onLevelChanged — visualLevel: ${this._currentLevel} → ${newLevel}, total=${payload.total}`);
        if (newLevel !== this._currentLevel) {
            this._pendingLevel = newLevel;
            this.unschedule(this._applyPendingLevel);
            this.scheduleOnce(this._applyPendingLevel, 0.05);
        }
    }

    /** Safety: apply pending khi không có wild trail (FLY_DONE không tới) */
    private _applyPendingLevel(): void {
        if (this._pendingLevel !== null && this._pendingLevel !== this._currentLevel) {
            this._transitionToLevel(this._pendingLevel);
        } else {
            EventBus.instance.emit(GameEvents.POT_TRANSITION_END);
        }
        this._pendingLevel = null;
    }

    /** Node Animation trên Pot — Transition bay chest tới đây. */
    getTransitionTargetNode(): Node | null {
        return this._animationNode ?? this.potSpine?.node ?? null;
    }

    /**
     * Nhận chest spine từ Transition (iconNode) → gán vào potSpine, thay shell rỗng trên Pot.
     */
    adoptChestFromTransition(chestNode: Node): void {
        const anchor = this._animationNode ?? this.potSpine?.node;
        if (!anchor?.isValid || !chestNode?.isValid) {
            Log.w('[PotController] adoptChestFromTransition — thiếu anchor hoặc chestNode');
            return;
        }

        const newSkel = chestNode.getComponent(sp.Skeleton);
        if (!newSkel) {
            Log.w('[PotController] adoptChestFromTransition — chestNode không có sp.Skeleton');
            return;
        }

        // Gỡ shell sp.Skeleton rỗng trên node Animation (không load Chest)
        if (this.potSpine?.isValid && this.potSpine !== newSkel && this.potSpine.node === anchor) {
            this.potSpine.destroy();
        }

        chestNode.setParent(anchor, true);
        chestNode.active = true;
        anchor.active = true;
        this.potSpine = newSkel;

        Log.d('[PotController] adoptChestFromTransition — potSpine wired, Animation active');
    }

    /** TRANSITION_DONE: chest đã handoff → bật Animation + play idle */
    private _onTransitionDone(): void {
        this._activateAnimationNode();
        const spine = this._getPotSpine();
        if (spine?.node) {
            spine.node.active = true;
            this._showLevel(this._currentLevel, false);
        }
        Log.d('[PotController] _onTransitionDone — potSpine ready');
    }

    /** FREE_SPIN_END: feature kết thúc → hiện Pot lại nếu đang ẩn */
    private _onFreeSpinEnd(): void {
        this._activateAnimationNode();
        const spine = this._getPotSpine();
        if (GameData.instance.currentMode === 'normal' && spine?.node && !spine.node.active) {
            spine.node.active = true;
            this._showLevel(this._currentLevel, false);
            Log.d('[PotController] Shown after FreeSpinEnd');
        }
    }

    /** PICK_GAME_OPEN: đánh dấu chờ ẩn Pot khi TransitionPopup READY */
    private _onPickGameOpen(): void {
        this._wasActiveBeforePickGame = this.node.active;
        this._pendingPickGameHide = true;
        Log.d('[PotController] Pick Game open — Pot hide when TransitionPopup READY');
    }

    /** TOPUP_TRANSITION_READY: overlay phủ kín → mới ẩn Pot */
    private _onTopUpTransitionReady(): void {
        this._hidePotForPickGameIfPending();
    }

    /** Fallback nếu READY bị miss */
    private _onTopUpTransitionDone(): void {
        this._hidePotForPickGameIfPending();
    }

    /** Fallback khi bỏ qua transition (useTopUpTransition=false) */
    private _onPickGameEntryDone(): void {
        this._hidePotForPickGameIfPending();
    }

    private _hidePotForPickGameIfPending(): void {
        if (!this._pendingPickGameHide) return;
        this._pendingPickGameHide = false;
        if (this.node.active) {
            this.node.active = false;
            Log.d('[PotController] Hidden — Pick Game under TransitionPopup');
        }
    }

    /** PICK_GAME_CLOSE: Pick Game kết thúc → hiện Pot lại (trừ khi vào Matsuri sau Pick). */
    private _onPickGameClose(): void {
        this._pendingPickGameHide = false;
        const data = GameData.instance;
        const goingToMatsuri = data.currentMode === 'matsuri'
            || data.pickToMatsuriTransition
            || !!(data.pendingCarnivalMatsuri?.matsuriRows);
        if (goingToMatsuri) return;
        if (this._wasActiveBeforePickGame && !this.node.active) {
            this.node.active = true;
            Log.d('[PotController] Shown — Pick Game close');
        }
    }

    /** POT_WIN_INTRO: server trigger pot win — particle + emit POT_WIN_DONE (không ép LV6, level do server quyết định) */
    private _onPotWinIntro(): void {
        // Không ép animation LV6 — Pot level đã được cập nhật từ server qua POT_LEVEL_CHANGED
        // Active + play jackpot particle effect
        if (this.jackpotEffectNode) {
            this.jackpotEffectNode.active = true;
            for (const ps of this.jackpotEffectNode.getComponentsInChildren(ParticleSystem)) {
                ps.stop(); ps.play();
            }
        }
        this.scheduleOnce(() => {
            // Stop particle trước khi chuyển sang popup
            if (this.jackpotEffectNode) {
                for (const ps of this.jackpotEffectNode.getComponentsInChildren(ParticleSystem)) ps.stop();
                this.jackpotEffectNode.active = false;
            }
            EventBus.instance.emit(GameEvents.POT_WIN_DONE);
        }, this.winIntroExtraDelay);
    }

    // ─── CHEST SPINE (shared from Transition) ───────────────────────────────

    /** Ẩn shell Animation cho đến khi Transition handoff chest. */
    private _prepareEmptyPotSpine(): void {
        const node = this._animationNode ?? this.potSpine?.node;
        if (!node?.isValid) return;
        node.active = false;
    }

    /** Bật node Animation sau Transition / resume. */
    private _activateAnimationNode(): void {
        if (this._animationNode?.isValid) {
            this._animationNode.active = true;
        }
    }

    private _getPotSpine(): sp.Skeleton | null {
        if (this.potSpine?.isValid && this.potSpine.skeletonData) {
            return this.potSpine;
        }
        // Fallback: tìm spine con handoff từ Transition (dưới node Animation)
        const anchor = this._animationNode ?? this.potSpine?.node;
        if (anchor?.isValid) {
            for (const child of anchor.children) {
                const sk = child.getComponent(sp.Skeleton);
                if (sk?.isValid && sk.skeletonData) {
                    this.potSpine = sk;
                    return sk;
                }
            }
        }
        // Không trả shell rỗng (không có skeletonData) — setAnimation sẽ treo complete listener
        return null;
    }

    private _clearTransitionFallback(): void {
        if (this._transitionFallbackCb) {
            this.unschedule(this._transitionFallbackCb);
            this._transitionFallbackCb = null;
        }
    }

    /** Hủy Impact đang chạy — tránh complete/fallback đè Idle lên level transition. */
    private _cancelImpact(clearListener: boolean = true): void {
        this._impactActive = false;
        if (this._impactFallbackCb) {
            this.unschedule(this._impactFallbackCb);
            this._impactFallbackCb = null;
        }
        if (this._impactEarlyCb) {
            this.unschedule(this._impactEarlyCb);
            this._impactEarlyCb = null;
        }
        if (clearListener) {
            const spine = this._getPotSpine();
            if (spine) spine.setCompleteListener(null);
        }
    }

    /** Emit POT_TRANSITION_END + dọn listener/fallback — luôn gọi khi bỏ qua hoặc xong anim. */
    private _finishTransition(nextLevel: number, playIdle: boolean): void {
        this._clearTransitionFallback();
        this._pendingTransitionSteps = [];
        this._isTransitioning = false;
        this._transitionAwaitingEnd = false;
        this._currentLevel = nextLevel;
        const spine = this._getPotSpine();
        if (spine) spine.setCompleteListener(null);
        if (playIdle) this._playIdle(nextLevel);
        EventBus.instance.emit(GameEvents.POT_TRANSITION_END);
    }

    /** true nếu skeleton có animation name (API thiếu → coi như có, để thử play). */
    private _hasSpineAnim(potSpine: sp.Skeleton, animName: string): boolean {
        try {
            const find = (potSpine as any).findAnimation;
            if (typeof find === 'function') {
                return !!find.call(potSpine, animName);
            }
        } catch {
            /* ignore */
        }
        return true;
    }

    /**
     * Play 1-shot transition spine; thiếu anim / setAnimation lỗi / complete không fire
     * → fallback vẫn idle + emit POT_TRANSITION_END để spin tiếp.
     */
    private _playTransitionSpine(potSpine: sp.Skeleton, animName: string, stepLevel: number): void {
        if (!potSpine.skeletonData || !this._hasSpineAnim(potSpine, animName)) {
            Log.w(`[PotController] skip transition — missing skeletonData/anim "${animName}" → jump to Idle_LV${this._transitionTargetLevel}`);
            this._finishTransition(this._transitionTargetLevel, true);
            return;
        }

        this._isTransitioning = true;
        this._transitionAwaitingEnd = true;
        this._currentLevel = stepLevel;
        SoundManager.instance?.playPotLevelUpEffect(stepLevel);

        const finishStep = () => {
            if (!this._transitionAwaitingEnd) return;
            this._transitionAwaitingEnd = false;
            this._clearTransitionFallback();
            if (potSpine.isValid) potSpine.setCompleteListener(null);

            // Còn bước trung gian → play tiếp; hết rồi mới idle + emit END
            if (this._pendingTransitionSteps.length > 0) {
                this._playNextTransitionStep(potSpine);
                return;
            }
            this._isTransitioning = false;
            this._playIdle(this._transitionTargetLevel);
            EventBus.instance.emit(GameEvents.POT_TRANSITION_END);
        };

        this._clearTransitionFallback();
        const animDur = this._getSpineAnimDuration(potSpine, animName);
        this._transitionFallbackCb = () => {
            Log.w(`[PotController] spine complete fallback → ${animName}`);
            finishStep();
        };
        this.scheduleOnce(this._transitionFallbackCb, Math.max(PotController.TRANSITION_FALLBACK_SEC, animDur + 0.35));

        potSpine.setCompleteListener((entry) => {
            if (entry?.animation?.name && entry.animation.name !== animName) return;
            finishStep();
        });
        potSpine.timeScale = 1;
        try {
            potSpine.setAnimation(0, animName, false);
        } catch (e) {
            Log.w(`[PotController] setAnimation failed "${animName}"`, e);
            finishStep();
        }
    }

    /** Play bước tiếp theo trong chuỗi LV{n}_transition_LV{n+1}. */
    private _playNextTransitionStep(potSpine: sp.Skeleton): void {
        const from = this._currentLevel;
        const to = this._pendingTransitionSteps.shift()!;
        const animName = `LV${from}_transition_LV${to}`;
        Log.d(`[PotController] Play transition step: ${animName} (remain=${this._pendingTransitionSteps.length})`);
        this._playTransitionSpine(potSpine, animName, to);
    }

    // ─── PRIVATE ───────────────────────────────────────────────────────────

    /**
     * Clamp visual level trong range 0..6.
     * GameManager đã map PotVisualLevel trực tiếp từ server, nên data.potLevel đã là visual level.
     */
    private _normalizeLevel(level: number): number {
        if (level == null || level < 0) return 0;
        return Math.min(6, level);
    }

    /**
     * Transition giữa các level bằng Spine animation.
     *   - Tăng level: chạy từng bước "LV{n}_transition_LV{n+1}" (Spine không có nhảy cách level)
     *     rồi loop Idle_LV{new}
     *   - Reset sau nổ hũ (về 0): chạy "LV{old}_transition_LV0" rồi Idle_LV0
     *   - Các trường hợp khác: set idle trực tiếp
     */
    private _transitionToLevel(newLevel: number): void {
        Log.d(`[PotController] _transitionToLevel: ${this._currentLevel} → ${newLevel}`);

        const oldLevel = this._currentLevel;
        const levelChanged = newLevel !== oldLevel;
        this._transitionTargetLevel = newLevel;
        this._pendingTransitionSteps = [];

        // Impact đang chạy sẽ complete → Idle: hủy trước khi play transition
        this._cancelImpact(true);

        const potSpine = this._getPotSpine();
        if (!potSpine) {
            this._currentLevel = newLevel;
            if (levelChanged && newLevel > oldLevel) {
                SoundManager.instance?.playPotLevelUpEffect(newLevel);
            }
            Log.w('[PotController] no pot spine/skeletonData → skip transition, emit POT_TRANSITION_END');
            this._finishTransition(newLevel, false);
            return;
        }

        if (!potSpine.node?.active) {
            this._currentLevel = newLevel;
            if (levelChanged && newLevel > oldLevel) {
                SoundManager.instance?.playPotLevelUpEffect(newLevel);
            }
            Log.d(`[PotController] potSpine inactive → skip transition, queued level=${newLevel}`);
            this._finishTransition(newLevel, false);
            return;
        }

        if (newLevel > oldLevel) {
            // Spine chỉ có LV{n}_transition_LV{n+1} — queue từng bước nếu nhảy nhiều level
            for (let lv = oldLevel + 1; lv <= newLevel; lv++) {
                this._pendingTransitionSteps.push(lv);
            }
            Log.d(`[PotController] transition queue: ${oldLevel} → [${this._pendingTransitionSteps.join(',')}]`);
            this._playNextTransitionStep(potSpine);
        } else if (newLevel < oldLevel) {
            this._currentLevel = newLevel;
            if (oldLevel > 0 && newLevel === 0) {
                const resetAnim = `LV${oldLevel}_transition_LV0`;
                Log.d(`[PotController] Play reset transition: ${resetAnim}`);
                this._playTransitionSpine(potSpine, resetAnim, newLevel);
            } else {
                this._finishTransition(newLevel, true);
            }
        } else {
            this._finishTransition(newLevel, false);
        }
    }

    /** Play idle animation cho level hiện tại (loop) */
    private _playIdle(level: number): void {
        const potSpine = this._getPotSpine();
        if (!potSpine || !potSpine.node?.active) return;
        const animName = `Idle_LV${level}`;
        if (!this._hasSpineAnim(potSpine, animName)) {
            Log.w(`[PotController] missing idle anim "${animName}" — skip`);
            return;
        }
        potSpine.timeScale = 1;
        try {
            potSpine.setAnimation(0, animName, true);
        } catch (e) {
            Log.w(`[PotController] idle setAnimation failed "${animName}"`, e);
        }
    }

    /** Hiển thị đúng level mà không animate transition (dùng khi init) */
    private _showLevel(level: number, _animate: boolean): void {
        const potSpine = this._getPotSpine();
        if (!potSpine || !potSpine.node?.active) return;
        this._playIdle(level);
    }

    /** Kích hoạt và play lại toàn bộ ParticleSystem trong các node con (kể cả inactive) */
    private _playAllChildParticles(root: Node): void {
        const walk = (node: Node) => {
            const pss = node.getComponents(ParticleSystem);
            if (pss.length > 0) {
                node.active = true;
            }
            for (const ps of pss) {
                ps.stop();
                ps.clear();
                ps.play();
            }
            for (const child of node.children) {
                walk(child);
            }
        };
        walk(root);
    }

}

