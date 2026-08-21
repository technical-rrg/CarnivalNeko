/**
 * CarnivalPotBoard — 3 Pot (Blue / Red / Green) Spine + burst khi Feature Trigger.
 *
 * Events:
 *   CARNIVAL_POT_LEVELS_CHANGED → sync labels (visual tạm = LV3)
 *   CARNIVAL_TRAIL_ONE_HIT      → nhún nhẹ + LV{n}_Impact rồi Idle_LV{n}
 *   CARNIVAL_POT_BURST          → nhún lên-xuống các pot tương ứng → CARNIVAL_POT_BURST_DONE
 *
 * Tạm thời force visual level = 3 cho idle + impact (cùng Anim-Pot skeleton như Pot cũ).
 */

import {
    _decorator, Component, Node, Label, Vec3, tween, Tween,
    UITransform, Color, Graphics, Sprite, sp,
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
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

/** Tạm: mọi pot idle/impact theo level 3. */
const FORCE_VISUAL_LEVEL = 3;

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

    @property({ tooltip: 'Thời gian burst anim trước khi DONE (giây)' })
    burstDuration: number = 1.15;

    @property({ tooltip: 'Biên độ nhún lên khi trigger Matsuri (px)' })
    hopHeight: number = 56;

    @property({ tooltip: 'Số lần nhún lên-xuống khi trigger Matsuri' })
    hopCount: number = 3;

    private _levels: CarnivalPotLevels = { blue: 0, red: 0, green: 0 };
    private _placeholderBuilt = false;
    private _bursting = false;
    private _burstingPots: Node[] = [];
    private _pendingBurstFeature: CarnivalFeatureTrigger | null = null;

    /** Spine cache per pot node */
    private _spineByNode = new Map<Node, sp.Skeleton>();
    /** Scale mặc định từ editor — không ghi đè về 1 */
    private _baseScaleByNode = new Map<Node, Vec3>();
    /** Position mặc định từ editor — hop xong trả về đây */
    private _basePosByNode = new Map<Node, Vec3>();
    /** Impact state per pot (tránh idle cắt impact / impact chồng nhau) */
    private _impactActive = new Set<Node>();
    private _impactFallback = new Map<Node, () => void>();

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.CARNIVAL_POT_LEVELS_CHANGED, this._onLevelsChanged, this);
        bus.on(GameEvents.CARNIVAL_TRAIL_ONE_HIT, this._onTrailHit, this);
        bus.on(GameEvents.CARNIVAL_POT_BURST, this._onPotBurst, this);
        bus.on(GameEvents.GAME_READY, this._onGameReady, this);
        this._cacheBaseTransforms();
    }

    start(): void {
        this._cacheBaseTransforms();
        this._cacheSpines();
        this._ensurePlaceholders();
        this._levels = { ...GameData.instance.potLevels };
        this._applyAll(false);
    }

    onDestroy(): void {
        for (const node of this._impactActive) {
            this._cancelImpact(node, true);
        }
        this.unschedule(this._finishBurst);
        this._pendingBurstFeature = null;
        this._restoreBurstPots();
        EventBus.instance.offTarget(this);
    }

    private _onGameReady(): void {
        this._cacheSpines();
        this._levels = { ...GameData.instance.potLevels };
        this._applyAll(false);
    }

    private _onLevelsChanged(levels: CarnivalPotLevels): void {
        if (!levels) return;
        this._levels = { ...levels };
        // Data level đổi vẫn giữ idle LV3 (tạm); chỉ refresh label
        this._applyAll(false);
        Log.d(`[CarnivalPot] levels B${levels.blue} R${levels.red} G${levels.green} (visual Idle_LV${FORCE_VISUAL_LEVEL})`);
    }

    private _onTrailHit(payload: { color?: TrailColor }): void {
        const color = payload?.color;
        if (color === undefined || this._bursting) return;
        const node = this._nodeFor(color);
        if (!node) return;
        this._playSoftBounce(node, 1.07, 0.92);
        const spine = this._resolveSpine(node);
        if (!spine) {
            Log.w(`[CarnivalPot] trail hit ${TrailColor[color]} — no Spine, bounce only`);
            return;
        }
        void this._playImpactAsync(node, spine);
    }

    private _onPotBurst(feature: CarnivalFeatureTrigger): void {
        if (!feature || this._bursting) {
            EventBus.instance.emit(GameEvents.CARNIVAL_POT_BURST_DONE, feature);
            return;
        }
        this._bursting = true;
        const hopColors = this._hopColorsFor(feature);
        feature.burstPots = hopColors;
        Log.e(`[CarnivalPot] BURST → ${feature.featureName} pots=[${hopColors.map(c => TrailColor[c]).join(',')}]`);

        const pots = hopColors
            .map(c => this._nodeFor(c))
            .filter((n): n is Node => !!n?.isValid);

        this._burstingPots = pots;
        this._cacheBaseTransforms();
        for (const node of pots) {
            this._cancelImpact(node, true);
            this._playTriggerHop(node);
        }

        resetBurstPotState(hopColors);
        this._levels = { ...GameData.instance.potLevels };
        this._applyLabelsOnly();

        this.unschedule(this._finishBurst);
        this._pendingBurstFeature = feature;
        this.scheduleOnce(this._finishBurst, Math.max(0.6, this.burstDuration));
    }

    /**
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

    private _finishBurst = (): void => {
        const feature = this._pendingBurstFeature;
        this._pendingBurstFeature = null;
        this._restoreBurstPots();
        this._bursting = false;
        this._applyAll(false);
        EventBus.instance.emit(GameEvents.CARNIVAL_POT_BURST_DONE, feature);
        Log.e('[CarnivalPot] BURST_DONE');
    };

    // ─── Spine idle / impact (mirror PotController) ─────────────────────────

    private _visualLevel(): number {
        return FORCE_VISUAL_LEVEL;
    }

    private _cacheBaseTransforms(): void {
        for (const node of [this.bluePot, this.redPot, this.greenPot]) {
            if (!node) continue;
            if (!this._baseScaleByNode.has(node)) {
                this._baseScaleByNode.set(node, node.scale.clone());
            }
            if (!this._basePosByNode.has(node)) {
                this._basePosByNode.set(node, node.position.clone());
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

    /** Nhún squash nhẹ 1 nhịp rồi về scale editor — không zoom to. */
    private _playSoftBounce(node: Node, peak = 1.07, squash = 0.93): void {
        if (!node?.isValid) return;
        Tween.stopAllByTarget(node);
        const base = this._baseScaleOf(node);
        node.setScale(base);
        tween(node)
            .to(0.08, { scale: new Vec3(base.x * peak, base.y * squash, base.z) }, { easing: 'sineOut' })
            .to(0.12, { scale: new Vec3(base.x * 0.98, base.y * 1.03, base.z) }, { easing: 'sineInOut' })
            .to(0.14, { scale: base.clone() }, { easing: 'sineOut' })
            .start();
    }

    /** Nhún lên-xuống rõ khi Matsuri / Jackpot kích hoạt — chỉ pot tương ứng. */
    private _playTriggerHop(node: Node): void {
        if (!node?.isValid) return;
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
        seq.to(0.1, { position: basePos.clone(), scale: baseScale.clone() }, { easing: 'sineOut' }).start();
    }

    private _cacheSpines(): void {
        for (const node of [this.bluePot, this.redPot, this.greenPot]) {
            if (node) this._resolveSpine(node);
        }
    }

    private _spineOf(node: Node): sp.Skeleton | null {
        return this._resolveSpine(node);
    }

    private _resolveSpine(node: Node): sp.Skeleton | null {
        const cached = this._spineByNode.get(node);
        if (cached?.isValid) return cached;
        const spine = node.getComponent(sp.Skeleton) || node.getComponentInChildren(sp.Skeleton);
        if (spine) this._spineByNode.set(node, spine);
        return spine ?? null;
    }

    private _playIdle(spine: sp.Skeleton, level: number): void {
        if (!spine?.isValid || !spine.node?.active) return;
        const animName = `Idle_LV${level}`;
        if (!this._hasSpineAnim(spine, animName)) {
            Log.w(`[CarnivalPot] missing idle "${animName}" — skip`);
            return;
        }
        spine.timeScale = 1;
        try {
            spine.setAnimation(0, animName, true);
        } catch (e) {
            Log.w(`[CarnivalPot] idle setAnimation failed "${animName}"`, e);
        }
    }

    private _playImpactAsync(node: Node, spine: sp.Skeleton): Promise<void> {
        return new Promise((resolve) => {
            if (!spine?.isValid || !spine.node?.active || this._bursting) {
                resolve();
                return;
            }
            const level = this._visualLevel();
            if (level <= 0) {
                resolve();
                return;
            }
            const animName = `LV${level}_Impact`;
            if (!this._hasSpineAnim(spine, animName)) {
                Log.w(`[CarnivalPot] missing impact "${animName}" — skip`);
                resolve();
                return;
            }

            this._cancelImpact(node, false);

            let finished = false;
            const finishAnim = () => {
                if (finished || !this._impactActive.has(node)) return;
                finished = true;
                this._impactActive.delete(node);
                const fb = this._impactFallback.get(node);
                if (fb) {
                    this.unschedule(fb);
                    this._impactFallback.delete(node);
                }
                if (this._bursting) {
                    resolve();
                    return;
                }
                if (spine.isValid) spine.setCompleteListener(null);
                this._playIdle(spine, this._visualLevel());
                resolve();
            };

            const fallback = () => {
                Log.w(`[CarnivalPot] impact complete fallback → ${animName}`);
                finishAnim();
            };
            this._impactFallback.set(node, fallback);

            const animDur = this._getSpineAnimDuration(spine, animName);
            this._impactActive.add(node);
            Log.d(`[CarnivalPot] impact ${node.name} → ${animName}`);
            spine.setCompleteListener((entry) => {
                if (entry?.animation?.name && entry.animation.name !== animName) return;
                finishAnim();
            });
            this.scheduleOnce(fallback, Math.max(2.0, animDur + 0.5));
            spine.timeScale = 1;
            try {
                spine.setAnimation(0, animName, false);
            } catch (e) {
                Log.w(`[CarnivalPot] impact setAnimation failed "${animName}"`, e);
                finishAnim();
            }
        });
    }

    private _cancelImpact(node: Node, clearListener: boolean): void {
        this._impactActive.delete(node);
        const fb = this._impactFallback.get(node);
        if (fb) {
            this.unschedule(fb);
            this._impactFallback.delete(node);
        }
        if (clearListener) {
            const spine = this._spineOf(node);
            if (spine) spine.setCompleteListener(null);
        }
    }

    private _hasSpineAnim(spine: sp.Skeleton, animName: string): boolean {
        try {
            const find = (spine as any).findAnimation;
            if (typeof find === 'function') {
                return !!find.call(spine, animName);
            }
        } catch {
            /* ignore */
        }
        return true;
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

    private _applyAll(_animate: boolean): void {
        this._applyOne(this.bluePot, this.blueLevelLabel, this._levels.blue);
        this._applyOne(this.redPot, this.redLevelLabel, this._levels.red);
        this._applyOne(this.greenPot, this.greenLevelLabel, this._levels.green);
    }

    private _applyLabelsOnly(): void {
        // Label theo data thật; Spine visual tạm luôn LV3
        if (this.blueLevelLabel) this.blueLevelLabel.string = `Lv${this._levels.blue}`;
        if (this.redLevelLabel) this.redLevelLabel.string = `Lv${this._levels.red}`;
        if (this.greenLevelLabel) this.greenLevelLabel.string = `Lv${this._levels.green}`;
    }

    private _applyOne(node: Node | null, label: Label | null, dataLevel?: number): void {
        const dataLv = dataLevel ?? this._visualLevel();
        if (label) label.string = `Lv${dataLv}`;
        if (!node || this._bursting) return;

        const spine = this._spineOf(node);
        if (spine) {
            if (!this._impactActive.has(node)) {
                this._playIdle(spine, this._visualLevel());
            }
            return;
        }

        // Fallback scale theo visual force level (không có Spine)
        const s = this._scaleForLevel(this._visualLevel());
        node.setScale(s, s, 1);
    }

    private _scaleForLevel(level: number): number {
        const t = Math.min(10, Math.max(0, level)) / 10;
        return this.scaleMin + (this.scaleMax - this.scaleMin) * t;
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
        // Có Spine / Sprite → không vẽ placeholder
        if (this._spineOf(node)) return;
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
