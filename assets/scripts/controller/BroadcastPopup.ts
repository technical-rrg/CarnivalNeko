import {
    _decorator,
    assetManager,
    Component,
    ImageAsset,
    Label,
    Mat4,
    Node,
    screen,
    Sprite,
    SpriteFrame,
    Texture2D,
    tween,
    UIOpacity,
    UITransform,
    Vec3,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { Log } from '../core/Logger';
import { ServerWinBroadcast } from '../data/SlotTypes';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

const LS_BROADCAST_ON = 'setting_broadcast_on';
const TRANSITION_NODE_NAME = 'Transition';

/**
 * Broadcast trên GameRoot, nhưng luôn ngay dưới Transition nếu cùng parent.
 * setSiblingIndex splice-remove trước khi insert — cần chỉnh index theo vị trí cũ.
 */
export function placeBroadcastBelowTransition(node: Node): void {
    const parent = node.parent;
    if (!parent?.isValid) return;

    const transition = parent.getChildByName(TRANSITION_NODE_NAME);
    if (transition?.isValid && transition !== node) {
        const tIdx = transition.getSiblingIndex();
        const myIdx = node.getSiblingIndex();
        node.setSiblingIndex(myIdx < tIdx ? tIdx - 1 : tIdx);
        return;
    }

    node.setSiblingIndex(parent.children.length - 1);
}

// ─── Timeline (total 3.0s per popup) ───────────────────────────────────────
// 0.0 → 0.5s  SLIDE_DURATION   : UI trượt vào, form nền hiển thị (nội dung ẩn)
// 0.5 → 1.0s  ANIM_DURATION    : Lever pull + Speedline animation
// 1.0 → 2.5s  DISPLAY_DURATION : Hiện 5 thông tin lõi, popup nằm im 1.5s
// 2.5 → 3.0s  SLIDE_DURATION   : UI trượt ra ngoài màn hình
const SLIDE_DURATION   = 0.5;
const ANIM_DURATION    = 0.5;
const DISPLAY_DURATION = 2;
const REST_DURATION    = 3.0;

/**
 * BroadcastManager — attach vào root node của prefab BroadcastPopup.
 * Kéo thả các child node vào đúng slot @property trong Inspector.
 */
@ccclass('BroadcastManager')
export class BroadcastManager extends Component {
    @property({ tooltip: 'Hiện log khi nhận/skip broadcast message.' })
    debugLog = false;

    /** Sprite hiển thị ảnh thumbnail game (SlotIcon) */
    @property({ type: Sprite })
    thumbSprite: Sprite | null = null;

    /** Sprite hiển thị cờ quốc gia (CountryFlagIcon) */
    @property({ type: Sprite })
    flagSprite: Sprite | null = null;

    /** Sprite hiển thị ảnh win grade (WinPopupUrl) */
    @property({ type: Sprite })
    gradeSprite: Sprite | null = null;

    /** Label fallback khi chưa load được ảnh grade */
    @property({ type: Label })
    gradeFallback: Label | null = null;

    /** Label tên tính năng (Feature) */
    @property({ type: Label })
    featureLabel: Label | null = null;

    /** Node hình ball — nằm cố định trên đỉnh pillar */
    @property({ type: Node })
    slotBall: Node | null = null;

    /** Node hình pillar — scale Y nhỏ lại rồi bounce lên để tạo hiệu ứng pull */
    @property({ type: Node })
    slotPillar: Node | null = null;

    /** Node sprite animation cho speed line — chứa 1 Sprite component */
    @property({ type: Node })
    speedLineSprite: Node | null = null;

    /** Frame 1 của speed line (0-0.23s) */
    @property({ type: SpriteFrame })
    speedLineFrame1: SpriteFrame | null = null;

    /** Frame 2 của speed line (0.23-0.46s, lật nhanh) */
    @property({ type: SpriteFrame })
    speedLineFrame2: SpriteFrame | null = null;

    /** Frame 3 của speed line (0.23-0.46s, lật nhanh) */
    @property({ type: SpriteFrame })
    speedLineFrame3: SpriteFrame | null = null;

    /** Node viewport dùng Mask cho tên người chơi (có UITransform + Mask component) */
    @property({ type: Node })
    nameViewport: Node | null = null;

    /** Label tên người chơi bên trong nameViewport */
    @property({ type: Label })
    nameLabel: Label | null = null;

    /** Node đánh dấu vị trí ẩn — popup luôn ở đây lúc idle, slide ra khi show */
    @property({ type: Node })
    posFrom: Node | null = null;

    /** Node đánh dấu vị trí hiện — popup slide tới đây khi show, rời đi khi hide */
    @property({ type: Node })
    posTo: Node | null = null;

    private _opacity: UIOpacity | null = null;
    private _isShowing = false;
    private _isResting = false;
    private _broadcastEnabled = true;
    // Cached inv matrix reused each call (avoid allocation)
    private readonly _invMat = new Mat4();
    // Dedup: mỗi Seq chỉ được hiển thị đúng 1 lần (spec §4) — string key
    private _seenSeqs = new Set<string>();

    // Jackpot guard: giữ broadcast lại trong khi jackpot đang hiển, phảt lại sau
    private _jackpotActive = false;
    // Spin guard: giữ broadcast trong khi reel đang quay (trước khi jackpot trigger)
    private _spinActive = false;
    private _pendingMessage: ServerWinBroadcast | null = null;
    // Game-ready guard: không hiện broadcast cho đến khi GAME_READY (đã vào GameView)
    private _gameReady = false;

    onLoad(): void {
        this._broadcastEnabled = this._loadBroadcastEnabled();
        this._opacity = this.node.getComponent(UIOpacity);
        // Giữ active=true — node inactive sẽ không nhận schedule/tween, broadcast không hiện.
        // Idle: đặt tại posFrom (ngoài màn hình) trong start().
        EventBus.instance.on(GameEvents.BROADCAST_WIN_MESSAGE, this._onBroadcastMessage, this);
        EventBus.instance.on(GameEvents.BROADCAST_SETTING_CHANGED, this._onBroadcastSettingChanged, this);
        EventBus.instance.on(GameEvents.JACKPOT_TRIGGER, this._onJackpotTrigger, this);
        EventBus.instance.on(GameEvents.JACKPOT_END, this._onJackpotEnd, this);
        EventBus.instance.on(GameEvents.REELS_START_SPIN, this._onReelsStartSpin, this);
        EventBus.instance.on(GameEvents.NORMAL_SPIN_DONE, this._onNormalSpinDone, this);
        EventBus.instance.on(GameEvents.GAME_READY, this._onGameReady, this);
        screen.on('orientation-change', this._onOrientationChange, this);
    }

    start(): void {
        this._snapToIdlePosition();
    }

    /** Wire PosFrom/PosTo từ Base root (marker nằm ngoài prefab sau khi tách). */
    bindPositionMarkers(posFrom: Node | null, posTo: Node | null): void {
        this.posFrom = posFrom;
        this.posTo = posTo;
        this._snapToIdlePosition();
        Log.d(`[Broadcast] bindPositionMarkers — posFrom=${!!posFrom}, posTo=${!!posTo}`);
    }

    /** Loader gọi nếu GAME_READY đã fire trước khi prefab instantiate. */
    syncGameReady(alreadyReady: boolean): void {
        if (alreadyReady && !this._gameReady) {
            this._onGameReady();
        }
    }

    /** Loader replay message bị miss khi lazy-load chưa xong. */
    deliverMessage(message: ServerWinBroadcast): void {
        this._onBroadcastMessage(message);
    }

    private _snapToIdlePosition(): void {
        if (this.posFrom) {
            this.node.setPosition(this._nodeToParentLocal(this.posFrom));
        }
    }

    onDestroy(): void {
        this.unscheduleAllCallbacks();
        screen.off('orientation-change', this._onOrientationChange, this);
        EventBus.instance.offTarget(this);
    }

    private _onOrientationChange(): void {
        // posFrom / posTo đã dời theo layout mới — cập nhật vị trí popup ngay lập tức
        if (!this.node.active) return;

        const fromPos = this.posFrom ? this._nodeToParentLocal(this.posFrom) : null;
        const toPos   = this.posTo   ? this._nodeToParentLocal(this.posTo)   : null;

        if (this._isShowing) {
            // Đang slide/display: dừng tween cũ, snap về posTo (popup đang hiện cho user)
            tween(this.node).stop();
            if (toPos) this.node.setPosition(toPos);
        } else {
            // Idle (rest) hoặc sau slide-out: snap về posFrom
            if (fromPos) this.node.setPosition(fromPos);
        }
    }

    private _onBroadcastMessage(message: ServerWinBroadcast): void {
        if (!this._broadcastEnabled) return;
        // spec §4: mỗi Seq chỉ hiển thị đúng 1 lần
        if (this._seenSeqs.has(message.Seq)) return;
        if (this._isShowing || this._isResting) return;
        // Chưa vào GameView — giữ lại, phát sau khi GAME_READY
        if (!this._gameReady) {
            this._pendingMessage = message;
            return;
        }
        // Jackpot đang chạy — giữ lại, phát sau khi jackpot kết thúc
        if (this._spinActive || this._jackpotActive) {
            // chỉ giữ message mới nhất (1 slot)
            this._pendingMessage = message;
            return;
        }
        this._seenSeqs.add(message.Seq);
        if (this._seenSeqs.size > 200) {
            this._seenSeqs.delete(this._seenSeqs.values().next().value!);
        }
        Log.d(`[Broadcast] SHOW Seq=${message.Seq} Nick="${message.DisplayName || message.Nick}" Feature="${message.Feature}" MX=${message.MX}`);
        this._show(message);
    }

    private _onJackpotTrigger(): void {
        // Jackpot trigger = spin result đã rõ, nhưng popup chưa hiện
        // Giữ block, chuyển từ spin guard sang jackpot guard
        this._spinActive = false;
        this._jackpotActive = true;
    }

    private _onReelsStartSpin(): void {
        this._spinActive = true;
    }

    private _onNormalSpinDone(): void {
        // Chỉ unblock spin nếu jackpot không tiếp quản (non-jackpot spin)
        if (this._jackpotActive) return;
        this._spinActive = false;
        this._tryShowPending();
    }

    private _onJackpotEnd(): void {
        this._jackpotActive = false;
        this._spinActive = false;
        // Restore vị trí đúng sau jackpot
        this._ensureLayerBelowTransition();
        this._tryShowPending();
    }

    private _tryShowPending(): void {
        if (!this._gameReady || this._spinActive || this._jackpotActive) return;
        const msg = this._pendingMessage;
        if (!msg) return;
        this._pendingMessage = null;
        this._seenSeqs.add(msg.Seq);
        if (this._seenSeqs.size > 200) {
            this._seenSeqs.delete(this._seenSeqs.values().next().value!);
        }
        this.scheduleOnce(() => this._show(msg), 0.3);
    }

    private _onGameReady(): void {
        this._gameReady = true;
        this._tryShowPending();
    }

    private _onBroadcastSettingChanged(enabled: boolean): void {
        this._broadcastEnabled = enabled;
        if (!enabled) {
            this._hideImmediately();
        }
    }

    private _show(message: ServerWinBroadcast): void {
        this._isShowing = true;
        this._isResting = false;
        this._applyMessage(message);
        SoundManager.instance?.playGlobalWin();

        // Đọc vị trí mỗi lần show — đảm bảo đúng theo layout hiện tại (cả landscape lẫn portrait)
        const fromPos = this.posFrom ? this._nodeToParentLocal(this.posFrom) : this.node.position.clone();
        const toPos   = this.posTo   ? this._nodeToParentLocal(this.posTo)   : fromPos.clone();

        this.node.active = true;
        this.node.setPosition(fromPos);
        if (this._opacity) this._opacity.opacity = 255;

        // Trên GameRoot / progressiveWin, nhưng luôn dưới Transition
        this._ensureLayerBelowTransition();

        // SpeedLine active + frame 1 từ ngay khi slide-in bắt đầu
        if (this.speedLineSprite && this.speedLineFrame1) {
            const sl = this.speedLineSprite.getComponent(Sprite);
            if (sl) { sl.spriteFrame = this.speedLineFrame1; }
            this.speedLineSprite.active = true;
        }

        tween(this.node).stop();
        tween(this.node)
            // 0.0 → 0.5s: slide in posFrom → posTo
            .to(SLIDE_DURATION, { position: toPos }, { easing: 'quadOut' })
            // 0.5s: kích hoạt lever + speedline
            .call(() => {
                this._playSlotPullAnimation();
                this._playSpeedLineAnimation();
            })
            // 0.5 → 1.0s: chờ animation kết thúc
            .delay(ANIM_DURATION)
            // 1.0 → 2.5s: display
            .delay(DISPLAY_DURATION)
            // 2.5 → 3.0s: slide out posTo → posFrom
            .to(SLIDE_DURATION, { position: fromPos }, { easing: 'quadIn' })
            .call(() => this._beginRest())
            .start();
    }

    /**
     * Chuyển world position của node sang local space của parent popup.
     * Dùng Mat4 invert để xử lý đúng mọi scale/rotation/orientation.
     */
    private _nodeToParentLocal(node: Node): Vec3 {
        const worldPos = new Vec3();
        node.getWorldPosition(worldPos);
        const local = new Vec3();
        if (this.node.parent) {
            Mat4.invert(this._invMat, this.node.parent.worldMatrix);
            Vec3.transformMat4(local, worldPos, this._invMat);
        } else {
            Vec3.copy(local, worldPos);
        }
        return local;
    }

    /** Trên GameRoot, ngay dưới Transition nếu cùng parent. */
    private _ensureLayerBelowTransition(): void {
        placeBroadcastBelowTransition(this.node);
    }

    private _beginRest(): void {
        // Popup đã về posFrom sau slide-out — giữ node active để scheduleOnce hoạt động
        this._isShowing = false;
        this._isResting = true;
        this.scheduleOnce(() => {
            this._isResting = false;
        }, REST_DURATION);
    }

    private _hideImmediately(): void {
        tween(this.node).stop();
        if (this.posFrom) {
            this.node.setPosition(this._nodeToParentLocal(this.posFrom));
        }
        if (this._opacity) this._opacity.opacity = 255;
        this._isShowing = false;
        this._isResting = false;
    }

    private _applyMessage(message: ServerWinBroadcast): void {
        const featureName = this._formatFeature(message.Feature || this._gradeFromUrl(message.WinPopupUrl));
        // Server gửi "Nick" = UUID. Ƭu tiên DisplayName nếu có, fallback Nick
        const nick = this._formatNick(message.DisplayName || message.Nick || '');
        const gradeText = this._formatGrade(message.Feature || this._gradeFromUrl(message.WinPopupUrl));

        // Ẩn các content element trước khi chạy speed line animation
        if (this.thumbSprite) this.thumbSprite.node.active = false;
        if (this.flagSprite) this.flagSprite.node.active = false;
        if (this.nameLabel) this.nameLabel.node.active = false;
        if (this.featureLabel) this.featureLabel.string = featureName;
        if (this.nameLabel) {
            this.nameLabel.string = nick;
        }
        if (this.gradeFallback) this.gradeFallback.string = gradeText;
        if (this.gradeSprite) this.gradeSprite.node.active = false;
        if (this.gradeFallback) this.gradeFallback.node.active = true;

        this._loadRemoteSprite(message.SlotIcon, this.thumbSprite, false);
        this._loadRemoteSprite(message.CountryFlagIcon || this._flagUrlFromLang(message.LangID), this.flagSprite, false);
        this._loadRemoteSprite(message.WinPopupUrl, this.gradeSprite, true);
    }

    private _loadRemoteSprite(url: string, sprite: Sprite | null, hideFallbackOnSuccess: boolean): void {
        if (!url || !sprite) return;
        const ext = this._guessImageExt(url);
        assetManager.loadRemote<ImageAsset>(url, { ext }, (err, imageAsset) => {
            if (err || !imageAsset || !sprite.isValid) {
                if (this.debugLog) Log.w(`[Broadcast] image load failed: ${url}`, err);
                return;
            }
            const texture = new Texture2D();
            texture.image = imageAsset;
            const frame = new SpriteFrame();
            frame.texture = texture;
            sprite.spriteFrame = frame;
            sprite.node.active = true;
            if (hideFallbackOnSuccess && this.gradeFallback) this.gradeFallback.node.active = false;
        });
    }

    private _playSlotPullAnimation(): void {
        if (!this.slotPillar || !this.slotBall) return;

        const pillar = this.slotPillar;
        const ball = this.slotBall;

        const pillarTransform = pillar.getComponent(UITransform);
        const pillarHeight = pillarTransform?.contentSize.height ?? 80;
        const origScaleX = pillar.scale.x;
        const origScaleY = pillar.scale.y;
        const ballOrigY = ball.position.y;
        const ballOrigX = ball.position.x;

        // Ball đi xuống đúng bằng lượng top pillar bị kéo xuống (anchor center)
        const PULL_SCALE = 0.55;
        const ballDrop = pillarHeight * origScaleY * (1 - PULL_SCALE) * 0.5;

        tween(pillar).stop();
        tween(ball).stop();

        // Tổng: 0.20 + 0.20 + 0.10 = 0.50s — khớp ANIM_DURATION
        tween(pillar)
            .to(0.20, { scale: new Vec3(origScaleX, origScaleY * PULL_SCALE, 1) }, { easing: 'quadOut' })
            .to(0.20, { scale: new Vec3(origScaleX, origScaleY * 1.06, 1) }, { easing: 'quadOut' })
            .to(0.10, { scale: new Vec3(origScaleX, origScaleY, 1) }, { easing: 'sineOut' })
            .start();

        tween(ball)
            .to(0.20, { position: new Vec3(ballOrigX, ballOrigY - ballDrop, 0) }, { easing: 'quadOut' })
            .to(0.20, { position: new Vec3(ballOrigX, ballOrigY + ballDrop * 0.06, 0) }, { easing: 'quadOut' })
            .to(0.10, { position: new Vec3(ballOrigX, ballOrigY, 0) }, { easing: 'sineOut' })
            .start();
    }

    private _playSpeedLineAnimation(): void {
        if (!this.speedLineSprite) return;

        const sprite = this.speedLineSprite.getComponent(Sprite);
        if (!sprite) return;

        this.speedLineSprite.active = true;
        tween(this.speedLineSprite).stop();

        // 0.00 → 0.25s: hiện frame 1 (static)
        if (this.speedLineFrame1) sprite.spriteFrame = this.speedLineFrame1;

        // 0.25 → 0.50s: lật nhanh frame 2 & 3 (4 lần × 0.062s ≈ 0.25s)
        // Tổng speedline = 0.50s — khớp ANIM_DURATION
        let flipCount = 0;
        const frames = [this.speedLineFrame2, this.speedLineFrame3];

        const flipCallback = () => {
            if (flipCount < 4) {
                const frame = frames[flipCount % frames.length];
                if (frame) sprite.spriteFrame = frame;
                flipCount++;
            } else {
                this.speedLineSprite!.active = false;
                this._showContentElements();
            }
        };

        tween(this.speedLineSprite)
            .delay(0.25)
            .call(flipCallback)
            .delay(0.062).call(flipCallback)
            .delay(0.062).call(flipCallback)
            .delay(0.062).call(flipCallback)
            .delay(0.062).call(flipCallback)
            .start();
    }

    private _showContentElements(): void {
        if (this.thumbSprite) this.thumbSprite.node.active = true;
        if (this.flagSprite) this.flagSprite.node.active = true;
        if (this.nameLabel) this.nameLabel.node.active = true;
    }

    private _loadBroadcastEnabled(): boolean {
        try {
            const value = localStorage.getItem(LS_BROADCAST_ON);
            return value !== 'false';
        } catch (_) {
            return true;
        }
    }

    private _formatNick(nick: string): string {
        // spec §2: xử lý các trường hợp ẩn tên
        const raw = (nick || '').trim();
        const lower = raw.toLowerCase();
        if (!raw || lower === 'hidden' || lower === 'unknown' || lower === '') return 'UNKNOWN';

        // TODO [PM/QA ⚠️]: Chính sách hiển thị tên người chơi (liên quan tiền thật) CHƯA được chốt.
        // Khi có quyết định từ đối tác, chọn một trong hai mode:
        //   Mode A — Hiển thị đầy đủ (hiện tại): return raw.length >= 8 ? raw : raw.padEnd(8, '*');
        //   Mode B — Ẩn bảo mật: return raw.slice(0, 2).padEnd(Math.max(8, raw.length), '*');
        // Hiện tại: Mode A — hiển thị đủ, tối thiểu 8 ký tự
        return raw.length >= 8 ? raw : raw.padEnd(8, '*');
    }

    private _cleanText(value: string | undefined, fallback: string): string {
        const text = (value || '').trim();
        return text.length > 0 ? text : fallback;
    }

    private _formatFeature(feature: string): string {
        const clean = this._cleanText(feature, 'BIG WIN');
        return clean.replace(/[_-]+/g, ' ').toUpperCase();
    }

    private _formatGrade(feature: string): string {
        const normalized = this._formatFeature(feature);
        // spec §1: Jackpot luôn được ưu tiên trên mọi loại win khác.
        // Nếu message chứa cả MINI lẫn BIG WIN, chỉ hiển thị "MINI".
        const jackpot = ['GRAND', 'MAJOR', 'MINOR', 'MINI'].find((key) => normalized.includes(key));
        if (jackpot) return jackpot;
        if (normalized.includes('MEGA'))  return 'MEGA WIN';
        if (normalized.includes('SUPER')) return 'SUPER WIN';
        if (normalized.includes('BIG'))   return 'BIG WIN';
        return normalized;
    }

    private _gradeFromUrl(url: string): string {
        if (!url) return '';
        const clean = decodeURIComponent(url.split('?')[0].split('/').pop() || '');
        return clean.replace(/\.[a-z0-9]+$/i, '');
    }

    /**
     * spec §3: Cờ xác định theo NGÔN NGỮ của client, không phải vị trí địa lý hay tiền tệ.
     * Ví dụ: người ở Thái Lan chơi bằng tiếng Ả Rập → hiển thị cờ Ả Rập Xê Út.
     */
    private _flagUrlFromLang(langId: string): string {
        const LANG_TO_ISO: Record<string, string> = {
            'en':    'gb',  'ko':    'kr',  'ja':    'jp',
            'zh-cn': 'cn',  'zh-tw': 'tw',  'th':    'th',
            'fil':   'ph',  'vi':    'vn',  'id':    'id',
            'ms':    'my',  'ar':    'sa',  'pt':    'pt',
            'es':    'es',  'fr':    'fr',  'de':    'de',
            'sg':    'sg',  'au':    'au',  'hk':    'hk',
        };
        const iso = LANG_TO_ISO[(langId ?? '').toLowerCase()];
        if (!iso) return '';
        // TODO: thay BASE_URL bằng CDN nội bộ nếu cần
        return `https://flagcdn.com/w40/${iso}.png`;
    }

    private _guessImageExt(url: string): string {
        const lower = url.split('?')[0].toLowerCase();
        if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return '.jpg';
        if (lower.endsWith('.webp')) return '.webp';
        return '.png';
    }
}
