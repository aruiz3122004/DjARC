import { Readable } from "node:stream";
// src/lib/audio/audioContainer.ts
var ADTS_SAMPLE_RATES = [
	96e3,
	88200,
	64e3,
	48e3,
	44100,
	32e3,
	24e3,
	22050,
	16e3,
	12e3,
	11025,
	8e3,
	7350
];
function readUint32BE(bytes, offset) {
	return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}
function readAscii4(bytes, offset) {
	return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}
function readBoxHeader(bytes, offset, limit) {
	if (offset + 8 > limit) return null;
	const rawSize = readUint32BE(bytes, offset);
	const type = readAscii4(bytes, offset + 4);
	if (rawSize === 0) return {
		type,
		headerSize: 8,
		boxSize: limit - offset
	};
	if (rawSize === 1) {
		if (offset + 16 > limit) return null;
		const high = readUint32BE(bytes, offset + 8);
		const low = readUint32BE(bytes, offset + 12);
		const boxSize = high * 4294967296 + low;
		if (boxSize < 16 || offset + boxSize > limit) return null;
		return {
			type,
			headerSize: 16,
			boxSize
		};
	}
	if (rawSize < 8 || offset + rawSize > limit) return null;
	return {
		type,
		headerSize: 8,
		boxSize: rawSize
	};
}
function scanMp4MoovBoxes(bytes, start, end, state) {
	const containerBoxes = /* @__PURE__ */ new Set([
		"moov",
		"trak",
		"mdia",
		"minf",
		"stbl"
	]);
	let offset = start;
	while (offset + 8 <= end) {
		const box = readBoxHeader(bytes, offset, end);
		if (!box) break;
		const contentStart = offset + box.headerSize;
		const contentEnd = offset + box.boxSize;
		if (box.type === "enca" || box.type === "encv" || box.type === "sinf" || box.type === "schi") state.encrypted = true;
		else if (box.type === "mp4a") {
			if (!state.codec) state.codec = "aac";
			if (contentStart + 28 < contentEnd) scanMp4MoovBoxes(bytes, contentStart + 28, contentEnd, state);
		} else if (box.type === "alac" || box.type === "ac-3" || box.type === "ec-3" || box.type === "mlpa" || box.type === "Opus") state.codec = box.type === "Opus" ? "opus" : box.type;
		else if (box.type === "stsd") {
			if (contentStart + 8 < contentEnd) scanMp4MoovBoxes(bytes, contentStart + 8, contentEnd, state);
		} else if (box.type === "esds") state.esdsConfig = parseAudioSpecificConfigFromEsds(bytes, contentStart, contentEnd);
		else if (containerBoxes.has(box.type)) scanMp4MoovBoxes(bytes, contentStart, contentEnd, state);
		offset = contentEnd;
	}
}
function parseAudioSpecificConfigFromEsds(bytes, start, end) {
	let pos = start + 4;
	while (pos + 2 < end) {
		const tag = bytes[pos++];
		let size = 0;
		for (let i = 0; i < 4 && pos < end; i++) {
			const b = bytes[pos++];
			size = size << 7 | b & 127;
			if ((b & 128) === 0) break;
		}
		if (tag === 3) {
			if (pos + 3 > end) return null;
			const flags = bytes[pos + 2];
			pos += 3;
			if (flags & 128) pos += 2;
			if (flags & 64) pos += 1 + (bytes[pos] ?? 0);
			if (flags & 32) pos += 2;
			continue;
		}
		if (tag === 4) {
			pos += 13;
			continue;
		}
		if (tag === 5 && pos + 2 <= end && size >= 2) {
			const b0 = bytes[pos];
			const b1 = bytes[pos + 1];
			const audioObjectType = b0 >> 3 & 31;
			const freqIdx = (b0 & 7) << 1 | b1 >> 7 & 1;
			const chanCfg = b1 >> 3 & 15;
			if (audioObjectType > 0 && freqIdx < ADTS_SAMPLE_RATES.length) return {
				profile: audioObjectType,
				freqIdx,
				chanCfg
			};
			return null;
		}
		pos += size;
	}
	return null;
}
function looksLikeTextError(bytes) {
	if (bytes.length === 0) return true;
	let i = 0;
	while (i < Math.min(bytes.length, 32) && (bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 13 || bytes[i] === 10)) i++;
	const head = String.fromCharCode(...bytes.slice(i, i + 16)).toLowerCase();
	return head.startsWith("{") || head.startsWith("<html") || head.startsWith("<!doc") || head.startsWith("<?xml");
}
/**
* Inspecciona la cabecera binaria de un archivo/stream para identificar el contenedor real,
* detectar cifrado DRM (enca/sinf) y prevenir falsos positivos por extensión o MIME erróneo.
*/
function inspectAudioContainer(bytes) {
	if (looksLikeTextError(bytes)) return {
		kind: "invalid-text",
		mimeType: null,
		codec: "invalid-text",
		encrypted: false,
		fragmentedMp4: false
	};
	if (bytes.length >= 12 && readAscii4(bytes, 4) === "ftyp") {
		const state = {
			encrypted: false,
			codec: null,
			esdsConfig: null
		};
		let fragmentedMp4 = false;
		let offset = 0;
		const scanLimit = Math.min(bytes.length, 262144);
		while (offset + 8 <= scanLimit) {
			const box = readBoxHeader(bytes, offset, bytes.length);
			if (!box) break;
			if (box.type === "moov") scanMp4MoovBoxes(bytes, offset + box.headerSize, offset + box.boxSize, state);
			else if (box.type === "moof" || box.type === "styp") fragmentedMp4 = true;
			if (box.type === "mdat" && state.codec) break;
			offset += box.boxSize;
		}
		return {
			kind: "mp4",
			mimeType: "audio/mp4",
			codec: state.encrypted ? "drm" : state.codec,
			encrypted: state.encrypted,
			fragmentedMp4
		};
	}
	if (bytes.length >= 3 && bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) return {
		kind: "mp3",
		mimeType: "audio/mpeg",
		codec: "mp3",
		encrypted: false,
		fragmentedMp4: false
	};
	if (bytes.length >= 4 && readAscii4(bytes, 0) === "OggS") return {
		kind: "ogg",
		mimeType: "audio/ogg",
		codec: "ogg",
		encrypted: false,
		fragmentedMp4: false
	};
	if (bytes.length >= 4 && readAscii4(bytes, 0) === "fLaC") return {
		kind: "flac",
		mimeType: "audio/flac",
		codec: "flac",
		encrypted: false,
		fragmentedMp4: false
	};
	if (bytes.length >= 12 && readAscii4(bytes, 0) === "RIFF" && readAscii4(bytes, 8) === "WAVE") return {
		kind: "wav",
		mimeType: "audio/wav",
		codec: "pcm",
		encrypted: false,
		fragmentedMp4: false
	};
	if (bytes.length >= 4 && bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return {
		kind: "webm",
		mimeType: "audio/webm",
		codec: "opus/vorbis",
		encrypted: false,
		fragmentedMp4: false
	};
	if (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 246) === 240) return {
		kind: "aac",
		mimeType: "audio/aac",
		codec: "aac",
		encrypted: false,
		fragmentedMp4: false
	};
	if (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 224) === 224) return {
		kind: "mp3",
		mimeType: "audio/mpeg",
		codec: "mp3",
		encrypted: false,
		fragmentedMp4: false
	};
	return {
		kind: "unknown",
		mimeType: null,
		codec: null,
		encrypted: false,
		fragmentedMp4: false
	};
}
function writeUint16BE(buf, offset, val) {
	buf[offset] = val >>> 8 & 255;
	buf[offset + 1] = val & 255;
}
function writeUint32BE(buf, offset, val) {
	buf[offset] = val >>> 24 & 255;
	buf[offset + 1] = val >>> 16 & 255;
	buf[offset + 2] = val >>> 8 & 255;
	buf[offset + 3] = val & 255;
}
function writeAscii4(buf, offset, str) {
	for (let i = 0; i < 4; i++) buf[offset + i] = str.charCodeAt(i) & 255;
}
function concatUint8Arrays(parts) {
	let total = 0;
	for (const p of parts) total += p.byteLength;
	const out = new Uint8Array(total);
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.byteLength;
	}
	return out;
}
function makeMp4ContainerBox(type, children) {
	let payloadSize = 0;
	for (const c of children) payloadSize += c.byteLength;
	const out = new Uint8Array(8 + payloadSize);
	writeUint32BE(out, 0, out.byteLength);
	writeAscii4(out, 4, type);
	let pos = 8;
	for (const c of children) {
		out.set(c, pos);
		pos += c.byteLength;
	}
	return out;
}
function buildStandardFtypBox() {
	const out = /* @__PURE__ */ new Uint8Array(32);
	writeUint32BE(out, 0, 32);
	writeAscii4(out, 4, "ftyp");
	writeAscii4(out, 8, "M4A ");
	writeUint32BE(out, 12, 0);
	writeAscii4(out, 16, "M4A ");
	writeAscii4(out, 20, "isom");
	writeAscii4(out, 24, "iso2");
	writeAscii4(out, 28, "mp42");
	return out;
}
function writeIdentityMatrix(buf, offset) {
	writeUint32BE(buf, offset, 65536);
	writeUint32BE(buf, offset + 16, 65536);
	writeUint32BE(buf, offset + 32, 1073741824);
}
function buildMvhdBox(timescale, duration) {
	const out = /* @__PURE__ */ new Uint8Array(108);
	writeUint32BE(out, 0, 108);
	writeAscii4(out, 4, "mvhd");
	writeUint32BE(out, 20, timescale);
	writeUint32BE(out, 24, Math.min(4294967295, Math.max(1, duration >>> 0)));
	writeUint32BE(out, 28, 65536);
	writeUint16BE(out, 32, 256);
	writeIdentityMatrix(out, 44);
	writeUint32BE(out, 104, 2);
	return out;
}
function buildTkhdBox(duration) {
	const out = /* @__PURE__ */ new Uint8Array(92);
	writeUint32BE(out, 0, 92);
	writeAscii4(out, 4, "tkhd");
	writeUint32BE(out, 8, 7);
	writeUint32BE(out, 20, 1);
	writeUint32BE(out, 28, Math.min(4294967295, Math.max(1, duration >>> 0)));
	writeUint16BE(out, 42, 256);
	writeIdentityMatrix(out, 48);
	return out;
}
function buildMdhdBox(timescale, duration, lang = 21956) {
	const out = /* @__PURE__ */ new Uint8Array(32);
	writeUint32BE(out, 0, 32);
	writeAscii4(out, 4, "mdhd");
	writeUint32BE(out, 20, timescale);
	writeUint32BE(out, 24, Math.min(4294967295, Math.max(1, duration >>> 0)));
	writeUint16BE(out, 28, lang);
	return out;
}
function buildDefaultSounHdlr() {
	const out = /* @__PURE__ */ new Uint8Array(45);
	writeUint32BE(out, 0, 45);
	writeAscii4(out, 4, "hdlr");
	writeAscii4(out, 16, "soun");
	const label = "SoundHandler\0";
	for (let i = 0; i < 13; i++) out[32 + i] = label.charCodeAt(i);
	return out;
}
function buildDefaultSmhd() {
	const out = /* @__PURE__ */ new Uint8Array(16);
	writeUint32BE(out, 0, 16);
	writeAscii4(out, 4, "smhd");
	return out;
}
function buildDefaultDinf() {
	const out = /* @__PURE__ */ new Uint8Array(36);
	writeUint32BE(out, 0, 36);
	writeAscii4(out, 4, "dinf");
	writeUint32BE(out, 8, 28);
	writeAscii4(out, 12, "dref");
	writeUint32BE(out, 20, 1);
	writeUint32BE(out, 24, 12);
	writeAscii4(out, 28, "url ");
	writeUint32BE(out, 32, 1);
	return out;
}
function buildSttsBox(durations) {
	const runs = [];
	for (const d of durations) {
		const delta = Math.max(1, d >>> 0);
		const last = runs[runs.length - 1];
		if (last && last.delta === delta) last.count += 1;
		else runs.push({
			count: 1,
			delta
		});
	}
	const out = new Uint8Array(16 + runs.length * 8);
	writeUint32BE(out, 0, out.byteLength);
	writeAscii4(out, 4, "stts");
	writeUint32BE(out, 12, runs.length);
	for (let i = 0; i < runs.length; i++) {
		writeUint32BE(out, 16 + i * 8, runs[i].count);
		writeUint32BE(out, 20 + i * 8, runs[i].delta);
	}
	return out;
}
function buildStscSingleChunkBox(totalSamples) {
	const out = /* @__PURE__ */ new Uint8Array(28);
	writeUint32BE(out, 0, 28);
	writeAscii4(out, 4, "stsc");
	writeUint32BE(out, 12, 1);
	writeUint32BE(out, 16, 1);
	writeUint32BE(out, 20, totalSamples);
	writeUint32BE(out, 24, 1);
	return out;
}
function buildStszBox(sizes) {
	const out = new Uint8Array(20 + sizes.length * 4);
	writeUint32BE(out, 0, out.byteLength);
	writeAscii4(out, 4, "stsz");
	writeUint32BE(out, 12, 0);
	writeUint32BE(out, 16, sizes.length);
	for (let i = 0; i < sizes.length; i++) writeUint32BE(out, 20 + i * 4, sizes[i] >>> 0);
	return out;
}
function buildStcoSingleChunkBox(offset) {
	const out = /* @__PURE__ */ new Uint8Array(20);
	writeUint32BE(out, 0, 20);
	writeAscii4(out, 4, "stco");
	writeUint32BE(out, 12, 1);
	writeUint32BE(out, 16, offset >>> 0);
	return out;
}
/**
* Remuxa un MP4 fragmentado sin cifrar (`moov` + `moof`/`mdat`) a un `.m4a` ISO-BMFF
* estándar no fragmentado con duración y tabla de muestras reales en `moov`, para que
* reproductores de escritorio/móvil no reporten duraciones erróneas (p. ej. 435 horas).
*/
function remuxFragmentedMp4ToStandardM4a(bytes) {
	if (bytes.length < 16 || readAscii4(bytes, 4) !== "ftyp") return null;
	const init = {
		encrypted: false,
		mdhdTimescale: 44100,
		mdhdLang: 21956,
		trexDefaultDuration: 1024,
		trexDefaultSize: 0,
		stsdBox: null,
		hdlrBox: null,
		smhdBox: null,
		dinfBox: null,
		udtaBox: null
	};
	const inspectInitContainers = (start, end) => {
		const containers = /* @__PURE__ */ new Set([
			"moov",
			"trak",
			"mdia",
			"minf",
			"stbl",
			"mvex"
		]);
		let pos = start;
		while (pos + 8 <= end) {
			const box = readBoxHeader(bytes, pos, end);
			if (!box) break;
			const cStart = pos + box.headerSize;
			const cEnd = pos + box.boxSize;
			if (box.type === "enca" || box.type === "encv" || box.type === "sinf" || box.type === "schi") init.encrypted = true;
			else if (box.type === "mdhd" && cStart + 24 <= cEnd) {
				const ver = bytes[cStart];
				if (ver === 0 && cStart + 20 <= cEnd) {
					const ts = readUint32BE(bytes, cStart + 12);
					if (ts > 0) init.mdhdTimescale = ts;
					init.mdhdLang = bytes[cStart + 20] << 8 | bytes[cStart + 21];
				} else if (ver === 1 && cStart + 32 <= cEnd) {
					const ts = readUint32BE(bytes, cStart + 20);
					if (ts > 0) init.mdhdTimescale = ts;
					init.mdhdLang = bytes[cStart + 32] << 8 | bytes[cStart + 33];
				}
			} else if (box.type === "trex" && cStart + 24 <= cEnd) {
				const defDur = readUint32BE(bytes, cStart + 12);
				const defSz = readUint32BE(bytes, cStart + 16);
				if (defDur > 0) init.trexDefaultDuration = defDur;
				if (defSz > 0) init.trexDefaultSize = defSz;
			} else if (box.type === "stsd") {
				init.stsdBox = bytes.slice(pos, cEnd);
				if (cStart + 8 < cEnd) inspectInitContainers(cStart + 8, cEnd);
			} else if (box.type === "hdlr") init.hdlrBox = bytes.slice(pos, cEnd);
			else if (box.type === "smhd") init.smhdBox = bytes.slice(pos, cEnd);
			else if (box.type === "dinf") init.dinfBox = bytes.slice(pos, cEnd);
			else if (box.type === "udta") init.udtaBox = bytes.slice(pos, cEnd);
			else if (containers.has(box.type)) inspectInitContainers(cStart, cEnd);
			pos = cEnd;
		}
	};
	const sampleSizes = [];
	const sampleDurations = [];
	const payloadChunks = [];
	let pendingSamples = null;
	let offset = 0;
	while (offset + 8 <= bytes.length) {
		const box = readBoxHeader(bytes, offset, bytes.length);
		if (!box) break;
		const cStart = offset + box.headerSize;
		const cEnd = offset + box.boxSize;
		if (box.type === "moov") {
			inspectInitContainers(cStart, cEnd);
			if (init.encrypted || !init.stsdBox) return null;
		} else if (box.type === "moof") {
			pendingSamples = null;
			let tfDefaultDur = init.trexDefaultDuration;
			let tfDefaultSize = init.trexDefaultSize;
			let mOff = cStart;
			while (mOff + 8 <= cEnd) {
				const sub = readBoxHeader(bytes, mOff, cEnd);
				if (!sub) break;
				if (sub.type === "traf") {
					let tOff = mOff + sub.headerSize;
					const tEnd = mOff + sub.boxSize;
					while (tOff + 8 <= tEnd) {
						const tb = readBoxHeader(bytes, tOff, tEnd);
						if (!tb) break;
						const tcStart = tOff + tb.headerSize;
						const tcEnd = tOff + tb.boxSize;
						if (tb.type === "tfhd" && tcStart + 8 <= tcEnd) {
							const flags = readUint32BE(bytes, tcStart) & 16777215;
							let p = tcStart + 8;
							if (flags & 1) p += 8;
							if (flags & 2) p += 4;
							if (flags & 8 && p + 4 <= tcEnd) {
								const d = readUint32BE(bytes, p);
								if (d > 0) tfDefaultDur = d;
								p += 4;
							}
							if (flags & 16 && p + 4 <= tcEnd) tfDefaultSize = readUint32BE(bytes, p);
						} else if (tb.type === "trun" && tcStart + 8 <= tcEnd) {
							const flags = readUint32BE(bytes, tcStart) & 16777215;
							const sampleCount = readUint32BE(bytes, tcStart + 4);
							let p = tcStart + 8;
							if (flags & 1) p += 4;
							if (flags & 4) p += 4;
							const hasDur = Boolean(flags & 256);
							const hasSize = Boolean(flags & 512);
							const hasFlags = Boolean(flags & 1024);
							const hasCto = Boolean(flags & 2048);
							const fragSamples = [];
							for (let s = 0; s < sampleCount; s++) {
								let dur = tfDefaultDur;
								if (hasDur) {
									if (p + 4 > tcEnd) break;
									dur = readUint32BE(bytes, p) || tfDefaultDur;
									p += 4;
								}
								let size = tfDefaultSize;
								if (hasSize) {
									if (p + 4 > tcEnd) break;
									size = readUint32BE(bytes, p);
									p += 4;
								}
								if (hasFlags) p += 4;
								if (hasCto) p += 4;
								if (size > 0) fragSamples.push({
									dur,
									size
								});
							}
							if (fragSamples.length > 0) pendingSamples = fragSamples;
						}
						tOff = tcEnd;
					}
				}
				mOff += sub.boxSize;
			}
		} else if (box.type === "mdat" && pendingSamples) {
			let fragBytes = 0;
			for (const s of pendingSamples) fragBytes += s.size;
			if (fragBytes > 0 && cStart + fragBytes <= cEnd) {
				payloadChunks.push(bytes.subarray(cStart, cStart + fragBytes));
				for (const s of pendingSamples) {
					sampleDurations.push(s.dur);
					sampleSizes.push(s.size);
				}
			}
			pendingSamples = null;
		}
		offset = cEnd;
	}
	if (!init.stsdBox || init.encrypted || sampleSizes.length === 0) return null;
	let totalPayload = 0;
	for (const chunk of payloadChunks) totalPayload += chunk.byteLength;
	if (totalPayload === 0) return null;
	let totalMediaDuration = 0;
	for (const d of sampleDurations) totalMediaDuration += d;
	const movieTimescale = 1e3;
	const movieDuration = Math.max(1, Math.round(totalMediaDuration / init.mdhdTimescale * movieTimescale));
	const ftyp = buildStandardFtypBox();
	const stts = buildSttsBox(sampleDurations);
	const stsc = buildStscSingleChunkBox(sampleSizes.length);
	const stsz = buildStszBox(sampleSizes);
	const stcoPlaceholder = buildStcoSingleChunkBox(0);
	const stbl = makeMp4ContainerBox("stbl", [
		init.stsdBox,
		stts,
		stsc,
		stsz,
		stcoPlaceholder
	]);
	const minf = makeMp4ContainerBox("minf", [
		init.smhdBox ?? buildDefaultSmhd(),
		init.dinfBox ?? buildDefaultDinf(),
		stbl
	]);
	const mdia = makeMp4ContainerBox("mdia", [
		buildMdhdBox(init.mdhdTimescale, totalMediaDuration, init.mdhdLang),
		init.hdlrBox ?? buildDefaultSounHdlr(),
		minf
	]);
	const trak = makeMp4ContainerBox("trak", [buildTkhdBox(movieDuration), mdia]);
	const moovChildren = [buildMvhdBox(movieTimescale, movieDuration), trak];
	if (init.udtaBox) moovChildren.push(init.udtaBox);
	const moov = makeMp4ContainerBox("moov", moovChildren);
	const mdatPayloadOffset = ftyp.byteLength + moov.byteLength + 8;
	const udtaLen = init.udtaBox ? init.udtaBox.byteLength : 0;
	writeUint32BE(moov, moov.byteLength - udtaLen - 4, mdatPayloadOffset);
	const mdatHeader = /* @__PURE__ */ new Uint8Array(8);
	writeUint32BE(mdatHeader, 0, 8 + totalPayload);
	writeAscii4(mdatHeader, 4, "mdat");
	return concatUint8Arrays([
		ftyp,
		moov,
		mdatHeader,
		...payloadChunks
	]);
}
/**
* Filtra y ordena transcodings de SoundCloud excluyendo flujos DRM cifrados
* (`cbc-encrypted-hls`, `ctr-encrypted-hls`), previews recortados (`snipped`) y playlists heredadas 404.
*/
function orderSoundCloudTranscodings(transcodings) {
	const list = (transcodings ?? []).filter((tr) => {
		if (!tr.url || tr.snipped) return false;
		const proto = (tr.format?.protocol ?? "").toLowerCase();
		if (!proto || proto.includes("encrypted")) return false;
		if (proto !== "progressive" && proto !== "hls") return false;
		const mime = (tr.format?.mime_type ?? "").toLowerCase();
		if (mime.includes("mpegurl")) return false;
		return mime.includes("audio/mpeg") || mime.includes("mp4");
	});
	const rank = (tr) => {
		const proto = (tr.format?.protocol ?? "").toLowerCase();
		const mime = (tr.format?.mime_type ?? "").toLowerCase();
		if (proto === "progressive" && mime.includes("audio/mpeg")) return 0;
		if (proto === "progressive") return 1;
		if (proto === "hls" && mime.includes("audio/mpeg")) return 2;
		if (proto === "hls" && mime.includes("mp4") && mime.includes("mp4a")) return 3;
		if (proto === "hls" && mime.includes("mp4")) return 4;
		return 5;
	};
	return [...list].sort((a, b) => rank(a) - rank(b));
}
// server/catalog.ts
function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(JSON.stringify(payload));
}
/**
* Catálogo remoto (SoundCloud + Audius) con cachés en memoria.
* Lo comparten el plugin de Vite (dev/preview) y las funciones serverless de Vercel.
*/
function createCatalogHandler() {
	let cachedAudiusHosts = [];
	let cachedAudiusHostsAt = 0;
	async function resolveAudiusHosts() {
		const now = Date.now();
		if (cachedAudiusHosts.length > 0 && now - cachedAudiusHostsAt < 6e5) return cachedAudiusHosts;
		try {
			const resp = await fetch("https://api.audius.co", { signal: AbortSignal.timeout(5e3) });
			if (resp.ok) {
				const valid = ((await resp.json()).data ?? []).filter((h) => /^https:\/\/[a-zA-Z0-9.-]+$/.test(h));
				if (valid.length > 0) {
					cachedAudiusHosts = valid;
					cachedAudiusHostsAt = now;
					return cachedAudiusHosts;
				}
			}
		} catch {}
		return cachedAudiusHosts.length > 0 ? cachedAudiusHosts : [
			"https://discoveryprovider.audius.co",
			"https://discoveryprovider2.audius.co",
			"https://discoveryprovider3.audius.co"
		];
	}
	const MIN_FULL_SONG_SECONDS = 60;
	const isPlayablePolicy = (policy) => policy === "ALLOW" || policy === "MONETIZE";
	let cachedScClientId = null;
	let cachedScClientIdAt = 0;
	let trendingCache = null;
	const searchCache = /* @__PURE__ */ new Map();
	const streamCache = /* @__PURE__ */ new Map();
	const MAX_STREAM_CACHE_BYTES = 50331648;
	const STREAM_CACHE_TTL_MS = 6e5;
	function cacheStreamBuffer(key, buffer, mimeType) {
		if (buffer.length > 16777216) return;
		streamCache.delete(key);
		streamCache.set(key, {
			buffer,
			mimeType,
			cachedAt: Date.now()
		});
		let totalBytes = 0;
		for (const entry of streamCache.values()) totalBytes += entry.buffer.length;
		for (const [oldKey, oldVal] of streamCache.entries()) {
			if (totalBytes <= MAX_STREAM_CACHE_BYTES && streamCache.size <= 8) break;
			streamCache.delete(oldKey);
			totalBytes -= oldVal.buffer.length;
		}
	}
	resolveSoundCloudClientId(false);
	resolveAudiusHosts();
	async function resolveSoundCloudClientId(forceRefresh = false) {
		const now = Date.now();
		if (!forceRefresh && cachedScClientId && now - cachedScClientIdAt < 72e5) return cachedScClientId;
		try {
			const scripts = [...(await (await fetch("https://soundcloud.com/", {
				signal: AbortSignal.timeout(6e3),
				headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
			})).text()).matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
			for (const scriptUrl of scripts.slice(-6).reverse()) {
				const match = (await (await fetch(scriptUrl, { signal: AbortSignal.timeout(6e3) })).text()).match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{20,40})["']/);
				if (match) {
					cachedScClientId = match[1];
					cachedScClientIdAt = now;
					return cachedScClientId;
				}
			}
		} catch {}
		return cachedScClientId;
	}
	function orderSoundCloudTranscodings$1(track) {
		return orderSoundCloudTranscodings(track.media?.transcodings);
	}
	function pickSoundCloudTranscoding(track) {
		return orderSoundCloudTranscodings$1(track)[0] ?? null;
	}
	function scoreSoundCloudCandidate(track, query) {
		const title = (track.title ?? "").toLowerCase();
		const artist = (track.user?.username ?? track.publisher_metadata?.artist ?? "").toLowerCase();
		const qLower = query.toLowerCase();
		const tokens = qLower.split(/\s+/).filter((t) => t.length >= 2);
		let score = Math.log10(Math.max(10, track.playback_count ?? 10)) * 10;
		for (const tok of tokens) {
			if (title.includes(tok)) score += 25;
			if (artist.includes(tok)) score += 15;
		}
		for (const term of [
			"slowed",
			"reverb",
			"sped up",
			"nightcore",
			"8d",
			"karaoke",
			"instrumental",
			"remix",
			"bootleg"
		]) if (title.includes(term) && !qLower.includes(term)) score -= 18;
		if (track.media?.transcodings?.some((tr) => tr.format?.protocol === "progressive" && !tr.snipped)) score += 8;
		return score;
	}
	function mapAudiusTracks(rawList, host) {
		return rawList.filter((t) => Boolean(t.id && t.title) && (Number(t.duration) || 0) >= MIN_FULL_SONG_SECONDS).map((t) => ({
			id: String(t.id),
			title: String(t.title ?? "Sin título"),
			artist: String(t.user?.name || t.user?.handle || ""),
			duration: Number(t.duration) || 0,
			genre: String(t.genre ?? ""),
			artworkUrl: t.artwork?.["150x150"] ?? t.artwork?.["480x480"] ?? null,
			host
		}));
	}
	function mapSoundCloudTracks(rawList, query) {
		const valid = rawList.filter((t) => {
			if (!t.id || !t.title) return false;
			if (!isPlayablePolicy(t.policy)) return false;
			if (Math.round((t.duration || 0) / 1e3) < MIN_FULL_SONG_SECONDS) return false;
			return pickSoundCloudTranscoding(t) !== null;
		});
		valid.sort((a, b) => scoreSoundCloudCandidate(b, query) - scoreSoundCloudCandidate(a, query));
		return valid.map((t) => ({
			id: `sc-${String(t.id)}`,
			title: String(t.title ?? "Sin título"),
			artist: String(t.publisher_metadata?.artist || t.user?.username || ""),
			duration: Math.round((t.duration || 0) / 1e3),
			genre: String(t.genre ?? ""),
			artworkUrl: t.artwork_url ? t.artwork_url.replace("-large", "-t300x300") : null,
			host: "soundcloud"
		}));
	}
	async function searchSoundCloudCatalog(query, limit) {
		let clientId = await resolveSoundCloudClientId(false);
		if (!clientId) return [];
		for (let attempt = 0; attempt < 2; attempt++) try {
			const endpoint = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${encodeURIComponent(clientId)}&limit=${Math.min(50, Math.max(limit * 2, 35))}`;
			const resp = await fetch(endpoint, { signal: AbortSignal.timeout(3800) });
			if ((resp.status === 401 || resp.status === 403) && attempt === 0) {
				clientId = await resolveSoundCloudClientId(true);
				if (!clientId) return [];
				continue;
			}
			if (!resp.ok) return [];
			const payload = await resp.json();
			return mapSoundCloudTracks(Array.isArray(payload.collection) ? payload.collection : [], query).slice(0, limit);
		} catch {
			return [];
		}
		return [];
	}
	async function fetchPopularDefaultCatalog(limit) {
		try {
			const results = await Promise.all([
				"Bad Bunny Titi Me Pregunto",
				"Karol G Provenza",
				"Grupo Niche Cali Pachanguero",
				"Daddy Yankee Gasolina",
				"Feid Luna"
			].map((s) => searchSoundCloudCatalog(s, 5)));
			const merged = [];
			const seen = /* @__PURE__ */ new Set();
			for (let i = 0; i < 5; i++) for (const list of results) {
				const item = list[i];
				if (item && !seen.has(item.id)) {
					seen.add(item.id);
					merged.push(item);
				}
			}
			if (merged.length > 0) return merged.slice(0, limit);
			const hosts = await resolveAudiusHosts();
			for (const host of hosts.slice(0, 2)) try {
				const trResp = await fetch(`${host}/v1/tracks/trending?limit=${limit}&app_name=GradMix`, { signal: AbortSignal.timeout(5e3) });
				if (trResp.ok) {
					const payload = await trResp.json();
					const mapped = mapAudiusTracks(Array.isArray(payload.data) ? payload.data : [], host);
					if (mapped.length > 0) return mapped.slice(0, limit);
				}
			} catch {}
		} catch {}
		return [];
	}
	async function searchAudiusCatalog(query, limit) {
		const hosts = await resolveAudiusHosts();
		for (const host of hosts.slice(0, 2)) try {
			const endpoint = `${host}/v1/tracks/search?query=${encodeURIComponent(query)}&limit=${Math.max(limit * 2, 16)}&app_name=GradMix`;
			const resp = await fetch(endpoint, { signal: AbortSignal.timeout(2800) });
			if (!resp.ok) continue;
			const payload = await resp.json();
			return mapAudiusTracks(Array.isArray(payload.data) ? payload.data : [], host).slice(0, limit);
		} catch {}
		return [];
	}
	async function fetchSegmentsBuffer(urls, signal) {
		const chunks = new Array(urls.length);
		const CONCURRENCY = Math.min(16, urls.length);
		let nextIdx = 0;
		async function worker() {
			while (nextIdx < urls.length) {
				const idx = nextIdx++;
				const r = await fetch(urls[idx], { signal });
				if (!r.ok) throw new Error(`Error de segmento HLS HTTP ${r.status}`);
				chunks[idx] = Buffer.from(await r.arrayBuffer());
			}
		}
		await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
		return Buffer.concat(chunks);
	}
	async function streamSoundCloudFullTrack(scId, res) {
		let clientId = await resolveSoundCloudClientId(false);
		if (!clientId) return false;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 35e3);
		try {
			let trackMeta = null;
			for (let attempt = 0; attempt < 2; attempt++) {
				const metaResp = await fetch(`https://api-v2.soundcloud.com/tracks/${scId}?client_id=${encodeURIComponent(clientId)}`, { signal: controller.signal });
				if ((metaResp.status === 401 || metaResp.status === 403) && attempt === 0) {
					clientId = await resolveSoundCloudClientId(true);
					if (!clientId) return false;
					continue;
				}
				if (metaResp.ok) trackMeta = await metaResp.json();
				break;
			}
			if (!trackMeta || !isPlayablePolicy(trackMeta.policy)) return false;
			const transcodings = orderSoundCloudTranscodings$1(trackMeta);
			if (transcodings.length === 0) return false;
			const authQuery = trackMeta.track_authorization ? `&track_authorization=${encodeURIComponent(trackMeta.track_authorization)}` : "";
			for (const transcoding of transcodings) {
				if (!transcoding.url) continue;
				const sep = transcoding.url.includes("?") ? "&" : "?";
				const resolvedResp = await fetch(`${transcoding.url}${sep}client_id=${encodeURIComponent(clientId)}${authQuery}`, { signal: controller.signal });
				if (!resolvedResp.ok) continue;
				const resolvedJson = await resolvedResp.json();
				if (!resolvedJson.url) continue;
				if (transcoding.format?.protocol === "progressive") {
					const upstream = await fetch(resolvedJson.url, {
						redirect: "follow",
						signal: controller.signal
					});
					const upstreamType = (upstream.headers.get("content-type") ?? "").toLowerCase();
					if (upstream.ok && upstream.body && !upstreamType.includes("text/html") && !upstreamType.includes("application/json")) {
						clearTimeout(timer);
						pipeUpstreamAudio(upstream, res, controller);
						return true;
					}
					await upstream.body?.cancel().catch(() => {});
					continue;
				}
				const m3u8Resp = await fetch(resolvedJson.url, { signal: controller.signal });
				if (!m3u8Resp.ok) continue;
				const m3u8Text = await m3u8Resp.text();
				if (/#EXT-X-KEY/i.test(m3u8Text)) continue;
				const mapMatch = m3u8Text.match(/#EXT-X-MAP:URI="([^"]+)"/);
				const segUrls = m3u8Text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
				if (segUrls.length === 0) continue;
				const assembled = await fetchSegmentsBuffer(mapMatch ? [mapMatch[1], ...segUrls] : segUrls, controller.signal);
				const containerInfo = inspectAudioContainer(assembled);
				if (containerInfo.encrypted || containerInfo.kind === "invalid-text") continue;
				clearTimeout(timer);
				const remuxed = containerInfo.fragmentedMp4 ? remuxFragmentedMp4ToStandardM4a(assembled) : null;
				const outputBuf = remuxed ? Buffer.from(remuxed.buffer, remuxed.byteOffset, remuxed.byteLength) : assembled;
				const mimeType = containerInfo.mimeType ?? (transcoding.format?.mime_type?.includes("mp4") ? "audio/mp4" : "audio/mpeg");
				cacheStreamBuffer(`sc-${scId}`, outputBuf, mimeType);
				res.statusCode = 200;
				res.setHeader("Content-Type", mimeType);
				res.setHeader("Content-Length", outputBuf.length);
				res.setHeader("Cache-Control", "no-store");
				res.end(outputBuf);
				return true;
			}
			return false;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
	}
	function pipeUpstreamAudio(upstream, res, controller) {
		res.statusCode = 200;
		res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/mpeg");
		const contentLen = upstream.headers.get("content-length");
		if (contentLen) res.setHeader("Content-Length", contentLen);
		res.setHeader("Cache-Control", "no-store");
		const nodeStream = Readable.fromWeb(upstream.body);
		const cleanupStream = () => {
			if (!res.writableEnded) {
				try {
					controller.abort();
				} catch {}
				nodeStream.destroy();
			}
		};
		nodeStream.on("error", () => {
			if (!res.destroyed) res.destroy();
		});
		res.on("error", cleanupStream);
		res.on("close", cleanupStream);
		nodeStream.pipe(res);
	}
	async function handleCatalogApi(res, reqPath, url, method) {
		if (method !== "GET") {
			sendJson(res, 405, { error: "Método no permitido." });
			return;
		}
		if (reqPath === "/api/catalog/trending") {
			const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
			if (trendingCache && Date.now() < trendingCache.expiresAt && trendingCache.tracks.length > 0) {
				sendJson(res, 200, {
					tracks: trendingCache.tracks.slice(0, limit),
					host: "catalog"
				});
				return;
			}
			const tracks = await fetchPopularDefaultCatalog(limit);
			if (tracks.length > 0) trendingCache = {
				tracks,
				expiresAt: Date.now() + 6e5
			};
			sendJson(res, 200, {
				tracks,
				host: "catalog"
			});
			return;
		}
		if (reqPath === "/api/catalog/search") {
			const q = (url.searchParams.get("q") ?? "").trim();
			const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
			if (!q) {
				sendJson(res, 200, {
					tracks: [],
					host: ""
				});
				return;
			}
			const cacheKey = `${q.toLowerCase()}|${limit}`;
			const cached = searchCache.get(cacheKey);
			if (cached && Date.now() < cached.expiresAt) {
				sendJson(res, 200, {
					tracks: cached.tracks,
					host: "catalog"
				});
				return;
			}
			const [scTracks, audiusTracks] = await Promise.all([searchSoundCloudCatalog(q, limit), searchAudiusCatalog(q, Math.max(4, Math.floor(limit / 3)))]);
			const combined = [...scTracks, ...audiusTracks].slice(0, limit);
			if (combined.length > 0) {
				if (searchCache.size >= 60) {
					const oldestKey = searchCache.keys().next().value;
					if (oldestKey !== void 0) searchCache.delete(oldestKey);
				}
				searchCache.set(cacheKey, {
					tracks: combined,
					expiresAt: Date.now() + 18e4
				});
			}
			sendJson(res, 200, {
				tracks: combined,
				host: "catalog"
			});
			return;
		}
		if (reqPath === "/api/catalog/stream") {
			const trackId = (url.searchParams.get("trackId") ?? "").trim();
			if (!/^[A-Za-z0-9_-]{1,40}$/.test(trackId)) {
				sendJson(res, 400, { error: "trackId inválido." });
				return;
			}
			const cachedStream = streamCache.get(trackId);
			if (cachedStream && Date.now() - cachedStream.cachedAt < STREAM_CACHE_TTL_MS) {
				res.statusCode = 200;
				res.setHeader("Content-Type", cachedStream.mimeType);
				res.setHeader("Content-Length", cachedStream.buffer.length);
				res.setHeader("Cache-Control", "no-store");
				res.end(cachedStream.buffer);
				return;
			}
			if (trackId.startsWith("sc-")) {
				const scId = trackId.slice(3);
				if (!/^\d{1,20}$/.test(scId)) {
					sendJson(res, 400, { error: "ID inválido." });
					return;
				}
				if (!await streamSoundCloudFullTrack(scId, res) && !res.headersSent) sendJson(res, 502, { error: "No se pudo descargar la canción completa." });
				return;
			}
			const hosts = await resolveAudiusHosts();
			const preferred = (url.searchParams.get("host") ?? "").trim();
			const orderedHosts = preferred && hosts.includes(preferred) ? [preferred, ...hosts.filter((h) => h !== preferred)] : hosts;
			for (const host of orderedHosts.slice(0, 4)) {
				const controller = new AbortController();
				const connectTimer = setTimeout(() => controller.abort(), 12e3);
				try {
					const streamUrl = `${host}/v1/tracks/${encodeURIComponent(trackId)}/stream?app_name=GradMix`;
					const upstream = await fetch(streamUrl, {
						redirect: "follow",
						signal: controller.signal
					});
					clearTimeout(connectTimer);
					if (!upstream.ok || !upstream.body) {
						await upstream.body?.cancel().catch(() => {});
						continue;
					}
					const upstreamType = (upstream.headers.get("content-type") ?? "").toLowerCase();
					if (upstreamType.includes("text/html") || upstreamType.includes("application/json")) {
						await upstream.body?.cancel().catch(() => {});
						continue;
					}
					pipeUpstreamAudio(upstream, res, controller);
					return;
				} catch {
					clearTimeout(connectTimer);
				}
			}
			sendJson(res, 502, { error: "No se pudo descargar el audio." });
			return;
		}
		sendJson(res, 404, { error: "Ruta de catálogo no encontrada." });
	}
	return { handle: handleCatalogApi };
}
// server/api/catalog/stream.ts
var catalog = createCatalogHandler();
async function handler(req, res) {
	const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
	try {
		await catalog.handle(res, "/api/catalog/stream", url, (req.method ?? "GET").toUpperCase());
	} catch (err) {
		if (!res.headersSent) {
			const message = err instanceof Error ? err.message : "Error al descargar audio.";
			res.statusCode = 500;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify({ error: message }));
		}
	}
}
export { handler as default };
