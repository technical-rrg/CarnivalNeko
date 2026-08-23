/**
 * SpriteNumber - Hiển thị số bằng các Sprite riêng lẻ thay vì Bitmap Font.
 *
 * ★ SETUP TRONG EDITOR:
 *   1. Tạo Node (ví dụ: "ScoreDisplay"), gắn component SpriteNumber vào.
 *   2. Component tự động thêm và cấu hình Layout (HORIZONTAL, CONTAINER) khi chạy.
 *      → Bạn có thể điều chỉnh Layout.spacingX bằng property "spacing" trong Inspector.
 *   3. Kéo đúng 10 SpriteFrame (số 0, 1, 2 ... 9) vào mảng numberSprites (phải đúng thứ tự).
 *   4. Kéo SpriteFrame dấu chấm (.) vào dotSprite.
 *   5. Kéo SpriteFrame dấu phẩy (,) vào commaSprite.
 *   6. (Tuỳ chọn) Kéo các SpriteFrame ký hiệu tiền tệ vào mảng currencySprites.
 *      Ví dụ: index 0 = $,  index 1 = đ,  index 2 = ¥
 *   7. Chọn currencyPosition = START (tiền tệ trước số) hoặc END (tiền tệ sau số).
 *
 * ★ GỌI TỪ SCRIPT KHÁC:
 *   import { SpriteNumber } from '../core/SpriteNumber';
 *
 *   const sn = this.scoreNode.getComponent(SpriteNumber);
 *
 *   sn.setData(1234567);        // → "1,234,567"   (không có ký hiệu tiền tệ)
 *   sn.setData(9999.5, 0);      // → "$9,999.50"   (currencySprites[0] = $, position = START)
 *   sn.setData(500, 1);         // → "500đ"         (currencySprites[1] = đ, position = END)
 *
 * ★ NODE POOL:
 *   Component dùng NodePool để tái sử dụng node — không bao giờ destroy/create node
 *   trong quá trình cập nhật, tránh lag khi liên tục refresh điểm số.
 */

import {
    _decorator, Color, Component, Enum, ImageAsset, Label, Node, NodePool,
    Rect, Size, Sprite, SpriteFrame, Texture2D, tween, Tween, UITransform, Vec2, Vec3,
} from 'cc';
import { EventBus } from './EventBus';
import { GameEvents } from './GameEvents';
import { LocalizationManager, LanguageCode } from './LocalizationManager';
import { SoundManager } from '../manager/SoundManager';
import { formatKMBT } from './FormatUtils';
import { Log } from './Logger';

const { ccclass, property } = _decorator;

/**
 * Cache SpriteFrame đã downsample (canvas high-quality) theo scale bucket.
 * Tránh GPU sample atlas lớn xuống rất nhỏ → răng cưa / nhòe mipmap.
 */
const _hqFrameCache = new Map<string, SpriteFrame>();
/** Scale dưới ngưỡng này mới bake HQ frame (shrinkToFit). */
const HQ_DOWNSCALE_THRESHOLD = 0.75;
/** Supersample 2x so với kích thước hiển thị design → sắc trên màn DPR cao. */
const HQ_SUPERSAMPLE = 2;

// ─── Enum ────────────────────────────────────────────────────────────────────

export enum CurrencyPosition {
    /** Ký hiệu tiền tệ đứng TRƯỚC số: ví dụ $1,000 */
    START = 0,
    /** Ký hiệu tiền tệ đứng SAU số: ví dụ 1,000đ */
    END = 1,
}

// ─── Component ───────────────────────────────────────────────────────────────

@ccclass('SpriteNumber')
export class SpriteNumber extends Component {

    // ─── Inspector Properties ─────────────────────────────────────────────

    @property({
        type: [SpriteFrame],
        tooltip: '10 SpriteFrame cho chữ số 0 → 9.\nPHẢI đúng thứ tự: index 0 = hình "0", index 9 = hình "9".',
    })
    numberSprites: SpriteFrame[] = [];

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame cho dấu chấm thập phân (.).',
    })
    dotSprite: SpriteFrame | null = null;

    @property({
        type: SpriteFrame,
        tooltip: 'SpriteFrame cho dấu phẩy phân cách hàng nghìn (,).',
    })
    commaSprite: SpriteFrame | null = null;

    @property({
        type: [SpriteFrame],
        tooltip: 'Mảng ký hiệu tiền tệ.\nVí dụ: index 0 = $,  index 1 = đ,  index 2 = ¥\nTruyền index tương ứng vào setData() để hiển thị.',
    })
    currencySprites: SpriteFrame[] = [];

    @property({
        type: [SpriteFrame],
        tooltip: '4 SpriteFrame cho K, M, B, T (index 0=K, 1=M, 2=B, 3:T).\n' +
                 'Dùng khi setData(..., useKMBT=true) và value >= 100K.',
    })
    kmbtSprites: SpriteFrame[] = [];

    @property({
        type: Enum(CurrencyPosition),
        tooltip: 'START = ký hiệu đứng trước số ($100).\nEND   = ký hiệu đứng sau số (100đ).',
    })
    currencyPosition: CurrencyPosition = CurrencyPosition.START;

    @property({
        tooltip: 'Bật để tự động đổi icon tiền tệ theo currency server trả về (ưu tiên) hoặc ngôn ngữ hiện tại.\n' +
                 'currencySprites: 14 phần tử — en, ko, zh-cn, zh-tw, fil, ja, th, sg, ms, vi, au, hk, C$, USDT.\n' +
                 'Khi ngôn ngữ/currency thay đổi, SpriteNumber tự dùng index tương ứng làm currency index.',
    })
    enableLangCurrency: boolean = false;

    @property({
        tooltip: 'Bật để tự động phát sx_counter_loop khi beginCountUp() và sx_counter_end khi endCountUp().\n' +
                 'Chỉ bật cho node hiển thị tiền đang count-up.',
    })
    enableCountSound: boolean = false;

    @property({
        tooltip: 'Khoảng cách (px) giữa các chữ số kề nhau. Số âm = chồng lên nhau (gần hơn).',
        range: [-100, 100, 1],
        slide: true,
    })
    spacing: number = 2;

    @property({
        tooltip: 'Khoảng cách (px) giữa chữ số cuối và ký tự K/M/B/T trong KMBT mode.\n' +
                 'Dương = tách xa, âm = sát lại.',
        range: [-100, 100, 1],
        slide: true,
    })
    kmbtSpacing: number = 0;

    @property({
        tooltip: 'Khoảng cách phụ thêm quanh dấu chấm (.) và phẩy (,).\nSố âm = gần hơn (chồng vào). Ví dụ: -4 = kéo vào 4px hai phía',
        range: [-30, 20, 1],
        slide: true,
    })
    punctuationSpacingOffset: number = -3;

    @property({
        tooltip: 'Khoảng cách (px) giữa ký hiệu tiền tệ và chữ số.\n' +
                 'Dương = tách xa, âm = sát lại. Mặc định 0 = dùng spacing chung.',
        range: [-100, 100, 1],
        slide: true,
    })
    currencySpacing: number = 0;

    @property({
        tooltip: 'Tỷ lệ khoảng cách giữa ký hiệu tiền tệ và chữ số, tính theo chiều rộng sprite của mệnh giá.\n' +
                 'Ví dụ: 0.1 = 10% width của currency sprite. Mỗi mệnh giá sẽ có khoảng cách khác nhau theo đúng size.',
        range: [0, 1, 0.01],
        slide: true,
    })
    currencySpacingRatio: number = 0;

    @property({
        tooltip: 'Chiều rộng tối đa (px) cho toàn bộ chuỗi số.\n' +
                 'Nếu tổng width vượt quá giá trị này, node sẽ được scale nhỏ lại vừa khít.\n' +
                 '0 = tắt tính năng (lấy theo ContentSize.width của node nếu > 0, ngược lại không giới hạn).',
        range: [0, 2000, 1],
    })
    maxWidth: number = 0;

    @property({
        tooltip: 'Khi bật: tự động thu nhỏ chuỗi số để vừa khít contentSize theo cả chiều rộng lẫn chiều cao,\n' +
                 'tương tự tính năng Shrink của Label. contentSize của node không bị ghi đè.\n' +
                 'Khi tắt (mặc định): hành vi như cũ — chỉ giới hạn theo maxWidth.',
    })
    shrinkToFit: boolean = false;

    @property({
        tooltip: 'Dùng cùng shrinkToFit: phóng to hoặc thu nhỏ chữ số để lấp đầy khung contentSize\n' +
                 '(scale = min(containerW/totalW, containerH/glyphH)). Mặc định tắt — chỉ thu nhỏ khi tràn.',
    })
    fillContainer: boolean = false;

    // ─── Jolt Effect ──────────────────────────────────────────────────────

    @property({
        tooltip: 'Bật/tắt hiệu ứng giật nhún khi setData() được gọi.',
    })
    joltEnabled: boolean = true;

    @property({
        tooltip: 'Thời gian tối thiểu (giây) giữa hai lần giật.\n' +
                 'Được random giữa Min-Max để tạo cảm giác sét đánh tự nhiên hơn.',
        range: [0, 5, 0.05],
        slide: true,
    })
    joltIntervalMin: number = 0.15;

    @property({
        tooltip: 'Thời gian tối đa (giây) giữa hai lần giật.\n' +
                 'Phải >= joltIntervalMin.',
        range: [0, 5, 0.05],
        slide: true,
    })
    joltIntervalMax: number = 0.35;

    @property({
        tooltip: 'Tổng thời gian của một lần giật (giây).\n' +
                 'Giai đoạn lên chiếm 35%, giai đoạn nẩy trở về chiếm 65%.',
        range: [0.05, 1.5, 0.01],
        slide: true,
    })
    joltDuration: number = 0.3;

    @property({
        tooltip: 'Scale đỉnh khi giật (nhân với scale hiện tại).\n' +
                 'Ví dụ: 1.15 = phình to 15% rồi nẩy về.\n' +
                 '1.0 = không đổi kích thước (chỉ dùng joltOffsetY).',
        range: [1.0, 2.0, 0.01],
        slide: true,
    })
    joltScale: number = 1.12;

    @property({
        tooltip: 'Dịch chuyển dọc (px) tại đỉnh giật. Số dương = lên trên, số âm = xuống dưới.',
        range: [-30, 30, 1],
        slide: true,
    })
    joltOffsetY: number = 6;

    // ─── Private State ────────────────────────────────────────────────────

    /** Pool tái sử dụng node digit/symbol — không bao giờ destroy mid-game. */
    private _pool: NodePool = new NodePool();
    /** Các node đang hiển thị trên màn hình. */
    private _activeNodes: Node[] = [];
    /** Width/Height đã khoá — 0 = dynamic (tính lại mỗi frame). */
    private _lockedWidth: number = 0;
    private _lockedHeight: number = 0;
    /**
     * Kích thước container gốc được snapshot từ UITransform.contentSize tại onLoad().
     * Dùng cho shrinkToFit — KHÔNG bao giờ thay đổi sau khi onLoad() chạy,
     * tránh bug khi contentSize bị ghi đè bởi code ngoài hoặc bởi path shrinkToFit=false.
     */
    private _shrinkContainerW: number = 0;
    private _shrinkContainerH: number = 0;

    /**
     * Scale hiệu dụng sau layout:
     * - shrinkToFit: tỷ lệ scale của digit children (parent giữ _initialScale)
     * - maxWidth: scale của parent node
     */
    private _effectiveScale: number = 1;
    /** Đang trong chế độ count-up — số nguyên sẽ được hiển thị với .00 */
    private _isCounting: boolean = false;
    /** Lưu scale ban đầu của node khi component load — dùng để giữ default scale. */
    private _initialScale: number = 1;
    /** Thời điểm (ms) lần giật cuối cùng — dùng để kiểm tra joltInterval. */
    private _lastJoltTime: number = -Infinity;
    /** Tween hiệu ứng giật đang chạy (nếu có). */
    private _joltTween: Tween<Node> | null = null;
    /** Scale/position cần khôi phục nếu jolt bị cắt giữa chừng. */
    private _joltRestoreScale: Vec3 | null = null;
    private _joltRestorePos: Vec3 | null = null;
    /** True nếu trong session count-up hiện tại đã từng xuất hiện phần lẻ khác 0. */
    private _hasSeenNonZeroDecimal: boolean = false;

    /** Thứ tự ngôn ngữ khớp với SUPPORTED_LANGUAGES trong LocalizationManager. */
    private static readonly LANG_ORDER: LanguageCode[] = [
        'en', 'ko', 'zh-cn', 'zh-tw', 'fil', 'ja', 'th', 'sg', 'ms', 'vi', 'au', 'hk',
    ];

    /**
     * Map currency code (ISO 4217) → index trong currencySprites (khớp LANG_ORDER).
     * Dùng khi enableLangCurrency=true và server trả về currency code rõ ràng.
     * Ưu tiên hơn ngôn ngữ UI đang chọn.
     */
    
    private static readonly CURRENCY_CODE_TO_SPRITE_INDEX: Record<string, number> = {
        // index khớp LANG_ORDER + 2 đơn vị thêm:
        // en=0, ko=1, zh-cn=2, zh-tw=3, fil=4, ja=5, th=6, sg=7, ms=8, vi=9, au=10, hk=11, C$=12, USDT=13
        'USD': 0,  // $   → en sprite
        'KRW': 1,  // ₩   → ko sprite
        'CNY': 2,  // ¥   → zh-cn sprite
        'TWD': 3,  // NT$ → zh-tw sprite
        'PHP': 4,  // ₱   → fil sprite
        'JPY': 5,  // ¥   → ja sprite
        'THB': 6,  // ฿   → th sprite
        'SGD': 7,  // S$  → sg sprite
        'MYR': 8,  // RM  → ms sprite
        'VND': 9,  // ₫   → vi sprite
        'AUD': 10, // A$  → au sprite
        'HKD': 11, // HK$ → hk sprite
        'CAD': 12, // C$  → C$ sprite
        'C$': 12,  // C$  → C$ sprite
        'USDT': 13, // USDT sprite
        'EUR': 0,  // €   → en sprite (fallback)
        'GBP': 0,  // £   → en sprite (fallback)
        'IDR': 0,  // Rp  → en sprite (fallback)
        'INR': 0,  // ₹   → en sprite (fallback)
    };

    /** Params của lần setData() cuối cùng — dùng để re-render khi đổi ngôn ngữ. */
    private _lastValue: number = 0;
    private _lastCurrencyIndex: number = -1;
    private _lastMinDecimals: number = 0;
    private _lastUseKMBT: boolean = false;
    private _hasData: boolean = false;
    /** Giá trị số thực sự được render lần cuối — dùng để skip jolt khi value không đổi. */
    private _prevRenderedValue: number = NaN;

    // ─── Lifecycle ────────────────────────────────────────────────────────

    onLoad(): void {
        // Lưu scale ban đầu của node để sau này áp dụng maxWidth scaling trên cơ sở này
        const initialScale = this.node.scale.x; // Giả sử x, y, z đều bằng nhau
        this._initialScale = initialScale > 0 ? initialScale : 1;

        // Snapshot kích thước container TRƯỚC khi bất kỳ setData() nào chạy.
        // Đây là giá trị đặt trong Editor — dùng làm giới hạn ổn định cho shrinkToFit.
        // Không đọc lại live sau này vì shrinkToFit=false path có thể ghi đè contentSize.
        this._snapshotContainerDims();

        if (this.enableLangCurrency) {
            EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, this._onLanguageChanged, this);
        }

        // Nếu setData() đã được gọi TRƯỚC onLoad() (bởi parent's onLoad),
        // lúc đó _shrinkContainerW/H chưa có giá trị đúng → re-render lại với params đã lưu.
        if (this._hasData) {
            this.setData(this._lastValue, this._lastCurrencyIndex, this._lastMinDecimals);
        }
    }

    /**
     * Snapshot kích thước container từ UITransform.
     * Chỉ ghi khi chưa có giá trị (đảm bảo snapshot 1 lần duy nhất từ Editor).
     */
    private _snapshotContainerDims(): void {
        if (this._shrinkContainerW > 0 || this._shrinkContainerH > 0) return;
        this.refreshContainerDims();
    }

    /**
     * Đọc lại contentSize hiện tại làm khung shrinkToFit / fillContainer.
     * Gọi khi Editor đổi size, hoặc trước khi lockWidth với khung đã override trên prefab.
     */
    public refreshContainerDims(): void {
        const tf = this.node.getComponent(UITransform);
        if (!tf) return;
        this._shrinkContainerW = tf.contentSize.width;
        this._shrinkContainerH = tf.contentSize.height;
    }

    /** Re-render trong Editor khi chỉnh spacing / sprite — không cần gọi setData() thủ công. */
    onValidate(): void {
        if (!this._hasData || !this.numberSprites.length) return;
        this.setData(this._lastValue, this._lastCurrencyIndex, this._lastMinDecimals, this._lastUseKMBT);
    }

    onDestroy(): void {
        this._stopJolt();
        // KHÔNG gọi _recycleAll() ở đây — active digit nodes là children của node này,
        // engine đã queue chúng để destroy trước khi onDestroy() được gọi.
        // Nếu _recycleAll() đưa chúng vào pool rồi _pool.clear() destroy lại → "destroy twice".
        // Chỉ cần clear reference; engine sẽ tự destroy children.
        this._activeNodes.length = 0;
        // Pool nodes không có parent (đã removeFromParent) → an toàn để destroy.
        this._pool.clear();
        EventBus.instance.off(GameEvents.LANGUAGE_CHANGED, this._onLanguageChanged, this);
    }

    // ─── Public API ───────────────────────────────────────────────────────

    /**
     * Scale hiển thị của node (parent) khi shrinkToFit=true.
     * setData() luôn reset về `_initialScale` — phải cập nhật ở đây, nếu không tỉ lệ
     * theo symbol/cell (5×4 / 5×5) sẽ bị mất mỗi lần gán số.
     */
    public setDisplayScale(scale: number): void {
        const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
        this._stopJolt();
        this._initialScale = s;
        this.node.setScale(s, s, 1);
    }

    /**
     * Tính trước kích thước container dựa trên giá trị đích (lớn nhất) và khoá lại.
     * Sau khi gọi, setData() sẽ KHÔNG thay đổi contentSize hay scale nữa → tránh layout nhảy.
     * Gọi unlockWidth() để trở về chế độ dynamic sau khi count-up xong.
     */
    lockWidth(finalValue: number, currencyIndex: number = -1, minDecimals: number = 0): void {
        minDecimals = this._resolveCurrencyMinDecimals(minDecimals, currencyIndex);
        const sizeResult = this._computeSize(finalValue, currencyIndex, minDecimals);
        const { totalWidth, maxHeight, sumSpriteWidth, sumVisualGaps } = sizeResult;
        this._lockedWidth  = totalWidth;
        this._lockedHeight = maxHeight;

        const parentTf = this.node.getComponent(UITransform);

        if (this.shrinkToFit) {
            // Shrink scale áp lên digit children trong setData(), không scale parent
            // (scale parent sẽ co cả contentSize → không bao giờ vừa khung).
            this._effectiveScale = this._computeShrinkScaleRatio(sumSpriteWidth, sumVisualGaps, maxHeight);
            this.node.setScale(this._initialScale, this._initialScale, 1);
        } else {
            // Áp dụng ngay để container đúng size trước khi count-up bắt đầu
            if (parentTf) parentTf.setContentSize(totalWidth, maxHeight);
            const effectiveMaxWidth = this.maxWidth > 0
                ? this.maxWidth
                : (parentTf && parentTf.contentSize.width > 0 ? parentTf.contentSize.width : 0);
            if (effectiveMaxWidth > 0 && totalWidth > effectiveMaxWidth) {
                // Apply maxWidth scaling ON TOP OF initial scale
                const maxWidthScale = effectiveMaxWidth / totalWidth;
                const finalScale = this._initialScale * maxWidthScale;
                this._effectiveScale = finalScale;
                this.node.setScale(finalScale, finalScale, 1);
            } else {
                // Không cần maxWidth scaling — giữ initial scale, không ghi đè
                this._effectiveScale = this._initialScale;
                this.node.setScale(this._initialScale, this._initialScale, 1);
            }
        }
    }

    /** Huỷ khoá width — setData() trở về chế độ tính lại động mỗi frame. */
    unlockWidth(): void {
        this._lockedWidth  = 0;
        this._lockedHeight = 0;
    }

    /** Bắt đầu chế độ count-up: số nguyên sẽ hiển thị .00 trong khi đang chạy. */
    beginCountUp(): void {
        this._isCounting = true;
        this._hasSeenNonZeroDecimal = false;
        if (this.enableCountSound) {
            Log.d(`[coinloop][SpriteNumber.beginCountUp] node=${this.node?.name} → playCoinLoop()`);
            SoundManager.instance?.playCoinLoop();
        }
    }

    /** Kết thúc chế độ count-up: số nguyên trở về hiển thị không có phần thập phân. */
    endCountUp(): void {
        this._isCounting = false;
        this._hasSeenNonZeroDecimal = false;
        // Dừng jolt đang chạy — tránh số tiếp tục nhún sau khi đã tới đích
        this._stopJolt();
        if (this.enableCountSound) {
            Log.d(`[coinloop][SpriteNumber.endCountUp] node=${this.node?.name} → stopCoinLoop + playCoinEnd`);
            SoundManager.instance?.stopCoinLoop();
            SoundManager.instance?.playCoinEnd();
        } else {
            Log.d(`[coinloop][SpriteNumber.endCountUp] node=${this.node?.name} — enableCountSound=false, skipped`);
        }
    }

    /**
     * Cập nhật số hiển thị.
     *
     * @param value         Số cần hiển thị. Hỗ trợ integer và float (tối đa 2 chữ số thập phân).
     *                      Số nguyên: không hiển thị phần thập phân.
     *                      Ví dụ: 1234567 → "1,234,567" | 9.5 → "9.50"
     * @param currencyIndex Index trong mảng currencySprites để hiển thị ký hiệu tiền tệ.
     *                      Truyền -1 (mặc định) để bỏ qua ký hiệu tiền tệ.
     */
    /**
     * Được gọi khi LANGUAGE_CHANGED event được emit.
     * Gọi lại setData() với params cũ — setData() sẽ tự tra ngôn ngữ hiện tại.
     */
    private _onLanguageChanged(): void {
        if (!this._hasData || this._lastCurrencyIndex < 0) return;
        this.setData(this._lastValue, this._lastCurrencyIndex, this._lastMinDecimals, this._lastUseKMBT);
    }

    /**
     * Khi hiển thị tiền tệ: mặc định 3 chữ thập phân (.000).
     * Caller truyền minDecimals > 0 thì giữ nguyên (vd. CreditLabel sticky = 2 → .00).
     */
    private _resolveCurrencyMinDecimals(minDecimals: number, currencyIndex: number): number {
        if (!this.enableLangCurrency || currencyIndex < 0) return minDecimals;
        return minDecimals > 0 ? minDecimals : 3;
    }

    /**
     * Tạo hoặc lấy Label node để hiển thị KMBT text khi value >= 100K.
     */
    private _kmbtLabelNode: Node | null = null;
    private _kmbtLabel: Label | null = null;

    private _ensureKMBTLabel(): void {
        if (this._kmbtLabelNode) return;
        const node = new Node('KMBTLabel');
        const label = node.addComponent(Label);
        const digitH = this.numberSprites[0]?.originalSize.height ?? 40;
        label.fontSize = Math.round(digitH * 0.9);
        label.color = Color.WHITE;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.CLAMP;
        node.setPosition(0, 0, 0);
        this.node.addChild(node);
        this._kmbtLabelNode = node;
        this._kmbtLabel = label;
    }

    setData(value: number, currencyIndex: number = -1, minDecimals: number = 0, useKMBT: boolean = false): void {
        // Lưu params gốc để re-render khi đổi ngôn ngữ
        this._lastValue         = value;
        this._lastCurrencyIndex = currencyIndex;
        this._lastMinDecimals   = minDecimals;
        this._lastUseKMBT       = useKMBT;
        this._hasData           = true;

        // Lazy snapshot: nếu onLoad() chưa chạy, thử capture container dims ngay
        if (this.shrinkToFit && this._shrinkContainerW === 0 && this._shrinkContainerH === 0) {
            this._snapshotContainerDims();
        }

        minDecimals = this._resolveCurrencyMinDecimals(minDecimals, currencyIndex);

        // Khi enableLangCurrency=true và caller muốn hiển thị tiền tệ (>= 0),
        // ƯU TIÊN: dùng currency code từ server (nếu có) để chọn sprite đúng.
        // FALLBACK: dùng ngôn ngữ UI hiện tại.
        if (this.enableLangCurrency && currencyIndex >= 0) {
            const code = LocalizationManager.instance.currencyCode;
            if (code && SpriteNumber.CURRENCY_CODE_TO_SPRITE_INDEX[code] !== undefined) {
                const codeIdx = SpriteNumber.CURRENCY_CODE_TO_SPRITE_INDEX[code];
                if (codeIdx < this.currencySprites.length) {
                    currencyIndex = codeIdx;
                }
            } else {
                const lang    = LocalizationManager.instance.currentLanguage;
                const langIdx = SpriteNumber.LANG_ORDER.indexOf(lang);
                if (langIdx >= 0 && langIdx < this.currencySprites.length) {
                    currencyIndex = langIdx;
                }
            }
        }

        // KMBT fallback: khi số >= 100K và bật flag → dùng Label hiển thị K/M/B/T
        const useKMBTMode = useKMBT && value >= 100000;
        if (useKMBTMode && this.kmbtSprites.length === 0) {
            // Không có KMBT sprite: fallback dùng Label
            this._recycleAll();
            this._ensureKMBTLabel();
            if (this._kmbtLabel) {
                this._kmbtLabel.string = formatKMBT(value);
                this._kmbtLabelNode!.active = true;
            }
            if (this.joltEnabled && value !== this._prevRenderedValue) {
                const now = Date.now();
                const interval = this._getRandomJoltInterval();
                if (now - this._lastJoltTime >= interval * 1000) {
                    this._lastJoltTime = now;
                    this.playJolt(this.node.scale.clone());
                }
            }
            this._prevRenderedValue = value;
            return;
        }

        // Ẩn KMBT label nếu không dùng (dùng sprite khi có kmbtSprites)
        if (this._kmbtLabelNode) {
            this._kmbtLabelNode.active = false;
        }

        this._recycleAll();

        // KMBT mode: dùng formatKMBT và bỏ qua currency
        if (useKMBTMode) {
            currencyIndex = -1;
        }

        // effectiveMaxWidth chỉ dùng cho shrinkToFit=false path (maxWidth feature)
        const parentTf0 = this.node.getComponent(UITransform);
        const effectiveMaxWidth = this.maxWidth > 0
            ? this.maxWidth
            : (parentTf0 && parentTf0.contentSize.width > 0 ? parentTf0.contentSize.width : 0);

        const hasCurrency = currencyIndex >= 0 && currencyIndex < this.currencySprites.length;
        const formatted   = useKMBTMode ? formatKMBT(value) : this._formatNumber(value, minDecimals);

        // ── Xây danh sách SpriteFrame theo thứ tự hiển thị ──────────────
        const frames: SpriteFrame[] = [];

        if (hasCurrency && this.currencyPosition === CurrencyPosition.START) {
            frames.push(this.currencySprites[currencyIndex]);
        }

        for (const ch of formatted) {
            if (ch >= '0' && ch <= '9') {
                const frame = this.numberSprites[+ch];
                if (frame) frames.push(frame);
            } else if (ch === '.') {
                if (this.dotSprite) frames.push(this.dotSprite);
            } else if (ch === ',') {
                if (this.commaSprite) frames.push(this.commaSprite);
            } else if (useKMBTMode && 'KMBT'.includes(ch)) {
                const frame = this._getKMBTSprite(ch);
                if (frame) frames.push(frame);
            }
        }

        if (hasCurrency && this.currencyPosition === CurrencyPosition.END) {
            frames.push(this.currencySprites[currencyIndex]);
        }

        if (frames.length === 0) return;

        // Tính chiều rộng hiệu dụng của currency sprite (đặc biệt cho zh-tw: NT$ = 3 ký tự).
        // Khi enableLangCurrency=true và ngôn ngữ hiện tại có ký hiệu nhiều ký tự,
        // thay vì dùng originalSize.width của sprite, dùng digitWidth × charCount.
        const currencyFrame = hasCurrency ? this.currencySprites[currencyIndex] : null;
        let effectiveCurrencyWidth = currencyFrame ? currencyFrame.originalSize.width : 0;
        if (this.enableLangCurrency && currencyFrame && this.numberSprites.length > 0) {
            const charCount = LocalizationManager.instance.getCurrencyCharCount();
            if (charCount > 1) {
                const digitW = this.numberSprites[0].originalSize.width;
                effectiveCurrencyWidth = digitW * charCount + this.spacing * (charCount - 1);
            }
        }

        // ── Pass 1: Tính tổng width để căn giữa ──────────────────────────
        const layoutMetrics = this._computeLayoutMetrics(frames, currencyFrame, effectiveCurrencyWidth);
        const { totalWidth, maxHeight, sumSpriteWidth, sumVisualGaps } = layoutMetrics;

        // shrinkToFit: scale từng digit child (không scale parent) để vừa contentSize.
        // Scale đồng nhất glyph + gap — giống Label Overflow.SHRINK.
        const layoutScale = this.shrinkToFit
            ? (this._lockedWidth > 0 ? this._effectiveScale : this._computeShrinkScaleRatio(sumSpriteWidth, sumVisualGaps, maxHeight))
            : 1;
        const layoutTotalWidth = totalWidth * layoutScale;

        // ── Pass 2: Spawn/reuse node, đặt vị trí thủ công ────────────────
        // shrinkToFit + scale nhỏ: bake HQ downsample thay vì scale GPU (tránh răng cưa/nhòe mip).
        const useHqDownscale = this.shrinkToFit && layoutScale > 0 && layoutScale < HQ_DOWNSCALE_THRESHOLD;

        // Bắt đầu từ -layoutTotalWidth/2 để căn giữa quanh pivot của parent node
        let cursorX = -layoutTotalWidth / 2;
        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            const isCurrencyFrame = frame === currencyFrame;
            // Chiều rộng cấp phát trong layout: zh-tw dùng effectiveCurrencyWidth (3 ký tự),
            // tất cả còn lại dùng originalSize.width của sprite.
            const allocatedW = isCurrencyFrame ? effectiveCurrencyWidth : frame.originalSize.width;
            const spriteW    = frame.originalSize.width;
            const displayAllocW = allocatedW * layoutScale;
            const displaySpriteW = spriteW * layoutScale;

            const node   = this._acquireNode();
            const sprite = node.getComponent(Sprite)!;
            const tf = node.getComponent(UITransform)!;

            if (useHqDownscale) {
                const hqFrame = this._getHqDownscaledFrame(frame, layoutScale) ?? frame;
                sprite.spriteFrame = hqFrame;
                // Hiển thị đúng size design; texture đã bake ~2x nên sắc, không cần scale node.
                tf.setContentSize(displaySpriteW, frame.originalSize.height * layoutScale);
                node.setScale(1, 1, 1);
            } else {
                sprite.spriteFrame = frame;
                // Sprite giữ kích thước gốc; shrinkToFit scale child node để vừa khung.
                tf.setContentSize(frame.originalSize);
                node.setScale(layoutScale, layoutScale, 1);
            }

            // Căn PHẢI trong không gian cấp phát (đã nhân layoutScale):
            //   right edge của sprite = cursorX + displayAllocW
            //   → center = cursorX + displayAllocW - displaySpriteW / 2
            // Với ký tự thường (allocatedW == spriteW): công thức trở thành cursorX + displaySpriteW/2.
            // Với NT$ (allocatedW = 3 digits): sprite sát phải → khoảng cách tới chữ số tiếp theo = spacing.
            node.setPosition(cursorX + displayAllocW - displaySpriteW / 2, 0, 0);

            if (i < frames.length - 1) {
                cursorX += displayAllocW + layoutMetrics.visualGap(i) * layoutScale;
            }

            this.node.addChild(node);
            this._activeNodes.push(node);
        }

        // Cập nhật kích thước UITransform của parent node
        if (this._lockedWidth > 0) {
            // Width đã khoá — chỉ cập nhật vị trí sprite, bỏ qua contentSize & scale
        } else {
            // Dùng "full size" (bao gồm .000 dù số tròn) để tính container và scale,
            // tránh trường hợp bỏ .000 làm totalWidth nhỏ hơn → scale ít hơn → tràn khung.
            const sizeRef = (this.enableLangCurrency && currencyIndex >= 0)
                ? this._computeSize(value, currencyIndex, minDecimals).totalWidth
                : totalWidth;
            const parentTf = this.node.getComponent(UITransform);
            if (this.shrinkToFit) {
                // shrinkToFit: contentSize giữ nguyên (khung Editor); scale nằm ở digit children.
                this._effectiveScale = layoutScale;
                this.node.setScale(this._initialScale, this._initialScale, 1);
            } else {
                if (parentTf) parentTf.setContentSize(sizeRef, maxHeight);
                // Scale để vừa maxWidth nếu cần — áp dụng trên cơ sở initial scale
                if (effectiveMaxWidth > 0 && sizeRef > effectiveMaxWidth) {
                    const maxWidthScale = effectiveMaxWidth / sizeRef;
                    const finalScale = this._initialScale * maxWidthScale;
                    this._effectiveScale = finalScale;
                    this.node.setScale(finalScale, finalScale, 1);
                } else {
                    // Không cần maxWidth scaling — giữ initial scale, không ghi đè
                    this._effectiveScale = this._initialScale;
                    this.node.setScale(this._initialScale, this._initialScale, 1);
                }
            }
        }

        // Kích hoạt hiệu ứng giật nếu đủ điều kiện và GIÁ TRỊ THỰC SỰ THAY ĐỔI
        // (tránh jolt khi setData cùng value — xảy ra khi bet đổi nhưng server values không đổi)
        // Capture scale SAU khi layout xong — nếu lấy trước sẽ tween về scale cũ và phá shrink/maxWidth.
        if (this.joltEnabled && value !== this._prevRenderedValue) {
            const now = Date.now();
            const interval = this._getRandomJoltInterval();
            if (now - this._lastJoltTime >= interval * 1000) {
                this._lastJoltTime = now;
                this.playJolt(this.node.scale.clone());
            }
        }
        this._prevRenderedValue = value;
    }


    /**
     * Lấy SpriteFrame cho ký tự K/M/B/T.
     */
    private _getKMBTSprite(char: string): SpriteFrame | null {
        switch (char) {
            case 'K': return this.kmbtSprites[0] ?? null;
            case 'M': return this.kmbtSprites[1] ?? null;
            case 'B': return this.kmbtSprites[2] ?? null;
            case 'T': return this.kmbtSprites[3] ?? null;
        }
        return null;
    }

    /**     * Random thời gian giật giữa joltIntervalMin và joltIntervalMax.
     */
    private _getRandomJoltInterval(): number {
        return this.joltIntervalMin + Math.random() * (this.joltIntervalMax - this.joltIntervalMin);
    }

    /**     * Phát hiệu ứng giật nhún một lần.
     * Có thể gọi thủ công từ script khác bất cứ lúc nào.
     * Hiệu ứng: phình nhanh lên đỉnh → nẩy đàn hồi về trạng thái ban đầu.
     */
    public playJolt(returnScale?: Vec3): void {
        this._stopJolt();
        const currentScale = this.node.scale.clone();
        const restoreScale = returnScale ? returnScale.clone() : currentScale;
        const peak = currentScale.x * this.joltScale;
        const rise = this.joltDuration * 0.35;
        const fall = this.joltDuration * 0.65;
        const origPos = this.node.position.clone();
        const peakPos = new Vec3(origPos.x, origPos.y + this.joltOffsetY, origPos.z);
        this._joltRestoreScale = restoreScale.clone();
        this._joltRestorePos = origPos.clone();
        this._joltTween = tween(this.node)
            .to(rise, { scale: new Vec3(peak, peak, 1), position: peakPos }, { easing: 'backOut' })
            .to(fall, { scale: restoreScale, position: origPos }, { easing: 'elasticOut' })
            .call(() => {
                this._joltTween = null;
                this._joltRestoreScale = null;
                this._joltRestorePos = null;
            })
            .start();
    }

    /**
     * Định dạng số thành chuỗi có dấu phân cách hàng nghìn.
     * Nhất quán với FormatUtils.formatCurrency nhưng không thêm ký hiệu tiền tệ.
     *   1234567   → "1,234,567"
     *   1234.5    → "1,234.50"
     *   0.1       → "0.10"
     */
    /**
     * @param forSizing  Khi true: không bao giờ ẩn phần thập phân (dùng để tính kích thước container).
     *                   Khi false (mặc định): ẩn .000 nếu số tròn và không đang count-up (dùng để render).
     */
    private _formatNumber(value: number, minDecimals: number = 0, forSizing: boolean = false): string {
        const isInteger = Number.isInteger(value) || Math.abs(value - Math.round(value)) < 0.0005;
        // Khi đang count-up: số nguyên không hiển thị phần thập phân (sẽ bị ẩn bởi shouldHide)
        if (isInteger && minDecimals <= 0 && !this._isCounting && !forSizing) {
            return Math.floor(value).toLocaleString('en-US');
        }
        const decimals = Math.max(minDecimals, isInteger ? (this._isCounting ? 1 : 0) : 2);
        const fixed = value.toFixed(decimals);
        const [intPart, decPart] = fixed.split('.');
        const formattedInt = parseInt(intPart, 10).toLocaleString('en-US');
        if (decPart) {
            const isZeroDecimal = /^0+$/.test(decPart);
            if (!isZeroDecimal) {
                // Ghi nhận có phần lẻ khác 0 trong session count-up này
                if (this._isCounting) this._hasSeenNonZeroDecimal = true;
            }
            // Ẩn phần thập phân khi render (không phải sizing):
            //   - Đang count-up và chưa từng thấy phần lẻ khác 0 và hiện tại cũng là 0
            //   - Không đang count-up và phần lẻ toàn 0 (số tròn → bỏ .000)
            const shouldHide = !forSizing && isZeroDecimal && minDecimals <= 0 && (this._isCounting ? !this._hasSeenNonZeroDecimal : true);
            if (shouldHide) return formattedInt;
            // Khi render (không phải sizing): cắt bỏ số 0 thừa ở cuối phần thập phân
            // Nhưng nếu minDecimals > 0 thì luôn giữ đủ minDecimals chữ số (không trim).
            let displayDecPart = forSizing ? decPart : decPart.replace(/0+$/, '');
            if (minDecimals > 0) {
                // Giữ đủ minDecimals, pad 0 nếu thiếu → 1.2 với minDecimals=3 → "1.200"
                if (displayDecPart.length < minDecimals) {
                    displayDecPart = displayDecPart.padEnd(minDecimals, '0');
                }
                return `${formattedInt}.${displayDecPart}`;
            }
            if (!displayDecPart) return formattedInt;
            return `${formattedInt}.${displayDecPart}`;
        }
        return formattedInt;
    }

    /**
     * Khoảng cách hiển thị (px) giữa hai SpriteFrame liền kề.
     */
    private _getPairVisualGap(
        frame: SpriteFrame,
        nextFrame: SpriteFrame,
        currencyFrame: SpriteFrame | null,
    ): number {
        const isPunct     = frame === this.dotSprite || frame === this.commaSprite;
        const isNextPunct = nextFrame === this.dotSprite || nextFrame === this.commaSprite;
        const isNextKMBT  = this.kmbtSprites.includes(nextFrame as SpriteFrame);
        const isCurr      = frame === currencyFrame;
        const isNextCurr  = nextFrame === currencyFrame;
        if (isNextKMBT) return this.kmbtSpacing;
        if (isPunct || isNextPunct) return this.spacing + this.punctuationSpacingOffset;
        if (isCurr || isNextCurr) {
            return this.currencySpacing + (currencyFrame ? currencyFrame.originalSize.width * this.currencySpacingRatio : 0);
        }
        return this.spacing;
    }

    private _computeLayoutMetrics(
        frames: SpriteFrame[],
        currencyFrame: SpriteFrame | null,
        effectiveCurrencyWidth: number,
    ): {
        sumSpriteWidth: number;
        sumVisualGaps: number;
        totalWidth: number;
        maxHeight: number;
        visualGap: (index: number) => number;
    } {
        let sumSpriteWidth = 0;
        let sumVisualGaps  = 0;
        let maxHeight      = 0;
        for (let i = 0; i < frames.length; i++) {
            const frame  = frames[i];
            const frameW = (frame === currencyFrame) ? effectiveCurrencyWidth : frame.originalSize.width;
            sumSpriteWidth += frameW;
            maxHeight = Math.max(maxHeight, frame.originalSize.height);
            if (i < frames.length - 1) {
                sumVisualGaps += this._getPairVisualGap(frame, frames[i + 1], currencyFrame);
            }
        }
        return {
            sumSpriteWidth,
            sumVisualGaps,
            totalWidth: sumSpriteWidth + sumVisualGaps,
            maxHeight,
            visualGap: (index: number) => this._getPairVisualGap(frames[index], frames[index + 1], currencyFrame),
        };
    }

    /**
     * shrinkToFit: scale digit children (đồng nhất glyph + gap) để vừa khung contentSize.
     * Không scale parent — nếu scale parent thì contentSize co theo → vẫn tràn tương đối.
     */
    private _computeShrinkScaleRatio(sumSpriteWidth: number, sumVisualGaps: number, maxHeight: number): number {
        const containerW = this.maxWidth > 0 ? this.maxWidth : this._shrinkContainerW;
        const containerH = this._shrinkContainerH;
        const totalWidth = sumSpriteWidth + sumVisualGaps;
        if (this.fillContainer) {
            // Phóng to / thu nhỏ để lấp khung — KHÔNG clamp về 1 trước.
            let scaleRatio = Number.POSITIVE_INFINITY;
            if (containerW > 0 && totalWidth > 0) {
                scaleRatio = Math.min(scaleRatio, containerW / totalWidth);
            }
            if (containerH > 0 && maxHeight > 0) {
                scaleRatio = Math.min(scaleRatio, containerH / maxHeight);
            }
            if (!Number.isFinite(scaleRatio)) scaleRatio = 1;
            return Math.max(0.01, scaleRatio);
        }

        let scaleRatio = 1;
        if (containerW > 0 && totalWidth > containerW) {
            scaleRatio = Math.min(scaleRatio, containerW / totalWidth);
        }
        if (containerH > 0 && maxHeight > containerH) {
            scaleRatio = Math.min(scaleRatio, containerH / maxHeight);
        }
        return Math.max(0.01, scaleRatio);
    }

    /**
     * Tính totalWidth và maxHeight cho một giá trị mà không render.
     * Dùng bởi lockWidth() để pre-compute kích thước container.
     */
    private _computeSize(
        value: number,
        currencyIndex: number,
        minDecimals: number,
    ): { totalWidth: number; maxHeight: number; sumSpriteWidth: number; sumVisualGaps: number } {
        const hasCurrency = currencyIndex >= 0 && currencyIndex < this.currencySprites.length;
        // forSizing=true: không ẩn .000 → size luôn tính đủ phần thập phân dù số tròn
        const formatted   = this._formatNumber(value, minDecimals, true);
        const frames: SpriteFrame[] = [];
        if (hasCurrency && this.currencyPosition === CurrencyPosition.START)
            frames.push(this.currencySprites[currencyIndex]);
        for (const ch of formatted) {
            if (ch >= '0' && ch <= '9') {
                const frame = this.numberSprites[+ch];
                if (frame) frames.push(frame);
            } else if (ch === '.') {
                if (this.dotSprite) frames.push(this.dotSprite);
            } else if (ch === ',') {
                if (this.commaSprite) frames.push(this.commaSprite);
            }
        }
        if (hasCurrency && this.currencyPosition === CurrencyPosition.END)
            frames.push(this.currencySprites[currencyIndex]);

        // Tính chiều rộng hiệu dụng của currency sprite (zh-tw: NT$ = 3 ký tự).
        const currencyFrame = hasCurrency ? this.currencySprites[currencyIndex] : null;
        let effectiveCurrencyWidth = currencyFrame ? currencyFrame.originalSize.width : 0;
        if (this.enableLangCurrency && currencyFrame && this.numberSprites.length > 0) {
            const charCount = LocalizationManager.instance.getCurrencyCharCount();
            if (charCount > 1) {
                const digitW = this.numberSprites[0].originalSize.width;
                effectiveCurrencyWidth = digitW * charCount + this.spacing * (charCount - 1);
            }
        }

        const layoutMetrics = this._computeLayoutMetrics(frames, currencyFrame, effectiveCurrencyWidth);
        return {
            totalWidth: layoutMetrics.totalWidth,
            maxHeight: layoutMetrics.maxHeight,
            sumSpriteWidth: layoutMetrics.sumSpriteWidth,
            sumVisualGaps: layoutMetrics.sumVisualGaps,
        };
    }

    /** Dừng tween giật đang chạy. */
    /** Dừng tween giật đang chạy và khôi phục scale/position nếu bị cắt giữa chừng. */
    private _stopJolt(): void {
        if (this._joltTween) {
            this._joltTween.stop();
            this._joltTween = null;
        }
        if (this._joltRestoreScale) {
            this.node.setScale(this._joltRestoreScale);
            this._joltRestoreScale = null;
        }
        if (this._joltRestorePos) {
            this.node.setPosition(this._joltRestorePos);
            this._joltRestorePos = null;
        }
    }

    /**
     * Đưa tất cả node đang hiển thị về pool — KHÔNG destroy.
     * Đây là điểm mấu chốt giúp tránh GC khi cập nhật điểm số liên tục.
     */
    private _recycleAll(): void {
        for (const node of this._activeNodes) {
            node.removeFromParent();
            this._pool.put(node);
        }
        this._activeNodes.length = 0;
    }

    /**
     * Lấy node từ pool nếu có, ngược lại tạo node mới.
     * Node mới chỉ được tạo khi pool chưa có node sẵn (thường chỉ vài lần đầu).
     */
    private _acquireNode(): Node {
        let node = this._pool.get();
        if (!node) {
            node = new Node('digit');
            // Sprite extends Renderable2D có @requireComponent(UITransform):
            // engine tự động thêm UITransform khi addComponent(Sprite) được gọi.
            // Tuyệt đối KHÔNG gọi addComponent(UITransform) thủ công — sẽ crash.
            const sprite = node.addComponent(Sprite);
            sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        }
        // NodePool.put() tự set node.active = false — phải restore trước khi dùng lại,
        // nếu không node sẽ được addChild nhưng vô hình (chỉ thấy jolt animation).
        node.active = true;
        return node;
    }

    /**
     * Bake 1 SpriteFrame đã downsample bằng canvas (imageSmoothingQuality=high).
     * Texture đích ≈ displaySize × HQ_SUPERSAMPLE — gần 1:1 với pixel màn hình, không cần mipmap.
     */
    private _getHqDownscaledFrame(src: SpriteFrame, layoutScale: number): SpriteFrame | null {
        if (typeof document === 'undefined') return null;

        const srcTex = src.texture as Texture2D | null;
        const imageAsset = srcTex?.image ?? null;
        const raw = imageAsset?.data as unknown;
        const canDraw =
            !!raw && (
                (typeof HTMLImageElement !== 'undefined' && raw instanceof HTMLImageElement) ||
                (typeof ImageBitmap !== 'undefined' && raw instanceof ImageBitmap) ||
                (typeof HTMLCanvasElement !== 'undefined' && raw instanceof HTMLCanvasElement)
            );
        if (!srcTex || !canDraw) {
            return null;
        }
        const source = raw as CanvasImageSource;

        const srcW = Math.max(1, Math.round(src.originalSize.width));
        const srcH = Math.max(1, Math.round(src.originalSize.height));
        const texScale = Math.min(1, layoutScale * HQ_SUPERSAMPLE);
        const destW = Math.max(1, Math.round(srcW * texScale));
        const destH = Math.max(1, Math.round(srcH * texScale));
        // Đã gần full-res thì dùng atlas gốc.
        if (destW >= srcW * 0.95 && destH >= srcH * 0.95) return null;

        const rect = src.rect;
        const bucket = `${destW}x${destH}`;
        const key = `${srcTex.uuid}|${rect.x},${rect.y},${rect.width},${rect.height}|r${src.rotated ? 1 : 0}|${bucket}`;
        const cached = _hqFrameCache.get(key);
        if (cached?.isValid) return cached;

        try {
            const canvas = document.createElement('canvas');
            canvas.width = destW;
            canvas.height = destH;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;

            ctx.imageSmoothingEnabled = true;
            // 'high' ≈ Lanczos-quality trên Chromium — sắc hơn GPU mipbox khi scale nhỏ.
            (ctx as CanvasRenderingContext2D & { imageSmoothingQuality?: string }).imageSmoothingQuality = 'high';
            ctx.clearRect(0, 0, destW, destH);

            if (src.rotated) {
                // Atlas rotate 90° CW trong Cocos: rect.width/height đã đổi chỗ trên texture.
                ctx.translate(destW / 2, destH / 2);
                ctx.rotate(-Math.PI / 2);
                ctx.drawImage(
                    source,
                    rect.x, rect.y, rect.width, rect.height,
                    -destH / 2, -destW / 2, destH, destW,
                );
            } else {
                ctx.drawImage(
                    source,
                    rect.x, rect.y, rect.width, rect.height,
                    0, 0, destW, destH,
                );
            }

            const bakedImage = new ImageAsset(canvas);
            const bakedTex = new Texture2D();
            bakedTex.image = bakedImage;
            bakedTex.setFilters(Texture2D.Filter.LINEAR, Texture2D.Filter.LINEAR);
            bakedTex.setMipFilter(Texture2D.Filter.NONE);
            bakedTex.setWrapMode(Texture2D.WrapMode.CLAMP_TO_EDGE, Texture2D.WrapMode.CLAMP_TO_EDGE);

            const bakedFrame = new SpriteFrame();
            bakedFrame.reset({
                texture: bakedTex,
                rect: new Rect(0, 0, destW, destH),
                originalSize: new Size(destW, destH),
                offset: new Vec2(0, 0),
                isRotate: false,
            });
            bakedFrame.packable = false;

            _hqFrameCache.set(key, bakedFrame);
            return bakedFrame;
        } catch (err) {
            Log.w(`[SpriteNumber] HQ downsample failed: ${err}`);
            return null;
        }
    }
}
