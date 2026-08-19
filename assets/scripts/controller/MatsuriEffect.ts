/**
 * MatsuriEffect — VFX Matsuri (seed + collect).
 *
 * TIMELINE
 *  A) VÀO FEATURE (SEED)
 *     bắn orb lần lượt xuống reel → sticky vàng hiện đủ
 *     → nhún highlight song song lệch pha (L→R, trên→dưới) → SEED_DONE → spin
 *  B) GREEN LAND (COLLECT)
 *     nhún sticky vàng → clone vàng hút tiền về UI tổng
 *     → đồng thời nhún các Green (trước khi lật)
 *     → flip Green→Gold + hiện CreditLabel
 *
 * INSPECTOR: seedSourceNode / seedOrbTemplate / collectTargetNode
 * TIMING: const bên dưới là mốc Normal. Quick/Turbo nhân getTimingMultiplier()
 * (0.8 / 0.6) — cùng hệ số TopUp reel / absorb, không đổi logic event.
 */

import {
    _decorator, Component, Node, tween, Vec3, Tween, NodePool,
    UITransform, UIOpacity, isValid, instantiate, ParticleSystem, Sprite, Camera,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { StickyCell, SymbolId } from '../data/SlotTypes';
import {
    MATSURI_GOLD_SYMBOL,
    clampMatsuriRows,
    matsuriGridFitScale,
    matsuriCellSize,
    MATSURI_CELL_SIZE,
} from '../data/MatsuriGridUtil';
import { SpriteNumber } from '../core/SpriteNumber';
import { StickyOverlayController } from './StickyOverlayController';
import { StickyFillEffect } from './StickyFillEffect';
import { TopUpAbsorbEffect } from './TopUpAbsorbEffect';
import { TopUpManager } from './TopUpManager';
import { TOPUP_STICKY_SYMBOL_SCALE, GRID_MINI_COIN_SIZE } from './TopUpReelController';
import { SymbolView } from './SymbolView';
import { SoundManager } from '../manager/SoundManager';
import { AutoSpinManager } from '../manager/AutoSpinManager';

const { ccclass, property } = _decorator;

// ═══════════════════════════════════════════════════════════════════════════════
// TIMING — SEED khớp StickyFillEffect (đường bay / tốc độ / scale-in particle).
// Ưu tiên đọc từ StickyFillEffect trên scene nếu có.
// ═══════════════════════════════════════════════════════════════════════════════

// ── A) SEED hop (đoạn rơi dùng seedOrbSpeed, không dùng duration cố định)
/** Hop lên trước khi rơi (world Y). */
const SEED_ORB_HOP_Y = 60;
/** Thời gian hop. */
const SEED_ORB_HOP_DURATION = 0.12;
const SEED_ORB_SCALE_IN_DURATION = 0.18;
/** ★ Delay giữa LẦN BẮT ĐẦU bắn 2 quả cầu (bay song song, không chờ land). */
const SEED_ORB_LAUNCH_INTERVAL = 0.4;
/** ★ Vận tốc rơi quả cầu Seed → ô StickyOverlay (px/s). Lớn = bay nhanh. */
const SEED_ORB_SPEED = 620;

/** Camera 3D vẽ Circle-Light (layer DEFAULT). Mặc định scene: pos (960,540) = tâm 1920×1080 gốc trái. */
const PARTICLE_3D_CAMERA_NAME = 'Particle3DCamera';

// ── B) HIGHLIGHT — nhún sticky vàng song song, lệch pha (sau seed / trước bay tiền)
/** ★ Hay chỉnh: cách bao lâu thì BẮT ĐẦU nhún sticky kế (song song, không chờ xong). */
const HIGHLIGHT_STAGGER = 0.05;
/** Trần thời điểm sticky CUỐI bắt đầu nhún — grid gần đầy thì nén stagger lại. */
const HIGHLIGHT_LAUNCH_WINDOW = 0.5;
/** Thời lượng 1 nhún của 1 sticky (scale+nhảy Y rồi settle). */
const HIGHLIGHT_BOUNCE_DURATION = 0.5;
/** Độ cao nhảy Y (pixel) khi nhún. */
const HIGHLIGHT_JUMP_Y = 16;
/** Nghỉ ngắn sau khi nhún hết tất cả, trước khi clone bay tiền. */
const DELAY_BEFORE_FLY = 0.04;

// ── C) FLY — clone sticky vàng bay về UI tổng tiền ────────────────────────────
/** Fallback vận tốc clone vàng (px/s). */
const FLY_SPEED = 800;
/** ★ Hay chỉnh: cách bao lâu thì BẮT ĐẦU bay clone kế (song song, lệch pha). */
const FLY_STAGGER = 0.2;
/**
 * Trần thời điểm clone CUỐI bắt đầu bay (s). 20 Gold × 0.2s = 3.4s chỉ để phóng hết
 * → mỗi lượt có Green đứng ~6s. Nén stagger để tổng luôn nằm trong cửa sổ này.
 */
const FLY_LAUNCH_WINDOW = 1.0;
/** Co scale ngắn lúc sắp chạm UI — giữ nguyên size suốt đường bay. */
const FLY_SHRINK_DURATION = 0.12;
/** Cooldown SFX khi clone tới đích — tránh playOneShot chồng theo số lượng Gold. */
const FLY_ARRIVE_SFX_COOLDOWN = 0.2;

@ccclass('MatsuriEffect')
export class MatsuriEffect extends Component {

    // ── Node refs (gán 1 lần) ─────────────────────────────────────────────────

    @property({
        type: Node,
        tooltip: 'Điểm xuất phát bắn Start Gold vào grid khi vào Matsuri.',
    })
    seedSourceNode: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Template object bay seed (active=false). Trống → clone seedSourceNode.',
    })
    seedOrbTemplate: Node | null = null;

    @property({
        type: Node,
        tooltip: 'UI đích nhận tiền khi collect Gold (StickyOverlay CollectTotal). Để trống → tự lấy từ overlay.',
    })
    collectTargetNode: Node | null = null;

    @property({
        type: SpriteNumber,
        tooltip: 'SpriteNumber tổng tiền — pulse khi nhận credit (optional).',
    })
    collectTotalSpriteNumber: SpriteNumber | null = null;

    @property({
        type: StickyOverlayController,
        tooltip: 'StickyOverlay — wire runtime; có thể để trống.',
    })
    stickyOverlay: StickyOverlayController | null = null;

    @property({
        type: TopUpAbsorbEffect,
        tooltip: 'Optional fly layer (UITransform).',
    })
    topUpAbsorbEffect: TopUpAbsorbEffect | null = null;

    // ── State ─────────────────────────────────────────────────────────────────

    private _seedBusy = false;
    private _collectBusy = false;
    private _collectCells: StickyCell[] = [];
    private _totalBaseScale = new Vec3(1, 1, 1);
    private _activeClones: Node[] = [];
    private _activeOrbs: Node[] = [];
    /** Pool orb seed — tránh destroy ParticleSystem mỗi lần land (giật Editor). */
    private _orbPool = new NodePool();
    /** Cache TopUpManager — không scan scene mỗi orb. */
    private _cachedTopUpMgr: TopUpManager | null = null;
    /** Thời điểm (Date.now) lần cuối play SFX tới đích — throttle theo FLY_ARRIVE_SFX_COOLDOWN. */
    private _lastFlyArriveSfxAt = 0;

    /** NORMAL=1, QUICK=0.8, TURBO=0.6 — cùng TopUpManager / TopUpAbsorbEffect. */
    private get _tm(): number {
        return AutoSpinManager.instance?.getTimingMultiplier() ?? 1;
    }

    /** Duration không về 0 (tween 0s dễ skip callback / failsafe đua). */
    private _dur(sec: number): number {
        return Math.max(0.02, sec * this._tm);
    }

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.MATSURI_SEED_START, this._onSeedStart, this);
        bus.on(GameEvents.MATSURI_COLLECT_START, this._onCollectStart, this);
        bus.on(GameEvents.CARNIVAL_MATSURI_START, this._onMatsuriStart, this);
        bus.on(GameEvents.CARNIVAL_MATSURI_END, this._onMatsuriEnd, this);
        if (this.seedOrbTemplate) this.seedOrbTemplate.active = false;
    }

    onDestroy(): void {
        this._cleanupAll();
        this._drainOrbPool();
        EventBus.instance.offTarget(this);
    }

    /** StickyOverlayLoader gọi 1 lần sau load overlay. */
    bindStickyOverlay(overlay: StickyOverlayController | null): void {
        this.stickyOverlay = overlay;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    private _onMatsuriStart(): void {
        this._seedBusy = false;
        this._collectBusy = false;
        this._collectCells = [];
        this.unscheduleAllCallbacks();
        this._cleanupAll();
        this._resolveRefs();
        if (this.collectTotalSpriteNumber?.node) {
            this._totalBaseScale = this.collectTotalSpriteNumber.node.scale.clone();
        }
    }

    private _onMatsuriEnd(): void {
        this._seedBusy = false;
        this._collectBusy = false;
        this._collectCells = [];
        this.stickyOverlay?.setMatsuriDeferGoldLandBounce(false);
        this.unscheduleAllCallbacks();
        this._cleanupAll();
    }

    private _resolveRefs(): void {
        if (!this.stickyOverlay) {
            this.stickyOverlay =
                this.node.scene?.getComponentInChildren(StickyOverlayController) ?? null;
        }
        if (!this.topUpAbsorbEffect) {
            this.topUpAbsorbEffect =
                this.node.scene?.getComponentInChildren(TopUpAbsorbEffect) ?? null;
        }
        this._cachedTopUpMgr =
            this.stickyOverlay?.node?.getComponentInChildren(TopUpManager)
            ?? this.node.scene?.getComponentInChildren(TopUpManager)
            ?? null;
        const overlayTarget = this.stickyOverlay?.getCollectTargetNode() ?? null;
        if (overlayTarget?.isValid) {
            this.collectTargetNode = overlayTarget;
        }
        const overlaySN = this.stickyOverlay?.getCollectTotalSpriteNumber() ?? null;
        if (overlaySN) {
            this.collectTotalSpriteNumber = overlaySN;
        }
        if (this.collectTotalSpriteNumber?.node?.isValid) {
            this._totalBaseScale = this.collectTotalSpriteNumber.node.scale.clone();
        }
        // seedSourceNode gán sẵn trên MatsuriEffect (node Seed) — không fallback Pot.
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  SEED — vào feature
    // ═══════════════════════════════════════════════════════════════════════════

    private _onSeedStart(payload: { cells?: StickyCell[] }): void {
        if (this._seedBusy) {
            return;
        }
        this._resolveRefs();

        const cells = this._sortLeftRightTopBottom(payload?.cells ?? []);

        if (cells.length === 0) {
            EventBus.instance.emit(GameEvents.MATSURI_SEED_DONE);
            return;
        }

        this._seedBusy = true;
        this._clearOrbs();
        void this._runSeedSequence(cells);
    }

    /**
     * Seed: bắn song song lệch pha theo SEED_ORB_LAUNCH_INTERVAL
     * (không chờ orb trước land xong). Bay/land giống StickyFillEffect.
     * Tất cả land xong → highlight → SEED_DONE.
     */
    private async _runSeedSequence(cells: StickyCell[]): Promise<void> {
        this.stickyOverlay?.setMatsuriDeferGoldLandBounce(true);
        try {
            this.stickyOverlay?.alignPositionsFromTopUpManager();
            this._syncParticle3DCamera();
            const fill = this._stickyFillRef();
            const popDur = this.stickyOverlay?.matsuriSeedPopDuration ?? this._dur(0.22);

            // Orb i bắt đầu sau i * interval — bay song song
            const jobs: Promise<void>[] = [];
            const launchInterval = this._dur(SEED_ORB_LAUNCH_INTERVAL);
            for (let i = 0; i < cells.length; i++) {
                const delay = i * launchInterval;
                const cell = cells[i];
                jobs.push(
                    this._wait(delay).then(() => this._seedLaunchOneLikeFill(cell, fill)),
                );
            }
            await Promise.all(jobs);
            // Chờ pop của quả cuối (land gần nhất) settle
            await this._wait(popDur + this._dur(0.08));

            await this._phaseHighlightStaggered(cells);

            this.stickyOverlay?.snapActiveCoinsToReelRest();
            await this._wait(this._dur(0.2));
        } catch {
            // seed failsafe
        }
        this.stickyOverlay?.setMatsuriDeferGoldLandBounce(false);
        this._seedBusy = false;
        this._clearOrbs();
        EventBus.instance.emit(GameEvents.MATSURI_SEED_DONE);
    }

    private _stickyFillRef(): StickyFillEffect | null {
        return this.node.scene?.getComponentInChildren(StickyFillEffect) ?? null;
    }

    /** Orb template: seedOrbTemplate → StickyFillEffect.orbTemplate → seedSource. */
    private _seedOrbTemplate(): Node | null {
        if (this.seedOrbTemplate?.isValid) return this.seedOrbTemplate;
        const fillTmpl = this._stickyFillRef()?.orbTemplate;
        if (fillTmpl?.isValid) return fillTmpl;
        return this.seedSourceNode?.isValid ? this.seedSourceNode : null;
    }

    /**
     * Bay 1 orb từ Seed → ô StickyOverlay.
     * Seed.x = 0 là TÂM SlotMachine (anchor 0.5), không phải mép trái.
     * Parent cùng MatsuriEffect với Seed — copy Seed.position, không convert qua layer khác.
     */
    private async _seedLaunchOneLikeFill(
        cell: StickyCell,
        fill: StickyFillEffect | null,
    ): Promise<void> {
        const srcNode = this._resolveSeedSourceNode();
        const dstNode = this.stickyOverlay?.getCoinSlot(cell.reel, cell.row) ?? null;
        const tmpl = this._seedOrbTemplate();
        const selfUT = this.node.getComponent(UITransform);
        if (!srcNode?.isValid || !dstNode || !tmpl || !selfUT) {
            this._seedPlaceCell(cell, true);
            return;
        }

        this._syncParticle3DCamera();
        this.node.updateWorldTransform();
        srcNode.updateWorldTransform();
        dstNode.updateWorldTransform();

        // Cùng parent với Seed → x=0 là giữa SlotMachine. Không dùng getWorldPosition.
        const start = srcNode.parent === this.node
            ? srcNode.position.clone()
            : selfUT.convertToNodeSpaceAR(srcNode.getWorldPosition());
        start.z = 0;

        const hop = new Vec3(start.x, start.y + SEED_ORB_HOP_Y, 0);
        const end = selfUT.convertToNodeSpaceAR(this._seedTargetWorld(cell, dstNode));
        end.z = 0;

        const hopDur = this._dur(SEED_ORB_HOP_DURATION);
        const scaleIn = this._dur(fill?.orbScaleInDuration ?? SEED_ORB_SCALE_IN_DURATION);
        const fit = this._reelFitScale();
        const fallDur = this._durationFromSpeed(hop, end, SEED_ORB_SPEED);

        SoundManager.instance?.playSfxByName('sxPotHit');

        const orb = this._acquireOrb(tmpl);
        this._resetOrbRootScale(orb, tmpl, fit);
        const childScales = this._prepareOrbChildrenScaleIn(orb, tmpl, fit);
        orb.setPosition(start.x, start.y, 0);
        orb.setRotationFromEuler(0, 0, 0);
        orb.active = true;
        this._playOrbParticles(orb);
        this._activeOrbs.push(orb);

        await new Promise<void>(resolve => {
            const moveTw = tween(orb)
                .to(hopDur, { position: hop })
                .to(fallDur, { position: end }, { easing: 'quadIn' });

            for (const { node, endScale } of childScales) {
                tween(node)
                    .to(Math.max(0.01, scaleIn), { scale: endScale }, { easing: 'sineOut' })
                    .start();
            }

            moveTw
                .call(() => {
                    this._hideOrbForReuse(orb);
                    this._seedPlaceCell(cell, true);
                    this.scheduleOnce(() => this._releaseOrbToPool(orb, tmpl), 0);
                    resolve();
                })
                .start();
        });
    }

    /**
     * Particle3DCamera mặc định (960, 540) — tâm canvas 1920×1080 theo gốc TRÁI.
     * Camera UI ở (0, 0) — tâm SlotMachine. Portrait không sync → particle x=0 vẽ ở mép trái.
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

    /** Marker Seed dưới MatsuriEffect — không dùng Pot (StickyFill). */
    private _resolveSeedSourceNode(): Node | null {
        if (this.seedSourceNode?.isValid) return this.seedSourceNode;
        return this._seedOrbTemplate();
    }

    /** Thời gian bay = quãng đường / vận tốc (px/s), rồi nhân speed mode. */
    private _durationFromSpeed(from: Vec3, to: Vec3, speed: number, minDur = 0.25, maxDur = 3): number {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dz = to.z - from.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const v = Math.max(1, speed);
        return this._dur(Math.min(maxDur, Math.max(minDur, dist / v)));
    }

    /** Tỉ lệ scale StickyOverlay / grid fit (đồng bộ reel thu nhỏ). */
    private _reelFitScale(): number {
        const overlayS = this.stickyOverlay?.node?.scale?.x;
        if (overlayS != null && overlayS > 0.01) return overlayS;
        return matsuriGridFitScale(clampMatsuriRows(GameData.instance.matsuriRows || 3));
    }

    private _seedTargetWorld(cell: StickyCell, fallbackSlot: Node): Vec3 {
        const rows = clampMatsuriRows(GameData.instance.matsuriRows || 3);
        const idx = cell.reel * rows + cell.row;
        if (!this._cachedTopUpMgr?.isValid) {
            this._cachedTopUpMgr =
                this.stickyOverlay?.node?.getComponentInChildren(TopUpManager)
                ?? this.node.scene?.getComponentInChildren(TopUpManager)
                ?? null;
        }
        const reel = this._cachedTopUpMgr?.reels?.[idx];
        if (reel) {
            return reel.getMidRestWorldPosition();
        }
        fallbackSlot.updateWorldTransform();
        return fallbackSlot.worldPosition.clone();
    }

    private _seedPlaceCell(cell: StickyCell, _emitTotal: boolean): void {
        const data = GameData.instance;
        data.stickyCells.set(`${cell.reel}-${cell.row}`, { ...cell });
        // Reveal trước (visual) — lock reel frame sau để khỏi spike cùng frame với pop
        SoundManager.instance?.playSfxByName('sxBonusStickyGoldLand');
        this.stickyOverlay?.revealMatsuriSeedCoin(cell);
        const payload = { ...cell };
        this.scheduleOnce(() => {
            EventBus.instance.emit(GameEvents.MATSURI_SEED_CELL, payload);
        }, 0);
    }

    private _resetOrbRootScale(orb: Node, tmpl: Node, _fit: number = 1): void {
        // Root giữ tỉ lệ template; fit áp vào child particle (scaleSpace Local)
        orb.setScale(tmpl.scale);
    }

    /**
     * Child Particle: scale 0.01 → (template × reelFit).
     * scaleSpace=Local — scale node ảnh hưởng particle size.
     */
    private _prepareOrbChildrenScaleIn(
        orb: Node,
        tmpl: Node,
        fit: number = 1,
    ): { node: Node; endScale: Vec3 }[] {
        const result: { node: Node; endScale: Vec3 }[] = [];
        const templateChildren = tmpl.children ?? [];
        const f = Math.max(0.05, fit);
        for (let i = 0; i < orb.children.length; i++) {
            const child = orb.children[i];
            if (!child?.isValid) continue;
            Tween.stopAllByTarget(child);
            const tChild = templateChildren[i];
            const base = tChild?.isValid
                ? tChild.scale.clone()
                : (child.scale.x === 0 && child.scale.y === 0
                    ? new Vec3(50, 50, 50)
                    : child.scale.clone());
            const endScale = new Vec3(base.x * f, base.y * f, base.z * f);
            for (const ps of child.getComponents(ParticleSystem)) {
                (ps as ParticleSystem & { scaleSpace: number }).scaleSpace = 0;
                ps.stop();
                ps.clear();
            }
            child.setScale(0.01, 0.01, 0.01);
            result.push({ node: child, endScale });
        }
        return result;
    }

    private _playOrbParticles(root: Node): void {
        for (const child of root.children) {
            if (!child?.isValid) continue;
            child.active = true;
            for (const ps of child.getComponents(ParticleSystem)) {
                (ps as ParticleSystem & { scaleSpace: number }).scaleSpace = 0;
                ps.stop();
                ps.clear();
                ps.play();
            }
        }
    }

    private _restoreOrbChildrenScale(orb: Node, tmpl: Node): void {
        const templateChildren = tmpl.children ?? [];
        for (let i = 0; i < orb.children.length; i++) {
            const child = orb.children[i];
            if (!child?.isValid) continue;
            Tween.stopAllByTarget(child);
            const tChild = templateChildren[i];
            if (tChild?.isValid) child.setScale(tChild.scale);
        }
    }

    private _stopAllChildParticles(root: Node): void {
        for (const ps of root.getComponentsInChildren(ParticleSystem)) {
            ps.stop();
            ps.clear();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  COLLECT — Green land → bay Gold về UI
    // ═══════════════════════════════════════════════════════════════════════════

    private _onCollectStart(payload: { goldCells?: StickyCell[] }): void {
        if (this._collectBusy) {
            return;
        }
        this._resolveRefs();
        this._cleanupClones();

        const cells = this._sortLeftRightTopBottom(
            (payload?.goldCells ?? [])
                .filter(c =>
                    (c.symbolId === MATSURI_GOLD_SYMBOL || c.symbolId === SymbolId.STICKY_YELLOW)
                    && (c.credit ?? 0) > 0,
                )
                .filter((c, i, arr) =>
                    arr.findIndex(t => t.reel === c.reel && t.row === c.row) === i,
                ),
        );

        if (cells.length === 0) {
            EventBus.instance.emit(GameEvents.MATSURI_COLLECT_DONE);
            return;
        }
        if (!this.collectTargetNode?.isValid) {
            for (const c of cells) {
                EventBus.instance.emit(GameEvents.MATSURI_COLLECT_CREDIT, { credit: c.credit ?? 0 });
            }
            EventBus.instance.emit(GameEvents.MATSURI_COLLECT_DONE);
            return;
        }

        this._collectBusy = true;
        this._collectCells = cells;
        void this._runCollectSequence();
    }

    /**
     * Collect: vàng nhún → hút tiền về UI; Green nhún trong lúc vàng bay; rồi flip.
     */
    private async _runCollectSequence(): Promise<void> {
        try {
            await this._phaseHighlightStaggered(this._collectCells);
            if (DELAY_BEFORE_FLY > 0) await this._wait(this._dur(DELAY_BEFORE_FLY));
            const fly = this._phaseFlyAll();
            await Promise.all([fly, this._phaseBounceGreensUntil(fly)]);
        } catch {
            // collect failsafe
        }
        this._stopGreenCollectBounce();
        this._collectBusy = false;
        this._cleanupClones();
        try {
            EventBus.instance.emit(GameEvents.MATSURI_COLLECT_DONE);
        } catch {
            EventBus.instance.emit(GameEvents.MATSURI_FLIP_DONE);
        }
    }

    private _getGreenStickyCells(): StickyCell[] {
        const greens: StickyCell[] = [];
        for (const cell of GameData.instance.stickyCells.values()) {
            if (cell.symbolId === SymbolId.STICKY_GREEN) greens.push(cell);
        }
        return this._sortLeftRightTopBottom(greens);
    }

    /** Green nhún liên tục khi vàng đang hút tiền — dừng khi fly xong. */
    private async _phaseBounceGreensUntil(until: Promise<void>): Promise<void> {
        const greens = this._getGreenStickyCells();
        if (greens.length === 0) {
            await until;
            return;
        }
        let finished = false;
        const mark = until.then(() => { finished = true; });
        while (!finished && this._collectBusy) {
            await this._phaseHighlightStaggered(greens);
        }
        await mark;
        this._stopGreenCollectBounce(greens);
    }

    private _stopGreenCollectBounce(cells?: StickyCell[]): void {
        const greens = cells ?? this._getGreenStickyCells();
        for (const cell of greens) {
            const node = this.stickyOverlay?.getCoinSlot(cell.reel, cell.row);
            if (node?.isValid) Tween.stopAllByTarget(node);
        }
        this.stickyOverlay?.snapActiveCoinsToReelRest();
    }

    /**
     * Nhún song song: sticky i bắt đầu sau i * HIGHLIGHT_STAGGER (không chờ bounce xong).
     * Thứ tự bắt đầu: L→R, trên→dưới.
     */
    private async _phaseHighlightStaggered(cells: StickyCell[]): Promise<void> {
        if (cells.length === 0) return;
        const stagger = this._staggerFor(cells.length, HIGHLIGHT_STAGGER, HIGHLIGHT_LAUNCH_WINDOW);
        const jobs: Promise<void>[] = [];
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            const delay = i * stagger;
            jobs.push(
                this._wait(delay).then(async () => {
                    const src = this.stickyOverlay?.getCoinSlot(cell.reel, cell.row) ?? null;
                    if (src?.active && isValid(src)) await this._bounceStickyLikeTopUp(src);
                    else await this._wait(this._dur(HIGHLIGHT_BOUNCE_DURATION));
                }),
            );
        }
        await Promise.all(jobs);
    }

    /**
     * Nhún giống TopUp sticky handoff.
     * Curve gốc TopUp: grow 0.08 + hold 0.12 + shrink 0.32 (= 0.52).
     */
    private _bounceStickyLikeTopUp(node: Node): Promise<void> {
        return new Promise(resolve => {
            if (!isValid(node)) {
                resolve();
                return;
            }
            const total = this._dur(HIGHLIGHT_BOUNCE_DURATION);
            const growDur = total * (0.08 / 0.52);
            const holdDur = total * (0.12 / 0.52);
            const shrinkDur = total * (0.32 / 0.52);
            const baseScale = 1;
            const startS = TOPUP_STICKY_SYMBOL_SCALE; // 0.85
            const peakS = baseScale * 1.12;

            const basePos = node.position.clone();
            const peakPos = new Vec3(basePos.x, basePos.y + HIGHLIGHT_JUMP_Y, basePos.z);

            Tween.stopAllByTarget(node);

            node.setScale(startS, startS, 1);
            node.setPosition(basePos);
            tween(node)
                .to(growDur, {
                    scale: new Vec3(peakS, peakS, 1),
                    position: peakPos,
                }, { easing: 'sineOut' })
                .delay(holdDur)
                .to(shrinkDur, {
                    scale: new Vec3(baseScale, baseScale, 1),
                    position: basePos.clone(),
                }, { easing: 'sineIn' })
                .call(() => {
                    if (isValid(node)) {
                        node.setPosition(basePos);
                        node.setScale(baseScale, baseScale, 1);
                    }
                    resolve();
                })
                .start();
        });
    }

    private async _phaseFlyAll(): Promise<void> {
        // Trail bay lên: 1 lần / wave (không play theo từng clone)
        SoundManager.instance?.playBonusTrail();
        this._lastFlyArriveSfxAt = 0;

        const stagger = this._staggerFor(this._collectCells.length, FLY_STAGGER, FLY_LAUNCH_WINDOW);
        const jobs: Promise<void>[] = [];
        for (let i = 0; i < this._collectCells.length; i++) {
            const cell = this._collectCells[i];
            const delay = i * stagger;
            jobs.push(this._wait(delay).then(() => this._flyCloneOne(cell)));
        }
        await Promise.all(jobs);
    }

    /**
     * Stagger giữ nguyên khi ít sticky; grid gần đầy thì nén để tổng thời gian
     * phóng không vượt `windowMax` (tránh mỗi lượt Green đứng nhiều giây).
     */
    private _staggerFor(count: number, base: number, windowMax: number): number {
        if (count <= 1) return this._dur(base);
        return this._dur(Math.min(base, windowMax / (count - 1)));
    }

    /** Trái → phải, trên → dưới (row 0 = top). */
    private _sortLeftRightTopBottom(cells: StickyCell[]): StickyCell[] {
        return [...cells].sort((a, b) =>
            a.reel !== b.reel ? a.reel - b.reel : a.row - b.row,
        );
    }

    private _flyCloneOne(cell: StickyCell): Promise<void> {
        return new Promise(resolve => {
            const credit = cell.credit ?? 0;
            let resolved = false;
            const finish = () => {
                if (resolved) return;
                resolved = true;
                this._playFlyArriveSfx();
                EventBus.instance.emit(GameEvents.MATSURI_COLLECT_CREDIT, { credit });
                this._pulseTotal();
                resolve();
            };

            const srcNode = this.stickyOverlay?.getCoinSlot(cell.reel, cell.row) ?? null;
            const dst = this.collectTargetNode;
            if (!srcNode?.active || !dst?.isValid) {
                finish();
                return;
            }

            const layer = this._flyLayer();
            if (!layer) {
                finish();
                return;
            }
            const layerUT = layer.getComponent(UITransform)!;

            const clone = instantiate(srcNode);
            clone.name = `MatsuriGoldFly_${cell.reel}_${cell.row}`;
            clone.setParent(layer);
            clone.setSiblingIndex(layer.children.length - 1);
            clone.active = true;

            const start = layerUT.convertToNodeSpaceAR(srcNode.getWorldPosition());
            const end = layerUT.convertToNodeSpaceAR(dst.getWorldPosition());
            const startScale = this._syncFlyCloneVisual(clone, srcNode, layer);
            clone.setPosition(start.x, start.y, 0);
            clone.setRotationFromEuler(0, 0, 0);

            let op = clone.getComponent(UIOpacity);
            if (!op) op = clone.addComponent(UIOpacity);
            op.opacity = 255;

            this._activeClones.push(clone);

            const flyDur = this._durationFromSpeed(start, end, FLY_SPEED);
            const shrinkDur = Math.min(this._dur(FLY_SHRINK_DURATION), flyDur * 0.35);
            const holdDur = Math.max(0, flyDur - shrinkDur);

            const failSafe = () => {
                this._destroyClone(clone);
                finish();
            };
            this.scheduleOnce(failSafe, flyDur + this._dur(1.0));

            // Bay full size; chỉ co scale ở đoạn cuối sắp chạm UI
            tween(clone)
                .to(flyDur, {
                    position: new Vec3(end.x, end.y, 0),
                }, { easing: 'sineIn' })
                .call(() => {
                    this.unschedule(failSafe);
                    this._destroyClone(clone);
                    finish();
                })
                .start();

            tween(clone)
                .delay(holdDur)
                .to(shrinkDur, {
                    scale: new Vec3(0.01, 0.01, startScale.z),
                }, { easing: 'sineIn' })
                .call(() => {
                    if (op && isValid(op)) op.opacity = 0;
                })
                .start();
        });
    }

    /** Hit khi clone tới UI tổng — throttle để không chồng theo số Gold. */
    private _playFlyArriveSfx(): void {
        const now = Date.now();
        if (now - this._lastFlyArriveSfxAt < this._dur(FLY_ARRIVE_SFX_COOLDOWN) * 1000) return;
        this._lastFlyArriveSfxAt = now;
        SoundManager.instance?.playSfxByName('sxBonusStickyGoldIncreaseHit');
    }

    /**
     * Clone bay trên fly layer (WaysPayDisplay) — giữ đúng kích thước world của coin gốc.
     * 5×3 dùng cell 182 → contentSize ~280; phải copy size + quy đổi world→local scale.
     */
    private _syncFlyCloneVisual(clone: Node, srcNode: Node, layer: Node): Vec3 {
        const rows = clampMatsuriRows(GameData.instance.matsuriRows || 3);
        const expectedCoin = Math.round(matsuriCellSize(rows) * GRID_MINI_COIN_SIZE / MATSURI_CELL_SIZE);

        const srcUt = srcNode.getComponent(UITransform);
        const cloneUt = clone.getComponent(UITransform);
        if (cloneUt) {
            const cs = srcUt?.contentSize;
            const w = cs && cs.width > 1 ? cs.width : expectedCoin;
            const h = cs && cs.height > 1 ? cs.height : expectedCoin;
            cloneUt.setContentSize(w, h);
        }

        const srcSp = srcNode.getComponent(Sprite);
        const cloneSp = clone.getComponent(Sprite);
        if (srcSp && cloneSp) {
            cloneSp.sizeMode = srcSp.sizeMode;
        }

        const srcWorldScale = new Vec3();
        const layerWorldScale = new Vec3(1, 1, 1);
        srcNode.getWorldScale(srcWorldScale);
        layer.getWorldScale(layerWorldScale);

        const localScale = new Vec3(
            layerWorldScale.x > 0.001 ? srcWorldScale.x / layerWorldScale.x : srcWorldScale.x,
            layerWorldScale.y > 0.001 ? srcWorldScale.y / layerWorldScale.y : srcWorldScale.y,
            layerWorldScale.z > 0.001 ? srcWorldScale.z / layerWorldScale.z : 1,
        );
        if (localScale.x <= 0.01 || localScale.y <= 0.01) {
            const fit = matsuriGridFitScale(rows);
            const overlayS = this.stickyOverlay?.node?.scale?.x ?? fit;
            const local = srcNode.scale;
            const s = Math.max(0.05, overlayS) * Math.max(local.x, 0.05);
            localScale.set(s, s, 1);
        }
        clone.setScale(localScale);
        return localScale;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Collect clone bay trên WaysPayDisplay (z-order trên symbol). */
    private _flyLayer(): Node | null {
        const top = SymbolView.landBounceParent;
        if (top?.isValid && top.getComponent(UITransform)) return top;
        if (this.topUpAbsorbEffect?.node?.isValid
            && this.topUpAbsorbEffect.node.getComponent(UITransform)) {
            return this.topUpAbsorbEffect.node;
        }
        if (this.node.getComponent(UITransform)) return this.node;
        const overlay = this.stickyOverlay?.node;
        if (overlay?.parent?.getComponent(UITransform)) return overlay.parent;
        return overlay ?? null;
    }

    private _pulseTotal(): void {
        const sn = this.collectTotalSpriteNumber;
        if (!sn?.node?.isValid) return;
        try {
            const bs = this._totalBaseScale;
            Tween.stopAllByTarget(sn.node);
            tween(sn.node)
                .to(this._dur(0.07), { scale: new Vec3(bs.x * 1.28, bs.y * 1.28, bs.z) })
                .to(this._dur(0.1), { scale: new Vec3(bs.x, bs.y, bs.z) })
                .start();
        } catch {
            // pulse failsafe
        }
    }

    private _destroyClone(clone: Node): void {
        const idx = this._activeClones.indexOf(clone);
        if (idx >= 0) this._activeClones.splice(idx, 1);
        if (!isValid(clone)) return;
        Tween.stopAllByTarget(clone);
        const op = clone.getComponent(UIOpacity);
        if (op) Tween.stopAllByTarget(op);
        clone.destroy();
    }

    private _acquireOrb(tmpl: Node): Node {
        let orb = this._orbPool.get();
        if (!orb?.isValid) {
            orb = instantiate(tmpl);
            orb.name = 'MatsuriSeedOrb';
        }
        orb.active = false;
        orb.setParent(this.node);
        return orb;
    }

    /** Ẩn orb ngay khi land — không destroy/pool trên cùng frame với reveal sticky. */
    private _hideOrbForReuse(orb: Node): void {
        if (!isValid(orb)) return;
        Tween.stopAllByTarget(orb);
        this._stopAllChildParticles(orb);
        for (const child of orb.children) {
            if (child?.isValid) Tween.stopAllByTarget(child);
        }
        orb.active = false;
    }

    private _releaseOrbToPool(orb: Node, tmpl?: Node | null): void {
        const idx = this._activeOrbs.indexOf(orb);
        if (idx >= 0) this._activeOrbs.splice(idx, 1);
        if (!isValid(orb)) return;
        Tween.stopAllByTarget(orb);
        this._stopAllChildParticles(orb);
        if (tmpl?.isValid) this._restoreOrbChildrenScale(orb, tmpl);
        for (const child of orb.children) {
            if (child?.isValid) Tween.stopAllByTarget(child);
        }
        orb.removeFromParent();
        orb.active = false;
        this._orbPool.put(orb);
    }

    private _clearOrbs(): void {
        const tmpl = this._seedOrbTemplate();
        for (const o of [...this._activeOrbs]) this._releaseOrbToPool(o, tmpl);
        this._activeOrbs.length = 0;
    }

    private _drainOrbPool(): void {
        while (this._orbPool.size() > 0) {
            const n = this._orbPool.get();
            if (n?.isValid) n.destroy();
        }
    }

    private _cleanupClones(): void {
        for (const n of this._activeClones) {
            if (isValid(n)) {
                Tween.stopAllByTarget(n);
                n.destroy();
            }
        }
        this._activeClones.length = 0;
    }

    private _cleanupAll(): void {
        this._cleanupClones();
        this._clearOrbs();
    }

    private _wait(sec: number): Promise<void> {
        return new Promise(resolve => {
            if (sec <= 0) resolve();
            else this.scheduleOnce(resolve, sec);
        });
    }
}
