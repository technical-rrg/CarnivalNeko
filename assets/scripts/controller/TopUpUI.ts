/**
 * TopUpUI — Hiển thị UI cho chế độ Top Up.
 *
 * Gắn component này lên node TopUpUI trong scene.
 * Lắng nghe các event TopUp để hiện/ẩn và cập nhật số tiền.
 *
 * ── PROPERTIES ──
 *   • spinsRemainingSpriteNumber   — Số lần quay còn lại trong Top Up.
 *   • totalCoinCreditSpriteNumber  — Tổng số coin đỏ/vàng/xanh đang xuất hiện trên grid.
 *   • topUpBaseCreditSpriteNumber  — Tổng tiền các đồng đỏ trước khi vào Top Up.
 *   • topUpAccumulatedSpriteNumber — Tổng tiền đang kiếm được trong Top Up.
 */

import { _decorator, Component, Node, Widget, screen } from 'cc';
import { EventBus }              from '../core/EventBus';
import { GameEvents }            from '../core/GameEvents';
import { GameData }              from '../data/GameData';
import { SymbolId }              from '../data/SlotTypes';
import { SpriteNumber }          from '../core/SpriteNumber';
import { Log }                   from '../core/Logger';
import { OrientationLayout }     from './OrientationLayout';

const { ccclass, property } = _decorator;

@ccclass('TopUpUI')
export class TopUpUI extends Component {

    // ── INSPECTOR ──────────────────────────────────────────────────────────────

    @property({
        type: SpriteNumber,
        tooltip: 'Topup UI: số lần quay còn lại.',
    })
    spinsRemainingSpriteNumber: SpriteNumber | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'Topup UI: tổng số đồng xu sticky (đỏ + vàng + xanh) đang hiển thị trên grid.',
    })
    totalCoinCreditSpriteNumber: SpriteNumber | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'Topup UI: tổng tiền các đồng đỏ trước khi vào Top Up.',
    })
    topUpBaseCreditSpriteNumber: SpriteNumber | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'Topup UI: tổng tiền đang kiếm được trong Top Up — cộng dồn sau mỗi đồng Vàng/Xanh hút xong.',
    })
    topUpAccumulatedSpriteNumber: SpriteNumber | null = null;

    // ── STATE ──────────────────────────────────────────────────────────────────

    /** Tổng credit đang hiển thị — cộng dồn qua từng coin absorb */
    private _accumulated: number = 0;

    /** Baseline worldY lần đầu vào TopUp */
    private _remainBaselineWorldY: number | null = null;

    // ── LIFECYCLE ──────────────────────────────────────────────────────────────

    onLoad(): void {
        EventBus.instance.on(GameEvents.TOPUP_START,         this._onTopUpStart,         this);
        EventBus.instance.on(GameEvents.TOPUP_COUNT_UPDATED, this._onTopUpCountUpdated,   this);
        EventBus.instance.on(GameEvents.TOPUP_TOTAL_UPDATED, this._onTopUpTotalUpdated,   this);
        EventBus.instance.on(GameEvents.TOPUP_ABSORB_CREDIT, this._onAbsorbCredit,        this);
        EventBus.instance.on(GameEvents.TOPUP_NEXT_WIN_UPDATED, this._onTopUpNextWinUpdated, this);
        EventBus.instance.on(GameEvents.TOPUP_END,           this._onTopUpEnd,            this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ── EVENT HANDLERS ────────────────────────────────────────────────────────

    private _onTopUpStart(payload: { spinsRemaining: number; baseCredit: number; totalWin: number }): void {
        // EachWin/NextWin is the TopUp win amount; base red credit is displayed separately.
        this._accumulated = Math.max(0, payload.totalWin ?? 0);
        this._showAccumulated();
        this._onTopUpCountUpdated(payload.spinsRemaining);
        if (this.topUpBaseCreditSpriteNumber) {
            this.topUpBaseCreditSpriteNumber.node.active = true;
            this.topUpBaseCreditSpriteNumber.setData(payload.baseCredit, -1, 0, true);
        }
        this._showTotalCoinCount();
        // 1 log sau khi layout ổn định
        this.scheduleOnce(() => this._logRemainPos('TOPUP'), 0.5);
    }

    private _onTopUpCountUpdated(count: number): void {
        if (!this.spinsRemainingSpriteNumber) return;
        this.spinsRemainingSpriteNumber.node.active = true;
        this.spinsRemainingSpriteNumber.setData(count);
    }

    // ── REMAIN POS DEBUG (1 dòng / lần) ────────────────────────────────────────

    private _findRemainNode(): Node | null {
        return this.node.getChildByName('Remain')
            ?? this.spinsRemainingSpriteNumber?.node?.parent?.parent
            ?? null;
    }

    /** In 1 dòng vị trí Remain + Number; chỉ thêm dòng ★ nếu worldY lệch so baseline. */
    private _logRemainPos(phase: string): void {
        const remain = this._findRemainNode();
        if (!remain) {
            Log.e(`[REMAIN-POS] ${phase} Remain=<missing>`);
            return;
        }

        const number = this.spinsRemainingSpriteNumber?.node
            ?? remain.getChildByName('Panel')?.getChildByName('Number')
            ?? null;
        const parent = this.node;
        const w = remain.getComponent(Widget);
        const ol = remain.getComponent(OrientationLayout);
        const isPortrait = screen.windowSize.height > screen.windowSize.width;
        const olData = ol ? (isPortrait ? ol.portrait : ol.landscape) : null;

        const remainLocalY = remain.position.y;
        const remainWorldY = remain.worldPosition.y;
        const parentWorldY = parent.worldPosition.y;
        const numberWorldY = number?.worldPosition.y ?? NaN;

        if (this._remainBaselineWorldY == null) {
            this._remainBaselineWorldY = remainWorldY;
        }
        const delta = remainWorldY - this._remainBaselineWorldY;

        Log.e(
            `[REMAIN-POS] ${phase} ` +
            `Remain localY=${remainLocalY.toFixed(1)} worldY=${remainWorldY.toFixed(1)} ` +
            `Number worldY=${Number.isFinite(numberWorldY) ? numberWorldY.toFixed(1) : 'n/a'} ` +
            `TopUpUI worldY=${parentWorldY.toFixed(1)} ` +
            (w ? `Widget(T=${w.isAlignTop}/${w.top.toFixed(0)},VC=${w.isAlignVerticalCenter}/${w.verticalCenter.toFixed(0)}) ` : '') +
            (olData ? `OL posY=${olData.posY.toFixed(1)} alignTop=${olData.isAlignTop} ` : '') +
            `ΔworldY=${delta.toFixed(1)}`
        );

        if (Math.abs(delta) > 0.5) {
            Log.e(
                `[REMAIN-POS] ★ ${phase} Remain worldY lệch ${delta.toFixed(1)}px so với lần đầu ` +
                `(localY=${remainLocalY.toFixed(1)} parentWorldY=${parentWorldY.toFixed(1)})`
            );
        }
    }

    private _onTopUpTotalUpdated(payload: { baseCredit?: number; totalWin?: number; deferEachWin?: boolean }): void {
        if (this.topUpBaseCreditSpriteNumber && payload.baseCredit != null) {
            this.topUpBaseCreditSpriteNumber.node.active = true;
            this.topUpBaseCreditSpriteNumber.setData(payload.baseCredit, -1, 0, true);
        }
        if (payload.totalWin != null && !payload.deferEachWin) {
            this._accumulated = Math.max(0, payload.totalWin);
            this._showAccumulated();
        }
        this._showTotalCoinCount();
    }

    /** Sau khi 1 dong Vang/Xanh hut xong → cong credit cua no vao tong */
    private _onAbsorbCredit(payload: { credit: number; visualCredit?: number; totalWin?: number }): void {
        if (payload.totalWin != null) {
            this._accumulated = Math.max(0, payload.totalWin);
        } else {
            this._accumulated += payload.credit;
        }
        this._showAccumulated();
        this._showTotalCoinCount();
    }

    private _onTopUpNextWinUpdated(_value: number): void {
        // NextWin/tiền thắng được hiển thị qua accumulated; totalCoin chỉ là số lượng coin.
    }

    private _showAccumulated(): void {
        GameData.instance.topUpDisplayedEachWin = this._accumulated;
        if (!this.topUpAccumulatedSpriteNumber) return;
        this.topUpAccumulatedSpriteNumber.node.active = true;
        this.topUpAccumulatedSpriteNumber.setData(this._accumulated, -1, 0, true);
    }

    private _showTotalCoinCount(): void {
        if (!this.totalCoinCreditSpriteNumber) return;
        this.totalCoinCreditSpriteNumber.node.active = true;
        this.totalCoinCreditSpriteNumber.setData(this._getTopUpCoinCount(), -1, 0, true);
    }

    private _getTopUpCoinCount(): number {
        let count = 0;
        for (const cell of GameData.instance.stickyCells.values()) {
            if (
                cell.symbolId === SymbolId.STICKY_YELLOW ||
                cell.symbolId === SymbolId.STICKY_GREEN
            ) {
                count++;
            }
        }
        return count;
    }

    private _onTopUpEnd(): void {
        if (this.spinsRemainingSpriteNumber)   this.spinsRemainingSpriteNumber.node.active = false;
        if (this.totalCoinCreditSpriteNumber)  this.totalCoinCreditSpriteNumber.node.active = false;
        if (this.topUpBaseCreditSpriteNumber)  this.topUpBaseCreditSpriteNumber.node.active = false;
        if (this.topUpAccumulatedSpriteNumber) this.topUpAccumulatedSpriteNumber.node.active = false;
        this._accumulated = 0;
        GameData.instance.topUpDisplayedEachWin = 0;
        this._remainBaselineWorldY = null;
    }
}
