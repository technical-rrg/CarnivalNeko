import { _decorator, Button, Component, ImageAsset, Label, Sprite, SpriteFrame, Texture2D, assetManager } from 'cc';
import { IBonusItem } from './SlotTypes';
import { formatCurrency } from '../core/FormatUtils';
import { L } from '../core/LocalizationManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('BuyBonusItemUI')
export class BuyBonusItemUI extends Component {
    @property(Label) nameLabel: Label = null;
    @property(Label) infoLabel: Label = null;
    @property(Label) priceLabel: Label = null;
    @property(Sprite) thumbnailSprite: Sprite = null;
    @property(Button) actionButton: Button = null;
    @property(Label) actionLabel: Label = null; // Chữ "BUY" hoặc "ACTIVATE"

    private _item: IBonusItem | null = null;
    private _onActionClick: ((item: IBonusItem) => void) | null = null;

    /** Item đang được hiển thị bởi row này */
    public get item(): IBonusItem | null { return this._item; }

    /**
     * Gán dữ liệu và sự kiện cho item row này.
     * Gọi một lần sau khi instantiate template.
     */
    public setup(
        item: IBonusItem,
        price: number,
        canAfford: boolean,
        onActionClick: (item: IBonusItem) => void,
    ): void {
        this._item = item;
        this._onActionClick = onActionClick;

        if (this.nameLabel)  this.nameLabel.string = item.itemName;
        if (this.infoLabel)  this.infoLabel.string = item.itemInfo;

        // Prefab cũ có thể chưa gán actionLabel — fallback label con của nút
        const actionLbl = this.actionLabel
            ?? this.actionButton?.getComponentInChildren(Label)
            ?? null;
        if (actionLbl) {
            actionLbl.string = item.applyType === 'onceuse'
                ? L('UI_POPUP_BUYBONUS_BUY')
                : L('UI_POPUP_BUYBONUS_ACTIVATE');
        }

        if (this.thumbnailSprite && item.thumbnailImage) {
            loadRemoteSprite(item.thumbnailImage, (frame) => {
                if (this.thumbnailSprite && frame) this.thumbnailSprite.spriteFrame = frame;
            });
        }

        // Bind click — off trước để tránh duplicate nếu setup() bị gọi lại
        if (this.actionButton) {
            this.actionButton.node.off(Button.EventType.CLICK, this._onButtonClick, this);
            this.actionButton.node.on(Button.EventType.CLICK, this._onButtonClick, this);
        }

        this.refresh(price, canAfford);
    }

    /**
     * Cập nhật Price label và trạng thái interactable của nút.
     * Gọi khi totalBet hoặc balance thay đổi.
     */
    public refresh(price: number, canAfford: boolean): void {
        if (this.priceLabel)   this.priceLabel.string        = L('CLIENT_CURRENENCY_SYMBOL') + formatCurrency(price);
        if (this.actionButton) this.actionButton.interactable = canAfford;
    }

    private _onButtonClick(): void {
        if (this._item && this._onActionClick) {
            this._onActionClick(this._item);
        }
    }

    onDestroy(): void {
        if (this.actionButton) {
            this.actionButton.node.off(Button.EventType.CLICK, this._onButtonClick, this);
        }
    }
}

/** Load ảnh từ URL và trả về SpriteFrame qua callback */
export function loadRemoteSprite(url: string, callback: (frame: SpriteFrame | null) => void): void {
    if (!url) { callback(null); return; }
    assetManager.loadRemote<ImageAsset>(url, { ext: '.png' }, (err, imageAsset) => {
        if (err || !imageAsset) { Log.w('[loadRemoteSprite] Failed:', url, err); callback(null); return; }
        const texture = new Texture2D();
        texture.image = imageAsset;
        const frame = new SpriteFrame();
        frame.texture = texture;
        callback(frame);
    });
}

