/**
 * FreeSpinGoldCoinEffect — Hiệu ứng bay từ đồng xu vàng đến UI Tổng tiền vàng.
 *
 * Flow mỗi đồng xu vàng:
 *   1. Bounce coin nhẹ (zoom lên rồi về).
 *   2. Spawn fly effect từ pool (giống TopUpAbsorbEffect.flyEffectTemplate).
 *   3. Bay từ vị trí coin → goldTotalNode.
 *   4. Đến đích: squish scale Y → 0, ẩn, trả về pool.
 *   5. Emit FREE_SPIN_GOLD_ABSORB_CREDIT → FreeSpinGoldUI cộng dồn.
 *   6. Pulse goldTotalSpriteNumber.
 *
 * Sau khi TẤT CẢ coin đã bay xong → bounce highlight đồng thời → emit FREE_SPIN_GOLD_FLY_DONE.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Gắn component này lên Node "FreeSpinGoldCoinFlyLayer" con của Canvas (top hierarchy).
 *      Gắn UITransform cùng kích thước Canvas.
 *   2. flyEffectTemplate    → Node mẫu hiệu ứng bay (giống template dùng trong TopUpAbsorbEffect)
 *   3. goldTotalNode        → Node UI "tổng tiền vàng"
 *   4. goldTotalSpriteNumber → SpriteNumber hiển thị tổng vàng
 *   5. slotMachine          → SlotMachineController
 *
 * ── ROW MAPPING ──
 *   row 0 = visual Bot = symbolNodes[3]
 *   row 1 = visual Mid = symbolNodes[2]
 *   row 2 = visual Top = symbolNodes[1]   (nodeIndex = 3 - row)
 */

import {
    _decorator, Component, Node, tween, Vec3, Tween,
    UITransform, isValid, instantiate,
} from 'cc';
import { EventBus }              from '../core/EventBus';
import { GameEvents }            from '../core/GameEvents';
import { StickyCell, SymbolId }  from '../data/SlotTypes';
import { Log }                   from '../core/Logger';
import { SlotMachineController } from './SlotMachineController';
import { SymbolView }            from './SymbolView';
import { SpriteNumber }          from '../core/SpriteNumber';
import { TopUpAbsorbEffect }     from './TopUpAbsorbEffect';
import { AutoSpinManager }       from '../manager/AutoSpinManager';
import { SoundManager }          from '../manager/SoundManager';

const { ccclass, property } = _decorator;

/** Payload của FREE_SPIN_GOLD_COIN_LAND */
export interface FreeSpinGoldCoinLandPayload {
    cells: StickyCell[];
}

@ccclass('FreeSpinGoldCoinEffect')
export class FreeSpinGoldCoinEffect extends Component {

    // ── INSPECTOR ──────────────────────────────────────────────────────────────

    @property({
        type: SlotMachineController,
        tooltip: 'SlotMachineController để lấy reels → symbolNodes.',
    })
    slotMachine: SlotMachineController | null = null;

    @property({
        type: Node,
        tooltip: 'Node đích: UI Tổng tiền vàng (goldTotalSpriteNumber.node hoặc parent của nó).',
    })
    goldTotalNode: Node | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'SpriteNumber hiển thị tổng tiền vàng — để pulse animation khi nhận thêm tiền.',
    })
    goldTotalSpriteNumber: SpriteNumber | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'SpriteNumber hiển thị win của mỗi lượt quay (each win) — pulse khi cập nhật.',
    })
    eachWinSpriteNumber: SpriteNumber | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'SpriteNumber hiển thị số lượt quay còn lại — pulse khi count giảm.',
    })
    spinsRemainingSpriteNumber: SpriteNumber | null = null;

    @property({
        type: TopUpAbsorbEffect,
        tooltip: 'TopUpAbsorbEffect — chia sẻ flyPool (borrowFlyEffect / returnFlyEffect).',
    })
    topUpAbsorbEffect: TopUpAbsorbEffect | null = null;

    @property({ tooltip: 'Delay (giây) giữa mỗi đồng xu bắt đầu bay.' })
    flyStagger: number = 0.15;

    @property({ tooltip: 'Thời gian tween bay từ đồng xu đến UI (giây).' })
    flyDuration: number = 0.6;

    // ── STATE ──────────────────────────────────────────────────────────────────

    private _isProcessingQueue: boolean = false;
    private _flyQueue: StickyCell[] = [];
    private _goldBaseScale: Vec3  = new Vec3(1, 1, 1);
    private _spinCountBaseScale: Vec3 = new Vec3(1, 1, 1);
    /** Cells của đợt fly hiện tại — dùng để zoom bounce highlight sau khi fly xong */
    private _lastGoldCells: StickyCell[] = [];

    /** Hệ số tốc độ dựa trên speed mode (NORMAL=1, QUICK=0.5, TURBO=0.33) */
    private get _tm(): number {
        return AutoSpinManager.instance.getTimingMultiplier();
    }

    // ── LIFECYCLE ──────────────────────────────────────────────────────────────

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.FREE_SPIN_GOLD_COIN_LAND,      this._onCoinLand,       this);
        bus.on(GameEvents.FREE_SPIN_GOLD_COUNT_UPDATED,  this._onCountUpdated,   this);
        bus.on(GameEvents.FREE_SPIN_GOLD_START,          this._onGoldStart,      this);
        bus.on(GameEvents.FREE_SPIN_GOLD_END,            this._onGoldEnd,        this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ── EVENT HANDLERS ────────────────────────────────────────────────────────

    private _onGoldStart(_payload: { spinsRemaining: number; baseCredit: number }): void {
        // Reset trạng thái bay khi bắt đầu mode mới
        this._isProcessingQueue = false;
        this._flyQueue.length = 0;
        this.unscheduleAllCallbacks();
        // Snapshot base scales sau khi node đã active
        if (this.goldTotalSpriteNumber)      this._goldBaseScale      = this.goldTotalSpriteNumber.node.scale.clone();
        if (this.spinsRemainingSpriteNumber) this._spinCountBaseScale = this.spinsRemainingSpriteNumber.node.scale.clone();
    }

    private _onGoldEnd(_totalWin: number): void {
        this._isProcessingQueue = false;
        this._flyQueue.length = 0;
        this.unscheduleAllCallbacks();
    }

    private _onCountUpdated(_count: number): void {
        const sn = this.spinsRemainingSpriteNumber;
        if (!sn) return;
        Tween.stopAllByTarget(sn.node);
        const bs = sn.node.scale.clone();
        tween(sn.node)
            .to(0.06 * this._tm, { scale: new Vec3(bs.x * 1.18, bs.y * 1.18, bs.z) })
            .to(0.10 * this._tm, { scale: bs })
            .start();
    }

    private _onCoinLand(payload: FreeSpinGoldCoinLandPayload): void {
        const rawCount = (payload.cells ?? []).length;
        const cells = (payload.cells ?? [])
            .filter(c => c.symbolId === SymbolId.STICKY_YELLOW && (c.credit ?? 0) > 0)
            // ★ Dedupe: loại bỏ duplicate cùng vị trí (phòng server/emit 2 lần)
            .filter((c, idx, arr) => arr.findIndex(t => t.reel === c.reel && t.row === c.row) === idx)
            .sort((a, b) => {
                if (a.reel !== b.reel) return a.reel - b.reel;
                return b.row - a.row;  // visual top → bottom
            });

        Log.e(`[GOLD-FLY][Effect._onCoinLand] raw=${rawCount} deduped=${cells.length} processing=${this._isProcessingQueue} queueSize=${this._flyQueue.length}`);

        if (cells.length === 0) {
            if (!this._isProcessingQueue) {
                Log.e(`[GOLD-FLY][Effect._onCoinLand] emit FLY_DONE immediately (no cells)`);
                EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_FLY_DONE);
            }
            return;
        }

        this._lastGoldCells = cells;
        this._flyQueue.push(...cells);
        Log.e(`[GOLD-FLY][Effect._onCoinLand] pushed ${cells.length} cells → queue=${this._flyQueue.length}`);

        if (!this._isProcessingQueue) {
            this._isProcessingQueue = true;
            // Delay 0.5s để đảm bảo tất cả reel dừng hẳn và symbol land bounce xong trước khi bay
            this.scheduleOnce(() => this._processNextFly(), 0.5 * this._tm);
        }
    }

    /** Lấy cell tiếp theo từ queue và bay. Nếu queue rỗng → kết thúc. */
    private _processNextFly(): void {
        Log.e(`[GOLD-FLY][Effect._processNextFly] queue=${this._flyQueue.length}`);
        if (this._flyQueue.length === 0) {
            this._isProcessingQueue = false;
            Log.e(`[GOLD-FLY][Effect._processNextFly] queue empty → _finish()`);
            this._finish();
            return;
        }
        const cell = this._flyQueue.shift()!;
        Log.e(`[GOLD-FLY][Effect._processNextFly] fly cell ${cell.reel}-${cell.row}=$${cell.credit} queueRemain=${this._flyQueue.length}`);
        this._flyOneCredit(cell);
    }

    // ── FLY ONE CREDIT ────────────────────────────────────────────────────────

    private _flyOneCredit(cell: StickyCell): void {
        const credit = cell.credit ?? 0;
        let resolved = false;

        const onFail = () => {
            if (resolved) { Log.e(`[GOLD-FLY][Effect._flyOneCredit] onFail SKIP — already resolved`); return; }
            resolved = true;
            Log.e(`[GOLD-FLY][Effect._flyOneCredit] onFail emit ABSORB_CREDIT credit=${credit}`);
            EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_ABSORB_CREDIT, { credit });
            this._processNextFly();
        };

        if (!this.slotMachine || !this.goldTotalNode) { onFail(); return; }

        const target = this._getFlyTarget(cell);
        if (!target) { onFail(); return; }

        const { symbolNode } = target;

        // 1. Play sound ngay khi coin bắn fly effect
        SoundManager.instance?.playSfxByName('sxBonusStickyGoldIncreaseHit');

        // 2. Nhún coin khi bắn fly effect — clone sang top node để vẽ chồng lên tất cả
        const symScale = symbolNode.scale.clone();
        const topNode = SymbolView.landBounceParent;
        let clone: Node | null = null;
        if (topNode && topNode.isValid) {
            clone = instantiate(symbolNode);
            clone.setParent(topNode, true);
            clone.setWorldPosition(symbolNode.getWorldPosition());
            clone.setSiblingIndex(topNode.children.length - 1);
            clone.active = true;
            tween(clone)
                .to(0.08 * this._tm, { scale: new Vec3(symScale.x * 1.12, symScale.y * 1.12, symScale.z) })
                .delay(0.5 * this._tm)
                .to(0.5 * this._tm, { scale: symScale }, { easing: 'sineOut' })
                .call(() => {
                    if (clone && isValid(clone)) {
                        Tween.stopAllByTarget(clone);
                        clone.destroy();
                    }
                })
                .start();
        }

        // 2. Borrow fly effect từ pool của TopUpAbsorbEffect
        const fx = this.topUpAbsorbEffect?.borrowFlyEffect() ?? null;
        if (!fx) { Log.w('[GoldFlyFX] no fx from pool'); onFail(); return; }

        const layerUT = this.node.getComponent(UITransform);
        if (!layerUT) { this.topUpAbsorbEffect?.returnFlyEffect(fx); onFail(); return; }

        // 3. Đặt effect tại vị trí coin
        const srcWorld = symbolNode.getWorldPosition();
        const srcLocal = layerUT.convertToNodeSpaceAR(srcWorld);
        fx.setParent(this.node);
        fx.setPosition(srcLocal.x, srcLocal.y, 0);
        fx.setScale(1, 1, 1);
        fx.active = true;
        SoundManager.instance?.playBonusTrail();

        const dstWorld = this.goldTotalNode.getWorldPosition();
        const dstLocal = layerUT.convertToNodeSpaceAR(dstWorld);

        // Snapshot scales của children trước khi animate (không phải scale node fx chính)
        const fxChildren = fx.children;
        const childOrigScales: Vec3[] = fxChildren.map(c => c.scale.clone());
        const restoreChildScales = () => {
            for (let i = 0; i < fxChildren.length; i++) {
                if (isValid(fxChildren[i])) {
                    Tween.stopAllByTarget(fxChildren[i]);
                    fxChildren[i].setScale(childOrigScales[i]);
                }
            }
        };

        const doFinish = () => {
            if (resolved) { Log.e(`[GOLD-FLY][Effect._flyOneCredit] doFinish SKIP — already resolved`); return; }
            resolved = true;
            // Emit credit absorbed → FreeSpinGoldUI cộng dồn
            Log.e(`[GOLD-FLY][Effect._flyOneCredit] doFinish emit ABSORB_CREDIT credit=${credit}`);
            EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_ABSORB_CREDIT, { credit });
            // Pulse goldTotalSpriteNumber
            if (this.goldTotalSpriteNumber) {
                const sn = this.goldTotalSpriteNumber.node;
                const bs = this._goldBaseScale;
                Tween.stopAllByTarget(sn);
                tween(sn)
                    .to(0.07 * this._tm, { scale: new Vec3(bs.x * 1.28, bs.y * 1.28, bs.z) })
                    .to(0.10 * this._tm, { scale: new Vec3(bs.x, bs.y, bs.z) })
                    .start();
            }
            this._processNextFly();
        };

        // Failsafe: restore children scales rồi trả pool (dùng named callback để unschedule được)
        const failSafeCb = () => {
            restoreChildScales();
            this.topUpAbsorbEffect?.returnFlyEffect(fx);
            doFinish();
        };
        this.scheduleOnce(failSafeCb, this.flyDuration * this._tm + 1.5);

        // 4. Bay tới đích → squish Y của children về 0 (X giữ nguyên) → restore → trả pool
        tween(fx)
            .to(this.flyDuration * this._tm, { position: new Vec3(dstLocal.x, dstLocal.y, 0) }, { easing: 'sineIn' })
            .call(() => {
                this.unschedule(failSafeCb);
                const childCount = fxChildren.length;
                if (childCount === 0) {
                    this.topUpAbsorbEffect?.returnFlyEffect(fx);
                    doFinish();
                    return;
                }
                let done = 0;
                const onChildSquishDone = () => {
                    done++;
                    if (done >= childCount) {
                        restoreChildScales();
                        this.topUpAbsorbEffect?.returnFlyEffect(fx);
                        doFinish();
                    }
                };
                for (let i = 0; i < childCount; i++) {
                    const child = fxChildren[i];
                    const os = childOrigScales[i];
                    tween(child)
                        .to(0.08 * this._tm, { scale: new Vec3(os.x, os.y * 0.15, os.z) }, { easing: 'sineIn' })
                        .to(0.07 * this._tm, { scale: new Vec3(os.x, 0, os.z) })
                        .call(onChildSquishDone)
                        .start();
                }
            })
            .start();
    }

    // ── HELPERS ───────────────────────────────────────────────────────────────

    private _finish(): void {
        this._isProcessingQueue = false;
        this._lastGoldCells = [];
        // Emit FLY_DONE ngay — không bounce thêm (coin chỉ nhún lúc fly effect bay ra)
        EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_FLY_DONE);
    }

    private _worldToLocal(worldPos: Vec3): Vec3 {
        const tf = this.node.getComponent(UITransform);
        if (tf) return tf.convertToNodeSpaceAR(worldPos);
        return worldPos.clone();
    }

    private _getFlyTarget(cell: StickyCell): { symbolNode: Node; view: SymbolView } | null {
        if (!this.slotMachine) return null;
        const reel = this.slotMachine.reels[cell.reel];
        if (!reel) return null;

        const nodeIndex  = 3 - cell.row;
        const symbolNode = reel.symbolNodes[nodeIndex];
        if (!symbolNode) return null;

        const view = symbolNode.getComponent(SymbolView);
        if (!view) return null;
        return { symbolNode, view };
    }
}
