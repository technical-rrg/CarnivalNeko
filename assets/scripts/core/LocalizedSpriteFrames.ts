/**
 * LocalizedSpriteFrames — chọn SpriteFrame theo ngôn ngữ hiện tại.
 *
 * Gán defaultFrame (bắt buộc) + overrides[] khi có asset theo từng locale.
 * Chưa có override → fallback defaultFrame (dùng chung 1 hình tạm thời).
 */

import { _decorator, Sprite, SpriteFrame } from 'cc';
import { LanguageCode, LocalizationManager } from './LocalizationManager';

const { ccclass, property } = _decorator;

@ccclass('LocaleSpriteOverride')
export class LocaleSpriteOverride {

    @property({ tooltip: 'Mã ngôn ngữ: en, ko, zh-cn, vi, ...' })
    language = 'en';

    @property({ type: SpriteFrame, tooltip: 'Sprite cho ngôn ngữ này' })
    frame: SpriteFrame | null = null;
}

@ccclass('LocalizedSpriteFrames')
export class LocalizedSpriteFrames {

    @property({ type: SpriteFrame, tooltip: 'Frame mặc định / fallback khi chưa gán theo ngôn ngữ' })
    defaultFrame: SpriteFrame | null = null;

    @property({ type: [LocaleSpriteOverride], tooltip: 'Override theo ngôn ngữ (để trống = luôn dùng defaultFrame)' })
    overrides: LocaleSpriteOverride[] = [];

    resolve(lang?: LanguageCode): SpriteFrame | null {
        const code = lang ?? LocalizationManager.instance.currentLanguage;
        const hit = this.overrides.find(o => o.language === code)?.frame;
        return hit ?? this.defaultFrame;
    }
}

export function applyLocalizedSprite(
    sprite: Sprite | null | undefined,
    frames: LocalizedSpriteFrames | null | undefined,
    lang?: LanguageCode,
): void {
    if (!sprite?.isValid || !frames) return;
    const frame = frames.resolve(lang);
    if (frame) sprite.spriteFrame = frame;
}
