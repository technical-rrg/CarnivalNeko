/**
 * CarnivalPotBoard — 3 Pot (Blue / Red / Green) + burst khi Feature Trigger.
 *
 * Events:
 *   CARNIVAL_POT_LEVELS_CHANGED → scale theo level
 *   CARNIVAL_TRAIL_ONE_HIT      → bounce nhẹ
 *   CARNIVAL_POT_BURST          → nổ pot (scale lớn) → CARNIVAL_POT_BURST_DONE
 */

import {
    _decorator, Component, Node, Label, Vec3, tween, Tween,
    UITransform, Color, Graphics, Sprite,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { CarnivalFeatureTrigger, CarnivalPotLevels, TrailColor } from '../data/SlotTypes';
import { resetBurstPotState } from '../data/CarnivalFeatureResolve';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('CarnivalPotBoard')
export class CarnivalPotBoard extends Component {

    @property({ type: Node, tooltip: 'Blue Pot node (left)' })
    bluePot: Node | null = null;

    @property({ type: Node, tooltip: 'Red Pot node (center)' })
    redPot: Node | null = null;

    @property({ type: Node, tooltip: 'Green Pot node (right)' })
    greenPot: Node | null = null;

    @property({ type: Label, tooltip: 'Optional level label Blue' })
    blueLevelLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Optional level label Red' })
    redLevelLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Optional level label Green' })
    greenLevelLabel: Label | null = null;

    @property({ tooltip: 'Scale tại level 0' })
    scaleMin: number = 0.75;

    @property({ tooltip: 'Scale tại level 10' })
    scaleMax: number = 1.35;

    @property({ tooltip: 'Thời gian burst anim trước khi DONE (giây)' })
    burstDuration: number = 0.85;

    private _levels: CarnivalPotLevels = { blue: 0, red: 0, green: 0 };
    private _placeholderBuilt = false;
    private _bursting = false;

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.CARNIVAL_POT_LEVELS_CHANGED, this._onLevelsChanged, this);
        bus.on(GameEvents.CARNIVAL_TRAIL_ONE_HIT, this._onTrailHit, this);
        bus.on(GameEvents.CARNIVAL_POT_BURST, this._onPotBurst, this);
        bus.on(GameEvents.GAME_READY, this._onGameReady, this);
    }

    start(): void {
        this._ensurePlaceholders();
        this._levels = { ...GameData.instance.potLevels };
        this._applyAll(false);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    private _onGameReady(): void {
        this._levels = { ...GameData.instance.potLevels };
        this._applyAll(false);
    }

    private _onLevelsChanged(levels: CarnivalPotLevels): void {
        if (!levels) return;
        this._levels = { ...levels };
        this._applyAll(true);
        Log.d(`[CarnivalPot] levels B${levels.blue} R${levels.red} G${levels.green}`);
    }

    private _onTrailHit(payload: { color?: TrailColor }): void {
        const color = payload?.color;
        if (color === undefined || this._bursting) return;
        const node = this._nodeFor(color);
        if (!node) return;
        const base = this._scaleForLevel(this._levelOf(color));
        Tween.stopAllByTarget(node);
        tween(node)
            .to(0.08, { scale: new Vec3(base * 1.2, base * 1.2, 1) }, { easing: 'backOut' })
            .to(0.14, { scale: new Vec3(base, base, 1) }, { easing: 'sineOut' })
            .start();
    }

    private _onPotBurst(feature: CarnivalFeatureTrigger): void {
        if (!feature || this._bursting) {
            // Vẫn emit DONE để không treo GameManager
            EventBus.instance.emit(GameEvents.CARNIVAL_POT_BURST_DONE, feature);
            return;
        }
        this._bursting = true;
        Log.e(`[CarnivalPot] BURST → ${feature.featureName} pots=[${feature.burstPots.map(c => TrailColor[c]).join(',')}]`);

        const pots = feature.burstPots
            .map(c => this._nodeFor(c))
            .filter((n): n is Node => !!n?.isValid);

        for (const node of pots) {
            Tween.stopAllByTarget(node);
            const from = node.scale.clone();
            tween(node)
                .to(0.15, { scale: new Vec3(from.x * 1.55, from.y * 1.55, 1) }, { easing: 'backOut' })
                .to(0.2, { scale: new Vec3(from.x * 0.85, from.y * 0.85, 1) }, { easing: 'sineIn' })
                .to(0.25, { scale: new Vec3(from.x * 1.35, from.y * 1.35, 1) }, { easing: 'backOut' })
                .to(0.2, { scale: new Vec3(this.scaleMin, this.scaleMin, 1) }, { easing: 'sineOut' })
                .start();
        }

        // Reset state pot đã nổ
        resetBurstPotState(feature.burstPots);
        this._levels = { ...GameData.instance.potLevels };
        this._applyLabelsOnly();

        this.scheduleOnce(() => {
            this._bursting = false;
            this._applyAll(false);
            EventBus.instance.emit(GameEvents.CARNIVAL_POT_BURST_DONE, feature);
            Log.e('[CarnivalPot] BURST_DONE');
        }, this.burstDuration);
    }

    private _applyAll(animate: boolean): void {
        this._applyOne(this.bluePot, this.blueLevelLabel, this._levels.blue, animate);
        this._applyOne(this.redPot, this.redLevelLabel, this._levels.red, animate);
        this._applyOne(this.greenPot, this.greenLevelLabel, this._levels.green, animate);
    }

    private _applyLabelsOnly(): void {
        if (this.blueLevelLabel) this.blueLevelLabel.string = `Lv${this._levels.blue}`;
        if (this.redLevelLabel) this.redLevelLabel.string = `Lv${this._levels.red}`;
        if (this.greenLevelLabel) this.greenLevelLabel.string = `Lv${this._levels.green}`;
    }

    private _applyOne(node: Node | null, label: Label | null, level: number, animate: boolean): void {
        if (label) label.string = `Lv${level}`;
        if (!node || this._bursting) return;
        const s = this._scaleForLevel(level);
        if (animate) {
            tween(node).to(0.25, { scale: new Vec3(s, s, 1) }, { easing: 'backOut' }).start();
        } else {
            node.setScale(s, s, 1);
        }
    }

    private _scaleForLevel(level: number): number {
        const t = Math.min(10, Math.max(0, level)) / 10;
        return this.scaleMin + (this.scaleMax - this.scaleMin) * t;
    }

    private _levelOf(color: TrailColor): number {
        if (color === TrailColor.BLUE) return this._levels.blue;
        if (color === TrailColor.RED) return this._levels.red;
        return this._levels.green;
    }

    private _nodeFor(color: TrailColor): Node | null {
        switch (color) {
            case TrailColor.BLUE: return this.bluePot;
            case TrailColor.RED: return this.redPot;
            case TrailColor.GREEN: return this.greenPot;
            default: return null;
        }
    }

    private _ensurePlaceholders(): void {
        if (this._placeholderBuilt) return;
        this._placeholderBuilt = true;
        this._paintPlaceholder(this.bluePot, new Color(60, 120, 220, 220), 'B');
        this._paintPlaceholder(this.redPot, new Color(220, 60, 60, 220), 'R');
        this._paintPlaceholder(this.greenPot, new Color(50, 180, 80, 220), 'G');
    }

    private _paintPlaceholder(node: Node | null, color: Color, tag: string): void {
        if (!node) return;
        const hasSprite = !!node.getComponent(Sprite) || !!node.getComponentInChildren(Sprite);
        if (hasSprite) return;

        let g = node.getComponent(Graphics);
        if (!g) g = node.addComponent(Graphics);
        let tf = node.getComponent(UITransform);
        if (!tf) tf = node.addComponent(UITransform);
        tf.setContentSize(120, 120);
        g.clear();
        g.fillColor = color;
        g.circle(0, 0, 48);
        g.fill();
        g.strokeColor = new Color(255, 255, 255, 180);
        g.lineWidth = 3;
        g.circle(0, 0, 48);
        g.stroke();

        if (!node.getComponentInChildren(Label)) {
            const labelNode = new Node(`Tag_${tag}`);
            labelNode.setParent(node);
            const ltf = labelNode.addComponent(UITransform);
            ltf.setContentSize(60, 40);
            const lab = labelNode.addComponent(Label);
            lab.string = tag;
            lab.fontSize = 28;
            lab.color = Color.WHITE;
            lab.horizontalAlign = Label.HorizontalAlign.CENTER;
            lab.verticalAlign = Label.VerticalAlign.CENTER;
        }
    }
}
