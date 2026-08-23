/**
 * PickGameUtil — Carnival Neko Jackpot Feature (Pick Game).
 *
 * ID mới (Jackpot Symbol ID Change 260810):
 *   81 Idle, 82 Grand, 83 Major, 84 Minor, 85 Mini, 86 Upgrade
 */

import { JackpotType, SymbolId } from './SlotTypes';
import { GameData } from './GameData';

/** Lưới Pick Game theo design: 5 cột × 3 hàng. */
export const PICK_GAME_COLS = 5;
export const PICK_GAME_ROWS = 3;
export const PICK_GAME_CELL_COUNT = PICK_GAME_COLS * PICK_GAME_ROWS; // 15

/** Default PS Pick IDs — 수정 후 ID (Major=83, Minor=84). */
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

/** CNPickResponse.JackpotName: “MINI”/“MINOR”/“MAJOR”/“GRAND” (empty nếu chưa match). */
export function parseCnJackpotName(raw: unknown): JackpotType {
    const name = String(raw ?? '').trim().toUpperCase();
    if (!name) return JackpotType.NONE;
    if (name.includes('GRAND')) return JackpotType.GRAND;
    if (name.includes('MAJOR')) return JackpotType.MAJOR;
    if (name.includes('MINOR')) return JackpotType.MINOR;
    if (name.includes('MINI')) return JackpotType.MINI;
    return JackpotType.NONE;
}

export const JP_TYPE_TO_TIER_NAME: Partial<Record<JackpotType, PickTierName>> = {
    [JackpotType.MINI]: 'MINI',
    [JackpotType.MINOR]: 'MINOR',
    [JackpotType.MAJOR]: 'MAJOR',
    [JackpotType.GRAND]: 'GRAND',
};

const _FALLBACK_PS_TO_CLIENT: Record<number, number> = {
    [PS_PICK.IDLE]: SymbolId.JP_IDLE,
    [PS_PICK.MINI]: SymbolId.JP_MINI,
    [PS_PICK.MINOR]: SymbolId.JP_MINOR,
    [PS_PICK.MAJOR]: SymbolId.JP_MAJOR,
    [PS_PICK.GRAND]: SymbolId.JP_GRAND,
    [PS_PICK.UPGRADE]: SymbolId.JP_UPGRADE,
    [-1]: SymbolId.JP_IDLE,
};

const _JP_CLIENT_IDS = new Set<number>([
    SymbolId.JP_IDLE,
    SymbolId.JP_MINI,
    SymbolId.JP_MINOR,
    SymbolId.JP_MAJOR,
    SymbolId.JP_GRAND,
    SymbolId.JP_UPGRADE,
]);

/** PS ID → client SymbolId (Pick only). Ưu tiên map từ Enter/PS named fields. */
export function psPickToClient(psId: number): number {
    if (psId === -1) return SymbolId.JP_IDLE;

    const dyn = GameData.instance?.psToClientMap;
    if (dyn && typeof dyn[psId] === 'number' && _JP_CLIENT_IDS.has(dyn[psId])) {
        return dyn[psId];
    }

    return _FALLBACK_PS_TO_CLIENT[psId] ?? SymbolId.JP_IDLE;
}

/** Client SymbolId → PS ID (Pick only). */
export function clientPickToPs(clientId: number): number {
    const dyn = GameData.instance?.psToClientMap;
    if (dyn) {
        for (const [psStr, cid] of Object.entries(dyn)) {
            if (cid === clientId && _JP_CLIENT_IDS.has(cid)) {
                return parseInt(psStr, 10);
            }
        }
    }

    switch (clientId) {
        case SymbolId.JP_IDLE: return PS_PICK.IDLE;
        case SymbolId.JP_MINI: return PS_PICK.MINI;
        case SymbolId.JP_MINOR: return PS_PICK.MINOR;
        case SymbolId.JP_MAJOR: return PS_PICK.MAJOR;
        case SymbolId.JP_GRAND: return PS_PICK.GRAND;
        case SymbolId.JP_UPGRADE: return PS_PICK.UPGRADE;
        default: return PS_PICK.MINI;
    }
}

/** PS Idle id (từ map hoặc default 81) — dùng skip unrevealed. */
export function psPickIdleId(): number {
    const dyn = GameData.instance?.psToClientMap;
    if (dyn) {
        for (const [psStr, cid] of Object.entries(dyn)) {
            if (cid === SymbolId.JP_IDLE) return parseInt(psStr, 10);
        }
    }
    return PS_PICK.IDLE;
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

/** JackpotType → PS Pick ID (82 Grand … 85 Mini). */
export function jackpotTypeToPickPsId(type: JackpotType): number {
    switch (type) {
        case JackpotType.GRAND: return PS_PICK.GRAND;
        case JackpotType.MAJOR: return PS_PICK.MAJOR;
        case JackpotType.MINOR: return PS_PICK.MINOR;
        case JackpotType.MINI:  return PS_PICK.MINI;
        default: return PS_PICK.MINI;
    }
}

/** Client SymbolId → PS Pick ID (82–86). Upgrade=86; idle/unknown → 81. */
export function clientSymToPickPsId(sym: number): number {
    if (isPickUpgradeSymbol(sym)) return PS_PICK.UPGRADE;
    const tier = clientSymToJackpotType(sym);
    if (tier !== JackpotType.NONE) return jackpotTypeToPickPsId(tier);
    return PS_PICK.IDLE;
}

/** Spine anim lật symbol: `82_Transition`, `86_Transition`, … */
export function pickPsTransitionAnim(psId: number): string {
    return `${psId}_Transition`;
}

/** Spine anim idle sau lật: `82_Idle`, `86_Idle`, … */
export function pickPsIdleAnim(psId: number): string {
    return `${psId}_Idle`;
}

export function isPickPsTransitionAnim(animName: string | null | undefined): boolean {
    return !!animName && /^\d+_Transition$/.test(animName);
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
