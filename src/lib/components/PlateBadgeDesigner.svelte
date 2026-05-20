<script lang="ts">
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
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import type { PaletteColor } from '$lib/colorPalette';
	import {
		CLIPPER_SCALE,
		clampElementOutlineThicknessMm,
		ELEMENT_OUTLINE_THICKNESS_MAX_MM,
		ELEMENT_OUTLINE_THICKNESS_MIN_MM,
		elementLabel,
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
		clampPlateElementDepthMm,
		clampPlateTextCapDepthMm,
		maxPlateTextCapDepthMm,
		PLATE_ELEMENT_DEPTH_MIN_MM,
		PLATE_SPEC,
		PLATE_TEXT_CAP_DEPTH_MIN_MM,
		plateBadgeTextLayer3D,
		plateOuterKonvaPathD,
		plateSlotKonvaPathD,
		subtractPlateMountingSlotsFromPolyTree,
		type PlateBadgeTextEmbedMode
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
		baseDepth: number;
		/** Plan-view width of the base-colored frame around each glyph (mm). */
		outlineThicknessMm?: number;
		baseColor: string;
		/** `full` = text fill through base depth; `cap` = thin top layer for multi-color. */
		textEmbedMode?: PlateBadgeTextEmbedMode;
		textCapDepthMm?: number;
		scale: number;
		phase: 'layout' | 'threeD';
		viewport?: CanvasStudioViewport;
	}

	function parseTextEmbedMode(v: unknown): PlateBadgeTextEmbedMode {
		return v === 'cap' ? 'cap' : 'full';
	}

	function defaultSettings(): PlateBadgeSettings {
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
			baseDepth: 2,
			outlineThicknessMm: 2,
			baseColor: '#1e293b',
			textEmbedMode: 'full',
			textCapDepthMm: 0.4,
			scale: 1,
			phase: 'layout'
		};
	}

	function loadSettings(): PlateBadgeSettings {
		const fallback = defaultSettings();
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return fallback;
			const parsed = JSON.parse(raw) as Partial<PlateBadgeSettings>;
			const rawList = Array.isArray(parsed.elements) ? parsed.elements : [];
			const elements: CanvasElement[] = rawList
				.filter((e): e is CanvasElement => !!e && typeof e === 'object' && 'kind' in (e as object))
				.map((el) => {
					const e = el as CanvasElement;
					const c = clampElementCenterToPlate(numOr(e.x, 0), numOr(e.y, 0));
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
				baseDepth: numOr(parsed.baseDepth, fallback.baseDepth),
				outlineThicknessMm: clampElementOutlineThicknessMm(
					numOr(
						parsed.outlineThicknessMm,
						numOr(parsed.baseDepth, fallback.outlineThicknessMm ?? fallback.baseDepth)
					)
				),
				baseColor: strOr(parsed.baseColor, fallback.baseColor),
				textEmbedMode: parseTextEmbedMode(parsed.textEmbedMode ?? fallback.textEmbedMode),
				textCapDepthMm: clampPlateTextCapDepthMm(
					numOr(parsed.textCapDepthMm, fallback.textCapDepthMm ?? 0.4),
					numOr(parsed.baseDepth, fallback.baseDepth)
				),
				scale: numOr(parsed.scale, fallback.scale),
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
	let baseDepth = $state(initial.baseDepth);
	let outlineThicknessMm = $state(
		clampElementOutlineThicknessMm(initial.outlineThicknessMm ?? initial.baseDepth)
	);
	let baseColor = $state(initial.baseColor);
	let textEmbedMode = $state<PlateBadgeTextEmbedMode>(initial.textEmbedMode ?? 'full');
	let textCapDepthMm = $state(initial.textCapDepthMm ?? 0.4);
	let overallScale = $state(initial.scale);

	$effect(() => {
		textCapDepthMm = clampPlateTextCapDepthMm(textCapDepthMm, baseDepth);
	});
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
		const snap: PlateBadgeSettings = {
			elements,
			baseDepth,
			outlineThicknessMm: clampElementOutlineThicknessMm(outlineThicknessMm),
			baseColor,
			textEmbedMode,
			textCapDepthMm: clampPlateTextCapDepthMm(textCapDepthMm, baseDepth),
			scale: overallScale,
			phase,
			viewport: viewport ?? undefined
		};
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
		} catch (e) {
			console.error('Plate badge: persist failed', e);
		}
	});

	const selectedElement = $derived(elements.find((e) => e.id === selectedId) ?? null);
	const textCapDepthMaxMm = $derived(maxPlateTextCapDepthMm(baseDepth));
	const textLayerSummary = $derived.by(() => {
		if (textEmbedMode === 'cap') {
			const layer = plateBadgeTextLayer3D(baseDepth, 'cap', textCapDepthMm, 3);
			return `Text cap ${layer.extrudeDepthMm.toFixed(2)} mm on top of base (${baseDepth.toFixed(1)} mm)`;
		}
		return `Text sits on top of base — depth per layer below`;
	});

	function setSelected(id: string | null) {
		selectedId = id;
		syncSelectionToKonva();
	}

	function pushElementsToKonva() {
		syncElementsToKonva();
		syncSelectionToKonva();
	}

	function addText() {
		const { x: cx, y: cy } = artboardMmAtCanvasCenter();
		const c = clampElementCenterToPlate(cx, cy);
		const el: TextElement = {
			id: makeId(),
			kind: 'text',
			content: 'Text',
			fontKey: FONT_OPTIONS[0]?.key ?? 'Titan One_Regular',
			size: 12,
			x: c.x,
			y: c.y,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			color: '#f8fafc',
			depth: 3
		};
		elements = [...elements, el];
		selectedId = el.id;
		shapePickerOpen = false;
		pushElementsToKonva();
	}

	function addShape(shapeId: string) {
		const def = getShape(shapeId);
		if (!def) return;
		const { x: cx, y: cy } = artboardMmAtCanvasCenter();
		const c = clampElementCenterToPlate(cx, cy);
		const el: ShapeElement = {
			id: makeId(),
			kind: 'shape',
			shapeId,
			size: 18,
			x: c.x,
			y: c.y,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			color: '#f472b6',
			depth: 3
		};
		elements = [...elements, el];
		selectedId = el.id;
		shapePickerOpen = false;
		pushElementsToKonva();
	}

	function updateElement(id: string, patch: Partial<CanvasElement>) {
		elements = elements.map((el) => {
			if (el.id !== id) return el;
			const merged = { ...el, ...patch } as CanvasElement;
			if ('x' in patch || 'y' in patch) {
				const c = clampElementCenterToPlate(merged.x, merged.y);
				return { ...merged, x: c.x, y: c.y };
			}
			return merged;
		});
		syncElementsToKonva();
	}

	function removeElement(id: string) {
		elements = elements.filter((el) => el.id !== id);
		if (selectedId === id) selectedId = elements[elements.length - 1]?.id ?? null;
		pushElementsToKonva();
	}

	function duplicateElement(id: string) {
		const idx = elements.findIndex((e) => e.id === id);
		if (idx < 0) return;
		const source = elements[idx];
		const copy = { ...source, id: makeId(), x: source.x + 4, y: source.y - 4 } as CanvasElement;
		const c = clampElementCenterToPlate(copy.x, copy.y);
		const placed = { ...copy, x: c.x, y: c.y };
		const next = [...elements];
		next.splice(idx + 1, 0, placed);
		elements = next;
		selectedId = placed.id;
		pushElementsToKonva();
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
		pushElementsToKonva();
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

		konvaGuideLayer.add(
			new Konva.Path({
				data: plateOuterKonvaPathD(),
				fill: 'rgba(14, 165, 233, 0.07)',
				stroke: '#0ea5e9',
				strokeWidth: 1.1,
				strokeScaleEnabled: false,
				listening: false,
				perfectDrawEnabled: false
			})
		);
		konvaGuideLayer.add(
			new Konva.Path({
				data: plateSlotKonvaPathD(-1),
				fill: 'rgba(255,255,255,0.2)',
				stroke: '#0369a1',
				strokeWidth: 0.85,
				strokeScaleEnabled: false,
				listening: false
			})
		);
		konvaGuideLayer.add(
			new Konva.Path({
				data: plateSlotKonvaPathD(1),
				fill: 'rgba(255,255,255,0.2)',
				stroke: '#0369a1',
				strokeWidth: 0.85,
				strokeScaleEnabled: false,
				listening: false
			})
		);
		const dz = PLATE_SPEC.designZone;
		const yTop = -dz.maxY;
		const yBot = -dz.minY;
		konvaGuideLayer.add(
			new Konva.Line({
				points: [dz.minX, yTop, dz.maxX, yTop, dz.maxX, yBot, dz.minX, yBot, dz.minX, yTop],
				stroke: '#64748b',
				strokeWidth: 0.65,
				dash: [5, 4],
				strokeScaleEnabled: false,
				listening: false,
				closed: false
			})
		);
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
			const c = clampElementCenterToPlate(node.x(), -node.y());
			updateElement(el.id, { x: c.x, y: c.y });
			node.x(c.x);
			node.y(-c.y);
		});
		node.on('transformend', () => {
			const u = elementUpdatesFromKonva(node);
			const c = clampElementCenterToPlate(u.x ?? node.x(), u.y ?? -node.y());
			updateElement(el.id, { ...u, x: c.x, y: c.y });
			node.x(c.x);
			node.y(-c.y);
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
			}
		}
		for (const el of elements) {
			let node = pathNodes.get(el.id);
			if (!node) {
				node = createPathNode(el);
				konvaContentLayer.add(node);
				pathNodes.set(el.id, node);
			} else {
				const expectedD = elementToPathD(el);
				if (node.data() !== expectedD) node.data(expectedD);
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
		const paths = getLocalPathsForElement(el);
		if (paths.length === 0) return '';
		const parts: string[] = [];
		for (const path of paths) {
			if (path.length < 3) continue;
			const head = path[0];
			parts.push(
				`M ${(head.X / CLIPPER_SCALE).toFixed(3)} ${(-head.Y / CLIPPER_SCALE).toFixed(3)}`
			);
			for (let i = 1; i < path.length; i++) {
				const p = path[i];
				parts.push(`L ${(p.X / CLIPPER_SCALE).toFixed(3)} ${(-p.Y / CLIPPER_SCALE).toFixed(3)}`);
			}
			parts.push('Z');
		}
		return parts.join(' ');
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
	/** Bumps on each 3D rebuild so stale OpenSCAD results are discarded. */
	let plateRebuildGeneration = 0;
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);
	let openBambuStudioLoading = $state(false);
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
		keyLight.shadow.mapSize.width = 4096;
		keyLight.shadow.mapSize.height = 4096;
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
		baseDepthMm: number,
		outlineWidthMm: number,
		plateBaseColor: string
	): THREE.Mesh | null {
		const planW = Math.max(0.1, outlineWidthMm);
		const rimH = Math.max(0.1, baseDepthMm);
		const outlineTree = subtractPlateMountingSlotsFromPolyTree(
			getElementOutlinePolyTree(el, planW)
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

	function collectPlateOutlineMeshes(baseDepthSafe: number, outlineWidthSafe: number): THREE.Mesh[] {
		const outlineParts: THREE.Mesh[] = [];
		for (let i = 0; i < elements.length; i++) {
			const el = elements[i];
			try {
				const outlineMesh = buildElementOutlineMesh(
					el,
					baseDepthSafe,
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

	function buildPlateBadgeArtMeshes(baseDepthSafe: number, outlineWidthSafe: number): THREE.Object3D[] {
		const art: THREE.Object3D[] = [];
		const outlineParts = collectPlateOutlineMeshes(baseDepthSafe, outlineWidthSafe);
		for (const om of outlineParts) {
			om.castShadow = true;
			om.receiveShadow = true;
			art.push(om);
		}
		for (let i = 0; i < elements.length; i++) {
			const el = elements[i];
			const textLayer = plateBadgeTextLayer3D(
				baseDepthSafe,
				textEmbedMode,
				textCapDepthMm,
				el.depth
			);
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
		group.scale.set(overallScale, overallScale, 1);
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
	function refreshPlateBadgeScene() {
		if (phase !== 'threeD' || !group) return;
		const baseDepthSafe = Math.max(0.1, baseDepth);
		const outlineWidthSafe = clampElementOutlineThicknessMm(outlineThicknessMm);
		const plateKey = `${baseDepthSafe.toFixed(2)}:${outlineWidthSafe.toFixed(2)}:${baseColor}`;
		const existingPlate = findPlateBaseMesh();

		if (!existingPlate || existingPlate.userData.plateKey !== plateKey) {
			installPlateBaseMesh(
				buildPlateBaseMeshPreview(baseDepthSafe, baseColor),
				plateKey,
				'preview'
			);
		}

		disposeThreeSelectionOutline();
		swapPlateBadgeArtMeshes(buildPlateBadgeArtMeshes(baseDepthSafe, outlineWidthSafe));
		finalizePlateBadgeGroupFrame();
		applyThreeSelectionHighlight();
	}

	/** Debounced: swap preview plate for manifold OpenSCAD mesh (export-quality holes). */
	async function refinePlateBaseWithOpenScad() {
		if (phase !== 'threeD' || !scene || !group) return;
		if (rebuildPending) {
			rebuildAgainAfterPending = true;
			return;
		}
		rebuildPending = true;
		const gen = ++plateRebuildGeneration;
		try {
			const baseDepthSafe = Math.max(0.1, baseDepth);
			const outlineWidthSafe = clampElementOutlineThicknessMm(outlineThicknessMm);
			const plateKey = `${baseDepthSafe.toFixed(2)}:${outlineWidthSafe.toFixed(2)}:${baseColor}`;
			const existingPlate = findPlateBaseMesh();
			if (
				existingPlate?.userData.plateKey === plateKey &&
				existingPlate.userData.plateSource === 'openscad'
			) {
				return;
			}

			let refined: THREE.Mesh;
			try {
				refined = await buildPlateBaseMeshFromOpenScad(baseDepthSafe, baseColor);
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
			if (rebuildAgainAfterPending) {
				rebuildAgainAfterPending = false;
				void refinePlateBaseWithOpenScad();
			}
		}
	}

	$effect(() => {
		if (phase !== 'threeD') return;
		ensureThreeScene();
		void elements;
		void elements.map((e) => `${e.id}:${clampPlateElementDepthMm(e.depth)}`);
		void baseDepth;
		void outlineThicknessMm;
		void baseColor;
		void textEmbedMode;
		void textCapDepthMm;

		refreshPlateBadgeScene();

		if (rebuildDebounceTimer !== null) {
			clearTimeout(rebuildDebounceTimer);
			rebuildDebounceTimer = null;
		}
		rebuildDebounceTimer = setTimeout(() => {
			rebuildDebounceTimer = null;
			void refinePlateBaseWithOpenScad().catch((err) =>
				console.error('Plate badge: debounced refinePlateBaseWithOpenScad failed', err)
			);
		}, 400);
		return () => {
			if (rebuildDebounceTimer !== null) {
				clearTimeout(rebuildDebounceTimer);
				rebuildDebounceTimer = null;
			}
		};
	});

	/** Scale is applied here only — avoids full OpenSCAD + mesh rebuild on every slider tick (flicker). */
	$effect(() => {
		// Dependencies first: early returns must not skip these reads or the effect never re-runs.
		void phase;
		void overallScale;
		if (phase !== 'threeD' || !group) return;
		if (group.children.length === 0) return;
		group.scale.set(overallScale, overallScale, 1);
		group.updateWorldMatrix(true, true);
		snapGroupBottomToBuildPlate(group);
		fitKeyLightShadowToModel();
		const size = measureWorldAabbSizeMm(group);
		modelAabbMm = size ? { x: size.x, y: size.y, z: size.z } : null;
	});

	$effect(() => {
		if (phase !== 'threeD') return;
		void selectedId;
		applyThreeSelectionHighlight();
	});

	function enterThreeDPhase() {
		phase = 'threeD';
	}

	function backToLayout() {
		phase = 'layout';
	}

	function modelNameSafe(): string {
		const first = elements.find((e) => isTextElement(e)) as TextElement | undefined;
		const raw = first?.content || 'plate-badge';
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
		const baseDepthSafe = Math.max(0.1, baseDepth);
		let plateMesh: THREE.Mesh;
		try {
			plateMesh = await buildPlateBaseMeshFromOpenScad(baseDepthSafe, baseColor);
		} catch (err) {
			console.error('Plate badge: export OpenSCAD base failed', err);
			plateMesh = buildPlateOuterMeshPreview(baseDepthSafe, baseColor);
		}
		exportGroup.add(plateMesh);

		const outlineWidthSafe = clampElementOutlineThicknessMm(outlineThicknessMm);
		const outlineParts = collectPlateOutlineMeshes(baseDepthSafe, outlineWidthSafe);
		for (const om of outlineParts) exportGroup.add(om);

		for (let i = 0; i < elements.length; i++) {
			const el = elements[i];
			const textLayer = plateBadgeTextLayer3D(
				baseDepthSafe,
				textEmbedMode,
				textCapDepthMm,
				el.depth
			);
			const mesh = buildElementMesh(el, textLayer);
			if (!mesh) continue;
			alignGeometryBottomToZ0(mesh.geometry);
			mesh.position.z = textLayer.bottomZMm;
			exportGroup.add(mesh);
		}
		exportGroup.scale.set(overallScale, overallScale, 1);
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
					designName: 'Plate badge',
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
				designName: 'Plate badge',
				format: '3mf'
			});
			onShowThankYou();
		} catch (err) {
			console.error('Plate badge: 3MF export failed', err);
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
			const exportGroup = await buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'plate-badge');
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Plate badge',
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Plate badge: open with Bambu Studio failed', err);
		} finally {
			openBambuStudioLoading = false;
		}
	}

	function handleSnapshot() {
		if (!renderer || !scene || !camera) return;
		downloadSnapshot(renderer, scene, camera, modelNameSafe());
	}

	$effect(() => {
		const host = canvasHostEl;
		if (phase !== 'layout' || !host) return;
		untrack(() => initKonva(host));
		return () => untrack(() => disposeKonva());
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
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Plate badge</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="shrink-0 px-4 pb-3">
				<div class="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
					<button
						type="button"
						class="rounded-lg px-3 py-1.5 text-xs font-semibold transition {phase === 'layout'
							? 'bg-white text-indigo-600 shadow-sm'
							: 'text-slate-600 hover:text-slate-900'}"
						onclick={() => (phase = 'layout')}
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
									<input
										class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-indigo-500/25 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2"
										type="text"
										value={tel.content}
										oninput={(e) =>
											updateElement(tel.id, {
												content: (e.currentTarget as HTMLInputElement).value
											})}
									/>
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
										min={-PLATE_SPEC.halfLengthMm}
										max={PLATE_SPEC.halfLengthMm}
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
										min={-PLATE_SPEC.halfHeightMm}
										max={PLATE_SPEC.halfHeightMm}
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
									disabled={textEmbedMode === 'cap'}
								/>
								<p class="text-[11px] leading-snug text-slate-500">
									{#if textEmbedMode === 'cap'}
										Uses thin cap depth from Base plate while cap mode is on.
									{:else}
										Extrusion height for this layer in 3D / export.
									{/if}
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
								<span class="text-xs font-medium text-slate-700">Base + outline height (mm)</span>
								<span class="text-xs text-slate-600 tabular-nums">{baseDepth.toFixed(1)}</span>
							</div>
							<Slider
								type="single"
								value={baseDepth}
								onValueChange={(v: number) => (baseDepth = v)}
								min={0.8}
								max={6}
								step={0.2}
								class="w-full"
							/>
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
						<ColorPalettePicker
							value={baseColor}
							onValueChange={(v: string) => (baseColor = v)}
							{palette}
							label="Base color"
						/>
						<div class="space-y-2 border-t border-slate-200 pt-3">
							<span class="text-xs font-medium text-slate-700">Text on top (multi-color)</span>
							<div class="grid grid-cols-2 gap-1.5">
								{#each [{ id: 'full' as const, label: 'Full depth' }, { id: 'cap' as const, label: 'Thin cap' }] as opt (opt.id)}
									<button
										type="button"
										class="rounded-lg border px-2 py-1.5 text-[11px] font-medium transition {textEmbedMode ===
										opt.id
											? 'border-indigo-300 bg-indigo-50 text-indigo-700'
											: 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'}"
										onclick={() => (textEmbedMode = opt.id)}
									>
										{opt.label}
									</button>
								{/each}
							</div>
							{#if textEmbedMode === 'cap'}
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Cap depth (mm)</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{textCapDepthMm.toFixed(2)}</span
										>
									</div>
									<Slider
										type="single"
										value={textCapDepthMm}
										onValueChange={(v: number) =>
											(textCapDepthMm = clampPlateTextCapDepthMm(v, baseDepth))}
										min={PLATE_TEXT_CAP_DEPTH_MIN_MM}
										max={textCapDepthMaxMm}
										step={0.05}
										class="w-full"
									/>
								</label>
								<p class="text-[11px] leading-snug text-slate-500">
									Thin top layer for the letter color — less filament change height when using
									multi-color.
								</p>
							{:else}
								<p class="text-[11px] leading-snug text-slate-500">
									Per-layer text depth (min {PLATE_ELEMENT_DEPTH_MIN_MM} mm) in Properties or
									Per-element 3D below.
								</p>
							{/if}
						</div>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Overall scale</span>
								<span class="text-xs text-slate-600 tabular-nums">{overallScale.toFixed(2)}×</span>
							</div>
							<Slider
								type="single"
								value={overallScale}
								onValueChange={(v: number) => (overallScale = v)}
								min={0.5}
								max={2}
								step={0.05}
								class="w-full"
							/>
						</label>
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
									Base-colored outline ({outlineThicknessMm.toFixed(2)} mm wide, {baseDepth.toFixed(
										1
									)} mm tall) is always added for this layer.
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
										disabled={textEmbedMode === 'cap'}
									/>
									{#if textEmbedMode === 'cap'}
										<p class="text-[11px] leading-snug text-slate-500">
											Cap mode uses global cap depth ({textCapDepthMm.toFixed(2)} mm).
										</p>
									{/if}
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
								<span class="text-xs font-medium text-slate-700">Base + outline height (mm)</span>
								<span class="text-xs text-slate-600 tabular-nums">{baseDepth.toFixed(1)}</span>
							</div>
							<Slider
								type="single"
								value={baseDepth}
								onValueChange={(v: number) => (baseDepth = v)}
								min={0.8}
								max={6}
								step={0.2}
								class="w-full"
							/>
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
						<ColorPalettePicker
							value={baseColor}
							onValueChange={(v: string) => (baseColor = v)}
							{palette}
							label="Base color"
						/>
						<div class="space-y-2 border-t border-slate-200 pt-3">
							<span class="text-xs font-medium text-slate-700">Text on top (multi-color)</span>
							<div class="grid grid-cols-2 gap-1.5">
								{#each [{ id: 'full' as const, label: 'Full depth' }, { id: 'cap' as const, label: 'Thin cap' }] as opt (opt.id)}
									<button
										type="button"
										class="rounded-lg border px-2 py-1.5 text-[11px] font-medium transition {textEmbedMode ===
										opt.id
											? 'border-indigo-300 bg-indigo-50 text-indigo-700'
											: 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'}"
										onclick={() => (textEmbedMode = opt.id)}
									>
										{opt.label}
									</button>
								{/each}
							</div>
							{#if textEmbedMode === 'cap'}
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Cap depth (mm)</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{textCapDepthMm.toFixed(2)}</span
										>
									</div>
									<Slider
										type="single"
										value={textCapDepthMm}
										onValueChange={(v: number) =>
											(textCapDepthMm = clampPlateTextCapDepthMm(v, baseDepth))}
										min={PLATE_TEXT_CAP_DEPTH_MIN_MM}
										max={textCapDepthMaxMm}
										step={0.05}
										class="w-full"
									/>
								</label>
							{:else}
								<p class="text-[11px] leading-snug text-slate-500">
									Letter fill height is set per layer below (min {PLATE_ELEMENT_DEPTH_MIN_MM} mm).
								</p>
							{/if}
							<p class="text-[11px] leading-snug text-slate-500">{textLayerSummary}</p>
						</div>
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
											disabled={textEmbedMode === 'cap'}
										/>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Overall scale</span>
							<span class="text-xs text-slate-600 tabular-nums">{overallScale.toFixed(2)}×</span>
						</div>
						<Slider
							type="single"
							value={overallScale}
							onValueChange={(v: number) => (overallScale = v)}
							min={0.5}
							max={2}
							step={0.05}
							class="w-full"
						/>
					</label>

					<Button variant="outline" class="w-full" onclick={backToLayout}>← Back to layout</Button>
				{/if}
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			{#if phase === 'layout'}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					bind:this={canvasHostEl}
					class="absolute inset-0 touch-none bg-slate-100"
					oncontextmenu={(e) => e.preventDefault()}
				></div>
				<div
					class="absolute top-3 right-3 flex items-center gap-1 rounded-full border border-slate-200 bg-white/95 px-1 py-1 text-xs shadow"
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
				<div bind:this={threeHostEl} class="absolute inset-0"></div>
				<div
					class="pointer-events-none absolute bottom-3 left-3 max-w-[min(100%,18rem)] rounded-full bg-white/90 px-3 py-1.5 text-[10px] font-medium leading-snug text-slate-600 shadow"
				>
					Base + art share Z = 0; whole group snapped to build plate. Tap to select — color in sidebar
				</div>
				<div class="absolute right-4 bottom-4">
					<DesignerExportToolbar
						onSnapshot={handleSnapshot}
						onExport={exportSTL}
						onExport3MF={export3MF}
						onOpenWithBambuStudio={openWithBambuStudio}
						{openBambuStudioLoading}
						{exportLoading}
						exportDisabled={false}
						exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF')}
						showLockIcon={!user || !subscriptionStatus?.isActive}
					/>
				</div>
			{/if}
		</section>
	</div>
</main>
