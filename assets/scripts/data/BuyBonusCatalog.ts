/**
 * Buy Bonus catalog — Carnival Neko System Design (Buy Bonus Pop-up).
 * 3 purchasable products → Matsuri Hold&Spin với grid 5×3 / 5×4 / 5×5.
 */

import {
    CarnivalFeatureKind,
    FeatureItem,
    IBonusItem,
    TrailColor,
    buildCarnivalFeatureTrigger,
    CarnivalFeatureTrigger,
} from './SlotTypes';

/** Mock / fallback itemId — map sang CarnivalFeatureKind. */
export const BUY_BONUS_ITEM_IDS = {
    MIGHTY: 201,
    MEGA: 202,
    SUPER: 203,
} as const;

export interface BuyBonusProductDef {
    itemId: number;
    kind: CarnivalFeatureKind;
    title: string;
    /** Mô tả ngắn — Doc: product description + grid hint */
    desc: string;
    /** Price = totalBet × priceRatio */
    priceRatio: number;
    /** Grid rows sau khi mua (3/4/5) */
    matsuriRows: number;
}

/** 3 gói theo design: MIGHTY / MEGA / SUPER FEATURE */
export const BUY_BONUS_PRODUCTS: readonly BuyBonusProductDef[] = [
    {
        itemId: BUY_BONUS_ITEM_IDS.MIGHTY,
        kind: CarnivalFeatureKind.MIGHTY,
        title: 'MIGHTY FEATURE',
        desc: 'Purchase Mighty Feature.\nPlay on a 5 x 3 grid.',
        priceRatio: 50,
        matsuriRows: 3,
    },
    {
        itemId: BUY_BONUS_ITEM_IDS.MEGA,
        kind: CarnivalFeatureKind.MEGA,
        title: 'MEGA FEATURE',
        desc: 'Purchase Mega Feature.\nPlay on a 5 x 4 grid.',
        priceRatio: 100,
        matsuriRows: 4,
    },
    {
        itemId: BUY_BONUS_ITEM_IDS.SUPER,
        kind: CarnivalFeatureKind.SUPER,
        title: 'SUPER FEATURE',
        desc: 'Purchase Super Feature.\nPlay on a 5 x 5 grid.',
        priceRatio: 150,
        matsuriRows: 5,
    },
];

const KIND_BY_ITEM_ID = new Map<number, CarnivalFeatureKind>(
    BUY_BONUS_PRODUCTS.map(p => [p.itemId, p.kind]),
);

const RATIO_BY_ITEM_ID = new Map<number, number>(
    BUY_BONUS_PRODUCTS.map(p => [p.itemId, p.priceRatio]),
);

export function carnivalKindFromBuyBonusItemId(itemId: number): CarnivalFeatureKind | null {
    return KIND_BY_ITEM_ID.get(itemId) ?? null;
}

/** Fallback map theo title/name khi server dùng Id khác mock (201/202/203). */
export function carnivalKindFromBuyBonusTitle(title: string | null | undefined): CarnivalFeatureKind | null {
    if (!title) return null;
    const t = title.toUpperCase();
    if (t.includes('SUPER')) return CarnivalFeatureKind.SUPER;
    if (t.includes('MEGA')) return CarnivalFeatureKind.MEGA;
    if (t.includes('MIGHTY')) return CarnivalFeatureKind.MIGHTY;
    return null;
}

export function priceRatioForBuyBonusItemId(itemId: number, fallback = 100): number {
    return RATIO_BY_ITEM_ID.get(itemId) ?? fallback;
}

function burstPotsForKind(kind: CarnivalFeatureKind): TrailColor[] {
    switch (kind) {
        case CarnivalFeatureKind.MIGHTY: return [TrailColor.BLUE];
        case CarnivalFeatureKind.MEGA: return [TrailColor.GREEN];
        case CarnivalFeatureKind.SUPER: return [TrailColor.BLUE, TrailColor.GREEN];
        default: return [];
    }
}

/** Tạo CarnivalFeatureTrigger từ CarnivalFeatureKind (null nếu không phải Mighty/Mega/Super). */
export function buildBuyBonusMatsuriTriggerFromKind(
    kind: CarnivalFeatureKind | null | undefined,
): CarnivalFeatureTrigger | null {
    if (
        kind !== CarnivalFeatureKind.MIGHTY
        && kind !== CarnivalFeatureKind.MEGA
        && kind !== CarnivalFeatureKind.SUPER
    ) {
        return null;
    }
    return buildCarnivalFeatureTrigger(kind, burstPotsForKind(kind));
}

/** Tạo CarnivalFeatureTrigger từ itemId Buy Bonus (null nếu không phải Mighty/Mega/Super). */
export function buildBuyBonusMatsuriTrigger(itemId: number): CarnivalFeatureTrigger | null {
    return buildBuyBonusMatsuriTriggerFromKind(carnivalKindFromBuyBonusItemId(itemId));
}

export function toFeatureItems(): FeatureItem[] {
    return BUY_BONUS_PRODUCTS.map(p => ({
        itemId: p.itemId,
        name: p.title,
        title: p.title,
        desc: p.desc,
        priceRatio: p.priceRatio,
        effectType: 1, // Ticket / onceuse
        imgUrl: '',
        addSpinValue: null,
        carnivalKind: p.kind,
    }));
}

export function toBonusItems(): IBonusItem[] {
    return BUY_BONUS_PRODUCTS.map(p => ({
        uniqueID: String(p.itemId),
        itemName: p.title,
        itemInfo: p.desc,
        applyType: 'onceuse',
        valueRatio: p.priceRatio,
        thumbnailImage: '',
        carnivalKind: p.kind,
    }));
}
