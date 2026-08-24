/**
 * JackpotDisplay - Hiển thị giá trị 4 loại jackpot.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo 4 Node (grandLabel, majorLabel, minorLabel, miniLabel).
 *   2. Mỗi Node gắn Component Label.
 *   3. Kéo Node vào slot tương ứng (grand/major/minor/miniLabelNode).
 *   4. Điền tên animation idle và win riêng cho từng loại jackpot vào inspector
 *      (ví dụ: grand_idle / grand_win, major_idle / major_win, ...).
 *
 * ── SPINE FLOW ──
 *   Bình thường: tất cả spine play animIdle riêng của từng loại, freeze tại frame 0.
 *   Tuần tự lần lượt Grand → Major → Minor → Mini → lặp lại:
 *     mỗi spine được set timeScale=1 để diễn animA 1 lần, xong freeze, qua tiếp.
 *   Trúng jackpot: dừng vòng tuần tự, freeze tất cả, spine trúng play animB 1 lần,
 *     xong quay lại vòng tuần tự từ đầu.
 *
 * ── AUTO UPDATE ──
 *   - Lắng nghe JACKPOT_VALUES_UPDATED từ server/mock polling → hiển thị giá trị API.
 *   - Lắng nghe BET_CHANGED → refresh (meter vẫn lấy từ jackpotValues, không nhân bet).
 *   - jackpotValues: [MINI, MINOR, MAJOR, GRAND] (thứ tự từ server API).
 */

import { _decorator, Component, Node, ParticleSystem, sp, tween, Tween, Vec3 } from 'cc';
import { GameData } from '../data/GameData';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { SpriteNumber } from '../core/SpriteNumber';
import { naturalCountUpValue } from '../core/FormatUtils';
import { JackpotType } from '../data/SlotTypes';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('JackpotDisplay')
export class JackpotDisplay extends Component {

    private static _instance: JackpotDisplay | null = null;
    static get instance(): JackpotDisplay | null { return JackpotDisplay._instance; }

    // ─── SPRITE NUMBERS ───────────────────────────────────────────────────────

    @property({ type: SpriteNumber, tooltip: 'SpriteNumber hiển thị GRAND jackpot (Wild 3X)' })
    grandLabel: SpriteNumber | null = null;

    @property({ type: SpriteNumber, tooltip: 'SpriteNumber hiển thị MAJOR jackpot (Red Lightning)' })
    majorLabel: SpriteNumber | null = null;

    @property({ type: SpriteNumber, tooltip: 'SpriteNumber hiển thị MINOR jackpot (Blue Lightning)' })
    minorLabel: SpriteNumber | null = null;

    @property({ type: SpriteNumber, tooltip: 'SpriteNumber hiển thị MINI jackpot (Mix Special)' })
    miniLabel: SpriteNumber | null = null;

    @property({
        tooltip: 'Currency index truyền vào SpriteNumber.setData().0 = currency đầu tiên trong currencySprites. Dùng -1 nếu không cần ký hiệu tiền tệ.',
    })
    currencyIndex: number = 0;

    
    // ─── SPINE ───────────────────────────────────────────────────────────────

    @property({
        type: sp.Skeleton,
        tooltip: 'Spine effect GRAND jackpot.',
    })
    spineGrand: sp.Skeleton | null = null;

    @property({
        type: sp.Skeleton,
        tooltip: 'Spine effect MAJOR jackpot.',
    })
    spineMajor: sp.Skeleton | null = null;

    @property({
        type: sp.Skeleton,
        tooltip: 'Spine effect MINOR jackpot.',
    })
    spineMinor: sp.Skeleton | null = null;

    @property({
        type: sp.Skeleton,
        tooltip: 'Spine effect MINI jackpot.',
    })
    spineMini: sp.Skeleton | null = null;

    @property({ type: Node, tooltip: 'Effect node GRAND — đã gán sẵn parent, chỉ cần kéo vào' })
    jackpotEffectGrand: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node MAJOR — đã gán sẵn parent, chỉ cần kéo vào' })
    jackpotEffectMajor: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node MINOR — đã gán sẵn parent, chỉ cần kéo vào' })
    jackpotEffectMinor: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node MINI — đã gán sẵn parent, chỉ cần kéo vào' })
    jackpotEffectMini: Node | null = null;

    @property({
        type: [Node],
        tooltip: '4 slot nodes là child của JackpotDisplay, theo thứ tự: [0]=Grand [1]=Minor [2]=Major [3]=Mini.',
    })
    jackpotSlotNodes: Node[] = [];

    // ─── ANIMATION NAMES (idle / win riêng cho từng loại jackpot) ─────────────

    @property({ tooltip: 'Animation idle của GRAND (tuần tự)' })
    grandAnimIdle: string = 'grand_idle';

    @property({ tooltip: 'Animation trúng của GRAND (play 1 lần khi win)' })
    grandAnimWin: string = 'grand_win';

    @property({ tooltip: 'Animation idle của MAJOR (tuần tự)' })
    majorAnimIdle: string = 'major_idle';

    @property({ tooltip: 'Animation trúng của MAJOR (play 1 lần khi win)' })
    majorAnimWin: string = 'major_win';

    @property({ tooltip: 'Animation idle của MINOR (tuần tự)' })
    minorAnimIdle: string = 'minor_idle';

    @property({ tooltip: 'Animation trúng của MINOR (play 1 lần khi win)' })
    minorAnimWin: string = 'minor_win';

    @property({ tooltip: 'Animation idle của MINI (tuần tự)' })
    miniAnimIdle: string = 'mini_idle';

    @property({ tooltip: 'Animation trúng của MINI (play 1 lần khi win)' })
    miniAnimWin: string = 'mini_win';

    // ─── PRIVATE ─────────────────────────────────────────────────────────────

    /**
     * Thứ tự hiển thị tuần tự: Grand → Major → Minor → Mini.
     * Index 0 = Grand, 1 = Major, 2 = Minor, 3 = Mini.
     */
    private get _seqSpines(): (sp.Skeleton | null)[] {
        return [this.spineGrand, this.spineMajor, this.spineMinor, this.spineMini];
    }

    /** Tên animIdle tương ứng với vị trí trong _seqSpines (Grand=0, Major=1, Minor=2, Mini=3) */
    private get _seqIdleAnims(): string[] {
        return [this.grandAnimIdle, this.majorAnimIdle, this.minorAnimIdle, this.miniAnimIdle];
    }

    /**
     * Ánh xạ jackpot index theo thứ tự server [MINI=0, MINOR=1, MAJOR=2, GRAND=3] → sp.Skeleton.
     * Dùng khi tra cứu spine theo JackpotType (jackpot - 1).
     */
    private get _spineByIndex(): (sp.Skeleton | null)[] {
        return [this.spineMini, this.spineMinor, this.spineMajor, this.spineGrand];
    }

    /** Ánh xạ jackpot index theo thứ tự server [MINI=0, MINOR=1, MAJOR=2, GRAND=3] → effect Node. */
    private get _effectByIndex(): (Node | null)[] {
        return [this.jackpotEffectMini, this.jackpotEffectMinor, this.jackpotEffectMajor, this.jackpotEffectGrand];
    }

    /** Tên animWin tương ứng với _spineByIndex (MINI=0, MINOR=1, MAJOR=2, GRAND=3) */
    private get _winAnimByIndex(): string[] {
        return [this.miniAnimWin, this.minorAnimWin, this.majorAnimWin, this.grandAnimWin];
    }

    /** Tên animIdle tương ứng với _spineByIndex (MINI=0, MINOR=1, MAJOR=2, GRAND=3) */
    private get _idleAnimByIndex(): string[] {
        return [this.miniAnimIdle, this.minorAnimIdle, this.majorAnimIdle, this.grandAnimIdle];
    }

    /** Trả về slot node tương ứng với jackpot index (MINI=0, MINOR=1, MAJOR=2, GRAND=3).
     *  slotNodes order: [0]=Grand [1]=Minor [2]=Major [3]=Mini  */
    private _getSlotNodeByIndex(jackpotIndex: number): Node | null {
        const slotIndexMap = [3, 1, 2, 0]; // MINI→3, MINOR→1, MAJOR→2, GRAND→0
        const slotIdx = slotIndexMap[jackpotIndex];
        if (slotIdx === undefined) return null;
        return this.jackpotSlotNodes[slotIdx] ?? null;
    }

    /** Flag: jackpot này đến từ long spin (spine đã play tại LONG_SPIN_JACKPOT_REVEAL) */
    private _isLongSpinJackpot: boolean = false;

    /** Flag tuần tự đang chạy hay không */
    private _seqActive: boolean = false;

    /** Index spine hiện tại trong vòng tuần tự (0 = Grand, 1 = Major, 2 = Minor, 3 = Mini) */
    private _seqIndex: number = 0;

    /** Cache giá trị hiển thị trước đó — tránh rebuild SpriteNumber khi giá trị không đổi. */
    private _cachedValues: { grand: number; major: number; minor: number; mini: number } | null = null;

    /** Các tween đang chạy cho SpriteNumber — dùng để stop khi có giá trị mới. */
    private _tweenMap: Map<SpriteNumber, Tween<{ val: number }>> = new Map();

    // ─── LIFECYCLE ───────────────────────────────────────────────────────────

    onLoad(): void {
        JackpotDisplay._instance = this;
        Log.d('[JackpotDisplay] onLoad — component initialized');
        this._ensureLabels();
        this._setAllEffectsInactive();
        this._updateAll();
        this._startSequential();
        EventBus.instance.on(GameEvents.JACKPOT_VALUES_UPDATED, this._onJackpotValuesUpdated, this);
        EventBus.instance.on(GameEvents.BET_CHANGED, this._onBetChanged, this);
        EventBus.instance.on(GameEvents.JACKPOT_TRIGGER, this._onJackpotTrigger, this);
        EventBus.instance.on(GameEvents.LONG_SPIN_JACKPOT_REVEAL, this._onLongSpinJackpotReveal, this);
        EventBus.instance.on(GameEvents.JACKPOT_END, this._onJackpotEnd, this);
        const matchEvent = GameEvents.PICK_GAME_MATCH_FOUND ?? 'pickgame:match:found';
        Log.d(`[JackpotDisplay] Register listener for: ${matchEvent}`);
        EventBus.instance.on(matchEvent, this._onPickGameMatchFound, this);
    }

    onDestroy(): void {
        if (JackpotDisplay._instance === this) JackpotDisplay._instance = null;
        this._seqActive = false;
        for (const tw of this._tweenMap.values()) {
            tw.stop();
        }
        this._tweenMap.clear();
        EventBus.instance.offTarget(this);
    }

    // ─── EVENT HANDLERS ──────────────────────────────────────────────────────

    private _onJackpotValuesUpdated(_vals: number[]): void {
        this._updateAll();
    }

    private _onBetChanged(): void {
        this._updateAll();
    }

    private _onJackpotTrigger(jackpot: JackpotType): void {
        // JackpotType: MINI=1, MINOR=2, MAJOR=3, GRAND=4 → spine index = jackpot - 1
        Log.d(`[JackpotDisplay] _onJackpotTrigger received: jackpot=${JackpotType[jackpot]}(${jackpot}) _isLongSpin=${this._isLongSpinJackpot}`);
        const jackpotIndex = jackpot - 1;
        // Active effect node đúng loại, tắt các node còn lại
        this._setActiveEffect(jackpotIndex);
        if (!this._isLongSpinJackpot) {
            this._playJackpotWin(jackpotIndex);
        }
        this._isLongSpinJackpot = false;
    }

    private _onLongSpinJackpotReveal(_positions: { reelIndex: number; rowIndex: number }[], jackpot: JackpotType): void {
        // Reel 3 vừa chạm đích — play spine ngay, trước khi popup hiện.
        this._isLongSpinJackpot = true;
        this._playJackpotWin(jackpot - 1);
    }

    private _onJackpotEnd(): void {
        Log.d('[JackpotDisplay] _onJackpotEnd — tắt tất cả effect nodes');
        this._setAllEffectsInactive();
    }

    private _onPickGameMatchFound(jackpot: JackpotType): void {
        const jackpotIndex = jackpot - 1; // MINI=1→0, MINOR=2→1, MAJOR=3→2, GRAND=4→3
        Log.d(`[JackpotDisplay] _onPickGameMatchFound: jackpot=${JackpotType[jackpot]}(${jackpot}) index=${jackpotIndex}`);
        // Active effect node đúng loại, tắt các node còn lại (đã gán sẵn parent)
        this._setActiveEffect(jackpotIndex);
    }

    /** Active effect node đúng loại theo jackpotIndex, tắt tất cả còn lại. */
    private _setActiveEffect(jackpotIndex: number): void {
        const effects = this._effectByIndex;
        for (let i = 0; i < effects.length; i++) {
            const e = effects[i];
            if (!e) continue;
            e.active = (i === jackpotIndex);
        }
        const active = effects[jackpotIndex];
        if (active) {
            for (const particle of active.getComponentsInChildren(ParticleSystem)) {
                particle.stop();
                particle.clear();
                particle.play();
            }
        }
        Log.d(`[JackpotDisplay] effect active index=${jackpotIndex} node=${active?.name ?? 'null'}`);
    }

    /** Mặc định ẩn toàn bộ effect; chỉ effect được gọi mới được active. */
    private _setAllEffectsInactive(): void {
        for (const effect of this._effectByIndex) {
            if (effect) effect.active = false;
        }
    }

    /**
     * Prize nodes theo thứ tự presentation: Grand → Major → Minor → Mini.
     * Dùng làm đích bay Upgrade coin.
     */
    public getUpgradeTargetNodes(): Node[] {
        const grand = this.jackpotSlotNodes[0] ?? this.grandLabel?.node ?? null;
        const major = this.jackpotSlotNodes[2] ?? this.majorLabel?.node ?? null;
        const minor = this.jackpotSlotNodes[1] ?? this.minorLabel?.node ?? null;
        const mini  = this.jackpotSlotNodes[3] ?? this.miniLabel?.node ?? null;
        return [grand, major, minor, mini].filter((n): n is Node => !!n?.isValid);
    }

    /** Nhún slot jackpot khi 3 clone Upgrade chạm đích — FX dùng template trên PickGamePopup. */
    public playUpgradeSlotPulse(waveIndex: number): void {
        this._ensureLabels();
        const slot = this.getUpgradeTargetNodes()[waveIndex];
        this._pulseUpgradeSlot(slot);
        Log.d(`[JackpotDisplay] upgrade slot pulse wave=${waveIndex}`);
    }

    /** @deprecated FX cũ — chỉ giữ pulse slot; dùng playUpgradeSlotPulse. */
    public playUpgradeBurstAtTier(waveIndex: number): void {
        this.playUpgradeSlotPulse(waveIndex);
    }

    /** Pulse đồng thời 4 slot (fallback). */
    public playUpgradeBurst(): void {
        this._ensureLabels();
        const slots = this.getUpgradeTargetNodes();
        for (const slot of slots) {
            this._pulseUpgradeSlot(slot);
        }
        Log.d(`[JackpotDisplay] upgrade slot pulse all slots=${slots.length}`);
    }

    private _pulseUpgradeSlot(slot: Node | null | undefined): void {
        if (!slot?.isValid) return;
        Tween.stopAllByTarget(slot);
        const base = slot.scale.clone();
        slot.setScale(base);
        tween(slot)
            .to(0.12, { scale: new Vec3(base.x * 1.18, base.y * 1.18, 1) }, { easing: 'sineOut' })
            .to(0.18, { scale: base }, { easing: 'backOut' })
            .start();
    }

    private _ensureLabels(): void {
        const fromSlot = (slot: Node | null | undefined): SpriteNumber | null =>
            slot?.getComponentInChildren(SpriteNumber) ?? null;
        if (!this.grandLabel) this.grandLabel = fromSlot(this.jackpotSlotNodes[0]);
        if (!this.minorLabel) this.minorLabel = fromSlot(this.jackpotSlotNodes[1]);
        if (!this.majorLabel) this.majorLabel = fromSlot(this.jackpotSlotNodes[2]);
        if (!this.miniLabel) this.miniLabel = fromSlot(this.jackpotSlotNodes[3]);
    }

    // ─── SEQUENTIAL LOOP ─────────────────────────────────────────────────────

    /**
     * Bắt đầu vòng lặp tuần tự từ Grand.
     * Freeze tất cả spine tại animA frame 0, rồi play lần lượt.
     */
    private _startSequential(): void {
        this._seqActive = true;
        this._seqIndex = 0;
        // Freeze tất cả spine tại animIdle frame 0 của từng loại
        const spines = this._seqSpines;
        const idleAnims = this._seqIdleAnims;
        for (let i = 0; i < spines.length; i++) {
            const s = spines[i];
            if (s) this._freezeAtIdle(s, idleAnims[i]);
        }
        this._playSeqStep();
    }

    /**
     * Play animA cho spine hiện tại trong vòng tuần tự.
     * Khi xong → freeze → chuyển sang spine tiếp theo → lặp lại.
     */
    private _playSeqStep(): void {
        if (!this._seqActive) return;

        const spines = this._seqSpines;
        const idleAnims = this._seqIdleAnims;
        // Bỏ qua spine null, tìm spine tiếp theo hợp lệ
        let attempts = 0;
        while (!spines[this._seqIndex] && attempts < spines.length) {
            this._seqIndex = (this._seqIndex + 1) % spines.length;
            attempts++;
        }

        const spine = spines[this._seqIndex];
        if (!spine) return; // Không có spine nào hợp lệ

        // Chỉ play idle animation cho Grand (index 0), các loại khác freeze và bỏ qua
        if (this._seqIndex !== 0) {
            this._seqIndex = (this._seqIndex + 1) % spines.length;
            this._playSeqStep();
            return;
        }

        const idleAnim = idleAnims[this._seqIndex];
        spine.setCompleteListener(null);
        spine.timeScale = 1;
        spine.setAnimation(0, idleAnim, false);
        spine.setCompleteListener(() => {
            if (!this._seqActive) return;
            spine.setCompleteListener(null);
            this._freezeAtIdle(spine, idleAnim);
            this._seqIndex = (this._seqIndex + 1) % spines.length;
            this._playSeqStep();
        });
    }

    /**
     * Freeze spine tại frame đầu của animation idle của nó (timeScale = 0).
     */
    private _freezeAtIdle(spine: sp.Skeleton, idleAnim: string): void {
        spine.setCompleteListener(null);
        spine.timeScale = 0;
        spine.setAnimation(0, idleAnim, false);
    }

    // ─── JACKPOT WIN ─────────────────────────────────────────────────────────

    /**
     * Dừng vòng tuần tự, freeze tất cả spine, play animB trên spine trúng.
     * Sau khi animB xong → restart vòng tuần tự.
     *
     * @param jackpotIndex  Index theo thứ tự server: MINI=0, MINOR=1, MAJOR=2, GRAND=3.
     */
    private _playJackpotWin(jackpotIndex: number): void {
        Log.d(`[JackpotDisplay] _playJackpotWin called: jackpotIndex=${jackpotIndex} slotNodes=${this.jackpotSlotNodes.length}`);
        // Dừng vòng tuần tự
        this._seqActive = false;

        // Freeze tất cả spine tại animIdle frame 0 của từng loại
        const seqSpines = this._seqSpines;
        const seqIdles = this._seqIdleAnims;
        for (let i = 0; i < seqSpines.length; i++) {
            const s = seqSpines[i];
            if (s) this._freezeAtIdle(s, seqIdles[i]);
        }

        // Play animWin trên spine trúng jackpot
        const spines = this._spineByIndex;
        const winAnims = this._winAnimByIndex;
        const idleAnims = this._idleAnimByIndex;
        if (jackpotIndex < 0 || jackpotIndex >= spines.length) {
            // effect giữ active cho đến JACKPOT_END
            this.scheduleOnce(() => {
                this._startSequential();
            }, 2.0);
            return;
        }
        const winSpine = spines[jackpotIndex];
        if (!winSpine) {
            // Không có spine → restart sequential sau delay (effect giữ active cho đến JACKPOT_END)
            this.scheduleOnce(() => {
                this._startSequential();
            }, 2.0);
            return;
        }

        const winAnim = winAnims[jackpotIndex];
        const idleAnim = idleAnims[jackpotIndex];
        winSpine.setCompleteListener(null);
        winSpine.timeScale = 1;
        winSpine.setAnimation(0, winAnim, false);
        winSpine.setCompleteListener(() => {
            winSpine.setCompleteListener(null);
            // Freeze spine trúng lại trước khi restart
            this._freezeAtIdle(winSpine, idleAnim);
            // Quay lại vòng tuần tự từ đầu
            this._startSequential();
        });
    }

    // ─── UPDATE ──────────────────────────────────────────────────────────────

    /**
     * Cập nhật tất cả các label từ jackpotValues API server
     * (poll Wins / spin After: [MINI, MINOR, MAJOR, GRAND]).
     * Không hardcode / không tính totalBet × multiplier.
     */
    private _updateAll(): void {
        this._ensureLabels();
        const vals = GameData.instance.jackpotValues;   // [MINI=0, MINOR=1, MAJOR=2, GRAND=3]
        const truncate3 = (n: number) => Math.floor(n * 1000) / 1000;
        const mini  = truncate3(Number(vals?.[0]) || 0);
        const minor = truncate3(Number(vals?.[1]) || 0);
        const major = truncate3(Number(vals?.[2]) || 0);
        const grand = truncate3(Number(vals?.[3]) || 0);

        const ci = this.currencyIndex;
        const c = this._cachedValues;
        const animG = !c || c.grand !== grand;
        const animMaj = !c || c.major !== major;
        const animMin = !c || c.minor !== minor;
        const animMini = !c || c.mini !== mini;
        if (animG || animMaj || animMin || animMini) {
            Log.e(
                `[Jackpot] Display animate G=${grand} Maj=${major} Min=${minor} Mini=${mini}` +
                ` labels=${!!this.grandLabel}/${!!this.majorLabel}/${!!this.minorLabel}/${!!this.miniLabel}` +
                ` flags=${animG}/${animMaj}/${animMin}/${animMini}`
            );
        }
        if (animG) { this._animateValue(this.grandLabel, c?.grand ?? grand, grand, ci); }
        if (animMaj) { this._animateValue(this.majorLabel, c?.major ?? major, major, ci); }
        if (animMin) { this._animateValue(this.minorLabel, c?.minor ?? minor, minor, ci); }
        if (animMini) { this._animateValue(this.miniLabel, c?.mini ?? mini, mini, ci); }
        this._cachedValues = { grand, major, minor, mini };
    }

    /**
     * Tween giá trị từ `from` đến `to` cho một SpriteNumber.
     * Không phát âm thanh count.
     */
    private _animateValue(label: SpriteNumber | null, from: number, to: number, currencyIndex: number, duration: number = 0.8): void {
        if (!label) return;
        const oldTween = this._tweenMap.get(label);
        if (oldTween) {
            oldTween.stop();
            this._tweenMap.delete(label);
        }
        if (Math.abs(from - to) < 0.01) {
            const toTrunc = Math.floor(to * 1000) / 1000;
            label.setData(toTrunc, currencyIndex, 3);
            return;
        }
        const obj = { val: from };
        const tw = tween(obj)
            .to(duration, { val: to }, {
                easing: 'quadOut',
                onUpdate: (_obj, ratio) => {
                    const cur = naturalCountUpValue(from, to, ratio ?? 0, 3);
                    label.setData(cur, currencyIndex, 3);
                },
            })
            .call(() => {
                this._tweenMap.delete(label);
            })
            .start();
        this._tweenMap.set(label, tw);
    }

    /** Refresh (dùng nếu bet/coin thay đổi) */
    public refresh(): void {
        this._updateAll();
    }
}
