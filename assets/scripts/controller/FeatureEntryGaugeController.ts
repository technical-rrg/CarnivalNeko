/**
 * FeatureEntryGaugeController — Reel UI Gauge (chữ tượng hình 2 cột trái/phải).
 *
 * ★ FEATURE ENTRY LOGIC ADDED (Concept & System Design v260610, trang 14–18)
 *
 * 10 hình chữ tượng hình Ai Cập được đặt ở 2 trụ (pillar) trái/phải của khung Reel,
 * hoạt động như một "gauge" (thanh nạp). Khi số Sticky tích lũy đạt ngưỡng,
 * đèn sáng lần lượt theo thứ tự:
 *   bottom-left(1) → bottom-right(2) → 2nd-left(3) → 2nd-right(4) → …
 *   → top-left(9) → top-right(10)
 *
 * Khi vào Feature → ẩn gauge + reset đèn (StickyAccumulated=0).
 * Thoát feature → hiện lại gauge đã tắt; không giữ lit stage cũ.
 *
 * ── GAUGE DATA (server API) ──
 *   StickyAccumulated = Red Sticky tích lũy (normal spin only) → lighting stage 0..10.
 *   StickyEarned      = Red Sticky landed spin này → log / earned payload.
 *   PotVisualLevel chỉ dùng cho Pot UI — KHÔNG map sang 10 ô gauge.
 * ── CÁCH KÍCH HOẠT ──
 *   GameManager emit FEATURE_GAUGE_UPDATE khi reel dừng (đọc StickyAccumulated/StickyEarned).
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "FeatureEntryGauge" trong scene (con của khung Reel/Canvas).
 *   2. Gắn component này vào node đó.
 *   3. Trên mỗi trụ đặt sẵn 5 hình off (luôn hiển thị) + 5 node "lit"/glow (overlay).
 *   4. CÁCH A — mảng phẳng 10 phần tử (khuyến nghị nếu scene có sẵn 1 list):
 *      Kéo 10 node lit vào `litNodes` theo thứ tự stage 1→10 (index 0 = stage 1).
 *   5. CÁCH B — 2 trụ trái/phải:
 *      Kéo 5 node lit TRỤ TRÁI (DƯỚI→TRÊN) vào `leftLitNodes`,
 *      5 node lit TRỤ PHẢI (DƯỚI→TRÊN) vào `rightLitNodes`.
 *      → stage 1 = left[0], stage 2 = right[0], stage 3 = left[1], … (flat index = stage - 1).
 *   6. (Optional) `sfxLightOn` — override clip khi đèn bật.
 *      Null → SoundManager play `sx_indicater_lighton`.
 *   7. (Optional) Node `DotHighlight` (sp.Skeleton) — effect spine khi đèn bật.
 *      Không gán `lightSpineEffectNode` → tự lấy child tên "DotHighlight".
 *   8. (Optional) Kéo Node Pot vào `potShakeNode`; SlotMachine tự rung (parent / `slotShakeNode`).
 */

import {
    _decorator, Component, Node, tween, Tween, Vec3, UIOpacity, AudioClip,
    ParticleSystem, instantiate, sp,
} from 'cc';
import { EventBus }      from '../core/EventBus';
import { GameEvents }    from '../core/GameEvents';
import { GameData }      from '../data/GameData';
import { SoundManager }  from '../manager/SoundManager';
import { gaugeStageToPillar, gaugeStageToFlatIndex, FEATURE_GAUGE_MAX_STAGE } from '../data/SlotTypes';
import { SlotMachineController } from './SlotMachineController';

const { ccclass, property } = _decorator;

export interface FeatureGaugeUpdatePayload {
    /** Lighting stage đích (0..10). */
    stage: number;
    /** Tổng Sticky tích lũy hiện tại (chỉ để log/hiển thị). */
    accumulated: number;
    /** Số Sticky vừa kiếm được spin này. */
    earned: number;
    /** true = bật đèn có animation; false = set tĩnh (init/resume). */
    animate: boolean;
    /** true = không phát sfxLightOn (Pot đã play sx_pot_effect_lvl_ cùng lúc). */
    suppressSfx?: boolean;
    /** true = không rung Pot / SlotMachine (Pot đang transition). */
    skipPotShake?: boolean;
}

@ccclass('FeatureEntryGaugeController')
export class FeatureEntryGaugeController extends Component {

    @property({
        type: [Node],
        tooltip: '10 node lit theo thứ tự stage 1→10 (index 0 = stage 1, bottom-left). Ưu tiên hơn left/right nếu đủ 10 phần tử.',
    })
    litNodes: Node[] = [];

    @property({
        type: [Node],
        tooltip: '5 node "lit"/glow của TRỤ TRÁI, thứ tự DƯỚI→TRÊN (index 0 = bottom). Dùng khi không kéo litNodes.',
    })
    leftLitNodes: Node[] = [];

    @property({
        type: [Node],
        tooltip: '5 node "lit"/glow của TRỤ PHẢI, thứ tự DƯỚI→TRÊN (index 0 = bottom). Dùng khi không kéo litNodes.',
    })
    rightLitNodes: Node[] = [];

    @property({ type: AudioClip, tooltip: 'SFX phát mỗi khi 1 đèn gauge bật (optional).' })
    sfxLightOn: AudioClip | null = null;

    @property({
        type: Node,
        tooltip: 'Node mẫu chứa ParticleSystem phát tại ô vừa sáng. Template sẽ mặc định active=false.',
    })
    lightEffectTemplate: Node | null = null;

    @property({ tooltip: 'Thời gian giữ mỗi particle effect trước khi huỷ (giây).' })
    lightEffectLifetime: number = 2;

    @property({
        type: Node,
        tooltip: 'Node chứa sp.Skeleton — reuse mỗi lần đèn bật. Null = child "DotHighlight".',
    })
    lightSpineEffectNode: Node | null = null;

    @property({ tooltip: 'Tên animation Spine (loop). Để trống = defaultAnimation / "animation".' })
    lightSpineAnim: string = 'animation';

    @property({ tooltip: 'Thời gian play loop trước khi bắt đầu fade (giây).' })
    lightSpineLoopDuration: number = 2;

    @property({ tooltip: 'Thời gian alpha mờ dần rồi tắt node (giây).' })
    lightSpineFadeDuration: number = 0.45;

    @property({
        type: Node,
        tooltip: 'Node Pot ở giữa màn hình — rung nhẹ mỗi khi đèn mới bật (optional).',
    })
    potShakeNode: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Node SlotMachine rung khi đèn bật. Null = parent (nếu là SlotMachine) hoặc tự tìm SlotMachineController.',
    })
    slotShakeNode: Node | null = null;

    @property({ tooltip: 'Thời gian fade-in khi 1 đèn bật (giây).' })
    litFadeDuration: number = 0.25;

    /** Stage đang hiển thị trên UI (0..10). */
    private _shownStage: number = 0;
    /** Tuỳ chọn SFX/rung từ payload FEATURE_GAUGE_UPDATE gần nhất. */
    private _suppressSfx: boolean = false;
    private _skipPotShake: boolean = false;
    /** Scale gốc từ Editor (uuid → scale) — lit overlay không bị ép về (1,1,1). */
    private _baseScales: Map<string, Vec3> = new Map();
    /** Gauge bị ẩn vì đang trong feature (PickGame / TopUp / FreeSpin). */
    private _hiddenForFeature: boolean = false;
    private _wasActiveBeforeFeature: boolean = true;
    /** Pick Game: PICK_GAME_OPEN đánh dấu — ẩn khi TOPUP_TRANSITION_READY. */
    private _pendingPickGameHide: boolean = false;
    /** Các effect clone đang phát để dọn an toàn khi component bị huỷ. */
    private _activeLightEffects: Set<Node> = new Set();
    /** Token hủy callback fade spine khi đèn mới bật chồng lên. */
    private _spineEffectToken: number = 0;
    private _spineFadeCb: (() => void) | null = null;
    /** Base position khi bắt đầu rung SlotMachine (tránh lệch nếu bị cắt giữa chừng). */
    private _slotShakeBase: Vec3 | null = null;
    private _slotShakeProxy: { x: number; y: number } = { x: 0, y: 0 };
    /** true từ LONG_SPIN_TRIGGERED/VFX_START đến khi zoom về scale gốc (LONG_SPIN_ZOOM_DONE). */
    private _longSpinBusy: boolean = false;
    /** Gauge update bị hoãn đến sau Long Spin zoom xong. */
    private _pendingGaugeUpdate: FeatureGaugeUpdatePayload | null = null;

    onLoad(): void {
        if (this.lightEffectTemplate) {
            this.lightEffectTemplate.active = false;
        }
        const spineFx = this._resolveSpineEffectNode();
        if (spineFx) {
            spineFx.active = false;
            this._ensureSpineOpacity(spineFx).opacity = 255;
        }
        EventBus.instance.on(GameEvents.FEATURE_GAUGE_UPDATE, this._onUpdate, this);
        EventBus.instance.on(GameEvents.FEATURE_GAUGE_RESET,  this._onReset,  this);
        EventBus.instance.on(GameEvents.LONG_SPIN_TRIGGERED, this._onLongSpinBusy, this);
        EventBus.instance.on(GameEvents.LONG_SPIN_VFX_START, this._onLongSpinBusy, this);
        EventBus.instance.on(GameEvents.LONG_SPIN_ZOOM_DONE, this._onLongSpinZoomDone, this);
        EventBus.instance.on(GameEvents.REELS_START_SPIN, this._onReelsStartSpin, this);
        // Pick Game — ẩn khi Transition fade-in xong (READY)
        EventBus.instance.on(GameEvents.PICK_GAME_OPEN,         this._onPickGameOpen,       this);
        EventBus.instance.on(GameEvents.TOPUP_TRANSITION_READY, this._onPickGameTransitionReady, this);
        EventBus.instance.on(GameEvents.PICK_GAME_ENTRY_DONE,   this._onPickGameEntryDone,  this);
        EventBus.instance.on(GameEvents.PICK_GAME_CLOSE,        this._onFeatureEnded,       this);
        // TopUp / FreeSpin — ẩn khi UI prepare sau READY (TOPUP_START / FREE_SPIN_*)
        EventBus.instance.on(GameEvents.TOPUP_START,            this._onFeatureEntered,     this);
        EventBus.instance.on(GameEvents.FREE_SPIN_START,        this._onFeatureEntered,     this);
        EventBus.instance.on(GameEvents.FREE_SPIN_GOLD_START,    this._onFeatureEntered,     this);
        // Hiện lại khi thoát feature
        EventBus.instance.on(GameEvents.TOPUP_END_POPUP_CLOSED, this._onFeatureEnded,       this);
        EventBus.instance.on(GameEvents.FREE_SPIN_END,          this._onFeatureEnded,       this);
    }

    start(): void {
        this._cacheBaseScales();
        // Khôi phục trạng thái gauge (khi mở lại game / reload scene)
        this._applyStage(GameData.instance.featureGaugeStage, false);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        this._cancelSpineEffect();
        for (const effect of this._activeLightEffects) {
            if (effect.isValid) effect.destroy();
        }
        this._activeLightEffects.clear();
        this._restoreSlotShakeBase();
    }

    // ─── EVENT HANDLERS ─────────────────────────────────────────────────────

    private _onUpdate(payload: FeatureGaugeUpdatePayload): void {
        // Đang Long Spin / Zoom → hoãn diễn light + rung đến khi zoom về scale gốc
        if (this._longSpinBusy && (payload?.animate ?? true)) {
            this._pendingGaugeUpdate = {
                stage: payload?.stage ?? 0,
                accumulated: payload?.accumulated ?? 0,
                earned: payload?.earned ?? 0,
                animate: true,
                suppressSfx: payload?.suppressSfx,
                skipPotShake: payload?.skipPotShake,
            };
            return;
        }

        const stage = Math.max(0, Math.min(FEATURE_GAUGE_MAX_STAGE, payload?.stage ?? 0));
        this._suppressSfx = payload?.suppressSfx ?? false;
        this._skipPotShake = payload?.skipPotShake ?? false;
        this._applyStage(stage, payload?.animate ?? true);
    }

    private _onLongSpinBusy(): void {
        this._longSpinBusy = true;
    }

    private _onLongSpinZoomDone(): void {
        this._longSpinBusy = false;
        const pending = this._pendingGaugeUpdate;
        if (!pending) return;
        this._pendingGaugeUpdate = null;
        this._onUpdate(pending);
    }

    private _onReelsStartSpin(): void {
        this._longSpinBusy = false;
        this._pendingGaugeUpdate = null;
        this._restoreSlotShakeBase();
    }

    private _onReset(): void {
        this._pendingGaugeUpdate = null;
        this._longSpinBusy = false;
        this._resetGaugeToZero(true);
    }

    /** PICK_GAME_OPEN: chỉ đánh dấu — ẩn khi TransitionPopup READY. */
    private _onPickGameOpen(): void {
        this._wasActiveBeforeFeature = this.node.active;
        this._pendingPickGameHide = true;
    }

    /** TOPUP_TRANSITION_READY: overlay phủ kín → mới ẩn gauge. */
    private _onPickGameTransitionReady(): void {
        if (!this._pendingPickGameHide) return;
        this._pendingPickGameHide = false;
        this._hideForFeature();
    }

    /** Fallback nếu SHOW bị miss / bỏ qua transition. */
    private _onPickGameEntryDone(): void {
        if (!this._pendingPickGameHide) return;
        this._pendingPickGameHide = false;
        this._hideForFeature();
    }

    /** Đã vào TopUp / FreeSpin (UI prepare dưới TransitionPopup). */
    private _onFeatureEntered(): void {
        this._hideForFeature();
    }

    private _hideForFeature(): void {
        if (this._hiddenForFeature) return;
        this._wasActiveBeforeFeature = this.node.active;
        this._hiddenForFeature = true;
        this.node.active = false;
        // Reset đèn ngay khi vào feature (StickyAccumulated=0) —
        // tránh thoát feature vẫn còn lit tới spin normal tiếp theo.
        this._pendingGaugeUpdate = null;
        this._resetGaugeToZero(false);
    }

    /** Thoát feature → hiện lại gauge đã reset (stage 0). */
    private _onFeatureEnded(): void {
        this._pendingPickGameHide = false;
        if (!this._hiddenForFeature) return;
        this._hiddenForFeature = false;
        // Safety: đảm bảo GameData + UI đều tắt đèn kể cả khi reset lúc ẩn bị miss.
        this._resetGaugeToZero(false);
        if (this._wasActiveBeforeFeature) {
            this.node.active = true;
        }
    }

    /** Tắt toàn bộ light + đồng bộ GameData (accumulated/stage = 0). */
    private _resetGaugeToZero(animate: boolean): void {
        GameData.instance.featureGaugeAccumulated = 0;
        this._applyStage(0, animate);
    }

    // ─── CORE ───────────────────────────────────────────────────────────────

    /** Bật/tắt đèn để khớp `targetStage`. Bật thêm đèn mới có animation nếu animate. */
    private _applyStage(targetStage: number, animate: boolean): void {
        const prev = this._shownStage;

        for (let stage = 1; stage <= FEATURE_GAUGE_MAX_STAGE; stage++) {
            const node = this._nodeForStage(stage);
            if (!node) continue;
            const shouldLit = stage <= targetStage;
            const isNewlyLit = shouldLit && stage > prev && animate;

            if (isNewlyLit) {
                this._lightOn(node, stage);
            } else if (shouldLit) {
                Tween.stopAllByTarget(node);
                node.active = true;
                this._applyBaseScale(node);
                const op = node.getComponent(UIOpacity);
                if (op) op.opacity = 255;
            } else {
                Tween.stopAllByTarget(node);
                node.active = false;
            }
        }

        this._shownStage = targetStage;
        GameData.instance.featureGaugeStage = targetStage;
    }

    /** Bật 1 đèn với fade + bounce nhẹ quanh scale gốc (không đổi position). */
    private _lightOn(node: Node, stage: number): void {
        Tween.stopAllByTarget(node);
        node.active = true;
        const base = this._baseScaleOf(node);
        node.setScale(base);

        const op = node.getComponent(UIOpacity);
        if (op && this.litFadeDuration > 0) {
            op.opacity = 0;
            tween(op).to(this.litFadeDuration, { opacity: 255 }).start();
        }
        const bounce = new Vec3(base.x * 1.12, base.y * 1.12, base.z);
        tween(node)
            .to(0.12, { scale: bounce })
            .to(0.12, { scale: base.clone() })
            .start();

        this._playLightEffect(node);
        this._playLightSpineEffect(node);
        if (!this._suppressSfx) {
            if (this.sfxLightOn) {
                SoundManager.instance?.playSFX(this.sfxLightOn);
            } else {
                SoundManager.instance?.playSfxByName('sxIndicaterLighton');
            }
        }
        if (!this._skipPotShake) {
            this._shakePot();
            this._shakeSlotMachine();
        }
        EventBus.instance.emit(GameEvents.FEATURE_GAUGE_LIGHT_ON, { stage });
    }

    /** Clone particle template (nếu có), đặt tại ô vừa sáng và phát 1 lần. */
    private _playLightEffect(litNode: Node): void {
        const template = this.lightEffectTemplate;
        if (!template?.isValid) return;

        const effect = instantiate(template);
        effect.setParent(template.parent ?? this.node);
        effect.setWorldPosition(litNode.worldPosition);
        effect.active = true;
        this._activeLightEffects.add(effect);

        for (const particle of effect.getComponentsInChildren(ParticleSystem)) {
            particle.loop = false;
            particle.stop();
            particle.clear();
            particle.play();
        }

        this.scheduleOnce(() => {
            this._activeLightEffects.delete(effect);
            if (effect.isValid) effect.destroy();
        }, Math.max(0, this.lightEffectLifetime));
    }

    /**
     * Reuse 1 node spine: active + đặt đúng ô light → loop 2s → fade alpha → active false.
     * Lần sau bật lại với full alpha.
     */
    private _playLightSpineEffect(litNode: Node): void {
        const effect = this._resolveSpineEffectNode();
        if (!effect?.isValid) return;

        this._cancelSpineEffect();
        const token = ++this._spineEffectToken;

        const op = this._ensureSpineOpacity(effect);
        Tween.stopAllByTarget(op);
        Tween.stopAllByTarget(effect);

        effect.setWorldPosition(litNode.worldPosition.clone());
        effect.active = true;
        op.opacity = 255;

        const skel = effect.getComponent(sp.Skeleton)
            ?? effect.getComponentInChildren(sp.Skeleton);
        const animName = this._resolveSpineAnimName(skel);
        if (skel) {
            skel.setAnimation(0, animName, true);
        }

        const loopDur = Math.max(0, this.lightSpineLoopDuration);
        const fadeDur = Math.max(0.05, this.lightSpineFadeDuration);

        this._spineFadeCb = () => {
            this._spineFadeCb = null;
            if (token !== this._spineEffectToken) return;
            if (!effect.isValid) return;

            tween(op)
                .to(fadeDur, { opacity: 0 })
                .call(() => {
                    if (token !== this._spineEffectToken) return;
                    if (!effect.isValid) return;
                    if (skel?.isValid) {
                        skel.clearTracks();
                    }
                    effect.active = false;
                    op.opacity = 255;
                })
                .start();
        };
        this.scheduleOnce(this._spineFadeCb, loopDur);
    }

    private _cancelSpineEffect(): void {
        if (this._spineFadeCb) {
            this.unschedule(this._spineFadeCb);
            this._spineFadeCb = null;
        }
        const effect = this._resolveSpineEffectNode();
        if (!effect?.isValid) return;
        const op = effect.getComponent(UIOpacity);
        if (op) Tween.stopAllByTarget(op);
        Tween.stopAllByTarget(effect);
    }

    private _resolveSpineEffectNode(): Node | null {
        if (this.lightSpineEffectNode?.isValid) return this.lightSpineEffectNode;
        const named = this.node.getChildByName('DotHighlight');
        if (named?.isValid) {
            this.lightSpineEffectNode = named;
            return named;
        }
        return null;
    }

    private _ensureSpineOpacity(effect: Node): UIOpacity {
        let op = effect.getComponent(UIOpacity);
        if (!op) op = effect.addComponent(UIOpacity);
        return op;
    }

    private _resolveSpineAnimName(_skel: sp.Skeleton | null): string {
        if (this.lightSpineAnim && this.lightSpineAnim.trim().length > 0) {
            return this.lightSpineAnim.trim();
        }
        return 'animation';
    }

    /** Rung nhẹ Pot ở giữa màn hình (doc: "shaking effect of the Pot in the screen center"). */
    private _shakePot(): void {
        if (!this.potShakeNode || !this.potShakeNode.isValid) return;
        const base = this.potShakeNode.position.clone();
        Tween.stopAllByTarget(this.potShakeNode);
        tween(this.potShakeNode)
            .to(0.05, { position: new Vec3(base.x - 6, base.y, base.z) })
            .to(0.05, { position: new Vec3(base.x + 6, base.y, base.z) })
            .to(0.05, { position: new Vec3(base.x - 3, base.y, base.z) })
            .to(0.05, { position: base })
            .start();
    }

    /** Rung cả SlotMachine (reels) khi 1 ô light bật — không chỉ Pot.
     *  Dùng proxy offset, KHÔNG Tween.stopAllByTarget(SlotMachine) để tránh cắt Long Spin zoom. */
    private _shakeSlotMachine(): void {
        const node = this._resolveSlotShakeNode();
        if (!node?.isValid) return;

        this._restoreSlotShakeBase();
        this._slotShakeBase = node.position.clone();
        this._slotShakeProxy.x = 0;
        this._slotShakeProxy.y = 0;

        const apply = () => {
            if (!node.isValid || !this._slotShakeBase) return;
            node.setPosition(
                this._slotShakeBase.x + this._slotShakeProxy.x,
                this._slotShakeBase.y + this._slotShakeProxy.y,
                this._slotShakeBase.z,
            );
        };

        Tween.stopAllByTarget(this._slotShakeProxy);
        tween(this._slotShakeProxy)
            .to(0.05, { x: -5, y: 2 }, { onUpdate: apply })
            .to(0.05, { x: 5, y: -2 }, { onUpdate: apply })
            .to(0.05, { x: -3, y: 0 }, { onUpdate: apply })
            .to(0.05, { x: 0, y: 0 }, { onUpdate: apply })
            .call(() => {
                apply();
                this._slotShakeBase = null;
            })
            .start();
    }

    private _resolveSlotShakeNode(): Node | null {
        if (this.slotShakeNode?.isValid) return this.slotShakeNode;
        const parent = this.node.parent;
        if (parent?.getComponent(SlotMachineController)) return parent;
        const smc = this.node.scene?.getComponentInChildren(SlotMachineController);
        return smc?.node ?? null;
    }

    private _restoreSlotShakeBase(): void {
        Tween.stopAllByTarget(this._slotShakeProxy);
        this._slotShakeProxy.x = 0;
        this._slotShakeProxy.y = 0;
        const node = this._resolveSlotShakeNode();
        if (node?.isValid && this._slotShakeBase) {
            node.setPosition(this._slotShakeBase);
        }
        this._slotShakeBase = null;
    }

    /** Lấy node lit ứng với lighting stage (1..10). stage N → flat index N-1. */
    private _nodeForStage(stage: number): Node | null {
        const flatIdx = gaugeStageToFlatIndex(stage);
        if (this.litNodes.length >= FEATURE_GAUGE_MAX_STAGE) {
            return this.litNodes[flatIdx] ?? null;
        }
        const pos = gaugeStageToPillar(stage);
        if (!pos) return null;
        const arr = pos.pillar === 0 ? this.leftLitNodes : this.rightLitNodes;
        return arr[pos.index] ?? null;
    }

    /** Lưu scale gốc từ Editor trước khi tween (lit node thường active=false lúc start). */
    private _cacheBaseScales(): void {
        this._baseScales.clear();
        for (let stage = 1; stage <= FEATURE_GAUGE_MAX_STAGE; stage++) {
            const node = this._nodeForStage(stage);
            if (node?.isValid) {
                this._baseScales.set(node.uuid, node.scale.clone());
            }
        }
    }

    private _baseScaleOf(node: Node): Vec3 {
        let base = this._baseScales.get(node.uuid);
        if (!base) {
            base = node.scale.clone();
            this._baseScales.set(node.uuid, base);
        }
        return base.clone();
    }

    private _applyBaseScale(node: Node): void {
        node.setScale(this._baseScaleOf(node));
    }
}
