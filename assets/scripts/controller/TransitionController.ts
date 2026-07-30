/**
 * TransitionController - Hiệu ứng transition giữa các màn hình.
 *
 * Setup trong Editor:
 *   1. Tạo Node "TransitionOverlay" (overlay toàn màn hình, ban đầu inactive).
 *   2. Gắn component này vào node đó.
 *   3. overlayNode: Node nền tối (kéo Background/Overlay vào) — có UIOpacity để fade.
 *   4. Đặt node này trên cùng hierarchy (order cao nhất).
 *   5. iconNode: Spine với animation Idle_LV6 và LV6_transition_LV0.
 *   6. effectNode: Particle active khi bắt đầu (Idle_LV6).
 *   7. effectNode2: Particle active khi icon bay tới đích.
 *
 * Flow:
 *   GUIDE_COMPLETE → icon bay tới Pot → effect → overlay fade out → ẩn hẳn
 *   → mới handoff chest sang Pot.potSpine → TRANSITION_DONE
 */

import { _decorator, Component, UIOpacity, tween, Tween, Node, Vec3, ParticleSystem, easing, sp, screen } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { SoundManager } from '../manager/SoundManager';
import { Log } from '../core/Logger';
import { PotController } from './PotController';
import { OrientationLayout } from './OrientationLayout';

const { ccclass, property } = _decorator;

@ccclass('TransitionController')
export class TransitionController extends Component {

    @property({ type: UIOpacity, tooltip: 'UIOpacity của root Transition (legacy / fallback fade)' })
    uiOpacity: UIOpacity | null = null;

    @property({
        type: Node,
        tooltip: 'Overlay nền tối (kéo node Overlay/Background vào).\nCần có UIOpacity — nếu chưa có sẽ tự add lúc runtime.',
    })
    overlayNode: Node | null = null;

    @property({ type: Node, tooltip: 'Icon node để hiển thị hiệu ứng bay' })
    iconNode: Node | null = null;

    @property({ type: Node, tooltip: 'Target node - nơi icon bay vào' })
    targetNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node (chứa nhiều particle con) - hiển thị khi iconNode zoom tới max (mặc định inactive)' })
    effectNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node 2 - hiển thị particle khi icon bay tới đích (mặc định inactive)' })
    effectNode2: Node | null = null;

    @property({ tooltip: 'Thời gian zoom in của icon (giây)' })
    iconZoomInDuration: number = 0.3;

    @property({ tooltip: 'Thời gian giữ Pot trên màn hình trước khi bay về đích (giây)' })
    holdBeforeFlyDuration: number = 1.0;

    @property({ tooltip: 'Thời gian icon bay vào target (giây) — gồm nhún → bay lên → hạ xuống' })
    iconFlyDuration: number = 2.0;

    @property({ tooltip: 'Độ nhún xuống nhẹ trước khi bay (local Y, pixel)' })
    flyDipOffset: number = 70;

    @property({ tooltip: 'Độ cao bay phía trên Pot trước khi hạ xuống (local Y, pixel)' })
    flyArcHeight: number = 200;

    @property({ tooltip: 'Thời gian zoom out của icon (giây)' })
    iconZoomOutDuration: number = 0.3;

    @property({ tooltip: 'Thời gian fade in overlay khi mở (giây)' })
    fadeInDuration: number = 0.2;

    @property({ tooltip: 'Thời gian giữ sau khi icon tới đích, trước khi fade overlay (giây)' })
    holdDuration: number = 1.0;

    @property({ tooltip: 'Thời gian overlay fade out trước khi ẩn (giây)' })
    fadeOutDuration: number = 0.35;

    @property({ type: Node, tooltip: 'Flash node (Sprite) — fade alpha khi ẩn, không tắt ngay' })
    flashNode: Node | null = null;

    @property({ tooltip: 'Thời gian flash fade out (giây)' })
    flashFadeOutDuration: number = 0.3;

    private _isPlaying: boolean = false;
    private _finishCb: (() => void) | null = null;
    private _pendingPot: PotController | null = null;

    /** true từ lúc bắt đầu dip/fly đến khi hạ cánh */
    private _flyActive: boolean = false;
    /** true sau khi icon đã hạ cánh (hold / fade) */
    private _hasLanded: boolean = false;
    private _landedSkel: sp.Skeleton | null = null;

    private readonly _targetLocalPos = new Vec3();
    private readonly _abovePotPos = new Vec3();
    private readonly _targetLocalScale = new Vec3();
    private readonly _midScale = new Vec3();

    // ─── LIFECYCLE ───

    onLoad(): void {
        this.node.active = false; // ẩn cho đến khi event trigger
        EventBus.instance.on(GameEvents.GUIDE_COMPLETE, this._onGuideComplete, this);
        screen.on('window-resize', this._onScreenChange, this);
        screen.on('orientation-change', this._onScreenChange, this);
    }

    onDestroy(): void {
        this._cleanupRunningTweens();
        this.unschedule(this._retargetFlyAfterLayout);
        this.unschedule(this._retargetFlyAfterLayoutLate);
        screen.off('window-resize', this._onScreenChange, this);
        screen.off('orientation-change', this._onScreenChange, this);
        EventBus.instance.offTarget(this);
    }

    /**
     * Xoay màn lúc Pot đang bay:
     * 1) Force OrientationLayout trên Pot/target ngay
     * 2) Retarget frame 0 + lần nữa sau 50ms (Widget/Responsive kịp settle)
     */
    private _onScreenChange(): void {
        if (!this._isPlaying) return;
        this._forceTargetLayoutNow();
        this.unschedule(this._retargetFlyAfterLayout);
        this.unschedule(this._retargetFlyAfterLayoutLate);
        this.scheduleOnce(this._retargetFlyAfterLayout, 0);
        this.scheduleOnce(this._retargetFlyAfterLayoutLate, 0.05);
    }

    private _retargetFlyAfterLayoutLate = (): void => {
        this._retargetFlyAfterLayout();
    };

    /** Refresh target từ Pot + apply OrientationLayout trên chuỗi parent. */
    private _forceTargetLayoutNow(): void {
        this._refreshTargetFromPot();
        let cur: Node | null = this.targetNode;
        for (let i = 0; i < 8 && cur?.isValid; i++) {
            const layout = cur.getComponent(OrientationLayout);
            if (layout) layout.applyOrientation();
            cur = cur.parent;
        }
    }

    private _refreshTargetFromPot(): void {
        const pot = this._pendingPot?.isValid ? this._pendingPot : this._findPotController();
        if (!pot?.isValid) return;
        const t = pot.getTransitionTargetNode();
        if (t?.isValid) this.targetNode = t;
        this._pendingPot = pot;
    }

    private _retargetFlyAfterLayout = (): void => {
        if (!this._isPlaying || !this.iconNode?.isValid) return;

        this._forceTargetLayoutNow();
        if (!this.targetNode?.isValid) return;

        this._computeFlyTarget();

        // Đã hạ cánh: snap icon + effect về Pot mới
        if (this._hasLanded) {
            this.iconNode.setPosition(this._targetLocalPos);
            this.iconNode.setScale(this._targetLocalScale);
            if (this.effectNode2?.isValid && this.effectNode2.active) {
                this.effectNode2.setWorldPosition(this.targetNode.getWorldPosition());
            }
            Log.d('[TransitionController] snap landed chest to new Pot pos after rotate');
            return;
        }

        // Đang bay: dừng tween cũ, bay tiếp từ vị trí hiện tại tới Pot mới (bỏ nhún)
        if (this._flyActive) {
            this._startChestFlyPath(0.45, true);
            Log.d(
                `[TransitionController] retarget fly → local(${this._targetLocalPos.x.toFixed(1)}, ${this._targetLocalPos.y.toFixed(1)})`,
            );
        }
        // Zoom / hold: _startChestFlyPath sẽ _computeFlyTarget lại khi bắt đầu bay
    };

    // ─── TRANSITION EFFECT ───

    private _onGuideComplete(): void {
        // Guide-first: GameEntryController.enterFromExternalGuide trigger sau khi lộ GameRoot
        // (GUIDE_COMPLETE thường fire trước khi Base/Transition tồn tại nếu Continue sớm)
        if (GameData.instance.guideFirstBoot) return;
        this._startGuideTransition();
    }

    /** Gọi từ TransitionLoader / GameEntryController khi load muộn hoặc sau reveal guide-first. */
    triggerGuideTransition(): void {
        this._startGuideTransition();
    }

    private _startGuideTransition(): void {
        if (this._isPlaying) return;
        this._isPlaying = true;
        this.node.active = true;
        this._resetOverlayOpacity(255);
        SoundManager.instance?.playNormalIntro();
        this.playIconFlyAnimation();
    }

    /**
     * Resume / không chạy fly: chuyển chest sang Pot anchor, không duplicate spine load.
     * Gọi sau ensureLoaded() khi bỏ qua GUIDE_COMPLETE animation.
     */
    handoffChestToPot(pot: PotController): void {
        if (!this.iconNode?.isValid || !pot?.isValid) return;
        this.targetNode = pot.getTransitionTargetNode();
        this._cleanupRunningTweens();

        const skel = this.iconNode.getComponent(sp.Skeleton);
        if (skel) {
            const level = GameData.instance.potLevel ?? 0;
            skel.setAnimation(0, `Idle_LV${level}`, true);
        }

        this._handoffChestToPot(pot);
        this.node.active = false;
        this._isPlaying = false;
        Log.d('[TransitionController] handoffChestToPot (no fly)');
    }

    playIconFlyAnimation(): void {
        if (!this.iconNode || !this.targetNode) {
            this._isPlaying = false;
            return;
        }
        this._cleanupRunningTweens();
        this._pendingPot = this._findPotController();
        this._flyActive = false;
        this._hasLanded = false;

        // targetNode = Pot anchor (empty) — iconNode bay tới rồi reparent SAU khi overlay ẩn
        this.iconNode.active = true;
        this.iconNode.setScale(new Vec3(0, 0, 0));

        // 1. Mới vào: play loop Idle_LV6 trên icon spine
        const skel = this.iconNode.getComponent(sp.Skeleton);
        this._landedSkel = skel;
        if (skel) {
            skel.setAnimation(0, 'Idle_LV6', true);
        }

        // 2. Mới vào: play particle effectNode
        if (this.effectNode) {
            this.effectNode.active = true;
            for (const ps of this.effectNode.getComponentsInChildren(ParticleSystem)) {
                ps.stop(); ps.play();
            }
        }

        this._resetFlashNode();

        const uiOpacity = this.iconNode.getComponent(UIOpacity);
        if (uiOpacity) uiOpacity.opacity = 255;

        tween(this.iconNode)
            // Zoom nhanh ra 0 → 1.3
            .to(this.iconZoomInDuration, { scale: new Vec3(1.3, 1.3, 1.3) })
            // Bounce nhẹ nhảy về 1
            .to(this.iconZoomOutDuration, { scale: new Vec3(1, 1, 1) })
            // Giữ yên trước khi bay
            .delay(this.holdBeforeFlyDuration)
            // Bắt đầu bay: target lấy lúc này (sau hold / có thể đã xoay)
            .call(() => {
                if (this.effectNode) {
                    for (const ps of this.effectNode.getComponentsInChildren(ParticleSystem)) ps.stop();
                    this.effectNode.active = false;
                }
                this._fadeOutFlashNode();
                this._startChestFlyPath();
            })
            .start();
    }

    /**
     * Bay tới Pot. Gọi lúc bắt đầu fly (và khi retarget sau xoay màn)
     * để luôn dùng targetNode world pos mới nhất.
     * @param skipDip true khi retarget giữa chừng — bỏ đoạn nhún, bay thẳng tới Pot mới.
     */
    private _startChestFlyPath(durationScale: number = 1, skipDip: boolean = false): void {
        if (!this.iconNode?.isValid || this._hasLanded) return;

        // Luôn lấy lại Pot anchor mới nhất (sau xoay màn)
        this._refreshTargetFromPot();
        if (!this.targetNode?.isValid) return;

        this._computeFlyTarget();
        this._flyActive = true;

        const flyDur = Math.max(0.05, this.iconFlyDuration * Math.max(0.2, durationScale));
        // Clone end values — Cocos snapshot props lúc tạo tween
        const above = this._abovePotPos.clone();
        const land = this._targetLocalPos.clone();
        const midScale = this._midScale.clone();
        const landScale = this._targetLocalScale.clone();

        Tween.stopAllByTarget(this.iconNode);
        let tw = tween(this.iconNode);

        if (!skipDip) {
            const startPos = this.iconNode.position.clone();
            const dipPos = new Vec3(startPos.x, startPos.y - Math.max(0, this.flyDipOffset), startPos.z);
            const dipT = flyDur * 0.18;
            const arcT = flyDur * 0.47;
            const landT = flyDur - dipT - arcT;
            tw = tw
                .to(dipT, { position: dipPos }, { easing: easing.sineOut })
                .to(arcT, { position: above, scale: midScale }, { easing: easing.cubicOut })
                .to(landT, { position: land, scale: landScale }, { easing: easing.cubicIn });
        } else {
            const arcT = flyDur * 0.55;
            const landT = flyDur - arcT;
            tw = tw
                .to(arcT, { position: above, scale: midScale }, { easing: easing.cubicOut })
                .to(landT, { position: land, scale: landScale }, { easing: easing.cubicIn });
        }

        tw.call(() => this._onChestLanded()).start();
    }

    /** Tính lại target local pos/scale theo targetNode hiện tại (sau xoay màn). */
    private _computeFlyTarget(): void {
        if (!this.iconNode?.isValid || !this.targetNode?.isValid) return;

        const targetWorldPos = this.targetNode.getWorldPosition();
        if (this.iconNode.parent) {
            this.iconNode.parent.inverseTransformPoint(this._targetLocalPos, targetWorldPos);
        } else {
            Vec3.copy(this._targetLocalPos, targetWorldPos);
        }

        const targetWorldScale = new Vec3();
        this.targetNode.getWorldScale(targetWorldScale);
        const iconParentWorldScale = new Vec3(1, 1, 1);
        if (this.iconNode.parent) {
            this.iconNode.parent.getWorldScale(iconParentWorldScale);
        }
        this._targetLocalScale.set(
            targetWorldScale.x / iconParentWorldScale.x,
            targetWorldScale.y / iconParentWorldScale.y,
            targetWorldScale.z / iconParentWorldScale.z,
        );

        this._abovePotPos.set(
            this._targetLocalPos.x,
            this._targetLocalPos.y + Math.max(0, this.flyArcHeight),
            this._targetLocalPos.z,
        );
        this._midScale.set(
            1 + (this._targetLocalScale.x - 1) * 0.45,
            1 + (this._targetLocalScale.y - 1) * 0.45,
            1 + (this._targetLocalScale.z - 1) * 0.45,
        );
    }

    private _onChestLanded(): void {
        if (this._hasLanded) return;
        this._hasLanded = true;
        this._flyActive = false;

        const skel = this._landedSkel;
        if (skel?.isValid) {
            const potLevel = GameData.instance.potLevel;
            skel.setAnimation(0, `LV6_transition_LV${potLevel}`, false);
        }
        if (this.effectNode2 && this.targetNode?.isValid) {
            this.effectNode2.setWorldPosition(this.targetNode.getWorldPosition());
            this.effectNode2.active = true;
            for (const ps of this.effectNode2.getComponentsInChildren(ParticleSystem)) {
                ps.stop(); ps.play();
            }
        }
        this._beginHideSequence();
    }

    /**
     * Giữ effect → fade overlay → ẩn Transition → mới handoff Pot → TRANSITION_DONE.
     */
    private _beginHideSequence(): void {
        this._finishCb = () => {
            this._finishCb = null;
            this._fadeOutOverlayThenHide();
        };
        this.scheduleOnce(this._finishCb, Math.max(0, this.holdDuration));
    }

    private _fadeOutOverlayThenHide(): void {
        const overlayOpacity = this._ensureOverlayOpacity();
        const duration = Math.max(0.05, this.fadeOutDuration);

        const finishHide = () => {
            // Ẩn Transition trước → rồi mới gán spine sang Pot (tránh Pot nhận spine quá sớm)
            this.node.active = false;
            this._isPlaying = false;
            this._handoffChestToPot(this._pendingPot ?? this._findPotController());
            this._pendingPot = null;
            EventBus.instance.emit(GameEvents.TRANSITION_DONE);
            Log.d('[TransitionController] overlay faded → hidden → chest handoff → TRANSITION_DONE');
        };

        if (!overlayOpacity) {
            finishHide();
            return;
        }

        tween(overlayOpacity).stop();
        tween(overlayOpacity)
            .to(duration, { opacity: 0 }, { easing: easing.sineIn })
            .call(finishHide)
            .start();
    }

    private _ensureOverlayOpacity(): UIOpacity | null {
        const node = this.overlayNode?.isValid ? this.overlayNode : null;
        if (!node) {
            // Fallback: dùng uiOpacity root nếu chưa gán overlayNode
            return this.uiOpacity?.isValid ? this.uiOpacity : this.node.getComponent(UIOpacity);
        }
        let op = node.getComponent(UIOpacity);
        if (!op) {
            op = node.addComponent(UIOpacity);
        }
        return op;
    }

    private _resetOverlayOpacity(value: number): void {
        const op = this._ensureOverlayOpacity();
        if (op) {
            tween(op).stop();
            op.opacity = value;
        }
        if (this.overlayNode?.isValid) {
            this.overlayNode.active = true;
        }
    }

    private _ensureFlashOpacity(): UIOpacity | null {
        const node = this.flashNode?.isValid ? this.flashNode : null;
        if (!node) return null;
        let op = node.getComponent(UIOpacity);
        if (!op) op = node.addComponent(UIOpacity);
        return op;
    }

    private _resetFlashNode(): void {
        const node = this.flashNode?.isValid ? this.flashNode : null;
        if (!node) return;
        const op = this._ensureFlashOpacity();
        if (op) {
            tween(op).stop();
            op.opacity = 255;
        }
        node.active = true;
    }

    /** Fade alpha flashNode rồi mới active = false (không tắt đột ngột). */
    private _fadeOutFlashNode(): void {
        const node = this.flashNode?.isValid ? this.flashNode : null;
        if (!node || !node.active) return;

        const op = this._ensureFlashOpacity();
        const duration = Math.max(0.05, this.flashFadeOutDuration);

        if (!op) {
            node.active = false;
            return;
        }

        tween(op).stop();
        tween(op)
            .to(duration, { opacity: 0 }, { easing: easing.sineOut })
            .call(() => {
                if (node.isValid) node.active = false;
            })
            .start();
    }

    private _findPotController(): PotController | null {
        if (!this.targetNode?.isValid) return null;
        return this.targetNode.getComponent(PotController)
            ?? this.targetNode.parent?.getComponent(PotController)
            ?? null;
    }

    /** Handoff chest → PotController.adoptChestFromTransition (potSpine). */
    private _handoffChestToPot(pot: PotController | null): void {
        if (!this.iconNode?.isValid) return;

        const uiOpacity = this.iconNode.getComponent(UIOpacity);
        if (uiOpacity) {
            tween(uiOpacity).stop();
            uiOpacity.opacity = 255;
        }

        if (pot?.isValid) {
            pot.adoptChestFromTransition(this.iconNode);
            Log.d('[TransitionController] chest handoff → Pot.potSpine');
            return;
        }

        // Fallback nếu chưa wire PotController
        if (this.targetNode?.isValid) {
            this.iconNode.setParent(this.targetNode, true);
            this.iconNode.active = true;
            Log.w('[TransitionController] PotController not found — fallback reparent only');
        }
    }

    private _cleanupRunningTweens(): void {
        if (this._finishCb) {
            this.unschedule(this._finishCb);
            this._finishCb = null;
        }
        this.unschedule(this._retargetFlyAfterLayout);
        this.unschedule(this._retargetFlyAfterLayoutLate);
        this._flyActive = false;
        this._hasLanded = false;
        this._landedSkel = null;
        if (this.iconNode?.isValid) {
            Tween.stopAllByTarget(this.iconNode);
            const uiOpacity = this.iconNode.getComponent(UIOpacity);
            if (uiOpacity) Tween.stopAllByTarget(uiOpacity);
        }
        const overlayOp = this.overlayNode?.isValid
            ? this.overlayNode.getComponent(UIOpacity)
            : (this.uiOpacity?.isValid ? this.uiOpacity : null);
        if (overlayOp) tween(overlayOp).stop();
        const flashOp = this.flashNode?.isValid ? this.flashNode.getComponent(UIOpacity) : null;
        if (flashOp) tween(flashOp).stop();
        for (const fx of [this.effectNode, this.effectNode2]) {
            if (!fx?.isValid) continue;
            for (const ps of fx.getComponentsInChildren(ParticleSystem)) {
                ps.stop();
            }
            fx.active = false;
        }
    }
}
