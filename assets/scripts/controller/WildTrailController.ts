/**
 * WildTrailController — Hiệu ứng Wild (Bat) symbol khi land trên reel.
 *
 * FLOW (mỗi spin có wildTrailCount > 0):
 *   1. GameManager emit WILD_TRAIL_START { positions, count }
 *   2. Với mỗi vị trí bat:
 *      a. Zoom nhẹ symbol node (scale 1→1.25→1, duration = zoomDuration)
 *      b. Tạo 1 "particle" node bay từ vị trí bat → potNode
 *         (Normal 0.8s / Quick 0.65s / Turbo 0.5s)
 *   3. Sau khi TẤT CẢ particle đến nơi → emit WILD_TRAIL_FLY_DONE
 *
 * SETUP TRONG EDITOR:
 *   1. Tạo Node trống "WildTrailController" trong scene.
 *   2. Gắn component WildTrailController vào Node đó.
 *   3. Kéo 5 ReelController vào mảng "reels" theo thứ tự 0→4.
 *   4. Kéo Node hũ Pot vào slot "potNode".
 *   5. (Tuỳ chọn) kéo 1 Node sprite dùng làm template particle vào "particleTemplate".
 *      Nếu để trống → dùng hình chữ nhật vàng 20×20 tự tạo.
 *
 * LƯU Ý:
 *   - symbolNodes[1+(2-gridRow)] = node tương ứng gridRow (vì displayRow = 2 - gridRow,
 *     nodeIndex = 1 + displayRow = 1 + (2 - gridRow) = 3 - gridRow).
 *   - Sau này: thay zoom bằng spine animation trên symbol node.
 *   - Sau này: thay particle node bằng particle system / spine hiệu ứng bay.
 */

import {
    _decorator, Component, Node, Vec3, tween, Tween,
    UITransform, Color, Graphics, instantiate, sp,
    ParticleSystem, Camera,
    input, Input, EventKeyboard, EventMouse, KeyCode,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { ReelController } from './ReelController';
import { SymbolView } from './SymbolView';
import { Log } from '../core/Logger';
import { AutoSpinManager, SpeedMode } from '../manager/AutoSpinManager';
import { SymbolHighlighter } from './SymbolHighlighter';
import { SymbolId } from '../data/SlotTypes';
import { isDebugToolsEnabled } from '../core/DebugEnv';

const { ccclass, property } = _decorator;

/** Priority cao hơn UI Camera → Particle3D luôn vẽ đè lên UI. */
const PARTICLE_3D_CAMERA_PRIORITY_OFFSET = 100;

/** Camera được tạo sẵn trong loading.scene — Visibility / Layer gán trên Editor (khuyến nghị UI_3D). */
const WILD_TRAIL_CAMERA_NAME = 'Particle3DCamera';

export interface WildTrailPayload {
    positions: Array<{ reel: number; row: number }>;
    count: number;
}

@ccclass('WildTrailController')
export class WildTrailController extends Component {

    /** Danh sách spine nodes đang active — dùng để cleanup khi spin mới.
     *  Mỗi entry lưu cả spineNode và symbolNode gốc (để restore sprite khi spine được reparent ra ngoài reel). */
    private _spawnedSpineNodes: Array<{ spineNode: Node; symbolNode: Node }> = [];

    /** Pool spine nodes */
    private _spinePool: Node[] = [];
    private readonly _spinePoolSize: number = 5;

    /** Số particle đang bay — khi về 0 emit WILD_TRAIL_FLY_DONE */
    private _flyingCount: number = 0;

    /** Tham chiếu tới SymbolHighlighter để lấy offset Y cho Wild spine (spineLocalPosY[WILD]). */
    private _symbolHighlighter: SymbolHighlighter | null = null;

    /** Camera UI hiện tại dùng làm chuẩn transform/viewport cho camera render trail. */
    private _sourceCamera: Camera | null = null;

    /** Camera chỉ render layer ParticleSystem 3D của WILD-trail. */
    private _trailCamera: Camera | null = null;

    /** Particle đang bay / đang fade-out — dọn khi spin mới hoặc destroy controller. */
    private _activeParticles: Set<Node> = new Set();

    /** Debug: particle follow chuột (phím T). */
    private _debugFollowParticle: Node | null = null;
    private readonly _debugMouseWorld = new Vec3();
    private readonly _debugScreenPos = new Vec3();

    // ─── INSPECTOR PROPERTIES ──────────────────────────────────────────────

    @property({
        type: [ReelController],
        tooltip: '5 ReelController theo thứ tự reel 0→4\n(kéo từ SlotMachine node trong Hierarchy)',
    })
    reels: ReelController[] = [];

    @property({
        type: Node,
        tooltip: 'Node đại diện cho hũ Pot — particle sẽ bay đến WorldPosition của node này.\n'
               + 'Có thể là node trung tâm của PotController.',
    })
    potNode: Node | null = null;

    @property({
        type: Node,
        tooltip: '(Tuỳ chọn) Template node cho particle bay.\n'
               + 'Nếu để trống → tạo hình vuông vàng 20×20 bằng Graphics.\n'
               + 'Template nên là Node inactive với Sprite component sẵn.',
    })
    particleTemplate: Node | null = null;

    @property({ tooltip: 'Thời gian zoom symbol bat: scale 1→1.25→1 (giây)' })
    zoomDuration: number = 0.15;

    @property({ tooltip: 'Thời gian particle bay Normal Spin (giây)' })
    flyDurationNormal: number = 0.8;

    @property({ tooltip: 'Thời gian particle bay Quick Spin (giây)' })
    flyDurationQuick: number = 0.65;

    @property({ tooltip: 'Thời gian particle bay Turbo Spin (giây)' })
    flyDurationTurbo: number = 0.5;

    @property({ tooltip: 'Tên Spine animation phát khi wild trail bay ra (mặc định: win2).' })
    wildTrailAnimName: string = 'win2';

    @property({
        type: Node,
        tooltip: 'Spine prefab để clone vào symbol node khi wild trail bay ra.\n'
               + 'Node inactive với sp.Skeleton component gắn sẵn.',
    })
    spinePrefab: Node | null = null;

    @property({
        tooltip: 'Độ rộng/độ xa đường bay Bezier (tỉ lệ so với khoảng cách symbol→pot).\n'
               + 'Cao hơn = vòng rộng hơn, đường đi dài hơn (thời gian bay không đổi).',
        range: [0.3, 2.5, 0.05],
    })
    flyCurvature: number = 1.35;

    @property({
        tooltip: 'Khoảng cách tối thiểu (world) dùng để tính vòng cung.\n'
               + 'Khi Wild gần Pot, vẫn bay xa/vòng lớn rồi mới về Pot — không bò chậm đoạn ngắn.',
    })
    minFlyPathDistance: number = 420;

    @property({
        tooltip: 'Delay trước khi bắt đầu bay (giây) — chờ Particle/Trail play xong 1 nhịp để ribbon kịp hiện.',
    })
    flyLaunchDelay: number = 0.06;

    @property({
        tooltip: 'Lệch điểm xuất phát khỏi Wild theo hướng cung (world) — tránh trail dính sát symbol.',
    })
    flyLaunchOffset: number = 36;

    @property({
        tooltip: 'Thời gian tối thiểu giữ node effect sau khi chạm Pot trước khi destroy (giây).\n'
               + 'Thực tế sẽ lấy max(giá trị này, startLifetime + trailLife) để trail kịp tàn.',
    })
    particleFadeOutDuration: number = 1.5;

    // ─── LIFECYCLE ─────────────────────────────────────────────────────────

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.WILD_TRAIL_ONE, this._onWildTrailOne, this);
        bus.on(GameEvents.REELS_START_SPIN, this._onReelsStartSpin, this);
        // Cleanup spine khi vào feature mode / feature select — đảm bảo Wild effect không còn hiển thị
        bus.on(GameEvents.FREE_SPIN_START,      this._onFeatureGameStart, this);
        bus.on(GameEvents.FREE_SPIN_GOLD_START, this._onFeatureGameStart, this);
        bus.on(GameEvents.TOPUP_START,           this._onFeatureGameStart, this);
        bus.on(GameEvents.FEATURE_SELECT_OPEN, this._onFeatureGameStart, this);
        bus.on(GameEvents.CREDIT_FLY_IN_START,  this._onFeatureGameStart, this);
        this._buildSpinePool();
        this._setupTrailCamera();
        this._setupDebugMouseFollow();

        // Tìm SymbolHighlighter trong scene (nếu có) để dùng chung offset Y cho Wild
        try {
            this._symbolHighlighter = this.node.scene?.getComponentInChildren(SymbolHighlighter) ?? null;
        } catch (_e) {
            this._symbolHighlighter = null;
        }
    }

    lateUpdate(): void {
        this._syncTrailCamera();
    }

    /** Lấy camera Particle3DCamera đã đặt sẵn trong loading.scene. */
    private _setupTrailCamera(): void {
        const scene = this.node.scene;
        if (!scene) return;

        this._trailCamera = scene.getComponentsInChildren(Camera).find(camera =>
            camera.node.name === WILD_TRAIL_CAMERA_NAME
        ) ?? null;

        if (!this._trailCamera) {
            Log.w(`[WildTrail] Không tìm thấy Camera "${WILD_TRAIL_CAMERA_NAME}" trong scene`);
            return;
        }

        this._sourceCamera = scene.getComponentsInChildren(Camera).find(camera =>
            camera.enabled
            && camera.node.name !== WILD_TRAIL_CAMERA_NAME
            && (camera.visibility & this.node.layer) !== 0
        ) ?? null;

        if (!this._sourceCamera) {
            Log.w('[WildTrail] Không tìm thấy UI Camera để đồng bộ Particle3DCamera');
            return;
        }

        // KHÔNG ghi đè visibility / layer — giữ đúng giá trị Editor (UI_3D).
        // Chỉ clear Depth để particle không bị depth UI chặn, giữ màu frame trước.
        this._trailCamera.node.active = true;
        this._trailCamera.enabled = true;
        this._trailCamera.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
        // Đưa camera ra ngoài Canvas (sibling Scene) — tránh pipeline UI xếp sai thứ tự.
        if (scene && this._trailCamera.node.parent !== scene) {
            this._trailCamera.node.setParent(scene);
        }
        this._syncTrailCamera();
    }

    /** Giữ camera trail khớp camera UI khi viewport/orientation thay đổi. */
    private _syncTrailCamera(): void {
        const source = this._sourceCamera;
        const trail = this._trailCamera;
        if (!source?.isValid || !trail?.isValid) return;

        trail.projection = source.projection;
        trail.fov = source.fov;
        trail.orthoHeight = source.orthoHeight;
        trail.near = source.near;
        trail.far = source.far;
        trail.viewport = source.viewport;
        // Priority cao hơn UI → luôn render SAU / đè lên UI Camera.
        trail.priority = source.priority + PARTICLE_3D_CAMERA_PRIORITY_OFFSET;

        trail.node.setWorldPosition(source.node.worldPosition);
        trail.node.setWorldRotation(source.node.worldRotation);
        trail.node.setScale(1, 1, 1);
    }

    /**
     * Tìm root WILD-trail (vd. WILD-trail, WILD-trail-Egypt) trong template Trail.
     * Layer (UI_3D) gán sẵn trên Editor — code không đụng layer/visibility.
     */
    private _findWildTrailFxNode(root: Node): Node | null {
        if (!root?.isValid) return null;
        if (root.name.startsWith('WILD-trail')) return root;
        const direct = root.children.find(child => child.name.startsWith('WILD-trail'));
        if (direct) return direct;
        for (const child of root.children) {
            const found = this._findWildTrailFxNode(child);
            if (found) return found;
        }
        return null;
    }

    /**
     * Vá material slot 0 nếu null — thiếu material khiến doUpdateScale → setUniform UNKNOWN
     * và particle render mềm/hỏng so với template gốc.
     */
    private _ensureParticleMaterial(ps: ParticleSystem): void {
        const mats = ps.sharedMaterials ? [...ps.sharedMaterials] : [];
        if (mats[0]) return;

        const renderer = (ps as unknown as {
            renderer?: { cpuMaterial?: unknown };
        }).renderer;
        const cpuMat = renderer?.cpuMaterial ?? null;
        if (!cpuMat) return;

        while (mats.length < 1) mats.push(null);
        mats[0] = cpuMat as never;
        ps.sharedMaterials = mats as never;
    }

    /** ParticleSystem thuộc WILD-trail (camera 3D), bỏ qua sibling ngoài WILD-trail. */
    private _getWildTrailParticleSystems(root: Node): ParticleSystem[] {
        const fx = this._findWildTrailFxNode(root);
        if (!fx) return [];
        return fx.getComponentsInChildren(ParticleSystem).filter(
            ps => ps.isValid && ps.enabled && !!ps.node?.activeInHierarchy
        );
    }

    /**
     * ParticleSystem UI_2D nằm ngoài WILD-trail (sibling dưới Trail, vd. qilin-001).
     * Vẫn render qua UI Camera + UIMeshRenderer — không đưa vào layer 3D.
     */
    private _getUiSiblingParticleSystems(root: Node): ParticleSystem[] {
        const fx = this._findWildTrailFxNode(root);
        const all = root.getComponentsInChildren(ParticleSystem);
        return all.filter(ps => {
            if (!ps.isValid || !ps.enabled || !ps.node?.activeInHierarchy) return false;
            if (!fx) return true;
            // Bỏ qua mọi PS nằm trong subtree WILD-trail
            let n: Node | null = ps.node;
            while (n) {
                if (n === fx) return false;
                n = n.parent;
            }
            return true;
        });
    }

    private _playOneParticleSystem(ps: ParticleSystem): void {
        if (!ps.isValid || !ps.enabled || !ps.node?.activeInHierarchy) return;

        ps.loop = true;
        if ('prewarm' in ps) {
            (ps as unknown as { prewarm: boolean }).prewarm = false;
        }

        // Không đụng alignSpace runtime — setter cần processor và dễ làm hỏng pass uniform (setUniform UNKNOWN).
        this._ensureParticleMaterial(ps);

        // Local + scale lớn × startSpeed cao → particle văng khỏi màn khi Play.
        const s = ps.node.scale;
        const maxScale = Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z), 1);
        if (ps.simulationSpace === 0 && maxScale > 1.01 && ps.startSpeed) {
            const raw = ps.startSpeed.constant ?? 0;
            if (raw > 0) {
                ps.startSpeed.mode = 0;
                ps.startSpeed.constant = raw / maxScale;
            }
        }

        try {
            // Không stop+clear hệ Trail — giữ buffer giống template playOnAwake.
            const trail = (ps as unknown as {
                trailModule?: { enable?: boolean; _enable?: boolean };
            }).trailModule;
            const hasTrail = !!(trail?.enable ?? trail?._enable);
            if (hasTrail) {
                if (!ps.isPlaying) ps.play();
            } else {
                ps.stop();
                const maybeClear = (ps as unknown as { clear?: () => void }).clear;
                if (maybeClear) maybeClear.call(ps);
                ps.play();
            }
        } catch (err) {
            Log.w(`[WildTrail] play particle failed on "${ps.node?.name}":`, err);
        }
    }

    private _playParticlesFromStart(root: Node): void {
        // 1) WILD-trail → camera 3D
        for (const ps of this._getWildTrailParticleSystems(root)) {
            this._playOneParticleSystem(ps);
        }
        // 2) Sibling UI_2D (qilin-001...) → UI Camera, giữ layer cũ
        for (const ps of this._getUiSiblingParticleSystems(root)) {
            this._playOneParticleSystem(ps);
        }
    }

    /** Vào Feature Mode → return toàn bộ spine nodes về pool ngay lập tức */
    private _onFeatureGameStart(): void {
        this._returnAllSpawnedSpines();
        this._destroyAllParticles();
    }

    private _buildSpinePool(): void {
        if (!this.spinePrefab || this._spinePool.length > 0) return;
        for (let i = 0; i < this._spinePoolSize; i++) {
            const n = instantiate(this.spinePrefab);
            n.name = `WildSpine_${i}`;
            n.active = false;
            n.setParent(this.node);
            this._spinePool.push(n);
        }
    }

    private _borrowSpine(): Node | null {
        while (this._spinePool.length > 0) {
            const n = this._spinePool.pop()!;
            if (n.isValid) return n;
        }
        if (this.spinePrefab) {
            Log.w('[WildTrail] spinePool exhausted — instantiate fallback');
            return instantiate(this.spinePrefab);
        }
        Log.w('[WildTrail] spinePool exhausted & no prefab');
        return null;
    }

    /** Thời gian bay theo AutoSpin speed mode. */
    private _getFlyDuration(): number {
        switch (AutoSpinManager.instance.speedMode) {
            case SpeedMode.TURBO: return this.flyDurationTurbo;
            case SpeedMode.QUICK: return this.flyDurationQuick;
            default:              return this.flyDurationNormal;
        }
    }

    /** Tốc độ bay theo AutoSpin speed mode — Quick/Turbo nhanh hơn (legacy multiplier cho chỗ khác nếu cần). */
    private _getSpeedMultiplier(): number {
        switch (AutoSpinManager.instance.speedMode) {
            case SpeedMode.TURBO: return this.flyDurationTurbo / this.flyDurationNormal;
            case SpeedMode.QUICK: return this.flyDurationQuick / this.flyDurationNormal;
            default:              return 1.0;
        }
    }

    private _returnSpine(n: Node): void {
        if (!n || !n.isValid) return;
        Tween.stopAllByTarget(n);
        const skel = n.getComponent(sp.Skeleton);
        if (skel) {
            skel.setCompleteListener(null);
            skel.clearTracks();
            skel.timeScale = 1;
        }
        n.active = false;
        n.setParent(this.node);
        n.setPosition(0, 0, 0);
        n.setScale(1, 1, 1);
        n.setRotationFromEuler(0, 0, 0);
        if (!this._spinePool.includes(n)) {
            this._spinePool.push(n);
        }
    }

    /** Tắt emit nhưng vẫn để ParticleSystem simulate — Trail module cần hệ còn playing mới tàn dần. */
    private _stopParticleEmission(ps: ParticleSystem): void {
        ps.loop = false;
        if (ps.rateOverTime) {
            ps.rateOverTime.mode = 0;
            ps.rateOverTime.constant = 0;
        }
        if (ps.rateOverDistance) {
            ps.rateOverDistance.mode = 0;
            ps.rateOverDistance.constant = 0;
        }
        // Không gọi ps.stop()/clear() — với Trail, stop thường làm effect biến mất ngay.
        if (!ps.isPlaying) {
            ps.play();
        }
    }

    /** Ước lượng thời gian chờ tối thiểu để particle + trail hết lifetime. */
    private _estimateParticleFadeDelay(root: Node): number {
        let maxLife = Math.max(0, this.particleFadeOutDuration);
        for (const ps of this._getWildTrailParticleSystems(root)) {
            const startLife = ps.startLifetime?.constant ?? 0;
            const trail = (ps as unknown as {
                trailModule?: { enable?: boolean; lifeTime?: { constant?: number } };
            }).trailModule;
            const trailLife = (trail?.enable && trail.lifeTime?.constant) ? trail.lifeTime.constant : 0;
            maxLife = Math.max(maxLife, startLife + trailLife + 0.15);
        }
        return maxLife;
    }

    /**
     * Va chạm Pot: giữ nguyên node effect tại chỗ, chỉ dừng emit.
     * Particle/trail đang sống tiếp tục simulate rồi mới destroy sau delay.
     */
    private _beginParticleFadeOut(root: Node): void {
        if (!root?.isValid) return;

        root.active = true;
        for (const ps of this._getWildTrailParticleSystems(root)) {
            this._stopParticleEmission(ps);
        }
        for (const ps of this._getUiSiblingParticleSystems(root)) {
            this._stopParticleEmission(ps);
        }

        const delay = this._estimateParticleFadeDelay(root);
        this.scheduleOnce(() => {
            this._destroyParticle(root);
        }, delay);
    }

    private _destroyParticle(root: Node): void {
        this._activeParticles.delete(root);
        if (root?.isValid) root.destroy();
    }

    private _destroyAllParticles(): void {
        this._debugFollowParticle = null;
        for (const node of this._activeParticles) {
            if (node?.isValid) node.destroy();
        }
        this._activeParticles.clear();
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        this._teardownDebugMouseFollow();
        this._returnAllSpawnedSpines();
        this._destroyAllParticles();
        // Particle3DCamera thuộc scene, không destroy cùng controller.
        this._trailCamera = null;
        this._sourceCamera = null;
    }

    // ─── DEBUG: phím T → spawn trail tại chuột, di chuột → follow ─────────

    private _setupDebugMouseFollow(): void {
        if (!isDebugToolsEnabled()) return;
        input.on(Input.EventType.KEY_DOWN, this._onDebugKeyDown, this);
        input.on(Input.EventType.MOUSE_MOVE, this._onDebugMouseMove, this);
        input.on(Input.EventType.MOUSE_DOWN, this._onDebugMouseMove, this);
        Log.d('[WildTrail] DEBUG: nhấn T = bật/tắt trail follow chuột');
    }

    private _teardownDebugMouseFollow(): void {
        input.off(Input.EventType.KEY_DOWN, this._onDebugKeyDown, this);
        input.off(Input.EventType.MOUSE_MOVE, this._onDebugMouseMove, this);
        input.off(Input.EventType.MOUSE_DOWN, this._onDebugMouseMove, this);
        this._stopDebugFollow(false);
    }

    private _onDebugKeyDown(event: EventKeyboard): void {
        if (!isDebugToolsEnabled()) return;
        if (event.keyCode !== KeyCode.KEY_T) return;

        if (this._debugFollowParticle?.isValid) {
            this._stopDebugFollow(true);
            Log.d('[WildTrail] DEBUG follow OFF');
            return;
        }

        this._spawnDebugFollowAtMouse();
    }

    private _onDebugMouseMove(event: EventMouse): void {
        // Luôn cache vị trí chuột — để khi nhấn T spawn đúng chỗ con trỏ.
        if (!this._screenToWorld(event.getLocationX(), event.getLocationY(), this._debugMouseWorld)) return;
        if (!this._debugFollowParticle?.isValid) return;
        this._debugFollowParticle.setWorldPosition(this._debugMouseWorld);
    }

    private _spawnDebugFollowAtMouse(): void {
        const particle = this._spawnParticle();
        if (!particle) {
            Log.w('[WildTrail] DEBUG spawn failed — thiếu particleTemplate?');
            return;
        }

        this._attachParticleOutsideCanvas(particle);
        particle.active = true;
        this._activeParticles.add(particle);
        this._debugFollowParticle = particle;
        particle.setWorldPosition(this._debugMouseWorld);

        this.scheduleOnce(() => {
            if (!particle.isValid) return;
            this._playParticlesFromStart(particle);
        }, 0);

        Log.d('[WildTrail] DEBUG follow ON — di chuyển chuột để kéo trail');
    }

    private _stopDebugFollow(fadeOut: boolean): void {
        const p = this._debugFollowParticle;
        this._debugFollowParticle = null;
        if (!p?.isValid) return;
        if (fadeOut) {
            this._beginParticleFadeOut(p);
        } else {
            this._destroyParticle(p);
        }
    }

    /** Screen (pixel) → world; dùng UI Camera hoặc Particle3DCamera. */
    private _screenToWorld(screenX: number, screenY: number, out: Vec3): boolean {
        const cam = this._sourceCamera ?? this._trailCamera;
        if (cam?.isValid) {
            this._debugScreenPos.set(screenX, screenY, 0);
            cam.screenToWorld(this._debugScreenPos, out);
            out.z = 0;
            return true;
        }
        const ut = this.node.getComponent(UITransform);
        if (!ut) return false;
        const local = ut.convertToNodeSpaceAR(new Vec3(screenX, screenY, 0));
        ut.convertToWorldSpaceAR(local, out);
        out.z = 0;
        return true;
    }

    /** Spin mới bắt đầu → return tất cả spine nodes về pool */
    private _onReelsStartSpin(): void {
        this._flyingCount = 0;
        this._returnAllSpawnedSpines();
        this._destroyAllParticles();
    }

    /** Return toàn bộ spine nodes đang active về pool */
    private _returnAllSpawnedSpines(): void {
        for (const entry of this._spawnedSpineNodes) {
            if (!entry) continue;
            const { spineNode, symbolNode } = entry;
            if (spineNode && spineNode.isValid) {
                if (symbolNode && symbolNode.isValid) {
                    const view = symbolNode.getComponent(SymbolView);
                    if (view) view.setSpriteVisible(true);
                }
                this._returnSpine(spineNode);
            }
        }
        this._spawnedSpineNodes.length = 0;
    }

    /** Return spine nodes clone cũ trên 1 symbolNode về pool trước khi spawn mới */
    private _cleanupSpineOnNode(symbolNode: Node): void {
        for (let i = this._spawnedSpineNodes.length - 1; i >= 0; i--) {
            const entry = this._spawnedSpineNodes[i];
            if (!entry) {
                this._spawnedSpineNodes.splice(i, 1);
                continue;
            }
            const { spineNode, symbolNode: origSym } = entry;
            if (!spineNode || !spineNode.isValid) {
                this._spawnedSpineNodes.splice(i, 1);
                continue;
            }
            if (origSym === symbolNode) {
                const view = symbolNode.getComponent(SymbolView);
                if (view) view.setSpriteVisible(true);
                this._returnSpine(spineNode);
                this._spawnedSpineNodes.splice(i, 1);
            }
        }
    }

    // ─── EVENT HANDLERS ──────────────────────────────────────────────────────────────────────

    /**
     * WILD_TRAIL_ONE: một reel dừng với Wild → bay con dơi đó vào hũ ngay lập tức.
     * Tăng _flyingCount, khi particle đến nơi giảm lại; nếu về 0 emit WILD_TRAIL_FLY_DONE.
     */
    private _releaseSpawnedSpine(spineNode: Node, symbolNode: Node): void {
        const idx = this._spawnedSpineNodes.findIndex(e => e?.spineNode === spineNode);
        if (idx >= 0) this._spawnedSpineNodes.splice(idx, 1);

        if (symbolNode?.isValid) {
            const view = symbolNode.getComponent(SymbolView);
            if (view) view.setSpriteVisible(true);
        }

        this._returnSpine(spineNode);
    }

    private _onWildTrailOne(payload: { reel: number; row: number }): void {
        const { reel, row } = payload;
        const nodeIdx    = 3 - row; // displayRow = 2 - gridRow, nodeIndex = 1 + displayRow
        const symbolNode = this.reels[reel]?.symbolNodes[nodeIdx];
        if (!symbolNode) return;

        const tryStart = () => {
            this._flyingCount++;
            // Hit & fly-done are now handled internally at particle landing time
            this._animateOne(symbolNode, reel, () => { /* no-op: kept for cleanup sync */ });
        };

        // Nếu reel chưa settled (đang decel/bounce), đợi 'reel-settled' rồi mới bắn trail.
        // Giảm hiện tượng thấy effect bay ra khi reel còn đang quay nhanh (đặc biệt Turbo).
        const reelCtrl = this.reels[reel];
        const isIdle = !!reelCtrl && (reelCtrl as any).isIdle === true;
        if (!isIdle) {
            symbolNode.once('reel-settled', () => {
                if (symbolNode && symbolNode.isValid) tryStart();
            });
        } else {
            tryStart();
        }
    }

    // ─── PRIVATE ───────────────────────────────────────────────────────────

    /**
     * Zoom nhẹ symbol node rồi spawn particle bay đến potNode.
     * Gọi onDone() khi cả win2 spine và particle đều đã xong.
     * win2 là one-shot: animation xong phải return spine về pool và bật lại sprite Wild.
     */
    /**
     * Hướng cong theo vị trí reel (world X): -1 = trái, +1 = phải.
     * Reel trái → trái, reel phải → phải, reel giữa → random.
     */
    private _resolveFlySide(reelIndex: number): number {
        const reelCount = this.reels.length > 0 ? this.reels.length : 5;
        const center = Math.floor(reelCount / 2); // 5 reel → 2
        if (reelIndex < center) return -1;
        if (reelIndex > center) return 1;
        return Math.random() < 0.5 ? -1 : 1;
    }

    private _animateOne(symbolNode: Node, reelIndex: number, onDone: () => void): void {
        let impactDone = !this.spinePrefab;
        let flyDone = false;
        let done = false;
        const tryDone = () => {
            if (done || !impactDone || !flyDone) return;
            done = true;
            onDone();
        };
        // Emit hit immediately at particle landing (do not wait for impact animation)
        const onLand = () => {
            EventBus.instance.emit(GameEvents.WILD_TRAIL_ONE_HIT);
            this._flyingCount--;
            if (this._flyingCount <= 0) {
                this._flyingCount = 0;
                EventBus.instance.emit(GameEvents.WILD_TRAIL_FLY_DONE);
            }
        };
        // 1. Clone spine prefab vào symbol node, play animation one-shot.
        if (this.spinePrefab) {
            const view = symbolNode.getComponent(SymbolView);
            if (view) view.setSpriteVisible(false);

            // Xóa spine cũ trên cùng symbol trước khi spawn mới
            this._cleanupSpineOnNode(symbolNode);

            const spineNode = this._borrowSpine();
            if (!spineNode) {
                if (view) view.setSpriteVisible(true);
                impactDone = true;
            }
            if (spineNode) {
                // Anchor win2 spine trực tiếp vào symbolNode để giữ trong mask của reel,
                // tránh cảm giác "bay ra sớm" khi các reel khác còn đang quay (đặc biệt ở Turbo).
                // Đặt sibling index cao nhất trong symbolNode để nằm trên sprite symbol.
                spineNode.setParent(symbolNode, false);
                spineNode.setSiblingIndex(symbolNode.children.length - 1);
                // Áp dụng offset Y giống SymbolHighlighter.spineLocalPosY cho Wild (nếu có set)
                let yOffset = 0;
                const hi = this._symbolHighlighter;
                if (hi && Array.isArray(hi.spineLocalPosY)) {
                    const v = hi.spineLocalPosY[SymbolId.WILD];
                    if (typeof v === 'number' && isFinite(v)) yOffset = v;
                }
                spineNode.setPosition(0, yOffset, 0);
                spineNode.active = true;
                this._spawnedSpineNodes.push({ spineNode, symbolNode });

                const skel = spineNode.getComponent(sp.Skeleton);
                if (skel) {
                    skel.timeScale = 1;
                    skel.clearTrack(0);
                    skel.setCompleteListener(null);
                    skel.setAnimation(0, this.wildTrailAnimName, false);
                    skel.setCompleteListener(() => {
                        if (!spineNode.isValid) return;
                        skel.setCompleteListener(null);
                        this._releaseSpawnedSpine(spineNode, symbolNode);
                        impactDone = true;
                        tryDone();
                    });
                } else {
                    // Không có skeleton → return pool, bật sprite lại
                    this._returnSpine(spineNode);
                    const idx = this._spawnedSpineNodes.findIndex(e => e?.spineNode === spineNode);
                    if (idx >= 0) this._spawnedSpineNodes.splice(idx, 1);
                    if (view) view.setSpriteVisible(true);
                    impactDone = true;
                }
            }
        } else {
            Log.w(`[WildTrail] spinePrefab chưa set — fallback to scale bounce on ${symbolNode.name}`);
            // Fallback: scale bounce nếu không có spine prefab
            const mul = this._getSpeedMultiplier();
            const baseScale = symbolNode.scale.clone();
            const s = baseScale.x;
            Tween.stopAllByTarget(symbolNode);
            tween(symbolNode)
                .to(0.25 * mul, { scale: new Vec3(s * 1.12, s * 1.12, 1) }, { easing: 'backOut' })
                .to(0.20 * mul, { scale: new Vec3(s * 0.95, s * 0.95, 1) }, { easing: 'sineInOut' })
                .to(0.15 * mul, { scale: baseScale },                       { easing: 'sineOut' })
                .call(() => {
                    impactDone = true;
                    tryDone();
                })
                .start();
        }

        // 2. Tạo particle và bay đến pot
        const speedMul = this._getSpeedMultiplier();
        if (!this.potNode) {
            // Không có potNode → chỉ zoom, coi như xong sau zoom
            this.scheduleOnce(() => {
                flyDone = true;
                // Consider as landed even without pot to keep flow consistent
                onLand();
                tryDone();
            }, 0.65 * speedMul);
            return;
        }

        const particle = this._spawnParticle();
        if (!particle) {
            this.scheduleOnce(() => {
                flyDone = true;
                onLand();
                tryDone();
            }, 0.65 * speedMul);
            return;
        }

        // Parent ra ngoài Canvas (Scene root) — tránh UI batcher / Canvas scale làm particle mờ/sai.
        this._attachParticleOutsideCanvas(particle);
        particle.active = true;
        this._activeParticles.add(particle);

        // Vị trí bắt đầu = world pos của symbol node
        const startWorld = new Vec3();
        symbolNode.getWorldPosition(startWorld);

        // Vị trí đích = world pos của potNode
        const endWorld = new Vec3();
        this.potNode.getWorldPosition(endWorld);

        // ── Cubic Bezier: luôn vòng RỘNG / XA (kể cả khi gần Pot) ──
        const dx = endWorld.x - startWorld.x;
        const dy = endWorld.y - startWorld.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Ép effectiveDist tối thiểu → gần Pot vẫn có vòng cung lớn, không bò đoạn ngắn.
        const minDist = Math.max(80, this.minFlyPathDistance);
        const effectiveDist = Math.max(dist, minDist);
        const nearFactor = dist < minDist ? (1 - dist / minDist) : 0; // 0 xa, 1 rất gần

        // Hướng start→pot (fallback lên nếu trùng vị trí)
        let ux = 0;
        let uy = 1;
        if (dist > 1e-3) {
            ux = dx / dist;
            uy = dy / dist;
        }
        // Pháp tuyến (vuông góc) để đẩy vòng sang trái/phải màn hình
        let nx = -uy;
        let ny = ux;
        const screenSide = this._resolveFlySide(reelIndex); // -1 trái, +1 phải
        const curve = Math.abs(this.flyCurvature);
        const offsetMag = effectiveDist * curve;
        let ox = nx * offsetMag;
        let oy = ny * offsetMag;
        if (ox * screenSide < 0) {
            ox = -ox;
            oy = -oy;
        }
        if (Math.abs(ox) < offsetMag * 0.25) {
            ox = screenSide * offsetMag;
            oy = 0;
        }

        // Gần Pot: CP1 đẩy NGƯỢC hướng pot (bay ra xa trước) rồi CP2 vòng về.
        // Xa Pot: CP1/CP2 dọc đường đi + offset bên như cũ.
        const along1 = effectiveDist * (0.25 - nearFactor * 0.7); // gần → âm = ra xa
        const along2 = effectiveDist * (0.55 + nearFactor * 0.15);
        const side1 = 1.25 + nearFactor * 0.35;
        const side2 = 1.05 + nearFactor * 0.25;

        const cp1X = startWorld.x + ux * along1 + ox * side1;
        const cp1Y = startWorld.y + uy * along1 + oy * side1;
        const cp2X = startWorld.x + ux * along2 + ox * side2;
        const cp2Y = startWorld.y + uy * along2 + oy * side2;

        // Lệch điểm xuất phát theo hướng cung — trail không dính sát Wild.
        const sideLen = Math.sqrt(ox * ox + oy * oy) || 1;
        const launchOff = Math.max(0, this.flyLaunchOffset);
        startWorld.x += (ox / sideLen) * launchOff;
        startWorld.y += (oy / sideLen) * launchOff;
        particle.setWorldPosition(startWorld);

        const proxy = { t: 0 };
        const pos = new Vec3();
        const updateParticlePos = (rawT: number) => {
            if (!particle || !particle.isValid) return;
            // Cùng đường Bezier cung rộng — tốc độ chậm → nhanh liên tục, tổng thời gian giữ nguyên.
            const t = this._easeFlyIn(rawT);
            const u = 1 - t;
            const uu = u * u;
            const tt = t * t;
            pos.x = uu * u * startWorld.x + 3 * uu * t * cp1X + 3 * u * tt * cp2X + tt * t * endWorld.x;
            pos.y = uu * u * startWorld.y + 3 * uu * t * cp1Y + 3 * u * tt * cp2Y + tt * t * endWorld.y;
            pos.z = 0;
            particle.setWorldPosition(pos);
        };

        const totalDur = this._getFlyDuration();
        // Delay seed trail nằm TRONG tổng thời gian — chạm Pot đúng 0.8 / 0.65 / 0.5.
        const launchDelay = Math.min(Math.max(0, this.flyLaunchDelay), totalDur * 0.25);
        const moveDur = Math.max(0.01, totalDur - launchDelay);

        // Play particle (next frame — processor sẵn) → delay ngắn để Trail seed → mới bay.
        this.scheduleOnce(() => {
            if (!particle.isValid) return;
            this._playParticlesFromStart(particle);
        }, 0);
        updateParticlePos(0);

        tween(proxy)
            .delay(launchDelay)
            .to(moveDur, { t: 1 }, {
                easing: 'linear',
                onUpdate: () => updateParticlePos(proxy.t),
            })
            .call(() => {
                // Chạm Pot → không ẩn ngay: dừng emit, để trail tàn dần rồi mới destroy.
                this._beginParticleFadeOut(particle);
                flyDone = true;
                onLand();
                tryDone();
            })
            .start();
    }

    /** easeIn trên toàn cung: chậm lúc bắn ra → nhanh dần khi về Pot (tổng thời gian giữ nguyên). */
    private _easeFlyIn(rawT: number): number {
        const u = Math.min(1, Math.max(0, rawT));
        // Mix linear + easeInCubic: khởi đầu chậm để trail hiện, tăng tốc lao về Pot.
        const easeIn = u * u * u;
        return u * 0.35 + easeIn * 0.65;
    }

    /**
     * Gắn particle bay lên Scene (sibling Canvas), không nằm trong Canvas hierarchy.
     * World position vẫn set sau đó từ symbol / pot / chuột.
     */
    private _attachParticleOutsideCanvas(particle: Node): void {
        const scene = this.node.scene;
        if (scene) {
            particle.setParent(scene, false);
        } else {
            this.node.addChild(particle);
        }
        particle.setScale(1, 1, 1);
    }

    /**
     * Tạo particle node:
     *   - Nếu có template → clone nó.
     *   - Nếu không → tạo node với Graphics vẽ hình tròn vàng (placeholder).
     */
    private _spawnParticle(): Node | null {
        if (this.particleTemplate) {
            const clone = instantiate(this.particleTemplate);
            clone.active = false;
            for (const ps of clone.getComponentsInChildren(ParticleSystem)) {
                if ('playOnAwake' in ps) {
                    (ps as unknown as { playOnAwake: boolean }).playOnAwake = false;
                }
                if ('prewarm' in ps) {
                    (ps as unknown as { prewarm: boolean }).prewarm = false;
                }
            }
            return clone;
        }

        // Placeholder: hình tròn vàng 18px radius bằng Graphics
        const node = new Node('WildParticle');
        const tf   = node.addComponent(UITransform);
        tf.setContentSize(36, 36);

        const g = node.addComponent(Graphics);
        g.fillColor = new Color(255, 220, 0, 230);
        g.circle(0, 0, 14);
        g.fill();

        // Viền nhỏ
        g.strokeColor = new Color(255, 255, 255, 180);
        g.lineWidth = 2;
        g.circle(0, 0, 14);
        g.stroke();

        return node;
    }

    /**
     * Kiểm tra xem node hoặc bất kỳ descendant nào còn sp.Skeleton active không.
     * Dùng để quyết định có bật sprite lại sau khi wild trail animation xong.
     */
    private _hasSpineOnNode(node: Node): boolean {
        if (node.getComponent(sp.Skeleton)) return true;
        for (const child of node.children) {
            if (this._hasSpineOnNode(child)) return true;
        }
        return false;
    }
}
