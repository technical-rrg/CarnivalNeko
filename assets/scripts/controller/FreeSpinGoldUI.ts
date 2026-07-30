/**
 * FreeSpinGoldUI — Hiển thị UI cho chế độ FreeSpin Gold (GoF 8 lượt quay đồng xu vàng).
 *
 * Tương tự TopUpUI nhưng dành cho FreeSpin Gold mode.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "FreeSpinGoldUI" trong scene, đặt active=false ban đầu.
 *   2. Gắn component này vào node đó.
 *   3. Kéo các SpriteNumber vào đúng slot bên dưới.
 *   4. Kéo reference vào slot gameManager trong Inspector nếu cần.
 *
 * ── NODE STRUCTURE ──
 *   FreeSpinGoldUI (Node)
 *   ├── spinsRemainingSpriteNumber  ← Số lượt quay còn lại
 *   ├── eachWinSpriteNumber         ← Win của spin hiện tại (totalWin mỗi spin)
 *   └── goldTotalSpriteNumber       ← Tổng credit từ đồng xu vàng tích lũy
 *
 * ── EVENTS LISTENED ──
 *   FREE_SPIN_GOLD_START   → Show UI, khởi tạo giá trị
 *   FREE_SPIN_GOLD_COUNT_UPDATED → Cập nhật số lượt còn lại
 *   FREE_SPIN_GOLD_EACH_WIN      → Cập nhật win của spin hiện tại
 *   FREE_SPIN_GOLD_ABSORB_CREDIT → Cộng dồn credit đồng xu vàng
 *   FREE_SPIN_GOLD_END           → Ẩn UI
 */

import { _decorator, Component } from 'cc';
import { EventBus }              from '../core/EventBus';
import { GameEvents }            from '../core/GameEvents';
import { SpriteNumber }          from '../core/SpriteNumber';
import { Log }                   from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('FreeSpinGoldUI')
export class FreeSpinGoldUI extends Component {

    // ── INSPECTOR ──────────────────────────────────────────────────────────────

    @property({
        type: SpriteNumber,
        tooltip: 'FreeSpin Gold UI: số lượt quay còn lại.',
    })
    spinsRemainingSpriteNumber: SpriteNumber | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'FreeSpin Gold UI: tổng credit đồng đỏ từ trigger (featureBaseCredit) — số tĩnh, hiển thị 1 lần khi vào mode.',
    })
    eachWinSpriteNumber: SpriteNumber | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'FreeSpin Gold UI: tổng credit tích lũy từ đồng xu vàng — cộng dồn sau mỗi đồng hút xong.',
    })
    goldTotalSpriteNumber: SpriteNumber | null = null;

    // ── STATE ──────────────────────────────────────────────────────────────────

    private _goldAccumulated: number = 0;
    private _lastSpinsRemaining: number = -1;

    // ── LIFECYCLE ──────────────────────────────────────────────────────────────

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.FREE_SPIN_GOLD_START,         this._onStart,        this);
        bus.on(GameEvents.FREE_SPIN_GOLD_COUNT_UPDATED, this._onCountUpdated, this);
        bus.on(GameEvents.FREE_SPIN_GOLD_ABSORB_CREDIT, this._onAbsorbCredit, this);
        bus.on(GameEvents.FREE_SPIN_GOLD_END,           this._onEnd,          this);

        // Ẩn ban đầu
        this.node.active = false;
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ── EVENT HANDLERS ────────────────────────────────────────────────────────

    private _onStart(payload: { spinsRemaining: number; baseCredit: number }): void {
        this._goldAccumulated = 0;
        this._lastSpinsRemaining = payload.spinsRemaining;
        this.node.active = true;

        if (this.spinsRemainingSpriteNumber) {
            this.spinsRemainingSpriteNumber.node.active = true;
            this.spinsRemainingSpriteNumber.setData(payload.spinsRemaining, -1, 0);
        }
        // eachWinSpriteNumber = tổng đỏ từ trigger (featureBaseCredit) — số tĩnh, không đổi trong suốt mode
        if (this.eachWinSpriteNumber) {
            this.eachWinSpriteNumber.node.active = true;
            this.eachWinSpriteNumber.setData(payload.baseCredit, -1, 0, true);
        }
        if (this.goldTotalSpriteNumber) {
            this.goldTotalSpriteNumber.node.active = true;
            this.goldTotalSpriteNumber.setData(0);
        }
    }

    private _onCountUpdated(count: number): void {
        if (!this.spinsRemainingSpriteNumber) return;
        if (count === this._lastSpinsRemaining) return;
        this._lastSpinsRemaining = count;
        this.spinsRemainingSpriteNumber.node.active = true;
        this.spinsRemainingSpriteNumber.setData(count, -1, 0);
    }

    /** Mỗi đồng xu vàng hút xong → cộng credit vào tổng vàng */
    private _onAbsorbCredit(payload: { credit: number }): void {
        Log.e(`[GOLD-FLY][UI._onAbsorbCredit] credit=${payload.credit} before=${this._goldAccumulated} after=${this._goldAccumulated + payload.credit}`);
        this._goldAccumulated += payload.credit;
        this._showGoldTotal();
    }

    private _showGoldTotal(): void {
        if (!this.goldTotalSpriteNumber) return;
        this.goldTotalSpriteNumber.node.active = true;
        this.goldTotalSpriteNumber.setData(this._goldAccumulated, -1, 0, true);
    }

    private _onEnd(): void {
        this.node.active = false;
        if (this.spinsRemainingSpriteNumber) this.spinsRemainingSpriteNumber.node.active = false;
        if (this.eachWinSpriteNumber)        this.eachWinSpriteNumber.node.active        = false;
        if (this.goldTotalSpriteNumber)      this.goldTotalSpriteNumber.node.active      = false;
        this._goldAccumulated = 0;
        this._lastSpinsRemaining = -1;
    }
}
