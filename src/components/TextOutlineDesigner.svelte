<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import { type LicenseStatus, checkLicenseStatus } from "../lib/licensing";
    import type { User, Session } from "@supabase/supabase-js";
    import type LicenseModal from "./LicenseModal.svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import ClipperLib from "clipper-lib";
    import {
        type FontSettings,
        type CharSettings,
        FONT_OPTIONS,
        DEFAULT_FONT_SETTINGS_OUTLINE,
        DEFAULT_CHAR_SETTINGS,
        DEFAULT_FONT_KEY_OUTLINE,
        DEFAULT_TEXT,
        getFont,
        centerGeometryXY,
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        frameCameraToObject,
        loadFontSettingsFromStorage,
        loadCharSettingsFromStorage,
    } from "../lib/utils";

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

    // ── Storage keys (outline-specific) ─────────────────────────────────────
    const STORAGE_KEY_SETTINGS = "keychain-outline-font-settings";
    const STORAGE_KEY_KEYRING = "keychain-outline-keyring-settings";
    const STORAGE_KEY_TEXT = "keychain-outline-text";
    const STORAGE_KEY_FONT = "keychain-outline-font";

    /** Z amount text is sunk into the base so they overlap (avoids non-manifold at contact). */
    const TEXT_BASE_EMBED = 0.2;
    // ── Persistence state ───────────────────────────────────────────────────
    let allFontSettings: Record<string, FontSettings> =
        loadFontSettingsFromStorage(STORAGE_KEY_SETTINGS);
    let allCharSettings: Record<
        string,
        Record<string, CharSettings>
    > = loadCharSettingsFromStorage(STORAGE_KEY_KEYRING);
    let isUpdatingFromStorage = $state(true);
    let lastFont = "";
    let lastChar = "";

    const defaults = DEFAULT_FONT_SETTINGS_OUTLINE;

    // Restore text and fontKey from localStorage (survive navigation)
    const restoredText = (() => {
        try {
            return localStorage.getItem(STORAGE_KEY_TEXT) ?? DEFAULT_TEXT;
        } catch {
            return DEFAULT_TEXT;
        }
    })();
    const restoredFont = (() => {
        try {
            const f = localStorage.getItem(STORAGE_KEY_FONT);
            return f && FONT_OPTIONS.some((o) => o.key === f)
                ? f
                : DEFAULT_FONT_KEY_OUTLINE;
        } catch {
            return DEFAULT_FONT_KEY_OUTLINE;
        }
    })();

    const fontSettings = allFontSettings[restoredFont] || defaults;
    const initialChar =
        restoredText.length > 0 ? restoredText.charAt(0).toUpperCase() : "";
    const charSettings =
        allCharSettings[restoredFont]?.[initialChar] || DEFAULT_CHAR_SETTINGS;

    // ── Reactive state ──────────────────────────────────────────────────────
    let text = $state(restoredText);
    let textSize = $state(fontSettings.textSize);
    let outlineOffsetPx = $state(fontSettings.outlineOffsetPx);
    let baseDepth = $state(fontSettings.baseDepth);
    let textDepth = $state(fontSettings.textDepth);
    let textColor = $state(fontSettings.textColor);
    let outlineColor = $state(fontSettings.outlineColor);
    let fontKey = $state(restoredFont);
    let keyringEnabled = $state(fontSettings.keyringEnabled ?? true);
    let keyringOuterSize = $state(charSettings.keyringOuterSize);
    let keyringHoleSize = $state(charSettings.keyringHoleSize);
    let keyringOffsetX = $state(charSettings.keyringOffsetX);
    let keyringOffsetY = $state(charSettings.keyringOffsetY);

    lastFont = restoredFont;
    lastChar = initialChar;

    function getCurrentChar(): string {
        return text.length > 0 ? text.charAt(0).toUpperCase() : "";
    }

    // ── Three.js state ──────────────────────────────────────────────────────
    let hostEl: HTMLDivElement | null = null;
    let renderer: any = null;
    let scene: any = null;
    let camera: any = null;
    let controls: any = null;
    let font: any = null;
    let group: any = null;
    let keyLight: any = null;
    let shadowPlane: any = null;
    let rafId = 0;
    let ro: ResizeObserver | null = null;
    let didInitFrame = false;

    // ── Dropdown state ──────────────────────────────────────────────────────
    let fontDropdownOpen = $state(false);
    let fontDropdownRef: HTMLDivElement | null = null;

    // ── Persistence helpers ─────────────────────────────────────────────────
    function loadSettingsForFont(fontName: string) {
        if (!allFontSettings) allFontSettings = {};
        const settings = allFontSettings[fontName] || { ...defaults };
        textSize = settings.textSize;
        outlineOffsetPx = settings.outlineOffsetPx;
        baseDepth = settings.baseDepth;
        textDepth = settings.textDepth;
        textColor = settings.textColor;
        outlineColor = settings.outlineColor;
        if (settings.keyringEnabled !== undefined)
            keyringEnabled = settings.keyringEnabled;
        if (!allFontSettings[fontName])
            allFontSettings[fontName] = { ...defaults };
    }

    function saveSettingsForFont(fontName: string) {
        if (isUpdatingFromStorage || !fontName) return;
        if (!allFontSettings) allFontSettings = {};
        allFontSettings[fontName] = {
            textSize,
            outlineOffsetPx,
            baseDepth,
            textDepth,
            textColor,
            outlineColor,
            keyringEnabled,
        };
        try {
            localStorage.setItem(
                STORAGE_KEY_SETTINGS,
                JSON.stringify(allFontSettings),
            );
        } catch (e) {
            console.error("Failed to save font settings:", e);
        }
    }

    function loadKeyringForChar(fontName: string, char: string) {
        if (!char || !fontName) return;
        const cs = allCharSettings[fontName]?.[char] || DEFAULT_CHAR_SETTINGS;
        keyringOffsetX = cs.keyringOffsetX;
        keyringOffsetY = cs.keyringOffsetY;
        keyringOuterSize = cs.keyringOuterSize;
        keyringHoleSize = cs.keyringHoleSize;
    }

    function saveKeyringForChar(fontName: string, char: string) {
        if (isUpdatingFromStorage || !char || !fontName) return;
        if (!allCharSettings) allCharSettings = {};
        if (!allCharSettings[fontName]) allCharSettings[fontName] = {};
        allCharSettings[fontName][char] = {
            keyringOffsetX,
            keyringOffsetY,
            keyringOuterSize,
            keyringHoleSize,
        };
        try {
            localStorage.setItem(
                STORAGE_KEY_KEYRING,
                JSON.stringify(allCharSettings),
            );
        } catch (e) {
            console.error("Failed to save keyring settings:", e);
        }
    }

    // ── Scene helpers ───────────────────────────────────────────────────────
    function resize() {
        if (!renderer || !camera || !hostEl) return;
        const rect = hostEl.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        renderer.setSize(width, height, true);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
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
            const safe = (text || "model")
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "");
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(`${safe || "model"}-${timestamp}.stl`, blob);
        }
        if (status.type === "trial") onShowThankYou();
    }

    // ── Rebuild meshes (outline only) ───────────────────────────────────────
    function rebuildMeshes() {
        if (!scene || !group || !font) return;
        disposeObject3D(group);
        group.clear();
        group.position.set(0, 0, 0);

        const size = Math.max(1, Math.round(textSize));
        const divisions = 18;
        const SCALE = 1000;

        const shapeToPaths = (shape: any) => {
            const toPath = (pts: any[]) => {
                const out: any[] = [];
                for (const p of pts)
                    out.push({
                        X: Math.round(p.x * SCALE),
                        Y: Math.round(p.y * SCALE),
                    });
                if (out.length > 2) {
                    const a = out[0];
                    const b = out[out.length - 1];
                    if (a.X === b.X && a.Y === b.Y) out.pop();
                }
                return out;
            };
            const outer = toPath(shape.getPoints(divisions));
            const holes = (shape.holes || []).map((h: any) =>
                toPath(h.getPoints(divisions)),
            );
            return { outer, holes };
        };

        const ensureCW = (path: any[], clockwise: boolean) => {
            const isCW = ClipperLib.Clipper.Orientation(path);
            if (isCW !== clockwise) path.reverse();
        };

        const shapes = font.generateShapes(text || " ", size);
        const inputPaths: any[] = [];
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

        const filledTree = new ClipperLib.PolyTree();
        {
            const c = new ClipperLib.Clipper();
            c.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
            c.Execute(
                ClipperLib.ClipType.ctUnion,
                filledTree,
                ClipperLib.PolyFillType.pftNonZero,
                ClipperLib.PolyFillType.pftNonZero,
            );
        }

        const outlineWorld = Math.max(0, outlineOffsetPx) * (size / 60);
        const outlineTree = new ClipperLib.PolyTree();
        if (outlineWorld > 0) {
            const co = new ClipperLib.ClipperOffset(2, 2);
            co.AddPaths(
                inputPaths,
                ClipperLib.JoinType.jtRound,
                ClipperLib.EndType.etClosedPolygon,
            );
            const offsetPaths: any[] = [];
            co.Execute(offsetPaths, outlineWorld * SCALE);
            const c2 = new ClipperLib.Clipper();
            c2.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
            c2.Execute(
                ClipperLib.ClipType.ctUnion,
                outlineTree,
                ClipperLib.PolyFillType.pftNonZero,
                ClipperLib.PolyFillType.pftNonZero,
            );
        } else {
            const c2 = new ClipperLib.Clipper();
            c2.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
            c2.Execute(
                ClipperLib.ClipType.ctUnion,
                outlineTree,
                ClipperLib.PolyFillType.pftNonZero,
                ClipperLib.PolyFillType.pftNonZero,
            );
        }

        let baseTree: any = outlineTree;
        let outlineCenter: { x: number; y: number } | null = null;
        let combinedCenter: { x: number; y: number } | null = null;
        if (keyringEnabled) {
            const circleToPath = (
                cx: number,
                cy: number,
                r: number,
                clockwise: boolean,
                segs = 64,
            ) => {
                const path: { X: number; Y: number }[] = [];
                for (let i = 0; i < segs; i++) {
                    const t = (i / segs) * Math.PI * 2;
                    path.push({
                        X: Math.round((cx + r * Math.cos(t)) * SCALE),
                        Y: Math.round((cy + r * Math.sin(t)) * SCALE),
                    });
                }
                if (path.length < 3) return null;
                const isCW = ClipperLib.Clipper.Orientation(path);
                if (isCW !== clockwise) path.reverse();
                return path;
            };
            const collectOuterPaths = (node: any, out: any[]) => {
                const isHole = node.IsHole?.() ?? node.m_IsHole;
                if (isHole) return;
                const contour = node.Contour?.() ?? node.m_polygon ?? [];
                if (contour.length >= 3) out.push(contour);
                const childs = node.Childs?.() ?? node.m_Childs ?? [];
                childs.forEach((ch: any) => collectOuterPaths(ch, out));
            };
            const getTreeBbox = (tree: any) => {
                let minX = Infinity,
                    maxX = -Infinity,
                    minY = Infinity,
                    maxY = -Infinity;
                const collect = (node: any) => {
                    const contour = node.Contour?.() ?? node.m_polygon ?? [];
                    for (const p of contour) {
                        minX = Math.min(minX, p.X);
                        maxX = Math.max(maxX, p.X);
                        minY = Math.min(minY, p.Y);
                        maxY = Math.max(maxY, p.Y);
                    }
                    const childs = node.Childs?.() ?? node.m_Childs ?? [];
                    childs.forEach(collect);
                };
                const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
                roots.forEach(collect);
                return { minX, maxX, minY, maxY };
            };
            const bbox = getTreeBbox(outlineTree);
            outlineCenter = {
                x: (bbox.minX + bbox.maxX) / 2 / SCALE,
                y: (bbox.minY + bbox.maxY) / 2 / SCALE,
            };
            const cornerX = bbox.minX / SCALE;
            const cornerY = bbox.maxY / SCALE;
            const kx = cornerX + keyringOffsetX;
            const ky = cornerY + keyringOffsetY;
            const outerR = Math.max(0.1, keyringOuterSize / 2);
            const innerR = Math.min(
                Math.max(0.05, keyringHoleSize / 2),
                outerR - 0.1,
            );
            const outerCircle = circleToPath(kx, ky, outerR, true);
            const innerCircle = circleToPath(kx, ky, innerR, false);
            if (outerCircle && innerCircle) {
                const outlinePaths: any[] = [];
                const roots =
                    outlineTree.Childs?.() ?? outlineTree.m_Childs ?? [];
                roots.forEach((n: any) => collectOuterPaths(n, outlinePaths));
                const unionTree = new ClipperLib.PolyTree();
                const unionC = new ClipperLib.Clipper();
                outlinePaths.forEach((p) =>
                    unionC.AddPath(p, ClipperLib.PolyType.ptSubject, true),
                );
                unionC.AddPath(
                    outerCircle,
                    ClipperLib.PolyType.ptSubject,
                    true,
                );
                unionC.Execute(
                    ClipperLib.ClipType.ctUnion,
                    unionTree,
                    ClipperLib.PolyFillType.pftNonZero,
                    ClipperLib.PolyFillType.pftNonZero,
                );
                const diffTree = new ClipperLib.PolyTree();
                const diffPaths: any[] = [];
                const unionRoots =
                    unionTree.Childs?.() ?? unionTree.m_Childs ?? [];
                unionRoots.forEach((n: any) => collectOuterPaths(n, diffPaths));
                const diffC = new ClipperLib.Clipper();
                diffPaths.forEach((p) =>
                    diffC.AddPath(p, ClipperLib.PolyType.ptSubject, true),
                );
                diffC.AddPath(innerCircle, ClipperLib.PolyType.ptClip, true);
                diffC.Execute(
                    ClipperLib.ClipType.ctDifference,
                    diffTree,
                    ClipperLib.PolyFillType.pftNonZero,
                    ClipperLib.PolyFillType.pftNonZero,
                );
                baseTree = diffTree;
                const baseBbox = getTreeBbox(baseTree);
                combinedCenter = {
                    x: (baseBbox.minX + baseBbox.maxX) / 2 / SCALE,
                    y: (baseBbox.minY + baseBbox.maxY) / 2 / SCALE,
                };
            }
        }

        const polyTreeToThreeShapes = (tree: any) => {
            const shapesOut: any[] = [];
            const toVec2 = (pt: any) =>
                new THREE.Vector2(pt.X / SCALE, pt.Y / SCALE);
            const buildFromOuter = (outerNode: any) => {
                const contour =
                    outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
                if (!contour || contour.length < 3) return null;
                // Three.js ExtrudeGeometry expects outer CCW and holes CW
                const outerPts = contour.map(toVec2);
                if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
                const shape = new THREE.Shape(outerPts);
                const children =
                    outerNode.Childs?.() ?? outerNode.m_Childs ?? [];
                for (const ch of children) {
                    const isHole = ch.IsHole?.() ?? ch.m_IsHole;
                    if (!isHole) continue;
                    const holeContour = ch.Contour?.() ?? ch.m_polygon ?? [];
                    if (holeContour.length >= 3) {
                        const holePts = holeContour.map(toVec2);
                        if (!THREE.ShapeUtils.isClockWise(holePts))
                            holePts.reverse();
                        shape.holes.push(new THREE.Path(holePts));
                    }
                    const holeKids = ch.Childs?.() ?? ch.m_Childs ?? [];
                    for (const hk of holeKids) {
                        const hkIsHole = hk.IsHole?.() ?? hk.m_IsHole;
                        if (!hkIsHole) shapesOut.push(buildFromOuter(hk));
                    }
                }
                return shape;
            };
            const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
            for (const n of roots) {
                const isHole = n.IsHole?.() ?? n.m_IsHole;
                if (isHole) continue;
                const s = buildFromOuter(n);
                if (s) shapesOut.push(s);
            }
            return shapesOut;
        };

        const baseShapes = polyTreeToThreeShapes(baseTree);
        const textShapes = polyTreeToThreeShapes(filledTree);

        const baseMat = new THREE.MeshStandardMaterial({
            color: outlineColor,
            roughness: 0.85,
            metalness: 0.05,
        });
        const textMat = new THREE.MeshStandardMaterial({
            color: textColor,
            roughness: 0.35,
            metalness: 0.1,
        });

        const baseGeo = new THREE.ExtrudeGeometry(baseShapes, {
            depth: Math.max(0.1, baseDepth),
            bevelEnabled: false,
            curveSegments: 12,
        });
        centerGeometryXY(baseGeo);
        if (outlineCenter && combinedCenter) {
            baseGeo.translate(
                combinedCenter.x - outlineCenter.x,
                combinedCenter.y - outlineCenter.y,
                0,
            );
        }

        const textGeo = new THREE.ExtrudeGeometry(textShapes, {
            depth: Math.max(0.1, textDepth),
            bevelEnabled: false,
        });
        centerGeometryXY(textGeo);

        const baseMesh = new THREE.Mesh(baseGeo, baseMat);
        const textMesh = new THREE.Mesh(textGeo, textMat);
        baseMesh.castShadow = true;
        baseMesh.receiveShadow = true;
        textMesh.castShadow = true;
        textMesh.receiveShadow = true;
        baseMesh.position.z = 0;
        // Embed text into base so they overlap (avoids non-manifold at contact)
        textMesh.position.z = Math.max(0.1, baseDepth) - TEXT_BASE_EMBED;
        group.add(baseMesh);
        group.add(textMesh);

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

    // ── Click outside ───────────────────────────────────────────────────────
    function handleClickOutside(event: MouseEvent) {
        const target = event.target as Node;
        if (fontDropdownRef && !fontDropdownRef.contains(target))
            fontDropdownOpen = false;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    onMount(() => {
        if (!hostEl) return;
        isUpdatingFromStorage = true;
        if (!allFontSettings[fontKey])
            allFontSettings[fontKey] = { ...defaults };
        font = getFont(fontKey);
        document.addEventListener("click", handleClickOutside);

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
        controls.minDistance = 50;
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
        shadowPlane = new THREE.Mesh(
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
        rebuildMeshes();
        setTimeout(() => {
            isUpdatingFromStorage = false;
        }, 0);
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

    // Persist text and fontKey so they survive navigation
    $effect(() => {
        try {
            localStorage.setItem(STORAGE_KEY_TEXT, text);
        } catch {}
    });
    $effect(() => {
        try {
            localStorage.setItem(STORAGE_KEY_FONT, fontKey);
        } catch {}
    });

    $effect(() => {
        const currentFont = fontKey;
        const currentChar = getCurrentChar();
        if (user && licenseStatus?.type === "trial") {
            const firstFontKey = FONT_OPTIONS[0]?.key;
            if (currentFont !== firstFontKey && firstFontKey) {
                fontKey = firstFontKey;
                return;
            }
        }
        if (currentFont !== lastFont) {
            if (lastFont && lastChar) {
                const wasUpdating = isUpdatingFromStorage;
                isUpdatingFromStorage = false;
                saveSettingsForFont(lastFont);
                saveKeyringForChar(lastFont, lastChar);
                isUpdatingFromStorage = wasUpdating;
            }
            isUpdatingFromStorage = true;
            lastFont = currentFont;
            loadSettingsForFont(currentFont);
            if (currentChar) {
                loadKeyringForChar(currentFont, currentChar);
                lastChar = currentChar;
            }
            setTimeout(() => {
                isUpdatingFromStorage = false;
            }, 0);
            if (scene) {
                font = getFont(fontKey);
                rebuildMeshes();
            }
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
        if (isUpdatingFromStorage || !fontKey) return;
        void textSize;
        void outlineOffsetPx;
        void baseDepth;
        void textDepth;
        void textColor;
        void outlineColor;
        void keyringEnabled;
        saveSettingsForFont(fontKey);
    });

    $effect(() => {
        if (isUpdatingFromStorage) return;
        const currentChar = getCurrentChar();
        const currentFont = fontKey;
        void keyringOffsetX;
        void keyringOffsetY;
        void keyringOuterSize;
        void keyringHoleSize;
        if (currentChar && currentFont)
            saveKeyringForChar(currentFont, currentChar);
    });

    $effect(() => {
        void text;
        void textSize;
        void outlineOffsetPx;
        void baseDepth;
        void textDepth;
        void textColor;
        void outlineColor;
        void keyringEnabled;
        void keyringOuterSize;
        void keyringHoleSize;
        void keyringOffsetX;
        void keyringOffsetY;
        if (!scene) return;
        rebuildMeshes();
    });

    onDestroy(() => {
        cancelAnimationFrame(rafId);
        rafId = 0;
        ro?.disconnect();
        ro = null;
        document.removeEventListener("click", handleClickOutside);
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
        font = null;
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
                    Text Only
                </h2>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
                <div class="grid grid-cols-1 gap-4">
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Text</span
                        >
                        <input
                            class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2"
                            type="text"
                            bind:value={text}
                        />
                    </label>

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
                                        (f) => f.key === fontKey,
                                    )?.fontFamily || 'inherit'}"
                                >
                                    {FONT_OPTIONS.find((f) => f.key === fontKey)
                                        ?.label || "Select font"}
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
                                            licenseStatus?.type === "trial" &&
                                            !isFirstFont}
                                        <button
                                            type="button"
                                            class="w-full px-3 py-2 text-left text-sm transition-colors {fontKey ===
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
                                                fontKey = f.key;
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

                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Text size</span
                            >
                            <span class="text-xs tabular-nums text-slate-600"
                                >{textSize}</span
                            >
                        </div>
                        <input
                            class="w-full accent-indigo-500"
                            type="range"
                            min="6"
                            max="72"
                            step="1"
                            bind:value={textSize}
                        />
                    </label>

                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Outline thickness</span
                            >
                            <span class="text-xs tabular-nums text-slate-600"
                                >{outlineOffsetPx}px</span
                            >
                        </div>
                        <input
                            class="w-full accent-indigo-500"
                            type="range"
                            min="5"
                            max="30"
                            step="1"
                            bind:value={outlineOffsetPx}
                        />
                    </label>

                    <div class="grid grid-cols-2 gap-3">
                        <label class="grid gap-1.5">
                            <span class="text-xs font-medium text-slate-700"
                                >Text color</span
                            >
                            <div class="flex items-center gap-2">
                                <input
                                    class="h-10 w-10 rounded-xl"
                                    type="color"
                                    bind:value={textColor}
                                />
                                <input
                                    class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                    type="text"
                                    bind:value={textColor}
                                />
                            </div>
                        </label>
                        <label class="grid gap-1.5">
                            <span class="text-xs font-medium text-slate-700"
                                >Outline color</span
                            >
                            <div class="flex items-center gap-2">
                                <input
                                    class="h-10 w-10 rounded-xl"
                                    type="color"
                                    bind:value={outlineColor}
                                />
                                <input
                                    class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                    type="text"
                                    bind:value={outlineColor}
                                />
                            </div>
                        </label>
                    </div>

                    <div
                        class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3"
                    >
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700"
                        >
                            Extrusion
                        </div>
                        <div class="grid grid-cols-2 gap-3">
                            <label class="grid gap-1.5">
                                <div
                                    class="flex items-center justify-between gap-2"
                                >
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Base depth</span
                                    >
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{baseDepth}</span
                                    >
                                </div>
                                <input
                                    class="w-full accent-indigo-500"
                                    type="range"
                                    min="1"
                                    max="20"
                                    step="0.2"
                                    bind:value={baseDepth}
                                />
                            </label>
                            <label class="grid gap-1.5">
                                <div
                                    class="flex items-center justify-between gap-2"
                                >
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Text depth</span
                                    >
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{textDepth}</span
                                    >
                                </div>
                                <input
                                    class="w-full accent-indigo-500"
                                    type="range"
                                    min="1"
                                    max="20"
                                    step="0.2"
                                    bind:value={textDepth}
                                />
                            </label>
                        </div>
                    </div>

                    <div
                        class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3"
                    >
                        <div class="flex items-center justify-between">
                            <div
                                class="text-xs font-semibold tracking-tight text-slate-700"
                            >
                                Keyring
                            </div>
                            <label
                                class="flex items-center gap-2 text-xs font-medium text-slate-700"
                            >
                                <input
                                    class="h-4 w-4 accent-indigo-500"
                                    type="checkbox"
                                    bind:checked={keyringEnabled}
                                />
                                Enabled
                            </label>
                        </div>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Ring size</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{keyringOuterSize}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="4"
                                max="15"
                                step="0.5"
                                bind:value={keyringOuterSize}
                            />
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Hole size</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{keyringHoleSize}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="2"
                                max={Math.max(1, keyringOuterSize - 1)}
                                step="0.5"
                                bind:value={keyringHoleSize}
                            />
                        </label>
                        <div class="grid grid-cols-2 gap-3">
                            <label class="grid gap-1.5">
                                <div
                                    class="flex items-center justify-between gap-2"
                                >
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Pos X</span
                                    >
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{keyringOffsetX}</span
                                    >
                                </div>
                                <input
                                    class="w-full accent-indigo-500"
                                    type="range"
                                    min="-40"
                                    max="40"
                                    step="0.5"
                                    bind:value={keyringOffsetX}
                                />
                            </label>
                            <label class="grid gap-1.5">
                                <div
                                    class="flex items-center justify-between gap-2"
                                >
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Pos Y</span
                                    >
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{keyringOffsetY}</span
                                    >
                                </div>
                                <input
                                    class="w-full accent-indigo-500"
                                    type="range"
                                    min="-40"
                                    max="40"
                                    step="0.5"
                                    bind:value={keyringOffsetY}
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
                        downloadSnapshot(renderer, scene, camera, "keychain")}
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
