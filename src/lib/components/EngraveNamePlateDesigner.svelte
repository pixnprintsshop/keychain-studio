<script lang="ts">
	/* eslint-disable @typescript-eslint/no-explicit-any -- Clipper PolyTree nodes are untyped */
	import type { Session, User } from '@supabase/supabase-js';
	import ClipperLib from 'clipper-lib';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import FontSelect from '$lib/components/FontSelect.svelte';
	import {
		buildEngravePlateOpenScadBufferGeometry,
		type EngravePlateOpenScadParams
	} from '$lib/engrave-plate-openscad';
	import {
		centerGeometryXY,
		type CharSettings,
		DEFAULT_CHAR_SETTINGS,
		DEFAULT_FONT_KEY_OUTLINE,
		DEFAULT_FONT_SETTINGS_OUTLINE,
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
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { warmupOpenScadWorker } from '$lib/openscad';
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

	/* eslint-disable @typescript-eslint/no-unused-vars -- session/onRequestLogin match App parity */
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
	/* eslint-enable @typescript-eslint/no-unused-vars */

	interface EngraveFontSettings extends FontSettings {
		tolerance?: number;
		pocketDepth?: number;
		/** Z depth of the optional insert piece (mm), capped to fit the pocket. */
		mainTextThicknessMm?: number;
		/** Separate solid text piece to print and press into the pocket (shown offset in 3D for clarity). */
		includeSlotInsert?: boolean;
		insertTextColor?: string;
	}

	const STORAGE_KEY_SETTINGS = 'keychain-engrave-plate-font-settings';
	const STORAGE_KEY_KEYRING = 'keychain-engrave-plate-keyring-settings';
	const STORAGE_KEY_TEXT = 'keychain-engrave-plate-text';
	const STORAGE_KEY_FONT = 'keychain-engrave-plate-font';

	const POCKET_FLOOR_MM = 1;
	/** Weld nearly-coincident verts before CSG so extrusions are watertight for three-bvh-csg. */
	const CSG_VERTEX_MERGE_EPS = 1e-4;
	/** Higher than the plate: pocket cutouts use letter holes; smoother curves reduce CSG artifacts. */
	const CUTOUT_CURVE_SEGMENTS = 12;
	/** Lower = faster Clipper / extrude; 12 is enough for keychain-scale preview. */
	const DIVISIONS = 12;
	const CURVE_SEGMENTS = 8;
	const KEYRING_CIRCLE_SEGS = 40;
	const INSERT_PREVIEW_GAP_MM = 14;
	const INSERT_DEPTH_CLEAR_MM = 0.25;

	function prepareGeometryForCsg(geo: THREE.BufferGeometry) {
		geo.clearGroups();
		geo.setDrawRange(0, Infinity);
		BufferGeometryUtils.mergeVertices(geo, CSG_VERTEX_MERGE_EPS);
		geo.computeVertexNormals();
	}

	const engraveDefaults: EngraveFontSettings = {
		...DEFAULT_FONT_SETTINGS_OUTLINE,
		tolerance: 0.3,
		pocketDepth: 4,
		mainTextThicknessMm: 3.5,
		includeSlotInsert: false,
		insertTextColor: DEFAULT_FONT_SETTINGS_OUTLINE.textColor
	};

	let allFontSettings: Record<string, EngraveFontSettings> = (() => {
		const base = loadFontSettingsFromStorage(STORAGE_KEY_SETTINGS) as Record<
			string,
			EngraveFontSettings
		>;
		const out: Record<string, EngraveFontSettings> = {};
		for (const [k, v] of Object.entries(base)) {
			out[k] = { ...engraveDefaults, ...v };
		}
		return out;
	})();
	let allCharSettings: Record<string, Record<string, CharSettings>> = loadCharSettingsFromStorage(
		STORAGE_KEY_KEYRING
	);
	let isUpdatingFromStorage = $state(true);
	let lastFont = '';
	let lastChar = '';

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
			return f && FONT_OPTIONS.some((o) => o.key === f) ? f : DEFAULT_FONT_KEY_OUTLINE;
		} catch {
			return DEFAULT_FONT_KEY_OUTLINE;
		}
	})();

	const fontSettings = allFontSettings[restoredFont] || engraveDefaults;
	const initialChar = restoredText.length > 0 ? restoredText.charAt(0).toUpperCase() : '';
	const charSettings = allCharSettings[restoredFont]?.[initialChar] || DEFAULT_CHAR_SETTINGS;

	let text = $state(restoredText);
	let textSize = $state(fontSettings.textSize);
	let outlineOffsetPx = $state(fontSettings.outlineOffsetPx);
	let baseDepth = $state(fontSettings.baseDepth);
	let outlineColor = $state(fontSettings.outlineColor);
	let fontKey = $state(restoredFont);
	let keyringEnabled = $state(fontSettings.keyringEnabled ?? true);
	let keyringOuterSize = $state(charSettings.keyringOuterSize);
	let keyringHoleSize = $state(charSettings.keyringHoleSize);
	let keyringOffsetX = $state(charSettings.keyringOffsetX);
	let keyringOffsetY = $state(charSettings.keyringOffsetY);
	let tolerance = $state(fontSettings.tolerance ?? 0.3);
	let pocketDepth = $state(fontSettings.pocketDepth ?? 4);
	let mainTextThicknessMm = $state(
		fontSettings.mainTextThicknessMm ?? engraveDefaults.mainTextThicknessMm ?? 3.5
	);
	const maxMainTextThicknessMm = $derived(
		Math.max(0.2, pocketDepth - INSERT_DEPTH_CLEAR_MM - 0.01)
	);
	let includeSlotInsert = $state(fontSettings.includeSlotInsert ?? false);
	let insertTextColor = $state(
		fontSettings.insertTextColor ?? DEFAULT_FONT_SETTINGS_OUTLINE.textColor
	);

	lastFont = restoredFont;
	lastChar = initialChar;

	let hostEl: HTMLDivElement | null = null;
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let controls: InstanceType<typeof OrbitControls> | null = null;
	let font: ReturnType<typeof getFont> | null = null;
	let group: THREE.Group | null = null;
	let keyLight: THREE.DirectionalLight | null = null;
	let shadowPlane: THREE.Mesh | null = null;
	let rafId = 0;
	let ro: ResizeObserver | null = null;
	/** Set true after scene/group/renderer exist so `$effect` can rebuild (plain `scene` is not reactive). */
	let sceneReady = $state(false);
	/** Plain `let` (not `$state`): rebuild `$effect` touches this; reactive `$state` would infinite-loop with `rebuildMeshes()`. */
	let didInitFrame = false;
	let openBambuStudioLoading = $state(false);
	/** STL / 3MF (and Bambu pre-upload) in progress — keeps toolbar responsive while WASM runs in a worker. */
	let exportLoading = $state(false);
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);
	/** First idle build finished — same idea as NamePuzzleDesigner. */
	let isReady = $state(false);
	/** Heavy Clipper + CSG rebuild in progress (debounced). */
	let sceneLoading = $state(false);

	let rebuildTimeoutId: ReturnType<typeof setTimeout> | null = null;
	const REBUILD_DEBOUNCE_MS = 350;

	function getCurrentChar(): string {
		return text.length > 0 ? text.charAt(0).toUpperCase() : '';
	}

	function loadSettingsForFont(fontName: string) {
		if (!allFontSettings[fontName]) allFontSettings[fontName] = { ...engraveDefaults };
		const s = allFontSettings[fontName];
		textSize = s.textSize;
		outlineOffsetPx = s.outlineOffsetPx;
		baseDepth = s.baseDepth;
		outlineColor = s.outlineColor;
		if (s.keyringEnabled !== undefined) keyringEnabled = s.keyringEnabled;
		if (s.tolerance !== undefined) tolerance = s.tolerance;
		if (s.pocketDepth !== undefined) pocketDepth = s.pocketDepth;
		if (s.mainTextThicknessMm !== undefined) mainTextThicknessMm = s.mainTextThicknessMm;
		if (s.includeSlotInsert !== undefined) includeSlotInsert = s.includeSlotInsert;
		if (s.insertTextColor) insertTextColor = s.insertTextColor;
	}

	function saveSettingsForFont(fontName: string) {
		if (isUpdatingFromStorage || !fontName) return;
		allFontSettings[fontName] = {
			textSize,
			outlineOffsetPx,
			baseDepth,
			textDepth: mainTextThicknessMm,
			textColor: outlineColor,
			outlineColor,
			keyringEnabled,
			tolerance,
			pocketDepth,
			mainTextThicknessMm,
			includeSlotInsert,
			insertTextColor
		};
		try {
			localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(allFontSettings));
		} catch (e) {
			console.error('Failed to save engrave plate settings:', e);
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
		if (!allCharSettings[fontName]) allCharSettings[fontName] = {};
		allCharSettings[fontName][char] = {
			keyringOffsetX,
			keyringOffsetY,
			keyringOuterSize,
			keyringHoleSize
		};
		try {
			localStorage.setItem(STORAGE_KEY_KEYRING, JSON.stringify(allCharSettings));
		} catch (e) {
			console.error('Failed to save keyring settings:', e);
		}
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
		if (!scene || !group || !font) return;
		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		modelAabbMm = null;

		try {
		const size = Math.max(1, Math.round(textSize));
		const SCALE = 1000;
		const content = (text || ' ').trim() || ' ';

		let shapes: THREE.Shape[];
		try {
			shapes = font.generateShapes(content, size);
		} catch {
			return;
		}
		if (!shapes?.length) return;

		const shapeToPaths = (shape: THREE.Shape) => {
			const toPath = (pts: THREE.Vector2[]) => {
				const out: { X: number; Y: number }[] = [];
				for (const p of pts) out.push({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) });
				if (out.length > 2) {
					const a = out[0];
					const b = out[out.length - 1];
					if (a.X === b.X && a.Y === b.Y) out.pop();
				}
				return out;
			};
			const outer = toPath(shape.getPoints(DIVISIONS));
			const holes = (shape.holes || []).map((h) => toPath(h.getPoints(DIVISIONS)));
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

		const outlineWorld = Math.max(0, outlineOffsetPx) * (size / 60);
		const outlineTree = new ClipperLib.PolyTree();
		if (outlineWorld > 0) {
			const co = new ClipperLib.ClipperOffset(2, 2);
			co.AddPaths(inputPaths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
			const offsetPaths: { X: number; Y: number }[][] = [];
			co.Execute(offsetPaths, outlineWorld * SCALE);
			const c2 = new ClipperLib.Clipper();
			c2.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
			c2.Execute(
				ClipperLib.ClipType.ctUnion,
				outlineTree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
		} else {
			const c2 = new ClipperLib.Clipper();
			c2.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
			c2.Execute(
				ClipperLib.ClipType.ctUnion,
				outlineTree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
		}

		let baseTree: any = outlineTree;
		let outlineCenter: { x: number; y: number } | null = null;
		let combinedCenter: { x: number; y: number } | null = null;

		if (keyringEnabled) {
			const circleToPath = (
				cx: number,
				cy: number,
				r: number,
				clockwise: boolean,
				segs = KEYRING_CIRCLE_SEGS
			) => {
				const path: { X: number; Y: number }[] = [];
				for (let i = 0; i < segs; i++) {
					const t = (i / segs) * Math.PI * 2;
					path.push({
						X: Math.round((cx + r * Math.cos(t)) * SCALE),
						Y: Math.round((cy + r * Math.sin(t)) * SCALE)
					});
				}
				if (path.length < 3) return null;
				const isCW = ClipperLib.Clipper.Orientation(path);
				if (isCW !== clockwise) path.reverse();
				return path;
			};
			const collectOuterPaths = (node: any, out: { X: number; Y: number }[][]) => {
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
			const bbox = getTreeBbox(outlineTree);
			outlineCenter = {
				x: (bbox.minX + bbox.maxX) / 2 / SCALE,
				y: (bbox.minY + bbox.maxY) / 2 / SCALE
			};
			const cornerX = bbox.minX / SCALE;
			const cornerY = bbox.maxY / SCALE;
			const kx = cornerX + keyringOffsetX;
			const ky = cornerY + keyringOffsetY;
			const outerR = Math.max(0.1, keyringOuterSize / 2);
			const innerR = Math.min(Math.max(0.05, keyringHoleSize / 2), outerR - 0.1);
			const outerCircle = circleToPath(kx, ky, outerR, true);
			const innerCircle = circleToPath(kx, ky, innerR, false);
			if (outerCircle && innerCircle) {
				const outlinePaths: { X: number; Y: number }[][] = [];
				const roots = outlineTree.Childs?.() ?? outlineTree.m_Childs ?? [];
				roots.forEach((n: any) => collectOuterPaths(n, outlinePaths));
				const unionTree = new ClipperLib.PolyTree();
				const unionC = new ClipperLib.Clipper();
				outlinePaths.forEach((p) => unionC.AddPath(p, ClipperLib.PolyType.ptSubject, true));
				unionC.AddPath(outerCircle, ClipperLib.PolyType.ptSubject, true);
				unionC.Execute(
					ClipperLib.ClipType.ctUnion,
					unionTree,
					ClipperLib.PolyFillType.pftNonZero,
					ClipperLib.PolyFillType.pftNonZero
				);
				const diffTree = new ClipperLib.PolyTree();
				const diffPaths: { X: number; Y: number }[][] = [];
				const unionRoots = unionTree.Childs?.() ?? unionTree.m_Childs ?? [];
				unionRoots.forEach((n: any) => collectOuterPaths(n, diffPaths));
				const diffC = new ClipperLib.Clipper();
				diffPaths.forEach((p) => diffC.AddPath(p, ClipperLib.PolyType.ptSubject, true));
				diffC.AddPath(innerCircle, ClipperLib.PolyType.ptClip, true);
				diffC.Execute(
					ClipperLib.ClipType.ctDifference,
					diffTree,
					ClipperLib.PolyFillType.pftNonZero,
					ClipperLib.PolyFillType.pftNonZero
				);
				baseTree = diffTree;
				const baseBbox = getTreeBbox(baseTree);
				combinedCenter = {
					x: (baseBbox.minX + baseBbox.maxX) / 2 / SCALE,
					y: (baseBbox.minY + baseBbox.maxY) / 2 / SCALE
				};
			}
		}

		const polyTreeToThreeShapes = (tree: any) => {
			const shapesOut: THREE.Shape[] = [];
			const toVec2 = (pt: any) => new THREE.Vector2(pt.X / SCALE, pt.Y / SCALE);
			const buildFromOuter = (outerNode: any): THREE.Shape | null => {
				const contour = outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
				if (contour.length < 3) return null;
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
					const holeKids = ch.Childs?.() ?? ch.m_Childs ?? [];
					for (const hk of holeKids) {
						const hkIsHole = hk.IsHole?.() ?? hk.m_IsHole;
						if (!hkIsHole) {
							const inner = buildFromOuter(hk);
							if (inner) shapesOut.push(inner);
						}
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

		const baseShapes = polyTreeToThreeShapes(baseTree);
		if (baseShapes.length === 0) return;

		const baseMat = new THREE.MeshStandardMaterial({
			color: outlineColor,
			roughness: 0.85,
			metalness: 0.05
		});

		const baseDepthVal = Math.max(0.1, baseDepth);

		const buildBaseGeo = () => {
			const geo = new THREE.ExtrudeGeometry(baseShapes, {
				depth: baseDepthVal,
				bevelEnabled: false,
				curveSegments: CURVE_SEGMENTS
			});
			centerGeometryXY(geo);
			if (outlineCenter && combinedCenter) {
				geo.translate(combinedCenter.x - outlineCenter.x, combinedCenter.y - outlineCenter.y, 0);
			}
			return geo;
		};

		/** Engraved pocket: letter paths (outers + holes, same as plate) + tolerance offset → cutout, CSG subtract */
		{
			/** Same winding/structure as `inputPaths` — keeps counters (O, A, B, …) open in pocket and insert. */
			const letterPaths = inputPaths;
			if (letterPaths.length === 0) return;

			const cutoutTree = new ClipperLib.PolyTree();
			const tol = Math.max(0, tolerance) * SCALE;
			if (tol > 0) {
				const co = new ClipperLib.ClipperOffset(2, 2);
				co.AddPaths(letterPaths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
				const offsetPaths: { X: number; Y: number }[][] = [];
				co.Execute(offsetPaths, tol);
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
				c2.AddPaths(letterPaths, ClipperLib.PolyType.ptSubject, true);
				c2.Execute(
					ClipperLib.ClipType.ctUnion,
					cutoutTree,
					ClipperLib.PolyFillType.pftNonZero,
					ClipperLib.PolyFillType.pftNonZero
				);
			}

			const cutoutShapeList = polyTreeToThreeShapes(cutoutTree);
			if (cutoutShapeList.length === 0) return;

			const maxPocket = Math.max(0.2, baseDepthVal - POCKET_FLOOR_MM - 0.05);
			const pocketD = Math.min(Math.max(0.2, pocketDepth), maxPocket);

			let baseGeo = buildBaseGeo();
			const cutoutGeo = new THREE.ExtrudeGeometry(cutoutShapeList, {
				depth: pocketD + 0.02,
				bevelEnabled: false,
				curveSegments: CUTOUT_CURVE_SEGMENTS,
				steps: 1
			});
			centerGeometryXY(cutoutGeo);
			baseGeo.computeBoundingBox();
			const baseBb = baseGeo.boundingBox!;
			cutoutGeo.translate(0, 0, -baseBb.min.z + baseDepthVal - pocketD);

			const baseForCsg = baseGeo.clone();
			prepareGeometryForCsg(baseForCsg);
			prepareGeometryForCsg(cutoutGeo);

			const dummyMat = new THREE.MeshBasicMaterial({ color: 0x808080 });
			const cutoutBrush = new Brush(cutoutGeo, dummyMat);
			const baseBrush = new Brush(baseForCsg, baseMat);
			baseBrush.updateMatrixWorld(true);
			cutoutBrush.updateMatrixWorld(true);
			const resultBase = new Brush(new THREE.BufferGeometry(), baseMat);
			const evaluator = new Evaluator();
			evaluator.useGroups = false;
			try {
				evaluator.evaluate(baseBrush, cutoutBrush, SUBTRACTION, resultBase);
			} catch (err) {
				console.error('Engrave plate CSG failed:', err);
				baseBrush.geometry.dispose();
				cutoutBrush.geometry.dispose();
				baseGeo.dispose();
				cutoutGeo.dispose();
				dummyMat.dispose();
				return;
			}
			baseBrush.geometry.dispose();
			cutoutBrush.geometry.dispose();
			baseGeo.dispose();
			cutoutGeo.dispose();
			dummyMat.dispose();

			const welded = BufferGeometryUtils.mergeVertices(resultBase.geometry.clone(), 1e-4);
			resultBase.geometry.dispose();
			const baseMesh = new THREE.Mesh(welded, baseMat);
			baseMesh.name = 'base';
			baseMesh.castShadow = true;
			baseMesh.receiveShadow = true;
			group.add(baseMesh);

			if (includeSlotInsert && letterPaths.length > 0) {
				const insertUnionTree = new ClipperLib.PolyTree();
				const iu = new ClipperLib.Clipper();
				iu.AddPaths(letterPaths, ClipperLib.PolyType.ptSubject, true);
				iu.Execute(
					ClipperLib.ClipType.ctUnion,
					insertUnionTree,
					ClipperLib.PolyFillType.pftNonZero,
					ClipperLib.PolyFillType.pftNonZero
				);
				const insertShapeList = polyTreeToThreeShapes(insertUnionTree);
				if (insertShapeList.length > 0) {
					const insertGeo = new THREE.ExtrudeGeometry(insertShapeList, {
						depth: mainTextThicknessMm,
						bevelEnabled: false,
						curveSegments: CURVE_SEGMENTS,
						steps: 1
					});
					centerGeometryXY(insertGeo);
					const insertMat = new THREE.MeshStandardMaterial({
						color: insertTextColor,
						roughness: 0.45,
						metalness: 0.08
					});
					const insertMesh = new THREE.Mesh(insertGeo, insertMat);
					insertMesh.name = 'insert';
					insertMesh.castShadow = true;
					insertMesh.receiveShadow = true;
					baseMesh.updateMatrixWorld(true);
					const plateBox = new THREE.Box3().setFromObject(baseMesh);
					insertGeo.computeBoundingBox();
					const ibb = insertGeo.boundingBox!;
					const insertHalfX = (ibb.max.x - ibb.min.x) / 2;
					const plateCy = (plateBox.min.y + plateBox.max.y) / 2;
					insertMesh.position.set(
						plateBox.max.x + INSERT_PREVIEW_GAP_MM + insertHalfX,
						plateCy,
						plateBox.min.z
					);
					group.add(insertMesh);
				}
			}
		}

		group.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(group);
		/** Insert is offset for preview; don't let it expand the shadow frustum or the map looks blocky on the plate. */
		const shadowBounds = new THREE.Box3();
		for (const c of group.children) {
			if (c.name === 'base') shadowBounds.union(new THREE.Box3().setFromObject(c));
		}
		const shadowBox = shadowBounds.isEmpty() ? box : shadowBounds;
		if (!shadowBox.isEmpty() && keyLight?.shadow?.camera) {
			const sizeVec = new THREE.Vector3();
			shadowBox.getSize(sizeVec);
			const center = new THREE.Vector3();
			shadowBox.getCenter(center);
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
		if (!didInitFrame && camera && controls && !box.isEmpty()) {
			frameCameraToObject(box, camera, controls);
			didInitFrame = true;
		}
		{
			// HUD: plate only — omit offset insert preview so dimensions match the export plate.
			const plate = group.getObjectByName('base');
			const s = plate ? measureWorldAabbSizeMm(plate) : null;
			modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
		}
		} catch (err) {
			console.error('Engrave plate rebuild failed:', err);
			modelAabbMm = null;
		}
	}

	function engraveOpenScadParams(): EngravePlateOpenScadParams {
		return {
			fontKey,
			text,
			textSize,
			outlineOffsetPx,
			tolerance,
			pocketDepth,
			baseDepth,
			keyringEnabled,
			keyringOuterSize,
			keyringHoleSize,
			keyringOffsetX,
			keyringOffsetY
		};
	}

	/**
	 * Plate from OpenSCAD (manifold); optional insert cloned from preview.
	 * Root must be a Scene (meshes as direct children): three-3mf-exporter wraps a root Group as one assembly;
	 * a Scene yields one 3MF build item per mesh for separate objects in Bambu/Orca.
	 */
	async function buildEngraveExportRootForMultipart(): Promise<THREE.Scene> {
		if (!font) throw new Error('Font not loaded');
		const plateGeo = await buildEngravePlateOpenScadBufferGeometry(font, engraveOpenScadParams());
		const baseMat = new THREE.MeshStandardMaterial({
			color: new THREE.Color(outlineColor),
			roughness: 0.85,
			metalness: 0.05
		});
		const plateMesh = new THREE.Mesh(plateGeo, baseMat);
		plateMesh.name = 'base';
		const exportRoot = new THREE.Scene();
		exportRoot.name = 'engrave-3mf-export';
		exportRoot.add(plateMesh);
		if (group) {
			const insertSrc = group.getObjectByName('insert');
			if (insertSrc && (insertSrc as THREE.Mesh).isMesh) {
				const src = insertSrc as THREE.Mesh;
				const insertGeo = src.geometry.clone();
				const insertMat = new THREE.MeshStandardMaterial({
					color: new THREE.Color(insertTextColor),
					roughness: 0.45,
					metalness: 0.08
				});
				const insertMesh = new THREE.Mesh(insertGeo, insertMat);
				insertMesh.name = 'insert';
				insertMesh.position.copy(src.position);
				insertMesh.quaternion.copy(src.quaternion);
				insertMesh.scale.copy(src.scale);
				exportRoot.add(insertMesh);
			}
		}
		exportRoot.updateWorldMatrix(true, true);
		return exportRoot;
	}

	async function exportSTL() {
		if (!group || !scene) return;
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
		rebuildMeshes();
		group.updateWorldMatrix(true, true);
		if (!font) return;
		const safe = (text || 'plate')
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '');
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const nameStem = safe || 'plate';
		const exporter = new STLExporter();
		let didExport = false;
		const insertForName = group.getObjectByName('insert');
		const hasInsertMesh =
			includeSlotInsert && insertForName && (insertForName as THREE.Mesh).isMesh;

		try {
			const plateGeo = await buildEngravePlateOpenScadBufferGeometry(font, engraveOpenScadParams());
			const plateResult = exporter.parse(new THREE.Mesh(plateGeo), { binary: true });
			plateGeo.dispose();
			const plateBuf = plateResult instanceof DataView ? plateResult.buffer : plateResult;
			if (plateBuf && (plateBuf as ArrayBuffer).byteLength >= 84) {
				const plateFile = hasInsertMesh
					? `${nameStem}-plate-${timestamp}.stl`
					: `${nameStem}-${timestamp}.stl`;
				downloadBlob(plateFile, new Blob([plateBuf], { type: 'model/stl' }));
				didExport = true;
			}
		} catch (err) {
			console.error('Engrave plate OpenSCAD STL export failed:', err);
		}

		if (hasInsertMesh) {
			await new Promise((r) => setTimeout(r, 200));
			const insertObj = group.getObjectByName('insert') as THREE.Mesh;
			const geo = insertObj.geometry.clone().applyMatrix4(insertObj.matrixWorld);
			const welded = BufferGeometryUtils.mergeVertices(geo, 1e-3);
			geo.dispose();
			const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
			welded.dispose();
			const buffer = result instanceof DataView ? result.buffer : result;
			if (buffer && (buffer as ArrayBuffer).byteLength >= 84) {
				downloadBlob(`${nameStem}-insert-${timestamp}.stl`, new Blob([buffer], { type: 'model/stl' }));
				didExport = true;
			}
		}

		if (didExport) {
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string) ?? '',
				subscriptionStatus,
				designName: 'Engrave Name Plate',
				format: 'stl'
			});
			onShowThankYou();
		}
		} finally {
			exportLoading = false;
		}
	}

	async function export3MF() {
		if (!group || !scene) return;
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		exportLoading = true;
		await tickThenYieldToPaint();
		let exportRoot: THREE.Scene | null = null;
		try {
			rebuildMeshes();
			group.updateWorldMatrix(true, true);
			if (!font) return;
			exportRoot = await buildEngraveExportRootForMultipart();
			const blob = await exportTo3MF(exportRoot);
			if (!blob || blob.size === 0) return;
			const safe = (text || 'plate')
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)/g, '');
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${safe || 'plate'}-multipart-${timestamp}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string) ?? '',
				subscriptionStatus,
				designName: 'Engrave Name Plate',
				format: '3mf'
			});
			onShowThankYou();
		} catch (err) {
			console.error('Engrave 3MF export failed:', err);
		} finally {
			if (exportRoot) disposeObject3D(exportRoot);
			exportLoading = false;
		}
	}

	async function openWithBambuStudio() {
		if (!group || !scene) return;
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		openBambuStudioLoading = true;
		exportLoading = true;
		await tickThenYieldToPaint();
		let exportRoot: THREE.Scene | null = null;
		try {
			rebuildMeshes();
			group.updateWorldMatrix(true, true);
			if (!font) return;
			exportRoot = await buildEngraveExportRootForMultipart();
			const blob = await exportTo3MF(exportRoot);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'engrave-plate');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string) ?? '',
				subscriptionStatus,
				designName: 'Engrave Name Plate',
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			if (exportRoot) disposeObject3D(exportRoot);
			openBambuStudioLoading = false;
			exportLoading = false;
		}
	}

	onMount(() => {
		if (!hostEl) return;
		isUpdatingFromStorage = true;
		if (!allFontSettings[fontKey]) allFontSettings[fontKey] = { ...engraveDefaults };
		font = getFont(fontKey);

		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);
		renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
		renderer.setPixelRatio(Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.05;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		// eslint-disable-next-line svelte/no-dom-manipulating -- Three.js attaches the WebGL canvas
		hostEl.appendChild(renderer.domElement);
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';
		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.screenSpacePanning = false;
		controls.minDistance = 50;
		controls.maxDistance = 500;
		controls.update();

		scene.add(new THREE.HemisphereLight(0xffffff, 0xffffff, 0.25));
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
			new THREE.ShadowMaterial({ opacity: 0.18 })
		);
		shadowPlane.position.z = -0.015;
		shadowPlane.receiveShadow = true;
		scene.add(shadowPlane);

		group = new THREE.Group();
		scene.add(group);

		sceneReady = true;

		const doBuild = () => {
			if (!group || !font) return;
			rebuildMeshes();
			isReady = true;
		};
		if (typeof requestIdleCallback !== 'undefined') {
			requestIdleCallback(doBuild, { timeout: 100 });
		} else {
			requestAnimationFrame(doBuild);
		}

		const scheduleOpenScadWarmup = () => {
			void warmupOpenScadWorker();
		};
		if (typeof requestIdleCallback !== 'undefined') {
			requestIdleCallback(scheduleOpenScadWarmup, { timeout: 8000 });
		} else {
			setTimeout(scheduleOpenScadWarmup, 500);
		}

		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();
		setTimeout(() => {
			isUpdatingFromStorage = false;
		}, 0);

		const tick = () => {
			rafId = requestAnimationFrame(tick);
			controls?.update();
			if (renderer && scene && camera) renderer.render(scene, camera);
		};
		tick();
		return () => {
			ro?.disconnect();
			ro = null;
		};
	});

	$effect(() => {
		try {
			localStorage.setItem(STORAGE_KEY_TEXT, text);
		} catch {
			void 0;
		}
	});
	$effect(() => {
		try {
			localStorage.setItem(STORAGE_KEY_FONT, fontKey);
		} catch {
			void 0;
		}
	});

	$effect(() => {
		const currentFont = fontKey;
		const currentChar = getCurrentChar();
		if (currentFont !== lastFont) {
			if (lastFont && lastChar) {
				const was = isUpdatingFromStorage;
				isUpdatingFromStorage = false;
				saveSettingsForFont(lastFont);
				saveKeyringForChar(lastFont, lastChar);
				isUpdatingFromStorage = was;
			}
			isUpdatingFromStorage = true;
			lastFont = currentFont;
			loadSettingsForFont(currentFont);
			if (currentChar) {
				loadKeyringForChar(currentFont, currentChar);
				lastChar = currentChar;
			}
			setTimeout(() => {
				isUpdatingFromStorage = false;
			}, 0);
			if (sceneReady && scene) {
				font = getFont(fontKey);
				didInitFrame = false;
			}
		}
	});

	$effect(() => {
		const currentChar = getCurrentChar();
		const currentFont = fontKey;
		if (currentChar !== lastChar && currentFont) {
			if (lastChar) {
				const was = isUpdatingFromStorage;
				isUpdatingFromStorage = false;
				saveKeyringForChar(currentFont, lastChar);
				isUpdatingFromStorage = was;
			}
			isUpdatingFromStorage = true;
			lastChar = currentChar;
			if (currentChar) loadKeyringForChar(currentFont, currentChar);
			setTimeout(() => {
				isUpdatingFromStorage = false;
			}, 0);
		}
	});

	$effect(() => {
		if (isUpdatingFromStorage || !fontKey) return;
		void textSize;
		void outlineOffsetPx;
		void baseDepth;
		void outlineColor;
		void keyringEnabled;
		void tolerance;
		void pocketDepth;
		void mainTextThicknessMm;
		void includeSlotInsert;
		void insertTextColor;
		saveSettingsForFont(fontKey);
	});

	$effect(() => {
		if (isUpdatingFromStorage) return;
		const c = getCurrentChar();
		const f = fontKey;
		void keyringOffsetX;
		void keyringOffsetY;
		void keyringOuterSize;
		void keyringHoleSize;
		if (c && f) saveKeyringForChar(f, c);
	});

	$effect(() => {
		void sceneReady;
		void isReady;
		void fontKey;
		void text;
		void textSize;
		void outlineOffsetPx;
		void baseDepth;
		void keyringEnabled;
		void keyringOuterSize;
		void keyringHoleSize;
		void keyringOffsetX;
		void keyringOffsetY;
		void tolerance;
		void pocketDepth;
		void mainTextThicknessMm;
		void includeSlotInsert;
		if (!sceneReady || !scene || !group || !font) return;
		if (isReady) sceneLoading = true;
		if (rebuildTimeoutId !== null) {
			clearTimeout(rebuildTimeoutId);
			rebuildTimeoutId = null;
		}
		rebuildTimeoutId = setTimeout(() => {
			rebuildTimeoutId = null;
			const done = () => {
				if (!group || !font) return;
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
		void outlineColor;
		void insertTextColor;
		if (!group) return;
		for (const c of group.children) {
			const mesh = c as THREE.Mesh;
			if (!mesh.isMesh) continue;
			const mat = mesh.material as THREE.MeshStandardMaterial;
			if (!mat?.color) continue;
			if (mesh.name === 'base') {
				mat.color.set(outlineColor);
				mat.needsUpdate = true;
			} else if (mesh.name === 'insert') {
				mat.color.set(insertTextColor);
				mat.needsUpdate = true;
			}
		}
	});

	onDestroy(() => {
		if (rebuildTimeoutId !== null) {
			clearTimeout(rebuildTimeoutId);
			rebuildTimeoutId = null;
		}
		sceneReady = false;
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
		if (renderer && hostEl && renderer.domElement.parentElement === hostEl) {
			// eslint-disable-next-line svelte/no-dom-manipulating -- teardown WebGL canvas
			hostEl.removeChild(renderer.domElement);
		}
		renderer?.dispose();
		renderer = null;
		scene = null;
		camera = null;
		font = null;
		group = null;
		keyLight = null;
		shadowPlane = null;
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full max-w-[360px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Engrave name plate</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4 pt-0">
				<label class="grid gap-1.5">
					<span class="text-xs font-medium text-slate-700">Text</span>
					<input
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-indigo-500/25 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2"
						type="text"
						bind:value={text}
					/>
				</label>

				<label class="grid gap-1.5">
					<span class="text-xs font-medium text-slate-700">Font</span>
					<FontSelect bind:value={fontKey} />
				</label>

				<label class="grid gap-1.5">
					<div class="flex items-center justify-between gap-2">
						<span class="text-xs font-medium text-slate-700">Text size</span>
						<span class="text-xs text-slate-600 tabular-nums">{textSize}</span>
					</div>
					<Slider type="single" bind:value={textSize} min={6} max={72} step={1} class="w-full" />
				</label>

				<label class="grid gap-1.5">
					<div class="flex items-center justify-between gap-2">
						<span class="text-xs font-medium text-slate-700">Outline margin</span>
						<span class="text-xs text-slate-600 tabular-nums">{outlineOffsetPx}px</span>
					</div>
					<Slider
						type="single"
						bind:value={outlineOffsetPx}
						min={5}
						max={30}
						step={1}
						class="w-full"
					/>
				</label>

				<ColorPalettePicker bind:value={outlineColor} {palette} label="Plate color" />

				<div class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Extrusion</div>
					<div class="grid grid-cols-2 gap-3">
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Base depth</span>
								<span class="text-xs text-slate-600 tabular-nums">{baseDepth}</span>
							</div>
							<Slider
								type="single"
								bind:value={baseDepth}
								min={1}
								max={20}
								step={0.2}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Pocket depth</span>
								<span class="text-xs text-slate-600 tabular-nums">{pocketDepth}</span>
							</div>
							<Slider
								type="single"
								bind:value={pocketDepth}
								min={0.5}
								max={16}
								step={0.2}
								class="w-full"
							/>
						</label>
					</div>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Main text thickness</span>
							<span class="text-xs text-slate-600 tabular-nums"
								>{mainTextThicknessMm.toFixed(1)} mm</span
							>
						</div>
						<p class="text-xs text-slate-500">
							Depth of the printable insert (when &quot;Include insert piece&quot; is on). Capped so
							it fits the pocket.
						</p>
						<Slider
							type="single"
							bind:value={mainTextThicknessMm}
							min={0.2}
							max={20}
							step={0.1}
							class="w-full"
						/>
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Slot clearance</span>
							<span class="text-xs text-slate-600 tabular-nums">{tolerance} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={tolerance}
							min={0}
							max={1.5}
							step={0.05}
							class="w-full"
						/>
					</label>
				</div>

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Slot insert piece</div>
					<p class="text-xs text-slate-500">
						Optional solid of your text (depth set by Main text thickness above, still capped to the
						pocket). It appears to the side in the preview. Exports bundle the OpenSCAD plate plus
						this insert (same offset as the preview); STL can also save two files. Position parts in
						your slicer as you like.
					</p>
					<label class="flex items-center gap-2 text-xs font-medium text-slate-700">
						<input
							class="h-4 w-4 accent-indigo-500"
							type="checkbox"
							bind:checked={includeSlotInsert}
						/>
						Include insert piece
					</label>
					{#if includeSlotInsert}
						<ColorPalettePicker bind:value={insertTextColor} {palette} label="Insert color" />
					{/if}
				</div>

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="flex items-center justify-between">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Keyring</div>
						<label class="flex items-center gap-2 text-xs font-medium text-slate-700">
							<input
								class="h-4 w-4 accent-indigo-500"
								type="checkbox"
								bind:checked={keyringEnabled}
							/>
							Enabled
						</label>
					</div>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Ring size</span>
							<span class="text-xs text-slate-600 tabular-nums">{keyringOuterSize}</span>
						</div>
						<Slider
							type="single"
							bind:value={keyringOuterSize}
							min={4}
							max={15}
							step={0.5}
							class="w-full"
						/>
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Hole size</span>
							<span class="text-xs text-slate-600 tabular-nums">{keyringHoleSize}</span>
						</div>
						<Slider
							type="single"
							bind:value={keyringHoleSize}
							min={2}
							max={Math.max(1, keyringOuterSize - 1)}
							step={0.5}
							class="w-full"
						/>
					</label>
					<div class="grid grid-cols-2 gap-3">
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Pos X</span>
								<span class="text-xs text-slate-600 tabular-nums">{keyringOffsetX}</span>
							</div>
							<Slider
								type="single"
								bind:value={keyringOffsetX}
								min={-40}
								max={40}
								step={0.5}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Pos Y</span>
								<span class="text-xs text-slate-600 tabular-nums">{keyringOffsetY}</span>
							</div>
							<Slider
								type="single"
								bind:value={keyringOffsetY}
								min={-40}
								max={40}
								step={0.5}
								class="w-full"
							/>
						</label>
					</div>
				</div>
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0"></div>
			{#if !isReady || sceneLoading}
				<div
					class="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center"
					aria-live="polite"
				>
					<span
						class="rounded-xl bg-white/90 px-4 py-2 text-sm text-slate-600 shadow-lg backdrop-blur"
					>
						{!isReady ? 'Preparing preview…' : 'Updating preview…'}
					</span>
				</div>
			{/if}
			<div class="absolute right-4 bottom-4 z-10">
				<DesignerExportToolbar
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'engrave-name-plate')}
					onExport={() => (user && subscriptionStatus?.isActive ? exportSTL() : onShowPricing?.())}
					onExport3MF={() =>
						user && subscriptionStatus?.isActive ? export3MF() : onShowPricing?.()}
					onOpenWithBambuStudio={() =>
						user && subscriptionStatus?.isActive ? openWithBambuStudio() : onShowPricing?.()}
					exportLoading={exportLoading}
					{openBambuStudioLoading}
					exportDisabled={!text?.trim()}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF')}
					showLockIcon={!user || !subscriptionStatus?.isActive}
				/>
			</div>
		</section>
	</div>
</main>
