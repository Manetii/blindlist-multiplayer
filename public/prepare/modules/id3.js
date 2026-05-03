/**
 * ════════════════════════════════════════════════════════════════
 *  ID3 Reader — Lecture des métadonnées MP3 (titre, artiste)
 * ════════════════════════════════════════════════════════════════
 *
 *  Parse les tags ID3v2 d'un buffer MP3.
 *  Gère ISO-8859-1, UTF-16 (avec/sans BOM), UTF-8.
 *  Renvoie { title, artist } (chaînes vides si non trouvés).
 * ════════════════════════════════════════════════════════════════ */

window.ID3 = (() => {

  function decodeString(buf, offset, length) {
    if (length <= 0) return "";
    const enc = new DataView(buf).getUint8(offset);
    const bytes = new Uint8Array(buf, offset + 1, length - 1);

    if (enc === 0) {
      // ISO-8859-1
      return Array.from(bytes)
        .filter(b => b !== 0)
        .map(b => String.fromCharCode(b))
        .join("");
    }
    if (enc === 3) {
      // UTF-8
      const filtered = new Uint8Array(Array.from(bytes).filter(b => b !== 0));
      return new TextDecoder("utf-8").decode(filtered);
    }
    if (enc === 1 || enc === 2) {
      // UTF-16 LE/BE avec ou sans BOM
      let start = 0;
      if (
        bytes.length >= 2 &&
        ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
         (bytes[0] === 0xfe && bytes[1] === 0xff))
      ) {
        start = 2;
      }
      const littleEndian =
        (bytes[0] === 0xff && bytes[1] === 0xfe) || enc === 1;
      const relevant = bytes.slice(start);
      const u16 = [];
      for (let i = 0; i + 1 < relevant.length; i += 2) {
        const cp = littleEndian
          ? relevant[i] | (relevant[i + 1] << 8)
          : (relevant[i] << 8) | relevant[i + 1];
        if (cp === 0) break;
        u16.push(cp);
      }
      return String.fromCharCode(...u16);
    }
    return "";
  }

  /** Parse un ArrayBuffer MP3 et retourne { title, artist }. */
  function parse(buf) {
    const out = { title: "", artist: "" };
    const dv = new DataView(buf);

    if (dv.byteLength < 10) return out;
    const id3 = String.fromCharCode(
      dv.getUint8(0), dv.getUint8(1), dv.getUint8(2)
    );
    if (id3 !== "ID3") return out;

    const flags = dv.getUint8(5);
    const hasExt = (flags & 0x40) !== 0;
    let pos = 10;

    if (hasExt) {
      const extSz =
        ((dv.getUint8(10) & 0x7f) << 21) |
        ((dv.getUint8(11) & 0x7f) << 14) |
        ((dv.getUint8(12) & 0x7f) << 7) |
        (dv.getUint8(13) & 0x7f);
      pos += extSz;
    }

    const end = Math.min(buf.byteLength, 2_000_000);

    while (pos + 10 < end) {
      const frameId = String.fromCharCode(
        dv.getUint8(pos), dv.getUint8(pos + 1),
        dv.getUint8(pos + 2), dv.getUint8(pos + 3)
      );
      if (frameId === "\0\0\0\0" || frameId.trim() === "") break;

      const sz = dv.getUint32(pos + 4);
      if (sz === 0 || sz > end - pos - 10) break;

      if (frameId === "TIT2" || frameId === "TPE1") {
        const txt = decodeString(buf, pos + 10, sz);
        if (frameId === "TIT2") out.title  = txt;
        if (frameId === "TPE1") out.artist = txt;
      }

      pos += 10 + sz;
    }
    return out;
  }

  /** Lit un File (ou Blob) et retourne une Promise<{title, artist}>. */
  function readFile(file) {
    return new Promise((resolve, reject) => {
      // Lit seulement les premiers 256KB (largement suffisant pour les tags ID3)
      const slice = file.slice(0, 256 * 1024);
      const reader = new FileReader();
      reader.onload = (e) => {
        try { resolve(parse(e.target.result)); }
        catch (err) { resolve({ title: "", artist: "" }); }
      };
      reader.onerror = () => resolve({ title: "", artist: "" });
      reader.readAsArrayBuffer(slice);
    });
  }

  return { parse, readFile };
})();
