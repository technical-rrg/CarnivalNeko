/**
 * CoinPickButton — Script gắn trên mỗi coin node trong Pick Game.
 *
 * Tự động wire index → PickGamePopup.pickCoin(index) khi player tap.
 * Index ưu tiên lấy từ vị trí trong `coinNodes` (tránh lệch Inspector / Layout).
 *
 * ── SETUP ──
 *   1. Gắn CoinPickButton lên mỗi CoinNode (Coin0..Coin14, lưới 5×3).
 *   2. `coinIndex` có thể để 0 — PickGamePopup._wireCoinButtons() sẽ sync lại.
 *   3. Đảm bảo CoinNode có Button component (hoặc thêm vào).
 *   4. Kéo PickGamePopup component vào `pickGamePopup` (hoặc để null → wire lúc open).
 */

import { _decorator, Component, Button } from 'cc';
import { PickGamePopup } from './PickGamePopup';

const { ccclass, property } = _decorator;

@ccclass('CoinPickButton')
export class CoinPickButton extends Component {

    @property({ tooltip: 'Index của coin này trong grid (0..14). Sync bởi PickGamePopup khi open.' })
    coinIndex: number = 0;

    @property({
        type: PickGamePopup,
        tooltip: 'Kéo PickGamePopup component vào đây.\n'
               + 'CoinPickButton sẽ gọi pickCoin(index) khi bị tap.',
    })
    pickGamePopup: PickGamePopup | null = null;

    onLoad(): void {
        if (!this.getComponent(Button)) {
            this.node.addComponent(Button);
        }
        this.node.off(Button.EventType.CLICK, this._onClick, this);
        this.node.on(Button.EventType.CLICK, this._onClick, this);
    }

    onDestroy(): void {
        this.node.off(Button.EventType.CLICK, this._onClick, this);
    }

    private _onClick(): void {
        if (!this.pickGamePopup) return;
        const resolved = this.pickGamePopup.resolveCoinIndex(this.node);
        const index = resolved >= 0 ? resolved : this.coinIndex;
        this.pickGamePopup.pickCoin(index);
    }
}
