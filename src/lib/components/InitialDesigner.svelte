<script lang="ts">
    import type { Session, User } from "@supabase/supabase-js";
    import ClipperLib from "clipper-lib";
    import { onDestroy, onMount } from "svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import { exportTo3MF } from "three-3mf-exporter";
    import FontSelect from "$lib/components/FontSelect.svelte";
    import {
        centerGeometryXY,
        type CharSettings,
        DEFAULT_CHAR_SETTINGS,
        DEFAULT_FONT_KEY_INITIAL,
        DEFAULT_FONT_SETTINGS_INITIAL,
        DEFAULT_INITIAL_FONT_KEY,
        DEFAULT_TEXT,
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        FONT_OPTIONS,
        type FontSettings,
        frameCameraToObject,
        getFont,
        loadCharSettingsFromStorage,
        loadFontSettingsFromStorage,
        makeKeyringGeometry,
    } from "$lib/utils-3d";
    import { notifyExportEvent } from "$lib/exportNotify";
    import { upload3mfToSupabase } from "$lib/upload3mf";
    import DesignerExportToolbar from "./DesignerExportToolbar.svelte";
    import { Button } from "$lib/components/ui/button";
    import { Slider } from "$lib/components/ui/slider";
    import ColorPalettePicker from "./ColorPalettePicker.svelte";
    import type { PaletteColor } from "$lib/colorPalette";
    import { getExportTitle, type SubscriptionStatus } from "$lib/subscription";

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
                : "Retro Dolly_Book";
        } catch {
            return "Retro Dolly_Book";
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
	// Top text (outline + text) XY offset relative to initial
	let textOffsetX = $state(0);
	let textOffsetY = $state(0);
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
    let openBambuStudioLoading = $state(false);
    let didInitFrame = false;

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
        notifyExportEvent({
            email: user?.email,
            name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
            subscriptionStatus,
            designName: "Text & Initial",
            format: "stl"
        });
        onShowThankYou();
    }

    /** 3MF: 3 objects. (1) Initial + text outline merged, same color. (2) Text outline only. (3) Text only. */
    async function export3MF() {
        if (!user) {
            onRequestLogin();
            return;
        }
        if (!group || group.children.length === 0) return;
        try {
            group.updateWorldMatrix(true, true);
            const byName: Record<string, THREE.Mesh> = {};
            for (const child of group.children) {
                if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).name) {
                    byName[(child as THREE.Mesh).name] = child as THREE.Mesh;
                }
            }
            const initialMesh = byName.initial;
            const initialBaseMesh = byName.initialBase;
            const outlineMesh = byName.outline;
            const textMesh = byName.text;
            const keyringMesh = byName.keyring;
            const geoWorld = (mesh: THREE.Mesh) =>
                mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
            const mergeAll = (meshes: THREE.Mesh[]) => {
                const geos = meshes.map(geoWorld);
                const merged =
                    geos.length === 1
                        ? geos[0]
                        : BufferGeometryUtils.mergeGeometries(geos);
                if (!merged) return null;
                if (geos.length > 1)
                    geos.forEach((g) => g !== merged && g.dispose());
                return BufferGeometryUtils.mergeVertices(merged, 1e-3);
            };
            const exportGroup = new THREE.Group();
            // Bottom: initial + text outline merged into 1 object, text color
            const bottomMeshes: THREE.Mesh[] = [];
            if (initialMesh) bottomMeshes.push(initialMesh);
            if (initialBaseMesh) bottomMeshes.push(initialBaseMesh);
            if (keyringMesh) bottomMeshes.push(keyringMesh);
            const bottomGeo =
                bottomMeshes.length > 0 ? mergeAll(bottomMeshes) : null;
            if (bottomGeo) {
                exportGroup.add(
                    new THREE.Mesh(
                        bottomGeo,
                        new THREE.MeshBasicMaterial({
                            color: new THREE.Color(textColor),
                        }),
                    ),
                );
            }
            // Middle: text outline only, outline color
            if (outlineMesh) {
                const outlineOnlyGeo = mergeAll([outlineMesh]);
                if (outlineOnlyGeo) {
                    exportGroup.add(
                        new THREE.Mesh(
                            outlineOnlyGeo,
                            new THREE.MeshBasicMaterial({
                                color: new THREE.Color(outlineColor),
                            }),
                        ),
                    );
                }
            }
            // Top: text only, text color
            if (textMesh) {
                const textOnlyGeo = mergeAll([textMesh]);
                if (textOnlyGeo) {
                    exportGroup.add(
                        new THREE.Mesh(
                            textOnlyGeo,
                            new THREE.MeshBasicMaterial({
                                color: new THREE.Color(textColor),
                            }),
                        ),
                    );
                }
            }
            if (exportGroup.children.length === 0) return;
            exportGroup.updateWorldMatrix(true, true);
            const blob = await exportTo3MF(exportGroup);
            if (!blob || blob.size === 0) return;
            const safe = (text || "model")
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "");
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(`${safe || "model"}-initial-${timestamp}.3mf`, blob);
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Text & Initial",
                format: "3mf"
            });
            onShowThankYou();
        } catch (e) {
            console.error("3MF export failed", e);
        }
    }

    async function openWithBambuStudio() {
        if (!group || group.children.length === 0) return;
        openBambuStudioLoading = true;
        try {
            group.updateWorldMatrix(true, true);
            const byName: Record<string, THREE.Mesh> = {};
            for (const child of group.children) {
                if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).name) {
                    byName[(child as THREE.Mesh).name] = child as THREE.Mesh;
                }
            }
            const initialMesh = byName.initial;
            const initialBaseMesh = byName.initialBase;
            const outlineMesh = byName.outline;
            const textMesh = byName.text;
            const keyringMesh = byName.keyring;
            const geoWorld = (mesh: THREE.Mesh) =>
                mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
            const mergeAll = (meshes: THREE.Mesh[]) => {
                const geos = meshes.map(geoWorld);
                const merged =
                    geos.length === 1
                        ? geos[0]
                        : BufferGeometryUtils.mergeGeometries(geos);
                if (!merged) return null;
                if (geos.length > 1)
                    geos.forEach((g) => g !== merged && g.dispose());
                return BufferGeometryUtils.mergeVertices(merged, 1e-3);
            };
            const exportGroup = new THREE.Group();
            const bottomMeshes: THREE.Mesh[] = [];
            if (initialMesh) bottomMeshes.push(initialMesh);
            if (initialBaseMesh) bottomMeshes.push(initialBaseMesh);
            if (keyringMesh) bottomMeshes.push(keyringMesh);
            const bottomGeo =
                bottomMeshes.length > 0 ? mergeAll(bottomMeshes) : null;
            if (bottomGeo) {
                exportGroup.add(
                    new THREE.Mesh(
                        bottomGeo,
                        new THREE.MeshBasicMaterial({
                            color: new THREE.Color(textColor),
                        }),
                    ),
                );
            }
            if (outlineMesh) {
                const outlineOnlyGeo = mergeAll([outlineMesh]);
                if (outlineOnlyGeo) {
                    exportGroup.add(
                        new THREE.Mesh(
                            outlineOnlyGeo,
                            new THREE.MeshBasicMaterial({
                                color: new THREE.Color(outlineColor),
                            }),
                        ),
                    );
                }
            }
            if (textMesh) {
                const textOnlyGeo = mergeAll([textMesh]);
                if (textOnlyGeo) {
                    exportGroup.add(
                        new THREE.Mesh(
                            textOnlyGeo,
                            new THREE.MeshBasicMaterial({
                                color: new THREE.Color(textColor),
                            }),
                        ),
                    );
                }
            }
            if (exportGroup.children.length === 0) return;
            exportGroup.updateWorldMatrix(true, true);
            const blob = await exportTo3MF(exportGroup);
            if (!blob || blob.size === 0) return;
            const publicUrl = await upload3mfToSupabase(blob, 'text-initial');
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Text & Initial",
                format: "bambu_studio"
            });
            window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
        } catch (err) {
            console.error('Open with Bambu Studio failed:', err);
        } finally {
            openBambuStudioLoading = false;
        }
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
        const initialDepthVal = Math.max(0.1, initialDepth);
        let initialMesh: THREE.Mesh | null = null;
        let initialBaseMesh: THREE.Mesh | null = null;
        if (initialThreeShapes.length > 0) {
            const initialGeo = new THREE.ExtrudeGeometry(initialThreeShapes, {
                depth: initialDepthVal,
                bevelEnabled: false,
                curveSegments: 12,
            });
            centerGeometryXY(initialGeo);
            initialMesh = new THREE.Mesh(initialGeo, textMat);
            initialMesh.name = "initial";
            initialMesh.castShadow = true;
            initialMesh.receiveShadow = true;
            initialMesh.position.z = 0.002;
            group.add(initialMesh);
            const initialBaseGeo = new THREE.ExtrudeGeometry(baseShapes, {
                depth: initialDepthVal,
                bevelEnabled: false,
                curveSegments: 12,
            });
            centerGeometryXY(initialBaseGeo);
            initialBaseMesh = new THREE.Mesh(initialBaseGeo, textMat);
            initialBaseMesh.name = "initialBase";
            initialBaseMesh.castShadow = true;
            initialBaseMesh.receiveShadow = true;
			// Move the merged base that sits under the initial together with the top text block
			// so STL and 3MF exports keep them aligned.
			initialBaseMesh.position.x = textOffsetX;
			initialBaseMesh.position.y = textOffsetY;
            initialBaseMesh.position.z = 0;
            group.add(initialBaseMesh);
        }

        // ── Outline (middle layer) + text (top layer) ────────────────────────
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
		baseMesh.name = "outline";
		const textMesh = new THREE.Mesh(textGeo, textMat);
		textMesh.name = "text";
        baseMesh.castShadow = true;
        baseMesh.receiveShadow = true;
        textMesh.castShadow = true;
        textMesh.receiveShadow = true;

		// Apply XY offset to the top text stack (outline + text) so user can move
		// the name block relative to the large initial.
		baseMesh.position.x = textOffsetX;
		baseMesh.position.y = textOffsetY;
		textMesh.position.x = textOffsetX;
		textMesh.position.y = textOffsetY;

		if (initialMesh) {
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
            ringMesh.name = "keyring";
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

    // ── Lifecycle ───────────────────────────────────────────────────────────
    onMount(() => {
        if (!hostEl) return;
        isUpdatingFromStorage = true;
        if (!allFontSettings[fontKey])
            allFontSettings[fontKey] = { ...defaults };
        font = getFont(fontKey);

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
        const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
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
		void textOffsetX;
		void textOffsetY;
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
        class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
        <aside
            class="flex min-h-0 w-full max-w-[360px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]">
            <div class="flex shrink-0 items-center justify-between p-4">
                <h1 class="text-lg font-semibold tracking-tight text-slate-900">
                    Text & Initial
                </h1>
                <Button variant="outline" size="sm" onclick={onBack}>
                    Back
                </Button>
            </div>

            <div
                class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
                <div class="grid grid-cols-1 gap-4">
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Text</span>
                        <input
                            class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2"
                            type="text"
                            bind:value={text} />
                    </label>

                    <!-- Text Font -->
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Text Font</span>
                        <FontSelect
                            bind:value={fontKey} />
                    </label>

                    <!-- Initial Font -->
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Initial Font</span>
                        <FontSelect
                            bind:value={initialFontKey} />
                    </label>

                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Initial size</span>
                            <span class="text-xs tabular-nums text-slate-600"
                                >{initialTextSize}</span>
                        </div>
                        <Slider
                            type="single"
                            bind:value={initialTextSize}
                            min={6}
                            max={120}
                            step={1}
                            class="w-full" />
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
                            max={72}
                            step={1}
                            class="w-full" />
                    </label>

					<!-- Top text position (relative to initial) -->
					<div class="grid grid-cols-2 gap-3">
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700"
									>Text Pos X</span>
								<span class="text-xs tabular-nums text-slate-600"
									>{textOffsetX}</span>
							</div>
							<Slider
								type="single"
								bind:value={textOffsetX}
								min={-40}
								max={40}
								step={0.5}
								class="w-full" />
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700"
									>Text Pos Y</span>
								<span class="text-xs tabular-nums text-slate-600"
									>{textOffsetY}</span>
							</div>
							<Slider
								type="single"
								bind:value={textOffsetY}
								min={-40}
								max={40}
								step={0.5}
								class="w-full" />
						</label>
					</div>

                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Outline thickness</span>
                            <span class="text-xs tabular-nums text-slate-600"
                                >{outlineOffsetPx}px</span>
                        </div>
                        <Slider
                            type="single"
                            bind:value={outlineOffsetPx}
                            min={5}
                            max={30}
                            step={1}
                            class="w-full" />
                    </label>

                    <div class="grid grid-cols-2 gap-3">
                        <ColorPalettePicker
                            bind:value={textColor}
                            {palette}
                            label="Text color" />
                        <ColorPalettePicker
                            bind:value={outlineColor}
                            {palette}
                            label="Outline color" />
                    </div>

                    <div
                        class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700">
                            Extrusion
                        </div>
                        <div class="grid grid-cols-2 gap-3">
                            <label class="grid gap-1.5">
                                <div
                                    class="flex items-center justify-between gap-2">
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Initial depth</span>
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{initialDepth}</span>
                                </div>
                                <Slider
                                    type="single"
                                    bind:value={initialDepth}
                                    min={1}
                                    max={20}
                                    step={0.2}
                                    class="w-full" />
                            </label>
                            <label class="grid gap-1.5">
                                <div
                                    class="flex items-center justify-between gap-2">
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Base depth</span>
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
                            <label class="grid gap-1.5">
                                <div
                                    class="flex items-center justify-between gap-2">
                                    <span
                                        class="text-xs font-medium text-slate-700"
                                        >Text depth</span>
                                    <span
                                        class="text-xs tabular-nums text-slate-600"
                                        >{textDepth}</span>
                                </div>
                                <Slider
                                    type="single"
                                    bind:value={textDepth}
                                    min={1}
                                    max={20}
                                    step={0.2}
                                    class="w-full" />
                            </label>
                        </div>
                    </div>

                    <div
                        class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                        <div class="flex items-center justify-between">
                            <div
                                class="text-xs font-semibold tracking-tight text-slate-700">
                                Keyring
                            </div>
                            <label
                                class="flex items-center gap-2 text-xs font-medium text-slate-700">
                                <input
                                    class="h-4 w-4 accent-indigo-500"
                                    type="checkbox"
                                    bind:checked={keyringEnabled} />
                                Enabled
                            </label>
                        </div>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
                                    >Ring depth</span>
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{keyringDepth}</span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={keyringDepth}
                                min={1}
                                max={20}
                                step={1}
                                class="w-full" />
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
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
                                <span class="text-xs font-medium text-slate-700"
                                    >Hole size</span>
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{keyringHoleSize}</span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={keyringHoleSize}
                                min={2}
                                max={Math.max(1, keyringOuterSize - 1)}
                                step={0.5}
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
                        downloadSnapshot(
                            renderer,
                            scene,
                            camera,
                            "keychain-initial",
                        )}
                    onExport={() => (user && subscriptionStatus?.isActive ? exportSTL() : onShowPricing?.())}
                    onExport3MF={() => (user && subscriptionStatus?.isActive ? export3MF() : onShowPricing?.())}
                    onOpenWithBambuStudio={() => (user && subscriptionStatus?.isActive ? openWithBambuStudio() : onShowPricing?.())}
                    openBambuStudioLoading={openBambuStudioLoading}
                    exportDisabled={false}
                    exportTitle={getExportTitle(user, subscriptionStatus, "Export STL or 3MF")}
                    showLockIcon={!user || !subscriptionStatus?.isActive} />
            </div>
        </section>
    </div>
</main>
