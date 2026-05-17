/**
 * Crockford-base32 ULID. 26 chars: 10 char timestamp + 16 char randomness.
 * Monotonic within a single isolate's millisecond — calling ulid() twice in
 * the same ms yields IDs that sort correctly.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastMs = -1;
let lastRandom = new Uint8Array(10);

const encodeBase32 = (bytes: Uint8Array, len: number, value: bigint): string => {
	let v = value;
	let out = "";
	for (let i = 0; i < len; i++) {
		out = ALPHABET[Number(v & 0x1fn)] + out;
		v >>= 5n;
	}
	return out;
};

const fillRandom = (out: Uint8Array): void => {
	crypto.getRandomValues(out);
};

const incrementRandom = (buf: Uint8Array): void => {
	for (let i = buf.length - 1; i >= 0; i--) {
		const next = (buf[i] ?? 0) + 1;
		buf[i] = next & 0xff;
		if (next <= 0xff) return;
	}
};

export const ulid = (): string => {
	const now = Date.now();
	if (now === lastMs) {
		incrementRandom(lastRandom);
	} else {
		lastMs = now;
		lastRandom = new Uint8Array(10);
		fillRandom(lastRandom);
	}

	const timePart = encodeBase32(new Uint8Array(0), 10, BigInt(now));
	let randomValue = 0n;
	for (const byte of lastRandom) randomValue = (randomValue << 8n) | BigInt(byte);
	const randomPart = encodeBase32(new Uint8Array(0), 16, randomValue);

	return timePart + randomPart;
};
