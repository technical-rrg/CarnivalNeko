/**
 * CarnivalTrailController — Trail Normal → flip màu → bay vào đúng Pot (Blue/Red/Green).
 *
 * FLOW:
 *   1. GameManager emit CARNIVAL_TRAIL_START { trails, potLevels }
 *   2. Mỗi reel stop có Trail → CARNIVAL_TRAIL_ONE (hoặc batch sau REELS_STOPPED)
 *   3. Flip TRAIL_NORMAL → TRAIL_BLUE/RED/GREEN bằng Spine Flip_41/42/43
 *      (không tween scale symbolNode — setSymbol() gọi Tween.stopAllByTarget và sẽ cắt chuỗi bay)
 *   4. instantiate FlipCoin_Blue/Green/Red (Flip_41/42/43) tại symbol → play "animation"
 *      → trail bay song song (mặc định ngay khi flip bắt đầu, không chờ flip xong)
 *   5. instantiate(particleTemplate) → child của CarnivalTrailController → bay tới Pot
 *   6. CARNIVAL_TRAIL_ONE_HIT → CarnivalPotBoard Spine impact
 *   7. CARNIVAL_TRAIL_FLY_DONE
 *
 * ĐƯỜNG BAY (dạng dấu hỏi "?"):
 *   Một cubic Bezier liên tục: từ Trail (dưới) vòng cung lên hơi cao hơn Pot rồi đổ xuống.
 *   Luôn vòng về phía gần Pot (mép Pot hướng về Symbol) — không vòng ra mặt xa.
 *   Tốc độ linear đều — không slow-start / tăng tốc giật.
 *   Timing Normal/Quick/Turbo khớp Wild Trail (0.8 / 0.65 / 0.5)
 *
 * SETUP EDITOR:
 *   1. Node "CarnivalTrailController" + gắn component
 *   2. Kéo 5 ReelController → reels
 *   3. Kéo 3 Pot → bluePot / redPot / greenPot
 *   4. Child inactive (Sprite / ParticleSystem) → particleTemplate
 *   5. Child inactive FlipCoin_Blue / FlipCoin_Green / FlipCoin_Red (sp.Skeleton Flip_41/42/43)
 */

import {
    _decorator, Component, Node, Vec3, tween, Tween, NodePool,
    Color, Sprite, SpriteFrame, instantiate, ParticleSystem, UIOpacity, UITransform, Camera,
    sp, assetManager,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { ReelController } from './ReelController';
import { SymbolView } from './SymbolView';
import { Log } from '../core/Logger';
import { AutoSpinManager, SpeedMode } from '../manager/AutoSpinManager';
import { SoundManager } from '../manager/SoundManager';
import {
    CarnivalTrailHit,
    TrailColor,
    SymbolId,
    trailColorToSymbolId,
    CLIENT_TO_PS,
} from '../data/SlotTypes';
import { getSymbolPackFrame, resolveSymbolPackAtlas } from '../data/SymbolPackUtil';
import { CarnivalPotBoard } from './CarnivalPotBoard';
import { CoinClusterView } from './CoinClusterView';

const { ccclass, property } = _decorator;

/** Camera 3D vẽ particle trail (layer DEFAULT). Mặc định scene: pos (960,540) gốc trái canvas 1920×1080. */
const PARTICLE_3D_CAMERA_NAME = 'Particle3DCamera';
const SPINE_BUNDLE = 'MainBundle';
const FLIP_ANIM_DEFAULT = 'animation';
const FLIP_SPINE_PATH: Record<TrailColor, string> = {
    [TrailColor.BLUE]: 'newSpine/Flip_COIN/Flip_41',
    [TrailColor.GREEN]: 'newSpine/Flip_COIN/Flip_42',
    [TrailColor.RED]: 'newSpine/Flip_COIN/Flip_43',
};
const FLIP_SPINE_UUID: Record<TrailColor, string> = {
    [TrailColor.BLUE]: 'ed611649-4a84-499e-bf4f-9d15c49209f5',
    [TrailColor.GREEN]: 'fba29b93-2ae5-49f3-9057-84f868ab5b95',
    [TrailColor.RED]: 'c85f2ad7-7168-4a60-97fd-0400a76cf8e7',
};
const FLIP_TEMPLATE_NAME: Record<TrailColor, string> = {
    [TrailColor.BLUE]: 'FlipCoin_Blue',
    [TrailColor.GREEN]: 'FlipCoin_Green',
    [TrailColor.RED]: 'FlipCoin_Red',
};

@ccclass('CarnivalTrailController')
export class CarnivalTrailController extends Component {

    @property({ type: [ReelController], tooltip: '5 ReelController 0→4' })
    reels: ReelController[] = [];

    @property({ type: Node, tooltip: 'Blue Pot target (left)' })
    bluePot: Node | null = null;

    @property({ type: Node, tooltip: 'Red Pot target (center)' })
    redPot: Node | null = null;

    @property({ type: Node, tooltip: 'Green Pot target (right)' })
    greenPot: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Template bay (child inactive).\ninstantiate mỗi lần → parent dưới CarnivalTrailController.',
    })
    particleTemplate: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Template Spine flip Blue (Flip_41). Child inactive — instantiate mỗi lần flip.',
    })
    flipBlueTemplate: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Template Spine flip Green (Flip_42). Child inactive — instantiate mỗi lần flip.',
    })
    flipGreenTemplate: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Template Spine flip Red (Flip_43). Child inactive — instantiate mỗi lần flip.',
    })
    flipRedTemplate: Node | null = null;

    @property({ tooltip: 'Scale Spine flip so với symbol (1 = khớp world scale symbol)' })
    flipScale: number = 1;

    @property({ tooltip: 'Tốc độ Spine flip (1 = bình thường, 1.5 = nhanh gấp 1.5 lần)' })
    flipTimeScale: number = 1.5;

    @property({ tooltip: 'Fallback scale-flip nửa nhịp (giây) — chỉ khi Spine chưa load được' })
    flipHalfDuration: number = 0.12;

    @property({
        tooltip: 'Sau khi reel dừng + hiện TRAIL_NORMAL xong, chờ bao lâu (giây) rồi mới flip/bay.\n'
               + '0 = flip/bay ngay sau khi symbol settle.',
    })
    postStopHoldDuration: number = 0;

    @property({
        tooltip: 'Tỉ lệ anim flip (0–1) trôi qua rồi mới bay.\n'
               + '0 = bay ngay khi flip bắt đầu. 1 = chờ flip xong.\n'
               + 'Kết hợp thêm Fly Start Extra Delay (giây).',
        range: [0, 1, 0.05],
    })
    flyStartAfterFlipRatio: number = 0.25;

    @property({
        tooltip: 'Delay cố định (giây) sau khi flip bắt đầu, cộng thêm trước khi trail bay.\n'
               + 'Canh “một chút” muộn hơn ratio thuần — không chờ hết flip.',
    })
    flyStartExtraDelay: number = 0.06;

    @property({ tooltip: 'Thời gian particle bay Normal (giây) — khớp Wild Trail' })
    flyDurationNormal: number = 0.8;

    @property({ tooltip: 'Thời gian particle bay Quick — khớp Wild Trail' })
    flyDurationQuick: number = 0.65;

    @property({ tooltip: 'Thời gian particle bay Turbo — khớp Wild Trail' })
    flyDurationTurbo: number = 0.5;

    @property({ tooltip: 'Scale particle bay' })
    flyScale: number = 1.0;

    @property({
        tooltip: 'Độ cao APEX phía trên Pot (world) — điểm đỉnh trước khi rơi xuống Pot.',
    })
    apexHeight: number = 110;

    @property({
        tooltip: 'Độ rộng vòng cung Bezier (tỉ lệ so với khoảng cách symbol→apex).\n'
               + 'Nhẹ vừa đủ thành dấu hỏi — không vòng lố như Wild Trail.',
        range: [0.15, 1.5, 0.05],
    })
    flyCurvature: number = 0.45;

    @property({
        tooltip: 'Khoảng cách tối thiểu (world) dùng để tính vòng cung.\n'
               + 'Giữ thấp để đường bay không bị ép vòng quá rộng khi gần Pot.',
    })
    minFlyPathDistance: number = 180;

    @property({
        tooltip: 'Delay tối thiểu trước khi bắt đầu bay (giây) — chờ particle/trail seed tại Symbol.\n'
               + 'Hay chỉnh: giảm để trail bay ngay sau flip ra màu.',
    })
    flyLaunchDelay: number = 0.02;

    @property({
        tooltip: 'Thời gian giữ particle sau khi chạm Pot (giây).\n'
               + 'Chạm Pot → Coins_Trail*: stop ngay | qilin*: loop=false tàn dần.\n'
               + 'Thực tế lấy max(giá trị này, startLifetime + trailLife của qilin*).',
    })
    particleFadeOutDuration: number = 1.2;

    @property({
        tooltip: 'Prefix tên child particle — stop()+clear ngay khi chạm Pot (vd. Coins_Trail).',
    })
    particleHitStopPrefixes: string[] = ['Coins_Trail'];

    @property({
        tooltip: 'Prefix tên child particle — loop=false, dừng emit, tàn dần khi chạm Pot (vd. qilin).',
    })
    particleHitLoopOffPrefixes: string[] = ['qilin'];

    @property({
        tooltip: 'Ẩn Coins_Trail* particle — thay bằng chùm sprite xoay (CoinCluster).',
    })
    useCoinClusterInsteadOfParticles = true;

    @property({ tooltip: 'Số đồng xu trong chùm bay' })
    coinClusterCount = 5;

    @property({ tooltip: 'Bán kính random quanh tâm chùm (local px)' })
    coinClusterSpread = 36;

    @property({ tooltip: 'Scale mỗi đồng xu trong chùm' })
    coinClusterCoinScale = 0.52;

    @property({ tooltip: 'Tốc độ xoay trục Y tối thiểu (deg/giây)' })
    coinClusterRotateSpeedMin = 200;

    @property({ tooltip: 'Tốc độ xoay trục Y tối đa (deg/giây)' })
    coinClusterRotateSpeedMax = 480;

    @property({ tooltip: 'Pool Fx_Coin_Trail — tái sử dụng thay instantiate/destroy mỗi trail' })
    flyFxPoolEnabled = true;

    @property({ tooltip: 'Số instance Fx_Coin_Trail giữ trong pool tối đa' })
    flyFxMaxPoolSize = 10;

    private _pending: CarnivalTrailHit[] = [];
    private _flyingCount = 0;
    private _started = false;
    private _flipGen = 0;
    private _activeParticles: Node[] = [];
    private _coinClusterByFx = new Map<Node, Node>();
    private _activeFlips: Node[] = [];
    private _flipData = new Map<TrailColor, sp.SkeletonData>();
    private _flipLoad: Map<TrailColor, Promise<sp.SkeletonData | null>> = new Map();
    private _flyFxPool: NodePool | null = null;
    /** rateOverTime/Distance gốc từ template — restore sau fade/pool. */
    private _particleEmitDefaults = new Map<string, { rateTime: number; rateDist: number }>();

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.CARNIVAL_TRAIL_START, this._onTrailStart, this);
        bus.on(GameEvents.CARNIVAL_TRAIL_ONE, this._onTrailOne, this);
        bus.on(GameEvents.REELS_START_SPIN, this._onReelsStartSpin, this);
        bus.on(GameEvents.REELS_STOPPED, this._onReelsStoppedFallback, this);
    }

    start(): void {
        this._autoWireIfNeeded();
        this._ensureFlipTemplates();
        void this._preloadFlipSpines();
        if (this.particleTemplate?.isValid) {
            this.particleTemplate.active = false;
        }
        this._cacheParticleEmitDefaults();
        this._initFlyFxPool();
        this._syncParticle3DCamera();
        Log.e(
            `[CarnivalTrail] ready | reels=${this.reels?.length ?? 0}` +
            ` pots=B${!!this.bluePot}/R${!!this.redPot}/G${!!this.greenPot}` +
            ` template=${this.particleTemplate ? this.particleTemplate.name : 'NULL'}` +
            ` flip=B${!!this.flipBlueTemplate}/G${!!this.flipGreenTemplate}/R${!!this.flipRedTemplate}`
        );
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        this._clearParticles();
        this._clearFlips();
        this._clearFlyFxPool();
    }

    lateUpdate(): void {
        if (this._activeParticles.length > 0) this._syncParticle3DCamera();
    }

    private _autoWireIfNeeded(): void {
        // Tự lấy pot từ CarnivalPotBoard nếu chưa kéo tay
        if (!this.bluePot || !this.redPot || !this.greenPot) {
            const board = this.node.getComponent(CarnivalPotBoard)
                ?? this.node.parent?.getComponent(CarnivalPotBoard)
                ?? this.node.scene?.getComponentInChildren(CarnivalPotBoard)
                ?? null;
            if (board) {
                this.bluePot = this.bluePot ?? board.bluePot;
                this.redPot = this.redPot ?? board.redPot;
                this.greenPot = this.greenPot ?? board.greenPot;
                Log.e('[CarnivalTrail] auto-wired pots from CarnivalPotBoard');
            }
        }
        // Template mặc định: child inactive đầu tiên (trừ khi đã gán)
        if (!this.particleTemplate) {
            for (const child of this.node.children) {
                if (!child.active && !child.name.startsWith('FlipCoin_')) {
                    this.particleTemplate = child;
                    Log.e(`[CarnivalTrail] auto-wired particleTemplate="${child.name}"`);
                    break;
                }
            }
        }
        this.flipBlueTemplate = this.flipBlueTemplate ?? this.node.getChildByName(FLIP_TEMPLATE_NAME[TrailColor.BLUE]);
        this.flipGreenTemplate = this.flipGreenTemplate ?? this.node.getChildByName(FLIP_TEMPLATE_NAME[TrailColor.GREEN]);
        this.flipRedTemplate = this.flipRedTemplate ?? this.node.getChildByName(FLIP_TEMPLATE_NAME[TrailColor.RED]);
    }

    private _onReelsStartSpin(): void {
        this.unscheduleAllCallbacks();
        this._pending = [];
        this._flyingCount = 0;
        this._started = false;
        this._flipGen++;
        this._clearParticles();
        this._clearFlips();
    }

    private _onTrailStart(payload: { trails?: CarnivalTrailHit[] }): void {
        this._pending = [...(payload?.trails ?? [])];
        this._started = true;
        this._flyingCount = 0;
        this._syncParticle3DCamera();
        Log.e(`[CarnivalTrail] START count=${this._pending.length} → ${this._pending.map(t => `r${t.reel}row${t.row}:${TrailColor[t.color]}`).join(', ')}`);
    }

    private _onReelsStoppedFallback(): void {
        if (!this._started || this._pending.length === 0) return;
        if (this._flyingCount > 0) return;
        const batch = [...this._pending];
        this._pending = [];
        Log.e(`[CarnivalTrail] REELS_STOPPED fallback — ${batch.length} trails`);
        for (const hit of batch) this._holdNormalThenAnimate(hit);
    }

    private _onTrailOne(hit: CarnivalTrailHit): void {
        if (!hit) return;
        this._pending = this._pending.filter(t => !(t.reel === hit.reel && t.row === hit.row));

        const symbolNode = this._getSymbolNode(hit.reel, hit.row);
        const reelCtrl = this.reels[hit.reel];
        // Chờ stop-bounce xong → ép TRAIL_NORMAL → giữ ngắn → flip/bay
        if (symbolNode?.isValid && reelCtrl && !reelCtrl.isIdle) {
            symbolNode.once('reel-settled', () => {
                if (symbolNode.isValid) this._holdNormalThenAnimate(hit);
            });
            return;
        }
        this._holdNormalThenAnimate(hit);
    }

    /** Ép hình gốc TRAIL_NORMAL, giữ postStopHoldDuration rồi mới flip + bay. */
    private _holdNormalThenAnimate(hit: CarnivalTrailHit): void {
        const symbolNode = this._getSymbolNode(hit.reel, hit.row);
        const view = symbolNode?.getComponent(SymbolView);
        if (view?.isValid) {
            view.setSymbol(SymbolId.TRAIL_NORMAL);
            this._resetSpriteColor(view);
        }
        const hold = Math.max(0, this.postStopHoldDuration);
        if (hold <= 0) {
            this._animateHit(hit);
            return;
        }
        this.scheduleOnce(() => this._animateHit(hit), hold);
    }

    private _animateHit(hit: CarnivalTrailHit): void {
        this._flyingCount++;
        const symbolNode = this._getSymbolNode(hit.reel, hit.row);
        if (!symbolNode) {
            Log.e(`[CarnivalTrail] MISSING symbol r${hit.reel}row${hit.row} — check reels[]`);
            this._flyingCount = Math.max(0, this._flyingCount - 1);
            this._emitHitAndMaybeDone(hit.color);
            return;
        }

        const view = symbolNode.getComponent(SymbolView);
        const coloredId = trailColorToSymbolId(hit.color);

        // Đảm bảo vẫn đang ở NORMAL trước khi bắt đầu flip
        if (view) {
            view.setSymbol(SymbolId.TRAIL_NORMAL);
            this._resetSpriteColor(view);
        }

        let flyStarted = false;
        const startFly = () => {
            if (flyStarted) return;
            flyStarted = true;
            this._flyToPot(symbolNode, hit, () => {
                this._flyingCount = Math.max(0, this._flyingCount - 1);
                this._emitHitAndMaybeDone(hit.color);
            });
        };

        const gen = this._flipGen;
        void this._playFlipThenFly(symbolNode, view, hit.color, coloredId, startFly, gen);
    }

    private async _playFlipThenFly(
        symbolNode: Node,
        view: SymbolView | null,
        color: TrailColor,
        coloredId: SymbolId,
        startFly: () => void,
        gen: number,
    ): Promise<void> {
        const data = await this._ensureFlipData(color);
        if (gen !== this._flipGen || !symbolNode.isValid) return;
        if (data) {
            this._playSpineFlip(symbolNode, view, color, coloredId, data, startFly, gen);
            return;
        }
        Log.e(`[CarnivalTrail] Flip spine missing ${FLIP_SPINE_PATH[color]} — skip scale-flip, show color + fly`);
        if (view?.isValid) {
            view.setSymbol(coloredId);
            this._resetSpriteColor(view);
        }
        SoundManager.instance?.playSfxByName('sxTrailLand');
        startFly();
    }

    private _playSpineFlip(
        symbolNode: Node,
        view: SymbolView | null,
        color: TrailColor,
        coloredId: SymbolId,
        data: sp.SkeletonData,
        startFly: () => void,
        gen: number,
    ): void {
        const flipNode = new Node(`CarnivalTrailFlip_${TrailColor[color]}`);
        flipNode.layer = symbolNode.layer || this.node.layer;
        const ut = flipNode.addComponent(UITransform);
        ut.setContentSize(180, 180);
        const skel = flipNode.addComponent(sp.Skeleton);
        skel.premultipliedAlpha = false;
        skel.skeletonData = data;

        flipNode.setParent(symbolNode, false);
        flipNode.setPosition(0, 0, 0);
        flipNode.setScale(this.flipScale, this.flipScale, 1);
        flipNode.setSiblingIndex(symbolNode.children.length - 1);
        flipNode.active = true;
        this._activeFlips.push(flipNode);

        if (view?.isValid) view.setSpriteVisible(false);

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            this._destroyFlip(flipNode);
            if (gen !== this._flipGen) return;
            if (view?.isValid) {
                view.setSymbol(coloredId);
                this._resetSpriteColor(view);
            }
        };

        const animName = this._resolveFlipAnimName(skel) ?? FLIP_ANIM_DEFAULT;
        const timeScale = Math.max(0.1, this.flipTimeScale);
        skel.timeScale = timeScale;
        skel.setCompleteListener(null);
        let duration = 0.67;
        try {
            SoundManager.instance?.playSfxByName('sxTrailLand');
            const entry = skel.setAnimation(0, animName, false);
            duration = entry?.animation?.duration ?? duration;
            Log.e(`[CarnivalTrail] PLAY flip ${TrailColor[color]} anim="${animName}" dur=${duration.toFixed(2)} x${timeScale}`);
        } catch (err) {
            Log.e(`[CarnivalTrail] setAnimation failed ${animName}`, err);
            startFly();
            finish();
            return;
        }
        const playDuration = duration / timeScale;
        this._scheduleFlyAfterFlip(startFly, playDuration, gen, symbolNode);
        this.scheduleOnce(() => {
            if (flipNode.isValid) finish();
        }, playDuration + 0.02);
        skel.setCompleteListener(() => {
            skel.setCompleteListener(null);
            if (flipNode.isValid) finish();
        });
    }

    /** Bay sau một phần flip + delay cố định — giữa “quá sớm” và “chờ flip xong”. */
    private _scheduleFlyAfterFlip(
        startFly: () => void,
        flipDuration: number,
        gen: number,
        symbolNode: Node,
    ): void {
        const ratio = Math.max(0, Math.min(1, this.flyStartAfterFlipRatio));
        const delay = flipDuration * ratio + Math.max(0, this.flyStartExtraDelay);
        if (delay <= 0.001) {
            startFly();
            return;
        }
        this.scheduleOnce(() => {
            if (gen !== this._flipGen || !symbolNode.isValid) return;
            startFly();
        }, delay);
    }

    private _ensureFlipTemplates(): void {
        const colors: TrailColor[] = [TrailColor.BLUE, TrailColor.GREEN, TrailColor.RED];
        for (const color of colors) {
            let node = this._flipTemplateFor(color);
            if (!node?.isValid) {
                node = this._createFlipTemplate(FLIP_TEMPLATE_NAME[color], null);
                node.setParent(this.node);
                this._setFlipTemplate(color, node);
            }
            node.active = false;
        }
    }

    private _createFlipTemplate(name: string, data: sp.SkeletonData | null): Node {
        const node = new Node(name);
        node.layer = this.node.layer;
        node.active = false;
        const ut = node.addComponent(UITransform);
        ut.setContentSize(180, 180);
        const skel = node.addComponent(sp.Skeleton);
        skel.premultipliedAlpha = false;
        if (data) skel.skeletonData = data;
        return node;
    }

    private _preloadFlipSpines(): Promise<void> {
        return Promise.all([
            this._ensureFlipData(TrailColor.BLUE),
            this._ensureFlipData(TrailColor.GREEN),
            this._ensureFlipData(TrailColor.RED),
        ]).then(() => undefined);
    }

    private _ensureFlipData(color: TrailColor): Promise<sp.SkeletonData | null> {
        const cached = this._flipData.get(color);
        if (cached) return Promise.resolve(cached);

        const template = this._flipTemplateFor(color);
        const existing = template?.getComponent(sp.Skeleton) ?? template?.getComponentInChildren(sp.Skeleton);
        if (existing?.skeletonData) {
            this._flipData.set(color, existing.skeletonData);
            return Promise.resolve(existing.skeletonData);
        }

        const inflight = this._flipLoad.get(color);
        if (inflight) return inflight;

        const path = FLIP_SPINE_PATH[color];
        const uuid = FLIP_SPINE_UUID[color];
        const promise = new Promise<sp.SkeletonData | null>((resolve) => {
            const done = (data: sp.SkeletonData | null, via: string) => {
                this._flipLoad.delete(color);
                if (data) {
                    this._flipData.set(color, data);
                    const tmpl = this._flipTemplateFor(color);
                    const skel = tmpl?.getComponent(sp.Skeleton) ?? tmpl?.getComponentInChildren(sp.Skeleton);
                    if (skel && !skel.skeletonData) skel.skeletonData = data;
                    Log.e(`[CarnivalTrail] loaded flip spine via ${via}: ${path}`);
                }
                resolve(data);
            };

            const bundle = assetManager.getBundle(SPINE_BUNDLE);
            if (bundle) {
                bundle.load(path, sp.SkeletonData, (err: Error | null, data: sp.SkeletonData) => {
                    if (!err && data) {
                        done(data, 'bundle');
                        return;
                    }
                    Log.w(`[CarnivalTrail] bundle.load failed ${path}`, err);
                    assetManager.loadAny({ uuid }, (uuidErr: Error | null, uuidData: sp.SkeletonData) => {
                        if (uuidErr || !uuidData) {
                            Log.e(`[CarnivalTrail] loadAny uuid failed ${uuid}`, uuidErr);
                            done(null, 'fail');
                            return;
                        }
                        done(uuidData, 'uuid');
                    });
                });
                return;
            }

            Log.w(`[CarnivalTrail] Bundle '${SPINE_BUNDLE}' missing — try uuid ${uuid}`);
            assetManager.loadAny({ uuid }, (uuidErr: Error | null, uuidData: sp.SkeletonData) => {
                if (uuidErr || !uuidData) {
                    Log.e(`[CarnivalTrail] loadAny uuid failed ${uuid}`, uuidErr);
                    done(null, 'fail');
                    return;
                }
                done(uuidData, 'uuid');
            });
        });
        this._flipLoad.set(color, promise);
        return promise;
    }

    private _flipTemplateFor(color: TrailColor): Node | null {
        switch (color) {
            case TrailColor.BLUE: return this.flipBlueTemplate;
            case TrailColor.GREEN: return this.flipGreenTemplate;
            case TrailColor.RED: return this.flipRedTemplate;
            default: return null;
        }
    }

    private _setFlipTemplate(color: TrailColor, node: Node): void {
        switch (color) {
            case TrailColor.BLUE: this.flipBlueTemplate = node; break;
            case TrailColor.GREEN: this.flipGreenTemplate = node; break;
            case TrailColor.RED: this.flipRedTemplate = node; break;
        }
    }

    private _resolveFlipAnimName(skel: sp.Skeleton): string | null {
        const tryName = (name: string): string | null => {
            try {
                const find = (skel as unknown as { findAnimation?: (n: string) => unknown }).findAnimation;
                if (typeof find === 'function' && find.call(skel, name)) return name;
            } catch {
                /* spine chưa init — vẫn cho setAnimation thử */
            }
            return null;
        };
        return tryName(FLIP_ANIM_DEFAULT) ?? tryName('Flip') ?? tryName('flip') ?? FLIP_ANIM_DEFAULT;
    }

    private _destroyFlip(node: Node): void {
        const idx = this._activeFlips.indexOf(node);
        if (idx >= 0) this._activeFlips.splice(idx, 1);
        if (!node?.isValid) return;
        const skel = node.getComponent(sp.Skeleton) ?? node.getComponentInChildren(sp.Skeleton);
        if (skel) skel.setCompleteListener(null);
        node.destroy();
    }

    private _clearFlips(): void {
        for (const n of this._activeFlips) {
            if (!n?.isValid) continue;
            const skel = n.getComponent(sp.Skeleton) ?? n.getComponentInChildren(sp.Skeleton);
            if (skel) skel.setCompleteListener(null);
            n.destroy();
        }
        this._activeFlips.length = 0;
    }

    /**
     * Bay dạng dấu hỏi "?" — một cubic Bezier liên tục, tốc độ đều (linear):
     *   start (dưới) → vòng cung lên cao hơn Pot một chút → đổ xuống miệng Pot.
     * Timing: Normal 0.8 / Quick 0.65 / Turbo 0.5.
     */
    private _flyToPot(symbolNode: Node, hit: CarnivalTrailHit, onDone: () => void): void {
        const pot = this._potFor(hit.color);
        if (!pot?.isValid) {
            Log.e(`[CarnivalTrail] Pot NULL ${TrailColor[hit.color]} — không bay được`);
            this.scheduleOnce(onDone, 0.05);
            return;
        }

        const particle = this._spawnFromTemplate();
        if (!particle) {
            this.scheduleOnce(onDone, 0.05);
            return;
        }

        particle.setParent(this.node, false);
        this._activateTree(particle);
        particle.setSiblingIndex(this.node.children.length - 1);
        this._ensureVisible(particle);
        this._activeParticles.push(particle);

        this._syncParticle3DCamera();
        this.node.updateWorldTransform();
        symbolNode.updateWorldTransform();
        pot.updateWorldTransform();

        const selfUT = this.node.getComponent(UITransform);
        const start = selfUT
            ? selfUT.convertToNodeSpaceAR(symbolNode.getWorldPosition())
            : symbolNode.worldPosition.clone();
        const end = selfUT
            ? selfUT.convertToNodeSpaceAR(pot.getWorldPosition())
            : pot.worldPosition.clone();
        start.z = 0;
        end.z = 0;

        const apexH = Math.max(20, this.apexHeight);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        // Luôn vòng cung về phía gần Pot (mặt Pot hướng về Symbol), không vòng ra mặt xa.
        // VD: Symbol trái + Pot phải → tiếp cận mép trái Pot (side=-1), không vòng sang mép phải.
        const side = this._resolveFlySide(start, end, hit.reel);
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), this.minFlyPathDistance * 0.5, 1);
        const bulge = dist * Math.abs(this.flyCurvature);

        // CP1 gần Symbol — tangent đầu không quá lớn (Turbo dễ "nhảy" xa Symbol nếu CP1 xa)
        const riseY = Math.max(start.y, end.y) + apexH * 1.35;
        const cp1X = start.x + dx * 0.18 + side * bulge * 0.55;
        const cp1Y = start.y + (riseY - start.y) * 0.45;

        // CP2: neo phía trên Pot — phần thân "?" trước khi rơi xuống (cùng phía gần với Symbol)
        const cp2X = end.x + side * bulge * 0.2;
        const cp2Y = end.y + apexH;

        particle.setPosition(start);
        particle.setScale(this.flyScale, this.flyScale, 1);

        if (this.useCoinClusterInsteadOfParticles) {
            this._hideCoinsTrailParticles(particle);
            this._setupCoinCluster(particle, hit.color);
        }

        Log.e(
            `[CarnivalTrail] FLY? ${TrailColor[hit.color]} ` +
            `from(${start.x.toFixed(0)},${start.y.toFixed(0)}) ` +
            `rise(${cp1X.toFixed(0)},${cp1Y.toFixed(0)}) ` +
            `apex(${cp2X.toFixed(0)},${cp2Y.toFixed(0)}) ` +
            `→ pot(${end.x.toFixed(0)},${end.y.toFixed(0)})`
        );

        // Play ngay tại Symbol + 1 frame sau (processor sẵn) — seed trail trước khi bay
        SoundManager.instance?.playSfxByName('sxCoinFly');
        this._playParticleSystems(particle);
        this.scheduleOnce(() => {
            if (particle.isValid) this._playParticleSystems(particle);
        }, 0);

        const flyProxy = { t: 0 };
        (particle as unknown as { _trailFlyProxy?: { t: number } })._trailFlyProxy = flyProxy;
        const pos = new Vec3();
        const totalDur = this._flyDuration();
        const launchDelay = this._getLaunchDelay(totalDur);
        const moveDur = Math.max(0.01, totalDur - launchDelay);

        const updatePos = (rawT: number) => {
            if (!particle.isValid) return;
            // Linear — diễn đều sau khi đã hold tại Symbol
            const t = Math.min(1, Math.max(0, rawT));
            const u = 1 - t;
            const uu = u * u;
            const tt = t * t;
            pos.x = uu * u * start.x + 3 * uu * t * cp1X + 3 * u * tt * cp2X + tt * t * end.x;
            pos.y = uu * u * start.y + 3 * uu * t * cp1Y + 3 * u * tt * cp2Y + tt * t * end.y;
            pos.z = 0;
            particle.setPosition(pos);
        };

        updatePos(0);

        // Hold tại Symbol suốt launchDelay — mỗi frame pin lại start (tránh drift / frame đầu lệch)
        tween(flyProxy)
            .delay(launchDelay)
            .call(() => {
                if (particle.isValid) particle.setPosition(start);
            })
            .to(moveDur, { t: 1 }, {
                easing: 'linear',
                onUpdate: () => updatePos(flyProxy.t),
            })
            .call(() => {
                // Chạm Pot → Coins_Trail* stop ngay; qilin* loop=false tàn dần
                this._beginParticleFadeOut(particle);
                onDone();
            })
            .start();
    }

    /**
     * Hold tại Symbol trước khi bay — Turbo giữ lâu hơn (tỉ lệ + tuyệt đối)
     * để particle/trail kịp hiện ngay tại Symbol, không nhảy ra giữa đường.
     */
    private _getLaunchDelay(totalDur: number): number {
        const mode = AutoSpinManager.instance.speedMode;
        let minHold = this.flyLaunchDelay;
        let maxFrac = 0.12;
        switch (mode) {
            case SpeedMode.TURBO:
                minHold = Math.max(this.flyLaunchDelay, 0.03);
                maxFrac = 0.15;
                break;
            case SpeedMode.QUICK:
                minHold = Math.max(this.flyLaunchDelay, 0.025);
                maxFrac = 0.12;
                break;
            default:
                minHold = Math.max(this.flyLaunchDelay, 0.02);
                maxFrac = 0.1;
                break;
        }
        return Math.min(Math.max(0, minHold), totalDur * maxFrac);
    }

    /** Tắt emit nhưng giữ ParticleSystem playing để particle/trail tàn dần. */
    private _stopParticleEmission(ps: ParticleSystem): void {
        ps.loop = false;
        if (ps.rateOverTime) {
            ps.rateOverTime.mode = 0;
            ps.rateOverTime.constant = 0;
        }
        if (ps.rateOverDistance) {
            ps.rateOverDistance.mode = 0;
            ps.rateOverDistance.constant = 0;
        }
        if (!ps.isPlaying) {
            ps.play();
        }
    }

    private _cacheParticleEmitDefaults(): void {
        this._particleEmitDefaults.clear();
        if (!this.particleTemplate?.isValid) return;
        for (const ps of this.particleTemplate.getComponentsInChildren(ParticleSystem)) {
            if (!ps?.isValid) continue;
            this._particleEmitDefaults.set(ps.node.name, {
                rateTime: ps.rateOverTime?.constant ?? 0,
                rateDist: ps.rateOverDistance?.constant ?? 0,
            });
        }
    }

    private _restoreParticleEmission(ps: ParticleSystem): void {
        const defaults = this._particleEmitDefaults.get(ps.node.name);
        if (!defaults) return;
        if (ps.rateOverTime) {
            ps.rateOverTime.mode = 0;
            ps.rateOverTime.constant = defaults.rateTime;
        }
        if (ps.rateOverDistance) {
            ps.rateOverDistance.mode = 0;
            ps.rateOverDistance.constant = defaults.rateDist;
        }
    }

    /** stop()+clear — biến mất ngay (Coins_Trail* khi chạm Pot). */
    private _stopParticleImmediate(ps: ParticleSystem): void {
        ps.loop = false;
        ps.stop();
        ps.clear();
    }

    private _matchesParticlePrefix(nodeName: string, prefixes: string[]): boolean {
        if (!prefixes?.length || !nodeName) return false;
        return prefixes.some(p => !!p && nodeName.startsWith(p));
    }

    private _particleSystemOnNode(node: Node): ParticleSystem | null {
        const ps = node.getComponent(ParticleSystem);
        return ps?.isValid && ps.enabled ? ps : null;
    }

    private _estimateParticleFadeDelay(root: Node): number {
        let maxLife = Math.max(0, this.particleFadeOutDuration);
        for (const child of root.children) {
            const ps = this._particleSystemOnNode(child);
            if (!ps) continue;
            if (this._matchesParticlePrefix(child.name, this.particleHitStopPrefixes)) continue;
            const startLife = ps.startLifetime?.constant ?? 0;
            const trail = (ps as unknown as {
                trailModule?: { enable?: boolean; lifeTime?: { constant?: number } };
            }).trailModule;
            const trailLife = (trail?.enable && trail.lifeTime?.constant) ? trail.lifeTime.constant : 0;
            maxLife = Math.max(maxLife, startLife + trailLife + 0.15);
        }
        return maxLife;
    }

    private _beginParticleFadeOut(root: Node): void {
        if (!root?.isValid) return;
        this._destroyCoinCluster(root);
        root.active = true;
        for (const child of root.children) {
            const ps = this._particleSystemOnNode(child);
            if (!ps) continue;
            if (this._matchesParticlePrefix(child.name, this.particleHitStopPrefixes)) {
                this._stopParticleImmediate(ps);
                continue;
            }
            if (this._matchesParticlePrefix(child.name, this.particleHitLoopOffPrefixes)) {
                this._stopParticleEmission(ps);
                continue;
            }
            this._stopParticleEmission(ps);
        }
        const delay = this._estimateParticleFadeDelay(root);
        this.scheduleOnce(() => {
            this._destroyParticle(root);
        }, delay);
    }

    private _destroyParticle(root: Node): void {
        const idx = this._activeParticles.indexOf(root);
        if (idx >= 0) this._activeParticles.splice(idx, 1);
        this._recycleFlyFx(root);
    }

    private _initFlyFxPool(): void {
        if (!this.flyFxPoolEnabled || !this.particleTemplate?.isValid) {
            this._flyFxPool = null;
            return;
        }
        this._clearFlyFxPool();
        for (const ps of this.particleTemplate.getComponentsInChildren(ParticleSystem)) {
            if ('playOnAwake' in ps) {
                (ps as unknown as { playOnAwake: boolean }).playOnAwake = false;
            }
        }
        const pool = new NodePool();
        const seed = instantiate(this.particleTemplate);
        seed.active = false;
        pool.put(seed);
        this._flyFxPool = pool;
    }

    private _clearFlyFxPool(): void {
        if (!this._flyFxPool) return;
        while (this._flyFxPool.size() > 0) {
            const n = this._flyFxPool.get();
            if (n?.isValid) n.destroy();
        }
        this._flyFxPool.clear();
        this._flyFxPool = null;
    }

    private _recycleFlyFx(fx: Node): void {
        if (!fx?.isValid) return;
        this._resetFlyFx(fx);
        if (!this.flyFxPoolEnabled || !this._flyFxPool) {
            fx.destroy();
            return;
        }
        if (this._flyFxPool.size() >= Math.max(1, this.flyFxMaxPoolSize)) {
            fx.destroy();
            return;
        }
        this._flyFxPool.put(fx);
    }

    /** Reset state trước khi trả Fx_Coin_Trail về pool. */
    private _resetFlyFx(fx: Node): void {
        this._destroyCoinCluster(fx);
        const flyProxy = (fx as unknown as { _trailFlyProxy?: { t: number } })._trailFlyProxy;
        if (flyProxy) Tween.stopAllByTarget(flyProxy);
        delete (fx as unknown as { _trailFlyProxy?: { t: number } })._trailFlyProxy;
        Tween.stopAllByTarget(fx);

        fx.removeFromParent();
        fx.active = false;
        fx.setPosition(0, 0, 0);
        fx.setScale(1, 1, 1);
        fx.setRotationFromEuler(0, 0, 0);

        for (const child of fx.children) {
            if (this._matchesParticlePrefix(child.name, this.particleHitStopPrefixes)) {
                child.active = true;
            }
        }
        for (const ps of fx.getComponentsInChildren(ParticleSystem)) {
            this._restoreParticleEmission(ps);
            ps.loop = false;
            ps.stop();
            const maybeClear = (ps as unknown as { clear?: () => void }).clear;
            if (maybeClear) maybeClear.call(ps);
        }
        const op = fx.getComponent(UIOpacity) ?? fx.getComponentInChildren(UIOpacity);
        if (op) op.opacity = 255;
    }

    /** Ẩn Coins_Trail* — giữ qilin và các particle khác. */
    private _hideCoinsTrailParticles(root: Node): void {
        for (const child of root.children) {
            if (!this._matchesParticlePrefix(child.name, this.particleHitStopPrefixes)) continue;
            child.active = false;
            const ps = this._particleSystemOnNode(child);
            if (ps) this._stopParticleImmediate(ps);
        }
    }

    private _resolveTrailFrame(color: TrailColor): SpriteFrame | null {
        const symbolId = trailColorToSymbolId(color);
        for (const reel of this.reels) {
            if (!reel?.symbolNodes) continue;
            for (const node of reel.symbolNodes) {
                const view = node?.getComponent(SymbolView);
                const frame = view?.symbolFrames?.[symbolId];
                if (frame?.isValid) return frame;
            }
        }
        const atlas = resolveSymbolPackAtlas(null);
        if (!atlas) return null;
        const psId = CLIENT_TO_PS[symbolId];
        return psId !== undefined ? getSymbolPackFrame(atlas, psId) : null;
    }

    /** Chùm sprite từ node CoinCluster trong Fx_Coin_Trail prefab. */
    private _setupCoinCluster(fxRoot: Node, color: TrailColor): void {
        const frame = this._resolveTrailFrame(color);
        if (!frame) {
            Log.w(`[CarnivalTrail] CoinCluster: missing frame ${TrailColor[color]}`);
            return;
        }

        const cluster = fxRoot.getChildByName('CoinCluster');
        if (!cluster?.isValid) {
            Log.w('[CarnivalTrail] CoinCluster node missing in Fx_Coin_Trail prefab');
            return;
        }

        let view = cluster.getComponent(CoinClusterView);
        if (!view) view = cluster.addComponent(CoinClusterView);

        view.coinSpread = this.coinClusterSpread;
        view.coinScale = this.coinClusterCoinScale;
        view.rotateSpeedMin = this.coinClusterRotateSpeedMin;
        view.rotateSpeedMax = this.coinClusterRotateSpeedMax;
        view.setup(frame, {
            spread: this.coinClusterSpread,
            coinScale: this.coinClusterCoinScale,
            rotateSpeedMin: this.coinClusterRotateSpeedMin,
            rotateSpeedMax: this.coinClusterRotateSpeedMax,
            randomizeLayout: true,
            maxCount: Math.max(1, Math.round(this.coinClusterCount)),
        });

        this._coinClusterByFx.set(fxRoot, cluster);
    }

    private _destroyCoinCluster(fxRoot: Node): void {
        const cluster = this._coinClusterByFx.get(fxRoot);
        this._coinClusterByFx.delete(fxRoot);
        if (!cluster?.isValid) return;
        cluster.getComponent(CoinClusterView)?.stop();
        cluster.active = false;
    }

    /**
     * Chọn phía vòng cung gần Pot nhất theo vị trí Symbol → Pot.
     * -1 = lệch/tiếp cận mép trái Pot, +1 = mép phải Pot.
     * Symbol bên trái Pot → luôn -1; bên phải → luôn +1 (không vòng sang mặt xa).
     */
    private _resolveFlySide(start: Vec3, end: Vec3, reelIndex: number): number {
        const dx = end.x - start.x;
        if (Math.abs(dx) > 8) {
            // Symbol trái Pot → tiếp cận mép trái; Symbol phải Pot → mép phải.
            return dx > 0 ? -1 : 1;
        }
        // Gần như thẳng hàng theo X: fallback nhẹ theo reel để tránh cung phẳng.
        const reelCount = this.reels.length > 0 ? this.reels.length : 5;
        const center = Math.floor(reelCount / 2);
        if (reelIndex < center) return -1;
        if (reelIndex > center) return 1;
        return Math.random() < 0.5 ? -1 : 1;
    }

    /**
     * Particle3DCamera mặc định (960, 540) — tâm 1920×1080 gốc TRÁI.
     * Camera UI ở (0, 0) — tâm SlotMachine. Portrait không sync → trail lệch mép trái.
     */
    private _syncParticle3DCamera(): void {
        const scene = this.node.scene;
        if (!scene) return;
        const cameras = scene.getComponentsInChildren(Camera);
        const particleCam = cameras.find(c => c.node.name === PARTICLE_3D_CAMERA_NAME);
        if (!particleCam?.isValid) return;
        const uiCam = cameras.find(c =>
            c.enabled
            && c.node.name !== PARTICLE_3D_CAMERA_NAME
            && (c.visibility & this.node.layer) !== 0,
        );
        if (!uiCam?.isValid) return;
        particleCam.projection = uiCam.projection;
        particleCam.fov = uiCam.fov;
        particleCam.orthoHeight = uiCam.orthoHeight;
        particleCam.near = uiCam.near;
        particleCam.far = uiCam.far;
        particleCam.viewport = uiCam.viewport;
        particleCam.node.setWorldPosition(uiCam.node.worldPosition);
        particleCam.node.setWorldRotation(uiCam.node.worldRotation);
    }

    private _activateTree(node: Node): void {
        node.active = true;
        for (const c of node.children) this._activateTree(c);
    }

    private _ensureVisible(node: Node): void {
        let op = node.getComponent(UIOpacity);
        if (!op) op = node.addComponent(UIOpacity);
        op.opacity = 255;
        // Đảm bảo controller cũng visible
        let selfOp = this.node.getComponent(UIOpacity);
        if (selfOp && selfOp.opacity < 10) selfOp.opacity = 255;
    }

    private _emitHitAndMaybeDone(color: TrailColor): void {
        EventBus.instance.emit(GameEvents.CARNIVAL_TRAIL_ONE_HIT, { color });
        if (this._flyingCount <= 0 && this._pending.length === 0) {
            this._started = false;
            EventBus.instance.emit(GameEvents.CARNIVAL_TRAIL_FLY_DONE);
            Log.e('[CarnivalTrail] FLY_DONE');
        }
    }

    private _getSymbolNode(reel: number, row: number): Node | null {
        const reelCtrl = this.reels[reel];
        if (!reelCtrl) return null;
        const nodeIdx = 3 - row;
        return reelCtrl.symbolNodes[nodeIdx] ?? null;
    }

    private _potFor(color: TrailColor): Node | null {
        switch (color) {
            case TrailColor.BLUE: return this.bluePot;
            case TrailColor.RED: return this.redPot;
            case TrailColor.GREEN: return this.greenPot;
            default: return this.redPot;
        }
    }

    private _resetSpriteColor(view: SymbolView): void {
        const sprite = view.node.getComponent(Sprite)
            ?? view.node.getComponentInChildren(Sprite);
        if (sprite) sprite.color = Color.WHITE;
    }

    private _flyDuration(): number {
        switch (AutoSpinManager.instance.speedMode) {
            case SpeedMode.TURBO: return this.flyDurationTurbo;
            case SpeedMode.QUICK: return this.flyDurationQuick;
            default: return this.flyDurationNormal;
        }
    }

    private _spawnFromTemplate(): Node | null {
        if (!this.particleTemplate?.isValid) {
            Log.e('[CarnivalTrail] particleTemplate NULL — kéo child template vào slot');
            return null;
        }
        const fromPool = !!(this.flyFxPoolEnabled && this._flyFxPool && this._flyFxPool.size() > 0);
        const clone = fromPool ? this._flyFxPool!.get()! : instantiate(this.particleTemplate);
        clone.name = `CarnivalTrailFly_${Date.now() % 100000}`;
        clone.active = false;
        if (!fromPool) {
            for (const ps of clone.getComponentsInChildren(ParticleSystem)) {
                if ('playOnAwake' in ps) {
                    (ps as unknown as { playOnAwake: boolean }).playOnAwake = false;
                }
            }
        }
        return clone;
    }

    private _playParticleSystems(root: Node): void {
        const systems = root.getComponentsInChildren(ParticleSystem);
        if (systems.length === 0) {
            Log.e(`[CarnivalTrail] template "${root.name}" không có ParticleSystem — vẫn bay node/Sprite nếu có`);
        }
        for (const ps of systems) {
            if (!ps.isValid || !ps.enabled) continue;
            try {
                this._restoreParticleEmission(ps);
                ps.loop = true;
                if ('prewarm' in ps) {
                    (ps as unknown as { prewarm: boolean }).prewarm = false;
                }
                if ('_prewarm' in ps) {
                    (ps as unknown as { _prewarm: boolean })._prewarm = false;
                }
                const nodeName = ps.node.name;
                const isQilin = this._matchesParticlePrefix(nodeName, this.particleHitLoopOffPrefixes);
                const trail = (ps as unknown as {
                    trailModule?: { enable?: boolean; _enable?: boolean };
                }).trailModule;
                const hasTrail = !!(trail?.enable ?? trail?._enable);
                // qilin*: luôn stop+clear+play — trailModule thường tắt; tránh state cũ từ pool.
                if (isQilin || !hasTrail) {
                    ps.stop();
                    const maybeClear = (ps as unknown as { clear?: () => void }).clear;
                    if (maybeClear) maybeClear.call(ps);
                    ps.play();
                } else if (!ps.isPlaying) {
                    ps.play();
                }
            } catch (err) {
                Log.e('[CarnivalTrail] play particle failed:', err);
            }
        }
    }

    private _clearParticles(): void {
        for (const p of this._activeParticles) {
            if (p?.isValid) this._recycleFlyFx(p);
        }
        this._activeParticles.length = 0;
        this._coinClusterByFx.clear();
    }
}
