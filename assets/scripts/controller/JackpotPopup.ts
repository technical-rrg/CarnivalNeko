/**
 * JackpotPopup - Popup chúc mừng trúng hũ Jackpot (Grand / Major / Minor / Mini).
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "JackpotPopup" (bắt đầu inactive).
 *   2. Gắn component này vào node đó.
 *   3. Cấu trúc node con:
 *
 *        JackpotPopup  ← component này
 *          ├── spineGrand       ← sp.Skeleton cho GRAND  (bắt đầu inactive)
 *          ├── spineMajor       ← sp.Skeleton cho MAJOR  (bắt đầu inactive)
 *          ├── spineMinor       ← sp.Skeleton cho MINOR  (bắt đầu inactive)
 *          ├── spineMini        ← sp.Skeleton cho MINI   (bắt đầu inactive)
 *          ├── titleLabel       ← Label tên hũ ("GRAND JACKPOT", ...)
 *          ├── amountDisplay    ← Node gắn SpriteNumber (count-up từ 0)
 *          ├── clickOverlay     ← Node trong suốt bắt click đóng popup
 *          └── particleNodeOrientationBased ← Node chứa ParticleSystem với scale theo orientation
 *
 * ── FLOW ──
 *   GameManager / EventBus gửi JACKPOT_TRIGGER(jackpotType, amount).
 *   1. Activate node; đặt đúng spine theo jackpotType.
 *   2. Spine play "in" → "loop" + bắt đầu count-up 0 → amount trong countUpDuration giây.
 *   3. Sau count-up (chạy hết hoặc skip): tự đóng sau autoCloseTimeout giây.
 *   4. Bấm vào:
 *      - Nếu đang count-up → nhảy thẳng tới tiền max, rồi đợi autoCloseTimeout rồi tự đóng.
 *        Click lần nữa trong lúc đợi → đóng ngay.
 *      - Nếu count-up xong (đang đợi auto-close) → đóng popup ngay.
 *   5. Spine play "out" (nếu có) → delay outAnimCloseDelay → deactivate node → callback().
 *      Không có anim "out" → đóng ngay, không treo game.
 */

import { _decorator, Component, Node, Label, ParticleSystem, tween, Vec3, Tween, screen, UIMeshRenderer } from 'cc';
import { sp } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { JackpotType } from '../data/SlotTypes';
import { L } from '../core/LocalizationManager';
import { AutoSpinManager } from '../manager/AutoSpinManager';
import { GameData } from '../data/GameData';
import { SoundManager } from '../manager/SoundManager';
import { SpriteNumber } from '../core/SpriteNumber';
import { naturalCountUpValue } from '../core/FormatUtils';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

/** Map JackpotType → localization key */
const JACKPOT_L10N_KEYS: Record<number, string> = {
    [JackpotType.GRAND]:  'grand_jackpot',
    [JackpotType.MAJOR]:  'major_jackpot',
    [JackpotType.MINOR]:  'minor_jackpot',
    [JackpotType.MINI]:   'mini_jackpot',
};

@ccclass('JackpotPopup')
export class JackpotPopup extends Component {

    // ── EDITOR NODE SLOTS ──────────────────────────────────────────────────────

    /** sp.Skeleton cho GRAND JACKPOT (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect GRAND JACKPOT\n→ Kéo sp.Skeleton node vào đây' })
    spineGrand: sp.Skeleton | null = null;

    /** sp.Skeleton cho MAJOR JACKPOT (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect MAJOR JACKPOT\n→ Kéo sp.Skeleton node vào đây' })
    spineMajor: sp.Skeleton | null = null;

    /** sp.Skeleton cho MINOR JACKPOT (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect MINOR JACKPOT\n→ Kéo sp.Skeleton node vào đây' })
    spineMinor: sp.Skeleton | null = null;

    /** sp.Skeleton cho MINI JACKPOT (bắt đầu inactive) */
    @property({ type: sp.Skeleton, tooltip: 'Spine effect MINI JACKPOT\n→ Kéo sp.Skeleton node vào đây' })
    spineMini: sp.Skeleton | null = null;

    /**
     * Effect node duy nhất chứa 4 child tên '1','2','3','4'.
     * Khi trúng jackpot, các child được active/inactive theo loại:
     *   MINI  → active '1'
     *   MINOR → active '1','2'
     *   MAJOR → active '1','2','3'
     *   GRAND → active tất cả '1','2','3','4'
     */
    @property({ type: Node, tooltip: 'Effect node duy nhất có 4 child tên 1,2,3,4\n→ Kéo Node vào đây' })
    effectNode: Node | null = null;

    /** Label tên hũ: "GRAND JACKPOT", "MAJOR JACKPOT", ... */
    @property({ type: Label, tooltip: 'Label tên hũ jackpot\n→ Kéo Label node vào đây' })
    titleLabel: Label | null = null;

    /**
     * SpriteNumber hiển thị số tiền trúng (count-up từ 0 → amount).
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

    /** Node trong suốt bắt click đóng popup */
    @property({ type: Node, tooltip: 'Node trong suốt bắt click đóng\n→ Tạo Widget fill + kéo vào đây' })
    clickOverlay: Node | null = null;

    /** Node chứa Particle effect (play khi activate, stop khi close) */
    @property({ type: Node, tooltip: 'Node chứa ParticleSystem effect\n→ Kéo Node gắn ParticleSystem vào đây' })
    particleNode: Node | null = null;

    /** Node chứa Particle effect thứ 2 — play khi spine 'in' bắt đầu, stop khi spine 'out' hoàn thành */
    @property({ type: ParticleSystem, tooltip: 'Node chứa ParticleSystem thứ 2\n→ Play khi animation "in", Stop khi animation "out" xong' })
    particleNodeInOut: ParticleSystem | null = null;

    /** Node chứa Particle effect với scale theo orientation (landscape: 100,100,100 | portrait: 100,200,100) */
    @property({ type: Node, tooltip: 'Node chứa ParticleSystem effect với scale theo orientation\n→ Kéo Node gắn ParticleSystem vào đây' })
    particleNodeOrientationBased: Node | null = null;

    // ── ANIMATION PARAMS ─────────────────────────────────────────────────────

    @property({ tooltip: 'Thời gian count-up số tiền (giây)' })
    countUpDuration: number = 3.0;

    @property({ tooltip: 'Timeout tự đóng popup sau khi count-up xong hoặc sau khi skip (giây)' })
    autoCloseTimeout: number = 3.0;

    @property({ tooltip: 'Delay sau khi play "out" animation trước khi đóng popup (giây)' })
    outAnimCloseDelay: number = 1.0;

    @property({ tooltip: 'Rate Over Time value cho GRAND JACKPOT' })
    rateOverTimeGrand: number = 4.0;

    @property({ tooltip: 'Rate Over Time value cho MAJOR JACKPOT' })
    rateOverTimeMajor: number = 3.0;

    @property({ tooltip: 'Rate Over Time value cho MINOR JACKPOT' })
    rateOverTimeMinor: number = 2.0;

    @property({ tooltip: 'Rate Over Time value cho MINI JACKPOT' })
    rateOverTimeMini: number = 1.0;

    // ── INTERNAL ─────────────────────────────────────────────────────────────

    private _callback: (() => void) | null = null;
    private _isOpen: boolean = false;
    private _isCountingUp: boolean = false;
    private _countUpTarget: number = 0;
    private _countUpCb: (() => void) | null = null;
    private _autoCloseCb: (() => void) | null = null;
    private _outAnimCloseCb: (() => void) | null = null;
    private _activeSpine: sp.Skeleton | null = null;
    private _activeJackpotType: JackpotType | null = null;

    /** Vị trí gốc (world) của parent amountDisplay để restore khi đóng popup */
    private _amountDisplayParentOriginalPos: Vec3 | null = null;

    /** NodeA (child[0] của spine đang active) để đồng bộ vị trí */
    private _activeNodeA: Node | null = null;

    /** Callback đồng bộ vị trí mỗi frame */
    private _syncPosCb: (() => void) | null = null;

    // ── LIFECYCLE ────────────────────────────────────────────────────────────

    onLoad(): void {
        this.node.active = false;
        Log.d('[JackpotPopup] ✓ onLoad() called', {
            nodeName: this.node.name,
            hasSpineGrand: !!this.spineGrand,
            hasSpineMajor: !!this.spineMajor,
            hasSpineMinor: !!this.spineMinor,
            hasSpineMini: !!this.spineMini,
            hasTitleLabel: !!this.titleLabel,
            hasAmountDisplay: !!this.amountDisplay,
            hasClickOverlay: !!this.clickOverlay,
        });
        // JACKPOT_TRIGGER được PopupLoader xử lý khi lần đầu instantiate prefab.
        // Từ lần thứ hai trở đi, popup đã tồn tại và tự đăng ký listener này.
        EventBus.instance.on(GameEvents.JACKPOT_TRIGGER, this._onJackpotTrigger, this);
        // Lắng nghe screen events để cập nhật scale của orientation-based particle effect khi xoay/resize
        screen.on('window-resize', this._onScreenChange, this);
        screen.on('orientation-change', this._onScreenChange, this);
        this._sanitizeBrokenParticleFx();
    }

    onDestroy(): void {
        Log.d('[JackpotPopup] onDestroy() called — node is being destroyed');
        this._cleanup();
        EventBus.instance.offTarget(this);
        // Hủy listener screen events
        screen.off('window-resize', this._onScreenChange, this);
        screen.off('orientation-change', this._onScreenChange, this);
    }

    // ── EVENT HANDLER ────────────────────────────────────────────────────────

    private _onJackpotTrigger(jackpotType: JackpotType, amount: number): void {
        const jackpotNames = ['NONE', 'MINI', 'MINOR', 'MAJOR', 'GRAND'];
        Log.d('[JackpotPopup] 🎰 _onJackpotTrigger received', {
            jackpotType,
            jackpotName: jackpotNames[jackpotType] ?? 'UNKNOWN',
            amount,
            timestamp: Date.now(),
            _isOpen: this._isOpen,
            nodeActive: this.node.active,
            nodeValid: this.node.isValid,
            nodeParent: this.node.parent?.name ?? 'NO_PARENT',
        });
        this.showPopup(jackpotType, amount, () => {
            Log.d('[JackpotPopup] ✓ Popup closed → emitting JACKPOT_END');
            EventBus.instance.emit(GameEvents.JACKPOT_END);
        });
    }

    // ── PUBLIC API ───────────────────────────────────────────────────────────

    /**
     * Hiện popup jackpot.
     * @param jackpotType  Loại hũ (GRAND / MAJOR / MINOR / MINI)
     * @param amount       Số tiền thực tế trúng
     * @param callback     Gọi khi popup đóng xong — GameManager tiếp tục flow
     */
    showPopup(jackpotType: JackpotType, amount: number, callback: () => void): void {
        if (this._isOpen) {
            Log.w('[JackpotPopup] ⚠️  Already open, ignoring duplicate trigger', {
                _isOpen: this._isOpen,
                nodeActive: this.node.active,
                nodeValid: this.node.isValid,
            });
            return;
        }
        Log.d('[JackpotPopup] 📂 showPopup() called', {
            jackpotType,
            amount,
            nodeName: this.node.name,
            nodeParent: this.node.parent?.name ?? 'NO_PARENT',
            nodeActive: this.node.active,
            nodeValid: this.node.isValid,
        });
        this._isOpen = true;
        this._callback = callback;
        this._countUpTarget = amount;
        this._activeJackpotType = jackpotType;

        // Deactivate all spines
        for (const s of [this.spineGrand, this.spineMajor, this.spineMinor, this.spineMini]) {
            if (s) s.node.active = false;
        }

        // Activate effectNode before setup; deactivate when 'out' plays
        if (this.effectNode) {
            this._sanitizeBrokenParticleFx();
            this.effectNode.active = true;
        }

        // Setup effect children visibility based on jackpot type
        this._setupEffectForType(jackpotType);

        // Init amount display
        if (this.amountDisplay) {
            this.amountDisplay.setData(0, this.currencyIndex, 3);
            this.amountDisplay.node.active = false;
            Tween.stopAllByTarget(this.amountDisplay.node);
            this.amountDisplay.node.setScale(1, 1, 1);
        }

        // Set title
        if (this.titleLabel) {
            this.titleLabel.string = L(JACKPOT_L10N_KEYS[jackpotType] ?? 'grand_jackpot');
        }

        // Activate node & bring to front so it's not hidden behind PickGamePopup
        Log.d('[JackpotPopup] ✓ Activating popup node...');
        this.node.active = true;
        if (this.node.parent) {
            this.node.setSiblingIndex(999999);
        }

        // Activate overlay early so player can skip at any time
        if (this.clickOverlay) {
            this.clickOverlay.active = true;
            this.clickOverlay.on(Node.EventType.TOUCH_END, this._onClickClose, this);
        }

        // Activate the correct spine and start flow
        this._activeSpine = this._getSpineForType(jackpotType);
        const spine = this._activeSpine;

        if (spine) {
            Log.d('[JackpotPopup] ✓ Spine found, playing "in" animation');
            spine.node.active = true;
            this._attachAmountDisplayParentToSpine(spine);
            this._playParticleEffects();
            this._playParticleInOut();
            spine.setAnimation(0, 'In', false);
            spine.setCompleteListener(() => {
                Log.d('[JackpotPopup] ✓ "in" animation complete → playing "loop"');
                spine.setCompleteListener(null);
                spine.setAnimation(0, 'Loop', true);
                if (this.amountDisplay) this.amountDisplay.node.active = true;
                this._startCountUp(amount, () => {
                    this._waitForClose();
                });
            });
        } else {
            Log.w('[JackpotPopup] ⚠️  No spine found for jackpot type', jackpotType);
            if (this.amountDisplay) this.amountDisplay.node.active = true;
            this._startCountUp(amount, () => {
                this._waitForClose();
            });
        }
    }

    // ── PRIVATE ──────────────────────────────────────────────────────────────

    private _getSpineForType(type: JackpotType): sp.Skeleton | null {
        switch (type) {
            case JackpotType.GRAND: return this.spineGrand;
            case JackpotType.MAJOR: return this.spineMajor;
            case JackpotType.MINOR: return this.spineMinor;
            case JackpotType.MINI:  return this.spineMini;
            default:                return null;
        }
    }

    private _setupEffectForType(type: JackpotType): void {
        if (!this.effectNode) return;

        // Layer '1' / 'base1' dùng material đã xóa — chỉ dùng 2,3,4 còn hoạt động.
        const child2 = this.effectNode.getChildByName('2');
        const child3 = this.effectNode.getChildByName('3');
        const child4 = this.effectNode.getChildByName('4');

        for (const child of this.effectNode.children) {
            child.active = false;
        }

        switch (type) {
            case JackpotType.GRAND:
                if (child2) child2.active = true;
                if (child3) child3.active = true;
                if (child4) child4.active = true;
                break;
            case JackpotType.MAJOR:
                if (child2) child2.active = true;
                if (child3) child3.active = true;
                break;
            case JackpotType.MINOR:
                if (child2) child2.active = true;
                break;
            case JackpotType.MINI:
                break;
        }
    }

    /** Tắt hẳn particle/UIMeshRenderer thiếu material — tránh treo Batcher2D. */
    private _sanitizeBrokenParticleFx(): void {
        const roots = [this.effectNode, this.particleNode, this.particleNodeOrientationBased].filter(Boolean) as Node[];
        for (const root of roots) {
            this._disableBrokenParticleNodes(root);
        }
    }

    private _disableBrokenParticleNodes(root: Node): void {
        const stack: Node[] = [root];
        while (stack.length > 0) {
            const node = stack.pop()!;
            stack.push(...node.children);

            const ps = node.getComponent(ParticleSystem);
            const uiMesh = node.getComponent(UIMeshRenderer);
            if (!ps && !uiMesh) continue;

            const broken = !ps?.enabled;
            if (!broken) continue;

            if (uiMesh?.enabled) uiMesh.enabled = false;
            if (ps) {
                ps.stop();
                ps.clear();
            }
            node.active = false;
        }
    }

    /**
     * Count-up số tiền từ 0 → to trong countUpDuration giây tại 30fps.
     * Luôn giữ 3 số thập phân để hiển thị phần lẻ (đuôi lẻ có chữ số) theo chuẩn formatCurrency.
     * Dùng lockWidth để tránh layout shift trong suốt quá trình đếm.
     */
    private _startCountUp(to: number, onDone: () => void): void {
        if (!this.amountDisplay) { onDone(); return; }
        this._stopCountUp();
        this._isCountingUp = true;
        this.amountDisplay?.beginCountUp();
        SoundManager.instance?.playCounterStart();

        const interval = 1 / 30;
        let elapsed = 0;
        let soundStarted = false;
        // Lock width with 3 decimal capacity so fractional part scrolls during count-up
        this.amountDisplay.lockWidth(to, this.currencyIndex, 3);

        this._countUpCb = () => {
            elapsed += interval;
            const t = Math.min(elapsed / this.countUpDuration, 1);

            // Phát âm thanh lần đầu tiên khi giá trị bắt đầu tăng
            if (!soundStarted && t > 0) {
                soundStarted = true;
                SoundManager.instance?.playCoinLoop();
            }

            // Natural count-up: tránh pattern đều (11.111→22.222) khi đích là số tròn
            const cur = naturalCountUpValue(0, to, t, 3);
            this.amountDisplay!.setData(cur, this.currencyIndex, 3);

            if (elapsed >= this.countUpDuration) {
                this._isCountingUp = false;
                this.amountDisplay!.endCountUp();
                const isInt = Number.isInteger(to) || Math.abs(to - Math.round(to)) < 0.0005;
                if (isInt) {
                    this.amountDisplay!.setData(Math.floor(to), this.currencyIndex, 0);
                } else {
                    const toTrunc = Math.floor(to * 1000) / 1000;
                    this.amountDisplay!.setData(toTrunc, this.currencyIndex, 3);
                }
                this.amountDisplay!.unlockWidth();
                this._stopCountUp();
                SoundManager.instance?.stopCoinLoop();
                SoundManager.instance?.playCoinEnd();
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
            // Skip count-up: nhảy thẳng tới tiền max
            this._isCountingUp = false;
            this._stopCountUp();

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

            // Skip xong: đợi vài giây rồi tự đóng (giống count-up chạy hết).
            // Click lần nữa trong lúc đợi → _onClickClose đóng ngay.
            this._waitForClose();
            return;
        }

        this._closePopup();
    }

    private _closePopup(): void {
        Log.d(`[JackpotPopup] _closePopup() called — _isOpen=${this._isOpen}, nodeActive=${this.node.active}`);
        if (!this._isOpen) return;
        this._isOpen = false;

        // Deactivate effectNode immediately when 'out' starts
        if (this.effectNode) this.effectNode.active = false;

        if (this.clickOverlay) {
            this.clickOverlay.off(Node.EventType.TOUCH_END, this._onClickClose, this);
            this.clickOverlay.active = false;
        }

        this._isCountingUp = false;
        this._stopCountUp();
        this._clearAllParticleSystems();

        const spine = this._activeSpine;
        if (spine) {
            spine.setCompleteListener(null);

            // Không có anim "out"/"Out" → đóng ngay, tránh treo game
            const outAnimName = spine.findAnimation('out')
                ? 'out'
                : (spine.findAnimation('Out') ? 'Out' : null);
            if (!outAnimName) {
                Log.w('[JackpotPopup] ⚠️  No "out" animation → closing immediately');
                SoundManager.instance?.playBannerDisappear();
                this._finishClose();
                return;
            }

            spine.setAnimation(0, outAnimName, false);
            // Phát sx_banner_disappear ngay khi spine animation "out" bắt đầu
            SoundManager.instance?.playBannerDisappear();
            // Scale amountDisplay thu nhỏ theo chiều X về 0 (Y giữ nguyên), nhanh hơn 'out'
            if (this.amountDisplay) {
                Tween.stopAllByTarget(this.amountDisplay.node);
                tween(this.amountDisplay.node)
                    .to(0.1, { scale: new Vec3(0, 1, 1) })
                    .start();
            }

            if (this._outAnimCloseCb) this.unschedule(this._outAnimCloseCb);
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
        Log.d(`[JackpotPopup] _finishClose() — nodeActive before=${this.node.active}`);
        this._restoreAmountDisplayParent();
        this.node.active = false;
        this._activeSpine = null;
        if (this.amountDisplay) {
            Tween.stopAllByTarget(this.amountDisplay.node);
            this.amountDisplay.node.setScale(1, 1, 1);
        }
        const cb = this._callback;
        this._callback = null;
        cb?.();
    }

    /** Lấy ParticleSystem enabled từ node và toàn bộ con. */
    private _getParticlesFrom(node: Node): ParticleSystem[] {
        return node.getComponentsInChildren(ParticleSystem).filter(ps => ps.enabled);
    }

    private _safePlayParticle(ps: ParticleSystem): void {
        if (!ps?.enabled) return;
        try {
            ps.stop();
            ps.play();
        } catch (e) {
            Log.w('[JackpotPopup] skip broken particle (missing material)', e);
        }
    }

    private _playParticleEffects(): void {
        if (this.particleNode) {
            this.particleNode.active = true;
            for (const p of this._getParticlesFrom(this.particleNode)) {
                this._safePlayParticle(p);
            }
        }
        const rateValue = this._getRateOverTimeValue(this._activeJackpotType);
        if (this.particleNodeOrientationBased) {
            this.particleNodeOrientationBased.active = true;
            // Áp dụng scale dựa trên orientation (sẽ tự cập nhật khi xoay màn hình)
            this._applyOrientationScale();
            for (const p of this._getParticlesFrom(this.particleNodeOrientationBased)) {
                // rateOverTime là CurveRange — phải set mode Constant (0) rồi gán constant
                p.rateOverTime.mode = 0;
                p.rateOverTime.constant = rateValue;
                this._safePlayParticle(p);
            }
        }
    }

    /** Dừng và xóa sạch mọi particle trong popup (gọi khi bắt đầu anim out). */
    private _clearAllParticleSystems(): void {
        for (const ps of this.node.getComponentsInChildren(ParticleSystem)) {
            try {
                ps.stop();
                ps.clear();
            } catch (e) {
                Log.w('[JackpotPopup] skip broken particle on clear', e);
            }
        }
    }

    private _playParticleInOut(): void {
        if (this.particleNodeInOut?.enabled) {
            this.particleNodeInOut.node.active = true;
            this._safePlayParticle(this.particleNodeInOut);
        }
    }

    private _onScreenChange(): void {
        this._applyOrientationScale();
    }

    private _isLandscape(): boolean {
        const size = screen.windowSize;
        return size.width >= size.height;
    }

    private _applyOrientationScale(): void {
        if (!this.particleNodeOrientationBased) return;
        const isLandscape = this._isLandscape();
        if (isLandscape) {
            // Landscape: scale (100, 100, 100)
            this.particleNodeOrientationBased.scale = this.particleNodeOrientationBased.scale.set(100, 100, 100);
        } else {
            // Portrait: scale (100, 200, 100)
            this.particleNodeOrientationBased.scale = this.particleNodeOrientationBased.scale.set(100, 200, 100);
        }
    }

    private _getRateOverTimeValue(jackpotType: JackpotType | null): number {
        switch (jackpotType) {
            case JackpotType.GRAND: return this.rateOverTimeGrand;
            case JackpotType.MAJOR: return this.rateOverTimeMajor;
            case JackpotType.MINOR: return this.rateOverTimeMinor;
            case JackpotType.MINI:  return this.rateOverTimeMini;
            default:                return 1.0;
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
            Log.w(`[JackpotPopup] Spine "${spineNode.name}" has no child at index 0`);
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
        for (const s of [this.spineGrand, this.spineMajor, this.spineMinor, this.spineMini]) {
            if (s) s.setCompleteListener(null);
        }
    }
}
