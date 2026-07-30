/**
 * GuideFrameLoader — preload guide slides độc lập với Base.prefab / GuideView.
 *
 * Dùng bởi LoadingController (trước LOADING_BAR_100) và GuideController (reuse cache).
 */
import { SpriteFrame, assetManager, AssetManager } from 'cc';
import { Log } from './Logger';

export const GUIDE_BUNDLE = 'MainBundle';

export const GUIDE_PORTRAIT_PATHS = [
    'newTextures/guide/Verticle/Guide1/spriteFrame',
    'newTextures/guide/Verticle/Guide2/spriteFrame',
    'newTextures/guide/Verticle/Guide3/spriteFrame',
    'newTextures/guide/Verticle/Guide4/spriteFrame',
    'newTextures/guide/Verticle/Guide5/spriteFrame',
    'newTextures/guide/Verticle/Guide6/spriteFrame',
] as const;

export const GUIDE_LANDSCAPE_PATHS = [
    'newTextures/guide/Guide1/spriteFrame',
    'newTextures/guide/Guide2/spriteFrame',
    'newTextures/guide/Guide3/spriteFrame',
    'newTextures/guide/Guide4/spriteFrame',
    'newTextures/guide/Guide5/spriteFrame',
    'newTextures/guide/Guide6/spriteFrame',
] as const;

export interface GuideFrames {
    portrait: SpriteFrame[];
    landscape: SpriteFrame[];
}

export class GuideFrameLoader {
    private static _promise: Promise<GuideFrames | null> | null = null;
    private static _cached: GuideFrames | null = null;

    static get cached(): GuideFrames | null {
        return GuideFrameLoader._cached;
    }

    static get isReady(): boolean {
        return !!GuideFrameLoader._cached
            && GuideFrameLoader._cached.portrait.length >= GUIDE_PORTRAIT_PATHS.length
            && GuideFrameLoader._cached.landscape.length >= GUIDE_LANDSCAPE_PATHS.length;
    }

    /** Preload (idempotent). Bundle phải đã load hoặc truyền vào. */
    static preload(bundle?: AssetManager.Bundle | null): Promise<GuideFrames | null> {
        if (GuideFrameLoader.isReady) {
            return Promise.resolve(GuideFrameLoader._cached);
        }
        // Cache thiếu slide mới (vd. thêm Guide6) → bỏ promise cũ, load lại
        if (GuideFrameLoader._cached
            && (GuideFrameLoader._cached.portrait.length < GUIDE_PORTRAIT_PATHS.length
                || GuideFrameLoader._cached.landscape.length < GUIDE_LANDSCAPE_PATHS.length)) {
            GuideFrameLoader._promise = null;
            GuideFrameLoader._cached = null;
        }
        if (GuideFrameLoader._promise) return GuideFrameLoader._promise;

        GuideFrameLoader._promise = new Promise<GuideFrames | null>((resolve) => {
            const b = bundle ?? assetManager.getBundle(GUIDE_BUNDLE);
            if (!b) {
                Log.w(`[GuideFrameLoader] Bundle '${GUIDE_BUNDLE}' missing`);
                GuideFrameLoader._promise = null;
                resolve(null);
                return;
            }
            const paths = [...GUIDE_PORTRAIT_PATHS, ...GUIDE_LANDSCAPE_PATHS];
            b.load(paths as unknown as string[], SpriteFrame, (err, assets) => {
                if (err || !assets) {
                    Log.w('[GuideFrameLoader] Load failed', err);
                    GuideFrameLoader._promise = null;
                    resolve(null);
                    return;
                }
                const list = assets as SpriteFrame[];
                GuideFrameLoader._cached = {
                    portrait: list.slice(0, GUIDE_PORTRAIT_PATHS.length),
                    landscape: list.slice(GUIDE_PORTRAIT_PATHS.length),
                };
                Log.d(`[GuideFrameLoader] Ready P=${GuideFrameLoader._cached.portrait.length} L=${GuideFrameLoader._cached.landscape.length}`);
                resolve(GuideFrameLoader._cached);
            });
        });
        return GuideFrameLoader._promise;
    }
}
