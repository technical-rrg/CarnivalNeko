/**
 * SymbolPack atlas — frame name = PS ID (1, 11, 21, 45, 81, …).
 * Dùng chung SlotMachine, PickGame, PayTable.
 */

import { assetManager, SpriteAtlas, SpriteFrame } from 'cc';
import { CLIENT_TO_PS, SymbolId } from './SlotTypes';
import { clientPickToPs } from './PickGameUtil';

export const SYMBOL_ATLAS_UUID = '8dbe097e-d812-4920-ac55-b5f62456e3b2';
export const SYMBOL_ATLAS_PATH = 'newTextures/symbols/SymbolPack';
export const SYMBOL_BUNDLE_NAME = 'MainBundle';

const SYMBOL_PS_OVERRIDES: Partial<Record<SymbolId, number>> = {
    [SymbolId.TRAIL_NORMAL]: 46,
};

export function getSymbolPackFrame(atlas: SpriteAtlas, psId: number): SpriteFrame | null {
    return atlas.getSpriteFrame(String(psId))
        ?? atlas.getSpriteFrame(`${psId}.png`)
        ?? null;
}

export function resolveSymbolPackAtlas(ref?: SpriteAtlas | null): SpriteAtlas | null {
    if (ref?.isValid) return ref;
    const bundle = assetManager.getBundle(SYMBOL_BUNDLE_NAME);
    return bundle?.get(SYMBOL_ATLAS_PATH, SpriteAtlas)
        ?? (assetManager.assets.get(SYMBOL_ATLAS_UUID) as SpriteAtlas | null)
        ?? null;
}

export function loadSymbolPackAtlas(
    onLoaded: (atlas: SpriteAtlas) => void,
    onError?: (err: Error | null) => void,
): void {
    const cached = resolveSymbolPackAtlas(null);
    if (cached) {
        onLoaded(cached);
        return;
    }
    const bundle = assetManager.getBundle(SYMBOL_BUNDLE_NAME);
    if (!bundle) {
        onError?.(new Error('MainBundle not loaded'));
        return;
    }
    bundle.load(SYMBOL_ATLAS_PATH, SpriteAtlas, (err, atlas) => {
        if (err || !atlas?.isValid) {
            onError?.(err ?? new Error('SymbolPack load failed'));
            return;
        }
        onLoaded(atlas);
    });
}

/** symbolFrames[SymbolId] cho reel / sticky / trail. */
export function buildSymbolFramesFromAtlas(atlas: SpriteAtlas): SpriteFrame[] {
    const frames: SpriteFrame[] = [];
    for (const [sidStr, ps] of Object.entries(CLIENT_TO_PS)) {
        const sid = Number(sidStr);
        const frame = getSymbolPackFrame(atlas, ps);
        if (frame) frames[sid] = frame;
    }
    for (const [sid, ps] of Object.entries(SYMBOL_PS_OVERRIDES)) {
        const frame = getSymbolPackFrame(atlas, ps as number);
        if (frame) frames[Number(sid)] = frame;
    }
    return frames;
}

export interface JackpotPickFrames {
    idle: SpriteFrame | null;
    mini: SpriteFrame | null;
    minor: SpriteFrame | null;
    major: SpriteFrame | null;
    grand: SpriteFrame | null;
    upgrade: SpriteFrame | null;
}

/** Pick Game frames theo PS ID (82 Grand, 83 Major, 84 Minor, 85 Mini). */
export function buildJackpotPickFrames(atlas: SpriteAtlas): JackpotPickFrames {
    return {
        idle: getSymbolPackFrame(atlas, clientPickToPs(SymbolId.JP_IDLE)),
        mini: getSymbolPackFrame(atlas, clientPickToPs(SymbolId.JP_MINI)),
        minor: getSymbolPackFrame(atlas, clientPickToPs(SymbolId.JP_MINOR)),
        major: getSymbolPackFrame(atlas, clientPickToPs(SymbolId.JP_MAJOR)),
        grand: getSymbolPackFrame(atlas, clientPickToPs(SymbolId.JP_GRAND)),
        upgrade: getSymbolPackFrame(atlas, clientPickToPs(SymbolId.JP_UPGRADE)),
    };
}
