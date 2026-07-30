/**
 * FeatureEntryController — Orchestrator chuỗi hiệu ứng Force Feature Entry.
 *
 * ★ FEATURE ENTRY LOGIC ADDED (Concept & System Design v260610, trang 19)
 *
 * Nối các hiệu ứng thành đúng thứ tự doc yêu cầu:
 *   Feature entry guide (nữ thần) → Sticky additional placement (đổ Sticky)
 *   → [GameManager tiếp quản] EACH WIN accumulation (credit fly) → Feature Selection popup.
 *
 * Component KHÔNG có visual — chỉ điều phối event, nên có thể gắn vào BẤT KỲ node
 * bền vững nào trong scene (ví dụ cùng node với GameManager hoặc node "Managers").
 *
 * FLOW:
 *   GameManager  ── FORCE_FEATURE_ENTRY_START(data) ─▶ this
 *   this         ── FEATURE_ENTRY_GUIDE_SHOW ─▶ FeatureEntryGuideLoader → Effect
 *   guide        ── FEATURE_ENTRY_GUIDE_DONE ─▶ this
 *   this         ── STICKY_FILL_START(data) ─▶ StickyFillEffect
 *   fill         ── STICKY_FILL_DONE ─▶ this
 *   this         ── FORCE_FEATURE_ENTRY_DONE ─▶ GameManager (tiếp tục credit-fly + popup)
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Gắn component này vào 1 node bền vững (khuyến nghị: node chứa GameManager).
 *   2. Không cần kéo tham chiếu nào — hoạt động hoàn toàn qua EventBus.
 *   3. (Optional) Bật `skipGuide` / `skipFill` nếu chưa có art tương ứng.
 *   4. `safetyTimeout` bảo đảm luôn emit DONE kể cả khi effect không phản hồi.
 */

import { _decorator, Component } from 'cc';
import { EventBus }               from '../core/EventBus';
import { GameEvents }             from '../core/GameEvents';
import { Log }                    from '../core/Logger';
import { ForceFeatureEntryData }  from '../data/SlotTypes';

const { ccclass, property } = _decorator;

@ccclass('FeatureEntryController')
export class FeatureEntryController extends Component {

    @property({ tooltip: 'Bỏ qua hiệu ứng nữ thần (khi chưa có art).' })
    skipGuide: boolean = false;

    @property({ tooltip: 'Bỏ qua hiệu ứng đổ Sticky (khi chưa có art).' })
    skipFill: boolean = false;

    @property({ tooltip: 'Timeout an toàn (giây): nếu quá lâu không xong → tự emit DONE.' })
    safetyTimeout: number = 8;

    private _running: boolean = false;
    private _data: ForceFeatureEntryData | null = null;
    /** Khi true, FORCE_FEATURE_ENTRY_DONE bắt buộc phải chờ STICKY_FILL_DONE. */
    private _waitingForFill: boolean = false;

    onLoad(): void {
        EventBus.instance.on(GameEvents.FORCE_FEATURE_ENTRY_START, this._onStart, this);
        EventBus.instance.on(GameEvents.FEATURE_ENTRY_GUIDE_DONE,  this._onGuideDone, this);
        EventBus.instance.on(GameEvents.STICKY_FILL_DONE,          this._onFillDone,  this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        this.unscheduleAllCallbacks();
    }

    private _onStart(data: ForceFeatureEntryData): void {
        if (this._running) return;
        this._running = true;
        this._data = data ?? { existingCells: [], fillCells: [], naturalCount: 0 };
        Log.d(`[FeatureEntryController] START — natural=${this._data.naturalCount} fill=${this._data.fillCells.length}`);

        // Guide + sticky fill: không còn highlight line win (WinPresenter có thể vẫn đang cycle).
        EventBus.instance.emit(GameEvents.WIN_HIGHLIGHT_CLEAR);

        // Safety net: luôn kết thúc dù effect không phản hồi
        this.scheduleOnce(this._safetyFinish, this.safetyTimeout);

        if (this.skipGuide) {
            this._startFill();
        } else {
            EventBus.instance.emit(GameEvents.FEATURE_ENTRY_GUIDE_SHOW);
        }
    }

    private _onGuideDone(): void {
        if (!this._running) return;
        this._startFill();
    }

    private _startFill(): void {
        if (this.skipFill) {
            this._onFillDone();
            return;
        }
        this._waitingForFill = true;
        EventBus.instance.emit(GameEvents.STICKY_FILL_START, this._data);
    }

    private _onFillDone(): void {
        if (!this._running) return;
        this._waitingForFill = false;
        this._finish();
    }

    private _safetyFinish = (): void => {
        if (!this._running) return;
        if (this._waitingForFill) {
            // Không được bypass StickyFillEffect: credit fly chỉ chạy sau STICKY_FILL_DONE.
            Log.w('[FeatureEntryController] safety timeout while sticky fill is running — continue waiting');
            this.scheduleOnce(this._safetyFinish, this.safetyTimeout);
            return;
        }
        Log.w('[FeatureEntryController] safety timeout → force DONE');
        this._finish();
    };

    private _finish(): void {
        this._running = false;
        this._data = null;
        this._waitingForFill = false;
        this.unschedule(this._safetyFinish);
        Log.d('[FeatureEntryController] DONE — emit FORCE_FEATURE_ENTRY_DONE');
        EventBus.instance.emit(GameEvents.FORCE_FEATURE_ENTRY_DONE);
    }
}
