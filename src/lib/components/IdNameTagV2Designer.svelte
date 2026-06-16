<script lang="ts">
	import { snapColorToPalette, type PaletteColor } from '$lib/colorPalette';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import ClipperLib from 'clipper-lib';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		cloneDefaultIdNameTagV2PresetsAsCustom,
		DEFAULT_ID_NAME_TAG_V2_COLOR_PRESETS,
		isCustomIdNameTagV2PresetId,
		loadUserIdNameTagV2Presets,
		persistIdNameTagV2CustomPresets,
		type IdNameTagV2ColorPreset
	} from '$lib/idNameTagV2Presets';
	import { notifyExportEvent } from '$lib/exportNotify';
	import base1StlUrl from '$lib/assets/stl/idnametag/base1.stl?url';
	import base1bStlUrl from '$lib/assets/stl/idnametag/base1b.stl?url';
	import base2StlUrl from '$lib/assets/stl/idnametag/base2.stl?url';
	import base2bStlUrl from '$lib/assets/stl/idnametag/base2b.stl?url';
	import base3StlUrl from '$lib/assets/stl/idnametag/base3.stl?url';
	import base3bStlUrl from '$lib/assets/stl/idnametag/base3b.stl?url';
	import base4StlUrl from '$lib/assets/stl/idnametag/base4.stl?url';
	import base4bStlUrl from '$lib/assets/stl/idnametag/base4b.stl?url';
	import border1StlUrl from '$lib/assets/stl/idnametag/border1.stl?url';
	import border2StlUrl from '$lib/assets/stl/idnametag/border2.stl?url';
	import border3StlUrl from '$lib/assets/stl/idnametag/border3.stl?url';
	import border4StlUrl from '$lib/assets/stl/idnametag/border4.stl?url';
	import { ensureExportAccess, getExportTitle, showExportLockIcon, type SubscriptionStatus } from '$lib/subscription';
	import { FEATURE_FLAG_KEYS } from '$lib/featureFlags';
	import { userFeatureFlags } from '$lib/userFeatureFlags.svelte';
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
	import { onDestroy, onMount, tick } from 'svelte';
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
	const TEXT_MAX_WIDTH_RATIO = 0.9;
	/** Match BasicName: sink text into the base in preview/single-mesh STL to avoid coplanar contact. */
	const TEXT_BASE_EMBED = 0.2;
	/** Match BasicName: sink border slightly so its bottom face is not coplanar with the base top face. */
	const BORDER_BASE_EMBED = 0.05;
	/** Preview only: show back text below the tag so it's visible (export stays embedded inside base). */
	const BACK_TEXT_PREVIEW_GAP_MM = 0.005;
	/** Back inlay thickness (fixed). */
	const BACK_TEXT_DEPTH_MM = 0.4;
	const WELD_TOL_MM = 1e-3;
	const TOP_LOOP_SNAP_MM = 1e-4;
	/** Vertical gap between stacked layers so faces do not touch. */
	const LAYER_GAP = 0.001;
	const CLIPPER_SCALE = 1000;
	/** Ignore hole loops smaller than this fraction of the outer loop area (avoids spurious inner loops on some STLs). */
	const HOLE_MIN_AREA_RATIO = 0.005;
	const DEFAULT_DETAIL_COLOR = '#1f2937';

	type ModelPairId = 1 | 2 | 3 | 4;
	type LaceHolderStyle = 'single' | 'dual';

	type ModelPair = {
		id: ModelPairId;
		label: string;
		baseUrl: string;
		dualBaseUrl: string;
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

	type TextLineEntry = { geo: THREE.BufferGeometry; height: number; depth: number; color: string };
	type FrontTextLineEntry = TextLineEntry & {
		centeredPaths: { X: number; Y: number }[][];
		yCenter: number;
	};
	type TopLoop = THREE.Vector2[];
	type BoundaryEdge = { a: string; b: string };
	type BoundaryEdgeCount = BoundaryEdge & { count: number };
	type AdjacencyByKey = Record<string, string[] | undefined>;
	type BoundaryEdgesByKey = Record<string, BoundaryEdgeCount | undefined>;
	type PointsByKey = Record<string, THREE.Vector2 | undefined>;
	type VisitedEdgesByKey = Record<string, true | undefined>;

	interface Settings {
		modelPairId: ModelPairId;
		laceHolderStyle: LaceHolderStyle;
		baseDepth: number;
		borderDepth: number;
		baseColor: string;
		commonColor: string;
		borderColor: string;
		lines: IdNameTagV2Line[];
		lineSpacing: number;
		backLines: IdNameTagV2Line[];
		backLineSpacing: number;
		textOutlineEnabled: boolean;
		textOutlineThicknessMm: number;
		textOutlineDepth: number;
		textOutlineColor: string;
	}

	const MODEL_PAIRS: ModelPair[] = [
		{
			id: 1,
			label: 'Bubble',
			baseUrl: base1StlUrl,
			dualBaseUrl: base1bStlUrl,
			borderUrl: border1StlUrl
		},
		{
			id: 2,
			label: 'Ribbon',
			baseUrl: base2StlUrl,
			dualBaseUrl: base2bStlUrl,
			borderUrl: border2StlUrl
		},
		{
			id: 3,
			label: 'Soft',
			baseUrl: base3StlUrl,
			dualBaseUrl: base3bStlUrl,
			borderUrl: border3StlUrl
		},
		{
			id: 4,
			label: 'Classic',
			baseUrl: base4StlUrl,
			dualBaseUrl: base4bStlUrl,
			borderUrl: border4StlUrl
		}
	];

	const LACE_HOLDER_OPTIONS: { id: LaceHolderStyle; label: string; hint: string }[] = [
		{ id: 'single', label: 'Single', hint: 'One center loop' },
		{ id: 'dual', label: 'Dual', hint: 'Left and right loops' }
	];

	function isLaceHolderStyle(v: unknown): v is LaceHolderStyle {
		return v === 'single' || v === 'dual';
	}

	function getBaseUrl(pair: ModelPair, laceHolder: LaceHolderStyle): string {
		return laceHolder === 'dual' ? pair.dualBaseUrl : pair.baseUrl;
	}

	function modelLoadKey(pairId: ModelPairId, laceHolder: LaceHolderStyle): string {
		return `${pairId}-${laceHolder}`;
	}

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
		laceHolderStyle: 'single',
		baseDepth: 2,
		borderDepth: 1,
		baseColor: '#ffffff',
		commonColor: DEFAULT_DETAIL_COLOR,
		borderColor: DEFAULT_DETAIL_COLOR,
		lines: [
			createLine({ content: 'Nickname', size: 18, depth: 1 }),
			createLine({ content: 'Full name', size: 9, depth: 1 })
		],
		lineSpacing: 5,
		backLines: [],
		backLineSpacing: 5,
		textOutlineEnabled: false,
		textOutlineThicknessMm: 1,
		textOutlineDepth: 0.6,
		textOutlineColor: '#ffffff'
	};

	function clamp(v: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, v));
	}

	function isFiniteNumber(v: unknown): v is number {
		return typeof v === 'number' && Number.isFinite(v);
	}

	function isModelPairId(v: unknown): v is ModelPairId {
		return v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
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
			if (!stored)
				return {
					...defaults,
					lines: cloneDefaultLines(),
					backLines: cloneDefaultLines()
				};
			const parsed = JSON.parse(stored);
			if (!parsed || typeof parsed !== 'object') {
				return {
					...defaults,
					lines: cloneDefaultLines(),
					backLines: cloneDefaultLines()
				};
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

			const rawBackLines: unknown[] | null = Array.isArray((parsed as Settings).backLines)
				? (((parsed as Settings).backLines as unknown[]) ?? null)
				: null;
			const backLines = rawBackLines
				? rawBackLines
						.map((line) => sanitizeLine(line, lineFallbackColor))
						.filter((line: IdNameTagV2Line | null): line is IdNameTagV2Line => line !== null)
				: cloneDefaultLines(lineFallbackColor);
			return {
				modelPairId: isModelPairId(parsed.modelPairId) ? parsed.modelPairId : defaults.modelPairId,
				laceHolderStyle: isLaceHolderStyle(parsed.laceHolderStyle)
					? parsed.laceHolderStyle
					: defaults.laceHolderStyle,
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
					: defaults.lineSpacing,
				backLines: backLines.length > 0 ? backLines : cloneDefaultLines(lineFallbackColor),
				backLineSpacing: isFiniteNumber((parsed as Settings).backLineSpacing)
					? clamp((parsed as Settings).backLineSpacing, 0, 20)
					: defaults.backLineSpacing,
				textOutlineEnabled:
					typeof parsed.textOutlineEnabled === 'boolean'
						? parsed.textOutlineEnabled
						: defaults.textOutlineEnabled,
				textOutlineThicknessMm: isFiniteNumber(parsed.textOutlineThicknessMm)
					? Math.min(8, Math.max(0.2, parsed.textOutlineThicknessMm))
					: defaults.textOutlineThicknessMm,
				textOutlineDepth: isFiniteNumber(parsed.textOutlineDepth)
					? Math.min(5, Math.max(0.2, parsed.textOutlineDepth))
					: defaults.textOutlineDepth,
				textOutlineColor:
					typeof parsed.textOutlineColor === 'string'
						? parsed.textOutlineColor
						: defaults.textOutlineColor
			};
		} catch {
			return {
				...defaults,
				lines: cloneDefaultLines(),
				backLines: cloneDefaultLines()
			};
		}
	}

	const initial = loadSettings();

	let selectedPairId = $state<ModelPairId>(initial.modelPairId);
	let laceHolderStyle = $state<LaceHolderStyle>(initial.laceHolderStyle);
	let baseDepth = $state(initial.baseDepth);
	let borderDepth = $state(initial.borderDepth);
	let baseColor = $state(initial.baseColor);
	let commonColor = $state(initial.commonColor);
	let borderColor = $state(initial.borderColor);
	let lines = $state<IdNameTagV2Line[]>(initial.lines.map((line) => ({ ...line })));
	let lineSpacing = $state(initial.lineSpacing);
	let backLines = $state<IdNameTagV2Line[]>(initial.backLines.map((line) => ({ ...line })));
	let backLineSpacing = $state(initial.backLineSpacing);
	let textOutlineEnabled = $state(initial.textOutlineEnabled);
	let textOutlineThicknessMm = $state(initial.textOutlineThicknessMm);
	let textOutlineDepth = $state(initial.textOutlineDepth);
	let textOutlineColor = $state(initial.textOutlineColor);
	let activeTextSide = $state<'front' | 'back'>('front');
	let activePresetId = $state<string | null>(null);
	let customPresets = $state<IdNameTagV2ColorPreset[]>([]);
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
	let presetEditorBase = $state('#ffffff');
	let presetEditorBorder = $state('#1f2937');
	let presetEditorText = $state('#1f2937');
	let presetEditorTextOutline = $state('#ffffff');
	let presetEditorTextOutlineEnabled = $state(false);

	function snapPresetColors(base: string, border: string, text: string, textOutline: string) {
		return {
			base: snapColorToPalette(base, palette, baseColor),
			border: snapColorToPalette(border, palette, borderColor),
			text: snapColorToPalette(text, palette, commonColor),
			textOutline: snapColorToPalette(textOutline, palette, textOutlineColor)
		};
	}

	function findMatchingPresetId(presets: IdNameTagV2ColorPreset[]): string | null {
		for (const preset of presets) {
			if (
				preset.baseColor === baseColor &&
				preset.borderColor === borderColor &&
				preset.textColor === commonColor &&
				preset.textOutlineColor === textOutlineColor &&
				(preset.textOutlineEnabled ?? false) === textOutlineEnabled
			) {
				return preset.id;
			}
		}
		return null;
	}

	function applyColorPreset(preset: IdNameTagV2ColorPreset) {
		const snapped = snapPresetColors(
			preset.baseColor,
			preset.borderColor,
			preset.textColor,
			preset.textOutlineColor
		);
		baseColor = snapped.base;
		borderColor = snapped.border;
		commonColor = snapped.text;
		lines = lines.map((line) => ({ ...line, color: snapped.text }));
		backLines = backLines.map((line) => ({ ...line, color: snapped.text }));
		textOutlineColor = snapped.textOutline;
		textOutlineEnabled = preset.textOutlineEnabled ?? false;
		activePresetId = findMatchingPresetId(galleryPresets) ?? preset.id;
	}

	function setPresetEditorColors(base: string, border: string, text: string, textOutline: string) {
		const snapped = snapPresetColors(base, border, text, textOutline);
		presetEditorBase = snapped.base;
		presetEditorBorder = snapped.border;
		presetEditorText = snapped.text;
		presetEditorTextOutline = snapped.textOutline;
	}

	function openCreatePresetEditor() {
		presetEditorMode = 'create';
		presetEditorId = null;
		presetEditorLabel = 'My preset';
		presetEditorTextOutlineEnabled = textOutlineEnabled;
		setPresetEditorColors(baseColor, borderColor, commonColor, textOutlineColor);
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
			customPresets = await loadUserIdNameTagV2Presets(userId);
			activePresetId = findMatchingPresetId(galleryPresets);
		} catch (e) {
			presetSyncError = e instanceof Error ? e.message : 'Failed to load presets';
		} finally {
			customPresetsLoading = false;
		}
	}

	async function persistCustomPresets(presets: IdNameTagV2ColorPreset[]) {
		if (!user?.id) return;
		const result = await persistIdNameTagV2CustomPresets(user.id, presets);
		if (!result.success) {
			presetSyncError = result.error;
			return;
		}
		presetSyncError = null;
	}

	function openEditPresetEditor(preset: IdNameTagV2ColorPreset) {
		presetEditorMode = 'edit';
		presetEditorId = preset.id;
		presetEditorLabel = preset.label;
		presetEditorTextOutlineEnabled = preset.textOutlineEnabled ?? false;
		setPresetEditorColors(
			preset.baseColor,
			preset.borderColor,
			preset.textColor,
			preset.textOutlineColor
		);
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
			presetEditorBorder,
			presetEditorText,
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
							borderColor: snapped.border,
							textColor: snapped.text,
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
					borderColor: snapped.border,
					textColor: snapped.text,
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
			borderColor: snapped.border,
			textColor: snapped.text,
			textOutlineColor: snapped.textOutline,
			textOutlineEnabled: enabled
		});
		await persistCustomPresets(customPresets);
		closePresetEditor();
	}

	async function deleteCustomPreset(id: string) {
		if (!isCustomIdNameTagV2PresetId(id)) return;
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
			customPresets = cloneDefaultIdNameTagV2PresetsAsCustom((hex, fallback) =>
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
	const backPrintDevOverride =
		import.meta.env.DEV &&
		typeof window !== 'undefined' &&
		new URL(window.location.href).searchParams.get('backprint') === '1';
	const backPrintEnabled = $derived(
		backPrintDevOverride || userFeatureFlags.has(FEATURE_FLAG_KEYS.ID_NAME_TAG_V2_BACKPRINT)
	);

	let hostEl: HTMLDivElement | null = null;
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let controls: InstanceType<typeof OrbitControls> | null = null;
	let group: THREE.Group | null = null;
	let keyLight: THREE.DirectionalLight | null = null;
	let hemiLight: THREE.HemisphereLight | null = null;
	let rimLight: THREE.DirectionalLight | null = null;
	let fillLight: THREE.DirectionalLight | null = null;
	let bottomLight: THREE.DirectionalLight | null = null;
	let grid: THREE.GridHelper | null = null;
	let rafId = 0;
	let ro: ResizeObserver | null = null;
	let didInitFrame = false;
	let wasBackPreviewView = false;
	let sceneReady = $state(false);
	let exportLoading = $state(false);
	let exportError = $state<string | null>(null);
	let openBambuStudioLoading = $state(false);
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);
	let loadError = $state<string | null>(null);
	let basePlanSize = $state<{ x: number; y: number } | null>(null);
	const maxTextOutlineMm = $derived(
		Math.max(
			0.2,
			Math.min(8, basePlanSize ? Math.min(basePlanSize.x, basePlanSize.y) * 0.12 : 4)
		)
	);
	let textCenterY = $state(0);
	let baseSourceGeometry = $state<THREE.BufferGeometry | null>(null);
	let borderSourceGeometry = $state<THREE.BufferGeometry | null>(null);
	let loadToken = 0;
	let mountGeneration = 0;
	let loadedBaseKey: string | null = null;

	function frameCameraToBottomView(
		box: THREE.Box3,
		cam: THREE.PerspectiveCamera,
		ctl: InstanceType<typeof OrbitControls>
	) {
		const center = new THREE.Vector3();
		box.getCenter(center);
		const sphere = new THREE.Sphere();
		box.getBoundingSphere(sphere);
		const radius = Math.max(0.001, sphere.radius);
		const fov = (cam.fov * Math.PI) / 200;
		const dist = (radius / Math.sin(fov / 2)) * 1.15;
		cam.position.set(center.x, center.y, center.z - dist);
		cam.up.set(0, 1, 0);
		cam.near = Math.max(0.01, dist / 200);
		cam.far = Math.max(2000, dist * 20);
		cam.updateProjectionMatrix();
		cam.lookAt(center);
		ctl.target.copy(center);
		ctl.update();
	}

	function syncBackPrintPreviewView(box: THREE.Box3) {
		const isBackView = backPrintEnabled && activeTextSide === 'back';
		if (grid) grid.visible = !isBackView;
		if (controls) {
			controls.enableRotate = !isBackView;
			controls.enablePan = !isBackView;
			controls.enableZoom = !isBackView;
		}
		if (bottomLight) bottomLight.visible = isBackView;
		if (keyLight) keyLight.intensity = isBackView ? 0.55 : 2.2;
		if (rimLight) rimLight.visible = !isBackView;
		if (fillLight) fillLight.visible = !isBackView;
		if (hemiLight) hemiLight.intensity = isBackView ? 0.12 : 0.25;
		if (!camera || !controls) return;
		const center = new THREE.Vector3();
		box.getCenter(center);
		if (isBackView) {
			if (bottomLight) {
				bottomLight.position.set(center.x, center.y, center.z - 140);
				bottomLight.target.position.copy(center);
				bottomLight.target.updateWorldMatrix(true, true);
			}
			frameCameraToBottomView(box, camera, controls);
		} else if (!didInitFrame || wasBackPreviewView) {
			camera.up.set(0, 0, 1);
			frameCameraToObject(box, camera, controls);
			if (!didInitFrame) didInitFrame = true;
		}
		wasBackPreviewView = isBackView;
	}

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
				laceHolderStyle,
				baseDepth,
				borderDepth,
				baseColor,
				commonColor,
				borderColor,
				lines,
				lineSpacing,
				backLines,
				backLineSpacing,
				textOutlineEnabled,
				textOutlineThicknessMm,
				textOutlineDepth,
				textOutlineColor
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

	function mirrorGeometryX(geo: THREE.BufferGeometry): THREE.BufferGeometry {
		// Negative scale flips winding; force non-indexed and swap triangle order to keep outward normals.
		let g = geo.index ? geo.toNonIndexed() : geo.clone();
		if (g !== geo) geo.dispose();
		g.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
		const pos = g.getAttribute('position');
		if (pos) {
			for (let i = 0; i < pos.count; i += 3) {
				// swap 2nd and 3rd vertex
				const x1 = pos.getX(i + 1);
				const y1 = pos.getY(i + 1);
				const z1 = pos.getZ(i + 1);
				const x2 = pos.getX(i + 2);
				const y2 = pos.getY(i + 2);
				const z2 = pos.getZ(i + 2);
				pos.setXYZ(i + 1, x2, y2, z2);
				pos.setXYZ(i + 2, x1, y1, z1);
			}
			pos.needsUpdate = true;
		}
		g.computeVertexNormals();
		g.computeBoundingBox();
		return g;
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

	function buildTextLineEntriesFrom(
		sourceLines: IdNameTagV2Line[],
		options: { fixedDepthMm?: number } = {}
	): TextLineEntry[] {
		const lineEntries: TextLineEntry[] = [];
		const maxTextWidth = Math.max(1, (basePlanSize?.x ?? 100) * TEXT_MAX_WIDTH_RATIO);
		for (const line of sourceLines) {
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
			const extrudeDepth =
				options.fixedDepthMm != null
					? Math.max(0.05, options.fixedDepthMm)
					: Math.max(0.05, line.depth);
			const geo = new THREE.ExtrudeGeometry(shapes, {
				depth: extrudeDepth,
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
			const depth = Math.max(0.001, bb.max.z - bb.min.z);
			lineEntries.push({
				geo,
				height: Math.max(0.001, bb.max.y - bb.min.y),
				depth,
				color: line.color
			});
		}
		return lineEntries;
	}

	function buildBackTextLineEntries(): TextLineEntry[] {
		return buildTextLineEntriesFrom(backLines, { fixedDepthMm: BACK_TEXT_DEPTH_MM });
	}

	function buildFrontTextLineEntries(): FrontTextLineEntry[] {
		const SCALE = CLIPPER_SCALE;
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
						X: Math.round(p.x * SCALE),
						Y: Math.round(p.y * SCALE)
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

			let clipperPaths: { X: number; Y: number }[][] = [];
			for (const shape of shapes) {
				clipperPaths.push(...shapeToClipperPaths(shape));
			}

			const extrudeDepth = Math.max(0.05, line.depth);
			const geo = new THREE.ExtrudeGeometry(shapes, {
				depth: extrudeDepth,
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
			let fitScale = 1;
			if (width > maxTextWidth) {
				fitScale = maxTextWidth / width;
				geo.scale(fitScale, fitScale, 1);
				bottomAlignGeometry(geo);
				bb = geo.boundingBox;
			}
			if (!bb) {
				geo.dispose();
				continue;
			}
			const cx = (bb.min.x + bb.max.x) / 2;
			const cy = (bb.min.y + bb.max.y) / 2;
			const centeredPaths = clipperPaths.map((path) =>
				path.map((pt) => ({
					X: Math.round((pt.X / SCALE - cx) * fitScale * SCALE),
					Y: Math.round((pt.Y / SCALE - cy) * fitScale * SCALE)
				}))
			);
			const depth = Math.max(0.001, bb.max.z - bb.min.z);
			lineEntries.push({
				geo,
				height: Math.max(0.001, bb.max.y - bb.min.y),
				depth,
				color: line.color,
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

	async function loadSelectedModelPair(pair: ModelPair, laceHolder: LaceHolderStyle) {
		const generation = mountGeneration;
		const token = ++loadToken;
		loadError = null;
		const loader = new STLLoader();
		const baseUrl = getBaseUrl(pair, laceHolder);
		try {
			const [baseGeo, borderGeo] = await Promise.all([
				loadStlGeometry(loader, baseUrl),
				loadStlGeometry(loader, pair.borderUrl)
			]);
			normalizeImportedGeometry(baseGeo);
			normalizeImportedGeometry(borderGeo);
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
		const borderZ = baseDepthSafe - BORDER_BASE_EMBED;
		const textZ = baseDepthSafe - TEXT_BASE_EMBED;
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

		const borderShape = buildTopPerimeterShape(borderSourceGeometry);
		const frontEntries = buildFrontTextLineEntries();
		const hasTextOutlineLayer =
			textOutlineEnabled && textOutlineThicknessMm > 0 && frontEntries.length > 0;

		let stackTopZ = baseDepthSafe;

		if (hasTextOutlineLayer && borderShape) {
			const textOutlineWorld = Math.min(
				Math.max(0.1, textOutlineThicknessMm),
				maxTextOutlineMm
			);
			const textOutlineZ = stackTopZ + LAYER_GAP;
			addExtrudedBorderLayer(
				borderShape,
				textOutlineZ,
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
				textOutlineMesh.position.set(0, textCenterY + entry.yCenter, textOutlineZ);
				group.add(textOutlineMesh);
				addedTextOutline = true;
			}
			if (addedTextOutline) {
				stackTopZ = textOutlineZ + textOutlineDepth;
			}
		}

		const mainLayerZ = hasTextOutlineLayer ? stackTopZ + LAYER_GAP : borderZ;
		const frontTextZ = hasTextOutlineLayer ? mainLayerZ : textZ;

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
						color: entry.color,
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

		if (backPrintEnabled) {
			const backLineEntries = buildBackTextLineEntries();
			if (backLineEntries.length > 0) {
				const gap = Math.max(0, backLineSpacing);
				const totalHeight =
					backLineEntries.reduce((acc, entry) => acc + entry.height, 0) +
					Math.max(0, backLineEntries.length - 1) * gap;
				let yCursor = totalHeight / 2;
				for (const entry of backLineEntries) {
					const yCenter = yCursor - entry.height / 2;
					yCursor -= entry.height + gap;
					const backGeo = mirrorGeometryX(entry.geo.clone());
					const textMesh = new THREE.Mesh(
						backGeo,
						new THREE.MeshStandardMaterial({
							color: entry.color,
							roughness: 0.35,
							metalness: 0.1
						})
					);
					textMesh.name = 'text-back';
					textMesh.castShadow = true;
					textMesh.receiveShadow = true;
					// Preview: show below the tag (export embeds inside base at z≈0.02).
					textMesh.position.set(
						0,
						textCenterY + yCenter,
						-(BACK_TEXT_PREVIEW_GAP_MM)
					);
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
			cam.updateProjectionMatrix();
			keyLight.target.position.copy(center);
			keyLight.target.updateWorldMatrix(true, true);
		}
		syncBackPrintPreviewView(box);
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
		const backInlayZ = -0.005; // lift inlay so it doesn't share the z=0 underside plane

		const baseGeo = buildExportSolidGeometry(baseSourceGeometry, baseDepthSafe);

		// Back inlay meshes (embedded inside base; per-line colors for multi-material 3MF).
		const backLineEntries = backPrintEnabled ? buildBackTextLineEntries() : [];
		if (backLineEntries.length > 0) {
			const gap = Math.max(0, backLineSpacing);
			const totalHeight =
				backLineEntries.reduce((acc, entry) => acc + entry.height, 0) +
				Math.max(0, backLineEntries.length - 1) * gap;
			let yCursor = totalHeight / 2;

			let backLineIndex = 0;
			for (const entry of backLineEntries) {
				const yCenter = yCursor - entry.height / 2;
				yCursor -= entry.height + gap;

				const baseLine = mirrorGeometryX(entry.geo.clone());
				baseLine.translate(0, textCenterY + yCenter, backInlayZ);
				const inlayMesh = new THREE.Mesh(
					cleanExportGeometry(baseLine),
					new THREE.MeshBasicMaterial({ color: new THREE.Color(entry.color) })
				);
				const count = backLineEntries.length;
				inlayMesh.name = count > 1 ? `text-back-${backLineIndex}` : 'text-back';
				exportGroup.add(inlayMesh);
				backLineIndex++;
			}
		}

		const baseMesh = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({ color: baseColor }));
		baseMesh.name = 'base';
		exportGroup.add(baseMesh);

		let exportBorderZ = borderZ;
		const borderPreview = group.children.find((child) => child.name === 'border');
		if (borderPreview) {
			exportBorderZ = borderPreview.position.z;
		}

		const borderMesh = new THREE.Mesh(
			buildExportSolidGeometry(borderSourceGeometry, borderDepthSafe, exportBorderZ),
			new THREE.MeshBasicMaterial({ color: borderColor })
		);
		borderMesh.name = 'border';
		exportGroup.add(borderMesh);

		for (const child of group.children) {
			const mesh = child as THREE.Mesh;
			if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.geometry) continue;
			// Front text comes from preview group. Back text is handled above.
			if (!['text', 'text-outline', 'text-outline-border'].includes(mesh.name)) continue;
			const sceneMat = (
				Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
			) as THREE.Material & { color?: THREE.Color };
			const color = sceneMat.color?.clone() ?? new THREE.Color(DEFAULT_DETAIL_COLOR);
			const textGeo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
			if (mesh.name === 'text' && options.liftTextOutOfEmbed) {
				textGeo.translate(0, 0, TEXT_BASE_EMBED);
			}
			const textMesh = new THREE.Mesh(textGeo, new THREE.MeshBasicMaterial({ color }));
			textMesh.name = mesh.name;
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

	function addLine(target: 'front' | 'back') {
		const current = target === 'front' ? lines : backLines;
		if (current.length >= 8) return;
		const last = current[current.length - 1];
		const next = [
			...current,
			createLine(
				last
					? {
							content: '',
							fontKey: last.fontKey,
							size: last.size,
							depth: target === 'back' ? BACK_TEXT_DEPTH_MM : last.depth,
							color: last.color
						}
					: {
							content: '',
							fontKey: DEFAULT_FONT_KEY,
							size: 12,
							depth: target === 'back' ? BACK_TEXT_DEPTH_MM : 1
						}
			)
		];
		if (target === 'front') lines = next;
		else backLines = next;
	}

	function removeLine(target: 'front' | 'back', id: string) {
		const current = target === 'front' ? lines : backLines;
		if (current.length <= 1) return;
		const next = current.filter((line) => line.id !== id);
		if (target === 'front') lines = next;
		else backLines = next;
	}

	function moveLine(target: 'front' | 'back', index: number, delta: -1 | 1) {
		const current = target === 'front' ? lines : backLines;
		const nextIndex = index + delta;
		if (nextIndex < 0 || nextIndex >= current.length) return;
		const next = [...current];
		const [item] = next.splice(index, 1);
		next.splice(nextIndex, 0, item);
		if (target === 'front') lines = next;
		else backLines = next;
	}

	function applyCommonColor(color: string) {
		commonColor = color;
		borderColor = color;
		lines = lines.map((line) => ({ ...line, color }));
		backLines = backLines.map((line) => ({ ...line, color }));
	}

	onMount(() => {
		if (!hostEl) return;

		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);

		renderer = new THREE.WebGLRenderer({
			antialias: true,
			preserveDrawingBuffer: true
		});
		renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.05;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		hostEl.appendChild(renderer.domElement);
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';

		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.screenSpacePanning = false;
		controls.minDistance = 10;
		controls.maxDistance = 800;
		controls.update();

		hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.25);
		scene.add(hemiLight);
		keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
		keyLight.position.set(80, -120, 140);
		keyLight.castShadow = true;
		keyLight.shadow.mapSize.width = 2048;
		keyLight.shadow.mapSize.height = 2048;
		keyLight.shadow.bias = -0.0002;
		keyLight.shadow.normalBias = 0.02;
		scene.add(keyLight);
		scene.add(keyLight.target);
		rimLight = new THREE.DirectionalLight(0xffffff, 0.7);
		rimLight.position.set(-120, 90, 80);
		scene.add(rimLight);
		fillLight = new THREE.DirectionalLight(0xffffff, 0.45);
		fillLight.position.set(40, 120, 60);
		scene.add(fillLight);
		bottomLight = new THREE.DirectionalLight(0xffffff, 2.4);
		bottomLight.position.set(0, 0, -140);
		bottomLight.visible = false;
		scene.add(bottomLight);
		scene.add(bottomLight.target);

		grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
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

		const pair = MODEL_PAIRS.find((p) => p.id === selectedPairId) ?? MODEL_PAIRS[0];
		loadedBaseKey = modelLoadKey(pair.id, laceHolderStyle);
		void loadSelectedModelPair(pair, laceHolderStyle);

		const renderFrame = () => {
			rafId = requestAnimationFrame(renderFrame);
			controls?.update();
			if (renderer && scene && camera) renderer.render(scene, camera);
		};
		renderFrame();

		return () => {
			ro?.disconnect();
			ro = null;
		};
	});

	$effect(() => {
		const pairId = selectedPairId;
		const laceHolder = laceHolderStyle;
		if (!scene || !group || !sceneReady) return;
		const nextKey = modelLoadKey(pairId, laceHolder);
		if (loadedBaseKey === nextKey) return;
		loadedBaseKey = nextKey;
		const pair = MODEL_PAIRS.find((p) => p.id === pairId) ?? MODEL_PAIRS[0];
		void loadSelectedModelPair(pair, laceHolder);
	});

	$effect(() => {
		void selectedPairId;
		void laceHolderStyle;
		void baseDepth;
		void borderDepth;
		void baseColor;
		void commonColor;
		void borderColor;
		void lines;
		void lineSpacing;
		void backLines;
		void backLineSpacing;
		void textOutlineEnabled;
		void textOutlineThicknessMm;
		void textOutlineDepth;
		void textOutlineColor;
		saveSettings();
	});

	$effect(() => {
		if (!backPrintEnabled && activeTextSide === 'back') {
			activeTextSide = 'front';
		}
	});

	$effect(() => {
		void user?.id;
		void syncCustomPresetsFromAccount();
	});

	$effect(() => {
		void baseColor;
		void borderColor;
		void commonColor;
		void textOutlineColor;
		void textOutlineEnabled;
		activePresetId = findMatchingPresetId(galleryPresets);
	});

	$effect(() => {
		void baseSourceGeometry;
		void borderSourceGeometry;
		void baseDepth;
		void borderDepth;
		void baseColor;
		void borderColor;
		void commonColor;
		void lines;
		void lineSpacing;
		void backLines;
		void backLineSpacing;
		void activeTextSide;
		void backPrintEnabled;
		void userFeatureFlags.loaded;
		void textOutlineEnabled;
		void textOutlineThicknessMm;
		void textOutlineDepth;
		void textOutlineColor;
		void maxTextOutlineMm;
		if (!scene || !group || !sceneReady) return;
		rebuildMeshes();
	});

	onDestroy(() => {
		mountGeneration++;
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
		if (renderer && hostEl && renderer.domElement.parentElement === hostEl) {
			hostEl.removeChild(renderer.domElement);
		}
		renderer?.dispose();
		renderer = null;
		scene = null;
		camera = null;
		group = null;
		keyLight = null;
		hemiLight = null;
		rimLight = null;
		fillLight = null;
		bottomLight = null;
		grid = null;
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

					<div id="idnametag-v2-lace-holder">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Lace holder</div>
						<p class="mt-1 text-xs text-slate-500">
							Swap the base STL for a single center loop or dual side loops.
						</p>
						<div class="mt-2 grid grid-cols-2 gap-2">
							{#each LACE_HOLDER_OPTIONS as option (option.id)}
								<Button
									type="button"
									variant={laceHolderStyle === option.id ? 'default' : 'outline'}
									size="sm"
									class="h-auto flex-col gap-0.5 py-2"
									onclick={() => (laceHolderStyle = option.id)}
								>
									<span>{option.label}</span>
									<span class="text-[10px] font-normal opacity-80">{option.hint}</span>
								</Button>
							{/each}
						</div>
					</div>

					{#if loadError}
						<p class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
							{loadError}
						</p>
					{/if}
				</div>

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="flex items-center justify-between gap-3">
						<div>
							<div class="text-xs font-semibold tracking-tight text-slate-700">Text</div>
							<p class="mt-1 text-xs text-slate-500">
								{backPrintEnabled
									? 'Edit front or back multiline text.'
									: 'Edit multiline text on the front.'}
							</p>
						</div>
						{#if backPrintEnabled}
							<div class="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
								<Button
									type="button"
									variant={activeTextSide === 'front' ? 'default' : 'ghost'}
									size="xs"
									class="h-7 px-3"
									onclick={() => (activeTextSide = 'front')}
								>
									Front
								</Button>
								<Button
									type="button"
									variant={activeTextSide === 'back' ? 'default' : 'ghost'}
									size="xs"
									class="h-7 px-3"
									onclick={() => (activeTextSide = 'back')}
								>
									Back
								</Button>
							</div>
						{/if}
					</div>

					<div class="flex items-center justify-between">
						<div class="text-xs font-semibold tracking-tight text-slate-700">
							{backPrintEnabled && activeTextSide === 'back' ? 'Back lines' : 'Front lines'}
						</div>
						<span class="text-xs text-slate-500">
							{backPrintEnabled && activeTextSide === 'back' ? backLines.length : lines.length} of 8
						</span>
					</div>

					{#if !backPrintEnabled || activeTextSide === 'front'}
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
											onclick={() => moveLine('front', i, -1)}
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
											onclick={() => moveLine('front', i, 1)}
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
											onclick={() => removeLine('front', line.id)}
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
							onclick={() => addLine('front')}
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
					{:else if backPrintEnabled}
						{#each backLines as line, i (line.id)}
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
											onclick={() => moveLine('back', i, -1)}
										>
											↑
										</Button>
										<Button
											variant="outline"
											size="xs"
											class="h-7 w-7 p-0"
											title="Move down"
											aria-label="Move line down"
											disabled={i === backLines.length - 1}
											onclick={() => moveLine('back', i, 1)}
										>
											↓
										</Button>
										<Button
											variant="outline"
											size="xs"
											class="h-7 w-7 p-0 text-red-600 hover:bg-red-50 hover:text-red-700"
											title="Remove line"
											aria-label="Remove line"
											disabled={backLines.length <= 1}
											onclick={() => removeLine('back', line.id)}
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
										placeholder={i === 0 ? 'Back text' : 'Back subtitle'}
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
									<div class="grid gap-1.5">
										<span class="text-xs font-medium text-slate-700">Depth</span>
										<span class="text-xs text-slate-600 tabular-nums">{BACK_TEXT_DEPTH_MM} mm</span>
									</div>
								</div>
							</div>
						{/each}

						<Button
							variant="outline"
							size="sm"
							class="w-full"
							onclick={() => addLine('back')}
							disabled={backLines.length >= 8}
						>
							+ Add line
						</Button>

						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Line spacing</span>
								<span class="text-xs text-slate-600 tabular-nums">{backLineSpacing} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={backLineSpacing}
								min={0}
								max={20}
								step={0.5}
								class="w-full"
							/>
						</label>
					{/if}
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

					<div class="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white/70 p-3">
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
							Middle layer between letters and the border, with a matching border frame.
						</p>
						{#if textOutlineEnabled}
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Text outline thickness</span>
									<span class="text-xs text-slate-600 tabular-nums"
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
								<p class="text-[11px] text-slate-500">
									Max {maxTextOutlineMm.toFixed(1)} mm (inside the tag border).
								</p>
							</label>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Text outline depth</span>
									<span class="text-xs text-slate-600 tabular-nums">{textOutlineDepth} mm</span>
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
								Import default presets to get {DEFAULT_ID_NAME_TAG_V2_COLOR_PRESETS.length} editable
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
												style:background-color={preset.borderColor}
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
							Save and reuse color combinations. Import
							{DEFAULT_ID_NAME_TAG_V2_COLOR_PRESETS.length} starter presets, create your own, and sync
							them to your account.
						</p>
						<Button type="button" size="sm" class="w-full" onclick={onRequestLogin}>
							Sign in to use presets
						</Button>
						<p class="text-[10px] font-medium tracking-wide text-slate-500 uppercase">
							Starter presets (preview)
						</p>
						<div class="grid grid-cols-3 gap-2 opacity-90" aria-hidden="true">
							{#each DEFAULT_ID_NAME_TAG_V2_COLOR_PRESETS as template (template.label)}
								<div
									class="overflow-hidden rounded-lg border border-slate-200/90 bg-white shadow-sm"
								>
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
												template.borderColor,
												palette,
												template.borderColor
											)}
										></span>
									</div>
									<span
										class="block border-t border-slate-100 px-1 py-1.5 text-center text-[10px] leading-tight font-medium text-slate-600"
									>
										{template.label}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0"></div>
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
					showLockIcon={showExportLockIcon(user, subscriptionStatus)}
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
					<ColorPalettePicker
						bind:value={presetEditorBase}
						{palette}
						paletteOnly
						label="Base"
					/>
					<ColorPalettePicker
						bind:value={presetEditorTextOutline}
						{palette}
						paletteOnly
						label="Text outline"
					/>
					<ColorPalettePicker
						bind:value={presetEditorBorder}
						{palette}
						paletteOnly
						label="Border"
					/>
					<ColorPalettePicker
						bind:value={presetEditorText}
						{palette}
						paletteOnly
						label="Text"
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
