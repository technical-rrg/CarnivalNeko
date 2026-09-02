/**
 * GameEntryController - Điều phối luồng vào game.
 *
 * Setup trong Editor:
 *   1. Gắn component này vào bất kỳ node nào trong game prefab.
 *   2. Kéo GameGuide node vào slot gameGuide (để active=false trong Editor).
 *   3. Kéo GameRoot node vào slot gameRoot (để active=false trong Editor).
 *
 * Flow Guide-first (SkipIntro OFF):
 *   LoadingController hiện GuideView.prefab trước Base
 *   → Base load nền → notifyBaseReadyDuringGuide (warm GameRoot)
 *   → Continue → FadeOut → màn đen (chờ Base/BG/Transition xong) → FadeIn GameRoot
 *   (Fade Guide↔Game dùng fill đen OverLay — không fade UIOpacity GameRoot)
 *
 * Flow (SkipIntro ON):
 *   → await Base → warm GameRoot (Reel + data + BG) dưới Loading
 *   → Transition sẵn → mới ẩn Loading / lộ GameView
 *
 * Flow (Resume):
 *   → await Base → GameRoot active ngay (không qua Guide)
 */

import { _decorator, Component, Node, UIOpacity } from 'cc';
import { EventBus }                from '../core/EventBus';
import { GameEvents }              from '../core/GameEvents';
import { GameData }                from '../data/GameData';
import { Log }                     from '../core/Logger';
import { SlotMachineController }   from './SlotMachineController';
import { TransitionLoader }        from './TransitionLoader';
import { TransitionController }    from './TransitionController';
import { BroadcastPopupLoader }    from './BroadcastPopupLoader';
import { DebbugManagerLoader }     from './DebbugManagerLoader';
import { GuideShellLoader }        from '../core/GuideShellLoader';
import { GameManager }             from '../manager/GameManager';
import { SKIP_GUIDE_TRANSITION }   from '../data/ServerConfig';

const { ccclass, property } = _decorator;

@ccclass('GameEntryController')
export class GameEntryController extends Component {

    @property({ type: Node, tooltip: 'Node màn hình Guide (có GuideController)' })
    gameGuide: Node | null = null;

    @property({ type: Node, tooltip: 'Node GameRoot chứa toàn bộ game — inactive đến GUIDE_COMPLETE' })
    gameRoot: Node | null = null;

    @property({ type: Node, tooltip: 'Node dùng chung giữa GuideView và GameRoot. Mặc định là con của GuideView, sẽ được chuyển sang GameRoot khi GuideView active=false.' })
    sharedNode: Node | null = null;

    @property({
        tooltip: 'Sau khi Guide hiện, đợi N giây rồi warm-init GameRoot nền.\n' +
                 '0 = tắt warm (chỉ init khi Continue).',
    })
    warmGameRootDelay: number = 0;

    /** Guard: chỉ xử lý LOADING_COMPLETE lần đầu tiên — GameManager có thể emit lại */
    private _loadingHandled: boolean = false;
    /** Guard: chỉ xử lý GUIDE_COMPLETE lần đầu tiên */
    private _guideHandled: boolean = false;
    /** State lưu từ _onLoadingComplete() để _onBarReached100() xử lý khi bar thực sự 100% */
    private _pendingState: { isResuming: boolean; skipIntro: boolean } | null = null;
    /** GameRoot đã được warm (active) trong lúc Guide đang hiện */
    private _gameRootWarmed: boolean = false;
    /** skipIntro: promise LoadingController await trước khi ẩn Loading / lộ GameView */
    private _skipIntroEnterPromise: Promise<void> | null = null;
    /** Chỉ true sau khi Reel thật + BG thật + Transition đã prepare xong dưới opacity=0. */
    private _skipIntroPrepared: boolean = false;

    private _transitionLoader: TransitionLoader | null = null;

    // ─── LIFECYCLE ───

    onLoad(): void {
        if (this.gameGuide) this.gameGuide.active = false;
        this._deactivateGameRoot();
        this._initOverlayLoaders();

        EventBus.instance.on(GameEvents.LOADING_COMPLETE, this._onLoadingComplete, this);
        EventBus.instance.on(GameEvents.LOADING_BAR_100,  this._onBarReached100,  this);
        EventBus.instance.on(GameEvents.GUIDE_CONTINUE,  this._onGuideContinue,  this);
        EventBus.instance.on(GameEvents.GUIDE_COMPLETE,  this._onGuideComplete,  this);
        EventBus.instance.on(GameEvents.GAME_VIEW_READY_UNDER_TRANSITION, this._onGameViewReadyUnderTransition, this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ─── HANDLERS ───

    private _onLoadingComplete(): void {
        if (this._loadingHandled) {
            Log.w('[GameEntryController] LOADING_COMPLETE fired again — ignored (already handled by LoadingController)');
            return;
        }
        this._loadingHandled = true;
        Log.d('[GameEntryController] LOADING_COMPLETE → handling (first time)');

        // Guide-first: Guide đã hiện từ shell — chỉ lưu state / warm khi Base vừa attach
        if (GameData.instance.guideFirstBoot && GameData.instance.isGuideShowing) {
            Log.d('[GameEntryController] Guide-first: Guide already showing — skip show GuideView');
            this._pendingState = {
                isResuming: GameData.instance.isResumingFreeSpin,
                skipIntro: false,
            };
            this._deactivateGameRoot();
            return;
        }

        const isResuming = GameData.instance.isResumingFreeSpin;
        Log.d(`[RESUME-DEBUG] GameEntryController._onLoadingComplete — isResumingFreeSpin=${isResuming}`);

        let skipIntro = false;
        try {
            const saved = localStorage.getItem('setting_intro_on');
            if (saved !== null) skipIntro = saved === 'false';
        } catch (_) {}

        this._pendingState = { isResuming, skipIntro };
        Log.d('[GameEntryController] State saved — waiting for LOADING_BAR_100');
    }

    /** Chỉ gọi khi loading bar VISUALLY đạt 100% — đảm bảo GuideView/GameRoot không hiện sớm */
    private _onBarReached100(): void {
        if (!this._pendingState) {
            // Guide-first: events có thể đã fire trước khi Base attach — ignore
            if (GameData.instance.guideFirstBoot && GameData.instance.isGuideShowing) {
                Log.d('[GameEntryController] LOADING_BAR_100 late during Guide-first — warm only');
                this.notifyBaseReadyDuringGuide();
                return;
            }
            this.scheduleOnce(() => this._onBarReached100(), 0);
            return;
        }

        const { isResuming, skipIntro } = this._pendingState;
        this._pendingState = null;
        Log.d(`[GameEntryController] LOADING_BAR_100 → processing: isResuming=${isResuming}, skipIntro=${skipIntro}`);

        if (isResuming) {
            Log.d('[RESUME-DEBUG] GameEntryController → resume path: _showGameRoot() → GAME_READY');
            this._guideHandled = true;
            GameData.instance.isGuideCompleted = true;
            GameData.instance.isGuideShowing = false;
            this._reparentSharedNode();
            this._showGameRoot();
            this.scheduleOnce(() => {
                void this._transitionLoader?.handoffChestForResume().then(() => {
                    Log.d('[RESUME-DEBUG] GameEntryController resume → emit GAME_READY');
                    EventBus.instance.emit(GameEvents.GAME_READY);
                });
            }, 0);
            return;
        }

        if (skipIntro) {
            Log.d('[GameEntryController] skipIntro=true → await Base/GameRoot ready under Loading');
            this._skipIntroEnterPromise = this._enterSkipIntro();
            void this._skipIntroEnterPromise;
        } else if (GameData.instance.guideFirstBoot && GameData.instance.isGuideShowing) {
            // Guide shell đã hiện — chỉ warm GameRoot
            Log.d('[GameEntryController] Guide-first BAR_100 → warm GameRoot only');
            this.notifyBaseReadyDuringGuide();
        } else {
            Log.d('[GameEntryController] skipIntro=false → gameGuide.active = true');
            GameData.instance.isGuideShowing = true;
            this._deactivateGameRoot();
            if (this.gameGuide) this.gameGuide.active = true;
            this._warmGameRootBackground();
            this._prefetchGameBackground();
        }
    }

    /**
     * LoadingController gọi khi Base attach xong lúc GuideShell đang hiện.
     * Warm GameRoot + prefetch BG — không đụng Guide shell (Guide cover phía trên).
     */
    notifyBaseReadyDuringGuide(): void {
        if (!GameData.instance.isGuideShowing || this._guideHandled) return;
        // GuideView đã tách prefab riêng — slot gameGuide trên Base có thể null
        if (this.gameGuide) this.gameGuide.active = false;
        this._loadingHandled = true;
        this._deactivateGameRoot();
        this._warmGameRootBackground();
        this._prefetchGameBackground();
        // Preload Transition nền — Continue sớm vẫn kịp play sau reveal
        void this._transitionLoader?.ensureLoaded();
        Log.d('[GameEntryController] notifyBaseReadyDuringGuide — GameRoot warmed (GuideView.prefab stays on top)');
    }

    /**
     * LoadingController gọi sau GUIDE_COMPLETE (đang giữ màn đen).
     * Chuỗi: prep dưới đen → start Transition NGAY + FadeIn song song (không chờ FadeIn xong mới play).
     */
    async enterFromExternalGuide(
        sharedFromShell: Node | null,
        onReadyToReveal?: () => void | Promise<void>,
    ): Promise<void> {
        if (this._guideHandled) {
            Log.w('[GameEntryController] enterFromExternalGuide — already handled');
            return;
        }
        this._guideHandled = true;
        this._loadingHandled = true;
        GameData.instance.isGuideCompleted = true;
        GameData.instance.isGuideShowing = false;
        if (this.gameGuide) this.gameGuide.active = false;

        if (sharedFromShell?.isValid) {
            this.sharedNode = sharedFromShell;
        }
        this._reparentSharedNode();

        // ★ Dưới màn đen: warm GameRoot + BG — giữ opacity=0 đến khi Transition fade out
        Log.d('[GameEntryController] enterFromExternalGuide — prep under black (no FadeIn yet)');
        await this.prepareGameRootBackground();
        this._showGameRoot(false, false);

        // Warm path: GameManager.start đã chạy lúc Guide — bù GAME_READY (không qua GUIDE_COMPLETE).
        if (this._gameRootWarmed) {
            EventBus.instance.emit(GameEvents.GAME_READY);
        }

        // Bỏ Transition: Guide xong → reveal game ngay
        if (SKIP_GUIDE_TRANSITION) {
            const loader = this._transitionLoader;
            if (loader) {
                await loader.handoffChestForResume(); // quiet handoff + TRANSITION_DONE (Pot unlock)
            } else {
                EventBus.instance.emit(GameEvents.TRANSITION_DONE);
            }
            EventBus.instance.emit(GameEvents.GAME_ENTRY_EFFECT);
            this._setGameRootOpacity(255);
            await onReadyToReveal?.();
            Log.d('[GameEntryController] enterFromExternalGuide → SKIP_GUIDE_TRANSITION (straight to game)');
            return;
        }

        const loader = this._transitionLoader;
        const transitionCtrl = loader ? await loader.ensureLoaded() : null;
        if (!transitionCtrl) {
            Log.w('[GameEntryController] enterFromExternalGuide — Transition missing');
            EventBus.instance.emit(GameEvents.GAME_ENTRY_EFFECT);
            this._setGameRootOpacity(255);
            await onReadyToReveal?.();
            return;
        }

        loader!.bringAboveShell();
        loader!.activateForPlay();
        // GuideView đè Transition nếu còn active / holdBlackOnTop — ẩn shell trước khi play
        GuideShellLoader.hideForTransition();
        loader!.bringAboveShell();

        EventBus.instance.emit(GameEvents.GAME_ENTRY_EFFECT);

        // Transition fade in xong → GameRoot opacity 255 dưới Transition → spine alpha fade lộ dần
        transitionCtrl.triggerGuideTransition(() => {
            GuideShellLoader.dismiss();
            void onReadyToReveal?.();
        });
        Log.d('[GameEntryController] enterFromExternalGuide → simple Transition (Guide→Anim→Game)');
    }

    /**
     * Skip intro / resume / Guide→game: bật GameRoot + chờ Reel/data/BG
     * đã GÁN XONG (verify) trước khi lộ UI.
     */
    async prepareGameRootBackground(): Promise<void> {
        if (!this.gameRoot) return;

        // Không phụ thuộc Loading có thật sự nằm trên GameRoot hay không.
        // GameRoot phải tuyệt đối vô hình trong toàn bộ quá trình init.
        this._setGameRootOpacity(0);
        if (!this.gameRoot.active) {
            this.gameRoot.active = true;
            this._gameRootWarmed = true;
        }

        await this._waitUntilGameRootAssigned();
        Log.d('[GameEntryController] prepareGameRootBackground — Reels + data + BG assigned');
    }

    /**
     * Poll đến khi:
     *   - SMC/reels + strip data sẵn
     *   - applyInitialSymbols thành công (gán sync, không scheduleOnce)
     *   - BG spriteFrame đã gán lên backgroundNode
     * rồi chờ 1 frame để engine commit render trước khi reveal.
     */
    private async _waitUntilGameRootAssigned(): Promise<void> {
        const gm = () => this.gameRoot?.getComponent(GameManager) ?? null;
        const smc = () => this.gameRoot?.getComponentInChildren(SlotMachineController) ?? null;

        let symbolsOk = false;
        let bgOk = false;

        let waitFrames = 0;
        while (this.gameRoot?.isValid && this.isValid) {
            const slot = smc();
            if (slot?.isReelDataReady()) {
                symbolsOk = slot.applyInitialSymbols();
            }

            const manager = gm();
            if (!manager) {
                bgOk = false;
            } else if (!manager.backgroundNode) {
                bgOk = true; // không có BG node → không block
            } else {
                if (!manager.isBackgroundAssigned()) {
                    await manager.ensureBackgroundReady();
                }
                bgOk = manager.isBackgroundAssigned();
            }

            if (symbolsOk && bgOk) break;
            await new Promise<void>((r) => this.scheduleOnce(() => r(), 0));
            waitFrames++;
            if (waitFrames % 300 === 0) {
                Log.w(`[GameEntryController] Still holding GameRoot hidden — symbols=${symbolsOk}, bg=${bgOk}`);
            }
        }

        // Gán lần cuối sync — tránh show rồi 1 frame sau mới apply
        const slot = smc();
        if (slot) symbolsOk = slot.applyInitialSymbols();
        const manager = gm();
        if (manager?.backgroundNode) {
            await manager.ensureBackgroundReady();
            bgOk = manager.isBackgroundAssigned();
        } else if (manager) {
            bgOk = true;
        }

        // 1 frame commit render (spriteFrame/symbol đã gán trước frame này)
        await new Promise<void>((r) => this.scheduleOnce(() => r(), 0));

        if (!symbolsOk || !bgOk) {
            throw new Error(`[GameEntryController] GameRoot preparation aborted — symbols=${symbolsOk}, bg=${bgOk}`);
        }
    }

    /**
     * LoadingController await trước khi ẩn Loading (skipIntro path).
     * Đảm bảo GameView chỉ lộ sau khi Base + GameRoot init xong.
     */
    async waitSkipIntroEnter(): Promise<void> {
        if (this._skipIntroEnterPromise) {
            await this._skipIntroEnterPromise;
            return;
        }
        // BAR_100 có thể scheduleOnce retry — tuyệt đối không cho Loading dismiss sớm.
        while (this.isValid && !this._skipIntroEnterPromise) {
            await new Promise<void>((r) => this.scheduleOnce(() => r(), 0));
        }
        if (this._skipIntroEnterPromise) {
            await this._skipIntroEnterPromise;
        }
    }

    /**
     * LoadingController gọi đồng bộ ngay trước khi tắt Loading.
     * Không có await giữa opacity=255 và Loading.active=false nên không thể render frame rỗng.
     */
    revealPreparedSkipIntro(): boolean {
        if (!this._skipIntroPrepared || !this.gameRoot?.isValid) {
            Log.err('[GameEntryController] Refuse reveal — SkipIntro GameRoot is not fully prepared');
            return false;
        }
        this._setGameRootOpacity(255);
        Log.d('[GameEntryController] SkipIntro GameRoot revealed with assigned Reel + BG');
        return true;
    }

    /** Tắt GameRoot — gọi mỗi lần vào Guide để chắc chắn không bị bật sớm. */
    private _deactivateGameRoot(): void {
        if (!this.gameRoot) {
            Log.w('[GameEntryController] gameRoot slot null — không thể tắt GameRoot');
            return;
        }
        if (this.gameRoot.active) {
            Log.d('[GameEntryController] GameRoot was active — forcing inactive during Guide');
        }
        this._setGameRootOpacity(0);
        this.gameRoot.active = false;
    }

    /**
     * Init GameRoot nền trong lúc Guide — chạy GameManager + prefetch BG.
     * Guide shell cover phía trên nên không cần ẩn bằng UIOpacity.
     */
    private _warmGameRootBackground(): void {
        if (this._guideHandled || this._gameRootWarmed) return;
        if (!this.gameRoot || this.gameRoot.active) return;
        if (!GameData.instance.isGuideShowing) return;

        Log.d('[GameEntryController] Warm GameRoot in background while Guide showing');
        this._gameRootWarmed = true;
        this.gameRoot.active = true;

        this.scheduleOnce(() => {
            this._applySymbolsSafe();
        }, 0);
    }

    /** Gọi GameManager.ensureBackgroundReady sau warm — gán BG trong lúc xem Guide. */
    private _prefetchGameBackground(): void {
        if (!this.gameRoot) return;
        const gm = this.gameRoot.getComponent(GameManager);
        if (gm) {
            void gm.ensureBackgroundReady();
            return;
        }
        this.scheduleOnce(() => {
            void this.gameRoot?.getComponent(GameManager)?.ensureBackgroundReady();
        }, 0);
    }

    private _onGuideContinue(): void {
        if (this.sharedNode) this.sharedNode.active = false;
        Log.d('[GameEntryController] GUIDE_CONTINUE → sharedNode.active = false');
    }

    private _onGuideComplete(): void {
        // Guide-first + shell đang hiện: LoadingController xử lý handoff
        if (GameData.instance.guideFirstBoot && GameData.instance.isGuideShowing && !this._guideHandled) {
            Log.d('[GameEntryController] GUIDE_COMPLETE ignored — LoadingController owns GuideShell handoff');
            return;
        }
        if (this._guideHandled) {
            Log.w('[GameEntryController] GUIDE_COMPLETE fired again — ignored');
            return;
        }
        this._guideHandled = true;
        GameData.instance.isGuideCompleted = true;
        GameData.instance.isGuideShowing = false;
        Log.d('[GameEntryController] GUIDE_COMPLETE → gameGuide.active=false → _showGameRoot()');
        if (this.gameGuide) this.gameGuide.active = false;
        this._reparentSharedNode();
        this._showGameRoot();
        EventBus.instance.emit(GameEvents.GAME_ENTRY_EFFECT);
    }

    /**
     * Bật GameRoot full — fade lộ game do fill đen Guide/Loading, không dùng UIOpacity.
     * @param deferSymbols false = gán symbols sync ngay (skipIntro — tránh trễ 1 frame).
     * @param reveal false = giữ opacity=0 để LoadingController reveal nguyên tử sau cùng.
     */
    private _showGameRoot(deferSymbols: boolean = true, reveal: boolean = true): void {
        if (!this.gameRoot) return;

        const wasInactive = !this.gameRoot.active;
        this.gameRoot.active = true;
        this._gameRootWarmed = true;

        if (wasInactive) {
            if (deferSymbols) {
                this.scheduleOnce(() => this._applySymbolsSafe(), 0);
            } else {
                this._applySymbolsSafe();
            }
        }

        if (this.sharedNode) {
            this.sharedNode.active = true;
            Log.d('[GameEntryController] GameRoot active → sharedNode.active = true');
        }

        if (reveal) this._setGameRootOpacity(255);
    }

    /**
     * skipIntro: CHỈ trigger Transition / resolve sau khi Reel + BG đã gán xong.
     * Loading vẫn cover đến khi promise resolve.
     */
    private async _enterSkipIntro(): Promise<void> {
        if (this._guideHandled) return;
        Log.d('[GameEntryController] _enterSkipIntro — await assigned Reels + BG before reveal');

        // 1) Gán hết data/BG trước — chưa show Transition
        await this.prepareGameRootBackground();

        // 2) Preload Transition (chỉ khi còn dùng intro fly)
        const loader = this._transitionLoader;
        const transitionCtrl = SKIP_GUIDE_TRANSITION
            ? null
            : (loader ? await loader.ensureLoaded() : null);

        // 3) Verify lại ngay trước reveal
        await this._waitUntilGameRootAssigned();

        // 4) Hoàn tất state nhưng vẫn giữ GameRoot opacity=0.
        this._guideHandled = true;
        GameData.instance.isGuideCompleted = true;
        GameData.instance.isGuideShowing = false;
        if (this.gameGuide) this.gameGuide.active = false;
        this._reparentSharedNode();
        this._showGameRoot(false, false);

        // GameManager nghe GUIDE_COMPLETE → GAME_READY
        EventBus.instance.emit(GameEvents.GUIDE_COMPLETE);

        // 5) Transition cover — hoặc skip thẳng vào game
        if (SKIP_GUIDE_TRANSITION) {
            if (loader) {
                await loader.handoffChestForResume();
            } else {
                EventBus.instance.emit(GameEvents.TRANSITION_DONE);
            }
            EventBus.instance.emit(GameEvents.GAME_ENTRY_EFFECT);
            this._skipIntroPrepared = true;
            Log.d('[GameEntryController] _enterSkipIntro → SKIP_GUIDE_TRANSITION');
            return;
        }

        if (transitionCtrl && loader) {
            loader.bringToFront();
            transitionCtrl.triggerGuideTransition();
            EventBus.instance.emit(GameEvents.GAME_ENTRY_EFFECT);
            this._skipIntroPrepared = true;
            Log.d('[GameEntryController] _enterSkipIntro → prepared under hidden GameRoot + Transition');
            return;
        }

        EventBus.instance.emit(GameEvents.GAME_ENTRY_EFFECT);
        this._skipIntroPrepared = true;
        Log.d('[GameEntryController] _enterSkipIntro → prepared under hidden GameRoot (no Transition)');
    }

    private _setGameRootOpacity(value: number): void {
        if (!this.gameRoot?.isValid) return;
        let opacity = this.gameRoot.getComponent(UIOpacity);
        if (!opacity) opacity = this.gameRoot.addComponent(UIOpacity);
        opacity.opacity = value;
    }

    /** GameRoot opacity 255 — gọi khi Transition đã che kín (sẵn sàng lộ khi spine alpha fade). */
    private _onGameViewReadyUnderTransition = (): void => {
        this._setGameRootOpacity(255);
        Log.d('[GameEntryController] GameRoot opacity=255 under Transition');
    };

    private _applySymbolsSafe(): void {
        if (!this.gameRoot?.isValid || !this.gameRoot.active) return;
        const smc = this.gameRoot.getComponentInChildren(SlotMachineController);
        if (smc?.applyInitialSymbols()) {
            Log.d('[GameEntryController] applyInitialSymbols after GameRoot active');
        }
    }

    /** Gắn lazy-load Transition / Broadcast / Debug trên Base root. */
    private _initOverlayLoaders(): void {
        const shell = this.node;

        let transition = shell.getComponent(TransitionLoader);
        if (!transition) transition = shell.addComponent(TransitionLoader);
        transition.init(shell, this.gameRoot);
        this._transitionLoader = transition;

        let broadcast = shell.getComponent(BroadcastPopupLoader);
        if (!broadcast) broadcast = shell.addComponent(BroadcastPopupLoader);
        broadcast.init(shell);

        let debug = shell.getComponent(DebbugManagerLoader);
        if (!debug) debug = shell.addComponent(DebbugManagerLoader);
        debug.init(shell, this.gameRoot);

    }

    /** Chuyển sharedNode từ GuideView sang GameRoot (gọi sau khi GuideView active=false). */
    private _reparentSharedNode(): void {
        if (!this.sharedNode || !this.gameRoot) return;
        this.sharedNode.setParent(this.gameRoot, false);
        this.sharedNode.setSiblingIndex(1);
        Log.d('[GameEntryController] sharedNode đã được chuyển sang GameRoot');
    }
}
