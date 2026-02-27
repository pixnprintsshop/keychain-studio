<script lang="ts">
    import type { Session, User } from "@supabase/supabase-js";
    import ClipperLib from "clipper-lib";
    import { onDestroy, onMount } from "svelte";
    import * as THREE from "three";
    import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
    import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
    import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
    import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
    import type { LicenseStatus } from "../lib/licensing";
    import { checkLicenseStatus } from "../lib/licensing";
    import {
        centerGeometryXY,
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        frameCameraToObject,
    } from "../lib/utils";
    import type LicenseModal from "./LicenseModal.svelte";

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

    const CUSTOM_SVG_CACHE_STORAGE = "custom-svg-cache";
    const CUSTOM_SVG_CURRENT_STORAGE = "custom-svg-current";
    const MAX_CACHE_ENTRIES = 50;

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
            const raw = localStorage.getItem(CUSTOM_SVG_CACHE_STORAGE);
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
            localStorage.setItem(CUSTOM_SVG_CACHE_STORAGE, JSON.stringify(cache));
        } catch (_) {}
    }

    type CustomSvg =
        | { type: "url"; url: string; optimizedSvg: string }
        | { type: "upload"; name: string; content: string; optimizedSvg: string };

    function getCurrentCustomSvg(): CustomSvg | null {
        try {
            const raw = localStorage.getItem(CUSTOM_SVG_CURRENT_STORAGE);
            if (raw) return JSON.parse(raw) as CustomSvg;
        } catch (_) {}
        return null;
    }

    function setCurrentCustomSvg(current: CustomSvg) {
        try {
            localStorage.setItem(
                CUSTOM_SVG_CURRENT_STORAGE,
                JSON.stringify(current),
            );
        } catch (_) {}
    }

    function loadPersistedSvg(): boolean {
        const current = getCurrentCustomSvg();
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
    let controls: any = null;
    let group: THREE.Group | null = null;
    let keyLight: THREE.DirectionalLight | null = null;
    let rafId = 0;
    let ro: ResizeObserver | null = null;
    let didInitFrame = false;

    let uploadName = $state("");
    let svgUrl = $state("");
    let sourceSvg = $state("");
    let optimizedSvg = $state("");
    let processError = $state<string | null>(null);
    let processing = $state(false);
    let exportError = $state<string | null>(null);
    const SCALE_OFFSET = 0.05;
    const CLIPPER_SCALE = 1000;
    const TOP_BASE_EMBED = 0.2;
    const DETAIL_AREA_RATIO = 0.08;
    const DETAIL_TOP_EMBED = 0.04;
    let uiScale = $state(1);
    let thickness = $state(2);
    let baseThickness = $state(3);
    let baseOffsetMm = $state(4);
    let keyringEnabled = $state(true);
    let keyringOuterMm = $state(8);
    let keyringHoleMm = $state(4);
    let keyringOffsetXmm = $state(0);
    let keyringOffsetYmm = $state(0);
    let mainColor = $state("#f06f05");
    let baseColor = $state("#616161");

    function resize() {
        if (!renderer || !camera || !hostEl) return;
        const rect = hostEl.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
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
                setCurrentCustomSvg({
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
            const resp = await fetch(PROCESS_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "image/svg+xml",
                },
                body: rawSvg,
            });
            if (!resp.ok) {
                const text = await resp.text();
                throw new Error(text || `Processor failed (${resp.status})`);
            }
            const processed = await resp.text();
            if (!processed.trim())
                throw new Error("Processor returned empty SVG");
            optimizedSvg = processed;
            setOptimizedCache(cacheKey, processed);
            if (uploadFileName !== undefined) {
                setCurrentCustomSvg({
                    type: "upload",
                    name: uploadFileName,
                    content: rawSvg,
                    optimizedSvg: processed,
                });
            }
        } catch (e) {
            processError =
                e instanceof Error ? e.message : "Failed to process SVG";
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
            setCurrentCustomSvg({ type: "url", url: input, optimizedSvg: cached });
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
            if (!processed.trim())
                throw new Error("Processor returned empty SVG");
            optimizedSvg = processed;
            uploadName = input;
            setOptimizedCache(cacheKey, processed);
            setCurrentCustomSvg({ type: "url", url: input, optimizedSvg: processed });
        } catch (e) {
            processError =
                e instanceof Error ? e.message : "Failed to process URL";
        } finally {
            processing = false;
        }
    }

    function rebuildMeshes() {
        if (!group) return;
        disposeObject3D(group);
        group.clear();
        if (!optimizedSvg.trim()) return;

        const loader = new SVGLoader();
        const parsed = loader.parse(optimizedSvg);
        const shapes: THREE.Shape[] = [];
        for (const p of parsed.paths) {
            const pShapes = SVGLoader.createShapes(p);
            for (const s of pShapes) shapes.push(s);
        }
        if (shapes.length === 0) {
            processError = "No extrudable shape found in processed SVG";
            return;
        }
        const divisions = 20;
        const shapeToPaths = (shape: THREE.Shape) => {
            const toPath = (pts: THREE.Vector2[]) => {
                const out: { X: number; Y: number }[] = [];
                for (const p of pts) {
                    out.push({
                        X: Math.round(p.x * CLIPPER_SCALE),
                        // SVG coordinates are Y-down; flip to Y-up for 3D layout/export.
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
        if (inputPaths.length === 0) {
            processError = "Processed SVG contains invalid paths";
            return;
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

        const effectiveScale = Math.max(0.02, uiScale * SCALE_OFFSET);
        const offsetSvgUnits = baseOffsetMm / effectiveScale;
        const baseTree = new ClipperLib.PolyTree();
        if (offsetSvgUnits > 0) {
            const co = new ClipperLib.ClipperOffset(2, 2);
            co.AddPaths(
                inputPaths,
                ClipperLib.JoinType.jtRound,
                ClipperLib.EndType.etClosedPolygon,
            );
            const offsetPaths: { X: number; Y: number }[][] = [];
            co.Execute(offsetPaths, offsetSvgUnits * CLIPPER_SCALE);
            const c2 = new ClipperLib.Clipper();
            c2.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
            c2.Execute(
                ClipperLib.ClipType.ctUnion,
                baseTree,
                ClipperLib.PolyFillType.pftNonZero,
                ClipperLib.PolyFillType.pftNonZero,
            );
        } else {
            const c2 = new ClipperLib.Clipper();
            c2.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
            c2.Execute(
                ClipperLib.ClipType.ctUnion,
                baseTree,
                ClipperLib.PolyFillType.pftNonZero,
                ClipperLib.PolyFillType.pftNonZero,
            );
        }

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
                    X: Math.round((cx + r * Math.cos(t)) * CLIPPER_SCALE),
                    Y: Math.round((cy + r * Math.sin(t)) * CLIPPER_SCALE),
                });
            }
            if (path.length < 3) return null;
            const isCW = ClipperLib.Clipper.Orientation(path);
            if (isCW !== clockwise) path.reverse();
            return path;
        };
        let finalBaseTree: any = baseTree;
        if (keyringEnabled) {
            const bbox = getTreeBbox(baseTree);
            if (Number.isFinite(bbox.minX) && Number.isFinite(bbox.maxX)) {
                const centerX = (bbox.minX + bbox.maxX) / 2 / CLIPPER_SCALE;
                const topY = bbox.maxY / CLIPPER_SCALE;
                const kx = centerX + keyringOffsetXmm / effectiveScale;
                const ky = topY + keyringOffsetYmm / effectiveScale;
                const outerR = Math.max(
                    0.5,
                    keyringOuterMm / effectiveScale / 2,
                );
                const innerR = Math.min(
                    Math.max(0.2, keyringHoleMm / effectiveScale / 2),
                    outerR - 0.2,
                );
                const outerCircle = circleToPath(kx, ky, outerR, true);
                const innerCircle = circleToPath(kx, ky, innerR, false);
                if (outerCircle && innerCircle) {
                    const basePaths: any[] = [];
                    const roots =
                        baseTree.Childs?.() ?? baseTree.m_Childs ?? [];
                    roots.forEach((n: any) => collectOuterPaths(n, basePaths));
                    const unionTree = new ClipperLib.PolyTree();
                    const unionC = new ClipperLib.Clipper();
                    basePaths.forEach((p) =>
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
                    const diffPaths: any[] = [];
                    const unionRoots =
                        unionTree.Childs?.() ?? unionTree.m_Childs ?? [];
                    unionRoots.forEach((n: any) =>
                        collectOuterPaths(n, diffPaths),
                    );
                    const diffTree = new ClipperLib.PolyTree();
                    const diffC = new ClipperLib.Clipper();
                    diffPaths.forEach((p) =>
                        diffC.AddPath(p, ClipperLib.PolyType.ptSubject, true),
                    );
                    diffC.AddPath(
                        innerCircle,
                        ClipperLib.PolyType.ptClip,
                        true,
                    );
                    diffC.Execute(
                        ClipperLib.ClipType.ctDifference,
                        diffTree,
                        ClipperLib.PolyFillType.pftNonZero,
                        ClipperLib.PolyFillType.pftNonZero,
                    );
                    finalBaseTree = diffTree;
                }
            }
        }

        const polyTreeToThreeShapes = (tree: any) => {
            const out: THREE.Shape[] = [];
            const toVec2 = (pt: { X: number; Y: number }) =>
                new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE);
            const buildFromOuter = (outerNode: any): THREE.Shape | null => {
                const contour =
                    outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
                if (!contour || contour.length < 3) return null;
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

        const topShapes = polyTreeToThreeShapes(filledTree);
        const baseShapes = polyTreeToThreeShapes(finalBaseTree);
        const topBbox = getTreeBbox(filledTree);
        const baseBbox2d = getTreeBbox(finalBaseTree);
        if (topShapes.length === 0 || baseShapes.length === 0) {
            processError = "Failed to build valid base/top shapes";
            return;
        }
        const shapeSignedArea = (pts: THREE.Vector2[]) => {
            if (pts.length < 3) return 0;
            return Math.abs(THREE.ShapeUtils.area(pts));
        };
        const shapeArea = (s: THREE.Shape) => {
            const outer = shapeSignedArea(s.getPoints(48));
            const holes = (s.holes || []).reduce(
                (sum, h) => sum + shapeSignedArea(h.getPoints(48)),
                0,
            );
            return Math.max(0, outer - holes);
        };
        const getShapesBboxYUp = (shapeList: THREE.Shape[]) => {
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            for (const s of shapeList) {
                const pts = s.getPoints(64);
                for (const p of pts) {
                    minX = Math.min(minX, p.x);
                    maxX = Math.max(maxX, p.x);
                    // Raw SVG shapes are Y-down, convert to Y-up reference.
                    const yy = -p.y;
                    minY = Math.min(minY, yy);
                    maxY = Math.max(maxY, yy);
                }
            }
            return { minX, maxX, minY, maxY };
        };
        const modelArea =
            Number.isFinite(topBbox.minX) && Number.isFinite(topBbox.maxX)
                ? ((topBbox.maxX - topBbox.minX) / CLIPPER_SCALE) *
                  ((topBbox.maxY - topBbox.minY) / CLIPPER_SCALE)
                : 0;
        const detailShapes = shapes.filter(
            (s) =>
                modelArea > 0 && shapeArea(s) <= modelArea * DETAIL_AREA_RATIO,
        );
        const topCenterX = (topBbox.minX + topBbox.maxX) / 2 / CLIPPER_SCALE;
        const topCenterY = (topBbox.minY + topBbox.maxY) / 2 / CLIPPER_SCALE;

        const baseDepth = Math.max(0.2, baseThickness);
        const topDepth = Math.max(0.2, thickness);
        const baseGeo = new THREE.ExtrudeGeometry(baseShapes, {
            depth: baseDepth,
            bevelEnabled: false,
            curveSegments: 12,
            steps: 1,
        });
        const topGeo = new THREE.ExtrudeGeometry(topShapes, {
            depth: topDepth,
            bevelEnabled: false,
            curveSegments: 12,
            steps: 1,
        });
        centerGeometryXY(baseGeo);
        centerGeometryXY(topGeo);
        if (
            Number.isFinite(topBbox.minX) &&
            Number.isFinite(topBbox.maxX) &&
            Number.isFinite(baseBbox2d.minX) &&
            Number.isFinite(baseBbox2d.maxX)
        ) {
            const baseCenterX =
                (baseBbox2d.minX + baseBbox2d.maxX) / 2 / CLIPPER_SCALE;
            const baseCenterY =
                (baseBbox2d.minY + baseBbox2d.maxY) / 2 / CLIPPER_SCALE;
            // Keep main SVG centered while letting keyring extend from base.
            baseGeo.translate(
                baseCenterX - topCenterX,
                baseCenterY - topCenterY,
                0,
            );
        }
        baseGeo.computeBoundingBox();
        topGeo.computeBoundingBox();
        const baseBb = baseGeo.boundingBox!;
        const topBb = topGeo.boundingBox!;
        baseGeo.translate(0, 0, -baseBb.min.z);
        topGeo.translate(0, 0, -topBb.min.z);

        const baseMat = new THREE.MeshStandardMaterial({
            color: baseColor,
            roughness: 0.85,
            metalness: 0.05,
        });
        const topMat = new THREE.MeshStandardMaterial({
            color: mainColor,
            roughness: 0.35,
            metalness: 0.1,
        });
        const baseMesh = new THREE.Mesh(baseGeo, baseMat);
        const topMesh = new THREE.Mesh(topGeo, topMat);
        baseMesh.castShadow = true;
        baseMesh.receiveShadow = true;
        topMesh.castShadow = true;
        topMesh.receiveShadow = true;
        topMesh.position.z = baseDepth - TOP_BASE_EMBED;

        baseMesh.scale.set(effectiveScale, effectiveScale, 1);
        topMesh.scale.set(effectiveScale, effectiveScale, 1);
        group.add(baseMesh);
        group.add(topMesh);
        if (detailShapes.length > 0) {
            // Match top layer depth so preserved micro-features don't look like thin walls.
            const detailDepth = topDepth;
            const detailGeo = new THREE.ExtrudeGeometry(detailShapes, {
                depth: detailDepth,
                bevelEnabled: false,
                curveSegments: 20,
                steps: 1,
            });
            // Raw SVG shapes are Y-down; flip to match Y-up Clipper pipeline.
            detailGeo.scale(1, -1, 1);
            // Negative scaling flips triangle winding; fix winding so caps render solid.
            if (!detailGeo.index) {
                const count = detailGeo.attributes.position.count;
                const index = new THREE.BufferAttribute(
                    new Uint32Array(count),
                    1,
                );
                for (let i = 0; i < count; i++) index.array[i] = i;
                detailGeo.setIndex(index);
            }
            if (detailGeo.index) {
                const idx = detailGeo.index.array as Uint16Array | Uint32Array;
                for (let i = 0; i < idx.length; i += 3) {
                    const tmp = idx[i + 1];
                    idx[i + 1] = idx[i + 2];
                    idx[i + 2] = tmp;
                }
                detailGeo.index.needsUpdate = true;
            }
            detailGeo.computeVertexNormals();
            centerGeometryXY(detailGeo);
            const detailBbox = getShapesBboxYUp(detailShapes);
            if (
                Number.isFinite(detailBbox.minX) &&
                Number.isFinite(detailBbox.maxX) &&
                Number.isFinite(topCenterX) &&
                Number.isFinite(topCenterY)
            ) {
                const detailCenterX = (detailBbox.minX + detailBbox.maxX) / 2;
                const detailCenterY = (detailBbox.minY + detailBbox.maxY) / 2;
                // Align detail islands (eyes) to the same centered frame as topGeo.
                detailGeo.translate(
                    detailCenterX - topCenterX,
                    detailCenterY - topCenterY,
                    0,
                );
            }
            detailGeo.computeBoundingBox();
            const detailBb = detailGeo.boundingBox!;
            detailGeo.translate(0, 0, -detailBb.min.z);
            const detailMesh = new THREE.Mesh(detailGeo, topMat);
            // Keep this layer visually fused with the main top surface.
            detailMesh.castShadow = false;
            detailMesh.receiveShadow = false;
            detailMesh.position.z =
                baseDepth - TOP_BASE_EMBED - DETAIL_TOP_EMBED;
            detailMesh.scale.set(effectiveScale, effectiveScale, 1);
            group.add(detailMesh);
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
        if (!group) return;
        if (!user) {
            onRequestLogin();
            return;
        }
        const status = await checkLicenseStatus(user);
        if (!status.canExport || !status.isPaid) {
            licenseModalRef?.open();
            return;
        }
        exportError = null;
        if (group.children.length === 0) {
            exportError = "Nothing to export yet";
            return;
        }
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
        if (geometries.length === 0) return;
        const merged =
            geometries.length === 1
                ? geometries[0]
                : BufferGeometryUtils.mergeGeometries(geometries);
        if (!merged) {
            geometries.forEach((g) => g.dispose());
            exportError = "Failed to merge geometry for export";
            return;
        }
        if (geometries.length > 1) geometries.forEach((g) => g.dispose());
        const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
        if (welded !== merged) merged.dispose();

        const exporter = new STLExporter();
        const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
        welded.dispose();
        const buffer = result instanceof DataView ? result.buffer : result;
        if (!buffer || buffer.byteLength < 84) {
            exportError = "Export produced empty geometry";
            return;
        }
        const slug = (uploadName || "custom-svg")
            .toLowerCase()
            .replace(/\.svg$/i, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "");
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(
            `${slug || "custom-svg"}-${ts}.stl`,
            new Blob([buffer], { type: "model/stl" }),
        );
        if (status.type === "trial") onShowThankYou();
    }

    $effect(() => {
        void optimizedSvg;
        void uiScale;
        void thickness;
        void baseThickness;
        void baseOffsetMm;
        void keyringEnabled;
        void keyringOuterMm;
        void keyringHoleMm;
        void keyringOffsetXmm;
        void keyringOffsetYmm;
        void mainColor;
        void baseColor;
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
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        hostEl.appendChild(renderer.domElement);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enablePan = true;
        controls.minDistance = 10;
        controls.maxDistance = 1000;

        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        keyLight = new THREE.DirectionalLight(0xffffff, 0.95);
        keyLight.position.set(60, -80, 140);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.width = 2048;
        keyLight.shadow.mapSize.height = 2048;
        scene.add(keyLight);
        scene.add(keyLight.target);

        group = new THREE.Group();
        scene.add(group);

        const grid = new THREE.GridHelper(240, 24, 0xd1d5db, 0xe5e7eb);
        grid.rotateX(Math.PI / 2);
        grid.position.z = -0.01;
        scene.add(grid);

        ro = new ResizeObserver(() => resize());
        ro.observe(hostEl);
        resize();

        const tick = () => {
            rafId = requestAnimationFrame(tick);
            controls?.update();
            renderer?.render(scene!, camera!);
        };
        tick();
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
        controls = null;
        group = null;
        keyLight = null;
    });
</script>

<main class="h-dvh w-dvw bg-slate-100 p-4">
    <div class="flex h-full min-h-0 gap-4">
        <aside
            class="w-full max-w-[360px] min-w-[320px] rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
        >
            <div class="mb-4 flex items-center justify-between">
                <h1 class="text-lg font-semibold tracking-tight text-slate-900">
                    Custom SVG
                </h1>
                <button
                    type="button"
                    class="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    onclick={onBack}
                >
                    Back
                </button>
            </div>

            <div
                class="space-y-4 overflow-y-auto pr-1 max-h-[calc(100dvh-7rem)]"
            >
                <div>
                    <label
                        for="custom-svg-url-input"
                        class="mb-1 block text-xs font-medium text-slate-700"
                    >
                        SVG URL
                    </label>
                    <div class="flex items-center gap-2">
                        <input
                            id="custom- svg-url-input"
                            type="url"
                            placeholder="https://api.iconify.design/proicons:accessibility.svg"
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

                <div class="h-px bg-slate-200"></div>

                <div>
                    <label
                        for="custom-svg-upload-input"
                        class="mb-1 block text-xs font-medium text-slate-700"
                    >
                        Upload SVG
                    </label>
                    <input
                        id="custom-svg-upload-input"
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

                <div>
                    <div class="mb-1 flex items-center justify-between">
                        <label
                            for="custom-svg-scale"
                            class="text-xs font-medium text-slate-700"
                            >Scale</label
                        >
                        <span class="text-xs text-slate-500"
                            >{uiScale.toFixed(2)}x</span
                        >
                    </div>
                    <input
                        id="custom-svg-scale"
                        type="range"
                        min="0.2"
                        max="10"
                        step="0.01"
                        bind:value={uiScale}
                        class="w-full"
                        disabled={!optimizedSvg || processing}
                    />
                </div>

                <div>
                    <div class="mb-1 flex items-center justify-between">
                        <label
                            for="custom-svg-thickness"
                            class="text-xs font-medium text-slate-700"
                            >Main thickness</label
                        >
                        <span class="text-xs text-slate-500"
                            >{thickness.toFixed(1)} mm</span
                        >
                    </div>
                    <input
                        id="custom-svg-thickness"
                        type="range"
                        min="0.5"
                        max="20"
                        step="0.1"
                        bind:value={thickness}
                        class="w-full"
                        disabled={!optimizedSvg || processing}
                    />
                </div>

                <div>
                    <div class="mb-1 flex items-center justify-between">
                        <label
                            for="custom-svg-base-thickness"
                            class="text-xs font-medium text-slate-700"
                            >Base thickness</label
                        >
                        <span class="text-xs text-slate-500"
                            >{baseThickness.toFixed(1)} mm</span
                        >
                    </div>
                    <input
                        id="custom-svg-base-thickness"
                        type="range"
                        min="0.5"
                        max="20"
                        step="0.1"
                        bind:value={baseThickness}
                        class="w-full"
                        disabled={!optimizedSvg || processing}
                    />
                </div>

                <div>
                    <div class="mb-1 flex items-center justify-between">
                        <label
                            for="custom-svg-base-offset"
                            class="text-xs font-medium text-slate-700"
                            >Base expand</label
                        >
                        <span class="text-xs text-slate-500"
                            >{baseOffsetMm.toFixed(2)} mm</span
                        >
                    </div>
                    <input
                        id="custom-svg-base-offset"
                        type="range"
                        min="0"
                        max="10"
                        step="0.1"
                        bind:value={baseOffsetMm}
                        class="w-full"
                        disabled={!optimizedSvg || processing}
                    />
                </div>

                <div
                    class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3"
                >
                    <div class="flex items-center justify-between">
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700"
                        >
                            Keyring
                        </div>
                        <label
                            class="flex items-center gap-2 text-xs text-slate-600"
                        >
                            <input
                                type="checkbox"
                                bind:checked={keyringEnabled}
                                class="h-4 w-4 accent-indigo-500"
                            />
                            Enabled
                        </label>
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Outer</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{keyringOuterMm.toFixed(1)} mm</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="2"
                                max="20"
                                step="0.1"
                                bind:value={keyringOuterMm}
                                disabled={!optimizedSvg ||
                                    processing ||
                                    !keyringEnabled}
                            />
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Hole</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{keyringHoleMm.toFixed(1)} mm</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="1"
                                max={Math.max(1.5, keyringOuterMm - 1)}
                                step="0.1"
                                bind:value={keyringHoleMm}
                                disabled={!optimizedSvg ||
                                    processing ||
                                    !keyringEnabled}
                            />
                        </label>
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Pos X</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{keyringOffsetXmm.toFixed(1)} mm</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="-30"
                                max="30"
                                step="0.1"
                                bind:value={keyringOffsetXmm}
                                disabled={!optimizedSvg ||
                                    processing ||
                                    !keyringEnabled}
                            />
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Pos Y</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{keyringOffsetYmm.toFixed(1)} mm</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="-30"
                                max="30"
                                step="0.1"
                                bind:value={keyringOffsetYmm}
                                disabled={!optimizedSvg ||
                                    processing ||
                                    !keyringEnabled}
                            />
                        </label>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-3">
                    <label class="grid gap-1.5" for="custom-svg-main-color-text">
                        <span class="text-xs font-medium text-slate-700"
                            >Main color</span
                        >
                        <div class="flex items-center gap-2">
                            <input
                                id="custom-svg-main-color"
                                class="h-10 w-10 rounded-xl"
                                type="color"
                                bind:value={mainColor}
                                disabled={!optimizedSvg || processing}
                            />
                            <input
                                id="svg-main-color-text"
                                class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                type="text"
                                bind:value={mainColor}
                                disabled={!optimizedSvg || processing}
                            />
                        </div>
                    </label>
                    <label class="grid gap-1.5" for="svg-base-color-text">
                        <span class="text-xs font-medium text-slate-700"
                            >Base color</span
                        >
                        <div class="flex items-center gap-2">
                            <input
                                id="svg-base-color"
                                class="h-10 w-10 rounded-xl"
                                type="color"
                                bind:value={baseColor}
                                disabled={!optimizedSvg || processing}
                            />
                            <input
                                id="svg-base-color-text"
                                class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                type="text"
                                bind:value={baseColor}
                                disabled={!optimizedSvg || processing}
                            />
                        </div>
                    </label>
                </div>

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
                            "svg-designer",
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
                    onclick={exportStl}
                    aria-label="Download STL"
                    disabled={!optimizedSvg ||
                        processing ||
                        !user ||
                        licenseStatus?.canExport === false ||
                        licenseStatus?.isPaid === false}
                    title={!user
                        ? "Sign in to export"
                        : licenseStatus?.canExport === false
                          ? "License required to export"
                          : licenseStatus?.isPaid === false
                            ? "Paid license required to export"
                            : "Export STL"}
                >
                    {#if !user || licenseStatus?.canExport === false || licenseStatus?.isPaid === false}
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

    {#if processing}
        <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-svg-processing-loading-title"
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
                            id="custom-svg-processing-loading-title"
                            class="text-lg font-semibold text-slate-900"
                        >
                            Processing SVG
                        </h2>
                        <p class="text-sm text-slate-600">
                            Preparing your design for the 3D preview…
                        </p>
                    </div>
                </div>
            </div>
        </div>
    {/if}
</main>
