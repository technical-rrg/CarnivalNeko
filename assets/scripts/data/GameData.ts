/**
 * GameData - Singleton chứa toàn bộ data runtime của game.
 * ★ Carnival Neko (5×3 Ways Pay).
 */

import { Log } from '../core/Logger';
import { LocalizationManager } from '../core/LocalizationManager';
import {
    PlayerData,
    SlotConfig,
    SpinResponse,
    SymbolId,
    ServerSession,
    StickyCell,
    JackpotType,
    FREE_SPIN_TIER_REEL_INDICES,
    isFreeSpinTierReelIndex,
} from './SlotTypes';

// ═══════════════════════════════════════════════════════════
//  DEFAULT REEL STRIPS — 5 reels × 30 ô
// ═══════════════════════════════════════════════════════════
//
// Carnival Neko:
//   - Wild (PS 21) chỉ reel 2, 3, 4.
//   - TRAIL_NORMAL trên base strip → flip màu Trail.
//   - Sticky Green/Gold (PS 44/45) chỉ Matsuri / respin strips.
//
const N9 = SymbolId.MINOR_9;
const N10 = SymbolId.MINOR_10;
const NJ = SymbolId.MINOR_J;
const Q = SymbolId.MINOR_Q;
const K = SymbolId.MINOR_K;
const A = SymbolId.MINOR_A;
const H = SymbolId.MAJOR_HORUS;
const An = SymbolId.MAJOR_ANUBIS;
const Sb = SymbolId.MAJOR_SOBEK;
const Rm = SymbolId.MAJOR_RAMSES;
const Cl = SymbolId.MAJOR_CLEOPATRA;
const W = SymbolId.WILD;
const Y = SymbolId.STICKY_YELLOW;
const G = SymbolId.STICKY_GREEN;
/** Carnival Neko — Trail Normal (úp, chưa biết màu) trên Base strip. */
const TN = SymbolId.TRAIL_NORMAL;

/** Normal Spin: 5 reels × 30 ô. Có TRAIL_NORMAL để mock luôn land được Trail. */
const DEFAULT_REEL_STRIPS: number[][] = [
    [N9, N10, NJ, Q, K, A, H, TN, Q, Rm, Sb, K, A, TN, H, Cl, Q, An, Rm, K, A, Sb, Q, H, Cl, TN, K, An, A, N10],
    [A, Cl, An, H, K, W, Rm, TN, H, A, K, Cl, TN, Q, Rm, Sb, N10, K, A, Cl, H, TN, An, K, Q, Rm, NJ, Sb, A, H],
    [Cl, Rm, H, TN, Sb, An, K, W, Cl, H, K, TN, A, Sb, An, Cl, K, H, TN, K, A, Rm, H, Sb, Cl, An, K, Q, Rm, N9],
    [Rm, A, Cl, TN, K, An, K, H, W, Cl, K, H, A, TN, Sb, Cl, K, H, A, K, Q, Rm, H, TN, Cl, Sb, K, A, An, Q],
    [K, Cl, A, Rm, H, An, Sb, TN, Cl, K, A, Q, Rm, Sb, An, Cl, TN, K, A, Q, Rm, Sb, H, Cl, An, K, TN, Rm, Sb, Cl],
];

/**
 * Free Spin strips: thay Wild → Yellow Sticky trên reel 1/2/3.
 * Khi spin, server (mock) sẽ random nhét Yellow vào để accumulator hoạt động.
 */
const DEFAULT_FREE_SPIN_REEL_STRIPS: number[][] = [
    [Q, K, A, H, An, Cl, Q, Rm, Sb, K, A, H, Cl, Q, An, Rm, K, A, Sb, Q, H, Cl, K, An, A, Rm, Sb, Q, N10, NJ],
    [A, Cl, An, Y, K, Q, Rm, Sb, H, A, K, Cl, Y, An, Q, Rm, Sb, K, A, Cl, H, An, K, Q, Rm, Y, Sb, A, H, W],
    [Cl, Rm, Y, A, K, Sb, An, Q, Cl, H, Y, K, A, Rm, Sb, An, Cl, K, Y, Q, A, Rm, H, Sb, Cl, An, K, Q, W, N9],
    [Rm, A, Cl, Y, Sb, K, An, H, Q, Cl, K, Y, A, Rm, An, Sb, Cl, K, Y, A, Q, Rm, H, An, Cl, Sb, K, A, W, H],
    [K, Cl, A, Rm, H, An, Sb, Cl, K, A, Q, Rm, Sb, An, Cl, K, A, Q, Rm, Sb, H, Cl, An, K, A, Rm, Sb, Cl, TN, Q],
];

/**
 * Matsuri / respin strips: chỉ Sticky Green + Gold (PS 44/45).
 */
const DEFAULT_RESPIN_REEL_STRIPS: number[][] = [
    [G, G, G, Y, Y, G, G, Y, G, G, G, Y, G, G, Y, G, G, G, Y, Y, G, G, G, Y, G, G, Y, G, G, G],
    [G, Y, G, G, G, Y, G, G, Y, G, G, G, Y, G, G, G, Y, G, G, Y, G, G, G, Y, G, G, G, Y, G, G],
    [Y, G, G, G, Y, G, G, G, G, Y, G, G, Y, G, G, G, Y, G, G, G, Y, G, G, Y, G, G, G, G, Y, G],
    [G, G, Y, G, G, G, Y, G, G, Y, G, G, G, Y, G, G, Y, G, G, G, Y, G, G, G, Y, G, G, Y, G, G],
    [G, Y, G, G, G, Y, G, G, G, Y, G, G, Y, G, G, G, Y, G, G, Y, G, G, G, Y, G, G, G, Y, G, G],
];

// ═══════════════════════════════════════════════════════════
//  WAYS PAYTABLE — multiplier × totalBet × ways
// ═══════════════════════════════════════════════════════════
//
// Format: SymbolId → [3-of-kind, 4-of-kind, 5-of-kind] multiplier
// Multiplier áp dụng cho mỗi "way":
//   payout = multiplier × totalBet × ways
//
const DEFAULT_WAYS_PAYTABLE: Record<number, [number, number, number]> = {
    // Minors (Secret Treasure: 9, 10, J, Q, K, A)
    [SymbolId.MINOR_9]:       [0.1, 0.2, 0.5],
    [SymbolId.MINOR_10]:      [0.15, 0.3, 0.7],
    [SymbolId.MINOR_J]:       [0.18, 0.4, 0.9],
    [SymbolId.MINOR_Q]:       [0.2, 0.5, 1.5],
    [SymbolId.MINOR_K]:       [0.3, 0.7, 2.0],
    [SymbolId.MINOR_A]:       [0.4, 1.0, 2.5],
    // Majors
    [SymbolId.MAJOR_HORUS]:     [0.8, 2.0, 5.0],
    [SymbolId.MAJOR_ANUBIS]:    [1.0, 2.5, 6.0],
    [SymbolId.MAJOR_SOBEK]:     [1.5, 4.0, 10.0],
    [SymbolId.MAJOR_RAMSES]:    [2.0, 5.0, 15.0],
    [SymbolId.MAJOR_CLEOPATRA]: [3.0, 8.0, 25.0],
};

/** Carnival Neko doc §7 Payout (có thể đổi khi server chốt). */
const DEFAULT_JACKPOT_MULTIPLIERS = {
    GRAND: 300,   // × totalBet
    MAJOR: 50,
    MINOR: 20,
    MINI:  10,
};

function buildDefaultFreeSpinTierStrips(): Record<number, number[][]> {
    const tiers: Record<number, number[][]> = {};
    for (const reelIndex of FREE_SPIN_TIER_REEL_INDICES) {
        tiers[reelIndex] = DEFAULT_FREE_SPIN_REEL_STRIPS.map(strip => [...strip]);
    }
    return tiers;
}

const DEFAULT_SLOT_CONFIG: SlotConfig = {
    reelStrips: DEFAULT_REEL_STRIPS,
    freeSpinReelStrips: DEFAULT_FREE_SPIN_REEL_STRIPS,
    freeSpinTierStrips: buildDefaultFreeSpinTierStrips(),
    respinReelStrips: DEFAULT_RESPIN_REEL_STRIPS,
    purchaseReelStrips: DEFAULT_REEL_STRIPS, // legacy alias
    betOptions: [1, 2, 3, 5, 10, 20, 50, 100],
    coinValues: [0.01, 0.02, 0.05, 0.10, 0.20, 0.50, 1.00],
    reelCount: 5,
    rowCount: 3,
    totalWays: 243,
    bigWinThreshold:     25,
    megaWinThreshold:    50,
    majorWinThreshold:   100,
    superWinThreshold:   200,
    epicWinThreshold:    400,
    ultraWinThreshold:   800,
    monsterWinThreshold: 1500,
    maxWinThreshold:     3000,
    waysPayTable: DEFAULT_WAYS_PAYTABLE,
    jackpotMultipliers: DEFAULT_JACKPOT_MULTIPLIERS,

    potLevelThresholds: [1, 11, 31, 51, 81, 101],   // ★ 6 ngưỡng cho level 1→6 (level 0 = trống)
    paylines: [], // deprecated
};

// ─── GAME DATA SINGLETON ───

export class GameData {
    private static _instance: GameData;

    player: PlayerData = {
        balance: 10000,
        betIndex: 0,
        coinValue: 0.01,
    };

    config: SlotConfig = { ...DEFAULT_SLOT_CONFIG };

    /** Response hiện tại từ server/mock */
    lastSpinResponse: SpinResponse | null = null;

    /**
     * Raw LastSpinResponse từ Enter API (chưa convert sang SpinResponse).
     * Dùng để detect Free Spin resume khi mở lại game.
     * Field names có thể là camelCase (stageType) hoặc PascalCase (NextStage) tuỳ server version.
     */
    rawEnterLastSpinResponse: any = null;

    /** Free spin state */
    freeSpinRemaining: number = 0;
    freeSpinTotalWin: number = 0;
    /**
     * Flag: freeSpinTotalWin được restore từ FeatureSpinTotalWin của server khi resume.
     */
    freeSpinTotalWinRestoredFromServer: boolean = false;

    // ═══════════════════════════════════════════════════════════
    //  ★ NEW — Gold of Fortune runtime state
    // ═══════════════════════════════════════════════════════════

    /** Re-Spin (Top Up) state */
    respinRemaining: number = 0;
    respinTotalWin: number = 0;
    /** Last value rendered in TopUp EachWin/NextWin UI, used for end-result diagnostics. */
    topUpDisplayedEachWin: number = 0;
    /** Base credit Σ Red khi bắt đầu Re-Spin / Free Spin (cho EACH WINS display). */
    featureBaseCredit: number = 0;

    /**
     * Sticky cells hiện đang khoá trên grid (Re-Spin / Free Spin).
     * Key = `${reel}-${row}` để lookup O(1) khi reel resolve.
     */
    stickyCells: Map<string, StickyCell> = new Map();

    /** Pot Level (0..6) — trực tiếp từ server qua PotVisualLevel (1..6). Level 0 = chưa có Pot. */
    potLevel: number = 0;
    /** Counter Wild Trail tích lũy từ đầu phiên chơi. */
    wildTrailCount: number = 0;

    // ─── Carnival Neko — 3 Pot levels (0..10 visual) ─────────────────────────
    potLevels: import('./SlotTypes').CarnivalPotLevels = { blue: 0, red: 0, green: 0 };
    /** Trail hits của spin đang xử lý (để controller đọc). */
    pendingTrails: import('./SlotTypes').CarnivalTrailHit[] = [];
    /** Tích lũy số Trail theo màu (mock growth condition_2). */
    trailAccumulated: import('./SlotTypes').CarnivalPotLevels = { blue: 0, red: 0, green: 0 };

    /** Số Normal Spin đã có Trail kể từ lần Feature Trigger gần nhất (mock auto). */
    carnivalTrailSpinCount: number = 0;
    /** Index cycle cho MOCK_CARNIVAL_FEATURE_TRIGGER = 'cycle' | 'auto'. */
    carnivalFeatureCycleIndex: number = 0;
    /**
     * Matsuri chờ chạy sau Jackpot (Ultra/Supreme/Ultimate: Pick → Free Spin).
     * Set khi Jackpot-first; clear khi vào Matsuri.
     */
    pendingCarnivalMatsuri: import('./SlotTypes').CarnivalFeatureTrigger | null = null;
    /**
     * Pick Game vừa đóng và đang vào Matsuri — SlotMachine/overlay/pot đọc cờ này
     * vì pendingCarnivalMatsuri bị clear trước khi listener khác chạy xong.
     */
    pickToMatsuriTransition: boolean = false;

    // ─── FEATURE ENTRY LOGIC ADDED — Reel UI Gauge state ─────────────────────
    /**
     * StickyAccumulated từ server — dùng tính lighting stage gauge (10 ô).
     * Chỉ track Normal Spin; reset khi vào feature (server gửi 0).
     */
    /** Lighting stage hiện tại của gauge (0..10). */

    /** Pick Game state hiện tại (active khi `gameStage = PICK_GAME`). */
    pickGameState: import('./SlotTypes').PickGameState | null = null;

    /** Pick Game win amount (jackpot prize) — dùng cho ProgressiveWin check sau khi Pick Game đóng */
    pickGameWinAmount: number = 0;

    /** Feature mode đang active để Mock API biết generate strip nào. */
    currentMode: 'normal' | 'respin' | 'freespin' | 'matsuri' = 'normal';

    /** Matsuri Hold&Spin — số hàng grid (3|4|5). */
    matsuriRows: number = 3;
    /** Tên feature Matsuri đang chạy (log / UI). */
    matsuriFeatureName: string = '';
    /** API CurrentFeatureType 0–5 đang active (−1 = none). */
    cnApiFeatureType: number = -1;

    // ─── FreeSpin Gold state ───────────────────────────────────────────────────
    /** Số lượt quay FreeSpin Gold còn lại. */
    freeSpinGoldRemaining: number = 0;
    /** Tổng credit tích lũy từ đồng xu vàng trong FreeSpin Gold. */
    freeSpinGoldTotalWin: number = 0;

    // ═══════════════════════════════════════════════════════════
    //  SERVER SESSION DATA (chỉ populated khi USE_REAL_API = true)
    // ═══════════════════════════════════════════════════════════
    /** Session nhận được sau Login */
    serverSession: ServerSession | null = null;
    /**
     * Chênh lệch đồng hồ giữa server và client (ms).
     * = serverTime - localTime tại thời điểm Login.
     * Dùng để tính timeLeft chính xác: Date.now() + clockOffsetMs.
     */
    clockOffsetMs: number = 0;
    /** Sequence number hiện tại — tăng dần sau mỗi SeqRequest thành công */
    currentSeq: number = 0;
    /** Đã login thành công chưa */
    isLoggedIn: boolean = false;
    /** Đã Enter game thành công chưa */
    isEntered: boolean = false;
    /** Last win message ID (cho Jackpot polling) — string để tránh mất precision số lớn */
    lastWinMsgId: string = '0';
    /**
     * WinGrade trả về từ ClaimResponse (sau khi kết thúc Free Spin).
     * Dùng bởi _onFreeSpinEndPopupClosed() khi USE_REAL_API = true.
     * Reset về undefined sau khi đã dùng.
     */
    lastClaimWinGrade: string | undefined = undefined;
    /** Jackpot values hiện tại [mini, minor, major, grand] — từ poll Wins / spin After */
    jackpotValues: number[] = [0, 0, 0, 0];
    /**
     * True sau khi Pick Game đủ 3 Upgrade đã apply meter.
     * Poll /Jackpot không được ghi đè cho đến khi Pick đóng.
     */
    holdJackpotValues: boolean = false;
    /**
     * Jackpot values trước spin [mini, minor, major, grand] — từ spin Before.
     * Dùng làm số tiền trúng progressive (pool lúc win), trước khi After reset meter.
     */
    jackpotValuesBefore: number[] = [0, 0, 0, 0];
    /** Raw PS reel strips (PS IDs gốc từ server — để verify mapping trong spin log) */
    rawPsStrips: number[][] = [];
    /** Raw FreeSpin PS reel strips (PS IDs gốc từ FreeSpinReel.Strips) */
    rawPsFreeSpinStrips: number[][] = [];
    /** Raw PS strips cho 5 tier Free Spin (ReelIndex 2–6). */
    rawPsFreeSpinTierStrips: Record<number, number[][]> = {};
    /** Tier Free Spin đã chọn ở FeatureSelect (ReelIndex 2–6). */
    selectedFreeSpinReelIndex: number | null = null;
    /** Raw Purchase PS reel strips (PS IDs gốc từ PurchaseReel.Strips) */
    rawPsPurchaseReelStrips: number[][] = [];
    /** Active feature item đang bật: dùng PurchaseReel cho normal spin đến khi cancel. */
    isPurchaseReelActive: boolean = false;
    /** Dynamic PS ID → Client SymbolId mapping, được build từ PS JSON symbol ID fields khi Enter */
    psToClientMap: Record<number, number> = {};
    /**
     * Named PS symbol IDs từ ParSheet — dùng để match matchedSymbols (raw PS IDs) → win type.
     * Server gửi PS IDs trong matchedSymbols; compare với các field này để xác định loại thắng.
     * Default -1 = chưa có PS (mock mode) → PayOutDisplay dùng client SymbolId so sánh thay thế.
     */
    psWinTypeIds = {
        oneSeven:    -1 as number,   // OneSevenSymbolID
        doubleSeven: -1 as number,   // DoubleSevenSymbolID
        tripleSeven: -1 as number,   // TripleSevenSymbolID
        anySeven:    -1 as number,   // AnySevenGroupID
        oneBar:      -1 as number,   // OneBarSymbolID
        doubleBar:   -1 as number,   // DoubleBarSymbolID
        anyBar:      -1 as number,   // AnyBarGroupID
        tripleWild:  -1 as number,   // TripleWildSymbolID
        redWild:     -1 as number,   // RedWildSymbolID
        blueWild:    -1 as number,   // BlueWildSymbolID
        anyWild:     -1 as number,   // AnyWildGroupID
    };
    /**
     * Flag: game được vào từ loading.scene (two-scene mode).
     * Set bởi LoadingController trước khi gọi director.loadScene().
     * GameManager dùng để tự detect, không cần isGameScene trong Inspector.
     */
    isFromLoadingScene: boolean = false;
    /**
     * Flag: đang resume Free Spin bị gián đoạn (tắt game giữa chừng).
     * Set bởi GameManager khi _pendingResume có stage FreeSpin.
     * GameEntryController dùng để bỏ qua màn hình guide và vào game ngay.
     */
    isResumingFreeSpin: boolean = false;
    /**
     * Flag: Guide đã hoàn tất (hoặc skip).
     * Set trước khi activate GameRoot — GameManager dùng để biết không chờ GUIDE_COMPLETE nữa.
     */
    isGuideCompleted: boolean = false;
    /**
     * Flag: GuideView đang hiện — GameRoot có thể warm-init nền (dưới Guide) nhưng chưa lộ.
     */
    isGuideShowing: boolean = false;
    /**
     * Guide-first boot: GuideView.prefab hiện trước Base.prefab.
     * LoadingController set true; GameEntryController dùng để không show Guide lần 2.
     */
    guideFirstBoot: boolean = false;
    /** Base.prefab đã attach (GameRoot có thể warm). */
    isBaseReady: boolean = false;
    /**
     * Jackpot symbol PS IDs từ ParSheet — dùng để detect jackpot từ rawPsStrips.
     * Server dùng các ID này thay vì winGrade để biểu thị jackpot trên reel.
     * Default = PS.json SuperNova values (nếu chưa có PS → dùng giá trị này).
     */
    jackpotPsIds: { MINI: number; MINOR: number; MAJOR: number; GRAND: number } = {
        MINI: 48, MINOR: 49, MAJOR: 51, GRAND: 52,
    };
    /**
     * Payline index của jackpot thắng gần nhất (0-based).
     * Set bởi GameManager._detectJackpot() khi phát hiện jackpot.
     * -1 = không có jackpot trong vòng quay hiện tại.
     */
    jackpotPaylineIndex: number = -1;
    /**
     * Payout multipliers từ PS.Symbols (API v1.0.3+).
     * Key = PS symbol ID, Value = payout multiplier (e.g. TripleSevenID → 200).
     * Empty khi chưa nhận PS (mock mode) → PayOutDisplay dùng Inspector fallback.
     */
    symbolPayouts: Record<number, number> = {};

    static get instance(): GameData {
        if (!this._instance) {
            this._instance = new GameData();
        }
        return this._instance;
    }

    /** Tổng bet = betOptions[betIndex] * coinValue (không nhân paylines) */
    get totalBet(): number {
        const bet = this.config.betOptions[this.player.betIndex] ?? 1;
        return bet * this.player.coinValue;
    }

    /**
     * Lấy 3 symbol hiển thị (top, mid, bot) cho 1 reel dựa trên center index.
     * Wrap-around khi vượt ngoài strip.
     * ★ Nếu có sticky cell → sticky override symbol từ strip.
     */
    getVisibleSymbols(reelIndex: number, centerIndex: number, isFreeSpin: boolean = false, stripIndex?: number, applyStickyOverride: boolean = true): number[] {
        const strips = this.getReelStrips(isFreeSpin, stripIndex);
        const strip = strips[reelIndex] ?? strips[0] ?? this.config.reelStrips[reelIndex] ?? [];
        const len = strip.length;
        if (len === 0) return [-1, -1, -1];
        const center = ((centerIndex % len) + len) % len;
        const top = strip[((center - 1) % len + len) % len];
        const mid = strip[center];
        const bot = strip[(center + 1) % len];
        const result = [top, mid, bot];
        // Sticky override (Re-Spin / Free Spin)
        if (applyStickyOverride && this.stickyCells.size > 0) {
            for (let r = 0; r < 3; r++) {
                const cell = this.stickyCells.get(`${reelIndex}-${r}`);
                if (cell) result[r] = cell.symbolId;
            }
        }
        return result;
    }

    /**
     * ★ Lấy toàn bộ grid 5×3 (reel × row) cho 1 spin response.
     * grid[reel][row] = symbolId.
     */
    getGrid(rands: number[], isFreeSpin: boolean = false, stripIndex?: number, applyStickyOverride: boolean = true): number[][] {
        const grid: number[][] = [];
        const reels = this.config.reelCount;
        for (let r = 0; r < reels; r++) {
            grid.push(this.getVisibleSymbols(r, rands[r] ?? 0, isFreeSpin, stripIndex, applyStickyOverride));
        }
        return grid;
    }

    /** Lấy grid trực tiếp từ reel strip/rands, không áp sticky override. Dùng để so với visual reel thật. */
    getBaseGrid(rands: number[], isFreeSpin: boolean = false, stripIndex?: number): number[][] {
        return this.getGrid(rands, isFreeSpin, stripIndex, false);
    }

    /** Strip Free Spin theo tier đã chọn (ReelIndex 2–6 từ SelectFeature). */
    resolveFreeSpinStrips(reelIndex?: number): number[][] {
        const tierKey = reelIndex ?? this.selectedFreeSpinReelIndex ?? 2;
        return this.config.freeSpinTierStrips?.[tierKey]
            ?? this.config.freeSpinReelStrips;
    }

    /** Raw PS strips cùng tier với resolveFreeSpinStrips(). */
    resolveRawPsFreeSpinStrips(reelIndex?: number): number[][] {
        const tierKey = reelIndex ?? this.selectedFreeSpinReelIndex ?? 2;
        const tier = this.rawPsFreeSpinTierStrips[tierKey];
        if (tier?.length) return tier;
        return this.rawPsFreeSpinStrips.length > 0 ? this.rawPsFreeSpinStrips : this.rawPsStrips;
    }

    /**
     * Chọn đúng bộ strip theo mode.
     *
     * Secret Treasure SelectFeature / spin:
     *   - Free Spin tiers: ReelIndex 2–6 (Highest…Lowest) → freeSpinTierStrips
     *   - Legacy FreeSpin: ReelIndex 1 → freeSpinReelStrips
     *   - TopUp / Re-Spin: currentMode === 'respin' (spin thường ReelIndex 2; legacy shortcut 3)
     *   - Purchase (non-FS): ReelIndex 2 khi không ở FS/respin
     *
     * Quan trọng: FS High cũng dùng ReelIndex=3 — PHẢI resolve FS trước shortcut
     * legacy `stripIndex === 3 → respin` (respin strips chứa Green Sticky + +1).
     */
    getReelStrips(isFreeSpin: boolean = false, stripIndex?: number): number[][] {
        const isFsMode = isFreeSpin || this.currentMode === 'freespin';

        if (stripIndex != null) {
            // Free Spin (kể cả tier 2–6) trước mọi shortcut TopUp/Re-Spin.
            if (isFsMode && this.currentMode !== 'respin' && this.currentMode !== 'matsuri') {
                const tierKey = isFreeSpinTierReelIndex(stripIndex) ? stripIndex : undefined;
                return this.resolveFreeSpinStrips(tierKey);
            }
            if (this.currentMode === 'respin' || this.currentMode === 'matsuri' || stripIndex === 3) {
                return this.config.respinReelStrips;
            }
            if (stripIndex === 2) {
                return this.config.purchaseReelStrips;
            }
            if (stripIndex === 1) {
                return this.config.freeSpinReelStrips;
            }
            if (stripIndex === 0 && this.isPurchaseReelActive) {
                return this.config.purchaseReelStrips;
            }
            return this.config.reelStrips;
        }

        if (this.currentMode === 'respin' || this.currentMode === 'matsuri') {
            // Matsuri Hold&Spin dùng FreeSpinReel group (đã gán vào respinReelStrips)
            return this.config.respinReelStrips;
        }
        if (!isFreeSpin && this.isPurchaseReelActive) {
            return this.config.purchaseReelStrips;
        }
        if (isFsMode) {
            return this.resolveFreeSpinStrips();
        }
        return this.config.reelStrips;
    }

    /** Raw PS strips cùng mode với getReelStrips(), dùng cho payout/jackpot debug chính xác. */
    getRawPsStrips(isFreeSpin: boolean = false, stripIndex?: number): number[][] {
        const isFsMode = isFreeSpin || this.currentMode === 'freespin';
        const purchaseOrNormal = this.rawPsPurchaseReelStrips.length > 0
            ? this.rawPsPurchaseReelStrips
            : this.rawPsStrips;

        if (stripIndex != null) {
            if (isFsMode && this.currentMode !== 'respin' && this.currentMode !== 'matsuri') {
                const tierKey = isFreeSpinTierReelIndex(stripIndex) ? stripIndex : undefined;
                return this.resolveRawPsFreeSpinStrips(tierKey);
            }
            if (this.currentMode === 'matsuri') {
                return this.rawPsFreeSpinStrips.length > 0 ? this.rawPsFreeSpinStrips : this.rawPsStrips;
            }
            if (this.currentMode === 'respin' || stripIndex === 3) {
                // TopUp/Re-Spin raw: ưu tiên purchase/respin PS sheet nếu server gửi riêng
                return purchaseOrNormal;
            }
            if (stripIndex === 2) {
                return purchaseOrNormal;
            }
            if (stripIndex === 1) {
                return this.rawPsFreeSpinStrips.length > 0 ? this.rawPsFreeSpinStrips : this.rawPsStrips;
            }
            if (stripIndex === 0 && this.isPurchaseReelActive) {
                return purchaseOrNormal;
            }
            return this.rawPsStrips;
        }
        if (this.currentMode === 'matsuri') {
            return this.rawPsFreeSpinStrips.length > 0 ? this.rawPsFreeSpinStrips : this.rawPsStrips;
        }
        if (!isFreeSpin && this.isPurchaseReelActive) {
            return purchaseOrNormal;
        }
        if (isFsMode) {
            return this.resolveRawPsFreeSpinStrips();
        }
        return this.rawPsStrips;
    }

    /** Convert server/logical row to display row after vertical reel reversal. */
    toDisplayRow(row: number): number {
        return row >= 0 && row <= 2 ? 2 - row : row;
    }

    /** Visible symbols in the same top/mid/bot order as the client renders them. */
    getDisplayVisibleSymbols(reelIndex: number, centerIndex: number, isFreeSpin: boolean = false, stripIndex?: number): number[] {
        const symbols = this.getVisibleSymbols(reelIndex, centerIndex, isFreeSpin, stripIndex);
        return [symbols[2], symbols[1], symbols[0]];
    }

    /** Xác định Win Tier dựa trên totalWin / totalBet.
     *  Thứ tự check: MAX → MONSTER → ULTRA → EPIC → SUPER → MAJOR → MEGA → BIG (từ cao → thấp).
     *  Chỉ check tier nếu threshold > 0 (đã được server ghi đè). */
    getWinTier(totalWin: number): number {
        const ratio = totalWin / this.totalBet;
        if (this.config.maxWinThreshold     > 0 && ratio >= this.config.maxWinThreshold)     return 9; // MAX_WIN
        if (this.config.monsterWinThreshold > 0 && ratio >= this.config.monsterWinThreshold) return 8; // MONSTER_WIN
        if (this.config.ultraWinThreshold   > 0 && ratio >= this.config.ultraWinThreshold)   return 7; // ULTRA_WIN
        if (this.config.epicWinThreshold    > 0 && ratio >= this.config.epicWinThreshold)    return 6; // EPIC_WIN
        if (this.config.superWinThreshold   > 0 && ratio >= this.config.superWinThreshold)   return 5; // SUPER_WIN
        if (this.config.majorWinThreshold   > 0 && ratio >= this.config.majorWinThreshold)   return 4; // MAJOR_WIN
        if (this.config.megaWinThreshold    > 0 && ratio >= this.config.megaWinThreshold)    return 3; // MEGA_WIN
        if (this.config.bigWinThreshold     > 0 && ratio >= this.config.bigWinThreshold)     return 2; // BIG_WIN
        if (totalWin > 0) return 1;                                                                       // NORMAL
        return 0;                                                                                        // NONE
    }

    reset(): void {
        this.lastSpinResponse = null;
        this.freeSpinRemaining = 0;
        this.freeSpinTotalWin = 0;
        this.freeSpinTotalWinRestoredFromServer = false;
        // ★ NEW
        this.respinRemaining = 0;
        this.respinTotalWin = 0;
        this.topUpDisplayedEachWin = 0;
        this.featureBaseCredit = 0;
        this.stickyCells.clear();
        this.pickGameState = null;
        this.pickGameWinAmount = 0;
        this.holdJackpotValues = false;
        this.pickToMatsuriTransition = false;
        this.currentMode = 'normal';
        this.freeSpinGoldRemaining = 0;
        this.freeSpinGoldTotalWin = 0;
        this.selectedFreeSpinReelIndex = null;
    }

    /** Reset server session (khi logout hoặc reconnect) */
    resetSession(): void {
        this.serverSession = null;
        this.currentSeq = 0;
        this.isLoggedIn = false;
        this.isEntered = false;
        this.lastWinMsgId = '0';
        this.jackpotValues = [0, 0, 0, 0];
        this.jackpotValuesBefore = [0, 0, 0, 0];
        this.holdJackpotValues = false;
    }

    /**
     * JackpotType → index server [MINI=0, MINOR=1, MAJOR=2, GRAND=3].
     * Trả -1 nếu type không hợp lệ.
     */
    static jackpotTypeToIndex(type: JackpotType): number {
        const idx = type - 1;
        return idx >= 0 && idx <= 3 ? idx : -1;
    }

    /** Meter jackpot hiện tại từ API (Wins / After). Không hardcode multiplier. */
    getJackpotMeter(type: JackpotType): number {
        const idx = GameData.jackpotTypeToIndex(type);
        if (idx < 0) return 0;
        const v = this.jackpotValues[idx];
        return Number.isFinite(v) && v > 0 ? v : 0;
    }

    /**
     * Số tiền jackpot thắng theo API server:
     * 1) Before[tier] (pool lúc spin trúng)
     * 2) meter hiện tại (Wins / After)
     * Không dùng bet × multiplier hardcode.
     */
    getJackpotWinAmount(type: JackpotType): number {
        const idx = GameData.jackpotTypeToIndex(type);
        if (idx < 0) return 0;
        const before = this.jackpotValuesBefore[idx];
        if (Number.isFinite(before) && before > 0) return before;
        return this.getJackpotMeter(type);
    }

    /** Cập nhật session sau login thành công */
    setServerSession(session: ServerSession): void {
        this.serverSession = session;
        this.currentSeq = session.seq;
        this.isLoggedIn = true;
        // Balance từ server
        this.player.balance = session.cash;
        // Override ký hiệu tiền tệ theo currency server trả về (bất kể ngôn ngữ UI)
        if (session.currency) {
            LocalizationManager.instance.setCurrencyOverride(session.currency);
        }
    }

    /** Cập nhật SEQ từ server response (dùng cho SeqRequest APIs) */
    updateSeq(newSeq: number): void {
        this.currentSeq = newSeq;
    }
}
