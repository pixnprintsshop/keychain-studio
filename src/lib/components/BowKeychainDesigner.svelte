<script lang="ts">
    import type { Session, User } from "@supabase/supabase-js";
    import ClipperLib from "clipper-lib";
    import { onDestroy, onMount } from "svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import { exportTo3MF } from "three-3mf-exporter";
    import ribbonSvgRaw from "$lib/assets/svg/ribbon.svg?raw";
    import FontSelect from "$lib/components/FontSelect.svelte";
    import {
        centerGeometryXY,
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        FONT_OPTIONS,
        frameCameraToObject,
        getFont,
        makeKeyringGeometry,
    } from "$lib/utils-3d";
    import DesignerExportToolbar from "./DesignerExportToolbar.svelte";
    import { Button } from "$lib/components/ui/button";
    import { Slider } from "$lib/components/ui/slider";
    import ColorPalettePicker from "./ColorPalettePicker.svelte";
    import type { PaletteColor } from "$lib/colorPalette";
    import type { SubscriptionStatus } from "$lib/subscription";

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

    const STORAGE_KEY = "keychain-bow-settings";

    const BOW_TOP_BASE_EMBED = 0.05;
    const CLIPPER_SCALE = 1000;
    const TEXT_BASE_FONT_SIZE = 18;
    const TEXT_EMBED = 0.02;

    interface BowSettings {
        baseDepth: number;
        baseColor: string;
        topDepth: number;
        topColor: string;
        text: string;
        textFontKey: string;
        textSize: number;
        textDepth: number;
        textColor: string;
        keyringEnabled: boolean;
        keyringOuterSize: number;
        keyringHoleSize: number;
        keyringDepth: number;
    }

    const defaults: BowSettings = {
        baseDepth: 1.4,
        baseColor: "#ffffff",
        topDepth: 1.2,
        topColor: "#fb7185",
        text: "Jen",
        textFontKey: FONT_OPTIONS[0]?.key ?? "Titan One_Regular",
        textSize: 12,
        textDepth: 1.2,
        textColor: "#ffffff",
        keyringEnabled: true,
        keyringOuterSize: 8,
        keyringHoleSize: 4,
        keyringDepth: 2,
    };

    function loadSettings(): BowSettings {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
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
    let text = $state(initial.text);
    let textFontKey = $state(
        initial.textFontKey &&
            FONT_OPTIONS.some((f) => f.key === initial.textFontKey)
            ? initial.textFontKey
            : (FONT_OPTIONS[0]?.key ?? "Titan One_Regular"),
    );
    let textSize = $state(initial.textSize);
    let textDepth = $state(initial.textDepth);
    let textColor = $state(initial.textColor);
    let keyringEnabled = $state(initial.keyringEnabled);
    let keyringOuterSize = $state(initial.keyringOuterSize);
    let keyringHoleSize = $state(initial.keyringHoleSize);
    let keyringDepth = $state(initial.keyringDepth);

    // ── Three.js state ──────────────────────────────────────────────────────
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

    // Base bow geometry (unit depth, centered) and expanded outline geometry
    let bowGeoUnit: THREE.BufferGeometry | null = null;
    let bowOutlineGeoUnit: THREE.BufferGeometry | null = null;

    let exportError = $state<string | null>(null);
    let exportLoading = $state(false);

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
                    text,
                    textFontKey,
                    textSize,
                    textDepth,
                    textColor,
                    keyringEnabled,
                    keyringOuterSize,
                    keyringHoleSize,
                    keyringDepth,
                }),
            );
        } catch {}
    }

    function centerAndNormalize(geo: THREE.BufferGeometry) {
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        if (!bb) return;
        const cx = (bb.min.x + bb.max.x) / 2;
        const cy = (bb.min.y + bb.max.y) / 2;
        const cz = bb.min.z;
        geo.translate(-cx, -cy, -cz);
        geo.computeBoundingBox();
    }

    function scaleGeometryToDepth(
        srcGeo: THREE.BufferGeometry,
        targetDepth: number,
    ): THREE.BufferGeometry {
        const geo = srcGeo.clone();
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        if (bb) {
            const currentDepth = bb.max.z - bb.min.z;
            if (currentDepth > 0.001) {
                const scale = Math.max(0.01, targetDepth) / currentDepth;
                geo.scale(1, 1, scale);
            }
        }
        geo.computeBoundingBox();
        return geo;
    }

    function rebuildMeshes() {
        if (!scene || !group || !bowGeoUnit || !bowOutlineGeoUnit) return;
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

        const baseD = Math.max(0.01, baseDepth);
        const topD = Math.max(0.01, topDepth);

        // Lower outline base: offset version of bow path (from Clipper)
        const baseGeoRaw = scaleGeometryToDepth(bowOutlineGeoUnit, baseDepth);
        const baseMesh = new THREE.Mesh(baseGeoRaw, baseMat);
        baseMesh.name = "base";
        baseMesh.rotation.z = Math.PI;
        baseMesh.castShadow = true;
        baseMesh.receiveShadow = true;
        baseMesh.position.z = 0;
        group.add(baseMesh);

        // Main bow base on top
        const topGeo = scaleGeometryToDepth(bowGeoUnit, topDepth);
        const topMesh = new THREE.Mesh(topGeo, topMat);
        topMesh.name = "top";
        topMesh.rotation.z = Math.PI;
        topMesh.castShadow = true;
        topMesh.receiveShadow = true;
        topMesh.position.z = baseD - BOW_TOP_BASE_EMBED;
        group.add(topMesh);

        // Bow bounds for text scaling & keyring placement
        topGeo.computeBoundingBox();
        const bowBB = topGeo.boundingBox;
        const bowWidth =
            bowBB && bowBB.max.x > bowBB.min.x ? bowBB.max.x - bowBB.min.x : 1;
        const bowHeight =
            bowBB && bowBB.max.y > bowBB.min.y ? bowBB.max.y - bowBB.min.y : 1;
        const bowTopY = bowBB ? bowBB.max.y : 0;

        // Text on top (scaled and capped like WhistleDesigner)
        const content = (text ?? "").trim();
        if (content) {
            const font = getFont(textFontKey);
            if (font) {
                const shapes = font.generateShapes(
                    content,
                    TEXT_BASE_FONT_SIZE,
                );
                if (shapes.length > 0) {
                    const textGeo = new THREE.ExtrudeGeometry(shapes, {
                        depth: baseD,
                        bevelEnabled: false,
                    });
                    centerGeometryXY(textGeo);

                    const textMat = new THREE.MeshStandardMaterial({
                        color: textColor,
                        roughness: 0.35,
                        metalness: 0.1,
                    });

                    textGeo.computeBoundingBox();
                    const tb = textGeo.boundingBox;
                    const textWidth =
                        tb && tb.max.x > tb.min.x ? tb.max.x - tb.min.x : 1;
                    const textHeight =
                        tb && tb.max.y > tb.min.y ? tb.max.y - tb.min.y : 1;

                    const baseScale = textSize / defaults.textSize;
                    const TARGET_HEIGHT = bowHeight * 0.45;
                    const rawScale = (TARGET_HEIGHT * baseScale) / textHeight;
                    const widthCap = (bowWidth * 0.9) / textWidth;
                    const scaleCapped = Math.min(rawScale, widthCap);

                    const textMesh = new THREE.Mesh(textGeo, textMat);
                    textMesh.name = "text";
                    textMesh.scale.set(scaleCapped, scaleCapped, 1);
                    textMesh.castShadow = true;
                    textMesh.receiveShadow = true;
                    textMesh.position.set(0, 10, 0);
                    group.add(textMesh);

                    // Second text instance on top of base (same XY scale), bow height, for bow+text STL
                    const textTopGeo = new THREE.ExtrudeGeometry(shapes, {
                        depth: topD,
                        bevelEnabled: false,
                    });
                    centerGeometryXY(textTopGeo);
                    const textTopMesh = new THREE.Mesh(textTopGeo, textMat);
                    textTopMesh.name = "textTop";
                    textTopMesh.scale.set(scaleCapped, scaleCapped, 1);
                    textTopMesh.castShadow = true;
                    textTopMesh.receiveShadow = true;
                    textTopMesh.position.set(0, 10, baseD);
                    group.add(textTopMesh);

                    // Third text instance on top of the bow (for 3MF "text only at top" layer)
                    const extraTextD = Math.max(0.01, textDepth);
                    const textTopMostGeo = new THREE.ExtrudeGeometry(shapes, {
                        depth: extraTextD,
                        bevelEnabled: false,
                    });
                    centerGeometryXY(textTopMostGeo);
                    const textTopMostMesh = new THREE.Mesh(textTopMostGeo, textMat);
                    textTopMostMesh.name = "textTopMost";
                    textTopMostMesh.scale.set(scaleCapped, scaleCapped, 1);
                    textTopMostMesh.castShadow = true;
                    textTopMostMesh.receiveShadow = true;
                    textTopMostMesh.position.set(0, 10, baseD + topD);
                    group.add(textTopMostMesh);
                }
            }
        }

        // Optional keyring eyelet at top center
        if (keyringEnabled) {
            const ringGeo = makeKeyringGeometry(
                Math.max(1, keyringOuterSize),
                Math.max(
                    0.1,
                    Math.min(keyringHoleSize, keyringOuterSize - 0.5),
                ),
                Math.max(0.1, Math.min(keyringDepth, baseDepth)),
            );
            const ringMat = new THREE.MeshStandardMaterial({
                color: baseColor,
                roughness: 0.85,
                metalness: 0.05,
            });
            const ringMesh = new THREE.Mesh(ringGeo, ringMat);
            ringMesh.name = "keyring";
            ringMesh.castShadow = true;
            ringMesh.receiveShadow = true;
            ringMesh.position.set(0, bowTopY - 4, 0);
            group.add(ringMesh);
        }

        group.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(group);
        if (keyLight?.shadow?.camera) {
            const sizeVec = new THREE.Vector3();
            box.getSize(sizeVec);
            const center = new THREE.Vector3();
            box.getCenter(center);
            const r = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 0.75 + 10;
            const cam = keyLight.shadow.camera as THREE.OrthographicCamera;
            cam.left = -r;
            cam.right = r;
            cam.top = r;
            cam.bottom = -r;
            cam.near = 0.1;
            cam.far = Math.max(300, r * 6);
            cam.updateProjectionMatrix();
            keyLight.target.position.copy(center);
            keyLight.target.updateWorldMatrix?.(true, true);
        }
        if (!didInitFrame && camera && controls) {
            frameCameraToObject(box, camera, controls);
            didInitFrame = true;
        }
    }

    /** STL: outline base + merged text, then bow + merged text on top; all merged into one watertight STL. */
    async function exportSTL() {
        if (!user) {
            onRequestLogin();
            return;
        }
        if (!group || group.children.length === 0) {
            exportError = "Nothing to export";
            return;
        }
        exportError = null;
        exportLoading = true;
        try {
            group.updateWorldMatrix(true, true);
            const forStl: THREE.Mesh[] = [];
            for (const child of group.children) {
                if (!(child as THREE.Mesh).isMesh) continue;
                const mesh = child as THREE.Mesh;
                const name = mesh.name;
                if (
                    name === "base" ||
                    name === "keyring" ||
                    name === "text" ||
                    name === "top" ||
                    name === "textTop" ||
                    name === "textTopMost"
                ) {
                    forStl.push(mesh);
                }
            }
            if (forStl.length === 0) {
                exportError = "Nothing to export";
                return;
            }
            const geometries: THREE.BufferGeometry[] = [];
            for (const mesh of forStl) {
                let g = mesh.geometry
                    .clone()
                    .applyMatrix4(mesh.matrixWorld);
                if (g.getAttribute("uv")) g.deleteAttribute("uv");
                if (!g.getAttribute("normal")) g.computeVertexNormals();
                if (g.index) {
                    const nonIndexed = g.toNonIndexed();
                    g.dispose();
                    g = nonIndexed;
                }
                geometries.push(g);
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
            if (geometries.length > 1) {
                geometries.forEach((g) => g !== merged && g.dispose());
            }
            const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
            if (welded !== merged) merged.dispose();

            const exporter = new STLExporter();
            const result = exporter.parse(new THREE.Mesh(welded), {
                binary: true,
            });
            welded.dispose();
            const buffer = (result as DataView).buffer as ArrayBuffer;
            if (!buffer || buffer.byteLength < 84) {
                exportError = "Export produced empty geometry";
                return;
            }
            const safe = (text || "bow")
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "");
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(
                `${safe || "bow"}-${ts}.stl`,
                new Blob([buffer], { type: "model/stl" }),
            );
            onShowThankYou();
        } catch (e) {
            exportError = e instanceof Error ? e.message : "Export failed";
        } finally {
            exportLoading = false;
        }
    }

    /** Multi-color 3MF: 3 objects. (1) Outline base + text. (2) Main bow + text merged. (3) Text only at top. Each one color. */
    async function export3MF() {
        if (!user) {
            onRequestLogin();
            return;
        }
        if (!group || group.children.length === 0) {
            exportError = "Nothing to export";
            return;
        }
        exportError = null;
        exportLoading = true;
        try {
            group.updateWorldMatrix(true, true);
            const byName: Record<string, THREE.Mesh> = {};
            for (const child of group.children) {
                if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).name) {
                    byName[(child as THREE.Mesh).name] = child as THREE.Mesh;
                }
            }
            const baseMesh = byName.base;
            const topMesh = byName.top;
            const textMesh = byName.text;
            const textTopMesh = byName.textTop;
            const keyringMesh = byName.keyring;
            if (!baseMesh) {
                exportError = "Nothing to export";
                return;
            }
            const geoWorld = (mesh: THREE.Mesh) =>
                mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
            const mergeAll = (meshes: THREE.Mesh[]) => {
                const geos = meshes.map(geoWorld);
                const merged =
                    geos.length === 1
                        ? geos[0]
                        : BufferGeometryUtils.mergeGeometries(geos);
                if (!merged) return null;
                if (geos.length > 1) geos.forEach((g) => g !== merged && g.dispose());
                return BufferGeometryUtils.mergeVertices(merged, 1e-3);
            };
            const exportGroup = new THREE.Group();
            // Bottom layer: expanded bow (base) + text merged, one color
            const bottomMeshes = [baseMesh].concat(keyringMesh ? [keyringMesh] : []);
            if (textMesh) bottomMeshes.push(textMesh);
            const bottomGeo = mergeAll(bottomMeshes);
            if (bottomGeo) {
                exportGroup.add(
                    new THREE.Mesh(
                        bottomGeo,
                        new THREE.MeshBasicMaterial({
                            color: new THREE.Color(baseColor),
                        }),
                    ),
                );
            }
            // Main bow + text merged as 1 object, one color (topColor)
            const bowTextMeshes = topMesh ? [topMesh] : [];
            if (textTopMesh) bowTextMeshes.push(textTopMesh);
            const bowTextGeo =
                bowTextMeshes.length > 0 ? mergeAll(bowTextMeshes) : null;
            if (bowTextGeo) {
                exportGroup.add(
                    new THREE.Mesh(
                        bowTextGeo,
                        new THREE.MeshBasicMaterial({
                            color: new THREE.Color(topColor),
                        }),
                    ),
                );
            }
            // Text only on top of the bow, one color (textColor)
            const textTopMostMesh = byName.textTopMost;
            if (textTopMostMesh) {
                const textOnlyGeo = mergeAll([textTopMostMesh]);
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
            if (exportGroup.children.length === 0) {
                exportError = "Nothing to export";
                return;
            }
            exportGroup.updateWorldMatrix(true, true);
            const blob = await exportTo3MF(exportGroup);
            if (!blob || blob.size === 0) {
                exportError = "3MF export produced no data";
                return;
            }
            const safe = (text || "bow")
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "");
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(
                `${safe || "bow"}-${ts}.3mf`,
                blob,
            );
            onShowThankYou();
        } catch (e) {
            exportError = e instanceof Error ? e.message : "3MF export failed";
        } finally {
            exportLoading = false;
        }
    }

    onMount(() => {
        if (!hostEl) return;

        try {
            const loader = new SVGLoader();
            const parsed = loader.parse(ribbonSvgRaw);
            const shapes: THREE.Shape[] = [];
            for (const p of parsed.paths) {
                const pShapes = SVGLoader.createShapes(p);
                for (const s of pShapes) shapes.push(s);
            }

            const geos: THREE.BufferGeometry[] = [];
            for (const s of shapes) {
                const geo = new THREE.ExtrudeGeometry(s, {
                    depth: 1,
                    bevelEnabled: false,
                });
                geos.push(geo);
            }
            const merged = BufferGeometryUtils.mergeGeometries(geos, true);
            if (!merged) throw new Error("Failed to merge bow geometry");
            centerAndNormalize(merged);
            bowGeoUnit = merged;

            const divisions = 24;
            const shapeToPaths = (shape: THREE.Shape) => {
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
                const outer = toPath(shape.getPoints(divisions));
                const holes = (shape.holes || []).map((h) =>
                    toPath(h.getPoints(divisions)),
                );
                return { outer, holes };
            };

            const ensureCW = (
                path: { X: number; Y: number }[],
                clockwise: boolean,
            ) => {
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

            if (inputPaths.length > 0) {
                let minX = Infinity;
                let maxX = -Infinity;
                for (const path of inputPaths) {
                    for (const pt of path) {
                        if (pt.X < minX) minX = pt.X;
                        if (pt.X > maxX) maxX = pt.X;
                    }
                }
                const width = maxX - minX;
                const offset = Math.max(5, Math.round(width * 0.03));

                const outlineTree = new ClipperLib.PolyTree();
                const co = new ClipperLib.ClipperOffset(2, 2);
                co.AddPaths(
                    inputPaths,
                    ClipperLib.JoinType.jtRound,
                    ClipperLib.EndType.etClosedPolygon,
                );
                const offsetPaths: { X: number; Y: number }[][] = [];
                co.Execute(offsetPaths, offset);

                const c = new ClipperLib.Clipper();
                c.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
                c.Execute(
                    ClipperLib.ClipType.ctUnion,
                    outlineTree,
                    ClipperLib.PolyFillType.pftNonZero,
                    ClipperLib.PolyFillType.pftNonZero,
                );

                const polyTreeToThreeShapes = (tree: unknown) => {
                    const out: THREE.Shape[] = [];
                    const toVec2 = (pt: { X: number; Y: number }) =>
                        new THREE.Vector2(
                            pt.X / CLIPPER_SCALE,
                            pt.Y / CLIPPER_SCALE,
                        );
                    const buildFromOuter = (
                        outerNode: unknown,
                    ): THREE.Shape | null => {
                        const contour =
                            (
                                outerNode as {
                                    Contour?: () => { X: number; Y: number }[];
                                }
                            ).Contour?.() ??
                            (
                                outerNode as {
                                    m_polygon?: { X: number; Y: number }[];
                                }
                            ).m_polygon ??
                            [];
                        if (!contour || contour.length < 3) return null;
                        const pts = contour.map(toVec2);
                        if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
                        const shape = new THREE.Shape(pts);
                        const children =
                            (
                                outerNode as { Childs?: () => unknown[] }
                            ).Childs?.() ??
                            (outerNode as { m_Childs?: unknown[] }).m_Childs ??
                            [];
                        for (const ch of children) {
                            const isHole =
                                (ch as { IsHole?: () => boolean }).IsHole?.() ??
                                (ch as { m_IsHole?: boolean }).m_IsHole;
                            if (!isHole) continue;
                            const holeContour =
                                (
                                    ch as {
                                        Contour?: () => {
                                            X: number;
                                            Y: number;
                                        }[];
                                    }
                                ).Contour?.() ??
                                (
                                    ch as {
                                        m_polygon?: { X: number; Y: number }[];
                                    }
                                ).m_polygon ??
                                [];
                            if (holeContour.length >= 3) {
                                const holePts = holeContour.map(toVec2);
                                if (!THREE.ShapeUtils.isClockWise(holePts))
                                    holePts.reverse();
                                shape.holes.push(new THREE.Path(holePts));
                            }
                        }
                        return shape;
                    };
                    const roots =
                        (tree as { Childs?: () => unknown[] }).Childs?.() ??
                        (tree as { m_Childs?: unknown[] }).m_Childs ??
                        [];
                    for (const n of roots) {
                        const isHole =
                            (n as { IsHole?: () => boolean }).IsHole?.() ??
                            (n as { m_IsHole?: boolean }).m_IsHole;
                        if (isHole) continue;
                        const s = buildFromOuter(n);
                        if (s) out.push(s);
                    }
                    return out;
                };

                const outlineShapes = polyTreeToThreeShapes(outlineTree);
                const outlineGeos: THREE.BufferGeometry[] = [];
                for (const s of outlineShapes) {
                    const geo = new THREE.ExtrudeGeometry(s, {
                        depth: 1,
                        bevelEnabled: false,
                    });
                    outlineGeos.push(geo);
                }
                if (outlineGeos.length > 0) {
                    const mergedOutline = BufferGeometryUtils.mergeGeometries(
                        outlineGeos,
                        true,
                    );
                    if (mergedOutline) {
                        centerAndNormalize(mergedOutline);
                        bowOutlineGeoUnit = mergedOutline;
                    }
                }
            }
        } catch (e) {
            console.error("Failed to build bow geometry from SVG", e);
        }

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
        void baseDepth;
        void baseColor;
        void topDepth;
        void topColor;
        void text;
        void textFontKey;
        void textSize;
        void textDepth;
        void textColor;
        void keyringDepth;
        void keyringOuterSize;
        void keyringHoleSize;
        void keyringEnabled;
        saveSettings();
    });

    $effect(() => {
        const maxRing = Math.max(0.6, baseDepth);
        if (keyringDepth > maxRing) keyringDepth = maxRing;
    });

    $effect(() => {
        void baseDepth;
        void baseColor;
        void topDepth;
        void topColor;
        void text;
        void textFontKey;
        void textSize;
        void textDepth;
        void textColor;
        void keyringEnabled;
        void keyringOuterSize;
        void keyringHoleSize;
        void keyringDepth;
        if (!scene || !group) return;
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
        if (
            renderer &&
            hostEl &&
            renderer.domElement.parentElement === hostEl
        ) {
            hostEl.removeChild(renderer.domElement);
        }
        renderer?.dispose();
        renderer = null;
        scene = null;
        camera = null;
        group = null;
    });
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
    <div
        class="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-4 lg:flex-row min-h-0">
        <aside
            class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]">
            <div class="flex shrink-0 items-center justify-between p-4">
                <h1 class="text-lg font-semibold tracking-tight text-slate-900">
                    Bow Keychain
                </h1>
                <Button variant="outline" size="sm" onclick={onBack}>
                    Back
                </Button>
            </div>

            <div
                class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 pt-0 pr-1">
                <div
                    class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3 mb-2">
                    <div
                        class="text-xs font-semibold tracking-tight text-slate-700">
                        Text
                    </div>
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Content</span>
                        <input
                            class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            type="text"
                            bind:value={text}
                            placeholder="Name" />
                    </label>
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Font</span>
                        <FontSelect bind:value={textFontKey} />
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
                            min={8}
                            max={40}
                            step={1}
                            class="w-full" />
                    </label>
                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Text thickness</span>
                            <span class="text-xs tabular-nums text-slate-600"
                                >{textDepth}</span>
                        </div>
                        <Slider
                            type="single"
                            bind:value={textDepth}
                            min={0.4}
                            max={4}
                            step={0.1}
                            class="w-full" />
                    </label>
                    <ColorPalettePicker
                        bind:value={textColor}
                        {palette}
                        label="Text color" />
                </div>

                <div
                    class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                    <div
                        class="text-xs font-semibold tracking-tight text-slate-700">
                        Bow Base
                    </div>
                    <ColorPalettePicker
                        bind:value={baseColor}
                        {palette}
                        label="Outline color" />
                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Outline thickness</span>
                            <span class="text-xs tabular-nums text-slate-600"
                                >{baseDepth}</span>
                        </div>
                        <Slider
                            type="single"
                            bind:value={baseDepth}
                            min={0.4}
                            max={4}
                            step={0.1}
                            class="w-full" />
                    </label>
                    <ColorPalettePicker
                        bind:value={topColor}
                        {palette}
                        label="Bow color" />
                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Bow thickness</span>
                            <span class="text-xs tabular-nums text-slate-600"
                                >{topDepth}</span>
                        </div>
                        <Slider
                            type="single"
                            bind:value={topDepth}
                            min={0.4}
                            max={4}
                            step={0.1}
                            class="w-full" />
                    </label>

                    <div class="mt-1 border-t border-slate-200 pt-2">
                        <div class="mb-1.5 flex items-center justify-between">
                            <span class="text-xs font-semibold text-slate-700"
                                >Keyring</span>
                            <label
                                class="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600">
                                <input
                                    type="checkbox"
                                    bind:checked={keyringEnabled}
                                    class="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                                <span>Enabled</span>
                            </label>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <label class="grid gap-0.5">
                                <div
                                    class="flex items-center justify-between gap-1.5">
                                    <span
                                        class="text-[11px] font-medium text-slate-700"
                                        >Outer Ø</span>
                                    <span
                                        class="text-[11px] tabular-nums text-slate-600">
                                        {keyringOuterSize.toFixed(1)} mm
                                    </span>
                                </div>
                                <Slider
                                    type="single"
                                    bind:value={keyringOuterSize}
                                    min={4}
                                    max={14}
                                    step={0.5}
                                    class="w-full" />
                            </label>
                            <label class="grid gap-0.5">
                                <div
                                    class="flex items-center justify-between gap-1.5">
                                    <span
                                        class="text-[11px] font-medium text-slate-700"
                                        >Hole Ø</span>
                                    <span
                                        class="text-[11px] tabular-nums text-slate-600">
                                        {keyringHoleSize.toFixed(1)} mm
                                    </span>
                                </div>
                                <Slider
                                    type="single"
                                    bind:value={keyringHoleSize}
                                    min={2}
                                    max={10}
                                    step={0.5}
                                    class="w-full" />
                            </label>
                        </div>
                        <label class="mt-1.5 grid gap-0.5">
                            <div
                                class="flex items-center justify-between gap-1.5">
                                <span
                                    class="text-[11px] font-medium text-slate-700"
                                    >Ring thickness</span>
                                <span
                                    class="text-[11px] tabular-nums text-slate-600">
                                    {keyringDepth.toFixed(1)} mm
                                </span>
                            </div>
                            <Slider
                                type="single"
                                bind:value={keyringDepth}
                                min={0.6}
                                max={Math.max(0.6, baseDepth)}
                                step={0.1}
                                class="w-full" />
                        </label>
                    </div>
                </div>
            </div>
        </aside>

        <section
            class="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]">
            <div bind:this={hostEl} class="absolute inset-0"></div>
            <div class="absolute bottom-4 right-4 flex items-center gap-2">
                <DesignerExportToolbar
                    onSnapshot={() => {
                        if (renderer && scene && camera)
                            downloadSnapshot(
                                renderer,
                                scene,
                                camera,
                                "bow-keychain",
                            );
                    }}
                    onExport={() => (user && subscriptionStatus?.isActive ? exportSTL() : onShowPricing?.())}
                    onExport3MF={() => (user && subscriptionStatus?.isActive ? export3MF() : onShowPricing?.())}
                    exportDisabled={false}
                    exportTitle={!user
                        ? "Sign in to export"
                        : !subscriptionStatus?.isActive
                            ? "Subscribe to export"
                            : "Export STL or 3MF"}
                    {exportLoading}
                    showLockIcon={!user || !subscriptionStatus?.isActive} />
                {#if exportError}
                    <p
                        class="max-w-[200px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg">
                        {exportError}
                    </p>
                {/if}
            </div>
        </section>
    </div>
</main>
