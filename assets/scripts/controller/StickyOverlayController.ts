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
    _decorator, Component, Node, Sprite, SpriteFrame, UIOpacity, tween, Vec3, Tween,
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
            '15 CoinSlot nodes theo thứ tự: index = reel * 3 + row\n' +
            '(row: 0=Bottom, 1=Mid, 2=Top visual)\n' +
            '[0]=R0_Bot [1]=R0_Mid [2]=R0_Top  [3]=R1_Bot ... [14]=R4_Top\n' +
            'Mỗi node cần Sprite component (coin image) + optional child "CreditLabel" (SpriteNumber).',
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

    /** Slots that are only a temporary +1 visual, not real stickyCells. */
    private _tempPlusOneKeys: Set<string> = new Set();

    private _coinSlotOriginalParents: Map<Node, { parent: Node | null; siblingIndex: number; spinCounter: number }> = new Map();

    private _topUpSpinCounter: number = 0;
    /** Mốc kết thúc land-bounce vàng/xanh gần nhất; absorb phải chờ qua mốc này. */
    private _goldLandBounceEndMs: number = 0;

    /** true trong _refreshAll lần đầu vào TopUp — nhún chậm + stagger. */
    private _isEnteringTopUp: boolean = false;
    /**
     * true khi đang có TransitionPopup TopUp:
     * setup coin dưới overlay lúc TOPUP_START (sau READY), chỉ nhún sau TOPUP_TRANSITION_DONE.
     */
    private _deferEnterAnim: boolean = false;
    private _pendingEnterAnim: boolean = false;
    private _enterAnimPlayed: boolean = false;

    // ── LIFECYCLE ──────────────────────────────────────────────────────────────

    onLoad(): void {
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

        // Defer inactive: nếu set active=false ngay trong onLoad, child TopUpManager
        // có thể chưa kịp onLoad khi lazy-instantiate Prefab.
        // Đang ở TopUp (resume / vừa set mode) → giữ active, chờ TOPUP_START refresh.
        this.scheduleOnce(() => {
            if (GameData.instance.currentMode !== 'respin') {
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
        if (GameData.instance.currentMode !== 'respin') {
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
        this.clearTempPlusOne('topup-start');
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

    /** Fade-in overlay + bounce stagger lần đầu vào TopUp. */
    private _playEnterAnim(): void {
        if (this._enterAnimPlayed) return;
        this._enterAnimPlayed = true;
        this._pendingEnterAnim = false;
        this._deferEnterAnim = false;
        this.node.active = true;
        this._previouslyActiveSlots.clear();
        this._fadeInOverlay();
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
        // Gọi sau mỗi spin Topup kết thúc — stickyCells đã được cập nhật bởi GameManager
        this._refreshAll(true /* chỉ fade in coin MỚI */);
    }

    private _onReelsStartSpin(): void {
        // ★ Khi bắt đầu spin tiếp theo: PLUS_ONE_SPIN đã bị xóa khỏi stickyCells
        // Refresh overlay để ẩn ngay các slot +1 Spin (và giữ lại coin thật)
        if (this.node.active) {
            this._topUpSpinCounter++;
            this._restoreCoinSlotParents(this._topUpSpinCounter);
            this.clearTempPlusOne('reels-start-spin');
            this._refreshAll(true /* chỉ fade in coin MỚI, coin cũ giữ nguyên */);
        }
    }

    private _onTopUpEnd(): void {
        this.clearTempPlusOne('topup-end');
        this._restoreCoinSlotParents();
        this._hideAll();
        this._previouslyActiveSlots.clear();
        this._slotCreditMap.clear();
        this._coinSlotOriginalParents.clear();
        this._topUpSpinCounter = 0;
        this._goldLandBounceEndMs = 0;
        this._deferEnterAnim = false;
        this._pendingEnterAnim = false;
        this._enterAnimPlayed = false;
        this.node.active = false;
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
        Log.e(`[SOC-DEBUG] stickyCells: ${cells.size === 0 ? '(empty)' : Array.from(cells.entries()).map(([k, c]) => `${k}=${c.symbolId === SymbolId.STICKY_YELLOW ? 'YELLOW' : c.symbolId === SymbolId.STICKY_GREEN ? 'GREEN' : c.symbolId === SymbolId.STICKY_RED ? 'RED' : c.symbolId}($${c.credit})`).join(', ')}`);
        // ═══ END DEBUG ═══

        const isEnter = this._isEnteringTopUp;

        for (let reel = 0; reel < 5; reel++) {
            for (let row = 0; row < 3; row++) {
                const key      = `${reel}-${row}`;
                const idx      = reel * 3 + row;
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
                    this._tempPlusOneKeys.delete(key);
                    slotNode.setScale(1, 1, 1);
                    slotNode.active = false;
                    continue;
                }

                this._tempPlusOneKeys.delete(key);

                // Track active slots
                newActiveSlots.add(key);

                // Detect if this is a NEW coin (wasn't in previous set)
                const isNewCoin = !this._previouslyActiveSlots.has(key);
                const isAbsorbTarget = isNewCoin && (
                    cell.symbolId === SymbolId.STICKY_YELLOW ||
                    cell.symbolId === SymbolId.STICKY_GREEN
                );
                const creditToShow = isAbsorbTarget ? 0 : (cell.credit ?? 0);
                if (idx < 3 || cell.symbolId !== SymbolId.STICKY_RED) {
                    Log.e(
                        `[TOPUP-ENTER-CHECK][OVERLAY] idx=${idx} node=${slotNode.name} key=${key}` +
                        ` sym=${SymbolId[cell.symbolId] ?? cell.symbolId} credit=${cell.credit ?? 0}` +
                        ` fadeOnlyNew=${fadeOnlyNew} isNew=${isNewCoin}`
                    );
                }
                Log.e(`[SOC-DEBUG]   slot[${key}] idx=${idx} isNew=${isNewCoin} absorb=${isAbsorbTarget} sym=${cell.symbolId} credit=${cell.credit} showCredit=${creditToShow}`);

                // Áp dụng sprite + credit
                // NEW Yellow/Green: KHÔNG set credit — TopUpAbsorbEffect sẽ count-up
                // Existing coins hoặc Red: hiển thị credit bình thường
                this._applyCoin(slotNode, cell.symbolId, creditToShow);
                slotNode.active = true;
                if (isNewCoin) {
                    this._reparentToStickyOverlay(slotNode);
                }

                const isGoldCoin = cell.symbolId === SymbolId.STICKY_YELLOW
                    || cell.symbolId === SymbolId.STICKY_GREEN;

                if (!animate) {
                    // Setup tĩnh dưới Transition — chờ DONE mới fade/bounce
                    Tween.stopAllByTarget(slotNode);
                    const restOp = slotNode.getComponent(UIOpacity) ?? slotNode.addComponent(UIOpacity);
                    Tween.stopAllByTarget(restOp);
                    restOp.opacity = 255;
                    slotNode.setScale(this._getBaseScale(cell.symbolId), this._getBaseScale(cell.symbolId), 1);
                    continue;
                }

                // Fade in + Bounce: chỉ cho coin MỚI hoặc lần đầu mở (fadeOnlyNew=false)
                if (!fadeOnlyNew || isNewCoin) {
                    // Land vàng/xanh: reel Mid giữ nguyên; overlay nhún giống sticky đỏ normal
                    // (0.85 → peak → settle 1), phủ lên trên.
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
                const reel = Math.floor(idx / 3);
                const row = idx % 3;
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
            case SymbolId.STICKY_RED: return 0;
            case SymbolId.STICKY_YELLOW: return 1;
            case SymbolId.STICKY_GREEN: return 2;
            default: return -1;
        }
    }

    /**
     * Hiển thị tạm một coin slot (dùng cho +1 Spin hoặc effect đặc biệt).
     * Trả về node slot để caller dùng làm điểm xuất phát effect.
     * Gọi hideTempCoin() sau khi xong.
     */
    showTempCoin(reel: number, row: number, symbolId: number, allowPlusOne: boolean = false): Node | null {
        const idx      = reel * 3 + row;
        const slotNode = this.coinSlots[idx];
        if (!slotNode) return null;
        const key = `${reel}-${row}`;
        if (symbolId === SymbolId.PLUS_ONE_SPIN && !allowPlusOne) {
            Log.e(`[TOPUP-PLUS] BLOCK showTempCoin +1 key=${key} idx=${idx} reason=missingAllowToken`);
            return null;
        }

        const frameIdx = this._symbolToFrameIndex(symbolId);
        const sprite   = slotNode.getComponent(Sprite);
        if (sprite && frameIdx >= 0 && this.coinFrames[frameIdx]) {
            sprite.spriteFrame = this.coinFrames[frameIdx];
        }
        Tween.stopAllByTarget(slotNode);
        const op = slotNode.getComponent(UIOpacity);
        if (op) {
            Tween.stopAllByTarget(op);
            op.opacity = 255;
        }
        slotNode.setScale(1, 1, 1);
        slotNode.active = true;

        // Ẩn CreditLabel cho slot tạm thời
        const labelNode = slotNode.getChildByName('CreditLabel');
        if (labelNode) {
            Tween.stopAllByTarget(labelNode);
            labelNode.active = false;
            labelNode.setScale(1, 1, 1);
        }
        this._slotCreditMap.delete(slotNode);
        if (symbolId === SymbolId.PLUS_ONE_SPIN) {
            this._tempPlusOneKeys.add(key);
            Log.e(`[TOPUP-PLUS] showTempCoin key=${key} idx=${idx} node=${slotNode.name}`);
        }

        return slotNode;
    }

    /** Ẩn slot tạm thời sau khi effect xong (nếu không có coin sticky thật tại vị trí đó). */
    hideTempCoin(reel: number, row: number): void {
        const key = `${reel}-${row}`;
        this._tempPlusOneKeys.delete(key);
        // Chỉ ẩn nếu không có sticky coin thật tại vị trí này
        if (!GameData.instance.stickyCells.has(key)) {
            const idx      = reel * 3 + row;
            const slotNode = this.coinSlots[idx];
            if (slotNode) this._hideTempSlot(slotNode);
        }
    }

    /**
     * Clear every temporary +1 visual that is not backed by a real sticky coin.
     * This prevents a +1 from a previous spin from looking like a new server result.
     */
    public clearTempPlusOne(reason: string = 'manual'): void {
        if (this._tempPlusOneKeys.size === 0) return;
        const keys = Array.from(this._tempPlusOneKeys);
        for (const key of keys) {
            const realCell = GameData.instance.stickyCells.get(key);
            if (realCell && realCell.symbolId !== SymbolId.PLUS_ONE_SPIN) {
                const [reelStr, rowStr] = key.split('-');
                const reel = Number(reelStr);
                const row = Number(rowStr);
                const idx = reel * 3 + row;
                const slotNode = this.coinSlots[idx];
                if (slotNode) {
                    this._applyCoin(slotNode, realCell.symbolId, realCell.credit ?? 0);
                    this._applyBaseScale(slotNode, realCell.symbolId);
                    slotNode.active = true;
                    Log.e(`[TOPUP-PLUS] restore real sticky after temp +1 key=${key} symbol=${SymbolId[realCell.symbolId] ?? realCell.symbolId}`);
                }
                this._tempPlusOneKeys.delete(key);
                continue;
            }
            const [reelStr, rowStr] = key.split('-');
            const reel = Number(reelStr);
            const row = Number(rowStr);
            const idx = reel * 3 + row;
            const slotNode = this.coinSlots[idx];
            if (slotNode) this._hideTempSlot(slotNode);
            this._tempPlusOneKeys.delete(key);
        }
        Log.e(`[TOPUP-PLUS] clearTempPlusOne reason=${reason} keys=${keys.join('|') || 'none'}`);
    }

    private _hideTempSlot(slotNode: Node): void {
        Tween.stopAllByTarget(slotNode);
        const op = slotNode.getComponent(UIOpacity);
        if (op) {
            Tween.stopAllByTarget(op);
            op.opacity = 255;
        }
        const labelNode = slotNode.getChildByName('CreditLabel');
        if (labelNode) {
            Tween.stopAllByTarget(labelNode);
            labelNode.active = false;
            labelNode.setScale(1, 1, 1);
        }
        this._slotCreditMap.delete(slotNode);
        slotNode.setScale(1, 1, 1);
        slotNode.active = false;
    }

    /** Tìm CreditLabel child — fallback getComponentInChildren(SpriteNumber) cho nested prefab. */
    private _resolveCreditLabel(slotNode: Node): { labelNode: Node | null; sn: SpriteNumber | null } {
        let labelNode = slotNode.getChildByName('CreditLabel');
        let sn = labelNode?.getComponent(SpriteNumber) ?? null;
        if (!sn) {
            sn = slotNode.getComponentInChildren(SpriteNumber);
            if (sn) labelNode = sn.node;
        }
        return { labelNode, sn };
    }

    /** Red luôn hiện label; Yellow/Green chỉ hiện khi đã có credit (sau absorb). */
    private _shouldShowCreditLabel(symbolId: number, credit: number): boolean {
        if (symbolId === SymbolId.STICKY_RED) return true;
        return credit > 0;
    }

    /**
     * Áp dụng loại coin + credit value lên 1 slotNode.
     * @param symbolId  SymbolId.STICKY_RED / YELLOW / GREEN
     * @param credit    Giá trị credit (>= 0, luôn hiển thị CreditLabel)
     */
    private _applyCoin(slotNode: Node, symbolId: number, credit: number): void {
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
        // Red: luôn hiện label (kể cả credit=0). Yellow/Green: ẩn cho đến khi absorb xong.
        const displayCredit = credit > 0 ? credit : safeLastCredit;
        const shouldActive  = this._shouldShowCreditLabel(symbolId, displayCredit);
        const { labelNode, sn } = this._resolveCreditLabel(slotNode);
        if (labelNode) {
            if (sn) {
                if (creditChanged || shouldActive) {
                    Log.e(`[STICKY-LABEL] _applyCoin ${slotNode.name} setData(${displayCredit}) sn=OK`);
                    sn.setData(Math.max(0, displayCredit));
                    Log.d(`[StickyOverlay] apply ${slotNode.name} symbol=${symbolId} credit=${displayCredit}`);
                }
            } else {
                Log.e(`[StickyOverlay] Missing SpriteNumber on ${slotNode.name}/CreditLabel`);
            }
            if (creditChanged) {
                labelNode.setRotationFromEuler(0, 0, 0);
            }
            Log.e(`[STICKY-LABEL] _applyCoin ${slotNode.name} credit=${credit} lastCredit=${safeLastCredit} active→${shouldActive} (was=${labelNode.active})`);
            labelNode.active = shouldActive;
        } else {
            Log.e(`[StickyOverlay] Missing CreditLabel on ${slotNode.name}`);
        }

        this._slotCreditMap.set(slotNode, Math.max(0, displayCredit));
    }

    /**
     * Map SymbolId → coinFrames index.
     * RED=0, YELLOW=1, GREEN=2. Trả -1 nếu không map được.
     */
    private _symbolToFrameIndex(symbolId: number): number {
        switch (symbolId) {
            case SymbolId.STICKY_RED:    return 0;
            case SymbolId.STICKY_YELLOW: return 1;
            case SymbolId.STICKY_GREEN:  return 2;
            case SymbolId.PLUS_ONE_SPIN: return 3; // coinFrames[3] = +1 Spin sprite
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
            for (let row = 0; row < 3; row++) {
                const coinIdx = reelIdx * 3 + row;
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
     *   index = reel * 3 + row  (row 0 = Bottom, 1 = Mid, 2 = Top visual).
     */
    alignPositionsFromTopUpManager(): void {
        // Ưu tiên TopUpManager trong cùng prefab hierarchy (lazy-loaded), fallback scene scan.
        const topUpMgr = this.node.getComponentInChildren(TopUpManager)
            ?? this.node.parent?.getComponentInChildren(TopUpManager)
            ?? this.node.scene?.getComponentInChildren(TopUpManager)
            ?? null;
        if (!topUpMgr) {
            Log.e('[StickyOverlay] alignPositionsFromTopUpManager: TopUpManager not found.');
            return;
        }

        if (topUpMgr.reels.length !== 15) {
            Log.w(`[StickyOverlay] alignPositionsFromTopUpManager: reels.length=${topUpMgr.reels.length} (expected 15).`);
        }

        const count = Math.min(topUpMgr.reels.length, this.coinSlots.length);
        for (let i = 0; i < count; i++) {
            const reel = topUpMgr.reels[i];
            const slotNode = this.coinSlots[i];
            if (!reel || !slotNode) continue;

            const symbolNode = reel.symbolNodes[1]; // Mid node = tâm ô
            if (!symbolNode) continue;

            slotNode.setWorldPosition(symbolNode.worldPosition);
        }

        Log.d(`[StickyOverlay] alignPositionsFromTopUpManager — synced ${count} slots.`);
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
        const reel = Math.floor(idx / 3);
        const row = idx % 3;
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

        if (GameData.instance.currentMode === 'respin' && isGoldCoin) {
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
