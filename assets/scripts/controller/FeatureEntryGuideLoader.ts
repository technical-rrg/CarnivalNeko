/**
 * FeatureEntryGuideLoader — Lazy-load FeatureEntryGuide.prefab từ MainBundle.
 *
 * Tách khỏi Base.prefab (kèm Spine Anim-New-Feature) — chỉ load khi
 * FEATURE_ENTRY_GUIDE_SHOW (Force Feature Entry).
 */

import { _decorator, Component, Node, Prefab, instantiate, assetManager } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { Log } from '../core/Logger';
import { FeatureEntryGuideEffect } from './FeatureEntryGuideEffect';

const { ccclass, property } = _decorator;

const BUNDLE_NAME = 'MainBundle';
const DEFAULT_PREFAB_PATH = 'FeatureEntryGuide';

@ccclass('FeatureEntryGuideLoader')
export class FeatureEntryGuideLoader extends Component {

    @property({
        type: Node,
        tooltip: 'Node cha gắn FeatureEntryGuide (thường GameRoot hoặc Base root).',
    })
    shellParent: Node | null = null;

    @property({
        type: Node,
        tooltip: 'GameRoot — gắn guide phía trên UI game.',
    })
    gameRoot: Node | null = null;

    @property({ tooltip: 'Path Prefab trong MainBundle (không extension).' })
    prefabPath: string = DEFAULT_PREFAB_PATH;

    private _instance: Node | null = null;
    private _effect: FeatureEntryGuideEffect | null = null;
    private _loading: Promise<FeatureEntryGuideEffect | null> | null = null;
    private _cachedPrefab: Prefab | null = null;

    init(shellParent: Node, gameRoot: Node | null): void {
        this.shellParent = shellParent;
        this.gameRoot = gameRoot;
    }

    onLoad(): void {
        EventBus.instance.on(GameEvents.FEATURE_ENTRY_GUIDE_SHOW, this._onGuideShow, this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    /** Load + instantiate khi cần (idempotent). */
    ensureLoaded(): Promise<FeatureEntryGuideEffect | null> {
        if (this._effect?.isValid && this._instance?.isValid) {
            return Promise.resolve(this._effect);
        }
        if (this._loading) return this._loading;

        this._loading = this._loadAndInstantiate().finally(() => {
            this._loading = null;
        });
        return this._loading;
    }

    private _onGuideShow(): void {
        void this.ensureLoaded().then((fx) => {
            if (!fx) {
                Log.e('[FeatureEntryGuideLoader] Prefab missing — skip guide → DONE');
                EventBus.instance.emit(GameEvents.FEATURE_ENTRY_GUIDE_DONE);
                return;
            }
            fx.playGuide();
        });
    }

    private _loadAndInstantiate(): Promise<FeatureEntryGuideEffect | null> {
        return new Promise((resolve) => {
            const finish = (prefab: Prefab | null) => {
                if (!prefab || !this.isValid) {
                    resolve(null);
                    return;
                }

                this._cachedPrefab = prefab;
                const parent = this.gameRoot?.isValid
                    ? this.gameRoot
                    : (this.shellParent ?? this.node);

                const instance = instantiate(prefab);
                instance.name = 'FeatureEntryGuide';
                // active=true trước để onLoad chạy xong, rồi tắt — playGuide() sẽ bật lại
                instance.active = true;
                parent.addChild(instance);
                instance.setSiblingIndex(parent.children.length - 1);

                const fx = instance.getComponent(FeatureEntryGuideEffect)
                    ?? instance.getComponentInChildren(FeatureEntryGuideEffect);
                if (!fx) {
                    Log.e('[FeatureEntryGuideLoader] Prefab thiếu FeatureEntryGuideEffect');
                    instance.destroy();
                    resolve(null);
                    return;
                }

                this._instance = instance;
                this._effect = fx;
                instance.active = false;
                Log.d('[FeatureEntryGuideLoader] instantiated FeatureEntryGuide (ready, inactive)');
                resolve(fx);
            };

            if (this._cachedPrefab) {
                finish(this._cachedPrefab);
                return;
            }

            const bundle = assetManager.getBundle(BUNDLE_NAME);
            if (!bundle) {
                Log.e(`[FeatureEntryGuideLoader] Bundle '${BUNDLE_NAME}' chưa load`);
                resolve(null);
                return;
            }

            const path = (this.prefabPath || DEFAULT_PREFAB_PATH).trim();
            bundle.load(path, Prefab, (err: Error | null, prefab: Prefab) => {
                if (err || !prefab) {
                    Log.e(`[FeatureEntryGuideLoader] Load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                Log.d(`[FeatureEntryGuideLoader] Prefab loaded: ${path}`);
                finish(prefab);
            });
        });
    }
}
