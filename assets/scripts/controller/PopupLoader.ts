/**
 * PopupLoader - Load lazy các popup từ AssetBundle 'prefabs' khi cần.
 *
 * ── MỤC ĐÍCH ──
 *   Không dùng @property prefab slot trong Editor.
 *   Mỗi popup được load on-demand qua assetManager.getBundle + bundle.load.
 *   Bundle 'prefabs' đã được LoadingController load sẵn trước khi scene này chạy.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Gắn component này vào node Canvas (hoặc UIRoot) của scene chính.
 *   2. Không cần kéo gì vào Editor — tên prefab được định nghĩa trong PREFAB_NAMES.
 */

import { _decorator, Component, Prefab, instantiate, Node, assetManager, Sprite, Button } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { JackpotType, PickGameState } from '../data/SlotTypes';
import { PickGamePopup } from './PickGamePopup';
import { JackpotPopup } from './JackpotPopup';
import { ProgressiveWinPopup, ProgressiveWinTier } from './ProgressiveWinPopup';
import { PayTablePopUp } from './PayTablePopUp';
import { FreeSpinEndPopup } from './FreeSpinEndPopup';
import { FreeSpinPopup } from './FreeSpinPopup';
import { PopupMessageController } from './PopupMessageController';
import { SystemPopupPayload } from '../core/PopUpMessage';
import { AutoSettingPopup } from './AutoSettingPopup';
import { BetSettingsPopup } from './BetSettingsPopup';
import { SettingPopup } from './SettingPopup';
import { TopUpEndPopup } from './TopUpEndPopup';
import { TransitionMode } from './TopUpTransitionPopup';
import { MatsuriStartPopup } from './MatsuriStartPopup';
import { JackpotStartPopup } from './JackpotStartPopup';
import { RedEnvelopePopup } from './RedEnvelopePopup';
import { CarnivalFeatureTrigger } from '../data/SlotTypes';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

// ── BUNDLE & PREFAB NAMES ──────────────────────────────────────────────────
const BUNDLE_NAME = 'MainBundle';

const PREFAB_NAMES = {
    jackpot:          'JackpotPopup',
    progressiveWin:   'ProgressiveWinPopup',
    payTable:         'PayTablePopUp',
    freeSpinEnd:      'FreeSpinEndPopup',
    freeSpin:         'FreeSpinPopup',
    popupMessage:     'MessagePopup',
    autoSetting:      'AutoSettingPopUp',
    betSettings:      'BetSettingsPopup',
    gameSetting:      'GameSettingPopUp',
    pickGame:         'PickGamePopup',
    topUpTransition:  'TransitionPopup',
    topUpEnd:         'TopUpEndPopup',
    matsuriStart:     'MatsuriStartPopup',
    jackpotStart:     'JackpotStartPopup',
    redEnvelope:      'RedEnvelopePopup',
} as const;

@ccclass('PopupLoader')
export class PopupLoader extends Component {

    @property({ tooltip: 'true → load sẵn tất cả prefab vào cache khi onLoad (không instantiate).\nfalse → lazy-load từng popup khi event kích hoạt lần đầu.' })
    preloadAll: boolean = false;

    // ── RUNTIME INSTANCES ─────────────────────────────────────────────────

    private _jackpotPopupNode: Node | null = null;
    private _progressiveWinNode: Node | null = null;
    private _payTablePopupNode: Node | null = null;
    private _freeSpinEndPopupNode: Node | null = null;
    private _freeSpinPopupNode: Node | null = null;
    private _popupMessageNode: Node | null = null;
    private _autoSettingPopupNode: Node | null = null;
    private _betSettingsPopupNode: Node | null = null;
    private _gameSettingPopupNode: Node | null = null;
    private _pickGameNode: Node | null = null;
    private _topUpTransitionNode: Node | null = null;
    private _topUpEndNode: Node | null = null;
    private _matsuriStartNode: Node | null = null;
    private _jackpotStartNode: Node | null = null;
    private _redEnvelopeNode: Node | null = null;

    /** Các prefab đang trong quá trình load — tránh double-instantiate */
    private _loadingSet: Set<string> = new Set();
    /** Callback chờ khi prefab đang instantiate (warm + open cùng lúc). */
    private _pendingAfterLoad: Map<string, Array<(node: Node) => void>> = new Map();
    /** Prefab asset đã bundle.load — chưa instantiate. */
    private _prefabCache: Map<string, Prefab> = new Map();
    /** Waiters khi đang cache Prefab (không instantiate). */
    private _prefabWaiters: Map<string, Array<(prefab: Prefab | null) => void>> = new Map();

    /** Delay instantiate nặng — JackpotStart vẫn dùng; Matsuri chờ INTRO_DONE. */
    private static readonly HEAVY_WARM_DELAY = 0.85;

    // ── LIFECYCLE ─────────────────────────────────────────────────────────

    onLoad(): void {
        EventBus.instance.on(GameEvents.JACKPOT_TRIGGER, this._onJackpotTrigger, this);
        EventBus.instance.on(GameEvents.PROGRESSIVE_WIN_SHOW, this._onProgressiveWinShow, this);
        EventBus.instance.on(GameEvents.PAY_TABLE_OPEN, this._onPayTableOpen, this);
        EventBus.instance.on(GameEvents.FREE_SPIN_END_POPUP, this._onFreeSpinEndPopup, this);
        EventBus.instance.on(GameEvents.FREE_SPIN_POPUP, this._onFreeSpinPopup, this);
        EventBus.instance.on(GameEvents.SHOW_SYSTEM_POPUP, this._onShowSystemPopup, this);
        EventBus.instance.on(GameEvents.AUTO_SETTING_OPEN, this._onAutoSettingOpen, this);
        EventBus.instance.on(GameEvents.BET_SETTING_OPEN, this._onBetSettingOpen, this);
        EventBus.instance.on(GameEvents.GAME_SETTING_OPEN,      this._onGameSettingOpen,      this);
        EventBus.instance.on(GameEvents.PICK_GAME_OPEN,          this._onPickGameOpen,          this);
        EventBus.instance.on(GameEvents.TOPUP_TRANSITION_SHOW,   this._onTopUpTransitionShow,   this);
        EventBus.instance.on(GameEvents.TOPUP_END_POPUP,         this._onTopUpEndPopup,         this);
        EventBus.instance.on(GameEvents.MATSURI_START_POPUP,     this._onMatsuriStartPopup,     this);
        EventBus.instance.on(GameEvents.MATSURI_START_POPUP_INTRO_DONE, this._onMatsuriStartIntroDone, this);
        EventBus.instance.on(GameEvents.PICK_GAME_START_POPUP,   this._onJackpotStartPopup,     this);
        EventBus.instance.on(GameEvents.PICK_GAME_START_POPUP_INTRO_DONE, this._onJackpotStartIntroDone, this);
        EventBus.instance.on(GameEvents.PICK_GAME_BEGIN_ENTRY,   this._onPickGameBeginEntry,    this);
        EventBus.instance.on(GameEvents.CARNIVAL_RED_ENVELOPE,   this._onRedEnvelopePopup,      this);
        EventBus.instance.on(GameEvents.CARNIVAL_POT_BURST,      this._cacheStartPopups,        this);
        EventBus.instance.on(GameEvents.GAME_READY,              this._cacheStartPopups,        this);
        // Any popup opened → re-raise PayTable to top if active/present
        EventBus.instance.on(GameEvents.POPUP_OPENED, this._ensurePayTableOnTop, this);

        if (this.preloadAll) {
            this._preloadAllPrefabs();
        }
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ── HELPER ────────────────────────────────────────────────────────────

    /** Preload toàn bộ prefab vào cache bundle mà không instantiate */
    private _preloadAllPrefabs(): void {
        const bundle = assetManager.getBundle(BUNDLE_NAME);
        if (!bundle) {
            Log.w(`[PopupLoader] Preload: Bundle '${BUNDLE_NAME}' chưa được load!`);
            return;
        }
        for (const name of Object.values(PREFAB_NAMES)) {
            bundle.load(name, Prefab, (err: Error | null) => {
                if (err) {
                    Log.w(`[PopupLoader] Preload thất bại: ${name}`, err);
                } else {
                    Log.d(`[PopupLoader] Preloaded: ${name}`);
                }
            });
        }
    }

    /**
     * Cache Prefab popup Start (nhỏ) — không instantiate.
     * Không cache PickGame ở đây: decode spine/texture trùng frame hiện popup sẽ giật scale-in.
     */
    private _cacheStartPopups = (): void => {
        this._cachePrefab(PREFAB_NAMES.matsuriStart);
        this._cachePrefab(PREFAB_NAMES.jackpotStart);
    };

    private _cachePrefab(prefabName: string): void {
        this._ensurePrefabAsset(prefabName, () => {});
    }

    private _ensurePrefabAsset(prefabName: string, cb: (prefab: Prefab | null) => void): void {
        const cached = this._prefabCache.get(prefabName);
        if (cached) {
            cb(cached);
            return;
        }
        const waiters = this._prefabWaiters.get(prefabName);
        if (waiters) {
            waiters.push(cb);
            return;
        }

        const bundle = assetManager.getBundle(BUNDLE_NAME);
        if (!bundle) {
            Log.w(`[PopupLoader] Bundle '${BUNDLE_NAME}' chưa được load!`);
            cb(null);
            return;
        }

        this._prefabWaiters.set(prefabName, [cb]);
        bundle.load(prefabName, Prefab, (err: Error | null, prefab: Prefab) => {
            if (prefab) this._prefabCache.set(prefabName, prefab);
            else if (err) Log.e(`[PopupLoader] Cache prefab thất bại: ${prefabName}`, err);
            const list = this._prefabWaiters.get(prefabName) ?? [];
            this._prefabWaiters.delete(prefabName);
            for (const w of list) w(prefab ?? null);
        });
    }

    /**
     * Load prefab từ bundle rồi instantiate vào node hiện tại.
     * Nếu prefab đang instantiate → xếp callback, không bỏ qua (tránh miss open khi đang warm).
     */
    private _loadPrefab(prefabName: string, callback: (node: Node) => void): void {
        if (this._loadingSet.has(prefabName)) {
            const q = this._pendingAfterLoad.get(prefabName) ?? [];
            q.push(callback);
            this._pendingAfterLoad.set(prefabName, q);
            Log.d(`[PopupLoader] ${prefabName} đang instantiate — queue callback`);
            return;
        }

        this._loadingSet.add(prefabName);
        this._ensurePrefabAsset(prefabName, (prefab) => {
            this._loadingSet.delete(prefabName);
            const queued = this._pendingAfterLoad.get(prefabName) ?? [];
            this._pendingAfterLoad.delete(prefabName);
            if (!prefab) {
                Log.e(`[PopupLoader] Load prefab thất bại: ${prefabName}`);
                return;
            }
            const node = instantiate(prefab);
            this.node.addChild(node);
            this._ensurePayTableOnTop();
            Log.d(`[PopupLoader] Instantiated: ${prefabName}`);
            callback(node);
            for (const cb of queued) cb(node);
            this._ensurePayTableOnTop();
        });
    }

    /** Instantiate ẩn để cache — không mở popup. */
    private _warmPrefab(prefabName: string, assign: (node: Node) => void, already: Node | null): void {
        if (already?.isValid) return;
        this._loadPrefab(prefabName, assign);
    }

    private _warmPickGame(): void {
        this._warmPrefab(PREFAB_NAMES.pickGame, (node) => {
            if (this._pickGameNode?.isValid && this._pickGameNode !== node) {
                node.destroy();
                return;
            }
            this._pickGameNode = node;
            Log.d('[PopupLoader] Warmed PickGamePopup');
        }, this._pickGameNode);
    }

    private _warmTopUpEnd(): void {
        this._warmPrefab(PREFAB_NAMES.topUpEnd, (node) => {
            if (this._topUpEndNode?.isValid && this._topUpEndNode !== node) {
                node.destroy();
                return;
            }
            this._topUpEndNode = node;
            Log.d('[PopupLoader] Warmed TopUpEndPopup');
        }, this._topUpEndNode);
    }

    // ── INTERNAL UTILS ────────────────────────────────────────────────────
    private _ensurePayTableOnTop(): void {
        const inst = PayTablePopUp.instance;
        const n = inst?.node ?? this._payTablePopupNode;
        if (!n || !n.isValid) return;
        if (n.parent !== this.node) {
            try { n.setParent(this.node); } catch {}
        }
        if (n.parent === this.node) {
            n.setSiblingIndex(this.node.children.length - 1);
        }
    }

    // ── HANDLERS ──────────────────────────────────────────────────────────

    private _onJackpotTrigger(jackpotType: JackpotType, amount: number): void {
        const nodeValid = this._jackpotPopupNode?.isValid ?? false;
        const nodeActive = this._jackpotPopupNode?.active ?? false;
        Log.e(`[PopupLoader] _onJackpotTrigger — type=${jackpotType}, amount=${amount}, _jackpotPopupNode=${!!this._jackpotPopupNode}, nodeValid=${nodeValid}, nodeActive=${nodeActive}`);
        if (this._jackpotPopupNode) {
            if (!nodeValid) {
                Log.e(`[PopupLoader] _onJackpotTrigger — node reference invalid, clearing _jackpotPopupNode`);
                this._jackpotPopupNode = null;
            } else {
                // Đã instantiate rồi — popup tự xử lý qua listener của nó.
                Log.e(`[PopupLoader] _onJackpotTrigger — node exists, returning (popup should self-handle)`);
                return;
            }
        }
        this._loadPrefab(PREFAB_NAMES.jackpot, (node) => {
            this._jackpotPopupNode = node;
            // onLoad của JackpotPopup đã chạy (synchronous trong instantiate) → gọi showPopup cho lần đầu
            const popup = node.getComponent(JackpotPopup);
            if (popup) {
                popup.showPopup(jackpotType, amount, () => {
                    Log.d('[PopupLoader] JackpotPopup closed → emitting JACKPOT_END');
                    EventBus.instance.emit(GameEvents.JACKPOT_END);
                });
            }
        });
    }

    private _onProgressiveWinShow(tier: ProgressiveWinTier, amount: number): void {
        const nodeValid = this._progressiveWinNode?.isValid ?? false;
        Log.e(`[PopupLoader] _onProgressiveWinShow — tier=${tier}, amount=${amount}, nodeExists=${!!this._progressiveWinNode}, nodeValid=${nodeValid}`);
        if (this._progressiveWinNode) {
            if (!nodeValid) {
                Log.e(`[PopupLoader] _onProgressiveWinShow — node reference invalid, clearing _progressiveWinNode`);
                this._progressiveWinNode = null;
            } else {
                // Đã instantiate rồi — popup tự xử lý qua listener của nó.
                return;
            }
        }
        this._loadPrefab(PREFAB_NAMES.progressiveWin, (node) => {
            this._progressiveWinNode = node;
            const popup = node.getComponent(ProgressiveWinPopup);
            if (popup) {
                popup.showPopup(tier, amount, () => {
                    Log.d('[PopupLoader] ProgressiveWinPopup closed → emitting PROGRESSIVE_WIN_END');
                    EventBus.instance.emit(GameEvents.PROGRESSIVE_WIN_END);
                });
            }
        });
    }

    private _onPayTableOpen(): void {
        if (this._payTablePopupNode) {
            if (!this._payTablePopupNode.isValid) {
                this._payTablePopupNode = null;
            } else {
                const popup = this._payTablePopupNode.getComponent(PayTablePopUp);
                if (popup) popup.open();
                return;
            }
        }
        this._loadPrefab(PREFAB_NAMES.payTable, (node) => {
            this._payTablePopupNode = node;
            const popup = node.getComponent(PayTablePopUp);
            if (popup) popup.open();
        });
    }

    private _onFreeSpinEndPopup(totalWin: number, spinCount: number): void {
        if (this._freeSpinEndPopupNode) {
            const popup = this._freeSpinEndPopupNode.getComponent(FreeSpinEndPopup);
            if (popup) popup.showPopup(totalWin, spinCount);
            return;
        }
        this._loadPrefab(PREFAB_NAMES.freeSpinEnd, (node) => {
            this._freeSpinEndPopupNode = node;
            const popup = node.getComponent(FreeSpinEndPopup);
            if (popup) popup.showPopup(totalWin, spinCount);
        });
    }

    private _onFreeSpinPopup(count: number): void {
        if (this._freeSpinPopupNode) {
            const popup = this._freeSpinPopupNode.getComponent(FreeSpinPopup);
            if (popup) popup.showFreeSpin(count);
            return;
        }
        this._loadPrefab(PREFAB_NAMES.freeSpin, (node) => {
            this._freeSpinPopupNode = node;
            const popup = node.getComponent(FreeSpinPopup);
            if (popup) popup.showFreeSpin(count);
        });
    }

    private _onShowSystemPopup(payload: SystemPopupPayload): void {
        if (this._popupMessageNode) {
            const popup = this._popupMessageNode.getComponent(PopupMessageController);
            if (popup) popup.show(payload);
            return;
        }
        this._loadPrefab(PREFAB_NAMES.popupMessage, (node) => {
            this._popupMessageNode = node;
            const popup = node.getComponent(PopupMessageController);
            if (popup) popup.show(payload);
        });
    }

    private _onAutoSettingOpen(): void {
        if (this._autoSettingPopupNode) {
            const popup = this._autoSettingPopupNode.getComponent(AutoSettingPopup);
            if (popup) popup.open();
            return;
        }
        this._loadPrefab(PREFAB_NAMES.autoSetting, (node) => {
            this._autoSettingPopupNode = node;
            const popup = node.getComponent(AutoSettingPopup);
            if (popup) popup.open();
        });
    }

    private _onBetSettingOpen(): void {
        if (this._betSettingsPopupNode) {
            const popup = this._betSettingsPopupNode.getComponent(BetSettingsPopup);
            if (popup) popup.open();
            return;
        }
        this._loadPrefab(PREFAB_NAMES.betSettings, (node) => {
            this._betSettingsPopupNode = node;
            const popup = node.getComponent(BetSettingsPopup);
            if (popup) popup.open();
        });
    }

    private _onGameSettingOpen(): void {
        if (this._gameSettingPopupNode) {
            const popup = this._gameSettingPopupNode.getComponent(SettingPopup);
            if (popup) popup.open();
            return;
        }
        this._loadPrefab(PREFAB_NAMES.gameSetting, (node) => {
            this._gameSettingPopupNode = node;
            const popup = node.getComponent(SettingPopup);
            if (popup) popup.open();
        });
    }

    private _onPickGameOpen(state: PickGameState): void {
        const shellUp = this._pickGameNode?.getComponent(PickGamePopup)?.isAwaitingStartPopup();
        if (shellUp) {
            Log.d('[PopupLoader] PICK_GAME_OPEN — shell đã mở, skip full open');
            return;
        }
        if (this._pickGameNode && this._pickGameNode.isValid) {
            const popup = this._pickGameNode.getComponent(PickGamePopup);
            if (popup) popup.openPickGame(state);
            return;
        }
        this._pickGameNode = null;
        this._loadPrefab(PREFAB_NAMES.pickGame, (node) => {
            this._pickGameNode = node;
            const popup = node.getComponent(PickGamePopup);
            if (popup) popup.openPickGame(state);
        });
    }

    private _onTopUpTransitionShow(mode: TransitionMode = TransitionMode.TopUp): void {
        if (this._topUpTransitionNode) return;
        this._loadPrefab(PREFAB_NAMES.topUpTransition, (node) => {
            this._topUpTransitionNode = node;
            EventBus.instance.emit(GameEvents.TOPUP_TRANSITION_SHOW, mode);
        });
    }

    private _onTopUpEndPopup(totalWin: number): void {
        if (this._topUpEndNode) {
            const popup = this._topUpEndNode.getComponent(TopUpEndPopup);
            if (popup) popup.showPopup(totalWin);
            return;
        }
        this._loadPrefab(PREFAB_NAMES.topUpEnd, (node) => {
            this._topUpEndNode = node;
            const popup = node.getComponent(TopUpEndPopup);
            if (popup) popup.showPopup(totalWin);
        });
    }

    private _onMatsuriStartPopup(feature: CarnivalFeatureTrigger): void {
        if (this._matsuriStartNode?.isValid) {
            this._matsuriStartNode.setSiblingIndex(this.node.children.length - 1);
            this._showMatsuriStart(this._matsuriStartNode, feature);
            // Không warm PickGame/TopUpEnd ở đây — chờ INTRO_DONE để tránh giật slam
            return;
        }
        this._loadPrefab(PREFAB_NAMES.matsuriStart, (node) => {
            this._matsuriStartNode = node;
            node.setSiblingIndex(this.node.children.length - 1);
            this._showMatsuriStart(node, feature);
        });
    }

    /** Slam Title/Grid/Press xong → mới instantiate nặng. */
    private _onMatsuriStartIntroDone(): void {
        this._scheduleHeavyWarm();
    }

    /** Slam Title1/Title2/Press xong — Pick shell đã mở, chỉ warm TopUpEnd. */
    private _onJackpotStartIntroDone(): void {
        this.unschedule(this._doHeavyWarm);
        this.scheduleOnce(this._warmTopUpEndOnly, PopupLoader.HEAVY_WARM_DELAY);
    }

    private _warmTopUpEndOnly = (): void => {
        this._warmTopUpEnd();
    };

    /** Prefab thiếu script / UUID lệch → addComponent fallback để vẫn vào được TopUp. */
    private _showMatsuriStart(node: Node, feature: CarnivalFeatureTrigger): void {
        let popup = node.getComponent(MatsuriStartPopup);
        if (!popup) {
            Log.w('[PopupLoader] MatsuriStartPopup missing on prefab — addComponent fallback');
            popup = node.addComponent(MatsuriStartPopup);
            this._wireStartPopupNodes(node, popup);
        }
        popup.showPopup(feature);
    }

    private _onJackpotStartPopup(state: PickGameState): void {
        this._openPickGameShellThenJackpotStart(state);
    }

    /** Pick Game shell bên dưới → JackpotStartPopup trên cùng (giống Feature + MatsuriStartPopup). */
    private _openPickGameShellThenJackpotStart(state: PickGameState): void {
        const showJackpot = (): void => {
            if (this._jackpotStartNode?.isValid) {
                this._jackpotStartNode.setSiblingIndex(this.node.children.length - 1);
                this._showJackpotStart(this._jackpotStartNode, state);
                return;
            }
            this._loadPrefab(PREFAB_NAMES.jackpotStart, (node) => {
                this._jackpotStartNode = node;
                this._showJackpotStart(node, state);
            });
        };

        const mountShell = (node: Node): void => {
            if (this._pickGameNode?.isValid && this._pickGameNode !== node) {
                node.destroy();
                showJackpot();
                return;
            }
            this._pickGameNode = node;
            node.active = true;
            const popup = node.getComponent(PickGamePopup);
            if (popup) popup.openPickGameShell(state);
            EventBus.instance.emit(GameEvents.PICK_GAME_OPEN, state);
            showJackpot();
        };

        if (this._pickGameNode?.isValid) {
            mountShell(this._pickGameNode);
            return;
        }
        this._loadPrefab(PREFAB_NAMES.pickGame, mountShell);
    }

    private _onPickGameBeginEntry = (state: PickGameState): void => {
        const popup = this._pickGameNode?.getComponent(PickGamePopup);
        if (popup) {
            popup.beginPickGameEntry();
            return;
        }
        Log.w('[PopupLoader] PICK_GAME_BEGIN_ENTRY — shell missing, fallback PICK_GAME_OPEN');
        this._onPickGameOpen(state);
    };

    /** Instantiate PickGame / TopUpEnd sau khi Start popup đã scale-in. */
    private _scheduleHeavyWarm(): void {
        this.unschedule(this._doHeavyWarm);
        this.scheduleOnce(this._doHeavyWarm, PopupLoader.HEAVY_WARM_DELAY);
    }

    private _doHeavyWarm = (): void => {
        this._warmPickGame();
        this._warmTopUpEnd();
    };

    private _showJackpotStart(node: Node, state: PickGameState): void {
        let popup = node.getComponent(JackpotStartPopup);
        if (!popup) {
            Log.w('[PopupLoader] JackpotStartPopup missing on prefab — addComponent fallback');
            popup = node.addComponent(JackpotStartPopup);
            this._wireStartPopupNodes(node, popup);
        }
        popup.showPopup(state);
        // Đảm bảo hiện — tránh onLoad defer tắt lại node sau showPopup
        node.active = true;
        node.setSiblingIndex(this.node.children.length - 1);
        Log.e(`[PopupLoader] JackpotStartPopup show active=${node.active}`);
    }

    private _onRedEnvelopePopup(payload: { amount: number }): void {
        const amount = Number(payload?.amount ?? 0);
        if (!(amount > 0)) {
            Log.w('[PopupLoader] RED_ENVELOPE amount<=0 — emit closed');
            EventBus.instance.emit(GameEvents.CARNIVAL_RED_ENVELOPE_CLOSED);
            return;
        }
        if (this._redEnvelopeNode?.isValid) {
            this._redEnvelopeNode.setSiblingIndex(this.node.children.length - 1);
            this._showRedEnvelope(this._redEnvelopeNode, amount);
            return;
        }

        const failLoad = () => {
            Log.e('[PopupLoader] RED_ENVELOPE prefab load failed — emit closed');
            EventBus.instance.emit(GameEvents.CARNIVAL_RED_ENVELOPE_CLOSED);
        };

        const bundle = assetManager.getBundle(BUNDLE_NAME);
        if (!bundle) {
            failLoad();
            return;
        }
        const prefabName = PREFAB_NAMES.redEnvelope;
        if (this._loadingSet.has(prefabName)) return;
        this._loadingSet.add(prefabName);
        bundle.load(prefabName, Prefab, (err: Error | null, prefab: Prefab) => {
            this._loadingSet.delete(prefabName);
            if (err || !prefab) {
                Log.e(`[PopupLoader] Load prefab thất bại: ${prefabName}`, err);
                failLoad();
                return;
            }
            const node = instantiate(prefab);
            this.node.addChild(node);
            this._redEnvelopeNode = node;
            node.setSiblingIndex(this.node.children.length - 1);
            this._showRedEnvelope(node, amount);
            this._ensurePayTableOnTop();
        });
    }

    private _showRedEnvelope(node: Node, amount: number): void {
        const popup = node.getComponent(RedEnvelopePopup);
        if (!popup) {
            Log.e('[PopupLoader] RedEnvelopePopup component missing on prefab');
            EventBus.instance.emit(GameEvents.CARNIVAL_RED_ENVELOPE_CLOSED);
            return;
        }
        popup.showPopup(amount);
        node.active = true;
        node.setSiblingIndex(this.node.children.length - 1);
        Log.e(`[PopupLoader] RedEnvelopePopup show amount=${amount}`);
    }

    /** Wire Overlay/Panel (fallback khi prefab thiếu script). */
    private _wireStartPopupNodes(
        node: Node,
        popup: MatsuriStartPopup | JackpotStartPopup,
    ): void {
        const overlay = node.getChildByName('Overlay');
        const panel = node.getChildByName('Panel');
        if (overlay) popup.overlayNode = overlay;
        if (panel) popup.popupNode = panel;

        if (popup instanceof MatsuriStartPopup) {
            const base = panel?.getChildByName('Base') ?? panel;
            if (!popup.titleSprite) {
                popup.titleSprite = base?.getChildByName('Title')?.getComponent(Sprite) ?? null;
            }
            if (!popup.gridSprite) {
                popup.gridSprite = base?.getChildByName('Grid')?.getComponent(Sprite) ?? null;
            }
            if (!popup.pressButton) {
                popup.pressButton = base?.getChildByName('Press')?.getComponent(Button) ?? null;
            }
            if (!popup.pressInfoSprite) {
                const pressNode = popup.pressButton?.node ?? base?.getChildByName('Press');
                popup.pressInfoSprite = pressNode?.getChildByName('Info')?.getComponent(Sprite) ?? null;
            }
            if (!popup.note1Sprite) {
                popup.note1Sprite = base?.getChildByName('Note1')?.getComponent(Sprite) ?? null;
            }
            if (!popup.note2Sprite) {
                popup.note2Sprite = base?.getChildByName('Note2')?.getComponent(Sprite) ?? null;
            }
            if (!popup.panelBgSprite) {
                popup.panelBgSprite = base?.getComponent(Sprite) ?? null;
            }
            return;
        }

        const jp = popup as JackpotStartPopup;
        if (!jp.title1Sprite) {
            jp.title1Sprite = panel?.getChildByName('Title1')?.getComponent(Sprite) ?? null;
        }
        if (!jp.title2Sprite) {
            jp.title2Sprite = panel?.getChildByName('Title2')?.getComponent(Sprite) ?? null;
        }
        if (!jp.pressButton) {
            jp.pressButton = panel?.getChildByName('Press')?.getComponent(Button) ?? null;
        }
        if (!jp.pressInfoSprite) {
            const pressNode = jp.pressButton?.node ?? panel?.getChildByName('Press');
            jp.pressInfoSprite = pressNode?.getChildByName('Info')?.getComponent(Sprite) ?? null;
        }
        if (!jp.panelBgSprite) {
            jp.panelBgSprite = panel?.getComponent(Sprite) ?? null;
        }
    }

    // ── PUBLIC API - Mở popup trực tiếp (không qua event) ────────────────

    public openPayTable(): void {
        this._onPayTableOpen();
    }

    public openFreeSpinEnd(totalWin: number, spinCount: number): void {
        this._onFreeSpinEndPopup(totalWin, spinCount);
    }

    public openFreeSpin(count: number): void {
        this._onFreeSpinPopup(count);
    }

    public openSystemPopup(payload: SystemPopupPayload): void {
        this._onShowSystemPopup(payload);
    }
}
