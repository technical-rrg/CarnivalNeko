/**
 * SettingPopup - Popup cài đặt âm thanh, intro screen và broadcast.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "SettingPopup" con của Canvas, đặt trên cùng Hierarchy.
 *   2. Gắn component SettingPopup vào Node đó.
 *   3. Kéo popupNode vào slot (đặt active=false ban đầu).
 *   4. Gắn nút btnSetting ở UI chính → kéo vào slot openButton.
 *   5. Kéo các Node/Button/Slider/Label vào đúng slot bên dưới.
 *
 * ── CẤU TRÚC POPUP (gợi ý hierarchy) ──
 *   SettingPopup (Node + component)
 *   └── PopupRoot (popupNode, active=false)
 *       ├── Background (màu tối / panel bg)
 *       ├── Title (Label: titleLabel)
 *       ├── BtnClose (Button: closeButton)
 *       │
 *       ├── VolumSection
 *       │   ├── Label "MASTER VOLUME" (volumeLabel)
 *       │   └── Slider → volumeSlider  (minValue=0, maxValue=1)
 *       │
 *       ├── MusicSection
 *       │   ├── Label "MUSIC" (musicLabel)
 *       │   ├── BtnMusicOn  → musicOnButton   (hiện khi ĐANG BẬT)
 *       │   └── BtnMusicOff → musicOffButton  (hiện khi ĐÃ TẮT)
 *       │
 *       ├── SoundSection
 *       │   ├── Label "SOUND" (soundLabel)
 *       │   ├── BtnSoundOn  → soundOnButton
 *       │   └── BtnSoundOff → soundOffButton
 *       │
 *       ├── IntroSection
 *       │   ├── Label "INTRO SCREEN" (introLabel)
 *       │   ├── BtnIntroOn  → introOnButton
 *       │   └── BtnIntroOff → introOffButton
 *       │
 *       └── BroadcastSection
 *           ├── Label "BROADCAST" (broadcastLabel)
 *           ├── BtnBroadcastOn  → broadcastOnButton
 *           └── BtnBroadcastOff → broadcastOffButton
 *
 * ── LƯU Ý ──
 *   - BtnXxxOn  = nút hiển thị khi tính năng đang BẬT  (click → TẮT)
 *   - BtnXxxOff = nút hiển thị khi tính năng đang TẮT  (click → BẬT)
 *   - Mỗi cặp toggle chỉ hiện 1 trong 2 nút tại 1 thời điểm.
 *   - Settings được lưu vào localStorage để giữ giữa các phiên.
 *   - Localization keys: setting_title, setting_volume, setting_music, setting_sound, setting_intro, setting_broadcast
 */

import { _decorator, Component, Node, Button, Slider, Label, tween, Vec3, BlockInputEvents, UITransform } from 'cc';
import { SoundManager } from '../manager/SoundManager';
import { AutoSpinManager } from '../manager/AutoSpinManager';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { Log } from '../core/Logger';
import { NetworkManager } from '../manager/NetworkManager';

const { ccclass, property } = _decorator;

// ─── LocalStorage keys ───
const LS_VOLUME       = 'setting_volume';
const LS_MUSIC_MUTED  = 'setting_music_muted';
const LS_SFX_MUTED    = 'setting_sfx_muted';
const LS_MASTER_MUTED = 'setting_master_muted';
const LS_INTRO_ON     = 'setting_intro_on';
const LS_BROADCAST_ON = 'setting_broadcast_on';

@ccclass('SettingPopup')
export class SettingPopup extends Component {

    // ─── SINGLETON ───
    private static _instance: SettingPopup | null = null;
    static get instance(): SettingPopup | null { return SettingPopup._instance; }

    // ─── TRIGGER ───

    @property({ type: Button, tooltip: 'Nút mở Setting popup (btnSetting trong UI chính)' })
    openButton: Button | null = null;

    // ─── POPUP ROOT ───

    @property({ type: Node, tooltip: 'Node bọc toàn bộ popup (đặt active=false ban đầu)' })
    popupNode: Node | null = null;

    @property({ type: Button, tooltip: 'Nút đóng popup (X)' })
    closeButton: Button | null = null;

    @property({ type: Node, tooltip: 'Node overlay phủ nền (active/inactive ngay cùng popupNode, không animation)' })
    fillOverlay: Node | null = null;

    // ─── LABELS (cho localization) ───

    @property({ type: Label, tooltip: 'Label tiêu đề "SETTINGS"' })
    titleLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label "MASTER VOLUME"' })
    volumeLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label "MUSIC"' })
    musicLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label "SOUND"' })
    soundLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label "INTRO SCREEN"' })
    introLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label "BROADCAST"' })
    broadcastLabel: Label | null = null;

    // ─── VOLUME ───

    @property({ type: Slider, tooltip: 'Thanh kéo Master Volume (0–1)' })
    volumeSlider: Slider | null = null;

    /**
     * Node sprite màu SÁNG bên trái Handle của volume slider.
     * Anchor phải là (0, 0.5), căn sát mép trái track.
     * Width được cập nhật theo progress để thể hiện phần đã fill.
     */
    @property({ type: Node, tooltip: 'Sprite fill sáng bên trái Handle volume — anchor (0,0.5), cùng chiều cao track' })
    volumeFill: Node | null = null;

    // ─── MUSIC on/off ───

    @property({ type: Button, tooltip: 'Nút "Music ON"  — hiện khi nhạc đang bật, click để TẮT' })
    musicOnButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút "Music OFF" — hiện khi nhạc đã tắt, click để BẬT' })
    musicOffButton: Button | null = null;

    // ─── SOUND on/off ───

    @property({ type: Button, tooltip: 'Nút "Sound ON"  — hiện khi sound đang bật, click để TẮT' })
    soundOnButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút "Sound OFF" — hiện khi sound đã tắt, click để BẬT' })
    soundOffButton: Button | null = null;

    // ─── INTRO SCREEN on/off ───

    @property({ type: Button, tooltip: 'Nút "Intro ON"  — hiện khi intro đang bật, click để TẮT' })
    introOnButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút "Intro OFF" — hiện khi intro đã tắt, click để BẬT' })
    introOffButton: Button | null = null;

    // ─── BROADCAST on/off (UI chỉ, chức năng sau) ───

    @property({ type: Button, tooltip: 'Nút "Broadcast ON"  — hiện khi broadcast đang bật, click để TẮT' })
    broadcastOnButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút "Broadcast OFF" — hiện khi broadcast đã tắt, click để BẬT' })
    broadcastOffButton: Button | null = null;

    // ─── INTERNAL STATE ───

    private _isOpen        = false;
    private _isFreeSpinMode = false;
    private _isAutoSpinActive = false;
    private _musicMuted    = false;
    private _sfxMuted      = false;
    private _masterMuted   = false;
    private _introEnabled  = true;
    private _broadcastOn   = true;
    /** Volume thực (persist) — không bị ghi đè khi mute từ MiniSetting */
    private _volume        = 1.0;

    // ─── LIFECYCLE ───

    onLoad(): void {
        SettingPopup._instance = this;
        this._loadSettings();
        this._setLabels();

        if (this.popupNode) this.popupNode.active = false;
        if (this.fillOverlay) {
            this.fillOverlay.active = false;
            this.fillOverlay.on(Node.EventType.TOUCH_END, this._close, this);
        }
        // Chặn touch xuyên qua xuống các node bên dưới khi popup đang hiển thị
        if (!this.node.getComponent(BlockInputEvents)) {
            this.node.addComponent(BlockInputEvents);
        }

        // Nút mở (openButton — không còn bắt buộc, popup được mở qua event GAME_SETTING_OPEN)
        if (this.openButton) {
            this.openButton.node.on('click', this._open, this);
        }

        // Lắng nghe event mở popup từ MiniSetting / bất kỳ nơi nào
        EventBus.instance.on(GameEvents.GAME_SETTING_OPEN, this._open, this);
        // MiniSetting mute → Volume slider về 0 / restore giá trị cũ
        EventBus.instance.on(GameEvents.MASTER_MUTE_CHANGED, this._onMasterMuteChanged, this);

        // Nút đóng
        if (this.closeButton) {
            this.closeButton.node.on('click', this._close, this);
        }

        // Volume slider
        if (this.volumeSlider) {
            this.volumeSlider.progress = this._getDisplayVolume();
            this.volumeSlider.node.on('slide', this._onVolumeSlide, this);
        }

        // Music
        if (this.musicOnButton)  this.musicOnButton.node.on('click',  this._onMusicOff,  this);
        if (this.musicOffButton) this.musicOffButton.node.on('click', this._onMusicOn,   this);

        // Sound
        if (this.soundOnButton)  this.soundOnButton.node.on('click',  this._onSoundOff,  this);
        if (this.soundOffButton) this.soundOffButton.node.on('click', this._onSoundOn,   this);

        // Intro
        if (this.introOnButton)  this.introOnButton.node.on('click',  this._onIntroOff,  this);
        if (this.introOffButton) this.introOffButton.node.on('click', this._onIntroOn,   this);

        // Broadcast (UI only)
        if (this.broadcastOnButton)  this.broadcastOnButton.node.on('click',  this._onBroadcastOff, this);
        if (this.broadcastOffButton) this.broadcastOffButton.node.on('click', this._onBroadcastOn,  this);

        // Áp dụng settings lên SoundManager (chờ đến sau khi SoundManager khởi xong)
        EventBus.instance.on(GameEvents.GAME_READY, this._applyToSoundManager, this);
        EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, this._setLabels, this);

        // Early attempt to apply settings if SoundManager is already ready (before GAME_READY)
        this.scheduleOnce(() => {
            if (SoundManager.instance) {
                this._applyToSoundManager();
                Log.d('[SettingPopup] ✓ Early settings applied before GAME_READY');
            }
        }, 0.1);

        // Lock openButton khi đang quay hoặc trong free spin
        EventBus.instance.on(GameEvents.UI_SPIN_BUTTON_STATE, this._onSpinButtonState, this);
        EventBus.instance.on(GameEvents.FREE_SPIN_START, this._onFreeSpinStart, this);
        EventBus.instance.on(GameEvents.FREE_SPIN_END, this._onFreeSpinEnd, this);
        EventBus.instance.on(GameEvents.AUTO_SPIN_CHANGED, this._onAutoSpinChanged, this);
    }

    onDestroy(): void {
        if (SettingPopup._instance === this) SettingPopup._instance = null;
        EventBus.instance.offTarget(this);
    }

    // ─── SPIN LOCK ───

    private _onSpinButtonState(enabled: boolean): void {
        if (this.openButton) this.openButton.interactable = enabled && !this._isFreeSpinMode && !this._isAutoSpinActive;
    }

    private _onFreeSpinStart(): void {
        this._isFreeSpinMode = true;
        if (this.openButton) this.openButton.interactable = false;
    }

    private _onFreeSpinEnd(): void {
        this._isFreeSpinMode = false;
        if (this.openButton) this.openButton.interactable = !this._isAutoSpinActive;
    }

    private _onAutoSpinChanged(count: number): void {
        this._isAutoSpinActive = AutoSpinManager.instance.isAutoSpinActive;
        if (this.openButton) this.openButton.interactable = !this._isAutoSpinActive && !this._isFreeSpinMode;
    }

    // ─── OPEN / CLOSE ───

    public open(): void { this._open(); }

    private _open(): void {
        if (this._isOpen || !this.popupNode) return;
        this._isOpen = true;
        EventBus.instance.emit(GameEvents.POPUP_OPENED);
        SoundManager.instance?.playButtonClick();

        this._refreshUI();

        if (this.fillOverlay) this.fillOverlay.active = true;
        this.popupNode.active = true;
        this.popupNode.setScale(new Vec3(0.1, 0.1, 1));
        tween(this.popupNode)
            .to(0.25, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'backOut' })
            .to(0.10, { scale: new Vec3(1, 1, 1) },        { easing: 'sineOut' })
            .start();

        Log.d('[SettingPopup] Mở Setting popup');
    }

    private _close(): void {
        if (!this._isOpen || !this.popupNode) return;
        this._isOpen = false;
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);
        SoundManager.instance?.playButtonClick();

        tween(this.popupNode)
            .to(0.12, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'sineOut' })
            .to(0.15, { scale: new Vec3(0.01, 0.01, 1) }, { easing: 'sineIn'  })
            .call(() => {
                if (this.popupNode) this.popupNode.active = false;
                if (this.fillOverlay) this.fillOverlay.active = false;
            })
            .start();

        Log.d('[SettingPopup] Đóng Setting popup');
    }

    // ─── VOLUME ───

    /** Volume hiển thị trên slider: 0 khi master mute, ngược lại là volume đã lưu */
    private _getDisplayVolume(): number {
        return this._masterMuted ? 0 : this._volume;
    }

    /** MiniSetting bật/tắt mute → cập nhật Volume slider (không ghi đè volume đã lưu) */
    private _onMasterMuteChanged(muted: boolean): void {
        this._masterMuted = muted;
        const display = this._getDisplayVolume();
        if (this.volumeSlider) this.volumeSlider.progress = display;
        this._updateVolumeFill(display);
        Log.d(`[SettingPopup] Master mute → ${muted ? 'ON (volume UI=0)' : `OFF (volume UI=${(this._volume * 100).toFixed(0)}%)`}`);
    }

    private _onVolumeSlide(slider: Slider): void {
        this._volume = slider.progress;
        SoundManager.instance?.setMasterVolume(this._volume);
        this._updateVolumeFill(this._volume);
        this._saveSettings();
        Log.d(`[SettingPopup] Volume → ${(this._volume * 100).toFixed(0)}%`);
    }

    /**
     * Cập nhật width của volumeFill theo progress (0→1).
     * volumeFill phải có anchor (0, 0.5) và cùng parent/vị trí với track.
     */
    private _updateVolumeFill(progress: number): void {
        if (!this.volumeFill || !this.volumeSlider) return;
        const trackTransform = this.volumeSlider.node.getComponent(UITransform);
        const fillTransform  = this.volumeFill.getComponent(UITransform);
        if (!trackTransform || !fillTransform) return;
        const totalWidth = trackTransform.contentSize.width;
        fillTransform.setContentSize(totalWidth * progress, fillTransform.contentSize.height);
    }

    // ─── MUSIC ───

    private _onMusicOn(): void {
        this._musicMuted = false;
        SoundManager.instance?.setBGMMuted(false);
        this._refreshMusicUI();
        this._saveSettings();
        Log.d('[SettingPopup] Music → BẬT');
    }

    private _onMusicOff(): void {
        this._musicMuted = true;
        SoundManager.instance?.setBGMMuted(true);
        this._refreshMusicUI();
        this._saveSettings();
        Log.d('[SettingPopup] Music → TẮT');
    }

    // ─── SOUND ───

    private _onSoundOn(): void {
        this._sfxMuted = false;
        SoundManager.instance?.setSFXMuted(false);
        this._refreshSoundUI();
        this._saveSettings();
        Log.d('[SettingPopup] Sound → BẬT');
    }

    private _onSoundOff(): void {
        this._sfxMuted = true;
        SoundManager.instance?.setSFXMuted(true);
        this._refreshSoundUI();
        this._saveSettings();
        Log.d('[SettingPopup] Sound → TẮT');
    }

    // ─── INTRO SCREEN ───

    private _onIntroOn(): void {
        this._introEnabled = true;
        this._refreshIntroUI();
        this._saveSettings();
        Log.d('[SettingPopup] Intro Screen → BẬT');
    }

    private _onIntroOff(): void {
        this._introEnabled = false;
        this._refreshIntroUI();
        this._saveSettings();
        Log.d('[SettingPopup] Intro Screen → TẮT');
    }

    // ─── BROADCAST ───

    private _onBroadcastOn(): void {
        this._broadcastOn = true;
        this._refreshBroadcastUI();
        this._saveSettings();
        EventBus.instance.emit(GameEvents.BROADCAST_SETTING_CHANGED, true);
        NetworkManager.instance.sendBroadcastOptionChange(true).catch((err) => {
            Log.w('[SettingPopup] Broadcast ON server sync failed:', err);
        });
        Log.d('[SettingPopup] Broadcast → BẬT');
    }

    private _onBroadcastOff(): void {
        this._broadcastOn = false;
        this._refreshBroadcastUI();
        this._saveSettings();
        EventBus.instance.emit(GameEvents.BROADCAST_SETTING_CHANGED, false);
        NetworkManager.instance.sendBroadcastOptionChange(false).catch((err) => {
            Log.w('[SettingPopup] Broadcast OFF server sync failed:', err);
        });
        Log.d('[SettingPopup] Broadcast → TẮT');
    }

    // ─── APPLY TO SOUND MANAGER (sau khi GAME_READY) ───

    private _applyToSoundManager(): void {
        const sm = SoundManager.instance;
        if (!sm) {
            Log.w('[SettingPopup] ⚠️ SoundManager instance not available yet, retrying in 0.2s');
            this.scheduleOnce(() => this._applyToSoundManager(), 0.2);
            return;
        }
        sm.setMasterVolume(this._volume);
        sm.setBGMMuted(this._musicMuted);
        sm.setSFXMuted(this._sfxMuted);
        if (this.volumeSlider) this.volumeSlider.progress = this._getDisplayVolume();
        this._updateVolumeFill(this._getDisplayVolume());
        // Refresh UI buttons to reflect loaded settings
        this._refreshUI();
        Log.d(`[SettingPopup] ✓ Applied settings to SoundManager → volume=${(this._volume * 100).toFixed(0)}%, music=${this._musicMuted ? 'OFF' : 'ON'}, sfx=${this._sfxMuted ? 'OFF' : 'ON'}`); 
    }

    // ─── INTRO SCREEN: GuideController lắng nghe getter này ───

    /**
     * Trả về setting của Intro Screen.
     * GuideController (hoặc GameManager) có thể gọi:
     *   SettingPopup.introEnabled → nếu false, skip guide.
     */
    get introEnabled(): boolean { return this._introEnabled; }
    get broadcastEnabled(): boolean { return this._broadcastOn; }

    /** Đồng bộ trạng thái sound từ MiniSetting (cập nhật UI trong popup nếu đang mở) */
    public syncSoundState(muted: boolean): void {
        this._onMasterMuteChanged(muted);
    }

    // ─── UI REFRESH ───

    private _refreshUI(): void {
        const display = this._getDisplayVolume();
        if (this.volumeSlider) this.volumeSlider.progress = display;
        this._updateVolumeFill(display);
        this._refreshMusicUI();
        this._refreshSoundUI();
        this._refreshIntroUI();
        this._refreshBroadcastUI();
    }

    private _refreshMusicUI(): void {
        // musicMuted=true → nhạc TẮT → hiện nút OFF (để click BẬT lại), ẩn nút ON
        if (this.musicOnButton)  this.musicOnButton.node.active  = !this._musicMuted;
        if (this.musicOffButton) this.musicOffButton.node.active =  this._musicMuted;
    }

    private _refreshSoundUI(): void {
        if (this.soundOnButton)  this.soundOnButton.node.active  = !this._sfxMuted;
        if (this.soundOffButton) this.soundOffButton.node.active =  this._sfxMuted;
    }

    private _refreshIntroUI(): void {
        if (this.introOnButton)  this.introOnButton.node.active  =  this._introEnabled;
        if (this.introOffButton) this.introOffButton.node.active = !this._introEnabled;
    }

    private _refreshBroadcastUI(): void {
        if (this.broadcastOnButton)  this.broadcastOnButton.node.active  =  this._broadcastOn;
        if (this.broadcastOffButton) this.broadcastOffButton.node.active = !this._broadcastOn;
    }

    // ─── PERSIST ───

    private _setLabels(): void {
        // Gán localization keys cho các label — thêm các key này vào LocalizationManager
        // if (this.titleLabel)     this.titleLabel.string     = L('setting_title');
        // if (this.volumeLabel)    this.volumeLabel.string    = L('setting_volume');
        // if (this.musicLabel)     this.musicLabel.string     = L('setting_music');
        // if (this.soundLabel)     this.soundLabel.string     = L('setting_sound');
        // if (this.introLabel)     this.introLabel.string     = L('setting_intro');
        // if (this.broadcastLabel) this.broadcastLabel.string = L('setting_broadcast');
    }

    private _saveSettings(): void {
        try {
            localStorage.setItem(LS_VOLUME,       String(this._volume));
            localStorage.setItem(LS_MUSIC_MUTED,  String(this._musicMuted));
            localStorage.setItem(LS_SFX_MUTED,    String(this._sfxMuted));
            localStorage.setItem(LS_INTRO_ON,     String(this._introEnabled));
            localStorage.setItem(LS_BROADCAST_ON, String(this._broadcastOn));
        } catch (_) { /* localStorage không khả dụng trong một số môi trường */ }
    }

    private _loadSettings(): void {
        try {
            const vol = localStorage.getItem(LS_VOLUME);
            if (vol !== null) this._volume = parseFloat(vol);

            const musicMuted = localStorage.getItem(LS_MUSIC_MUTED);
            if (musicMuted !== null) this._musicMuted = musicMuted === 'true';

            const sfxMuted = localStorage.getItem(LS_SFX_MUTED);
            if (sfxMuted !== null) this._sfxMuted = sfxMuted === 'true';

            const masterMuted = localStorage.getItem(LS_MASTER_MUTED);
            if (masterMuted !== null) this._masterMuted = masterMuted === 'true';

            const introOn = localStorage.getItem(LS_INTRO_ON);
            if (introOn !== null) this._introEnabled = introOn !== 'false';

            const broadcastOn = localStorage.getItem(LS_BROADCAST_ON);
            if (broadcastOn !== null) this._broadcastOn = broadcastOn !== 'false';
        } catch (_) { /* localStorage không khả dụng */ }
    }
}
