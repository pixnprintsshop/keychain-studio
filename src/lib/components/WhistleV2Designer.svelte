<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import whistleClassicObjUrl from '$lib/assets/stl/whistle/classic.obj?url';
	import whistleModernObjUrl from '$lib/assets/stl/whistle/modern.obj?url';
	import FontSelect from '$lib/components/FontSelect.svelte';
	import {
		centerGeometryXY,
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		frameCameraToObject,
		getFont,
		makeKeyringGeometry,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Slider } from '$lib/components/ui/slider';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import { snapColorToPalette, type PaletteColor } from '$lib/colorPalette';
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import {
		cloneDefaultWhistleV2PresetsAsCustom,
		DEFAULT_WHISTLE_V2_COLOR_PRESETS,
		isCustomWhistleV2PresetId,
		loadUserWhistleV2Presets,
		persistWhistleV2CustomPresets,
		type WhistleV2ColorPreset
	} from '$lib/whistleV2Presets';

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

	type WhistlePartKey = 'accent' | 'main' | 'border';
	type WhistleStyleId = 'modern' | 'classic';

	/** group_0 → Border, group_1 → Main, group_2 → Accent (embossed top for text) */
	const PART_ORDER: WhistlePartKey[] = ['border', 'main', 'accent'];

	const WHISTLE_STYLES: Record<
		WhistleStyleId,
		{ label: string; objUrl: string; textOffsetX: number; textOffsetY: number }
	> = {
		modern: {
			label: 'Modern',
			objUrl: whistleModernObjUrl,
			textOffsetX: 4.5,
			textOffsetY: 0
		},
		classic: {
			label: 'Classic',
			objUrl: whistleClassicObjUrl,
			textOffsetX: 0,
			textOffsetY: 0
		}
	};

	const FONT_SIZE_FOR_SHAPES = 12;
	const TARGET_TEXT_HEIGHT_MM = 10;
	const TEXT_DEPTH_MM = 1;
	const TEXT_SURFACE_EMBED = 0.02;
	/** Modern assembly width — keeps letter scale consistent when switching styles. */
	const TEXT_FIT_REFERENCE_WIDTH_MM = 60.89;

	/** Hollow ring: 25 mm OD, 2 mm wall → 21 mm ID, 2 mm tall (extruded along Z). */
	const KEYRING_OUTER_DIAMETER_MM = 25;
	const KEYRING_WALL_THICKNESS_MM = 2;
	const KEYRING_HEIGHT_MM = 2;
	const KEYRING_INNER_DIAMETER_MM =
		KEYRING_OUTER_DIAMETER_MM - 2 * KEYRING_WALL_THICKNESS_MM;
	const KEYRING_POSITION = { x: -33.7, y: 11.3, z: 3 };
	const KEYRING_ROTATION_Z_DEG = 0;
	const KEYRING_SILVER_COLOR = 0xc0c0c0;
	const KEYRING_MESH_NAME = 'keyring';

	const STORAGE_KEY = 'keychain-whistle-v2-settings';
	const DEFAULT_BORDER_COLOR = '#1f2937';
	const DEFAULT_ACCENT_COLOR = '#eab308';

	type WhistleColorPreset = WhistleV2ColorPreset;

	interface WhistleV2Settings {
		whistleStyle: WhistleStyleId;
		textContent: string;
		fontKey: string;
		textScale: number;
		accentColor: string;
		mainColor: string;
		borderColor: string;
		textColor: string;
		showBorder: boolean;
	}

	const defaults: WhistleV2Settings = {
		whistleStyle: 'modern',
		textContent: 'Name',
		fontKey: FONT_OPTIONS[0]?.key ?? 'Titan One_Regular',
		textScale: 1,
		accentColor: DEFAULT_ACCENT_COLOR,
		mainColor: '#f97316',
		borderColor: DEFAULT_BORDER_COLOR,
		textColor: DEFAULT_BORDER_COLOR,
		showBorder: true
	};

	function clamp(n: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, n));
	}

	function loadSettings(): WhistleV2Settings {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return { ...defaults };
			const parsed = JSON.parse(stored) as Partial<WhistleV2Settings>;
			if (!parsed || typeof parsed !== 'object') return { ...defaults };
			const fontKey =
				typeof parsed.fontKey === 'string' &&
				FONT_OPTIONS.some((option) => option.key === parsed.fontKey)
					? parsed.fontKey
					: defaults.fontKey;
			const whistleStyle: WhistleStyleId =
				parsed.whistleStyle === 'classic' || parsed.whistleStyle === 'modern'
					? parsed.whistleStyle
					: defaults.whistleStyle;
			return {
				whistleStyle,
				textContent:
					typeof parsed.textContent === 'string'
						? parsed.textContent
						: defaults.textContent,
				fontKey,
				textScale:
					typeof parsed.textScale === 'number' && Number.isFinite(parsed.textScale)
						? clamp(parsed.textScale, 0.3, 2)
						: defaults.textScale,
				accentColor:
					typeof parsed.accentColor === 'string' ? parsed.accentColor : defaults.accentColor,
				mainColor:
					typeof parsed.mainColor === 'string' ? parsed.mainColor : defaults.mainColor,
				borderColor:
					typeof parsed.borderColor === 'string' ? parsed.borderColor : defaults.borderColor,
				textColor:
					typeof parsed.textColor === 'string' ? parsed.textColor : defaults.textColor,
				showBorder:
					typeof parsed.showBorder === 'boolean' ? parsed.showBorder : defaults.showBorder
			};
		} catch {
			return { ...defaults };
		}
	}

	const initial = loadSettings();

	function saveSettings() {
		try {
			const payload: WhistleV2Settings = {
				whistleStyle,
				textContent,
				fontKey,
				textScale,
				accentColor,
				mainColor,
				borderColor,
				textColor,
				showBorder
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
	let envMap: THREE.Texture | null = null;
	let pmremGenerator: THREE.PMREMGenerator | null = null;
	let rafId = 0;
	let ro: ResizeObserver | null = null;
	let didInitFrame = false;
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);

	let partGeometries = $state<Record<WhistlePartKey, THREE.BufferGeometry> | null>(null);
	let loadError = $state<string | null>(null);
	/** True once Three.js scene + group exist (not waiting on OBJ). */
	let sceneInitialized = $state(false);
	let sceneReady = $state(false);
	let loadToken = 0;
	let loadedWhistleStyle = $state<WhistleStyleId | null>(null);

	let whistleStyle = $state<WhistleStyleId>(initial.whistleStyle);

	let textContent = $state(initial.textContent);
	let fontKey = $state(initial.fontKey);
	let textScale = $state(initial.textScale);
	let accentColor = $state(initial.accentColor);
	let mainColor = $state(initial.mainColor);
	let borderColor = $state(initial.borderColor);
	let textColor = $state(initial.textColor);
	let showBorder = $state(initial.showBorder);
	let activePresetId = $state<string | null>(null);
	let customPresets = $state<WhistleColorPreset[]>([]);
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
	let presetEditorMain = $state('#f97316');
	let presetEditorAccent = $state('#eab308');
	let presetEditorBorder = $state('#1f2937');
	let presetEditorText = $state('#1f2937');

	function snapPresetColors(main: string, accent: string, border: string, text: string) {
		return {
			main: snapColorToPalette(main, palette, mainColor),
			accent: snapColorToPalette(accent, palette, accentColor),
			border: snapColorToPalette(border, palette, borderColor),
			text: snapColorToPalette(text, palette, textColor)
		};
	}

	function applyColorPreset(preset: WhistleColorPreset) {
		const text = preset.textColor ?? preset.borderColor;
		const snapped = snapPresetColors(
			preset.mainColor,
			preset.accentColor,
			preset.borderColor,
			text
		);
		mainColor = snapped.main;
		accentColor = snapped.accent;
		borderColor = snapped.border;
		textColor = snapped.text;
		activePresetId = findMatchingPresetId(galleryPresets) ?? preset.id;
	}

	function setPresetEditorColors(main: string, accent: string, border: string, text: string) {
		const snapped = snapPresetColors(main, accent, border, text);
		presetEditorMain = snapped.main;
		presetEditorAccent = snapped.accent;
		presetEditorBorder = snapped.border;
		presetEditorText = snapped.text;
	}

	function findMatchingPresetId(presets: WhistleColorPreset[]): string | null {
		for (const preset of presets) {
			const text = preset.textColor ?? preset.borderColor;
			if (
				preset.mainColor === mainColor &&
				preset.accentColor === accentColor &&
				preset.borderColor === borderColor &&
				text === textColor
			) {
				return preset.id;
			}
		}
		return null;
	}

	function openCreatePresetEditor() {
		presetEditorMode = 'create';
		presetEditorId = null;
		presetEditorLabel = 'My preset';
		setPresetEditorColors(mainColor, accentColor, borderColor, textColor);
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
			customPresets = await loadUserWhistleV2Presets(userId);
			activePresetId = findMatchingPresetId(galleryPresets);
		} catch (e) {
			presetSyncError = e instanceof Error ? e.message : 'Failed to load presets';
		} finally {
			customPresetsLoading = false;
		}
	}

	async function persistCustomPresets(presets: WhistleColorPreset[]) {
		if (!user?.id) return;
		const result = await persistWhistleV2CustomPresets(user.id, presets);
		if (!result.success) {
			presetSyncError = result.error;
			return;
		}
		presetSyncError = null;
	}

	function openEditPresetEditor(preset: WhistleColorPreset) {
		presetEditorMode = 'edit';
		presetEditorId = preset.id;
		presetEditorLabel = preset.label;
		setPresetEditorColors(
			preset.mainColor,
			preset.accentColor,
			preset.borderColor,
			preset.textColor ?? preset.borderColor
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
			presetEditorMain,
			presetEditorAccent,
			presetEditorBorder,
			presetEditorText
		);
		const main = snapped.main;
		const accent = snapped.accent;
		const border = snapped.border;
		const text = snapped.text;

		if (presetEditorMode === 'edit' && presetEditorId) {
			customPresets = customPresets.map((p) =>
				p.id === presetEditorId
					? { id: p.id, label, mainColor: main, accentColor: accent, borderColor: border, textColor: text }
					: p
			);
			activePresetId = presetEditorId;
		} else {
			const id = `custom-${crypto.randomUUID()}`;
			customPresets = [
				...customPresets,
				{ id, label, mainColor: main, accentColor: accent, borderColor: border, textColor: text }
			];
			activePresetId = id;
		}

		mainColor = main;
		accentColor = accent;
		borderColor = border;
		textColor = text;
		await persistCustomPresets(customPresets);
		closePresetEditor();
	}

	async function deleteCustomPreset(id: string) {
		if (!isCustomWhistleV2PresetId(id)) return;
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
			customPresets = cloneDefaultWhistleV2PresetsAsCustom((hex, fallback) =>
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

	function meshToWorldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
		const g = mesh.geometry.clone();
		mesh.updateWorldMatrix(true, false);
		g.applyMatrix4(mesh.matrixWorld);
		return g;
	}

	/** Parse OBJLoader output: meshes are named group_0_*, group_1_*, group_2_* (not obj_0). */
	function extractPartGeometries(root: THREE.Object3D): Record<WhistlePartKey, THREE.BufferGeometry> | null {
		const meshes: THREE.Mesh[] = [];
		root.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
		});
		if (meshes.length === 0) return null;

		const byIndex = new Map<number, THREE.Mesh>();
		for (const mesh of meshes) {
			const m = /^group_(\d+)_/i.exec(mesh.name);
			if (m) byIndex.set(Number(m[1]), mesh);
		}

		const parts = {} as Record<WhistlePartKey, THREE.BufferGeometry>;
		for (let i = 0; i < PART_ORDER.length; i++) {
			const key = PART_ORDER[i];
			const mesh = byIndex.get(i) ?? meshes[i];
			if (!mesh) return null;
			parts[key] = meshToWorldGeometry(mesh);
		}
		return parts;
	}

	function centerPartGeometries(parts: Record<WhistlePartKey, THREE.BufferGeometry>) {
		const box = new THREE.Box3();
		for (const geo of Object.values(parts)) {
			geo.computeBoundingBox();
			if (geo.boundingBox) box.union(geo.boundingBox);
		}
		const cx = (box.min.x + box.max.x) / 2;
		const cy = (box.min.y + box.max.y) / 2;
		const cz = box.min.z;
		for (const geo of Object.values(parts)) {
			geo.translate(-cx, -cy, -cz);
			geo.computeBoundingBox();
			geo.computeVertexNormals();
		}
	}

	/** Accent mesh is embossed: find upward-facing vertices on the top plateau. */
	function getAssemblyBounds(): THREE.Box3 | null {
		if (!partGeometries) return null;
		const box = new THREE.Box3();
		for (const geo of Object.values(partGeometries)) {
			geo.computeBoundingBox();
			if (geo.boundingBox) box.union(geo.boundingBox);
		}
		return box.isEmpty() ? null : box;
	}

	function getEmbossedTopSurface(borderGeo: THREE.BufferGeometry): {
		topZ: number;
		planWidth: number;
	} | null {
		borderGeo.computeBoundingBox();
		const bb = borderGeo.boundingBox;
		if (!bb) return null;

		if (!borderGeo.getAttribute('normal')) borderGeo.computeVertexNormals();
		const pos = borderGeo.getAttribute('position');
		const norm = borderGeo.getAttribute('normal');
		if (!pos || !norm) return null;

		const zSpan = Math.max(0.001, bb.max.z - bb.min.z);
		const topTolerance = Math.max(0.05, zSpan * 0.02);
		const minNormalZ = 0.65;

		const samples: { x: number; y: number; z: number }[] = [];
		for (let i = 0; i < pos.count; i++) {
			const z = pos.getZ(i);
			const nz = norm.getZ(i);
			if (z >= bb.max.z - topTolerance && nz > minNormalZ) {
				samples.push({ x: pos.getX(i), y: pos.getY(i), z });
			}
		}
		if (samples.length < 3) {
			for (let i = 0; i < pos.count; i++) {
				const z = pos.getZ(i);
				if (z >= bb.max.z - topTolerance) {
					samples.push({ x: pos.getX(i), y: pos.getY(i), z });
				}
			}
		}
		if (samples.length === 0) return null;

		let minX = Infinity;
		let maxX = -Infinity;
		let topZ = -Infinity;
		for (const s of samples) {
			minX = Math.min(minX, s.x);
			maxX = Math.max(maxX, s.x);
			topZ = Math.max(topZ, s.z);
		}
		return {
			topZ,
			planWidth: Math.max(0.01, maxX - minX)
		};
	}

	/**
	 * Accent embossed Z can sit below the border rim (Classic). Place text on the
	 * visible plateau under the border so it matches Modern (raised, not buried).
	 */
	function resolveTextSurface(
		accentGeo: THREE.BufferGeometry,
		borderGeo: THREE.BufferGeometry | null
	): { topZ: number; planWidth: number } | null {
		const embossed = getEmbossedTopSurface(accentGeo);
		if (!embossed) return null;
		let topZ = embossed.topZ;
		if (borderGeo) {
			borderGeo.computeBoundingBox();
			const borderBb = borderGeo.boundingBox;
			if (borderBb && borderBb.min.z > topZ + 0.15) {
				topZ = borderBb.min.z;
			}
		}
		return { topZ, planWidth: embossed.planWidth };
	}

	function createKeyringMesh(): THREE.Mesh {
		const geo = makeKeyringGeometry(
			KEYRING_OUTER_DIAMETER_MM,
			KEYRING_INNER_DIAMETER_MM,
			KEYRING_HEIGHT_MM
		);
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (bb) geo.translate(0, 0, -bb.min.z);
		const mat = new THREE.MeshPhysicalMaterial({
			color: KEYRING_SILVER_COLOR,
			metalness: .5,
			roughness: 0.12,
			clearcoat: 0.1,
			clearcoatRoughness: 0.02,
			envMapIntensity: 1,
			reflectivity: 0.2
		});
		if (envMap) mat.envMap = envMap;
		const mesh = new THREE.Mesh(geo, mat);
		mesh.name = KEYRING_MESH_NAME;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.position.set(KEYRING_POSITION.x, KEYRING_POSITION.y, KEYRING_POSITION.z);
		mesh.rotation.z = (KEYRING_ROTATION_Z_DEG * Math.PI) / 180;
		return mesh;
	}

	function bottomAlignGeometryZ(geo: THREE.BufferGeometry) {
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) return;
		geo.translate(0, 0, -bb.min.z);
		geo.computeBoundingBox();
	}

	function rebuildMeshes() {
		if (!group) return;
		disposeObject3D(group);
		group.clear();
		modelAabbMm = null;

		if (!partGeometries) return;

		const swapMainAccentColors = whistleStyle === 'classic';
		const partColors: Record<WhistlePartKey, string> = {
			accent: swapMainAccentColors ? mainColor : accentColor,
			main: swapMainAccentColors ? accentColor : mainColor,
			border: borderColor
		};

		const visibleParts: WhistlePartKey[] = showBorder
			? ['accent', 'main', 'border']
			: ['accent', 'main'];
		for (const key of visibleParts) {
			const geo = partGeometries[key];
			const mat = new THREE.MeshStandardMaterial({
				color: partColors[key],
				roughness: 0.7,
				metalness: 0.12,
				envMap: null,
				envMapIntensity: 0
			});
			const mesh = new THREE.Mesh(geo, mat);
			mesh.name = key;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			group.add(mesh);
		}

		const content = (textContent ?? '').trim();
		const assemblyBox = getAssemblyBounds();
		const topSurface = partGeometries.accent
			? resolveTextSurface(partGeometries.accent, partGeometries.border)
			: null;
		if (content && topSurface && assemblyBox) {
			const font = getFont(fontKey);
			if (font) {
				const shapes = font.generateShapes(content, FONT_SIZE_FOR_SHAPES);
				if (shapes.length > 0) {
					const textGeo = new THREE.ExtrudeGeometry(shapes, {
						depth: TEXT_DEPTH_MM,
						bevelEnabled: false,
						curveSegments: 8
					});
					centerGeometryXY(textGeo);
					bottomAlignGeometryZ(textGeo);

					const textMat = new THREE.MeshStandardMaterial({
						color: textColor,
						roughness: 0.4,
						metalness: 0.1,
						envMap: null,
						envMapIntensity: 0
					});
					const textMesh = new THREE.Mesh(textGeo, textMat);
					textMesh.name = 'text';
					textMesh.castShadow = true;
					textMesh.receiveShadow = true;

					textGeo.computeBoundingBox();
					const tb = textGeo.boundingBox!;
					const textH = Math.max(tb.max.y - tb.min.y, 0.01);
					const scale = (TARGET_TEXT_HEIGHT_MM * textScale) / textH;
					const scaleCap =
						(TEXT_FIT_REFERENCE_WIDTH_MM * 0.8) / (tb.max.x - tb.min.x || 0.01);
					const scaleCapped = Math.min(scale, scaleCap);
					textMesh.scale.set(scaleCapped, scaleCapped, 1);
					const centerX = (assemblyBox.min.x + assemblyBox.max.x) / 2;
					const centerY = (assemblyBox.min.y + assemblyBox.max.y) / 2;
					const textOffset = WHISTLE_STYLES[whistleStyle];
					textMesh.position.set(
						centerX + textOffset.textOffsetX,
						centerY + textOffset.textOffsetY,
						topSurface.topZ + TEXT_SURFACE_EMBED
					);
					group.add(textMesh);
				}
			}
		}

		if (whistleStyle === 'classic') {
			group.add(createKeyringMesh());
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
		if (!group) throw new Error('Scene not ready');
		rebuildMeshes();
		group.updateWorldMatrix(true, true);
		const exportGroup = new THREE.Group();
		for (const child of group.children) {
			if (!(child as THREE.Mesh).isMesh) continue;
			const mesh = child as THREE.Mesh;
			if (mesh.name === KEYRING_MESH_NAME) continue;
			const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
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
		if (!group || group.children.length === 0) {
			exportError = 'Nothing to export';
			return;
		}
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const geometries: THREE.BufferGeometry[] = [];
			for (const child of group.children) {
				if (!(child as THREE.Mesh).isMesh) continue;
				const mesh = child as THREE.Mesh;
				if (mesh.name === KEYRING_MESH_NAME) continue;
				let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
				if (g.attributes.uv) g.deleteAttribute('uv');
				if (!g.attributes.normal) g.computeVertexNormals();
				if (g.index) {
					const nonIndexed = g.toNonIndexed();
					g.dispose();
					g = nonIndexed;
				}
				geometries.push(g);
			}
			if (geometries.length === 0) {
				exportError = 'Nothing to export';
				return;
			}
			const merged =
				geometries.length === 1 ? geometries[0] : BufferGeometryUtils.mergeGeometries(geometries);
			if (!merged) {
				geometries.forEach((g) => g.dispose());
				exportError = 'Failed to merge geometry';
				return;
			}
			if (geometries.length > 1) geometries.forEach((g) => g.dispose());
			const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
			if (welded !== merged) merged.dispose();

			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
			welded.dispose();
			const buffer = result instanceof DataView ? result.buffer : result;
			if (!buffer || (buffer as ArrayBuffer).byteLength < 84) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`whistle-v2-${whistleStyle}-${ts}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Whistle v2',
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
			downloadBlob(`whistle-v2-${whistleStyle}-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Whistle v2',
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
			const publicUrl = await upload3mfToSupabase(blob, 'whistle-v2');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Whistle v2',
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			openBambuStudioLoading = false;
		}
	}

	function disposePartGeometries() {
		if (!partGeometries) return;
		for (const geo of Object.values(partGeometries)) geo.dispose();
		partGeometries = null;
	}

	function loadWhistleStyle(style: WhistleStyleId) {
		const token = ++loadToken;
		loadError = null;
		disposePartGeometries();

		const loader = new OBJLoader();
		loader.load(
			WHISTLE_STYLES[style].objUrl,
			(root) => {
				if (token !== loadToken) return;
				const parts = extractPartGeometries(root);
				if (!parts) {
					loadError = 'Whistle model must contain three mesh groups (Border, Main, Accent).';
					return;
				}
				centerPartGeometries(parts);
				partGeometries = parts;
				loadedWhistleStyle = style;
				loadError = null;
				sceneReady = true;
				didInitFrame = false;
			},
			undefined,
			(err) => {
				if (token !== loadToken) return;
				loadError = err instanceof Error ? err.message : 'Failed to load whistle model';
			}
		);
	}

	$effect(() => {
		const userId = user?.id ?? null;
		void syncCustomPresetsFromAccount();
	});

	$effect(() => {
		void textContent;
		void fontKey;
		void textScale;
		void textColor;
		void accentColor;
		void mainColor;
		void borderColor;
		void showBorder;
		void whistleStyle;
		activePresetId = findMatchingPresetId(galleryPresets);
		saveSettings();
	});

	$effect(() => {
		if (!sceneInitialized) return;
		const style = whistleStyle;
		if (loadedWhistleStyle === style) return;
		untrack(() => loadWhistleStyle(style));
	});

	$effect(() => {
		void partGeometries;
		void whistleStyle;
		void textContent;
		void fontKey;
		void textScale;
		void textColor;
		void accentColor;
		void mainColor;
		void borderColor;
		void showBorder;
		if (!scene || !group || !sceneReady) return;
		rebuildMeshes();
	});

	onMount(() => {
		if (!hostEl) return;
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);
		renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		hostEl.appendChild(renderer.domElement);

		pmremGenerator = new THREE.PMREMGenerator(renderer);
		pmremGenerator.compileEquirectangularShader();
		// Keyring only — do not set scene.environment (would tint all plastic parts).
		envMap = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

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
		fillLight.target.position.set(0, 0, 0);
		scene.add(fillLight);
		scene.add(fillLight.target);

		group = new THREE.Group();
		scene.add(group);
		sceneInitialized = true;

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

		return () => {
			ro?.disconnect();
			ro = null;
		};
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		rafId = 0;
		disposePartGeometries();
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
		envMap?.dispose();
		envMap = null;
		pmremGenerator?.dispose();
		pmremGenerator = null;
	});
</script>

<main class="h-dvh w-dvw bg-slate-100 p-4">
	<div class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]"
		>
			<div class="mb-4 flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Whistle v2</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<p class="text-xs text-slate-500">
					Multicolor whistle.
				</p>

				{#if loadError}
					<p class="text-sm text-red-600">{loadError}</p>
				{/if}

				<div class="grid gap-1.5">
					<span class="text-xs font-medium text-slate-700">Style</span>
					<div class="flex flex-wrap gap-2">
						{#each Object.keys(WHISTLE_STYLES) as styleId (styleId)}
							{@const id = styleId as WhistleStyleId}
							<Button
								variant={whistleStyle === id ? 'default' : 'outline'}
								size="sm"
								onclick={() => (whistleStyle = id)}
							>
								{WHISTLE_STYLES[id].label}
							</Button>
						{/each}
					</div>
				</div>

				<div>
					<label for="whistle-v2-text" class="mb-1 block text-xs font-medium text-slate-700">
						Text
					</label>
					<input
						id="whistle-v2-text"
						type="text"
						placeholder="Your name or message"
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
						bind:value={textContent}
					/>
				</div>

				<div>
					<label for="whistle-v2-font" class="mb-1 block text-xs font-medium text-slate-700">
						Font
					</label>
					<FontSelect id="whistle-v2-font" bind:value={fontKey} />
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="whistle-v2-text-scale" class="text-xs font-medium text-slate-700">
							Text scale
						</label>
						<span class="text-xs text-slate-500">{textScale.toFixed(1)}×</span>
					</div>
					<Slider
						id="whistle-v2-text-scale"
						type="single"
						bind:value={textScale}
						min={0.3}
						max={2}
						step={0.1}
						class="w-full"
					/>
				</div>

				<ColorPalettePicker bind:value={textColor} {palette} label="Text color" />

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="flex items-center justify-between gap-2">
						<p class="text-xs font-semibold tracking-tight text-slate-700">Body colors</p>
						<label class="flex shrink-0 items-center gap-2 text-xs font-medium text-slate-700">
							<input
								type="checkbox"
								class="h-4 w-4 accent-indigo-500"
								bind:checked={showBorder}
							/>
							Border
						</label>
					</div>
					<ColorPalettePicker bind:value={mainColor} {palette} label="Main" />
					{#if showBorder}
						<ColorPalettePicker bind:value={borderColor} {palette} label="Border" />
					{/if}
					<ColorPalettePicker bind:value={accentColor} {palette} label="Accent" />
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
								Import default presets to get {DEFAULT_WHISTLE_V2_COLOR_PRESETS.length} editable
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
												style:background-color={preset.mainColor}
												aria-hidden="true"
											></span>
											<span
												class="min-w-0 flex-1 border-x border-white/20"
												style:background-color={preset.accentColor}
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
							Save and reuse color combinations for your whistle. Import
							{DEFAULT_WHISTLE_V2_COLOR_PRESETS.length} starter presets, create your own, and
							edit or delete them anytime — all synced to your account.
						</p>
						<Button type="button" size="sm" class="w-full" onclick={onRequestLogin}>
							Sign in to use presets
						</Button>
						<p class="text-[10px] font-medium uppercase tracking-wide text-slate-500">
							Starter presets (preview)
						</p>
						<div class="grid grid-cols-3 gap-2 opacity-90" aria-hidden="true">
							{#each DEFAULT_WHISTLE_V2_COLOR_PRESETS as template (template.label)}
								<div
									class="overflow-hidden rounded-lg border border-slate-200/90 bg-white shadow-sm"
								>
									<div class="flex h-11 w-full">
										<span
											class="min-w-0 flex-1"
											style:background-color={snapColorToPalette(
												template.mainColor,
												palette,
												template.mainColor
											)}
										></span>
										<span
											class="min-w-0 flex-1 border-x border-white/20"
											style:background-color={snapColorToPalette(
												template.accentColor,
												palette,
												template.accentColor
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
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'whistle-v2')}
					onExport={() => exportStl()}
					exportDisabled={!partGeometries || exportLoading}
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
							Save the current whistle colors as a reusable preset.
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
					<ColorPalettePicker
						bind:value={presetEditorMain}
						{palette}
						paletteOnly
						label="Main"
					/>
					<ColorPalettePicker
						bind:value={presetEditorAccent}
						{palette}
						paletteOnly
						label="Accent"
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
