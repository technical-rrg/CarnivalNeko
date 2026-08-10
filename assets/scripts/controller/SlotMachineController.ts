/**
 * SlotMachineController - Điều phối 5 ReelController.
 *
 * FLOW 2 PHA:
 *   Phase 1: REELS_START_SPIN → reel quay ngay lập tức (trước khi chờ server)
 *   Phase 2: SPIN_RESPONSE    → ra lệnh dừng reel tại đúng vị trí (rands)
 *
 * LONG SPIN VFX:
 *   Khi LONG_SPIN_TRIGGERED: Cột cuối (reel 5) delay thêm 2.5–3s.
 *   Ngay khi Cột áp chót dừng xong → bật longSpinVFXNode + emit LONG_SPIN_VFX_START (audio anticipation).
 *   Khi Cột cuối dừng hẳn     → tắt longSpinVFXNode + emit LONG_SPIN_VFX_END (audio thud).
 *   Khi Long Spin ở reel cuối → Zoom In bằng Camera (orthoHeight + pan) tạo hồi hộp;
 *   Zoom Out khi VFX tắt. Tạm tắt Canvas.alignCanvasWithScreen để orthoHeight có hiệu lực.
 *
 * LONG SPIN VFX (lazy):
 *   Prefab `fxLongSpin` (Spine Longspin) tách khỏi Base — load qua LongSpinVFXLoader
 *   khi LONG_SPIN_TRIGGERED. Có thể gán sẵn longSpinVFXNode trong Editor (optional).
 */

import { _decorator, Component, Node, Sprite, SpriteFrame, screen, Prefab, instantiate, Vec3, tween, Tween, Camera, Canvas } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { SpinResponse, SymbolId, isFreeSpinTierReelIndex } from '../data/SlotTypes';
import { GameData } from '../data/GameData';
import { ReelController } from './ReelController';
import { SymbolView } from './SymbolView';
import { WaysPayDisplay } from './WaysPayDisplay';
import { SymbolHighlighter } from './SymbolHighlighter';
import { AutoSpinManager, SpeedMode } from '../manager/AutoSpinManager';
import { Log } from '../core/Logger';
import { SpriteNumber } from '../core/SpriteNumber';
import { LongSpinVFXLoader } from './LongSpinVFXLoader';
import {
    crossfadeSpriteFrame,
    fadeInNode,
    fadeNodeOpacity,
    fadeOutNode,
    setNodeOpacity,
    DEFAULT_UI_FADE_DURATION,
} from '../core/OpacityFadeUtil';

const { ccclass, property } = _decorator;

// ─── PER-MODE SPEED CONFIGURATION ───────────────────────────────────────────
/**
 * Holds all tunable speed parameters for one SpeedMode (NORMAL / QUICK / TURBO).
 * Drag the three instances (normalModeSettings, quickModeSettings, turboModeSettings)
 * from the SlotMachineController Inspector to adjust without touching code.
 */
@ccclass('SpeedModeSettings')
class SpeedModeSettings {
    @property({
        tooltip: [
            'Reel scroll speed while spinning (pixels / sec).',
            'Higher value = faster visual scroll.',
            'Recommended → Normal: 7000 | Quick: 7000 | Turbo: 10000',
        ].join('\n'),
    })
    spinSpeed: number = 7000;

    @property({
        tooltip: [
            'Minimum time the reel must keep spinning before it is allowed to stop — Normal Spin (seconds).',
            'Prevents the reel from stopping too early when the server response arrives quickly.',
            'Recommended → Normal: 0.25 | Quick: 0.2 | Turbo: 0.125',
        ].join('\n'),
    })
    minSpinDuration: number = 0.25;

    @property({
        tooltip: [
            'Same as minSpinDuration but applied when Free Spin is active (seconds).',
            'Free Spin usually feels better with a slightly longer minimum.',
            'Recommended → Normal: 0.5 | Quick: 0.3 | Turbo: 0.2',
        ].join('\n'),
    })
    minSpinDurationFreeSpin: number = 0.5;

    @property({
        tooltip: [
            'How long the reel takes to decelerate from full speed to a stop — Normal Spin (seconds).',
            'Shorter = snappier stop. Longer = more dramatic slowdown.',
            'Recommended → Normal: 0.15 | Quick: 0.15 | Turbo: 0.05',
        ].join('\n'),
    })
    decelDuration: number = 0.15;

    @property({
        tooltip: [
            'Deceleration duration when Free Spin is active (seconds).',
            'Recommended → Normal: 0.27 | Quick: 0.27 | Turbo: 0.09',
        ].join('\n'),
    })
    decelDurationFreeSpin: number = 0.27;

    @property({
        tooltip: [
            'Extra wait time added before last reel begins decelerating when a Long Spin is triggered (seconds).',
            'Creates the anticipation window before the big reveal.',
            'Recommended → Normal: 2 | Quick: 0.8 | Turbo: 1',
        ].join('\n'),
    })
    longSpinDelay: number = 2;

    @property({
        tooltip: [
            'Reel scroll speed during Long Spin (pixels / sec). 0 = use spinSpeed.',
            'Higher than spinSpeed → more rotations within the same anticipation window.',
            'Recommended → Normal: 10000 | Quick: 10000 | Turbo: 14000',
        ].join('\n'),
    })
    longSpinSpeed: number = 10000;

    @property({
        tooltip: [
            'Skip the upward bounce animation that plays at the very start of each spin.',
            'Enable for QUICK and TURBO so reels begin scrolling instantly.',
            'Recommended → Normal: false | Quick: true | Turbo: true',
        ].join('\n'),
    })
    skipLaunchBounce: boolean = false;

    @property({
        tooltip: [
            'When enabled, all reels start decelerating simultaneously (stopDelay = 0).',
            'When disabled, each reel waits reelIndex × stopInterval seconds before stopping (stagger effect).',
            'Enable for QUICK and TURBO. Leave off for NORMAL.',
            'Recommended → Normal: false | Quick: true | Turbo: true',
        ].join('\n'),
    })
    noStopDelay: boolean = false;
}

@ccclass('SlotMachineController')
export class SlotMachineController extends Component {

    @property({ type: [ReelController], tooltip: 'Kéo các ReelController (cột 0..4) vào đây' })
    reels: ReelController[] = [];

    @property({
        type: Prefab,
        tooltip: 'Prefab SpriteNumber cho Sticky Red symbol.\n'
               + 'Tạo 1 Prefab chứa Node có SpriteNumber component.\n'
               + 'SlotMachineController tự instantiate và inject vào mọi SymbolView.\n'
               + 'Để null → SpriteNumber disabled (không hiện giá trị trên sticky red).',
    })
    creditLabelPrefab: Prefab | null = null;

    @property({
        type: [SpriteFrame],
        tooltip: 'SpriteFrame cho từng Symbol — kéo 1 lần, áp dụng cho mọi SymbolView.\n[0]=minor_9 [1]=minor_10 [2]=minor_j [3]=minor_q [4]=minor_k [5]=minor_a [6]=major_horus [7]=major_anubis [8]=major_sobek [9]=major_ramses [10]=major_cleopatra [11]=wild_trail [12]=sticky_red [13]=sticky_yellow [14]=sticky_green [15]=plus_one_spin',
    })
    symbolFrames: SpriteFrame[] = [];

    @property({
        type: [SpriteFrame],
        tooltip: 'SpriteFrame BLUR tương ứng — kéo 1 lần, áp dụng cho mọi SymbolView.\nIndex = SymbolId (giống symbolFrames). Chỉ cần blur cho symbol 0..8 (xuất hiện trên reel).',
    })
    blurFrames: SpriteFrame[] = [];

    @property({
        type: Node,
        tooltip: 'Node template Spine cho highlight ô thắng (Ways Pay).\n'
               + 'Đặt 1 Node inactive trong scene, gắn sp.Skeleton với SkeletonData đúng.\n'
               + 'WaysPayDisplay sẽ instantiate node này thành pool khi start().',
    })
    highlightSpinePrefab: Node | null = null;

    @property({ tooltip: 'Tên animation Spine phát khi highlight (mặc định: "animation")' })
    highlightSpineAnim: string = 'animation';

    @property({
        type: WaysPayDisplay,
        tooltip: 'WaysPayDisplay component — gắn vào node nào đó trên scene, kéo vào đây.\nSlotMachineController sẽ tự gọi init() với highlightSpinePrefab + reels.',
    })
    waysPayDisplay: WaysPayDisplay | null = null;

    @property({ type: Node, tooltip: 'Slot machine background node (animated background quanh reels)' })
    slotBackgroundNode: Node | null = null;

    @property({ type: SpriteFrame, tooltip: 'Slot background sprite - Normal Spin' })
    normalSprite: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'Slot background sprite - Free Spin' })
    freeSpinSprite: SpriteFrame | null = null;

    @property({ tooltip: 'Fade SlotMachine / ReelMask / slot BG khi vào Feature/Pick (giây)' })
    uiFadeDuration: number = DEFAULT_UI_FADE_DURATION;

    @property({ tooltip: 'Delay giữa việc bắt đầu quay mỗi reel (seconds)' })
    startStaggerDelay: number = 0.3;

    @property({ tooltip: 'Delay giữa việc dừng mỗi reel (seconds)' })
    stopInterval: number = 0.3;

    @property({ tooltip: 'Thời gian giảm tốc của Reel cuối khi Long Spin — ngắn hơn để dừng dứt khoát (seconds)' })
    longSpinDecelDuration: number = 0.5;

    @property({ tooltip: 'Thêm delay (giây) cho longspin ở reel cuối so với longspin thường — kéo anticipation lâu hơn một chút' })
    longSpinLastReelExtraDelay: number = 0.5;

    @property({ tooltip: 'Chiều cao nhảy lên khi bắt đầu spin (nhân với symbolHeight). VD: 0.5 = nhảy lên 50% chiều cao symbol.' })
    launchBounceHeightRatio: number = 0.5;

    @property({ tooltip: 'Thời gian nhảy lên trong launch bounce (giây).' })
    launchBounceUpDuration: number = 0.12;

    @property({ tooltip: 'Thời gian rơi xuống trong launch bounce (giây).' })
    launchBounceDownDuration: number = 0.25;

    @property({ tooltip: 'Chiều cao hạ thêm xuống khi reel dừng (nhân với symbolHeight). VD: 0.08 = hạ thêm 8% chiều cao symbol rồi snap về.' })
    stopBounceOvershootRatio: number = 0.08;

    @property({ tooltip: 'Thời gian snap lui về vị trí đích khi reel dừng (giây).' })
    stopBounceSettleDuration: number = 0.12;

    @property({ tooltip: 'Delay (giây) giữa khi một longspin reel dừng và khi reel longspin tiếp theo bắt đầu quay' })
    longSpinNextReelDelay: number = 0.5;

    @property({ tooltip: 'Nếu true mới diễn longSpin khi đủ 3 symbol đỏ; false thì bỏ qua.' })
    isLongSpin: boolean = true;

    @property({
        tooltip: 'Center index khởi tạo cho mỗi reel (trước lần spin đầu tiên).\nLấy từ vị trí strip 1,2,3 của Parsheet (0-based: 0,1,2).',
    })
    initialCenterIndices: number[] = [0, 1, 2];

    // ─── SPEED MODE SETTINGS ───
    @property({
        type: SpeedModeSettings,
        tooltip: [
            '[NORMAL mode] Speed parameters used during standard spin.',
            'stopDelay is derived from reelIndex × stopInterval (set above).',
            'Default values → spinSpeed:7000 | minSpin:0.25/0.5fs | decel:0.15/0.27fs | longSpinDelay:2 | bounce:on | stagger:on',
        ].join('\n'),
    })
    normalModeSettings: SpeedModeSettings = new SpeedModeSettings();

    @property({
        type: SpeedModeSettings,
        tooltip: [
            '[QUICK mode] Faster spin with stagger between reels (like Normal) but no launch bounce.',
            'Default values → spinSpeed:7000 | minSpin:0.2/0.3fs | decel:0.15/0.27fs | longSpinDelay:1.5 | bounce:off | stagger:on',
        ].join('\n'),
    })
    quickModeSettings: SpeedModeSettings = (() => {
        const s = new SpeedModeSettings();
        s.spinSpeed              = 7000;
        s.minSpinDuration        = 0.2;
        s.minSpinDurationFreeSpin = 0.3;
        s.decelDuration          = 0.15;
        s.decelDurationFreeSpin  = 0.27;
        s.longSpinDelay          = 1.5;
        s.longSpinSpeed          = 10000;
        s.skipLaunchBounce       = true;
        s.noStopDelay            = false;
        return s;
    })();

    @property({
        type: SpeedModeSettings,
        tooltip: [
            '[TURBO mode] Maximum speed — instant start, instant stop, no stagger.',
            'Default values → spinSpeed:10000 | minSpin:0.125/0.2fs | decel:0.05/0.09fs | longSpinDelay:1 | bounce:off | stagger:off',
        ].join('\n'),
    })
    turboModeSettings: SpeedModeSettings = (() => {
        const s = new SpeedModeSettings();
        s.spinSpeed              = 10000;
        s.minSpinDuration        = 0.125;
        s.minSpinDurationFreeSpin = 0.2;
        s.decelDuration          = 0.05;
        s.decelDurationFreeSpin  = 0.09;
        s.longSpinDelay          = 1.5;
        s.longSpinSpeed          = 14000;
        s.skipLaunchBounce       = true;
        s.noStopDelay            = true;
        return s;
    })();

    /** Set các reel index cần long spin (được tính progressive từ redReels) */
    private _longSpinReelSet: Set<number> = new Set();
    /** Flag tích cực: true suốt từ khi LONG_SPIN_TRIGGERED đến khi longspin reel cuối dừng */
    private _isLongSpinActive: boolean = false;
    private _stoppedCount: number = 0;
    /** True khi tất cả reel đã dừng hẳn (bounce xong) — guard cho spin tiếp theo */
    private _allReelsStopped: boolean = true;
    private _stoppedReelSet: Set<number> = new Set();
    private _pendingOutOfOrderStops: Set<number> = new Set();
    private _longSpinBoundary: number = -1;
    private _pendingReelStarts: { reel: ReelController; triggerTime: number }[] = [];
    /**
     * Hàng đợi các reel đang tiếp tục quay (loop) và chờ đến lượt dừng.
     * Mỗi reel sau longspin boundary sẽ KHÔNG bị freeze — chúng tiếp tục spin bình thường.
     * stopAt() chỉ được gọi khi reel ngay trước nó đã dừng xong.
     */
    private _waitingReels: { reelIndex: number; centerIndex: number; isLong: boolean }[] = [];

    // ─── LONG SPIN VFX ───
    /**
     * Node hiệu ứng VFX bao quanh Cột 3 khi long spin.
     *
     * EDITOR SETUP:
     *   - Tạo Node con "LongSpinVFX" đặt chồng lên Cột 3 (z-order cao hơn).
     *   - Gắn Sprite component vào Node đó.
     *   - Kéo Node vào slot này.
     *   - Bắt đầu active = false.
     */
    @property({ type: Node, tooltip: 'Optional: Node VFX long spin. Nếu trống → lazy-load fxLongSpin.prefab khi LONG_SPIN_TRIGGERED' })
    longSpinVFXNode: Node | null = null;

    /**
     * Mảng SpriteFrame cho animation VFX (loop).
     *
     * EDITOR SETUP:
     *   - Kéo lần lượt các frame ảnh vào mảng này theo thứ tự.
     *   - Tạm thời dùng sprite thường; sau thay bằng Spine.
     */
    @property({ type: [SpriteFrame], tooltip: 'Danh sách SpriteFrame cho animation VFX loop\n→ Kéo lần lượt các frame vào đây' })
    vfxFrames: SpriteFrame[] = [];

    @property({ tooltip: 'Tốc độ chạy frame VFX (frames/giây)' })
    vfxFPS: number = 12;

    // ─── LONG SPIN ZOOM (Camera.orthoHeight + pan — toàn bộ visual game) ───
    @property({ tooltip: 'Bật Zoom In Camera khi Long Spin xuất hiện ở reel cuối' })
    enableLongSpinCameraZoom: boolean = true;

    @property({
        tooltip: [
            'Mức Zoom In Camera (1.0 = không zoom). orthoHeight /= scale.',
            'Recommended → 1.25 ~ 1.45',
        ].join('\n'),
    })
    longSpinZoomScale: number = 1.35;

    @property({ tooltip: 'Thời gian Zoom In khi anticipation bắt đầu (giây). Nhỏ hơn = nhanh hơn.' })
    longSpinZoomInDuration: number = 0.4;

    @property({ tooltip: 'Delay sau khi reel cuối dừng trước khi Zoom Out về vị trí cũ (giây)' })
    longSpinZoomOutDelay: number = 0.5;

    @property({ tooltip: 'Thời gian Zoom Out khi reel cuối dừng (giây)' })
    longSpinZoomOutDuration: number = 0.3;

    @property({
        tooltip: [
            'Camera pan X (world). Dương = camera dịch về phía reel cuối',
            '→ reel bị kéo sang trái vào giữa màn.',
            'Recommended → 80 ~ 160',
        ].join('\n'),
    })
    longSpinZoomPanX: number = 120;

    @property({
        tooltip: [
            'Camera pan Y (world). Dương = camera dịch xuống',
            '→ reel bị kéo lên giữa màn.',
            'Recommended → 40 ~ 120',
        ].join('\n'),
    })
    longSpinZoomPanY: number = 80;

    @property({ tooltip: 'Rung nhẹ camera ngay khi bắt đầu Zoom In (anticipation)' })
    enableLongSpinZoomShake: boolean = true;

    @property({ tooltip: 'Biên độ rung camera (px). Recommended → 2~3 (nhẹ)' })
    longSpinZoomShakeAmplitude: number = 2.5;

    @property({ tooltip: 'Thời gian mỗi nhịp rung (giây). Recommended → 0.05~0.07' })
    longSpinZoomShakeStep: number = 0.055;

    private _vfxSprite: Sprite | null = null;
    private _vfxFrameIdx: number = 0;
    private _vfxCb: (() => void) | null = null;

    /** UI Camera dùng để zoom Longspin (Canvas.cameraComponent). */
    private _zoomCamera: Camera | null = null;
    private _zoomCanvas: Canvas | null = null;
    private _particle3DCamera: Camera | null = null;
    private _zoomBaseOrtho: number = 0;
    private _zoomEndOrtho: number = 0;
    private readonly _zoomBaseCamPos: Vec3 = new Vec3();
    private readonly _zoomEndCamPos: Vec3 = new Vec3();
    private _zoomBaseAlign: boolean = true;
    private _isZoomActive: boolean = false;
    private _isZoomShaking: boolean = false;
    /** Tiến độ Zoom In 0→1 — kết hợp với shake offset mỗi frame. */
    private _zoomProgress: { t: number } = { t: 0 };
    /** Offset rung camera. */
    private _zoomShakeOffset: { x: number; y: number } = { x: 0, y: 0 };
    /** Callback delay Zoom Out sau khi reel cuối dừng */
    private _zoomOutDelayCb: (() => void) | null = null;
    private _isFreeSpin: boolean = false;
    /** TopUp mode: reel dùng normal strips (không dùng freeSpinReelStrips), StickyOverlayController lo hiển thị coin */
    private _isTopUp: boolean = false;
    /** PickGame mode: đổi slot background giống FreeSpin/TopUp */
    private _isPickGame: boolean = false;
    /** Twin sprite cho crossfade slot frame BG. */
    private _slotBgFadeTwin: Node | null = null;
    /** Ẩn SlotMachine khi vào Pick Game; hiện lại khi PICK_GAME_CLOSE */
    private _wasActiveBeforePickGame: boolean = true;
    private _pendingPickGameHide: boolean = false;
    /** Danh sách {reelIndex, rowIndex} cần show hint khi long spin bắt đầu */
    private _hintPositions: { reelIndex: number; rowIndex: number }[] = [];
    private _hintBounceCb: (() => void) | null = null;

    // ─── LIFECYCLE ───

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.REELS_START_SPIN, this._onReelsStartSpin, this);
        bus.on(GameEvents.SPIN_RESPONSE, this._onSpinResponse, this);
        bus.on(GameEvents.LONG_SPIN_TRIGGERED, this._onLongSpin, this);
        bus.on(GameEvents.LONG_SPIN_SYMBOL_HINT, this._onLongSpinHint, this);
        bus.on(GameEvents.ENTER_SUCCESS, this._onEnterSuccess, this);
        bus.on(GameEvents.FREE_SPIN_START, this._onFreeSpinStart, this);
        bus.on(GameEvents.FREE_SPIN_END, this._onFreeSpinEnd, this);
        bus.on(GameEvents.TOPUP_START, this._onTopUpStart, this);
        bus.on(GameEvents.TOPUP_END, this._onTopUpEnd, this);
        bus.on(GameEvents.PICK_GAME_OPEN, this._onPickGameOpen, this);
        bus.on(GameEvents.PICK_GAME_ENTRY_DONE, this._onPickGameEntryDone, this);
        bus.on(GameEvents.TOPUP_TRANSITION_READY, this._onPickGameTransitionReady, this);
        bus.on(GameEvents.TOPUP_TRANSITION_DONE, this._onPickGameTransitionDone, this);
        bus.on(GameEvents.PICK_GAME_CLOSE, this._onPickGameClose, this);
        bus.on(GameEvents.REELS_QUICK_STOP, this._onQuickStop, this);
        bus.on(GameEvents.RESUME_NORMAL_SPIN, this._onResumeNormalSpin, this);
        bus.on(GameEvents.RESUME_FREE_SPIN_REELS, this._onResumeFreeSpinReels, this);
        bus.on(GameEvents.BET_CHANGED, this._onBetChanged, this);

        // Khởi tạo AutoSpinManager sớm
        AutoSpinManager.instance;

        // Gán stopDelay tăng dần cho từng reel
        for (let i = 0; i < this.reels.length; i++) {
            this.reels[i].reelIndex = i;
            this.reels[i].stopDelay = i * this.stopInterval;
        }

        // Cache Sprite component trên VFX node
        if (this.longSpinVFXNode) {
            this._vfxSprite = this.longSpinVFXNode.getComponent(Sprite);
            this.longSpinVFXNode.active = false;
        }

        // Phân phối symbolFrames sớm trong onLoad() — trước khi bất kỳ event nào
        // (ENTER_SUCCESS, RESUME_NORMAL_SPIN) fire và gọi setSymbols() trên reels.
        this._distributeFramesToSymbolViews();
    }

    start(): void {

        // Khởi tạo WaysPayDisplay với highlightSpinePrefab + reels
        if (this.waysPayDisplay) {
            this.waysPayDisplay.init(this.reels, this.highlightSpinePrefab, this.highlightSpineAnim);
            SymbolView.landBounceParent = this.waysPayDisplay.node;
        }

        // Auto-wire paylineManagerNode cho SymbolHighlighter nếu chưa gán trong Editor
        const symHighlighter = this.node.getComponent(SymbolHighlighter)
            ?? this.node.getComponentInChildren(SymbolHighlighter);
        if (symHighlighter && !symHighlighter.paylineManagerNode && this.waysPayDisplay) {
            symHighlighter.paylineManagerNode = this.waysPayDisplay.node;
        }

        // Hiển thị symbol cố định từ vị trí strip ban đầu
        const reelCount = this.reels.length;
        // SAFE fallback: [0,1,0,0,...] tránh các vị trí red trong DEFAULT_REEL_STRIPS
        const safeFallback = Array.from({ length: reelCount }, (_, i) => i <= 1 ? i : 0);
        const indices = this.initialCenterIndices.length >= reelCount
            ? this.initialCenterIndices
            : safeFallback;
        // Log removed for performance
        this.setInitialSymbols(indices);

        // Gọi trực tiếp _onEnterSuccess() — real data đã có trong GameData nếu ENTER_SUCCESS đã fire.
        // Lần áp dứt khoát được đảm bảo bởi applyInitialSymbols() gọi từ _onLoadingComplete().
        this._onEnterSuccess();
    }

    /**
     * Gọi từ GameEntryController — đảm bảo symbols có hình đúng trước khi lộ GameView.
     * @returns false nếu strips/reels chưa sẵn (caller nên retry frame sau).
     */
    public applyInitialSymbols(): boolean {
        const strips = GameData.instance.getReelStrips(false);
        if (!strips || strips.length < this.reels.length) return false;
        if (this.reels.length === 0 || this.reels.some((r) => !r?.isValid || !r.isInitialized)) return false;
        this._onEnterSuccess();
        return this.reels.every((r) => r.areSymbolsAssigned);
    }

    /** true khi đã có strip data + reel components sẵn để gán symbol. */
    public isReelDataReady(): boolean {
        const strips = GameData.instance.getReelStrips(false);
        return !!strips
            && strips.length >= this.reels.length
            && this.reels.length > 0
            && this.reels.every((r) => r?.isValid && r.isInitialized);
    }

    /**
     * Instantiate CreditLabel cho SymbolView chưa có (lazy / on-demand).
     * Không gọi lúc load — _distributeFramesToSymbolViews cũng tạo khi cần.
     */
    public ensureCreditLabels(): void {
        if (!this.creditLabelPrefab) return;
        for (const reel of this.reels) {
            for (const node of reel.symbolNodes) {
                const view = node.getComponent(SymbolView);
                if (view && !view.SpriteNumber) {
                    const snNode = instantiate(this.creditLabelPrefab);
                    node.addChild(snNode);
                    view.SpriteNumber = snNode.getComponent(SpriteNumber)
                        ?? snNode.getComponentInChildren(SpriteNumber);
                    if (view.SpriteNumber) {
                        view.SpriteNumber.node.active = false;
                        view.SpriteNumber.joltEnabled = false;
                    }
                }
            }
        }
    }

    /** Ghi symbolFrames + blurFrames vào từng SymbolView trên mọi reel.
     *  Nếu có creditLabelPrefab, instantiate và inject vào view.creditLabel.
     */
    private _distributeFramesToSymbolViews(): void {
        if (this.symbolFrames.length === 0) {
            // Log removed for performance
            return;
        }
        for (const reel of this.reels) {
            for (let ni = 0; ni < reel.symbolNodes.length; ni++) {
                const node = reel.symbolNodes[ni];
                const view = node.getComponent(SymbolView);
                if (view) {
                    view.symbolFrames = this.symbolFrames;
                    view.blurFrames   = this.blurFrames;
                    // Gán vị trí reel/row để setSymbol() tra cứu stickyCells
                    // Visible nodes: ni=1 (top/row2), ni=2 (mid/row1), ni=3 (bot/row0)
                    // Off-screen:    ni=0 (trên) và ni=4 (dưới) → rowIndex=-1
                    view.reelIndex = reel.reelIndex;
                    view.rowIndex  = (ni >= 1 && ni <= 3) ? (3 - ni) : -1;

                    // Inject SpriteNumber từ prefab (chỉ tạo nếu chưa có)
                    if (this.creditLabelPrefab && !view.SpriteNumber) {
                        const snNode = instantiate(this.creditLabelPrefab);
                        node.addChild(snNode);
                        view.SpriteNumber = snNode.getComponent(SpriteNumber)
                            ?? snNode.getComponentInChildren(SpriteNumber);
                        if (view.SpriteNumber) {
                            view.SpriteNumber.node.active = false;
                            // Tắt jolt — credit label phải tĩnh hoàn toàn
                            view.SpriteNumber.joltEnabled = false;
                        } else {
                            // Log removed for performance
                        }
                    }
                }
            }
        }
    }

    onDestroy(): void {
        this._pendingReelStarts = [];
        this._stopLongSpinCameraZoom(true);
        EventBus.instance.offTarget(this);
    }

    get areAllReelsStopped(): boolean {
        return this._allReelsStopped && this.reels.every((reel) => reel?.isIdle ?? true);
    }

    get areReelsVisuallyIdle(): boolean {
        return this.reels.every((reel) => reel?.isIdle ?? true);
    }

    get debugStateSummary(): string {
        const reelStates = this.reels.map((reel, i) => `R${i}:${reel?.debugState ?? 'null'}`).join(' ');
        return `all=${this._allReelsStopped} visualIdle=${this.areReelsVisuallyIdle} stopped=${this._stoppedCount}/${this.reels.length} stoppedSet=[${Array.from(this._stoppedReelSet).join(',')}] pendingOut=[${Array.from(this._pendingOutOfOrderStops).join(',')}] topUp=${this._isTopUp} free=${this._isFreeSpin} longActive=${this._isLongSpinActive} longBoundary=${this._longSpinBoundary} waiting=[${this._waitingReels.map(r => r.reelIndex).join(',')}] pendingStarts=${this._pendingReelStarts.length} ${reelStates}`;
    }

    /** Chỉ dựng chuỗi debug khi whitelist bật — tránh GC hitch giữa lúc reel quay. */
    private _logSpinState(msg: string): void {
        // TEMP SPIN-HANG debug — bỏ comment khối dưới khi cần trace treo spin
        // if (!Log.isEnabled('spin-hang')) return;
        // Log.e(`${msg} | ${this.debugStateSummary}`);
        void msg;
    }

    tryRecoverReelsStopped(): boolean {
        if (this._isTopUp) return false;
        if (!this.areReelsVisuallyIdle) return false;

        if (!this._allReelsStopped) {
            // Đánh dấu mọi reel IDLE còn thiếu trước khi force emit
            this._recoverMissedIdleStops();
            if (this._allReelsStopped) {
                // recover đã emit REELS_STOPPED
                return true;
            }
            if (this._stoppedCount < this.reels.length) {
                for (let i = 0; i < this.reels.length; i++) {
                    if (!this._stoppedReelSet.has(i)) {
                        this._logSpinState(`[SPIN-HANG][SlotMC] force-count idle reel=${i}`);
                        this._stoppedReelSet.add(i);
                        this._stoppedCount++;
                    }
                }
            }
            this._stoppedCount = this.reels.length;
            this._allReelsStopped = true;
            this._waitingReels = [];
            this._pendingOutOfOrderStops.clear();
            this._stopLongSpinVFX(false);
        }
        this._logSpinState('[SPIN-HANG][SlotMC] recover/resent REELS_STOPPED');
        EventBus.instance.emit(GameEvents.REELS_STOPPED);
        return true;
    }

    canRunPerReelEffects(reelIndex: number): boolean {
        if (this._longSpinBoundary < 0) return true;
        if (reelIndex <= this._longSpinBoundary) return true;
        for (let i = this._longSpinBoundary; i < reelIndex; i++) {
            if (!this._stoppedReelSet.has(i)) return false;
        }
        return true;
    }

    update(): void {
        const len = this._pendingReelStarts.length;
        if (len === 0) return;

        const now = Date.now();
        let writeIdx = 0;

        for (let i = 0; i < len; i++) {
            const pending = this._pendingReelStarts[i];
            if (now >= pending.triggerTime) {
                // ★ Tối ưu: tránh tìm index bằng linear search mỗi lần
                // Dùng reelIndex được lưu sẵn nếu có, hoặc skip log nếu không quan trọng
                pending.reel.startSpin();
            } else {
                // Giữ lại - in-place filter
                this._pendingReelStarts[writeIdx++] = pending;
            }
        }

        // Truncate array
        this._pendingReelStarts.length = writeIdx;
    }

    // ─── SLOT BACKGROUND SPRITE (NORMAL/FREE SPIN) ───

    /**
     * Cập nhật sprite cho slot machine background theo Free Spin mode.
     * Normal Spin: normalSprite
     * Free Spin: freeSpinSprite
     */
    private _updateSlotBackgroundSprite(): void {
        if (!this.slotBackgroundNode) return;

        const spriteComponent = this.slotBackgroundNode.getComponent(Sprite);
        if (!spriteComponent) return;

        const isFeature = this._isFreeSpin || this._isTopUp || this._isPickGame;
        const sprite = isFeature ? this.freeSpinSprite : this.normalSprite;
        if (!sprite) return;

        if (spriteComponent.spriteFrame === sprite || !spriteComponent.spriteFrame) {
            spriteComponent.spriteFrame = sprite;
            setNodeOpacity(this.slotBackgroundNode, 255);
            return;
        }
        this._slotBgFadeTwin = crossfadeSpriteFrame(
            this.slotBackgroundNode,
            this._slotBgFadeTwin,
            sprite,
            this.uiFadeDuration,
        );
    }

    /** FREE_SPIN_START event → cập nhật slot background sprite sang FreeSpin */
    private _onFreeSpinStart(): void {
        this._isFreeSpin = true;
        this._updateSlotBackgroundSprite();
    }

    /** FREE_SPIN_END event → cập nhật slot background sprite về Normal */
    private _onFreeSpinEnd(): void {
        this._isFreeSpin = false;
        this._updateSlotBackgroundSprite();
        // Defer refreshSymbols sang frame tiếp theo để đảm bảo SymbolHighlighter/WaysPayDisplay
        // đã cleanup xong trước khi emit symbol-changed.
        this.scheduleOnce(() => {
            for (const reel of this.reels) {
                if (reel) reel.refreshSymbols();
            }
        }, 0);
    }

    private _onTopUpStart(): void {
        // KHÔNG set _isFreeSpin = true — TopUp dùng normal reel strips để reel không hiện coin symbols.
        // StickyOverlayController hiển thị coin overlay độc lập (layer trên reel).
        // _isTopUp dùng để:
        //   1. Áp dụng freespin speed settings (minSpinDurationFreeSpin, decelDurationFreeSpin)
        //   2. Bỏ qua response.reelIndex khi set strip index → reel dùng normal strips khi dừng
        this._isTopUp = true;
        // Ẩn SlotReel chính (ReelMask) — giữ StickyOverLayparent sibling vẫn hiện
        this._setMainSlotReelsVisible(false);
        this._updateSlotBackgroundSprite();
    }

    private _onTopUpEnd(): void {
        this._isTopUp = false;
        this._setMainSlotReelsVisible(true);
        this._updateSlotBackgroundSprite();
        // Defer refreshSymbols sang frame tiếp theo để đảm bảo SymbolHighlighter/WaysPayDisplay
        // đã cleanup xong trước khi emit symbol-changed.
        this.scheduleOnce(() => {
            for (const reel of this.reels) {
                if (reel) reel.refreshSymbols();
            }
        }, 0);
    }

    /**
     * Ẩn/hiện ReelMask (5 ReelController chính) bằng opacity fade.
     * Không đụng StickyOverLayparent (sibling) — StickyOverlay vẫn hiện.
     */
    private _setMainSlotReelsVisible(visible: boolean): void {
        const mask = this.node.getChildByName('ReelMask');
        const targets: Node[] = [];
        if (mask?.isValid) {
            targets.push(mask);
        } else {
            for (const reel of this.reels) {
                if (reel?.node?.isValid) targets.push(reel.node);
            }
        }
        const dur = this.uiFadeDuration;
        for (const n of targets) {
            if (visible) {
                fadeInNode(n, dur);
            } else {
                // Giữ active trong lúc fade; tắt sau khi mờ xong (tránh hit-test)
                fadeOutNode(n, dur, true);
            }
        }
    }

    private _onPickGameOpen(): void {
        this._isPickGame = true;
        this._wasActiveBeforePickGame = this.node.active;
        this._pendingPickGameHide = true;
        this._updateSlotBackgroundSprite();
        // Không còn TransitionPopup — fade SlotMachine ngay khi Pick mở
        this._hideForPickGameIfPending();
        Log.d('[SlotMachineController] Pick Game open — fade out SlotMachine');
    }

    /**
     * TOPUP_TRANSITION_READY: overlay đã phủ kín → mới ẩn SlotMachine (legacy).
     */
    private _onPickGameTransitionReady(): void {
        if (!this._isPickGame) return;
        this._hideForPickGameIfPending();
    }

    /** Fallback nếu READY bị miss */
    private _onPickGameTransitionDone(): void {
        if (!this._isPickGame) return;
        this._hideForPickGameIfPending();
    }

    /** Fallback khi bỏ qua transition (useTopUpTransition=false) */
    private _onPickGameEntryDone(): void {
        this._hideForPickGameIfPending();
    }

    private _hideForPickGameIfPending(): void {
        if (!this._pendingPickGameHide) return;
        this._pendingPickGameHide = false;
        // Giữ node.active=true để fade nhìn thấy; opacity → 0
        this.node.active = true;
        fadeNodeOpacity(this.node, 0, this.uiFadeDuration, () => {
            // Sau fade: tắt hit-test bằng active=false (đã mờ hết)
            if (this._isPickGame && this.node.isValid) {
                this.node.active = false;
            }
            Log.d('[SlotMachineController] Faded out — Pick Game');
        });
    }

    private _onPickGameClose(): void {
        this._isPickGame = false;
        this._pendingPickGameHide = false;
        if (this._wasActiveBeforePickGame) {
            this.node.active = true;
            setNodeOpacity(this.node, 0);
            fadeNodeOpacity(this.node, 255, this.uiFadeDuration);
            Log.d('[SlotMachineController] Fade in — Pick Game close');
        }
        this._updateSlotBackgroundSprite();
    }

    /** Quick stop — người chơi nhấn Spin lại khi reel đang quay → tất cả reel dừng cùng lúc.
     *  Chỉ hoạt động trong normal spin, không áp dụng cho FreeSpin/TopUp/PickGame. */
    private _onQuickStop(): void {
        this._logSpinState('[SPIN-HANG][SlotMC] QUICK_STOP received');
        if (this._isFreeSpin || this._isTopUp || this._isPickGame) return;

        // 0) Bỏ stagger / long-spin delay trước khi ra lệnh dừng
        for (const reel of this.reels) {
            reel.stopDelay = 0;
            reel.longSpinDelay = 0;
        }

        // 1) Hủy stagger start còn chờ — khởi động ngay mọi reel chưa quay
        if (this._pendingReelStarts.length > 0) {
            const pending = this._pendingReelStarts.splice(0);
            for (const item of pending) {
                item.reel.startSpin();
            }
        }

        // 2) Bỏ long-spin queue / delay — stopAt ngay mọi reel đang chờ đến lượt
        if (this._waitingReels.length > 0) {
            const waiting = this._waitingReels.splice(0);
            for (const item of waiting) {
                const reel = this.reels[item.reelIndex];
                if (!reel || this._stoppedReelSet.has(item.reelIndex)) continue;
                // Quick stop: không dùng longSpin delay
                reel.stopAt(item.centerIndex, false);
            }
        }

        // 3) Tắt long-spin VFX / sequential boundary — không còn anticipation
        this._longSpinBoundary = -1;
        this._longSpinReelSet.clear();
        if (this._isLongSpinActive) {
            // Quick stop: zoom về ngay, không chờ delay
            this._stopLongSpinVFX(false, true);
        }

        // 4) Mọi reel vào quick decel cùng frame
        for (const reel of this.reels) {
            reel.forceQuickStop();
        }
        this._logSpinState('[SPIN-HANG][SlotMC] QUICK_STOP applied');
    }

    /**
     * Resume Normal Spin bị gián đoạn: snap reel về vị trí kết quả cuối,
     * đợi một frame để render xong rồi emit REELS_STOPPED kích hoạt win flow.
     */
    private _onResumeNormalSpin(rands: number[]): void {
        // Log removed for performance
        this.setInitialSymbols(rands);
        this.scheduleOnce(() => {
            EventBus.instance.emit(GameEvents.REELS_STOPPED);
        }, 0.2);
    }

    /**
     * Resume Free Spin: chỉ vẽ lại reel tĩnh từ rands, KHÔNG emit REELS_STOPPED.
     * Tránh trigger win flow của ván trước; auto-spin sẽ bắt đầu ngay sau đó.
     */
    private _onResumeFreeSpinReels(rands: number[]): void {
        // Log removed for performance
        this.setInitialSymbols(rands);
    }

    /**
     * Sau khi Enter thành công và PS được apply, gán symbol đúng từ strip.
     * Dùng center=1 (index 1 của strip sau snap) cho mỗi reel.
     */
    private _onEnterSuccess(): void {
        const data = GameData.instance;
        // FIX: dùng getReelStrips() thay vì trực tiếp data.config.reelStrips
        // để đúng khi isPurchaseReelActive=true (edge case: resume sau khi đã activate)
        const strips = data.getReelStrips(false);
        if (!strips || strips.length < this.reels.length) return;

        // ── Tính startIdx cho mỗi reel ──
        const startIdxs: number[] = [];
        for (let i = 0; i < this.reels.length; i++) {
            const strip = strips[i];
            let idx = 0;
            for (let j = 0; j < strip.length; j++) {
                if (strip[j] >= 0) { idx = j; break; }
            }
            startIdxs.push(idx);
        }

        // ── GoF: pre-populate stickyCells cho Trail Coins tại vị trí init ──
        // Phải làm TRƯỚC setSymbols() để SymbolView.setSymbol() thấy stickyCells ngay.
        //
        // Nguồn chính: rawEnterLastSpinResponse.NoramlSpinLinkReel (server typo — KHÔNG có chữ 'm' ở Normal)
        // Mỗi slot {Type, Win}: Type=1=RED, Type=2=YELLOW, Type=3=GREEN | Win = giá trị tiền tuyệt đối
        // Layout 15 slot = 3 row × 5 reel: index 0-4=row TOP(0), 5-9=row MID(1), 10-14=row BOT(2)
        const rawEnter = data.rawEnterLastSpinResponse;
        const nextStage = rawEnter?.NextStage ?? rawEnter?.nextStage ?? 0;
        // Logs removed for performance
        const linkReel = rawEnter?.NoramlSpinLinkReel ?? rawEnter?.NormalSpinLinkReel
            ?? rawEnter?.TopupReel ?? null;

        if (Array.isArray(linkReel) && linkReel.length > 0) {
            // Ưu tiên 1: Đọc trực tiếp từ NoramlSpinLinkReel / TopupReel (credit đúng từ server)
            data.stickyCells.clear();
            for (let i = 0; i < Math.min(15, linkReel.length); i++) {
                const slot = linkReel[i];
                const type = typeof slot === 'number' ? slot : (slot?.Type ?? slot?.type ?? 0);
                const win  = typeof slot === 'object' && slot !== null ? (slot.Win ?? slot.win ?? 0) : 0;
                if (type === 0) continue;

                const apiRow = Math.floor(i / 5); // 0=top-of-API 1=mid 2=bot
                const reel   = i % 5;
                // NoramlSpinLinkReel: slot 0-4=top row(apiRow=0), 5-9=mid(apiRow=1), 10-14=bot(apiRow=2)
                const row    = apiRow; // row 0=top, 1=mid, 2=bot (client convention)
                let symbolId = SymbolId.STICKY_RED;
                if (type === 2) symbolId = SymbolId.STICKY_YELLOW;
                else if (type === 3) symbolId = SymbolId.STICKY_GREEN;

                const cell: any = { reel, row, symbolId, credit: win };
                data.stickyCells.set(`${reel}-${row}`, cell);
                // Log removed for performance
            }
            // Log removed for performance
        } else if (nextStage > 0) {
            // Ưu tiên 2: Có feature đang dang dở nhưng không có LinkReel data
            // → fallback tính từ rawPsStrips + symbolPayouts
            const rawStrips = data.rawPsStrips;
            const payouts   = data.symbolPayouts;
            const hasPayouts = rawStrips.length > 0 && Object.keys(payouts).length > 0;
            // Log removed for performance
            if (hasPayouts) {
                data.stickyCells.clear();
                for (let i = 0; i < this.reels.length; i++) {
                    const rawStrip = rawStrips[i];
                    if (!rawStrip || rawStrip.length === 0) continue;
                    const len = rawStrip.length;
                    const center = startIdxs[i];
                    for (let offset = -1; offset <= 1; offset++) {
                        const sIdx = ((center + offset) % len + len) % len;
                        const psId = rawStrip[sIdx];
                        const clientId = data.psToClientMap[psId] ?? -1;
                        const isSticky = clientId === SymbolId.STICKY_RED
                            || clientId === SymbolId.STICKY_YELLOW
                            || clientId === SymbolId.STICKY_GREEN;
                        const rate = payouts[psId] ?? 0;
                        if (!isSticky && rate <= 0) continue;
                        const row = offset + 1; // -1→0(top), 0→1(mid), +1→2(bot)
                        const finalId = isSticky ? clientId : (data.psToClientMap[psId] ?? SymbolId.STICKY_RED);
                        const credit = this._toStickyCreditFromRate(rate);
                        const cell: any = { reel: i, row, symbolId: finalId, credit, _rate: rate };
                        data.stickyCells.set(`${i}-${row}`, cell);
                        // Log removed for performance
                    }
                }
            }
        } else {
            // NextStage=0: kết thúc spin bình thường, không có feature — xóa stickyCells
            // Log removed for performance
            data.stickyCells.clear();
        }

        // ── Render reel symbols (stickyCells đã sẵn sàng) ──
        for (let i = 0; i < this.reels.length; i++) {
            this.reels[i].setSymbols(startIdxs[i]);
            // Log removed for performance
        }
    }

    private _toStickyCreditFromRate(rate: number): number {
        if (rate <= 0) return 0;
        return rate < 1 ? rate * 2500 : rate;
    }

    // ─── PHASE 1: BẮT ĐẦU QUAY (ngay khi nhấn Spin, trước khi chờ server) ───

    private _onReelsStartSpin(): void {
        if (this._isTopUp) return; // TopUp mode: SlotMachineController không quay

        // Guard: reel chưa dừng hẳn từ spin trước → defer 0.2s rồi thử lại
        if (!this.areAllReelsStopped) {
            this._logSpinState('[SPIN-HANG][SlotMC] REELS_START_SPIN deferred');
            this.scheduleOnce(() => this._onReelsStartSpin(), 0.2);
            return;
        }
        this._allReelsStopped = false;

        this._stoppedCount = 0;
        this._stoppedReelSet.clear();
        this._pendingOutOfOrderStops.clear();
        this._longSpinBoundary = -1;
        this._isLongSpinActive = false;
        this._longSpinReelSet.clear();
        this._pendingReelStarts = [];
        this._waitingReels = [];
        this._hintPositions = [];
        this._stopHintBounce();
        this._resetVFX();
        this._logSpinState('[SPIN-HANG][SlotMC] REELS_START_SPIN accepted');

        // Áp dụng speed mode trước khi spin
        this._applySpeedMode();

        const mode = AutoSpinManager.instance.speedMode;
        const noStagger = mode === SpeedMode.TURBO;
        for (let i = 0; i < this.reels.length; i++) {
            const reel = this.reels[i];
            const delay = noStagger ? 0 : i * this.startStaggerDelay;
            this._scheduleReelStart(reel, delay);
        }
    }

    /**
     * Apply speed settings from the Inspector-configurable SpeedModeSettings objects
     * (normalModeSettings / quickModeSettings / turboModeSettings) to each ReelController.
     * Edit those objects in the Editor instead of touching this code.
     * 
     * CONSTRAINT: QUICK và TURBO mode phải có noStopDelay = true (tất cả reel dừng cùng lúc)
     */
    private _applySpeedMode(): void {
        const mode = AutoSpinManager.instance.speedMode;
        // TopUp dùng freespin speed settings (minSpinDurationFreeSpin, decelDurationFreeSpin)
        const fs   = this._isFreeSpin || this._isTopUp;

        let cfg: SpeedModeSettings;
        switch (mode) {
            case SpeedMode.QUICK:  cfg = this.quickModeSettings;  break;
            case SpeedMode.TURBO:  cfg = this.turboModeSettings;  break;
            default:               cfg = this.normalModeSettings; break;
        }

        // Validate constraint: TURBO phải có noStopDelay = true
        if (mode === SpeedMode.TURBO && !cfg.noStopDelay) {
            // Log removed for performance
            cfg.noStopDelay = true; // Force it
        }

        for (let i = 0; i < this.reels.length; i++) {
            const reel = this.reels[i];
            reel.spinSpeed        = cfg.spinSpeed;
            reel.minSpinDuration  = fs ? cfg.minSpinDurationFreeSpin : cfg.minSpinDuration;
            reel.decelDuration    = fs ? cfg.decelDurationFreeSpin   : cfg.decelDuration;
            reel.stopDelay        = cfg.noStopDelay ? 0 : i * this.stopInterval;
            reel.skipLaunchBounce       = cfg.skipLaunchBounce;
            reel.longSpinDelay            = cfg.longSpinDelay;
            reel.longSpinSpeed            = cfg.longSpinSpeed;
            reel.launchBounceHeightRatio  = this.launchBounceHeightRatio;
            reel.launchBounceUpDuration   = this.launchBounceUpDuration;
            reel.launchBounceDownDuration = this.launchBounceDownDuration;
            reel.stopBounceOvershootRatio = this.stopBounceOvershootRatio;
            reel.stopBounceSettleDuration = this.stopBounceSettleDuration;
        }
    }
    private _scheduleReelStart(reel: ReelController, delay: number): void {
        // QUAN TRỌNG: LUÔN queue qua _pendingReelStarts, KHÔNG gọi startSpin() đồng bộ dù delay=0.
        //
        // Lý do: khi REELS_START_SPIN emit, SlotMachineController và SymbolHighlighter đều lắng nghe.
        // Nếu SlotMachineController xử lý trước → startSpin() tạo launch-bounce tween trên symbolNodes.
        // SymbolHighlighter xử lý sau → _resetHighlights() → Tween.stopAllByTarget(zoomedNode) →
        // kill launch tween của Reel 0 → Reel 0 kẹt ở LAUNCHING mãi mãi → không bao giờ decel →
        // REELS_STOPPED không bao giờ emit → game đơ.
        //
        // Giải pháp: defer startSpin() sang frame tiếp theo (update loop) để SymbolHighlighter
        // đã dọn sạch zoom tweens trước khi launch tween được tạo.
        this._pendingReelStarts.push({
            reel,
            triggerTime: Date.now() + delay * 1000,
        });
    }

    // ─── PHASE 2: NHẬN KẾT QUẢ → RA LỆNH DỪNG ───

    private _onSpinResponse(response: SpinResponse): void {
        if (this._isTopUp) return; // TopUp mode: SlotMachineController không dừng reels

        this._logSpinState(`[SPIN-HANG][SlotMC] SPIN_RESPONSE received | rands=${response.rands?.join(',')} reelIndex=${response.reelIndex}`);

        // ★ Progressive Long Spin: tính toán reel nào cần long spin dựa trên tổng red SYMBOLS
        if (this._isLongSpinActive) {
            // Force Feature Entry: chỉ đếm existingCells — fillCells chưa nằm trên grid
            const stickyCells = (response.isForcedFeatureEntry && response.forceFeatureEntry)
                ? (response.forceFeatureEntry.existingCells ?? [])
                : (response.stickyCells ?? []);
            const redCountPerReel: number[] = new Array(this.reels.length).fill(0);
            for (const cell of stickyCells) {
                if (cell.symbolId === SymbolId.STICKY_RED && cell.reel >= 0 && cell.reel < this.reels.length) {
                    redCountPerReel[cell.reel]++;
                }
            }

            this._longSpinReelSet.clear();
            for (let ri = 2; ri < this.reels.length; ri++) {
                // Đếm TỔNG SỐ red symbols trên các reel [0..ri-1]
                let totalRedsBefore = 0;
                for (let r = 0; r < ri; r++) {
                    totalRedsBefore += redCountPerReel[r];
                }
                if (totalRedsBefore >= 3) {
                    this._longSpinReelSet.add(ri);
                }
            }
            // Log removed for performance
        }

        // ─── Sequential longspin: reels sau boundary tiếp tục quay, stopAt() trì hoãn ──
        // Các reel có index > boundary VẪN QUAY BÌNH THƯỜNG (loop animation).
        // stopAt() của chúng chỉ được gọi khi reel ngay trước dừng xong.
        const longSpinBoundary = (this._isLongSpinActive && this._longSpinReelSet.size > 0)
            ? Math.min(...Array.from(this._longSpinReelSet))
            : -1;
        this._longSpinBoundary = longSpinBoundary;
        this._logSpinState(`[SPIN-HANG][SlotMC] longspin boundary resolved | boundary=${longSpinBoundary} longSet=[${Array.from(this._longSpinReelSet).join(',')}]`);


        for (let i = 0; i < this.reels.length; i++) {
            const reel = this.reels[i];
            const centerIndex = response.rands[i];
            const isLong = this._longSpinReelSet.has(i);
            const reelIdx = i; // capture for closure

            // TopUp: undefined → normal strips (coin do StickyOverlay).
            // Free Spin: dùng tier ReelIndex 2–6; legacy ReelIndex=1 → selectedFreeSpinReelIndex.
            let stripIdx: number | undefined = response.reelIndex;
            if (this._isTopUp) {
                stripIdx = undefined;
            } else if (this._isFreeSpin) {
                if (isFreeSpinTierReelIndex(response.reelIndex)) {
                    stripIdx = response.reelIndex;
                } else {
                    stripIdx = GameData.instance.selectedFreeSpinReelIndex ?? response.reelIndex;
                }
            }
            reel.setResultStripIndex(stripIdx);

            // Reel long spin: kéo dài thời gian giảm tốc để tạo cảm giác hồi hộp
            if (isLong) {
                reel.decelDuration = this.longSpinDecelDuration;
                // Reel cuối: anticipation lâu hơn longspin thường một chút
                if (i === this.reels.length - 1) {
                    reel.longSpinDelay += this.longSpinLastReelExtraDelay;
                }
            }

            reel.onSnapComplete = () => {
                this._onReelSnapped(reelIdx);
            };

            // onSymbolsSettled: tất cả symbolNodes đã có đúng symId (sau _finishDecel).
            // Dùng để emit LONG_SPIN_HINT_SHOW — tránh trường hợp onSnapComplete bắn sớm
            // (spineTriggerDistance) khiến node visual-bottom chưa có symbol đúng.
            reel.onSymbolsSettled = () => {
                this._onReelSymbolsSettled(reelIdx);
            };

            reel.onBounceStart = () => {
                EventBus.instance.emit(GameEvents.REEL_SNAPPED, reelIdx);
            };

            reel.onDecelStart = (decelDuration: number) => {
                if (isLong) EventBus.instance.emit(GameEvents.REEL_DECEL_START, { reelIndex: reelIdx, decelDuration });
            };

            reel.onStopComplete = () => {
                this._onReelStopped(reelIdx);
            };

            if (longSpinBoundary >= 0 && i > longSpinBoundary) {
                // Reel tiếp tục quay loop — lưu kết quả vào queue.
                // stopAt() sẽ được gọi khi reel ngay trước (i-1) dừng xong.
                this._waitingReels.push({ reelIndex: i, centerIndex, isLong });
                // Log removed for performance
            } else {
                // Log removed for performance
                reel.stopAt(centerIndex, isLong);
            }
        }

    }

    /**
     * Gọi ngay khi reel snap về rest (trước bounce).
     * KHÔNG còn emit LONG_SPIN_HINT_SHOW ở đây — đã chuyển sang _onReelSymbolsSettled
     * để đảm bảo tất cả symbolNodes đã có đúng symId trước khi SymbolHighlighter tìm kiếm.
     */
    private _onReelSnapped(_reelIndex: number): void {
        // Nothing to do here — REEL_SNAPPED emitted from onBounceStart
    }

    /**
     * Gọi từ onSymbolsSettled — SAU _finishDecel đã gán đúng symbol.
     * LONG_SPIN_HINT_SHOW cố ý KHÔNG emit ở đây: highlight/spine async có thể
     * Tween.stopAllByTarget symbolNode giữa lúc stop-bounce → mất onStopComplete → treo spin.
     * Hint được emit trong _processReelStopped (sau bounce / fallback).
     */
    private _onReelSymbolsSettled(_reelIndex: number): void {
        // no-op — hint moved to _processReelStopped
    }

    private _canAcceptLongSpinStop(reelIndex: number): boolean {
        if (this._longSpinBoundary < 0) return true;
        if (reelIndex <= this._longSpinBoundary) return true;
        return this._stoppedReelSet.has(reelIndex - 1);
    }

    private _flushPendingLongSpinStops(): void {
        let flushed = true;
        while (flushed) {
            flushed = false;
            const pending = Array.from(this._pendingOutOfOrderStops).sort((a, b) => a - b);
            for (const reelIndex of pending) {
                if (!this._canAcceptLongSpinStop(reelIndex)) continue;
                this._pendingOutOfOrderStops.delete(reelIndex);
                this._logSpinState(`[SPIN-HANG][SlotMC] flush pending out-of-order REEL_STOPPED reel=${reelIndex}`);
                this._processReelStopped(reelIndex);
                flushed = true;
                break;
            }
        }
    }

    private _onReelStopped(reelIndex: number): void {
        if (this._stoppedReelSet.has(reelIndex)) {
            this._logSpinState(`[SPIN-HANG][SlotMC] duplicate REEL_STOPPED ignored reel=${reelIndex}`);
            return;
        }
        if (!this._canAcceptLongSpinStop(reelIndex)) {
            this._pendingOutOfOrderStops.add(reelIndex);
            this._logSpinState(`[SPIN-HANG][SlotMC] out-of-order REEL_STOPPED held reel=${reelIndex}`);
            return;
        }
        this._processReelStopped(reelIndex);
    }

    /**
     * Reel đã IDLE (stop-bounce xong) nhưng chưa vào stoppedSet (onStopComplete bị mất vì tween bị kill).
     * Gọi sau mỗi stop / khi recover để không kẹt stopped=4/5.
     * Không recover lúc SETTLING — tránh bắn trail khi symbol còn overshoot.
     */
    private _recoverMissedIdleStops(): void {
        for (let i = 0; i < this.reels.length; i++) {
            if (this._stoppedReelSet.has(i)) continue;
            if (this._pendingOutOfOrderStops.has(i)) continue;
            if (this._waitingReels.some((w) => w.reelIndex === i)) continue;
            const reel = this.reels[i];
            // isIdle chỉ true sau stop-bounce (SETTLING không recover)
            if (!reel?.isIdle) continue;
            this._logSpinState(`[SPIN-HANG][SlotMC] recover missed IDLE stop reel=${i}`);
            this._processReelStopped(i);
        }
    }

    private _processReelStopped(reelIndex: number): void {
        if (this._stoppedReelSet.has(reelIndex)) return;
        this._stoppedReelSet.add(reelIndex);
        this._stoppedCount++;
        this._logSpinState(`[SPIN-HANG][SlotMC] REEL_STOPPED reel=${reelIndex}`);
        EventBus.instance.emit(GameEvents.REEL_STOPPED, reelIndex);

        // Long-spin hint SAU khi stop bounce xong — an toàn với spine/highlight
        if (this._isLongSpinActive) {
            const hintPos = this._hintPositions.find(p => p.reelIndex === reelIndex);
            if (hintPos) {
                EventBus.instance.emit(GameEvents.LONG_SPIN_HINT_SHOW, [hintPos]);
            }
        }

        // ★ Hiện credit label ngay khi reel dừng (per-reel) — chỉ cho STICKY_RED
        this._showCreditsForReel(reelIndex);

        // ★ Sequential longspin: khi reel dừng, báo cho reel đang-quay-chờ tiếp theo dừng.
        // Reel trong queue đang spin loop — chỉ cần gọi stopAt() khi đến lượt.
        // Nếu reel vừa dừng là longspin reel → thêm delay trước khi gọi stopAt() cho reel tiếp.
        if (this._waitingReels.length > 0) {
            const next = this._waitingReels[0];
            if (reelIndex === next.reelIndex - 1) {
                this._waitingReels.shift();
                const delay = this._longSpinReelSet.has(reelIndex) ? this.longSpinNextReelDelay : 0;
                // Log removed for performance
                if (this._pendingOutOfOrderStops.has(next.reelIndex)) {
                    this._logSpinState(`[SPIN-HANG][SlotMC] skip stopAt for pending out-of-order reel=${next.reelIndex}`);
                } else if (delay > 0) {
                    this.scheduleOnce(() => {
                        if (this._pendingOutOfOrderStops.has(next.reelIndex) || this._stoppedReelSet.has(next.reelIndex)) {
                            this._logSpinState(`[SPIN-HANG][SlotMC] scheduled stopAt skipped for already pending/stopped reel=${next.reelIndex}`);
                            return;
                        }
                        this.reels[next.reelIndex].stopAt(next.centerIndex, next.isLong);
                    }, delay);
                } else {
                    this.reels[next.reelIndex].stopAt(next.centerIndex, next.isLong);
                }
            }
        }

        // ★ Progressive Long Spin VFX:
        // Nếu reel hiện tại là longspin reel → VFX đang hiển thị trên nó → tắt VFX
        const nextReelIdx = reelIndex + 1;
        if (this._longSpinReelSet.has(reelIndex) && this.longSpinVFXNode?.active) {
            // keepActive = true chỉ khi reel tiếp theo cũng là longspin (sẽ bật VFX ngay sau)
            const keepActive = nextReelIdx < this.reels.length && this._longSpinReelSet.has(nextReelIdx);
            this._stopLongSpinVFX(keepActive);
        }

        // Nếu reel tiếp theo là longspin reel → bật VFX trên reel tiếp theo
        if (nextReelIdx < this.reels.length && this._longSpinReelSet.has(nextReelIdx) && this._isLongSpinActive) {
            this._tryStartLongSpinVFX(nextReelIdx);
        }

        // Safety: nếu reel cuối dừng mà VFX vẫn active → tắt hoàn toàn
        const lastReelIdx = this.reels.length - 1;
        if (reelIndex === lastReelIdx && this._isLongSpinActive) {
            this._stopLongSpinVFX(false);
        }

        this._flushPendingLongSpinStops();
        this._recoverMissedIdleStops();

        if (this._stoppedCount === this.reels.length && !this._allReelsStopped) {
            this._allReelsStopped = true;
            this._logSpinState('[SPIN-HANG][SlotMC] EMIT REELS_STOPPED');
            EventBus.instance.emit(GameEvents.REELS_STOPPED);
        }
    }

    /**
     * #1 Sticky Red Credit Display (per-reel):
     * Khi một reel dừng, tìm các ô STICKY_RED trên reel đó trong stickyCells
     * và gọi showCredit() NGAY LẬP TỨC — không chờ tất cả reel dừng.
     *
     * CHỈ hiện credit trên symbol thực sự là STICKY_RED (kiểm tra symbolId trên SymbolView).
     *
     * Mapping GameData row → ReelController symbolNode index:
     *   row 0 → symbolNodes[3] (visual Bot)
     *   row 1 → symbolNodes[2] (visual Mid)
     *   row 2 → symbolNodes[1] (visual Top)
     * Formula: nodeIndex = 3 - row
     */
    private _showCreditsForReel(reelIndex: number): void {
        // TopUp mode: credit label chỉ hiện trên StickyOverlay, không hiện trên background reel
        if (GameData.instance.currentMode === 'respin' || GameData.instance.currentMode === 'matsuri') return;
        const cells = GameData.instance.stickyCells;
        if (cells.size === 0) return;

        const reel = this.reels[reelIndex];
        if (!reel) return;

        let hasNewRed = false;
        for (const [key, cell] of cells) {
            if (cell.reel !== reelIndex) continue;
            // ★ Hiện credit cho STICKY_RED, STICKY_YELLOW và STICKY_GREEN
            const isStickyCoin = cell.symbolId === SymbolId.STICKY_RED
                || cell.symbolId === SymbolId.STICKY_YELLOW
                || cell.symbolId === SymbolId.STICKY_GREEN;
            if (!isStickyCoin) continue;

            const nodeIndex = 3 - cell.row;
            const node = reel.symbolNodes[nodeIndex];
            if (!node) continue;

            const view = node.getComponent(SymbolView);
            if (!view) continue;

            // Double-check: symbol visual hiện tại PHẢI là cùng loại sticky coin
            if (view.symbolId !== cell.symbolId) continue;

            view.showCredit(cell.credit);
            if (cell.symbolId === SymbolId.STICKY_RED) hasNewRed = true;
        }

        // Emit tổng Red credit hiện tại (running total) cho EachWin display
        if (hasNewRed) {
            let totalRedCredit = 0;
            let redCount = 0;
            for (const [, c] of cells) {
                if (c.symbolId === SymbolId.STICKY_RED) {
                    totalRedCredit += c.credit;
                    redCount++;
                }
            }
            EventBus.instance.emit(GameEvents.RED_CREDIT_UPDATED, { totalRedCredit, redCount, reelIndex });
        }
    }

    /**
     * Khi mức cược thay đổi: cập nhật lại credit trong stickyCells và refresh label trên reel.
     * Credit = _rate × newTotalBet.
     */
    private _onBetChanged(): void {
        const data = GameData.instance;
        const cells = data.stickyCells;
        if (cells.size === 0) return;

        // Recalculate credit dựa trên _rate đã lưu sẵn
        for (const [, cell] of cells) {
            if (cell.symbolId !== SymbolId.STICKY_RED) continue;
            if ((cell as any)._rate != null) {
                cell.credit = this._toStickyCreditFromRate((cell as any)._rate);
            }
        }

        // Refresh visible credit labels trên mọi reel
        for (let i = 0; i < this.reels.length; i++) {
            this._showCreditsForReel(i);
        }
    }

    // ─── LONG SPIN VFX ────────────────────────────────────────────────────────

    private _onLongSpin(): void {
        if (this._isTopUp) return; // TopUp mode: không cho phép longSpin
        if (!this.isLongSpin) {
            // Log removed for performance
            return;
        }
        this._isLongSpinActive = true;
        // Prefetch prefab sớm — VFX chỉ show khi reel trước long-spin dừng
        LongSpinVFXLoader.preload();
        void this._ensureLongSpinVFX();
    }

    /** Lazy-load fxLongSpin dưới SlotMachine nếu chưa có. */
    private _ensureLongSpinVFX(): Promise<Node | null> {
        if (this.longSpinVFXNode?.isValid) {
            return Promise.resolve(this.longSpinVFXNode);
        }
        return LongSpinVFXLoader.ensure(this.node).then((node) => {
            if (!node) return null;
            this.longSpinVFXNode = node;
            this._vfxSprite = node.getComponent(Sprite);
            return node;
        });
    }

    /**
     * Gọi khi reel trước long-spin dừng — ensure VFX (lazy) rồi bật + emit audio.
     * @param reelIndex reel sẽ nhận VFX (move trước khi active)
     */
    private _tryStartLongSpinVFX(reelIndex?: number): void {
        if (!this._isLongSpinActive) return;
        if (this._stoppedCount >= this.reels.length) return;

        void this._ensureLongSpinVFX().then((node) => {
            if (!node || !this._isLongSpinActive) return;
            if (this._stoppedCount >= this.reels.length) return;

            if (reelIndex != null) {
                this._moveVFXToReel(reelIndex);
            }

            node.active = true;
            this._vfxFrameIdx = 0;
            this._startVFXLoop();
            EventBus.instance.emit(GameEvents.LONG_SPIN_VFX_START);

            // Zoom khi Long Spin tới reel cuối (anticipation cột cuối)
            const lastIdx = this.reels.length - 1;
            if (reelIndex === lastIdx) {
                this._startLongSpinCameraZoom(lastIdx);
            }
        });
    }

    /** Bắt đầu loop sprite frame cho VFX */
    private _startVFXLoop(): void {
        this._stopVFXLoop();
        if (this.vfxFrames.length === 0) return;

        this._vfxCb = () => {
            if (!this.longSpinVFXNode?.active) {
                this._stopVFXLoop();
                return;
            }
            if (this._vfxSprite && this.vfxFrames.length > 0) {
                this._vfxSprite.spriteFrame = this.vfxFrames[this._vfxFrameIdx % this.vfxFrames.length];
                this._vfxFrameIdx++;
            }
        };
        this.schedule(this._vfxCb, 1 / this.vfxFPS);
    }

    /** Dừng VFX sprite loop */
    private _stopVFXLoop(): void {
        if (this._vfxCb) {
            this.unschedule(this._vfxCb);
            this._vfxCb = null;
        }
    }

    /**
     * Tắt VFX khi longspin reel dừng.
     * @param keepActive true = còn longspin reel tiếp theo (không reset _isLongSpinActive)
     * @param instantZoom true = Zoom Out ngay (quick stop / reset), false = delay rồi mới Zoom Out
     */
    private _stopLongSpinVFX(keepActive: boolean = false, instantZoom: boolean = false): void {
        const wasActive = this._isLongSpinActive && this.longSpinVFXNode?.active;
        if (!keepActive) {
            this._isLongSpinActive = false;
            // Zoom Out async — LONG_SPIN_ZOOM_DONE chỉ emit khi về scale gốc
            if (this._isZoomActive) {
                this._stopLongSpinCameraZoom(instantZoom);
            } else {
                EventBus.instance.emit(GameEvents.LONG_SPIN_ZOOM_DONE);
            }
        }
        this._stopVFXLoop();
        this._stopHintBounce();
        if (this.longSpinVFXNode) {
            this.longSpinVFXNode.active = false;
        }
        // Chỉ emit thud nếu VFX đã bật (long spin thật sự) VÀ thực sự kết thúc (không chuyển sang reel khác)
        if (wasActive && !keepActive) {
            EventBus.instance.emit(GameEvents.LONG_SPIN_VFX_END);
        }
    }

    /** Di chuyển VFX node đến vị trí của reel target */
    private _moveVFXToReel(reelIndex: number): void {
        if (!this.longSpinVFXNode) return;
        const targetReel = this.reels[reelIndex];
        if (!targetReel) return;

        const vfxParent = this.longSpinVFXNode.parent;
        if (!vfxParent) return;

        // Chuyển world X của reel sang local space của VFX parent
        const reelWorldPos = targetReel.node.worldPosition;
        const localPos = new Vec3();
        vfxParent.inverseTransformPoint(localPos, reelWorldPos);

        const pos = this.longSpinVFXNode.position.clone();
        pos.x = localPos.x;
        this.longSpinVFXNode.setPosition(pos);
    }

    /** Reset hoàn toàn khi spin mới bắt đầu */
    private _resetVFX(): void {
        this._stopVFXLoop();
        this._stopHintBounce();
        this._stopLongSpinCameraZoom(true);
        if (this.longSpinVFXNode) this.longSpinVFXNode.active = false;
    }

    // ─── LONG SPIN ZOOM (Camera) ──────────────────────────────────────────────

    private static readonly PARTICLE_3D_CAMERA_NAME = 'Particle3DCamera';

    /** Resolve UI Camera + Canvas (một lần, cache). */
    private _resolveZoomCamera(): Camera | null {
        if (this._zoomCamera?.isValid) return this._zoomCamera;

        const scene = this.node.scene;
        if (!scene) return null;

        const canvas = scene.getComponentInChildren(Canvas);
        this._zoomCanvas = canvas?.isValid ? canvas : null;

        const cam = this._zoomCanvas?.cameraComponent
            ?? scene.getComponentsInChildren(Camera).find((c) =>
                c.enabled
                && c.node.name !== SlotMachineController.PARTICLE_3D_CAMERA_NAME
            )
            ?? null;

        this._zoomCamera = cam?.isValid ? cam : null;
        return this._zoomCamera;
    }

    /** Particle3DCamera theo ortho/pos UI Camera (WildTrail lateUpdate cũng sync). */
    private _syncParticle3DCameraFromZoom(): void {
        const source = this._zoomCamera;
        if (!source?.isValid) return;

        if (!this._particle3DCamera?.isValid) {
            this._particle3DCamera = this.node.scene?.getComponentsInChildren(Camera)
                .find((c) => c.node.name === SlotMachineController.PARTICLE_3D_CAMERA_NAME)
                ?? null;
        }
        const trail = this._particle3DCamera;
        if (!trail?.isValid) return;

        trail.orthoHeight = source.orthoHeight;
        trail.node.setWorldPosition(source.node.worldPosition);
    }

    /**
     * Zoom In bằng Camera: giảm orthoHeight + pan về reel cuối.
     * Tắt alignCanvasWithScreen tạm thời — nếu không, Canvas sẽ nuốt thay đổi orthoHeight.
     */
    private _startLongSpinCameraZoom(reelIndex: number): void {
        if (!this.enableLongSpinCameraZoom) return;
        if (this.longSpinZoomScale <= 1.001) return;

        const cam = this._resolveZoomCamera();
        if (!cam) {
            Log.w('[SlotMC] LongSpin Camera Zoom skipped — no UI Camera');
            return;
        }

        const s = this.longSpinZoomScale;
        const dur = Math.max(0.05, this.longSpinZoomInDuration);

        // Baseline chỉ capture lần đầu (tránh cộng dồn nếu gọi lại giữa chừng)
        if (!this._isZoomActive) {
            this._zoomBaseOrtho = cam.orthoHeight;
            this._zoomBaseCamPos.set(cam.node.position);
            this._zoomBaseAlign = this._zoomCanvas?.alignCanvasWithScreen ?? true;
        }

        if (this._zoomCanvas) {
            this._zoomCanvas.alignCanvasWithScreen = false;
        }

        this._zoomEndOrtho = this._zoomBaseOrtho / s;

        // Pan camera về phía reel → reel vào giữa màn (trái / lên)
        this._zoomEndCamPos.set(this._zoomBaseCamPos);
        const reel = this.reels[reelIndex];
        if (reel) {
            const reelWorld = reel.node.worldPosition;
            const slotWorld = this.node.worldPosition;
            const dirX = reelWorld.x >= slotWorld.x ? 1 : -1;
            this._zoomEndCamPos.x = this._zoomBaseCamPos.x + dirX * Math.abs(this.longSpinZoomPanX);
            this._zoomEndCamPos.y = this._zoomBaseCamPos.y - this.longSpinZoomPanY;
        } else {
            this._zoomEndCamPos.y = this._zoomBaseCamPos.y - this.longSpinZoomPanY;
        }

        this._cancelZoomOutDelay();
        this._stopLongSpinZoomDrivers();
        this._isZoomActive = true;
        this._zoomProgress.t = 0;

        this._applyLongSpinZoomTransform();
        this._startLongSpinZoomShake();

        Tween.stopAllByTarget(this._zoomProgress);
        tween(this._zoomProgress)
            .to(dur, { t: 1 }, {
                easing: 'cubicOut',
                onUpdate: () => this._applyLongSpinZoomTransform(),
            })
            .start();

        Log.d(`[SlotMC] LongSpin Camera Zoom In scale=${s} ortho=${this._zoomBaseOrtho.toFixed(1)}→${this._zoomEndOrtho.toFixed(1)} pan=(${this.longSpinZoomPanX},${this.longSpinZoomPanY}) dur=${dur}`);
    }

    /** Áp orthoHeight + camera pos theo tiến độ zoom + shake. */
    private _applyLongSpinZoomTransform(): void {
        const cam = this._zoomCamera;
        if (!cam?.isValid) return;

        const t = this._zoomProgress.t;
        cam.orthoHeight = this._zoomBaseOrtho + (this._zoomEndOrtho - this._zoomBaseOrtho) * t;

        const ox = this._zoomShakeOffset.x;
        const oy = this._zoomShakeOffset.y;
        cam.node.setPosition(
            this._zoomBaseCamPos.x + (this._zoomEndCamPos.x - this._zoomBaseCamPos.x) * t + ox,
            this._zoomBaseCamPos.y + (this._zoomEndCamPos.y - this._zoomBaseCamPos.y) * t + oy,
            this._zoomBaseCamPos.z,
        );
        this._syncParticle3DCameraFromZoom();
    }

    /** Rung nhẹ camera ngay khi bắt đầu zoom. */
    private _startLongSpinZoomShake(): void {
        if (!this.enableLongSpinZoomShake) return;
        if (!this._isZoomActive || !this._zoomCamera?.isValid) return;
        if (this.longSpinZoomShakeAmplitude <= 0) return;

        this._isZoomShaking = true;
        this._zoomShakeOffset.x = 0;
        this._zoomShakeOffset.y = 0;
        Log.d(`[SlotMC] LongSpin Camera Zoom Shake start amp=${this.longSpinZoomShakeAmplitude}`);
        this._runLongSpinZoomShakeCycle();
    }

    private _runLongSpinZoomShakeCycle(): void {
        if (!this._isZoomShaking || !this._isZoomActive) return;

        const a = this.longSpinZoomShakeAmplitude;
        const step = Math.max(0.03, this.longSpinZoomShakeStep);
        const apply = () => this._applyLongSpinZoomTransform();

        Tween.stopAllByTarget(this._zoomShakeOffset);
        tween(this._zoomShakeOffset)
            .to(step, { x: a, y: -a * 0.45 }, { onUpdate: apply })
            .to(step, { x: -a * 0.85, y: a * 0.35 }, { onUpdate: apply })
            .to(step, { x: 0, y: 0 }, { onUpdate: apply })
            .call(() => this._runLongSpinZoomShakeCycle())
            .start();
    }

    private _stopLongSpinZoomDrivers(): void {
        this._isZoomShaking = false;
        Tween.stopAllByTarget(this._zoomShakeOffset);
        Tween.stopAllByTarget(this._zoomProgress);
        this._zoomShakeOffset.x = 0;
        this._zoomShakeOffset.y = 0;
    }

    private _cancelZoomOutDelay(): void {
        if (!this._zoomOutDelayCb) return;
        this.unschedule(this._zoomOutDelayCb);
        this._zoomOutDelayCb = null;
    }

    /** Khôi phục Canvas.alignCanvasWithScreen sau khi camera về baseline. */
    private _restoreZoomCanvasAlign(): void {
        if (this._zoomCanvas?.isValid) {
            this._zoomCanvas.alignCanvasWithScreen = this._zoomBaseAlign;
        }
    }

    /**
     * Zoom Out / snap camera về baseline.
     * @param instant true = cắt ngay (spin mới / quick stop), false = delay rồi tween về
     */
    private _stopLongSpinCameraZoom(instant: boolean = false): void {
        this._cancelZoomOutDelay();
        if (!this._isZoomActive) return;

        this._stopLongSpinZoomDrivers();
        this._applyLongSpinZoomTransform();

        if (!instant && this.longSpinZoomOutDelay > 0) {
            Log.d(`[SlotMC] LongSpin Camera Zoom Out delay=${this.longSpinZoomOutDelay}s`);
            this._zoomOutDelayCb = () => {
                this._zoomOutDelayCb = null;
                this._performLongSpinZoomOut(false);
            };
            this.scheduleOnce(this._zoomOutDelayCb, this.longSpinZoomOutDelay);
            return;
        }

        this._performLongSpinZoomOut(instant);
    }

    /** Thực hiện Zoom Out / snap camera (sau delay hoặc instant). */
    private _performLongSpinZoomOut(instant: boolean): void {
        if (!this._isZoomActive) return;

        const finishAll = () => {
            this._restoreZoomCanvasAlign();
            this._syncParticle3DCameraFromZoom();
            this._isZoomActive = false;
            EventBus.instance.emit(GameEvents.LONG_SPIN_ZOOM_DONE);
        };

        const cam = this._zoomCamera;
        if (!cam?.isValid) {
            finishAll();
            return;
        }

        // Đảo hướng tween: từ trạng thái hiện tại → baseline (t:1 → 0)
        // Capture current as "end", baseline as target via progress.
        const curOrtho = cam.orthoHeight;
        const curPos = cam.node.position.clone();
        this._zoomEndOrtho = curOrtho;
        this._zoomEndCamPos.set(curPos);
        // _zoomBaseOrtho / _zoomBaseCamPos đã là baseline
        this._zoomProgress.t = 1;

        if (instant) {
            this._zoomProgress.t = 0;
            this._applyLongSpinZoomTransform();
            finishAll();
            return;
        }

        const dur = Math.max(0.05, this.longSpinZoomOutDuration);
        Log.d(`[SlotMC] LongSpin Camera Zoom Out dur=${dur}`);

        Tween.stopAllByTarget(this._zoomProgress);
        tween(this._zoomProgress)
            .to(dur, { t: 0 }, {
                easing: 'sineIn',
                onUpdate: () => this._applyLongSpinZoomTransform(),
            })
            .call(() => finishAll())
            .start();
    }

    // ─── LONG SPIN SYMBOL BOUNCE HINT ─────────────────────────────────────────

    /**
     * Nhận payload từ GameManager: danh sách {reelIndex, rowIndex} cần bounce.
     * Lưu lại — sẽ bắt đầu bounce khi _tryStartLongSpinVFX() được gọi (cột 2 dừng).
     */
    private _onLongSpinHint(positions: { reelIndex: number; rowIndex: number }[]): void {
        this._hintPositions = positions;
    }

    /**
     * Thông báo cho SymbolHighlighter bắt đầu spine effect trên các hint symbols.
     * Không còn dùng — hint được emit per-reel trong _onReelStopped.
     */
    private _startHintBounce(): void {
        this._hintBounceCb = () => {};
    }

    private _stopHintBounce(): void {
        this._hintBounceCb = null;
    }

    /**
     * Set hiển thị tĩnh (dùng cho init).
     */
    setInitialSymbols(centerIndices: number[]): void {
        for (let i = 0; i < this.reels.length && i < centerIndices.length; i++) {
            this.reels[i].setSymbols(centerIndices[i]);
        }
    }
}
