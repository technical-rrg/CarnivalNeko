/**
 * MiniSetting - Panel nhỏ chứa 3 nút tắt bật âm thanh, mở Setting, mở PayTable.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "MiniSetting" đặt trong Canvas.
 *   2. Gắn component MiniSetting vào Node đó.
 *   3. Kéo các slot bên dưới:
 *        toggleButton  → nút bấm để mở/đóng panel (btnMenu, nằm ngoài panel)
 *        panelNode     → Node con chứa 3 button (đặt active=false ban đầu)
 *        btnSetting    → mở SettingPopup
 *        btnSound      → bật/tắt toàn bộ âm thanh
 *        btnInfo       → mở PayTable (chưa làm, emit event trước)
 *        soundOnSprite  → SpriteFrame khi sound ĐANG BẬT
 *        soundOffSprite → SpriteFrame khi sound ĐÃ TẮT
 *
 * ── HIERARCHY GỢI Ý ──
 *   MiniSetting (Node + component)
 *   ├── BtnToggle    (toggleButton) — nút mở panel
 *   └── Panel        (panelNode, active=false)
 *       ├── BtnSetting  (btnSetting)
 *       ├── BtnSound    (btnSound) — có Sprite component để đổi icon
 *       └── BtnInfo     (btnInfo)
 *
 * ── LOGIC ──
 *   - Nhấn toggleButton  → panel xuất hiện / ẩn (toggle)
 *   - Nhấn bên ngoài panel → đóng panel
 *   - BtnSetting → emit SETTING_OPEN (SettingPopup lắng nghe) hoặc gọi SettingPopup.instance
 *   - BtnSound   → bật/tắt toàn bộ âm thanh (BGM + SFX), lưu localStorage, đổi icon ngay
 *   - BtnInfo    → emit PAY_TABLE_OPEN (PayTable popup lắng nghe sau)
 */

import { _decorator, Component, Node, Button, Sprite, SpriteFrame, tween, Tween, Vec3, EventTouch, UITransform, view, Widget } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { SoundManager } from '../manager/SoundManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

const LS_SOUND_MUTED = 'setting_master_muted';

@ccclass('MiniSetting')
export class MiniSetting extends Component {

    // ─── TRIGGER ───

    @property({ type: Button, tooltip: 'Nút bấm để mở / đóng MiniSetting panel' })
    toggleButton: Button | null = null;

    // ─── PANEL ───

    @property({ type: Node, tooltip: 'Node panel chứa 3 button con (active=false ban đầu)' })
    panelNode: Node | null = null;

    @property({ type: Node, tooltip: '(Tuỳ chọn) Node blocker toàn màn hình — tạo sẵn trong Editor, active=false, kéo vào đây.\nNếu bỏ trống, script sẽ tự tạo lúc runtime.' })
    blockerNode: Node | null = null;

    // ─── 3 BUTTONS ───

    @property({ type: Button, tooltip: 'Nút mở SettingPopup' })
    btnSetting: Button | null = null;

    @property({ type: Button, tooltip: 'Nút bật/tắt toàn bộ âm thanh' })
    btnSound: Button | null = null;

    @property({ type: Button, tooltip: 'Nút mở PayTable (tính năng sau)' })
    btnInfo: Button | null = null;

    // ─── SOUND ICON ───

    @property({ type: SpriteFrame, tooltip: 'Icon khi sound ĐANG BẬT' })
    soundOnSprite: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'Icon khi sound ĐÃ TẮT (muted)' })
    soundOffSprite: SpriteFrame | null = null;

    // ─── STATE ───

    private _isOpen    = false;
    private _soundMuted = false;
    private _savedPanelPos: Vec3 | null = null;
    private _selfOpening = false; // Tránh tự đóng khi vừa emit POPUP_OPENED

    // ─── LIFECYCLE ───

    onLoad(): void {
        this._loadSoundState();
        this._refreshSoundIcon();
        this._ensureBlocker();

        if (this.panelNode) {
            // Lưu vị trí gốc ngay từ lúc load (trước khi mở bất kỳ khi nào)
            this._savedPanelPos = this.panelNode.position.clone();
            this.panelNode.active = false;
        }

        if (this.toggleButton) {
            this.toggleButton.node.on('click', this._onToggle, this);
        }
        if (this.btnSetting) {
            this.btnSetting.node.on('click', this._onSettingClick, this);
        }
        if (this.btnSound) {
            this.btnSound.node.on('click', this._onSoundClick, this);
        }
        if (this.btnInfo) {
            this.btnInfo.node.on('click', this._onInfoClick, this);
        }

        // Đóng MiniSetting nếu một popup khác được mở ra
        EventBus.instance.on(GameEvents.POPUP_OPENED, this._onAnyPopupOpened, this);
        // Đóng MiniSetting khi nhấn Spin
        EventBus.instance.on(GameEvents.SPIN_REQUEST, this._onSpinRequest, this);
    }


    start(): void {
        // ★ Áp dụng master mute state ĐỢI GAME_READY hoàn thành
        // Lý do: Cho phép bgmMain phát lần đầu tiên, sau đó mới áp dụng master mute preference
        EventBus.instance.once(GameEvents.GAME_READY, () => {
            this._applySoundState();
            this._refreshSoundIcon();
        });
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ─── TOGGLE PANEL ───

    private _onToggle(): void {
        SoundManager.instance?.playButtonClick();
        if (this._isOpen) {
            this._closePanel();
        } else {
            this._openPanel();
        }
    }

    private _openPanel(): void {
        if (!this.panelNode || this._isOpen) return;
        this._isOpen = true;
        this._selfOpening = true;
        EventBus.instance.emit(GameEvents.POPUP_OPENED);
        this._selfOpening = false;

        // Blocker bật lên trước panel — chặn mọi click phía sau
        if (this.blockerNode) {
            this.blockerNode.active = true;
            this.blockerNode.setSiblingIndex(this.node.getSiblingIndex());
        }

        // Dừng tween cũ (nếu có) trước khi bắt đầu mới
        Tween.stopAllByTarget(this.panelNode);

        // Disable Widget để ngăn nó ghi đè position ở lần active đầu tiên
        // (Widget với alignOnce=true sẽ chạy và override position ta set nếu không disable)
        const widget = this.panelNode.getComponent(Widget);
        if (widget) widget.enabled = false;

        // Set scale và restore position trước khi active — tránh dịch chuyển vị trí
       // this.panelNode.active = false;
       // this.panelNode.setScale(new Vec3(0.1, 0.1, 1));
       // if (this._savedPanelPos) {
       //     this.panelNode.setPosition(this._savedPanelPos);
       // }
        this.panelNode.active = true;

        // tween(this.panelNode)
        //     .to(0.2, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'backOut' })
        //     .to(0.08, { scale: new Vec3(1, 1, 1) },       { easing: 'sineOut' })
        //     .start();
    }

    private _closePanel(): void {
        if (!this.panelNode || !this._isOpen) return;
        this._isOpen = false;
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);

        if (this.blockerNode) this.blockerNode.active = false;

        // tween(this.panelNode)
        //     .to(0.12, { scale: new Vec3(0.01, 0.01, 1) }, { easing: 'sineIn' })
        //     .call(() => {
        //         if (this.panelNode) {
        //             this.panelNode.active = false;
        //             // Restore vị trí gốc ngay sau khi đóng — chuẩn bị cho lần mở kế tiếp
        //             if (this._savedPanelPos) {
        //                 this.panelNode.setPosition(this._savedPanelPos);
        //             }
        //         }
        //     })
        //     .start();

             this.panelNode.active = false;

    }

    /** Đóng panel khi một popup khác được mở ra (tránh tự đóng chính mình) */
    private _onAnyPopupOpened(): void {
        if (this._selfOpening) return;
        this._closePanel();
    }

    /** Đóng panel khi nhấn Spin */
    private _onSpinRequest(): void {
        this._closePanel();
    }

    // ─── BLOCKER ───

    /**
     * Tạo hoặc xác nhận blockerNode — node trong suốt toàn màn hình.
     * Đặt trước panelNode trong hierarchy để chặn touch phía sau.
     * Nếu editor đã kéo sẵn blockerNode vào slot thì dùng cái đó.
     */
    private _ensureBlocker(): void {
        if (!this.blockerNode) {
            // Tự tạo nếu chưa có
            const blocker = new Node('_MiniSettingBlocker');
            const transform = blocker.addComponent(UITransform);
            const size = view.getVisibleSize();
            transform.setContentSize(size.width * 2, size.height * 2);
            // Thêm vào cùng parent với node hiện tại (Canvas)
            const parent = this.node.parent;
            if (parent) {
                parent.addChild(blocker);
                // Đặt thứ tự ngay dưới node MiniSetting
                blocker.setSiblingIndex(this.node.getSiblingIndex());
            }
            blocker.active = false;
            this.blockerNode = blocker;
        }

        // Resize khi màn hình thay đổi
        this.blockerNode.on(Node.EventType.TOUCH_START, this._onBlockerTouch, this);
    }

    /** Touch vào blocker (vùng ngoài panel) → đóng panel, nuốt event */
    private _onBlockerTouch(event: EventTouch): void {
        event.propagationStopped = true; // Không cho event lan lên canvas
        this._closePanel();
    }

    // ─── BTN SETTING ───

    private _onSettingClick(): void {
      //  SoundManager.instance?.playButtonClick();
        this._closePanel();

        // Mở SettingPopup qua EventBus → PopupLoader sẽ lazy-instantiate và gọi open()
        EventBus.instance.emit(GameEvents.GAME_SETTING_OPEN);
        Log.d('[MiniSetting] Mở SettingPopup (emit GAME_SETTING_OPEN)');
    }

    // ─── BTN SOUND ───

    private _onSoundClick(): void {
        SoundManager.instance?.playButtonClick();
        this._soundMuted = !this._soundMuted;
        this._applySoundState();
        this._refreshSoundIcon();
        this._saveSoundState();
        Log.d(`[MiniSetting] Sound → ${this._soundMuted ? 'TẮT' : 'BẬT'}`);
        
    }

    private _applySoundState(): void {
        const sm = SoundManager.instance;
        if (!sm) return;
        // Only set master mute — do NOT touch individual music/sfx mutes
        sm.setMasterMuted(this._soundMuted);
        // Sync volume slider in GameSettingPopUp (0 khi mute, restore khi unmute)
        EventBus.instance.emit(GameEvents.MASTER_MUTE_CHANGED, this._soundMuted);
    }

    private _refreshSoundIcon(): void {
        if (!this.btnSound) return;
        const sprite = this.btnSound.node.getComponentInChildren(Sprite);
        if (!sprite) return;
        const frame = this._soundMuted ? this.soundOffSprite : this.soundOnSprite;
        if (frame) sprite.spriteFrame = frame;
    }

    // ─── BTN INFO ───

    private _onInfoClick(): void {
       // SoundManager.instance?.playButtonClick();
        this._closePanel();
        EventBus.instance.emit(GameEvents.PAY_TABLE_OPEN);
        Log.d('[MiniSetting] Mở PayTable (emit PAY_TABLE_OPEN)');
    }

    // ─── PERSIST ───

    private _saveSoundState(): void {
        try {
            // Only save master mute state — do NOT touch setting_music_muted / setting_sfx_muted
            localStorage.setItem(LS_SOUND_MUTED, String(this._soundMuted));
        } catch (_) { }
    }

    private _loadSoundState(): void {
        try {
            // Only load master mute state — do NOT interfere with SettingPopup settings
            const saved = localStorage.getItem(LS_SOUND_MUTED);
            if (saved !== null) this._soundMuted = saved === 'true';
        } catch (_) { }
    }

    // ─── PUBLIC: cho phép gọi từ bên ngoài nếu cần ───
    public openPanel(): void  { this._openPanel(); }
    public closePanel(): void { this._closePanel(); }
}
