<script lang="ts">
	import { openInSlicer, type OpenWithSlicerId } from '$lib/openInSlicer';
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import type { PaletteColor } from '$lib/colorPalette';
	import {
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		frameCameraToObject,
		frameOrthographicTopView,
		getFont,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import {
		applyMountingHoleToShapes,
		applyKeyringToOutlineShapes,
		buildCurvedNameShapes,
		buildInitialLayerShapes,
		buildInitialOutlineShapes,
		buildHoleByInitialSnapshot,
		computeShapesXYCenter,
		computeOutlineKeyringAnchor,
		DEFAULT_OVERALL_SCALE,
		DESIGN_INITIAL_SIZE,
		DESIGN_NAME,
		DESIGN_NAME_SIZE,
		effectiveLargeInitial,
		getMountingForInitial,
		getMountingHoleGuidePoints,
		getMountingKeyringGuideLoops,
		getLetterNamePlacement,
		getNamePlacementForInitial,
		normalizeNamePlacementByInitial,
		getNameTextBoxCornerPoints,
		INITIAL_FONT_KEY,
		NAME_FONT_KEY,
		loadNamePlacementState,
		loadMountingState,
		normalizeInitialLetter,
		parseLetterRailSettings,
		readLetterRailSettingsRaw,
		STORAGE_KEY,
		type LetterRailSettings,
		type MountingByInitial,
		type MountingHoleSettings,
		type MountingKeyringSettings,
		type MountingMode,
		type NamePlacement,
		type NamePlacementByInitial,
		type TextBoxAlign,
		type TextBoxJustify
	} from '$lib/utils-letter-rail';
	import {
		ensureExportAccess,
		getExportTitle,
		showExportLockIcon,
		type SubscriptionStatus
	} from '$lib/subscription';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import EditableNumericValue from './EditableNumericValue.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';

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

	/** Gap between stacked extrusion layers (matches TextOutlineDesigner). */
	const LAYER_GAP = 0.001;
	const FINE_SLIDER_STEP = 0.2;

	const OVERALL_SCALE_MIN = 0.5;
	const OVERALL_SCALE_MAX = 1.5;

	function loadSettings(): LetterRailSettings {
		return parseLetterRailSettings(readLetterRailSettingsRaw());
	}

	function saveSettings() {
		try {
			const payload: LetterRailSettings = {
				nameText,
				initialChar,
				overallScale,
				initialDepth,
				nameDepth,
				outlineOffsetPx,
				namePlacementByInitial: normalizeNamePlacementByInitial(namePlacementByInitial),
				mountingByInitial,
				outlineColor,
				initialColor,
				nameColor
			};
			let legacyHoleByInitial: Partial<
				Record<string, { enabled?: boolean; diameter?: number; offsetX?: number; offsetY?: number }>
			> = {};
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw) {
					legacyHoleByInitial =
						(JSON.parse(raw) as { holeByInitial?: typeof legacyHoleByInitial }).holeByInitial ?? {};
				}
			} catch {
				/* ignore */
			}
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					...payload,
					holeByInitial: {
						...legacyHoleByInitial,
						...buildHoleByInitialSnapshot(mountingByInitial)
					}
				})
			);
		} catch {
			/* ignore */
		}
	}

	function updateActivePlacement(patch: Partial<NamePlacement>) {
		const key = normalizeInitialLetter(effectiveInitial);
		const mode = getMountingForInitial(mountingByInitial, key).mode;
		const letterPlacement = getLetterNamePlacement(namePlacementByInitial, key);
		namePlacementByInitial = {
			...namePlacementByInitial,
			[key]: {
				...letterPlacement,
				[mode]: { ...letterPlacement[mode], ...patch }
			}
		};
	}

	function updateActiveMounting(patch: {
		mode?: MountingMode;
		hole?: Partial<MountingHoleSettings>;
		keyring?: Partial<MountingKeyringSettings>;
	}) {
		const key = normalizeInitialLetter(effectiveInitial);
		const current = getMountingForInitial(mountingByInitial, key);

		if (patch.mode !== undefined && patch.mode !== current.mode) {
			const placement = getLetterNamePlacement(namePlacementByInitial, key);
			namePlacementByInitial = {
				...namePlacementByInitial,
				[key]: {
					hole: { ...placement.hole },
					keyring: { ...placement.keyring }
				}
			};
		}

		mountingByInitial = {
			...mountingByInitial,
			[key]: {
				mode: patch.mode ?? current.mode,
				hole: patch.hole ? { ...current.hole, ...patch.hole } : current.hole,
				keyring: patch.keyring ? { ...current.keyring, ...patch.keyring } : current.keyring
			}
		};
	}

	function updateActiveHole(patch: Partial<MountingHoleSettings>) {
		updateActiveMounting({ hole: patch });
	}

	function updateActiveKeyring(patch: Partial<MountingKeyringSettings>) {
		updateActiveMounting({ keyring: patch });
	}

	const initial = loadSettings();

	let nameText = $state(initial.nameText);
	let initialChar = $state(initial.initialChar);
	let overallScale = $state(initial.overallScale ?? DEFAULT_OVERALL_SCALE);
	let initialDepth = $state(initial.initialDepth);
	let nameDepth = $state(initial.nameDepth);
	let outlineOffsetPx = $state(initial.outlineOffsetPx);
	// Deep copy of letter-rail-defaults.json when nothing stored (matches pasting that file).
	let namePlacementByInitial = $state<NamePlacementByInitial>(loadNamePlacementState());
	let mountingByInitial = $state<MountingByInitial>(loadMountingState());
	let outlineColor = $state(initial.outlineColor);
	let initialColor = $state(initial.initialColor);
	let nameColor = $state(initial.nameColor);

	let hostEl: HTMLDivElement | null = null;
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let perspectiveCamera: THREE.PerspectiveCamera | null = null;
	let orthographicCamera: THREE.OrthographicCamera | null = null;
	let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null = null;
	let controls: InstanceType<typeof OrbitControls> | null = null;
	let group: THREE.Group | null = null;
	let keyLight: THREE.DirectionalLight | null = null;
	let rafId = 0;
	let ro: ResizeObserver | null = null;
	let didInitFrame = false;
	let openWithSlicerLoading = $state(false);
	let exportLoading = $state(false);
	let topViewEnabled = $state(false);
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);

	const effectiveInitial = $derived(effectiveLargeInitial(initialChar, nameText));
	const activePlacementKey = $derived(normalizeInitialLetter(effectiveInitial));
	const activeMounting = $derived(getMountingForInitial(mountingByInitial, activePlacementKey));
	const activePlacement = $derived(
		getNamePlacementForInitial(namePlacementByInitial, activePlacementKey, activeMounting.mode)
	);
	const activeHole = $derived(activeMounting.hole);
	const activeKeyring = $derived(activeMounting.keyring);

	const TEXT_BOX_GUIDE_NAME = 'nameTextBoxGuide';
	const HOLE_GUIDE_NAME = 'mountingHoleGuide';
	const KEYRING_GUIDE_OUTER_NAME = 'mountingKeyringGuideOuter';
	const KEYRING_GUIDE_INNER_NAME = 'mountingKeyringGuideInner';
	const PREVIEW_GUIDE_NAMES = new Set([
		TEXT_BOX_GUIDE_NAME,
		HOLE_GUIDE_NAME,
		KEYRING_GUIDE_OUTER_NAME,
		KEYRING_GUIDE_INNER_NAME
	]);

	function buildExportMeshGroup(): THREE.Group {
		if (!group) return new THREE.Group();
		const out = new THREE.Group();
		group.updateWorldMatrix(true, true);
		for (const child of group.children) {
			if (PREVIEW_GUIDE_NAMES.has(child.name)) continue;
			out.add(child.clone(true));
		}
		return out;
	}

	function addNameTextBoxGuide(refCx: number, refCy: number, z: number) {
		if (!group) return;
		const corners = getNameTextBoxCornerPoints(activePlacement, refCx, refCy);
		const closed = [...corners, corners[0]];
		const guideGeo = new THREE.BufferGeometry().setFromPoints(closed);
		const guideMat = new THREE.LineBasicMaterial({
			color: 0x6366f1,
			transparent: true,
			opacity: 0.95,
			depthTest: false
		});
		const guide = new THREE.LineLoop(guideGeo, guideMat);
		guide.name = TEXT_BOX_GUIDE_NAME;
		guide.renderOrder = 1000;
		guide.position.z = z;
		group.add(guide);
	}

	function addMountingGuide(z: number, keyringAnchor: { x: number; y: number }) {
		if (!group) return;
		const guideMat = new THREE.LineBasicMaterial({
			color: 0xf59e0b,
			transparent: true,
			opacity: 0.95,
			depthTest: false
		});

		if (activeMounting.mode === 'hole') {
			const points = getMountingHoleGuidePoints(activeHole);
			if (points.length === 0) return;
			const guide = new THREE.LineLoop(
				new THREE.BufferGeometry().setFromPoints(points),
				guideMat
			);
			guide.name = HOLE_GUIDE_NAME;
			guide.renderOrder = 1001;
			guide.position.z = z;
			group.add(guide);
			return;
		}

		const loops = getMountingKeyringGuideLoops(activeKeyring, keyringAnchor.x, keyringAnchor.y);
		if (loops.outer.length > 0) {
			const outer = new THREE.LineLoop(
				new THREE.BufferGeometry().setFromPoints(loops.outer),
				guideMat
			);
			outer.name = KEYRING_GUIDE_OUTER_NAME;
			outer.renderOrder = 1001;
			outer.position.z = z;
			group.add(outer);
		}
		if (loops.inner.length > 0) {
			const inner = new THREE.LineLoop(
				new THREE.BufferGeometry().setFromPoints(loops.inner),
				guideMat
			);
			inner.name = KEYRING_GUIDE_INNER_NAME;
			inner.renderOrder = 1001;
			inner.position.z = z;
			group.add(inner);
		}
	}

	function resize() {
		if (!renderer || !perspectiveCamera || !hostEl) return;
		const rect = hostEl.getBoundingClientRect();
		const width = Math.max(1, Math.floor(rect.width));
		const height = Math.max(1, Math.floor(rect.height));
		renderer.setSize(width, height, true);
		const aspect = width / height;
		perspectiveCamera.aspect = aspect;
		perspectiveCamera.updateProjectionMatrix();
		if (topViewEnabled && orthographicCamera && group) {
			group.updateWorldMatrix(true, true);
			const box = new THREE.Box3().setFromObject(group);
			if (!box.isEmpty() && controls) {
				frameOrthographicTopView(box, orthographicCamera, controls, aspect);
			}
		}
	}

	function getModelBox(): THREE.Box3 | null {
		if (!group) return null;
		group.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(group);
		return box.isEmpty() ? null : box;
	}

	function applyCameraView(reframe = true) {
		if (!perspectiveCamera || !orthographicCamera || !controls || !hostEl) return;
		const box = getModelBox();
		if (!box) return;
		const rect = hostEl.getBoundingClientRect();
		const aspect = Math.max(0.01, rect.width / Math.max(1, rect.height));

		if (topViewEnabled) {
			camera = orthographicCamera;
			controls.object = orthographicCamera;
			controls.enableRotate = false;
			if (reframe) frameOrthographicTopView(box, orthographicCamera, controls, aspect);
		} else {
			camera = perspectiveCamera;
			controls.object = perspectiveCamera;
			controls.enableRotate = true;
			if (reframe) frameCameraToObject(box, perspectiveCamera, controls);
		}
		controls.update();
	}

	function buildExportGroup(): THREE.Group {
		if (!group) throw new Error('Preview not ready');
		group.updateWorldMatrix(true, true);
		const byName: Record<string, THREE.Mesh> = {};
		for (const child of group.children) {
			if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).name) {
				byName[(child as THREE.Mesh).name] = child as THREE.Mesh;
			}
		}
		const geoWorld = (mesh: THREE.Mesh) => mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
		const mergeAll = (meshes: THREE.Mesh[]) => {
			const geos = meshes.map(geoWorld);
			const merged = geos.length === 1 ? geos[0] : BufferGeometryUtils.mergeGeometries(geos);
			if (!merged) return null;
			if (geos.length > 1) geos.forEach((g) => g !== merged && g.dispose());
			return BufferGeometryUtils.mergeVertices(merged, 1e-3);
		};

		const exportGroup = new THREE.Group();
		const bottomMeshes: THREE.Mesh[] = [];
		if (byName.initialOutline) bottomMeshes.push(byName.initialOutline);
		const bottomGeo = bottomMeshes.length > 0 ? mergeAll(bottomMeshes) : null;
		if (bottomGeo) {
			exportGroup.add(
				new THREE.Mesh(
					bottomGeo,
					new THREE.MeshBasicMaterial({ color: new THREE.Color(outlineColor) })
				)
			);
		}
		if (byName.initial) {
			const initialGeo = mergeAll([byName.initial]);
			if (initialGeo) {
				exportGroup.add(
					new THREE.Mesh(
						initialGeo,
						new THREE.MeshBasicMaterial({ color: new THREE.Color(initialColor) })
					)
				);
			}
		}
		if (byName.name) {
			const nameGeo = mergeAll([byName.name]);
			if (nameGeo) {
				exportGroup.add(
					new THREE.Mesh(
						nameGeo,
						new THREE.MeshBasicMaterial({ color: new THREE.Color(nameColor) })
					)
				);
			}
		}
		return exportGroup;
	}

	async function exportSTL() {
		if (!group) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const exporter = new STLExporter();
			const exportMeshes = buildExportMeshGroup();
			exportMeshes.updateWorldMatrix(true, true);
			const result = exporter.parse(exportMeshes, { binary: true });
			disposeObject3D(exportMeshes);
			const blob =
				result instanceof ArrayBuffer
					? new Blob([result], { type: 'model/stl' })
					: new Blob([result], { type: 'text/plain' });
			const safe = (nameText || 'model')
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)/g, '');
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${safe || 'model'}-letter-rail-${timestamp}.stl`, blob);
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: 'stl'
			});
			onShowThankYou();
		} finally {
			exportLoading = false;
		}
	}

	async function export3MF() {
		if (!group || group.children.length === 0) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup();
			if (exportGroup.children.length === 0) return;
			exportGroup.updateWorldMatrix(true, true);
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) return;
			const safe = (nameText || 'model')
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)/g, '');
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${safe || 'model'}-letter-rail-${timestamp}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: '3mf'
			});
			onShowThankYou();
		} catch (e) {
			console.error('3MF export failed', e);
		} finally {
			exportLoading = false;
		}
	}

	async function openWithSlicerHandler(slicer: OpenWithSlicerId) {
		if (!group || group.children.length === 0) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		openWithSlicerLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup();
			if (exportGroup.children.length === 0) return;
			exportGroup.updateWorldMatrix(true, true);
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'letter-rail');
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: 'bambu_studio'
			});
			openInSlicer(publicUrl, slicer);
		} catch (err) {
			console.error('Open with slicer failed:', err);
		} finally {
			openWithSlicerLoading = false;
		}
	}

	function rebuildMeshes() {
		if (!scene || !group) return;
		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		group.scale.set(1, 1, 1);
		modelAabbMm = null;

		const initialFont = getFont(INITIAL_FONT_KEY);
		const nameFont = getFont(NAME_FONT_KEY);
		if (!initialFont || !nameFont) return;

		const char = effectiveInitial;
		const initialDepthVal = Math.max(0.1, initialDepth);
		const nameDepthVal = Math.max(0.1, nameDepth);
		// Bottom → top: outline base, initial on base, name on initial (TextOutlineDesigner stack).
		const outlineZ = 0;
		const initialZ = initialDepthVal + LAYER_GAP;
		const nameZ = initialZ + initialDepthVal + LAYER_GAP;

		const outlineMat = new THREE.MeshStandardMaterial({
			color: outlineColor,
			roughness: 0.75,
			metalness: 0.05
		});
		const initialMat = new THREE.MeshStandardMaterial({
			color: initialColor,
			roughness: 0.55,
			metalness: 0.08
		});
		const nameMat = new THREE.MeshStandardMaterial({
			color: nameColor,
			roughness: 0.45,
			metalness: 0.08
		});

		const initialShapes = buildInitialLayerShapes(initialFont, char, DESIGN_INITIAL_SIZE);
		const { cx: refCx, cy: refCy } = computeShapesXYCenter(initialShapes);
		const extrudeOpts = {
			bevelEnabled: false,
			curveSegments: 12
		} as const;

		const outlineShapesRaw = buildInitialOutlineShapes(
			initialFont,
			char,
			DESIGN_INITIAL_SIZE,
			outlineOffsetPx
		);
		let keyringAnchor = { x: 0, y: 0 };
		let outlineShapes = outlineShapesRaw;
		if (activeMounting.mode === 'hole') {
			outlineShapes = applyMountingHoleToShapes(outlineShapesRaw, refCx, refCy, activeHole);
		} else if (activeMounting.mode === 'keyring') {
			const keyringResult = applyKeyringToOutlineShapes(
				outlineShapesRaw,
				refCx,
				refCy,
				activeKeyring
			);
			outlineShapes = keyringResult.shapes;
			keyringAnchor = keyringResult.anchor;
		} else {
			keyringAnchor = computeOutlineKeyringAnchor(outlineShapesRaw, refCx, refCy);
		}
		if (outlineShapes.length > 0) {
			const outlineGeo = new THREE.ExtrudeGeometry(outlineShapes, {
				...extrudeOpts,
				depth: initialDepthVal
			});
			outlineGeo.translate(-refCx, -refCy, 0);
			outlineGeo.computeBoundingBox();
			const outlineMesh = new THREE.Mesh(outlineGeo, outlineMat);
			outlineMesh.name = 'initialOutline';
			outlineMesh.castShadow = true;
			outlineMesh.receiveShadow = true;
			outlineMesh.position.z = outlineZ;
			group.add(outlineMesh);
		}

		let initialMesh: THREE.Mesh | null = null;
		const initialShapesRaw = initialShapes;
		const initialShapesWithHole =
			activeMounting.mode === 'hole'
				? applyMountingHoleToShapes(initialShapesRaw, refCx, refCy, activeHole)
				: initialShapesRaw;
		if (initialShapesWithHole.length > 0) {
			const initialGeo = new THREE.ExtrudeGeometry(initialShapesWithHole, {
				...extrudeOpts,
				depth: initialDepthVal
			});
			initialGeo.translate(-refCx, -refCy, 0);
			initialGeo.computeBoundingBox();
			initialMesh = new THREE.Mesh(initialGeo, initialMat);
			initialMesh.name = 'initial';
			initialMesh.castShadow = true;
			initialMesh.receiveShadow = true;
			initialMesh.position.z = initialZ;
			group.add(initialMesh);
		}

		const nameShapes = buildCurvedNameShapes(nameFont, nameText, DESIGN_NAME_SIZE, activePlacement);
		if (nameShapes.length > 0) {
			const nameGeo = new THREE.ExtrudeGeometry(nameShapes, {
				...extrudeOpts,
				depth: nameDepthVal
			});
			nameGeo.translate(-refCx, -refCy, 0);
			nameGeo.computeBoundingBox();
			const nameMesh = new THREE.Mesh(nameGeo, nameMat);
			nameMesh.name = 'name';
			nameMesh.castShadow = true;
			nameMesh.receiveShadow = true;
			nameMesh.position.z = nameZ;
			group.add(nameMesh);
		}

		addNameTextBoxGuide(refCx, refCy, nameZ + nameDepthVal + 0.05);
		addMountingGuide(nameZ + nameDepthVal + 0.06, keyringAnchor);

		const scaleXY = Math.max(OVERALL_SCALE_MIN, Math.min(OVERALL_SCALE_MAX, overallScale));
		group.scale.set(scaleXY, scaleXY, 1);

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
			keyLight.target.updateWorldMatrix(true, true);
		}
		if (controls && perspectiveCamera && orthographicCamera) {
			if (topViewEnabled) {
				applyCameraView(true);
			} else if (!didInitFrame) {
				frameCameraToObject(box, perspectiveCamera, controls);
				didInitFrame = true;
			}
		}
		const size = measureWorldAabbSizeMm(group);
		modelAabbMm = size ? { x: size.x, y: size.y, z: size.z } : null;
	}

	onMount(() => {
		if (!hostEl) return;
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		perspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		perspectiveCamera.up.set(0, 0, 1);
		orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
		orthographicCamera.up.set(0, 0, 1);
		camera = perspectiveCamera;
		renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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
		rebuildMeshes();

		const tick = () => {
			rafId = requestAnimationFrame(tick);
			controls?.update();
			if (renderer && scene && camera) renderer.render(scene, camera);
		};
		tick();
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		ro?.disconnect();
		if (group) {
			disposeObject3D(group);
			group.clear();
		}
		renderer?.dispose();
	});

	$effect(() => {
		void nameText;
		void initialChar;
		void overallScale;
		void initialDepth;
		void nameDepth;
		void outlineOffsetPx;
		void namePlacementByInitial;
		void mountingByInitial;
		void activePlacementKey;
		void activeMounting.mode;
		void outlineColor;
		void initialColor;
		void nameColor;
		saveSettings();
		if (scene && group) rebuildMeshes();
	});

	$effect(() => {
		void topViewEnabled;
		if (scene && group && controls) applyCameraView(true);
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">{DESIGN_NAME}</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>
			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<div class="rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2 text-[11px] text-slate-600">
					Fonts: <strong>Qilka Bold</strong> (initial) · <strong>Rounds Black</strong> (name)
				</div>

				<div class="space-y-3">
					<p class="text-xs font-semibold uppercase tracking-wide text-slate-500">Size</p>
					<p class="text-[11px] leading-snug text-slate-500">
						Scales initial and name together in width and height. Layer depths are unchanged.
					</p>
					<div class="grid gap-1.5">
						<div class="flex items-center justify-between">
							<span class="text-xs font-medium text-slate-700">Overall scale</span>
							<EditableNumericValue
								value={overallScale}
								min={OVERALL_SCALE_MIN}
								max={OVERALL_SCALE_MAX}
								step={0.02}
								decimals={2}
								suffix="×"
								onChange={(v) => (overallScale = v)}
							/>
						</div>
						<Slider
							type="single"
							bind:value={overallScale}
							min={OVERALL_SCALE_MIN}
							max={OVERALL_SCALE_MAX}
							step={0.02}
							class="w-full"
						/>
					</div>
				</div>

				<div class="space-y-3">
					<p class="text-xs font-semibold uppercase tracking-wide text-slate-500">Initial</p>
					<label class="grid gap-1">
						<span class="text-xs font-medium text-slate-700">Initial letter (blank = from name)</span>
						<input
							class="rounded-md border border-slate-200 px-2 py-1.5 text-sm uppercase"
							maxlength="1"
							bind:value={initialChar}
							placeholder={effectiveInitial}
						/>
					</label>
					<div class="grid gap-1.5">
						<div class="flex items-center justify-between">
							<span class="text-xs font-medium text-slate-700">Initial depth</span>
							<EditableNumericValue
								value={initialDepth}
								min={1}
								max={12}
								step={0.1}
								decimals={1}
								suffix=" mm"
								onChange={(v) => (initialDepth = v)}
							/>
						</div>
						<Slider type="single" bind:value={initialDepth} min={1} max={12} step={0.1} class="w-full" />
					</div>
					<div class="grid gap-1.5">
						<div class="flex items-center justify-between">
							<span class="text-xs font-medium text-slate-700">Outline thickness</span>
							<EditableNumericValue
								value={outlineOffsetPx}
								min={4}
								max={24}
								step={1}
								decimals={0}
								suffix="px"
								onChange={(v) => (outlineOffsetPx = v)}
							/>
						</div>
						<Slider type="single" bind:value={outlineOffsetPx} min={4} max={24} step={1} class="w-full" />
					</div>
					<ColorPalettePicker bind:value={initialColor} {palette} label="Initial color" />
					<ColorPalettePicker bind:value={outlineColor} {palette} label="Outline color" />
				</div>

				<div class="space-y-3">
					<p class="text-xs font-semibold uppercase tracking-wide text-slate-500">Name</p>
					<label class="grid gap-1">
						<span class="text-xs font-medium text-slate-700">Name text</span>
						<input
							class="rounded-md border border-slate-200 px-2 py-1.5 text-sm uppercase"
							bind:value={nameText}
							maxlength="16"
						/>
					</label>
					<div class="grid gap-1.5">
						<div class="flex items-center justify-between">
							<span class="text-xs font-medium text-slate-700">Name depth</span>
							<EditableNumericValue
								value={nameDepth}
								min={0.4}
								max={4}
								step={0.1}
								decimals={1}
								suffix=" mm"
								onChange={(v) => (nameDepth = v)}
							/>
						</div>
						<Slider type="single" bind:value={nameDepth} min={0.4} max={4} step={0.1} class="w-full" />
					</div>
					<ColorPalettePicker bind:value={nameColor} {palette} label="Name color" />
				</div>

				<div class="space-y-3">
					<div class="flex items-center justify-between gap-2">
						<p class="text-xs font-semibold uppercase tracking-wide text-slate-500">Name placement</p>
						<div class="flex items-center gap-1.5">
							<span
								class="rounded-md bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-indigo-700"
								title="Placement is saved per letter A–Z"
							>
								{activePlacementKey}
							</span>
							<span
								class="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold capitalize text-amber-800"
								title="Hole and keyring each keep their own placement and text box"
							>
								{activeMounting.mode}
							</span>
						</div>
					</div>
					<p class="text-[11px] leading-snug text-slate-500">
						Placement and text box are saved per letter and per mount type. Switch Hole/Keyring to edit
						each set independently.
					</p>
					{#key `${activePlacementKey}-${activeMounting.mode}`}
					<div class="grid grid-cols-2 gap-3">
						<div class="grid gap-1.5">
							<div class="flex items-center justify-between">
								<span class="text-xs font-medium text-slate-700">Offset X</span>
								<EditableNumericValue
									value={activePlacement.offsetX}
									min={-60}
									max={60}
									step={FINE_SLIDER_STEP}
									decimals={1}
									onChange={(v) => updateActivePlacement({ offsetX: v })}
								/>
							</div>
							<Slider
								type="single"
								value={activePlacement.offsetX}
								onValueChange={(v: number) => updateActivePlacement({ offsetX: v })}
								min={-60}
								max={60}
								step={FINE_SLIDER_STEP}
								class="w-full"
							/>
						</div>
						<div class="grid gap-1.5">
							<div class="flex items-center justify-between">
								<span class="text-xs font-medium text-slate-700">Offset Y</span>
								<EditableNumericValue
									value={activePlacement.offsetY}
									min={-60}
									max={60}
									step={FINE_SLIDER_STEP}
									decimals={1}
									onChange={(v) => updateActivePlacement({ offsetY: v })}
								/>
							</div>
							<Slider
								type="single"
								value={activePlacement.offsetY}
								onValueChange={(v: number) => updateActivePlacement({ offsetY: v })}
								min={-60}
								max={60}
								step={FINE_SLIDER_STEP}
								class="w-full"
							/>
						</div>
					</div>
					<div class="grid gap-1.5">
						<div class="flex items-center justify-between">
							<span class="text-xs font-medium text-slate-700">Rotation</span>
							<EditableNumericValue
								value={activePlacement.rotationDeg}
								min={-180}
								max={180}
								step={FINE_SLIDER_STEP}
								decimals={1}
								suffix="°"
								onChange={(v) => updateActivePlacement({ rotationDeg: v })}
							/>
						</div>
						<Slider
							type="single"
							value={activePlacement.rotationDeg}
							onValueChange={(v: number) => updateActivePlacement({ rotationDeg: v })}
							min={-180}
							max={180}
							step={FINE_SLIDER_STEP}
							class="w-full"
						/>
					</div>
					<div class="grid gap-1.5">
						<div class="flex items-center justify-between">
							<span class="text-xs font-medium text-slate-700">Curve</span>
							<EditableNumericValue
								value={activePlacement.curve}
								min={-120}
								max={120}
								step={FINE_SLIDER_STEP}
								decimals={1}
								onChange={(v) => updateActivePlacement({ curve: v })}
							/>
						</div>
						<Slider
							type="single"
							value={activePlacement.curve}
							onValueChange={(v: number) => updateActivePlacement({ curve: v })}
							min={-120}
							max={120}
							step={FINE_SLIDER_STEP}
							class="w-full"
						/>
					</div>
					<div class="grid gap-1.5">
						<div class="flex items-center justify-between">
							<span class="text-xs font-medium text-slate-700">Char spacing</span>
							<EditableNumericValue
								value={activePlacement.charSpacing}
								min={-2}
								max={10}
								step={0.1}
								decimals={1}
								suffix=" mm"
								onChange={(v) => updateActivePlacement({ charSpacing: v })}
							/>
						</div>
						<Slider
							type="single"
							value={activePlacement.charSpacing}
							onValueChange={(v: number) => updateActivePlacement({ charSpacing: v })}
							min={-2}
							max={10}
							step={0.1}
							class="w-full"
						/>
					</div>

					<div class="space-y-2 rounded-lg border border-indigo-100 bg-indigo-50/40 p-3">
						<p class="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Text box</p>
						<p class="text-[11px] leading-snug text-slate-500">
							Name fits inside the box at the designed size. Outline shown in preview only.
						</p>
						<div class="grid gap-1.5">
							<div class="flex items-center justify-between">
								<span class="text-xs font-medium text-slate-700">Box width</span>
								<EditableNumericValue
									value={activePlacement.boxWidth}
									min={12}
									max={90}
									step={FINE_SLIDER_STEP}
									decimals={1}
									suffix=" mm"
									onChange={(v) => updateActivePlacement({ boxWidth: v })}
								/>
							</div>
							<Slider
								type="single"
								value={activePlacement.boxWidth}
								onValueChange={(v: number) => updateActivePlacement({ boxWidth: v })}
								min={12}
								max={90}
								step={FINE_SLIDER_STEP}
								class="w-full"
							/>
						</div>
						<div class="grid gap-1.5">
							<div class="flex items-center justify-between">
								<span class="text-xs font-medium text-slate-700">Box height</span>
								<EditableNumericValue
									value={activePlacement.boxHeight}
									min={4}
									max={40}
									step={FINE_SLIDER_STEP}
									decimals={1}
									suffix=" mm"
									onChange={(v) => updateActivePlacement({ boxHeight: v })}
								/>
							</div>
							<Slider
								type="single"
								value={activePlacement.boxHeight}
								onValueChange={(v: number) => updateActivePlacement({ boxHeight: v })}
								min={4}
								max={40}
								step={FINE_SLIDER_STEP}
								class="w-full"
							/>
						</div>
						<label class="grid gap-1">
							<span class="text-xs font-medium text-slate-700">Justify</span>
							<select
								class="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
								value={activePlacement.boxJustify}
								onchange={(e) =>
									updateActivePlacement({
										boxJustify: (e.currentTarget as HTMLSelectElement).value as TextBoxJustify
									})}
							>
								<option value="left">Left</option>
								<option value="center">Center</option>
								<option value="right">Right</option>
							</select>
						</label>
						<label class="grid gap-1">
							<span class="text-xs font-medium text-slate-700">Vertical align</span>
							<select
								class="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
								value={activePlacement.boxAlign}
								onchange={(e) =>
									updateActivePlacement({
										boxAlign: (e.currentTarget as HTMLSelectElement).value as TextBoxAlign
									})}
							>
								<option value="bottom">Bottom</option>
								<option value="center">Center</option>
								<option value="top">Top</option>
							</select>
						</label>
					</div>
					{/key}
				</div>

				<div class="space-y-3">
					<div class="flex items-center justify-between gap-2">
						<p class="text-xs font-semibold uppercase tracking-wide text-slate-500">Mounting</p>
						<span
							class="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-800"
							title="Hole and keyring settings are saved separately per letter A–Z"
						>
							{activePlacementKey}
						</span>
					</div>
					<div class="flex gap-2">
						<Button
							variant={activeMounting.mode === 'hole' ? 'default' : 'outline'}
							size="sm"
							class="flex-1"
							onclick={() => updateActiveMounting({ mode: 'hole' })}
						>
							Hole
						</Button>
						<Button
							variant={activeMounting.mode === 'keyring' ? 'default' : 'outline'}
							size="sm"
							class="flex-1"
							onclick={() => updateActiveMounting({ mode: 'keyring' })}
						>
							Keyring
						</Button>
					</div>
					<p class="text-[11px] leading-snug text-slate-500">
						Each letter stores both hole and keyring settings. Switching modes keeps your values.
					</p>

					{#if activeMounting.mode === 'hole'}
						<p class="text-[11px] leading-snug text-slate-500">
							Cuts through outline and initial layers. Amber circle is preview only.
						</p>
						<div class="grid gap-1.5">
							<div class="flex items-center justify-between">
								<span class="text-xs font-medium text-slate-700">Hole diameter</span>
								<EditableNumericValue
									value={activeHole.diameter}
									min={2}
									max={12}
									step={FINE_SLIDER_STEP}
									decimals={1}
									suffix=" mm"
									onChange={(v) => updateActiveHole({ diameter: v })}
								/>
							</div>
							<Slider
								type="single"
								value={activeHole.diameter}
								onValueChange={(v: number) => updateActiveHole({ diameter: v })}
								min={2}
								max={12}
								step={FINE_SLIDER_STEP}
								class="w-full"
							/>
						</div>
						<div class="grid grid-cols-2 gap-3">
							<div class="grid gap-1.5">
								<div class="flex items-center justify-between">
									<span class="text-xs font-medium text-slate-700">Offset X</span>
									<EditableNumericValue
										value={activeHole.offsetX}
										min={-60}
										max={60}
										step={FINE_SLIDER_STEP}
										decimals={1}
										onChange={(v) => updateActiveHole({ offsetX: v })}
									/>
								</div>
								<Slider
									type="single"
									value={activeHole.offsetX}
									onValueChange={(v: number) => updateActiveHole({ offsetX: v })}
									min={-60}
									max={60}
									step={FINE_SLIDER_STEP}
									class="w-full"
								/>
							</div>
							<div class="grid gap-1.5">
								<div class="flex items-center justify-between">
									<span class="text-xs font-medium text-slate-700">Offset Y</span>
									<EditableNumericValue
										value={activeHole.offsetY}
										min={-60}
										max={60}
										step={FINE_SLIDER_STEP}
										decimals={1}
										onChange={(v) => updateActiveHole({ offsetY: v })}
									/>
								</div>
								<Slider
									type="single"
									value={activeHole.offsetY}
									onValueChange={(v: number) => updateActiveHole({ offsetY: v })}
									min={-60}
									max={60}
									step={FINE_SLIDER_STEP}
									class="w-full"
								/>
							</div>
						</div>
					{:else}
						<p class="text-[11px] leading-snug text-slate-500">
							Unions a keyring tab into the outline shape at the top-left edge of the letter.
							Amber rings are preview only.
						</p>
						<div class="grid grid-cols-2 gap-3">
							<div class="grid gap-1.5">
								<div class="flex items-center justify-between">
									<span class="text-xs font-medium text-slate-700">Outer size</span>
									<EditableNumericValue
										value={activeKeyring.outerSize}
										min={4}
										max={16}
										step={FINE_SLIDER_STEP}
										decimals={1}
										suffix=" mm"
										onChange={(v) => updateActiveKeyring({ outerSize: v })}
									/>
								</div>
								<Slider
									type="single"
									value={activeKeyring.outerSize}
									onValueChange={(v: number) => updateActiveKeyring({ outerSize: v })}
									min={4}
									max={16}
									step={FINE_SLIDER_STEP}
									class="w-full"
								/>
							</div>
							<div class="grid gap-1.5">
								<div class="flex items-center justify-between">
									<span class="text-xs font-medium text-slate-700">Hole size</span>
									<EditableNumericValue
										value={activeKeyring.holeSize}
										min={2}
										max={12}
										step={FINE_SLIDER_STEP}
										decimals={1}
										suffix=" mm"
										onChange={(v) => updateActiveKeyring({ holeSize: v })}
									/>
								</div>
								<Slider
									type="single"
									value={activeKeyring.holeSize}
									onValueChange={(v: number) => updateActiveKeyring({ holeSize: v })}
									min={2}
									max={12}
									step={FINE_SLIDER_STEP}
									class="w-full"
								/>
							</div>
						</div>
						<div class="grid gap-1.5">
							<div class="flex items-center justify-between">
								<span class="text-xs font-medium text-slate-700">Keyring depth</span>
								<EditableNumericValue
									value={activeKeyring.depth}
									min={1}
									max={12}
									step={FINE_SLIDER_STEP}
									decimals={1}
									suffix=" mm"
									onChange={(v) => updateActiveKeyring({ depth: v })}
								/>
							</div>
							<Slider
								type="single"
								value={activeKeyring.depth}
								onValueChange={(v: number) => updateActiveKeyring({ depth: v })}
								min={1}
								max={12}
								step={FINE_SLIDER_STEP}
								class="w-full"
							/>
						</div>
						<div class="grid grid-cols-2 gap-3">
							<div class="grid gap-1.5">
								<div class="flex items-center justify-between">
									<span class="text-xs font-medium text-slate-700">Offset X</span>
									<EditableNumericValue
										value={activeKeyring.offsetX}
										min={-60}
										max={60}
										step={FINE_SLIDER_STEP}
										decimals={1}
										onChange={(v) => updateActiveKeyring({ offsetX: v })}
									/>
								</div>
								<Slider
									type="single"
									value={activeKeyring.offsetX}
									onValueChange={(v: number) => updateActiveKeyring({ offsetX: v })}
									min={-60}
									max={60}
									step={FINE_SLIDER_STEP}
									class="w-full"
								/>
							</div>
							<div class="grid gap-1.5">
								<div class="flex items-center justify-between">
									<span class="text-xs font-medium text-slate-700">Offset Y</span>
									<EditableNumericValue
										value={activeKeyring.offsetY}
										min={-60}
										max={60}
										step={FINE_SLIDER_STEP}
										decimals={1}
										onChange={(v) => updateActiveKeyring({ offsetY: v })}
									/>
								</div>
								<Slider
									type="single"
									value={activeKeyring.offsetY}
									onValueChange={(v: number) => updateActiveKeyring({ offsetY: v })}
									min={-60}
									max={60}
									step={FINE_SLIDER_STEP}
									class="w-full"
								/>
							</div>
						</div>
					{/if}
				</div>
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div class="absolute top-28 left-4 z-10">
				<Button
					variant={topViewEnabled ? 'default' : 'outline'}
					size="sm"
					onclick={() => (topViewEnabled = !topViewEnabled)}
				>
					{topViewEnabled ? 'Perspective view' : 'Top view'}
				</Button>
			</div>
			<div bind:this={hostEl} class="absolute inset-0"></div>
			<div class="absolute right-4 bottom-4">
				<DesignerExportToolbar
					onExport={() => exportSTL()}
					onExport3MF={() => export3MF()}
					onOpenWithSlicer={openWithSlicerHandler}
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'letter-rail')}
					exportDisabled={exportLoading}
					exportTitle={getExportTitle(user, subscriptionStatus)}
					showLockIcon={showExportLockIcon(user, subscriptionStatus)}
					{exportLoading}
					{openWithSlicerLoading}
				/>
			</div>
		</section>
	</div>
</main>
