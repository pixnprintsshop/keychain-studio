<script lang="ts">
	import { openInSlicer, type OpenWithSlicerId } from '$lib/openInSlicer';
    import type { Session, User } from "@supabase/supabase-js";
    import { onDestroy, onMount } from "svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import { exportTo3MF } from "$lib/export-to-3mf";
    import ClipperLib from "clipper-lib";
    import baseStlUrl from "$lib/assets/stl/dogtag/base.stl?url";
    import borderStlUrl from "$lib/assets/stl/dogtag/border.stl?url";
    import { snapColorToPalette, type PaletteColor } from "$lib/colorPalette";
    import {
        cloneDefaultDogTagPresetsAsCustom,
        DEFAULT_DOG_TAG_COLOR_PRESETS,
        isCustomDogTagPresetId,
        loadUserDogTagPresets,
        persistDogTagCustomPresets,
        type DogTagColorPreset,
    } from "$lib/dogTagPresets";
    import * as Dialog from "$lib/components/ui/dialog";
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
    import { ensureExportAccess, getExportTitle, showExportLockIcon, type SubscriptionStatus } from "$lib/subscription";
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

    const STORAGE_KEY = "keychain-dogtag-settings";
    /** Vertical gap between stacked layers so faces do not touch (avoids coplanar / non-manifold). */
    const LAYER_GAP = 0.001;
    /** Preview: sink text into the border/base stack (shared bottom plane with the rim). */
    const TEXT_BASE_EMBED = 0.2;
    /** STL export: extra overlap so merged mesh fuses cleanly at the lettering junction. */
    const TEXT_STL_FUSE_OVERLAP = 0.35;
    /** Sink border slightly into the base so its bottom is not coplanar with the base top face. */
    const BORDER_BASE_EMBED = 0.05;
    const WELD_TOL_MM = 1e-3;
    const CLIPPER_SCALE = 1000;
    const TOP_LOOP_SNAP_MM = 1e-4;
    const HOLE_MIN_AREA_RATIO = 0.005;

    const defaultSettings = {
        textContent: "Name",
        fontKey: FONT_OPTIONS[0]?.key ?? "Milkyway_Regular",
        textSize: 20,
        textScale: 1,
        textDepth: 0.8,
        textColor: "#ffffff",
        baseColor: "#94a3b8",
        textOutlineEnabled: false,
        textOutlineThicknessMm: 2,
        textOutlineDepth: 0.8,
        textOutlineColor: "#ffffff",
    };

    type TopLoop = THREE.Vector2[];
    type BoundaryEdge = { a: string; b: string };
    type BoundaryEdgeCount = BoundaryEdge & { count: number };
    type AdjacencyByKey = Record<string, string[] | undefined>;
    type BoundaryEdgesByKey = Record<string, BoundaryEdgeCount | undefined>;
    type PointsByKey = Record<string, THREE.Vector2 | undefined>;
    type VisitedEdgesByKey = Record<string, true | undefined>;

    function loadSettings() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (!stored) return { ...defaultSettings };
            const parsed = JSON.parse(stored) as Partial<typeof defaultSettings>;
            if (!parsed || typeof parsed !== "object") return { ...defaultSettings };
            return {
                textContent:
                    typeof parsed.textContent === "string"
                        ? parsed.textContent
                        : defaultSettings.textContent,
                fontKey:
                    typeof parsed.fontKey === "string" &&
                    FONT_OPTIONS.some((o) => o.key === parsed.fontKey)
                        ? parsed.fontKey
                        : defaultSettings.fontKey,
                textSize:
                    typeof parsed.textSize === "number" && Number.isFinite(parsed.textSize)
                        ? parsed.textSize
                        : defaultSettings.textSize,
                textScale:
                    typeof parsed.textScale === "number" && Number.isFinite(parsed.textScale)
                        ? parsed.textScale
                        : defaultSettings.textScale,
                textDepth:
                    typeof parsed.textDepth === "number" && Number.isFinite(parsed.textDepth)
                        ? Math.min(2, Math.max(0.2, parsed.textDepth))
                        : defaultSettings.textDepth,
                textColor:
                    typeof parsed.textColor === "string"
                        ? parsed.textColor
                        : defaultSettings.textColor,
                baseColor:
                    typeof parsed.baseColor === "string"
                        ? parsed.baseColor
                        : defaultSettings.baseColor,
                textOutlineEnabled:
                    typeof parsed.textOutlineEnabled === "boolean"
                        ? parsed.textOutlineEnabled
                        : defaultSettings.textOutlineEnabled,
                textOutlineThicknessMm:
                    typeof parsed.textOutlineThicknessMm === "number" &&
                    Number.isFinite(parsed.textOutlineThicknessMm)
                        ? Math.min(8, Math.max(0.2, parsed.textOutlineThicknessMm))
                        : defaultSettings.textOutlineThicknessMm,
                textOutlineDepth:
                    typeof parsed.textOutlineDepth === "number" &&
                    Number.isFinite(parsed.textOutlineDepth)
                        ? Math.min(3, Math.max(0.2, parsed.textOutlineDepth))
                        : defaultSettings.textOutlineDepth,
                textOutlineColor:
                    typeof parsed.textOutlineColor === "string"
                        ? parsed.textOutlineColor
                        : defaultSettings.textOutlineColor,
            };
        } catch {
            return { ...defaultSettings };
        }
    }

    const initial = loadSettings();

    let baseGeometry = $state<THREE.BufferGeometry | null>(null);
    let borderGeometry = $state<THREE.BufferGeometry | null>(null);
    let basePlanWidth = $state<number | null>(null);
    let textContent = $state(initial.textContent);
    let fontKey = $state(initial.fontKey);
    let textSize = $state(initial.textSize);
    let textScale = $state(initial.textScale);
    let textDepth = $state(initial.textDepth);
    let textColor = $state(initial.textColor);
    let baseColor = $state(initial.baseColor);
    let textOutlineEnabled = $state(initial.textOutlineEnabled);
    let textOutlineThicknessMm = $state(initial.textOutlineThicknessMm);
    let textOutlineDepth = $state(initial.textOutlineDepth);
    let textOutlineColor = $state(initial.textOutlineColor);

    const maxTextOutlineMm = $derived(
        Math.max(0.5, Math.min(8, (basePlanWidth ?? 50) * 0.22)),
    );

    let activePresetId = $state<string | null>(null);
    let customPresets = $state<DogTagColorPreset[]>([]);
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
    let presetEditorBase = $state("#94a3b8");
    let presetEditorText = $state("#ffffff");
    let presetEditorTextOutline = $state("#ffffff");
    let presetEditorTextOutlineEnabled = $state(false);

    function snapPresetColors(base: string, text: string, textOutline: string) {
        return {
            base: snapColorToPalette(base, palette, baseColor),
            text: snapColorToPalette(text, palette, textColor),
            textOutline: snapColorToPalette(textOutline, palette, textOutlineColor),
        };
    }

    function findMatchingPresetId(presets: DogTagColorPreset[]): string | null {
        for (const preset of presets) {
            if (
                preset.baseColor === baseColor &&
                preset.textColor === textColor &&
                preset.textOutlineColor === textOutlineColor &&
                (preset.textOutlineEnabled ?? false) === textOutlineEnabled
            ) {
                return preset.id;
            }
        }
        return null;
    }

    function applyColorPreset(preset: DogTagColorPreset) {
        const snapped = snapPresetColors(
            preset.baseColor,
            preset.textColor,
            preset.textOutlineColor,
        );
        baseColor = snapped.base;
        textColor = snapped.text;
        textOutlineColor = snapped.textOutline;
        textOutlineEnabled = preset.textOutlineEnabled ?? false;
        activePresetId = findMatchingPresetId(galleryPresets) ?? preset.id;
    }

    function setPresetEditorColors(base: string, text: string, textOutline: string) {
        const snapped = snapPresetColors(base, text, textOutline);
        presetEditorBase = snapped.base;
        presetEditorText = snapped.text;
        presetEditorTextOutline = snapped.textOutline;
    }

    function openCreatePresetEditor() {
        presetEditorMode = "create";
        presetEditorId = null;
        presetEditorLabel = "My preset";
        presetEditorTextOutlineEnabled = textOutlineEnabled;
        setPresetEditorColors(baseColor, textColor, textOutlineColor);
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
            customPresets = await loadUserDogTagPresets(userId);
            activePresetId = findMatchingPresetId(galleryPresets);
        } catch (e) {
            presetSyncError =
                e instanceof Error ? e.message : "Failed to load presets";
        } finally {
            customPresetsLoading = false;
        }
    }

    async function persistCustomPresets(presets: DogTagColorPreset[]) {
        if (!user?.id) return;
        const result = await persistDogTagCustomPresets(user.id, presets);
        if (!result.success) {
            presetSyncError = result.error;
            return;
        }
        presetSyncError = null;
    }

    function openEditPresetEditor(preset: DogTagColorPreset) {
        presetEditorMode = "edit";
        presetEditorId = preset.id;
        presetEditorLabel = preset.label;
        presetEditorTextOutlineEnabled = preset.textOutlineEnabled ?? false;
        setPresetEditorColors(preset.baseColor, preset.textColor, preset.textOutlineColor);
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
            presetEditorText,
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
                          textColor: snapped.text,
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
                    textColor: snapped.text,
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
            textColor: snapped.text,
            textOutlineColor: snapped.textOutline,
            textOutlineEnabled: enabled,
        });
        await persistCustomPresets(customPresets);
        closePresetEditor();
    }

    async function deleteCustomPreset(id: string) {
        if (!isCustomDogTagPresetId(id)) return;
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
            customPresets = cloneDefaultDogTagPresetsAsCustom((hex, fallback) =>
                snapColorToPalette(hex, palette, fallback),
            );
            await persistCustomPresets(customPresets);
            activePresetId = null;
        } catch (e) {
            presetSyncError =
                e instanceof Error ? e.message : "Failed to import presets";
        } finally {
            importPresetsLoading = false;
        }
    }

    let exportError = $state<string | null>(null);
    let exportLoading = $state(false);
    let openWithSlicerLoading = $state(false);

    function resize() {
        if (!renderer || !camera || !hostEl) return;
        const rect = hostEl.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
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
                    textScale,
                    textDepth,
                    textColor,
                    baseColor,
                    textOutlineEnabled,
                    textOutlineThicknessMm,
                    textOutlineDepth,
                    textOutlineColor,
                }),
            );
        } catch {
            /* ignore */
        }
    }

    function centerModelPair(baseGeo: THREE.BufferGeometry, borderGeo: THREE.BufferGeometry) {
        const box = new THREE.Box3();
        for (const geo of [baseGeo, borderGeo]) {
            geo.computeBoundingBox();
            if (geo.boundingBox) box.union(geo.boundingBox);
        }
        if (box.isEmpty()) return;
        const cx = (box.min.x + box.max.x) / 2;
        const cy = (box.min.y + box.max.y) / 2;
        const cz = box.min.z;
        for (const geo of [baseGeo, borderGeo]) {
            geo.translate(-cx, -cy, -cz);
            geo.computeBoundingBox();
            geo.computeVertexNormals();
        }
    }

    function centerAndBottomAlignGeometry(geo: THREE.BufferGeometry) {
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        if (!bb) return;
        const cx = (bb.min.x + bb.max.x) / 2;
        const cy = (bb.min.y + bb.max.y) / 2;
        const cz = bb.min.z;
        geo.translate(-cx, -cy, -cz);
        geo.computeBoundingBox();
        geo.computeVertexNormals();
    }

    function snapTopPoint(x: number, y: number) {
        const ix = Math.round(x / TOP_LOOP_SNAP_MM);
        const iy = Math.round(y / TOP_LOOP_SNAP_MM);
        return {
            key: `${ix},${iy}`,
            point: new THREE.Vector2(ix * TOP_LOOP_SNAP_MM, iy * TOP_LOOP_SNAP_MM),
        };
    }

    function boundaryEdgeKey(a: string, b: string) {
        return a < b ? `${a}|${b}` : `${b}|${a}`;
    }

    function addBoundaryCandidate(edges: BoundaryEdgesByKey, a: string, b: string) {
        if (a === b) return;
        const key = boundaryEdgeKey(a, b);
        const existing = edges[key];
        if (existing) {
            existing.count += 1;
            return;
        }
        edges[key] = { a, b, count: 1 };
    }

    function addAdjacent(adjacency: AdjacencyByKey, a: string, b: string) {
        const existing = adjacency[a];
        if (existing) {
            if (!existing.includes(b)) existing.push(b);
            return;
        }
        adjacency[a] = [b];
    }

    function signedLoopArea(points: TopLoop): number {
        let area = 0;
        for (let i = 0; i < points.length; i++) {
            const current = points[i];
            const next = points[(i + 1) % points.length];
            area += current.x * next.y - next.x * current.y;
        }
        return area / 2;
    }

    function traceBoundaryLoops(
        edges: BoundaryEdge[],
        pointsByKey: PointsByKey,
        areaEpsilon: number,
    ): TopLoop[] {
        const adjacency: AdjacencyByKey = {};
        for (const edge of edges) {
            addAdjacent(adjacency, edge.a, edge.b);
            addAdjacent(adjacency, edge.b, edge.a);
        }

        const visited: VisitedEdgesByKey = {};
        const loops: TopLoop[] = [];
        for (const edge of edges) {
            const firstEdgeKey = boundaryEdgeKey(edge.a, edge.b);
            if (visited[firstEdgeKey]) continue;

            const loopKeys = [edge.a, edge.b];
            const loopEdgeKeys = [firstEdgeKey];
            let previous = edge.a;
            let current = edge.b;
            let closed = false;

            for (let step = 0; step < edges.length + 2; step++) {
                if (current === edge.a) {
                    closed = true;
                    break;
                }
                const candidates = (adjacency[current] ?? []).filter(
                    (candidate) =>
                        !visited[boundaryEdgeKey(current, candidate)] &&
                        !loopEdgeKeys.includes(boundaryEdgeKey(current, candidate)),
                );
                const next =
                    candidates.find((candidate) => candidate !== previous) ??
                    candidates[0];
                if (!next) break;

                loopEdgeKeys.push(boundaryEdgeKey(current, next));
                loopKeys.push(next);
                previous = current;
                current = next;
            }

            if (!closed) continue;
            for (const loopEdgeKey of loopEdgeKeys) visited[loopEdgeKey] = true;
            if (loopKeys[loopKeys.length - 1] === loopKeys[0]) loopKeys.pop();
            if (loopKeys.length < 3) continue;

            const loop = loopKeys
                .map((key) => pointsByKey[key])
                .filter((point): point is THREE.Vector2 => !!point)
                .map((point) => point.clone());
            if (loop.length < 3 || Math.abs(signedLoopArea(loop)) <= areaEpsilon) continue;
            loops.push(loop);
        }
        return loops;
    }

    function extractTopPerimeterLoops(srcGeo: THREE.BufferGeometry): TopLoop[] {
        srcGeo.computeBoundingBox();
        const bb = srcGeo.boundingBox;
        if (!bb) return [];

        const depth = Math.max(0.001, bb.max.z - bb.min.z);
        const topZ = bb.max.z;
        const topTolerance = Math.max(1e-3, depth * 0.02);
        const planArea = Math.max(0.001, (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y));
        const areaEpsilon = Math.max(1e-4, planArea * 1e-8);
        const geometry = srcGeo.index ? srcGeo.toNonIndexed() : srcGeo;
        const position = geometry.getAttribute("position");
        if (!position || position.count < 3) {
            if (geometry !== srcGeo) geometry.dispose();
            return [];
        }

        const pointsByKey: PointsByKey = {};
        const edgeCounts: BoundaryEdgesByKey = {};
        try {
            for (let i = 0; i + 2 < position.count; i += 3) {
                const z0 = position.getZ(i);
                const z1 = position.getZ(i + 1);
                const z2 = position.getZ(i + 2);
                if (
                    Math.abs(z0 - topZ) > topTolerance ||
                    Math.abs(z1 - topZ) > topTolerance ||
                    Math.abs(z2 - topZ) > topTolerance
                ) {
                    continue;
                }

                const p0 = snapTopPoint(position.getX(i), position.getY(i));
                const p1 = snapTopPoint(position.getX(i + 1), position.getY(i + 1));
                const p2 = snapTopPoint(position.getX(i + 2), position.getY(i + 2));
                pointsByKey[p0.key] ??= p0.point;
                pointsByKey[p1.key] ??= p1.point;
                pointsByKey[p2.key] ??= p2.point;
                addBoundaryCandidate(edgeCounts, p0.key, p1.key);
                addBoundaryCandidate(edgeCounts, p1.key, p2.key);
                addBoundaryCandidate(edgeCounts, p2.key, p0.key);
            }

            const boundaryEdges = Object.values(edgeCounts)
                .filter((edge): edge is BoundaryEdgeCount => !!edge && edge.count === 1)
                .map(({ a, b }) => ({ a, b }));
            if (boundaryEdges.length < 3) return [];
            return traceBoundaryLoops(boundaryEdges, pointsByKey, areaEpsilon);
        } finally {
            if (geometry !== srcGeo) geometry.dispose();
        }
    }

    function buildTopPerimeterShape(srcGeo: THREE.BufferGeometry): THREE.Shape | null {
        const loops = extractTopPerimeterLoops(srcGeo)
            .map((loop) => ({ loop, area: signedLoopArea(loop) }))
            .sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
        if (loops.length === 0) return null;

        const outerArea = Math.abs(loops[0].area);
        const minHoleArea = Math.max(1e-4, outerArea * HOLE_MIN_AREA_RATIO);
        const outerPts = loops[0].loop.map((point) => point.clone());
        if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
        const shape = new THREE.Shape(outerPts);

        for (const { loop, area } of loops.slice(1)) {
            if (Math.abs(area) < minHoleArea) continue;
            const holePts = loop.map((point) => point.clone());
            if (!THREE.ShapeUtils.isClockWise(holePts)) holePts.reverse();
            shape.holes.push(new THREE.Path(holePts));
        }

        return shape;
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
                if (ch.IsHole?.() ?? ch.m_IsHole) {
                    const holeContour = ch.Contour?.() ?? ch.m_polygon ?? [];
                    if (holeContour.length >= 3) {
                        const holePts = holeContour.map(toVec2);
                        if (!THREE.ShapeUtils.isClockWise(holePts)) holePts.reverse();
                        shape.holes.push(new THREE.Path(holePts));
                    }
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

    function bottomAlignGeometryZ(geo: THREE.BufferGeometry, zOffset = 0) {
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        if (!bb) return;
        geo.translate(0, 0, -bb.min.z + zOffset);
        geo.computeBoundingBox();
    }

    /** Watertight rim from the border STL top profile (matches Whistle Bag Tag). */
    function buildDogTagBorderSolid(
        srcGeo: THREE.BufferGeometry,
        targetDepth: number,
    ): THREE.BufferGeometry {
        const shape = buildTopPerimeterShape(srcGeo);
        if (shape) {
            const geo = new THREE.ExtrudeGeometry([shape], {
                depth: Math.max(0.1, targetDepth),
                bevelEnabled: false,
                curveSegments: 8,
            });
            bottomAlignGeometryZ(geo);
            geo.computeVertexNormals();
            return geo;
        }
        const geo = srcGeo.clone();
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        if (!bb) return geo;
        const currentDepth = Math.max(0.001, bb.max.z - bb.min.z);
        const scale = Math.max(0.01, targetDepth) / currentDepth;
        geo.scale(1, 1, scale);
        bottomAlignGeometryZ(geo);
        geo.computeVertexNormals();
        return geo;
    }

    function cleanExportGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
        if (geo.attributes.uv) geo.deleteAttribute("uv");
        const welded = BufferGeometryUtils.mergeVertices(geo, WELD_TOL_MM);
        if (welded !== geo) geo.dispose();
        if (welded.attributes.uv) welded.deleteAttribute("uv");
        welded.computeVertexNormals();
        welded.computeBoundingBox();
        return welded;
    }

    function buildExportGroup(
        options: { liftTextOutOfEmbed?: boolean; stlFuse?: boolean } = {},
    ): THREE.Group {
        if (!baseGeometry || !group) throw new Error("Model geometry not ready");

        rebuildMeshes();
        group.updateWorldMatrix(true, true);

        const exportGroup = new THREE.Group();
        const baseGeo = cleanExportGeometry(baseGeometry.clone());
        const baseMesh = new THREE.Mesh(
            baseGeo,
            new THREE.MeshBasicMaterial({ color: baseColor }),
        );
        baseMesh.name = "base";
        exportGroup.add(baseMesh);

        const textDepthSafe = Math.max(0.1, textDepth);
        const borderPreview = group.children.find((child) => child.name === "border") as
            | THREE.Mesh
            | undefined;
        if (borderGeometry && borderPreview) {
            const borderGeo = cleanExportGeometry(
                buildDogTagBorderSolid(borderGeometry, textDepthSafe),
            );
            borderGeo.applyMatrix4(borderPreview.matrixWorld);
            const borderMesh = new THREE.Mesh(
                borderGeo,
                new THREE.MeshBasicMaterial({ color: textColor }),
            );
            borderMesh.name = "border";
            exportGroup.add(borderMesh);
        }

        for (const child of group.children) {
            const mesh = child as THREE.Mesh;
            if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.geometry) continue;
            if (mesh.name === "base" || mesh.name === "border") continue;

            const sceneMat = (
                Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
            ) as THREE.MeshStandardMaterial;
            const color = sceneMat?.color?.clone() ?? new THREE.Color(textColor);

            let geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
            if (mesh.name === "text") {
                geo = geo.clone();
                if (options.stlFuse) {
                    geo.translate(0, 0, -(TEXT_BASE_EMBED + TEXT_STL_FUSE_OVERLAP));
                } else if (options.liftTextOutOfEmbed) {
                    geo.translate(0, 0, TEXT_BASE_EMBED);
                }
                geo.computeBoundingBox();
            }

            const exportMesh = new THREE.Mesh(
                cleanExportGeometry(geo),
                new THREE.MeshBasicMaterial({ color }),
            );
            exportMesh.name = mesh.name;
            exportGroup.add(exportMesh);
        }

        exportGroup.updateWorldMatrix(true, true);
        if (exportGroup.children.length === 0) throw new Error("No geometry to export");
        return exportGroup;
    }

    type BuiltText = {
        geo: THREE.BufferGeometry;
        scaleCapped: number;
        centeredPaths: { X: number; Y: number }[][];
    } | null;

    function buildMainText(): BuiltText {
        const content = (textContent ?? "").trim();
        if (!content || !baseGeometry) return null;
        const font = getFont(fontKey);
        if (!font) return null;

        const shapes = font.generateShapes(content, textSize);
        if (shapes.length === 0) return null;

        const shapeDivisions = 18;
        const ensureClipperCW = (path: { X: number; Y: number }[], clockwise: boolean) => {
            const isCW = ClipperLib.Clipper.Orientation(path);
            if (isCW !== clockwise) path.reverse();
        };
        const shapeToClipperPaths = (shape: THREE.Shape) => {
            const toPath = (pts: THREE.Vector2[]) => {
                const out: { X: number; Y: number }[] = [];
                for (const p of pts) {
                    out.push({
                        X: Math.round(p.x * CLIPPER_SCALE),
                        Y: Math.round(p.y * CLIPPER_SCALE),
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

        let clipperPaths: { X: number; Y: number }[][] = [];
        for (const shape of shapes) clipperPaths.push(...shapeToClipperPaths(shape));

        const textGeo = new THREE.ExtrudeGeometry(shapes, {
            depth: Math.max(0.1, textDepth),
            bevelEnabled: false,
            curveSegments: 16,
        });
        centerGeometryXY(textGeo);
        bottomAlignGeometryZ(textGeo);
        textGeo.computeBoundingBox();
        const tb = textGeo.boundingBox;
        if (!tb) return null;

        baseGeometry.computeBoundingBox();
        const wb = baseGeometry.boundingBox!;
        const textH = Math.max(tb.max.y - tb.min.y, 0.01);
        const baseW = Math.max(0.01, wb.max.x - wb.min.x);
        const TARGET_HEIGHT_MM = 8 * (textSize / 20) * textScale;
        const scale = TARGET_HEIGHT_MM / textH;
        const scaleCap = (baseW * 0.7) / (tb.max.x - tb.min.x || 0.01);
        const scaleCapped = Math.min(scale, scaleCap);

        const cx = (tb.min.x + tb.max.x) / 2;
        const cy = (tb.min.y + tb.max.y) / 2;
        const centeredPaths = clipperPaths.map((path) =>
            path.map((pt) => ({
                X: Math.round((pt.X / CLIPPER_SCALE - cx) * scaleCapped * CLIPPER_SCALE),
                Y: Math.round((pt.Y / CLIPPER_SCALE - cy) * scaleCapped * CLIPPER_SCALE),
            })),
        );

        return { geo: textGeo, scaleCapped, centeredPaths };
    }

    function rebuildMeshes() {
        if (!group) return;
        disposeObject3D(group);
        group.clear();
        modelAabbMm = null;

        if (!baseGeometry) return;

        const baseMat = new THREE.MeshStandardMaterial({
            color: baseColor,
            roughness: 0.7,
            metalness: 0.15,
        });
        const baseGeo = baseGeometry.clone();
        baseGeo.computeVertexNormals();
        const baseMesh = new THREE.Mesh(baseGeo, baseMat);
        baseMesh.name = "base";
        baseMesh.castShadow = true;
        baseMesh.receiveShadow = true;
        group.add(baseMesh);

        baseGeometry.computeBoundingBox();
        const wb = baseGeometry.boundingBox!;
        const topZ = wb.max.z;
        const centerX = (wb.min.x + wb.max.x) / 2;
        const centerY = (wb.min.y + wb.max.y) / 2;

        const builtText = buildMainText();
        const borderShape = borderGeometry ? buildTopPerimeterShape(borderGeometry) : null;
        const hasTextOutlineLayer =
            textOutlineEnabled &&
            textOutlineThicknessMm > 0 &&
            builtText !== null &&
            builtText.centeredPaths.length > 0;

        const textDepthSafe = Math.max(0.1, textDepth);
        const outlineDepthSafe = Math.max(0.1, textOutlineDepth);
        /** Top of the base STL — where the border rim meets the tag (text seats here). */
        const seatingZ = topZ;
        const borderLayerZ = seatingZ - BORDER_BASE_EMBED;

        let stackTopZ = seatingZ;
        let stackedOutlineLayer = false;

        if (hasTextOutlineLayer && borderShape && builtText) {
            const textOutlineWorld = Math.min(
                Math.max(0.1, textOutlineThicknessMm),
                maxTextOutlineMm,
            );
            const outlineZ = stackTopZ + LAYER_GAP;
            addExtrudedBorderLayer(
                borderShape,
                outlineZ,
                outlineDepthSafe,
                textOutlineColor,
                "text-outline-border",
            );
            stackedOutlineLayer = true;
            stackTopZ = outlineZ + outlineDepthSafe;

            const toVec2 = (pt: { X: number; Y: number }) =>
                new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE);
            const outlineTree = buildUnionOffsetTree(builtText.centeredPaths, textOutlineWorld);
            const outlineShapes = polyTreeToThreeShapes(outlineTree, toVec2);
            if (outlineShapes.length > 0) {
                const outlineGeo = new THREE.ExtrudeGeometry(outlineShapes, {
                    depth: outlineDepthSafe,
                    bevelEnabled: false,
                    curveSegments: 12,
                });
                centerGeometryXY(outlineGeo);
                outlineGeo.computeBoundingBox();
                const outlineBb = outlineGeo.boundingBox!;
                outlineGeo.translate(0, 0, -outlineBb.min.z);
                const outlineMesh = new THREE.Mesh(
                    outlineGeo,
                    new THREE.MeshStandardMaterial({
                        color: textOutlineColor,
                        roughness: 0.55,
                        metalness: 0.08,
                    }),
                );
                outlineMesh.name = "text-outline";
                outlineMesh.castShadow = true;
                outlineMesh.receiveShadow = true;
                // centeredPaths are already in final mm; do not apply scaleCapped again (main text mesh does).
                outlineMesh.position.set(centerX, centerY, outlineZ);
                group.add(outlineMesh);
            }
        }

        const mainLayerZ = stackedOutlineLayer ? stackTopZ + LAYER_GAP : borderLayerZ;
        const borderZ = mainLayerZ;
        const textZ = mainLayerZ - TEXT_BASE_EMBED;

        if (borderGeometry) {
            const borderMat = new THREE.MeshStandardMaterial({
                color: textColor,
                roughness: 0.4,
                metalness: 0.1,
            });
            const borderMeshGeo = buildDogTagBorderSolid(borderGeometry, textDepthSafe);
            const borderMesh = new THREE.Mesh(borderMeshGeo, borderMat);
            borderMesh.name = "border";
            borderMesh.castShadow = true;
            borderMesh.receiveShadow = true;
            borderMesh.position.set(centerX, centerY, borderZ);
            group.add(borderMesh);
        }

        if (builtText) {
            const textMat = new THREE.MeshStandardMaterial({
                color: textColor,
                roughness: 0.4,
                metalness: 0.1,
            });
            const textMesh = new THREE.Mesh(builtText.geo, textMat);
            textMesh.name = "text";
            textMesh.castShadow = true;
            textMesh.receiveShadow = true;
            textMesh.scale.set(builtText.scaleCapped, builtText.scaleCapped, 1);
            textMesh.position.set(centerX, centerY, textZ);
            group.add(textMesh);
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
        if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
        if (!group || group.children.length === 0) {
            exportError = "Nothing to export";
            return;
        }
        exportError = null;
        exportLoading = true;
        await tickThenYieldToPaint();
        try {
            const exportGroup = buildExportGroup({ stlFuse: true });
            const geometries: THREE.BufferGeometry[] = [];
            for (const child of exportGroup.children) {
                if (!(child as THREE.Mesh).isMesh) continue;
                const mesh = child as THREE.Mesh;
                geometries.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
            }
            disposeObject3D(exportGroup);
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
            const welded = BufferGeometryUtils.mergeVertices(merged, WELD_TOL_MM);
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
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Dog Tag",
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
        if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
        let exportGroup: THREE.Group | null = null;
        try {
            exportGroup = buildExportGroup({ liftTextOutOfEmbed: true });
            const blob = await exportTo3MF(exportGroup);
            if (!blob || blob.size === 0) return;
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(`dog-tag-${timestamp}.3mf`, blob);
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Dog Tag",
                format: "3mf"
            });
            onShowThankYou();
        } finally {
            if (exportGroup) disposeObject3D(exportGroup);
        }
    }

    async function openWithSlicer(slicer: OpenWithSlicerId) {
        if (!group || !scene) return;
        if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
        openWithSlicerLoading = true;
        await tickThenYieldToPaint();
        try {
            const exportGroup = buildExportGroup({ liftTextOutOfEmbed: true });
            const blob = await exportTo3MF(exportGroup);
            disposeObject3D(exportGroup);
            if (!blob || blob.size === 0) return;
            const publicUrl = await upload3mfToSupabase(blob, 'dogtag');
            notifyExportEvent({
                email: user?.email,
                name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
                subscriptionStatus,
                designName: "Dog Tag",
                format: "bambu_studio"
            });
            openInSlicer(publicUrl, slicer);
        } catch (err) {
            console.error('Open with Bambu Studio failed:', err);
        } finally {
            openWithSlicerLoading = false;
        }
    }

    $effect(() => {
        void textContent;
        void fontKey;
        void textSize;
        void textScale;
        void textDepth;
        void textColor;
        void baseColor;
        void textOutlineEnabled;
        void textOutlineThicknessMm;
        void textOutlineDepth;
        void textOutlineColor;
        saveSettings();
    });

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
        void textOutlineEnabled;
        void textOutlineThicknessMm;
        void textOutlineDepth;
        void textOutlineColor;
        void maxTextOutlineMm;
        if (!scene || !group) return;
        rebuildMeshes();
    });

    $effect(() => {
        void user?.id;
        void syncCustomPresetsFromAccount();
    });

    $effect(() => {
        void baseColor;
        void textColor;
        void textOutlineColor;
        void textOutlineEnabled;
        activePresetId = findMatchingPresetId(galleryPresets);
    });

    async function loadDogTagModels() {
        const loader = new STLLoader();
        try {
            const [baseGeo, borderGeo] = await Promise.all([
                new Promise<THREE.BufferGeometry>((resolve, reject) => {
                    loader.load(baseStlUrl, resolve, undefined, reject);
                }),
                new Promise<THREE.BufferGeometry>((resolve, reject) => {
                    loader.load(borderStlUrl, resolve, undefined, reject);
                }),
            ]);
            baseGeo.computeVertexNormals();
            borderGeo.computeVertexNormals();
            // Dog tag STL parts aren't guaranteed to share an origin; align each part to the same
            // bbox-centered XY origin so the border sits correctly on the base.
            centerAndBottomAlignGeometry(baseGeo);
            centerAndBottomAlignGeometry(borderGeo);
            baseGeo.computeBoundingBox();
            const bb = baseGeo.boundingBox;
            if (bb) {
                basePlanWidth = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y);
            }
            baseGeometry = baseGeo;
            borderGeometry = borderGeo;
            didInitFrame = false;
            rebuildMeshes();
        } catch (e) {
            console.error("Failed to load dog tag STL models", e);
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

        void loadDogTagModels();

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
                <Button variant="outline" size="sm" onclick={onBack}>
                    Back
                </Button>
            </div>

            <div
                class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
                <p class="text-xs text-slate-500">
                    Personalize the dog tag with your text. Border and text share
                    depth and color; optionally add a middle text-outline layer.
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
                            for="dogtag-text-depth"
                            class="text-xs font-medium text-slate-700">
                            Text & border depth
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
                    label="Text & border color" />

                <ColorPalettePicker
                    bind:value={baseColor}
                    {palette}
                    label="Base color" />

                <div class="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
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
                        Middle layer between letters and the border stack, with a matching frame.
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
                                max={1}
                                step={0.1}
                                class="w-full" />
                        </label>
                        <label class="grid gap-1.5">
                            <div class="flex items-center justify-between gap-2">
                                <span class="text-xs font-medium text-slate-700"
                                    >Text outline depth</span>
                                <span class="text-xs tabular-nums text-slate-600"
                                    >{textOutlineDepth} mm</span>
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

                <div class="grid gap-2 rounded-2xl border border-violet-200/80 bg-violet-50/50 p-3">
                    <p class="text-xs font-semibold tracking-tight text-slate-800">
                        Preset gallery
                    </p>
                    {#if user}
                        <p class="text-[11px] text-slate-500">
                            {#if hasGalleryPresets}
                                Click a preset to apply its colors. Edit or delete any preset.
                                Saved to your account.
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
                                        {importPresetsLoading
                                            ? "Importing…"
                                            : "Import default presets"}
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
                                Import default presets to get {DEFAULT_DOG_TAG_COLOR_PRESETS.length}
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
                                                style:background-color={preset.textColor}
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
                            {DEFAULT_DOG_TAG_COLOR_PRESETS.length} starter presets, create your own,
                            and sync them to your account.
                        </p>
                        <Button type="button" size="sm" class="w-full" onclick={onRequestLogin}>
                            Sign in to use presets
                        </Button>
                        <p class="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                            Starter presets (preview)
                        </p>
                        <div class="grid grid-cols-3 gap-2 opacity-90" aria-hidden="true">
                            {#each DEFAULT_DOG_TAG_COLOR_PRESETS as template (template.label)}
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
                                                template.textColor,
                                                palette,
                                                template.textColor,
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
                    onSnapshot={() => {
                        if (renderer && scene && camera)
                            downloadSnapshot(
                                renderer,
                                scene,
                                camera,
                                "dog-tag",
                            );
                    }}
                    onExport={() => exportStl()}
                    exportDisabled={!baseGeometry || exportLoading}
                    exportTitle={getExportTitle(user, subscriptionStatus, "Export STL or 3MF")}
                    onExport3MF={() => export3MF()}
                    onOpenWithSlicer={openWithSlicer}
                    openWithSlicerLoading={openWithSlicerLoading}
                    {exportLoading}
                    showLockIcon={showExportLockIcon(user, subscriptionStatus)} />
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
                        bind:value={presetEditorText}
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
