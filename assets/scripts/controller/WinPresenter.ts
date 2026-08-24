/**
 * WinPresenter - Trình diễn kết quả thắng.
 *
 * FLOW MỚI:
 *   1. Khi reel dừng (WIN_PRESENT_START):
 *      - Hiện TẤT CẢ winning lines cùng 1 lúc (WIN_SHOW_ALL_LINES / WAYS)
 *      - Show BigWin popup nếu cần
 *   2. Sau 1 giây: emit WIN_PRESENT_END → GameManager bật nút Spin
 *   3. Đồng thời bắt đầu vòng lặp cycling: line1 → (1s) → line2 → ... → loop
 *      (bỏ qua cycling trong FreeSpin / AutoSpin — chỉ highlight multiple 1 lần)
 *      Quick-stop: show-all ngắn + mở Spin, rồi vẫn cycle line/way lẻ đến spin mới
 *   4. Khi REELS_START_SPIN: hủy cycling, reset hoàn toàn
 */

import { _decorator, Component, Label } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { SpinResponse, SlotStageType, WinTier, WaysPayWin } from '../data/SlotTypes';
import { AutoSpinManager, SpeedMode } from '../manager/AutoSpinManager';
import { L } from '../core/LocalizationManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('WinPresenter')
export class WinPresenter extends Component {

    @property({ tooltip: 'Label hiển thị tiền thắng (không bắt buộc)' })
    winLabel: Label | null = null;

    @property({ tooltip: 'Delay trước khi bật Spin sau khi Normal spin kết thúc (giây)' })
    spinEnableDelayNormal: number = 1.0;

    @property({ tooltip: 'Delay trước khi bật Spin sau khi AutoSpin kết thúc (giây)' })
    spinEnableDelayAuto: number = 1.2;

    @property({ tooltip: 'Delay trước khi bật Spin sau khi Free Spin kết thúc (giây)' })
    spinEnableDelayFreeSpin: number = 0.3;

    @property({ tooltip: 'Thời gian hiển thị "show all" highlight trước khi chuyển sang cycling từng line (giây).' })
    showAllHighlightDuration: number = 1.5;

    @property({ tooltip: 'AutoSpin win delay — Normal mode (giây)' })
    autoSpinFixedWinDelayNormal: number = 1.5;

    @property({ tooltip: 'AutoSpin win delay — Quick mode (giây)' })
    autoSpinFixedWinDelayQuick: number = 1.0;

    @property({ tooltip: 'AutoSpin win delay — Turbo mode (giây)' })
    autoSpinFixedWinDelayTurbo: number = 0.8;

    @property({ tooltip: 'Thời gian mỗi line trong vòng lặp cycling (giây)' })
    lineCycleDuration: number = 2.0;

    @property({ tooltip: 'Thời gian hiện win một lần khi Dừng nhanh (giây)' })
    quickStopWinDuration: number = 0.5;

    /** Tăng mỗi round mới — callback từ round cũ bỏ qua nếu lỗi thời */
    private _generation: number = 0;
    private _isPresenting: boolean = false;
    /** Spin hiện tại đã kích hoạt Dừng nhanh — win hiện 1 lần rồi mở Spin ngay */
    private _isQuickStopSpin: boolean = false;
    /** Reference đến cycling callback đang chạy (dùng để unschedule chính xác) */
    private _cycleCallback: (() => void) | null = null;
    /** Đang trong chế độ free spin — bỏ qua các ghi winLabel khi đúng */
    private _isFreeSpinMode: boolean = false;
    /** Đang trong chế độ auto spin */
    private _isAutoSpinMode: boolean = false;
    /** PickGame đang active: không replay jackpot/line cycle của normal spin cũ. */
    private _isPickGameMode: boolean = false;
    /** Tất cả spine highlight đã hoàn tất animation (do SymbolHighlighter báo) */
    private _highlightAnimDone: boolean = false;
    /** Gen đang chờ WIN_HIGHLIGHT_ANIM_DONE để emit WIN_PRESENT_END; -1 = không chờ */
    private _pendingPresentEndGen: number = -1;
    /** Danh sách line thắng của vòng quay gần nhất (dùng để cycle sau jackpot popup) */
    private _lastMatchedLines: SpinResponse['matchedLinePays'] = [];
    /** Danh sách WaysPayWin của vòng quay gần nhất (Ways Pay) */
    private _lastWaysPayWins: WaysPayWin[] = [];
    /** Wild trail đang diễn animation → delay highlight */
    // ─── LIFECYCLE ───

    onLoad(): void {
        EventBus.instance.on(GameEvents.WIN_PRESENT_START, this._onWinStart, this);
        EventBus.instance.on(GameEvents.REELS_START_SPIN,  this._onReelsStartSpin, this);
        EventBus.instance.on(GameEvents.REELS_QUICK_STOP, this._onQuickStop, this);
        EventBus.instance.on(GameEvents.WIN_HIGHLIGHT_ANIM_DONE, this._onHighlightAnimDone, this);
        EventBus.instance.on(GameEvents.WIN_HIGHLIGHT_CLEAR, this._onWinHighlightClear, this);
        EventBus.instance.on(GameEvents.JACKPOT_END, this._onJackpotEndForCycle, this);
        EventBus.instance.on(GameEvents.AUTO_SPIN_CHANGED, this._onAutoSpinChanged, this);
        EventBus.instance.on(GameEvents.PICK_GAME_OPEN, this._onPickGameOpen, this);
        EventBus.instance.on(GameEvents.PICK_GAME_CLOSE, this._onPickGameClose, this);
        EventBus.instance.on(GameEvents.CARNIVAL_MATSURI_START, this._onWinHighlightClear, this);
        EventBus.instance.on(GameEvents.FREE_SPIN_COUNT_UPDATED, (remaining: number) => {
            this._isFreeSpinMode = remaining > 0;
        }, this);
        EventBus.instance.on(GameEvents.FREE_SPIN_END, () => {
            this._isFreeSpinMode = false;
            // ★ CRITICAL: invalidate mọi scheduled callback còn sót từ lần quay free spin cuối
            // — tránh highlight/spine effect hiện lại sau khi về normal mode.
            this._generation++;
            // Log.d(`[WinHL] gen++ FREE_SPIN_END → ${this._generation} (kills cycle)`);
            this._stopCycling();
            this.unscheduleAllCallbacks();
            this._isPresenting = false;
            this._highlightAnimDone = false;
            this._pendingPresentEndGen = -1;
            this._lastMatchedLines = [];
            this._lastWaysPayWins = [];
        }, this);
        EventBus.instance.on(GameEvents.TOPUP_END, () => {
            // Tương tự FREE_SPIN_END — invalidate callback còn sót từ TopUp mode
            this._generation++;
            // Log.d(`[WinHL] gen++ TOPUP_END → ${this._generation} (kills cycle)`);
            this._stopCycling();
            this.unscheduleAllCallbacks();
            this._isPresenting = false;
            this._highlightAnimDone = false;
            this._pendingPresentEndGen = -1;
            this._lastMatchedLines = [];
            this._lastWaysPayWins = [];
        }, this);
    }

    onDestroy(): void {
        this.unscheduleAllCallbacks();
        EventBus.instance.offTarget(this);
    }

    // ─── RESET KHI SPIN MỚI BẮT ĐẦU ───

    private _onReelsStartSpin(): void {
        this._generation++;
        // Log.d(`[WinHL] gen++ REELS_START_SPIN → ${this._generation} (kills cycle)`);
        this._stopCycling();
        this.unscheduleAllCallbacks();
        this._isPresenting = false;
        this._isQuickStopSpin = false;
        this._highlightAnimDone = false;
        this._pendingPresentEndGen = -1;
        // Reset để vòng quay mới không dùng lines của vòng quay trước (đặc biệt quan trọng
        // khi jackpot path không emit WIN_PRESENT_START → _lastMatchedLines không được cập nhật).
        this._lastMatchedLines = [];
        // Trong free spin: UIController quản lý winLabel — không ghi đè ở đây
        if (!this._isFreeSpinMode && this.winLabel) {
            this.winLabel.string = L('good_luck');
        }
    }

    private _onQuickStop(): void {
        // Chỉ áp dụng presentation rút gọn cho Normal Spin (không FreeSpin/TopUp/AutoSpin feature)
        if (this._isFreeSpinMode || this._isPickGameMode) return;
        this._isQuickStopSpin = true;
    }

    // ─── XỬ LÝ KẾT QUẢ ─────────────────────────────────────────────

    private _onWinStart(response: SpinResponse): void {
        this._generation++;
        const myGen = this._generation;
        this._stopCycling();
        this.unscheduleAllCallbacks();
        this._isPresenting = false;
        this._highlightAnimDone = false;
        this._pendingPresentEndGen = -1;
        // Lưu lại lines để dùng sau jackpot popup
        this._lastMatchedLines  = response.matchedLinePays;
        this._lastWaysPayWins   = response.waysPayWins ?? [];
        const waysLen = response.waysPayWins?.length ?? 0;
        const linesLen = response.matchedLinePays?.length ?? 0;
        this._logMultiLineWin(
            `WIN_PRESENT_START gen=${myGen} totalWin=${response.totalWin} totalBet=${response.totalBet}` +
            ` ways=${waysLen} lines=${linesLen} linePayouts=[${this._fmtLinePayouts(response.matchedLinePays)}]` +
            ` mode=${GameData.instance.currentMode} auto=${this._isAutoSpinMode} fs=${this._isFreeSpinMode}`
        );
        // Không có tiền thắng → kết thúc ngay để GameManager mở Spin
        if (response.totalWin <= 0) {
            if (!this._isFreeSpinMode && this.winLabel) this.winLabel.string = L('no_win');
            // Log.e(`[SPIN-HANG][WinHL] WIN_PRESENT_START no-win → finish | gen=${myGen}`);
            this._isQuickStopSpin = false;
            this._finishPresentation(myGen);
            return;
        }

        // GameManager đã defer WIN_PRESENT_START đến sau CARNIVAL_TRAIL_FLY_DONE (nếu có).
        void waysLen;
        void linesLen;
        this._emitHighlights(response, myGen);
    }

    /**
     * Emit highlight events, win popup, và setup cycling timers.
     */
    private _emitHighlights(response: SpinResponse, myGen: number): void {
        this._isPresenting = true;

        // Cập nhật win label ngay khi có kết quả (chỉ ngoài free spin)
        if (!this._isFreeSpinMode && this.winLabel) {
            this.winLabel.string = L('win_amount', { amount: response.totalWin.toFixed(3) });
        }

        // 1) Hiện TẤT CẢ winning cells cùng 1 lúc
        const ways = response.waysPayWins ?? [];
        const hasWin = (response.matchedLinePays.length > 0) || (ways.length > 0);
        const isAutoSpinWithWin = this._isAutoSpinMode && hasWin;
        const isQuickStopWin = this._isQuickStopSpin && hasWin && !this._isFreeSpinMode && !this._isPickGameMode;
        // highlightShowDuration: show-all + delay trước cycle — luôn theo Editor (showAllHighlightDuration).
        // presentEndDelay: khi mở nút Spin — quick-stop có thể rút ngắn.
        let highlightShowDuration = this.showAllHighlightDuration;
        let presentEndDelay = this.showAllHighlightDuration;
        if (isQuickStopWin) {
            presentEndDelay = this.quickStopWinDuration;
        } else if (isAutoSpinWithWin) {
            const mode = AutoSpinManager.instance.speedMode;
            presentEndDelay = this.autoSpinFixedWinDelayNormal;
            highlightShowDuration = presentEndDelay;
            if (mode === SpeedMode.QUICK) {
                presentEndDelay = this.autoSpinFixedWinDelayQuick;
                highlightShowDuration = presentEndDelay;
            } else if (mode === SpeedMode.TURBO) {
                presentEndDelay = this.autoSpinFixedWinDelayTurbo;
                highlightShowDuration = presentEndDelay;
            }
        }
        if (ways.length > 0) {
            // ★ Gold of Fortune: Ways Pay — emit WIN_SHOW_ALL_WAYS
            this._logMultiLineWin(
                `EMIT WIN_SHOW_ALL_WAYS ways=${ways.length} highlight=${highlightShowDuration}s` +
                ` presentEnd=${presentEndDelay}s gen=${myGen}` +
                ` wayPayouts=[${ways.map(w => `${w.symbolId}:${w.payout}(ways=${w.ways})`).join('|')}]`
            );
            EventBus.instance.emit(GameEvents.WIN_SHOW_ALL_WAYS, ways, highlightShowDuration);
        } else if (response.matchedLinePays.length > 0) {
            // Legacy payline game fallback
            this._logMultiLineWin(
                `EMIT WIN_SHOW_ALL_LINES lines=${response.matchedLinePays.length}` +
                ` highlight=${highlightShowDuration}s presentEnd=${presentEndDelay}s gen=${myGen}` +
                ` payouts=[${this._fmtLinePayouts(response.matchedLinePays)}]`
            );
            EventBus.instance.emit(GameEvents.WIN_SHOW_ALL_LINES, response.matchedLinePays, highlightShowDuration);
        } else {
            // Log.d(`[WinHL] SHOW_ALL skip — no ways/lines gen=${myGen}`);
        }

        // 2) Show Big/Mega/Super Win popup nếu cần
        // Quick-stop thắng thường: không rút ngắn Feature/Jackpot/Progressive — BigWin vẫn hiện nếu đủ tier
        const winTier = GameData.instance.getWinTier(response.totalWin);
        if (winTier >= WinTier.BIG_WIN) {
            EventBus.instance.emit(GameEvents.WIN_POPUP, winTier, response.totalWin);
        }

        // 3) Free Spin multiplier thông báo
        if (response.featureMultiple && response.featureMultiple > 1) {
            EventBus.instance.emit(GameEvents.FREE_SPIN_MULTIPLIER, response.featureMultiple);
        }

        const willAutoSpin = response.nextStage === SlotStageType.FREE_SPIN
            || response.nextStage === SlotStageType.FREE_SPIN_START
            || response.nextStage === SlotStageType.FREE_SPIN_RE_TRIGGER
            || response.nextStage === SlotStageType.BUY_FREE_SPIN
            || response.nextStage === SlotStageType.BUY_FREE_SPIN_START;
        const inFreeSpin = this._isInFreeSpinMode();

        // Dừng nhanh: mở Spin sớm — highlight show-all + cycle vẫn theo showAllHighlightDuration (Editor).
        if (isQuickStopWin) {
            this._logMultiLineWin(
                `quickStop — presentEnd=${presentEndDelay}s highlight=${highlightShowDuration}s` +
                ` cycleAfter=${highlightShowDuration}s gen=${myGen}`
            );
            this.scheduleOnce(() => {
                if (this._generation !== myGen) return;
                this._isPresenting = false;
                this._isQuickStopSpin = false;
                EventBus.instance.emit(GameEvents.WIN_COUNTUP_DONE, response.totalWin);
                EventBus.instance.emit(GameEvents.WIN_PRESENT_END);
            }, presentEndDelay);
        } else if (isAutoSpinWithWin) {

            // AutoSpin + có win: delay cố định tùy theo speed mode
            this.scheduleOnce(() => {
                if (this._generation !== myGen) {
                    // Log.e(`[SPIN-HANG][WinHL] WIN_PRESENT_END skipped — gen stale | gen=${myGen} cur=${this._generation}`);
                    return;
                }
                this._isPresenting = false;
                // Log.d(`[WinHL] EMIT WIN_PRESENT_END (autoWin) gen=${myGen}`);
                EventBus.instance.emit(GameEvents.WIN_COUNTUP_DONE, response.totalWin);
                EventBus.instance.emit(GameEvents.WIN_PRESENT_END);
            }, presentEndDelay);
        } else {
            // Các trường hợp khác: dùng logic cũ (spinEnableDelay / showAllHighlightDuration)
            presentEndDelay = Math.max(this._getSpinEnableDelay(), this.showAllHighlightDuration);
            // Log.e(`[SPIN-HANG][WinHL] schedule WIN_PRESENT_END in ${presentEndDelay}s | gen=${myGen}`);
            this.scheduleOnce(() => {
                if (this._generation !== myGen) {
                    // Log.e(`[SPIN-HANG][WinHL] WIN_PRESENT_END skipped — gen stale | gen=${myGen} cur=${this._generation}`);
                    return;
                }

                this._isPresenting = false;
                // Log.d(`[WinHL] EMIT WIN_PRESENT_END gen=${myGen}`);
                EventBus.instance.emit(GameEvents.WIN_COUNTUP_DONE, response.totalWin);
                EventBus.instance.emit(GameEvents.WIN_PRESENT_END);
            }, presentEndDelay);
        }

        // 5) Sau showAllHighlightDuration: bắt đầu cycling từng way/line
        // Không cycling khi:
        //   - auto-spin / free-spin (next spin ngay sau WIN_PRESENT_END)
        //   - FreeSpin mode: chỉ highlight multiple 1 lần, không cycle line lẻ
        //     (kể cả lượt FS cuối remaining=0 — dùng currentMode, không chỉ flag remaining)
        //
        // BUG FIX: 1 WaysPayWin (vd. chỉ symbol J) vẫn có thể có nhiều combinations.
        // Trước đây điều kiện `ways.length > 1` khiến case này fallback sang line-cycle
        // (UI_UPDATE_WIN_LABEL) → WaysPayDisplay không nhận WIN_CYCLE_ONE_WAY →
        // 5 spine overlay show-all bị kẹt trên màn hình.
        const shouldCycle = !willAutoSpin && !this._isAutoSpinMode && !inFreeSpin;
        const waysForCycle = response.waysPayWins ?? [];
        const waysComboCount = this._countWaysCombos(waysForCycle);
        const linesForCycle = response.matchedLinePays ?? [];
        let cyclePlan = 'SKIP';
        let skipReason = '';
        if (!shouldCycle) {
            skipReason = willAutoSpin ? 'willAutoSpin/nextFS' : this._isAutoSpinMode ? 'autoSpin' : 'freeSpin';
        } else if (waysComboCount > 1) {
            cyclePlan = `WAYS after ${highlightShowDuration}s`;
        } else if (waysForCycle.length === 0 && linesForCycle.length > 1) {
            cyclePlan = `LINES after ${highlightShowDuration}s`;
        } else if (waysForCycle.length > 0 && waysComboCount <= 1 && linesForCycle.length > 1) {
            skipReason = `waysPresent(${waysForCycle.length}) combo<=1 blocks lineCycle(lines=${linesForCycle.length})`;
        } else {
            skipReason = `need>=2 combos/lines; combos=${waysComboCount} lines=${linesForCycle.length}`;
        }
        this._logMultiLineWin(
            `CYCLE-DECISION gen=${myGen} totalWin=${response.totalWin} totalBet=${response.totalBet}` +
            ` ways=${waysForCycle.length} combos=${waysComboCount} lines=${linesForCycle.length}` +
            ` shouldCycle=${shouldCycle} plan=${cyclePlan} skip=${skipReason || 'none'}` +
            ` highlightPath=${waysForCycle.length > 0 ? 'WAYS' : 'LINES'}` +
            ` loopOverallOnly=${waysForCycle.length <= 1 && linesForCycle.length <= 1 ? 'maybe' : waysForCycle.length === 1 || (waysForCycle.length === 0 && linesForCycle.length === 1) ? 'YES' : 'NO'}` +
            ` | linesDump: ${this._fmtLines(linesForCycle)} | waysDump: ${this._fmtWays(waysForCycle)}`
        );
        if (shouldCycle && waysComboCount > 1) {
            // Log.d(`[WinHL] schedule WAYS cycle in ${highlightShowDuration}s | gen=${myGen}`);
            this.scheduleOnce(() => {
                if (this._generation !== myGen) {
                    // Log.d(`[WinHL] WAYS cycle-timer SKIP stale | gen=${myGen} cur=${this._generation}`);
                    return;
                }
                // Log.d(`[WinHL] WAYS cycle-timer fired → start | gen=${myGen}`);
                this._startWaysCycle(waysForCycle, myGen);
            }, highlightShowDuration);
        } else if (shouldCycle && waysForCycle.length === 0 && linesForCycle.length > 1) {
            // Legacy payline only — không dùng khi đã có Ways Pay (tránh lệch overlay)
            // Log.d(`[WinHL] schedule LINE cycle in ${highlightShowDuration}s | gen=${myGen}`);
            this.scheduleOnce(() => {
                if (this._generation !== myGen) {
                    // Log.d(`[WinHL] LINE cycle-timer SKIP stale | gen=${myGen} cur=${this._generation}`);
                    return;
                }
                // Log.d(`[WinHL] LINE cycle-timer fired → start | gen=${myGen}`);
                this._startLineCycle(linesForCycle, myGen);
            }, highlightShowDuration);
        } else {
            // Log.d(`[WinHL] NO cycle scheduled | plan=${cyclePlan} skip=${skipReason || 'none'} gen=${myGen}`);
        }
    }

    /** Tổng số combination paths từ mọi WaysPayWin (1 way × N combos vẫn > 1). */
    private _countWaysCombos(ways: WaysPayWin[]): number {
        let n = 0;
        for (const w of ways) {
            if (w.combinations && w.combinations.length > 0) {
                n += w.combinations.length;
            } else if (w.cells && w.cells.length > 0) {
                n += 1;
            }
        }
        return n;
    }

    private _fmtWays(ways: WaysPayWin[]): string {
        if (!ways || ways.length === 0) return '(none)';
        return ways.map((w, i) =>
            `w${i}:sym=${w.symbolId} ways=${w.ways} payout=${w.payout} combos=${w.combinations?.length ?? 0} cells=${w.cells?.length ?? 0}`
        ).join(' | ');
    }

    private _fmtLines(lines: SpinResponse['matchedLinePays']): string {
        if (!lines || lines.length === 0) return '(none)';
        return lines.map((l, i) =>
            `L${i}:pl=#${l.payLineIndex} payout=${l.payout} cnt=${l.matchedSymbolsCount ?? l.reelCnt}`
        ).join(' | ');
    }

    private _fmtLinePayouts(lines: SpinResponse['matchedLinePays']): string {
        if (!lines || lines.length === 0) return '';
        return lines.map(l => `pl${l.payLineIndex}=${l.payout}`).join(',');
    }

    private _logMultiLineWin(msg: string): void {
        Log.e(`[MULTI-LINE-WIN] ${msg}`);
    }

    private _fmtComboCells(way: WaysPayWin): string {
        const cells = way?.cells ?? [];
        return `sym=${way?.symbolId} cells=[${cells.map(c => `r${c.reel}y${c.row}`).join(',')}]`;
    }

    // ─── CYCLING LOOP (lặp lại vô hạn đến khi spin mới) ─────────────

    /**
     * Cycling từng combination của WaysPayWin — emit WIN_CYCLE_ONE_WAY mỗi `lineCycleDuration` giây.
     * Mỗi combination là 1 path cụ thể (1 row per reel), giống payline cycling.
     * Dùng cho Gold of Fortune (Ways Pay 243).
     * Chỉ cycle khi có ≥ 2 combo — 1 combo giữ nguyên highlight show-all.
     */
    private _startWaysCycle(ways: WaysPayWin[], gen: number): void {
        this._stopCycling();

        // Flatten tất cả combinations của mọi WaysPayWin → list các WaysPayWin giả (cells = combo)
        const allCombos: WaysPayWin[] = [];
        for (const way of ways) {
            const combos = way.combinations && way.combinations.length > 0
                ? way.combinations
                : [way.cells]; // fallback nếu combinations chưa được tính
            for (const combo of combos) {
                allCombos.push({ ...way, cells: combo });
            }
        }
        if (allCombos.length < 2) {
            // Log.d(`[WinHL] START_WAYS_CYCLE abort — flattenedCombos=${allCombos.length} gen=${gen}`);
            return;
        }

        let idx = 0;
        // Log.d(`[WinHL] START_WAYS_CYCLE combos=${allCombos.length} interval=${this.lineCycleDuration}s gen=${gen}`);

        // Emit combination đầu tiên ngay lập tức
        this._logMultiLineWin(
            `START_WAYS_CYCLE combos=${allCombos.length} interval=${this.lineCycleDuration}s gen=${gen}` +
            ` first=${this._fmtComboCells(allCombos[idx])} payout=${allCombos[idx].payout}`
        );
        EventBus.instance.emit(GameEvents.WIN_CYCLE_ONE_WAY, allCombos[idx]);
        idx = (idx + 1) % allCombos.length;

        this._cycleCallback = () => {
            if (this._generation !== gen) {
                // Log.d(`[WinHL] WAYS cycle tick SKIP stale | gen=${gen} cur=${this._generation}`);
                this._stopCycling();
                return;
            }
            // Log.d(`[WinHL] EMIT WIN_CYCLE_ONE_WAY idx=${idx}/${allCombos.length} ${this._fmtComboCells(allCombos[idx])} gen=${gen}`);
            EventBus.instance.emit(GameEvents.WIN_CYCLE_ONE_WAY, allCombos[idx]);
            idx = (idx + 1) % allCombos.length;
        };
        this.schedule(this._cycleCallback, this.lineCycleDuration);
    }

    private _startLineCycle(lines: SpinResponse['matchedLinePays'], gen: number): void {
        this._stopCycling();
        if (lines.length < 2) {
            // Log.d(`[WinHL] START_LINE_CYCLE abort — lines=${lines.length} gen=${gen}`);
            return;
        }

        let lineIdx = 0;
        // Log.d(`[WinHL] START_LINE_CYCLE lines=${lines.length} interval=${this.lineCycleDuration}s gen=${gen}`);

        // Emit line đầu tiên ngay lập tức
        this._logMultiLineWin(
            `START_LINE_CYCLE lines=${lines.length} interval=${this.lineCycleDuration}s gen=${gen}` +
            ` first=pl#${lines[lineIdx].payLineIndex} payout=${lines[lineIdx].payout}`
        );
        EventBus.instance.emit(GameEvents.UI_UPDATE_WIN_LABEL, lines[lineIdx]);
        lineIdx = (lineIdx + 1) % lines.length;

        // Dùng schedule (repeating interval) thay vì đệ qui scheduleOnce
        // để tránh vấn đề dedup của scheduler Cocos Creator
        this._cycleCallback = () => {
            if (this._generation !== gen) {
                // Log.d(`[WinHL] LINE cycle tick SKIP stale | gen=${gen} cur=${this._generation}`);
                this._stopCycling();
                return;
            }
            const line = lines[lineIdx];
            this._logMultiLineWin(
                `EMIT UI_UPDATE_WIN_LABEL idx=${lineIdx}/${lines.length} pl=#${line.payLineIndex}` +
                ` payout=${line.payout} gen=${gen}`
            );
            EventBus.instance.emit(GameEvents.UI_UPDATE_WIN_LABEL, line);
            lineIdx = (lineIdx + 1) % lines.length;
        };
        this.schedule(this._cycleCallback, this.lineCycleDuration);
    }

    private _stopCycling(): void {
        if (this._cycleCallback) {
            // Log.d(`[WinHL] STOP_CYCLING gen=${this._generation}`);
            this.unschedule(this._cycleCallback);
            this._cycleCallback = null;
        }
    }

    /**
     * Sau jackpot popup đóng (Normal spin): WIN_PRESENT_START không được emit trong jackpot path,
     * nên cycling chưa bao giờ chạy. Khởi động lại cycling tại đây nếu có line thắng.
     * Jackpot được coi như 1 line thường — thêm vào đầu danh sách để cycle đầu tiên.
     * Flow giống normal win: show all lines → sau showAllHighlightDuration → cycle từng line.
     * Bỏ qua trong free spin (free spin tự auto-spin tiếp).
     */
    private _onJackpotEndForCycle(): void {
        if (this._isPickGameJackpotFlow()) return;
        if (this._isInFreeSpinMode()) return;

        const resp = GameData.instance.lastSpinResponse;
        // Luôn lấy từ resp của vòng quay HIỆN TẠI — KHÔNG dùng _lastMatchedLines vì jackpot
        // path không emit WIN_PRESENT_START, nên _lastMatchedLines có thể chứa data của spin trước.
        let allLines = [...(resp?.matchedLinePays ?? [])];

        // Nếu jackpot payline chưa có trong matchedLinePays (jackpot-only, server không gửi
        // line entry riêng), thêm synthetic entry để cycle hiển thị đúng.
        const jackpotPaylineIdx = GameData.instance.jackpotPaylineIndex;
        if (jackpotPaylineIdx >= 0 && !allLines.some(l => l.payLineIndex === jackpotPaylineIdx)) {
            allLines.unshift({
                payLineIndex: jackpotPaylineIdx,
                payout: 0,
                matchedSymbols: [],
                containsWild: false,
                reelCnt: 3,
                matchedSymbolsIndices: null,
            } as any);
        }

        if (allLines.length < 1) return;

        this._generation++;
        const myGen = this._generation;
        this._stopCycling();
        this.unscheduleAllCallbacks();

        // 1. Hiện TẤT CẢ winning lines cùng 1 lúc (giống normal win flow)
        // Log.d(`[WinHL] JACKPOT_END SHOW_ALL_LINES lines=${allLines.length} gen=${myGen}`);
        EventBus.instance.emit(GameEvents.WIN_SHOW_ALL_LINES, allLines, this.showAllHighlightDuration);

        // 2. Sau showAllHighlightDuration: bắt đầu cycling từng line lẻ
        this.scheduleOnce(() => {
            if (this._generation !== myGen) return;
            this._startLineCycle(allLines, myGen);
        }, this.showAllHighlightDuration);
    }

    // ─── FINISH ───

    /** Callback khi SymbolHighlighter báo tất cả spine animation đã hoàn tất */
    private _onHighlightAnimDone(): void {
        this._highlightAnimDone = true;
        if (this._pendingPresentEndGen >= 0 && this._pendingPresentEndGen === this._generation) {
            this._pendingPresentEndGen = -1;
            this._isPresenting = false;
            const resp = GameData.instance.lastSpinResponse;
            if (resp) EventBus.instance.emit(GameEvents.WIN_COUNTUP_DONE, resp.totalWin);
            EventBus.instance.emit(GameEvents.WIN_PRESENT_END);
        }
    }

    private _finishPresentation(gen: number): void {
        if (this._generation !== gen) {
            // Log.e(`[SPIN-HANG][WinHL] _finishPresentation skipped — gen stale | gen=${gen} cur=${this._generation}`);
            return;
        }
        this._stopCycling();
        this.unscheduleAllCallbacks();
        this._isPresenting = false;
        // Log.e(`[SPIN-HANG][WinHL] EMIT WIN_PRESENT_END (_finishPresentation) | gen=${gen}`);
        EventBus.instance.emit(GameEvents.WIN_PRESENT_END);
    }

    // ─── HELPERS ───

    /** Cập nhật trạng thái auto spin từ AutoSpinManager */
    private _onAutoSpinChanged(count: number): void {
        // FIX: dùng isAutoSpinActive thay vì count > 0 — count > 0 không có nghĩa auto đang chạy
        // (có thể còn dư từ localStorage hoặc user chưa confirm trong setting popup)
        this._isAutoSpinMode = count > 0 && AutoSpinManager.instance.isAutoSpinActive;
    }

    /** Lấy delay phù hợp dựa vào mode hiện tại (Normal / Auto / Free) */
    private _getSpinEnableDelay(): number {
        if (this._isInFreeSpinMode()) {
            return this.spinEnableDelayFreeSpin;
        } else if (this._isAutoSpinMode) {
            return this.spinEnableDelayAuto;
        } else {
            return this.spinEnableDelayNormal;
        }
    }

    /** Tắt cycling trước khi feature entry / pot burst. */
    private _onWinHighlightClear(): void {
        this._generation++;
        // Log.d(`[WinHL] gen++ HIGHLIGHT_CLEAR → ${this._generation} (kills cycle)`);
        this._stopCycling();
        this.unscheduleAllCallbacks();
        this._isPresenting = false;
        this._highlightAnimDone = false;
        this._pendingPresentEndGen = -1;
    }

    private _onPickGameOpen(): void {
        this._isPickGameMode = true;
        this._pausePresentationRuntime();
    }

    private _onPickGameClose(): void {
        this._isPickGameMode = false;
        this._pausePresentationRuntime();

        const myGen = this._generation;
        this.scheduleOnce(() => {
            if (this._generation !== myGen) return;
            this._resumePickGameWinHighlight(myGen);
        }, 0);
    }

    private _pausePresentationRuntime(): void {
        this._generation++;
        // Log.d(`[WinHL] gen++ PAUSE_RUNTIME → ${this._generation} pick=${this._isPickGameMode}`);
        this._stopCycling();
        this.unscheduleAllCallbacks();
        this._isPresenting = false;
        this._highlightAnimDone = false;
        this._pendingPresentEndGen = -1;
    }

    private _resumePickGameWinHighlight(gen: number): void {
        const resp = GameData.instance.lastSpinResponse;
        if (!resp || resp.totalWin <= 0) return;

        const ways = resp.waysPayWins ?? [];
        const lines = resp.matchedLinePays ?? [];
        if (ways.length === 0 && lines.length === 0) return;

        if (ways.length > 0) {
            // Log.d(`[WinHL] resumePick SHOW_ALL_WAYS ways=${ways.length} gen=${gen}`);
            EventBus.instance.emit(GameEvents.WIN_SHOW_ALL_WAYS, ways, this.showAllHighlightDuration);
            this.scheduleOnce(() => {
                if (this._generation !== gen || this._isAutoSpinMode || this._isInFreeSpinMode()) {
                    // Log.d(`[WinHL] resumePick WAYS cycle skip | gen=${gen} cur=${this._generation} auto=${this._isAutoSpinMode}`);
                    return;
                }
                if (ways.length > 1) this._startWaysCycle(ways, gen);
                // else: single way — no cycle
            }, this.showAllHighlightDuration);
        } else {
            // Log.d(`[WinHL] resumePick SHOW_ALL_LINES lines=${lines.length} gen=${gen}`);
            EventBus.instance.emit(GameEvents.WIN_SHOW_ALL_LINES, lines, this.showAllHighlightDuration);
            this.scheduleOnce(() => {
                if (this._generation !== gen || this._isAutoSpinMode || this._isInFreeSpinMode()) {
                    // Log.d(`[WinHL] resumePick LINE cycle skip | gen=${gen} cur=${this._generation}`);
                    return;
                }
                if (lines.length > 1) this._startLineCycle(lines, gen);
            }, this.showAllHighlightDuration);
        }
    }

    /** FreeSpin đang chạy (currentMode ổn định cả lượt FS cuối remaining=0). */
    private _isInFreeSpinMode(): boolean {
        if (this._isFreeSpinMode) return true;
        return GameData.instance.currentMode === 'freespin';
    }

    private _isPickGameJackpotFlow(): boolean {
        const resp = GameData.instance.lastSpinResponse as (SpinResponse & { triggerPotWin?: boolean }) | null;
        const nextStage = resp?.nextStage as SlotStageType | undefined;
        return this._isPickGameMode
            || !!resp?.triggerPotWin
            || !!resp?.pickGame
            || nextStage === SlotStageType.PICK_START
            || nextStage === SlotStageType.PICK
            || nextStage === SlotStageType.PICK_END
            || nextStage === SlotStageType.POT_WIN
            || nextStage === SlotStageType.PICK_GAME
            || nextStage === SlotStageType.PICK_GAME_END;
    }

}
