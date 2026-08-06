/**
 * MockDataProvider — ★ Gold of Fortune (3×5, Ways Pay 243)
 *
 * Generate SpinResponse cho USE_REAL_API = false.
 * Hỗ trợ đầy đủ feature mới:
 *  - Wild Trail (reel 1/2/3), Sticky Red/Yellow/Green, +1 Spin
 *  - Long Spin trigger (3+ Red trên reel 0..3)
 *  - Feature Select (6+ Red trên grid)
 *  - Re-Spin (Top Up) — sticky lock, có thể +1 Spin
 *  - Free Spin (8 spin, yellow wild reel 1/2/3)
 *  - Pot Win + Pick Game (4 tier jackpot)
 */

import {
    SpinResponse,
    SlotStageType,
    SymbolId,
    StickyCell,
    PickGameState,
    WaysPayWin,
    MatchedLinePay,
    ServerSession,
    ServerEnterResponse,
    ServerJackpotResponse,
    ServerPickResponse,
    SelectFeatureResponse,
    ForceFeatureEntryData,
    pickForcedStickyValue,
    FEATURE_ENTRY_REQUIRED_STICKY,
    TrailColor,
    CarnivalTrailHit,
    CarnivalPotLevels,
    CarnivalFeatureKind,
    TopupReelType,
} from './SlotTypes';
import { INetworkAdapter } from '../manager/NetworkManager';
import { GameData } from './GameData';
import { WaysPayCalculator } from './WaysPayCalculator';
import { Log } from '../core/Logger';
import {
    MOCK_FORCE_CARNIVAL_TRAILS,
    MOCK_CARNIVAL_TRAIL_COUNT_MIN,
    MOCK_CARNIVAL_TRAIL_COUNT_MAX,
    MOCK_PICK_GAME_MODE,
    MockPickGameMode,
} from './ServerConfig';
import { PICK_GAME_CELL_COUNT } from './PickGameUtil';
import { resolveMockCarnivalFeature } from './CarnivalFeatureResolve';
import {
    MATSURI_COL_COUNT,
    MATSURI_SPIN_COUNT,
    buildMatsuriTopupReel,
    clampMatsuriRows,
    matsuriCellCount,
    pickMatsuriCredit,
} from './MatsuriGridUtil';

export class MockDataProvider {

    /** Đã retrigger free spin trong session hiện tại chưa? */
    static _freeSpinRetriggered: boolean = false;

    static resetFreeSpinState(): void {
        MockDataProvider._freeSpinRetriggered = false;
    }

    // ═══════════════════════════════════════════════════════════
    //  PUBLIC API — generate response theo current mode
    // ═══════════════════════════════════════════════════════════

    static generateSpinResponse(_isFreeSpin: boolean = false): SpinResponse {
        const data = GameData.instance;
        const mode = data.currentMode;

        if (mode === 'respin')                     return MockDataProvider._generateRespin();
        if (mode === 'matsuri')                    return MockDataProvider._generateMatsuri();
        if (mode === 'freespin' || mode === 'freespin_gold') return MockDataProvider._generateFreeSpin();
        return MockDataProvider._generateNormal();
    }

    // ═══════════════════════════════════════════════════════════
    //  NORMAL SPIN
    // ═══════════════════════════════════════════════════════════

    private static _generateNormal(): SpinResponse {
        const data = GameData.instance;
        const totalBet = data.totalBet;
        const strips = data.getReelStrips(false);

        let rands = strips.map((s) => Math.floor(Math.random() * s.length));
        let trails: CarnivalTrailHit[] | undefined;
        let potLevels: CarnivalPotLevels | undefined;
        let carnivalFeature = undefined as ReturnType<typeof resolveMockCarnivalFeature>;

        // ★ Carnival Neko: force land Trail Normal → flip màu (mock)
        if (MOCK_FORCE_CARNIVAL_TRAILS) {
            const forced = MockDataProvider._forceCarnivalTrailRands(strips);
            rands = forced.rands;
            trails = forced.trails;
            potLevels = MockDataProvider._applyCarnivalPotGrowth(trails);
            data.potLevels = { ...potLevels };
            data.pendingTrails = trails;
            carnivalFeature = resolveMockCarnivalFeature(trails);
        }

        const grid = data.getBaseGrid(rands, false);

        Log.e(
            `[MockDataProvider] _generateNormal()\n` +
            `  rands=[${rands.join(',')}]\n` +
            `  trails: ${(trails ?? []).map(t => `r${t.reel}row${t.row}→${TrailColor[t.color]}`).join(', ') || '(none)'}\n` +
            `  feature: ${carnivalFeature ? `${carnivalFeature.featureName} (${CarnivalFeatureKind[carnivalFeature.kind]})` : '(none)'}`
        );

        const { redCount, redReels, wildTrailCount } = MockDataProvider._countSpecials(grid);

        const waysPayWins = WaysPayCalculator.calculate(grid, totalBet);
        let totalWin = WaysPayCalculator.totalWin(waysPayWins);

        let stickyCells: StickyCell[] = redCount > 0
            ? MockDataProvider._buildRedStickies(grid, totalBet)
            : [];
        let nextStage = SlotStageType.SPIN;

        // Khi đang test Carnival Trail — bỏ Feature Select / Pot Win GoF để không chen flow
        if (!MOCK_FORCE_CARNIVAL_TRAILS && redCount >= 6) {
            nextStage = SlotStageType.FEATURE_SELECT_START;
        }

        let potVisualLevel = data.potLevel;
        if (!MOCK_FORCE_CARNIVAL_TRAILS && nextStage === SlotStageType.SPIN && wildTrailCount > 0) {
            data.wildTrailCount += wildTrailCount;
            const thresholds = data.config?.potLevelThresholds ?? [1, 11, 31, 51, 81, 101];
            let lvl = 0;
            for (let i = 0; i < thresholds.length; i++) {
                if (data.wildTrailCount >= thresholds[i]) lvl = i + 1;
            }
            potVisualLevel = Math.min(6, lvl);
        }

        let triggerPotWin = false;
        let pickGame: PickGameState | undefined;
        if (!MOCK_FORCE_CARNIVAL_TRAILS && nextStage === SlotStageType.SPIN && potVisualLevel >= 6) {
            triggerPotWin = true;
            pickGame = MockDataProvider.buildPickGame();
            nextStage = SlotStageType.POT_WIN;
        }

        // ★ Carnival Feature Trigger → nextStage
        if (carnivalFeature) {
            if (carnivalFeature.jackpotFirst) {
                triggerPotWin = true;
                pickGame = MockDataProvider.buildPickGame();
                nextStage = SlotStageType.POT_WIN;
                // Combo: Matsuri chạy sau Pick
                if (carnivalFeature.matsuriRows > 0) {
                    data.pendingCarnivalMatsuri = carnivalFeature;
                } else {
                    data.pendingCarnivalMatsuri = null;
                }
            } else {
                data.pendingCarnivalMatsuri = null;
                nextStage = SlotStageType.CARNIVAL_MATSURI_START;
            }
        }

        const updateCash = true;
        const remainCash = data.player.balance - totalBet + totalWin;
        const winGrade = MockDataProvider._getWinGrade(totalWin, totalBet);

        return {
            rands,
            waysPayWins,
            matchedLinePays: MockDataProvider._toLegacyLinePays(waysPayWins),
            totalBet,
            totalWin,
            updateCash,
            nextStage,
            reelIndex: 0,
            remainCash,
            winGrade,
            redCount,
            redReels,
            stickyCells,
            wildTrailCount: MOCK_FORCE_CARNIVAL_TRAILS ? 0 : wildTrailCount,
            potVisualLevel: MOCK_FORCE_CARNIVAL_TRAILS ? data.potLevel : potVisualLevel,
            triggerPotWin,
            pickGame,
            trails,
            potLevels,
            carnivalFeature: carnivalFeature ?? undefined,
        };
    }

    /**
     * Chọn rands sao cho mỗi Trail land đúng ô TRAIL_NORMAL trên strip.
     * Mỗi hit gán random Blue/Red/Green (để flip).
     */
    private static _forceCarnivalTrailRands(strips: number[][]): {
        rands: number[];
        trails: CarnivalTrailHit[];
    } {
        const reelCount = strips.length;
        const rowCount = 3;
        const rands = strips.map((s) => Math.floor(Math.random() * Math.max(1, s.length)));
        const trails: CarnivalTrailHit[] = [];
        const used = new Set<string>();

        const min = Math.max(1, MOCK_CARNIVAL_TRAIL_COUNT_MIN);
        const max = Math.max(min, MOCK_CARNIVAL_TRAIL_COUNT_MAX);
        const want = min + Math.floor(Math.random() * (max - min + 1));

        const colors = [TrailColor.BLUE, TrailColor.RED, TrailColor.GREEN];
        // Round-robin màu để luôn thấy đủ 3 Pot khi test
        let colorIdx = 0;

        const candidates: Array<{ reel: number; row: number; center: number }> = [];
        for (let reel = 0; reel < reelCount; reel++) {
            const strip = strips[reel] ?? [];
            for (let i = 0; i < strip.length; i++) {
                if (strip[i] !== SymbolId.TRAIL_NORMAL) continue;
                // TN ở strip[i] có thể hiện ở top/mid/bot tùy center
                // row0(top)=center-1 → center=i+1; row1=i; row2=i-1
                for (const row of [0, 1, 2]) {
                    let center = i;
                    if (row === 0) center = i + 1;
                    else if (row === 2) center = i - 1;
                    const len = strip.length;
                    center = ((center % len) + len) % len;
                    candidates.push({ reel, row, center });
                }
            }
        }

        // Shuffle nhẹ
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = candidates[i];
            candidates[i] = candidates[j];
            candidates[j] = tmp;
        }

        for (const c of candidates) {
            if (trails.length >= want) break;
            const key = `${c.reel}-${c.row}`;
            if (used.has(key)) continue;
            // Một reel một centerIndex — nếu đã set rand khác cho reel, chỉ thêm trail
            // cùng center (các row khác cùng stop). Nếu conflict center → skip.
            const existing = trails.find(t => t.reel === c.reel);
            if (existing) {
                // Cùng reel phải cùng rands[reel]
                if (rands[c.reel] !== c.center) continue;
            } else {
                rands[c.reel] = c.center;
            }
            used.add(key);
            trails.push({
                reel: c.reel,
                row: c.row,
                color: colors[colorIdx % colors.length],
            });
            colorIdx++;
        }

        // Fallback: nếu strip thiếu TN, vẫn trả 1 trail mid reel 2 (visual sẽ setSymbol override)
        if (trails.length === 0) {
            trails.push({ reel: 2, row: 1, color: TrailColor.RED });
        }

        return { rands, trails };
    }

    /** Growth condition_2 đơn giản: mỗi Trail +1 accumulated; tier theo ngưỡng design. */
    private static _applyCarnivalPotGrowth(trails: CarnivalTrailHit[]): CarnivalPotLevels {
        const data = GameData.instance;
        // Design doc: 10,20,40,... — mock dùng step nhỏ để thấy level lên nhanh khi test
        const mockThresholds = [1, 2, 3, 5, 7, 9, 12, 15, 18, 22];

        for (const t of trails) {
            if (t.color === TrailColor.BLUE) data.trailAccumulated.blue += 1;
            else if (t.color === TrailColor.RED) data.trailAccumulated.red += 1;
            else data.trailAccumulated.green += 1;
        }

        const tierOf = (acc: number): number => {
            let lvl = 0;
            for (let i = 0; i < mockThresholds.length; i++) {
                if (acc >= mockThresholds[i]) lvl = i + 1;
            }
            return Math.min(10, lvl);
        };

        return {
            blue: tierOf(data.trailAccumulated.blue),
            red: tierOf(data.trailAccumulated.red),
            green: tierOf(data.trailAccumulated.green),
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  RE-SPIN (TOP UP)
    // ═══════════════════════════════════════════════════════════

    private static _generateRespin(): SpinResponse {
        const data = GameData.instance;
        const totalBet = data.totalBet;
        // Reel dùng normal strips khi TopUp (chỉ StickyOverlay hiển thị coin)
        // → rands phải là index hợp lệ cho normal strips
        const normalStrips = data.config.reelStrips;
        const rands = normalStrips.map((s) => Math.floor(Math.random() * s.length));

        const stickyMap = data.stickyCells;
        const newStickies: StickyCell[] = [];
        const reelCount = data.config.reelCount;
        const rowCount = data.config.rowCount;
        const grid: number[][] = [];

        let plusOneSpin = 0;
        let yellowSum = 0;
        let greenSum = 0;
        const baseCredit = data.featureBaseCredit;

        for (let r = 0; r < reelCount; r++) {
            const col: number[] = [];
            const strip = normalStrips[r] ?? [];
            const center = rands[r];
            const len = strip.length || 1;

            for (let row = 0; row < rowCount; row++) {
                const key = `${r}-${row}`;
                if (stickyMap.has(key)) {
                    col.push(stickyMap.get(key)!.symbolId);
                    continue;
                }

                // Random spawn cho ô trống
                // ★ TopUp KHÔNG sinh đồng đỏ mới — chỉ Yellow, Green, +1 Spin
                let s: number;
                const roll = Math.random();
                if (roll < 0.18) {
                    s = SymbolId.STICKY_YELLOW;
                } else if (roll < 0.32) {
                    s = SymbolId.STICKY_GREEN;
                } else if (roll < 0.38) {
                    s = SymbolId.PLUS_ONE_SPIN;
                } else {
                    // Empty filler — lấy từ strip (normal symbol, không phải coin)
                    s = strip[((center + row - 1) % len + len) % len];
                }
                col.push(s);

                if (s === SymbolId.STICKY_YELLOW) {
                    // Yellow hút TẤT CẢ đồng Đỏ hiện tại trên màn hình (copy, không trừ)
                    const redSum = MockDataProvider._sumCreditBySymbol(stickyMap, SymbolId.STICKY_RED);
                    const credit = redSum;
                    yellowSum += credit;
                    newStickies.push({ reel: r, row, symbolId: s, credit });
                } else if (s === SymbolId.STICKY_GREEN) {
                    // Green hút TẤT CẢ: Red + Yellow (đã tính) + Green khác
                    // Tính sum toàn bộ coin trên lưới (cũ + mới trước nó)
                    const redSum = MockDataProvider._sumCreditBySymbol(stickyMap, SymbolId.STICKY_RED);
                    const credit = redSum + yellowSum + greenSum;
                    greenSum += credit;
                    newStickies.push({ reel: r, row, symbolId: s, credit });
                } else if (s === SymbolId.PLUS_ONE_SPIN) {
                    plusOneSpin++;
                    // +1 Spin cũng được thêm vào stickyCells để TopUpAbsorbEffect biết vị trí
                    newStickies.push({ reel: r, row, symbolId: s, credit: 0 });
                }
            }
            grid.push(col);
        }

        // TopUp không spawn Red mới → totalWin = yellowSum + greenSum
        let totalWin = yellowSum + greenSum;

        // GM đã −1 trước request → cộng +1 Spin (nếu có), không trừ thêm lần nữa
        let remainRespinCount = Math.max(0, data.respinRemaining) + plusOneSpin;

        // +1 Spin không sticky — chỉ đếm Yellow/Green mới cho fullGrid check
        const newStickyCount = newStickies.filter(c => c.symbolId !== SymbolId.PLUS_ONE_SPIN).length;
        const allStickyCount = stickyMap.size + newStickyCount;
        const fullGrid = allStickyCount >= reelCount * rowCount;
        if (fullGrid) {
            const grand = (data.config.jackpotMultipliers?.GRAND ?? 1000);
            totalWin += grand * totalBet;
        }

        // Hết lượt → END ngay; full grid cũng END (Grand). Không bắt buộc full mới kết thúc.
        let nextStage: number;
        if (fullGrid || remainRespinCount <= 0) {
            nextStage = SlotStageType.TOPUP_SPIN_END;
            remainRespinCount = 0;
        } else {
            nextStage = SlotStageType.TOPUP_SPIN;
        }

        return {
            rands,
            waysPayWins: [],
            matchedLinePays: [],
            totalBet,
            totalWin,
            updateCash: false,
            nextStage,
            reelIndex: 3,
            remainCash: data.player.balance + totalWin,
            stickyCells: newStickies,
            remainRespinCount,
            featureSpinTotalWin: data.respinTotalWin + totalWin,
            winGrade: MockDataProvider._getWinGrade(totalWin, totalBet),
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  MATSURI HOLD & SPIN (5×3|4|5) — ★ MOCK tạm
    //  Client chỉ tin field API: remainRespinCount / nextStage / stickyCells / topupReel.
    //  Khi USE_REAL_API=true: bỏ qua hàm này — NetworkManager parse RemainFeatureSpinCount.
    // ═══════════════════════════════════════════════════════════

    private static _generateMatsuri(): SpinResponse {
        const data = GameData.instance;
        const totalBet = data.totalBet;
        const rows = clampMatsuriRows(data.matsuriRows || 3);
        const cellCount = matsuriCellCount(rows);
        const stickyMap = data.stickyCells;
        const newGreens: StickyCell[] = [];
        let landedGreen = false;

        // ★ MOCK spawn Green (~10% / ô trống). Real API: Green đến từ TopupReel server.
        for (let reel = 0; reel < MATSURI_COL_COUNT; reel++) {
            for (let row = 0; row < rows; row++) {
                const key = `${reel}-${row}`;
                if (stickyMap.has(key)) continue;
                if (Math.random() >= 0.10) continue;
                const credit = pickMatsuriCredit(totalBet);
                landedGreen = true;
                newGreens.push({
                    reel,
                    row,
                    symbolId: SymbolId.STICKY_GREEN,
                    credit,
                });
            }
        }

        const topupReel = buildMatsuriTopupReel(stickyMap, newGreens, rows);

        // ★ remainRespinCount = field API (mock gán tạm, client chỉ đọc resp.remainRespinCount)
        // Design Matsuri: mỗi spin GM đã −1 trước request;
        //   • không Green → giữ remain hiện tại (có thể 2→1→0 rồi END)
        //   • có Green  → RESET về 3  ← đây là lý do UI thấy 3→2 rồi lại lên 3
        const remainBefore = Math.max(0, data.respinRemaining);
        let remainRespinCount = landedGreen ? MATSURI_SPIN_COUNT : remainBefore;

        // Design: khi có Green → acquire tổng Credit của mọi Gold đang trên grid (+ Grand nếu full)
        let collectWin = 0;
        if (landedGreen) {
            for (const c of stickyMap.values()) {
                if (c.symbolId === SymbolId.STICKY_YELLOW && (c.credit ?? 0) > 0) {
                    collectWin += c.credit ?? 0;
                }
            }
        }

        const filledAfter = stickyMap.size + newGreens.length;
        const fullGrid = filledAfter >= cellCount;
        if (fullGrid) {
            const grandMult = data.config.jackpotMultipliers?.GRAND ?? 1000;
            collectWin += grandMult * totalBet;
            remainRespinCount = 0;
            Log.e(`[Matsuri MOCK] FULL GRID 5×${rows} → Grand + end`);
        }

        const spinWin = collectWin;
        const nextStage = (fullGrid || remainRespinCount <= 0)
            ? SlotStageType.TOPUP_SPIN_END
            : SlotStageType.TOPUP_SPIN;

        // rands dummy (TopUp/Matsuri không dùng main strip)
        const normalStrips = data.config.reelStrips;
        const rands = normalStrips.map((s) => Math.floor(Math.random() * (s.length || 1)));

        Log.e(
            `[Matsuri MOCK] rows=${rows} newGreen=${newGreens.length} filled=${filledAfter}/${cellCount}` +
            ` remain ${remainBefore}→${remainRespinCount}` +
            `${landedGreen ? ' (GREEN reset→3)' : ''}` +
            ` collect=${spinWin} next=${nextStage}`
        );

        return {
            rands,
            waysPayWins: [],
            matchedLinePays: [],
            totalBet,
            totalWin: spinWin,
            updateCash: false,
            nextStage,
            reelIndex: 3,
            remainCash: data.player.balance + spinWin,
            stickyCells: newGreens,
            remainRespinCount,
            featureSpinTotalWin: data.respinTotalWin + spinWin,
            topupReel,
            winGrade: MockDataProvider._getWinGrade(spinWin, totalBet),
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  FREE SPIN (8 spin, yellow wild trên reel 1/2/3)
    // ═══════════════════════════════════════════════════════════

    private static _generateFreeSpin(): SpinResponse {
        const data = GameData.instance;
        const totalBet = data.totalBet;
        const strips = data.getReelStrips(true);
        const rands = strips.map((s) => Math.floor(Math.random() * s.length));
        const grid = data.getGrid(rands, true);

        // Dùng isFreeSpin=true → WaysPayCalculator dùng STICKY_YELLOW làm Wild
        const waysPayWins = WaysPayCalculator.calculate(grid, totalBet, true);
        const payWin = WaysPayCalculator.totalWin(waysPayWins);

        // Tính tổng credit Yellow trong spin này
        let yellowAccum = 0;
        const yellowCells: StickyCell[] = [];
        for (let r = 0; r < grid.length; r++) {
            for (let row = 0; row < grid[r].length; row++) {
                if (grid[r][row] === SymbolId.STICKY_YELLOW) {
                    const credit = data.featureBaseCredit;
                    yellowAccum += credit;
                    yellowCells.push({ reel: r, row, symbolId: SymbolId.STICKY_YELLOW, credit });
                }
            }
        }

        const totalWin = payWin + yellowAccum;

        const remaining = data.freeSpinRemaining - 1;
        const nextStage = remaining <= 0 ? SlotStageType.FREE_SPIN_END : SlotStageType.FREE_SPIN;

        return {
            rands,
            waysPayWins,
            matchedLinePays: MockDataProvider._toLegacyLinePays(waysPayWins),
            totalBet,
            totalWin,
            updateCash: false,
            nextStage,
            reelIndex: 1,
            remainCash: data.player.balance + totalWin,
            remainFreeSpinCount: Math.max(0, remaining),
            stickyCells: yellowCells,
            winGrade: MockDataProvider._getWinGrade(totalWin, totalBet),
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════

    private static _countSpecials(grid: number[][]) {
        let redCount = 0;
        let wildTrailCount = 0;
        const redReelsSet = new Set<number>();
        for (let r = 0; r < grid.length; r++) {
            for (let row = 0; row < grid[r].length; row++) {
                const s = grid[r][row];
                if (s === SymbolId.STICKY_RED) {
                    redCount++;
                    redReelsSet.add(r);
                } else if (s === SymbolId.WILD) {
                    wildTrailCount++;
                }
            }
        }
        return { redCount, redReels: Array.from(redReelsSet).sort(), wildTrailCount };
    }

    private static _buildFeatureTriggerRands(strips: number[][], minRedCount: number): number[] {
        const picks = strips.map((strip) => {
            if (strip.length === 0) return { center: 0, redCount: 0, maxCenter: 0, maxRedCount: 0 };

            let singleCenter = -1;
            let maxCenter = 0;
            let maxRedCount = -1;
            let maxHasMidRed = false;

            for (let center = 0; center < strip.length; center++) {
                const len = strip.length;
                const visible = [
                    strip[((center - 1) % len + len) % len],
                    strip[center],
                    strip[(center + 1) % len],
                ];
                const redCount = visible.filter(s => s === SymbolId.STICKY_RED).length;
                const hasMidRed = strip[center] === SymbolId.STICKY_RED;

                if (redCount === 1 && hasMidRed && singleCenter < 0) {
                    singleCenter = center;
                }
                if (redCount > maxRedCount || (redCount === maxRedCount && hasMidRed && !maxHasMidRed)) {
                    maxCenter = center;
                    maxRedCount = redCount;
                    maxHasMidRed = hasMidRed;
                }
            }

            const center = singleCenter >= 0 ? singleCenter : maxCenter;
            const redCount = singleCenter >= 0 ? 1 : maxRedCount;
            return { center, redCount, maxCenter, maxRedCount };
        });

        let totalReds = picks.reduce((sum, pick) => sum + pick.redCount, 0);
        while (totalReds < minRedCount) {
            let bestIndex = -1;
            let bestGain = 0;
            for (let i = 0; i < picks.length; i++) {
                const gain = picks[i].maxRedCount - picks[i].redCount;
                if (gain > bestGain) {
                    bestGain = gain;
                    bestIndex = i;
                }
            }
            if (bestIndex < 0) break;
            picks[bestIndex].center = picks[bestIndex].maxCenter;
            picks[bestIndex].redCount = picks[bestIndex].maxRedCount;
            totalReds += bestGain;
        }

        if (totalReds < minRedCount) {
            console.warn(`[MockDataProvider] Feature trigger rands only produce ${totalReds}/${minRedCount} real reds. Check DEFAULT_REEL_STRIPS red adjacency.`);
        }
        return picks.map(pick => pick.center);
    }

    private static _buildRedStickies(grid: number[][], totalBet: number): StickyCell[] {
        const out: StickyCell[] = [];
        for (let r = 0; r < grid.length; r++) {
            for (let row = 0; row < grid[r].length; row++) {
                if (grid[r][row] === SymbolId.STICKY_RED) {
                    out.push({
                        reel: r, row, symbolId: SymbolId.STICKY_RED,
                        credit: MockDataProvider._randomCredit(totalBet),
                    });
                }
            }
        }
        return out;
    }

    private static _randomCredit(totalBet: number): number {
        const options = [1, 1, 1, 2, 2, 3, 5, 5, 10, 25];
        return totalBet * options[Math.floor(Math.random() * options.length)];
    }

    /** Tính tổng credit của 1 loại symbol trên stickyCells map */
    private static _sumCreditBySymbol(cells: Map<string, StickyCell>, symbolId: number): number {
        let sum = 0;
        for (const cell of cells.values()) {
            if (cell.symbolId === symbolId) sum += cell.credit;
        }
        return sum;
    }

    /**
     * Carnival Pick Game 5×3 = 15 ô.
     * Grid prefill (mock); real API chỉ lộ từng ô khi /Pick.
     * Mode lấy từ MOCK_PICK_GAME_MODE — có thể override qua tham số.
     */
    public static buildPickGame(mode?: MockPickGameMode): PickGameState {
        const m = mode ?? MOCK_PICK_GAME_MODE;
        const tierToSym: Record<string, number> = {
            GRAND: SymbolId.JP_GRAND,
            MAJOR: SymbolId.JP_MAJOR,
            MINOR: SymbolId.JP_MINOR,
            MINI:  SymbolId.JP_MINI,
        };

        let matchTier: 'GRAND' | 'MAJOR' | 'MINOR' | 'MINI' = 'MINI';
        let paidTier: 'GRAND' | 'MAJOR' | 'MINOR' | 'MINI' = 'MINI';
        let withUpgrade = false;

        switch (m) {
            case 'plain_mini':
                matchTier = 'MINI';
                paidTier = 'MINI';
                break;
            case 'upgrade_to_major':
                matchTier = 'MINOR';
                paidTier = 'MAJOR';
                withUpgrade = true;
                break;
            case 'upgrade_grand_x2':
                matchTier = 'GRAND';
                paidTier = 'GRAND';
                withUpgrade = true;
                break;
            case 'random':
            default: {
                const tiers: Array<'GRAND' | 'MAJOR' | 'MINOR' | 'MINI'> =
                    ['MINI', 'MINI', 'MINOR', 'MINOR', 'MAJOR', 'GRAND'];
                matchTier = tiers[Math.floor(Math.random() * tiers.length)];
                withUpgrade = Math.random() < 0.35;
                if (withUpgrade) {
                    if (matchTier === 'MINI') paidTier = 'MINOR';
                    else if (matchTier === 'MINOR') paidTier = 'MAJOR';
                    else if (matchTier === 'MAJOR') paidTier = 'GRAND';
                    else paidTier = 'GRAND';
                } else {
                    paidTier = matchTier;
                }
                break;
            }
        }

        const winSym = tierToSym[matchTier];
        const grid: number[] = [winSym, winSym, winSym];
        if (withUpgrade) {
            grid.push(SymbolId.JP_UPGRADE, SymbolId.JP_UPGRADE, SymbolId.JP_UPGRADE);
        }
        for (const t of ['GRAND', 'MAJOR', 'MINOR', 'MINI'] as const) {
            if (t === matchTier) continue;
            // Mỗi tier còn lại tối đa 2 (tránh match sớm tier khác)
            grid.push(tierToSym[t], tierToSym[t]);
        }
        // Pad đủ 15 ô — không cho tier JP nào khác winSym đạt 3; dư thì thêm winSym
        const countOf = (sym: number) => grid.reduce((n, s) => n + (s === sym ? 1 : 0), 0);
        const padPool = [
            SymbolId.JP_GRAND, SymbolId.JP_MAJOR, SymbolId.JP_MINOR, SymbolId.JP_MINI,
        ].filter((s) => s !== winSym);
        while (grid.length < PICK_GAME_CELL_COUNT) {
            const candidates = padPool.filter((s) => countOf(s) < 2);
            grid.push(candidates.length > 0
                ? candidates[grid.length % candidates.length]
                : winSym);
        }
        grid.length = PICK_GAME_CELL_COUNT;

        for (let i = grid.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [grid[i], grid[j]] = [grid[j], grid[i]];
        }

        Log.e(`[MockPick] buildPickGame mode=${m} match=${matchTier} paid=${paidTier} upgrade=${withUpgrade} cells=${grid.length}`);
        return {
            grid,
            revealed: [],
            wonTier: paidTier,
            upgradeArmed: false,
            upgradeCount: 0,
            doubleGrand: withUpgrade && matchTier === 'GRAND',
        };
    }

    private static _getWinGrade(totalWin: number, totalBet: number): string | undefined {
        if (totalWin <= 0) return undefined;
        const cfg = GameData.instance.config;
        const r = totalWin / totalBet;
        if (r >= cfg.maxWinThreshold)     return 'Max';
        if (r >= cfg.monsterWinThreshold) return 'Monster';
        if (r >= cfg.ultraWinThreshold)   return 'Ultra';
        if (r >= cfg.epicWinThreshold)    return 'Epic';
        if (r >= cfg.superWinThreshold)   return 'Super';
        if (r >= cfg.majorWinThreshold)   return 'Major';
        if (r >= cfg.megaWinThreshold)    return 'Mega';
        if (r >= cfg.bigWinThreshold)     return 'Big';
        return 'Normal';
    }

    /** Convert WaysPayWin[] → MatchedLinePay[] để code legacy còn dùng được. */
    private static _toLegacyLinePays(wins: WaysPayWin[]): MatchedLinePay[] {
        return wins.map((w, i) => ({
            payLineIndex: i,
            payout: w.payout,
            matchedSymbols: w.cells.map(() => w.symbolId),
            containsWild: w.containsWild,
            reelCnt: w.reelCount,
            matchedSymbolsIndices: w.cells.map((c) => ({ Item1: c.reel, Item2: c.row })),
        }));
    }

    // ═══════════════════════════════════════════════════════════
    //  FORCED SCENARIOS — test UI/animation
    // ═══════════════════════════════════════════════════════════

    static buildScenario(scenario: TestScenario): SpinResponse {
        const data = GameData.instance;
        const totalBet = data.totalBet;

        const enrich = (resp: SpinResponse): SpinResponse => {
            resp.remainCash = resp.updateCash
                ? data.player.balance - resp.totalBet + resp.totalWin
                : data.player.balance + resp.totalWin;
            resp.winGrade = MockDataProvider._getWinGrade(resp.totalWin, resp.totalBet);
            return resp;
        };

        /**
         * Tìm rand sao cho strip[rand] = targetSymbol (mid row = target).
         * Trả về index đầu tiên tìm thấy, hoặc fallback=0.
         */
        const findMidRand = (strip: number[], targetSymbol: number): number => {
            const idx = strip.indexOf(targetSymbol);
            return idx >= 0 ? idx : 0;
        };

        /**
         * Tìm rand sao cho KHÔNG có targetSymbol trong cửa sổ 3 hàng [top, mid, bot].
         * Đảm bảo streak Ways Pay bị cắt tại reel này.
         */
        const findNoSymbolRand = (strip: number[], targetSymbol: number): number => {
            const len = strip.length;
            for (let i = 0; i < len; i++) {
                const top = strip[((i - 1) % len + len) % len];
                const mid = strip[i];
                const bot = strip[(i + 1) % len];
                if (top !== targetSymbol && mid !== targetSymbol && bot !== targetSymbol) return i;
            }
            return 0;
        };

        switch (scenario) {
            case TestScenario.NORMAL_WIN: {
                // Cleopatra 3-reel win: tìm rand thực trên strip → grid nhất quán với visual
                // Reels 0,1,2: mid row = Cleopatra; Reels 3,4: không có Cleopatra → streak dừng ở 3
                const strips = data.getReelStrips(false);
                const rands = [
                    findMidRand(strips[0], SymbolId.MAJOR_CLEOPATRA),
                    findMidRand(strips[1], SymbolId.MAJOR_CLEOPATRA),
                    findMidRand(strips[2], SymbolId.MAJOR_CLEOPATRA),
                    findNoSymbolRand(strips[3] ?? [], SymbolId.MAJOR_CLEOPATRA),
                    findNoSymbolRand(strips[4] ?? [], SymbolId.MAJOR_CLEOPATRA),
                ];
                const grid = data.getBaseGrid(rands, false);
                const wins = WaysPayCalculator.calculate(grid, totalBet);
                return enrich({
                    rands,
                    waysPayWins: wins,
                    matchedLinePays: MockDataProvider._toLegacyLinePays(wins),
                    totalBet, totalWin: WaysPayCalculator.totalWin(wins),
                    updateCash: true, nextStage: SlotStageType.SPIN,
                });
            }

            case TestScenario.BIG_WIN: {
                // Cleopatra full 5-reel win: tất cả reel đều có Cleopatra ở mid row
                const strips = data.getReelStrips(false);
                const rands = strips.map(strip => findMidRand(strip, SymbolId.MAJOR_CLEOPATRA));
                const grid = data.getBaseGrid(rands, false);
                const wins = WaysPayCalculator.calculate(grid, totalBet);
                return enrich({
                    rands,
                    waysPayWins: wins,
                    matchedLinePays: MockDataProvider._toLegacyLinePays(wins),
                    totalBet, totalWin: WaysPayCalculator.totalWin(wins),
                    updateCash: true, nextStage: SlotStageType.SPIN,
                });
            }

            case TestScenario.LONG_SPIN_TRIGGER: {
                // 3 Red trên reel 0,1,2 (1 mỗi reel) → Long Spin reel cuối
                // rands trỏ vào vị trí STICKY_RED trên Normal strips: Reel0=11, Reel1=14, Reel2=4
                const strips = data.getReelStrips(false);
                const longRands = [
                    findMidRand(strips[0], SymbolId.STICKY_RED),   // Reel 0: Red ở index 11
                    findMidRand(strips[1], SymbolId.STICKY_RED),   // Reel 1: Red ở index 14
                    findMidRand(strips[2], SymbolId.STICKY_RED),   // Reel 2: Red ở index 4
                    0,  // Reel 3: không Red
                    0,  // Reel 4: không Red
                ];
                const longGrid = data.getBaseGrid(longRands, false);
                const { redCount: lrc, redReels: lrr } = MockDataProvider._countSpecials(longGrid);
                const longStickies = MockDataProvider._buildRedStickies(longGrid, totalBet);
                return enrich({
                    rands: longRands,
                    waysPayWins: [], matchedLinePays: [],
                    totalBet, totalWin: 0, updateCash: true,
                    nextStage: SlotStageType.SPIN,
                    redCount: lrc,
                    redReels: lrr,
                    stickyCells: longStickies,
                });
            }

            case TestScenario.FEATURE_TRIGGER_RESPIN: {
                // 6+ Red: dùng rands trỏ vào STICKY_RED trên strip → visual khớp
                // Mỗi reel có 2 Red, center=Red → mid row hiện Red. Với 5 reel × mid=Red → ít nhất 5.
                // Thêm Red ở adjacent row (top/bot) để đạt >= 6.
                const strips = data.getReelStrips(false);
                const featureRands = MockDataProvider._buildFeatureTriggerRands(strips, 6);
                const featureGrid = data.getBaseGrid(featureRands, false);
                const { redCount: frc, redReels: frr } = MockDataProvider._countSpecials(featureGrid);
                const stickies = MockDataProvider._buildRedStickies(featureGrid, totalBet);
                return enrich({
                    rands: featureRands,
                    waysPayWins: [], matchedLinePays: [],
                    totalBet, totalWin: 0, updateCash: true,
                    nextStage: SlotStageType.FEATURE_SELECT_START,
                    redCount: frc,
                    redReels: frr.length >= 3 ? frr : [0, 1, 2, 3, 4],
                    stickyCells: stickies,
                });
            }

            case TestScenario.FEATURE_TRIGGER_FREESPIN: {
                // 7+ Red: tương tự RESPIN nhưng cần nhiều hơn
                const strips2 = data.getReelStrips(false);
                const fsRands = MockDataProvider._buildFeatureTriggerRands(strips2, 7);
                const fsGrid = data.getBaseGrid(fsRands, false);
                const { redCount: fsrc, redReels: fsrr } = MockDataProvider._countSpecials(fsGrid);
                const fsStickies = MockDataProvider._buildRedStickies(fsGrid, totalBet);
                return enrich({
                    rands: fsRands,
                    waysPayWins: [], matchedLinePays: [],
                    totalBet, totalWin: 0, updateCash: true,
                    nextStage: SlotStageType.FEATURE_SELECT_START,
                    redCount: fsrc,
                    redReels: fsrr.length >= 3 ? fsrr : [0, 1, 2, 3],
                    stickyCells: fsStickies,
                });
            }

            case TestScenario.FEATURE_GAUGE_WARMUP: {
                // Spin 1 test: có Red trên reel + gauge sáng, KHÔNG vào Feature.
                const strips = data.getReelStrips(false);
                const rands = [
                    findMidRand(strips[0] ?? [], SymbolId.STICKY_RED),
                    findMidRand(strips[1] ?? [], SymbolId.STICKY_RED),
                    findMidRand(strips[2] ?? [], SymbolId.STICKY_RED),
                    findNoSymbolRand(strips[3] ?? [], SymbolId.STICKY_RED),
                    findNoSymbolRand(strips[4] ?? [], SymbolId.STICKY_RED),
                ];
                const grid = data.getBaseGrid(rands, false);
                const stickies = MockDataProvider._buildRedStickies(grid, totalBet);
                const earned = stickies.length;
                return enrich({
                    rands,
                    waysPayWins: [], matchedLinePays: [],
                    totalBet, totalWin: 0, updateCash: true,
                    nextStage: SlotStageType.SPIN,
                    redCount: earned,
                    stickyCells: stickies,
                    naturalStickyCount: earned,
                    wildCount: earned,
                    stickyEarnedThisSpin: earned,
                    potVisualLevel: 2,
                    potCount: 40,
                    stickyAccumulated: 40,
                    lightingStage: 3,
                });
            }

            case TestScenario.FORCE_FEATURE_ENTRY: {
                // ★ Force Feature Entry demo: đúng 2 Red tự nhiên (reel 0+1 mid), 4 ô còn lại do StickyFillEffect đổ.
                const strips = data.getReelStrips(false);
                const naturalRands = [
                    findMidRand(strips[0] ?? [], SymbolId.STICKY_RED),
                    findMidRand(strips[1] ?? [], SymbolId.STICKY_RED),
                    findNoSymbolRand(strips[2] ?? [], SymbolId.STICKY_RED),
                    findNoSymbolRand(strips[3] ?? [], SymbolId.STICKY_RED),
                    findNoSymbolRand(strips[4] ?? [], SymbolId.STICKY_RED),
                ];
                const naturalGrid = data.getBaseGrid(naturalRands, false);
                const existingCells = MockDataProvider._buildRedStickies(naturalGrid, totalBet);
                const naturalCount = existingCells.length;

                const occupied = new Set(existingCells.map(c => `${c.reel}-${c.row}`));
                const fillCells: StickyCell[] = [];
                for (let r = 0; r < 5 && existingCells.length + fillCells.length < FEATURE_ENTRY_REQUIRED_STICKY; r++) {
                    for (let row = 0; row < 3 && existingCells.length + fillCells.length < FEATURE_ENTRY_REQUIRED_STICKY; row++) {
                        if (naturalGrid[r][row] === SymbolId.STICKY_RED) continue;
                        const key = `${r}-${row}`;
                        if (occupied.has(key)) continue;
                        occupied.add(key);
                        fillCells.push({
                            reel: r, row, symbolId: SymbolId.STICKY_RED,
                            credit: pickForcedStickyValue() * (totalBet || 1),
                        });
                    }
                }

                const force: ForceFeatureEntryData = { existingCells, fillCells, naturalCount };
                return enrich({
                    rands: naturalRands,
                    waysPayWins: [], matchedLinePays: [],
                    totalBet, totalWin: 0, updateCash: true,
                    nextStage: SlotStageType.FEATURE_SELECT_START,
                    redCount: naturalCount,
                    stickyCells: existingCells,
                    naturalStickyCount: naturalCount,
                    wildCount: naturalCount,
                    stickyEarnedThisSpin: naturalCount,
                    potCount: 60,
                    stickyAccumulated: 60,
                    isForcedFeatureEntry: true,
                    forceFeatureEntry: force,
                });
            }

            case TestScenario.POT_WIN: {
                // Wild (con dơi, id=8) nằm ở reel 1/2/3 trong strip
                // Tìm rands thực → visual hiện Wild → Wild Trail animation khớp
                const strips = data.getReelStrips(false);
                const rands = [
                    0,                                                        // Reel 0: không có Wild
                    findMidRand(strips[1] ?? [], SymbolId.WILD),              // Reel 1: mid = Wild
                    findMidRand(strips[2] ?? [], SymbolId.WILD),              // Reel 2: mid = Wild
                    findMidRand(strips[3] ?? [], SymbolId.WILD),              // Reel 3: mid = Wild
                    0,                                                        // Reel 4: không có Wild
                ];
                const grid = data.getBaseGrid(rands, false);
                const wins = WaysPayCalculator.calculate(grid, totalBet);
                return enrich({
                    rands,
                    waysPayWins: wins,
                    matchedLinePays: MockDataProvider._toLegacyLinePays(wins),
                    totalBet, totalWin: WaysPayCalculator.totalWin(wins), updateCash: true,
                    nextStage: SlotStageType.POT_WIN,
                    wildTrailCount: 3,
                    triggerPotWin: true,
                    pickGame: MockDataProvider.buildPickGame(),
                });
            }

            case TestScenario.GRAND_JACKPOT: {
                const pick = MockDataProvider.buildPickGame('upgrade_grand_x2');
                return enrich({
                    rands: [0, 0, 0, 0, 0],
                    waysPayWins: [], matchedLinePays: [],
                    totalBet, totalWin: 0, updateCash: true,
                    nextStage: SlotStageType.POT_WIN,
                    triggerPotWin: true,
                    pickGame: pick,
                });
            }

            case TestScenario.WILD_TRAIL_ONE: {
                // Mỗi spin có 2 wild (reel 1 + reel 2 mid), nextStage=SPIN — dùng để test tích lũy Pot
                const strips = data.getReelStrips(false);
                const rands = [
                    0,
                    findMidRand(strips[1] ?? [], SymbolId.WILD),   // Reel 1: mid = Wild
                    findMidRand(strips[2] ?? [], SymbolId.WILD),   // Reel 2: mid = Wild
                    0,
                    0,
                ];
                const grid = data.getBaseGrid(rands, false);
                const wins = WaysPayCalculator.calculate(grid, totalBet);
                return enrich({
                    rands,
                    waysPayWins: wins,
                    matchedLinePays: MockDataProvider._toLegacyLinePays(wins),
                    totalBet, totalWin: WaysPayCalculator.totalWin(wins), updateCash: true,
                    nextStage: SlotStageType.SPIN,   // ★ Không force POT_WIN — để GameManager tích lũy
                    wildTrailCount: 2,               // Báo cho GameManager: spin này có 2 wild
                });
            }

            case TestScenario.NO_WIN:
            default:
                return enrich({
                    rands: [0, 1, 2, 3, 4],
                    waysPayWins: [], matchedLinePays: [],
                    totalBet, totalWin: 0, updateCash: true,
                    nextStage: SlotStageType.SPIN,
                });
        }
    }
}

// ─── TEST SCENARIO ENUM ───

export enum TestScenario {
    WILD_TRAIL_ONE           = 'wild_trail_one',      // 1 wild/spin, nextStage=SPIN (test tích lũy)
    NO_WIN                   = 'no_win',
    NORMAL_WIN               = 'normal_win',
    BIG_WIN                  = 'big_win',
    LONG_SPIN_TRIGGER        = 'long_spin_trigger',
    FEATURE_TRIGGER_RESPIN   = 'feature_respin',
    FEATURE_TRIGGER_FREESPIN = 'feature_freespin',
    /** Spin 1: Red + gauge sáng (không Feature). Spin 2: Force Feature Entry. */
    FEATURE_GAUGE_WARMUP       = 'feature_gauge_warmup',
    /** ★ Force Feature Entry: Sticky tự nhiên < 6 → hệ thống đổ đủ 6 (guide + sticky fill). */
    FORCE_FEATURE_ENTRY      = 'force_feature_entry',
    POT_WIN                  = 'pot_win',
    GRAND_JACKPOT            = 'grand_jackpot',
}

// ─── FORCED MOCK ADAPTER ───
//
// Cách dùng trong GameManager.onLoad():
//   import { ForcedMockAdapter, TestScenario } from '../data/MockDataProvider';
//   NetworkManager.instance.setAdapter(new ForcedMockAdapter(TestScenario.FEATURE_TRIGGER_RESPIN));

export class ForcedMockAdapter implements INetworkAdapter {
    private _scenario: TestScenario;
    private _playCount: number = 0;

    constructor(scenario: TestScenario, private _repeatTimes: number = -1) {
        this._scenario = scenario;
    }

    async login(_params?: any): Promise<ServerSession> {
        await this._delay(100);
        return {
            nick: 'GofPlayer', serverTime: new Date().toISOString(),
            clientIp: '127.0.0.1', sessionKey: 0n, sessionUpdateSec: 300,
            memberIdx: 0, seq: 100, uid: 'gof-mock',
            cash: GameData.instance.player.balance, aky: '', currency: 'USD',
            country: 'US', isNewAccount: false, useBroadcast: false, smm: null,
        };
    }

    async enterGame(): Promise<ServerEnterResponse> {
        await this._delay(100);
        return {
            cash: GameData.instance.player.balance,
            slotName: 'Carnival Neko', ps: '',
            betIndex: 0, coinValueIndex: 0,
            lastSpinResponse: null,
            isPractice: false, memberIdx: 0, smm: null,
        };
    }

    async sendSpinRequest(_isFreeSpin: boolean): Promise<SpinResponse> {
        await this._delay(300);
        if (this._repeatTimes === -1 || this._playCount < this._repeatTimes) {
            this._playCount++;
            return MockDataProvider.buildScenario(this._scenario);
        }
        return MockDataProvider.generateSpinResponse(_isFreeSpin);
    }

    async sendClaimRequest(): Promise<{ balance: number; winCash?: number }> {
        await this._delay(100);
        const data = GameData.instance;
        const winCash = data.freeSpinTotalWin + data.respinTotalWin;
        return { balance: data.player.balance + winCash, winCash };
    }

    async pollJackpot(): Promise<ServerJackpotResponse> {
        return {
            Wins: GameData.instance.jackpotValues,
            WinMsgs: [], ReqRace: false, CR: null,
            UTC: new Date().toISOString(),
        };
    }

    async sendHeartBeat(): Promise<void> {}
    async sendGameOptChange(): Promise<void> {}
    async sendBroadcastOptionChange(): Promise<void> {}
    async sendFeatureItemGet(): Promise<any[]> { return []; }
    async sendFeatureItemBuy(): Promise<{ isSuccess: boolean; remainCash: number; res: any | null }> {
        return { isSuccess: true, remainCash: GameData.instance.player.balance, res: null };
    }
    async sendBalanceGet(): Promise<{ balance: number; currency: string }> {
        return { balance: GameData.instance.player.balance, currency: 'USD' };
    }
    async sendCashRaceMyRankGetFirst(): Promise<any | null> { return null; }
    async sendSelectFeature(nextStage: SlotStageType, reelIndex: number = 0): Promise<SelectFeatureResponse> {
        await this._delay(50);
        const remain = nextStage === SlotStageType.TOPUP_SPIN_START
            ? 6
            : (reelIndex >= 2 && reelIndex <= 6 ? 20 - (reelIndex - 2) * 2 : 8);
        return { nextStage, remainFeatureSpinCount: remain, reelIndex };
    }

    async sendPickRequest(_pickIndex: number): Promise<ServerPickResponse> {
        await this._delay(100);
        return {
            PickGame: [],
            IsJackpot: false,
            JackpotIndex: -1,
            NextStage: SlotStageType.SPIN,
        };
    }

    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
