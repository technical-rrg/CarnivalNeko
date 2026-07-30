/**
 * EachWinDisplay — Hiển thị tổng credit Đồng xu Đỏ (Each Win / Base Credit)
 *
 * SETUP TRONG EDITOR:
 *   1. Tạo Node (ví dụ "EachWinDisplay") ở vị trí mong muốn (dưới reel mask hoặc trên HUD).
 *   2. Gắn component EachWinDisplay.
 *   3. Tạo child node có Label component → kéo vào slot `creditLabel`.
 *   4. (Optional) Tạo child node "Title" có Label → kéo vào slot `titleLabel` (sẽ hiện "EACH WINS").
 *   5. Node ban đầu nên inactive (active = false) — sẽ tự bật khi có Red coin.
 *
 * LOGIC:
 *   - Ẩn mặc định.
 *   - Khi nhận RED_CREDIT_UPDATED (mỗi khi reel dừng có Red) → hiện + cập nhật tổng.
 *   - Khi REELS_START_SPIN → ẩn + reset (chuẩn bị cho spin mới).
 *   - Khi FEATURE_SELECT_OPEN → giữ nguyên giá trị (popup sẽ dùng sumCredit riêng).
 */

import { _decorator, Component, Label, Node, tween, Vec3, Tween } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { LocalizationManager } from '../core/LocalizationManager';

const { ccclass, property } = _decorator;
const L = LocalizationManager.bind(LocalizationManager);

@ccclass('EachWinDisplay')
export class EachWinDisplay extends Component {

    @property({ type: Label, tooltip: 'Label hiển thị tổng credit Red (format số tiền)' })
    creditLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label tiêu đề "EACH WINS" (optional)' })
    titleLabel: Label | null = null;

    private _totalCredit: number = 0;

    onLoad(): void {
        // Ẩn ban đầu
        this.node.active = false;

        const bus = EventBus.instance;
        bus.on(GameEvents.RED_CREDIT_UPDATED, this._onRedCreditUpdated, this);
        bus.on(GameEvents.REELS_START_SPIN, this._onSpinStart, this);
    }

    onDestroy(): void {
        const bus = EventBus.instance;
        bus.off(GameEvents.RED_CREDIT_UPDATED, this._onRedCreditUpdated, this);
        bus.off(GameEvents.REELS_START_SPIN, this._onSpinStart, this);
    }

    private _onRedCreditUpdated(payload: { totalRedCredit: number; redCount: number }): void {
        this._totalCredit = payload.totalRedCredit;

        // Hiện node nếu chưa active
        if (!this.node.active) {
            this.node.active = true;
            this.node.setScale(0.1, 0.1, 1);
            Tween.stopAllByTarget(this.node);
            tween(this.node)
                .to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }

        // Cập nhật title
        if (this.titleLabel) {
            this.titleLabel.string = L('feature_select_each_wins') || 'EACH WINS';
        }

        // Cập nhật credit label với format tiền
        if (this.creditLabel) {
            this.creditLabel.string = this._formatCredit(this._totalCredit);
            // Pulse animation khi giá trị thay đổi
            Tween.stopAllByTarget(this.creditLabel.node);
            this.creditLabel.node.setScale(1.2, 1.2, 1);
            tween(this.creditLabel.node)
                .to(0.15, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
                .start();
        }
    }

    private _onSpinStart(): void {
        // Reset khi spin mới bắt đầu
        this._totalCredit = 0;
        Tween.stopAllByTarget(this.node);
        this.node.active = false;
    }

    private _formatCredit(value: number): string {
        if (value >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (value >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
        return value.toFixed(2).replace(/\.00$/, '');
    }
}
