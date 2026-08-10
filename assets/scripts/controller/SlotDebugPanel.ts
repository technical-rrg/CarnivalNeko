/**
 * SlotDebugPanel — DebugArray presets cho Carnival Neko (SlotId 20).
 *
 * DebugArray = 5 stop index (mỗi reel). Index = mid-row trên strip PS từ Enter.
 * Tính động từ `GameData.instance.rawPsStrips` — không hardcode index cố định.
 *
 * Preset chính:
 *   High×5 / High Win / Minor×5 / Multi Line / Win 1 line / No Win
 *   Wild / Trail Blue|Green|Red|Mix / Win+Trail
 *   Sticky (FS strips nếu có)
 *
 * Gửi: DebugManager.setDebugRands(arr) → emit SPIN_REQUEST.
 */

import { _decorator, Component, Node, EditBox, Label, Button } from 'cc';
import { DebugManager } from '../manager/DebugManager';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { Log } from '../core/Logger';
import { SymbolId, PS_TO_CLIENT } from '../data/SlotTypes';

const { ccclass, property } = _decorator;

const REEL_COUNT = 5;
const TOPUP_CELL_COUNT = 15;
const SEARCH_ITERS = 6000;

// ── Carnival Neko PS IDs (API V1.0.1) ───────────────────────────────────────
const PS_MINOR = [1, 2, 3, 4, 5, 6] as const;
const PS_MAJOR_HIGH = 15; // High05 — payout cao nhất
const PS_MAJOR_MID = 12;
const PS_WILD = 21;
const PS_TRAIL_BLUE = 41;
const PS_TRAIL_GREEN = 42;
const PS_TRAIL_RED = 43;
const PS_TRAILS = [PS_TRAIL_BLUE, PS_TRAIL_GREEN, PS_TRAIL_RED] as const;
const PS_STICKY_GREEN = 44;
const PS_STICKY_GOLD = 45;

const NON_PAY_CLIENT = new Set<number>([
    SymbolId.WILD,
    SymbolId.STICKY_RED, SymbolId.STICKY_YELLOW, SymbolId.STICKY_GREEN,
    SymbolId.PLUS_ONE_SPIN,
    SymbolId.JP_IDLE, SymbolId.JP_MINI, SymbolId.JP_MINOR,
    SymbolId.JP_MAJOR, SymbolId.JP_GRAND, SymbolId.JP_UPGRADE,
    SymbolId.TRAIL_NORMAL, SymbolId.TRAIL_BLUE, SymbolId.TRAIL_RED, SymbolId.TRAIL_GREEN,
]);

@ccclass('SlotDebugPanel')
export class SlotDebugPanel extends Component {

    @property(Node) debugPanelNode: Node = null!;
    @property(EditBox) inputReelIndices: EditBox = null!;
    @property(Label) statusLabel: Label = null!;
    @property(Label) memberIdxLabel: Label = null!;

    // ── NORMAL SPIN ─────────────────────────────────────────────────────────
    @property(Button) btnRandomSpin: Button = null!;
    @property(Button) btnAllZeros: Button = null!;
    /** Maximize Red Trail (PS=43) — charge Red Pot / gần Pick. */
    @property(Button) btnForcePickGame: Button = null!;
    /** Maximize Blue+Green+Red Trail trong 1 spin. */
    @property(Button) btnAllNegOnes6: Button = null!;
    /** High05 (PS=15) mid trên cả 5 reel. */
    @property(Button) btnPhoenix5: Button = null!;
    /** Search: ways win ưu tiên high symbol. */
    @property(Button) btnCoin5: Button = null!;
    /** Wild (PS=21) mid trên các reel có Wild. */
    @property(Button) btnWild3Reels: Button = null!;
    /** Maximize Blue Trail (PS=41). */
    @property(Button) btnRedCoins5: Button = null!;
    /** Maximize Green Trail (PS=42). */
    @property(Button) btnRedCoinsUnder6: Button = null!;
    /** Ways win + ≥1 Trail. */
    @property(Button) btnRedWithWin: Button = null!;
    /** Minor (1–6) mid ×5. */
    @property(Button) btnMinorWin5: Button = null!;
    /** Đúng 1 way (3 reel đầu). */
    @property(Button) btnSingleWayWin: Button = null!;
    /** Không win, không trail. */
    @property(Button) btnNoWin: Button = null!;
    /** Nhiều symbol thắng cùng lúc. */
    @property(Button) btnMultiLineWin: Button = null!;

    // ── FEATURE / FS ────────────────────────────────────────────────────────
    /** Sticky Green/Gold trên FS strips (nếu có). */
    @property(Button) btnYellowFreeSpin: Button = null!;

    // ── LEGACY TOPUP (15) — giữ binding prefab cũ ───────────────────────────
    @property(Button) btnTopupZeros: Button = null!;
    @property(Button) btnTopupAllYellow: Button = null!;
    @property(Button) btnTopupAllGreen: Button = null!;
    @property(Button) btnTopupAllPlusOne: Button = null!;

    @property(Button) btnSendCustom: Button = null!;

    onLoad(): void {
        if (this.debugPanelNode) this.debugPanelNode.active = false;
        if (this.inputReelIndices) this.inputReelIndices.maxLength = 200;
        this._bindButtons();
        Log.d('%c[SlotDebugPanel] Loaded — Carnival Neko DebugArray (5 reel stop indices)',
            'color:#0af;font-weight:bold');
    }

    public onClose(): void { this.onCloseDebug(); }

    onOpenDebug(): void {
        if (!this.debugPanelNode) return;
        this.debugPanelNode.active = true;
        this._setStatus('Carnival Neko — preset hoặc nhập 5 stop index.');
        this._refreshMemberIdx();
    }

    onCloseDebug(): void {
        if (this.debugPanelNode) this.debugPanelNode.active = false;
    }

    private _bindButtons(): void {
        try {
            this._bind(this.btnRandomSpin, this._onRandomSpin);
            this._bind(this.btnAllZeros, this._onAllZeros);
            this._bind(this.btnForcePickGame, this._onTrailRed);
            this._bind(this.btnAllNegOnes6, this._onTrailMix);
            this._bind(this.btnPhoenix5, this._onHigh5);
            this._bind(this.btnCoin5, this._onHighWin);
            this._bind(this.btnWild3Reels, this._onWild);
            this._bind(this.btnRedCoins5, this._onTrailBlue);
            this._bind(this.btnRedCoinsUnder6, this._onTrailGreen);
            this._bind(this.btnRedWithWin, this._onWinWithTrail);
            this._bind(this.btnMinorWin5, this._onMinorWin5);
            this._bind(this.btnSingleWayWin, this._onSingleWayWin);
            this._bind(this.btnNoWin, this._onNoWin);
            this._bind(this.btnMultiLineWin, this._onMultiLineWin);
            this._bind(this.btnYellowFreeSpin, this._onStickyFeature);
            this._bind(this.btnTopupZeros, this._onTopupZeros);
            this._bind(this.btnTopupAllYellow, this._onTopupAllYellow);
            this._bind(this.btnTopupAllGreen, this._onTopupAllGreen);
            this._bind(this.btnTopupAllPlusOne, this._onTopupAllPlusOne);
            this._bind(this.btnSendCustom, this.onSendDebugSpin);
        } catch (err) {
            Log.w('[SlotDebugPanel] _bindButtons error:', err);
        }
    }

    private _bind(btn: Button | null, handler: () => void): void {
        if (btn) btn.node.on(Button.EventType.CLICK, handler, this);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  HANDLERS
    // ════════════════════════════════════════════════════════════════════════

    private _onRandomSpin(): void {
        this._setInputText('');
        this._sendSpinWithDebugArray([], 'Random Spin (clear debug)');
    }

    private _onAllZeros(): void {
        this._firePreset(new Array(REEL_COUNT).fill(0), '[0,0,0,0,0] All Zeros');
    }

    private _onHigh5(): void {
        const arr = this._findMidForEachReel((s) => s === PS_MAJOR_HIGH);
        this._firePresetWithFallback(arr, `High×5 (PS=${PS_MAJOR_HIGH})`);
    }

    private _onHighWin(): void {
        const found = this._searchCombo({
            preferHighPay: true,
            requireWin: true,
            minWinSymbols: 1,
            preferTrail: false,
        });
        this._firePreset(found.arr, `High Win (${found.winCount} sym, ${found.totalWays} ways, high=${found.highHits})`);
    }

    private _onMinorWin5(): void {
        const arr = this._findMidForEachReel((s) => (PS_MINOR as readonly number[]).includes(s));
        this._firePresetWithFallback(arr, 'Minor×5');
    }

    private _onWild(): void {
        const arr = this._findMidForEachReel((s) => s === PS_WILD, false);
        for (let i = 0; i < REEL_COUNT; i++) if (arr[i] < 0) arr[i] = 0;
        const n = arr.filter((v, i) => {
            const strip = this._getStrips()[i];
            return strip && strip[v] === PS_WILD;
        }).length;
        this._firePreset(arr, `Wild mid ×${n}`);
    }

    private _onTrailBlue(): void {
        this._fireMaximizePs([PS_TRAIL_BLUE], 'Trail Blue (41)');
    }

    private _onTrailGreen(): void {
        this._fireMaximizePs([PS_TRAIL_GREEN], 'Trail Green (42)');
    }

    private _onTrailRed(): void {
        this._fireMaximizePs([PS_TRAIL_RED], 'Trail Red (43) → Red Pot');
    }

    private _onTrailMix(): void {
        this._fireMaximizePs([...PS_TRAILS], 'Trail Mix (41/42/43)');
    }

    private _onWinWithTrail(): void {
        const found = this._searchCombo({
            preferHighPay: false,
            requireWin: true,
            minWinSymbols: 1,
            preferTrail: true,
            minTrail: 1,
        });
        this._firePreset(
            found.arr,
            `Win+Trail (wins=${found.winCount}, trails=${found.trailCount}, ways=${found.totalWays})`,
        );
    }

    private _onSingleWayWin(): void {
        const strips = this._getStrips();
        const arr: number[] = new Array(REEL_COUNT).fill(0);
        const TARGET = PS_MAJOR_MID;
        const WILD = PS_WILD;

        for (let r = 0; r < 3; r++) {
            const strip = strips[r];
            if (!strip?.length) { arr[r] = 0; continue; }
            const len = strip.length;
            let found = -1;
            for (let i = 0; i < len; i++) {
                const [top, mid, bot] = this._window(strip, i);
                if (mid === TARGET && top !== TARGET && bot !== TARGET && top !== WILD && bot !== WILD
                    && !(PS_TRAILS as readonly number[]).includes(top)
                    && !(PS_TRAILS as readonly number[]).includes(bot)) {
                    found = i; break;
                }
            }
            if (found < 0) {
                for (let i = 0; i < len; i++) if (strip[i] === TARGET) { found = i; break; }
            }
            arr[r] = found >= 0 ? found : 0;
        }

        for (let r = 3; r < REEL_COUNT; r++) {
            const strip = strips[r];
            if (!strip?.length) { arr[r] = 0; continue; }
            const len = strip.length;
            let found = -1;
            for (let i = 0; i < len; i++) {
                const win = this._window(strip, i);
                if (win.every((s) => s !== TARGET && s !== WILD)) { found = i; break; }
            }
            arr[r] = found >= 0 ? found : 0;
        }

        this._firePreset(arr, `Win 1 line (PS=${TARGET} mid ×3)`);
    }

    private _onNoWin(): void {
        const found = this._searchCombo({
            preferHighPay: false,
            requireWin: false,
            minWinSymbols: 0,
            preferTrail: false,
            maxTrail: 0,
            preferNoWin: true,
        });
        if (found.winCount === 0) {
            this._firePreset(found.arr, `No Win (trails=${found.trailCount})`);
            return;
        }
        // Fallback: mid khác nhau từng reel (1,2,3,4,5)
        const strips = this._getStrips();
        const targets = [1, 2, 3, 4, 5];
        const arr = targets.map((ps, r) => {
            const strip = strips[r];
            if (!strip?.length) return 0;
            const idx = strip.findIndex((s) => s === ps);
            return idx >= 0 ? idx : 0;
        });
        this._firePreset(arr, 'No Win (mix minors fallback)');
    }

    private _onMultiLineWin(): void {
        const found = this._searchCombo({
            preferHighPay: false,
            requireWin: true,
            minWinSymbols: 2,
            preferTrail: false,
        });
        this._firePreset(
            found.arr,
            `Multi Line (${found.winCount} symbols, ${found.totalWays} ways)`,
        );
    }

    private _onStickyFeature(): void {
        // Ưu tiên FS strips; fallback normal — Sticky Green rồi Gold.
        const fs = this._getFreeSpinStrips();
        const useFs = fs.some((s) => s?.some((id) => id === PS_STICKY_GREEN || id === PS_STICKY_GOLD));
        const strips = useFs ? fs : this._getStrips();
        const target = strips.some((s) => s?.includes(PS_STICKY_GREEN)) ? PS_STICKY_GREEN : PS_STICKY_GOLD;
        const arr = this._findMidOnStrips(strips, (s) => s === target, false);
        for (let i = 0; i < REEL_COUNT; i++) if (arr[i] < 0) arr[i] = 0;
        this._firePreset(arr, `Sticky PS=${target} (${useFs ? 'FS strips' : 'normal strips'})`);
    }

    private _onTopupZeros(): void {
        this._firePreset(new Array(TOPUP_CELL_COUNT).fill(0), 'Legacy TopUp [0×15]');
    }

    private _onTopupAllYellow(): void {
        this._fireTopupPreset(PS_STICKY_GOLD, 'Legacy TopUp Sticky Gold (45)');
    }

    private _onTopupAllGreen(): void {
        this._fireTopupPreset(PS_STICKY_GREEN, 'Legacy TopUp Sticky Green (44)');
    }

    private _onTopupAllPlusOne(): void {
        this._fireTopupPreset(50, 'Legacy TopUp +1 (50)');
    }

    onSendDebugSpin(): void {
        try {
            if (!this.inputReelIndices) {
                this._setStatus('⚠ EditBox inputReelIndices chưa gắn!');
                return;
            }
            const raw = this.inputReelIndices.string?.trim();
            if (!raw) {
                this._setStatus('⚠ Nhập VD: "0,12,5,23,8"');
                return;
            }
            const arr = this._parseInput(raw);
            if (!arr) return;
            if (arr.length === REEL_COUNT) {
                this._sendSpinWithDebugArray(arr, 'Custom Normal/FS');
            } else if (arr.length === TOPUP_CELL_COUNT) {
                this._sendSpinWithDebugArray(arr, 'Custom 15-cell');
            } else {
                const msg = `⚠ Count=${arr.length}. Cần ${REEL_COUNT} (hoặc ${TOPUP_CELL_COUNT}).`;
                this._setStatus(msg);
                this._sendSpinWithDebugArray(arr, 'Wrong count');
            }
        } catch (err) {
            Log.e('[SlotDebugPanel] onSendDebugSpin error:', err);
            this._setStatus('❌ Lỗi: ' + String(err));
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  SEARCH / MAXIMIZE
    // ════════════════════════════════════════════════════════════════════════

    private _fireMaximizePs(psIds: number[], label: string): void {
        const strips = this._requireStrips();
        if (!strips) return;
        const want = new Set(psIds);
        const arr: number[] = new Array(REEL_COUNT).fill(0);
        let total = 0;
        for (let r = 0; r < REEL_COUNT; r++) {
            const strip = strips[r];
            let bestIdx = 0;
            let bestScore = -1;
            for (let i = 0; i < strip.length; i++) {
                const score = this._window(strip, i).filter((s) => want.has(s)).length;
                if (score > bestScore) { bestScore = score; bestIdx = i; }
            }
            arr[r] = bestIdx;
            total += Math.max(0, bestScore);
        }
        this._firePreset(arr, `${label} — visible=${total}`);
    }

    private _searchCombo(opts: {
        preferHighPay: boolean;
        requireWin: boolean;
        minWinSymbols: number;
        preferTrail: boolean;
        minTrail?: number;
        maxTrail?: number;
        preferNoWin?: boolean;
    }): { arr: number[]; winCount: number; totalWays: number; trailCount: number; highHits: number } {
        const psStrips = this._requireStrips();
        const fallback = {
            arr: new Array(REEL_COUNT).fill(0) as number[],
            winCount: 0, totalWays: 0, trailCount: 0, highHits: 0,
        };
        if (!psStrips) return fallback;

        const clientStrips = psStrips.map((strip) =>
            strip.map((psId) => PS_TO_CLIENT[psId] ?? -1),
        );
        const lens = psStrips.map((s) => s.length);
        const minTrail = opts.minTrail ?? 0;
        const maxTrail = opts.maxTrail ?? 999;

        let best = { ...fallback, arr: lens.map((len) => Math.floor(Math.random() * len)) };
        let bestScore = -1e9;

        for (let n = 0; n < SEARCH_ITERS; n++) {
            const arr = lens.map((len) => Math.floor(Math.random() * len));
            const evaled = this._evalStops(psStrips, clientStrips, arr);
            if (opts.requireWin && evaled.winCount < opts.minWinSymbols) continue;
            if (opts.preferNoWin && evaled.winCount > 0) continue;
            if (evaled.trailCount < minTrail || evaled.trailCount > maxTrail) continue;

            let score = 0;
            if (opts.preferNoWin) {
                score = 1000 - evaled.winCount * 100 - evaled.trailCount * 10;
            } else {
                score = evaled.winCount * 1000 + evaled.totalWays * 10;
                if (opts.preferHighPay) score += evaled.highHits * 500 + evaled.highWays * 5;
                if (opts.preferTrail) score += evaled.trailCount * 200;
                else score -= evaled.trailCount * 5; // ưu tiên win sạch khi không cần trail
            }
            if (score > bestScore) {
                bestScore = score;
                best = { arr: arr.slice(), ...evaled };
                if (!opts.preferNoWin && evaled.winCount >= 3 && (!opts.preferTrail || evaled.trailCount >= minTrail)) {
                    break;
                }
            }
        }

        if (opts.requireWin && best.winCount === 0) {
            Log.w('[SlotDebugPanel] Search: không tìm được combo win — dùng random fallback.');
        }
        return best;
    }

    private _evalStops(
        psStrips: number[][],
        clientStrips: number[][],
        arr: number[],
    ): { winCount: number; totalWays: number; trailCount: number; highHits: number; highWays: number } {
        const psGrid: number[][] = [];
        const grid: number[][] = [];
        for (let r = 0; r < REEL_COUNT; r++) {
            psGrid.push(this._window(psStrips[r], arr[r]));
            grid.push(this._window(clientStrips[r], arr[r]));
        }

        let trailCount = 0;
        for (const col of psGrid) {
            trailCount += col.filter((s) => (PS_TRAILS as readonly number[]).includes(s)).length;
        }

        const targets = new Set<number>();
        for (const s of grid[0]) {
            if (s >= 0 && !NON_PAY_CLIENT.has(s)) targets.add(s);
        }

        let winCount = 0;
        let totalWays = 0;
        let highHits = 0;
        let highWays = 0;
        const WILD = SymbolId.WILD;
        for (const sym of targets) {
            let ways = 1;
            let reelCount = 0;
            for (const col of grid) {
                const cnt = col.filter((s) => s === sym || s === WILD).length;
                if (cnt === 0) break;
                ways *= cnt;
                reelCount++;
            }
            if (reelCount >= 3) {
                winCount++;
                totalWays += ways;
                if (sym >= SymbolId.MAJOR_HORUS && sym <= SymbolId.MAJOR_CLEOPATRA) {
                    highHits++;
                    highWays += ways;
                }
            }
        }
        return { winCount, totalWays, trailCount, highHits, highWays };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  STRIPS / LOOKUP
    // ════════════════════════════════════════════════════════════════════════

    private _requireStrips(): number[][] | null {
        const strips = this._getStrips();
        if (!strips?.length || strips.some((s) => !s?.length)) {
            this._setStatus('⚠ Strips chưa load — Enter game trước.');
            return null;
        }
        return strips;
    }

    private _window(strip: number[], idx: number): [number, number, number] {
        const len = strip.length;
        const i = ((idx % len) + len) % len;
        return [
            strip[(i - 1 + len) % len],
            strip[i],
            strip[(i + 1) % len],
        ];
    }

    private _getStrips(): number[][] {
        const raw = GameData.instance.rawPsStrips;
        if (raw && raw.length === REEL_COUNT && raw.every((s) => s && s.length > 0)) return raw;
        return this._clientStripsToPs(GameData.instance.config.reelStrips);
    }

    private _getFreeSpinStrips(): number[][] {
        const raw = GameData.instance.rawPsFreeSpinStrips;
        if (raw && raw.length >= REEL_COUNT && raw.slice(0, REEL_COUNT).every((s) => s && s.length > 0)) {
            return raw.slice(0, REEL_COUNT);
        }
        return this._clientStripsToPs(GameData.instance.config.freeSpinReelStrips);
    }

    private _getRespinStrips(): number[][] {
        const purchase = GameData.instance.rawPsPurchaseReelStrips;
        if (purchase && purchase.length === REEL_COUNT && purchase.every((s) => s && s.length > 0)) return purchase;
        const fs = GameData.instance.rawPsFreeSpinStrips;
        if (fs && fs.length >= REEL_COUNT && fs.slice(0, REEL_COUNT).every((s) => s && s.length > 0)) {
            return fs.slice(0, REEL_COUNT);
        }
        return this._clientStripsToPs(GameData.instance.config.respinReelStrips);
    }

    private _clientStripsToPs(clientStrips: number[][]): number[][] {
        // Client SymbolId → PS (fallback khi chưa Enter / chưa có rawPsStrips)
        const map: Record<number, number> = {
            [SymbolId.MINOR_9]: 1, [SymbolId.MINOR_10]: 2, [SymbolId.MINOR_J]: 3,
            [SymbolId.MINOR_Q]: 4, [SymbolId.MINOR_K]: 5, [SymbolId.MINOR_A]: 6,
            [SymbolId.MAJOR_HORUS]: 11, [SymbolId.MAJOR_ANUBIS]: 12,
            [SymbolId.MAJOR_SOBEK]: 13, [SymbolId.MAJOR_RAMSES]: 14,
            [SymbolId.MAJOR_CLEOPATRA]: 15,
            [SymbolId.WILD]: 21,
            [SymbolId.STICKY_YELLOW]: 45, [SymbolId.STICKY_GREEN]: 44,
            [SymbolId.TRAIL_NORMAL]: 41, [SymbolId.TRAIL_BLUE]: 41,
            [SymbolId.TRAIL_RED]: 43, [SymbolId.TRAIL_GREEN]: 42,
        };
        return (clientStrips ?? []).map((strip) => (strip ?? []).map((cs) => map[cs] ?? 1));
    }

    private _findMidForEachReel(
        matcher: (psId: number) => boolean,
        requireAll: boolean = true,
    ): number[] {
        return this._findMidOnStrips(this._getStrips(), matcher, requireAll);
    }

    private _findMidOnStrips(
        strips: number[][],
        matcher: (psId: number) => boolean,
        requireAll: boolean,
    ): number[] {
        const arr: number[] = new Array(REEL_COUNT).fill(-1);
        for (let r = 0; r < REEL_COUNT; r++) {
            const strip = strips[r];
            if (!strip?.length) continue;
            arr[r] = strip.findIndex(matcher);
        }
        if (requireAll && arr.some((v) => v < 0)) {
            const missing = arr.map((v, i) => (v < 0 ? i : -1)).filter((i) => i >= 0);
            Log.w(`[SlotDebugPanel] Missing symbol on reel(s) ${missing.join(',')}`);
        }
        return arr;
    }

    private _fireTopupPreset(targetPsId: number, label: string): void {
        const strips = this._getRespinStrips();
        const arr: number[] = new Array(TOPUP_CELL_COUNT).fill(0);
        for (let cell = 0; cell < TOPUP_CELL_COUNT; cell++) {
            const reel = cell % REEL_COUNT;
            const strip = strips[reel];
            if (!strip?.length) { arr[cell] = 0; continue; }
            const idx = strip.findIndex((s) => s === targetPsId);
            arr[cell] = idx >= 0 ? idx : 0;
        }
        this._firePreset(arr, label);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  SEND
    // ════════════════════════════════════════════════════════════════════════

    private _parseInput(raw: string): number[] | null {
        const parts = raw.split(/[,\s]+/).filter((s) => s.length > 0);
        const result: number[] = [];
        for (const p of parts) {
            const num = parseInt(p, 10);
            if (isNaN(num)) {
                this._setStatus(`⚠ "${p}" không phải số nguyên`);
                return null;
            }
            result.push(num);
        }
        return result;
    }

    private _firePreset(arr: number[], label: string): void {
        this._setInputText(arr.join(', '));
        this._sendSpinWithDebugArray(arr, label);
    }

    private _firePresetWithFallback(arr: number[], label: string): void {
        const fixed = arr.map((v) => (v < 0 ? 0 : v));
        const hadMissing = arr.some((v) => v < 0);
        this._firePreset(fixed, label + (hadMissing ? ' (fallback 0)' : ''));
    }

    private _sendSpinWithDebugArray(debugArray: number[], label: string = ''): void {
        Log.d(
            `%c[SlotDebugPanel] Sending Debug Array: [${debugArray.join(', ')}] (len=${debugArray.length})`
            + (label ? ` — ${label}` : ''),
            'color:#0f0;font-weight:bold',
        );
        DebugManager.instance.setDebugRands(debugArray);
        EventBus.instance.emit(GameEvents.SPIN_REQUEST);
        this._setStatus(`✅ [${debugArray.join(', ')}]${label ? ' — ' + label : ''}`);
    }

    private _setInputText(text: string): void {
        if (this.inputReelIndices) this.inputReelIndices.string = text;
    }

    private _setStatus(msg: string): void {
        if (this.statusLabel) this.statusLabel.string = msg;
        Log.d(`[SlotDebugPanel] ${msg}`);
    }

    private _refreshMemberIdx(): void {
        const memberIdx = GameData.instance.serverSession?.memberIdx ?? 'N/A';
        if (this.memberIdxLabel) this.memberIdxLabel.string = `Member_Idx: ${memberIdx}`;
    }
}
