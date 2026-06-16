<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import type { User, Session } from "@supabase/supabase-js";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import { exportTo3MF } from "$lib/export-to-3mf";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import ClipperLib from "clipper-lib";
    import FontSelect from "$lib/components/FontSelect.svelte";
    import {
        createRoundedRectShape,
        centerGeometryXY,
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        frameCameraToObject,
        getFont,
        FONT_OPTIONS,
        DEFAULT_TEXT,
        measureWorldAabbSizeMm,
    } from "$lib/utils-3d";
    import { notifyExportEvent } from "$lib/exportNotify";
    import { upload3mfToSupabase } from "$lib/upload3mf";
    import DesignerExportToolbar from "./DesignerExportToolbar.svelte";
    import DesignerModelDimensionsHud from "./DesignerModelDimensionsHud.svelte";
    import { Button } from "$lib/components/ui/button";
    import { Slider } from "$lib/components/ui/slider";
    import ColorPalettePicker from "./ColorPalettePicker.svelte";
    import { snapColorToPalette, type PaletteColor } from "$lib/colorPalette";
    import { ensureExportAccess, getExportTitle, showExportLockIcon, type SubscriptionStatus } from "$lib/subscription";
    import { tickThenYieldToPaint } from "$lib/yield-to-paint";
    import * as Dialog from "$lib/components/ui/dialog";
    import {
        cloneDefaultBasicNamePresetsAsCustom,
        DEFAULT_BASIC_NAME_COLOR_PRESETS,
        isCustomBasicNamePresetId,
        loadUserBasicNamePresets,
        persistBasicNameCustomPresets,
        type BasicNameColorPreset,
    } from "$lib/basicNamePresets";

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
    let { user, session, subscriptionStatus, palette, onBack, onRequestLogin, onShowThankYou, onShowPricing }: Props = $props();

    // ── Storage ──────────────────────────────────────────────────────────────
    const STORAGE_KEY = "keychain-basicname-settings";

    /** Vertical gap between stacked layers so faces do not touch (avoids coplanar / non-manifold). */
    const LAYER_GAP = 0.001;
    const CLIPPER_SCALE = 1000;
    /** Hard cap on text width as a fraction of the tag's base width. Lines that
     * exceed this are uniformly scaled down (preserving aspect) to fit. */
    const TEXT_MAX_WIDTH_RATIO = 0.85;
    /** Maximum number of stacked text lines. */
    const MAX_LINES = 8;

    type KeyringPosition =
        | "topCenter"
        | "topLeft"
        | "topRight"
        | "leftCenter"
        | "rightCenter";

    type BasicNameLine = {
        content: string;
        fontKey: string;
        size: number;
        depth: number;
    };

    interface Settings {
        baseWidth: number;
        baseHeight: number;
        cornerRadius: number;
        baseDepth: number;
        topBorderDepth: number;
        keyringPosition: KeyringPosition;
        baseColor: string;
        accentColor: string; // border and text (same color)
        lines: BasicNameLine[];
        /** Vertical gap (mm) between adjacent text lines. */
        lineSpacing: number;
        textOutlineEnabled: boolean;
        textOutlineThicknessMm: number;
        textOutlineDepth: number;
        textOutlineColor: string;
    }

    const KEYRING_POSITIONS: { value: KeyringPosition; label: string }[] = [
        { value: "topCenter", label: "Top center" },
        { value: "topLeft", label: "Top left" },
        { value: "topRight", label: "Top right" },
        { value: "leftCenter", label: "Left center" },
        { value: "rightCenter", label: "Right center" },
    ];

    const DEFAULT_FONT_KEY = FONT_OPTIONS[0]?.key ?? "Titan One_Regular";

    const defaults: Settings = {
        baseWidth: 50,
        baseHeight: 25,
        cornerRadius: 7,
        baseDepth: 2,
        topBorderDepth: 1,
        keyringPosition: "topCenter",
        baseColor: "#000000",
        accentColor: "#24b6ff",
        lines: [
            {
                content: DEFAULT_TEXT,
                fontKey: DEFAULT_FONT_KEY,
                size: 8,
                depth: 0.8,
            },
        ],
        lineSpacing: 1.5,
        textOutlineEnabled: false,
        textOutlineThicknessMm: 1,
        textOutlineDepth: 0.6,
        textOutlineColor: "#ffffff",
    };

    function isFiniteNumber(v: unknown): v is number {
        return typeof v === "number" && Number.isFinite(v);
    }

    function sanitizeLine(raw: unknown): BasicNameLine | null {
        if (!raw || typeof raw !== "object") return null;
        const r = raw as Partial<BasicNameLine>;
        if (typeof r.content !== "string") return null;
        const fontKey =
            typeof r.fontKey === "string" &&
            FONT_OPTIONS.some((o) => o.key === r.fontKey)
                ? r.fontKey
                : DEFAULT_FONT_KEY;
        const size = isFiniteNumber(r.size)
            ? Math.min(40, Math.max(1, r.size))
            : 8;
        const depth = isFiniteNumber(r.depth)
            ? Math.min(5, Math.max(0.1, r.depth))
            : 0.8;
        return { content: r.content, fontKey, size, depth };
    }

    function cloneDefaultLines(): BasicNameLine[] {
        return defaults.lines.map((l) => ({ ...l }));
    }

    function loadSettings(): Settings {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (!stored) return { ...defaults, lines: cloneDefaultLines() };
            const parsed = JSON.parse(stored);
            if (!parsed || typeof parsed !== "object") {
                return { ...defaults, lines: cloneDefaultLines() };
            }
            const merged: Settings = { ...defaults, ...parsed };
            // Migrate old borderColor/textColor to single accentColor.
            merged.accentColor =
                parsed.accentColor ??
                parsed.borderColor ??
                parsed.textColor ??
                defaults.accentColor;

            // Migrate from legacy single-line schema (textContent/textFontKey/
            // textSize/textDepth) → first entry of the new `lines` array.
            const rawLines: unknown[] | null = Array.isArray(parsed.lines)
                ? (parsed.lines as unknown[])
                : null;
            if (rawLines) {
                const sanitized = rawLines
                    .map(sanitizeLine)
                    .filter(
                        (l: BasicNameLine | null): l is BasicNameLine =>
                            l !== null,
                    );
                merged.lines =
                    sanitized.length > 0 ? sanitized : cloneDefaultLines();
            } else if (typeof parsed.textContent === "string") {
                const legacy = sanitizeLine({
                    content: parsed.textContent,
                    fontKey: parsed.textFontKey,
                    size: parsed.textSize,
                    depth: parsed.textDepth,
                });
                merged.lines = legacy ? [legacy] : cloneDefaultLines();
            } else {
                merged.lines = cloneDefaultLines();
            }

            merged.lineSpacing = isFiniteNumber(parsed.lineSpacing)
                ? Math.max(0, parsed.lineSpacing)
                : defaults.lineSpacing;
            merged.textOutlineEnabled =
                typeof parsed.textOutlineEnabled === "boolean"
                    ? parsed.textOutlineEnabled
                    : defaults.textOutlineEnabled;
            merged.textOutlineThicknessMm = isFiniteNumber(parsed.textOutlineThicknessMm)
                ? Math.min(8, Math.max(0.2, parsed.textOutlineThicknessMm))
                : defaults.textOutlineThicknessMm;
            merged.textOutlineDepth = isFiniteNumber(parsed.textOutlineDepth)
                ? Math.min(5, Math.max(0.2, parsed.textOutlineDepth))
                : defaults.textOutlineDepth;
            merged.textOutlineColor =
                typeof parsed.textOutlineColor === "string"
                    ? parsed.textOutlineColor
                    : defaults.textOutlineColor;
            return merged;
        } catch {
            return { ...defaults, lines: cloneDefaultLines() };
        }
    }

    const initial = loadSettings();

    // ── Reactive state (rounded rectangle only) ──────────────────────────────
    let baseWidth = $state(initial.baseWidth);
    let baseHeight = $state(initial.baseHeight);
    let cornerRadius = $state(initial.cornerRadius);
    let baseDepth = $state(initial.baseDepth);
    let topBorderDepth = $state(initial.topBorderDepth);
    let keyringPosition = $state(initial.keyringPosition);
    let baseColor = $state(initial.baseColor);
    let accentColor = $state(initial.accentColor);
    let lines = $state<BasicNameLine[]>(initial.lines.map((l) => ({ ...l })));
    let lineSpacing = $state(initial.lineSpacing);
    let textOutlineEnabled = $state(initial.textOutlineEnabled);
    let textOutlineThicknessMm = $state(initial.textOutlineThicknessMm);
    let textOutlineDepth = $state(initial.textOutlineDepth);
    let textOutlineColor = $state(initial.textOutlineColor);

    const maxTextOutlineMm = $derived(
        Math.max(
            0.2,
            Math.min(
                8,
                Math.min(
                    Math.max(0.5, baseWidth / 2 - 2),
                    Math.max(0.5, baseHeight / 2 - 2),
                ) *
                    2 -
                    0.5,
            ),
        ),
    );

    let activePresetId = $state<string | null>(null);
    let customPresets = $state<BasicNameColorPreset[]>([]);
    let presetSyncError = $state<string | null>(null);
    let customPresetsLoading = $state(false);
    let importPresetsLoading = $state(false);
    const galleryPresets = $derived(customPresets);
    const hasGalleryPresets = $derived(galleryPresets.length > 0);

    type PresetEditorMode = "create" | "edit";
    let presetEditorOpen = $state(false);
    let presetEditorMode = $state<PresetEditorMode>("create");
    let presetEditorId = $state<string | null>(null);
    let presetEditorLabel = $state("");
    let presetEditorBase = $state("#000000");
    let presetEditorAccent = $state("#24b6ff");
    let presetEditorTextOutline = $state("#ffffff");
    let presetEditorTextOutlineEnabled = $state(false);

    function snapPresetColors(base: string, accent: string, textOutline: string) {
        return {
            base: snapColorToPalette(base, palette, baseColor),
            accent: snapColorToPalette(accent, palette, accentColor),
            textOutline: snapColorToPalette(textOutline, palette, textOutlineColor),
        };
    }

    function findMatchingPresetId(presets: BasicNameColorPreset[]): string | null {
        for (const preset of presets) {
            if (
                preset.baseColor === baseColor &&
                preset.accentColor === accentColor &&
                preset.textOutlineColor === textOutlineColor &&
                (preset.textOutlineEnabled ?? false) === textOutlineEnabled
            ) {
                return preset.id;
            }
        }
        return null;
    }

    function applyColorPreset(preset: BasicNameColorPreset) {
        const snapped = snapPresetColors(
            preset.baseColor,
            preset.accentColor,
            preset.textOutlineColor,
        );
        baseColor = snapped.base;
        accentColor = snapped.accent;
        textOutlineColor = snapped.textOutline;
        textOutlineEnabled = preset.textOutlineEnabled ?? false;
        activePresetId = findMatchingPresetId(galleryPresets) ?? preset.id;
    }

    function setPresetEditorColors(base: string, accent: string, textOutline: string) {
        const snapped = snapPresetColors(base, accent, textOutline);
        presetEditorBase = snapped.base;
        presetEditorAccent = snapped.accent;
        presetEditorTextOutline = snapped.textOutline;
    }

    function openCreatePresetEditor() {
        presetEditorMode = "create";
        presetEditorId = null;
        presetEditorLabel = "My preset";
        presetEditorTextOutlineEnabled = textOutlineEnabled;
        setPresetEditorColors(baseColor, accentColor, textOutlineColor);
        presetEditorOpen = true;
    }

    async function syncCustomPresetsFromAccount() {
        const userId = user?.id;
        if (!userId) {
            customPresets = [];
            activePresetId = null;
            closePresetEditor();
            presetSyncError = null;
            return;
        }
        customPresetsLoading = true;
        presetSyncError = null;
        try {
            customPresets = await loadUserBasicNamePresets(userId);
            activePresetId = findMatchingPresetId(galleryPresets);
        } catch (e) {
            presetSyncError = e instanceof Error ? e.message : "Failed to load presets";
        } finally {
            customPresetsLoading = false;
        }
    }

    async function persistCustomPresets(presets: BasicNameColorPreset[]) {
        if (!user?.id) return;
        const result = await persistBasicNameCustomPresets(user.id, presets);
        if (!result.success) {
            presetSyncError = result.error;
            return;
        }
        presetSyncError = null;
    }

    function openEditPresetEditor(preset: BasicNameColorPreset) {
        presetEditorMode = "edit";
        presetEditorId = preset.id;
        presetEditorLabel = preset.label;
        presetEditorTextOutlineEnabled = preset.textOutlineEnabled ?? false;
        setPresetEditorColors(preset.baseColor, preset.accentColor, preset.textOutlineColor);
        presetEditorOpen = true;
    }

    function closePresetEditor() {
        presetEditorOpen = false;
        presetEditorId = null;
    }

    function onPresetEditorOpenChange(open: boolean) {
        if (!open) closePresetEditor();
    }

    async function commitPresetEditor() {
        const label = presetEditorLabel.trim() || "My preset";
        const snapped = snapPresetColors(
            presetEditorBase,
            presetEditorAccent,
            presetEditorTextOutline,
        );
        const enabled = presetEditorTextOutlineEnabled;

        if (presetEditorMode === "edit" && presetEditorId) {
            customPresets = customPresets.map((p) =>
                p.id === presetEditorId
                    ? {
                          id: p.id,
                          label,
                          baseColor: snapped.base,
                          accentColor: snapped.accent,
                          textOutlineColor: snapped.textOutline,
                          textOutlineEnabled: enabled,
                      }
                    : p,
            );
            activePresetId = presetEditorId;
        } else {
            const id = `custom-${crypto.randomUUID()}`;
            customPresets = [
                ...customPresets,
                {
                    id,
                    label,
                    baseColor: snapped.base,
                    accentColor: snapped.accent,
                    textOutlineColor: snapped.textOutline,
                    textOutlineEnabled: enabled,
                },
            ];
            activePresetId = id;
        }

        applyColorPreset({
            id: activePresetId!,
            label,
            baseColor: snapped.base,
            accentColor: snapped.accent,
            textOutlineColor: snapped.textOutline,
            textOutlineEnabled: enabled,
        });
        await persistCustomPresets(customPresets);
        closePresetEditor();
    }

    async function deleteCustomPreset(id: string) {
        if (!isCustomBasicNamePresetId(id)) return;
        customPresets = customPresets.filter((p) => p.id !== id);
        await persistCustomPresets(customPresets);
        if (activePresetId === id) activePresetId = findMatchingPresetId(galleryPresets);
        closePresetEditor();
    }

    async function importDefaultPresets() {
        if (!user?.id) {
            onRequestLogin();
            return;
        }
        importPresetsLoading = true;
        presetSyncError = null;
        try {
            customPresets = cloneDefaultBasicNamePresetsAsCustom((hex, fallback) =>
                snapColorToPalette(hex, palette, fallback),
            );
            await persistCustomPresets(customPresets);
            activePresetId = null;
        } catch (e) {
            presetSyncError = e instanceof Error ? e.message : "Failed to import presets";
        } finally {
            importPresetsLoading = false;
        }
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
    let exportLoading = $state(false);
    let exportError = $state<string | null>(null);
    let openBambuStudioLoading = $state(false);
    let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);

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
            const payload: Settings = {
                baseWidth,
                baseHeight,
                cornerRadius,
                baseDepth,
                topBorderDepth,
                keyringPosition,
                baseColor,
                accentColor,
                lines,
                lineSpacing,
                textOutlineEnabled,
                textOutlineThicknessMm,
                textOutlineDepth,
                textOutlineColor,
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        } catch {}
    }

    function addLine() {
        if (lines.length >= MAX_LINES) return;
        const last = lines[lines.length - 1];
        const seed: BasicNameLine = last
            ? { ...last, content: "" }
            : {
                  content: "",
                  fontKey: DEFAULT_FONT_KEY,
                  size: 8,
                  depth: 0.8,
              };
        lines = [...lines, seed];
    }

    function removeLine(index: number) {
        if (lines.length <= 1) return;
        lines = lines.filter((_, i) => i !== index);
    }

    function moveLine(index: number, delta: -1 | 1) {
        const target = index + delta;
        if (target < 0 || target >= lines.length) return;
        const next = [...lines];
        const [item] = next.splice(index, 1);
        next.splice(target, 0, item);
        lines = next;
    }

    function polyTreeToThreeShapes(
        tree: any,
        toVec2: (pt: { X: number; Y: number }) => THREE.Vector2,
    ): THREE.Shape[] {
        const shapesOut: THREE.Shape[] = [];
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
            if (n.IsHole?.() ?? n.m_IsHole) continue;
            const s = buildFromOuter(n);
            if (s) shapesOut.push(s);
        }
        return shapesOut;
    }

    function buildUnionOffsetTree(paths: any[], offsetWorld: number) {
        const tree = new ClipperLib.PolyTree();
        if (offsetWorld > 0) {
            const co = new ClipperLib.ClipperOffset(2, 2);
            co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
            const offsetPaths: any[] = [];
            co.Execute(offsetPaths, offsetWorld * CLIPPER_SCALE);
            const clipper = new ClipperLib.Clipper();
            clipper.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
            clipper.Execute(
                ClipperLib.ClipType.ctUnion,
                tree,
                ClipperLib.PolyFillType.pftNonZero,
                ClipperLib.PolyFillType.pftNonZero,
            );
        } else {
            const clipper = new ClipperLib.Clipper();
            clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
            clipper.Execute(
                ClipperLib.ClipType.ctUnion,
                tree,
                ClipperLib.PolyFillType.pftNonZero,
                ClipperLib.PolyFillType.pftNonZero,
            );
        }
        return tree;
    }

    function addExtrudedBorderLayer(
        shape: THREE.Shape,
        z: number,
        depth: number,
        color: string,
        meshName: string,
    ) {
        if (!group) return;
        const topGeo = new THREE.ExtrudeGeometry([shape], {
            depth: Math.max(0.1, depth),
            bevelEnabled: false,
        });
        topGeo.computeBoundingBox();
        const topBb = topGeo.boundingBox!;
        topGeo.translate(0, 0, -topBb.min.z);
        const borderMat = new THREE.MeshStandardMaterial({
            color,
            roughness: 0.85,
            metalness: 0.05,
        });
        const topMesh = new THREE.Mesh(topGeo, borderMat);
        topMesh.name = meshName;
        topMesh.castShadow = true;
        topMesh.receiveShadow = true;
        topMesh.position.z = z;
        group.add(topMesh);
    }

    function rebuildMeshes() {
        if (!scene || !group) return;
        disposeObject3D(group);
        group.clear();
        group.position.set(0, 0, 0);
        modelAabbMm = null;

        const halfW = Math.max(1, baseWidth / 2);
        const halfH = Math.max(1, baseHeight / 2);
        const margin = 6;
        const discCenterX = (() => {
            switch (keyringPosition) {
                case "topLeft":
                case "leftCenter":
                    return -halfW;
                case "topRight":
                case "rightCenter":
                    return halfW;
                default:
                    return 0;
            }
        })();
        const discCenterY = (() => {
            switch (keyringPosition) {
                case "topCenter":
                    return halfH;
                case "topLeft":
                case "topRight":
                    return halfH;
                case "leftCenter":
                case "rightCenter":
                    return 0;
                default:
                    return halfH;
            }
        })();
        const discRadius = 4;
        const holeRadius = 2;
        const SCALE = 1000;
        const divisions = 24;
        const circleDivisions = 64; // smoother curve for disk

        const shapeToPath = (shape: THREE.Shape, clockwise: boolean) => {
            const pts = shape.getPoints(divisions);
            const path = pts.map((p) => ({
                X: Math.round(p.x * SCALE),
                Y: Math.round(p.y * SCALE),
            }));
            if (
                path.length > 2 &&
                path[0].X === path[path.length - 1].X &&
                path[0].Y === path[path.length - 1].Y
            )
                path.pop();
            if (path.length < 3) return null;
            const isCW = ClipperLib.Clipper.Orientation(path);
            if (isCW !== clockwise) path.reverse();
            return path;
        };

        const circleToPath = (
            cx: number,
            cy: number,
            r: number,
            clockwise: boolean,
            segs = divisions,
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

        // Rounded rect + disc as subject paths (both CW for union)
        const rectShape = createRoundedRectShape(halfW, halfH, cornerRadius);
        const rectPath = shapeToPath(rectShape, true);
        const discPath = circleToPath(
            discCenterX,
            discCenterY,
            discRadius,
            true,
            circleDivisions,
        );
        if (!rectPath) return;

        const unionTree = new ClipperLib.PolyTree();
        const clipperUnion = new ClipperLib.Clipper();
        clipperUnion.AddPath(rectPath, ClipperLib.PolyType.ptSubject, true);
        if (discPath)
            clipperUnion.AddPath(discPath, ClipperLib.PolyType.ptSubject, true);
        clipperUnion.Execute(
            ClipperLib.ClipType.ctUnion,
            unionTree,
            ClipperLib.PolyFillType.pftNonZero,
            ClipperLib.PolyFillType.pftNonZero,
        );

        // Subtract hole (center of disc)
        const holePath = circleToPath(
            discCenterX,
            discCenterY,
            holeRadius,
            false,
            circleDivisions,
        );
        const resultTree = new ClipperLib.PolyTree();
        const subjectPaths: any[] = [];
        const collectPaths = (node: any) => {
            const contour = node.Contour?.() ?? node.m_polygon ?? [];
            if (contour && contour.length >= 3) subjectPaths.push(contour);
            const childs = node.Childs?.() ?? node.m_Childs ?? [];
            childs.forEach(collectPaths);
        };
        const roots = unionTree.Childs?.() ?? unionTree.m_Childs ?? [];
        roots.forEach((n: any) => {
            if (n.IsHole?.() ?? n.m_IsHole) return;
            collectPaths(n);
        });

        const clipperDiff = new ClipperLib.Clipper();
        subjectPaths.forEach((p) =>
            clipperDiff.AddPath(p, ClipperLib.PolyType.ptSubject, true),
        );
        if (holePath)
            clipperDiff.AddPath(holePath, ClipperLib.PolyType.ptClip, true);
        clipperDiff.Execute(
            ClipperLib.ClipType.ctDifference,
            resultTree,
            ClipperLib.PolyFillType.pftNonZero,
            ClipperLib.PolyFillType.pftNonZero,
        );

        const toVec2 = (pt: any) =>
            new THREE.Vector2(pt.X / SCALE, pt.Y / SCALE);
        const resultRoots = resultTree.Childs?.() ?? resultTree.m_Childs ?? [];
        let mergedShape: THREE.Shape | null = null;
        for (const n of resultRoots) {
            if (n.IsHole?.() ?? n.m_IsHole) continue;
            const contour = n.Contour?.() ?? n.m_polygon ?? [];
            if (contour.length < 3) continue;
            mergedShape = new THREE.Shape(contour.map(toVec2));
            const childs = n.Childs?.() ?? n.m_Childs ?? [];
            for (const ch of childs) {
                const holeContour = ch.Contour?.() ?? ch.m_polygon ?? [];
                if (holeContour.length >= 3)
                    mergedShape.holes.push(
                        new THREE.Path(holeContour.map(toVec2)),
                    );
            }
            break;
        }

        if (!mergedShape) return;

        const baseGeo = new THREE.ExtrudeGeometry([mergedShape], {
            depth: Math.max(0.1, baseDepth),
            bevelEnabled: false,
        });
        // Do not center XY: keep rect center at (0,0) so top rect aligns
        baseGeo.computeBoundingBox();
        const bb = baseGeo.boundingBox!;
        baseGeo.translate(0, 0, -bb.min.z);
        baseGeo.computeBoundingBox();

        const baseMat = new THREE.MeshStandardMaterial({
            color: baseColor,
            roughness: 0.85,
            metalness: 0.05,
        });
        const baseMesh = new THREE.Mesh(baseGeo, baseMat);
        baseMesh.name = "base";
        baseMesh.castShadow = true;
        baseMesh.receiveShadow = true;
        baseMesh.position.z = 0;
        group.add(baseMesh);

        // Top layer: 1) subtract hole from top rectangle → border  2) merge border with top disc
        const borderWidth = 2;
        const innerHalfW = Math.max(0.5, halfW - borderWidth);
        const innerHalfH = Math.max(0.5, halfH - borderWidth);
        const innerCornerR = Math.max(0, cornerRadius - borderWidth);
        const outerRectPath = shapeToPath(
            createRoundedRectShape(halfW, halfH, cornerRadius),
            true,
        );
        const topCirclePath = circleToPath(
            discCenterX,
            discCenterY,
            discRadius,
            true,
            circleDivisions,
        );
        const innerRectPath = shapeToPath(
            createRoundedRectShape(innerHalfW, innerHalfH, innerCornerR),
            false,
        );

        // Step 1: subtract hole from top rectangle → border (rectangle with hole)
        const borderTree = new ClipperLib.PolyTree();
        const borderClipper = new ClipperLib.Clipper();
        if (outerRectPath)
            borderClipper.AddPath(
                outerRectPath,
                ClipperLib.PolyType.ptSubject,
                true,
            );
        if (innerRectPath)
            borderClipper.AddPath(
                innerRectPath,
                ClipperLib.PolyType.ptClip,
                true,
            );
        borderClipper.Execute(
            ClipperLib.ClipType.ctDifference,
            borderTree,
            ClipperLib.PolyFillType.pftNonZero,
            ClipperLib.PolyFillType.pftNonZero,
        );

        // Step 2: get border outer contour(s) and the hole contour from border tree
        const borderOuterPaths: any[] = [];
        let borderHolePath: any[] | null = null;
        const borderRoots = borderTree.Childs?.() ?? borderTree.m_Childs ?? [];
        for (const n of borderRoots) {
            if (n.IsHole?.() ?? n.m_IsHole) continue;
            const contour = n.Contour?.() ?? n.m_polygon ?? [];
            if (contour && contour.length >= 3) borderOuterPaths.push(contour);
            const childs = n.Childs?.() ?? n.m_Childs ?? [];
            for (const ch of childs) {
                const holeContour = ch.Contour?.() ?? ch.m_polygon ?? [];
                if (holeContour && holeContour.length >= 3)
                    borderHolePath = holeContour;
            }
        }

        // Step 3: merge border (outer paths) with top disc
        const topUnionTree = new ClipperLib.PolyTree();
        const topUnionClipper = new ClipperLib.Clipper();
        borderOuterPaths.forEach((p) =>
            topUnionClipper.AddPath(p, ClipperLib.PolyType.ptSubject, true),
        );
        if (topCirclePath)
            topUnionClipper.AddPath(
                topCirclePath,
                ClipperLib.PolyType.ptSubject,
                true,
            );
        topUnionClipper.Execute(
            ClipperLib.ClipType.ctUnion,
            topUnionTree,
            ClipperLib.PolyFillType.pftNonZero,
            ClipperLib.PolyFillType.pftNonZero,
        );

        // Step 4: hole = innerRect - circle (only the part of the rect hole outside the disc), so the disc is not cut
        const rectHoleOnlyTree = new ClipperLib.PolyTree();
        const rectHoleClipper = new ClipperLib.Clipper();
        if (innerRectPath)
            rectHoleClipper.AddPath(
                innerRectPath,
                ClipperLib.PolyType.ptSubject,
                true,
            );
        if (topCirclePath)
            rectHoleClipper.AddPath(
                topCirclePath,
                ClipperLib.PolyType.ptClip,
                true,
            );
        rectHoleClipper.Execute(
            ClipperLib.ClipType.ctDifference,
            rectHoleOnlyTree,
            ClipperLib.PolyFillType.pftNonZero,
            ClipperLib.PolyFillType.pftNonZero,
        );

        const rectHoleOnlyPaths: any[] = [];
        const collectAllContours = (node: any) => {
            const contour = node.Contour?.() ?? node.m_polygon ?? [];
            if (contour && contour.length >= 3) rectHoleOnlyPaths.push(contour);
            const childs = node.Childs?.() ?? node.m_Childs ?? [];
            childs.forEach(collectAllContours);
        };
        const rectHoleRoots =
            rectHoleOnlyTree.Childs?.() ?? rectHoleOnlyTree.m_Childs ?? [];
        rectHoleRoots.forEach((n: any) => {
            if (n.IsHole?.() ?? n.m_IsHole) return;
            collectAllContours(n);
        });

        // Step 5: subtract rect hole and disc hole from merged (border ∪ disc); disc center stored for hole
        const discHolePath = circleToPath(
            discCenterX,
            discCenterY,
            holeRadius,
            false,
            circleDivisions,
        );

        const mergedOuterPaths: any[] = [];
        const topUnionRoots =
            topUnionTree.Childs?.() ?? topUnionTree.m_Childs ?? [];
        topUnionRoots.forEach((n: any) => {
            if (n.IsHole?.() ?? n.m_IsHole) return;
            const contour = n.Contour?.() ?? n.m_polygon ?? [];
            if (contour && contour.length >= 3) mergedOuterPaths.push(contour);
        });

        const topResultTree = new ClipperLib.PolyTree();
        const topDiffClipper = new ClipperLib.Clipper();
        mergedOuterPaths.forEach((p) =>
            topDiffClipper.AddPath(p, ClipperLib.PolyType.ptSubject, true),
        );
        rectHoleOnlyPaths.forEach((p) =>
            topDiffClipper.AddPath(p, ClipperLib.PolyType.ptClip, true),
        );
        if (discHolePath)
            topDiffClipper.AddPath(
                discHolePath,
                ClipperLib.PolyType.ptClip,
                true,
            );
        topDiffClipper.Execute(
            ClipperLib.ClipType.ctDifference,
            topResultTree,
            ClipperLib.PolyFillType.pftNonZero,
            ClipperLib.PolyFillType.pftNonZero,
        );

        const topResultRoots =
            topResultTree.Childs?.() ?? topResultTree.m_Childs ?? [];
        let topMergedShape: THREE.Shape | null = null;
        for (const n of topResultRoots) {
            if (n.IsHole?.() ?? n.m_IsHole) continue;
            const contour = n.Contour?.() ?? n.m_polygon ?? [];
            if (contour.length < 3) continue;
            // Three.js ExtrudeGeometry expects outer CCW and holes CW
            const outerPts = contour.map(toVec2);
            if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
            topMergedShape = new THREE.Shape(outerPts);
            const childs = n.Childs?.() ?? n.m_Childs ?? [];
            for (const ch of childs) {
                const hc = ch.Contour?.() ?? ch.m_polygon ?? [];
                if (hc.length >= 3) {
                    const holePts = hc.map(toVec2);
                    if (!THREE.ShapeUtils.isClockWise(holePts))
                        holePts.reverse();
                    topMergedShape.holes.push(new THREE.Path(holePts));
                }
            }
            break;
        }

        let stackTopZ = baseDepth;

        const shapeDivisions = 18;
        const ensureClipperCW = (path: any[], clockwise: boolean) => {
            const isCW = ClipperLib.Clipper.Orientation(path);
            if (isCW !== clockwise) path.reverse();
        };
        const shapeToClipperPaths = (shape: THREE.Shape) => {
            const toPath = (pts: THREE.Vector2[]) => {
                const out: { X: number; Y: number }[] = [];
                for (const p of pts) {
                    out.push({
                        X: Math.round(p.x * SCALE),
                        Y: Math.round(p.y * SCALE),
                    });
                }
                if (out.length > 2) {
                    const a = out[0];
                    const b = out[out.length - 1];
                    if (a.X === b.X && a.Y === b.Y) out.pop();
                }
                return out;
            };
            const paths: { X: number; Y: number }[][] = [];
            const outer = toPath(shape.getPoints(shapeDivisions));
            if (outer.length >= 3) {
                ensureClipperCW(outer, true);
                paths.push(outer);
            }
            for (const hole of shape.holes ?? []) {
                const holePath = toPath(hole.getPoints(shapeDivisions));
                if (holePath.length >= 3) {
                    ensureClipperCW(holePath, false);
                    paths.push(holePath);
                }
            }
            return paths;
        };

        // ── Multi-line text (top) + optional text-outline layer (middle) ─────
        type LineEntry = {
            geo: THREE.BufferGeometry;
            height: number;
            line: BasicNameLine;
            centeredPaths: { X: number; Y: number }[][];
            yCenter: number;
        };
        const lineEntries: LineEntry[] = [];
        const maxTextWidth = baseWidth * TEXT_MAX_WIDTH_RATIO;
        for (const line of lines) {
            const content = (line.content ?? "").trim();
            if (!content) continue;
            const font = getFont(line.fontKey);
            if (!font) continue;
            let shapes: THREE.Shape[];
            try {
                shapes = font.generateShapes(content, Math.max(1, line.size));
            } catch (e) {
                console.error(
                    "BasicName generateShapes failed for line:",
                    content,
                    e,
                );
                continue;
            }
            if (!shapes || shapes.length === 0) continue;

            let clipperPaths: { X: number; Y: number }[][] = [];
            for (const shape of shapes) {
                clipperPaths.push(...shapeToClipperPaths(shape));
            }

            const geo = new THREE.ExtrudeGeometry(shapes, {
                depth: Math.max(0.05, line.depth),
                bevelEnabled: false,
                curveSegments: 8,
                steps: 1,
            });
            centerGeometryXY(geo);
            geo.computeBoundingBox();
            let bb = geo.boundingBox!;
            const w = Math.max(0.001, bb.max.x - bb.min.x);
            let fitScale = 1;
            if (w > maxTextWidth) {
                fitScale = maxTextWidth / w;
                geo.scale(fitScale, fitScale, 1);
                geo.computeBoundingBox();
                bb = geo.boundingBox!;
            }
            const cx = (bb.min.x + bb.max.x) / 2;
            const cy = (bb.min.y + bb.max.y) / 2;
            const centeredPaths = clipperPaths.map((path) =>
                path.map((pt) => ({
                    X: Math.round((pt.X / SCALE - cx) * fitScale * SCALE),
                    Y: Math.round((pt.Y / SCALE - cy) * fitScale * SCALE),
                })),
            );
            const h = Math.max(0.001, bb.max.y - bb.min.y);
            lineEntries.push({ geo, height: h, line, centeredPaths, yCenter: 0 });
        }

        if (lineEntries.length > 0) {
            const gap = Math.max(0, lineSpacing);
            const totalHeight =
                lineEntries.reduce((acc, e) => acc + e.height, 0) +
                Math.max(0, lineEntries.length - 1) * gap;
            let yCursor = totalHeight / 2;
            for (const entry of lineEntries) {
                entry.yCenter = yCursor - entry.height / 2;
                yCursor -= entry.height + gap;
            }
        }

        const hasTextOutlineLayer =
            textOutlineEnabled &&
            textOutlineThicknessMm > 0 &&
            lineEntries.length > 0;

        if (hasTextOutlineLayer && topMergedShape) {
            const textOutlineWorld = Math.min(
                Math.max(0.1, textOutlineThicknessMm),
                maxTextOutlineMm,
            );
            const textOutlineZ = stackTopZ + LAYER_GAP;
            let addedTextOutline = false;
            addExtrudedBorderLayer(
                topMergedShape,
                textOutlineZ,
                textOutlineDepth,
                textOutlineColor,
                "text-outline-border",
            );
            const textOutlineMat = new THREE.MeshStandardMaterial({
                color: textOutlineColor,
                roughness: 0.55,
                metalness: 0.08,
            });
            for (const entry of lineEntries) {
                if (entry.centeredPaths.length === 0) continue;
                const textOutlineTree = buildUnionOffsetTree(
                    entry.centeredPaths,
                    textOutlineWorld,
                );
                const textOutlineShapes = polyTreeToThreeShapes(textOutlineTree, (pt) =>
                    toVec2(pt),
                );
                if (textOutlineShapes.length === 0) continue;
                const textOutlineGeo = new THREE.ExtrudeGeometry(textOutlineShapes, {
                    depth: Math.max(0.1, textOutlineDepth),
                    bevelEnabled: false,
                    curveSegments: 12,
                });
                centerGeometryXY(textOutlineGeo);
                textOutlineGeo.computeBoundingBox();
                const outlineBb = textOutlineGeo.boundingBox!;
                textOutlineGeo.translate(0, 0, -outlineBb.min.z);
                const textOutlineMesh = new THREE.Mesh(textOutlineGeo, textOutlineMat);
                textOutlineMesh.name = "text-outline";
                textOutlineMesh.castShadow = true;
                textOutlineMesh.receiveShadow = true;
                textOutlineMesh.position.set(0, entry.yCenter, textOutlineZ);
                group.add(textOutlineMesh);
                addedTextOutline = true;
            }
            if (addedTextOutline) {
                stackTopZ = textOutlineZ + textOutlineDepth;
            }
        }

        // Main border frame + text share the inner panel (not stacked on the rim height).
        const mainLayerZ = stackTopZ + LAYER_GAP;
        if (topMergedShape) {
            addExtrudedBorderLayer(
                topMergedShape,
                mainLayerZ,
                topBorderDepth,
                accentColor,
                "border",
            );
        }

        if (lineEntries.length > 0) {
            const textZ = mainLayerZ;
            for (const entry of lineEntries) {
                const textMat = new THREE.MeshStandardMaterial({
                    color: accentColor,
                    roughness: 0.35,
                    metalness: 0.1,
                });
                const textMesh = new THREE.Mesh(entry.geo, textMat);
                textMesh.name = "text";
                textMesh.castShadow = true;
                textMesh.receiveShadow = true;
                textMesh.position.set(0, entry.yCenter, textZ);
                group.add(textMesh);
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
            cam.updateProjectionMatrix?.();
            keyLight.target.position.copy(center);
            keyLight.target.updateWorldMatrix?.(true, true);
        }
        if (!didInitFrame) {
            frameCameraToObject(box, camera, controls);
            didInitFrame = true;
        }
        {
            const s = measureWorldAabbSizeMm(group);
            modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
        }
    }

    async function exportSTL() {
        if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
        exportError = null;
        exportLoading = true;
        await tickThenYieldToPaint();
        try {
            if (!group || !scene) throw new Error("Scene not ready");
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
            if (geometries.length === 0)
                throw new Error("No geometry to export");
            const merged = BufferGeometryUtils.mergeGeometries(geometries);
            if (!merged) throw new Error("Failed to merge geometry");
            geometries.forEach((g) => g.dispose());
            const singleMesh = new THREE.Mesh(merged);
            const exporter = new STLExporter();
            const result = exporter.parse(singleMesh, { binary: true });
            merged.dispose();
            const buffer = result instanceof DataView ? result.buffer : result;
            if (!buffer || buffer.byteLength < 84)
                throw new Error("Export produced no geometry");
            const blob = new Blob([buffer], { type: "model/stl" });
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(`rounded-rect-${timestamp}.stl`, blob);
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Classic Name Tag Keychain",
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
        if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
        exportError = null;
        exportLoading = true;
        await tickThenYieldToPaint();
        try {
            if (!group || !scene) throw new Error("Scene not ready");
            rebuildMeshes();
            group.updateWorldMatrix(true, true);
            const exportGroup = group.clone(true);
            exportGroup.updateWorldMatrix(true, true);
            const blob = await exportTo3MF(exportGroup);
            if (!blob || blob.size === 0)
                throw new Error("Export produced no geometry");
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(`rounded-rect-multipart-${timestamp}.3mf`, blob);
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Classic Name Tag Keychain",
                format: "3mf"
            });
        onShowThankYou();
        } catch (e) {
            exportError = e instanceof Error ? e.message : "Export failed";
        } finally {
            exportLoading = false;
        }
    }

    async function openWithBambuStudio() {
        if (!group || !scene) return;
        if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
        openBambuStudioLoading = true;
        await tickThenYieldToPaint();
        try {
            rebuildMeshes();
            group.updateWorldMatrix(true, true);
            const exportGroup = group.clone(true);
            exportGroup.updateWorldMatrix(true, true);
            const blob = await exportTo3MF(exportGroup);
            if (!blob || blob.size === 0) return;
            const publicUrl = await upload3mfToSupabase(blob, 'nametag');
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Classic Name Tag Keychain",
                format: "bambu_studio"
            });
            window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
        } catch (err) {
            console.error('Open with Bambu Studio failed:', err);
        } finally {
            openBambuStudioLoading = false;
        }
    }

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

    $effect(() => {
        void baseWidth;
        void baseHeight;
        void cornerRadius;
        void baseDepth;
        void topBorderDepth;
        void keyringPosition;
        void baseColor;
        void accentColor;
        void lines;
        void lineSpacing;
        void textOutlineEnabled;
        void textOutlineThicknessMm;
        void textOutlineDepth;
        void textOutlineColor;
        saveSettings();
    });

    $effect(() => {
        void baseWidth;
        void baseHeight;
        void cornerRadius;
        void baseDepth;
        void topBorderDepth;
        void keyringPosition;
        void baseColor;
        void accentColor;
        void lines;
        void lineSpacing;
        void textOutlineEnabled;
        void textOutlineThicknessMm;
        void textOutlineDepth;
        void textOutlineColor;
        void maxTextOutlineMm;
        if (!scene || !group) return;
        rebuildMeshes();
    });

    $effect(() => {
        const userId = user?.id ?? null;
        void syncCustomPresetsFromAccount();
    });

    $effect(() => {
        void baseColor;
        void accentColor;
        void textOutlineColor;
        void textOutlineEnabled;
        activePresetId = findMatchingPresetId(galleryPresets);
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
    });
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
    <div
        class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
        <aside
            class="flex min-h-0 w-full max-w-[360px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]">
            <div class="flex shrink-0 items-center justify-between p-4">
                <h1 class="text-lg font-semibold tracking-tight text-slate-900">
                    Classic Name Tag Keychain
                </h1>
                <Button variant="outline" size="sm" onclick={onBack}>
                    Back
                </Button>
            </div>

            <div
                class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 pt-0">
                <div
                    class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3 mb-2">
                    <div class="flex items-center justify-between">
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700">
                            Lines
                        </div>
                        <span class="text-xs text-slate-500"
                            >{lines.length} of {MAX_LINES}</span>
                    </div>

                    {#each lines as line, i (i)}
                        <div
                            class="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                            <div class="mb-2 flex items-center justify-between">
                                <span
                                    class="text-[11px] font-semibold tracking-wide text-slate-500 uppercase"
                                    >Line {i + 1}</span>
                                <div class="flex items-center gap-1">
                                    <Button
                                        variant="outline"
                                        size="xs"
                                        class="h-7 w-7 p-0"
                                        title="Move up"
                                        aria-label="Move line up"
                                        disabled={i === 0}
                                        onclick={() => moveLine(i, -1)}>
                                        ↑
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="xs"
                                        class="h-7 w-7 p-0"
                                        title="Move down"
                                        aria-label="Move line down"
                                        disabled={i === lines.length - 1}
                                        onclick={() => moveLine(i, 1)}>
                                        ↓
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="xs"
                                        class="h-7 w-7 p-0 text-red-600 hover:bg-red-50 hover:text-red-700"
                                        title="Remove line"
                                        aria-label="Remove line"
                                        disabled={lines.length <= 1}
                                        onclick={() => removeLine(i)}>
                                        ✕
                                    </Button>
                                </div>
                            </div>

                            <label class="grid gap-1.5">
                                <span
                                    class="text-xs font-medium text-slate-700"
                                    >Content</span>
                                <input
                                    class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                    type="text"
                                    bind:value={line.content}
                                    placeholder={i === 0
                                        ? "Name"
                                        : "Subtitle"} />
                            </label>

                            <label class="mt-2 grid gap-1.5">
                                <span
                                    class="text-xs font-medium text-slate-700"
                                    >Font</span>
                                <FontSelect bind:value={line.fontKey} />
                            </label>

                            <div class="mt-2 grid grid-cols-2 gap-3">
                                <label class="grid gap-1.5">
                                    <div
                                        class="flex items-center justify-between gap-2">
                                        <span
                                            class="text-xs font-medium text-slate-700"
                                            >Size</span>
                                        <span
                                            class="text-xs tabular-nums text-slate-600"
                                            >{line.size}</span>
                                    </div>
                                    <Slider
                                        type="single"
                                        bind:value={line.size}
                                        min={2}
                                        max={16}
                                        step={0.5}
                                        class="w-full" />
                                </label>
                                <label class="grid gap-1.5">
                                    <div
                                        class="flex items-center justify-between gap-2">
                                        <span
                                            class="text-xs font-medium text-slate-700"
                                            >Depth</span>
                                        <span
                                            class="text-xs tabular-nums text-slate-600"
                                            >{line.depth}</span>
                                    </div>
                                    <Slider
                                        type="single"
                                        bind:value={line.depth}
                                        min={0.2}
                                        max={3}
                                        step={0.1}
                                        class="w-full" />
                                </label>
                            </div>
                        </div>
                    {/each}

                    <Button
                        variant="outline"
                        size="sm"
                        class="w-full"
                        onclick={addLine}
                        disabled={lines.length >= MAX_LINES}>
                        + Add line
                    </Button>

                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Line spacing</span>
                            <span class="text-xs tabular-nums text-slate-600"
                                >{lineSpacing}</span>
                        </div>
                        <Slider
                            type="single"
                            bind:value={lineSpacing}
                            min={0}
                            max={10}
                            step={0.1}
                            class="w-full" />
                    </label>

                    <ColorPalettePicker
                        bind:value={accentColor}
                        {palette}
                        label="Border & text color" />

                    <div
                        class="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white/70 p-3">
                        <div class="flex items-center justify-between gap-2">
                            <div class="text-xs font-semibold tracking-tight text-slate-700">
                                Text outline
                            </div>
                            <label class="flex items-center gap-2 text-xs font-medium text-slate-700">
                                <input
                                    class="h-4 w-4 accent-indigo-500"
                                    type="checkbox"
                                    bind:checked={textOutlineEnabled} />
                                Enabled
                            </label>
                        </div>
                        <p class="text-[11px] leading-snug text-slate-500">
                            Middle layer between letters and the base, with a matching border frame.
                        </p>
                        {#if textOutlineEnabled}
                            <label class="grid gap-1.5">
                                <div class="flex items-center justify-between gap-2">
                                    <span class="text-xs font-medium text-slate-700"
                                        >Text outline thickness</span>
                                    <span class="text-xs tabular-nums text-slate-600"
                                        >{textOutlineThicknessMm.toFixed(1)} mm</span>
                                </div>
                                <Slider
                                    type="single"
                                    bind:value={textOutlineThicknessMm}
                                    min={0.2}
                                    max={maxTextOutlineMm}
                                    step={0.1}
                                    class="w-full" />
                                <p class="text-[11px] text-slate-500">
                                    Max {maxTextOutlineMm.toFixed(1)} mm (inside the tag border).
                                </p>
                            </label>
                            <label class="grid gap-1.5">
                                <div class="flex items-center justify-between gap-2">
                                    <span class="text-xs font-medium text-slate-700"
                                        >Text outline depth</span>
                                    <span class="text-xs tabular-nums text-slate-600"
                                        >{textOutlineDepth}</span>
                                </div>
                                <Slider
                                    type="single"
                                    bind:value={textOutlineDepth}
                                    min={0.2}
                                    max={3}
                                    step={0.1}
                                    class="w-full" />
                            </label>
                            <ColorPalettePicker
                                bind:value={textOutlineColor}
                                {palette}
                                label="Text outline color" />
                        {/if}
                    </div>
                </div>
                <div class="grid grid-cols-1 gap-4">
                    <div
                        class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700">
                            Shape
                        </div>
                        <ColorPalettePicker
                            bind:value={baseColor}
                            {palette}
                            label="Color" />
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
                                    >Width</span>
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{baseWidth}</span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={baseWidth}
                                min={20}
                                max={80}
                                step={1}
                                class="w-full" />
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
                                    >Height</span>
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{baseHeight}</span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={baseHeight}
                                min={12}
                                max={50}
                                step={1}
                                class="w-full" />
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
                                    >Corner radius</span>
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{cornerRadius}</span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={cornerRadius}
                                min={0}
                                max={Math.min(baseWidth, baseHeight) / 2}
                                step={0.2}
                                class="w-full" />
                        </label>
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
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
                                    >Top border depth</span>
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{topBorderDepth}</span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={topBorderDepth}
                                min={0.2}
                                max={3}
                                step={0.2}
                                class="w-full" />
                        </label>
                        <div class="grid gap-1.5">
                            <span class="text-xs font-medium text-slate-700"
                                >Keyring position</span>
                            <div
                                class="grid w-full grid-cols-3 gap-1"
                                role="group"
                                aria-label="Keyring position">
                                <Button
                                    variant="outline"
                                    class="h-10 w-full text-lg {keyringPosition ===
                                    'topLeft'
                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                        : ''}"
                                    onclick={() =>
                                        (keyringPosition = "topLeft")}
                                    title="Top left"
                                    aria-pressed={keyringPosition ===
                                        "topLeft"}>
                                    ↖
                                </Button>
                                <Button
                                    variant="outline"
                                    class="h-10 w-full text-lg {keyringPosition ===
                                    'topCenter'
                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                        : ''}"
                                    onclick={() =>
                                        (keyringPosition = "topCenter")}
                                    title="Top center"
                                    aria-pressed={keyringPosition ===
                                        "topCenter"}>
                                    ↑
                                </Button>
                                <Button
                                    variant="outline"
                                    class="h-10 w-full text-lg {keyringPosition ===
                                    'topRight'
                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                        : ''}"
                                    onclick={() =>
                                        (keyringPosition = "topRight")}
                                    title="Top right"
                                    aria-pressed={keyringPosition ===
                                        "topRight"}>
                                    ↗
                                </Button>
                                <Button
                                    variant="outline"
                                    class="h-10 w-full text-lg {keyringPosition ===
                                    'leftCenter'
                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                        : ''}"
                                    onclick={() =>
                                        (keyringPosition = "leftCenter")}
                                    title="Left center"
                                    aria-pressed={keyringPosition ===
                                        "leftCenter"}>
                                    ←
                                </Button>
                                <div class="h-10" aria-hidden="true"></div>
                                <Button
                                    variant="outline"
                                    class="h-10 w-full text-lg {keyringPosition ===
                                    'rightCenter'
                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                        : ''}"
                                    onclick={() =>
                                        (keyringPosition = "rightCenter")}
                                    title="Right center"
                                    aria-pressed={keyringPosition ===
                                        "rightCenter"}>
                                    →
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="grid gap-2 rounded-2xl border border-violet-200/80 bg-violet-50/50 p-3">
                    <p class="text-xs font-semibold tracking-tight text-slate-800">Preset gallery</p>

                    {#if user}
                        <p class="text-[11px] text-slate-500">
                            {#if hasGalleryPresets}
                                Click a preset to apply its colors. Edit or delete any preset. Saved to
                                your account.
                            {:else}
                                No presets yet. Import the starter set or create your own.
                            {/if}
                        </p>
                        {#if presetSyncError}
                            <p class="text-[11px] text-red-600">{presetSyncError}</p>
                        {/if}
                        {#if customPresetsLoading}
                            <p class="text-[11px] text-slate-500">Loading your presets…</p>
                        {/if}

                        <div class="flex items-start justify-between gap-2">
                            <div class="min-w-0 flex-1"></div>
                            <div class="flex shrink-0 flex-col gap-1">
                                {#if !hasGalleryPresets}
                                    <Button
                                        type="button"
                                        size="sm"
                                        class="h-7 px-2 text-[11px]"
                                        disabled={importPresetsLoading}
                                        onclick={() => void importDefaultPresets()}>
                                        {importPresetsLoading ? "Importing…" : "Import default presets"}
                                    </Button>
                                {/if}
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    class="h-7 px-2 text-[11px]"
                                    onclick={openCreatePresetEditor}>
                                    + New
                                </Button>
                            </div>
                        </div>

                        {#if !hasGalleryPresets && !customPresetsLoading}
                            <p
                                class="rounded-lg border border-dashed border-violet-200 bg-white/60 px-3 py-4 text-center text-[11px] text-slate-600">
                                Import default presets to get {DEFAULT_BASIC_NAME_COLOR_PRESETS.length}
                                editable color combos, or use + New to add one.
                            </p>
                        {/if}

                        <div class="grid grid-cols-3 gap-2">
                            {#each galleryPresets as preset (preset.id)}
                                <div class="relative">
                                    <button
                                        type="button"
                                        class={[
                                            "w-full overflow-hidden rounded-lg border bg-white pr-6 text-left shadow-sm transition hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60",
                                            activePresetId === preset.id
                                                ? "border-indigo-400 ring-2 ring-indigo-400/30"
                                                : "border-slate-200/90 hover:border-slate-300",
                                        ].join(" ")}
                                        aria-pressed={activePresetId === preset.id}
                                        aria-label={`Apply ${preset.label} colors`}
                                        onclick={() => applyColorPreset(preset)}>
                                        <div class="flex h-11 w-full">
                                            <span
                                                class="min-w-0 flex-1"
                                                style:background-color={preset.baseColor}
                                                aria-hidden="true"></span>
                                            <span
                                                class="min-w-0 flex-1 border-x border-white/20"
                                                style:background-color={preset.textOutlineColor}
                                                aria-hidden="true"></span>
                                            <span
                                                class="min-w-0 flex-1"
                                                style:background-color={preset.accentColor}
                                                aria-hidden="true"></span>
                                        </div>
                                        <span
                                            class="block border-t border-slate-100 px-1 py-1.5 text-center text-[10px] font-medium leading-tight text-slate-700">
                                            {preset.label}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        class="absolute right-0.5 top-0.5 rounded bg-white/90 px-1 py-0.5 text-[9px] font-medium text-slate-600 shadow-sm hover:bg-white hover:text-indigo-700"
                                        aria-label={`Edit ${preset.label}`}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            openEditPresetEditor(preset);
                                        }}>
                                        Edit
                                    </button>
                                </div>
                            {/each}
                        </div>
                    {:else}
                        <p class="text-[11px] leading-relaxed text-slate-600">
                            Save and reuse color combinations. Import
                            {DEFAULT_BASIC_NAME_COLOR_PRESETS.length} starter presets, create your own,
                            and sync them to your account.
                        </p>
                        <Button type="button" size="sm" class="w-full" onclick={onRequestLogin}>
                            Sign in to use presets
                        </Button>
                        <p class="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                            Starter presets (preview)
                        </p>
                        <div class="grid grid-cols-3 gap-2 opacity-90" aria-hidden="true">
                            {#each DEFAULT_BASIC_NAME_COLOR_PRESETS as template (template.label)}
                                <div
                                    class="overflow-hidden rounded-lg border border-slate-200/90 bg-white shadow-sm">
                                    <div class="flex h-11 w-full">
                                        <span
                                            class="min-w-0 flex-1"
                                            style:background-color={snapColorToPalette(
                                                template.baseColor,
                                                palette,
                                                template.baseColor,
                                            )}></span>
                                        <span
                                            class="min-w-0 flex-1 border-x border-white/20"
                                            style:background-color={snapColorToPalette(
                                                template.textOutlineColor,
                                                palette,
                                                template.textOutlineColor,
                                            )}></span>
                                        <span
                                            class="min-w-0 flex-1"
                                            style:background-color={snapColorToPalette(
                                                template.accentColor,
                                                palette,
                                                template.accentColor,
                                            )}></span>
                                    </div>
                                    <span
                                        class="block border-t border-slate-100 px-1 py-1.5 text-center text-[10px] font-medium leading-tight text-slate-600">
                                        {template.label}
                                    </span>
                                </div>
                            {/each}
                        </div>
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
                    onSnapshot={() =>
                        downloadSnapshot(
                            renderer,
                            scene,
                            camera,
                            "rounded-rect",
                        )}
                    onExport={() => exportSTL()}
                    onExport3MF={() => export3MF()}
                    onOpenWithBambuStudio={() => openWithBambuStudio()}
                    openBambuStudioLoading={openBambuStudioLoading}
                    exportDisabled={exportLoading}
                    exportTitle={getExportTitle(user, subscriptionStatus, "Export STL (single mesh) or 3MF (multipart) for 3D print")}
                    {exportLoading}
                    showLockIcon={showExportLockIcon(user, subscriptionStatus)} />
                {#if exportError}
                    <p
                        class="absolute bottom-14 right-4 max-w-[200px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg">
                        {exportError}
                    </p>
                {/if}
            </div>
        </section>
    </div>

    {#if user}
        <Dialog.Root bind:open={presetEditorOpen} onOpenChange={onPresetEditorOpenChange}>
            <Dialog.Content class="max-w-md rounded-2xl border-slate-200 shadow-xl">
                <Dialog.Header>
                    <Dialog.Title>
                        {presetEditorMode === "edit" ? "Edit preset" : "New preset"}
                    </Dialog.Title>
                    <Dialog.Description class="text-sm text-slate-600">
                        {#if presetEditorMode === "edit"}
                            Update this saved color combination.
                        {:else}
                            Save the current tag colors as a reusable preset.
                        {/if}
                    </Dialog.Description>
                </Dialog.Header>

                <div class="grid gap-3 py-2">
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700">Name</span>
                        <input
                            type="text"
                            class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            bind:value={presetEditorLabel}
                            maxlength={32}
                            placeholder="My preset" />
                    </label>
                    <label class="flex items-center gap-2 text-xs font-medium text-slate-700">
                        <input
                            type="checkbox"
                            class="h-4 w-4 accent-indigo-500"
                            bind:checked={presetEditorTextOutlineEnabled} />
                        Text outline layer enabled
                    </label>
                    <ColorPalettePicker
                        bind:value={presetEditorBase}
                        {palette}
                        paletteOnly
                        label="Base" />
                    <ColorPalettePicker
                        bind:value={presetEditorTextOutline}
                        {palette}
                        paletteOnly
                        label="Text outline" />
                    <ColorPalettePicker
                        bind:value={presetEditorAccent}
                        {palette}
                        paletteOnly
                        label="Border & text" />
                </div>

                <Dialog.Footer class="flex flex-wrap items-center gap-2">
                    {#if presetEditorMode === "edit" && presetEditorId}
                        <Button
                            type="button"
                            variant="outline"
                            class="text-red-600 hover:text-red-700"
                            onclick={() => void deleteCustomPreset(presetEditorId!)}>
                            Delete
                        </Button>
                    {/if}
                    <div class="flex flex-wrap gap-2 sm:ml-auto">
                        <Button type="button" variant="outline" onclick={closePresetEditor}>
                            Cancel
                        </Button>
                        <Button type="button" onclick={() => void commitPresetEditor()}>
                            Save preset
                        </Button>
                    </div>
                </Dialog.Footer>
            </Dialog.Content>
        </Dialog.Root>
    {/if}
</main>
