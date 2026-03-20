<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import ClipperLib from 'clipper-lib';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import { exportTo3MF } from 'three-3mf-exporter';
	import { runOpenScad } from '$lib/openscad';
	import {
		centerGeometryXY,
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		frameCameraToObject,
		getFont,
		stlToBufferGeometry
	} from '$lib/utils-3d';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import type { PaletteColor } from '$lib/colorPalette';
	import FontSelect from './FontSelect.svelte';
	import LoadingModal from './LoadingModal.svelte';
	import type { SubscriptionStatus } from '$lib/subscription';

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

	let hostEl: HTMLDivElement | null = null;
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let controls: any = null;
	let group: THREE.Group | null = null;
	let keyLight: THREE.DirectionalLight | null = null;
	let holeLight: THREE.PointLight | null = null;
	let rafId = 0;
	let ro: ResizeObserver | null = null;
	let didInitFrame = false;

	let textContent = $state('Name');
	let fontKey = $state(
		FONT_OPTIONS.find((f) => f.key === 'Beautiful Harmony_Regular')?.key ??
			FONT_OPTIONS[0]?.key ??
			'Milkyway_Regular'
	);
	let textSize = $state(20);
	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);
	const CLIPPER_SCALE = 1000;
	/** Scene floor grid size (same units as preview); hole length matches so the straw hole spans the grid. */
	const BED_GRID_SIZE = 250;
	/** Min base thickness = hole diameter + this buffer (mm) so the hole fits. */
	const BASE_HOLE_BUFFER = 2;
	/** Design size in mm derived from text size so the slider visibly changes the model size (like font size in points → mm). */
	const sizeMmFromTextSize = (v: number) => Math.max(15, Math.min(100, v));
	let thickness = $state(1);
	let baseThickness = $state(9);
	let baseOffsetMm = $state(2);
	let holeDiameter = $state(6);
	let mainColor = $state('#ffffff');
	let baseColor = $state('#ff9e9e');

	let committed = $state({
		sizeMm: sizeMmFromTextSize(20),
		thickness: 1,
		baseThickness: 9,
		baseOffsetMm: 2,
		holeDiameter: 6
	});

	function resize() {
		if (!renderer || !camera || !hostEl) return;
		const rect = hostEl.getBoundingClientRect();
		const w = Math.max(1, Math.floor(rect.width));
		const h = Math.max(1, Math.floor(rect.height));
		renderer.setSize(w, h, true);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	function rebuildMeshes() {
		if (!group) return;
		disposeObject3D(group);
		group.clear();
		const content = (textContent ?? '').trim();
		if (!content) return;
		const font = getFont(fontKey);
		if (!font) return;
		const shapes = font.generateShapes(content, textSize);
		if (shapes.length === 0) return;

		const divisions = 18;
		// Font shapes are Y-up; pass through to Clipper without flipping (no -p.y) so text is not inverted
		const shapeToPaths = (shape: THREE.Shape) => {
			const toPath = (pts: THREE.Vector2[]) => {
				const out: { X: number; Y: number }[] = [];
				for (const p of pts) {
					out.push({
						X: Math.round(p.x * CLIPPER_SCALE),
						Y: Math.round(p.y * CLIPPER_SCALE)
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
			const holes = (shape.holes || []).map((h) => toPath(h.getPoints(divisions)));
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
		if (inputPaths.length === 0) return;

		const filledTree = new ClipperLib.PolyTree();
		{
			const c = new ClipperLib.Clipper();
			c.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
			c.Execute(
				ClipperLib.ClipType.ctUnion,
				filledTree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
		}

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

		const topBbox = getTreeBbox(filledTree);
		const maxExtentNorm = Math.max(
			0.001,
			(topBbox.maxX - topBbox.minX) / CLIPPER_SCALE,
			(topBbox.maxY - topBbox.minY) / CLIPPER_SCALE
		);
		// Use scale 1 so size matches TextOutlineDesigner (no target-mm normalization)
		const shapeScaleMm = 1;
		const offsetInClipper = (committed.baseOffsetMm / shapeScaleMm) * CLIPPER_SCALE;

		const baseTree = new ClipperLib.PolyTree();
		if (offsetInClipper > 0) {
			const co = new ClipperLib.ClipperOffset(2, 2);
			co.AddPaths(inputPaths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
			const offsetPaths: { X: number; Y: number }[][] = [];
			co.Execute(offsetPaths, offsetInClipper);
			const c2 = new ClipperLib.Clipper();
			c2.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
			c2.Execute(
				ClipperLib.ClipType.ctUnion,
				baseTree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
		} else {
			const c2 = new ClipperLib.Clipper();
			c2.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
			c2.Execute(
				ClipperLib.ClipType.ctUnion,
				baseTree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
		}
		const baseBbox2d = getTreeBbox(baseTree);

		const polyTreeToThreeShapes = (tree: any, scale2d: number) => {
			const out: THREE.Shape[] = [];
			const toVec2 = (pt: { X: number; Y: number }) =>
				new THREE.Vector2((pt.X / CLIPPER_SCALE) * scale2d, (pt.Y / CLIPPER_SCALE) * scale2d);
			const buildFromOuter = (outerNode: any, includeHoles: boolean): THREE.Shape | null => {
				const contour = outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
				if (!contour || contour.length < 3) return null;
				const outerPts = contour.map(toVec2);
				if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
				const shape = new THREE.Shape(outerPts);
				if (includeHoles) {
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

		const topShapes = polyTreeToThreeShapes(filledTree, shapeScaleMm);
		const baseShapes = polyTreeToThreeShapes(baseTree, shapeScaleMm);
		if (topShapes.length === 0 || baseShapes.length === 0) return;

		const topCenterX = (topBbox.minX + topBbox.maxX) / 2 / CLIPPER_SCALE;
		const topCenterY = (topBbox.minY + topBbox.maxY) / 2 / CLIPPER_SCALE;

		const baseDepth = Math.max(committed.holeDiameter + BASE_HOLE_BUFFER, committed.baseThickness);
		const topDepth = Math.max(0.2, committed.thickness);
		const baseGeo = new THREE.ExtrudeGeometry(baseShapes, {
			depth: baseDepth,
			bevelEnabled: false,
			curveSegments: 24,
			steps: 1
		});
		const topGeo = new THREE.ExtrudeGeometry(topShapes, {
			depth: topDepth,
			bevelEnabled: false,
			curveSegments: 24,
			steps: 1
		});
		centerGeometryXY(baseGeo);
		centerGeometryXY(topGeo);
		if (
			Number.isFinite(baseBbox2d.minX) &&
			Number.isFinite(baseBbox2d.maxX) &&
			Number.isFinite(baseBbox2d.minY) &&
			Number.isFinite(baseBbox2d.maxY)
		) {
			const baseCenterX = (baseBbox2d.minX + baseBbox2d.maxX) / 2 / CLIPPER_SCALE;
			const baseCenterY = (baseBbox2d.minY + baseBbox2d.maxY) / 2 / CLIPPER_SCALE;
			const dx = (baseCenterX - topCenterX) * shapeScaleMm;
			const dy = (baseCenterY - topCenterY) * shapeScaleMm;
			baseGeo.translate(dx, dy, 0);
		}
		baseGeo.computeBoundingBox();
		topGeo.computeBoundingBox();
		const baseBb = baseGeo.boundingBox!;
		const topBb = topGeo.boundingBox!;
		baseGeo.translate(0, 0, -baseBb.min.z);
		topGeo.translate(0, 0, -topBb.min.z);
		topGeo.translate(0, 0, baseDepth);

		const baseMat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.85,
			metalness: 0.05
		});
		const topMat = new THREE.MeshStandardMaterial({
			color: mainColor,
			roughness: 0.35,
			metalness: 0.1
		});

		const holeCenterZ = baseDepth / 2;
		const designCenterX =
			(Math.min(baseBb.min.x, topBb.min.x) + Math.max(baseBb.max.x, topBb.max.x)) / 2;
		const designCenterY =
			(Math.min(baseBb.min.y, topBb.min.y) + Math.max(baseBb.max.y, topBb.max.y)) / 2;
		if (holeLight) holeLight.position.set(designCenterX, designCenterY, holeCenterZ);
		const holeRadius = Math.max(0.5, committed.holeDiameter / 2);
		const designSize = baseBb.getSize(new THREE.Vector3());
		const designExtent = Math.max(designSize.x, designSize.y, 1);
		const holeLength = Math.max(BED_GRID_SIZE, designExtent + 80);
		const HOLE_FLAT_CEILING_OFFSET = 0.3;
		const flatCeilingZ = holeCenterZ + holeRadius - Math.max(0.1, HOLE_FLAT_CEILING_OFFSET);

		const cylinderGeo = new THREE.CylinderGeometry(holeRadius, holeRadius, holeLength, 32);
		const holeHorizontal = true;
		if (holeHorizontal) {
			cylinderGeo.rotateZ(-Math.PI);
		}
		cylinderGeo.translate(designCenterX, designCenterY, holeCenterZ);

		const boxHeight = flatCeilingZ + 100;
		// Box (X, Y, Z) must be long along the cylinder axis so we don't clip the hole. Cylinder is along Y.
		const halfSpaceGeo = new THREE.BoxGeometry(
			holeHorizontal ? committed.holeDiameter + 20 : holeLength + 20,
			holeHorizontal ? holeLength + 20 : committed.holeDiameter + 20,
			boxHeight
		);
		halfSpaceGeo.translate(designCenterX, designCenterY, (flatCeilingZ - 100) / 2);

		const dummyMat = new THREE.MeshBasicMaterial({ color: 0x808080 });
		const cylinderBrush = new Brush(cylinderGeo, dummyMat);
		const halfSpaceBrush = new Brush(halfSpaceGeo, dummyMat);
		const evaluator = new Evaluator();
		const intersectionTarget = new Brush(new THREE.BufferGeometry(), dummyMat);
		evaluator.evaluate(cylinderBrush, halfSpaceBrush, INTERSECTION, intersectionTarget);
		const flatTopHoleGeo = intersectionTarget.geometry;
		cylinderGeo.dispose();
		halfSpaceGeo.dispose();
		dummyMat.dispose();

		const HOLE_EPSILON_SCALE = 1.005;
		const holeDummyMat = new THREE.MeshBasicMaterial({ color: 0x808080 });
		const holeBrush = new Brush(flatTopHoleGeo.clone(), holeDummyMat);
		holeBrush.scale.set(HOLE_EPSILON_SCALE, HOLE_EPSILON_SCALE, HOLE_EPSILON_SCALE);

		const baseBrush = new Brush(baseGeo.clone(), baseMat);
		baseBrush.scale.set(1, 1, 1);
		const topBrush = new Brush(topGeo.clone(), topMat);
		topBrush.scale.set(1, 1, 1);

		baseBrush.updateMatrixWorld(true);
		topBrush.updateMatrixWorld(true);
		holeBrush.updateMatrixWorld(true);

		const resultBaseBrush = new Brush(new THREE.BufferGeometry(), baseMat);
		const resultTopBrush = new Brush(new THREE.BufferGeometry(), topMat);
		try {
			evaluator.evaluate(baseBrush, holeBrush, SUBTRACTION, resultBaseBrush);
			evaluator.evaluate(topBrush, holeBrush, SUBTRACTION, resultTopBrush);
		} catch (err) {
			console.error('CSG hole subtract failed:', err);
			baseBrush.geometry.dispose();
			topBrush.geometry.dispose();
			holeBrush.geometry.dispose();
			flatTopHoleGeo.dispose();
			holeDummyMat.dispose();
			return;
		}

		const baseGeoWelded = BufferGeometryUtils.mergeVertices(resultBaseBrush.geometry.clone(), 1e-3);
		resultBaseBrush.geometry.dispose();
		const baseMesh = new THREE.Mesh(baseGeoWelded, baseMat);
		baseMesh.name = 'base';
		baseMesh.scale.set(1, 1, 1);
		baseMesh.castShadow = true;
		baseMesh.receiveShadow = true;
		group.add(baseMesh);

		const topGeoWelded = BufferGeometryUtils.mergeVertices(resultTopBrush.geometry.clone(), 1e-3);
		resultTopBrush.geometry.dispose();
		const topMesh = new THREE.Mesh(topGeoWelded, topMat);
		topMesh.name = 'top';
		topMesh.scale.set(1, 1, 1);
		topMesh.castShadow = true;
		topMesh.receiveShadow = true;
		group.add(topMesh);

		baseBrush.geometry.dispose();
		topBrush.geometry.dispose();
		holeBrush.geometry.dispose();
		flatTopHoleGeo.dispose();
		holeDummyMat.dispose();

		group.scale.set(1, 1, 1);

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

	/** Build normalized SVG for OpenSCAD from current text/font/size. Returns { svg, sizeMm } so export uses same scale as preview. */
	function buildNormalizedSvgFromText(): { svg: string; sizeMm: number } | null {
		const font = getFont(fontKey);
		const content = (textContent ?? '').trim();
		if (!content || !font) return null;
		const shapes = font.generateShapes(content, textSize);
		if (shapes.length === 0) return null;

		const divisions = 18;
		const shapeToPaths = (shape: THREE.Shape) => {
			const toPath = (pts: THREE.Vector2[]) => {
				const out: { X: number; Y: number }[] = [];
				for (const p of pts) {
					out.push({
						X: Math.round(p.x * CLIPPER_SCALE),
						Y: Math.round(p.y * CLIPPER_SCALE)
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
			const holes = (shape.holes || []).map((h) => toPath(h.getPoints(divisions)));
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
			ClipperLib.PolyFillType.pftNonZero
		);
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
				(node.Childs?.() ?? node.m_Childs ?? []).forEach(collect);
			};
			(tree.Childs?.() ?? tree.m_Childs ?? []).forEach(collect);
			return { minX, maxX, minY, maxY };
		};
		const topBbox = getTreeBbox(filledTree);
		const maxExtentNorm = Math.max(
			0.001,
			(topBbox.maxX - topBbox.minX) / CLIPPER_SCALE,
			(topBbox.maxY - topBbox.minY) / CLIPPER_SCALE
		);
		const shapeScaleMm = 1;
		const cx = ((topBbox.minX + topBbox.maxX) / 2 / CLIPPER_SCALE) * shapeScaleMm;
		const cy = ((topBbox.minY + topBbox.maxY) / 2 / CLIPPER_SCALE) * shapeScaleMm;
		const half = maxExtentNorm / 2;
		const toPt = (p: { X: number; Y: number }) =>
			`${((p.X / CLIPPER_SCALE) * shapeScaleMm - cx + half).toFixed(4)},${(-(p.Y / CLIPPER_SCALE) * shapeScaleMm + cy + half).toFixed(4)}`;
		const pathParts: string[] = [];
		const roots = filledTree.Childs?.() ?? filledTree.m_Childs ?? [];
		for (const n of roots) {
			const isHole = n.IsHole?.() ?? n.m_IsHole;
			if (isHole) continue;
			const contour = n.Contour?.() ?? n.m_polygon ?? [];
			if (!contour || contour.length < 3) continue;
			pathParts.push(`M ${contour.map(toPt).join(' L ')} Z`);
			const children = n.Childs?.() ?? n.m_Childs ?? [];
			for (const ch of children) {
				const hole = ch.IsHole?.() ?? ch.m_IsHole;
				if (!hole) continue;
				const hContour = ch.Contour?.() ?? ch.m_polygon ?? [];
				if (hContour.length < 3) continue;
				pathParts.push(`M ${hContour.map(toPt).join(' L ')} Z`);
			}
		}
		if (pathParts.length === 0) return null;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maxExtentNorm} ${maxExtentNorm}"><path fill-rule="evenodd" d="${pathParts.join(' ')}" fill="black"/></svg>`;
		return { svg, sizeMm: maxExtentNorm };
	}

	/** OpenSCAD script: import normalized SVG (single shape, mm), offset(delta) only, linear_extrude, then subtract flat-top hole. */
	function getCharmBaseOpenScadScript(params: {
		sizeMm: number;
		baseThickness: number;
		baseOffsetMm: number;
		holeDiameter: number;
	}): string {
		const { sizeMm, baseThickness, baseOffsetMm, holeDiameter } = params;
		const holeR = Math.max(0.25, holeDiameter / 2);
		const holeLength = Math.max(BED_GRID_SIZE, sizeMm + 80);
		const flatCeilingOffset = Math.max(0.01, Math.min(holeR, 0.3));
		return `
$fn = 64;
size_mm = ${sizeMm};
base_thickness = ${baseThickness};
base_offset_mm = ${baseOffsetMm};
hole_diameter = ${holeDiameter};
hole_length = ${holeLength};
hole_flat_ceiling_offset = ${flatCeilingOffset};
hole_along_x = false;

module base_shape() {
  linear_extrude(height = base_thickness) {
    translate([-size_mm/2, -size_mm/2, 0]) {
      if (base_offset_mm > 0) {
        offset(delta = base_offset_mm) {
          import("/input.svg", center = false, dpi = 25.4);
        }
      } else {
        import("/input.svg", center = false, dpi = 25.4);
      }
    }
  }
}

module hole_cylinder() {
  translate([0, 0, base_thickness/2]) {
    if (hole_along_x) {
      rotate([0, 90, 0]) {
        cylinder(h = hole_length, r = hole_diameter/2, center = true);
      }
    } else {
      rotate([90, 0, 0]) {
        cylinder(h = hole_length, r = hole_diameter/2, center = true);
      }
    }
  }
}

module flat_top_hole() {
  cylinder_top_z = base_thickness/2 + hole_diameter/2;
  flat_ceiling_z = cylinder_top_z - hole_flat_ceiling_offset;
  intersection() {
    hole_cylinder();
    translate([0, 0, flat_ceiling_z/2 - 50]) {
      cube([hole_diameter + 20, hole_length + 20, flat_ceiling_z + 100], center = true);
    }
  }
}

difference() {
  base_shape();
  flat_top_hole();
}
`;
	}

	/** Build base via OpenSCAD: import normalized SVG (from text), offset, extrude, subtract hole. */
	async function buildOpenScadBaseGeometry(): Promise<THREE.BufferGeometry> {
		const result = buildNormalizedSvgFromText();
		if (!result) throw new Error('Could not build base shape from text');
		const { svg: normalizedSvg, sizeMm: sizeMmForExport } = result;
		const baseThickness = Math.max(
			committed.holeDiameter + BASE_HOLE_BUFFER,
			committed.baseThickness
		);
		const baseOffsetMm = Math.max(0, committed.baseOffsetMm);
		const holeDiameter = Math.max(0.5, committed.holeDiameter);
		const source = getCharmBaseOpenScadScript({
			sizeMm: sizeMmForExport,
			baseThickness,
			baseOffsetMm,
			holeDiameter
		});
		const stlBytes = await runOpenScad(source, {
			svgContent: normalizedSvg
		});
		let geo = stlToBufferGeometry(stlBytes);
		geo = BufferGeometryUtils.mergeVertices(geo, 1e-3);
		geo.computeBoundingBox();
		const bb = geo.boundingBox!;
		geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
		return geo;
	}

	async function exportStl() {
		if (!user) {
			onRequestLogin();
			return;
		}
		if (!textContent?.trim()) {
			exportError = 'Nothing to export yet';
			return;
		}
		exportError = null;
		exportLoading = true;
		try {
			const baseGeo = await buildOpenScadBaseGeometry();
			const exportGroup = new THREE.Group();
			const mat = new THREE.MeshBasicMaterial({ color: 0x808080 });
			exportGroup.add(new THREE.Mesh(baseGeo, mat));

			if (scene && group) {
				rebuildMeshes();
				group.updateWorldMatrix(true, true);
				for (const child of group.children) {
					const mesh = child as THREE.Mesh;
					if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.geometry) continue;
					if (mesh.name === 'base') continue;
					const cloneGeo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
					const cloneMat = Array.isArray(mesh.material)
						? (mesh.material[0] as THREE.Material).clone()
						: (mesh.material as THREE.Material).clone();
					exportGroup.add(new THREE.Mesh(cloneGeo, cloneMat));
				}
			}

			const exporter = new STLExporter();
			const result = exporter.parse(exportGroup, { binary: true });
			const buffer = result instanceof DataView ? result.buffer : result;
			const blob = new Blob([buffer], {
				type: 'application/octet-stream'
			});
			if (blob.size < 84) throw new Error('Export produced empty STL');

			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`straw-topper-${ts}.stl`, blob);
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: "Straw Topper",
				format: "stl"
			});
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	async function export3MF() {
		if (!user) {
			onRequestLogin();
			return;
		}
		if (!textContent?.trim()) {
			exportError = 'Nothing to export yet';
			return;
		}
		exportError = null;
		exportLoading = true;
		try {
			const baseGeo = await buildOpenScadBaseGeometry();
			const baseMatExport = new THREE.MeshBasicMaterial({
				color: new THREE.Color(baseColor)
			});
			const exportGroup = new THREE.Group();
			exportGroup.add(new THREE.Mesh(baseGeo, baseMatExport));

			if (scene && group) {
				rebuildMeshes();
				group.updateWorldMatrix(true, true);
				for (const child of group.children) {
					const mesh = child as THREE.Mesh;
					if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.geometry) continue;
					if (mesh.name === 'base') continue;
					const cloneGeo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
					const sceneMat = (
						Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
					) as THREE.MeshStandardMaterial;
					const color =
						sceneMat?.color != null ? sceneMat.color.clone() : new THREE.Color(0xffffff);
					const cloneMat = new THREE.MeshBasicMaterial({ color });
					exportGroup.add(new THREE.Mesh(cloneGeo, cloneMat));
				}
			}
			exportGroup.updateWorldMatrix(true, true);

			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) throw new Error('Export produced no geometry');
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`straw-topper-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: "Straw Topper",
				format: "3mf"
			});
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	async function openWithBambuStudio() {
		if (!textContent?.trim()) return;
		openBambuStudioLoading = true;
		try {
			const baseGeo = await buildOpenScadBaseGeometry();
			const baseMatExport = new THREE.MeshBasicMaterial({
				color: new THREE.Color(baseColor)
			});
			const exportGroup = new THREE.Group();
			exportGroup.add(new THREE.Mesh(baseGeo, baseMatExport));

			if (scene && group) {
				rebuildMeshes();
				group.updateWorldMatrix(true, true);
				for (const child of group.children) {
					const mesh = child as THREE.Mesh;
					if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.geometry) continue;
					if (mesh.name === 'base') continue;
					const cloneGeo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
					const sceneMat = (
						Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
					) as THREE.MeshStandardMaterial;
					const color =
						sceneMat?.color != null ? sceneMat.color.clone() : new THREE.Color(0xffffff);
					const cloneMat = new THREE.MeshBasicMaterial({ color });
					exportGroup.add(new THREE.Mesh(cloneGeo, cloneMat));
				}
			}
			exportGroup.updateWorldMatrix(true, true);

			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob);
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: "Straw Topper",
				format: "bambu_studio"
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			openBambuStudioLoading = false;
		}
	}

	let copyTimeoutId: ReturnType<typeof setTimeout> | null = null;
	let prevTextKey = '';
	const COMMIT_DEBOUNCE_MS = 100;

	$effect(() => {
		void textContent;
		void fontKey;
		void textSize;
		void thickness;
		void baseThickness;
		void baseOffsetMm;
		void holeDiameter;

		const sync = () => {
			const minBase = holeDiameter + BASE_HOLE_BUFFER;
			const base = Math.max(minBase, baseThickness);
			if (base !== baseThickness) baseThickness = base;
			committed = {
				sizeMm: sizeMmFromTextSize(textSize),
				thickness,
				baseThickness: base,
				baseOffsetMm,
				holeDiameter
			};
		};

		// Content/font sync immediately; sliders debounced 100ms for snappier preview
		const textKey = `${textContent}|${fontKey}`;
		if (textKey !== prevTextKey) {
			prevTextKey = textKey;
			if (copyTimeoutId !== null) {
				clearTimeout(copyTimeoutId);
				copyTimeoutId = null;
			}
			sync();
		} else {
			if (copyTimeoutId !== null) clearTimeout(copyTimeoutId);
			copyTimeoutId = setTimeout(() => {
				copyTimeoutId = null;
				sync();
			}, COMMIT_DEBOUNCE_MS);
		}

		return () => {
			if (copyTimeoutId !== null) {
				clearTimeout(copyTimeoutId);
				copyTimeoutId = null;
			}
		};
	});

	// Rebuild when committed or content/font change; defer to idle so UI stays responsive
	$effect(() => {
		void textContent;
		void fontKey;
		void committed.sizeMm;
		void committed.thickness;
		void committed.baseThickness;
		void committed.baseOffsetMm;
		void committed.holeDiameter;
		if (!scene || !group) return;
		const run = () => rebuildMeshes();
		if (typeof requestIdleCallback !== 'undefined') {
			requestIdleCallback(run, { timeout: 50 });
		} else {
			run();
		}
	});

	$effect(() => {
		void mainColor;
		void baseColor;
		if (!group) return;
		for (const child of group.children) {
			const mesh = child as THREE.Mesh;
			if (!(mesh as any).isMesh) continue;
			const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
			for (const m of mats) {
				const mat = m as THREE.MeshStandardMaterial;
				if (!(mat as any)?.color) continue;
				if (mesh.name === 'base') {
					mat.color.set(baseColor);
				} else {
					mat.color.set(mainColor);
				}
				mat.needsUpdate = true;
			}
		}
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

		holeLight = new THREE.PointLight(0xffffff, 0.9, 50, 2);
		holeLight.position.set(0, 0, 5);
		scene.add(holeLight);

		group = new THREE.Group();
		scene.add(group);

		const grid = new THREE.GridHelper(BED_GRID_SIZE, 25, 0xcbd5e1, 0xe2e8f0);
		grid.rotateX(Math.PI / 2);
		grid.position.z = -0.01;
		scene.add(grid);

		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();

		// Run initial build so text shows on first load (effect may have run before scene/group were set)
		rebuildMeshes();

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
		if (renderer && hostEl && renderer.domElement.parentElement === hostEl) {
			hostEl.removeChild(renderer.domElement);
		}
		renderer?.dispose();
		renderer = null;
		scene = null;
		camera = null;
		controls = null;
		group = null;
		keyLight = null;
		holeLight = null;
	});
</script>

<main class="h-dvh w-dvw bg-slate-100 p-4">
	<div class="flex h-full min-h-0 gap-4">
		<aside
			class="flex min-h-0 w-full max-w-[360px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Straw Topper</h1>
				<Button variant="outline" size="sm" onclick={onBack}>
					Back
				</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4 pt-0">
				<div>
					<label for="straw-topper-text" class="mb-1 block text-xs font-medium text-slate-700">
						Text
					</label>
					<input
						id="straw-topper-text"
						type="text"
						placeholder="Enter text…"
						class="w-full min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
						bind:value={textContent}
					/>
				</div>

				<div>
					<label for="straw-topper-font" class="mb-1 block text-xs font-medium text-slate-700">
						Font
					</label>
					<FontSelect id="straw-topper-font" bind:value={fontKey} />
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="straw-topper-text-size" class="text-xs font-medium text-slate-700"
							>Text size</label
						>
						<span class="text-xs text-slate-500">{textSize}</span>
					</div>
					<Slider
						type="single"
						bind:value={textSize}
						min={8}
						max={72}
						step={1}
						class="w-full"
						disabled={!textContent?.trim()}
					/>
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="straw-topper-thickness" class="text-xs font-medium text-slate-700"
							>Text thickness</label
						>
						<span class="text-xs text-slate-500">{thickness.toFixed(1)} mm</span>
					</div>
					<Slider
						type="single"
						bind:value={thickness}
						min={0.5}
						max={10}
						step={0.1}
						class="w-full"
						disabled={!textContent?.trim()}
					/>
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="straw-topper-base-thickness" class="text-xs font-medium text-slate-700"
							>Base thickness</label
						>
						<span class="text-xs text-slate-500">{baseThickness.toFixed(1)} mm</span>
					</div>
					<Slider
						type="single"
						bind:value={baseThickness}
						min={holeDiameter + BASE_HOLE_BUFFER}
						max={25}
						step={0.5}
						class="w-full"
						disabled={!textContent?.trim()}
					/>
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="straw-topper-base-offset" class="text-xs font-medium text-slate-700"
							>Outline width</label
						>
						<span class="text-xs text-slate-500">{baseOffsetMm.toFixed(2)} mm</span>
					</div>
					<Slider
						type="single"
						bind:value={baseOffsetMm}
						min={0}
						max={10}
						step={0.1}
						class="w-full"
						disabled={!textContent?.trim()}
					/>
				</div>

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Hole</div>
					<div>
						<div class="mb-1 flex items-center justify-between">
							<label for="straw-topper-hole-diameter" class="text-xs font-medium text-slate-700"
								>Diameter (mm)</label
							>
							<span class="text-xs text-slate-500">{holeDiameter.toFixed(1)}</span>
						</div>
						<Slider
							type="single"
							bind:value={holeDiameter}
							min={2}
							max={12}
							step={0.5}
							class="w-full"
							disabled={!textContent?.trim()}
						/>
					</div>
				</div>

				<div class="grid grid-cols-2 gap-3">
					<ColorPalettePicker
						bind:value={mainColor}
						{palette}
						label="Top color"
						disabled={!textContent?.trim()} />
					<ColorPalettePicker
						bind:value={baseColor}
						{palette}
						label="Base color"
						disabled={!textContent?.trim()} />
				</div>

				{#if exportError}
					<p class="text-xs text-red-600">{exportError}</p>
				{/if}
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div bind:this={hostEl} class="absolute inset-0"></div>
			<div class="absolute right-4 bottom-4">
				<DesignerExportToolbar
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'straw-topper')}
					onExport={() => (user && subscriptionStatus?.isActive ? exportStl() : onShowPricing?.())}
					onExport3MF={() => (user && subscriptionStatus?.isActive ? export3MF() : onShowPricing?.())}
					onOpenWithBambuStudio={() => (user && subscriptionStatus?.isActive ? openWithBambuStudio() : onShowPricing?.())}
					openBambuStudioLoading={openBambuStudioLoading}
					exportDisabled={!textContent?.trim() || exportLoading}
					exportTitle={!user
						? 'Sign in to export'
						: !subscriptionStatus?.isActive
							? 'Subscribe to export'
							: 'Export STL or 3MF (multipart) for 3D print'}
					{exportLoading}
					showLockIcon={!user || !subscriptionStatus?.isActive}
				/>
			</div>
		</section>
	</div>

	<LoadingModal
		open={exportLoading}
		title="Exporting STL"
		description="Preparing your 3D model… This usually takes a few seconds."
		titleId="straw-topper-export-loading-title"
	/>
</main>
