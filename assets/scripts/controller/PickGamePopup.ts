/**
 * PickGamePopup — Carnival Neko Jackpot Feature (API V1.0.2).
 *
 *   - 15 ô; /Pick mỗi lần chọn 1 ô (PickIndex 0–14)
 *   - CNPickResponse: PickGame[-1|PS], PickResults, PickWin, JackpotName, NextStage
 *   - Match 3 JP → PICK_END + JackpotName/PickWin (server đã gồm upgrade nếu có)
 *   - 3 Upgrade → 4 đợt clone (Grand→Major→Minor→Mini), pick tiếp (không kết thúc)
 */

import {
    _decorator, Component, Node, Label, tween, Vec3, Tween,
    Sprite, SpriteFrame, SpriteAtlas, sp, Layout, Button, Color, Prefab, UITransform,
    instantiate, UIOpacity, isValid, NodePool, ParticleSystem,
} from 'cc';
import { EventBus }      from '../core/EventBus';
import { GameEvents }    from '../core/GameEvents';
import { PickGameState, JackpotType, SymbolId, SlotStageType } from '../data/SlotTypes';
import {
    psPickToClient,
    clientSymToJackpotType,
    clientSymToPickPsId,
    isPickUpgradeSymbol,
    isPickPsTransitionAnim,
    pickPsIdleAnim,
    pickPsTransitionAnim,
    resolvePickState,
    parseCnJackpotName,
    PICK_GAME_CELL_COUNT,
    computeUpgradedJackpotValues,
    PS_PICK,
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
import {
    buildJackpotPickFrames,
    getSymbolPackFrame,
    loadSymbolPackAtlas,
    resolveSymbolPackAtlas,
} from '../data/SymbolPackUtil';
import { RichTextShrink } from '../core/RichTextShrink';
import { JackpotDisplay } from './JackpotDisplay';

const { ccclass, property } = _decorator;


@ccclass('PickGamePopup')
export class PickGamePopup extends Component {

    @property({
        type: [Node],
        tooltip: '15 coin nodes (5×3) theo thứ tự 0..14.\n'
               + 'Mỗi node: CoinBack + CoinFront (sp.Skeleton hoặc Sprite).',
    })
    coinNodes: Node[] = [];

    @property({
        type: sp.SkeletonData,
        tooltip: 'Spine chung Pick Game (82–85 jackpot, 86 bonus).\n'
               + 'Anim: {ID}_Transition (lật) → {ID}_Idle (loop).\n'
               + 'Ví dụ: 82_Transition, 82_Idle, 86_Transition, 86_Idle.',
    })
    pickSymbolSpineData: sp.SkeletonData | null = null;

    @property({
        type: SpriteAtlas,
        tooltip: 'SymbolPack — frame 81 idle, 82 Grand, 83 Major, 84 Minor, 85 Mini, 86 Upgrade.',
    })
    symbolAtlas: SpriteAtlas | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame Upgrade (ps_86) — fallback; thường lấy từ SymbolPack.',
    })
    frameJpUpgrade: SpriteFrame | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame Mini (ps_85) — fallback; thường lấy từ SymbolPack.',
    })
    frameJpMini: SpriteFrame | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame Minor (ps_84) — fallback; thường lấy từ SymbolPack.',
    })
    frameJpMinor: SpriteFrame | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame Major (ps_83) — fallback; thường lấy từ SymbolPack.',
    })
    frameJpMajor: SpriteFrame | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame Grand (ps_82) — fallback; thường lấy từ SymbolPack.',
    })
    frameJpGrand: SpriteFrame | null = null;

    @property({
        tooltip: 'true = lật coin dùng Sprite SymbolPack.\n'
               + 'false = dùng pickSymbolSpineData + anim {ID}_Transition/{ID}_Idle.\n'
               + 'Thiếu frame hoặc spine thì tự fallback.',
    })
    preferSymbolSprites: boolean = false;

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

    @property({ tooltip: 'Biên độ lơ lửng Y coin chưa lật (px).' })
    hiddenCoinFloatHeight: number = 6;

    @property({ tooltip: 'Chu kỳ lơ lửng coin chưa lật (giây).' })
    hiddenCoinFloatDuration: number = 1.4;

    @property({ tooltip: 'Lệch pha thêm theo hàng (giây/hàng) — kết hợp so le bàn cờ.' })
    hiddenCoinFloatStagger: number = 0.06;

    @property({ tooltip: 'Delay sau Upgrade×3 burst trước khi cho pick tiếp (giây).' })
    upgradeCelebrateDelay: number = 0.35;

    @property({ tooltip: 'Tổng thời gian clone bay lên rồi tới JackpotDisplay (giây).' })
    upgradeFlyDuration: number = 0.5;

    @property({ tooltip: 'Độ cao bay lên ngay khi clone xuất hiện (px, local PickGamePopup).' })
    upgradeFlyLiftOffset: number = 70;

    @property({ tooltip: 'Tỷ lệ thời gian bay lên / tổng upgradeFlyDuration (0.15–0.7).' })
    upgradeFlyLiftRatio: number = 0.32;

    @property({ tooltip: 'Lệch pha giữa các đợt bay (Grand→Major→Minor→Mini) — nhỏ = chồng song song.' })
    upgradeWaveStagger: number = 0.08;

    @property({ tooltip: 'Delay giữa 3 clone trong cùng 1 đợt (giây) — clone 2, 3 xuất hiện lần lượt.' })
    upgradeCloneStagger: number = 0.06;

    @property({ tooltip: 'Scale clone khi chạm đích JackpotDisplay (so với lúc phóng).' })
    upgradeFlyEndScale: number = 0.35;

    @property({
        type: Node,
        tooltip: 'Template FX (inactive) — spawn tại slot jackpot khi 3 clone Upgrade chạm đích.\n'
            + 'Không dùng jackpotEffect* trên JackpotDisplay.',
    })
    upgradeJackpotHitFxTemplate: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Layer gắn FX (null = node PickGamePopup). Nên kéo Canvas nếu FX bị che.',
    })
    upgradeJackpotHitFxLayer: Node | null = null;

    @property({ tooltip: 'Giữ FX trước khi trả pool (giây).' })
    upgradeJackpotHitFxRecycleDelay: number = 1.2;

    private _pickState: PickGameState | null = null;
    private _revealedSet: Set<number> = new Set();
    private _matched: boolean = false;
    private _wonTier: JackpotType = JackpotType.NONE;
    private _doubleGrand: boolean = false;
    private _upgradeArmed: boolean = false;
    private _inEntry: boolean = false;
    private _pickBlocked: boolean = false;
    /** Pick shell hiện sẵn — chờ JackpotStartPopup đóng mới entry / pick. */
    private _awaitingStartPopup = false;

    public isAwaitingStartPopup(): boolean {
        return this._awaitingStartPopup;
    }
    private _serverPickWinAmount: number = 0;
    private _lastRevealedIndex: number = -1;
    private _frameIdle: SpriteFrame | null = null;
    private _symbolPackReady = false;
    private _upgradeFlyClones: Node[] = [];
    private _upgradeJackpotHitFxPool: NodePool | null = null;
    private readonly _maxUpgradeJackpotHitFxPool = 8;
    private _upgradeJackpotHitFxRecycleCbs = new Map<Node, () => void>();
    /** Vị trí gốc coin (trước float) — key = coin index. */
    private _coinBasePos = new Map<number, Vec3>();
    private _hiddenFloatPlaying = new Set<number>();

    onLoad(): void {
        this.node.active = false;
        setNodeOpacity(this.node, 0);
        this._initUpgradeJackpotHitFxPool();
        const bus = EventBus.instance;
        bus.on(GameEvents.JACKPOT_END,             this._onJackpotEnd,       this);
        bus.on(GameEvents.TOPUP_TRANSITION_DONE,   this._onTransitionDone,   this);
        this._initCoinFontDemo();
        this._initSymbolPackFrames();
        this._clearInstructionAutoLayout();
    }

    /** Gỡ RichTextShrink cũ (từng ép maxWidth=650) — dùng đúng size prefab. */
    private _clearInstructionAutoLayout(): void {
        const instruction = this._findInstruction1Node();
        if (!instruction) return;
        const shrink = instruction.getComponent(RichTextShrink);
        if (shrink) shrink.destroy();
    }

    private _findInstruction1Node(): Node | null {
        if (this.gameContentNode) {
            return this.gameContentNode.getChildByName('Instruction1');
        }
        return this.node.getChildByName('GameContent')?.getChildByName('Instruction1') ?? null;
    }

    /** Load jp frames + coin back idle từ SymbolPack. */
    private _initSymbolPackFrames(onReady?: () => void): void {
        const apply = (atlas: SpriteAtlas) => {
            this.symbolAtlas = atlas;
            const jp = buildJackpotPickFrames(atlas);
            this._frameIdle = jp.idle;
            this.frameJpMini = jp.mini ?? this.frameJpMini;
            this.frameJpMinor = jp.minor ?? this.frameJpMinor;
            this.frameJpMajor = jp.major ?? this.frameJpMajor;
            this.frameJpGrand = jp.grand ?? this.frameJpGrand;
            this.frameJpUpgrade = jp.upgrade ?? this.frameJpUpgrade;
            this._symbolPackReady = true;
            this._applyIdleCoinBacks();
            onReady?.();
        };

        const atlas = resolveSymbolPackAtlas(this.symbolAtlas);
        if (atlas) {
            apply(atlas);
            return;
        }
        loadSymbolPackAtlas(
            apply,
            (err) => Log.err('[PickGamePopup] load SymbolPack failed', err),
        );
    }

    private _applyIdleCoinBacks(): void {
        if (!this._frameIdle) return;
        for (const coin of this.coinNodes) {
            const back = coin?.getChildByName('CoinBack');
            const spr = back?.getComponent(Sprite);
            if (spr) spr.spriteFrame = this._frameIdle;
        }
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
        this._stopAllHiddenCoinFloats(false);
        this._clearUpgradeFlyClones();
        this._clearUpgradeJackpotHitFx();
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
            const paidTier = parseCnJackpotName(resp.JackpotName);
            const isPickEnd = resp.NextStage === SlotStageType.PICK_END;
            // CNPickResponse: IsJackpot luôn false, JackpotIndex luôn −1.
            // Thắng khi PickWin>0 / JackpotName / NextStage=PICK_END(102).
            const won = pickWinAmt > 0 || paidTier !== JackpotType.NONE || isPickEnd;

            const pickResultPs = Number(resp.PickResults);
            if (this._pickState && Array.isArray(resp.PickGame)) {
                // -1 = chưa chọn; số dương = PS ID đã lộ
                for (let i = 0; i < resp.PickGame.length; i++) {
                    const ps = Number(resp.PickGame[i]);
                    if (!Number.isFinite(ps) || ps === -1) continue;
                    this._pickState.grid[i] = psPickToClient(ps);
                }
            }

            // PickResults = symbol ô vừa pick (Table 23)
            if (Number.isFinite(pickResultPs) && pickResultPs > 0 && this._pickState) {
                this._pickState.grid[index] = psPickToClient(pickResultPs);
            }

            this._revealCoin(index, () => {
                const wasArmed = this._upgradeArmed;
                const resolved = this._pickState
                    ? resolvePickState(
                        this._pickState.grid,
                        Array.from(this._revealedSet),
                        wasArmed,
                    )
                    : null;

                // 3 Upgrade → celebrate rồi pick tiếp (NextStage vẫn PICK).
                if (resolved?.upgradeArmed || resp.IsUpgradeComplete) {
                    this._upgradeArmed = true;
                    if (this._pickState) {
                        this._pickState.upgradeArmed = true;
                        this._pickState.upgradeCount = resolved?.upgradeCount
                            ?? resp.UpgradeCount
                            ?? this._pickState.upgradeCount;
                    }
                }

                const upgradeJustDone = !wasArmed && this._upgradeArmed;
                if (upgradeJustDone && !this._matched) {
                    const apiJackpot = this._extractJackpotAfter(resp);
                    const localJackpot = computeUpgradedJackpotValues(GameData.instance.jackpotValues);
                    if (apiJackpot) {
                        Log.d(
                            `[PickGame] Upgrade×3 API jackpot=[${apiJackpot.join(',')}]`
                            + ` local=[${localJackpot.join(',')}]`,
                        );
                    } else {
                        Log.w(
                            `[PickGame] Upgrade×3 API không trả After/Wins — cascade local`
                            + ` [${localJackpot.join(',')}]`,
                        );
                    }
                    const nextVals = apiJackpot ?? localJackpot;
                    EventBus.instance.emit(
                        GameEvents.PICK_GAME_UPGRADE_COMPLETE,
                        {
                            upgradeCount: resolved?.upgradeCount ?? resp.UpgradeCount ?? 3,
                            jackpotValues: nextVals,
                            fromApi: !!apiJackpot,
                        },
                    );
                    this._playUpgradeCelebrate(nextVals, () => {
                        if (!this._matched) {
                            this._setButtonsInteractable(true);
                            this._refreshHiddenCoinFloats();
                        }
                    });
                }

                // 3 Upgrade ≠ win. Win chỉ khi server báo PickWin / JackpotName / PICK_END.
                const isWin = won && !this._matched && !upgradeJustDone;
                if (isWin) {
                    this._matched = true;
                    this._wonTier = paidTier !== JackpotType.NONE
                        ? paidTier
                        : this._resolveWonTier(resp);
                    this._doubleGrand = false;
                    this._serverPickWinAmount = pickWinAmt;
                    if (this._serverPickWinAmount > 0) {
                        GameData.instance.pickGameWinAmount = this._serverPickWinAmount;
                    }
                    if (this._pickState) {
                        this._pickState.wonTier = JackpotType[this._wonTier] as any;
                        this._pickState.doubleGrand = this._doubleGrand;
                    }
                    const matchedCells = this._collectMatchedIndices(this._wonTier).slice(0, 3);
                    const rawGrid: any[] = Array.isArray(resp.PickGame) ? resp.PickGame : [];
                    const matchedRaw = matchedCells.map(idx => rawGrid[idx] ?? 'n/a');
                    const matchedMapped = matchedCells.map(
                        idx => clientSymToPickPsId(this._pickState!.grid[idx]),
                    );
                    Log.d(
                        `[PickGame] WIN cells=[${matchedCells.join(',')}]`
                        + ` rawPickGameIds=[${matchedRaw.join(',')}]`
                        + ` mappedPsIds=[${matchedMapped.join(',')}]`
                        + ` PickResults=${JSON.stringify(resp.PickResults)}`
                        + ` JackpotName=${JSON.stringify(resp.JackpotName ?? '')}`
                        + ` paidTier=${JackpotType[this._wonTier]}`
                        + ` pickWin=${pickWinAmt}`,
                    );
                    EventBus.instance.emit(GameEvents.PICK_GAME_MATCH_FOUND, this._wonTier);
                    this._setButtonsInteractable(false);
                    this._playWinAnimation(this._wonTier, () => {
                        this.scheduleOnce(this._emitJackpot, this.jackpotTriggerDelay);
                    });
                } else if (!upgradeJustDone && !this._matched) {
                    this._setButtonsInteractable(true);
                }

                if (isPickEnd) {
                    EventBus.instance.emit(GameEvents.PICK_GAME_NEED_CLAIM);
                }
            });
        } catch (err) {
            Log.err('[PickGamePopup] sendPickRequest failed:', err);
            this._setButtonsInteractable(true);
        }
    }

    public openPickGame(state: PickGameState): void {
        this._awaitingStartPopup = false;
        this._startPickGameSession(state, () => this._continueOpenPickGame(state, false));
    }

    /** Hiện Pick Game sẵn (coin grid) — chưa entry / chưa pick. Dùng với JackpotStartPopup overlay. */
    public openPickGameShell(state: PickGameState): void {
        this._awaitingStartPopup = true;
        this._startPickGameSession(state, () => this._continueOpenPickGame(state, true));
    }

    /** Sau Press to Start — bounce coin + bật pick. */
    public beginPickGameEntry(): void {
        if (!this._awaitingStartPopup) {
            Log.w('[PickGamePopup] beginPickGameEntry — không ở shell mode');
            return;
        }
        this._awaitingStartPopup = false;
        this._inEntry = true;
        Log.d('[PickGamePopup] beginPickGameEntry — coin bounce');
        this._playCoinIntroBounce();
        this._setButtonsInteractable(true);
        for (let i = 0; i < this.coinNodes.length; i++) {
            if (!this._revealedSet.has(i)) {
                this._setCoinInteractable(i, true);
            }
        }
        EventBus.instance.emit(GameEvents.PICK_GAME_ENTRY_DONE);
    }

    private _startPickGameSession(state: PickGameState, onReady: () => void): void {
        this.unscheduleAllCallbacks();
        this._clearInstructionAutoLayout();
        GameData.instance.pickGameWinAmount = 0;

        const normalized = this._normalizePickState(state);
        if (!normalized) return;

        state = normalized;
        this._pickState = state;
        GameData.instance.pickGameState = state;
        this._revealedSet = new Set(state.revealed ?? []);
        this._matched = false;
        this._wonTier = JackpotType.NONE;
        this._doubleGrand = !!state.doubleGrand;
        const resumeResolved = resolvePickState(state.grid, state.revealed ?? [], !!state.upgradeArmed);
        this._upgradeArmed = resumeResolved.upgradeArmed;
        if (this._upgradeArmed) {
            state.upgradeArmed = true;
            state.upgradeCount = resumeResolved.upgradeCount;
        }
        this._serverPickWinAmount = 0;
        this._lastRevealedIndex = -1;
        this._coinBasePos.clear();
        this._hiddenFloatPlaying.clear();
        GameData.instance.holdJackpotValues = false;

        if (this.coinFontDemo?.isValid) this.coinFontDemo.active = false;

        this._initSymbolPackFrames(onReady);
        SoundManager.instance?.enterPickGameBgm();
    }

    private _normalizePickState(state: PickGameState): PickGameState | null {
        const raw = state as PickGameState & { Grid?: number[]; Revealed?: number[] };
        let s = state;
        if (!s.grid && raw.Grid) s = { ...s, grid: raw.Grid };
        if (!s.revealed && raw.Revealed) s = { ...s, revealed: raw.Revealed };
        if (!s.grid) {
            Log.err('[PickGamePopup] pick state grid missing — abort');
            return null;
        }
        if (s.grid.length < PICK_GAME_CELL_COUNT) {
            const pad = s.grid.slice();
            while (pad.length < PICK_GAME_CELL_COUNT) pad.push(SymbolId.JP_MINI);
            s = { ...s, grid: pad };
        }
        return s;
    }

    private _continueOpenPickGame(state: PickGameState, shellOnly: boolean): void {
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

        if (shellOnly) {
            this._awaitingStartPopup = true;
            this._inEntry = true;
            this._pickBlocked = true;
            this.node.active = true;
            setNodeOpacity(this.node, 255);
            if (this.gameContentNode) {
                this.gameContentNode.active = true;
                this.gameContentNode.setScale(1, 1, 1);
                setNodeOpacity(this.gameContentNode, 255);
            }
            for (let i = 0; i < this.coinNodes.length; i++) {
                this._setCoinInteractable(i, false);
            }
            if (this.bottomUINode) this.bottomUINode.active = false;
            EventBus.instance.emit(GameEvents.HIDE_BOTTOM_UI);
            Log.d(`[PickGamePopup] Shell ready — cells=${state.grid.length} awaiting Start popup`);
            return;
        }

        this._inEntry = true;
        this._pickBlocked = false;

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
        if (!this._matched) {
            Log.w('[PickGamePopup] JACKPOT_END ignored — pick not finished');
            return;
        }
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
            const pickBtn = node.getComponent('CoinPickButton') as unknown as {
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
        this._stopHiddenCoinFloat(index, true);
        this._coinBasePos.delete(index);
        Tween.stopAllByTarget(node);
        node.setScale(1, 1, 1);
        this._setCoinInteractable(index, true);

        const back  = node.getChildByName('CoinBack');
        const front = node.getChildByName('CoinFront');
        if (back) {
            back.active = true;
            const spr = back.getComponent(Sprite);
            if (spr && this._frameIdle) spr.spriteFrame = this._frameIdle;
        }
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
            this._applySymbolToFront(front, sym, false);
        }
        this._setCoinInteractable(index, false);
        this._stopHiddenCoinFloat(index, true);
    }

    private _cacheCoinBasePos(index: number): Vec3 {
        const node = this.coinNodes[index];
        if (!node) return new Vec3();
        let base = this._coinBasePos.get(index);
        if (!base) {
            base = node.position.clone();
            this._coinBasePos.set(index, base);
        }
        return base.clone();
    }

    private _stopHiddenCoinFloat(index: number, restore: boolean): void {
        const node = this.coinNodes[index];
        if (!node?.isValid) return;
        Tween.stopAllByTarget(node);
        this._hiddenFloatPlaying.delete(index);
        if (restore) {
            const base = this._coinBasePos.get(index);
            if (base) node.setPosition(base);
        }
    }

    private _stopAllHiddenCoinFloats(restore: boolean): void {
        for (const idx of [...this._hiddenFloatPlaying]) {
            this._stopHiddenCoinFloat(idx, restore);
        }
    }

    /** Lưới 5×3 — ô kề nhau so le nửa chu kỳ (bàn cờ) + lệch nhẹ theo hàng. */
    private _hiddenCoinFloatPhase(index: number): number {
        const cols = 5;
        const i = Math.max(0, index);
        const row = Math.floor(i / cols);
        const col = i % cols;
        const half = Math.max(0.35, this.hiddenCoinFloatDuration * 0.5);
        const checker = ((row + col) & 1) === 1 ? half : 0;
        const rowWave = row * Math.max(0, this.hiddenCoinFloatStagger);
        return checker + rowWave;
    }

    /** Lơ lửng nhẹ loop — chỉ coin chưa lật, các ô so le nhau. */
    private _startHiddenCoinFloat(index: number): void {
        if (this._matched || this._inEntry) return;
        if (this._revealedSet.has(index)) return;
        const node = this.coinNodes[index];
        if (!node?.isValid) return;

        this._stopHiddenCoinFloat(index, true);
        const base = this._cacheCoinBasePos(index);
        node.setPosition(base);
        node.setScale(1, 1, 1);

        const h = Math.max(2, this.hiddenCoinFloatHeight);
        const half = Math.max(0.35, this.hiddenCoinFloatDuration * 0.5);
        const up = new Vec3(base.x, base.y + h, base.z);
        const phase = this._hiddenCoinFloatPhase(index);

        this._hiddenFloatPlaying.add(index);
        tween(node)
            .delay(phase)
            .repeatForever(
                tween(node)
                    .to(half, { position: up }, { easing: 'sineInOut' })
                    .to(half, { position: base.clone() }, { easing: 'sineInOut' }),
            )
            .start();
    }

    private _refreshHiddenCoinFloats(): void {
        if (this._matched || this._inEntry) return;
        for (let i = 0; i < this.coinNodes.length; i++) {
            if (this._revealedSet.has(i)) {
                this._stopHiddenCoinFloat(i, true);
            } else {
                this._startHiddenCoinFloat(i);
            }
        }
    }

    private _applySymbolToFront(front: Node, symbolId: number, withTransition: boolean): void {
        const frame = this._resolveSymbolFrame(symbolId);

        // Đã gán pickSymbolSpineData → luôn ưu tiên spine (bỏ qua preferSymbolSprites).
        if (this._hasPickSpine()) {
            this._applySpineToFront(front, symbolId, withTransition);
            return;
        }

        if (this.preferSymbolSprites && frame) {
            this._applySpriteToFront(front, frame);
            return;
        }

        if (frame) {
            this._applySpriteToFront(front, frame);
        }
    }

    private _playCoinIntroBounce(): void {
        const DURATION = 1;
        const PULSES = 2;
        const half = DURATION / (PULSES * 2);

        for (let i = 0; i < this.coinNodes.length; i++) {
            const node = this.coinNodes[i];
            if (!node || this._revealedSet.has(i)) continue;
            Tween.stopAllByTarget(node);
            const t = tween(node);
            for (let p = 0; p < PULSES; p++) {
                t.to(half, { scale: new Vec3(1.1, 1.1, 1) }, { easing: 'sineInOut' })
                 .to(half, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' });
            }
            t.start();
        }
        this.scheduleOnce(() => {
            this._inEntry = false;
            this._refreshHiddenCoinFloats();
        }, DURATION);
    }

    private _revealCoin(index: number, onDone?: () => void): void {
        if (!this._pickState) return;
        const node = this.coinNodes[index];
        if (!node) { onDone?.(); return; }

        const symbolId = this._pickState.grid[index];
        if (isPickUpgradeSymbol(symbolId)) {
            SoundManager.instance?.playBonusSelectUpgrade();
        } else {
            const jpType = clientSymToJackpotType(symbolId);
            if (jpType !== JackpotType.NONE) {
                SoundManager.instance?.playBonusSelect(jpType);
            }
        }
        this._revealedSet.add(index);
        this._lastRevealedIndex = index;
        this._setCoinInteractable(index, false);

        if (node.parent) {
            node.setSiblingIndex(node.parent.children.length - 1);
        }

        this._stopHiddenCoinFloat(index, true);

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
                    this._applySymbolToFront(front, symbolId, true);
                }
            })
            .to(half, { scale: new Vec3(1, 1, 1) })
            .call(() => { onDone?.(); })
            .start();
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

    private _hasPickSpine(): boolean {
        return !!this.pickSymbolSpineData;
    }

    private _applySpriteToFront(front: Node, frame: SpriteFrame): void {
        const sk = front.getComponent(sp.Skeleton);
        if (sk) {
            sk.clearTracks();
            sk.enabled = false;
        }
        this._setSymbolSpriteChild(front, frame);
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

    private _applySpineToFront(front: Node, symbolId: number, withTransition: boolean): void {
        this._setSymbolSpriteChild(front, null);

        const sk = front.getComponent(sp.Skeleton);
        if (!sk) {
            Log.d('[PickGamePopup] CoinFront thiếu sp.Skeleton.');
            return;
        }
        if (!this.pickSymbolSpineData) {
            Log.d('[PickGamePopup] Chưa gán pickSymbolSpineData trên PickGamePopup.');
            return;
        }

        const psId = clientSymToPickPsId(symbolId);
        sk.enabled = true;
        sk.color = isPickUpgradeSymbol(symbolId)
            ? new Color(255, 220, 80, 255)
            : Color.WHITE;
        sk.skeletonData = this.pickSymbolSpineData;
        sk.setToSetupPose();
        this._playPickPsSpine(sk, psId, withTransition);
        Log.d(`[PickGamePopup] spine psId=${psId} transition=${withTransition}`);
    }

    /** Play `{psId}_Transition` → `{psId}_Idle` trên spine chung. */
    private _playPickPsSpine(sk: sp.Skeleton, psId: number, withTransition: boolean): void {
        const idleAnim = pickPsIdleAnim(psId);
        const transitionAnim = pickPsTransitionAnim(psId);

        sk.setCompleteListener(null);

        if (withTransition && sk.findAnimation(transitionAnim)) {
            sk.setAnimation(0, transitionAnim, false);
            sk.setCompleteListener(() => {
                sk.setCompleteListener(null);
                if (sk.findAnimation(idleAnim)) {
                    sk.setAnimation(0, idleAnim, true);
                } else {
                    Log.w(`[PickGamePopup] Thiếu anim ${idleAnim}`);
                }
            });
            return;
        }

        if (sk.findAnimation(idleAnim)) {
            sk.setAnimation(0, idleAnim, true);
        } else {
            Log.w(`[PickGamePopup] Thiếu anim ${idleAnim} / ${transitionAnim} (psId=${psId})`);
        }
    }

    private _playUpgradeCelebrate(nextVals: number[], onDone: () => void): void {
        Log.d('[PickGamePopup] Upgrade ×3 complete — fly to JackpotDisplay');
        const upgradeIdx = this._collectUpgradeIndices();
        for (const idx of upgradeIdx) {
            const node = this.coinNodes[idx];
            if (!node) continue;
            this._stopHiddenCoinFloat(idx, true);
            Tween.stopAllByTarget(node);
            tween(node)
                .to(0.12, { scale: new Vec3(1.22, 1.22, 1) }, { easing: 'sineOut' })
                .to(0.12, { scale: new Vec3(1, 1, 1) }, { easing: 'sineIn' })
                .start();
        }

        const startFly = () => {
            this._flyUpgradeClones(upgradeIdx, nextVals, onDone);
        };
        this.scheduleOnce(startFly, 0.22);
    }

    private _collectUpgradeIndices(): number[] {
        if (!this._pickState) return [];
        const out: number[] = [];
        for (const idx of this._revealedSet) {
            if (isPickUpgradeSymbol(this._pickState.grid[idx] ?? -1)) out.push(idx);
        }
        out.sort((a, b) => a - b);
        return out.slice(0, 3);
    }

    private _extractJackpotAfter(resp: any): number[] | null {
        const raw = resp?.JackpotAfter ?? resp?.jackpotAfter;
        if (!Array.isArray(raw) || raw.length < 4) return null;
        const vals = raw.slice(0, 4).map((v: any) => Number(v) || 0);
        return vals.some((v: number) => v > 0) ? vals : null;
    }

    /**
     * 4 đợt Grand → Major → Minor → Mini — mỗi đợt 3 clone Upgrade,
     * lệch pha ngắn để bay chồng song song; FX + meter khi clone đầu tiên chạm đích.
     */
    private _flyUpgradeClones(upgradeIdx: number[], nextVals: number[], onDone: () => void): void {
        this._clearUpgradeFlyClones();
        const jp = JackpotDisplay.instance;
        const targets = jp?.getUpgradeTargetNodes() ?? [];
        if (!jp || targets.length < 4 || upgradeIdx.length < 3) {
            Log.w('[PickGamePopup] Upgrade fly skip — missing JackpotDisplay/targets, apply meters now');
            this._applyJackpotMeterValues(nextVals, true);
            this._playUpgradeJackpotHitFx(targets[0]);
            SoundManager.instance?.playUpgradeJackpotHit();
            jp?.playUpgradeSlotPulse(0);
            this.scheduleOnce(onDone, this.upgradeCelebrateDelay);
            return;
        }

        const baseVals = GameData.instance.jackpotValues?.slice?.(0, 4) ?? [0, 0, 0, 0];
        GameData.instance.holdJackpotValues = true;

        const stagger = Math.max(0, this.upgradeWaveStagger);
        let wavesDone = 0;
        let wavesStarted = 0;

        const onWaveFirstHit = (waveIndex: number): void => {
            const partial = this._upgradeValuesAfterWave(baseVals, nextVals, waveIndex);
            this._playUpgradeJackpotHitFx(targets[waveIndex]);
            JackpotDisplay.instance?.playUpgradeSlotPulse(waveIndex);
            this._applyJackpotMeterValues(partial, waveIndex >= 3);
        };

        const onWaveComplete = (_waveIndex: number): void => {
            wavesDone++;
            if (wavesDone >= wavesStarted) {
                this.scheduleOnce(onDone, this.upgradeCelebrateDelay);
            }
        };

        for (let wave = 0; wave < 4; wave++) {
            const dst = targets[wave];
            if (!dst?.isValid) continue;
            wavesStarted++;
            this.scheduleOnce(() => {
                this._flyOneUpgradeWave(
                    upgradeIdx,
                    dst,
                    wave,
                    () => onWaveFirstHit(wave),
                    () => onWaveComplete(wave),
                );
            }, wave * stagger);
        }

        if (wavesStarted === 0) {
            this._applyJackpotMeterValues(nextVals, true);
            this.scheduleOnce(onDone, this.upgradeCelebrateDelay);
        }
    }

    /** Meter sau từng đợt bay — cascade lần lượt theo tier. */
    private _upgradeValuesAfterWave(base: number[], final: number[], waveIndex: number): number[] {
        switch (waveIndex) {
            case 0: return [base[0], base[1], base[2], final[3]];
            case 1: return [base[0], base[1], final[2], final[3]];
            case 2: return [base[0], final[1], final[2], final[3]];
            default: return final.slice(0, 4);
        }
    }

    /** Clone chỉ hiển thị symbol Upgrade (86) — không copy state lật của coin gốc. */
    private _createUpgradeFlyClone(src: Node, waveIndex: number, srcIdx: number): Node | null {
        if (!src?.isValid) return null;

        const clone = instantiate(src);
        clone.name = `UpgradeFly_w${waveIndex}_${srcIdx}`;

        const btn = clone.getComponent(Button);
        if (btn) {
            btn.interactable = false;
            btn.enabled = false;
        }
        const pickBtn = clone.getComponent('CoinPickButton') as unknown as {
            enabled: boolean;
            pickGamePopup: unknown;
        } | null;
        if (pickBtn) {
            pickBtn.enabled = false;
            pickBtn.pickGamePopup = null;
        }

        const back = clone.getChildByName('CoinBack');
        if (back) back.active = false;
        const front = clone.getChildByName('CoinFront');
        if (front) {
            front.active = true;
            this._applyUpgradeFlyVisual(front);
        }

        return clone;
    }

    /** Fly clone luôn dùng hình PS 86 (SymbolPack) — không dùng spine copy từ coin gốc. */
    private _applyUpgradeFlyVisual(front: Node): void {
        const frame = this._resolvePs86Frame();
        const sk = front.getComponent(sp.Skeleton);
        if (sk) {
            sk.setCompleteListener(null);
            sk.clearTracks();
            sk.setToSetupPose();
            sk.enabled = false;
        }
        front.setScale(1, 1, 1);

        if (frame) {
            this._applySpriteToFront(front, frame);
            return;
        }

        Log.w('[PickGamePopup] Thiếu frame PS 86 — fallback spine 86_Idle');
        if (this._hasPickSpine()) {
            this._applySpineToFront(front, SymbolId.JP_UPGRADE, false);
        }
    }

    /** Sprite frame Pick Upgrade — PS ID 86 trong SymbolPack. */
    private _resolvePs86Frame(): SpriteFrame | null {
        if (this.frameJpUpgrade?.isValid) return this.frameJpUpgrade;

        const atlas = resolveSymbolPackAtlas(this.symbolAtlas);
        if (!atlas) return null;

        return getSymbolPackFrame(atlas, PS_PICK.UPGRADE)
            ?? atlas.getSpriteFrame('ps_86');
    }

    private _destroyUpgradeFlyClone(clone: Node): void {
        const idx = this._upgradeFlyClones.indexOf(clone);
        if (idx >= 0) this._upgradeFlyClones.splice(idx, 1);
        if (!isValid(clone)) return;
        Tween.stopAllByTarget(clone);
        clone.destroy();
    }

    /** Clone 3 symbol Upgrade — bay lên nhẹ rồi tới cùng 1 đích jackpot. */
    private _flyOneUpgradeWave(
        upgradeIdx: number[],
        dst: Node,
        waveIndex: number,
        onFirstHit: () => void,
        onComplete: () => void,
    ): void {
        const layer = this.node;
        const layerUt = layer.getComponent(UITransform) ?? layer.addComponent(UITransform);
        const flyDur = Math.max(0.2, this.upgradeFlyDuration);
        const endScaleMul = Math.max(0.08, this.upgradeFlyEndScale);
        const end = layerUt.convertToNodeSpaceAR(dst.getWorldPosition());
        const layerWs = layer.worldScale;
        let arrived = 0;
        let hitFxPlayed = false;
        const need = upgradeIdx.length;
        const cloneStagger = Math.max(0, this.upgradeCloneStagger);

        if (need === 0) {
            onComplete();
            return;
        }

        const markArrived = (): void => {
            arrived++;
            if (arrived >= need) onComplete();
        };

        const onCloneHit = (): void => {
            if (!hitFxPlayed) {
                hitFxPlayed = true;
                SoundManager.instance?.playUpgradeJackpotHit();
                onFirstHit();
            }
            markArrived();
        };

        for (let c = 0; c < need; c++) {
            const srcIdx = upgradeIdx[c];
            this.scheduleOnce(() => {
                const src = this.coinNodes[srcIdx];
                if (!src?.isValid) {
                    onCloneHit();
                    return;
                }
                const clone = this._createUpgradeFlyClone(src, waveIndex, srcIdx);
                if (!clone) {
                    onCloneHit();
                    return;
                }

                clone.setParent(layer);
                clone.setSiblingIndex(layer.children.length - 1);
                clone.active = true;

                const start = layerUt.convertToNodeSpaceAR(src.getWorldPosition());
                clone.setPosition(start.x, start.y, 0);
                const srcWs = src.worldScale;
                const startScale = new Vec3(
                    layerWs.x !== 0 ? srcWs.x / layerWs.x : srcWs.x,
                    layerWs.y !== 0 ? srcWs.y / layerWs.y : srcWs.y,
                    1,
                );
                clone.setScale(startScale);
                clone.setRotationFromEuler(0, 0, 0);

                let op = clone.getComponent(UIOpacity);
                if (!op) op = clone.addComponent(UIOpacity);
                op.opacity = 255;

                this._upgradeFlyClones.push(clone);
                SoundManager.instance?.playCoinFly();

                const endScale = new Vec3(startScale.x * endScaleMul, startScale.y * endScaleMul, 1);
                const liftRatio = Math.min(0.7, Math.max(0.15, this.upgradeFlyLiftRatio));
                const liftDur = flyDur * liftRatio;
                const travelDur = Math.max(0.08, flyDur - liftDur);
                const liftY = start.y + Math.max(0, this.upgradeFlyLiftOffset);
                const liftPos = new Vec3(start.x, liftY, 0);
                const endPos = new Vec3(end.x, end.y, 0);

                tween(clone)
                    .to(liftDur, { position: liftPos }, { easing: 'sineOut' })
                    .to(travelDur, { position: endPos, scale: endScale }, { easing: 'quadIn' })
                    .call(() => {
                        if (op && isValid(op)) op.opacity = 0;
                        this._destroyUpgradeFlyClone(clone);
                        onCloneHit();
                    })
                    .start();
            }, c * cloneStagger);
        }
    }

    private _applyJackpotMeterValues(vals: number[], finalizeHold: boolean): void {
        if (!vals || vals.length < 4) return;
        const data = GameData.instance;
        const prev = data.jackpotValues?.slice?.() ?? [];
        data.jackpotValues = vals.slice(0, 4);
        if (finalizeHold) data.holdJackpotValues = true;
        Log.d(
            `[PickGamePopup] upgrade meter [${prev.join(',')}] → [${data.jackpotValues.join(',')}]`,
        );
        EventBus.instance.emit(GameEvents.JACKPOT_VALUES_UPDATED, data.jackpotValues);
    }

    private _clearUpgradeFlyClones(): void {
        for (const clone of this._upgradeFlyClones) {
            if (!isValid(clone)) continue;
            Tween.stopAllByTarget(clone);
            clone.destroy();
        }
        this._upgradeFlyClones.length = 0;
    }

    // ─── Upgrade jackpot hit FX (template) ───────────────────────────────────

    private _initUpgradeJackpotHitFxPool(): void {
        const template = this.upgradeJackpotHitFxTemplate;
        if (!template?.isValid) {
            this._upgradeJackpotHitFxPool = null;
            return;
        }
        template.active = false;
        for (const ps of template.getComponentsInChildren(ParticleSystem)) {
            if ('playOnAwake' in ps) {
                (ps as unknown as { playOnAwake: boolean }).playOnAwake = false;
            }
        }
        const pool = new NodePool();
        const seed = instantiate(template);
        seed.active = false;
        pool.put(seed);
        this._upgradeJackpotHitFxPool = pool;
    }

    /** Spawn template FX tại slot jackpot khi 1 đợt 3 clone chạm đích. */
    private _playUpgradeJackpotHitFx(target: Node | null | undefined): void {
        const template = this.upgradeJackpotHitFxTemplate;
        const pool = this._upgradeJackpotHitFxPool;
        if (!target?.isValid || !template?.isValid || !pool) {
            if (target?.isValid && !template?.isValid) {
                Log.w('[PickGamePopup] upgradeJackpotHitFxTemplate chưa gán — bỏ qua hit FX');
            }
            return;
        }

        const fx = pool.size() > 0 ? pool.get()! : instantiate(template);
        this._placeUpgradeJackpotHitFx(fx, target);
        fx.active = true;
        this._playUpgradeJackpotHitFxTree(fx);

        const delay = Math.max(0.5, this.upgradeJackpotHitFxRecycleDelay);
        const recycleCb = () => {
            this._upgradeJackpotHitFxRecycleCbs.delete(fx);
            this._recycleUpgradeJackpotHitFx(fx);
        };
        this._upgradeJackpotHitFxRecycleCbs.set(fx, recycleCb);
        this.scheduleOnce(recycleCb, delay);
    }

    private _placeUpgradeJackpotHitFx(fx: Node, target: Node): void {
        target.updateWorldTransform();
        const layer = this.upgradeJackpotHitFxLayer ?? this.node;
        layer.updateWorldTransform();
        const layerUt = layer.getComponent(UITransform);
        const localPos = layerUt
            ? layerUt.convertToNodeSpaceAR(target.getWorldPosition())
            : target.worldPosition.clone();
        fx.setParent(layer, false);
        fx.setPosition(localPos.x, localPos.y, 0);
        fx.setRotationFromEuler(0, 0, 0);
        fx.setScale(1, 1, 1);
        this._resetUpgradeJackpotFxEmitterPositions(fx);
    }

    /** Prefab FX thường bake offset — đưa emitter ParticleSystem về gốc local. */
    private _resetUpgradeJackpotFxEmitterPositions(fxRoot: Node): void {
        const walk = (node: Node) => {
            if (node !== fxRoot && node.getComponent(ParticleSystem)) {
                node.setPosition(0, 0, 0);
            }
            for (const child of node.children) walk(child);
        };
        walk(fxRoot);
    }

    private _playUpgradeJackpotHitFxTree(root: Node): void {
        const walk = (node: Node) => {
            const systems = node.getComponents(ParticleSystem);
            if (systems.length > 0) node.active = true;
            for (const ps of systems) {
                ps.stop();
                ps.clear();
                ps.play();
            }
            for (const sk of node.getComponents(sp.Skeleton)) {
                node.active = true;
                sk.setCompleteListener(null);
                sk.clearTracks();
                sk.setToSetupPose();
                const runtime = sk.skeletonData?.getRuntimeData();
                const anim = runtime?.animations?.[0]?.name ?? 'animation';
                if (sk.findAnimation(anim)) {
                    sk.setAnimation(0, anim, false);
                }
            }
            for (const child of node.children) walk(child);
        };
        walk(root);
    }

    private _recycleUpgradeJackpotHitFx(fx: Node): void {
        if (!fx?.isValid) return;
        const walk = (node: Node) => {
            for (const ps of node.getComponents(ParticleSystem)) {
                ps.stop();
                ps.clear();
            }
            for (const child of node.children) walk(child);
        };
        walk(fx);
        fx.active = false;
        fx.removeFromParent();
        const pool = this._upgradeJackpotHitFxPool;
        if (!pool || pool.size() >= this._maxUpgradeJackpotHitFxPool) {
            fx.destroy();
            return;
        }
        pool.put(fx);
    }

    private _clearUpgradeJackpotHitFx(): void {
        for (const cb of this._upgradeJackpotHitFxRecycleCbs.values()) {
            this.unschedule(cb);
        }
        this._upgradeJackpotHitFxRecycleCbs.clear();
        const pool = this._upgradeJackpotHitFxPool;
        if (!pool) return;
        while (pool.size() > 0) {
            const n = pool.get();
            if (n?.isValid) n.destroy();
        }
        pool.clear();
        this._upgradeJackpotHitFxPool = null;
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
        const animName = current?.animation?.name;
        if (sk && isPickPsTransitionAnim(animName)) {
            sk.setCompleteListener(() => {
                sk.setCompleteListener(null);
                const psId = this._pickState
                    ? clientSymToPickPsId(this._pickState.grid[lastIdx])
                    : 0;
                const idleAnim = pickPsIdleAnim(psId);
                if (sk.findAnimation(idleAnim)) {
                    sk.setAnimation(0, idleAnim, true);
                }
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
        this._stopAllHiddenCoinFloats(true);

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

    /** CN V1.0.2: JackpotName là tier trả thưởng. Không dùng JackpotIndex (luôn −1). */
    private _resolveWonTier(resp: any): JackpotType {
        const fromName = parseCnJackpotName(resp?.JackpotName ?? resp?.jackpotName);
        if (fromName !== JackpotType.NONE) return fromName;

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
            return { amount: meter, source: 'JackpotValues' };
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
        return { amount, source: 'BetMultiplier' };
    }

    private _emitJackpot = (): void => {
        const { amount, source } = this._resolveJackpotAmount();
        Log.d(`[Jackpot] TRIGGER tier=${JackpotType[this._wonTier]} amount=${amount} src=${source}`);
        GameData.instance.pickGameWinAmount = amount;
        EventBus.instance.emit(GameEvents.JACKPOT_TRIGGER, this._wonTier, amount);
    };

    private _setButtonsInteractable(enabled: boolean): void {
        this._pickBlocked = !enabled;
    }

    private _closePopup(skipEmitClose: boolean = false): void {
        this.unscheduleAllCallbacks();
        this._clearUpgradeFlyClones();
        GameData.instance.holdJackpotValues = false;

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
