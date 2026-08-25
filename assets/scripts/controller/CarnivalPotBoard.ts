/**
 * CarnivalPotBoard — 3 Pot (Blue / Red / Green) Spine theo potLevels API (0..10).
 *
 * Spine `newSpine/Pot/Pot_Blue|Pot_red|Pot_Green` — tên anim đúng JSON:
 *   Idle      : Lv0 … Lv10
 *   Level-up  : Lv0toLv1 … Lv5toLv6, Lv6Lv7 … Lv9Lv10
 *   Burst     : LvFinal
 *
 * Events:
 *   CARNIVAL_POT_LEVELS_CHANGED → lưu target (idle ngay nếu không có trail đang bay)
 *   CARNIVAL_TRAIL_START        → defer idle mới, chờ từng hit
 *   CARNIVAL_TRAIL_ONE_HIT      → nhún scale nhẹ (code) + hitFxTemplate tại pot + play bước LvN→LvN+1 nếu level tăng
 *   CARNIVAL_TRAIL_FLY_DONE     → flush các bước level-up còn lại
 *   CARNIVAL_POT_BURST          → nạp còn lại LvN→Lv10 (nếu chưa đầy) → LvFinal + burstFinalFx → BURST_DONE (sau khi FX xong)
 *   Feature end                 → idle Lv0 cho pot vừa nổ
 */

import {
    _decorator, Component, Node, NodePool, Label, Vec3, tween, Tween,
    UITransform, Color, Graphics, Sprite, sp, assetManager, instantiate, ParticleSystem,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { CarnivalFeatureTrigger, CarnivalPotLevels, TrailColor } from '../data/SlotTypes';
import {
    burstPotsForApiFeatureType,
    burstPotsForKind,
    resetBurstPotState,
} from '../data/CarnivalFeatureResolve';
import { SoundManager } from '../manager/SoundManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

const SPINE_BUNDLE = 'MainBundle';
const POT_MAX_LEVEL = 10;
const BURST_ANIM = 'LvFinal';

/** Path SkeletonData trong MainBundle — khớp file name (Pot_red chữ r thường). */
const POT_SPINE_PATH: Record<'blue' | 'red' | 'green', string> = {
    blue: 'newSpine/Pot/Pot_Blue',
    red: 'newSpine/Pot/Pot_red',
    green: 'newSpine/Pot/Pot_Green',
};

function clampPotLevel(level: number | undefined): number {
    if (level == null || !Number.isFinite(level) || level < 0) return 0;
    return Math.min(POT_MAX_LEVEL, Math.floor(level));
}

function idleAnimName(level: number): string {
    return `Lv${clampPotLevel(level)}`;
}

/**
 * Tên transition đúng JSON (Lv0–5 có "to", Lv6–9 không có "to").
 * Chỉ hỗ trợ bước +1. Lv9→10 có thêm alias tên anim legacy.
 */
function levelUpAnimCandidates(from: number): string[] {
    switch (from) {
        case 0: return ['Lv0toLv1'];
        case 1: return ['Lv1toLv2'];
        case 2: return ['Lv2toLv3'];
        case 3: return ['Lv3toLv4'];
        case 4: return ['Lv4toLv5'];
        case 5: return ['Lv5toLv6'];
        case 6: return ['Lv6Lv7'];
        case 7: return ['Lv7Lv8'];
        case 8: return ['Lv8Lv9'];
        case 9: return ['Lv9Lv10', 'Lv9ToLv10', 'Lv9toLv10'];
        default: return [];
    }
}

function levelUpAnimName(from: number): string | null {
    const candidates = levelUpAnimCandidates(from);
    return candidates.length > 0 ? candidates[0] : null;
}

@ccclass('CarnivalPotBoard')
export class CarnivalPotBoard extends Component {

    @property({ type: Node, tooltip: 'Blue Pot node (left)' })
    bluePot: Node | null = null;

    @property({ type: Node, tooltip: 'Red Pot node (center)' })
    redPot: Node | null = null;

    @property({ type: Node, tooltip: 'Green Pot node (right)' })
    greenPot: Node | null = null;

    @property({ type: Label, tooltip: 'Optional level label Blue' })
    blueLevelLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Optional level label Red' })
    redLevelLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Optional level label Green' })
    greenLevelLabel: Label | null = null;

    @property({ tooltip: 'Scale tại level 0 (fallback khi không có Spine)' })
    scaleMin: number = 0.75;

    @property({ tooltip: 'Scale tại level 10 (fallback khi không có Spine)' })
    scaleMax: number = 1.35;

    @property({ tooltip: 'Thời gian burst anim trước khi DONE nếu không có LvFinal (giây)' })
    burstDuration: number = 1.15;

    @property({ tooltip: 'Tốc độ spine khi nạp nhanh LvN→Lv10 trước lúc nổ hũ (trigger feature, không phải trail từng hit). 1= bình thường.' })
    preBurstFillTimeScale: number = 2.8;

    @property({ tooltip: 'Biên độ nhún lên khi trigger Matsuri (px)' })
    hopHeight: number = 56;

    @property({ tooltip: 'Số lần nhún lên-xuống khi trigger Matsuri' })
    hopCount: number = 3;

    @property({ tooltip: 'Scale peak khi trail trúng pot' })
    hitBouncePeak: number = 1.08;

    @property({ tooltip: 'Scale squash khi trail trúng pot' })
    hitBounceSquash: number = 0.92;

    @property({
        type: Node,
        tooltip: 'Template FX (inactive) — clone tại vị trí pot khi trail trúng.\nCác ParticleSystem nằm ở child.',
    })
    hitFxTemplate: Node | null = null;

    @property({ tooltip: 'Thời gian giữ FX trước khi trả pool (giây)' })
    hitFxRecycleDelay: number = 2.5;

    @property({
        type: Node,
        tooltip: 'Template FX final (inactive) — play tại pot khi LvFinal đến burstFinalFxDelay (giây).',
    })
    burstFinalFxTemplate: Node | null = null;

    @property({ tooltip: 'Giây từ lúc bắt đầu LvFinal đến khi play burstFinalFx (canh theo anim)' })
    burstFinalFxDelay: number = 2.5;

    @property({ tooltip: 'Thời gian giữ burst final FX trước khi trả pool (giây)' })
    burstFinalFxRecycleDelay: number = 3;

    @property({ tooltip: 'Khoảng cách tối thiểu giữa 2 lần rung idle (giây)' })
    idleWobbleMinInterval: number = 3.5;

    @property({ tooltip: 'Khoảng cách tối đa giữa 2 lần rung idle (giây)' })
    idleWobbleMaxInterval: number = 9;

    @property({ tooltip: 'Góc rung nhẹ idle (độ)' })
    idleWobbleAngle: number = 2.2;

    @property({ tooltip: 'Dịch chuyển ngang rung idle (px)' })
    idleWobbleShift: number = 2.5;

    /** Level đang hiện trên spine (từng bước). */
    private _displayLevels: CarnivalPotLevels = { blue: 0, red: 0, green: 0 };
    /** Level API / target sau spin. */
    private _targetLevels: CarnivalPotLevels = { blue: 0, red: 0, green: 0 };
    private _placeholderBuilt = false;
    private _bursting = false;
    private _burstingPots: Node[] = [];
    private _pendingBurstFeature: CarnivalFeatureTrigger | null = null;
    private _trailsFlying = false;
    /** Pot đang giữ pose LvFinal đến khi feature kết thúc. */
    private _frozenBurstNodes = new Set<Node>();

    private _spineByNode = new Map<Node, sp.Skeleton>();
    private _baseScaleByNode = new Map<Node, Vec3>();
    private _basePosByNode = new Map<Node, Vec3>();
    /** Spine track 0 đang chạy 1-shot (level-up / burst). */
    private _animBusy = new Set<Node>();
    private _animFallback = new Map<Node, () => void>();
    private _lastIdleByNode = new Map<Node, string>();
    private _burstWaitCount = 0;
    /** Rung nhẹ khi idle normal — mỗi pot timer riêng. */
    private _idleWobbleEnabled = false;
    private _idleWobblePlaying = new Set<Node>();
    private _idleWobbleScheduleCb = new Map<Node, () => void>();
    private _baseAngleByNode = new Map<Node, number>();
    private _hitFxPool: NodePool | null = null;
    private _burstFinalFxPool: NodePool | null = null;
    private readonly _maxHitFxPoolSize = 8;
    private readonly _maxBurstFinalFxPoolSize = 6;
    /** scheduleOnce chờ play burst final FX theo từng pot. */
    private _burstFinalFxScheduleCbs = new Map<Node, () => void>();
    /** FX burst final đang chạy (chờ recycle) — BURST_DONE chờ hết FX rồi mới emit. */
    private _activeBurstFinalFx = new Set<Node>();
    private _burstFinalFxRecycleCbs = new Map<Node, () => void>();
    /** LvFinal xong — chờ burst final FX recycle xong mới emit BURST_DONE. */
    private _burstDoneDeferred = false;

    onLoad(): void {
        this._initFxPool(this.hitFxTemplate, pool => { this._hitFxPool = pool; });
        this._initFxPool(this.burstFinalFxTemplate, pool => { this._burstFinalFxPool = pool; });
        const bus = EventBus.instance;
        bus.on(GameEvents.CARNIVAL_POT_LEVELS_CHANGED, this._onLevelsChanged, this);
        bus.on(GameEvents.CARNIVAL_TRAIL_START, this._onTrailStart, this);
        bus.on(GameEvents.CARNIVAL_TRAIL_ONE_HIT, this._onTrailHit, this);
        bus.on(GameEvents.CARNIVAL_TRAIL_FLY_DONE, this._onTrailFlyDone, this);
        bus.on(GameEvents.CARNIVAL_POT_BURST, this._onPotBurst, this);
        bus.on(GameEvents.MATSURI_START_POPUP, this._onMatsuriStartPopup, this);
        bus.on(GameEvents.CARNIVAL_MATSURI_END, this._onFeatureReturnToBase, this);
        bus.on(GameEvents.FREE_SPIN_END, this._onFeatureReturnToBase, this);
        bus.on(GameEvents.PICK_GAME_CLOSE, this._onPickGameClose, this);
        bus.on(GameEvents.GAME_READY, this._onGameReady, this);
        bus.on(GameEvents.REELS_START_SPIN, this._onReelsStartSpin, this);
        bus.on(GameEvents.REELS_STOPPED, this._onReelsStopped, this);
        bus.on(GameEvents.CARNIVAL_MATSURI_START, this._onFeaturePauseWobble, this);
        bus.on(GameEvents.FREE_SPIN_START, this._onFeaturePauseWobble, this);
        bus.on(GameEvents.PICK_GAME_OPEN, this._onFeaturePauseWobble, this);
        this._cacheBaseTransforms();
    }

    start(): void {
        this._cacheBaseTransforms();
        this._cacheSpines();
        this._syncLevelsFromData(true);
        this._ensurePlaceholders();
        this._applyAll(false);
        void this._ensureSpinesLoaded();
    }

    onDestroy(): void {
        for (const node of [...this._animBusy]) {
            this._cancelAnim(node, true);
        }
        this._stopAllIdleWobble(true);
        this.unschedule(this._finishBurst);
        this._cancelAllBurstFinalFxSchedules();
        this._forceStopAllBurstFinalFx();
        this._pendingBurstFeature = null;
        this._burstDoneDeferred = false;
        this._restoreBurstPots();
        this._clearFxPool(this._hitFxPool, pool => { this._hitFxPool = pool; });
        this._clearFxPool(this._burstFinalFxPool, pool => { this._burstFinalFxPool = pool; });
        EventBus.instance.offTarget(this);
    }

    private _onGameReady(): void {
        this._cacheSpines();
        this._syncLevelsFromData(true);
        this._applyAll(false);
        void this._ensureSpinesLoaded().then(() => this._enableIdleWobble());
    }

    private _onTrailStart(): void {
        this._trailsFlying = true;
        this._stopAllIdleWobble(true);
    }

    private _onTrailFlyDone(): void {
        this._trailsFlying = false;
        if (this._bursting) return;
        this._flushPendingLevelUps();
        this._restartIdleWobbleAll();
    }

    private _onReelsStartSpin(): void {
        this._stopAllIdleWobble(true);
    }

    private _onReelsStopped(): void {
        this._restartIdleWobbleAll();
    }

    /** Feature / pick — tạm dừng rung idle. */
    private _onFeaturePauseWobble(): void {
        this._stopAllIdleWobble(true);
    }

    private _onLevelsChanged(levels: CarnivalPotLevels): void {
        if (!levels) return;
        this._targetLevels = this._clampLevels(levels);
        if (this._bursting) {
            this._applyLabelsOnly();
            return;
        }
        const needsLevelUpAnim =
            this._displayLevels.blue < this._targetLevels.blue
            || this._displayLevels.red < this._targetLevels.red
            || this._displayLevels.green < this._targetLevels.green;

        if (this._trailsFlying || this._frozenBurstNodes.size > 0 || needsLevelUpAnim) {
            this._applyLabelsOnly();
            if (needsLevelUpAnim && !this._trailsFlying && this._frozenBurstNodes.size === 0) {
                this._flushPendingLevelUps();
            }
            Log.d(
                `[CarnivalPot] target B${this._targetLevels.blue} R${this._targetLevels.red} G${this._targetLevels.green}` +
                ` display B${this._displayLevels.blue} R${this._displayLevels.red} G${this._displayLevels.green}` +
                (this._frozenBurstNodes.size > 0 ? ' (hold LvFinal)' :
                    needsLevelUpAnim ? ' (step-up pending)' :
                    this._trailsFlying ? ' (wait trail hit)' : ''),
            );
            return;
        }
        // Enter / resume / reset — sync idle (không tăng level)
        this._displayLevels = { ...this._targetLevels };
        this._applyAll(false);
        Log.d(`[CarnivalPot] sync idle B${this._displayLevels.blue} R${this._displayLevels.red} G${this._displayLevels.green}`);
    }

    private _onTrailHit(payload: { color?: TrailColor }): void {
        const color = payload?.color;
        if (color === undefined || this._bursting) return;
        const node = this._nodeFor(color);
        if (!node) return;
        this._playSoftBounce(node, this.hitBouncePeak, this.hitBounceSquash);
        this._playHitFx(node);
        this._tryStepUp(color);
    }

    private _onPotBurst(feature: CarnivalFeatureTrigger): void {
        if (!feature || this._bursting) {
            EventBus.instance.emit(GameEvents.CARNIVAL_POT_BURST_DONE, feature);
            return;
        }
        this._stopAllIdleWobble(true);
        this._burstDoneDeferred = false;
        this._bursting = true;
        this._trailsFlying = false;
        const hopColors = this._hopColorsFor(feature);
        feature.burstPots = hopColors;
        Log.e(`[CarnivalPot] BURST → ${feature.featureName} pots=[${hopColors.map(c => TrailColor[c]).join(',')}]`);

        const pots = hopColors
            .map(c => this._nodeFor(c))
            .filter((n): n is Node => !!n?.isValid);

        this._burstingPots = pots;
        this._cacheBaseTransforms();
        this._pendingBurstFeature = feature;
        this._burstWaitCount = 0;

        resetBurstPotState(hopColors);
        this._targetLevels = this._clampLevels(GameData.instance.potLevels);
        this._applyLabelsOnly();

        let asyncPotCount = 0;
        for (const node of pots) {
            const color = this._colorForNode(node);
            if (color === undefined) continue;
            asyncPotCount++;
            this._startPotBurstSequence(node, color);
        }

        this.unschedule(this._finishBurst);
        this._burstWaitCount = asyncPotCount;
        if (asyncPotCount <= 0) {
            this.scheduleOnce(this._finishBurst, Math.max(0.6, this.burstDuration));
        }
    }

    /**
     * Thắng trước khi hũ đầy: chạy chuỗi nạp còn lại (LvN→Lv10) rồi mới LvFinal.
     */
    private _startPotBurstSequence(node: Node, color: TrailColor): void {
        const display = this._displayOf(color);

        const runBurst = (spine: sp.Skeleton | null) => {
            if (display < POT_MAX_LEVEL && spine) {
                Log.d(
                    `[CarnivalPot] pre-burst fill start ${TrailColor[color]} Lv${display}→Lv${POT_MAX_LEVEL}`,
                );
                this._playPreBurstFillChain(node, spine, color, display, () => {
                    this._playPotBurstFinal(node, color);
                });
            } else {
                this._playPotBurstFinal(node, color);
            }
        };

        const spine = this._resolveSpine(node);
        if (spine) {
            runBurst(spine);
            return;
        }
        void this._ensureSpineReady(node).then((loaded) => {
            if (!node?.isValid || !this._bursting) return;
            runBurst(loaded);
        });
    }

    /** Nạp tuần tự từ fromLevel đến POT_MAX_LEVEL rồi gọi onComplete. */
    private _playPreBurstFillChain(
        node: Node,
        spine: sp.Skeleton,
        color: TrailColor,
        fromLevel: number,
        onComplete: () => void,
    ): void {
        if (fromLevel >= POT_MAX_LEVEL) {
            onComplete();
            return;
        }

        const animName = this._resolveLevelUpAnim(spine, fromLevel);
        if (!animName) {
            Log.w(`[CarnivalPot] pre-burst missing level-up from Lv${fromLevel} — jump`);
            this._setDisplayForColor(color, fromLevel + 1);
            this._applyDisplayLabels();
            this._playPreBurstFillChain(node, spine, color, fromLevel + 1, onComplete);
            return;
        }

        Log.d(
            `[CarnivalPot] pre-burst fill ${TrailColor[color]} ${animName} (${fromLevel}→${fromLevel + 1})`,
        );
        this._playOneShot(node, spine, animName, () => {
            this._setDisplayForColor(color, fromLevel + 1);
            this._applyDisplayLabels();
            this._playPreBurstFillChain(node, spine, color, fromLevel + 1, onComplete);
        }, this.preBurstFillTimeScale, () => {
            SoundManager.instance?.playPotLevelUpEffect(fromLevel + 1);
        });
    }

    /** LvFinal (+ FX) hoặc hop fallback sau khi đã nạp đầy. */
    private _playPotBurstFinal(node: Node, color: TrailColor): void {
        this._cancelAnim(node, true);
        const spine = this._resolveSpine(node);
        this._setDisplayForColor(color, POT_MAX_LEVEL);
        this._applyDisplayLabels();

        if (spine && this._hasSpineAnim(spine, BURST_ANIM)) {
            this._scheduleBurstFinalFx(node);
            this._playOneShot(node, spine, BURST_ANIM, () => {
                this._onBurstAnimDone(node);
            }, 1, () => {
                SoundManager.instance?.playSfxByName('sxPotFinal');
            });
            return;
        }

        this._playTriggerHop(node);
        this._frozenBurstNodes.add(node);
        this._onPotBurstSequenceDone();
    }

    private _onPotBurstSequenceDone(): void {
        this._burstWaitCount = Math.max(0, this._burstWaitCount - 1);
        if (this._burstWaitCount <= 0) this._finishBurst();
    }

    private _resolveLevelUpAnim(spine: sp.Skeleton, fromLevel: number): string | null {
        for (const name of levelUpAnimCandidates(fromLevel)) {
            if (this._hasSpineAnim(spine, name)) return name;
        }
        return null;
    }

    private _colorForNode(node: Node): TrailColor | undefined {
        if (node === this.bluePot) return TrailColor.BLUE;
        if (node === this.redPot) return TrailColor.RED;
        if (node === this.greenPot) return TrailColor.GREEN;
        return undefined;
    }

    private _onBurstAnimDone(node: Node): void {
        this._setDisplayForNode(node, 0);
        const spine = this._resolveSpine(node);
        if (spine) this._freezeAtLastFrame(spine);
        this._frozenBurstNodes.add(node);
        this._onPotBurstSequenceDone();
    }

    /**
     * Pot nổ theo feature (system):
     * 0 Mighty Blue | 1 Mega Green | 2 Super Blue+Green |
     * 3 Ultra Blue+Red | 4 Supreme Red+Green | 5 Ultimate Blue+Red+Green
     */
    private _hopColorsFor(feature: CarnivalFeatureTrigger): TrailColor[] {
        const fromKind = burstPotsForKind(feature.kind);
        if (fromKind.length) return fromKind;
        const apiType = GameData.instance.cnApiFeatureType
            ?? GameData.instance.lastSpinResponse?.currentFeatureType;
        if (apiType != null && Number(apiType) >= 0) {
            const fromApi = burstPotsForApiFeatureType(Number(apiType));
            if (fromApi.length) return fromApi;
        }
        return (feature.burstPots ?? []).slice();
    }

    private _freezeAtLastFrame(spine: sp.Skeleton): void {
        if (!spine?.isValid) return;
        try {
            const entry = spine.getCurrent?.(0);
            if (entry) {
                const end = (entry as any).animationEnd
                    ?? entry.animation?.duration
                    ?? 0;
                if (typeof end === 'number' && end > 0) {
                    (entry as any).trackTime = end;
                }
            }
        } catch {
            /* ignore */
        }
        spine.timeScale = 0;
    }

    /** Feature xong (về normal) → idle lại các pot đang giữ LvFinal. */
    private _onFeatureReturnToBase(): void {
        if (this._frozenBurstNodes.size === 0) return;
        if (GameData.instance.currentMode !== 'normal') return;
        this._restoreIdleAfterFeature();
    }

    /** Pick đóng = hết feature (kể cả Ultra sau Matsuri). */
    private _onPickGameClose(): void {
        if (this._frozenBurstNodes.size === 0) return;
        this._restoreIdleAfterFeature();
    }

    private _restoreIdleAfterFeature(): void {
        const nodes = [...this._frozenBurstNodes];
        this._frozenBurstNodes.clear();
        this._targetLevels = this._clampLevels(GameData.instance.potLevels);
        for (const node of nodes) {
            if (!node?.isValid) continue;
            this._setDisplayForNode(node, 0);
            const spine = this._resolveSpine(node);
            if (spine) {
                spine.timeScale = 1;
                this._playIdle(spine, 0);
            }
        }
        this._applyLabelsOnly();
        Log.d('[CarnivalPot] restore idle after feature');
        this._restartIdleWobbleAll();
    }

    private _finishBurst = (): void => {
        // LvFinal spine xong — fire ngay FX đã schedule nhưng chưa tới burstFinalFxDelay.
        for (const potNode of [...this._burstFinalFxScheduleCbs.keys()]) {
            this._cancelBurstFinalFxSchedule(potNode);
            if (potNode?.isValid) this._playBurstFinalFx(potNode);
        }

        this._burstWaitCount = 0;
        this._restoreBurstPots();
        this._burstDoneDeferred = true;
        this._tryCompleteBurst();
    };

    /** Emit BURST_DONE sau khi mọi burst final FX đã recycle (không cắt particle giữa chừng). */
    private _tryCompleteBurst(): void {
        if (!this._burstDoneDeferred || this._activeBurstFinalFx.size > 0) return;

        this._burstDoneDeferred = false;
        const feature = this._pendingBurstFeature;
        this._pendingBurstFeature = null;
        this._bursting = false;
        // Giữ pose LvFinal — không idle. Idle khi feature kết thúc.
        this._applyLabelsOnly();
        EventBus.instance.emit(GameEvents.CARNIVAL_POT_BURST_DONE, feature);
        Log.e('[CarnivalPot] BURST_DONE (hold LvFinal, burst FX finished)');
    }

    /** Popup Matsuri hiện — hủy schedule chưa fire; FX đang chạy vẫn để recycle tự nhiên. */
    private _onMatsuriStartPopup(): void {
        this._cancelAllBurstFinalFxSchedules();
    }

    // ─── Spine attach ───────────────────────────────────────────────────────

    private async _ensureSpinesLoaded(): Promise<void> {
        await Promise.all([
            this._ensurePotSpine(this.bluePot, POT_SPINE_PATH.blue),
            this._ensurePotSpine(this.redPot, POT_SPINE_PATH.red),
            this._ensurePotSpine(this.greenPot, POT_SPINE_PATH.green),
        ]);
        this._cacheSpines();
        if (!this._bursting && this._frozenBurstNodes.size === 0) this._applyAll(false);
        this._enableIdleWobble();
    }

    private _ensurePotSpine(node: Node | null, path: string): Promise<void> {
        if (!node?.isValid) return Promise.resolve();
        const existing = this._resolveSpine(node);
        if (existing?.skeletonData) {
            this._hideStaticSprite(node);
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const bundle = assetManager.getBundle(SPINE_BUNDLE);
            if (!bundle) {
                Log.w(`[CarnivalPot] Bundle '${SPINE_BUNDLE}' missing — cannot load ${path}`);
                resolve();
                return;
            }
            bundle.load(path, sp.SkeletonData, (err: Error | null, data: sp.SkeletonData) => {
                if (err || !data || !node.isValid) {
                    Log.w(`[CarnivalPot] load SkeletonData failed: ${path}`, err);
                    resolve();
                    return;
                }
                this._attachSpine(node, data);
                Log.d(`[CarnivalPot] attached ${path} → ${node.name}`);
                resolve();
            });
        });
    }

    private _attachSpine(node: Node, data: sp.SkeletonData): void {
        let spine = node.getComponent(sp.Skeleton) || node.getComponentInChildren(sp.Skeleton);
        if (!spine) {
            const child = new Node('PotSpine');
            child.layer = node.layer;
            child.setParent(node);
            child.setPosition(0, 0, 0);
            child.addComponent(UITransform);
            spine = child.addComponent(sp.Skeleton);
        }
        spine.premultipliedAlpha = false;
        spine.skeletonData = data;
        spine.node.active = true;
        this._spineByNode.set(node, spine);
        this._hideStaticSprite(node);
    }

    private _hideStaticSprite(node: Node): void {
        const sprite = node.getComponent(Sprite);
        if (sprite) sprite.enabled = false;
    }

    // ─── Level-up ───────────────────────────────────────────────────────────

    private _tryStepUp(color: TrailColor): void {
        if (this._bursting) return;
        const node = this._nodeFor(color);
        if (!node || this._animBusy.has(node) || this._frozenBurstNodes.has(node)) return;

        const display = this._displayOf(color);
        const target = this._targetOf(color);
        if (display >= target) return;

        const spine = this._resolveSpine(node);
        if (spine) {
            this._runStepUpOnce(color, node, spine);
            return;
        }
        void this._ensureSpineReady(node).then((loaded) => {
            if (!loaded || !node.isValid || this._bursting) return;
            if (this._animBusy.has(node) || this._frozenBurstNodes.has(node)) return;
            this._runStepUpOnce(color, node, loaded);
        });
    }

    private _runStepUpOnce(color: TrailColor, node: Node, spine: sp.Skeleton): void {
        const display = this._displayOf(color);
        const target = this._targetOf(color);
        if (display >= target) return;

        const animName = this._resolveLevelUpAnim(spine, display);
        if (!animName) {
            Log.w(`[CarnivalPot] missing level-up from Lv${display} — jump to Lv${display + 1}`);
            this._setDisplayForColor(color, display + 1);
            this._applyDisplayLabels();
            if (this._displayOf(color) < this._targetOf(color)) {
                this._tryStepUp(color);
            } else {
                this._playIdle(spine, this._displayOf(color));
            }
            return;
        }

        Log.d(`[CarnivalPot] ${TrailColor[color]} ${animName} (${display}→${display + 1}) target=${target}`);
        this._playOneShot(node, spine, animName, () => {
            this._setDisplayForColor(color, display + 1);
            this._applyDisplayLabels();
            if (this._bursting) return;
            if (this._displayOf(color) < this._targetOf(color)) {
                this._tryStepUp(color);
            } else {
                this._playIdle(spine, this._displayOf(color));
            }
        }, 1, () => {
            SoundManager.instance?.playPotLevelUpEffect(display + 1);
        });
    }

    private _flushPendingLevelUps(): void {
        this._tryStepUp(TrailColor.BLUE);
        this._tryStepUp(TrailColor.RED);
        this._tryStepUp(TrailColor.GREEN);
    }

    private _isFrozenSpine(spine: sp.Skeleton): boolean {
        for (const node of this._frozenBurstNodes) {
            if (this._resolveSpine(node) === spine) return true;
        }
        return false;
    }

    private _playIdle(spine: sp.Skeleton, level: number): void {
        if (!spine?.isValid || !spine.node?.active) return;
        if (this._isFrozenSpine(spine)) return;
        const animName = idleAnimName(level);
        if (!this._hasSpineAnim(spine, animName)) {
            Log.w(`[CarnivalPot] missing idle "${animName}" — skip`);
            return;
        }
        if (this._lastIdleByNode.get(spine.node) === animName && !this._animBusy.has(spine.node)) {
            const entry = spine.getCurrent?.(0);
            if (entry?.animation?.name === animName) return;
        }
        spine.timeScale = 1;
        try {
            spine.setAnimation(0, animName, true);
            this._lastIdleByNode.set(spine.node, animName);
        } catch (e) {
            Log.w(`[CarnivalPot] idle setAnimation failed "${animName}"`, e);
        }
    }

    private _playOneShot(
        node: Node,
        spine: sp.Skeleton,
        animName: string,
        onDone: () => void,
        timeScale = 1,
        onAnimStarted?: () => void,
    ): void {
        this._cancelIdleWobble(node, true);
        this._cancelAnim(node, false);
        this._lastIdleByNode.delete(spine.node);

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            this._animBusy.delete(node);
            const fb = this._animFallback.get(node);
            if (fb) {
                this.unschedule(fb);
                this._animFallback.delete(node);
            }
            if (spine.isValid) {
                spine.setCompleteListener(null);
                spine.timeScale = 1;
            }
            onDone();
        };

        if (!spine?.isValid || !spine.skeletonData) {
            Log.w(`[CarnivalPot] _playOneShot skip — spine chưa có skeletonData (${animName})`);
            finish();
            return;
        }
        if (!this._hasSpineAnim(spine, animName)) {
            Log.w(`[CarnivalPot] _playOneShot skip — thiếu anim "${animName}"`);
            finish();
            return;
        }

        const fallback = () => {
            Log.w(`[CarnivalPot] complete fallback → ${animName}`);
            finish();
        };
        this._animFallback.set(node, fallback);
        this._animBusy.add(node);

        const scale = Math.max(0.1, timeScale);
        const animDur = this._getSpineAnimDuration(spine, animName);
        spine.setCompleteListener((entry) => {
            if (entry?.animation?.name && entry.animation.name !== animName) return;
            finish();
        });
        this.scheduleOnce(fallback, Math.max(0.35, animDur / scale + 0.25));
        spine.timeScale = scale;
        try {
            spine.clearTracks();
            spine.setAnimation(0, animName, false);
            onAnimStarted?.();
        } catch (e) {
            Log.w(`[CarnivalPot] setAnimation failed "${animName}"`, e);
            finish();
        }
    }

    private _cancelAnim(node: Node, clearListener: boolean): void {
        this._animBusy.delete(node);
        const fb = this._animFallback.get(node);
        if (fb) {
            this.unschedule(fb);
            this._animFallback.delete(node);
        }
        if (clearListener) {
            const spine = this._spineOf(node);
            if (spine) spine.setCompleteListener(null);
        }
    }

    // ─── Transforms / bounce / hop ──────────────────────────────────────────

    private _cacheBaseTransforms(): void {
        for (const node of [this.bluePot, this.redPot, this.greenPot]) {
            if (!node) continue;
            if (!this._baseScaleByNode.has(node)) {
                this._baseScaleByNode.set(node, node.scale.clone());
            }
            if (!this._basePosByNode.has(node)) {
                this._basePosByNode.set(node, node.position.clone());
            }
            if (!this._baseAngleByNode.has(node)) {
                this._baseAngleByNode.set(node, node.angle);
            }
        }
    }

    private _baseScaleOf(node: Node): Vec3 {
        return this._baseScaleByNode.get(node)?.clone() ?? node.scale.clone();
    }

    private _basePosOf(node: Node): Vec3 {
        return this._basePosByNode.get(node)?.clone() ?? node.position.clone();
    }

    private _restoreBurstPots(): void {
        const pots = this._burstingPots;
        this._burstingPots = [];
        for (const node of pots) {
            if (!node?.isValid) continue;
            Tween.stopAllByTarget(node);
            node.setPosition(this._basePosOf(node));
            node.setScale(this._baseScaleOf(node));
        }
    }

    // ─── Pot FX (hit / burst final) ────────────────────────────────────────

    private _initFxPool(template: Node | null, setPool: (pool: NodePool | null) => void): void {
        if (!template?.isValid) {
            setPool(null);
            return;
        }
        template.active = false;
        for (const ps of template.getComponentsInChildren(ParticleSystem)) {
            if ('playOnAwake' in ps) {
                (ps as unknown as { playOnAwake: boolean }).playOnAwake = false;
            }
        }
        const pool = new NodePool();
        const seed = instantiate(template);
        seed.active = false;
        pool.put(seed);
        setPool(pool);
    }

    private _clearFxPool(pool: NodePool | null, setPool: (pool: NodePool | null) => void): void {
        if (!pool) return;
        while (pool.size() > 0) {
            const n = pool.get();
            if (n?.isValid) n.destroy();
        }
        pool.clear();
        setPool(null);
    }

    /** Đặt FX tại world position pot (cùng layer CarnivalPotBoard), reset offset emitter về tâm. */
    private _placeFxAtPot(fx: Node, potNode: Node): void {
        potNode.updateWorldTransform();
        this.node.updateWorldTransform();
        const layerUT = this.node.getComponent(UITransform);
        const localPos = layerUT
            ? layerUT.convertToNodeSpaceAR(potNode.getWorldPosition())
            : potNode.worldPosition.clone();
        fx.setParent(this.node, false);
        fx.setPosition(localPos.x, localPos.y, 0);
        fx.setRotationFromEuler(0, 0, 0);
        fx.setScale(1, 1, 1);
        this._resetFxEmitterPositions(fx);
    }

    /** Prefab FX thường bake offset design — đưa mọi node ParticleSystem về (0,0,0) local. */
    private _resetFxEmitterPositions(fxRoot: Node): void {
        const walk = (node: Node) => {
            if (node !== fxRoot && node.getComponent(ParticleSystem)) {
                node.setPosition(0, 0, 0);
            }
            for (const child of node.children) walk(child);
        };
        walk(fxRoot);
    }

    private _spawnPotFx(
        potNode: Node,
        template: Node | null,
        pool: NodePool | null,
        recycleDelay: number,
        maxPoolSize: number,
        trackBurstFinal = false,
    ): void {
        if (!potNode?.isValid || !template?.isValid || !pool) return;

        const fx = pool.size() > 0 ? pool.get()! : instantiate(template);
        this._placeFxAtPot(fx, potNode);
        fx.active = true;
        this._playAllChildParticles(fx);

        const delay = Math.max(0.5, recycleDelay);
        const recycleCb = () => {
            if (trackBurstFinal) {
                this._burstFinalFxRecycleCbs.delete(fx);
                this._activeBurstFinalFx.delete(fx);
            }
            this._recyclePotFx(fx, pool, maxPoolSize);
            if (trackBurstFinal) this._tryCompleteBurst();
        };
        if (trackBurstFinal) {
            this._activeBurstFinalFx.add(fx);
            this._burstFinalFxRecycleCbs.set(fx, recycleCb);
        }
        this.scheduleOnce(recycleCb, delay);
    }

    private _recyclePotFx(fx: Node, pool: NodePool, maxPoolSize: number): void {
        if (!fx?.isValid) return;
        this._stopPotFxTree(fx);
        fx.removeFromParent();
        if (pool.size() >= maxPoolSize) {
            fx.destroy();
            return;
        }
        pool.put(fx);
    }

    /** Dừng hẳn particle tree (Starlight/Coin…) — stop+clear, tắt emit, deactivate node. */
    private _stopPotFxTree(root: Node): void {
        if (!root?.isValid) return;
        const walk = (node: Node) => {
            for (const ps of node.getComponents(ParticleSystem)) {
                ps.loop = false;
                if (ps.rateOverTime) {
                    ps.rateOverTime.mode = 0;
                    ps.rateOverTime.constant = 0;
                }
                if (ps.rateOverDistance) {
                    ps.rateOverDistance.mode = 0;
                    ps.rateOverDistance.constant = 0;
                }
                ps.stop();
                const maybeClear = (ps as unknown as { clear?: () => void }).clear;
                if (maybeClear) maybeClear.call(ps);
            }
            for (const child of node.children) walk(child);
            node.active = false;
        };
        walk(root);
        root.active = false;
    }

    private _forceStopAllBurstFinalFx(): void {
        for (const cb of this._burstFinalFxRecycleCbs.values()) {
            this.unschedule(cb);
        }
        this._burstFinalFxRecycleCbs.clear();
        for (const fx of [...this._activeBurstFinalFx]) {
            if (!fx?.isValid) continue;
            this._stopPotFxTree(fx);
            fx.removeFromParent();
            const pool = this._burstFinalFxPool;
            if (pool && pool.size() < this._maxBurstFinalFxPoolSize) {
                pool.put(fx);
            } else {
                fx.destroy();
            }
        }
        this._activeBurstFinalFx.clear();
    }

    private _playHitFx(potNode: Node): void {
        this._spawnPotFx(
            potNode,
            this.hitFxTemplate,
            this._hitFxPool,
            this.hitFxRecycleDelay,
            this._maxHitFxPoolSize,
        );
    }

    private _scheduleBurstFinalFx(potNode: Node): void {
        if (!this.burstFinalFxTemplate?.isValid || !this._burstFinalFxPool) return;
        this._cancelBurstFinalFxSchedule(potNode);
        const delay = Math.max(0, this.burstFinalFxDelay);
        const cb = () => {
            this._burstFinalFxScheduleCbs.delete(potNode);
            if (!potNode?.isValid || !this._bursting) return;
            this._playBurstFinalFx(potNode);
        };
        this._burstFinalFxScheduleCbs.set(potNode, cb);
        this.scheduleOnce(cb, delay);
    }

    private _playBurstFinalFx(potNode: Node): void {
        this._spawnPotFx(
            potNode,
            this.burstFinalFxTemplate,
            this._burstFinalFxPool,
            this.burstFinalFxRecycleDelay,
            this._maxBurstFinalFxPoolSize,
            true,
        );
    }

    private _cancelBurstFinalFxSchedule(potNode: Node): void {
        const cb = this._burstFinalFxScheduleCbs.get(potNode);
        if (!cb) return;
        this.unschedule(cb);
        this._burstFinalFxScheduleCbs.delete(potNode);
    }

    private _cancelAllBurstFinalFxSchedules(): void {
        for (const cb of this._burstFinalFxScheduleCbs.values()) {
            this.unschedule(cb);
        }
        this._burstFinalFxScheduleCbs.clear();
    }

    /** Kích hoạt và play lại toàn bộ ParticleSystem trong cây con (kể cả inactive). */
    private _playAllChildParticles(root: Node): void {
        const walk = (node: Node) => {
            const systems = node.getComponents(ParticleSystem);
            if (systems.length > 0) node.active = true;
            for (const ps of systems) {
                ps.stop();
                ps.clear();
                ps.play();
            }
            for (const child of node.children) walk(child);
        };
        walk(root);
    }

    /** Nhún squash nhẹ 1 nhịp rồi về scale editor — trail trúng pot. */
    private _playSoftBounce(node: Node, peak = 1.08, squash = 0.92): void {
        if (!node?.isValid) return;
        this._cancelIdleWobble(node, true);
        Tween.stopAllByTarget(node);
        const base = this._baseScaleOf(node);
        node.setScale(base);
        tween(node)
            .to(0.07, { scale: new Vec3(base.x * peak, base.y * squash, base.z) }, { easing: 'sineOut' })
            .to(0.1, { scale: new Vec3(base.x * 0.97, base.y * 1.04, base.z) }, { easing: 'sineInOut' })
            .to(0.12, { scale: base.clone() }, { easing: 'sineOut' })
            .call(() => this._scheduleIdleWobble(node))
            .start();
    }

    /** Nhún lên-xuống khi không có LvFinal. */
    private _playTriggerHop(node: Node): void {
        if (!node?.isValid) return;
        this._cancelIdleWobble(node, true);
        Tween.stopAllByTarget(node);
        const basePos = this._basePosOf(node);
        const baseScale = this._baseScaleOf(node);
        node.setPosition(basePos);
        node.setScale(baseScale);

        const hops = Math.max(1, Math.floor(this.hopCount));
        const height = Math.max(16, this.hopHeight);
        let seq = tween(node);
        for (let i = 0; i < hops; i++) {
            const h = height * (1 - i * 0.18);
            const up = new Vec3(basePos.x, basePos.y + h, basePos.z);
            const stretch = new Vec3(baseScale.x * 0.92, baseScale.y * 1.12, baseScale.z);
            const squash = new Vec3(baseScale.x * 1.1, baseScale.y * 0.9, baseScale.z);
            seq = seq
                .to(0.12, { position: up, scale: stretch }, { easing: 'quadOut' })
                .to(0.12, { position: basePos.clone(), scale: squash }, { easing: 'quadIn' });
        }
        seq.to(0.1, { position: basePos.clone(), scale: baseScale.clone() }, { easing: 'sineOut' })
            .call(() => this._scheduleIdleWobble(node))
            .start();
    }

    // ─── Idle wobble (normal mode) ──────────────────────────────────────────

    private _enableIdleWobble(): void {
        this._idleWobbleEnabled = true;
        this._restartIdleWobbleAll();
    }

    private _restartIdleWobbleAll(): void {
        if (!this._idleWobbleEnabled) return;
        for (const node of [this.bluePot, this.redPot, this.greenPot]) {
            if (node?.isValid) this._scheduleIdleWobble(node);
        }
    }

    private _stopAllIdleWobble(restore: boolean): void {
        for (const node of [this.bluePot, this.redPot, this.greenPot]) {
            if (node?.isValid) this._cancelIdleWobble(node, restore);
        }
    }

    private _randomWobbleDelay(): number {
        const min = Math.max(1, this.idleWobbleMinInterval);
        const max = Math.max(min, this.idleWobbleMaxInterval);
        return min + Math.random() * (max - min);
    }

    private _canIdleWobble(node: Node): boolean {
        if (!this._idleWobbleEnabled || !node?.isValid || !node.active) return false;
        if (GameData.instance.currentMode !== 'normal') return false;
        if (this._bursting || this._trailsFlying) return false;
        if (this._animBusy.has(node) || this._frozenBurstNodes.has(node)) return false;
        return true;
    }

    private _scheduleIdleWobble(node: Node): void {
        this._cancelIdleWobbleSchedule(node);
        if (!node?.isValid) return;
        const cb = () => {
            this._idleWobbleScheduleCb.delete(node);
            this._playIdleWobble(node);
        };
        this._idleWobbleScheduleCb.set(node, cb);
        this.scheduleOnce(cb, this._randomWobbleDelay());
    }

    private _cancelIdleWobbleSchedule(node: Node): void {
        const cb = this._idleWobbleScheduleCb.get(node);
        if (!cb) return;
        this.unschedule(cb);
        this._idleWobbleScheduleCb.delete(node);
    }

    private _cancelIdleWobble(node: Node, restore: boolean): void {
        this._cancelIdleWobbleSchedule(node);
        if (!this._idleWobblePlaying.has(node)) return;
        Tween.stopAllByTarget(node);
        this._idleWobblePlaying.delete(node);
        if (restore && node?.isValid) {
            node.setPosition(this._basePosOf(node));
            node.angle = this._baseAngleOf(node);
            node.setScale(this._baseScaleOf(node));
        }
    }

    private _baseAngleOf(node: Node): number {
        return this._baseAngleByNode.get(node) ?? node.angle;
    }

    /** Rung lắc nhẹ ngẫu nhiên khi pot đang idle (normal mode). */
    private _playIdleWobble(node: Node): void {
        if (!this._canIdleWobble(node)) {
            if (node?.isValid && this._idleWobbleEnabled) {
                this._scheduleIdleWobble(node);
            }
            return;
        }
        if (this._idleWobblePlaying.has(node)) return;

        this._idleWobblePlaying.add(node);
        const basePos = this._basePosOf(node);
        const baseAngle = this._baseAngleOf(node);
        const baseScale = this._baseScaleOf(node);
        node.setPosition(basePos);
        node.angle = baseAngle;
        node.setScale(baseScale);

        const amp = Math.max(0.5, this.idleWobbleAngle);
        const shift = Math.max(0.5, this.idleWobbleShift);

        tween(node)
            .to(0.045, {
                angle: baseAngle + amp,
                position: new Vec3(basePos.x + shift, basePos.y + 0.8, basePos.z),
                scale: new Vec3(baseScale.x * 1.015, baseScale.y * 0.985, baseScale.z),
            }, { easing: 'sineOut' })
            .to(0.045, {
                angle: baseAngle - amp,
                position: new Vec3(basePos.x - shift, basePos.y, basePos.z),
                scale: new Vec3(baseScale.x * 0.99, baseScale.y * 1.01, baseScale.z),
            }, { easing: 'sineInOut' })
            .to(0.04, {
                angle: baseAngle + amp * 0.55,
                position: new Vec3(basePos.x + shift * 0.45, basePos.y + 0.4, basePos.z),
            }, { easing: 'sineInOut' })
            .to(0.04, {
                angle: baseAngle - amp * 0.4,
                position: new Vec3(basePos.x - shift * 0.35, basePos.y, basePos.z),
            }, { easing: 'sineInOut' })
            .to(0.07, {
                angle: baseAngle,
                position: basePos.clone(),
                scale: baseScale.clone(),
            }, { easing: 'sineOut' })
            .call(() => {
                this._idleWobblePlaying.delete(node);
                if (!node.isValid) return;
                node.setPosition(basePos);
                node.angle = baseAngle;
                node.setScale(baseScale);
                this._scheduleIdleWobble(node);
            })
            .start();
    }

    private _cacheSpines(): void {
        for (const node of [this.bluePot, this.redPot, this.greenPot]) {
            if (node) this._resolveSpine(node);
        }
    }

    private _spineOf(node: Node): sp.Skeleton | null {
        return this._resolveSpine(node);
    }

    private _spinePathForNode(node: Node): string | null {
        if (node === this.bluePot) return POT_SPINE_PATH.blue;
        if (node === this.redPot) return POT_SPINE_PATH.red;
        if (node === this.greenPot) return POT_SPINE_PATH.green;
        return null;
    }

    private async _ensureSpineReady(node: Node | null): Promise<sp.Skeleton | null> {
        if (!node?.isValid) return null;
        const ready = this._resolveSpine(node);
        if (ready) return ready;
        const path = this._spinePathForNode(node);
        if (!path) return null;
        await this._ensurePotSpine(node, path);
        return this._resolveSpine(node);
    }

    private _resolveSpine(node: Node): sp.Skeleton | null {
        const cached = this._spineByNode.get(node);
        if (cached?.isValid && cached.skeletonData) return cached;
        const spine = node.getComponent(sp.Skeleton) || node.getComponentInChildren(sp.Skeleton);
        if (!spine?.isValid || !spine.skeletonData) return null;
        this._spineByNode.set(node, spine);
        this._hideStaticSprite(node);
        return spine;
    }

    private _hasSpineAnim(spine: sp.Skeleton, animName: string): boolean {
        if (!spine?.skeletonData) return false;
        try {
            const find = (spine as any).findAnimation;
            if (typeof find === 'function') {
                return !!find.call(spine, animName);
            }
            const runtime = spine.skeletonData.getRuntimeData?.();
            if (runtime?.findAnimation) {
                return !!runtime.findAnimation(animName);
            }
        } catch {
            /* ignore */
        }
        return false;
    }

    private _getSpineAnimDuration(spine: sp.Skeleton, animName: string): number {
        try {
            const find = (spine as any).findAnimation;
            if (typeof find === 'function') {
                const anim = find.call(spine, animName);
                const dur = anim?.duration;
                if (typeof dur === 'number' && dur > 0) return dur;
            }
        } catch {
            /* ignore */
        }
        return 1.0;
    }

    // ─── Apply visual ───────────────────────────────────────────────────────

    private _syncLevelsFromData(forceDisplay: boolean): void {
        this._targetLevels = this._clampLevels(GameData.instance.potLevels);
        if (forceDisplay) this._displayLevels = { ...this._targetLevels };
    }

    private _clampLevels(levels: CarnivalPotLevels): CarnivalPotLevels {
        return {
            blue: clampPotLevel(levels.blue),
            red: clampPotLevel(levels.red),
            green: clampPotLevel(levels.green),
        };
    }

    private _applyAll(_animate: boolean): void {
        this._applyOne(this.bluePot, this.blueLevelLabel, this._displayLevels.blue);
        this._applyOne(this.redPot, this.redLevelLabel, this._displayLevels.red);
        this._applyOne(this.greenPot, this.greenLevelLabel, this._displayLevels.green);
    }

    private _applyLabelsOnly(): void {
        if (this.blueLevelLabel) this.blueLevelLabel.string = `Lv${this._targetLevels.blue}`;
        if (this.redLevelLabel) this.redLevelLabel.string = `Lv${this._targetLevels.red}`;
        if (this.greenLevelLabel) this.greenLevelLabel.string = `Lv${this._targetLevels.green}`;
    }

    private _applyDisplayLabels(): void {
        if (this.blueLevelLabel) this.blueLevelLabel.string = `Lv${this._displayLevels.blue}`;
        if (this.redLevelLabel) this.redLevelLabel.string = `Lv${this._displayLevels.red}`;
        if (this.greenLevelLabel) this.greenLevelLabel.string = `Lv${this._displayLevels.green}`;
    }

    private _applyOne(node: Node | null, label: Label | null, displayLevel: number): void {
        if (label) label.string = `Lv${displayLevel}`;
        if (!node || this._bursting) return;
        if (this._frozenBurstNodes.has(node)) return;
        if (this._animBusy.has(node)) return;

        const spine = this._spineOf(node);
        if (spine?.skeletonData) {
            this._playIdle(spine, displayLevel);
            return;
        }

        const s = this._scaleForLevel(displayLevel);
        node.setScale(s, s, 1);
    }

    private _scaleForLevel(level: number): number {
        const t = clampPotLevel(level) / POT_MAX_LEVEL;
        return this.scaleMin + (this.scaleMax - this.scaleMin) * t;
    }

    private _displayOf(color: TrailColor): number {
        switch (color) {
            case TrailColor.BLUE: return this._displayLevels.blue;
            case TrailColor.RED: return this._displayLevels.red;
            case TrailColor.GREEN: return this._displayLevels.green;
            default: return 0;
        }
    }

    private _targetOf(color: TrailColor): number {
        switch (color) {
            case TrailColor.BLUE: return this._targetLevels.blue;
            case TrailColor.RED: return this._targetLevels.red;
            case TrailColor.GREEN: return this._targetLevels.green;
            default: return 0;
        }
    }

    private _setDisplayForColor(color: TrailColor, level: number): void {
        const lv = clampPotLevel(level);
        if (color === TrailColor.BLUE) this._displayLevels.blue = lv;
        else if (color === TrailColor.RED) this._displayLevels.red = lv;
        else if (color === TrailColor.GREEN) this._displayLevels.green = lv;
    }

    private _setDisplayForNode(node: Node, level: number): void {
        if (node === this.bluePot) this._displayLevels.blue = clampPotLevel(level);
        else if (node === this.redPot) this._displayLevels.red = clampPotLevel(level);
        else if (node === this.greenPot) this._displayLevels.green = clampPotLevel(level);
    }

    private _nodeFor(color: TrailColor): Node | null {
        switch (color) {
            case TrailColor.BLUE: return this.bluePot;
            case TrailColor.RED: return this.redPot;
            case TrailColor.GREEN: return this.greenPot;
            default: return null;
        }
    }

    private _ensurePlaceholders(): void {
        if (this._placeholderBuilt) return;
        this._placeholderBuilt = true;
        this._paintPlaceholder(this.bluePot, new Color(60, 120, 220, 220), 'B');
        this._paintPlaceholder(this.redPot, new Color(220, 60, 60, 220), 'R');
        this._paintPlaceholder(this.greenPot, new Color(50, 180, 80, 220), 'G');
    }

    private _paintPlaceholder(node: Node | null, color: Color, tag: string): void {
        if (!node) return;
        if (this._spineOf(node)?.skeletonData) return;
        const hasSprite = !!node.getComponent(Sprite) || !!node.getComponentInChildren(Sprite);
        if (hasSprite) return;

        let g = node.getComponent(Graphics);
        if (!g) g = node.addComponent(Graphics);
        let tf = node.getComponent(UITransform);
        if (!tf) tf = node.addComponent(UITransform);
        tf.setContentSize(120, 120);
        g.clear();
        g.fillColor = color;
        g.circle(0, 0, 48);
        g.fill();
        g.strokeColor = new Color(255, 255, 255, 180);
        g.lineWidth = 3;
        g.circle(0, 0, 48);
        g.stroke();

        if (!node.getComponentInChildren(Label)) {
            const labelNode = new Node(`Tag_${tag}`);
            labelNode.setParent(node);
            const ltf = labelNode.addComponent(UITransform);
            ltf.setContentSize(60, 40);
            const lab = labelNode.addComponent(Label);
            lab.string = tag;
            lab.fontSize = 28;
            lab.color = Color.WHITE;
            lab.horizontalAlign = Label.HorizontalAlign.CENTER;
            lab.verticalAlign = Label.VerticalAlign.CENTER;
        }
    }
}
