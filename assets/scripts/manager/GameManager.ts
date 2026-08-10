/**
 * GameManager - State Machine điều phối toàn bộ flow game.
 * Component gắn vào root node, quản lý SlotStageType.
 */

import { _decorator, Component, Node, Sprite, SpriteFrame, screen, Color, game, ParticleSystem, assetManager } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import {
    crossfadeSpriteFrame,
    fadeInNode,
    fadeOutNode,
    setNodeOpacity,
    DEFAULT_UI_FADE_DURATION,
} from '../core/OpacityFadeUtil';
import { GameData } from '../data/GameData';
import { SlotStageType, SpinResponse, MatchedLinePay, JackpotType, SymbolId, GameState, FeatureItem, PickGameState, StickyCell, TopupReelSlot, TopupReelType, FeatureSelectChoiceId, isFreeSpinTierReelIndex, gaugeStageFromAccumulated, CarnivalTrailHit, CarnivalFeatureTrigger, CarnivalFeatureKind } from '../data/SlotTypes';
import {
    buildBuyBonusMatsuriTrigger,
    buildBuyBonusMatsuriTriggerFromKind,
    carnivalKindFromBuyBonusTitle,
} from '../data/BuyBonusCatalog';
import { FeatureSelectChoicePayload } from '../controller/FeatureSelectionPopup';
import { NetworkManager } from './NetworkManager';
import { WalletManager } from './WalletManager';
import { BetManager } from './BetManager';
import { SoundManager } from './SoundManager';
import { DebugManager } from './DebugManager';
import { PROGRESSIVE_WIN_THRESHOLDS, ProgressiveWinTier } from '../controller/ProgressiveWinPopup';
import { USE_REAL_API, MOCK_GAUGE_HOLD_SEC_BEFORE_FORCE_ENTRY, MOCK_FORCE_CARNIVAL_TRAILS } from '../data/ServerConfig';
import { MockDataProvider } from '../data/MockDataProvider';
import { psPickToClient, PICK_GAME_CELL_COUNT } from '../data/PickGameUtil';
import { LocalizationManager } from '../core/LocalizationManager';
import { AutoSpinManager, SpeedMode } from './AutoSpinManager';
import { PopUpMessage, PopupCase } from '../core/PopUpMessage';
import { ServerApiError } from './NetworkManager';
import { Log } from '../core/Logger';
import { TopUpManager } from '../controller/TopUpManager';
import { SlotMachineController } from '../controller/SlotMachineController';
import { StickyOverlayController } from '../controller/StickyOverlayController';
import { StickyOverlayLoader } from '../controller/StickyOverlayLoader';
import { SymbolView } from '../controller/SymbolView';
import { TransitionMode } from '../controller/TopUpTransitionPopup';
import {
    MATSURI_GOLD_SYMBOL,
    MATSURI_SPIN_COUNT,
    clampMatsuriRows,
    pickMatsuriStartCoinCells,
} from '../data/MatsuriGridUtil';

const { ccclass, property } = _decorator;

const BG_BUNDLE = 'MainBundle';
/** [0]=portrait, [1]=landscape — paths inside MainBundle (SpriteFrame sub-asset). */
const NORMAL_BG_PATHS = [
    'newTextures/mainUI/Bg-maingame-portrait/spriteFrame',
    'newTextures/mainUI/Bg-maingame-landscape/spriteFrame',
] as const;
const FREESPIN_BG_PATHS = [
    'newTextures/mainUI/Bg-freespins-portrait/spriteFrame',
    'newTextures/mainUI/Bg-freespins-landscape/spriteFrame',
] as const;

const truncateMoney3 = (value: number): number => {
    const clean = Math.round(value * 1e9) / 1e9;
    const fixed9 = clean.toFixed(9);
    const sign = fixed9.startsWith('-') ? -1 : 1;
    const [intPart, decPart = ''] = fixed9.replace('-', '').split('.');
    const mills = Number(intPart) * 1000 + Number(decPart.padEnd(3, '0').slice(0, 3));
    return sign * mills / 1000;
};

interface PendingResumeData {
    nextStage: number;
    remainFreeSpinCount: number;
    featureSpinTotalWin: number;
    lastSpinRands?: number[];
    remainRespinCount?: number;
    topupReel?: TopupReelSlot[];
    stickyCells?: StickyCell[];
    featureBaseCredit?: number;
    /** Pick Game state khi resume vào đúng lúc đang chơi Pick Game (Pot/Jackpot). */
    pickGame?: PickGameState;
}

@ccclass('GameManager')
export class GameManager extends Component {
    @property({ tooltip: 'Bỏ qua Loading + Guide để vào game ngay (chỉ dùng khi dev/debug)' })
    skipIntroScreens: boolean = false;
    private _guideCompleteHandled: boolean = false;

    @property({
        tooltip: '[Two-scene mode] Set TRUE trong game.scene.\n' +
                 'Login đã được xử lý bởi LoadingController ở loading.scene.\n' +
                 'GameManager sẽ bỏ qua login flow, đọc data từ GameData và bắt đầu game ngay.'
    })
    isGameScene: boolean = false;

    @property({ tooltip: 'Delay trước khi hiện FreeSpinEndPopup (giây) — để cho highlight vòng cuối diễn xong' })
    freeSpinEndPopupDelay: number = 1.0;

    @property({ tooltip: 'Delay trước khi hiện FreeSpinStartPopup (giây) — để cho spine effect phát xong' })
    freeSpinStartPopupDelay: number = 0.5;

    @property({ tooltip: 'Delay (giây) giữa khi reel 3 long-spin dừng và lúc 3 symbol jackpot cùng play animation (LONG_SPIN_JACKPOT_REVEAL)' })
    jackpotRevealDelay: number = 0.6;

    @property({ type: Node, tooltip: 'Background node để thay đổi sprite theo orientation' })
    backgroundNode: Node | null = null;

    @property({
        tooltip: 'Thời gian crossfade background / fade UI khi vào-ra Feature/Pick (giây)',
    })
    uiFadeDuration: number = DEFAULT_UI_FADE_DURATION;

    @property({ type: SpriteFrame, tooltip: 'Background sprites NORMAL SPIN — [0]=portrait, [1]=landscape' })
    backgroundSprites: SpriteFrame[] = [];

    @property({ type: SpriteFrame, tooltip: 'Background sprites FREE SPIN — [0]=portrait, [1]=landscape' })
    freeSpinBackgroundSprites: SpriteFrame[] = [];

    @property({ type: Node, tooltip: 'PayOut Display - hiển thị khi Normal Spin' })
    payOutDisplay: Node | null = null;

    @property({ type: Node, tooltip: 'Multiplier Display - hiển thị khi Free Spin' })
    multiplierDisplay: Node | null = null;

    @property({ type: Node, tooltip: 'Multiplier Effect node - active cùng với Multiplier Display' })
    multiplierEffect: Node | null = null;

    @property({ type: Node, tooltip: 'Jackpot Display - ẩn khi TopUp/FreeSpin' })
    jackpotDisplay: Node | null = null;

    @property({ type: Node, tooltip: 'Pot Display - hiển thị khi Normal Spin, ẩn khi TopUp' })
    potDisplay: Node | null = null;

    @property({ type: Node, tooltip: '[Legacy] TopUpUI — Carnival không dùng; luôn ẩn với Matsuri.' })
    topUpDisplay: Node | null = null;

    @property({
        type: Node,
        tooltip: 'FreeSpinUI (Base.prefab) — active khi vào Matsuri / FreeSpin Gold.',
    })
    freeSpinUI: Node | null = null;

    @property({ type: Node, tooltip: 'Alias FreeSpinUI — nếu trống dùng freeSpinUI.' })
    freeSpinGoldDisplay: Node | null = null;

    @property({ type: ParticleSystem, tooltip: 'Particle system - RateOverTime điều chỉnh theo orientation' })
    particleSystem: ParticleSystem | null = null;

    /** Lazy BG load promises keyed by bundle path */
    private _bgLoadPromises: Map<string, Promise<SpriteFrame | null>> = new Map();

    private _currentStage: SlotStageType = SlotStageType.SPIN;
    /** State machine — kiểm soát luồng xử lý và block input */
    private _gameState: GameState = GameState.IDLE;
    private _isSpinning: boolean = false;
    /** True nếu spin hiện tại là long spin — dùng để delay jackpot popup */
    private _hadLongSpin: boolean = false;
    /** Tất cả 3 vị trí hint khi long spin (reel0, reel1, reel2) — dùng cho jackpot reveal */
    private _longSpinHintPositions: { reelIndex: number; rowIndex: number }[] = [];
    /** Đếm số lần free spin đã thực sự chạy (để hiển thị trong FreeSpinEndPopup) */
    private _freeSpinActualCount: number = 0;
    /** Tổng gold coin credit tích lũy trong FreeSpin Gold mode */
    private _freeSpinGoldCoinTotal: number = 0;
    private _freeSpinGoldServerTotalWin: number | null = null;
    private _freeSpinGoldCountedKeys: Set<string> = new Set();
    /** Pending resp khi FreeSpin Gold phải chờ coin fly done trước khi phát WIN_PRESENT_START */
    private _pendingWinPresentResp: typeof GameData.instance.lastSpinResponse | null = null;
    /** Thời gian tối đa (giây) mỗi đồng xu được bay trước khi fallback trigger.
     *  Thực tế: flyDuration(0.6) + squish(0.15) + overhead(~0.05) ≈ 0.8s/coin.
     *  Để 0.9 để có margin an toàn, +2.5s buffer trong công thức maxFlyWait. */
    private readonly _goldFlyFallbackPerCoin: number = 0.9;
    /** Fallback: nếu FREE_SPIN_GOLD_FLY_DONE không đến (component thiếu trong scene), tự phát WIN_PRESENT_START */
    private _goldFlyFallback = () => {
        // Log removed for performance
        this._onGoldFlyDone();
    };
    /** Fallback đảm bảo spin cycle LUÔN kết thúc dù WinPresenter/JackpotPresenter chưa có trong scene */
    private _spinCycleFallback = () => {
        if (!this._isSpinning) {
            this._logSpinState('spinCycleFallback SKIP — not spinning');
            return; // Guard: tránh fire stale timer từ spin trước
        }
        // Nếu jackpot/popup đang mở: KHÔNG can thiệp — chờ popup tự đóng và _onJackpotEnd sẽ handle.
        // Reschedule để vẫn có fallback phòng khi popup bị treo.
        if (this._gameState === GameState.POPUP) {
            this._logSpinState('spinCycleFallback RESCHEDULE — gameState=POPUP');
            this.scheduleOnce(this._spinCycleFallback, 3.0);
            return;
        }
        // CreditFlyEffect chỉ phụ thuộc vào REELS_STOPPED (reel cuối dừng hẳn),
        // không phụ thuộc vào longSpin VFX.
        this._logSpinState('spinCycleFallback FIRE → _afterWinProcessed');
        this._afterWinProcessed();
    };
    /** Safety timeout: nếu REELS_STOPPED không đến → chỉ recover khi reel thật sự đã idle. */
    private _reelsStoppedTimeout = () => {
        if (!this._isSpinning) return;
        if (this._reelsStoppedProcessed) return;

        this._logSpinState('REELS_STOPPED watchdog tick');
        const scene = this.node.scene;
        const slotMachines = scene?.getComponentsInChildren(SlotMachineController) ?? [];
        if (slotMachines.some((smc) => smc.tryRecoverReelsStopped())) return;

        this._logSpinState('REELS_STOPPED watchdog — reels still moving, reschedule 1s');
        this.unschedule(this._reelsStoppedTimeout);
        this.scheduleOnce(this._reelsStoppedTimeout, 1.0);
    };
    /** Cờ chờ FLY_DONE trước khi auto-spin; fallback timer sẽ hủy nếu FLY_DONE đến trước */
    private _waitingForFlyDone: boolean = false;
    /** FLY_DONE đã fire trong spin hiện tại — dùng khi popup (Jackpot/Progressive) delay flow */
    private _flyDoneReceived: boolean = false;
    /** Callback auto-spin (giữ reference để unschedule được) */
    private _autoSpinCallback = () => {
        this._waitingForFlyDone = false;
        EventBus.instance.emit(GameEvents.SPIN_REQUEST);
    };
    /** Fallback: nếu WildTrailController không có trong scene, tự emit WILD_TRAIL_FLY_DONE sau 2s để không treo game */
    private _wildTrailFlyDoneFallback = () => {
        EventBus.instance.emit(GameEvents.WILD_TRAIL_FLY_DONE);
    };
    /** Fallback Carnival Trail — nếu chưa gắn CarnivalTrailController */
    private _carnivalTrailFlyDoneFallback = () => {
        EventBus.instance.emit(GameEvents.CARNIVAL_TRAIL_FLY_DONE);
    };
    /** Đã emit CARNIVAL_TRAIL_START trong spin hiện tại */
    private _carnivalTrailStartedThisSpin: boolean = false;
    private _carnivalTrailFlyDoneReceivedThisSpin: boolean = false;
    private _pendingWinPresentRespCarnival: typeof GameData.instance.lastSpinResponse | null = null;
    private _carnivalTrailReelsProcessed: Set<number> = new Set();
    /** Đang chờ pot burst xong để vào Jackpot / Matsuri */
    private _pendingCarnivalAfterBurst: CarnivalFeatureTrigger | null = null;
    private _carnivalBurstFallback = () => {
        const f = this._pendingCarnivalAfterBurst;
        if (!f) return;
        Log.e('[GameManager] carnival burst fallback → BURST_DONE');
        EventBus.instance.emit(GameEvents.CARNIVAL_POT_BURST_DONE, f);
    };
    /** Fallback: pot spine transition không emit POT_TRANSITION_END → force nhả spin */
    private _potTransitionEndFallback = () => {
        if (!this._isPotTransitioning) return;
        Log.w('[GameManager] pot transition fallback — force POT_TRANSITION_END');
        this._onPotTransitionEnd();
    };
    /** Đủ dài cho wild fly (~2s) + pot spine transition; chỉ là safety net cuối. */
    private static readonly POT_TRANSITION_FALLBACK_SEC = 4.5;
    /** Resp đang chờ WILD_TRAIL_FLY_DONE trước khi emit WIN_PRESENT_START (no-win + wild trail case) */
    private _pendingWinPresentRespWild: typeof GameData.instance.lastSpinResponse | null = null;
    private _wildTrailFlyDoneReceivedThisSpin: boolean = false;
    /** Resp đang chờ CREDIT_FLY_IN_DONE trước khi emit WIN_PRESENT_START (Feature Select case) */
    private _pendingWinPresentRespFeature: typeof GameData.instance.lastSpinResponse | null = null;
    /** Feature Select có win: chờ highlight xong mới bắt đầu credit fly */
    private _pendingFeatureSelectAfterHighlight: boolean = false;
    /** Chỉ true khi CREDIT_FLY_IN_DONE thuộc đúng FeatureSelect hiện tại. */
    private _awaitingFeatureSelectCreditDone: boolean = false;
    /** Đã emit CREDIT_FLY_IN_START trong lượt feature select hiện tại — tránh double-emit */
    private _featureSelectCreditFlyDone: boolean = false;
    /** ★ Feature Entry Logic Added — đã chạy chuỗi Force Feature Entry cho spin hiện tại. */
    private _forceFeatureEntryPlayed: boolean = false;
    /** Đã xử lý REELS_STOPPED trong spin hiện tại — ngăn duplicate processing */
    private _reelsStoppedProcessed: boolean = false;
    /** Có một SPIN_REQUEST bị reject vì reel còn settling — retry khi reel idle. */
    private _pendingSpinRequestAfterSettled: boolean = false;
    /** Đã emit WILD_TRAIL_ONE cho reel này trong spin hiện tại — ngăn duplicate per-reel */
    private _wildTrailReelsProcessed: Set<number> = new Set();
    private _featureSelectWinPresentationFallback = () => {
        if (!this._pendingFeatureSelectAfterHighlight || this._featureSelectCreditFlyDone) return;
        Log.e('[GOLD-FLY][FEATURE_SELECT] WIN_PRESENT_END fallback — start credit fly after forced presentation end');
        this._afterWinProcessed();
        this.scheduleOnce(() => this._startFeatureSelectCreditFly('win-presentation-fallback'), 0);
    };
    /** Snapshot stickyCells keys trước mỗi TopUp spin — dùng để detect new cells khi có pre-add per-reel */
    private _topUpStickySnapshot: Set<string> = new Set();
    private _topUpRemainBeforeSpin: number = 0;
    /** Cache TopUpManager — tránh getComponent(s)InChildren(scene) mỗi lần lock seed coin. */
    private _cachedTopUpMgr: TopUpManager | null = null;
    /** Pending resume data khi Enter trả về lastSpinResponse đang dở Free Spin */
    private _pendingResume: PendingResumeData | null = null;
    /** Pending resume sau khi jackpot popup đóng (resume interrupted by jackpot) */
    private _pendingResumeAfterJackpot: PendingResumeData | null = null;
    /** Resume TopUp end: show total-win popup first, then call Claim when popup closes. */
    private _claimTopUpAfterEndPopup: boolean = false;
    /** [TEMP] Tạm tắt absorb effect để test reel spin */
    private _skipTopUpAbsorb: boolean = false;
    /** Pick Game đang active — block các Progressive Win check khác */
    private _isPickGameActive: boolean = false;
    /** Chờ TransitionPopup SHOW rồi mới đổi background Pick Game (dưới overlay) */
    private _pickGameBgPending: boolean = false;
    /** Twin node cho crossfade background (tạo runtime). */
    private _bgFadeTwin: Node | null = null;
    /** SpriteFrame đang hiển thị trên backgroundNode — tránh crossfade trùng. */
    private _currentBgFrame: SpriteFrame | null = null;
    /** TopUp: UI đã prepare dưới TransitionPopup; gameplay (SPIN) chờ DONE */
    private _topUpUiPrepared: boolean = false;
    private _topUpStartGameplayPending: boolean = false;
    private _topUpFirstSpinDelay: number = 0.4;
    /** Count chờ prepare khi Transition fade-in xong (READY) */
    private _pendingTopUpPrepareCount: number | null = null;
    private _pendingFreespinPrepareCount: number | null = null;
    /** Pot transition animation đang chạy — chỉ defer stage đặc biệt (non-SPIN), không chặn Spin thường */
    private _isPotTransitioning: boolean = false;
    /** _afterWinProcessed bị defer vì pot transition chưa xong (non-SPIN) — flush khi POT_TRANSITION_END */
    private _pendingAfterWinProcessed: boolean = false;
    /** Free Spin end pending sau khi Pick Game đóng */
    private _pendingFreeSpinEnd: boolean = false;
    /** Cho phép lazy-load main BG — bật khi GuideView hiện (prefetch) hoặc vào game */
    private _bgLoadAllowed: boolean = false;

    // ─── LIFECYCLE ───

    onLoad(): void {
        // Khóa target 60 FPS (web/desktop). Cocos dùng rAF + cap theo giá trị này.
        game.frameRate = 60;

        // Khởi tạo DebugManager sớm để keyboard shortcuts (F1-F7) hoạt động ngay từ đầu
        DebugManager.instance.toString();
        // Khởi tạo AutoSpinManager sớm để ENTER_SUCCESS listener được đăng ký trước khi login xong.
        // Dùng toString() để tránh build optimizer tree-shake biểu thức không có side-effect.
        AutoSpinManager.instance.toString();

        this._bindEvents();

        // 🎯 Cho phép game chạy khi chuyển tab (background mode)
        // Cocos tự động pause khi visibilitychange → hidden; ta resume lại ngay.
    

        // 🎯 Lắng nghe screen resize/orientation để cập nhật background sprite
        screen.on('window-resize', this._updateBackgroundSprite, this);
        screen.on('orientation-change', this._updateBackgroundSprite, this);
        screen.on('window-resize', this._updateParticleRateOverTime, this);
        screen.on('orientation-change', this._updateParticleRateOverTime, this);
        // Không gán BG lúc onLoad — prefetch khi GuideView hiện (GameRoot warm)
        this._clearBackgroundSprite();
        this._updateParticleRateOverTime();
    }

    start(): void {
        const data = GameData.instance;
        // Two-scene mode: LoadingController set isFromLoadingScene=true trước director.loadScene()
        // → không cần tick isGameScene hay isEntered trong Inspector.
        if (data.isFromLoadingScene || data.isEntered || this.isGameScene) {
            // Log removed for performance
            this._startFromGameScene();
            return;
        }
        if (this.skipIntroScreens) {
            // Chế độ dev: bỏ qua Loading + Guide, khởi động game ngay
            if (USE_REAL_API) {
                // Log removed for performance
                this._startWithServerLogin();
            } else {
                // Log removed for performance
                this._startWithMockInit();
            }
            return;
        }
        // Log removed for performance
        // Single-scene mode: chờ LOADING_GATE_REACHED (bar được 90%)
        // rồi mới bắt đầu login/init — được lắng nghe trong _bindEvents()
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        NetworkManager.instance.dispose();
        // Hủy listener screen events
        screen.off('window-resize', this._updateBackgroundSprite, this);
        screen.off('orientation-change', this._updateBackgroundSprite, this);
        screen.off('window-resize', this._updateParticleRateOverTime, this);
        screen.off('orientation-change', this._updateParticleRateOverTime, this);
    }

    // ─── SERVER LOGIN + ENTER FLOW ───

    /**
     * Quy trình Login → Enter khi USE_REAL_API = true:
     *
     * 1. Lấy gp token từ URL (nếu production) hoặc dùng test login (dev)
     * 2. Gọi Login API → nhận SessionKey, MemberIdx, Seq, Aky
     * 3. Gọi Enter API → nhận ParSheet, balance, initial state
     * 4. Cập nhật GameData, WalletManager
     * 5. Bắt đầu HeartBeat + Jackpot polling
     * 6. Emit GAME_READY
     */
    private async _startWithServerLogin(): Promise<void> {
        const net = NetworkManager.instance;
        const data = GameData.instance;

        EventBus.instance.emit(GameEvents.LOGIN_START);
        // Log.d('[GameManager] Bắt đầu Login Server...');

        try {
            // ─── Step 1: Login ───
            // Production: lấy gp token từ URL query params
            // Dev: dùng test login (không cần gp)
            const urlParams = new (window.URLSearchParams)(window.location.search);
            const gpToken = urlParams.get('gp');
            const loginParams = gpToken ? { gp: gpToken } : undefined;

            const session = await net.login(loginParams);
            // Log.d(`[GameManager] Login OK — Nick: ${session.nick}, Cash: ${session.cash}`);

            // Cập nhật balance từ server
            WalletManager.instance.balance = session.cash;

            EventBus.instance.emit(GameEvents.LOGIN_SUCCESS, session);

            // ─── Step 2: Enter Game ───
            const enterResp = await net.enterGame();
            // Log.d(`[GameManager] Enter OK — Slot: ${enterResp.slotName}, Cash: ${enterResp.cash}`);

            // Cập nhật balance từ Enter response (có thể khác login)
            WalletManager.instance.balance = enterResp.cash;

            // Cập nhật bet settings từ server
            data.player.betIndex = enterResp.betIndex;
            // TODO: Parse PS (ParSheet) để cập nhật reelStrips, paylines, etc.
            // data.config = parseParSheet(enterResp.ps);

            EventBus.instance.emit(GameEvents.ENTER_SUCCESS, enterResp);

            // ─── Step 3: Bắt đầu background tasks ───
            net.startHeartBeat();
            net.startJackpotPolling();

            // ─── Step 4: Sync pot + gauge từ Enter LastSpinResponse ───
            this._syncEnterGaugeState(enterResp.lastSpinResponse);
            const enterPotVisualLevel = (enterResp.lastSpinResponse as any)?.PotVisualLevel ?? (enterResp.lastSpinResponse as any)?.potVisualLevel;
            if (enterPotVisualLevel != null) {
                data.potLevel = Math.max(0, Math.min(6, enterPotVisualLevel as number));
                // Log removed for performance
            }

            // ─── Step 5: Kiểm tra LastSpinResponse — resume Free Spin nếu đang dở ───
            if (enterResp.lastSpinResponse) {
                const raw = enterResp.lastSpinResponse;
                this._pendingResume = this._buildPendingResume(raw, '_startWithServerLogin');
                // Logs removed for performance
            } else {
                // Log removed for performance
            }

            // ★ Flag resume để GameEntryController skip guide
            // Chỉ skip guide khi FreeSpin/Claim cần xử lý ngay — Normal Spin resume không cần skip
            if (this._pendingResume && this._pendingResume.nextStage !== SlotStageType.SPIN) {
                data.isResumingFreeSpin = true;
                // Log removed for performance
            }

            // ─── Step 5: Emit initial data + Game Ready ───
            this._emitInitialData();

            if (this.skipIntroScreens) {
                EventBus.instance.emit(GameEvents.GAME_READY);
            }
            // Nếu không skip: chờ GUIDE_COMPLETE → _onGuideComplete → GAME_READY

        } catch (err: any) {
            // Log removed for performance
            EventBus.instance.emit(GameEvents.LOGIN_FAILED, err.message || 'Login failed');
            // Nếu NetworkManager đã emit popup (ServerApiError.alreadyHandled), không emit lại
            if (!(err instanceof ServerApiError && err.alreadyHandled)) {
                const popupCase = PopUpMessage.popupCaseFromError(err);
                EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, { popupCase });
            }
        }
    }

    // ─── GAME SCENE START (two-scene mode) ───

    /**
     * Được gọi khi isGameScene = true.
     * Login + Enter đã hoàn tất ở loading.scene bởi LoadingController.
     * GameData đã có đầy đủ: serverSession, balance, betIndex, isLoggedIn, isEntered.
     *
     * Flow:
     *   1. Emit LOADING_COMPLETE → GuideController hiển thị guide (hoặc skip nếu tắt)
     *   2. Sau GUIDE_COMPLETE → GAME_ENTRY_EFFECT → GAME_READY (đã bind trong _bindEvents)
     */
    private _startFromGameScene(): void {
        const data = GameData.instance;
        const net = NetworkManager.instance;

        // Sync pot + gauge từ Enter response nếu có
        this._syncEnterGaugeState(data.rawEnterLastSpinResponse);
        const enterPotVisualLevel = (data.rawEnterLastSpinResponse as any)?.PotVisualLevel ?? (data.rawEnterLastSpinResponse as any)?.potVisualLevel;
        if (enterPotVisualLevel != null) {
            data.potLevel = Math.max(0, Math.min(6, enterPotVisualLevel as number));
            // Log removed for performance
        }

        if (!data.isEntered) {
            // Dữ liệu chưa được load (vào thẳng game scene mà không qua loading scene)
            // Fallback: chạy login ngay tại đây
            // Log removed for performance
            if (USE_REAL_API) {
                // Log removed for performance
                this._startWithServerLogin();
            } else {
                // Log removed for performance
                // Dùng async _startWithMockInit để đọc lastSpinResponse + set _pendingResume.
                // LOADING_COMPLETE sẽ được emit bên trong _startWithMockInit sau khi data đã sẵn sàng.
                this._startWithMockInit(true); // true = emit LOADING_COMPLETE sau enterGame
            }
            return;
        }

        // Đã Enter ở loading scene (real hoặc mock) — không login lại
        if (USE_REAL_API) {
            net.startHeartBeat();
            net.startJackpotPolling();
            // Re-emit ENTER_SUCCESS để SlotMachineController init reels
            EventBus.instance.emit(GameEvents.ENTER_SUCCESS, {
                cash: WalletManager.instance.balance,
                slotName: 'Carnival Neko',
                ps: '',
                betIndex: data.player.betIndex,
                coinValueIndex: 0,
                lastSpinResponse: data.lastSpinResponse,
                isPractice: false,
                memberIdx: data.serverSession?.memberIdx ?? 0,
                smm: null,
            });
        } else {
            // Mock: init strips/map + emit ENTER_SUCCESS (không gọi lại login/enter)
            this._initMockMode();
        }

        // Kiểm tra Free Spin resume
        const rawLast = data.rawEnterLastSpinResponse;
        if (rawLast) {
            this._pendingResume = this._buildPendingResume(rawLast, '_startFromGameScene');
        }

        // ★ Flag resume để GameEntryController skip guide
        // Chỉ skip guide khi FreeSpin/Claim cần xử lý ngay — Normal Spin resume không cần skip
        if (this._pendingResume && this._pendingResume.nextStage !== SlotStageType.SPIN) {
            data.isResumingFreeSpin = true;
        }

        // Dùng scheduleOnce(0) để defer sang frame tiếp theo:
        // đảm bảo TẤT CẢ start() trong scene đã chạy xong trước khi emit LOADING_COMPLETE.
        this.scheduleOnce(() => {
            this._emitInitialData();
            // ★ GameRoot có thể activate SAU Guide (deferred) — nếu Guide đã xong thì GAME_READY ngay
            if (data.isGuideCompleted || data.isResumingFreeSpin || this.skipIntroScreens) {
                this._guideCompleteHandled = true;
                this._allowBackgroundLoad();
                EventBus.instance.emit(GameEvents.GAME_READY);
                return;
            }
            // Guide đang hiện (warm path) hoặc chưa hiện — không re-emit LOADING_COMPLETE
            // (LoadingController đã emit). Chỉ chờ GUIDE_COMPLETE.
            if (data.isGuideShowing) {
                this.prefetchBackground();
                return;
            }
            EventBus.instance.emit(GameEvents.LOADING_COMPLETE);
            // Sau đó: GuideController show → GUIDE_COMPLETE → GAME_ENTRY_EFFECT → GAME_READY
        }, 0);

        // ★ skipIntroScreens: không có guide → emit GAME_READY trực tiếp (giống _startWithServerLogin).
        // Đảm bảo resume flow chạy ngay cả khi GameEntryController không có trong scene.
        if (this.skipIntroScreens) {
            this.scheduleOnce(() => {
                EventBus.instance.emit(GameEvents.GAME_READY);
            }, 0.1);
        }

        // Trong super-html build, FontFace có thể chưa hoàn toàn sẵn sàng khi scene render lần đầu.
        // Emit LANGUAGE_CHANGED sau 1 frame để các LocaleFont/LanguageChange components re-apply font.
        this.scheduleOnce(() => {
            EventBus.instance.emit(GameEvents.LANGUAGE_CHANGED,
                LocalizationManager.instance.currentLanguage);
        }, 0.1);
    }

    // ─── EVENT BINDING ───

    private _bindEvents(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.LOADING_GATE_REACHED,            this._onLoadingGateReached,     this);
        bus.on(GameEvents.GUIDE_COMPLETE,                  this._onGuideComplete,          this);
        bus.on(GameEvents.SPIN_REQUEST,                    this._onSpinRequest,            this);
        bus.on(GameEvents.REELS_STOPPED,                   this._onReelsStopped,           this);
        bus.on(GameEvents.REEL_STOPPED,                    this._onReelStoppedWild,        this);
        bus.on(GameEvents.WIN_PRESENT_END,                 this._onWinPresentEnd,          this);
        bus.on(GameEvents.JACKPOT_END,                     this._onJackpotEnd,             this);
        bus.on(GameEvents.PROGRESSIVE_WIN_END,             this._onProgressiveWinEnd,      this);
        bus.on(GameEvents.POT_WIN_DONE,                    this._onPotWinDone,             this);
        bus.on(GameEvents.PICK_GAME_CLOSE,                 this._onPickGameClose,          this);
        bus.on(GameEvents.PICK_GAME_ENTRY_DONE,            this._onPickGameEntryDone,      this);
        bus.on(GameEvents.PICK_GAME_NEED_CLAIM,            this._onPickGameNeedClaim,      this);
        bus.on(GameEvents.TOPUP_TRANSITION_READY,          this._onTopUpTransitionReady,   this);
        bus.on(GameEvents.TOPUP_TRANSITION_DONE,           this._onTopUpTransitionDone,    this);
        bus.on(GameEvents.FREE_SPIN_START,                 this._onFreeSpinStart,          this);
        bus.on(GameEvents.FREE_SPIN_END,                   this._onFreeSpinEnd,            this);
        bus.on(GameEvents.FREE_SPIN_END_POPUP_CLOSED,      this._onFreeSpinEndPopupClosed, this);
        bus.on(GameEvents.TOPUP_END_POPUP_CLOSED,          this._onTopUpEndPopupClosed,    this);
        bus.on(GameEvents.FREE_SPIN_MULTIPLIER_FLY_DONE,   this._onMultiplierFlyDone,      this);
        bus.on(GameEvents.FREE_SPIN_MULTIPLIER_SPIN,       this._onMultiplierSpinStart,    this);
        bus.on(GameEvents.BUY_BONUS_REQUEST,               this._onBuyBonusRequest,        this);
        bus.on(GameEvents.BUY_BONUS_CONFIRM,               this._onBuyBonusConfirm,        this);
        bus.on(GameEvents.BUY_BONUS_ACTIVATE,              this._onBuyBonusActivate,       this);
        bus.on(GameEvents.BUY_BONUS_DEACTIVATE,            this._onBuyBonusDeactivate,     this);
        bus.on(GameEvents.FEATURE_SELECT_CHOICE,           this._onFeatureSelectChoice,  this);
        bus.on(GameEvents.GAME_READY,                      this._onGameReady,              this);
        bus.on(GameEvents.CREDIT_FLY_IN_DONE,              this._onCreditFlyInDone,        this);
        bus.on(GameEvents.FREE_SPIN_GOLD_FLY_DONE,         this._onGoldFlyDone,            this);
        bus.on(GameEvents.WIN_HIGHLIGHT_ANIM_DONE,         this._onHighlightAnimDone,      this);
        bus.on(GameEvents.WILD_TRAIL_FLY_DONE,              this._onWildTrailFlyDoneCancelFallback, this);
        bus.on(GameEvents.CARNIVAL_TRAIL_FLY_DONE,          this._onCarnivalTrailFlyDone, this);
        bus.on(GameEvents.CARNIVAL_POT_BURST_DONE,          this._onCarnivalPotBurstDone, this);
        bus.on(GameEvents.CARNIVAL_MATSURI_STUB_DONE,       this._onCarnivalMatsuriStubDone, this);
        bus.on(GameEvents.MATSURI_COLLECT_CREDIT,           this._onMatsuriCollectCredit, this);
        bus.on(GameEvents.MATSURI_FLIP_DONE,                this._onMatsuriFlipDone, this);
        bus.on(GameEvents.MATSURI_SEED_CELL,                this._onMatsuriSeedCell, this);
        bus.on(GameEvents.MATSURI_SEED_DONE,                this._onMatsuriSeedDone, this);
        bus.on(GameEvents.MATSURI_START_POPUP_CLOSED,       this._onMatsuriStartPopupClosed, this);
        bus.on(GameEvents.PICK_GAME_START_POPUP_CLOSED,     this._onJackpotStartPopupClosed, this);
        bus.on(GameEvents.POT_TRANSITION_END,                this._onPotTransitionEnd,       this);
        // LONG_SPIN_VFX events: chỉ SoundManager cần, GameManager không gate bằng VFX nữa.
    }

    // ─── LOADING GATE (90%) → BẮĐẦU TẢI DỮ LIỆU ───

    /** Bar đạt 90% — bộ độc login+enter (real) hoặc mock init */
    private _onLoadingGateReached(): void {
        if (this.skipIntroScreens) return; // đã xử lý trong start()
        if (USE_REAL_API) {
            this._startWithServerLogin();
        } else {
            this._startWithMockInit();
        }
    }

    // ─── GUIDE COMPLETE → KHỚI ĐỘNG GAME ───

    private _onGuideComplete(): void {
        if (this._guideCompleteHandled) return;
        this._guideCompleteHandled = true;
        // ★ #5: Load BG sau khi Guide xong — không tranh I/O với guide slides
        this._allowBackgroundLoad();
        this._emitInitialData();
        // GAME_ENTRY_EFFECT is now emitted by GameEntryController AFTER gameRoot.active=true,
        // ensuring SoundManager.onLoad() has already run before the event fires.
        // Emit GAME_READY here — SoundManager is now guaranteed initialized.
        EventBus.instance.emit(GameEvents.GAME_READY);
    }

    private _emitInitialData(): void {
        this._updateDisplayVisibility();
        EventBus.instance.emit(GameEvents.BALANCE_UPDATED, WalletManager.instance.balance);
        EventBus.instance.emit(GameEvents.BET_CHANGED, {
            betIndex: BetManager.instance.betIndex,
            currentBet: BetManager.instance.currentBet,
            coinValue: BetManager.instance.coinValue,
            totalBet: BetManager.instance.totalBet,
        });
    }

    /**
     * Async mock init — tương đương _startWithServerLogin() nhưng dùng MockNetworkAdapter.
     * Gọi enterGame() để lấy lastSpinResponse (bao gồm MOCK_RESUME_SCENARIO),
     * rồi set _pendingResume trước khi GAME_READY fire.
     *
     * @param emitLoadingComplete  Nếu true, emit LOADING_COMPLETE sau khi enterGame() xong
     *                             (dùng cho _startFromGameScene path — cần đợi _pendingResume set trước)
     */
    private async _startWithMockInit(emitLoadingComplete: boolean = false): Promise<void> {
        // Bước 1: init strips, psToClientMap, emit ENTER_SUCCESS cho SlotMachineController
        this._initMockMode();

        // Bước 1a: gọi mock login và lưu session để kích hoạt currency override
        const session = await NetworkManager.instance.login();
        GameData.instance.setServerSession(session);
        WalletManager.instance.balance = session.cash;

        // Bước 2: gọi MockNetworkAdapter.enterGame() để lấy lastSpinResponse
        // (sẽ chứa dữ liệu từ MOCK_RESUME_SCENARIO nếu khác 'none')
        const enterResp = await NetworkManager.instance.enterGame();
        // Log removed for performance

        // Bước 3: sync pot + gauge từ mock Enter response
        this._syncEnterGaugeState(enterResp.lastSpinResponse);
        const enterPotVisualLevel = (enterResp.lastSpinResponse as any)?.PotVisualLevel ?? (enterResp.lastSpinResponse as any)?.potVisualLevel;
        if (enterPotVisualLevel != null) {
            GameData.instance.potLevel = Math.max(0, Math.min(6, enterPotVisualLevel as number));
            // Log removed for performance
        }

        // Bước 4: parse lastSpinResponse giống _startWithServerLogin
        if (enterResp.lastSpinResponse) {
            this._pendingResume = this._buildPendingResume(enterResp.lastSpinResponse, '_startWithMockInit');
        } else {
            // Log removed for performance
        }

        // ★ Flag resume để GameEntryController skip guide
        if (this._pendingResume) {
            GameData.instance.isResumingFreeSpin = true;
            // Log removed for performance
        }

        // Bước 4a: emit LOADING_COMPLETE nếu được yêu cầu (isGameScene path)
        if (emitLoadingComplete) {
            // Log removed for performance
            this._emitInitialData();
            EventBus.instance.emit(GameEvents.LOADING_COMPLETE);
            // Sau đó: GuideController chạy xong → GUIDE_COMPLETE → _onGuideComplete → GAME_READY
            return;
        }

        // Bước 4b: emit GAME_READY nếu skipIntroScreens (không có Guide)
        if (this.skipIntroScreens) {
            // Log removed for performance
            EventBus.instance.emit(GameEvents.GAME_READY);
        }
        // Nếu không skip: GuideController chạy xong → GUIDE_COMPLETE → _onGuideComplete → GAME_READY
    }

    /** Khởi tạo mock mode — giả lập Enter + PS data để các component như real API */
    private _initMockMode(): void {
        const data = GameData.instance;

        // GoF: rawPsStrips không dùng PS IDs cũ nữa — để trống, ReelController dùng clientStrips trực tiếp
        data.rawPsStrips = [];
        data.rawPsFreeSpinStrips = [];
        data.rawPsPurchaseReelStrips = [];
        data.psToClientMap = {};

        this._emitInitialData();

        // Emit ENTER_SUCCESS để SlotMachineController._onEnterSuccess() chạy
        // (init reel symbols từ PS strips trước khi quay)
        EventBus.instance.emit(GameEvents.ENTER_SUCCESS, {
            cash: WalletManager.instance.balance,
            slotName: 'SuperNova (Mock)',
            ps: '',
            betIndex: 0,
            coinValueIndex: 0,
            lastSpinResponse: null,
            isPractice: false,
            memberIdx: 0,
            smm: null,
        });
    }

    /** Clone bay xong (hoặc no-win skip) → bắt đầu auto-spin sau 800ms */
    private _onMultiplierFlyDone(): void {
        this._flyDoneReceived = true;
        if (!this._waitingForFlyDone) return;
        this._waitingForFlyDone = false;
        this.unschedule(this._autoSpinCallback);
        this.scheduleOnce(this._autoSpinCallback, this._getAutoSpinDelay());
    }

    /** FREE_SPIN_START event → cập nhật background sprite sang FreeSpin + gọi popup logic */
    private _onFreeSpinStart(): void {
        this._updateBackgroundSprite();
        // FreeSpin Gold tự xử lý flow — không cần qua FreeSpinPopup closed logic
        if (this._isFreespinGold()) return;
        // Gọi logic cũ của popup closed: chuyển stage + emit events
        this._onFreeSpinPopupClosed();
    }

    /** FREE_SPIN_END event → cập nhật background sprite về Normal */
    private _onFreeSpinEnd(): void {
        this._updateDisplayVisibility();
        this._updateBackgroundSprite();
        // multiplierEffect ẩn cùng với kết thúc rolling
        if (this.multiplierEffect) this.multiplierEffect.active = false;
    }

    /** FREE_SPIN_MULTIPLIER_SPIN event → bật multiplierEffect cùng lúc rolling bắt đầu */
    private _onMultiplierSpinStart(): void {
        if (this.multiplierEffect) this.multiplierEffect.active = true;
    }

    private _onFreeSpinPopupClosed(): void {
        const data = GameData.instance;
        // Chỉ chuyển sang FREE_SPIN khi đang ở các stage START (không phải đang spin rồi)
        const isFreeSpinStartStage = (
            this._currentStage === SlotStageType.FREE_SPIN_START ||
            this._currentStage === SlotStageType.FREE_SPIN_RE_TRIGGER ||
            this._currentStage === SlotStageType.BUY_FREE_SPIN_START
        );
        if (data.freeSpinRemaining > 0 && isFreeSpinStartStage) {
            // Xác định stage phù hợp: nếu đang ở BUY_FREE_SPIN_START → BUY_FREE_SPIN, ngược lại → FREE_SPIN
            const targetStage = (this._currentStage === SlotStageType.BUY_FREE_SPIN_START)
                ? SlotStageType.BUY_FREE_SPIN
                : SlotStageType.FREE_SPIN;
            this._currentStage = targetStage;
            this._updateDisplayVisibility(); // ← chuyển sang FS display đúng lúc popup đóng và vòng quay bắt đầu
            // Log removed for performance
            EventBus.instance.emit(GameEvents.STAGE_CHANGED, targetStage);
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
            this._gameState = GameState.IDLE;
            // Auto spin ngay sau popup đóng
            this.scheduleOnce(() => {
                EventBus.instance.emit(GameEvents.SPIN_REQUEST);
            }, 0.2);
        } else {
            Log.w(`[GameManager] FreeSpinPopup đóng nhưng điều kiện không hợp lệ: remain=${data.freeSpinRemaining}, stage=${this._currentStage}`);
        }
    }

    // ─── SPIN REQUEST ───

    private _areSlotReelsSettled(): boolean {
        if (this._isTopUp()) return true;
        if (this._isMatsuri()) return true;
        const scene = this.node.scene;
        if (!scene) return true;
        const slotMachines = scene.getComponentsInChildren(SlotMachineController);
        if (slotMachines.length === 0) return true;
        return slotMachines.every((smc) => smc.areAllReelsStopped);
    }

    private _getSlotReelDebugState(): string {
        const scene = this.node.scene;
        const slotMachines = scene?.getComponentsInChildren(SlotMachineController) ?? [];
        if (slotMachines.length === 0) return 'slotMachines=0';
        return slotMachines.map((smc, i) => `SM${i}{${smc.debugStateSummary}}`).join(' | ');
    }

    private _logSpinState(reason: string): void {
        // TEMP SPIN-HANG debug — bỏ comment khối dưới khi cần trace treo spin
        // const auto = AutoSpinManager.instance;
        // Log.e(
        //     `[SPIN-HANG][GM] ${reason} | isSpinning=${this._isSpinning} gameState=${this._gameState}` +
        //     ` stage=${this._currentStage} mode=${GameData.instance.currentMode} reelsStoppedProcessed=${this._reelsStoppedProcessed}` +
        //     ` potTransit=${this._isPotTransitioning} pendingAfterWin=${this._pendingAfterWinProcessed}` +
        //     ` pendingWild=${!!this._pendingWinPresentRespWild} pendingGold=${!!this._pendingWinPresentResp}` +
        //     ` pendingFeature=${!!this._pendingWinPresentRespFeature} wildFlyDone=${this._wildTrailFlyDoneReceivedThisSpin}` +
        //     ` pendingRetry=${this._pendingSpinRequestAfterSettled} autoActive=${auto.isAutoSpinActive} autoCount=${auto.autoSpinCount}` +
        //     ` speed=${auto.speedMode} | ${this._getSlotReelDebugState()}`
        // );
        void reason;
    }

    private _clearFeatureSelectTransientState(): void {
        this._pendingWinPresentRespFeature = null;
        this._pendingFeatureSelectAfterHighlight = false;
        this._awaitingFeatureSelectCreditDone = false;
        this._featureSelectCreditFlyDone = false;
        this._forceFeatureEntryPlayed = false;
        this.unschedule(this._featureSelectWinPresentationFallback);
    }

    private _startFeatureSelectCreditFly(reason: string): void {
        if (this._featureSelectCreditFlyDone) {
            Log.e(`[GOLD-FLY][FEATURE_SELECT] SKIP credit fly — already started | reason=${reason}`);
            return;
        }
        if (!this._reelsStoppedProcessed) {
            Log.e(`[GOLD-FLY][FEATURE_SELECT] SKIP credit fly — reel chưa dừng hẳn | reason=${reason}`);
            return;
        }

        const featureResp = GameData.instance.lastSpinResponse;
        const nextStage = featureResp?.nextStage as SlotStageType | undefined;
        const isFeatureSelect = nextStage === SlotStageType.FEATURE_SELECT || nextStage === SlotStageType.FEATURE_SELECT_START;
        if (!featureResp || !isFeatureSelect) {
            Log.e(`[GOLD-FLY][FEATURE_SELECT] SKIP credit fly — nextStage=${nextStage} | reason=${reason}`);
            return;
        }

        // ★ FEATURE ENTRY LOGIC ADDED — Force Feature Entry (Sticky < 6):
        //   chạy hiệu ứng nữ thần + đổ Sticky TRƯỚC credit-fly. Sau khi xong (DONE)
        //   gọi lại chính hàm này để tiếp tục EACH WIN accumulation + Feature Select popup.
        if (featureResp.isForcedFeatureEntry && !this._forceFeatureEntryPlayed) {
            this._forceFeatureEntryPlayed = true;
            Log.e('[FEATURE-ENTRY] Force Feature Entry → guide + sticky fill trước credit-fly');

            // Tắt ngay highlight / line cycling — kể cả trong mock gauge hold trước guide.
            EventBus.instance.emit(GameEvents.WIN_HIGHLIGHT_CLEAR);

            const beginForceEntry = (): void => {
                // Gauge reset do server xử lý sau Pick Game — client không reset local tại đây.
                EventBus.instance.once(GameEvents.FORCE_FEATURE_ENTRY_DONE, () => {
                    const force = featureResp.forceFeatureEntry;
                    if (force?.fillCells?.length) {
                        const data = GameData.instance;
                        for (const cell of force.fillCells) {
                            data.stickyCells.set(`${cell.reel}-${cell.row}`, cell);
                        }
                        featureResp.stickyCells = [...(force.existingCells ?? []), ...force.fillCells];
                        Log.e(`[FEATURE-ENTRY] merged ${force.fillCells.length} fill cells → stickyCells=${featureResp.stickyCells.length}`);
                    }
                    this._startFeatureSelectCreditFly('force-feature-entry-done');
                }, this);
                EventBus.instance.emit(GameEvents.FORCE_FEATURE_ENTRY_START, featureResp.forceFeatureEntry);
            };

            const holdSec = !USE_REAL_API ? MOCK_GAUGE_HOLD_SEC_BEFORE_FORCE_ENTRY : 0;
            if (holdSec > 0) {
                Log.e(`[FEATURE-ENTRY] mock: giữ gauge sáng ${holdSec}s trước reset + guide`);
                this.scheduleOnce(beginForceEntry, holdSec);
            } else {
                beginForceEntry();
            }
            return;
        }

        const cells = featureResp.stickyCells ?? [];
        const sumCredit = cells.reduce((sum, c) => sum + (c.credit ?? 0), 0);
        GameData.instance.featureBaseCredit = sumCredit;

        this._pendingFeatureSelectAfterHighlight = false;
        this._featureSelectCreditFlyDone = true;
        this.unschedule(this._featureSelectWinPresentationFallback);

        Log.e(`[GOLD-FLY][FEATURE_SELECT] START CREDIT_FLY_IN | reason=${reason} cells=${cells.length} sumCredit=${sumCredit}`);

        // Flow bắt buộc khi 6+ Red + (có/không) line win trước credit fly:
        //   1) Tắt hẳn highlight (cycling / fillBlack / sprite bounce)
        //   2) Tất cả sticky đỏ nhún cùng lúc
        //   3) Bounce xong → CREDIT_FLY_IN_START
        EventBus.instance.emit(GameEvents.WIN_HIGHLIGHT_CLEAR);

        const bounceDur = SymbolView.getLandBounceDuration();
        this.scheduleOnce(() => {
            if (this._featureSelectCreditFlyDone !== true) return;
            Log.e('[GOLD-FLY][FEATURE_SELECT] highlight cleared → RED_SYMBOL_BOUNCE');
            EventBus.instance.emit(GameEvents.RED_SYMBOL_BOUNCE);
            this.scheduleOnce(() => {
                this._awaitingFeatureSelectCreditDone = true;
                Log.e('[GOLD-FLY][FEATURE_SELECT] red bounce done → CREDIT_FLY_IN_START');
                EventBus.instance.emit(GameEvents.CREDIT_FLY_IN_START, { sumCredit, stickyCells: cells });
            }, bounceDur);
        }, 0.05);
    }

    private _shouldRetrySpinRequestAfterSettled(): boolean {
        return AutoSpinManager.instance.isAutoSpinActive || this._isFreeSpin() || this._isTopUp() || this._isMatsuri();
    }

    private _retrySpinRequestAfterReelsSettled(): void {
        if (this._pendingSpinRequestAfterSettled) return;
        this._pendingSpinRequestAfterSettled = true;
        this._logSpinState('schedule retry SPIN_REQUEST after reels settled');

        const retry = () => {
            if (!this._pendingSpinRequestAfterSettled) return;
            if (!this._shouldRetrySpinRequestAfterSettled()) {
                this._pendingSpinRequestAfterSettled = false;
                this._logSpinState('cancel retry SPIN_REQUEST because auto/feature no longer active');
                return;
            }
            if (this._isSpinning || this._gameState === GameState.RESULT || this._gameState === GameState.POPUP) {
                this.scheduleOnce(retry, 0.2);
                return;
            }
            if (!this._areSlotReelsSettled()) {
                this.scheduleOnce(retry, 0.2);
                return;
            }

            this._pendingSpinRequestAfterSettled = false;
            this._logSpinState('retry SPIN_REQUEST after reels settled');
            EventBus.instance.emit(GameEvents.SPIN_REQUEST);
        };

        this.scheduleOnce(retry, 0.2);
    }

    private async _onSpinRequest(): Promise<void> {
        this._logSpinState('SPIN_REQUEST received');
        if (this._isSpinning) {
            this._logSpinState('SPIN_REQUEST ignored because GameManager is spinning');
            return;
        }
        // Matsuri: chặn mọi spin cho tới khi seed sticky vàng hiện xong hết
        if (this._matsuriAwaitingSeed) {
            this._logSpinState('SPIN_REQUEST ignored — waiting Matsuri seed stickies');
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
            return;
        }
        if (!this._areSlotReelsSettled()) {
            // Log.e('[SPIN-HANG][GM] SPIN_REQUEST ignored — slot reels are still settling');
            this._logSpinState('SPIN_REQUEST ignored because slot reels are still settling');
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
            if (this._shouldRetrySpinRequestAfterSettled()) {
                this._retrySpinRequestAfterReelsSettled();
            }
            return;
        }
        // Block spin khi đang xử lý result hoặc popup
        if (this._gameState === GameState.RESULT || this._gameState === GameState.POPUP) {
            this._logSpinState(`SPIN_REQUEST ignored because gameState=${this._gameState}`);
            return;
        }

        // CN: server stage ≥ NEED_CLAIM(100) phải Claim trước Spin.
        // Client-only stages (200–999: POT_WIN, CARNIVAL_MATSURI_START=240, …) KHÔNG claim.
        if (USE_REAL_API && this._stageRequiresServerClaim(this._currentStage)) {
            Log.e(
                `[CarnivalMatsuri] SPIN blocked → Claim first (stage=${this._currentStage})`,
            );
            this._logSpinState(`SPIN_REQUEST blocked — need Claim first (stage=${this._currentStage})`);
            void this._handleClaim();
            return;
        }

        // Reset pot transition flags từ spin trước (safety)
        this.unschedule(this._potTransitionEndFallback);
        this._isPotTransitioning = false;
        this._pendingAfterWinProcessed = false;

        // Log.d(`[SPIN] NHẤN SPIN`);

        const data = GameData.instance;
        const wallet = WalletManager.instance;
        const isFreeSpin = this._isFreeSpin();
        const isTopUp = this._isTopUp();
        const isMatsuri = this._isMatsuri();
        const isFeatureSpin = isFreeSpin || isTopUp || isMatsuri;

        // Feature spins (FreeSpin / Topup) không trừ tiền từng lượt.
        if (!isFeatureSpin) {
            const totalBet = BetManager.instance.totalBet;
            if (!wallet.canAfford(totalBet)) {
                // Thử refresh balance từ partner (e.g. player đã top-up bên ngoài)
                if (USE_REAL_API) {
                    try {
                        const result = await NetworkManager.instance.sendBalanceGet();
                        WalletManager.instance.balance = result.balance;
                        Log.d(`%c[BalanceGet] Refreshed balance=${result.balance} ${result.currency}`, 'color:#0af;font-weight:bold');
                    } catch (err) {
                        Log.w('[BalanceGet] Failed to refresh balance:', err);
                    }
                }
                if (!wallet.canAfford(totalBet)) {
                    EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, {
                        popupCase: PopupCase.INSUFFICIENT_BALANCE,
                        onConfirm: async () => {
                            try {
                                const result = await NetworkManager.instance.sendBalanceGet();
                                WalletManager.instance.balance = result.balance;
                            } catch (e) {
                                Log.w('[Spin] Refresh balance failed:', e);
                            }
                        },
                    });
                    return;
                }
            }
            // Deduct bet locally ngay lập tức để UI phản hồi ngay (cả mock lẫn real API).
            // Real API: server trả remainCash sau khi spin xong sẽ reconcile lại balance chính xác.
            wallet.deduct(totalBet);
        }

        this._isSpinning = true;
        this._flyDoneReceived = false;
        this._hadLongSpin = false;
        this._longSpinHintPositions = [];
        this._pendingWinPresentRespWild = null;
        this._wildTrailFlyDoneReceivedThisSpin = false;
        this._pendingWinPresentRespCarnival = null;
        this._carnivalTrailFlyDoneReceivedThisSpin = false;
        this._carnivalTrailStartedThisSpin = false;
        this._carnivalTrailReelsProcessed.clear();
        this._pendingWinPresentRespFeature = null;
        this._pendingFeatureSelectAfterHighlight = false;
        this._awaitingFeatureSelectCreditDone = false;
        this._featureSelectCreditFlyDone = false;
        this._forceFeatureEntryPlayed = false;
        this._reelsStoppedProcessed = false;
        this._pendingSpinRequestAfterSettled = false;
        this._wildTrailReelsProcessed.clear();
        this._gameState = GameState.SPINNING;
        this._logSpinState('SPIN_REQUEST accepted, entering SPINNING');
        // Clear stickyCells từ spin trước (nếu không phải respin/matsuri — giữ sticky cũ)
        if (!isFeatureSpin && GameData.instance.currentMode !== 'respin' && GameData.instance.currentMode !== 'matsuri') {
            GameData.instance.stickyCells.clear();
        }

        if (isTopUp || isMatsuri) {
            // ★ Xóa PLUS_ONE_SPIN khỏi stickyCells trước khi quay lượt mới
            //    +1 Spin chỉ hiển thị trong lượt rơi xuống, không sticky qua lượt
            for (const [key, cell] of data.stickyCells.entries()) {
                if (cell.symbolId === SymbolId.PLUS_ONE_SPIN) {
                    data.stickyCells.delete(key);
                }
            }
            this._topUpRemainBeforeSpin = data.respinRemaining;
            data.respinRemaining = Math.max(0, data.respinRemaining - 1);
            EventBus.instance.emit(GameEvents.TOPUP_COUNT_UPDATED, data.respinRemaining);
            this._topUpStickySnapshot = new Set(data.stickyCells.keys());
        }
        if (isFreeSpin) {
            data.freeSpinRemaining = Math.max(0, data.freeSpinRemaining - 1);
            EventBus.instance.emit(GameEvents.FREE_SPIN_COUNT_UPDATED, data.freeSpinRemaining);
            if (this._isFreespinGold()) {
                data.freeSpinGoldRemaining = data.freeSpinRemaining;
                EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_COUNT_UPDATED, data.freeSpinGoldRemaining);
            }
        }
        // Clear stale fallback + timeout từ spin trước (Cocos scheduleOnce không replace delay đúng)
        this.unschedule(this._spinCycleFallback);
        this.unschedule(this._reelsStoppedTimeout);
        this.unschedule(this._featureSelectWinPresentationFallback);
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);

        // ★ PHASE 1: Quay reel NGAY LẬP TỨC (không chờ server)
        EventBus.instance.emit(GameEvents.REELS_START_SPIN);

        // Multiplier Phase 1: bắt đầu rolling (chỉ trong Free Spin)
        if (isFreeSpin) {
            EventBus.instance.emit(GameEvents.FREE_SPIN_MULTIPLIER_SPIN);
        }

        // ★ PHASE 2: Gửi request (mock/real) — reel đang quay trong lúc chờ
        try {
            const response = await NetworkManager.instance.sendSpinRequest(isFreeSpin);
            data.lastSpinResponse = response;

            // Multiplier Phase 2: chốt hệ số khi biết kết quả từ server
            // Emit LOCK nếu server trả featureMultiple > 1 (bất kể có win hay không)
            const fm = response.featureMultiple;
            const willLock = isFreeSpin && fm != null && fm > 1;
            Log.d(
                `%c[MULTIPLIER] isFS=${isFreeSpin} | featureMultiple=${fm ?? 'null'} | totalWin=${response.totalWin} | → ${willLock ? 'EMIT LOCK ✓' : 'no lock (mult=' + fm + ')'}`,
                willLock ? 'color:#0f0;font-weight:bold' : 'color:#888;'
            );
            // TODO: uncomment khi debug multiplier
            /*Log.d(
                `%c[MULTIPLIER] isFS=${isFreeSpin} | featureMultiple=${fm ?? 'null'} | totalWin=${response.totalWin} | → ${willLock ? 'EMIT LOCK ✓' : 'no lock (mult=' + fm + ')'}`,
                willLock ? 'color:#0f0;font-weight:bold' : 'color:#888;'
            );*/
            if (willLock) {
                EventBus.instance.emit(GameEvents.FREE_SPIN_MULTIPLIER_LOCK, fm);
            }

            // Detect Long Spin — trả về danh sách vị trí hint nếu có
            const longSpinHints = (isTopUp || isMatsuri) ? this._getTopUpLongSpinHints() : this._getLongSpinHints(response);
            if (longSpinHints.length > 0) {
                this._hadLongSpin = true;
                this._longSpinHintPositions = longSpinHints;
                EventBus.instance.emit(GameEvents.LONG_SPIN_TRIGGERED);
                // Emit hint positions ngay để SlotMachineController lưu lại
                // (spine effect bắt đầu sau khi cột 2 dừng)
                EventBus.instance.emit(GameEvents.LONG_SPIN_SYMBOL_HINT, longSpinHints);
            }

            // ★ Store stickyCells NGAY khi nhận response (trước khi reel dừng)
            // để credit values hiển thị đúng khi mỗi reel stop.
            // EXCEPTION: TopUp / Matsuri — KHÔNG pre-store ở đây
            // (TopUp: absorb detect newCells; Matsuri: Green→Gold lúc stop/land)
            if (!isTopUp && !isMatsuri && response.stickyCells && response.stickyCells.length > 0) {
                // Force Feature Entry: chỉ pre-store ô Red tự nhiên; fillCells merge sau STICKY_FILL_DONE
                const cellsToStore = response.isForcedFeatureEntry && response.forceFeatureEntry
                    ? response.forceFeatureEntry.existingCells
                    : response.stickyCells;
                for (const cell of cellsToStore) {
                    data.stickyCells.set(`${cell.reel}-${cell.row}`, cell);
                }
                if (response.isForcedFeatureEntry) {
                    Log.e(`[FEATURE-ENTRY] pre-store ${cellsToStore.length} existing sticky (fill ${response.forceFeatureEntry?.fillCells?.length ?? 0} deferred)`);
                }
            }

            const debugGrid = data.getBaseGrid(response.rands, isFreeSpin, response.reelIndex);
            const debugGridRedCells: string[] = [];
            for (let reel = 0; reel < debugGrid.length; reel++) {
                for (let row = 0; row < debugGrid[reel].length; row++) {
                    if (debugGrid[reel][row] === SymbolId.STICKY_RED) {
                        debugGridRedCells.push(`r${reel}row${row}`);
                    }
                }
            }
            const debugStickyReds = (response.stickyCells ?? [])
                .filter(c => c.symbolId === SymbolId.STICKY_RED)
                .map(c => `r${c.reel}row${c.row}`);
            // ★ PHASE 2: Ra lệnh dừng reel với kết quả
            EventBus.instance.emit(GameEvents.SPIN_RESPONSE, response);

            // Safety monitor: không force theo thời gian mù nữa.
            // Watchdog chỉ recover khi SlotMachineController xác nhận tất cả reel đã idle.
            this.scheduleOnce(this._reelsStoppedTimeout, 2.0);
        } catch (err: any) {
            // ★ Log nguyên nhân thực sự — bao gồm cả lỗi client-side xảy ra SAU khi server trả OK
            Log.e(
                `[CarnivalMatsuri] SPIN FAILED mode=${GameData.instance.currentMode}` +
                ` isMatsuri=${isMatsuri} msg=${err?.message ?? err}`,
                err,
            );
            if (!isFeatureSpin) {
                wallet.add(BetManager.instance.totalBet);
            }
            this._isSpinning = false;
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
            // Nếu NetworkManager đã emit popup (ServerApiError.alreadyHandled), không emit lại
            if (!(err instanceof ServerApiError && err.alreadyHandled)) {
                const popupCase = PopUpMessage.popupCaseFromError(err);
                EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, { popupCase });
            }
        }
    }

    // ─── WILD TRAIL FLY DONE: huỷ fallback + emit WIN_PRESENT_START nếu đang pending ───

    /**
     * WildTrailController emit WILD_TRAIL_FLY_DONE thật sự:
     *  1. Hủy fallback 2s
     *  2. Nếu có resp đang pending (no-win + wild trail) → emit WIN_PRESENT_START ngay
     */
    private _onWildTrailFlyDoneCancelFallback(): void {
        this._wildTrailFlyDoneReceivedThisSpin = true;
        this.unschedule(this._wildTrailFlyDoneFallback);
        if (this._pendingWinPresentRespWild) {
            const resp = this._pendingWinPresentRespWild;
            this._pendingWinPresentRespWild = null;
            const hasRedSticky = !this._isFreeSpin()
                && (resp.stickyCells?.some((c: StickyCell) => c.symbolId === SymbolId.STICKY_RED) ?? false);
            this._logSpinState(
                `WILD_TRAIL_FLY_DONE → emit WIN_PRESENT_START | totalWin=${resp.totalWin}` +
                ` ways=${resp.waysPayWins?.length ?? 0} lines=${resp.matchedLinePays?.length ?? 0}` +
                ` hasRedSticky=${hasRedSticky}`
            );
            this._emitWinPresentAfterRedLandBounce(resp, hasRedSticky);
        } else {
            this._logSpinState('WILD_TRAIL_FLY_DONE — no pending WIN_PRESENT');
        }
    }

    /** Carnival Trail flip+fly xong → tiếp tục WIN_PRESENT nếu đang defer. */
    private _onCarnivalTrailFlyDone(): void {
        this._carnivalTrailFlyDoneReceivedThisSpin = true;
        this.unschedule(this._carnivalTrailFlyDoneFallback);
        if (this._pendingWinPresentRespCarnival) {
            const resp = this._pendingWinPresentRespCarnival;
            this._pendingWinPresentRespCarnival = null;
            const hasRedSticky = !this._isFreeSpin()
                && (resp.stickyCells?.some((c: StickyCell) => c.symbolId === SymbolId.STICKY_RED) ?? false);
            this._logSpinState(
                `CARNIVAL_TRAIL_FLY_DONE → emit WIN_PRESENT_START | totalWin=${resp.totalWin}`
            );
            this._emitWinPresentAfterRedLandBounce(resp, hasRedSticky);
        } else {
            this._logSpinState('CARNIVAL_TRAIL_FLY_DONE — no pending WIN_PRESENT');
        }
    }

    /** Bắt đầu Pot burst — CarnivalPotBoard anim → CARNIVAL_POT_BURST_DONE. */
    private _startCarnivalPotBurst(feature: CarnivalFeatureTrigger): void {
        this._pendingCarnivalAfterBurst = feature;
        this.unschedule(this._carnivalBurstFallback);
        this.scheduleOnce(this._carnivalBurstFallback, 2.0);
        // Line/Ways win cùng spin → tắt highlight + dừng WinPresenter cycle trước khi vào Feature
        EventBus.instance.emit(GameEvents.WIN_HIGHLIGHT_CLEAR);
        EventBus.instance.emit(GameEvents.CARNIVAL_POT_BURST, feature);
        // Sync level UI về 0 cho pot đã nổ (resolve đã/ sẽ reset trong PotBoard)
        EventBus.instance.emit(GameEvents.CARNIVAL_POT_LEVELS_CHANGED, { ...GameData.instance.potLevels });
    }

    private _onCarnivalPotBurstDone(feature?: CarnivalFeatureTrigger): void {
        this.unschedule(this._carnivalBurstFallback);
        const f = feature ?? this._pendingCarnivalAfterBurst;
        this._pendingCarnivalAfterBurst = null;
        if (!f) {
            Log.e('[GameManager] CARNIVAL_POT_BURST_DONE nhưng không có feature');
            return;
        }

        Log.e(
            `[GameManager] BURST_DONE → ${f.featureName} jackpotFirst=${f.jackpotFirst}` +
            ` jackpotAfterFS=${f.jackpotAfterFreeSpin} rows=${f.matsuriRows}`,
        );

        if (f.jackpotFirst) {
            // Red-only: mở Pick ngay (Ultra+ không còn Pick-first — API V1.0.2)
            Log.e('[GameManager] Carnival Jackpot (Red-only) → open PickGame ngay');
            this._onPotWinDone();
            return;
        }

        // Mighty/Mega/Super/Ultra/Supreme/Ultimate — Matsuri trước; Pick (nếu có) sau Claim
        this._showMatsuriStartPopupThenEnter(f);
    }

    /** Stash feature đang chờ Press to Start. */
    private _pendingMatsuriStartFeature: CarnivalFeatureTrigger | null = null;

    /**
     * Hiện popup thông báo feature (Mega Feature Award / with 5xN Reel / PRESS TO START).
     * Chỉ sau khi đóng mới _enterCarnivalMatsuri.
     */
    private _showMatsuriStartPopupThenEnter(feature: CarnivalFeatureTrigger): void {
        this._pendingMatsuriStartFeature = feature;
        this._gameState = GameState.IDLE;
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
        // Đảm bảo WaysPay/Symbol highlight không còn khi hiện Press to Start
        EventBus.instance.emit(GameEvents.WIN_HIGHLIGHT_CLEAR);
        Log.e(`[GameManager] MATSURI_START_POPUP → "${feature.featureName}" 5x${feature.matsuriRows}`);
        EventBus.instance.emit(GameEvents.MATSURI_START_POPUP, feature);
        // Failsafe nếu PopupLoader miss event
        this.unschedule(this._matsuriStartPopupFailsafe);
        this.scheduleOnce(this._matsuriStartPopupFailsafe, 25.0);
    }

    private _matsuriStartPopupFailsafe = (): void => {
        if (!this._pendingMatsuriStartFeature) return;
        Log.w('[GameManager] Matsuri start popup failsafe — enter feature');
        this._onMatsuriStartPopupClosed(this._pendingMatsuriStartFeature);
    };

    private _onMatsuriStartPopupClosed(feature?: CarnivalFeatureTrigger): void {
        this.unschedule(this._matsuriStartPopupFailsafe);
        const f = feature ?? this._pendingMatsuriStartFeature;
        this._pendingMatsuriStartFeature = null;
        if (!f) {
            Log.w('[GameManager] MATSURI_START_POPUP_CLOSED nhưng không có feature');
            return;
        }
        void this._enterCarnivalMatsuri(f);
    }

    /** Pending Start Gold — hiện sau khi orb bay vào (không nằm sẵn trên grid). */
    private _pendingMatsuriSeedCells: StickyCell[] = [];
    private _matsuriAwaitingSeed = false;

    /** Swap respin strips theo API CurrentFeatureType (FreeSpinReel group 0–5). */
    private _applyCnFeatureStrips(apiType: number | undefined | null): void {
        const data = GameData.instance;
        if (apiType == null || apiType < 0 || apiType > 5) return;
        const strips = data.config.freeSpinTierStrips?.[apiType];
        const raw = data.rawPsFreeSpinTierStrips?.[apiType];
        if (strips?.length === 5) {
            data.config.respinReelStrips = strips;
            data.cnApiFeatureType = apiType;
            Log.e(`[CarnivalMatsuri] strips ← FreeSpinReel group ${apiType}`);
        }
        if (raw?.length === 5) {
            // rawPs dùng cho debug/payout — giữ sync với visual
            data.rawPsFreeSpinStrips = raw;
        }
    }

    /** Vào Matsuri Hold&Spin — tái dùng StickyOverlay + TopUpManager (grid 5×N). */
    private async _enterCarnivalMatsuri(feature: CarnivalFeatureTrigger): Promise<void> {
        GameData.instance.pendingCarnivalMatsuri = null;
        const data = GameData.instance;
        const spin = data.lastSpinResponse;
        const rows = clampMatsuriRows(spin?.featureRows ?? feature.matsuriRows ?? 3);

        data.currentMode = 'matsuri';
        data.matsuriRows = rows;
        data.matsuriFeatureName = feature.featureName;
        // API type 0–5: ưu tiên kind (đúng combo pot); fallback CurrentFeatureType từ spin
        let apiType: number | undefined;
        if (feature.kind >= CarnivalFeatureKind.MIGHTY
            && feature.kind <= CarnivalFeatureKind.ULTIMATE) {
            apiType = feature.kind - CarnivalFeatureKind.MIGHTY;
        } else if (spin?.currentFeatureType != null && spin.currentFeatureType >= 0) {
            apiType = spin.currentFeatureType;
        }
        if (apiType != null && apiType >= 0) {
            data.cnApiFeatureType = apiType;
        }
        this._applyCnFeatureStrips(apiType);

        // Remain từ server (FREE_SPIN_START); fallback MATSURI_SPIN_COUNT
        const serverRemain = spin?.remainRespinCount;
        data.respinRemaining = (serverRemain != null && serverRemain >= 0)
            ? serverRemain
            : MATSURI_SPIN_COUNT;
        data.respinTotalWin = spin?.featureSpinTotalWin ?? 0;
        data.stickyCells.clear();
        this._topUpStickySnapshot.clear();
        this._topUpRemainBeforeSpin = 0;
        this._currentStage = SlotStageType.CARNIVAL_MATSURI_START;
        this._gameState = GameState.IDLE;

        // Real: StarterCoins từ server; Mock: random seed
        let placed: StickyCell[];
        if (USE_REAL_API && spin?.starterCoins && spin.starterCoins.length > 0) {
            placed = spin.starterCoins.map((c) => ({
                ...c,
                symbolId: c.symbolId === SymbolId.STICKY_GREEN ? SymbolId.STICKY_GREEN : MATSURI_GOLD_SYMBOL,
            }));
        } else if (USE_REAL_API && spin?.allStickies && spin.allStickies.length > 0) {
            placed = spin.allStickies.map((c) => ({ ...c, symbolId: MATSURI_GOLD_SYMBOL }));
        } else {
            placed = pickMatsuriStartCoinCells(rows, feature.startCoins, data.totalBet);
        }
        data.featureBaseCredit = placed.reduce((s, c) => s + (c.credit ?? 0), 0);
        this._pendingMatsuriSeedCells = placed;
        this._matsuriAwaitingSeed = true;

        Log.e(
            `[CarnivalMatsuri] ENTER "${feature.featureName}" grid=5x${rows} ` +
            `startCoins=${placed.length}/${feature.startCoins} base=${data.featureBaseCredit} ` +
            `remain=${data.respinRemaining} totalBet=${data.totalBet} ` +
            `credits=[${placed.map(c => `${c.reel}-${c.row}:${c.credit}`).join('|')}]` +
            ` source=${USE_REAL_API && spin?.starterCoins?.length ? 'StarterCoins' : 'mock'}`,
        );

        this._updateDisplayVisibility();
        this._updateBackgroundSprite();

        await this._ensureStickyOverlayLoaded();
        this._applyStickyOverlayRowCount(rows);

        EventBus.instance.emit(GameEvents.CARNIVAL_MATSURI_START, feature);
        EventBus.instance.emit(GameEvents.CARNIVAL_MATSURI_STUB, feature); // alias listener cũ
        // Grid trống lúc vào — coin xuất hiện khi orb land
        EventBus.instance.emit(GameEvents.TOPUP_START, {
            spinsRemaining: data.respinRemaining,
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
            stickyCells: [],
            matsuri: true,
            rows,
        });
        EventBus.instance.emit(GameEvents.TOPUP_COUNT_UPDATED, data.respinRemaining);
        EventBus.instance.emit(GameEvents.TOPUP_TOTAL_UPDATED, {
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
        });
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);

        EventBus.instance.emit(GameEvents.MATSURI_SEED_START, { cells: placed });

        // Failsafe nếu thiếu MatsuriEffect / seed (đủ dài cho 10 orb + pop + highlight)
        this.unschedule(this._matsuriSeedFailsafe);
        this.scheduleOnce(this._matsuriSeedFailsafe, 20.0);
    }

    private _matsuriSeedFailsafe = (): void => {
        if (!this._matsuriAwaitingSeed) return;
        Log.w('[Matsuri] seed failsafe — place remaining cells');
        const data = GameData.instance;
        for (const cell of this._pendingMatsuriSeedCells) {
            const key = `${cell.reel}-${cell.row}`;
            if (!data.stickyCells.has(key)) {
                data.stickyCells.set(key, { ...cell });
                EventBus.instance.emit(GameEvents.MATSURI_SEED_CELL, { ...cell });
            }
        }
        EventBus.instance.emit(GameEvents.TOPUP_TOTAL_UPDATED, {
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
        });
        EventBus.instance.emit(GameEvents.MATSURI_SEED_DONE);
    };

    private _onMatsuriSeedCell(cell: StickyCell): void {
        if (!cell) return;
        // lockCellAt (matsuri) đã blockInPlace + hideForOverlay — không scan scene lần 2
        this._lockTopUpCell(cell);
    }

    private _onMatsuriSeedDone(): void {
        if (!this._matsuriAwaitingSeed) return;
        this._matsuriAwaitingSeed = false;
        this._pendingMatsuriSeedCells = [];
        this.unschedule(this._matsuriSeedFailsafe);

        Log.e('[CarnivalMatsuri] seed done → first spin');
        // Seed xong: stage client → TOPUP_SPIN (không để CARNIVAL_MATSURI_START=240
        // vì gate Claim cũ coi ≥100 là NEED_CLAIM → gọi /Claim nhầm → 30034).
        this._currentStage = SlotStageType.TOPUP_SPIN;
        this._gameState = GameState.IDLE;
        // Seed/highlight đã xong trong MatsuriEffect — nghỉ ngắn rồi mới quay
        this.scheduleOnce(() => {
            const d = GameData.instance;
            Log.e(
                `[CarnivalMatsuri] emit SPIN_REQUEST mode=${d.currentMode}` +
                ` stage=${this._currentStage} remain=${d.respinRemaining}` +
                ` featureType=${d.cnApiFeatureType}` +
                ` sticky=${d.stickyCells.size} gameState=${this._gameState}`,
            );
            EventBus.instance.emit(GameEvents.SPIN_REQUEST);
        }, 0.35);
    }

    private _onCarnivalMatsuriStubDone(): void {
        // External / legacy: chỉ end nếu vẫn đang matsuri (tránh loop từ emit trong _endCarnivalMatsuri)
        if (GameData.instance.currentMode === 'matsuri') {
            this._endCarnivalMatsuri();
        }
    }

    /**
     * Kết thúc Matsuri — Real: Claim trước rồi popup; Mock: cộng win rồi popup.
     * Cleanup thật sự chạy trong _onTopUpEndPopupClosed (mode matsuri).
     */
    /** Pick seed từ Claim sau Ultra/Supreme/Ultimate Matsuri (NextStage=PICK_START). */
    private _pendingPickAfterMatsuriClaim: PickGameState | null = null;

    private _endCarnivalMatsuri(): void {
        const data = GameData.instance;
        if (data.currentMode !== 'matsuri') return;

        Log.e(`[CarnivalMatsuri] END "${data.matsuriFeatureName}" clientTotal=${data.respinTotalWin}`);
        this._gameState = GameState.POPUP;
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);

        // Real + Mock: Claim trước (Mock Ultra+ trả PICK_START + PickGame)
        void this._handleTopUpClaim();
    }

    /** Đợi collect+flip Matsuri xong mới transition stage. */
    private _pendingMatsuriNext: SlotStageType | null = null;
    private _matsuriAwaitingCollect = false;
    private _matsuriCollectCreditsSeen = false;
    private _pendingMatsuriGoldForFailsafe: StickyCell[] = [];

    /**
     * Matsuri reels stopped:
     *   có Green → collect/fly toàn bộ Gold → flip Green→Gold → reset 3 spins → tiếp tục
     *   không Green → spin −1 → tiếp tục / end
     */
    private _handleMatsuriReelsStopped(resp: SpinResponse): void {
        const data = GameData.instance;
        this.unschedule(this._spinCycleFallback);

        const rows = clampMatsuriRows(data.matsuriRows || 3);
        let greenCount = 0;

        if (resp.stickyCells) {
            for (const cell of resp.stickyCells) {
                // Chỉ đếm Green mới — tránh coi mọi stickyCells là green → reset spin mãi
                if (cell.symbolId != null && cell.symbolId !== SymbolId.STICKY_GREEN) continue;
                const key = `${cell.reel}-${cell.row}`;
                const credit = cell.credit ?? 0;
                const existing = data.stickyCells.get(key);
                // Ô đã là Gold/Red từ trước → không phải Green mới
                if (existing
                    && existing.symbolId !== SymbolId.STICKY_GREEN
                    && existing.symbolId !== SymbolId.PLUS_ONE_SPIN) {
                    continue;
                }
                greenCount++;

                // Per-reel land có thể đã add Green — chỉ bổ sung nếu thiếu
                if (!existing) {
                    const green: StickyCell = {
                        reel: cell.reel,
                        row: cell.row,
                        symbolId: SymbolId.STICKY_GREEN,
                        credit,
                    };
                    data.stickyCells.set(key, green);
                    this._lockTopUpCell(green);
                    Log.e(`[Matsuri] late-add Green ${key} credit=${credit}`);
                } else if (existing.symbolId === SymbolId.STICKY_GREEN && credit > 0) {
                    existing.credit = credit;
                }
            }
        }

        // Sync từ topupReel nếu stickyCells thiếu (phòng parser)
        const slots = resp.topupReel ?? [];
        if (greenCount === 0 && slots.length > 0) {
            for (let serverIdx = 0; serverIdx < slots.length; serverIdx++) {
                const slot = slots[serverIdx];
                if ((slot.type ?? TopupReelType.NONE) !== TopupReelType.GREEN) continue;
                const apiRow = Math.floor(serverIdx / 5);
                const reel = serverIdx % 5;
                const row = rows - 1 - apiRow;
                const key = `${reel}-${row}`;
                const existing = data.stickyCells.get(key);
                if (existing
                    && existing.symbolId !== SymbolId.STICKY_GREEN
                    && existing.symbolId !== SymbolId.PLUS_ONE_SPIN) {
                    continue;
                }
                const credit = slot.win ?? 0;
                greenCount++;
                if (existing) continue;
                const green: StickyCell = { reel, row, symbolId: SymbolId.STICKY_GREEN, credit };
                data.stickyCells.set(key, green);
                this._lockTopUpCell(green);
            }
        }

        // ★ remain chỉ lấy từ API (mock cũng trả cùng field remainRespinCount).
        // Green reset 3 spins = server/mock set remainRespinCount=3 — client không tự +1.
        if (resp.remainRespinCount != null) {
            data.respinRemaining = Math.max(0, resp.remainRespinCount);
        } else if (greenCount > 0) {
            // Fallback khi response thiếu field (không nên xảy ra với API chuẩn)
            data.respinRemaining = MATSURI_SPIN_COUNT;
        }

        // Sync AllStickies (Gold đã giữ) nếu server gửi full set
        if (resp.allStickies?.length) {
            for (const cell of resp.allStickies) {
                const key = `${cell.reel}-${cell.row}`;
                if (!data.stickyCells.has(key)) {
                    data.stickyCells.set(key, { ...cell, symbolId: MATSURI_GOLD_SYMBOL });
                }
            }
        }

        if (resp.featureSpinTotalWin != null && resp.featureSpinTotalWin > data.respinTotalWin) {
            data.respinTotalWin = resp.featureSpinTotalWin;
        }

        if (resp.isGridFull) {
            const gWin = resp.gridFullGrandWin ?? resp.featureSpinTotalWin ?? 0;
            Log.e(`[Matsuri] GRID FULL grandWin=${gWin}`);
            EventBus.instance.emit(GameEvents.CARNIVAL_GRID_FULL, { amount: gWin });
            if (gWin > data.respinTotalWin) data.respinTotalWin = gWin;
        }

        this._isSpinning = false;

        // Server FREE_SPIN_END / NEED_CLAIM / remain=0 / full grid → END
        const serverEnd = resp.nextStage === SlotStageType.FREE_SPIN_END
            || resp.nextStage === SlotStageType.NEED_CLAIM
            || (resp.nextStage as number) >= 100
            || !!resp.isGridFull;
        const next = (!serverEnd && data.respinRemaining > 0)
            ? SlotStageType.TOPUP_SPIN
            : SlotStageType.TOPUP_SPIN_END;

        Log.e(
            `[Matsuri] stopped green=${greenCount} filled=${data.stickyCells.size} ` +
            `remain=${data.respinRemaining} total=${data.respinTotalWin} next=${next}` +
            ` serverStage=${resp.nextStage} gridFull=${!!resp.isGridFull}`,
        );

        if (greenCount > 0) {
            // Gold hiện có (chưa gồm Green vừa land) → bay về UI tổng
            const goldCells: StickyCell[] = [];
            for (const cell of data.stickyCells.values()) {
                if (
                    (cell.symbolId === MATSURI_GOLD_SYMBOL || cell.symbolId === SymbolId.STICKY_YELLOW)
                    && (cell.credit ?? 0) > 0
                ) {
                    goldCells.push({ ...cell });
                }
            }

            this._pendingMatsuriNext = next;
            this._matsuriAwaitingCollect = true;
            this._matsuriCollectCreditsSeen = false;
            this._pendingMatsuriGoldForFailsafe = goldCells;
            // Chưa cập nhật count UI cho đến sau flip (vẫn hiện số cũ trong lúc bay)
            EventBus.instance.emit(GameEvents.MATSURI_COLLECT_START, { goldCells });

            // Failsafe: effect kẹt / thiếu component
            this.unschedule(this._matsuriCollectFailsafe);
            this.scheduleOnce(this._matsuriCollectFailsafe, 5.0);
            return;
        }

        // Không Green — chỉ cập nhật count / total rồi tiếp tục
        EventBus.instance.emit(GameEvents.TOPUP_COUNT_UPDATED, data.respinRemaining);
        EventBus.instance.emit(GameEvents.TOPUP_TOTAL_UPDATED, {
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
        });

        this._transitionStage(next);
        if (this._gameState !== GameState.POPUP) {
            this._gameState = GameState.IDLE;
        }
    }

    private _matsuriCollectFailsafe = (): void => {
        if (!this._matsuriAwaitingCollect) return;
        Log.w('[Matsuri] collect/flip failsafe');
        if (!this._matsuriCollectCreditsSeen) {
            for (const c of this._pendingMatsuriGoldForFailsafe) {
                EventBus.instance.emit(GameEvents.MATSURI_COLLECT_CREDIT, { credit: c.credit ?? 0 });
            }
        }
        this._pendingMatsuriGoldForFailsafe = [];
        EventBus.instance.emit(GameEvents.MATSURI_COLLECT_DONE);
    };

    private _onMatsuriCollectCredit(payload: { credit?: number }): void {
        const credit = Math.max(0, payload?.credit ?? 0);
        if (credit <= 0) return;
        this._matsuriCollectCreditsSeen = true;
        const data = GameData.instance;
        data.respinTotalWin = truncateMoney3(data.respinTotalWin + credit);
        EventBus.instance.emit(GameEvents.TOPUP_TOTAL_UPDATED, {
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
        });
        Log.e(`[Matsuri] collect +${credit} → total=${data.respinTotalWin}`);
    }

    private _onMatsuriFlipDone(): void {
        if (!this._matsuriAwaitingCollect) return;
        this._matsuriAwaitingCollect = false;
        this._matsuriCollectCreditsSeen = false;
        this._pendingMatsuriGoldForFailsafe = [];
        this.unschedule(this._matsuriCollectFailsafe);

        const data = GameData.instance;

        // Sync Grand / server total sau collect (full grid)
        const resp = data.lastSpinResponse;
        const serverTotal = resp?.featureSpinTotalWin;
        if (serverTotal != null && serverTotal > data.respinTotalWin) {
            data.respinTotalWin = serverTotal;
        }

        EventBus.instance.emit(GameEvents.TOPUP_COUNT_UPDATED, data.respinRemaining);
        EventBus.instance.emit(GameEvents.TOPUP_TOTAL_UPDATED, {
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
        });

        // remain <= 0 → END (không reset 3 / không default tiếp tục quay)
        let next = this._pendingMatsuriNext
            ?? (data.respinRemaining > 0 ? SlotStageType.TOPUP_SPIN : SlotStageType.TOPUP_SPIN_END);
        if (data.respinRemaining <= 0) {
            next = SlotStageType.TOPUP_SPIN_END;
        }
        this._pendingMatsuriNext = null;

        Log.e(`[Matsuri] flip done → next=${next} remain=${data.respinRemaining} total=${data.respinTotalWin}`);

        this._transitionStage(next);
        if (this._gameState !== GameState.POPUP) {
            this._gameState = GameState.IDLE;
        }
    }

    // ─── POT TRANSITION END: pot level transition animation hoàn tất ───

    /**
     * PotController emit POT_TRANSITION_END khi spine transition kết thúc.
     * Nếu _afterWinProcessed đã bị defer vì pot transition chưa xong → flush ngay.
     */
    private _onPotTransitionEnd(): void {
        this._logSpinState('POT_TRANSITION_END');
        this.unschedule(this._potTransitionEndFallback);
        this._isPotTransitioning = false;
        if (this._pendingAfterWinProcessed) {
            this._pendingAfterWinProcessed = false;
            this._logSpinState('POT_TRANSITION_END → flush pending _afterWinProcessed');
            this._afterWinProcessed();
        }
    }


    // ─── REEL STOPPED (per-reel): kiểm tra Wild → bay ngay lập tức ───

    /**
     * Gọi khi từng reel dừng xong. Nếu reel đó (1/2/3) có Wild → emit WILD_TRAIL_ONE
     * ngay lập tức để WildTrailController bắt đầu hiệu ứng bay cùng lúc reel dừng.
     */
    private _onReelStoppedWild(reelIndex: number | { reelIndex: number, result?: any }): void {
        const isObj = typeof reelIndex === 'object' && reelIndex != null;
        const idx = isObj ? (reelIndex as any).reelIndex : reelIndex as number;
        if (idx == null) return;

        // ★ TopUp / Matsuri: coin hiện ngay khi reel dừng — ko chờ REELS_STOPPED
        if ((GameData.instance.currentMode === 'respin' || GameData.instance.currentMode === 'matsuri') && isObj) {
            const result = (reelIndex as any).result;
            if (result) {
                if (
                    result.type === TopupReelType.RED ||
                    result.type === TopupReelType.YELLOW ||
                    result.type === TopupReelType.GREEN ||
                    result.type === TopupReelType.GRAND
                ) {
                    const landedSymbolId = result._symbolId ?? result.symbolId;
                    Log.d(`[TopUp-REEL-STOP] idx=${idx} YELLOW/GREEN sym=${SymbolId[landedSymbolId] ?? landedSymbolId} win=${result.win}`);
                    this._onTopUpReelCoinLanded(idx, result);
                } else if (result.type === TopupReelType.NONE) {
                    // ★ Check nếu strip tại index có PLUS_ONE_SPIN → hiện trên overlay
                    // PLUS_ONE_SPIN is resolved only after REELS_STOPPED from server remain delta.
                }
            }
            return;
        }

        if (!this._isSpinning) return;
        if (this._isFreeSpin()) return;

        const data = GameData.instance;
        const resp = data.lastSpinResponse;
        if (!resp) return;

        // ★ Carnival Neko Trail — mọi reel 0..4 đều có thể có Trail
        const carnivalHits = (resp.trails ?? []).filter((t: CarnivalTrailHit) => t.reel === idx);
        if (carnivalHits.length > 0 && !this._carnivalTrailReelsProcessed.has(idx)) {
            this._carnivalTrailReelsProcessed.add(idx);
            if (!this._carnivalTrailStartedThisSpin) {
                this._carnivalTrailStartedThisSpin = true;
                EventBus.instance.emit(GameEvents.CARNIVAL_TRAIL_START, {
                    trails: resp.trails ?? [],
                    potLevels: resp.potLevels,
                });
                if (resp.potLevels) {
                    data.potLevels = { ...resp.potLevels };
                    EventBus.instance.emit(GameEvents.CARNIVAL_POT_LEVELS_CHANGED, resp.potLevels);
                }
                this.unschedule(this._carnivalTrailFlyDoneFallback);
                this.scheduleOnce(this._carnivalTrailFlyDoneFallback, 3.5);
            }
            for (const hit of carnivalHits) {
                EventBus.instance.emit(GameEvents.CARNIVAL_TRAIL_ONE, hit);
            }
        }

        // Wild chỉ xuất hiện ở reel 1, 2, 3 (legacy GoF) — bỏ qua khi đang force Carnival Trail
        if (MOCK_FORCE_CARNIVAL_TRAILS || (resp.trails?.length ?? 0) > 0) return;
        if (idx < 1 || idx > 3) return;
        const slotMachines = this.node.scene?.getComponentsInChildren(SlotMachineController) ?? [];
        if (slotMachines.some((smc) => !smc.canRunPerReelEffects(idx))) {
            return;
        }
        if (this._wildTrailReelsProcessed.has(idx)) return;
        this._wildTrailReelsProcessed.add(idx);

        Log.d(`[WildTrail] _onReelStoppedWild: reel=${reelIndex} isSpinning=${this._isSpinning} gameState=${this._gameState}`);

        const grid = data.getBaseGrid(resp.rands, false, resp.reelIndex);
        const col  = grid[idx] ?? [];
        for (let row = 0; row < col.length; row++) {
            if (col[row] === SymbolId.WILD) {
                EventBus.instance.emit(GameEvents.WILD_TRAIL_ONE, { reel: idx, row });
            }
        }
    }

    // ─── REELS STOPPED → Evaluate Result ───

    /** Khi từng TopUp reel dừng và có coin mới → hiện ngay trên StickyOverlay */
    private _onTopUpReelCoinLanded(reelIdx: number, result: any): void {
        const data = GameData.instance;
        const rows = data.currentMode === 'matsuri'
            ? clampMatsuriRows(data.matsuriRows || 3)
            : 3;
        const reel = Math.floor(reelIdx / rows);
        const row  = reelIdx % rows;
        const key  = `${reel}-${row}`;

        // Nếu ô đã có sticky (RED/...) thì bỏ qua
        if (data.stickyCells.has(key)) {
            Log.d(`[TopUp-COIN-LAND] SKIP: ${key} already has ${SymbolId[data.stickyCells.get(key)!.symbolId]}`);
            return;
        }

        let symbolId: number | null = null;
        if (result.type === TopupReelType.RED) symbolId = SymbolId.STICKY_RED;
        else if (result.type === TopupReelType.YELLOW) symbolId = SymbolId.STICKY_YELLOW;
        else if (result.type === TopupReelType.GREEN) symbolId = SymbolId.STICKY_GREEN;
        else if (result.type === TopupReelType.GRAND) symbolId = SymbolId.JP_GRAND;
        else return;

        // ★ PLUS_ONE_SPIN không phải sticky coin — không thêm vào stickyCells.
        //    Effect +1 sẽ do TopUpAbsorbEffect._stepPlusOneSpin xử lý qua newCells.
        if (symbolId === SymbolId.PLUS_ONE_SPIN) {
            Log.e(`[TOPUP-PLUS] ignored per-reel +1 at ${key}; wait for server remain delta`);
            return;
        }

        // Matsuri: giữ Green trên stickyCells — StickyOverlay hiện xanh rồi flip sang Gold
        const isMatsuri = data.currentMode === 'matsuri';

        // TopUp Yellow/Green mới chưa absorb → credit = 0; Matsuri hiện credit ngay
        const isAbsorbCoin = !isMatsuri
            && (symbolId === SymbolId.STICKY_YELLOW || symbolId === SymbolId.STICKY_GREEN);
        const credit = isAbsorbCoin ? 0 : (result.win ?? 0);
        data.stickyCells.set(key, { reel, row, symbolId, credit });
        this._lockTopUpCell({ reel, row, symbolId, credit });
        Log.d(`[TopUp-COIN-LAND] ADD ${key} ${SymbolId[symbolId]} credit=${credit} matsuri=${isMatsuri ? 1 : 0}`);

        // ★ Đảm bảo TopUpReel tại index này được lock ngay — phòng trường hợp reel chưa block
        const topUpMgrs = this.node.scene?.getComponentsInChildren(TopUpManager) ?? [];
        for (const mgr of topUpMgrs) {
            const topUpReel = mgr.reels[reelIdx];
            if (!topUpReel) continue;
            if (isMatsuri) {
                // Matsuri: chỉ ẩn reel — Green/Gold hiện trên StickyOverlay
                topUpReel.blockInPlace();
                topUpReel.hideForOverlayResult();
            } else if (!topUpReel.isLocked) {
                const lockType = result.type ?? TopupReelType.NONE;
                if (lockType > 0) {
                    Log.e(`[TopUp-COIN-LAND] FORCE LOCK reel ${reelIdx} type=${lockType} credit=${credit}`);
                    topUpReel.applyStickyResult(lockType, credit);
                }
            }
        }

        // Matsuri Green: reveal trực tiếp trên overlay (trước collect/flip)
        if (isMatsuri && symbolId === SymbolId.STICKY_GREEN) {
            const overlay = this.node.scene?.getComponentInChildren(StickyOverlayController) ?? null;
            overlay?.revealMatsuriGreenCoin({ reel, row, credit });
            return;
        }

        // Refresh overlay ngay → coin hiện lần lượt theo reel stop
        EventBus.instance.emit(GameEvents.TOPUP_TOTAL_UPDATED, {
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
        });
    }

    private _getTopUpManagerCached(): TopUpManager | null {
        if (this._cachedTopUpMgr?.isValid) return this._cachedTopUpMgr;
        const overlay = this.node.scene?.getComponentInChildren(StickyOverlayController) ?? null;
        this._cachedTopUpMgr = overlay?.node?.getComponentInChildren(TopUpManager)
            ?? this.node.scene?.getComponentInChildren(TopUpManager)
            ?? null;
        return this._cachedTopUpMgr;
    }

    private _lockTopUpCell(cell: StickyCell): void {
        if (
            cell.symbolId !== SymbolId.STICKY_YELLOW &&
            cell.symbolId !== SymbolId.STICKY_GREEN &&
            cell.symbolId !== SymbolId.PLUS_ONE_SPIN
        ) {
            return;
        }

        const mgr = this._getTopUpManagerCached();
        if (mgr) {
            mgr.lockCellAt(cell.reel, cell.row, cell.symbolId, cell.credit ?? 0);
        }
    }

    private _onReelsStopped(): void {
        this.unschedule(this._reelsStoppedTimeout);
        this.unschedule(this._onReelsStopped); // clear any stale timer
        const data = GameData.instance;
        const resp = data.lastSpinResponse;
        this._logSpinState('REELS_STOPPED received');
        // Guard: nếu không đang spin → đây là REELS_STOPPED trùng lặp (timeout fired early
        // rồi reel thật mới dừng), bỏ qua hoàn toàn để không phá state đã xử lý xong.
        Log.e(`[GOLD-FLY][REELS_STOPPED] _isSpinning=${this._isSpinning} _gameState=${this._gameState} mode=${data.currentMode} processed=${this._reelsStoppedProcessed}`);
        if (!this._isSpinning) {
            this._logSpinState('REELS_STOPPED ignored because GameManager is not spinning');
            Log.e(`[GOLD-FLY][REELS_STOPPED] SKIP — not spinning`);
            return;
        }
        if (this._reelsStoppedProcessed) {
            this._logSpinState('REELS_STOPPED ignored because already processed');
            Log.e(`[GOLD-FLY][REELS_STOPPED] SKIP — already processed`);
            return;
        }
        if (!this._isTopUp() && !this._isMatsuri() && !this._areSlotReelsSettled()) {
            this._logSpinState('REELS_STOPPED ignored because slot reels are not settled yet');
            // Log.e('[SPIN-HANG][GM] REELS_STOPPED ignored — slot reels are not settled yet');
            this.scheduleOnce(this._reelsStoppedTimeout, 0.2);
            return;
        }
        this._reelsStoppedProcessed = true;
        this._logSpinState('REELS_STOPPED accepted');

        if (!resp) {
            this._isSpinning = false;
            this._gameState = GameState.IDLE;
            this._logSpinState('REELS_STOPPED no response, reset to IDLE');
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
            EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, { popupCase: PopupCase.DISCONNECTED });
            return;
        }

        this._gameState = GameState.RESULT;

        if (this._isMatsuri()) {
            this._handleMatsuriReelsStopped(resp);
            return;
        }

        if (this._isTopUp()) {
            this._handleTopUpReelsStopped(resp);
            return;
        }

        // ★ Gauge cập nhật ngay khi reel dừng (kể cả spin vào Feature Select), trước win presentation
        if (!this._isFreeSpin() && (resp.reelIndex ?? 0) === 0) {
            this._updateFeatureGauge(resp);
        }

        // Build grid string cho log (dùng lại ở các path bên dưới)
        const S: Record<number,string> = {
            [SymbolId.MINOR_Q]:'Q', [SymbolId.MINOR_K]:'K', [SymbolId.MINOR_A]:'A',
            [SymbolId.MAJOR_HORUS]:'Horus', [SymbolId.MAJOR_ANUBIS]:'Anubis',
            [SymbolId.MAJOR_SOBEK]:'Sobek', [SymbolId.MAJOR_RAMSES]:'Ramses',
            [SymbolId.MAJOR_CLEOPATRA]:'Cleo', [SymbolId.WILD]:'Wild',
            [SymbolId.STICKY_RED]:'Red', [SymbolId.STICKY_YELLOW]:'Yel',
            [SymbolId.STICKY_GREEN]:'Grn', [SymbolId.PLUS_ONE_SPIN]:'+1',
        };
        const isFS = this._isFreeSpin();
        // g[col][0]=top / [1]=mid / [2]=bot — logical order (server)
        const g = [0,1,2].map(c => data.getVisibleSymbols(c, resp.rands[c], isFS, resp.reelIndex).map(id => S[id]??`?${id}`));
        // gridStr dùng display order thực tế của ReelController để tránh đảo top/bot trong log client visual.
        const gD = [0,1,2].map(c => data.getDisplayVisibleSymbols(c, resp.rands[c], isFS, resp.reelIndex).map(id => S[id]??`?${id}`));
        const gridStr = `[${gD[0][0]}-${gD[1][0]}-${gD[2][0]}] [${gD[0][1]}-${gD[1][1]}-${gD[2][1]}] [${gD[0][2]}-${gD[1][2]}-${gD[2][2]}]`;

        // ═══ PURCHASE REEL COMPARISON LOG ═══
        // if (data.isPurchaseReelActive) {
        //     // So sánh kết quả khi dùng normalStrips vs purchaseStrips với cùng rands
        //     const normalStrips = data.config.reelStrips;
        //     const purchaseStrips = data.config.purchaseReelStrips;
        //     const fmtGrid = (strips: number[][]) => {
        //         return [0,1,2].map(c => {
        //             const strip = strips[c] ?? [];
        //             const len = strip.length;
        //             const center = ((resp.rands[c] % len) + len) % len;
        //             const top = strip[((center - 1) % len + len) % len];
        //             const mid = strip[center];
        //             const bot = strip[(center + 1) % len];
        //             return [S[bot]??`?${bot}`, S[mid]??`?${mid}`, S[top]??`?${top}`];
        //         });
        //     };
        //     const normalGrid = fmtGrid(normalStrips);
        //     const purchaseGrid = fmtGrid(purchaseStrips);
        //     Log.e(
        //         `%c[PURCHASE-COMPARE] ReelIndex=${resp.reelIndex} rands=[${resp.rands}]` +
        //         ` normalStripLens=[${normalStrips.map(s => s.length)}] purchaseStripLens=[${purchaseStrips.map(s => s.length)}]` +
        //         `\n  IF NORMAL:   [${normalGrid[0][0]}-${normalGrid[1][0]}-${normalGrid[2][0]}]` +
        //         ` [${normalGrid[0][1]}-${normalGrid[1][1]}-${normalGrid[2][1]}]` +
        //         ` [${normalGrid[0][2]}-${normalGrid[1][2]}-${normalGrid[2][2]}]` +
        //         `\n  IF PURCHASE: [${purchaseGrid[0][0]}-${purchaseGrid[1][0]}-${purchaseGrid[2][0]}]` +
        //         ` [${purchaseGrid[0][1]}-${purchaseGrid[1][1]}-${purchaseGrid[2][1]}]` +
        //         ` [${purchaseGrid[0][2]}-${purchaseGrid[1][2]}-${purchaseGrid[2][2]}]` +
        //         `\n  ACTUAL USED: [${gD[0][0]}-${gD[1][0]}-${gD[2][0]}]` +
        //         ` [${gD[0][1]}-${gD[1][1]}-${gD[2][1]}]` +
        //         ` [${gD[0][2]}-${gD[1][2]}-${gD[2][2]}]`,
        //         'color:#ff0;font-weight:bold;font-size:12px'
        //     );
        // }

        // ── GRID DEBUG LOG ────────────────────────────────────────────────────
        // gD[col][0]=visual-top / [1]=visual-mid / [2]=visual-bot (display order, reversed)
        const pad = (s: string) => s.padStart(4);
        Log.e(
            `[GRID-DEBUG] rands=[${resp.rands.join(', ')}]` +
            `\n  SERVER logical (top→bot)   : row0=${pad(g[0][0])} ${pad(g[1][0])} ${pad(g[2][0])}` +
            `\n                               row1=${pad(g[0][1])} ${pad(g[1][1])} ${pad(g[2][1])}` +
            `\n                               row2=${pad(g[0][2])} ${pad(g[1][2])} ${pad(g[2][2])}` +
            `\n  CLIENT display (top→bot)   : row0=${pad(gD[0][0])} ${pad(gD[1][0])} ${pad(gD[2][0])}` +
            `\n                               row1=${pad(gD[0][1])} ${pad(gD[1][1])} ${pad(gD[2][1])}` +
            `\n                               row2=${pad(gD[0][2])} ${pad(gD[1][2])} ${pad(gD[2][2])}`
        );
        // ─────────────────────────────────────────────────────────────────────

        // Check jackpot trước — jackpot KHÔNG áp dụng featureMultiple
        // Detect từ rawPsStrips (PS IDs gốc) cho cả real API lẫn mock.
        // Server KHÔNG trả winGrade='Grand' — jackpot phải detect từ symbols.
        const jackpot: JackpotType = this._detectJackpot(resp);
        if (jackpot !== JackpotType.NONE) {
            this._gameState = GameState.POPUP;
            // jackpotPrize: lấy từ API (Before / meter Wins) — không hardcode bet × multiplier.
            const jackpotPrize = data.getJackpotWinAmount(jackpot);
            const names: Record<number,string> = {1:'MINI',2:'MINOR',3:'MAJOR',4:'GRAND'};
            Log.e(`[GameManager] Jackpot ${names[jackpot] ?? jackpot} prize=${jackpotPrize} (from server Before/meter)`);

            if (this._isFreeSpin()) {
                // Trong free spin: tích lũy vào freeSpinTotalWin, KHÔNG cập nhật wallet ngay.
                // Wallet sẽ được cập nhật sau Claim (FREE_SPIN_END).
                if (resp.totalWin > 0) {
                    data.freeSpinTotalWin = truncateMoney3(data.freeSpinTotalWin + resp.totalWin);
                }
                // Đã giảm free spin counter khi nhấn Spin
                this._freeSpinActualCount++;
            } else {
                // Normal spin: cập nhật wallet ngay
                if (USE_REAL_API && resp.remainCash != null) {
                    WalletManager.instance.balance = resp.remainCash;
                } else {
                    WalletManager.instance.add(resp.totalWin);
                }
                EventBus.instance.emit(GameEvents.BALANCE_UPDATED, WalletManager.instance.balance);
            }

            // Delay jackpot popup nếu là long spin để player kịp thấy highlight
            // Trước khi delay: emit JACKPOT_REVEAL để SymbolHighlighter phát spine 3 symbol cùng lúc
            // Với mọi jackpot (kể cả không phải long spin) — để SymbolHighlighter có entries cho loop sau popup
            let jackpotPositions = this._longSpinHintPositions;
            if (jackpotPositions.length < 3) {
                jackpotPositions = this._getLongSpinHints(resp);
            }
            const revealDelay = this._hadLongSpin ? this.jackpotRevealDelay : 0;
            const popupDelay  = revealDelay + (this._hadLongSpin ? 0.5 : 0);
            if (jackpotPositions.length >= 3) {
                // Delay trước khi play animation 3 symbol cùng lúc — để player kịp thấy reel 3 dừng hẳn
                this.scheduleOnce(() => {
                    EventBus.instance.emit(GameEvents.LONG_SPIN_JACKPOT_REVEAL, jackpotPositions, jackpot);
                }, revealDelay);
            }
            this.scheduleOnce(() => {
                EventBus.instance.emit(GameEvents.JACKPOT_TRIGGER, jackpot, jackpotPrize);
                // Fallback: nếu không có JackpotPresenter thì tự complete sau 8s
                this.scheduleOnce(this._spinCycleFallback, 8.0);
            }, popupDelay);
            return;
        }

        // ── WILD TRAIL: tính từ grid thực tế, emit WILD_TRAIL_START nếu có WILD trên reel 1-3 ──
        const positions: Array<{ reel: number; row: number }> = [];
        const carnivalTrails = resp.trails ?? [];
        const hasCarnivalTrails = carnivalTrails.length > 0 && !this._isFreeSpin();

        if (!hasCarnivalTrails) {
            const grid = data.getBaseGrid(resp.rands, false, resp.reelIndex);
            for (let reel = 1; reel <= 3; reel++) {
                const col = grid[reel] ?? [];
                for (let row = 0; row < col.length; row++) {
                    if (col[row] === SymbolId.WILD) {
                        positions.push({ reel, row });
                    }
                }
            }
        }

        // ★ Carnival Pot levels (nếu chưa emit khi per-reel stop)
        if (hasCarnivalTrails && resp.potLevels) {
            data.potLevels = { ...resp.potLevels };
            if (!this._carnivalTrailStartedThisSpin) {
                this._carnivalTrailStartedThisSpin = true;
                EventBus.instance.emit(GameEvents.CARNIVAL_TRAIL_START, {
                    trails: carnivalTrails,
                    potLevels: resp.potLevels,
                });
                EventBus.instance.emit(GameEvents.CARNIVAL_POT_LEVELS_CHANGED, resp.potLevels);
                this.unschedule(this._carnivalTrailFlyDoneFallback);
                this.scheduleOnce(this._carnivalTrailFlyDoneFallback, 3.5);
            } else {
                EventBus.instance.emit(GameEvents.CARNIVAL_POT_LEVELS_CHANGED, resp.potLevels);
            }
        }

        // ★ POT LEVEL: dùng PotVisualLevel trực tiếp từ server (1..6) — legacy single pot
        let potLevelChanged = false;
        if (!hasCarnivalTrails && resp.potVisualLevel !== undefined && resp.potVisualLevel !== null && !this._isFreeSpin()) {
            const oldLevel = data.potLevel;
            const newLevel = Math.max(0, Math.min(6, resp.potVisualLevel as number));
            data.potLevel = newLevel;
            if (newLevel !== oldLevel) {
                potLevelChanged = true;
                this._isPotTransitioning = true;
                this.unschedule(this._potTransitionEndFallback);
                this.scheduleOnce(this._potTransitionEndFallback, GameManager.POT_TRANSITION_FALLBACK_SEC);
            }
        }

        if (potLevelChanged) {
            EventBus.instance.emit(GameEvents.POT_LEVEL_CHANGED, { level: data.potLevel, total: data.wildTrailCount ?? 0 });
        }

        if (positions.length > 0 && !this._isFreeSpin()) {
            EventBus.instance.emit(GameEvents.WILD_TRAIL_START, { positions, count: positions.length });
            this.unschedule(this._wildTrailFlyDoneFallback);
            this.scheduleOnce(this._wildTrailFlyDoneFallback, 2.0);
        }

        // Cộng tiền thắng khi reel dừng
        // Trong free spin: server trả updateCash=false → chỉ tích lũy freeSpinTotalWin,
        // KHÔNG cập nhật wallet ngay. Balance sẽ được cập nhật sau Claim (FREE_SPIN_END).
        if (resp.totalWin > 0) {
            if (this._isFreeSpin()) {
                // Chỉ tích lũy — KHÔNG cập nhật wallet
                GameData.instance.freeSpinTotalWin = truncateMoney3(GameData.instance.freeSpinTotalWin + resp.totalWin);
            } else {
                // Normal spin: cập nhật wallet ngay
                if (USE_REAL_API && resp.remainCash != null) {
                    WalletManager.instance.balance = resp.remainCash;
                } else {
                    WalletManager.instance.add(resp.totalWin);
                }
            }
        } else if (!this._isFreeSpin() && USE_REAL_API && resp.remainCash != null) {
            // Không thắng, không phải free spin: sync balance từ server (đã trừ bet)
            WalletManager.instance.balance = resp.remainCash;
        }
        // Đã giảm free spin counter khi nhấn Spin; chỉ đếm lượt đã qua ở đây
        if (this._isFreeSpin()) {
            this._freeSpinActualCount++;

            // FreeSpin Gold: phát hiện đồng xu vàng trên reel
            // NOTE: FREE_SPIN_GOLD_COUNT_UPDATED đã emit khi spin bắt đầu (freeSpinRemaining giảm)
            if (this._isFreespinGold()) {
                const data = GameData.instance;
                // Mỗi lượt quay: emit each win (tiền từ paylines)
                EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_EACH_WIN, resp.totalWin);
                // Đồng xu vàng trong FreeSpin = STICKY_YELLOW (PS ID 47), KHÔNG phải STICKY_RED (PS 41-46)
                // freeSpinReelStrips chứa PS 47 = Yellow Coin, server trả stickyCells với symbolId=STICKY_YELLOW
                const allCells = resp.stickyCells ?? [];
                Log.e(`[FreespinGold] stickyCells raw: [${allCells.map(c => `${SymbolId[c.symbolId]}@${c.reel}-${c.row}(cr=${c.credit})`).join(', ')}]`);
                const goldCells = allCells.filter(
                    (c: StickyCell) => c.symbolId === SymbolId.STICKY_YELLOW && (c.credit ?? 0) > 0
                );
                const newGoldCells = goldCells.filter((c: StickyCell) => !this._freeSpinGoldCountedKeys.has(`${c.reel}-${c.row}`));
                const duplicateGoldCells = goldCells.filter((c: StickyCell) => this._freeSpinGoldCountedKeys.has(`${c.reel}-${c.row}`));
                Log.e(`[FreespinGold] goldCells(YELLOW+credit>0): ${goldCells.length} — ${goldCells.map(c => `${c.reel}-${c.row}=$${c.credit}`).join(', ') || '(none)'}`);
                Log.e(`[FreespinGold] newGoldCells=${newGoldCells.length} duplicateGoldCells=${duplicateGoldCells.length} | new=[${newGoldCells.map(c => `${c.reel}-${c.row}=$${c.credit}`).join(', ') || 'none'}] dup=[${duplicateGoldCells.map(c => `${c.reel}-${c.row}=$${c.credit}`).join(', ') || 'none'}]`);
                if (goldCells.length > 0) {
                    const coinCredit = newGoldCells.reduce((sum: number, c: StickyCell) => sum + (c.credit ?? 0), 0);
                    if (newGoldCells.length > 0) {
                        data.freeSpinGoldTotalWin = truncateMoney3(data.freeSpinGoldTotalWin + coinCredit);
                        this._freeSpinGoldCoinTotal = truncateMoney3(this._freeSpinGoldCoinTotal + coinCredit);
                    }
                    // Cập nhật stickyCells với các đồng vàng mới land — SymbolView dùng để hiện credit label
                    for (const cell of goldCells) {
                        if (!this._freeSpinGoldCountedKeys.has(`${cell.reel}-${cell.row}`)) {
                            this._freeSpinGoldCountedKeys.add(`${cell.reel}-${cell.row}`);
                        }
                        data.stickyCells.set(`${cell.reel}-${cell.row}`, cell);
                    }
                    Log.e(`[GOLD-FLY][GOLD-EMIT] FREE_SPIN_GOLD_COIN_LAND visualCells=${goldCells.length} newCounted=${newGoldCells.length} coinCredit=${coinCredit} lineWinTotal=${data.freeSpinTotalWin} goldTotal=${data.freeSpinGoldTotalWin} _freeSpinGoldCoinTotal=${this._freeSpinGoldCoinTotal}`);
                    EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_COIN_LAND, { cells: goldCells });
                } else {
                    this.scheduleOnce(() => EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_COIN_LAND, { cells: [] }), 0);
                }
            }
        }

        // ── FreeSpin Gold: nếu có đồng xu vàng, defer WIN_PRESENT_START cho đến sau FLY_DONE ──
        // FreeSpinGoldCoinEffect sẽ emit FREE_SPIN_GOLD_FLY_DONE khi tất cả coin fly + bounce xong.
        // _onGoldFlyDone() sẽ nhận event đó và emit WIN_PRESENT_START với resp đã lưu.
        // Nếu không có đồng vàng, FreeSpinGoldCoinEffect._onCoinLand emit FLY_DONE ngay lập tức.
        if (this._isFreespinGold()) {
            this._pendingWinPresentResp = resp;
            // FallBack an toàn: nếu FLY_DONE không bao giờ đến (component chưa gắn vào scene),
            // tự emit sau khoảng thời gian tối đa để không treo game.
            const maxFlyWait = 0.5 + (resp.stickyCells?.filter((c: StickyCell) => c.symbolId === SymbolId.STICKY_YELLOW).length ?? 0) * this._goldFlyFallbackPerCoin + 2.5;
            this.scheduleOnce(this._goldFlyFallback, maxFlyWait);
            return;
        }

        // Nếu có wild trail / carnival trail: trì hoãn WIN_PRESENT_START đến khi FLY_DONE
        const _hasWildTrail = positions.length > 0 && !this._isFreeSpin();
        const _hasCarnivalTrail = hasCarnivalTrails;

        // Normal mode: nếu có red sticky symbols → đợi TẤT CẢ land zoom/bounce xong mới highlight
        const hasRedSticky = !this._isFreeSpin() && (resp.stickyCells?.some((c: StickyCell) => c.symbolId === SymbolId.STICKY_RED) ?? false);

        // Feature Select (6+ Red): defer WIN_PRESENT_START cho đến sau CREDIT_FLY_IN_DONE
        // để đảm bảo đồng vàng bay tới đích hết mới highlight line win
        const isFeatureSelect = resp.nextStage === SlotStageType.FEATURE_SELECT || resp.nextStage === SlotStageType.FEATURE_SELECT_START;

        this.unschedule(this._spinCycleFallback);
        const _fallbackDelay = (_hasWildTrail || _hasCarnivalTrail) ? 4.5 : 2.0;
        this.scheduleOnce(this._spinCycleFallback, _fallbackDelay);
        this._logSpinState(
            `post-REELS_STOPPED schedule spinCycleFallback=${_fallbackDelay}s` +
            ` wildTrail=${_hasWildTrail} carnivalTrail=${_hasCarnivalTrail} redSticky=${hasRedSticky} featureSelect=${isFeatureSelect}` +
            ` totalWin=${resp.totalWin} ways=${resp.waysPayWins?.length ?? 0} lines=${resp.matchedLinePays?.length ?? 0}`
        );

        if (_hasCarnivalTrail) {
            if (this._carnivalTrailFlyDoneReceivedThisSpin) {
                this._logSpinState('emit WIN_PRESENT_START via carnivalTrail already done');
                this._emitWinPresentAfterRedLandBounce(resp, hasRedSticky);
            } else {
                this._pendingWinPresentRespCarnival = resp;
                this._logSpinState('DEFER WIN_PRESENT_START — wait CARNIVAL_TRAIL_FLY_DONE');
            }
        } else if (_hasWildTrail) {
            // Defer WIN_PRESENT_START — sẽ được emit trong _onWildTrailFlyDoneCancelFallback khi particle hạ cánh
            // Vẫn phải chờ sticky red land-bounce xong (nếu có) trước khi highlight.
            if (this._wildTrailFlyDoneReceivedThisSpin) {
                this._logSpinState('emit WIN_PRESENT_START via wildTrail already done + redBounce gate');
                this._emitWinPresentAfterRedLandBounce(resp, hasRedSticky);
            } else {
                this._pendingWinPresentRespWild = resp;
                this._logSpinState('DEFER WIN_PRESENT_START — wait WILD_TRAIL_FLY_DONE');
            }
        } else if (isFeatureSelect) {
            const hasWin = ((resp.waysPayWins ?? []).length > 0) || resp.matchedLinePays.length > 0 || resp.totalWin > 0;
            if (hasWin) {
                // Có line win → highlight trước, credit fly sau khi highlight xong
                this._pendingFeatureSelectAfterHighlight = true;
                this.unschedule(this._spinCycleFallback);
                this.unschedule(this._featureSelectWinPresentationFallback);
                this.scheduleOnce(this._featureSelectWinPresentationFallback, 8.0);
                this._logSpinState('FEATURE_SELECT hasWin → emit WIN_PRESENT then credit fly');
                this._emitWinPresentAfterRedLandBounce(resp, hasRedSticky);
            } else {
                // Không có win → credit fly trước như cũ, WIN_PRESENT_START sau CREDIT_FLY_IN_DONE
                this._pendingWinPresentRespFeature = resp;
                // Không có highlight → đẩy nhanh vào feature select, không chờ fallback 2.0s
                const fsDelay = hasRedSticky ? 0.2 : 0.1;
                this._logSpinState(`FEATURE_SELECT noWin → _afterWinProcessed in ${fsDelay}s`);
                this.scheduleOnce(() => {
                    if (!this._isSpinning) return;
                    this._afterWinProcessed();
                }, fsDelay);
            }
        } else if (hasRedSticky) {
            this._logSpinState('emit WIN_PRESENT_START after red land bounce');
            this._emitWinPresentAfterRedLandBounce(resp, true);
        } else {
            // Luôn emit WIN_PRESENT_START để UI cập nhật label (cả win lẫn no-win)
            this._logSpinState('EMIT WIN_PRESENT_START immediate');
            EventBus.instance.emit(GameEvents.WIN_PRESENT_START, resp);
        }

        {
            const lines = resp.matchedLinePays;
            if (lines.length > 0 || resp.totalWin > 0) {
                const data = GameData.instance;
                const PS_NAME: Record<number,string> = {}; // GoF PS schema pending
                const fmtPs = (id: number) => PS_NAME[id] ?? `ps${id}`;
                const SYM_NAME: Record<number,string> = {
                    0:'Q',1:'K',2:'A',3:'Coin',4:'Ingot',5:'Ship',6:'Turtle',7:'Phx',
                    8:'Wild',9:'Red',10:'Yel',11:'Grn',12:'+1',
                    13:'IdleJP',14:'Mini',15:'Minor',16:'Major',17:'Grand',
                };
                const fmtCl = (id: number) => id < 0 ? '___' : (SYM_NAME[id] ?? `?${id}`);
                const modeName = (idx?: number) => idx === 2 ? 'Purchase' : (idx === 1 ? 'FreeSpin' : 'Normal');
                const fmtClientGrid = (strips: number[][], label: string) => {
                    const cols = [0, 1, 2].map((c) => {
                        const strip = strips[c] || [];
                        const len = strip.length;
                        if (len === 0) return ['EMPTY', 'EMPTY', 'EMPTY'];
                        const center = ((resp.rands[c] % len) + len) % len;
                        const logical = [
                            strip[((center - 1) % len + len) % len],
                            strip[center],
                            strip[(center + 1) % len],
                        ];
                        return [logical[2], logical[1], logical[0]].map(fmtCl);
                    });
                    return `${label}{len=${strips.map(s => s.length).join('/')}} ` +
                        `[${cols[0][0]}-${cols[1][0]}-${cols[2][0]}] ` +
                        `[${cols[0][1]}-${cols[1][1]}-${cols[2][1]}] ` +
                        `[${cols[0][2]}-${cols[1][2]}-${cols[2][2]}]`;
                };
                const fmtRawGrid = (strips: number[][], label: string) => {
                    const cols = [0, 1, 2].map((c) => {
                        const strip = strips[c] || [];
                        const len = strip.length;
                        if (len === 0) return ['EMPTY', 'EMPTY', 'EMPTY'];
                        const center = ((resp.rands[c] % len) + len) % len;
                        const logical = [
                            strip[((center - 1) % len + len) % len],
                            strip[center],
                            strip[(center + 1) % len],
                        ];
                        return [logical[2], logical[1], logical[0]].map(fmtPs);
                    });
                    return `${label}{len=${strips.map(s => s.length).join('/')}} ` +
                        `[${cols[0][0]}-${cols[1][0]}-${cols[2][0]}] ` +
                        `[${cols[0][1]}-${cols[1][1]}-${cols[2][1]}] ` +
                        `[${cols[0][2]}-${cols[1][2]}-${cols[2][2]}]`;
                };

                Log.e(
                    `[SPIN SERVER SNAPSHOT] mode=${modeName(resp.reelIndex)} ReelIndex=${resp.reelIndex ?? 'undefined'}` +
                    ` isFS=${isFS} purchaseActive=${data.isPurchaseReelActive}` +
                    ` rands=${JSON.stringify(resp.rands)} totalWin=${resp.totalWin} lines=${lines.length}\n` +
                    `  CLIENT Normal   ${fmtClientGrid(data.config.reelStrips, 'Reel')}\n` +
                    `  CLIENT FreeSpin ${fmtClientGrid(data.config.freeSpinReelStrips, 'FreeSpinReel')}\n` +
                    `  CLIENT Purchase ${fmtClientGrid(data.config.purchaseReelStrips, 'PurchaseReel')}\n` +
                    `  RAW    Normal   ${fmtRawGrid(data.rawPsStrips, 'Reel')}\n` +
                    `  RAW    FreeSpin ${fmtRawGrid(data.rawPsFreeSpinStrips, 'FreeSpinReel')}\n` +
                    `  RAW    Purchase ${fmtRawGrid(data.rawPsPurchaseReelStrips, 'PurchaseReel')}`
                );

                // Chi tiết từng line thắng
                const lineDetails = lines.map((l: any) => {
                    const payLineIdx = l.payLineIndex;
                    const payline = data.config.paylines[payLineIdx] || [1, 1, 1];  // [row0, row1, row2]
                    const rawRands = resp.rands;  // [rand0, rand1, rand2]
                    const rawStrips = data.getRawPsStrips(isFS, resp.reelIndex);

                    // Lấy 3 symbol thực tế (server gốc) từ payline + rands
                    // step=1 no snap — khớp với visual đang hiển thị
                    const paylineSymbols: number[] = [];
                    for (let c = 0; c < 3; c++) {
                        const row = payline[c];  // row index (0=top, 1=mid, 2=bot)
                        const rand = rawRands[c];
                        const strip = rawStrips[c] || [];
                        const len = strip.length;
                        const centerIdx = ((rand % len) + len) % len;
                        // row 0=top(center-1), row 1=mid(center), row 2=bot(center+1)
                        const symbolIdx = ((centerIdx + (row - 1)) % len + len) % len;
                        paylineSymbols.push(strip[symbolIdx] ?? 99);
                    }

                    const psSyms = paylineSymbols.map(fmtPs).join('-');
                    const clSyms = paylineSymbols.map((psId: number) => fmtCl(data.psToClientMap[psId] ?? -1)).join('-');

                    // Detect win type từ payline symbols
                    let winType = 'Normal';
                    const sevenIds = [12, 13, 14];
                    const barIds = [2, 3];
                    const wildIds = [21, 22, 23];

                    if (paylineSymbols.some((id: number) => wildIds.includes(id))) {
                        winType = 'Wild';
                    } else if (paylineSymbols.every((id: number) => sevenIds.includes(id))) {
                        winType = paylineSymbols[0] === paylineSymbols[1] && paylineSymbols[1] === paylineSymbols[2] ? '777' : 'Any-7';
                    } else if (paylineSymbols.every((id: number) => barIds.includes(id))) {
                        winType = paylineSymbols[0] === paylineSymbols[1] && paylineSymbols[1] === paylineSymbols[2] ? 'BAR×3' : 'Any-Bar';
                    } else if (paylineSymbols.includes(98)) {
                        winType = 'Scatter';
                    }

                    // So sánh với matchedSymbols từ server (giúp verify logic detect)
                    const matched = (l.matchedSymbols || []).map(fmtPs).join('-');
                    const matchedCL = (l.matchedSymbols || []).map((psId: number) => fmtCl(data.psToClientMap[psId] ?? -1)).join('-');

                    const serverCells = l.matchedSymbolsIndices
                        ? l.matchedSymbolsIndices.map((p: any) => `c${p.Item1}r${p.Item2}->displayR${data.toDisplayRow(p.Item2)}`).join(',')
                        : 'null(fallback payline)';

                    return `[Line${payLineIdx}] rows=[${payline.join('-')}] serverCells=[${serverCells}] Payline: ${psSyms}(${clSyms}) | Matched: ${matched}(${matchedCL}) | ${winType} | +$${l.payout.toFixed(2)}`;
                }).join('\n  ');

                let detail = `💰 WIN +$${resp.totalWin.toFixed(2)}`;
                if (lines.length > 0) detail += ` (${lines.length}L)`;
                if (resp.featureMultiple && resp.featureMultiple > 1) detail += ` ×${resp.featureMultiple}`;
                // (Fallback đã được schedule ở trên, trước WIN_PRESENT_START)
            }
        }
    }

    // ─── SAU KHI WIN PRESENTATION XONG ───

    /**
     * Đợi tất cả Sticky đỏ land-bounce (zoom) xong rồi mới emit WIN_PRESENT_START.
     * Tránh highlight chạy song song với zoom của coin đỏ vừa land.
     */
    private _emitWinPresentAfterRedLandBounce(resp: SpinResponse, waitForRed: boolean): void {
        const emitHighlight = () => {
            if (!this._isSpinning) {
                this._logSpinState('redBounce emitHighlight SKIP — not spinning');
                return;
            }
            SymbolView.logLandBounceParentState('pre-highlight');
            SymbolView.ensureRedLandBouncesRestored();
            SymbolView.restoreAllLandBounces();
            SymbolView.logLandBounceParentState('pre-WIN_PRESENT_START');
            this._logSpinState(`EMIT WIN_PRESENT_START (after redBounce wait=${waitForRed})`);
            EventBus.instance.emit(GameEvents.WIN_PRESENT_START, resp);
        };

        if (!waitForRed) {
            emitHighlight();
            return;
        }

        // Đánh dấu toàn bộ reel đã dừng — từ đây mới check bounce đỏ settled
        SymbolView.markRedLandBounceSessionReady();
        Log.e(`[LB-DEBUG] wait-highlight ${SymbolView.getRedLandBounceDebugSummary()}`);

        let done = false;
        const finish = (force = false) => {
            if (done || !this._isSpinning) return;
            if (!force && !SymbolView.areAllRedLandBouncesSettled()) return;
            done = true;
            this.unschedule(fallback);
            this.unschedule(poll);
            EventBus.instance.off(GameEvents.STICKY_RED_LAND_BOUNCE_DONE, onBounceDone, this);
            emitHighlight();
        };
        const onBounceDone = () => finish(false);
        const poll = () => finish(false);
        const fallback = () => {
            Log.e('[LB-DEBUG] wait-highlight FALLBACK — force cleanup + emit');
            SymbolView.ensureRedLandBouncesRestored();
            SymbolView.restoreAllLandBounces();
            finish(true);
        };

        // Chờ reel cuối settle + kick land-bounce trước khi kiểm tra counter/clone
        this.scheduleOnce(() => {
            if (!this._isSpinning) return;
            EventBus.instance.on(GameEvents.STICKY_RED_LAND_BOUNCE_DONE, onBounceDone, this);
            this.schedule(poll, 0.05);
            this.scheduleOnce(fallback, SymbolView.getLandBounceDuration() + 0.5);
            finish(false);
        }, 0.08);
    }

    /** Tất cả đồng xu vàng đã fly + bounce xong → phát WIN_PRESENT_START đã bị defer */
    private _onGoldFlyDone(): void {
        this.unschedule(this._goldFlyFallback);
        const resp = this._pendingWinPresentResp;
        this._pendingWinPresentResp = null;
        if (!resp) return;
        // Schedule fallback (giống flow thường, nhưng sau thời gian fly)
        const hasWin = resp.matchedLinePays.length > 0 || resp.totalWin > 0;
        if (hasWin) {
            this.unschedule(this._spinCycleFallback);
            this.scheduleOnce(this._spinCycleFallback, 2.0);
        }
        EventBus.instance.emit(GameEvents.WIN_PRESENT_START, resp);
    }

    private _onWinPresentEnd(): void {
        this._logSpinState('WIN_PRESENT_END received → check progressive then _afterWinProcessed');
        this.unschedule(this._spinCycleFallback);
        if (this._pendingFeatureSelectAfterHighlight) {
            this.unschedule(this._featureSelectWinPresentationFallback);
            this._logSpinState('WIN_PRESENT_END → featureSelect after highlight path');
            this._checkProgressiveWin(() => {
                this._afterWinProcessed();
                this.scheduleOnce(() => this._startFeatureSelectCreditFly('WIN_PRESENT_END'), 0);
            });
            return;
        }
        this._checkProgressiveWin(() => {
            this._afterWinProcessed();
        });
    }

    private _onJackpotEnd(): void {
        Log.e(`[DEBUG-PICK] _onJackpotEnd ENTER — stage=${this._currentStage}, gameState=${this._gameState}`);

        // Resume path: jackpot popup vừa đóng sau khi resume → tiếp tục resume flow
        if (this._pendingResumeAfterJackpot) {
            const resume = this._pendingResumeAfterJackpot;
            this._pendingResumeAfterJackpot = null;
            this._executeResume(resume);
            return;
        }

        this._gameState = GameState.RESULT;
        const resp = GameData.instance.lastSpinResponse;

        // ★ Pick Game flow: sau JACKPOT_END, emit PICK_GAME_CLOSE để reset state
        // KHÔNG check progressive win ngay - ProgressiveWin sẽ được check sau khi PICK_GAME_CLOSE
        if (this._currentStage === SlotStageType.PICK_END || this._currentStage === SlotStageType.PICK || this._currentStage === SlotStageType.POT_WIN) {
            Log.e(`[DEBUG-PICK] _onJackpotEnd → Pick Game flow detected (stage=${this._currentStage}) → emit PICK_GAME_CLOSE`);
            EventBus.instance.emit(GameEvents.PICK_GAME_CLOSE);
            // Sau PICK_GAME_CLOSE, progressive win sẽ được check trong _onPickGameClose nếu cần
            return;
        }
        Log.e(`[DEBUG-PICK] _onJackpotEnd → NOT Pick Game flow, stage=${this._currentStage}`);

        if (this._isFreeSpin()) {
            // Trong free spin: sau jackpot popup đóng, hiện WIN animation trước rồi mới auto-spin.
            // Emit WIN_PRESENT_START để UIController highlight symbol và animate tổng tiền tích lũy.
            // KHÔNG gọi _afterWinProcessed() ngay — chờ WIN_PRESENT_END để highlight xong rồi mới spin tiếp.
            if (resp) {
                EventBus.instance.emit(GameEvents.WIN_PRESENT_START, resp);
                // Fallback nếu WinPresenter không emit WIN_PRESENT_END (ví dụ: totalWin=0)
                if (resp.totalWin > 0 || resp.matchedLinePays.length > 0) {
                    this.unschedule(this._spinCycleFallback);
                    this.scheduleOnce(this._spinCycleFallback, 3.0);
                } else {
                    this._afterWinProcessed();
                }
            } else {
                this._afterWinProcessed();
            }
            return;
        }

        // Sau jackpot popup (Normal spin): kiểm tra progressive win.
        // Real API: thử winGrade trước; nếu là jackpot-grade (grand/major/minor/mini) hoặc null
        //           → fallback tính từ ratio totalWin / totalBet để không bỏ sót.
        // Lý do: server có thể không gửi winGrade riêng cho progressive khi trúng jackpot.
        if (resp && resp.totalWin > 0) {
            let tier: ProgressiveWinTier | null = null;
            if (resp.winGrade) {
                tier = this._winGradeToTier(resp.winGrade);
            }
            if (!tier) {
                // fallback: tính từ ratio (dùng cả real API lẫn mock)
                tier = this._getProgressiveTierFromRatio(resp.totalWin, BetManager.instance.totalBet);
            }
            if (tier) {
                this._gameState = GameState.POPUP;
                Log.e(`[DEBUG-PICK] _onJackpotEnd EMIT PROGRESSIVE_WIN_SHOW — tier=${tier}, amount=${resp.totalWin}`);
                EventBus.instance.emit(GameEvents.PROGRESSIVE_WIN_SHOW, tier, resp.totalWin);
                return; // PROGRESSIVE_WIN_END → _onProgressiveWinEnd → _afterWinProcessed
            }
        }
        this._afterWinProcessed();
    }

    /** Progressive Win đóng xong → tiếp tục flow */
    private _onProgressiveWinEnd(): void {
        this._logSpinState('PROGRESSIVE_WIN_END received');
        if (this._isSpinning) {
            // Normal spin path: _afterWinProcessed chưa chạy → để nó hoàn tất cycle
            this._gameState = GameState.RESULT;
            this._afterWinProcessed();
        } else {
            // FreeSpinEnd path hoặc fallback đã clear _isSpinning → reset trực tiếp
            this._gameState = GameState.IDLE;
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);

            // BUG FIX: AutoSpin vẫn còn count sau khi free spin kết thúc.
            // AutoSpinManager._onFreeSpinEnd() đã emit SPIN_REQUEST 300ms sau FREE_SPIN_END,
            // nhưng lúc đó GameState=POPUP (ProgressiveWinPopup đang hiện) nên bị block và mất.
            // → Phải re-trigger SPIN_REQUEST tại đây khi popup đóng và state đã về IDLE.
            if (AutoSpinManager.instance.isAutoSpinActive && AutoSpinManager.instance.autoSpinCount > 0) {
                this.scheduleOnce(() => {
                    EventBus.instance.emit(GameEvents.SPIN_REQUEST);
                }, 0.3);
            }
        }
    }

    /**
     * POT_WIN_DONE / Carnival Jackpot: hiện JackpotStartPopup (Press to Start)
     * thay TransitionPopup. Sau khi đóng → PICK_GAME_OPEN.
     */
    private _onPotWinDone(): void {
        Log.e('[DEBUG-PICK] _onPotWinDone ENTER → JackpotStartPopup');
        const data = GameData.instance;
        const resp = data.lastSpinResponse;

        let pickState: PickGameState | undefined = resp?.pickGame;
        if (!pickState) {
            pickState = MockDataProvider.buildPickGame();
            Log.d('[POT-DEBUG] resp.pickGame missing → built mock PickGameState');
        }
        data.pickGameState = pickState;
        if (resp) (resp as any).pickGame = pickState;

        this._showJackpotStartPopupThenEnter(pickState);
    }

    /** Stash PickGame đang chờ Press to Start. */
    private _pendingJackpotStartPick: PickGameState | null = null;

    private _showJackpotStartPopupThenEnter(pickState: PickGameState): void {
        this._pendingJackpotStartPick = pickState;
        this._gameState = GameState.POPUP;
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
        EventBus.instance.emit(GameEvents.WIN_HIGHLIGHT_CLEAR);
        Log.e('[GameManager] PICK_GAME_START_POPUP → PRESS TO START');
        EventBus.instance.emit(GameEvents.PICK_GAME_START_POPUP, pickState);
        this.unschedule(this._jackpotStartPopupFailsafe);
        this.scheduleOnce(this._jackpotStartPopupFailsafe, 25.0);
    }

    private _jackpotStartPopupFailsafe = (): void => {
        if (!this._pendingJackpotStartPick) return;
        Log.w('[GameManager] Jackpot start popup failsafe — enter Pick Game');
        this._onJackpotStartPopupClosed(this._pendingJackpotStartPick);
    };

    private _onJackpotStartPopupClosed(pickState?: PickGameState | null): void {
        this.unschedule(this._jackpotStartPopupFailsafe);
        const pick = pickState ?? this._pendingJackpotStartPick
            ?? GameData.instance.pickGameState
            ?? MockDataProvider.buildPickGame();
        this._pendingJackpotStartPick = null;
        this._openPickGameNow(pick);
    }

    /** Mở PickGamePopup thật sự (sau Press to Start / resume). */
    private _openPickGameNow(pickState: PickGameState): void {
        Log.e('[DEBUG-PICK] _openPickGameNow → PICK_GAME_OPEN');
        this._isPickGameActive = true;
        this._pickGameBgPending = true;
        this._gameState = GameState.POPUP;
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
        EventBus.instance.emit(GameEvents.WIN_HIGHLIGHT_CLEAR);
        EventBus.instance.emit(GameEvents.PICK_GAME_OPEN, pickState);
        // Không còn TransitionPopup — đổi BG Pick ngay khi entry
        this.scheduleOnce(() => this._applyPickGameBackgroundIfPending(), 0);
    }

    /**
     * PICK_GAME_NEED_CLAIM: server tr\u1ea3 NextStage=PICK_END(102) sau l\u1ea7n Pick tr\u00fang jackpot.
     * G\u1ecdi /Claim \u0111\u1ec3 ch\u1ed1t s\u1ed5 v\u00e0 c\u1eadp nh\u1eadt balance. Ch\u1ec9 th\u1ef1c hi\u1ec7n khi USE_REAL_API=true.
     */
    private async _onPickGameNeedClaim(): Promise<void> {
        if (!USE_REAL_API) return;
        Log.d('[GameManager] PICK_GAME_NEED_CLAIM → _handleClaim()');
        await this._handleClaim();
        const data = GameData.instance;
        if (data.pickGameWinAmount <= 0 && data.freeSpinTotalWin > 0) {
            data.pickGameWinAmount = data.freeSpinTotalWin;
            Log.d(`[GameManager] PICK_GAME_NEED_CLAIM cached pickGameWinAmount=${data.pickGameWinAmount} from Claim WinCash`);
        }
    }

    /**
     * TOPUP_TRANSITION_READY: overlay đã fade-in full → mới đổi UI mode.
     * FeatureSelect / trước fade-in: UI vẫn giữ nguyên Normal.
     */
    private _onTopUpTransitionReady(mode?: TransitionMode): void {
        if (mode === TransitionMode.TopUp && this._pendingTopUpPrepareCount != null) {
            const count = this._pendingTopUpPrepareCount;
            this._pendingTopUpPrepareCount = null;
            void this._prepareTopUpUI(count);
        } else if (mode === TransitionMode.FreeSpin && this._pendingFreespinPrepareCount != null) {
            const count = this._pendingFreespinPrepareCount;
            this._pendingFreespinPrepareCount = null;
            this._prepareFreespinGoldUI(count);
        }

        if (mode === TransitionMode.PickGame || this._isPickGameActive) {
            this._applyPickGameBackgroundIfPending();
        }
    }

    /**
     * TOPUP_TRANSITION_DONE: fallback đổi BG Pick Game nếu READY bị miss.
     */
    private _onTopUpTransitionDone(): void {
        if (!this._isPickGameActive) return;
        this._applyPickGameBackgroundIfPending();
    }

    /** Fallback khi bỏ qua transition (useTopUpTransition=false). */
    private _onPickGameEntryDone(): void {
        if (!this._isPickGameActive) return;
        this._applyPickGameBackgroundIfPending();
    }

    private _applyPickGameBackgroundIfPending(): void {
        if (!this._pickGameBgPending) return;
        this._pickGameBgPending = false;
        this._updateBackgroundSprite();
        Log.d('[GameManager] Pick Game background updated under TransitionPopup');
    }

    /**
     * PICK_GAME_CLOSE: PickGamePopup đóng xong.
     * Reset pot counter + restore game state (POPUP → IDLE), re-enable spin button.
     * Sau đó check progressive win nếu có.
     */
    private _onPickGameClose(): void {
        Log.e(`[DEBUG-PICK] _onPickGameClose ENTER — checking progressive win now`);
        this._isPickGameActive = false;
        this._pickGameBgPending = false;
        this._updateBackgroundSprite();
        const data = GameData.instance;
        data.wildTrailCount = 0;
        data.potLevel       = 1;
        this._resetFeatureGauge();
        EventBus.instance.emit(GameEvents.POT_LEVEL_CHANGED, { level: 1, total: 0 });
        // Restore game state bị block bởi _transitionStage(POT_WIN)
        this._gameState = GameState.IDLE;
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);

        // Legacy: Pick-first → Matsuri (không còn dùng cho Ultra+ API V1.0.2)
        const pendingMatsuri = GameData.instance.pendingCarnivalMatsuri;
        if (pendingMatsuri && pendingMatsuri.matsuriRows > 0) {
            GameData.instance.pendingCarnivalMatsuri = null;
            Log.e(`[DEBUG-PICK] _onPickGameClose → Matsuri start popup "${pendingMatsuri.featureName}"`);
            this._showMatsuriStartPopupThenEnter(pendingMatsuri);
            return;
        }

        // ★ Nếu có pending Free Spin end (từ _handleClaim trong Pick Game), xử lý trước
        if (this._pendingFreeSpinEnd) {
            Log.e(`[DEBUG-PICK] _onPickGameClose → pending free spin end detected`);
            this._pendingFreeSpinEnd = false;
            if (data.freeSpinTotalWin > 0) {
                this._checkProgressiveWinForFeatureEnd(data.freeSpinTotalWin);
            }
            return;
        }

        // ★ Check progressive win sau khi Pick Game đóng xong
        // Dùng pickGameWinAmount (jackpot prize) thay vì lastSpinResponse.totalWin
        const pickWin = GameData.instance.pickGameWinAmount;
        const spinResp = GameData.instance.lastSpinResponse;
        const totalWin = pickWin > 0 ? pickWin : (spinResp?.totalWin ?? 0);
        if (totalWin > 0) {
            let tier: ProgressiveWinTier | null = null;
            if (spinResp?.winGrade) {
                tier = this._winGradeToTier(spinResp.winGrade);
            }
            if (!tier) {
                tier = this._getProgressiveTierFromRatio(totalWin, BetManager.instance.totalBet);
            }
            if (tier) {
                this._gameState = GameState.POPUP;
                Log.e(`[DEBUG-PICK] _onPickGameClose EMIT PROGRESSIVE_WIN_SHOW — tier=${tier}, amount=${totalWin}`);
                EventBus.instance.emit(GameEvents.PROGRESSIVE_WIN_SHOW, tier, totalWin);
                return; // PROGRESSIVE_WIN_END → _onProgressiveWinEnd → _afterWinProcessed
            }
        }

        // Notify AutoSpinManager để có thể tiếp tục auto spin
        if (!this._isFreeSpin()) {
            EventBus.instance.emit(GameEvents.NORMAL_SPIN_DONE);
        }
    }

    /** FreeSpinEndPopup đóng xong → emit FREE_SPIN_END thật sự + check progressive win */
    private _onFreeSpinEndPopupClosed(): void {
        const data = GameData.instance;
        const totalWin = data.freeSpinTotalWin;

        // Mock mode: cộng tổng tiền free spin vào balance ngay tại đây.
        // Real API: balance đã được sync từ server trong _handleClaim() trước khi popup hiện.
        // ★ Nếu freeSpinTotalWin được restore từ server (resume), MockNetworkAdapter.sendClaimRequest
        //   đã xử lý đúng balance rồi — không add thêm ở đây nữa.
        if (!USE_REAL_API && totalWin > 0 && !data.freeSpinTotalWinRestoredFromServer) {
            WalletManager.instance.add(totalWin);
        }

        // Reset state về normal TRƯỚC emit — đảm bảo listeners thấy đúng mode
        data.freeSpinRemaining = 0;
        data.freeSpinTotalWin = 0;
        data.freeSpinTotalWinRestoredFromServer = false;
        data.isResumingFreeSpin = false;
        this._currentStage = SlotStageType.SPIN;
        this._gameState = GameState.IDLE;
        this._resetFeatureGauge();

        EventBus.instance.emit(GameEvents.FREE_SPIN_END, totalWin);

        // Check progressive win cho tổng tiền free spin
        let tier: ProgressiveWinTier | null = null;
        if (USE_REAL_API) {
            // Real API: thử WinGrade từ ClaimResponse trước.
            // Nếu null (server không gửi) → fallback tính từ ratio để không bỏ sót.
            const claimGrade = GameData.instance.lastClaimWinGrade;
            tier = claimGrade ? this._winGradeToTier(claimGrade) : null;
            GameData.instance.lastClaimWinGrade = undefined; // reset sau khi dùng
            if (!tier) {
                tier = this._getProgressiveTierFromRatio(totalWin, BetManager.instance.totalBet);
            }
        } else {
            // Mock / cheat mode: tính từ ratio
            tier = this._getProgressiveTierFromRatio(totalWin, BetManager.instance.totalBet);
        }
        if (tier) {
            this._gameState = GameState.POPUP;
            Log.e(`[DEBUG-PICK] _checkProgressiveWinForFeatureEnd EMIT — tier=${tier}, amount=${totalWin}`);
            EventBus.instance.emit(GameEvents.PROGRESSIVE_WIN_SHOW, tier, totalWin);
            // PROGRESSIVE_WIN_END → _onProgressiveWinEnd sẽ tiếp tục
        } else {
            // Không có progressive win → enable spin button ngay
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
        }
    }

    /**
     * Kiểm tra ngưỡng Progressive Win sau khi spin xong.
     * KHÔNG check nếu là vòng free spin (tích lũy đến cuối mới check tổng).
     */
    private _checkProgressiveWin(onNone: () => void): void {
        const data = GameData.instance;
        const resp = data.lastSpinResponse;
        this._logSpinState(`_checkProgressiveWin ENTER totalWin=${resp?.totalWin ?? 'null'}`);
        if (!resp || resp.totalWin <= 0) {
            this._logSpinState('_checkProgressiveWin SKIP — no win → continue');
            onNone();
            return;
        }

        // Trong free spin, Pick Game, hoặc vừa kết thúc feature:
        // KHÔNG hiện progressive each round, chờ đến cuối feature.
        if (this._isFreeSpin() ||
            this._currentStage === SlotStageType.FREE_SPIN_END ||
            this._currentStage === SlotStageType.BUY_FREE_SPIN_END ||
            this._currentStage === SlotStageType.POT_WIN ||
            this._currentStage === SlotStageType.PICK ||
            this._currentStage === SlotStageType.PICK_END) {
            this._logSpinState(`_checkProgressiveWin SKIP — feature/pick stage=${this._currentStage}`);
            onNone();
            return;
        }

        let tier: ProgressiveWinTier | null = null;
        if (USE_REAL_API) {
            // Real API: thử winGrade từ server trước; fallback ratio nếu null.
            const grade = resp.winGrade;
            tier = grade ? this._winGradeToTier(grade) : null;
            if (!tier) {
                tier = this._getProgressiveTierFromRatio(resp.totalWin, BetManager.instance.totalBet);
            }
        } else {
            // Mock / cheat mode: tính từ ratio totalWin / totalBet.
            tier = this._getProgressiveTierFromRatio(resp.totalWin, BetManager.instance.totalBet);
        }
        if (!tier) {
            this._logSpinState('_checkProgressiveWin no tier → continue _afterWinProcessed');
            onNone();
            return;
        }

        this._logSpinState(`_checkProgressiveWin OPEN POPUP tier=${tier} amount=${resp.totalWin} — wait PROGRESSIVE_WIN_END`);
        this._gameState = GameState.POPUP;
        EventBus.instance.emit(GameEvents.PROGRESSIVE_WIN_SHOW, tier, resp.totalWin);
        // PROGRESSIVE_WIN_END → _onProgressiveWinEnd → onNone đã được gọi từ đó riêng
    }

    /**
     * Kiểm tra Progressive Win sau khi feature kết thúc (FreeSpin/TopUp).
     * Dùng winGrade từ ClaimResponse nếu có; fallback tính từ ratio.
     */
    private _checkProgressiveWinForFeatureEnd(totalWin: number): void {
        Log.e(`[DEBUG-PICK] _checkProgressiveWinForFeatureEnd ENTER — totalWin=${totalWin}, stage=${this._currentStage}, caller=${new Error().stack?.split('\n')[2]?.trim() ?? 'unknown'}`);
        if (totalWin <= 0) {
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
            return;
        }
        let tier: ProgressiveWinTier | null = null;
        if (USE_REAL_API) {
            const claimGrade = GameData.instance.lastClaimWinGrade;
            tier = claimGrade ? this._winGradeToTier(claimGrade) : null;
            Log.d(`[GameManager] _checkProgressiveWinForFeatureEnd REAL_API — claimWinGrade="${claimGrade}" mappedTier=${tier ?? 'null'} totalWin=${totalWin}`);
            GameData.instance.lastClaimWinGrade = undefined;
            if (!tier) {
                tier = this._getProgressiveTierFromRatio(totalWin, BetManager.instance.totalBet);
                Log.d(`[GameManager] _checkProgressiveWinForFeatureEnd REAL_API — fallback ratio tier=${tier ?? 'null'}`);
            }
        } else {
            tier = this._getProgressiveTierFromRatio(totalWin, BetManager.instance.totalBet);
        }
        if (tier) {
            this._gameState = GameState.POPUP;
            Log.e(`[DEBUG-PICK] _checkProgressiveWinForFeatureEnd EMIT-2 — tier=${tier}, amount=${totalWin}`);
            EventBus.instance.emit(GameEvents.PROGRESSIVE_WIN_SHOW, tier, totalWin);
        } else {
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
        }
    }

    /** Map server winGrade string → ProgressiveWinTier */
    private _winGradeToTier(winGrade: string): ProgressiveWinTier | null {
        switch (winGrade.toLowerCase()) {
            case 'max':     return ProgressiveWinTier.MAX;
            case 'monster': return ProgressiveWinTier.MONSTER;
            case 'ultra':   return ProgressiveWinTier.ULTRA;
            case 'epic':    return ProgressiveWinTier.EPIC;
            case 'super':   return ProgressiveWinTier.SUPER;
            case 'major':   return ProgressiveWinTier.MAJOR;
            case 'mega':    return ProgressiveWinTier.MEGA;
            case 'big':     return ProgressiveWinTier.BIG;
            default:        return null; // "Normal", "Grand", "Minor", "Mini" = không hiện popup
        }
    }

    /** Map server winGrade string → JackpotType (cho real API jackpot detection) */
    private _winGradeToJackpotType(winGrade?: string): JackpotType {
        if (!winGrade) return JackpotType.NONE;
        switch (winGrade.toLowerCase()) {
            case 'grand': return JackpotType.GRAND;
            case 'major': return JackpotType.MAJOR;
            case 'minor': return JackpotType.MINOR;
            case 'mini':  return JackpotType.MINI;
            default:      return JackpotType.NONE; // 'Invalid', 'Normal', ''
        }
    }

    private _getProgressiveTier(win: number, totalBet: number): ProgressiveWinTier | null {
        // Real API: tier đến từ winGrade server — không tính lại tại client.
        if (USE_REAL_API) return null;
        // Mock / cheat mode: tính từ ratio dùng PROGRESSIVE_WIN_THRESHOLDS (hằng số theo spec).
        return this._getProgressiveTierFromRatio(win, totalBet);
    }

    /**
     * Tính Progressive Tier từ ratio totalWin / totalBet.
     * Dùng config từ server (đã parse vào data.config) nếu > 0; fallback PROGRESSIVE_WIN_THRESHOLDS.
     * Thứ tự: MAX → MONSTER → ULTRA → EPIC → SUPER → MAJOR → MEGA → BIG.
     */
    private _getProgressiveTierFromRatio(win: number, totalBet: number): ProgressiveWinTier | null {
        const ratio = totalBet > 0 ? win / totalBet : 0;
        for (const t of PROGRESSIVE_WIN_THRESHOLDS) {
            if (ratio >= t.multiplier) return t.tier;
        }
        return null;
    }

    private _afterWinProcessed(): void {
        this._logSpinState('_afterWinProcessed ENTER');
        if (!this._isSpinning) {
            this._logSpinState('_afterWinProcessed SKIP — already not spinning');
            return; // guard: tránh gọi 2 lần
        }
        // Guard: chỉ xử lý win sau khi REELS_STOPPED đã fire (reel cuối dừng hẳn)
        if (!this._reelsStoppedProcessed) {
            this._logSpinState('_afterWinProcessed SKIP — reelsStoppedProcessed=false');
            return;
        }

        // Pot level-up animation không được chặn Spin.
        // Highlight win (show-all) xong → mở Spin ngay, chạy song song với Pot transition.
        // Chỉ defer khi nextStage không phải SPIN (POT_WIN / FEATURE_SELECT / …).
        const data = GameData.instance;
        const resp = data.lastSpinResponse;
        if (!resp) {
            this._logSpinState('_afterWinProcessed SKIP — no lastSpinResponse');
            return;
        }

        const canContinueDuringPotTransition =
            (resp.nextStage as SlotStageType) === SlotStageType.SPIN;

        if (this._isPotTransitioning && !canContinueDuringPotTransition) {
            this._pendingAfterWinProcessed = true;
            this._logSpinState('_afterWinProcessed DEFER — pot transitioning (non-SPIN stage)');
            return;
        }

        // Kiểm tra trước khi chuyển stage: spin hiện tại có phải Normal không?
        const wasNormalSpin = !this._isFreeSpin();

        // Carnival Red Mystery Envelope (instant payout trên normal spin)
        if (resp.redEnvelopePay != null && resp.redEnvelopePay > 0) {
            Log.e(`[GameManager] RED_ENVELOPE pay=${resp.redEnvelopePay}`);
            EventBus.instance.emit(GameEvents.CARNIVAL_RED_ENVELOPE, { amount: resp.redEnvelopePay });
        }

        // Chuyển stage
        this._transitionStage(resp.nextStage as SlotStageType);

        this._isSpinning = false;
        // Nếu _transitionStage đặt state POPUP (ví dụ FREE_SPIN_END → popup tổng kết),
        // không override → chờ popup đóng rồi mới reset
        if (this._gameState !== GameState.POPUP) {
            this._gameState = GameState.IDLE;
            this._logSpinState(`_afterWinProcessed DONE → IDLE + UI_SPIN_BUTTON_STATE(true) nextStage=${resp.nextStage}`);
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);

            // Emit NORMAL_SPIN_DONE để AutoSpinManager có thể trigger auto spin tiếp theo.
            // Chỉ emit khi spin vừa rồi là Normal và stage tiếp theo vẫn là SPIN bình thường
            // (không emit nếu vừa vào FREE_SPIN_START, hoặc FREE_SPIN_END, v.v.)
            if (wasNormalSpin && (
                (resp.nextStage as SlotStageType) === SlotStageType.SPIN
                // POT_WIN: NORMAL_SPIN_DONE được emit bởi _onPotWinDone() sau khi animation xong
            )) {
                EventBus.instance.emit(GameEvents.NORMAL_SPIN_DONE);
            }
        } else {
            this._logSpinState(`_afterWinProcessed kept POPUP — spin button NOT enabled | nextStage=${resp.nextStage}`);
        }
    }

    // ─── HELPERS ───

    /** Trả về auto-spin delay (giây) theo speed mode — đồng bộ với Normal AutoSpin */
    private _getAutoSpinDelay(): number {
        switch (AutoSpinManager.instance.speedMode) {
            case SpeedMode.QUICK:  return 0.3;
            case SpeedMode.TURBO:  return 0.2;
            default:               return 0.5; // Normal
        }
    }

    // ─── STATE TRANSITIONS ───

    private _transitionStage(nextStage: SlotStageType): void {
        const prevStage = this._currentStage;
        this._currentStage = nextStage;

        EventBus.instance.emit(GameEvents.STAGE_CHANGED, nextStage, prevStage);

        switch (nextStage) {
            case SlotStageType.FREE_SPIN_START:
            case SlotStageType.BUY_FREE_SPIN_START: {
                // Carnival Neko: FREE_SPIN_* = Matsuri Hold&Spin (không phải line Free Spin)
                const spinResp = GameData.instance.lastSpinResponse;
                const cnFeature = spinResp?.carnivalFeature
                    ?? GameData.instance.pendingCarnivalMatsuri;
                const isCnMatsuri = !!cnFeature
                    || (spinResp?.currentFeatureType != null && spinResp.currentFeatureType >= 0)
                    || !!spinResp?.starterCoins?.length
                    || GameData.instance.currentMode === 'matsuri';
                if (isCnMatsuri) {
                    const feature = cnFeature
                        ?? ({
                            kind: CarnivalFeatureKind.MIGHTY,
                            burstPots: [],
                            jackpotFirst: false,
                            jackpotAfterFreeSpin: false,
                            matsuriRows: spinResp?.featureRows ?? 3,
                            startCoins: spinResp?.starterCoins?.length ?? 6,
                            featureName: 'Mighty Matsuri',
                        } as CarnivalFeatureTrigger);
                    Log.e(`[GameManager] FREE_SPIN_START → Carnival Matsuri "${feature.featureName}"`);
                    this._showMatsuriStartPopupThenEnter(feature);
                    break;
                }
                const fsCount = (USE_REAL_API && spinResp?.remainFreeSpinCount != null && spinResp.remainFreeSpinCount > 0)
                    ? spinResp.remainFreeSpinCount
                    : 3;
                this._enterFreeSpin(fsCount, false);
                break;
            }
            case SlotStageType.FREE_SPIN_RE_TRIGGER: {
                // Matsuri mid: RE_TRIGGER đã xử lý trong _handleMatsuriReelsStopped
                if (GameData.instance.currentMode === 'matsuri') {
                    if (GameData.instance.respinRemaining > 0) {
                        this._currentStage = SlotStageType.TOPUP_SPIN;
                        this._gameState = GameState.IDLE;
                        this.scheduleOnce(() => EventBus.instance.emit(GameEvents.SPIN_REQUEST), 0.35);
                    } else {
                        this._transitionStage(SlotStageType.TOPUP_SPIN_END);
                    }
                    break;
                }
                const spinResp = GameData.instance.lastSpinResponse;
                const fsCount = (spinResp?.remainFreeSpinCount != null && spinResp.remainFreeSpinCount > 0)
                    ? spinResp.remainFreeSpinCount
                    : GameData.instance.freeSpinRemaining + 5;
                this._enterFreeSpin(fsCount, true);
                break;
            }

            case SlotStageType.FREE_SPIN:
            case SlotStageType.BUY_FREE_SPIN: {
                if (GameData.instance.currentMode === 'matsuri') {
                    if (GameData.instance.respinRemaining > 0) {
                        this._currentStage = SlotStageType.TOPUP_SPIN;
                        this._gameState = GameState.IDLE;
                        this.scheduleOnce(() => EventBus.instance.emit(GameEvents.SPIN_REQUEST), 0.35);
                    } else {
                        this._transitionStage(SlotStageType.TOPUP_SPIN_END);
                    }
                    break;
                }
                const delay = this._getAutoSpinDelay();
                if (this._isFreespinGold()) {
                    this.scheduleOnce(this._autoSpinCallback, delay);
                    break;
                }
                this.scheduleOnce(this._autoSpinCallback, delay);
                break;
            }

            case SlotStageType.FREE_SPIN_END:
            case SlotStageType.BUY_FREE_SPIN_END:
                this._gameState = GameState.POPUP;
                if (GameData.instance.currentMode === 'matsuri') {
                    Log.d('[GameManager] FREE_SPIN_END (Matsuri) → _endCarnivalMatsuri');
                    this.scheduleOnce(() => this._endCarnivalMatsuri(), 0.6);
                    break;
                }
                Log.d(`[GameManager] FREE_SPIN_END transition — scheduling FreeSpinEndPopup display after ${this.freeSpinEndPopupDelay}s`);
                this.scheduleOnce(() => {
                    if (USE_REAL_API) {
                        this._handleClaim();
                    } else {
                        this._endFreeSpin();
                    }
                }, this.freeSpinEndPopupDelay);
                break;

            case SlotStageType.TOPUP_SPIN_START:
            case SlotStageType.TOPUP_SPIN:
            case SlotStageType.RESPIN_START:
            case SlotStageType.RESPIN:
                // Hết lượt → chuyển END, không schedule spin thêm (tránh quay tới full reel)
                if (GameData.instance.respinRemaining <= 0) {
                    Log.e('[TopUp/Matsuri] TOPUP_SPIN nhưng remain=0 → ép TOPUP_SPIN_END');
                    this._transitionStage(SlotStageType.TOPUP_SPIN_END);
                    break;
                }
                this._currentStage = SlotStageType.TOPUP_SPIN;
                this._gameState = GameState.IDLE;
                this.scheduleOnce(() => {
                    EventBus.instance.emit(GameEvents.SPIN_REQUEST);
                }, 0.35);
                break;

            case SlotStageType.TOPUP_SPIN_END:
            case SlotStageType.RESPIN_END:
                this._gameState = GameState.POPUP;
                if (GameData.instance.currentMode === 'matsuri') {
                    this.scheduleOnce(() => this._endCarnivalMatsuri(), 0.6);
                } else {
                    this.scheduleOnce(() => this._handleTopUpClaim(), 0.6);
                }
                break;

            case SlotStageType.NEED_CLAIM:
                this._handleClaim();
                break;

            // ★ Server gửi PICK_START(6) hoặc PICK(7) trực tiếp (ví dụ: Force Pick Game [-1×5]).
            // Client-side flow vẫn đi qua POT_WIN để trigger PotController → PickGamePopup.
            case SlotStageType.PICK_START:
            case SlotStageType.PICK:
                this._currentStage = SlotStageType.POT_WIN;
                // Đảm bảo resp.triggerPotWin = true để _onPotWinDone() dùng resp.pickGame thật.
                if (GameData.instance.lastSpinResponse) {
                    (GameData.instance.lastSpinResponse as any).triggerPotWin = true;
                }
                // Fall through vào POT_WIN handler
                // falls through

            case SlotStageType.POT_WIN:
                // Block spin button trong suốt POT_WIN sequence.
                this._gameState = GameState.POPUP;
                {
                    const carnival = GameData.instance.lastSpinResponse?.carnivalFeature ?? null;
                    if (carnival) {
                        // Carnival: pot burst trước → rồi POT_WIN_INTRO / Pick
                        Log.e(`[GameManager] POT_WIN (Carnival) → BURST "${carnival.featureName}"`);
                        this._startCarnivalPotBurst(carnival);
                    } else {
                        Log.d('[GameManager] POT_WIN stage → POT_WIN_INTRO delayed 0.9s');
                        this.scheduleOnce(() => {
                            EventBus.instance.emit(GameEvents.POT_WIN_INTRO);
                        }, 0.9);
                    }
                }
                break;

            case SlotStageType.CARNIVAL_MATSURI_START: {
                this._gameState = GameState.POPUP;
                const carnival = GameData.instance.lastSpinResponse?.carnivalFeature
                    ?? GameData.instance.pendingCarnivalMatsuri;
                if (!carnival) {
                    Log.e('[GameManager] CARNIVAL_MATSURI_START nhưng thiếu carnivalFeature → IDLE');
                    this._gameState = GameState.IDLE;
                    EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
                    EventBus.instance.emit(GameEvents.NORMAL_SPIN_DONE);
                    break;
                }
                Log.e(`[GameManager] CARNIVAL_MATSURI_START → BURST "${carnival.featureName}"`);
                this._startCarnivalPotBurst(carnival);
                break;
            }

            case SlotStageType.FEATURE_SELECT:
            case SlotStageType.FEATURE_SELECT_START: {
                // 6+ Red → bắt đầu fly-in animation trước khi mở popup
                this._gameState = GameState.POPUP;
                const featureResp = GameData.instance.lastSpinResponse;
                const cells = featureResp?.stickyCells ?? [];
                const sumCredit = cells.reduce((sum, c) => sum + (c.credit ?? 0), 0);
                Log.e(`[FEATURE_SELECT] cells=${cells.length} sumCredit=${sumCredit} | cellDetails=${JSON.stringify(cells.map(c => ({ r: c.reel, row: c.row, sym: c.symbolId, credit: c.credit })))}`);
                // Lưu Base Credit cho Re-Spin / Free Spin dùng sau
                GameData.instance.featureBaseCredit = sumCredit;
                Log.d(`[GameManager] FEATURE_SELECT_START — redCount=${featureResp?.redCount}, sumCredit=${sumCredit}, cells=${cells.length}`);
                // Guard: chỉ emit CREDIT_FLY_IN_START sau khi reel cuối dừng hẳn
                if (!this._reelsStoppedProcessed) {
                    Log.e(`[GOLD-FLY][FEATURE_SELECT] SKIP CREDIT_FLY_IN_START — reel chưa dừng hẳn`);
                    break;
                }
                if (this._pendingFeatureSelectAfterHighlight) {
                    Log.e('[GOLD-FLY][FEATURE_SELECT] wait WIN_PRESENT_END before CREDIT_FLY_IN_START');
                    break;
                }
                // Force Feature Entry gate nằm trong _startFeatureSelectCreditFly()
                // để mọi nhánh (no-win và WIN_PRESENT_END) đều chạy guide + sticky fill.
                this._startFeatureSelectCreditFly('transitionStage-no-win');
                break;
            }

            case SlotStageType.SPIN:
                // Quay bình thường, chờ người chơi nhấn Spin
                // Gauge đã cập nhật trong _onReelsStopped
                break;
        }
    }

    /**
     * ★ FEATURE ENTRY — Reel UI Gauge.
     * 10 ô lighting từ StickyAccumulated (Red Sticky tích lũy) theo ngưỡng
     * [10,20,40,60,80,100,120,140,160,200].
     * StickyEarned = số Red Sticky landed spin này (log/animation).
     * Chỉ track ở Normal Spin; Free/Feature Spin = 0, reset khi vào feature.
     * PotVisualLevel chỉ dùng cho Pot UI, KHÔNG dùng cho gauge.
     */
    private _resetFeatureGauge(): void {
        const data = GameData.instance;
        data.featureGaugeAccumulated = 0;
        data.featureGaugeStage = 0;
        EventBus.instance.emit(GameEvents.FEATURE_GAUGE_RESET);
    }

    private _updateFeatureGauge(resp: SpinResponse | null): void {
        if (!resp) return;
        const data = GameData.instance;
        if (data.currentMode !== 'normal') return;
        if ((resp.reelIndex ?? 0) !== 0) return;

        const earned = resp.stickyEarnedThisSpin ?? resp.wildCount ?? 0;
        const serverAccumulated = resp.stickyAccumulated ?? resp.potCount ?? null;
        const accumulated = serverAccumulated != null
            ? (serverAccumulated as number)
            : data.featureGaugeAccumulated + earned;
        const stage = gaugeStageFromAccumulated(accumulated);

        data.featureGaugeAccumulated = accumulated;

        const changed = stage !== data.featureGaugeStage;
        data.featureGaugeStage = stage;

        if (!changed && earned === 0) return;
        EventBus.instance.emit(GameEvents.FEATURE_GAUGE_UPDATE, {
            stage, accumulated, earned, animate: true,
        });
    }

    /** Khôi phục gauge từ LastSpinResponse.StickyAccumulated khi /Enter. */
    private _syncEnterGaugeState(lastSpin: any): void {
        const data = GameData.instance;
        const accumulated = lastSpin?.StickyAccumulated ?? lastSpin?.stickyAccumulated
            ?? lastSpin?.PotCount ?? lastSpin?.potCount ?? null;
        if (accumulated != null) {
            data.featureGaugeAccumulated = accumulated as number;
            data.featureGaugeStage = gaugeStageFromAccumulated(data.featureGaugeAccumulated);
        }
    }

    // ─── CREDIT FLY-IN DONE → MỞ FEATURE SELECTION POPUP ───

    /**
     * Khi tất cả credit label đã bay vào EachWin xong → mở popup Feature Selection.
     */
    private _onCreditFlyInDone(payload?: { sumCredit?: number }): void {
        if (!this._awaitingFeatureSelectCreditDone) {
            Log.e('[GameManager] CREDIT_FLY_IN_DONE ignored — no active FeatureSelect credit fly');
            return;
        }
        this._awaitingFeatureSelectCreditDone = false;

        const featureResp = GameData.instance.lastSpinResponse;
        const nextStage = featureResp?.nextStage as SlotStageType | undefined;
        const isFeatureSelect = nextStage === SlotStageType.FEATURE_SELECT || nextStage === SlotStageType.FEATURE_SELECT_START;
        if (!isFeatureSelect) {
            Log.e(`[GameManager] CREDIT_FLY_IN_DONE ignored — lastSpinResponse.nextStage=${nextStage}`);
            return;
        }

        const cells = featureResp?.stickyCells ?? [];
        const sumCredit = payload?.sumCredit ?? GameData.instance.featureBaseCredit;
        Log.d(`[GameManager] CREDIT_FLY_IN_DONE → emit FEATURE_SELECT_OPEN (sumCredit=${sumCredit})`);
        EventBus.instance.emit(GameEvents.FEATURE_SELECT_OPEN, { sumCredit, stickyCells: cells });

        // Emit WIN_PRESENT_START sau khi credit fly xong nếu deferred từ Feature Select
        if (this._pendingWinPresentRespFeature) {
            const resp = this._pendingWinPresentRespFeature;
            this._pendingWinPresentRespFeature = null;
            if (this._isSpinning) {
                EventBus.instance.emit(GameEvents.WIN_PRESENT_START, resp);
            }
        }
    }

    /**
     * Highlight animation xong (SymbolHighlighter emit WIN_HIGHLIGHT_ANIM_DONE).
     * Nếu Feature Select có win: bắt đầu bounce + credit fly-in sau khi highlight xong.
     */
    private _onHighlightAnimDone(): void {
        if (this._pendingFeatureSelectAfterHighlight) {
            Log.e('[GOLD-FLY][FEATURE_SELECT] WIN_HIGHLIGHT_ANIM_DONE received — wait WIN_PRESENT_END before credit fly');
        }
    }

    private async _onFeatureSelectChoice(payload?: FeatureSelectChoicePayload): Promise<void> {
        if (!payload?.option) return;
        const { option } = payload;
        const reelIndex = option.reelIndex;

        try {
            if (option.id === FeatureSelectChoiceId.TOPUP) {
                GameData.instance.selectedFreeSpinReelIndex = null;
                Log.e('[GameManager] FEATURE_SELECT → TopUp NextStage=12(TOPUP_SPIN_START) ReelIndex=0');
            } else {
                GameData.instance.selectedFreeSpinReelIndex = reelIndex;
                Log.e(`[GameManager] FEATURE_SELECT → FreeSpin tier=${option.id} NextStage=3(FREE_SPIN_START) ReelIndex=${reelIndex}`);
            }

            const ack = await NetworkManager.instance.sendSelectFeature(option.nextStage, reelIndex);
            if (ack.reelIndex != null && isFreeSpinTierReelIndex(ack.reelIndex)) {
                GameData.instance.selectedFreeSpinReelIndex = ack.reelIndex;
            }

            if (option.id === FeatureSelectChoiceId.TOPUP) {
                const count = ack.remainFeatureSpinCount > 0 ? ack.remainFeatureSpinCount : 6;
                this._clearFeatureSelectTransientState();
                payload.onAccepted?.(() => this._showTopUpTransitionThenEnter(count));
                if (!payload.onAccepted) this._showTopUpTransitionThenEnter(count);
                return;
            }

            const count = ack.remainFeatureSpinCount > 0 ? ack.remainFeatureSpinCount : 8;
            // currentMode / UI chỉ đổi sau Transition READY — giữ Normal đến khi overlay phủ kín
            this._freeSpinGoldCoinTotal = 0;
            this._freeSpinGoldServerTotalWin = null;
            this._freeSpinGoldCountedKeys.clear();
            this._clearFeatureSelectTransientState();
            payload.onAccepted?.(() => this._showTopUpTransitionThenEnterFreespin(count));
            if (!payload.onAccepted) this._showTopUpTransitionThenEnterFreespin(count);
        } catch (err) {
            Log.e('[GameManager] SelectFeature failed:', err);
            payload.onRejected?.();
            if (!(err instanceof ServerApiError && err.alreadyHandled)) {
                const popupCase = PopUpMessage.popupCaseFromError(err as Error);
                EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, { popupCase });
            }
        }
    }

    /**
     * FeatureSelect → TopUp:
     * 1) SHOW TransitionPopup (UI Normal vẫn giữ nguyên lúc fade-in)
     * 2) READY (fade-in full) → prepare UI TopUp dưới overlay
     * 3) DONE → sticky bounce + bắt đầu spin
     */
    private _showTopUpTransitionThenEnter(count: number): void {
        this._topUpUiPrepared = false;
        this._topUpStartGameplayPending = false;
        this._pendingTopUpPrepareCount = count;
        this._pendingFreespinPrepareCount = null;

        let done = false;
        const startGameplay = () => {
            if (done) return;
            done = true;
            EventBus.instance.off(GameEvents.TOPUP_TRANSITION_DONE, startGameplay, this);
            this.unschedule(startGameplay);
            this._startTopUpGameplayAfterTransition();
        };
        EventBus.instance.once(GameEvents.TOPUP_TRANSITION_DONE, startGameplay, this);
        EventBus.instance.emit(GameEvents.TOPUP_TRANSITION_SHOW, TransitionMode.TopUp);
        // Fallback DONE
        this.scheduleOnce(startGameplay, 4.0);
    }

    /**
     * FeatureSelect → FreeSpin Gold: UI đổi ở READY, spin ở DONE.
     */
    private _showTopUpTransitionThenEnterFreespin(count: number): void {
        this._pendingFreespinPrepareCount = count;
        this._pendingTopUpPrepareCount = null;

        let done = false;
        const startGameplay = () => {
            if (done) return;
            done = true;
            EventBus.instance.off(GameEvents.TOPUP_TRANSITION_DONE, startGameplay, this);
            this.unschedule(startGameplay);
            this._startFreespinGoldGameplayAfterTransition();
        };
        EventBus.instance.once(GameEvents.TOPUP_TRANSITION_DONE, startGameplay, this);
        EventBus.instance.emit(GameEvents.TOPUP_TRANSITION_SHOW, TransitionMode.FreeSpin);
        this.scheduleOnce(startGameplay, 4.0);
    }

    private _buildPendingResume(raw: any, source: string): PendingResumeData | null {
        const body = raw?.Res ?? raw ?? {};
        Log.d(`[RESUME-DEBUG] _buildPendingResume source=${source} — raw dump: ${JSON.stringify(raw)}`);
        Log.d(`[RESUME-DEBUG] _buildPendingResume body keys: [${Object.keys(body).join(', ')}]`);
        const lastStage: number = body.NextStage ?? body.stageType ?? raw?.NextStage ?? raw?.stageType ?? 0;
        const remainFS: number = body.RemainFreeSpinCount ?? body.remainFreeSpinCount
            ?? body.RemainFeatureSpinCount ?? body.remainFeatureSpinCount
            ?? raw?.RemainFreeSpinCount ?? raw?.remainFreeSpinCount
            ?? raw?.RemainFeatureSpinCount ?? raw?.remainFeatureSpinCount
            ?? 0;
        const featureTotalWin: number = body.FeatureSpinTotalWin ?? body.featureSpinTotalWin ?? raw?.FeatureSpinTotalWin ?? raw?.featureSpinTotalWin ?? 0;
        const lastRands: number[] = body.Rands ?? body.rands ?? raw?.Rands ?? raw?.rands ?? [];
        const remainTopUp: number = body.RemainFeatureSpinCount ?? body.remainFeatureSpinCount
            ?? body.RemainReSpinCount ?? body.remainReSpinCount
            ?? body.RemainRespinCount ?? body.remainRespinCount
            ?? raw?.RemainFeatureSpinCount ?? raw?.remainFeatureSpinCount
            ?? raw?.RemainReSpinCount ?? raw?.remainReSpinCount
            ?? raw?.RemainRespinCount ?? raw?.remainRespinCount
            ?? 0;
        const topupRaw = body.TopupReel ?? body.topupReel
            ?? body.NormalSpinLinkReel ?? body.normalSpinLinkReel
            ?? body.NoramlSpinLinkReel ?? body.noramlSpinLinkReel
            ?? raw?.TopupReel ?? raw?.topupReel
            ?? raw?.NormalSpinLinkReel ?? raw?.normalSpinLinkReel
            ?? raw?.NoramlSpinLinkReel ?? raw?.noramlSpinLinkReel;
        const topupReel = this._parseResumeTopupReel(topupRaw);
        const stickyCells = this._parseResumeTopupStickyCells(topupReel);
        const featureBaseCredit = this._sumTopUpBaseCredit(stickyCells);
        const stageName = this._stageName(lastStage);

        Log.d(`[GAME-ENTER] ${source} → lastStage=${lastStage}(${stageName}), remainFS=${remainFS}, remainTopUp=${remainTopUp}, featureTotalWin=${featureTotalWin}`);

        if (this._isTopUpStage(lastStage)) {
            if (remainTopUp > 0 || stickyCells.length > 0 || lastStage === SlotStageType.TOPUP_SPIN_START) {
                Log.d(`[RESUME-DEBUG] ${source} → set _pendingResume TOPUP stage=${lastStage}, remain=${remainTopUp}, cells=${stickyCells.length}`);
                return {
                    nextStage: lastStage,
                    remainFreeSpinCount: 0,
                    featureSpinTotalWin: featureTotalWin,
                    lastSpinRands: lastRands.length >= 3 ? lastRands : undefined,
                    remainRespinCount: remainTopUp,
                    topupReel,
                    stickyCells,
                    featureBaseCredit,
                };
            }
            Log.d(`[RESUME-DEBUG] ${source} → TOPUP stage nhưng thiếu remain/cells, bỏ qua resume`);
            return null;
        }

        if (lastStage === SlotStageType.FREE_SPIN
            || lastStage === SlotStageType.BUY_FREE_SPIN
            || lastStage === SlotStageType.FREE_SPIN_START
            || lastStage === SlotStageType.FREE_SPIN_RE_TRIGGER
            || lastStage === SlotStageType.BUY_FREE_SPIN_START) {
            if (remainFS > 0) {
                Log.d(`[RESUME-DEBUG] ${source} → set _pendingResume FREE_SPIN stage=${lastStage}, remain=${remainFS}, baseCredit=${featureBaseCredit}`);
                return {
                    nextStage: lastStage,
                    remainFreeSpinCount: remainFS,
                    featureSpinTotalWin: featureTotalWin,
                    lastSpinRands: lastRands.length >= 3 ? lastRands : undefined,
                    stickyCells,
                    featureBaseCredit,
                };
            }
            Log.d(`[RESUME-DEBUG] ${source} → remainFS=0, không resume`);
            return null;
        }

        // ★ Pick Game / Pot Win đang dở (chưa pick xong) → mở lại Pick Game.
        // Phải check TRƯỚC nhánh `>= 100` vì POT_WIN(220)/PICK_GAME(221) đều >= 100.
        if (this._isPickGameStage(lastStage)) {
            const pickGame = this._parseResumePickGame(body, raw);
            Log.d(`[RESUME-DEBUG] ${source} → set _pendingResume PICK_GAME stage=${lastStage}, hasPickGame=${!!pickGame}`);
            return {
                nextStage: lastStage,
                remainFreeSpinCount: remainFS,
                featureSpinTotalWin: featureTotalWin,
                lastSpinRands: lastRands.length >= 3 ? lastRands : undefined,
                pickGame,
            };
        }

        // ★ Đang ở Feature Select popup (chưa chọn Re-Spin/Free Spin) → mở lại popup.
        if (lastStage === SlotStageType.FEATURE_SELECT) {
            Log.d(`[RESUME-DEBUG] ${source} → set _pendingResume FEATURE_SELECT stage=${lastStage}, cells=${stickyCells.length}`);
            return {
                nextStage: lastStage,
                remainFreeSpinCount: remainFS,
                featureSpinTotalWin: featureTotalWin,
                lastSpinRands: lastRands.length >= 3 ? lastRands : undefined,
                stickyCells,
                featureBaseCredit,
            };
        }

        if (lastStage >= 100) {
            Log.d(`[RESUME-DEBUG] ${source} → set _pendingResume NEED_CLAIM stage=${lastStage}`);
            return {
                nextStage: lastStage,
                remainFreeSpinCount: 0,
                featureSpinTotalWin: featureTotalWin,
                lastSpinRands: lastRands.length >= 3 ? lastRands : undefined,
                remainRespinCount: remainTopUp,
                topupReel,
                stickyCells,
                featureBaseCredit,
            };
        }

        if (lastStage === SlotStageType.SPIN && lastRands.length >= 3) {
            Log.d(`[RESUME-DEBUG] ${source} → NORMAL_SPIN interrupted, rands=${JSON.stringify(lastRands)}`);
            return {
                nextStage: SlotStageType.SPIN,
                remainFreeSpinCount: 0,
                featureSpinTotalWin: featureTotalWin,
                lastSpinRands: lastRands,
            };
        }

        Log.d(`[GAME-ENTER] ${source} → stage=${stageName} không cần resume`);
        return null;
    }

    private _parseResumeTopupReel(raw: any): TopupReelSlot[] | undefined {
        if (!Array.isArray(raw) || raw.length === 0) return undefined;
        const slots: TopupReelSlot[] = [];
        for (let i = 0; i < raw.length; i++) {
            const item = raw[i];
            const isObj = typeof item === 'object' && item !== null;
            const type = isObj ? item?.Type ?? item?.type ?? TopupReelType.NONE : TopupReelType.NONE;
            // ★ Thử nhiều field name server có thể gửi cho credit (Win, Credit, Val, Value)
            const win = isObj
                ? (item?.Win ?? item?.win ?? item?.Credit ?? item?.credit ?? item?.Val ?? item?.val ?? item?.Value ?? item?.value ?? 0)
                : 0;
            const index = isObj ? item?.Index ?? item?.index ?? i : (typeof item === 'number' ? item : i);
            slots.push({ type, win, index });
        }
        return slots;
    }

    private _parseResumeTopupStickyCells(slots?: TopupReelSlot[]): StickyCell[] {
        if (!slots) return [];
        const cells: StickyCell[] = [];
        for (let i = 0; i < Math.min(15, slots.length); i++) {
            const slot = slots[i];
            if (slot.type === TopupReelType.NONE) continue;
            const apiRow = Math.floor(i / 5);
            const reel = i % 5;
            const row = 2 - apiRow;
            let symbolId = SymbolId.STICKY_RED;
            if (slot.type === TopupReelType.YELLOW) symbolId = SymbolId.STICKY_YELLOW;
            else if (slot.type === TopupReelType.GREEN) symbolId = SymbolId.STICKY_GREEN;
            else if (slot.type === TopupReelType.GRAND) symbolId = SymbolId.JP_GRAND;
            cells.push({ reel, row, symbolId, credit: slot.win });
        }
        Log.e(`[RESUME-STICKY] Parsed ${cells.length} cells: ${cells.map(c => `${c.reel}-${c.row}:${SymbolId[c.symbolId]??c.symbolId}($${c.credit})`).join(', ')}`);
        return cells;
    }

    private _sumTopUpBaseCredit(cells: StickyCell[]): number {
        return cells.reduce((sum, cell) => cell.symbolId === SymbolId.STICKY_RED ? sum + (cell.credit ?? 0) : sum, 0);
    }

    private _isTopUpStage(stage: number): boolean {
        return stage === SlotStageType.TOPUP_SPIN_START
            || stage === SlotStageType.TOPUP_SPIN
            || stage === SlotStageType.TOPUP_SPIN_END
            || stage === SlotStageType.RESPIN_START
            || stage === SlotStageType.RESPIN
            || stage === SlotStageType.RESPIN_END;
    }

    /**
     * Các stage cho biết người chơi đang DỞ Pick Game (chưa pick xong) khi tắt game.
     * Bao gồm cả PICK_START/PICK (server API 7.1) và POT_WIN/PICK_GAME (client GoF).
     * KHÔNG bao gồm PICK_END/PICK_GAME_END — đó là "đã pick xong, chờ claim" (xử lý ở nhánh >=100).
     */
    private _isPickGameStage(stage: number): boolean {
        return stage === SlotStageType.POT_WIN
            || stage === SlotStageType.PICK_GAME
            || stage === SlotStageType.PICK_START
            || stage === SlotStageType.PICK;
    }

    /**
     * Parse PickGame state từ raw LastSpinResponse để resume.
     * Hỗ trợ:
     *  - Client form: { grid, revealed, wonTier }
     *  - Server array: [{ Index, SymbolId }] (PS 82–85 remapped) → convert sang client SymbolId
     *  - Thiếu/không hợp lệ → build mock PickGameState mới.
     */
    private _parseResumePickGame(body: any, raw: any): PickGameState {
        const rawPick = body?.PickGame ?? body?.pickGame ?? raw?.PickGame ?? raw?.pickGame;

        // Client form đã có grid
        if (rawPick && Array.isArray(rawPick.grid) && rawPick.grid.length > 0) {
            const grid = rawPick.grid.slice();
            while (grid.length < PICK_GAME_CELL_COUNT) grid.push(SymbolId.JP_MINI);
            return {
                grid,
                revealed: Array.isArray(rawPick.revealed) ? rawPick.revealed.slice() : [],
                wonTier: rawPick.wonTier,
                upgradeArmed: rawPick.upgradeArmed,
                upgradeCount: rawPick.upgradeCount,
                doubleGrand: rawPick.doubleGrand,
            };
        }

        // Server array form: [{ Index, SymbolId }] hoặc number[] PS IDs
        if (Array.isArray(rawPick) && rawPick.length > 0) {
            const grid: number[] = new Array(PICK_GAME_CELL_COUNT).fill(SymbolId.JP_IDLE);
            const revealed: number[] = [];
            if (typeof rawPick[0] === 'number') {
                for (let i = 0; i < Math.min(rawPick.length, PICK_GAME_CELL_COUNT); i++) {
                    const ps = rawPick[i] as number;
                    if (ps === -1) continue;
                    grid[i] = psPickToClient(ps);
                    if (ps !== 81) revealed.push(i);
                }
            } else {
                for (const item of rawPick) {
                    const idx = item?.Index ?? item?.index ?? 0;
                    const sym = item?.SymbolId ?? item?.symbolId ?? -1;
                    if (idx < 0 || idx >= PICK_GAME_CELL_COUNT) continue;
                    grid[idx] = psPickToClient(sym);
                    if (sym !== -1 && sym !== 81) revealed.push(idx);
                }
            }
            return { grid, revealed, wonTier: undefined };
        }

        Log.d('[RESUME-DEBUG] _parseResumePickGame → thiếu PickGame data, build mock PickGameState');
        return MockDataProvider.buildPickGame();
    }

    private _stageName(stage: number): string {
        return (SlotStageType as any)[stage] ?? `UNKNOWN(${stage})`;
    }

    // ─── GAME READY → RESUME FREE SPIN NẾU CÓ ───

    private _onGameReady(): void {
        // Resume / skipIntro có thể không đi qua GUIDE_COMPLETE trên GameManager
        this._allowBackgroundLoad();

        if (this._pendingResume) {
            const r = this._pendingResume;
            Log.d(`[RESUME-DEBUG] _onGameReady() — _pendingResume: stage=${r.nextStage}, remainFS=${r.remainFreeSpinCount}, remainTopUp=${r.remainRespinCount ?? 0}, featureWin=${r.featureSpinTotalWin}, rands=${JSON.stringify(r.lastSpinRands)}, stickyCells=${r.stickyCells?.length ?? 0}, pickGame=${!!r.pickGame}`);
        } else {
            Log.d(`[RESUME-DEBUG] _onGameReady() — _pendingResume: null`);
        }
        
        // ★ Fallback: Ensure SoundManager starts BGM if not already started
        // (Handles timing issues where GAME_READY fires before SoundManager fully initialized)
        if (SoundManager.instance) {
            Log.d(`[GameManager] _onGameReady → SoundManager status:`, SoundManager.instance.getStatus?.());
            SoundManager.instance.initBGM?.();
        }

        if (!this._pendingResume) return;
        const resume = this._pendingResume;
        this._pendingResume = null;

        // Khôi phục freeSpinTotalWin từ server (FeatureSpinTotalWin)
        if (!this._isTopUpStage(resume.nextStage) && resume.featureSpinTotalWin > 0) {
            GameData.instance.freeSpinTotalWin = resume.featureSpinTotalWin;
            // Đánh dấu: tổng này đã được server tính sẵn (bao gồm cả jackpot/win trước đó)
            // → mock sendClaimRequest sẽ KHÔNG add thêm lần nữa vào balance (tránh double-add)
            GameData.instance.freeSpinTotalWinRestoredFromServer = true;
            Log.d(`[GameManager] Resume: Restored freeSpinTotalWin=${resume.featureSpinTotalWin} (flagged as server-restored)`);
        }

        // Detect jackpot từ lastSpinResponse → hiện popup jackpot trước khi resume
        // (spec: "Pot Win: bắt đầu từ hiệu ứng trúng Pot")
        if (resume.lastSpinRands && resume.lastSpinRands.length >= 3) {
            const jackpotCheckResp: SpinResponse = {
                rands: resume.lastSpinRands,
                waysPayWins: [],
                matchedLinePays: [],
                totalBet: 0,
                totalWin: 0,
                updateCash: false,
                nextStage: resume.nextStage,
            };
            const jackpot = this._detectJackpot(jackpotCheckResp);
            Log.d(`[GameManager] Resume: _detectJackpot(rands=${JSON.stringify(resume.lastSpinRands)}) → ${jackpot} (NONE=0,MINI=1,MINOR=2,MAJOR=3,GRAND=4)`);
            if (jackpot !== JackpotType.NONE) {
                const data = GameData.instance;
                // Resume: lấy prize từ API Before/meter — không hardcode multiplier
                const jackpotPrize = data.getJackpotWinAmount(jackpot);
                Log.d(`[GameManager] Resume: Jackpot ${jackpot} detected (prize=${jackpotPrize}) → emit JACKPOT_TRIGGER`);
                this._pendingResumeAfterJackpot = {
                    nextStage: resume.nextStage,
                    remainFreeSpinCount: resume.remainFreeSpinCount,
                    featureSpinTotalWin: resume.featureSpinTotalWin,
                    lastSpinRands: resume.lastSpinRands,
                };
                this._gameState = GameState.POPUP;
                EventBus.instance.emit(GameEvents.JACKPOT_TRIGGER, jackpot, jackpotPrize);
                return;
            }
        }

        this._executeResume(resume);
    }

    /**
     * Thực thi resume flow: vào Free Spin hoặc Claim.
     * Tách riêng để gọi được từ _onGameReady (no jackpot) và _onJackpotEnd (after jackpot popup).
     */
    private _executeResume(resume: PendingResumeData): void {
        Log.d(`[RESUME-DEBUG] _executeResume() FULL DUMP: ${JSON.stringify(resume)}`);

        // NextStage = SPIN(0): vòng quay thường bị gián đoạn → khôi phục màn hình kết quả cuối
        if (resume.nextStage === SlotStageType.SPIN) {
            const rawLast = GameData.instance.rawEnterLastSpinResponse;
            if (rawLast && (rawLast.Rands ?? rawLast.rands ?? []).length >= 3) {
                Log.d(`[RESUME-DEBUG] _executeResume → NORMAL_SPIN resume`);
                const resp = this._buildSpinResponseFromRaw(rawLast);
                GameData.instance.lastSpinResponse = resp;
                // Set spinning=true trước khi REELS_STOPPED — _afterWinProcessed cần guard này
                this._isSpinning = true;
                this._gameState = GameState.SPINNING;
                EventBus.instance.emit(GameEvents.RESUME_NORMAL_SPIN, resp.rands);
            } else {
                Log.d(`[RESUME-DEBUG] _executeResume → SPIN resume nhưng thiếu rands, bỏ qua`);
            }
            return;
        }

        if (this._isTopUpStage(resume.nextStage)) {
            if (resume.nextStage === SlotStageType.TOPUP_SPIN_END || resume.nextStage === SlotStageType.RESPIN_END) {
                Log.d(`[RESUME-DEBUG] _executeResume → TOPUP ended, show end popup before Claim`);
                this._restoreTopUpResumeState(resume, false);
                this._currentStage = SlotStageType.TOPUP_SPIN_END;
                this._gameState = GameState.POPUP;
                this._claimTopUpAfterEndPopup = false;
                EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
                this.scheduleOnce(() => {
                    this._handleTopUpClaim();
                }, 0.3);
                return;
            }

            Log.d(`[RESUME-DEBUG] _executeResume → TOPUP resume, remain=${resume.remainRespinCount ?? 0}`);
            this._restoreTopUpResumeState(resume, true);
            return;
        }

        // ★ Pick Game / Pot Win đang dở → mở lại Pick Game popup (cả Mock + Real).
        // Phải check TRƯỚC nhánh `>= 100` vì POT_WIN(220)/PICK_GAME(221) đều >= 100.
        if (this._isPickGameStage(resume.nextStage)) {
            this._resumePickGame(resume);
            return;
        }

        // ★ Đang ở Feature Select popup (chưa chọn Re-Spin/Free Spin) → mở lại popup.
        if (resume.nextStage === SlotStageType.FEATURE_SELECT) {
            Log.d(`[RESUME-DEBUG] _executeResume → FEATURE_SELECT resume, cells=${resume.stickyCells?.length ?? 0}`);
            const data = GameData.instance;
            if (!data.lastSpinResponse) {
                data.lastSpinResponse = {
                    rands: resume.lastSpinRands ?? [0, 0, 0, 0, 0],
                    waysPayWins: [],
                    matchedLinePays: [],
                    totalBet: BetManager.instance.totalBet,
                    totalWin: 0,
                    updateCash: false,
                    nextStage: SlotStageType.FEATURE_SELECT,
                };
            }
            (data.lastSpinResponse as any).stickyCells = resume.stickyCells ?? [];
            data.featureBaseCredit = resume.featureBaseCredit ?? 0;
            this._currentStage = SlotStageType.FEATURE_SELECT;
            this._gameState = GameState.POPUP;
            this._updateDisplayVisibility();
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
            this.scheduleOnce(() => {
                EventBus.instance.emit(GameEvents.FEATURE_SELECT_OPEN, {
                    sumCredit: data.featureBaseCredit,
                    stickyCells: resume.stickyCells ?? [],
                });
            }, 0.3);
            return;
        }

        // NextStage >= 100 → Free Spin đã kết thúc nhưng chưa Claim
        // Không cần switch visual sang freespin mode — chỉ cần Claim và hiện end popup.
        if (resume.nextStage >= 100) {
            Log.d(`[RESUME-DEBUG] _executeResume → _handleClaim() (stage=${resume.nextStage})`);
            // ★ Đặt _currentStage phù hợp để _endFreeSpin / _onFreeSpinEndPopupClosed xử lý đúng
            this._currentStage = resume.nextStage as SlotStageType;
            this._handleClaim();
            return;
        }

        // NextStage = FREE_SPIN/BUY_FREE_SPIN (GoF Free Game = FreeSpin Gold) → khôi phục Gold mode + quay tiếp.
        // Mọi sub-stage (START/RE_TRIGGER/mid) đều vào thẳng Gold (GoF không có start popup cho Free Game).
        if (resume.remainFreeSpinCount > 0) {
            Log.d(`[RESUME-DEBUG] _executeResume → FREE SPIN (Gold) resume stage=${resume.nextStage}, remain=${resume.remainFreeSpinCount}`);
            this._resumeFreeSpinGold(resume.remainFreeSpinCount, resume.featureSpinTotalWin, resume.lastSpinRands, resume.featureBaseCredit);
        }
    }

    /**
     * Khôi phục FreeSpin Gold khi resume (GoF Free Game = FreeSpin Gold).
     * Giữ tổng tiền đã thắng (server tính sẵn trong FeatureSpinTotalWin), hiện đúng UI Gold
     * (freeSpinGoldDisplay), ẩn jackpot/pot/multiplier qua _updateDisplayVisibility, rồi auto-spin.
     */
    private _resumeFreeSpinGold(count: number, totalWin: number, rands?: number[], featureBaseCredit?: number): void {
        const data = GameData.instance;
        Log.d(`[RESUME-DEBUG] _resumeFreeSpinGold → count=${count}, totalWin=${totalWin}, rands=${JSON.stringify(rands)}, baseCredit=${featureBaseCredit}`);
        data.currentMode = 'freespin_gold';
        data.freeSpinRemaining     = count;
        data.freeSpinGoldRemaining = count;
        // Server resume only gives FeatureSpinTotalWin (already accumulated) and does not split
        // line wins vs gold coin wins. Keep the restored amount in the Gold UI bucket so the
        // final popup remains equal to UIController total + FreeSpinGoldUI total instead of double-counting.
        data.freeSpinTotalWin      = 0;
        data.freeSpinGoldTotalWin  = truncateMoney3(totalWin);
        data.freeSpinTotalWinRestoredFromServer = true;  // mock Claim không cộng đôi
        data.isResumingFreeSpin    = true;
        this._freeSpinActualCount   = 0;
        this._freeSpinGoldCoinTotal = truncateMoney3(totalWin);
        this._freeSpinGoldServerTotalWin = null;
        this._freeSpinGoldCountedKeys.clear();
        data.stickyCells.clear();

        this._currentStage = SlotStageType.FREE_SPIN;
        this._gameState    = GameState.IDLE;
        this._updateDisplayVisibility();
        this._updateBackgroundSprite();

        // ★ Vẽ lại reel tĩnh từ kết quả ván trước (nền chờ) trước khi auto-spin
        if (rands && rands.length >= 3) {
            Log.d(`[RESUME-DEBUG] _resumeFreeSpinGold → emit RESUME_FREE_SPIN_REELS rands=${JSON.stringify(rands)}`);
            EventBus.instance.emit(GameEvents.RESUME_FREE_SPIN_REELS, rands);
        }

        EventBus.instance.emit(GameEvents.FREE_SPIN_START);
        EventBus.instance.emit(GameEvents.FREE_SPIN_COUNT_UPDATED, count);
        // ★ Khôi phục featureBaseCredit cho EachWin display (tổng đỏ từ trigger)
        data.featureBaseCredit = featureBaseCredit ?? data.featureBaseCredit ?? 0;
        EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_START, {
            spinsRemaining: count,
            baseCredit:     data.featureBaseCredit,
        });
        // Hiện lại tổng vàng đã tích lũy trước khi tắt game
        if (totalWin > 0) {
            EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_ABSORB_CREDIT, { credit: totalWin });
        }
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
        this.scheduleOnce(() => EventBus.instance.emit(GameEvents.SPIN_REQUEST), 0.4);
    }

    /**
     * Khôi phục Pick Game khi resume (trúng Pot/Jackpot chưa pick xong).
     * Mở lại PickGamePopup để người chơi hoàn tất. PickGamePopup tự ẩn bottom UI
     * (spin/bet) khi entry, và _onPickGameClose re-enable lại sau khi đóng.
     */
    private _resumePickGame(resume: PendingResumeData): void {
        const data = GameData.instance;
        const pickState = resume.pickGame ?? data.lastSpinResponse?.pickGame ?? MockDataProvider.buildPickGame();
        Log.d(`[RESUME-DEBUG] _resumePickGame → reopen Pick Game (grid len=${pickState.grid?.length ?? 0})`);

        // Đảm bảo lastSpinResponse mang pickGame để sendPickRequest (mock) + _onPotWinDone dùng đúng state
        if (!data.lastSpinResponse) {
            data.lastSpinResponse = {
                rands: resume.lastSpinRands ?? [0, 0, 0, 0, 0],
                waysPayWins: [],
                matchedLinePays: [],
                totalBet: BetManager.instance.totalBet,
                totalWin: 0,
                updateCash: false,
                nextStage: SlotStageType.POT_WIN,
            };
        }
        (data.lastSpinResponse as any).pickGame = pickState;
        (data.lastSpinResponse as any).triggerPotWin = true;
        data.pickGameState = pickState;

        this._currentStage = SlotStageType.POT_WIN;
        this._gameState = GameState.POPUP;
        this._isPickGameActive = true;
        this._pickGameBgPending = true;
        this._updateDisplayVisibility();
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
        // Mở thẳng Pick Game (bỏ qua hiệu ứng bat-fly POT_WIN_INTRO vì reel không hiển thị trail khi resume)
        this.scheduleOnce(() => {
            EventBus.instance.emit(GameEvents.PICK_GAME_OPEN, pickState);
        }, 0.3);
    }

    private _restoreTopUpResumeState(resume: PendingResumeData, continueSpin: boolean): void {
        void this._restoreTopUpResumeStateAsync(resume, continueSpin);
    }

    private async _restoreTopUpResumeStateAsync(resume: PendingResumeData, continueSpin: boolean): Promise<void> {
        const data = GameData.instance;
        Log.d(`[RESUME-DEBUG] _restoreTopUpResumeState — continueSpin=${continueSpin}, remainRespin=${resume.remainRespinCount ?? 0}, stickyCells=${resume.stickyCells?.length ?? 0}, featureWin=${resume.featureSpinTotalWin}`);
        data.currentMode = 'respin';
        data.stickyCells.clear();
        for (const cell of resume.stickyCells ?? []) {
            data.stickyCells.set(`${cell.reel}-${cell.row}`, cell);
        }
        data.featureBaseCredit = resume.featureBaseCredit ?? this._sumTopUpBaseCredit(resume.stickyCells ?? []);
        data.respinRemaining = Math.max(0, resume.remainRespinCount ?? 0);
        data.respinTotalWin = Math.max(0, resume.featureSpinTotalWin ?? 0);

        // ★ Đảm bảo lastSpinResponse có topupReel để TopUpManager init empty reels đúng khi resume
        if (resume.topupReel && resume.topupReel.length > 0) {
            if (!data.lastSpinResponse) {
                data.lastSpinResponse = {
                    rands: resume.lastSpinRands ?? [0, 0, 0, 0, 0],
                    waysPayWins: [],
                    matchedLinePays: [],
                    totalBet: BetManager.instance.totalBet,
                    totalWin: 0,
                    updateCash: false,
                    nextStage: SlotStageType.TOPUP_SPIN,
                };
            }
            (data.lastSpinResponse as any).topupReel = resume.topupReel;
            Log.d(`[RESUME-DEBUG] Populated lastSpinResponse.topupReel with ${resume.topupReel.length} slots`);
        }

        this._currentStage = SlotStageType.TOPUP_SPIN;
        this._gameState = GameState.IDLE;
        this._updateDisplayVisibility();
        this._updateBackgroundSprite();

        // Lazy-load StickyOverlay (+ TopUpManager) trước khi emit TOPUP_START
        await this._ensureStickyOverlayLoaded();
        this._applyStickyOverlayRowCount(3);

        EventBus.instance.emit(GameEvents.TOPUP_START, {
            spinsRemaining: data.respinRemaining,
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
            stickyCells: Array.from(data.stickyCells.values()),
        });
        EventBus.instance.emit(GameEvents.TOPUP_COUNT_UPDATED, data.respinRemaining);
        EventBus.instance.emit(GameEvents.TOPUP_TOTAL_UPDATED, {
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
            topupReel: resume.topupReel,
        });

        if (continueSpin && data.respinRemaining > 0) {
            EventBus.instance.emit(GameEvents.STAGE_CHANGED, SlotStageType.TOPUP_SPIN);
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
            this.scheduleOnce(() => EventBus.instance.emit(GameEvents.SPIN_REQUEST), 0.35);
        } else {
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
        }
    }

    /** Lazy-load StickyOverlay Prefab (nếu có StickyOverlayLoader). No-op khi overlay vẫn nằm sẵn trên Base. */
    private async _ensureStickyOverlayLoaded(): Promise<void> {
        const loader = this.node.scene?.getComponentInChildren(StickyOverlayLoader) ?? null;
        if (!loader) {
            // Fallback: overlay vẫn gắn sẵn trong Base (chưa chuyển sang lazy)
            return;
        }
        const overlay = await loader.ensureLoaded();
        if (!overlay) {
            Log.e('[GameManager] StickyOverlayLoader.ensureLoaded() failed — TopUp overlay sẽ không hiện');
        }
    }

    /** Prefab StickyOverlay 5×5 — bật đúng số hàng (3|4|5). */
    private _applyStickyOverlayRowCount(rows: number): void {
        const loader = this.node.scene?.getComponentInChildren(StickyOverlayLoader) ?? null;
        const overlay = loader?.overlay
            ?? this.node.scene?.getComponentInChildren(StickyOverlayController)
            ?? null;
        const topUpMgr = loader?.topUpManager
            ?? this.node.scene?.getComponentInChildren(TopUpManager)
            ?? null;
        overlay?.ensureRowCount(rows, topUpMgr);
        if (!overlay && topUpMgr) topUpMgr.ensureRowCount(rows);
    }

    // ─── BUY BONUS ───

    /**
     * Chuyển đổi raw LastSpinResponse (PascalCase hoặc camelCase) từ Enter API
     * thành SpinResponse client format để dùng trong resume normal spin.
     * Balance đã đúng (server đã cộng win vào Cash khi Enter) → remainCash = balance hiện tại.
     */
    private _buildSpinResponseFromRaw(raw: any): SpinResponse {
        const rands: number[]  = raw.Rands ?? raw.rands ?? [];
        const totalWin: number = raw.TotalWin ?? raw.totalWin ?? 0;
        const totalBet: number = raw.TotalBet ?? raw.totalBet ?? 0;
        const winGrade: string = raw.WinGrade ?? raw.winGrade ?? '';
        Log.d(`[RESUME-DEBUG] _buildSpinResponseFromRaw — rands=${JSON.stringify(rands)}, totalWin=${totalWin}, totalBet=${totalBet}, winGrade=${winGrade}, matchedLines=${(raw.MatchedLinePays ?? raw.matchedLinePays ?? []).length}`);

        const rawLines: any[] = raw.MatchedLinePays ?? raw.matchedLinePays ?? [];
        const matchedLinePays: MatchedLinePay[] = rawLines.map((l: any) => ({
            payLineIndex:          l.PayLineIndex          ?? l.payLineIndex          ?? 0,
            payout:                l.Payout                ?? l.payout                ?? 0,
            matchedSymbols:        l.MatchedSymbols        ?? l.matchedSymbols        ?? [],
            containsWild:          l.ContainsWild          ?? l.containsWild          ?? false,
            reelCnt:               l.ReelCnt               ?? l.reelCnt               ?? 0,
            matchedSymbolsIndices: l.MatchedSymbolsIndices ?? l.matchedSymbolsIndices ?? null,
        }));

        return {
            rands,
            waysPayWins: [],
            matchedLinePays,
            totalBet,
            totalWin,
            updateCash: false,          // Balance đã đúng từ Enter.Cash — không cộng thêm
            nextStage: SlotStageType.SPIN,
            winGrade:    winGrade || undefined,
            remainCash:  WalletManager.instance.balance,  // Sync về balance hiện tại (no-op)
        };
    }

    /** Người chơi bấm nút Buy Bonus → gọi API lấy danh sách gói */
    private async _onBuyBonusRequest(): Promise<void> {
        if (this._isSpinning || this._gameState !== GameState.IDLE) {
            Log.w(`[BuyBonus] Request bị bỏ qua — isSpinning=${this._isSpinning}, gameState=${this._gameState}`);
            return;
        }
        if (this._isFreeSpin()) {
            Log.w(`[BuyBonus] Không cho mua khi đang Free Spin (stage=${this._currentStage})`);
            return;
        }

        Log.d('[BuyBonus] Đang tải danh sách gói mua bonus...');
        try {
            const items = await NetworkManager.instance.sendFeatureItemGet();
            Log.d(`[BuyBonus] Tải xong ${items.length} gói — emit BUY_BONUS_ITEMS_LOADED`);
            EventBus.instance.emit(GameEvents.BUY_BONUS_ITEMS_LOADED, items);
        } catch (err: any) {
            Log.e('[BuyBonus] FeatureItemGet failed:', err.message || err);
            EventBus.instance.emit(GameEvents.BUY_BONUS_FAILED, err.message || 'Failed to load items');
        }
    }

    /** Người chơi xác nhận mua gói Feature */
    private async _onBuyBonusConfirm(item: FeatureItem): Promise<void> {
        if (this._isSpinning || this._isFreeSpin()) return;

        // Giá tuyệt đối = priceRatio × totalBet
        const cost = item.priceRatio * BetManager.instance.totalBet;

        Log.d(`[BuyBonus] Xác nhận mua: "${item.title}" | itemId=${item.itemId} | cost=${cost}`);

        // Kiểm tra balance
        const wallet = WalletManager.instance;
        if (!wallet.canAfford(cost)) {
            Log.w(`[BuyBonus] Không đủ số dư: balance=${wallet.balance} < cost=${cost}`);
            EventBus.instance.emit(GameEvents.BUY_BONUS_FAILED, 'Insufficient balance');
            EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, {
                popupCase: PopupCase.INSUFFICIENT_BALANCE,
                onConfirm: async () => {
                    try {
                        const result = await NetworkManager.instance.sendBalanceGet();
                        WalletManager.instance.balance = result.balance;
                    } catch (e) {
                        Log.w('[BuyBonus] Refresh balance failed:', e);
                    }
                },
            });
            return;
        }

        this._gameState = GameState.POPUP;
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);

        try {
            Log.d(`[BuyBonus] Gửi FeatureItemBuy(itemId=${item.itemId})...`);
            const result = await NetworkManager.instance.sendFeatureItemBuy(item.itemId, false);
            Log.d(`[BuyBonus] FeatureItemBuy response: isSuccess=${result.isSuccess}, remainCash=${result.remainCash}, hasRes=${!!result.res}`);

            if (!result.isSuccess) {
                this._gameState = GameState.IDLE;
                EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
                EventBus.instance.emit(GameEvents.BUY_BONUS_FAILED, 'Purchase rejected by server');
                return;
            }

            // Cập nhật balance sau khi trừ tiền mua
            WalletManager.instance.balance = result.remainCash;
            EventBus.instance.emit(GameEvents.BALANCE_UPDATED, result.remainCash);
            Log.d(`[BuyBonus] Balance cập nhật → ${result.remainCash}`);

            // Emit SUCCESS để BuyBonus popup đóng
            EventBus.instance.emit(GameEvents.BUY_BONUS_SUCCESS, { remainCash: result.remainCash });

            // Carnival: Mighty / Mega / Super → Matsuri Hold&Spin (5×3 / 5×4 / 5×5)
            const matsuri = buildBuyBonusMatsuriTrigger(item.itemId)
                ?? buildBuyBonusMatsuriTriggerFromKind(item.carnivalKind)
                ?? buildBuyBonusMatsuriTriggerFromKind(
                    carnivalKindFromBuyBonusTitle(item.title || item.name),
                );
            if (matsuri) {
                Log.d(`[BuyBonus] Vào Matsuri: "${matsuri.featureName}" 5x${matsuri.matsuriRows}`);
                this._showMatsuriStartPopupThenEnter(matsuri);
                return;
            }

            // Legacy fallback: Free Spin buy
            const freeSpinCount = result.res?.RemainFreeSpinCount
                ?? result.res?.remainFreeSpinCount
                ?? item.addSpinValue
                ?? 10;
            Log.d(`[BuyBonus] Số Free Spin sẽ nhận: ${freeSpinCount}`);

            this._currentStage = SlotStageType.BUY_FREE_SPIN_START;
            this._gameState = GameState.POPUP;
            this._enterFreeSpin(freeSpinCount);

        } catch (err: any) {
            Log.e('[BuyBonus] FeatureItemBuy failed:', err.message || err);
            this._gameState = GameState.IDLE;
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
            EventBus.instance.emit(GameEvents.BUY_BONUS_FAILED, err.message || 'Purchase failed');
            // Nếu NetworkManager đã emit popup (ServerApiError.alreadyHandled), không emit lại
            if (!(err instanceof ServerApiError && err.alreadyHandled)) {
                EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, { popupCase: PopupCase.DISCONNECTED });
            }
        }
    }

    /** Activate item (EffectType 2/3): gọi FeatureItemBuy, không vào FreeSpin */
    private async _onBuyBonusActivate(item: FeatureItem): Promise<void> {
        if (this._isSpinning || this._isFreeSpin()) return;

        Log.d(`[BuyBonus] Activate: "${item.title}" | itemId=${item.itemId} | priceRatio=${item.priceRatio}`);
        try {
            const result = await NetworkManager.instance.sendFeatureItemBuy(item.itemId, true);
            Log.d(`[BuyBonus] Activate response: isSuccess=${result.isSuccess}, remainCash=${result.remainCash}`);

            if (!result.isSuccess) {
                EventBus.instance.emit(GameEvents.BUY_BONUS_FAILED, 'Activate rejected by server');
                return;
            }

            // Activate-type items không deduct balance ngay — chỉ cập nhật nếu server trả giá trị hợp lệ
            if (result.remainCash > 0) {
                WalletManager.instance.balance = result.remainCash;
            }
            // Nếu server trả RemainCash=0 (behaviour bình thường với activate) → không update balance,
            // tránh làm balanceLabel nhảy về 0 rồi lại lên

            GameData.instance.isPurchaseReelActive = true;

            // Emit SUCCESS trước để BuyBonusManager cập nhật internal state (activeActivateItemId, _activeItemPriceRatio)
            // Sau đó mới emit BUY_BONUS_TOTAL_BET_CHANGED để UIController ghi đè betLabel cuối cùng với đúng format
            EventBus.instance.emit(GameEvents.BUY_BONUS_ACTIVATE_SUCCESS, {
                itemId: item.itemId,
                priceRatio: item.priceRatio,
                remainCash: result.remainCash,
            });

            // Thông báo UIController cập nhật Total Bet display (×ratio, đổi màu)
            const adjustedBet = BetManager.instance.totalBet * item.priceRatio;
            EventBus.instance.emit(GameEvents.BUY_BONUS_TOTAL_BET_CHANGED, { displayBet: adjustedBet, isActive: true });
        } catch (err: any) {
            Log.e('[BuyBonus] Activate failed:', err.message || err);
            EventBus.instance.emit(GameEvents.BUY_BONUS_FAILED, err.message || 'Activate failed');
        }
    }

    /** Deactivate item: gọi FeatureItemBuy với ItemId=0 (cancellation) */
    private async _onBuyBonusDeactivate(): Promise<void> {
        Log.d('[BuyBonus] Deactivate — gọi FeatureItemBuy(0) for cancellation');
        try {
            const result = await NetworkManager.instance.sendFeatureItemBuy(0, false);
            Log.d(`[BuyBonus] Deactivate response: isSuccess=${result.isSuccess}`);
            if (!result.isSuccess) {
                EventBus.instance.emit(GameEvents.BUY_BONUS_FAILED, 'Deactivate rejected by server');
                return;
            }

            // Doc: On cancellation RemainCash is always 0 — refresh balance from server
            const balanceResult = await NetworkManager.instance.sendBalanceGet();
            WalletManager.instance.balance = balanceResult.balance;

            GameData.instance.isPurchaseReelActive = false;

            // Emit DEACTIVATE_SUCCESS trước để BuyBonusManager clear internal state
            // Sau đó mới emit BUY_BONUS_TOTAL_BET_CHANGED để UIController ghi đè betLabel cuối cùng với đúng format
            EventBus.instance.emit(GameEvents.BUY_BONUS_DEACTIVATE_SUCCESS);

            // Khôi phục Total Bet display về bình thường
            EventBus.instance.emit(GameEvents.BUY_BONUS_TOTAL_BET_CHANGED, { displayBet: BetManager.instance.totalBet, isActive: false });
        } catch (err: any) {
            Log.e('[BuyBonus] Deactivate failed:', err.message || err);
            EventBus.instance.emit(GameEvents.BUY_BONUS_FAILED, err.message || 'Deactivate failed');
        }
    }

    // ─── FREE SPIN MANAGEMENT ───

    private _enterFreeSpin(count: number, isRetrigger: boolean = false): void {
        const data = GameData.instance;

        if (isRetrigger) {
            // Retrigger: count = TỔNG remaining sau khi cộng lượt mới
            // Real API: server tính sẵn (đã trừ lượt vừa quay + cộng mới)
            // Mock: remaining trước lượt này + 5 (chưa trừ, GameManager SET trực tiếp)
            // → Luôn SET (không cộng) để đảm bảo hiển thị đúng
            data.freeSpinRemaining = count;
        } else {
            // Initial trigger: freeSpinRemaining = 0 trước đó → += = SET
            data.freeSpinRemaining += count;
            // Reset flag retrigger mock để cho phép retrigger trong session mới
            if (!USE_REAL_API) {
                MockDataProvider.resetFreeSpinState();
            }
        }

        // BUG FIX: đặt state POPUP để _afterWinProcessed không set về IDLE,
        // tránh auto-spin kích hoạt trong khi popup retrigger đang hiện.
        this._gameState = GameState.POPUP;

        // Chỉ reset counter khi trigger lần đầu, KHÔNG reset khi retrigger
        if (!isRetrigger) {
            this._freeSpinActualCount = 0;
        }
        EventBus.instance.emit(GameEvents.FREE_SPIN_COUNT_UPDATED, data.freeSpinRemaining);

        // Highlight spine trên vị trí Red sticky trigger (thay cho BONUS scatter cũ)
        // → GoF: Free Spin vào từ Feature Select, không có symbol Scatter trên reel
        EventBus.instance.emit(GameEvents.FREE_SPIN_POPUP, data.freeSpinRemaining);
    }

    /**
     * Prepare FreeSpin Gold UI ngay khi TransitionPopup SHOW (dưới overlay).
     * Spin chỉ gọi ở _startFreespinGoldGameplayAfterTransition (DONE).
     */
    private _prepareFreespinGoldUI(count: number): void {
        const data = GameData.instance;
        data.currentMode = 'freespin_gold';
        data.freeSpinRemaining      = count;
        data.freeSpinGoldRemaining  = count;
        data.freeSpinGoldTotalWin   = 0;
        data.freeSpinTotalWin       = 0;
        this._freeSpinActualCount   = 0;
        this._freeSpinGoldCoinTotal = 0;
        this._freeSpinGoldServerTotalWin = null;
        this._freeSpinGoldCountedKeys.clear();

        // Xoá stickyCells cũ (STICKY_RED từ trigger base game) — tránh đồng đỏ hiển thị dai dẳng trong FreeSpin Gold
        Log.e(`[FreespinGold] stickyCells trước khi clear: ${data.stickyCells.size} entries: [${Array.from(data.stickyCells.keys()).join(',')}]`);
        data.stickyCells.clear();

        // Vào FREE_SPIN stage ngay (không qua popup) — tương tự TopUp
        this._currentStage = SlotStageType.FREE_SPIN;
        this._gameState    = GameState.IDLE;
        this._updateDisplayVisibility(); // freeSpinGoldDisplay ON, jackpotDisplay OFF, multiplierDisplay OFF
        this._updateBackgroundSprite();  // đổi sang freeSpinBackgroundSprites

        // Thông báo SlotMachineController để áp dụng freespin speed + slot background
        EventBus.instance.emit(GameEvents.FREE_SPIN_START);
        EventBus.instance.emit(GameEvents.FREE_SPIN_COUNT_UPDATED, count);
        EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_START, {
            spinsRemaining: count,
            baseCredit:     data.featureBaseCredit ?? 0,
        });
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
        Log.d(`[FreespinGold] UI prepared under TransitionPopup → count=${count}`);
    }

    private _startFreespinGoldGameplayAfterTransition(): void {
        this.scheduleOnce(() => EventBus.instance.emit(GameEvents.SPIN_REQUEST), 0.4);
        Log.d('[FreespinGold] Transition DONE → auto-spin in 0.4s');
    }

    /** Legacy entry — prepare UI + start gameplay (resume / path không qua Transition). */
    private _enterFreespinGold(count: number): void {
        this._prepareFreespinGoldUI(count);
        this._startFreespinGoldGameplayAfterTransition();
    }

    private _enterTopUp(count: number): void {
        void this._enterTopUpAsync(count);
    }

    /** Legacy entry — prepare + gameplay (resume / path không qua Transition). */
    private async _enterTopUpAsync(count: number): Promise<void> {
        this._topUpUiPrepared = false;
        this._topUpStartGameplayPending = false;
        await this._prepareTopUpUI(count);
        this._startTopUpGameplayAfterTransition();
    }

    /**
     * Prepare toàn bộ TopUp UI ngay dưới TransitionPopup (SHOW).
     * StickyOverlay load + TOPUP_START chạy ở đây để khi DONE tắt overlay thì UI đã sẵn.
     */
    private async _prepareTopUpUI(count: number): Promise<void> {
        const data = GameData.instance;
        data.currentMode = 'respin';
        data.respinRemaining = count > 0 ? count : 6;
        data.respinTotalWin = 0;
        this._topUpStickySnapshot.clear();
        this._topUpRemainBeforeSpin = 0;
        this._currentStage = SlotStageType.TOPUP_SPIN;
        this._gameState = GameState.IDLE;
        this._updateDisplayVisibility();
        this._updateBackgroundSprite();

        // ★ Rebuild stickyCells từ topupReel (5-column coordinates) thay vì giữ 3-column từ normal spin.
        // Điều này đảm bảo _handleTopUpReelsStopped so sánh đúng key khi detect new cells.
        const lastResp = data.lastSpinResponse;
        if (lastResp?.topupReel && lastResp.topupReel.length > 0) {
            // Giữ credit đã tính từ normal spin — server TopupReel thường có Type/Index nhưng Win=0.
            const prevCredits = new Map<string, number>();
            for (const [key, cell] of data.stickyCells.entries()) {
                if ((cell.credit ?? 0) > 0) prevCredits.set(key, cell.credit!);
            }
            data.stickyCells.clear();
            for (let i = 0; i < Math.min(15, lastResp.topupReel.length); i++) {
                const slot = lastResp.topupReel[i];
                if (slot.type === TopupReelType.NONE) continue;
                const apiRow = Math.floor(i / 5);
                const reel = i % 5;
                const row = 2 - apiRow; // Server row order is inverted against StickyOverlay/TopUp visual slots.
                if (slot.type !== TopupReelType.RED) {
                    Log.e(
                        `[TOPUP-ENTER-CHECK] skip non-red initial cell slot=${i} visual=${reel}-${row}` +
                        ` type=${slot.type} win=${slot.win} index=${slot.index}`
                    );
                    continue;
                }
                const symbolId = SymbolId.STICKY_RED;
                const key = `${reel}-${row}`;
                const credit = (slot.win > 0 ? slot.win : prevCredits.get(key)) ?? slot.win ?? 0;
                data.stickyCells.set(key, { reel, row, symbolId, credit });
            }
            Log.e(`[TopUp] _prepareTopUpUI: rebuilt stickyCells from topupReel → ${data.stickyCells.size} cells (5-col coords)`);
        } else {
            Log.e(`[TopUp] _prepareTopUpUI: no topupReel in lastSpinResponse — keeping existing stickyCells (${data.stickyCells.size})`);
        }

        for (const [key, cell] of Array.from(data.stickyCells.entries())) {
            if (cell.symbolId !== SymbolId.STICKY_RED) {
                data.stickyCells.delete(key);
                Log.e(`[TOPUP-ENTER-CHECK] drop stale non-red sticky key=${key} symbol=${SymbolId[cell.symbolId] ?? cell.symbolId} credit=${cell.credit ?? 0}`);
            }
        }

        const enterIdx0 = data.stickyCells.get('0-0');
        Log.e(
            `[TOPUP-ENTER-CHECK] idx0=${enterIdx0 ? `${SymbolId[enterIdx0.symbolId] ?? enterIdx0.symbolId} credit=${enterIdx0.credit ?? 0}` : 'empty'}` +
            ` stickyKeys=${Array.from(data.stickyCells.keys()).join('|') || 'none'}`
        );

        data.featureBaseCredit = this._sumTopUpBaseCredit(Array.from(data.stickyCells.values()));
        data.respinTotalWin = data.featureBaseCredit;
        Log.e(`[TOPUP-CREDIT][GM] prepareTopUpUI baseCredit=${data.featureBaseCredit} initialTotal=${data.respinTotalWin} cells=${data.stickyCells.size}`);

        // Lazy-load StickyOverlay (+ TopUpManager) trước khi emit TOPUP_START
        await this._ensureStickyOverlayLoaded();
        this._applyStickyOverlayRowCount(3);

        EventBus.instance.emit(GameEvents.TOPUP_START, {
            spinsRemaining: data.respinRemaining,
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
            stickyCells: Array.from(data.stickyCells.values()),
        });
        EventBus.instance.emit(GameEvents.TOPUP_COUNT_UPDATED, data.respinRemaining);
        EventBus.instance.emit(GameEvents.TOPUP_TOTAL_UPDATED, {
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
        });
        EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);

        this._topUpFirstSpinDelay = this._topUpEnterAnimWait(data.stickyCells.size);
        this._topUpUiPrepared = true;
        Log.d(`[TopUp] UI prepared under TransitionPopup — firstSpinDelay=${this._topUpFirstSpinDelay}`);

        // DONE đã tới trước khi prepare xong → start gameplay ngay
        if (this._topUpStartGameplayPending) {
            this._topUpStartGameplayPending = false;
            this._scheduleTopUpFirstSpin();
        }
    }

    private _startTopUpGameplayAfterTransition(): void {
        if (!this._topUpUiPrepared) {
            this._topUpStartGameplayPending = true;
            Log.d('[TopUp] Transition DONE nhưng UI chưa prepared — chờ _prepareTopUpUI');
            return;
        }
        this._scheduleTopUpFirstSpin();
    }

    private _scheduleTopUpFirstSpin(): void {
        const delay = this._topUpFirstSpinDelay;
        this.scheduleOnce(() => EventBus.instance.emit(GameEvents.SPIN_REQUEST), delay);
        Log.d(`[TopUp] Transition DONE → first SPIN_REQUEST in ${delay}s`);
    }

    /** Chờ overlay fade + coin bounce stagger xong trước spin đầu TopUp. */
    private _topUpEnterAnimWait(redCount: number): number {
        const fade = 0.4;
        const stagger = Math.max(0, redCount - 1) * 0.07;
        const bounce = 0.22 + 0.32;
        return fade + stagger + bounce + 0.15;
    }

    private _handleTopUpReelsStopped(resp: SpinResponse): void {
        const data = GameData.instance;
        this.unschedule(this._spinCycleFallback);

        // ── Detect +1 Spin: compare remainRespinCount trước và sau ──
        // prevRemain = data.respinRemaining đã bị giảm 1 trong performSpin() trước khi request.
        // newRemain = số lần quay còn lại server trả về sau spin này.
        // Bình thường: newRemain == prevRemain (server confirm đúng).
        // Có +1 Spin: newRemain = prevRemain + N → plusOneSpinCount = N.
        const prevRemain = data.respinRemaining;
        const remainBeforeSpin = this._topUpRemainBeforeSpin || prevRemain;
        const newRemain = resp.remainRespinCount ?? prevRemain;
        const plusOneSpinCount = Math.max(0, newRemain - prevRemain);
        Log.e(`[TOPUP-PLUS] remain beforeSpin=${remainBeforeSpin} afterLocalConsume=${prevRemain} server=${newRemain} plusOneCount=${plusOneSpinCount}`);
        if (plusOneSpinCount === 0) {
            const overlays = this.node.scene?.getComponentsInChildren(StickyOverlayController) ?? [];
            for (const overlay of overlays) {
                overlay.clearTempPlusOne('server-no-plus');
            }
        }
        Log.e(
            `[TOPUP-CREDIT][GM] reelsStopped rawTotals spinTotal=${resp.totalWin ?? 'n/a'}` +
            ` featureTotal=${resp.featureSpinTotalWin ?? 'n/a'} beforeClientTotal=${data.respinTotalWin}` +
            ` beforeEachWin=${data.topUpDisplayedEachWin} stickyBefore=${data.stickyCells.size}`
        );

        // ── Detect NEW cells: so sánh resp.stickyCells vs snapshot trước spin ──
        // Dùng _topUpStickySnapshot vì cells có thể đã được pre-add per-reel trong _onTopUpReelCoinLanded
        const newCells: StickyCell[] = [];

        if (resp.stickyCells) {
            Log.e(`[TopUp-DEBUG] resp.stickyCells count=${resp.stickyCells.length} data.stickyCells size=${data.stickyCells.size}`);
            Log.e(`[TopUp-DEBUG] resp cells: ${resp.stickyCells.map(c => `${c.reel}-${c.row}:${SymbolId[c.symbolId] ?? c.symbolId}($${c.credit})`).join(', ')}`);
            Log.e(`[TopUp-DEBUG] existing keys: ${Array.from(data.stickyCells.keys()).join(', ')}`);
            for (const cell of resp.stickyCells) {
                const key = `${cell.reel}-${cell.row}`;
                const wasExistingBeforeSpin = this._topUpStickySnapshot?.has(key) ?? false;
                const existingCell = data.stickyCells.get(key);

                // Cell đã tồn tại từ spin trước → KHÔNG phải new (bỏ qua)
                if (wasExistingBeforeSpin && existingCell) {
                    Log.e(`[TopUp-DEBUG]   ${key}: EXISTING (${SymbolId[existingCell.symbolId]}→${SymbolId[cell.symbolId]})`);
                    // Cập nhật credit nếu server gửi giá trị mới (Yellow/Green có thể thay đổi do absorb)
                    if (existingCell.symbolId === SymbolId.STICKY_YELLOW || existingCell.symbolId === SymbolId.STICKY_GREEN) {
                        existingCell.credit = existingCell.credit ?? 0;
                    } else if ((cell.credit ?? 0) > 0) {
                        existingCell.credit = cell.credit;
                    }
                    continue;
                }

                Log.e(`[TopUp-DEBUG]   ${key}: NEW ${SymbolId[cell.symbolId] ?? cell.symbolId} credit=${cell.credit}`);
                if (cell.symbolId === SymbolId.PLUS_ONE_SPIN && plusOneSpinCount <= 0) {
                    Log.e(`[TOPUP-PLUS] DROP stale parsed +1 cell key=${key} because plusOneCount=0`);
                    continue;
                }
                if (cell.symbolId === SymbolId.STICKY_YELLOW || cell.symbolId === SymbolId.STICKY_GREEN) {
                    Log.e(`[TOPUP-CREDIT][GM] serverNewCoin key=${key} symbol=${SymbolId[cell.symbolId]} credit=${cell.credit} snapshotHad=${wasExistingBeforeSpin}`);
                }

                // Cell MỚI spin này
                if (cell.symbolId === SymbolId.PLUS_ONE_SPIN) {
                    // +1 Spin — track vị trí cho effect và lock reel lần sau
                    newCells.push(cell);
                    data.stickyCells.set(key, cell);
                    this._lockTopUpCell(cell);
                    continue;
                }

                // Yellow/Green MỚI → absorb effect
                if (cell.symbolId === SymbolId.STICKY_YELLOW || cell.symbolId === SymbolId.STICKY_GREEN) {
                    newCells.push(cell);
                    // ★ NEW Yellow/Green: credit = 0 trong stickyCells (label ẩn cho đến khi absorb xong)
                    data.stickyCells.set(key, { ...cell, credit: 0 });
                    this._lockTopUpCell(cell);
                    Log.e(`[TOPUP-CREDIT][GM] clientStoreNewCoin key=${key} symbol=${SymbolId[cell.symbolId]} serverCredit=${cell.credit} storedCredit=0 reason=waitAbsorb`);
                    continue;
                }

                // Thêm vào stickyCells map (Red/Yellow/Green đều sticky)
                data.stickyCells.set(key, cell);
                this._lockTopUpCell(cell);
            }
        } else {
            Log.e(`[TopUp-DEBUG] ⚠ resp.stickyCells is NULL/UNDEFINED — no cells parsed from server response!`);
            Log.e(`[TopUp-DEBUG] ⚠ Nguyên nhân có thể: server không trả TopupReel/NormalSpinLinkReel, fallback parser không chạy, hoặc currentMode sai`);
        }

        Log.e(`[TopUp-DEBUG] AFTER: newCells=${newCells.length} (${newCells.map(c => `${c.reel}-${c.row}:${SymbolId[c.symbolId]}`).join(',')}) | data.stickyCells=${data.stickyCells.size} keys=[${Array.from(data.stickyCells.keys()).join(',')}]`);
        if (newCells.length === 0) {
            Log.e(`[TopUp-DEBUG] ⚠ newCells RỖNG → TOPUP_ABSORB_START sẽ KHÔNG emit → không có hiệu ứng hút xu!`);
            Log.e(`[TopUp-DEBUG] ⚠ Nếu Yellow/Green đã tồn tại trong stickyCells trước spin, chúng bị coi là EXISTING → không vào newCells`);
        }

        // ── Synthesize PLUS_ONE_SPIN cell khi server tăng remainRespinCount nhưng TopupReel
        //    không chứa ô PLUS_ONE_SPIN (real API không map Type → PLUS_ONE_SPIN).
        //    Cần cell này để _stepPlusOneSpin biết vị trí coin trên grid → highlight + fly animation.
        //    Tìm vị trí trong respinReelStrips + rands mà symbol là PLUS_ONE_SPIN và slot còn trống.
        if (plusOneSpinCount > 0 && !newCells.some(c => c.symbolId === SymbolId.PLUS_ONE_SPIN)) {
            const strips = data.config.respinReelStrips;
            const rands  = resp.rands ?? [];
            const plusOneKeys = new Set<string>();
            const topupSlots = resp.topupReel ?? [];
            for (let topUpIdx = 0; topUpIdx < 15; topUpIdx++) {
                const reel = Math.floor(topUpIdx / 3);
                const row = topUpIdx % 3;
                const apiRow = 2 - row;
                const serverIdx = apiRow * 5 + reel;
                const slot = topupSlots[serverIdx];
                if (!slot) continue;
                const strip = strips[reel] ?? [];
                if (strip.length === 0) continue;
                const stripIdx = ((slot.index % strip.length) + strip.length) % strip.length;
                if (strip[stripIdx] !== SymbolId.PLUS_ONE_SPIN) continue;
                const key = `${reel}-${row}`;
                if (!data.stickyCells.has(key) && !plusOneKeys.has(key) && plusOneKeys.size < plusOneSpinCount) {
                    const synthCell: StickyCell = { reel, row, symbolId: SymbolId.PLUS_ONE_SPIN, credit: 0 };
                    newCells.push(synthCell);
                    plusOneKeys.add(key);
                    Log.e(`[TOPUP-PLUS] synth ${key} from TopupReel topUpIdx=${topUpIdx} serverIdx=${serverIdx} index=${slot.index} count=${plusOneKeys.size}/${plusOneSpinCount}`);
                }
            }
            outer:
            for (let reel = 0; false && plusOneKeys.size < plusOneSpinCount && reel < strips.length; reel++) {
                const strip = strips[reel] ?? [];
                const len   = strip.length || 1;
                const rand  = rands[reel] ?? 0;
                const center = ((rand % len) + len) % len;
                // row0=top=center+1, row1=mid=center, row2=bottom=center-1
                for (let row = 0; row < (data.config.rowCount ?? 3); row++) {
                    const stripIdx = ((center + (1 - row)) % len + len) % len;
                    if (strip[stripIdx] === SymbolId.PLUS_ONE_SPIN) {
                        const key = `${reel}-${row}`;
                        if (!data.stickyCells.has(key) && !plusOneKeys.has(key)) {
                            const synthCell: StickyCell = { reel, row, symbolId: SymbolId.PLUS_ONE_SPIN, credit: 0 };
                            newCells.push(synthCell);
                            plusOneKeys.add(key);
                            Log.e(`[TOPUP-PLUS] synth ${key} from respinStrip count=${plusOneKeys.size}/${plusOneSpinCount}`);
                            if (plusOneKeys.size >= plusOneSpinCount) break outer;
                        }
                    }
                }
            }
            if (plusOneKeys.size < plusOneSpinCount) {
                Log.e(`[TOPUP-PLUS] WARNING expected=${plusOneSpinCount} found=${plusOneKeys.size}; no fallback cell used to avoid wrong +1 position`);
                const detail = [];
                for (let topUpIdx = 0; topUpIdx < 15; topUpIdx++) {
                    const reel = Math.floor(topUpIdx / 3);
                    const row = topUpIdx % 3;
                    const apiRow = 2 - row;
                    const serverIdx = apiRow * 5 + reel;
                    const slot = topupSlots[serverIdx];
                    const strip = strips[reel] ?? [];
                    const stripIdx = slot && strip.length > 0 ? ((slot.index % strip.length) + strip.length) % strip.length : -1;
                    const symbolId = stripIdx >= 0 ? strip[stripIdx] : undefined;
                    const key = `${reel}-${row}`;
                    const sticky = data.stickyCells.get(key);
                    detail.push(`${topUpIdx}>${serverIdx}:${key} t=${slot?.type ?? 'n/a'} idx=${slot?.index ?? 'n/a'} stripIdx=${stripIdx} sym=${symbolId == null ? 'none' : (SymbolId[symbolId] ?? symbolId)} sticky=${sticky ? (SymbolId[sticky.symbolId] ?? sticky.symbolId) : 'empty'}`);
                }
                Log.e(`[TOPUP-PLUS] noVisualPlus candidates ${detail.join('|')}`);
                // Không tìm thấy vị trí cụ thể → dùng cell giả reel=0 row=1 (mid) để effect vẫn chạy
                Log.e(`[TopUp-DEBUG] +1Spin: không tìm được vị trí trong strip → dùng fallback cell (0-1)`);
            }
        }

        this._logTopupSpinResultGrid(resp, 'STOPPED', newCells);

        const beforeTotalUpdate = data.respinTotalWin;
        data.respinTotalWin = resp.featureSpinTotalWin ?? resp.totalWin ?? data.respinTotalWin;
        const serverDeltaWin = Math.max(0, data.respinTotalWin - beforeTotalUpdate);
        const hasMoneyAbsorb = newCells.some(c => c.symbolId === SymbolId.STICKY_YELLOW || c.symbolId === SymbolId.STICKY_GREEN);
        const stickyValues = Array.from(data.stickyCells.values());
        const redCreditSum = stickyValues
            .filter(c => c.symbolId === SymbolId.STICKY_RED)
            .reduce((sum, c) => sum + (c.credit ?? 0), 0);
        const yellowCreditSum = stickyValues
            .filter(c => c.symbolId === SymbolId.STICKY_YELLOW)
            .reduce((sum, c) => sum + (c.credit ?? 0), 0);
        const greenCreditSum = stickyValues
            .filter(c => c.symbolId === SymbolId.STICKY_GREEN)
            .reduce((sum, c) => sum + (c.credit ?? 0), 0);
        const topUpSpinOrdinal = Math.max(1, 7 - remainBeforeSpin);
        Log.e(
            `[TOPUP-CREDIT][GM] totalUpdate before=${beforeTotalUpdate}` +
            ` resp.FeatureSpinTotalWin=${resp.featureSpinTotalWin ?? 'n/a'} resp.TotalWin=${resp.totalWin ?? 'n/a'}` +
            ` after=${data.respinTotalWin} serverDelta=${serverDeltaWin} hasMoneyAbsorb=${hasMoneyAbsorb ? 1 : 0}` +
            ` spinOrdinal=${topUpSpinOrdinal} baseCredit=${data.featureBaseCredit}` +
            ` redSum=${redCreditSum} yellowSum=${yellowCreditSum} greenSum=${greenCreditSum}`
        );
        if (serverDeltaWin > 0 && !hasMoneyAbsorb) {
            const looksLikeImplicitBase = redCreditSum > 0 && (serverDeltaWin === redCreditSum || serverDeltaWin === redCreditSum * 2 || serverDeltaWin === data.featureBaseCredit || serverDeltaWin === data.featureBaseCredit * 2);
            Log.e(
                `[TOPUP-CREDIT][GM] WARNING serverDeltaNoNewCoin delta=${serverDeltaWin}` +
                ` before=${beforeTotalUpdate} after=${data.respinTotalWin}` +
                ` spinOrdinal=${topUpSpinOrdinal} baseCredit=${data.featureBaseCredit}` +
                ` redSum=${redCreditSum} looksLikeImplicitBase=${looksLikeImplicitBase ? 1 : 0}` +
                ` parsedCells=${resp.stickyCells?.map(c => `${c.reel}-${c.row}:${SymbolId[c.symbolId] ?? c.symbolId}=${c.credit ?? 0}`).join('|') || 'none'}`
            );
        }
        if (resp.remainRespinCount != null) {
            data.respinRemaining = Math.max(0, resp.remainRespinCount);
        }
        // If +1 landed, TopUpAbsorbEffect emits the server count in sync with the +1 visual.
        if (plusOneSpinCount === 0) {
            EventBus.instance.emit(GameEvents.TOPUP_COUNT_UPDATED, data.respinRemaining);
        }
        EventBus.instance.emit(GameEvents.TOPUP_TOTAL_UPDATED, {
            baseCredit: data.featureBaseCredit,
            totalWin: data.respinTotalWin,
            topupReel: resp.topupReel,
            deferEachWin: hasMoneyAbsorb,
        });
        Log.e(`[TOPUP-CREDIT][GM] emitTotal baseCredit=${data.featureBaseCredit} totalWin=${data.respinTotalWin} serverDelta=${serverDeltaWin} deferEachWin=${hasMoneyAbsorb ? 1 : 0} newCells=${newCells.map(c => `${c.reel}-${c.row}:${SymbolId[c.symbolId] ?? c.symbolId}=${c.credit ?? 0}`).join('|') || 'none'}`);

        const topupSlots = resp.topupReel ?? [];
        const filled = topupSlots.slice(0, 15).filter(s => s.type !== 0).length;
        Log.d(`[TopUp] reels stopped — filled=${filled}/15 remain=${data.respinRemaining} total=${data.respinTotalWin} nextStage=${resp.nextStage} newAbsorb=${newCells.length} +1spin=${plusOneSpinCount}`);

        this._isSpinning = false;

        // Safety guard: nếu remain=0 và không có +1 Spin nhưng nextStage không phải END → ép END
        let effectiveNextStage = resp.nextStage as SlotStageType;
        if (data.respinRemaining <= 0 && plusOneSpinCount <= 0) {
            const isEndStage = effectiveNextStage === SlotStageType.TOPUP_SPIN_END || effectiveNextStage === SlotStageType.RESPIN_END;
            if (!isEndStage) {
                Log.e(`[TopUp] ⚠️ remain=0 nhưng nextStage=${effectiveNextStage} không phải END → ép TOPUP_SPIN_END`);
                effectiveNextStage = SlotStageType.TOPUP_SPIN_END;
            }
        }

        // [TEMP] Tắt absorb effect nếu _skipTopUpAbsorb = true
        if (this._skipTopUpAbsorb) {
            Log.w('[TopUp] _skipTopUpAbsorb=true → skip absorb, transition ngay');
            this._transitionStage(effectiveNextStage);
            if (this._gameState !== GameState.POPUP) {
                this._gameState = GameState.IDLE;
            }
            return;
        }

        // Nếu có cells mới hoặc +1 Spin → chạy absorb effect trước khi transition
        if (newCells.length > 0 || plusOneSpinCount > 0) {
            let absorbDone = false;
            const onAbsorbDone = () => {
                if (absorbDone) return;
                absorbDone = true;
                this.unschedule(absorbTimeout);
                EventBus.instance.off(GameEvents.TOPUP_ABSORB_DONE, onAbsorbDone, this);
                this._transitionStage(effectiveNextStage);
                if (this._gameState !== GameState.POPUP) {
                    this._gameState = GameState.IDLE;
                }
            };
            // Fallback: nếu TopUpAbsorbEffect không có trong scene (chưa setup), tiếp tục sau 30s
            // (absorb nhiều coin có thể kéo dài 10-20s)
            const absorbTimeout = () => {
                Log.e('[TopUp] TOPUP_ABSORB_DONE timeout — TopUpAbsorbEffect chưa được gắn vào scene!');
                onAbsorbDone();
            };
            this.scheduleOnce(absorbTimeout, 30);
            EventBus.instance.on(GameEvents.TOPUP_ABSORB_DONE, onAbsorbDone, this);
            EventBus.instance.emit(GameEvents.TOPUP_ABSORB_START, {
                newCells,
                plusOneSpinCount,
                allStickyCells: data.stickyCells,
                newSpinCount: data.respinRemaining,
                serverDeltaWin,
                serverTotalWin: data.respinTotalWin,
            });
            Log.e(`[TOPUP-CREDIT][GM] emitAbsorbStart newCells=${newCells.map(c => `${c.reel}-${c.row}:${SymbolId[c.symbolId] ?? c.symbolId}=${c.credit ?? 0}`).join('|') || 'none'} stickyCredits=${Array.from(data.stickyCells.values()).map(c => `${c.reel}-${c.row}:${SymbolId[c.symbolId] ?? c.symbolId}=${c.credit ?? 0}`).join('|')}`);
        } else {
            // Không có gì mới → transition ngay
            this._transitionStage(effectiveNextStage);
            if (this._gameState !== GameState.POPUP) {
                this._gameState = GameState.IDLE;
            }
        }
    }

    private _logTopupSpinResultGrid(resp: SpinResponse, source: string, transientCells: StickyCell[] = []): void {
        const slots = resp.topupReel ?? [];
        const data = GameData.instance;
        const strips = GameData.instance.config.respinReelStrips;
        if (slots.length === 0) {
            Log.e(`[TOPUP-GRID][${source}] server=[] overlay=[] topup=[]`);
            return;
        }
        const getSymbolId = (serverIdx: number): number => {
            const slot = slots[serverIdx];
            if (!slot) return -1;
            const type = slot.type ?? (slot as any).Type ?? TopupReelType.NONE;
            const index = slot.index ?? (slot as any).Index ?? 0;
            if (type === TopupReelType.RED) return SymbolId.STICKY_RED;
            if (type === TopupReelType.YELLOW) return SymbolId.STICKY_YELLOW;
            if (type === TopupReelType.GREEN) return SymbolId.STICKY_GREEN;
            if (type === TopupReelType.GRAND) return SymbolId.JP_GRAND;
            const reel = serverIdx % 5;
            const strip = strips[reel] ?? [];
            const stripIdx = strip.length > 0 ? ((index % strip.length) + strip.length) % strip.length : -1;
            return stripIdx >= 0 ? strip[stripIdx] : -1;
        };
        const transientPlusKeys = new Set(
            transientCells
                .filter(c => c.symbolId === SymbolId.PLUS_ONE_SPIN)
                .map(c => `${c.reel}-${c.row}`)
        );
        const isTopUpSpecial = (symbolId: number): boolean => {
            return symbolId === SymbolId.STICKY_RED ||
                symbolId === SymbolId.STICKY_YELLOW ||
                symbolId === SymbolId.STICKY_GREEN ||
                symbolId === SymbolId.JP_GRAND ||
                symbolId === SymbolId.PLUS_ONE_SPIN;
        };
        const fallbackNonBonus = (reel: number): number => {
            const strip = strips[reel] ?? [];
            for (const symbolId of strip) {
                if (!isTopUpSpecial(symbolId)) return symbolId;
            }
            return SymbolId.MAJOR_CLEOPATRA;
        };

        const serverGrid: number[][] = [];
        const serverVisualGrid: number[][] = [];
        const serverStickyGrid: number[][] = [];
        const serverCreditGrid: number[][] = [];
        for (let row = 0; row < 3; row++) {
            const cells: number[] = [];
            const visualCells: number[] = [];
            const stickyCells: number[] = [];
            const creditCells: number[] = [];
            for (let col = 0; col < 5; col++) {
                const serverIdx = (2 - row) * 5 + col;
                const slot = slots[serverIdx];
                const type = slot?.type ?? (slot as any)?.Type ?? TopupReelType.NONE;
                const credit = slot?.win ?? (slot as any)?.Win ?? 0;
                const rawSymbolId = getSymbolId(serverIdx);
                let visualSymbolId = rawSymbolId;
                if (type === TopupReelType.NONE && isTopUpSpecial(rawSymbolId)) {
                    const key = `${col}-${row}`;
                    visualSymbolId = rawSymbolId === SymbolId.PLUS_ONE_SPIN && transientPlusKeys.has(key)
                        ? SymbolId.PLUS_ONE_SPIN
                        : fallbackNonBonus(col);
                }
                cells.push(rawSymbolId);
                visualCells.push(visualSymbolId);
                const key = `${col}-${row}`;
                if (type === TopupReelType.NONE && transientPlusKeys.has(key)) {
                    stickyCells.push(SymbolId.PLUS_ONE_SPIN);
                    creditCells.push(0);
                } else if (type === TopupReelType.RED) {
                    stickyCells.push(SymbolId.STICKY_RED);
                    creditCells.push(credit);
                } else if (type === TopupReelType.YELLOW) {
                    stickyCells.push(SymbolId.STICKY_YELLOW);
                    creditCells.push(credit);
                } else if (type === TopupReelType.GREEN) {
                    stickyCells.push(SymbolId.STICKY_GREEN);
                    creditCells.push(credit);
                } else if (type === TopupReelType.GRAND) {
                    stickyCells.push(SymbolId.JP_GRAND);
                    creditCells.push(credit);
                } else {
                    stickyCells.push(-1);
                    creditCells.push(0);
                }
            }
            serverGrid.push(cells);
            serverVisualGrid.push(visualCells);
            serverStickyGrid.push(stickyCells);
            serverCreditGrid.push(creditCells);
        }

        const overlayGrid: number[][] = Array.from({ length: 3 }, () => Array(5).fill(-1));
        const overlayCreditGrid: number[][] = Array.from({ length: 3 }, () => Array(5).fill(0));
        for (const cell of data.stickyCells.values()) {
            if (cell.reel >= 0 && cell.reel < 5 && cell.row >= 0 && cell.row < 3) {
                overlayGrid[cell.row][cell.reel] = cell.symbolId;
                overlayCreditGrid[cell.row][cell.reel] = cell.credit ?? 0;
            }
        }
        for (const cell of transientCells) {
            if (cell.reel >= 0 && cell.reel < 5 && cell.row >= 0 && cell.row < 3) {
                overlayGrid[cell.row][cell.reel] = cell.symbolId;
                overlayCreditGrid[cell.row][cell.reel] = cell.credit ?? 0;
            }
        }

        const mgr = this.node.scene?.getComponentsInChildren(TopUpManager)?.[0];
        const topUpGrid = mgr?.getDebugClientGrid?.() ?? [];
        const sameGrid = (a: number[][], b: number[][]): boolean => {
            if (a.length !== b.length) return false;
            for (let r = 0; r < a.length; r++) {
                if ((a[r]?.length ?? 0) !== (b[r]?.length ?? 0)) return false;
                for (let c = 0; c < a[r].length; c++) {
                    if (a[r][c] !== b[r][c]) return false;
                }
            }
            return true;
        };
        const topupMatch = topUpGrid.length > 0 && sameGrid(serverVisualGrid, topUpGrid);
        const overlayMatch = sameGrid(serverStickyGrid, overlayGrid);
        Log.e(
            `[TOPUP-GRID][${source}] server=${JSON.stringify(serverGrid)}` +
            ` serverVisual=${JSON.stringify(serverVisualGrid)}` +
            ` serverSticky=${JSON.stringify(serverStickyGrid)}` +
            ` serverCredit=${JSON.stringify(serverCreditGrid)}` +
            ` overlay=${JSON.stringify(overlayGrid)}` +
            ` overlayCredit=${JSON.stringify(overlayCreditGrid)}` +
            ` topup=${JSON.stringify(topUpGrid)}` +
            ` topupMatch=${topupMatch ? 1 : 0}` +
            ` overlayMatch=${overlayMatch ? 1 : 0}`
        );
    }

    private async _handleTopUpClaim(): Promise<void> {
        this._claimTopUpAfterEndPopup = false;
        this._pendingPickAfterMatsuriClaim = null;
        const data = GameData.instance;
        const beforeClaimClientTotal = data.respinTotalWin;
        const beforeClaimEachWin = data.topUpDisplayedEachWin;
        const beforeClaimBalance = WalletManager.instance.balance;
        try {
            const result = await NetworkManager.instance.sendClaimRequest();
            WalletManager.instance.balance = result.balance;
            EventBus.instance.emit(GameEvents.BALANCE_UPDATED, WalletManager.instance.balance);
            GameData.instance.lastClaimWinGrade = result.winGrade;
            Log.e(
                `[TOPUP-END-CHECK] claimResult beforeClient=${beforeClaimClientTotal} eachWinDisplay=${beforeClaimEachWin}` +
                ` parsedWin=${result.winCash ?? 'null'} claimTotalWin=${result.claimTotalWin ?? 'n/a'}` +
                ` topLevelWinCash=${result.topLevelWinCash ?? 'n/a'} balanceBefore=${beforeClaimBalance}` +
                ` balanceAfter=${result.balance} balanceDelta=${result.balance - beforeClaimBalance}` +
                ` nextStage=${result.nextStage ?? 'n/a'}`,
            );
            // Dùng winCash từ server làm totalWin chính thức (giống pattern FreeSpin)
            if (result.winCash != null) {
                Log.e(`[TopUp-CLAIM] winCash từ server: ${result.winCash} (client had: ${data.respinTotalWin})`);
                data.respinTotalWin = result.winCash;
            } else {
                // Server không trả winCash → hiện 0, không dùng số client (tránh hiện sai)
                Log.e(`[TopUp-CLAIM] ⚠ server không trả winCash — hiện 0. Client respinTotalWin=${data.respinTotalWin}`);
                data.respinTotalWin = 0;
            }

            // Ultra/Supreme/Ultimate: Claim trả PICK_START + PickGame → mở Pick sau end popup
            const ns = result.nextStage ?? SlotStageType.SPIN;
            if (ns === SlotStageType.PICK_START || ns === SlotStageType.PICK) {
                const pick = result.pickGame ?? MockDataProvider.buildPickGame();
                data.pickGameState = pick;
                if (data.lastSpinResponse) {
                    data.lastSpinResponse.pickGame = pick;
                    data.lastSpinResponse.nextStage = SlotStageType.PICK_START;
                }
                this._pendingPickAfterMatsuriClaim = pick;
                Log.e('[TopUp-CLAIM] NextStage=PICK_START → sẽ mở Pick sau Matsuri end popup');
            }
        } catch (err) {
            Log.e('[TopUp-CLAIM] ❌ Claim failed — hiện 0:', err);
            data.respinTotalWin = 0;
            this._pendingPickAfterMatsuriClaim = null;
            const popupCase = PopUpMessage.popupCaseFromError(err);
            EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, { popupCase });
            return;
        }

        const totalWin = data.respinTotalWin;
        this._gameState = GameState.POPUP;

        Log.e(`[TopUp-CLAIM] Showing end popup — totalWin=${totalWin}`);
        // Hiện popup tổng kết → _onTopUpEndPopupClosed sẽ emit TOPUP_END + cleanup
        Log.e(
            `[TOPUP-END-CHECK] showPopup totalWin=${totalWin} eachWinDisplay=${data.topUpDisplayedEachWin}` +
            ` deltaPopupMinusEachWin=${totalWin - data.topUpDisplayedEachWin}`
        );
        EventBus.instance.emit(GameEvents.TOPUP_END_POPUP, totalWin);
    }

    /**
     * TopUpEndPopup đóng xong → emit TOPUP_END thật sự + cleanup state.
     * Pattern tương tự _onFreeSpinEndPopupClosed.
     */
    private async _onTopUpEndPopupClosed(): Promise<void> {
        const data = GameData.instance;

        // ── Matsuri Hold&Spin: đóng popup tổng kết → cleanup; Ultra+ → Pick ──
        if (data.currentMode === 'matsuri') {
            const totalWin = data.respinTotalWin;
            const pendingPick = this._pendingPickAfterMatsuriClaim;
            this._pendingPickAfterMatsuriClaim = null;
            Log.e(
                `[CarnivalMatsuri] TopUpEndPopup closed — totalWin=${totalWin}` +
                ` pendingPick=${pendingPick ? 'yes' : 'no'}`,
            );

            data.currentMode = 'normal';
            data.respinRemaining = 0;
            data.respinTotalWin = 0;
            data.featureBaseCredit = 0;
            data.matsuriRows = 3;
            data.matsuriFeatureName = '';
            data.cnApiFeatureType = -1;
            data.stickyCells.clear();
            data.pendingCarnivalMatsuri = null;
            data.topUpDisplayedEachWin = 0;
            this._topUpStickySnapshot.clear();
            this._topUpRemainBeforeSpin = 0;
            this._resetFeatureGauge();

            EventBus.instance.emit(GameEvents.TOPUP_END, totalWin);
            EventBus.instance.emit(GameEvents.CARNIVAL_MATSURI_END);
            EventBus.instance.emit(GameEvents.CARNIVAL_MATSURI_STUB_DONE);
            this._updateDisplayVisibility();
            this._updateBackgroundSprite();

            // API V1.0.2: Ultra/Supreme/Ultimate Claim → PICK_START
            if (pendingPick) {
                this._currentStage = SlotStageType.PICK_START;
                this._gameState = GameState.POPUP;
                EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, false);
                this._showJackpotStartPopupThenEnter(pendingPick);
                return;
            }

            this._currentStage = SlotStageType.SPIN;
            this._gameState = GameState.IDLE;
            EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
            EventBus.instance.emit(GameEvents.NORMAL_SPIN_DONE);
            this._checkProgressiveWinForFeatureEnd(totalWin);
            return;
        }

        // ── FreeSpin Gold: kết thúc FreeSpin Gold, dọn trạng thái FS, phát sự kiện ──
        if (data.currentMode === 'freespin_gold') {
            const localTotalWin = truncateMoney3(data.freeSpinTotalWin + data.freeSpinGoldTotalWin);
            const totalWin = this._freeSpinGoldServerTotalWin ?? localTotalWin;
            Log.e(`[FreespinGold][END-CLOSE] serverTotal=${this._freeSpinGoldServerTotalWin ?? 'null'} localLineWin=${data.freeSpinTotalWin} localGoldWin=${data.freeSpinGoldTotalWin} localTotal=${localTotalWin} finalTotal=${totalWin}`);
            data.freeSpinRemaining      = 0;
            data.freeSpinTotalWin       = 0;
            data.freeSpinGoldRemaining  = 0;
            data.freeSpinGoldTotalWin   = 0;
            this._freeSpinGoldServerTotalWin = null;
            data.featureBaseCredit      = 0;
            data.stickyCells.clear();
            data.currentMode            = 'normal';
            data.isResumingFreeSpin     = false;
            this._currentStage          = SlotStageType.SPIN;
            this._gameState             = GameState.IDLE;
            this._resetFeatureGauge();
            this._updateDisplayVisibility();
            this._updateBackgroundSprite();
            EventBus.instance.emit(GameEvents.FREE_SPIN_GOLD_END, totalWin);
            EventBus.instance.emit(GameEvents.FREE_SPIN_END, totalWin); // cập nhật balance/UI
            Log.d(`[FreespinGold] End popup closed — totalWin=${totalWin}, returning to normal mode`);
            // Check Progressive Win cho tổng tiền FreeSpin Gold
            this._checkProgressiveWinForFeatureEnd(totalWin);
            return;
        }

        const totalWin = data.respinTotalWin;

        if (this._claimTopUpAfterEndPopup) {
            this._claimTopUpAfterEndPopup = false;
            try {
                const result = await NetworkManager.instance.sendClaimRequest();
                WalletManager.instance.balance = result.balance;
                EventBus.instance.emit(GameEvents.BALANCE_UPDATED, WalletManager.instance.balance);
                // Lưu WinGrade từ ClaimResponse để _checkProgressiveWinForFeatureEnd dùng
                GameData.instance.lastClaimWinGrade = result.winGrade;
                if (result.winCash != null) {
                    Log.e(`[TopUp-CLAIM] resume winCash từ server: ${result.winCash} (client had: ${data.respinTotalWin})`);
                    data.respinTotalWin = result.winCash;
                } else {
                    Log.e(`[TopUp-CLAIM] ⚠ resume: server không trả winCash — hiện 0. Client respinTotalWin=${data.respinTotalWin}`);
                    data.respinTotalWin = 0;
                }
            } catch (err) {
                Log.e('[TopUp-CLAIM] ❌ resume Claim failed — hiện 0:', err);
                data.respinTotalWin = 0;
                const popupCase = PopUpMessage.popupCaseFromError(err);
                EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, { popupCase });
                return;
            }
        }

        // Reset state về normal TRƯỚC emit — đảm bảo listeners thấy đúng mode
        data.respinRemaining = 0;
        data.respinTotalWin = 0;
        data.featureBaseCredit = 0;
        data.stickyCells.clear();
        data.topUpDisplayedEachWin = 0;
        data.currentMode = 'normal';
        data.isResumingFreeSpin = false;
        this._topUpStickySnapshot.clear();
        this._topUpRemainBeforeSpin = 0;
        this._claimTopUpAfterEndPopup = false;
        this._currentStage = SlotStageType.SPIN;
        this._gameState = GameState.IDLE;
        this._resetFeatureGauge();

        // Emit TOPUP_END để các controller cleanup (StickyOverlay, etc.)
        EventBus.instance.emit(GameEvents.TOPUP_END, totalWin);
        this._updateDisplayVisibility();
        this._updateBackgroundSprite();
        Log.d(`[TopUp] End popup closed — cleaned up state, returning to normal mode`);
        // Check Progressive Win cho tổng tiền TopUp
        this._checkProgressiveWinForFeatureEnd(totalWin);
    }

    private _endFreeSpin(): void {
        const data = GameData.instance;

        // FreeSpin Gold kết thúc: dùng TopUpEndPopup thay vì FreeSpinEndPopup
        if (this._isFreespinGold()) {
            const localTotalWin = truncateMoney3(data.freeSpinTotalWin + data.freeSpinGoldTotalWin);
            const totalWin = this._freeSpinGoldServerTotalWin ?? localTotalWin;
            this._gameState = GameState.POPUP;
            Log.d(`[FreespinGold] _endFreeSpin → emit TOPUP_END_POPUP totalWin=${totalWin}`);
            Log.e(`[FreespinGold][END-POPUP] serverTotal=${this._freeSpinGoldServerTotalWin ?? 'null'} localLineWin=${data.freeSpinTotalWin} localGoldWin=${data.freeSpinGoldTotalWin} localTotal=${localTotalWin} finalTotal=${totalWin} _freeSpinGoldCoinTotal=${this._freeSpinGoldCoinTotal}`);
            EventBus.instance.emit(GameEvents.TOPUP_END_POPUP, totalWin);
            return;
        }

        const totalWin = data.freeSpinTotalWin;
        const spinCount = this._freeSpinActualCount;

        // ★ Nếu Pick Game đang active, defer free spin end cho đến sau khi Pick Game đóng
        if (this._isPickGameActive) {
            Log.e(`[DEBUG-PICK] _endFreeSpin deferred — Pick Game still active, totalWin=${totalWin}`);
            this._pendingFreeSpinEnd = true;
            return;
        }

        this._gameState = GameState.POPUP;

        // ★ DISABLED: Bỏ FreeSpinEndPopup theo yêu cầu user
        // Log.d(`[RESUME-DEBUG] _endFreeSpin() → emit FREE_SPIN_END_POPUP totalWin=${totalWin}, spinCount=${spinCount}`);
        // EventBus.instance.emit(GameEvents.FREE_SPIN_END_POPUP, totalWin, spinCount);

        // Reset state về normal TRƯỚC emit — đảm bảo listeners thấy đúng mode
        data.freeSpinRemaining = 0;
        data.freeSpinTotalWin = 0;
        data.freeSpinTotalWinRestoredFromServer = false;
        data.isResumingFreeSpin = false;
        this._currentStage = SlotStageType.SPIN;
        this._gameState = GameState.IDLE;
        this._resetFeatureGauge();

        // Thay vì hiện popup, emit FREE_SPIN_END trực tiếp + check progressive win
        Log.d(`[RESUME-DEBUG] _endFreeSpin() → emit FREE_SPIN_END directly totalWin=${totalWin}`);
        EventBus.instance.emit(GameEvents.FREE_SPIN_END, totalWin);
        // Check Progressive Win cho tổng tiền FreeSpin
        this._checkProgressiveWinForFeatureEnd(totalWin);
    }

    private async _handleClaim(): Promise<void> {
        Log.d(`[RESUME-DEBUG] _handleClaim() START — freeSpinTotalWin=${GameData.instance.freeSpinTotalWin}`);
        // Set POPUP ngay (sync) để _afterWinProcessed không enable spin button trong lúc await
        this._gameState = GameState.POPUP;
        try {
            const result = await NetworkManager.instance.sendClaimRequest();
            WalletManager.instance.balance = result.balance;
            // Lưu WinGrade từ ClaimResponse — _onFreeSpinEndPopupClosed() sẽ dùng khi USE_REAL_API
            GameData.instance.lastClaimWinGrade = result.winGrade;
            // Cập nhật freeSpinTotalWin từ server để FreeSpinEndPopup hiển thị đúng số tiền
            if (result.winCash != null) {
                if (GameData.instance.currentMode === 'freespin_gold') {
                    this._freeSpinGoldServerTotalWin = truncateMoney3(result.winCash);
                    Log.e(`[FreespinGold][CLAIM] server winCash=${result.winCash} -> popupTotal=${this._freeSpinGoldServerTotalWin}, local lineWin=${GameData.instance.freeSpinTotalWin}, goldWin=${GameData.instance.freeSpinGoldTotalWin}`);
                } else {
                    GameData.instance.freeSpinTotalWin = result.winCash;
                }
            }
            Log.d(`[RESUME-DEBUG] _handleClaim SUCCESS — balance=${result.balance}, winCash=${result.winCash}, freeSpinTotalWin=${GameData.instance.freeSpinTotalWin}`);
            // Hiện popup tổng kết Free Spin (sẽ reset stage khi đóng)
            this._endFreeSpin();
        } catch (err) {
            Log.d('[Claim] Error:', err);
            // ★ Resume fallback: nếu freeSpinTotalWin đã được restore từ server (resume path),
            // vẫn hiện popup tổng kết để user claim — tránh kẹt game.
            const data = GameData.instance;
            if (data.freeSpinTotalWin > 0) {
                Log.w(`[Claim] Claim API failed nhưng freeSpinTotalWin=${data.freeSpinTotalWin} > 0 → vẫn hiện FreeSpinEndPopup`);
                this._endFreeSpin();
            } else {
                this._gameState = GameState.IDLE;
                this._currentStage = SlotStageType.SPIN;
                EventBus.instance.emit(GameEvents.UI_SPIN_BUTTON_STATE, true);
            }
        }
    }

    // ─── HELPERS ───

    private _isFreeSpin(): boolean {
        return (
            this._currentStage === SlotStageType.FREE_SPIN ||
            this._currentStage === SlotStageType.FREE_SPIN_START ||
            this._currentStage === SlotStageType.FREE_SPIN_RE_TRIGGER ||
            this._currentStage === SlotStageType.BUY_FREE_SPIN_START ||
            this._currentStage === SlotStageType.BUY_FREE_SPIN
        );
    }

    /** Kiểm tra đang ở chế độ FreeSpin Gold (đồng xu vàng). */
    private _isFreespinGold(): boolean {
        return GameData.instance.currentMode === 'freespin_gold';
    }

    private _isMatsuri(): boolean {
        return GameData.instance.currentMode === 'matsuri';
    }

    /**
     * Server stages cần /Claim trước /Spin tiếp.
     * - NEED_CLAIM(100) … HIDDEN_FREE_SPIN_END(109), DIRECT_PAY(1000+)
     * - Loại client-only 200–999 (FEATURE_SELECT_START, POT_WIN, CARNIVAL_MATSURI_START=240, …)
     */
    private _stageRequiresServerClaim(stage: SlotStageType): boolean {
        const n = stage as number;
        if (n >= 200 && n < 1000) return false;
        return n >= SlotStageType.NEED_CLAIM;
    }

    private _isTopUp(): boolean {
        return (
            this._currentStage === SlotStageType.TOPUP_SPIN_START ||
            this._currentStage === SlotStageType.TOPUP_SPIN ||
            this._currentStage === SlotStageType.TOPUP_SPIN_END ||
            GameData.instance.currentMode === 'respin'
        );
    }

    private _getTopUpLongSpinHints(): { reelIndex: number; rowIndex: number }[] {
        const data = GameData.instance;
        const rows = data.currentMode === 'matsuri'
            ? clampMatsuriRows(data.matsuriRows || 3)
            : 3;
        const occupied = new Set<string>();
        for (const cell of data.stickyCells.values()) {
            if (cell.reel >= 0 && cell.reel < 5 && cell.row >= 0 && cell.row < rows) {
                occupied.add(`${cell.reel}-${cell.row}`);
            }
        }
        const empty: { reelIndex: number; rowIndex: number }[] = [];
        for (let reel = 0; reel < 5; reel++) {
            for (let row = 0; row < rows; row++) {
                if (!occupied.has(`${reel}-${row}`)) empty.push({ reelIndex: reel, rowIndex: row });
            }
        }
        return empty.length <= 2 ? empty : [];
    }

    /**
     * Cập nhật background sprite theo orientation + spin mode (Normal/Free Spin).
     * Chỉ load đúng 1 ảnh mỗi lần — portrait HOẶC landscape, normal HOẶC freespin.
     * prefetchBackground() gọi khi GuideView hiện (GameRoot warm, opacity=0).
     */
    private _updateBackgroundSprite(): void {
        if (!this._bgLoadAllowed) return;
        if (!this.backgroundNode) return;

        const isFeatureMode = this._isFreeSpin() || this._isTopUp() || this._isMatsuri() || this._isPickGameActive;
        const size = screen.windowSize;
        const isPortrait = size.height > size.width;
        const idx = isPortrait ? 0 : 1;
        const paths = isFeatureMode ? FREESPIN_BG_PATHS : NORMAL_BG_PATHS;
        const arr = isFeatureMode ? this.freeSpinBackgroundSprites : this.backgroundSprites;

        const cached = arr[idx] ?? null;
        if (cached) {
            this._applyBackgroundSprite(cached);
            return;
        }

        void this._loadBackgroundSprite(paths[idx], isFeatureMode, idx).then((sf) => {
            this._applyBackgroundSprite(sf);
        });
    }

    /** ★ Prefetch BG khi GuideView hiện (GameRoot warm) — gán sprite trước khi user Continue. */
    prefetchBackground(): void {
        void this.ensureBackgroundReady();
    }

    /**
     * Load + gán BG orientation hiện tại (và prefetch chiều còn lại).
     * Await trước khi lộ GameRoot (skipIntro / Guide → game) để tránh màn trống.
     * Resolve chỉ khi spriteFrame đã gán lên backgroundNode (hoặc fail).
     */
    async ensureBackgroundReady(): Promise<SpriteFrame | null> {
        this._bgLoadAllowed = true;
        if (!this.backgroundNode?.isValid) return null;

        const size = screen.windowSize;
        const isPortrait = size.height > size.width;
        const primaryIdx = isPortrait ? 0 : 1;
        const secondaryIdx = isPortrait ? 1 : 0;

        // Prefetch chiều kia nền — không block
        void this._loadBackgroundSprite(NORMAL_BG_PATHS[secondaryIdx], false, secondaryIdx);

        const sf = await this._loadBackgroundSprite(NORMAL_BG_PATHS[primaryIdx], false, primaryIdx);
        this._applyBackgroundSprite(sf);
        return sf;
    }

    /** true khi backgroundNode đã có spriteFrame (đã gán, không còn null). */
    isBackgroundAssigned(): boolean {
        if (!this.backgroundNode?.isValid) return false;
        const sprite = this.backgroundNode.getComponent(Sprite);
        return !!sprite?.spriteFrame;
    }

    /** Mở khóa lazy-load BG (gọi sau Guide / khi vào game). */
    private _allowBackgroundLoad(): void {
        if (this._bgLoadAllowed) {
            this._updateBackgroundSprite();
            return;
        }
        this._bgLoadAllowed = true;
        this._updateBackgroundSprite();
    }

    /** Xóa spriteFrame serialize cứng — tránh boot load landscape 3.3MB trước khi lazy-load */
    private _clearBackgroundSprite(): void {
        if (!this.backgroundNode) return;
        const spriteComponent = this.backgroundNode.getComponent(Sprite);
        if (spriteComponent) spriteComponent.spriteFrame = null;
        this._currentBgFrame = null;
        if (this._bgFadeTwin?.isValid) {
            setNodeOpacity(this._bgFadeTwin, 0);
            this._bgFadeTwin.active = false;
        }
    }

    /**
     * Gán / crossfade background.
     * Hình cũ mờ dần + hình mới hiện dần (không cắt cứng 1 frame).
     */
    private _applyBackgroundSprite(sf: SpriteFrame | null): void {
        if (!sf || !this.backgroundNode?.isValid) return;
        if (this._currentBgFrame === sf) {
            setNodeOpacity(this.backgroundNode, 255);
            return;
        }
        const hadPrevious = !!this._currentBgFrame
            || !!this.backgroundNode.getComponent(Sprite)?.spriteFrame;
        this._currentBgFrame = sf;

        if (!hadPrevious) {
            const spriteComponent = this.backgroundNode.getComponent(Sprite);
            if (spriteComponent) spriteComponent.spriteFrame = sf;
            setNodeOpacity(this.backgroundNode, 255);
            return;
        }

        this._bgFadeTwin = crossfadeSpriteFrame(
            this.backgroundNode,
            this._bgFadeTwin,
            sf,
            this.uiFadeDuration,
        );
    }

    private _loadBackgroundSprite(
        path: string,
        isFeature: boolean,
        idx: number,
    ): Promise<SpriteFrame | null> {
        const arr = isFeature ? this.freeSpinBackgroundSprites : this.backgroundSprites;
        const cached = arr[idx] ?? null;
        if (cached) return Promise.resolve(cached);

        const existing = this._bgLoadPromises.get(path);
        if (existing) return existing;

        const promise = new Promise<SpriteFrame | null>((resolve) => {
            const bundle = assetManager.getBundle(BG_BUNDLE);
            if (!bundle) {
                Log.w(`[GameManager] Bundle '${BG_BUNDLE}' missing — cannot load BG ${path}`);
                resolve(null);
                return;
            }
            bundle.load(path, SpriteFrame, (err, sf) => {
                this._bgLoadPromises.delete(path);
                if (err || !sf) {
                    Log.w(`[GameManager] BG load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                while (arr.length <= idx) arr.push(null as any);
                arr[idx] = sf;
                resolve(sf);
            });
        });
        this._bgLoadPromises.set(path, promise);
        return promise;
    }

    /** Điều chỉnh ParticleSystem RateOverTime theo screen orientation */
    private _updateParticleRateOverTime(): void {
        if (!this.particleSystem) return;

        const size = screen.windowSize;
        const isPortrait = size.height > size.width;
        
        // Ngang (landscape) → RateOverTime = 2
        // Dọc (portrait) → RateOverTime = 1
        this.particleSystem.rateOverTime.constant = isPortrait ? 1 : 2;
    }

    /**
     * Cập nhật visibility của PayOutDisplay và MultiplierDisplay dựa vào spin mode.
     * Normal Spin: hiện PayOutDisplay, ẩn MultiplierDisplay
     * Free Spin: ẩn PayOutDisplay, hiện MultiplierDisplay
     */
    private _updateDisplayVisibility(): void {
        const isFreeSpin     = this._isFreeSpin();
        const isTopUp        = this._isTopUp();
        const isMatsuri      = this._isMatsuri();
        const isFreespinGold = this._isFreespinGold();
        const isCellFeature  = isTopUp || isMatsuri;
        const dur = this.uiFadeDuration;

        const setVisible = (node: Node | null, visible: boolean) => {
            if (!node?.isValid) return;
            if (visible) fadeInNode(node, dur);
            else fadeOutNode(node, dur, true);
        };

        setVisible(this.payOutDisplay, !isFreeSpin && !isCellFeature);

        // Multiplier chỉ hiển thị khi FreeSpin thường (không phải FreeSpin Gold)
        setVisible(this.multiplierDisplay, isFreeSpin && !isFreespinGold);

        setVisible(this.jackpotDisplay, !isFreeSpin && !isCellFeature);

        setVisible(this.potDisplay, !isCellFeature && !isFreeSpin);

        // Carnival: bỏ TopUpUI — luôn ẩn
        if (this.topUpDisplay?.isValid) {
            this.topUpDisplay.active = false;
        }
        const topUpByName = this._findNodeByName('TopUpUI');
        if (topUpByName) topUpByName.active = false;

        // FreeSpinUI: active khi Matsuri hoặc FreeSpin Gold
        const fsUI = this.freeSpinUI ?? this.freeSpinGoldDisplay ?? this._findNodeByName('FreeSpinUI');
        setVisible(fsUI, isMatsuri || isFreespinGold);

        // multiplierEffect được điều khiển riêng bằng FREE_SPIN_MULTIPLIER_SPIN / FREE_SPIN_END
        // để đảm bảo active cùng lúc với MultiplierDisplay rolling bắt đầu
    }

    private _findNodeByName(name: string): Node | null {
        const scene = this.node.scene;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length) {
            const n = stack.pop()!;
            if (n.name === name) return n;
            for (const c of n.children) stack.push(c);
        }
        return null;
    }

    /**
     * ★ GoF: Long Spin trigger khi tổng Red symbols >= 3.
     * Tính từ stickyCells (luôn có sẵn) thay vì phụ thuộc resp.redCount (có thể undefined).
     * Trả về các vị trí Red hint (dùng mid row) để SlotMachineController bounce animation.
     *
     * Force Feature Entry: chỉ đếm existingCells (Red thật trên grid).
     * fillCells chưa đổ — nếu đếm vào sẽ LONG_SPIN_HINT_SHOW sớm → spine trên symbol thường
     * khi từng reel dừng (trông như hilightWin giữa lúc quay).
     */
    private _getLongSpinHints(resp: SpinResponse): { reelIndex: number; rowIndex: number }[] {
        const cells = (resp.isForcedFeatureEntry && resp.forceFeatureEntry)
            ? (resp.forceFeatureEntry.existingCells ?? [])
            : (resp.stickyCells ?? []);
        const redCells = cells.filter(c => c.symbolId === SymbolId.STICKY_RED);
        if (redCells.length < 3) return [];
        // Lấy danh sách reel unique chứa red, dùng row thực tế của red đầu tiên trên mỗi reel
        const reelSet = new Set<number>();
        for (const c of redCells) reelSet.add(c.reel);
        return Array.from(reelSet).sort().map(r => {
            const red = redCells.find(c => c.reel === r);
            return { reelIndex: r, rowIndex: red?.row ?? 1 };
        });
    }

    /**
     * ★ GoF: Jackpot chỉ được trúng qua Pick Game (resp.pickGame + resp.triggerPotWin).
     * Hàm giữ lại để resume path gọi — luôn trả NONE.
     */
    private _detectJackpot(_resp: SpinResponse): JackpotType {
        return JackpotType.NONE;
    }

    // ─── PUBLIC GETTERS ───

    get currentStage(): SlotStageType { return this._currentStage; }
    get isSpinning(): boolean { return this._isSpinning; }
    get gameState(): GameState { return this._gameState; }
}



