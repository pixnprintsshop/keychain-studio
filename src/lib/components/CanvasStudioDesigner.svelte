<script lang="ts">
	import { openInSlicer, type OpenWithSlicerId } from '$lib/openInSlicer';
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
	import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';

	import { exportTo3MF } from '$lib/export-to-3mf';
	import {
		centerGeometryXY,
		createRoundedRectShape,
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		frameCameraToObject,
		getFont,
		makeKeyringGeometry,
		measureWorldAabbSizeMm,
		stlToBufferGeometry
	} from '$lib/utils-3d';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import { ensureExportAccess, getExportTitle, showExportLockIcon, type SubscriptionStatus } from '$lib/subscription';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import type { PaletteColor } from '$lib/colorPalette';
	import { runOpenScad } from '$lib/openscad';

	import {
		CLIPPER_SCALE,
		KEYRING_ORIGINS,
		defaultSettings,
		elementsBoundsMm,
		elementLabel,
		getLocalPathsForElement,
		getWorldPathsForElement,
		isShapeElement,
		isTextElement,
		isValidFontKey,
		keyringAnchorMm,
		makeId,
		offsetUnionPaths,
		polyTreeBboxMm,
		polyTreeToThreeShapes,
		threeShapeToClipperTree,
		unionTreeWithCircle,
		type BaseMode,
		type CanvasElement,
		type CanvasStudioSettings,
		type CanvasStudioViewport,
		type KeyringOrigin,
		type ShapeElement,
		type TextElement
	} from '$lib/utils-canvas-studio';
	import { getShape } from '$lib/assets/svg/shapes/index';
	import { remoteShapesStore } from '$lib/assets/svg/shapes/remote.svelte';

	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import FontSelect from './FontSelect.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import * as Popover from '$lib/components/ui/popover/index.js';

	// ── Props ───────────────────────────────────────────────────────────────
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
		subscriptionStatus,
		palette,
		onBack,
		onRequestLogin,
		onShowThankYou,
		onShowPricing
	}: Props = $props();

	const STORAGE_KEY = 'keychain-canvas-studio-settings';
	const ELEMENT_BASE_EMBED = 0.2;

	// ── Settings load / persist ─────────────────────────────────────────────
	function loadSettings(): CanvasStudioSettings {
		const fallback = defaultSettings();
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return fallback;
			const parsed = JSON.parse(raw) as Partial<CanvasStudioSettings>;
			const elements: CanvasElement[] = Array.isArray(parsed.elements)
				? parsed.elements
						.map((el) => sanitizeElement(el))
						.filter((el): el is CanvasElement => el !== null)
				: fallback.elements;
			return {
				artboard: {
					width: clamp(Number(parsed.artboard?.width) || fallback.artboard.width, 30, 200),
					height: clamp(Number(parsed.artboard?.height) || fallback.artboard.height, 20, 200)
				},
				elements: elements.length > 0 ? elements : fallback.elements,
				baseMode: validateBaseMode(parsed.baseMode) ?? fallback.baseMode,
				baseParams: {
					padding: numOr(parsed.baseParams?.padding, fallback.baseParams.padding),
					cornerRadius: numOr(parsed.baseParams?.cornerRadius, fallback.baseParams.cornerRadius),
					outlineThickness: numOr(
						parsed.baseParams?.outlineThickness,
						fallback.baseParams.outlineThickness
					),
					baseDepth: numOr(parsed.baseParams?.baseDepth, fallback.baseParams.baseDepth),
					baseColor: strOr(parsed.baseParams?.baseColor, fallback.baseParams.baseColor)
				},
				keyring: (() => {
					// Backward-compat: pre-keyring-refactor saves used
					// `diameter` (hole) and `offsetFromEdge`. Pre-origin saves
					// implicitly used bbox center → migrate to origin='mc'.
					const k = (parsed.keyring ?? {}) as Record<string, unknown>;
					const rawOrigin = k.origin;
					const origin: KeyringOrigin = KEYRING_ORIGINS.includes(rawOrigin as KeyringOrigin)
						? (rawOrigin as KeyringOrigin)
						: 'mc';
					return {
						enabled:
							typeof k.enabled === 'boolean' ? (k.enabled as boolean) : fallback.keyring.enabled,
						outerSize: numOr(k.outerSize, fallback.keyring.outerSize),
						holeSize: numOr(k.holeSize ?? k.diameter, fallback.keyring.holeSize),
						origin,
						offsetX: numOr(k.offsetX, fallback.keyring.offsetX),
						offsetY: numOr(k.offsetY, fallback.keyring.offsetY)
					};
				})(),
				scale: numOr(parsed.scale, fallback.scale),
				phase: parsed.phase === 'threeD' ? 'threeD' : 'layout',
				viewport: sanitizeViewport(parsed.viewport)
			};
		} catch (e) {
			console.error('Canvas Studio: failed to load settings', e);
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

	function clamp(v: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, v));
	}
	function numOr(v: unknown, def: number): number {
		const n = Number(v);
		return Number.isFinite(n) ? n : def;
	}
	function strOr(v: unknown, def: string): string {
		return typeof v === 'string' && v ? v : def;
	}
	function validateBaseMode(v: unknown): BaseMode | null {
		return v === 'none' || v === 'outline' || v === 'rectangle' || v === 'circle' ? v : null;
	}
	function originLabel(o: KeyringOrigin): string {
		const v = o[0];
		const h = o[1];
		const vLabel = v === 't' ? 'Top' : v === 'b' ? 'Bottom' : 'Middle';
		const hLabel = h === 'l' ? 'left' : h === 'r' ? 'right' : 'center';
		return `${vLabel} ${hLabel}`;
	}
	const ORIGIN_ARROWS: Record<KeyringOrigin, string> = {
		tl: '↖',
		tc: '↑',
		tr: '↗',
		ml: '←',
		mc: '',
		mr: '→',
		bl: '↙',
		bc: '↓',
		br: '↘'
	};
	function sanitizeElement(el: any): CanvasElement | null {
		if (!el || typeof el !== 'object') return null;
		const base = {
			id: typeof el.id === 'string' ? el.id : makeId(),
			x: numOr(el.x, 0),
			y: numOr(el.y, 0),
			rotation: numOr(el.rotation, 0),
			scaleX: numOr(el.scaleX, 1),
			scaleY: numOr(el.scaleY, 1),
			color: strOr(el.color, '#ffffff'),
			depth: numOr(el.depth, 1.5)
		};
		if (el.kind === 'text') {
			const fontKey = isValidFontKey(String(el.fontKey || ''))
				? String(el.fontKey)
				: FONT_OPTIONS[0].key;
			return {
				...base,
				kind: 'text',
				content: typeof el.content === 'string' ? el.content : 'Text',
				fontKey,
				size: numOr(el.size, 14)
			};
		}
		if (el.kind === 'shape') {
			// Preserve the saved shapeId even if `getShape` can't resolve it
			// yet — the remote catalog may still be loading. Path generation
			// already returns an empty list for unresolved shapes, so the
			// element will simply render as nothing until the catalog lands.
			const shapeId = typeof el.shapeId === 'string' && el.shapeId ? el.shapeId : null;
			if (!shapeId) return null;
			return {
				...base,
				kind: 'shape',
				shapeId,
				size: numOr(el.size, 20)
			};
		}
		return null;
	}

	const initial = loadSettings();
	let artboard = $state(initial.artboard);
	let elements = $state<CanvasElement[]>(initial.elements);
	let baseMode = $state<BaseMode>(initial.baseMode);
	let baseParams = $state(initial.baseParams);
	let keyring = $state(initial.keyring);
	let overallScale = $state(initial.scale);
	let phase = $state<'layout' | 'threeD'>(initial.phase);
	let selectedId = $state<string | null>(initial.elements[0]?.id ?? null);
	/** Persisted 2D canvas viewport. Updated on every pan/zoom interaction and
	 *  on disposeKonva (so it captures the latest state before unmount). */
	let viewport = $state<CanvasStudioViewport | null>(initial.viewport ?? null);

	// Kick off remote shape fetch (Supabase catalog). The store hydrates
	// from localStorage cache synchronously so the picker is populated on
	// first open for repeat visitors; refreshes from the DB in the background.
	remoteShapesStore.ensure();

	/** Picker tab list. Derived from the loaded catalog — the DB query is
	 *  ordered by `category ASC`, so first-occurrence order is alphabetical. */
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
		const snap: CanvasStudioSettings = {
			artboard,
			elements,
			baseMode,
			baseParams,
			keyring,
			scale: overallScale,
			phase,
			viewport: viewport ?? undefined
		};
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
		} catch (e) {
			console.error('Canvas Studio: persist failed', e);
		}
	});

	const selectedElement = $derived(elements.find((e) => e.id === selectedId) ?? null);

	// ── Layout helpers ─────────────────────────────────────────────────────
	// Every mutator below pushes to Konva imperatively at the end (instead of
	// relying on a `$effect` that watches `elements`/`selectedId`). This keeps
	// the canvas rock-stable: sidebar control changes never trigger any
	// effect-driven viewport math.
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
		const el: TextElement = {
			id: makeId(),
			kind: 'text',
			content: 'Text',
			fontKey: FONT_OPTIONS[0].key,
			size: 12,
			x: cx,
			y: cy,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			color: '#ffffff',
			depth: 1.5
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
		const el: ShapeElement = {
			id: makeId(),
			kind: 'shape',
			shapeId,
			size: 18,
			x: cx,
			y: cy,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			color: '#ec4899',
			depth: 1.5
		};
		elements = [...elements, el];
		selectedId = el.id;
		shapePickerOpen = false;
		pushElementsToKonva();
	}

	function updateElement(id: string, patch: Partial<CanvasElement>) {
		elements = elements.map((el) => (el.id === id ? ({ ...el, ...patch } as CanvasElement) : el));
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
		const next = [...elements];
		next.splice(idx + 1, 0, copy);
		elements = next;
		selectedId = copy.id;
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

	// ── 2D canvas (Konva) ──────────────────────────────────────────────────
	// Konva does all the heavy lifting: stage-level pan/zoom, per-node drag,
	// and a built-in Transformer for corner/edge/rotate handles. We drive it
	// from the `elements` data model via a tiny sync layer.
	let canvasHostEl: HTMLDivElement | null = $state(null);
	let shapePickerOpen = $state(false);
	/** Live mirror of `konvaStage.scaleX()` so the zoom toolbar can show %. */
	let stageZoomPct = $state(100);
	/** Whether space-bar is held — enables grab-to-pan on the empty area. */
	let isSpaceDown = $state(false);

	let konvaStage: Konva.Stage | null = null;
	let konvaGridLayer: Konva.Layer | null = null;
	let konvaContentLayer: Konva.Layer | null = null;
	let konvaUiLayer: Konva.Layer | null = null;
	let konvaTransformer: Konva.Transformer | null = null;
	let konvaWheelPreventer: ((e: WheelEvent) => void) | null = null;
	let konvaWindowResize: (() => void) | null = null;
	let konvaInitFrame: number | null = null;
	/** Becomes true after the first measure with real dims; subsequent window
	 *  resizes then only change width/height and never touch position. */
	let didInitialMeasure = false;
	const pathNodes = new Map<string, Konva.Path>();

	const MIN_ZOOM = 0.4;
	const MAX_ZOOM = 16;
	/** Starting scale: visible mm-per-pixel. ~4 px/mm fits a typical keychain
	 *  comfortably inside a 600–900 px viewport. */
	const INITIAL_SCALE = 4;

	function initKonva(host: HTMLDivElement) {
		const rect = host.getBoundingClientRect();
		// Initial canvas size. If the host's CSS layout hasn't settled yet,
		// fall back to a sane default (window dims minus a guess for sidebar);
		// we re-measure in `applyHostSize` on the next animation frame anyway.
		const w0 = Math.max(1, rect.width || window.innerWidth - 360);
		const h0 = Math.max(1, rect.height || window.innerHeight - 64);

		konvaStage = new Konva.Stage({ container: host, width: w0, height: h0 });
		konvaGridLayer = new Konva.Layer({ listening: false });
		konvaContentLayer = new Konva.Layer();
		konvaUiLayer = new Konva.Layer();
		konvaStage.add(konvaGridLayer);
		konvaStage.add(konvaContentLayer);
		konvaStage.add(konvaUiLayer);

		// Restore persisted viewport if available, otherwise center the
		// artboard origin at INITIAL_SCALE. Restoring marks the initial
		// measure as done so the rAF re-measure doesn't override the pan/zoom.
		if (viewport) {
			konvaStage.scale({ x: viewport.scale, y: viewport.scale });
			konvaStage.position({ x: viewport.x, y: viewport.y });
			stageZoomPct = Math.round(viewport.scale * 25);
			didInitialMeasure = true;
		} else {
			konvaStage.scale({ x: INITIAL_SCALE, y: INITIAL_SCALE });
			konvaStage.position({ x: w0 / 2, y: h0 / 2 });
			stageZoomPct = Math.round(INITIAL_SCALE * 25); // 4 px/mm → 100 %
			didInitialMeasure = rect.width > 0 && rect.height > 0;
		}

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

		// Stage-level interactions.
		konvaStage.on('wheel', onStageWheel);
		konvaStage.on('mousedown touchstart', onStageMouseDown);
		konvaStage.on('click tap', onStageClick);

		// Konva attaches wheel as passive; preventDefault inside .on('wheel')
		// doesn't actually stop the page from scrolling. So we also attach a
		// passive:false listener directly on the container that just calls
		// preventDefault. Konva still gets the event and updates the stage.
		konvaWheelPreventer = (e) => e.preventDefault();
		host.addEventListener('wheel', konvaWheelPreventer, { passive: false });

		// IMPORTANT: we DO NOT observe `host` with ResizeObserver. Sidebar
		// interactions (selecting an element, dragging a slider, etc.) can
		// shift the section's width by a few pixels because of layout
		// reflows, and any width change applied to the stage would visibly
		// jump the right edge of the viewport — perceived as "the canvas
		// just zoomed/centered". Instead, we only react to *window* resizes,
		// which are the only resizes the user explicitly triggers. Internal
		// layout shifts are silently absorbed by `overflow: hidden` on the
		// section: the canvas keeps its full pixel size and gets clipped if
		// the parent shrinks — content stays exactly where it was on screen.
		konvaWindowResize = () => applyHostSize(host);
		window.addEventListener('resize', konvaWindowResize);
		// Apply real dims on the next frame, in case the host was 0×0 at mount.
		konvaInitFrame = requestAnimationFrame(() => {
			konvaInitFrame = null;
			applyHostSize(host);
		});

		drawKonvaGrid();
		syncElementsToKonva();
		syncSelectionToKonva();
	}

	/** Match the Konva stage to the host's current size. Only sets/changes the
	 *  stage position on the *very first* measure (after a possible 0×0 init);
	 *  subsequent resizes only change width/height so content stays at the
	 *  exact same screen pixels and the user's pan/zoom is never disturbed. */
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
			// First real-size measure: center the origin now (the init step ran
			// with a placeholder size because CSS layout hadn't settled).
			konvaStage.position({ x: newW / 2, y: newH / 2 });
			didInitialMeasure = true;
			captureViewport();
		}
		drawKonvaGrid();
	}

	function disposeKonva() {
		// Capture viewport one last time so it survives the unmount.
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
		konvaContentLayer = null;
		konvaUiLayer = null;
		pathNodes.clear();
	}

	/** Snapshot the current Konva stage transform into the persisted `viewport`
	 *  state. Called after every pan/zoom interaction so the value survives
	 *  phase changes (layout ↔ 3D) and page reloads via the persistence effect. */
	function captureViewport() {
		if (!konvaStage) return;
		viewport = {
			scale: konvaStage.scaleX(),
			x: konvaStage.x(),
			y: konvaStage.y()
		};
	}

	/** Artboard-space mm (origin = artboard center, Y-up) under the center of the
	 *  Konva viewport — matches `zoomBy` / grid math so new elements land in the
	 *  middle of what you see after pan/zoom. */
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

	/** Convert a data-model element's `(x, y, rotation, scaleX, scaleY)` to the
	 *  Konva node attributes. Our data model is Y-up + CCW radians; Konva is
	 *  Y-down + CW degrees, so we negate the y and rotation. */
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

	/** Build (and cache by ref) one Konva.Path node for an element. */
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
		node.on('mousedown touchstart', () => {
			setSelected(el.id);
		});
		node.on('dragstart', () => {
			setSelected(el.id);
		});
		node.on('dragend', () => {
			updateElement(el.id, { x: node.x(), y: -node.y() });
		});
		node.on('transformend', () => {
			updateElement(el.id, elementUpdatesFromKonva(node));
		});
		return node;
	}

	/** Sync the element data model → Konva.Path nodes. Creates new nodes,
	 *  updates existing ones in place, destroys removed ones, and reorders
	 *  z-index to match `elements`. */
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
				const a = konvaAttrsFromElement(el);
				if (Math.abs(node.x() - a.x) > 1e-4) node.x(a.x);
				if (Math.abs(node.y() - a.y) > 1e-4) node.y(a.y);
				if (Math.abs(node.rotation() - a.rotation) > 1e-3) node.rotation(a.rotation);
				if (Math.abs(node.scaleX() - a.scaleX) > 1e-4) node.scaleX(a.scaleX);
				if (Math.abs(node.scaleY() - a.scaleY) > 1e-4) node.scaleY(a.scaleY);
			}
		}
		// Match z-order. Higher index in `elements` = drawn on top.
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
		stageZoomPct = Math.round(newScale * 25);
		drawKonvaGrid();
		captureViewport();
	}

	type PanState = { startX: number; startY: number; ox: number; oy: number };
	let panState: PanState | null = null;

	/** True when the click target is “empty” canvas (not an element path or transformer). */
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
		// Clicking empty workspace with the left button deselects (in addition
		// to starting a pan).
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
			if (konvaStage) {
				konvaStage.container().style.cursor = isSpaceDown ? 'grab' : '';
			}
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
		stageZoomPct = Math.round(newScale * 25);
		drawKonvaGrid();
		captureViewport();
	}

	function resetView() {
		if (!konvaStage) return;
		const stage = konvaStage;
		stage.scale({ x: INITIAL_SCALE, y: INITIAL_SCALE });
		stage.position({ x: stage.width() / 2, y: stage.height() / 2 });
		stageZoomPct = Math.round(INITIAL_SCALE * 25);
		drawKonvaGrid();
		captureViewport();
	}

	/** Re-render the adaptive grid for the currently visible region. Lines are
	 *  drawn in stage-local mm with `strokeScaleEnabled: false`, so they stay
	 *  crisp at every zoom level. */
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
		const buffer = 50; // mm — keeps lines from popping at the edges while panning
		const showMinor = sx >= 4;

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

		// Hard world cap so we don't generate enormous grids if user zooms out far.
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

	/** Build the SVG path `d` string for an element in local mm coordinates (Y-up). */
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

	// ── Keyboard shortcuts (nudge / delete / duplicate / space-to-pan) ──────
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

	// ── 3D scene state ──────────────────────────────────────────────────────
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
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);
	let openWithSlicerLoading = $state(false);
	let exportLoading = $state(false);
	/** Fat-line outline for selection (`LineSegments2` = real pixel width on screen). */
	let threeSelectionOutline: LineSegments2 | null = null;

	const threePickRaycaster = new THREE.Raycaster();
	const threePickNdc = new THREE.Vector2();
	let threePickDown: { x: number; y: number } | null = null;

	function onThreePickPointerDown(e: PointerEvent) {
		if (e.button !== 0 || phase !== 'threeD') return;
		threePickDown = { x: e.clientX, y: e.clientY };
		// Listen on `window` so we still get `pointerup` if the cursor leaves the
		// canvas before release (OrbitControls uses the same canvas).
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
		/** Ignore drags (orbit / pan); allow a small wobble for real clicks. */
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
			// Re-attach the canvas if the user toggled back to 3D after a
			// detour through the 2D layout (the {:else} branch unmounts the
			// host div, so the renderer's canvas gets orphaned).
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
		controls.minDistance = 30;
		controls.maxDistance = 1200;
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

	// ── Base shape geometry ─────────────────────────────────────────────────
	interface BaseGeometry {
		shapes: THREE.Shape[];
		bounds: { halfW: number; halfH: number; cx: number; cy: number };
		keyringCenter?: { x: number; y: number };
	}

	function computeBaseGeometry(): BaseGeometry | null {
		if (baseMode === 'none' || elements.length === 0) return null;
		const elementsBounds = elementsBoundsMm(elements);
		if (!elementsBounds) return null;
		const pad = Math.max(0, baseParams.padding);
		const minX = elementsBounds.minX - pad;
		const maxX = elementsBounds.maxX + pad;
		const minY = elementsBounds.minY - pad;
		const maxY = elementsBounds.maxY + pad;
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		if (baseMode === 'rectangle' || baseMode === 'circle') {
			let halfW: number;
			let halfH: number;
			let baseShape: THREE.Shape;
			if (baseMode === 'rectangle') {
				halfW = Math.max(1, (maxX - minX) / 2);
				halfH = Math.max(1, (maxY - minY) / 2);
				const r = Math.max(0, Math.min(baseParams.cornerRadius, halfW, halfH));
				baseShape = createRoundedRectShape(halfW, halfH, r);
				translateShape(baseShape, cx, cy);
			} else {
				const radius = Math.max(1, Math.hypot(maxX - cx, maxY - cy));
				halfW = radius;
				halfH = radius;
				baseShape = circleShape(cx, cy, radius);
			}
			// Fast path: keyring disabled → no need to roundtrip through Clipper.
			if (!keyring.enabled) {
				return {
					shapes: [baseShape],
					bounds: { halfW, halfH, cx, cy }
				};
			}
			// Keyring enabled: union the outer ring into the 2D shape (same
			// recipe outline mode uses) so the keyring has its own tab if it
			// pokes outside the base, and the hole-drilling step at extrude
			// time still works regardless.
			// Use the *base* bbox (rect=padded-elements, circle=diagonal-radius),
			// not the element bbox, so origin='tc' anchors at the top of the
			// actual base shape.
			const baseBbox = {
				minX: cx - halfW,
				maxX: cx + halfW,
				minY: cy - halfH,
				maxY: cy + halfH
			};
			const anchor = keyringAnchorMm(baseBbox, keyring.origin);
			const kCenter = { x: anchor.x + keyring.offsetX, y: anchor.y + keyring.offsetY };
			const ringR = Math.max(0.5, keyring.outerSize / 2);
			let tree = threeShapeToClipperTree(baseShape, 96);
			tree = unionTreeWithCircle(tree, kCenter.x, kCenter.y, ringR, 96);
			const shapes = polyTreeToThreeShapes(tree);
			if (shapes.length === 0) {
				return {
					shapes: [baseShape],
					bounds: { halfW, halfH, cx, cy },
					keyringCenter: kCenter
				};
			}
			// Final bbox (after ring) for camera framing.
			const fb = polyTreeBboxMm(tree);
			const fHalfW = fb ? Math.max(halfW, (fb.maxX - fb.minX) / 2) : halfW;
			const fHalfH = fb ? Math.max(halfH, (fb.maxY - fb.minY) / 2) : halfH;
			return {
				shapes,
				bounds: { halfW: fHalfW, halfH: fHalfH, cx, cy },
				keyringCenter: kCenter
			};
		}
		if (baseMode === 'outline') {
			const offset = Math.max(0.1, baseParams.outlineThickness);
			let tree = offsetUnionPaths(elements, offset);
			// Bbox of the outline *before* the ring is added – this is the
			// reference frame the keyring origin + offset is interpreted in,
			// so moving the ring around doesn't recursively shift its anchor.
			const outlineBbox = polyTreeBboxMm(tree);
			if (!outlineBbox) return null;
			const ocx = (outlineBbox.minX + outlineBbox.maxX) / 2;
			const ocy = (outlineBbox.minY + outlineBbox.maxY) / 2;
			let kCenter: { x: number; y: number } | null = null;
			if (keyring.enabled) {
				const anchor = keyringAnchorMm(outlineBbox, keyring.origin);
				kCenter = { x: anchor.x + keyring.offsetX, y: anchor.y + keyring.offsetY };
				// Union the outer ring into the outline. Same trick as
				// TextOutlineDesigner: gives the keyring a tab of material so a
				// hole can be drilled through it without piercing the outline.
				const ringR = Math.max(0.5, keyring.outerSize / 2);
				tree = unionTreeWithCircle(tree, kCenter.x, kCenter.y, ringR, 96);
			}
			const shapes = polyTreeToThreeShapes(tree);
			if (shapes.length === 0) return null;
			// Final bbox (including ring) – used for camera framing & HUD only.
			const finalBbox = polyTreeBboxMm(tree) ?? outlineBbox;
			return {
				shapes,
				bounds: {
					halfW: Math.max(1, (finalBbox.maxX - finalBbox.minX) / 2),
					halfH: Math.max(1, (finalBbox.maxY - finalBbox.minY) / 2),
					cx: ocx,
					cy: ocy
				},
				keyringCenter: kCenter ?? undefined
			};
		}
		return null;
	}

	function circleShape(cx: number, cy: number, radius: number): THREE.Shape {
		const shape = new THREE.Shape();
		shape.absarc(cx, cy, radius, 0, Math.PI * 2, false);
		return shape;
	}

	function translateShape(shape: THREE.Shape, dx: number, dy: number) {
		const m = new THREE.Matrix3().translate(dx, dy);
		const t = (v: THREE.Vector2) => v.applyMatrix3(m);
		for (const c of shape.curves) {
			const ec = c as THREE.LineCurve;
			if (ec.v1) t(ec.v1);
			if ((ec as any).v2) t((ec as any).v2);
		}
		for (const h of shape.holes) {
			for (const c of h.curves) {
				const ec = c as THREE.LineCurve;
				if (ec.v1) t(ec.v1);
				if ((ec as any).v2) t((ec as any).v2);
			}
		}
	}

	function keyringCenterForBase(base: BaseGeometry): { x: number; y: number } | null {
		if (!keyring.enabled || baseMode === 'none') return null;
		// Outline mode bakes the center into base.keyringCenter (so the ring
		// position matches the ring tab that was unioned in). Other modes
		// derive it from the base bbox + origin + offset.
		if (base.keyringCenter) return base.keyringCenter;
		const anchor = keyringAnchorMm(
			{
				minX: base.bounds.cx - base.bounds.halfW,
				maxX: base.bounds.cx + base.bounds.halfW,
				minY: base.bounds.cy - base.bounds.halfH,
				maxY: base.bounds.cy + base.bounds.halfH
			},
			keyring.origin
		);
		return {
			x: anchor.x + keyring.offsetX,
			y: anchor.y + keyring.offsetY
		};
	}

	// ── 3D rebuild pipeline ────────────────────────────────────────────────
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
			const id = obj.userData?.elementId as string | undefined;
			if (id === elementId) found = obj;
		});
		return found;
	}

	/** Crease outline only — leaves `MeshStandardMaterial.color` unchanged. */
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
		lines.name = 'canvasStudioSelectionOutline';
		lines.renderOrder = 2;
		// Fat lines would win raycasts; keep pick on the solid mesh for tap-to-select.
		lines.raycast = () => {};
		threeSelectionOutline = lines;
		mesh.add(lines);
	}

	async function rebuild3D() {
		if (phase !== 'threeD' || !scene || !group) return;
		if (rebuildPending) return;
		rebuildPending = true;
		try {
			disposeThreeSelectionOutline();
			disposeObject3D(group);
			group.clear();
			modelAabbMm = null;

			const baseGeoInfo = computeBaseGeometry();
			const baseDepthSafe = Math.max(0.1, baseParams.baseDepth);

			// Build base mesh (preview — three-bvh-csg for keyring subtraction).
			let baseMesh: THREE.Mesh | null = null;
			let kCenter: { x: number; y: number } | null = null;
			if (baseGeoInfo) {
				let baseGeo: THREE.BufferGeometry = new THREE.ExtrudeGeometry(baseGeoInfo.shapes, {
					depth: baseDepthSafe,
					bevelEnabled: false,
					curveSegments: 24
				});
				kCenter = keyringCenterForBase(baseGeoInfo);
				if (kCenter) {
					const innerD = Math.max(1, keyring.holeSize);
					const cylShape = new THREE.Shape();
					cylShape.absarc(kCenter.x, kCenter.y, innerD / 2, 0, Math.PI * 2, false);
					const cylGeo = new THREE.ExtrudeGeometry([cylShape], {
						depth: baseDepthSafe + 2,
						bevelEnabled: false,
						curveSegments: 48
					});
					cylGeo.translate(0, 0, -1);
					const baseMat = new THREE.MeshStandardMaterial({
						color: baseParams.baseColor,
						roughness: 0.85,
						metalness: 0.05
					});
					const baseBrush = new Brush(baseGeo, baseMat);
					baseBrush.updateMatrixWorld(true);
					const cylBrush = new Brush(cylGeo, new THREE.MeshBasicMaterial());
					cylBrush.updateMatrixWorld(true);
					try {
						const out = new Brush(new THREE.BufferGeometry(), baseMat);
						new Evaluator().evaluate(baseBrush, cylBrush, SUBTRACTION, out);
						baseGeo.dispose();
						baseGeo = out.geometry;
					} catch (err) {
						console.error('Canvas Studio: CSG keyring subtract failed', err);
					} finally {
						cylBrush.geometry.dispose();
					}
					baseMesh = new THREE.Mesh(baseGeo, baseMat);
				} else {
					const baseMat = new THREE.MeshStandardMaterial({
						color: baseParams.baseColor,
						roughness: 0.85,
						metalness: 0.05
					});
					baseMesh = new THREE.Mesh(baseGeo, baseMat);
				}
				baseMesh.name = 'base';
				baseMesh.castShadow = true;
				baseMesh.receiveShadow = true;
				baseMesh.position.z = 0;
				group.add(baseMesh);
			}

			// Build element meshes — one mesh per element with its own color & depth.
			const baseTopZ = baseMesh ? baseDepthSafe : 0;
			for (let i = 0; i < elements.length; i++) {
				const el = elements[i];
				const mesh = buildElementMesh(el);
				if (!mesh) continue;
				const elDepth = Math.max(0.1, el.depth);
				const embed = baseMesh ? ELEMENT_BASE_EMBED : 0;
				mesh.position.z = baseTopZ - embed + i * 0.01;
				mesh.userData.elementId = el.id;
				mesh.userData.elementDepth = elDepth;
				mesh.castShadow = true;
				mesh.receiveShadow = true;
				group.add(mesh);
			}

			group.scale.set(overallScale, overallScale, 1);
			group.updateWorldMatrix(true, true);
			const box = new THREE.Box3().setFromObject(group);
			if (keyLight && keyLight.shadow?.camera) {
				const sizeVec = new THREE.Vector3();
				box.getSize(sizeVec);
				const center = new THREE.Vector3();
				box.getCenter(center);
				const r = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 0.75 + 20;
				const cam = keyLight.shadow.camera as THREE.OrthographicCamera;
				cam.left = -r;
				cam.right = r;
				cam.top = r;
				cam.bottom = -r;
				cam.near = 0.1;
				cam.far = Math.max(400, r * 6);
				cam.updateProjectionMatrix?.();
				keyLight.target.position.copy(center);
				keyLight.target.updateWorldMatrix?.(true, true);
			}
			if (!didInitFrame && camera && controls) {
				frameCameraToObject(box, camera, controls);
				didInitFrame = true;
			}
			const size = measureWorldAabbSizeMm(group);
			modelAabbMm = size ? { x: size.x, y: size.y, z: size.z } : null;
			applyThreeSelectionHighlight();
		} finally {
			rebuildPending = false;
		}
	}

	function buildElementMesh(el: CanvasElement): THREE.Mesh | null {
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
		const geo = new THREE.ExtrudeGeometry(shapes, {
			depth: Math.max(0.1, el.depth),
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
		return mesh;
	}

	// Set up the Three.js scene the first time we enter 3D (and re-attach the
	// canvas if the user toggled away and back), then rebuild whenever any
	// 3D-affecting input changes. Combining both into one effect avoids a race
	// where the rebuild fires before the scene exists: ensureThreeScene runs
	// synchronously, so `scene`/`group` are guaranteed populated by the time
	// rebuild3D is invoked below.
	$effect(() => {
		if (phase !== 'threeD') return;
		ensureThreeScene();
		// Reactive dependencies that should trigger a rebuild.
		void elements;
		void baseMode;
		void baseParams.padding;
		void baseParams.cornerRadius;
		void baseParams.outlineThickness;
		void baseParams.baseDepth;
		void baseParams.baseColor;
		void keyring.enabled;
		void keyring.outerSize;
		void keyring.holeSize;
		void keyring.origin;
		void keyring.offsetX;
		void keyring.offsetY;
		void overallScale;
		void rebuild3D();
	});

	/** Selection-only changes: update emissive highlight without a full mesh rebuild. */
	$effect(() => {
		if (phase !== 'threeD') return;
		void selectedId;
		applyThreeSelectionHighlight();
	});

	function enterThreeDPhase() {
		if (elements.length === 0) return;
		phase = 'threeD';
	}

	function backToLayout() {
		phase = 'layout';
	}

	// ── Export ─────────────────────────────────────────────────────────────
	function modelNameSafe(): string {
		const first = elements.find((e) => isTextElement(e)) as TextElement | undefined;
		const raw = first?.content || 'design';
		const safe = raw
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '');
		return safe || 'design';
	}

	function pointsToScadList(pts: { x: number; y: number }[]): string {
		return '[' + pts.map((p) => `[${p.x.toFixed(4)}, ${p.y.toFixed(4)}]`).join(', ') + ']';
	}

	function shapeToOuterCcwPoints(shape: THREE.Shape, divisions = 64): { x: number; y: number }[] {
		const pts = shape.getPoints(divisions).map((p) => ({ x: p.x, y: p.y }));
		if (THREE.ShapeUtils.isClockWise(pts.map((p) => new THREE.Vector2(p.x, p.y)))) pts.reverse();
		return pts;
	}

	function getOpenScadBaseScript(): string | null {
		const info = computeBaseGeometry();
		if (!info) return null;
		const baseT = Math.max(0.1, baseParams.baseDepth);
		const outerOutlines = info.shapes.map((s) => shapeToOuterCcwPoints(s, 96));
		if (outerOutlines.length === 0) return null;
		const polygons = outerOutlines
			.map((pts) => `polygon(points = ${pointsToScadList(pts)});`)
			.join('\n      ');
		const kc = keyringCenterForBase(info);
		const kr = Math.max(0.5, keyring.holeSize / 2);
		const slot =
			kc && keyring.enabled
				? `
  translate([${kc.x.toFixed(4)}, ${kc.y.toFixed(4)}, -1]) {
    cylinder(h = ${(baseT + 2).toFixed(4)}, r = ${kr.toFixed(4)}, $fn = 96);
  }`
				: '';
		return `
$fn = 96;
base_t = ${baseT.toFixed(4)};

difference() {
  linear_extrude(height = base_t) {
    union() {
      ${polygons}
    }
  }${slot}
}
`;
	}

	async function buildOpenScadBaseMesh(baseColor: string): Promise<THREE.Mesh | null> {
		const source = getOpenScadBaseScript();
		if (!source) return null;
		const stl = await runOpenScad(source);
		let geo = stlToBufferGeometry(stl);
		geo = BufferGeometryUtils.mergeVertices(geo, 1e-3);
		geo.computeVertexNormals();
		geo.computeBoundingBox();
		const bb = geo.boundingBox!;
		// OpenSCAD base sits in absolute mm (centered roughly around the elements bbox).
		// Preserve the (x, y) so element meshes still align; just normalize z to 0.
		geo.translate(0, 0, -bb.min.z);
		const mat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.85,
			metalness: 0.05
		});
		const mesh = new THREE.Mesh(geo, mat);
		mesh.name = 'base';
		return mesh;
	}

	async function buildExportGroup(): Promise<THREE.Group> {
		const exportGroup = new THREE.Group();
		const baseDepthSafe = Math.max(0.1, baseParams.baseDepth);

		// Manifold base via OpenSCAD when a base is configured.
		let baseMesh: THREE.Mesh | null = null;
		if (baseMode !== 'none') {
			baseMesh = await buildOpenScadBaseMesh(baseParams.baseColor);
			if (baseMesh) exportGroup.add(baseMesh);
		}

		// Elements: each as a separate body, sitting *on top* of the base so
		// slicers can apply different filaments.
		const baseTopZ = baseMesh ? baseDepthSafe : 0;
		for (let i = 0; i < elements.length; i++) {
			const el = elements[i];
			const mesh = buildElementMesh(el);
			if (!mesh) continue;
			mesh.position.z = baseTopZ + i * 0.01;
			exportGroup.add(mesh);
		}
		exportGroup.scale.set(overallScale, overallScale, 1);
		exportGroup.updateWorldMatrix(true, true);
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
					designName: 'Freeform Design Canvas',
					format: 'stl'
				});
			}
			onShowThankYou();
		} catch (err) {
			console.error('Canvas Studio: STL export failed', err);
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
				designName: 'Freeform Design Canvas',
				format: '3mf'
			});
			onShowThankYou();
		} catch (err) {
			console.error('Canvas Studio: 3MF export failed', err);
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
			const publicUrl = await upload3mfToSupabase(blob, 'canvas-studio');
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Freeform Design Canvas',
				format: 'bambu_studio'
			});
			openInSlicer(publicUrl, slicer);
		} catch (err) {
			console.error('Canvas Studio: open with Bambu Studio failed', err);
		} finally {
			openWithSlicerLoading = false;
		}
	}

	function handleSnapshot() {
		if (!renderer || !scene || !camera) return;
		downloadSnapshot(renderer, scene, camera, modelNameSafe());
	}

	// ── Lifecycle (Konva stage init/dispose, 3D cleanup) ───────────────────
	// Init Konva once the layout-phase host div is mounted; tear down when the
	// user switches to the 3D phase (since that branch unmounts the div).
	// IMPORTANT: this is the *only* Konva-related effect. We call `untrack`
	// around `initKonva` because that function reads `elements` / `selectedId`
	// (for the initial node creation + transformer attachment) — without
	// untracking, Svelte 5 would add those as dependencies of this effect, so
	// every selection or mutation would re-init the stage and reset zoom/pan.
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
		<!-- Left sidebar: Layers / Add / Properties -->
		<aside
			class="flex min-h-0 w-full max-w-[360px] min-w-[300px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Freeform Design Canvas</h1>
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
						disabled={elements.length === 0}
					>
						2. 3D
					</button>
				</div>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4 pt-0">
				{#if phase === 'layout'}
					<!-- Add element -->
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
								<div class="flex flex-col flex-1 h-full">
									<div class="space-y-4 overflow-y-auto p-2 max-h-[calc(min(70vh,28rem)-3rem)] flex-1">
										{#each shapeCategories as cat (cat)}
											<div>
												<p
													class="mb-2 text-[10px] font-semibold tracking-wider text-slate-500 uppercase"
												>
													{cat}
												</p>
												<div class="grid grid-cols-5 gap-2">
													{#each remoteShapesStore.shapes.filter((s) => s.category === cat) as def (def.id)}
														<!-- svelte-ignore a11y_click_events_have_key_events -->
														<button
															type="button"
															title={def.label}
															class="flex aspect-square min-h-10 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white p-2 text-slate-700 transition hover:border-indigo-400 hover:text-indigo-600 focus:ring-2 focus:ring-indigo-500/30 focus:outline-none"
															onclick={() => addShape(def.id)}
														>
															<!-- svelte-ignore a11y_missing_attribute -->
															<div
																class="grid size-full place-items-center [&_svg]:block [&_svg]:size-8 [&_svg]:max-w-full"
															>
																{@html def.rawSvg}
															</div>
														</button>
													{/each}
												</div>
											</div>
										{/each}
									</div>
								</div>
							</Popover.Content>
						</Popover.Root>
					</div>

					<!-- Layers list -->
					<div class="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
						<div class="mb-2 text-xs font-semibold tracking-tight text-slate-700">
							Layers ({elements.length})
						</div>
						{#if elements.length === 0}
							<p class="text-xs text-slate-500">No elements. Click "+ Text" or "+ Shape" to add.</p>
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

					<!-- Properties -->
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
										max={40}
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
										max={120}
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
										min={-200}
										max={200}
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
										min={-200}
										max={200}
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
				{:else}
					<!-- ── Phase 2: 3D refine controls ─────────────────────────────── -->
					<div class="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
						<div class="mb-2 text-xs font-semibold tracking-tight text-slate-700">
							Layers ({elements.length})
						</div>
						{#if elements.length === 0}
							<p class="text-xs text-slate-500">No elements.</p>
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
							<div class="mt-3 border-t border-slate-200 pt-3">
								<ColorPalettePicker
									value={selectedElement.color}
									onValueChange={(v: string) => updateElement(selectedElement.id, { color: v })}
									{palette}
									label="Element color"
								/>
							</div>
						{/if}
					</div>

					<div class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Base</div>
						<div class="grid grid-cols-2 gap-1.5">
							{#each [{ id: 'none' as const, label: 'None' }, { id: 'outline' as const, label: 'Outline' }, { id: 'rectangle' as const, label: 'Rectangle' }, { id: 'circle' as const, label: 'Circle' }] as opt (opt.id)}
								<button
									type="button"
									class="rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition {baseMode ===
									opt.id
										? 'border-indigo-300 bg-indigo-50 text-indigo-700'
										: 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'}"
									onclick={() => (baseMode = opt.id)}
								>
									{opt.label}
								</button>
							{/each}
						</div>
						{#if baseMode !== 'none'}
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Padding (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums"
										>{baseParams.padding.toFixed(1)}</span
									>
								</div>
								<Slider
									type="single"
									value={baseParams.padding}
									onValueChange={(v: number) => (baseParams = { ...baseParams, padding: v })}
									min={0}
									max={20}
									step={0.5}
									class="w-full"
								/>
							</label>
							{#if baseMode === 'rectangle'}
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Corner radius</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{baseParams.cornerRadius.toFixed(1)}</span
										>
									</div>
									<Slider
										type="single"
										value={baseParams.cornerRadius}
										onValueChange={(v: number) => (baseParams = { ...baseParams, cornerRadius: v })}
										min={0}
										max={30}
										step={0.5}
										class="w-full"
									/>
								</label>
							{:else if baseMode === 'outline'}
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Outline thickness</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{baseParams.outlineThickness.toFixed(1)}</span
										>
									</div>
									<Slider
										type="single"
										value={baseParams.outlineThickness}
										onValueChange={(v: number) =>
											(baseParams = { ...baseParams, outlineThickness: v })}
										min={0.5}
										max={10}
										step={0.25}
										class="w-full"
									/>
								</label>
							{/if}
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Depth (mm)</span>
									<span class="text-xs text-slate-600 tabular-nums"
										>{baseParams.baseDepth.toFixed(1)}</span
									>
								</div>
								<Slider
									type="single"
									value={baseParams.baseDepth}
									onValueChange={(v: number) => (baseParams = { ...baseParams, baseDepth: v })}
									min={0.6}
									max={10}
									step={0.2}
									class="w-full"
								/>
							</label>
							<ColorPalettePicker
								value={baseParams.baseColor}
								onValueChange={(v: string) => (baseParams = { ...baseParams, baseColor: v })}
								{palette}
								label="Base color"
							/>
						{/if}
					</div>

					{#if baseMode !== 'none'}
						<div class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
							<div class="flex items-center justify-between">
								<div class="text-xs font-semibold tracking-tight text-slate-700">Keyring</div>
								<label class="flex items-center gap-2 text-xs font-medium text-slate-700">
									<input
										type="checkbox"
										class="h-4 w-4 accent-indigo-500"
										checked={keyring.enabled}
										onchange={(e) =>
											(keyring = {
												...keyring,
												enabled: (e.currentTarget as HTMLInputElement).checked
											})}
									/>
									Enabled
								</label>
							</div>
							{#if keyring.enabled}
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Ring size</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{keyring.outerSize.toFixed(1)}</span
										>
									</div>
									<Slider
										type="single"
										value={keyring.outerSize}
										onValueChange={(v: number) => (keyring = { ...keyring, outerSize: v })}
										min={4}
										max={20}
										step={0.5}
										class="w-full"
									/>
								</label>
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Hole size</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{keyring.holeSize.toFixed(1)}</span
										>
									</div>
									<Slider
										type="single"
										value={keyring.holeSize}
										onValueChange={(v: number) => (keyring = { ...keyring, holeSize: v })}
										min={1.5}
										max={Math.max(2, keyring.outerSize - 1)}
										step={0.25}
										class="w-full"
									/>
								</label>
								<div class="flex items-center gap-3">
									<span class="text-xs font-medium text-slate-700">Origin</span>
									<div
										class="grid w-fit grid-cols-3 gap-0.5 rounded-md border border-slate-200 bg-white p-0.5"
										role="radiogroup"
										aria-label="Keyring origin"
									>
										{#each KEYRING_ORIGINS as o (o)}
											{#if o === 'mc'}
												<span aria-hidden="true" class="h-5 w-5"></span>
											{:else}
												<button
													type="button"
													role="radio"
													aria-checked={keyring.origin === o}
													aria-label={originLabel(o)}
													title={originLabel(o)}
													class="grid h-8 w-8 place-items-center rounded text-[11px] leading-none transition {keyring.origin ===
													o
														? 'bg-indigo-500 text-white shadow-sm'
														: 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'}"
													onclick={() => (keyring = { ...keyring, origin: o })}
												>
													{ORIGIN_ARROWS[o]}
												</button>
											{/if}
										{/each}
									</div>
								</div>
								<div class="grid grid-cols-2 gap-3">
									<label class="grid gap-1.5">
										<div class="flex items-center justify-between gap-2">
											<span class="text-xs font-medium text-slate-700">Offset X</span>
											<span class="text-xs text-slate-600 tabular-nums"
												>{keyring.offsetX.toFixed(1)}</span
											>
										</div>
										<Slider
											type="single"
											value={keyring.offsetX}
											onValueChange={(v: number) => (keyring = { ...keyring, offsetX: v })}
											min={-40}
											max={40}
											step={0.5}
											class="w-full"
										/>
									</label>
									<label class="grid gap-1.5">
										<div class="flex items-center justify-between gap-2">
											<span class="text-xs font-medium text-slate-700">Offset Y</span>
											<span class="text-xs text-slate-600 tabular-nums"
												>{keyring.offsetY.toFixed(1)}</span
											>
										</div>
										<Slider
											type="single"
											value={keyring.offsetY}
											onValueChange={(v: number) => (keyring = { ...keyring, offsetY: v })}
											min={-40}
											max={40}
											step={0.5}
											class="w-full"
										/>
									</label>
								</div>
							{/if}
						</div>
					{/if}

					<div class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
						<div class="text-xs font-semibold tracking-tight text-slate-700">
							Per-element thickness
						</div>
						{#if elements.length === 0}
							<p class="text-xs text-slate-500">No elements.</p>
						{:else}
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
											<span class="flex-1 truncate" title={elementLabel(el)}
												>{elementLabel(el)}</span
											>
											<span class="text-slate-500 tabular-nums">{el.depth.toFixed(1)}mm</span>
										</div>
										<Slider
											type="single"
											value={el.depth}
											onValueChange={(v: number) => updateElement(el.id, { depth: v })}
											min={0.4}
											max={8}
											step={0.2}
											class="w-full"
										/>
									</li>
								{/each}
							</ul>
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

					<Button variant="outline" class="w-full" onclick={backToLayout}>← Back to layout</Button>
				{/if}
			</div>
		</aside>

		<!-- Main panel: layout canvas or 3D viewport -->
		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			{#if phase === 'layout'}
				<!-- Konva mounts its `<canvas>` inside this host div. The init
				     effect runs as soon as `canvasHostEl` is bound, sets up the
				     stage, grid/content/UI layers, and the Transformer. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					bind:this={canvasHostEl}
					class="absolute inset-0 touch-none bg-slate-100"
					oncontextmenu={(e) => e.preventDefault()}
				></div>
				<!-- Floating zoom toolbar -->
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
						title="Reset view (100%)"
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
					class="pointer-events-none absolute bottom-3 left-3 rounded-full bg-white/90 px-3 py-1 text-[10px] font-medium text-slate-600 shadow"
				>
					drag empty space or hold space to pan · scroll to zoom · arrows to nudge
				</div>
			{:else}
				<DesignerModelDimensionsHud sizes={modelAabbMm} />
				<div bind:this={threeHostEl} class="absolute inset-0"></div>
				<div
					class="pointer-events-none absolute bottom-3 left-3 max-w-[min(100%,18rem)] rounded-full bg-white/90 px-3 py-1.5 text-[10px] font-medium leading-snug text-slate-600 shadow"
				>
					Click an element (quick tap, not a drag) to select — indigo outline · change
					<strong class="font-semibold">Element color</strong> in the sidebar
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
