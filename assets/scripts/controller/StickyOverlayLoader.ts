/**
 * StickyOverlayLoader — Lazy-load StickyOverlay (+ TopUpManager child) từ MainBundle.
 *
 * ── MỤC ĐÍCH ──
 *   Không nhúng StickyOverlay vào Base.prefab (nặng, chỉ dùng khi TopUp).
 *   Khi vào TopUp: bundle.load → instantiate → wire SlotMachineController bằng code.
 *   Khi thoát TopUp: destroy instance để giải phóng memory.
 *
 * ── SETUP ──
 *   1. Prefab "StickyOverlay" trong MainBundle phải gồm:
 *        - StickyOverlayController (root hoặc child)
 *        - TopUpManager (thường child GridMiniReel) + 15 TopUpReelController
 *   2. Gắn StickyOverlayLoader vào Canvas / GameRoot (trong Base).
 *   3. Kéo SlotMachineController + parent node + (optional) TopUpAbsorbEffect.
 *   4. Xóa StickyOverlay khỏi Base — không còn reference Prefab trên Base.
 *
 * ── FLOW ──
 *   GameManager TopUp prepare / resume → await ensureLoaded()
 *   → emit TOPUP_START (overlay + TopUpManager đã sẵn sàng)
 *   TOPUP_END → destroy instance, giữ Prefab cache.
 *   Feature lần 2 instantiate lại — Mask RECT sạch như lần đầu (không tái dùng stencil).
 */

import { _decorator, Component, Node, Prefab, instantiate, assetManager } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { Log } from '../core/Logger';
import { GameData } from '../data/GameData';
import { SlotMachineController } from './SlotMachineController';
import { StickyOverlayController } from './StickyOverlayController';
import { TopUpManager } from './TopUpManager';
import { TopUpAbsorbEffect } from './TopUpAbsorbEffect';
import { MatsuriEffect } from './MatsuriEffect';

const { ccclass, property } = _decorator;

const BUNDLE_NAME = 'MainBundle';
const DEFAULT_PREFAB_PATH = 'StickyOverlay';

@ccclass('StickyOverlayLoader')
export class StickyOverlayLoader extends Component {

    @property({
        type: Node,
        tooltip: 'Parent để gắn StickyOverlay instance (vd: SlotMachine / Canvas).\n'
               + 'Null = dùng node của loader.',
    })
    overlayParent: Node | null = null;

    @property({
        type: SlotMachineController,
        tooltip: 'SlotMachineController — wire vào StickyOverlay + TopUpManager bằng code.',
    })
    slotMachine: SlotMachineController | null = null;

    @property({
        type: TopUpAbsorbEffect,
        tooltip: '(Optional) TopUpAbsorbEffect trên Base — wire stickyOverlay sau khi load.',
    })
    absorbEffect: TopUpAbsorbEffect | null = null;

    @property({
        type: MatsuriEffect,
        tooltip:
            'MatsuriEffect — GẮN 1 LẦN trên node này, gán seedSourceNode tại đó.\n' +
            'collectTargetNode để trống → tự lấy SpriteNumber tổng tiền trên StickyOverlay.\n' +
            'Để trống component → auto-add MatsuriEffect trên node loader.',
    })
    matsuriEffect: MatsuriEffect | null = null;

    @property({
        tooltip: 'Path Prefab trong MainBundle (không extension). Mặc định: StickyOverlay',
    })
    prefabPath: string = DEFAULT_PREFAB_PATH;

    @property({
        tooltip: 'Luôn destroy instance khi TOPUP_END (giữ Prefab). Tái dùng Mask RECT làm mất symbol từ feature lần 2.',
    })
    destroyOnTopUpEnd: boolean = true;

    private _instance: Node | null = null;
    private _overlay: StickyOverlayController | null = null;
    private _topUpManager: TopUpManager | null = null;
    private _loading: Promise<StickyOverlayController | null> | null = null;
    private _cachedPrefab: Prefab | null = null;
    private _prefabLoading: Promise<Prefab | null> | null = null;

    onLoad(): void {
        EventBus.instance.on(GameEvents.TOPUP_END, this._onTopUpEnd, this);
        EventBus.instance.on(GameEvents.FREE_SPIN_GOLD_END, this._onTopUpEnd, this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        this.unload();
    }

    /** Instance StickyOverlayController hiện tại (null nếu chưa load). */
    get overlay(): StickyOverlayController | null {
        return this._overlay?.isValid ? this._overlay : null;
    }

    get topUpManager(): TopUpManager | null {
        return this._topUpManager?.isValid ? this._topUpManager : null;
    }

    /**
     * Chỉ tải Prefab + dependency vào cache — KHÔNG instantiate.
     * Gọi lúc Pot burst để parse texture/JSON lúc đang anim, không đụng popup.
     */
    preloadPrefab(): Promise<Prefab | null> {
        if (this._cachedPrefab) return Promise.resolve(this._cachedPrefab);
        if (this._prefabLoading) return this._prefabLoading;

        const bundle = assetManager.getBundle(BUNDLE_NAME);
        if (!bundle) {
            Log.e(`[StickyOverlayLoader] Bundle '${BUNDLE_NAME}' chưa load`);
            return Promise.resolve(null);
        }

        const path = (this.prefabPath || DEFAULT_PREFAB_PATH).trim();
        this._prefabLoading = new Promise((resolve) => {
            bundle.load(path, Prefab, (err: Error | null, prefab: Prefab) => {
                this._prefabLoading = null;
                if (err || !prefab) {
                    Log.err(`[StickyOverlayLoader] Load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                this._cachedPrefab = prefab;
                Log.d(`[StickyOverlayLoader] Prefab cached: ${path}`);
                resolve(prefab);
            });
        });
        return this._prefabLoading;
    }

    /**
     * Đảm bảo StickyOverlay đã được load + wire.
     * Gọi TRƯỚC khi emit TOPUP_START.
     */
    ensureLoaded(): Promise<StickyOverlayController | null> {
        if (this._overlay?.isValid && this._instance?.isValid) {
            this._wireRefs();
            this._hideIfNotInFeature();
            return Promise.resolve(this._overlay);
        }
        if (this._loading) return this._loading;

        this._loading = this.preloadPrefab()
            .then((prefab) => this._spawnOverlay(prefab))
            .finally(() => {
                this._loading = null;
            });
        return this._loading;
    }

    /** Destroy instance (và optionally giữ Prefab cache). */
    unload(): void {
        if (this.absorbEffect) {
            this.absorbEffect.bindStickyOverlay(null);
        }
        if (this._instance?.isValid) {
            this._instance.destroy();
        }
        this._instance = null;
        this._overlay = null;
        this._topUpManager = null;
        Log.d('[StickyOverlayLoader] unloaded instance');
    }

    private _onTopUpEnd(): void {
        // Prefab cache giữ nguyên. Instance mới = Mask sạch như feature lần 1.
        this.scheduleOnce(() => this.unload(), 0);
    }

    private _spawnOverlay(prefab: Prefab | null): StickyOverlayController | null {
        if (!prefab || !this.isValid) return null;
        if (this._overlay?.isValid && this._instance?.isValid) {
            this._wireRefs();
            this._hideIfNotInFeature();
            return this._overlay;
        }

        this._cachedPrefab = prefab;
        const parent = this.overlayParent ?? this.node;
        const instance = instantiate(prefab);
        instance.name = 'StickyOverlay';
        instance.active = false;
        parent.addChild(instance);

        const overlay = instance.getComponent(StickyOverlayController)
            ?? instance.getComponentInChildren(StickyOverlayController);
        const topUpMgr = instance.getComponent(TopUpManager)
            ?? instance.getComponentInChildren(TopUpManager);

        if (!overlay) {
            Log.err('[StickyOverlayLoader] Prefab thiếu StickyOverlayController');
            instance.destroy();
            return null;
        }
        if (!topUpMgr) {
            Log.w('[StickyOverlayLoader] Prefab chưa có TopUpManager — chỉ overlay coin sẽ hoạt động');
        }

        this._instance = instance;
        this._overlay = overlay;
        this._topUpManager = topUpMgr;

        this._wireRefs();
        instance.active = true;
        this._wireRefs();
        this._hideIfNotInFeature();

        Log.d('[StickyOverlayLoader] instantiated + wired StickyOverlay');
        return overlay;
    }

    private _wireRefs(): void {
        const smc = this.slotMachine
            ?? this.node.scene?.getComponentInChildren(SlotMachineController)
            ?? null;

        if (!smc) {
            Log.e('[StickyOverlayLoader] Không tìm thấy SlotMachineController để wire');
        }

        this._overlay?.bindSlotMachine(smc);
        this._topUpManager?.bindSlotMachine(smc);

        const absorb = this.absorbEffect
            ?? this.node.scene?.getComponentInChildren(TopUpAbsorbEffect)
            ?? null;
        absorb?.bindStickyOverlay(this._overlay);

        // Một class MatsuriEffect — gán node tại Inspector của chính nó
        let matsuri = this.matsuriEffect
            ?? this.node.getComponent(MatsuriEffect)
            ?? this.node.scene?.getComponentInChildren(MatsuriEffect)
            ?? null;
        if (!matsuri) {
            matsuri = this.node.addComponent(MatsuriEffect);
            this.matsuriEffect = matsuri;
            Log.e('[StickyOverlayLoader] auto-add MatsuriEffect — gán seedSourceNode + collectTargetNode trên component này');
        }
        matsuri.bindStickyOverlay(this._overlay);
        matsuri.topUpAbsorbEffect = absorb;
        // Đảm bảo MatsuriEffect thấy collect target ngay sau lazy-load overlay.
        this._overlay?.getCollectTargetNode();
    }

    private _hideIfNotInFeature(): void {
        const inst = this._instance;
        if (!inst?.isValid) return;
        const mode = GameData.instance.currentMode;
        if (mode !== 'matsuri' && mode !== 'respin') {
            inst.active = false;
        }
    }
}
