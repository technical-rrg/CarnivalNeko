import { _decorator, Component, AudioSource, AudioClip, assetManager } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { JackpotType, SpinResponse } from '../data/SlotTypes';
import { SpeedMode } from './AutoSpinManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

type ReelStoppedPayload = number | { reelIndex: number; result?: unknown };
type StickyCellLike = { symbolId?: number; credit?: number };

/** UI volume 100% maps to this actual engine level (keeps relative balance). */
const VOLUME_BASE_SCALE = 0.8;

/** mx_normal_loop plays at this fraction of the normal BGM level. */
const MX_NORMAL_LOOP_VOLUME_SCALE = 0.6;

/** Bundle path (no extension) for clips nulled out of Base.prefab to shrink boot deps. */
const LAZY_AUDIO_PATHS: Record<string, string> = {
    // Boot BGM/SFX — tách khỏi Base.prefab (~1MB); load ngay khi SoundManager warm
    mxNormalIntro: 'sound/mx_normal_intro',
    mxNormalLoop: 'sound/mx_normal_loop',
    sxAmbience: 'sound/sx_ambience',
    sxUiClick: 'sound/sx_ui_click',
    sxBuyBonusButton: 'sound/sx_buy_bonus_button',
    sxReelSpin: 'sound/sx_reel_spin',
    mxBonusIdle: 'sound/mx_bonus_idle',
    mxBonusLoop: 'sound/mx_bonus_loop',
    mxBonusCongratulation: 'sound/mx_bonus_congratulation',
    mxProgressiveWin: 'sound/mx_progressive_win',
    mxProgressiveTransImpact: 'sound/mx_progressive_trans_impact',
    mxProgressiveWinSkip: 'sound/mx_progressive_win_skip',
    mxGrandJackpotWin: 'sound/mx_grand_jackpot_win',
    mxMajorJackpotWin: 'sound/mx_major_jackpot_win',
    mxMinorJackpotWin: 'sound/mx_minor_jackpot_win',
    mxMiniJackpotWin: 'sound/mx_mini_jackpot_win',
    sxReelSpinQuickTurbo: 'sound/sx_reel_spin_quick_turbo',
    sxReelLand1: 'sound/sx_reel_land_1',
    sxReelLand2: 'sound/sx_reel_land_2',
    sxReelLand3: 'sound/sx_reel_land_3',
    sxReelLand4: 'sound/sx_reel_land_4',
    sxReelLand5: 'sound/sx_reel_land_5',
    sxReelLandAll: 'sound/sx_reel_land_all',
    sxSelectAFeature: 'sound/sx_select_a_feature',
    sxFeatureSelect: 'sound/sx_feature_select',
    sxSymbolMatchLowValue: 'sound/sx_symbol_match_low_value',
    sxSymbolMatchHighValue: 'sound/sx_symbol_match_high_value',
    sxSymbolMatchWildLayer: 'sound/sx_symbol_match_wild_layer',
    sxSymbolPayout: 'sound/sx_symbol_payout',
    sxBonusTrigger: 'sound/sx_bonus_trigger',
    sxPotEffectLvl2: 'sound/sx_pot_effect_lvl_2',
    sxPotEffectLvl3: 'sound/sx_pot_effect_lvl_3',
    sxPotEffectLvl4: 'sound/sx_pot_effect_lvl_4',
    sxPotEffectLvl5: 'sound/sx_pot_effect_lvl_5',
    sxPotEffectLvl6: 'sound/sx_pot_effect_lvl_6',
    sxPotTrailWhoosh: 'sound/sx_pot_trail_whoosh',
    sxPotHit: 'sound/sx_pot_hit',
    sxBonusSelectMini: 'sound/sx_bonus_select_mini',
    sxBonusSelectMinor: 'sound/sx_bonus_select_minor',
    sxBonusSelectMajor: 'sound/sx_bonus_select_major',
    sxBonusSelectGrand: 'sound/sx_bonus_select_grand',
    sxBonusJpWin: 'sound/sx_bonus_jp_win',
    sxBonusFakeTrigger: 'sound/sx_bonus_fake_trigger',
    sxBonusTrail: 'sound/sx_bonus_trail',
    sxBonusStickyLand: 'sound/sx_bonus_sticky_land',
    sxBonusStickyLand2: 'sound/sx_bonus_sticky_land_2',
    sxBonusStickyLand3: 'sound/sx_bonus_sticky_land_3',
    sxBonusStickyLand4: 'sound/sx_bonus_sticky_land_4',
    sxBonusStickyLand5: 'sound/sx_bonus_sticky_land_5',
    sxBonusStickyGoldLand: 'sound/sx_bonus_sticky_gold_land',
    sxBonusStickyGoldIncreaseHit: 'sound/sx_bonus_sticky_gold_increase_hit',
    sxBonusStickyWin: 'sound/sx_bonus_sticky_win',
    sxTransition: 'sound/sx_transition',
    sxCounterLoop: 'sound/sx_counter_loop',
    sxCounterEnd: 'sound/sx_counter_end',
    sxPlus1Spin: 'sound/sx_plus_1_anim',
    sxGirlSymbolAnim: 'sound/sx_girl_symbol_anim',
    sxBannerDisappear: 'sound/sx_banner_disappear',
    sxIndicaterLighton: 'sound/sx_indicater_lighton',
    sxGlobalWin: 'sound/sx_global_win',
    sxPickGame: 'sound/sx_pick_game',
    sxLuchHas: 'sound/sx_luch_has',
};

const SOUND_BUNDLE = 'MainBundle';

@ccclass('SoundManager')
export class SoundManager extends Component {
    private static _instance: SoundManager | null = null;
    static get instance(): SoundManager | null { return SoundManager._instance; }

    @property({ type: AudioSource })
    bgmSource: AudioSource | null = null;

    @property({ type: AudioSource })
    sfxSource: AudioSource | null = null;

    @property({ type: AudioSource })
    coinSource: AudioSource | null = null;

    @property({ type: AudioSource })
    ambienceSource: AudioSource | null = null;

    @property({ type: AudioSource })
    bgmCrossfadeSource: AudioSource | null = null;

    /** AudioSource riêng cho âm thanh báo thắng — không bị cắt bởi REELS_START_SPIN. */
    private _winSource: AudioSource | null = null;

    @property({ type: AudioClip }) mxNormalIntro: AudioClip | null = null;
    @property({ type: AudioClip }) mxNormalLoop: AudioClip | null = null;
    @property({ type: AudioClip }) mxBonusIdle: AudioClip | null = null;
    @property({ type: AudioClip }) mxBonusLoop: AudioClip | null = null;
    @property({ type: AudioClip }) mxBonusCongratulation: AudioClip | null = null;
    @property({ type: AudioClip }) mxProgressiveWin: AudioClip | null = null;
    @property({ type: AudioClip }) mxProgressiveTransImpact: AudioClip | null = null;
    @property({ type: AudioClip }) mxProgressiveWinSkip: AudioClip | null = null;
    @property({ type: AudioClip }) mxGrandJackpotWin: AudioClip | null = null;
    @property({ type: AudioClip }) mxMajorJackpotWin: AudioClip | null = null;
    @property({ type: AudioClip }) mxMinorJackpotWin: AudioClip | null = null;
    @property({ type: AudioClip }) mxMiniJackpotWin: AudioClip | null = null;

    @property({ type: AudioClip }) sxAmbience: AudioClip | null = null;
    @property({ type: AudioClip }) sxUiClick: AudioClip | null = null;
    @property({ type: AudioClip }) sxBuyBonusButton: AudioClip | null = null;
    @property({ type: AudioClip }) sxReelSpin: AudioClip | null = null;
    @property({ type: AudioClip }) sxReelSpinQuickTurbo: AudioClip | null = null;
    @property({ type: AudioClip }) sxReelLand1: AudioClip | null = null;
    @property({ type: AudioClip }) sxReelLand2: AudioClip | null = null;
    @property({ type: AudioClip }) sxReelLand3: AudioClip | null = null;
    @property({ type: AudioClip }) sxReelLand4: AudioClip | null = null;
    @property({ type: AudioClip }) sxReelLand5: AudioClip | null = null;
    @property({ type: AudioClip }) sxReelLandAll: AudioClip | null = null;
    @property({ type: AudioClip }) sxSelectAFeature: AudioClip | null = null;
    @property({ type: AudioClip }) sxFeatureSelect: AudioClip | null = null;
    @property({ type: AudioClip }) sxSymbolMatchLowValue: AudioClip | null = null;
    @property({ type: AudioClip }) sxSymbolMatchHighValue: AudioClip | null = null;
    @property({ type: AudioClip }) sxSymbolMatchWildLayer: AudioClip | null = null;
    @property({ type: AudioClip }) sxSymbolPayout: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusTrigger: AudioClip | null = null;
    @property({ type: AudioClip }) sxPotEffectLvl2: AudioClip | null = null;
    @property({ type: AudioClip }) sxPotEffectLvl3: AudioClip | null = null;
    @property({ type: AudioClip }) sxPotEffectLvl4: AudioClip | null = null;
    @property({ type: AudioClip }) sxPotEffectLvl5: AudioClip | null = null;
    @property({ type: AudioClip }) sxPotEffectLvl6: AudioClip | null = null;
    @property({ type: AudioClip }) sxPotTrailWhoosh: AudioClip | null = null;
    @property({ type: AudioClip }) sxPotHit: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusSelectMini: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusSelectMinor: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusSelectMajor: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusSelectGrand: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusJpWin: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusFakeTrigger: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusTrail: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusStickyLand: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusStickyLand2: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusStickyLand3: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusStickyLand4: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusStickyLand5: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusStickyGoldLand: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusStickyGoldIncreaseHit: AudioClip | null = null;
    @property({ type: AudioClip }) sxBonusStickyWin: AudioClip | null = null;
    @property({ type: AudioClip }) sxTransition: AudioClip | null = null;
    @property({ type: AudioClip }) sxCounterLoop: AudioClip | null = null;
    @property({ type: AudioClip }) sxCounterEnd: AudioClip | null = null;
    @property({ type: AudioClip }) sxPlus1Spin: AudioClip | null = null;
    @property({ type: AudioClip }) sxGirlSymbolAnim: AudioClip | null = null;
    @property({ type: AudioClip }) sxBannerDisappear: AudioClip | null = null;
    @property({ type: AudioClip }) sxIndicaterLighton: AudioClip | null = null;
    @property({ type: AudioClip }) sxGlobalWin: AudioClip | null = null;
    @property({ type: AudioClip }) sxPickGame: AudioClip | null = null;
    @property({ type: AudioClip }) sxLuchHas: AudioClip | null = null;

    @property({ range: [0, 1, 0.05], slide: true })
    bgmVolume = 0.5;

    @property({ range: [0, 1, 0.05], slide: true })
    sfxVolume = 1.0;

    @property({ range: [0, 1, 0.05], slide: true })
    ambienceVolume = 0.3;

    @property({ min: 0, max: 10000, step: 100 })
    introToLoopDelayMs = 3000;

    @property({ min: 0, max: 1000, step: 50 })
    bgmFadeOutDurationMs = 300;

    /** Delay từ lúc chuyển level Progressive Win tới lúc play mx_progressive_trans_impact (giây) */
    @property({ tooltip: 'Delay (giây) từ lúc chuyển level Progressive Win → play mx_progressive_trans_impact' })
    progressiveTransImpactDelay = 0;

    private _masterMuted = false;
    private _bgmMuted = false;
    private _sfxMuted = false;
    private _speedMode: SpeedMode = SpeedMode.NORMAL;
    private _introTriggered = false;
    private _inFeatureMusic = false;
    private _turboLandPlayed = false;
    private _coinLoopActive = false;
    private _bgmFadeTick: (() => void) | null = null;
    private _crossfadeFadeTick: (() => void) | null = null;
    private _bonusLoopCallback: (() => void) | null = null;
    private _transitionSoundPlayed: boolean = false;
    private _stickyLandCount: number = 0;
    private _stickyWinSoundPlayedThisSpin: boolean = false;
    /** In-flight lazy clip loads — avoid duplicate bundle.load */
    private _lazyLoading: Map<string, Promise<AudioClip | null>> = new Map();
    private _deferredAudioKickStarted = false;
    /** Progressive Win đang mở (đang play mx_progressive_win) */
    private _progressiveWinActive = false;
    private _progressiveTransImpactCb: (() => void) | null = null;
    /** Đang play mx_progressive_win_skip trên BGM chính */
    private _progressiveSkipPlaying = false;

    onLoad(): void {
        SoundManager._instance = this;
        // Log.enable('coinloop');
        this._loadMuteSettings();
        // ★ Không addPersistRootNode(this.node): component đang gắn trên Base root.
        //   Persist cả Base lúc attach sớm (loading) phá hierarchy → bar kẹt ~81%.
        //   Instance sống theo Base shell; không cần cross-scene persist.
        this._ensureWinSource();
        this._bindEvents();
        // Boot clips trước (đã null khỏi Base), rồi warm feature/jackpot — không block instantiate
        this.scheduleOnce(() => this._kickDeferredAudioWarmup(), 0);
    }

    onDestroy(): void {
        if (SoundManager._instance === this) SoundManager._instance = null;
        this._removeBonusLoopCallback();
        this.unscheduleAllCallbacks();
        EventBus.instance.offTarget(this);
    }

    private _bindEvents(): void {
        const bus = EventBus.instance;

        bus.on(GameEvents.GAME_READY, this._onGameReady, this);
        bus.on(GameEvents.GUIDE_COMPLETE, this._onGameEntryEffect, this);
        bus.on(GameEvents.GAME_ENTRY_EFFECT, this._onGameEntryEffect, this);

        bus.on(GameEvents.SPEED_MODE_CHANGED, this._onSpeedModeChanged, this);
        bus.on(GameEvents.REELS_START_SPIN, this._onSpinStart, this);
        bus.on(GameEvents.REEL_STOPPED, this._onReelStopped, this);
        bus.on(GameEvents.LONG_SPIN_VFX_START, this._onLongSpinTriggered, this);
        bus.on(GameEvents.WIN_PRESENT_START,     this._onWinPresentStart,   this);

        bus.on(GameEvents.PROGRESSIVE_WIN_SKIP, this._onProgressiveWinSkip, this);
        bus.on(GameEvents.PROGRESSIVE_WIN_END, this._onProgressiveWinEnd, this);

        bus.on(GameEvents.JACKPOT_TRIGGER, this._onJackpotTrigger, this);
        bus.on(GameEvents.JACKPOT_END, this._onFeatureOrJackpotEnd, this);
        bus.on(GameEvents.PICK_GAME_MATCH_FOUND, this._onPickGameMatchFound, this);

        bus.on(GameEvents.FREE_SPIN_START, this._onFeatureStart, this);
        bus.on(GameEvents.FREE_SPIN_GOLD_START, this._onFeatureStart, this);
        bus.on(GameEvents.TOPUP_START, this._onFeatureStart, this);
        bus.on(GameEvents.FREE_SPIN_END_POPUP, this._onFeatureEndPopup, this);
        bus.on(GameEvents.TOPUP_END_POPUP, this._onFeatureEndPopup, this);
        bus.on(GameEvents.FREE_SPIN_END_POPUP_CLOSED, this._onFeatureEndPopupClosed, this);
        bus.on(GameEvents.TOPUP_END_POPUP_CLOSED, this._onFeatureEndPopupClosed, this);
        // FreeSpin thường không có end popup — restore normal BGM khi feature kết thúc
        bus.on(GameEvents.FREE_SPIN_END, this._onFeatureGameEnded, this);
        bus.on(GameEvents.FREE_SPIN_GOLD_END, this._onFeatureGameEnded, this);
        bus.on(GameEvents.TOPUP_END, this._onFeatureGameEnded, this);

        bus.on(GameEvents.POT_WIN_INTRO,          this._onPotWinIntro,    this);
        bus.on(GameEvents.PICK_GAME_CLOSE,          this._onPickGameClose,  this);
        bus.on(GameEvents.TOPUP_TRANSITION_SHOW, this._onTransitionShow,  this);
        bus.on(GameEvents.TOPUP_TRANSITION_DONE,  this._onTransitionDone,  this);
        bus.on(GameEvents.RED_CREDIT_UPDATED, this._onRedCreditUpdated, this);
        bus.on(GameEvents.TOPUP_ABSORB_START, this._onTopUpAbsorbStart, this);

        bus.on(GameEvents.BUY_BONUS_REQUEST, this._onBuyBonusRequest, this);
        bus.on(GameEvents.BUY_BONUS_DEACTIVATE, this._onBuyBonusDeactivate, this);

        // Carnival trail → pot (thay WILD_TRAIL_* legacy)
        bus.on(GameEvents.CARNIVAL_TRAIL_ONE, this._onCarnivalTrailOne, this);
        bus.on(GameEvents.CARNIVAL_TRAIL_ONE_HIT, this._onCarnivalTrailHit, this);
    }

    private _onCarnivalTrailOne(): void {
        this.playPotTrailWhoosh();
    }

    private _onCarnivalTrailHit(): void {
        this._playSfxProp('sxPotHit');
    }

    private _onBuyBonusRequest(): void {
        this._playSfxProp('sxBuyBonusButton');
    }

    private _onBuyBonusDeactivate(): void {
        this._playSfxProp('sxBuyBonusButton');
    }

    private _loadMuteSettings(): void {
        try {
            const music = localStorage.getItem('setting_music_muted');
            const sfx = localStorage.getItem('setting_sfx_muted');
            const master = localStorage.getItem('setting_master_muted');
            const vol = localStorage.getItem('setting_volume');
            if (music !== null) this._bgmMuted = music === 'true';
            if (sfx !== null) this._sfxMuted = sfx === 'true';
            if (master !== null) this._masterMuted = master === 'true';
            if (vol !== null) {
                const parsed = parseFloat(vol);
                if (!Number.isNaN(parsed)) {
                    this.bgmVolume = Math.max(0, Math.min(1, parsed));
                    this.sfxVolume = this.bgmVolume;
                }
            }
        } catch (err) {
            // Log.d('[SoundManager] localStorage not available', err);
        }
    }

    private _onGameReady(): void {
        this._startAmbience();
        if (GameData.instance.isResumingFreeSpin) {
            this._inFeatureMusic = true;
            void this._ensureClip('mxBonusLoop').then((clip) => {
                if (clip && this.bgmSource?.clip !== clip) {
                    this._playMusic(clip, true);
                }
            });
        }
        this._kickDeferredAudioWarmup();
    }

    /** Prefetch deferred clips in background after boot (non-blocking). */
    private _kickDeferredAudioWarmup(): void {
        if (this._deferredAudioKickStarted) return;
        this._deferredAudioKickStarted = true;
        // Priority: boot BGM/SFX (tách khỏi Base) → land/spin → feature/jackpot
        const priority = [
            'mxNormalIntro', 'mxNormalLoop', 'sxAmbience', 'sxUiClick', 'sxReelSpin',
            'mxProgressiveWin', 'mxProgressiveTransImpact', 'mxProgressiveWinSkip',
            'sxReelLand1', 'sxReelLand2', 'sxReelLand3', 'sxReelLand4', 'sxReelLand5', 'sxReelLandAll',
            'sxReelSpinQuickTurbo', 'sxSymbolMatchLowValue', 'sxSymbolMatchHighValue',
            'sxSymbolMatchWildLayer', 'sxSymbolPayout',
            'mxBonusIdle', 'mxBonusLoop', 'mxBonusCongratulation',
            'sxBonusTrigger', 'sxTransition', 'sxCounterLoop', 'sxCounterEnd',
            'sxBonusStickyLand', 'sxBonusStickyLand2', 'sxBonusStickyLand3',
            'sxBonusStickyLand4', 'sxBonusStickyLand5', 'sxBonusStickyWin',
            'sxPotTrailWhoosh', 'sxPotHit', 'sxSelectAFeature', 'sxFeatureSelect',
            'mxGrandJackpotWin', 'mxMajorJackpotWin', 'mxMinorJackpotWin', 'mxMiniJackpotWin',
        ];
        const rest = Object.keys(LAZY_AUDIO_PATHS).filter((k) => !priority.includes(k));
        const queue = [...priority, ...rest];
        let i = 0;
        const step = () => {
            if (i >= queue.length) return;
            const key = queue[i++];
            void this._ensureClip(key).finally(() => {
                // Stagger to avoid main-thread spikes
                this.scheduleOnce(step, 0.05);
            });
        };
        step();
    }

    /**
     * Ensure a SoundManager clip property is loaded.
     * Boot clips stay on the prefab; deferred clips load from MainBundle on demand.
     */
    ensureClip(prop: string): Promise<AudioClip | null> {
        return this._ensureClip(prop);
    }

    /** playSFX after ensuring deferred clip is ready (no-op if still loading). */
    playSfxByName(prop: string): void {
        this._playSfxProp(prop);
    }

    /**
     * Sticky Red land SFX — progressive sx_bonus_sticky_land → _5 (reset mỗi spin).
     * Dùng chung cho reel stop thường và sticky land FX.
     */
    playStickyLandSfx(): void {
        const props = [
            'sxBonusStickyLand',
            'sxBonusStickyLand2',
            'sxBonusStickyLand3',
            'sxBonusStickyLand4',
            'sxBonusStickyLand5',
        ];
        const idx = Math.min(this._stickyLandCount, props.length - 1);
        // Sticky land: giữ volume UI 100% (không nhân VOLUME_BASE_SCALE).
        this._playSfxProp(props[idx] ?? 'sxBonusStickyLand', true);
        this._stickyLandCount++;
    }

    private _ensureClip(prop: string): Promise<AudioClip | null> {
        const current = (this as any)[prop] as AudioClip | null | undefined;
        if (current) return Promise.resolve(current);

        const path = LAZY_AUDIO_PATHS[prop];
        if (!path) return Promise.resolve(null);

        const existing = this._lazyLoading.get(prop);
        if (existing) return existing;

        const promise = new Promise<AudioClip | null>((resolve) => {
            const bundle = assetManager.getBundle(SOUND_BUNDLE);
            if (!bundle) {
                // Log.w(`[SoundManager] Bundle '${SOUND_BUNDLE}' missing — cannot lazy-load ${prop}`);
                resolve(null);
                return;
            }
            bundle.load(path, AudioClip, (err, clip) => {
                this._lazyLoading.delete(prop);
                if (err || !clip) {
                    // Log.w(`[SoundManager] Lazy load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                (this as any)[prop] = clip;
                resolve(clip);
            });
        });
        this._lazyLoading.set(prop, promise);
        return promise;
    }

    /** playSFX after ensuring deferred clip is ready (no-op if still loading). */
    private _playSfxProp(prop: string, fullVolume = false): void {
        const clip = (this as any)[prop] as AudioClip | null;
        if (clip) {
            this.playSFX(clip, fullVolume);
            return;
        }
        void this._ensureClip(prop).then((c) => {
            if (c) this.playSFX(c, fullVolume);
        });
    }

    private _playMusicProp(prop: string, loop: boolean, onEnded?: () => void): void {
        const clip = (this as any)[prop] as AudioClip | null;
        if (clip) {
            this._playMusic(clip, loop, onEnded);
            return;
        }
        void this._ensureClip(prop).then((c) => {
            if (c) this._playMusic(c, loop, onEnded);
        });
    }

    private _onGameEntryEffect(): void {
        if (GameData.instance.isResumingFreeSpin || this._inFeatureMusic) return;
        if (this._introTriggered) return;
        this._introTriggered = true;
        void (async () => {
            const intro = await this._ensureClip('mxNormalIntro');
            const loop = await this._ensureClip('mxNormalLoop');
            this._playMusic(intro, false, () => this._playMusic(loop, true));
            const fallbackDelay = this._clipDurationSeconds(intro) || (this.introToLoopDelayMs / 1000);
            if (fallbackDelay > 0) {
                this.scheduleOnce(() => {
                    if (this.bgmSource?.clip === intro) {
                        this._playMusic(loop, true);
                    }
                }, fallbackDelay);
            }
            this._startAmbience();
        })();
    }

    private _onSpeedModeChanged(mode: SpeedMode): void {
        this._speedMode = mode;
    }

    private _onSpinStart(): void {
        // Log.d(`[coinloop][SM._onSpinStart] stopCoinLoop()`);
        this._turboLandPlayed = false;
        this._stickyLandCount = 0;
        this._stickyWinSoundPlayedThisSpin = false;
        this.stopCoinLoop();
        const quick = this._speedMode === SpeedMode.QUICK || this._speedMode === SpeedMode.TURBO;
        if (quick) {
            this._playSfxProp('sxReelSpinQuickTurbo');
        } else {
            this._playSfxProp('sxReelSpin');
        }
    }

    private _onReelStopped(payload: ReelStoppedPayload): void {
        const reelIndex = typeof payload === 'number' ? payload : payload?.reelIndex;
        if (reelIndex == null) return;

        if (this._speedMode === SpeedMode.TURBO) {
            if (!this._turboLandPlayed) {
                this._turboLandPlayed = true;
                this._playSfxProp('sxReelLandAll');
            }
            return;
        }

        if (this._speedMode === SpeedMode.NORMAL || this._speedMode === SpeedMode.QUICK) {
            const prop =
                reelIndex === 0 ? 'sxReelLand1' :
                reelIndex === 1 ? 'sxReelLand2' :
                reelIndex === 2 ? 'sxReelLand3' :
                reelIndex === 3 ? 'sxReelLand4' :
                reelIndex === 4 ? 'sxReelLand5' : null;
            if (prop) this._playSfxProp(prop);
        }
    }

    private _onLongSpinTriggered(): void {
        // Longspin anticipation: giữ volume UI 100% (không nhân VOLUME_BASE_SCALE).
        this._playSfxProp('sxBonusTrigger', true);
    }

    private _onWinPresentStart(resp: SpinResponse): void {
        const lineCount = (resp?.matchedLinePays?.length ?? 0) + (resp?.waysPayWins?.length ?? 0);
        if (lineCount <= 0) return;
        // Thắng mới → dừng âm thắng cũ (nếu còn) rồi phát lại từ đầu
        this.playSymbolPayoutForLine(lineCount);
    }

    /** Play mx_progressive_win một lần khi ProgressiveWinPopup mở (gọi từ popup, không nghe EventBus — tránh double). */
    startProgressiveWinMusic(): void {
        if (this._progressiveWinActive
            && this.mxProgressiveWin
            && this.bgmSource?.clip === this.mxProgressiveWin
            && this.bgmSource.playing) {
            return;
        }
        this._progressiveWinActive = true;
        this._progressiveSkipPlaying = false;
        this._cancelProgressiveTransImpact();
        this._playMusicProp('mxProgressiveWin', false);
        this._logProgressivePlaying('mx_progressive_win');
    }

    /**
     * Chuyển level Progressive Win — chỉ play mx_progressive_trans_impact (có delay).
     * Không đổi BGM (vẫn giữ mx_progressive_win đang chạy).
     */
    playProgressiveWinLevel(_level: number): void {
        if (!this._progressiveWinActive) return;
        // [TEMP] Tắt mx_progressive_trans_impact — bật lại khi cần.
        // this._scheduleProgressiveTransImpact();
    }

    private _logProgressivePlaying(label: string): void {
        Log.d(`[ProgressiveBGM] playing: ${label}`);
    }

    private _scheduleProgressiveTransImpact(): void {
        this._cancelProgressiveTransImpact();
        this._progressiveTransImpactCb = () => {
            this._progressiveTransImpactCb = null;
            if (!this._progressiveWinActive) return;
            this._playSfxProp('mxProgressiveTransImpact');
            this._logProgressivePlaying('mx_progressive_trans_impact');
        };
        this.scheduleOnce(this._progressiveTransImpactCb, Math.max(0, this.progressiveTransImpactDelay));
    }

    private _cancelProgressiveTransImpact(): void {
        if (!this._progressiveTransImpactCb) return;
        this.unschedule(this._progressiveTransImpactCb);
        this._progressiveTransImpactCb = null;
    }

    private _onProgressiveWinSkip(): void {
        this.stopProgressiveWinMusic();
    }

    /**
     * Skip Progressive Win: dừng mx_progressive_win → play mx_progressive_win_skip.
     * Chỉ play skip một lần khi progressive win còn active; lần gọi sau là no-op
     * (đóng popup dùng sx_banner_disappear, không replay skip).
     * Đóng popup lúc skip đang chạy → fade out skip về 0 + play loop ngay (không cắt ngang).
     */
    stopProgressiveWinMusic(): void {
        if (!this._progressiveWinActive) return;
        this._progressiveWinActive = false;
        this._cancelProgressiveTransImpact();
        if (this._bgmFadeTick) { this.unschedule(this._bgmFadeTick); this._bgmFadeTick = null; }
        this._removeBonusLoopCallback();

        const playSkip = (skip: AudioClip | null) => {
            if (!this.bgmSource) return;
            if (this.bgmSource.playing) this.bgmSource.stop();
            if (!skip) {
                this._progressiveSkipPlaying = false;
                this._cutToCurrentLoopNow();
                return;
            }
            this._progressiveSkipPlaying = true;
            this.bgmSource.clip = skip;
            this.bgmSource.loop = false;
            this.bgmSource.volume = this._scaledVolume(this.bgmVolume);
            // Fallback: nếu popup chưa đóng mà skip hết → về loop
            this._bonusLoopCallback = () => {
                this._bonusLoopCallback = null;
                this._progressiveSkipPlaying = false;
                this._cutToCurrentLoopNow();
            };
            this.bgmSource.node.once(AudioSource.EventType.ENDED, this._bonusLoopCallback, this);
            if (!this._masterMuted && !this._bgmMuted) this.bgmSource.play();
            this._logProgressivePlaying('mx_progressive_win_skip');
        };

        const clip = this.mxProgressiveWinSkip;
        if (clip) {
            playSkip(clip);
            return;
        }
        void this._ensureClip('mxProgressiveWinSkip').then(playSkip);
    }

    private _onProgressiveWinEnd(): void {
        this._progressiveWinActive = false;
        this._cancelProgressiveTransImpact();
        // Đang play skip → chuyển sang crossfade, fade dần về 0, đồng thời bật loop ngay
        if (this._progressiveSkipPlaying
            && this.mxProgressiveWinSkip
            && this.bgmSource?.clip === this.mxProgressiveWinSkip
            && this.bgmSource.playing) {
            this._fadeOutProgressiveSkipAndRestoreLoop();
            return;
        }
        this._progressiveSkipPlaying = false;
        this._cutToCurrentLoopNow();
    }

    /**
     * Hand-off mx_progressive_win_skip sang bgmCrossfadeSource → fade volume → 0,
     * đồng thời play loop trên bgmSource ngay (không chờ hết clip, không cắt ngang).
     */
    private _fadeOutProgressiveSkipAndRestoreLoop(): void {
        this._removeBonusLoopCallback();
        const main = this.bgmSource;
        if (!main) {
            this._progressiveSkipPlaying = false;
            this._cutToCurrentLoopNow();
            return;
        }

        const skipClip = main.clip;
        const skipVol = main.volume;
        const skipTime = main.currentTime;
        main.stop();
        this._progressiveSkipPlaying = false;

        // Bật loop ngay trên BGM chính
        this._startCurrentLoopImmediate();

        // Fade skip trên crossfade source (nếu không có → fallback fade tuần tự đã xong vì main đã stop)
        const xf = this.bgmCrossfadeSource;
        if (!xf || !skipClip) return;

        if (this._crossfadeFadeTick) {
            this.unschedule(this._crossfadeFadeTick);
            this._crossfadeFadeTick = null;
        }
        xf.stop();
        xf.clip = skipClip;
        xf.loop = false;
        xf.volume = skipVol;
        if (!this._masterMuted && !this._bgmMuted) {
            xf.play();
            if (skipTime > 0) {
                try { xf.currentTime = skipTime; } catch { /* platform may not support seek */ }
            }
        }
        this._fadeOutAudioSource(xf, () => {
            if (xf.isValid) {
                xf.stop();
                xf.clip = null;
            }
        });
    }

    /** Play mx_normal_loop / mx_bonus_loop ngay trên bgmSource, không đụng crossfade source. */
    private _startCurrentLoopImmediate(): void {
        if (this._bgmFadeTick) {
            this.unschedule(this._bgmFadeTick);
            this._bgmFadeTick = null;
        }
        this._removeBonusLoopCallback();

        const wantBonus = this._inFeatureMusic;
        const prop = wantBonus ? 'mxBonusLoop' : 'mxNormalLoop';
        const clip = wantBonus ? this.mxBonusLoop : this.mxNormalLoop;
        if (!this.bgmSource) return;

        const start = (c: AudioClip) => {
            if (!this.bgmSource) return;
            if (this.bgmSource.clip === c && this.bgmSource.playing && this.bgmSource.loop) return;
            this.bgmSource.stop();
            this.bgmSource.clip = c;
            this.bgmSource.loop = true;
            this.bgmSource.volume = this._bgmVolumeForClip(c);
            if (!this._masterMuted && !this._bgmMuted) this.bgmSource.play();
        };

        if (clip) {
            start(clip);
            return;
        }
        void this._ensureClip(prop).then((c) => { if (c) start(c); });
    }

    /** Fade volume của AudioSource về 0 rồi gọi onDone (dùng cho crossfade skip). */
    private _fadeOutAudioSource(source: AudioSource, onDone?: () => void): void {
        if (this._crossfadeFadeTick) {
            this.unschedule(this._crossfadeFadeTick);
            this._crossfadeFadeTick = null;
        }
        if (!source.isValid || !source.playing || this.bgmFadeOutDurationMs <= 0) {
            if (source.isValid && source.playing) source.stop();
            onDone?.();
            return;
        }
        const startVolume = source.volume;
        const steps = 10;
        let step = 0;
        const interval = (this.bgmFadeOutDurationMs / 1000) / steps;
        const tick = () => {
            if (!source.isValid) {
                this.unschedule(tick);
                if (this._crossfadeFadeTick === tick) this._crossfadeFadeTick = null;
                onDone?.();
                return;
            }
            step++;
            source.volume = startVolume * Math.max(0, 1 - step / steps);
            if (step >= steps) {
                this.unschedule(tick);
                if (this._crossfadeFadeTick === tick) this._crossfadeFadeTick = null;
                source.stop();
                onDone?.();
            }
        };
        this._crossfadeFadeTick = tick;
        this.schedule(tick, interval);
    }

    private _onJackpotTrigger(type: JackpotType): void {
        this._playSfxProp('sxBonusJpWin');
        const prop =
            type === JackpotType.GRAND ? 'mxGrandJackpotWin' :
            type === JackpotType.MAJOR ? 'mxMajorJackpotWin' :
            type === JackpotType.MINOR ? 'mxMinorJackpotWin' :
            type === JackpotType.MINI ? 'mxMiniJackpotWin' : null;
        if (prop) this._playMusicProp(prop, false);
    }

    private _onFeatureOrJackpotEnd(): void {
        // Cắt jackpot BGM ngay → loop, không fade/chờ hết clip
        this._cutToCurrentLoopNow();
    }

    private _onFeatureStart(): void {
        this._inFeatureMusic = true;
        this._startFeatureMusic();
    }

    private _onFeatureEndPopup(): void {
        // Log.d(`[coinloop][SM._onFeatureEndPopup] coinLoopActive=${this._coinLoopActive}`);
        this._inFeatureMusic = false;
        this._playMusicProp('mxBonusCongratulation', false, () => this._cutToNormalLoopNow());
    }

    private _onFeatureEndPopupClosed(): void {
        // Log.d(`[coinloop][SM._onFeatureEndPopupClosed] coinLoopActive=${this._coinLoopActive}`);
        this.stopCoinLoop();
        // Cắt congratulation ngay — không chờ hết clip (gây delay vài giây sau khi đóng popup)
        this._cutToNormalLoopNow();
    }

    /** FreeSpin/TopUp kết thúc (có hoặc không qua end popup) → về mx_normal_loop. */
    private _onFeatureGameEnded(): void {
        this._cutToNormalLoopNow();
    }

    /** Ngắt BGM hiện tại và play mx_normal_loop ngay (skip nếu đang progressive / đã là normal). */
    private _cutToNormalLoopNow(): void {
        this._inFeatureMusic = false;
        if (this._progressiveWinActive) return;
        this._cutToCurrentLoopNow();
    }

    /**
     * Ngắt BGM hiện tại (progressive skip / jackpot / …) → loop phù hợp ngay.
     * Feature còn mở → mx_bonus_loop; không thì mx_normal_loop.
     */
    private _cutToCurrentLoopNow(): void {
        if (this._progressiveWinActive) return;
        // Skip đang trên BGM chính — để ENDED / _onProgressiveWinEnd (fade) xử lý
        if (this._progressiveSkipPlaying) return;

        const wantBonus = this._inFeatureMusic;
        const targetProp = wantBonus ? 'mxBonusLoop' : 'mxNormalLoop';
        const targetClip = wantBonus ? this.mxBonusLoop : this.mxNormalLoop;
        if (targetClip && this.bgmSource?.clip === targetClip && this.bgmSource.playing) return;

        if (this._bgmFadeTick) {
            this.unschedule(this._bgmFadeTick);
            this._bgmFadeTick = null;
        }
        this._removeBonusLoopCallback();
        if (this.bgmSource?.playing) this.bgmSource.stop();
        this._playMusicProp(targetProp, true);
    }

    private _onPickGameMatchFound(): void {
        this._playSfxProp('sxBonusFakeTrigger');
    }

    private _onPotWinIntro(): void {
        this._playSfxProp('sxBonusFakeTrigger');
        this._inFeatureMusic = true;
        this._startFeatureMusic();
    }

    private _onPickGameClose(): void {
        this._inFeatureMusic = false;
        this._restoreCurrentLoop();
    }

    private _onTransitionShow(): void {
        if (this._transitionSoundPlayed) return;
        this._transitionSoundPlayed = true;
        this._playSfxProp('sxTransition');
    }

    private _onTransitionDone(): void {
        this._transitionSoundPlayed = false;
    }

    private _onRedCreditUpdated(payload?: { totalRedCredit?: number; redCount?: number; reelIndex?: number }): void {
        const redCount = payload?.redCount ?? 0;
        this.playStickyLandSfx();

        // Big red-coin win sound: play once per spin when normal-reel red coins exceed 6
        if (GameData.instance.currentMode === 'normal' && redCount > 6 && !this._stickyWinSoundPlayedThisSpin) {
            this._stickyWinSoundPlayedThisSpin = true;
            // Log.d(`[coinloop][SM._onRedCreditUpdated] redCount=${redCount} > 6 → play sxBonusStickyWin`);
            this._playSfxProp('sxBonusStickyWin');
        }
    }

    private _onTopUpAbsorbStart(_payload?: { newCells?: StickyCellLike[]; plusOneSpinCount?: number }): void {
        // +1 spin sound is now handled by TopUpAbsorbEffect when the +1 symbol is actually shown on StickyOverlay.
        // Yellow/Green coin absorb sound is handled by StickyOverlayController when they appear on overlay.
    }

    private _startFeatureMusic(): void {
        if (this.bgmSource?.clip === this.mxBonusIdle || this.bgmSource?.clip === this.mxBonusLoop) return;
        this._playMusicProp('mxBonusIdle', false, () => this._playMusicProp('mxBonusLoop', true));
    }

    private _restoreCurrentLoop(): void {
        // Đừng để listener ENDED cũ / call khác ghi đè nhạc Progressive / skip đang chạy
        if (this._progressiveWinActive || this._progressiveSkipPlaying) return;
        if (this._inFeatureMusic) {
            this._playMusicProp('mxBonusLoop', true);
        } else {
            this._playMusicProp('mxNormalLoop', true);
        }
    }

    private _playMusic(clip: AudioClip | null, loop: boolean, onEnded?: () => void): void {
        if (!this.bgmSource || !clip) return;
        this._removeBonusLoopCallback();
        // Đừng cắt crossfade đang fade-out progressive skip
        if (this.bgmCrossfadeSource?.playing && !this._crossfadeFadeTick) {
            this.bgmCrossfadeSource.stop();
        }
        const start = () => {
            if (!this.bgmSource || !clip) return;
            this.bgmSource.stop();
            this.bgmSource.clip = clip;
            this.bgmSource.loop = loop;
            this.bgmSource.volume = this._bgmVolumeForClip(clip);
            if (onEnded) {
                this._bonusLoopCallback = onEnded;
                this.bgmSource.node.once(AudioSource.EventType.ENDED, onEnded, this);
            }
            if (!this._masterMuted && !this._bgmMuted) this.bgmSource.play();
        };
        this._fadeOutBgm(start);
    }

    private _fadeOutBgm(onDone?: () => void): void {
        if (this._bgmFadeTick) {
            this.unschedule(this._bgmFadeTick);
            this._bgmFadeTick = null;
        }
        if (!this.bgmSource || !this.bgmSource.playing || this.bgmFadeOutDurationMs <= 0) {
            if (this.bgmSource?.playing) this.bgmSource.stop();
            onDone?.();
            return;
        }
        const source = this.bgmSource;
        const startVolume = source.volume;
        const steps = 10;
        let step = 0;
        const interval = (this.bgmFadeOutDurationMs / 1000) / steps;
        const tick = () => {
            step++;
            source.volume = startVolume * Math.max(0, 1 - step / steps);
            if (step >= steps) {
                this.unschedule(tick);
                if (this._bgmFadeTick === tick) this._bgmFadeTick = null;
                source.stop();
                onDone?.();
            }
        };
        this._bgmFadeTick = tick;
        this.schedule(tick, interval);
    }

    private _removeBonusLoopCallback(): void {
        if (!this._bonusLoopCallback || !this.bgmSource) return;
        this.bgmSource.node.off(AudioSource.EventType.ENDED, this._bonusLoopCallback, this);
        this._bonusLoopCallback = null;
    }

    private _startAmbience(): void {
        if (!this.ambienceSource) return;
        if (this.ambienceSource.playing) return;
        void this._ensureClip('sxAmbience').then((clip) => {
            if (!clip || !this.ambienceSource || this.ambienceSource.playing) return;
            this.ambienceSource.clip = clip;
            this.ambienceSource.loop = true;
            this.ambienceSource.volume = this._scaledVolume(this.ambienceVolume);
            if (!this._masterMuted && !this._sfxMuted) this.ambienceSource.play();
        });
    }

    private _reelLandClip(reelIndex: number): AudioClip | null {
        switch (reelIndex) {
            case 0: return this.sxReelLand1;
            case 1: return this.sxReelLand2;
            case 2: return this.sxReelLand3;
            case 3: return this.sxReelLand4;
            case 4: return this.sxReelLand5;
            default: return null;
        }
    }

    private _jackpotMusic(type: JackpotType): AudioClip | null {
        switch (type) {
            case JackpotType.GRAND: return this.mxGrandJackpotWin;
            case JackpotType.MAJOR: return this.mxMajorJackpotWin;
            case JackpotType.MINOR: return this.mxMinorJackpotWin;
            case JackpotType.MINI: return this.mxMiniJackpotWin;
            default: return null;
        }
    }

    private _clipDurationSeconds(clip: AudioClip | null): number {
        if (!clip) return 0;
        const timedClip = clip as AudioClip & { getDuration?: () => number; duration?: number };
        const duration = typeof timedClip.getDuration === 'function'
            ? timedClip.getDuration()
            : timedClip.duration;
        return typeof duration === 'number' && duration > 0 ? duration : 0;
    }

    /**
     * @param fullVolume true = dùng đúng sfxVolume UI (không nhân VOLUME_BASE_SCALE).
     *                   Dùng cho Longspin anticipation cần giữ loudness 100%.
     */
    playSFX(clip: AudioClip | null, fullVolume = false): void {
        if (!this.sfxSource || !clip || this._masterMuted || this._sfxMuted) return;
        const vol = fullVolume
            ? Math.max(0, Math.min(1, this.sfxVolume))
            : this._scaledVolume(this.sfxVolume);
        this.sfxSource.playOneShot(clip, vol);
    }

    playBGM(clip: AudioClip | null): void {
        this._playMusic(clip, true);
    }

    playCoinLoop(): void {
        // Mark intent immediately so a late async load still plays,
        // and stopCoinLoop() can cancel that intent before start() runs.
        this._coinLoopActive = true;
        const start = (clip: AudioClip) => {
            // stopCoinLoop() may have run while clip was still loading
            if (!this._coinLoopActive) return;
            if (!this.coinSource || !this.coinSource.isValid) {
                this._recreateCoinSource();
            }
            if (!this.coinSource) {
                // Log.d(`[coinloop][SM.playCoinLoop] SKIP — failed to recreate coinSource`);
                return;
            }
            this.coinSource.volume = this._scaledVolume(this.sfxVolume);
            if (this._masterMuted || this._sfxMuted) {
                // Log.d(`[coinloop][SM.playCoinLoop] SKIP — muted (master=${this._masterMuted} sfx=${this._sfxMuted})`);
                return;
            }
            const needRestart = this.coinSource.clip !== clip || !this.coinSource.loop;
            // Log.d(`[coinloop][SM.playCoinLoop] valid=${this.coinSource.isValid} playing=${this.coinSource.playing} needRestart=${needRestart}`);
            if (needRestart) {
                this.coinSource.stop();
                this.coinSource.clip = clip;
                this.coinSource.loop = true;
            }
            if (!this.coinSource.playing) {
                // Log.d(`[coinloop][SM.playCoinLoop] ▶ play()`);
                this.coinSource.play();
            } else {
                // Log.d(`[coinloop][SM.playCoinLoop] already playing, skip play()`);
            }
        };

        if (this.sxCounterLoop) {
            start(this.sxCounterLoop);
            return;
        }
        void this._ensureClip('sxCounterLoop').then((clip) => {
            if (!clip) {
                // Log.d(`[coinloop][SM.playCoinLoop] SKIP — sxCounterLoop load failed`);
                return;
            }
            start(clip);
        });
    }

    stopCoinLoop(): void {
        // Log.d(`[coinloop][SM.stopCoinLoop] coinLoopActive=${this._coinLoopActive} playing=${this.coinSource?.playing}`);
        this._coinLoopActive = false;
        if (!this.coinSource) return;

        // Cocos AudioSource on a persistent node ignores onDisable; stop()/clip=null
        // are async and may leave a stuck Web Audio player. Recreate the component
        // to guarantee the underlying player is destroyed.
        this.coinSource.volume = 0;
        this.coinSource.stop();
        this.coinSource.loop = false;
        this.coinSource.clip = null;
        this._recreateCoinSource();
    }

    private _recreateCoinSource(): void {
        if (!this.node) return;
        const oldSource = this.coinSource;
        this.coinSource = this.node.addComponent(AudioSource);
        // Log.d(`[coinloop][SM._recreateCoinSource] oldValid=${oldSource?.isValid ?? false} newValid=${this.coinSource?.isValid ?? false}`);
        if (oldSource && oldSource.isValid) {
            oldSource.destroy();
        }
    }

    playCoinEnd(): void {
        // Log.d(`[coinloop][SM.playCoinEnd] ► play sxCounterEnd`);
        this._playSfxProp('sxCounterEnd');
    }

    playCounterStart(): void {
        // Removed from the new asset list. Kept as a compatibility no-op.
    }

    playButtonClick(): void {
        this._playSfxProp('sxUiClick');
    }

    playBannerDisappear(): void {
        this._playSfxProp('sxBannerDisappear');
    }

    playGlobalWin(): void {
        this._playSfxProp('sxGlobalWin');
    }

    /** TransitionPopup vừa bắt đầu play spine anim. */
    playPickGame(): void {
        this._playSfxProp('sxPickGame');
    }

    playBonusSelect(type: JackpotType): void {
        switch (type) {
            case JackpotType.MINI: this._playSfxProp('sxBonusSelectMini'); break;
            case JackpotType.MINOR: this._playSfxProp('sxBonusSelectMinor'); break;
            case JackpotType.MAJOR: this._playSfxProp('sxBonusSelectMajor'); break;
            case JackpotType.GRAND: this._playSfxProp('sxBonusSelectGrand'); break;
            default: break;
        }
    }

    playGirlSymbolAnim(): void {
        this._playSfxProp('sxGirlSymbolAnim');
    }

    playSymbolPayoutForLine(_lineCount: number): void {
        // Chỉ play payout; high/low/wild match do SymbolHighlighter chọn theo symbol.
        this._recreateWinSource();
        this._playWinOneShot('sxSymbolPayout');
    }

    /** Match SFX theo loại symbol thắng — chỉ gọi 1 trong 3 (high / low / wild). */
    playSymbolMatchHigh(): void {
        this._playWinOneShot('sxSymbolMatchHighValue');
    }

    playSymbolMatchLow(): void {
        this._playWinOneShot('sxSymbolMatchLowValue');
    }

    private _ensureWinSource(): AudioSource | null {
        if (this._winSource?.isValid) return this._winSource;
        if (!this.node) return null;
        this._winSource = this.node.addComponent(AudioSource);
        this._winSource.playOnAwake = false;
        this._winSource.loop = false;
        this._winSource.volume = this._scaledVolume(this.sfxVolume);
        return this._winSource;
    }

    private _recreateWinSource(): void {
        if (!this.node) return;
        const old = this._winSource;
        this._winSource = this.node.addComponent(AudioSource);
        this._winSource.playOnAwake = false;
        this._winSource.loop = false;
        this._winSource.volume = this._scaledVolume(this.sfxVolume);
        if (old?.isValid) {
            old.stop();
            old.destroy();
        }
    }

    /** playOneShot trên winSource — không bị REELS_START_SPIN cắt. */
    private _playWinOneShot(prop: string): void {
        const play = (clip: AudioClip) => {
            if (this._masterMuted || this._sfxMuted) return;
            const src = this._ensureWinSource();
            if (!src) return;
            const vol = this._scaledVolume(this.sfxVolume);
            src.volume = vol;
            src.playOneShot(clip, vol);
        };

        const clip = (this as any)[prop] as AudioClip | null;
        if (clip) {
            play(clip);
            return;
        }
        void this._ensureClip(prop).then((c) => {
            if (c) play(c);
        });
    }

    playSymbolMatch7(): void {
        this.playGirlSymbolAnim();
    }

    playSymbolMatchBar(): void {
        // Removed from the new asset list. Kept as a compatibility no-op.
    }

    playSymbolMatchWild(): void {
        this._playWinOneShot('sxSymbolMatchWildLayer');
    }

    playBuyBonusButton(): void {
        this._playSfxProp('sxBuyBonusButton');
    }

    playNormalIntro(): void {
        this._onGameEntryEffect();
    }

    playBonusTrail(): void {
        this._playSfxProp('sxBonusTrail');
    }

    playPotTrailWhoosh(): void {
        this._playSfxProp('sxPotTrailWhoosh');
    }

    playFeatureSelectMusic(): void {
        this._inFeatureMusic = true;
        this._startFeatureMusic();
    }

    initBGM(): void {
        this._startAmbience();
        if (GameData.instance.isResumingFreeSpin) {
            this._inFeatureMusic = true;
            this._playMusicProp('mxBonusLoop', true);
        }
    }

    getStatus(): object {
        return {
            hasInstance: !!SoundManager._instance,
            hasBgmSource: !!this.bgmSource,
            hasMxNormalLoop: !!this.mxNormalLoop,
            bgmMuted: this._bgmMuted,
            masterMuted: this._masterMuted,
            speedMode: this._speedMode,
            inFeatureMusic: this._inFeatureMusic,
        };
    }

    setMasterVolume(ratio: number): void {
        const v = Math.max(0, Math.min(1, ratio));
        this.bgmVolume = v;
        this.sfxVolume = v;
        const scaled = this._scaledVolume(v);
        if (this.bgmSource && !this._bgmMuted) {
            this.bgmSource.volume = this._bgmVolumeForClip(this.bgmSource.clip);
        }
        if (this.sfxSource) this.sfxSource.volume = scaled;
        if (this.coinSource) this.coinSource.volume = scaled;
        if (this._winSource) this._winSource.volume = scaled;
        if (this.ambienceSource) this.ambienceSource.volume = this._scaledVolume(v * this.ambienceVolume);
        try { localStorage.setItem('setting_volume', String(v)); } catch (_) {}
    }

    get masterVolume(): number { return this.bgmVolume; }

    /** Apply global base scale so UI 100% = VOLUME_BASE_SCALE. */
    private _scaledVolume(ratio: number): number {
        return Math.max(0, Math.min(1, ratio)) * VOLUME_BASE_SCALE;
    }

    /** BGM volume for a clip — mx_normal_loop is quieter than other tracks. */
    private _bgmVolumeForClip(clip: AudioClip | null): number {
        const base = this._scaledVolume(this.bgmVolume);
        if (clip && this.mxNormalLoop && clip === this.mxNormalLoop) {
            return base * MX_NORMAL_LOOP_VOLUME_SCALE;
        }
        return base;
    }

    setBGMMuted(muted: boolean): void {
        if (this._bgmMuted === muted) return;
        this._bgmMuted = muted;
        if (!this.bgmSource) return;
        if (muted) {
            this.bgmSource.pause();
            this.bgmCrossfadeSource?.pause();
        } else if (!this._masterMuted) {
            if (this.bgmSource.clip) this.bgmSource.play();
            else this._restoreCurrentLoop();
        }
    }

    setSFXMuted(muted: boolean): void {
        if (this._sfxMuted === muted) return;
        this._sfxMuted = muted;
        if (muted) {
            // Log.d(`[coinloop][SM.setSFXMuted] muted=true → stopCoinLoop()`);
            this.stopCoinLoop();
            this._recreateWinSource();
            this.ambienceSource?.stop();
        } else if (!this._masterMuted) {
            if (this._coinLoopActive) this.playCoinLoop();
            this._startAmbience();
        }
    }

    toggleBGM(): void { this.setBGMMuted(!this._bgmMuted); }
    toggleSFX(): void { this.setSFXMuted(!this._sfxMuted); }

    setMasterMuted(muted: boolean): void {
        if (this._masterMuted === muted) return;
        this._masterMuted = muted;
        if (muted) {
            this.bgmSource?.pause();
            this.bgmCrossfadeSource?.pause();
            this.sfxSource?.pause();
            this.coinSource?.pause();
            this._winSource?.pause();
            this.ambienceSource?.pause();
        } else {
            if (this.bgmSource?.clip && !this._bgmMuted) this.bgmSource.play();
            if (!this._sfxMuted) {
                if (this._coinLoopActive) this.playCoinLoop();
                this._startAmbience();
            }
        }
    }
}
