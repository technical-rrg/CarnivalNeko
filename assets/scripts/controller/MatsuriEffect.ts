/**
 * MatsuriEffect — VFX Matsuri (seed + collect).
 *
 * TIMELINE
 *  A) VÀO FEATURE (SEED)
 *     bắn orb lần lượt xuống reel → sticky vàng hiện đủ
 *     → nhún highlight song song lệch pha (L→R, trên→dưới) → SEED_DONE → spin
 *  B) GREEN LAND (COLLECT)
 *     nhún highlight song song lệch pha các sticky vàng
 *     → clone bay về UI tổng tiền → flip Green→Gold (lúc đó mới hiện CreditLabel)
 *
 * INSPECTOR (chỉ gán node, không chỉnh timing):
 *   seedSourceNode / seedOrbTemplate / collectTargetNode / …
 *
 * TIMING: hardcode const phía dưới — sửa số ở đó.
 */

import {
    _decorator, Component, Node, tween, Vec3, Tween,
    UITransform, UIOpacity, isValid, instantiate,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { StickyCell, SymbolId } from '../data/SlotTypes';
import { MATSURI_GOLD_SYMBOL } from '../data/MatsuriGridUtil';
import { Log } from '../core/Logger';
import { SpriteNumber } from '../core/SpriteNumber';
import { StickyOverlayController } from './StickyOverlayController';
import { TopUpAbsorbEffect } from './TopUpAbsorbEffect';
import { TOPUP_STICKY_SYMBOL_SCALE } from './TopUpReelController';
import { FreeSpinGoldUI } from './FreeSpinGoldUI';
import { SymbolView } from './SymbolView';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

// ═══════════════════════════════════════════════════════════════════════════════
// TIMING (giây, trừ *_Y / *_SCALE). Chỉ đụng vài dòng “hay chỉnh” nếu cần.
// ═══════════════════════════════════════════════════════════════════════════════

// ── A) SEED — bắn orb tạo sticky vàng trên reel ───────────────────────────────
/** ★ Hay chỉnh: cách bao lâu thì BẮT ĐẦU bắn orb kế (L→R, trên→dưới). */
const SEED_LAUNCH_INTERVAL = 0.5;
/** Thời gian 1 orb bay từ nguồn → ô đích (càng lớn = bay càng chậm). */
const SEED_ORB_FLY_DURATION = 0.5;
/** Thời gian orb nhún hop lên trước khi lao xuống ô. */
const SEED_ORB_HOP_DURATION = 0.2;
/** Độ cao hop (pixel world) trước khi bay xuống. */
const SEED_ORB_HOP_Y = 50;
/** Scale lúc orb vừa spawn (0.2 = nhỏ 20% rồi phóng to khi hop). */
const SEED_ORB_START_SCALE = 0.2;

// ── B) HIGHLIGHT — nhún sticky vàng song song, lệch pha (sau seed / trước bay tiền)
/** ★ Hay chỉnh: cách bao lâu thì BẮT ĐẦU nhún sticky kế (song song, không chờ xong). */
const HIGHLIGHT_STAGGER = 0.05;
/** Thời lượng 1 nhún của 1 sticky (scale+nhảy Y rồi settle). */
const HIGHLIGHT_BOUNCE_DURATION = 0.5;
/** Độ cao nhảy Y (pixel) khi nhún. */
const HIGHLIGHT_JUMP_Y = 16;
/** Nghỉ ngắn sau khi nhún hết tất cả, trước khi clone bay tiền. */
const DELAY_BEFORE_FLY = 0.04;

// ── C) FLY — clone sticky vàng bay về UI tổng tiền ────────────────────────────
/** Thời gian 1 clone bay từ ô → UI đích. */
const FLY_DURATION = 0.45;
/** ★ Hay chỉnh: cách bao lâu thì BẮT ĐẦU bay clone kế (song song, lệch pha). */
const FLY_STAGGER = 0.08;
/** Scale lúc tới đích / biến mất (nhỏ lại). */
const FLY_END_SCALE = 0.15;
/** Thời gian co nhỏ + fade khi tới đích. */
const FLY_SHRINK_DURATION = 0.12;

@ccclass('MatsuriEffect')
export class MatsuriEffect extends Component {

    // ── Node refs (gán 1 lần) ─────────────────────────────────────────────────

    @property({
        type: Node,
        tooltip: 'Điểm xuất phát bắn Start Gold vào grid khi vào Matsuri.',
    })
    seedSourceNode: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Template object bay seed (active=false). Trống → clone seedSourceNode.',
    })
    seedOrbTemplate: Node | null = null;

    @property({
        type: Node,
        tooltip: 'UI đích nhận tiền khi collect Gold (FreeSpinUI / CoinCount).',
    })
    collectTargetNode: Node | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'SpriteNumber tổng tiền — pulse khi nhận credit (optional).',
    })
    collectTotalSpriteNumber: SpriteNumber | null = null;

    @property({
        type: StickyOverlayController,
        tooltip: 'StickyOverlay — wire runtime; có thể để trống.',
    })
    stickyOverlay: StickyOverlayController | null = null;

    @property({
        type: TopUpAbsorbEffect,
        tooltip: 'Optional fly layer (UITransform).',
    })
    topUpAbsorbEffect: TopUpAbsorbEffect | null = null;

    // ── State ─────────────────────────────────────────────────────────────────

    private _seedBusy = false;
    private _collectBusy = false;
    private _collectCells: StickyCell[] = [];
    private _totalBaseScale = new Vec3(1, 1, 1);
    private _activeClones: Node[] = [];
    private _activeOrbs: Node[] = [];

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.MATSURI_SEED_START, this._onSeedStart, this);
        bus.on(GameEvents.MATSURI_COLLECT_START, this._onCollectStart, this);
        bus.on(GameEvents.CARNIVAL_MATSURI_START, this._onMatsuriStart, this);
        bus.on(GameEvents.CARNIVAL_MATSURI_END, this._onMatsuriEnd, this);
        if (this.seedOrbTemplate) this.seedOrbTemplate.active = false;
    }

    onDestroy(): void {
        this._cleanupAll();
        EventBus.instance.offTarget(this);
    }

    /** StickyOverlayLoader gọi 1 lần sau load overlay. */
    bindStickyOverlay(overlay: StickyOverlayController | null): void {
        this.stickyOverlay = overlay;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    private _onMatsuriStart(): void {
        this._seedBusy = false;
        this._collectBusy = false;
        this._collectCells = [];
        this.unscheduleAllCallbacks();
        this._cleanupAll();
        this._resolveRefs();
        if (this.collectTotalSpriteNumber?.node) {
            this._totalBaseScale = this.collectTotalSpriteNumber.node.scale.clone();
        }
    }

    private _onMatsuriEnd(): void {
        this._seedBusy = false;
        this._collectBusy = false;
        this._collectCells = [];
        this.stickyOverlay?.setMatsuriDeferGoldLandBounce(false);
        this.unscheduleAllCallbacks();
        this._cleanupAll();
    }

    private _resolveRefs(): void {
        if (!this.stickyOverlay) {
            this.stickyOverlay =
                this.node.scene?.getComponentInChildren(StickyOverlayController) ?? null;
        }
        if (!this.topUpAbsorbEffect) {
            this.topUpAbsorbEffect =
                this.node.scene?.getComponentInChildren(TopUpAbsorbEffect) ?? null;
        }
        if (!this.collectTargetNode?.isValid) {
            const fsUI = this.node.scene?.getComponentInChildren(FreeSpinGoldUI) ?? null;
            const target = fsUI?.getCollectTargetNode() ?? null;
            if (target?.isValid) {
                this.collectTargetNode = target;
                if (!this.collectTotalSpriteNumber && fsUI?.goldTotalSpriteNumber) {
                    this.collectTotalSpriteNumber = fsUI.goldTotalSpriteNumber;
                }
            }
        }
        if (!this.seedSourceNode?.isValid) {
            const fs = this._findSceneNode('FreeSpinUI');
            if (fs) this.seedSourceNode = fs;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  SEED — vào feature
    // ═══════════════════════════════════════════════════════════════════════════

    private _onSeedStart(payload: { cells?: StickyCell[] }): void {
        if (this._seedBusy) {
            Log.w('[MatsuriEffect] seed busy — ignore');
            return;
        }
        this._resolveRefs();

        const cells = this._sortLeftRightTopBottom(payload?.cells ?? []);

        Log.e(`[MatsuriEffect:SEED] cells=${cells.length} src=${this.seedSourceNode?.name ?? 'NONE'}`);

        if (cells.length === 0) {
            EventBus.instance.emit(GameEvents.MATSURI_SEED_DONE);
            return;
        }

        this._seedBusy = true;
        this._clearOrbs();
        void this._runSeedSequence(cells);
    }

    /**
     * 1) Bắn orb tới khi TẤT CẢ vàng có trên reel
     * 2) Highlight nhún song song lệch pha
     * 3) SEED_DONE → spin
     */
    private async _runSeedSequence(cells: StickyCell[]): Promise<void> {
        this.stickyOverlay?.setMatsuriDeferGoldLandBounce(true);
        try {
            if (!this.seedSourceNode?.isValid && !this.seedOrbTemplate?.isValid) {
                await this._seedPlaceStaggered(cells);
            } else {
                this.stickyOverlay?.alignPositionsFromTopUpManager();
                const jobs: Promise<void>[] = [];
                for (let i = 0; i < cells.length; i++) {
                    const delay = i * SEED_LAUNCH_INTERVAL; // hardcode 0.1s
                    const cell = cells[i];
                    jobs.push(this._wait(delay).then(() => this._seedLaunchOne(cell)));
                }
                await Promise.all(jobs);
            }
            // Tất cả vàng đã sẵn trên reel → nhún song song lệch pha (L→R, trên→dưới)
            await this._phaseHighlightStaggered(cells);
        } catch (err) {
            Log.e('[MatsuriEffect:SEED] error', err);
        }
        this.stickyOverlay?.setMatsuriDeferGoldLandBounce(false);
        this._seedBusy = false;
        this._clearOrbs();
        EventBus.instance.emit(GameEvents.MATSURI_SEED_DONE);
    }

    private async _seedPlaceStaggered(cells: StickyCell[]): Promise<void> {
        const jobs: Promise<void>[] = [];
        for (let i = 0; i < cells.length; i++) {
            const delay = i * SEED_LAUNCH_INTERVAL;
            const cell = cells[i];
            jobs.push(
                this._wait(delay).then(() => {
                    this._seedPlaceCell(cell);
                    SoundManager.instance?.playSfxByName('sxBonusStickyGoldLand');
                }),
            );
        }
        await Promise.all(jobs);
    }

    private async _seedLaunchOne(cell: StickyCell): Promise<void> {
        const dstNode = this.stickyOverlay?.getCoinSlot(cell.reel, cell.row) ?? null;
        const srcWorld = this.seedSourceNode?.worldPosition.clone()
            ?? this.seedOrbTemplate?.worldPosition.clone()
            ?? new Vec3();

        if (!dstNode) {
            this._seedPlaceCell(cell);
            return;
        }

        const dstWorld = dstNode.worldPosition.clone();
        const orb = this._createSeedOrb();
        if (!orb) {
            this._seedPlaceCell(cell);
            return;
        }

        orb.setParent(this.node);
        orb.setWorldPosition(srcWorld);
        const endScale = orb.scale.clone();
        const startS = Math.max(0.05, SEED_ORB_START_SCALE);
        orb.setScale(endScale.x * startS, endScale.y * startS, endScale.z);
        orb.active = true;
        this._activeOrbs.push(orb);

        let op = orb.getComponent(UIOpacity);
        if (!op) op = orb.addComponent(UIOpacity);
        op.opacity = 255;

        SoundManager.instance?.playSfxByName('sxPotHit');
        SoundManager.instance?.playBonusTrail();

        const hop = new Vec3(srcWorld.x, srcWorld.y + SEED_ORB_HOP_Y, srcWorld.z);
        const hopDur = Math.max(0.02, SEED_ORB_HOP_DURATION);
        const flyDur = Math.max(0.05, SEED_ORB_FLY_DURATION);

        await new Promise<void>(resolve => {
            tween(orb)
                .to(hopDur, { worldPosition: hop, scale: endScale }, { easing: 'sineOut' })
                .to(flyDur, { worldPosition: dstWorld }, { easing: 'quadIn' })
                .call(() => {
                    this._seedPlaceCell(cell);
                    SoundManager.instance?.playSfxByName('sxBonusStickyGoldLand');
                    this._releaseOrb(orb);
                    resolve();
                })
                .start();
        });
    }

    private _seedPlaceCell(cell: StickyCell): void {
        const data = GameData.instance;
        data.stickyCells.set(`${cell.reel}-${cell.row}`, { ...cell });
        EventBus.instance.emit(GameEvents.MATSURI_SEED_CELL, { ...cell });
        EventBus.instance.emit(GameEvents.TOPUP_TOTAL_UPDATED, {
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
        });
    }

    private _createSeedOrb(): Node | null {
        const tmpl = this.seedOrbTemplate?.isValid ? this.seedOrbTemplate : this.seedSourceNode;
        if (!tmpl?.isValid) return null;
        const orb = instantiate(tmpl);
        orb.name = 'MatsuriSeedOrb';
        orb.active = false;
        return orb;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  COLLECT — Green land → bay Gold về UI
    // ═══════════════════════════════════════════════════════════════════════════

    private _onCollectStart(payload: { goldCells?: StickyCell[] }): void {
        if (this._collectBusy) {
            Log.w('[MatsuriEffect] collect busy — ignore');
            return;
        }
        this._resolveRefs();
        this._cleanupClones();

        const cells = this._sortLeftRightTopBottom(
            (payload?.goldCells ?? [])
                .filter(c =>
                    (c.symbolId === MATSURI_GOLD_SYMBOL || c.symbolId === SymbolId.STICKY_YELLOW)
                    && (c.credit ?? 0) > 0,
                )
                .filter((c, i, arr) =>
                    arr.findIndex(t => t.reel === c.reel && t.row === c.row) === i,
                ),
        );

        Log.e(`[MatsuriEffect:COLLECT] golds=${cells.length} target=${this.collectTargetNode?.name ?? 'NONE'}`);

        if (cells.length === 0) {
            EventBus.instance.emit(GameEvents.MATSURI_COLLECT_DONE);
            return;
        }
        if (!this.collectTargetNode?.isValid) {
            for (const c of cells) {
                EventBus.instance.emit(GameEvents.MATSURI_COLLECT_CREDIT, { credit: c.credit ?? 0 });
            }
            EventBus.instance.emit(GameEvents.MATSURI_COLLECT_DONE);
            return;
        }

        this._collectBusy = true;
        this._collectCells = cells;
        void this._runCollectSequence();
    }

    /**
     * Collect: vàng đã sẵn trên reel → nhún song song lệch pha → bay tiền.
     */
    private async _runCollectSequence(): Promise<void> {
        try {
            await this._phaseHighlightStaggered(this._collectCells);
            if (DELAY_BEFORE_FLY > 0) await this._wait(DELAY_BEFORE_FLY);
            await this._phaseFlyAll();
        } catch (err) {
            Log.e('[MatsuriEffect:COLLECT] error', err);
        }
        this._collectBusy = false;
        this._cleanupClones();
        EventBus.instance.emit(GameEvents.MATSURI_COLLECT_DONE);
    }

    /**
     * Nhún song song: sticky i bắt đầu sau i * HIGHLIGHT_STAGGER (không chờ bounce xong).
     * Thứ tự bắt đầu: L→R, trên→dưới.
     */
    private async _phaseHighlightStaggered(cells: StickyCell[]): Promise<void> {
        if (cells.length === 0) return;
        const jobs: Promise<void>[] = [];
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            const delay = i * HIGHLIGHT_STAGGER;
            jobs.push(
                this._wait(delay).then(async () => {
                    const src = this.stickyOverlay?.getCoinSlot(cell.reel, cell.row) ?? null;
                    if (src?.active && isValid(src)) await this._bounceStickyLikeTopUp(src);
                    else await this._wait(HIGHLIGHT_BOUNCE_DURATION);
                }),
            );
        }
        await Promise.all(jobs);
    }

    /**
     * Nhún giống TopUp sticky handoff.
     * Curve gốc TopUp: grow 0.08 + hold 0.12 + shrink 0.32 (= 0.52).
     */
    private _bounceStickyLikeTopUp(node: Node): Promise<void> {
        return new Promise(resolve => {
            if (!isValid(node)) {
                resolve();
                return;
            }
            const total = HIGHLIGHT_BOUNCE_DURATION;
            const growDur = total * (0.08 / 0.52);
            const holdDur = total * (0.12 / 0.52);
            const shrinkDur = total * (0.32 / 0.52);
            const baseScale = 1;
            const startS = TOPUP_STICKY_SYMBOL_SCALE; // 0.85
            const peakS = baseScale * 1.12;

            const basePos = node.position.clone();
            const peakPos = new Vec3(basePos.x, basePos.y + HIGHLIGHT_JUMP_Y, basePos.z);

            Tween.stopAllByTarget(node);
            SoundManager.instance?.playSfxByName('sxBonusStickyGoldLand');

            node.setScale(startS, startS, 1);
            node.setPosition(basePos);
            tween(node)
                .to(growDur, {
                    scale: new Vec3(peakS, peakS, 1),
                    position: peakPos,
                }, { easing: 'sineOut' })
                .delay(holdDur)
                .to(shrinkDur, {
                    scale: new Vec3(baseScale, baseScale, 1),
                    position: basePos.clone(),
                }, { easing: 'sineIn' })
                .call(() => {
                    if (isValid(node)) {
                        node.setPosition(basePos);
                        node.setScale(baseScale, baseScale, 1);
                    }
                    resolve();
                })
                .start();
        });
    }

    private async _phaseFlyAll(): Promise<void> {
        const jobs: Promise<void>[] = [];
        for (let i = 0; i < this._collectCells.length; i++) {
            const cell = this._collectCells[i];
            const delay = i * FLY_STAGGER;
            jobs.push(this._wait(delay).then(() => this._flyCloneOne(cell)));
        }
        await Promise.all(jobs);
    }

    /** Trái → phải, trên → dưới (row 0 = top). */
    private _sortLeftRightTopBottom(cells: StickyCell[]): StickyCell[] {
        return [...cells].sort((a, b) =>
            a.reel !== b.reel ? a.reel - b.reel : a.row - b.row,
        );
    }

    private _flyCloneOne(cell: StickyCell): Promise<void> {
        return new Promise(resolve => {
            const credit = cell.credit ?? 0;
            let resolved = false;
            const finish = () => {
                if (resolved) return;
                resolved = true;
                EventBus.instance.emit(GameEvents.MATSURI_COLLECT_CREDIT, { credit });
                this._pulseTotal();
                resolve();
            };

            const srcNode = this.stickyOverlay?.getCoinSlot(cell.reel, cell.row) ?? null;
            const dst = this.collectTargetNode;
            if (!srcNode?.active || !dst?.isValid) {
                finish();
                return;
            }

            const layer = this._flyLayer();
            if (!layer) {
                finish();
                return;
            }
            const layerUT = layer.getComponent(UITransform)!;

            const clone = instantiate(srcNode);
            clone.name = `MatsuriGoldFly_${cell.reel}_${cell.row}`;
            clone.setParent(layer);
            clone.setSiblingIndex(layer.children.length - 1);
            clone.active = true;

            const start = layerUT.convertToNodeSpaceAR(srcNode.getWorldPosition());
            const end = layerUT.convertToNodeSpaceAR(dst.getWorldPosition());
            const startScale = srcNode.scale.clone();
            clone.setPosition(start.x, start.y, 0);
            clone.setScale(startScale);
            clone.setRotationFromEuler(0, 0, 0);

            let op = clone.getComponent(UIOpacity);
            if (!op) op = clone.addComponent(UIOpacity);
            op.opacity = 255;

            this._activeClones.push(clone);
            SoundManager.instance?.playSfxByName('sxBonusStickyGoldIncreaseHit');
            SoundManager.instance?.playBonusTrail();

            const flyDur = FLY_DURATION;
            const shrinkDur = FLY_SHRINK_DURATION;
            const endScale = FLY_END_SCALE;

            const failSafe = () => {
                this._destroyClone(clone);
                finish();
            };
            this.scheduleOnce(failSafe, flyDur + shrinkDur + 1.0);

            tween(clone)
                .to(flyDur, {
                    position: new Vec3(end.x, end.y, 0),
                    scale: new Vec3(startScale.x * 0.85, startScale.y * 0.85, startScale.z),
                }, { easing: 'sineIn' })
                .call(() => {
                    if (op && isValid(op)) {
                        tween(op).to(shrinkDur, { opacity: 0 }, { easing: 'sineIn' }).start();
                    }
                })
                .to(shrinkDur, {
                    scale: new Vec3(endScale, endScale, startScale.z),
                }, { easing: 'sineIn' })
                .call(() => {
                    this.unschedule(failSafe);
                    this._destroyClone(clone);
                    finish();
                })
                .start();
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private _flyLayer(): Node | null {
        const top = SymbolView.landBounceParent;
        if (top?.isValid && top.getComponent(UITransform)) return top;
        if (this.topUpAbsorbEffect?.node?.isValid
            && this.topUpAbsorbEffect.node.getComponent(UITransform)) {
            return this.topUpAbsorbEffect.node;
        }
        if (this.node.getComponent(UITransform)) return this.node;
        const overlay = this.stickyOverlay?.node;
        if (overlay?.parent?.getComponent(UITransform)) return overlay.parent;
        return overlay ?? null;
    }

    private _pulseTotal(): void {
        const sn = this.collectTotalSpriteNumber;
        if (!sn?.node?.isValid) return;
        const bs = this._totalBaseScale;
        Tween.stopAllByTarget(sn.node);
        tween(sn.node)
            .to(0.07, { scale: new Vec3(bs.x * 1.28, bs.y * 1.28, bs.z) })
            .to(0.1, { scale: new Vec3(bs.x, bs.y, bs.z) })
            .start();
    }

    private _destroyClone(clone: Node): void {
        const idx = this._activeClones.indexOf(clone);
        if (idx >= 0) this._activeClones.splice(idx, 1);
        if (!isValid(clone)) return;
        Tween.stopAllByTarget(clone);
        const op = clone.getComponent(UIOpacity);
        if (op) Tween.stopAllByTarget(op);
        clone.destroy();
    }

    private _releaseOrb(orb: Node): void {
        const idx = this._activeOrbs.indexOf(orb);
        if (idx >= 0) this._activeOrbs.splice(idx, 1);
        if (!isValid(orb)) return;
        Tween.stopAllByTarget(orb);
        const op = orb.getComponent(UIOpacity);
        if (op) Tween.stopAllByTarget(op);
        orb.destroy();
    }

    private _clearOrbs(): void {
        for (const o of [...this._activeOrbs]) this._releaseOrb(o);
        this._activeOrbs.length = 0;
    }

    private _cleanupClones(): void {
        for (const n of this._activeClones) {
            if (isValid(n)) {
                Tween.stopAllByTarget(n);
                n.destroy();
            }
        }
        this._activeClones.length = 0;
    }

    private _cleanupAll(): void {
        this._cleanupClones();
        this._clearOrbs();
    }

    private _findSceneNode(name: string): Node | null {
        const scene = this.node.scene;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length) {
            const n = stack.pop()!;
            if (n.name === name) return n;
            for (const c of n.children) stack.push(c);
        }
        return null;
    }

    private _wait(sec: number): Promise<void> {
        return new Promise(resolve => {
            if (sec <= 0) resolve();
            else this.scheduleOnce(resolve, sec);
        });
    }
}
