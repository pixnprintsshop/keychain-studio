import * as THREE from 'three';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import titanOneJson from './assets/fonts/Titan One_Regular.json';
import showpopJson from './assets/fonts/Showpop_Regular.json';
import retroDollyJson from './assets/fonts/Retro Dolly_Book.json';
import kindergoJson from './assets/fonts/Kindergo_Regular.json';
import kablammoJson from './assets/fonts/Kablammo_Regular.json';
import beautifulHarmonyJson from './assets/fonts/Beautiful Harmony_Regular.json';
import milkywayJson from './assets/fonts/Milkyway_Regular.json';
import milkshakeJson from './assets/fonts/Milkshake_Regular.json';
import ngacoJson from './assets/fonts/Ngaco_Regular.json';
import miltonianJson from './assets/fonts/Miltonian_Regular.json';
import monotonJson from './assets/fonts/Monoton_Regular.json';
import bebasNeueJson from './assets/fonts/Bebas Neue_Regular.json';
import berkshireSwashJson from './assets/fonts/Berkshire Swash_Regular.json';
import blackOpsOneJson from './assets/fonts/Black Ops One_Regular.json';
import cherryBombOneJson from './assets/fonts/Cherry Bomb One_Regular.json';
import cherrySwashJson from './assets/fonts/Cherry Swash_Bold.json';
import dynaPuffJson from './assets/fonts/DynaPuff_Bold.json';
import fascinateInlineJson from './assets/fonts/Fascinate Inline_Regular.json';
import getllesJson from './assets/fonts/Getlles_Regular.json';
import coinyJson from './assets/fonts/Coiny_Regular.json';
import pacificoJson from './assets/fonts/Pacifico_Regular.json';
import lobsterTwoJson from './assets/fonts/Lobster Two_Regular.json';
import roadsideSansJson from './assets/fonts/Roadside Sans_Regular.json';
import trainOneJson from './assets/fonts/Train One_Regular.json';
import daffiysJson from './assets/fonts/Daffiys_Regular.json';
import varsityRelaxaSlabSerifJson from './assets/fonts/Varsity Relaxa Slab Serif_Regular.json';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface FontSettings {
	textSize: number;
	outlineOffsetPx: number;
	baseDepth: number;
	textDepth: number;
	textColor: string;
	outlineColor: string;
	keyringEnabled?: boolean;
	initialDepth?: number;
	initialTextSize?: number;
	initialFontKey?: string;
	keyringDepth?: number;
}

export type KeyringStyle = 'round' | 'sideTab';

export interface CharSettings {
	keyringOffsetX: number;
	keyringOffsetY: number;
	keyringOuterSize: number;
	keyringHoleSize: number;
	/** Text Outline only — round corner ring vs left-center side tab. */
	keyringStyle?: KeyringStyle;
	/** Text Outline side-tab only: distance from the left keychain edge to the hole center (mm). */
	keyringTabExtensionMm?: number;
}

// ── Font options ────────────────────────────────────────────────────────────

export interface FontOption {
	key: string;
	label: string;
	json: any;
	fontFamily: string;
}

export const FONT_OPTIONS: FontOption[] = [
	{
		key: 'Titan One_Regular',
		label: 'Titan One (Regular)',
		json: titanOneJson,
		fontFamily: 'Titan One'
	},
	{ key: 'Showpop_Regular', label: 'Showpop (Regular)', json: showpopJson, fontFamily: 'Showpop' },
	{
		key: 'Retro Dolly_Book',
		label: 'Retro Dolly (Book)',
		json: retroDollyJson,
		fontFamily: 'Retro Dolly'
	},
	{
		key: 'Kindergo_Regular',
		label: 'Kindergo (Regular)',
		json: kindergoJson,
		fontFamily: 'Kindergo'
	},
	{
		key: 'Kablammo_Regular',
		label: 'Kablammo (Regular)',
		json: kablammoJson,
		fontFamily: 'Kablammo'
	},
	{
		key: 'Beautiful Harmony_Regular',
		label: 'Beautiful Harmony (Regular)',
		json: beautifulHarmonyJson,
		fontFamily: 'Beautiful Harmony'
	},
	{
		key: 'Milkyway_Regular',
		label: 'Milkyway (Regular)',
		json: milkywayJson,
		fontFamily: 'Milkyway'
	},
	{
		key: 'Milkshake_Regular',
		label: 'Milkshake (Regular)',
		json: milkshakeJson,
		fontFamily: 'Milkshake'
	},
	{
		key: 'Ngaco_Regular',
		label: 'Ngaco (Regular)',
		json: ngacoJson,
		fontFamily: 'Ngaco'
	},
	{
		key: 'Miltonian_Regular',
		label: 'Miltonian (Regular)',
		json: miltonianJson,
		fontFamily: 'Miltonian'
	},
	{
		key: 'Monoton_Regular',
		label: 'Monoton (Regular)',
		json: monotonJson,
		fontFamily: 'Monoton'
	},
	{
		key: 'Bebas Neue_Regular',
		label: 'Bebas Neue (Regular)',
		json: bebasNeueJson,
		fontFamily: 'Bebas Neue'
	},
	{
		key: 'Black Ops One_Regular',
		label: 'Black Ops One (Regular)',
		json: blackOpsOneJson,
		fontFamily: 'Black Ops One'
	},
	{
		key: 'Berkshire Swash_Regular',
		label: 'Berkshire Swash (Regular)',
		json: berkshireSwashJson,
		fontFamily: 'Berkshire Swash'
	},
	{
		key: 'Cherry Bomb One_Regular',
		label: 'Cherry Bomb One (Regular)',
		json: cherryBombOneJson,
		fontFamily: 'Cherry Bomb One'
	},
	{
		key: 'Cherry Swash_Bold',
		label: 'Cherry Swash (Bold)',
		json: cherrySwashJson,
		fontFamily: 'Cherry Swash'
	},
	{ key: 'DynaPuff_Bold', label: 'DynaPuff (Bold)', json: dynaPuffJson, fontFamily: 'DynaPuff' },
	{
		key: 'Fascinate Inline_Regular',
		label: 'Fascinate Inline (Regular)',
		json: fascinateInlineJson,
		fontFamily: 'Fascinate Inline'
	},
	{
		key: 'Getlles_Regular',
		label: 'Getlles (Regular)',
		json: getllesJson,
		fontFamily: 'Getlles'
	},
	{ key: 'Coiny_Regular', label: 'Coiny (Regular)', json: coinyJson, fontFamily: 'Coiny' },
	{
		key: 'Pacifico_Regular',
		label: 'Pacifico (Regular)',
		json: pacificoJson,
		fontFamily: 'Pacifico'
	},
	{
		key: 'Lobster Two_Regular',
		label: 'Lobster Two (Regular)',
		json: lobsterTwoJson,
		fontFamily: 'Lobster Two'
	},
	{
		key: 'Roadside Sans_Regular',
		label: 'Roadside Sans (Regular)',
		json: roadsideSansJson,
		fontFamily: 'Roadside Sans'
	},
	{
		key: 'Train One_Regular',
		label: 'Train One (Regular)',
		json: trainOneJson,
		fontFamily: 'Train One'
	},
	{
		key: 'Daffiys_Regular',
		label: 'Daffiys (Regular)',
		json: daffiysJson,
		fontFamily: 'Daffiys'
	},
	{
		key: 'Varsity Relaxa Slab',
		label: 'Varsity Relaxa Slab (Regular)',
		json: varsityRelaxaSlabSerifJson,
		fontFamily: 'Varsity Relaxa Slab Serif'
	}
];

export const DEFAULT_FONT_SETTINGS_OUTLINE: FontSettings = {
	textSize: 13,
	outlineOffsetPx: 10,
	baseDepth: 3,
	textDepth: 2,
	textColor: '#ffffff',
	outlineColor: '#ec4899',
	keyringEnabled: true
};

export const DEFAULT_FONT_SETTINGS_INITIAL: FontSettings = {
	textSize: 13,
	outlineOffsetPx: 10,
	baseDepth: 1,
	textDepth: 1,
	textColor: '#ec4899',
	outlineColor: '#ffffff',
	keyringEnabled: true,
	initialDepth: 10,
	initialTextSize: 39,
	initialFontKey: 'Varsity Relaxa Slab'
};

export const DEFAULT_CHAR_SETTINGS: CharSettings = {
	keyringOffsetX: 0,
	keyringOffsetY: 0,
	keyringOuterSize: 8,
	keyringHoleSize: 4,
	keyringStyle: 'round',
	keyringTabExtensionMm: 4
};

export const DEFAULT_FONT_KEY_OUTLINE = 'Titan One_Regular';
export const DEFAULT_FONT_KEY_INITIAL = 'Beautiful Harmony_Regular';
export const DEFAULT_INITIAL_FONT_KEY = 'Varsity Relaxa Slab';
export const DEFAULT_TEXT = 'Name';

const fontLoader = new FontLoader();
const fontCache = new Map<string, any>();

export function getFont(key: string) {
	const cached = fontCache.get(key);
	if (cached) return cached;
	const opt = FONT_OPTIONS.find((o) => o.key === key) ?? FONT_OPTIONS[0];
	const parsed = fontLoader.parse(opt.json as any);
	fontCache.set(key, parsed);
	return parsed;
}

export function centerGeometryXY(geo: any, offsetX: number = 0) {
	geo.computeBoundingBox();
	const bb = geo.boundingBox;
	if (!bb) return;
	const cx = (bb.min.x + bb.max.x) / 2;
	const cy = (bb.min.y + bb.max.y) / 2;
	geo.translate(-cx + offsetX, -cy, 0);
	geo.computeBoundingBox();
}

export function createRoundedRectShape(
	halfW: number,
	halfH: number,
	cornerRadius: number
): THREE.Shape {
	const w = Math.max(0.01, halfW);
	const h = Math.max(0.01, halfH);
	const r = Math.max(0, Math.min(cornerRadius, w, h));
	const shape = new THREE.Shape();

	if (r <= 0) {
		shape.moveTo(-w, h);
		shape.lineTo(w, h);
		shape.lineTo(w, -h);
		shape.lineTo(-w, -h);
		shape.lineTo(-w, h);
		return shape;
	}

	shape.moveTo(-w, h - r);
	shape.absarc(-w + r, h - r, r, Math.PI, Math.PI / 2, true);
	shape.lineTo(w - r, h);
	shape.absarc(w - r, h - r, r, Math.PI / 2, 0, true);
	shape.lineTo(w, -h + r);
	shape.absarc(w - r, -h + r, r, 0, -Math.PI / 2, true);
	shape.lineTo(-w + r, -h);
	shape.absarc(-w + r, -h + r, r, -Math.PI / 2, Math.PI, true);
	shape.lineTo(-w, h - r);
	return shape;
}

export function makeKeyringGeometry(
	outerDiameter: number,
	innerDiameter: number,
	depth: number,
	segments = 64
) {
	const outerRadius = Math.max(0.1, outerDiameter / 2);
	const innerRadius = Math.min(Math.max(0.05, innerDiameter / 2), outerRadius - 0.1);
	const shape = new THREE.Shape();
	shape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
	const hole = new THREE.Path();
	hole.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
	shape.holes.push(hole);
	return new THREE.ExtrudeGeometry([shape], {
		depth: Math.max(0.1, depth),
		bevelEnabled: false,
		curveSegments: segments
	});
}

export function disposeObject3D(obj: any) {
	obj.traverse((child: any) => {
		const mesh = child;
		if (mesh?.geometry?.dispose) mesh.geometry.dispose();
		const mat = mesh?.material;
		if (Array.isArray(mat)) mat.forEach((m: any) => m?.dispose?.());
		else mat?.dispose?.();
	});
}

/**
 * Parse STL (ASCII or binary) into Three.js BufferGeometry.
 * @param data - STL file contents as string (ASCII) or ArrayBuffer (binary)
 */
export function stlToBufferGeometry(data: string | ArrayBuffer): THREE.BufferGeometry {
	const isBinary =
		typeof data !== 'string' &&
		data.byteLength >= 84 &&
		new TextDecoder().decode(new Uint8Array(data, 0, 5)) !== 'solid';

	if (isBinary && typeof data !== 'string') {
		const view = new DataView(data);
		const numTriangles = view.getUint32(80, true);
		const positions: number[] = [];
		const normals: number[] = [];
		let offset = 84;
		for (let i = 0; i < numTriangles; i++) {
			const nx = view.getFloat32(offset, true);
			const ny = view.getFloat32(offset + 4, true);
			const nz = view.getFloat32(offset + 8, true);
			normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
			for (let v = 0; v < 3; v++) {
				positions.push(
					view.getFloat32(offset + 12 + v * 12, true),
					view.getFloat32(offset + 12 + v * 12 + 4, true),
					view.getFloat32(offset + 12 + v * 12 + 8, true)
				);
			}
			offset += 50;
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
		return geo;
	}

	// ASCII STL: parse facet-by-facet so normals and vertices stay aligned
	const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
	const pos: number[] = [];
	const norm: number[] = [];
	const facetBlockRe =
		/facet normal\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+outer loop\s+vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
	let m = facetBlockRe.exec(text);
	while (m) {
		const nx = parseFloat(m[1]);
		const ny = parseFloat(m[2]);
		const nz = parseFloat(m[3]);
		norm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
		pos.push(parseFloat(m[4]), parseFloat(m[5]), parseFloat(m[6]));
		pos.push(parseFloat(m[7]), parseFloat(m[8]), parseFloat(m[9]));
		pos.push(parseFloat(m[10]), parseFloat(m[11]), parseFloat(m[12]));
		m = facetBlockRe.exec(text);
	}
	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
	return geo;
}

export function downloadBlob(filename: string, blob: Blob) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Revoke after a delay so the browser can start the download; revoking
	// immediately can make subsequent downloads in the same session fail.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadSnapshot(renderer: any, scene: any, camera: any, filenamePrefix: string) {
	if (!renderer || !scene || !camera) return;
	renderer.render(scene, camera);
	const canvas = renderer.domElement as HTMLCanvasElement;
	canvas.toBlob((blob: Blob | null) => {
		if (!blob) return;
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		downloadBlob(`${filenamePrefix}-${timestamp}.png`, blob);
	}, 'image/png');
}

/** World-space AABB size in scene units (mm for keychain designers). Null if empty or invalid. */
export function measureWorldAabbSizeMm(root: THREE.Object3D): THREE.Vector3 | null {
	root.updateWorldMatrix(true, true);
	const box = new THREE.Box3().setFromObject(root);
	if (box.isEmpty()) return null;
	const size = new THREE.Vector3();
	box.getSize(size);
	return size;
}

export function frameCameraToObject(box: any, camera: any, controls: any) {
	if (!camera || !controls) return;
	const center = new THREE.Vector3();
	box.getCenter(center);
	const sphere = new THREE.Sphere();
	box.getBoundingSphere(sphere);
	const radius = Math.max(0.001, sphere.radius);
	const fov = (camera.fov * Math.PI) / 200;
	const dist = (radius / Math.sin(fov / 2)) * 1.15;
	const dir = new THREE.Vector3(0, -1.35, 3).normalize();
	camera.position.copy(center).add(dir.multiplyScalar(dist));
	camera.near = Math.max(0.01, dist / 200);
	camera.far = Math.max(2000, dist * 20);
	camera.updateProjectionMatrix();
	camera.lookAt(center);
	controls.target.copy(center);
	controls.update();
}

export function loadFontSettingsFromStorage(storageKey: string): Record<string, FontSettings> {
	try {
		const stored = localStorage.getItem(storageKey);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (parsed && typeof parsed === 'object') return parsed;
		}
	} catch (e) {
		console.error('Failed to load font settings:', e);
	}
	return {};
}

export function loadCharSettingsFromStorage(
	storageKey: string
): Record<string, Record<string, CharSettings>> {
	try {
		const stored = localStorage.getItem(storageKey);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (parsed && typeof parsed === 'object') return parsed;
		}
	} catch (e) {
		console.error('Failed to load char settings:', e);
	}
	return {};
}
