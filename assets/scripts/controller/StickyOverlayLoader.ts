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
 *   TOPUP_END → unload() destroy instance
 */

import { _decorator, Component, Node, Prefab, instantiate, assetManager } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { Log } from '../core/Logger';
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
            'MatsuriEffect — GẮN 1 LẦN trên node này, gán seedSourceNode + collectTargetNode tại đó.\n' +
            'Để trống → auto-add MatsuriEffect trên node loader.',
    })
    matsuriEffect: MatsuriEffect | null = null;

    @property({
        tooltip: 'Path Prefab trong MainBundle (không extension). Mặc định: StickyOverlay',
    })
    prefabPath: string = DEFAULT_PREFAB_PATH;

    @property({
        tooltip: 'true = destroy instance khi TOPUP_END.\nfalse = chỉ ẩn, giữ cache cho lần TopUp sau.',
    })
    destroyOnTopUpEnd: boolean = true;

    private _instance: Node | null = null;
    private _overlay: StickyOverlayController | null = null;
    private _topUpManager: TopUpManager | null = null;
    private _loading: Promise<StickyOverlayController | null> | null = null;
    private _cachedPrefab: Prefab | null = null;

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
     * Đảm bảo StickyOverlay đã được load + wire.
     * Gọi TRƯỚC khi emit TOPUP_START.
     */
    ensureLoaded(): Promise<StickyOverlayController | null> {
        if (this._overlay?.isValid && this._instance?.isValid) {
            this._wireRefs();
            return Promise.resolve(this._overlay);
        }
        if (this._loading) return this._loading;

        this._loading = this._loadAndInstantiate().finally(() => {
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
        if (!this.destroyOnTopUpEnd) return;
        // Đợi 1 frame để StickyOverlay/TopUpManager xử lý TOPUP_END xong rồi mới destroy.
        this.scheduleOnce(() => this.unload(), 0);
    }

    private _loadAndInstantiate(): Promise<StickyOverlayController | null> {
        return new Promise((resolve) => {
            const finish = (prefab: Prefab | null) => {
                if (!prefab || !this.isValid) {
                    resolve(null);
                    return;
                }
                this._cachedPrefab = prefab;
                const parent = this.overlayParent ?? this.node;
                const instance = instantiate(prefab);
                instance.name = 'StickyOverlay';
                // Inactive trước addChild → onLoad chưa chạy → wire slotMachine trước.
                instance.active = false;
                parent.addChild(instance);

                const overlay = instance.getComponent(StickyOverlayController)
                    ?? instance.getComponentInChildren(StickyOverlayController);
                const topUpMgr = instance.getComponent(TopUpManager)
                    ?? instance.getComponentInChildren(TopUpManager);

                if (!overlay) {
                    Log.e('[StickyOverlayLoader] Prefab thiếu StickyOverlayController');
                    instance.destroy();
                    resolve(null);
                    return;
                }
                if (!topUpMgr) {
                    Log.w('[StickyOverlayLoader] Prefab chưa có TopUpManager — chỉ overlay coin sẽ hoạt động');
                }

                this._instance = instance;
                this._overlay = overlay;
                this._topUpManager = topUpMgr;

                // Wire TRƯỚC khi active để onLoad/TopUpManager nhận được slotMachine.
                this._wireRefs();
                instance.active = true;
                // Re-wire absorb sau khi components đã onLoad.
                this._wireRefs();

                Log.d('[StickyOverlayLoader] instantiated + wired StickyOverlay');
                resolve(overlay);
            };

            if (this._cachedPrefab) {
                finish(this._cachedPrefab);
                return;
            }

            const bundle = assetManager.getBundle(BUNDLE_NAME);
            if (!bundle) {
                Log.e(`[StickyOverlayLoader] Bundle '${BUNDLE_NAME}' chưa load`);
                resolve(null);
                return;
            }

            const path = (this.prefabPath || DEFAULT_PREFAB_PATH).trim();
            bundle.load(path, Prefab, (err: Error | null, prefab: Prefab) => {
                if (err || !prefab) {
                    Log.e(`[StickyOverlayLoader] Load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                Log.d(`[StickyOverlayLoader] Prefab loaded: ${path}`);
                finish(prefab);
            });
        });
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
    }
}
