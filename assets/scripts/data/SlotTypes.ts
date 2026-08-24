/**
 * SlotTypes - Định nghĩa tất cả Type, Enum, Interface cho game slot.
 * ★ Gold of Fortune (3×5 Ways Pay) — rewrite từ Shangri-La (3×3 Payline).
 */

// ─── ENUMS ───

/**
 * Stage type — mở rộng cho các feature mới của Gold of Fortune.
 * Giữ nguyên giá trị Free Spin / Buy Free Spin cũ để compatible với server SuperNova schema.
 */
export enum SlotStageType {
    SPIN = 0,
    POT = 1,                    // POT stage (server API 7.1)
    RE_SPIN = 2,                // Re-spin stage (server API 7.1)
    FREE_SPIN_START = 3,
    FREE_SPIN = 4,
    FREE_SPIN_RE_TRIGGER = 5,
    PICK_START = 6,             // Pick game start (server API 7.1)
    PICK = 7,                   // Pick game in progress (server API 7.1)
    BUY_FREE_SPIN_START = 8,
    BUY_FREE_SPIN = 9,
    LINK_SPIN_START = 10,       // Link spin start (server API 7.1)
    LINK_SPIN = 11,             // Link spin in progress (server API 7.1)
    TOPUP_SPIN_START = 12,      // Top-up spin start (server API 7.1)
    TOPUP_SPIN = 13,            // Top-up spin in progress (server API 7.1)
    HIDDEN_FREE_SPIN_START = 14, // Hidden free spin start (server API 7.1)
    HIDDEN_FREE_SPIN = 15,      // Hidden free spin in progress (server API 7.1)
    NEED_CLAIM = 100,
    FREE_SPIN_END = 101,
    PICK_END = 102,             // Pick game end (server API 7.1)
    COIN_FLIP = 103,            // Coin flip (server API 7.1)
    COIN_WHEEL = 104,           // Coin wheel (server API 7.1)
    COIN_FREE_SPIN = 105,       // Coin free spin (server API 7.1)
    COIN_END = 106,             // Coin event end (server API 7.1)
    BUY_FREE_SPIN_END = 107,
    FEATURE_SELECT = 108,       // Feature select (server API 7.1)
    HIDDEN_FREE_SPIN_END = 109, // Hidden free spin end (server API 7.1)
    DIRECT_PAY_START = 1000,    // Direct pay start (server API 7.1)
    DIRECT_PAY = 1001,          // Direct pay in progress (server API 7.1)
    LINK_SPIN_END = 1002,       // Link spin end (server API 7.1)
    TOPUP_SPIN_END = 1003,      // Top-up spin end (server API 7.1)
    DOUBLE_LINK_SPIN_START = 1004, // Double link spin start (server API 7.1)
    // ★ Gold of Fortune custom stages (client-side only)
    FEATURE_SELECT_START = 200,   // 6+ Red → hiển thị popup chọn Re-Spin / Free Spin
    RESPIN_START = 210,           // Vào chuỗi Re-Spin (Top Up)
    RESPIN = 211,                 // Đang Re-Spin
    RESPIN_END = 212,             // Re-Spin kết thúc → claim
    POT_WIN = 220,                // Wild trail trigger Pot Win → vào Pick Game
    PICK_GAME = 221,              // Đang chơi Pick Game
    PICK_GAME_END = 222,          // Pick Game kết thúc → claim jackpot
    BUY_RESPIN_START = 230,       // Mua Re-Spin
    BUY_RESPIN_END = 231,
    // ★ Carnival Neko
    CARNIVAL_MATSURI_START = 240, // Pot Blue/Green/Combo → Matsuri Hold&Spin
}

/** Secret Treasure — ReelIndex gửi trong SelectFeature cho 5 tier Free Spin (2=Highest … 6=Lowest). */
export const FREE_SPIN_TIER_REEL_INDICES = [2, 3, 4, 5, 6] as const;
export type FreeSpinTierReelIndex = typeof FREE_SPIN_TIER_REEL_INDICES[number];

export enum FeatureSelectChoiceId {
    TOPUP = 'topup',
    FS_HIGHEST = 'fs_highest',
    FS_HIGH = 'fs_high',
    FS_MIDDLE = 'fs_middle',
    FS_LOW = 'fs_low',
    FS_LOWEST = 'fs_lowest',
}

/** Metadata 1 tier Free Spin — map PS field + SelectFeature ReelIndex. */
export interface FreeSpinTierDef {
    id: FeatureSelectChoiceId;
    reelIndex: FreeSpinTierReelIndex;
    psKeys: string[];
    labelKey: string;
    shortLabel: string;
}

/** 5 tier Free Spin Secret Treasure (ReelIndex 2→6). */
export const SECRET_TREASURE_FREE_SPIN_TIERS: FreeSpinTierDef[] = [
    { id: FeatureSelectChoiceId.FS_HIGHEST, reelIndex: 2, psKeys: ['HighestFreeSpinReel', 'HighestFreeSpin'], labelKey: 'feature_select_fs_highest', shortLabel: 'Highest' },
    { id: FeatureSelectChoiceId.FS_HIGH,    reelIndex: 3, psKeys: ['HighFreeSpinReel', 'HighFreeSpin'],       labelKey: 'feature_select_fs_high',    shortLabel: 'High' },
    { id: FeatureSelectChoiceId.FS_MIDDLE,  reelIndex: 4, psKeys: ['MiddleFreeSpinReel', 'MiddleFreeSpin'],   labelKey: 'feature_select_fs_middle',  shortLabel: 'Middle' },
    { id: FeatureSelectChoiceId.FS_LOW,     reelIndex: 5, psKeys: ['LowFreeSpinReel', 'LowFreeSpin'],         labelKey: 'feature_select_fs_low',     shortLabel: 'Low' },
    { id: FeatureSelectChoiceId.FS_LOWEST,  reelIndex: 6, psKeys: ['LowestFreeSpinReel', 'LowestFreeSpin'],   labelKey: 'feature_select_fs_lowest',  shortLabel: 'Lowest' },
];

/** Lựa chọn hiển thị trên Feature Selection popup (TopUp + 5 tier FS). */
export interface FeatureSelectOption {
    id: FeatureSelectChoiceId;
    nextStage: SlotStageType;
    /** SelectFeature: 0=TopUp, 2–6=Free Spin tier. Spin response: 0=Normal, 1=FreeSpin, 2=TopUp game. */
    reelIndex: number;
    labelKey: string;
    enabled: boolean;
    spinCountHint?: number;
}

/** 6 lựa chọn mặc định — server có thể disable từng option qua payload sau. */
export function buildDefaultFeatureSelectOptions(): FeatureSelectOption[] {
    const topUp: FeatureSelectOption = {
        id: FeatureSelectChoiceId.TOPUP,
        nextStage: SlotStageType.TOPUP_SPIN_START,
        reelIndex: 0,
        labelKey: 'feature_select_topup',
        enabled: true,
    };
    const tiers: FeatureSelectOption[] = SECRET_TREASURE_FREE_SPIN_TIERS.map(t => ({
        id: t.id,
        nextStage: SlotStageType.FREE_SPIN_START,
        reelIndex: t.reelIndex,
        labelKey: t.labelKey,
        enabled: true,
    }));
    return [topUp, ...tiers];
}

export function getFreeSpinTierDef(reelIndex: number): FreeSpinTierDef | undefined {
    return SECRET_TREASURE_FREE_SPIN_TIERS.find(t => t.reelIndex === reelIndex);
}

export function isFreeSpinTierReelIndex(reelIndex: number): reelIndex is FreeSpinTierReelIndex {
    return reelIndex >= 2 && reelIndex <= 6;
}

/**
 * Client SymbolId — index nội bộ (prefab / art / logic). KHÔNG bằng số PS server.
 * Map PS → client: PS_TO_CLIENT + NetworkManager._applyPS dynMap.
 *
 * Carnival Neko API V1.0.1 PS IDs:
 *   Low 1–6 → MINOR_* | High 11–15 → MAJOR_* | Wild 21 → WILD
 *   Trail 41/42/43 → TRAIL_BLUE/GREEN/RED | Sticky 44/45 → STICKY_GREEN / STICKY_YELLOW(Gold)
 *   Pick: 81 Idle, 82 Grand, 83 Major, 84 Minor, 85 Mini, 86 Upgrade
 */
export enum SymbolId {
    // ── Pay symbols (PS Low01–06 = 1–6; art tạm giữ tên cũ) ──
    MINOR_9 = 0,
    MINOR_10 = 1,
    MINOR_J = 2,
    MINOR_Q = 3,
    MINOR_K = 4,
    MINOR_A = 5,
    // ── High pay (PS High01–05 = 11–15; art tạm giữ tên cũ) ──
    MAJOR_HORUS = 6,
    MAJOR_ANUBIS = 7,
    MAJOR_SOBEK = 8,
    MAJOR_RAMSES = 9,
    MAJOR_CLEOPATRA = 10,
    // ── Special ──
    WILD = 11,             // Client index — system/PS Wild = 21 (PS_WILD_ID)
    STICKY_YELLOW = 13,    // CN Sticky_02 Gold — PS 45
    STICKY_GREEN = 14,     // CN Sticky_01 Green — PS 44
    // (12, 15 reserved — legacy STICKY_RED / PLUS_ONE_SPIN removed)
    // ── Jackpot Pick (PS remapped) ──
    JP_IDLE = 16,          // PS 81
    JP_MINI = 17,          // PS 85
    JP_MINOR = 18,         // PS 84
    JP_MAJOR = 19,         // PS 83
    JP_GRAND = 20,         // PS 82
    /** Upgrade — PS 86; 3 Upgrade → nâng tier / Grand ×2. */
    JP_UPGRADE = 25,

    // ── Carnival Trail — UI hiện TRAIL_NORMAL rồi flip màu ──
    TRAIL_NORMAL = 21,
    /** PS 41 Trail_01 Blue → Blue Pot */
    TRAIL_BLUE = 22,
    /** PS 43 Trail_03 Red → Red Pot */
    TRAIL_RED = 23,
    /** PS 42 Trail_02 Green → Green Pot */
    TRAIL_GREEN = 24,
}

/** Màu Trail / Pot Carnival Neko — map 1-1 với 3 hũ trên UI. */
export enum TrailColor {
    BLUE = 0,
    RED = 1,
    GREEN = 2,
}

/** Một Trail vừa land trên grid (server / mock đã quyết định màu khi flip). */
export interface CarnivalTrailHit {
    reel: number;
    row: number;
    /** Màu sau khi flip — client luôn hiện TRAIL_NORMAL trước, rồi flip sang màu này. */
    color: TrailColor;
}

/** Level 3 Pot (visual tier 1..10 theo design; mock dùng 0..10). */
export interface CarnivalPotLevels {
    blue: number;
    red: number;
    green: number;
}

export function trailColorToSymbolId(color: TrailColor): SymbolId {
    switch (color) {
        case TrailColor.BLUE: return SymbolId.TRAIL_BLUE;
        case TrailColor.RED: return SymbolId.TRAIL_RED;
        case TrailColor.GREEN: return SymbolId.TRAIL_GREEN;
        default: return SymbolId.TRAIL_NORMAL;
    }
}

export function isTrailSymbol(s: number): boolean {
    return s === SymbolId.TRAIL_NORMAL
        || s === SymbolId.TRAIL_BLUE
        || s === SymbolId.TRAIL_RED
        || s === SymbolId.TRAIL_GREEN;
}

/**
 * Reel display: luôn hiện TRAIL_NORMAL trước khi flip màu.
 * Strip/API có thể trả TRAIL_BLUE/GREEN/RED — map về NORMAL khi render trên reel.
 */
export function toReelDisplayTrailSymbol(s: number): number {
    if (s === SymbolId.TRAIL_BLUE || s === SymbolId.TRAIL_RED || s === SymbolId.TRAIL_GREEN) {
        return SymbolId.TRAIL_NORMAL;
    }
    return s;
}

/** Feature kích hoạt khi Pot nổ (Carnival Neko). */
export enum CarnivalFeatureKind {
    NONE = 0,
    /** Red Pot only → Jackpot Pick ngay (NextStage=PICK_START) */
    JACKPOT = 1,
    /** Blue Pot → Mighty Matsuri 5×3 / StartCoin 6 */
    MIGHTY = 2,
    /** Green Pot → Mega Matsuri 5×4 / StartCoin 8 */
    MEGA = 3,
    /** Blue+Green → Super Matsuri 5×5 / StartCoin 10 */
    SUPER = 4,
    /** Blue+Red → Jackpot Pick trước, rồi Ultra Matsuri */
    ULTRA = 5,
    /** Red+Green → Jackpot Pick trước, rồi Supreme Matsuri */
    SUPREME = 6,
    /** Cả 3 → Jackpot Pick trước, rồi Ultimate Matsuri */
    ULTIMATE = 7,
}

export interface CarnivalFeatureTrigger {
    kind: CarnivalFeatureKind;
    /** Pot nào nổ spin này */
    burstPots: TrailColor[];
    /**
     * Red-only + Ultra/Supreme/Ultimate: mở Jackpot Pick ngay sau spin.
     * Mighty/Mega/Super = false — vào Matsuri trước.
     */
    jackpotFirst: boolean;
    /**
     * Legacy: Pick sau Matsuri Claim. Ultra+ hiện không dùng (đảo thành Pick → FS).
     */
    jackpotAfterFreeSpin: boolean;
    /**
     * Ultra/Supreme/Ultimate: PICK_END Claim → NextStage=FREE_SPIN_START (Matsuri sau Pick).
     */
    freeSpinAfterJackpot: boolean;
    /** Matsuri rows: 3/4/5 — 0 nếu chỉ Jackpot */
    matsuriRows: number;
    /** Số Start Gold Sticky */
    startCoins: number;
    /** Tên hiển thị (Mighty Matsuri, …) */
    featureName: string;
}

export function describeCarnivalFeature(kind: CarnivalFeatureKind): Omit<CarnivalFeatureTrigger, 'kind' | 'burstPots'> {
    switch (kind) {
        case CarnivalFeatureKind.JACKPOT:
            return {
                jackpotFirst: true, jackpotAfterFreeSpin: false, freeSpinAfterJackpot: false,
                matsuriRows: 0, startCoins: 0, featureName: 'Jackpot Feature',
            };
        case CarnivalFeatureKind.MIGHTY:
            return {
                jackpotFirst: false, jackpotAfterFreeSpin: false, freeSpinAfterJackpot: false,
                matsuriRows: 3, startCoins: 6, featureName: 'Mighty Matsuri',
            };
        case CarnivalFeatureKind.MEGA:
            return {
                jackpotFirst: false, jackpotAfterFreeSpin: false, freeSpinAfterJackpot: false,
                matsuriRows: 4, startCoins: 8, featureName: 'Mega Matsuri',
            };
        case CarnivalFeatureKind.SUPER:
            return {
                jackpotFirst: false, jackpotAfterFreeSpin: false, freeSpinAfterJackpot: false,
                matsuriRows: 5, startCoins: 10, featureName: 'Super Matsuri',
            };
        case CarnivalFeatureKind.ULTRA:
            return {
                jackpotFirst: true, jackpotAfterFreeSpin: false, freeSpinAfterJackpot: true,
                matsuriRows: 3, startCoins: 6, featureName: 'Ultra Matsuri + Jackpot',
            };
        case CarnivalFeatureKind.SUPREME:
            return {
                jackpotFirst: true, jackpotAfterFreeSpin: false, freeSpinAfterJackpot: true,
                matsuriRows: 4, startCoins: 8, featureName: 'Supreme Matsuri + Jackpot',
            };
        case CarnivalFeatureKind.ULTIMATE:
            return {
                jackpotFirst: true, jackpotAfterFreeSpin: false, freeSpinAfterJackpot: true,
                matsuriRows: 5, startCoins: 10, featureName: 'Ultimate Matsuri + Jackpot',
            };
        default:
            return {
                jackpotFirst: false, jackpotAfterFreeSpin: false, freeSpinAfterJackpot: false,
                matsuriRows: 0, startCoins: 0, featureName: 'None',
            };
    }
}

export function buildCarnivalFeatureTrigger(
    kind: CarnivalFeatureKind,
    burstPots: TrailColor[],
): CarnivalFeatureTrigger | null {
    if (kind === CarnivalFeatureKind.NONE) return null;
    return { kind, burstPots, ...describeCarnivalFeature(kind) };
}

/**
 * API CurrentFeatureType (−1 none, 0–5 Mighty→Ultimate) → CarnivalFeatureKind.
 * Khác offset với enum nội bộ (JACKPOT=1, MIGHTY=2…).
 */
export function carnivalKindFromApiFeatureType(apiType: number): CarnivalFeatureKind {
    switch (apiType) {
        case 0: return CarnivalFeatureKind.MIGHTY;
        case 1: return CarnivalFeatureKind.MEGA;
        case 2: return CarnivalFeatureKind.SUPER;
        case 3: return CarnivalFeatureKind.ULTRA;
        case 4: return CarnivalFeatureKind.SUPREME;
        case 5: return CarnivalFeatureKind.ULTIMATE;
        default: return CarnivalFeatureKind.NONE;
    }
}

/** API feature type index 0–5 → FreeSpinReel strip group start (×5 strips). */
export function cnFreeSpinStripGroupStart(apiFeatureType: number): number {
    const t = Math.max(0, Math.min(5, Math.floor(apiFeatureType)));
    return t * 5;
}

/** Helper: kiểm tra symbol là Major (client 6–10) */
export function isMajor(s: number): boolean { return s >= SymbolId.MAJOR_HORUS && s <= SymbolId.MAJOR_CLEOPATRA; }
/** Helper: kiểm tra symbol là Minor (client 0–5) */
export function isMinor(s: number): boolean { return s >= SymbolId.MINOR_9 && s <= SymbolId.MINOR_A; }

/** PS/system High pay ID 11–15 (High01–05). */
export function isHighPayPsId(psId: number): boolean {
    return psId >= 11 && psId <= 15;
}

/** PS/system Low pay ID 1–6 (Low01–06). */
export function isLowPayPsId(psId: number): boolean {
    return psId >= 1 && psId <= 6;
}

/** PS/system Wild ID — luôn là 21 (không phải 11). */
export const PS_WILD_ID = 21;

/** Helper: kiểm tra symbol là Sticky (Red/Yellow/Green) */
export function isSticky(s: number): boolean {
    return s === SymbolId.STICKY_YELLOW || s === SymbolId.STICKY_GREEN;
}
/** Helper: Wild có thay thế được cho symbol s không?
 * Wild thay tất cả Minor + Major. KHÔNG thay Sticky, +1 Spin, Jackpot.
 */
export function wildSubstitutes(s: number): boolean { return isMinor(s) || isMajor(s); }

// ═══════════════════════════════════════════════════════════
//  PS ↔ CLIENT SYMBOL ID MAPPING — Carnival Neko (SlotId 20)
// ═══════════════════════════════════════════════════════════

/**
 * PS ID → Client SymbolId — Carnival Neko API V1.0.1.
 *
 * Low: 1–6 | High: 11–15 | Wild: 21
 * Trail: 41 Blue, 42 Green, 43 Red
 * Sticky: 44 Green (detect), 45 Gold (overlay)
 * Pick: 81 Idle, 82 Grand, 83 Major, 84 Minor, 85 Mini, 86 Upgrade
 *
 * Legacy 46–50: không dùng CN primary (giữ map nhẹ cho mock cũ nếu còn).
 */
export const PS_TO_CLIENT: Record<number, number> = {
    // ─── Pay symbols ───
    1:  SymbolId.MINOR_9,
    2:  SymbolId.MINOR_10,
    3:  SymbolId.MINOR_J,
    4:  SymbolId.MINOR_Q,
    5:  SymbolId.MINOR_K,
    6:  SymbolId.MINOR_A,
    11: SymbolId.MAJOR_HORUS,
    12: SymbolId.MAJOR_ANUBIS,
    13: SymbolId.MAJOR_SOBEK,
    14: SymbolId.MAJOR_RAMSES,
    15: SymbolId.MAJOR_CLEOPATRA,
    // ─── Wild ───
    21: SymbolId.WILD,
    // ─── Trail (UI: TRAIL_NORMAL → flip màu theo PS) ───
    41: SymbolId.TRAIL_BLUE,
    42: SymbolId.TRAIL_GREEN,
    43: SymbolId.TRAIL_RED,
    // ─── Sticky feature ───
    44: SymbolId.STICKY_GREEN,   // Sticky_01 Green
    45: SymbolId.STICKY_YELLOW,  // Sticky_02 Gold
    // ─── Legacy unused on CN primary (ignored) ───
    46: SymbolId.STICKY_YELLOW,
    47: SymbolId.STICKY_YELLOW,
    48: SymbolId.STICKY_YELLOW,
    49: SymbolId.STICKY_GREEN,
    50: SymbolId.STICKY_GREEN,
    // ─── Pick Game (ID mới 260810): 82 Grand, 83 Major, 84 Minor, 85 Mini ───
    81: SymbolId.JP_IDLE,
    82: SymbolId.JP_GRAND,
    83: SymbolId.JP_MAJOR,
    84: SymbolId.JP_MINOR,
    85: SymbolId.JP_MINI,
    86: SymbolId.JP_UPGRADE,
    99: -1,
};

/** Client SymbolId → representative PS ID (CN V1.0.1). */
export const CLIENT_TO_PS: Record<number, number> = {
    [SymbolId.MINOR_9]:         1,
    [SymbolId.MINOR_10]:        2,
    [SymbolId.MINOR_J]:         3,
    [SymbolId.MINOR_Q]:         4,
    [SymbolId.MINOR_K]:         5,
    [SymbolId.MINOR_A]:         6,
    [SymbolId.MAJOR_HORUS]:     11,
    [SymbolId.MAJOR_ANUBIS]:    12,
    [SymbolId.MAJOR_SOBEK]:     13,
    [SymbolId.MAJOR_RAMSES]:    14,
    [SymbolId.MAJOR_CLEOPATRA]: 15,
    [SymbolId.WILD]:            21,
    [SymbolId.TRAIL_BLUE]:      41,
    [SymbolId.TRAIL_GREEN]:     42,
    [SymbolId.TRAIL_RED]:       43,
    [SymbolId.STICKY_GREEN]:    44,
    [SymbolId.STICKY_YELLOW]:   45,
    [SymbolId.JP_IDLE]:         81,
    [SymbolId.JP_MINI]:         85,
    [SymbolId.JP_MINOR]:        84,
    [SymbolId.JP_MAJOR]:        83,
    [SymbolId.JP_GRAND]:        82,
    [SymbolId.JP_UPGRADE]:      86,
};

/**
 * Đưa về PS/system ID để so high/wild.
 *   'ps'     : matchedSymbols server — giữ nguyên (11–15 = high, 21 = wild)
 *   'client' : WaysPayWin.symbolId — map qua CLIENT_TO_PS (client WILD → PS 21)
 */
export function toSystemPsId(rawId: number, idSpace: 'ps' | 'client' = 'ps'): number {
    if (idSpace === 'client') {
        const ps = CLIENT_TO_PS[rawId];
        return ps !== undefined ? ps : rawId;
    }
    return rawId;
}

/** High pay = system ID 11–15. Wild (21) không phải high. */
export function isHighPaySymbol(rawId: number, idSpace: 'ps' | 'client' = 'ps'): boolean {
    return isHighPayPsId(toSystemPsId(rawId, idSpace));
}

/** Low pay = system ID 1–6. */
export function isLowPaySymbol(rawId: number, idSpace: 'ps' | 'client' = 'ps'): boolean {
    return isLowPayPsId(toSystemPsId(rawId, idSpace));
}

/** Wild = system ID 21. */
export function isWildSymbol(rawId: number, idSpace: 'ps' | 'client' = 'ps'): boolean {
    return toSystemPsId(rawId, idSpace) === PS_WILD_ID;
}

export function psToClientSymbol(psId: number): number {
    return PS_TO_CLIENT[psId] ?? -1;
}

export function convertPSStrips(psStrips: number[][]): number[][] {
    return psStrips.map((strip) =>
        strip.map((psId) => PS_TO_CLIENT[psId] ?? SymbolId.MINOR_9)
    );
}

export enum JackpotType {
    NONE = 0,
    MINI = 1,
    MINOR = 2,
    MAJOR = 3,
    GRAND = 4,
}

export enum TopupReelType {
    NONE = 0,
    YELLOW = 2,
    GREEN = 3,
    GRAND = 4,
}

export enum WinTier {
    NONE = 0,
    NORMAL = 1,
    BIG_WIN = 2,
    MEGA_WIN = 3,
    MAJOR_WIN = 4,
    SUPER_WIN = 5,
    EPIC_WIN = 6,
    ULTRA_WIN = 7,
    MONSTER_WIN = 8,
    MAX_WIN = 9,
}

/** State machine — trạng thái hiện tại của vòng spin */
export enum GameState {
    IDLE = 'idle',
    SPINNING = 'spinning',
    RESULT = 'result',
    FREE_SPIN = 'freespin',
    POPUP = 'popup',
    // ★ NEW
    FEATURE_SELECT = 'feature_select',  // Đang hiển thị popup chọn Re-Spin / Free Spin
    RESPIN = 'respin',                  // Đang trong chuỗi Re-Spin
    POT_WIN = 'pot_win',                // Pot Trail đã trigger, chuẩn bị Pick Game
    PICK_GAME = 'pick_game',            // Đang chơi Pick Game
}

// ─── INTERFACES ───

/**
 * 1 win theo Ways Pay — thay thế MatchedLinePay (payline).
 * Server (nếu có) cũng có thể trả về structure này khi schema cập nhật.
 */
export interface WaysPayWin {
    /** Symbol thắng (đã resolve Wild → ID symbol gốc). */
    symbolId: number;
    /** Số reel liên tiếp từ trái match (3..5). */
    reelCount: number;
    /** Số "ways" = tích số instance trên mỗi reel. */
    ways: number;
    /** Payout = symbolPayout × ways × totalBet (đã tính sẵn). */
    payout: number;
    /** Có chứa Wild không (để khoá animation Wild zoom riêng). */
    containsWild: boolean;
    /** Danh sách vị trí (reel, row) tất cả ô tham gia win — dùng cho highlight. */
    cells: Array<{ reel: number; row: number }>;
    /**
     * Mỗi phần tử là 1 combination cụ thể (1 path từ reel 0 → reelCount-1).
     * combinations.length === ways.
     * Dùng để cycle từng path riêng biệt giống payline cycling.
     */
    combinations: Array<Array<{ reel: number; row: number }>>;
}

/**
 * @deprecated dùng `WaysPayWin` cho Gold of Fortune.
 * Giữ alias để code legacy compile (sẽ remove cùng PaylineDisplay).
 */
export interface MatchedLinePay {
    payLineIndex: number;
    payout: number;
    matchedSymbols: number[];
    containsWild: boolean;
    reelCnt: number;
    /** Server MatchedSymbolsCount — 3/4/5-of-a-kind (ReelCnt thường = 0). */
    matchedSymbolsCount?: number;
    matchedSymbolsIndices: Array<{ Item1: number; Item2: number }> | null;
}

/** Sticky cell state — dùng trong Re-Spin / Free Spin. */
export interface StickyCell {
    reel: number;        // 0..4
    row: number;         // 0..2 (visual: 0 = bottom)
    symbolId: number;    // STICKY_GREEN / Gold sticky overlay
    /** CN API V1.0.2: Credit trên StarterCoins / NewStickies / AllStickies (đã × TotalBet). */
    credit: number;
}

/** Pick Game state — Pick coin reveal sequence. */
export interface PickGameState {
    /**
     * Grid 5×3 = 15 ô (Carnival Neko).
     * Mỗi ô: JP_GRAND/MAJOR/MINOR/MINI/UPGRADE (client SymbolId) — chưa lộ cho người chơi.
     * Real API có thể trả -1/Idle cho ô chưa pick; mock prefill toàn bộ.
     */
    grid: number[];
    /** Ô đã lật (index 0..14). */
    revealed: number[];
    /** Tier trả thưởng (sau upgrade nếu có). undefined = chưa thắng. */
    wonTier?: 'GRAND' | 'MAJOR' | 'MINOR' | 'MINI';
    /** Đã đủ 3 Upgrade trước khi match JP → lần win sẽ nâng tier / Grand×2. */
    upgradeArmed?: boolean;
    /** Số Upgrade đã reveal. */
    upgradeCount?: number;
    /** Grand ×2 khi upgrade + match Grand. */
    doubleGrand?: boolean;
}

export interface TopupReelSlot {
    type: TopupReelType;
    win: number;
    index: number;
}

export interface SelectFeatureResponse {
    nextStage: number;
    remainFeatureSpinCount: number;
    /** ReelIndex đã chọn (0=TopUp, 2–6=Free Spin tier). */
    reelIndex?: number;
}

/** Spin response — mở rộng đầy đủ cho Gold of Fortune. */
export interface SpinResponse {
    /** Center strip index của 5 reel. */
    rands: number[];
    /** ★ NEW: Wins theo Ways Pay. */
    waysPayWins: WaysPayWin[];
    /** @deprecated giữ field cho code legacy. */
    matchedLinePays: MatchedLinePay[];
    totalBet: number;
    totalWin: number;
    updateCash: boolean;
    nextStage: number;
    reelIndex?: number;
    featureMultiple?: number;
    remainCash?: number;
    remainFreeSpinCount?: number;
    winGrade?: string;
    featureSpinTotalWin?: number;

    // ★ NEW Gold of Fortune fields ─────────────────────────────
    /** Số Red sticky xuất hiện trong vòng spin này (để detect Feature Select / Long Spin). */
    redCount?: number;
    /** Danh sách reel có Red sticky (dùng cho Long Spin trigger: 3+ reel trong [0..3]). */
    redReels?: number[];
    /** Danh sách sticky cells (kèm credit) — non-empty khi Re-Spin / Free Spin. */
    stickyCells?: StickyCell[];
    /** Số ô Wild Trail xuất hiện trong spin này (để Pot Level tích lũy). */
    wildTrailCount?: number;
    /** Pot Visual Level trực tiếp từ server (1..6). Dùng để set Pot level UI. */
    potVisualLevel?: number;
    /** Server trigger Pot Win (= bước vào Pick Game). */
    triggerPotWin?: boolean;
    /** Pick game data (chỉ có khi triggerPotWin = true). */
    pickGame?: PickGameState;
    /** Số Re-Spin còn lại (Re-Spin mode). */
    remainRespinCount?: number;
    /** Topup game link reel state: 15 grid cells + 1 Grand slot. */
    topupReel?: TopupReelSlot[];

    /** Legacy: wild/sticky count aliases still present on some server payloads. */
    wildCount?: number;
    potCount?: number;

    // ★ Carnival Neko — 3 Trail / 3 Pot ─────────────────────────────────────
    /**
     * Trails land trên spin này.
     * Client: hiện TRAIL_NORMAL → flip ra color → bay vào đúng Pot.
     * Real API: parse từ PS Trail IDs (41=Blue, 42=Green, 43=Red) trên grid.
     */
    trails?: CarnivalTrailHit[];
    /** Level 3 Pot sau spin (visual). Real API: map từ server pot state khi có. */
    potLevels?: CarnivalPotLevels;
    /**
     * Feature trigger Carnival (Pot nổ).
     * Client: sau CARNIVAL_TRAIL_FLY_DONE → pot burst → Jackpot và/hoặc Matsuri.
     */
    carnivalFeature?: CarnivalFeatureTrigger;

    // ★ Carnival Neko CNSpinResponse (API V1.0.2) ─────────────────────────────
    /** API CurrentFeatureType: −1 none, 0–5 Mighty→Ultimate. */
    currentFeatureType?: number;
    /** Grid height 3 / 4 / 5 trong Matsuri. */
    featureRows?: number;
    /** FREE_SPIN_START — Start Gold sticky: [{ Reel, Row, Credit }]. */
    starterCoins?: StickyCell[];
    /** Sticky Green mới land: [{ Reel, Row, Credit }]. */
    newStickies?: StickyCell[];
    /** Toàn bộ sticky trên grid: [{ Reel, Row, Credit }]. */
    allStickies?: StickyCell[];
    /** CollectWin / FeatureSpinWin của spin Matsuri (tổng hút Gold → gán Green nếu cell.Credit=0). */
    collectWin?: number;
    featureSpinWin?: number;
    /** API: tổng credit sticky đang hold (AllStickies). */
    accumulatedStickyCredit?: number;
    stickyCount?: number;
    /** PICK_END Claim Ultra+: jackpot win mang sang Free Spin. */
    featureEntryJackpotWin?: number;
    /** PICK_END Claim Ultra+: tên tier JP (MINI/MINOR/MAJOR/GRAND). */
    featureEntryJackpotName?: string;
    /** Mystery envelope instant payout (normal spin). */
    redEnvelopePay?: number;
    isGridFull?: boolean;
    gridFullGrandWin?: number;
}

export interface PlayerData {
    balance: number;
    betIndex: number;
    coinValue: number;
}

/** Config cố định từ Parsheet (★ Gold of Fortune — 5 reels, Ways Pay). */
export interface SlotConfig {
    /** 5 reel strips Normal Spin. Mỗi strip = mảng SymbolId. */
    reelStrips: number[][];
    /** Legacy single Free Spin strip (Gold Of Fortunes fallback). */
    freeSpinReelStrips: number[][];
    /** Secret Treasure: 5 tier Free Spin strips keyed by SelectFeature ReelIndex (2–6). */
    freeSpinTierStrips: Record<number, number[][]>;
    /** 5 reel strips Re-Spin (chỉ ô trống được quay; strip nhiều +1 spin / Yellow / Green). */
    respinReelStrips: number[][];
    /** Hỗ trợ legacy: nếu user bật BuyBonus cũ ⇒ dùng tạm strips này. */
    purchaseReelStrips: number[][];

    /** Bet & Coin options. */
    betOptions: number[];
    coinValues: number[];

    /** Số reel cố định = 5 (đặt thành biến để code adapter dễ thay đổi). */
    reelCount: number;
    /** Số row visible = 3. */
    rowCount: number;
    /** Tổng số ways = rowCount ^ reelCount = 3^5 = 243. */
    totalWays: number;

    /** Ngưỡng WinTier (×totalBet). */
    bigWinThreshold: number;
    megaWinThreshold: number;
    majorWinThreshold: number;
    superWinThreshold: number;
    epicWinThreshold: number;
    ultraWinThreshold: number;
    monsterWinThreshold: number;
    maxWinThreshold: number;

    /**
     * Paytable theo Ways Pay: payout multiplier × totalBet × ways
     * Key = SymbolId. Value = mảng [3-of-a-kind, 4-of-a-kind, 5-of-a-kind] multiplier.
     * Lưu ý: multiplier áp dụng **không nhân với totalBet** vì server schema mới
     * dùng công thức (multiplier × ways × totalBet). Xem `WaysPayCalculator`.
     */
    waysPayTable: Record<number, [number, number, number]>;

    /** Jackpot tier payout multipliers (× totalBet) — Pick Game reward. */
    jackpotMultipliers?: {
        GRAND: number;
        MAJOR: number;
        MINOR: number;
        MINI: number;
    };

    /** Pot Level thresholds (số Wild Trail tích luỹ để lên level). 6 ngưỡng cho level 1→6. */
    potLevelThresholds: number[]; // e.g. [1, 3, 5, 7, 9, 12]

    // ─── @deprecated — giữ field cho code legacy. Không dùng trong code mới. ───
    /** @deprecated dùng Ways Pay; không còn paylines. */
    paylines: number[][];
}

// ═══════════════════════════════════════════════════════════
//  SERVER API TYPES (dùng khi USE_REAL_API = true)
// ═══════════════════════════════════════════════════════════

/** Session data nhận được sau khi Login thành công */
export interface ServerSession {
    nick: string;
    serverTime: string;
    clientIp: string;
    sessionKey: bigint;       // Int64 — dùng làm SKEY cho mọi request sau (dùng BigInt để tránh mất precision)
    sessionUpdateSec: number;
    memberIdx: number;        // Int64 — dùng làm MIDX (giá trị thực tế nhỏ, number là đủ)
    seq: number;              // Sequence number khởi đầu
    uid: string;
    cash: number;             // Balance thực từ server
    aky: string;              // AES-256 key cho mọi request sau login
    currency: string;
    country: string;
    isNewAccount: boolean;
    useBroadcast: boolean;
    isPractice?: boolean;
    smm: ServerMaintenanceMessage | null;
}

/** Enter response — data game khởi tạo */
export interface ServerEnterResponse {
    cash: number;
    slotName: string;
    ps: string;               // Base64 par sheet data
    betIndex: number;
    coinValueIndex: number;
    lastSpinResponse: any;    // ISpinResponse từ server
    isPractice: boolean;
    memberIdx: number;
    smm: ServerMaintenanceMessage | null;
}

/** Spin response từ server (AckSpin) — ALL PascalCase theo actual API */
export interface ServerSpinResponse {
    RemainCash: number;
    Res: {
        Rands: number[];
        MatchedLinePays: ServerMatchedLinePay[];
        UpdateCash: boolean;
        TotalBet: number;
        TotalWin: number;
        NextStage: number;
        WinGrade: string | null;
        FeatureSpinTotalWin: number;
        FeatureSpinWin: number;
        RemainFreeSpinCount: number;
        RemainFeatureSpinCount?: number;
        ReelIndex: number;
        FeatureMultiple?: number;
        MysteryMultiple?: number;
        FreeSpinMultiplier?: number;
        MatchedBonus?: any;
        CollectWin?: number;
        AddSpinCount?: number;
        InitReel?: any;
        // ★ Gold of Fortune specific fields
        RedCount?: number;
        StickyRedCount?: number;
        RedReels?: number[];
        StickyCells?: any[];
        StickyList?: any[];
        CollectSymbols?: any[];
        WildTrailCount?: number;
        WildCount?: number;
        /** Gauge accumulated count (= StickyAccumulated). */
        PotCount?: number;
        PotVisualLevel?: number;
        TriggerPotWin?: boolean;
        IsPotWin?: boolean;
        PickGame?: any;
        PickGameState?: any;
        RemainReSpinCount?: number;
        RemainRespinCount?: number;
        TopupReel?: any[];
        NormalSpinLinkReel?: any[];
        NoramlSpinLinkReel?: any[];
    };
    SpinID: number;                    // Int64
    Before: Record<string, number>;    // Jackpot values trước spin
    After: Record<string, number>;     // Jackpot values sau spin
    SMM: ServerMaintenanceMessage | null;
}

/** Server MatchedLinePay format — ALL PascalCase theo actual API */
export interface ServerMatchedLinePay {
    Feature: string | null;
    FeatureParam: number;
    MatchedSymbols: number[];
    MatchedSymbolsCount: number;
    PayLineIndex: number;
    Payout: number;
    ReelCnt: number;
    ContainsWild: boolean;
    MatchedSymbolsIndices: any[];
}

/**
 * Pick response từ server (AckPick → CNPickResponse) — API V1.0.2 Table 23.
 * PickGame: 15 ô, -1=chưa chọn, số dương=PS ID (82 Grand, 83 Major, 84 Minor, 85 Mini, 86 Upgrade).
 * PickResults: PS ID ô vừa pick. PickWin=0 đến khi match 3 JP.
 * IsJackpot luôn false, JackpotIndex luôn -1 (flat jackpot).
 * NextStage=PICK(7) khi còn pick; PICK_END(102) khi match 3 JP → /Claim.
 * JackpotName: “MINI”/“MINOR”/“MAJOR”/“GRAND” khi thắng (đã gồm upgrade nếu server áp).
 */
export interface ServerPickResponse {
    /** Grid 15 items — -1=unselected, positive=revealed PS ID */
    PickGame: number[];
    /** PS ID revealed by this pick */
    PickResults?: number;
    /** 1-based pick count */
    PickStage?: number;
    PickWin?: number;
    /** CN: luôn false */
    IsJackpot: boolean;
    /** CN: luôn −1 */
    JackpotIndex: number;
    /** “MINI”/“MINOR”/“MAJOR”/“GRAND” khi match 3 JP */
    JackpotName?: string;
    NextStage: number;
    UpgradeCount?: number;
    IsUpgradeComplete?: boolean;
    DoubleGrand?: boolean;
    /** Meter sau upgrade [MINI, MINOR, MAJOR, GRAND] — từ AckPick After/Wins nếu server trả. */
    JackpotAfter?: number[];
}

/** Claim response từ server (AckClaimFeature / CNClaimResponse) — API V1.0.2 */
export interface ServerClaimResponse {
    ClaimResponse: {
        TotalWin: number;
        FeatureName: string;
        /** SPIN, PICK_START (legacy), hoặc FREE_SPIN_START sau PICK_END Ultra+. */
        NextStage: number;
        WinGrade: string;
        StartRands: number[];
        /** Chỉ có nghĩa khi claim PICK_END. */
        JackpotName?: string;
        /** Grid 15 ô khi NextStage=PICK_START (legacy Ultra+ FS→Pick). */
        PickGame?: number[];
        CurrentFeatureType?: number;
        FeatureRows?: number;
        StarterCoins?: any[];
        AllStickies?: any[];
        FeatureEntryJackpotWin?: number;
        FeatureEntryJackpotName?: string;
        RemainFeatureSpinCount?: number;
    };
    WinCash: number;
    Cash: number;
}

/** Kết quả parse Claim phía client. */
export interface ClaimResult {
    balance: number;
    winCash?: number;
    winGrade?: string;
    claimTotalWin?: number;
    /** CNClaimResponse.FeatureSpinTotalWin — đối chiếu collect-all với client. */
    claimFeatureSpinTotalWin?: number;
    topLevelWinCash?: number;
    featureName?: string;
    /** PICK_END claim only — tier Mini/Minor/Major/Grand. */
    jackpotName?: string;
    startRands?: number[];
    /** SPIN, PICK_START (legacy FS→Pick), hoặc FREE_SPIN_START (Pick→FS Ultra+). */
    nextStage?: number;
    /** Seed Pick khi Claim NextStage=PICK_START. */
    pickGame?: PickGameState;
    /** PICK_END Claim Ultra+ → Free Spin. */
    currentFeatureType?: number;
    featureRows?: number;
    starterCoins?: StickyCell[];
    allStickies?: StickyCell[];
    featureEntryJackpotWin?: number;
    featureEntryJackpotName?: string;
    remainFeatureSpinCount?: number;
}

/** BalanceGet response từ server (AckBalanceGet) — 4.11 /Slot/{SlotId}/BalanceGet */
export interface ServerBalanceGetResponse {
    Balance: number;     // Current balance
    Currency: string;    // Currency code (e.g. "KRW")
}

/** FeatureItem từ server — AckFeatureItemGet.Items[n] (theo API doc) */
export interface ServerFeatureItem {
    Id: number;              // ID của gói
    Name: string;            // Tên gói
    Title: string;           // Tiêu đề hiển thị
    Desc: string;            // Mô tả chi tiết
    PriceRatio: number;      // Bội số so với totalBet (không phải giá tuyệt đối)
    EffectType: number;      // 1=Ticket, 2=ExchangeReel, 3=ProvideSymbol, 4=AddSpins
    EffectReels: number[];   // Reel áp dụng (nếu có)
    EffectSymbols: any[];    // Symbol áp dụng (nếu có)
    AddSpinValue: number | null;
    TicketFeature: number;
    Order: number;
    ImgUrl: string;          // URL thumbnail
}

/** FeatureItemGet response từ server (AckFeatureItemGet) */
export interface ServerFeatureItemGetResponse {
    Cash: number;
    Items: ServerFeatureItem[];
    SMM: any | null;
}

/** FeatureItemBuy response từ server (AckPurchaseItemBuy) */
export interface ServerFeatureItemBuyResponse {
    IsSuccess: boolean;
    Res: any | null;       // ISpinResponse — spin result kèm theo khi mua
    RemainCash: number;
    ExReel: any;           // Có thể là string (AES encrypted), array, object, hoặc null
}

/** Client-side FeatureItem (camelCase) */
export interface FeatureItem {
    itemId: number;
    name: string;
    title: string;
    desc: string;
    priceRatio: number;      // PriceRatio từ server (bội số × totalBet)
    effectType: number;      // 1=Ticket, 2=ExchangeReel, 3=ProvideSymbol, 4=AddSpins
    imgUrl: string;
    addSpinValue?: number | null;
    /** Carnival Buy Bonus → Matsuri kind (Mighty/Mega/Super). */
    carnivalKind?: CarnivalFeatureKind;
}

// ═══════════════════════════════════════════════════════════
//  BUY BONUS SYSTEM — IBonusItem
// ═══════════════════════════════════════════════════════════

/** Loại áp dụng của BonusItem (mapping từ SlotPurchaseItemEffectType) */
export type BonusApplyType = 'onceuse' | 'activate';

/**
 * IBonusItem — Dữ liệu item bonus từ Server (SlotFeatureItemInfo).
 * - "onceuse": Mua đứt 1 lần → gọi API FeatureItemBuy (EffectType=1 Ticket / 4 AddSpins).
 * - "activate": Bật/Tắt → dùng OnOff trong FeatureItemBuy (EffectType=2 ExchangeReel / 3 ProvideSymbol).
 * - Price hiển thị = currentTotalBet × valueRatio (PriceRatio từ server).
 */
export interface IBonusItem {
    uniqueID: string;            // ← SlotFeatureItemInfo.Id (Int32 → string)
    itemName: string;            // ← SlotFeatureItemInfo.Name
    itemInfo: string;            // ← SlotFeatureItemInfo.Desc
    applyType: BonusApplyType;   // ← suy ra từ EffectType: "onceuse" hoặc "activate"
    valueRatio: number;          // ← SlotFeatureItemInfo.PriceRatio
    thumbnailImage: string;      // ← SlotFeatureItemInfo.ImgUrl
    /** Carnival Buy Bonus → Matsuri kind (Mighty/Mega/Super). */
    carnivalKind?: CarnivalFeatureKind;
}

/** Jackpot polling response (AckJackpotInfo) — PascalCase theo tài liệu */
export interface ServerJackpotResponse {
    Wins: number[];                  // [mini, minor, major, grand] — array theo actual API
    WinMsgs: ServerWinBroadcast[];
    ReqRace: boolean;
    CR: NwCashRaceSimpleForUser | null;
    UTC: string;
    SMM?: ServerMaintenanceMessage | null;  // "Most responses include SMM" (doc section 6)
}

// ─── Cash Race types (theo API doc) ──────────────────────────────────────────

/** NwCashRaceSimpleForUser — trả về trong Jackpot polling */
export interface NwCashRaceSimpleForUser {
    MyRank: number;           // hạng hiện tại của tôi (0 nếu chưa có hạng)
    MyPrizePercent: number;   // % prize có thể nhận
    Race: NwCashRaceInfoSimple;
}

/** NwCashRaceInfoSimple — thông tin race rút gọn (trong Jackpot CR) */
export interface NwCashRaceInfoSimple {
    RaceId: number;
    Rule: number;     // CashRaceRule: 0=WIN, 1=BET, 2=LOSE
    State: number;    // CashRaceState: 0=none,1=wait,2=notice,3=running,4=closing,5=closed
    NT: string;       // notice start time (ISO UTC)
    ST: string;       // race start time (ISO UTC)
    CT: string;       // race end / settlement start time (ISO UTC)
    ET: string;       // settlement end time (ISO UTC)
    DT: string;       // display time (ISO UTC)
    TotalPrize: number;
}

/** NwCashRaceInfoDetail — thông tin race đầy đủ (trong CashRaceMyRankGetFirst) */
export interface NwCashRaceInfoDetail {
    RaceId: number;
    Title: string;
    Rule: number;     // CashRaceRule: 0=WIN, 1=BET, 2=LOSE
    State: number;    // CashRaceState
    NT: string;
    ST: string;
    CT: string;
    ET: string;
    Desc: string;
    TotalPrize: number;
    WinnerCount: number;  // số người nhận thưởng
    BasePrize: number;
    PrizeRatio: number;
}

/** NwCashRaceRankerSimple — 1 dòng trong bảng xếp hạng */
export interface NwCashRaceRankerSimple {
    Rank: number;
    Nick: string;
    Score: number;
    Prize: number;
    B_Rank: number;   // hạng trước đó
}

/** Response của CashRaceMyRankGetFirst */
export interface CashRaceMyRankGetFirstResponse {
    Race: NwCashRaceInfoDetail;
    MyRank: NwCashRaceRankerSimple | null;
    TopRanks: NwCashRaceRankerSimple[];
    BottomRanks: NwCashRaceRankerSimple[];
    PrizeRangePercent: number;
}

/**
 * Response CashRaceMyRankGetPage (API V1.0.2).
 * Server có thể trả Ranks hoặc tái dùng TopRanks/BottomRanks — parse linh hoạt.
 */
export interface CashRaceMyRankGetPageResponse {
    Ranks?: NwCashRaceRankerSimple[];
    TopRanks?: NwCashRaceRankerSimple[];
    BottomRanks?: NwCashRaceRankerSimple[];
    MyRank?: NwCashRaceRankerSimple | null;
    PrizeRangePercent?: number;
}

/** Win broadcast message */
export interface ServerWinBroadcast {
    Seq: string;                 // ID dạng số lớn (19 chữ số) — giữ dạng string tránh mất precision
    Slot: string;
    MX: number;
    Nick: string;                // Server vẫn gửi field "Nick" (hiện đang chứa UUID)
    DisplayName?: string;        // Tên hiển thị (nếu server bổ sung sau)
    WinPopupUrl: string;
    Feature: string;
    LangID: string;
    SlotIcon: string;
    CountryFlagIcon: string;
    CTime: string;
}

/** Server Maintenance Message */
export interface ServerMaintenanceMessage {
    ServerUtc: string;
    ShutdownUtc: string;
    Title: string;
    Line1: string;
    Line2: string;
    RemainMinutes: number;
    DurationMinutes: number;
    Step: number;
}
