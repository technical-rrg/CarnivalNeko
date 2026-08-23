/**
 * TopUpEndPopup - Popup tổng kết khi TopUp (Re-Spin) kết thúc. *
 * ── NỘI DUNG ──
 *   CONGRATULATIONS
 *   YOU WON
 *   $999,999.00           ← totalWin (count-up nhanh từ 0)
 *   TOPUP BONUS COMPLETE
 *   PRESS ANYWHERE TO CONTINUE
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "TopUpEndPopup" (bắt đầu inactive).
 *   2. Gắn component này + UIOpacity vào cùng node.
 *   3. Cấu trúc node con:
 *
 *        TopUpEndPopup  ← component này + UIOpacity
 *          ├── titleLabel      ← Label "CONGRATULATIONS\nYOU WON"
 *          ├── amountLabel     ← Label số tiền tổng
 *          ├── subLabel        ← Label "TOPUP BONUS COMPLETE"
 *          ├── hintLabel       ← Label "PRESS ANYWHERE TO CONTINUE"
 *          └── clickOverlay    ← Node trong suốt bắt click đóng
 *
 * ── FLOW ──
 *   GameManager emit TOPUP_END_POPUP(totalWin).
 *   1. Show popup (fade in, scale backOut)
 *   2. Chờ 3 giây tự đóng (hoặc click)
 *   3. Emit TOPUP_END_POPUP_CLOSED → GameManager tiếp tục flow
 *      (tại đây GameManager mới emit TOPUP_END và cleanup state)
 */

import { _decorator, Component, Node, Label, UIOpacity, Button, tween, Vec3, Tween, ParticleSystem } from 'cc';
import { sp } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { SpriteNumber } from '../core/SpriteNumber';
import { naturalCountUpValue } from '../core/FormatUtils';
import { SoundManager } from '../manager/SoundManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('TopUpEndPopup')
export class TopUpEndPopup extends Component {

    // ── EDITOR NODE SLOTS ──────────────────────────────────────────────────────

    /** Node chứa toàn bộ popup content (để làm zoom in/out) */
    @property({ type: Node, tooltip: 'Node chứa popup content - dùng cho scale animation\n→ Kéo Node popup vào đây' })
    popupNode: Node | null = null;

    /** Overlay node (nên fill canvas, active=false ban đầu) */
    @property({ type: Node, tooltip: 'Overlay node (fill canvas, active=false ban đầu)\n→ Kéo Node overlay vào đây' })
    overlayNode: Node | null = null;

    /** Label tiêu đề "CONGRATULATIONS\nYOU WON" */
    @property({ type: Label, tooltip: 'Label "CONGRATULATIONS YOU WON"\n→ Kéo Label node vào đây' })
    titleLabel: Label | null = null;

    /** SpriteNumber hiển thị tổng tiền thắng */
    @property({ type: SpriteNumber, tooltip: 'SpriteNumber hiển thị số tiền tổng\n→ Kéo SpriteNumber component vào đây' })
    amountLabel: SpriteNumber | null = null;

    /** Label "TOPUP BONUS COMPLETE" */
    @property({ type: Label, tooltip: 'Label phụ (vd: TOPUP BONUS COMPLETE)\n→ Kéo Label node vào đây' })
    subLabel: Label | null = null;

    /** Label "PRESS ANYWHERE TO CONTINUE" */
    @property({ type: Label, tooltip: 'Label hướng dẫn đóng popup\n→ Kéo Label node vào đây' })
    hintLabel: Label | null = null;

    /** Node trong suốt bắt click đóng popup */
    @property({ type: Node, tooltip: 'Node trong suốt bắt click đóng\n→ Tạo Widget fill + kéo vào đây' })
    clickOverlay: Node | null = null;

    /** Nút đóng popup */
    @property({ type: Button, tooltip: '(Tuỳ chọn) Nút đóng popup\n→ Kéo Button node vào đây' })
    closeButton: Button | null = null;

    /** UIOpacity của popup node */
    @property({ type: UIOpacity, tooltip: 'UIOpacity của popup node\n→ Kéo UIOpacity component vào đây' })
    uiOpacity: UIOpacity | null = null;

    /** Spine animation cho popup */
    @property({ type: sp.Skeleton, tooltip: 'Spine animation cho popup\n→ Kéo sp.Skeleton node vào đây' })
    spine: sp.Skeleton | null = null;

    /** FX coin fly — ẩn lúc mở, hiện cùng amountLabel sau amountShowDelay */
    @property({ type: Node, tooltip: 'Fx1 — particle FX\n→ Kéo node Fx1 vào đây' })
    fx1: Node | null = null;

    @property({ type: Node, tooltip: 'Fx2 — particle FX\n→ Kéo node Fx2 vào đây' })
    fx2: Node | null = null;

    // ── ANIMATION PARAMS ─────────────────────────────────────────────────────

    @property({ tooltip: 'Timeout tự đóng popup (giây)' })
    autoCloseTimeout: number = 3.0;

    @property({ tooltip: 'Thời gian count-up từ 0 đến totalWin (giây)' })
    countUpDuration: number = 1.5;

    @property({ tooltip: 'Thời gian fade-out amountLabel (giây).\n>0 = dùng đúng giá trị này.\n≤0 = tự tính từ spine Out trừ amountFadeLeadTime.' })
    amountFadeOutDuration: number = 0;

    @property({ tooltip: 'Amount biến mất sớm hơn popup bao nhiêu giây (chỉ khi amountFadeOutDuration ≤ 0).\nVd 0.12 → số mất hẳn ~120ms trước khi spine Out kết thúc.' })
    amountFadeLeadTime: number = 0.12;

    @property({ tooltip: 'Delay trước khi hiện amountLabel sau khi mở popup (giây)' })
    amountShowDelay: number = 0.3;

    // ── INTERNAL ─────────────────────────────────────────────────────────────

    private _isOpen: boolean = false;
    private _autoCloseCb: (() => void) | null = null;
    private _boundClickOverlayHandler = this._onClickOverlay.bind(this);
    private _spineOutCb: (() => void) | null = null;
    private _outAnimCloseCb: (() => void) | null = null;
    private _amountShowCb: (() => void) | null = null;
    private _countUpTween: Tween<{ value: number }> | null = null;
    private _countUpTarget: number = 0;
    private _countUpSoundEnded: boolean = false;
    private _showCount: number = 0;
    private _amountOpacity: UIOpacity | null = null;

    // ── LIFECYCLE ────────────────────────────────────────────────────────────

    onLoad(): void {
        this.node.active = false;
        if (this.overlayNode) this.overlayNode.active = false;
        if (!this.fx1) {
            this.fx1 = this.node.getChildByName('Fx1')
                ?? this.node.getChildByName('Popup_Fx_Coinfly');
        }
        if (!this.fx2) {
            this.fx2 = this.node.getChildByName('Fx2')
                ?? this.node.getChildByName('Popup_Fx_Coinfly-001');
        }
        // Không lắng nghe TOPUP_END_POPUP trực tiếp; PopupLoader là manager load và show popup.

        if (this.closeButton) {
            this.closeButton.node.on('click', this._closePopup, this);
        }

        // Tap anywhere on popup to close
        if (this.clickOverlay) {
            this.clickOverlay.on(Node.EventType.TOUCH_END, this._boundClickOverlayHandler);
        }
    }

    onDestroy(): void {
        this._cleanup();
        EventBus.instance.offTarget(this);
    }

    // ── PUBLIC API ───────────────────────────────────────────────────────────

    showPopup(totalWin: number): void {
        const isNewShow = !this._isOpen;
        if (isNewShow) this._showCount++;
        Log.d(`[coinloop][TopUpEndPopup.showPopup] showCount=${this._showCount} totalWin=${totalWin} _isOpen=${this._isOpen} isNewShow=${isNewShow}`);
        if (this._isOpen) return;
        this._isOpen = true;

        // Cập nhật text
        if (this.titleLabel) {
            this.titleLabel.string = L('UI_CONTROL_PANEL_TEXT_FREE_SPIN_ACCUMULATED'); // CONGRATULATIONS YOU WON
        }
        if (this.subLabel) {
            this.subLabel.string = L('TOPUP_BONUS_COMPLETE') || 'TOPUP BONUS COMPLETE';
        }
        if (this.hintLabel) {
            this.hintLabel.string = L('UI_START_PAGE_3_DESCRIPTION'); // PRESS ANYWHERE TO CONTINUE
        }

        if (this.overlayNode) {
            this.overlayNode.active = true;
        }

        this.node.active = true;

        this._hideDelayedRevealElements();
        this._scheduleDelayedReveal(totalWin);

        if (this.spine) {
            this.spine.node.active = true;
            this.spine.setAnimation(0, 'In', false);
            this.spine.setCompleteListener(() => {
                this.spine!.setCompleteListener(null);
                this.spine!.setAnimation(0, 'Loop', true);
                this._waitForClose();
            });
        } else {
            this._waitForClose();
        }
    }

    /** Ẩn amount + Fx lúc mở popup → delay rồi mới hiện */
    private _scheduleDelayedReveal(totalWin: number): void {
        this._cancelAmountShowSchedule();
        const delay = Math.max(0, this.amountShowDelay);
        if (delay <= 0) {
            this._revealDelayedElements(totalWin);
            return;
        }
        this._amountShowCb = () => {
            this._amountShowCb = null;
            this._revealDelayedElements(totalWin);
        };
        this.scheduleOnce(this._amountShowCb, delay);
    }

    private _hideDelayedRevealElements(): void {
        if (this.amountLabel) {
            Tween.stopAllByTarget(this.amountLabel.node);
            this.amountLabel.node.setScale(1, 1, 1);
            this.amountLabel.node.active = false;
            this._resetAmountLabelOpacity();
        }
        this._hideFxNodes();
    }

    private _revealDelayedElements(totalWin: number): void {
        if (!this._isOpen) return;
        this._playFxNode(this.fx1);
        this._playFxNode(this.fx2);
        if (this.amountLabel) {
            this.amountLabel.node.active = true;
            this._resetAmountLabelOpacity();
            this._animateAmountLabel(totalWin);
        }
    }

    private _playFxNode(node: Node | null): void {
        if (!node) return;
        node.active = true;
        const systems = node.getComponentsInChildren(ParticleSystem);
        for (const ps of systems) {
            ps.stop();
            ps.clear();
            ps.play();
        }
    }

    private _hideFxNodes(): void {
        for (const node of [this.fx1, this.fx2]) {
            if (!node) continue;
            const systems = node.getComponentsInChildren(ParticleSystem);
            for (const ps of systems) {
                ps.stop();
                ps.clear();
            }
            node.active = false;
        }
    }

    /** Dừng và xóa sạch mọi particle trong popup (gọi khi bắt đầu anim out). */
    private _clearAllParticleSystems(): void {
        for (const ps of this.node.getComponentsInChildren(ParticleSystem)) {
            try {
                ps.stop();
                ps.clear();
            } catch (e) {
                Log.w('[TopUpEndPopup] skip broken particle on clear', e);
            }
        }
        for (const node of [this.fx1, this.fx2]) {
            if (node) node.active = false;
        }
    }

    private _cancelAmountShowSchedule(): void {
        if (this._amountShowCb) {
            this.unschedule(this._amountShowCb);
            this._amountShowCb = null;
        }
    }

    /** Chạy hiệu ứng count-up nhanh từ 0 đến totalWin */
    private _animateAmountLabel(totalWin: number): void {
        if (!this.amountLabel) return;
        this._stopCountUp();
        this._countUpSoundEnded = false;
        Log.d(`[coinloop][TopUpEndPopup._animateAmountLabel] showCount=${this._showCount} stopCoinLoop before new count-up target=${totalWin}`);
        SoundManager.instance?.stopCoinLoop();
        this._resetAmountLabelOpacity();
        this._countUpTarget = totalWin;

        // Khoá width theo giá trị đích để layout không nhảy trong khi count-up
        this.amountLabel.lockWidth(totalWin, 0, 3);
        this.amountLabel.setData(0, 0, 3);
        this.amountLabel.enableCountSound = true;
        Log.d(`[coinloop][TopUpEndPopup._animateAmountLabel] showCount=${this._showCount} beginCountUp()`);
        this.amountLabel.beginCountUp();
        Log.e(`[TopUpEndPopup][AMOUNT_COUNTUP_START] showCount=${this._showCount} target=${totalWin} duration=${this.countUpDuration}`);

        const progress = { value: 0 };
        this._countUpTween = tween(progress)
            .to(this.countUpDuration, { value: totalWin }, {
                easing: 'quadOut',
                onUpdate: (_target, ratio) => {
                    // Natural count-up: tránh pattern đều khi đích là số tròn
                    const cur = naturalCountUpValue(0, totalWin, ratio ?? 0, 3);
                    this.amountLabel?.setData(cur, 0, 3);
                },
            })
            .call(() => {
                this._finishCountUp();
            })
            .start();
    }

    private _finishCountUp(): void {
        Log.d(`[coinloop][TopUpEndPopup._finishCountUp] showCount=${this._showCount} _countUpSoundEnded=${this._countUpSoundEnded}`);
        this._stopCountUp();
        if (!this.amountLabel) {
            SoundManager.instance?.stopCoinLoop();
            this._countUpSoundEnded = true;
            return;
        }

        const isInt = Number.isInteger(this._countUpTarget) || Math.abs(this._countUpTarget - Math.round(this._countUpTarget)) < 0.0005;
        if (!this._countUpSoundEnded) {
            Log.d(`[coinloop][TopUpEndPopup._finishCountUp] showCount=${this._showCount} endCountUp()`);
            this.amountLabel.endCountUp();
            this._countUpSoundEnded = true;
        } else {
            Log.d(`[coinloop][TopUpEndPopup._finishCountUp] showCount=${this._showCount} skip endCountUp (already ended)`);
        }
        if (isInt) {
            this.amountLabel.unlockWidth();
            this.amountLabel.setData(Math.floor(this._countUpTarget), 0, 0);
        } else {
            this.amountLabel.unlockWidth();
            this.amountLabel.setData(Math.floor(this._countUpTarget * 1000) / 1000, 0, 3);
        }
        Log.e(`[TopUpEndPopup][AMOUNT_COUNTUP_END] showCount=${this._showCount} final=${this._countUpTarget}`);
    }

    private _stopCountUp(): void {
        if (this._countUpTween) {
            this._countUpTween.stop();
            this._countUpTween = null;
        }
    }

    private _ensureAmountOpacity(): UIOpacity | null {
        if (!this.amountLabel) return null;
        if (!this._amountOpacity || !this._amountOpacity.isValid) {
            this._amountOpacity =
                this.amountLabel.node.getComponent(UIOpacity) ??
                this.amountLabel.node.addComponent(UIOpacity);
        }
        return this._amountOpacity;
    }

    private _resetAmountLabelOpacity(): void {
        const op = this._ensureAmountOpacity();
        if (!op) return;
        Tween.stopAllByTarget(op);
        op.opacity = 255;
    }

    /** Fade amountLabel alpha → 0 */
    private _fadeAmountLabelOut(duration: number): void {
        const op = this._ensureAmountOpacity();
        if (!op) return;
        Tween.stopAllByTarget(op);
        const dur = Math.max(0.01, duration);
        tween(op).to(dur, { opacity: 0 }).start();
    }

    /**
     * Tính thời gian fade amount sao cho opacity = 0 trước khi spine Out kết thúc ~lead giây.
     * amountFadeOutDuration > 0 → override thủ công.
     */
    private _computeAmountFadeDuration(spineOutDur: number): number {
        if (this.amountFadeOutDuration > 0) {
            return this.amountFadeOutDuration;
        }
        const lead = Math.max(0.05, this.amountFadeLeadTime);
        return Math.max(0.15, spineOutDur - lead);
    }

    // ── PRIVATE ──────────────────────────────────────────────────────────────

    private _onClickOverlay(): void {
        this._closePopup();
    }

    private _waitForClose(): void {
        if (this.clickOverlay) {
            this.clickOverlay.off(Node.EventType.TOUCH_END, this._boundClickOverlayHandler);
            this.clickOverlay.on(Node.EventType.TOUCH_END, this._boundClickOverlayHandler);
            this.clickOverlay.active = true;
        }
        this._autoCloseCb = () => { this._closePopup(); };
        this.scheduleOnce(this._autoCloseCb, this.autoCloseTimeout);
    }

    /** Spine JSON dùng 'Out' (Anim_Congratulation) — fallback 'out' nếu asset khác. */
    private _resolveOutAnimName(): string | null {
        if (!this.spine) return null;
        if (this.spine.findAnimation('Out')) return 'Out';
        if (this.spine.findAnimation('out')) return 'out';
        return null;
    }

    private _closePopup(): void {
        if (!this._isOpen) return;
        this._isOpen = false;

        this._cancelAmountShowSchedule();

        if (this._autoCloseCb) {
            this.unschedule(this._autoCloseCb);
            this._autoCloseCb = null;
        }

        if (this.clickOverlay) {
            this.clickOverlay.off(Node.EventType.TOUCH_END, this._boundClickOverlayHandler);
            this.clickOverlay.active = false;
        }

        // Nếu đang count-up: dừng tween và hiện ngay số đích, rồi mới đóng
        Log.d(`[coinloop][TopUpEndPopup._closePopup] showCount=${this._showCount} tweenActive=${!!this._countUpTween} soundEnded=${this._countUpSoundEnded}`);
        if (this._countUpTween) {
            this._finishCountUp();
        } else if (this.amountLabel && !this._countUpSoundEnded) {
            Log.d(`[coinloop][TopUpEndPopup._closePopup] showCount=${this._showCount} endCountUp (no tween)`);
            this.amountLabel.endCountUp();
            this._countUpSoundEnded = true;
        }
        Log.d(`[coinloop][TopUpEndPopup._closePopup] showCount=${this._showCount} stopCoinLoop()`);
        SoundManager.instance?.stopCoinLoop();
        this._clearAllParticleSystems();

        if (this.spine) {
            this.spine.setCompleteListener(null);
            const outAnimName = this._resolveOutAnimName();
            if (!outAnimName) {
                Log.w('[TopUpEndPopup] No Out animation — closing immediately');
                this._finishClose();
                return;
            }

            const entry = this.spine.setAnimation(0, outAnimName, false);
            const spineOutDur = entry?.animation?.duration ?? 0.467;
            const fadeDur = this._computeAmountFadeDuration(spineOutDur);
            this._fadeAmountLabelOut(fadeDur);

            if (this._outAnimCloseCb) this.unschedule(this._outAnimCloseCb);
            this._outAnimCloseCb = () => {
                this._outAnimCloseCb = null;
                this._finishClose();
            };
            this.scheduleOnce(this._outAnimCloseCb, spineOutDur + 0.05);

            this.spine.setCompleteListener(() => {
                this.spine!.setCompleteListener(null);
                if (this._outAnimCloseCb) {
                    this.unschedule(this._outAnimCloseCb);
                    this._outAnimCloseCb = null;
                }
                this._finishClose();
            });
        } else {
            const fadeDur = this._computeAmountFadeDuration(0.3);
            this._fadeAmountLabelOut(fadeDur);
            this.scheduleOnce(() => this._finishClose(), 0.3);
        }
    }

    private _finishClose(): void {
        Log.d(`[coinloop][TopUpEndPopup._finishClose] showCount=${this._showCount} soundEnded=${this._countUpSoundEnded}`);
        if (this._outAnimCloseCb) {
            this.unschedule(this._outAnimCloseCb);
            this._outAnimCloseCb = null;
        }
        this._stopCountUp();
        if (this.amountLabel) {
            Tween.stopAllByTarget(this.amountLabel.node);
            this.amountLabel.node.setScale(1, 1, 1);
            this._resetAmountLabelOpacity();
            if (!this._countUpSoundEnded) {
                Log.d(`[coinloop][TopUpEndPopup._finishClose] showCount=${this._showCount} endCountUp()`);
                this.amountLabel.endCountUp();
                this._countUpSoundEnded = true;
            }
        }
        Log.d(`[coinloop][TopUpEndPopup._finishClose] showCount=${this._showCount} stopCoinLoop() → emit TOPUP_END_POPUP_CLOSED`);
        SoundManager.instance?.stopCoinLoop();
        this._hideFxNodes();
        this.node.active = false;
        if (this.overlayNode) this.overlayNode.active = false;
        if (this.spine) this.spine.node.active = false;
        EventBus.instance.emit(GameEvents.TOPUP_END_POPUP_CLOSED);
    }

    private _cleanup(): void {
        Log.d(`[coinloop][TopUpEndPopup._cleanup] showCount=${this._showCount} soundEnded=${this._countUpSoundEnded}`);
        if (this._autoCloseCb) {
            this.unschedule(this._autoCloseCb);
            this._autoCloseCb = null;
        }
        if (this._outAnimCloseCb) {
            this.unschedule(this._outAnimCloseCb);
            this._outAnimCloseCb = null;
        }
        this._cancelAmountShowSchedule();
        this._clearAllParticleSystems();
        this._stopCountUp();
        if (this._amountOpacity) Tween.stopAllByTarget(this._amountOpacity);
        if (this.amountLabel) {
            Tween.stopAllByTarget(this.amountLabel.node);
            if (!this._countUpSoundEnded) {
                this.amountLabel.endCountUp();
                this._countUpSoundEnded = true;
            }
        }
        SoundManager.instance?.stopCoinLoop();
        if (this.spine) {
            this.spine.setCompleteListener(null);
        }
        if (this.clickOverlay) {
            this.clickOverlay.off(Node.EventType.TOUCH_END, this._boundClickOverlayHandler);
        }
    }
}
