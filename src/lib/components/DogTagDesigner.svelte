<script lang="ts">
    import type { Session, User } from "@supabase/supabase-js";
    import { onDestroy, onMount } from "svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import { exportTo3MF } from "three-3mf-exporter";
    import baseStlUrl from "$lib/assets/stl/dogtag/base.stl?url";
    import borderStlUrl from "$lib/assets/stl/dogtag/border.stl?url";
    import FontSelect from "$lib/components/FontSelect.svelte";
    import type { LicenseStatus } from "$lib/licensing";
    import {
        centerGeometryXY,
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        FONT_OPTIONS,
        frameCameraToObject,
        getFont,
    } from "$lib/utils";
    import DesignerExportToolbar from "./DesignerExportToolbar.svelte";
    import type LicenseModal from "./LicenseModal.svelte";

    export interface Props {
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

    let hostEl: HTMLDivElement | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let scene: THREE.Scene | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let controls: InstanceType<typeof OrbitControls> | null = null;
    let group: THREE.Group | null = null;
    let keyLight: THREE.DirectionalLight | null = null;
    let rafId = 0;
    let ro: ResizeObserver | null = null;
    let didInitFrame = false;

    const defaultSettings = {
        textContent: "Name",
        fontKey: FONT_OPTIONS[0]?.key ?? "Milkyway_Regular",
        textSize: 20,
        textScale: 1,
        textDepth: 0.8,
        textColor: "#ffffff",
        baseColor: "#94a3b8",
    };

    let baseGeometry = $state<THREE.BufferGeometry | null>(null);
    let borderGeometry = $state<THREE.BufferGeometry | null>(null);
    let textContent = $state(defaultSettings.textContent);
    let fontKey = $state(defaultSettings.fontKey);
    let textSize = $state(defaultSettings.textSize);
    let textScale = $state(defaultSettings.textScale);
    let textDepth = $state(defaultSettings.textDepth);
    let textColor = $state(defaultSettings.textColor);
    let baseColor = $state(defaultSettings.baseColor);
    let exportError = $state<string | null>(null);
    let exportLoading = $state(false);

    function resize() {
        if (!renderer || !camera || !hostEl) return;
        const rect = hostEl.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    /** Center geometry in XY and set min Z to 0 (for base/border). */
    function centerBase(geo: THREE.BufferGeometry) {
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        const cx = (bb.min.x + bb.max.x) / 2;
        const cy = (bb.min.y + bb.max.y) / 2;
        const cz = bb.min.z;
        geo.translate(-cx, -cy, -cz);
        geo.computeBoundingBox();
    }

    function rebuildMeshes() {
        if (!group) return;
        disposeObject3D(group);
        group.clear();

        if (!baseGeometry) return;

        const baseMat = new THREE.MeshStandardMaterial({
            color: baseColor,
            roughness: 0.7,
            metalness: 0.15,
        });
        const baseMesh = new THREE.Mesh(baseGeometry, baseMat);
        baseMesh.castShadow = true;
        baseMesh.receiveShadow = true;
        group.add(baseMesh);

        baseGeometry.computeBoundingBox();
        const wb = baseGeometry.boundingBox!;
        const topZ = wb.max.z;
        const centerX = (wb.min.x + wb.max.x) / 2;
        const centerY = (wb.min.y + wb.max.y) / 2;

        // Border on top of base: same text color and depth (scale Z by textDepth)
        if (borderGeometry) {
            const borderMat = new THREE.MeshStandardMaterial({
                color: textColor,
                roughness: 0.4,
                metalness: 0.1,
            });
            const borderMesh = new THREE.Mesh(borderGeometry, borderMat);
            borderMesh.castShadow = true;
            borderMesh.receiveShadow = true;
            borderGeometry.computeBoundingBox();
            const bordMinZ = borderGeometry.boundingBox!.min.z;
            borderMesh.position.set(centerX, centerY, topZ - bordMinZ);
            borderMesh.scale.set(1, 1, Math.max(0.1, textDepth));
            group.add(borderMesh);
        }

        // Text on top of base (and border)
        const content = (textContent ?? "").trim();
        if (content) {
            const font = getFont(fontKey);
            if (font) {
                const shapes = font.generateShapes(content, textSize);
                if (shapes.length > 0) {
                    const textGeo = new THREE.ExtrudeGeometry(shapes, {
                        depth: Math.max(0.1, textDepth),
                        bevelEnabled: false,
                        curveSegments: 8,
                    });
                    centerGeometryXY(textGeo);

                    const textMat = new THREE.MeshStandardMaterial({
                        color: textColor,
                        roughness: 0.4,
                        metalness: 0.1,
                    });
                    const textMesh = new THREE.Mesh(textGeo, textMat);
                    textMesh.castShadow = true;
                    textMesh.receiveShadow = true;

                    // Text sits on the base surface (same level as border bottom), not on top of border
                    const textTopZ = topZ + 0.02;
                    textGeo.computeBoundingBox();
                    const tb = textGeo.boundingBox!;
                    const textH = Math.max(tb.max.y - tb.min.y, 0.01);
                    const baseW = Math.max(0.01, wb.max.x - wb.min.x);
                    const TARGET_HEIGHT_MM = 8 * (textSize / 20) * textScale;
                    const scale = TARGET_HEIGHT_MM / textH;
                    const scaleCap =
                        (baseW * 0.7) / (tb.max.x - tb.min.x || 0.01);
                    const scaleCapped = Math.min(scale, scaleCap);
                    textMesh.scale.set(scaleCapped, scaleCapped, 1);
                    textMesh.position.set(centerX, centerY, textTopZ);
                    group.add(textMesh);
                }
            }
        }

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
            cam.updateProjectionMatrix();
            keyLight.target.position.copy(center);
            keyLight.target.updateWorldMatrix(true, true);
        }
        if (!didInitFrame && camera && controls) {
            frameCameraToObject(box, camera, controls);
            didInitFrame = true;
        }
    }

    async function exportStl() {
        if (!user) {
            onRequestLogin();
            return;
        }
        if (!licenseStatus?.canExport) {
            licenseModalRef?.open();
            return;
        }
        if (!group || group.children.length === 0) {
            exportError = "Nothing to export";
            return;
        }
        exportError = null;
        exportLoading = true;
        try {
            const geometries: THREE.BufferGeometry[] = [];
            for (const child of group.children) {
                if ((child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    let g = mesh.geometry
                        .clone()
                        .applyMatrix4(mesh.matrixWorld);
                    if (g.attributes.uv) g.deleteAttribute("uv");
                    if (!g.attributes.normal) g.computeVertexNormals();
                    geometries.push(g);
                }
            }
            if (geometries.length === 0) {
                exportError = "Nothing to export";
                return;
            }
            const merged =
                geometries.length === 1
                    ? geometries[0]
                    : BufferGeometryUtils.mergeGeometries(geometries);
            if (!merged) {
                geometries.forEach((g) => g.dispose());
                exportError = "Failed to merge geometry";
                return;
            }
            if (geometries.length > 1) geometries.forEach((g) => g.dispose());
            const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
            if (welded !== merged) merged.dispose();

            const exporter = new STLExporter();
            const result = exporter.parse(new THREE.Mesh(welded), {
                binary: true,
            });
            welded.dispose();
            const buffer = result instanceof DataView ? result.buffer : result;
            if (!buffer || (buffer as ArrayBuffer).byteLength < 84) {
                exportError = "Export produced empty geometry";
                return;
            }
            const slug = "dog-tag";
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(
                `${slug}-${ts}.stl`,
                new Blob([buffer], { type: "model/stl" }),
            );
            if (licenseStatus?.type === "trial") onShowThankYou();
        } catch (e) {
            exportError = e instanceof Error ? e.message : "Export failed";
        } finally {
            exportLoading = false;
        }
    }

    async function export3MF() {
        if (!group || !scene) return;
        if (!user) {
            onRequestLogin();
            return;
        }
        if (!licenseStatus?.canExport) {
            licenseModalRef?.open();
            return;
        }
        rebuildMeshes();
        group.updateWorldMatrix(true, true);
        const exportGroup = new THREE.Group();
        for (const child of group.children) {
            if (!(child as THREE.Mesh).isMesh) continue;
            const mesh = child as THREE.Mesh;
            const geo = mesh.geometry
                .clone()
                .applyMatrix4(mesh.matrixWorld);
            const mat = (Array.isArray(mesh.material)
                ? mesh.material[0]
                : mesh.material) as THREE.MeshStandardMaterial;
            const color =
                mat?.color != null
                    ? mat.color.clone()
                    : new THREE.Color(0xffffff);
            exportGroup.add(
                new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color })),
            );
        }
        if (exportGroup.children.length === 0) return;
        exportGroup.updateWorldMatrix(true, true);
        const blob = await exportTo3MF(exportGroup);
        if (!blob || blob.size === 0) return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(`dog-tag-${timestamp}.3mf`, blob);
        if (licenseStatus?.type === "trial") onShowThankYou();
    }

    $effect(() => {
        void baseGeometry;
        void borderGeometry;
        void textContent;
        void fontKey;
        void textSize;
        void textScale;
        void textDepth;
        void textColor;
        void baseColor;
        if (!scene || !group) return;
        rebuildMeshes();
    });

    onMount(() => {
        if (!hostEl) return;
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xffffff);
        camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
        camera.up.set(0, 0, 1);
        renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            preserveDrawingBuffer: true,
        });
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        hostEl.appendChild(renderer.domElement);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enablePan = true;
        controls.minDistance = 5;
        controls.maxDistance = 500;

        scene.add(new THREE.AmbientLight(0xffffff, 0.85));
        keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
        keyLight.position.set(60, -80, 140);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.width = 2048;
        keyLight.shadow.mapSize.height = 2048;
        scene.add(keyLight);
        scene.add(keyLight.target);

        const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
        fillLight.position.set(0, 0, -80);
        fillLight.target.position.set(0, 0, 0);
        scene.add(fillLight);
        scene.add(fillLight.target);

        group = new THREE.Group();
        scene.add(group);

        const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
        grid.rotateX(Math.PI / 2);
        grid.position.z = -0.01;
        scene.add(grid);

        const loader = new STLLoader();
        loader.load(baseStlUrl, (geometry: THREE.BufferGeometry) => {
            centerBase(geometry);
            baseGeometry = geometry;
        });
        loader.load(borderStlUrl, (geometry: THREE.BufferGeometry) => {
            centerBase(geometry);
            borderGeometry = geometry;
        });

        ro = new ResizeObserver(() => resize());
        ro.observe(hostEl);
        resize();

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

    onDestroy(() => {
        cancelAnimationFrame(rafId);
        rafId = 0;
        if (baseGeometry) {
            baseGeometry.dispose();
            baseGeometry = null;
        }
        if (borderGeometry) {
            borderGeometry.dispose();
            borderGeometry = null;
        }
        if (group) {
            disposeObject3D(group);
            group.clear();
        }
        group = null;
        renderer = null;
        scene = null;
        camera = null;
        controls = null;
        keyLight = null;
    });
</script>

<main class="h-dvh w-dvw bg-slate-100 p-4">
    <div
        class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
        <aside
            class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]">
            <div class="flex shrink-0 items-center justify-between p-4">
                <h1 class="text-lg font-semibold tracking-tight text-slate-900">
                    Dog Tag
                </h1>
                <button
                    type="button"
                    class="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    onclick={onBack}>
                    Back
                </button>
            </div>

            <div
                class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
                <p class="text-xs text-slate-500">
                    Personalize the dog tag with your text. Border and text use
                    the same depth and color, on top of the base.
                </p>

                <div>
                    <label
                        for="dogtag-text-input"
                        class="mb-1 block text-xs font-medium text-slate-700">
                        Text
                    </label>
                    <input
                        id="dogtag-text-input"
                        type="text"
                        placeholder="Pet name or phone"
                        class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                        bind:value={textContent} />
                </div>

                <div>
                    <label
                        for="dogtag-font"
                        class="mb-1 block text-xs font-medium text-slate-700">
                        Font
                    </label>
                    <FontSelect id="dogtag-font" bind:value={fontKey} />
                </div>

                <div>
                    <div class="mb-1 flex items-center justify-between">
                        <label
                            for="dogtag-text-scale"
                            class="text-xs font-medium text-slate-700">
                            Text scale
                        </label>
                        <span class="text-xs text-slate-500"
                            >{textScale.toFixed(1)}×</span>
                    </div>
                    <input
                        id="dogtag-text-scale"
                        type="range"
                        min="0.3"
                        max="2"
                        step="0.1"
                        bind:value={textScale}
                        class="w-full accent-indigo-500" />
                </div>

                <div>
                    <div class="mb-1 flex items-center justify-between">
                        <label
                            for="dogtag-text-depth"
                            class="text-xs font-medium text-slate-700">
                            Text & border depth
                        </label>
                        <span class="text-xs text-slate-500"
                            >{textDepth.toFixed(1)} mm</span>
                    </div>
                    <input
                        id="dogtag-text-depth"
                        type="range"
                        min="0.2"
                        max="2"
                        step="0.1"
                        bind:value={textDepth}
                        class="w-full accent-indigo-500" />
                </div>

                <div>
                    <label
                        class="flex items-center gap-2"
                        for="dogtag-text-color">
                        <span class="text-xs font-medium text-slate-700"
                            >Text & border color</span>
                        <input
                            id="dogtag-text-color"
                            class="h-10 w-10 cursor-pointer rounded-xl"
                            type="color"
                            bind:value={textColor} />
                        <input
                            type="text"
                            class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            bind:value={textColor} />
                    </label>
                </div>

                <div>
                    <label
                        class="flex items-center gap-2"
                        for="dogtag-base-color">
                        <span class="text-xs font-medium text-slate-700"
                            >Base color</span>
                        <input
                            id="dogtag-base-color"
                            class="h-10 w-10 cursor-pointer rounded-xl"
                            type="color"
                            bind:value={baseColor} />
                        <input
                            type="text"
                            class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            bind:value={baseColor} />
                    </label>
                </div>

                {#if exportError}
                    <p class="text-sm text-red-600">{exportError}</p>
                {/if}
            </div>
        </aside>

        <section
            class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]">
            <div bind:this={hostEl} class="absolute inset-0"></div>
            <div class="absolute bottom-4 right-4">
                <DesignerExportToolbar
                    onSnapshot={() => {
                        if (renderer && scene && camera)
                            downloadSnapshot(
                                renderer,
                                scene,
                                camera,
                                "dog-tag",
                            );
                    }}
                    onExport={() => void exportStl()}
                    exportDisabled={!baseGeometry ||
                        exportLoading ||
                        !user ||
                        licenseStatus?.canExport === false}
                    exportTitle={!user
                        ? "Sign in to export"
                        : licenseStatus?.canExport === false
                          ? "License required to export"
                          : "Export STL"}
                    onExport3MF={() => void export3MF()}
                    {exportLoading}
                    showLockIcon={!user ||
                        licenseStatus?.canExport === false} />
            </div>
        </section>
    </div>
</main>
