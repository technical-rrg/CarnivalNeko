/**
 * PickGamePopup — Carnival Neko Jackpot Feature (Pick Game).
 *
 * Design:
 *   - Grid 5×3 = 15 coin
 *   - Flip → Mini / Minor / Major / Grand / Upgrade
 *   - Match 3 JP → Jackpot popup (tier trả thưởng)
 *   - 3 Upgrade trước → nâng 1 bậc (Grand → ×2), feature tiếp tục
 *
 * API-ready: mọi pick đều qua NetworkManager.sendPickRequest
 * (MockAdapter hoặc RealAdapter). UI chỉ render theo ServerPickResponse.
 */

import {
    _decorator, Component, Node, Label, tween, Vec3, Tween,
    Sprite, SpriteFrame, sp, Layout, Button, Color, Prefab, UITransform,
} from 'cc';
import { EventBus }      from '../core/EventBus';
import { GameEvents }    from '../core/GameEvents';
import { PickGameState, JackpotType, SymbolId } from '../data/SlotTypes';
import {
    psPickToClient,
    psPickIdleId,
    clientSymToJackpotType,
    isPickUpgradeSymbol,
    JACKPOT_INDEX_TO_TYPE,
    PICK_GAME_CELL_COUNT,
} from '../data/PickGameUtil';
import { GameData }      from '../data/GameData';
import { NetworkManager } from '../manager/NetworkManager';
import { SoundManager }  from '../manager/SoundManager';
import { Log }           from '../core/Logger';
import { SpriteNumber }  from '../core/SpriteNumber';
import { TransitionMode } from './TopUpTransitionPopup';
import {
    fadeNodeOpacity,
    getNodeOpacity,
    setNodeOpacity,
    DEFAULT_UI_FADE_DURATION,
} from '../core/OpacityFadeUtil';

const { ccclass, property } = _decorator;

@ccclass('PickGamePopup')
export class PickGamePopup extends Component {

    @property({
        type: [Node],
        tooltip: '15 coin nodes (5×3) theo thứ tự 0..14.\n'
               + 'Mỗi node: CoinBack + CoinFront (sp.Skeleton hoặc Sprite).',
    })
    coinNodes: Node[] = [];

    @property({ type: sp.SkeletonData, tooltip: 'SpineData Jackpot MINI.' })
    spineJpMini: sp.SkeletonData | null = null;

    @property({ type: sp.SkeletonData, tooltip: 'SpineData Jackpot MINOR.' })
    spineJpMinor: sp.SkeletonData | null = null;

    @property({ type: sp.SkeletonData, tooltip: 'SpineData Jackpot MAJOR.' })
    spineJpMajor: sp.SkeletonData | null = null;

    @property({ type: sp.SkeletonData, tooltip: 'SpineData Jackpot GRAND.' })
    spineJpGrand: sp.SkeletonData | null = null;

    @property({ type: sp.SkeletonData, tooltip: 'SpineData Upgrade Coin (optional).' })
    spineJpUpgrade: sp.SkeletonData | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame Upgrade (ps_86) — dùng tạm khi chưa có spine.',
    })
    frameJpUpgrade: SpriteFrame | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame Mini (ps_85) — dùng tạm khi chưa có spine.',
    })
    frameJpMini: SpriteFrame | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame Minor (ps_84) — dùng tạm khi chưa có spine.',
    })
    frameJpMinor: SpriteFrame | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame Major (ps_83) — dùng tạm khi chưa có spine.',
    })
    frameJpMajor: SpriteFrame | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame Grand (ps_82) — dùng tạm khi chưa có spine.',
    })
    frameJpGrand: SpriteFrame | null = null;

    @property({
        tooltip: 'true = lật coin dùng hình symbol (tạm).\n'
               + 'false = dùng spine khi đã gán SkeletonData.\n'
               + 'Thiếu frame thì vẫn fallback spine.',
    })
    preferSymbolSprites: boolean = true;

    @property({
        type: Prefab,
        tooltip: 'Prefab CoinFont (SpriteNumber) — demo / dùng sau khi hiện credit trên coin.',
    })
    coinFontPrefab: Prefab | null = null;

    @property({
        type: Node,
        tooltip: 'Node CoinFont demo trong prefab (SpriteNumber).',
    })
    coinFontDemo: Node | null = null;

    @property({ tooltip: 'false → bỏ qua TopUpTransitionPopup, vào Pick Game ngay.\nMặc định false — dùng JackpotStartPopup (Press to Start) thay Transition.' })
    useTopUpTransition: boolean = false;

    @property({ type: Node, tooltip: 'Node nội dung pick game (coin grid, labels).' })
    gameContentNode: Node | null = null;

    @property({ type: Node, tooltip: 'Bottom UI (spin/bet) — ẩn khi pick, hiện khi đóng.' })
    bottomUINode: Node | null = null;

    @property({ type: Label })
    instruction1Label: Label | null = null;

    @property({ type: Label })
    instruction2Label: Label | null = null;

    @property({ type: Label })
    themeTextLabel: Label | null = null;

    @property({ tooltip: 'Nội dung themeTextLabel.' })
    themeText: string = '福壽雙全';

    @property({ tooltip: 'Thời gian fade-in opacity PickGame (giây).' })
    showDuration: number = DEFAULT_UI_FADE_DURATION;

    @property({ tooltip: 'Thời gian fade-out opacity khi đóng (giây).' })
    hideDuration: number = DEFAULT_UI_FADE_DURATION;

    @property({ tooltip: 'Thời gian flip mỗi coin (giây).' })
    flipDuration: number = 0.3;

    @property({ tooltip: 'Delay sau match pulse trước JACKPOT_TRIGGER (giây).' })
    jackpotTriggerDelay: number = 0.35;

    @property({ tooltip: 'Thời gian 3 ô match nhún zoom (giây).' })
    matchCelebrateDuration: number = 0.7;

    @property({ tooltip: 'Delay sau Upgrade×3 trước khi cho pick tiếp (giây).' })
    upgradeCelebrateDelay: number = 0.8;

    private _pickState: PickGameState | null = null;
    private _revealedSet: Set<number> = new Set();
    private _matched: boolean = false;
    private _wonTier: JackpotType = JackpotType.NONE;
    private _doubleGrand: boolean = false;
    private _upgradeArmed: boolean = false;
    private _inEntry: boolean = false;
    private _pickBlocked: boolean = false;
    private _serverPickWinAmount: number = 0;
    private _lastRevealedIndex: number = -1;

    onLoad(): void {
        this.node.active = false;
        setNodeOpacity(this.node, 0);
        const bus = EventBus.instance;
        bus.on(GameEvents.PICK_GAME_OPEN,          this.openPickGame,     this);
        bus.on(GameEvents.JACKPOT_END,             this._onJackpotEnd,       this);
        bus.on(GameEvents.TOPUP_TRANSITION_DONE,   this._onTransitionDone,   this);
        this._initCoinFontDemo();
    }

    /** CoinFont demo trên prefab — set số mẫu để xem font trong Editor / runtime. */
    private _initCoinFontDemo(): void {
        const node = this.coinFontDemo
            ?? this.gameContentNode?.getChildByName('CoinFont')
            ?? this.node.getChildByName('CoinFont');
        if (!node?.isValid) return;
        this.coinFontDemo = node;
        const sn = node.getComponent(SpriteNumber)
            ?? node.getComponentInChildren(SpriteNumber);
        if (!sn) return;
        sn.joltEnabled = false;
        sn.setData(1234567);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    public resolveCoinIndex(node: Node): number {
        return this.coinNodes.indexOf(node);
    }

    /**
     * Tap coin → luôn gọi /Pick (Mock hoặc Real) rồi flip theo response.
     */
    public pickCoin(index: number): void {
        if (this._inEntry || this._pickBlocked || this._matched) return;
        if (!this._pickState?.grid) return;
        if (this._revealedSet.has(index)) return;
        if (index < 0 || index >= this.coinNodes.length || !this.coinNodes[index]) return;
        // Cho phép pick cả khi grid mock ngắn hơn (pad) — vẫn gọi API
        if (index >= Math.max(this._pickState.grid.length, PICK_GAME_CELL_COUNT)) return;

        this._setButtonsInteractable(false);
        void this._pickCoinViaApi(index);
    }

    private async _pickCoinViaApi(index: number): Promise<void> {
        try {
            const resp = await NetworkManager.instance.sendPickRequest(index);

            const pickWinAmt = this._extractPickWin(resp);
            const needClaim = resp.NextStage === 102 || resp.NextStage >= 100;
            // CN: IsJackpot luôn false — thắng khi PickWin > 0 / JackpotName / PICK_END
            const won = !!resp.IsJackpot
                || pickWinAmt > 0
                || !!(resp.JackpotName && String(resp.JackpotName).trim())
                || needClaim;

            Log.d(`[PickGamePopup] PICK #${index} IsJackpot=${resp.IsJackpot} JP=${resp.JackpotIndex}`
                + ` Name=${resp.JackpotName ?? 'n/a'} Upgrade=${resp.UpgradeCount ?? '?'}`
                + ` UpgradeDone=${!!resp.IsUpgradeComplete} DoubleGrand=${!!resp.DoubleGrand}`
                + ` PickWin=${pickWinAmt} won=${won} NextStage=${resp.NextStage}`);

            if (this._pickState && resp.PickGame) {
                // Đồng bộ grid từ server; -1 / Idle = chưa lộ → giữ local (mock prefill)
                for (let i = 0; i < resp.PickGame.length; i++) {
                    const serverSym = resp.PickGame[i];
                    if (serverSym === -1 || serverSym === psPickIdleId()) continue;
                    this._pickState.grid[i] = psPickToClient(serverSym);
                }
            }

            // Ô vừa pick: lấy từ response, fallback local grid
            const serverSym = resp.PickGame?.[index];
            if (serverSym != null && serverSym !== -1 && this._pickState) {
                this._pickState.grid[index] = psPickToClient(serverSym);
            }

            this._revealCoin(index, () => {
                if (resp.IsUpgradeComplete && !this._upgradeArmed) {
                    this._upgradeArmed = true;
                    if (this._pickState) this._pickState.upgradeArmed = true;
                    EventBus.instance.emit(GameEvents.PICK_GAME_UPGRADE_COMPLETE, resp.UpgradeCount ?? 3);
                    this._playUpgradeCelebrate(() => {
                        if (!this._matched) this._setButtonsInteractable(true);
                    });
                }

                if (won && !this._matched) {
                    this._matched = true;
                    this._wonTier = this._resolveWonTier(resp);
                    this._doubleGrand = !!resp.DoubleGrand
                        || /grand\s*x\s*2|grandupgrade|×\s*2/i.test(String(resp.JackpotName ?? ''));
                    this._serverPickWinAmount = pickWinAmt;
                    if (this._serverPickWinAmount > 0) {
                        GameData.instance.pickGameWinAmount = this._serverPickWinAmount;
                    }
                    if (this._pickState) {
                        this._pickState.wonTier = JackpotType[this._wonTier] as any;
                        this._pickState.doubleGrand = this._doubleGrand;
                    }
                    Log.d(`[PickGamePopup] JACKPOT paid=${JackpotType[this._wonTier]} x2=${this._doubleGrand} win=${pickWinAmt}`);
                    EventBus.instance.emit(GameEvents.PICK_GAME_MATCH_FOUND, this._wonTier);
                    this._setButtonsInteractable(false);
                    // Chờ ô cuối In xong → pulse 3 ô (spine chỉ có In/Loop, không có win)
                    // rồi mới JACKPOT_TRIGGER — tránh cắt anim ô cuối.
                    this._playWinAnimation(this._wonTier, () => {
                        this.scheduleOnce(this._emitJackpot, this.jackpotTriggerDelay);
                    });
                } else if (!resp.IsUpgradeComplete && !this._matched) {
                    this._setButtonsInteractable(true);
                }

                if (needClaim) {
                    EventBus.instance.emit(GameEvents.PICK_GAME_NEED_CLAIM);
                }
            });
        } catch (err) {
            Log.e('[PickGamePopup] sendPickRequest failed:', err);
            this._setButtonsInteractable(true);
        }
    }

    public openPickGame(state: PickGameState): void {
        this.unscheduleAllCallbacks();
        GameData.instance.pickGameWinAmount = 0;

        const raw = state as any;
        if (!state.grid && raw.Grid) state = { ...state, grid: raw.Grid };
        if (!state.revealed && raw.Revealed) state = { ...state, revealed: raw.Revealed };
        if (!state.grid) {
            Log.e('[PickGamePopup] openPickGame: state.grid missing — abort');
            return;
        }

        // Pad grid lên 15 nếu mock/legacy còn 12
        if (state.grid.length < PICK_GAME_CELL_COUNT) {
            const pad = state.grid.slice();
            while (pad.length < PICK_GAME_CELL_COUNT) pad.push(SymbolId.JP_MINI);
            state = { ...state, grid: pad };
        }

        this._pickState = state;
        GameData.instance.pickGameState = state;
        this._revealedSet = new Set(state.revealed ?? []);
        this._matched = false;
        this._wonTier = JackpotType.NONE;
        this._doubleGrand = !!state.doubleGrand;
        this._upgradeArmed = !!state.upgradeArmed;
        this._inEntry = true;
        this._pickBlocked = false;
        this._serverPickWinAmount = 0;
        this._lastRevealedIndex = -1;

        if (this.coinFontDemo?.isValid) this.coinFontDemo.active = false;

        this._ensureCoinGridLayout();
        this._wireCoinButtons();

        for (let i = 0; i < this.coinNodes.length; i++) {
            this._resetCoin(i);
        }
        // Resume: re-show already revealed
        for (const idx of this._revealedSet) {
            this._showRevealedImmediate(idx);
        }

        if (this.instruction1Label) {
            this.instruction1Label.string = 'PRESS COIN TO REVEAL LUCKY SYMBOL.';
        }
        if (this.instruction2Label) {
            this.instruction2Label.string = 'MATCH 3 TO WIN JACKPOT. 3 UPGRADES RAISE THE PRIZE.';
        }
        if (this.themeTextLabel) {
            this.themeTextLabel.string = this.themeText;
        }

        // Mặc định opacity 0 → fade lên 255 (không cắt active cứng)
        this.node.active = true;
        setNodeOpacity(this.node, 0);
        if (this.gameContentNode) {
            this.gameContentNode.active = true;
            setNodeOpacity(this.gameContentNode, 0);
        }

        Log.d(`[PickGamePopup] Opening — cells=${state.grid.length} coins=${this.coinNodes.length}`);

        if (this.useTopUpTransition) {
            EventBus.instance.emit(GameEvents.TOPUP_TRANSITION_SHOW, TransitionMode.PickGame);
            this.scheduleOnce(this._onEntryDone, 3.0);
        } else {
            this._onEntryDone();
        }
    }

    private _onJackpotEnd(): void {
        if (!this.node.isValid) return;
        if (!this.node.active && getNodeOpacity(this.node) <= 0) return;
        this._closePopup(true);
    }

    private _onTransitionDone(): void {
        if (this._inEntry) {
            this.unschedule(this._onEntryDone);
            this._onEntryDone();
        }
    }

    private _onEntryDone = (): void => {
        Log.d('[PickGamePopup] Entry done — fade in coin grid');

        const onContentShown = (): void => {
            this._playCoinIntroBounce();
        };

        // Root + content fade 0 → 255
        fadeNodeOpacity(this.node, 255, this.showDuration);
        if (this.gameContentNode) {
            this.gameContentNode.active = true;
            this.gameContentNode.setScale(1, 1, 1);
            setNodeOpacity(this.gameContentNode, 0);
            fadeNodeOpacity(this.gameContentNode, 255, this.showDuration, onContentShown);
        } else {
            onContentShown();
        }

        if (this.bottomUINode) this.bottomUINode.active = false;
        EventBus.instance.emit(GameEvents.HIDE_BOTTOM_UI);
        EventBus.instance.emit(GameEvents.PICK_GAME_ENTRY_DONE);
    };

    /** Reflow Layout 5×3 rồi freeze — tránh setSiblingIndex làm lệch vị trí. */
    private _ensureCoinGridLayout(): void {
        const grid = this.coinNodes[0]?.parent;
        if (!grid?.isValid) return;
        const layout = grid.getComponent(Layout);
        if (layout) {
            layout.constraintNum = 5;
            layout.enabled = true;
            const anyLayout = layout as Layout & { updateLayout?: () => void };
            anyLayout.updateLayout?.();
            layout.enabled = false;
            Log.d('[PickGamePopup] CoinGrid Layout 5-col applied then frozen');
        }
    }

    private _wireCoinButtons(): void {
        for (let i = 0; i < this.coinNodes.length; i++) {
            const node = this.coinNodes[i];
            if (!node?.isValid) continue;
            const pickBtn = node.getComponent('CoinPickButton') as {
                coinIndex: number;
                pickGamePopup: PickGamePopup | null;
            } | null;
            if (pickBtn) {
                pickBtn.coinIndex = i;
                pickBtn.pickGamePopup = this;
            }
            const btn = node.getComponent(Button) ?? node.addComponent(Button);
            btn.interactable = true;
        }
    }

    private _setCoinInteractable(index: number, enabled: boolean): void {
        const node = this.coinNodes[index];
        if (!node) return;
        const btn = node.getComponent(Button);
        if (btn) btn.interactable = enabled;
    }

    private _resetCoin(index: number): void {
        const node = this.coinNodes[index];
        if (!node) return;
        Tween.stopAllByTarget(node);
        node.setScale(1, 1, 1);
        this._setCoinInteractable(index, true);

        const back  = node.getChildByName('CoinBack');
        const front = node.getChildByName('CoinFront');
        if (back) back.active = true;
        if (front) {
            front.active = false;
            const sk = front.getComponent(sp.Skeleton);
            if (sk) {
                sk.enabled = true;
                sk.setToSetupPose();
                sk.clearTracks();
                sk.color = Color.WHITE;
            }
            this._setSymbolSpriteChild(front, null);
        }
    }

    private _showRevealedImmediate(index: number): void {
        if (!this._pickState) return;
        const node = this.coinNodes[index];
        if (!node) return;
        const back = node.getChildByName('CoinBack');
        const front = node.getChildByName('CoinFront');
        if (back) back.active = false;
        if (front) {
            front.active = true;
            const sym = this._pickState.grid[index];
            this._applySymbolToFront(front, sym);
        }
        this._setCoinInteractable(index, false);
    }

    private _playCoinIntroBounce(): void {
        const DURATION = 1;
        const PULSES = 2;
        const half = DURATION / (PULSES * 2);

        for (const node of this.coinNodes) {
            if (!node) continue;
            Tween.stopAllByTarget(node);
            const t = tween(node);
            for (let i = 0; i < PULSES; i++) {
                t.to(half, { scale: new Vec3(1.1, 1.1, 1) }, { easing: 'sineInOut' })
                 .to(half, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' });
            }
            t.start();
        }
        this.scheduleOnce(() => { this._inEntry = false; }, DURATION);
    }

    private _revealCoin(index: number, onDone?: () => void): void {
        if (!this._pickState) return;
        const node = this.coinNodes[index];
        if (!node) { onDone?.(); return; }

        const symbolId = this._pickState.grid[index];
        const jpType = clientSymToJackpotType(symbolId);
        if (jpType !== JackpotType.NONE) {
            SoundManager.instance?.playBonusSelect(jpType);
        }
        this._revealedSet.add(index);
        this._lastRevealedIndex = index;
        this._setCoinInteractable(index, false);

        if (node.parent) {
            node.setSiblingIndex(node.parent.children.length - 1);
        }

        const half = this.flipDuration / 2;
        Tween.stopAllByTarget(node);

        tween(node)
            .to(half, { scale: new Vec3(0, 1, 1) })
            .call(() => {
                const back  = node.getChildByName('CoinBack');
                const front = node.getChildByName('CoinFront');
                if (back) back.active = false;
                if (front) {
                    front.active = true;
                    this._applySymbolToFront(front, symbolId);
                }
            })
            .to(half, { scale: new Vec3(1, 1, 1) })
            .call(() => { onDone?.(); })
            .start();
    }

    private _applySymbolToFront(front: Node, symbolId: number): void {
        const frame = this._resolveSymbolFrame(symbolId);
        if (this.preferSymbolSprites && frame) {
            this._applySpriteToFront(front, frame);
            return;
        }
        if (isPickUpgradeSymbol(symbolId)) {
            this._applyUpgradeToFront(front);
            return;
        }
        const jpType = clientSymToJackpotType(symbolId);
        this._applySpineToFront(front, jpType);
        // Spine chưa gán → vẫn hiện hình symbol nếu có
        if (frame && !this._hasSpineFor(jpType, symbolId)) {
            this._applySpriteToFront(front, frame);
        }
    }

    private _resolveSymbolFrame(symbolId: number): SpriteFrame | null {
        if (isPickUpgradeSymbol(symbolId)) return this.frameJpUpgrade;
        switch (clientSymToJackpotType(symbolId)) {
            case JackpotType.MINI:  return this.frameJpMini;
            case JackpotType.MINOR: return this.frameJpMinor;
            case JackpotType.MAJOR: return this.frameJpMajor;
            case JackpotType.GRAND: return this.frameJpGrand;
            default: return null;
        }
    }

    private _hasSpineFor(jpType: JackpotType, symbolId: number): boolean {
        if (isPickUpgradeSymbol(symbolId)) return !!this.spineJpUpgrade;
        const dataMap: Partial<Record<JackpotType, sp.SkeletonData | null>> = {
            [JackpotType.MINI]:  this.spineJpMini,
            [JackpotType.MINOR]: this.spineJpMinor,
            [JackpotType.MAJOR]: this.spineJpMajor,
            [JackpotType.GRAND]: this.spineJpGrand,
        };
        return !!dataMap[jpType];
    }

    private _applySpriteToFront(front: Node, frame: SpriteFrame): void {
        const sk = front.getComponent(sp.Skeleton);
        if (sk) {
            sk.clearTracks();
            sk.enabled = false;
        }
        this._setSymbolSpriteChild(front, frame);
    }

    private _applyUpgradeToFront(front: Node): void {
        const sk = front.getComponent(sp.Skeleton);
        if (this.frameJpUpgrade) {
            this._applySpriteToFront(front, this.frameJpUpgrade);
            return;
        }

        this._setSymbolSpriteChild(front, null);

        if (this.spineJpUpgrade && sk) {
            sk.enabled = true;
            sk.skeletonData = this.spineJpUpgrade;
            sk.color = new Color(255, 220, 80, 255);
            sk.setAnimation(0, 'In', false);
            sk.setCompleteListener(() => {
                sk.setAnimation(0, 'Loop', true);
            });
            return;
        }

        // Fallback: reuse spine Major + tint vàng
        if (sk && this.spineJpMajor) {
            sk.enabled = true;
            sk.skeletonData = this.spineJpMajor;
            sk.color = new Color(255, 200, 40, 255);
            sk.setAnimation(0, 'In', false);
            sk.setCompleteListener(() => {
                sk.setAnimation(0, 'Loop', true);
            });
            Log.d('[PickGamePopup] Upgrade dùng spine Major + tint (chưa có art Upgrade).');
            return;
        }

        Log.d('[PickGamePopup] Chưa gán visual Upgrade (spineJpUpgrade / frameJpUpgrade).');
    }

    /**
     * Sprite symbol trên child — tránh conflict Skeleton + Sprite cùng CoinFront.
     */
    private _setSymbolSpriteChild(front: Node, frame: SpriteFrame | null): void {
        const CHILD = 'SymbolIcon';
        let child = front.getChildByName(CHILD) ?? front.getChildByName('UpgradeIcon');
        if (!frame) {
            if (child) child.active = false;
            return;
        }
        if (!child) {
            child = new Node(CHILD);
            front.addChild(child);
            child.layer = front.layer;
            child.addComponent(Sprite);
            const ut = child.getComponent(UITransform) ?? child.addComponent(UITransform);
            ut.setContentSize(130, 130);
        }
        child.name = CHILD;
        child.active = true;
        const spr = child.getComponent(Sprite)!;
        spr.sizeMode = Sprite.SizeMode.TRIMMED;
        spr.spriteFrame = frame;
        spr.color = Color.WHITE;
        child.setScale(1, 1, 1);
    }

    private _applySpineToFront(front: Node, jpType: JackpotType): void {
        this._setSymbolSpriteChild(front, null);

        const dataMap: Partial<Record<JackpotType, sp.SkeletonData | null>> = {
            [JackpotType.MINI]:  this.spineJpMini,
            [JackpotType.MINOR]: this.spineJpMinor,
            [JackpotType.MAJOR]: this.spineJpMajor,
            [JackpotType.GRAND]: this.spineJpGrand,
        };
        const data = dataMap[jpType];
        const sk = front.getComponent(sp.Skeleton);
        if (sk && data) {
            sk.enabled = true;
            sk.color = Color.WHITE;
            sk.skeletonData = data;
            sk.setAnimation(0, 'In', false);
            sk.setCompleteListener(() => {
                sk.setAnimation(0, 'Loop', true);
            });
        } else if (!sk) {
            Log.d('[PickGamePopup] CoinFront thiếu sp.Skeleton.');
        } else if (!data) {
            Log.d(`[PickGamePopup] Chưa gán SpineData tier=${JackpotType[jpType]}.`);
        }
    }

    private _playUpgradeCelebrate(onDone: () => void): void {
        Log.d('[PickGamePopup] Upgrade ×3 complete — celebrate');
        for (const idx of this._revealedSet) {
            const sym = this._pickState?.grid[idx];
            if (!isPickUpgradeSymbol(sym ?? -1)) continue;
            const node = this.coinNodes[idx];
            if (!node) continue;
            Tween.stopAllByTarget(node);
            tween(node)
                .to(0.15, { scale: new Vec3(1.25, 1.25, 1) }, { easing: 'sineOut' })
                .to(0.15, { scale: new Vec3(1, 1, 1) }, { easing: 'sineIn' })
                .start();
        }
        this.scheduleOnce(onDone, this.upgradeCelebrateDelay);
    }

    /**
     * Celebrate 3 ô match — chỉ nhún zoom nhẹ (giữ spine đang Loop).
     * Chờ ô cuối xong In trước để không bị cắt anim reveal.
     */
    private _playWinAnimation(wonTier: JackpotType, onDone?: () => void): void {
        const matched = this._collectMatchedIndices(wonTier);
        const startCelebrate = () => this._doPlayWinAnimation(matched, onDone);

        const lastIdx = this._lastRevealedIndex;
        const lastNode = lastIdx >= 0 ? this.coinNodes[lastIdx] : null;
        const front = lastNode?.getChildByName('CoinFront');
        const sk = front?.getComponent(sp.Skeleton);
        const current = sk?.getCurrent(0);
        if (sk && current?.animation?.name === 'In') {
            sk.setCompleteListener(() => {
                sk.setCompleteListener(null);
                sk.setAnimation(0, 'Loop', true);
                startCelebrate();
            });
            return;
        }
        startCelebrate();
    }

    private _collectMatchedIndices(wonTier: JackpotType): number[] {
        if (!this._pickState) return [];
        const matched: number[] = [];
        const counts: Partial<Record<JackpotType, number[]>> = {};
        for (const idx of this._revealedSet) {
            const tier = clientSymToJackpotType(this._pickState.grid[idx]);
            if (tier === JackpotType.NONE) continue;
            if (!counts[tier]) counts[tier] = [];
            counts[tier]!.push(idx);
        }
        for (const t of [JackpotType.MINI, JackpotType.MINOR, JackpotType.MAJOR, JackpotType.GRAND]) {
            const list = counts[t];
            if (list && list.length >= 3) {
                matched.push(...list.slice(0, 3));
                break;
            }
        }
        if (matched.length === 0) {
            for (const idx of this._revealedSet) {
                if (matched.length >= 3) break;
                if (clientSymToJackpotType(this._pickState.grid[idx]) === wonTier) {
                    matched.push(idx);
                }
            }
        }
        // Đảm bảo ô vừa pick luôn nằm trong nhóm celebrate
        if (this._lastRevealedIndex >= 0 && !matched.includes(this._lastRevealedIndex)) {
            matched.push(this._lastRevealedIndex);
        }
        return matched;
    }

    private _doPlayWinAnimation(matched: number[], onDone?: () => void): void {
        Log.d(`[PickGamePopup] Match celebrate coins=[${matched.join(',')}]`);

        for (const idx of matched) {
            const node = this.coinNodes[idx];
            if (!node?.isValid) continue;

            // Chỉ nhún zoom nhẹ — giữ spine Loop hiện tại, không replay In
            Tween.stopAllByTarget(node);
            node.setScale(1, 1, 1);
            if (node.parent) {
                node.setSiblingIndex(node.parent.children.length - 1);
            }
            tween(node)
                .to(0.12, { scale: new Vec3(1.2, 1.2, 1) }, { easing: 'sineOut' })
                .to(0.12, { scale: new Vec3(1.0, 1.0, 1) }, { easing: 'sineIn' })
                .to(0.12, { scale: new Vec3(1.14, 1.14, 1) }, { easing: 'sineOut' })
                .to(0.14, { scale: new Vec3(1.0, 1.0, 1) }, { easing: 'backOut' })
                .start();
        }

        this.scheduleOnce(() => onDone?.(), this.matchCelebrateDuration);
    }

    private _extractPickWin(resp: any): number {
        const raw = resp?.PickWin ?? resp?.pickWin ?? resp?.WinCash ?? resp?.winCash ?? resp?.TotalWin ?? resp?.totalWin;
        const value = Number(raw);
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    /** CN: ưu tiên JackpotName → JackpotIndex → đếm 3-match trên grid. */
    private _resolveWonTier(resp: any): JackpotType {
        const name = String(resp?.JackpotName ?? resp?.jackpotName ?? '').toLowerCase();
        if (name.includes('grand')) return JackpotType.GRAND;
        if (name.includes('major')) return JackpotType.MAJOR;
        if (name.includes('minor')) return JackpotType.MINOR;
        if (name.includes('mini')) return JackpotType.MINI;

        if (resp?.JackpotIndex != null && resp.JackpotIndex >= 0) {
            return JACKPOT_INDEX_TO_TYPE[resp.JackpotIndex] ?? JackpotType.MINI;
        }

        if (this._pickState?.grid) {
            const counts: Partial<Record<JackpotType, number>> = {};
            for (const idx of this._revealedSet) {
                const tier = clientSymToJackpotType(this._pickState.grid[idx]);
                if (tier !== JackpotType.NONE) {
                    counts[tier] = (counts[tier] ?? 0) + 1;
                    if ((counts[tier] ?? 0) >= 3) return tier;
                }
            }
        }
        return JackpotType.MINI;
    }

    private _resolveJackpotAmount(): { amount: number; source: string } {
        if (this._serverPickWinAmount > 0) {
            return { amount: this._serverPickWinAmount, source: 'PickWin' };
        }
        const meter = GameData.instance.getJackpotWinAmount(this._wonTier);
        if (meter > 0) {
            const amount = this._doubleGrand ? meter * 2 : meter;
            return { amount, source: 'JackpotValues' };
        }
        if (GameData.instance.pickGameWinAmount > 0) {
            return { amount: GameData.instance.pickGameWinAmount, source: 'ClaimWinCash' };
        }
        // Mock fallback: bet × multiplier (doc)
        const mult = GameData.instance.config.jackpotMultipliers;
        const map: Partial<Record<JackpotType, number>> = {
            [JackpotType.MINI]: mult?.MINI ?? 10,
            [JackpotType.MINOR]: mult?.MINOR ?? 20,
            [JackpotType.MAJOR]: mult?.MAJOR ?? 50,
            [JackpotType.GRAND]: mult?.GRAND ?? 300,
        };
        let amount = (map[this._wonTier] ?? 10) * GameData.instance.totalBet;
        if (this._doubleGrand) amount *= 2;
        return { amount, source: 'BetMultiplier' };
    }

    private _emitJackpot = (): void => {
        const { amount, source } = this._resolveJackpotAmount();
        Log.d(`[PickGamePopup] EMIT JACKPOT_TRIGGER tier=${JackpotType[this._wonTier]} amount=${amount} src=${source} x2=${this._doubleGrand}`);
        GameData.instance.pickGameWinAmount = amount;
        EventBus.instance.emit(GameEvents.JACKPOT_TRIGGER, this._wonTier, amount);
    };

    private _setButtonsInteractable(enabled: boolean): void {
        this._pickBlocked = !enabled;
    }

    private _closePopup(skipEmitClose: boolean = false): void {
        this.unscheduleAllCallbacks();

        const doClose = () => {
            this._pickState = null;
            if (this.bottomUINode) this.bottomUINode.active = true;
            EventBus.instance.emit(GameEvents.SHOW_BOTTOM_UI);
            if (!skipEmitClose) {
                Log.d('[PickGamePopup] Closed → emit PICK_GAME_CLOSE');
                EventBus.instance.emit(GameEvents.PICK_GAME_CLOSE);
            }
            this.node.destroy();
        };

        // Fade opacity → 0 rồi destroy (song song SlotMachine fade-in)
        fadeNodeOpacity(this.node, 0, this.hideDuration, doClose);
        if (this.gameContentNode?.isValid) {
            fadeNodeOpacity(this.gameContentNode, 0, this.hideDuration);
        }
    }
}
