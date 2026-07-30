/**
 * ButtonSfx - Component phát tiếng click cho mọi Button node.
 *
 * ── CÁCH DÙNG ──
 *   1. Gắn component này vào bất kỳ Node nào có Button component.
 *   2. Không cần config gì thêm — tự động phát btnClickSound khi click.
 *   3. Nếu button đã có tiếng riêng (spinButton, betUp/Down), bật disableSound = true.
 *
 * ── DANH SÁCH NÚT NÊN THÊM COMPONENT NÀY ──
 *   UIController:
 *     - autoSpinFreeButton      ← nút mở auto spin
 *
 *   AutoSettingPopup:
 *     - btnMinus / btnPlus      ← nút điều chỉnh count
 *     - btnNormal / btnQuick / btnTurbo  ← nút chọn speed mode
 *     - closeButton             ← nút đóng popup
 *     - openButton              ← nút mở popup (nếu dùng)
 *
 *   ⛔ KHÔNG thêm vào:
 *     - spinButton              → đã có spinStartSound qua REELS_START_SPIN
 *     - betUpButton / betDownButton → đã có betChangeSound qua BET_CHANGED event
 *     - FreeSpinPopup.closeButton   → xử lý trong _close() để tránh phát 2 lần
 */

import { _decorator, Component, Button } from 'cc';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

@ccclass('ButtonSfx')
export class ButtonSfx extends Component {

    /** Tắt tiếng cho nút này (dùng khi button đã có tiếng riêng) */
    @property({ tooltip: 'Tắt tiếng click cho nút này\n(dùng khi button đã có âm thanh riêng)' })
    disableSound: boolean = false;

    onLoad(): void {
        this.node.on(Button.EventType.CLICK, this._onClick, this);
    }

    onDestroy(): void {
        this.node.off(Button.EventType.CLICK, this._onClick, this);
    }

    private _onClick(): void {
        if (this.disableSound) return;
        SoundManager.instance?.playButtonClick();
    }
}
