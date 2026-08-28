import { _decorator, Component, Node, view, ResolutionPolicy, screen, Camera, Rect, director, Label } from 'cc';
import { FontManager } from '../manager/FontManager';
import { Log } from '../core/Logger';

const { ccclass, property, executionOrder } = _decorator;

@ccclass('ResponsiveController')
@executionOrder(-1000)
export class ResponsiveController extends Component {

    private readonly DESIGN_LANDSCAPE_WIDTH = 1920;
    private readonly DESIGN_LANDSCAPE_HEIGHT = 1080;

    @property({
        type: [Node],
        tooltip: 'Nodes kept inactive while layout is being applied, then activated at the end of start().',
        displayName: 'Nodes Activate After Layout',
    })
    nodesActivateAfterLayout: Node[] = [];

    @property({
        type: Camera,
        tooltip: 'Main camera. When SHOW_ALL is used, viewport is clipped to the game area.',
        displayName: 'Main Camera (Viewport Clip)',
    })
    mainCamera: Camera | null = null;

    private _lastApplyKey: string = '';
    private _pendingViewportDesignW: number = 0;
    private _pendingViewportDesignH: number = 0;

    onLoad(): void {
        for (const node of this.nodesActivateAfterLayout) {
            if (node) node.active = false;
        }

        screen.on('window-resize', this._onScreenChange, this);
        screen.on('orientation-change', this._onScreenChange, this);
    }

    start(): void {
        this._applyOrientation();

        for (const node of this.nodesActivateAfterLayout) {
            if (node) node.active = true;
        }
    }

    onDestroy(): void {
        screen.off('window-resize', this._onScreenChange, this);
        screen.off('orientation-change', this._onScreenChange, this);
        this.unschedule(this._applyOrientation);
        this.unschedule(this._applyCameraViewport);
        this.unschedule(this._rebuildLabelsAfterResize);
    }

    private _onScreenChange(): void {
        this.unschedule(this._applyOrientation);
        this.scheduleOnce(this._applyOrientation, 0);
    }

    private _applyOrientation(): void {
        const size = screen.windowSize;
        const isPortrait = size.height > size.width;
        const screenRatio = size.width / size.height;
        const designLandscapeRatio = this.DESIGN_LANDSCAPE_WIDTH / this.DESIGN_LANDSCAPE_HEIGHT;
        const designPortraitRatio = this.DESIGN_LANDSCAPE_HEIGHT / this.DESIGN_LANDSCAPE_WIDTH;

        let usedShowAll = false;
        let designW = this.DESIGN_LANDSCAPE_WIDTH;
        let designH = this.DESIGN_LANDSCAPE_HEIGHT;
        let policy = ResolutionPolicy.FIXED_HEIGHT;

        if (isPortrait) {
            designW = this.DESIGN_LANDSCAPE_HEIGHT;
            designH = this.DESIGN_LANDSCAPE_WIDTH;
            if (screenRatio > designPortraitRatio) {
                policy = ResolutionPolicy.SHOW_ALL;
                usedShowAll = true;
                Log.d('[Responsive] Portrait SHOW_ALL');
            } else {
                policy = ResolutionPolicy.FIXED_WIDTH;
                Log.d('[Responsive] Portrait FIXED_WIDTH');
            }
        } else if (screenRatio < designLandscapeRatio) {
            policy = ResolutionPolicy.SHOW_ALL;
            usedShowAll = true;
            Log.d('[Responsive] Landscape SHOW_ALL');
        } else {
            policy = ResolutionPolicy.FIXED_HEIGHT;
            Log.d('[Responsive] Landscape FIXED_HEIGHT');
        }

        const applyKey = `${size.width}x${size.height}:${designW}x${designH}:${policy}`;
        if (applyKey !== this._lastApplyKey) {
            this._lastApplyKey = applyKey;
            view.setDesignResolutionSize(designW, designH, policy);
            this.unschedule(this._rebuildLabelsAfterResize);
            this.scheduleOnce(this._rebuildLabelsAfterResize, 0);
        }

        this._updateCameraViewport(usedShowAll, designW, designH);
    }

    /**
     * Hạ mọi Label CHAR (bet / balance / Guide / popup…) rồi redraw.
     * CHAR atlas không theo canvas scale → window→fullscreen mix size glyph.
     */
    private _rebuildLabelsAfterResize(): void {
        const scene = director.getScene();
        if (!scene) return;
        const labels = scene.getComponentsInChildren(Label);
        for (const lb of labels) {
            if (!lb.isValid) continue;
            FontManager.sanitizeLabelCacheMode(lb);
            lb.updateRenderData(true);
        }
    }

    private _updateCameraViewport(isLetterbox: boolean, designW: number, designH: number): void {
        if (!this.mainCamera) return;

        this.unschedule(this._applyCameraViewport);
        if (!isLetterbox) {
            this.mainCamera.viewport = new Rect(0, 0, 1, 1);
            return;
        }

        this._pendingViewportDesignW = designW;
        this._pendingViewportDesignH = designH;
        this.scheduleOnce(this._applyCameraViewport, 0);
    }

    private _applyCameraViewport(): void {
        if (!this.mainCamera) return;

        const sw = screen.windowSize.width;
        const sh = screen.windowSize.height;
        const designW = this._pendingViewportDesignW;
        const designH = this._pendingViewportDesignH;
        if (sw <= 0 || sh <= 0 || designW <= 0 || designH <= 0) return;

        const scale = Math.min(sw / designW, sh / designH);
        // Snap to integer pixels — viewport lệch nửa pixel làm UI (SpriteNumber) bị nhòe/bể cạnh.
        const gw = Math.max(1, Math.round(designW * scale));
        const gh = Math.max(1, Math.round(designH * scale));
        const x = Math.round((sw - gw) / 2);
        const y = Math.round((sh - gh) / 2);
        this.mainCamera.viewport = new Rect(x / sw, y / sh, gw / sw, gh / sh);
        Log.d(`[Responsive] Camera viewport: x=${(x / sw).toFixed(3)} y=${(y / sh).toFixed(3)} w=${(gw / sw).toFixed(3)} h=${(gh / sh).toFixed(3)}`);
    }
}
