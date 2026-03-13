<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import ClipperLib from 'clipper-lib';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import { exportTo3MF } from 'three-3mf-exporter';
	import type { LicenseStatus } from '$lib/licensing';
	import { uploadSvgToSupabase } from '$lib/svgUpload';
	import { runOpenScad } from '$lib/openscad';
	import {
		centerGeometryXY,
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		frameCameraToObject,
		stlToBufferGeometry
	} from '$lib/utils';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import type LicenseModal from './LicenseModal.svelte';
	import LoadingModal from './LoadingModal.svelte';
	import SvgInfoModal from './SvgInfoModal.svelte';

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
		onShowThankYou
	}: Props = $props();

	const PROCESS_URL = 'https://svg-icon-processor-475432008335.us-central1.run.app/process';

	const CHARM_SVG_CACHE_STORAGE = 'charm-svg-cache';
	const CHARM_SVG_CURRENT_STORAGE = 'charm-svg-current';
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
			const raw = localStorage.getItem(CHARM_SVG_CACHE_STORAGE);
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
			localStorage.setItem(CHARM_SVG_CACHE_STORAGE, JSON.stringify(cache));
		} catch (_) {}
	}

	type CharmSvg =
		| { type: 'url'; url: string; optimizedSvg: string }
		| {
				type: 'upload';
				name: string;
				content: string;
				optimizedSvg: string;
		  };

	function getCurrentCharmSvg(): CharmSvg | null {
		try {
			const raw = localStorage.getItem(CHARM_SVG_CURRENT_STORAGE);
			if (raw) return JSON.parse(raw) as CharmSvg;
		} catch (_) {}
		return null;
	}

	function setCurrentCharmSvg(current: CharmSvg) {
		try {
			localStorage.setItem(CHARM_SVG_CURRENT_STORAGE, JSON.stringify(current));
		} catch (_) {}
	}

	function loadPersistedSvg(): boolean {
		const current = getCurrentCharmSvg();
		if (!current?.optimizedSvg) return false;
		optimizedSvg = current.optimizedSvg;
		if (current.type === 'url') {
			svgUrl = current.url;
			uploadName = current.url;
			sourceSvg = '';
		} else {
			uploadName = current.name;
			sourceSvg = current.content;
			svgUrl = '';
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

	let uploadName = $state('');
	let svgUrl = $state('');
	let sourceSvg = $state('');
	let optimizedSvg = $state('');
	let processError = $state<string | null>(null);
	let processing = $state(false);
	let showSvgInfoModal = $state(true);
	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	const CLIPPER_SCALE = 1000;
	const DETAIL_AREA_RATIO = 0.08;
	let sizeMm = $state(20);
	let thickness = $state(1);
	let baseThickness = $state(9);
	let baseOffsetMm = $state(2);
	let holeDiameter = $state(6);
	let holeFlatTopOffset = $state(0.3);
	let holeOrientation = $state<'horizontal' | 'vertical'>('horizontal');
	let mainColor = $state('#ffffff');
	let baseColor = $state('#ff9e9e');

	let committed = $state({
		sizeMm: 20,
		thickness: 1,
		baseThickness: 9,
		baseOffsetMm: 2,
		holeDiameter: 6,
		holeFlatTopOffset: 0.3,
		holeOrientation: 'horizontal' as 'horizontal' | 'vertical'
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

	async function onSvgSelected(file: File) {
		processError = null;
		exportError = null;
		uploadName = file.name;
		const raw = await file.text();
		sourceSvg = raw;
		await processSvg(raw, file.name);
	}

	async function processSvg(rawSvg: string, uploadFileName?: string) {
		processError = null;
		const cacheKey = 'upload:' + hashString(rawSvg);
		const cached = getOptimizedCache()[cacheKey];
		if (cached) {
			optimizedSvg = cached;
			if (uploadFileName !== undefined) {
				setCurrentCharmSvg({
					type: 'upload',
					name: uploadFileName,
					content: rawSvg,
					optimizedSvg: cached
				});
			}
			return;
		}
		processing = true;
		optimizedSvg = '';
		try {
			const publicUrl = await uploadSvgToSupabase(rawSvg);
			const resp = await fetch(`${PROCESS_URL}?url=${encodeURIComponent(publicUrl)}`);
			if (!resp.ok) {
				const text = await resp.text();
				throw new Error(text || `Processor failed (${resp.status})`);
			}
			const processed = await resp.text();
			if (!processed.trim()) throw new Error('Processor returned empty SVG');
			optimizedSvg = processed;
			setOptimizedCache(cacheKey, processed);
			if (uploadFileName !== undefined) {
				setCurrentCharmSvg({
					type: 'upload',
					name: uploadFileName,
					content: rawSvg,
					optimizedSvg: processed
				});
			}
		} catch (e) {
			processError = e instanceof Error ? e.message : 'Failed to process SVG';
		} finally {
			processing = false;
		}
	}

	async function processSvgFromUrl() {
		const input = svgUrl.trim();
		if (!input) return;
		processError = null;
		exportError = null;
		const cacheKey = 'url:' + hashString(input);
		const cached = getOptimizedCache()[cacheKey];
		if (cached) {
			optimizedSvg = cached;
			uploadName = input;
			setCurrentCharmSvg({
				type: 'url',
				url: input,
				optimizedSvg: cached
			});
			return;
		}
		processing = true;
		optimizedSvg = '';
		try {
			// Download SVG from URL
			const downloadResp = await fetch(input);
			if (!downloadResp.ok) {
				throw new Error(
					`Failed to download SVG (${downloadResp.status}): ${downloadResp.statusText}`
				);
			}
			const rawSvg = await downloadResp.text();
			if (!rawSvg.trim()) throw new Error('URL returned empty content');

			// Upload to Supabase, then run through svg-icon-processor
			const publicUrl = await uploadSvgToSupabase(rawSvg);
			const resp = await fetch(`${PROCESS_URL}?url=${encodeURIComponent(publicUrl)}`);
			if (!resp.ok) {
				const text = await resp.text();
				throw new Error(text || `Processor failed (${resp.status})`);
			}
			const processed = await resp.text();
			if (!processed.trim()) throw new Error('Processor returned empty SVG');
			optimizedSvg = processed;
			uploadName = input;
			setOptimizedCache(cacheKey, processed);
			setCurrentCharmSvg({
				type: 'url',
				url: input,
				optimizedSvg: processed
			});
		} catch (e) {
			processError = e instanceof Error ? e.message : 'Failed to process URL';
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
			processError = 'No extrudable shape found in processed SVG';
			return;
		}
		const divisions = 20;
		const shapeToPaths = (shape: THREE.Shape) => {
			const toPath = (pts: THREE.Vector2[]) => {
				const out: { X: number; Y: number }[] = [];
				for (const p of pts) {
					out.push({
						X: Math.round(p.x * CLIPPER_SCALE),
						Y: Math.round(-p.y * CLIPPER_SCALE)
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
		if (inputPaths.length === 0) {
			processError = 'Processed SVG contains invalid paths';
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
				ClipperLib.PolyFillType.pftNonZero
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

		const topBbox = getTreeBbox(filledTree);
		const maxExtentNorm = Math.max(
			0.001,
			(topBbox.maxX - topBbox.minX) / CLIPPER_SCALE,
			(topBbox.maxY - topBbox.minY) / CLIPPER_SCALE
		);
		const shapeScaleMm = committed.sizeMm / maxExtentNorm;
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
		/** Base: same as top but from offset tree — include holes so base follows logo outline (no disc). */
		const baseShapes = polyTreeToThreeShapes(baseTree, shapeScaleMm);
		if (topShapes.length === 0 || baseShapes.length === 0) {
			processError = 'Failed to build valid base/top shapes';
			return;
		}
		const shapeSignedArea = (pts: THREE.Vector2[]) => {
			if (pts.length < 3) return 0;
			return Math.abs(THREE.ShapeUtils.area(pts));
		};
		const shapeArea = (s: THREE.Shape) => {
			const outer = shapeSignedArea(s.getPoints(48));
			const holes = (s.holes || []).reduce((sum, h) => sum + shapeSignedArea(h.getPoints(48)), 0);
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
			(s) => modelArea > 0 && shapeArea(s) <= modelArea * DETAIL_AREA_RATIO
		);
		const topCenterX = (topBbox.minX + topBbox.maxX) / 2 / CLIPPER_SCALE;
		const topCenterY = (topBbox.minY + topBbox.maxY) / 2 / CLIPPER_SCALE;

		const baseDepth = Math.max(0.2, committed.baseThickness);
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

		const totalHeight = baseDepth + topDepth;
		const holeCenterZ = baseDepth / 2;
		const holeRadius = Math.max(0.5, committed.holeDiameter / 2);
		const holeLength = Math.max(30, 50);
		const flatCeilingZ = holeCenterZ + holeRadius - Math.max(0.1, committed.holeFlatTopOffset);

		const cylinderGeo = new THREE.CylinderGeometry(holeRadius, holeRadius, holeLength, 32);
		const holeHorizontal = committed.holeOrientation === 'horizontal';
		if (holeHorizontal) {
			cylinderGeo.rotateZ(-Math.PI / 2);
		}
		cylinderGeo.translate(0, 0, holeCenterZ);

		const boxHeight = flatCeilingZ + 100;
		const halfSpaceGeo = new THREE.BoxGeometry(
			holeHorizontal ? holeLength + 20 : committed.holeDiameter + 20,
			holeHorizontal ? committed.holeDiameter + 20 : holeLength + 20,
			boxHeight
		);
		halfSpaceGeo.translate(0, 0, (flatCeilingZ - 100) / 2);

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

		// OpenSCAD-style: scale hole slightly larger so CSG result has no coplanar/touching
		// faces at the boundary (avoids non-manifold in slicers/export).
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
			processError = 'Failed to cut cord hole (try different hole size)';
			baseBrush.geometry.dispose();
			topBrush.geometry.dispose();
			holeBrush.geometry.dispose();
			flatTopHoleGeo.dispose();
			holeDummyMat.dispose();
			return;
		}

		// Weld vertices to fix non-manifold edges at hole/base interface (slicers/export)
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

		if (detailShapes.length > 0) {
			const detailDepth = topDepth;
			const detailGeo = new THREE.ExtrudeGeometry(detailShapes, {
				depth: detailDepth,
				bevelEnabled: false,
				curveSegments: 20,
				steps: 1
			});
			detailGeo.scale(1, -1, 1);
			if (!detailGeo.index) {
				const count = detailGeo.attributes.position.count;
				const index = new THREE.BufferAttribute(new Uint32Array(count), 1);
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
				detailGeo.translate(detailCenterX - topCenterX, detailCenterY - topCenterY, 0);
			}
			detailGeo.computeBoundingBox();
			const detailBb = detailGeo.boundingBox!;
			detailGeo.translate(0, 0, -detailBb.min.z);
			const detailMesh = new THREE.Mesh(detailGeo, topMat);
			detailMesh.name = 'detail';
			detailMesh.castShadow = false;
			detailMesh.receiveShadow = false;
			detailMesh.position.z = baseDepth;
			detailMesh.scale.set(shapeScaleMm, shapeScaleMm, 1);
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

	function removeDegenerateTriangles(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
		const pos = geometry.getAttribute('position');
		const triCount = pos.count / 3;
		const vA = new THREE.Vector3();
		const vB = new THREE.Vector3();
		const vC = new THREE.Vector3();
		const eps = 1e-10;
		const keep: number[] = [];
		for (let i = 0; i < triCount; i++) {
			const i0 = i * 3 + 0;
			const i1 = i * 3 + 1;
			const i2 = i * 3 + 2;
			vA.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
			vB.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
			vC.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
			const area = vB.clone().sub(vA).cross(vC.clone().sub(vA)).lengthSq();
			if (area > eps) keep.push(i0, i1, i2);
		}
		if (keep.length === pos.count) return geometry;
		const newPos = new Float32Array(keep.length * 3);
		for (let i = 0; i < keep.length; i++) {
			const j = keep[i];
			newPos[i * 3 + 0] = pos.getX(j);
			newPos[i * 3 + 1] = pos.getY(j);
			newPos[i * 3 + 2] = pos.getZ(j);
		}
		const out = new THREE.BufferGeometry();
		out.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
		const norm = geometry.getAttribute('normal');
		if (norm) {
			const newNorm = new Float32Array(keep.length * 3);
			for (let i = 0; i < keep.length; i++) {
				const j = keep[i];
				newNorm[i * 3 + 0] = norm.getX(j);
				newNorm[i * 3 + 1] = norm.getY(j);
				newNorm[i * 3 + 2] = norm.getZ(j);
			}
			out.setAttribute('normal', new THREE.BufferAttribute(newNorm, 3));
		}
		geometry.dispose();
		return out;
	}

	/** Build a single normalized SVG for OpenSCAD: one shape, centered, max extent = sizeMm (mm). So OpenSCAD only sees one shape at correct size; we use offset(delta) only, no scale. */
	function buildNormalizedSvgForOpenScad(svg: string): string | null {
		if (!svg.trim()) return null;
		const loader = new SVGLoader();
		const parsed = loader.parse(svg);
		const shapes: THREE.Shape[] = [];
		for (const p of parsed.paths) {
			const pShapes = SVGLoader.createShapes(p);
			for (const s of pShapes) shapes.push(s);
		}
		if (shapes.length === 0) return null;
		const divisions = 20;
		const shapeToPaths = (shape: THREE.Shape) => {
			const toPath = (pts: THREE.Vector2[]) => {
				const out: { X: number; Y: number }[] = [];
				for (const p of pts) {
					out.push({
						X: Math.round(p.x * CLIPPER_SCALE),
						Y: Math.round(-p.y * CLIPPER_SCALE)
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
		const shapeScaleMm = committed.sizeMm / maxExtentNorm;
		const cx = ((topBbox.minX + topBbox.maxX) / 2 / CLIPPER_SCALE) * shapeScaleMm;
		const cy = ((topBbox.minY + topBbox.maxY) / 2 / CLIPPER_SCALE) * shapeScaleMm;
		const half = committed.sizeMm / 2;
		// Use 0-based viewBox so OpenSCAD doesn't shift; we center in script with translate(-size_mm/2, -size_mm/2).
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
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${committed.sizeMm} ${committed.sizeMm}"><path fill-rule="evenodd" d="${pathParts.join(' ')}" fill="black"/></svg>`;
	}

	/** OpenSCAD script: import normalized SVG (single shape, mm), offset(delta) only, linear_extrude, then subtract flat-top hole. */
	function getCharmBaseOpenScadScript(params: {
		sizeMm: number;
		baseThickness: number;
		baseOffsetMm: number;
		holeDiameter: number;
		holeFlatTopOffset: number;
		holeAlongX: boolean;
	}): string {
		const { sizeMm, baseThickness, baseOffsetMm, holeDiameter, holeFlatTopOffset, holeAlongX } =
			params;
		const holeR = Math.max(0.25, holeDiameter / 2);
		const holeLength = 200;
		const flatCeilingOffset = Math.max(0.01, Math.min(holeR, holeFlatTopOffset));
		return `
$fn = 64;
size_mm = ${sizeMm};
base_thickness = ${baseThickness};
base_offset_mm = ${baseOffsetMm};
hole_diameter = ${holeDiameter};
hole_length = ${holeLength};
hole_flat_ceiling_offset = ${flatCeilingOffset};
hole_along_x = ${holeAlongX ? 'true' : 'false'};

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
      cube([hole_length + 20, hole_diameter + 20, flat_ceiling_z + 100], center = true);
    }
  }
}

difference() {
  base_shape();
  flat_top_hole();
}
`;
	}

	/** Build base via OpenSCAD: import normalized SVG, offset, extrude, subtract hole. */
	async function buildOpenScadBaseGeometry(): Promise<THREE.BufferGeometry> {
		const normalizedSvg = buildNormalizedSvgForOpenScad(optimizedSvg);
		if (!normalizedSvg) throw new Error('Could not build base shape from SVG');
		const baseThickness = Math.max(0.2, committed.baseThickness);
		const baseOffsetMm = Math.max(0, committed.baseOffsetMm);
		const holeDiameter = Math.max(0.5, committed.holeDiameter);
		const holeFlatTopOffset = Math.max(0, committed.holeFlatTopOffset);
		const holeAlongX = committed.holeOrientation === 'horizontal';
		const source = getCharmBaseOpenScadScript({
			sizeMm: committed.sizeMm,
			baseThickness,
			baseOffsetMm,
			holeDiameter,
			holeFlatTopOffset,
			holeAlongX
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
		if (!licenseStatus?.canExport || !licenseStatus?.isPaid) {
			licenseModalRef?.open();
			return;
		}
		if (!optimizedSvg?.trim()) {
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

			let baseName = 'charm';
			if (svgUrl.trim() !== '') {
				try {
					const parsed = new URL(svgUrl.trim());
					const path = decodeURIComponent(parsed.pathname);
					const lastSegment = path.split('/').filter(Boolean).pop() ?? '';
					if (lastSegment) {
						baseName = lastSegment
							.toLowerCase()
							.replace(/\.svg$/i, '')
							.replace(/[:]+/g, '-')
							.replace(/[^a-z0-9-]+/g, '-')
							.replace(/(^-|-$)/g, '');
					}
				} catch {
					// Fallback to uploadName below if URL parsing fails
				}
			}
			if (baseName === 'charm' && uploadName) {
				baseName = uploadName
					.toLowerCase()
					.replace(/\.svg$/i, '')
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/(^-|-$)/g, '');
			}

			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${baseName || 'charm'}-${ts}.stl`, blob);
			if (licenseStatus?.type === 'trial') onShowThankYou();
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
		if (!licenseStatus?.canExport || !licenseStatus?.isPaid) {
			licenseModalRef?.open();
			return;
		}
		if (!optimizedSvg?.trim()) {
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
			let baseName = 'charm';
			if (svgUrl.trim() !== '') {
				try {
					const parsed = new URL(svgUrl.trim());
					const path = decodeURIComponent(parsed.pathname);
					const lastSegment = path.split('/').filter(Boolean).pop() ?? '';
					if (lastSegment) {
						baseName = lastSegment
							.toLowerCase()
							.replace(/\.svg$/i, '')
							.replace(/[:]+/g, '-')
							.replace(/[^a-z0-9-]+/g, '-')
							.replace(/(^-|-$)/g, '');
					}
				} catch {
					// use default baseName
				}
			}
			if (baseName === 'charm' && uploadName) {
				baseName = uploadName
					.toLowerCase()
					.replace(/\.svg$/i, '')
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/(^-|-$)/g, '');
			}
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${baseName || 'charm'}-${ts}.3mf`, blob);
			if (licenseStatus?.type === 'trial') onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	let copyTimeoutId: ReturnType<typeof setTimeout> | null = null;
	let prevOptimizedSvg = '';
	const COMMIT_DEBOUNCE_MS = 350;

	$effect(() => {
		void optimizedSvg;
		void sizeMm;
		void thickness;
		void baseThickness;
		void baseOffsetMm;
		void holeDiameter;
		void holeFlatTopOffset;
		void holeOrientation;

		const sync = () => {
			committed = {
				sizeMm,
				thickness,
				baseThickness,
				baseOffsetMm,
				holeDiameter,
				holeFlatTopOffset,
				holeOrientation
			};
		};

		if (optimizedSvg !== prevOptimizedSvg) {
			prevOptimizedSvg = optimizedSvg;
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

	$effect(() => {
		void optimizedSvg;
		void committed.sizeMm;
		void committed.thickness;
		void committed.baseThickness;
		void committed.baseOffsetMm;
		void committed.holeDiameter;
		void committed.holeFlatTopOffset;
		void committed.holeOrientation;
		if (!scene || !group) return;
		rebuildMeshes();
	});

	// Color-only updates should not trigger an expensive rebuild.
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
		loadPersistedSvg();
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

		const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
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
	});
</script>

<main class="h-dvh w-dvw bg-slate-100 p-4">
	<div class="flex h-full min-h-0 gap-4">
		<aside
			class="flex min-h-0 w-full max-w-[360px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Chunky Charm</h1>
				<button
					type="button"
					class="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
					onclick={onBack}
				>
					Back
				</button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4 pt-0">
				<p class="text-xs text-slate-500">
					Some SVGs may produce unexpected results depending on complexity and structure.
				</p>
				<div>
					<label for="charm-svg-url-input" class="mb-1 block text-xs font-medium text-slate-700">
						SVG URL
					</label>
					<div class="flex items-center gap-2">
						<input
							id="charm-svg-url-input"
							type="url"
							placeholder="https://..."
							class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
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
					<label for="charm-svg-upload-input" class="mb-1 block text-xs font-medium text-slate-700">
						Upload SVG
					</label>
					<input
						id="charm-svg-upload-input"
						type="file"
						accept=".svg,image/svg+xml"
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
						onchange={(e) => {
							const input = e.currentTarget as HTMLInputElement;
							const file = input.files?.[0];
							if (file) void onSvgSelected(file);
						}}
					/>
					{#if uploadName}
						<p class="mt-1 truncate text-xs text-slate-500">
							{uploadName}
						</p>
					{/if}
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="charm-size" class="text-xs font-medium text-slate-700">Size (width)</label>
						<span class="text-xs text-slate-500">{sizeMm.toFixed(0)} mm</span>
					</div>
					<input
						id="charm-size"
						type="range"
						min="5"
						max="100"
						step="1"
						bind:value={sizeMm}
						class="w-full"
						disabled={!optimizedSvg || processing}
					/>
					<p class="mt-0.5 text-[10px] text-slate-400">Width and height only; depth unchanged.</p>
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="charm-thickness" class="text-xs font-medium text-slate-700"
							>Top thickness</label
						>
						<span class="text-xs text-slate-500">{thickness.toFixed(1)} mm</span>
					</div>
					<input
						id="charm-thickness"
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
						<label for="charm-base-thickness" class="text-xs font-medium text-slate-700"
							>Base thickness</label
						>
						<span class="text-xs text-slate-500">{baseThickness.toFixed(1)} mm</span>
					</div>
					<input
						id="charm-base-thickness"
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
						<label for="charm-base-offset" class="text-xs font-medium text-slate-700"
							>Outline width</label
						>
						<span class="text-xs text-slate-500">{baseOffsetMm.toFixed(2)} mm</span>
					</div>
					<input
						id="charm-base-offset"
						type="range"
						min="0"
						max="10"
						step="0.1"
						bind:value={baseOffsetMm}
						class="w-full"
						disabled={!optimizedSvg || processing}
					/>
				</div>

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Cord hole</div>
					<div class="flex items-center gap-3">
						<span class="text-xs font-medium text-slate-700">Orientation</span>
						<label class="flex cursor-pointer items-center gap-1.5">
							<input
								type="radio"
								name="hole-orientation"
								value="horizontal"
								bind:group={holeOrientation}
							/>
							<span class="text-xs text-slate-700">Horizontal</span>
						</label>
						<label class="flex cursor-pointer items-center gap-1.5">
							<input
								type="radio"
								name="hole-orientation"
								value="vertical"
								bind:group={holeOrientation}
							/>
							<span class="text-xs text-slate-700">Vertical</span>
						</label>
					</div>
					<div>
						<div class="mb-1 flex items-center justify-between">
							<label for="charm-hole-diameter" class="text-xs font-medium text-slate-700"
								>Diameter (mm)</label
							>
							<span class="text-xs text-slate-500">{holeDiameter.toFixed(1)}</span>
						</div>
						<input
							id="charm-hole-diameter"
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
							<label for="charm-hole-flat" class="text-xs font-medium text-slate-700"
								>Flat top (mm)</label
							>
							<span class="text-xs text-slate-500">{holeFlatTopOffset.toFixed(2)}</span>
						</div>
						<input
							id="charm-hole-flat"
							class="w-full accent-indigo-500"
							type="range"
							min="0.1"
							max="2"
							step="0.05"
							bind:value={holeFlatTopOffset}
							disabled={!optimizedSvg || processing}
						/>
						<p class="mt-0.5 text-[10px] text-slate-400">
							Flat ceiling = bridge (easier to print, no overhang).
						</p>
					</div>
				</div>

				<div class="grid grid-cols-2 gap-3">
					<label class="grid gap-1.5" for="charm-main-color-text">
						<span class="text-xs font-medium text-slate-700">Top color</span>
						<div class="flex items-center gap-2">
							<input
								id="charm-main-color"
								class="h-10 w-10 rounded-xl"
								type="color"
								bind:value={mainColor}
								disabled={!optimizedSvg || processing}
							/>
							<input
								id="charm-main-color-text"
								class="w-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
								type="text"
								bind:value={mainColor}
								disabled={!optimizedSvg || processing}
							/>
						</div>
					</label>
					<label class="grid gap-1.5" for="charm-base-color-text">
						<span class="text-xs font-medium text-slate-700">Base color</span>
						<div class="flex items-center gap-2">
							<input
								id="charm-base-color"
								class="h-10 w-10 rounded-xl"
								type="color"
								bind:value={baseColor}
								disabled={!optimizedSvg || processing}
							/>
							<input
								id="charm-base-color-text"
								class="w-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
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
			<div class="absolute right-4 bottom-4">
				<DesignerExportToolbar
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'charm-designer')}
					onExport={exportStl}
					onExport3MF={export3MF}
					exportDisabled={!optimizedSvg ||
						processing ||
						exportLoading ||
						!user ||
						licenseStatus?.canExport === false ||
						licenseStatus?.isPaid === false}
					exportTitle={!user
						? 'Sign in to export'
						: licenseStatus?.canExport === false
							? 'License required to export'
							: licenseStatus?.isPaid === false
								? 'Paid license required to export'
								: 'Export STL or 3MF (multipart) for 3D print'}
					{exportLoading}
					showLockIcon={!user ||
						licenseStatus?.canExport === false ||
						licenseStatus?.isPaid === false}
				/>
			</div>
		</section>
	</div>

	<SvgInfoModal open={showSvgInfoModal} onClose={() => (showSvgInfoModal = false)} />
	<LoadingModal
		open={processing}
		title="Processing SVG"
		description="Preparing your design for the 3D preview…"
		titleId="charm-processing-loading-title"
	/>
	<LoadingModal
		open={exportLoading}
		title="Exporting STL"
		description="Preparing your 3D model… This usually takes a few seconds."
		titleId="charm-export-loading-title"
	/>
</main>
