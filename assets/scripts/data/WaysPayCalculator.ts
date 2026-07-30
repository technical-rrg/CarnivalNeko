/**
 * WaysPayCalculator — Engine tính Ways Pay 243 (Gold of Fortune).
 *
 * Thuật toán (theo spec):
 *  1. Lấy danh sách Unique Symbols ở Cột 1 (Reel 0), bỏ qua Feature symbols (Sticky/+1/JP/Wild).
 *  2. Với mỗi Target Symbol, quét sang Cột 2, 3, 4, 5 (từ trái sang phải).
 *  3. Ở mỗi cột: đếm số ô là Target Symbol HOẶC Wild.
 *  4. Dừng nếu cột đó có số đếm = 0.
 *  5. Trúng nếu quét được ≥ 3 cột liên tiếp.
 *
 * Wild substitution:
 *  - Base Game : Wild = WILD (id=11), chỉ xuất hiện ở Reel 1,2,3.
 *  - Free Spin : Wild = STICKY_YELLOW (id=13), chỉ xuất hiện ở Reel 1,2,3.
 *  - Wild KHÔNG thay thế Feature symbols (Sticky Red/Green, +1 Spin, JP icons).
 *  - Wild đứng một mình KHÔNG tự thắng (không phải Target Symbol).
 *
 * Công thức:
 *  Winning Ways = count[Reel0] × count[Reel1] × ... (mỗi reel liên tiếp)
 *  Win Amount   = Paytable[Symbol][matchedColumns - 3] × TotalBet × WinningWays
 */

import { WaysPayWin, SymbolId } from './SlotTypes';
import { GameData } from './GameData';

/** Set các symbol KHÔNG được là Target (Feature symbols + Wild bản thân) */
const FEATURE_SYMBOLS = new Set([
    SymbolId.WILD,
    SymbolId.STICKY_RED,
    SymbolId.STICKY_YELLOW,
    SymbolId.STICKY_GREEN,
    SymbolId.PLUS_ONE_SPIN,
    SymbolId.JP_IDLE,
    SymbolId.JP_MINI,
    SymbolId.JP_MINOR,
    SymbolId.JP_MAJOR,
    SymbolId.JP_GRAND,
    SymbolId.TRAIL_NORMAL,
    SymbolId.TRAIL_BLUE,
    SymbolId.TRAIL_RED,
    SymbolId.TRAIL_GREEN,
]);

export class WaysPayCalculator {

    /**
     * Tính tất cả Ways Pay wins từ grid 5×3.
     * @param grid       grid[reel][row] = symbolId
     * @param totalBet   stake (đã include coinValue)
     * @param isFreeSpin true → Wild = STICKY_YELLOW, false → Wild = WILD
     */
    static calculate(grid: number[][], totalBet: number, isFreeSpin: boolean = false): WaysPayWin[] {
        const config   = GameData.instance.config;
        const reelCount = grid.length;
        if (reelCount < 3) return [];

        // Wild tuỳ mode
        const wildId = isFreeSpin ? SymbolId.STICKY_YELLOW : SymbolId.WILD;

        // ── Bước 1: Unique Target Symbols từ Cột 0 (Reel 0) ──────────────────
        const col0 = grid[0] ?? [];
        const targets = new Set<number>();
        for (const s of col0) {
            if (!FEATURE_SYMBOLS.has(s)) targets.add(s);
        }

        // ── Bước 2–5: Tính win cho từng target ────────────────────────────────
        const wins: WaysPayWin[] = [];
        for (const sym of targets) {
            const win = this._calcSymbol(grid, sym, wildId, config.waysPayTable, totalBet, reelCount);
            if (win) wins.push(win);
        }

        // ══ DEBUG LOG ══
        console.log(
            `%c[WaysPayCalc] grid=${reelCount}×${(grid[0]??[]).length} | wildId=${wildId} | isFreeSpin=${isFreeSpin} | totalBet=${totalBet}\n` +
            `  col0=[${col0.join(',')}] → targets=[${[...targets].join(',')}]\n` +
            `  grid: ${grid.map((c, i) => `R${i}=[${c.join(',')}]`).join(' | ')}\n` +
            `  WINS (${wins.length}): ${wins.map(w =>
                `{sym=${w.symbolId}, reels=${w.reelCount}, ways=${w.ways}, payout=${w.payout.toFixed(3)},` +
                ` gridCells=[${w.cells.map(c => `r${c.reel}g${c.row}→d${2-c.row}`).join(',')}]}`
            ).join('\n        ')}`,
            'color:#ff0;font-weight:bold'
        );
        // ══════════════

        return wins;
    }

    /** Tính win cho 1 symbol cụ thể, trả null nếu < 3 cột hoặc multiplier = 0. */
    private static _calcSymbol(
        grid:      number[][],
        symbol:    number,
        wildId:    number,
        paytable:  Record<number, [number, number, number]>,
        totalBet:  number,
        reelCount: number,
    ): WaysPayWin | null {

        const reelHits: Array<{
            count:     number;
            positions: Array<{ reel: number; row: number }>;
            hasWild:   boolean;
        }> = [];

        for (let r = 0; r < reelCount; r++) {
            const col       = grid[r] ?? [];
            const positions: Array<{ reel: number; row: number }> = [];
            let   hasWild   = false;

            for (let row = 0; row < col.length; row++) {
                const s = col[row];
                if (s === symbol) {
                    positions.push({ reel: r, row });
                } else if (s === wildId) {
                    // Wild thay thế — không kiểm tra thêm vì feature symbols đã bị loại ở bước 1
                    positions.push({ reel: r, row });
                    hasWild = true;
                }
            }

            // Bước 4: Cột này = 0 → cắt streak
            if (positions.length === 0) break;

            reelHits.push({ count: positions.length, positions, hasWild });
        }

        // Bước 5: ≥ 3 cột mới tính
        const k = reelHits.length;
        if (k < 3) return null;

        const mult = paytable[symbol]?.[k - 3];
        if (!mult || mult <= 0) return null;

        // Công thức: ways = product of count per reel
        let ways         = 1;
        let containsWild = false;
        const cells: Array<{ reel: number; row: number }> = [];

        for (const hit of reelHits) {
            ways *= hit.count;
            if (hit.hasWild) containsWild = true;
            for (const p of hit.positions) cells.push(p);
        }

        // Enumerate all combinations (cartesian product of per-reel positions)
        const combinations = WaysPayCalculator._cartesian(reelHits.map(h => h.positions));

        return {
            symbolId:     symbol,
            reelCount:    k,
            ways,
            payout:       mult * ways * totalBet,
            containsWild,
            cells,
            combinations,
        };
    }

    /** Cartesian product: mỗi phần tử output là 1 array chọn 1 item từ mỗi group. */
    private static _cartesian<T>(groups: T[][]): T[][] {
        return groups.reduce<T[][]>(
            (acc, group) => acc.flatMap(combo => group.map(item => [...combo, item])),
            [[]]
        );
    }

    /** Tổng win của 1 spin. */
    static totalWin(wins: WaysPayWin[]): number {
        return wins.reduce((sum, w) => sum + w.payout, 0);
    }
}

