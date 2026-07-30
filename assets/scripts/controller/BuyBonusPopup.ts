/**
 * BuyBonusPopup - Popup chọn và xác nhận mua gói Free Spin (Buy Bonus).
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "BuyBonusPopup" con của Canvas, đặt trên cùng Hierarchy.
 *   2. Gắn component BuyBonusPopup.
 *   3. Kéo các Node/Label/Button vào đúng slot.
 *   4. Đặt popupNode.active = false trong Editor.
 *
 * ── FLOW ──
 *   BUY_BONUS_REQUEST →
 *     GameManager gọi FeatureItemGet →
 *     BUY_BONUS_ITEMS_LOADED (items[]) →
 *     Popup hiện lên với thông tin item + giá →
 *     Confirm → emit BUY_BONUS_CONFIRM(item) →
 *     GameManager gọi FeatureItemBuy →
 *     BUY_BONUS_SUCCESS: đóng popup, WalletManager cập nhật, _enterFreeSpin bắt đầu
 *     BUY_BONUS_FAILED: bật lại nút Confirm, hiện thông báo lỗi
 */

import { _decorator, Component, Node, Label, Button, tween, Vec3, BlockInputEvents } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { FeatureItem } from '../data/SlotTypes';
import { formatCurrency } from '../core/FormatUtils';
import { Log } from '../core/Logger';
import { BetManager } from '../manager/BetManager';

const { ccclass, property } = _decorator;

@ccclass('BuyBonusPopup')
export class BuyBonusPopup extends Component {

    @property({ type: Node, tooltip: 'Node bọc toàn bộ popup (đặt active=false ban đầu)' })
    popupNode: Node | null = null;

    @property({ type: Label, tooltip: 'Label tiêu đề gói (item.title, ví dụ "BUY FREE SPINS")' })
    titleLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label mô tả gói (item.desc)' })
    descLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label giá mua (ví dụ "Cost: 10,000")' })
    priceLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label số Free Spin sẽ nhận (ví dụ "10 FREE SPINS")' })
    spinCountLabel: Label | null = null;

    @property({ type: Label, tooltip: '(Tuỳ chọn) Label hiển thị lỗi khi mua thất bại' })
    errorLabel: Label | null = null;

    @property({ type: Button, tooltip: 'Nút xác nhận mua' })
    confirmButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút huỷ / đóng popup' })
    cancelButton: Button | null = null;

    // ─── State ───

    private _selectedItem: FeatureItem | null = null;
    private _isOpen: boolean = false;
    private _isPurchasing: boolean = false;

    // ─── LIFECYCLE ───

    onLoad(): void {
        if (this.popupNode) this.popupNode.active = false;
        // Chặn touch xuyên qua xuống các node bên dưới khi popup đang hiển thị
        if (!this.node.getComponent(BlockInputEvents)) {
            this.node.addComponent(BlockInputEvents);
        }

        if (this.confirmButton) {
            this.confirmButton.node.on('click', this._onConfirm, this);
        }
        if (this.cancelButton) {
            this.cancelButton.node.on('click', this._onCancel, this);
        }

        const bus = EventBus.instance;
        bus.on(GameEvents.BUY_BONUS_ITEMS_LOADED, this._onItemsLoaded,   this);
        bus.on(GameEvents.BUY_BONUS_SUCCESS,       this._onBuySuccess,    this);
        bus.on(GameEvents.BUY_BONUS_FAILED,        this._onBuyFailed,     this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ─── EVENTS FROM GAME MANAGER ───

    private _onItemsLoaded(items: FeatureItem[]): void {
        if (items.length === 0) {
            Log.w('[BuyBonusPopup] Items array rỗng, không hiện popup.');
            return;
        }

        // Lấy item đầu tiên (hoặc mở rộng sau để hỗ trợ nhiều item)
        const item = items[0];
        this._selectedItem = item;

        // Giá tuyệt đối = priceRatio × totalBet (FeatureItem chỉ lưu priceRatio)
        const cost = item.priceRatio * BetManager.instance.totalBet;
        const spinCount = item.addSpinValue ?? 10;

        Log.d(`[BuyBonusPopup] Items loaded — sẽ hiện popup. Item: "${item.title}", cost=${formatCurrency(cost)}, spins=${spinCount}`);

        if (this.titleLabel)     this.titleLabel.string     = item.title || item.name;
        if (this.descLabel)      this.descLabel.string      = item.desc;
        if (this.priceLabel)     this.priceLabel.string     = `Cost: ${formatCurrency(cost)}`;
        if (this.spinCountLabel) this.spinCountLabel.string = `${spinCount} FREE SPINS`;
        if (this.errorLabel)     this.errorLabel.string     = '';

        this._setConfirmInteractable(true);
        this._isPurchasing = false;
        this._show();
    }

    private _onBuySuccess(_data: { remainCash: number }): void {
        Log.d('[BuyBonusPopup] Mua thành công → đóng popup ngay (instant)');
        this._closeInstant();
    }

    private _onBuyFailed(reason: string): void {
        Log.w(`[BuyBonusPopup] Mua thất bại: ${reason}`);
        this._isPurchasing = false;
        this._setConfirmInteractable(true);
        if (this.errorLabel) {
            this.errorLabel.string = reason || 'Purchase failed. Please try again.';
        }
    }

    // ─── BUTTON HANDLERS ───

    private _onConfirm(): void {
        if (!this._selectedItem || this._isPurchasing) return;

        const cost = this._selectedItem.priceRatio * BetManager.instance.totalBet;
        Log.d(`[BuyBonusPopup] Xác nhận mua: "${this._selectedItem.title}" | cost=${formatCurrency(cost)}`);

        this._isPurchasing = true;
        this._setConfirmInteractable(false);
        if (this.errorLabel) this.errorLabel.string = '';

        // GameManager lắng nghe BUY_BONUS_CONFIRM → gọi FeatureItemBuy → emit SUCCESS/FAILED
        EventBus.instance.emit(GameEvents.BUY_BONUS_CONFIRM, this._selectedItem);
    }

    private _onCancel(): void {
        if (this._isPurchasing) return; // Không cho cancel khi đang xử lý
        Log.d('[BuyBonusPopup] Người dùng hủy mua bonus');
        this._close();
    }

    // ─── SHOW / HIDE ───

    private _show(): void {
        if (!this.popupNode || this._isOpen) return;
        this._isOpen = true;
        EventBus.instance.emit(GameEvents.POPUP_OPENED);

        this.popupNode.active = true;
        this.popupNode.setScale(new Vec3(0.1, 0.1, 1));

        tween(this.popupNode)
            .to(0.25, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'backOut' })
            .to(0.12, { scale: new Vec3(1, 1, 1) },       { easing: 'sineOut' })
            .start();
    }

    private _close(): void {
        if (!this.popupNode || !this._isOpen) return;
        this._isOpen = false;
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);
        this._selectedItem = null;
        this._isPurchasing = false;

        tween(this.popupNode)
            .to(0.15, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'sineOut' })
            .to(0.12, { scale: new Vec3(0.01, 0.01, 1) }, { easing: 'sineIn' })
            .call(() => {
                if (this.popupNode) this.popupNode.active = false;
            })
            .start();
    }

    /** Đóng popup ngay lập tức, không có animation — dùng khi Buy Bonus thành công. */
    private _closeInstant(): void {
        if (!this.popupNode) return;
        if (this._isOpen) EventBus.instance.emit(GameEvents.POPUP_CLOSED);
        this._isOpen = false;
        this._selectedItem = null;
        this._isPurchasing = false;
        tween(this.popupNode).stop();
        this.popupNode.active = false;
    }

    // ─── HELPERS ───

    private _setConfirmInteractable(enabled: boolean): void {
        if (this.confirmButton) this.confirmButton.interactable = enabled;
    }
}
