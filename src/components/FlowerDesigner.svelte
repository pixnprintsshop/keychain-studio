<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import { type LicenseStatus, checkLicenseStatus } from "../lib/licensing";
    import type { User, Session } from "@supabase/supabase-js";
    import type LicenseModal from "./LicenseModal.svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLLoader } from "three/examples/jsm/loaders/STLLoader";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import {
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        frameCameraToObject,
        centerGeometryXY,
        getFont,
        FONT_OPTIONS,
    } from "../lib/utils";
    import baseStlUrl from "../assets/stl/flower/base.stl?url";
    import topStlUrl from "../assets/stl/flower/top.stl?url";

    // ── Props ───────────────────────────────────────────────────────────────
    interface Props {
        user: User | null;
        session: Session | null;
        licenseStatus: LicenseStatus | null;
        licenseModalRef: LicenseModal | null;
        onBack: () => void;
        onRequestLogin: () => void;
        onShowThankYou: () => void;
    }
    let {
        user,
        session,
        licenseStatus,
        licenseModalRef,
        onBack,
        onRequestLogin,
        onShowThankYou,
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

    // ── Dropdown state ──────────────────────────────────────────────────────
    let fontDropdownOpen = $state(false);
    let fontDropdownRef: HTMLDivElement | null = null;

    function handleClickOutside(event: MouseEvent) {
        const target = event.target as Node;
        if (fontDropdownRef && !fontDropdownRef.contains(target))
            fontDropdownOpen = false;
    }

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
        const status = await checkLicenseStatus(user);
        if (!status.canExport) {
            licenseModalRef?.open();
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
        }
        if (status.type === "trial") onShowThankYou();
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    onMount(() => {
        if (!hostEl) return;
        document.addEventListener("mousedown", handleClickOutside);

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
        const grid = new THREE.GridHelper(300, 20, 0xcbd5e1, 0xe2e8f0);
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
        document.removeEventListener("mousedown", handleClickOutside);
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
        class="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-4 lg:flex-row"
    >
        <aside
            class="flex max-h-[44dvh] w-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/85 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] backdrop-blur lg:max-h-none lg:w-[380px]"
        >
            <div class="border-b border-slate-200 p-4">
                <button
                    type="button"
                    class="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors"
                    onclick={onBack}
                >
                    <svg
                        class="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M15 19l-7-7 7-7"
                        />
                    </svg>
                    Back
                </button>
                <h2
                    class="mt-2 text-sm font-semibold tracking-tight text-slate-900"
                >
                    Flower Keychain
                </h2>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
                <div class="grid grid-cols-1 gap-4">
                    <!-- Base controls -->
                    <div
                        class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3"
                    >
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700"
                        >
                            Base
                        </div>
                        <label class="grid gap-1.5">
                            <span class="text-xs font-medium text-slate-700"
                                >Color</span
                            >
                            <div class="flex items-center gap-2">
                                <input
                                    class="h-10 w-10 rounded-xl"
                                    type="color"
                                    bind:value={baseColor}
                                />
                                <input
                                    class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                    type="text"
                                    bind:value={baseColor}
                                />
                            </div>
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Depth</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{baseDepth}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="0.2"
                                max="20"
                                step="0.2"
                                bind:value={baseDepth}
                            />
                        </label>
                    </div>

                    <!-- Top controls -->
                    <div
                        class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3"
                    >
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700"
                        >
                            Top
                        </div>
                        <label class="grid gap-1.5">
                            <span class="text-xs font-medium text-slate-700"
                                >Color</span
                            >
                            <div class="flex items-center gap-2">
                                <input
                                    class="h-10 w-10 rounded-xl"
                                    type="color"
                                    bind:value={topColor}
                                />
                                <input
                                    class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                    type="text"
                                    bind:value={topColor}
                                />
                            </div>
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Depth</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{topDepth}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="0.2"
                                max="20"
                                step="0.2"
                                bind:value={topDepth}
                            />
                        </label>
                    </div>

                    <!-- Text controls -->
                    <div
                        class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3"
                    >
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700"
                        >
                            Text
                        </div>

                        <!-- Char input -->
                        <label class="grid gap-1.5">
                            <span class="text-xs font-medium text-slate-700"
                                >Char</span
                            >
                            <input
                                class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                type="text"
                                maxlength={1}
                                bind:value={char}
                            />
                        </label>

                        <!-- Font dropdown -->
                        <label class="grid gap-1.5">
                            <span class="text-xs font-medium text-slate-700"
                                >Font</span
                            >
                            <div class="relative" bind:this={fontDropdownRef}>
                                <button
                                    type="button"
                                    class="w-full appearance-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2 flex items-center justify-between"
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        fontDropdownOpen = !fontDropdownOpen;
                                    }}
                                >
                                    <span
                                        style="font-family: {FONT_OPTIONS.find(
                                            (f) => f.key === charFontKey,
                                        )?.fontFamily || 'inherit'}"
                                    >
                                        {FONT_OPTIONS.find(
                                            (f) => f.key === charFontKey,
                                        )?.label || "Select font"}
                                    </span>
                                    <svg
                                        class="h-4 w-4 text-slate-500 transition-transform {fontDropdownOpen
                                            ? 'rotate-180'
                                            : ''}"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                    >
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2"
                                            d="M19 9l-7 7-7-7"
                                        />
                                    </svg>
                                </button>
                                {#if fontDropdownOpen}
                                    <div
                                        class="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg"
                                    >
                                        {#each FONT_OPTIONS as f, index}
                                            {@const isFirstFont = index === 0}
                                            {@const isTrialRestricted =
                                                user &&
                                                licenseStatus?.type ===
                                                    "trial" &&
                                                !isFirstFont}
                                            <button
                                                type="button"
                                                class="w-full px-3 py-2 text-left text-sm transition-colors {charFontKey ===
                                                f.key
                                                    ? 'bg-indigo-100'
                                                    : ''} {isTrialRestricted
                                                    ? 'opacity-50 cursor-not-allowed text-slate-400'
                                                    : 'text-slate-900 hover:bg-indigo-50'}"
                                                style="font-family: {f.fontFamily}"
                                                disabled={isTrialRestricted}
                                                onclick={(e) => {
                                                    e.stopPropagation();
                                                    if (isTrialRestricted) {
                                                        licenseModalRef?.open();
                                                        return;
                                                    }
                                                    charFontKey = f.key;
                                                    fontDropdownOpen = false;
                                                }}
                                            >
                                                <div
                                                    class="flex items-center justify-between"
                                                >
                                                    <span>{f.label}</span>
                                                    {#if isTrialRestricted}
                                                        <svg
                                                            class="h-4 w-4 text-slate-400"
                                                            fill="none"
                                                            viewBox="0 0 24 24"
                                                            stroke="currentColor"
                                                        >
                                                            <path
                                                                stroke-linecap="round"
                                                                stroke-linejoin="round"
                                                                stroke-width="2"
                                                                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                                                            />
                                                        </svg>
                                                    {/if}
                                                </div>
                                            </button>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        </label>

                        <!-- Size slider -->
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Size</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{charSize}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="1"
                                max="40"
                                step="1"
                                bind:value={charSize}
                            />
                        </label>

                        <!-- Depth slider -->
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Depth</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{charDepth}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="0.2"
                                max="10"
                                step="0.2"
                                bind:value={charDepth}
                            />
                        </label>

                        <!-- Color picker -->
                        <label class="grid gap-1.5">
                            <span class="text-xs font-medium text-slate-700"
                                >Color</span
                            >
                            <div class="flex items-center gap-2">
                                <input
                                    class="h-10 w-10 rounded-xl"
                                    type="color"
                                    bind:value={charColor}
                                />
                                <input
                                    class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                    type="text"
                                    bind:value={charColor}
                                />
                            </div>
                        </label>

                        <!-- Text offset -->
                        <div class="grid gap-1.5">
                            <div
                                class="text-xs font-semibold tracking-tight text-slate-600"
                            >
                                Offset
                            </div>
                            <label class="grid gap-1">
                                <div
                                    class="flex items-center justify-between gap-2"
                                >
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >X</span
                                    >
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{textOffsetX}</span
                                    >
                                </div>
                                <input
                                    class="w-full accent-indigo-500"
                                    type="range"
                                    min="-50"
                                    max="50"
                                    step="0.5"
                                    bind:value={textOffsetX}
                                />
                            </label>
                            <label class="grid gap-1">
                                <div
                                    class="flex items-center justify-between gap-2"
                                >
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Y</span
                                    >
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{textOffsetY}</span
                                    >
                                </div>
                                <input
                                    class="w-full accent-indigo-500"
                                    type="range"
                                    min="-50"
                                    max="50"
                                    step="0.5"
                                    bind:value={textOffsetY}
                                />
                            </label>
                        </div>
                    </div>
                </div>
            </div>
        </aside>

        <section
            class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
        >
            <div bind:this={hostEl} class="absolute inset-0"></div>
            <div class="absolute bottom-4 right-4 flex items-center gap-2">
                <button
                    class="rounded-full border border-slate-200 bg-white/90 p-2.5 text-slate-600 shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:text-slate-900 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                    type="button"
                    onclick={() =>
                        downloadSnapshot(renderer, scene, camera, "flower")}
                    aria-label="Download snapshot"
                    title="Download snapshot"
                >
                    <svg
                        class="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                        />
                        <circle cx="12" cy="13" r="3" />
                    </svg>
                </button>
                <button
                    class="rounded-full border border-slate-200 bg-white/90 px-4 py-2 text-sm font-semibold tracking-tight text-slate-900 shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                    type="button"
                    onclick={exportSTL}
                    aria-label="Download STL"
                    disabled={!user || licenseStatus?.canExport === false}
                    title={!user
                        ? "Sign in to export"
                        : licenseStatus?.canExport === false
                          ? "License required to export"
                          : "Export STL"}
                >
                    {#if !user || licenseStatus?.canExport === false}
                        <span class="flex items-center gap-2">
                            <svg
                                class="h-4 w-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                                />
                            </svg>
                            Export STL
                        </span>
                    {:else}
                        Export STL
                    {/if}
                </button>
            </div>
        </section>
    </div>
</main>
