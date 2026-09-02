/**
 * TopUpAbsorbEffect - Chuoi hieu ung hut tien sau moi spin TopUp.
 *
 * TRINH TU:
 *   1. Bounce coin moi rot xuong (Yellow/Green)
 *   2. Green hut tien: effect bay tu tat ca dong khac toi dong Xanh moi
 *   3. Emit TOPUP_ABSORB_DONE cho GameManager tiep tuc
 *
 * LUAT:
 *   - Xanh hut TAT CA (Vang + Xanh khac).
 *   - Thu tu: trai sang phai, tren xuong duoi.
 *   - 1 luot quay: het Vang -> het Xanh -> moi quay tiep.
 *
 * SETUP TRONG EDITOR:
 *   1. Tao Node "TopUpAbsorbLayer" con cua Canvas, z-order tren StickyOverlay.
 *      Gan UITransform cung kich thuoc Canvas. Gan component TopUpAbsorbEffect.
 *   2. flyEffectPrefab   -> Prefab hieu ung bay (node co UITransform, Sprite/Particle...)
 *   3. stickyOverlay     -> StickyOverlayController
 *   4. stickyOverlay     -> StickyOverlayController
 */

import {
    _decorator, Component, Node, tween, Vec3, Tween,
    UITransform, UIOpacity, Sprite, Color, instantiate, isValid,
    ParticleSystem, Camera,
} from 'cc';
import { EventBus }                from '../core/EventBus';
import { GameEvents }              from '../core/GameEvents';
import { StickyCell, SymbolId }    from '../data/SlotTypes';
import { StickyOverlayController } from './StickyOverlayController';
import { SpriteNumber }            from '../core/SpriteNumber';
import { Log }                     from '../core/Logger';
import { AutoSpinManager }         from '../manager/AutoSpinManager';
import { SoundManager }            from '../manager/SoundManager';

const { ccclass, property } = _decorator;

/** Camera Particle3D trong scene — Visibility/Layer gán trên Editor (khuyến nghị UI_3D). */
const PARTICLE_3D_CAMERA_NAME = 'Particle3DCamera';
/** Priority cao hơn UI Camera → particle luôn vẽ đè lên UI. */
const PARTICLE_3D_CAMERA_PRIORITY_OFFSET = 100;

/** Khớp StickyOverlay: vàng/xanh scale tối đa khi xuất hiện = 1. */
const TOPUP_YELLOW_COIN_SCALE = 1;
const TOPUP_GREEN_COIN_SCALE = 1;

function topUpAbsorbCoinScale(symbolId: number): number {
    if (symbolId === SymbolId.STICKY_YELLOW) return TOPUP_YELLOW_COIN_SCALE;
    if (symbolId === SymbolId.STICKY_GREEN) return TOPUP_GREEN_COIN_SCALE;
    return TOPUP_YELLOW_COIN_SCALE;
}

/** Payload tu GameManager khi emit TOPUP_ABSORB_START */
export interface TopUpAbsorbPayload {
    newCells: StickyCell[];
    allStickyCells: Map<string, StickyCell>;
    serverDeltaWin?: number;
    serverTotalWin?: number;
    /** So lan spin cuoi cung sau khi +1 duoc tinh (emit TOPUP_COUNT_UPDATED sau animation) */
    newSpinCount?: number;
}

@ccclass('TopUpAbsorbEffect')
export class TopUpAbsorbEffect extends Component {

    // == INSPECTOR ==

    @property({
        type: Node,
        tooltip: 'Node mẫu (active=false) hiệu ứng bay giữa các đồng xu.\nCần có UITransform và ParticleSystem (loop=true). Sẽ được pool.',
    })
    flyEffectTemplate: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Node mẫu effect phát trên đồng vàng: khi vàng bay vào xanh. Cần có ParticleSystem.',
    })
    yellowHitTemplate: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Node mẫu effect phát trên đồng xanh khi bất kỳ đồng nào bay vào nó. Cần có ParticleSystem.',
    })
    greenHitTemplate: Node | null = null;

    @property({
        type: StickyOverlayController,
        tooltip: 'Thường để trống — StickyOverlayLoader.bindStickyOverlay() wire lúc runtime khi lazy-load.',
    })
    stickyOverlay: StickyOverlayController | null = null;

    /** Wire StickyOverlay từ code sau khi lazy-load Prefab. */
    bindStickyOverlay(overlay: StickyOverlayController | null): void {
        this.stickyOverlay = overlay;
    }

    @property({ tooltip: 'Thoi gian effect bay tu nguon den dich (giay)' })
    flyDuration: number = 0.4;

    @property({ tooltip: 'Delay giua cac effect khi co nhieu nguon cung bay (giay)' })
    flyStagger: number = 0.07;

    @property({ tooltip: 'Delay giua 2 lan absorb khi co nhieu dong Vang hoac Xanh (giay)' })
    coinSequenceDelay: number = 0.25;

    // == STATE ==

    private _isPlaying: boolean = false;
    private _pulseTween: Tween<Node> | null = null;
    private _pulseBaseScale: Vec3 = new Vec3(1, 1, 1);
    private _newSpinCount: number = -1;
    private _allStickyCells: Map<string, StickyCell> | null = null;
    private _currentSpinNextWinKeys: Set<string> = new Set();

    // Lazy pools: chỉ tạo object khi borrow, trả về pool khi xong.
    private _flyPool:       Node[] = [];
    private _yellowHitPool: Node[] = [];
    private _greenHitPool:  Node[] = [];

    // Map de huy callback scheduleOnce con ton dong khi node duoc tai su dung tu pool
    private _flyTimers: Map<Node, () => void> = new Map();
    private _hitTimers: Map<Node, () => void> = new Map();

    /** Camera UI dùng làm chuẩn transform/viewport cho Particle3DCamera. */
    private _sourceCamera: Camera | null = null;

    /** Particle3DCamera sẵn trong loading.scene — không tạo bằng code. */
    private _particle3DCamera: Camera | null = null;

    // == LIFECYCLE ==

    onLoad(): void {
        // Không prebuild pool lúc load — tạo object khi borrow.
        EventBus.instance.on(GameEvents.TOPUP_ABSORB_START, this._onAbsorbStart, this);
        this._bindParticle3DCamera();
    }

    lateUpdate(): void {
        this._syncParticle3DCamera();
    }

    /** Bind Particle3DCamera đã đặt sẵn trong loading.scene (không instantiate). */
    private _bindParticle3DCamera(): void {
        const scene = this.node.scene;
        if (!scene) return;

        this._particle3DCamera = scene.getComponentsInChildren(Camera).find(camera =>
            camera.node.name === PARTICLE_3D_CAMERA_NAME
        ) ?? null;

        if (!this._particle3DCamera) {
            Log.w(`[TopUpAbsorb] Không tìm thấy Camera "${PARTICLE_3D_CAMERA_NAME}" trong scene`);
            return;
        }

        this._sourceCamera = scene.getComponentsInChildren(Camera).find(camera =>
            camera.enabled
            && camera.node.name !== PARTICLE_3D_CAMERA_NAME
            && (camera.visibility & this.node.layer) !== 0
        ) ?? null;

        if (!this._sourceCamera) {
            Log.w('[TopUpAbsorb] Không tìm thấy UI Camera để đồng bộ Particle3DCamera');
            return;
        }

        // KHÔNG ghi đè visibility — giữ đúng Editor (UI_3D). Chỉ clear Depth.
        this._particle3DCamera.node.active = true;
        this._particle3DCamera.enabled = true;
        this._particle3DCamera.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
        if (scene && this._particle3DCamera.node.parent !== scene) {
            this._particle3DCamera.node.setParent(scene);
        }
        this._syncParticle3DCamera();
    }

    private _syncParticle3DCamera(): void {
        const source = this._sourceCamera;
        const cam = this._particle3DCamera;
        if (!source?.isValid || !cam?.isValid) return;

        cam.projection = source.projection;
        cam.fov = source.fov;
        cam.orthoHeight = source.orthoHeight;
        cam.near = source.near;
        cam.far = source.far;
        cam.viewport = source.viewport;
        cam.priority = source.priority + PARTICLE_3D_CAMERA_PRIORITY_OFFSET;

        cam.node.setWorldPosition(source.node.worldPosition);
        cam.node.setWorldRotation(source.node.worldRotation);
        cam.node.setScale(1, 1, 1);
    }

    /**
     * Mượn node từ pool; nếu trống thì instantiate từ template (lazy).
     */
    private _borrowEffect(pool: Node[], template: Node | null, poolName: string = 'unknown'): Node | null {
        Log.d(`[TopUpAbsorb] _borrowEffect from ${poolName}, pool.length=${pool.length}`);
        while (pool.length > 0) {
            const n = pool.pop()!;
            if (isValid(n)) {
                Log.d(`[TopUpAbsorb] borrowed ${n.name} from ${poolName}, remaining=${pool.length}`);
                return n;
            } else {
                Log.w(`[TopUpAbsorb] skipped invalid node in ${poolName}`);
            }
        }
        if (!template) {
            Log.e(`[TopUpAbsorb] ${poolName} empty and no template`);
            return null;
        }
        const n = instantiate(template);
        n.name = `${poolName}_${pool.length}`;
        n.active = false;
        n.setParent(this.node);
        Log.d(`[TopUpAbsorb] created new ${n.name} for ${poolName}`);
        return n;
    }

    private _returnEffect(pool: Node[], n: Node, poolName: string = 'unknown'): void {
        if (!isValid(n)) {
            Log.w(`[TopUpAbsorb] _returnEffect: node invalid, cannot return to ${poolName}`);
            return;
        }
        Tween.stopAllByTarget(n);
        n.active = false;
        n.setParent(this.node);
        if (!pool.includes(n)) {
            pool.push(n);
            Log.d(`[TopUpAbsorb] returned ${n.name} to ${poolName}, pool.length=${pool.length}`);
        } else {
            Log.w(`[TopUpAbsorb] ${n.name} already in ${poolName}, skip push`);
        }
    }

    // ── PUBLIC: chia sẻ fly pool với effect khác ─────────────────────────────

    /** Mượn 1 fly effect node từ pool để dùng ngoài class này. */
    public borrowFlyEffect(): Node | null {
        return this._borrowEffect(this._flyPool, this.flyEffectTemplate, 'flyPool[shared]');
    }

    /** Trả fly effect node về pool sau khi dùng xong. */
    public returnFlyEffect(n: Node): void {
        this._returnEffect(this._flyPool, n, 'flyPool[shared]');
    }

    private _getMaxParticleDuration(root: Node, fallback: number): number {
        const particles = root.getComponentsInChildren(ParticleSystem);
        if (particles.length === 0) return fallback;

        let maxDuration = fallback;
        for (const ps of particles) {
            maxDuration = Math.max(maxDuration, ps.duration > 0 ? ps.duration : fallback);
        }
        return maxDuration;
    }

    private _playParticlesFromStart(root: Node): void {
        const particles = root.getComponentsInChildren(ParticleSystem);
        for (const ps of particles) {
            ps.stop();
            const maybeClear = (ps as unknown as { clear?: () => void }).clear;
            if (maybeClear) maybeClear.call(ps);
            ps.play();
        }
    }

    onDestroy(): void {
        EventBus.instance.off(GameEvents.TOPUP_ABSORB_START, this._onAbsorbStart, this);
        // Particle3DCamera thuộc scene — không destroy.
        this._particle3DCamera = null;
        this._sourceCamera = null;
    }

    // == MAIN ==

    private async _onAbsorbStart(payload: TopUpAbsorbPayload): Promise<void> {
        if (this._isPlaying) return;
        this._isPlaying = true;

        const { newCells, allStickyCells, newSpinCount, serverDeltaWin, serverTotalWin } = payload;
        this._newSpinCount = newSpinCount ?? -1;
        this._allStickyCells = allStickyCells;
        this._currentSpinNextWinKeys = new Set(
            newCells
                .filter(c => c.symbolId === SymbolId.STICKY_YELLOW || c.symbolId === SymbolId.STICKY_GREEN)
                .map(c => `${c.reel}-${c.row}`)
        );
        Log.d(`[TopUpAbsorb] START newCells=${newCells.length} newSpinCount=${this._newSpinCount}`);
        Log.e(`[TOPUP-CREDIT][ABSORB] start serverDelta=${serverDeltaWin ?? 'n/a'} serverTotal=${serverTotalWin ?? 'n/a'} newCells=${newCells.map(c => `${c.reel}-${c.row}:${SymbolId[c.symbolId] ?? c.symbolId}=${c.credit ?? 0}`).join('|') || 'none'} allSticky=${Array.from(allStickyCells.values()).map(c => `${c.reel}-${c.row}:${SymbolId[c.symbolId] ?? c.symbolId}=${c.credit ?? 0}`).join('|')}`);

        try {
            let didAbsorbMoneyThisSpin = false;
            // NOTE: Bounce khi coin mới land đã được StickyOverlayController xử lý
            // qua TOPUP_TOTAL_UPDATED → _refreshAll(true). Không bounce lại ở đây để
            // tránh duplicate tween gây nhún giật.

            await this.stickyOverlay?.waitForGoldLandBounce();

            // Green absorb - tuan tu tung dong Xanh moi (trai-phai, tren-duoi)
            //    LUAT: Xanh hut TAT CA (Do, Vang, Xanh khac)
            //    Chi Xanh moi duoc lam dich hut; Xanh cu da hut roi thi khong reset ve 0/hut lai.
            const newGreenKeys = this._sortedNewKeys(newCells, SymbolId.STICKY_GREEN);
            const pendingNewGreenKeys = new Set(newGreenKeys);
            const completedNewGreenKeys = new Set<string>();
            for (let gi = 0; gi < newGreenKeys.length; gi++) {
                const gKey  = newGreenKeys[gi];
                const gCell = allStickyCells.get(gKey);
                if (!gCell) continue;
                const dstNode = this._getSlotNode(gCell.reel, gCell.row);
                if (!dstNode || !dstNode.active) continue;

                // Nguon = moi coin TRU ban than
                const sources: StickyCell[] = [];
                for (const [key, cell] of allStickyCells) {
                    if (key === gKey) continue;
                    if (pendingNewGreenKeys.has(key) && !completedNewGreenKeys.has(key)) continue;
                    if ((cell.credit ?? 0) <= 0) continue;
                    sources.push(cell);
                }
                const sortedSources = this._sortCellsForAbsorbSources(sources);
                if (sortedSources.length === 0) {
                    pendingNewGreenKeys.delete(gKey);
                    continue;
                }

                const creditTarget = sortedSources.reduce((sum, s) => sum + (s.credit ?? 0), 0);
                Log.e(`[TOPUP-CREDIT][ABSORB] green dst=${gCell.reel}-${gCell.row} target=${creditTarget} sources=${sortedSources.map(s => `${s.reel}-${s.row}:${SymbolId[s.symbolId] ?? s.symbolId}=${s.credit ?? 0}`).join('|')}`);
                await this._absorbIntoCoin(sortedSources, dstNode, gCell.symbolId, creditTarget, gCell);
                pendingNewGreenKeys.delete(gKey);
                completedNewGreenKeys.add(gKey);
                didAbsorbMoneyThisSpin = true;
                if (gi < newGreenKeys.length - 1) await this._delay(this.coinSequenceDelay * this._spd());
            }

            if (didAbsorbMoneyThisSpin) {
                const visualCredit = this._getTopUpNextWinValue();
                const creditForEachWin = serverDeltaWin ?? visualCredit;
                Log.e(`[TOPUP-CREDIT][ABSORB] emitVisualCredit=${visualCredit} serverDelta=${serverDeltaWin ?? 'n/a'} creditForEachWin=${creditForEachWin} serverTotal=${serverTotalWin ?? 'n/a'}`);
                EventBus.instance.emit(GameEvents.TOPUP_ABSORB_CREDIT, {
                    credit: creditForEachWin,
                    visualCredit,
                    totalWin: serverTotalWin,
                });
            }

            Log.d(`[TopUpAbsorb] DONE`);
        } catch (err) {
            Log.err(`[TopUpAbsorb] Error:`, err);
        }

        this._isPlaying = false;
        this._allStickyCells = null;
        this._currentSpinNextWinKeys.clear();
        EventBus.instance.emit(GameEvents.TOPUP_ABSORB_DONE);
    }

    // ==========================================================================
    //  ABSORB CORE
    //  - Bay tat ca effect tu sources -> dstNode (co stagger)
    //  - Dong dich nhun nhe deu trong luc cho effect den
    //  - Moi effect cham dich -> cong them credit len CreditLabel ngay lap tuc
    // ==========================================================================

    private async _absorbIntoCoin(
        sources: StickyCell[],
        dstNode: Node,
        dstSymbolId: number,
        creditTarget: number,
        dstCell: StickyCell,
    ): Promise<void> {
        Log.d(`[TopUpAbsorb] absorb dst=${dstNode.name} target=${creditTarget} sources=${JSON.stringify(sources.map(s => ({ reel: s.reel, row: s.row, sym: s.symbolId, credit: s.credit ?? 0 })))}`);

        // Coin vang/xanh da hien tren StickyOverlay (scale toi da = 1).
        // Stop landing bounce first so the absorb scale is not overwritten by a previous tween.
        const absorbScale = topUpAbsorbCoinScale(dstSymbolId);
        Tween.stopAllByTarget(dstNode);
        dstNode.setScale(absorbScale, absorbScale, dstNode.scale.z);

        // Bay tat ca effect song song (co stagger), moi lan 1 effect cham -> cong credit + zoom nhe
        await this._flyEffectsWithIncrementalCredit(sources, dstNode, dstSymbolId, creditTarget, dstCell);

        // Dam bao so cuoi cung chinh xac
        this._commitAbsorbCredit(dstCell, dstNode, creditTarget);
        dstNode.setScale(absorbScale, absorbScale, dstNode.scale.z);
    }

    private _commitAbsorbCredit(dstCell: StickyCell, dstNode: Node, credit: number): void {
        dstCell.credit = credit;
        this._ensureCreditLabel(dstNode, credit);
        Log.e(`[TOPUP-CREDIT][ABSORB] commit dst=${dstCell.reel}-${dstCell.row}:${SymbolId[dstCell.symbolId] ?? dstCell.symbolId} credit=${credit}`);
        if (this.stickyOverlay) {
            this.stickyOverlay.setSlotCredit(dstNode, credit);
        }
        if (dstCell.symbolId === SymbolId.STICKY_YELLOW || dstCell.symbolId === SymbolId.STICKY_GREEN) {
            EventBus.instance.emit(GameEvents.TOPUP_NEXT_WIN_UPDATED, this._getTopUpNextWinValue());
        }
    }

    private _getTopUpNextWinValue(): number {
        let maxGreenCredit = 0;
        let totalYellowCredit = 0;
        let hasGreen = false;
        const cells = this._allStickyCells;
        if (!cells) return 0;
        for (const key of this._currentSpinNextWinKeys) {
            const cell = cells.get(key);
            if (!cell) continue;
            if (cell.symbolId === SymbolId.STICKY_GREEN) {
                hasGreen = true;
                maxGreenCredit = Math.max(maxGreenCredit, cell.credit ?? 0);
            } else if (cell.symbolId === SymbolId.STICKY_YELLOW) {
                totalYellowCredit += cell.credit ?? 0;
            }
        }
        return hasGreen ? maxGreenCredit : totalYellowCredit;
    }

    /** Hien thi CreditLabel va set gia tri — giữ nguyên scale node để SpriteNumber tự quản lý. */
    private _ensureCreditLabel(slotNode: Node, value: number): void {
        let labelNode = slotNode.getChildByName('CreditLabel');
        let sn = labelNode?.getComponent(SpriteNumber) ?? null;
        if (!sn) {
            sn = slotNode.getComponentInChildren(SpriteNumber);
            if (sn) labelNode = sn.node;
        }
        if (!labelNode || !sn) {
            Log.err(`[TopUpAbsorb] Missing CreditLabel/SpriteNumber on ${slotNode.name}`);
            return;
        }
        const safeValue = Math.max(0, value);
        labelNode.active = safeValue > 0;
        sn.setData(safeValue, -1, 2);
    }

    // -- Bay nhieu effect voi stagger, moi effect cham -> cong credit cua source --

    private _flyEffectsWithIncrementalCredit(
        sources: StickyCell[],
        dstNode: Node,
        dstSymbolId: number,
        creditTarget: number,
        dstCell: StickyCell,
    ): Promise<void> {
        return new Promise(resolve => {
            if (sources.length === 0) { resolve(); return; }

            const n = sources.length;
            let landed = 0;
            let runningCredit = 0;

            const oneLanded = (sourceIndex: number) => {
                landed++;
                const source = sources[sourceIndex];
                const sourceCredit = source.credit ?? 0;
                runningCredit += sourceCredit;
                const display = landed >= n ? creditTarget : Math.min(runningCredit, creditTarget);
                Log.d(`[TopUpAbsorb] oneLanded ${landed}/${n} srcIdx=${sourceIndex}`);
                this._commitAbsorbCredit(dstCell, dstNode, display);

                // Nhún nhẹ từ current scale lên rồi về lại
                const bumpBase = dstNode.scale.clone();
                const bumpScale = new Vec3(bumpBase.x * 1.05, bumpBase.y * 1.05, bumpBase.z);
                Tween.stopAllByTarget(dstNode);
                tween(dstNode)
                    .to(0.08 * this._spd(), { scale: bumpScale }, { easing: 'sineOut' })
                    .to(0.08 * this._spd(), { scale: bumpBase }, { easing: 'sineIn' })
                    .start();

                // Hit effect tai dong dich khi co dong bay den
                if (dstSymbolId === SymbolId.STICKY_YELLOW) {
                    this._spawnHitEffect(this._yellowHitPool, dstNode.worldPosition, dstNode);
                } else if (dstSymbolId === SymbolId.STICKY_GREEN) {
                    this._spawnHitEffect(this._greenHitPool, dstNode.worldPosition, dstNode);
                }

                if (landed >= n) resolve();
            };

            for (let i = 0; i < n; i++) {
                const srcNode = this._getSlotNode(sources[i].reel, sources[i].row);
                const srcSymbolId = sources[i].symbolId;
                const delay   = i * this.flyStagger * this._spd();
                const idx     = i;

                if (!srcNode || !srcNode.active) {
                    Log.w(`[TopUpAbsorb] srcNode invalid/inactive for idx=${idx}, schedule fallback oneLanded`);
                    this.scheduleOnce(() => oneLanded(idx), delay + this.flyDuration * this._spd());
                    continue;
                }

                // Hit effect tai nguon khi bat dau bay
                this.scheduleOnce(() => {
                    if (srcSymbolId === SymbolId.STICKY_YELLOW) {
                        this._spawnHitEffect(this._yellowHitPool, srcNode.worldPosition);
                    } else if (srcSymbolId === SymbolId.STICKY_GREEN) {
                        this._spawnHitEffect(this._greenHitPool, srcNode.worldPosition);
                    }
                    this._spawnFlyEffect(srcNode, dstNode).then(() => oneLanded(idx));
                }, delay);
            }
        });
    }

    // -- Pulse nhe va deu (khong giat) ----------------------------------------

    private _startPulse(node: Node): void {
        this._stopPulse(node);
        this._pulseBaseScale = node.scale.clone();
        const base = this._pulseBaseScale;
        this._pulseTween = tween(node)
            .repeatForever(
                tween(node)
                    .to(0.3, { scale: new Vec3(base.x * 1.08, base.y * 1.08, base.z) }, { easing: 'sineInOut' })
                    .to(0.3, { scale: base }, { easing: 'sineInOut' })
            )
            .start();
    }

    private _stopPulse(node: Node): void {
        if (this._pulseTween) {
            this._pulseTween.stop();
            this._pulseTween = null;
        }
        Tween.stopAllByTarget(node);
        if (isValid(node)) {
            const base = this._pulseBaseScale;
            node.setScale(base.x, base.y, base.z);
            // Dam bao CreditLabel scale = base (co the bi anh huong boi parent tween)
            const label = node.getChildByName('CreditLabel');
            if (label) label.setScale(base.x, base.y, base.z);
        }
    }

    // -- Spawn 1 effect tu template, bay tu src -> dst (pool + particle loop) --

    private _spawnFlyEffect(srcNode: Node, dstNode: Node): Promise<void> {
        return new Promise(resolve => {
            if (!isValid(srcNode) || !isValid(dstNode) || !isValid(this.node)) {
                resolve();
                return;
            }

            const layerUT = this.node.getComponent(UITransform);
            if (!layerUT) { resolve(); return; }

            const fx = this._borrowEffect(this._flyPool, this.flyEffectTemplate, 'flyPool');
            if (!fx) {
                Log.err('[TopUpAbsorb] Fly effect create failed, skip this fly effect - RESOLVE immediately');
                resolve();
                return;
            }
            Log.d(`[TopUpAbsorb] _spawnFlyEffect: got ${fx.name}, setting active=true`);

            // Huy callback cu con ton dong
            const stale = this._flyTimers.get(fx);
            if (stale) { this.unschedule(stale); this._flyTimers.delete(fx); }
            Tween.stopAllByTarget(fx);

            fx.setParent(this.node);

            const start = layerUT.convertToNodeSpaceAR(srcNode.getWorldPosition());
            fx.setPosition(start.x, start.y, 0);
            fx.active = true;
            this._playParticlesFromStart(fx);

            // Bao ve: dam bao Promise luon resolve du tween co hoan thanh hay ko
            let resolved = false;
            const doResolve = () => { if (!resolved) { resolved = true; resolve(); } };

            const failSafeCb = () => {
                Log.w(`[TopUpAbsorb] flyEffect failSafe triggered for ${fx.name}`);
                this._flyTimers.delete(fx);
                doResolve();
                if (isValid(fx)) this._returnEffect(this._flyPool, fx, 'flyPool');
            };
            this._flyTimers.set(fx, failSafeCb);
            this.scheduleOnce(failSafeCb, this.flyDuration * this._spd() + 1.5);

            const endWorld = dstNode.getWorldPosition();
            const end = layerUT.convertToNodeSpaceAR(endWorld);

            tween(fx)
                .to(this.flyDuration * this._spd(),
                    { position: new Vec3(end.x, end.y, 0) },
                    { easing: 'sineIn' }
                )
                .call(() => {
                    SoundManager.instance?.playBonusTrail();
                    const pending = this._flyTimers.get(fx);
                    if (pending === failSafeCb) this.unschedule(failSafeCb);
                    doResolve();
                    if (!isValid(fx)) return;

                    // Gan parent = coin dich: effect tren sprite, CreditLabel tren het
                    if (isValid(dstNode)) {
                        fx.setParent(dstNode);
                        // Dat effect o cuoi (tren cung hien tai)
                        fx.setSiblingIndex(dstNode.children.length - 1);
                        fx.setPosition(0, 0, 0);
                        // Dam bao CreditLabel luon o tren effect
                        const creditLabel = dstNode.getChildByName('CreditLabel');
                        if (creditLabel && isValid(creditLabel)) {
                            creditLabel.setSiblingIndex(dstNode.children.length - 1);
                        }
                    }

                    // Dung 1 giay roi tra pool
                    const stopCb = () => {
                        Log.d(`[TopUpAbsorb] flyEffect stopCb for ${fx.name}`);
                        this._flyTimers.delete(fx);
                        if (isValid(fx)) {
                            this._returnEffect(this._flyPool, fx, 'flyPool');
                        }
                    };
                    this._flyTimers.set(fx, stopCb);
                    this.scheduleOnce(stopCb, 1.0);
                })
                .start();
        });
    }

    // -- Spawn hit effect tu fixed-size pool ---------------------------------

    /**
     * Lay 1 node tu pool 5 node, hien len tai worldPos,
     * play lai tat ca particle tu dau, dien xong thi tra pool. Het pool thi skip.
     * @param coinNode  Neu truyen vao: setParent(coinNode) + siblingIndex=0 + pos=(0,0,0)
     *                  de effect nam duoi CreditLabel cua coin do.
     *                  Neu null: dat tai layerUT local position tinh tu worldPos.
     */
    private _spawnHitEffect(pool: Node[], worldPos: Vec3, coinNode: Node | null = null): void {
        if (!isValid(this.node)) return;

        const layerUT = this.node.getComponent(UITransform);
        if (!layerUT) return;

        const poolName = pool === this._yellowHitPool ? 'yellowHitPool' : 'greenHitPool';
        const template =
            pool === this._yellowHitPool ? this.yellowHitTemplate :
            this.greenHitTemplate;
        const fx = this._borrowEffect(pool, template, poolName);
        if (!fx) {
            Log.err(`[TopUpAbsorb] ${poolName} create failed, skip this hit effect`);
            return;
        }
        Log.d(`[TopUpAbsorb] _spawnHitEffect: got ${fx.name} from ${poolName}`);

        // Huy callback cu con ton dong
        const stale = this._hitTimers.get(fx);
        if (stale) { this.unschedule(stale); this._hitTimers.delete(fx); }
        Tween.stopAllByTarget(fx);

        if (coinNode && isValid(coinNode)) {
            // Parent vao coin node, nam duoi CreditLabel (siblingIndex = 0)
            fx.setParent(coinNode);
            fx.setSiblingIndex(0);
            fx.setPosition(0, 0, 0);
        } else {
            const localPos = layerUT.convertToNodeSpaceAR(worldPos);
            fx.setPosition(localPos.x, localPos.y, 0);
        }
        fx.active = true;

        // Defer play sang frame ke tiep de node kip wake up
        this.scheduleOnce(() => {
            if (isValid(fx)) {
                this._playParticlesFromStart(fx);
            }
        }, 0);

        const returnDelay = this._getMaxParticleDuration(fx, 0.5) + 0.1;
        Log.d(`[TopUpAbsorb] hitEffect ${fx.name} returnDelay=${returnDelay}`);
        const poolNameForReturn = poolName;
        const stopCb = () => {
            Log.d(`[TopUpAbsorb] hitEffect stopCb for ${fx.name}`);
            this._hitTimers.delete(fx);
            if (isValid(fx)) { this._returnEffect(pool, fx, poolNameForReturn); }
        };
        this._hitTimers.set(fx, stopCb);
        this.scheduleOnce(stopCb, returnDelay);
    }

    // ==========================================================================
    //  STEP 1 - Bounce coin moi
    // ==========================================================================

    private async _stepBounceNewCoins(newCells: StickyCell[]): Promise<void> {
        const toShow = newCells.filter(c =>
            c.symbolId === SymbolId.STICKY_YELLOW || c.symbolId === SymbolId.STICKY_GREEN
        );
        if (toShow.length === 0) return;

        const ps: Promise<void>[] = [];
        for (const cell of toShow) {
            const node = this._getSlotNode(cell.reel, cell.row);
            if (!node || !node.active) continue;
            ps.push(this._bounceCoin(node, 1));
        }
        await Promise.all(ps);
    }

    /** @param peakMultiplier Nhân peak scale; vàng/xanh xuất hiện dùng 1 (không vượt base). */
    private _bounceCoin(node: Node, peakMultiplier: number = 1.25): Promise<void> {
        return new Promise(resolve => {
            if (!isValid(node) || !node.activeInHierarchy) {
                Log.w(`[TopUpAbsorb] _bounceCoin: node invalid or inactive (${node?.name}), skip`);
                resolve();
                return;
            }
            Tween.stopAllByTarget(node);
            const baseScale = node.scale.clone();
            const peakX = baseScale.x * peakMultiplier;
            const peakY = baseScale.y * peakMultiplier;

            let resolved = false;
            const doResolve = () => { if (!resolved) { resolved = true; resolve(); } };

            tween(node)
                .to(0.10, { scale: new Vec3(peakX, peakY, baseScale.z) })
                .to(0.08, { scale: new Vec3(baseScale.x * 0.95, baseScale.y * 0.95, baseScale.z) })
                .to(0.06, { scale: baseScale })
                .call(() => doResolve())
                .start();

            // Failsafe: tween tren node bi deactivate se khong chay
            this.scheduleOnce(doResolve, 0.5);
        });
    }

    // ==========================================================================
    //  UTILITIES
    // ==========================================================================

    /**
     * Keys cua newCells theo symbolId, sort: trai->phai (reel asc), tren->duoi (row asc).
     * StickyOverlay/TopUpReel index convention: row 0 = visual Top, row 2 = visual Bottom.
     */
    private _sortedNewKeys(newCells: StickyCell[], symbolId: number): string[] {
        return newCells
            .filter(c => c.symbolId === symbolId)
            .sort((a, b) => a.reel !== b.reel ? a.reel - b.reel : a.row - b.row)
            .map(c => `${c.reel}-${c.row}`);
    }

    private _getSlotNode(reel: number, row: number): Node | null {
        if (!this.stickyOverlay) return null;
        // Ưu tiên API rowCount (Matsuri 5×3|4|5); fallback 3 hàng.
        if (typeof this.stickyOverlay.getCoinSlot === 'function') {
            return this.stickyOverlay.getCoinSlot(reel, row);
        }
        const rows = this.stickyOverlay.rowCount || 3;
        return this.stickyOverlay.coinSlots[reel * rows + row] ?? null;
    }

    private _getCellsBySymbol(cells: Map<string, StickyCell>, symbolId: number): StickyCell[] {
        const result: StickyCell[] = [];
        for (const cell of cells.values()) {
            if (cell.symbolId === symbolId) result.push(cell);
        }
        return result;
    }

    private _sortCellsForAbsorbSources(cells: StickyCell[]): StickyCell[] {
        return cells.sort((a, b) => {
            const priorityDiff = this._getAbsorbSymbolPriority(a.symbolId) - this._getAbsorbSymbolPriority(b.symbolId);
            if (priorityDiff !== 0) return priorityDiff;
            // trai->phai, tren->duoi cho thu tu dong nguon ban tien.
            return a.reel !== b.reel ? a.reel - b.reel : a.row - b.row;
        });
    }

    private _getAbsorbSymbolPriority(symbolId: number): number {
        switch (symbolId) {
            case SymbolId.STICKY_YELLOW: return 0;
            case SymbolId.STICKY_GREEN: return 1;
            default: return 2;
        }
    }

    /** Timing multiplier theo speed mode (Normal=1, Quick=0.8, Turbo=0.6) */
    private _spd(): number {
        return AutoSpinManager.instance?.getTimingMultiplier() ?? 1;
    }

    private _delay(sec: number): Promise<void> {
        return new Promise(resolve => this.scheduleOnce(resolve, sec));
    }
}
