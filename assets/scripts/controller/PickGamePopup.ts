/**
 * PickGamePopup — Popup Pick Game (Gold of Fortune / Shangri-La of Fortune).
 *
 * ★ DOCUMENT REQUIREMENTS:
 *   1. Entry animation → Pick Game screen hiện ra → ẩn bottom UI.
 *   2. 3×4 grid = 12 coin nodes, player tap để lật mở từng đồng xu.
 *   3. Khi lật: ô hiện ra Jackpot Symbol (GRAND/MAJOR/MINOR/MINI).
 *   4. Khi 3 symbol giống nhau → hiện Jackpot Popup.
 *   5. Sau Jackpot Popup đóng → trở về Normal Reels → hiện lại bottom UI.
 *
 * ★ JACKPOT SYMBOL TYPES:
 *   Idle   = trạng thái đồng xu chưa lật (CoinBack node)
 *   Grand  → sprGrand trong CoinFront
 *   Major  → sprMajor trong CoinFront
 *   Minor  → sprMinor trong CoinFront
 *   Mini   → sprMini  trong CoinFront
 *
 * ★ INSTRUCTION TEXT (hiển thị trong popup):
 *   - "PRESS COIN TO REVEAL LUCKY SYMBOL."
 *   - "MATCH 3 LUCKY SYMBOLS TO AWARD JACKPOT / BONUS."
 *   - "福壽雙全" / "好运连连"
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "PickGamePopup" (bắt đầu inactive, top layer).
 *   2. Gắn component PickGamePopup vào node đó.
 *   3. Trong node, tạo cấu trúc con:
 *
 *        PickGamePopup
 *          ├── EntryAnimNode   ← Spine/tween entry animation (optional)
 *          │                     active trong lúc play entry, rồi deactivate
 *          ├── GameContent     ← Toàn bộ nội dung pick game (inactive lúc entry)
 *          │     ├── BgOverlay         ← background mờ
 *          │     ├── Instruction1Label ← "PRESS COIN TO REVEAL LUCKY SYMBOL."
 *          │     ├── Instruction2Label ← "MATCH 3 LUCKY SYMBOLS TO AWARD JACKPOT / BONUS."
 *          │     ├── ThemeTextLabel    ← "福壽雙全" / "好运连连"
 *          │     └── CoinGrid         ← 12 coin node con
 *          │           ├── Coin0 .. Coin11
 *          │           │     ├── CoinBack   ← mặt sau (active lúc đầu)
 *          │           │     └── CoinFront  ← mặt trước (inactive lúc đầu)
 *          │           │           └── [Sprite component] ← frame set từ data, KHÔNG cần child nodes
 *
 *   4. Kéo 12 Coin node vào mảng `coinNodes` (thứ tự 0..11).
 *      Mỗi CoinFront cần có 1 Sprite component (add trong Editor, không cần child sprite nodes).
 *   4b. Kéo SpriteFrame ảnh của từng tier vào:
 *       `frameJpMini`, `frameJpMinor`, `frameJpMajor`, `frameJpGrand`.
 *       → MockDataProvider sinh grid[i] = SymbolId.JP_MINI/MINOR/MAJOR/GRAND;
 *         PickGamePopup dùng frame tương ứng để set lên Sprite.spriteFrame.
 *         Sau này thay MockDataProvider bằng real API → không cần đổi gì ở đây.
 *   5. Kéo EntryAnimNode → `entryAnimNode`.
 *   6. Kéo GameContent  → `gameContentNode`.
 *   7. Kéo các Label → `instruction1Label`, `instruction2Label`, `themeTextLabel`.
 *   8. Kéo Bottom UI node (chứa spin/bet buttons) → `bottomUINode`.
 *   9. Nếu EntryAnimNode có sp.Skeleton:
 *      - Kéo vào `entrySpine` và điền `entryAnimName` (animation tên "in" hoặc "entry").
 *      - Sau khi animation "in" xong → event PICK_GAME_ENTRY_DONE tự fire.
 *      - Nếu KHÔNG có Spine: set `entryDuration = 0` để skip và vào game ngay.
 *  10. Mỗi coin node gắn thêm CoinPickButton.ts và điền index vào inspector.
 *
 * ── FLOW ──
 *   PICK_GAME_OPEN → _onPickGameOpen():
 *     node.active = true, entryAnimNode bật.
 *     Nếu có Spine → play "in", khi xong → _onEntryDone().
 *     Nếu không → scheduleOnce(entryDuration) → _onEntryDone().
 *   _onEntryDone():
 *     entryAnimNode deactive, gameContentNode active.
 *     Emit HIDE_BOTTOM_UI (ẩn spin/bet controls).
 *     Emit PICK_GAME_ENTRY_DONE (UIController/khác biết pick game bắt đầu).
 *   Player tap Coin[i] → pickCoin(i):
 *     Flip animation → hiện symbol.
 *     Nếu 3 cùng tier → _onMatchFound() → auto-reveal → JACKPOT_TRIGGER.
 *   JACKPOT_END → _onJackpotEnd():
 *     node.active = false.
 *     Emit PICK_GAME_CLOSE → GameManager reset pot + IDLE.
 *     Emit SHOW_BOTTOM_UI (hiện lại spin/bet controls).
 */

import {
    _decorator, Component, Node, Label, tween, Vec3, Tween,
    Sprite, SpriteFrame, sp, Layout, Button,
} from 'cc';
import { EventBus }      from '../core/EventBus';
import { GameEvents }    from '../core/GameEvents';
import { PickGameState, JackpotType, SymbolId } from '../data/SlotTypes';
import { GameData }      from '../data/GameData';
import { NetworkManager } from '../manager/NetworkManager';
import { SoundManager }  from '../manager/SoundManager';
import { USE_REAL_API }  from '../data/ServerConfig';
import { Log }           from '../core/Logger';
import { TransitionMode } from './TopUpTransitionPopup';

const { ccclass, property } = _decorator;

/** SymbolId JP → JackpotType */
const SYM_TO_JP: Record<number, JackpotType> = {
    [SymbolId.JP_MINI]:  JackpotType.MINI,
    [SymbolId.JP_MINOR]: JackpotType.MINOR,
    [SymbolId.JP_MAJOR]: JackpotType.MAJOR,
    [SymbolId.JP_GRAND]: JackpotType.GRAND,
};



@ccclass('PickGamePopup')
export class PickGamePopup extends Component {

    // ── INSPECTOR — NODES ────────────────────────────────────────────────────

    @property({
        type: [Node],
        tooltip: '12 coin nodes theo thứ tự 0..11.\n'
               + 'Mỗi node cần:\n'
               + '  CoinBack  (active lúc đầu — mặt idle chưa lật)\n'
               + '  CoinFront (inactive lúc đầu) có 1 Sprite component — frame set từ data.',
    })
    coinNodes: Node[] = [];

    // ── INSPECTOR — JACKPOT SPRITE FRAMES (data-driven) ──────────────────────
    // Kéo SpriteFrame tương ứng từ Assets vào đây.
    // MockDataProvider (và sau này real API) sẽ quyết định tier nào hiện;
    // PickGamePopup chỉ dùng frame này để set lên Sprite component của CoinFront.

    @property({ type: sp.SkeletonData, tooltip: 'SpineData cho Jackpot MINI.' })
    spineJpMini: sp.SkeletonData | null = null;

    @property({ type: sp.SkeletonData, tooltip: 'SpineData cho Jackpot MINOR.' })
    spineJpMinor: sp.SkeletonData | null = null;

    @property({ type: sp.SkeletonData, tooltip: 'SpineData cho Jackpot MAJOR.' })
    spineJpMajor: sp.SkeletonData | null = null;

    @property({ type: sp.SkeletonData, tooltip: 'SpineData cho Jackpot GRAND.' })
    spineJpGrand: sp.SkeletonData | null = null;

    /** Nếu false → skip transition, vào game ngay (không cần gán node). */
    @property({ tooltip: 'false → bỏ qua TopUpTransitionPopup, vào Pick Game ngay.' })
    useTopUpTransition: boolean = true;

    @property({
        type: Node,
        tooltip: 'Node chứa toàn bộ nội dung pick game (coin grid, labels).\n'
               + 'Inactive lúc entry animation, active sau khi entry xong.',
    })
    gameContentNode: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Bottom UI node chứa spin button, bet controls.\n'
               + 'Sẽ bị ẩn khi pick game bắt đầu, hiện lại khi kết thúc.\n'
               + 'Để null → dùng event HIDE_BOTTOM_UI / SHOW_BOTTOM_UI thay.',
    })
    bottomUINode: Node | null = null;

    // ── INSPECTOR — LABELS ───────────────────────────────────────────────────

    @property({
        type: Label,
        tooltip: 'Label dòng 1: "PRESS COIN TO REVEAL LUCKY SYMBOL."',
    })
    instruction1Label: Label | null = null;

    @property({
        type: Label,
        tooltip: 'Label dòng 2: "MATCH 3 LUCKY SYMBOLS TO AWARD JACKPOT / BONUS."',
    })
    instruction2Label: Label | null = null;

    @property({
        type: Label,
        tooltip: 'Label chủ đề văn hóa: "福壽雙全" hoặc "好运连连".',
    })
    themeTextLabel: Label | null = null;

    @property({ tooltip: 'Nội dung themeTextLabel (có thể đổi theo locale).' })
    themeText: string = '福壽雙全';

    // ── INSPECTOR — TIMING ───────────────────────────────────────────────────

    @property({ tooltip: 'Thời gian scale-in gameContentNode khi popup mở (giây).' })
    showDuration: number = 0.35;

    @property({ tooltip: 'Thời gian scale-out gameContentNode khi popup đóng (giây).' })
    hideDuration: number = 0.25;

    @property({ tooltip: 'Thời gian flip animation mỗi coin (giây).' })
    flipDuration: number = 0.3;

    @property({ tooltip: 'Delay giữa mỗi coin auto-reveal sau khi match (giây).' })
    autoRevealDelay: number = 0.18;

    @property({ tooltip: 'Delay sau auto-reveal trước khi emit JACKPOT_TRIGGER (giây).' })
    jackpotTriggerDelay: number = 0.5;

    // ── STATE ────────────────────────────────────────────────────────────────

    private _pickState: PickGameState | null = null;
    private _revealedSet: Set<number> = new Set();
    private _matched: boolean = false;
    private _wonTier: JackpotType = JackpotType.NONE;
    /** Flag: đang trong entry animation — chặn tap coin */
    private _inEntry: boolean = false;
    /** Flag: đang chờ kết quả API pick — chặn tap coin tiếp theo */
    private _pickBlocked: boolean = false;
    private _serverPickWinAmount: number = 0;

    /** Index coin vừa được reveal gần nhất — dùng để delay win animation */
    private _lastRevealedIndex: number = -1;

    /** Counter số lượng coin đã reveal theo tier — dùng để check khi nào đạt 3 */
    private _tierCounts: Record<JackpotType, number> = {
        [JackpotType.MINI]: 0,
        [JackpotType.MINOR]: 0,
        [JackpotType.MAJOR]: 0,
        [JackpotType.GRAND]: 0,
        [JackpotType.NONE]: 0,
    };

    // ── LIFECYCLE ────────────────────────────────────────────────────────────

    onLoad(): void {
        this.node.active = false;
        const bus = EventBus.instance;
        bus.on(GameEvents.PICK_GAME_OPEN,          this.openPickGame,     this);
        bus.on(GameEvents.JACKPOT_END,             this._onJackpotEnd,       this);
        bus.on(GameEvents.TOPUP_TRANSITION_DONE,   this._onTransitionDone,   this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ── PUBLIC API ───────────────────────────────────────────────────────────

    /** Index trong `coinNodes` của node được tap — nguồn sự thật duy nhất cho click→flip. */
    public resolveCoinIndex(node: Node): number {
        return this.coinNodes.indexOf(node);
    }

    /**
     * Gọi từ CoinPickButton.ts (gắn trên mỗi coin) hoặc Button onClick.
     * Real API: gọi /Pick trước, dùng kết quả server để lật và kiểm tra match.
     * Mock: xử lý local (giữ nguyên logic cũ).
     */
    public pickCoin(index: number): void {
        if (this._inEntry)     return;
        if (this._pickBlocked) return;
        if (this._matched)     return;
        if (!this._pickState) return;
        if (!this._pickState.grid) return;
        if (this._revealedSet.has(index)) return;
        if (index < 0 || index >= this._pickState.grid.length) return;
        if (index >= this.coinNodes.length || !this.coinNodes[index]) return;

        if (USE_REAL_API) {
            this._setButtonsInteractable(false);
            this._pickCoinReal(index);
        } else {
            this._revealCoin(index, () => { this._onCoinRevealed(index); });
        }
    }

    private async _pickCoinReal(index: number): Promise<void> {
        try {
            const resp = await NetworkManager.instance.sendPickRequest(index);

            // ★ DEBUG: Log full server response
            Log.d(`[PickGamePopup][DEBUG] === PICK #${index} ===`);
            Log.d(`[PickGamePopup][DEBUG] Server resp.IsJackpot=${resp.IsJackpot}`);
            Log.d(`[PickGamePopup][DEBUG] Server resp.JackpotIndex=${resp.JackpotIndex}`);
            Log.d(`[PickGamePopup][DEBUG] Server resp.NextStage=${resp.NextStage}`);
            Log.d(`[PickGamePopup][DEBUG] Server resp.PickWin=${resp.PickWin ?? 0}`);
            Log.d(`[PickGamePopup][DEBUG] Server resp.PickGame length=${resp.PickGame?.length ?? 'undefined'}`);
            Log.d(`[PickGamePopup][DEBUG] Server resp.PickGame=[${resp.PickGame?.join(', ')}]`);

            // Map server SymbolId (82–85) → client SymbolId
            const serverToClient: Record<number, number> = {
                82: SymbolId.JP_GRAND, 83: SymbolId.JP_MAJOR,
                84: SymbolId.JP_MINOR, 85: SymbolId.JP_MINI,
            };
            const clientToName: Record<number, string> = {
                [SymbolId.JP_GRAND]: 'GRAND', [SymbolId.JP_MAJOR]: 'MAJOR',
                [SymbolId.JP_MINOR]: 'MINOR', [SymbolId.JP_MINI]: 'MINI',
            };

            // Update entire grid from server response
            // Skip -1 (unselected) — giữ nguyên giá trị cũ cho ô chưa pick
            if (this._pickState && resp.PickGame) {
                for (let i = 0; i < resp.PickGame.length; i++) {
                    const serverSym = resp.PickGame[i];
                    if (serverSym === -1) continue; // Unselected — skip
                    const clientSym = serverToClient[serverSym] ?? SymbolId.JP_MINI;
                    const oldSym = this._pickState.grid[i];
                    this._pickState.grid[i] = clientSym;
                    Log.d(`[PickGamePopup][DEBUG] Grid[${i}]: server=${serverSym} → client=${clientSym}(${clientToName[clientSym]}) (old=${oldSym})`);
                }
            }

            // Get symbol for the picked coin to reveal
            const serverSym = resp.PickGame?.[index] ?? 85;
            const clientSym = serverToClient[serverSym] ?? SymbolId.JP_MINI;
            Log.d(`[PickGamePopup][DEBUG] Reveal coin[${index}]: server=${serverSym} → client=${clientSym}(${clientToName[clientSym]})`);
            Log.d(`[PickGamePopup][DEBUG] Before reveal: _matched=${this._matched} tierCounts=${JSON.stringify(this._tierCounts)}`);

            this._revealCoin(index, () => {
                Log.d(`[PickGamePopup][DEBUG] After reveal: _matched=${this._matched} tierCounts=${JSON.stringify(this._tierCounts)}`);
                if (resp.IsJackpot) {
                    // Server xác nhận match 3 — JackpotIndex: 0=Mini,1=Minor,2=Major,3=Grand
                    const tierMap: Record<number, JackpotType> = {
                        0: JackpotType.MINI, 1: JackpotType.MINOR,
                        2: JackpotType.MAJOR, 3: JackpotType.GRAND,
                    };
                    this._matched = true;
                    this._wonTier = tierMap[resp.JackpotIndex] ?? JackpotType.MINI;
                    this._serverPickWinAmount = this._extractPickWin(resp);
                    if (this._serverPickWinAmount > 0) {
                        GameData.instance.pickGameWinAmount = this._serverPickWinAmount;
                    }
                    Log.d(`[PickGamePopup] Server confirmed IsJackpot=true → tier=${JackpotType[this._wonTier]} skip remaining reveal`);
                    this._playWinAnimation(this._wonTier);
                    // Emit ngay để effect kịp active trước khi popup hiện
                    const matchEvent = GameEvents.PICK_GAME_MATCH_FOUND ?? 'pickgame:match:found';
                    Log.d(`[JackpotDisplay] PickGamePopup emit matchEvent=${matchEvent} tier=${this._wonTier} (server IsJackpot)`);
                    EventBus.instance.emit(matchEvent, this._wonTier);
                    this._setButtonsInteractable(false);
                    this.scheduleOnce(this._emitJackpot, this.jackpotTriggerDelay);
                } else {
                    // Server chưa xác nhận jackpot → dùng client logic track streak
                    this._onCoinRevealed(index);
                    if (!this._matched) this._setButtonsInteractable(true);
                }
                // Emit để GameManager gọi /Claim sau khi JACKPOT_END nếu NextStage=PICK_END
                if (resp.NextStage === 102 /* PICK_END */ || resp.NextStage >= 100 /* NEED_CLAIM */) {
                    EventBus.instance.emit(GameEvents.PICK_GAME_NEED_CLAIM);
                }
            });
        } catch (err) {
            Log.e('[PickGamePopup] sendPickRequest failed:', err);
            this._setButtonsInteractable(true);
        }
    }

    // ── EVENT HANDLERS ───────────────────────────────────────────────────────

    public openPickGame(state: PickGameState): void {
        // ★ CRITICAL: Clear mọi timer cũ từ lần chơi trước (node chưa bị destroy)
        this.unscheduleAllCallbacks();
        // Reset win amount cũ để tránh ProgressiveWin hiện với giá trị lần trước
        GameData.instance.pickGameWinAmount = 0;

        // Normalize server data (server có thể dùng PascalCase: Grid, Revealed, WonTier)
        const raw = state as any;
        if (!state.grid && raw.Grid)     state = { ...state, grid: raw.Grid };
        if (!state.revealed && raw.Revealed) state = { ...state, revealed: raw.Revealed };
        if (!state.grid) {
            Log.e('[PickGamePopup] _onPickGameOpen: state.grid is missing — abort open');
            return;
        }

        this._pickState      = state;
        this._revealedSet    = new Set();
        this._matched        = false;
        this._wonTier        = JackpotType.NONE;
        this._inEntry        = true;
        this._pickBlocked       = false;
        this._serverPickWinAmount = 0;
        this._lastRevealedIndex  = -1;
        this._tierCounts         = {
            [JackpotType.MINI]: 0,
            [JackpotType.MINOR]: 0,
            [JackpotType.MAJOR]: 0,
            [JackpotType.GRAND]: 0,
            [JackpotType.NONE]: 0,
        };

        // Layout GRID trên CoinGrid sẽ reflow khi setSiblingIndex → lệch click/index.
        // Tắt Layout sau khi vị trí đã ổn định; wire lại coinIndex theo coinNodes[].
        this._freezeCoinGridLayout();
        this._wireCoinButtons();

        // Reset coins
        for (let i = 0; i < this.coinNodes.length; i++) {
            this._resetCoin(i);
        }

        // Set instruction texts
        if (this.instruction1Label) {
            this.instruction1Label.string = 'PRESS COIN TO REVEAL LUCKY SYMBOL.';
        }
        if (this.instruction2Label) {
            this.instruction2Label.string = 'MATCH 3 LUCKY SYMBOLS TO AWARD JACKPOT / BONUS.';
        }
        if (this.themeTextLabel) {
            this.themeTextLabel.string = this.themeText;
        }

        this.node.active = true;

        // Entry: gameContentNode hidden cho đến khi nhận TOPUP_TRANSITION_DONE
        if (this.gameContentNode) this.gameContentNode.active = false;

        Log.d(`[PickGamePopup] Opening — grid: ${JSON.stringify(state.grid)}`);

        // Phát transition popup trước; _onTransitionDone() sẽ gọi _onEntryDone()
        if (this.useTopUpTransition) {
            EventBus.instance.emit(GameEvents.TOPUP_TRANSITION_SHOW, TransitionMode.PickGame);
            // Fallback: nếu không có TopUpTransitionPopup nào trong scene, tự vào game sau 3s
            this.scheduleOnce(this._onEntryDone, 3.0);
        } else {
            // Skip transition → vào game ngay
            this._onEntryDone();
        }
    }

    private _onJackpotEnd(): void {
        if (!this.node.active) return;
        this._closePopup(true);
    }

    // ── PRIVATE: ENTRY ───────────────────────────────────────────────────────

    /** Nhận TOPUP_TRANSITION_DONE → chỉ xử lý khi popup đang chờ entry. */
    private _onTransitionDone(): void {
        if (this._inEntry) {
            this.unschedule(this._onEntryDone); // clear fallback timer
            this._onEntryDone();
        }
    }

    private _onEntryDone = (): void => {
        Log.d('[PickGamePopup] Entry done — showing coin grid');
        // _inEntry vẫn true — chờ intro bounce coin xong mới mở khóa click

        const onContentShown = (): void => {
            this._playCoinIntroBounce();
        };

        if (this.gameContentNode) {
            this.gameContentNode.active = true;
            this.gameContentNode.setScale(0.1, 0.1, 1);
            tween(this.gameContentNode)
                .to(this.showDuration, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .call(onContentShown)
                .start();
        } else {
            onContentShown();
        }

        // Ẩn bottom UI (spin/bet controls)
        if (this.bottomUINode) this.bottomUINode.active = false;
        EventBus.instance.emit(GameEvents.HIDE_BOTTOM_UI);
        EventBus.instance.emit(GameEvents.PICK_GAME_ENTRY_DONE);
    };

    // ── PRIVATE: COINS ───────────────────────────────────────────────────────

    /**
     * CoinGrid có cc.Layout (GRID). Nếu để Layout bật, mọi setSiblingIndex
     * (đưa coin lên trên khi flip) sẽ xếp lại vị trí → tap coin A lật coin B.
     */
    private _freezeCoinGridLayout(): void {
        const grid = this.coinNodes[0]?.parent;
        if (!grid?.isValid) return;
        const layout = grid.getComponent(Layout);
        if (layout) {
            layout.enabled = false;
            Log.d('[PickGamePopup] CoinGrid Layout disabled — keep fixed positions');
        }
    }

    /** Đồng bộ CoinPickButton.coinIndex / pickGamePopup theo mảng coinNodes. */
    private _wireCoinButtons(): void {
        for (let i = 0; i < this.coinNodes.length; i++) {
            const node = this.coinNodes[i];
            if (!node?.isValid) continue;
            // getComponent by name — tránh circular import với CoinPickButton.ts
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
        if (back)  back.active  = true;
        if (front) {
            front.active = false;
            const sk = front.getComponent(sp.Skeleton);
            if (sk) {
                sk.setToSetupPose();
                sk.clearTracks();
            }
        }
    }

    /**
     * Intro bounce — tất cả coin nhún zoom lên xuống trong 1 giây trước khi cho chơi.
     */
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

        // Mở khóa click sau khi bounce xong
        this.scheduleOnce(() => { this._inEntry = false; }, DURATION);
    }

    /**
     * Flip coin: scale.x 1→0 (đổi mặt) → 0→1.
     * Khi scale.x = 0: CoinBack off, CoinFront on với đúng sprite.
     */
    private _revealCoin(index: number, onDone?: () => void): void {
        if (!this._pickState) return;
        const node     = this.coinNodes[index];
        if (!node) { onDone?.(); return; }

        const symbolId = this._pickState.grid[index];
        const jpType   = SYM_TO_JP[symbolId] ?? JackpotType.NONE;
        if (jpType !== JackpotType.NONE) {
            SoundManager.instance?.playBonusSelect(jpType);
        }
        this._revealedSet.add(index);
        this._lastRevealedIndex = index;
        this._setCoinInteractable(index, false);

        // Đưa node lên trên cùng để flip không bị che.
        // An toàn vì Layout trên CoinGrid đã bị tắt trong openPickGame.
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
                if (back)  back.active  = false;
                if (front) {
                    front.active = true;
                    this._applySpineToFront(front, jpType);
                }
            })
            .to(half, { scale: new Vec3(1, 1, 1) })
            .call(() => { onDone?.(); })
            .start();
    }

    /**
     * Set SpineData và play animation 'in' → 'loop' trên sp.Skeleton của CoinFront.
     */
    private _applySpineToFront(front: Node, jpType: JackpotType): void {
        const dataMap: Partial<Record<JackpotType, sp.SkeletonData | null>> = {
            [JackpotType.MINI]:  this.spineJpMini,
            [JackpotType.MINOR]: this.spineJpMinor,
            [JackpotType.MAJOR]: this.spineJpMajor,
            [JackpotType.GRAND]: this.spineJpGrand,
        };
        const data = dataMap[jpType];
        const sk = front.getComponent(sp.Skeleton);
        if (sk && data) {
            sk.skeletonData = data;
            sk.setAnimation(0, 'In', false);
            sk.setCompleteListener(() => {
                sk.setAnimation(0, 'Loop', true);
            });
        } else if (!sk) {
            Log.d(`[PickGamePopup] CoinFront thiếu sp.Skeleton component — thêm vào Editor.`);
        } else if (!data) {
            Log.d(`[PickGamePopup] Chưa gán sp.SkeletonData cho tier=${JackpotType[jpType]} trong Inspector.`);
        }
    }

    /**
     * Gọi sau khi flip coin xong.
     * Logic mới: chỉ cần 3 ô giống nhau bất kỳ (không cần liên tiếp).
     * Đếm tổng số coin đã reveal theo tier, khi đạt 3 → WIN.
     */
    private _onCoinRevealed(index: number): void {
        if (!this._pickState) return;
        const symbolId = this._pickState.grid[index];
        const tier = SYM_TO_JP[symbolId] ?? JackpotType.NONE;
        Log.d(`[JackpotDisplay] _onCoinRevealed index=${index} symbolId=${symbolId} tier=${tier} _tierCounts=${JSON.stringify(this._tierCounts)}`);

        // Tăng counter cho tier này
        if (tier !== JackpotType.NONE) {
            this._tierCounts[tier]++;
            Log.d(`[PickGamePopup] Tier count: ${JackpotType[tier]} = ${this._tierCounts[tier]}`);
        }

        // ── Kiểm tra WIN ──────────────────────────────────────────────────
        Log.d(`[JackpotDisplay] Check match: tier=${tier} count=${this._tierCounts[tier]}`);
        if (this._tierCounts[tier] >= 3) {
            this._matched = true;
            this._wonTier = tier;
            Log.d(`[PickGamePopup] MATCH! tier=${JackpotType[this._wonTier]} count=${this._tierCounts[tier]}`);
            this._playWinAnimation(tier);
            // Emit ngay để các effect kịp active trước khi popup hiện
            const matchEvent = GameEvents.PICK_GAME_MATCH_FOUND ?? 'pickgame:match:found';
            Log.d(`[JackpotDisplay] PickGamePopup emit matchEvent=${matchEvent} tier=${this._wonTier}`);
            EventBus.instance.emit(matchEvent, this._wonTier);
            this.scheduleOnce(this._emitJackpot, this.jackpotTriggerDelay);
            return;
        }

        // ── Hết coin mà không win → đóng popup ───────────────────────────
        if (this._pickState && this._revealedSet.size >= this._pickState.grid.length) {
            Log.d('[PickGamePopup] All coins revealed, no match → close popup');
            this.scheduleOnce(() => { this._closePopup(); }, this.jackpotTriggerDelay);
        }
    }

    /**
     * Kiểm tra nếu coin cuối cùng vừa reveal vẫn đang chạy 'In', chờ xong rồi mới highlight 3 ô.
     */
    private _playWinAnimation(wonTier: JackpotType): void {
        const lastNode = this.coinNodes[this._lastRevealedIndex];
        if (lastNode) {
            const front = lastNode.getChildByName('CoinFront');
            const sk = front?.getComponent(sp.Skeleton);
            if (sk) {
                const current = sk.getCurrent(0);
                if (current?.animation?.name === 'In') {
                    Log.d(`[PickGamePopup] Last revealed coin still playing 'In' — delaying win animation`);
                    sk.setCompleteListener(() => {
                        this._doPlayWinAnimation(wonTier);
                    });
                    return;
                }
            }
        }
        this._doPlayWinAnimation(wonTier);
    }

    /**
     * Phát animation 'win' trên 3 coin đã match.
     */
    private _doPlayWinAnimation(wonTier: JackpotType): void {
        if (!this._pickState) return;
        const matched: number[] = [];
        for (const idx of this._revealedSet) {
            if (matched.length >= 3) break;
            const sym = this._pickState.grid[idx];
            if ((SYM_TO_JP[sym] ?? JackpotType.NONE) === wonTier) {
                matched.push(idx);
            }
        }
        for (const idx of matched) {
            const node = this.coinNodes[idx];
            if (!node) continue;
            const front = node.getChildByName('CoinFront');
            if (!front) continue;
            const sk = front.getComponent(sp.Skeleton);
            if (sk) {
                sk.setAnimation(0, 'win', true);
            }
        }
    }

    private _extractPickWin(resp: any): number {
        const raw = resp?.PickWin ?? resp?.pickWin ?? resp?.WinCash ?? resp?.winCash ?? resp?.TotalWin ?? resp?.totalWin;
        const value = Number(raw);
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    private _getJackpotValueFromServerMeter(tier: JackpotType): number {
        // Meter hiện tại (Wins/After) — cùng nguồn JackpotDisplay đang show
        return GameData.instance.getJackpotMeter(tier);
    }

    /**
     * Số tiền popup: chỉ lấy từ API server — cùng nguồn với JackpotDisplay khi có thể.
     * 1) jackpotValues Before / meter (Wins/After) — khớp Display
     * 2) PickWin từ Pick ACK
     * 3) pickGameWinAmount (Claim WinCash)
     * Không hardcode bet × multiplier.
     */
    private _resolveJackpotAmount(): { amount: number; source: string } {
        const serverMeterAmount = this._getJackpotValueFromServerMeter(this._wonTier);
        if (serverMeterAmount > 0) {
            return { amount: serverMeterAmount, source: 'JackpotValues' };
        }
        if (this._serverPickWinAmount > 0) {
            return { amount: this._serverPickWinAmount, source: 'PickWin' };
        }
        if (GameData.instance.pickGameWinAmount > 0) {
            return { amount: GameData.instance.pickGameWinAmount, source: 'ClaimWinCash' };
        }
        Log.w(`[PickGamePopup] No server jackpot amount for tier=${JackpotType[this._wonTier]}`);
        return { amount: 0, source: 'None' };
    }

    private _emitJackpot = (): void => {
        const { amount, source } = this._resolveJackpotAmount();
        Log.d(`[PickGamePopup] jackpot amount source=${source}`);
        Log.d(`[PickGamePopup] → EMIT JACKPOT_TRIGGER tier=${JackpotType[this._wonTier]} amount=${amount}`);
        GameData.instance.pickGameWinAmount = amount;
        EventBus.instance.emit(GameEvents.JACKPOT_TRIGGER, this._wonTier, amount);
        Log.d(`[PickGamePopup] → EMIT JACKPOT_TRIGGER done`);
    };

    // ── PRIVATE: CLOSE ───────────────────────────────────────────────────────

    /** Bật/tắt tương tác coin (dùng _inEntry flag để chặn pickCoin). */
    private _setButtonsInteractable(enabled: boolean): void {
        if (!enabled) {
            // Dùng _inEntry tạm thời chặn pickCoin — lưu trạng thái qua flag riêng
            this._pickBlocked = !enabled;
        } else {
            this._pickBlocked = false;
        }
    }

    private _closePopup(skipEmitClose: boolean = false): void {
        // ★ Clear mọi timer đang chờ (auto-reveal, jackpot trigger, v.v.)
        this.unscheduleAllCallbacks();

        const doClose = () => {
            this._pickState  = null;

            // Hiện lại bottom UI
            if (this.bottomUINode) this.bottomUINode.active = true;
            EventBus.instance.emit(GameEvents.SHOW_BOTTOM_UI);

            if (!skipEmitClose) {
                Log.d('[PickGamePopup] Closed → emit PICK_GAME_CLOSE');
                EventBus.instance.emit(GameEvents.PICK_GAME_CLOSE);
            }

            // Destroy node hoàn toàn để tránh leak timer/listener
            this.node.destroy();
        };

        if (this.gameContentNode) {
            Tween.stopAllByTarget(this.gameContentNode);
            tween(this.gameContentNode)
                .to(this.hideDuration, { scale: new Vec3(0.1, 0.1, 1) }, { easing: 'backIn' })
                .call(doClose)
                .start();
        } else {
            doClose();
        }
    }
}

