/**
 * DebbugManagerLoader — Lazy-load DebbugManager prefab từ MainBundle.
 *
 * ── MỤC ĐÍCH ──
 *   Debug panel tách khỏi Base.prefab — chỉ load khi bấm OpenDebug (Editor/Debug build).
 *
 * ── FLOW ──
 *   GAME_READY → bind nút OpenDebug trong GameRoot
 *   Click OpenDebug → ensureLoaded → SlotDebugPanel.onOpenDebug()
 */

import { _decorator, Button, Component, Node, Prefab, instantiate, assetManager } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { isDebugToolsEnabled } from '../core/DebugEnv';
import { Log } from '../core/Logger';
import { SlotDebugPanel } from './SlotDebugPanel';

const { ccclass, property } = _decorator;

const BUNDLE_NAME = 'MainBundle';
const DEFAULT_PREFAB_PATH = 'DebbugManager';
const OPEN_DEBUG_NODE = 'OpenDebug';

@ccclass('DebbugManagerLoader')
export class DebbugManagerLoader extends Component {

    @property({
        type: Node,
        tooltip: 'Node cha gắn DebbugManager (thường là Base root). Null = node của loader.',
    })
    shellParent: Node | null = null;

    @property({
        type: Node,
        tooltip: 'GameRoot — chứa nút OpenDebug.',
    })
    gameRoot: Node | null = null;

    @property({
        tooltip: 'Path Prefab trong MainBundle (không extension).',
    })
    prefabPath: string = DEFAULT_PREFAB_PATH;

    private _instance: Node | null = null;
    private _panel: SlotDebugPanel | null = null;
    private _loading: Promise<SlotDebugPanel | null> | null = null;
    private _cachedPrefab: Prefab | null = null;
    private _openDebugBound = false;

    init(shellParent: Node, gameRoot: Node | null): void {
        this.shellParent = shellParent;
        this.gameRoot = gameRoot;
    }

    onLoad(): void {
        if (!isDebugToolsEnabled()) return;
        EventBus.instance.on(GameEvents.GAME_READY, this._onGameReady, this);
        EventBus.instance.on(GameEvents.GAME_ENTRY_EFFECT, this._onGameReady, this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    get panel(): SlotDebugPanel | null {
        return this._panel?.isValid ? this._panel : null;
    }

    ensureLoaded(): Promise<SlotDebugPanel | null> {
        if (this._panel?.isValid && this._instance?.isValid) {
            return Promise.resolve(this._panel);
        }
        if (this._loading) return this._loading;

        this._loading = this._loadAndInstantiate().finally(() => {
            this._loading = null;
        });
        return this._loading;
    }

    private _onGameReady(): void {
        this._bindOpenDebugButton();
        // GameRoot có thể active sau GAME_READY (deferred entry) — retry bind
        if (!this._openDebugBound) {
            this.scheduleOnce(() => this._bindOpenDebugButton(), 0.5);
        }
    }

    private _bindOpenDebugButton(): void {
        if (this._openDebugBound || !isDebugToolsEnabled()) return;
        const root = this.gameRoot;
        if (!root?.isValid || !root.activeInHierarchy) return;

        const btnNode = this._findNodeByName(root, OPEN_DEBUG_NODE);
        if (!btnNode) {
            Log.w(`[DebbugManagerLoader] Không tìm thấy '${OPEN_DEBUG_NODE}' trong GameRoot`);
            return;
        }

        const button = btnNode.getComponent(Button);
        if (!button) {
            Log.w('[DebbugManagerLoader] OpenDebug thiếu Button component');
            return;
        }

        // Prefab cũ có ClickEvent target=null (DebbugManager đã tách) — xóa handler hỏng
        button.clickEvents.length = 0;
        btnNode.off(Button.EventType.CLICK, this._onOpenDebugClick, this);
        btnNode.on(Button.EventType.CLICK, this._onOpenDebugClick, this);
        this._openDebugBound = true;
        Log.d('[DebbugManagerLoader] OpenDebug button bound (web/editor)');
    }

    private _onOpenDebugClick(): void {
        void this.ensureLoaded().then((panel) => {
            panel?.onOpenDebug();
        });
    }

    private _loadAndInstantiate(): Promise<SlotDebugPanel | null> {
        return new Promise((resolve) => {
            const finish = (prefab: Prefab | null) => {
                if (!prefab || !this.isValid) {
                    resolve(null);
                    return;
                }

                this._cachedPrefab = prefab;
                const parent = this.shellParent ?? this.node;

                const instance = instantiate(prefab);
                instance.name = 'DebbugManager';
                instance.active = true;
                parent.addChild(instance);

                const panel = instance.getComponent(SlotDebugPanel)
                    ?? instance.getComponentInChildren(SlotDebugPanel);
                if (!panel) {
                    Log.err('[DebbugManagerLoader] Prefab thiếu SlotDebugPanel');
                    instance.destroy();
                    resolve(null);
                    return;
                }

                this._instance = instance;
                this._panel = panel;

                Log.d('[DebbugManagerLoader] instantiated DebbugManager');
                resolve(panel);
            };

            if (this._cachedPrefab) {
                finish(this._cachedPrefab);
                return;
            }

            const bundle = assetManager.getBundle(BUNDLE_NAME);
            if (!bundle) {
                Log.e(`[DebbugManagerLoader] Bundle '${BUNDLE_NAME}' chưa load`);
                resolve(null);
                return;
            }

            const path = (this.prefabPath || DEFAULT_PREFAB_PATH).trim();
            bundle.load(path, Prefab, (err: Error | null, prefab: Prefab) => {
                if (err || !prefab) {
                    Log.err(`[DebbugManagerLoader] Load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                Log.d(`[DebbugManagerLoader] Prefab loaded: ${path}`);
                finish(prefab);
            });
        });
    }

    private _findNodeByName(root: Node, name: string): Node | null {
        if (root.name === name) return root;
        for (const child of root.children) {
            const found = this._findNodeByName(child, name);
            if (found) return found;
        }
        return null;
    }
}
