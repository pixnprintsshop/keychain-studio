<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import ClipperLib from 'clipper-lib';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { runOpenScad } from '$lib/openscad';
	import {
		centerGeometryXY,
		createRoundedRectShape,
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		frameCameraToObject,
		getFont,
		measureWorldAabbSizeMm,
		stlToBufferGeometry
	} from '$lib/utils-3d';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import type { PaletteColor } from '$lib/colorPalette';
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';

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
		onShowPricing
	}: Props = $props();

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
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);

	const CLIPPER_SCALE = 1000;
	const DIVISIONS = 12;
	const PUZZLE_POCKET_FLOOR_MM = 1;

	let textContent = $state('Name');
	const fontKey = 'Roadside Sans_Regular';
	let textSize = $state(24);
	let thickness = $state(10);
	let padding = $state(8);
	let tolerance = $state(0.3);
	let cornerRadius = $state(5);
	let baseColor = $state('#ffffff');
	let pieceColor = $state('#f472b6');
	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);
	let isReady = $state(false);
	let sceneLoading = $state(false);
	let previewMode = $state<'base' | 'pieces'>('base');

	/** Create solid shapes from font output: outer boundary only, no holes (A, O, B become filled). */
	function shapesToSolid(shapes: THREE.Shape[]): THREE.Shape[] {
		const solid: THREE.Shape[] = [];
		for (const shape of shapes) {
			const pts = shape.getPoints(DIVISIONS);
			if (pts.length < 3) continue;
			const s = new THREE.Shape();
			s.moveTo(pts[0].x, pts[0].y);
			for (let i = 1; i < pts.length; i++) {
				s.lineTo(pts[i].x, pts[i].y);
			}
			solid.push(s);
		}
		return solid;
	}

	function shapeToClipperPath(shape: THREE.Shape): { X: number; Y: number }[] {
		const pts = shape.getPoints(DIVISIONS);
		const out: { X: number; Y: number }[] = [];
		for (const p of pts) {
			out.push({ X: Math.round(p.x * CLIPPER_SCALE), Y: Math.round(p.y * CLIPPER_SCALE) });
		}
		if (
			out.length > 2 &&
			out[0].X === out[out.length - 1].X &&
			out[0].Y === out[out.length - 1].Y
		) {
			out.pop();
		}
		return out;
	}

	function ensureCW(path: { X: number; Y: number }[], clockwise: boolean) {
		if (ClipperLib.Clipper.Orientation(path) !== clockwise) path.reverse();
	}

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
		if (!group || !scene) return;
		const content = (textContent ?? '').trim();
		if (!content) {
			modelAabbMm = null;
			return;
		}
		try {
			disposeObject3D(group);
			group.clear();
		} catch (e) {
			console.error('NamePuzzle dispose failed:', e);
			modelAabbMm = null;
			return;
		}
		modelAabbMm = null;
		const font = getFont(fontKey);
		if (!font) return;
		let rawShapes: THREE.Shape[];
		try {
			rawShapes = font.generateShapes(content, Math.max(1, textSize));
		} catch (e) {
			console.error('NamePuzzle generateShapes failed:', e);
			return;
		}
		if (!rawShapes || rawShapes.length === 0) return;
		const solidShapes = shapesToSolid(rawShapes);
		if (solidShapes.length === 0) return;

		const inputPaths: { X: number; Y: number }[][] = [];
		for (const s of solidShapes) {
			const path = shapeToClipperPath(s);
			if (path.length < 3) continue;
			ensureCW(path, true);
			inputPaths.push(path);
		}
		if (inputPaths.length === 0) return;

		const unionTree = new ClipperLib.PolyTree();
		const c = new ClipperLib.Clipper();
		c.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
		c.Execute(
			ClipperLib.ClipType.ctUnion,
			unionTree,
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
				const childs = node.Childs?.() ?? node.m_Childs ?? [];
				childs.forEach(collect);
			};
			const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
			roots.forEach(collect);
			return { minX, maxX, minY, maxY };
		};

		const textBbox = getTreeBbox(unionTree);
		const spanX = (textBbox.maxX - textBbox.minX) / CLIPPER_SCALE;
		const spanY = (textBbox.maxY - textBbox.minY) / CLIPPER_SCALE;
		if (!Number.isFinite(spanX) || !Number.isFinite(spanY) || spanX <= 0 || spanY <= 0) return;
		const halfW = spanX / 2 + padding;
		const halfH = spanY / 2 + padding;
		const baseDepth = Math.max(0.5, thickness);
		const cutoutDepth = Math.max(0.2, baseDepth - PUZZLE_POCKET_FLOOR_MM);
		let baseGeo: THREE.ExtrudeGeometry;
		let cutoutGeo: THREE.ExtrudeGeometry;
		try {
			const baseShape = createRoundedRectShape(
				halfW,
				halfH,
				Math.min(cornerRadius, halfW * 0.4, halfH * 0.4)
			);
			baseGeo = new THREE.ExtrudeGeometry([baseShape], {
				depth: Math.max(0.5, thickness),
				bevelEnabled: false,
				curveSegments: 8,
				steps: 1
			});
			centerGeometryXY(baseGeo);

			const toleranceInClipper = Math.max(0, tolerance) * CLIPPER_SCALE;
			const cutoutTree = new ClipperLib.PolyTree();
			if (toleranceInClipper > 0) {
				const co = new ClipperLib.ClipperOffset(2, 2);
				co.AddPaths(inputPaths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
				const offsetPaths: { X: number; Y: number }[][] = [];
				co.Execute(offsetPaths, toleranceInClipper);
				const c2 = new ClipperLib.Clipper();
				c2.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
				c2.Execute(
					ClipperLib.ClipType.ctUnion,
					cutoutTree,
					ClipperLib.PolyFillType.pftNonZero,
					ClipperLib.PolyFillType.pftNonZero
				);
			} else {
				const c2 = new ClipperLib.Clipper();
				c2.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
				c2.Execute(
					ClipperLib.ClipType.ctUnion,
					cutoutTree,
					ClipperLib.PolyFillType.pftNonZero,
					ClipperLib.PolyFillType.pftNonZero
				);
			}

			const treeToShapes = (tree: any): THREE.Shape[] => {
				const out: THREE.Shape[] = [];
				const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
				const toVec2 = (pt: { X: number; Y: number }) =>
					new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE);
				const build = (node: any): THREE.Shape | null => {
					const contour = node.Contour?.() ?? node.m_polygon ?? [];
					if (contour.length < 3) return null;
					const isHole = node.IsHole?.() ?? node.m_IsHole;
					if (isHole) return null;
					const pts = contour.map(toVec2);
					if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
					const s = new THREE.Shape();
					s.moveTo(pts[0].x, pts[0].y);
					for (let i = 1; i < pts.length; i++) s.lineTo(pts[i].x, pts[i].y);
					return s;
				};
				for (const n of roots) {
					const s = build(n);
					if (s) out.push(s);
				}
				return out;
			};

			const cutoutShapes = treeToShapes(cutoutTree);
			if (cutoutShapes.length === 0) {
				baseGeo.dispose();
				return;
			}
			cutoutGeo = new THREE.ExtrudeGeometry(cutoutShapes, {
				depth: cutoutDepth + 0.01,
				bevelEnabled: false,
				curveSegments: 8,
				steps: 1
			});
			centerGeometryXY(cutoutGeo);
			baseGeo.computeBoundingBox();
			cutoutGeo.computeBoundingBox();
			const baseBb = baseGeo.boundingBox!;
			cutoutGeo.translate(0, 0, -baseBb.min.z + baseDepth - cutoutDepth);
		} catch (e) {
			console.error('NamePuzzle geometry build failed:', e);
			return;
		}

		const baseMat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.6,
			metalness: 0.1
		});
		const dummyMat = new THREE.MeshBasicMaterial({ color: 0x808080 });
		const cutoutBrush = new Brush(cutoutGeo, dummyMat);
		const baseBrush = new Brush(baseGeo.clone(), baseMat);
		baseBrush.updateMatrixWorld(true);
		cutoutBrush.updateMatrixWorld(true);
		const resultBase = new Brush(new THREE.BufferGeometry(), baseMat);
		const evaluator = new Evaluator();
		try {
			evaluator.evaluate(baseBrush, cutoutBrush, SUBTRACTION, resultBase);
		} catch (err) {
			console.error('CSG subtract failed:', err);
			baseBrush.geometry.dispose();
			cutoutBrush.geometry.dispose();
			cutoutGeo.dispose();
			dummyMat.dispose();
			return;
		}
		baseBrush.geometry.dispose();
		cutoutBrush.geometry.dispose();
		cutoutGeo.dispose();
		dummyMat.dispose();

		const baseWelded = BufferGeometryUtils.mergeVertices(resultBase.geometry.clone(), 1e-3);
		resultBase.geometry.dispose();
		const baseMesh = new THREE.Mesh(baseWelded, baseMat);
		baseMesh.name = 'base';
		baseMesh.castShadow = true;
		baseMesh.receiveShadow = true;
		group.add(baseMesh);

		const piecesPreviewGroup = buildPuzzlePiecesGroup();
		piecesPreviewGroup.name = 'pieces-preview-group';
		piecesPreviewGroup.position.z = 0;
		piecesPreviewGroup.traverse((child) => {
			if ((child as any).isMesh) {
				const m = child as THREE.Mesh;
				m.castShadow = true;
				m.receiveShadow = true;
			}
		});
		group.add(piecesPreviewGroup);

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
		applyPreviewModeVisibility();
		{
			const s = measureWorldAabbSizeMm(group);
			modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
		}
	}

	function applyPreviewModeVisibility() {
		if (!group) return;
		const showBase = previewMode === 'base';
		group.traverse((child) => {
			if (!(child as any).isMesh) return;
			const mesh = child as THREE.Mesh;
			if (mesh.name === 'base') {
				mesh.visible = showBase;
				return;
			}
			if (mesh.name.startsWith('letter-')) {
				mesh.visible = !showBase;
			}
		});
	}

	/** Build a group of A–Z puzzle pieces laid out in a grid. */
	function buildPuzzlePiecesGroup(): THREE.Group {
		const font = getFont(fontKey);
		if (!font) return new THREE.Group();
		const pieceMat = new THREE.MeshStandardMaterial({
			color: pieceColor,
			roughness: 0.6,
			metalness: 0.1
		});
		const group = new THREE.Group();
		const size = Math.max(1, textSize);
		const depth = Math.max(0.5, thickness * 1.2);
		const cols = 6;
		const spacingX = size * 1.1;
		const spacingY = size * 1.3;
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
		for (let i = 0; i < alphabet.length; i++) {
			const char = alphabet[i];
			const shapes = font.generateShapes(char, size);
			if (!shapes?.length) continue;
			let geo: THREE.BufferGeometry;
			try {
				geo = new THREE.ExtrudeGeometry(shapes, {
					depth,
					bevelEnabled: false,
					curveSegments: 8,
					steps: 1
				});
			} catch {
				continue;
			}
			centerGeometryXY(geo);
			const col = i % cols;
			const row = Math.floor(i / cols);
			const mesh = new THREE.Mesh(geo, pieceMat);
			mesh.name = `letter-${char}`;
			mesh.position.set(col * spacingX, row * spacingY, 0);
			group.add(mesh);
		}
		group.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(group);
		const center = new THREE.Vector3();
		box.getCenter(center);
		group.position.sub(center);
		return group;
	}

	function buildPuzzleCutoutSvgForOpenScad(): {
		svg: string;
		textWidth: number;
		textHeight: number;
		baseWidth: number;
		baseHeight: number;
		baseCornerRadius: number;
		baseThickness: number;
	} | null {
		const content = (textContent ?? '').trim();
		if (!content) return null;
		const font = getFont(fontKey);
		if (!font) return null;
		const rawShapes = font.generateShapes(content, Math.max(1, textSize));
		if (!rawShapes?.length) return null;
		const solidShapes = shapesToSolid(rawShapes);
		if (!solidShapes.length) return null;

		const inputPaths: { X: number; Y: number }[][] = [];
		for (const s of solidShapes) {
			const path = shapeToClipperPath(s);
			if (path.length < 3) continue;
			ensureCW(path, true);
			inputPaths.push(path);
		}
		if (!inputPaths.length) return null;

		const toleranceInClipper = Math.max(0, tolerance) * CLIPPER_SCALE;
		const cutoutTree = new ClipperLib.PolyTree();
		if (toleranceInClipper > 0) {
			const co = new ClipperLib.ClipperOffset(2, 2);
			co.AddPaths(inputPaths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
			const offsetPaths: { X: number; Y: number }[][] = [];
			co.Execute(offsetPaths, toleranceInClipper);
			const c = new ClipperLib.Clipper();
			c.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
			c.Execute(
				ClipperLib.ClipType.ctUnion,
				cutoutTree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
		} else {
			const c = new ClipperLib.Clipper();
			c.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
			c.Execute(
				ClipperLib.ClipType.ctUnion,
				cutoutTree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
		}

		const getTreeBbox = (tree: any) => {
			let minX = Infinity;
			let maxX = -Infinity;
			let minY = Infinity;
			let maxY = -Infinity;
			const collect = (node: any) => {
				const contour = node.Contour?.() ?? node.m_polygon ?? [];
				for (const p of contour) {
					minX = Math.min(minX, p.X);
					maxX = Math.max(maxX, p.X);
					minY = Math.min(minY, p.Y);
					maxY = Math.max(maxY, p.Y);
				}
				const children = node.Childs?.() ?? node.m_Childs ?? [];
				for (const child of children) collect(child);
			};
			const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
			for (const root of roots) collect(root);
			return { minX, maxX, minY, maxY };
		};

		const cutoutBbox = getTreeBbox(cutoutTree);
		const textWidth = (cutoutBbox.maxX - cutoutBbox.minX) / CLIPPER_SCALE;
		const textHeight = (cutoutBbox.maxY - cutoutBbox.minY) / CLIPPER_SCALE;
		if (
			!Number.isFinite(textWidth) ||
			!Number.isFinite(textHeight) ||
			textWidth <= 0 ||
			textHeight <= 0
		) {
			return null;
		}

		const cx = (cutoutBbox.minX + cutoutBbox.maxX) / 2 / CLIPPER_SCALE;
		const cy = (cutoutBbox.minY + cutoutBbox.maxY) / 2 / CLIPPER_SCALE;
		const halfW = textWidth / 2;
		const halfH = textHeight / 2;
		const toPt = (p: { X: number; Y: number }) =>
			`${(p.X / CLIPPER_SCALE - cx + halfW).toFixed(4)},${(-(p.Y / CLIPPER_SCALE) + cy + halfH).toFixed(4)}`;

		const pathParts: string[] = [];
		const roots = cutoutTree.Childs?.() ?? cutoutTree.m_Childs ?? [];
		for (const n of roots) {
			const isHole = n.IsHole?.() ?? n.m_IsHole;
			if (isHole) continue;
			const contour = n.Contour?.() ?? n.m_polygon ?? [];
			if (!contour?.length || contour.length < 3) continue;
			pathParts.push(`M ${contour.map(toPt).join(' L ')} Z`);
			const children = n.Childs?.() ?? n.m_Childs ?? [];
			for (const ch of children) {
				const hole = ch.IsHole?.() ?? ch.m_IsHole;
				if (!hole) continue;
				const hContour = ch.Contour?.() ?? ch.m_polygon ?? [];
				if (!hContour?.length || hContour.length < 3) continue;
				pathParts.push(`M ${hContour.map(toPt).join(' L ')} Z`);
			}
		}
		if (!pathParts.length) return null;

		const baseWidth = textWidth + padding * 2;
		const baseHeight = textHeight + padding * 2;
		const maxRadius = Math.max(0, Math.min(baseWidth / 2, baseHeight / 2));
		const baseCornerRadius = Math.max(0, Math.min(cornerRadius, maxRadius));
		const baseThickness = Math.max(0.5, thickness);
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${textWidth.toFixed(4)} ${textHeight.toFixed(4)}"><path fill-rule="evenodd" d="${pathParts.join(' ')}" fill="black"/></svg>`;

		return {
			svg,
			textWidth,
			textHeight,
			baseWidth,
			baseHeight,
			baseCornerRadius,
			baseThickness
		};
	}

	function getNamePuzzleOpenScadScript(params: {
		baseWidth: number;
		baseHeight: number;
		baseThickness: number;
		cornerRadius: number;
		textWidth: number;
		textHeight: number;
	}): string {
		const { baseWidth, baseHeight, baseThickness, cornerRadius, textWidth, textHeight } = params;
		return `
$fn = 96;
base_w = ${baseWidth};
base_h = ${baseHeight};
base_t = ${baseThickness};
corner_r = ${cornerRadius};
text_w = ${textWidth};
text_h = ${textHeight};

module rounded_rect_2d(w, h, r) {
  if (r <= 0) {
    square([w, h], center = true);
  } else {
    offset(r = r) {
      offset(delta = -r) {
        square([w, h], center = true);
      }
    }
  }
}

module cutout_2d() {
  translate([-text_w / 2, -text_h / 2, 0]) {
    import("/input.svg", center = false, dpi = 25.4);
  }
}

difference() {
  linear_extrude(height = base_t) {
    rounded_rect_2d(base_w, base_h, corner_r);
  }
  cutout_depth = max(0.2, base_t - ${PUZZLE_POCKET_FLOOR_MM});
  translate([0, 0, base_t - cutout_depth]) {
    linear_extrude(height = cutout_depth + 0.05) {
      cutout_2d();
    }
  }
}
`;
	}

	async function buildOpenScadNamePuzzleBaseGeometry(): Promise<THREE.BufferGeometry> {
		const cutout = buildPuzzleCutoutSvgForOpenScad();
		if (!cutout) throw new Error('Could not build puzzle cutout from text');
		const source = getNamePuzzleOpenScadScript({
			baseWidth: cutout.baseWidth,
			baseHeight: cutout.baseHeight,
			baseThickness: cutout.baseThickness,
			cornerRadius: cutout.baseCornerRadius,
			textWidth: cutout.textWidth,
			textHeight: cutout.textHeight
		});
		const stlBytes = await runOpenScad(source, { svgContent: cutout.svg });
		let geo = stlToBufferGeometry(stlBytes);
		geo = BufferGeometryUtils.mergeVertices(geo, 1e-3);
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) throw new Error('Failed to compute exported geometry bounds');
		geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
		return geo;
	}

	async function exportSTL() {
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			if (previewMode === 'pieces') {
				const piecesGroup = buildPuzzlePiecesGroup();
				try {
					if (piecesGroup.children.length === 0) throw new Error('Could not generate puzzle pieces');
					piecesGroup.updateWorldMatrix(true, true);
					const geometries: THREE.BufferGeometry[] = [];
					piecesGroup.traverse((child) => {
						const mesh = child as THREE.Mesh;
						if (mesh?.isMesh && mesh.geometry) {
							geometries.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
						}
					});
					const merged = BufferGeometryUtils.mergeGeometries(geometries);
					if (!merged) throw new Error('Merge failed');
					const exporter = new STLExporter();
					const result = exporter.parse(new THREE.Mesh(merged, new THREE.MeshBasicMaterial()), {
						binary: true
					});
					const buffer = result instanceof DataView ? result.buffer : result;
					const blob = new Blob([buffer], { type: 'application/octet-stream' });
					if (blob.size < 84) throw new Error('Export produced empty STL');
					const ts = new Date().toISOString().replace(/[:.]/g, '-');
					downloadBlob(`puzzle-pieces-AZ-${ts}.stl`, blob);
					merged.dispose();
					notifyExportEvent({
						email: user?.email,
						name:
							(user as any)?.user_metadata?.full_name ?? (user as any)?.user_metadata?.name ?? '',
						subscriptionStatus,
						designName: 'Puzzle Pieces A–Z',
						format: 'stl'
					});
				} finally {
					disposeObject3D(piecesGroup);
				}
				onShowThankYou();
				return;
			}
			const baseGeo = await buildOpenScadNamePuzzleBaseGeometry();
			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial()), {
				binary: true
			});
			const buffer = result instanceof DataView ? result.buffer : result;
			const blob = new Blob([buffer], { type: 'application/octet-stream' });
			if (blob.size < 84) throw new Error('Export produced empty STL');
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`name-puzzle-${ts}.stl`, blob);
			baseGeo.dispose();
			notifyExportEvent({
				email: user?.email,
				name: (user as any)?.user_metadata?.full_name ?? (user as any)?.user_metadata?.name ?? '',
				subscriptionStatus,
				designName: 'Name Puzzle',
				format: 'stl'
			});
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	async function export3MF() {
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			if (previewMode === 'pieces') {
				const piecesGroup = buildPuzzlePiecesGroup();
				try {
					if (piecesGroup.children.length === 0) throw new Error('Could not generate puzzle pieces');
					const blob = await exportTo3MF(piecesGroup);
					if (!blob || blob.size === 0) throw new Error('Export produced no geometry');
					const ts = new Date().toISOString().replace(/[:.]/g, '-');
					downloadBlob(`puzzle-pieces-AZ-${ts}.3mf`, blob);
					notifyExportEvent({
						email: user?.email,
						name:
							(user as any)?.user_metadata?.full_name ?? (user as any)?.user_metadata?.name ?? '',
						subscriptionStatus,
						designName: 'Puzzle Pieces A–Z',
						format: '3mf'
					});
				} finally {
					disposeObject3D(piecesGroup);
				}
				onShowThankYou();
				return;
			}
			const baseGeo = await buildOpenScadNamePuzzleBaseGeometry();
			const exportGroup = new THREE.Group();
			exportGroup.add(
				new THREE.Mesh(baseGeo, new THREE.MeshStandardMaterial({ color: baseColor }))
			);
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) throw new Error('Export produced no geometry');
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`name-puzzle-${ts}.3mf`, blob);
			baseGeo.dispose();
			notifyExportEvent({
				email: user?.email,
				name: (user as any)?.user_metadata?.full_name ?? (user as any)?.user_metadata?.name ?? '',
				subscriptionStatus,
				designName: 'Name Puzzle',
				format: '3mf'
			});
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	async function openWithBambuStudio() {
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		openBambuStudioLoading = true;
		exportError = null;
		await tickThenYieldToPaint();
		try {
			if (previewMode === 'pieces') {
				const piecesGroup = buildPuzzlePiecesGroup();
				try {
					if (piecesGroup.children.length === 0) throw new Error('Could not generate puzzle pieces');
					const blob = await exportTo3MF(piecesGroup);
					if (!blob || blob.size === 0) throw new Error('Export produced no geometry');
					const publicUrl = await upload3mfToSupabase(blob, 'name-puzzle-pieces');
					window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
				} finally {
					disposeObject3D(piecesGroup);
				}
				onShowThankYou();
				return;
			}
			const baseGeo = await buildOpenScadNamePuzzleBaseGeometry();
			const exportGroup = new THREE.Group();
			exportGroup.add(
				new THREE.Mesh(baseGeo, new THREE.MeshStandardMaterial({ color: baseColor }))
			);
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) throw new Error('Export produced no geometry');
			baseGeo.dispose();
			const publicUrl = await upload3mfToSupabase(blob, 'name-puzzle');
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Upload failed';
		} finally {
			openBambuStudioLoading = false;
		}
	}

	function doSnapshot() {
		if (renderer && scene && camera) {
			downloadSnapshot(renderer, scene, camera, 'name-puzzle');
		}
	}

	let rebuildTimeoutId: ReturnType<typeof setTimeout> | null = null;
	const REBUILD_DEBOUNCE_MS = 350;

	$effect(() => {
		void textContent;
		void textSize;
		void thickness;
		void padding;
		void tolerance;
		void cornerRadius;
		void baseColor;
		void pieceColor;
		void isReady;
		if (!group) return;
		if (isReady) sceneLoading = true;
		if (rebuildTimeoutId !== null) {
			clearTimeout(rebuildTimeoutId);
			rebuildTimeoutId = null;
		}
		rebuildTimeoutId = setTimeout(() => {
			rebuildTimeoutId = null;
			const done = () => {
				rebuildMeshes();
				sceneLoading = false;
			};
			if (typeof requestIdleCallback !== 'undefined') {
				requestIdleCallback(done, { timeout: 50 });
			} else {
				done();
			}
		}, REBUILD_DEBOUNCE_MS);
		return () => {
			if (rebuildTimeoutId !== null) {
				clearTimeout(rebuildTimeoutId);
				rebuildTimeoutId = null;
			}
		};
	});

	$effect(() => {
		void previewMode;
		applyPreviewModeVisibility();
	});

	onMount(() => {
		if (!hostEl || typeof window === 'undefined') return;
		renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
		renderer.setPixelRatio(Math.min(2, window.devicePixelRatio ?? 1));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.2;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		renderer.domElement.style.display = 'block';
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		hostEl.appendChild(renderer.domElement);
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);
		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.screenSpacePanning = false;
		controls.minDistance = 10;
		controls.maxDistance = 500;
		controls.update();
		group = new THREE.Group();
		scene.add(group);
		keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
		keyLight.position.set(60, -80, 140);
		keyLight.castShadow = true;
		keyLight.shadow.mapSize.set(2048, 2048);
		scene.add(keyLight);
		scene.add(keyLight.target);
		scene.add(new THREE.AmbientLight(0xffffff, 0.85));
		const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
		fillLight.position.set(-120, 90, 80);
		scene.add(fillLight);
		const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
		grid.rotateX(Math.PI / 2);
		grid.position.z = -0.01;
		scene.add(grid);
		resize();
		// Defer heavy build so full UI paints first; run when browser is idle
		const doBuild = () => {
			rebuildMeshes();
			isReady = true;
		};
		if (typeof requestIdleCallback !== 'undefined') {
			requestIdleCallback(doBuild, { timeout: 100 });
		} else {
			requestAnimationFrame(doBuild);
		}
		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();
		function animate() {
			rafId = requestAnimationFrame(animate);
			controls?.update();
			renderer?.render(scene!, camera!);
		}
		animate();
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		ro?.disconnect();
		ro = null;
		if (group) {
			disposeObject3D(group);
			group = null;
		}
		renderer?.dispose();
		renderer = null;
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="flex h-full min-h-0 gap-4">
		<aside
			class="flex min-h-0 w-full max-w-[360px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">
					Baby / Toddler Name Puzzle
				</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>
			<div class="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4 pt-0">
				<div>
					<label for="name-puzzle-text" class="mb-1 block text-xs font-medium text-slate-700"
						>Name</label
					>
					<input
						id="name-puzzle-text"
						type="text"
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
						placeholder="Enter name"
						bind:value={textContent}
					/>
				</div>
				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="name-puzzle-size" class="text-xs font-medium text-slate-700"
							>Text size</label
						>
						<span class="text-xs text-slate-500">{textSize}</span>
					</div>
					<Slider
						id="name-puzzle-size"
						min={12}
						max={48}
						step={1}
						bind:value={textSize}
						type="single"
						class="w-full"
					/>
				</div>
				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="name-puzzle-thickness" class="text-xs font-medium text-slate-700"
							>Thickness (mm)</label
						>
						<span class="text-xs text-slate-500">{thickness}</span>
					</div>
					<Slider
						id="name-puzzle-thickness"
						min={3}
						max={20}
						step={0.5}
						bind:value={thickness}
						type="single"
						class="w-full"
					/>
				</div>
				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="name-puzzle-padding" class="text-xs font-medium text-slate-700"
							>Padding (mm)</label
						>
						<span class="text-xs text-slate-500">{padding}</span>
					</div>
					<Slider
						id="name-puzzle-padding"
						min={4}
						max={20}
						step={1}
						bind:value={padding}
						type="single"
						class="w-full"
					/>
				</div>
				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="name-puzzle-tolerance" class="text-xs font-medium text-slate-700"
							>Tolerance (mm)</label
						>
						<span class="text-xs text-slate-500">{tolerance}</span>
					</div>
					<Slider
						id="name-puzzle-tolerance"
						min={0.1}
						max={0.6}
						step={0.05}
						bind:value={tolerance}
						type="single"
						class="w-full"
					/>
				</div>
				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="name-puzzle-corners" class="text-xs font-medium text-slate-700"
							>Corner radius</label
						>
						<span class="text-xs text-slate-500">{cornerRadius}</span>
					</div>
					<Slider
						id="name-puzzle-corners"
						min={0}
						max={15}
						step={1}
						bind:value={cornerRadius}
						type="single"
						class="w-full"
					/>
				</div>
				<div>
					<ColorPalettePicker bind:value={baseColor} {palette} label="Base color" />
				</div>
				<div>
					<ColorPalettePicker bind:value={pieceColor} {palette} label="Piece color" />
				</div>
				{#if exportError}
					<p class="text-sm text-red-600">{exportError}</p>
				{/if}
			</div>
		</aside>
		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0"></div>
			{#if !isReady || sceneLoading}
				<div
					class="pointer-events-none absolute inset-0 flex items-center justify-center"
					aria-live="polite"
				>
					<span
						class="rounded-xl bg-white/90 px-4 py-2 text-sm text-slate-600 shadow-lg backdrop-blur"
					>
						{!isReady ? 'Preparing puzzle…' : 'Updating preview…'}
					</span>
				</div>
			{/if}
			<div class="absolute top-1/2 right-4 z-10 -translate-y-1/2">
				<div
					class="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white/95 p-2 shadow-lg backdrop-blur"
				>
					<Button
						size="sm"
						class="justify-start"
						style="background-color: {previewMode === 'base' ? '' : '#e0e7ef'};"
						onclick={() => (previewMode = 'base')}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"
							><!-- Icon from Material Symbols by Google - https://github.com/google/material-design-icons/blob/master/LICENSE --><path
								fill="currentColor"
								d="M6.4 18h2.1l1.1-3.05h4.8L15.5 18h2.1L13.05 6h-2.1zm3.8-4.8l1.75-4.95h.1l1.75 4.95zM4 22q-.825 0-1.412-.587T2 20V4q0-.825.588-1.412T4 2h16q.825 0 1.413.588T22 4v16q0 .825-.587 1.413T20 22z"
							/></svg
						>
					</Button>
					<Button
						size="sm"
						class="justify-start"
						style="background-color: {previewMode === 'pieces' ? '' : '#e0e7ef'};"
						onclick={() => (previewMode = 'pieces')}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="22"
							height="22"
							viewBox="0 0 24 24"
							fill="none"
						>
							<path
								d="M12 4L18 20H16.2L14.7 16H9.3L7.8 20H6L12 4ZM10 14H14L12 8.67L10 14Z"
								fill="currentColor"
							/>
						</svg>
					</Button>
				</div>
			</div>
			<div class="absolute right-4 bottom-4 flex flex-wrap items-center gap-2">
				<DesignerExportToolbar
					onSnapshot={doSnapshot}
					onExport={() =>
						user && subscriptionStatus?.isActive ? void exportSTL() : onShowPricing?.()}
					exportDisabled={!textContent?.trim() || exportLoading}
					exportTitle={getExportTitle(
						user,
						subscriptionStatus,
						previewMode === 'pieces' ? 'Export puzzle pieces (STL)' : 'Export base (STL)'
					)}
					{exportLoading}
					onExport3MF={() =>
						user && subscriptionStatus?.isActive ? void export3MF() : onShowPricing?.()}
					onOpenWithBambuStudio={() =>
						user && subscriptionStatus?.isActive
							? void openWithBambuStudio()
							: onShowPricing?.()}
					{openBambuStudioLoading}
					showLockIcon={!user || !subscriptionStatus?.isActive}
				/>
			</div>
		</section>
	</div>
</main>
