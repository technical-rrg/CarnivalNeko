/**
 * MatsuriEffect — VFX Matsuri (seed + collect).
 *
 * TIMELINE
 *  A) VÀO FEATURE (SEED)
 *     bắn orb lần lượt xuống reel → sticky vàng hiện đủ
 *     → nhún highlight song song lệch pha (L→R, trên→dưới) → SEED_DONE → spin
 *  B) GREEN LAND (COLLECT)
 *     nhún highlight song song lệch pha các sticky vàng
 *     → clone bay về UI tổng tiền → flip Green→Gold (lúc đó mới hiện CreditLabel)
 *
 * INSPECTOR (chỉ gán node, không chỉnh timing):
 *   seedSourceNode / seedOrbTemplate / collectTargetNode / …
 *
 * TIMING: hardcode const phía dưới — sửa số ở đó.
 */

import {
    _decorator, Component, Node, tween, Vec3, Tween, NodePool,
    UITransform, UIOpacity, isValid, instantiate, ParticleSystem,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { StickyCell, SymbolId } from '../data/SlotTypes';
import {
    MATSURI_GOLD_SYMBOL,
    clampMatsuriRows,
    matsuriGridFitScale,
} from '../data/MatsuriGridUtil';
import { Log } from '../core/Logger';
import { SpriteNumber } from '../core/SpriteNumber';
import { StickyOverlayController } from './StickyOverlayController';
import { StickyFillEffect } from './StickyFillEffect';
import { TopUpAbsorbEffect } from './TopUpAbsorbEffect';
import { TopUpManager } from './TopUpManager';
import { TOPUP_STICKY_SYMBOL_SCALE } from './TopUpReelController';
import { FreeSpinGoldUI } from './FreeSpinGoldUI';
import { SymbolView } from './SymbolView';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

// ═══════════════════════════════════════════════════════════════════════════════
// TIMING — SEED khớp StickyFillEffect (đường bay / tốc độ / scale-in particle).
// Ưu tiên đọc từ StickyFillEffect trên scene nếu có.
// ═══════════════════════════════════════════════════════════════════════════════

// ── A) SEED — khớp StickyFillEffect._launchNextOrb ───────────────────────────
/** Hop lên trước khi rơi (world Y). StickyFillEffect: +60 — KHÔNG × fit. */
const SEED_ORB_HOP_Y = 60;
/** Thời gian hop. StickyFillEffect: 0.1. */
const SEED_ORB_HOP_DURATION = 0.1;
/** Fallback fall duration nếu không có StickyFillEffect.orbFallDuration. */
const SEED_ORB_FALL_DURATION = 0.55;
const SEED_ORB_SCALE_IN_DURATION = 0.18;
/** ★ Delay giữa LẦN BẮT ĐẦU bắn 2 quả cầu (bay song song, không chờ land). */
const SEED_ORB_LAUNCH_INTERVAL = 0.6;

// ── B) HIGHLIGHT — nhún sticky vàng song song, lệch pha (sau seed / trước bay tiền)
/** ★ Hay chỉnh: cách bao lâu thì BẮT ĐẦU nhún sticky kế (song song, không chờ xong). */
const HIGHLIGHT_STAGGER = 0.05;
/** Thời lượng 1 nhún của 1 sticky (scale+nhảy Y rồi settle). */
const HIGHLIGHT_BOUNCE_DURATION = 0.5;
/** Độ cao nhảy Y (pixel) khi nhún. */
const HIGHLIGHT_JUMP_Y = 16;
/** Nghỉ ngắn sau khi nhún hết tất cả, trước khi clone bay tiền. */
const DELAY_BEFORE_FLY = 0.04;

// ── C) FLY — clone sticky vàng bay về UI tổng tiền ────────────────────────────
/** Thời gian 1 clone bay từ ô → UI đích. */
const FLY_DURATION = 0.55;
/** ★ Hay chỉnh: cách bao lâu thì BẮT ĐẦU bay clone kế (song song, lệch pha). */
const FLY_STAGGER = 0.1;
/** Tỉ lệ đường bay trước khi bắt đầu co scale về 0 (0.5 = nửa đường). */
const FLY_SHRINK_START_RATIO = 0.5;
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
        tooltip: 'UI đích nhận tiền khi collect Gold (FreeSpinUI / CoinCount).',
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
        if (!this.collectTargetNode?.isValid) {
            const fsUI = this.node.scene?.getComponentInChildren(FreeSpinGoldUI) ?? null;
            const target = fsUI?.getCollectTargetNode() ?? null;
            if (target?.isValid) {
                this.collectTargetNode = target;
                if (!this.collectTotalSpriteNumber && fsUI?.goldTotalSpriteNumber) {
                    this.collectTotalSpriteNumber = fsUI.goldTotalSpriteNumber;
                }
            }
        }
        // Điểm bắn seed = Pot (StickyFill) — KHÔNG dùng FreeSpinUI (sai đường bay)
        if (!this.seedSourceNode?.isValid) {
            const pot = this._stickyFillRef()?.potNode;
            if (pot?.isValid) {
                this.seedSourceNode = pot;
            } else {
                const potByName = this._findSceneNode('Pot')
                    ?? this._findSceneNode('PotNode')
                    ?? this._findSceneNode('CarnivalPot');
                if (potByName) this.seedSourceNode = potByName;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  SEED — vào feature
    // ═══════════════════════════════════════════════════════════════════════════

    private _onSeedStart(payload: { cells?: StickyCell[] }): void {
        if (this._seedBusy) {
            Log.w('[MatsuriEffect] seed busy — ignore');
            return;
        }
        this._resolveRefs();

        const cells = this._sortLeftRightTopBottom(payload?.cells ?? []);

        Log.e(`[MatsuriEffect:SEED] cells=${cells.length} src=${this.seedSourceNode?.name ?? 'NONE'}`);

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
            const fill = this._stickyFillRef();
            const popDur = this.stickyOverlay?.matsuriSeedPopDuration ?? 0.22;

            // Orb i bắt đầu sau i * interval — bay song song
            const jobs: Promise<void>[] = [];
            for (let i = 0; i < cells.length; i++) {
                const delay = i * SEED_ORB_LAUNCH_INTERVAL;
                const cell = cells[i];
                jobs.push(
                    this._wait(delay).then(() => this._seedLaunchOneLikeFill(cell, fill)),
                );
            }
            await Promise.all(jobs);
            // Chờ pop của quả cuối (land gần nhất) settle
            await this._wait(popDur + 0.08);

            await this._phaseHighlightStaggered(cells);

            this.stickyOverlay?.snapActiveCoinsToReelRest();
            await this._wait(0.2);
        } catch (err) {
            Log.e('[MatsuriEffect:SEED] error', err);
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
     * Bay 1 orb — cùng công thức StickyFillEffect._launchNextOrb:
     *   start (Pot) → hop(+60Y, 0.1s) → fall(orbFallDuration, quadIn) → đích
     * + children particle scale-in (sineOut).
     */
    private async _seedLaunchOneLikeFill(
        cell: StickyCell,
        fill: StickyFillEffect | null,
    ): Promise<void> {
        const dstNode = this.stickyOverlay?.getCoinSlot(cell.reel, cell.row) ?? null;
        // Ưu tiên điểm Pot (StickyFill) để đường bay giống bắn từ Pot
        const srcWorld = this.seedSourceNode?.worldPosition.clone()
            ?? fill?.potNode?.worldPosition.clone()
            ?? this._seedOrbTemplate()?.worldPosition.clone()
            ?? new Vec3();

        if (!dstNode) {
            this._seedPlaceCell(cell, true);
            return;
        }

        // Dest = mid ô TopUp (ổn định hơn coin slot inactive)
        const dstWorld = this._seedTargetWorld(cell, dstNode);
        const tmpl = this._seedOrbTemplate();
        if (!tmpl) {
            this._seedPlaceCell(cell, true);
            return;
        }

        // Timing lấy từ StickyFillEffect trên scene (giống Pot fill)
        const fallDur = fill?.orbFallDuration ?? SEED_ORB_FALL_DURATION;
        const hopDur = SEED_ORB_HOP_DURATION;
        const hopY = SEED_ORB_HOP_Y; // world px — không × grid fit
        const scaleIn = fill?.orbScaleInDuration ?? SEED_ORB_SCALE_IN_DURATION;
        const fit = this._reelFitScale(); // chỉ scale size orb, không đụng đường bay

        SoundManager.instance?.playSfxByName('sxPotHit');

        const orb = this._acquireOrb(tmpl);
        // Root × fit; child particle scale-in tới (template × fit)
        this._resetOrbRootScale(orb, tmpl, fit);
        const childScales = this._prepareOrbChildrenScaleIn(orb, tmpl, fit);
        orb.setWorldPosition(srcWorld);
        orb.active = true;
        this._playOrbParticles(orb);
        this._activeOrbs.push(orb);

        // StickyFill: hop thẳng lên rồi quadIn lao xuống đích (= vòng cung cảm nhận)
        const hop = new Vec3(srcWorld.x, srcWorld.y + hopY, srcWorld.z);

        await new Promise<void>(resolve => {
            const moveTw = tween(orb)
                .to(hopDur, { worldPosition: hop })
                .to(fallDur, { worldPosition: dstWorld }, { easing: 'quadIn' });

            for (const { node, endScale } of childScales) {
                tween(node)
                    .to(Math.max(0.01, scaleIn), { scale: endScale }, { easing: 'sineOut' })
                    .start();
            }

            moveTw
                .call(() => {
                    // Ẩn orb trước → hiện sticky → trả pool frame sau (tránh spike destroy+reveal cùng frame)
                    this._hideOrbForReuse(orb);
                    this._seedPlaceCell(cell, true);
                    this.scheduleOnce(() => this._releaseOrbToPool(orb, tmpl), 0);
                    resolve();
                })
                .start();
        });
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
                (ps as any).scaleSpace = 0;
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
                (ps as any).scaleSpace = 0;
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
            Log.w('[MatsuriEffect] collect busy — ignore');
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

        Log.e(`[MatsuriEffect:COLLECT] golds=${cells.length} target=${this.collectTargetNode?.name ?? 'NONE'}`);

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
     * Collect: vàng đã sẵn trên reel → nhún song song lệch pha → bay tiền.
     */
    private async _runCollectSequence(): Promise<void> {
        try {
            await this._phaseHighlightStaggered(this._collectCells);
            if (DELAY_BEFORE_FLY > 0) await this._wait(DELAY_BEFORE_FLY);
            await this._phaseFlyAll();
        } catch (err) {
            Log.e('[MatsuriEffect:COLLECT] error', err);
        }
        this._collectBusy = false;
        this._cleanupClones();
        EventBus.instance.emit(GameEvents.MATSURI_COLLECT_DONE);
    }

    /**
     * Nhún song song: sticky i bắt đầu sau i * HIGHLIGHT_STAGGER (không chờ bounce xong).
     * Thứ tự bắt đầu: L→R, trên→dưới.
     */
    private async _phaseHighlightStaggered(cells: StickyCell[]): Promise<void> {
        if (cells.length === 0) return;
        const jobs: Promise<void>[] = [];
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            const delay = i * HIGHLIGHT_STAGGER;
            jobs.push(
                this._wait(delay).then(async () => {
                    const src = this.stickyOverlay?.getCoinSlot(cell.reel, cell.row) ?? null;
                    if (src?.active && isValid(src)) await this._bounceStickyLikeTopUp(src);
                    else await this._wait(HIGHLIGHT_BOUNCE_DURATION);
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
            const total = HIGHLIGHT_BOUNCE_DURATION;
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

        const jobs: Promise<void>[] = [];
        for (let i = 0; i < this._collectCells.length; i++) {
            const cell = this._collectCells[i];
            const delay = i * FLY_STAGGER;
            jobs.push(this._wait(delay).then(() => this._flyCloneOne(cell)));
        }
        await Promise.all(jobs);
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
            // Clone ra layer ngoài StickyOverlay → mất parent scale; dùng world/grid fit scale.
            const startScale = this._flyCloneStartScale(srcNode);
            clone.setPosition(start.x, start.y, 0);
            clone.setScale(startScale);
            clone.setRotationFromEuler(0, 0, 0);

            let op = clone.getComponent(UIOpacity);
            if (!op) op = clone.addComponent(UIOpacity);
            op.opacity = 255;

            this._activeClones.push(clone);

            const flyDur = FLY_DURATION;
            const shrinkRatio = Math.min(0.9, Math.max(0.1, FLY_SHRINK_START_RATIO));
            const holdDur = flyDur * shrinkRatio;
            const shrinkDur = flyDur * (1 - shrinkRatio);

            const failSafe = () => {
                this._destroyClone(clone);
                finish();
            };
            this.scheduleOnce(failSafe, flyDur + 1.0);

            // Bay cả chặng; từ nửa đường co scale → 0 (song song với đoạn bay còn lại)
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
        if (now - this._lastFlyArriveSfxAt < FLY_ARRIVE_SFX_COOLDOWN * 1000) return;
        this._lastFlyArriveSfxAt = now;
        SoundManager.instance?.playSfxByName('sxBonusStickyGoldIncreaseHit');
    }

    /**
     * Scale clone lúc bay = world scale của sticky (đã gồm StickyOverlay fit 5×4/5×5).
     * Fallback: matsuriGridFitScale(rows) × local scale.
     */
    private _flyCloneStartScale(srcNode: Node): Vec3 {
        const ws = new Vec3();
        srcNode.getWorldScale(ws);
        if (ws.x > 0.01 && ws.y > 0.01) {
            return new Vec3(ws.x, ws.y, 1);
        }
        const rows = clampMatsuriRows(GameData.instance.matsuriRows || 3);
        const fit = matsuriGridFitScale(rows);
        const overlayS = this.stickyOverlay?.node?.scale?.x ?? fit;
        const local = srcNode.scale;
        const s = Math.max(0.05, overlayS) * Math.max(local.x, 0.05);
        return new Vec3(s, s, 1);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

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
        const bs = this._totalBaseScale;
        Tween.stopAllByTarget(sn.node);
        tween(sn.node)
            .to(0.07, { scale: new Vec3(bs.x * 1.28, bs.y * 1.28, bs.z) })
            .to(0.1, { scale: new Vec3(bs.x, bs.y, bs.z) })
            .start();
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

    private _findSceneNode(name: string): Node | null {
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

    private _wait(sec: number): Promise<void> {
        return new Promise(resolve => {
            if (sec <= 0) resolve();
            else this.scheduleOnce(resolve, sec);
        });
    }
}
