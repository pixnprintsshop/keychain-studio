/** Iconify refs (`collection:icon-name`) for the pickleball paddle center icon. */
export interface PickleballKeychainIcon {
	id: string;
	label: string;
}

/**
 * Curated monochrome Iconify set — flowers, sports balls, food, flat emoticons, and fun marks.
 * Preview URLs verified against api.iconify.design.
 */
export const PICKLEBALL_KEYCHAIN_ICONS: readonly PickleballKeychainIcon[] = [
	// Flowers & nature
	{ id: 'mdi:flower', label: 'Flower' },
	{ id: 'ph:flower-bold', label: 'Flower 1' },
	{ id: 'bi:flower2', label: 'Flower 2' },
	{ id: 'bi:flower1', label: 'Flower 3' },
	{ id: 'streamline:flower-remix', label: 'Flower 4' },
	{ id: 'ion:ios-flower', label: 'Flower 5' },
	{ id: 'game-icons:flower-star', label: 'Flower 6' },
	{ id: 'mdi:flower-tulip', label: 'Tulip' },
	{ id: 'game-icons:rose', label: 'Rose' },
	{ id: 'mdi:leaf', label: 'Leaf (MDI)' },
	{ id: 'mdi:butterfly', label: 'Butterfly' },
	{ id: 'mdi:bee', label: 'Bee' },

	// Sports & balls
	{ id: 'mdi:tennis-ball', label: 'Tennis ball' },
	{ id: 'mdi:basketball', label: 'Basketball' },
	{ id: 'mingcute:basketball-line', label: 'Basketball line' },
	{ id: 'mdi:baseball', label: 'Baseball' },
	{ id: 'mdi:soccer', label: 'Soccer ball' },
	{ id: 'mdi:volleyball', label: 'Volleyball' },
	{ id: 'mdi:football', label: 'Football' },
	{ id: 'mdi:golf', label: 'Golf ball' },

	// Food & drink
	{ id: 'material-symbols:cookie-outline', label: 'Cookie line' },
	{ id: 'ph:hamburger-bold', label: 'Hamburger line' },
	{ id: 'mdi:pizza', label: 'Pizza' },
	{ id: 'mdi:hamburger', label: 'Hamburger' },
	{ id: 'mdi:cookie', label: 'Cookie' },
	{ id: 'mdi:cupcake', label: 'Cupcake' },
	{ id: 'mdi:ice-cream', label: 'Ice cream' },
	{ id: 'mdi:beer', label: 'Beer' },

	// Flat emoticons (MDI outline)
	{ id: 'mdi:emoticon-happy-outline', label: 'Happy' },
	{ id: 'mdi:emoticon-excited-outline', label: 'Excited' },
	{ id: 'mdi:emoticon-wink-outline', label: 'Wink' },
	{ id: 'mdi:emoticon-cool-outline', label: 'Cool' },
	{ id: 'mdi:emoticon-lol-outline', label: 'LOL' },
	{ id: 'mdi:emoticon-kiss-outline', label: 'Kiss' },
	{ id: 'mdi:emoticon-tongue-outline', label: 'Tongue' },
	{ id: 'mdi:emoticon-neutral-outline', label: 'Neutral' },
	{ id: 'mdi:emoticon-confused-outline', label: 'Confused' },
	{ id: 'mdi:emoticon-sad-outline', label: 'Sad' },
	{ id: 'mdi:emoticon-cry-outline', label: 'Cry' },
	{ id: 'mdi:emoticon-frown-outline', label: 'Frown' },
	{ id: 'mdi:emoticon-angry-outline', label: 'Angry' },
	{ id: 'mdi:emoticon-sick-outline', label: 'Sick' },
	{ id: 'mdi:emoticon-dead-outline', label: 'Dead' },
	{ id: 'mdi:emoticon-devil-outline', label: 'Devil' },
	{ id: 'mdi:emoticon-poop', label: 'Poop' },
	{ id: 'mdi:emoticon-outline', label: 'Smiley outline' },

	// Hearts, stars & fun
	{ id: 'mdi:heart', label: 'Heart' },
	{ id: 'mdi:heart-outline', label: 'Heart outline' },
	{ id: 'mdi:star', label: 'Star' },
	{ id: 'mdi:paw', label: 'Paw' },
	{ id: 'mdi:fire', label: 'Fire' },
	{ id: 'mdi:lightning-bolt', label: 'Lightning' },
	{ id: 'mdi:crown', label: 'Crown' },
	{ id: 'mdi:trophy', label: 'Trophy' },
	{ id: 'mdi:alpha-p-circle', label: 'Letter P' },
	{ id: 'mdi:eiffel-tower', label: 'Eiffel Tower' },
	{ id: 'ph:butterfly-bold', label: 'Butterfly' },

	{ id: 'material-symbols:stethoscope', label: 'Stethoscope' },
	{ id: 'ri:tools-fill', label: 'Tools' },
	{ id: 'nimbus:tools', label: 'Tools (Tabler)' },
	{ id: 'solar:dumbbells-bold', label: 'Dumbbells' },
	{ id: 'uil:18-plus', label: '18+' },
	{ id: 'fa7-solid:hand-peace', label: 'Peace hand' },
	{ id: 'mdi:hand-okay', label: 'OK hand' },
	{ id: 'fa7-solid:hand-point-up', label: 'Point up hand' },
	{ id: 'ep:fries', label: 'Fries' },
{ id: 'bx:coffee-togo', label: 'Coffee to go' },
{ id: 'ph:microphone-stage', label: 'Microphone (handheld)' },
{ id: 'lineicons:nike', label: 'Nike' },
{ id: 'ic:baseline-apple', label: 'Apple' },
{ id: 'material-symbols:android', label: 'Android' },
{ id: 'tabler:cherry-filled', label: 'Cherry' },
{ id: 'streamline-ultimate:fruit-banana-bold', label: 'Banana' },
{ id: 'streamline-plump:cake-slice-remix', label: 'Cake slice' },
{ id: 'mingcute:chicken-fill', label: 'Chicken' },






] as const;

export const DEFAULT_PICKLEBALL_ICON_ID = 'mdi:flower';

export function iconifySvgUrl(iconRef: string): string {
	const colon = iconRef.indexOf(':');
	if (colon < 1) throw new Error(`Invalid icon ref: ${iconRef}`);
	const collection = iconRef.slice(0, colon);
	const name = iconRef.slice(colon + 1);
	return `https://api.iconify.design/${collection}/${name}.svg`;
}

/** CDN preview image for picker UI (tinted with decor color on the keychain). */
export function iconifyPreviewUrl(iconRef: string, color?: string, size = 48): string {
	const url = new URL(iconifySvgUrl(iconRef));
	url.searchParams.set('width', String(size));
	url.searchParams.set('height', String(size));
	if (color) url.searchParams.set('color', color);
	return url.toString();
}

export function getPickleballIconLabel(iconRef: string): string {
	return PICKLEBALL_KEYCHAIN_ICONS.find((icon) => icon.id === iconRef)?.label ?? 'Icon';
}
