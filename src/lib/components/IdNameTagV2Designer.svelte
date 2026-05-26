<script lang="ts">
	import type { PaletteColor } from '$lib/colorPalette';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { notifyExportEvent } from '$lib/exportNotify';
	import base1StlUrl from '$lib/assets/stl/idnametag/base1.stl?url';
	import base2StlUrl from '$lib/assets/stl/idnametag/base2.stl?url';
	import base3StlUrl from '$lib/assets/stl/idnametag/base3.stl?url';
	import base4StlUrl from '$lib/assets/stl/idnametag/base4.stl?url';
	import border1StlUrl from '$lib/assets/stl/idnametag/border1.stl?url';
	import border2StlUrl from '$lib/assets/stl/idnametag/border2.stl?url';
	import border3StlUrl from '$lib/assets/stl/idnametag/border3.stl?url';
	import border4StlUrl from '$lib/assets/stl/idnametag/border4.stl?url';
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import {
		centerGeometryXY,
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		frameCameraToObject,
		getFont,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import FontSelect from './FontSelect.svelte';
	import { Button } from './ui/button';
	import { Slider } from './ui/slider';

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

	const STORAGE_KEY = 'keychain-idnametag-v2-settings';
	const DESIGN_NAME = 'ID Name Tag v2';
	const SLUG = 'id-name-tag-v2';
	const TEXT_MAX_WIDTH_RATIO = 0.78;
	/** Match BasicName: sink text into the base in preview/single-mesh STL to avoid coplanar contact. */
	const TEXT_BASE_EMBED = 0.2;
	/** Match BasicName: sink border slightly so its bottom face is not coplanar with the base top face. */
	const BORDER_BASE_EMBED = 0.05;
	const WELD_TOL_MM = 1e-3;
	const TOP_LOOP_SNAP_MM = 1e-4;
	const DEFAULT_DETAIL_COLOR = '#1f2937';

	type ModelPairId = 1 | 2 | 3 | 4;

	type ModelPair = {
		id: ModelPairId;
		label: string;
		baseUrl: string;
		borderUrl: string;
	};

	type IdNameTagV2Line = {
		id: string;
		content: string;
		fontKey: string;
		size: number;
		depth: number;
		color: string;
	};

	type TextLineEntry = { geo: THREE.BufferGeometry; height: number; color: string };
	type TopLoop = THREE.Vector2[];
	type BoundaryEdge = { a: string; b: string };
	type BoundaryEdgeCount = BoundaryEdge & { count: number };
	type AdjacencyByKey = Record<string, string[] | undefined>;
	type BoundaryEdgesByKey = Record<string, BoundaryEdgeCount | undefined>;
	type PointsByKey = Record<string, THREE.Vector2 | undefined>;
	type VisitedEdgesByKey = Record<string, true | undefined>;

	interface Settings {
		modelPairId: ModelPairId;
		baseDepth: number;
		borderDepth: number;
		baseColor: string;
		commonColor: string;
		borderColor: string;
		lines: IdNameTagV2Line[];
		lineSpacing: number;
	}

	const MODEL_PAIRS: ModelPair[] = [
		{ id: 1, label: 'Style 1', baseUrl: base1StlUrl, borderUrl: border1StlUrl },
		{ id: 2, label: 'Style 2', baseUrl: base2StlUrl, borderUrl: border2StlUrl },
		{ id: 3, label: 'Style 3', baseUrl: base3StlUrl, borderUrl: border3StlUrl },
		{ id: 4, label: 'Style 4', baseUrl: base4StlUrl, borderUrl: border4StlUrl }
	];

	const DEFAULT_FONT_KEY = FONT_OPTIONS[0]?.key ?? 'Titan One_Regular';
	let nextLineId = 1;

	function createLine(values: Partial<Omit<IdNameTagV2Line, 'id'>> = {}): IdNameTagV2Line {
		return {
			id: `line-${nextLineId++}`,
			content: values.content ?? '',
			fontKey: values.fontKey ?? DEFAULT_FONT_KEY,
			size: values.size ?? 14,
			depth: values.depth ?? 1,
			color: values.color ?? DEFAULT_DETAIL_COLOR
		};
	}

	const defaults: Settings = {
		modelPairId: 1,
		baseDepth: 2.5,
		borderDepth: 1.2,
		baseColor: '#ffffff',
		commonColor: DEFAULT_DETAIL_COLOR,
		borderColor: DEFAULT_DETAIL_COLOR,
		lines: [
			createLine({ content: 'Nickname', size: 18, depth: 1 }),
			createLine({ content: 'Full name', size: 9, depth: 1 })
		],
		lineSpacing: 5
	};

	function clamp(v: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, v));
	}

	function isFiniteNumber(v: unknown): v is number {
		return typeof v === 'number' && Number.isFinite(v);
	}

	function isModelPairId(v: unknown): v is ModelPairId {
		return v === 1 || v === 2 || v === 3 || v === 4;
	}

	function cloneDefaultLines(color = DEFAULT_DETAIL_COLOR): IdNameTagV2Line[] {
		return defaults.lines.map((line) =>
			createLine({
				content: line.content,
				fontKey: line.fontKey,
				size: line.size,
				depth: line.depth,
				color
			})
		);
	}

	function sanitizeLine(
		raw: unknown,
		fallbackColor = DEFAULT_DETAIL_COLOR
	): IdNameTagV2Line | null {
		if (!raw || typeof raw !== 'object') return null;
		const r = raw as Partial<IdNameTagV2Line>;
		if (typeof r.content !== 'string') return null;
		const fontKey =
			typeof r.fontKey === 'string' && FONT_OPTIONS.some((option) => option.key === r.fontKey)
				? r.fontKey
				: DEFAULT_FONT_KEY;
		const size = isFiniteNumber(r.size) ? clamp(r.size, 3, 40) : 14;
		const depth = isFiniteNumber(r.depth) ? clamp(r.depth, 0.1, 5) : 1;
		const color = typeof r.color === 'string' ? r.color : fallbackColor;
		return createLine({ content: r.content, fontKey, size, depth, color });
	}

	function loadSettings(): Settings {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return { ...defaults, lines: cloneDefaultLines() };
			const parsed = JSON.parse(stored);
			if (!parsed || typeof parsed !== 'object') {
				return { ...defaults, lines: cloneDefaultLines() };
			}
			const oldAccentColor = typeof parsed.accentColor === 'string' ? parsed.accentColor : null;
			const borderColor =
				typeof parsed.borderColor === 'string'
					? parsed.borderColor
					: (oldAccentColor ?? defaults.borderColor);
			const commonColor =
				typeof parsed.commonColor === 'string'
					? parsed.commonColor
					: (oldAccentColor ?? borderColor);
			const lineFallbackColor = oldAccentColor ?? DEFAULT_DETAIL_COLOR;
			const rawLines: unknown[] | null = Array.isArray(parsed.lines)
				? (parsed.lines as unknown[])
				: null;
			const lines = rawLines
				? rawLines
						.map((line) => sanitizeLine(line, lineFallbackColor))
						.filter((line: IdNameTagV2Line | null): line is IdNameTagV2Line => line !== null)
				: cloneDefaultLines(lineFallbackColor);
			return {
				modelPairId: isModelPairId(parsed.modelPairId) ? parsed.modelPairId : defaults.modelPairId,
				baseDepth: isFiniteNumber(parsed.baseDepth)
					? clamp(parsed.baseDepth, 0.4, 10)
					: defaults.baseDepth,
				borderDepth: isFiniteNumber(parsed.borderDepth)
					? clamp(parsed.borderDepth, 0.2, 5)
					: defaults.borderDepth,
				baseColor: typeof parsed.baseColor === 'string' ? parsed.baseColor : defaults.baseColor,
				commonColor,
				borderColor,
				lines: lines.length > 0 ? lines : cloneDefaultLines(lineFallbackColor),
				lineSpacing: isFiniteNumber(parsed.lineSpacing)
					? clamp(parsed.lineSpacing, 0, 20)
					: defaults.lineSpacing
			};
		} catch {
			return { ...defaults, lines: cloneDefaultLines() };
		}
	}

	const initial = loadSettings();

	let selectedPairId = $state<ModelPairId>(initial.modelPairId);
	let baseDepth = $state(initial.baseDepth);
	let borderDepth = $state(initial.borderDepth);
	let baseColor = $state(initial.baseColor);
	let commonColor = $state(initial.commonColor);
	let borderColor = $state(initial.borderColor);
	let lines = $state<IdNameTagV2Line[]>(initial.lines.map((line) => ({ ...line })));
	let lineSpacing = $state(initial.lineSpacing);

	let hostEl: HTMLDivElement | null = null;
	let canvasEl: HTMLCanvasElement | null = null;
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let controls: InstanceType<typeof OrbitControls> | null = null;
	let group: THREE.Group | null = null;
	let keyLight: THREE.DirectionalLight | null = null;
	let rafId = 0;
	let ro: ResizeObserver | null = null;
	let didInitFrame = false;
	let sceneReady = $state(false);
	let exportLoading = $state(false);
	let exportError = $state<string | null>(null);
	let openBambuStudioLoading = $state(false);
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);
	let loadError = $state<string | null>(null);
	let basePlanSize = $state<{ x: number; y: number } | null>(null);
	let textCenterY = $state(0);
	let baseSourceGeometry = $state<THREE.BufferGeometry | null>(null);
	let borderSourceGeometry = $state<THREE.BufferGeometry | null>(null);
	let loadToken = 0;

	const selectedModelPair = $derived(
		MODEL_PAIRS.find((pair) => pair.id === selectedPairId) ?? MODEL_PAIRS[0]
	);

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
				modelPairId: selectedPairId,
				baseDepth,
				borderDepth,
				baseColor,
				commonColor,
				borderColor,
				lines,
				lineSpacing
			};
			localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
		} catch {
			/* localStorage may be unavailable; ignore */
		}
	}

	function getGeometryBounds(geo: THREE.BufferGeometry): THREE.Box3 | null {
		geo.computeBoundingBox();
		return geo.boundingBox ?? null;
	}

	function normalizeImportedGeometry(geo: THREE.BufferGeometry) {
		const bb = getGeometryBounds(geo);
		if (!bb) return;
		const cx = (bb.min.x + bb.max.x) / 2;
		// Register STL pairs by their visible lower edge; some bases include a top hook.
		geo.translate(-cx, -bb.min.y, -bb.min.z);
		geo.computeBoundingBox();
		geo.computeVertexNormals();
	}

	function getPlanSize(geo: THREE.BufferGeometry): { x: number; y: number } | null {
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) return null;
		return { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y };
	}

	function snapTopPoint(x: number, y: number): { key: string; point: THREE.Vector2 } {
		const ix = Math.round(x / TOP_LOOP_SNAP_MM);
		const iy = Math.round(y / TOP_LOOP_SNAP_MM);
		return {
			key: `${ix},${iy}`,
			point: new THREE.Vector2(ix * TOP_LOOP_SNAP_MM, iy * TOP_LOOP_SNAP_MM)
		};
	}

	function boundaryEdgeKey(a: string, b: string): string {
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
		areaEpsilon: number
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
						!loopEdgeKeys.includes(boundaryEdgeKey(current, candidate))
				);
				const next = candidates.find((candidate) => candidate !== previous) ?? candidates[0];
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
				.filter((point: THREE.Vector2 | undefined): point is THREE.Vector2 => !!point)
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
		const position = geometry.getAttribute('position');
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
				.filter((edge: BoundaryEdgeCount | undefined): edge is BoundaryEdgeCount => {
					return !!edge && edge.count === 1;
				})
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

		const outerPts = loops[0].loop.map((point) => point.clone());
		if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
		const shape = new THREE.Shape(outerPts);

		for (const { loop } of loops.slice(1)) {
			const holePts = loop.map((point) => point.clone());
			if (!THREE.ShapeUtils.isClockWise(holePts)) holePts.reverse();
			shape.holes.push(new THREE.Path(holePts));
		}

		return shape;
	}

	function buildCleanTopExtrusionGeometry(
		srcGeo: THREE.BufferGeometry,
		targetDepth: number,
		zOffset = 0
	): THREE.BufferGeometry | null {
		try {
			const shape = buildTopPerimeterShape(srcGeo);
			if (!shape) return null;
			const geo = new THREE.ExtrudeGeometry([shape], {
				depth: Math.max(0.01, targetDepth),
				bevelEnabled: false,
				steps: 1
			});
			bottomAlignGeometry(geo, zOffset);
			geo.computeVertexNormals();
			return geo;
		} catch (error) {
			console.warn('IdNameTagV2 clean top extrusion failed; falling back to STL scaling.', error);
			return null;
		}
	}

	function scaleGeometryToDepth(
		srcGeo: THREE.BufferGeometry,
		targetDepth: number
	): THREE.BufferGeometry {
		const geo = srcGeo.clone();
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) return geo;
		const currentDepth = Math.max(0.001, bb.max.z - bb.min.z);
		const scale = Math.max(0.01, targetDepth) / currentDepth;
		geo.scale(1, 1, scale);
		geo.computeBoundingBox();
		const scaledBb = geo.boundingBox;
		if (scaledBb) geo.translate(0, 0, -scaledBb.min.z);
		geo.computeVertexNormals();
		return geo;
	}

	function buildPreviewSolidGeometry(
		srcGeo: THREE.BufferGeometry,
		targetDepth: number
	): THREE.BufferGeometry {
		return (
			buildCleanTopExtrusionGeometry(srcGeo, targetDepth) ??
			scaleGeometryToDepth(srcGeo, targetDepth)
		);
	}

	function bottomAlignGeometry(geo: THREE.BufferGeometry, zOffset = 0) {
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) return;
		geo.translate(0, 0, -bb.min.z + zOffset);
		geo.computeBoundingBox();
	}

	function cleanExportGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
		if (geo.attributes.uv) geo.deleteAttribute('uv');
		const welded = BufferGeometryUtils.mergeVertices(geo, WELD_TOL_MM);
		if (welded !== geo) geo.dispose();
		if (welded.attributes.uv) welded.deleteAttribute('uv');
		welded.computeVertexNormals();
		welded.computeBoundingBox();
		return welded;
	}

	function buildExportSolidGeometry(
		srcGeo: THREE.BufferGeometry,
		targetDepth: number,
		zOffset = 0
	): THREE.BufferGeometry {
		const cleanGeo = buildCleanTopExtrusionGeometry(srcGeo, targetDepth, zOffset);
		if (cleanGeo) return cleanExportGeometry(cleanGeo);

		const geo = srcGeo.clone();
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) return cleanExportGeometry(geo);
		const currentDepth = Math.max(0.001, bb.max.z - bb.min.z);
		const scale = Math.max(0.01, targetDepth) / currentDepth;
		geo.scale(1, 1, scale);
		bottomAlignGeometry(geo, zOffset);
		return cleanExportGeometry(geo);
	}

	function buildTextLineEntries(): TextLineEntry[] {
		const lineEntries: TextLineEntry[] = [];
		const maxTextWidth = Math.max(1, (basePlanSize?.x ?? 100) * TEXT_MAX_WIDTH_RATIO);
		for (const line of lines) {
			const content = (line.content ?? '').trim();
			if (!content) continue;
			const font = getFont(line.fontKey);
			if (!font) continue;
			let shapes: THREE.Shape[];
			try {
				shapes = font.generateShapes(content, Math.max(1, line.size));
			} catch (error) {
				console.error('IdNameTagV2 generateShapes failed for line:', content, error);
				continue;
			}
			if (!shapes || shapes.length === 0) continue;
			const geo = new THREE.ExtrudeGeometry(shapes, {
				depth: Math.max(0.05, line.depth),
				bevelEnabled: false,
				curveSegments: 8,
				steps: 1
			});
			centerGeometryXY(geo);
			bottomAlignGeometry(geo);
			geo.computeBoundingBox();
			let bb = geo.boundingBox;
			if (!bb) {
				geo.dispose();
				continue;
			}
			const width = Math.max(0.001, bb.max.x - bb.min.x);
			if (width > maxTextWidth) {
				const scale = maxTextWidth / width;
				geo.scale(scale, scale, 1);
				bottomAlignGeometry(geo);
				bb = geo.boundingBox;
			}
			if (!bb) {
				geo.dispose();
				continue;
			}
			lineEntries.push({
				geo,
				height: Math.max(0.001, bb.max.y - bb.min.y),
				color: line.color
			});
		}
		return lineEntries;
	}

	function loadStlGeometry(loader: STLLoader, url: string): Promise<THREE.BufferGeometry> {
		return new Promise((resolve, reject) => {
			loader.load(
				url,
				(geometry) => resolve(geometry),
				undefined,
				(error) => reject(error)
			);
		});
	}

	async function loadSelectedModelPair(pair: ModelPair) {
		const token = ++loadToken;
		loadError = null;
		const loader = new STLLoader();
		try {
			const [baseGeo, borderGeo] = await Promise.all([
				loadStlGeometry(loader, pair.baseUrl),
				loadStlGeometry(loader, pair.borderUrl)
			]);
			normalizeImportedGeometry(baseGeo);
			normalizeImportedGeometry(borderGeo);
			if (token !== loadToken) {
				baseGeo.dispose();
				borderGeo.dispose();
				return;
			}
			baseSourceGeometry?.dispose();
			borderSourceGeometry?.dispose();
			baseSourceGeometry = baseGeo;
			borderSourceGeometry = borderGeo;
			basePlanSize = getPlanSize(baseGeo);
			const borderBounds = getGeometryBounds(borderGeo);
			textCenterY = borderBounds ? (borderBounds.min.y + borderBounds.max.y) / 2 : 0;
			didInitFrame = false;
			rebuildMeshes();
		} catch (error) {
			if (token !== loadToken) return;
			loadError = error instanceof Error ? error.message : 'Failed to load STL model pair';
			baseSourceGeometry?.dispose();
			borderSourceGeometry?.dispose();
			baseSourceGeometry = null;
			borderSourceGeometry = null;
			basePlanSize = null;
			textCenterY = 0;
			rebuildMeshes();
		}
	}

	function rebuildMeshes() {
		if (!group) return;
		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		modelAabbMm = null;

		if (!baseSourceGeometry || !borderSourceGeometry) return;

		const baseDepthSafe = Math.max(0.1, baseDepth);
		const borderDepthSafe = Math.max(0.1, borderDepth);
		const raisedSurfaceZ = baseDepthSafe;
		const borderZ = raisedSurfaceZ - BORDER_BASE_EMBED;
		const textZ = raisedSurfaceZ - TEXT_BASE_EMBED;
		const baseMat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.85,
			metalness: 0.05
		});
		const borderMat = new THREE.MeshStandardMaterial({
			color: borderColor,
			roughness: 0.55,
			metalness: 0.08
		});

		const baseMesh = new THREE.Mesh(
			buildPreviewSolidGeometry(baseSourceGeometry, baseDepthSafe),
			baseMat
		);
		baseMesh.name = 'base';
		baseMesh.castShadow = true;
		baseMesh.receiveShadow = true;
		group.add(baseMesh);

		const borderMesh = new THREE.Mesh(
			buildPreviewSolidGeometry(borderSourceGeometry, borderDepthSafe),
			borderMat
		);
		borderMesh.name = 'border';
		borderMesh.castShadow = true;
		borderMesh.receiveShadow = true;
		borderMesh.position.z = borderZ;
		group.add(borderMesh);

		const lineEntries = buildTextLineEntries();

		if (lineEntries.length > 0) {
			const gap = Math.max(0, lineSpacing);
			const totalHeight =
				lineEntries.reduce((acc, entry) => acc + entry.height, 0) +
				Math.max(0, lineEntries.length - 1) * gap;
			let yCursor = totalHeight / 2;
			for (const entry of lineEntries) {
				const yCenter = yCursor - entry.height / 2;
				yCursor -= entry.height + gap;
				const textMesh = new THREE.Mesh(
					entry.geo,
					new THREE.MeshStandardMaterial({
						color: entry.color,
						roughness: 0.35,
						metalness: 0.1
					})
				);
				textMesh.name = 'text';
				textMesh.castShadow = true;
				textMesh.receiveShadow = true;
				textMesh.position.set(0, textCenterY + yCenter, textZ);
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
			cam.updateProjectionMatrix();
			keyLight.target.position.copy(center);
			keyLight.target.updateWorldMatrix(true, true);
		}
		if (!didInitFrame && camera && controls) {
			frameCameraToObject(box, camera, controls);
			didInitFrame = true;
		}
		const size = measureWorldAabbSizeMm(group);
		modelAabbMm = size ? { x: size.x, y: size.y, z: size.z } : null;
	}

	function buildExportGroup(options: { liftTextOutOfEmbed?: boolean } = {}): THREE.Group {
		if (!baseSourceGeometry || !borderSourceGeometry) throw new Error('Model geometry not ready');
		if (!group) throw new Error('Preview scene not ready');

		rebuildMeshes();
		group.updateWorldMatrix(true, true);

		const exportGroup = new THREE.Group();
		const baseDepthSafe = Math.max(0.1, baseDepth);
		const borderDepthSafe = Math.max(0.1, borderDepth);
		const borderZ = baseDepthSafe - BORDER_BASE_EMBED;

		const baseMesh = new THREE.Mesh(
			buildExportSolidGeometry(baseSourceGeometry, baseDepthSafe),
			new THREE.MeshBasicMaterial({ color: baseColor })
		);
		baseMesh.name = 'base';
		exportGroup.add(baseMesh);

		const borderMesh = new THREE.Mesh(
			buildExportSolidGeometry(borderSourceGeometry, borderDepthSafe, borderZ),
			new THREE.MeshBasicMaterial({ color: borderColor })
		);
		borderMesh.name = 'border';
		exportGroup.add(borderMesh);

		for (const child of group.children) {
			const mesh = child as THREE.Mesh;
			if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.geometry) continue;
			if (mesh.name !== 'text') continue;
			const sceneMat = (
				Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
			) as THREE.Material & { color?: THREE.Color };
			const color = sceneMat.color?.clone() ?? new THREE.Color(DEFAULT_DETAIL_COLOR);
			const textGeo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
			if (options.liftTextOutOfEmbed) textGeo.translate(0, 0, TEXT_BASE_EMBED);
			const textMesh = new THREE.Mesh(textGeo, new THREE.MeshBasicMaterial({ color }));
			textMesh.name = 'text';
			exportGroup.add(textMesh);
		}

		exportGroup.updateWorldMatrix(true, true);
		if (exportGroup.children.length === 0) throw new Error('No geometry to export');
		return exportGroup;
	}

	async function exportSTL() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup();
			const geometries: THREE.BufferGeometry[] = [];
			for (const child of exportGroup.children) {
				if (!(child as THREE.Mesh).isMesh) continue;
				const mesh = child as THREE.Mesh;
				geometries.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
			}
			const merged =
				geometries.length === 1 ? geometries[0] : BufferGeometryUtils.mergeGeometries(geometries);
			if (geometries.length > 1) geometries.forEach((geo) => geo.dispose());
			if (!merged) throw new Error('Failed to merge geometry');
			const welded = BufferGeometryUtils.mergeVertices(merged, WELD_TOL_MM);
			if (welded !== merged) merged.dispose();
			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
			welded.dispose();
			disposeObject3D(exportGroup);
			const buffer = result instanceof DataView ? result.buffer : result;
			if (!buffer || buffer.byteLength < 84) throw new Error('Export produced no geometry');
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${SLUG}-${timestamp}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: 'stl'
			});
			onShowThankYou();
		} catch (error) {
			exportError = error instanceof Error ? error.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	async function export3MF() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup({ liftTextOutOfEmbed: true });
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) throw new Error('Export produced no geometry');
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${SLUG}-${timestamp}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: '3mf'
			});
			onShowThankYou();
		} catch (error) {
			exportError = error instanceof Error ? error.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	async function openWithBambuStudio() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		openBambuStudioLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup({ liftTextOutOfEmbed: true });
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, SLUG);
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (error) {
			console.error('Open with Bambu Studio failed:', error);
			exportError = error instanceof Error ? error.message : 'Open with Bambu Studio failed';
		} finally {
			openBambuStudioLoading = false;
		}
	}

	function addLine() {
		if (lines.length >= 8) return;
		const last = lines[lines.length - 1];
		lines = [
			...lines,
			createLine(
				last
					? {
							content: '',
							fontKey: last.fontKey,
							size: last.size,
							depth: last.depth,
							color: last.color
						}
					: { content: '', fontKey: DEFAULT_FONT_KEY, size: 12, depth: 1 }
			)
		];
	}

	function removeLine(id: string) {
		if (lines.length <= 1) return;
		lines = lines.filter((line) => line.id !== id);
	}

	function moveLine(index: number, delta: -1 | 1) {
		const target = index + delta;
		if (target < 0 || target >= lines.length) return;
		const next = [...lines];
		const [item] = next.splice(index, 1);
		next.splice(target, 0, item);
		lines = next;
	}

	function applyCommonColor(color: string) {
		commonColor = color;
		borderColor = color;
		lines = lines.map((line) => ({ ...line, color }));
	}

	onMount(() => {
		if (!hostEl || !canvasEl) return;

		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);

		renderer = new THREE.WebGLRenderer({
			canvas: canvasEl,
			antialias: true,
			preserveDrawingBuffer: true
		});
		renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.05;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;

		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.screenSpacePanning = false;
		controls.minDistance = 10;
		controls.maxDistance = 800;
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
			new THREE.ShadowMaterial({ opacity: 0.18 })
		);
		shadowPlane.position.z = -0.015;
		shadowPlane.receiveShadow = true;
		scene.add(shadowPlane);

		group = new THREE.Group();
		scene.add(group);

		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();
		sceneReady = true;

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
		const pair = selectedModelPair;
		if (!sceneReady) return;
		void loadSelectedModelPair(pair);
	});

	$effect(() => {
		void selectedPairId;
		void baseDepth;
		void borderDepth;
		void baseColor;
		void commonColor;
		void borderColor;
		void lines;
		void lineSpacing;
		saveSettings();
	});

	$effect(() => {
		void baseSourceGeometry;
		void borderSourceGeometry;
		void baseDepth;
		void borderDepth;
		void baseColor;
		void borderColor;
		void lines;
		void lineSpacing;
		if (!sceneReady) return;
		rebuildMeshes();
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		rafId = 0;
		loadToken++;
		ro?.disconnect();
		ro = null;
		if (group) {
			disposeObject3D(group);
			group.clear();
		}
		baseSourceGeometry?.dispose();
		borderSourceGeometry?.dispose();
		baseSourceGeometry = null;
		borderSourceGeometry = null;
		controls?.dispose();
		controls = null;
		renderer?.dispose();
		renderer = null;
		scene = null;
		camera = null;
		group = null;
		keyLight = null;
		sceneReady = false;
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full max-w-[380px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">ID Name Tag v2</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto p-4 pt-0">
				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="flex items-start justify-between gap-3">
						<div>
							<div class="text-xs font-semibold tracking-tight text-slate-700">Model</div>
							<p class="mt-1 text-xs text-slate-500">Choose one fixed STL base/border pair.</p>
						</div>
						{#if basePlanSize}
							<span class="shrink-0 text-xs text-slate-500 tabular-nums">
								{basePlanSize.x.toFixed(1)} x {basePlanSize.y.toFixed(1)} mm
							</span>
						{/if}
					</div>

					<div class="grid grid-cols-2 gap-2">
						{#each MODEL_PAIRS as pair (pair.id)}
							<Button
								type="button"
								variant={selectedPairId === pair.id ? 'default' : 'outline'}
								size="sm"
								class="justify-center"
								onclick={() => (selectedPairId = pair.id)}
							>
								{pair.label}
							</Button>
						{/each}
					</div>

					{#if loadError}
						<p class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
							{loadError}
						</p>
					{/if}
				</div>

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="flex items-center justify-between">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Lines</div>
						<span class="text-xs text-slate-500">{lines.length} of 8</span>
					</div>

					{#each lines as line, i (line.id)}
						<div class="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
							<div class="mb-2 flex items-center justify-between">
								<span class="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
									Line {i + 1}
								</span>
								<div class="flex items-center gap-1">
									<Button
										variant="outline"
										size="xs"
										class="h-7 w-7 p-0"
										title="Move up"
										aria-label="Move line up"
										disabled={i === 0}
										onclick={() => moveLine(i, -1)}
									>
										↑
									</Button>
									<Button
										variant="outline"
										size="xs"
										class="h-7 w-7 p-0"
										title="Move down"
										aria-label="Move line down"
										disabled={i === lines.length - 1}
										onclick={() => moveLine(i, 1)}
									>
										↓
									</Button>
									<Button
										variant="outline"
										size="xs"
										class="h-7 w-7 p-0 text-red-600 hover:bg-red-50 hover:text-red-700"
										title="Remove line"
										aria-label="Remove line"
										disabled={lines.length <= 1}
										onclick={() => removeLine(line.id)}
									>
										✕
									</Button>
								</div>
							</div>

							<label class="grid gap-1.5">
								<span class="text-xs font-medium text-slate-700">Content</span>
								<input
									class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
									type="text"
									bind:value={line.content}
									placeholder={i === 0 ? 'Name' : 'Subtitle'}
								/>
							</label>

							<label class="mt-2 grid gap-1.5">
								<span class="text-xs font-medium text-slate-700">Font</span>
								<FontSelect bind:value={line.fontKey} />
							</label>

							<div class="mt-2">
								<ColorPalettePicker bind:value={line.color} {palette} label="Text color" />
							</div>

							<div class="mt-2 grid grid-cols-2 gap-3">
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Size</span>
										<span class="text-xs text-slate-600 tabular-nums">{line.size}</span>
									</div>
									<Slider
										type="single"
										bind:value={line.size}
										min={4}
										max={32}
										step={0.5}
										class="w-full"
									/>
								</label>
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Depth</span>
										<span class="text-xs text-slate-600 tabular-nums">{line.depth}</span>
									</div>
									<Slider
										type="single"
										bind:value={line.depth}
										min={0.2}
										max={3}
										step={0.1}
										class="w-full"
									/>
								</label>
							</div>
						</div>
					{/each}

					<Button
						variant="outline"
						size="sm"
						class="w-full"
						onclick={addLine}
						disabled={lines.length >= 8}
					>
						+ Add line
					</Button>

					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Line spacing</span>
							<span class="text-xs text-slate-600 tabular-nums">{lineSpacing} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={lineSpacing}
							min={0}
							max={20}
							step={0.5}
							class="w-full"
						/>
					</label>
				</div>

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Base & border</div>
					<ColorPalettePicker
						bind:value={commonColor}
						{palette}
						label="All text & border color"
						onValueChange={applyCommonColor}
					/>
					<ColorPalettePicker bind:value={baseColor} {palette} label="Base color" />
					<ColorPalettePicker bind:value={borderColor} {palette} label="Border color" />

					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Base thickness</span>
							<span class="text-xs text-slate-600 tabular-nums">{baseDepth} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={baseDepth}
							min={0.4}
							max={10}
							step={0.1}
							class="w-full"
						/>
					</label>

					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Border thickness</span>
							<span class="text-xs text-slate-600 tabular-nums">{borderDepth} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={borderDepth}
							min={0.2}
							max={5}
							step={0.1}
							class="w-full"
						/>
					</label>
				</div>
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0">
				<canvas bind:this={canvasEl} class="block h-full w-full"></canvas>
			</div>
			<div class="absolute right-4 bottom-4">
				<DesignerExportToolbar
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, SLUG)}
					onExport={() => exportSTL()}
					onExport3MF={() => export3MF()}
					onOpenWithBambuStudio={() => openWithBambuStudio()}
					{openBambuStudioLoading}
					exportDisabled={!baseSourceGeometry || !borderSourceGeometry || exportLoading}
					exportTitle={getExportTitle(
						user,
						subscriptionStatus,
						'Export STL (single mesh) or 3MF (multipart) for 3D print'
					)}
					{exportLoading}
					showLockIcon={!session || !user || !subscriptionStatus?.isActive}
				/>
				{#if exportError}
					<p
						class="absolute right-4 bottom-14 max-w-[220px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg"
					>
						{exportError}
					</p>
				{/if}
			</div>
		</section>
	</div>
</main>
