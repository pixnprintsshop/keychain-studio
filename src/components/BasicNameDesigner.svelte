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
        createRoundedRectShape,
        centerGeometryXY,
        disposeObject3D,
        downloadBlob,
        downloadSnapshot,
        frameCameraToObject,
        getFont,
        FONT_OPTIONS,
        DEFAULT_TEXT,
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

    // ── Storage ──────────────────────────────────────────────────────────────
    const STORAGE_KEY = "keychain-basicname-settings";

    /** Z amount text is sunk into the base so they overlap (avoids non-manifold at contact). */
    const TEXT_BASE_EMBED = 0.2;
    /** Small embed for border so it isn't exactly coplanar with base (which can make it disappear in export). */
    const BORDER_BASE_EMBED = 0.05;

    type KeyringPosition =
        | "topCenter"
        | "topLeft"
        | "topRight"
        | "leftCenter"
        | "rightCenter";

    interface Settings {
        baseWidth: number;
        baseHeight: number;
        cornerRadius: number;
        baseDepth: number;
        topBorderDepth: number;
        keyringPosition: KeyringPosition;
        baseColor: string;
        accentColor: string; // border and text (same color)
        textContent: string;
        textFontKey: string;
        textSize: number;
        textDepth: number;
    }

    const KEYRING_POSITIONS: { value: KeyringPosition; label: string }[] = [
        { value: "topCenter", label: "Top center" },
        { value: "topLeft", label: "Top left" },
        { value: "topRight", label: "Top right" },
        { value: "leftCenter", label: "Left center" },
        { value: "rightCenter", label: "Right center" },
    ];

    const defaults: Settings = {
        baseWidth: 50,
        baseHeight: 25,
        cornerRadius: 7,
        baseDepth: 2,
        topBorderDepth: 1,
        keyringPosition: "topCenter",
        baseColor: "#000000",
        accentColor: "#24b6ff",
        textContent: DEFAULT_TEXT,
        textFontKey: FONT_OPTIONS[0]?.key ?? "Titan One_Regular",
        textSize: 8,
        textDepth: 0.8,
    };

    function loadSettings(): Settings {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed && typeof parsed === "object") {
                    const merged = { ...defaults, ...parsed };
                    // Migrate old borderColor/textColor to single accentColor
                    merged.accentColor =
                        parsed.accentColor ??
                        parsed.borderColor ??
                        parsed.textColor ??
                        defaults.accentColor;
                    return merged;
                }
            }
        } catch {}
        return { ...defaults };
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
    let textContent = $state(initial.textContent);
    let textFontKey = $state(initial.textFontKey);
    let textSize = $state(initial.textSize);
    let textDepth = $state(initial.textDepth);

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
                    baseWidth,
                    baseHeight,
                    cornerRadius,
                    baseDepth,
                    topBorderDepth,
                    keyringPosition,
                    baseColor,
                    accentColor,
                    textContent,
                    textFontKey,
                    textSize,
                    textDepth,
                }),
            );
        } catch {}
    }

    function rebuildMeshes() {
        if (!scene || !group) return;
        disposeObject3D(group);
        group.clear();
        group.position.set(0, 0, 0);

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

        if (topMergedShape) {
            const topGeo = new THREE.ExtrudeGeometry([topMergedShape], {
                depth: Math.max(0.1, topBorderDepth),
                bevelEnabled: false,
            });
            topGeo.computeBoundingBox();
            const topBb = topGeo.boundingBox!;
            topGeo.translate(0, 0, -topBb.min.z);
            const borderMat = new THREE.MeshStandardMaterial({
                color: accentColor,
                roughness: 0.85,
                metalness: 0.05,
            });
            const topMesh = new THREE.Mesh(topGeo, borderMat);
            topMesh.castShadow = true;
            topMesh.receiveShadow = true;
            // Slight embed so border isn't coplanar with base (flush made it disappear in export)
            topMesh.position.z = baseDepth - BORDER_BASE_EMBED;
            group.add(topMesh);
        }

        // ── Text sitting on base surface ─────────────────────────────────────
        const textToRender = (textContent ?? "").trim();
        if (textToRender) {
            const font = getFont(textFontKey);
            if (font) {
                const shapes = font.generateShapes(textToRender, textSize);
                if (shapes.length > 0) {
                    const textGeo = new THREE.ExtrudeGeometry(shapes, {
                        depth: Math.max(0.01, textDepth),
                        bevelEnabled: false,
                    });
                    centerGeometryXY(textGeo);

                    const textMat = new THREE.MeshStandardMaterial({
                        color: accentColor,
                        roughness: 0.35,
                        metalness: 0.1,
                    });

                    const textMesh = new THREE.Mesh(textGeo, textMat);
                    textMesh.castShadow = true;
                    textMesh.receiveShadow = true;
                    // Embed text into base so they overlap (avoids non-manifold at contact)
                    textMesh.position.z = baseDepth - TEXT_BASE_EMBED;
                    group.add(textMesh);
                }
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
    }

    async function exportSTL() {
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
        exportLoading = true;
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
            if (status.type === "trial") onShowThankYou();
        } catch (e) {
            exportError = e instanceof Error ? e.message : "Export failed";
        } finally {
            exportLoading = false;
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
        const grid = new THREE.GridHelper(300, 20, 0xcbd5e1, 0xe2e8f0);
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
        void textContent;
        void textFontKey;
        void textSize;
        void textDepth;
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
        void textContent;
        void textFontKey;
        void textSize;
        void textDepth;
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
                    Basic Name Tag
                </h2>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
                <div
                    class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3 mb-2"
                >
                    <div
                        class="text-xs font-semibold tracking-tight text-slate-700"
                    >
                        Text
                    </div>
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Content</span
                        >
                        <input
                            class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            type="text"
                            bind:value={textContent}
                            placeholder="Name"
                        />
                    </label>
                    <label class="grid gap-1.5">
                        <span class="text-xs font-medium text-slate-700"
                            >Border & text color</span
                        >
                        <div class="flex items-center gap-2">
                            <input
                                class="h-10 w-10 rounded-xl"
                                type="color"
                                bind:value={accentColor}
                            />
                            <input
                                class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                type="text"
                                bind:value={accentColor}
                            />
                        </div>
                    </label>
                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-medium text-slate-700"
                                >Text depth</span
                            >
                            <span class="text-xs tabular-nums text-slate-600"
                                >{textDepth}</span
                            >
                        </div>
                        <input
                            class="w-full accent-indigo-500"
                            type="range"
                            min="0.2"
                            max="3"
                            step="0.1"
                            bind:value={textDepth}
                        />
                    </label>
                </div>
                <div class="grid grid-cols-1 gap-4">
                    <div
                        class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3"
                    >
                        <div
                            class="text-xs font-semibold tracking-tight text-slate-700"
                        >
                            Shape
                        </div>
                        <label class="grid gap-1.5">
                            <span class="text-xs font-medium text-slate-700"
                                >Color</span
                            >
                            <div class="flex items-center gap-2">
                                <input
                                    class="h-10 w-10 rounded-xl"
                                    type="color"
                                    bind:value={baseColor}
                                />
                                <input
                                    class="min-w-0 w-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                                    type="text"
                                    bind:value={baseColor}
                                />
                            </div>
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Width</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{baseWidth}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="20"
                                max="80"
                                step="1"
                                bind:value={baseWidth}
                            />
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Height</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{baseHeight}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="12"
                                max="50"
                                step="1"
                                bind:value={baseHeight}
                            />
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Corner radius</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{cornerRadius}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="0"
                                max={Math.min(baseWidth, baseHeight) / 2}
                                step="0.2"
                                bind:value={cornerRadius}
                            />
                        </label>
                        <label class="grid gap-1.5">
                            <div
                                class="flex items-center justify-between gap-2"
                            >
                                <span class="text-xs font-medium text-slate-700"
                                    >Depth</span
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
                                <span class="text-xs font-medium text-slate-700"
                                    >Top border depth</span
                                >
                                <span
                                    class="text-xs tabular-nums text-slate-600"
                                    >{topBorderDepth}</span
                                >
                            </div>
                            <input
                                class="w-full accent-indigo-500"
                                type="range"
                                min="0.2"
                                max="3"
                                step="0.2"
                                bind:value={topBorderDepth}
                            />
                        </label>
                        <div class="grid gap-1.5">
                            <span class="text-xs font-medium text-slate-700"
                                >Keyring position</span
                            >
                            <div
                                class="grid w-full grid-cols-3 gap-1"
                                role="group"
                                aria-label="Keyring position"
                            >
                                <button
                                    type="button"
                                    class="flex h-10 w-full items-center justify-center rounded-xl border text-lg transition focus:outline-none focus:ring-2 focus:ring-indigo-500/30 {keyringPosition ===
                                    'topLeft'
                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'}"
                                    onclick={() =>
                                        (keyringPosition = "topLeft")}
                                    title="Top left"
                                    aria-pressed={keyringPosition === "topLeft"}
                                >
                                    ↖
                                </button>
                                <button
                                    type="button"
                                    class="flex h-10 w-full items-center justify-center rounded-xl border text-lg transition focus:outline-none focus:ring-2 focus:ring-indigo-500/30 {keyringPosition ===
                                    'topCenter'
                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'}"
                                    onclick={() =>
                                        (keyringPosition = "topCenter")}
                                    title="Top center"
                                    aria-pressed={keyringPosition ===
                                        "topCenter"}
                                >
                                    ↑
                                </button>
                                <button
                                    type="button"
                                    class="flex h-10 w-full items-center justify-center rounded-xl border text-lg transition focus:outline-none focus:ring-2 focus:ring-indigo-500/30 {keyringPosition ===
                                    'topRight'
                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'}"
                                    onclick={() =>
                                        (keyringPosition = "topRight")}
                                    title="Top right"
                                    aria-pressed={keyringPosition ===
                                        "topRight"}
                                >
                                    ↗
                                </button>
                                <button
                                    type="button"
                                    class="flex h-10 w-full items-center justify-center rounded-xl border text-lg transition focus:outline-none focus:ring-2 focus:ring-indigo-500/30 {keyringPosition ===
                                    'leftCenter'
                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'}"
                                    onclick={() =>
                                        (keyringPosition = "leftCenter")}
                                    title="Left center"
                                    aria-pressed={keyringPosition ===
                                        "leftCenter"}
                                >
                                    ←
                                </button>
                                <div class="h-10" aria-hidden="true"></div>
                                <button
                                    type="button"
                                    class="flex h-10 w-full items-center justify-center rounded-xl border text-lg transition focus:outline-none focus:ring-2 focus:ring-indigo-500/30 {keyringPosition ===
                                    'rightCenter'
                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'}"
                                    onclick={() =>
                                        (keyringPosition = "rightCenter")}
                                    title="Right center"
                                    aria-pressed={keyringPosition ===
                                        "rightCenter"}
                                >
                                    →
                                </button>
                            </div>
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
                            "rounded-rect",
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
                    disabled={!user ||
                        licenseStatus?.canExport === false ||
                        exportLoading}
                    title={!user
                        ? "Sign in to export"
                        : licenseStatus?.canExport === false
                          ? "License required to export"
                          : "Export STL (base + border, no text) for 3D print"}
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
                    {:else if exportLoading}
                        Exporting…
                    {:else}
                        Export STL
                    {/if}
                </button>
                {#if exportError}
                    <p
                        class="absolute bottom-14 right-4 max-w-[200px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg"
                    >
                        {exportError}
                    </p>
                {/if}
            </div>
        </section>
    </div>
</main>
