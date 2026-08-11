/**
 * CarnivalTrailController — Trail Normal → flip màu → bay vào đúng Pot (Blue/Red/Green).
 *
 * FLOW:
 *   1. GameManager emit CARNIVAL_TRAIL_START { trails, potLevels }
 *   2. Mỗi reel stop có Trail → CARNIVAL_TRAIL_ONE (hoặc batch sau REELS_STOPPED)
 *   3. Flip TRAIL_NORMAL → TRAIL_BLUE/RED/GREEN (tween trên proxy — KHÔNG tween symbolNode
 *      vì SymbolView.setSymbol() gọi Tween.stopAllByTarget và sẽ cắt chuỗi bay)
 *   4. instantiate(particleTemplate) → child của CarnivalTrailController → bay tới Pot
 *   5. CARNIVAL_TRAIL_ONE_HIT → CarnivalPotBoard Spine impact
 *   6. CARNIVAL_TRAIL_FLY_DONE
 *
 * ĐƯỜNG BAY (dạng dấu hỏi "?"):
 *   Một cubic Bezier liên tục: từ Trail (dưới) vòng cung lên hơi cao hơn Pot rồi đổ xuống.
 *   Luôn vòng về phía gần Pot (mép Pot hướng về Symbol) — không vòng ra mặt xa.
 *   Tốc độ linear đều — không slow-start / tăng tốc giật.
 *   Timing Normal/Quick/Turbo khớp Wild Trail (0.8 / 0.65 / 0.5)
 *
 * SETUP EDITOR:
 *   1. Node "CarnivalTrailController" + gắn component
 *   2. Kéo 5 ReelController → reels
 *   3. Kéo 3 Pot → bluePot / redPot / greenPot
 *   4. Child inactive (Sprite / ParticleSystem) → particleTemplate
 */

import {
    _decorator, Component, Node, Vec3, tween,
    Color, Sprite, instantiate, ParticleSystem, UIOpacity, UITransform,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { ReelController } from './ReelController';
import { SymbolView } from './SymbolView';
import { Log } from '../core/Logger';
import { AutoSpinManager, SpeedMode } from '../manager/AutoSpinManager';
import {
    CarnivalTrailHit,
    TrailColor,
    SymbolId,
    trailColorToSymbolId,
} from '../data/SlotTypes';
import { CarnivalPotBoard } from './CarnivalPotBoard';

const { ccclass, property } = _decorator;

@ccclass('CarnivalTrailController')
export class CarnivalTrailController extends Component {

    @property({ type: [ReelController], tooltip: '5 ReelController 0→4' })
    reels: ReelController[] = [];

    @property({ type: Node, tooltip: 'Blue Pot target (left)' })
    bluePot: Node | null = null;

    @property({ type: Node, tooltip: 'Red Pot target (center)' })
    redPot: Node | null = null;

    @property({ type: Node, tooltip: 'Green Pot target (right)' })
    greenPot: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Template bay (child inactive).\ninstantiate mỗi lần → parent dưới CarnivalTrailController.',
    })
    particleTemplate: Node | null = null;

    @property({ tooltip: 'Flip half duration (giây)' })
    flipHalfDuration: number = 0.12;

    @property({
        tooltip: 'Sau khi reel dừng + hiện TRAIL_NORMAL xong, chờ bao lâu (giây) rồi mới flip/bay.',
    })
    postStopHoldDuration: number = 0.25;

    @property({ tooltip: 'Thời gian particle bay Normal (giây) — khớp Wild Trail' })
    flyDurationNormal: number = 0.8;

    @property({ tooltip: 'Thời gian particle bay Quick — khớp Wild Trail' })
    flyDurationQuick: number = 0.65;

    @property({ tooltip: 'Thời gian particle bay Turbo — khớp Wild Trail' })
    flyDurationTurbo: number = 0.5;

    @property({ tooltip: 'Scale particle bay' })
    flyScale: number = 1.0;

    @property({
        tooltip: 'Độ cao APEX phía trên Pot (world) — điểm đỉnh trước khi rơi xuống Pot.',
    })
    apexHeight: number = 110;

    @property({
        tooltip: 'Độ rộng vòng cung Bezier (tỉ lệ so với khoảng cách symbol→apex).\n'
               + 'Nhẹ vừa đủ thành dấu hỏi — không vòng lố như Wild Trail.',
        range: [0.15, 1.5, 0.05],
    })
    flyCurvature: number = 0.45;

    @property({
        tooltip: 'Khoảng cách tối thiểu (world) dùng để tính vòng cung.\n'
               + 'Giữ thấp để đường bay không bị ép vòng quá rộng khi gần Pot.',
    })
    minFlyPathDistance: number = 180;

    @property({
        tooltip: 'Delay tối thiểu trước khi bắt đầu bay (giây) — chờ particle/trail seed tại Symbol.\n'
               + 'Turbo/Quick sẽ tự nâng thêm để kịp thấy trail xuất phát từ Symbol.',
    })
    flyLaunchDelay: number = 0.06;

    @property({
        tooltip: 'Thời gian giữ particle sau khi chạm Pot (giây).\n'
               + 'Chạm Pot → loop=false, dừng emit, để particle/trail diễn hết rồi mới destroy.\n'
               + 'Thực tế lấy max(giá trị này, startLifetime + trailLife).',
    })
    particleFadeOutDuration: number = 1.2;

    private _pending: CarnivalTrailHit[] = [];
    private _flyingCount = 0;
    private _started = false;
    private _activeParticles: Node[] = [];

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.CARNIVAL_TRAIL_START, this._onTrailStart, this);
        bus.on(GameEvents.CARNIVAL_TRAIL_ONE, this._onTrailOne, this);
        bus.on(GameEvents.REELS_START_SPIN, this._onReelsStartSpin, this);
        bus.on(GameEvents.REELS_STOPPED, this._onReelsStoppedFallback, this);
    }

    start(): void {
        this._autoWireIfNeeded();
        if (this.particleTemplate?.isValid) {
            this.particleTemplate.active = false;
        }
        Log.e(
            `[CarnivalTrail] ready | reels=${this.reels?.length ?? 0}` +
            ` pots=B${!!this.bluePot}/R${!!this.redPot}/G${!!this.greenPot}` +
            ` template=${this.particleTemplate ? this.particleTemplate.name : 'NULL'}`
        );
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        this._clearParticles();
    }

    private _autoWireIfNeeded(): void {
        // Tự lấy pot từ CarnivalPotBoard nếu chưa kéo tay
        if (!this.bluePot || !this.redPot || !this.greenPot) {
            const board = this.node.getComponent(CarnivalPotBoard)
                ?? this.node.parent?.getComponent(CarnivalPotBoard)
                ?? this.node.scene?.getComponentInChildren(CarnivalPotBoard)
                ?? null;
            if (board) {
                this.bluePot = this.bluePot ?? board.bluePot;
                this.redPot = this.redPot ?? board.redPot;
                this.greenPot = this.greenPot ?? board.greenPot;
                Log.e('[CarnivalTrail] auto-wired pots from CarnivalPotBoard');
            }
        }
        // Template mặc định: child inactive đầu tiên (trừ khi đã gán)
        if (!this.particleTemplate) {
            for (const child of this.node.children) {
                if (!child.active) {
                    this.particleTemplate = child;
                    Log.e(`[CarnivalTrail] auto-wired particleTemplate="${child.name}"`);
                    break;
                }
            }
        }
    }

    private _onReelsStartSpin(): void {
        this.unscheduleAllCallbacks();
        this._pending = [];
        this._flyingCount = 0;
        this._started = false;
        this._clearParticles();
    }

    private _onTrailStart(payload: { trails?: CarnivalTrailHit[] }): void {
        this._pending = [...(payload?.trails ?? [])];
        this._started = true;
        this._flyingCount = 0;
        Log.e(`[CarnivalTrail] START count=${this._pending.length} → ${this._pending.map(t => `r${t.reel}row${t.row}:${TrailColor[t.color]}`).join(', ')}`);
    }

    private _onReelsStoppedFallback(): void {
        if (!this._started || this._pending.length === 0) return;
        if (this._flyingCount > 0) return;
        const batch = [...this._pending];
        this._pending = [];
        Log.e(`[CarnivalTrail] REELS_STOPPED fallback — ${batch.length} trails`);
        for (const hit of batch) this._holdNormalThenAnimate(hit);
    }

    private _onTrailOne(hit: CarnivalTrailHit): void {
        if (!hit) return;
        this._pending = this._pending.filter(t => !(t.reel === hit.reel && t.row === hit.row));

        const symbolNode = this._getSymbolNode(hit.reel, hit.row);
        const reelCtrl = this.reels[hit.reel];
        // Chờ stop-bounce xong → ép TRAIL_NORMAL → giữ 0.5s → flip/bay
        if (symbolNode?.isValid && reelCtrl && !reelCtrl.isIdle) {
            symbolNode.once('reel-settled', () => {
                if (symbolNode.isValid) this._holdNormalThenAnimate(hit);
            });
            return;
        }
        this._holdNormalThenAnimate(hit);
    }

    /** Ép hình gốc TRAIL_NORMAL, giữ postStopHoldDuration rồi mới flip + bay. */
    private _holdNormalThenAnimate(hit: CarnivalTrailHit): void {
        const symbolNode = this._getSymbolNode(hit.reel, hit.row);
        const view = symbolNode?.getComponent(SymbolView);
        if (view?.isValid) {
            view.setSymbol(SymbolId.TRAIL_NORMAL);
            this._resetSpriteColor(view);
        }
        const hold = Math.max(0, this.postStopHoldDuration);
        if (hold <= 0) {
            this._animateHit(hit);
            return;
        }
        this.scheduleOnce(() => this._animateHit(hit), hold);
    }

    private _animateHit(hit: CarnivalTrailHit): void {
        this._flyingCount++;
        const symbolNode = this._getSymbolNode(hit.reel, hit.row);
        if (!symbolNode) {
            Log.e(`[CarnivalTrail] MISSING symbol r${hit.reel}row${hit.row} — check reels[]`);
            this._flyingCount = Math.max(0, this._flyingCount - 1);
            this._emitHitAndMaybeDone(hit.color);
            return;
        }

        const view = symbolNode.getComponent(SymbolView);
        const coloredId = trailColorToSymbolId(hit.color);
        const baseX = symbolNode.scale.x;
        const baseY = symbolNode.scale.y;

        // Đảm bảo vẫn đang ở NORMAL trước khi bắt đầu flip (sau hold 0.5s)
        if (view) {
            view.setSymbol(SymbolId.TRAIL_NORMAL);
            this._resetSpriteColor(view);
        }

        const half = this.flipHalfDuration;
        // ★ Tween PROXY — không tween symbolNode (setSymbol sẽ stopAllByTarget và cắt chuỗi bay)
        const proxy = { s: baseX };
        tween(proxy)
            .to(half, { s: 0.05 }, {
                easing: 'sineIn',
                onUpdate: () => {
                    if (symbolNode.isValid) symbolNode.setScale(proxy.s, baseY, 1);
                },
            })
            .call(() => {
                if (view?.isValid) {
                    view.setSymbol(coloredId);
                    this._resetSpriteColor(view);
                }
                if (symbolNode.isValid) symbolNode.setScale(0.05, baseY, 1);
            })
            .to(half, { s: baseX }, {
                easing: 'sineOut',
                onUpdate: () => {
                    if (symbolNode.isValid) symbolNode.setScale(proxy.s, baseY, 1);
                },
            })
            .call(() => {
                if (symbolNode.isValid) symbolNode.setScale(baseX, baseY, 1);
                this._flyToPot(symbolNode, hit, () => {
                    this._flyingCount = Math.max(0, this._flyingCount - 1);
                    this._emitHitAndMaybeDone(hit.color);
                });
            })
            .start();
    }

    /**
     * Bay dạng dấu hỏi "?" — một cubic Bezier liên tục, tốc độ đều (linear):
     *   start (dưới) → vòng cung lên cao hơn Pot một chút → đổ xuống miệng Pot.
     * Timing: Normal 0.8 / Quick 0.65 / Turbo 0.5.
     */
    private _flyToPot(symbolNode: Node, hit: CarnivalTrailHit, onDone: () => void): void {
        const pot = this._potFor(hit.color);
        if (!pot?.isValid) {
            Log.e(`[CarnivalTrail] Pot NULL ${TrailColor[hit.color]} — không bay được`);
            this.scheduleOnce(onDone, 0.05);
            return;
        }

        const particle = this._spawnFromTemplate();
        if (!particle) {
            this.scheduleOnce(onDone, 0.05);
            return;
        }

        particle.setParent(this.node, false);
        this._activateTree(particle);
        particle.setSiblingIndex(this.node.children.length - 1);
        this._ensureVisible(particle);
        this._activeParticles.push(particle);

        const start = new Vec3();
        const end = new Vec3();
        symbolNode.getWorldPosition(start);
        pot.getWorldPosition(end);

        const apexH = Math.max(20, this.apexHeight);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        // Luôn vòng cung về phía gần Pot (mặt Pot hướng về Symbol), không vòng ra mặt xa.
        // VD: Symbol trái + Pot phải → tiếp cận mép trái Pot (side=-1), không vòng sang mép phải.
        const side = this._resolveFlySide(start, end, hit.reel);
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), this.minFlyPathDistance * 0.5, 1);
        const bulge = dist * Math.abs(this.flyCurvature);

        // CP1 gần Symbol — tangent đầu không quá lớn (Turbo dễ "nhảy" xa Symbol nếu CP1 xa)
        const riseY = Math.max(start.y, end.y) + apexH * 1.35;
        const cp1X = start.x + dx * 0.18 + side * bulge * 0.55;
        const cp1Y = start.y + (riseY - start.y) * 0.45;

        // CP2: neo phía trên Pot — phần thân "?" trước khi rơi xuống (cùng phía gần với Symbol)
        const cp2X = end.x + side * bulge * 0.2;
        const cp2Y = end.y + apexH;

        this._setWorldPosUnderSelf(particle, start);
        particle.setScale(this.flyScale, this.flyScale, 1);

        Log.e(
            `[CarnivalTrail] FLY? ${TrailColor[hit.color]} ` +
            `from(${start.x.toFixed(0)},${start.y.toFixed(0)}) ` +
            `rise(${cp1X.toFixed(0)},${cp1Y.toFixed(0)}) ` +
            `apex(${cp2X.toFixed(0)},${cp2Y.toFixed(0)}) ` +
            `→ pot(${end.x.toFixed(0)},${end.y.toFixed(0)})`
        );

        // Play ngay tại Symbol + 1 frame sau (processor sẵn) — seed trail trước khi bay
        this._playParticleSystems(particle);
        this.scheduleOnce(() => {
            if (particle.isValid) this._playParticleSystems(particle);
        }, 0);

        const flyProxy = { t: 0 };
        const pos = new Vec3();
        const totalDur = this._flyDuration();
        const launchDelay = this._getLaunchDelay(totalDur);
        const moveDur = Math.max(0.01, totalDur - launchDelay);

        const updatePos = (rawT: number) => {
            if (!particle.isValid) return;
            // Linear — diễn đều sau khi đã hold tại Symbol
            const t = Math.min(1, Math.max(0, rawT));
            const u = 1 - t;
            const uu = u * u;
            const tt = t * t;
            pos.x = uu * u * start.x + 3 * uu * t * cp1X + 3 * u * tt * cp2X + tt * t * end.x;
            pos.y = uu * u * start.y + 3 * uu * t * cp1Y + 3 * u * tt * cp2Y + tt * t * end.y;
            pos.z = 0;
            this._setWorldPosUnderSelf(particle, pos);
        };

        updatePos(0);

        // Hold tại Symbol suốt launchDelay — mỗi frame pin lại start (tránh drift / frame đầu lệch)
        tween(flyProxy)
            .delay(launchDelay)
            .call(() => {
                if (particle.isValid) this._setWorldPosUnderSelf(particle, start);
            })
            .to(moveDur, { t: 1 }, {
                easing: 'linear',
                onUpdate: () => updatePos(flyProxy.t),
            })
            .call(() => {
                // Chạm Pot → không destroy ngay: loop=false, để particle diễn hết rồi mới hủy
                this._beginParticleFadeOut(particle);
                onDone();
            })
            .start();
    }

    /**
     * Hold tại Symbol trước khi bay — Turbo giữ lâu hơn (tỉ lệ + tuyệt đối)
     * để particle/trail kịp hiện ngay tại Symbol, không nhảy ra giữa đường.
     */
    private _getLaunchDelay(totalDur: number): number {
        const mode = AutoSpinManager.instance.speedMode;
        let minHold = this.flyLaunchDelay;
        let maxFrac = 0.25;
        switch (mode) {
            case SpeedMode.TURBO:
                minHold = Math.max(this.flyLaunchDelay, 0.14);
                maxFrac = 0.35;
                break;
            case SpeedMode.QUICK:
                minHold = Math.max(this.flyLaunchDelay, 0.09);
                maxFrac = 0.3;
                break;
            default:
                minHold = Math.max(this.flyLaunchDelay, 0.06);
                maxFrac = 0.25;
                break;
        }
        return Math.min(Math.max(0, minHold), totalDur * maxFrac);
    }

    /** Tắt emit nhưng giữ ParticleSystem playing để particle/trail tàn dần. */
    private _stopParticleEmission(ps: ParticleSystem): void {
        ps.loop = false;
        if (ps.rateOverTime) {
            ps.rateOverTime.mode = 0;
            ps.rateOverTime.constant = 0;
        }
        if (ps.rateOverDistance) {
            ps.rateOverDistance.mode = 0;
            ps.rateOverDistance.constant = 0;
        }
        // Không stop()/clear() — Trail sẽ biến mất ngay nếu dừng simulate
        if (!ps.isPlaying) {
            ps.play();
        }
    }

    private _estimateParticleFadeDelay(root: Node): number {
        let maxLife = Math.max(0, this.particleFadeOutDuration);
        for (const ps of root.getComponentsInChildren(ParticleSystem)) {
            if (!ps.isValid) continue;
            const startLife = ps.startLifetime?.constant ?? 0;
            const trail = (ps as unknown as {
                trailModule?: { enable?: boolean; lifeTime?: { constant?: number } };
            }).trailModule;
            const trailLife = (trail?.enable && trail.lifeTime?.constant) ? trail.lifeTime.constant : 0;
            maxLife = Math.max(maxLife, startLife + trailLife + 0.15);
        }
        return maxLife;
    }

    private _beginParticleFadeOut(root: Node): void {
        if (!root?.isValid) return;
        root.active = true;
        for (const ps of root.getComponentsInChildren(ParticleSystem)) {
            if (!ps.isValid || !ps.enabled) continue;
            this._stopParticleEmission(ps);
        }
        const delay = this._estimateParticleFadeDelay(root);
        this.scheduleOnce(() => {
            this._destroyParticle(root);
        }, delay);
    }

    private _destroyParticle(root: Node): void {
        const idx = this._activeParticles.indexOf(root);
        if (idx >= 0) this._activeParticles.splice(idx, 1);
        if (root?.isValid) root.destroy();
    }

    /**
     * Chọn phía vòng cung gần Pot nhất theo vị trí Symbol → Pot.
     * -1 = lệch/tiếp cận mép trái Pot, +1 = mép phải Pot.
     * Symbol bên trái Pot → luôn -1; bên phải → luôn +1 (không vòng sang mặt xa).
     */
    private _resolveFlySide(start: Vec3, end: Vec3, reelIndex: number): number {
        const dx = end.x - start.x;
        if (Math.abs(dx) > 8) {
            // Symbol trái Pot → tiếp cận mép trái; Symbol phải Pot → mép phải.
            return dx > 0 ? -1 : 1;
        }
        // Gần như thẳng hàng theo X: fallback nhẹ theo reel để tránh cung phẳng.
        const reelCount = this.reels.length > 0 ? this.reels.length : 5;
        const center = Math.floor(reelCount / 2);
        if (reelIndex < center) return -1;
        if (reelIndex > center) return 1;
        return Math.random() < 0.5 ? -1 : 1;
    }

    private _setWorldPosUnderSelf(node: Node, world: Vec3): void {
        const ut = this.node.getComponent(UITransform);
        if (ut) {
            const local = ut.convertToNodeSpaceAR(world);
            node.setPosition(local);
        } else {
            node.setWorldPosition(world);
        }
    }

    private _activateTree(node: Node): void {
        node.active = true;
        for (const c of node.children) this._activateTree(c);
    }

    private _ensureVisible(node: Node): void {
        let op = node.getComponent(UIOpacity);
        if (!op) op = node.addComponent(UIOpacity);
        op.opacity = 255;
        // Đảm bảo controller cũng visible
        let selfOp = this.node.getComponent(UIOpacity);
        if (selfOp && selfOp.opacity < 10) selfOp.opacity = 255;
    }

    private _emitHitAndMaybeDone(color: TrailColor): void {
        EventBus.instance.emit(GameEvents.CARNIVAL_TRAIL_ONE_HIT, { color });
        if (this._flyingCount <= 0 && this._pending.length === 0) {
            this._started = false;
            EventBus.instance.emit(GameEvents.CARNIVAL_TRAIL_FLY_DONE);
            Log.e('[CarnivalTrail] FLY_DONE');
        }
    }

    private _getSymbolNode(reel: number, row: number): Node | null {
        const reelCtrl = this.reels[reel];
        if (!reelCtrl) return null;
        const nodeIdx = 3 - row;
        return reelCtrl.symbolNodes[nodeIdx] ?? null;
    }

    private _potFor(color: TrailColor): Node | null {
        switch (color) {
            case TrailColor.BLUE: return this.bluePot;
            case TrailColor.RED: return this.redPot;
            case TrailColor.GREEN: return this.greenPot;
            default: return this.redPot;
        }
    }

    private _resetSpriteColor(view: SymbolView): void {
        const sprite = view.node.getComponent(Sprite)
            ?? view.node.getComponentInChildren(Sprite);
        if (sprite) sprite.color = Color.WHITE;
    }

    private _flyDuration(): number {
        switch (AutoSpinManager.instance.speedMode) {
            case SpeedMode.TURBO: return this.flyDurationTurbo;
            case SpeedMode.QUICK: return this.flyDurationQuick;
            default: return this.flyDurationNormal;
        }
    }

    private _spawnFromTemplate(): Node | null {
        if (!this.particleTemplate?.isValid) {
            Log.e('[CarnivalTrail] particleTemplate NULL — kéo child template vào slot');
            return null;
        }
        const clone = instantiate(this.particleTemplate);
        clone.name = `CarnivalTrailFly_${Date.now() % 100000}`;
        clone.active = false;
        for (const ps of clone.getComponentsInChildren(ParticleSystem)) {
            if ('playOnAwake' in ps) {
                (ps as unknown as { playOnAwake: boolean }).playOnAwake = false;
            }
        }
        return clone;
    }

    private _playParticleSystems(root: Node): void {
        const systems = root.getComponentsInChildren(ParticleSystem);
        if (systems.length === 0) {
            Log.e(`[CarnivalTrail] template "${root.name}" không có ParticleSystem — vẫn bay node/Sprite nếu có`);
        }
        for (const ps of systems) {
            if (!ps.isValid || !ps.enabled) continue;
            try {
                ps.loop = true;
                if ('prewarm' in ps) {
                    (ps as unknown as { prewarm: boolean }).prewarm = false;
                }
                const trail = (ps as unknown as {
                    trailModule?: { enable?: boolean; _enable?: boolean };
                }).trailModule;
                const hasTrail = !!(trail?.enable ?? trail?._enable);
                // Trail: không stop+clear — dễ làm ribbon nhảy lệch khỏi Symbol
                if (hasTrail) {
                    if (!ps.isPlaying) ps.play();
                } else {
                    ps.stop();
                    const maybeClear = (ps as unknown as { clear?: () => void }).clear;
                    if (maybeClear) maybeClear.call(ps);
                    ps.play();
                }
            } catch (err) {
                Log.e('[CarnivalTrail] play particle failed:', err);
            }
        }
    }

    private _clearParticles(): void {
        for (const p of this._activeParticles) {
            if (p?.isValid) p.destroy();
        }
        this._activeParticles.length = 0;
    }
}
