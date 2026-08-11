/**
 * FreeSpinGoldUI — UI trên node FreeSpinUI (Base.prefab).
 *
 * Dùng cho:
 *   • FreeSpin Gold (legacy GoF)
 *   • Carnival Matsuri Hold&Spin (feature chính)
 *
 * TopUpUI không còn dùng cho Matsuri — luôn để FreeSpinUI.
 *
 * Events:
 *   FREE_SPIN_GOLD_*          → FreeSpin Gold mode
 *   CARNIVAL_MATSURI_START/END + TOPUP_COUNT/TOTAL + MATSURI_COLLECT_CREDIT → Matsuri
 */

import { _decorator, Component, Node } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { SpriteNumber } from '../core/SpriteNumber';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('FreeSpinGoldUI')
export class FreeSpinGoldUI extends Component {

    @property({
        type: SpriteNumber,
        tooltip: 'Số lượt quay còn lại (Remain).',
    })
    spinsRemainingSpriteNumber: SpriteNumber | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'Each win / base credit (optional).',
    })
    eachWinSpriteNumber: SpriteNumber | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'Tổng credit tích lũy (CoinCount / Title Credits acquired).',
    })
    goldTotalSpriteNumber: SpriteNumber | null = null;

    private _goldAccumulated: number = 0;
    private _lastSpinsRemaining: number = -1;
    private _matsuriMode = false;

    onLoad(): void {
        this._autoWireSpriteNumbers();

        const bus = EventBus.instance;
        bus.on(GameEvents.FREE_SPIN_GOLD_START, this._onGoldStart, this);
        bus.on(GameEvents.FREE_SPIN_GOLD_COUNT_UPDATED, this._onCountUpdated, this);
        bus.on(GameEvents.FREE_SPIN_GOLD_ABSORB_CREDIT, this._onAbsorbCredit, this);
        bus.on(GameEvents.FREE_SPIN_GOLD_END, this._onGoldEnd, this);

        // Matsuri / Carnival feature → dùng FreeSpinUI
        bus.on(GameEvents.CARNIVAL_MATSURI_START, this._onMatsuriStart, this);
        bus.on(GameEvents.CARNIVAL_MATSURI_END, this._onMatsuriEnd, this);
        bus.on(GameEvents.TOPUP_COUNT_UPDATED, this._onTopUpCount, this);
        bus.on(GameEvents.TOPUP_TOTAL_UPDATED, this._onTopUpTotal, this);
        bus.on(GameEvents.MATSURI_COLLECT_CREDIT, this._onMatsuriCollectCredit, this);

        this.node.active = false;
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    /** Tổng credit node — MatsuriEffect dùng làm đích bay. */
    getCollectTargetNode(): Node | null {
        return this.goldTotalSpriteNumber?.node
            ?? this.node.getChildByName('CoinCount')
            ?? this.node;
    }

    // ── FreeSpin Gold ─────────────────────────────────────────────────────────

    private _onGoldStart(payload: { spinsRemaining: number; baseCredit: number }): void {
        this._matsuriMode = false;
        this._showUI(payload.spinsRemaining, 0, payload.baseCredit);
    }

    private _onGoldEnd(): void {
        if (this._matsuriMode) return;
        this._hideUI();
    }

    private _onAbsorbCredit(payload: { credit: number }): void {
        if (this._matsuriMode) return;
        this._goldAccumulated += payload.credit ?? 0;
        this._showGoldTotal();
    }

    // ── Matsuri ───────────────────────────────────────────────────────────────

    private _onMatsuriStart(): void {
        this._matsuriMode = true;
        const data = GameData.instance;
        this._showUI(data.respinRemaining || 3, data.respinTotalWin || 0, data.featureBaseCredit || 0);
        Log.e('[FreeSpinUI] Matsuri START — FreeSpinUI active');
    }

    private _onMatsuriEnd(): void {
        if (!this._matsuriMode) return;
        this._matsuriMode = false;
        this._hideUI();
        Log.e('[FreeSpinUI] Matsuri END — FreeSpinUI hidden');
    }

    private _onTopUpCount(count: number): void {
        if (!this._matsuriMode) return;
        this._onCountUpdated(count);
    }

    private _onTopUpTotal(payload: { totalWin?: number }): void {
        if (!this._matsuriMode) return;
        if (payload?.totalWin == null) return;
        this._goldAccumulated = Math.max(0, payload.totalWin);
        GameData.instance.topUpDisplayedEachWin = this._goldAccumulated;
        this._showGoldTotal();
    }

    private _onMatsuriCollectCredit(payload: { credit?: number }): void {
        if (!this._matsuriMode) return;
        // TOPUP_TOTAL_UPDATED cũng tới — vẫn sync nếu chỉ có credit event
        if (payload?.credit != null && payload.credit > 0) {
            // total đã được GM cộng; sync từ GameData cho chắc
            this._goldAccumulated = GameData.instance.respinTotalWin;
            GameData.instance.topUpDisplayedEachWin = this._goldAccumulated;
            this._showGoldTotal();
        }
    }

    // ── Shared ────────────────────────────────────────────────────────────────

    private _showUI(spins: number, total: number, baseCredit: number): void {
        this._goldAccumulated = total;
        this._lastSpinsRemaining = spins;
        this.node.active = true;

        if (this.spinsRemainingSpriteNumber) {
            this.spinsRemainingSpriteNumber.node.active = true;
            this.spinsRemainingSpriteNumber.setData(spins, -1, 0);
        }
        if (this.eachWinSpriteNumber) {
            this.eachWinSpriteNumber.node.active = true;
            this.eachWinSpriteNumber.setData(baseCredit, -1, 0, true);
        }
        if (this.goldTotalSpriteNumber) {
            this.goldTotalSpriteNumber.node.active = true;
            this.goldTotalSpriteNumber.setData(total, -1, 0, true);
        }
    }

    private _hideUI(): void {
        this.node.active = false;
        if (this.spinsRemainingSpriteNumber) this.spinsRemainingSpriteNumber.node.active = false;
        if (this.eachWinSpriteNumber) this.eachWinSpriteNumber.node.active = false;
        if (this.goldTotalSpriteNumber) this.goldTotalSpriteNumber.node.active = false;
        this._goldAccumulated = 0;
        this._lastSpinsRemaining = -1;
    }

    private _onCountUpdated(count: number): void {
        if (!this.spinsRemainingSpriteNumber) return;
        if (count === this._lastSpinsRemaining) return;
        this._lastSpinsRemaining = count;
        this.spinsRemainingSpriteNumber.node.active = true;
        this.spinsRemainingSpriteNumber.setData(count, -1, 0);
    }

    private _showGoldTotal(): void {
        if (!this.goldTotalSpriteNumber) return;
        this.goldTotalSpriteNumber.node.active = true;
        this.goldTotalSpriteNumber.setData(this._goldAccumulated, -1, 0, true);
    }

    /** Tự tìm SpriteNumber trong FreeSpinUI nếu Inspector chưa gán. */
    private _autoWireSpriteNumbers(): void {
        const all = this.node.getComponentsInChildren(SpriteNumber);
        const remainRoot = this.node.getChildByName('Remain');
        const coinRoot = this.node.getChildByName('CoinCount');

        if (!this.spinsRemainingSpriteNumber && remainRoot) {
            this.spinsRemainingSpriteNumber =
                remainRoot.getComponentInChildren(SpriteNumber) ?? null;
        }
        if (!this.goldTotalSpriteNumber && coinRoot) {
            this.goldTotalSpriteNumber =
                coinRoot.getComponentInChildren(SpriteNumber) ?? null;
        }
        // Fallback: Remaining = first SN under Remain; Total = first under CoinCount; else by index
        if (!this.spinsRemainingSpriteNumber && all.length > 0) {
            this.spinsRemainingSpriteNumber = all[0];
        }
        if (!this.goldTotalSpriteNumber && all.length > 1) {
            this.goldTotalSpriteNumber = all[all.length - 1];
        }

        Log.d(
            `[FreeSpinUI] wire remain=${!!this.spinsRemainingSpriteNumber} ` +
            `total=${!!this.goldTotalSpriteNumber} each=${!!this.eachWinSpriteNumber}`,
        );
    }
}
