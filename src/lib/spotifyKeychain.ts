import {
	parseSpotifyCodeSvgToLayout,
	validateSpotifyCodeLayout,
	type SpotifyCodeBar,
	type SpotifyCodeLayout
} from '$lib/spotifyKeychainLayout';
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type {
	SpotifyCodeBar,
	SpotifyCodeLayout,
	SpotifyCodeLayoutValidation,
	SpotifyUriType
} from '$lib/spotifyKeychainLayout';

export {
	buildSpotifyCodeDownloadUrl,
	buildSpotifyCodePngUrl,
	buildSpotifyCodeSvgUrl,
	isSpotifyCodeLayout,
	parseSpotifyBarRectsFromSvg,
	parseSpotifyCodeSvgToLayout,
	parseSpotifyUri, SPOTIFY_CODE_IMAGE_WIDTH, validateSpotifyCodeLayout
} from '$lib/spotifyKeychainLayout';

const SPOTIFY_CODE_MIN_BAR_X = 95;
const SPOTIFY_CODE_MAX_BAR_WIDTH = 50;
const MIN_BAR_HEIGHT_PX = 8;
const BLACK_LUMINANCE_THRESHOLD = 128;

export interface SpotifyCodeBarPlacement {
	depth: number;
	surfaceEmbed: number;
	offsetX: number;
	offsetY: number;
	offsetZ: number;
	scale: number;
}

function isBrowser(): boolean {
	return typeof document !== 'undefined' && typeof createImageBitmap === 'function';
}

function isBlackPixel(data: Uint8ClampedArray, width: number, x: number, y: number): boolean {
	const i = (y * width + x) * 4;
	const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
	return luma < BLACK_LUMINANCE_THRESHOLD;
}

export function extractBarsFromImageData(imageData: ImageData): SpotifyCodeBar[] {
	const { data, width, height } = imageData;
	const visited = new Uint8Array(width * height);
	const bars: SpotifyCodeBar[] = [];

	for (let y = 0; y < height; y++) {
		for (let x = SPOTIFY_CODE_MIN_BAR_X; x < width; x++) {
			const startIdx = y * width + x;
			if (visited[startIdx] || !isBlackPixel(data, width, x, y)) continue;

			let minX = x;
			let maxX = x;
			let minY = y;
			let maxY = y;
			const stack: [number, number][] = [[x, y]];
			visited[startIdx] = 1;

			while (stack.length > 0) {
				const [cx, cy] = stack.pop()!;
				minX = Math.min(minX, cx);
				maxX = Math.max(maxX, cx);
				minY = Math.min(minY, cy);
				maxY = Math.max(maxY, cy);

				for (const [dx, dy] of [
					[1, 0],
					[-1, 0],
					[0, 1],
					[0, -1]
				] as const) {
					const nx = cx + dx;
					const ny = cy + dy;
					if (nx < SPOTIFY_CODE_MIN_BAR_X || nx >= width || ny < 0 || ny >= height) continue;
					const nidx = ny * width + nx;
					if (visited[nidx] || !isBlackPixel(data, width, nx, ny)) continue;
					visited[nidx] = 1;
					stack.push([nx, ny]);
				}
			}

			const barWidth = maxX - minX + 1;
			const barHeight = maxY - minY + 1;
			if (barHeight >= height * 0.95) continue;
			if (barWidth > SPOTIFY_CODE_MAX_BAR_WIDTH || barHeight < MIN_BAR_HEIGHT_PX) continue;

			bars.push({ x: minX, y: minY, width: barWidth, height: barHeight });
		}
	}

	bars.sort((a, b) => a.x - b.x || a.y - b.y);
	return bars;
}

function isPngBuffer(buffer: ArrayBuffer): boolean {
	if (buffer.byteLength < 8) return false;
	const bytes = new Uint8Array(buffer);
	return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

async function decodePngWithHtmlImage(blob: Blob): Promise<SpotifyCodeLayout> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			try {
				const width = img.naturalWidth;
				const height = img.naturalHeight;
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext('2d', { willReadFrequently: true });
				if (!ctx) {
					reject(new Error('Canvas 2D not available'));
					return;
				}
				ctx.drawImage(img, 0, 0);
				const imageData = ctx.getImageData(0, 0, width, height);
				resolve({ width, height, bars: extractBarsFromImageData(imageData) });
			} catch (e) {
				reject(e);
			} finally {
				URL.revokeObjectURL(url);
			}
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('Could not decode Spotify code image'));
		};
		img.src = url;
	});
}

export async function decodeSpotifyCodePngToLayout(
	source: Blob | ArrayBuffer
): Promise<SpotifyCodeLayout> {
	if (!isBrowser()) {
		throw new Error('Spotify code PNG decode requires a browser');
	}

	const buffer = source instanceof Blob ? await source.arrayBuffer() : source;
	if (!isPngBuffer(buffer)) {
		const text = new TextDecoder().decode(buffer);
		if (text.includes('<svg')) {
			const layout = parseSpotifyCodeSvgToLayout(text);
			if (layout) return layout;
		}
		throw new Error('Spotify code response is not a valid PNG or SVG');
	}

	const blob = new Blob([buffer], { type: 'image/png' });

	try {
		const bitmap = await createImageBitmap(blob);
		try {
			const width = bitmap.width;
			const height = bitmap.height;
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			if (!ctx) throw new Error('Canvas 2D not available');

			ctx.drawImage(bitmap, 0, 0);
			const imageData = ctx.getImageData(0, 0, width, height);
			return { width, height, bars: extractBarsFromImageData(imageData) };
		} finally {
			bitmap.close();
		}
	} catch {
		return decodePngWithHtmlImage(blob);
	}
}

const BAR_EXTRUDE_CURVE_SEGMENTS = 12;

function barCornerRadius(bar: SpotifyCodeBar): number {
	const maxR = Math.min(bar.width / 2, bar.height / 2);
	if (bar.cornerRadius != null && bar.cornerRadius > 0) {
		return Math.min(bar.cornerRadius, maxR);
	}
	return Math.min(bar.width * 0.5, maxR);
}

/** Rounded rect in Y-up code space; extruding along +Z yields flat caps and rounded vertical corners. */
function roundedRectShape(x: number, y: number, w: number, h: number, rx: number): THREE.Shape {
	const r = Math.min(Math.max(0, rx), w / 2, h / 2);
	const shape = new THREE.Shape();
	shape.moveTo(x + r, y);
	shape.lineTo(x + w - r, y);
	shape.quadraticCurveTo(x + w, y, x + w, y + r);
	shape.lineTo(x + w, y + h - r);
	shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	shape.lineTo(x + r, y + h);
	shape.quadraticCurveTo(x, y + h, x, y + h - r);
	shape.lineTo(x, y + r);
	shape.quadraticCurveTo(x, y, x + r, y);
	return shape;
}

function createBarExtrudeGeometry(
	bar: SpotifyCodeBar,
	viewHeight: number,
	depth: number
): THREE.BufferGeometry {
	const yUp = viewHeight - bar.y - bar.height;
	const shape = roundedRectShape(
		bar.x,
		yUp,
		bar.width,
		bar.height,
		barCornerRadius(bar)
	);
	const geo = new THREE.ExtrudeGeometry(shape, {
		depth,
		bevelEnabled: false,
		curveSegments: BAR_EXTRUDE_CURVE_SEGMENTS,
		steps: 1
	});
	geo.computeVertexNormals();
	return geo;
}

function mergeBarPieces(pieceGeos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
	if (pieceGeos.length === 0) return null;
	const merged =
		pieceGeos.length === 1 ? pieceGeos[0] : BufferGeometryUtils.mergeGeometries(pieceGeos);
	if (!merged) {
		pieceGeos.forEach((g) => g.dispose());
		return null;
	}
	if (pieceGeos.length > 1) pieceGeos.forEach((g) => g.dispose());
	merged.computeVertexNormals();
	return merged;
}

export function buildSpotifyCodeBarGeometryFromLayout(
	layout: SpotifyCodeLayout,
	plateMinX: number,
	plateMinY: number,
	plateWidth: number,
	plateHeight: number,
	plateTopZ: number,
	placement: SpotifyCodeBarPlacement
): THREE.BufferGeometry | null {
	const validation = validateSpotifyCodeLayout(layout);
	if (!validation.ok) return null;

	const pieceGeos = layout.bars.map((bar) =>
		createBarExtrudeGeometry(bar, layout.height, placement.depth)
	);
	const merged = mergeBarPieces(pieceGeos);
	if (!merged) return null;

	merged.computeBoundingBox();
	const bb = merged.boundingBox;
	if (!bb) return merged;

	const codeW = Math.max(0.01, bb.max.x - bb.min.x);
	const codeH = Math.max(0.01, bb.max.y - bb.min.y);
	const fitScale = Math.min(plateWidth / codeW, plateHeight / codeH) * placement.scale;

	const codeCx = (bb.min.x + bb.max.x) / 2;
	const codeCy = (bb.min.y + bb.max.y) / 2;
	const plateCx = plateMinX + plateWidth / 2 + placement.offsetX;
	const plateCy = plateMinY + plateHeight / 2 + placement.offsetY;
	const baseZ = plateTopZ + placement.surfaceEmbed;

	const matrix = new THREE.Matrix4()
		.makeTranslation(-codeCx, -codeCy, 0)
		.premultiply(new THREE.Matrix4().makeScale(fitScale, fitScale, 1))
		.premultiply(new THREE.Matrix4().makeTranslation(plateCx, plateCy, baseZ));

	merged.applyMatrix4(matrix);
	merged.computeBoundingBox();
	merged.computeVertexNormals();
	return merged;
}
