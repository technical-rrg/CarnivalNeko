/**
 * ReelSymbolResolver - Chuyển đổi mảng Rands từ API /Spin → biểu tượng hiển thị trên lưới 5x3.
 *
 * ★ LOGIC TOÁN HỌC:
 *   Mỗi phần tử Rands[col] là INDEX (offset) vào mảng Reel.Strips[col].Symbols.
 *   Mảng strip là vòng tròn (circular), nên wrap-around bằng modulo.
 *
 *   Với centerIndex = Rands[col] và stripLen = Strips[col].Symbols.length:
 *     Top = Symbols[ (centerIndex - 1 + stripLen) % stripLen ]
 *     Mid = Symbols[ centerIndex % stripLen ]
 *     Bot = Symbols[ (centerIndex + 1) % stripLen ]
 *
 *   ⚠ (centerIndex - 1) có thể âm khi centerIndex=0 → phải cộng stripLen trước modulo.
 *
 * ★ SỬ DỤNG:
 *   - Gọi resolveGrid(rands, strips) để lấy grid 5x3
 *   - Gọi updateReelSprites(rands, strips, reelNodes) để cập nhật Sprite trực tiếp
 */

import { Node, Sprite } from 'cc';
import { SymbolManager } from './SymbolManager';
import { psToClientSymbol } from '../data/SlotTypes';
import { Log } from '../core/Logger';

// ═══════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════

/** 3 biểu tượng hiển thị của 1 cột: [Top, Mid, Bot] */
export interface ReelColumn {
    top: number;    // Symbol ID hàng trên
    mid: number;    // Symbol ID hàng giữa (= vị trí Rands trỏ tới)
    bot: number;    // Symbol ID hàng dưới
}

/** Lưới 5x3 hoàn chỉnh */
export type SymbolGrid = ReelColumn[];  // Length = 5 (5 cột)

// ═══════════════════════════════════════════════════════════
//  CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Tính 3 biểu tượng (Top, Mid, Bot) cho 1 cột dựa trên centerIndex.
 *
 * @param strip     Mảng Symbols của cột (từ PS: Reel.Strips[col].Symbols)
 * @param centerIdx Index trung tâm (= Rands[col] từ API /Spin)
 * @returns         ReelColumn { top, mid, bot }
 *
 * ★ TOÁN HỌC:
 *   stripLen = strip.length   (ví dụ: Reel 0 = 75, Reel 1 = 74...)
 *   top = strip[ (centerIdx - 1 + stripLen) % stripLen ]   ← wrap khi idx=0
 *   mid = strip[ centerIdx % stripLen ]                     ← vị trí chính
 *   bot = strip[ (centerIdx + 1) % stripLen ]               ← wrap khi idx=last
 */
export function getVisibleSymbols(strip: number[], centerIdx: number): ReelColumn {
    const len = strip.length;
    // Safety: đảm bảo centerIdx luôn >= 0 (phòng server trả giá trị lạ)
    const idx = ((centerIdx % len) + len) % len;
    return {
        top: strip[((idx - 1) + len) % len],
        mid: strip[idx],
        bot: strip[(idx + 1) % len],
    };
}

/**
 * Từ mảng Rands (5 phần tử) + ReelStrips → tính toàn bộ lưới 5×3.
 *
 * @param rands   Mảng 5 số nguyên từ API: Res.Rands
 * @param strips  Mảng 5 strips từ PS: Reel.Strips (hoặc FreeSpinReel.Strips)
 * @returns       SymbolGrid — mảng 5 ReelColumn
 *
 * ★ VÍ DỤ:
 *   rands = [13, 13, 18, 17, 16]
 *   strips = PS.Reel.Strips (mảng 5 phần tử, mỗi phần tử có .Symbols[])
 *
 *   Reel 0: strip[0].Symbols có 75 phần tử
 *     top = Symbols[(13-1+75)%75] = Symbols[12] = 3
 *     mid = Symbols[13%75]        = Symbols[13] = 4
 *     bot = Symbols[(13+1)%75]    = Symbols[14] = 12
 *
 *   Reel 1: strip[1].Symbols có 74 phần tử
 *     top = Symbols[(13-1+74)%74] = Symbols[12] = 4
 *     mid = Symbols[13%74]        = Symbols[13] = 4
 *     bot = Symbols[(13+1)%74]    = Symbols[14] = 3
 *
 *   → Mid line: [4, 4, 4, 1, 2]  ← 3 reels đầu match symbol 4
 */
export function resolveGrid(
    rands: number[],
    strips: { Symbols: number[] }[]
): SymbolGrid {
    const grid: SymbolGrid = [];
    for (let col = 0; col < rands.length; col++) {
        const strip = strips[col].Symbols;
        grid.push(getVisibleSymbols(strip, rands[col]));
    }
    return grid;
}

/**
 * Debug: In lưới 5x3 ra console dạng bảng.
 */
export function printGrid(grid: SymbolGrid): void {
    const rows = ['Top', 'Mid', 'Bot'];
    const getters: ((col: ReelColumn) => number)[] = [
        (c) => c.top,
        (c) => c.mid,
        (c) => c.bot,
    ];
    for (let r = 0; r < 3; r++) {
        const symbols = grid.map((col) => {
            const s = String(getters[r](col));
            return '   '.substring(s.length) + s;
        });
        // Log.d(`  ${rows[r]}: [${symbols.join(', ')}]`);
    }
}

// ═══════════════════════════════════════════════════════════
//  COCOS CREATOR INTEGRATION
// ═══════════════════════════════════════════════════════════

/**
 * Cập nhật SpriteFrame cho toàn bộ lưới 5x3 trên Cocos Creator.
 *
 * @param rands      Mảng Rands[5] từ server API
 * @param strips     Strips từ PS (Reel.Strips hoặc FreeSpinReel.Strips)
 * @param reelNodes  Mảng 5 Node, mỗi Node chứa 3 children:
 *                     reelNodes[col].children[0] = Top symbol node (có Sprite component)
 *                     reelNodes[col].children[1] = Mid symbol node
 *                     reelNodes[col].children[2] = Bot symbol node
 *
 * ★ CẤU TRÚC NODE TREE (Cocos Creator Scene):
 *   SlotMachine
 *   ├── Reel_0
 *   │   ├── Symbol_Top   (Sprite)
 *   │   ├── Symbol_Mid   (Sprite)
 *   │   └── Symbol_Bot   (Sprite)
 *   ├── Reel_1
 *   │   ├── Symbol_Top
 *   │   ├── Symbol_Mid
 *   │   └── Symbol_Bot
 *   └── ... (Reel_2, Reel_3, Reel_4)
 */
export async function updateReelSprites(
    rands: number[],
    strips: { Symbols: number[] }[],
    reelNodes: Node[]
): Promise<void> {
    const grid = resolveGrid(rands, strips);
    const symbolMgr = SymbolManager.instance;

    const tasks: Promise<void>[] = [];

    for (let col = 0; col < grid.length; col++) {
        const column = grid[col];
        const reelNode = reelNodes[col];
        if (!reelNode || reelNode.children.length < 3) {
            Log.w(`[ReelResolver] Reel node ${col} missing or has < 3 children`);
            continue;
        }

        const symbolIds = [column.top, column.mid, column.bot];
        for (let row = 0; row < 3; row++) {
            const psId = symbolIds[row];
            const targetNode = reelNode.children[row];
            const sprite = targetNode.getComponent(Sprite);

            if (!sprite) {
                Log.w(`[ReelResolver] No Sprite component on Reel_${col}/child[${row}]`);
                continue;
            }

            // PS ID → Client SymbolId → SpriteFrame (async, có cache)
            const task = symbolMgr.getSpriteFrameByPSId(psId).then((sf) => {
                if (sf) {
                    sprite.spriteFrame = sf;
                }
            });
            tasks.push(task);
        }
    }

    await Promise.all(tasks);
}

// ═══════════════════════════════════════════════════════════
//  VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════

/** Giới hạn hợp lệ của Rands cho từng reel (Normal Reel từ Server PS — SuperNova 3-reel) */
export const NORMAL_REEL_LENGTHS = [58, 44, 352];

/** Giới hạn hợp lệ của Rands cho FreeSpin Reel */
export const FREE_SPIN_REEL_LENGTHS = [44, 34, 300];

/** Giới hạn hợp lệ của Rands cho Purchase Reel */
export const PURCHASE_REEL_LENGTHS = [58, 44, 352];

/**
 * Kiểm tra Rands có hợp lệ không (trong giới hạn strip length).
 *
 * @param rands        Mảng 5 index từ server
 * @param reelLengths  Mảng 5 strip lengths (dùng NORMAL_REEL_LENGTHS, FREE_SPIN_REEL_LENGTHS, v.v.)
 * @returns            true nếu tất cả index đều >= 0 và < stripLength
 */
export function validateRands(rands: number[], reelLengths: number[]): boolean {
    if (rands.length !== reelLengths.length) return false;
    for (let i = 0; i < rands.length; i++) {
        if (rands[i] < 0 || rands[i] >= reelLengths[i]) {
            Log.w(`[ValidateRands] Reel ${i}: rand=${rands[i]} out of range [0, ${reelLengths[i] - 1}]`);
            return false;
        }
    }
    return true;
}
