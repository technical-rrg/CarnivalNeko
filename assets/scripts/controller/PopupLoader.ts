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

import { _decorator, Component, Prefab, instantiate, Node, assetManager } from 'cc';
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
import { FeatureSelectPayload } from './FeatureSelectionPopup';
import { TopUpEndPopup } from './TopUpEndPopup';
import { TransitionMode } from './TopUpTransitionPopup';
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
    featureSelection: 'FeatureSelectPopUp',
    topUpEnd:         'TopUpEndPopup',
    
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
    private _featureSelectionNode: Node | null = null;
    private _topUpEndNode: Node | null = null;

    /** Các prefab đang trong quá trình load — tránh double-instantiate */
    private _loadingSet: Set<string> = new Set();

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
        EventBus.instance.on(GameEvents.FEATURE_SELECT_OPEN,     this._onFeatureSelectOpen,     this);
        EventBus.instance.on(GameEvents.TOPUP_END_POPUP,         this._onTopUpEndPopup,         this);
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
     * Load prefab từ bundle rồi instantiate vào node hiện tại.
     * Nếu prefab đang load (loading flag) → bỏ qua để tránh double-instantiate.
     * @param prefabName  Tên prefab trong bundle (không có extension)
     * @param callback    Gọi sau khi node đã addChild, nhận node đã tạo
     */
    private _loadPrefab(prefabName: string, callback: (node: Node) => void): void {
        if (this._loadingSet.has(prefabName)) {
            Log.d(`[PopupLoader] ${prefabName} đang load, bỏ qua`);
            return;
        }

        const bundle = assetManager.getBundle(BUNDLE_NAME);
        if (!bundle) {
            Log.w(`[PopupLoader] Bundle '${BUNDLE_NAME}' chưa được load!`);
            return;
        }

        this._loadingSet.add(prefabName);
        bundle.load(prefabName, Prefab, (err: Error | null, prefab: Prefab) => {
            this._loadingSet.delete(prefabName);
            if (err || !prefab) {
                Log.e(`[PopupLoader] Load prefab thất bại: ${prefabName}`, err);
                return;
            }
            const node = instantiate(prefab);
            this.node.addChild(node);
            // Always keep PayTablePopUp on topmost layer among Popup children
            this._ensurePayTableOnTop();
            Log.d(`[PopupLoader] Instantiated: ${prefabName}`);
            callback(node);
            // Re-ensure in case callback did further child ops
            this._ensurePayTableOnTop();
        });
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
        if (this._pickGameNode && this._pickGameNode.isValid) {
            const popup = this._pickGameNode.getComponent(PickGamePopup);
            if (popup) popup.openPickGame(state);
            return;
        }
        // Node cũ đã bị destroy — clear và instantiate mới
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

    private _onFeatureSelectOpen(payload: FeatureSelectPayload): void {
        if (this._featureSelectionNode) return;
        this._loadPrefab(PREFAB_NAMES.featureSelection, (node) => {
            this._featureSelectionNode = node;
            EventBus.instance.emit(GameEvents.FEATURE_SELECT_OPEN, payload);
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
