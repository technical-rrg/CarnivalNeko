/**
 * FreeSpinEndPopup - Popup tổng kết khi Free Spin kết thúc.
 *
 * ── NỘI DUNG (theo tài liệu p.32, UI doc p.11) ──
 *   CONGRATULATIONS
 *   YOU WON
 *   $999,999.00           ← totalWin (không count-up, hiện ngay)
 *   IN 10 FREE SPINS      ← số lần spin thực tế đã dùng
 *   PRESS ANYWHERE TO CONTINUE
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "FreeSpinEndPopup" (bắt đầu inactive).
 *   2. Gắn component này + UIOpacity vào cùng node.
 *   3. Cấu trúc node con:
 *
 *        FreeSpinEndPopup  ← component này + UIOpacity
 *          ├── titleLabel      ← Label "CONGRATULATIONS\nYOU WON"
 *          ├── amountLabel     ← Label số tiền tổng
 *          ├── spinCountLabel  ← Label "IN X FREE SPINS"
 *          ├── hintLabel       ← Label "PRESS ANYWHERE TO CONTINUE"
 *          └── clickOverlay    ← Node trong suốt bắt click đóng
 *
 * ── FLOW ──
 *   GameManager emit FREE_SPIN_END_POPUP(totalWin, spinCount).
 *   1. Show popup (fade in, scale backOut)
 *   2. Chờ 3 giây tự đóng (hoặc click)
 *   3. Emit FREE_SPIN_END_POPUP_CLOSED → GameManager tiếp tục flow
 *      (tại đây GameManager mới emit FREE_SPIN_END và check Progressive Win)
 */

import { _decorator, Component, Node, Label, UIOpacity, Button, tween, Vec3, Tween } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { formatCurrencyFixed } from '../core/FormatUtils';
import { SoundManager } from '../manager/SoundManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('FreeSpinEndPopup')
export class FreeSpinEndPopup extends Component {

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

    /** Label hiển thị tổng tiền thắng */
    @property({ type: Label, tooltip: 'Label số tiền tổng\n→ Kéo Label node vào đây' })
    amountLabel: Label | null = null;

    /** Label "IN X FREE SPINS" */
    @property({ type: Label, tooltip: 'Label "IN X FREE SPINS"\n→ Kéo Label node vào đây' })
    spinCountLabel: Label | null = null;

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

    // ── ANIMATION PARAMS ─────────────────────────────────────────────────────

    @property({ tooltip: 'Timeout tự đóng popup (giây)' })
    autoCloseTimeout: number = 3.0;

    // ── INTERNAL ─────────────────────────────────────────────────────────────

    private _isOpen: boolean = false;
    private _autoCloseCb: (() => void) | null = null;
    private _countUpCb: (() => void) | null = null;
    private _boundClickOverlayHandler = this._onClickOverlay.bind(this);

    // ── LIFECYCLE ────────────────────────────────────────────────────────────

    onLoad(): void {
        this.node.active = false;
        if (this.overlayNode) this.overlayNode.active = false;
        EventBus.instance.on(GameEvents.FREE_SPIN_END_POPUP, this._onFreeSpinEndPopup, this);

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

    // ── EVENT HANDLER ────────────────────────────────────────────────────────

    private _onFreeSpinEndPopup(totalWin: number, spinCount: number): void {
        Log.d(`[RESUME-DEBUG] FreeSpinEndPopup._onFreeSpinEndPopup event received — totalWin=${totalWin}, spinCount=${spinCount}`);
        this.showPopup(totalWin, spinCount);
    }

    // ── PUBLIC API ───────────────────────────────────────────────────────────

    showPopup(totalWin: number, spinCount: number): void {
        Log.d(`[RESUME-DEBUG] FreeSpinEndPopup.showPopup() called — totalWin=${totalWin}, spinCount=${spinCount}, _isOpen=${this._isOpen}, node.active=${this.node.active}`);
        if (this._isOpen) return;
        this._isOpen = true;

        // Cập nhật text (title, count, hint)
        if (this.titleLabel)     this.titleLabel.string     = L('UI_CONTROL_PANEL_TEXT_FREE_SPIN_ACCUMULATED');
        if (this.spinCountLabel) this.spinCountLabel.string = L('in_free_spins', { count: spinCount });
        if (this.hintLabel)      this.hintLabel.string      = L('UI_START_PAGE_3_DESCRIPTION');

        // Show overlay instantly (no animation)
        if (this.overlayNode) {
            this.overlayNode.active = true;
        }

        // Chuẩn bị trạng thái đầu
        this.node.active = true;
        const scaleTarget = this.popupNode || this.node;
        scaleTarget.setScale(0, 0, 1);
        if (this.uiOpacity) this.uiOpacity.opacity = 0;

        // Tween xuất hiện (zoom scale)
        tween(scaleTarget)
            .to(0.4, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
            .start();

        const afterFadeIn = () => {
            // Animate amount label with zoom & counting effect
            this._animateAmountLabel(totalWin);
            this._waitForClose();
        };

        if (this.uiOpacity) {
            tween(this.uiOpacity)
                .to(0.3, { opacity: 255 })
                .call(afterFadeIn)
                .start();
        } else {
            this.scheduleOnce(afterFadeIn, 0.3);
        }
    }

    /** Animate amount label: scale zoom pop effect only (no count-up) */
    private _animateAmountLabel(totalWin: number): void {
        if (!this.amountLabel) return;

        // Stop any running count-up
        if (this._countUpCb) {
            this.unschedule(this._countUpCb);
            this._countUpCb = null;
        }

        // Set amount directly (no counting effect)
        this.amountLabel.string = L('CLIENT_CURRENENCY_SYMBOL') + formatCurrencyFixed(totalWin);

        // Reset to scale 0
        this.amountLabel.node.setScale(0, 0, 1);

        // Zoom-in bounce animation only
        tween(this.amountLabel.node)
            .to(0.1, { scale: new Vec3(1.15, 1.15, 1) }, { easing: 'backOut' })
            .to(0.15, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
            .start();
    }


    // ── PRIVATE ──────────────────────────────────────────────────────────────

    private _onClickOverlay(): void {
        this._closePopup();
    }

    private _waitForClose(): void {
        if (this.clickOverlay) {
            this.clickOverlay.active = true;
        }
        this._autoCloseCb = () => { this._closePopup(); };
        this.scheduleOnce(this._autoCloseCb, this.autoCloseTimeout);
    }

    private _closePopup(): void {
        if (!this._isOpen) return;
        this._isOpen = false;

        if (this._autoCloseCb) {
            this.unschedule(this._autoCloseCb);
            this._autoCloseCb = null;
        }

        if (this.clickOverlay) {
            this.clickOverlay.off(Node.EventType.TOUCH_END, this._boundClickOverlayHandler);
            this.clickOverlay.active = false;
        }

        const scaleTarget = this.popupNode || this.node;
        tween(scaleTarget)
            .to(0.3, { scale: new Vec3(0, 0, 1) }, { easing: 'backIn' })
            .call(() => {
                this.node.active = false;
                // Hide overlay immediately
                if (this.overlayNode) {
                    this.overlayNode.active = false;
                }
                EventBus.instance.emit(GameEvents.FREE_SPIN_END_POPUP_CLOSED);
            })
            .start();

        if (this.uiOpacity) {
            tween(this.uiOpacity)
                .to(0.3, { opacity: 0 })
                .start();
        }
    }

    private _cleanup(): void {
        if (this._autoCloseCb) {
            this.unschedule(this._autoCloseCb);
            this._autoCloseCb = null;
        }
        if (this._countUpCb) {
            this.unschedule(this._countUpCb);
            this._countUpCb = null;
        }
        // Stop any lingering sound
        SoundManager.instance?.stopCoinLoop();
        Tween.stopAllByTarget(this.node);
        if (this.uiOpacity) Tween.stopAllByTarget(this.uiOpacity);
        if (this.amountLabel) Tween.stopAllByTarget(this.amountLabel.node);
    }
}
