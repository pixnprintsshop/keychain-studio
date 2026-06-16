declare module 'qrcode/lib/core/qrcode.js' {
	import type { QRCodeErrorCorrectionLevel } from 'qrcode';

	export interface QrCodeSymbol {
		modules: {
			size: number;
			get(row: number, col: number): boolean | number;
		};
	}

	export function create(
		data: string,
		options?: { errorCorrectionLevel?: QRCodeErrorCorrectionLevel }
	): QrCodeSymbol;
}
