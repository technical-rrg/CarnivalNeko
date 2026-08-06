/**
 * Matsuri Hold&Spin — helper lưới 5×N (N = 3|4|5).
 *
 * Index convention (cùng StickyOverlay / TopUpManager):
 *   visualIdx = reel * rowCount + row
 *   row 0 = Bottom … row (rowCount-1) = Top
 *
 * Server topupReel: row-major, apiRow 0 = visual Top:
 *   serverIdx = apiRow * 5 + reel
 *   apiRow = rowCount - 1 - row
 */

import { StickyCell, SymbolId, TopupReelSlot, TopupReelType } from './SlotTypes';

export const MATSURI_COL_COUNT = 5;
/**
 * Số Free Spin Matsuri lúc vào feature / khi Green land (reset).
 * ★ MOCK + client fallback dùng const này.
 * Real API: lấy RemainFeatureSpinCount / remainRespinCount từ response — không hardcode phía client.
 */
export const MATSURI_SPIN_COUNT = 3;
export const MATSURI_MIN_ROWS = 3;
export const MATSURI_MAX_ROWS = 5;

export function clampMatsuriRows(rows: number): number {
    const n = Math.floor(rows);
    if (n < MATSURI_MIN_ROWS) return MATSURI_MIN_ROWS;
    if (n > MATSURI_MAX_ROWS) return MATSURI_MAX_ROWS;
    return n;
}

/**
 * Scale root StickyOverlay (GridMiniReel + coin) theo số hàng.
 * Baseline = 5×3 (scale 1). 5×4 / 5×5 thu nhỏ nhẹ để vừa viewport.
 */
export function matsuriGridFitScale(rows: number): number {
    const r = clampMatsuriRows(rows);
    if (r <= MATSURI_MIN_ROWS) return 1;
    if (r === 4) return 0.85; // Mega — to hơn 0.75
    return 0.72;              // Super 5×5 — to hơn 0.6
}

/**
 * Hệ số chiều cao local của FillBlackFrame / mask theo số hàng
 * (trước khi root scale xuống). 5×3 = 1, 5×4 ≈ 1.33, 5×5 ≈ 1.67.
 */
export function matsuriGridFrameHeightMul(rows: number): number {
    return clampMatsuriRows(rows) / MATSURI_MIN_ROWS;
}

/**
 * Đẩy Y local StickyOverlay lên (px) theo số hàng.
 * 5×3 → 16, 5×4 → 52, 5×5 → 78.
 */
export function matsuriGridYOffset(rows: number): number {
    const r = clampMatsuriRows(rows);
    if (r <= MATSURI_MIN_ROWS) return 16;
    if (r === 4) return 152;
    return 178;
}

export function matsuriCellCount(rows: number): number {
    return MATSURI_COL_COUNT * clampMatsuriRows(rows);
}

export function matsuriVisualIdx(reel: number, row: number, rows: number): number {
    return reel * clampMatsuriRows(rows) + row;
}

export function matsuriVisualToServerIdx(visualIdx: number, rows: number): number {
    const r = clampMatsuriRows(rows);
    const col = Math.floor(visualIdx / r);
    const offset = visualIdx % r;
    const apiRow = r - 1 - offset;
    return apiRow * MATSURI_COL_COUNT + col;
}

export function matsuriServerToVisual(serverIdx: number, rows: number): { reel: number; row: number } {
    const r = clampMatsuriRows(rows);
    const apiRow = Math.floor(serverIdx / MATSURI_COL_COUNT);
    const reel = serverIdx % MATSURI_COL_COUNT;
    const row = r - 1 - apiRow;
    return { reel, row };
}

/** Gold Sticky trong Matsuri = STICKY_YELLOW (reuse art vàng hiện có). */
export const MATSURI_GOLD_SYMBOL = SymbolId.STICKY_YELLOW;

/** Hệ số credit × totalBet (giống mock TopUp) — tránh 0.1×0.01 bị round về 0. */
const MATSURI_CREDIT_MULTS: readonly number[] = [1, 1, 1, 2, 2, 3, 5, 5, 10, 25];

/**
 * Credit tiền cho 1 Gold/Green Matsuri.
 * totalBet mặc định mock = 0.01 → dùng bội số nguyên của bet, làm tròn 3 chữ số thập phân.
 */
export function pickMatsuriCredit(totalBet: number, rng: () => number = Math.random): number {
    const bet = totalBet > 0 ? totalBet : 0.01;
    const mult = MATSURI_CREDIT_MULTS[Math.floor(rng() * MATSURI_CREDIT_MULTS.length)];
    const raw = bet * mult;
    // 3 decimals: giữ được 0.01, 0.02… với coinValue nhỏ
    const credit = Math.round(raw * 1000) / 1000;
    return credit > 0 ? credit : bet;
}

/**
 * Chọn ngẫu nhiên vị trí Start Gold (không ghi stickyCells).
 * Dùng cho anim seed bay vào grid trước khi hiện coin.
 */
export function pickMatsuriStartCoinCells(
    rows: number,
    startCoins: number,
    totalBet: number,
    rng: () => number = Math.random,
): StickyCell[] {
    const r = clampMatsuriRows(rows);
    const total = matsuriCellCount(r);
    const count = Math.max(0, Math.min(startCoins, total));

    const keys: string[] = [];
    for (let reel = 0; reel < MATSURI_COL_COUNT; reel++) {
        for (let row = 0; row < r; row++) {
            keys.push(`${reel}-${row}`);
        }
    }
    for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
    }

    const placed: StickyCell[] = [];
    for (let i = 0; i < count; i++) {
        const [reelStr, rowStr] = keys[i].split('-');
        placed.push({
            reel: parseInt(reelStr, 10),
            row: parseInt(rowStr, 10),
            symbolId: MATSURI_GOLD_SYMBOL,
            credit: pickMatsuriCredit(totalBet, rng),
        });
    }
    return placed;
}

/**
 * Đặt ngẫu nhiên `startCoins` ô Gold vào stickyCells ngay (không anim).
 */
export function seedMatsuriStartCoins(
    stickyCells: Map<string, StickyCell>,
    rows: number,
    startCoins: number,
    totalBet: number,
): StickyCell[] {
    stickyCells.clear();
    const placed = pickMatsuriStartCoinCells(rows, startCoins, totalBet);
    for (const cell of placed) {
        stickyCells.set(`${cell.reel}-${cell.row}`, cell);
    }
    return placed;
}

/** Build topupReel (server order) từ sticky map + new green hits. */
export function buildMatsuriTopupReel(
    stickyCells: Map<string, StickyCell>,
    newGreens: StickyCell[],
    rows: number,
): TopupReelSlot[] {
    const r = clampMatsuriRows(rows);
    const n = matsuriCellCount(r);
    const greenKeys = new Set(newGreens.map((c) => `${c.reel}-${c.row}`));
    const greenMap = new Map(newGreens.map((c) => [`${c.reel}-${c.row}`, c]));

    const visual: TopupReelSlot[] = new Array(n);
    for (let reel = 0; reel < MATSURI_COL_COUNT; reel++) {
        for (let row = 0; row < r; row++) {
            const idx = matsuriVisualIdx(reel, row, r);
            const key = `${reel}-${row}`;
            if (greenKeys.has(key)) {
                const g = greenMap.get(key)!;
                visual[idx] = {
                    type: TopupReelType.GREEN,
                    win: g.credit ?? 0,
                    index: 0,
                };
            } else if (stickyCells.has(key)) {
                const c = stickyCells.get(key)!;
                visual[idx] = {
                    type: TopupReelType.YELLOW,
                    win: c.credit ?? 0,
                    index: 0,
                };
            } else {
                visual[idx] = {
                    type: TopupReelType.NONE,
                    win: 0,
                    index: Math.floor(Math.random() * 30),
                };
            }
        }
    }

    const server: TopupReelSlot[] = new Array(n);
    for (let i = 0; i < n; i++) {
        server[matsuriVisualToServerIdx(i, r)] = visual[i];
    }
    return server;
}
