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
    tween, Vec3, Tween, instantiate, Size,
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
import { TOPUP_STICKY_SYMBOL_SCALE } from './TopUpReelController';
import { TopUpTransitionPopup, TransitionMode } from './TopUpTransitionPopup';
import {
    MATSURI_COL_COUNT,
    MATSURI_GOLD_SYMBOL,
    MATSURI_MIN_ROWS,
    clampMatsuriRows,
    matsuriGridFitScale,
    matsuriGridFrameHeightMul,
    matsuriGridYOffset,
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
        tooltip: 'Coin sprite frames:\n[0]=Red  [1]=Yellow  [2]=Green\n(Grand có thể thêm vào [3] nếu có art)',
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

    /**
     * Wire SlotMachineController từ code (lazy-load Prefab không serialize cross-prefab refs).
     * Gọi trước khi active / trước TOPUP_START.
     */
    bindSlotMachine(smc: SlotMachineController | null): void {
        this.slotMachine = smc;
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

        this._applyCoin(slotNode, SymbolId.STICKY_GREEN, 0);
        slotNode.active = true;
        this._reparentToStickyOverlay(slotNode);
        this._alignSlotToTopUpCell(idx);

        const op = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        op.opacity = 255;

        this._matsuriPendingFlipKeys.add(key);
        this._previouslyActiveSlots.add(key);
        this._playMatsuriGreenLandOnly(slotNode, idx);
        Log.d(`[StickyOverlay] revealMatsuriGreenCoin ${key}`);
    }

    /** Thời lượng pop seed vàng (giây) — MatsuriEffect chờ trước orb kế / highlight. */
    get matsuriSeedPopDuration(): number {
        return 0.22;
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

    /** Baseline layout (prefab 5×3) — capture 1 lần trước khi fit. */
    private _baseRootPos: Vec3 | null = null;
    private _frameBaseSizes: Map<Node, Size> = new Map();
    private _frameBasePos: Map<Node, Vec3> = new Map();
    private _frameNodes: Node[] = [];
    private _maskResizeNodes: Node[] = [];

    get rowCount(): number { return this._rowCount; }

    /** Public: vị trí coin slot theo reel/row (Matsuri collect fly). */
    getCoinSlot(reel: number, row: number): Node | null {
        const idx = this._cellIdx(reel, row);
        return this.coinSlots[idx] ?? null;
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
     *  - Expand height FillBlackFrame / Array mask
     *  - Canh tâm frame/mask theo tâm grid reel active (tránh lệch khi thêm hàng dưới)
     *  - Scale root xuống + đẩy Y viewport
     */
    private _applyGridFitScale(rows: number): void {
        this._ensureLayoutBaselines();
        const r = clampMatsuriRows(rows);
        const s = matsuriGridFitScale(r);
        const hMul = matsuriGridFrameHeightMul(r);
        const yOff = matsuriGridYOffset(r);

        this._resizeAndCenterFramesOnGrid(r, hMul);

        this.node.setScale(s, s, 1);
        if (this._baseRootPos) {
            this.node.setPosition(
                this._baseRootPos.x,
                this._baseRootPos.y + yOff,
                this._baseRootPos.z,
            );
        }

        this.alignPositionsFromTopUpManager();
        Log.d(
            `[StickyOverlay] grid fit 5×${r} scale=${s.toFixed(3)} hMul=${hMul.toFixed(3)} yOff=${yOff}`,
        );
    }

    /**
     * Pool active = row 0..N-1 (TOP xuống). Khi tăng height với anchor 0.5,
     * phải dịch Y xuống để tâm frame/mask = tâm grid active (không giữ tâm 5×3).
     */
    private _resizeAndCenterFramesOnGrid(rows: number, hMul: number): void {
        const centerY = this._activeGridCenterLocalY(rows);
        const nodes = [...this._frameNodes, ...this._maskResizeNodes];

        for (const n of nodes) {
            const base = this._frameBaseSizes.get(n);
            const basePos = this._frameBasePos.get(n);
            const ut = n.getComponent(UITransform);
            if (!base || !basePos || !ut) continue;

            ut.setContentSize(base.width, base.height * hMul);

            if (centerY != null) {
                n.setPosition(basePos.x, centerY, basePos.z);
            } else {
                // Fallback: giữ mép trên 5×3, bung chiều cao xuống dưới
                const dy = -base.height * (hMul - 1) * 0.5;
                n.setPosition(basePos.x, basePos.y + dy, basePos.z);
            }
        }
    }

    /** Tâm Y local (StickyOverlay) của các reel đang active. */
    private _activeGridCenterLocalY(rows: number): number | null {
        const mgr = this.node.getComponentInChildren(TopUpManager);
        if (!mgr?.reels?.length) return null;

        const r = clampMatsuriRows(rows);
        const topReel = mgr.reels[0];
        const botReel = mgr.reels[r - 1];
        if (!topReel || !botReel) return null;

        const rootUT = this.node.getComponent(UITransform);
        if (!rootUT) return null;

        const topL = rootUT.convertToNodeSpaceAR(topReel.getMidRestWorldPosition());
        const botL = rootUT.convertToNodeSpaceAR(botReel.getMidRestWorldPosition());
        return (topL.y + botL.y) * 0.5;
    }

    private _ensureLayoutBaselines(): void {
        if (!this._baseRootPos) {
            this._baseRootPos = this.node.position.clone();
        }
        if (this._frameNodes.length > 0) return;

        const capture = (n: Node | null) => {
            if (!n) return null;
            const ut = n.getComponent(UITransform);
            if (!ut) return null;
            this._frameBaseSizes.set(n, new Size(ut.contentSize.width, ut.contentSize.height));
            this._frameBasePos.set(n, n.position.clone());
            return n;
        };

        for (const name of ['FillBlackFrame-001', 'FillBlackFrame']) {
            const n = capture(this.node.getChildByName(name));
            if (n) this._frameNodes.push(n);
        }

        const arrayNode = capture(this.node.getChildByName('Array'));
        if (arrayNode) this._maskResizeNodes.push(arrayNode);
    }

    private _resetGridFitLayout(): void {
        this.node.setScale(1, 1, 1);
        if (this._baseRootPos) {
            this.node.setPosition(this._baseRootPos);
        }
        for (const [n, base] of this._frameBaseSizes) {
            const ut = n.getComponent(UITransform);
            if (ut) ut.setContentSize(base.width, base.height);
            const pos = this._frameBasePos.get(n);
            if (pos) n.setPosition(pos);
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

        EventBus.instance.on(GameEvents.TOPUP_TRANSITION_SHOW, this._onTransitionShow, this);
        EventBus.instance.on(GameEvents.TOPUP_TRANSITION_READY, this._onTransitionReady, this);
        EventBus.instance.on(GameEvents.TOPUP_TRANSITION_DONE, this._onTransitionDone, this);
        EventBus.instance.on(GameEvents.TOPUP_START,         this._onTopUpStart,   this);
        EventBus.instance.on(GameEvents.TOPUP_TOTAL_UPDATED, this._onTopUpUpdated, this);
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
                this._refreshAll(false, false);
                Log.d(`[StickyOverlay] Matsuri resume — show ${GameData.instance.stickyCells.size} stickies`);
                return;
            }
            // Enter mới: grid trống — Start Gold chỉ hiện khi seed orb land
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

    private _onTopUpUpdated(): void {
        // Seed Matsuri tự reveal từng coin — bỏ full refresh (rất nặng / gây giật)
        if (
            GameData.instance.currentMode === 'matsuri'
            && this._matsuriDeferGoldLandBounce
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
        // Reset scale / frame / Y về baseline 5×3
        this._resetGridFitLayout();
        this._rowCount = MATSURI_MIN_ROWS;
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

    /** Collect Gold xong → flip mọi Green đang pending. */
    private _onMatsuriCollectDone(): void {
        if (GameData.instance.currentMode !== 'matsuri') {
            EventBus.instance.emit(GameEvents.MATSURI_FLIP_DONE);
            return;
        }

        const keys = [...this._matsuriPendingFlipKeys];
        this._matsuriPendingFlipKeys.clear();

        if (keys.length === 0) {
            // Có thể Green chưa kịp refresh — quét stickyCells
            for (const [key, cell] of GameData.instance.stickyCells) {
                if (cell.symbolId === SymbolId.STICKY_GREEN) keys.push(key);
            }
        }

        if (keys.length === 0) {
            Log.e('[StickyOverlay] MATSURI_COLLECT_DONE — no Green to flip');
            EventBus.instance.emit(GameEvents.MATSURI_FLIP_DONE);
            return;
        }

        this._matsuriFlipDonePending = keys.length;
        Log.e(`[StickyOverlay] flip ${keys.length} Green→Gold after collect`);

        for (const key of keys) {
            const [reelStr, rowStr] = key.split('-');
            const reel = parseInt(reelStr, 10);
            const row = parseInt(rowStr, 10);
            const idx = this._cellIdx(reel, row);
            const slotNode = this.coinSlots[idx];
            const cell = GameData.instance.stickyCells.get(key);
            if (!slotNode || !cell) {
                this._onOneMatsuriFlipDone();
                continue;
            }
            // Green trước flip: ẩn CreditLabel; credit thật áp khi lật ra Gold
            this._applyCoin(slotNode, SymbolId.STICKY_GREEN, 0);
            slotNode.active = true;
            this._playMatsuriGreenFlipToGold(slotNode, key, idx, cell.credit ?? 0);
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

        // ═══ TOPUP OVERLAY DEBUG ═══
        Log.e(`[SOC-DEBUG] _refreshAll(fadeOnlyNew=${fadeOnlyNew}, animate=${animate}) — stickyCells.size=${cells.size} coinSlots.length=${this.coinSlots.length} node.active=${this.node.active}`);
        Log.e(`[SOC-DEBUG] stickyCells: ${cells.size === 0 ? '(empty)' : Array.from(cells.entries()).map(([k, c]) => `${k}=${c.symbolId === SymbolId.STICKY_YELLOW ? 'YELLOW' : c.symbolId === SymbolId.STICKY_GREEN ? 'GREEN' : c.symbolId}($${c.credit})`).join(', ')}`);
        // ═══ END DEBUG ═══

        const isEnter = this._isEnteringTopUp;

        for (let reel = 0; reel < 5; reel++) {
            for (let row = 0; row < this._rowCount; row++) {
                const key      = `${reel}-${row}`;
                const idx      = this._cellIdx(reel, row);
                const slotNode = this.coinSlots[idx];
                if (!slotNode) continue;

                const cell = cells.get(key);

                if (!cell) {
                    if (idx < 3) {
                        Log.e(`[TOPUP-ENTER-CHECK][OVERLAY] idx=${idx} node=${slotNode.name} key=${key} cell=empty activeBefore=${slotNode.active}`);
                    }
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
                        const gOp = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
                        gOp.opacity = 255;
                    }
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
                if (idx < 3) {
                    Log.e(
                        `[TOPUP-ENTER-CHECK][OVERLAY] idx=${idx} node=${slotNode.name} key=${key}` +
                        ` sym=${SymbolId[cell.symbolId] ?? cell.symbolId} credit=${cell.credit ?? 0}` +
                        ` fadeOnlyNew=${fadeOnlyNew} isNew=${isNewCoin}`
                    );
                }
                Log.e(`[SOC-DEBUG]   slot[${key}] idx=${idx} isNew=${isNewCoin} absorb=${isAbsorbTarget} sym=${cell.symbolId} credit=${cell.credit} showCredit=${creditToShow}`);

                // Áp dụng sprite + credit
                // Align chỉ coin MỚI (tránh refresh sau land canh lại giữa bounce → lệch Y)
                this._applyCoin(slotNode, cell.symbolId, creditToShow);
                slotNode.active = true;
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

        const prevSize = this._previouslyActiveSlots.size;
        // Update previous active slots for next refresh
        this._previouslyActiveSlots = newActiveSlots;

        Log.e(`[SOC-DEBUG] refreshAll DONE — activeSlots=${newActiveSlots.size} prevSlots=${prevSize} cells rendered on overlay`);
        Log.d(`[StickyOverlay] refreshAll(fadeOnlyNew=${fadeOnlyNew}, animate=${animate}) — stickyCells=${cells.size}/15`);
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

        // ── Sprite ──
        const frameIdx = this._symbolToFrameIndex(symbolId);
        const sprite   = slotNode.getComponent(Sprite);
        if (sprite && frameIdx >= 0 && this.coinFrames[frameIdx]) {
            sprite.spriteFrame = this.coinFrames[frameIdx];
        }

        // ★ Giữ nguyên scale cho coin đã có (existing) — new coin set base scale qua _playCoinBounce.

        // ── Credit label (SpriteNumber trên child "CreditLabel") ──
        // Matsuri Green: ẩn đến khi flip Gold. Yellow/Green TopUp: credit > 0.
        const displayCredit = credit > 0 ? credit : safeLastCredit;
        const shouldActive  = this._shouldShowCreditLabel(symbolId, displayCredit);
        const { labelNode, sn } = this._resolveCreditLabel(slotNode);
        if (labelNode) {
            if (sn) {
                if (creditChanged || shouldActive) {
                    if (!quiet) Log.d(`[STICKY-LABEL] _applyCoin ${slotNode.name} setData(${displayCredit})`);
                    sn.setData(Math.max(0, displayCredit));
                }
            } else if (!quiet) {
                Log.e(`[StickyOverlay] Missing SpriteNumber on ${slotNode.name}/CreditLabel`);
            }
            if (creditChanged) {
                labelNode.setRotationFromEuler(0, 0, 0);
            }
            labelNode.active = shouldActive;
        } else if (!quiet) {
            Log.e(`[StickyOverlay] Missing CreditLabel on ${slotNode.name}`);
        }

        this._slotCreditMap.set(slotNode, Math.max(0, displayCredit));
    }

    /**
     * Map SymbolId → coinFrames index.
     * YELLOW=0, GREEN=1. Trả -1 nếu không map được.
     */
    private _symbolToFrameIndex(symbolId: number): number {
        switch (symbolId) {
            case SymbolId.STICKY_YELLOW: return 0;
            case SymbolId.STICKY_GREEN:  return 1;
            default:                     return -1;
        }
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
        const { labelNode } = this._resolveCreditLabel(slotNode);
        if (labelNode) labelNode.active = false;

        const base = this._getBaseScale(SymbolId.STICKY_GREEN);
        Tween.stopAllByTarget(slotNode);
        slotNode.setScale(0.05, 0.05, 1);
        const op = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        op.opacity = 0;
        SoundManager.instance?.playSfxByName('sxBonusStickyGoldLand');
        tween(op).to(0.1, { opacity: 255 }, { easing: 'sineOut' }).start();
        tween(slotNode)
            .to(0.22, { scale: new Vec3(base, base, 1) }, { easing: 'backOut' })
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

        const greenS = this._getBaseScale(SymbolId.STICKY_GREEN);
        const goldS = this._getBaseScale(MATSURI_GOLD_SYMBOL);
        const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
        const holdDur = 0.06 * m;
        const flipDur = 0.14 * m;

        SoundManager.instance?.playSfxByName('sxBonusStickyGoldLand');

        slotNode.setScale(greenS, greenS, 1);
        tween(slotNode)
            .delay(holdDur)
            .to(flipDur, { scale: new Vec3(0.02, greenS, 1) }, { easing: 'sineIn' })
            .call(() => {
                if (!slotNode?.isValid) {
                    this._onOneMatsuriFlipDone();
                    return;
                }
                this._applyCoin(slotNode, MATSURI_GOLD_SYMBOL, credit);
                const cell = GameData.instance.stickyCells.get(key);
                if (cell) {
                    cell.symbolId = MATSURI_GOLD_SYMBOL;
                    GameData.instance.stickyCells.set(key, { ...cell });
                }
                this._alignSlotToTopUpCell(idx);
                slotNode.setScale(0.02, goldS, 1);
            })
            .to(flipDur, { scale: new Vec3(goldS, goldS, 1) }, { easing: 'sineOut' })
            .call(() => {
                if (slotNode?.isValid) {
                    this._alignSlotToTopUpCell(idx);
                    slotNode.setScale(goldS, goldS, 1);
                    slotNode.setRotationFromEuler(0, 0, 0);
                }
                this._matsuriFlippingKeys.delete(key);
                this._onOneMatsuriFlipDone();
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
            const startS = TOPUP_STICKY_SYMBOL_SCALE;
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
