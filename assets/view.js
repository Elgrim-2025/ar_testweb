import * as THREE from 'https://threejsfundamentals.org/threejs/resources/threejs/r132/build/three.module.js';
import { OrbitControls } from 'https://threejsfundamentals.org/threejs/resources/threejs/r132/examples/jsm/controls/OrbitControls.js';
import { AlvaARConnectorTHREE } from './alva_ar_three.js';

// ==========================================
// 크로마키 셰이더
// ==========================================
const CHROMA_VERTEX = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CHROMA_FRAGMENT = `
uniform sampler2D tex;
uniform vec3 keyColor;
uniform float similarity;
uniform float smoothness;
uniform float spill;
varying vec2 vUv;

vec2 RGBtoUV(vec3 rgb) {
    return vec2(
        rgb.r * -0.169 + rgb.g * -0.331 + rgb.b * 0.5 + 0.5,
        rgb.r * 0.5 + rgb.g * -0.419 + rgb.b * -0.081 + 0.5
    );
}

vec4 ProcessChromaKey(vec2 texCoord) {
    vec4 rgba = texture2D(tex, texCoord);
    float chromaDist = distance(RGBtoUV(rgba.rgb), RGBtoUV(keyColor));
    float baseMask = chromaDist - similarity;
    float fullMask = pow(clamp(baseMask / smoothness, 0.0, 1.0), 1.5);
    rgba.a = fullMask;
    float spillVal = pow(clamp(baseMask / spill, 0.0, 1.0), 1.5);
    float desat = clamp(rgba.r * 0.2126 + rgba.g * 0.7152 + rgba.b * 0.0722, 0.0, 1.0);
    rgba.rgb = mix(vec3(desat), rgba.rgb, spillVal);
    return rgba;
}

void main() {
    gl_FragColor = ProcessChromaKey(vUv);
}`;

// ==========================================
// ARCamView (크로마키 비디오 + 터치)
// ==========================================
class ARCamView {
    constructor(container, width, height, x = 0, y = 0, z = -10, scale = 1.0) {
        this.applyPose = AlvaARConnectorTHREE.Initialize(THREE);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.setClearColor(0, 0);
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);

        this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
        this.camera.rotation.reorder('YXZ');
        this.camera.updateProjectionMatrix();

        // 크로마키 비디오 설정
        this.effectVideo = this._createVideo();
        this.videoTexture = new THREE.VideoTexture(this.effectVideo);
        this.videoTexture.minFilter = THREE.LinearFilter;
        this.videoTexture.magFilter = THREE.LinearFilter;

        this.chromakeyMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tex: { value: this.videoTexture },
                keyColor: { value: new THREE.Color(0x32A644) },
                similarity: { value: 0.095 },
                smoothness: { value: 0.082 },
                spill: { value: 0.214 }
            },
            vertexShader: CHROMA_VERTEX,
            fragmentShader: CHROMA_FRAGMENT,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false
        });

        this.object = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), this.chromakeyMaterial);
        this.object.scale.set(scale, scale, scale);
        this.object.position.set(x, y, z);
        this.object.visible = false;

        // 터치 컨트롤 설정값 (외부에서 조정 가능)
        this.MOVE_SENSITIVITY = 0.0017;  // 이동 감도 (낮을수록 느림)
        this.MIN_SCALE = 0.3;          // 핀치 줌 최소 스케일
        this.MAX_SCALE = 5.0;          // 핀치 줌 최대 스케일
        this.LONG_PRESS_TIME = 300;    // 롱프레스 시간 (ms)

        // 빌보드 설정
        this.billboardEnabled = true;  // 빌보드 활성화 여부
        this.billboardMode = 'spherical'; // 'spherical' | 'cylindrical'

        // 빌보드 계산용 벡터 (매 프레임 재생성 방지)
        this._billboardTarget = new THREE.Vector3();
        this._billboardUp = new THREE.Vector3(0, 1, 0);

        // ==========================================
        // 스케일 제한 및 가시성 보장 설정
        // ==========================================
        this.minAllowedScale = 0.1;       // 절대 최소 스케일
        this.maxAllowedScale = 10.0;      // 절대 최대 스케일
        this.minVisibleSize = 100;         // 화면상 최소 픽셀 크기
        this.distanceScaleEnabled = false; // 거리 기반 스케일 보정 활성화
        this.baseDistance = 10;           // 기준 거리 (이 거리에서 스케일 1.0)
        this.distanceScaleFactor = 0.5;   // 거리 스케일 보정 계수 (0~1, 높을수록 강하게 보정)

        // 계산용 캐시 벡터
        this._distanceVec = new THREE.Vector3();
        this._userScale = scale; // 사용자 설정 스케일 저장

        this.scene = new THREE.Scene();
        this.scene.add(new THREE.AmbientLight(0x808080));
        this.scene.add(new THREE.HemisphereLight(0x404040, 0xf0f0f0, 1));
        this.scene.add(this.camera);
        this.scene.add(this.object);

        container.appendChild(this.renderer.domElement);
        this._setupTouch();
        this._render();
    }

    _createVideo() {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.src = './assets/greenscreen.mp4';
        v.addEventListener('error', () => this._createTestPattern());
        v.load();
        return v;
    }

    _createTestPattern() {
        const c = document.createElement('canvas');
        c.width = c.height = 512;
        const ctx = c.getContext('2d');
        const tex = new THREE.CanvasTexture(c);
        const draw = () => {
            ctx.fillStyle = '#32A644';
            ctx.fillRect(0, 0, 512, 512);
            const t = Date.now() * 0.002;
            ctx.fillStyle = '#ff4757';
            ctx.beginPath();
            ctx.arc(256 + Math.sin(t) * 80, 256 + Math.cos(t * 0.7) * 60, 100, 0, Math.PI * 2);
            ctx.fill();
            tex.needsUpdate = true;
            requestAnimationFrame(draw);
        };
        this.chromakeyMaterial.uniforms.tex.value = tex;
        draw();
    }

    _setupTouch() {
        const canvas = this.renderer.domElement;
        const raycaster = new THREE.Raycaster();
        let isDrag = false, isPinch = false, isLongPress = false;
        let longTimer = null, selected = null;
        let startPos = { x: 0, y: 0 }, initPinchDist = 0, initScale = 1;

        const ndc = (t) => {
            const r = canvas.getBoundingClientRect();
            return new THREE.Vector2(((t.clientX - r.left) / r.width) * 2 - 1, -((t.clientY - r.top) / r.height) * 2 + 1);
        };
        const pinchDist = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
        const hit = (n) => { raycaster.setFromCamera(n, this.camera); const i = raycaster.intersectObject(this.object); return i.length ? i[0] : null; };

        canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const ts = e.targetTouches;
            if (ts.length === 2) {
                clearTimeout(longTimer); isLongPress = isDrag = false; isPinch = true;
                initPinchDist = pinchDist(ts); initScale = this.object.scale.x;
            } else if (ts.length === 1) {
                startPos = { x: ts[0].clientX, y: ts[0].clientY };
                if (hit(ndc(ts[0]))) {
                    selected = this.object;
                    longTimer = setTimeout(() => { isLongPress = isDrag = true; navigator.vibrate?.(50); }, this.LONG_PRESS_TIME);
                }
            }
        }, { passive: false });

        canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const ts = e.targetTouches;
            if (isPinch && ts.length === 2) {
                const d = pinchDist(ts);
                const rawScale = initScale * (d / initPinchDist);
                // 핀치 줌 범위 제한 후 절대 스케일 제한 적용
                const clampedScale = Math.max(this.MIN_SCALE, Math.min(this.MAX_SCALE, rawScale));
                this._userScale = clampedScale; // 사용자 의도 저장
                this.enforceScaleLimits(clampedScale);
            } else if (isDrag && ts.length === 1 && selected) {
                const dx = ts[0].clientX - startPos.x, dy = ts[0].clientY - startPos.y;
                const depth = (this.camera.position.z - selected.position.z) * this.MOVE_SENSITIVITY;
                selected.position.x += dx * depth;
                selected.position.y -= dy * depth;
                startPos = { x: ts[0].clientX, y: ts[0].clientY };
            }
        }, { passive: false });

        canvas.addEventListener('touchend', (e) => {
            e.preventDefault(); clearTimeout(longTimer);
            if (e.targetTouches.length === 0) { isDrag = isPinch = isLongPress = false; selected = null; }
        }, { passive: false });

        // Mouse support
        let mouseDown = false;
        canvas.addEventListener('mousedown', (e) => {
            const n = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
            if (hit(n)) { mouseDown = true; selected = this.object; startPos = { x: e.clientX, y: e.clientY }; }
        });
        canvas.addEventListener('mousemove', (e) => {
            if (!mouseDown || !selected) return;
            const dx = e.clientX - startPos.x, dy = e.clientY - startPos.y;
            const depth = (this.camera.position.z - selected.position.z) * this.MOVE_SENSITIVITY;
            selected.position.x += dx * depth; selected.position.y -= dy * depth;
            startPos = { x: e.clientX, y: e.clientY };
        });
        canvas.addEventListener('mouseup', () => { mouseDown = false; selected = null; });
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rawScale = this.object.scale.x * (e.deltaY > 0 ? 0.9 : 1.1);
            const clampedScale = Math.max(this.MIN_SCALE, Math.min(this.MAX_SCALE, rawScale));
            this._userScale = clampedScale;
            this.enforceScaleLimits(clampedScale);
        }, { passive: false });
    }

    _render() {
        requestAnimationFrame(this._render.bind(this));

        // 빌보드 업데이트
        if (this.billboardEnabled && this.object.visible) {
            this._updateBillboard();
        }

        // 가시성 보장 (거리 기반 스케일 보정)
        if (this.object.visible && this.distanceScaleEnabled) {
            this.ensureMinimumVisibility();
        }

        if (this.effectVideo && !this.effectVideo.paused) this.videoTexture.needsUpdate = true;
        this.renderer.render(this.scene, this.camera);
    }

    // ==========================================
    // 빌보드 기능
    // ==========================================
    _updateBillboard() {
        if (this.billboardMode === 'spherical') {
            this._sphericalBillboard();
        } else {
            this._cylindricalBillboard();
        }
    }

    // 구형 빌보드: 모든 축에서 카메라를 완전히 추적
    _sphericalBillboard() {
        // 카메라 위치를 바라보도록 설정
        this._billboardTarget.copy(this.camera.position);
        this.object.lookAt(this._billboardTarget);

        // PlaneGeometry는 기본적으로 -Z를 향하므로 뒤집힘 보정 불필요
        // lookAt은 +Z가 타겟을 향하게 하므로 Plane 앞면이 카메라를 향함
    }

    // 원통형 빌보드: Y축 회전만 (수직 유지, 뒤집힘 방지)
    _cylindricalBillboard() {
        // Y축만 회전하도록 타겟의 Y를 오브젝트와 동일하게 설정
        this._billboardTarget.set(
            this.camera.position.x,
            this.object.position.y,  // Y 고정
            this.camera.position.z
        );
        this.object.lookAt(this._billboardTarget);
    }

    // 빌보드 모드 설정 메서드
    setBillboardMode(mode) {
        if (mode === 'spherical' || mode === 'cylindrical' || mode === 'none') {
            this.billboardMode = mode;
            this.billboardEnabled = (mode !== 'none');
        }
    }

    // ==========================================
    // 스케일 제한 및 가시성 보장
    // ==========================================

    // 스케일 클램핑 (최소/최대 강제)
    enforceScaleLimits(scale = null) {
        if (scale === null) {
            scale = this.object.scale.x;
        }

        const clampedScale = THREE.MathUtils.clamp(
            scale,
            this.minAllowedScale,
            this.maxAllowedScale
        );

        this.object.scale.set(clampedScale, clampedScale, clampedScale);
        return clampedScale;
    }

    // 카메라와 개체 간 거리 계산
    getDistanceToCamera() {
        this._distanceVec.copy(this.object.position).sub(this.camera.position);
        return this._distanceVec.length();
    }

    // 거리 기반 스케일 보정 (멀어지면 커지게)
    applyDistanceScaleCompensation() {
        if (!this.distanceScaleEnabled) return;

        const distance = this.getDistanceToCamera();

        // 기준 거리 대비 비율 계산
        const distanceRatio = distance / this.baseDistance;

        // 보정 계수 적용 (lerp로 부드럽게)
        const compensation = 1 + (distanceRatio - 1) * this.distanceScaleFactor;

        // 현재 사용자 설정 스케일에 보정 적용
        const baseScale = this._userScale || 1.0;
        const compensatedScale = baseScale * Math.max(0.5, compensation);

        this.enforceScaleLimits(compensatedScale);
    }

    // 화면상 픽셀 크기 기반 가시성 보장
    ensureMinimumVisibility() {
        const distance = this.getDistanceToCamera();

        // 화면상 예상 크기 계산 (근사치)
        const fov = this.camera.fov * (Math.PI / 180);
        const screenHeight = this.renderer.domElement.height;
        const objectWorldSize = this.object.scale.x * 3; // PlaneGeometry 기본 크기 3

        // 화면상 픽셀 크기 = (오브젝트 크기 / 거리) * (화면높이 / 2 / tan(fov/2))
        const projectedSize = (objectWorldSize / distance) * (screenHeight / (2 * Math.tan(fov / 2)));

        // 최소 픽셀 크기보다 작으면 스케일 조정
        if (projectedSize < this.minVisibleSize) {
            const requiredScale = (this.minVisibleSize / projectedSize) * this.object.scale.x;
            this.enforceScaleLimits(requiredScale);
        }
    }

    // 스케일 직접 설정 (사용자 의도 저장)
    setScale(scale) {
        this._userScale = THREE.MathUtils.clamp(scale, this.MIN_SCALE, this.MAX_SCALE);
        this.enforceScaleLimits(this._userScale);
    }

    // 초기 스케일로 리셋
    resetScale() {
        this._userScale = 1.0;
        this.object.scale.set(1, 1, 1);
    }

    playVideo() { this.effectVideo?.play().catch(console.error); }
    pauseVideo() { this.effectVideo?.pause(); }
    toggleVideo() { this.effectVideo?.paused ? this.playVideo() : this.pauseVideo(); }

    updateCameraPose(pose) {
        this.applyPose(pose, this.camera.quaternion, this.camera.position);
        this.object.visible = true;
        if (this.effectVideo?.paused) this.playVideo();
    }

    lostCamera() { this.object.visible = false; }
}

// ==========================================
// ARCamIMUView (기존 유지)
// ==========================================
class ARCamIMUView {
    constructor(container, width, height) {
        this.applyPose = AlvaARConnectorTHREE.Initialize(THREE);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.setClearColor(0, 0);
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 1000);
        this.raycaster = new THREE.Raycaster();
        this.ground = new THREE.Mesh(new THREE.CircleGeometry(1000, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: true, opacity: 0.1, side: THREE.DoubleSide }));
        this.ground.rotation.x = Math.PI / 2;
        this.ground.position.y = -10;
        this.scene = new THREE.Scene();
        this.scene.add(new THREE.AmbientLight(0x808080));
        this.scene.add(new THREE.HemisphereLight(0x404040, 0xf0f0f0, 1));
        this.scene.add(this.ground);
        this.scene.add(this.camera);
        container.appendChild(this.renderer.domElement);
        const render = () => { requestAnimationFrame(render); this.renderer.render(this.scene, this.camera); };
        render();
    }
    updateCameraPose(pose) {
        this.applyPose(pose, this.camera.quaternion, this.camera.position);
        this.ground.position.x = this.camera.position.x;
        this.ground.position.z = this.camera.position.z;
        this.scene.children.forEach(obj => obj.visible = true);
    }
    lostCamera() { this.scene.children.forEach(obj => obj.visible = false); }
    addObjectAt(x, y, scale = 1.0) {
        const el = this.renderer.domElement;
        const coord = new THREE.Vector2((x / el.offsetWidth) * 2 - 1, -(y / el.offsetHeight) * 2 + 1);
        this.raycaster.setFromCamera(coord, this.camera);
        const intersections = this.raycaster.intersectObjects([this.ground]);
        if (intersections.length > 0) {
            const point = intersections[0].point;
            const object = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshNormalMaterial({ flatShading: true }));
            object.scale.set(scale, scale, scale);
            object.position.copy(point);
            object.custom = true;
            this.scene.add(object);
        }
    }
    reset() { this.scene.children.filter(o => o.custom).forEach(o => this.scene.remove(o)); }
}

// ==========================================
// ARSimpleView, ARSimpleMap, Marker 클래스들
// ==========================================
class ARSimpleView {
    constructor(container, width, height, mapView = null) {
        this.applyPose = AlvaARConnectorTHREE.Initialize(THREE);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.setClearColor(0, 0);
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
        this.camera.rotation.reorder('YXZ');
        this.camera.updateProjectionMatrix();
        this.scene = new THREE.Scene();
        this.scene.add(new THREE.AmbientLight(0x808080));
        this.scene.add(new THREE.HemisphereLight(0x404040, 0xf0f0f0, 1));
        this.scene.add(this.camera);
        this.body = document.body;
        container.appendChild(this.renderer.domElement);
        if (mapView) { this.mapView = mapView; this.mapView.camHelper = new THREE.CameraHelper(this.camera); this.mapView.scene.add(this.mapView.camHelper); }
    }
    updateCameraPose(pose) { this.applyPose(pose, this.camera.quaternion, this.camera.position); this.renderer.render(this.scene, this.camera); this.body.classList.add("tracking"); }
    lostCamera() { this.body.classList.remove("tracking"); }
    createObjectWithPose(pose, scale = 1.0) {
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(scale, scale), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.1 }));
        scale *= 0.25;
        const cube = new THREE.Mesh(new THREE.BoxGeometry(scale, scale, scale), new THREE.MeshNormalMaterial({ flatShading: true }));
        cube.position.z = scale * 0.5;
        plane.add(cube);
        plane.custom = true;
        this.applyPose(pose, plane.quaternion, plane.position);
        this.scene.add(plane);
        if (this.mapView) this.mapView.scene.add(plane.clone());
    }
    reset() { this.scene.children.filter(o => o.custom).forEach(o => this.scene.remove(o)); if (this.mapView) this.mapView.scene.children.filter(o => o.custom).forEach(o => this.mapView.scene.remove(o)); }
}

class ARSimpleMap {
    constructor(container, width, height) {
        this.renderer = new THREE.WebGLRenderer({ antialias: false });
        this.renderer.setClearColor(new THREE.Color('rgb(255,255,255)'));
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height, false);
        this.renderer.domElement.style.width = width + 'px';
        this.renderer.domElement.style.height = height + 'px';
        this.camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
        this.camera.position.set(-1, 2, 2);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.1;
        this.gridHelper = new THREE.GridHelper(150, 100);
        this.gridHelper.position.y = -1;
        this.axisHelper = new THREE.AxesHelper(0.25);
        this.scene = new THREE.Scene();
        this.scene.add(new THREE.AmbientLight(0xefefef));
        this.scene.add(new THREE.HemisphereLight(0x404040, 0xf0f0f0, 1));
        this.scene.add(this.gridHelper);
        this.scene.add(this.axisHelper);
        container.appendChild(this.renderer.domElement);
        const render = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(render); };
        render();
    }
}

class ARCamMarkerView {
    constructor(container, width, height) {
        this.applyPose = AlvaARConnectorTHREE.Initialize(THREE);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.setClearColor(0, 0);
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
        this.camera.rotation.reorder('YXZ');
        this.camera.updateProjectionMatrix();
        this.raycaster = new THREE.Raycaster();
        this.ground = new THREE.Mesh(new THREE.CircleGeometry(1000, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, side: THREE.DoubleSide }));
        this.ground.rotation.x = Math.PI / 2;
        this.ground.position.y = -10;
        this.marker = this._createMarker();
        this.currentObject = null;
        this.scene = new THREE.Scene();
        this.scene.add(new THREE.AmbientLight(0x808080));
        this.scene.add(new THREE.HemisphereLight(0x404040, 0xf0f0f0, 1));
        this.scene.add(this.ground);
        this.scene.add(this.marker);
        this.scene.add(this.camera);
        container.appendChild(this.renderer.domElement);
        const render = () => { requestAnimationFrame(render); this.renderer.render(this.scene, this.camera); };
        render();
    }
    _createMarker() {
        const g = new THREE.Group();
        const c = new THREE.Mesh(new THREE.CircleGeometry(0.3, 32), new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthTest: false }));
        c.rotation.x = -Math.PI / 2;
        const pts = [-0.25, 0, 0, 0.25, 0, 0, 0, 0, -0.25, 0, 0, 0.25];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const cross = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
        g.add(c); g.add(cross); g.visible = false;
        return g;
    }
    updateCameraPose(pose) {
        this.applyPose(pose, this.camera.quaternion, this.camera.position);
        this.ground.position.x = this.camera.position.x;
        this.ground.position.z = this.camera.position.z;
        this._updateMarker();
    }
    _updateMarker() {
        this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
        const i = this.raycaster.intersectObjects([this.ground]);
        if (i.length) { this.marker.position.copy(i[0].point); this.marker.visible = true; }
        else this.marker.visible = false;
    }
    placeObjectAtMarker() {
        if (!this.marker.visible) return;
        if (this.currentObject) this.scene.remove(this.currentObject);
        const o = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshNormalMaterial({ flatShading: true }));
        o.scale.set(0.5, 0.5, 0.5);
        o.position.copy(this.marker.position);
        this.scene.add(o);
        this.currentObject = o;
    }
    lostCamera() { this.marker.visible = false; if (this.currentObject) this.currentObject.visible = false; }
}

class ARCamMarkerIMUView extends ARCamMarkerView {
    constructor(container, width, height) {
        super(container, width, height);
        this.camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 1000);
    }
    lostCamera() { this.scene.children.forEach(o => o.visible = false); }
}

export { ARCamView, ARCamIMUView, ARSimpleView, ARSimpleMap, ARCamMarkerView, ARCamMarkerIMUView };