/**
 * CarnivalTrailController — Trail Normal → flip màu → bay vào đúng Pot (Blue/Red/Green).
 *
 * FLOW:
 *   1. GameManager emit CARNIVAL_TRAIL_START { trails, potLevels }
 *   2. Mỗi reel stop có Trail → CARNIVAL_TRAIL_ONE (hoặc batch sau REELS_STOPPED)
 *   3. Flip TRAIL_NORMAL → TRAIL_BLUE/RED/GREEN (tween trên proxy — KHÔNG tween symbolNode
 *      vì SymbolView.setSymbol() gọi Tween.stopAllByTarget và sẽ cắt chuỗi bay)
 *   4. instantiate(particleTemplate) → child của CarnivalTrailController → bay tới Pot
 *   5. CARNIVAL_TRAIL_ONE_HIT → CarnivalPotBoard bounce
 *   6. CARNIVAL_TRAIL_FLY_DONE
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

    @property({ tooltip: 'Fly duration Normal (giây)' })
    flyDurationNormal: number = 0.75;

    @property({ tooltip: 'Fly duration Quick' })
    flyDurationQuick: number = 0.55;

    @property({ tooltip: 'Fly duration Turbo' })
    flyDurationTurbo: number = 0.4;

    @property({ tooltip: 'Scale particle bay' })
    flyScale: number = 1.0;

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
        for (const hit of batch) this._animateHit(hit);
    }

    private _onTrailOne(hit: CarnivalTrailHit): void {
        if (!hit) return;
        this._pending = this._pending.filter(t => !(t.reel === hit.reel && t.row === hit.row));
        this._animateHit(hit);
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

        // Child của CarnivalTrailController
        particle.setParent(this.node, false);
        this._activateTree(particle);
        particle.setSiblingIndex(this.node.children.length - 1);
        this._ensureVisible(particle);
        this._activeParticles.push(particle);

        const start = new Vec3();
        const end = new Vec3();
        symbolNode.getWorldPosition(start);
        pot.getWorldPosition(end);

        // Đặt local pos qua UITransform của controller (ổn định hơn setWorldPosition thuần)
        this._setWorldPosUnderSelf(particle, start);
        particle.setScale(this.flyScale, this.flyScale, 1);

        Log.e(
            `[CarnivalTrail] FLY ${TrailColor[hit.color]} template="${this.particleTemplate?.name}" ` +
            `from(${start.x.toFixed(0)},${start.y.toFixed(0)}) → (${end.x.toFixed(0)},${end.y.toFixed(0)})`
        );

        // Play particle sau 1 frame (processor sẵn)
        this.scheduleOnce(() => {
            if (particle.isValid) this._playParticleSystems(particle);
        }, 0);

        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const dist = Math.max(120, Math.sqrt(dx * dx + dy * dy));
        const side = hit.reel < 2 ? -1 : hit.reel > 2 ? 1 : (Math.random() < 0.5 ? -1 : 1);
        const cp1 = new Vec3(start.x + dx * 0.25 + side * dist * 0.35, start.y + dy * 0.25 + dist * 0.2, 0);
        const cp2 = new Vec3(start.x + dx * 0.65 + side * dist * 0.2, start.y + dy * 0.65 + dist * 0.15, 0);

        const flyProxy = { t: 0 };
        const pos = new Vec3();
        const dur = this._flyDuration();

        tween(flyProxy)
            .to(dur, { t: 1 }, {
                easing: 'quadIn',
                onUpdate: () => {
                    if (!particle.isValid) return;
                    const t = flyProxy.t;
                    const u = 1 - t;
                    pos.x = u * u * u * start.x + 3 * u * u * t * cp1.x + 3 * u * t * t * cp2.x + t * t * t * end.x;
                    pos.y = u * u * u * start.y + 3 * u * u * t * cp1.y + 3 * u * t * t * cp2.y + t * t * t * end.y;
                    pos.z = 0;
                    this._setWorldPosUnderSelf(particle, pos);
                },
            })
            .call(() => {
                if (particle.isValid) particle.destroy();
                const idx = this._activeParticles.indexOf(particle);
                if (idx >= 0) this._activeParticles.splice(idx, 1);
                onDone();
            })
            .start();
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
                ps.stop();
                const maybeClear = (ps as unknown as { clear?: () => void }).clear;
                if (maybeClear) maybeClear.call(ps);
                ps.play();
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
