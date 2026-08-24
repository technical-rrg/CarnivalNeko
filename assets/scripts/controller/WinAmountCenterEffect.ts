/**
 * WinAmountCenterEffect — Effect hiển thị số tiền thắng zoom in/out ở giữa màn hình.
 *
 * ── FEATURE ──
 *   Khi WIN_SHOW_ALL_WAYS fire (tất cả symbol winning được highlight cùng lúc),
 *   hiển thị tổng tiền thắng của spin (totalWin từ GameData.lastSpinResponse) ở giữa màn hình:
 *     • Scale 0 → 1  (backOut, 0.35s)
 *     • Giữ 1 giây
 *     • Scale 1 → 0  (backIn, 0.25s)
 *   Effect cố định ở giữa màn hình (node nằm ở Canvas center).
 *   Reset khi spin mới bắt đầu.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "WinAmountCenterEffect" con của Canvas, position = (0, 0).
 *   2. Gắn component này.
 *   3. Tạo child node "Container" chứa bất kỳ background + SpriteNumber:
 *        Container (Node)
 *          ├── BG (Sprite — nền mờ tùy chọn)
 *          └── amountLabel (SpriteNumber — số tiền bằng bitmap)
 *   4. Kéo Container vào slot "effectNode".
 *   5. Kéo SpriteNumber vào slot "amountLabel".
 *   6. Đặt effectNode.active = false ban đầu.
 */

import { _decorator, Component, Node, tween, Vec3, Tween } from 'cc';
import { SpriteNumber } from '../core/SpriteNumber';
import { EventBus }      from '../core/EventBus';
import { GameEvents }    from '../core/GameEvents';
import { WaysPayWin, MatchedLinePay } from '../data/SlotTypes';
import { GameData }      from '../data/GameData';
import { Log }           from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('WinAmountCenterEffect')
export class WinAmountCenterEffect extends Component {

    // ── INSPECTOR ──────────────────────────────────────────────────────────────

    @property({
        type: Node,
        tooltip: 'Container node chứa background + label. Đặt ở giữa Canvas.\n'
               + 'Sẽ được scale 0 → 1 → 0.',
    })
    effectNode: Node | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'SpriteNumber hiển thị số tiền thắng bằng bitmap font.',
    })
    amountLabel: SpriteNumber | null = null;

    @property({ tooltip: 'Thời gian zoom-in (giây).' })
    zoomInDuration: number = 0.35;

    @property({ tooltip: 'Thời gian giữ sau khi zoom-in (giây).' })
    holdDuration: number = 1.0;

    @property({ tooltip: 'Thời gian zoom-out (giây).' })
    zoomOutDuration: number = 0.25;

    // ── STATE ──────────────────────────────────────────────────────────────────

    /** Đã hiện lần đầu trong spin này chưa? */
    private _shownThisSpin: boolean = false;

    // ── LIFECYCLE ──────────────────────────────────────────────────────────────

    onLoad(): void {
        // Log.d(`[WinAmountCenterEffect] onLoad — effectNode=${!!this.effectNode}, amountLabel(SpriteNumber)=${!!this.amountLabel}`);
        EventBus.instance.on(GameEvents.WIN_SHOW_ALL_WAYS,  this._onShowAllWays,     this);
        // Real API dùng MatchedLinePays (không có waysPayWins) → WIN_SHOW_ALL_LINES
        EventBus.instance.on(GameEvents.WIN_SHOW_ALL_LINES,  this._onShowAllLines,    this);
        EventBus.instance.on(GameEvents.REELS_START_SPIN,   this._onReelsStartSpin,  this);

        if (this.effectNode) this.effectNode.active = false;
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ── EVENT HANDLERS ──────────────────────────────────────────────────────────

    private _onReelsStartSpin(): void {
        this._shownThisSpin = false;
        // Hủy tween và ẩn ngay nếu đang hiển thị
        if (this.effectNode) {
            Tween.stopAllByTarget(this.effectNode);
            this.effectNode.active = false;
        }
    }

    /**
     * WIN_SHOW_ALL_WAYS — fire đúng lúc tất cả symbol winning được highlight cùng lúc.
     * Chỉ phản ứng lần đầu tiên mỗi spin.
     *
     * Lấy totalWin từ GameData.lastSpinResponse (luôn được set trước khi bất kỳ
     * WIN_* event nào fire) — tránh race condition khi dùng WIN_PRESENT_START.
     */
    private _onShowAllWays(ways: WaysPayWin[], _duration: number): void {
        // Log.d(`[WinAmountCenterEffect] _onShowAllWays fired — _shownThisSpin=${this._shownThisSpin}, waysLen=${ways?.length ?? 0}`);
        if (!ways || ways.length === 0) return;
        this._tryShowWinAmount('WAYS', ways.length);
    }

    /**
     * Real API path: server trả MatchedLinePays → WinPresenter emit WIN_SHOW_ALL_LINES.
     * Logic giống _onShowAllWays, dùng chung _tryShowWinAmount().
     */
    private _onShowAllLines(lines: MatchedLinePay[], _duration: number): void {
        // Log.d(`[WinAmountCenterEffect] _onShowAllLines fired — _shownThisSpin=${this._shownThisSpin}, linesLen=${lines?.length ?? 0}`);
        if (!lines || lines.length === 0) return;
        this._tryShowWinAmount('LINES', lines.length);
    }

    private _tryShowWinAmount(source: 'WAYS' | 'LINES', winCount: number): void {
        if (this._shownThisSpin) {
            Log.e(`[MULTI-LINE-WIN] WinAmountCenter SKIP — already shown this spin source=${source} count=${winCount}`);
            return;
        }
        if (!this.effectNode || !this.amountLabel) {
            Log.e(`[MULTI-LINE-WIN] WinAmountCenter SKIP — missing nodes source=${source}`);
            return;
        }

        const resp = GameData.instance.lastSpinResponse;
        const totalWin = resp?.totalWin ?? 0;
        const sumLinePayout = (resp?.matchedLinePays ?? []).reduce((s, l) => s + (l.payout ?? 0), 0);
        const sumWayPayout = (resp?.waysPayWins ?? []).reduce((s, w) => s + (w.payout ?? 0), 0);
        Log.e(
            `[MULTI-LINE-WIN] WinAmountCenter SHOW source=${source} winCount=${winCount}` +
            ` displayAmount=${totalWin} totalBet=${resp?.totalBet ?? 0}` +
            ` sumLinePayout=${sumLinePayout} sumWayPayout=${sumWayPayout}` +
            ` lines=${resp?.matchedLinePays?.length ?? 0} ways=${resp?.waysPayWins?.length ?? 0}`
        );
        if (totalWin <= 0) return;

        this._shownThisSpin = true;
        this.amountLabel.setData(totalWin, -1, 3);
        this._playEffect();
    }

    // ── ANIMATION ──────────────────────────────────────────────────────────────

    private _playEffect(): void {
        const node = this.effectNode!;
        Tween.stopAllByTarget(node);
        node.setScale(0, 0, 1);
        node.active = true;

        tween(node)
            // Zoom in: 0 → 1 với backOut
            .to(this.zoomInDuration, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
            // Giữ holdDuration giây
            .delay(this.holdDuration)
            // Zoom out: 1 → 0 với backIn
            .to(this.zoomOutDuration, { scale: new Vec3(0, 0, 1) }, { easing: 'backIn' })
            .call(() => {
                if (this.effectNode) this.effectNode.active = false;
            })
            .start();
    }
}
