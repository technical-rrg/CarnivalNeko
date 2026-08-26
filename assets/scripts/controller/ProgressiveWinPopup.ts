/**
 * ProgressiveWinPopup - Popup BIG WIN / MEGA WIN / MAJOR WIN / SUPER WIN / EPIC WIN / ULTRA WIN / MONSTER WIN / MAX WIN.
 *
 * ── ĐIỀU KIỆN HIỆN (PS.WinPopup từ API Enter; fallback dưới) ──
 *   BIG WIN    : totalWin ≥ totalBet × 10
 *   MEGA WIN   : totalWin ≥ totalBet × 30
 *   MAJOR WIN  : totalWin ≥ totalBet × 50
 *   SUPER WIN  : totalWin ≥ totalBet × 70
 *   EPIC WIN   : totalWin ≥ totalBet × 100
 *   ULTRA WIN  : totalWin ≥ totalBet × 150
 *   MONSTER WIN: totalWin ≥ totalBet × 200
 *   MAX WIN    : totalWin ≥ totalBet × 300
 *   Normal     : 0× — không hiện popup
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "ProgressiveWinPopup" (bắt đầu inactive).
 *   2. Gắn component này vào node đó.
 *   3. Cấu trúc node con:
 *
 *        ProgressiveWinPopup  ← component này
 *          ├── spineBig         ← sp.Skeleton cho BIG WIN    (bắt đầu inactive)
 *          ├── spineMega        ← sp.Skeleton cho MEGA WIN   (bắt đầu inactive)
 *          ├── spineMajor       ← sp.Skeleton cho MAJOR WIN  (bắt đầu inactive)
 *          ├── spineSuper       ← sp.Skeleton cho SUPER WIN  (bắt đầu inactive)
 *          ├── spineEpic        ← sp.Skeleton cho EPIC WIN   (bắt đầu inactive)
 *          ├── spineUltra       ← sp.Skeleton cho ULTRA WIN  (bắt đầu inactive)
 *          ├── spineMonster     ← sp.Skeleton cho MONSTER WIN(bắt đầu inactive)
 *          ├── spineMax         ← sp.Skeleton cho MAX WIN    (bắt đầu inactive)
 *          ├── particleSet1     ← Particle BIG / MEGA           (bắt đầu inactive)
 *          ├── particleSet2     ← Particle MAJOR / SUPER        (bắt đầu inactive)
 *          ├── particleSet3     ← Particle EPIC / ULTRA         (bắt đầu inactive)
 *          ├── particleSet4     ← Particle MONSTER / MAX        (bắt đầu inactive)
 *          ├── tierLabel        ← Label tên tier ("BIG WIN", "MEGA WIN", ...)
 *          ├── amountLabel      ← Label số tiền (count-up từ 0)
 *          └── clickOverlay     ← Node trong suốt bắt click đóng popup
 *
 * ── FLOW (LINEAR PROGRESSIVE) ──
 *   GameManager gọi showPopup(tier, amount, callback).
 *   1. Activate node, luôn bắt đầu từ spineBig (BIG WIN).
 *   2. Spine play "in" → "loop" + bắt đầu count-up 0 → amount.
 *   3. Khi số tiền vượt ngưỡng MEGA/MAJOR/SUPER/EPIC/ULTRA/MONSTER/MAX: chuyển spine tương ứng,
 *      cập nhật tierLabel + particle set tương ứng (số tiền chạy liên tục, KHÔNG đóng popup).
 *   4. Sau count-up:
 *      - Auto-Spin đang bật  → tự đóng sau autoCloseTimeout giây.
 *      - Không có Auto-Spin  → giữ trạng thái cuối, chờ player bấm.
 *   5. Spine play "out" → delay → deactivate node → callback().
 */

import { _decorator, Component, Node, Label, tween, Vec3, Tween, ParticleSystem } from 'cc';
import { sp } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { AutoSpinManager } from '../manager/AutoSpinManager';
import { GameData } from '../data/GameData';
import { BetManager } from '../manager/BetManager';
import { SoundManager } from '../manager/SoundManager';
import { SpriteNumber } from '../core/SpriteNumber';
import { naturalCountUpValue } from '../core/FormatUtils';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

/** Tương ứng với WinTier enum (BIG=2, MEGA=3, MAJOR=4, SUPER=5, EPIC=6, ULTRA=7, MONSTER=8, MAX=9) */
export const enum ProgressiveWinTier {
    BIG     = 'big_win',
    MEGA    = 'mega_win',
    MAJOR   = 'major_win',
    SUPER   = 'super_win',
    EPIC    = 'epic_win',
    ULTRA   = 'ultra_win',
    MONSTER = 'monster_win',
    MAX     = 'max_win',
}

/** Ngưỡng multiplier fallback (từ cao → thấp). Khớp PS.WinPopup Carnival Neko API V1.0.2. */
export const PROGRESSIVE_WIN_THRESHOLDS = [
    { tier: ProgressiveWinTier.MAX,     multiplier: 300 },
    { tier: ProgressiveWinTier.MONSTER, multiplier: 200 },
    { tier: ProgressiveWinTier.ULTRA,   multiplier: 150 },
    { tier: ProgressiveWinTier.EPIC,    multiplier: 100 },
    { tier: ProgressiveWinTier.SUPER,   multiplier: 70  },
    { tier: ProgressiveWinTier.MAJOR,   multiplier: 50  },
    { tier: ProgressiveWinTier.MEGA,    multiplier: 30  },
    { tier: ProgressiveWinTier.BIG,     multiplier: 10  },
];

@ccclass('ProgressiveWinPopup')
export class ProgressiveWinPopup extends Component {

    // ── EDITOR NODE SLOTS ──────────────────────────────────────────────────────

    /** sp.Skeleton cho BIG WIN (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect BIG WIN\n→ Kéo sp.Skeleton node vào đây' })
    spineBig: sp.Skeleton | null = null;

    /** sp.Skeleton cho MEGA WIN (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect MEGA WIN\n→ Kéo sp.Skeleton node vào đây' })
    spineMega: sp.Skeleton | null = null;

    /** sp.Skeleton cho MAJOR WIN (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect MAJOR WIN\n→ Kéo sp.Skeleton node vào đây' })
    spineMajor: sp.Skeleton | null = null;

    /** sp.Skeleton cho SUPER WIN (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect SUPER WIN\n→ Kéo sp.Skeleton node vào đây' })
    spineSuper: sp.Skeleton | null = null;

    /** sp.Skeleton cho EPIC WIN (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect EPIC WIN\n→ Kéo sp.Skeleton node vào đây' })
    spineEpic: sp.Skeleton | null = null;

    /** sp.Skeleton cho ULTRA WIN (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect ULTRA WIN\n→ Kéo sp.Skeleton node vào đây' })
    spineUltra: sp.Skeleton | null = null;

    /** sp.Skeleton cho MONSTER WIN (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect MONSTER WIN\n→ Kéo sp.Skeleton node vào đây' })
    spineMonster: sp.Skeleton | null = null;

    /** sp.Skeleton cho MAX WIN (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect MAX WIN\n→ Kéo sp.Skeleton node vào đây' })
    spineMax: sp.Skeleton | null = null;

    /** Label tên tier: "BIG WIN", "MEGA WIN", "MAJOR WIN", "SUPER WIN", "EPIC WIN", "ULTRA WIN", "MONSTER WIN", "MAX WIN" */
    @property({ type: Label, tooltip: 'Label tên tier\n→ Kéo Label node vào đây' })
    tierLabel: Label | null = null;

    /**
     * SpriteNumber hiển thị số tiền trúng (count-up).
     * → Kéo Node gắn component SpriteNumber vào đây.
     */
    @property({ type: SpriteNumber, tooltip: 'SpriteNumber node hiển thị số tiền (count-up)\n→ Kéo Node gắn SpriteNumber vào đây' })
    amountDisplay: SpriteNumber | null = null;

    /**
     * Index trong mảng currencySprites của SpriteNumber.
     * -1 = không hiển thị ký hiệu tiền tệ.
     */
    @property({ tooltip: 'Index ký hiệu tiền tệ trong SpriteNumber.currencySprites.\n-1 = không dùng ký hiệu tiền tệ.' })
    currencyIndex: number = 0;

    /** Scale AmountDisplay (SpriteNumber) — dùng setDisplayScale để không bị setData ghi đè */
    @property({ tooltip: 'Scale số tiền (SpriteNumber.setDisplayScale). Vd 1.3 = lớn hơn 30%.' })
    amountDisplayScale: number = 1.3;

    /** Node trong suốt bắt click đóng popup */
    @property({ type: Node, tooltip: 'Node trong suốt bắt click đóng\n→ Tạo Widget fill + kéo vào đây' })
    clickOverlay: Node | null = null;

    /** Node chứa Particle Set 1 (BIG / MEGA) */
    @property({ type: Node, tooltip: 'Particle Set 1 → BIG, MEGA\n→ Kéo Node gắn ParticleSystem vào đây' })
    particleSet1: Node | null = null;

    /** Node chứa Particle Set 2 (MAJOR / SUPER) */
    @property({ type: Node, tooltip: 'Particle Set 2 → MAJOR, SUPER\n→ Kéo Node gắn ParticleSystem vào đây' })
    particleSet2: Node | null = null;

    /** Node chứa Particle Set 3 (EPIC / ULTRA) */
    @property({ type: Node, tooltip: 'Particle Set 3 → EPIC, ULTRA\n→ Kéo Node gắn ParticleSystem vào đây' })
    particleSet3: Node | null = null;

    /** Node chứa Particle Set 4 (MONSTER / MAX) */
    @property({ type: Node, tooltip: 'Particle Set 4 → MONSTER, MAX\n→ Kéo Node gắn ParticleSystem vào đây' })
    particleSet4: Node | null = null;

    /** FX burst khi vào / chuyển tier (nested prefab Popup_Fx_In) */
    @property({ type: Node, tooltip: 'Popup_Fx_In — play 1 lần mỗi khi chuyển win level\n→ Kéo node Popup_Fx_In vào đây' })
    popupFxIn: Node | null = null;

    @property({ tooltip: 'Delay (giây) trước khi play Popup_Fx_In khi chuyển tier mới' })
    popupFxTransitionDelay: number = 0.2;

    // ── ANIMATION PARAMS ─────────────────────────────────────────────────────

    @property({ tooltip: 'Thời gian BIG WIN tier hiển thị (giây)' })
    tierDurationBig: number = 5.0;

    @property({ tooltip: 'Thời gian MEGA WIN tier hiển thị (giây)' })
    tierDurationMega: number = 5.0;

    @property({ tooltip: 'Thời gian MAJOR WIN tier hiển thị (giây)' })
    tierDurationMajor: number = 5.0;

    @property({ tooltip: 'Thời gian SUPER WIN tier hiển thị (giây)' })
    tierDurationSuper: number = 5.0;

    @property({ tooltip: 'Thời gian EPIC WIN tier hiển thị (giây)' })
    tierDurationEpic: number = 5.0;

    @property({ tooltip: 'Thời gian ULTRA WIN tier hiển thị (giây)' })
    tierDurationUltra: number = 5.0;

    @property({ tooltip: 'Thời gian MONSTER WIN tier hiển thị (giây)' })
    tierDurationMonster: number = 5.0;

    @property({ tooltip: 'Thời gian MAX WIN tier hiển thị (giây)' })
    tierDurationMax: number = 5.0;

    @property({ tooltip: 'Timeout tự đóng popup (giây) - NORMAL mode' })
    autoCloseTimeout: number = 5.0;

    @property({ tooltip: 'Delay sau khi play "out" animation trước khi đóng popup (giây)' })
    outAnimCloseDelay: number = 1.0;

    // ── INTERNAL ─────────────────────────────────────────────────────────────

    private _callback: (() => void) | null = null;
    private _isOpen: boolean = false;
    private _isCountingUp: boolean = false;
    private _countUpTarget: number = 0;
    private _countUpCb: (() => void) | null = null;
    private _autoCloseCb: (() => void) | null = null;
    private _outAnimCloseCb: (() => void) | null = null;
    private _activeSpine: sp.Skeleton | null = null;
    private _activeTier: ProgressiveWinTier | null = null;

    // Progressive linear flow state
    private _totalBet: number = 0;
    private _segments: { tier: ProgressiveWinTier; startAmount: number; endAmount: number }[] = [];
    private _currentSegIndex: number = 0;

    /** Vị trí gốc (world) của parent amountDisplay để restore khi đóng popup */
    private _amountDisplayParentOriginalPos: Vec3 | null = null;

    /** NodeA (child[0] của spine đang active) để đồng bộ vị trí */
    private _activeNodeA: Node | null = null;

    /** Callback đồng bộ vị trí mỗi frame */
    private _syncPosCb: (() => void) | null = null;

    /** scheduleOnce play Popup_Fx_In sau delay chuyển tier */
    private _popupFxPlayCb: (() => void) | null = null;

    // ── LIFECYCLE ────────────────────────────────────────────────────────────

    onLoad(): void {
        this.node.active = false;
        if (!this.popupFxIn) {
            this.popupFxIn = this.node.getChildByName('Popup_Fx_In');
        }
        // PROGRESSIVE_WIN_SHOW được PopupLoader xử lý khi lần đầu instantiate prefab.
        // Từ lần thứ hai trở đi, popup đã tồn tại và tự đăng ký listener này.
        EventBus.instance.on(GameEvents.PROGRESSIVE_WIN_SHOW, this._onProgressiveWinShow, this);
    }

    onDestroy(): void {
        this._cleanup();
        EventBus.instance.offTarget(this);
    }

    // ── EVENT HANDLER ────────────────────────────────────────────────────────

    private _onProgressiveWinShow(tier: ProgressiveWinTier, amount: number): void {
        this.showPopup(tier, amount, () => {
            EventBus.instance.emit(GameEvents.PROGRESSIVE_WIN_END);
        });
    }

    // ── PUBLIC API ───────────────────────────────────────────────────────────

    showPopup(tier: ProgressiveWinTier, amount: number, callback: () => void): void {
        Log.d(`[ProgressiveWinPopup] showPopup called — tier=${tier} amount=${amount} _isOpen=${this._isOpen}`);
        if (this._isOpen) return;
        this._isOpen = true;
        this._callback = callback;
        this._totalBet = BetManager.instance.totalBet || 1;

        // Build segments: amount-based thresholds, each segment plays for tierDuration seconds
        this._buildSegments(tier, amount);
        this._currentSegIndex = 0;

        // Deactivate all spines
        for (const s of [this.spineBig, this.spineMega, this.spineMajor, this.spineSuper, this.spineEpic, this.spineUltra, this.spineMonster, this.spineMax]) {
            if (s) s.node.active = false;
        }

        if (this.amountDisplay) {
            this._applyAmountDisplayScale();
            this.amountDisplay.setData(0, this.currencyIndex);
            this.amountDisplay.node.active = false;
            Tween.stopAllByTarget(this.amountDisplay.node);
        }
        this._stopPopupFxIn();

        // Always start with BIG WIN spine
        const startTier = this._segments[0].tier;
        this._activeTier = startTier;
        // Gọi trực tiếp (không chỉ dựa EventBus) — đảm bảo music play khi popup mở
        SoundManager.instance?.startProgressiveWinMusic();
        SoundManager.instance?.playCounterStart();
        this._activeSpine = this._getSpineForTier(startTier);
        if (this.tierLabel) this.tierLabel.string = L(startTier);

        this.node.active = true;
        if (this.node.parent) {
            this.node.setSiblingIndex(999999);
        }

        // Activate overlay early to catch click-skip at any point
        if (this.clickOverlay) {
            this.clickOverlay.active = true;
            this.clickOverlay.on(Node.EventType.TOUCH_END, this._onClickClose, this);
        }

        // Play particle effects for starting tier
        this._playParticleEffects();
        this._playPopupFxIn();

        const startSpine = this._activeSpine;
        if (startSpine) {
            startSpine.node.active = true;
            this._attachAmountDisplayParentToSpine(startSpine);
            startSpine.setAnimation(0, 'in', false);
            startSpine.setCompleteListener(() => {
                startSpine.setCompleteListener(null);
                startSpine.setAnimation(0, 'loop', true);
                if (this.amountDisplay) this.amountDisplay.node.active = true;
                this._startCountUp(0, amount, () => {
                    this._waitForClose();
                });
            });
        } else {
            if (this.amountDisplay) this.amountDisplay.node.active = true;
            this._startCountUp(0, amount, () => {
                this._waitForClose();
            });
        }
    }

    // ── PRIVATE ──────────────────────────────────────────────────────────────

    /**
     * Build count-up segments with amount-based tier thresholds.
     * Each segment = one tier, plays for tierDuration seconds.
     * Transition happens when the counted amount reaches the next tier's threshold.
     * Fine decimal precision is computed per segment based on per-tick increment.
     */
    private _buildSegments(finalTier: ProgressiveWinTier, finalAmount: number): void {
        const tierOrder = [
            ProgressiveWinTier.BIG,
            ProgressiveWinTier.MEGA,
            ProgressiveWinTier.MAJOR,
            ProgressiveWinTier.SUPER,
            ProgressiveWinTier.EPIC,
            ProgressiveWinTier.ULTRA,
            ProgressiveWinTier.MONSTER,
            ProgressiveWinTier.MAX,
        ];
        // Ngưỡng chuyển sang tier kế — lấy PS.WinPopup (GameData.config) sau Enter.
        const cfg = GameData.instance.config;
        const nextThresholdMuls = [
            cfg.megaWinThreshold    || 30,   // BIG    → MEGA
            cfg.majorWinThreshold   || 50,   // MEGA   → MAJOR
            cfg.superWinThreshold   || 70,   // MAJOR  → SUPER
            cfg.epicWinThreshold    || 100,  // SUPER  → EPIC
            cfg.ultraWinThreshold   || 150,  // EPIC   → ULTRA
            cfg.monsterWinThreshold || 200,  // ULTRA  → MONSTER
            cfg.maxWinThreshold     || 300,  // MONSTER → MAX
        ];
        const finalIndex = tierOrder.indexOf(finalTier);

        this._segments = [];
        let curStart = 0;

        for (let i = 0; i <= finalIndex; i++) {
            let endAmount: number;
            if (i < finalIndex) {
                // Clamp intermediate threshold to finalAmount — handles debug/small amounts
                endAmount = Math.min(this._totalBet * nextThresholdMuls[i], finalAmount);
            } else {
                endAmount = finalAmount;
            }

            const range = endAmount - curStart;
            // Break only if range < 0 (impossible) OR if this is NOT the final segment and range = 0
            // Prevents skipping the final tier when finalAmount exactly equals the tier threshold
            if (range < 0) break;
            if (range === 0 && i < finalIndex) break;

            this._segments.push({
                tier: tierOrder[i],
                startAmount: curStart,
                endAmount,
            });
            curStart = endAmount;
        }
        Log.d(`[ProgressiveWinPopup] _buildSegments — finalTier=${finalTier} _totalBet=${this._totalBet} segments=${JSON.stringify(this._segments.map(s => ({ tier: s.tier, start: s.startAmount, end: s.endAmount })))}`);
    }

    private _getTierDuration(segmentIndex: number): number {
        if (segmentIndex < 0 || segmentIndex >= this._segments.length) return 5.0;
        const tier = this._segments[segmentIndex].tier;
        switch (tier) {
            case ProgressiveWinTier.BIG:     return this.tierDurationBig;
            case ProgressiveWinTier.MEGA:    return this.tierDurationMega;
            case ProgressiveWinTier.MAJOR:   return this.tierDurationMajor;
            case ProgressiveWinTier.SUPER:   return this.tierDurationSuper;
            case ProgressiveWinTier.EPIC:    return this.tierDurationEpic;
            case ProgressiveWinTier.ULTRA:   return this.tierDurationUltra;
            case ProgressiveWinTier.MONSTER: return this.tierDurationMonster;
            case ProgressiveWinTier.MAX:     return this.tierDurationMax;
            default:                         return 5.0;
        }
    }

    private _getSpineForTier(tier: ProgressiveWinTier): sp.Skeleton | null {
        switch (tier) {
            case ProgressiveWinTier.BIG:     return this.spineBig;
            case ProgressiveWinTier.MEGA:    return this.spineMega;
            case ProgressiveWinTier.MAJOR:   return this.spineMajor;
            case ProgressiveWinTier.SUPER:   return this.spineSuper;
            case ProgressiveWinTier.EPIC:    return this.spineEpic;
            case ProgressiveWinTier.ULTRA:   return this.spineUltra;
            case ProgressiveWinTier.MONSTER: return this.spineMonster;
            case ProgressiveWinTier.MAX:     return this.spineMax;
        }
    }

    /**
     * Không đổi parent của amountDisplay; thay vào đó đồng bộ worldPosition
     * của parent theo node con index 0 của spine đang active, rồi gán local Y
     * của AmountDisplay theo orientation (landscape / portrait).
     */
    private _attachAmountDisplayParentToSpine(spine: sp.Skeleton): void {
        if (!this.amountDisplay) return;
        const amountNode = this.amountDisplay.node;
        if (!amountNode) return;
        const parentNode = amountNode.parent;
        if (!parentNode) return;

        // Lưu vị trí gốc (world) lần đầu tiên
        if (!this._amountDisplayParentOriginalPos) {
            this._amountDisplayParentOriginalPos = parentNode.getWorldPosition().clone();
        }

        const spineNode = spine.node;
        if (spineNode.children.length === 0) {
            Log.w(`[ProgressiveWinPopup] Spine "${spineNode.name}" has no child at index 0`);
            return;
        }
        this._activeNodeA = spineNode.children[0];

        // Đồng bộ ngay lập tức
        this._syncAmountDisplayPosition();

        // Bắt đầu đồng bộ mỗi frame nếu chưa có
        if (!this._syncPosCb) {
            this._syncPosCb = () => { this._syncAmountDisplayPosition(); };
            this.schedule(this._syncPosCb, 0);
        }
    }

    /** Áp scale cho SpriteNumber — setDisplayScale để setData/shrinkToFit không ghi đè về 1. */
    private _applyAmountDisplayScale(): void {
        if (!this.amountDisplay) return;
        const s = Number.isFinite(this.amountDisplayScale) && this.amountDisplayScale > 0
            ? this.amountDisplayScale
            : 1;
        this.amountDisplay.setDisplayScale(s);
    }

    /** Đồng bộ parent AmountDisplay theo nodeA (giữ local position đã set trong Editor). */
    private _syncAmountDisplayPosition(): void {
        if (!this._activeNodeA || !this.amountDisplay) return;
        const parentNode = this.amountDisplay.node.parent;
        if (!parentNode) return;
        parentNode.setWorldPosition(this._activeNodeA.getWorldPosition());
    }

    /** Khôi phục vị trí gốc của parent amountDisplay và dừng đồng bộ. */
    private _restoreAmountDisplayParent(): void {
        if (this._syncPosCb) {
            this.unschedule(this._syncPosCb);
            this._syncPosCb = null;
        }
        this._activeNodeA = null;

        if (!this.amountDisplay || !this._amountDisplayParentOriginalPos) return;
        const parentNode = this.amountDisplay.node.parent;
        if (!parentNode) return;
        parentNode.setWorldPosition(this._amountDisplayParentOriginalPos);
        this._amountDisplayParentOriginalPos = null;
    }

    /**
     * Transition to a new tier spine while count-up continues uninterrupted.
     * Deactivates current spine, activates new spine, plays "in" → "loop".
     * Updates tierLabel and particle rateOverTime values.
     */
    private _getLevelForTier(tier: ProgressiveWinTier): number {
        switch (tier) {
            case ProgressiveWinTier.BIG:     return 1;
            case ProgressiveWinTier.MEGA:    return 2;
            case ProgressiveWinTier.MAJOR:   return 3;
            case ProgressiveWinTier.SUPER:   return 4;
            case ProgressiveWinTier.EPIC:    return 5;
            case ProgressiveWinTier.ULTRA:   return 6;
            case ProgressiveWinTier.MONSTER: return 7;
            case ProgressiveWinTier.MAX:     return 8;
            default:                         return 1;
        }
    }

    private _transitionToTier(tier: ProgressiveWinTier): void {
        Log.d(`[ProgressiveWinPopup] _transitionToTier → ${tier}`);
        if (this._activeSpine) {
            this._activeSpine.setCompleteListener(null);
            this._activeSpine.node.active = false;
        }

        this._activeTier = tier;
        SoundManager.instance?.playProgressiveWinLevel(this._getLevelForTier(tier));
        const newSpine = this._getSpineForTier(tier);
        this._activeSpine = newSpine;

        if (this.tierLabel) this.tierLabel.string = L(tier);
        this._switchParticleSet(tier);
        this._playPopupFxIn(this.popupFxTransitionDelay);

        if (newSpine) {
            newSpine.node.active = true;
            this._attachAmountDisplayParentToSpine(newSpine);
            newSpine.setAnimation(0, 'in', false);
            newSpine.setCompleteListener(() => {
                newSpine.setCompleteListener(null);
                // Guard: only switch to loop if this spine is still the active one
                if (this._activeSpine === newSpine) {
                    newSpine.setAnimation(0, 'loop', true);
                }
            });
        } else {
            Log.w(`[ProgressiveWinPopup] _transitionToTier → ${tier} has NO SPINE assigned!`);
        }
    }

    private _startCountUp(from: number, to: number, onDone: () => void): void {
        if (!this.amountDisplay) { onDone(); return; }
        this._stopCountUp();
        this._isCountingUp = true;
        this._countUpTarget = to;
        this._currentSegIndex = 0;
        this.amountDisplay?.beginCountUp();

        // Total duration = sum of each segment's tier duration
        const totalDuration = this._segments.reduce((sum, seg, idx) => sum + this._getTierDuration(idx), 0);
        Log.d(`[ProgressiveWinPopup] _startCountUp — segments=${this._segments.length} totalDuration=${totalDuration}`);
        const interval = 1 / 30;
        let elapsed = 0;
        let soundStarted = false;

        // Lock width with 3 decimal capacity so fractional part can scroll during count-up
        this.amountDisplay.lockWidth(to, this.currencyIndex, 3);

        const isInteger = (v: number) => Number.isInteger(v) || Math.abs(v - Math.round(v)) < 0.0005;

        this._countUpCb = () => {
            elapsed += interval;

            // Phát âm thanh lần đầu tiên khi giá trị bắt đầu tăng
            if (!soundStarted && elapsed > 0) {
                soundStarted = true;
                SoundManager.instance?.playCoinLoop();
            }

            // Determine current segment by cumulative elapsed time.
            // When elapsed >= totalDuration, clamp to the last segment (do NOT leave segIndex at 0).
            let segStartTime = 0;
            let segIndex = this._segments.length - 1;
            for (let i = 0; i < this._segments.length; i++) {
                const segDuration = this._getTierDuration(i);
                if (elapsed < segStartTime + segDuration) {
                    segIndex = i;
                    break;
                }
                segStartTime += segDuration;
                if (i === this._segments.length - 1) {
                    // Past all segments — keep last segment's start time for localT=1
                    segStartTime -= segDuration;
                }
            }

            // Transition tier when segment changes
            if (segIndex > this._currentSegIndex) {
                this._currentSegIndex = segIndex;
                this._transitionToTier(this._segments[segIndex].tier);
            }

            const seg = this._segments[segIndex];
            const segDuration = Math.max(this._getTierDuration(segIndex), 0.0001);
            const localT = Math.min(Math.max((elapsed - segStartTime) / segDuration, 0), 1);
            // Natural count-up: tránh pattern đều (11.111→22.222) khi đích là số tròn
            const cur = naturalCountUpValue(seg.startAmount, seg.endAmount, localT, 3);
            this.amountDisplay!.setData(cur, this.currencyIndex, 3);

            // Finish when time is up OR amount already reached target.
            // Zero-range trailing segments (finalAmount == tier threshold) reach `to` early;
            // without this check, coin-loop/jolt keep running for the leftover tierDuration
            // and _waitForClose (autoCloseTimeout) never starts.
            const reachedTarget = cur >= to - 1e-9;
            if (elapsed >= totalDuration || reachedTarget) {
                // Ensure final tier spine is showing before we hand off to _waitForClose
                const finalSeg = this._segments[this._segments.length - 1];
                if (this._activeTier !== finalSeg.tier) {
                    this._currentSegIndex = this._segments.length - 1;
                    this._transitionToTier(finalSeg.tier);
                }

                this._isCountingUp = false;
                this.amountDisplay!.endCountUp();
                if (isInteger(to)) {
                    this.amountDisplay!.setData(Math.floor(to), this.currencyIndex, 0);
                } else {
                    const toTrunc = Math.floor(to * 1000) / 1000;
                    this.amountDisplay!.setData(toTrunc, this.currencyIndex, 3);
                }
                this.amountDisplay!.unlockWidth();
                this._stopCountUp();
                SoundManager.instance?.stopCoinLoop();
                SoundManager.instance?.playCoinEnd();
                Log.d(`[ProgressiveWinPopup] count-up DONE — elapsed=${elapsed.toFixed(2)}s totalDuration=${totalDuration.toFixed(2)}s reachedTarget=${reachedTarget} finalTier=${this._activeTier}`);
                onDone();
            }
        };
        this.schedule(this._countUpCb, interval);
    }

    private _stopCountUp(): void {
        if (this._countUpCb) {
            this.unschedule(this._countUpCb);
            this._countUpCb = null;
        }
        SoundManager.instance?.stopCoinLoop();
    }

    private _waitForClose(): void {
        const multiplier = AutoSpinManager.instance.getTimingMultiplier();
        const timeout = this.autoCloseTimeout * multiplier;
        this._autoCloseCb = () => { this._autoCloseCb = null; this._closePopup(); };
        this.scheduleOnce(this._autoCloseCb, timeout);
    }

    private _onClickClose(): void {
        SoundManager.instance?.playButtonClick();
        if (this._autoCloseCb) {
            this.unschedule(this._autoCloseCb);
            this._autoCloseCb = null;
        }
        if (this._isCountingUp) {
            // Skip count-up: play mx_progressive_win_skip once, jump to final amount.
            // Lần click sau (đóng popup) không gọi lại — _closePopup sẽ play sx_banner_disappear.
            SoundManager.instance?.stopProgressiveWinMusic();
            this._isCountingUp = false;
            this._stopCountUp();

            // Force transition to the final tier if not already there
            const finalSeg = this._segments[this._segments.length - 1];
            const finalTier = finalSeg.tier;
            if (this._activeTier !== finalTier) {
                this._currentSegIndex = this._segments.length - 1;
                // Skip "in" anim on skip — go straight to loop
                if (this._activeSpine) {
                    this._activeSpine.setCompleteListener(null);
                    this._activeSpine.node.active = false;
                }
                this._activeTier = finalTier;
                const finalSpine = this._getSpineForTier(finalTier);
                this._activeSpine = finalSpine;
                if (finalSpine) {
                    finalSpine.node.active = true;
                    this._attachAmountDisplayParentToSpine(finalSpine);
                    finalSpine.setAnimation(0, 'loop', true);
                }
                if (this.tierLabel) this.tierLabel.string = L(finalTier);
                this._switchParticleSet(finalTier);
            }

            const to = this._countUpTarget;
            const isInt = Number.isInteger(to) || Math.abs(to - Math.round(to)) < 0.0005;
            this.amountDisplay?.endCountUp();
            if (isInt) {
                this.amountDisplay?.setData(Math.floor(to), this.currencyIndex, 0);
            } else {
                const toTrunc = Math.floor(to * 1000) / 1000;
                this.amountDisplay?.setData(toTrunc, this.currencyIndex, 3);
            }
            this.amountDisplay?.unlockWidth();
            SoundManager.instance?.stopCoinLoop();
            SoundManager.instance?.playCoinEnd();

            // After skip: close after a brief pause (auto-spin → shorter)
            const isAutoSpin = AutoSpinManager.instance.autoSpinCount > 0;
            const skipDelay = isAutoSpin ? 0.8 : 1.5;
            this._autoCloseCb = () => { this._autoCloseCb = null; this._closePopup(); };
            this.scheduleOnce(this._autoCloseCb, skipDelay);
            return;
        }
        this._closePopup();
    }

    private _closePopup(): void {
        if (!this._isOpen) return;
        this._isOpen = false;
        SoundManager.instance?.stopCoinLoop();

        if (this.clickOverlay) {
            this.clickOverlay.off(Node.EventType.TOUCH_END, this._onClickClose, this);
            this.clickOverlay.active = false;
        }

        this._isCountingUp = false;
        this._stopCountUp();
        this._clearAllParticleSystems();

        const spine = this._activeSpine;
        if (spine) {
            // Play "out" animation ngay, không đợi xong
            spine.setAnimation(0, 'out', false);
            // Phát sx_banner_disappear ngay khi spine animation "out" bắt đầu
            SoundManager.instance?.playBannerDisappear();
            // Scale amountDisplay thu nhỏ theo chiều X về 0 (Y giữ nguyên), nhanh hơn 'out'
            if (this.amountDisplay) {
                Tween.stopAllByTarget(this.amountDisplay.node);
                const sy = this.amountDisplay.node.scale.y;
                tween(this.amountDisplay.node)
                    .to(0.1, { scale: new Vec3(0, sy, 1) })
                    .start();
            }
            spine.setCompleteListener(null); // Không nghe completion, delay thôi
            // Delay rồi đóng popup
            if (this._outAnimCloseCb) {
                this.unschedule(this._outAnimCloseCb);
            }
            this._outAnimCloseCb = () => {
                this._outAnimCloseCb = null;
                this._finishClose();
            };
            this.scheduleOnce(this._outAnimCloseCb, this.outAnimCloseDelay);
        } else {
            this._finishClose();
        }
    }

    private _finishClose(): void {
        this._restoreAmountDisplayParent();
        this.node.active = false;
        this._activeSpine = null;
        // Reset scale của amountDisplay để sẵn sàng cho lần show tiếp theo
        if (this.amountDisplay) {
            Tween.stopAllByTarget(this.amountDisplay.node);
            this._applyAmountDisplayScale();
        }
        const cb = this._callback;
        this._callback = null;
        cb?.();
    }

    /** Lấy tất cả ParticleSystem từ node (bản thân + children) */
    private _getParticlesFrom(node: Node): any[] {
        const results: any[] = [];
        const self = node.getComponent('cc.ParticleSystem');
        if (self) results.push(self);
        for (const child of node.children) {
            const ps = child.getComponent('cc.ParticleSystem');
            if (ps) results.push(ps);
        }
        return results;
    }

    /** Particle set index (1–4) for tier — 2 wins share one set. */
    private _getParticleSetIndexForTier(tier: ProgressiveWinTier): number {
        switch (tier) {
            case ProgressiveWinTier.BIG:
            case ProgressiveWinTier.MEGA:
                return 1;
            case ProgressiveWinTier.MAJOR:
            case ProgressiveWinTier.SUPER:
                return 2;
            case ProgressiveWinTier.EPIC:
            case ProgressiveWinTier.ULTRA:
                return 3;
            case ProgressiveWinTier.MONSTER:
            case ProgressiveWinTier.MAX:
                return 4;
            default:
                return 1;
        }
    }

    private _getParticleSetByIndex(index: number): Node | null {
        switch (index) {
            case 1: return this.particleSet1;
            case 2: return this.particleSet2;
            case 3: return this.particleSet3;
            case 4: return this.particleSet4;
            default: return null;
        }
    }

    private _allParticleSets(): (Node | null)[] {
        return [this.particleSet1, this.particleSet2, this.particleSet3, this.particleSet4];
    }

    /** Bật tích lũy particle set 1..N — set cũ vẫn giữ khi lên tier cao hơn. */
    private _switchParticleSet(tier: ProgressiveWinTier): void {
        const maxIndex = this._getParticleSetIndexForTier(tier);
        for (let i = 1; i <= maxIndex; i++) {
            const node = this._getParticleSetByIndex(i);
            if (!node) continue;
            if (!node.active) {
                node.active = true;
                for (const p of this._getParticlesFrom(node)) {
                    p.stop();
                    p.play();
                }
            }
        }
    }

    private _playParticleEffects(): void {
        this._switchParticleSet(this._activeTier!);
    }

    /** Dừng và xóa sạch mọi particle trong popup (gọi khi bắt đầu anim out). */
    private _clearAllParticleSystems(): void {
        if (this._popupFxPlayCb) {
            this.unschedule(this._popupFxPlayCb);
            this._popupFxPlayCb = null;
        }
        for (const ps of this.node.getComponentsInChildren(ParticleSystem)) {
            try {
                ps.stop();
                ps.clear();
            } catch (e) {
                Log.w('[ProgressiveWinPopup] skip broken particle on clear', e);
            }
        }
        for (const node of [...this._allParticleSets(), this.popupFxIn]) {
            if (node) node.active = false;
        }
    }

    private _stopParticleEffects(): void {
        for (const node of this._allParticleSets()) {
            if (!node) continue;
            node.active = false;
            for (const p of this._getParticlesFrom(node)) {
                p.stop();
            }
        }
    }

    /** Play Popup_Fx_In particle burst một lần. delay>0 = chờ trước khi play (chuyển tier). */
    private _playPopupFxIn(delay = 0): void {
        if (!this.popupFxIn) return;
        if (this._popupFxPlayCb) {
            this.unschedule(this._popupFxPlayCb);
            this._popupFxPlayCb = null;
        }
        if (delay > 0) {
            this._popupFxPlayCb = () => {
                this._popupFxPlayCb = null;
                this._playPopupFxInNow();
            };
            this.scheduleOnce(this._popupFxPlayCb, delay);
            return;
        }
        this._playPopupFxInNow();
    }

    private _playPopupFxInNow(): void {
        if (!this.popupFxIn) return;
        this.popupFxIn.active = true;
        const systems = this.popupFxIn.getComponentsInChildren(ParticleSystem);
        for (const ps of systems) {
            ps.stop();
            ps.clear();
            ps.play();
        }
    }

    private _stopPopupFxIn(): void {
        if (this._popupFxPlayCb) {
            this.unschedule(this._popupFxPlayCb);
            this._popupFxPlayCb = null;
        }
        if (!this.popupFxIn) return;
        const systems = this.popupFxIn.getComponentsInChildren(ParticleSystem);
        for (const ps of systems) {
            ps.stop();
        }
        this.popupFxIn.active = false;
    }

    private _cleanup(): void {
        this._restoreAmountDisplayParent();
        this._clearAllParticleSystems();
        this._stopCountUp();
        if (this._autoCloseCb) {
            this.unschedule(this._autoCloseCb);
            this._autoCloseCb = null;
        }
        if (this._outAnimCloseCb) {
            this.unschedule(this._outAnimCloseCb);
            this._outAnimCloseCb = null;
        }
        for (const s of [this.spineBig, this.spineMega, this.spineMajor, this.spineSuper, this.spineEpic, this.spineUltra, this.spineMonster, this.spineMax]) {
            if (s) s.setCompleteListener(null);
        }
    }
}
