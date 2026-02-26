<script lang="ts">
    import type { Session, User } from "@supabase/supabase-js";
    import ClipperLib from "clipper-lib";
    import { onDestroy, onMount } from "svelte";
    import * as THREE from "three";
    import { Brush, Evaluator, INTERSECTION, SUBTRACTION } from "three-bvh-csg";
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
    let rebuildTimeout: ReturnType<typeof setTimeout> | null = null;
    const REBUILD_DEBOUNCE_MS = 120;

    let uploadName = $state("");
    let svgUrl = $state("");
    let sourceSvg = $state("");
    let optimizedSvg = $state("");
    let processError = $state<string | null>(null);
    let processing = $state(false);
    let exportError = $state<string | null>(null);
    const SCALE_OFFSET = 0.01;
    const CLIPPER_SCALE = 1000;
    const TOP_BASE_EMBED = 0.2;
    const DETAIL_AREA_RATIO = 0.08;
    const DETAIL_TOP_EMBED = 0.04;
    let uiScale = $state(1);
    let thickness = $state(1);
    let baseThickness = $state(9);
    let baseOffsetMm = $state(2.5);
    let holeDiameter = $state(6.5);
    let holeFlatTopOffset = $state(0.3);
    let mainColor = $state("#ffffff");
    let baseColor = $state("#ff9e9e");

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
        await processSvg(raw);
    }

    async function processSvg(rawSvg: string) {
        processing = true;
        processError = null;
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
        processing = true;
        processError = null;
        exportError = null;
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

        const polyTreeToThreeShapes = (tree: any) => {
            const out: THREE.Shape[] = [];
            const toVec2 = (pt: { X: number; Y: number }) =>
                new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE);
            const buildFromOuter = (outerNode: any, includeHoles: boolean): THREE.Shape | null => {
                const contour =
                    outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
                if (!contour || contour.length < 3) return null;
                const outerPts = contour.map(toVec2);
                if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
                const shape = new THREE.Shape(outerPts);
                if (includeHoles) {
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
                }
                return shape;
            };
            const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
            for (const n of roots) {
                const isHole = n.IsHole?.() ?? n.m_IsHole;
                if (isHole) continue;
                const s = buildFromOuter(n, true);
                if (s) out.push(s);
            }
            return out;
        };

        /** Base only: outer contours, no holes — so base is solid (e.g. "O" becomes a filled disc). */
        const polyTreeToThreeShapesSolid = (tree: any) => {
            const out: THREE.Shape[] = [];
            const toVec2 = (pt: { X: number; Y: number }) =>
                new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE);
            const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
            for (const n of roots) {
                const isHole = n.IsHole?.() ?? n.m_IsHole;
                if (isHole) continue;
                const contour = n.Contour?.() ?? n.m_polygon ?? [];
                if (!contour || contour.length < 3) continue;
                const outerPts = contour.map(toVec2);
                if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
                out.push(new THREE.Shape(outerPts));
            }
            return out;
        };

        const topShapes = polyTreeToThreeShapes(filledTree);
        const baseShapes = polyTreeToThreeShapesSolid(baseTree);
        const topBbox = getTreeBbox(filledTree);
        const baseBbox2d = getTreeBbox(baseTree);
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
            Number.isFinite(baseBbox2d.minX) &&
            Number.isFinite(baseBbox2d.maxX) &&
            Number.isFinite(baseBbox2d.minY) &&
            Number.isFinite(baseBbox2d.maxY)
        ) {
            const baseCenterX =
                (baseBbox2d.minX + baseBbox2d.maxX) / 2 / CLIPPER_SCALE;
            const baseCenterY =
                (baseBbox2d.minY + baseBbox2d.maxY) / 2 / CLIPPER_SCALE;
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

        const totalHeight = baseDepth + topDepth - TOP_BASE_EMBED;
        const holeCenterZ = totalHeight / 2;
        const holeRadius = Math.max(0.5, holeDiameter / 2);
        const baseExtentX = baseBb.max.x - baseBb.min.x;
        const holeLength = Math.max(30, baseExtentX * effectiveScale + 20);
        const flatCeilingZ =
            holeCenterZ + holeRadius - Math.max(0.1, holeFlatTopOffset);

        const cylinderGeo = new THREE.CylinderGeometry(
            holeRadius,
            holeRadius,
            holeLength,
            32,
        );
        cylinderGeo.rotateZ(-Math.PI / 2);
        cylinderGeo.translate(0, 0, holeCenterZ);

        const halfSpaceHeight = flatCeilingZ + 100;
        const halfSpaceGeo = new THREE.BoxGeometry(
            holeLength + 20,
            holeDiameter + 20,
            halfSpaceHeight,
        );
        halfSpaceGeo.translate(0, 0, (flatCeilingZ - 100) / 2);

        const dummyMat = new THREE.MeshBasicMaterial({ color: 0x808080 });
        const cylinderBrush = new Brush(cylinderGeo.clone(), dummyMat);
        const halfSpaceBrush = new Brush(halfSpaceGeo.clone(), dummyMat);
        const evaluatorForHole = new Evaluator();
        const flatTopHoleTarget = new Brush(
            new THREE.BufferGeometry(),
            dummyMat,
        );
        evaluatorForHole.evaluate(
            cylinderBrush,
            halfSpaceBrush,
            INTERSECTION,
            flatTopHoleTarget,
        );
        cylinderGeo.dispose();
        halfSpaceGeo.dispose();
        cylinderBrush.geometry.dispose();
        halfSpaceBrush.geometry.dispose();
        dummyMat.dispose();

        const flatTopHoleGeo = flatTopHoleTarget.geometry;
        const holeDummyMat = new THREE.MeshBasicMaterial({ color: 0x808080 });
        const holeBrush = new Brush(flatTopHoleGeo.clone(), holeDummyMat);
        // Keep hole in "mm" space (radius 2.5, length 200) so it matches base z; base x,y are scaled by effectiveScale so base world size matches hole
        holeBrush.scale.set(1, 1, 1);

        const baseBrush = new Brush(baseGeo.clone(), baseMat);
        baseBrush.scale.set(effectiveScale, effectiveScale, 1);
        const topBrush = new Brush(topGeo.clone(), topMat);
        topBrush.scale.set(effectiveScale, effectiveScale, 1);
        topBrush.position.z = baseDepth - TOP_BASE_EMBED;

        baseBrush.updateMatrixWorld(true);
        topBrush.updateMatrixWorld(true);
        holeBrush.updateMatrixWorld(true);

        const evaluator = new Evaluator();
        const resultBaseBrush = new Brush(
            new THREE.BufferGeometry(),
            baseMat,
        );
        const resultTopBrush = new Brush(new THREE.BufferGeometry(), topMat);
        try {
            evaluator.evaluate(baseBrush, holeBrush, SUBTRACTION, resultBaseBrush);
            evaluator.evaluate(topBrush, holeBrush, SUBTRACTION, resultTopBrush);
        } catch (err) {
            console.error("CSG subtract failed:", err);
            processError = "Failed to cut cord hole (try different hole size)";
            baseBrush.geometry.dispose();
            topBrush.geometry.dispose();
            holeBrush.geometry.dispose();
            flatTopHoleGeo.dispose();
            holeDummyMat.dispose();
            return;
        }

        const baseMesh = new THREE.Mesh(resultBaseBrush.geometry, baseMat);
        const topMesh = new THREE.Mesh(resultTopBrush.geometry, topMat);
        baseMesh.castShadow = true;
        baseMesh.receiveShadow = true;
        topMesh.castShadow = true;
        topMesh.receiveShadow = true;
        // CSG result is in hole's local space (= world); top geometry already has correct z, so no position offset
        baseMesh.scale.set(1, 1, 1);
        topMesh.scale.set(1, 1, 1);
        group.add(baseMesh);
        group.add(topMesh);

        if (detailShapes.length > 0) {
            const detailDepth = topDepth;
            const detailGeo = new THREE.ExtrudeGeometry(detailShapes, {
                depth: detailDepth,
                bevelEnabled: false,
                curveSegments: 20,
                steps: 1,
            });
            detailGeo.scale(1, -1, 1);
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
                detailGeo.translate(
                    detailCenterX - topCenterX,
                    detailCenterY - topCenterY,
                    0,
                );
            }
            detailGeo.computeBoundingBox();
            const detailBb = detailGeo.boundingBox!;
            detailGeo.translate(0, 0, -detailBb.min.z);
            detailGeo.scale(effectiveScale, effectiveScale, 1);
            const detailMesh = new THREE.Mesh(detailGeo, topMat);
            detailMesh.castShadow = false;
            detailMesh.receiveShadow = false;
            detailMesh.position.z =
                baseDepth - TOP_BASE_EMBED - DETAIL_TOP_EMBED;
            detailMesh.scale.set(1, 1, 1);
            group.add(detailMesh);
        }

        baseBrush.geometry.dispose();
        topBrush.geometry.dispose();
        holeBrush.geometry.dispose();
        flatTopHoleGeo.dispose();
        holeDummyMat.dispose();

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
        if (!status.canExport) {
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
        const welded = BufferGeometryUtils.mergeVertices(merged, 1e-5);
        if (welded !== merged) merged.dispose();

        const exporter = new STLExporter();
        const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
        welded.dispose();
        const buffer = result instanceof DataView ? result.buffer : result;
        if (!buffer || buffer.byteLength < 84) {
            exportError = "Export produced empty geometry";
            return;
        }
        const slug = (uploadName || "bead")
            .toLowerCase()
            .replace(/\.svg$/i, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "");
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(
            `${slug || "bead"}-${ts}.stl`,
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
        void holeDiameter;
        void holeFlatTopOffset;
        void mainColor;
        void baseColor;
        if (!scene || !group) return;
        if (rebuildTimeout != null) clearTimeout(rebuildTimeout);
        rebuildTimeout = setTimeout(() => {
            rebuildTimeout = null;
            rebuildMeshes();
        }, REBUILD_DEBOUNCE_MS);
        return () => {
            if (rebuildTimeout != null) {
                clearTimeout(rebuildTimeout);
                rebuildTimeout = null;
            }
        };
    });

    onMount(() => {
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
        controls.minDistance = 10;
        controls.maxDistance = 1000;

        scene.add(new THREE.AmbientLight(0xffffff, 0.85));
        keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
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
                    Chunky Bead
                </h1>
                <button
                    type="button"
                    class="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    onclick={onBack}
                >
                    Back
                </button>
            </div>

            <p class="mb-4 text-xs text-slate-500">
                Upload an SVG to create a bead with a cord hole (flat top for easier printing).
            </p>

            <div
                class="space-y-4 overflow-y-auto pr-1 max-h-[calc(100dvh-10rem)]"
            >
                <div>
                    <label
                        for="bead-svg-url-input"
                        class="mb-1 block text-xs font-medium text-slate-700"
                    >
                        SVG URL
                    </label>
                    <div class="flex items-center gap-2">
                        <input
                            id="bead-svg-url-input"
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

                <div class="h-px bg-slate-200"></div>

                <div>
                    <label
                        for="bead-svg-upload-input"
                        class="mb-1 block text-xs font-medium text-slate-700"
                    >
                        Upload SVG
                    </label>
                    <input
                        id="bead-svg-upload-input"
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
                            for="bead-scale"
                            class="text-xs font-medium text-slate-700"
                            >Scale</label
                        >
                        <span class="text-xs text-slate-500"
                            >{uiScale.toFixed(2)}x</span
                        >
                    </div>
                    <input
                        id="bead-scale"
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
                            for="bead-thickness"
                            class="text-xs font-medium text-slate-700"
                            >Top thickness</label
                        >
                        <span class="text-xs text-slate-500"
                            >{thickness.toFixed(1)} mm</span
                        >
                    </div>
                    <input
                        id="bead-thickness"
                        type="range"
                        min="0.5"
                        max="10"
                        step="0.1"
                        bind:value={thickness}
                        class="w-full"
                        disabled={!optimizedSvg || processing}
                    />
                </div>

                <div>
                    <div class="mb-1 flex items-center justify-between">
                        <label
                            for="bead-base-thickness"
                            class="text-xs font-medium text-slate-700"
                            >Base thickness</label
                        >
                        <span class="text-xs text-slate-500"
                            >{baseThickness.toFixed(1)} mm</span
                        >
                    </div>
                    <input
                        id="bead-base-thickness"
                        type="range"
                        min="2"
                        max="25"
                        step="0.5"
                        bind:value={baseThickness}
                        class="w-full"
                        disabled={!optimizedSvg || processing}
                    />
                </div>

                <div>
                    <div class="mb-1 flex items-center justify-between">
                        <label
                            for="bead-base-offset"
                            class="text-xs font-medium text-slate-700"
                            >Base expand</label
                        >
                        <span class="text-xs text-slate-500"
                            >{baseOffsetMm.toFixed(2)} mm</span
                        >
                    </div>
                    <input
                        id="bead-base-offset"
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
                    class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3"
                >
                    <div class="text-xs font-semibold tracking-tight text-slate-700">
                        Cord hole
                    </div>
                    <div>
                        <div class="mb-1 flex items-center justify-between">
                            <label for="bead-hole-diameter" class="text-xs font-medium text-slate-700"
                                >Diameter</label
                            >
                            <span class="text-xs text-slate-500"
                                >{holeDiameter.toFixed(1)} mm</span
                            >
                            </div>
                            <input
                                id="bead-hole-diameter"
                                class="w-full accent-indigo-500"
                                type="range"
                                min="2"
                                max="12"
                                step="0.5"
                                bind:value={holeDiameter}
                                disabled={!optimizedSvg || processing}
                            />
                        </div>
                    <div>
                        <div class="mb-1 flex items-center justify-between">
                            <label for="bead-hole-flat" class="text-xs font-medium text-slate-700"
                                >Flat top offset</label
                            >
                            <span class="text-xs text-slate-500"
                                >{holeFlatTopOffset.toFixed(2)} mm</span
                            >
                        </div>
                        <input
                            id="bead-hole-flat"
                            class="w-full accent-indigo-500"
                            type="range"
                            min="0.1"
                            max="2"
                            step="0.05"
                            bind:value={holeFlatTopOffset}
                            disabled={!optimizedSvg || processing}
                        />
                        <p class="mt-0.5 text-[10px] text-slate-400">
                            Cuts curved cap for a flat ceiling (bridge-friendly).
                        </p>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-3">
                    <label class="grid gap-1.5" for="bead-main-color-text">
                        <span class="text-xs font-medium text-slate-700"
                            >Top color</span
                        >
                        <div class="flex items-center gap-2">
                            <input
                                id="bead-main-color"
                                class="h-10 w-10 rounded-xl"
                                type="color"
                                bind:value={mainColor}
                                disabled={!optimizedSvg || processing}
                            />
                            <input
                                id="bead-main-color-text"
                                class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                type="text"
                                bind:value={mainColor}
                                disabled={!optimizedSvg || processing}
                            />
                        </div>
                    </label>
                    <label class="grid gap-1.5" for="bead-base-color-text">
                        <span class="text-xs font-medium text-slate-700"
                            >Base color</span
                        >
                        <div class="flex items-center gap-2">
                            <input
                                id="bead-base-color"
                                class="h-10 w-10 rounded-xl"
                                type="color"
                                bind:value={baseColor}
                                disabled={!optimizedSvg || processing}
                            />
                            <input
                                id="bead-base-color-text"
                                class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                type="text"
                                bind:value={baseColor}
                                disabled={!optimizedSvg || processing}
                            />
                        </div>
                    </label>
                </div>

                {#if processing}
                    <p class="text-xs text-indigo-600">Processing SVG...</p>
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
                            "bead-designer",
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
                        licenseStatus?.canExport === false}
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
