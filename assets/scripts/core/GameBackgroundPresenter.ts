/**
 * Game background:
 *   Normal  → JPG (portrait / landscape)
 *   Feature → Spine Anim_Bg_Feature (_P / _L)
 *   Pick    → Spine Anim_Bg_Jackpot (_P / _L)
 *
 * Chỉ giữ 1 spine đang play (2 lúc crossfade). SkeletonData lazy-load + cache.
 * Mọi chuyển mode / xoay màn đều fade in–out.
 */

import { Node, Sprite, SpriteFrame, UITransform, UIOpacity, Widget, sp, assetManager, screen, view, Component } from 'cc';
import {
    crossfadeSpriteFrame,
    fadeInNode,
    fadeOutNode,
    setNodeOpacity,
    DEFAULT_UI_FADE_DURATION,
} from './OpacityFadeUtil';
import { Log } from './Logger';

const BG_BUNDLE = 'MainBundle';
const SPINE_ANIM = 'animation';

export type BackgroundMode = 'normal' | 'feature' | 'pickgame';

const NORMAL_BG_PATHS = [
    'newTextures/mainUI/Bg-normal-portrait/spriteFrame',
    'newTextures/mainUI/Bg-normal-landscape/spriteFrame',
] as const;

/** [0]=portrait, [1]=landscape — path SkeletonData trong MainBundle (không extension). */
const FEATURE_SPINE_PATHS = [
    'newSpine/Anim_Bg_Feature/Anim_Feature_P',
    'newSpine/Anim_Bg_Feature/Anim_Bg_Feature_L',
] as const;

const PICK_SPINE_PATHS = [
    'newSpine/Anim_Bg_Jackpot/Anim_Bg_Jackpot_P',
    'newSpine/Anim_Bg_Jackpot/Anim_Bg_Jackpot_L',
] as const;

const SPINE_NATIVE = {
    portrait: { w: 1080, h: 1920 },
    landscape: { w: 1920, h: 1080 },
} as const;

export class GameBackgroundPresenter {
    private _spriteNode: Node | null;
    private _normalCache: SpriteFrame[];
    private _getFadeDuration: () => number;
    private _scheduleHostComp: Component | null;

    private _spriteTwin: Node | null = null;
    private _currentSprite: SpriteFrame | null = null;

    private _spineFront: Node | null = null;
    private _spineBack: Node | null = null;

    private _skelCache = new Map<string, sp.SkeletonData>();
    private _skelLoads = new Map<string, Promise<sp.SkeletonData | null>>();
    private _spriteLoads = new Map<string, Promise<SpriteFrame | null>>();

    private _gen = 0;
    private _currentKey = '';
    private _visibleKind: 'sprite' | 'spine' | null = null;
    private _visibleMode: BackgroundMode | null = null;
    /** Huỷ refit deferred khi có orientation/mode mới. */
    private _fitSeq = 0;
    private _pendingFitSlot: Node | null = null;
    private _pendingFitIdx = 0;

    constructor(
        spriteNode: Node | null,
        normalCache: SpriteFrame[],
        getFadeDuration: () => number = () => DEFAULT_UI_FADE_DURATION,
        scheduleHost: Component | null = null,
    ) {
        this._spriteNode = spriteNode;
        this._normalCache = normalCache;
        this._getFadeDuration = getFadeDuration;
        this._scheduleHostComp = scheduleHost;
    }

    dispose(): void {
        this._fitSeq++;
        const host = this._scheduleHost();
        host?.unschedule(this._refitSpineDeferred);
        host?.unschedule(this._refitSpineLate);
        this._gen++;
        this._destroySlot(this._spineFront);
        this._destroySlot(this._spineBack);
        this._spineFront = null;
        this._spineBack = null;
        this._skelCache.clear();
        this._skelLoads.clear();
        this._spriteLoads.clear();
    }

    clear(): void {
        const sprite = this._spriteNode?.getComponent(Sprite);
        if (sprite) sprite.spriteFrame = null;
        this._currentSprite = null;
        this._currentKey = '';
        this._visibleKind = null;
        this._visibleMode = null;
        if (this._spriteTwin?.isValid) {
            setNodeOpacity(this._spriteTwin, 0);
            this._spriteTwin.active = false;
        }
        this._sleepSpine(this._spineFront);
        this._sleepSpine(this._spineBack);
    }

    isAssigned(): boolean {
        if (this._visibleKind === 'spine' && this._spineFront?.isValid && this._spineFront.active) {
            return true;
        }
        const sprite = this._spriteNode?.getComponent(Sprite);
        return !!sprite?.spriteFrame;
    }

    async ensureNormalReady(): Promise<SpriteFrame | null> {
        if (!this._spriteNode?.isValid) return null;
        const idx = this._orientationIndex();
        const other = idx === 0 ? 1 : 0;
        void this._loadSprite(NORMAL_BG_PATHS[other], other);
        const sf = await this._loadSprite(NORMAL_BG_PATHS[idx], idx);
        const gen = ++this._gen;
        this._applySprite(sf, `normal:${idx}`, gen, false);
        return sf;
    }

    update(mode: BackgroundMode): void {
        if (!this._spriteNode?.isValid) return;
        const idx = this._orientationIndex();
        const key = `${mode}:${idx}`;

        if (this._currentKey === key && this._visibleKind) {
            if (this._visibleKind === 'spine') this._scheduleSpineFit(this._spineFront, idx);
            return;
        }

        const gen = ++this._gen;
        if (mode === 'normal') {
            const cached = this._normalCache[idx] ?? null;
            if (cached) {
                this._applySprite(cached, key, gen, true);
                return;
            }
            void this._loadSprite(NORMAL_BG_PATHS[idx], idx).then((sf) => {
                if (gen !== this._gen) return;
                this._applySprite(sf, key, gen, true);
            });
            return;
        }

        const path = this._spinePath(mode, idx);
        const cached = this._skelCache.get(path) ?? null;
        if (cached) {
            this._applySpine(cached, mode, idx, key, gen);
            return;
        }
        void this._loadSpine(path).then((data) => {
            if (gen !== this._gen) return;
            this._applySpine(data, mode, idx, key, gen);
        });
    }

    prefetch(mode: 'feature' | 'pickgame'): void {
        const idx = this._orientationIndex();
        const other = idx === 0 ? 1 : 0;
        void this._loadSpine(this._spinePath(mode, idx));
        void this._loadSpine(this._spinePath(mode, other));
    }

    private _orientationIndex(): number {
        const size = screen.windowSize;
        return size.height > size.width ? 0 : 1;
    }

    private _spinePath(mode: 'feature' | 'pickgame', idx: number): string {
        return mode === 'pickgame' ? PICK_SPINE_PATHS[idx] : FEATURE_SPINE_PATHS[idx];
    }

    private _fadeDuration(): number {
        return Math.max(0.05, this._getFadeDuration());
    }

    private _applySprite(sf: SpriteFrame | null, key: string, gen: number, allowFade: boolean): void {
        if (!sf || !this._spriteNode?.isValid || gen !== this._gen) return;
        if (this._currentSprite === sf && this._visibleKind === 'sprite') {
            setNodeOpacity(this._spriteNode, 255);
            this._currentKey = key;
            return;
        }

        const hadPrevious = this._visibleKind !== null;
        this._currentSprite = sf;
        this._currentKey = key;
        this._visibleMode = 'normal';

        const spriteNode = this._spriteNode;
        spriteNode.active = true;

        if (!hadPrevious || !allowFade) {
            const sprite = spriteNode.getComponent(Sprite);
            if (sprite) sprite.spriteFrame = sf;
            setNodeOpacity(spriteNode, 255);
            this._sleepSpine(this._spineFront);
            this._sleepSpine(this._spineBack);
            this._visibleKind = 'sprite';
            return;
        }

        if (this._visibleKind === 'sprite') {
            this._spriteTwin = crossfadeSpriteFrame(
                spriteNode,
                this._spriteTwin,
                sf,
                this._fadeDuration(),
            );
            this._visibleKind = 'sprite';
            return;
        }

        const sprite = spriteNode.getComponent(Sprite);
        if (sprite) sprite.spriteFrame = sf;
        setNodeOpacity(spriteNode, 0);
        fadeInNode(spriteNode, this._fadeDuration());
        this._fadeOutSpine(this._spineFront);
        this._visibleKind = 'sprite';
    }

    private _applySpine(
        data: sp.SkeletonData | null,
        mode: 'feature' | 'pickgame',
        idx: number,
        key: string,
        gen: number,
    ): void {
        if (!data || !this._spriteNode?.isValid || gen !== this._gen) return;
        this._ensureSpineSlots();
        const incoming = this._spineBack;
        if (!incoming?.isValid) return;

        const preserve = this._visibleKind === 'spine' && this._visibleMode === mode;
        const resumeAt = preserve ? this._readTrackTime(this._spineFront) : 0;

        this._playOnSlot(incoming, data, idx, resumeAt);
        this._currentKey = key;
        this._visibleMode = mode;

        const dur = this._fadeDuration();
        const hadPrevious = this._visibleKind !== null;

        if (!hadPrevious) {
            setNodeOpacity(incoming, 255);
            incoming.active = true;
            this._hideSpriteLayer();
            this._commitSpineSwap();
            void this._loadSpine(this._spinePath(mode, idx === 0 ? 1 : 0));
            return;
        }

        incoming.active = true;
        setNodeOpacity(incoming, 0);
        fadeInNode(incoming, dur);

        if (this._visibleKind === 'sprite') {
            fadeOutNode(this._spriteNode, dur, false);
            if (this._spriteTwin?.isValid) {
                fadeOutNode(this._spriteTwin, dur, true);
            }
        } else {
            this._fadeOutSpine(this._spineFront);
        }

        this._visibleKind = 'spine';
        this._commitSpineSwap();
        void this._loadSpine(this._spinePath(mode, idx === 0 ? 1 : 0));
    }

    private _commitSpineSwap(): void {
        const oldFront = this._spineFront;
        this._spineFront = this._spineBack;
        this._spineBack = oldFront;
        this._visibleKind = 'spine';
    }

    private _hideSpriteLayer(): void {
        if (this._spriteNode?.isValid) setNodeOpacity(this._spriteNode, 0);
        if (this._spriteTwin?.isValid) {
            setNodeOpacity(this._spriteTwin, 0);
            this._spriteTwin.active = false;
        }
    }

    private _fadeOutSpine(slot: Node | null): void {
        if (!slot?.isValid) return;
        const skel = this._skeletonOf(slot);
        fadeOutNode(slot, this._fadeDuration(), true, () => {
            if (!slot.isValid) return;
            if (skel?.isValid) {
                skel.clearTracks();
                skel.paused = true;
            }
        });
    }

    private _sleepSpine(slot: Node | null): void {
        if (!slot?.isValid) return;
        const skel = this._skeletonOf(slot);
        if (skel?.isValid) {
            skel.clearTracks();
            skel.paused = true;
        }
        setNodeOpacity(slot, 0);
        slot.active = false;
    }

    private _playOnSlot(slot: Node, data: sp.SkeletonData, idx: number, resumeAt: number): void {
        const skel = this._skeletonOf(slot);
        if (!skel) return;
        skel.clearTracks();
        if (skel.skeletonData !== data) {
            skel.skeletonData = null!;
            skel.skeletonData = data;
        }
        skel.paused = false;
        skel.premultipliedAlpha = false;
        slot.active = true;
        this._scheduleSpineFit(slot, idx);

        if (!skel.findAnimation(SPINE_ANIM)) {
            Log.w(`[GameBackground] Missing anim "${SPINE_ANIM}"`);
            return;
        }
        const entry = skel.setAnimation(0, SPINE_ANIM, true);
        if (entry && resumeAt > 0) {
            const duration = (entry.animation as { duration?: number } | null)?.duration ?? 0;
            entry.trackTime = duration > 0 ? resumeAt % duration : resumeAt;
        }
    }

    private _readTrackTime(slot: Node | null): number {
        const skel = this._skeletonOf(slot);
        if (!skel) return 0;
        const entry = skel.getCurrent(0);
        return entry?.trackTime ?? 0;
    }

    private _skeletonOf(slot: Node | null): sp.Skeleton | null {
        if (!slot?.isValid) return null;
        return slot.getComponentInChildren(sp.Skeleton);
    }

    private _scheduleHost(): Component | null {
        if (this._scheduleHostComp?.isValid) return this._scheduleHostComp;
        return null;
    }

    /**
     * Fit spine cover-scale — gọi ngay + deferred (frame 0 + ~80ms).
     * orientation-change chạy trước khi Widget/ResponsiveController settle → scale sai nếu chỉ fit 1 lần.
     */
    private _scheduleSpineFit(slot: Node | null, idx: number): void {
        if (!slot?.isValid) return;
        this._pendingFitSlot = slot;
        this._pendingFitIdx = idx;
        ++this._fitSeq;

        this._fitSpine(slot, idx);

        const host = this._scheduleHost();
        if (!host) return;

        host.unschedule(this._refitSpineDeferred);
        host.unschedule(this._refitSpineLate);
        host.scheduleOnce(this._refitSpineDeferred, 0);
        host.scheduleOnce(this._refitSpineLate, 0.08);
    }

    private _refitSpineDeferred = (): void => {
        if (!this._pendingFitSlot?.isValid) return;
        this._fitSpine(this._pendingFitSlot, this._pendingFitIdx);
    };

    private _refitSpineLate = (): void => {
        if (!this._pendingFitSlot?.isValid) return;
        this._fitSpine(this._pendingFitSlot, this._pendingFitIdx);
    };

    /** Kích thước cover — dùng visible/design, không đụng Widget/UITransform size. */
    private _coverTargetSize(): { w: number; h: number } {
        const visible = view.getVisibleSize();
        if (visible.width > 1 && visible.height > 1) {
            return { w: visible.width, h: visible.height };
        }
        const ds = view.getDesignResolutionSize();
        if (ds.width > 1 && ds.height > 1) {
            return { w: ds.width, h: ds.height };
        }
        return { w: 1920, h: 1080 };
    }

    private _fitSpine(slot: Node | null, idx: number): void {
        if (!slot?.isValid) return;
        this._stripWidget(slot);

        const skelNode = slot.getChildByName('Skeleton');
        if (!skelNode?.isValid) return;

        const native = idx === 0 ? SPINE_NATIVE.portrait : SPINE_NATIVE.landscape;
        const { w: pw, h: ph } = this._coverTargetSize();
        const s = Math.max(pw / native.w, ph / native.h);
        skelNode.setScale(s, s, 1);
    }

    /** Widget trên BG spine gây refreshWidgetOnResized loop trên web — gỡ hẳn. */
    private _stripWidget(slot: Node): void {
        const widget = slot.getComponent(Widget);
        if (widget) slot.removeComponent(widget);
    }

    private _ensureSpineSlots(): void {
        if (this._spineFront?.isValid && this._spineBack?.isValid) return;
        this._spineFront = this._createSpineSlot('BackgroundSpine');
        this._spineBack = this._createSpineSlot('BackgroundSpine_FadeTwin');
    }

    private _createSpineSlot(name: string): Node | null {
        const src = this._spriteNode;
        if (!src?.isValid || !src.parent) return null;

        let node = src.parent.getChildByName(name);
        if (node?.isValid) {
            this._stripWidget(node);
            this._ensureSkeletonChild(node);
            node.setPosition(0, 0, 0);
            const ut = node.getComponent(UITransform) ?? node.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            const { w, h } = this._coverTargetSize();
            ut.setContentSize(w, h);
            if (!node.getComponent(UIOpacity)) node.addComponent(UIOpacity);
            setNodeOpacity(node, 0);
            node.active = false;
            return node;
        }

        node = new Node(name);
        node.layer = src.layer;
        src.parent.insertChild(node, src.getSiblingIndex() + 1);
        node.setPosition(0, 0, 0);

        const ut = node.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        const { w, h } = this._coverTargetSize();
        ut.setContentSize(w, h);

        const op = node.addComponent(UIOpacity);
        op.opacity = 0;
        this._ensureSkeletonChild(node);
        node.active = false;
        return node;
    }

    private _ensureSkeletonChild(slot: Node): sp.Skeleton {
        let skelNode = slot.getChildByName('Skeleton');
        if (!skelNode?.isValid) {
            skelNode = new Node('Skeleton');
            skelNode.layer = slot.layer;
            skelNode.setParent(slot);
            skelNode.setPosition(0, 0, 0);
            const ut = skelNode.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
        }
        let skel = skelNode.getComponent(sp.Skeleton);
        if (!skel) skel = skelNode.addComponent(sp.Skeleton);
        skel.premultipliedAlpha = false;
        skel.enableBatch = false;
        return skel;
    }

    private _destroySlot(slot: Node | null): void {
        if (slot?.isValid) slot.destroy();
    }

    private _loadSprite(path: string, idx: number): Promise<SpriteFrame | null> {
        const cached = this._normalCache[idx] ?? null;
        if (cached) return Promise.resolve(cached);
        const existing = this._spriteLoads.get(path);
        if (existing) return existing;

        const promise = new Promise<SpriteFrame | null>((resolve) => {
            const bundle = assetManager.getBundle(BG_BUNDLE);
            if (!bundle) {
                Log.w(`[GameBackground] Bundle '${BG_BUNDLE}' missing — ${path}`);
                resolve(null);
                return;
            }
            bundle.load(path, SpriteFrame, (err, sf) => {
                this._spriteLoads.delete(path);
                if (err || !sf) {
                    Log.w(`[GameBackground] JPG load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                while (this._normalCache.length <= idx) this._normalCache.push(null as unknown as SpriteFrame);
                this._normalCache[idx] = sf;
                resolve(sf);
            });
        });
        this._spriteLoads.set(path, promise);
        return promise;
    }

    private _loadSpine(path: string): Promise<sp.SkeletonData | null> {
        const cached = this._skelCache.get(path);
        if (cached) return Promise.resolve(cached);
        const existing = this._skelLoads.get(path);
        if (existing) return existing;

        const promise = new Promise<sp.SkeletonData | null>((resolve) => {
            const bundle = assetManager.getBundle(BG_BUNDLE);
            if (!bundle) {
                Log.w(`[GameBackground] Bundle '${BG_BUNDLE}' missing — ${path}`);
                resolve(null);
                return;
            }
            bundle.load(path, sp.SkeletonData, (err, data) => {
                this._skelLoads.delete(path);
                if (err || !data) {
                    Log.w(`[GameBackground] Spine load failed: ${path}`, err);
                    resolve(null);
                    return;
                }
                this._skelCache.set(path, data);
                Log.d(`[GameBackground] Cached spine ${path}`);
                resolve(data);
            });
        });
        this._skelLoads.set(path, promise);
        return promise;
    }
}
