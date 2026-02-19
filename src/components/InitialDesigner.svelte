<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import { type LicenseStatus, checkLicenseStatus } from "../lib/licensing";
    import type { User, Session } from "@supabase/supabase-js";
    import type LicenseModal from "./LicenseModal.svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter";
    import ClipperLib from "clipper-lib";
    import {
        type FontSettings,
        type CharSettings,
        FONT_OPTIONS,
        DEFAULT_FONT_SETTINGS_INITIAL,
        DEFAULT_CHAR_SETTINGS,
        DEFAULT_FONT_KEY_INITIAL,
        DEFAULT_INITIAL_FONT_KEY,
        DEFAULT_TEXT,
        getFont,
        centerGeometryXY,
        makeKeyringGeometry,
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

    // ── Storage keys (initial-specific) ─────────────────────────────────────
    const STORAGE_KEY_SETTINGS = "keychain-initial-font-settings";
    const STORAGE_KEY_KEYRING = "keychain-initial-keyring-settings";
    const STORAGE_KEY_TEXT = "keychain-initial-text";
    const STORAGE_KEY_FONT = "keychain-initial-font";

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
    let lastInitialFont = ""; // tracks initialFontKey for keyring persistence

    const defaults = DEFAULT_FONT_SETTINGS_INITIAL;

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
                : DEFAULT_FONT_KEY_INITIAL;
        } catch {
            return DEFAULT_FONT_KEY_INITIAL;
        }
    })();

    const fontSettings = allFontSettings[restoredFont] || defaults;
    const initialCharValue =
        restoredText.length > 0 ? restoredText.charAt(0).toUpperCase() : "";
    // Keyring position is tied to initialFontKey + initial char
    const restoredInitialFontKey =
        fontSettings.initialFontKey ?? DEFAULT_INITIAL_FONT_KEY;
    const charSettings =
        allCharSettings[restoredInitialFontKey]?.[initialCharValue] ||
        DEFAULT_CHAR_SETTINGS;

    // ── Reactive state ──────────────────────────────────────────────────────
    let text = $state(restoredText);
    let textSize = $state(fontSettings.textSize);
    let outlineOffsetPx = $state(fontSettings.outlineOffsetPx);
    let baseDepth = $state(fontSettings.baseDepth);
    let textDepth = $state(fontSettings.textDepth);
    let initialDepth = $state(
        fontSettings.initialDepth ?? defaults.initialDepth ?? 0.4,
    );
    let initialTextSize = $state(
        fontSettings.initialTextSize ?? defaults.initialTextSize ?? 39,
    );
    let textColor = $state(fontSettings.textColor);
    let outlineColor = $state(fontSettings.outlineColor);
    let fontKey = $state(restoredFont);
    let initialFontKey = $state(
        fontSettings.initialFontKey ?? DEFAULT_INITIAL_FONT_KEY,
    );
    let keyringEnabled = $state(fontSettings.keyringEnabled ?? true);
    let keyringDepth = $state(fontSettings.keyringDepth ?? 4);
    let keyringOuterSize = $state(charSettings.keyringOuterSize);
    let keyringHoleSize = $state(charSettings.keyringHoleSize);
    let keyringOffsetX = $state(charSettings.keyringOffsetX);
    let keyringOffsetY = $state(charSettings.keyringOffsetY);

    lastFont = restoredFont;
    lastChar = initialCharValue;
    lastInitialFont = restoredInitialFontKey;

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
    let initialFontDropdownOpen = $state(false);
    let initialFontDropdownRef = $state<HTMLDivElement | null>(null);

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
        initialDepth = settings.initialDepth ?? defaults.initialDepth ?? 10;
        initialTextSize =
            settings.initialTextSize ?? defaults.initialTextSize ?? 39;
        initialFontKey = settings.initialFontKey ?? DEFAULT_INITIAL_FONT_KEY;
        keyringDepth = settings.keyringDepth ?? 4;
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
            initialDepth,
            initialTextSize,
            initialFontKey,
            keyringDepth,
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
        if (!group) return;
        if (!user) {
            onRequestLogin();
            return;
        }
        const status = await checkLicenseStatus(user);
        if (!status.canExport) {
            licenseModalRef?.open();
            return;
        }
        const exporter = new STLExporter();
        const result = exporter.parse(group, { binary: true } as any);
        const blob =
            result instanceof ArrayBuffer
                ? new Blob([result], { type: "model/stl" })
                : new Blob([result], { type: "text/plain" });
        const safe = (text || "model")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(`${safe || "model"}-initial-${timestamp}.stl`, blob);
        if (status.type === "trial") onShowThankYou();
    }

    // ── Rebuild meshes (initial + text) ─────────────────────────────────────
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

        // Main text shapes
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

        const polyTreeToThreeShapes = (tree: any) => {
            const shapesOut: any[] = [];
            const toVec2 = (pt: any) =>
                new THREE.Vector2(pt.X / SCALE, pt.Y / SCALE);
            const buildFromOuter = (outerNode: any) => {
                const contour =
                    outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
                if (!contour || contour.length < 3) return;
                const shape = new THREE.Shape(contour.map(toVec2));
                const children =
                    outerNode.Childs?.() ?? outerNode.m_Childs ?? [];
                for (const ch of children) {
                    const isHole = ch.IsHole?.() ?? ch.m_IsHole;
                    if (!isHole) continue;
                    const holeContour = ch.Contour?.() ?? ch.m_polygon ?? [];
                    if (holeContour.length >= 3)
                        shape.holes.push(
                            new THREE.Path(holeContour.map(toVec2)),
                        );
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

        const baseShapes = polyTreeToThreeShapes(outlineTree);
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

        // ── Build the large initial mesh ────────────────────────────────────
        let initialMesh: any = null;
        const initialCharStr =
            (text?.charAt(0)?.toUpperCase() as string) || "A";
        const initialSize = Math.max(1, Math.round(initialTextSize));
        const fontForInitial = getFont(initialFontKey);
        const initialFontShapes = fontForInitial.generateShapes(
            initialCharStr,
            initialSize,
        );
        const initialPaths: any[] = [];
        for (const s of initialFontShapes) {
            const { outer, holes } = shapeToPaths(s);
            if (outer.length < 3) continue;
            ensureCW(outer, true);
            initialPaths.push(outer);
            for (const h of holes) {
                if (h.length < 3) continue;
                ensureCW(h, false);
                initialPaths.push(h);
            }
        }
        const initialTree = new ClipperLib.PolyTree();
        if (initialPaths.length > 0) {
            const ci = new ClipperLib.Clipper();
            ci.AddPaths(initialPaths, ClipperLib.PolyType.ptSubject, true);
            ci.Execute(
                ClipperLib.ClipType.ctUnion,
                initialTree,
                ClipperLib.PolyFillType.pftNonZero,
                ClipperLib.PolyFillType.pftNonZero,
            );
        }
        const initialThreeShapes = polyTreeToThreeShapes(initialTree);
        if (initialThreeShapes.length > 0) {
            const initialGeo = new THREE.ExtrudeGeometry(initialThreeShapes, {
                depth: Math.max(0.1, initialDepth),
                bevelEnabled: false,
                curveSegments: 12,
            });
            centerGeometryXY(initialGeo);
            initialMesh = new THREE.Mesh(initialGeo, textMat);
            initialMesh.castShadow = true;
            initialMesh.receiveShadow = true;
            initialMesh.position.z = 0;
            group.add(initialMesh);
        }

        // ── Initial base (outline shape at initialDepth + textColor) ────────
        // This creates a colored platform under the main outline base,
        // so the initial's color extends through the outline footprint.
        let initialBaseMesh: any = null;
        if (initialMesh) {
            const initialBaseGeo = new THREE.ExtrudeGeometry(baseShapes, {
                depth: Math.max(0.1, initialDepth),
                bevelEnabled: false,
                curveSegments: 12,
            });
            centerGeometryXY(initialBaseGeo);
            initialBaseMesh = new THREE.Mesh(initialBaseGeo, textMat);
            initialBaseMesh.castShadow = true;
            initialBaseMesh.receiveShadow = true;
            initialBaseMesh.position.z = 0.0;
            group.add(initialBaseMesh);
        }

        // ── Base + text meshes ──────────────────────────────────────────────
        const baseGeo = new THREE.ExtrudeGeometry(baseShapes, {
            depth: Math.max(0.1, baseDepth),
            bevelEnabled: false,
            curveSegments: 12,
        });
        centerGeometryXY(baseGeo);

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

        if (initialMesh) {
            // Stack: initial + initialBase at z=0, base on top at initialDepth, text on top of base
            initialMesh.position.z = 0.005;
            baseMesh.position.z = Math.max(0.1, initialDepth) + 0.01;
            textMesh.position.z =
                Math.max(0.1, initialDepth) + Math.max(0.1, baseDepth) + 0.02;
        } else {
            baseMesh.position.z = 0;
            textMesh.position.z = Math.max(0.1, baseDepth) - 0.02;
        }
        group.add(baseMesh);
        group.add(textMesh);

        // ── Keyring anchored to initial ─────────────────────────────────────
        const keyringAnchorMesh = initialMesh || baseMesh;
        if (keyringEnabled) {
            const ringGeo = makeKeyringGeometry(
                Math.max(1, keyringOuterSize),
                Math.max(
                    0.1,
                    Math.min(keyringHoleSize, keyringOuterSize - 0.5),
                ),
                Math.max(0.1, keyringDepth),
            );
            keyringAnchorMesh.updateWorldMatrix(true, true);
            const bb = new THREE.Box3().setFromObject(keyringAnchorMesh);
            const corner = new THREE.Vector3(bb.min.x, bb.max.y, 0);
            const ringMesh = new THREE.Mesh(ringGeo, textMat);
            ringMesh.castShadow = true;
            ringMesh.receiveShadow = true;
            ringMesh.position.set(
                corner.x + keyringOffsetX,
                corner.y + keyringOffsetY,
                0,
            );
            ringMesh.updateWorldMatrix(true, true);
            group.add(ringMesh);
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

    // ── Click outside ───────────────────────────────────────────────────────
    function handleClickOutside(event: MouseEvent) {
        const target = event.target as Node;
        if (fontDropdownRef && !fontDropdownRef.contains(target))
            fontDropdownOpen = false;
        if (initialFontDropdownRef && !initialFontDropdownRef.contains(target))
            initialFontDropdownOpen = false;
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

    // Track previous initialDepth so we can apply delta to baseDepth
    let prevInitialDepth = initialDepth;

    // ── Effects ─────────────────────────────────────────────────────────────

    // When initialDepth changes, shift baseDepth by the same delta
    $effect(() => {
        const curDepth = initialDepth;
        if (!isUpdatingFromStorage && curDepth !== prevInitialDepth) {
            const delta = curDepth - prevInitialDepth;
            baseDepth = Math.max(0.2, baseDepth + delta);
        }
        prevInitialDepth = curDepth;
    });

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

    // Text font change (save/load font settings, but NOT keyring -- that's tied to initialFontKey)
    $effect(() => {
        const currentFont = fontKey;
        if (user && licenseStatus?.type === "trial") {
            const firstFontKey = FONT_OPTIONS[0]?.key;
            if (currentFont !== firstFontKey && firstFontKey) {
                fontKey = firstFontKey;
                return;
            }
        }
        if (currentFont !== lastFont) {
            if (lastFont) {
                const wasUpdating = isUpdatingFromStorage;
                isUpdatingFromStorage = false;
                saveSettingsForFont(lastFont);
                isUpdatingFromStorage = wasUpdating;
            }
            isUpdatingFromStorage = true;
            lastFont = currentFont;
            loadSettingsForFont(currentFont);
            setTimeout(() => {
                isUpdatingFromStorage = false;
            }, 0);
            if (scene) {
                font = getFont(fontKey);
                rebuildMeshes();
            }
        }
    });

    // Initial font change: save/load keyring position (tied to initialFontKey + char)
    $effect(() => {
        const curInitialFont = initialFontKey;
        const currentChar = getCurrentChar();
        if (curInitialFont !== lastInitialFont) {
            if (lastInitialFont && lastChar) {
                const wasUpdating = isUpdatingFromStorage;
                isUpdatingFromStorage = false;
                saveKeyringForChar(lastInitialFont, lastChar);
                isUpdatingFromStorage = wasUpdating;
            }
            isUpdatingFromStorage = true;
            lastInitialFont = curInitialFont;
            if (currentChar) {
                loadKeyringForChar(curInitialFont, currentChar);
                lastChar = currentChar;
            }
            setTimeout(() => {
                isUpdatingFromStorage = false;
            }, 0);
        }
    });

    // Char change: save/load keyring for initial font + new char
    $effect(() => {
        const currentChar = getCurrentChar();
        const curInitialFont = initialFontKey;
        if (currentChar !== lastChar && curInitialFont) {
            if (lastChar) {
                const wasUpdating = isUpdatingFromStorage;
                isUpdatingFromStorage = false;
                saveKeyringForChar(curInitialFont, lastChar);
                isUpdatingFromStorage = wasUpdating;
            }
            isUpdatingFromStorage = true;
            lastChar = currentChar;
            if (currentChar) loadKeyringForChar(curInitialFont, currentChar);
            setTimeout(() => {
                isUpdatingFromStorage = false;
            }, 0);
        }
    });

    // Save font settings on change
    $effect(() => {
        if (isUpdatingFromStorage || !fontKey) return;
        void textSize;
        void outlineOffsetPx;
        void baseDepth;
        void textDepth;
        void textColor;
        void outlineColor;
        void keyringEnabled;
        void initialDepth;
        void initialTextSize;
        void initialFontKey;
        void keyringDepth;
        saveSettingsForFont(fontKey);
    });

    // Save keyring on change (tied to initialFontKey + char)
    $effect(() => {
        if (isUpdatingFromStorage) return;
        const currentChar = getCurrentChar();
        const curInitialFont = initialFontKey;
        void keyringOffsetX;
        void keyringOffsetY;
        void keyringOuterSize;
        void keyringHoleSize;
        if (currentChar && curInitialFont)
            saveKeyringForChar(curInitialFont, currentChar);
    });

    // Rebuild meshes on any visual change
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
        void initialDepth;
        void initialTextSize;
        void initialFontKey;
        void keyringDepth;
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
                    Initial + Text
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

                    <!-- Text Font -->
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Text Font</span
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

                    <!-- Initial Font -->
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Initial Font</span
                        >
                        <div
                            class="relative"
                            bind:this={initialFontDropdownRef}
                        >
                            <button
                                type="button"
                                class="w-full appearance-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2 flex items-center justify-between"
                                onclick={(e) => {
                                    e.stopPropagation();
                                    initialFontDropdownOpen =
                                        !initialFontDropdownOpen;
                                }}
                            >
                                <span
                                    style="font-family: {FONT_OPTIONS.find(
                                        (f) => f.key === initialFontKey,
                                    )?.fontFamily || 'inherit'}"
                                >
                                    {FONT_OPTIONS.find(
                                        (f) => f.key === initialFontKey,
                                    )?.label || "Select font"}
                                </span>
                                <svg
                                    class="h-4 w-4 text-slate-500 transition-transform {initialFontDropdownOpen
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
                            {#if initialFontDropdownOpen}
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
                                            class="w-full px-3 py-2 text-left text-sm transition-colors {initialFontKey ===
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
                                                initialFontKey = f.key;
                                                initialFontDropdownOpen = false;
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
                                >Initial size</span
                            >
                            <span class="text-xs tabular-nums text-slate-600"
                                >{initialTextSize}</span
                            >
                        </div>
                        <input
                            class="w-full accent-indigo-500"
                            type="range"
                            min="6"
                            max="120"
                            step="1"
                            bind:value={initialTextSize}
                        />
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
                                        >Initial depth</span
                                    >
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{initialDepth}</span
                                    >
                                </div>
                                <input
                                    class="w-full accent-indigo-500"
                                    type="range"
                                    min="1"
                                    max="20"
                                    step="0.2"
                                    bind:value={initialDepth}
                                />
                            </label>
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
                                    min="0.2"
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
                                    >Ring depth</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{keyringDepth}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="1"
                                max="20"
                                step="1"
                                bind:value={keyringDepth}
                            />
                        </label>
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
                        downloadSnapshot(
                            renderer,
                            scene,
                            camera,
                            "keychain-initial",
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
