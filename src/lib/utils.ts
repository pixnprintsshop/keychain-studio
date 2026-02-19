import * as THREE from "three";
import { FontLoader } from "three/examples/jsm/loaders/FontLoader";
import titanOneJson from "../assets/fonts/Titan One_Regular.json";
import showpopJson from "../assets/fonts/Showpop_Regular.json";
import retroDollyJson from "../assets/fonts/Retro Dolly_Book.json";
import kindergoJson from "../assets/fonts/Kindergo_Regular.json";
import beautifulHarmonyJson from "../assets/fonts/Beautiful Harmony_Regular.json";
import milkywayJson from "../assets/fonts/Milkyway_Regular.json";

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

export interface CharSettings {
    keyringOffsetX: number;
    keyringOffsetY: number;
    keyringOuterSize: number;
    keyringHoleSize: number;
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
        key: "Titan One_Regular",
        label: "Titan One (Regular)",
        json: titanOneJson,
        fontFamily: "Titan One",
    },
    {
        key: "Showpop_Regular",
        label: "Showpop (Regular)",
        json: showpopJson,
        fontFamily: "Showpop",
    },
    {
        key: "Retro Dolly_Book",
        label: "Retro Dolly (Book)",
        json: retroDollyJson,
        fontFamily: "Retro Dolly",
    },
    {
        key: "Kindergo_Regular",
        label: "Kindergo (Regular)",
        json: kindergoJson,
        fontFamily: "Kindergo",
    },
    {
        key: "Beautiful Harmony_Regular",
        label: "Beautiful Harmony (Regular)",
        json: beautifulHarmonyJson,
        fontFamily: "Beautiful Harmony",
    },
    {
        key: "Milkyway_Regular",
        label: "Milkyway (Regular)",
        json: milkywayJson,
        fontFamily: "Milkyway",
    },
];

// ── Default values ──────────────────────────────────────────────────────────

export const DEFAULT_FONT_SETTINGS_OUTLINE: FontSettings = {
    textSize: 13,
    outlineOffsetPx: 10,
    baseDepth: 3,
    textDepth: 2,
    textColor: "#ffffff",
    outlineColor: "#ec4899",
    keyringEnabled: true,
};

export const DEFAULT_FONT_SETTINGS_INITIAL: FontSettings = {
    textSize: 13,
    outlineOffsetPx: 10,
    baseDepth: 1,
    textDepth: 1,
    textColor: "#ec4899",
    outlineColor: "#ffffff",
    keyringEnabled: true,
    initialDepth: 10,
    initialTextSize: 39,
    initialFontKey: "Milkyway_Regular",
};

export const DEFAULT_CHAR_SETTINGS: CharSettings = {
    keyringOffsetX: 0,
    keyringOffsetY: 0,
    keyringOuterSize: 8,
    keyringHoleSize: 4,
};

export const DEFAULT_FONT_KEY_OUTLINE = "Titan One_Regular";
export const DEFAULT_FONT_KEY_INITIAL = "Beautiful Harmony_Regular";
export const DEFAULT_INITIAL_FONT_KEY = "Milkyway_Regular";
export const DEFAULT_TEXT = "Name";

// ── Font loader (shared singleton) ──────────────────────────────────────────

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

// ── Three.js helpers ────────────────────────────────────────────────────────

export function centerGeometryXY(geo: any) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    geo.translate(-cx, -cy, 0);
    geo.computeBoundingBox();
}

/**
 * Creates a THREE.Shape for a rounded rectangle centered at origin.
 * Built from discretized points in counter-clockwise order so the interior
 * is unambiguously the rectangle (avoids arc winding issues in some engines).
 * @param halfW half-width (x extent from center)
 * @param halfH half-height (y extent from center)
 * @param cornerRadius radius for the four corners (clamped to min(halfW, halfH))
 */
export function createRoundedRectShape(
    halfW: number,
    halfH: number,
    cornerRadius: number,
): THREE.Shape {
    const w = Math.max(0.01, halfW);
    const h = Math.max(0.01, halfH);
    const r = Math.max(0, Math.min(cornerRadius, w, h));

    const shape = new THREE.Shape();
    const segments = Math.max(2, Math.min(16, Math.ceil((r * Math.PI) / 2)));

    function arcPoints(cx: number, cy: number, startAngle: number, endAngle: number): { x: number; y: number }[] {
        const points: { x: number; y: number }[] = [];
        for (let i = 1; i <= segments; i++) {
            const t = i / segments;
            const angle = startAngle + t * (endAngle - startAngle);
            points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
        }
        return points;
    }

    // Single contour, counter-clockwise: left edge up -> top-left arc -> top -> top-right arc -> right -> bottom-right -> bottom-left arc -> left edge
    shape.moveTo(-w, h - r);
    if (r > 0) {
        arcPoints(-w + r, h - r, Math.PI, Math.PI / 2).forEach((p) => shape.lineTo(p.x, p.y));
    }
    shape.lineTo(w - r, h);
    if (r > 0) {
        arcPoints(w - r, h - r, Math.PI / 2, 0).forEach((p) => shape.lineTo(p.x, p.y));
    }
    shape.lineTo(w, -h + r);
    if (r > 0) {
        arcPoints(w - r, -h + r, 0, -Math.PI / 2).forEach((p) => shape.lineTo(p.x, p.y));
    }
    shape.lineTo(-w + r, -h);
    if (r > 0) {
        // Quarter circle from bottom to left: -90° to 180° (use -PI so we take the short way, not 270°)
        arcPoints(-w + r, -h + r, -Math.PI / 2, -Math.PI).forEach((p) => shape.lineTo(p.x, p.y));
    }
    shape.lineTo(-w, h - r);
    return shape;
}

export function makeKeyringGeometry(
    outerDiameter: number,
    innerDiameter: number,
    depth: number,
    segments = 64,
) {
    const outerRadius = Math.max(0.1, outerDiameter / 2);
    const innerRadius = Math.min(
        Math.max(0.05, innerDiameter / 2),
        outerRadius - 0.1,
    );

    const shape = new THREE.Shape();
    shape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
    shape.holes.push(hole);

    return new THREE.ExtrudeGeometry([shape], {
        depth: Math.max(0.1, depth),
        bevelEnabled: false,
        curveSegments: segments,
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

export function downloadBlob(filename: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/**
 * Capture the current Three.js renderer output and download as a PNG snapshot.
 * Forces a render before capturing so the buffer is fresh.
 */
export function downloadSnapshot(
    renderer: any,
    scene: any,
    camera: any,
    filenamePrefix: string,
) {
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    const canvas = renderer.domElement as HTMLCanvasElement;
    canvas.toBlob((blob: Blob | null) => {
        if (!blob) return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(`${filenamePrefix}-${timestamp}.png`, blob);
    }, "image/png");
}

export function frameCameraToObject(
    box: any,
    camera: any,
    controls: any,
) {
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

// ── Persistence helpers ─────────────────────────────────────────────────────

export function loadFontSettingsFromStorage(
    storageKey: string,
): Record<string, FontSettings> {
    try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed && typeof parsed === "object") return parsed;
        }
    } catch (e) {
        console.error("Failed to load font settings:", e);
    }
    return {};
}

export function loadCharSettingsFromStorage(
    storageKey: string,
): Record<string, Record<string, CharSettings>> {
    try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed && typeof parsed === "object") return parsed;
        }
    } catch (e) {
        console.error("Failed to load char settings:", e);
    }
    return {};
}
