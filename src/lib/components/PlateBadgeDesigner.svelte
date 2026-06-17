<script lang="ts">
	import { openInSlicer, type OpenWithSlicerId } from '$lib/openInSlicer';
	/* eslint-disable svelte/prefer-svelte-reactivity, svelte/no-dom-manipulating -- Konva paths and Three.js canvas (same pattern as Canvas Studio) */
	import type { Session, User } from '@supabase/supabase-js';
	import ClipperLib from 'clipper-lib';
	import Konva from 'konva';
	import { onDestroy, untrack } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
	import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
	import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

	import { exportTo3MF } from '$lib/export-to-3mf';
	import {
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		frameCameraToObject,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import { ensureExportAccess, getExportTitle, showExportLockIcon, type SubscriptionStatus } from '$lib/subscription';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import type { PaletteColor } from '$lib/colorPalette';
	import {
		clampElementOutlineThicknessMm,
		ELEMENT_OUTLINE_THICKNESS_MAX_MM,
		ELEMENT_OUTLINE_THICKNESS_MIN_MM,
		elementLabel,
		clipperPathsToKonvaPathD,
		getElementOutlinePolyTree,
		getLocalPathsForElement,
		getWorldPathsForElement,
		isTextElement,
		makeId,
		polyTreeToThreeShapes,
		type CanvasElement,
		type CanvasStudioViewport,
		type ShapeElement,
		type TextElement
	} from '$lib/utils-canvas-studio';
	import { getShape } from '$lib/assets/svg/shapes/index';
	import { remoteShapesStore } from '$lib/assets/svg/shapes/remote.svelte';
	import {
		buildPlateBaseMeshFromOpenScad,
		buildPlateBaseMeshPreview,
		buildPlateOuterMeshPreview,
		clampElementCenterToPlate,
		plateElementCenterLimits,
		clampPlateElementDepthMm,
		clampPlateBaseHeightMm,
		clampPlateBaseThicknessMm,
		clampPlateEndPaddingMm,
		clampPlateHoleSpacingMm,
		clampPlateSlotHeightMm,
		clampPlateSlotWidthMm,
		defaultPlateBarParams,
		defaultPlateSlotDimensions,
		maxPlateEndPaddingMm,
		maxPlateHoleSpacingMm,
		normalizePlateBarParams,
		normalizePlateSlotDimensions,
		plateDesignZone,
		plateEndPaddingFromLegacyBaseLengthMm,
		PLATE_BASE_HEIGHT_MAX_MM,
		PLATE_BASE_HEIGHT_MIN_MM,
		PLATE_BASE_THICKNESS_MAX_MM,
		PLATE_BASE_THICKNESS_MIN_MM,
		PLATE_ELEMENT_DEPTH_MIN_MM,
		PLATE_END_PADDING_DEFAULT_MM,
		PLATE_END_PADDING_MIN_MM,
		PLATE_HOLE_SPACING_DEFAULT_MM,
		PLATE_HOLE_SPACING_MIN_MM,
		PLATE_SLOT_HEIGHT_MAX_MM,
		PLATE_SLOT_HEIGHT_MIN_MM,
		PLATE_SLOT_WIDTH_MAX_MM,
		PLATE_SLOT_WIDTH_MIN_MM,
		PLATE_SPEC,
		plateBadgeElementLayer3D,
		plateBaseSilhouetteKonvaPathD,
		subtractPlateMountingSlotsFromPolyTree,
		type PlateBarParams,
		type PlateSlotDimensions
	} from '$lib/utils-plate-badge';

	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import FontSelect from './FontSelect.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import * as Popover from '$lib/components/ui/popover/index.js';

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
		session: _session,
		subscriptionStatus,
		palette,
		onBack,
		onRequestLogin,
		onShowThankYou,
		onShowPricing
	}: Props = $props();
	$effect(() => {
		void _session;
	});

	const STORAGE_KEY = 'plate-badge-designer-settings';

	function alignGeometryBottomToZ0(geo: THREE.BufferGeometry) {
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb || bb.isEmpty()) return;
		const z0 = bb.min.z;
		if (Math.abs(z0) > 1e-6) geo.translate(0, 0, -z0);
	}

	/** Move `group` along +Z so its world AABB min.z is 0 (slicer build plate). */
	function snapGroupBottomToBuildPlate(root: THREE.Group) {
		root.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(root);
		if (box.isEmpty() || !Number.isFinite(box.min.z)) return;
		root.position.z -= box.min.z;
		root.updateWorldMatrix(true, true);
	}

	interface PlateBadgeSettings {
		elements: CanvasElement[];
		/** Extrusion depth of the base + outline stack (mm, Z). */
		baseThickness?: number;
		/** @deprecated Use baseThickness. */
		baseDepth?: number;
		/** Full bar height across Y (mm). */
		baseHeightMm?: number;
		/** Plan-view width of the base-colored frame around each glyph (mm). */
		outlineThicknessMm?: number;
		baseColor: string;
		/** Mounting hole size along the bar (mm). */
		slotWidthMm?: number;
		/** Mounting hole size across the bar (mm). */
		slotHeightMm?: number;
		/** Center-to-center distance between mounting holes (mm). */
		holeSpacingMm?: number;
		/** Distance from each bar end to the outer edge of a mounting slot (mm). */
		endPaddingMm?: number;
		/** @deprecated Legacy — converted to endPaddingMm on load. */
		baseLengthMm?: number;
		phase: 'layout' | 'threeD';
		viewport?: CanvasStudioViewport;
	}

	function defaultSettings(): PlateBadgeSettings {
		const defaultSlot = defaultPlateSlotDimensions();
		const defaultBar = defaultPlateBarParams();
		return {
			elements: [
				{
					id: makeId(),
					kind: 'text',
					content: 'TEXT',
					fontKey: FONT_OPTIONS[0]?.key ?? 'Titan One_Regular',
					size: 14,
					x: 0,
					y: 0,
					rotation: 0,
					scaleX: 1,
					scaleY: 1,
					color: '#f8fafc',
					depth: 3
				}
			],
			baseThickness: 2,
			baseHeightMm: defaultBar.baseHeightMm,
			outlineThicknessMm: 2,
			baseColor: '#1e293b',
			slotWidthMm: defaultSlot.widthMm,
			slotHeightMm: defaultSlot.heightMm,
			holeSpacingMm: defaultBar.holeSpacingMm,
			endPaddingMm: defaultBar.endPaddingMm,
			phase: 'layout'
		};
	}

	function loadSettings(): PlateBadgeSettings {
		const fallback = defaultSettings();
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return fallback;
			const parsed = JSON.parse(raw) as Partial<PlateBadgeSettings>;
			const slotForLoad = normalizePlateSlotDimensions({
				widthMm: clampPlateSlotWidthMm(
					numOr(parsed.slotWidthMm, fallback.slotWidthMm ?? defaultPlateSlotDimensions().widthMm)
				),
				heightMm: clampPlateSlotHeightMm(
					numOr(parsed.slotHeightMm, fallback.slotHeightMm ?? defaultPlateSlotDimensions().heightMm)
				)
			});
			const holeForLoad = numOr(
				parsed.holeSpacingMm,
				fallback.holeSpacingMm ?? defaultPlateBarParams(slotForLoad).holeSpacingMm
			);
			const endPadForLoad =
				parsed.endPaddingMm != null
					? numOr(parsed.endPaddingMm, PLATE_END_PADDING_DEFAULT_MM)
					: parsed.baseLengthMm != null
						? plateEndPaddingFromLegacyBaseLengthMm(
								numOr(parsed.baseLengthMm, defaultPlateBarParams(slotForLoad).baseLengthMm),
								holeForLoad,
								slotForLoad.widthMm
							)
						: (fallback.endPaddingMm ?? defaultPlateBarParams(slotForLoad).endPaddingMm);
			const barForLoad = normalizePlateBarParams(
				{
					holeSpacingMm: holeForLoad,
					endPaddingMm: endPadForLoad,
					baseHeightMm: numOr(
						parsed.baseHeightMm,
						fallback.baseHeightMm ?? defaultPlateBarParams(slotForLoad).baseHeightMm
					)
				},
				slotForLoad
			);
			const rawList = Array.isArray(parsed.elements) ? parsed.elements : [];
			const elements: CanvasElement[] = rawList
				.filter((e): e is CanvasElement => !!e && typeof e === 'object' && 'kind' in (e as object))
				.map((el) => {
					const e = el as CanvasElement;
					const c = clampElementCenterToPlate(numOr(e.x, 0), numOr(e.y, 0), barForLoad, e);
					const rest = { ...e } as CanvasElement & {
						outlineColor?: string;
						outlineEnabled?: boolean;
						outlineThickness?: number;
					};
					delete rest.outlineColor;
					delete rest.outlineEnabled;
					delete rest.outlineThickness;
					return {
						...rest,
						x: c.x,
						y: c.y,
						depth: clampPlateElementDepthMm(numOr(e.depth, 3))
					} as CanvasElement;
				});
			return {
				elements: elements.length > 0 ? elements : fallback.elements,
				baseThickness: clampPlateBaseThicknessMm(
					numOr(
						parsed.baseThickness ?? parsed.baseDepth,
						fallback.baseThickness ?? fallback.baseDepth ?? 2
					)
				),
				baseHeightMm: barForLoad.baseHeightMm,
				outlineThicknessMm: clampElementOutlineThicknessMm(
					numOr(
						parsed.outlineThicknessMm,
						numOr(
							parsed.baseThickness ?? parsed.baseDepth,
							fallback.outlineThicknessMm ?? fallback.baseThickness ?? 2
						)
					)
				),
				baseColor: strOr(parsed.baseColor, fallback.baseColor),
				slotWidthMm: slotForLoad.widthMm,
				slotHeightMm: slotForLoad.heightMm,
				holeSpacingMm: barForLoad.holeSpacingMm,
				endPaddingMm: barForLoad.endPaddingMm,
				phase: parsed.phase === 'threeD' ? 'threeD' : 'layout',
				viewport: sanitizeViewport(parsed.viewport)
			};
		} catch (e) {
			console.error('Plate badge: failed to load settings', e);
			return fallback;
		}
	}

	function sanitizeViewport(v: unknown): CanvasStudioViewport | undefined {
		if (!v || typeof v !== 'object') return undefined;
		const o = v as Record<string, unknown>;
		const scale = Number(o.scale);
		const x = Number(o.x);
		const y = Number(o.y);
		if (!Number.isFinite(scale) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
		return { scale, x, y };
	}

	function numOr(v: unknown, def: number): number {
		const n = Number(v);
		return Number.isFinite(n) ? n : def;
	}
	function strOr(v: unknown, def: string): string {
		return typeof v === 'string' && v ? v : def;
	}

	const initial = loadSettings();
	let elements = $state<CanvasElement[]>(initial.elements);
	let baseThickness = $state(
		clampPlateBaseThicknessMm(initial.baseThickness ?? initial.baseDepth ?? 2)
	);
	let baseHeightMm = $state(
		clampPlateBaseHeightMm(initial.baseHeightMm ?? defaultPlateBarParams().baseHeightMm)
	);
	let outlineThicknessMm = $state(
		clampElementOutlineThicknessMm(initial.outlineThicknessMm ?? initial.baseThickness ?? 2)
	);
	let baseColor = $state(initial.baseColor);
	let slotWidthMm = $state(
		clampPlateSlotWidthMm(initial.slotWidthMm ?? defaultPlateSlotDimensions().widthMm)
	);
	let slotHeightMm = $state(
		clampPlateSlotHeightMm(initial.slotHeightMm ?? defaultPlateSlotDimensions().heightMm)
	);
	let holeSpacingMm = $state(initial.holeSpacingMm ?? defaultPlateBarParams().holeSpacingMm);
	let endPaddingMm = $state(initial.endPaddingMm ?? defaultPlateBarParams().endPaddingMm);

	const plateSlotDims = $derived<PlateSlotDimensions>({
		widthMm: slotWidthMm,
		heightMm: slotHeightMm
	});
	const plateBarParams = $derived<PlateBarParams>(
		normalizePlateBarParams({ holeSpacingMm, endPaddingMm, baseHeightMm }, plateSlotDims)
	);
	const plateHalfLengthMm = $derived(plateBarParams.baseLengthMm / 2);
	const plateHalfHeightMm = $derived(plateBarParams.baseHeightMm / 2);
	const computedBaseLengthMm = $derived(plateBarParams.baseLengthMm);
	const maxHoleSpacingMm = $derived(maxPlateHoleSpacingMm(endPaddingMm, slotWidthMm));
	const maxEndPaddingMm = $derived(maxPlateEndPaddingMm(holeSpacingMm, slotWidthMm));

	function clampElToPlate(x: number, y: number, el: CanvasElement) {
		return clampElementCenterToPlate(x, y, plateBarParams, el);
	}

	function patchAffectsPlacement(patch: Partial<CanvasElement>): boolean {
		return (
			'x' in patch ||
			'y' in patch ||
			'size' in patch ||
			'rotation' in patch ||
			'scaleX' in patch ||
			'scaleY' in patch ||
			'content' in patch ||
			'fontKey' in patch ||
			'shapeId' in patch
		);
	}

	function patchNeedsGeometryRegen(patch: Partial<CanvasElement>): boolean {
		return (
			'content' in patch ||
			'fontKey' in patch ||
			'size' in patch ||
			'shapeId' in patch ||
			'lineSpacingMm' in patch
		);
	}

	function patchNeedsSilhouetteRegen(patch: Partial<CanvasElement>): boolean {
		return patchNeedsGeometryRegen(patch) || patchAffectsPlacement(patch);
	}

	function applyElementPatchToKonva(el: CanvasElement, patch: Partial<CanvasElement>): boolean {
		const node = pathNodes.get(el.id);
		if (!node || !konvaContentLayer || patchNeedsGeometryRegen(patch)) return false;
		if ('color' in patch && node.fill() !== el.color) node.fill(el.color);
		const a = konvaAttrsFromElement(el);
		node.x(a.x);
		node.y(a.y);
		node.rotation(a.rotation);
		node.scaleX(a.scaleX);
		node.scaleY(a.scaleY);
		konvaContentLayer.batchDraw();
		return true;
	}

	let phase = $state<'layout' | 'threeD'>(initial.phase);
	let selectedId = $state<string | null>(initial.elements[0]?.id ?? null);
	let viewport = $state<CanvasStudioViewport | null>(initial.viewport ?? null);

	remoteShapesStore.ensure();

	const shapeCategories = $derived.by(() => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const s of remoteShapesStore.shapes) {
			if (seen.has(s.category)) continue;
			seen.add(s.category);
			out.push(s.category);
		}
		return out;
	});

	$effect(() => {
		const bar = normalizePlateBarParams({ holeSpacingMm, endPaddingMm, baseHeightMm }, plateSlotDims);
		if (bar.holeSpacingMm !== holeSpacingMm) holeSpacingMm = bar.holeSpacingMm;
		if (bar.endPaddingMm !== endPaddingMm) endPaddingMm = bar.endPaddingMm;
		if (bar.baseHeightMm !== baseHeightMm) baseHeightMm = bar.baseHeightMm;
	});

	$effect(() => {
		void plateBarParams.baseLengthMm;
		let changed = false;
		const next = elements.map((el) => {
			const c = clampElementCenterToPlate(el.x, el.y, plateBarParams, el);
			if (c.x === el.x && c.y === el.y) return el;
			changed = true;
			return { ...el, x: c.x, y: c.y };
		});
		if (changed) elements = next;
	});

	$effect(() => {
		void plateBarParams;
		syncKonvaDesignZone();
		scheduleBaseSilhouetteSync();
	});

	$effect(() => {
		void plateSlotDims;
		void outlineThicknessMm;
		void elements;
		scheduleBaseSilhouetteSync();
		if (phase === 'layout') scheduleKonvaSync();
	});

	$effect(() => {
		void elements;
		void baseThickness;
		void baseHeightMm;
		void outlineThicknessMm;
		void baseColor;
		void slotWidthMm;
		void slotHeightMm;
		void holeSpacingMm;
		void endPaddingMm;
		void phase;
		void viewport;
		schedulePersistSettings();
	});

	const selectedElement = $derived(elements.find((e) => e.id === selectedId) ?? null);
	const selectedPosLimits = $derived.by(() => {
		if (!selectedElement) {
			return {
				xMin: -plateHalfLengthMm,
				xMax: plateHalfLengthMm,
				yMin: -plateHalfHeightMm,
				yMax: plateHalfHeightMm
			};
		}
		return plateElementCenterLimits(selectedElement, plateBarParams);
	});
	function setSelected(id: string | null) {
		selectedId = id;
		syncSelectionToKonva();
	}

	function pushElementsToKonva() {
		syncElementsToKonva();
		syncSelectionToKonva();
	}

	const KONVA_SYNC_DEBOUNCE_MS = 48;
	const SILHOUETTE_DEBOUNCE_MS = 72;
	const PERSIST_DEBOUNCE_MS = 280;
	const THREE_PREVIEW_DEBOUNCE_MS = 100;
	const PREVIEW_INDICATOR_DELAY_MS = 100;

	let konvaSyncTimer: ReturnType<typeof setTimeout> | null = null;
	let konvaSyncRaf: number | null = null;
	let silhouetteTimer: ReturnType<typeof setTimeout> | null = null;
	let silhouetteIdleId: number | null = null;
	let persistTimer: ReturnType<typeof setTimeout> | null = null;
	let threePreviewTimer: ReturnType<typeof setTimeout> | null = null;
	let threePreviewRaf: number | null = null;
	let layoutPreviewBusy = $state(false);
	let layoutPreviewVisible = $state(false);
	let scenePreviewBusy = $state(false);
	let scenePreviewVisible = $state(false);
	let layoutPreviewRevealTimer: ReturnType<typeof setTimeout> | null = null;
	let scenePreviewRevealTimer: ReturnType<typeof setTimeout> | null = null;
	const elementGeometryKeys = new Map<string, string>();

	function setPreviewIndicatorBusy(kind: 'layout' | 'scene', busy: boolean) {
		if (kind === 'layout') {
			layoutPreviewBusy = busy;
			if (busy) {
				if (layoutPreviewRevealTimer === null) {
					layoutPreviewRevealTimer = setTimeout(() => {
						layoutPreviewRevealTimer = null;
						if (layoutPreviewBusy) layoutPreviewVisible = true;
					}, PREVIEW_INDICATOR_DELAY_MS);
				}
				return;
			}
			if (layoutPreviewRevealTimer !== null) {
				clearTimeout(layoutPreviewRevealTimer);
				layoutPreviewRevealTimer = null;
			}
			layoutPreviewVisible = false;
			return;
		}
		scenePreviewBusy = busy;
		if (busy) {
			if (scenePreviewRevealTimer === null) {
				scenePreviewRevealTimer = setTimeout(() => {
					scenePreviewRevealTimer = null;
					if (scenePreviewBusy) scenePreviewVisible = true;
				}, PREVIEW_INDICATOR_DELAY_MS);
			}
			return;
		}
		if (scenePreviewRevealTimer !== null) {
			clearTimeout(scenePreviewRevealTimer);
			scenePreviewRevealTimer = null;
		}
		scenePreviewVisible = false;
	}

	function syncLayoutPreviewBusy() {
		setPreviewIndicatorBusy(
			'layout',
			konvaSyncTimer !== null ||
				konvaSyncRaf !== null ||
				silhouetteTimer !== null ||
				silhouetteIdleId !== null
		);
	}

	function syncScenePreviewBusy() {
		setPreviewIndicatorBusy(
			'scene',
			threePreviewTimer !== null ||
				threePreviewRaf !== null ||
				scenePrebuildTimer !== null ||
				scenePrebuildIdleId !== null ||
				rebuildDebounceTimer !== null ||
				rebuildPending
		);
	}

	function clearPreviewIndicatorTimers() {
		if (layoutPreviewRevealTimer !== null) {
			clearTimeout(layoutPreviewRevealTimer);
			layoutPreviewRevealTimer = null;
		}
		if (scenePreviewRevealTimer !== null) {
			clearTimeout(scenePreviewRevealTimer);
			scenePreviewRevealTimer = null;
		}
		layoutPreviewBusy = false;
		layoutPreviewVisible = false;
		scenePreviewBusy = false;
		scenePreviewVisible = false;
	}

	function clearDeferredLayoutWork() {
		if (konvaSyncTimer !== null) {
			clearTimeout(konvaSyncTimer);
			konvaSyncTimer = null;
		}
		if (konvaSyncRaf !== null) {
			cancelAnimationFrame(konvaSyncRaf);
			konvaSyncRaf = null;
		}
		if (silhouetteTimer !== null) {
			clearTimeout(silhouetteTimer);
			silhouetteTimer = null;
		}
		if (silhouetteIdleId !== null && typeof cancelIdleCallback !== 'undefined') {
			cancelIdleCallback(silhouetteIdleId);
			silhouetteIdleId = null;
		}
		if (persistTimer !== null) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		if (threePreviewTimer !== null) {
			clearTimeout(threePreviewTimer);
			threePreviewTimer = null;
		}
		if (threePreviewRaf !== null) {
			cancelAnimationFrame(threePreviewRaf);
			threePreviewRaf = null;
		}
		cancelScenePrebuild();
		syncLayoutPreviewBusy();
		syncScenePreviewBusy();
	}

	function cancelScenePrebuild() {
		if (scenePrebuildTimer !== null) {
			clearTimeout(scenePrebuildTimer);
			scenePrebuildTimer = null;
		}
		if (scenePrebuildIdleId !== null && typeof cancelIdleCallback !== 'undefined') {
			cancelIdleCallback(scenePrebuildIdleId);
			scenePrebuildIdleId = null;
		}
	}

	function invalidateScenePreview() {
		lastAppliedSceneKey = '';
	}

	function sceneCacheKey(): string {
		const baseThicknessSafe = Math.max(0.1, baseThickness);
		const outlineWidthSafe = clampElementOutlineThicknessMm(outlineThicknessMm);
		const plateKey = plateRebuildKey(baseThicknessSafe, outlineWidthSafe);
		const artSig = elements
			.map((e) => {
				const depth = clampPlateElementDepthMm(e.depth);
				if (e.kind === 'text') {
					return `${e.id}:t:${e.x.toFixed(3)}:${e.y.toFixed(3)}:${e.rotation.toFixed(4)}:${e.scaleX}:${e.scaleY}:${depth}:${e.color}:${e.content}|${e.fontKey}|${e.size}|${e.lineSpacingMm ?? ''}`;
				}
				return `${e.id}:s:${e.x.toFixed(3)}:${e.y.toFixed(3)}:${e.rotation.toFixed(4)}:${e.scaleX}:${e.scaleY}:${depth}:${e.color}:${e.shapeId}|${e.size}`;
			})
			.join(';');
		return `${plateKey}::${artSig}`;
	}

	function sceneArtIsCurrent(key: string = sceneCacheKey()): boolean {
		if (key !== lastAppliedSceneKey || !group) return false;
		if (!findPlateBaseMesh()) return false;
		if (elements.length === 0) return true;
		return group.children.some(isPlateBadgeArtObject);
	}

	function scheduleScenePrebuild() {
		if (phase === 'threeD') return;
		cancelScenePrebuild();
		scenePrebuildTimer = setTimeout(() => {
			scenePrebuildTimer = null;
			const run = () => {
				scenePrebuildIdleId = null;
				if (phase === 'threeD' || !threeHostEl) return;
				const key = sceneCacheKey();
				if (sceneArtIsCurrent(key)) return;
				ensureThreeScene();
				refreshPlateBadgeScene({ allowLayout: true });
			};
			if (typeof requestIdleCallback !== 'undefined') {
				scenePrebuildIdleId = requestIdleCallback(run, { timeout: 400 });
			} else {
				requestAnimationFrame(run);
			}
			syncScenePreviewBusy();
		}, 120);
		syncScenePreviewBusy();
	}

	function scheduleKonvaSync() {
		if (konvaSyncTimer !== null) clearTimeout(konvaSyncTimer);
		konvaSyncTimer = setTimeout(() => {
			konvaSyncTimer = null;
			if (konvaSyncRaf !== null) cancelAnimationFrame(konvaSyncRaf);
			konvaSyncRaf = requestAnimationFrame(() => {
				konvaSyncRaf = null;
				pushElementsToKonva();
				syncLayoutPreviewBusy();
			});
			syncLayoutPreviewBusy();
		}, KONVA_SYNC_DEBOUNCE_MS);
		syncLayoutPreviewBusy();
	}

	function clearKonvaSyncTimers() {
		if (konvaSyncTimer !== null) {
			clearTimeout(konvaSyncTimer);
			konvaSyncTimer = null;
		}
		if (konvaSyncRaf !== null) {
			cancelAnimationFrame(konvaSyncRaf);
			konvaSyncRaf = null;
		}
		syncLayoutPreviewBusy();
	}

	function flushKonvaSync() {
		clearKonvaSyncTimers();
		pushElementsToKonva();
		syncLayoutPreviewBusy();
	}

	function elementGeometryKey(el: CanvasElement): string {
		if (el.kind === 'text') {
			return `${el.content}|${el.fontKey}|${el.size}|${el.lineSpacingMm ?? ''}`;
		}
		return `${el.shapeId}|${el.size}`;
	}

	function applyBaseSilhouetteToKonva() {
		if (!konvaBaseSilhouettePath) return;
		konvaBaseSilhouettePath.data(
			plateBaseSilhouetteKonvaPathD(
				elements,
				clampElementOutlineThicknessMm(outlineThicknessMm),
				plateSlotDims,
				plateBarParams
			)
		);
		konvaGuideLayer?.batchDraw();
	}

	function scheduleBaseSilhouetteSync() {
		if (phase !== 'layout') return;
		if (silhouetteTimer !== null) clearTimeout(silhouetteTimer);
		silhouetteTimer = setTimeout(() => {
			silhouetteTimer = null;
			const run = () => {
				silhouetteIdleId = null;
				applyBaseSilhouetteToKonva();
				syncLayoutPreviewBusy();
			};
			if (typeof requestIdleCallback !== 'undefined') {
				silhouetteIdleId = requestIdleCallback(run, { timeout: 120 });
			} else {
				requestAnimationFrame(run);
			}
			syncLayoutPreviewBusy();
		}, SILHOUETTE_DEBOUNCE_MS);
		syncLayoutPreviewBusy();
	}

	function flushBaseSilhouetteSync() {
		if (silhouetteTimer !== null) {
			clearTimeout(silhouetteTimer);
			silhouetteTimer = null;
		}
		if (silhouetteIdleId !== null && typeof cancelIdleCallback !== 'undefined') {
			cancelIdleCallback(silhouetteIdleId);
			silhouetteIdleId = null;
		}
		applyBaseSilhouetteToKonva();
		syncLayoutPreviewBusy();
	}

	function syncKonvaDesignZone() {
		if (!konvaDesignZoneLine) return;
		const dz = plateDesignZone(plateBarParams);
		const yTop = -dz.maxY;
		const yBot = -dz.minY;
		konvaDesignZoneLine.points([
			dz.minX,
			yTop,
			dz.maxX,
			yTop,
			dz.maxX,
			yBot,
			dz.minX,
			yBot,
			dz.minX,
			yTop
		]);
		konvaGuideLayer?.batchDraw();
	}

	function schedulePersistSettings() {
		if (persistTimer !== null) clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			persistTimer = null;
			const snap: PlateBadgeSettings = {
				elements,
				baseThickness,
				baseHeightMm: plateBarParams.baseHeightMm,
				outlineThicknessMm: clampElementOutlineThicknessMm(outlineThicknessMm),
				baseColor,
				slotWidthMm: clampPlateSlotWidthMm(slotWidthMm),
				slotHeightMm: clampPlateSlotHeightMm(slotHeightMm),
				holeSpacingMm: plateBarParams.holeSpacingMm,
				endPaddingMm: plateBarParams.endPaddingMm,
				phase,
				viewport: viewport ?? undefined
			};
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
			} catch (e) {
				console.error('Plate badge: persist failed', e);
			}
		}, PERSIST_DEBOUNCE_MS);
	}

	function addText() {
		const { x: cx, y: cy } = artboardMmAtCanvasCenter();
		const draft: TextElement = {
			id: makeId(),
			kind: 'text',
			content: 'Text',
			fontKey: FONT_OPTIONS[0]?.key ?? 'Titan One_Regular',
			size: 12,
			x: cx,
			y: cy,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			color: '#f8fafc',
			depth: 3
		};
		const c = clampElToPlate(cx, cy, draft);
		const el: TextElement = { ...draft, x: c.x, y: c.y };
		elements = [...elements, el];
		selectedId = el.id;
		shapePickerOpen = false;
		flushKonvaSync();
		flushBaseSilhouetteSync();
	}

	function addShape(shapeId: string) {
		const def = getShape(shapeId);
		if (!def) return;
		const { x: cx, y: cy } = artboardMmAtCanvasCenter();
		const draft: ShapeElement = {
			id: makeId(),
			kind: 'shape',
			shapeId,
			size: 18,
			x: cx,
			y: cy,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			color: '#f472b6',
			depth: 3
		};
		const c = clampElToPlate(cx, cy, draft);
		const el: ShapeElement = { ...draft, x: c.x, y: c.y };
		elements = [...elements, el];
		selectedId = el.id;
		shapePickerOpen = false;
		flushKonvaSync();
		flushBaseSilhouetteSync();
	}

	function updateElement(id: string, patch: Partial<CanvasElement>) {
		elements = elements.map((el) => {
			if (el.id !== id) return el;
			const merged = { ...el, ...patch } as CanvasElement;
			if (!patchAffectsPlacement(patch)) return merged;
			const c = clampElToPlate(merged.x, merged.y, merged);
			return { ...merged, x: c.x, y: c.y };
		});
		const el = elements.find((e) => e.id === id);
		if (el && applyElementPatchToKonva(el, patch)) {
			if (patchNeedsSilhouetteRegen(patch)) scheduleBaseSilhouetteSync();
			return;
		}
		scheduleKonvaSync();
		if (patchNeedsSilhouetteRegen(patch)) scheduleBaseSilhouetteSync();
	}

	function removeElement(id: string) {
		elements = elements.filter((el) => el.id !== id);
		if (selectedId === id) selectedId = elements[elements.length - 1]?.id ?? null;
		flushKonvaSync();
		flushBaseSilhouetteSync();
	}

	function duplicateElement(id: string) {
		const idx = elements.findIndex((e) => e.id === id);
		if (idx < 0) return;
		const source = elements[idx];
		const copy = { ...source, id: makeId(), x: source.x + 4, y: source.y - 4 } as CanvasElement;
		const c = clampElToPlate(copy.x, copy.y, copy);
		const placed = { ...copy, x: c.x, y: c.y };
		const next = [...elements];
		next.splice(idx + 1, 0, placed);
		elements = next;
		selectedId = placed.id;
		flushKonvaSync();
		flushBaseSilhouetteSync();
	}

	function moveElement(id: string, delta: number) {
		const idx = elements.findIndex((e) => e.id === id);
		if (idx < 0) return;
		const target = idx + delta;
		if (target < 0 || target >= elements.length) return;
		const next = [...elements];
		const [el] = next.splice(idx, 1);
		next.splice(target, 0, el);
		elements = next;
		flushKonvaSync();
	}

	function flipElement(id: string, axis: 'x' | 'y') {
		const el = elements.find((e) => e.id === id);
		if (!el) return;
		if (axis === 'x') updateElement(id, { scaleX: -el.scaleX });
		else updateElement(id, { scaleY: -el.scaleY });
	}

	let canvasHostEl: HTMLDivElement | null = $state(null);
	let shapePickerOpen = $state(false);
	let stageZoomPct = $state(100);
	let isSpaceDown = $state(false);

	let konvaStage: Konva.Stage | null = null;
	let konvaGridLayer: Konva.Layer | null = null;
	let konvaGuideLayer: Konva.Layer | null = null;
	let konvaBaseSilhouettePath: Konva.Path | null = null;
	let konvaDesignZoneLine: Konva.Line | null = null;
	let konvaContentLayer: Konva.Layer | null = null;
	let konvaUiLayer: Konva.Layer | null = null;
	let konvaTransformer: Konva.Transformer | null = null;
	let konvaWheelPreventer: ((e: WheelEvent) => void) | null = null;
	let konvaWindowResize: (() => void) | null = null;
	let konvaInitFrame: number | null = null;
	let didInitialMeasure = false;
	const pathNodes = new Map<string, Konva.Path>();

	const MIN_ZOOM = 0.35;
	const MAX_ZOOM = 16;
	/** ~3 px/mm so a ~200 mm plate fits comfortably. */
	const INITIAL_SCALE = 3;

	function initKonva(host: HTMLDivElement) {
		if (konvaStage) return;
		const rect = host.getBoundingClientRect();
		const w0 = Math.max(1, rect.width || window.innerWidth - 360);
		const h0 = Math.max(1, rect.height || window.innerHeight - 64);

		konvaStage = new Konva.Stage({ container: host, width: w0, height: h0 });
		konvaGridLayer = new Konva.Layer({ listening: false });
		konvaGuideLayer = new Konva.Layer({ listening: false });
		konvaContentLayer = new Konva.Layer();
		konvaUiLayer = new Konva.Layer();
		konvaStage.add(konvaGridLayer);
		konvaStage.add(konvaGuideLayer);
		konvaStage.add(konvaContentLayer);
		konvaStage.add(konvaUiLayer);

		if (viewport) {
			konvaStage.scale({ x: viewport.scale, y: viewport.scale });
			konvaStage.position({ x: viewport.x, y: viewport.y });
			stageZoomPct = Math.round(viewport.scale * (100 / INITIAL_SCALE));
			didInitialMeasure = true;
		} else {
			konvaStage.scale({ x: INITIAL_SCALE, y: INITIAL_SCALE });
			konvaStage.position({ x: w0 / 2, y: h0 / 2 });
			stageZoomPct = 100;
			didInitialMeasure = rect.width > 0 && rect.height > 0;
		}

		konvaBaseSilhouettePath = new Konva.Path({
			data: plateBaseSilhouetteKonvaPathD(
				elements,
				clampElementOutlineThicknessMm(outlineThicknessMm),
				plateSlotDims,
				plateBarParams
			),
			fill: 'rgba(14, 165, 233, 0.07)',
			stroke: '#0ea5e9',
			strokeWidth: 1.1,
			strokeScaleEnabled: false,
			fillRule: 'evenodd',
			listening: false,
			perfectDrawEnabled: false
		});
		konvaGuideLayer.add(konvaBaseSilhouettePath);
		const dz = plateDesignZone(plateBarParams);
		const yTop = -dz.maxY;
		const yBot = -dz.minY;
		konvaDesignZoneLine = new Konva.Line({
			points: [dz.minX, yTop, dz.maxX, yTop, dz.maxX, yBot, dz.minX, yBot, dz.minX, yTop],
			stroke: '#64748b',
			strokeWidth: 0.65,
			dash: [5, 4],
			strokeScaleEnabled: false,
			listening: false,
			closed: false
		});
		konvaGuideLayer.add(konvaDesignZoneLine);
		konvaGuideLayer.batchDraw();

		konvaTransformer = new Konva.Transformer({
			rotationSnaps: [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180],
			rotationSnapTolerance: 4,
			anchorSize: 10,
			anchorStroke: '#6366f1',
			anchorStrokeWidth: 1.5,
			anchorFill: '#ffffff',
			anchorCornerRadius: 2,
			borderStroke: '#6366f1',
			borderStrokeWidth: 1.2,
			borderDash: [4, 3],
			rotateAnchorOffset: 28,
			keepRatio: false,
			ignoreStroke: true,
			flipEnabled: true,
			padding: 2
		});
		konvaUiLayer.add(konvaTransformer);

		konvaStage.on('wheel', onStageWheel);
		konvaStage.on('mousedown touchstart', onStageMouseDown);
		konvaStage.on('click tap', onStageClick);

		konvaWheelPreventer = (e) => e.preventDefault();
		host.addEventListener('wheel', konvaWheelPreventer, { passive: false });

		konvaWindowResize = () => applyHostSize(host);
		window.addEventListener('resize', konvaWindowResize);
		konvaInitFrame = requestAnimationFrame(() => {
			konvaInitFrame = null;
			applyHostSize(host);
		});

		drawKonvaGrid();
		syncElementsToKonva();
		syncSelectionToKonva();
	}

	function applyHostSize(host: HTMLDivElement) {
		if (!konvaStage) return;
		const r = host.getBoundingClientRect();
		const newW = Math.max(1, r.width);
		const newH = Math.max(1, r.height);
		const prevW = konvaStage.width();
		const prevH = konvaStage.height();
		if (newW === prevW && newH === prevH) return;
		konvaStage.width(newW);
		konvaStage.height(newH);
		if (!didInitialMeasure && r.width > 0 && r.height > 0) {
			konvaStage.position({ x: newW / 2, y: newH / 2 });
			didInitialMeasure = true;
			captureViewport();
		}
		drawKonvaGrid();
	}

	function disposeKonva() {
		captureViewport();
		if (konvaInitFrame !== null) {
			cancelAnimationFrame(konvaInitFrame);
			konvaInitFrame = null;
		}
		if (konvaWindowResize) {
			window.removeEventListener('resize', konvaWindowResize);
			konvaWindowResize = null;
		}
		if (konvaWheelPreventer && canvasHostEl) {
			canvasHostEl.removeEventListener('wheel', konvaWheelPreventer);
		}
		konvaWheelPreventer = null;
		konvaTransformer?.destroy();
		konvaTransformer = null;
		konvaStage?.destroy();
		konvaStage = null;
		konvaGridLayer = null;
		konvaGuideLayer = null;
		konvaContentLayer = null;
		konvaUiLayer = null;
		pathNodes.clear();
		elementGeometryKeys.clear();
		clearDeferredLayoutWork();
		clearPreviewIndicatorTimers();
	}

	function captureViewport() {
		if (!konvaStage) return;
		viewport = {
			scale: konvaStage.scaleX(),
			x: konvaStage.x(),
			y: konvaStage.y()
		};
	}

	function artboardMmAtCanvasCenter(): { x: number; y: number } {
		if (!konvaStage) return { x: 0, y: 0 };
		const stage = konvaStage;
		const scale = stage.scaleX();
		const cx = stage.width() / 2;
		const cy = stage.height() / 2;
		const kx = (cx - stage.x()) / scale;
		const ky = (cy - stage.y()) / scale;
		return { x: kx, y: -ky };
	}

	function konvaAttrsFromElement(el: CanvasElement): {
		x: number;
		y: number;
		rotation: number;
		scaleX: number;
		scaleY: number;
	} {
		return {
			x: el.x,
			y: -el.y,
			rotation: (-el.rotation * 180) / Math.PI,
			scaleX: el.scaleX,
			scaleY: el.scaleY
		};
	}

	function elementUpdatesFromKonva(node: Konva.Node): Partial<CanvasElement> {
		return {
			x: node.x(),
			y: -node.y(),
			rotation: (-node.rotation() * Math.PI) / 180,
			scaleX: node.scaleX(),
			scaleY: node.scaleY()
		};
	}

	function createPathNode(el: CanvasElement): Konva.Path {
		const attrs = konvaAttrsFromElement(el);
		const node = new Konva.Path({
			id: el.id,
			data: elementToPathD(el),
			fill: el.color,
			stroke: '#64748b',
			strokeWidth: 1,
			strokeScaleEnabled: false,
			draggable: true,
			x: attrs.x,
			y: attrs.y,
			rotation: attrs.rotation,
			scaleX: attrs.scaleX,
			scaleY: attrs.scaleY
		});
		node.on('mousedown touchstart', () => setSelected(el.id));
		node.on('dragstart', () => setSelected(el.id));
		node.on('dragend', () => {
			const draft = { ...el, x: node.x(), y: -node.y() } as CanvasElement;
			const c = clampElToPlate(draft.x, draft.y, draft);
			updateElement(el.id, { x: c.x, y: c.y });
			node.x(c.x);
			node.y(-c.y);
			flushKonvaSync();
			flushBaseSilhouetteSync();
		});
		node.on('transformend', () => {
			const u = elementUpdatesFromKonva(node);
			const draft = {
				...el,
				...u,
				x: u.x ?? node.x(),
				y: u.y ?? -node.y()
			} as CanvasElement;
			const c = clampElToPlate(draft.x, draft.y, draft);
			updateElement(el.id, { ...u, x: c.x, y: c.y });
			node.x(c.x);
			node.y(-c.y);
			flushKonvaSync();
			flushBaseSilhouetteSync();
		});
		return node;
	}

	function syncElementsToKonva() {
		if (!konvaContentLayer) return;
		const ids = new Set(elements.map((e) => e.id));
		for (const [id, node] of pathNodes) {
			if (!ids.has(id)) {
				node.destroy();
				pathNodes.delete(id);
				elementGeometryKeys.delete(id);
			}
		}
		for (const el of elements) {
			let node = pathNodes.get(el.id);
			if (!node) {
				node = createPathNode(el);
				konvaContentLayer.add(node);
				pathNodes.set(el.id, node);
				elementGeometryKeys.set(el.id, elementGeometryKey(el));
			} else {
				const gk = elementGeometryKey(el);
				if (elementGeometryKeys.get(el.id) !== gk) {
					const expectedD = elementToPathD(el);
					if (node.data() !== expectedD) node.data(expectedD);
					elementGeometryKeys.set(el.id, gk);
				}
				if (node.fill() !== el.color) node.fill(el.color);
				if (node.stroke() !== '#64748b') node.stroke('#64748b');
				if (Math.abs(node.strokeWidth() - 1) > 1e-4) node.strokeWidth(1);
				const a = konvaAttrsFromElement(el);
				if (Math.abs(node.x() - a.x) > 1e-4) node.x(a.x);
				if (Math.abs(node.y() - a.y) > 1e-4) node.y(a.y);
				if (Math.abs(node.rotation() - a.rotation) > 1e-3) node.rotation(a.rotation);
				if (Math.abs(node.scaleX() - a.scaleX) > 1e-4) node.scaleX(a.scaleX);
				if (Math.abs(node.scaleY() - a.scaleY) > 1e-4) node.scaleY(a.scaleY);
			}
		}
		elements.forEach((el, i) => pathNodes.get(el.id)?.zIndex(i));
		konvaContentLayer.batchDraw();
	}

	function syncSelectionToKonva() {
		if (!konvaTransformer) return;
		const node = selectedId ? pathNodes.get(selectedId) ?? null : null;
		konvaTransformer.nodes(node ? [node] : []);
		konvaTransformer.getLayer()?.batchDraw();
	}

	function onStageWheel(e: Konva.KonvaEventObject<WheelEvent>) {
		if (!konvaStage) return;
		const stage = konvaStage;
		const oldScale = stage.scaleX();
		const pointer = stage.getPointerPosition();
		if (!pointer) return;
		const sensitivity = e.evt.ctrlKey ? 0.01 : 0.0015;
		const factor = Math.exp(-e.evt.deltaY * sensitivity);
		const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldScale * factor));
		const stagePointTo = {
			x: (pointer.x - stage.x()) / oldScale,
			y: (pointer.y - stage.y()) / oldScale
		};
		stage.scale({ x: newScale, y: newScale });
		stage.position({
			x: pointer.x - stagePointTo.x * newScale,
			y: pointer.y - stagePointTo.y * newScale
		});
		stageZoomPct = Math.round((newScale / INITIAL_SCALE) * 100);
		drawKonvaGrid();
		captureViewport();
	}

	type PanState = { startX: number; startY: number; ox: number; oy: number };
	let panState: PanState | null = null;

	function konvaClickShouldClearSelection(target: Konva.Node): boolean {
		let n: Konva.Node | null = target;
		while (n) {
			if (n instanceof Konva.Transformer) return false;
			if (n instanceof Konva.Path && pathNodes.has(n.id())) return false;
			n = n.getParent();
		}
		return true;
	}

	function onStageMouseDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
		if (!konvaStage) return;
		const stage = konvaStage;
		const evt = e.evt as MouseEvent;
		const isEmpty = konvaClickShouldClearSelection(e.target as Konva.Node);
		const middleBtn = evt && typeof evt.button === 'number' && evt.button === 1;
		const leftBtn = evt && typeof evt.button === 'number' && evt.button === 0;
		const wantsPan = middleBtn || (isSpaceDown && leftBtn) || (isEmpty && leftBtn);
		if (!wantsPan) return;
		evt.preventDefault?.();
		if (isEmpty && leftBtn && !isSpaceDown) setSelected(null);
		const p = stage.getPointerPosition();
		if (!p) return;
		panState = { startX: p.x, startY: p.y, ox: stage.x(), oy: stage.y() };
		stage.container().style.cursor = 'grabbing';
		const onMove = () => {
			if (!panState || !konvaStage) return;
			const cur = konvaStage.getPointerPosition();
			if (!cur) return;
			konvaStage.position({
				x: panState.ox + (cur.x - panState.startX),
				y: panState.oy + (cur.y - panState.startY)
			});
			drawKonvaGrid();
		};
		const onUp = () => {
			panState = null;
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
			if (konvaStage) konvaStage.container().style.cursor = isSpaceDown ? 'grab' : '';
			captureViewport();
		};
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

	function onStageClick(e: Konva.KonvaEventObject<MouseEvent>) {
		if (!konvaStage) return;
		if (konvaClickShouldClearSelection(e.target as Konva.Node)) setSelected(null);
	}

	function zoomBy(factor: number) {
		if (!konvaStage) return;
		const stage = konvaStage;
		const oldScale = stage.scaleX();
		const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldScale * factor));
		const cx = stage.width() / 2;
		const cy = stage.height() / 2;
		const point = { x: (cx - stage.x()) / oldScale, y: (cy - stage.y()) / oldScale };
		stage.scale({ x: newScale, y: newScale });
		stage.position({ x: cx - point.x * newScale, y: cy - point.y * newScale });
		stageZoomPct = Math.round((newScale / INITIAL_SCALE) * 100);
		drawKonvaGrid();
		captureViewport();
	}

	function resetView() {
		if (!konvaStage) return;
		const stage = konvaStage;
		stage.scale({ x: INITIAL_SCALE, y: INITIAL_SCALE });
		stage.position({ x: stage.width() / 2, y: stage.height() / 2 });
		stageZoomPct = 100;
		drawKonvaGrid();
		captureViewport();
	}

	function drawKonvaGrid() {
		if (!konvaStage || !konvaGridLayer) return;
		konvaGridLayer.destroyChildren();
		const stage = konvaStage;
		const sx = stage.scaleX();
		const w = stage.width();
		const h = stage.height();
		const left = -stage.x() / sx;
		const top = -stage.y() / sx;
		const right = (w - stage.x()) / sx;
		const bottom = (h - stage.y()) / sx;
		const buffer = 50;
		const showMinor = sx >= 3;

		const addLine = (
			x1: number,
			y1: number,
			x2: number,
			y2: number,
			stroke: string,
			width: number,
			dash?: number[]
		) => {
			konvaGridLayer!.add(
				new Konva.Line({
					points: [x1, y1, x2, y2],
					stroke,
					strokeWidth: width,
					strokeScaleEnabled: false,
					dash,
					listening: false,
					perfectDrawEnabled: false
				})
			);
		};

		const worldHalf = 2000;
		const xLo = Math.max(-worldHalf, Math.floor((left - buffer) / 5) * 5);
		const xHi = Math.min(worldHalf, Math.ceil((right + buffer) / 5) * 5);
		const yLo = Math.max(-worldHalf, Math.floor((top - buffer) / 5) * 5);
		const yHi = Math.min(worldHalf, Math.ceil((bottom + buffer) / 5) * 5);

		for (let x = xLo; x <= xHi; x += 5) {
			if (x === 0) continue;
			const isMajor = x % 10 === 0;
			if (!isMajor && !showMinor) continue;
			addLine(x, yLo, x, yHi, isMajor ? '#cbd5e1' : '#e2e8f0', isMajor ? 0.8 : 0.5);
		}
		for (let y = yLo; y <= yHi; y += 5) {
			if (y === 0) continue;
			const isMajor = y % 10 === 0;
			if (!isMajor && !showMinor) continue;
			addLine(xLo, y, xHi, y, isMajor ? '#cbd5e1' : '#e2e8f0', isMajor ? 0.8 : 0.5);
		}
		if (0 >= xLo && 0 <= xHi) addLine(0, yLo, 0, yHi, '#94a3b8', 0.8, [3, 3]);
		if (0 >= yLo && 0 <= yHi) addLine(xLo, 0, xHi, 0, '#94a3b8', 0.8, [3, 3]);

		konvaGridLayer.batchDraw();
	}

	function elementToPathD(el: CanvasElement): string {
		return clipperPathsToKonvaPathD(getLocalPathsForElement(el));
	}

	function onCanvasKeyDown(e: KeyboardEvent) {
		if (e.code === 'Space' && !isTextInputFocused(e.target)) {
			if (!isSpaceDown) {
				isSpaceDown = true;
				if (konvaStage) konvaStage.container().style.cursor = 'grab';
			}
			e.preventDefault();
			return;
		}
		if (isTextInputFocused(e.target) && e.key.startsWith('Arrow')) return;
		if (!selectedId) return;
		const el = elements.find((x) => x.id === selectedId);
		if (!el) return;
		if (e.key === 'Delete' || e.key === 'Backspace') {
			if (isTextInputFocused(e.target)) return;
			e.preventDefault();
			removeElement(selectedId);
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
			e.preventDefault();
			duplicateElement(selectedId);
			return;
		}
		const step = e.shiftKey ? 5 : 1;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			updateElement(el.id, { x: el.x - step });
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			updateElement(el.id, { x: el.x + step });
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			updateElement(el.id, { y: el.y + step });
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			updateElement(el.id, { y: el.y - step });
		}
	}

	function onCanvasKeyUp(e: KeyboardEvent) {
		if (e.code === 'Space') {
			isSpaceDown = false;
			if (konvaStage && !panState) konvaStage.container().style.cursor = '';
		}
	}

	function isTextInputFocused(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el) return false;
		const tag = el.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
	}

	let threeHostEl: HTMLDivElement | null = $state(null);
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let controls: InstanceType<typeof OrbitControls> | null = null;
	let group: THREE.Group | null = null;
	let keyLight: THREE.DirectionalLight | null = null;
	let shadowPlane: THREE.Mesh | null = null;
	let rafId = 0;
	let resizeObserver: ResizeObserver | null = null;
	let didInitFrame = false;
	let rebuildPending = false;
	let rebuildAgainAfterPending = false;
	let rebuildDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let threeDSessionActive = false;
	let sceneRefreshGeneration = 0;
	let lastAppliedSceneKey = '';
	let scenePrebuildTimer: ReturnType<typeof setTimeout> | null = null;
	let scenePrebuildIdleId: number | null = null;
	/** Bumps on each 3D rebuild so stale OpenSCAD results are discarded. */
	let plateRebuildGeneration = 0;
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);
	let openWithSlicerLoading = $state(false);
	let exportLoading = $state(false);
	let threeSelectionOutline: LineSegments2 | null = null;

	const threePickRaycaster = new THREE.Raycaster();
	const threePickNdc = new THREE.Vector2();
	let threePickDown: { x: number; y: number } | null = null;

	function onThreePickPointerDown(e: PointerEvent) {
		if (e.button !== 0 || phase !== 'threeD') return;
		threePickDown = { x: e.clientX, y: e.clientY };
		window.addEventListener('pointerup', onThreePickPointerUpWindow, { capture: true, once: true });
	}

	function onThreePickPointerCancel() {
		threePickDown = null;
	}

	function onThreePickPointerUpWindow(e: PointerEvent) {
		if (e.button !== 0) return;
		const down = threePickDown;
		threePickDown = null;
		if (phase !== 'threeD' || !down || !camera || !group || !renderer) return;
		const dx = e.clientX - down.x;
		const dy = e.clientY - down.y;
		if (dx * dx + dy * dy > 225) return;

		const rect = renderer.domElement.getBoundingClientRect();
		const px = e.clientX;
		const py = e.clientY;
		if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) return;

		threePickNdc.x = ((px - rect.left) / rect.width) * 2 - 1;
		threePickNdc.y = -((py - rect.top) / rect.height) * 2 + 1;
		threePickRaycaster.setFromCamera(threePickNdc, camera);
		const hits = threePickRaycaster.intersectObjects(group.children, true);
		for (const hit of hits) {
			let o: THREE.Object3D | null = hit.object;
			while (o) {
				const id = o.userData?.elementId as string | undefined;
				if (id) {
					setSelected(id);
					return;
				}
				o = o.parent;
			}
		}
		setSelected(null);
	}

	function attachThreePickListeners() {
		if (!renderer) return;
		const el = renderer.domElement;
		el.addEventListener('pointerdown', onThreePickPointerDown, { passive: true });
		el.addEventListener('pointercancel', onThreePickPointerCancel, { passive: true });
	}

	function detachThreePickListeners() {
		if (!renderer) return;
		const el = renderer.domElement;
		el.removeEventListener('pointerdown', onThreePickPointerDown);
		el.removeEventListener('pointercancel', onThreePickPointerCancel);
	}

	function ensureThreeScene() {
		if (!threeHostEl) return;
		if (renderer) {
			if (renderer.domElement.parentElement !== threeHostEl) {
				threeHostEl.appendChild(renderer.domElement);
				threeResize();
			}
			return;
		}
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);
		renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
		renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.05;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		threeHostEl.appendChild(renderer.domElement);
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';
		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.screenSpacePanning = false;
		controls.minDistance = 40;
		controls.maxDistance = 1400;
		controls.update();
		const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.25);
		scene.add(hemi);
		keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
		keyLight.position.set(80, -120, 140);
		keyLight.castShadow = true;
		keyLight.shadow.mapSize.width = 2048;
		keyLight.shadow.mapSize.height = 2048;
		keyLight.shadow.bias = -0.0001;
		keyLight.shadow.normalBias = 0.018;
		scene.add(keyLight);
		scene.add(keyLight.target);
		const rim = new THREE.DirectionalLight(0xffffff, 0.7);
		rim.position.set(-120, 90, 80);
		scene.add(rim);
		const fill = new THREE.DirectionalLight(0xffffff, 0.45);
		fill.position.set(40, 120, 60);
		scene.add(fill);
		const grid = new THREE.GridHelper(280, 28, 0xcbd5e1, 0xe2e8f0);
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

		resizeObserver = new ResizeObserver(() => threeResize());
		resizeObserver.observe(threeHostEl);
		threeResize();
		attachThreePickListeners();
		const tick = () => {
			rafId = requestAnimationFrame(tick);
			if (phase !== 'threeD') return;
			controls?.update();
			if (renderer && scene && camera) renderer.render(scene, camera);
		};
		tick();
	}

	function threeResize() {
		if (!renderer || !camera || !threeHostEl) return;
		const rect = threeHostEl.getBoundingClientRect();
		const w = Math.max(1, Math.floor(rect.width));
		const h = Math.max(1, Math.floor(rect.height));
		renderer.setSize(w, h, true);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	/** Fit directional shadow frustum to the model so map texels aren’t wasted (reduces blocky shadows). */
	function fitKeyLightShadowToModel() {
		if (phase !== 'threeD' || !keyLight?.shadow?.camera || !group || group.children.length === 0) return;
		group.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(group);
		if (box.isEmpty()) return;
		const sizeVec = new THREE.Vector3();
		box.getSize(sizeVec);
		const center = new THREE.Vector3();
		box.getCenter(center);
		const maxDim = Math.max(sizeVec.x, sizeVec.y, sizeVec.z, 1);
		const r = maxDim * 0.5 + 10;
		const cam = keyLight.shadow.camera as THREE.OrthographicCamera;
		cam.left = -r;
		cam.right = r;
		cam.top = r;
		cam.bottom = -r;
		cam.near = 0.5;
		cam.far = Math.max(120, maxDim * 10);
		cam.updateProjectionMatrix?.();
		keyLight.target.position.copy(center);
		keyLight.target.updateWorldMatrix?.(true, true);
	}

	const THREE_SELECT_OUTLINE = 0x6366f1;

	function disposeThreeSelectionOutline() {
		const o = threeSelectionOutline;
		threeSelectionOutline = null;
		if (!o) return;
		if (o.parent) o.parent.remove(o);
		o.geometry.dispose();
		(o.material as THREE.Material).dispose();
	}

	function findSelectedElementMesh(root: THREE.Group, elementId: string): THREE.Mesh | null {
		let found: THREE.Mesh | null = null;
		root.traverse((obj) => {
			if (found) return;
			if (!(obj instanceof THREE.Mesh)) return;
			if (obj.userData?.isElementOutline) return;
			const id = obj.userData?.elementId as string | undefined;
			if (id === elementId) found = obj;
		});
		return found;
	}

	function applyThreeSelectionHighlight() {
		disposeThreeSelectionOutline();
		if (phase !== 'threeD' || !group || !selectedId) return;
		const mesh = findSelectedElementMesh(group, selectedId);
		if (!mesh) return;
		const edges = new THREE.EdgesGeometry(mesh.geometry, 35);
		const posAttr = edges.getAttribute('position');
		const flat: number[] = [];
		for (let i = 0; i < posAttr.count; i++) {
			flat.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
		}
		edges.dispose();
		if (flat.length < 6) return;
		const lineGeom = new LineSegmentsGeometry();
		lineGeom.setPositions(flat);
		const lineMat = new LineMaterial({
			color: THREE_SELECT_OUTLINE,
			linewidth: 5,
			depthTest: true,
			depthWrite: false,
			polygonOffset: true,
			polygonOffsetFactor: -1,
			polygonOffsetUnits: -1
		});
		const lines = new LineSegments2(lineGeom, lineMat);
		lines.name = 'plateBadgeSelectionOutline';
		lines.renderOrder = 2;
		lines.raycast = () => {};
		threeSelectionOutline = lines;
		mesh.add(lines);
	}

	function buildElementOutlineMesh(
		el: CanvasElement,
		baseThicknessMm: number,
		outlineWidthMm: number,
		plateBaseColor: string
	): THREE.Mesh | null {
		const planW = Math.max(0.1, outlineWidthMm);
		const rimH = Math.max(0.1, baseThicknessMm);
		const outlineTree = subtractPlateMountingSlotsFromPolyTree(
			getElementOutlinePolyTree(el, planW),
			plateSlotDims,
			plateBarParams
		);
		const shapes = polyTreeToThreeShapes(outlineTree);
		if (shapes.length === 0) return null;
		const geo = new THREE.ExtrudeGeometry(shapes, {
			depth: rimH,
			bevelEnabled: false,
			curveSegments: 12
		});
		const mat = new THREE.MeshStandardMaterial({
			color: plateBaseColor,
			roughness: 0.85,
			metalness: 0.05
		});
		const mesh = new THREE.Mesh(geo, mat);
		mesh.name = 'elementOutline';
		mesh.userData.isElementOutline = true;
		mesh.userData.elementId = el.id;
		mesh.userData.outlinePlanWidthMm = planW;
		mesh.userData.outlineExtrudeDepthMm = rimH;
		return mesh;
	}

	function buildElementMesh(
		el: CanvasElement,
		textLayer: { extrudeDepthMm: number; bottomZMm: number }
	): THREE.Mesh | null {
		const worldPaths = getWorldPathsForElement(el);
		if (worldPaths.length === 0) return null;
		const tree = new ClipperLib.PolyTree();
		const c = new ClipperLib.Clipper();
		c.AddPaths(worldPaths, ClipperLib.PolyType.ptSubject, true);
		c.Execute(
			ClipperLib.ClipType.ctUnion,
			tree,
			ClipperLib.PolyFillType.pftNonZero,
			ClipperLib.PolyFillType.pftNonZero
		);
		const shapes = polyTreeToThreeShapes(tree);
		if (shapes.length === 0) return null;
		const d = Math.max(0.1, textLayer.extrudeDepthMm);
		const geo = new THREE.ExtrudeGeometry(shapes, {
			depth: d,
			bevelEnabled: false,
			curveSegments: 12
		});
		const mat = new THREE.MeshStandardMaterial({
			color: el.color,
			roughness: 0.35,
			metalness: 0.1
		});
		const mesh = new THREE.Mesh(geo, mat);
		mesh.name = 'element';
		mesh.userData.textExtrudeDepthMm = d;
		mesh.userData.textBottomZMm = textLayer.bottomZMm;
		return mesh;
	}

	function collectPlateOutlineMeshes(
		baseThicknessSafe: number,
		outlineWidthSafe: number
	): THREE.Mesh[] {
		const outlineParts: THREE.Mesh[] = [];
		for (let i = 0; i < elements.length; i++) {
			const el = elements[i];
			try {
				const outlineMesh = buildElementOutlineMesh(
					el,
					baseThicknessSafe,
					outlineWidthSafe,
					baseColor
				);
				if (!outlineMesh) continue;
				alignGeometryBottomToZ0(outlineMesh.geometry);
				outlineMesh.position.z = 0;
				outlineParts.push(outlineMesh);
			} catch (outlineErr) {
				console.warn('Plate badge: skip rim for element', el.id, outlineErr);
			}
		}
		return outlineParts;
	}

	function isPlateBadgeArtObject(obj: THREE.Object3D): boolean {
		return !!(obj.userData?.elementId || obj.userData?.isElementOutline);
	}

	function buildPlateBadgeArtMeshes(
		baseThicknessSafe: number,
		outlineWidthSafe: number
	): THREE.Object3D[] {
		const art: THREE.Object3D[] = [];
		const outlineParts = collectPlateOutlineMeshes(baseThicknessSafe, outlineWidthSafe);
		for (const om of outlineParts) {
			om.castShadow = true;
			om.receiveShadow = true;
			art.push(om);
		}
		for (let i = 0; i < elements.length; i++) {
			const el = elements[i];
			const textLayer = plateBadgeElementLayer3D(baseThicknessSafe, el.depth);
			const mesh = buildElementMesh(el, textLayer);
			if (!mesh) continue;
			alignGeometryBottomToZ0(mesh.geometry);
			mesh.position.z = textLayer.bottomZMm;
			mesh.userData.elementId = el.id;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			art.push(mesh);
		}
		return art;
	}

	function swapPlateBadgeArtMeshes(artMeshes: THREE.Object3D[]) {
		if (!group) return;
		for (const child of group.children.slice()) {
			if (!isPlateBadgeArtObject(child)) continue;
			group.remove(child);
			disposeObject3D(child);
		}
		for (const m of artMeshes) group.add(m);
	}

	function finalizePlateBadgeGroupFrame() {
		if (!group) return;
		group.position.set(0, 0, 0);
		group.scale.set(1, 1, 1);
		group.updateWorldMatrix(true, true);
		snapGroupBottomToBuildPlate(group);
		const box = new THREE.Box3().setFromObject(group);
		fitKeyLightShadowToModel();
		if (!didInitFrame && camera && controls) {
			frameCameraToObject(box, camera, controls);
			didInitFrame = true;
		}
		const size = measureWorldAabbSizeMm(group);
		modelAabbMm = size ? { x: size.x, y: size.y, z: size.z } : null;
	}

	function plateRebuildKey(baseThicknessSafe: number, outlineWidthSafe: number): string {
		return `${baseThicknessSafe.toFixed(2)}:${outlineWidthSafe.toFixed(2)}:${baseColor}:${slotWidthMm.toFixed(2)}:${slotHeightMm.toFixed(2)}:${plateBarParams.holeSpacingMm.toFixed(2)}:${plateBarParams.endPaddingMm.toFixed(2)}:${plateBarParams.baseHeightMm.toFixed(2)}`;
	}

	function findPlateBaseMesh(): THREE.Mesh | undefined {
		return group?.children.find(
			(c): c is THREE.Mesh => c instanceof THREE.Mesh && c.name === 'base'
		);
	}

	function installPlateBaseMesh(mesh: THREE.Mesh, plateKey: string, source: 'preview' | 'openscad') {
		if (!group) return;
		mesh.name = 'base';
		mesh.userData.plateKey = plateKey;
		mesh.userData.plateSource = source;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		alignGeometryBottomToZ0(mesh.geometry);
		mesh.position.z = 0;
		const existing = findPlateBaseMesh();
		if (existing) {
			group.remove(existing);
			disposeObject3D(existing);
		}
		group.add(mesh);
	}

	/** Instant 3D preview: sync plate depth + outlines/fills; OpenSCAD refines the base in the background. */
	function refreshPlateBadgeScene(options?: { allowLayout?: boolean }) {
		const key = sceneCacheKey();
		if (!options?.allowLayout && phase !== 'threeD') return;
		if (!group) return;
		if (sceneArtIsCurrent(key)) {
			if (phase === 'threeD') {
				applyThreeSelectionHighlight();
				syncScenePreviewBusy();
			}
			return;
		}

		const gen = ++sceneRefreshGeneration;
		const baseThicknessSafe = Math.max(0.1, baseThickness);
		const outlineWidthSafe = clampElementOutlineThicknessMm(outlineThicknessMm);
		const plateKey = plateRebuildKey(baseThicknessSafe, outlineWidthSafe);
		const existingPlate = findPlateBaseMesh();

		if (!existingPlate || existingPlate.userData.plateKey !== plateKey) {
			installPlateBaseMesh(
				buildPlateBaseMeshPreview(baseThicknessSafe, baseColor, plateSlotDims, plateBarParams),
				plateKey,
				'preview'
			);
		}

		if (gen !== sceneRefreshGeneration) return;

		disposeThreeSelectionOutline();
		const artMeshes = buildPlateBadgeArtMeshes(baseThicknessSafe, outlineWidthSafe);
		if (gen !== sceneRefreshGeneration) {
			for (const m of artMeshes) disposeObject3D(m);
			return;
		}
		swapPlateBadgeArtMeshes(artMeshes);
		lastAppliedSceneKey = key;
		finalizePlateBadgeGroupFrame();
		if (phase === 'threeD') applyThreeSelectionHighlight();
		syncScenePreviewBusy();
	}

	function cancelQueuedScenePreview() {
		if (threePreviewTimer !== null) {
			clearTimeout(threePreviewTimer);
			threePreviewTimer = null;
		}
		if (threePreviewRaf !== null) {
			cancelAnimationFrame(threePreviewRaf);
			threePreviewRaf = null;
		}
	}

	function runScenePreviewRefresh() {
		threePreviewRaf = null;
		if (phase !== 'threeD') {
			syncScenePreviewBusy();
			return;
		}
		ensureThreeScene();
		refreshPlateBadgeScene();
	}

	/** Defer mesh rebuild so the 3D tab can paint before heavy Clipper/Three work. */
	function queueScenePreviewRefresh(immediate: boolean) {
		cancelQueuedScenePreview();
		syncScenePreviewBusy();
		if (immediate && sceneArtIsCurrent()) {
			ensureThreeScene();
			threeResize();
			applyThreeSelectionHighlight();
			syncScenePreviewBusy();
			return;
		}
		const scheduleRun = () => {
			threePreviewRaf = requestAnimationFrame(() => {
				runScenePreviewRefresh();
			});
			syncScenePreviewBusy();
		};
		if (immediate) {
			scheduleRun();
		} else {
			threePreviewTimer = setTimeout(() => {
				threePreviewTimer = null;
				scheduleRun();
			}, THREE_PREVIEW_DEBOUNCE_MS);
		}
		syncScenePreviewBusy();
	}

	/** Debounced: swap preview plate for manifold OpenSCAD mesh (export-quality holes). */
	async function refinePlateBaseWithOpenScad() {
		if (phase !== 'threeD' || !scene || !group) return;
		if (rebuildPending) {
			rebuildAgainAfterPending = true;
			return;
		}
		rebuildPending = true;
		syncScenePreviewBusy();
		const gen = ++plateRebuildGeneration;
		try {
			const baseThicknessSafe = Math.max(0.1, baseThickness);
			const outlineWidthSafe = clampElementOutlineThicknessMm(outlineThicknessMm);
			const plateKey = plateRebuildKey(baseThicknessSafe, outlineWidthSafe);
			const existingPlate = findPlateBaseMesh();
			if (
				existingPlate?.userData.plateKey === plateKey &&
				existingPlate.userData.plateSource === 'openscad'
			) {
				return;
			}

			let refined: THREE.Mesh;
			try {
				refined = await buildPlateBaseMeshFromOpenScad(
					baseThicknessSafe,
					baseColor,
					plateSlotDims,
					plateBarParams
				);
			} catch (err) {
				console.error('Plate badge: OpenSCAD base failed', err);
				return;
			}
			if (phase !== 'threeD' || gen !== plateRebuildGeneration) {
				disposeObject3D(refined);
				return;
			}

			installPlateBaseMesh(refined, plateKey, 'openscad');
			finalizePlateBadgeGroupFrame();
			applyThreeSelectionHighlight();
		} catch (err) {
			console.error('Plate badge: refinePlateBaseWithOpenScad failed', err);
		} finally {
			rebuildPending = false;
			syncScenePreviewBusy();
			if (rebuildAgainAfterPending) {
				rebuildAgainAfterPending = false;
				void refinePlateBaseWithOpenScad();
			}
		}
	}

	$effect(() => {
		const host = threeHostEl;
		if (!host) return;
		const warm = () => {
			if (renderer) return;
			ensureThreeScene();
		};
		if (typeof requestIdleCallback !== 'undefined') {
			const id = requestIdleCallback(warm, { timeout: 1200 });
			return () => cancelIdleCallback(id);
		}
		const t = setTimeout(warm, 150);
		return () => clearTimeout(t);
	});

	$effect(() => {
		if (phase === 'threeD') return;
		void elements;
		void elements.map(
			(e) =>
				`${e.id}:${e.x.toFixed(3)}:${e.y.toFixed(3)}:${e.rotation.toFixed(4)}:${e.scaleX}:${e.scaleY}:${clampPlateElementDepthMm(e.depth)}:${e.kind === 'text' ? `${e.content}|${e.fontKey}|${e.size}` : `${(e as ShapeElement).shapeId}|${e.size}`}`
		);
		void baseThickness;
		void baseHeightMm;
		void outlineThicknessMm;
		void baseColor;
		void slotWidthMm;
		void slotHeightMm;
		void holeSpacingMm;
		void endPaddingMm;
		scheduleScenePrebuild();
		return () => cancelScenePrebuild();
	});

	$effect(() => {
		if (phase !== 'threeD') {
			threeDSessionActive = false;
			return;
		}
		void elements;
		void elements.map(
			(e) =>
				`${e.id}:${e.x.toFixed(3)}:${e.y.toFixed(3)}:${e.rotation.toFixed(4)}:${e.scaleX}:${e.scaleY}:${clampPlateElementDepthMm(e.depth)}`
		);
		void baseThickness;
		void baseHeightMm;
		void outlineThicknessMm;
		void baseColor;
		void slotWidthMm;
		void slotHeightMm;
		void holeSpacingMm;
		void endPaddingMm;

		const needsImmediate = !threeDSessionActive;
		threeDSessionActive = true;
		queueScenePreviewRefresh(needsImmediate);

		if (rebuildDebounceTimer !== null) {
			clearTimeout(rebuildDebounceTimer);
			rebuildDebounceTimer = null;
		}
		rebuildDebounceTimer = setTimeout(() => {
			rebuildDebounceTimer = null;
			syncScenePreviewBusy();
			void refinePlateBaseWithOpenScad().catch((err) =>
				console.error('Plate badge: debounced refinePlateBaseWithOpenScad failed', err)
			);
		}, 400);
		syncScenePreviewBusy();
		return () => {
			cancelQueuedScenePreview();
			if (rebuildDebounceTimer !== null) {
				clearTimeout(rebuildDebounceTimer);
				rebuildDebounceTimer = null;
			}
			syncScenePreviewBusy();
		};
	});

	$effect(() => {
		if (phase !== 'threeD') return;
		void selectedId;
		applyThreeSelectionHighlight();
	});

	function enterThreeDPhase() {
		threeDSessionActive = false;
		phase = 'threeD';
	}

	function backToLayout() {
		cancelQueuedScenePreview();
		phase = 'layout';
		if (konvaStage && canvasHostEl) {
			applyHostSize(canvasHostEl);
			syncSelectionToKonva();
			konvaGridLayer?.batchDraw();
			konvaGuideLayer?.batchDraw();
			konvaContentLayer?.batchDraw();
			konvaUiLayer?.batchDraw();
		}
		scheduleKonvaSync();
		scheduleBaseSilhouetteSync();
	}

	function applySettingsSnapshot(snap: PlateBadgeSettings) {
		const slot = normalizePlateSlotDimensions({
			widthMm: snap.slotWidthMm ?? defaultPlateSlotDimensions().widthMm,
			heightMm: snap.slotHeightMm ?? defaultPlateSlotDimensions().heightMm
		});
		const bar = normalizePlateBarParams(
			{
				holeSpacingMm: snap.holeSpacingMm,
				endPaddingMm: snap.endPaddingMm,
				baseHeightMm: snap.baseHeightMm
			},
			slot
		);
		elements = snap.elements.map((el) => {
			const c = clampElementCenterToPlate(el.x, el.y, bar, el);
			return {
				...el,
				x: c.x,
				y: c.y,
				depth: clampPlateElementDepthMm(el.depth)
			};
		});
		baseThickness = clampPlateBaseThicknessMm(snap.baseThickness ?? snap.baseDepth ?? 2);
		baseHeightMm = bar.baseHeightMm;
		outlineThicknessMm = clampElementOutlineThicknessMm(
			snap.outlineThicknessMm ?? snap.baseThickness ?? 2
		);
		baseColor = snap.baseColor;
		slotWidthMm = slot.widthMm;
		slotHeightMm = slot.heightMm;
		holeSpacingMm = bar.holeSpacingMm;
		endPaddingMm = bar.endPaddingMm;
		phase = snap.phase;
		selectedId = snap.elements[0]?.id ?? null;
		viewport = snap.viewport ?? null;
		didInitFrame = false;
		modelAabbMm = null;
		plateRebuildGeneration++;
		invalidateScenePreview();
		disposeThreeSelectionOutline();
		if (group) {
			for (const child of group.children.slice()) {
				group.remove(child);
				disposeObject3D(child);
			}
		}
	}

	function resetAllToDefaults() {
		const defaults = defaultSettings();
		try {
			localStorage.removeItem(STORAGE_KEY);
		} catch (e) {
			console.error('Plate badge: clear persisted settings failed', e);
		}
		applySettingsSnapshot(defaults);
		if (konvaStage) {
			if (viewport) {
				konvaStage.scale({ x: viewport.scale, y: viewport.scale });
				konvaStage.position({ x: viewport.x, y: viewport.y });
				stageZoomPct = Math.round((viewport.scale / INITIAL_SCALE) * 100);
			} else {
				resetView();
			}
			drawKonvaGrid();
		}
		flushKonvaSync();
		flushBaseSilhouetteSync();
	}

	function modelNameSafe(): string {
		const first = elements.find((e) => isTextElement(e)) as TextElement | undefined;
		const raw = (first?.content || 'plate-badge').split(/\r?\n/)[0] ?? 'plate-badge';
		const safe = raw
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '');
		return safe || 'plate-badge';
	}

	async function buildExportGroup(): Promise<THREE.Group> {
		const exportGroup = new THREE.Group();
		exportGroup.position.set(0, 0, 0);
		const baseThicknessSafe = Math.max(0.1, baseThickness);
		let plateMesh: THREE.Mesh;
		try {
			plateMesh = await buildPlateBaseMeshFromOpenScad(
				baseThicknessSafe,
				baseColor,
				plateSlotDims,
				plateBarParams
			);
		} catch (err) {
			console.error('Plate badge: export OpenSCAD base failed', err);
			plateMesh = buildPlateOuterMeshPreview(baseThicknessSafe, baseColor, plateBarParams);
		}
		exportGroup.add(plateMesh);

		const outlineWidthSafe = clampElementOutlineThicknessMm(outlineThicknessMm);
		const outlineParts = collectPlateOutlineMeshes(baseThicknessSafe, outlineWidthSafe);
		for (const om of outlineParts) exportGroup.add(om);

		for (let i = 0; i < elements.length; i++) {
			const el = elements[i];
			const textLayer = plateBadgeElementLayer3D(baseThicknessSafe, el.depth);
			const mesh = buildElementMesh(el, textLayer);
			if (!mesh) continue;
			alignGeometryBottomToZ0(mesh.geometry);
			mesh.position.z = textLayer.bottomZMm;
			exportGroup.add(mesh);
		}
		exportGroup.updateWorldMatrix(true, true);
		snapGroupBottomToBuildPlate(exportGroup);
		return exportGroup;
	}

	async function exportSTL() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		try {
			exportLoading = true;
			await tickThenYieldToPaint();
			const exportGroup = await buildExportGroup();
			const geometries: THREE.BufferGeometry[] = [];
			exportGroup.traverse((obj) => {
				if (obj instanceof THREE.Mesh) {
					obj.updateWorldMatrix(true, false);
					const geo = obj.geometry.clone().applyMatrix4(obj.matrixWorld);
					geometries.push(geo);
				}
			});
			if (geometries.length === 0) return;
			const merged = BufferGeometryUtils.mergeGeometries(geometries);
			geometries.forEach((g) => g.dispose());
			if (!merged) return;
			const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
			merged.dispose();
			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
			welded.dispose();
			const buffer = result instanceof DataView ? result.buffer : result;
			if (buffer && buffer.byteLength >= 84) {
				const blob = new Blob([buffer], { type: 'model/stl' });
				const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
				downloadBlob(`${modelNameSafe()}-${timestamp}.stl`, blob);
				notifyExportEvent({
					email: user?.email,
					name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
					subscriptionStatus,
					designName: 'Motorcycle Plate Bar',
					format: 'stl'
				});
			}
			onShowThankYou();
		} catch (err) {
			console.error('Plate badge: STL export failed', err);
		} finally {
			exportLoading = false;
		}
	}

	async function export3MF() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		try {
			exportLoading = true;
			await tickThenYieldToPaint();
			const exportGroup = await buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) return;
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${modelNameSafe()}-multipart-${timestamp}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Motorcycle Plate Bar',
				format: '3mf'
			});
			onShowThankYou();
		} catch (err) {
			console.error('Plate badge: 3MF export failed', err);
		} finally {
			exportLoading = false;
		}
	}

	async function openWithSlicer(slicer: OpenWithSlicerId) {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		openWithSlicerLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = await buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'plate-badge');
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Motorcycle Plate Bar',
				format: 'bambu_studio'
			});
			openInSlicer(publicUrl, slicer);
		} catch (err) {
			console.error('Plate badge: open with Bambu Studio failed', err);
		} finally {
			openWithSlicerLoading = false;
		}
	}

	function handleSnapshot() {
		if (!renderer || !scene || !camera) return;
		downloadSnapshot(renderer, scene, camera, modelNameSafe());
	}

	$effect(() => {
		const host = canvasHostEl;
		if (!host) return;
		untrack(() => initKonva(host));
	});

	onDestroy(() => {
		disposeKonva();
		cancelAnimationFrame(rafId);
		rafId = 0;
		resizeObserver?.disconnect();
		resizeObserver = null;
		detachThreePickListeners();
		disposeThreeSelectionOutline();
		if (group) {
			disposeObject3D(group);
			group.clear();
		}
		controls?.dispose();
		controls = null;
		if (renderer && threeHostEl && renderer.domElement.parentElement === threeHostEl) {
			threeHostEl.removeChild(renderer.domElement);
		}
		renderer?.dispose();
		renderer = null;
		scene = null;
		camera = null;
		group = null;
	});
</script>

<svelte:window onkeydown={onCanvasKeyDown} onkeyup={onCanvasKeyUp} />

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full max-w-[360px] min-w-[300px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Motorcycle Plate Bar</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="shrink-0 px-4 pb-3">
				<div class="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
					<button
						type="button"
						class="rounded-lg px-3 py-1.5 text-xs font-semibold transition {phase === 'layout'
							? 'bg-white text-indigo-600 shadow-sm'
							: 'text-slate-600 hover:text-slate-900'}"
						onclick={backToLayout}
					>
						1. Layout
					</button>
					<button
						type="button"
						class="rounded-lg px-3 py-1.5 text-xs font-semibold transition {phase === 'threeD'
							? 'bg-white text-indigo-600 shadow-sm'
							: 'text-slate-600 hover:text-slate-900'}"
						onclick={enterThreeDPhase}
					>
						2. 3D
					</button>
				</div>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4 pt-0">
				{#if phase === 'layout'}
					<div class="grid grid-cols-2 gap-2">
						<Button variant="outline" size="sm" onclick={addText}>+ Text</Button>
						<Popover.Root bind:open={shapePickerOpen}>
							<Popover.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="outline" size="sm">+ Shape</Button>
								{/snippet}
							</Popover.Trigger>
							<Popover.Content
								class="max-h-[min(70vh,28rem)] w-[min(100vw-2rem,22rem)] overflow-hidden overscroll-contain p-3 sm:w-96"
								align="start"
							>
								<div class="flex h-full max-h-[calc(min(70vh,28rem)-3rem)] flex-1 flex-col overflow-y-auto p-2">
									{#each shapeCategories as cat (cat)}
										<div class="mb-4">
											<p
												class="mb-2 text-[10px] font-semibold tracking-wider text-slate-500 uppercase"
											>
												{cat}
											</p>
											<div class="grid grid-cols-5 gap-2">
												{#each remoteShapesStore.shapes.filter((s) => s.category === cat) as def (def.id)}
													<button
														type="button"
														title={def.label}
														class="flex aspect-square min-h-10 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white p-2 text-slate-700 transition hover:border-indigo-400 hover:text-indigo-600 focus:ring-2 focus:ring-indigo-500/30 focus:outline-none"
														onclick={() => addShape(def.id)}
													>
														<div
															class="grid size-full place-items-center [&_svg]:block [&_svg]:size-8 [&_svg]:max-w-full"
														>
															<!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted catalog SVG -->
															{@html def.rawSvg}
														</div>
													</button>
												{/each}
											</div>
										</div>
									{/each}
								</div>
							</Popover.Content>
						</Popover.Root>
					</div>

					<div class="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
						<div class="mb-2 text-xs font-semibold tracking-tight text-slate-700">
							Layers ({elements.length})
						</div>
						{#if elements.length === 0}
							<p class="text-xs text-slate-500">No elements. Add text or a shape.</p>
						{:else}
							<ul class="space-y-1.5">
								{#each [...elements].reverse() as el (el.id)}
									{@const isSel = el.id === selectedId}
									<li
										class="flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition {isSel
											? 'border-indigo-300 bg-indigo-50/70'
											: 'border-slate-200 bg-white hover:border-slate-300'}"
									>
										<button
											type="button"
											class="flex-1 truncate text-left text-slate-800"
											onclick={() => setSelected(el.id)}
											title={elementLabel(el)}
										>
											<span
												class="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle"
												style="background-color: {el.color}"
											></span>
											{elementLabel(el)}
										</button>
										<button
											type="button"
											class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
											title="Move up"
											onclick={() => moveElement(el.id, 1)}
											aria-label="Move up"
										>
											<svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"
												><path d="M10 4 l5 6 H5 z" /></svg
											>
										</button>
										<button
											type="button"
											class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
											title="Move down"
											onclick={() => moveElement(el.id, -1)}
											aria-label="Move down"
										>
											<svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"
												><path d="M10 16 l5 -6 H5 z" /></svg
											>
										</button>
										<button
											type="button"
											class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
											title="Duplicate"
											onclick={() => duplicateElement(el.id)}
											aria-label="Duplicate"
										>
											<svg
												class="h-3.5 w-3.5"
												viewBox="0 0 20 20"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												><rect x="6" y="6" width="10" height="10" rx="2" /><path
													d="M14 4H6a2 2 0 00-2 2v8"
												/></svg
											>
										</button>
										<button
											type="button"
											class="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
											title="Delete"
											onclick={() => removeElement(el.id)}
											aria-label="Delete"
										>
											<svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"
												><path
													d="M5 5l10 10M15 5L5 15"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
												/></svg
											>
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>

					{#if selectedElement}
						<div class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
							<div class="text-xs font-semibold tracking-tight text-slate-700">Properties</div>
							{#if isTextElement(selectedElement)}
								{@const tel = selectedElement}
								<label class="grid gap-1.5">
									<span class="text-xs font-medium text-slate-700">Text</span>
									<textarea
										class="min-h-[4.5rem] w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-snug text-slate-900 shadow-sm ring-indigo-500/25 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2"
										rows={3}
										value={tel.content}
										oninput={(e) =>
											updateElement(tel.id, {
												content: (e.currentTarget as HTMLTextAreaElement).value
											})}
									></textarea>
									<p class="text-[11px] leading-snug text-slate-500">
										Press Enter for a new line.
									</p>
								</label>
								<label class="grid gap-1.5">
									<span class="text-xs font-medium text-slate-700">Font</span>
									<FontSelect
										value={tel.fontKey}
										onValueChange={(v) => updateElement(tel.id, { fontKey: v })}
									/>
								</label>
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Size (mm)</span>
										<span class="text-xs text-slate-600 tabular-nums">{tel.size.toFixed(0)}</span>
									</div>
									<Slider
										type="single"
										value={tel.size}
										onValueChange={(v: number) => updateElement(tel.id, { size: v })}
										min={4}
										max={36}
										step={0.5}
										class="w-full"
									/>
								</label>
							{:else}
								{@const sel = selectedElement as ShapeElement}
								<div class="text-xs text-slate-700">
									<span class="font-medium">Shape:</span>
									{elementLabel(sel)}
								</div>
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Size (mm)</span>
										<span class="text-xs text-slate-600 tabular-nums">{sel.size.toFixed(0)}</span>
									</div>
									<Slider
										type="single"
										value={sel.size}
										onValueChange={(v: number) => updateElement(sel.id, { size: v })}
										min={4}
										max={100}
										step={0.5}
										class="w-full"
									/>
								</label>
							{/if}

							<ColorPalettePicker
								value={selectedElement.color}
								onValueChange={(v: string) => updateElement(selectedElement.id, { color: v })}
								{palette}
								label="Color"
							/>

							<div class="grid grid-cols-2 gap-3">
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Pos X</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{selectedElement.x.toFixed(1)}</span
										>
									</div>
									<Slider
										type="single"
										value={selectedElement.x}
										onValueChange={(v: number) => updateElement(selectedElement.id, { x: v })}
										min={selectedPosLimits.xMin}
										max={selectedPosLimits.xMax}
										step={0.5}
										class="w-full"
									/>
								</label>
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Pos Y</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{selectedElement.y.toFixed(1)}</span
										>
									</div>
									<Slider
										type="single"
										value={selectedElement.y}
										onValueChange={(v: number) => updateElement(selectedElement.id, { y: v })}
										min={selectedPosLimits.yMin}
										max={selectedPosLimits.yMax}
										step={0.5}
										class="w-full"
									/>
								</label>
							</div>

							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Rotation (deg)</span>
									<span class="text-xs text-slate-600 tabular-nums"
										>{((selectedElement.rotation * 180) / Math.PI).toFixed(0)}</span
									>
								</div>
								<Slider
									type="single"
									value={(selectedElement.rotation * 180) / Math.PI}
									onValueChange={(v: number) =>
										updateElement(selectedElement.id, { rotation: (v * Math.PI) / 180 })}
									min={-180}
									max={180}
									step={1}
									class="w-full"
								/>
							</label>

							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Text depth (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums"
										>{clampPlateElementDepthMm(selectedElement.depth).toFixed(2)}</span
									>
								</div>
								<Slider
									type="single"
									value={clampPlateElementDepthMm(selectedElement.depth)}
									onValueChange={(v: number) =>
										updateElement(selectedElement.id, {
											depth: clampPlateElementDepthMm(v)
										})}
									min={PLATE_ELEMENT_DEPTH_MIN_MM}
									max={8}
									step={0.1}
									class="w-full"
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									Extrusion height above the base in 3D / export.
								</p>
							</label>

							<div class="grid grid-cols-2 gap-2">
								<Button
									variant="outline"
									size="sm"
									onclick={() => flipElement(selectedElement.id, 'x')}
								>
									Flip H
								</Button>
								<Button
									variant="outline"
									size="sm"
									onclick={() => flipElement(selectedElement.id, 'y')}
								>
									Flip V
								</Button>
							</div>
						</div>
					{/if}

					<div class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Base plate</div>
						<p class="text-[11px] leading-snug text-slate-500">
							Stack (bottom → top): base + outline frame, then letter fill on top.
						</p>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Base height (mm)</span>
								<span class="text-xs text-slate-600 tabular-nums">{baseHeightMm.toFixed(1)}</span>
							</div>
							<Slider
								type="single"
								value={baseHeightMm}
								onValueChange={(v: number) =>
									(baseHeightMm = clampPlateBaseHeightMm(v))}
								min={PLATE_BASE_HEIGHT_MIN_MM}
								max={PLATE_BASE_HEIGHT_MAX_MM}
								step={0.5}
								class="w-full"
							/>
							<p class="text-[11px] leading-snug text-slate-500">
								Across the bar — default {defaultPlateBarParams().baseHeightMm} mm.
							</p>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Base thickness (mm)</span>
								<span class="text-xs text-slate-600 tabular-nums">{baseThickness.toFixed(1)}</span>
							</div>
							<Slider
								type="single"
								value={baseThickness}
								onValueChange={(v: number) =>
									(baseThickness = clampPlateBaseThicknessMm(v))}
								min={PLATE_BASE_THICKNESS_MIN_MM}
								max={PLATE_BASE_THICKNESS_MAX_MM}
								step={0.2}
								class="w-full"
							/>
							<p class="text-[11px] leading-snug text-slate-500">
								Extrusion depth of the base + outline stack (Z).
							</p>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Outline thickness (mm)</span>
								<span class="text-xs text-slate-600 tabular-nums"
									>{outlineThicknessMm.toFixed(2)}</span
								>
							</div>
							<Slider
								type="single"
								value={outlineThicknessMm}
								onValueChange={(v: number) =>
									(outlineThicknessMm = clampElementOutlineThicknessMm(v))}
								min={ELEMENT_OUTLINE_THICKNESS_MIN_MM}
								max={ELEMENT_OUTLINE_THICKNESS_MAX_MM}
								step={0.1}
								class="w-full"
							/>
							<p class="text-[11px] leading-snug text-slate-500">
								Plan width of the base-colored frame around every letter (always on).
							</p>
						</label>
						<div class="space-y-2 border-t border-slate-200 pt-3">
							<span class="text-xs font-medium text-slate-700">Mounting holes</span>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Hole width (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums">{slotWidthMm.toFixed(1)}</span>
								</div>
								<Slider
									type="single"
									value={slotWidthMm}
									onValueChange={(v: number) => (slotWidthMm = clampPlateSlotWidthMm(v))}
									min={PLATE_SLOT_WIDTH_MIN_MM}
									max={PLATE_SLOT_WIDTH_MAX_MM}
									step={0.5}
									class="w-full"
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									Along the bar — default {defaultPlateSlotDimensions().widthMm} mm.
								</p>
							</label>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Hole height (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums">{slotHeightMm.toFixed(1)}</span>
								</div>
								<Slider
									type="single"
									value={slotHeightMm}
									onValueChange={(v: number) => (slotHeightMm = clampPlateSlotHeightMm(v))}
									min={PLATE_SLOT_HEIGHT_MIN_MM}
									max={PLATE_SLOT_HEIGHT_MAX_MM}
									step={0.5}
									class="w-full"
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									Across the bar — default {defaultPlateSlotDimensions().heightMm} mm.
								</p>
							</label>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Hole distance (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums">{holeSpacingMm.toFixed(1)}</span>
								</div>
								<Slider
									type="single"
									value={holeSpacingMm}
									onValueChange={(v: number) =>
										(holeSpacingMm = clampPlateHoleSpacingMm(v, endPaddingMm, slotWidthMm))}
									min={Math.max(PLATE_HOLE_SPACING_MIN_MM, slotWidthMm + 8)}
									max={maxHoleSpacingMm}
									step={0.5}
									class="w-full"
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									Center-to-center — default {PLATE_HOLE_SPACING_DEFAULT_MM} mm.
								</p>
							</label>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Left/right padding (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums">{endPaddingMm.toFixed(1)}</span>
								</div>
								<Slider
									type="single"
									value={endPaddingMm}
									onValueChange={(v: number) =>
										(endPaddingMm = clampPlateEndPaddingMm(v, holeSpacingMm, slotWidthMm))}
									min={PLATE_END_PADDING_MIN_MM}
									max={maxEndPaddingMm}
									step={0.5}
									class="w-full"
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									From each bar end to the outer edge of a mounting slot — default{' '}
									{PLATE_END_PADDING_DEFAULT_MM} mm.
								</p>
							</label>
							<p class="text-[11px] leading-snug text-slate-500">
								Base length (auto): <span class="font-medium tabular-nums text-slate-600"
									>{computedBaseLengthMm.toFixed(1)} mm</span
								>
							</p>
						</div>
						<ColorPalettePicker
							value={baseColor}
							onValueChange={(v: string) => (baseColor = v)}
							{palette}
							label="Base color"
						/>
					</div>
				{:else}
					<div class="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
						<div class="mb-2 text-xs font-semibold tracking-tight text-slate-700">
							Layers ({elements.length})
						</div>
						{#if elements.length === 0}
							<p class="text-xs text-slate-500">No raised elements — exporting the base plate only.</p>
						{:else}
							<ul class="space-y-1.5">
								{#each [...elements].reverse() as el (el.id)}
									{@const isSel = el.id === selectedId}
									<li
										class="flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition {isSel
											? 'border-indigo-300 bg-indigo-50/70'
											: 'border-slate-200 bg-white hover:border-slate-300'}"
									>
										<button
											type="button"
											class="flex-1 truncate text-left text-slate-800"
											onclick={() => setSelected(el.id)}
											title={elementLabel(el)}
										>
											<span
												class="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle"
												style="background-color: {el.color}"
											></span>
											{elementLabel(el)}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
						{#if selectedElement}
							<div class="mt-3 space-y-3 border-t border-slate-200 pt-3">
								<ColorPalettePicker
									value={selectedElement.color}
									onValueChange={(v: string) => updateElement(selectedElement.id, { color: v })}
									{palette}
									label="Element color"
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									Base-colored outline ({outlineThicknessMm.toFixed(2)} mm wide, {baseThickness.toFixed(
										1
									)} mm thick) is always added for this layer.
								</p>
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Text depth (mm)</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{clampPlateElementDepthMm(selectedElement.depth).toFixed(2)}</span
										>
									</div>
									<Slider
										type="single"
										value={clampPlateElementDepthMm(selectedElement.depth)}
										onValueChange={(v: number) =>
											updateElement(selectedElement.id, {
												depth: clampPlateElementDepthMm(v)
											})}
										min={PLATE_ELEMENT_DEPTH_MIN_MM}
										max={8}
										step={0.1}
										class="w-full"
									/>
								</label>
							</div>
						{/if}
					</div>

					<div class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Base plate</div>
						<p class="text-[11px] leading-snug text-slate-500">
							Stack (bottom → top): base + outline frame, then letter fill on top.
						</p>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Base height (mm)</span>
								<span class="text-xs text-slate-600 tabular-nums">{baseHeightMm.toFixed(1)}</span>
							</div>
							<Slider
								type="single"
								value={baseHeightMm}
								onValueChange={(v: number) =>
									(baseHeightMm = clampPlateBaseHeightMm(v))}
								min={PLATE_BASE_HEIGHT_MIN_MM}
								max={PLATE_BASE_HEIGHT_MAX_MM}
								step={0.5}
								class="w-full"
							/>
							<p class="text-[11px] leading-snug text-slate-500">
								Across the bar — default {defaultPlateBarParams().baseHeightMm} mm.
							</p>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Base thickness (mm)</span>
								<span class="text-xs text-slate-600 tabular-nums">{baseThickness.toFixed(1)}</span>
							</div>
							<Slider
								type="single"
								value={baseThickness}
								onValueChange={(v: number) =>
									(baseThickness = clampPlateBaseThicknessMm(v))}
								min={PLATE_BASE_THICKNESS_MIN_MM}
								max={PLATE_BASE_THICKNESS_MAX_MM}
								step={0.2}
								class="w-full"
							/>
							<p class="text-[11px] leading-snug text-slate-500">
								Extrusion depth of the base + outline stack (Z).
							</p>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Outline thickness (mm)</span>
								<span class="text-xs text-slate-600 tabular-nums"
									>{outlineThicknessMm.toFixed(2)}</span
								>
							</div>
							<Slider
								type="single"
								value={outlineThicknessMm}
								onValueChange={(v: number) =>
									(outlineThicknessMm = clampElementOutlineThicknessMm(v))}
								min={ELEMENT_OUTLINE_THICKNESS_MIN_MM}
								max={ELEMENT_OUTLINE_THICKNESS_MAX_MM}
								step={0.1}
								class="w-full"
							/>
							<p class="text-[11px] leading-snug text-slate-500">
								Plan width of the base-colored frame around every letter (always on).
							</p>
						</label>
						<div class="space-y-2 border-t border-slate-200 pt-3">
							<span class="text-xs font-medium text-slate-700">Mounting holes</span>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Hole width (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums">{slotWidthMm.toFixed(1)}</span>
								</div>
								<Slider
									type="single"
									value={slotWidthMm}
									onValueChange={(v: number) => (slotWidthMm = clampPlateSlotWidthMm(v))}
									min={PLATE_SLOT_WIDTH_MIN_MM}
									max={PLATE_SLOT_WIDTH_MAX_MM}
									step={0.5}
									class="w-full"
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									Along the bar — default {defaultPlateSlotDimensions().widthMm} mm.
								</p>
							</label>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Hole height (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums">{slotHeightMm.toFixed(1)}</span>
								</div>
								<Slider
									type="single"
									value={slotHeightMm}
									onValueChange={(v: number) => (slotHeightMm = clampPlateSlotHeightMm(v))}
									min={PLATE_SLOT_HEIGHT_MIN_MM}
									max={PLATE_SLOT_HEIGHT_MAX_MM}
									step={0.5}
									class="w-full"
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									Across the bar — default {defaultPlateSlotDimensions().heightMm} mm.
								</p>
							</label>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Hole spacing (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums">{holeSpacingMm.toFixed(1)}</span>
								</div>
								<Slider
									type="single"
									value={holeSpacingMm}
									onValueChange={(v: number) =>
										(holeSpacingMm = clampPlateHoleSpacingMm(v, endPaddingMm, slotWidthMm))}
									min={Math.max(PLATE_HOLE_SPACING_MIN_MM, slotWidthMm + 8)}
									max={maxHoleSpacingMm}
									step={0.5}
									class="w-full"
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									Center-to-center — default {PLATE_HOLE_SPACING_DEFAULT_MM} mm.
								</p>
							</label>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Left/right padding (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums">{endPaddingMm.toFixed(1)}</span>
								</div>
								<Slider
									type="single"
									value={endPaddingMm}
									onValueChange={(v: number) =>
										(endPaddingMm = clampPlateEndPaddingMm(v, holeSpacingMm, slotWidthMm))}
									min={PLATE_END_PADDING_MIN_MM}
									max={maxEndPaddingMm}
									step={0.5}
									class="w-full"
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									From each bar end to the outer edge of a mounting slot — default{' '}
									{PLATE_END_PADDING_DEFAULT_MM} mm.
								</p>
							</label>
							<p class="text-[11px] leading-snug text-slate-500">
								Base length (auto): <span class="font-medium tabular-nums text-slate-600"
									>{computedBaseLengthMm.toFixed(1)} mm</span
								>
							</p>
						</div>
						<ColorPalettePicker
							value={baseColor}
							onValueChange={(v: string) => (baseColor = v)}
							{palette}
							label="Base color"
						/>
					</div>

					{#if elements.length > 0}
						<div class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
							<div class="text-xs font-semibold tracking-tight text-slate-700">
								Per-element 3D (mm)
							</div>
							<ul class="space-y-2">
								{#each [...elements].reverse() as el (el.id)}
									<li class="rounded-lg border border-slate-200 bg-white p-2">
										<div
											class="mb-1 flex items-center gap-2 text-[11px] font-medium text-slate-700"
										>
											<span
												class="inline-block h-2.5 w-2.5 rounded-sm"
												style="background-color: {el.color}"
											></span>
											<span class="flex-1 truncate" title={elementLabel(el)}>{elementLabel(el)}</span>
										</div>
										<div class="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
											Text depth
										</div>
										<div class="mb-1 flex items-center justify-between gap-2 text-[11px] text-slate-600">
											<span class="tabular-nums"
												>{clampPlateElementDepthMm(el.depth).toFixed(2)} mm</span
											>
										</div>
										<Slider
											type="single"
											value={clampPlateElementDepthMm(el.depth)}
											onValueChange={(v: number) =>
												updateElement(el.id, { depth: clampPlateElementDepthMm(v) })}
											min={PLATE_ELEMENT_DEPTH_MIN_MM}
											max={8}
											step={0.1}
											class="w-full"
										/>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					<Button variant="outline" class="w-full" onclick={backToLayout}>← Back to layout</Button>
				{/if}
			</div>

			<div class="shrink-0 border-t border-slate-200 p-4">
				<Button variant="outline" size="sm" class="w-full" onclick={resetAllToDefaults}>
					Reset to defaults
				</Button>
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			{#if (phase === 'layout' && layoutPreviewVisible) || (phase === 'threeD' && scenePreviewVisible)}
				<div
					class="pointer-events-none absolute top-3 left-3 z-10 flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/85 px-2.5 py-1 text-[10px] font-medium text-slate-500 shadow-sm backdrop-blur-sm"
					aria-live="polite"
					aria-busy="true"
				>
					<span
						class="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-slate-300 border-t-slate-500"
						aria-hidden="true"
					></span>
					{phase === 'layout' ? 'Updating layout…' : 'Updating preview…'}
				</div>
			{/if}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				bind:this={canvasHostEl}
				class="absolute inset-0 touch-none bg-slate-100 {phase === 'layout'
					? ''
					: 'pointer-events-none invisible'}"
				oncontextmenu={(e) => e.preventDefault()}
			></div>
			<div
				bind:this={threeHostEl}
				class="absolute inset-0 {phase === 'threeD' ? '' : 'pointer-events-none invisible'}"
			></div>
			{#if phase === 'layout'}
				<div
					class="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-full border border-slate-200 bg-white/95 px-1 py-1 text-xs shadow"
				>
					<button
						type="button"
						class="grid h-7 w-7 place-items-center rounded-full text-slate-600 hover:bg-slate-100"
						onclick={() => zoomBy(1 / 1.2)}
						aria-label="Zoom out"
						title="Zoom out"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
							><path d="M5 12h14" stroke-width="2" stroke-linecap="round" /></svg
						>
					</button>
					<button
						type="button"
						class="min-w-13 rounded-full px-2 py-1 text-center font-semibold text-slate-700 hover:bg-slate-100"
						onclick={resetView}
						title="Reset view"
					>
						{stageZoomPct}%
					</button>
					<button
						type="button"
						class="grid h-7 w-7 place-items-center rounded-full text-slate-600 hover:bg-slate-100"
						onclick={() => zoomBy(1.2)}
						aria-label="Zoom in"
						title="Zoom in"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
							><path d="M12 5v14M5 12h14" stroke-width="2" stroke-linecap="round" /></svg
						>
					</button>
				</div>
				<div
					class="pointer-events-none absolute bottom-3 left-3 max-w-[min(100%,20rem)] rounded-full bg-white/90 px-3 py-1 text-[10px] font-medium leading-snug text-slate-600 shadow"
				>
					Base and art both start at mesh Z = 0 (Bow Keychain style). Pan empty space / hold space ·
					scroll zoom
				</div>
			{:else}
				<DesignerModelDimensionsHud sizes={modelAabbMm} />
				<div
					class="pointer-events-none absolute bottom-3 left-3 z-10 max-w-[min(100%,18rem)] rounded-full bg-white/90 px-3 py-1.5 text-[10px] font-medium leading-snug text-slate-600 shadow"
				>
					Base + art share Z = 0; whole group snapped to build plate. Tap to select — color in sidebar
				</div>
				<div class="absolute right-4 bottom-4">
					<DesignerExportToolbar
						onSnapshot={handleSnapshot}
						onExport={exportSTL}
						onExport3MF={export3MF}
						onOpenWithSlicer={openWithSlicer}
						{openWithSlicerLoading}
						{exportLoading}
						exportDisabled={false}
						exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF')}
						showLockIcon={showExportLockIcon(user, subscriptionStatus)}
					/>
				</div>
			{/if}
		</section>
	</div>
</main>
