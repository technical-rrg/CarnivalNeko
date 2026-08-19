/**
 * StickyOverlayController — Overlay hiển thị đồng xu sticky cố định trong chế độ Top Up.
 *
 * ── MỤC ĐÍCH ──
 *   Khi reel đang SPINNING, tất cả symbolNodes trong ReelController đều scroll xuống.
 *   Các đồng xu sticky (Red/Yellow/Green) thuộc layer này sẽ ở LỚP TRÊN fillback,
 *   KHÔNG liên quan đến scroll — luôn cố định ở đúng vị trí grid 5×3.
 *
 * ── LAYER ORDER TRONG SCENE ──
 *   [0] ReelContainer  (symbolNodes — cuộn khi spin)
 *   [1] FillbackFrame  (khung trang trí)
 *   [2] StickyOverlay  ← component này — trên fillback, tĩnh tuyệt đối
 *
 * ── SETUP ──
 *   Prefab StickyOverlay (MainBundle) — KHÔNG nhúng vào Base.
 *   StickyOverlayLoader lazy-load khi vào TopUp và gọi bindSlotMachine() bằng code.
 *   Trong Prefab: coinSlots / coinFrames gán sẵn; slotMachine để trống (wire runtime).
 *
 * ── ROW CONVENTION ──
 *   Theo GameData / stickyCells key `${reel}-${row}`:
 *     row 0 = visual Bottom  (symbolNodes[3])
 *     row 1 = visual Middle  (symbolNodes[2])
 *     row 2 = visual Top     (symbolNodes[1])
 */

import {
    _decorator, Component, Node, Sprite, SpriteFrame, UIOpacity, UITransform,
    tween, Vec3, Tween, instantiate, Layout,
} from 'cc';
import { EventBus }     from '../core/EventBus';
import { GameEvents }   from '../core/GameEvents';
import { GameData }     from '../data/GameData';
import { SymbolId }     from '../data/SlotTypes';
import { SpriteNumber } from '../core/SpriteNumber';
import { Log }          from '../core/Logger';
import { SoundManager } from '../manager/SoundManager';
import { AutoSpinManager } from '../manager/AutoSpinManager';
import { SlotMachineController } from './SlotMachineController';
import { TopUpManager } from './TopUpManager';
import {
    GRID_MINI_COIN_SIZE,
    TOPUP_STICKY_SYMBOL_SCALE,
    gridMiniGreenReelVisualScale,
} from './TopUpReelController';
import { TopUpTransitionPopup, TransitionMode } from './TopUpTransitionPopup';
import {
    MATSURI_COL_COUNT,
    MATSURI_CELL_SIZE,
    MATSURI_GOLD_SYMBOL,
    MATSURI_MIN_ROWS,
    MATSURI_SPIN_COUNT,
    clampMatsuriRows,
    matsuriCellSize,
    matsuriGridCellLocal,
    lookupCnStickyCredit,
} from '../data/MatsuriGridUtil';

const { ccclass, property } = _decorator;

/** Base scale khi sticky vàng/xanh nằm trên overlay (đồng đỏ = 1). */
const TOPUP_YELLOW_COIN_SCALE = 1;
const TOPUP_GREEN_COIN_SCALE = 1;

@ccclass('StickyOverlayController')
export class StickyOverlayController extends Component {

    // ── INSPECTOR ──────────────────────────────────────────────────────────────

    @property({
        type: [Node],
        tooltip:
            'CoinSlot nodes: index = reel * N + row (N = activeRowCount, Prefab mặc định 3).\n' +
            '(row: 0=Bottom … N-1=Top)\n' +
            'Mỗi node cần Sprite + optional child "CreditLabel" (SpriteNumber).',
    })
    coinSlots: Node[] = [];

    @property({
        type: [SpriteFrame],
        tooltip: 'Coin sprite frames:\n[0]=Gold (ps_45)  [1]=Green (ps_44)\nThiếu thì lấy từ SlotMachine.symbolFrames.',
    })
    coinFrames: SpriteFrame[] = [];

    @property({ tooltip: 'Thời gian fade-in khi coin mới xuất hiện (giây). 0 = không fade.' })
    coinFadeInDuration: number = 0.2;

    @property({ tooltip: 'Fade-in khi đồng vàng/xanh mới land trên StickyOverlay (giây).' })
    goldCoinFadeInDuration: number = 0.35;

    @property({ tooltip: 'Scale bắt đầu khi đồng vàng/xanh pop-in (nhỏ → to).' })
    goldCoinPopStartScale: number = 0.35;

    @property({ tooltip: 'Overshoot scale khi đồng vàng/xanh nhún xuất hiện (nhân với base, tối đa = base).' })
    goldCoinBounceOvershoot: number = 1;

    @property({ tooltip: 'Thời gian scale UP khi đồng vàng/xanh xuất hiện (giây).' })
    goldCoinBounceUpDuration: number = 0.28;

    @property({ tooltip: 'Thời gian scale DOWN settle khi đồng vàng/xanh xuất hiện (giây).' })
    goldCoinBounceDownDuration: number = 0.36;

    @property({ tooltip: 'Fade-in toàn overlay khi vừa vào TopUp (giây).' })
    topUpEnterFadeDuration: number = 0.4;

    @property({ tooltip: 'Fade Cat ↔ Top trên FramFront khi seed / vào feature (giây).' })
    matsuriFrameHudFadeDuration: number = 0.35;

    @property({ tooltip: 'Fade-in coin lần đầu vào TopUp (giây) — thường dài hơn coinFadeInDuration.' })
    topUpEnterCoinFadeDuration: number = 0.35;

    @property({ tooltip: 'Bounce scale khi coin mới xuất hiện (1.0 = no bounce, 1.12 = 12% bigger).' })
    coinBounceScale: number = 1.12;

    @property({ tooltip: 'Thời gian scale UP khi coin vào TopUp lần đầu (giây).' })
    coinEnterBounceUpDuration: number = 0.22;

    @property({ tooltip: 'Thời gian scale DOWN khi coin vào TopUp lần đầu (giây).' })
    coinEnterBounceDownDuration: number = 0.32;

    @property({ tooltip: 'Delay giữa từng coin khi nhún lần đầu vào TopUp (giây).' })
    coinEnterBounceStagger: number = 0.07;

    @property({
        type: SlotMachineController,
        tooltip: 'Thường để trống trên Prefab — StickyOverlayLoader.bindSlotMachine() wire lúc runtime.',
    })
    slotMachine: SlotMachineController | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'Tổng tiền gom Matsuri — gán SpriteNumber trên FramFront/Top/Frame2 (CollectTotal).',
    })
    collectTotalSpriteNumber: SpriteNumber | null = null;

    @property({
        type: [Node],
        tooltip: '3 ô remain (trái → phải). Mỗi ô: sprite Empty + child Fill. Gán từ Editor.',
    })
    spinRemainSlots: Node[] = [];

    @property({ type: SpriteFrame, tooltip: 'FramFront — grid 5×3 (Reelframe_Freespin_5x3).' })
    featureFrame5x3: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'FramFront — grid 5×4 (Reelframe_Freespin_5x4).' })
    featureFrame5x4: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'FramFront — grid 5×5 (Reelframe_Freespin_5x5).' })
    featureFrame5x5: SpriteFrame | null = null;

    @property({
        type: Node,
        tooltip: 'Cat — hiện khi đang ném quả cầu seed (MATSURI_SEED_START → DONE). Gán từ Editor.',
    })
    seedThrowCatNode: Node | null = null;

    @property({
        type: Node,
        tooltip: 'FramFront/Top — HUD remain + collect; ẩn lúc seed, hiện khi vào feature. Gán từ Editor.',
    })
    featureFrameTopNode: Node | null = null;

    /**
     * Wire SlotMachineController từ code (lazy-load Prefab không serialize cross-prefab refs).
     * Gọi trước khi active / trước TOPUP_START.
     */
    bindSlotMachine(smc: SlotMachineController | null): void {
        this.slotMachine = smc;
        this._syncCoinFramesFromSlotMachine();
    }

    // ── STATE ──────────────────────────────────────────────────────────────────

    /** Track which slots were active before update — to detect NEW coins */
    private _previouslyActiveSlots: Set<string> = new Set();

    /** Track last applied credit per slotNode — to avoid redundant setData() calls causing flicker */
    private _slotCreditMap: Map<Node, number> = new Map();

    private _coinSlotOriginalParents: Map<Node, { parent: Node | null; siblingIndex: number; spinCounter: number }> = new Map();

    private _topUpSpinCounter: number = 0;
    /** Mốc kết thúc land-bounce vàng/xanh gần nhất; absorb phải chờ qua mốc này. */
    private _goldLandBounceEndMs: number = 0;
    /** Matsuri: đang flip Green→Gold — _refreshAll không đụng slot này. */
    private _matsuriFlippingKeys: Set<string> = new Set();
    /** Matsuri: Green đã land, chờ collect Gold xong mới flip. */
    private _matsuriPendingFlipKeys: Set<string> = new Set();
    private _matsuriFlipDonePending = 0;
    /**
     * Matsuri seed: hiện Gold tĩnh khi orb land (không nhún từng cái).
     * MatsuriEffect sẽ nhún lần lượt sau khi bắn xong hết.
     */
    private _matsuriDeferGoldLandBounce = false;
    /** Cache TopUpManager — tránh getComponentInChildren mỗi lần align/reveal. */
    private _cachedTopUpMgr: TopUpManager | null = null;

    /** Bật khi đang seed — Gold pop-in nhẹ, bỏ full refresh trên TOPUP_TOTAL. */
    setMatsuriDeferGoldLandBounce(defer: boolean): void {
        this._matsuriDeferGoldLandBounce = defer;
    }

    /**
     * Seed: hiện 1 sticky vàng (pop mượt 0→base) — không _refreshAll toàn grid.
     * Gọi từ MatsuriEffect mỗi lần orb land.
     */
    revealMatsuriSeedCoin(cell: { reel: number; row: number; symbolId: number; credit?: number }): void {
        const key = `${cell.reel}-${cell.row}`;
        const idx = this._cellIdx(cell.reel, cell.row);
        const slotNode = this.coinSlots[idx];
        if (!slotNode?.isValid) return;

        const credit = Math.max(0, cell.credit ?? 0);
        const mgr = this._getTopUpManager();
        this._applyCoin(slotNode, cell.symbolId, credit, /* quiet */ true);
        slotNode.active = true;
        this._reparentToStickyOverlay(slotNode);
        this._alignSlotToTopUpCell(idx, mgr);

        const op = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        op.opacity = 255;

        this._playMatsuriGoldSeedPopIn(slotNode, cell.symbolId);
        this._previouslyActiveSlots.add(key);
    }

    /**
     * Matsuri: hiện Sticky GREEN ngay khi land (trước collect/flip).
     * Không phụ thuộc full refresh — tránh mất xanh đến lúc flip mới thấy.
     */
    revealMatsuriGreenCoin(cell: { reel: number; row: number; credit?: number }): void {
        const key = `${cell.reel}-${cell.row}`;
        const idx = this._cellIdx(cell.reel, cell.row);
        const slotNode = this.coinSlots[idx];
        if (!slotNode?.isValid) return;

        const apiCredit = this._lookupMatsuriApiCredit(cell.reel, cell.row) || Math.max(0, cell.credit ?? 0);
        this._applyCoin(slotNode, SymbolId.STICKY_GREEN, apiCredit);
        slotNode.active = true;
        this._reparentToStickyOverlay(slotNode);
        this._alignSlotToTopUpCell(idx);
        this._setMatsuriCreditLabelVisible(slotNode, false, apiCredit);

        const op = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        op.opacity = 255;

        this._matsuriPendingFlipKeys.add(key);
        this._previouslyActiveSlots.add(key);
        this._playMatsuriGreenLandOnly(slotNode, idx);
        this._logGreenCredit('REVEAL', cell.reel, cell.row, apiCredit, slotNode);
    }

    /** Thời lượng pop seed vàng (giây) — MatsuriEffect chờ trước highlight; theo speed mode. */
    get matsuriSeedPopDuration(): number {
        const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
        return Math.max(0.08, 0.22 * m);
    }

    /**
     * Snap mọi sticky đang hiện về Mid REST của TopUpReel.
     * Stop tween scale/pos — tránh lệch Y sau highlight hoặc khi reel vừa start spin.
     */
    snapActiveCoinsToReelRest(): void {
        const topUpMgr = this._getTopUpManager();
        if (!topUpMgr) return;

        for (const key of this._previouslyActiveSlots) {
            const [reelStr, rowStr] = key.split('-');
            const reel = parseInt(reelStr, 10);
            const row = parseInt(rowStr, 10);
            if (Number.isNaN(reel) || Number.isNaN(row)) continue;
            const idx = this._cellIdx(reel, row);
            const slotNode = this.coinSlots[idx];
            if (!slotNode?.isValid || !slotNode.active) continue;

            Tween.stopAllByTarget(slotNode);
            this._alignSlotToTopUpCell(idx, topUpMgr);

            const cell = GameData.instance.stickyCells.get(key);
            const base = this._getBaseScale(cell?.symbolId ?? SymbolId.STICKY_YELLOW);
            slotNode.setScale(base, base, 1);
            slotNode.setRotationFromEuler(0, 0, 0);
        }
    }

    /** true trong _refreshAll lần đầu vào TopUp — nhún chậm + stagger. */
    private _isEnteringTopUp: boolean = false;
    /**
     * true khi đang có TransitionPopup TopUp:
     * setup coin dưới overlay lúc TOPUP_START (sau READY), chỉ nhún sau TOPUP_TRANSITION_DONE.
     */
    private _deferEnterAnim: boolean = false;
    private _pendingEnterAnim: boolean = false;
    private _enterAnimPlayed: boolean = false;

    /** Số hàng active (3|4|5) — đồng bộ TopUpManager.ensureRowCount. */
    private _rowCount: number = MATSURI_MIN_ROWS;
    /** Pool 25 coinSlots từ Prefab 5×5. */
    private _poolCoinSlots: Node[] = [];
    private static readonly POOL_ROWS = 5;

    /** Baseline layout — capture 1 lần trước khi fit. */
    private _baseRootPos: Vec3 | null = null;
    private _frontFrameNode: Node | null = null;
    private _arrayNode: Node | null = null;
    private _gridNode: Node | null = null;
    /** FramFront/Top — HUD trên khung (fallback nếu chưa gán Inspector). */
    private _featureTopNode: Node | null = null;
    /** Đang ném quả cầu seed — Cat on, Top off. */
    private _inSeedThrowPhase = false;

    private _lastFeatureRemain = -1;
    private _featureCollectTotal = 0;

    get rowCount(): number { return this._rowCount; }

    /** Public: vị trí coin slot theo reel/row (Matsuri collect fly). */
    getCoinSlot(reel: number, row: number): Node | null {
        const idx = this._cellIdx(reel, row);
        return this.coinSlots[idx] ?? null;
    }

    /** Đích bay collect — SpriteNumber tổng tiền (Inspector). */
    getCollectTargetNode(): Node | null {
        return this.collectTotalSpriteNumber?.node ?? null;
    }

    getCollectTotalSpriteNumber(): SpriteNumber | null {
        return this.collectTotalSpriteNumber;
    }

    private _cellIdx(reel: number, row: number): number {
        return reel * this._rowCount + row;
    }

    /**
     * Đồng bộ số hàng với TopUpManager (clone coinSlots nếu Prefab chỉ có 5×3).
     * Sau remap: scale root StickyOverlay để 5×4/5×5 vừa tầm nhìn (reel + sticky đồng bộ).
     */
    ensureRowCount(rows: number, topUpMgr?: TopUpManager | null): void {
        const target = clampMatsuriRows(rows);
        if (topUpMgr) topUpMgr.ensureRowCount(target);

        if (this._poolCoinSlots.length === 0) {
            this._poolCoinSlots = this.coinSlots.slice();
        }

        // Prefab 5×5 pool
        if (this._poolCoinSlots.length >= MATSURI_COL_COUNT * StickyOverlayController.POOL_ROWS) {
            const fullRows = StickyOverlayController.POOL_ROWS;
            const next: Node[] = [];
            for (let col = 0; col < MATSURI_COL_COUNT; col++) {
                for (let row = 0; row < target; row++) {
                    const n = this._poolCoinSlots[col * fullRows + row];
                    if (!n) continue;
                    n.active = false; // refresh sẽ bật khi có coin
                    next.push(n);
                }
                for (let row = target; row < fullRows; row++) {
                    const n = this._poolCoinSlots[col * fullRows + row];
                    if (n) n.active = false;
                }
            }
            this.coinSlots = next;
            this._rowCount = target;
            Log.d(`[StickyOverlay] ensureRowCount pool → 5×${target} (${this.coinSlots.length} active)`);
            this._applyGridFitScale(target);
            return;
        }

        const oldRows = this._rowCount;
        const oldSlots = this.coinSlots.slice();

        if (target === oldRows && oldSlots.length >= MATSURI_COL_COUNT * target) {
            this._rowCount = target;
            this._applySlotVisibility();
            this._applyGridFitScale(target);
            return;
        }

        if (target < oldRows) {
            const kept: Node[] = [];
            for (let col = 0; col < MATSURI_COL_COUNT; col++) {
                for (let row = 0; row < target; row++) {
                    const n = oldSlots[col * oldRows + row];
                    if (n) kept.push(n);
                }
                for (let row = target; row < oldRows; row++) {
                    const n = oldSlots[col * oldRows + row];
                    if (n) n.active = false;
                }
            }
            this.coinSlots = kept;
            this._rowCount = target;
            this._applySlotVisibility();
            Log.d(`[StickyOverlay] ensureRowCount shrink → 5×${target}`);
            this._applyGridFitScale(target);
            return;
        }

        const spacingY = (oldSlots[0] && oldSlots[1])
            ? oldSlots[1].position.y - oldSlots[0].position.y
            : 120;
        const parent = oldSlots[0]?.parent;
        if (!parent) {
            Log.e('[StickyOverlay] ensureRowCount: thiếu parent coinSlots');
            this._rowCount = target;
            this._applyGridFitScale(target);
            return;
        }

        const newSlots: Node[] = [];
        for (let col = 0; col < MATSURI_COL_COUNT; col++) {
            for (let row = 0; row < target; row++) {
                if (row < oldRows) {
                    const existing = oldSlots[col * oldRows + row];
                    if (existing) {
                        existing.active = false;
                        newSlots.push(existing);
                    }
                    continue;
                }
                const template = oldSlots[col * oldRows + (oldRows - 1)];
                if (!template) continue;
                const node = instantiate(template);
                node.name = `CoinSlot_${col}_${row}`;
                parent.addChild(node);
                const base = template.position;
                node.setPosition(base.x, base.y + spacingY * (row - (oldRows - 1)), base.z);
                node.active = false;
                newSlots.push(node);
            }
        }
        this.coinSlots = newSlots;
        this._rowCount = target;
        this._applySlotVisibility();
        Log.e(`[StickyOverlay] ensureRowCount expand → 5×${target} slots=${this.coinSlots.length}`);
        this._applyGridFitScale(target);
    }

    /**
     * Fit layout theo số hàng:
     *  - FramFront: đổi sprite Reelframe_Freespin_5×N
     *  - GridMiniReel + Array: canh giữa Rect5×N, cell 182 (5×3) / 126 (5×4|5×5)
     *  - Root StickyOverlay giữ nguyên (Widget prefab đã canh)
     */
    private _applyGridFitScale(rows: number): void {
        this._ensureLayoutBaselines();
        const r = clampMatsuriRows(rows);

        this._applyFeatureFrame(r);
        this._layoutMatsuriGrid(r);
        this._syncGridRectNodes(r);

        this.node.setScale(1, 1, 1);

        this.alignPositionsFromTopUpManager();
        Log.d(`[StickyOverlay] grid fit 5×${r} cell=${matsuriCellSize(r)}`);
    }

    /** Đổi sprite FramFront theo 5×3 / 5×4 / 5×5 — giữ Widget, không dịch root. */
    private _applyFeatureFrame(rows: number): void {
        const frame = this._frontFrameNode;
        if (!frame) return;

        const spriteFrame = this._featureFrameForRows(rows);
        if (!spriteFrame) return;

        const sprite = frame.getComponent(Sprite);
        const ut = frame.getComponent(UITransform);
        if (sprite) {
            sprite.spriteFrame = spriteFrame;
            sprite.sizeMode = Sprite.SizeMode.RAW;
        }
        if (ut) {
            const w = spriteFrame.originalSize?.width ?? spriteFrame.width;
            const h = spriteFrame.originalSize?.height ?? spriteFrame.height;
            ut.setContentSize(w, h);
        }
    }

    private _featureFrameForRows(rows: number): SpriteFrame | null {
        const r = clampMatsuriRows(rows);
        if (r === 3) return this.featureFrame5x3;
        if (r === 4) return this.featureFrame5x4;
        return this.featureFrame5x5;
    }

    /** Canh pool 5×5 reel + coin slot vào giữa Rect5×N tương ứng. */
    private _layoutMatsuriGrid(rows: number): void {
        const r = clampMatsuriRows(rows);
        const cellSize = matsuriCellSize(r);
        const poolRows = StickyOverlayController.POOL_ROWS;
        const gridNode = this._gridNode;
        const arrayNode = this._arrayNode;

        const gridLayout = gridNode?.getComponent(Layout);
        if (gridLayout) gridLayout.enabled = false;
        const arrayLayout = arrayNode?.getComponent(Layout);
        if (arrayLayout) arrayLayout.enabled = false;

        for (let col = 0; col < MATSURI_COL_COUNT; col++) {
            for (let poolRow = 0; poolRow < poolRows; poolRow++) {
                const idx = col * poolRows + poolRow;
                const reelLocal = matsuriGridCellLocal('miniReel', r, col, poolRow);
                const arrayLocal = matsuriGridCellLocal('array', r, col, poolRow);

                const reelNode = gridNode?.children[idx] ?? gridNode?.getChildByName(String(idx));
                if (reelNode) {
                    reelNode.setPosition(reelLocal.x, reelLocal.y, reelNode.position.z);
                    this._setNodeSquareSize(reelNode, cellSize);
                }

                const arraySlot = arrayNode?.children[idx] ?? arrayNode?.getChildByName(String(idx));
                if (arraySlot) {
                    arraySlot.setPosition(arrayLocal.x, arrayLocal.y, arraySlot.position.z);
                    this._setNodeSquareSize(arraySlot, cellSize);
                }

                const poolSlot = this._poolCoinSlots[idx];
                if (poolSlot?.isValid && poolSlot.parent === arrayNode) {
                    poolSlot.setPosition(arrayLocal.x, arrayLocal.y, poolSlot.position.z);
                    this._setNodeSquareSize(poolSlot, cellSize);
                }
            }
        }

        const topUpMgr = this._getTopUpManager();
        topUpMgr?.applyGridCellSize(cellSize);
    }

    private _setNodeSquareSize(node: Node, size: number): void {
        const ut = node.getComponent(UITransform);
        if (ut) ut.setContentSize(size, size);
    }

    /** Bật đúng Rect5×N, tắt 2 Rect còn lại (debug/canhvùng grid trên Prefab). */
    private _syncGridRectNodes(rows: number): void {
        const r = clampMatsuriRows(rows);
        for (const n of [3, 4, 5] as const) {
            const rect = this.node.getChildByName(`Rect5x${n}`);
            if (rect?.isValid) rect.active = n === r;
        }
    }

    private _ensureLayoutBaselines(): void {
        if (!this._baseRootPos) {
            this._baseRootPos = this.node.position.clone();
        }
        if (this._gridNode && this._arrayNode && this._frontFrameNode) return;

        this._frontFrameNode = this.node.getChildByName('FramFront')
            ?? this.node.getChildByName('FrameFront');

        if (this._frontFrameNode) {
            const top = this._frontFrameNode.getChildByName('Top')
                ?? this.node.getChildByName('Top');
            if (top) this._featureTopNode = top;
        }

        this._arrayNode = this.node.getChildByName('Array');
        this._gridNode = this.node.getChildByName('GridMiniReel');
    }

    private _resetGridFitLayout(): void {
        this.node.setScale(1, 1, 1);
        if (this._baseRootPos) {
            this.node.setPosition(this._baseRootPos);
        }
    }

    private _applySlotVisibility(): void {
        const n = MATSURI_COL_COUNT * this._rowCount;
        for (let i = 0; i < this.coinSlots.length; i++) {
            // keep inactive until refresh shows coins; don't force active
            if (i >= n && this.coinSlots[i]) this.coinSlots[i].active = false;
        }
    }

    private _isCellFeatureMode(): boolean {
        const m = GameData.instance.currentMode;
        return m === 'respin' || m === 'matsuri';
    }

    private _isMatsuriMode(): boolean {
        return GameData.instance.currentMode === 'matsuri';
    }

    // ── FEATURE HUD (remain slots + collect total trên FramFront/Top) ─────────

    private _findSeedThrowCat(): Node | null {
        if (this.seedThrowCatNode?.isValid) return this.seedThrowCatNode;
        return this.node.getChildByName('Cat') ?? null;
    }

    private _findFeatureTop(): Node | null {
        if (this.featureFrameTopNode?.isValid) return this.featureFrameTopNode;
        if (this._featureTopNode?.isValid) return this._featureTopNode;
        const frame = this.node.getChildByName('FramFront')
            ?? this.node.getChildByName('FrameFront');
        return frame?.getChildByName('Top') ?? this.node.getChildByName('Top') ?? null;
    }

    private _wireFeatureHud(): void {
        this._inSeedThrowPhase = false;
        this._applyMatsuriFrameNodes(false);
    }

    private _ensureFrameNodeOpacity(node: Node): UIOpacity {
        return node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    }

    /**
     * Fade Cat/Top — crossfade bằng opacity, không toggle active giữa 2 node.
     * @param deactivateWhenHidden chỉ khi thoát feature (ẩn hẳn sau fade).
     */
    private _fadeMatsuriFrameNode(
        node: Node | null,
        visible: boolean,
        animate: boolean,
        deactivateWhenHidden = false,
    ): void {
        if (!node?.isValid) return;
        const op = this._ensureFrameNodeOpacity(node);
        Tween.stopAllByTarget(op);
        const dur = Math.max(0, this.matsuriFrameHudFadeDuration);

        if (visible) node.active = true;

        if (!animate || dur <= 0) {
            op.opacity = visible ? 255 : 0;
            if (!visible && deactivateWhenHidden) node.active = false;
            return;
        }

        if (visible) {
            if (op.opacity >= 255) return;
            op.opacity = 0;
            tween(op).to(dur, { opacity: 255 }, { easing: 'sineOut' }).start();
            return;
        }

        if (op.opacity <= 0) {
            if (deactivateWhenHidden) node.active = false;
            return;
        }
        tween(op)
            .to(dur, { opacity: 0 }, { easing: 'sineIn' })
            .call(() => {
                if (deactivateWhenHidden && node.isValid) node.active = false;
            })
            .start();
    }

    /** Cat ↔ Top: seed throw vs đã vào feature (crossfade opacity). */
    private _applyMatsuriFrameNodes(animate = true): void {
        const inMatsuri = this._isMatsuriMode();
        const cat = this._findSeedThrowCat();
        const top = this._findFeatureTop();

        if (!inMatsuri) {
            this._fadeMatsuriFrameNode(cat, false, animate, true);
            this._fadeMatsuriFrameNode(top, false, animate, true);
            return;
        }

        const showCat = this._inSeedThrowPhase;
        if (cat?.isValid) cat.active = true;
        if (top?.isValid) top.active = true;
        this._fadeMatsuriFrameNode(cat, showCat, animate, false);
        this._fadeMatsuriFrameNode(top, !showCat, animate, false);
    }

    private _syncFeatureHud(): void {
        this._applyMatsuriFrameNodes();
        if (!this._isMatsuriMode() || this._inSeedThrowPhase) return;
        const data = GameData.instance;
        const remain = data.respinRemaining;
        if (remain > 0) this._setFeatureRemain(remain);
        else if (this._lastFeatureRemain >= 0) this._setFeatureRemain(Math.max(0, remain));
        else this._setFeatureRemain(MATSURI_SPIN_COUNT);
        this._setFeatureCollectTotal(Math.max(this._featureCollectTotal, data.respinTotalWin || 0));
    }

    private _syncFeatureHudTotal(totalWin?: number): void {
        if (!this._isMatsuriMode()) return;
        const fromPayload = totalWin != null ? totalWin : 0;
        const fromData = GameData.instance.respinTotalWin || 0;
        // Không bao giờ tụt xuống 0 / số nhỏ hơn sau khi đã gom — chỉ nhận số lớn hơn.
        this._setFeatureCollectTotal(Math.max(this._featureCollectTotal, fromPayload, fromData));
    }

    private _onMatsuriHudStart(): void {
        this._featureCollectTotal = 0;
        // Vào mới: grid trống → chờ seed orb; resume: đã có sticky → feature mode ngay.
        this._inSeedThrowPhase = GameData.instance.stickyCells.size === 0;
        this._syncFeatureHud();
    }

    private _onMatsuriHudEnd(): void {
        this._lastFeatureRemain = -1;
        this._featureCollectTotal = 0;
        this._inSeedThrowPhase = false;
        this._applyMatsuriFrameNodes();
    }

    private _onMatsuriSeedStart(): void {
        this._inSeedThrowPhase = true;
        this._applyMatsuriFrameNodes();
    }

    private _onMatsuriSeedDone(): void {
        this._inSeedThrowPhase = false;
        this._syncFeatureHud();
    }

    private _onTopUpCountUpdated(count: number): void {
        if (!this._isMatsuriMode()) return;
        this._setFeatureRemain(count);
    }

    private _setFeatureRemain(count: number): void {
        const n = Math.max(0, Math.min(MATSURI_SPIN_COUNT, Math.floor(Number(count) || 0)));
        const prev = this._lastFeatureRemain;
        this._lastFeatureRemain = n;
        let fillAnimIndex = 0;
        for (let i = 0; i < this.spinRemainSlots.length; i++) {
            const slot = this.spinRemainSlots[i];
            const fill = slot?.getChildByName('Fill');
            if (!fill) continue;
            const shouldFill = i < n;
            const wasFill = fill.active;
            fill.active = shouldFill;
            // Chỉ diễn khi cộng thêm ô (Green reset) — không bounce lúc trừ lượt / sync lần đầu.
            if (shouldFill && !wasFill && prev >= 0) {
                this._playRemainSlotFillEffect(fill, fillAnimIndex * 0.08);
                fillAnimIndex++;
            }
        }
    }

    private _playRemainSlotFillEffect(fill: Node, delay: number): void {
        if (!fill?.isValid) return;
        Tween.stopAllByTarget(fill);
        fill.setScale(0.15, 0.15, 1);
        const play = () => {
            if (!fill.isValid) return;
            SoundManager.instance?.playSfxByName('sxPlus1Spin');
            tween(fill)
                .to(0.18, { scale: new Vec3(1.28, 1.28, 1) }, { easing: 'backOut' })
                .to(0.12, { scale: new Vec3(1, 1, 1) }, { easing: 'sineIn' })
                .start();
        };
        if (delay > 0) this.scheduleOnce(play, delay);
        else play();
    }

    private _setFeatureCollectTotal(value: number): void {
        const next = Math.max(0, value);
        if (next < this._featureCollectTotal) return;
        this._featureCollectTotal = next;
        const sn = this.collectTotalSpriteNumber;
        if (!sn?.node?.isValid) {
            Log.w('[StickyOverlay] collectTotalSpriteNumber chưa gán — kéo SpriteNumber vào Inspector');
            return;
        }
        sn.node.active = true;
        sn.setData(this._featureCollectTotal, -1, 0, true);
    }

    // ── LIFECYCLE ──────────────────────────────────────────────────────────────

    onLoad(): void {
        this._poolCoinSlots = this.coinSlots.slice();
        if (this._poolCoinSlots.length >= MATSURI_COL_COUNT * StickyOverlayController.POOL_ROWS) {
            this._rowCount = StickyOverlayController.POOL_ROWS;
            this.ensureRowCount(MATSURI_MIN_ROWS, null);
        } else if (this.coinSlots.length >= 20) {
            this._rowCount = 4;
        } else {
            this._rowCount = 3;
        }

        this._hideAll();
        this._wireFeatureHud();

        EventBus.instance.on(GameEvents.TOPUP_TRANSITION_SHOW, this._onTransitionShow, this);
        EventBus.instance.on(GameEvents.TOPUP_TRANSITION_READY, this._onTransitionReady, this);
        EventBus.instance.on(GameEvents.TOPUP_TRANSITION_DONE, this._onTransitionDone, this);
        EventBus.instance.on(GameEvents.TOPUP_START,         this._onTopUpStart,   this);
        EventBus.instance.on(GameEvents.TOPUP_TOTAL_UPDATED, this._onTopUpUpdated, this);
        EventBus.instance.on(GameEvents.TOPUP_COUNT_UPDATED, this._onTopUpCountUpdated, this);
        EventBus.instance.on(GameEvents.CARNIVAL_MATSURI_START, this._onMatsuriHudStart, this);
        EventBus.instance.on(GameEvents.CARNIVAL_MATSURI_END, this._onMatsuriHudEnd, this);
        EventBus.instance.on(GameEvents.MATSURI_SEED_START, this._onMatsuriSeedStart, this);
        EventBus.instance.on(GameEvents.MATSURI_SEED_DONE, this._onMatsuriSeedDone, this);
        EventBus.instance.on(GameEvents.TOPUP_END,           this._onTopUpEnd,     this);
        EventBus.instance.on(GameEvents.FREE_SPIN_GOLD_END, this._onTopUpEnd,     this);
        EventBus.instance.on(GameEvents.FREE_SPIN_END,       this._onTopUpEnd,     this);
        EventBus.instance.on(GameEvents.REELS_START_SPIN,   this._onReelsStartSpin, this);
        EventBus.instance.on(GameEvents.MATSURI_COLLECT_DONE, this._onMatsuriCollectDone, this);

        // Defer inactive: nếu set active=false ngay trong onLoad, child TopUpManager
        // có thể chưa kịp onLoad khi lazy-instantiate Prefab.
        // Đang ở TopUp/Matsuri (resume / vừa set mode) → giữ active, chờ TOPUP_START refresh.
        this.scheduleOnce(() => {
            if (!this._isCellFeatureMode()) {
                this.node.active = false;
            }
        }, 0);
    }

    onDestroy(): void {
        EventBus.instance.off(GameEvents.TOPUP_TRANSITION_SHOW, this._onTransitionShow, this);
        EventBus.instance.off(GameEvents.TOPUP_TRANSITION_READY, this._onTransitionReady, this);
        EventBus.instance.off(GameEvents.TOPUP_TRANSITION_DONE, this._onTransitionDone, this);
        EventBus.instance.off(GameEvents.TOPUP_START,         this._onTopUpStart,   this);
        EventBus.instance.off(GameEvents.TOPUP_TOTAL_UPDATED, this._onTopUpUpdated, this);
        EventBus.instance.off(GameEvents.TOPUP_COUNT_UPDATED, this._onTopUpCountUpdated, this);
        EventBus.instance.off(GameEvents.CARNIVAL_MATSURI_START, this._onMatsuriHudStart, this);
        EventBus.instance.off(GameEvents.CARNIVAL_MATSURI_END, this._onMatsuriHudEnd, this);
        EventBus.instance.off(GameEvents.MATSURI_SEED_START, this._onMatsuriSeedStart, this);
        EventBus.instance.off(GameEvents.MATSURI_SEED_DONE, this._onMatsuriSeedDone, this);
        EventBus.instance.off(GameEvents.TOPUP_END,           this._onTopUpEnd,     this);
        EventBus.instance.off(GameEvents.FREE_SPIN_GOLD_END, this._onTopUpEnd,     this);
        EventBus.instance.off(GameEvents.FREE_SPIN_END,       this._onTopUpEnd,     this);
        EventBus.instance.off(GameEvents.REELS_START_SPIN,   this._onReelsStartSpin, this);
        EventBus.instance.off(GameEvents.MATSURI_COLLECT_DONE, this._onMatsuriCollectDone, this);
    }

    // ── EVENT HANDLERS ─────────────────────────────────────────────────────────

    /** Transition TopUp bắt đầu fade-in → đánh dấu sẽ defer bounce. */
    private _onTransitionShow(mode?: TransitionMode): void {
        if (mode === TransitionMode.TopUp) {
            this._deferEnterAnim = true;
            this._enterAnimPlayed = false;
        }
    }

    /** Fade-in xong — UI TopUp sắp prepare; vẫn defer bounce đến DONE. */
    private _onTransitionReady(mode?: TransitionMode): void {
        if (mode === TransitionMode.TopUp) {
            this._deferEnterAnim = true;
        }
    }

    /** Transition tắt → diễn fade + bounce đồng đỏ lần đầu vào TopUp. */
    private _onTransitionDone(): void {
        if (!this._isCellFeatureMode()) {
            this._pendingEnterAnim = false;
            this._deferEnterAnim = false;
            return;
        }
        if (this._enterAnimPlayed) return;
        // Chỉ bounce khi đã TOPUP_START (pending) hoặc overlay đã setup (active + defer)
        if (this._pendingEnterAnim || (this._deferEnterAnim && this.node.active)) {
            this._playEnterAnim();
            return;
        }
        // TOPUP_START tới sau DONE (load chậm) → giữ defer=false để START tự nhún
        this._deferEnterAnim = false;
    }

    private _onTopUpStart(): void {
        this.node.active = true;
        this._topUpSpinCounter = 0;
        this._enterAnimPlayed = false;
        this.alignPositionsFromTopUpManager();
        this._previouslyActiveSlots.clear();
        this._syncFeatureHud();

        // Dưới Transition (sau READY): setup tĩnh, nhún khi DONE
        if (this._deferEnterAnim || this._isTopUpTransitionActive()) {
            this._deferEnterAnim = true;
            const op = this.node.getComponent(UIOpacity) ?? this.node.addComponent(UIOpacity);
            Tween.stopAllByTarget(op);
            op.opacity = 0;
            this._refreshAll(false, false);
            this._pendingEnterAnim = true;
            Log.d('[StickyOverlay] TopUp coins prepared under Transition — bounce deferred to DONE');
            return;
        }

        // Resume / không qua Transition → nhún ngay
        this._playEnterAnim();
    }

    /** TransitionPopup TopUp đang phủ màn hình? */
    private _isTopUpTransitionActive(): boolean {
        const scene = this.node.scene;
        if (!scene) return false;
        const popups = scene.getComponentsInChildren(TopUpTransitionPopup);
        return popups.some(p => !!p?.node?.isValid && p.node.active);
    }

    /** Fade-in overlay + (TopUp) bounce stagger; Matsuri: hiện tĩnh, không nhún L→R. */
    private _playEnterAnim(): void {
        if (this._enterAnimPlayed) return;
        this._enterAnimPlayed = true;
        this._pendingEnterAnim = false;
        this._deferEnterAnim = false;
        this.node.active = true;
        this._previouslyActiveSlots.clear();
        this._fadeInOverlay();
        const isMatsuri = GameData.instance.currentMode === 'matsuri';
        if (isMatsuri) {
            this.alignPositionsFromTopUpManager();
            this._previouslyActiveSlots.clear();
            this._matsuriPendingFlipKeys.clear();
            this._matsuriFlippingKeys.clear();
            // Resume mid-feature: sticky đã có → hiện ngay (không chờ seed orb)
            if (GameData.instance.stickyCells.size > 0) {
                this._inSeedThrowPhase = false;
                this._syncFeatureHud();
                this._refreshAll(false, false);
                Log.d(`[StickyOverlay] Matsuri resume — show ${GameData.instance.stickyCells.size} stickies`);
                return;
            }
            // Enter mới: grid trống — Start Gold chỉ hiện khi seed orb land
            this._inSeedThrowPhase = true;
            this._hideAll();
            Log.d('[StickyOverlay] Matsuri enter — blank overlay (chờ seed)');
            return;
        }
        this._isEnteringTopUp = true;
        this._refreshAll(false, true);
        this._isEnteringTopUp = false;
        Log.d('[StickyOverlay] TopUp enter bounce started');
    }

    private _fadeInOverlay(): void {
        const fadeDur = Math.max(0.05, this.topUpEnterFadeDuration);
        const op = this.node.getComponent(UIOpacity) ?? this.node.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        op.opacity = 0;
        tween(op).to(fadeDur, { opacity: 255 }, { easing: 'sineOut' }).start();
    }

    private _onTopUpUpdated(payload?: { totalWin?: number }): void {
        this._syncFeatureHudTotal(payload?.totalWin);
        // Seed / collect / flip: không _refreshAll — web dễ throw + cắt tween Green.
        if (
            GameData.instance.currentMode === 'matsuri'
            && (
                this._matsuriDeferGoldLandBounce
                || this._matsuriPendingFlipKeys.size > 0
                || this._matsuriFlippingKeys.size > 0
                || this._matsuriFlipDonePending > 0
            )
        ) {
            return;
        }
        // Gọi sau mỗi spin Topup kết thúc — stickyCells đã được cập nhật bởi GameManager
        this._refreshAll(true /* chỉ fade in coin MỚI */);
    }

    private _onReelsStartSpin(): void {
        if (!this.node.active) return;

        this._topUpSpinCounter++;
        this._restoreCoinSlotParents(this._topUpSpinCounter);

        if (GameData.instance.currentMode === 'matsuri') {
            // Chỉ snap REST — không _refreshAll (tránh giật + lệch theo mid đang quay)
            this.snapActiveCoinsToReelRest();
            return;
        }

        this._refreshAll(true /* chỉ fade in coin MỚI, coin cũ giữ nguyên */);
    }

    private _onTopUpEnd(): void {
        this._restoreCoinSlotParents();
        this._hideAll();
        this._previouslyActiveSlots.clear();
        this._slotCreditMap.clear();
        this._coinSlotOriginalParents.clear();
        this._topUpSpinCounter = 0;
        this._goldLandBounceEndMs = 0;
        this._matsuriFlippingKeys.clear();
        this._matsuriPendingFlipKeys.clear();
        this._matsuriFlipDonePending = 0;
        this._deferEnterAnim = false;
        this._pendingEnterAnim = false;
        this._enterAnimPlayed = false;
        this._lastFeatureRemain = -1;
        this._featureCollectTotal = 0;
        this._inSeedThrowPhase = false;
        this._applyMatsuriFrameNodes();
        // Reset scale / frame / Y về baseline 5×5
        this._resetGridFitLayout();
        const topUpMgr = this.node.getComponentInChildren(TopUpManager);
        this.ensureRowCount(MATSURI_MIN_ROWS, topUpMgr);
        // Fade out opacity rồi mới active=false
        const fadeDur = Math.max(0.05, this.topUpEnterFadeDuration);
        const op = this.node.getComponent(UIOpacity) ?? this.node.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        tween(op)
            .to(fadeDur, { opacity: 0 }, { easing: 'sineIn' })
            .call(() => {
                if (this.node?.isValid) this.node.active = false;
            })
            .start();
    }

    /** Sau flip: cập nhật stickyCells + vẽ CreditLabel trên Gold (credit = API). */
    private _applyMatsuriFlipResult(
        slotNode: Node,
        key: string,
        idx: number,
        credit: number,
    ): void {
        const safeCredit = Math.max(0, credit)
            || this._lookupMatsuriApiCredit(
                parseInt(key.split('-')[0], 10),
                parseInt(key.split('-')[1], 10),
            )
            || this._slotCreditMap.get(slotNode)
            || 0;
        const cell = GameData.instance.stickyCells.get(key);
        if (cell) {
            cell.symbolId = MATSURI_GOLD_SYMBOL;
            cell.credit = safeCredit;
            GameData.instance.stickyCells.set(key, { ...cell });
        }
        if (slotNode?.isValid) {
            this._applyCoin(slotNode, MATSURI_GOLD_SYMBOL, safeCredit);
            this._alignSlotToTopUpCell(idx);
            slotNode.setRotationFromEuler(0, 0, 0);
        }
    }

    /** Collect Gold xong → flip mọi Green đang pending. */
    private _onMatsuriCollectDone(): void {
        if (this._matsuriFlipDonePending > 0) {
            return;
        }
        if (GameData.instance.currentMode !== 'matsuri') {
            EventBus.instance.emit(GameEvents.MATSURI_FLIP_DONE);
            return;
        }

        const keys = [...this._matsuriPendingFlipKeys];
        this._matsuriPendingFlipKeys.clear();

        if (keys.length === 0) {
            for (const [key, cell] of GameData.instance.stickyCells) {
                if (cell.symbolId === SymbolId.STICKY_GREEN) keys.push(key);
            }
        }

        if (keys.length === 0) {
            EventBus.instance.emit(GameEvents.MATSURI_FLIP_DONE);
            return;
        }

        this._matsuriFlipDonePending = keys.length;
        Log.e(
            `[GREEN-CREDIT][FLIP-ALL] count=${keys.length} ` +
            keys.map(k => {
                const [c, r] = k.split('-').map(n => parseInt(n, 10));
                const cell = GameData.instance.stickyCells.get(k);
                const credit = this._lookupMatsuriApiCredit(c, r) || Math.max(0, cell?.credit ?? 0);
                return `col=${c} row=${r} credit=${credit}${credit <= 0 ? ' ⚠0' : ''}`;
            }).join(' | '),
        );

        for (const key of keys) {
            try {
                const [reelStr, rowStr] = key.split('-');
                const reel = parseInt(reelStr, 10);
                const row = parseInt(rowStr, 10);
                const idx = this._cellIdx(reel, row);
                const slotNode = this.coinSlots[idx];
                const cell = GameData.instance.stickyCells.get(key);
                if (!slotNode?.isValid || !cell) {
                    Log.e(`[GREEN-CREDIT][FLIP] col=${reel} row=${row} SKIP slot=${!!slotNode?.isValid} cell=${!!cell}`);
                    this._onOneMatsuriFlipDone();
                    continue;
                }
                const flipCredit = this._lookupMatsuriApiCredit(reel, row)
                    || Math.max(0, cell.credit ?? 0)
                    || this._slotCreditMap.get(slotNode)
                    || 0;
                if (flipCredit > 0 && (cell.credit ?? 0) !== flipCredit) {
                    cell.credit = flipCredit;
                    GameData.instance.stickyCells.set(key, { ...cell });
                }
                this._logGreenCredit('FLIP', reel, row, flipCredit, slotNode);
                slotNode.active = true;
                this._playMatsuriGreenFlipToGold(slotNode, key, idx, flipCredit);
            } catch {
                this._matsuriFlippingKeys.delete(key);
                this._onOneMatsuriFlipDone();
            }
        }
    }

    private _onOneMatsuriFlipDone(): void {
        this._matsuriFlipDonePending = Math.max(0, this._matsuriFlipDonePending - 1);
        if (this._matsuriFlipDonePending <= 0) {
            EventBus.instance.emit(GameEvents.MATSURI_FLIP_DONE);
        }
    }

    // ── CORE LOGIC ─────────────────────────────────────────────────────────────

    /**
     * Refresh toàn bộ 15 ô overlay từ GameData.stickyCells.
     * @param fadeOnlyNew  true  = chỉ fade-in slot vừa được bật (slot cũ giữ nguyên)
     *                     false = ẩn hết rồi show tất cả cùng lúc (lần đầu vào Topup)
     * @param animate      false = chỉ đặt coin tĩnh (dưới Transition, chưa nhún)
     */
    private _refreshAll(fadeOnlyNew: boolean, animate: boolean = true): void {
        const cells = GameData.instance.stickyCells;
        const newActiveSlots = new Set<string>();

        const isEnter = this._isEnteringTopUp;

        for (let reel = 0; reel < 5; reel++) {
            for (let row = 0; row < this._rowCount; row++) {
                const key      = `${reel}-${row}`;
                const idx      = this._cellIdx(reel, row);
                const slotNode = this.coinSlots[idx];
                if (!slotNode) continue;

                const cell = cells.get(key);

                if (!cell) {
                    // Không có coin → ẩn slot
                    Tween.stopAllByTarget(slotNode);
                    const emptyOpacity = slotNode.getComponent(UIOpacity);
                    if (emptyOpacity) {
                        Tween.stopAllByTarget(emptyOpacity);
                        emptyOpacity.opacity = 255;
                    }
                    const emptyLabel = slotNode.getChildByName('CreditLabel');
                    if (emptyLabel) {
                        Tween.stopAllByTarget(emptyLabel);
                        emptyLabel.active = false;
                        emptyLabel.setScale(1, 1, 1);
                    }
                    this._slotCreditMap.delete(slotNode);
                    this._matsuriFlippingKeys.delete(key);
                    slotNode.setScale(1, 1, 1);
                    slotNode.active = false;
                    continue;
                }

                // Track active slots
                newActiveSlots.add(key);

                // Matsuri flip Green→Gold đang chạy — đừng apply/align (tránh cắt tween + lệch Y)
                if (this._matsuriFlippingKeys.has(key)) {
                    continue;
                }
                // Đang chờ collect → giữ Green (đảm bảo vẫn active + sprite xanh)
                if (this._matsuriPendingFlipKeys.has(key) && cell.symbolId === SymbolId.STICKY_GREEN) {
                    newActiveSlots.add(key);
                    if (!slotNode.active) {
                        this._applyCoin(slotNode, SymbolId.STICKY_GREEN, 0);
                        slotNode.active = true;
                        this._reparentToStickyOverlay(slotNode);
                        this._alignSlotToTopUpCell(idx);
                    }
                    const gOp = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
                    Tween.stopAllByTarget(gOp);
                    gOp.opacity = 255;
                    continue;
                }

                // Detect if this is a NEW coin (wasn't in previous set)
                const isNewCoin = !this._previouslyActiveSlots.has(key);
                // TopUp: Yellow/Green mới chờ absorb → credit=0 tạm.
                // Matsuri Green: ẩn credit đến khi flip → Gold; Gold hiện credit ngay.
                const isMatsuri = GameData.instance.currentMode === 'matsuri';
                const isAbsorbTarget = !isMatsuri && isNewCoin && (
                    cell.symbolId === SymbolId.STICKY_YELLOW ||
                    cell.symbolId === SymbolId.STICKY_GREEN
                );
                const isMatsuriGreenPending =
                    isMatsuri && cell.symbolId === SymbolId.STICKY_GREEN;
                const creditToShow = (isAbsorbTarget || isMatsuriGreenPending)
                    ? 0
                    : (cell.credit ?? 0);

                // Áp dụng sprite + credit
                // Align chỉ coin MỚI (tránh refresh sau land canh lại giữa bounce → lệch Y)
                this._applyCoin(slotNode, cell.symbolId, creditToShow);
                slotNode.active = true;
                // Pool slot có thể còn opacity=0 từ fade bị ngắt ở feature trước.
                // Nhánh coin mới bên dưới vẫn được phép set lại 0 để chạy fade.
                const visibleOp = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
                Tween.stopAllByTarget(visibleOp);
                visibleOp.opacity = 255;
                if (isNewCoin) {
                    this._reparentToStickyOverlay(slotNode);
                    this._alignSlotToTopUpCell(idx);
                }

                const isGoldCoin = cell.symbolId === SymbolId.STICKY_YELLOW
                    || cell.symbolId === SymbolId.STICKY_GREEN;

                if (!animate) {
                    // Setup tĩnh dưới Transition — chờ DONE mới fade/bounce
                    Tween.stopAllByTarget(slotNode);
                    slotNode.setRotationFromEuler(0, 0, 0);
                    const restOp = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
                    Tween.stopAllByTarget(restOp);
                    restOp.opacity = 255;
                    slotNode.setScale(this._getBaseScale(cell.symbolId), this._getBaseScale(cell.symbolId), 1);
                    if (isNewCoin) this._alignSlotToTopUpCell(idx);
                    continue;
                }

                // Fade in + Bounce: chỉ cho coin MỚI hoặc lần đầu mở (fadeOnlyNew=false)
                if (!fadeOnlyNew || isNewCoin) {
                    // Matsuri Green land: hiện xanh + chờ collect Gold → rồi mới flip
                    if (isMatsuri && isNewCoin && cell.symbolId === SymbolId.STICKY_GREEN) {
                        const op = slotNode.getComponent(UIOpacity)
                            ?? slotNode.addComponent(UIOpacity);
                        Tween.stopAllByTarget(op);
                        op.opacity = 255;
                        this._matsuriPendingFlipKeys.add(key);
                        this._playMatsuriGreenLandOnly(slotNode, idx);
                        continue;
                    }

                    // Matsuri Gold mới (seed / spin land / sau flip)
                    if (isMatsuri && isNewCoin && cell.symbolId === SymbolId.STICKY_YELLOW) {
                        const op = slotNode.getComponent(UIOpacity)
                            ?? slotNode.addComponent(UIOpacity);
                        Tween.stopAllByTarget(op);
                        op.opacity = 255;
                        this._alignSlotToTopUpCell(idx);
                        if (this._matsuriDeferGoldLandBounce) {
                            // Seed: pop scale 0 → base (không dùng handoff bounce đè orb)
                            this._playMatsuriGoldSeedPopIn(slotNode, cell.symbolId);
                        } else {
                            this._playMatsuriGoldLandBounce(slotNode, cell.symbolId);
                        }
                        continue;
                    }

                    // Land vàng/xanh TopUp: reel Mid giữ nguyên; overlay nhún giống sticky đỏ
                    const fromHandoff = isGoldCoin && !isEnter && isNewCoin;
                    if (fromHandoff) {
                        const op = slotNode.getComponent(UIOpacity)
                            ?? slotNode.addComponent(UIOpacity);
                        Tween.stopAllByTarget(op);
                        op.opacity = 255;
                        this._playCoinBounce(slotNode, cell.symbolId, false, true);
                    } else {
                        const fadeDur = isEnter
                            ? this.topUpEnterCoinFadeDuration
                            : (isGoldCoin ? this.goldCoinFadeInDuration : this.coinFadeInDuration);
                        if (fadeDur > 0) {
                            const op = slotNode.getComponent(UIOpacity)
                                ?? slotNode.addComponent(UIOpacity);
                            Tween.stopAllByTarget(op);
                            op.opacity = 0;
                            tween(op).to(fadeDur, { opacity: 255 }, { easing: 'sineOut' }).start();
                        }
                        const stagger = isEnter ? idx * this.coinEnterBounceStagger : 0;
                        if (stagger > 0) {
                            this.scheduleOnce(
                                () => this._playCoinBounce(slotNode, cell.symbolId, isEnter, false),
                                stagger,
                            );
                        } else {
                            this._playCoinBounce(slotNode, cell.symbolId, isEnter, false);
                        }
                    }
                }
            }
        }
        this._applyStickySymbolOrder();

        // Update previous active slots for next refresh
        this._previouslyActiveSlots = newActiveSlots;
    }

    /** Ẩn tất cả 15 slot (không destroy, chỉ inactive) */
    private _hideAll(): void {
        for (const slot of this.coinSlots) {
            if (!slot) continue;
            Tween.stopAllByTarget(slot);
            const op = slot.getComponent(UIOpacity);
            if (op) {
                Tween.stopAllByTarget(op);
                op.opacity = 255;
            }
            slot.setScale(1, 1, 1);
            const labelNode = slot.getChildByName('CreditLabel');
            if (labelNode) {
                Tween.stopAllByTarget(labelNode);
                labelNode.active = false;
                labelNode.setScale(1, 1, 1);
            }
            this._slotCreditMap.delete(slot);
            slot.active = false;
        }
    }

    private _reparentToStickyOverlay(slotNode: Node): void {
        if (!slotNode || !slotNode.isValid || slotNode.parent === this.node) return;
        const existing = this._coinSlotOriginalParents.get(slotNode);
        if (!existing) {
            this._coinSlotOriginalParents.set(slotNode, {
                parent: slotNode.parent,
                siblingIndex: slotNode.getSiblingIndex(),
                spinCounter: this._topUpSpinCounter,
            });
        } else {
            existing.spinCounter = this._topUpSpinCounter;
        }
        slotNode.setParent(this.node, true);
        slotNode.setSiblingIndex(this.node.children.length - 1);
    }

    private _restoreCoinSlotParents(maxSpinCounter?: number): void {
        const toRemove: Node[] = [];
        for (const [slotNode, data] of this._coinSlotOriginalParents) {
            if (!slotNode || !slotNode.isValid) {
                toRemove.push(slotNode);
                continue;
            }
            if (maxSpinCounter != null && data.spinCounter >= maxSpinCounter) continue;
            if (data.parent && data.parent.isValid) {
                if (slotNode.parent !== data.parent) {
                    slotNode.setParent(data.parent, true);
                }
                slotNode.setSiblingIndex(data.parent.children.length - 1);
            }
            toRemove.push(slotNode);
        }
        for (const slotNode of toRemove) {
            this._coinSlotOriginalParents.delete(slotNode);
        }
    }

    private _applyStickySymbolOrder(): void {
        const sortable = this.coinSlots
            .map((node, idx) => {
                const reel = Math.floor(idx / this._rowCount);
                const row = idx % this._rowCount;
                const cell = GameData.instance.stickyCells.get(`${reel}-${row}`);
                return { node, idx, symbolId: cell?.symbolId ?? -1 };
            })
            .filter(item => item.node && item.node.active && this._stickySymbolLayerPriority(item.symbolId) >= 0);

        sortable.sort((a, b) => {
            const priorityDiff = this._stickySymbolLayerPriority(a.symbolId) - this._stickySymbolLayerPriority(b.symbolId);
            if (priorityDiff !== 0) return priorityDiff;
            return a.idx - b.idx;
        });

        for (const item of sortable) {
            item.node.setSiblingIndex(item.node.parent!.children.length - 1);
        }
    }

    private _stickySymbolLayerPriority(symbolId: number): number {
        switch (symbolId) {
            case SymbolId.STICKY_YELLOW: return 0;
            case SymbolId.STICKY_GREEN: return 1;
            default: return -1;
        }
    }

    /**
     * Credit API cho ô Green: NewStickies trước, rồi stickyCells, rồi AllStickies (đúng tọa độ).
     * NewStickies thử cả row đảo (phòng server Row 0 = bottom).
     */
    private _lookupMatsuriApiCredit(reel: number, row: number): number {
        const data = GameData.instance;
        const rows = this._rowCount;
        const resp = data.lastSpinResponse;
        const fromApi = lookupCnStickyCredit(
            reel,
            row,
            rows,
            [resp?.newStickies, resp?.stickyCells, resp?.allStickies],
        );
        if (fromApi > 0) return fromApi;
        const slots = resp?.topupReel ?? [];
        if (slots.length > 0) {
            const altRow = rows - 1 - row;
            for (let serverIdx = 0; serverIdx < slots.length; serverIdx++) {
                const slot = slots[serverIdx];
                const win = Math.max(0, slot.win ?? 0);
                if (win <= 0) continue;
                const apiRow = Math.floor(serverIdx / 5);
                const slotReel = serverIdx % 5;
                const slotRow = rows - 1 - apiRow;
                if (slotReel === reel && (slotRow === row || slotRow === altRow)) return win;
            }
        }
        const stored = Math.max(0, data.stickyCells.get(`${reel}-${row}`)?.credit ?? 0);
        if (stored > 0) return stored;
        let greenCount = 0;
        let goldSum = 0;
        for (const cell of data.stickyCells.values()) {
            if (cell.symbolId === SymbolId.STICKY_GREEN) greenCount++;
            if (cell.symbolId === MATSURI_GOLD_SYMBOL || cell.symbolId === SymbolId.STICKY_YELLOW) {
                goldSum += Math.max(0, cell.credit ?? 0);
            }
        }
        if (greenCount === 1) {
            const acc = Number(resp?.accumulatedStickyCredit ?? 0);
            const fromAcc = Math.round((acc - goldSum) * 1000) / 1000;
            if (fromAcc > 0) return fromAcc;
            const spinCollect = Number(resp?.collectWin ?? resp?.featureSpinWin ?? 0);
            if (spinCollect > 0) return spinCollect;
        }
        return 0;
    }

    /** Giữ CreditLabel.active=true (SpriteNumber onLoad sẵn) — ẩn/hiện bằng opacity. */
    private _setMatsuriCreditLabelVisible(slotNode: Node, visible: boolean, credit = 0): void {
        const { labelNode, sn } = this._resolveCreditLabel(slotNode);
        if (!labelNode) return;
        if (!labelNode.active) labelNode.active = true;
        if (sn && credit > 0) sn.setData(credit);
        const op = labelNode.getComponent(UIOpacity) ?? labelNode.addComponent(UIOpacity);
        op.opacity = visible ? 255 : 0;
    }

    private _logGreenCredit(
        phase: string,
        reel: number,
        row: number,
        applied: number,
        slotNode?: Node | null,
    ): void {
        const data = GameData.instance;
        const resp = data.lastSpinResponse;
        const cell = data.stickyCells.get(`${reel}-${row}`);
        const { labelNode, sn } = slotNode ? this._resolveCreditLabel(slotNode) : { labelNode: null, sn: null };
        const fmt = (list?: { reel: number; row: number; credit?: number }[]) =>
            (list ?? []).map(c => `col=${c.reel} row=${c.row} credit=${c.credit ?? 0}`).join(' | ') || 'none';
        const miss = applied <= 0 ? ' ⚠ CREDIT=0' : '';
        const topupWin = (() => {
            const slots = resp?.topupReel ?? [];
            if (!slots.length) return 'n/a';
            const rows = this._rowCount;
            const apiRow = rows - 1 - row;
            const idx = apiRow * 5 + reel;
            return `${slots[idx]?.win ?? 'miss'}@${idx}`;
        })();
        Log.e(
            `[GREEN-CREDIT][${phase}] col=${reel} row=${row} applied=${applied}` +
            ` sticky=${cell?.credit ?? 'MISS'} lookup=${this._lookupMatsuriApiCredit(reel, row)}` +
            ` label=${labelNode?.name ?? 'NONE'} sn=${sn ? 1 : 0}${miss}` +
            ` totalWin=${resp?.totalWin ?? 0} fsTotal=${resp?.featureSpinTotalWin ?? 'n/a'}` +
            ` accSticky=${resp?.accumulatedStickyCredit ?? 'n/a'} collectWin=${resp?.collectWin ?? 'n/a'} topupWin=${topupWin}` +
            `\n  NewStickies: ${fmt(resp?.newStickies)}` +
            `\n  resp.stickyCells: ${fmt(resp?.stickyCells)}` +
            `\n  AllStickies: ${fmt(resp?.allStickies)}`,
        );
    }

    /** Tìm CreditLabel child — fallback typo CreaditLabel + SpriteNumber trong nested prefab. */
    private _resolveCreditLabel(slotNode: Node): { labelNode: Node | null; sn: SpriteNumber | null } {
        let labelNode = slotNode.getChildByName('CreditLabel')
            ?? slotNode.getChildByName('CreaditLabel');
        let sn = labelNode?.getComponent(SpriteNumber) ?? null;
        if (!sn) {
            sn = slotNode.getComponentInChildren(SpriteNumber);
            if (sn) labelNode = sn.node;
        }
        return { labelNode, sn };
    }

    /**
     * Matsuri Green (chưa flip): không hiện CreditLabel — chỉ hiện sau khi lật thành Gold.
     * Yellow / TopUp Green: hiện khi credit > 0.
     */
    private _shouldShowCreditLabel(symbolId: number, credit: number): boolean {
        if (
            symbolId === SymbolId.STICKY_GREEN
            && GameData.instance.currentMode === 'matsuri'
        ) {
            return false;
        }
        return credit > 0;
    }

    /**
     * Áp dụng loại coin + credit value lên 1 slotNode.
     * @param symbolId  SymbolId.STICKY_YELLOW / GREEN
     * @param credit    Giá trị credit (>= 0, luôn hiển thị CreditLabel)
     */
    private _applyCoin(slotNode: Node, symbolId: number, credit: number, quiet = false): void {
        const lastCredit = this._slotCreditMap.get(slotNode);
        const safeLastCredit = lastCredit != null && lastCredit >= 0 ? lastCredit : 0;
        const creditChanged = credit !== safeLastCredit;

        // ── Sprite: coinFrames → SlotMachine.symbolFrames (ps_45 vàng / ps_44 xanh) ──
        const sprite = slotNode.getComponent(Sprite);
        const frame = this._resolveCoinFrame(symbolId);
        if (sprite && frame) {
            sprite.sizeMode = Sprite.SizeMode.CUSTOM;
            sprite.spriteFrame = frame;
            const ut = slotNode.getComponent(UITransform);
            const coinSize = Math.round(matsuriCellSize(this._rowCount) * GRID_MINI_COIN_SIZE / MATSURI_CELL_SIZE);
            if (ut) ut.setContentSize(coinSize, coinSize);
        }

        // ★ Giữ nguyên scale cho coin đã có (existing) — new coin set base scale qua _playCoinBounce.

        // ── Credit label (SpriteNumber trên child "CreditLabel") ──
        // Matsuri Green: ẩn đến khi flip Gold. Yellow/Green TopUp: credit > 0.
        const displayCredit = credit > 0 ? credit : safeLastCredit;
        const shouldActive  = this._shouldShowCreditLabel(symbolId, displayCredit);
        const { labelNode, sn } = this._resolveCreditLabel(slotNode);
        const isMatsuri = GameData.instance.currentMode === 'matsuri';
        if (labelNode) {
            if (creditChanged) {
                labelNode.setRotationFromEuler(0, 0, 0);
            }
            if (isMatsuri) {
                // Không active=false — lần đầu bật sẽ delay onLoad SpriteNumber (số hiện chậm).
                if (!labelNode.active) labelNode.active = true;
                const lop = labelNode.getComponent(UIOpacity) ?? labelNode.addComponent(UIOpacity);
                lop.opacity = shouldActive ? 255 : 0;
                if (sn && displayCredit > 0) {
                    sn.setData(Math.max(0, displayCredit));
                }
            } else {
                labelNode.active = shouldActive;
                if (sn && (creditChanged || shouldActive)) {
                    sn.setData(Math.max(0, displayCredit));
                } else if (!sn && !quiet) {
                    Log.e(`[StickyOverlay] Missing SpriteNumber on ${slotNode.name}/CreditLabel`);
                }
            }
        } else if (!quiet) {
            Log.e(`[StickyOverlay] Missing CreditLabel on ${slotNode.name}`);
        }

        this._slotCreditMap.set(slotNode, Math.max(0, displayCredit));
    }

    /**
     * Map SymbolId → coinFrames index.
     * Gold/ps_45 = 0, Green/ps_44 = 1. Trả -1 nếu không map được.
     */
    private _symbolToFrameIndex(symbolId: number): number {
        switch (symbolId) {
            case SymbolId.STICKY_YELLOW: return 0;
            case SymbolId.STICKY_GREEN:  return 1;
            default:                     return -1;
        }
    }

    private _syncCoinFramesFromSlotMachine(): void {
        const frames = this.slotMachine?.symbolFrames;
        if (!frames?.length) return;
        const gold = frames[SymbolId.STICKY_YELLOW];
        const green = frames[SymbolId.STICKY_GREEN];
        if (gold) this.coinFrames[0] = gold;
        if (green) this.coinFrames[1] = green;
    }

    private _resolveCoinFrame(symbolId: number): SpriteFrame | null {
        const idx = this._symbolToFrameIndex(symbolId);
        const fromCoin = idx >= 0 ? this.coinFrames[idx] : null;
        if (fromCoin) return fromCoin;
        return this.slotMachine?.symbolFrames?.[symbolId] ?? null;
    }

    private _getBaseScale(symbolId: number): number {
        if (symbolId === SymbolId.STICKY_YELLOW) return TOPUP_YELLOW_COIN_SCALE;
        if (symbolId === SymbolId.STICKY_GREEN) return TOPUP_GREEN_COIN_SCALE;
        return 1;
    }

    private _applyBaseScale(slotNode: Node, symbolId: number): void {
        const scale = this._getBaseScale(symbolId);
        slotNode.setScale(scale, scale, 1);
    }

    /**
     * Canh tọa độ 15 coin slot khớp chính xác với 15 symbol trên reels.
     * Thứ tự: 0,1,2 = Top,Mid,Bot của Reel1; 3,4,5 = Reel2; ... 12,13,14 = Reel5.
     */
    alignCoinPositions(): void {
        if (!this.slotMachine) {
            Log.e('[StickyOverlay] alignCoinPositions: slotMachine chưa được gán.');
            return;
        }
        for (let reelIdx = 0; reelIdx < 5; reelIdx++) {
            const reel = this.slotMachine.reels[reelIdx];
            if (!reel) continue;

            const symbolNodeIndices = [1, 2, 3]; // Top, Mid, Bot
            for (let row = 0; row < this._rowCount; row++) {
                const coinIdx = this._cellIdx(reelIdx, row);
                const slotNode = this.coinSlots[coinIdx];
                if (!slotNode) continue;

                const symbolNode = reel.symbolNodes[symbolNodeIndices[row]];
                if (!symbolNode) continue;

                slotNode.setWorldPosition(symbolNode.worldPosition);
            }
        }
    }

    /**
     * Canh 15 coin slot theo 15 reel trong TopUpManager.
     * Mỗi reel TopUp là một ô (cell); node Mid (symbolNodes[1]) là tâm ô.
     * Giả định mảng coinSlots và TopUpManager.reels cùng thứ tự:
     *   index = reel * N + row  (row 0 = Bottom, 1 = Mid, 2 = Top visual).
     */
    alignPositionsFromTopUpManager(): void {
        const topUpMgr = this._getTopUpManager();
        if (!topUpMgr) {
            Log.e('[StickyOverlay] alignPositionsFromTopUpManager: TopUpManager not found.');
            return;
        }

        if (topUpMgr.reels.length !== topUpMgr.cellCount) {
            Log.w(`[StickyOverlay] alignPositionsFromTopUpManager: reels.length=${topUpMgr.reels.length} (expected cellCount).`);
        }

        const count = Math.min(topUpMgr.reels.length, this.coinSlots.length);
        for (let i = 0; i < count; i++) {
            this._alignSlotToTopUpCell(i, topUpMgr);
        }

        Log.d(`[StickyOverlay] alignPositionsFromTopUpManager — synced ${count} slots.`);
    }

    private _getTopUpManager(): TopUpManager | null {
        if (this._cachedTopUpMgr?.isValid) return this._cachedTopUpMgr;
        this._cachedTopUpMgr = this.node.getComponentInChildren(TopUpManager)
            ?? this.node.parent?.getComponentInChildren(TopUpManager)
            ?? this.node.scene?.getComponentInChildren(TopUpManager)
            ?? null;
        return this._cachedTopUpMgr;
    }

    /** Canh 1 coinSlot đúng world-pos tâm ô TopUpReel (Mid rest — không dùng mid.worldPosition stale). */
    private _alignSlotToTopUpCell(idx: number, topUpMgr?: TopUpManager | null): void {
        const mgr = topUpMgr ?? this._getTopUpManager();
        if (!mgr) return;
        const reel = mgr.reels[idx];
        const slotNode = this.coinSlots[idx];
        if (!reel || !slotNode) return;
        slotNode.setWorldPosition(reel.getMidRestWorldPosition());
    }

    /** Matsuri: Gold vừa seed/land — nhún giống TopUp sticky handoff. */
    private _playMatsuriGoldLandBounce(slotNode: Node, symbolId: number): void {
        this._playCoinBounce(slotNode, symbolId, false, true);
    }

    /** Matsuri seed: pop mượt 1 tween (backOut) — tránh 2 đoạn + stop tween gây giật. */
    private _playMatsuriGoldSeedPopIn(slotNode: Node, symbolId: number): void {
        const base = this._getBaseScale(symbolId);
        const dur = this.matsuriSeedPopDuration;
        Tween.stopAllByTarget(slotNode);
        slotNode.setScale(0.05, 0.05, 1);
        const op = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        op.opacity = 0;
        tween(op).to(dur * 0.45, { opacity: 255 }, { easing: 'sineOut' }).start();
        tween(slotNode)
            .to(dur, { scale: new Vec3(base, base, 1) }, { easing: 'backOut' })
            .call(() => {
                if (!slotNode?.isValid) return;
                slotNode.setScale(base, base, 1);
                if (op.isValid) op.opacity = 255;
            })
            .start();
    }

    /** Matsuri: Green vừa land — pop scale + hiện xanh; ẩn CreditLabel. */
    private _playMatsuriGreenLandOnly(slotNode: Node, idx: number): void {
        this._alignSlotToTopUpCell(idx);
        slotNode.setRotationFromEuler(0, 0, 0);
        this._setMatsuriCreditLabelVisible(slotNode, false);

        const base = this._getBaseScale(SymbolId.STICKY_GREEN);
        const startS = base * gridMiniGreenReelVisualScale();
        const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
        Tween.stopAllByTarget(slotNode);
        slotNode.setScale(startS, startS, 1);
        const op = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        op.opacity = 255;
        SoundManager.instance?.playSfxByName('sxBonusStickyGoldLand');
        tween(slotNode)
            .to(Math.max(0.08, 0.22 * m), { scale: new Vec3(base, base, 1) }, { easing: 'backOut' })
            .call(() => {
                if (slotNode?.isValid) slotNode.setScale(base, base, 1);
            })
            .start();
    }

    /**
     * Matsuri: squeeze flip Green → Gold (sau khi collect Gold xong).
     */
    private _playMatsuriGreenFlipToGold(
        slotNode: Node,
        key: string,
        idx: number,
        credit: number,
    ): void {
        this._matsuriFlippingKeys.add(key);
        this._matsuriPendingFlipKeys.delete(key);
        Tween.stopAllByTarget(slotNode);
        this._alignSlotToTopUpCell(idx);
        slotNode.setRotationFromEuler(0, 0, 0);
        // Pre-bake số lúc scale đầy đủ, ẩn opacity — hiện ngay khi đổi sprite Gold.
        this._setMatsuriCreditLabelVisible(slotNode, false, credit);

        const greenS = this._getBaseScale(SymbolId.STICKY_GREEN);
        const goldS = this._getBaseScale(MATSURI_GOLD_SYMBOL);
        const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
        const holdDur = 0.06 * m;
        const flipDur = 0.14 * m;

        SoundManager.instance?.playSfxByName('sxBonusStickyGoldLand');

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            this._matsuriFlippingKeys.delete(key);
            this._onOneMatsuriFlipDone();
        };
        const flipTimeout = () => {
            if (!this._matsuriFlippingKeys.has(key)) return;
            try {
                if (slotNode?.isValid) {
                    this._applyMatsuriFlipResult(slotNode, key, idx, credit);
                    slotNode.setScale(goldS, goldS, 1);
                }
            } catch {
                // failsafe only
            }
            finish();
        };
        this.scheduleOnce(flipTimeout, holdDur + flipDur * 2 + Math.max(0.25, 0.4 * m));

        slotNode.setScale(greenS, greenS, 1);
        tween(slotNode)
            .delay(holdDur)
            .to(flipDur, { scale: new Vec3(0.02, greenS, 1) }, { easing: 'sineIn' })
            .call(() => {
                if (!slotNode?.isValid) return;
                try {
                    const frame = this._resolveCoinFrame(MATSURI_GOLD_SYMBOL);
                    const sprite = slotNode.getComponent(Sprite);
                    if (sprite && frame) {
                        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
                        sprite.spriteFrame = frame;
                    }
                    this._setMatsuriCreditLabelVisible(slotNode, credit > 0);
                    slotNode.setScale(0.02, goldS, 1);
                } catch {
                    // flip mid failsafe
                }
            })
            .to(flipDur, { scale: new Vec3(goldS, goldS, 1) }, { easing: 'sineOut' })
            .call(() => {
                this.unschedule(flipTimeout);
                if (slotNode?.isValid) {
                    slotNode.setScale(goldS, goldS, 1);
                    this._applyMatsuriFlipResult(slotNode, key, idx, credit);
                    this._setMatsuriCreditLabelVisible(slotNode, credit > 0, credit);
                }
                finish();
            })
            .start();
    }

    /**
     * Cập nhật credit value cho slot sau khi absorb xong.
     * Giữ label active và cập nhật _slotCreditMap để _refreshAll sau không ẩn label.
     */
    setSlotCredit(slotNode: Node, credit: number): void {
        const safeCredit = Math.max(0, credit);
        this._slotCreditMap.set(slotNode, safeCredit);
        const cellKey = this._coinSlotKey(slotNode);
        const cell = cellKey ? GameData.instance.stickyCells.get(cellKey) : undefined;
        const symbolId = cell?.symbolId ?? SymbolId.STICKY_YELLOW;
        const { labelNode, sn } = this._resolveCreditLabel(slotNode);
        if (labelNode) {
            if (sn) {
                sn.setData(safeCredit);
            }
            labelNode.active = this._shouldShowCreditLabel(symbolId, safeCredit);
        }
    }

    /** Chờ land-bounce vàng/xanh hoàn tất để absorb không cắt tween giữa chừng. */
    async waitForGoldLandBounce(): Promise<void> {
        const remaining = Math.max(0, (this._goldLandBounceEndMs - Date.now()) / 1000);
        if (remaining <= 0) return;
        await new Promise<void>(resolve => this.scheduleOnce(resolve, remaining));
    }

    /** Map coin slot node → stickyCells key `${reel}-${row}`. */
    private _coinSlotKey(slotNode: Node): string | null {
        const idx = this.coinSlots.indexOf(slotNode);
        if (idx < 0) return null;
        const reel = Math.floor(idx / this._rowCount);
        const row = idx % this._rowCount;
        return `${reel}-${row}`;
    }

    /**
     * Bounce khi coin mới xuất hiện trên StickyOverlay.
     * Vàng/xanh land: giống sticky đỏ normal — grow + hold + shrink + nhảy Y,
     * bắt đầu từ TOPUP_STICKY_SYMBOL_SCALE (0.85), settle về base (1).
     * Reel Mid sticky giữ nguyên bên dưới.
     * @param isEnter       true = lần đầu vào TopUp (chậm + mượt hơn)
     * @param fromHandoff   true = land trong TopUp (nhún kiểu sticky đỏ)
     */
    private _playCoinBounce(
        slotNode: Node,
        symbolId: number,
        isEnter: boolean = false,
        fromHandoff: boolean = false,
    ): void {
        const baseScale = this._getBaseScale(symbolId);
        const isGoldCoin = symbolId === SymbolId.STICKY_YELLOW || symbolId === SymbolId.STICKY_GREEN;

        Tween.stopAllByTarget(slotNode);

        if ((GameData.instance.currentMode === 'respin' || GameData.instance.currentMode === 'matsuri') && isGoldCoin) {
            SoundManager.instance?.playSfxByName('sxBonusStickyGoldLand');
        }

        if (isGoldCoin && fromHandoff) {
            // Khớp SymbolView._playLandBounce (sticky đỏ normal)
            const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
            const startS = symbolId === SymbolId.STICKY_GREEN
                ? baseScale * gridMiniGreenReelVisualScale()
                : TOPUP_STICKY_SYMBOL_SCALE;
            const peakS = baseScale * 1.12;
            const growDur = 0.08 * m;
            const holdDur = 0.12 * m;
            const shrinkDur = 0.32 * m;
            const totalDur = growDur + holdDur + shrinkDur;
            const jumpY = 16;
            const basePos = slotNode.position.clone();
            const peakPos = new Vec3(basePos.x, basePos.y + jumpY, basePos.z);
            this._goldLandBounceEndMs = Math.max(
                this._goldLandBounceEndMs,
                Date.now() + totalDur * 1000,
            );
            slotNode.setScale(startS, startS, 1);
            tween(slotNode)
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
                    // Normalize tuyệt đối để không còn sai số vị trí/scale sau tween.
                    if (!slotNode?.isValid) return;
                    slotNode.setPosition(basePos);
                    slotNode.setScale(baseScale, baseScale, 1);
                })
                .start();
            return;
        }

        if (isGoldCoin) {
            // Enter / pop-in cũ: bắt đầu nhỏ → phóng → settle base
            const startS = baseScale * Math.max(0.05, this.goldCoinPopStartScale);
            const overshoot = Math.min(baseScale * this.goldCoinBounceOvershoot, 1);
            const upDur = this.goldCoinBounceUpDuration;
            const downDur = this.goldCoinBounceDownDuration;
            slotNode.setScale(startS, startS, 1);
            tween(slotNode)
                .to(upDur, { scale: new Vec3(overshoot, overshoot, 1) }, { easing: 'sineOut' })
                .to(downDur, { scale: new Vec3(baseScale, baseScale, 1) }, { easing: 'sineInOut' })
                .start();
            return;
        }

        // Đỏ / khác: bounce nhẹ quanh base
        const maxBounce = isEnter ? 1.1 : Math.min(this.coinBounceScale, 1.12);
        const bounceScale = baseScale * maxBounce;
        const upDur = isEnter ? this.coinEnterBounceUpDuration : 0.12;
        const downDur = isEnter ? this.coinEnterBounceDownDuration : 0.16;
        slotNode.setScale(baseScale, baseScale, 1);
        tween(slotNode)
            .to(upDur, { scale: new Vec3(bounceScale, bounceScale, 1) }, { easing: 'sineOut' })
            .to(downDur, { scale: new Vec3(baseScale, baseScale, 1) }, { easing: 'sineInOut' })
            .start();
    }

}
