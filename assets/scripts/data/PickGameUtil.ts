/**
 * PickGameUtil — Carnival Neko Jackpot Feature (Pick Game).
 *
 * Doc: 5×3 = 15 ô; match 3 JP; 3 Upgrade → nâng tier (Grand → ×2).
 * Map PS ↔ client dùng chung cho MockAdapter + Real API parse.
 */

import { JackpotType, SymbolId } from './SlotTypes';

/** Lưới Pick Game theo design: 5 cột × 3 hàng. */
export const PICK_GAME_COLS = 5;
export const PICK_GAME_ROWS = 3;
export const PICK_GAME_CELL_COUNT = PICK_GAME_COLS * PICK_GAME_ROWS; // 15

/**
 * Server / PS Pick symbol IDs (backend remapped).
 * 81 Idle, 82 Grand, 83 Major, 84 Minor, 85 Mini, 86 Upgrade.
 */
export const PS_PICK = {
    IDLE: 81,
    GRAND: 82,
    MAJOR: 83,
    MINOR: 84,
    MINI: 85,
    UPGRADE: 86,
} as const;

export type PickTierName = 'GRAND' | 'MAJOR' | 'MINOR' | 'MINI';

/** JackpotIndex API: 0=Mini, 1=Minor, 2=Major, 3=Grand. */
export const JACKPOT_INDEX_TO_TYPE: Record<number, JackpotType> = {
    0: JackpotType.MINI,
    1: JackpotType.MINOR,
    2: JackpotType.MAJOR,
    3: JackpotType.GRAND,
};

export const JP_TYPE_TO_INDEX: Partial<Record<JackpotType, number>> = {
    [JackpotType.MINI]: 0,
    [JackpotType.MINOR]: 1,
    [JackpotType.MAJOR]: 2,
    [JackpotType.GRAND]: 3,
};

export const TIER_NAME_TO_TYPE: Record<PickTierName, JackpotType> = {
    MINI: JackpotType.MINI,
    MINOR: JackpotType.MINOR,
    MAJOR: JackpotType.MAJOR,
    GRAND: JackpotType.GRAND,
};

export const JP_TYPE_TO_TIER_NAME: Partial<Record<JackpotType, PickTierName>> = {
    [JackpotType.MINI]: 'MINI',
    [JackpotType.MINOR]: 'MINOR',
    [JackpotType.MAJOR]: 'MAJOR',
    [JackpotType.GRAND]: 'GRAND',
};

/** PS ID → client SymbolId (Pick only). Unselected / idle → JP_IDLE. */
export function psPickToClient(psId: number): number {
    switch (psId) {
        case PS_PICK.IDLE: return SymbolId.JP_IDLE;
        case PS_PICK.GRAND: return SymbolId.JP_GRAND;
        case PS_PICK.MAJOR: return SymbolId.JP_MAJOR;
        case PS_PICK.MINOR: return SymbolId.JP_MINOR;
        case PS_PICK.MINI: return SymbolId.JP_MINI;
        case PS_PICK.UPGRADE: return SymbolId.JP_UPGRADE;
        case -1: return SymbolId.JP_IDLE;
        default: return SymbolId.JP_IDLE;
    }
}

/** Client SymbolId → PS ID (Pick only). */
export function clientPickToPs(clientId: number): number {
    switch (clientId) {
        case SymbolId.JP_IDLE: return PS_PICK.IDLE;
        case SymbolId.JP_GRAND: return PS_PICK.GRAND;
        case SymbolId.JP_MAJOR: return PS_PICK.MAJOR;
        case SymbolId.JP_MINOR: return PS_PICK.MINOR;
        case SymbolId.JP_MINI: return PS_PICK.MINI;
        case SymbolId.JP_UPGRADE: return PS_PICK.UPGRADE;
        default: return PS_PICK.MINI;
    }
}

export function isPickJackpotSymbol(sym: number): boolean {
    return sym === SymbolId.JP_MINI
        || sym === SymbolId.JP_MINOR
        || sym === SymbolId.JP_MAJOR
        || sym === SymbolId.JP_GRAND;
}

export function isPickUpgradeSymbol(sym: number): boolean {
    return sym === SymbolId.JP_UPGRADE;
}

export function clientSymToJackpotType(sym: number): JackpotType {
    switch (sym) {
        case SymbolId.JP_MINI: return JackpotType.MINI;
        case SymbolId.JP_MINOR: return JackpotType.MINOR;
        case SymbolId.JP_MAJOR: return JackpotType.MAJOR;
        case SymbolId.JP_GRAND: return JackpotType.GRAND;
        default: return JackpotType.NONE;
    }
}

/**
 * Nâng tier khi đã đủ 3 Upgrade trước khi match 3 JP.
 * Grand + upgrade → vẫn GRAND nhưng doubleGrand = true.
 */
export function applyPickUpgrade(
    matched: JackpotType,
    upgradeArmed: boolean,
): { paidTier: JackpotType; doubleGrand: boolean } {
    if (!upgradeArmed || matched === JackpotType.NONE) {
        return { paidTier: matched, doubleGrand: false };
    }
    switch (matched) {
        case JackpotType.MINI:  return { paidTier: JackpotType.MINOR, doubleGrand: false };
        case JackpotType.MINOR: return { paidTier: JackpotType.MAJOR, doubleGrand: false };
        case JackpotType.MAJOR: return { paidTier: JackpotType.GRAND, doubleGrand: false };
        case JackpotType.GRAND: return { paidTier: JackpotType.GRAND, doubleGrand: true };
        default: return { paidTier: matched, doubleGrand: false };
    }
}

export interface PickResolveResult {
    /** Đã match 3 JP (sau lần pick này). */
    isJackpot: boolean;
    /** Tier của 3 symbol match (trước upgrade). */
    matchedTier: JackpotType;
    /** Tier trả thưởng (sau upgrade). */
    paidTier: JackpotType;
    /** Grand ×2. */
    doubleGrand: boolean;
    /** Vừa đủ 3 Upgrade ở lần pick này. */
    upgradeJustCompleted: boolean;
    /** Tổng Upgrade đã reveal. */
    upgradeCount: number;
    /** Đã armed upgrade (đủ 3). */
    upgradeArmed: boolean;
    /** JackpotIndex API (-1 nếu chưa win). */
    jackpotIndex: number;
}

/**
 * Resolve trạng thái sau khi reveal thêm các index trong `revealed`.
 * `grid` dùng client SymbolId.
 */
export function resolvePickState(
    grid: number[],
    revealed: number[],
    prevUpgradeArmed: boolean = false,
): PickResolveResult {
    const tierCounts: Partial<Record<JackpotType, number>> = {
        [JackpotType.MINI]: 0,
        [JackpotType.MINOR]: 0,
        [JackpotType.MAJOR]: 0,
        [JackpotType.GRAND]: 0,
    };
    let upgradeCount = 0;

    for (const idx of revealed) {
        const sym = grid[idx];
        if (sym == null) continue;
        if (isPickUpgradeSymbol(sym)) {
            upgradeCount++;
            continue;
        }
        const tier = clientSymToJackpotType(sym);
        if (tier !== JackpotType.NONE) {
            tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
        }
    }

    const upgradeArmed = prevUpgradeArmed || upgradeCount >= 3;
    const upgradeJustCompleted = !prevUpgradeArmed && upgradeCount >= 3;

    let matchedTier = JackpotType.NONE;
    for (const t of [JackpotType.MINI, JackpotType.MINOR, JackpotType.MAJOR, JackpotType.GRAND]) {
        if ((tierCounts[t] ?? 0) >= 3) {
            matchedTier = t;
            break;
        }
    }

    const isJackpot = matchedTier !== JackpotType.NONE;
    const { paidTier, doubleGrand } = applyPickUpgrade(matchedTier, upgradeArmed && isJackpot);
    const jackpotIndex = isJackpot ? (JP_TYPE_TO_INDEX[paidTier] ?? 0) : -1;

    return {
        isJackpot,
        matchedTier,
        paidTier,
        doubleGrand,
        upgradeJustCompleted,
        upgradeCount,
        upgradeArmed,
        jackpotIndex,
    };
}
