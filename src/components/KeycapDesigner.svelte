<script lang="ts">
    import type { Session, User } from "@supabase/supabase-js";
    import ClipperLib from "clipper-lib";
    import { onDestroy, onMount } from "svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import type { LicenseStatus } from "../lib/licensing";
    import { checkLicenseStatus } from "../lib/licensing";
    import { uploadSvgToSupabase } from "../lib/svgUpload";
    import {
        centerGeometryXY,
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        frameCameraToObject,
    } from "../lib/utils";
    import type LicenseModal from "./LicenseModal.svelte";
    import defaultKeycapStlUrl from "../assets/stl/keycap.stl?url";

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

    const PROCESS_URL =
        "https://svg-icon-processor-475432008335.us-central1.run.app/process";

    const KEYCAP_SVG_CACHE_STORAGE = "keycap-svg-cache";
    const KEYCAP_SVG_CURRENT_STORAGE = "keycap-svg-current";
    const MAX_CACHE_ENTRIES = 50;
    const CLIPPER_SCALE = 1000;

    function hashString(s: string): string {
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h = (h << 5) - h + c;
            h = h & h;
        }
        return Math.abs(h).toString(36);
    }

    function getOptimizedCache(): Record<string, string> {
        try {
            const raw = localStorage.getItem(KEYCAP_SVG_CACHE_STORAGE);
            if (raw) return JSON.parse(raw) as Record<string, string>;
        } catch (_) {}
        return {};
    }

    function setOptimizedCache(key: string, optimizedSvg: string) {
        const cache = getOptimizedCache();
        cache[key] = optimizedSvg;
        const keys = Object.keys(cache);
        if (keys.length > MAX_CACHE_ENTRIES) {
            for (let i = 0; i < keys.length - MAX_CACHE_ENTRIES; i++) {
                delete cache[keys[i]];
            }
        }
        try {
            localStorage.setItem(KEYCAP_SVG_CACHE_STORAGE, JSON.stringify(cache));
        } catch (_) {}
    }

    type KeycapSvg =
        | { type: "url"; url: string; optimizedSvg: string }
        | { type: "upload"; name: string; content: string; optimizedSvg: string };

    function getCurrentKeycapSvg(): KeycapSvg | null {
        try {
            const raw = localStorage.getItem(KEYCAP_SVG_CURRENT_STORAGE);
            if (raw) return JSON.parse(raw) as KeycapSvg;
        } catch (_) {}
        return null;
    }

    function setCurrentKeycapSvg(current: KeycapSvg) {
        try {
            localStorage.setItem(
                KEYCAP_SVG_CURRENT_STORAGE,
                JSON.stringify(current),
            );
        } catch (_) {}
    }

    function loadPersistedSvg(): boolean {
        const current = getCurrentKeycapSvg();
        if (!current?.optimizedSvg) return false;
        optimizedSvg = current.optimizedSvg;
        if (current.type === "url") {
            svgUrl = current.url;
            uploadName = current.url;
            sourceSvg = "";
        } else {
            uploadName = current.name;
            sourceSvg = current.content;
            svgUrl = "";
        }
        return true;
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

    let keycapGeometry = $state<THREE.BufferGeometry | null>(null);
    let keycapObjectUrl = $state<string | null>(null);
    let keycapFileName = $state("");
    let uploadName = $state("");
    let svgUrl = $state("");
    let sourceSvg = $state("");
    let optimizedSvg = $state("");
    let processError = $state<string | null>(null);
    let processing = $state(false);
    let showSvgInfoModal = $state(true);
    let exportError = $state<string | null>(null);
    let exportLoading = $state(false);
    let logoDepth = $state(0.5);
    let logoScale = $state(0.6);
    let keycapColor = $state("#ffffff");
    let logoColor = $state("#3898ff");

    function centerAndNormalizeKeycap(geo: THREE.BufferGeometry) {
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        const cx = (bb.min.x + bb.max.x) / 2;
        const cy = (bb.min.y + bb.max.y) / 2;
        const cz = bb.min.z;
        geo.translate(-cx, -cy, -cz);
        geo.computeBoundingBox();
    }

    function resize() {
        if (!renderer || !camera || !hostEl) return;
        const rect = hostEl.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    async function onKeycapSelected(file: File) {
        if (keycapObjectUrl) {
            URL.revokeObjectURL(keycapObjectUrl);
            keycapObjectUrl = null;
        }
        if (keycapGeometry) {
            keycapGeometry.dispose();
            keycapGeometry = null;
        }
        keycapFileName = file.name;
        const url = URL.createObjectURL(file);
        keycapObjectUrl = url;
        const loader = new STLLoader();
        try {
            const geo = await new Promise<THREE.BufferGeometry>((resolve, reject) => {
                loader.load(url, resolve, undefined, reject);
            });
            centerAndNormalizeKeycap(geo);
            keycapGeometry = geo;
        } catch (e) {
            keycapGeometry = null;
            processError = e instanceof Error ? e.message : "Failed to load keycap STL";
        }
    }

    async function onSvgSelected(file: File) {
        processError = null;
        exportError = null;
        uploadName = file.name;
        const raw = await file.text();
        sourceSvg = raw;
        svgUrl = "";
        await processSvg(raw, file.name);
    }

    async function processSvg(rawSvg: string, uploadFileName?: string) {
        processError = null;
        const cacheKey = "upload:" + hashString(rawSvg);
        const cached = getOptimizedCache()[cacheKey];
        if (cached) {
            optimizedSvg = cached;
            if (uploadFileName !== undefined) {
                setCurrentKeycapSvg({
                    type: "upload",
                    name: uploadFileName,
                    content: rawSvg,
                    optimizedSvg: cached,
                });
            }
            return;
        }
        processing = true;
        optimizedSvg = "";
        try {
            const publicUrl = await uploadSvgToSupabase(rawSvg);
            const resp = await fetch(
                `${PROCESS_URL}?url=${encodeURIComponent(publicUrl)}`,
            );
            if (!resp.ok) {
                const text = await resp.text();
                throw new Error(text || `Processor failed (${resp.status})`);
            }
            const processed = await resp.text();
            if (!processed.trim()) throw new Error("Processor returned empty SVG");
            optimizedSvg = processed;
            setOptimizedCache(cacheKey, processed);
            if (uploadFileName !== undefined) {
                setCurrentKeycapSvg({
                    type: "upload",
                    name: uploadFileName,
                    content: rawSvg,
                    optimizedSvg: processed,
                });
            }
        } catch (e) {
            processError = e instanceof Error ? e.message : "Failed to process SVG";
        } finally {
            processing = false;
        }
    }

    async function processSvgFromUrl() {
        const input = svgUrl.trim();
        if (!input) return;
        processError = null;
        exportError = null;
        const cacheKey = "url:" + hashString(input);
        const cached = getOptimizedCache()[cacheKey];
        if (cached) {
            optimizedSvg = cached;
            uploadName = input;
            setCurrentKeycapSvg({ type: "url", url: input, optimizedSvg: cached });
            return;
        }
        processing = true;
        optimizedSvg = "";
        try {
            const resp = await fetch(
                `${PROCESS_URL}?url=${encodeURIComponent(input)}`,
            );
            if (!resp.ok) {
                const text = await resp.text();
                throw new Error(text || `Processor failed (${resp.status})`);
            }
            const processed = await resp.text();
            if (!processed.trim()) throw new Error("Processor returned empty SVG");
            optimizedSvg = processed;
            uploadName = input;
            setOptimizedCache(cacheKey, processed);
            setCurrentKeycapSvg({ type: "url", url: input, optimizedSvg: processed });
        } catch (e) {
            processError = e instanceof Error ? e.message : "Failed to process URL";
        } finally {
            processing = false;
        }
    }

    function buildLogoGeometry(): THREE.BufferGeometry | null {
        if (!optimizedSvg.trim()) return null;
        const loader = new SVGLoader();
        const parsed = loader.parse(optimizedSvg);
        const shapes: THREE.Shape[] = [];
        for (const p of parsed.paths) {
            const pShapes = SVGLoader.createShapes(p);
            for (const s of pShapes) shapes.push(s);
        }
        if (shapes.length === 0) return null;

        const divisions = 20;
        const shapeToPaths = (shape: THREE.Shape) => {
            const toPath = (pts: THREE.Vector2[]) => {
                const out: { X: number; Y: number }[] = [];
                for (const p of pts) {
                    out.push({
                        X: Math.round(p.x * CLIPPER_SCALE),
                        Y: Math.round(-p.y * CLIPPER_SCALE),
                    });
                }
                if (out.length > 2) {
                    const a = out[0];
                    const b = out[out.length - 1];
                    if (a.X === b.X && a.Y === b.Y) out.pop();
                }
                return out;
            };
            const outer = toPath(shape.getPoints(divisions));
            const holes = (shape.holes || []).map((h) =>
                toPath(h.getPoints(divisions)),
            );
            return { outer, holes };
        };
        const ensureCW = (path: { X: number; Y: number }[], clockwise: boolean) => {
            const isCW = ClipperLib.Clipper.Orientation(path);
            if (isCW !== clockwise) path.reverse();
        };
        const inputPaths: { X: number; Y: number }[][] = [];
        for (const s of shapes) {
            const { outer, holes } = shapeToPaths(s);
            if (outer.length < 3) continue;
            ensureCW(outer, true);
            inputPaths.push(outer);
            for (const h of holes) {
                if (h.length < 3) continue;
                ensureCW(h, false);
                inputPaths.push(h);
            }
        }
        if (inputPaths.length === 0) return null;

        const filledTree = new ClipperLib.PolyTree();
        const c = new ClipperLib.Clipper();
        c.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
        c.Execute(
            ClipperLib.ClipType.ctUnion,
            filledTree,
            ClipperLib.PolyFillType.pftNonZero,
            ClipperLib.PolyFillType.pftNonZero,
        );

        const polyTreeToThreeShapes = (tree: any) => {
            const out: THREE.Shape[] = [];
            const toVec2 = (pt: { X: number; Y: number }) =>
                new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE);
            const buildFromOuter = (outerNode: any): THREE.Shape | null => {
                const contour = outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
                if (!contour || contour.length < 3) return null;
                const outerPts = contour.map(toVec2);
                if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
                const shape = new THREE.Shape(outerPts);
                const children = outerNode.Childs?.() ?? outerNode.m_Childs ?? [];
                for (const ch of children) {
                    const isHole = ch.IsHole?.() ?? ch.m_IsHole;
                    if (!isHole) continue;
                    const holeContour = ch.Contour?.() ?? ch.m_polygon ?? [];
                    if (holeContour.length >= 3) {
                        const holePts = holeContour.map(toVec2);
                        if (!THREE.ShapeUtils.isClockWise(holePts)) holePts.reverse();
                        shape.holes.push(new THREE.Path(holePts));
                    }
                }
                return shape;
            };
            const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
            for (const n of roots) {
                const isHole = n.IsHole?.() ?? n.m_IsHole;
                if (isHole) continue;
                const s = buildFromOuter(n);
                if (s) out.push(s);
            }
            return out;
        };

        const logoShapes = polyTreeToThreeShapes(filledTree);
        if (logoShapes.length === 0) return null;

        const depth = Math.max(0.05, logoDepth);
        const logoGeo = new THREE.ExtrudeGeometry(logoShapes, {
            depth,
            bevelEnabled: false,
            curveSegments: 12,
            steps: 1,
        });
        logoGeo.computeVertexNormals();
        centerGeometryXY(logoGeo);
        logoGeo.computeBoundingBox();
        return logoGeo;
    }

    function rebuildMeshes() {
        if (!group) return;
        disposeObject3D(group);
        group.clear();
        processError = null;

        if (keycapGeometry) {
            keycapGeometry.computeBoundingBox();
        }

        if (keycapGeometry) {
            const keycapMat = new THREE.MeshStandardMaterial({
                color: keycapColor,
                roughness: 0.7,
                metalness: 0.1,
            });
            const keycapMesh = new THREE.Mesh(keycapGeometry, keycapMat);
            keycapMesh.castShadow = true;
            keycapMesh.receiveShadow = true;
            group.add(keycapMesh);
        }

        if (optimizedSvg.trim() && keycapGeometry?.boundingBox) {
            const logoGeo = buildLogoGeometry();
            if (logoGeo) {
                const bb = keycapGeometry.boundingBox;
                const keycapMaxZ = bb.max.z;
                const keycapCenterX = (bb.min.x + bb.max.x) / 2;
                const keycapCenterY = (bb.min.y + bb.max.y) / 2;
                const keycapW = Math.max(0.01, bb.max.x - bb.min.x);
                const keycapH = Math.max(0.01, bb.max.y - bb.min.y);

                const logoBb = logoGeo.boundingBox!;
                const logoW = Math.max(0.01, logoBb.max.x - logoBb.min.x);
                const logoH = Math.max(0.01, logoBb.max.y - logoBb.min.y);
                const scale = Math.min(
                    (keycapW * logoScale) / logoW,
                    (keycapH * logoScale) / logoH,
                );
                logoGeo.scale(scale, scale, 1);
                logoGeo.computeBoundingBox();

                const depth = Math.max(0.05, logoDepth);
                const logoMat = new THREE.MeshStandardMaterial({
                    color: logoColor,
                    roughness: 0.4,
                    metalness: 0.1,
                });
                const logoMesh = new THREE.Mesh(logoGeo, logoMat);
                logoMesh.castShadow = true;
                logoMesh.receiveShadow = true;
                logoMesh.position.set(
                    keycapCenterX,
                    keycapCenterY,
                    keycapMaxZ,
                );
                group.add(logoMesh);
            }
        } else if (optimizedSvg.trim()) {
            const logoGeo = buildLogoGeometry();
            if (logoGeo) {
                const logoMat = new THREE.MeshStandardMaterial({
                    color: logoColor,
                    roughness: 0.4,
                    metalness: 0.1,
                });
                const logoMesh = new THREE.Mesh(logoGeo, logoMat);
                logoMesh.castShadow = true;
                logoMesh.receiveShadow = true;
                group.add(logoMesh);
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
        const hasContent = keycapGeometry != null && group.children.length > 0;
        const boxValid = !box.isEmpty() && box.getSize(new THREE.Vector3()).lengthSq() > 1e-6;
        if (!didInitFrame && camera && controls && hasContent && boxValid) {
            frameCameraToObject(box, camera, controls);
            didInitFrame = true;
        }
    }

    async function exportStl() {
        if (!user) {
            onRequestLogin();
            return;
        }
        const status = await checkLicenseStatus(user);
        if (!status.canExport) {
            licenseModalRef?.open();
            return;
        }
        if (!group || group.children.length === 0) {
            exportError = "Add a keycap and an icon to export";
            return;
        }
        exportError = null;
        exportLoading = true;
        try {
            const geometries: THREE.BufferGeometry[] = [];
            for (const child of group.children) {
                if ((child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
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
            const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
            welded.dispose();
            const buffer = result instanceof DataView ? result.buffer : result;
            if (!buffer || (buffer as ArrayBuffer).byteLength < 84) {
                exportError = "Export produced empty geometry";
                return;
            }
            const slug = (keycapFileName || uploadName || "keycap")
                .toLowerCase()
                .replace(/\.(stl|svg)$/i, "")
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "");
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(
                `${slug || "keycap"}-${ts}.stl`,
                new Blob([buffer], { type: "model/stl" }),
            );
            if (status.type === "trial") onShowThankYou();
        } catch (e) {
            exportError = e instanceof Error ? e.message : "Export failed";
        } finally {
            exportLoading = false;
        }
    }

    $effect(() => {
        void keycapGeometry;
        void optimizedSvg;
        void logoDepth;
        void logoScale;
        void keycapColor;
        void logoColor;
        if (!scene || !group) return;
        rebuildMeshes();
    });

    onMount(() => {
        loadPersistedSvg();
        if (!hostEl) return;
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xffffff);
        camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
        camera.up.set(0, 0, 1);
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
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

        const grid = new THREE.GridHelper(240, 24, 0xd1d5db, 0xe5e7eb);
        grid.rotateX(Math.PI / 2);
        grid.position.z = -0.01;
        scene.add(grid);

        const loader = new STLLoader();
        loader.load(defaultKeycapStlUrl, (geometry: THREE.BufferGeometry) => {
            centerAndNormalizeKeycap(geometry);
            keycapGeometry = geometry;
            keycapFileName = "keycap.stl";
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
        if (keycapObjectUrl) {
            URL.revokeObjectURL(keycapObjectUrl);
            keycapObjectUrl = null;
        }
        if (keycapGeometry) {
            keycapGeometry.dispose();
            keycapGeometry = null;
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
    <div class="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-4 lg:flex-row min-h-0">
        <aside
            class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]"
        >
            <div class="mb-4 flex shrink-0 items-center justify-between p-4">
                <h1 class="text-lg font-semibold tracking-tight text-slate-900">
                    Keycap Maker
                </h1>
                <button
                    type="button"
                    class="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    onclick={onBack}
                >
                    Back
                </button>
            </div>

            <div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden pr-1 p-4 pt-0">
                <p class="text-xs text-slate-500">
                    Upload a flat keycap base (STL) and an SVG icon. The icon is centered on the top of the keycap. Some SVGs may produce unexpected results.
                </p>

                <div>
                    <label
                        for="keycap-stl-input"
                        class="mb-1 block text-xs font-medium text-slate-700"
                    >
                        Keycap base (STL)
                    </label>
                    <input
                        id="keycap-stl-input"
                        type="file"
                        accept=".stl"
                        class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                        onchange={(e) => {
                            const input = e.currentTarget as HTMLInputElement;
                            const file = input.files?.[0];
                            if (file) void onKeycapSelected(file);
                        }}
                    />
                    {#if keycapFileName}
                        <p class="mt-1 text-xs text-slate-500 truncate">
                            {keycapFileName}
                        </p>
                    {/if}
                </div>

                <div class="h-px bg-slate-200"></div>

                <div>
                    <label
                        for="keycap-svg-url-input"
                        class="mb-1 block text-xs font-medium text-slate-700"
                    >
                        Icon SVG URL
                    </label>
                    <div class="flex items-center gap-2">
                        <input
                            id="keycap-svg-url-input"
                            type="url"
                            placeholder="https://..."
                            class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            bind:value={svgUrl}
                            disabled={processing}
                        />
                        <button
                            type="button"
                            class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            onclick={() => void processSvgFromUrl()}
                            disabled={processing || !svgUrl.trim()}
                        >
                            Process
                        </button>
                    </div>
                </div>

                <div>
                    <label
                        for="keycap-svg-upload-input"
                        class="mb-1 block text-xs font-medium text-slate-700"
                    >
                        Upload icon SVG
                    </label>
                    <input
                        id="keycap-svg-upload-input"
                        type="file"
                        accept=".svg,image/svg+xml"
                        class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                        onchange={(e) => {
                            const input = e.currentTarget as HTMLInputElement;
                            const file = input.files?.[0];
                            if (file) void onSvgSelected(file);
                        }}
                    />
                    {#if uploadName}
                        <p class="mt-1 text-xs text-slate-500 truncate">
                            {uploadName}
                        </p>
                    {/if}
                </div>

                {#if keycapGeometry && optimizedSvg}
                    <div>
                        <div class="mb-1 flex items-center justify-between">
                            <label
                                for="keycap-logo-scale"
                                class="text-xs font-medium text-slate-700"
                            >
                                Icon size
                            </label>
                            <span class="text-xs text-slate-500">
                                {(logoScale * 100).toFixed(0)}%
                            </span>
                        </div>
                        <input
                            id="keycap-logo-scale"
                            type="range"
                            min="0.2"
                            max="1"
                            step="0.05"
                            bind:value={logoScale}
                            class="w-full"
                            disabled={!optimizedSvg || processing}
                        />
                    </div>

                    <div>
                        <div class="mb-1 flex items-center justify-between">
                            <label
                                for="keycap-logo-depth"
                                class="text-xs font-medium text-slate-700"
                            >
                                Icon depth
                            </label>
                            <span class="text-xs text-slate-500">
                                {logoDepth.toFixed(1)} mm
                            </span>
                        </div>
                        <input
                            id="keycap-logo-depth"
                            type="range"
                            min="0.1"
                            max="2"
                            step="0.05"
                            bind:value={logoDepth}
                            class="w-full"
                            disabled={!optimizedSvg || processing}
                        />
                    </div>

                    <div class="grid grid-cols-2 gap-3">
                        <label class="grid gap-1.5" for="keycap-color-text">
                            <span class="text-xs font-medium text-slate-700"
                                >Keycap color</span
                            >
                            <div class="flex items-center gap-2">
                                <input
                                    id="keycap-color"
                                    class="h-10 w-10 rounded-xl"
                                    type="color"
                                    bind:value={keycapColor}
                                    disabled={!keycapGeometry || processing}
                                />
                                <input
                                    id="keycap-color-text"
                                    class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                    type="text"
                                    bind:value={keycapColor}
                                    disabled={!keycapGeometry || processing}
                                />
                            </div>
                        </label>
                        <label class="grid gap-1.5" for="keycap-logo-color-text">
                            <span class="text-xs font-medium text-slate-700"
                                >Icon color</span
                            >
                            <div class="flex items-center gap-2">
                                <input
                                    id="keycap-logo-color"
                                    class="h-10 w-10 rounded-xl"
                                    type="color"
                                    bind:value={logoColor}
                                    disabled={!optimizedSvg || processing}
                                />
                                <input
                                    id="keycap-logo-color-text"
                                    class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                    type="text"
                                    bind:value={logoColor}
                                    disabled={!optimizedSvg || processing}
                                />
                            </div>
                        </label>
                    </div>
                {/if}

                {#if processError}
                    <p class="text-xs text-red-600">{processError}</p>
                {/if}
                {#if exportError}
                    <p class="text-xs text-red-600">{exportError}</p>
                {/if}
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
                        downloadSnapshot(
                            renderer,
                            scene,
                            camera,
                            "keycap-designer",
                        )}
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
                    class="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold tracking-tight text-slate-900 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                    type="button"
                    onclick={exportStl}
                    disabled={!keycapGeometry ||
                        !optimizedSvg ||
                        processing ||
                        exportLoading ||
                        !user ||
                        licenseStatus?.canExport === false}
                    title={!user
                        ? "Sign in to export"
                        : licenseStatus?.canExport === false
                            ? "License required to export"
                            : "Export STL"}
                >
                    {#if exportLoading}
                        Exporting…
                    {:else}
                        Export STL
                    {/if}
                </button>
            </div>
        </section>
    </div>

    {#if showSvgInfoModal}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="keycap-svg-info-modal-title"
            onclick={() => (showSvgInfoModal = false)}
            onkeydown={(e) => e.key === "Escape" && (showSvgInfoModal = false)}
            tabindex="-1"
        >
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
                onclick={(e) => e.stopPropagation()}
            >
                <h2
                    id="keycap-svg-info-modal-title"
                    class="text-lg font-semibold text-slate-900"
                >
                    Before you start
                </h2>
                <p class="mt-1 text-sm text-slate-600">
                    For the best results with custom SVGs, please keep these in mind:
                </p>
                <ul class="mt-3 list-inside list-disc space-y-2 text-sm text-slate-600">
                    <li><strong>Compatibility:</strong> Not every SVG will work—complex paths, filters, or unsupported features may cause issues.</li>
                    <li><strong>Format:</strong> Use black-and-white artwork only, and keep file size under 1 MB.</li>
                    <li><strong>Extrusion:</strong> We extrude a single flat layer from your paths; grays, gradients, and shading are ignored—only the outline shape is used.</li>
                </ul>
                <div class="mt-5 flex justify-end">
                    <button
                        type="button"
                        class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                        onclick={() => (showSvgInfoModal = false)}
                    >
                        Got it
                    </button>
                </div>
            </div>
        </div>
    {/if}

    {#if processing}
        <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="keycap-processing-loading-title"
            aria-busy="true"
        >
            <div
                class="relative w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
            >
                <div class="flex flex-col items-center gap-4 text-center">
                    <div
                        class="h-10 w-10 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"
                        aria-hidden="true"
                    ></div>
                    <div class="space-y-1">
                        <h2
                            id="keycap-processing-loading-title"
                            class="text-lg font-semibold text-slate-900"
                        >
                            Processing SVG
                        </h2>
                        <p class="text-sm text-slate-600">
                            Preparing your icon for the keycap…
                        </p>
                    </div>
                </div>
            </div>
        </div>
    {/if}
</main>
