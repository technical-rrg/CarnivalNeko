/**
 * OpacityFadeUtil — fade / crossfade bằng UIOpacity (thay active true/false cứng).
 */

import { Node, Sprite, SpriteFrame, UIOpacity, UITransform, Tween, tween } from 'cc';

export const DEFAULT_UI_FADE_DURATION = 0.35;

export function ensureUIOpacity(node: Node | null | undefined): UIOpacity | null {
    if (!node?.isValid) return null;
    return node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
}

export function getNodeOpacity(node: Node | null | undefined): number {
    const op = node?.getComponent(UIOpacity);
    return op ? op.opacity : 255;
}

export function setNodeOpacity(node: Node | null | undefined, opacity: number): void {
    const op = ensureUIOpacity(node);
    if (!op) return;
    Tween.stopAllByTarget(op);
    op.opacity = opacity;
}

/**
 * Tween opacity → target. Node phải active để nhìn thấy fade.
 * onComplete gọi sau khi xong (hoặc ngay nếu duration≈0).
 */
export function fadeNodeOpacity(
    node: Node | null | undefined,
    toOpacity: number,
    duration: number = DEFAULT_UI_FADE_DURATION,
    onComplete?: () => void,
): void {
    if (!node?.isValid) {
        onComplete?.();
        return;
    }
    if (!node.active) node.active = true;
    const op = ensureUIOpacity(node)!;
    Tween.stopAllByTarget(op);
    const dur = Math.max(0, duration);
    if (dur <= 0.001) {
        op.opacity = toOpacity;
        onComplete?.();
        return;
    }
    tween(op)
        .to(dur, { opacity: toOpacity }, { easing: 'sineInOut' })
        .call(() => onComplete?.())
        .start();
}

/** Fade-in: active + opacity 0 → 255. */
export function fadeInNode(
    node: Node | null | undefined,
    duration: number = DEFAULT_UI_FADE_DURATION,
    onComplete?: () => void,
): void {
    if (!node?.isValid) {
        onComplete?.();
        return;
    }
    node.active = true;
    setNodeOpacity(node, 0);
    fadeNodeOpacity(node, 255, duration, onComplete);
}

/**
 * Fade-out: opacity → 0, rồi (tuỳ chọn) active=false sau khi xong.
 * deactivateAfter: false → giữ active, chỉ mờ (để crossfade song song).
 */
export function fadeOutNode(
    node: Node | null | undefined,
    duration: number = DEFAULT_UI_FADE_DURATION,
    deactivateAfter: boolean = true,
    onComplete?: () => void,
): void {
    if (!node?.isValid) {
        onComplete?.();
        return;
    }
    fadeNodeOpacity(node, 0, duration, () => {
        if (deactivateAfter && node.isValid) node.active = false;
        onComplete?.();
    });
}

/**
 * Crossfade sprite trên 1 node chính + 1 node phụ (tạo runtime nếu thiếu).
 * Hình cũ trên front mờ dần; hình mới trên back hiện dần rồi swap role.
 */
export function crossfadeSpriteFrame(
    primary: Node | null | undefined,
    secondary: Node | null | undefined,
    newFrame: SpriteFrame | null,
    duration: number = DEFAULT_UI_FADE_DURATION,
): Node | null {
    if (!primary?.isValid || !newFrame) return secondary ?? null;

    const frontSp = primary.getComponent(Sprite);
    if (!frontSp) return secondary ?? null;

    // Cùng frame → không cần crossfade
    if (frontSp.spriteFrame === newFrame) {
        setNodeOpacity(primary, 255);
        if (secondary?.isValid) setNodeOpacity(secondary, 0);
        return secondary ?? null;
    }

    // Chưa có hình cũ → gán thẳng
    if (!frontSp.spriteFrame) {
        frontSp.spriteFrame = newFrame;
        setNodeOpacity(primary, 255);
        if (secondary?.isValid) setNodeOpacity(secondary, 0);
        return secondary ?? null;
    }

    let back = secondary;
    if (!back?.isValid) {
        back = createBackgroundFadeTwin(primary);
    }
    if (!back?.isValid) {
        // Fallback: fade out → swap → fade in trên cùng node
        fadeNodeOpacity(primary, 0, duration * 0.5, () => {
            if (!primary.isValid) return;
            const sp = primary.getComponent(Sprite);
            if (sp) sp.spriteFrame = newFrame;
            fadeNodeOpacity(primary, 255, duration * 0.5);
        });
        return back;
    }

    const backSp = back.getComponent(Sprite) ?? back.addComponent(Sprite);
    // Đồng bộ size/transform với primary
    syncFadeTwinTransform(primary, back);
    backSp.sizeMode = frontSp.sizeMode;
    backSp.type = frontSp.type;
    backSp.spriteFrame = newFrame;
    back.active = true;
    setNodeOpacity(back, 0);
    setNodeOpacity(primary, getNodeOpacity(primary) || 255);

    const dur = Math.max(0.05, duration);
    fadeNodeOpacity(primary, 0, dur);
    fadeNodeOpacity(back, 255, dur, () => {
        if (!primary.isValid || !back?.isValid) return;
        // Đưa frame mới về primary (ổn định cho code khác chỉ biết primary)
        const pSp = primary.getComponent(Sprite);
        if (pSp) pSp.spriteFrame = newFrame;
        setNodeOpacity(primary, 255);
        setNodeOpacity(back, 0);
        back.active = false;
    });

    return back;
}

/** Clone nhẹ node Sprite làm lớp fade phụ (sibling, cùng parent). */
export function createBackgroundFadeTwin(primary: Node): Node | null {
    if (!primary?.isValid || !primary.parent) return null;
    const twin = new Node(`${primary.name}_FadeTwin`);
    twin.layer = primary.layer;
    primary.parent.insertChild(twin, primary.getSiblingIndex() + 1);

    const pUt = primary.getComponent(UITransform);
    const ut = twin.addComponent(UITransform);
    if (pUt) {
        ut.setContentSize(pUt.contentSize);
        ut.setAnchorPoint(pUt.anchorPoint);
    }
    twin.setPosition(primary.position);
    twin.setScale(primary.scale);
    twin.setRotation(primary.rotation);

    const pSp = primary.getComponent(Sprite);
    const sp = twin.addComponent(Sprite);
    if (pSp) {
        sp.sizeMode = pSp.sizeMode;
        sp.type = pSp.type;
        sp.color = pSp.color.clone();
    }
    const op = twin.addComponent(UIOpacity);
    op.opacity = 0;
    twin.active = false;
    return twin;
}

function syncFadeTwinTransform(primary: Node, twin: Node): void {
    const pUt = primary.getComponent(UITransform);
    const ut = twin.getComponent(UITransform);
    if (pUt && ut) {
        ut.setContentSize(pUt.contentSize);
        ut.setAnchorPoint(pUt.anchorPoint);
    }
    twin.setPosition(primary.position);
    twin.setScale(primary.scale);
    twin.setRotation(primary.rotation);
    if (twin.parent !== primary.parent && primary.parent) {
        twin.setParent(primary.parent);
        twin.setSiblingIndex(primary.getSiblingIndex() + 1);
    }
}
