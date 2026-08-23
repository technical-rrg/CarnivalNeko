/**
 * CarnivalFeatureResolve — quyết định Pot nào nổ + Feature nào vào.
 * Dùng chung Mock + (sau này) Real API map từ server fields.
 */

import {
    CarnivalFeatureKind,
    CarnivalFeatureTrigger,
    CarnivalTrailHit,
    TrailColor,
    SlotStageType,
    buildCarnivalFeatureTrigger,
    carnivalKindFromApiFeatureType,
} from './SlotTypes';
import { GameData } from './GameData';
import {
    MOCK_CARNIVAL_FEATURE_TRIGGER,
    MOCK_CARNIVAL_FEATURE_EVERY_N_SPINS,
    MockCarnivalFeatureMode,
} from './ServerConfig';

const CYCLE_KINDS: CarnivalFeatureKind[] = [
    CarnivalFeatureKind.JACKPOT,
    CarnivalFeatureKind.MIGHTY,
    CarnivalFeatureKind.MEGA,
    CarnivalFeatureKind.SUPER,
    CarnivalFeatureKind.ULTRA,
    CarnivalFeatureKind.SUPREME,
    CarnivalFeatureKind.ULTIMATE,
];

/**
 * API CurrentFeatureType 0–5 → pot nhún khi kích hoạt Matsuri.
 * 0 Mighty Blue | 1 Mega Green | 2 Super Blue+Green |
 * 3 Ultra Blue+Red | 4 Supreme Red+Green | 5 Ultimate Blue+Red+Green
 */
export function burstPotsForApiFeatureType(apiType: number): TrailColor[] {
    switch (apiType) {
        case 0: return [TrailColor.BLUE];
        case 1: return [TrailColor.GREEN];
        case 2: return [TrailColor.BLUE, TrailColor.GREEN];
        case 3: return [TrailColor.BLUE, TrailColor.RED];
        case 4: return [TrailColor.RED, TrailColor.GREEN];
        case 5: return [TrailColor.BLUE, TrailColor.RED, TrailColor.GREEN];
        default: return [];
    }
}

/** Pot nhún theo CarnivalFeatureKind — 6 Matsuri + Jackpot Red. */
export function burstPotsForKind(kind: CarnivalFeatureKind): TrailColor[] {
    switch (kind) {
        case CarnivalFeatureKind.JACKPOT: return [TrailColor.RED];
        case CarnivalFeatureKind.MIGHTY: return burstPotsForApiFeatureType(0);
        case CarnivalFeatureKind.MEGA: return burstPotsForApiFeatureType(1);
        case CarnivalFeatureKind.SUPER: return burstPotsForApiFeatureType(2);
        case CarnivalFeatureKind.ULTRA: return burstPotsForApiFeatureType(3);
        case CarnivalFeatureKind.SUPREME: return burstPotsForApiFeatureType(4);
        case CarnivalFeatureKind.ULTIMATE: return burstPotsForApiFeatureType(5);
        default: return [];
    }
}

function kindFromMode(mode: MockCarnivalFeatureMode): CarnivalFeatureKind {
    switch (mode) {
        case 'red': return CarnivalFeatureKind.JACKPOT;
        case 'blue': return CarnivalFeatureKind.MIGHTY;
        case 'green': return CarnivalFeatureKind.MEGA;
        case 'blue_green': return CarnivalFeatureKind.SUPER;
        case 'blue_red': return CarnivalFeatureKind.ULTRA;
        case 'red_green': return CarnivalFeatureKind.SUPREME;
        case 'all': return CarnivalFeatureKind.ULTIMATE;
        default: return CarnivalFeatureKind.NONE;
    }
}

function nextCycleKind(): CarnivalFeatureKind {
    const data = GameData.instance;
    const kind = CYCLE_KINDS[data.carnivalFeatureCycleIndex % CYCLE_KINDS.length];
    data.carnivalFeatureCycleIndex++;
    return kind;
}

/**
 * Resolve feature từ trails spin này + mock mode.
 * Trả null nếu không trigger.
 */
export function resolveMockCarnivalFeature(
    trails: CarnivalTrailHit[],
): CarnivalFeatureTrigger | null {
    if (!trails.length) return null;

    const data = GameData.instance;
    data.carnivalTrailSpinCount++;

    const mode = MOCK_CARNIVAL_FEATURE_TRIGGER;
    if (mode === 'none') return null;

    let kind = CarnivalFeatureKind.NONE;

    if (mode === 'cycle') {
        kind = nextCycleKind();
    } else if (mode === 'auto') {
        const every = Math.max(1, MOCK_CARNIVAL_FEATURE_EVERY_N_SPINS);
        if (data.carnivalTrailSpinCount < every) return null;
        data.carnivalTrailSpinCount = 0;
        kind = nextCycleKind();
    } else {
        kind = kindFromMode(mode);
    }

    if (kind === CarnivalFeatureKind.NONE) return null;

    data.carnivalTrailSpinCount = 0;
    return buildCarnivalFeatureTrigger(kind, burstPotsForKind(kind));
}

/**
 * Real API: dựng CarnivalFeatureTrigger từ CNSpinResponse (V1.0.2).
 * CurrentFeatureType 0–5 = Mighty→Ultimate (Matsuri trước; Ultra+ Pick sau Claim).
 * PICK_START + type −1 (hoặc thiếu type) + có PickGame → Jackpot Red-only.
 */
export function buildCarnivalFeatureFromSpin(anyRes: any, nextStage: number): CarnivalFeatureTrigger | null {
    const apiType = anyRes?.CurrentFeatureType ?? anyRes?.currentFeatureType;
    const stage = nextStage as SlotStageType;
    const isPick = stage === SlotStageType.PICK_START || stage === SlotStageType.PICK
        || stage === SlotStageType.POT_WIN;
    const isFsStart = stage === SlotStageType.FREE_SPIN_START
        || stage === SlotStageType.CARNIVAL_MATSURI_START;

    let kind = CarnivalFeatureKind.NONE;
    if (apiType != null && Number(apiType) >= 0) {
        kind = carnivalKindFromApiFeatureType(Number(apiType));
    } else if (isPick && (anyRes?.PickGame || anyRes?.pickGame)) {
        kind = CarnivalFeatureKind.JACKPOT;
    } else if (isFsStart) {
        // FREE_SPIN_START nhưng thiếu type — fallback Mighty 5×3
        kind = CarnivalFeatureKind.MIGHTY;
    }

    if (kind === CarnivalFeatureKind.NONE) return null;

    const featureRows = anyRes?.FeatureRows ?? anyRes?.featureRows;
    const trigger = buildCarnivalFeatureTrigger(kind, burstPotsForKind(kind));
    if (!trigger) return null;

    if (featureRows != null && Number(featureRows) > 0) {
        trigger.matsuriRows = Math.max(3, Math.min(5, Number(featureRows)));
    }

    const starter = anyRes?.StarterCoins ?? anyRes?.starterCoins;
    if (Array.isArray(starter) && starter.length > 0) {
        trigger.startCoins = starter.length;
    }

    return trigger;
}

/** Reset accumulated + level của các pot vừa nổ. */
export function resetBurstPotState(burstPots: TrailColor[]): void {
    const data = GameData.instance;
    for (const c of burstPots) {
        if (c === TrailColor.BLUE) {
            data.trailAccumulated.blue = 0;
            data.potLevels.blue = 0;
        } else if (c === TrailColor.RED) {
            data.trailAccumulated.red = 0;
            data.potLevels.red = 0;
        } else if (c === TrailColor.GREEN) {
            data.trailAccumulated.green = 0;
            data.potLevels.green = 0;
        }
    }
}
