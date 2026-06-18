<script lang="ts">
	import { openInSlicer, type OpenWithSlicerId } from '$lib/openInSlicer';
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import textblockObjUrl from '$lib/assets/stl/textblock.obj?url';
	import FontSelect from '$lib/components/FontSelect.svelte';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import type { PaletteColor } from '$lib/colorPalette';
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
	import {
		ensureExportAccess,
		getExportTitle,
		showExportLockIcon,
		type SubscriptionStatus
	} from '$lib/subscription';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';

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

	/** Clear gap between chained bases (mm); was negative overlap from articulated keychain. */
	const BLOCK_GAP_MM = 1;
	const FONT_SIZE_FOR_SHAPES = 12;
	const LETTER_TARGET_HEIGHT_MM = 6.5;
	const TEXT_SURFACE_EMBED = 0.02;

	const BLOCK_FONT_KEYS = new Set([
		'Titan One_Regular',
		'Showpop_Regular',
		'Kindergo_Regular',
		'Milkyway_Regular',
		'DynaPuff_Bold',
		'Coiny_Regular',
		'Roadside Sans_Regular'
	]);
	const BLOCK_FONT_OPTIONS = FONT_OPTIONS.filter((o) => BLOCK_FONT_KEYS.has(o.key));

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

	let baseParts = $state<{ frame: THREE.BufferGeometry; inset: THREE.BufferGeometry } | null>(
		null
	);
	let loadError = $state<string | null>(null);
	let sceneReady = $state(false);

	let textContent = $state('Name');
	let fontKey = $state(BLOCK_FONT_OPTIONS[0]?.key ?? 'Titan One_Regular');
	let textScale = $state(1);
	let textDepth = $state(1);
	let frameColor = $state('#3b82f6');
	let insetColor = $state('#e2e8f0');
	let textColor = $state('#3b82f6');

	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openWithSlicerLoading = $state(false);

	function sanitizeText(raw: string): string {
		return (raw ?? '')
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, '')
			.slice(0, 24);
	}

	function blockLettersFromText(raw: string): string[] {
		return [...sanitizeText(raw)];
	}

	function meshToWorldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
		const g = mesh.geometry.clone();
		mesh.updateWorldMatrix(true, false);
		g.applyMatrix4(mesh.matrixWorld);
		return g;
	}

	/** OBJ group_0 = outer frame, group_1 = character background pads. */
	function extractTextBlockParts(root: THREE.Object3D): {
		frame: THREE.BufferGeometry;
		inset: THREE.BufferGeometry;
	} | null {
		const byIndex = new Map<number, THREE.Mesh>();
		root.updateWorldMatrix(true, true);
		root.traverse((node) => {
			const mesh = node as THREE.Mesh;
			if (!mesh.isMesh || !mesh.geometry) return;
			const m = /^group_(\d+)_/i.exec(mesh.name);
			if (m) byIndex.set(Number(m[1]), mesh);
		});
		const frameMesh = byIndex.get(0);
		const insetMesh = byIndex.get(1);
		if (!frameMesh || !insetMesh) return null;
		return {
			frame: meshToWorldGeometry(frameMesh),
			inset: meshToWorldGeometry(insetMesh)
		};
	}

	function normalizeOffsetForParts(frame: THREE.BufferGeometry, inset: THREE.BufferGeometry) {
		const box = new THREE.Box3();
		frame.computeBoundingBox();
		inset.computeBoundingBox();
		if (frame.boundingBox) box.union(frame.boundingBox);
		if (inset.boundingBox) box.union(inset.boundingBox);
		return new THREE.Vector3(-box.min.x, -box.min.y, -box.min.z);
	}

	function applyNormalizeOffset(geo: THREE.BufferGeometry, offset: THREE.Vector3) {
		geo.translate(offset.x, offset.y, offset.z);
		geo.computeBoundingBox();
		geo.computeVertexNormals();
	}

	function prepareTextBlockTemplates(parts: { frame: THREE.BufferGeometry; inset: THREE.BufferGeometry }) {
		const offset = normalizeOffsetForParts(parts.frame, parts.inset);
		applyNormalizeOffset(parts.frame, offset);
		applyNormalizeOffset(parts.inset, offset);
		return parts;
	}

	function cloneNormalizedPart(template: THREE.BufferGeometry): THREE.BufferGeometry {
		const geo = template.clone();
		geo.computeBoundingBox();
		geo.computeVertexNormals();
		return geo;
	}

	function blockTextZones(frameBb: THREE.Box3, insetBb: THREE.Box3) {
		const yMid = (frameBb.min.y + frameBb.max.y) / 2;
		const cx = (frameBb.min.x + frameBb.max.x) / 2;
		const faceZ = insetBb.max.z;
		return {
			top: new THREE.Vector3(cx, (yMid + frameBb.max.y) / 2, faceZ),
			bottom: new THREE.Vector3(cx, (frameBb.min.y + yMid) / 2, faceZ)
		};
	}

	function addLetterOnBlock(
		assembly: THREE.Group,
		letter: string,
		zone: THREE.Vector3,
		inverted: boolean
	) {
		const font = getFont(fontKey);
		if (!font) return;
		const shapes = font.generateShapes(letter, FONT_SIZE_FOR_SHAPES);
		if (shapes.length === 0) return;

		const textGeo = new THREE.ExtrudeGeometry(shapes, {
			depth: Math.max(0.1, textDepth),
			bevelEnabled: false,
			curveSegments: 8
		});
		centerGeometryXY(textGeo);
		textGeo.computeBoundingBox();
		const tb = textGeo.boundingBox;
		if (!tb) return;

		const textW = Math.max(0.01, tb.max.x - tb.min.x);
		const textH = Math.max(0.01, tb.max.y - tb.min.y);
		const scaleXY = Math.min(
			(12 * 0.72) / textW,
			(12 * 0.72) / textH,
			(LETTER_TARGET_HEIGHT_MM * textScale) / textH
		);

		const textMat = new THREE.MeshStandardMaterial({
			color: textColor,
			roughness: 0.4,
			metalness: 0.1
		});
		const textMesh = new THREE.Mesh(textGeo, textMat);
		textMesh.name = inverted ? `letter-bottom-${letter}` : `letter-top-${letter}`;
		textMesh.castShadow = true;
		textMesh.receiveShadow = true;
		textMesh.scale.set(scaleXY, scaleXY, 1);
		if (inverted) {
			textMesh.rotation.z = Math.PI;
		}

		textMesh.position.set(zone.x, zone.y, zone.z + TEXT_SURFACE_EMBED);
		assembly.add(textMesh);
	}

	function centerAssemblyOnOrigin(assembly: THREE.Group) {
		const box = new THREE.Box3().setFromObject(assembly);
		if (box.isEmpty()) return;
		const center = new THREE.Vector3();
		box.getCenter(center);
		assembly.position.set(-center.x, -center.y, -box.min.z);
	}

	function rebuildMeshes() {
		if (!group || !baseParts) return;
		disposeObject3D(group);
		group.clear();
		modelAabbMm = null;

		const letters = blockLettersFromText(textContent);
		if (letters.length === 0) {
			group.updateWorldMatrix(true, true);
			return;
		}

		const assembly = new THREE.Group();
		const frameMat = new THREE.MeshStandardMaterial({
			color: frameColor,
			roughness: 0.75,
			metalness: 0.1
		});
		const insetMat = new THREE.MeshStandardMaterial({
			color: insetColor,
			roughness: 0.65,
			metalness: 0.05
		});

		let cursorX = 0;
		const frameProbe = cloneNormalizedPart(baseParts.frame);
		const insetProbe = cloneNormalizedPart(baseParts.inset);
		frameProbe.computeBoundingBox();
		insetProbe.computeBoundingBox();
		const frameProbeBb = frameProbe.boundingBox!;
		const blockWidth = Math.max(0.01, frameProbeBb.max.x - frameProbeBb.min.x);
		frameProbe.dispose();
		insetProbe.dispose();

		for (let i = 0; i < letters.length; i++) {
			const letter = letters[i]!;
			const frameGeo = cloneNormalizedPart(baseParts.frame);
			const insetGeo = cloneNormalizedPart(baseParts.inset);
			frameGeo.computeBoundingBox();
			insetGeo.computeBoundingBox();
			const frameBb = frameGeo.boundingBox!;
			const insetBb = insetGeo.boundingBox!;

			const basePos = new THREE.Vector3(cursorX, 0, 0);

			const frameMesh = new THREE.Mesh(frameGeo, frameMat.clone());
			frameMesh.name = `text-block-frame-${i}`;
			frameMesh.castShadow = true;
			frameMesh.receiveShadow = true;
			frameMesh.position.copy(basePos);
			assembly.add(frameMesh);

			const insetMesh = new THREE.Mesh(insetGeo, insetMat.clone());
			insetMesh.name = `text-block-inset-${i}`;
			insetMesh.castShadow = true;
			insetMesh.receiveShadow = true;
			insetMesh.position.copy(basePos);
			assembly.add(insetMesh);

			const localZones = blockTextZones(frameBb, insetBb);
			addLetterOnBlock(
				assembly,
				letter,
				new THREE.Vector3(
					basePos.x + localZones.top.x,
					basePos.y + localZones.top.y,
					basePos.z + localZones.top.z
				),
				false
			);
			addLetterOnBlock(
				assembly,
				letter,
				new THREE.Vector3(
					basePos.x + localZones.bottom.x,
					basePos.y + localZones.bottom.y,
					basePos.z + localZones.bottom.z
				),
				true
			);

			cursorX += blockWidth;
			if (i < letters.length - 1) {
				cursorX += BLOCK_GAP_MM;
			}
		}

		centerAssemblyOnOrigin(assembly);
		group.add(assembly);

		group.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(group);
		if (keyLight?.shadow?.camera && !box.isEmpty()) {
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
		if (!didInitFrame && camera && controls && !box.isEmpty()) {
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
			const sub = child as THREE.Object3D;
			sub.traverse((node) => {
				if (!(node as THREE.Mesh).isMesh) return;
				const mesh = node as THREE.Mesh;
				const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
				const mat = mesh.material as THREE.MeshStandardMaterial;
				const color = mat?.color?.clone() ?? new THREE.Color(0xffffff);
				const exportMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
				exportMesh.name = mesh.name;
				exportGroup.add(exportMesh);
			});
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
			const slug = sanitizeText(textContent) || 'text-blocks';
			downloadBlob(`text-blocks-${slug}-${ts}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Text Blocks',
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
			const slug = sanitizeText(textContent) || 'text-blocks';
			downloadBlob(`text-blocks-${slug}-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Text Blocks',
				format: '3mf'
			});
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	async function openWithSlicer(slicer: OpenWithSlicerId) {
		if (!group) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		openWithSlicerLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'text-blocks');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Text Blocks',
				format: 'bambu_studio'
			});
			openInSlicer(publicUrl, slicer);
		} catch (err) {
			console.error('Open with slicer failed:', err);
		} finally {
			openWithSlicerLoading = false;
		}
	}

	function loadObj(url: string): Promise<THREE.Object3D> {
		return new Promise((resolve, reject) => {
			const loader = new OBJLoader();
			loader.load(url, resolve, undefined, reject);
		});
	}

	$effect(() => {
		void sceneReady;
		void baseParts;
		void textContent;
		void fontKey;
		void textScale;
		void textDepth;
		void frameColor;
		void insetColor;
		void textColor;
		if (!scene || !group || !sceneReady || !baseParts) return;
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

		getFont(fontKey);

		loadObj(textblockObjUrl)
			.then((root) => {
				const parts = extractTextBlockParts(root);
				disposeObject3D(root);
				if (!parts) {
					loadError = 'Text block model must contain frame and inset meshes';
					return;
				}
				baseParts = prepareTextBlockTemplates(parts);
				loadError = null;
				sceneReady = true;
				didInitFrame = false;
				if (group && baseParts) rebuildMeshes();
			})
			.catch((err) => {
				loadError = err instanceof Error ? err.message : 'Failed to load text block model';
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
		baseParts?.frame.dispose();
		baseParts?.inset.dispose();
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
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Text Blocks</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<p class="text-xs text-slate-500">
					Each character gets its own block — same letter on top and inverted on the lower face
					(e.g. <strong>NAME</strong> → four blocks). A–Z and 0–9 only.
				</p>

				{#if loadError}
					<p class="text-sm text-red-600">{loadError}</p>
				{/if}

				<div>
					<label for="text-blocks-content" class="mb-1 block text-xs font-medium text-slate-700">
						Text
					</label>
					<input
						id="text-blocks-content"
						type="text"
						placeholder="NAME"
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
						bind:value={textContent}
					/>
					<p class="mt-1 text-[11px] text-slate-500">
						Preview: {sanitizeText(textContent) || '—'}
						({blockLettersFromText(textContent).length} block{blockLettersFromText(textContent).length ===
						1
							? ''
							: 's'})
					</p>
				</div>

				<div>
					<label for="text-blocks-font" class="mb-1 block text-xs font-medium text-slate-700">
						Letter font
					</label>
					<FontSelect id="text-blocks-font" bind:value={fontKey} options={BLOCK_FONT_OPTIONS} />
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="text-blocks-scale" class="text-xs font-medium text-slate-700">
							Letter scale
						</label>
						<span class="text-xs text-slate-500">{textScale.toFixed(1)}×</span>
					</div>
					<Slider
						id="text-blocks-scale"
						type="single"
						bind:value={textScale}
						min={0.3}
						max={2}
						step={0.1}
						class="w-full"
					/>
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="text-blocks-depth" class="text-xs font-medium text-slate-700">
							Letter depth
						</label>
						<span class="text-xs text-slate-500">{textDepth.toFixed(1)} mm</span>
					</div>
					<Slider
						id="text-blocks-depth"
						type="single"
						bind:value={textDepth}
						min={0.3}
						max={3}
						step={0.1}
						class="w-full"
					/>
				</div>

				<ColorPalettePicker bind:value={frameColor} {palette} label="Frame color" />
				<ColorPalettePicker bind:value={insetColor} {palette} label="Character background" />
				<ColorPalettePicker bind:value={textColor} {palette} label="Letter color" />

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
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'text-blocks')}
					onExport={() => exportStl()}
					exportDisabled={!sceneReady || blockLettersFromText(textContent).length === 0 || exportLoading}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF')}
					onExport3MF={() => export3MF()}
					onOpenWithSlicer={openWithSlicer}
					{openWithSlicerLoading}
					{exportLoading}
					showLockIcon={showExportLockIcon(user, subscriptionStatus)}
				/>
			</div>
		</section>
	</div>
</main>
