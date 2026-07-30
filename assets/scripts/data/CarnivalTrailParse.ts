/**
 * CarnivalTrailParse — helpers gắn Real API sau này.
 *
 * PS IDs (doc Carnival Neko):
 *   41 = Blue Trail
 *   42 = Green Trail
 *   43 = Red Trail
 *
 * Client luôn hiện TRAIL_NORMAL trên reel trước, rồi flip sang màu từ PS ID.
 * Khi USE_REAL_API = true, NetworkManager convert SpinResponse nên gọi:
 *   buildCarnivalTrailsFromGrid(clientGrid)
 * và gán vào SpinResponse.trails (+ potLevels từ server field khi có).
 */

import {
    CarnivalTrailHit,
    CarnivalPotLevels,
    SymbolId,
    TrailColor,
} from './SlotTypes';

const PS_TRAIL_TO_COLOR: Record<number, TrailColor> = {
    41: TrailColor.BLUE,
    42: TrailColor.GREEN,
    43: TrailColor.RED,
};

/** Client SymbolId đã map (TRAIL_*) → màu. */
export function trailSymbolToColor(symbolId: number): TrailColor | null {
    switch (symbolId) {
        case SymbolId.TRAIL_BLUE: return TrailColor.BLUE;
        case SymbolId.TRAIL_RED: return TrailColor.RED;
        case SymbolId.TRAIL_GREEN: return TrailColor.GREEN;
        default: return null;
    }
}

/**
 * Từ grid client (sau PS→client map): ô TRAIL_* → CarnivalTrailHit.
 * Ô TRAIL_NORMAL không có màu → bỏ (server phải gửi màu rõ).
 */
export function buildCarnivalTrailsFromGrid(grid: number[][]): CarnivalTrailHit[] {
    const hits: CarnivalTrailHit[] = [];
    for (let reel = 0; reel < grid.length; reel++) {
        const col = grid[reel] ?? [];
        for (let row = 0; row < col.length; row++) {
            const color = trailSymbolToColor(col[row]);
            if (color === null) continue;
            hits.push({ reel, row, color });
        }
    }
    return hits;
}

/** Map PS ID Trail → màu (dùng trước khi đổi ô grid sang TRAIL_NORMAL để display). */
export function trailColorFromPsId(psId: number): TrailColor | null {
    return PS_TRAIL_TO_COLOR[psId] ?? null;
}

export function emptyPotLevels(): CarnivalPotLevels {
    return { blue: 0, red: 0, green: 0 };
}
