/**
 * GuideShellLoader — load/show GuideView.prefab độc lập với Base.prefab.
 *
 * Guide-first boot: hiện Guide ngay khi Login + frames sẵn; Base load nền.
 */
import { Node, Prefab, instantiate, assetManager, AssetManager } from 'cc';
import { Log } from './Logger';
import { GuideController } from '../controller/GuideController';

export const GUIDE_SHELL_BUNDLE = 'MainBundle';
export const GUIDE_SHELL_PREFAB_PATH = 'GuideView';

export class GuideShellLoader {
    private static _prefabPromise: Promise<Prefab | null> | null = null;
    private static _cachedPrefab: Prefab | null = null;
    private static _instance: Node | null = null;

    static get instance(): Node | null {
        return GuideShellLoader._instance?.isValid ? GuideShellLoader._instance : null;
    }

    static get isShowing(): boolean {
        const n = GuideShellLoader.instance;
        return !!n && n.active;
    }

    /** Sharenode trong shell — reparent sang GameRoot khi Guide xong. */
    static get sharedNode(): Node | null {
        const root = GuideShellLoader.instance;
        if (!root) return null;
        return root.getChildByName('Sharenode')
            ?? root.getChildByName('ShareNode')
            ?? root.getChildByName('sharedNode');
    }

    /** Logo spine (TitleGame) trên Guide — reparent sang GameRoot Logo slot. */
    static get logoNode(): Node | null {
        const root = GuideShellLoader.instance;
        if (!root) return null;
        return root.getChildByName('Logo');
    }

    static preload(bundle?: AssetManager.Bundle | null): Promise<Prefab | null> {
        if (GuideShellLoader._cachedPrefab?.isValid) {
            return Promise.resolve(GuideShellLoader._cachedPrefab);
        }
        if (GuideShellLoader._prefabPromise) return GuideShellLoader._prefabPromise;

        GuideShellLoader._prefabPromise = new Promise<Prefab | null>((resolve) => {
            const b = bundle ?? assetManager.getBundle(GUIDE_SHELL_BUNDLE);
            if (!b) {
                Log.w(`[GuideShellLoader] Bundle '${GUIDE_SHELL_BUNDLE}' missing`);
                GuideShellLoader._prefabPromise = null;
                resolve(null);
                return;
            }
            b.load(GUIDE_SHELL_PREFAB_PATH, Prefab, (err, prefab) => {
                if (err || !prefab) {
                    Log.w('[GuideShellLoader] Prefab load failed', err);
                    GuideShellLoader._prefabPromise = null;
                    resolve(null);
                    return;
                }
                GuideShellLoader._cachedPrefab = prefab;
                Log.d(`[GuideShellLoader] Prefab cached: ${GUIDE_SHELL_PREFAB_PATH}`);
                resolve(prefab);
            });
        });
        return GuideShellLoader._prefabPromise;
    }

    /**
     * Instantiate (inactive) dưới parent — gọi trước bar 100%.
     * Idempotent nếu đã có instance.
     */
    static async attach(parent: Node): Promise<Node | null> {
        if (GuideShellLoader.instance) {
            if (GuideShellLoader._instance!.parent !== parent) {
                GuideShellLoader._instance!.setParent(parent);
            }
            return GuideShellLoader._instance;
        }

        const prefab = await GuideShellLoader.preload();
        if (!prefab || !parent?.isValid) return null;

        const node = instantiate(prefab);
        node.name = 'GuideView';
        node.active = false;
        parent.addChild(node);
        GuideShellLoader._instance = node;
        Log.d('[GuideShellLoader] Attached (inactive)');
        return node;
    }

    /**
     * Bật GuideView — kích hoạt GuideController.onEnable.
     * @param deferEntranceFade true → giữ màn đen, chờ GuideController.beginEntranceFade()
     */
    static show(deferEntranceFade: boolean = false): Node | null {
        const node = GuideShellLoader.instance;
        if (!node) {
            Log.e('[GuideShellLoader] show() — no instance');
            return null;
        }
        if (deferEntranceFade) {
            GuideController.markDeferEntranceFade(node);
        }
        node.active = true;
        node.setSiblingIndex(node.parent!.children.length - 1);
        Log.d(`[GuideShellLoader] Shown (deferEntranceFade=${deferEntranceFade})`);
        return node;
    }

    static getController(): GuideController | null {
        const node = GuideShellLoader.instance;
        return node?.getComponent(GuideController) ?? null;
    }

    /** Đưa shell lên trên cùng (không đổi overlay) — dùng khi warm Base lúc đang xem Guide. */
    static bringToFront(): void {
        const node = GuideShellLoader.instance;
        if (!node?.isValid || !node.parent) return;
        node.setSiblingIndex(node.parent.children.length - 1);
    }

    /** Đưa shell lên trên + ép OverLay đen (che Base đang load sau Continue). */
    static holdBlackOnTop(): void {
        GuideShellLoader.bringToFront();
        GuideShellLoader.getController()?.holdBlackOverlay();
    }

    /**
     * Fade fill đen → trong suốt (lộ GameRoot phía dưới) rồi dismiss shell.
     * Chỉ gọi SAU khi Base + GameRoot đã sẵn dưới lớp đen.
     */
    static fadeRevealAndDismiss(): Promise<void> {
        return new Promise((resolve) => {
            const node = GuideShellLoader.instance;
            const gc = GuideShellLoader.getController();
            if (!node || !gc) {
                GuideShellLoader.dismiss();
                resolve();
                return;
            }
            // Guide (fill đen) phải ở trên GameRoot trong lúc fade lộ
            GuideShellLoader.holdBlackOnTop();
            gc.beginRevealFade(() => {
                GuideShellLoader.dismiss();
                resolve();
            });
        });
    }

    /** Tắt + destroy shell (sau khi reparent sharedNode nếu cần). */
    static dismiss(): void {
        const node = GuideShellLoader._instance;
        GuideShellLoader._instance = null;
        if (!node?.isValid) return;
        // Đảm bảo GuideController không bị re-enable
        const gc = node.getComponent(GuideController);
        node.active = false;
        node.destroy();
        Log.d(`[GuideShellLoader] Dismissed (gc=${!!gc})`);
    }
}
