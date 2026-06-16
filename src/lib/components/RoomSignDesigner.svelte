<script lang="ts">
	import { type PaletteColor } from '$lib/colorPalette';
	import FontSelect from '$lib/components/FontSelect.svelte';
	import RoomSignStyleSelect from '$lib/components/RoomSignStyleSelect.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Slider } from '$lib/components/ui/slider';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { notifyExportEvent } from '$lib/exportNotify';
	import {
		cloneDefaultRoomSignPresetsAsCustom,
		DEFAULT_ROOM_SIGN_COLOR_PRESETS,
		isCustomRoomSignPresetId,
		loadUserRoomSignPresets,
		persistRoomSignCustomPresets,
		type RoomSignColorPreset
	} from '$lib/roomSignPresets';
	import {
		buildAlignedRoomSignLayers,
		loadStlGeometry,
		ROOM_SIGN_VIEWBOX,
		scaleGeometryToDepth
	} from '$lib/roomSignStl';
	import {
		DEFAULT_ROOM_SIGN_STYLE_ID,
		isRoomSignStyleId,
		ROOM_SIGN_STYLES,
		roomSignStyleOffsetYMm,
		type RoomSignStyleId
	} from '$lib/roomSignStyles';
	import { ensureExportAccess, getExportTitle, showExportLockIcon, type SubscriptionStatus } from '$lib/subscription';
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
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';

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

	const STORAGE_KEY = 'keychain-room-sign-settings';
	const DESIGN_NAME = 'Room Sign';
	const SLUG = 'room-sign';
	/** Vertical gap between base and decor so faces do not touch (avoids coplanar / non-manifold). */
	const LAYER_GAP = 0.001;
	const WELD_TOL_MM = 1e-3;
	const FONT_SIZE_FOR_SHAPES = 12;
	const TEXT_MAX_WIDTH_RATIO = 0.72;
	const TEXT_MAX_HEIGHT_RATIO = 0.22;
	const TEXT_HEIGHT_MIN_MM = 6;
	const TEXT_HEIGHT_STEP_MM = 0.5;
	const DEFAULT_FONT_KEY = FONT_OPTIONS[0]?.key ?? 'Titan One_Regular';

	function maxTextHeightMmForWidth(widthMm: number): number {
		const planH = widthMm * (ROOM_SIGN_VIEWBOX.height / ROOM_SIGN_VIEWBOX.width);
		return planH * TEXT_MAX_HEIGHT_RATIO;
	}

	interface RoomSignSettings {
		styleId: RoomSignStyleId;
		textContent: string;
		textFontKey: string;
		textHeightMm: number;
		textDepth: number;
		baseColor: string;
		decorColor: string;
		textColor: string;
		targetWidthMm: number;
		baseDepth: number;
		decorDepth: number;
	}

	const defaults: RoomSignSettings = {
		styleId: DEFAULT_ROOM_SIGN_STYLE_ID,
		textContent: "LIBBY'S ROOM",
		textFontKey: DEFAULT_FONT_KEY,
		textHeightMm: maxTextHeightMmForWidth(80),
		textDepth: 1.2,
		baseColor: '#db2777',
		decorColor: '#fce7f3',
		textColor: '#ffffff',
		targetWidthMm: 150,
		baseDepth: 2,
		decorDepth: 1
	};

	function clamp(n: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, n));
	}

	function loadSettings(): RoomSignSettings {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return { ...defaults };
			const parsed = JSON.parse(raw) as Partial<RoomSignSettings> & { textSize?: number };
			if (!parsed || typeof parsed !== 'object') return { ...defaults };
			const fontKey =
				typeof parsed.textFontKey === 'string' &&
				FONT_OPTIONS.some((f) => f.key === parsed.textFontKey)
					? parsed.textFontKey
					: defaults.textFontKey;
			const widthMm =
				typeof parsed.targetWidthMm === 'number' && Number.isFinite(parsed.targetWidthMm)
					? clamp(parsed.targetWidthMm, 80, 280)
					: defaults.targetWidthMm;
			const heightMax = maxTextHeightMmForWidth(widthMm);
			const legacyTextSize =
				typeof parsed.textSize === 'number' && Number.isFinite(parsed.textSize)
					? parsed.textSize
					: null;
			const textHeightMm =
				typeof parsed.textHeightMm === 'number' && Number.isFinite(parsed.textHeightMm)
					? clamp(parsed.textHeightMm, TEXT_HEIGHT_MIN_MM, heightMax)
					: legacyTextSize !== null
						? clamp(legacyTextSize * heightMax, TEXT_HEIGHT_MIN_MM, heightMax)
						: defaults.textHeightMm;
			const styleId =
				typeof parsed.styleId === 'string' && isRoomSignStyleId(parsed.styleId)
					? parsed.styleId
					: defaults.styleId;
			return {
				styleId,
				textContent:
					typeof parsed.textContent === 'string' ? parsed.textContent : defaults.textContent,
				textFontKey: fontKey,
				textHeightMm,
				textDepth:
					typeof parsed.textDepth === 'number' && Number.isFinite(parsed.textDepth)
						? clamp(parsed.textDepth, 0.2, 5)
						: defaults.textDepth,
				baseColor:
					typeof parsed.baseColor === 'string' ? parsed.baseColor : defaults.baseColor,
				decorColor:
					typeof parsed.decorColor === 'string' ? parsed.decorColor : defaults.decorColor,
				textColor:
					typeof parsed.textColor === 'string' ? parsed.textColor : defaults.textColor,
				targetWidthMm: widthMm,
				baseDepth:
					typeof parsed.baseDepth === 'number' && Number.isFinite(parsed.baseDepth)
						? clamp(parsed.baseDepth, 1, 12)
						: defaults.baseDepth,
				decorDepth:
					typeof parsed.decorDepth === 'number' && Number.isFinite(parsed.decorDepth)
						? clamp(parsed.decorDepth, 0.3, 6)
						: defaults.decorDepth
			};
		} catch {
			return { ...defaults };
		}
	}

	const initial = loadSettings();

	let styleId = $state(initial.styleId);
	let textContent = $state(initial.textContent);
	let textFontKey = $state(initial.textFontKey);
	let textHeightMm = $state(initial.textHeightMm);
	let textDepth = $state(initial.textDepth);
	let baseColor = $state(initial.baseColor);
	let decorColor = $state(initial.decorColor);
	let textColor = $state(initial.textColor);
	let targetWidthMm = $state(initial.targetWidthMm);
	const textHeightMaxMm = $derived(maxTextHeightMmForWidth(targetWidthMm));
	let baseDepth = $state(initial.baseDepth);
	let decorDepth = $state(initial.decorDepth);

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

	let baseGeoUnit = $state<THREE.BufferGeometry | null>(null);
	let decorGeoUnit = $state<THREE.BufferGeometry | null>(null);
	let baseStlSource: THREE.BufferGeometry | null = null;
	let decorStlSource: THREE.BufferGeometry | null = null;
	let loadError = $state<string | null>(null);
	let sceneInitialized = $state(false);
	let modelReady = $state(false);
	let loadedStyleId = $state<RoomSignStyleId | null>(null);
	let stlLoadToken = 0;
	let geoBuildToken = 0;

	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);

	let activePresetId = $state<string | null>(null);
	let customPresets = $state<RoomSignColorPreset[]>([]);
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
	let presetEditorBase = $state('#db2777');
	let presetEditorDecor = $state('#fce7f3');
	let presetEditorText = $state('#ffffff');

	function saveSettings() {
		try {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					styleId,
					textContent,
					textFontKey,
					textHeightMm,
					textDepth,
					baseColor,
					decorColor,
					textColor,
					targetWidthMm,
					baseDepth,
					decorDepth
				})
			);
		} catch {
			/* localStorage may be unavailable */
		}
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

	function disposeUnitGeometries() {
		baseGeoUnit?.dispose();
		decorGeoUnit?.dispose();
		baseGeoUnit = null;
		decorGeoUnit = null;
	}

	function disposeStlSources() {
		baseStlSource?.dispose();
		decorStlSource?.dispose();
		baseStlSource = null;
		decorStlSource = null;
	}

	async function loadRoomSignStyle(style: RoomSignStyleId) {
		const token = ++stlLoadToken;
		const prevBaseGeo = baseGeoUnit;
		const prevDecorGeo = decorGeoUnit;
		const prevBaseStl = baseStlSource;
		const prevDecorStl = decorStlSource;
		modelReady = false;
		loadError = null;
		loadedStyleId = null;

		const assets = ROOM_SIGN_STYLES[style];
		const loader = new STLLoader();
		try {
			const [baseStl, decorStl] = await Promise.all([
				loadStlGeometry(loader, assets.baseStlUrl),
				loadStlGeometry(loader, assets.decorStlUrl)
			]);
			if (token !== stlLoadToken) {
				baseStl.dispose();
				decorStl.dispose();
				return;
			}
			prevBaseGeo?.dispose();
			prevDecorGeo?.dispose();
			prevBaseStl?.dispose();
			prevDecorStl?.dispose();
			baseStlSource = baseStl;
			decorStlSource = decorStl;
			loadedStyleId = style;

			const { baseUnit, decorUnit } = buildAlignedRoomSignLayers({
				baseStl: baseStlSource,
				decorStl: decorStlSource,
				targetWidthMm
			});
			if (!baseUnit) {
				loadError = 'Could not prepare room sign geometry';
				return;
			}
			baseGeoUnit = baseUnit;
			decorGeoUnit = decorUnit;
			modelReady = true;
			didInitFrame = false;
			if (scene && group) rebuildMeshes();
		} catch (e) {
			if (token !== stlLoadToken) return;
			loadError = e instanceof Error ? e.message : 'Failed to load room sign STL';
		}
	}

	async function rebuildSourceGeometries() {
		const token = ++geoBuildToken;
		await tickThenYieldToPaint();
		if (token !== geoBuildToken) return;
		if (!baseStlSource) return;

		disposeUnitGeometries();
		loadError = null;
		try {
			const { baseUnit, decorUnit } = buildAlignedRoomSignLayers({
				baseStl: baseStlSource,
				decorStl: decorStlSource,
				targetWidthMm
			});
			if (token !== geoBuildToken) {
				baseUnit?.dispose();
				decorUnit?.dispose();
				return;
			}
			if (!baseUnit) {
				loadError = 'Could not prepare room sign geometry';
				return;
			}
			baseGeoUnit = baseUnit;
			decorGeoUnit = decorUnit;
			if (modelReady) rebuildMeshes();
		} catch (e) {
			if (token !== geoBuildToken) return;
			loadError = e instanceof Error ? e.message : 'Failed to prepare room sign geometry';
		}
	}

	function cleanExportGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
		const g = geo.clone();
		if (g.getAttribute('uv')) g.deleteAttribute('uv');
		if (!g.getAttribute('normal')) g.computeVertexNormals();
		if (g.index) {
			const nonIndexed = g.toNonIndexed();
			g.dispose();
			return nonIndexed;
		}
		return g;
	}

	function rebuildMeshes() {
		if (!scene || !group || !baseGeoUnit) {
			modelAabbMm = null;
			return;
		}
		try {
			rebuildMeshesInner();
		} catch (e) {
			console.error('Room Sign mesh rebuild failed:', e);
			loadError = e instanceof Error ? e.message : 'Failed to build 3D model';
			modelAabbMm = null;
		}
	}

	function rebuildMeshesInner() {
		if (!scene || !group || !baseGeoUnit) {
			modelAabbMm = null;
			return;
		}
		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		modelAabbMm = null;

		const baseD = Math.max(0.1, baseDepth);
		const decorD = Math.max(0.1, decorDepth);
		const textD = Math.max(0.1, textDepth);
		const styleOffsetY = roomSignStyleOffsetYMm(styleId, targetWidthMm);
		const baseTopZ = baseD;
		/** Decor sits above the base with a gap — not embedded into the plaque. */
		const decorLayerZ = baseTopZ + LAYER_GAP;
		/** Text shares the decor layer plane (name field), not stacked above the ornament. */
		const textLayerZ = decorGeoUnit ? decorLayerZ : baseTopZ;

		const baseMat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.85,
			metalness: 0.05,
			side: THREE.DoubleSide
		});
		const decorMat = new THREE.MeshStandardMaterial({
			color: decorColor,
			roughness: 0.35,
			metalness: 0.1,
			side: THREE.DoubleSide
		});

		const baseGeo = scaleGeometryToDepth(baseGeoUnit, baseD);
		const baseMesh = new THREE.Mesh(baseGeo, baseMat);
		baseMesh.name = 'base';
		baseMesh.castShadow = true;
		baseMesh.receiveShadow = true;
		baseMesh.position.set(0, styleOffsetY, 0);
		group.add(baseMesh);

		// Text fit area from plaque width — not base bbox (stroke thickness would rescale text).
		const planW = targetWidthMm;
		const planH = targetWidthMm * (ROOM_SIGN_VIEWBOX.height / ROOM_SIGN_VIEWBOX.width);

		if (decorGeoUnit) {
			const decorGeo = scaleGeometryToDepth(decorGeoUnit, decorD);
			const decorMesh = new THREE.Mesh(decorGeo, decorMat);
			decorMesh.name = 'decor';
			decorMesh.castShadow = true;
			decorMesh.receiveShadow = true;
			decorMesh.position.set(0, styleOffsetY, decorLayerZ);
			group.add(decorMesh);
		}

		const content = (textContent ?? '').trim();
		if (content) {
			const font = getFont(textFontKey);
			if (font) {
				const shapes = font.generateShapes(content, FONT_SIZE_FOR_SHAPES);
				if (shapes.length > 0) {
					const textGeo = new THREE.ExtrudeGeometry(shapes, {
						depth: textD,
						bevelEnabled: false
					});
					centerGeometryXY(textGeo);
					const textMat = new THREE.MeshStandardMaterial({
						color: textColor,
						roughness: 0.35,
						metalness: 0.1,
						side: THREE.DoubleSide
					});
					textGeo.computeBoundingBox();
					const tb = textGeo.boundingBox;
					const textW = tb && tb.max.x > tb.min.x ? tb.max.x - tb.min.x : 1;
					const textH = tb && tb.max.y > tb.min.y ? tb.max.y - tb.min.y : 1;
					const targetW = planW * TEXT_MAX_WIDTH_RATIO;
					const scale = textHeightMm / textH;
					const scaleCap = targetW / textW;
					const scaleCapped = Math.min(scale, scaleCap);
					if (tb) textGeo.translate(0, 0, -tb.min.z);
					const textMesh = new THREE.Mesh(textGeo, textMat);
					textMesh.name = 'text';
					textMesh.scale.set(scaleCapped, scaleCapped, 1);
					textMesh.castShadow = true;
					textMesh.receiveShadow = true;
					textMesh.position.set(0, styleOffsetY, textLayerZ);
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

	function buildExportGroup(): THREE.Group {
		if (!group) throw new Error('Scene not ready');
		rebuildMeshes();
		group.updateWorldMatrix(true, true);
		const exportGroup = new THREE.Group();
		for (const child of group.children) {
			if (!(child as THREE.Mesh).isMesh) continue;
			const mesh = child as THREE.Mesh;
			const geo = cleanExportGeometry(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
			const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
			const color = mat?.color?.clone() ?? new THREE.Color(0xffffff);
			const exportMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
			exportMesh.name = mesh.name;
			exportGroup.add(exportMesh);
		}
		exportGroup.updateWorldMatrix(true, true);
		return exportGroup;
	}

	async function exportStl() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		if (!group) {
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
				geometries.push(
					(child as THREE.Mesh).geometry.clone().applyMatrix4(child.matrixWorld)
				);
			}
			if (geometries.length === 0) {
				disposeObject3D(exportGroup);
				exportError = 'Nothing to export';
				return;
			}
			const merged =
				geometries.length === 1 ? geometries[0] : BufferGeometryUtils.mergeGeometries(geometries);
			if (geometries.length > 1) geometries.forEach((g) => g.dispose());
			if (!merged) {
				disposeObject3D(exportGroup);
				exportError = 'Failed to merge geometry';
				return;
			}
			const welded = BufferGeometryUtils.mergeVertices(merged, WELD_TOL_MM);
			if (welded !== merged) merged.dispose();
			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
			welded.dispose();
			disposeObject3D(exportGroup);
			const buffer = result instanceof DataView ? result.buffer : result;
			if (!buffer || (buffer as ArrayBuffer).byteLength < 84) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const safe = (textContent || 'room-sign')
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)/g, '');
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${safe || 'room-sign'}-${styleId}-${ts}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				designerId: 'roomSign',
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
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`room-sign-${styleId}-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				designerId: 'roomSign',
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
			const publicUrl = await upload3mfToSupabase(blob, 'room-sign');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				designerId: 'roomSign',
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			openBambuStudioLoading = false;
		}
	}

	function normalizePresetHex(value: string, fallback: string): string {
		const c = value.trim();
		if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
		if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
		return fallback;
	}

	function findMatchingPresetId(presets: RoomSignColorPreset[]): string | null {
		for (const preset of presets) {
			if (
				preset.baseColor === baseColor &&
				preset.decorColor === decorColor &&
				preset.textColor === textColor
			) {
				return preset.id;
			}
		}
		return null;
	}

	function applyColorPreset(preset: RoomSignColorPreset) {
		baseColor = preset.baseColor;
		decorColor = preset.decorColor;
		textColor = preset.textColor;
		activePresetId = preset.id;
	}

	function setPresetEditorColors(base: string, decor: string, text: string) {
		presetEditorBase = normalizePresetHex(base, '#db2777');
		presetEditorDecor = normalizePresetHex(decor, '#fce7f3');
		presetEditorText = normalizePresetHex(text, '#ffffff');
	}

	function openCreatePresetEditor() {
		presetEditorMode = 'create';
		presetEditorId = null;
		presetEditorLabel = 'My preset';
		setPresetEditorColors(baseColor, decorColor, textColor);
		presetEditorOpen = true;
	}

	function openEditPresetEditor(preset: RoomSignColorPreset) {
		presetEditorMode = 'edit';
		presetEditorId = preset.id;
		presetEditorLabel = preset.label;
		setPresetEditorColors(preset.baseColor, preset.decorColor, preset.textColor);
		presetEditorOpen = true;
	}

	function closePresetEditor() {
		presetEditorOpen = false;
		presetEditorId = null;
	}

	function onPresetEditorOpenChange(open: boolean) {
		if (!open) closePresetEditor();
	}

	async function persistCustomPresets(presets: RoomSignColorPreset[]) {
		if (!user?.id) return;
		const result = await persistRoomSignCustomPresets(user.id, presets);
		if (!result.success) {
			presetSyncError = result.error;
			return;
		}
		presetSyncError = null;
	}

	async function commitPresetEditor() {
		const label = presetEditorLabel.trim() || 'My preset';
		const base = normalizePresetHex(presetEditorBase, '#db2777');
		const decor = normalizePresetHex(presetEditorDecor, '#fce7f3');
		const text = normalizePresetHex(presetEditorText, '#ffffff');

		if (presetEditorMode === 'edit' && presetEditorId) {
			customPresets = customPresets.map((p) =>
				p.id === presetEditorId ? { id: p.id, label, baseColor: base, decorColor: decor, textColor: text } : p
			);
			activePresetId = presetEditorId;
		} else {
			const id = `custom-${crypto.randomUUID()}`;
			customPresets = [...customPresets, { id, label, baseColor: base, decorColor: decor, textColor: text }];
			activePresetId = id;
		}

		baseColor = base;
		decorColor = decor;
		textColor = text;
		await persistCustomPresets(customPresets);
		closePresetEditor();
	}

	async function deleteCustomPreset(id: string) {
		if (!isCustomRoomSignPresetId(id)) return;
		customPresets = customPresets.filter((p) => p.id !== id);
		await persistCustomPresets(customPresets);
		if (activePresetId === id) activePresetId = findMatchingPresetId(galleryPresets);
		closePresetEditor();
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
			customPresets = await loadUserRoomSignPresets(userId);
			activePresetId = findMatchingPresetId(galleryPresets);
		} catch (e) {
			presetSyncError = e instanceof Error ? e.message : 'Failed to load presets';
		} finally {
			customPresetsLoading = false;
		}
	}

	async function importDefaultPresets() {
		if (!user?.id) {
			onRequestLogin();
			return;
		}
		importPresetsLoading = true;
		presetSyncError = null;
		try {
			customPresets = cloneDefaultRoomSignPresetsAsCustom();
			await persistCustomPresets(customPresets);
			activePresetId = null;
		} catch (e) {
			presetSyncError = e instanceof Error ? e.message : 'Failed to import presets';
		} finally {
			importPresetsLoading = false;
		}
	}

	onMount(() => {
		void (async () => {
			await tick();
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
			sceneInitialized = true;

			const renderLoop = () => {
				rafId = requestAnimationFrame(renderLoop);
				controls?.update();
				renderer?.render(scene!, camera!);
			};
			renderLoop();
		})();

		return () => {
			ro?.disconnect();
			ro = null;
		};
	});

	$effect(() => {
		if (!sceneInitialized) return;
		const style = styleId;
		if (loadedStyleId === style) return;
		untrack(() => void loadRoomSignStyle(style));
	});

	$effect(() => {
		void styleId;
		void textContent;
		void textFontKey;
		void textHeightMm;
		void textDepth;
		void baseColor;
		void decorColor;
		void textColor;
		void targetWidthMm;
		void baseDepth;
		void decorDepth;
		saveSettings();
	});

	$effect(() => {
		void targetWidthMm;
		const maxHeight = textHeightMaxMm;
		if (textHeightMm > maxHeight) textHeightMm = maxHeight;
	});

	$effect(() => {
		void targetWidthMm;
		if (!modelReady || !baseStlSource || loadedStyleId !== styleId) return;
		untrack(() => void rebuildSourceGeometries());
	});

	$effect(() => {
		void styleId;
		void textContent;
		void textFontKey;
		void textHeightMm;
		void baseColor;
		void decorColor;
		void textColor;
		void baseDepth;
		void decorDepth;
		void textDepth;
		void baseGeoUnit;
		void decorGeoUnit;
		if (!scene || !group || !modelReady) return;
		rebuildMeshes();
	});

	$effect(() => {
		const userId = user?.id ?? null;
		void userId;
		void syncCustomPresetsFromAccount();
	});

	$effect(() => {
		void baseColor;
		void decorColor;
		void textColor;
		activePresetId = findMatchingPresetId(galleryPresets);
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		rafId = 0;
		ro?.disconnect();
		ro = null;
		disposeUnitGeometries();
		disposeStlSources();
		if (group) {
			disposeObject3D(group);
			group.clear();
		}
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
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full max-w-[360px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">{DESIGN_NAME}</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 pt-0 space-y-4">
				<p class="text-xs text-slate-500">
					Decorative room plaque with raised border flourishes and centered text.
				</p>

				{#if loadError}
					<p class="text-sm text-red-600">{loadError}</p>
				{:else if !baseGeoUnit}
					<p class="text-sm text-slate-500">Building 3D model…</p>
				{/if}

				<div class="flex items-center gap-2">
					<span class="shrink-0 text-xs font-medium text-slate-700">Style</span>
					<RoomSignStyleSelect id="room-sign-style" bind:value={styleId} />
				</div>

				<div>
					<label for="room-sign-text" class="mb-1 block text-xs font-medium text-slate-700">
						Text
					</label>
					<input
						id="room-sign-text"
						type="text"
						placeholder="LIBBY'S ROOM"
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
						bind:value={textContent}
					/>
				</div>

				<div>
					<label for="room-sign-font" class="mb-1 block text-xs font-medium text-slate-700">
						Font
					</label>
					<FontSelect id="room-sign-font" bind:value={textFontKey} />
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="room-sign-text-height" class="text-xs font-medium text-slate-700">
							Text height
						</label>
						<span class="text-xs text-slate-500 tabular-nums">{textHeightMm.toFixed(1)} mm</span>
					</div>
					<Slider
						id="room-sign-text-height"
						type="single"
						bind:value={textHeightMm}
						min={TEXT_HEIGHT_MIN_MM}
						max={textHeightMaxMm}
						step={TEXT_HEIGHT_STEP_MM}
						class="w-full"
					/>
				</div>

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<p class="text-xs font-semibold tracking-tight text-slate-700">Colors</p>
					<ColorPalettePicker bind:value={baseColor} {palette} label="Base" />
					<ColorPalettePicker bind:value={decorColor} {palette} label="Decor" />
					<ColorPalettePicker bind:value={textColor} {palette} label="Text" />
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="room-sign-width" class="text-xs font-medium text-slate-700">
							Width (mm)
						</label>
						<span class="text-xs text-slate-500">{targetWidthMm.toFixed(0)}</span>
					</div>
					<Slider
						id="room-sign-width"
						type="single"
						bind:value={targetWidthMm}
						min={80}
						max={280}
						step={1}
						class="w-full"
					/>
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="room-sign-base-depth" class="text-xs font-medium text-slate-700">
							Base depth (mm)
						</label>
						<span class="text-xs text-slate-500">{baseDepth.toFixed(1)}</span>
					</div>
					<Slider
						id="room-sign-base-depth"
						type="single"
						bind:value={baseDepth}
						min={1}
						max={12}
						step={0.1}
						class="w-full"
					/>
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="room-sign-decor-depth" class="text-xs font-medium text-slate-700">
							Decor depth (mm)
						</label>
						<span class="text-xs text-slate-500">{decorDepth.toFixed(1)}</span>
					</div>
					<Slider
						id="room-sign-decor-depth"
						type="single"
						bind:value={decorDepth}
						min={0.3}
						max={6}
						step={0.1}
						class="w-full"
					/>
				</div>

				<div class="grid gap-2 rounded-2xl border border-violet-200/80 bg-violet-50/50 p-3">
					<p class="text-xs font-semibold tracking-tight text-slate-800">Preset gallery</p>

					{#if user}
						<p class="text-[11px] text-slate-500">
							{#if hasGalleryPresets}
								Click a preset to apply its colors. Edit or delete any preset. Saved to your
								account.
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
								Import default presets to get {DEFAULT_ROOM_SIGN_COLOR_PRESETS.length} editable
								color combos, or use + New to add one.
							</p>
						{/if}

						<div class="grid grid-cols-3 gap-2">
							{#each galleryPresets as preset (preset.id)}
								<div class="relative h-20">
									<button
										type="button"
										class={[
											'flex h-full w-full flex-col overflow-hidden rounded-lg border bg-white pr-6 text-left shadow-sm transition hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60',
											activePresetId === preset.id
												? 'border-indigo-400 ring-2 ring-indigo-400/30'
												: 'border-slate-200/90 hover:border-slate-300'
										].join(' ')}
										aria-pressed={activePresetId === preset.id}
										aria-label={`Apply ${preset.label} colors`}
										onclick={() => applyColorPreset(preset)}
									>
										<div class="flex h-11 w-full shrink-0">
											<span
												class="min-w-0 flex-1"
												style:background-color={preset.baseColor}
												aria-hidden="true"
											></span>
											<span
												class="min-w-0 flex-1 border-x border-white/20"
												style:background-color={preset.decorColor}
												aria-hidden="true"
											></span>
											<span
												class="min-w-0 flex-1"
												style:background-color={preset.textColor}
												aria-hidden="true"
											></span>
										</div>
										<span
											class="flex h-9 shrink-0 items-center border-t border-slate-100 px-1"
											title={preset.label}
										>
											<span
												class="line-clamp-2 w-full text-center text-[10px] font-medium leading-tight text-slate-700"
											>
												{preset.label}
											</span>
										</span>
									</button>
									<button
										type="button"
										class="absolute right-0.5 top-0.5 rounded bg-white/90 px-1 py-0.5 text-[9px] font-medium text-slate-600 shadow-sm hover:bg-white hover:text-indigo-700"
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
							Save and reuse color combinations for your room sign. Import
							{DEFAULT_ROOM_SIGN_COLOR_PRESETS.length} starter presets, create your own, and edit
							or delete them anytime — all synced to your account.
						</p>
						<Button type="button" size="sm" class="w-full" onclick={onRequestLogin}>
							Sign in to use presets
						</Button>
						<p class="text-[10px] font-medium uppercase tracking-wide text-slate-500">
							Starter presets (preview)
						</p>
						<div class="grid grid-cols-3 gap-2 opacity-90" aria-hidden="true">
							{#each DEFAULT_ROOM_SIGN_COLOR_PRESETS as template (template.label)}
								<div
									class="flex h-20 flex-col overflow-hidden rounded-lg border border-slate-200/90 bg-white shadow-sm"
								>
									<div class="flex h-11 w-full shrink-0">
										<span
											class="min-w-0 flex-1"
											style:background-color={template.baseColor}
										></span>
										<span
											class="min-w-0 flex-1 border-x border-white/20"
											style:background-color={template.decorColor}
										></span>
										<span
											class="min-w-0 flex-1"
											style:background-color={template.textColor}
										></span>
									</div>
									<span
										class="flex h-9 shrink-0 items-center border-t border-slate-100 px-1"
										title={template.label}
									>
										<span
											class="line-clamp-2 w-full text-center text-[10px] font-medium leading-tight text-slate-600"
										>
											{template.label}
										</span>
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
			<div class="absolute bottom-4 right-4">
				<DesignerExportToolbar
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, SLUG)}
					onExport={() => exportStl()}
					onExport3MF={() => export3MF()}
					onOpenWithBambuStudio={() => openWithBambuStudio()}
					{openBambuStudioLoading}
					exportDisabled={exportLoading || !!loadError || !baseGeoUnit}
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
						class="absolute bottom-14 right-4 max-w-[200px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg"
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
							Save the current room sign colors as a reusable preset.
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
					<label class="grid gap-1.5">
						<span class="text-xs font-medium text-slate-700">Base</span>
						<div class="flex items-center gap-2">
							<input
								type="color"
								class="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-slate-200 bg-white p-0.5"
								bind:value={presetEditorBase}
							/>
							<input
								type="text"
								class="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
								bind:value={presetEditorBase}
								maxlength={7}
								placeholder="#db2777"
							/>
						</div>
					</label>
					<label class="grid gap-1.5">
						<span class="text-xs font-medium text-slate-700">Decor</span>
						<div class="flex items-center gap-2">
							<input
								type="color"
								class="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-slate-200 bg-white p-0.5"
								bind:value={presetEditorDecor}
							/>
							<input
								type="text"
								class="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
								bind:value={presetEditorDecor}
								maxlength={7}
								placeholder="#fce7f3"
							/>
						</div>
					</label>
					<label class="grid gap-1.5">
						<span class="text-xs font-medium text-slate-700">Text</span>
						<div class="flex items-center gap-2">
							<input
								type="color"
								class="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-slate-200 bg-white p-0.5"
								bind:value={presetEditorText}
							/>
							<input
								type="text"
								class="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
								bind:value={presetEditorText}
								maxlength={7}
								placeholder="#ffffff"
							/>
						</div>
					</label>
					<p class="text-[11px] text-slate-500">
						Presets keep your exact hex colors — not limited to the filament palette.
					</p>
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
