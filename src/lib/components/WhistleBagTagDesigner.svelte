<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import ClipperLib from 'clipper-lib';
	import bagtagBaseStlUrl from '$lib/assets/stl/whistle/bagtag/base.stl?url';
	import bagtagBorderStlUrl from '$lib/assets/stl/whistle/bagtag/border.stl?url';
	import FontSelect from '$lib/components/FontSelect.svelte';
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
	import { notifyExportEvent } from '$lib/exportNotify';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import { snapColorToPalette, type PaletteColor } from '$lib/colorPalette';
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		cloneDefaultWhistleBagTagPresetsAsCustom,
		DEFAULT_WHISTLE_BAG_TAG_COLOR_PRESETS,
		isCustomWhistleBagTagPresetId,
		loadUserWhistleBagTagPresets,
		persistWhistleBagTagCustomPresets,
		type WhistleBagTagColorPreset
	} from '$lib/whistleBagTagPresets';

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

	const STORAGE_KEY = 'keychain-whistle-bag-tag-settings';
	const DESIGN_NAME = 'Whistle Bag Tag';
	const SLUG = 'whistle-bag-tag';
	const FONT_SIZE_FOR_SHAPES = 12;
	const TEXT_DEPTH_MM = 0.8;
	const TEXT_MAX_WIDTH_RATIO = 0.85;
	const WELD_TOL_MM = 1e-3;
	const TOP_LOOP_SNAP_MM = 1e-4;
	/** Vertical gap between stacked layers so faces do not touch. */
	const LAYER_GAP = 0.001;
	const CLIPPER_SCALE = 1000;
	/** Ignore hole loops smaller than this fraction of the outer loop area. */
	const HOLE_MIN_AREA_RATIO = 0.005;
	const MAX_LINES = 6;
	const DEFAULT_FONT_KEY = FONT_OPTIONS[0]?.key ?? 'Titan One_Regular';

	type TopLoop = THREE.Vector2[];
	type BoundaryEdge = { a: string; b: string };
	type BoundaryEdgeCount = BoundaryEdge & { count: number };
	type AdjacencyByKey = Record<string, string[] | undefined>;
	type BoundaryEdgesByKey = Record<string, BoundaryEdgeCount | undefined>;
	type PointsByKey = Record<string, THREE.Vector2 | undefined>;
	type VisitedEdgesByKey = Record<string, true | undefined>;
	type FrontTextLineEntry = {
		geo: THREE.BufferGeometry;
		height: number;
		centeredPaths: { X: number; Y: number }[][];
		yCenter: number;
	};

	type BagTagLine = {
		content: string;
		sizeMm: number;
	};

	interface BagTagSettings {
		fontKey: string;
		borderDepth: number;
		baseColor: string;
		accentColor: string;
		lineSpacing: number;
		lines: BagTagLine[];
		textOutlineEnabled: boolean;
		textOutlineThicknessMm: number;
		textOutlineDepth: number;
		textOutlineColor: string;
	}

	const defaults: BagTagSettings = {
		fontKey: DEFAULT_FONT_KEY,
		borderDepth: 1,
		baseColor: '#f97316',
		accentColor: '#ffffff',
		lineSpacing: 1.2,
		lines: [{ content: 'Name', sizeMm: 11 }],
		textOutlineEnabled: false,
		textOutlineThicknessMm: 1,
		textOutlineDepth: 0.6,
		textOutlineColor: '#ffffff'
	};

	function clamp(n: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, n));
	}

	function isFiniteNumber(v: unknown): v is number {
		return typeof v === 'number' && Number.isFinite(v);
	}

	function cloneDefaultLines(): BagTagLine[] {
		return defaults.lines.map((line) => ({ ...line }));
	}

	function parseLine(raw: unknown): BagTagLine | null {
		if (!raw || typeof raw !== 'object') return null;
		const line = raw as Partial<BagTagLine>;
		const content = typeof line.content === 'string' ? line.content : '';
		const sizeMm =
			typeof line.sizeMm === 'number' && Number.isFinite(line.sizeMm)
				? clamp(line.sizeMm, 3, 18)
				: 8;
		return { content, sizeMm };
	}

	function loadSettings(): BagTagSettings {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return { ...defaults, lines: cloneDefaultLines() };
			const parsed = JSON.parse(stored) as Partial<BagTagSettings>;
			if (!parsed || typeof parsed !== 'object') {
				return { ...defaults, lines: cloneDefaultLines() };
			}
			const fontKey =
				typeof parsed.fontKey === 'string' &&
				FONT_OPTIONS.some((option) => option.key === parsed.fontKey)
					? parsed.fontKey
					: defaults.fontKey;
			const rawLines = Array.isArray(parsed.lines) ? parsed.lines : null;
			const lines = rawLines
				?.map(parseLine)
				.filter((line): line is BagTagLine => line !== null) ?? [];
			return {
				fontKey,
				borderDepth: isFiniteNumber(parsed.borderDepth)
					? clamp(parsed.borderDepth, 0.2, 5)
					: defaults.borderDepth,
				baseColor:
					typeof parsed.baseColor === 'string' ? parsed.baseColor : defaults.baseColor,
				accentColor:
					typeof parsed.accentColor === 'string'
						? parsed.accentColor
						: defaults.accentColor,
				lineSpacing:
					typeof parsed.lineSpacing === 'number' && Number.isFinite(parsed.lineSpacing)
						? Math.max(0, parsed.lineSpacing)
						: defaults.lineSpacing,
				lines: lines.length > 0 ? lines.slice(0, MAX_LINES) : cloneDefaultLines(),
				textOutlineEnabled:
					typeof parsed.textOutlineEnabled === 'boolean'
						? parsed.textOutlineEnabled
						: defaults.textOutlineEnabled,
				textOutlineThicknessMm:
					typeof parsed.textOutlineThicknessMm === 'number' &&
					Number.isFinite(parsed.textOutlineThicknessMm)
						? Math.min(8, Math.max(0.2, parsed.textOutlineThicknessMm))
						: defaults.textOutlineThicknessMm,
				textOutlineDepth:
					typeof parsed.textOutlineDepth === 'number' &&
					Number.isFinite(parsed.textOutlineDepth)
						? Math.min(5, Math.max(0.2, parsed.textOutlineDepth))
						: defaults.textOutlineDepth,
				textOutlineColor:
					typeof parsed.textOutlineColor === 'string'
						? parsed.textOutlineColor
						: defaults.textOutlineColor
			};
		} catch {
			return { ...defaults, lines: cloneDefaultLines() };
		}
	}

	const initial = loadSettings();

	function saveSettings() {
		try {
			const payload: BagTagSettings = {
				fontKey,
				borderDepth,
				baseColor,
				accentColor,
				lineSpacing,
				lines: lines.map((line) => ({ ...line })),
				textOutlineEnabled,
				textOutlineThicknessMm,
				textOutlineDepth,
				textOutlineColor
			};
			localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
		} catch {
			/* localStorage may be unavailable */
		}
	}

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

	let baseSourceGeometry = $state<THREE.BufferGeometry | null>(null);
	let borderSourceGeometry = $state<THREE.BufferGeometry | null>(null);
	let loadError = $state<string | null>(null);
	let sceneReady = $state(false);
	let basePlanSize = $state<{ x: number; y: number } | null>(null);
	const maxTextOutlineMm = $derived(
		Math.max(
			0.2,
			Math.min(8, basePlanSize ? Math.min(basePlanSize.x, basePlanSize.y) * 0.12 : 4)
		)
	);
	let textCenterY = $state(0);
	let loadToken = 0;
	let mountGeneration = 0;

	let fontKey = $state(initial.fontKey);
	let borderDepth = $state(initial.borderDepth);
	let baseColor = $state(initial.baseColor);
	let accentColor = $state(initial.accentColor);
	let lineSpacing = $state(initial.lineSpacing);
	let lines = $state<BagTagLine[]>(initial.lines.map((line) => ({ ...line })));
	let textOutlineEnabled = $state(initial.textOutlineEnabled);
	let textOutlineThicknessMm = $state(initial.textOutlineThicknessMm);
	let textOutlineDepth = $state(initial.textOutlineDepth);
	let textOutlineColor = $state(initial.textOutlineColor);

	let activePresetId = $state<string | null>(null);
	let customPresets = $state<WhistleBagTagColorPreset[]>([]);
	let presetSyncError = $state<string | null>(null);
	let customPresetsLoading = $state(false);
	let importPresetsLoading = $state(false);
	const galleryPresets = $derived(customPresets);
	const hasGalleryPresets = $derived(galleryPresets.length > 0);

	type PresetEditorMode = 'create' | 'edit';
	let presetEditorOpen = $state(false);
	let presetEditorMode = $state<PresetEditorMode>('create');
	let presetEditorId = $state<string | null>(null);
	let presetEditorLabel = $state('');
	let presetEditorBase = $state('#f97316');
	let presetEditorAccent = $state('#ffffff');
	let presetEditorTextOutline = $state('#ffffff');
	let presetEditorTextOutlineEnabled = $state(false);

	function snapPresetColors(base: string, accent: string, textOutline: string) {
		return {
			base: snapColorToPalette(base, palette, baseColor),
			accent: snapColorToPalette(accent, palette, accentColor),
			textOutline: snapColorToPalette(textOutline, palette, textOutlineColor)
		};
	}

	function findMatchingPresetId(presets: WhistleBagTagColorPreset[]): string | null {
		for (const preset of presets) {
			if (
				preset.baseColor === baseColor &&
				preset.accentColor === accentColor &&
				preset.textOutlineColor === textOutlineColor &&
				(preset.textOutlineEnabled ?? false) === textOutlineEnabled
			) {
				return preset.id;
			}
		}
		return null;
	}

	function applyColorPreset(preset: WhistleBagTagColorPreset) {
		const snapped = snapPresetColors(
			preset.baseColor,
			preset.accentColor,
			preset.textOutlineColor
		);
		baseColor = snapped.base;
		accentColor = snapped.accent;
		textOutlineColor = snapped.textOutline;
		textOutlineEnabled = preset.textOutlineEnabled ?? false;
		activePresetId = findMatchingPresetId(galleryPresets) ?? preset.id;
	}

	function setPresetEditorColors(base: string, accent: string, textOutline: string) {
		const snapped = snapPresetColors(base, accent, textOutline);
		presetEditorBase = snapped.base;
		presetEditorAccent = snapped.accent;
		presetEditorTextOutline = snapped.textOutline;
	}

	function openCreatePresetEditor() {
		presetEditorMode = 'create';
		presetEditorId = null;
		presetEditorLabel = 'My preset';
		presetEditorTextOutlineEnabled = textOutlineEnabled;
		setPresetEditorColors(baseColor, accentColor, textOutlineColor);
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
			customPresets = await loadUserWhistleBagTagPresets(userId);
			activePresetId = findMatchingPresetId(galleryPresets);
		} catch (e) {
			presetSyncError = e instanceof Error ? e.message : 'Failed to load presets';
		} finally {
			customPresetsLoading = false;
		}
	}

	async function persistCustomPresets(presets: WhistleBagTagColorPreset[]) {
		if (!user?.id) return;
		const result = await persistWhistleBagTagCustomPresets(user.id, presets);
		if (!result.success) {
			presetSyncError = result.error;
			return;
		}
		presetSyncError = null;
	}

	function openEditPresetEditor(preset: WhistleBagTagColorPreset) {
		presetEditorMode = 'edit';
		presetEditorId = preset.id;
		presetEditorLabel = preset.label;
		presetEditorTextOutlineEnabled = preset.textOutlineEnabled ?? false;
		setPresetEditorColors(preset.baseColor, preset.accentColor, preset.textOutlineColor);
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
		const label = presetEditorLabel.trim() || 'My preset';
		const snapped = snapPresetColors(
			presetEditorBase,
			presetEditorAccent,
			presetEditorTextOutline
		);
		const enabled = presetEditorTextOutlineEnabled;

		if (presetEditorMode === 'edit' && presetEditorId) {
			customPresets = customPresets.map((p) =>
				p.id === presetEditorId
					? {
							id: p.id,
							label,
							baseColor: snapped.base,
							accentColor: snapped.accent,
							textOutlineColor: snapped.textOutline,
							textOutlineEnabled: enabled
						}
					: p
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
					accentColor: snapped.accent,
					textOutlineColor: snapped.textOutline,
					textOutlineEnabled: enabled
				}
			];
			activePresetId = id;
		}

		applyColorPreset({
			id: activePresetId!,
			label,
			baseColor: snapped.base,
			accentColor: snapped.accent,
			textOutlineColor: snapped.textOutline,
			textOutlineEnabled: enabled
		});
		await persistCustomPresets(customPresets);
		closePresetEditor();
	}

	async function deleteCustomPreset(id: string) {
		if (!isCustomWhistleBagTagPresetId(id)) return;
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
			customPresets = cloneDefaultWhistleBagTagPresetsAsCustom((hex, fallback) =>
				snapColorToPalette(hex, palette, fallback)
			);
			await persistCustomPresets(customPresets);
			activePresetId = null;
		} catch (e) {
			presetSyncError = e instanceof Error ? e.message : 'Failed to import presets';
		} finally {
			importPresetsLoading = false;
		}
	}

	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);

	function resize() {
		if (!renderer || !camera || !hostEl) return;
		const rect = hostEl.getBoundingClientRect();
		const w = Math.max(1, Math.floor(rect.width));
		const h = Math.max(1, Math.floor(rect.height));
		renderer.setSize(w, h, true);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	function getGeometryBounds(geo: THREE.BufferGeometry): THREE.Box3 | null {
		geo.computeBoundingBox();
		return geo.boundingBox ?? null;
	}

	function getPlanSize(geo: THREE.BufferGeometry): { x: number; y: number } | null {
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) return null;
		return { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y };
	}

	/** Center base + border together in XY and rest the assembly on Z = 0 (translation only). */
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

	/** Flat text plateau: bottom of the border rim in STL coordinates. */
	function getTextPlateauZ(): number {
		if (!borderSourceGeometry) return 0;
		borderSourceGeometry.computeBoundingBox();
		return borderSourceGeometry.boundingBox?.min.z ?? 0;
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

	function isWatertightGeometry(geo: THREE.BufferGeometry): boolean {
		const geometry = geo.index ? geo.toNonIndexed() : geo;
		const position = geometry.getAttribute('position');
		if (!position || position.count < 3) {
			if (geometry !== geo) geometry.dispose();
			return false;
		}

		const edgeCounts: Record<string, number | undefined> = {};
		const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
		const vertexKey = (x: number, y: number, z: number) =>
			`${Math.round(x / WELD_TOL_MM)},${Math.round(y / WELD_TOL_MM)},${Math.round(z / WELD_TOL_MM)}`;

		for (let i = 0; i + 2 < position.count; i += 3) {
			const keys = [
				vertexKey(position.getX(i), position.getY(i), position.getZ(i)),
				vertexKey(position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1)),
				vertexKey(position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2))
			];
			for (const [a, b] of [
				[keys[0], keys[1]],
				[keys[1], keys[2]],
				[keys[2], keys[0]]
			] as const) {
				const key = edgeKey(a, b);
				edgeCounts[key] = (edgeCounts[key] ?? 0) + 1;
			}
		}

		let boundaryEdges = 0;
		let nonManifoldEdges = 0;
		for (const count of Object.values(edgeCounts)) {
			if (!count) continue;
			if (count === 1) boundaryEdges += 1;
			else if (count > 2) nonManifoldEdges += 1;
		}

		if (geometry !== geo) geometry.dispose();
		return boundaryEdges === 0 && nonManifoldEdges === 0;
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
		toVec2: (pt: { X: number; Y: number }) => THREE.Vector2
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
				const isHole = ch.IsHole?.() ?? ch.m_IsHole;
				if (!isHole) continue;
				const holeContour = ch.Contour?.() ?? ch.m_polygon ?? [];
				if (holeContour.length >= 3) {
					const holePts = holeContour.map(toVec2);
					if (!THREE.ShapeUtils.isClockWise(holePts)) holePts.reverse();
					shape.holes.push(new THREE.Path(holePts));
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
				ClipperLib.PolyFillType.pftNonZero
			);
		} else {
			const clipper = new ClipperLib.Clipper();
			clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
			clipper.Execute(
				ClipperLib.ClipType.ctUnion,
				tree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
		}
		return tree;
	}

	function addExtrudedBorderLayer(
		shape: THREE.Shape,
		z: number,
		depth: number,
		color: string,
		meshName: string
	) {
		if (!group) return;
		const topGeo = new THREE.ExtrudeGeometry([shape], {
			depth: Math.max(0.1, depth),
			bevelEnabled: false
		});
		topGeo.computeBoundingBox();
		const topBb = topGeo.boundingBox!;
		topGeo.translate(0, 0, -topBb.min.z);
		const borderMat = new THREE.MeshStandardMaterial({
			color,
			roughness: 0.85,
			metalness: 0.05
		});
		const topMesh = new THREE.Mesh(topGeo, borderMat);
		topMesh.name = meshName;
		topMesh.castShadow = true;
		topMesh.receiveShadow = true;
		topMesh.position.z = z;
		group.add(topMesh);
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
			if (!isWatertightGeometry(geo)) {
				geo.dispose();
				return null;
			}
			return geo;
		} catch (error) {
			console.warn('WhistleBagTag clean top extrusion failed; falling back to STL scaling.', error);
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

	function buildFrontTextLineEntries(): FrontTextLineEntry[] {
		const font = getFont(fontKey);
		if (!font) return [];

		const maxTextWidth = Math.max(1, (basePlanSize?.x ?? 100) * TEXT_MAX_WIDTH_RATIO);
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

		const lineEntries: FrontTextLineEntry[] = [];
		for (const line of lines) {
			const content = (line.content ?? '').trim();
			if (!content) continue;
			const shapes = font.generateShapes(content, FONT_SIZE_FOR_SHAPES);
			if (shapes.length === 0) continue;

			let clipperPaths: { X: number; Y: number }[][] = [];
			for (const shape of shapes) clipperPaths.push(...shapeToClipperPaths(shape));

			const textGeo = new THREE.ExtrudeGeometry(shapes, {
				depth: TEXT_DEPTH_MM,
				bevelEnabled: false,
				curveSegments: 12
			});
			centerGeometryXY(textGeo);
			bottomAlignGeometry(textGeo);
			textGeo.computeBoundingBox();
			const tb = textGeo.boundingBox;
			if (!tb) continue;

			const nativeH = Math.max(0.001, tb.max.y - tb.min.y);
			const scale = line.sizeMm / nativeH;
			textGeo.scale(scale, scale, 1);
			bottomAlignGeometry(textGeo);
			textGeo.computeBoundingBox();
			let scaledBb = textGeo.boundingBox;
			if (!scaledBb) continue;

			const w = Math.max(0.001, scaledBb.max.x - scaledBb.min.x);
			let fitScale = 1;
			if (w > maxTextWidth) {
				fitScale = maxTextWidth / w;
				textGeo.scale(fitScale, fitScale, 1);
				bottomAlignGeometry(textGeo);
				scaledBb = textGeo.boundingBox;
			}
			if (!scaledBb) continue;

			const cx = (scaledBb.min.x + scaledBb.max.x) / 2;
			const cy = (scaledBb.min.y + scaledBb.max.y) / 2;
			const centeredPaths = clipperPaths.map((path) =>
				path.map((pt) => ({
					X: Math.round((pt.X / CLIPPER_SCALE - cx) * scale * fitScale * CLIPPER_SCALE),
					Y: Math.round((pt.Y / CLIPPER_SCALE - cy) * scale * fitScale * CLIPPER_SCALE)
				}))
			);

			const height = Math.max(0.001, scaledBb.max.y - scaledBb.min.y);
			lineEntries.push({
				geo: textGeo,
				height,
				centeredPaths,
				yCenter: 0
			});
		}

		if (lineEntries.length > 0) {
			const gap = Math.max(0, lineSpacing);
			const totalHeight =
				lineEntries.reduce((acc, entry) => acc + entry.height, 0) +
				Math.max(0, lineEntries.length - 1) * gap;
			let yCursor = totalHeight / 2;
			for (const entry of lineEntries) {
				entry.yCenter = yCursor - entry.height / 2;
				yCursor -= entry.height + gap;
			}
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

	async function loadBagTagModels() {
		const generation = mountGeneration;
		const token = ++loadToken;
		loadError = null;
		const loader = new STLLoader();
		try {
			const [baseGeo, borderGeo] = await Promise.all([
				loadStlGeometry(loader, bagtagBaseStlUrl),
				loadStlGeometry(loader, bagtagBorderStlUrl)
			]);
			baseGeo.computeVertexNormals();
			borderGeo.computeVertexNormals();
			centerModelPair(baseGeo, borderGeo);
			if (generation !== mountGeneration || token !== loadToken) {
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
			sceneReady = true;
			rebuildMeshes();
		} catch (error) {
			if (generation !== mountGeneration || token !== loadToken) return;
			loadError = error instanceof Error ? error.message : 'Failed to load bag tag STL models';
			baseSourceGeometry?.dispose();
			borderSourceGeometry?.dispose();
			baseSourceGeometry = null;
			borderSourceGeometry = null;
			basePlanSize = null;
			textCenterY = 0;
			rebuildMeshes();
		}
	}

	function addLine(
		content = '',
		sizeMm = lines[lines.length - 1]?.sizeMm ?? 8
	) {
		if (lines.length >= MAX_LINES) return;
		lines = [...lines, { content, sizeMm: clamp(sizeMm, 3, 18) }];
	}

	function removeLine(index: number) {
		if (lines.length <= 1) return;
		lines = lines.filter((_, i) => i !== index);
	}

	function moveLine(index: number, direction: -1 | 1) {
		const target = index + direction;
		if (target < 0 || target >= lines.length) return;
		const next = [...lines];
		[next[index], next[target]] = [next[target], next[index]];
		lines = next;
	}

	function rebuildMeshes() {
		if (!group) return;
		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		modelAabbMm = null;

		if (!baseSourceGeometry || !borderSourceGeometry) return;

		const borderDepthSafe = Math.max(0.1, borderDepth);
		const plateauZ = getTextPlateauZ();
		const baseMat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.85,
			metalness: 0.05
		});
		const borderMat = new THREE.MeshStandardMaterial({
			color: accentColor,
			roughness: 0.55,
			metalness: 0.08
		});

		const baseGeo = baseSourceGeometry.clone();
		baseGeo.computeVertexNormals();
		const baseMesh = new THREE.Mesh(baseGeo, baseMat);
		baseMesh.name = 'base';
		baseMesh.castShadow = true;
		baseMesh.receiveShadow = true;
		group.add(baseMesh);

		const borderShape = buildTopPerimeterShape(borderSourceGeometry);
		const frontEntries = buildFrontTextLineEntries();
		const hasTextOutlineLayer =
			textOutlineEnabled && textOutlineThicknessMm > 0 && frontEntries.length > 0;

		let stackTopZ = plateauZ;

		if (hasTextOutlineLayer && borderShape) {
			const textOutlineWorld = Math.min(
				Math.max(0.1, textOutlineThicknessMm),
				maxTextOutlineMm
			);
			const outlineZ = stackTopZ + LAYER_GAP;
			addExtrudedBorderLayer(
				borderShape,
				outlineZ,
				textOutlineDepth,
				textOutlineColor,
				'text-outline-border'
			);
			const textOutlineMat = new THREE.MeshStandardMaterial({
				color: textOutlineColor,
				roughness: 0.55,
				metalness: 0.08
			});
			const toVec2 = (pt: { X: number; Y: number }) =>
				new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE);
			let addedTextOutline = false;
			for (const entry of frontEntries) {
				if (entry.centeredPaths.length === 0) continue;
				const textOutlineTree = buildUnionOffsetTree(entry.centeredPaths, textOutlineWorld);
				const textOutlineShapes = polyTreeToThreeShapes(textOutlineTree, toVec2);
				if (textOutlineShapes.length === 0) continue;
				const textOutlineGeo = new THREE.ExtrudeGeometry(textOutlineShapes, {
					depth: Math.max(0.1, textOutlineDepth),
					bevelEnabled: false,
					curveSegments: 12
				});
				centerGeometryXY(textOutlineGeo);
				textOutlineGeo.computeBoundingBox();
				const outlineBb = textOutlineGeo.boundingBox!;
				textOutlineGeo.translate(0, 0, -outlineBb.min.z);
				const textOutlineMesh = new THREE.Mesh(textOutlineGeo, textOutlineMat);
				textOutlineMesh.name = 'text-outline';
				textOutlineMesh.castShadow = true;
				textOutlineMesh.receiveShadow = true;
				textOutlineMesh.position.set(0, textCenterY + entry.yCenter, outlineZ);
				group.add(textOutlineMesh);
				addedTextOutline = true;
			}
			if (addedTextOutline) {
				stackTopZ = outlineZ + textOutlineDepth;
			}
		}

		const mainLayerZ = stackTopZ + LAYER_GAP;
		const frontTextZ = mainLayerZ;

		const borderMesh = new THREE.Mesh(
			buildPreviewSolidGeometry(borderSourceGeometry, borderDepthSafe),
			borderMat
		);
		borderMesh.name = 'border';
		borderMesh.castShadow = true;
		borderMesh.receiveShadow = true;
		borderMesh.position.z = mainLayerZ;
		group.add(borderMesh);

		if (frontEntries.length > 0) {
			for (const entry of frontEntries) {
				const textMesh = new THREE.Mesh(
					entry.geo,
					new THREE.MeshStandardMaterial({
						color: accentColor,
						roughness: 0.35,
						metalness: 0.1
					})
				);
				textMesh.name = 'text';
				textMesh.castShadow = true;
				textMesh.receiveShadow = true;
				textMesh.position.set(0, textCenterY + entry.yCenter, frontTextZ);
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
		const s = measureWorldAabbSizeMm(group);
		modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
	}

	function buildExportGroup(): THREE.Group {
		if (!baseSourceGeometry || !borderSourceGeometry) throw new Error('Model geometry not ready');
		if (!group) throw new Error('Preview scene not ready');

		rebuildMeshes();
		group.updateWorldMatrix(true, true);

		const exportGroup = new THREE.Group();
		const borderDepthSafe = Math.max(0.1, borderDepth);
		const plateauZ = getTextPlateauZ();

		const baseGeo = cleanExportGeometry(baseSourceGeometry.clone());
		const baseMesh = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({ color: baseColor }));
		baseMesh.name = 'base';
		exportGroup.add(baseMesh);

		let exportBorderZ = plateauZ + LAYER_GAP;
		const borderPreview = group.children.find((child) => child.name === 'border');
		if (borderPreview) {
			exportBorderZ = borderPreview.position.z;
		}

		const borderMesh = new THREE.Mesh(
			buildExportSolidGeometry(borderSourceGeometry, borderDepthSafe, exportBorderZ),
			new THREE.MeshBasicMaterial({ color: accentColor })
		);
		borderMesh.name = 'border';
		exportGroup.add(borderMesh);

		for (const child of group.children) {
			const mesh = child as THREE.Mesh;
			if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.geometry) continue;
			if (!['text', 'text-outline', 'text-outline-border'].includes(mesh.name)) continue;
			const sceneMat = (
				Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
			) as THREE.Material & { color?: THREE.Color };
			const color = sceneMat.color?.clone() ?? new THREE.Color(accentColor);
			const textGeo = cleanExportGeometry(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
			const textMesh = new THREE.Mesh(textGeo, new THREE.MeshBasicMaterial({ color }));
			textMesh.name = mesh.name;
			exportGroup.add(textMesh);
		}

		exportGroup.updateWorldMatrix(true, true);
		if (exportGroup.children.length === 0) throw new Error('No geometry to export');
		return exportGroup;
	}

	async function exportStl() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		if (!group || group.children.length === 0) {
			exportError = 'Nothing to export';
			return;
		}
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
			disposeObject3D(exportGroup);
			if (geometries.length === 0) {
				exportError = 'Nothing to export';
				return;
			}
			const merged =
				geometries.length === 1 ? geometries[0] : BufferGeometryUtils.mergeGeometries(geometries);
			if (!merged) {
				geometries.forEach((g) => g.dispose());
				disposeObject3D(exportGroup);
				exportError = 'Failed to merge geometry';
				return;
			}
			if (geometries.length > 1) geometries.forEach((g) => g.dispose());
			const welded = BufferGeometryUtils.mergeVertices(merged, WELD_TOL_MM);
			if (welded !== merged) merged.dispose();

			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
			welded.dispose();
			const buffer = result instanceof DataView ? result.buffer : result;
			if (!buffer || (buffer as ArrayBuffer).byteLength < 84) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${SLUG}-${timestamp}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
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
		if (!group) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${SLUG}-${timestamp}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
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
		if (!group) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		openBambuStudioLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, SLUG);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			openBambuStudioLoading = false;
		}
	}

	$effect(() => {
		void fontKey;
		void borderDepth;
		void baseColor;
		void accentColor;
		void lineSpacing;
		void lines;
		void textOutlineEnabled;
		void textOutlineThicknessMm;
		void textOutlineDepth;
		void textOutlineColor;
		saveSettings();
	});

	$effect(() => {
		void baseSourceGeometry;
		void borderSourceGeometry;
		void borderDepth;
		void fontKey;
		void baseColor;
		void accentColor;
		void lineSpacing;
		void lines;
		void textOutlineEnabled;
		void textOutlineThicknessMm;
		void textOutlineDepth;
		void textOutlineColor;
		void maxTextOutlineMm;
		if (!scene || !group || !sceneReady) return;
		rebuildMeshes();
	});

	$effect(() => {
		void user?.id;
		void syncCustomPresetsFromAccount();
	});

	$effect(() => {
		void baseColor;
		void accentColor;
		void textOutlineColor;
		void textOutlineEnabled;
		activePresetId = findMatchingPresetId(galleryPresets);
	});

	onMount(() => {
		if (!hostEl) return;
		mountGeneration += 1;
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
		scene.add(fillLight);

		group = new THREE.Group();
		scene.add(group);

		const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
		grid.rotateX(Math.PI / 2);
		grid.position.z = -0.01;
		scene.add(grid);

		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();

		void loadBagTagModels();

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
		baseSourceGeometry?.dispose();
		borderSourceGeometry?.dispose();
		baseSourceGeometry = null;
		borderSourceGeometry = null;
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
	<div class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]"
		>
			<div class="mb-4 flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Whistle Bag Tag</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<p class="text-xs text-slate-500">
					Whistle bag tag with base plate, border rim, and raised multiline text (border and text
					share one color).
				</p>

				{#if loadError}
					<p class="text-sm text-red-600">{loadError}</p>
				{/if}

				<div>
					<label for="bag-tag-font" class="mb-1 block text-xs font-medium text-slate-700">Font</label>
					<FontSelect id="bag-tag-font" bind:value={fontKey} />
				</div>

				<div class="space-y-2">
					<div class="flex items-center justify-between gap-2">
						<p class="text-xs font-medium text-slate-700">Text lines</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							class="h-7 px-2 text-[11px]"
							disabled={lines.length >= MAX_LINES}
							onclick={() => addLine()}
						>
							+ Line
						</Button>
					</div>

					{#each lines as line, idx (idx)}
						<div class="rounded-xl border border-slate-200 bg-slate-50/60 p-2.5">
							<div class="mb-2 flex items-center justify-between gap-2">
								<span class="text-[11px] font-medium text-slate-600">Line {idx + 1}</span>
								<div class="flex gap-1">
									<Button
										type="button"
										variant="outline"
										size="sm"
										class="h-6 w-6 p-0"
										disabled={idx === 0}
										aria-label="Move line up"
										onclick={() => moveLine(idx, -1)}
									>
										↑
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										class="h-6 w-6 p-0"
										disabled={idx === lines.length - 1}
										aria-label="Move line down"
										onclick={() => moveLine(idx, 1)}
									>
										↓
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										class="h-6 px-2 text-[10px]"
										disabled={lines.length <= 1}
										onclick={() => removeLine(idx)}
									>
										Remove
									</Button>
								</div>
							</div>
							<input
								type="text"
								placeholder="Line text"
								class="mb-2 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
								bind:value={line.content}
							/>
							<div class="flex items-center justify-between gap-2">
								<label class="text-[11px] text-slate-600" for="bag-tag-line-size-{idx}">
									Size
								</label>
								<span class="text-[11px] text-slate-500">{line.sizeMm.toFixed(1)} mm</span>
							</div>
							<Slider
								id="bag-tag-line-size-{idx}"
								type="single"
								bind:value={line.sizeMm}
								min={3}
								max={18}
								step={0.5}
								class="w-full"
							/>
						</div>
					{/each}
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="bag-tag-line-spacing" class="text-xs font-medium text-slate-700">
							Line spacing
						</label>
						<span class="text-xs text-slate-500">{lineSpacing.toFixed(1)} mm</span>
					</div>
					<Slider
						id="bag-tag-line-spacing"
						type="single"
						bind:value={lineSpacing}
						min={0}
						max={6}
						step={0.1}
						class="w-full"
					/>
				</div>

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="flex items-center justify-between gap-2">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Base & border</div>
						{#if basePlanSize}
							<span class="shrink-0 text-xs text-slate-500 tabular-nums">
								{basePlanSize.x.toFixed(1)} x {basePlanSize.y.toFixed(1)} mm
							</span>
						{/if}
					</div>
					<ColorPalettePicker bind:value={baseColor} {palette} label="Base color" />
					<ColorPalettePicker bind:value={accentColor} {palette} label="Border & text color" />

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

				<div class="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="flex items-center justify-between gap-2">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Text outline</div>
						<label class="flex items-center gap-2 text-xs font-medium text-slate-700">
							<input
								class="h-4 w-4 accent-indigo-500"
								type="checkbox"
								bind:checked={textOutlineEnabled}
							/>
							Enabled
						</label>
					</div>
					<p class="text-[11px] leading-snug text-slate-500">
						Middle layer between letters and the base/border stack (with a matching border frame).
					</p>
					{#if textOutlineEnabled}
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Text outline thickness</span>
								<span class="text-xs tabular-nums text-slate-600"
									>{textOutlineThicknessMm.toFixed(1)} mm</span
								>
							</div>
							<Slider
								type="single"
								bind:value={textOutlineThicknessMm}
								min={0.2}
								max={maxTextOutlineMm}
								step={0.1}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Text outline depth</span>
								<span class="text-xs tabular-nums text-slate-600">{textOutlineDepth} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={textOutlineDepth}
								min={0.2}
								max={3}
								step={0.1}
								class="w-full"
							/>
						</label>
						<ColorPalettePicker
							bind:value={textOutlineColor}
							{palette}
							label="Text outline color"
						/>
					{/if}
				</div>

				<div class="grid gap-2 rounded-2xl border border-violet-200/80 bg-violet-50/50 p-3">
					<p class="text-xs font-semibold tracking-tight text-slate-800">Preset gallery</p>
					{#if user}
						<p class="text-[11px] text-slate-500">
							{#if hasGalleryPresets}
								Click a preset to apply its colors. Edit or delete any preset. Saved to your account.
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
										onclick={() => void importDefaultPresets()}
									>
										{importPresetsLoading ? 'Importing…' : 'Import default presets'}
									</Button>
								{/if}
								<Button
									type="button"
									variant="outline"
									size="sm"
									class="h-7 px-2 text-[11px]"
									onclick={openCreatePresetEditor}
								>
									+ New
								</Button>
							</div>
						</div>

						{#if !hasGalleryPresets && !customPresetsLoading}
							<p
								class="rounded-lg border border-dashed border-violet-200 bg-white/60 px-3 py-4 text-center text-[11px] text-slate-600"
							>
								Import default presets to get {DEFAULT_WHISTLE_BAG_TAG_COLOR_PRESETS.length} editable
								color combos, or use + New to add one.
							</p>
						{/if}

						<div class="grid grid-cols-3 gap-2">
							{#each galleryPresets as preset (preset.id)}
								<div class="relative">
									<button
										type="button"
										class={[
											'w-full overflow-hidden rounded-lg border bg-white pr-6 text-left shadow-sm transition hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60',
											activePresetId === preset.id
												? 'border-indigo-400 ring-2 ring-indigo-400/30'
												: 'border-slate-200/90 hover:border-slate-300'
										].join(' ')}
										aria-pressed={activePresetId === preset.id}
										aria-label={`Apply ${preset.label} colors`}
										onclick={() => applyColorPreset(preset)}
									>
										<div class="flex h-11 w-full">
											<span
												class="min-w-0 flex-1"
												style:background-color={preset.baseColor}
												aria-hidden="true"
											></span>
											<span
												class="min-w-0 flex-1 border-x border-white/20"
												style:background-color={preset.textOutlineColor}
												aria-hidden="true"
											></span>
											<span
												class="min-w-0 flex-1"
												style:background-color={preset.accentColor}
												aria-hidden="true"
											></span>
										</div>
										<span
											class="block border-t border-slate-100 px-1 py-1.5 text-center text-[10px] font-medium leading-tight text-slate-700"
										>
											{preset.label}
										</span>
									</button>
									<button
										type="button"
										class="absolute top-0.5 right-0.5 rounded bg-white/90 px-1 py-0.5 text-[9px] font-medium text-slate-600 shadow-sm hover:bg-white hover:text-indigo-700"
										aria-label={`Edit ${preset.label}`}
										onclick={(e) => {
											e.stopPropagation();
											openEditPresetEditor(preset);
										}}
									>
										Edit
									</button>
								</div>
							{/each}
						</div>
					{:else}
						<p class="text-[11px] leading-relaxed text-slate-600">
							Save and reuse color combinations. Import {DEFAULT_WHISTLE_BAG_TAG_COLOR_PRESETS.length} starter
							presets, create your own, and sync them to your account.
						</p>
						<Button type="button" size="sm" class="w-full" onclick={onRequestLogin}>
							Sign in to use presets
						</Button>
						<p class="text-[10px] font-medium tracking-wide text-slate-500 uppercase">
							Starter presets (preview)
						</p>
						<div class="grid grid-cols-3 gap-2 opacity-90" aria-hidden="true">
							{#each DEFAULT_WHISTLE_BAG_TAG_COLOR_PRESETS as template (template.label)}
								<div class="overflow-hidden rounded-lg border border-slate-200/90 bg-white shadow-sm">
									<div class="flex h-11 w-full">
										<span
											class="min-w-0 flex-1"
											style:background-color={snapColorToPalette(
												template.baseColor,
												palette,
												template.baseColor
											)}
										></span>
										<span
											class="min-w-0 flex-1 border-x border-white/20"
											style:background-color={snapColorToPalette(
												template.textOutlineColor,
												palette,
												template.textOutlineColor
											)}
										></span>
										<span
											class="min-w-0 flex-1"
											style:background-color={snapColorToPalette(
												template.accentColor,
												palette,
												template.accentColor
											)}
										></span>
									</div>
									<span
										class="block border-t border-slate-100 px-1 py-1.5 text-center text-[10px] font-medium leading-tight text-slate-600"
									>
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
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0"></div>
			<div class="absolute bottom-4 right-4">
				<DesignerExportToolbar
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, SLUG)}
					onExport={() => exportStl()}
					exportDisabled={!sceneReady || exportLoading}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF')}
					onExport3MF={() => export3MF()}
					onOpenWithBambuStudio={() => openWithBambuStudio()}
					openBambuStudioLoading={openBambuStudioLoading}
					{exportLoading}
					showLockIcon={!user || !subscriptionStatus?.isActive}
				/>
			</div>
		</section>
	</div>

	{#if user}
		<Dialog.Root bind:open={presetEditorOpen} onOpenChange={onPresetEditorOpenChange}>
			<Dialog.Content class="max-w-md rounded-2xl border-slate-200 shadow-xl">
				<Dialog.Header>
					<Dialog.Title>
						{presetEditorMode === 'edit' ? 'Edit preset' : 'New preset'}
					</Dialog.Title>
					<Dialog.Description class="text-sm text-slate-600">
						{#if presetEditorMode === 'edit'}
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
							placeholder="My preset"
						/>
					</label>
					<label class="flex items-center gap-2 text-xs font-medium text-slate-700">
						<input
							type="checkbox"
							class="h-4 w-4 accent-indigo-500"
							bind:checked={presetEditorTextOutlineEnabled}
						/>
						Text outline layer enabled
					</label>
					<ColorPalettePicker bind:value={presetEditorBase} {palette} paletteOnly label="Base" />
					<ColorPalettePicker
						bind:value={presetEditorTextOutline}
						{palette}
						paletteOnly
						label="Text outline"
					/>
					<ColorPalettePicker
						bind:value={presetEditorAccent}
						{palette}
						paletteOnly
						label="Border & text"
					/>
				</div>

				<Dialog.Footer class="flex flex-wrap items-center gap-2">
					{#if presetEditorMode === 'edit' && presetEditorId}
						<Button
							type="button"
							variant="outline"
							class="text-red-600 hover:text-red-700"
							onclick={() => void deleteCustomPreset(presetEditorId!)}
						>
							Delete
						</Button>
					{/if}
					<div class="flex flex-wrap gap-2 sm:ml-auto">
						<Button type="button" variant="outline" onclick={closePresetEditor}>Cancel</Button>
						<Button type="button" onclick={() => void commitPresetEditor()}>Save preset</Button>
					</div>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog.Root>
	{/if}
</main>
