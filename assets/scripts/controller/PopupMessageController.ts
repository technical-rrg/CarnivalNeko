/**
 * PopupMessageController - Component UI cho System Message Popup.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "SystemPopup" con của Canvas, đặt trên cùng Hierarchy.
 *   2. Gắn component PopupMessageController vào Node đó.
 *   3. Dựng hierarchy bên trong như sau:
 *
 *   SystemPopup  (Node + PopupMessageController)
 *   └── Overlay  (Node fill canvas, màu tối bán trong suốt) → overlayNode
 *       └── PopupPanel  (panel trắng/tối bo góc)             → popupNode
 *           ├── TitleLabel  (Label cc.Label)                  → titleLabel
 *           ├── MessageLabel (Label cc.Label, multiline)      → messageLabel
 *           │
 *           ├── OkContainer  (Node chứa nút OK)              → okContainer
 *           │   └── BtnOk   (Button)                         → okButton
 *           │
 *           └── ConfirmContainer (Node chứa 2 nút)           → confirmContainer
 *               ├── BtnConfirm  (Button)                     → confirmButton
 *               └── BtnCancel   (Button)                     → cancelButton
 *
 *   4. Label text của các nút được tự động set từ localization:
 *      - okButton        → L('UI_POPUP_SYSTEM_OK')
 *      - confirmButton   → L('UI_POPUP_SYSTEM_CONFIRM')
 *      - cancelButton    → L('UI_POPUP_SYSTEM_CANCEL')
 *
 *   5. Đặt overlayNode.active = false lúc ban đầu trong Editor.
 *   6. Bật BlockInputEvents trên overlayNode để chặn click xuyên qua popup.
 *
 * ── PHÂN LOẠI POPUP ──
 *   • Message thường  (isConfirmType = false): hiện OkContainer, ẩn ConfirmContainer
 *     → Dùng cho: EXPIRED_LINK, INVALID_REQUEST, DISCONNECTED, RELOGIN, WRONG_PARSHEET
 *   • Popup confirm   (isConfirmType = true):  ẩn OkContainer, hiện ConfirmContainer
 *     → Dùng cho: INSUFFICIENT_BALANCE (Confirm = refresh wallet, Cancel = đóng)
 *
 * ── SỬ DỤNG TỪ CODE ──
 *   import { EventBus } from '../core/EventBus';
 *   import { GameEvents } from '../core/GameEvents';
 *   import { PopupCase } from '../core/PopUpMessage';
 *
 *   // Popup đơn giản (chỉ OK):
 *   EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, {
 *       popupCase: PopupCase.DISCONNECTED,
 *   });
 *
 *   // Popup xác nhận (Confirm + Cancel):
 *   EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, {
 *       popupCase: PopupCase.INSUFFICIENT_BALANCE,
 *       onConfirm: () => { /* refresh wallet * / },
 *       onCancel:  () => { /* dismiss * / },
 *   });
 */

import { _decorator, Component, Node, Label, Button, tween, Tween, Vec3, BlockInputEvents, RichText, director } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { PopupCase, PopUpMessage, SystemPopupPayload } from '../core/PopUpMessage';
import { GameData } from '../data/GameData';

const { ccclass, property } = _decorator;

@ccclass('PopupMessageController')
export class PopupMessageController extends Component {

    // ─── SINGLETON ───
    private static _instance: PopupMessageController | null = null;
    static get instance(): PopupMessageController | null { return PopupMessageController._instance; }

    // ─── OVERLAY ───
    @property({ type: Node, tooltip: 'Node overlay fill canvas (đặt active=false ban đầu)\nBật BlockInputEvents trên node này để chặn click xuyên qua' })
    overlayNode: Node | null = null;

    // ─── PANEL ───
    @property({ type: Node, tooltip: 'Node panel popup (con của overlay)' })
    popupNode: Node | null = null;

    // ─── LABELS ───
    @property({ type: Label, tooltip: 'Label tiêu đề popup (ẩn khi title rỗng)' })
    titleLabel: Label | null = null;

    @property({ type: RichText, tooltip: 'Label nội dung thông báo (multiline)' })
    messageLabel: RichText | null = null;

    // ─── OK CONTAINER (loại message thường) ───
    @property({ type: Node, tooltip: 'Node chứa nút OK — hiện khi popup loại message thường' })
    okContainer: Node | null = null;

    @property({ type: Button, tooltip: 'Nút OK' })
    okButton: Button | null = null;

    @property({ type: Label, tooltip: 'Label của nút OK' })
    okLabel: Label | null = null;

    // ─── CONFIRM CONTAINER (loại confirm) ───
    @property({ type: Node, tooltip: 'Node chứa nút Confirm + Cancel — hiện khi popup loại confirm' })
    confirmContainer: Node | null = null;

    @property({ type: Button, tooltip: 'Nút Confirm' })
    confirmButton: Button | null = null;

    @property({ type: Label, tooltip: 'Label của nút Confirm' })
    confirmLabel: Label | null = null;

    @property({ type: Button, tooltip: 'Nút Cancel' })
    cancelButton: Button | null = null;

    @property({ type: Label, tooltip: 'Label của nút Cancel' })
    cancelLabel: Label | null = null;

    // ─── ANIMATION ───
    @property({ tooltip: 'Thời gian scale-in popup (giây)' })
    tweenInDuration: number = 0.2;

    @property({ tooltip: 'Thời gian scale-out popup (giây)' })
    tweenOutDuration: number = 0.15;

    // ─── PRIVATE STATE ───
    private _isOpen: boolean = false;
    private _onConfirmCallback: (() => void) | null = null;
    private _onCancelCallback: (() => void) | null = null;

    // ─── LIFECYCLE ───

    onLoad(): void {
        PopupMessageController._instance = this;

        EventBus.instance.on(GameEvents.SHOW_SYSTEM_POPUP, this._onShowSystemPopup, this);
        EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, this._onLanguageChanged, this);

        // Bind buttons
        if (this.okButton) {
            this.okButton.node.on('click', this._onOkClick, this);
        }
        if (this.confirmButton) {
            this.confirmButton.node.on('click', this._onConfirmClick, this);
        }
        if (this.cancelButton) {
            this.cancelButton.node.on('click', this._onCancelClick, this);
        }

        // Đảm bảo ẩn ban đầu (giống các popup khác — không tin vào trạng thái trong Editor)
        if (this.overlayNode) this.overlayNode.active = false;
        if (this.popupNode) {
            this.popupNode.active = false;
            this.popupNode.setScale(new Vec3(1, 1, 1));
        }

        // Thêm BlockInputEvents nếu chưa có
        if (this.overlayNode && !this.overlayNode.getComponent(BlockInputEvents)) {
            this.overlayNode.addComponent(BlockInputEvents);
        }

        // Set button labels từ localization
        this._setButtonLabels();
    }

    onDestroy(): void {
        if (PopupMessageController._instance === this) {
            PopupMessageController._instance = null;
        }
        EventBus.instance.offTarget(this);
    }

    // ─── API CÔNG KHAI ───

    /**
     * Hiện popup với nội dung chỉ định.
     * Thường dùng qua EventBus với SHOW_SYSTEM_POPUP event.
     */
    show(payload: SystemPopupPayload): void {
        if (this._isOpen) return;

        const { popupCase, onConfirm, onCancel } = payload;
        const data = PopUpMessage.get(popupCase);
        const isConfirm = PopUpMessage.isConfirmType(popupCase);

        // RELOGIN / EXPIRED_LINK / DISCONNECTED: sau khi OK phải reload loading scene để restart game
        const needsRestart = popupCase === PopupCase.RELOGIN || popupCase === PopupCase.EXPIRED_LINK || popupCase === PopupCase.DISCONNECTED;
        const resolvedConfirm = needsRestart
            ? () => {
                if (onConfirm) onConfirm();
                // Reset session trước khi reload để LoadingController không bị skip
                GameData.instance.resetSession();
                director.loadScene('loading');
            }
            : onConfirm;

        // Gán nội dung
        if (this.titleLabel) {
            this.titleLabel.string = data.title;
            this.titleLabel.node.active = data.title.length > 0;
        }
        if (this.messageLabel) {
            this.messageLabel.string = data.message;
        }

        // Toggle container theo loại popup
        if (this.okContainer) this.okContainer.active = !isConfirm;
        if (this.confirmContainer) this.confirmContainer.active = isConfirm;

        // Lưu callbacks
        this._onConfirmCallback = resolvedConfirm ?? null;
        this._onCancelCallback = onCancel ?? null;

        // Hiện overlay + animate panel
        this._isOpen = true;
        if (this.overlayNode) this.overlayNode.active = true;

        if (this.popupNode) {
            Tween.stopAllByTarget(this.popupNode);
            this.popupNode.active = true;
            this.popupNode.setScale(new Vec3(0, 0, 1));
            tween(this.popupNode)
                .to(this.tweenInDuration, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }
    }

    // ─── EVENT HANDLERS ───

    private _onShowSystemPopup(payload: SystemPopupPayload): void {
        this.show(payload);
    }

    private _onLanguageChanged(): void {
        this._setButtonLabels();
    }

    private _onOkClick(): void {
        const cb = this._onConfirmCallback;
        this._close(() => {
            if (cb) cb();
        });
    }

    private _onConfirmClick(): void {
        const cb = this._onConfirmCallback;
        this._close(() => {
            if (cb) cb();
        });
    }

    private _onCancelClick(): void {
        const cb = this._onCancelCallback;
        this._close(() => {
            if (cb) cb();
        });
    }

    // ─── INTERNAL ───

    private _close(afterClose?: () => void): void {
        if (!this._isOpen) return;
        this._isOpen = false;
        this._onConfirmCallback = null;
        this._onCancelCallback = null;

        if (this.popupNode) {
            Tween.stopAllByTarget(this.popupNode);
            tween(this.popupNode)
                .to(this.tweenOutDuration, { scale: new Vec3(0, 0, 1) }, { easing: 'backIn' })
                .call(() => {
                    if (this.popupNode) this.popupNode.active = false;
                    if (this.overlayNode) this.overlayNode.active = false;
                    if (afterClose) afterClose();
                })
                .start();
        } else {
            if (this.overlayNode) this.overlayNode.active = false;
            if (afterClose) afterClose();
        }
    }

    private _setButtonLabels(): void {
        if (this.okLabel) this.okLabel.string = L('UI_POPUP_SYSTEM_OK');
        if (this.confirmLabel) this.confirmLabel.string = L('UI_POPUP_SYSTEM_CONFIRM');
        if (this.cancelLabel) this.cancelLabel.string = L('UI_POPUP_SYSTEM_CANCEL');
    }
}
