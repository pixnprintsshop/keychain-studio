<script lang="ts">
    import type { Session, User } from "@supabase/supabase-js";
    import { onDestroy, onMount } from "svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import { exportTo3MF } from "$lib/export-to-3mf";
    import FontSelect from "$lib/components/FontSelect.svelte";
    import {
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        FONT_OPTIONS,
        frameCameraToObject,
        getFont,
        makeKeyringGeometry,
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

    export interface Props {
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

    const STORAGE_KEY = "keychain-bumpy-text-settings";
    const STORAGE_KEY_KEYRING = "keychain-bumpy-text-keyring";

    interface BumpyCharSettings {
        keyringEnabled: boolean;
        keyringOuterSize: number;
        keyringHoleSize: number;
        keyringDepth: number;
        keyringOffsetX: number;
        keyringOffsetY: number;
    }

    const defaultCharSettings: BumpyCharSettings = {
        keyringEnabled: true,
        keyringOuterSize: 8,
        keyringHoleSize: 4,
        keyringDepth: 2,
        keyringOffsetX: 0,
        keyringOffsetY: 2,
    };

    function loadKeyringSettingsFromStorage(): Record<
        string,
        Record<string, BumpyCharSettings>
    > {
        try {
            const stored = localStorage.getItem(STORAGE_KEY_KEYRING);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed && typeof parsed === "object") return parsed;
            }
        } catch (_) {}
        return {};
    }

    const MID_THICKNESS = 5;
    const LOW_MIN = 3;
    const LOW_MAX = MID_THICKNESS;
    const HIGH_MIN = MID_THICKNESS;
    const HIGH_MAX = 7;

    function seededUnitForChar(
        seedBase: string,
        index: number,
        char: string,
    ): number {
        const c = char.codePointAt(0) ?? 0;
        const seed = `${seedBase}\0${index}\0${c}\0${index * 7919}`;
        let h = 0;
        for (let i = 0; i < seed.length; i++) {
            h = (h * 31 + seed.charCodeAt(i)) | 0;
        }
        h = Math.imul(h, 1103515245) + 12345;
        return (Math.abs(h) % 10000) / 10000;
    }

    const ALLOWED_FONT_KEYS = ["Titan One_Regular", "DynaPuff_Bold"] as const;
    const BUMPY_FONT_OPTIONS = FONT_OPTIONS.filter((f) =>
        ALLOWED_FONT_KEYS.includes(f.key as (typeof ALLOWED_FONT_KEYS)[number]),
    ).sort(
        (a, b) =>
            ALLOWED_FONT_KEYS.indexOf(
                a.key as (typeof ALLOWED_FONT_KEYS)[number],
            ) -
            ALLOWED_FONT_KEYS.indexOf(
                b.key as (typeof ALLOWED_FONT_KEYS)[number],
            ),
    );

    const defaults = {
        textContent: "Name",
        fontKey: BUMPY_FONT_OPTIONS[0]?.key ?? "Titan One_Regular",
        textSize: 20,
        letterSpacing: -2.7,
        textColor: "#24b6ff",
    };

    function loadSettings() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed && typeof parsed === "object")
                    return { ...defaults, ...parsed };
            }
        } catch {}
        return { ...defaults };
    }

    const initial = loadSettings();
    let allCharSettings = loadKeyringSettingsFromStorage();

    function getCurrentChar(): string {
        const t = (textContent ?? "").trim();
        return t.length > 0 ? t.charAt(0).toUpperCase() : "";
    }

    const initialChar =
        (initial.textContent ?? "").trim().length > 0
            ? initial.textContent!.trim().charAt(0).toUpperCase()
            : "";
    const initialCharSettings =
        allCharSettings[initial.fontKey]?.[initialChar] ?? defaultCharSettings;

    let textContent = $state(initial.textContent);
    let fontKey = $state(initial.fontKey);
    let textSize = $state(initial.textSize);
    let letterSpacing = $state(initial.letterSpacing);
    let textColor = $state(initial.textColor);
    let keyringEnabled = $state(initialCharSettings.keyringEnabled);
    let keyringOuterSize = $state(initialCharSettings.keyringOuterSize);
    let keyringHoleSize = $state(initialCharSettings.keyringHoleSize);
    let keyringDepth = $state(initialCharSettings.keyringDepth);
    let keyringOffsetX = $state(initialCharSettings.keyringOffsetX);
    let keyringOffsetY = $state(initialCharSettings.keyringOffsetY);

    let lastFont = initial.fontKey;
    let lastChar = initialChar;
    let isUpdatingFromStorage = $state(true);

    // Always keep user input in uppercase for consistency.
    $effect(() => {
        if (typeof textContent === "string") {
            textContent = textContent.toUpperCase();
        }
    });

    function loadKeyringForChar(fontName: string, char: string) {
        if (!char || !fontName) return;
        const cs = allCharSettings[fontName]?.[char] ?? defaultCharSettings;
        keyringEnabled = cs.keyringEnabled;
        keyringOuterSize = cs.keyringOuterSize;
        keyringHoleSize = cs.keyringHoleSize;
        keyringDepth = cs.keyringDepth;
        keyringOffsetX = cs.keyringOffsetX;
        keyringOffsetY = cs.keyringOffsetY;
    }

    function saveKeyringForChar(fontName: string, char: string) {
        if (isUpdatingFromStorage || !char || !fontName) return;
        if (!allCharSettings[fontName]) allCharSettings[fontName] = {};
        allCharSettings[fontName][char] = {
            keyringEnabled,
            keyringOuterSize,
            keyringHoleSize,
            keyringDepth,
            keyringOffsetX,
            keyringOffsetY,
        };
        try {
            localStorage.setItem(
                STORAGE_KEY_KEYRING,
                JSON.stringify(allCharSettings),
            );
        } catch (_) {}
    }

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
    let exportLoading = $state(false);
    let exportError = $state<string | null>(null);
    let openBambuStudioLoading = $state(false);
    let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);

    function resize() {
        if (!renderer || !camera || !hostEl) return;
        const w = Math.max(1, Math.floor(hostEl.getBoundingClientRect().width));
        const h = Math.max(
            1,
            Math.floor(hostEl.getBoundingClientRect().height),
        );
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    function saveSettings() {
        try {
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({
                    textContent,
                    fontKey,
                    textSize,
                    letterSpacing,
                    textColor,
                }),
            );
        } catch (_) {}
    }

    function rebuildMeshes() {
        if (!scene || !group) return;
        disposeObject3D(group);
        group.clear();
        group.position.set(0, 0, 0);
        modelAabbMm = null;

        const content = (textContent ?? "").trim();
        if (!content) {
            group.updateWorldMatrix(true, true);
            const box = new THREE.Box3().setFromObject(group);
            if (keyLight?.shadow?.camera) {
                const cam = keyLight.shadow.camera;
                cam.left = -20;
                cam.right = 20;
                cam.top = 20;
                cam.bottom = -20;
                cam.near = 0.1;
                cam.far = 300;
                cam.updateProjectionMatrix?.();
            }
            if (!didInitFrame && camera && controls) {
                frameCameraToObject(box, camera, controls);
                didInitFrame = true;
            }
            return;
        }

        const font = getFont(fontKey);
        if (!font) return;

        const size = Math.max(1, Math.round(textSize));
        const seedBase = `${content}\0${fontKey}\0${textSize}`;
        let offsetX = 0;

        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            const unit = seededUnitForChar(seedBase, i, char);
            const isLowBand = i % 2 === 0;
            const depth = isLowBand
                ? LOW_MIN + (LOW_MAX - LOW_MIN) * unit
                : HIGH_MIN + (HIGH_MAX - HIGH_MIN) * unit;

            const shapes = font.generateShapes(
                char === " " ? "\u00A0" : char,
                size,
            );
            if (shapes.length === 0) {
                offsetX += size * 0.35 + letterSpacing;
                continue;
            }

            let geo: THREE.BufferGeometry;
            try {
                geo = new THREE.ExtrudeGeometry(shapes, {
                    depth: Math.max(0.05, depth),
                    bevelEnabled: false,
                    curveSegments: 8,
                });
            } catch (_) {
                offsetX += size * 0.5 + letterSpacing;
                continue;
            }

            geo.computeBoundingBox();
            const bb = geo.boundingBox!;
            const width = bb.max.x - bb.min.x;

            const mat = new THREE.MeshStandardMaterial({
                color: textColor,
                roughness: 0.4,
                metalness: 0.1,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.position.set(offsetX, 0, 0);
            group.add(mesh);

            offsetX += width + letterSpacing;
        }

        group.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(group);
        const center = new THREE.Vector3();
        box.getCenter(center);
        const topY = box.max.y;
        group.position.set(-center.x, -center.y, 0);

        if (keyringEnabled) {
            const ringGeo = makeKeyringGeometry(
                Math.max(1, keyringOuterSize),
                Math.max(
                    0.1,
                    Math.min(keyringHoleSize, keyringOuterSize - 0.5),
                ),
                Math.max(0.1, keyringDepth),
            );
            const ringMat = new THREE.MeshStandardMaterial({
                color: textColor,
                roughness: 0.4,
                metalness: 0.1,
            });
            const ringMesh = new THREE.Mesh(ringGeo, ringMat);
            ringMesh.castShadow = true;
            ringMesh.receiveShadow = true;
            ringMesh.position.set(keyringOffsetX, topY + keyringOffsetY, 0);
            group.add(ringMesh);
        }

        group.updateWorldMatrix(true, true);
        const finalBox = new THREE.Box3().setFromObject(group);
        if (keyLight?.shadow?.camera) {
            const sizeVec = new THREE.Vector3();
            finalBox.getSize(sizeVec);
            const r = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 0.6 + 15;
            const cam = keyLight.shadow.camera;
            cam.left = -r;
            cam.right = r;
            cam.top = r;
            cam.bottom = -r;
            cam.near = 0.1;
            cam.far = Math.max(300, r * 4);
            cam.updateProjectionMatrix?.();
            const boxCenter = new THREE.Vector3();
            finalBox.getCenter(boxCenter);
            keyLight.target.position.copy(boxCenter);
            keyLight.target.updateWorldMatrix?.(true, true);
        }
        if (!didInitFrame && camera && controls) {
            frameCameraToObject(finalBox, camera, controls);
            didInitFrame = true;
        }
        {
            const s = measureWorldAabbSizeMm(group);
            modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
        }
    }

    async function exportSTL() {
        if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
        if (!group || !scene) return;
        exportError = null;
        exportLoading = true;
        await tickThenYieldToPaint();
        try {
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
                    geometries.push(geo);
                }
            }
            if (geometries.length === 0) {
                exportError = "No text to export";
                return;
            }
            const merged = BufferGeometryUtils.mergeGeometries(geometries);
            if (!merged) {
                exportError = "Failed to merge geometry";
                return;
            }
            geometries.forEach((g) => g.dispose());
            const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
            merged.dispose();
            const singleMesh = new THREE.Mesh(welded);
            const exporter = new STLExporter();
            const result = exporter.parse(singleMesh, { binary: true });
            welded.dispose();
            const buffer = result instanceof DataView ? result.buffer : result;
            if (buffer && (buffer as ArrayBuffer).byteLength >= 84) {
                const blob = new Blob([buffer], { type: "model/stl" });
                const safe = (textContent || "text")
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/(^-|-$)/g, "");
                const timestamp = new Date()
                    .toISOString()
                    .replace(/[:.]/g, "-");
                downloadBlob(`${safe || "text"}-${timestamp}.stl`, blob);
                notifyExportEvent({
                    email: user?.email,
                    name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                    subscriptionStatus,
                    designName: "Bumpy Text",
                    format: "stl"
                });
                onShowThankYou();
            }
        } catch (e) {
            exportError = e instanceof Error ? e.message : "Export failed";
        } finally {
            exportLoading = false;
        }
    }

    async function export3MF() {
        if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
        if (!group || !scene) return;
        exportError = null;
        exportLoading = true;
        await tickThenYieldToPaint();
        try {
            rebuildMeshes();
            group.updateWorldMatrix(true, true);
            const exportGroup = new THREE.Group();
            const mat = new THREE.MeshBasicMaterial({
                color: new THREE.Color(textColor || "#24b6ff"),
            });
            for (let i = 0; i < group.children.length; i++) {
                const child = group.children[i];
                if (child && (child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    const geo = mesh.geometry
                        .clone()
                        .applyMatrix4(mesh.matrixWorld);
                    exportGroup.add(new THREE.Mesh(geo, mat));
                }
            }
            if (exportGroup.children.length === 0) {
                exportError = "No text to export";
                return;
            }
            exportGroup.updateWorldMatrix(true, true);
            const blob = await exportTo3MF(exportGroup);
            if (!blob || blob.size === 0) {
                exportError = "3MF export produced no data";
                return;
            }
            const safe = (textContent || "text")
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "");
            const timestamp = new Date()
                .toISOString()
                .replace(/[:.]/g, "-");
            downloadBlob(`${safe || "text"}-${timestamp}.3mf`, blob);
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Bumpy Text",
                format: "3mf"
            });
            onShowThankYou();
        } catch (e) {
            exportError = e instanceof Error ? e.message : "3MF export failed";
        } finally {
            exportLoading = false;
        }
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
            const mat = new THREE.MeshBasicMaterial({
                color: new THREE.Color(textColor || "#24b6ff"),
            });
            for (let i = 0; i < group.children.length; i++) {
                const child = group.children[i];
                if (child && (child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    const geo = mesh.geometry
                        .clone()
                        .applyMatrix4(mesh.matrixWorld);
                    exportGroup.add(new THREE.Mesh(geo, mat));
                }
            }
            if (exportGroup.children.length === 0) return;
            exportGroup.updateWorldMatrix(true, true);
            const blob = await exportTo3MF(exportGroup);
            if (!blob || blob.size === 0) return;
            const publicUrl = await upload3mfToSupabase(blob, 'bumpy-text');
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Bumpy Text",
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
        const currentFont = fontKey;
        const currentChar = getCurrentChar();
        if (currentFont !== lastFont) {
            if (lastFont && lastChar) {
                const wasUpdating = isUpdatingFromStorage;
                isUpdatingFromStorage = false;
                saveKeyringForChar(lastFont, lastChar);
                isUpdatingFromStorage = wasUpdating;
            }
            isUpdatingFromStorage = true;
            lastFont = currentFont;
            if (currentChar) {
                loadKeyringForChar(currentFont, currentChar);
                lastChar = currentChar;
            }
            setTimeout(() => {
                isUpdatingFromStorage = false;
            }, 0);
        }
    });

    $effect(() => {
        const currentChar = getCurrentChar();
        const currentFont = fontKey;
        if (currentChar !== lastChar && currentFont) {
            if (lastChar) {
                const wasUpdating = isUpdatingFromStorage;
                isUpdatingFromStorage = false;
                saveKeyringForChar(currentFont, lastChar);
                isUpdatingFromStorage = wasUpdating;
            }
            isUpdatingFromStorage = true;
            lastChar = currentChar;
            if (currentChar) loadKeyringForChar(currentFont, currentChar);
            setTimeout(() => {
                isUpdatingFromStorage = false;
            }, 0);
        }
    });

    $effect(() => {
        if (isUpdatingFromStorage) return;
        const currentChar = getCurrentChar();
        const currentFont = fontKey;
        void keyringEnabled;
        void keyringOuterSize;
        void keyringHoleSize;
        void keyringDepth;
        void keyringOffsetX;
        void keyringOffsetY;
        if (currentChar && currentFont)
            saveKeyringForChar(currentFont, currentChar);
    });

    $effect(() => {
        void textContent;
        void fontKey;
        void textSize;
        void letterSpacing;
        void textColor;
        void keyringEnabled;
        void keyringOuterSize;
        void keyringHoleSize;
        void keyringDepth;
        void keyringOffsetX;
        void keyringOffsetY;
        saveSettings();
        if (!scene || !group) return;
        rebuildMeshes();
    });

    onMount(() => {
        if (!hostEl) return;
        setTimeout(() => {
            isUpdatingFromStorage = false;
        }, 0);
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xffffff);
        camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
        camera.up.set(0, 0, 1);
        renderer = new THREE.WebGLRenderer({
            antialias: true,
            preserveDrawingBuffer: true,
        });
        renderer.setPixelRatio(
            Math.max(1, Math.min(window.devicePixelRatio || 1, 2)),
        );
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
        controls.minDistance = 20;
        controls.maxDistance = 500;
        controls.update();

        const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.25);
        scene.add(hemi);
        keyLight = new THREE.DirectionalLight(0xffffff, 2);
        keyLight.position.set(80, -100, 120);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.width = 2048;
        keyLight.shadow.mapSize.height = 2048;
        keyLight.shadow.bias = -0.0002;
        keyLight.shadow.normalBias = 0.02;
        scene.add(keyLight);
        scene.add(keyLight.target);

        const rim = new THREE.DirectionalLight(0xffffff, 0.6);
        rim.position.set(-100, 80, 60);
        scene.add(rim);

        const grid = new THREE.GridHelper(200, 20, 0xcbd5e1, 0xe2e8f0);
        grid.rotation.x = Math.PI / 2;
        grid.position.z = -0.01;
        scene.add(grid);

        group = new THREE.Group();
        scene.add(group);

        ro = new ResizeObserver(() => resize());
        ro.observe(hostEl);
        resize();
        rebuildMeshes();

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
        ro?.disconnect();
        ro = null;
        if (group) {
            disposeObject3D(group);
            group.clear();
        }
        controls?.dispose();
        controls = null;
        if (renderer && hostEl && renderer.domElement.parentElement === hostEl)
            hostEl.removeChild(renderer.domElement);
        renderer?.dispose();
        renderer = null;
        scene = null;
        camera = null;
        group = null;
        keyLight = null;
    });
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
    <div
        class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
        <aside
            class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]">
            <div class="flex shrink-0 items-center justify-between p-4">
                <h1 class="text-lg font-semibold tracking-tight text-slate-900">
                    Bumpy Text
                </h1>
                <Button variant="outline" size="sm" onclick={onBack}>
                    Back
                </Button>
            </div>

            <div
                class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
                <p class="text-xs text-slate-500">
                    Simple text with no base. Each character has a random
                    thickness.
                </p>

                <div class="grid grid-cols-1 gap-4">
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Text</span>
                        <input
                            type="text"
                            class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            bind:value={textContent}
                            placeholder="Name" />
                    </label>

                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Font</span>
                        <FontSelect
                            bind:value={fontKey}
                            options={BUMPY_FONT_OPTIONS} />
                    </label>

                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Text size</span>
                            <span class="text-xs tabular-nums text-slate-600"
                                >{textSize}</span>
                        </div>
                        <Slider
                            type="single"
                            bind:value={textSize}
                            min={6}
                            max={36}
                            step={1}
                            class="w-full" />
                    </label>

                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Letter spacing</span>
                            <span class="text-xs tabular-nums text-slate-600">
                                {letterSpacing === 0
                                    ? "normal"
                                    : `${letterSpacing > 0 ? "+" : ""}${letterSpacing.toFixed(1)} mm`}
                            </span>
                        </div>
                        <Slider
                            type="single"
                            bind:value={letterSpacing}
                            min={-3}
                            max={3}
                            step={0.1}
                            class="w-full" />
                        <span class="text-[10px] text-slate-500"
                            >0 = normal; negative = tighter</span>
                    </label>

                    <ColorPalettePicker
                        bind:value={textColor}
                        {palette}
                        label="Text color" />

                    <div
                        class="rounded-2xl border border-slate-200 bg-slate-50/60 p-3 space-y-3">
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-semibold text-slate-700"
                                >Keyring</span>
                            <label
                                class="flex items-center gap-2 text-xs font-medium text-slate-700">
                                <input
                                    type="checkbox"
                                    class="h-4 w-4 accent-indigo-500"
                                    bind:checked={keyringEnabled} />
                                Enabled
                            </label>
                        </div>
                        {#if keyringEnabled}
                            <label class="grid gap-1.5">
                                <div
                                    class="flex items-center justify-between gap-2">
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Ring size</span>
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{keyringOuterSize}</span>
                                </div>
                                <Slider
                                    type="single"
                                    bind:value={keyringOuterSize}
                                    min={4}
                                    max={15}
                                    step={0.5}
                                    class="w-full" />
                            </label>
                            <label class="grid gap-1.5">
                                <div
                                    class="flex items-center justify-between gap-2">
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Hole size</span>
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{keyringHoleSize}</span>
                                </div>
                                <Slider
                                    type="single"
                                    bind:value={keyringHoleSize}
                                    min={2}
                                    max={Math.max(2, keyringOuterSize - 1)}
                                    step={0.5}
                                    class="w-full" />
                            </label>
                            <label class="grid gap-1.5">
                                <div
                                    class="flex items-center justify-between gap-2">
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Ring thickness</span>
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{keyringDepth.toFixed(1)} mm</span>
                                </div>
                                <Slider
                                    type="single"
                                    bind:value={keyringDepth}
                                    min={0.5}
                                    max={4}
                                    step={0.1}
                                    class="w-full" />
                            </label>
                            <div class="grid grid-cols-2 gap-3">
                                <label class="grid gap-1.5">
                                    <div
                                        class="flex items-center justify-between gap-2">
                                        <span
                                            class="text-xs font-medium text-slate-700"
                                            >Pos X</span>
                                        <span
                                            class="text-xs tabular-nums text-slate-600"
                                            >{keyringOffsetX}</span>
                                    </div>
                                    <Slider
                                        type="single"
                                        bind:value={keyringOffsetX}
                                        min={-40}
                                        max={40}
                                        step={0.5}
                                        class="w-full" />
                                </label>
                                <label class="grid gap-1.5">
                                    <div
                                        class="flex items-center justify-between gap-2">
                                        <span
                                            class="text-xs font-medium text-slate-700"
                                            >Pos Y</span>
                                        <span
                                            class="text-xs tabular-nums text-slate-600"
                                            >{keyringOffsetY}</span>
                                    </div>
                                    <Slider
                                        type="single"
                                        bind:value={keyringOffsetY}
                                        min={-40}
                                        max={40}
                                        step={0.5}
                                        class="w-full" />
                                </label>
                            </div>
                        {/if}
                    </div>

                    {#if exportError}
                        <p class="text-sm text-red-600">{exportError}</p>
                    {/if}
                </div>
            </div>
        </aside>

        <section
            class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]">
            <DesignerModelDimensionsHud sizes={modelAabbMm} />
            <div bind:this={hostEl} class="absolute inset-0"></div>
            <div class="absolute bottom-4 right-4">
                <DesignerExportToolbar
                    onSnapshot={() => {
                        if (renderer && scene && camera)
                            downloadSnapshot(
                                renderer,
                                scene,
                                camera,
                                "bumpy-text",
                            );
                    }}
                    onExport={() => (user && subscriptionStatus?.isActive ? exportSTL() : onShowPricing?.())}
                    onExport3MF={() => (user && subscriptionStatus?.isActive ? export3MF() : onShowPricing?.())}
                    onOpenWithBambuStudio={() => (user && subscriptionStatus?.isActive ? openWithBambuStudio() : onShowPricing?.())}
                    openBambuStudioLoading={openBambuStudioLoading}
                    exportDisabled={false}
                    exportTitle={getExportTitle(user, subscriptionStatus, "Export STL or 3MF")}
                    {exportLoading}
                    showLockIcon={!user || !subscriptionStatus?.isActive} />
            </div>
        </section>
    </div>
</main>
