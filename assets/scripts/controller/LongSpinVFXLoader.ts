/**
 * LongSpinVFXLoader — Lazy-load fxLongSpin.prefab (Spine Longspin) từ MainBundle.
 *
 * Tách khỏi Base.prefab — chỉ load khi LONG_SPIN_TRIGGERED.
 */

import { Node, Prefab, instantiate, assetManager, sp } from 'cc';
import { Log } from '../core/Logger';

const BUNDLE_NAME = 'MainBundle';
const DEFAULT_PREFAB_PATH = 'fxLongSpin';

export class LongSpinVFXLoader {
    private static _cachedPrefab: Prefab | null = null;
    private static _loading: Promise<Prefab | null> | null = null;

    /** Prefetch prefab (không instantiate). */
    static preload(): void {
        void LongSpinVFXLoader._loadPrefab();
    }

    /**
     * Load + instantiate dưới parent (thường SlotMachine), inactive.
     * Idempotent nếu parent đã có child fxLongSpin.
     */
    static ensure(parent: Node, prefabPath: string = DEFAULT_PREFAB_PATH): Promise<Node | null> {
        if (!parent?.isValid) return Promise.resolve(null);

        const existing = parent.getChildByName('fxLongSpin');
        if (existing?.isValid) {
            existing.active = false;
            return Promise.resolve(existing);
        }

        return LongSpinVFXLoader._loadPrefab(prefabPath).then((prefab) => {
            if (!prefab || !parent.isValid) return null;

            // Race: node đã được tạo bởi call song song
            const again = parent.getChildByName('fxLongSpin');
            if (again?.isValid) {
                again.active = false;
                return again;
            }

            const node = instantiate(prefab);
            node.name = 'fxLongSpin';
            node.active = false;
            parent.addChild(node);

            const skel = node.getComponent(sp.Skeleton);
            if (skel?.skeletonData) {
                const anim = skel.defaultAnimation || 'animation';
                skel.setAnimation(0, anim, true);
            }

            Log.d('[LongSpinVFXLoader] instantiated fxLongSpin');
            return node;
        });
    }

    private static _loadPrefab(path: string = DEFAULT_PREFAB_PATH): Promise<Prefab | null> {
        if (LongSpinVFXLoader._cachedPrefab?.isValid) {
            return Promise.resolve(LongSpinVFXLoader._cachedPrefab);
        }
        if (LongSpinVFXLoader._loading) return LongSpinVFXLoader._loading;

        LongSpinVFXLoader._loading = new Promise<Prefab | null>((resolve) => {
            const bundle = assetManager.getBundle(BUNDLE_NAME);
            if (!bundle) {
                Log.err(`[LongSpinVFXLoader] Bundle '${BUNDLE_NAME}' missing`);
                LongSpinVFXLoader._loading = null;
                resolve(null);
                return;
            }
            const p = (path || DEFAULT_PREFAB_PATH).trim();
            bundle.load(p, Prefab, (err, prefab) => {
                LongSpinVFXLoader._loading = null;
                if (err || !prefab) {
                    Log.err(`[LongSpinVFXLoader] Load failed: ${p}`, err);
                    resolve(null);
                    return;
                }
                LongSpinVFXLoader._cachedPrefab = prefab;
                Log.d(`[LongSpinVFXLoader] Prefab cached: ${p}`);
                resolve(prefab);
            });
        });
        return LongSpinVFXLoader._loading;
    }
}
