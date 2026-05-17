/**
 * Deterministic 5x5 symmetric identicon as inline SVG. Derived from a seed
 * (use the user's ULID). Color comes from the same seed so two anonymous
 * users with different ULIDs always have visually distinct avatars.
 *
 * Output is a self-contained <svg> string that can be inlined into the
 * comment template — no extra HTTP request, no per-user cache entry.
 */

const fnv1a = (s: string): number => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
};

const hslColor = (seed: number): string => {
	const hue = seed % 360;
	return `hsl(${hue} 55% 55%)`;
};

export const identiconSvg = (seed: string, size = 48): string => {
	const hash = fnv1a(seed);
	const fg = hslColor(hash);
	const bg = "#eef0f3";
	const cell = size / 5;
	const rects: string[] = [];

	// Iterate left columns (0, 1, 2) — mirror cols 3, 4 from cols 1, 0.
	for (let col = 0; col < 3; col++) {
		for (let row = 0; row < 5; row++) {
			const bit = (hash >>> (col * 5 + row)) & 1;
			if (!bit) continue;
			const x = col * cell;
			const y = row * cell;
			rects.push(
				`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${fg}"/>`,
			);
			if (col < 2) {
				const mirrorX = (4 - col) * cell;
				rects.push(
					`<rect x="${mirrorX}" y="${y}" width="${cell}" height="${cell}" fill="${fg}"/>`,
				);
			}
		}
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="identicon"><rect width="${size}" height="${size}" fill="${bg}"/>${rects.join("")}</svg>`;
};
