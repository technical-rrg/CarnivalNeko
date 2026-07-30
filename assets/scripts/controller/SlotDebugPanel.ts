/**
 * SlotDebugPanel — UI Debug Panel cho Gold of Fortunes (Shangri-La).
 *
 * Cập nhật theo API DebugArray v1.0.3 (dev env):
 *   • Normal / Free Spin: gửi 5 số → mỗi số là stop index của reel tương ứng.
 *   • Force Pick Game   : gửi [-1, -1, -1, -1, -1] trong normal spin.
 *   • Topup Spin        : gửi 15 số → mỗi số là stop index của cell trong lưới 3×5.
 *                         Ô đã trúng giữ nguyên, chỉ ô trống bị thay đổi.
 *   • Số phần tử sai    → server bỏ qua DebugArray, spin ngẫu nhiên.
 *
 * Preset được TÍNH ĐỘNG từ `GameData.instance.rawPsStrips` (PS IDs do server gửi qua
 * Enter API). Nhờ vậy nếu server cập nhật PS / fix slot ID thì panel tự đồng bộ —
 * không cần hardcode chỉ số.
 *
 * ─── Inspector setup ─────────────────────────────────────────────────────────
 *   1. Gắn component này vào 1 Node trong scene game.
 *   2. Kéo các Button con vào các property tương ứng (mọi field đều optional —
 *      chỉ bind button nào có thật trong scene).
 *   3. Mở panel bằng `onOpenDebug()`, đóng bằng `onCloseDebug()`.
 *
 * ─── Hành vi gửi spin ───────────────────────────────────────────────────────
 *   - Set `DebugManager.setDebugRands(arr)` để chèn DebugArray vào request kế tiếp.
 *   - Emit `GameEvents.SPIN_REQUEST` (tương đương người chơi bấm Spin chính).
 *   - Log màu xanh `Sending Debug Array: …` ngay trước khi NetworkManager AES-encrypt.
 */

import { _decorator, Component, Node, EditBox, Label, Button } from 'cc';
import { DebugManager } from '../manager/DebugManager';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { Log } from '../core/Logger';
import { SymbolId, PS_TO_CLIENT } from '../data/SlotTypes';

const { ccclass, property } = _decorator;

/** Game này 5 reels. */
const REEL_COUNT = 5;
/** Topup grid 3 rows × 5 reels = 15 cells. */
const TOPUP_CELL_COUNT = 15;

// ── PS Symbol IDs (theo PS_TO_CLIENT trong SlotTypes.ts) ─────────────────────
const PS_MINOR = [1, 2, 3, 4, 5, 6] as const;               // 9, 10, J, Q, K, A
const PS_MAJOR_CLEOPATRA = 15;                              // payout cao nhất
const PS_MAJOR_HORUS = 11;                                // payout thấp nhất
const PS_WILD = 21;                                         // Wild Trail (chỉ reel 1/2/3)
const PS_RED_COINS = [41, 42, 43, 44, 45, 46] as const;     // Red Coin Trail
const PS_YELLOW_FREE = 47;                                  // Yellow Coin — Free Spin Wild
const PS_YELLOW_TOPUP = 48;                                 // Yellow Coin — TopUp
const PS_GREEN = 49;                                        // Green Coin — TopUp VIP
const PS_PLUS_ONE_SPIN = 50;                                // +1 Spin (TopUp)

/** Phân tích Red Coin của 1 reel: map redCount → các stop index có thể tạo ra count đó. */
interface RedReelCandidates {
    reel: number;
    /** Stop index tạo ra 0 Red Coin (dùng làm mặc định). */
    zeroIdx: number;
    /** redCount → array of stop indices. */
    byCount: Map<number, number[]>;
    /** Số Red Coin tối đa reel này có thể hiển thị (0..3). */
    maxRed: number;
}

@ccclass('SlotDebugPanel')
export class SlotDebugPanel extends Component {

    // ════════════════════════════════════════════════════════════════════════
    //  PROPERTIES (Inspector)
    // ════════════════════════════════════════════════════════════════════════

    /** Khung UI chính — mặc định ẩn khi onLoad. */
    @property(Node)
    debugPanelNode: Node = null!;

    /** Ô nhập tay: VD "0,12,5,23,8" (5 số) hoặc 15 số cho TopUp. */
    @property(EditBox)
    inputReelIndices: EditBox = null!;

    /** Label trạng thái / kết quả. */
    @property(Label)
    statusLabel: Label = null!;

    /** Label hiển thị Member_Idx của session hiện tại. */
    @property(Label)
    memberIdxLabel: Label = null!;

    // ── NORMAL / FREE SPIN PRESETS ──────────────────────────────────────────

    /** Random spin — clear DebugArray, để server tự random. */
    @property(Button) btnRandomSpin: Button = null!;

    /** Integration test — gửi [0,0,0,0,0]. */
    @property(Button) btnAllZeros: Button = null!;

    /** Force Pick Game — gửi [-1,-1,-1,-1,-1] trong normal spin. */
    @property(Button) btnForcePickGame: Button = null!;

    /** Debug Array toàn -1 (6 phần tử) — gửi [-1,-1,-1,-1,-1,-1]. */
    @property(Button) btnAllNegOnes6: Button = null!;

    /** Big Win — Cleopatra (PS=15) trên cả 5 reels. */
    @property(Button) btnPhoenix5: Button = null!;

    /** Horus Win — MAJOR_HORUS (PS=11) trên cả 5 reels. */
    @property(Button) btnCoin5: Button = null!;

    /** Wild Trail trên reels 1/2/3 (PS=21) → tích lũy Pot / trigger Pick Game. */
    @property(Button) btnWild3Reels: Button = null!;

    /** Red Coin (PS=41-46) trên cả 5 reels → LUÔN ≥6 red để trigger Feature Select (TopUp / FreeSpin). */
    @property(Button) btnRedCoins5: Button = null!;

    /** Red Coin < 6 (1–5 red) — KHÔNG đủ trigger Feature Select; test gauge & Force Feature Entry. */
    @property(Button) btnRedCoinsUnder6: Button = null!;

    /** Red Coin + Line Win — đủ 6 red để trigger Feature Select, kèm ít nhất 1 line win. */
    @property(Button) btnRedWithWin: Button = null!;

    /** Normal Win nhỏ — Minor symbol (Q/K/A) trên cả 5 reels. */
    @property(Button) btnMinorWin5: Button = null!;

    /** Single Way Win — chỉ 3 reel đầu match 1 symbol duy nhất, reels 3/4 không match (ways=1). */
    @property(Button) btnSingleWayWin: Button = null!;

    /** No Win — chọn index không tạo combo (mix các symbol khác nhau). */
    @property(Button) btnNoWin: Button = null!;

    /** Multi Line Win — tìm combo có nhiều symbol thắng đồng thời nhất. */
    @property(Button) btnMultiLineWin: Button = null!;

    // ── FREE SPIN ──────────────────────────────────────────────────────────

    /** Yellow Coin Free Spin (PS=47) — test wild & instant pay trong Free Spin. */
    @property(Button) btnYellowFreeSpin: Button = null!;

    // ── TOPUP PRESETS (15 values) ──────────────────────────────────────────

    /** TopUp test — gửi 15 zeros. */
    @property(Button) btnTopupZeros: Button = null!;

    /** TopUp — toàn Yellow Coin (PS=48) → hút sạch Red trên reel. */
    @property(Button) btnTopupAllYellow: Button = null!;

    /** TopUp — toàn Green Coin (PS=49) → hút sạch toàn bộ. */
    @property(Button) btnTopupAllGreen: Button = null!;

    /** TopUp — toàn +1 Spin (PS=50). */
    @property(Button) btnTopupAllPlusOne: Button = null!;

    // ── CUSTOM ─────────────────────────────────────────────────────────────

    /** Send custom từ EditBox: auto-detect 5 (normal) hoặc 15 (topup). */
    @property(Button) btnSendCustom: Button = null!;

    // ════════════════════════════════════════════════════════════════════════
    //  LIFECYCLE
    // ════════════════════════════════════════════════════════════════════════

    onLoad(): void {
        if (this.debugPanelNode) this.debugPanelNode.active = false;
        if (this.inputReelIndices) this.inputReelIndices.maxLength = 200;
        this._bindButtons();
        Log.d('%c[SlotDebugPanel] Loaded — DebugArray API v1.0.3 (5 reels / 15 topup cells)',
            'color:#0af;font-weight:bold');
    }

    public onClose(): void { this.onCloseDebug(); }

    onOpenDebug(): void {
        if (!this.debugPanelNode) return;
        this.debugPanelNode.active = true;
        this._setStatus('Panel open — chọn preset hoặc nhập tay (5 số = normal, 15 số = topup).');
        this._refreshMemberIdx();
    }

    onCloseDebug(): void {
        if (this.debugPanelNode) this.debugPanelNode.active = false;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  BIND
    // ════════════════════════════════════════════════════════════════════════

    private _bindButtons(): void {
        try {
            this._bind(this.btnRandomSpin,      this._onRandomSpin);
            this._bind(this.btnAllZeros,        this._onAllZeros);
            this._bind(this.btnForcePickGame,   this._onForcePickGame);
            this._bind(this.btnAllNegOnes6,     this._onAllNegOnes6);

            this._bind(this.btnPhoenix5,        this._onPhoenix5);
            this._bind(this.btnCoin5,           this._onCoin5);
            this._bind(this.btnWild3Reels,      this._onWild3Reels);
            this._bind(this.btnRedCoins5,       this._onRedCoins5);
            this._bind(this.btnRedCoinsUnder6,  this._onRedCoinsUnder6);
            this._bind(this.btnRedWithWin,       this._onRedWithWin);
            this._bind(this.btnMinorWin5,       this._onMinorWin5);
            this._bind(this.btnSingleWayWin,    this._onSingleWayWin);
            this._bind(this.btnNoWin,           this._onNoWin);
            this._bind(this.btnMultiLineWin,     this._onMultiLineWin);

            this._bind(this.btnYellowFreeSpin,  this._onYellowFreeSpin);

            this._bind(this.btnTopupZeros,      this._onTopupZeros);
            this._bind(this.btnTopupAllYellow,  this._onTopupAllYellow);
            this._bind(this.btnTopupAllGreen,   this._onTopupAllGreen);
            this._bind(this.btnTopupAllPlusOne, this._onTopupAllPlusOne);

            this._bind(this.btnSendCustom,      this.onSendDebugSpin);
        } catch (err) {
            Log.w('[SlotDebugPanel] _bindButtons error:', err);
        }
    }

    private _bind(btn: Button | null, handler: () => void): void {
        if (btn) btn.node.on(Button.EventType.CLICK, handler, this);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  NORMAL SPIN HANDLERS
    // ════════════════════════════════════════════════════════════════════════

    private _onRandomSpin(): void {
        // Empty array — NetworkManager sẽ gửi DebugArray:[] (= RNG bình thường).
        this._setInputText('');
        this._sendSpinWithDebugArray([], 'Random Spin (clear debug)');
    }

    private _onAllZeros(): void {
        this._firePreset(new Array(REEL_COUNT).fill(0), '[0,0,0,0,0] All Zeros');
    }

    private _onForcePickGame(): void {
        this._firePreset(new Array(REEL_COUNT).fill(-1), 'Force Pick Game [-1×5]');
    }

    private _onAllNegOnes6(): void {
        this._firePreset([-1, -1, -1, -1, -1, -1], 'All Neg Ones [-1×6]');
    }

    private _onPhoenix5(): void {
        const arr = this._findIndicesForEachReel((sym) => sym === PS_MAJOR_CLEOPATRA);
        this._firePresetWithFallback(arr, 'Cleopatra × 5 (Big Win)');
    }

    private _onCoin5(): void {
        const arr = this._findIndicesForEachReel((sym) => sym === PS_MAJOR_HORUS);
        this._firePresetWithFallback(arr, 'Horus × 5 (MAJOR_HORUS Win)');
    }

    private _onWild3Reels(): void {
        // Wild chỉ có trên reel 1/2/3 (theo design). Reel 0 và 4 dùng index 0.
        const arr = this._findIndicesForEachReel((sym) => sym === PS_WILD, /*requireAll*/ false);
        for (let i = 0; i < REEL_COUNT; i++) if (arr[i] < 0) arr[i] = 0;
        this._firePreset(arr, 'Wild Trail × 3 (reel 1/2/3)');
    }

    /**
     * Phân tích Red Coin của từng reel dựa trên PS strips hiện tại.
     * Với mỗi reel: liệt kê stop index → số Red Coin hiển thị (0..3) trong cửa sổ 3 ô.
     * Ràng buộc: reel 0 ô top (idx-1) phải là symbol thường (không phải Red Coin).
     */
    private _buildRedReelCandidates(): RedReelCandidates[] {
        const strips = this._getStrips();
        const normalPsSymbols = new Set<number>([1, 2, 3, 11, 12, 13, 14, 15]);
        const isRedCoin = (s: number) => (PS_RED_COINS as readonly number[]).includes(s);
        const isNormalSymbol = (s: number) => normalPsSymbols.has(s);

        const out: RedReelCandidates[] = [];
        for (let r = 0; r < REEL_COUNT; r++) {
            const strip = strips[r];
            const byCount = new Map<number, number[]>();
            let zeroIdx = -1, maxRed = 0;
            if (strip && strip.length > 0) {
                const len = strip.length;
                for (let i = 0; i < len; i++) {
                    const top = strip[(i - 1 + len) % len];
                    const mid = strip[i];
                    const bot = strip[(i + 1) % len];
                    const score = [top, mid, bot].filter(isRedCoin).length;
                    if (r === 0 && !isNormalSymbol(top)) continue; // reel0 top phải là normal
                    if (!byCount.has(score)) byCount.set(score, []);
                    byCount.get(score)!.push(i);
                    if (score > maxRed) maxRed = score;
                    if (score === 0 && zeroIdx < 0) zeroIdx = i;
                }
            }
            out.push({ reel: r, zeroIdx: zeroIdx >= 0 ? zeroIdx : 0, byCount, maxRed });
        }
        return out;
    }

    /** Chọn ngẫu nhiên 1 stop index của reel tạo ra đúng `count` Red Coin (null nếu không có). */
    private _pickRedIndex(rc: RedReelCandidates, count: number): number | null {
        const idxs = rc.byCount.get(count);
        if (idxs && idxs.length > 0) return idxs[Math.floor(Math.random() * idxs.length)];
        return null;
    }

    /**
     * ★ Red Coins ≥ 6 — LUÔN đủ ≥ 6 Red Coin để trigger Feature Select thật (đủ 6).
     * Lấy maxRed từ các reel giàu Red Coin nhất (sort desc) cho tới khi tổng ≥ 6.
     */
    private _onRedCoins5(): void {
        const TARGET = 6;
        const cands = this._buildRedReelCandidates();
        const arr: number[] = cands.map(rc => rc.zeroIdx);
        const totalMax = cands.reduce((s, rc) => s + rc.maxRed, 0);

        // Ưu tiên reel có nhiều Red nhất trước → dồn đủ ≥ 6 nhanh nhất.
        const order = [...cands].sort((a, b) => b.maxRed - a.maxRed);
        let total = 0;
        for (const rc of order) {
            if (total >= TARGET) break;
            if (rc.maxRed <= 0) continue;
            const idx = this._pickRedIndex(rc, rc.maxRed);
            if (idx != null) { arr[rc.reel] = idx; total += rc.maxRed; }
        }

        if (total < TARGET) {
            Log.w(`[SlotDebugPanel] Chỉ đạt ${total} Red (totalMax=${totalMax}) — strip không đủ Red Coin để đạt 6.`);
        }
        this._firePreset(arr, `Red Coins ${total} (≥6) → Feature Select (đủ 6)`);
    }

    /**
     * ★ Red Coins < 6 — hiện 1..5 Red Coin (KHÔNG đủ 6).
     * Dùng để test nhánh Force Feature Entry: server sẽ roll xác suất đổ thêm cho đủ 6.
     * (Với mock, dùng MOCK_SPIN_SCENARIO='force_feature_entry' để buộc hiệu ứng chạy.)
     */
    private _onRedCoinsUnder6(): void {
        const cands = this._buildRedReelCandidates();
        const arr: number[] = cands.map(rc => rc.zeroIdx);
        const totalMax = cands.reduce((s, rc) => s + rc.maxRed, 0);

        // Mục tiêu ngẫu nhiên 3..5 Red (nhưng không vượt tổng khả dụng và luôn < 6).
        let target = Math.min(5, totalMax, 3 + Math.floor(Math.random() * 3)); // 3..5
        if (target < 1 && totalMax > 0) target = 1;

        const order = [...cands].sort(() => Math.random() - 0.5); // xáo trộn reel
        let remaining = target;
        for (const rc of order) {
            if (remaining <= 0) break;
            const want = Math.min(remaining, rc.maxRed); // cap để KHÔNG vượt target (<6)
            for (let c = want; c >= 1; c--) {
                const idx = this._pickRedIndex(rc, c);
                if (idx != null) { arr[rc.reel] = idx; remaining -= c; break; }
            }
        }

        let achieved = target - remaining;
        // Fallback: nếu chưa đặt được Red nào → ép 1 reel giàu nhất (maxRed ≤ 3 nên vẫn < 6).
        if (achieved === 0) {
            const richest = [...cands].sort((a, b) => b.maxRed - a.maxRed)[0];
            if (richest && richest.maxRed > 0) {
                const idx = this._pickRedIndex(richest, richest.maxRed);
                if (idx != null) { arr[richest.reel] = idx; achieved = richest.maxRed; }
            }
        }
        this._firePreset(arr, `Red Coins ${achieved} (<6) → Force Feature Entry check`);
    }

    private _onMinorWin5(): void {
        const arr = this._findIndicesForEachReel((sym) => (PS_MINOR as readonly number[]).includes(sym));
        this._firePresetWithFallback(arr, 'Minor × 5 (Normal Win)');
    }

    /**
     * Red Coin + Line Win + Wild — random search để tìm stop index có >6 red visible,
     * ít nhất 1 Wild, và ít nhất 1 line win (Ways Pay reelCount ≥ 3).
     */
    private _onRedWithWin(): void {
        const psStrips = this._getStrips();
        if (!psStrips || psStrips.length === 0 || psStrips.some((s) => !s || s.length === 0)) {
            this._setStatus('⚠ Strips chưa load — không thể tìm Red + Win + Wild.');
            return;
        }

        const clientStrips = psStrips.map((strip) =>
            strip.map((psId) => PS_TO_CLIENT[psId] ?? -1)
        );

        const featureSymbols = new Set<number>([
            SymbolId.WILD, SymbolId.STICKY_RED, SymbolId.STICKY_YELLOW,
            SymbolId.STICKY_GREEN, SymbolId.PLUS_ONE_SPIN,
            SymbolId.JP_IDLE, SymbolId.JP_MINI, SymbolId.JP_MINOR,
            SymbolId.JP_MAJOR, SymbolId.JP_GRAND,
        ]);
        const WILD = SymbolId.WILD;
        const reelLens = psStrips.map((s) => s.length);
        const SEARCH_ITERATIONS = 50000;
        const isRedCoin = (s: number) => (PS_RED_COINS as readonly number[]).includes(s);
        const strip0 = psStrips[0];
        const len0 = strip0?.length ?? 0;
        let safeReel0Index = 0;
        if (strip0 && len0 > 0) {
            for (let i = 0; i < len0; i++) {
                const top = strip0[(i - 1 + len0) % len0];
                if (!isRedCoin(top)) {
                    safeReel0Index = i;
                    break;
                }
            }
        }

        let bestArr: number[] = new Array(REEL_COUNT).fill(0);
        bestArr[0] = safeReel0Index;
        let bestRedCount = 0;
        let bestWinCount = 0;
        let bestWildCount = 0;
        let found = false;

        for (let i = 0; i < SEARCH_ITERATIONS; i++) {
            const arr = reelLens.map((len) => Math.floor(Math.random() * len));
            if (strip0 && len0 > 0) {
                const col0Row0 = strip0[(arr[0] - 1 + len0) % len0];
                if (isRedCoin(col0Row0)) continue;
            }

            // Count red coins & wilds in visible grid (PS IDs)
            let redCount = 0;
            let wildCount = 0;
            for (let r = 0; r < REEL_COUNT; r++) {
                const strip = psStrips[r];
                const len = strip.length;
                const idx = arr[r];
                const visible = [
                    strip[(idx - 1 + len) % len],
                    strip[idx],
                    strip[(idx + 1) % len],
                ];
                redCount += visible.filter(isRedCoin).length;
                wildCount += visible.filter((s) => s === PS_WILD).length;
            }

            if (redCount <= 6) continue;
            if (wildCount === 0) continue;

            // Evaluate wins using client SymbolIds
            const clientGrid: number[][] = [];
            for (let r = 0; r < REEL_COUNT; r++) {
                const strip = clientStrips[r];
                const len = strip.length;
                const idx = arr[r];
                clientGrid.push([
                    strip[(idx - 1 + len) % len],
                    strip[idx],
                    strip[(idx + 1) % len],
                ]);
            }

            const targets = new Set<number>();
            for (const s of clientGrid[0]) {
                if (s >= 0 && !featureSymbols.has(s)) targets.add(s);
            }

            let winCount = 0;
            for (const sym of targets) {
                let reelCount = 0;
                for (const col of clientGrid) {
                    const cnt = col.filter((s) => s === sym || s === WILD).length;
                    if (cnt === 0) break;
                    reelCount++;
                }
                if (reelCount >= 3) {
                    winCount++;
                }
            }

            if (redCount > 6 && winCount > 0 && wildCount > 0) {
                bestArr = arr.slice();
                bestRedCount = redCount;
                bestWinCount = winCount;
                bestWildCount = wildCount;
                found = true;
                break;
            }

            // Fallback scoring: prefer more red, then win, then wild
            const score = redCount * 10000 + winCount * 100 + wildCount;
            const bestScore = bestRedCount * 10000 + bestWinCount * 100 + bestWildCount;
            if (score > bestScore) {
                bestArr = arr.slice();
                bestRedCount = redCount;
                bestWinCount = winCount;
                bestWildCount = wildCount;
            }
        }

        const label = found
            ? `Red+Win+Wild (${bestRedCount} red, ${bestWildCount} wild, ${bestWinCount} wins) → Feature Select + Highlight`
            : `Red+Win+Wild fallback (red=${bestRedCount}, wild=${bestWildCount}, wins=${bestWinCount})`;
        if (strip0 && len0 > 0) {
            const col0Row0 = strip0[(bestArr[0] - 1 + len0) % len0];
            if (isRedCoin(col0Row0)) {
                bestArr[0] = safeReel0Index;
                Log.w(`[SlotDebugPanel] Red+Win+Wild: forced reel0 index=${safeReel0Index} so col0,row0 is not red.`);
            }
        }
        if (!found) {
            Log.w(`[SlotDebugPanel] Red+Win+Wild: Không tìm được combo lý tưởng (>6 red + wild + win). Dùng fallback.`);
        }
        this._firePreset(bestArr, label);
    }

    /**
     * Single Way Win — reels 0/1/2 mỗi reel có đúng 1 instance target symbol ở MID row,
     * reels 3/4 không có target symbol và không có Wild. Đảm bảo ways=1, reelCount=3.
     */
    private _onSingleWayWin(): void {
        const strips = this._getStrips();
        const arr: number[] = new Array(REEL_COUNT).fill(0);

        // Target: PS_MAJOR_HORUS (11) — symbol phổ biến, dễ tìm
        const TARGET = 11;
        const WILD = PS_WILD;

        // Reels 0/1/2: tìm index sao cho MID = TARGET, TOP/BOT != TARGET và != WILD
        for (let r = 0; r < 3; r++) {
            const strip = strips[r];
            if (!strip || strip.length === 0) { arr[r] = 0; continue; }
            const len = strip.length;
            let found = -1;
            for (let i = 0; i < len; i++) {
                const top = strip[(i - 1 + len) % len];
                const mid = strip[i];
                const bot = strip[(i + 1) % len];
                if (mid === TARGET && top !== TARGET && bot !== TARGET && top !== WILD && bot !== WILD) {
                    found = i; break;
                }
            }
            if (found < 0) {
                // Fallback: tìm bất kỳ index nào có TARGET ở mid (dù top/bot có thể cũng là TARGET)
                for (let i = 0; i < len; i++) {
                    if (strip[i] === TARGET) { found = i; break; }
                }
                Log.w(`[SlotDebugPanel] SingleWayWin: Reel${r} không có index lý tưởng (mid=${TARGET} only). Dùng fallback mid=${TARGET}.`);
            }
            arr[r] = found >= 0 ? found : 0;
        }

        // Reels 3/4: tìm index sao cho TOP/MID/BOT đều != TARGET và != WILD
        for (let r = 3; r < REEL_COUNT; r++) {
            const strip = strips[r];
            if (!strip || strip.length === 0) { arr[r] = 0; continue; }
            const len = strip.length;
            let found = -1;
            for (let i = 0; i < len; i++) {
                const top = strip[(i - 1 + len) % len];
                const mid = strip[i];
                const bot = strip[(i + 1) % len];
                if (top !== TARGET && mid !== TARGET && bot !== TARGET && top !== WILD && mid !== WILD && bot !== WILD) {
                    found = i; break;
                }
            }
            if (found < 0) {
                // Fallback: tìm index không có TARGET (bỏ qua wild check)
                for (let i = 0; i < len; i++) {
                    const top = strip[(i - 1 + len) % len];
                    const mid = strip[i];
                    const bot = strip[(i + 1) % len];
                    if (top !== TARGET && mid !== TARGET && bot !== TARGET) { found = i; break; }
                }
                Log.w(`[SlotDebugPanel] SingleWayWin: Reel${r} không có index lý tưởng (no TARGET/WILD). Dùng fallback.`);
            }
            arr[r] = found >= 0 ? found : 0;
        }

        // Verify
        const visible = arr.map((idx, r) => {
            const s = strips[r];
            if (!s || s.length === 0) return [];
            const len = s.length;
            return [s[(idx - 1 + len) % len], s[idx], s[(idx + 1) % len]];
        });
        const wayCount = visible.slice(0, 3).reduce((ways, row) => {
            const c = row.filter((s) => s === TARGET || s === WILD).length;
            return ways * Math.max(c, 1);
        }, 1);
        const hasMatch34 = visible[3].some((s) => s === TARGET || s === WILD) ||
                           visible[4].some((s) => s === TARGET || s === WILD);
        const label = `Single Way Win (${TARGET}) — ways≈${wayCount} match34=${hasMatch34}`;
        if (wayCount !== 1 || hasMatch34) {
            Log.w(`[SlotDebugPanel] ${label} → KHÔNG đạt yêu cầu 1 way duy nhất!`);
        }
        this._firePreset(arr, label);
    }

    private _onNoWin(): void {
        // Mix minor + low major trên 5 reels → ít khả năng tạo way pay.
        const targets = [1, 2, 3, 4, 5, 11, 12]; // 9, 10, J, Q, K, Horus, Anubis
        const arr: number[] = new Array(REEL_COUNT).fill(0);
        const strips = this._getStrips();
        for (let r = 0; r < REEL_COUNT; r++) {
            const strip = strips[r];
            if (!strip || strip.length === 0) continue;
            const target = targets[r % targets.length];
            const idx = strip.findIndex((s) => s === target);
            arr[r] = idx >= 0 ? idx : 0;
        }
        this._firePreset(arr, 'No Win (mix symbols)');
    }

    /**
     * Multi Line Win — random search 5000 combinations để tìm stop index
     * cho nhiều symbol thắng đồng thời nhất (mỗi symbol = 1 WaysPayWin).
     */
    private _onMultiLineWin(): void {
        const psStrips = this._getStrips();
        if (!psStrips || psStrips.length === 0 || psStrips.some((s) => !s || s.length === 0)) {
            this._setStatus('⚠ Strips chưa load — không thể tìm Multi Line Win.');
            return;
        }

        // Convert PS strips → client SymbolId strips để evaluate
        const clientStrips = psStrips.map((strip) =>
            strip.map((psId) => PS_TO_CLIENT[psId] ?? -1)
        );

        const featureSymbols = new Set<number>([
            SymbolId.WILD, SymbolId.STICKY_RED, SymbolId.STICKY_YELLOW,
            SymbolId.STICKY_GREEN, SymbolId.PLUS_ONE_SPIN,
            SymbolId.JP_IDLE, SymbolId.JP_MINI, SymbolId.JP_MINOR,
            SymbolId.JP_MAJOR, SymbolId.JP_GRAND,
        ]);
        const WILD = SymbolId.WILD;
        const reelLens = clientStrips.map((s) => s.length);
        const SEARCH_ITERATIONS = 5000;

        let bestArr: number[] = new Array(REEL_COUNT).fill(0);
        let bestWinCount = 0;
        let bestTotalWays = 0;

        for (let i = 0; i < SEARCH_ITERATIONS; i++) {
            const arr = reelLens.map((len) => Math.floor(Math.random() * len));

            // Build visible grid (3 rows × 5 reels) từ stop indices
            const grid: number[][] = [];
            for (let r = 0; r < REEL_COUNT; r++) {
                const strip = clientStrips[r];
                const len = strip.length;
                const idx = arr[r];
                grid.push([
                    strip[(idx - 1 + len) % len],
                    strip[idx],
                    strip[(idx + 1) % len],
                ]);
            }

            // Evaluate wins theo Ways Pay logic (đơn giản hóa)
            const targets = new Set<number>();
            for (const s of grid[0]) {
                if (s >= 0 && !featureSymbols.has(s)) targets.add(s);
            }

            let winCount = 0;
            let totalWays = 0;
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
                }
            }

            if (winCount > bestWinCount || (winCount === bestWinCount && totalWays > bestTotalWays)) {
                bestWinCount = winCount;
                bestTotalWays = totalWays;
                bestArr = arr.slice();
                if (winCount >= 3) break; // Good enough
            }
        }

        const label = `Multi Line Win (${bestWinCount} symbols, ${bestTotalWays} ways)`;
        if (bestWinCount === 0) {
            Log.w(`[SlotDebugPanel] MultiLineWin: Không tìm thấy combo nào có win. Kiểm tra strips đã load chưa.`);
        }
        this._firePreset(bestArr, label);
    }

    private _onYellowFreeSpin(): void {
        const arr = this._findIndicesForEachReel((sym) => sym === PS_YELLOW_FREE,
            /*requireAll*/ false, /*useFreeSpinStrips*/ true);
        for (let i = 0; i < REEL_COUNT; i++) if (arr[i] < 0) arr[i] = 0;
        this._firePreset(arr, 'Yellow Coin × FreeSpin reels');
    }

    // ════════════════════════════════════════════════════════════════════════
    //  TOPUP HANDLERS (15 values)
    // ════════════════════════════════════════════════════════════════════════

    private _onTopupZeros(): void {
        this._firePreset(new Array(TOPUP_CELL_COUNT).fill(0), 'TopUp [0×15]');
    }

    private _onTopupAllYellow(): void {
        this._fireTopupPreset(PS_YELLOW_TOPUP, 'TopUp All Yellow (PS=48)');
    }

    private _onTopupAllGreen(): void {
        this._fireTopupPreset(PS_GREEN, 'TopUp All Green (PS=49)');
    }

    private _onTopupAllPlusOne(): void {
        this._fireTopupPreset(PS_PLUS_ONE_SPIN, 'TopUp All +1 Spin (PS=50)');
    }

    /**
     * Lưới TopUp = 3 rows × 5 reels = 15 cells. Mỗi cell có index riêng trên strip
     * của reel chứa cell đó (cell % REEL_COUNT). Tìm index có symbol mong muốn.
     */
    private _fireTopupPreset(targetPsId: number, label: string): void {
        const strips = this._getRespinStrips();
        const arr: number[] = new Array(TOPUP_CELL_COUNT).fill(0);
        for (let cell = 0; cell < TOPUP_CELL_COUNT; cell++) {
            const reel = cell % REEL_COUNT;
            const strip = strips[reel];
            if (!strip || strip.length === 0) { arr[cell] = 0; continue; }
            const idx = strip.findIndex((s) => s === targetPsId);
            arr[cell] = idx >= 0 ? idx : 0;
        }
        this._firePreset(arr, label);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  CUSTOM INPUT
    // ════════════════════════════════════════════════════════════════════════

    onSendDebugSpin(): void {
        try {
            if (!this.inputReelIndices) {
                this._setStatus('⚠ EditBox inputReelIndices chưa gắn trong Inspector!');
                return;
            }
            const raw = this.inputReelIndices.string?.trim();
            if (!raw) {
                this._setStatus('⚠ Ô nhập trống! VD normal: "0,12,5,23,8" — VD topup: 15 số.');
                return;
            }
            const arr = this._parseInput(raw);
            if (!arr) return;

            if (arr.length === REEL_COUNT) {
                this._sendSpinWithDebugArray(arr, 'Custom Normal/FreeSpin');
            } else if (arr.length === TOPUP_CELL_COUNT) {
                this._sendSpinWithDebugArray(arr, 'Custom TopUp (15)');
            } else {
                const msg = `⚠ Wrong count = ${arr.length}. Cần ${REEL_COUNT} (normal/FS) hoặc ${TOPUP_CELL_COUNT} (TopUp). Server sẽ random.`;
                this._setStatus(msg);
                Log.w(`[SlotDebugPanel] ${msg}`);
                this._sendSpinWithDebugArray(arr, 'Wrong Count (server will random)');
            }
        } catch (err) {
            Log.e('[SlotDebugPanel] onSendDebugSpin error:', err);
            this._setStatus('❌ Lỗi: ' + String(err));
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  HELPERS — strips / index lookup
    // ════════════════════════════════════════════════════════════════════════

    private _getStrips(): number[][] {
        const raw = GameData.instance.rawPsStrips;
        if (raw && raw.length === REEL_COUNT && raw.every((s) => s && s.length > 0)) return raw;
        // Fallback (chưa Enter game): convert client SymbolId → PS ID xấp xỉ.
        return this._clientStripsToPs(GameData.instance.config.reelStrips);
    }

    private _getFreeSpinStrips(): number[][] {
        const raw = GameData.instance.rawPsFreeSpinStrips;
        if (raw && raw.length === REEL_COUNT && raw.every((s) => s && s.length > 0)) return raw;
        return this._clientStripsToPs(GameData.instance.config.freeSpinReelStrips);
    }

    private _getRespinStrips(): number[][] {
        // TopUp dùng strip chứa Yellow/Green/+1Spin — server gửi qua PurchaseReel
        // hoặc FreeSpinReel tuỳ game.
        const purchase = GameData.instance.rawPsPurchaseReelStrips;
        if (purchase && purchase.length === REEL_COUNT && purchase.every((s) => s && s.length > 0)) return purchase;
        const fs = GameData.instance.rawPsFreeSpinStrips;
        if (fs && fs.length === REEL_COUNT && fs.every((s) => s && s.length > 0)) return fs;
        return this._clientStripsToPs(GameData.instance.config.respinReelStrips);
    }

    /** Map client SymbolId → PS ID đại diện (chỉ dùng làm fallback khi chưa có rawPsStrips). */
    private _clientStripsToPs(clientStrips: number[][]): number[][] {
        const map: Record<number, number> = {
            0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6,
            6: 11, 7: 12, 8: 13, 9: 14, 10: 15,
            11: 21, 12: 41, 13: 47, 14: 49, 15: 50,
        };
        return clientStrips.map((strip) => strip.map((cs) => map[cs] ?? 99));
    }

    private _findIndicesForEachReel(
        matcher: (psSymbolId: number) => boolean,
        requireAll: boolean = true,
        useFreeSpinStrips: boolean = false,
    ): number[] {
        const strips = useFreeSpinStrips ? this._getFreeSpinStrips() : this._getStrips();
        const arr: number[] = new Array(REEL_COUNT).fill(-1);
        for (let r = 0; r < REEL_COUNT; r++) {
            const strip = strips[r];
            if (!strip || strip.length === 0) continue;
            arr[r] = strip.findIndex(matcher);
        }
        if (requireAll && arr.some((v) => v < 0)) {
            const missing = arr.map((v, i) => v < 0 ? i : -1).filter((i) => i >= 0);
            Log.w(`[SlotDebugPanel] Không tìm thấy symbol trên reel(s) ${missing.join(',')} — fallback về 0.`);
        }
        return arr;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  HELPERS — parse / send
    // ════════════════════════════════════════════════════════════════════════

    private _parseInput(raw: string): number[] | null {
        const parts = raw.split(/[,\s]+/).filter((s) => s.length > 0);
        const result: number[] = [];
        for (let i = 0; i < parts.length; i++) {
            const num = parseInt(parts[i], 10);
            if (isNaN(num)) {
                this._setStatus(`⚠ Giá trị "${parts[i]}" không phải số nguyên!`);
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

    /** Như _firePreset nhưng nếu có index < 0 thì thay = 0 + warn. */
    private _firePresetWithFallback(arr: number[], label: string): void {
        const fixed = arr.map((v) => v < 0 ? 0 : v);
        const hadMissing = arr.some((v) => v < 0);
        this._firePreset(fixed, label + (hadMissing ? ' (some reels fallback to 0)' : ''));
    }

    private _sendSpinWithDebugArray(debugArray: number[], label: string = ''): void {
        Log.d(
            `%c[SlotDebugPanel] Sending Debug Array: [${debugArray.join(', ')}] (len=${debugArray.length})` +
            (label ? ` — ${label}` : ''),
            'color:#0f0;font-weight:bold'
        );
        Log.d('Sending Debug Array:', debugArray);
        Log.d('[SlotDebugPanel] Member_Idx:', GameData.instance.serverSession?.memberIdx ?? 'N/A');

        DebugManager.instance.setDebugRands(debugArray);
        EventBus.instance.emit(GameEvents.SPIN_REQUEST);

        this._setStatus(`✅ Sent [${debugArray.join(', ')}] (len=${debugArray.length})${label ? ' — ' + label : ''}`);
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
        Log.d('[SlotDebugPanel] Member_Idx:', memberIdx);
    }
}
