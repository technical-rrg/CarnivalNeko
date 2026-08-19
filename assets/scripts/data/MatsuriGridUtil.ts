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

import { StickyCell, SymbolId, TopupReelSlot, TopupReelType, PS_TO_CLIENT } from './SlotTypes';
import { GameData } from './GameData';
import { Log } from '../core/Logger';

export const MATSURI_COL_COUNT = 5;
/**
 * Số Free Spin Matsuri lúc vào feature / khi có Green (reset về 3).
 * Real API: ưu tiên RemainFeatureSpinCount; Green land luôn reset 3 theo spec.
 */
export const MATSURI_SPIN_COUNT = 3;
export const MATSURI_MIN_ROWS = 3;
export const MATSURI_MAX_ROWS = 5;
/** @deprecated Baseline cũ 130px — dùng {@link matsuriCellSize}. */
export const MATSURI_CELL_SIZE = 130;

/** Ô grid Matsuri 5×4 / 5×5 (px). */
export const MATSURI_CELL_SIZE_DENSE = 126;
/** Ô grid Matsuri 5×3 (px). */
export const MATSURI_CELL_SIZE_LARGE = 182;

/** Tâm vùng grid (StickyOverlay local) — khớp node Rect5×N trên Prefab. */
export const MATSURI_RECT_CENTER: Readonly<Record<number, { x: number; y: number }>> = {
    5: { x: -0.5611111111111124, y: -32.91277777777777 },
    4: { x: -0.561, y: 29.893 },
    3: { x: 0, y: -11.132777777777779 },
};

/** Offset parent GridMiniReel / Array (StickyOverlay local). */
export const MATSURI_GRID_PARENT = {
    miniReel: { x: -230.843, y: 15.096 },
    array: { x: -7.473, y: -24.6605 },
} as const;

export function matsuriCellSize(rows?: number): number {
    return clampMatsuriRows(rows ?? MATSURI_MIN_ROWS) === MATSURI_MIN_ROWS
        ? MATSURI_CELL_SIZE_LARGE
        : MATSURI_CELL_SIZE_DENSE;
}

/** Tâm ô (col, poolRow) trong không gian StickyOverlay. poolRow 0 = hàng trên. */
export function matsuriGridCellCenter(rows: number, col: number, poolRow: number): { x: number; y: number } {
    const r = clampMatsuriRows(rows);
    const cell = matsuriCellSize(r);
    const rect = MATSURI_RECT_CENTER[r];
    const gridW = MATSURI_COL_COUNT * cell;
    const gridH = r * cell;
    return {
        x: rect.x - gridW * 0.5 + cell * 0.5 + col * cell,
        y: rect.y + gridH * 0.5 - cell * 0.5 - poolRow * cell,
    };
}

/** Local pos trong GridMiniReel hoặc Array. */
export function matsuriGridCellLocal(
    parent: keyof typeof MATSURI_GRID_PARENT,
    rows: number,
    col: number,
    poolRow: number,
): { x: number; y: number } {
    const center = matsuriGridCellCenter(rows, col, poolRow);
    const offset = MATSURI_GRID_PARENT[parent];
    return { x: center.x - offset.x, y: center.y - offset.y };
}

export function clampMatsuriRows(rows: number): number {
    const n = Math.floor(rows);
    if (n < MATSURI_MIN_ROWS) return MATSURI_MIN_ROWS;
    if (n > MATSURI_MAX_ROWS) return MATSURI_MAX_ROWS;
    return n;
}

/**
 * Scale root StickyOverlay — luôn 1.
 * Khung / grid đã trừ height + canh giữa theo số hàng, không thu nhỏ root nữa.
 */
export function matsuriGridFitScale(_rows?: number): number {
    return 1;
}

/**
 * Hệ số chiều cao local của FillBlackFrame / mask theo số hàng
 * (trước khi root scale xuống). 5×3 = 1, 5×4 ≈ 1.33, 5×5 ≈ 1.67.
 * @deprecated Prefab baseline đã là 5×5 — dùng matsuriGridFrameHeightShrink.
 */
export function matsuriGridFrameHeightMul(rows: number): number {
    return clampMatsuriRows(rows) / MATSURI_MIN_ROWS;
}

/**
     * Trừ height FrameFront / fill / mask từ baseline 5×5 (co từ mép dưới, mép trên đứng yên).
     * 5×5 → 0, 5×4 → 130, 5×3 → 260.
     */
export function matsuriGridFrameHeightShrink(rows: number): number {
    return MATSURI_CELL_SIZE * (MATSURI_MAX_ROWS - clampMatsuriRows(rows));
}

/**
 * Offset Y để pin mép trên khi co height node neo giữa.
 * 5×5 → 0, 5×4 → +65, 5×3 → +130.
 */
export function matsuriGridFrameTopPinY(rows: number): number {
    return matsuriGridFrameHeightShrink(rows) * 0.5;
}

/**
 * @deprecated Grid giữ vị trí prefab (hàng 0 = top). Dùng matsuriGridFrameTopPinY cho FrameFront.
 */
export function matsuriGridPrefabYShift(rows: number): number {
    return -matsuriGridFrameTopPinY(rows);
}

/**
 * Offset Y root StickyOverlay — canh giữa theo số hàng (size không đổi).
 * Pin-top hiện tại cao hơn tâm 5×5 đúng shrink/2 → dịch xuống:
 *   5×5 → 0, 5×4 → −65, 5×3 → −130.
 */
export function matsuriGridYOffset(rows?: number): number {
    return -matsuriGridFrameTopPinY(rows ?? MATSURI_MAX_ROWS);
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
 * Parse StarterCoins / NewStickies / AllStickies từ CNSpinResponse (V1.0.2).
 * Shape: [{ Reel, Row, Credit }] — Credit = PayoutRate × TotalBet (đã nhân sẵn).
 * Server Row 0 = top → visual row 0 = bottom.
 * MessagePack/C# có thể gửi tuple [Reel, Row, Credit] hoặc decimal object.
 */
function toPositiveNumber(v: any): number {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
    if (typeof v === 'string') {
        const n = Number(v.replace(',', '.'));
        return Number.isFinite(n) && n > 0 ? n : 0;
    }
    if (typeof v === 'object') {
        return toPositiveNumber(
            v.Value ?? v.value ?? v.Credit ?? v.credit ?? v.Win ?? v.win
            ?? v.Amount ?? v.amount ?? v.m ?? v.Val ?? v.val,
        );
    }
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parseCnStickyCredit(item: any, totalBet?: number): number {
    if (item == null) return 0;
    if (typeof item !== 'object') return toPositiveNumber(item);
    if (Array.isArray(item)) {
        // [Reel, Row, Credit] hoặc [Reel, Row, PayoutRate]
        const fromTuple = toPositiveNumber(item[2] ?? item[3]);
        if (fromTuple > 0) return fromTuple;
    }
    const nested = item.Sticky ?? item.sticky ?? item.Data ?? item.data ?? item.Coin ?? item.coin;
    const sources = [item, nested].filter((v) => v != null && typeof v === 'object' && !Array.isArray(v));
    const firstPositive = (keys: string[]): number => {
        for (const src of sources) {
            for (const key of keys) {
                const n = toPositiveNumber(src[key]);
                if (n > 0) return n;
            }
        }
        return 0;
    };
    const direct = firstPositive([
        'Credit', 'credit', 'Win', 'win', 'Val', 'val', 'Value', 'value',
        'Prize', 'prize', 'Payout', 'payout', 'Amount', 'amount',
        'Cash', 'cash', 'CoinValue', 'coinValue', 'StickyWin', 'stickyWin',
        'Item3', 'item3',
    ]);
    if (direct > 0) return direct;
    const rate = firstPositive([
        'PayoutRate', 'payoutRate', 'Rate', 'rate', 'Mul', 'mul',
        'Multiplier', 'multiplier', 'BetMul', 'betMul',
    ]);
    const bet = (Number.isFinite(totalBet) && (totalBet as number) > 0)
        ? (totalBet as number)
        : (GameData.instance?.totalBet ?? 0);
    if (rate > 0 && bet > 0) return rate * bet;
    return 0;
}

export function parseCnStickyCells(
    raw: any,
    featureRows: number,
    defaultSymbolId: number = MATSURI_GOLD_SYMBOL,
    totalBet?: number,
): StickyCell[] {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const rows = clampMatsuriRows(featureRows || 3);
    const out: StickyCell[] = [];
    for (const item of raw) {
        if (item == null) continue;
        let reel = NaN;
        let apiRow = NaN;
        if (Array.isArray(item)) {
            reel = Number(item[0]);
            apiRow = Number(item[1]);
        } else if (typeof item === 'object') {
            const hasReel = item.Reel != null || item.reel != null || item.Col != null || item.col != null
                || item.Column != null || item.Item1 != null;
            const hasRow = item.Row != null || item.row != null || item.Item2 != null;
            if (hasReel) {
                reel = Number(item.Reel ?? item.reel ?? item.Col ?? item.col ?? item.Column ?? item.Item1);
            }
            if (hasRow) {
                apiRow = Number(item.Row ?? item.row ?? item.Item2);
            }
            if (!Number.isFinite(reel) || !Number.isFinite(apiRow)) {
                const index = Number(item.Index ?? item.index ?? item.Slot ?? item.slot ?? item.Pos ?? item.pos);
                if (Number.isFinite(index) && index >= 0) {
                    const vis = matsuriServerToVisual(index, rows);
                    reel = vis.reel;
                    apiRow = rows - 1 - vis.row;
                }
            }
        } else if (typeof item === 'number' && Number.isFinite(item) && item >= 0) {
            const vis = matsuriServerToVisual(item, rows);
            reel = vis.reel;
            apiRow = rows - 1 - vis.row;
        }
        if (!Number.isFinite(reel) || !Number.isFinite(apiRow)) continue;
        const row = rows - 1 - apiRow;
        if (reel < 0 || reel >= MATSURI_COL_COUNT || row < 0 || row >= rows) continue;
        const credit = parseCnStickyCredit(item, totalBet);
        if (credit <= 0 && defaultSymbolId === SymbolId.STICKY_GREEN) {
            const keys = item && typeof item === 'object' && !Array.isArray(item)
                ? Object.keys(item).join(',')
                : Array.isArray(item) ? `tuple[${item.length}]` : typeof item;
            Log.e(`[GREEN-CREDIT][PARSE] col=${reel} row=${row} apiRow=${apiRow} credit=0 keys=${keys || 'none'} raw=${JSON.stringify(item)}`);
        }
        const psSym = (item && typeof item === 'object' && !Array.isArray(item))
            ? (item.SymbolId ?? item.symbolId ?? item.Symbol ?? item.PsId)
            : undefined;
        let symbolId = defaultSymbolId;
        if (psSym != null) {
            const mapped = PS_TO_CLIENT[Number(psSym)];
            if (mapped != null && mapped >= 0) symbolId = mapped;
        }
        out.push({ reel, row, symbolId, credit });
    }
    return out;
}

/**
 * Tìm Credit API cho 1 ô Green — đúng tọa độ (và row đảo nếu parser lệch).
 * Không lấy credit của ô khác / cột kề (tránh green nhảy chỗ).
 */
export function lookupCnStickyCredit(
    reel: number,
    row: number,
    rows: number,
    lists: Array<{ reel: number; row: number; credit?: number }[] | undefined>,
    allowUnique = true,
): number {
    const rCount = clampMatsuriRows(rows || 3);
    const altRow = rCount - 1 - row;
    const coords: Array<[number, number]> = [
        [reel, row],
        [reel, altRow],
    ];
    for (const list of lists) {
        if (!list?.length) continue;
        for (const [c, y] of coords) {
            if (c < 0 || c >= MATSURI_COL_COUNT) continue;
            for (const cell of list) {
                const credit = Math.max(0, cell.credit ?? 0);
                if (credit <= 0) continue;
                if (cell.reel === c && cell.row === y) return credit;
            }
        }
    }
    if (allowUnique) {
        const news = lists[0] ?? [];
        const hits = news.filter(c => (c.credit ?? 0) > 0);
        if (hits.length === 1) return hits[0].credit ?? 0;
    }
    return 0;
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
