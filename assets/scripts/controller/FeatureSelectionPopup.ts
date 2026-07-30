/**
 * FeatureSelectionPopup — Popup chọn bonus khi 6+ Red sticky xuất hiện.
 *
 * Secret Treasure: 6 lựa chọn = TopUp + 5 tier Free Spin (ReelIndex 0 / 2–6).
 *
 * ── SETUP TRONG EDITOR ──
 *   introZoomNodes       → 3 node zoom lần lượt khi mở (scale 0→1, rồi nhún chậm)
 *   glowNode             → Node glow pulse zoom in/out nhẹ
 *   btnTopUp             → TopUp Bonus (ReelIndex 0, NextStage 12)
 *   btnFreeSpinTiers     → 5 nút tier FS (Highest→Lowest, ReelIndex 2–6)
 *   spineTopUp           → Spine play khi bấm TopUp (xong mới vào TopUp)
 *   spineFreeSpinTiers   → 5 spine tương ứng 5 nút FS (xong mới vào FreeSpin)
 */

import {
    _decorator, Component, Node, Button, BlockInputEvents, Label, UIOpacity, tween, Tween, Vec3, Color, Sprite, screen,
} from 'cc';
import { sp } from 'cc';
import { EventBus }       from '../core/EventBus';
import { GameEvents }     from '../core/GameEvents';
import {
    StickyCell, SymbolId, FeatureSelectOption,
    buildDefaultFeatureSelectOptions, FeatureSelectChoiceId,
    SECRET_TREASURE_FREE_SPIN_TIERS,
} from '../data/SlotTypes';
import { SpriteNumber }   from '../core/SpriteNumber';
import { Log }            from '../core/Logger';
import { SoundManager }   from '../manager/SoundManager';
import { L }              from '../core/LocalizationManager';
import { OrientationLayout } from './OrientationLayout';

const { ccclass, property } = _decorator;

export interface FeatureSelectPayload {
    sumCredit: number;
    stickyCells: StickyCell[];
    options?: FeatureSelectOption[];
}

export interface FeatureSelectChoicePayload {
    option: FeatureSelectOption;
    onAccepted?: (onClosed?: () => void) => void;
    onRejected?: () => void;
}

@ccclass('FeatureSelectionPopup')
export class FeatureSelectionPopup extends Component {

    @property({ type: sp.Skeleton, tooltip: 'Spine intro/loop chung của popup (optional).' })
    spine: sp.Skeleton | null = null;

    @property({ type: SpriteNumber, tooltip: 'SpriteNumber hiển thị tổng credit — count-up từ 0 đến sumCredit.' })
    sumCreditSpriteNumber: SpriteNumber | null = null;

    @property({ type: Button, tooltip: 'Nút TOP UP BONUS (Re-Spin).' })
    btnTopUp: Button | null = null;

    /** 5 nút Free Spin tier — thứ tự: Highest, High, Middle, Low, Lowest (ReelIndex 2–6). */
    @property({ type: [Button], tooltip: '5 nút Free Spin tier (Highest → Lowest).' })
    btnFreeSpinTiers: Button[] = [];

    /** Label tùy chọn cho từng tier (cùng thứ tự với btnFreeSpinTiers). */
    @property({ type: [Label], tooltip: 'Label text cho 5 tier Free Spin (optional).' })
    labelFreeSpinTiers: Label[] = [];

    @property({ type: [Node], tooltip: '3 node zoom lần lượt khi mở popup (scale 0→1, có delay).' })
    introZoomNodes: Node[] = [];

    @property({ tooltip: 'Thời gian zoom mỗi node (giây).' })
    introZoomDuration: number = 0.5;

    @property({ tooltip: 'Delay giữa các node zoom (giây).' })
    introZoomStagger: number = 0.14;

    @property({ tooltip: 'Overshoot scale khi zoom vào (vd 1.08).' })
    introZoomOvershoot: number = 1.08;

    @property({ tooltip: 'Biên độ nhún lên/xuống sau zoom (px) — nhỏ = nhẹ.' })
    introFloatAmplitude: number = 6;

    @property({ tooltip: 'Thời gian nửa chu kỳ nhún (giây) — lớn = chậm hơn.' })
    introFloatHalfPeriod: number = 1.6;

    @property({ type: Node, tooltip: 'Node Glow — zoom in/out nhẹ (light effect).' })
    glowNode: Node | null = null;

    @property({ tooltip: 'Biên độ pulse scale Glow (vd 0.06 = ±6%).' })
    glowPulseAmount: number = 0.06;

    @property({ tooltip: 'Nửa chu kỳ zoom in/out của Glow (giây).' })
    glowPulseHalfPeriod: number = 1.4;

    @property({ type: sp.Skeleton, tooltip: 'Spine play khi bấm nút TopUp — xong mới vào TopUp.' })
    spineTopUp: sp.Skeleton | null = null;

    @property({ type: [sp.Skeleton], tooltip: '5 spine tương ứng 5 nút Free Spin (Highest → Lowest).' })
    spineFreeSpinTiers: sp.Skeleton[] = [];

    @property({ tooltip: 'Tên animation khi play (để trống = dùng anim đã gắn sẵn trên spine).' })
    choiceSpineAnimName: string = '';

    @property({ tooltip: 'Độ tối spine các nút không được chọn (0–1, càng nhỏ càng tối).' })
    unselectedSpineDim: number = 0.35;

    @property({ tooltip: 'Thời gian tối dần spine không chọn (giây).' })
    unselectedSpineDimDuration: number = 0.35;

    @property({ type: Node, tooltip: 'Fill đen khi đóng vào feature — fade UIOpacity, không fade alpha cả popup. Để trống = dùng child Overlay.' })
    closeFadeOverlay: Node | null = null;

    @property({ tooltip: 'Thời gian fade fill đen khi đóng (giây). 0 = giao cho TransitionPopup.' })
    closeFadeDuration: number = 0;

    private _isOpen: boolean = false;
    private _pendingFinishClose: boolean = false;
    private _payload: FeatureSelectPayload | null = null;
    private _choosing: boolean = false;
    private _options: FeatureSelectOption[] = buildDefaultFeatureSelectOptions();
    /** Nút FS đã resolve (Inspector hoặc FreeGame1–5). */
    private _freeSpinButtons: Button[] = [];
    private _baseNode: Node | null = null;
    /** Layer preview tĩnh — ẩn khi spine chạy để không chặn touch. */
    private _demoNode: Node | null = null;
    private _choiceFallbackEmit: (() => void) | null = null;

    /** Vị trí gốc + scale gốc của introZoomNodes (để float / reset). */
    private _introBases: { node: Node; pos: Vec3; scale: Vec3 }[] = [];
    private _glowBaseScale: Vec3 | null = null;

    onLoad(): void {
        if (!this.node.getComponent(BlockInputEvents)) {
            this.node.addComponent(BlockInputEvents);
        }

        this._baseNode = this.node.getChildByName('Base');
        this._demoNode = this._baseNode?.getChildByName('Demo') ?? null;
        this._resyncEffectBases();
        this._freezeChoiceSpines();

        EventBus.instance.on(GameEvents.FEATURE_SELECT_OPEN, this._onOpen, this);
        screen.on('window-resize', this._onScreenChange, this);
        screen.on('orientation-change', this._onScreenChange, this);
        this._bindButtons();

        this.node.active = false;
        if (this.spine) this.spine.node.active = false;
        if (this.sumCreditSpriteNumber) this.sumCreditSpriteNumber.node.active = false;
    }

    onDestroy(): void {
        this._stopIntroAnims();
        this._stopGlowEffect();
        this._pendingFinishClose = false;
        this.unschedule(this._onTransitionReadyHide);
        this.unschedule(this._resyncEffectBases);
        screen.off('window-resize', this._onScreenChange, this);
        screen.off('orientation-change', this._onScreenChange, this);
        EventBus.instance.offTarget(this);
    }

    /** Đồng bộ lại base pos/scale theo OrientationLayout sau khi xoay / resize. */
    private _onScreenChange(): void {
        this.unschedule(this._resyncEffectBases);
        // Delay 0 để chạy sau OrientationLayout._applyOrientation (cùng frame schedule).
        this.scheduleOnce(this._resyncEffectBases, 0);
    }

    private _isPortrait(): boolean {
        const size = screen.windowSize;
        return size.height > size.width;
    }

    /** Apply OL trên node effect → capture lại base → nếu popup đang mở thì snap + float lại. */
    private _resyncEffectBases = (): void => {
        this._applyOrientationToEffectNodes();
        this._captureIntroBases();
        this._captureGlowBase();

        if (!this._isOpen) return;

        // Đang mở: snap về layout mới rồi tiếp tục float / glow (không replay zoom intro).
        this._stopIntroAnims();
        for (const base of this._introBases) {
            if (!base.node?.isValid) continue;
            base.node.setPosition(base.pos);
            base.node.setScale(base.scale);
            base.node.active = true;
        }
        this._startIntroFloat();
        this._startGlowEffect();
    };

    private _applyOrientationToEffectNodes(): void {
        for (const node of this.introZoomNodes) {
            if (!node?.isValid) continue;
            node.getComponent(OrientationLayout)?.applyOrientation();
        }
        if (this.glowNode?.isValid) {
            this.glowNode.getComponent(OrientationLayout)?.applyOrientation();
        }
    }

    private _onOpen(payload: FeatureSelectPayload): void {
        if (this._isOpen) return;
        this._isOpen  = true;
        this._payload = payload;
        this._options = payload.options?.length
            ? payload.options
            : buildDefaultFeatureSelectOptions();

        const sumCredit = payload.stickyCells.reduce((sum, cell) =>
            cell.symbolId === SymbolId.STICKY_RED ? sum + (cell.credit ?? 0) : sum, 0);
        Log.e(`[FeatureSelectPopup] open sumCredit=${sumCredit} cells=${payload.stickyCells.length} options=${this._options.length}`);

        if (this.sumCreditSpriteNumber) {
            this.sumCreditSpriteNumber.setData(sumCredit);
        }

        this._bindButtons();
        this._applyOptionLabels();
        this._show();
    }

    /** Resolve 5 nút Free Spin — ưu tiên Inspector, fallback FreeGame1–5 trong Base. */
    private _resolveFreeSpinButtons(): Button[] {
        const fromInspector = this.btnFreeSpinTiers.filter(Boolean);
        if (fromInspector.length >= SECRET_TREASURE_FREE_SPIN_TIERS.length) {
            return fromInspector.slice(0, SECRET_TREASURE_FREE_SPIN_TIERS.length);
        }

        const resolved: Button[] = [...fromInspector];
        for (let i = 1; i <= SECRET_TREASURE_FREE_SPIN_TIERS.length; i++) {
            const idx = i - 1;
            if (resolved[idx]) continue;
            const node = this._baseNode?.getChildByName(`FreeGame${i}`);
            const btn = node?.getComponent(Button);
            if (btn) resolved[idx] = btn;
        }
        return resolved;
    }

    private _bindButtons(): void {
        this._freeSpinButtons = this._resolveFreeSpinButtons();
        Log.d(`[FeatureSelectionPopup] bind buttons topUp=${!!this.btnTopUp} freeSpin=${this._freeSpinButtons.length}`);

        if (this.btnTopUp) {
            this.btnTopUp.node.off(Button.EventType.CLICK);
            this.btnTopUp.node.on(Button.EventType.CLICK, () => this._onChooseOption(FeatureSelectChoiceId.TOPUP), this);
        }

        for (let i = 0; i < SECRET_TREASURE_FREE_SPIN_TIERS.length; i++) {
            const tierDef = SECRET_TREASURE_FREE_SPIN_TIERS[i];
            const btn = this._freeSpinButtons[i];
            if (!btn) {
                Log.e(`[FeatureSelectionPopup] Missing FreeSpin button index=${i} (${tierDef.shortLabel})`);
                continue;
            }
            btn.node.off(Button.EventType.CLICK);
            btn.node.on(Button.EventType.CLICK, () => this._onChooseOption(tierDef.id), this);
        }
    }

    /** Đưa nút lên trên spine / Demo để nhận touch. */
    private _raiseButtonsAboveContent(): void {
        const base = this._baseNode;
        if (!base) return;

        const touchables: Node[] = [];
        for (const btn of this._freeSpinButtons) {
            if (btn?.node) touchables.push(btn.node);
        }
        if (this.btnTopUp?.node) touchables.push(this.btnTopUp.node);

        let nextIndex = base.children.length;
        for (const node of touchables) {
            node.setSiblingIndex(nextIndex++);
        }
    }

    private _applyOptionLabels(): void {
        const topUpOpt = this._options.find(o => o.id === FeatureSelectChoiceId.TOPUP);
        if (this.btnTopUp) {
            this.btnTopUp.interactable = topUpOpt?.enabled ?? true;
        }

        for (let i = 0; i < SECRET_TREASURE_FREE_SPIN_TIERS.length; i++) {
            const tierDef = SECRET_TREASURE_FREE_SPIN_TIERS[i];
            const opt = this._options.find(o => o.id === tierDef.id);
            const enabled = opt?.enabled ?? true;
            const labelKey = opt?.labelKey ?? tierDef.labelKey;
            const text = L(labelKey) || tierDef.shortLabel;

            const btn = this._freeSpinButtons[i];
            if (btn) {
                btn.interactable = enabled;
            }
            if (this.labelFreeSpinTiers[i]) {
                this.labelFreeSpinTiers[i].string = text;
            }
        }
    }

    private _onChooseOption(choiceId: FeatureSelectChoiceId): void {
        if (!this._isOpen || this._choosing) return;
        const option = this._options.find(o => o.id === choiceId);
        if (!option || !option.enabled) return;

        this._choosing = true;
        Log.d(`[FeatureSelectionPopup] Chọn ${choiceId} → NextStage=${option.nextStage} ReelIndex=${option.reelIndex}`);
        this._setButtonsInteractable(false);
        SoundManager.instance?.playSfxByName('sxFeatureSelect');
        SoundManager.instance?.playFeatureSelectMusic();

        let choiceEmitted = false;
        const emitChoice = () => {
            if (choiceEmitted) return;
            choiceEmitted = true;
            this._clearChoiceFallback();
            EventBus.instance.emit(GameEvents.FEATURE_SELECT_CHOICE, {
                option,
                onAccepted: (onClosed?: () => void) => this._close(onClosed),
                onRejected: () => {
                    this._choosing = false;
                    this._freezeChoiceSpines();
                    this._setButtonsInteractable(true);
                },
            } satisfies FeatureSelectChoicePayload);
        };

        const choiceSpine = this._getChoiceSpine(choiceId);
        if (choiceSpine) {
            this._playChoiceSpine(choiceSpine, emitChoice, choiceId);
            return;
        }

        // Fallback: spine chung cũ (Choose-topupbonus / Choose-freegames)
        if (this.spine) {
            const anim = choiceId === FeatureSelectChoiceId.TOPUP ? 'Choose-topupbonus' : 'Choose-freegames';
            const fallbackSec = (choiceId === FeatureSelectChoiceId.TOPUP ? 2.5 : 4.5) / (this.spine.timeScale || 1);
            this._clearChoiceFallback();
            this._choiceFallbackEmit = () => {
                Log.e(`[FeatureSelectionPopup] spine complete fallback → ${choiceId}`);
                this.spine?.setCompleteListener(null);
                emitChoice();
            };
            this.scheduleOnce(this._choiceFallbackEmit, fallbackSec);

            this.spine.setCompleteListener(() => {
                this.spine!.setCompleteListener(null);
                emitChoice();
            });
            this.spine.setAnimation(0, anim, false);
        } else {
            emitChoice();
        }
    }

    private _getChoiceSpine(choiceId: FeatureSelectChoiceId): sp.Skeleton | null {
        if (choiceId === FeatureSelectChoiceId.TOPUP) {
            return this.spineTopUp;
        }
        const tierIdx = SECRET_TREASURE_FREE_SPIN_TIERS.findIndex(t => t.id === choiceId);
        if (tierIdx < 0) return null;
        return this.spineFreeSpinTiers[tierIdx] ?? null;
    }

    private _playChoiceSpine(skel: sp.Skeleton, onDone: () => void, choiceId: FeatureSelectChoiceId): void {
        if (!skel?.isValid || !skel.node?.isValid) {
            Log.e(`[FeatureSelectionPopup] choice spine invalid → ${choiceId}`);
            onDone();
            return;
        }

        skel.node.active = true;
        // Đưa spine lên trên sibling để không bị che
        const parent = skel.node.parent;
        if (parent) skel.node.setSiblingIndex(parent.children.length - 1);

        const animName = this._resolveAnimName(skel);
        if (!skel.findAnimation(animName)) {
            Log.e(`[FeatureSelectionPopup] anim "${animName}" not found on "${skel.node.name}" → ${choiceId}`);
            onDone();
            return;
        }

        // Tránh Button COLOR (disabled) làm tối spine lúc play
        const btnNode = skel.node.parent;
        if (btnNode) {
            const btn = btnNode.getComponent(Button);
            if (btn) btn.transition = Button.Transition.NONE;
            const op = btnNode.getComponent(UIOpacity);
            if (op) op.opacity = 255;
        }

        // Restart sạch: bỏ pause/freeze, clear track, play 1 lần
        skel.setCompleteListener(null);
        skel.paused = false;
        skel.timeScale = 1;
        skel.color = Color.WHITE;
        skel.clearTrack(0);
        skel.setToSetupPose();

        // Tối màu 5 spine còn lại trong lúc nút được chọn đang play
        this._dimUnselectedChoiceSpines(skel);

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            skel.setCompleteListener(null);
            this._clearChoiceFallback();
            onDone();
        };

        const duration = this._estimateSpineDuration(skel, animName);
        const fallbackSec = Math.max(0.5, duration + 0.2);
        this._clearChoiceFallback();
        this._choiceFallbackEmit = () => {
            Log.e(`[FeatureSelectionPopup] choice spine fallback → ${choiceId} anim="${animName}"`);
            finish();
        };
        this.scheduleOnce(this._choiceFallbackEmit, fallbackSec);

        // Listener trước setAnimation — tránh miss complete
        skel.setCompleteListener((entry?: { animation?: { name?: string } }) => {
            const name = entry?.animation?.name;
            if (name && name !== animName) return;
            finish();
        });

        const track = skel.setAnimation(0, animName, false);
        if (track) {
            track.trackTime = 0;
            track.timeScale = 1;
        }

        Log.e(`[FeatureSelectionPopup] PLAY choice spine "${skel.node.name}" anim="${animName}" dur≈${duration.toFixed(2)}s`);
    }

    private _resolveAnimName(skel: sp.Skeleton): string {
        const wanted = (this.choiceSpineAnimName || '').trim();
        if (wanted && skel.findAnimation(wanted)) return wanted;

        // Ưu tiên animation đang gắn sẵn trên track 0 (set trong Editor)
        const current = skel.getCurrent(0);
        if (current?.animation?.name) return current.animation.name;

        // Fallback: defaultAnimation của Skeleton / anim đầu tiên trong data
        const defaultAnim = (skel as any).defaultAnimation as string | undefined;
        if (defaultAnim && skel.findAnimation(defaultAnim)) return defaultAnim;

        const data = skel.skeletonData?.getRuntimeData?.() ?? (skel as any)._skeleton?.data;
        const anims: { name: string }[] | undefined = data?.animations;
        if (anims?.length) return anims[0].name;

        return wanted || 'animation';
    }

    private _estimateSpineDuration(skel: sp.Skeleton, animName: string): number {
        const anim = skel.findAnimation(animName);
        if (anim && typeof (anim as any).duration === 'number') {
            return Math.max(0.2, (anim as any).duration);
        }
        return 2.0;
    }

    /** Giữ spine hiện sẵn (anim đã gắn), đóng băng frame đầu bằng paused (không dùng timeScale=0). */
    private _freezeChoiceSpines(): void {
        this._resetChoiceSpineColors();
        for (const skel of this._allChoiceSpines()) {
            this._freezeOneChoiceSpine(skel);
        }
    }

    private _freezeOneChoiceSpine(skel: sp.Skeleton): void {
        if (!skel?.isValid) return;
        skel.node.active = true;
        skel.setCompleteListener(null);

        const animName = this._resolveAnimName(skel);
        skel.paused = false;
        skel.timeScale = 1;
        skel.clearTrack(0);
        skel.setAnimation(0, animName, false);
        const entry = skel.getCurrent(0);
        if (entry) {
            entry.trackTime = 0;
            entry.timeScale = 0;
        }
        // Đóng băng tại frame đầu — resume bằng paused=false khi play
        skel.paused = true;
    }

    private _allChoiceSpines(): sp.Skeleton[] {
        const list: sp.Skeleton[] = [];
        if (this.spineTopUp) list.push(this.spineTopUp);
        for (const s of this.spineFreeSpinTiers) {
            if (s) list.push(s);
        }
        return list;
    }

    /** Reset màu tất cả choice spine về trắng (gọi khi show / reject / close). */
    private _resetChoiceSpineColors(): void {
        for (const skel of this._allChoiceSpines()) {
            if (!skel?.isValid) continue;
            Tween.stopAllByTarget(skel);
            skel.color = Color.WHITE;
        }
    }

    /** Tối dần spine các nút không được chọn khi đang play choice anim. */
    private _dimUnselectedChoiceSpines(selected: sp.Skeleton): void {
        const t = Math.max(0, Math.min(1, this.unselectedSpineDim));
        const gray = Math.round(255 * t);
        const dim = new Color(gray, gray, gray, 255);
        const dur = Math.max(0, this.unselectedSpineDimDuration);

        for (const skel of this._allChoiceSpines()) {
            if (!skel?.isValid || skel === selected) continue;
            Tween.stopAllByTarget(skel);
            skel.color = Color.WHITE;
            if (dur <= 0) {
                skel.color = dim;
                continue;
            }
            tween(skel)
                .to(dur, { color: dim }, { easing: 'sineOut' })
                .start();
        }
    }

    private _clearChoiceFallback(): void {
        if (this._choiceFallbackEmit) {
            this.unschedule(this._choiceFallbackEmit);
            this._choiceFallbackEmit = null;
        }
    }

    // ── Glow rotate + pulse ─────────────────────────────────────────

    private _captureGlowBase(): void {
        if (!this.glowNode?.isValid) {
            this._glowBaseScale = null;
            return;
        }
        // Ưu tiên scale từ OrientationLayout — tránh capture scale đang pulse.
        const ol = this.glowNode.getComponent(OrientationLayout);
        if (ol) {
            const data = this._isPortrait() ? ol.portrait : ol.landscape;
            this._glowBaseScale = new Vec3(data.scaleX, data.scaleY, data.scaleZ);
            return;
        }
        this._glowBaseScale = this.glowNode.scale.clone();
    }

    private _stopGlowEffect(): void {
        if (!this.glowNode?.isValid) return;
        Tween.stopAllByTarget(this.glowNode);
    }

    private _resetGlowNode(): void {
        this._stopGlowEffect();
        if (!this.glowNode?.isValid) return;
        if (!this._glowBaseScale) this._captureGlowBase();
        if (this._glowBaseScale) {
            this.glowNode.setScale(this._glowBaseScale);
        }
    }

    /** Pulse zoom in/out nhẹ (glow light). */
    private _startGlowEffect(): void {
        if (!this.glowNode?.isValid) return;
        if (!this._glowBaseScale) this._captureGlowBase();
        this._resetGlowNode();

        const node = this.glowNode;
        node.active = true;

        const base = this._glowBaseScale ?? node.scale.clone();
        const amount = Math.max(0, this.glowPulseAmount);
        if (amount <= 0) return;

        const half = Math.max(0.3, this.glowPulseHalfPeriod);
        const hi = new Vec3(base.x * (1 + amount), base.y * (1 + amount), base.z);
        const lo = new Vec3(base.x * (1 - amount), base.y * (1 - amount), base.z);

        tween(node)
            .to(half, { scale: hi }, { easing: 'sineInOut' })
            .to(half, { scale: lo }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();
    }

    // ── Intro zoom + float ──────────────────────────────────────────

    /**
     * Capture target pos/scale theo OrientationLayout hiện tại.
     * Scale lấy từ OL data (không lấy scale đang tween zoom 0→1).
     * Pos lấy từ node sau khi OL apply + Widget align.
     */
    private _captureIntroBases(): void {
        this._introBases = [];
        for (const node of this.introZoomNodes) {
            if (!node?.isValid) continue;

            const ol = node.getComponent(OrientationLayout);
            let pos = node.position.clone();
            let scale = node.scale.clone();

            if (ol) {
                const data = this._isPortrait() ? ol.portrait : ol.landscape;
                pos = node.position.clone();
                scale = new Vec3(data.scaleX, data.scaleY, data.scaleZ);
            }

            if (scale.x === 0 && scale.y === 0) {
                scale.set(1, 1, 1);
            }

            this._introBases.push({ node, pos, scale });
        }
    }

    private _stopIntroAnims(): void {
        for (const base of this._introBases) {
            if (!base.node?.isValid) continue;
            Tween.stopAllByTarget(base.node);
        }
    }

    private _resetIntroNodes(): void {
        this._stopIntroAnims();
        if (this._introBases.length === 0) this._captureIntroBases();

        for (const base of this._introBases) {
            if (!base.node?.isValid) continue;
            base.node.setPosition(base.pos);
            base.node.setScale(0, 0, base.scale.z || 1);
            base.node.active = true;
        }
    }

    private _playIntroZoomThenFloat(onReady: () => void): void {
        if (this._introBases.length === 0) {
            this._captureIntroBases();
        }
        if (this._introBases.length === 0) {
            onReady();
            return;
        }

        this._resetIntroNodes();

        const zoomDur = Math.max(0.15, this.introZoomDuration);
        const stagger = Math.max(0, this.introZoomStagger);
        const overshoot = Math.max(1.0, this.introZoomOvershoot);
        let finished = 0;
        const total = this._introBases.length;

        for (let i = 0; i < total; i++) {
            const base = this._introBases[i];
            const target = base.scale.clone();
            if (target.x === 0 && target.y === 0) {
                target.set(1, 1, 1);
            }
            const peak = new Vec3(target.x * overshoot, target.y * overshoot, target.z);
            const settleRatio = 0.78;
            const settleDur = zoomDur * settleRatio;
            const pullDur = Math.max(0.08, zoomDur * (1 - settleRatio));

            tween(base.node)
                .delay(i * stagger)
                .to(settleDur, { scale: peak }, { easing: 'cubicOut' })
                .to(pullDur, { scale: target }, { easing: 'sineOut' })
                .call(() => {
                    finished++;
                    if (finished >= total) {
                        this._startIntroFloat();
                        onReady();
                    }
                })
                .start();
        }
    }

    private _startIntroFloat(): void {
        const amp = Math.max(0, this.introFloatAmplitude);
        if (amp <= 0) return;

        const half = Math.max(0.4, this.introFloatHalfPeriod);

        for (let i = 0; i < this._introBases.length; i++) {
            const base = this._introBases[i];
            if (!base.node?.isValid) continue;

            // Phase lệch nhẹ giữa các node để cảm giác tự nhiên hơn
            const phaseDelay = i * 0.18;
            const up = new Vec3(base.pos.x, base.pos.y + amp, base.pos.z);
            const down = new Vec3(base.pos.x, base.pos.y - amp * 0.65, base.pos.z);

            tween(base.node)
                .delay(phaseDelay)
                .to(half, { position: up }, { easing: 'sineInOut' })
                .to(half * 1.05, { position: down }, { easing: 'sineInOut' })
                .to(half * 0.95, { position: base.pos.clone() }, { easing: 'sineInOut' })
                .union()
                .repeatForever()
                .start();
        }
    }

    private _show(): void {
        this.node.active = true;
        const rootOp = this.node.getComponent(UIOpacity) ?? this.node.addComponent(UIOpacity);
        Tween.stopAllByTarget(rootOp);
        rootOp.opacity = 0;
        tween(rootOp).to(0.3, { opacity: 255 }, { easing: 'sineOut' }).start();

        this._setButtonsInteractable(false);
        if (this.sumCreditSpriteNumber) this.sumCreditSpriteNumber.node.active = true;
        this._freezeChoiceSpines();

        // Đồng bộ target bay/zoom theo OrientationLayout trước khi chạy intro.
        this._applyOrientationToEffectNodes();
        this._captureIntroBases();
        this._captureGlowBase();
        this._startGlowEffect();

        if (this._demoNode) {
            this._demoNode.active = !this.spine;
        }
        this._raiseButtonsAboveContent();

        let introSpineDone = !this.spine;
        let zoomDone = this.introZoomNodes.filter(Boolean).length === 0;

        const tryEnableButtons = () => {
            if (introSpineDone && zoomDone) {
                this._setButtonsInteractable(true);
            }
        };

        this._playIntroZoomThenFloat(() => {
            zoomDone = true;
            tryEnableButtons();
        });

        if (this.spine) {
            this.spine.node.active = true;
            this.spine.setCompleteListener(() => {
                this.spine!.setCompleteListener(null);
                this.spine!.setAnimation(0, 'Loop', true);
                introSpineDone = true;
                tryEnableButtons();
            });
            this.spine.setAnimation(0, 'In', false);
        } else {
            tryEnableButtons();
        }
    }

    /**
     * Đóng khi vào feature:
     * - KHÔNG fade alpha cả popup (UIOpacity root).
     * - Giữ popup hiện đầy đủ → kick Transition fill đen → ẩn popup khi overlay đã phủ (READY).
     */
    private _close(onDone?: () => void): void {
        if (!this._isOpen) return;
        this._isOpen = false;
        this._choosing = false;
        this._setButtonsInteractable(false);
        this._clearChoiceFallback();
        this._stopIntroAnims();
        this._stopGlowEffect();

        if (this.spine) {
            this.spine.setCompleteListener(null);
        }
        if (this.spineTopUp) this.spineTopUp.setCompleteListener(null);
        for (const s of this.spineFreeSpinTiers) {
            s?.setCompleteListener(null);
        }

        // Giữ root opacity full — không set alpha cả màn popup
        const rootOp = this.node.getComponent(UIOpacity);
        if (rootOp) {
            Tween.stopAllByTarget(rootOp);
            rootOp.opacity = 255;
        }

        const overlay = this.closeFadeOverlay ?? this.node.getChildByName('Overlay');
        const fadeDur = Math.max(0, this.closeFadeDuration);

        const startTransition = () => {
            this._pendingFinishClose = true;
            EventBus.instance.once(GameEvents.TOPUP_TRANSITION_READY, this._onTransitionReadyHide, this);
            // Fallback nếu Transition không emit READY
            this.scheduleOnce(this._onTransitionReadyHide, Math.max(0.6, fadeDur + 0.5));
            onDone?.();
        };

        if (overlay && fadeDur > 0) {
            // Optional: tự fade fill đen trước, rồi mới giao Transition
            overlay.active = true;
            overlay.setSiblingIndex(this.node.children.length - 1);
            const spr = overlay.getComponent(Sprite);
            if (spr) spr.color = new Color(0, 0, 0, 255);
            const op = overlay.getComponent(UIOpacity) ?? overlay.addComponent(UIOpacity);
            Tween.stopAllByTarget(op);
            op.opacity = 0;
            tween(op)
                .to(fadeDur, { opacity: 255 }, { easing: 'sineOut' })
                .call(startTransition)
                .start();
        } else {
            // Mặc định: TransitionPopup lo fade fill đen; popup giữ nguyên đến READY
            startTransition();
        }
    }

    private _onTransitionReadyHide = (): void => {
        if (!this._pendingFinishClose) return;
        this._pendingFinishClose = false;
        this.unschedule(this._onTransitionReadyHide);
        EventBus.instance.off(GameEvents.TOPUP_TRANSITION_READY, this._onTransitionReadyHide, this);
        this._finishCloseImmediate();
    };

    private _finishCloseImmediate(): void {
        if (this._demoNode) {
            this._demoNode.active = true;
        }
        this.node.active = false;
        if (this.spine) this.spine.node.active = false;
        this._freezeChoiceSpines();
        if (this.sumCreditSpriteNumber) this.sumCreditSpriteNumber.node.active = false;

        for (const base of this._introBases) {
            if (!base.node?.isValid) continue;
            base.node.setPosition(base.pos);
            base.node.setScale(base.scale);
        }
        this._resetGlowNode();

        const overlay = this.closeFadeOverlay ?? this.node.getChildByName('Overlay');
        if (overlay) {
            const op = overlay.getComponent(UIOpacity);
            if (op) {
                Tween.stopAllByTarget(op);
                op.opacity = 255;
            }
        }

        const rootOp = this.node.getComponent(UIOpacity);
        if (rootOp) rootOp.opacity = 255;

        this._payload = null;
        EventBus.instance.emit(GameEvents.FEATURE_SELECT_CLOSE);
    }

    private _setButtonsInteractable(value: boolean): void {
        if (this.btnTopUp) {
            const topUpOpt = this._options.find(o => o.id === FeatureSelectChoiceId.TOPUP);
            this.btnTopUp.interactable = value && (topUpOpt?.enabled ?? true);
        }
        for (let i = 0; i < SECRET_TREASURE_FREE_SPIN_TIERS.length; i++) {
            const tierDef = SECRET_TREASURE_FREE_SPIN_TIERS[i];
            const opt = tierDef ? this._options.find(o => o.id === tierDef.id) : undefined;
            const btn = this._freeSpinButtons[i];
            if (btn) {
                btn.interactable = value && (opt?.enabled ?? true);
            }
        }
    }
}
