/**
 * StickyFillEffect — orb template / timing props for MatsuriEffect.
 *
 * Force Entry fill flow removed. MatsuriEffect reads orbTemplate,
 * potNode, orbFallDuration, orbScaleInDuration via getComponentInChildren.
 */

import { _decorator, Component, Node, AudioClip } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('StickyFillEffect')
export class StickyFillEffect extends Component {

    @property({ type: Node, tooltip: 'Node Pot — điểm xuất phát orb (Matsuri seed).' })
    potNode: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Node mẫu light orb trên scene (active=false). MatsuriEffect dùng làm seed template.',
    })
    orbTemplate: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Node mẫu hiệu ứng chạm đất (optional, active=false).',
    })
    landEffectTemplate: Node | null = null;

    @property({ type: Node, tooltip: 'Node rung màn hình khi orb chạm (optional).' })
    screenShakeNode: Node | null = null;

    @property({ type: AudioClip, tooltip: 'SFX Pot charge (legacy).' })
    sfxCharge: AudioClip | null = null;
    @property({ type: AudioClip, tooltip: 'SFX phóng orb (legacy).' })
    sfxLaunch: AudioClip | null = null;
    @property({ type: AudioClip, tooltip: 'SFX orb chạm đất (legacy).' })
    sfxLand: AudioClip | null = null;
    @property({ type: AudioClip, tooltip: 'SFX convert thành Sticky (legacy).' })
    sfxConvert: AudioClip | null = null;

    @property({ tooltip: 'Delay sau khi Pot Impact xong trước khi bắn orb (giây).' })
    impactToLaunchDelay: number = 0;
    @property({ tooltip: 'Bắn orb sớm hơn trước khi Impact kết thúc (giây).' })
    impactEarlyLaunch: number = 0.18;
    @property({ tooltip: 'Play sx_pot_hit sớm hơn lúc orb bay ra (giây).' })
    potHitSfxLead: number = 0.12;
    @property({ tooltip: 'Thời gian zoom orb từ 0 → scale gốc khi bay ra (giây).' })
    orbScaleInDuration: number = 0.18;
    @property({ tooltip: 'Thời gian rơi của mỗi orb (Phase 2).' })
    orbFallDuration: number = 0.55;
    @property({ tooltip: 'Khoảng cách giữa 2 orb liên tiếp (giây).' })
    orbLaunchInterval: number = 0.25;
    @property({ tooltip: 'Thời gian giữ land FX trước khi trả pool (giây).' })
    landFxDuration: number = 1.0;

    onLoad(): void {
        if (this.orbTemplate) this.orbTemplate.active = false;
        if (this.landEffectTemplate) this.landEffectTemplate.active = false;
    }
}
