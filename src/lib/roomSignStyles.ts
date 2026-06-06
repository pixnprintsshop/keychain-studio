import classicbloomBaseUrl from '$lib/assets/stl/roomsign/classicbloom/base.stl?url';
import classicbloomDecorUrl from '$lib/assets/stl/roomsign/classicbloom/decor.stl?url';
import cloudblossomBaseUrl from '$lib/assets/stl/roomsign/cloudblossom/base.stl?url';
import cloudblossomDecorUrl from '$lib/assets/stl/roomsign/cloudblossom/decor.stl?url';
import countryfloralBaseUrl from '$lib/assets/stl/roomsign/countryfloral/base.stl?url';
import countryfloralDecorUrl from '$lib/assets/stl/roomsign/countryfloral/decor.stl?url';
import elegantmanorBaseUrl from '$lib/assets/stl/roomsign/elegantmanor/base.stl?url';
import elegantmanorDecorUrl from '$lib/assets/stl/roomsign/elegantmanor/decor.stl?url';
import ovalcharmBaseUrl from '$lib/assets/stl/roomsign/ovalcharm/base.stl?url';
import ovalcharmDecorUrl from '$lib/assets/stl/roomsign/ovalcharm/decor.stl?url';
import princesscrestBaseUrl from '$lib/assets/stl/roomsign/princesscrest/base.stl?url';
import princesscrestDecorUrl from '$lib/assets/stl/roomsign/princesscrest/decor.stl?url';
import royalgardenBaseUrl from '$lib/assets/stl/roomsign/royalgarden/base.stl?url';
import royalgardenDecorUrl from '$lib/assets/stl/roomsign/royalgarden/decor.stl?url';
import sweetheartBaseUrl from '$lib/assets/stl/roomsign/sweetheart/base.stl?url';
import sweetheartDecorUrl from '$lib/assets/stl/roomsign/sweetheart/decor.stl?url';
import vintagelilyBaseUrl from '$lib/assets/stl/roomsign/vintagelily/base.stl?url';
import vintagelilyDecorUrl from '$lib/assets/stl/roomsign/vintagelily/decor.stl?url';

export type RoomSignStyleId =
	| 'classicbloom'
	| 'cloudblossom'
	| 'countryfloral'
	| 'elegantmanor'
	| 'ovalcharm'
	| 'princesscrest'
	| 'royalgarden'
	| 'sweetheart'
	| 'vintagelily';

export interface RoomSignStyle {
	label: string;
	baseStlUrl: string;
	decorStlUrl: string;
	previewImageUrl: string;
	/** Y shift (mm at 150 mm width) for base + decor after bbox centering. */
	offsetYMm?: number;
}

export const ROOM_SIGN_STYLES: Record<RoomSignStyleId, RoomSignStyle> = {
	classicbloom: {
		label: 'Classic Bloom',
		baseStlUrl: classicbloomBaseUrl,
		decorStlUrl: classicbloomDecorUrl,
		previewImageUrl: '/images/roomsign/classicbloom.png'
	},
	cloudblossom: {
		label: 'Cloud Blossom',
		baseStlUrl: cloudblossomBaseUrl,
		decorStlUrl: cloudblossomDecorUrl,
		previewImageUrl: '/images/roomsign/cloudblossom.png'
	},
	countryfloral: {
		label: 'Country Floral',
		baseStlUrl: countryfloralBaseUrl,
		decorStlUrl: countryfloralDecorUrl,
		previewImageUrl: '/images/roomsign/countryfloral.png'
	},
	elegantmanor: {
		label: 'Elegant Manor',
		baseStlUrl: elegantmanorBaseUrl,
		decorStlUrl: elegantmanorDecorUrl,
		previewImageUrl: '/images/roomsign/elegantmanor.png'
	},
	ovalcharm: {
		label: 'Oval Charm',
		baseStlUrl: ovalcharmBaseUrl,
		decorStlUrl: ovalcharmDecorUrl,
		previewImageUrl: '/images/roomsign/ovalcharm.png'
	},
	princesscrest: {
		label: 'Princess Crest',
		baseStlUrl: princesscrestBaseUrl,
		decorStlUrl: princesscrestDecorUrl,
		previewImageUrl: '/images/roomsign/princesscrest.png'
	},
	royalgarden: {
		label: 'Royal Garden',
		baseStlUrl: royalgardenBaseUrl,
		decorStlUrl: royalgardenDecorUrl,
		previewImageUrl: '/images/roomsign/royalgarden.png'
	},
	sweetheart: {
		label: 'Sweetheart',
		baseStlUrl: sweetheartBaseUrl,
		decorStlUrl: sweetheartDecorUrl,
		previewImageUrl: '/images/roomsign/sweetheart.png'
	},
	vintagelily: {
		label: 'Vintage Lily',
		baseStlUrl: vintagelilyBaseUrl,
		decorStlUrl: vintagelilyDecorUrl,
		previewImageUrl: '/images/roomsign/vintagelilly.png',
		offsetYMm: 4.5
	}
};

export const ROOM_SIGN_STYLE_IDS = Object.keys(ROOM_SIGN_STYLES) as RoomSignStyleId[];

export const DEFAULT_ROOM_SIGN_STYLE_ID: RoomSignStyleId = 'classicbloom';

export function isRoomSignStyleId(value: string): value is RoomSignStyleId {
	return value in ROOM_SIGN_STYLES;
}

/** Scaled Y offset for base + decor meshes (text stays at origin). */
export function roomSignStyleOffsetYMm(styleId: RoomSignStyleId, targetWidthMm: number): number {
	const offset = ROOM_SIGN_STYLES[styleId].offsetYMm ?? 0;
	return offset * (targetWidthMm / 150);
}
