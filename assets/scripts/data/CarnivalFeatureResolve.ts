/**
 * CarnivalFeatureResolve — quyết định Pot nào nổ + Feature nào vào.
 * Dùng chung Mock + (sau này) Real API map từ server fields.
 */

import {
    CarnivalFeatureKind,
    CarnivalFeatureTrigger,
    CarnivalTrailHit,
    TrailColor,
    buildCarnivalFeatureTrigger,
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

function burstPotsForKind(kind: CarnivalFeatureKind): TrailColor[] {
    switch (kind) {
        case CarnivalFeatureKind.JACKPOT: return [TrailColor.RED];
        case CarnivalFeatureKind.MIGHTY: return [TrailColor.BLUE];
        case CarnivalFeatureKind.MEGA: return [TrailColor.GREEN];
        case CarnivalFeatureKind.SUPER: return [TrailColor.BLUE, TrailColor.GREEN];
        case CarnivalFeatureKind.ULTRA: return [TrailColor.BLUE, TrailColor.RED];
        case CarnivalFeatureKind.SUPREME: return [TrailColor.RED, TrailColor.GREEN];
        case CarnivalFeatureKind.ULTIMATE:
            return [TrailColor.BLUE, TrailColor.RED, TrailColor.GREEN];
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

    // Ưu tiên burst pots theo màu Trail vừa land (nếu match kind); fallback theo kind
    const colorsLanded = new Set(trails.map(t => t.color));
    let burst = burstPotsForKind(kind);
    // Đảm bảo hiển thị burst đúng màu design của kind
    if (burst.length === 0) {
        burst = [...colorsLanded];
    }

    data.carnivalTrailSpinCount = 0;
    return buildCarnivalFeatureTrigger(kind, burst);
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
