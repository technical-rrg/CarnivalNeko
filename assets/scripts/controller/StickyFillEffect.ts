/**
 * StickyFillEffect — Hiệu ứng "đổ" Sticky đủ 6 khi Force Feature Entry.
 *
 * ★ FEATURE ENTRY LOGIC ADDED (Concept & System Design v260610, trang 21–26)
 *
 * Phase 1 – (không nhún Pot) mỗi orb: Pot play LV{level}_Impact → bắn orb
 * → Phase 2 orb bay từ Pot
 * → Phase 3 impact tại ô đích
 * → Phase 4 convert symbol tại ô đó thành Sticky đỏ + nhún land
 * → lặp cho từng fillCell → Phase 5 emit STICKY_FILL_DONE.
 *
 * Doc: mỗi orb bay → chạm → 1 symbol đổi thành Sticky (không đổ hàng loạt cùng lúc).
 */

import {
    _decorator, Component, Node, instantiate, tween, Tween, Vec3, NodePool, AudioClip,
    ParticleSystem,
} from 'cc';
import { EventBus }               from '../core/EventBus';
import { GameEvents }             from '../core/GameEvents';
import { Log }                    from '../core/Logger';
import { SoundManager }           from '../manager/SoundManager';
import { StickyCell, ForceFeatureEntryData } from '../data/SlotTypes';
import { SlotMachineController }  from './SlotMachineController';
import { SymbolView }             from './SymbolView';
import { PotController }          from './PotController';

const { ccclass, property } = _decorator;

@ccclass('StickyFillEffect')
export class StickyFillEffect extends Component {

    @property({ type: SlotMachineController, tooltip: 'SlotMachineController — lấy symbolNodes trên reel.' })
    slotMachine: SlotMachineController | null = null;

    @property({ type: Node, tooltip: 'Node Pot — điểm xuất phát orb.' })
    potNode: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Node mẫu light orb trên scene (active=false). Runtime clone/pool, xong trả pool.',
    })
    orbTemplate: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Node mẫu hiệu ứng chạm đất (optional, active=false). Clone/pool giống orb.',
    })
    landEffectTemplate: Node | null = null;

    @property({ type: Node, tooltip: 'Node rung màn hình khi orb chạm (optional).' })
    screenShakeNode: Node | null = null;

    @property({ type: AudioClip, tooltip: 'SFX Pot charge (Phase 1).' })
    sfxCharge: AudioClip | null = null;
    @property({ type: AudioClip, tooltip: 'SFX phóng orb (Phase 2).' })
    sfxLaunch: AudioClip | null = null;
    @property({ type: AudioClip, tooltip: 'SFX orb chạm đất (Phase 3).' })
    sfxLand: AudioClip | null = null;
    @property({ type: AudioClip, tooltip: 'SFX convert thành Sticky (Phase 4).' })
    sfxConvert: AudioClip | null = null;

    @property({ tooltip: 'Delay sau khi Pot Impact xong trước khi bắn orb (giây).' })
    impactToLaunchDelay: number = 0;
    @property({ tooltip: 'Bắn orb sớm hơn trước khi Impact kết thúc (giây).' })
    impactEarlyLaunch: number = 0.18;
    @property({ tooltip: 'Play sx_pot_hit sớm hơn lúc orb bay ra (giây) — bù latency clip/visual.' })
    potHitSfxLead: number = 0.12;
    @property({ tooltip: 'Thời gian zoom orb từ 0 → scale gốc khi bay ra (giây).' })
    orbScaleInDuration: number = 0.18;
    @property({ tooltip: 'Thời gian rơi của mỗi orb (Phase 2).' })
    orbFallDuration: number = 0.55;
    @property({ tooltip: 'Khoảng cách giữa 2 orb liên tiếp (giây, sau khi orb trước chạm đích).' })
    orbLaunchInterval: number = 0.25;
    @property({ tooltip: 'Thời gian giữ land FX trước khi trả pool (giây).' })
    landFxDuration: number = 1.0;

    private _busy: boolean = false;
    private _orbPool: NodePool = new NodePool();
    private _landFxPool: NodePool = new NodePool();
    /** Orb đang bay — dọn khi cancel/destroy. */
    private _activeOrbs: Node[] = [];

    onLoad(): void {
        EventBus.instance.on(GameEvents.STICKY_FILL_START, this._onStart, this);
        this.node.active = false;
        if (this.orbTemplate) this.orbTemplate.active = false;
        if (this.landEffectTemplate) this.landEffectTemplate.active = false;
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        this._releaseAllActiveOrbs();
        this._drainPool(this._orbPool);
        this._drainPool(this._landFxPool);
    }

    private _onStart(data: ForceFeatureEntryData): void {
        if (this._busy) return;
        const fillCells = data?.fillCells ?? [];
        if (fillCells.length === 0) {
            Log.w('[StickyFillEffect] fillCells rỗng → done ngay');
            this._finish();
            return;
        }
        this._busy = true;
        this.node.active = true;
        this._releaseAllActiveOrbs();
        Log.d(`[StickyFillEffect] start — fill ${fillCells.length} cells (sequential)`);
        this._phaseCharge(fillCells);
    }

    // ─── PHASE 1: BẮT ĐẦU BẮN (không nhún Pot) ──────────────────────────────

    private _phaseCharge(fillCells: StickyCell[]): void {
        SoundManager.instance?.playSFX(this.sfxCharge);
        // Không tween scale Pot — Impact chạy ngay trước mỗi lần bắn orb.
        void this._launchNextOrb(fillCells, 0);
    }

    // ─── PHASE 2–4: IMPACT → DELAY → LAUNCH → LAND → CONVERT (từng ô) ───────

    private async _launchNextOrb(fillCells: StickyCell[], index: number): Promise<void> {
        if (index >= fillCells.length) {
            // Lần gọi này đến sau orbLaunchInterval kể từ landing cuối.
            // Chỉ emit DONE khi land FX cuối đã chạy đủ landFxDuration,
            // để CreditFlyInEffect không thể bắt đầu khi landing FX còn hiển thị.
            const remainingLandFx = Math.max(0, this.landFxDuration - this.orbLaunchInterval);
            this.scheduleOnce(() => this._finish(), Math.max(0.35, remainingLandFx));
            return;
        }

        // Trước mỗi lần bắn: Pot play LV{level}_Impact → (SFX sớm) → phóng orb.
        await this._playPotImpactThenDelay();
        // sx_pot_hit sớm hơn visual orb một chút (potHitSfxLead).
        SoundManager.instance?.playSfxByName('sxPotHit');
        const lead = Math.max(0, this.potHitSfxLead);
        if (lead > 0) await this._wait(lead);

        const cell = fillCells[index];
        const target = this._cellWorldPos(cell);

        if (!target) {
            Log.w(`[StickyFillEffect] no target r${cell.reel}row${cell.row} → convert skip orb`);
            this._convertCell(cell);
            this.scheduleOnce(() => { void this._launchNextOrb(fillCells, index + 1); }, this.orbLaunchInterval);
            return;
        }

        if (!this.orbTemplate) {
            Log.w('[StickyFillEffect] orbTemplate chưa gán — convert không có orb bay');
            this._onOrbLand(target);
            this._convertCell(cell);
            this.scheduleOnce(() => { void this._launchNextOrb(fillCells, index + 1); }, this.orbLaunchInterval);
            return;
        }

        const potPos = this.potNode?.worldPosition.clone() ?? new Vec3();
        const orb = this._acquireOrb();
        if (!orb) {
            this._onOrbLand(target);
            this._convertCell(cell);
            this.scheduleOnce(() => { void this._launchNextOrb(fillCells, index + 1); }, this.orbLaunchInterval);
            return;
        }

        // Parent giữ scale gốc. Child Particle (scale ~50) zoom 0 → gốc.
        // Phải set scale=0 + scaleSpace=Local TRƯỚC khi active/play — Circle-Light dùng
        // World scaleSpace + playOnAwake nên scale node trước đây không thấy.
        this._resetOrbRootScale(orb);
        const childScales = this._prepareOrbChildrenScaleIn(orb);
        orb.setWorldPosition(potPos);
        orb.active = true;
        this._playOrbParticles(orb);
        this._activeOrbs.push(orb);

        const hop = new Vec3(potPos.x, potPos.y + 60, potPos.z);
        const scaleIn = Math.max(0.01, this.orbScaleInDuration);

        Log.d(`[StickyFillEffect] orb ${index + 1}/${fillCells.length} → r${cell.reel}row${cell.row} children=${childScales.length}`);
        const moveTw = tween(orb)
            .to(0.1, { worldPosition: hop })
            .to(this.orbFallDuration, { worldPosition: target }, { easing: 'quadIn' });

        for (const { node, endScale } of childScales) {
            Log.d(`[StickyFillEffect] scale-in ${node.name} 0 → (${endScale.x},${endScale.y},${endScale.z})`);
            tween(node)
                .to(scaleIn, { scale: endScale }, { easing: 'sineOut' })
                .start();
        }

        moveTw
            .call(() => {
                this._onOrbLand(target);
                this._releaseOrb(orb);
                this._convertCell(cell);
                this.scheduleOnce(() => { void this._launchNextOrb(fillCells, index + 1); }, this.orbLaunchInterval);
            })
            .start();
    }

    /**
     * Pot play LV{level}_Impact → resolve sớm (overlap + potHitSfxLead)
     * để caller kịp play SFX rồi đợi lead trước khi bắn orb (visual timing giữ nguyên).
     */
    private async _playPotImpactThenDelay(): Promise<void> {
        const pot = this._findPotController();
        const early = Math.max(0, this.impactEarlyLaunch) + Math.max(0, this.potHitSfxLead);
        if (pot) {
            await pot.playImpactAsync(early);
        } else {
            Log.w('[StickyFillEffect] PotController not found — skip Impact anim');
        }
        await this._wait(Math.max(0, this.impactToLaunchDelay));
    }

    private _resetOrbRootScale(orb: Node): void {
        const t = this.orbTemplate;
        if (t?.isValid) {
            orb.setScale(t.scale);
        } else {
            orb.setScale(1, 1, 1);
        }
    }

    /**
     * Child ParticleSystem (CircleLight*) scale ~50.
     * Ép scaleSpace=Local rồi set scale=0 — World space khiến scale node không ảnh hưởng visual.
     */
    private _prepareOrbChildrenScaleIn(orb: Node): { node: Node; endScale: Vec3 }[] {
        const result: { node: Node; endScale: Vec3 }[] = [];
        const templateChildren = this.orbTemplate?.children ?? [];
        for (let i = 0; i < orb.children.length; i++) {
            const child = orb.children[i];
            if (!child?.isValid) continue;
            Tween.stopAllByTarget(child);

            const tmpl = templateChildren[i];
            const endScale = tmpl?.isValid
                ? tmpl.scale.clone()
                : (child.scale.x === 0 && child.scale.y === 0
                    ? new Vec3(50, 50, 50)
                    : child.scale.clone());

            // Local = 0 — particle size theo scale node
            for (const ps of child.getComponents(ParticleSystem)) {
                (ps as any).scaleSpace = 0;
                ps.stop();
                ps.clear();
            }

            // Tránh scale (0,0,0) — một số ParticleSystem bỏ qua transform zero.
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

    private _restoreOrbChildrenScale(orb: Node): void {
        const templateChildren = this.orbTemplate?.children ?? [];
        for (let i = 0; i < orb.children.length; i++) {
            const child = orb.children[i];
            if (!child?.isValid) continue;
            Tween.stopAllByTarget(child);
            const tmpl = templateChildren[i];
            if (tmpl?.isValid) {
                child.setScale(tmpl.scale);
            }
        }
    }

    private _findPotController(): PotController | null {
        if (!this.potNode?.isValid) return null;
        return this.potNode.getComponent(PotController)
            ?? this.potNode.getComponentInChildren(PotController)
            ?? this.potNode.parent?.getComponent(PotController)
            ?? null;
    }

    private _wait(sec: number): Promise<void> {
        return new Promise((resolve) => {
            this.scheduleOnce(() => resolve(), sec);
        });
    }

    private _convertCell(cell: StickyCell): void {
        // Va chạm + tạo StickyRed → progressive sticky land (giống normal trúng Sticky).
        SoundManager.instance?.playStickyLandSfx();
        const view = this._getSymbolView(cell);
        if (!view) {
            Log.w(`[StickyFillEffect] no SymbolView r${cell.reel}row${cell.row}`);
            return;
        }
        view.applyStickyRedFill(cell.credit ?? 0);
    }

    private _onOrbLand(worldPos: Vec3): void {
        this._spawnLandFx(worldPos);
        this._shakeScreen();
    }

    // ─── PHASE 5: HANDOFF ───────────────────────────────────────────────────

    private _finish(): void {
        this._busy = false;
        Log.d('[StickyFillEffect] done — emit STICKY_FILL_DONE');
        EventBus.instance.emit(GameEvents.STICKY_FILL_DONE);
    }

    // ─── ORB / LAND FX POOL ─────────────────────────────────────────────────

    private _acquireOrb(): Node | null {
        if (!this.orbTemplate) return null;
        let orb = this._orbPool.get();
        if (!orb || !orb.isValid) {
            orb = instantiate(this.orbTemplate);
        }
        Tween.stopAllByTarget(orb);
        // Chưa active — tránh playOnAwake phát particle full size trước khi scale=0.
        orb.active = false;
        orb.setParent(this.node);
        this._stopAllChildParticles(orb);
        return orb;
    }

    private _releaseOrb(orb: Node): void {
        if (!orb || !orb.isValid) return;
        Tween.stopAllByTarget(orb);
        this._stopAllChildParticles(orb);
        this._restoreOrbChildrenScale(orb);
        orb.removeFromParent();
        orb.active = false;
        this._orbPool.put(orb);
        const idx = this._activeOrbs.indexOf(orb);
        if (idx >= 0) this._activeOrbs.splice(idx, 1);
    }

    private _releaseAllActiveOrbs(): void {
        for (const orb of [...this._activeOrbs]) {
            this._releaseOrb(orb);
        }
        this._activeOrbs.length = 0;
    }

    private _spawnLandFx(worldPos: Vec3): void {
        if (!this.landEffectTemplate?.isValid) return;

        let fx = this._landFxPool.get();
        if (!fx || !fx.isValid) {
            fx = instantiate(this.landEffectTemplate);
        }

        fx.setParent(this.node);
        fx.setWorldPosition(worldPos);
        fx.active = true;
        this._playAllChildParticles(fx);

        this.scheduleOnce(() => {
            if (!fx.isValid) return;
            this._stopAllChildParticles(fx);
            fx.removeFromParent();
            fx.active = false;
            this._landFxPool.put(fx);
        }, Math.max(0, this.landFxDuration));
    }

    /** Active node + play lại toàn bộ ParticleSystem (kể cả child đang inactive). */
    private _playAllChildParticles(root: Node): void {
        const walk = (node: Node) => {
            const pss = node.getComponents(ParticleSystem);
            if (pss.length > 0) node.active = true;
            for (const ps of pss) {
                ps.loop = false;
                ps.stop();
                ps.clear();
                ps.play();
            }
            for (const child of node.children) {
                walk(child);
            }
        };
        walk(root);
    }

    private _stopAllChildParticles(root: Node): void {
        for (const ps of root.getComponentsInChildren(ParticleSystem)) {
            ps.stop();
            ps.clear();
        }
    }

    private _drainPool(pool: NodePool): void {
        while (pool.size() > 0) {
            const n = pool.get();
            if (n?.isValid) n.destroy();
        }
    }

    // ─── REEL CELL HELPERS ──────────────────────────────────────────────────

    /**
     * row convention (stickyCells / CreditFlyIn):
     *   row 0 = Bot → symbolNodes[3], row 1 = Mid → [2], row 2 = Top → [1].
     */
    private _symbolNodeIndex(cell: StickyCell): number {
        return 3 - cell.row;
    }

    private _getSymbolView(cell: StickyCell): SymbolView | null {
        if (!this.slotMachine) return null;
        const reel = this.slotMachine.reels[cell.reel];
        if (!reel) return null;
        const symbolNode = reel.symbolNodes[this._symbolNodeIndex(cell)];
        return symbolNode?.getComponent(SymbolView) ?? null;
    }

    private _cellWorldPos(cell: StickyCell): Vec3 | null {
        if (!this.slotMachine) return null;
        const reel = this.slotMachine.reels[cell.reel];
        if (!reel) return null;
        const symbolNode = reel.symbolNodes[this._symbolNodeIndex(cell)];
        if (!symbolNode) return null;
        return symbolNode.worldPosition.clone();
    }

    private _shakeScreen(): void {
        if (!this.screenShakeNode || !this.screenShakeNode.isValid) return;
        const base = this.screenShakeNode.position.clone();
        Tween.stopAllByTarget(this.screenShakeNode);
        tween(this.screenShakeNode)
            .to(0.04, { position: new Vec3(base.x + 4, base.y - 4, base.z) })
            .to(0.04, { position: new Vec3(base.x - 4, base.y + 2, base.z) })
            .to(0.04, { position: base })
            .start();
    }
}
