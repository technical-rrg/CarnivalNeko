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
    tween, Vec3, Tween, instantiate, Layout, screen, view, Widget, sp, ParticleSystem,
} from 'cc';
import { EventBus }     from '../core/EventBus';
import { GameEvents }   from '../core/GameEvents';
import { LanguageChange } from '../core/LanguageChange';
import { RichTextShrink } from '../core/RichTextShrink';
import { GameData }     from '../data/GameData';
import { SymbolId }     from '../data/SlotTypes';
import { SpriteNumber } from '../core/SpriteNumber';
import { Log }          from '../core/Logger';
import { SoundManager } from '../manager/SoundManager';
import { AutoSpinManager, SpeedMode } from '../manager/AutoSpinManager';
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
    MATSURI_CELL_SIZE_LARGE,
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

/** Spine VFX đồng vàng — land từ quả cầu seed / nhún trước collect. */
const GOLD_COIN_SPINE_IMPACT = 'Coin_Impact';
const GOLD_COIN_SPINE_IMPACT2 = 'Coin_Impact2';

/** Spine VFX đồng xanh Matsuri — land / loop collect / flip sang vàng. */
const GREEN_COIN_SPINE_IMPACT = 'Coin_Impact';
const GREEN_COIN_SPINE_ANIM_LOOP = 'Coin_Anim_Loop';
const GREEN_COIN_SPINE_TRANSITION_GOLD = 'Transition_GoldCoin';

/** Cat Spine — ném quả cầu seed Matsuri. */
const SEED_CAT_SPINE_RISEUP = 'riseup';
const SEED_CAT_SPINE_BONUS = 'bonus';

/** Pos/scale prefab lúc ngang — luôn restore, không capture runtime. */
const LANDSCAPE_POS_X = 0;
const LANDSCAPE_POS_Y = -26;
const LANDSCAPE_SCALE_X = 1;
const LANDSCAPE_SCALE_Y = 1;

/** FramFront/Top/Frame2/Note — RichText max width (px). */
const GRAND_JACKPOT_NOTE_WIDTH = 650;
const GRAND_JACKPOT_NOTE_FONT = 30;
const GRAND_JACKPOT_NOTE_MIN_FONT = 14;

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
        type: Node,
        tooltip:
            'Template FX (inactive) tại CollectTotal — clone từ pool, trả pool sau khi play.',
    })
    collectFlyHitFx: Node | null = null;

    @property({
        tooltip: 'Tên anim Spine trên collectFlyHitFx (trống = anim đầu tiên trong skeleton).',
    })
    collectFlyHitFxAnim: string = '';

    @property({
        tooltip:
            'Cứ N lần clone vàng chạm CollectTotal mới spawn 1 hit FX (mặc định 2).\n' +
            'Đồng đầu tiên mỗi lượt collect luôn play FX.',
    })
    collectFlyHitFxEveryHits: number = 2;

    @property({
        tooltip: 'Số node tối đa giữ trong pool collect hit FX (dư sẽ destroy khi trả).',
    })
    collectFlyHitFxPoolMax: number = 8;

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
        tooltip: 'Cat Spine — hiện khi ném quả cầu seed (MATSURI_SEED_START → DONE).\n' +
            'riseup → bonus từng vòng; mỗi vòng bonus xong bắn 1 quả cầu; hết cầu thì dừng anim.',
    })
    seedThrowCatNode: Node | null = null;

    @property({
        type: Node,
        tooltip: 'FramFront/Top — HUD remain + collect; ẩn lúc seed, hiện khi vào feature. Gán từ Editor.',
    })
    featureFrameTopNode: Node | null = null;

    @property({
        type: Node,
        tooltip:
            'Template Spine VFX đồng vàng (inactive). Clone thành child của coin:\n' +
            'Coin_Impact = play ngay khi quả cầu land\n' +
            'Coin_Impact2 = nhún lần lượt trước khi bắn tiền\n' +
            'CreditLabel luôn sibling trên Spine.',
    })
    goldCoinSpineTemplate: Node | null = null;

    @property({
        group: { name: 'Gold Coin Spine FX', id: 'gcss' },
        tooltip: 'Scale Spine trên grid 5×3 (đồng to hơn). 1 = giữ scale template.',
    })
    goldCoinSpineScale5x3: number = 1;

    @property({
        group: { name: 'Gold Coin Spine FX', id: 'gcss' },
        tooltip: 'Local pos X Spine đồng vàng trên grid 5×3.',
    })
    goldCoinSpineOffsetX5x3: number = 0;

    @property({
        group: { name: 'Gold Coin Spine FX', id: 'gcss' },
        tooltip: 'Local pos Y Spine đồng vàng trên grid 5×3.',
    })
    goldCoinSpineOffsetY5x3: number = 0;

    @property({
        group: { name: 'Gold Coin Spine FX', id: 'gcss' },
        tooltip: 'Scale Spine trên grid 5×4.',
    })
    goldCoinSpineScale5x4: number = 1;

    @property({
        group: { name: 'Gold Coin Spine FX', id: 'gcss' },
        tooltip: 'Local pos X Spine đồng vàng trên grid 5×4.',
    })
    goldCoinSpineOffsetX5x4: number = 0;

    @property({
        group: { name: 'Gold Coin Spine FX', id: 'gcss' },
        tooltip: 'Local pos Y Spine đồng vàng trên grid 5×4.',
    })
    goldCoinSpineOffsetY5x4: number = 0;

    @property({
        group: { name: 'Gold Coin Spine FX', id: 'gcss' },
        tooltip: 'Scale Spine trên grid 5×5.',
    })
    goldCoinSpineScale5x5: number = 1;

    @property({
        group: { name: 'Gold Coin Spine FX', id: 'gcss' },
        tooltip: 'Local pos X Spine đồng vàng trên grid 5×5.',
    })
    goldCoinSpineOffsetX5x5: number = 0;

    @property({
        group: { name: 'Gold Coin Spine FX', id: 'gcss' },
        tooltip: 'Local pos Y Spine đồng vàng trên grid 5×5.',
    })
    goldCoinSpineOffsetY5x5: number = 0;

    @property({
        type: Node,
        tooltip:
            'Template Spine VFX đồng xanh (inactive). Clone thành child của coin:\n' +
            'Coin_Impact = vừa land\n' +
            'Coin_Anim_Loop = khi đồng vàng đang phóng tiền\n' +
            'Transition_GoldCoin = lật xanh → vàng (thay tween squeeze)\n' +
            'CreditLabel luôn sibling trên Spine.',
    })
    greenCoinSpineTemplate: Node | null = null;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Scale Spine đồng xanh trên grid 5×3.',
    })
    greenCoinSpineScale5x3: number = 1;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Local pos X Spine đồng xanh trên grid 5×3.',
    })
    greenCoinSpineOffsetX5x3: number = 0;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Local pos Y Spine đồng xanh trên grid 5×3.',
    })
    greenCoinSpineOffsetY5x3: number = 0;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Scale Spine đồng xanh trên grid 5×4.',
    })
    greenCoinSpineScale5x4: number = 1;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Local pos X Spine đồng xanh trên grid 5×4.',
    })
    greenCoinSpineOffsetX5x4: number = 0;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Local pos Y Spine đồng xanh trên grid 5×4.',
    })
    greenCoinSpineOffsetY5x4: number = 0;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Scale Spine đồng xanh trên grid 5×5.',
    })
    greenCoinSpineScale5x5: number = 1;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Local pos X Spine đồng xanh trên grid 5×5.',
    })
    greenCoinSpineOffsetX5x5: number = 0;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Local pos Y Spine đồng xanh trên grid 5×5.',
    })
    greenCoinSpineOffsetY5x5: number = 0;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Hiện CreditLabel sớm hơn bao nhiêu giây trước khi Transition_GoldCoin kết thúc (Normal speed).',
    })
    greenFlipCreditRevealLead: number = 0.28;

    @property({
        group: { name: 'Green Coin Spine FX', id: 'gcss2' },
        tooltip: 'Sau khi Credit hiện, bao lâu thì cắt Transition_GoldCoin và chuyển sang Gold (giây, Normal).',
    })
    greenFlipFxCutAfterCredit: number = 0.2;

    @property({
        group: { name: 'Seed Throw Cat', id: 'stc' },
        tooltip: 'Tốc độ Spine Cat (1 = bình thường, 2 = nhanh gấp 2). Quick/Turbo nhân thêm.',
    })
    seedCatSpineTimeScale: number = 2;

    @property({
        group: { name: 'Seed Throw Cat', id: 'stc' },
        tooltip: 'Bắn quả cầu sớm hơn bao nhiêu giây trước khi 1 vòng bonus kết thúc (Normal).',
    })
    seedCatBonusOrbFireLead: number = 0.18;

    // ── Portrait root transform (màn dọc) — ngang dùng scale/pos mặc định prefab ──

    @property({ group: { name: 'Portrait 5x3', id: 'p53' }, tooltip: 'Pos X — màn dọc grid 5×3' })
    portrait5x3PosX: number = 0;

    @property({ group: { name: 'Portrait 5x3', id: 'p53' }, tooltip: 'Pos Y — màn dọc grid 5×3' })
    portrait5x3PosY: number = -69.443;

    @property({ group: { name: 'Portrait 5x3', id: 'p53' }, tooltip: 'Scale X — màn dọc grid 5×3' })
    portrait5x3ScaleX: number = 1;

    @property({ group: { name: 'Portrait 5x3', id: 'p53' }, tooltip: 'Scale Y — màn dọc grid 5×3' })
    portrait5x3ScaleY: number = 1;

    @property({ group: { name: 'Portrait 5x4', id: 'p54' }, tooltip: 'Pos X — màn dọc grid 5×4' })
    portrait5x4PosX: number = 0;

    @property({ group: { name: 'Portrait 5x4', id: 'p54' }, tooltip: 'Pos Y — màn dọc grid 5×4' })
    portrait5x4PosY: number = -69.443;

    @property({ group: { name: 'Portrait 5x4', id: 'p54' }, tooltip: 'Scale X — màn dọc grid 5×4' })
    portrait5x4ScaleX: number = 1;

    @property({ group: { name: 'Portrait 5x4', id: 'p54' }, tooltip: 'Scale Y — màn dọc grid 5×4' })
    portrait5x4ScaleY: number = 1;

    @property({ group: { name: 'Portrait 5x5', id: 'p55' }, tooltip: 'Pos X — màn dọc grid 5×5' })
    portrait5x5PosX: number = 0;

    @property({ group: { name: 'Portrait 5x5', id: 'p55' }, tooltip: 'Pos Y — màn dọc grid 5×5' })
    portrait5x5PosY: number = -69.443;

    @property({ group: { name: 'Portrait 5x5', id: 'p55' }, tooltip: 'Scale X — màn dọc grid 5×5' })
    portrait5x5ScaleX: number = 1;

    @property({ group: { name: 'Portrait 5x5', id: 'p55' }, tooltip: 'Scale Y — màn dọc grid 5×5' })
    portrait5x5ScaleY: number = 1;

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
    /** Green đang tới lượt (sequential) — COLLECT_DONE chỉ flip key này. */
    private _matsuriNextFlipKey: string | null = null;
    /**
     * Matsuri seed: hiện Gold tĩnh khi orb land (không nhún từng cái).
     * MatsuriEffect sẽ nhún lần lượt sau khi bắn xong hết.
     */
    private _matsuriDeferGoldLandBounce = false;
    /** Cache TopUpManager — tránh getComponentInChildren mỗi lần align/reveal. */
    private _cachedTopUpMgr: TopUpManager | null = null;
    /** Clone Spine VFX đồng vàng đang chạy — dọn khi feature kết thúc. */
    private _activeGoldSpineFx: Node[] = [];
    /** Coin_Impact2 loop — giữ đến khi clone bay tiền của ô đó. */
    private _goldImpact2FxBySlot: Map<Node, Node> = new Map();
    /** Clone Spine VFX đồng xanh đang chạy — dọn khi feature kết thúc. */
    private _activeGreenSpineFx: Node[] = [];
    /** Coin_Anim_Loop — giữ khi đồng vàng đang phóng tiền. */
    private _greenAnimLoopFxBySlot: Map<Node, Node> = new Map();
    /** Collect hit FX — pool clone từ template, trả pool sau khi play xong. */
    private _collectFlyHitFxHitCount = 0;
    private _collectFlyHitFxPool: Node[] = [];
    private _collectFlyHitFxPoolSeq = 0;
    private _activeCollectFlyHitFx: Node[] = [];
    private _collectFlyHitFxReturnTimers: Map<Node, () => void> = new Map();

    /** Bật khi đang seed — Gold pop-in nhẹ, bỏ full refresh trên TOPUP_TOTAL. */
    setMatsuriDeferGoldLandBounce(defer: boolean): void {
        this._matsuriDeferGoldLandBounce = defer;
    }

    /** Sequential collect: COLLECT_DONE chỉ flip Green này. */
    setMatsuriNextFlipKey(key: string | null): void {
        this._matsuriNextFlipKey = key && key.length > 0 ? key : null;
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
        const spineDur = this._getGoldCoinSpineAnimDuration(GOLD_COIN_SPINE_IMPACT);
        const base = spineDur > 0 ? spineDur : 0.22;
        return Math.max(0.08, base * m);
    }

    /** Matsuri seed: quả cầu land → Coin_Impact tại coin slot. */
    playGoldCoinImpactAtSlot(slotNode: Node): Promise<void> {
        return this._playGoldCoinSpineFx(slotNode, GOLD_COIN_SPINE_IMPACT);
    }

    /** Matsuri collect: Coin_Impact2 loop — giữ sáng đến khi bay tiền. */
    playGoldCoinImpact2AtSlot(slotNode: Node): Promise<void> {
        return this._startGoldCoinImpact2Loop(slotNode);
    }

    /** Ẩn Coin_Impact2 khi clone tiền của ô này bắt đầu bay. */
    clearGoldCoinImpact2AtSlot(slotNode: Node): void {
        if (!slotNode?.isValid) return;
        const fx = this._goldImpact2FxBySlot.get(slotNode);
        if (!fx?.isValid) {
            this._goldImpact2FxBySlot.delete(slotNode);
            return;
        }
        this._goldImpact2FxBySlot.delete(slotNode);
        this._destroyGoldSpineFx(fx);
    }

    /**
     * Gọi khi clone vàng THẬT SỰ chạm CollectTotal.
     * Đồng đầu mỗi lượt collect luôn play; sau đó cứ N lần chạm → borrow pool → trả pool.
     */
    playCollectFlyHitFx(): void {
        this._collectFlyHitFxHitCount++;
        const every = Math.max(1, Math.floor(this.collectFlyHitFxEveryHits));
        if (this._collectFlyHitFxHitCount < every) return;
        this._collectFlyHitFxHitCount = 0;

        const tmpl = this.collectFlyHitFx;
        if (!tmpl?.isValid) return;
        tmpl.active = false;

        const fx = this._borrowCollectFlyHitFx(tmpl);
        if (!fx) return;

        const stale = this._collectFlyHitFxReturnTimers.get(fx);
        if (stale) {
            this.unschedule(stale);
            this._collectFlyHitFxReturnTimers.delete(fx);
        }

        this._haltCollectFlyHitFxNode(fx);
        fx.setParent(tmpl.parent);
        fx.setPosition(tmpl.position);
        fx.setRotation(tmpl.rotation);
        fx.setScale(tmpl.scale);
        fx.setSiblingIndex(tmpl.getSiblingIndex());
        fx.active = true;
        this._activeCollectFlyHitFx.push(fx);

        this.scheduleOnce(() => {
            if (!fx?.isValid) return;
            this._playCollectFlyHitFxOnNode(fx);
        }, 0);

        const returnDelay = Math.min(1.2, this._getCollectFlyHitFxDuration(fx) + 0.12);
        const returnCb = () => {
            this._collectFlyHitFxReturnTimers.delete(fx);
            this._returnCollectFlyHitFxClone(fx);
        };
        this._collectFlyHitFxReturnTimers.set(fx, returnCb);
        this.scheduleOnce(returnCb, returnDelay);
    }

    private _borrowCollectFlyHitFx(tmpl: Node): Node | null {
        while (this._collectFlyHitFxPool.length > 0) {
            const n = this._collectFlyHitFxPool.pop()!;
            if (n?.isValid) return n;
        }
        const fx = instantiate(tmpl);
        fx.name = `${tmpl.name}_pooled_${this._collectFlyHitFxPoolSeq++}`;
        fx.active = false;
        return fx;
    }

    private _haltCollectFlyHitFxNode(fx: Node): void {
        if (!fx?.isValid) return;
        Tween.stopAllByTarget(fx);
        for (const child of fx.children) {
            Tween.stopAllByTarget(child);
        }
        for (const ps of fx.getComponentsInChildren(ParticleSystem)) {
            ps.stop();
            ps.clear();
            ps.enabled = false;
        }
        for (const skel of fx.getComponentsInChildren(sp.Skeleton)) {
            skel.setCompleteListener(null);
            skel.clearTracks();
            skel.setToSetupPose();
        }
    }

    private _returnCollectFlyHitFxClone(fx: Node): void {
        if (!fx?.isValid) {
            const idxDead = this._activeCollectFlyHitFx.indexOf(fx);
            if (idxDead >= 0) this._activeCollectFlyHitFx.splice(idxDead, 1);
            this._collectFlyHitFxReturnTimers.delete(fx);
            return;
        }

        const pending = this._collectFlyHitFxReturnTimers.get(fx);
        if (pending) {
            this.unschedule(pending);
            this._collectFlyHitFxReturnTimers.delete(fx);
        }

        this._haltCollectFlyHitFxNode(fx);
        fx.active = false;

        const idx = this._activeCollectFlyHitFx.indexOf(fx);
        if (idx >= 0) this._activeCollectFlyHitFx.splice(idx, 1);
        this._pushCollectFlyHitFxToPool(fx);
    }

    private _playCollectFlyHitFxOnNode(fx: Node): void {
        SoundManager.instance?.playSfxByName('sxYellowcoinHit');
        for (const ps of fx.getComponentsInChildren(ParticleSystem)) {
            ps.enabled = true;
            ps.stop();
            ps.clear();
            ps.loop = false;
            ps.play();
        }

        const skel = fx.getComponent(sp.Skeleton) ?? fx.getComponentInChildren(sp.Skeleton);
        if (!skel?.isValid) return;

        const named = this.collectFlyHitFxAnim.trim();
        let anim = named;
        if (!anim) {
            try {
                anim = skel.skeletonData?.getRuntimeData()?.animations?.[0]?.name ?? '';
            } catch {
                anim = '';
            }
        }
        if (!anim) return;

        try {
            skel.setCompleteListener(null);
            skel.clearTracks();
            skel.setAnimation(0, anim, false);
        } catch {
            // ignore missing anim
        }
    }

    private _getCollectFlyHitFxDuration(fx: Node): number {
        let maxDur = 0.45;
        for (const ps of fx.getComponentsInChildren(ParticleSystem)) {
            const emitDur = ps.duration > 0 ? ps.duration : 0.45;
            const startLife = ps.startLifetime?.constant ?? 0;
            maxDur = Math.max(maxDur, emitDur + startLife + 0.1);
        }
        const skel = fx.getComponent(sp.Skeleton) ?? fx.getComponentInChildren(sp.Skeleton);
        if (skel?.isValid && skel.skeletonData) {
            const named = this.collectFlyHitFxAnim.trim();
            try {
                const runtime = skel.skeletonData.getRuntimeData();
                const animName = named || runtime?.animations?.[0]?.name;
                const anim = animName ? runtime?.findAnimation(animName) : null;
                if (anim?.duration) maxDur = Math.max(maxDur, anim.duration);
            } catch {
                // ignore
            }
        }
        return Math.min(maxDur, 1.0);
    }

    /** Prime counter — lần chạm tiếp theo luôn spawn FX (đồng đầu mỗi lượt collect). */
    private _primeCollectFlyHitFxForRound(): void {
        const every = Math.max(1, Math.floor(this.collectFlyHitFxEveryHits));
        this._collectFlyHitFxHitCount = every - 1;
    }

    private _cleanupCollectFlyHitFx(drainAll = false): void {
        for (const cb of this._collectFlyHitFxReturnTimers.values()) {
            this.unschedule(cb);
        }
        this._collectFlyHitFxReturnTimers.clear();
        this._collectFlyHitFxHitCount = 0;

        for (const fx of this._activeCollectFlyHitFx.slice()) {
            if (!fx?.isValid) continue;
            this._haltCollectFlyHitFxNode(fx);
            fx.active = false;
            const idx = this._activeCollectFlyHitFx.indexOf(fx);
            if (idx >= 0) this._activeCollectFlyHitFx.splice(idx, 1);
            if (drainAll) {
                fx.destroy();
            } else {
                this._pushCollectFlyHitFxToPool(fx);
            }
        }

        if (drainAll) {
            for (const fx of this._collectFlyHitFxPool) {
                if (fx?.isValid) fx.destroy();
            }
            this._collectFlyHitFxPool.length = 0;
        }

        if (this.collectFlyHitFx?.isValid) {
            this.collectFlyHitFx.active = false;
        }
    }

    private _pushCollectFlyHitFxToPool(fx: Node): void {
        if (!fx?.isValid) return;
        const maxPool = Math.max(1, Math.floor(this.collectFlyHitFxPoolMax));
        if (this._collectFlyHitFxPool.length >= maxPool) {
            fx.destroy();
            return;
        }
        const tmpl = this.collectFlyHitFx;
        if (tmpl?.isValid && tmpl.parent?.isValid) {
            fx.setParent(tmpl.parent);
        }
        if (!this._collectFlyHitFxPool.includes(fx)) {
            this._collectFlyHitFxPool.push(fx);
        }
    }

    /** Matsuri: Green vừa land → Coin_Impact tại coin slot. */
    playGreenCoinImpactAtSlot(slotNode: Node): Promise<void> {
        return this._playGreenCoinSpineFxOnce(slotNode, GREEN_COIN_SPINE_IMPACT);
    }

    /** Matsuri collect: Coin_Anim_Loop — giữ đến khi bay tiền xong. */
    playGreenCoinAnimLoopAtSlot(slotNode: Node): Promise<void> {
        return this._startGreenCoinAnimLoop(slotNode);
    }

    /** Dừng Coin_Anim_Loop khi collect Gold xong. */
    clearGreenCoinAnimLoopAtSlot(slotNode: Node): void {
        if (!slotNode?.isValid) return;
        const fx = this._greenAnimLoopFxBySlot.get(slotNode);
        if (!fx?.isValid) {
            this._greenAnimLoopFxBySlot.delete(slotNode);
            return;
        }
        this._greenAnimLoopFxBySlot.delete(slotNode);
        this._destroyGreenSpineFx(fx);
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

    /** Baseline layout ngang = hằng số prefab (không capture lúc dọc). */
    private _frontFrameNode: Node | null = null;
    private _arrayNode: Node | null = null;
    private _gridNode: Node | null = null;
    /** FramFront/Top — HUD trên khung (fallback nếu chưa gán Inspector). */
    private _featureTopNode: Node | null = null;
    /** Đang ném quả cầu seed — Cat on, Top off. */
    private _inSeedThrowPhase = false;
    /** Cat seed spine — gen để hủy sequence cũ. */
    private _seedCatSeqGen = 0;
    private _seedCatSkel: sp.Skeleton | null = null;
    private _seedCatOrbRemaining = 0;
    private _seedCatRiseupFailsafe: (() => void) | null = null;
    private _seedCatOrbFireCb: (() => void) | null = null;
    private _seedCatFadeOutDoneCb: (() => void) | null = null;

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
        this._ensureCollectTotalSpriteNumber();
        return this.collectTotalSpriteNumber?.node ?? null;
    }

    getCollectTotalSpriteNumber(): SpriteNumber | null {
        this._ensureCollectTotalSpriteNumber();
        return this.collectTotalSpriteNumber;
    }

    /**
     * Lazy-load Prefab: collectTotalSpriteNumber thường null trong .prefab
     * (chỉ có TargetOverride khi nhúng Base) — tự tìm AmountDisplay dưới Top.
     */
    private _ensureCollectTotalSpriteNumber(): void {
        if (this.collectTotalSpriteNumber?.isValid) return;
        const sn = this._findCollectTotalSpriteNumber();
        if (sn) {
            this.collectTotalSpriteNumber = sn;
            Log.d(`[StickyOverlay] auto-wired collectTotalSpriteNumber → ${sn.node.name}`);
        }
    }

    private _findCollectTotalSpriteNumber(): SpriteNumber | null {
        const top = this._findFeatureTop();
        if (top?.isValid) {
            const amount = top.getChildByName('AmountDisplay');
            if (amount?.isValid) {
                const sn = amount.getComponent(SpriteNumber)
                    ?? amount.getComponentInChildren(SpriteNumber);
                if (sn) return sn;
            }
        }
        for (const path of [
            'FramFront/Top/AmountDisplay',
            'FrameFront/Top/AmountDisplay',
            'Top/AmountDisplay',
        ]) {
            const node = this.node.getChildByPath(path);
            if (!node?.isValid) continue;
            const sn = node.getComponent(SpriteNumber) ?? node.getComponentInChildren(SpriteNumber);
            if (sn) return sn;
        }
        return null;
    }

    /** Số đang hiện trên HUD collect (client). */
    getFeatureCollectTotal(): number {
        return this._featureCollectTotal;
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
     *  - Root: màn dọc dùng pos/scale Inspector theo 5×N; màn ngang giữ mặc định prefab
     */
    private _applyGridFitScale(rows: number): void {
        this._ensureLayoutBaselines();
        const r = clampMatsuriRows(rows);

        this._applyFeatureFrame(r);
        this._layoutMatsuriGrid(r);
        this._syncGridRectNodes(r);

        this.applyOrientationLayout();
        this._scheduleOrientationApply();

        this.alignPositionsFromTopUpManager();
        this._refreshGrandJackpotNote();
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

    /** FramFront/Top/Frame2/Note — số ô = 5×rows (15/20/25). */
    private _findGrandJackpotNote(): Node | null {
        const top = this._findFeatureTop();
        return top?.getChildByName('Frame2')?.getChildByName('Note') ?? null;
    }

    private _ensureGrandJackpotShrink(note: Node): RichTextShrink {
        let shrink = note.getComponent(RichTextShrink);
        if (!shrink) {
            shrink = note.addComponent(RichTextShrink);
        }
        shrink.maxFontSize = GRAND_JACKPOT_NOTE_FONT;
        shrink.minFontSize = GRAND_JACKPOT_NOTE_MIN_FONT;
        shrink.containerWidth = GRAND_JACKPOT_NOTE_WIDTH;
        shrink.containerHeight = 200;
        shrink.maxLines = 0;
        shrink.allowWrap = false;
        return shrink;
    }

    private _refreshGrandJackpotNote(): void {
        const note = this._findGrandJackpotNote();
        if (!note?.isValid) return;

        this._ensureGrandJackpotShrink(note);

        const count = MATSURI_COL_COUNT * this._rowCount;
        const lc = note.getComponent(LanguageChange);
        if (lc) {
            lc.translationParams = { count };
            lc.refreshText();
            return;
        }
        this._ensureGrandJackpotShrink(note).startShrink();
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
                if (poolSlot?.isValid) {
                    const { labelNode, sn } = this._resolveCreditLabel(poolSlot);
                    this._fitCreditLabelToGrid(labelNode, sn, r, poolSlot);
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

    private _rowsForLayout(rows?: number): number {
        if (rows != null && rows > 0) return clampMatsuriRows(rows);
        const data = GameData.instance;
        if (data.currentMode === 'matsuri' || data.currentMode === 'respin') {
            return clampMatsuriRows(data.matsuriRows || this._rowCount || MATSURI_MIN_ROWS);
        }
        return clampMatsuriRows(this._rowCount || MATSURI_MIN_ROWS);
    }

    private _isPortrait(): boolean {
        const vs = view.getVisibleSize();
        const win = screen.windowSize;
        const viewPortrait = vs.height > vs.width;
        const winPortrait = win.height > win.width;
        return viewPortrait && winPortrait;
    }

    private _applyLandscapeLayout(): void {
        this._lockRootWidget();
        this.node.setPosition(LANDSCAPE_POS_X, LANDSCAPE_POS_Y, 0);
        this.node.setScale(LANDSCAPE_SCALE_X, LANDSCAPE_SCALE_Y, 1);
    }

    /**
     * Gán pos/scale ngay: dọc theo grid 5×N (Inspector), ngang luôn y=-26 scale 1,1,1.
     */
    applyOrientationLayout(rows?: number): void {
        if (!this.node?.isValid) return;
        this._lockRootWidget();
        if (!this._isPortrait()) {
            this._applyLandscapeLayout();
            return;
        }
        const r = this._rowsForLayout(rows);
        const cfg = this._portraitCfgForRows(r);
        this.node.setPosition(cfg.x, cfg.y, 0);
        this.node.setScale(cfg.sx, cfg.sy, 1);
    }

    private _portraitCfgForRows(rows: number): { x: number; y: number; sx: number; sy: number } {
        const r = clampMatsuriRows(rows);
        if (r === 3) {
            return {
                x: this.portrait5x3PosX, y: this.portrait5x3PosY,
                sx: this.portrait5x3ScaleX, sy: this.portrait5x3ScaleY,
            };
        }
        if (r === 4) {
            return {
                x: this.portrait5x4PosX, y: this.portrait5x4PosY,
                sx: this.portrait5x4ScaleX, sy: this.portrait5x4ScaleY,
            };
        }
        return {
            x: this.portrait5x5PosX, y: this.portrait5x5PosY,
            sx: this.portrait5x5ScaleX, sy: this.portrait5x5ScaleY,
        };
    }

    /** Widget root không canh cạnh — tắt để khỏi ghi đè pos khi xoay. */
    private _lockRootWidget(): void {
        const widget = this.node.getComponent(Widget);
        if (widget?.enabled) widget.enabled = false;
    }

    /** Apply ngay + lại sau 1 frame và sau layout canvas (tránh Widget/resize ghi đè). */
    private _scheduleOrientationApply(): void {
        this.unschedule(this._applyOrientationNow);
        this.unschedule(this._applyOrientationLate);
        this.scheduleOnce(this._applyOrientationNow, 0);
        this.scheduleOnce(this._applyOrientationLate, 0.12);
    }

    private _applyOrientationNow = (): void => {
        this.applyOrientationLayout();
        if (this.node.active) this.alignPositionsFromTopUpManager();
    };

    private _applyOrientationLate = (): void => {
        this.applyOrientationLayout();
        if (this.node.active) this.alignPositionsFromTopUpManager();
    };

    private _onOrientationChange = (): void => {
        this.applyOrientationLayout();
        this._scheduleOrientationApply();
    };

    private _resetGridFitLayout(): void {
        this.applyOrientationLayout(MATSURI_MIN_ROWS);
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

    private _syncFeatureHudTotal(totalWin?: number, force = false): void {
        if (!this._isMatsuriMode()) return;
        const fromPayload = totalWin != null ? totalWin : 0;
        const fromData = GameData.instance.respinTotalWin || 0;
        const next = Math.max(fromPayload, fromData);
        this._setFeatureCollectTotal(force ? (totalWin ?? fromData) : Math.max(this._featureCollectTotal, next), force);
    }

    private _onMatsuriHudStart(): void {
        this._featureCollectTotal = 0;
        // Chờ MatsuriStartPopup đóng → MATSURI_SEED_START mới bật Cat / ẩn Top
        this._inSeedThrowPhase = false;
        this.applyOrientationLayout();
        this._scheduleOrientationApply();
        this._syncFeatureHud();
    }

    private _onMatsuriHudEnd(): void {
        this._stopSeedThrowCatSequence();
        this._lastFeatureRemain = -1;
        this._featureCollectTotal = 0;
        this._inSeedThrowPhase = false;
        this._applyMatsuriFrameNodes();
    }

    private _onMatsuriSeedStart(payload?: { cells?: { reel: number; row: number }[] }): void {
        this._inSeedThrowPhase = true;
        this._applyMatsuriFrameNodes();
        const orbCount = payload?.cells?.length ?? 0;
        if (orbCount > 0) this._startSeedThrowCatSequence(orbCount);
    }

    private _onMatsuriSeedDone(): void {
        this._stopSeedThrowCatSequence();
        this._inSeedThrowPhase = false;
        this._syncFeatureHud();
    }

    private _resolveSeedThrowCatSkeleton(): sp.Skeleton | null {
        const cat = this._findSeedThrowCat();
        if (!cat?.isValid) return null;
        return cat.getComponent(sp.Skeleton) ?? cat.getComponentInChildren(sp.Skeleton);
    }

    private _getSeedCatTimeScale(): number {
        const base = Math.max(0.1, this.seedCatSpineTimeScale);
        switch (AutoSpinManager.instance?.speedMode) {
            case SpeedMode.QUICK: return base * 1.2;
            case SpeedMode.TURBO: return base * 1.5;
            default: return base;
        }
    }

    /** Thời lượng anim trên wall-clock — có tính timeScale + speed mode. */
    private _seedCatWallDuration(nativeDur: number, timeScale: number): number {
        if (nativeDur <= 0) return 0;
        const ts = Math.max(0.1, timeScale);
        const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
        return (nativeDur / ts) * m;
    }

    private _getSeedCatAnimDuration(skel: sp.Skeleton, animName: string): number {
        if (!skel?.skeletonData) return 0;
        try {
            const anim = skel.skeletonData.getRuntimeData()?.findAnimation(animName);
            return anim?.duration ?? 0;
        } catch {
            return 0;
        }
    }

    /** riseup → bonus từng vòng; mỗi vòng bonus xong → MATSURI_SEED_CAT_ORB_FIRE; hết cầu → dừng anim. */
    private _startSeedThrowCatSequence(orbCount: number): void {
        this._stopSeedThrowCatSequence();
        if (orbCount <= 0) return;

        this._seedCatOrbRemaining = orbCount;
        const gen = ++this._seedCatSeqGen;
        const skel = this._resolveSeedThrowCatSkeleton();

        if (!skel?.isValid) {
            this._fallbackSeedCatOrbFires(gen, orbCount);
            return;
        }

        this._seedCatSkel = skel;
        const timeScale = this._getSeedCatTimeScale();
        skel.timeScale = timeScale;
        skel.setCompleteListener(null);

        const riseupDur = this._getSeedCatAnimDuration(skel, SEED_CAT_SPINE_RISEUP);
        this._seedCatRiseupFailsafe = () => {
            if (gen !== this._seedCatSeqGen) return;
            this._playSeedCatBonusRound(gen);
        };
        this.scheduleOnce(
            this._seedCatRiseupFailsafe,
            Math.max(0.35, this._seedCatWallDuration(riseupDur, timeScale) + 0.1),
        );

        try {
            SoundManager.instance?.playSfxByName('sxCatAppear');
            skel.setAnimation(0, SEED_CAT_SPINE_RISEUP, false);
            skel.setCompleteListener((entry) => {
                if (gen !== this._seedCatSeqGen) return;
                if (entry?.animation?.name && entry.animation.name !== SEED_CAT_SPINE_RISEUP) return;
                this._playSeedCatBonusRound(gen);
            });
        } catch {
            this._playSeedCatBonusRound(gen);
        }
    }

    /** Một vòng bonus (không loop) — xong vòng → bắn 1 quả cầu; còn cầu thì chơi vòng kế. */
    private _playSeedCatBonusRound(gen: number): void {
        if (gen !== this._seedCatSeqGen) return;
        if (this._seedCatRiseupFailsafe) {
            this.unschedule(this._seedCatRiseupFailsafe);
            this._seedCatRiseupFailsafe = null;
        }

        const skel = this._seedCatSkel;
        if (!skel?.isValid) {
            this._fallbackSeedCatOrbFires(gen, this._seedCatOrbRemaining);
            return;
        }

        if (this._seedCatOrbRemaining <= 0) {
            this._finishSeedThrowCatSequence(gen);
            return;
        }

        const bonusDur = this._getSeedCatAnimDuration(skel, SEED_CAT_SPINE_BONUS);
        const timeScale = skel.timeScale || this._getSeedCatTimeScale();
        const wallBonus = this._seedCatWallDuration(bonusDur, timeScale);
        const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
        const lead = Math.max(0.05, this.seedCatBonusOrbFireLead) * m;
        const fireDelay = wallBonus > 0
            ? Math.max(0.06, wallBonus - lead)
            : 0.1 * m;

        let orbFired = false;
        const fireOrb = () => {
            if (orbFired || gen !== this._seedCatSeqGen) return;
            orbFired = true;
            this._seedCatOrbFireCb = null;
            this._emitSeedCatOrbFire(gen);
        };
        this._seedCatOrbFireCb = fireOrb;
        this.scheduleOnce(fireOrb, fireDelay);

        try {
            skel.setAnimation(0, SEED_CAT_SPINE_BONUS, false);
            skel.setCompleteListener((entry) => {
                if (gen !== this._seedCatSeqGen) return;
                if (entry?.animation?.name && entry.animation.name !== SEED_CAT_SPINE_BONUS) return;
                if (this._seedCatOrbFireCb) {
                    this.unschedule(this._seedCatOrbFireCb);
                    this._seedCatOrbFireCb = null;
                }
                if (!orbFired) fireOrb();
                if (this._seedCatOrbRemaining > 0) {
                    this._playSeedCatBonusRound(gen);
                } else {
                    this._finishSeedThrowCatSequence(gen);
                }
            });
        } catch {
            if (this._seedCatOrbFireCb) {
                this.unschedule(this._seedCatOrbFireCb);
                this._seedCatOrbFireCb = null;
            }
            this._fallbackSeedCatOrbFires(gen, this._seedCatOrbRemaining);
        }
    }

    /** Hết quả cầu — Cat fade out, Top fade in đồng thời; dừng Spine sau fade. */
    private _finishSeedThrowCatSequence(gen: number): void {
        if (gen !== this._seedCatSeqGen) return;

        const skel = this._seedCatSkel;
        if (skel?.isValid) skel.setCompleteListener(null);

        this._inSeedThrowPhase = false;
        const cat = this._findSeedThrowCat();
        const top = this._findFeatureTop();
        if (top?.isValid) top.active = true;
        if (cat?.isValid) cat.active = true;
        this._fadeMatsuriFrameNode(cat, false, true, false);
        this._fadeMatsuriFrameNode(top, true, true, false);

        if (this._seedCatFadeOutDoneCb) {
            this.unschedule(this._seedCatFadeOutDoneCb);
            this._seedCatFadeOutDoneCb = null;
        }
        const fadeDur = Math.max(0.05, this.matsuriFrameHudFadeDuration)
            * (AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1);
        this._seedCatFadeOutDoneCb = () => {
            this._seedCatFadeOutDoneCb = null;
            if (gen !== this._seedCatSeqGen) return;
            if (skel?.isValid) skel.clearTracks();
        };
        this.scheduleOnce(this._seedCatFadeOutDoneCb, fadeDur);
    }

    private _emitSeedCatOrbFire(gen: number): void {
        if (gen !== this._seedCatSeqGen || this._seedCatOrbRemaining <= 0) return;
        this._seedCatOrbRemaining--;
        EventBus.instance.emit(GameEvents.MATSURI_SEED_CAT_ORB_FIRE);
    }

    /** Không có Cat Spine — bắn lệch pha (mỗi nhịp ≈ 1 vòng bonus). */
    private _fallbackSeedCatOrbFires(gen: number, count: number): void {
        const skel = this._resolveSeedThrowCatSkeleton();
        const bonusDur = skel ? this._getSeedCatAnimDuration(skel, SEED_CAT_SPINE_BONUS) : 0;
        const timeScale = skel ? this._getSeedCatTimeScale() : 1;
        const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
        const lead = Math.max(0.05, this.seedCatBonusOrbFireLead) * m;
        const round = bonusDur > 0
            ? Math.max(0.15, this._seedCatWallDuration(bonusDur, timeScale) - lead)
            : 0.35 * m;
        for (let i = 0; i < count; i++) {
            const t = i * round;
            this.scheduleOnce(() => {
                this._emitSeedCatOrbFire(gen);
                if (i === count - 1) this._finishSeedThrowCatSequence(gen);
            }, t);
        }
    }

    private _stopSeedThrowCatSequence(): void {
        this._seedCatSeqGen++;
        this._seedCatOrbRemaining = 0;
        if (this._seedCatRiseupFailsafe) {
            this.unschedule(this._seedCatRiseupFailsafe);
            this._seedCatRiseupFailsafe = null;
        }
        if (this._seedCatOrbFireCb) {
            this.unschedule(this._seedCatOrbFireCb);
            this._seedCatOrbFireCb = null;
        }
        if (this._seedCatFadeOutDoneCb) {
            this.unschedule(this._seedCatFadeOutDoneCb);
            this._seedCatFadeOutDoneCb = null;
        }
        if (this._seedCatSkel?.isValid) {
            this._seedCatSkel.setCompleteListener(null);
            this._seedCatSkel.clearTracks();
        }
        this._seedCatSkel = null;
    }

    private _onTopUpCountUpdated(count: number): void {
        if (!this._isMatsuriMode()) return;
        this._setFeatureRemain(count);
    }

    private _setFeatureRemain(count: number): void {
        const n = Math.max(0, Math.min(MATSURI_SPIN_COUNT, Math.floor(Number(count) || 0)));
        const prev = this._lastFeatureRemain;
        if (prev >= 0 && n !== prev) {
            SoundManager.instance?.playSfxByName('sxSpinRemain');
        }
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
            tween(fill)
                .to(0.18, { scale: new Vec3(1.28, 1.28, 1) }, { easing: 'backOut' })
                .to(0.12, { scale: new Vec3(1, 1, 1) }, { easing: 'sineIn' })
                .start();
        };
        if (delay > 0) this.scheduleOnce(play, delay);
        else play();
    }

    private _setFeatureCollectTotal(value: number, force = false): void {
        const next = Math.max(0, value);
        if (!force && next < this._featureCollectTotal) return;
        this._featureCollectTotal = next;
        this._ensureCollectTotalSpriteNumber();
        const sn = this.collectTotalSpriteNumber;
        if (!sn?.node?.isValid) {
            Log.w('[StickyOverlay] collectTotalSpriteNumber chưa gán — kéo SpriteNumber Top/AmountDisplay vào Inspector');
            return;
        }
        sn.node.active = true;
        sn.setData(this._featureCollectTotal, 0, 3, true);
    }

    // ── LIFECYCLE ──────────────────────────────────────────────────────────────

    onLoad(): void {
        this._lockRootWidget();
        this._poolCoinSlots = this.coinSlots.slice();
        if (this._poolCoinSlots.length >= MATSURI_COL_COUNT * StickyOverlayController.POOL_ROWS) {
            this._rowCount = StickyOverlayController.POOL_ROWS;
            this.ensureRowCount(MATSURI_MIN_ROWS, null);
        } else if (this.coinSlots.length >= 20) {
            this._rowCount = 4;
        } else {
            this._rowCount = 3;
        }

        this._refreshGrandJackpotNote();
        this._hideAll();
        this._wireFeatureHud();
        this._ensureCollectTotalSpriteNumber();
        if (this.goldCoinSpineTemplate?.isValid) {
            this.goldCoinSpineTemplate.active = false;
        }
        if (this.greenCoinSpineTemplate?.isValid) {
            this.greenCoinSpineTemplate.active = false;
        }
        if (this.collectFlyHitFx?.isValid) {
            this.collectFlyHitFx.active = false;
        }

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
        EventBus.instance.on(GameEvents.MATSURI_COLLECT_START, this._onMatsuriCollectStart, this);
        EventBus.instance.on(GameEvents.MATSURI_COLLECT_DONE, this._onMatsuriCollectDone, this);
        screen.on('window-resize', this._onOrientationChange, this);
        screen.on('orientation-change', this._onOrientationChange, this);
        view.on('canvas-resize', this._onOrientationChange, this);
        this.applyOrientationLayout();
        this._scheduleOrientationApply();

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
        EventBus.instance.off(GameEvents.MATSURI_COLLECT_START, this._onMatsuriCollectStart, this);
        EventBus.instance.off(GameEvents.MATSURI_COLLECT_DONE, this._onMatsuriCollectDone, this);
        screen.off('window-resize', this._onOrientationChange, this);
        screen.off('orientation-change', this._onOrientationChange, this);
        view.off('canvas-resize', this._onOrientationChange, this);
        this.unschedule(this._applyOrientationNow);
        this.unschedule(this._applyOrientationLate);
    }

    start(): void {
        this.applyOrientationLayout();
        this._scheduleOrientationApply();
        this._refreshGrandJackpotNote();
    }

    onEnable(): void {
        this.applyOrientationLayout();
        this._scheduleOrientationApply();
    }

    lateUpdate(): void {
        if (!this.node?.active || !this.node.isValid) return;
        if (this._isPortrait()) return;
        const p = this.node.position;
        const s = this.node.scale;
        if (
            Math.abs(p.x) > 0.01
            || Math.abs(p.y - LANDSCAPE_POS_Y) > 0.01
            || Math.abs(s.x - 1) > 0.001
            || Math.abs(s.y - 1) > 0.001
            || Math.abs(s.z - 1) > 0.001
        ) {
            this._applyLandscapeLayout();
        }
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
        this.applyOrientationLayout();
        this._scheduleOrientationApply();
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
        this.applyOrientationLayout();
        this._scheduleOrientationApply();
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
            // Enter mới: grid trống — FramFront/Top hiện; Cat + seed chờ MatsuriStartPopup đóng
            this._inSeedThrowPhase = false;
            this._hideAll();
            this._syncFeatureHud();
            Log.d('[StickyOverlay] Matsuri enter — blank overlay, Top HUD (chờ start popup)');
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

    private _onTopUpUpdated(payload?: { totalWin?: number; force?: boolean }): void {
        this._syncFeatureHudTotal(payload?.totalWin, !!payload?.force);
        if (payload?.force) return;
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
        this._matsuriNextFlipKey = null;
        this._matsuriFlipDonePending = 0;
        this._deferEnterAnim = false;
        this._pendingEnterAnim = false;
        this._enterAnimPlayed = false;
        this._lastFeatureRemain = -1;
        this._featureCollectTotal = 0;
        this._inSeedThrowPhase = false;
        this._applyMatsuriFrameNodes();
        this._cleanupGoldSpineFx();
        this._cleanupGreenSpineFx();
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
            const sprite = slotNode.getComponent(Sprite);
            if (sprite) sprite.enabled = true;
            this._applyCoin(slotNode, MATSURI_GOLD_SYMBOL, safeCredit);
            this._alignSlotToTopUpCell(idx);
            slotNode.setRotationFromEuler(0, 0, 0);
        }
    }

    /** Collect Gold xong → flip 1 Green (sequential: hút → lật → Green kế). */
    private _onMatsuriCollectStart(payload?: { flipGreenKey?: string }): void {
        // Dọn FX sót từ vòng collect trước — trả pool, giữ node để tái dùng.
        this._cleanupCollectFlyHitFx(false);
        this._primeCollectFlyHitFxForRound();
        const key = payload?.flipGreenKey;
        this._matsuriNextFlipKey = key && key.length > 0 ? key : null;
    }

    private _onMatsuriCollectDone(): void {
        // Chỉ reset counter — không destroy FX đang play (để hit cuối kịp hiện).
        // FX sót sẽ bị dọn ở COLLECT_START vòng sau / _hideAll.
        this._collectFlyHitFxHitCount = 0;
        if (this._matsuriFlipDonePending > 0) {
            return;
        }
        if (GameData.instance.currentMode !== 'matsuri') {
            EventBus.instance.emit(GameEvents.MATSURI_FLIP_DONE);
            return;
        }

        let keys: string[] = [];
        const one = this._matsuriNextFlipKey;
        this._matsuriNextFlipKey = null;
        if (one && this._matsuriPendingFlipKeys.has(one)) {
            this._matsuriPendingFlipKeys.delete(one);
            keys = [one];
        } else if (one) {
            keys = [one];
        } else {
            keys = [...this._matsuriPendingFlipKeys];
            this._matsuriPendingFlipKeys.clear();
        }

        if (keys.length === 0) {
            for (const [key, cell] of GameData.instance.stickyCells) {
                if (cell.symbolId === SymbolId.STICKY_GREEN) {
                    keys.push(key);
                    break;
                }
            }
        }

        if (keys.length === 0) {
            EventBus.instance.emit(GameEvents.MATSURI_FLIP_DONE);
            return;
        }

        this._matsuriFlipDonePending = keys.length;
        for (const key of keys) {
            try {
                const [reelStr, rowStr] = key.split('-');
                const reel = parseInt(reelStr, 10);
                const row = parseInt(rowStr, 10);
                const idx = this._cellIdx(reel, row);
                const slotNode = this.coinSlots[idx];
                const cell = GameData.instance.stickyCells.get(key);
                if (!slotNode?.isValid || !cell) {
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
        this._cleanupGoldSpineFx();
        this._cleanupGreenSpineFx();
        this._cleanupCollectFlyHitFx(true);
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
        this._fitCreditLabelToGrid(labelNode, sn, undefined, slotNode);
        if (sn && credit > 0) sn.setData(credit, 0, 2);
        const op = labelNode.getComponent(UIOpacity) ?? labelNode.addComponent(UIOpacity);
        op.opacity = visible ? 255 : 0;
        if (visible) this._raiseCreditLabelAboveSpine(slotNode);
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
     * CreditLabel.prefab = 130×130, shrinkToFit + fillContainer theo khung đó (thiết kế 5×3).
     * Coin 5×4/5×5 thu nhỏ bằng contentSize — child không inherit → số bị to.
     * Scale label theo cell/182 để khớp tỉ lệ symbol.
     */
    private _creditLabelGridScale(rows?: number): number {
        return matsuriCellSize(rows ?? this._rowCount) / MATSURI_CELL_SIZE_LARGE;
    }

    /** shrinkToFit chỉ thu nhỏ khi fillContainer=false — bật fill + maxWidth=0 để phóng to vừa khung. */
    private _configureCreditLabelSpriteNumber(sn: SpriteNumber): void {
        sn.shrinkToFit = true;
        sn.fillContainer = true;
        sn.maxWidth = 0;
        sn.enableLangCurrency = true;
        sn.refreshContainerDims();
    }

    private _fitCreditLabelToGrid(
        labelNode: Node | null,
        sn: SpriteNumber | null,
        rows?: number,
        slotNode?: Node,
    ): void {
        if (!labelNode) return;
        const s = this._creditLabelGridScale(rows);
        if (sn) {
            this._configureCreditLabelSpriteNumber(sn);
            sn.setDisplayScale(s);
            if (slotNode) {
                const credit = this._slotCreditMap.get(slotNode);
                if (credit != null && credit > 0) {
                    sn.setData(credit, 0, 2);
                }
            }
        } else {
            labelNode.setScale(s, s, 1);
        }
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
            this._fitCreditLabelToGrid(labelNode, sn, undefined, slotNode);
            if (isMatsuri) {
                // Không active=false — lần đầu bật sẽ delay onLoad SpriteNumber (số hiện chậm).
                if (!labelNode.active) labelNode.active = true;
                const lop = labelNode.getComponent(UIOpacity) ?? labelNode.addComponent(UIOpacity);
                lop.opacity = shouldActive ? 255 : 0;
                if (sn && displayCredit > 0) {
                    sn.setData(Math.max(0, displayCredit), 0, 2);
                }
            } else {
                labelNode.active = shouldActive;
                if (sn && (creditChanged || shouldActive)) {
                    sn.setData(Math.max(0, displayCredit), 0, 2);
                } else if (!sn && !quiet) {
                    Log.e(`[StickyOverlay] Missing SpriteNumber on ${slotNode.name}/CreditLabel`);
                }
            }
        } else if (!quiet) {
            Log.e(`[StickyOverlay] Missing CreditLabel on ${slotNode.name}`);
        }

        this._slotCreditMap.set(slotNode, Math.max(0, displayCredit));
        this._raiseCreditLabelAboveSpine(slotNode);
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

    /** Matsuri seed: coin hiện tĩnh + Coin_Impact ngay khi quả cầu land. */
    private _playMatsuriGoldSeedPopIn(slotNode: Node, symbolId: number): void {
        const base = this._getBaseScale(symbolId);
        const fadeDur = Math.min(this.matsuriSeedPopDuration * 0.45, 0.15);
        Tween.stopAllByTarget(slotNode);
        slotNode.setScale(base, base, 1);
        const op = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        op.opacity = 0;
        if (fadeDur > 0) {
            tween(op).to(fadeDur, { opacity: 255 }, { easing: 'sineOut' }).start();
        } else {
            op.opacity = 255;
        }
        SoundManager.instance?.playSfxByName('sxYellowGreenAppear');
        void this.playGoldCoinImpactAtSlot(slotNode);
    }

    private _resolveGoldCoinSpineTemplate(): sp.Skeleton | null {
        const tmpl = this.goldCoinSpineTemplate;
        if (!tmpl?.isValid) return null;
        return tmpl.getComponent(sp.Skeleton) ?? tmpl.getComponentInChildren(sp.Skeleton);
    }

    private _getGoldCoinSpineAnimDuration(animName: string): number {
        const skel = this._resolveGoldCoinSpineTemplate();
        if (!skel?.skeletonData) return 0;
        try {
            const anim = skel.skeletonData.getRuntimeData()?.findAnimation(animName);
            return anim?.duration ?? 0;
        } catch {
            return 0;
        }
    }

    /** Scale + local pos Spine lấy từ Inspector theo grid 5×3 / 5×4 / 5×5. */
    private _goldCoinSpineLayout(): { scale: number; offsetX: number; offsetY: number } {
        const r = this._rowCount;
        if (r >= 5) {
            return {
                scale: this.goldCoinSpineScale5x5,
                offsetX: this.goldCoinSpineOffsetX5x5,
                offsetY: this.goldCoinSpineOffsetY5x5,
            };
        }
        if (r === 4) {
            return {
                scale: this.goldCoinSpineScale5x4,
                offsetX: this.goldCoinSpineOffsetX5x4,
                offsetY: this.goldCoinSpineOffsetY5x4,
            };
        }
        return {
            scale: this.goldCoinSpineScale5x3,
            offsetX: this.goldCoinSpineOffsetX5x3,
            offsetY: this.goldCoinSpineOffsetY5x3,
        };
    }

    private _fitGoldSpineToCoin(fx: Node, _slotNode: Node): void {
        const { scale, offsetX, offsetY } = this._goldCoinSpineLayout();
        const fit = Math.max(0.01, scale);
        fx.setScale(fit, fit, 1);
        fx.setPosition(offsetX, offsetY, 0);
    }

    /** CreditLabel luôn vẽ trên Spine (sibling sau cùng của coin slot). */
    private _raiseCreditLabelAboveSpine(slotNode: Node): void {
        const { labelNode } = this._resolveCreditLabel(slotNode);
        if (!labelNode?.isValid) return;
        let raise = labelNode;
        while (raise.parent && raise.parent !== slotNode) {
            raise = raise.parent;
        }
        if (raise.parent === slotNode) {
            raise.setSiblingIndex(slotNode.children.length - 1);
        }
    }

    private _playGoldCoinSpineFxOnce(slotNode: Node, animName: string): Promise<void> {
        return new Promise(resolve => {
            const tmpl = this.goldCoinSpineTemplate;
            if (!tmpl?.isValid || !slotNode?.isValid) {
                resolve();
                return;
            }

            const fx = this._spawnGoldCoinSpineFxNode(slotNode, animName);
            if (!fx) {
                resolve();
                return;
            }

            const skel = fx.getComponent(sp.Skeleton) ?? fx.getComponentInChildren(sp.Skeleton);
            if (!skel) {
                this._destroyGoldSpineFx(fx);
                resolve();
                return;
            }

            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                this.unschedule(fallback);
                if (skel.isValid) skel.setCompleteListener(null);
                this._destroyGoldSpineFx(fx);
                resolve();
            };
            const fallback = () => finish();

            const animDur = this._getGoldCoinSpineAnimDuration(animName);
            this.scheduleOnce(fallback, Math.max(0.5, animDur + 0.12));

            skel.setCompleteListener((entry) => {
                if (entry?.animation?.name && entry.animation.name !== animName) return;
                finish();
            });

            try {
                skel.setAnimation(0, animName, false);
            } catch {
                finish();
            }
        });
    }

    /** Coin_Impact2: loop giữ sáng — resolve ngay sau khi bắt đầu. */
    private _startGoldCoinImpact2Loop(slotNode: Node): Promise<void> {
        return new Promise(resolve => {
            const tmpl = this.goldCoinSpineTemplate;
            if (!tmpl?.isValid || !slotNode?.isValid) {
                resolve();
                return;
            }

            this.clearGoldCoinImpact2AtSlot(slotNode);

            const fx = this._spawnGoldCoinSpineFxNode(slotNode, GOLD_COIN_SPINE_IMPACT2);
            if (!fx) {
                resolve();
                return;
            }

            const skel = fx.getComponent(sp.Skeleton) ?? fx.getComponentInChildren(sp.Skeleton);
            if (!skel) {
                this._destroyGoldSpineFx(fx);
                resolve();
                return;
            }

            this._goldImpact2FxBySlot.set(slotNode, fx);

            try {
                skel.setCompleteListener(null);
                skel.setAnimation(0, GOLD_COIN_SPINE_IMPACT2, true);
            } catch {
                this.clearGoldCoinImpact2AtSlot(slotNode);
            }
            resolve();
        });
    }

    private _spawnGoldCoinSpineFxNode(slotNode: Node, animName: string): Node | null {
        const tmpl = this.goldCoinSpineTemplate;
        if (!tmpl?.isValid || !slotNode?.isValid) return null;

        const fx = instantiate(tmpl);
        fx.name = `GoldCoinSpineFx_${animName}`;
        fx.setParent(slotNode);
        fx.setPosition(0, 0, 0);
        fx.setRotationFromEuler(0, 0, 0);
        this._fitGoldSpineToCoin(fx, slotNode);
        fx.setSiblingIndex(0);
        fx.active = true;
        this._raiseCreditLabelAboveSpine(slotNode);
        this._activeGoldSpineFx.push(fx);
        return fx;
    }

    private _playGoldCoinSpineFx(slotNode: Node, animName: string): Promise<void> {
        return this._playGoldCoinSpineFxOnce(slotNode, animName);
    }

    private _destroyGoldSpineFx(fx: Node): void {
        if (!fx?.isValid) return;
        for (const [slot, node] of this._goldImpact2FxBySlot) {
            if (node === fx) {
                this._goldImpact2FxBySlot.delete(slot);
                break;
            }
        }
        const idx = this._activeGoldSpineFx.indexOf(fx);
        if (idx >= 0) this._activeGoldSpineFx.splice(idx, 1);
        fx.destroy();
    }

    private _cleanupGoldSpineFx(): void {
        this._goldImpact2FxBySlot.clear();
        const copy = this._activeGoldSpineFx.slice();
        this._activeGoldSpineFx.length = 0;
        for (const fx of copy) {
            if (fx?.isValid) fx.destroy();
        }
    }

    /** Matsuri: Green vừa land — hiện xanh + Coin_Impact; ẩn CreditLabel. */
    private _playMatsuriGreenLandOnly(slotNode: Node, idx: number): void {
        this._alignSlotToTopUpCell(idx);
        slotNode.setRotationFromEuler(0, 0, 0);
        this._setMatsuriCreditLabelVisible(slotNode, false);

        const base = this._getBaseScale(SymbolId.STICKY_GREEN);
        Tween.stopAllByTarget(slotNode);
        slotNode.setScale(base, base, 1);
        const op = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        op.opacity = 255;
        SoundManager.instance?.playSfxByName('sxYellowGreenAppear');
        void this.playGreenCoinImpactAtSlot(slotNode);
    }

    /**
     * Matsuri: Transition_GoldCoin spine — sau khi collect Gold xong (thay squeeze flip code).
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
        this.clearGreenCoinAnimLoopAtSlot(slotNode);
        this._alignSlotToTopUpCell(idx);
        slotNode.setRotationFromEuler(0, 0, 0);
        this._setMatsuriCreditLabelVisible(slotNode, false, credit);

        const greenS = this._getBaseScale(SymbolId.STICKY_GREEN);
        const goldS = this._getBaseScale(MATSURI_GOLD_SYMBOL);
        slotNode.setScale(greenS, greenS, 1);

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
                    this._setMatsuriCreditLabelVisible(slotNode, credit > 0, credit);
                }
            } catch {
                // failsafe only
            }
            finish();
        };

        const animDur = this._getGreenCoinSpineAnimDuration(GREEN_COIN_SPINE_TRANSITION_GOLD);
        const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
        this.scheduleOnce(flipTimeout, Math.max(0.5, animDur * m + 0.2));

        void this._playGreenCoinTransitionToGold(slotNode, key, idx, credit, goldS, finish, flipTimeout);
    }

    private _playGreenCoinTransitionToGold(
        slotNode: Node,
        key: string,
        idx: number,
        credit: number,
        goldS: number,
        finish: () => void,
        flipTimeout: () => void,
    ): Promise<void> {
        return new Promise(resolve => {
            const tmpl = this.greenCoinSpineTemplate;
            if (!tmpl?.isValid || !slotNode?.isValid) {
                this._applyMatsuriFlipResult(slotNode, key, idx, credit);
                if (slotNode?.isValid) slotNode.setScale(goldS, goldS, 1);
                finish();
                resolve();
                return;
            }

            const coinSprite = slotNode.getComponent(Sprite);
            if (coinSprite) coinSprite.enabled = false;

            const fx = this._spawnGreenCoinSpineFxNode(slotNode, GREEN_COIN_SPINE_TRANSITION_GOLD);
            if (!fx) {
                if (coinSprite) coinSprite.enabled = true;
                this._applyMatsuriFlipResult(slotNode, key, idx, credit);
                if (slotNode?.isValid) slotNode.setScale(goldS, goldS, 1);
                finish();
                resolve();
                return;
            }

            const skel = fx.getComponent(sp.Skeleton) ?? fx.getComponentInChildren(sp.Skeleton);
            if (!skel) {
                if (coinSprite) coinSprite.enabled = true;
                this._destroyGreenSpineFx(fx);
                this._applyMatsuriFlipResult(slotNode, key, idx, credit);
                if (slotNode?.isValid) slotNode.setScale(goldS, goldS, 1);
                finish();
                resolve();
                return;
            }

            let done = false;
            let creditRevealed = false;
            const complete = () => {
                if (done) return;
                done = true;
                this.unschedule(revealCreditEarly);
                this.unschedule(flipTimeout);
                this.unschedule(fallback);
                if (skel.isValid) skel.setCompleteListener(null);
                this._destroyGreenSpineFx(fx);
                if (slotNode?.isValid) {
                    this._applyMatsuriFlipResult(slotNode, key, idx, credit);
                    slotNode.setScale(goldS, goldS, 1);
                    if (!creditRevealed) {
                        this._setMatsuriCreditLabelVisible(slotNode, credit > 0, credit);
                    } else {
                        this._raiseCreditLabelAboveSpine(slotNode);
                    }
                }
                finish();
                resolve();
            };

            const revealCreditEarly = () => {
                if (creditRevealed || !slotNode?.isValid) return;
                creditRevealed = true;
                this._setMatsuriCreditLabelVisible(slotNode, credit > 0, credit);
                const cutDelay = Math.max(0.05, this.greenFlipFxCutAfterCredit * m);
                this.scheduleOnce(complete, cutDelay);
            };

            const animDur = this._getGreenCoinSpineAnimDuration(GREEN_COIN_SPINE_TRANSITION_GOLD);
            const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
            const revealLead = Math.max(0.05, this.greenFlipCreditRevealLead);
            const revealDelay = animDur > 0
                ? Math.max(0.06, (animDur - revealLead) * m)
                : 0.06 * m;
            this.scheduleOnce(revealCreditEarly, revealDelay);

            const fallback = () => complete();
            this.scheduleOnce(fallback, Math.max(0.5, animDur * m + 0.12));

            try {
                skel.setCompleteListener(null);
                skel.setAnimation(0, GREEN_COIN_SPINE_TRANSITION_GOLD, false);
            } catch {
                complete();
            }
        });
    }

    private _resolveGreenCoinSpineTemplate(): sp.Skeleton | null {
        const tmpl = this.greenCoinSpineTemplate;
        if (!tmpl?.isValid) return null;
        return tmpl.getComponent(sp.Skeleton) ?? tmpl.getComponentInChildren(sp.Skeleton);
    }

    private _getGreenCoinSpineAnimDuration(animName: string): number {
        const skel = this._resolveGreenCoinSpineTemplate();
        if (!skel?.skeletonData) return 0;
        try {
            const anim = skel.skeletonData.getRuntimeData()?.findAnimation(animName);
            return anim?.duration ?? 0;
        } catch {
            return 0;
        }
    }

    private _greenCoinSpineLayout(): { scale: number; offsetX: number; offsetY: number } {
        const r = this._rowCount;
        if (r >= 5) {
            return {
                scale: this.greenCoinSpineScale5x5,
                offsetX: this.greenCoinSpineOffsetX5x5,
                offsetY: this.greenCoinSpineOffsetY5x5,
            };
        }
        if (r === 4) {
            return {
                scale: this.greenCoinSpineScale5x4,
                offsetX: this.greenCoinSpineOffsetX5x4,
                offsetY: this.greenCoinSpineOffsetY5x4,
            };
        }
        return {
            scale: this.greenCoinSpineScale5x3,
            offsetX: this.greenCoinSpineOffsetX5x3,
            offsetY: this.greenCoinSpineOffsetY5x3,
        };
    }

    private _fitGreenSpineToCoin(fx: Node, _slotNode: Node): void {
        const { scale, offsetX, offsetY } = this._greenCoinSpineLayout();
        const fit = Math.max(0.01, scale);
        fx.setScale(fit, fit, 1);
        fx.setPosition(offsetX, offsetY, 0);
    }

    private _playGreenCoinSpineFxOnce(slotNode: Node, animName: string): Promise<void> {
        return new Promise(resolve => {
            const tmpl = this.greenCoinSpineTemplate;
            if (!tmpl?.isValid || !slotNode?.isValid) {
                resolve();
                return;
            }

            const fx = this._spawnGreenCoinSpineFxNode(slotNode, animName);
            if (!fx) {
                resolve();
                return;
            }

            const skel = fx.getComponent(sp.Skeleton) ?? fx.getComponentInChildren(sp.Skeleton);
            if (!skel) {
                this._destroyGreenSpineFx(fx);
                resolve();
                return;
            }

            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                this.unschedule(fallback);
                if (skel.isValid) skel.setCompleteListener(null);
                this._destroyGreenSpineFx(fx);
                resolve();
            };
            const fallback = () => finish();

            const animDur = this._getGreenCoinSpineAnimDuration(animName);
            this.scheduleOnce(fallback, Math.max(0.5, animDur + 0.12));

            skel.setCompleteListener((entry) => {
                if (entry?.animation?.name && entry.animation.name !== animName) return;
                finish();
            });

            try {
                skel.setAnimation(0, animName, false);
            } catch {
                finish();
            }
        });
    }

    private _startGreenCoinAnimLoop(slotNode: Node): Promise<void> {
        return new Promise(resolve => {
            const tmpl = this.greenCoinSpineTemplate;
            if (!tmpl?.isValid || !slotNode?.isValid) {
                resolve();
                return;
            }

            this.clearGreenCoinAnimLoopAtSlot(slotNode);

            const fx = this._spawnGreenCoinSpineFxNode(slotNode, GREEN_COIN_SPINE_ANIM_LOOP);
            if (!fx) {
                resolve();
                return;
            }

            const skel = fx.getComponent(sp.Skeleton) ?? fx.getComponentInChildren(sp.Skeleton);
            if (!skel) {
                this._destroyGreenSpineFx(fx);
                resolve();
                return;
            }

            this._greenAnimLoopFxBySlot.set(slotNode, fx);

            try {
                skel.setCompleteListener(null);
                skel.setAnimation(0, GREEN_COIN_SPINE_ANIM_LOOP, true);
            } catch {
                this.clearGreenCoinAnimLoopAtSlot(slotNode);
            }
            resolve();
        });
    }

    private _spawnGreenCoinSpineFxNode(slotNode: Node, animName: string): Node | null {
        const tmpl = this.greenCoinSpineTemplate;
        if (!tmpl?.isValid || !slotNode?.isValid) return null;

        const fx = instantiate(tmpl);
        fx.name = `GreenCoinSpineFx_${animName}`;
        fx.setParent(slotNode);
        fx.setPosition(0, 0, 0);
        fx.setRotationFromEuler(0, 0, 0);
        this._fitGreenSpineToCoin(fx, slotNode);
        fx.setSiblingIndex(0);
        fx.active = true;
        this._raiseCreditLabelAboveSpine(slotNode);
        this._activeGreenSpineFx.push(fx);
        return fx;
    }

    private _destroyGreenSpineFx(fx: Node): void {
        if (!fx?.isValid) return;
        for (const [slot, node] of this._greenAnimLoopFxBySlot) {
            if (node === fx) {
                this._greenAnimLoopFxBySlot.delete(slot);
                break;
            }
        }
        const idx = this._activeGreenSpineFx.indexOf(fx);
        if (idx >= 0) this._activeGreenSpineFx.splice(idx, 1);
        fx.destroy();
    }

    private _cleanupGreenSpineFx(): void {
        this._greenAnimLoopFxBySlot.clear();
        const copy = this._activeGreenSpineFx.slice();
        this._activeGreenSpineFx.length = 0;
        for (const fx of copy) {
            if (fx?.isValid) fx.destroy();
        }
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
            this._fitCreditLabelToGrid(labelNode, sn, undefined, slotNode);
            if (sn) {
                sn.setData(safeCredit, 0, 2);
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
            SoundManager.instance?.playSfxByName('sxYellowGreenAppear');
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
