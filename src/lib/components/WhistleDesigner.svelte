<script lang="ts">
    import type { Session, User } from "@supabase/supabase-js";
    import { onDestroy, onMount } from "svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import { exportTo3MF } from "$lib/export-to-3mf";
    import whistleBaseStlUrl from "$lib/assets/stl/whistle-base.stl?url";
    import FontSelect from "$lib/components/FontSelect.svelte";
    import {
        centerGeometryXY,
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        FONT_OPTIONS,
        frameCameraToObject,
        getFont,
        measureWorldAabbSizeMm,
    } from "$lib/utils-3d";
    import { notifyExportEvent } from "$lib/exportNotify";
    import { upload3mfToSupabase } from "$lib/upload3mf";
    import DesignerExportToolbar from "./DesignerExportToolbar.svelte";
    import DesignerModelDimensionsHud from "./DesignerModelDimensionsHud.svelte";
    import { Button } from "$lib/components/ui/button";
    import { Slider } from "$lib/components/ui/slider";
    import ColorPalettePicker from "./ColorPalettePicker.svelte";
    import type { PaletteColor } from "$lib/colorPalette";
    import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from "$lib/subscription";
    import { tickThenYieldToPaint } from "$lib/yield-to-paint";

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

    let { user, session, subscriptionStatus, palette, onBack, onRequestLogin, onShowThankYou, onShowPricing }: Props = $props();

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
    let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);

    const defaultSettings = {
        textContent: "Name",
        fontKey: FONT_OPTIONS[0].key,
        textScale: 1,
        textDepth: 1,
        textColor: "#ffffff",
        textOffsetX: 4.5,
        baseColor: "#f97316",
    };
    const FONT_SIZE_FOR_SHAPES = 12;

    let whistleGeometry = $state<THREE.BufferGeometry | null>(null);
    let textContent = $state("Name");
    let fontKey = $state(FONT_OPTIONS[0].key);
    let textScale = $state(defaultSettings.textScale);
    let textDepth = $state(defaultSettings.textDepth);
    let textColor = $state(defaultSettings.textColor);
    let textOffsetX = $state(defaultSettings.textOffsetX);
    let baseColor = $state(defaultSettings.baseColor);
    let exportError = $state<string | null>(null);
    let exportLoading = $state(false);
    let openBambuStudioLoading = $state(false);

    function resize() {
        if (!renderer || !camera || !hostEl) return;
        const rect = hostEl.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    function centerWhistle(geo: THREE.BufferGeometry) {
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
        modelAabbMm = null;

        if (!whistleGeometry) return;

        const whistleMat = new THREE.MeshStandardMaterial({
            color: baseColor,
            roughness: 0.7,
            metalness: 0.15,
        });
        const whistleMesh = new THREE.Mesh(whistleGeometry, whistleMat);
        whistleMesh.castShadow = true;
        whistleMesh.receiveShadow = true;
        group.add(whistleMesh);

        const content = (textContent ?? "").trim();
        if (content) {
            const font = getFont(fontKey);
            if (font) {
                const shapes = font.generateShapes(
                    content,
                    FONT_SIZE_FOR_SHAPES,
                );
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

                    whistleGeometry.computeBoundingBox();
                    const wb = whistleGeometry.boundingBox!;
                    const topZ = wb.max.z;
                    const centerX = (wb.min.x + wb.max.x) / 2;
                    const centerY = (wb.min.y + wb.max.y) / 2;

                    textGeo.computeBoundingBox();
                    const tb = textGeo.boundingBox!;
                    const textH = Math.max(tb.max.y - tb.min.y, 0.01);
                    const whistleW = Math.max(0.01, wb.max.x - wb.min.x);
                    // Scale by height so letter height is consistent regardless of character count
                    const TARGET_HEIGHT_MM = 10;
                    const scale = (TARGET_HEIGHT_MM * textScale) / textH;
                    const scaleCap =
                        (whistleW * 0.8) / (tb.max.x - tb.min.x || 0.01);
                    const scaleCapped = Math.min(scale, scaleCap);
                    textMesh.scale.set(scaleCapped, scaleCapped, 1);
                    textMesh.position.set(
                        centerX + textOffsetX,
                        centerY,
                        topZ + 0.02,
                    );
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
        {
            const s = measureWorldAabbSizeMm(group);
            modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
        }
    }

    async function exportStl() {
        if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
        if (!group || group.children.length === 0) {
            exportError = "Nothing to export";
            return;
        }
        exportError = null;
        exportLoading = true;
        await tickThenYieldToPaint();
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
                    if (g.index) {
                        const nonIndexed = g.toNonIndexed();
                        g.dispose();
                        g = nonIndexed;
                    }
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
            const slug = "custom-whistle";
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(
                `${slug}-${ts}.stl`,
                new Blob([buffer], { type: "model/stl" }),
            );
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Custom Whistle",
                format: "stl"
            });
            onShowThankYou();
        } catch (e) {
            exportError = e instanceof Error ? e.message : "Export failed";
        } finally {
            exportLoading = false;
        }
    }

    async function export3MF() {
        if (!group || !scene) return;
        if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
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
        downloadBlob(`custom-whistle-${timestamp}.3mf`, blob);
        notifyExportEvent({
            email: user?.email,
            name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
            subscriptionStatus,
            designName: "Custom Whistle",
            format: "3mf"
        });
        onShowThankYou();
    }

    async function openWithBambuStudio() {
        if (!group || !scene) return;
        if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
        openBambuStudioLoading = true;
        await tickThenYieldToPaint();
        try {
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
            const publicUrl = await upload3mfToSupabase(blob, 'whistle');
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Custom Whistle",
                format: "bambu_studio"
            });
            window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
        } catch (err) {
            console.error('Open with Bambu Studio failed:', err);
        } finally {
            openBambuStudioLoading = false;
        }
    }

    $effect(() => {
        void whistleGeometry;
        void textContent;
        void fontKey;
        void textScale;
        void textDepth;
        void textColor;
        void textOffsetX;
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
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
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
        loader.load(whistleBaseStlUrl, (geometry: THREE.BufferGeometry) => {
            centerWhistle(geometry);
            whistleGeometry = geometry;
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
        if (whistleGeometry) {
            whistleGeometry.dispose();
            whistleGeometry = null;
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
        class="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-4 lg:flex-row min-h-0">
        <aside
            class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]">
            <div class="mb-4 flex shrink-0 items-center justify-between p-4">
                <h1 class="text-lg font-semibold tracking-tight text-slate-900">
                    Custom Whistle
                </h1>
                <Button variant="outline" size="sm" onclick={onBack}>
                    Back
                </Button>
            </div>

            <div
                class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
                <p class="text-xs text-slate-500">
                    Add your text on top of the whistle. The text is centered
                    and scaled to fit.
                </p>

                <div>
                    <label
                        for="whistle-text-input"
                        class="mb-1 block text-xs font-medium text-slate-700">
                        Text
                    </label>
                    <input
                        id="whistle-text-input"
                        type="text"
                        placeholder="Your name or message"
                        class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                        bind:value={textContent} />
                </div>

                <div>
                    <label
                        for="whistle-font"
                        class="mb-1 block text-xs font-medium text-slate-700">
                        Font
                    </label>
                    <FontSelect id="whistle-font" bind:value={fontKey} />
                </div>

                <div>
                    <div class="mb-1 flex items-center justify-between">
                        <label
                            for="whistle-text-scale"
                            class="text-xs font-medium text-slate-700">
                            Text scale
                        </label>
                        <span class="text-xs text-slate-500"
                            >{textScale.toFixed(1)}×</span>
                    </div>
                    <Slider
                        type="single"
                        bind:value={textScale}
                        min={0.3}
                        max={2}
                        step={0.1}
                        class="w-full" />
                </div>

                <div>
                    <div class="mb-1 flex items-center justify-between">
                        <label
                            for="whistle-text-depth"
                            class="text-xs font-medium text-slate-700">
                            Text depth
                        </label>
                        <span class="text-xs text-slate-500"
                            >{textDepth.toFixed(1)} mm</span>
                    </div>
                    <Slider
                        type="single"
                        bind:value={textDepth}
                        min={0.2}
                        max={2}
                        step={0.1}
                        class="w-full" />
                </div>

                <ColorPalettePicker
                    bind:value={textColor}
                    {palette}
                    label="Text color" />

                <ColorPalettePicker
                    bind:value={baseColor}
                    {palette}
                    label="Base color" />

                {#if exportError}
                    <p class="text-sm text-red-600">{exportError}</p>
                {/if}
            </div>
        </aside>

        <section
            class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]">
            <DesignerModelDimensionsHud sizes={modelAabbMm} />
            <div bind:this={hostEl} class="absolute inset-0"></div>
            <div class="absolute bottom-4 right-4">
                <DesignerExportToolbar
                    onSnapshot={() =>
                        downloadSnapshot(
                            renderer,
                            scene,
                            camera,
                            "whistle-designer",
                        )}
                    onExport={() => (user && subscriptionStatus?.isActive ? exportStl() : onShowPricing?.())}
                    exportDisabled={!whistleGeometry || exportLoading}
                    exportTitle={getExportTitle(user, subscriptionStatus, "Export STL")}
                    onExport3MF={() => (user && subscriptionStatus?.isActive ? export3MF() : onShowPricing?.())}
                    onOpenWithBambuStudio={() => (user && subscriptionStatus?.isActive ? openWithBambuStudio() : onShowPricing?.())}
                    openBambuStudioLoading={openBambuStudioLoading}
                    {exportLoading}
                    showLockIcon={!user || !subscriptionStatus?.isActive} />
            </div>
        </section>
    </div>
</main>
