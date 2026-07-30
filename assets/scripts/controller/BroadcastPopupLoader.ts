/**
 * BroadcastPopupLoader — Lazy-load BroadcastPopup prefab từ MainBundle.
 *
 * ── MỤC ĐÍCH ──
 *   BroadcastPopup tách khỏi Base.prefab — load khi boot, gắn sibling index cuối.
 *   Wire PosFrom/PosTo từ Base root (marker layout vẫn trên Base).
 *
 * ── FLOW ──
 *   LOADING_COMPLETE → preload nền
 *   BROADCAST_WIN_MESSAGE → ensureLoaded + queue nếu chưa có manager
 */

import { _decorator, Component, Node, Prefab, instantiate, assetManager } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { Log } from '../core/Logger';
import { ServerWinBroadcast } from '../data/SlotTypes';
import { BroadcastManager } from './BroadcastPopup';

const { ccclass, property } = _decorator;

const BUNDLE_NAME = 'MainBundle';
const DEFAULT_PREFAB_PATH = 'BroadcastPopup';
const POS_FROM_NAME = 'PosFrom';
const POS_TO_NAME = 'PosTo';

@ccclass('BroadcastPopupLoader')
export class BroadcastPopupLoader extends Component {

    @property({
        type: Node,
        tooltip: 'Node cha gắn BroadcastPopup (thường là Base root). Null = node của loader.',
    })
    shellParent: Node | null = null;

    @property({
        tooltip: 'Path Prefab trong MainBundle (không extension).',
    })
    prefabPath: string = DEFAULT_PREFAB_PATH;

    private _instance: Node | null = null;
    private _manager: BroadcastManager | null = null;
    private _loading: Promise<BroadcastManager | null> | null = null;
    private _cachedPrefab: Prefab | null = null;
    private _pendingMessages: ServerWinBroadcast[] = [];
    private _gameReady = false;

    init(shellParent: Node): void {
        this.shellParent = shellParent;
    }

    onLoad(): void {
        EventBus.instance.on(GameEvents.LOADING_COMPLETE, this._onPreload, this);
        EventBus.instance.on(GameEvents.BROADCAST_WIN_MESSAGE, this._onBroadcastMessage, this);
        EventBus.instance.on(GameEvents.GAME_READY, this._onGameReady, this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    get manager(): BroadcastManager | null {
        return this._manager?.isValid ? this._manager : null;
    }

    preload(): void {
        void this.ensureLoaded();
    }

    ensureLoaded(): Promise<BroadcastManager | null> {
        if (this._manager?.isValid && this._instance?.isValid) {
            this._ensureLastSibling();
            return Promise.resolve(this._manager);
        }
        if (this._loading) return this._loading;

        this._loading = this._loadAndInstantiate().finally(() => {
            this._loading = null;
        });
        return this._loading;
    }

    private _onPreload(): void {
        this.preload();
    }

    private _onGameReady(): void {
        this._gameReady = true;
        this._manager?.syncGameReady(true);
    }

    /** Queue message nếu manager chưa load — tránh miss emit trước onLoad. */
    private _onBroadcastMessage(message: ServerWinBroadcast): void {
        if (this._manager?.isValid) return;

        this._pendingMessages.push(message);
        void this.ensureLoaded().then((mgr) => {
            if (mgr) this._finishSetup(mgr);
        });
    }

    private _loadAndInstantiate(): Promise<BroadcastManager | null> {
        return new Promise((resolve) => {
            const finish = (prefab: Prefab | null) => {
                if (!prefab || !this.isValid) {
                    resolve(null);
                    return;
                }

                this._cachedPrefab = prefab;
                const parent = this.shellParent ?? this.node;

                const instance = instantiate(prefab);
                instance.name = 'BroadcastPopup';
                instance.active = true;
                parent.addChild(instance);
                this._ensureLastSibling();

                const mgr = instance.getComponent(BroadcastManager)
                    ?? instance.getComponentInChildren(BroadcastManager);
                if (!mgr) {
                    Log.e('[BroadcastPopupLoader] Prefab thiếu BroadcastManager');
                    instance.destroy();
                    resolve(null);
                    return;
                }

                this._instance = instance;
                this._manager = mgr;
                this._finishSetup(mgr);

                Log.d('[BroadcastPopupLoader] instantiated BroadcastPopup (active, last sibling)');
                resolve(mgr);
            };

            if (this._cachedPrefab) {
                finish(this._cachedPrefab);
                return;
            }

            const bundle = assetManager.getBundle(BUNDLE_NAME);
            if (!bundle) {
                Log.e(`[BroadcastPopupLoader] Bundle '${BUNDLE_NAME}' chưa load`);
                resolve(null);
                return;
            }

            const path = (this.prefabPath || DEFAULT_PREFAB_PATH).trim();
            bundle.load(path, Prefab, (err: Error | null, prefab: Prefab) => {
                if (err || !prefab) {
                    Log.e(`[BroadcastPopupLoader] Load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                Log.d(`[BroadcastPopupLoader] Prefab loaded: ${path}`);
                finish(prefab);
            });
        });
    }

    private _finishSetup(mgr: BroadcastManager): void {
        this._wirePositionMarkers(mgr);
        mgr.syncGameReady(this._gameReady);
        this._flushPending(mgr);
    }

    /** PosFrom/PosTo vẫn nằm trên Base root sau khi tách BroadcastPopup prefab. */
    private _wirePositionMarkers(mgr: BroadcastManager): void {
        const parent = this.shellParent ?? this.node;
        const posFrom = this._findChildByName(parent, POS_FROM_NAME);
        const posTo = this._findChildByName(parent, POS_TO_NAME);
        if (!posFrom || !posTo) {
            Log.w(`[BroadcastPopupLoader] Thiếu ${POS_FROM_NAME}/${POS_TO_NAME} trên Base — broadcast slide có thể sai vị trí`);
        }
        mgr.bindPositionMarkers(posFrom, posTo);
    }

    private _flushPending(mgr: BroadcastManager): void {
        if (!this._pendingMessages.length) return;
        const pending = this._pendingMessages.splice(0);
        Log.d(`[BroadcastPopupLoader] replay ${pending.length} pending broadcast(s)`);
        for (const msg of pending) {
            mgr.deliverMessage(msg);
        }
    }

    private _findChildByName(root: Node, name: string): Node | null {
        if (root.name === name) return root;
        for (const child of root.children) {
            const found = this._findChildByName(child, name);
            if (found) return found;
        }
        return null;
    }

    /** BroadcastPopup luôn ở sibling index cuối trên shell parent. */
    private _ensureLastSibling(): void {
        const node = this._instance;
        const parent = this.shellParent ?? this.node;
        if (!node?.isValid || !parent?.isValid) return;
        if (node.parent !== parent) return;
        node.setSiblingIndex(parent.children.length - 1);
    }
}
