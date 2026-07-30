/**
 * FreeSpinPopup - Popup thông báo trúng Free Spin.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo 1 Node "FreeSpinPopup" (con của Canvas), đặt trên cùng hierarchy.
 *   2. Gắn component FreeSpinPopup.
 *   3. Kéo node popup vào slot "popupNode".
 *   4. Kéo Label vào slot "messageLabel" (để hiển thị text thông báo).
 *   5. Kéo Label vào slot "countLabel" (ví dụ "10 FREE SPINS").
 *   6. (Tuỳ chọn) Kéo Button vào slot "closeButton" để bấm tắt sớm.
 *   7. Để popupNode.active = false trong Editor.
 *
 * ── FLOW ──
 *   FREE_SPIN_POPUP event → hiện popup → scale-in → chờ 3s (hoặc tap) → scale-out → ẩn
 */

import { _decorator, Component, Node, Label, Button, tween, Vec3, EventTouch } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

@ccclass('FreeSpinPopup')
export class FreeSpinPopup extends Component {

    @property({ type: Node, tooltip: 'Node chứa toàn bộ popup (đặt active=false ban đầu)' })
    popupNode: Node | null = null;

    @property({ type: Node, tooltip: 'Overlay node (nên fill canvas, active=false ban đầu)\n→ Kéo Node overlay vào đây' })
    overlayNode: Node | null = null;

    @property({ type: Label, tooltip: 'Label tiêu đề, ví dụ "SUPERNOVA - FREE SPINS AWARDED"' })
    messageLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label số lượt, ví dụ "10 FREE SPINS"' })
    countLabel: Label | null = null;

    @property({ type: Button, tooltip: '(Tuỳ chọn) Nút đóng popup sớm' })
    closeButton: Button | null = null;

    @property({ tooltip: 'Thời gian tự động đóng (giây)' })
    autoCloseDuration: number = 3.0;

    @property({ tooltip: 'Title hiển thị trên popup' })
    title: string = 'SUPERNOVA';

    private _isOpen: boolean = false;
    private _autoCloseKey = () => this._close();

    // ─── LIFECYCLE ───

    onLoad(): void {
        EventBus.instance.on(GameEvents.FREE_SPIN_POPUP, this._onFreeSpinPopup, this);

        if (this.closeButton) {
            this.closeButton.node.on('click', this._close, this);
        }

        // Tap anywhere on popup to close
        if (this.popupNode) {
            this.popupNode.on(Node.EventType.TOUCH_END, this._close, this);
        }

        // Ẩn ban đầu
        if (this.popupNode) this.popupNode.active = false;
        if (this.overlayNode) this.overlayNode.active = false;
        // Chặn touch xuyên qua xuống các node bên dưới khi popup đang hiển thị
   
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ─── EVENT ───

    private _onFreeSpinPopup(count: number): void {
        if (this._isOpen) return;

        if (this.messageLabel) {
            this.messageLabel.string = `${this.title}\n${L('free_spin_awarded', { count })}`;
        }
        if (this.countLabel) {
            this.countLabel.string = String(count);
            // Zoom bounce effect: phóng to ra xong zoom in vô lại scale 1
            const countNode = this.countLabel.node;
            countNode.setScale(new Vec3(1, 1, 1));
            tween(countNode)
                .to(0.2, { scale: new Vec3(1.7, 1.7, 1) }, { easing: 'backOut' })
                .to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
                .start();
        }

        this._show();
    }

    public showFreeSpin(count: number): void {
        this._onFreeSpinPopup(count);
    }

    // ─── SHOW / HIDE ───

    private _show(): void {
        if (!this.popupNode) return;
        this._isOpen = true;
        EventBus.instance.emit(GameEvents.POPUP_OPENED);

        // Show overlay instantly (no animation)
        if (this.overlayNode) {
            this.overlayNode.active = true;
        }

        this.popupNode.active = true;
        this.popupNode.setScale(new Vec3(0.1, 0.1, 1));

        tween(this.popupNode)
            .to(0.25, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'backOut' })
            .to(0.12, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
            .call(() => {
                // Auto-close sau N giây (chỉ schedule 1 lần, sau khi animate-in xong)
                this.scheduleOnce(this._autoCloseKey, this.autoCloseDuration);
            })
            .start();
    }

    private _close(): void {
        if (!this._isOpen || !this.popupNode) return;
        this._isOpen = false;
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);
        SoundManager.instance?.playButtonClick();

        this.unschedule(this._autoCloseKey);

        tween(this.popupNode)
            .to(0.18, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'sineOut' })
            .to(0.15, { scale: new Vec3(0.01, 0.01, 1) }, { easing: 'sineIn' })
            .call(() => {
                this.popupNode!.active = false;
                // Hide overlay immediately
                if (this.overlayNode) {
                    this.overlayNode.active = false;
                }
                // Popup đóng → báo GameManager bắt đầu free spin auto
                EventBus.instance.emit(GameEvents.FREE_SPIN_START, 0);
            })
            .start();
    }
}
