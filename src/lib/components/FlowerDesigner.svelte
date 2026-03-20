<script lang="ts">
    import type { Session, User } from "@supabase/supabase-js";
    import { onDestroy, onMount } from "svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import { STLLoader } from "three/examples/jsm/loaders/STLLoader";
    import { exportTo3MF } from "three-3mf-exporter";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import baseStlUrl from "$lib/assets/stl/flower/base.stl?url";
    import topStlUrl from "$lib/assets/stl/flower/top.stl?url";
    import FontSelect from "$lib/components/FontSelect.svelte";
    import {
        centerGeometryXY,
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        frameCameraToObject,
        getFont,
    } from "$lib/utils-3d";
    import { notifyExportEvent } from "$lib/exportNotify";
    import DesignerExportToolbar from "./DesignerExportToolbar.svelte";
    import { Button } from '$lib/components/ui/button';
    import { Slider } from '$lib/components/ui/slider';
    import ColorPalettePicker from './ColorPalettePicker.svelte';
    import type { PaletteColor } from '$lib/colorPalette';
    import type { SubscriptionStatus } from "$lib/subscription";

    // ── Props ───────────────────────────────────────────────────────────────
    interface Props {
        user: User | null;
        session: Session | null;
        subscriptionStatus: SubscriptionStatus | null;
        palette: PaletteColor[];
        onBack: () => void;
        onRequestLogin: () => void;
        onShowThankYou: () => void;
        onShowPricing?: () => void;
    }
    let {
        user,
        session,
        subscriptionStatus,
        palette,
        onBack,
        onRequestLogin,
        onShowThankYou,
        onShowPricing,
    }: Props = $props();

    // ── Storage keys ────────────────────────────────────────────────────────
    const STORAGE_KEY = "keychain-flower-settings";

    /** Top base sunk into bottom base so they overlap (avoids non-manifold at contact in STL). */
    const FLOWER_TOP_BASE_EMBED = 0.05;

    // ── Load persisted settings ─────────────────────────────────────────────
    interface FlowerSettings {
        baseDepth: number;
        baseColor: string;
        topDepth: number;
        topColor: string;
        char: string;
        charColor: string;
        charDepth: number;
        charSize: number;
        charFontKey: string;
        textOffsetX: number;
        textOffsetY: number;
    }

    // Fixed origin positions for the two text meshes
    const TEXT1_ORIGIN_X = -26;
    const TEXT2_ORIGIN_X = 26;
    const TEXT_ORIGIN_Y = 0;

    const defaults: FlowerSettings = {
        baseDepth: 1,
        baseColor: "#ec4899",
        topDepth: 1,
        topColor: "#ffffff",
        char: "A",
        charColor: "#ec4899",
        charDepth: 1,
        charSize: 21,
        charFontKey: "Titan One_Regular",
        textOffsetX: 0,
        textOffsetY: 0,
    };

    function loadSettings(): FlowerSettings {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed && typeof parsed === "object") {
                    return { ...defaults, ...parsed };
                }
            }
        } catch {}
        return { ...defaults };
    }

    const initial = loadSettings();

    // ── Reactive state ──────────────────────────────────────────────────────
    let baseDepth = $state(initial.baseDepth);
    let baseColor = $state(initial.baseColor);
    let topDepth = $state(initial.topDepth);
    let topColor = $state(initial.topColor);
    let char = $state(initial.char);
    let charColor = $state(initial.charColor);
    let charDepth = $state(initial.charDepth);
    let charSize = $state(initial.charSize);
    let charFontKey = $state(initial.charFontKey);
    let textOffsetX = $state(initial.textOffsetX);
    let textOffsetY = $state(initial.textOffsetY);

    // ── Three.js state ──────────────────────────────────────────────────────
    let hostEl: HTMLDivElement | null = null;
    let renderer: any = null;
    let scene: any = null;
    let camera: any = null;
    let controls: any = null;
    let group: any = null;
    let keyLight: any = null;
    let rafId = 0;
    let ro: ResizeObserver | null = null;
    let didInitFrame = false;

    // Loaded geometries (cached)
    let baseGeometry: THREE.BufferGeometry | null = null;
    let topGeometry: THREE.BufferGeometry | null = null;

    // ── Helpers ─────────────────────────────────────────────────────────────
    function resize() {
        if (!renderer || !camera || !hostEl) return;
        const rect = hostEl.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        renderer.setSize(width, height, true);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }

    function saveSettings() {
        try {
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({
                    baseDepth,
                    baseColor,
                    topDepth,
                    topColor,
                    char,
                    charColor,
                    charDepth,
                    charSize,
                    charFontKey,
                    textOffsetX,
                    textOffsetY,
                }),
            );
        } catch {}
    }

    function centerAndNormalize(geo: THREE.BufferGeometry) {
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        const cx = (bb.min.x + bb.max.x) / 2;
        const cy = (bb.min.y + bb.max.y) / 2;
        const cz = bb.min.z; // move bottom to z=0
        geo.translate(-cx, -cy, -cz);
        geo.computeBoundingBox();
    }

    function scaleGeometryToDepth(
        srcGeo: THREE.BufferGeometry,
        targetDepth: number,
    ): THREE.BufferGeometry {
        const geo = srcGeo.clone();
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        const currentDepth = bb.max.z - bb.min.z;
        if (currentDepth > 0.001) {
            const scale = Math.max(0.01, targetDepth) / currentDepth;
            // Scale only Z axis to match target depth
            geo.scale(1, 1, scale);
        }
        geo.computeBoundingBox();
        return geo;
    }

    function rebuildMeshes() {
        if (!scene || !group || !baseGeometry || !topGeometry) return;
        disposeObject3D(group);
        group.clear();
        group.position.set(0, 0, 0);

        const baseMat = new THREE.MeshStandardMaterial({
            color: baseColor,
            roughness: 0.85,
            metalness: 0.05,
        });
        const topMat = new THREE.MeshStandardMaterial({
            color: topColor,
            roughness: 0.35,
            metalness: 0.1,
        });

        // Scale base geometry to target depth
        const scaledBaseGeo = scaleGeometryToDepth(baseGeometry, baseDepth);
        const baseMesh = new THREE.Mesh(scaledBaseGeo, baseMat);
        baseMesh.castShadow = true;
        baseMesh.receiveShadow = true;
        baseMesh.position.z = 0;
        group.add(baseMesh);

        // Scale top geometry to target depth, place on top of base
        const scaledTopGeo = scaleGeometryToDepth(topGeometry, topDepth);
        const topMesh = new THREE.Mesh(scaledTopGeo, topMat);
        topMesh.castShadow = true;
        topMesh.receiveShadow = true;
        topMesh.position.z = Math.max(0.01, baseDepth) - FLOWER_TOP_BASE_EMBED;
        group.add(topMesh);

        // ── Text meshes on top of flower ─────────────────────────────────
        const charToRender = char.trim().slice(0, 1);
        if (charToRender) {
            const font = getFont(charFontKey);
            if (font) {
                const shapes = font.generateShapes(charToRender, charSize);
                if (shapes.length > 0) {
                    const charGeo = new THREE.ExtrudeGeometry(shapes, {
                        depth: Math.max(0.01, charDepth),
                        bevelEnabled: false,
                    });
                    centerGeometryXY(charGeo);

                    const charMat = new THREE.MeshStandardMaterial({
                        color: charColor,
                        roughness: 0.35,
                        metalness: 0.1,
                    });

                    const textZ =
                        Math.max(0.01, baseDepth) -
                        FLOWER_TOP_BASE_EMBED +
                        Math.max(0.01, topDepth) +
                        0.01;

                    const textMesh1 = new THREE.Mesh(charGeo, charMat);
                    textMesh1.castShadow = true;
                    textMesh1.receiveShadow = true;
                    textMesh1.position.set(
                        TEXT1_ORIGIN_X + textOffsetX,
                        TEXT_ORIGIN_Y + textOffsetY,
                        textZ,
                    );
                    group.add(textMesh1);

                    const textMesh2 = new THREE.Mesh(charGeo, charMat);
                    textMesh2.castShadow = true;
                    textMesh2.receiveShadow = true;
                    textMesh2.position.set(
                        TEXT2_ORIGIN_X + textOffsetX,
                        TEXT_ORIGIN_Y + textOffsetY,
                        textZ,
                    );
                    group.add(textMesh2);
                }
            }
        }

        // Shadow camera
        group.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(group);
        if (keyLight?.shadow?.camera) {
            const sizeVec = new THREE.Vector3();
            box.getSize(sizeVec);
            const center = new THREE.Vector3();
            box.getCenter(center);
            const r = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 0.75 + 10;
            const cam = keyLight.shadow.camera;
            cam.left = -r;
            cam.right = r;
            cam.top = r;
            cam.bottom = -r;
            cam.near = 0.1;
            cam.far = Math.max(300, r * 6);
            cam.updateProjectionMatrix?.();
            keyLight.target.position.copy(center);
            keyLight.target.updateWorldMatrix?.(true, true);
        }
        if (!didInitFrame) {
            frameCameraToObject(box, camera, controls);
            didInitFrame = true;
        }
    }

    // ── Export ───────────────────────────────────────────────────────────────
    async function exportSTL() {
        if (!group || !scene) return;
        if (!user) {
            onRequestLogin();
            return;
        }

        rebuildMeshes();
        group.updateWorldMatrix(true, true);
        const geometries: THREE.BufferGeometry[] = [];
        for (let i = 0; i < group.children.length; i++) {
            const child = group.children[i];
            if (child && (child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                const geo = mesh.geometry
                    .clone()
                    .applyMatrix4(mesh.matrixWorld);
                if (geo.attributes.uv) geo.deleteAttribute("uv");
                geometries.push(geo);
            }
        }
        if (geometries.length === 0) return;
        const merged = BufferGeometryUtils.mergeGeometries(geometries);
        if (!merged) return;
        geometries.forEach((g) => g.dispose());
        const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
        merged.dispose();
        const singleMesh = new THREE.Mesh(welded);
        const exporter = new STLExporter();
        const result = exporter.parse(singleMesh, { binary: true });
        welded.dispose();
        const buffer = result instanceof DataView ? result.buffer : result;
        if (buffer && buffer.byteLength >= 84) {
            const blob = new Blob([buffer], { type: "model/stl" });
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(`flower-${timestamp}.stl`, blob);
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Flower + Initial",
                format: "stl"
            });
        }
        onShowThankYou();
    }

    async function export3MF() {
        if (!group || !scene) return;
        if (!user) {
            onRequestLogin();
            return;
        }

        rebuildMeshes();
        group.updateWorldMatrix(true, true);
        const exportGroup = new THREE.Group();
        const meshes = group.children.filter(
            (c: THREE.Object3D) => (c as THREE.Mesh).isMesh,
        ) as THREE.Mesh[];
        if (meshes.length === 0) return;
        const geoWorld = (m: THREE.Mesh) =>
            m.geometry.clone().applyMatrix4(m.matrixWorld);
        const getColor = (m: THREE.Mesh) => {
            const mat = (Array.isArray(m.material)
                ? m.material[0]
                : m.material) as THREE.MeshStandardMaterial;
            return mat?.color != null
                ? mat.color.clone()
                : new THREE.Color(0xffffff);
        };
        if (meshes.length >= 1) {
            exportGroup.add(
                new THREE.Mesh(
                    geoWorld(meshes[0]),
                    new THREE.MeshBasicMaterial({ color: getColor(meshes[0]) }),
                ),
            );
        }
        if (meshes.length >= 2) {
            exportGroup.add(
                new THREE.Mesh(
                    geoWorld(meshes[1]),
                    new THREE.MeshBasicMaterial({ color: getColor(meshes[1]) }),
                ),
            );
        }
        if (meshes.length > 2) {
            const textGeos = meshes.slice(2).map(geoWorld);
            const mergedText =
                textGeos.length === 1
                    ? textGeos[0]
                    : BufferGeometryUtils.mergeGeometries(textGeos);
            if (mergedText) {
                if (textGeos.length > 1) {
                    textGeos.forEach((g) => g.dispose());
                }
                exportGroup.add(
                    new THREE.Mesh(
                        BufferGeometryUtils.mergeVertices(mergedText, 1e-3),
                        new THREE.MeshBasicMaterial({
                            color: new THREE.Color(charColor),
                        }),
                    ),
                );
            }
        }
        if (exportGroup.children.length === 0) return;
        exportGroup.updateWorldMatrix(true, true);
        const blob = await exportTo3MF(exportGroup);
        if (!blob || blob.size === 0) return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(`flower-${timestamp}.3mf`, blob);
        notifyExportEvent({
            email: user?.email,
            name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
            subscriptionStatus,
            designName: "Flower + Initial",
            format: "3mf"
        });
        onShowThankYou();
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    onMount(() => {
        if (!hostEl) return;

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xffffff);
        camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
        camera.up.set(0, 0, 1);
        renderer = new THREE.WebGLRenderer({
            antialias: true,
            preserveDrawingBuffer: true,
        });
        renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        hostEl.appendChild(renderer.domElement);
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        renderer.domElement.style.display = "block";
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.screenSpacePanning = false;
        controls.minDistance = 10;
        controls.maxDistance = 500;
        controls.update();
        const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.25);
        scene.add(hemi);
        keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
        keyLight.position.set(80, -120, 140);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.width = 2048;
        keyLight.shadow.mapSize.height = 2048;
        keyLight.shadow.bias = -0.0002;
        keyLight.shadow.normalBias = 0.02;
        scene.add(keyLight);
        scene.add(keyLight.target);
        const rim = new THREE.DirectionalLight(0xffffff, 0.7);
        rim.position.set(-120, 90, 80);
        scene.add(rim);
        const fill = new THREE.DirectionalLight(0xffffff, 0.45);
        fill.position.set(40, 120, 60);
        scene.add(fill);
        const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
        grid.rotation.x = Math.PI / 2;
        grid.position.z = -0.01;
        scene.add(grid);
        const shadowPlane = new THREE.Mesh(
            new THREE.PlaneGeometry(800, 800),
            new THREE.ShadowMaterial({ opacity: 0.18 }),
        );
        shadowPlane.position.z = -0.015;
        shadowPlane.receiveShadow = true;
        scene.add(shadowPlane);
        group = new THREE.Group();
        scene.add(group);
        ro = new ResizeObserver(() => resize());
        ro.observe(hostEl);
        resize();

        // Load STL files
        const loader = new STLLoader();
        let loadedCount = 0;
        const onBothLoaded = () => {
            loadedCount++;
            if (loadedCount === 2) rebuildMeshes();
        };

        loader.load(baseStlUrl, (geometry: THREE.BufferGeometry) => {
            centerAndNormalize(geometry);
            baseGeometry = geometry;
            onBothLoaded();
        });
        loader.load(topStlUrl, (geometry: THREE.BufferGeometry) => {
            centerAndNormalize(geometry);
            topGeometry = geometry;
            onBothLoaded();
        });

        const tick = () => {
            rafId = requestAnimationFrame(tick);
            controls?.update();
            renderer?.render(scene!, camera!);
        };
        tick();

        return () => {
            ro?.disconnect();
            ro = null;
        };
    });

    // ── Effects ─────────────────────────────────────────────────────────────

    // Save settings on change
    $effect(() => {
        void baseDepth;
        void baseColor;
        void topDepth;
        void topColor;
        void char;
        void charColor;
        void charDepth;
        void charSize;
        void charFontKey;
        void textOffsetX;
        void textOffsetY;
        saveSettings();
    });

    // Rebuild meshes on change
    $effect(() => {
        void baseDepth;
        void baseColor;
        void topDepth;
        void topColor;
        void char;
        void charColor;
        void charDepth;
        void charSize;
        void charFontKey;
        void textOffsetX;
        void textOffsetY;
        if (!scene || !baseGeometry || !topGeometry) return;
        rebuildMeshes();
    });

    onDestroy(() => {
        cancelAnimationFrame(rafId);
        rafId = 0;
        ro?.disconnect();
        ro = null;
        if (group) {
            disposeObject3D(group);
            group.clear();
        }
        baseGeometry?.dispose();
        topGeometry?.dispose();
        baseGeometry = null;
        topGeometry = null;
        controls?.dispose();
        controls = null;
        if (renderer && hostEl && renderer.domElement.parentElement === hostEl)
            hostEl.removeChild(renderer.domElement);
        renderer?.dispose();
        renderer = null;
        scene = null;
        camera = null;
        group = null;
    });
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
    <div
        class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
        <aside
            class="flex min-h-0 w-full max-w-[360px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]">
            <div class="flex shrink-0 items-center justify-between p-4">
                <h1 class="text-lg font-semibold tracking-tight text-slate-900">
                    Flower & Initial
                </h1>
                <Button variant="outline" size="sm" onclick={onBack}>
                    Back
                </Button>
            </div>

            <div
                class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
                <!-- Text controls -->
                <div
                    class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                    <div
                        class="text-xs font-semibold tracking-tight text-slate-700">
                        Text
                    </div>

                    <!-- Char input -->
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Char</span>
                        <input
                            class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            type="text"
                            maxlength={1}
                            bind:value={char} />
                    </label>

                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Font</span>
                        <FontSelect bind:value={charFontKey} />
                    </label>

                    <!-- Size slider -->
                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Size</span>
                            <span class="text-xs tabular-nums text-slate-600"
                                >{charSize}</span>
                        </div>
                        <Slider
                            type="single"
                            bind:value={charSize}
                            min={1}
                            max={40}
                            step={1}
                            class="w-full" />
                    </label>

                    <!-- Depth slider -->
                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Depth</span>
                            <span class="text-xs tabular-nums text-slate-600"
                                >{charDepth}</span>
                        </div>
                        <Slider
                            type="single"
                            bind:value={charDepth}
                            min={0.2}
                            max={10}
                            step={0.2}
                            class="w-full" />
                    </label>

                    <ColorPalettePicker
                        bind:value={charColor}
                        {palette}
                        label="Color" />

                    <!-- Text offset -->
                    <div class="grid gap-1.5">
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-600">
                            Offset
                        </div>
                        <label class="grid gap-1">
                            <div
                                class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
                                    >X</span>
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{textOffsetX}</span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={textOffsetX}
                                min={-50}
                                max={50}
                                step={0.5}
                                class="w-full" />
                        </label>
                        <label class="grid gap-1">
                            <div
                                class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
                                    >Y</span>
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{textOffsetY}</span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={textOffsetY}
                                min={-50}
                                max={50}
                                step={0.5}
                                class="w-full" />
                        </label>
                    </div>
                </div>
                <div class="grid grid-cols-1 gap-4">
                    <!-- Base controls -->
                    <div
                        class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700">
                            Base
                        </div>
                        <ColorPalettePicker
                            bind:value={baseColor}
                            {palette}
                            label="Color" />
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
                                    >Depth</span>
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{baseDepth}</span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={baseDepth}
                                min={0.2}
                                max={20}
                                step={0.2}
                                class="w-full" />
                        </label>
                    </div>

                    <!-- Top controls -->
                    <div
                        class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700">
                            Top
                        </div>
                        <ColorPalettePicker
                            bind:value={topColor}
                            {palette}
                            label="Color" />
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
                                    >Depth</span>
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{topDepth}</span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={topDepth}
                                min={0.2}
                                max={20}
                                step={0.2}
                                class="w-full" />
                        </label>
                    </div>
                </div>
            </div>
        </aside>

        <section
            class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]">
            <div bind:this={hostEl} class="absolute inset-0"></div>
            <div class="absolute bottom-4 right-4">
                <DesignerExportToolbar
                    onSnapshot={() =>
                        downloadSnapshot(renderer, scene, camera, "flower")}
                    onExport={() => (user && subscriptionStatus?.isActive ? exportSTL() : onShowPricing?.())}
                    onExport3MF={() => (user && subscriptionStatus?.isActive ? export3MF() : onShowPricing?.())}
                    exportDisabled={false}
                    exportTitle={!user
                        ? "Sign in to export"
                        : !subscriptionStatus?.isActive
                            ? "Subscribe to export"
                            : "Export STL or 3MF"}
                    showLockIcon={!user || !subscriptionStatus?.isActive} />
            </div>
        </section>
    </div>
</main>
