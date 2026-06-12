<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import baseSvgRaw from '$lib/assets/svg/basketball/base.svg?raw';
	import borderSvgRaw from '$lib/assets/svg/basketball/border.svg?raw';
	import hoopSvgRaw from '$lib/assets/svg/basketball/hoop.svg?raw';
	import netSvgRaw from '$lib/assets/svg/basketball/net.svg?raw';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import {
		buildOffsetFontTextShapes,
		type HoopTagDecorLayerUnit,
		prepareHoopTagGeometries,
		scaleGeometryToDepth,
		unionFontShapesToThree
	} from '$lib/utils-hooptag-keychain';
	import {
		centerGeometryXY,
		DEFAULT_TEXT,
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		frameCameraToObject,
		getFont,
		makeKeyringGeometry,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Slider } from '$lib/components/ui/slider';
	import FontSelect from './FontSelect.svelte';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import type { PaletteColor } from '$lib/colorPalette';

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

	const STORAGE_KEY = 'hoop-tag-settings-v1';
	/** Vertical gap between stacked print strata so faces do not touch (avoids coplanar / non-manifold). */
	const LAYER_GAP = 0.001;
	/** Tiny Z nudge within one multi-pass plane (preview only — not stack spacing). */
	const MULTI_PASS_PLANE_NUDGE = 0.0003;
	const DESIGN_NAME = 'HoopTag';
	const HEIGHT_AT_SCALE_1_MM = 50;
	/** Hidden multiplier — UI shows 1.00× while geometry is 10% smaller. */
	const OVERALL_SCALE_OFFSET = 0.9;
	const DEFAULT_OVERALL_SCALE = 1.0;
	const REFERENCE_HEIGHT_AT_1X_MM = OVERALL_SCALE_OFFSET * HEIGHT_AT_SCALE_1_MM;
	const KEYRING_SCALE = 0.9;
	const KEYRING_OUTER_SIZE_MM = 8 * KEYRING_SCALE;
	const KEYRING_HOLE_SIZE_MM = 4 * KEYRING_SCALE;
	/** Keyring center (mm) in centered base XY — per slot for curved top edge. */
	const KEYRING_POSITION_MM: Record<KeyringHolderPosition, { x: number; y: number }> = {
		left: { x: -21 * KEYRING_SCALE, y: 21 * KEYRING_SCALE },
		center: { x: 0, y: 22 * KEYRING_SCALE },
		right: { x: 21 * KEYRING_SCALE, y: 22.5 * KEYRING_SCALE }
	};

	type KeyringHolderPosition = 'left' | 'center' | 'right';
	type ColorPrintMode = 'multiPass' | 'layerBased';
	const TEXT_BASE_FONT_SIZE = 72;
	const TEXT_MAX_LEN = 12;
	const TEXT_OUTLINE_MM = 1.0;
	const NET_COLOR_DEFAULT = '#f8f8f8';
	const NET_COLOR_ON_LIGHT_BASE = '#121212';
	const TEXT_COLOR_DEFAULT = '#f8f8f8';
	const TEXT_COLOR_ON_LIGHT_BASE = '#121212';
	/** Stack border → hoop → net (bottom to top). */
	const DECOR_LAYER_ORDER = ['border', 'hoop', 'net'] as const;
	const HOOPTAG_DECOR_SVGS = [
		{ id: 'border', svg: borderSvgRaw },
		{ id: 'hoop', svg: hoopSvgRaw },
		{ id: 'net', svg: netSvgRaw }
	] as const;

	const HOOPTAG_FONT_KEYS_ORDER = [
		'Titan One_Regular',
		'Coiny_Regular',
		'Kindergo_Regular',
		'Milkyway_Regular',
		'Ngaco_Regular',
		'Monoton_Regular',
		'Black Ops One_Regular',
		'Cherry Bomb One_Regular',
		'DynaPuff_Bold',
		'Fascinate Inline_Regular',
		'Roadside Sans_Regular'
	] as const;
	const HOOPTAG_FONT_KEYS = new Set<string>(HOOPTAG_FONT_KEYS_ORDER);
	const HOOPTAG_FONT_OPTIONS = HOOPTAG_FONT_KEYS_ORDER.flatMap((key) => {
		const opt = FONT_OPTIONS.find((f) => f.key === key);
		return opt ? [opt] : [];
	});
	const DEFAULT_HOOPTAG_FONT_KEY = HOOPTAG_FONT_OPTIONS[0]?.key ?? 'Titan One_Regular';

	interface HoopTagSettings {
		baseDepth: number;
		baseColor: string;
		borderHoopColor: string;
		netColor: string;
		colorPrintMode: ColorPrintMode;
		keyringPosition: KeyringHolderPosition;
		decorDepth: number;
		overallScale: number;
		text: string;
		textFontKey: string;
		textColor: string;
		textDepth: number;
		textScale: number;
		textOffsetX: number;
		textOffsetY: number;
		textRotationDeg: number;
		textSkewXDeg: number;
		textSkewYDeg: number;
	}

	const defaults: HoopTagSettings = {
		baseDepth: 1.6,
		baseColor: '#121212',
		borderHoopColor: '#fb6b0a',
		netColor: NET_COLOR_DEFAULT,
		colorPrintMode: 'multiPass',
		keyringPosition: 'center',
		decorDepth: 1.0,
		overallScale: DEFAULT_OVERALL_SCALE,
		text: 'JORDAN',
		textFontKey: DEFAULT_HOOPTAG_FONT_KEY,
		textColor: TEXT_COLOR_DEFAULT,
		textDepth: 1.0,
		textScale: 1.6,
		textOffsetX: 0,
		textOffsetY: 5.55,
		textRotationDeg: 4,
		textSkewXDeg: 14,
		textSkewYDeg: 0
	};

	function effectiveOverallScale(userScale: number): number {
		return userScale * OVERALL_SCALE_OFFSET;
	}

	function loadSettings(): HoopTagSettings {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw) as Partial<HoopTagSettings> & {
					borderColor?: string;
					hoopColor?: string;
				};
				if (parsed && typeof parsed === 'object') {
					const keyringPosition =
						parsed.keyringPosition === 'left' ||
						parsed.keyringPosition === 'center' ||
						parsed.keyringPosition === 'right'
							? parsed.keyringPosition
							: defaults.keyringPosition;
					const colorPrintMode =
						parsed.colorPrintMode === 'layerBased' || parsed.colorPrintMode === 'multiPass'
							? parsed.colorPrintMode
							: defaults.colorPrintMode;
					const borderHoopColor =
						parsed.borderHoopColor ?? parsed.borderColor ?? parsed.hoopColor ?? defaults.borderHoopColor;
					let overallScale =
						typeof parsed.overallScale === 'number' ? parsed.overallScale : defaults.overallScale;
					// Migrate legacy stored effective scale (0.9 default) to user-facing 1.0×.
					if (Math.abs(overallScale - OVERALL_SCALE_OFFSET) < 0.001) {
						overallScale = DEFAULT_OVERALL_SCALE;
					}
					return {
						...defaults,
						...parsed,
						borderHoopColor,
						keyringPosition,
						colorPrintMode,
						overallScale
					};
				}
			}
		} catch {
			// ignore corrupt storage
		}
		return { ...defaults };
	}

	const initial = loadSettings();

	let baseDepth = $state(initial.baseDepth);
	let baseColor = $state(initial.baseColor);
	let borderHoopColor = $state(initial.borderHoopColor);
	let netColor = $state(initial.netColor);
	let colorPrintMode = $state<ColorPrintMode>(initial.colorPrintMode);
	let keyringPosition = $state<KeyringHolderPosition>(initial.keyringPosition);
	let decorDepth = $state(initial.decorDepth);
	let overallScale = $state(initial.overallScale);
	let text = $state(initial.text);
	let textFontKey = $state(
		initial.textFontKey && HOOPTAG_FONT_KEYS.has(initial.textFontKey)
			? initial.textFontKey
			: defaults.textFontKey
	);
	let textColor = $state(initial.textColor);
	let textDepth = $state(initial.textDepth);
	let textScale = $state(initial.textScale);
	let textOffsetX = $state(initial.textOffsetX);
	let textOffsetY = $state(initial.textOffsetY);
	let textRotationDeg = $state(initial.textRotationDeg);
	let textSkewXDeg = $state(initial.textSkewXDeg);
	let textSkewYDeg = $state(initial.textSkewYDeg);

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

	let baseGeometryUnit: THREE.BufferGeometry | null = null;
	let decorLayerUnits: HoopTagDecorLayerUnit[] = [];
	let nativeHeightMm = HEIGHT_AT_SCALE_1_MM;
	let geometryLoadToken = 0;
	let sceneReady = $state(false);
	let modelLoadError = $state<string | null>(null);
	let modelReady = $state(false);
	let geometryLoading = $state(false);

	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);

	/** Plain (non-reactive) — auto net/text only when base color changes. */
	let previousBaseColor = initial.baseColor;

	function isLightColor(hex: string): boolean {
		const c = new THREE.Color(hex);
		const luminance = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
		return luminance > 0.65;
	}

	function normalizeHex(hex: string): string {
		const h = (hex || '').replace(/^#/, '').trim();
		if (!h) return '#ffffff';
		if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
		return `#${h}`.toLowerCase();
	}

	function isContrastWhite(hex: string): boolean {
		const n = normalizeHex(hex);
		return n === '#f8f8f8' || n === '#ffffff';
	}

	function isContrastBlack(hex: string): boolean {
		const n = normalizeHex(hex);
		return n === '#121212' || n === '#000000';
	}

	/** Flip white ↔ black on base change; leave custom colors alone. */
	function contrastForLightBase(current: string): string {
		if (isContrastWhite(current)) return NET_COLOR_ON_LIGHT_BASE;
		return current;
	}

	function contrastForDarkBase(current: string): string {
		if (isContrastBlack(current)) return NET_COLOR_DEFAULT;
		return current;
	}

	function keyringPositionMm(position: KeyringHolderPosition): { x: number; y: number } {
		return KEYRING_POSITION_MM[position];
	}

	function decorLayerRank(id: string): number {
		const idx = DECOR_LAYER_ORDER.indexOf(id as (typeof DECOR_LAYER_ORDER)[number]);
		return idx >= 0 ? idx : DECOR_LAYER_ORDER.length;
	}

	function decorColorForId(id: string): string {
		switch (id) {
			case 'border':
			case 'hoop':
				return borderHoopColor;
			case 'net':
				return netColor;
			default:
				return '#ffffff';
		}
	}

	function sortedDecorLayers(layers: HoopTagDecorLayerUnit[]): HoopTagDecorLayerUnit[] {
		return [...layers].sort((a, b) => decorLayerRank(a.id) - decorLayerRank(b.id));
	}

	function sanitizeText(raw: string): string {
		return (raw ?? '').trim().slice(0, TEXT_MAX_LEN);
	}

	function applyShearXY(
		geo: THREE.BufferGeometry,
		skewXDeg: number,
		skewYDeg: number
	): void {
		if (skewXDeg === 0 && skewYDeg === 0) return;
		const sx = Math.tan((skewXDeg * Math.PI) / 180);
		const sy = Math.tan((skewYDeg * Math.PI) / 180);
		const pos = geo.attributes.position as THREE.BufferAttribute;
		for (let i = 0; i < pos.count; i++) {
			const x = pos.getX(i);
			const y = pos.getY(i);
			const z = pos.getZ(i);
			pos.setXYZ(i, x + sx * y, y + sy * x, z);
		}
		pos.needsUpdate = true;
		geo.computeBoundingBox();
	}

	function bottomAlignGeometryZ(geo: THREE.BufferGeometry): void {
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (bb) geo.translate(0, 0, -bb.min.z);
	}

	function prepareTextGeometry(
		shapes: THREE.Shape[],
		depth: number
	): THREE.BufferGeometry {
		const geo = new THREE.ExtrudeGeometry(shapes, {
			depth: Math.max(0.05, depth),
			bevelEnabled: false,
			curveSegments: 8
		});
		centerGeometryXY(geo);
		applyShearXY(geo, textSkewXDeg, textSkewYDeg);
		return geo;
	}

	/** Match decor layers: extrude then scale Z so every slab is exactly slabD mm. */
	function buildSlabTextGeometry(shapes: THREE.Shape[], slabD: number): THREE.BufferGeometry {
		const raw = prepareTextGeometry(shapes, slabD);
		const fitted = scaleGeometryToDepth(raw, slabD);
		raw.dispose();
		return fitted;
	}

	function placeTextMesh(
		mesh: THREE.Mesh,
		scale: number,
		centerX: number,
		centerY: number,
		z: number
	): void {
		mesh.scale.set(scale, scale, 1);
		mesh.position.set(centerX + textOffsetX, centerY + textOffsetY, z);
		mesh.rotation.z = (textRotationDeg * Math.PI) / 180;
	}

	interface TextBuildContext {
		scale: number;
		centerX: number;
		centerY: number;
		solidShapes: THREE.Shape[];
		rawShapes: THREE.Shape[];
		textD: number;
	}

	function buildTextContext(
		baseGeo: THREE.BufferGeometry,
		content: string
	): TextBuildContext | null {
		const font = getFont(textFontKey);
		if (!font) return null;
		const rawShapes = font.generateShapes(content, TEXT_BASE_FONT_SIZE);
		const solidShapes = unionFontShapesToThree(rawShapes);
		if (solidShapes.length === 0) return null;
		const textD = Math.max(0.05, textDepth);
		const probeGeo = prepareTextGeometry(solidShapes, textD);
		probeGeo.computeBoundingBox();
		const tb = probeGeo.boundingBox;
		const textH = tb && tb.max.y > tb.min.y ? Math.max(0.01, tb.max.y - tb.min.y) : 1;
		probeGeo.dispose();

		baseGeo.computeBoundingBox();
		const baseBbForText = baseGeo.boundingBox;
		const baseW =
			baseBbForText && baseBbForText.max.x > baseBbForText.min.x
				? baseBbForText.max.x - baseBbForText.min.x
				: 50;
		const targetH = baseW * 0.14 * Math.max(0.2, textScale);
		const scale = targetH / textH;
		const centerX = baseBbForText ? (baseBbForText.min.x + baseBbForText.max.x) / 2 : 0;
		const centerY = baseBbForText ? (baseBbForText.min.y + baseBbForText.max.y) / 2 : 0;
		return { scale, centerX, centerY, solidShapes, rawShapes, textD };
	}

	function addTextInstance(
		parent: THREE.Group,
		ctx: TextBuildContext,
		options: {
			z: number;
			name: string;
			color: string;
			depth?: number;
			slabFit?: boolean;
			polygonOffset?: boolean;
			renderOrder?: number;
			polygonOffsetFactor?: number;
		}
	): void {
		const depth = options.depth ?? ctx.textD;
		const textGeo = options.slabFit
			? buildSlabTextGeometry(ctx.solidShapes, depth)
			: (() => {
					const geo = prepareTextGeometry(ctx.solidShapes, depth);
					bottomAlignGeometryZ(geo);
					return geo;
				})();
		const usePolygonOffset = options.polygonOffset ?? true;
		const textMat = new THREE.MeshStandardMaterial({
			color: options.color,
			roughness: 0.35,
			metalness: 0.1,
			polygonOffset: usePolygonOffset,
			...(usePolygonOffset
				? {
						polygonOffsetFactor: options.polygonOffsetFactor ?? -2,
						polygonOffsetUnits: -1
					}
				: {})
		});
		const textMesh = new THREE.Mesh(textGeo, textMat);
		textMesh.name = options.name;
		textMesh.castShadow = true;
		textMesh.receiveShadow = true;
		if (options.renderOrder != null) textMesh.renderOrder = options.renderOrder;
		placeTextMesh(textMesh, ctx.scale, ctx.centerX, ctx.centerY, options.z);
		parent.add(textMesh);
	}

	interface LayerBasedStrata {
		netLayerZ: number;
		accentLayerZ: number;
		textTopZ: number;
	}

	/** Layer-based print strata — net/accent slab height from artwork thickness. */
	function computeLayerBasedStrata(baseTopZ: number, artworkD: number): LayerBasedStrata {
		const netLayerZ = baseTopZ + LAYER_GAP;
		const accentLayerZ = netLayerZ + artworkD;
		const textTopZ = accentLayerZ + artworkD;
		return { netLayerZ, accentLayerZ, textTopZ };
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
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					baseDepth,
					baseColor,
					borderHoopColor,
					netColor,
					colorPrintMode,
					keyringPosition,
					decorDepth,
					overallScale,
					text,
					textFontKey,
					textColor,
					textDepth,
					textScale,
					textOffsetX,
					textOffsetY,
					textRotationDeg,
					textSkewXDeg,
					textSkewYDeg
				} satisfies HoopTagSettings)
			);
		} catch {
			// storage unavailable
		}
	}

	function disposePreparedGeometry() {
		baseGeometryUnit?.dispose();
		for (const layer of decorLayerUnits) layer.geometry.dispose();
		baseGeometryUnit = null;
		decorLayerUnits = [];
	}

	function disposePreparedResult(prepared: {
		baseUnit: THREE.BufferGeometry;
		decorLayers: HoopTagDecorLayerUnit[];
	}) {
		prepared.baseUnit.dispose();
		for (const layer of prepared.decorLayers) layer.geometry.dispose();
	}

	async function loadGeometryFromSvg() {
		const token = ++geometryLoadToken;
		modelReady = false;
		geometryLoading = true;
		modelLoadError = null;
		await tickThenYieldToPaint();
		if (token !== geometryLoadToken) return;

		let prepared: ReturnType<typeof prepareHoopTagGeometries> | null = null;
		try {
			prepared = prepareHoopTagGeometries(
				{
					baseSvg: baseSvgRaw,
					decorLayers: HOOPTAG_DECOR_SVGS.map((layer) => ({ ...layer }))
				},
				{ targetNativeHeightMm: HEIGHT_AT_SCALE_1_MM }
			);
		} catch (e) {
			if (token !== geometryLoadToken) {
				if (prepared) disposePreparedResult(prepared);
				return;
			}
			disposePreparedGeometry();
			modelLoadError = e instanceof Error ? e.message : 'Failed to prepare HoopTag geometry';
			geometryLoading = false;
			return;
		}

		if (token !== geometryLoadToken) {
			disposePreparedResult(prepared);
			return;
		}

		disposePreparedGeometry();
		baseGeometryUnit = prepared.baseUnit;
		decorLayerUnits = prepared.decorLayers;
		nativeHeightMm = prepared.nativeHeightMm;
		modelReady = true;
		modelLoadError = null;
		geometryLoading = false;
		rebuildMeshes();
	}

	function addDecorMesh(
		parent: THREE.Group,
		layer: HoopTagDecorLayerUnit,
		options: {
			depth: number;
			color: string;
			z: number;
			name: string;
			polygonOffsetIndex: number;
			polygonOffset?: boolean;
			renderOrder?: number;
		}
	): THREE.Mesh {
		const decorGeo = scaleGeometryToDepth(layer.geometry, options.depth);
		const usePolygonOffset = options.polygonOffset ?? true;
		const decorMat = new THREE.MeshStandardMaterial({
			color: options.color,
			roughness: 0.35,
			metalness: 0.1,
			polygonOffset: usePolygonOffset,
			...(usePolygonOffset
				? {
						polygonOffsetFactor: -1 - options.polygonOffsetIndex,
						polygonOffsetUnits: -1
					}
				: {})
		});
		const decorMesh = new THREE.Mesh(decorGeo, decorMat);
		decorMesh.name = options.name;
		decorMesh.castShadow = true;
		decorMesh.receiveShadow = true;
		decorMesh.position.z = options.z;
		if (options.renderOrder != null) decorMesh.renderOrder = options.renderOrder;
		parent.add(decorMesh);
		return decorMesh;
	}

	function rebuildMeshes() {
		if (!scene || !group || !baseGeometryUnit || decorLayerUnits.length === 0) {
			modelAabbMm = null;
			return;
		}

		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		group.scale.set(1, 1, 1);
		modelAabbMm = null;

		const baseD = Math.max(0.05, baseDepth);
		const decorD = Math.max(0.05, decorDepth);
		const baseTopZ = baseD;
		const decorLayerZ = baseTopZ + LAYER_GAP;
		const content = sanitizeText(text);
		const textD = content ? Math.max(0.05, textDepth) : 0;
		const { netLayerZ, accentLayerZ, textTopZ } = computeLayerBasedStrata(baseTopZ, decorD);
		/** Multi Pass: text shares the decor print plane (same Z), not stacked above it. */
		const multiPassTextZ = decorLayerZ + sortedDecorLayers(decorLayerUnits).length * MULTI_PASS_PLANE_NUDGE;

		const baseGeo = scaleGeometryToDepth(baseGeometryUnit, baseD);
		const baseMat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.85,
			metalness: 0.05
		});
		const baseMesh = new THREE.Mesh(baseGeo, baseMat);
		baseMesh.name = 'base';
		baseMesh.castShadow = true;
		baseMesh.receiveShadow = true;
		group.add(baseMesh);

		const sorted = sortedDecorLayers(decorLayerUnits);
		const sceneGroup = group;

		if (colorPrintMode === 'layerBased') {
			let netOrder = 0;
			for (const id of ['border', 'hoop', 'net'] as const) {
				const layer = sorted.find((l) => l.id === id);
				if (!layer) continue;
				addDecorMesh(sceneGroup, layer, {
					depth: decorD,
					color: netColor,
					z: netLayerZ,
					name: id === 'net' ? 'net' : `${id}-net`,
					polygonOffsetIndex: 0,
					polygonOffset: false,
					renderOrder: netOrder++
				});
			}

			let accentOrder = 0;
			for (const id of ['border', 'hoop'] as const) {
				const layer = sorted.find((l) => l.id === id);
				if (!layer) continue;
				addDecorMesh(sceneGroup, layer, {
					depth: decorD,
					color: borderHoopColor,
					z: accentLayerZ,
					name: `${id}-accent`,
					polygonOffsetIndex: 0,
					polygonOffset: false,
					renderOrder: accentOrder++
				});
			}
		} else {
			sorted.forEach((layer, index) => {
				addDecorMesh(sceneGroup, layer, {
					depth: decorD,
					color: decorColorForId(layer.id),
					z: decorLayerZ + index * MULTI_PASS_PLANE_NUDGE,
					name: layer.id,
					polygonOffsetIndex: index
				});
			});
		}

		if (content) {
			const textCtx = buildTextContext(baseGeo, content);
			if (textCtx) {
				const outlineShapes = buildOffsetFontTextShapes(
					textCtx.rawShapes,
					TEXT_OUTLINE_MM,
					textCtx.scale
				);
				if (outlineShapes.length > 0) {
					const outlineGeo = prepareTextGeometry(outlineShapes, baseD);
					bottomAlignGeometryZ(outlineGeo);
					const outlineMat = new THREE.MeshStandardMaterial({
						color: baseColor,
						roughness: 0.85,
						metalness: 0.05
					});
					const outlineMesh = new THREE.Mesh(outlineGeo, outlineMat);
					outlineMesh.name = 'text-outline';
					outlineMesh.castShadow = true;
					outlineMesh.receiveShadow = true;
					placeTextMesh(
						outlineMesh,
						textCtx.scale,
						textCtx.centerX,
						textCtx.centerY,
						0
					);
					sceneGroup.add(outlineMesh);
				}

				if (colorPrintMode === 'layerBased') {
					addTextInstance(sceneGroup, textCtx, {
						z: netLayerZ,
						name: 'text-net',
						color: netColor,
						depth: decorD,
						slabFit: true,
						polygonOffset: false,
						renderOrder: 10
					});
					addTextInstance(sceneGroup, textCtx, {
						z: accentLayerZ,
						name: 'text-accent',
						color: borderHoopColor,
						depth: decorD,
						slabFit: true,
						polygonOffset: false,
						renderOrder: 20
					});
					addTextInstance(sceneGroup, textCtx, {
						z: textTopZ,
						name: 'text',
						color: textColor,
						depth: textD,
						slabFit: true,
						polygonOffset: false,
						renderOrder: 30
					});
				} else {
					addTextInstance(sceneGroup, textCtx, {
						z: multiPassTextZ,
						name: 'text',
						color: textColor
					});
				}
			}
		}

		baseGeo.computeBoundingBox();
		if (baseGeo.boundingBox) {
			const ringGeo = makeKeyringGeometry(
				KEYRING_OUTER_SIZE_MM,
				Math.max(0.1, Math.min(KEYRING_HOLE_SIZE_MM, KEYRING_OUTER_SIZE_MM - 0.5)),
				Math.max(0.1, baseD)
			);
			const ringMat = new THREE.MeshStandardMaterial({
				color: baseColor,
				roughness: 0.85,
				metalness: 0.05
			});
			const ringMesh = new THREE.Mesh(ringGeo, ringMat);
			ringMesh.name = 'keyring';
			ringMesh.castShadow = true;
			ringMesh.receiveShadow = true;
			const keyringPos = keyringPositionMm(keyringPosition);
			ringMesh.position.set(keyringPos.x, keyringPos.y, 0);
			group.add(ringMesh);
		}

		const heightNormalize = HEIGHT_AT_SCALE_1_MM / Math.max(1e-6, nativeHeightMm);
		const xyScale = heightNormalize * Math.max(0.2, effectiveOverallScale(overallScale));
		group.scale.set(xyScale, xyScale, 1);

		group.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(group);
		if (keyLight?.shadow?.camera) {
			const sizeVec = new THREE.Vector3();
			box.getSize(sizeVec);
			const center = new THREE.Vector3();
			box.getCenter(center);
			const r = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 0.75 + 10;
			const cam = keyLight.shadow.camera as THREE.OrthographicCamera;
			cam.left = -r;
			cam.right = r;
			cam.top = r;
			cam.bottom = -r;
			cam.near = 0.1;
			cam.far = Math.max(300, r * 6);
			cam.updateProjectionMatrix();
			keyLight.target.position.copy(center);
			keyLight.target.updateWorldMatrix?.(true, true);
		}
		if (!didInitFrame && camera && controls) {
			frameCameraToObject(box, camera, controls);
			didInitFrame = true;
		}
		const s = measureWorldAabbSizeMm(group);
		modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
	}

	function collectExportMeshes(): THREE.Mesh[] {
		if (!modelReady || !group || !baseGeometryUnit) return [];
		if (group.children.length === 0) rebuildMeshes();
		const out: THREE.Mesh[] = [];
		for (const child of group.children) {
			if (child instanceof THREE.Mesh) out.push(child);
		}
		return out;
	}

	function prepareWorldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
		let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
		if (g.getAttribute('uv')) g.deleteAttribute('uv');
		if (!g.getAttribute('normal')) g.computeVertexNormals();
		if (g.index) {
			const nonIndexed = g.toNonIndexed();
			g.dispose();
			g = nonIndexed;
		}
		return g;
	}

	function mergeExportMeshes(meshes: THREE.Mesh[]): THREE.BufferGeometry | null {
		if (meshes.length === 0) return null;
		const geometries = meshes.map(prepareWorldGeometry);
		const merged =
			geometries.length === 1
				? geometries[0]
				: BufferGeometryUtils.mergeGeometries(geometries);
		if (!merged) {
			geometries.forEach((g) => g.dispose());
			return null;
		}
		if (geometries.length > 1) geometries.forEach((g) => g !== merged && g.dispose());
		const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
		if (welded !== merged) merged.dispose();
		return welded;
	}

	function buildMultipartExportGroup(meshes: THREE.Mesh[]): THREE.Group | null {
		const byName: Record<string, THREE.Mesh> = {};
		for (const mesh of meshes) {
			if (mesh.name) byName[mesh.name] = mesh;
		}
		const exportGroup = new THREE.Group();
		const baseMeshes = [byName.base, byName.keyring, byName['text-outline']].filter(
			Boolean
		) as THREE.Mesh[];
		const baseGeo = mergeExportMeshes(baseMeshes);
		if (baseGeo) {
			exportGroup.add(
				new THREE.Mesh(
					baseGeo,
					new THREE.MeshBasicMaterial({ color: new THREE.Color(baseColor) })
				)
			);
		}

		if (colorPrintMode === 'layerBased') {
			const netLayerMeshes = [
				byName['border-net'],
				byName['hoop-net'],
				byName.net,
				byName['text-net']
			].filter(Boolean) as THREE.Mesh[];
			const netLayerGeo = mergeExportMeshes(netLayerMeshes);
			if (netLayerGeo) {
				exportGroup.add(
					new THREE.Mesh(
						netLayerGeo,
						new THREE.MeshBasicMaterial({ color: new THREE.Color(netColor) })
					)
				);
			}
			const accentLayerMeshes = [
				byName['border-accent'],
				byName['hoop-accent'],
				byName['text-accent']
			].filter(Boolean) as THREE.Mesh[];
			const accentLayerGeo = mergeExportMeshes(accentLayerMeshes);
			if (accentLayerGeo) {
				exportGroup.add(
					new THREE.Mesh(
						accentLayerGeo,
						new THREE.MeshBasicMaterial({ color: new THREE.Color(borderHoopColor) })
					)
				);
			}
			const textMesh = byName.text;
			if (textMesh) {
				const geo = mergeExportMeshes([textMesh]);
				if (geo) {
					exportGroup.add(
						new THREE.Mesh(
							geo,
							new THREE.MeshBasicMaterial({ color: new THREE.Color(textColor) })
						)
					);
				}
			}
		} else {
			const borderHoopMeshes = [byName.border, byName.hoop].filter(Boolean) as THREE.Mesh[];
			const borderHoopGeo = mergeExportMeshes(borderHoopMeshes);
			if (borderHoopGeo) {
				exportGroup.add(
					new THREE.Mesh(
						borderHoopGeo,
						new THREE.MeshBasicMaterial({ color: new THREE.Color(borderHoopColor) })
					)
				);
			}
			const netMesh = byName.net;
			if (netMesh) {
				const geo = mergeExportMeshes([netMesh]);
				if (geo) {
					exportGroup.add(
						new THREE.Mesh(
							geo,
							new THREE.MeshBasicMaterial({ color: new THREE.Color(netColor) })
						)
					);
				}
			}
			const textMesh = byName.text;
			if (textMesh) {
				const geo = mergeExportMeshes([textMesh]);
				if (geo) {
					exportGroup.add(
						new THREE.Mesh(
							geo,
							new THREE.MeshBasicMaterial({ color: new THREE.Color(textColor) })
						)
					);
				}
			}
		}
		return exportGroup.children.length > 0 ? exportGroup : null;
	}

	async function exportSTL() {
		if (modelLoadError) {
			exportError = modelLoadError;
			return;
		}
		if (!modelReady) {
			exportError = 'Model is still loading';
			return;
		}
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		const meshes = collectExportMeshes();
		if (meshes.length === 0) {
			exportError = 'Nothing to export';
			return;
		}
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			group?.updateWorldMatrix(true, true);
			const welded = mergeExportMeshes(collectExportMeshes());
			if (!welded) {
				exportError = 'Failed to merge geometry';
				return;
			}
			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
			welded.dispose();
			const buffer = (result as DataView).buffer as ArrayBuffer;
			if (!buffer || buffer.byteLength < 84) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`hoop-tag-${ts}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
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
		if (modelLoadError) {
			exportError = modelLoadError;
			return;
		}
		if (!modelReady) {
			exportError = 'Model is still loading';
			return;
		}
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		const meshes = collectExportMeshes();
		if (meshes.length === 0) {
			exportError = 'Nothing to export';
			return;
		}
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		let exportGroup: THREE.Group | null = null;
		try {
			group?.updateWorldMatrix(true, true);
			exportGroup = buildMultipartExportGroup(collectExportMeshes());
			if (!exportGroup) {
				exportError = 'Failed to merge geometry';
				return;
			}
			exportGroup.updateWorldMatrix(true, true);
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) {
				exportError = '3MF export produced no data';
				return;
			}
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`hoop-tag-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: '3mf'
			});
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : '3MF export failed';
		} finally {
			if (exportGroup) disposeObject3D(exportGroup);
			exportLoading = false;
		}
	}

	async function openWithBambuStudio() {
		if (!modelReady || modelLoadError) return;
		const meshes = collectExportMeshes();
		if (meshes.length === 0) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		openBambuStudioLoading = true;
		await tickThenYieldToPaint();
		let exportGroup: THREE.Group | null = null;
		try {
			group?.updateWorldMatrix(true, true);
			exportGroup = buildMultipartExportGroup(collectExportMeshes());
			if (!exportGroup) return;
			exportGroup.updateWorldMatrix(true, true);
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'hoop-tag');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			if (exportGroup) disposeObject3D(exportGroup);
			openBambuStudioLoading = false;
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
			renderer?.render(scene!, camera!);
		};
		tick();

		return () => {
			ro?.disconnect();
			ro = null;
		};
	});

	$effect(() => {
		const base = baseColor;
		if (base === previousBaseColor) return;
		const wasLight = isLightColor(previousBaseColor);
		const isLight = isLightColor(base);
		previousBaseColor = base;
		if (isLight && !wasLight) {
			netColor = contrastForLightBase(netColor);
			textColor = contrastForLightBase(textColor);
		} else if (!isLight && wasLight) {
			netColor = contrastForDarkBase(netColor);
			textColor = contrastForDarkBase(textColor);
		}
	});

	$effect(() => {
		void baseDepth;
		void baseColor;
		void borderHoopColor;
		void netColor;
		void colorPrintMode;
		void keyringPosition;
		void decorDepth;
		void overallScale;
		void text;
		void textFontKey;
		void textColor;
		void textDepth;
		void textScale;
		void textOffsetX;
		void textOffsetY;
		void textRotationDeg;
		void textSkewXDeg;
		void textSkewYDeg;
		saveSettings();
	});

	$effect(() => {
		if (!sceneReady) return;
		void loadGeometryFromSvg();
	});

	$effect(() => {
		void baseDepth;
		void baseColor;
		void borderHoopColor;
		void netColor;
		void colorPrintMode;
		void keyringPosition;
		void decorDepth;
		void overallScale;
		void text;
		void textFontKey;
		void textColor;
		void textDepth;
		void textScale;
		void textOffsetX;
		void textOffsetY;
		void textRotationDeg;
		void textSkewXDeg;
		void textSkewYDeg;
		if (!sceneReady || !modelReady) return;
		rebuildMeshes();
	});

	onDestroy(() => {
		geometryLoadToken++;
		sceneReady = false;
		cancelAnimationFrame(rafId);
		rafId = 0;
		ro?.disconnect();
		ro = null;
		if (group) disposeObject3D(group);
		disposePreparedGeometry();
		if (scene) disposeObject3D(scene);
		renderer?.dispose();
		if (renderer?.domElement?.parentElement) {
			renderer.domElement.parentElement.removeChild(renderer.domElement);
		}
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]">
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">HoopTag</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<div class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Base</div>
					<p class="text-[11px] text-slate-500">
						Silhouette from the base SVG with a keyring tab at the top.
					</p>
					<ColorPalettePicker bind:value={baseColor} {palette} label="Base color" />
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Base thickness</span>
							<span class="text-xs text-slate-600 tabular-nums">{baseDepth} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={baseDepth}
							min={0.4}
							max={4}
							step={0.1}
							class="w-full" />
					</label>

					<div class="grid gap-1.5">
						<span class="text-xs font-medium text-slate-700">Keyring position</span>
						<div class="grid grid-cols-3 gap-1" role="group" aria-label="Keyring position">
							<Button
								variant="outline"
								class="h-10 w-full text-lg {keyringPosition === 'left'
									? 'border-indigo-500 bg-indigo-100 text-indigo-700'
									: ''}"
								onclick={() => (keyringPosition = 'left')}
								title="Top left"
								aria-pressed={keyringPosition === 'left'}>
								↖
							</Button>
							<Button
								variant="outline"
								class="h-10 w-full text-lg {keyringPosition === 'center'
									? 'border-indigo-500 bg-indigo-100 text-indigo-700'
									: ''}"
								onclick={() => (keyringPosition = 'center')}
								title="Top center"
								aria-pressed={keyringPosition === 'center'}>
								↑
							</Button>
							<Button
								variant="outline"
								class="h-10 w-full text-lg {keyringPosition === 'right'
									? 'border-indigo-500 bg-indigo-100 text-indigo-700'
									: ''}"
								onclick={() => (keyringPosition = 'right')}
								title="Top right"
								aria-pressed={keyringPosition === 'right'}>
								↗
							</Button>
						</div>
					</div>

					<div class="mt-1 border-t border-slate-200 pt-2 text-xs font-semibold text-slate-700">
						Multi-color print
					</div>
					<p class="text-[11px] text-slate-500">
						Multi Pass prints border, hoop, and net at the same height. Layer Based stacks four
						layers: text, accent (border + hoop + text), net (border + hoop + text + net), then
						base.
					</p>
					<div class="grid grid-cols-2 gap-1" role="group" aria-label="Multi-color print mode">
						<Button
							variant="outline"
							class="h-9 w-full text-xs {colorPrintMode === 'multiPass'
								? 'border-indigo-500 bg-indigo-100 text-indigo-700'
								: ''}"
							onclick={() => (colorPrintMode = 'multiPass')}
							aria-pressed={colorPrintMode === 'multiPass'}>
							Multi Pass
						</Button>
						<Button
							variant="outline"
							class="h-9 w-full text-xs {colorPrintMode === 'layerBased'
								? 'border-indigo-500 bg-indigo-100 text-indigo-700'
								: ''}"
							onclick={() => (colorPrintMode = 'layerBased')}
							aria-pressed={colorPrintMode === 'layerBased'}>
							Layer Based
						</Button>
					</div>

					<div class="mt-1 border-t border-slate-200 pt-2 text-xs font-semibold text-slate-700">
						Artwork
					</div>
					<p class="text-[11px] text-slate-500">
						{#if colorPrintMode === 'layerBased'}
							Top to bottom: text → accent border/hoop/text → net border/hoop/text/net → base.
							Artwork thickness applies to decor and fill text; top text uses text thickness.
						{:else}
							Border, hoop, and net are separate layers with their own colors.
						{/if}
					</p>
					<ColorPalettePicker
						bind:value={borderHoopColor}
						{palette}
						label={colorPrintMode === 'layerBased' ? 'Accent border & hoop color' : 'Border & hoop color'} />
					<ColorPalettePicker bind:value={netColor} {palette} label="Net color" />
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Artwork thickness</span>
							<span class="text-xs text-slate-600 tabular-nums">{decorDepth} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={decorDepth}
							min={0.3}
							max={3}
							step={0.1}
							class="w-full" />
					</label>

					<div class="mt-1 border-t border-slate-200 pt-2 text-xs font-semibold text-slate-700">
						Text
					</div>
					<label class="grid gap-1.5">
						<span class="text-xs font-medium text-slate-700">Text</span>
						<Input
							type="text"
							bind:value={text}
							maxlength={TEXT_MAX_LEN}
							placeholder={DEFAULT_TEXT}
							class="h-9" />
					</label>
					<FontSelect id="hoop-tag-font" bind:value={textFontKey} options={HOOPTAG_FONT_OPTIONS} />
					<ColorPalettePicker bind:value={textColor} {palette} label="Text color" />
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Text size</span>
							<span class="text-xs text-slate-600 tabular-nums">{textScale.toFixed(2)}×</span>
						</div>
						<Slider
							type="single"
							bind:value={textScale}
							min={0.4}
							max={2}
							step={0.05}
							class="w-full" />
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">
								{colorPrintMode === 'layerBased' ? 'Top text thickness' : 'Text thickness'}
							</span>
							<span class="text-xs text-slate-600 tabular-nums">{textDepth} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={textDepth}
							min={0.3}
							max={3}
							step={0.1}
							class="w-full" />
					</label>

					<div class="rounded-lg border border-amber-200 bg-amber-50/80 p-2.5">
						<div class="text-xs font-semibold text-amber-900">Placement (temporary)</div>
						<p class="mt-1 text-[11px] text-amber-800/90">
							Tune position, rotation, and skew — note values for defaults later.
						</p>
						<div class="mt-3 grid grid-cols-2 gap-3">
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Pos X</span>
									<span class="text-xs text-slate-600 tabular-nums">{textOffsetX.toFixed(2)}</span>
								</div>
								<Slider
									type="single"
									bind:value={textOffsetX}
									min={-30}
									max={30}
									step={0.05}
									class="w-full" />
							</label>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Pos Y</span>
									<span class="text-xs text-slate-600 tabular-nums">{textOffsetY.toFixed(2)}</span>
								</div>
								<Slider
									type="single"
									bind:value={textOffsetY}
									min={-30}
									max={30}
									step={0.05}
									class="w-full" />
							</label>
						</div>
						<label class="mt-3 grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Rotation</span>
								<span class="text-xs text-slate-600 tabular-nums">{textRotationDeg.toFixed(1)}°</span>
							</div>
							<Slider
								type="single"
								bind:value={textRotationDeg}
								min={-45}
								max={45}
								step={0.25}
								class="w-full" />
						</label>
						<div class="mt-3 grid grid-cols-2 gap-3">
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Skew X</span>
									<span class="text-xs text-slate-600 tabular-nums">{textSkewXDeg.toFixed(1)}°</span>
								</div>
								<Slider
									type="single"
									bind:value={textSkewXDeg}
									min={-30}
									max={30}
									step={0.25}
									class="w-full" />
							</label>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Skew Y</span>
									<span class="text-xs text-slate-600 tabular-nums">{textSkewYDeg.toFixed(1)}°</span>
								</div>
								<Slider
									type="single"
									bind:value={textSkewYDeg}
									min={-30}
									max={30}
									step={0.25}
									class="w-full" />
							</label>
						</div>
					</div>

					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Overall scale</span>
							<span class="text-xs text-slate-600 tabular-nums">
								{(effectiveOverallScale(overallScale) * HEIGHT_AT_SCALE_1_MM).toFixed(1)} mm
								<span class="text-slate-400">({overallScale.toFixed(2)}×)</span>
							</span>
						</div>
						<Slider
							type="single"
							bind:value={overallScale}
							min={0.5}
							max={1.5}
							step={0.01}
							class="w-full" />
						<p class="text-[11px] text-slate-500">
							1.00× = {REFERENCE_HEIGHT_AT_1X_MM.toFixed(1)} mm height
						</p>
					</label>
				</div>
			</div>
		</aside>

		<section
			class="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]">
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0"></div>
			{#if geometryLoading}
				<div
					class="pointer-events-none absolute inset-x-4 top-4 rounded-lg border border-slate-200 bg-white/90 px-3 py-2 text-xs text-slate-600 shadow-sm">
					Preparing model…
				</div>
			{:else if modelLoadError}
				<div
					class="pointer-events-none absolute inset-x-4 top-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-sm">
					{modelLoadError}
				</div>
			{/if}
			<div class="absolute right-4 bottom-4 flex items-center gap-2">
				<DesignerExportToolbar
					onSnapshot={() => {
						if (renderer && scene && camera) downloadSnapshot(renderer, scene, camera, 'hoop-tag');
					}}
					onExport={() => exportSTL()}
					onExport3MF={() => export3MF()}
					onOpenWithBambuStudio={() => openWithBambuStudio()}
					{openBambuStudioLoading}
					exportDisabled={!modelReady || geometryLoading || !!modelLoadError}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF')}
					{exportLoading}
					showLockIcon={!user || !subscriptionStatus?.isActive} />
				{#if exportError}
					<p
						class="max-w-[200px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg">
						{exportError}
					</p>
				{/if}
			</div>
		</section>
	</div>
</main>
