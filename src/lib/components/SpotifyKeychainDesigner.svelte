<script lang="ts">
	import spotifyBaseObjUrl from '$lib/assets/stl/spotify/base.obj?url';
	import type { PaletteColor } from '$lib/colorPalette';
	import { Button } from '$lib/components/ui/button';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { notifyExportEvent } from '$lib/exportNotify';
	import {
		buildSpotifyCodeBarGeometryFromLayout,
		decodeSpotifyCodePngToLayout,
		isSpotifyCodeLayout,
		parseSpotifyCodeSvgToLayout,
		parseSpotifyUri,
		validateSpotifyCodeLayout,
		type SpotifyCodeLayout
	} from '$lib/spotifyKeychain';
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import {
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		frameCameraToObject,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
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

	/** OBJ group_0 = logo bottom, group_1 = main plate, group_2 = top logo */
	type BasePartKey = 'logoBottom' | 'main' | 'logoTop';

	const PART_ORDER: BasePartKey[] = ['logoBottom', 'main', 'logoTop'];
	const BAR_DEPTH_MM = 0.6;
	const BAR_SURFACE_EMBED = 0.02;
	const BAR_OFFSET = { x: 8.4, y: 0, z: 0 };
	const BAR_SCALE = 0.67;
	const DEFAULT_MAIN_THICKNESS_MM = 1.4;
	const BASE_THICKNESS_MIN_MM = 0.8;
	const BASE_THICKNESS_MAX_MM = 4;
	const MAIN_TOP_ATTACH_EPS_MM = 0.02;
	const LOGO_COLOR = '#1db954';
	const DEFAULT_SPOTIFY_URL = 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8';
	const STORAGE_KEY_CODE_CACHE = 'spotify-keychain-code-cache-v2';
	const BARS_MESH_NAME = 'spotify-code-bars';

	interface SpotifyCodeCache {
		uri: string;
		url: string;
		layout: SpotifyCodeLayout;
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

	let baseParts = $state<Record<BasePartKey, THREE.BufferGeometry> | null>(null);
	let loadError = $state<string | null>(null);
	let sceneReady = $state(false);

	let spotifyUrl = $state('');
	let spotifyUri = $state<string | null>(null);
	let codeLayout = $state<SpotifyCodeLayout | null>(null);
	let codeError = $state<string | null>(null);
	let loadingCode = $state(false);

	let baseColor = $state('#000000');
	let baseThicknessMm = $state(DEFAULT_MAIN_THICKNESS_MM);
	let barColorOption = $state<'white' | 'black'>('white');
	const barColor = $derived(barColorOption === 'white' ? '#ffffff' : '#000000');

	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);

	const parsedUriPreview = $derived(parseSpotifyUri(spotifyUrl));
	const hasPreviewCode = $derived((codeLayout?.bars.length ?? 0) > 0);

	let codeHydrated = false;
	/** Top Z of the main plate in source OBJ space (logo layers stack above this). */
	let nativeMainTopMm = DEFAULT_MAIN_THICKNESS_MM;

	function loadCodeCache(): SpotifyCodeCache | null {
		try {
			const raw = localStorage.getItem(STORAGE_KEY_CODE_CACHE);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as SpotifyCodeCache;
			if (parsed?.uri && Array.isArray(parsed.layout?.bars) && parsed.layout.bars.length > 0) {
				return parsed;
			}
		} catch {
			// ignore corrupt cache
		}
		return null;
	}

	function saveCodeCache(cache: SpotifyCodeCache) {
		try {
			localStorage.setItem(STORAGE_KEY_CODE_CACHE, JSON.stringify(cache));
		} catch {
			// storage full or unavailable
		}
	}

	function meshToWorldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
		const g = mesh.geometry.clone();
		mesh.updateWorldMatrix(true, false);
		g.applyMatrix4(mesh.matrixWorld);
		return g;
	}

	function extractBaseParts(root: THREE.Object3D): Record<BasePartKey, THREE.BufferGeometry> | null {
		const meshes: THREE.Mesh[] = [];
		root.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
		});
		if (meshes.length < 3) return null;

		const byIndex = new Map<number, THREE.Mesh>();
		for (const mesh of meshes) {
			const m = /^group_(\d+)_/i.exec(mesh.name);
			if (m) byIndex.set(Number(m[1]), mesh);
		}

		const parts = {} as Record<BasePartKey, THREE.BufferGeometry>;
		for (let i = 0; i < PART_ORDER.length; i++) {
			const key = PART_ORDER[i];
			const mesh = byIndex.get(i);
			if (!mesh) return null;
			parts[key] = meshToWorldGeometry(mesh);
		}
		return parts;
	}

	function initMainPlateMetrics(main: THREE.BufferGeometry) {
		main.computeBoundingBox();
		const box = main.boundingBox;
		if (!box) return;
		nativeMainTopMm = box.max.z;
		baseThicknessMm = Math.max(
			BASE_THICKNESS_MIN_MM,
			Math.min(BASE_THICKNESS_MAX_MM, box.max.z - box.min.z)
		);
	}

	/** Scale main plate height from its bottom face; returns Z shift applied to the top face. */
	function scaleMainPlateThickness(geo: THREE.BufferGeometry, targetMm: number): number {
		geo.computeBoundingBox();
		const box = geo.boundingBox;
		if (!box) return 0;
		const nativeH = box.max.z - box.min.z;
		const oldTop = box.max.z;
		if (nativeH <= 1e-6) return 0;

		const clamped = Math.max(BASE_THICKNESS_MIN_MM, Math.min(BASE_THICKNESS_MAX_MM, targetMm));
		const scale = clamped / nativeH;
		const pos = geo.attributes.position as THREE.BufferAttribute;
		for (let i = 0; i < pos.count; i++) {
			const z = pos.getZ(i);
			pos.setZ(i, box.min.z + (z - box.min.z) * scale);
		}
		pos.needsUpdate = true;
		geo.computeBoundingBox();
		return (geo.boundingBox?.max.z ?? oldTop) - oldTop;
	}

	function clonePartWithBaseThickness(key: BasePartKey, zShift: number): THREE.BufferGeometry {
		const geo = baseParts![key].clone();
		if (key === 'main') {
			scaleMainPlateThickness(geo, baseThicknessMm);
			return geo;
		}
		geo.computeBoundingBox();
		const box = geo.boundingBox;
		if (box && box.min.z >= nativeMainTopMm - MAIN_TOP_ATTACH_EPS_MM) {
			geo.translate(0, 0, zShift);
		}
		return geo;
	}

	function cloneMainPlateForBars(): THREE.BufferGeometry {
		const geo = baseParts!.main.clone();
		scaleMainPlateThickness(geo, baseThicknessMm);
		return geo;
	}

	function centerAssemblyOnOrigin(assembly: THREE.Group) {
		const box = new THREE.Box3();
		let hasGeometry = false;
		assembly.traverse((node) => {
			if (!(node as THREE.Mesh).isMesh) return;
			box.expandByObject(node);
			hasGeometry = true;
		});
		if (!hasGeometry) return;
		const center = new THREE.Vector3();
		box.getCenter(center);
		assembly.position.set(-center.x, -center.y, -box.min.z);
	}

	function createMainBaseMaterial(colorHex: string): THREE.MeshStandardMaterial {
		return new THREE.MeshStandardMaterial({
			color: colorHex,
			roughness: 0.75,
			metalness: 0.1
		});
	}

	/** Logo bottom layer and scannable code bars (white or black). */
	function createBarColorMaterial(colorHex: string): THREE.MeshStandardMaterial {
		return new THREE.MeshStandardMaterial({
			color: colorHex,
			roughness: 0.75,
			metalness: 0.1
		});
	}

	function createLogoTopMaterial(): THREE.MeshStandardMaterial {
		return new THREE.MeshStandardMaterial({
			color: LOGO_COLOR,
			roughness: 0.75,
			metalness: 0.1
		});
	}

	function loadObj(url: string): Promise<THREE.Object3D> {
		return new Promise((resolve, reject) => {
			const loader = new OBJLoader();
			loader.load(url, resolve, undefined, reject);
		});
	}

	function addCodeBars(
		assembly: THREE.Group,
		mainGeo: THREE.BufferGeometry,
		layout: SpotifyCodeLayout,
		barMat: THREE.Material
	) {
		mainGeo.computeBoundingBox();
		const plate = mainGeo.boundingBox;
		if (!plate) return;

		const barGeo = buildSpotifyCodeBarGeometryFromLayout(
			layout,
			plate.min.x,
			plate.min.y,
			plate.max.x - plate.min.x,
			plate.max.y - plate.min.y,
			plate.max.z,
			{
				depth: BAR_DEPTH_MM,
				surfaceEmbed: BAR_SURFACE_EMBED + BAR_OFFSET.z,
				offsetX: BAR_OFFSET.x,
				offsetY: BAR_OFFSET.y,
				offsetZ: 0,
				scale: BAR_SCALE
			}
		);
		if (!barGeo) {
			const validation = validateSpotifyCodeLayout(layout);
			if (!validation.ok) {
				codeError = validation.message ?? 'Could not build scannable code bars';
			}
			return;
		}

		const mesh = new THREE.Mesh(barGeo, barMat);
		mesh.name = BARS_MESH_NAME;
		mesh.castShadow = false;
		mesh.receiveShadow = false;
		assembly.add(mesh);
	}

	function rebuildMeshes() {
		if (!group || !baseParts) return;
		disposeObject3D(group);
		group.clear();
		modelAabbMm = null;

		const assembly = new THREE.Group();
		const mainBaseMat = createMainBaseMaterial(baseColor);
		const barColorMat = createBarColorMaterial(barColor);
		const logoTopMat = createLogoTopMaterial();

		const mainProbe = baseParts.main.clone();
		const zShift = scaleMainPlateThickness(mainProbe, baseThicknessMm);
		mainProbe.dispose();

		for (const key of PART_ORDER) {
			const geo = clonePartWithBaseThickness(key, zShift);
			geo.computeVertexNormals();
			const partMat =
				key === 'logoTop'
					? logoTopMat
					: key === 'logoBottom'
						? barColorMat
						: mainBaseMat;
			const mesh = new THREE.Mesh(geo, partMat);
			mesh.name = `base-${key}`;
			mesh.castShadow = key !== 'logoTop';
			mesh.receiveShadow = key !== 'logoTop';
			assembly.add(mesh);
		}

		if (codeLayout) {
			addCodeBars(assembly, cloneMainPlateForBars(), codeLayout, barColorMat);
		}

		centerAssemblyOnOrigin(assembly);
		group.add(assembly);

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

	function isPngBytes(buffer: ArrayBuffer): boolean {
		if (buffer.byteLength < 8) return false;
		const b = new Uint8Array(buffer);
		return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
	}

	async function fetchSpotifyCodeLayout(uri: string): Promise<SpotifyCodeLayout> {
		const res = await fetch(`/api/spotify-code?uri=${encodeURIComponent(uri)}`, {
			cache: 'no-store',
			headers: { Accept: 'application/json, image/svg+xml, image/png' }
		});
		const buffer = await res.arrayBuffer();

		if (isPngBytes(buffer)) {
			if (!res.ok) throw new Error('Failed to load Spotify code');
			return decodeSpotifyCodePngToLayout(buffer);
		}

		const text = new TextDecoder().decode(buffer);

		if (!res.ok) {
			try {
				const err = JSON.parse(text) as { error?: string };
				throw new Error(err.error ?? 'Failed to load Spotify code');
			} catch (e) {
				if (e instanceof Error && e.message !== 'Failed to load Spotify code') throw e;
				throw new Error('Failed to load Spotify code');
			}
		}

		if (text.trimStart().startsWith('{')) {
			try {
				const body = JSON.parse(text) as unknown;
				if (isSpotifyCodeLayout(body)) return body;
				if (body && typeof body === 'object' && 'error' in body) {
					const message = (body as { error?: string }).error;
					throw new Error(message ?? 'Failed to load Spotify code');
				}
			} catch (e) {
				if (!(e instanceof SyntaxError)) throw e;
			}
		}

		if (text.trimStart().startsWith('<svg')) {
			const layout = parseSpotifyCodeSvgToLayout(text);
			if (layout) {
				const validation = validateSpotifyCodeLayout(layout);
				if (validation.ok) return layout;
				throw new Error(validation.message ?? 'Incomplete Spotify code');
			}
		}

		throw new Error('Unexpected response from Spotify code service — hard refresh and try again');
	}

	async function applySpotifyCode(uri: string, urlForCache: string, persist = true) {
		codeError = null;
		loadingCode = true;
		try {
			const layout = await fetchSpotifyCodeLayout(uri);
			const validation = validateSpotifyCodeLayout(layout);
			if (!validation.ok) {
				throw new Error(validation.message ?? 'Invalid Spotify code image');
			}
			spotifyUri = uri;
			codeLayout = layout;
			codeError = null;
			if (persist) {
				saveCodeCache({ uri, url: urlForCache, layout });
			}
		} catch (e) {
			codeLayout = null;
			codeError = e instanceof Error ? e.message : 'Failed to load Spotify code';
		} finally {
			loadingCode = false;
		}
	}

	async function hydratePreviewCode() {
		const cached = loadCodeCache();
		if (cached) {
			const validation = validateSpotifyCodeLayout(cached.layout);
			if (validation.ok) {
				spotifyUri = cached.uri;
				codeLayout = cached.layout;
				codeError = null;
				return;
			}
		}
		const defaultUri = parseSpotifyUri(DEFAULT_SPOTIFY_URL);
		if (!defaultUri) return;
		await applySpotifyCode(defaultUri, DEFAULT_SPOTIFY_URL);
	}

	async function loadSpotifyCode() {
		const uri = parseSpotifyUri(spotifyUrl);
		if (!uri) {
			codeError = 'Paste a valid Spotify album, track, playlist, or artist link';
			return;
		}
		await applySpotifyCode(uri, spotifyUrl.trim());
	}

	function buildExportGroup(): THREE.Group {
		if (!group) throw new Error('Scene not ready');
		group.updateWorldMatrix(true, true);
		const exportGroup = new THREE.Group();
		group.traverse((node) => {
			if (!(node as THREE.Mesh).isMesh) return;
			const mesh = node as THREE.Mesh;
			const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
			const mat = mesh.material as THREE.MeshStandardMaterial;
			const color = mat?.color?.clone() ?? new THREE.Color(0xffffff);
			const exportMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
			exportMesh.name = mesh.name;
			exportGroup.add(exportMesh);
		});
		exportGroup.updateWorldMatrix(true, true);
		return exportGroup;
	}

	function mergeExportGeometry(): THREE.BufferGeometry | null {
		if (!group) return null;
		const geometries: THREE.BufferGeometry[] = [];
		group.updateWorldMatrix(true, true);
		group.traverse((child) => {
			if (!(child as THREE.Mesh).isMesh) return;
			const mesh = child as THREE.Mesh;
			let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
			if (g.attributes.uv) g.deleteAttribute('uv');
			if (!g.attributes.normal) g.computeVertexNormals();
			if (g.index) {
				const nonIndexed = g.toNonIndexed();
				g.dispose();
				g = nonIndexed;
			}
			geometries.push(g);
		});
		if (geometries.length === 0) return null;

		const merged =
			geometries.length === 1 ? geometries[0] : BufferGeometryUtils.mergeGeometries(geometries);
		if (!merged) {
			geometries.forEach((g) => g.dispose());
			return null;
		}
		if (geometries.length > 1) geometries.forEach((g) => g.dispose());
		const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
		if (welded !== merged) merged.dispose();
		return welded;
	}

	async function exportStl() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		if (!group || !hasPreviewCode) {
			exportError = 'Load a Spotify code before exporting';
			return;
		}
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const welded = mergeExportGeometry();
			if (!welded) {
				exportError = 'Nothing to export';
				return;
			}

			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
			welded.dispose();
			const buffer = result instanceof DataView ? result.buffer : result;
			if (!buffer || (buffer as ArrayBuffer).byteLength < 84) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			const slug = spotifyUri?.replace(/[^a-zA-Z0-9]+/g, '-') ?? 'spotify-keychain';
			downloadBlob(`spotify-keychain-${slug}-${ts}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Spotify Keychain',
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
		if (!codeLayout) {
			exportError = 'Load a Spotify code before exporting';
			return;
		}
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
			const slug = spotifyUri?.replace(/[^a-zA-Z0-9]+/g, '-') ?? 'spotify-keychain';
			downloadBlob(`spotify-keychain-${slug}-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Spotify Keychain',
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
		if (!codeLayout) return;
		openBambuStudioLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'spotify-keychain');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Spotify Keychain',
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
		void sceneReady;
		void baseParts;
		void codeLayout;
		void baseColor;
		void baseThicknessMm;
		void barColorOption;
		if (!scene || !group || !sceneReady || !baseParts) return;
		if (!codeHydrated) {
			codeHydrated = true;
			void hydratePreviewCode();
		}
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
		scene.add(fillLight.target);

		group = new THREE.Group();
		scene.add(group);

		const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
		grid.rotateX(Math.PI / 2);
		grid.position.z = -0.01;
		scene.add(grid);

		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();

		loadObj(spotifyBaseObjUrl)
			.then((root) => {
				const parts = extractBaseParts(root);
				if (!parts) throw new Error('Could not parse Spotify base model');
				initMainPlateMetrics(parts.main);
				baseParts = parts;
				loadError = null;
				sceneReady = true;
				didInitFrame = false;
				if (group && baseParts) rebuildMeshes();
			})
			.catch((err) => {
				loadError = err instanceof Error ? err.message : 'Failed to load base model';
			});

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

	function resize() {
		if (!renderer || !camera || !hostEl) return;
		const rect = hostEl.getBoundingClientRect();
		const w = Math.max(1, Math.floor(rect.width));
		const h = Math.max(1, Math.floor(rect.height));
		renderer.setSize(w, h, true);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		rafId = 0;
		if (baseParts) {
			for (const geo of Object.values(baseParts)) geo.dispose();
		}
		baseParts = null;
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
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Spotify Keychain</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<p class="text-xs text-slate-500">
					Paste a Spotify album, track, playlist, or artist link. The scannable code bars are
					generated from Spotify Codes and placed on the base plate.
				</p>

				{#if loadError}
					<p class="text-sm text-red-600">{loadError}</p>
				{/if}

				<div>
					<label for="spotify-url" class="mb-1 block text-xs font-medium text-slate-700">
						Spotify link
					</label>
					<input
						id="spotify-url"
						type="url"
						placeholder="Paste a link, or leave empty for saved preview"
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
						bind:value={spotifyUrl}
					/>
					<p class="mt-1 text-[11px] text-slate-500">
						Leave empty to show your saved code.
					</p>
					{#if hasPreviewCode && !spotifyUrl.trim()}
						<p class="mt-1 text-[11px] text-emerald-700">Showing saved Spotify code preview.</p>
					{/if}
					{#if parsedUriPreview}
						<p class="mt-1 text-[11px] text-slate-500">URI: {parsedUriPreview}</p>
					{/if}
					<Button
						class="mt-2 w-full"
						disabled={!parsedUriPreview || loadingCode || !sceneReady}
						onclick={() => loadSpotifyCode()}
					>
						{loadingCode ? 'Loading code…' : 'Load Spotify code'}
					</Button>
					{#if codeError}
						<p class="mt-1 text-sm text-red-600">{codeError}</p>
					{/if}
				</div>

				<ColorPalettePicker bind:value={baseColor} {palette} label="Rectangular base color" />

				<div>
					<div class="mb-1 flex items-center justify-between gap-2">
						<label for="spotify-base-thickness" class="text-xs font-medium text-slate-700">
							Base thickness
						</label>
						<span class="text-xs text-slate-500">{baseThicknessMm.toFixed(1)} mm</span>
					</div>
					<input
						id="spotify-base-thickness"
						type="range"
						min={BASE_THICKNESS_MIN_MM}
						max={BASE_THICKNESS_MAX_MM}
						step="0.1"
						bind:value={baseThicknessMm}
						disabled={!sceneReady}
						class="w-full accent-indigo-600"
					/>
				</div>

				<div>
					<p class="mb-1 text-xs font-medium text-slate-700">Code bars</p>
					<div class="flex items-center gap-4">
						<label class="flex cursor-pointer items-center gap-1.5">
							<input
								type="radio"
								name="spotify-bar-color"
								value="white"
								bind:group={barColorOption}
							/>
							<span class="text-xs text-slate-700">White</span>
						</label>
						<label class="flex cursor-pointer items-center gap-1.5">
							<input
								type="radio"
								name="spotify-bar-color"
								value="black"
								bind:group={barColorOption}
							/>
							<span class="text-xs text-slate-700">Black</span>
						</label>
					</div>
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
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'spotify-keychain')}
					onExport={() => exportStl()}
					exportDisabled={!sceneReady || !hasPreviewCode || exportLoading}
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
</main>
