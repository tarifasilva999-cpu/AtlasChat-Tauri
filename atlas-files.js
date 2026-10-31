(() => {
  "use strict";

  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_ARCHIVE_BYTES = 15 * 1024 * 1024;
  const MAX_ARCHIVE_OUTPUT_BYTES = 30 * 1024 * 1024;
  const MAX_ARCHIVE_ENTRIES = 60;
  const MAX_PDF_PAGES = 40;
  const MAX_PDF_OCR_PAGES = 8;
  const MAX_IMAGE_PIXELS = 60_000_000;
  const MAX_IMAGE_DIMENSION = 12_000;
  const MAX_IMAGE_OCR_DIMENSION = 2_200;
  const ZIP_TEXT_EXTENSIONS = new Set([
    "txt", "md", "csv", "tsv", "json", "html", "htm", "xml", "css", "js", "mjs", "cjs",
    "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "cs", "go", "rs", "sh", "yaml",
    "yml", "toml", "sql", "ini", "log", "gradle", "kt", "swift", "rb", "php", "vue", "svelte"
  ]);
  const TEXT_EXTENSIONS = new Set([...ZIP_TEXT_EXTENSIONS, "text"]);
  const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

  let fflatePromise = null;
  let pdfPromise = null;
  let tesseractPromise = null;
  let ocrWorkerPromise = null;
  let ocrProgressCallback = null;

  const assetUrl = path => new URL(path, document.baseURI).href;
  const extension = name => String(name || "").split(".").at(-1).toLowerCase();
  const progress = (callback, label) => {
    if (typeof callback === "function") callback(label);
  };

  function parseXml(xmlText) {
    const documentXml = new DOMParser().parseFromString(xmlText, "application/xml");
    if (documentXml.querySelector("parsererror")) throw new Error("The document’s XML could not be read.");
    return documentXml;
  }

  async function getFflate() {
    fflatePromise ||= import(assetUrl("./vendor/fflate.mjs"));
    return fflatePromise;
  }

  async function getPdfJs() {
    pdfPromise ||= import(assetUrl("./vendor/pdf.min.mjs")).then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = assetUrl("./vendor/pdf.worker.min.mjs");
      return pdfjs;
    });
    return pdfPromise;
  }

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractPromise) {
      tesseractPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = assetUrl("./vendor/tesseract.min.js");
        script.async = true;
        script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("The local OCR engine did not start."));
        script.onerror = () => reject(new Error("The local OCR engine could not be loaded."));
        document.head.appendChild(script);
      }).catch(error => {
        tesseractPromise = null;
        throw error;
      });
    }
    return tesseractPromise;
  }

  async function getOcrWorker(onProgress) {
    ocrProgressCallback = onProgress;
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = (async () => {
        const Tesseract = await loadTesseract();
        return Tesseract.createWorker("eng", 1, {
          workerPath: assetUrl("./vendor/tesseract-worker.min.js"),
          corePath: assetUrl("./vendor/tesseract-core"),
          langPath: assetUrl("./vendor/eng-data"),
          gzip: true,
          workerBlobURL: false,
          cacheMethod: "write",
          logger: status => {
            if (status?.status) progress(ocrProgressCallback, status.status === "recognizing text" ? "Reading image text…" : "Preparing OCR…");
          }
        });
      })().catch(error => {
        ocrWorkerPromise = null;
        throw error;
      });
    }
    return ocrWorkerPromise;
  }

  async function recognize(image, onProgress) {
    const worker = await getOcrWorker(onProgress);
    const result = await worker.recognize(image);
    return String(result?.data?.text || "").trim();
  }

  function imageDimensions(bytes, ext) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (offset, littleEndian = false) => offset + 2 <= view.byteLength ? view.getUint16(offset, littleEndian) : 0;
    const u24le = offset => offset + 3 <= view.byteLength ? view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16) : 0;
    const u32 = (offset, littleEndian = false) => offset + 4 <= view.byteLength ? view.getUint32(offset, littleEndian) : 0;
    let width = 0, height = 0;

    if (ext === "png" && view.byteLength >= 24) {
      width = u32(16); height = u32(20);
    } else if (ext === "gif" && view.byteLength >= 10) {
      width = u16(6, true); height = u16(8, true);
    } else if (ext === "bmp" && view.byteLength >= 26) {
      width = u32(18, true); height = Math.abs(view.getInt32(22, true));
    } else if ((ext === "jpg" || ext === "jpeg") && view.byteLength >= 4 && u16(0) === 0xffd8) {
      let offset = 2;
      while (offset + 4 < view.byteLength) {
        if (view.getUint8(offset) !== 0xff) { offset++; continue; }
        const marker = view.getUint8(offset + 1);
        offset += 2;
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const length = u16(offset);
        if (length < 2 || offset + length > view.byteLength) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          height = u16(offset + 3); width = u16(offset + 5); break;
        }
        offset += length;
      }
    } else if (ext === "webp" && view.byteLength >= 30) {
      const chunk = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15));
      if (chunk === "VP8X") {
        width = u24le(24) + 1; height = u24le(27) + 1;
      } else if (chunk === "VP8L" && view.getUint8(20) === 0x2f) {
        const bits = u32(21, true);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      } else if (chunk === "VP8 " && view.byteLength >= 30 && view.getUint8(23) === 0x9d && view.getUint8(24) === 0x01 && view.getUint8(25) === 0x2a) {
        width = u16(26, true) & 0x3fff; height = u16(28, true) & 0x3fff;
      }
    }

    if (!width || !height) throw new Error("The image dimensions could not be checked safely.");
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
      throw new Error("This image is too large to OCR safely.");
    }
    return { width, height };
  }

  async function imageForOcr(bytes, ext, mimeType) {
    const dimensions = imageDimensions(bytes, ext);
    const scale = Math.min(1, MAX_IMAGE_OCR_DIMENSION / dimensions.width, MAX_IMAGE_OCR_DIMENSION / dimensions.height);
    const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
    return createImageBitmap(blob, {
      resizeWidth: Math.max(1, Math.round(dimensions.width * scale)),
      resizeHeight: Math.max(1, Math.round(dimensions.height * scale)),
      resizeQuality: "high"
    });
  }

  async function extractImage(bytes, ext, mimeType, onProgress) {
    progress(onProgress, "Preparing image…");
    const bitmap = await imageForOcr(bytes, ext, mimeType);
    try {
      return await recognize(bitmap, onProgress);
    } finally {
      bitmap.close?.();
    }
  }

  async function extractPdf(bytes, maxChars, onProgress) {
    const pdfjs = await getPdfJs();
    const task = pdfjs.getDocument({
      data: bytes,
      useWorkerFetch: false,
      isEvalSupported: false,
      cMapUrl: assetUrl("./vendor/pdf-cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: assetUrl("./vendor/pdf-standard-fonts/"),
      wasmUrl: assetUrl("./vendor/pdf-wasm/")
    });
    const documentPdf = await task.promise;
    const output = [];
    let characters = 0;
    let ocrPages = 0;
    let pagesRead = 0;
    let truncated = documentPdf.numPages > MAX_PDF_PAGES;
    const pageCount = Math.min(documentPdf.numPages, MAX_PDF_PAGES);

    try {
      for (let pageNumber = 1; pageNumber <= pageCount && characters < maxChars; pageNumber++) {
        pagesRead = pageNumber;
        progress(onProgress, `Reading PDF page ${pageNumber} of ${pageCount}…`);
        const page = await documentPdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => {
          if (typeof item.str !== "string") return "";
          return item.str + (item.hasEOL ? "\n" : " ");
        }).join("").trim();
        let value = pageText;

        if (pageText.replace(/\s/g, "").length < 28 && ocrPages < MAX_PDF_OCR_PAGES) {
          ocrPages++;
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(1.35, 1900 / base.width, 1900 / base.height);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d", { alpha: false });
          if (context) {
            await page.render({ canvasContext: context, viewport }).promise;
            progress(onProgress, `Reading scanned PDF page ${pageNumber}…`);
            value = await recognize(canvas, onProgress) || pageText;
          }
          canvas.width = 0; canvas.height = 0;
        } else if (pageText.replace(/\s/g, "").length < 28) {
          truncated = true;
        }

        const section = `Page ${pageNumber}\n${value}\n\n`;
        const remaining = Math.max(0, maxChars - characters);
        const clipped = section.slice(0, remaining);
        output.push(clipped); characters += clipped.length;
        if (clipped.length < section.length) { truncated = true; break; }
        page.cleanup?.();
      }
      if (pagesRead < documentPdf.numPages) truncated = true;
    } finally {
      await documentPdf.destroy();
    }

    return {
      text: output.join("").trim(),
      kind: ocrPages ? "PDF text + English OCR" : "PDF text",
      summary: `${pagesRead}${pagesRead < documentPdf.numPages ? ` of ${documentPdf.numPages}` : ""} page${documentPdf.numPages === 1 ? "" : "s"}${ocrPages ? ` · OCR on ${ocrPages} scanned page${ocrPages === 1 ? "" : "s"}` : ""}`,
      truncated
    };
  }

  function xmlParagraphText(xmlText, paragraphName, textName) {
    const xml = parseXml(xmlText);
    const paragraphs = [...xml.getElementsByTagName("*")].filter(node => node.localName === paragraphName);
    return paragraphs.map(paragraph => [...paragraph.getElementsByTagName("*")]
      .filter(node => node.localName === textName).map(node => node.textContent || "").join("")).filter(Boolean).join("\n");
  }

  async function unzipEntries(bytes, include, limits = {}) {
    const { Unzip, UnzipInflate, UnzipPassThrough } = await getFflate();
    const maxEntries = limits.maxEntries || MAX_ARCHIVE_ENTRIES;
    const maxOutputBytes = limits.maxOutputBytes || MAX_ARCHIVE_OUTPUT_BYTES;
    const maxEntryBytes = limits.maxEntryBytes || 20 * 1024 * 1024;

    return new Promise((resolve, reject) => {
      const entries = [];
      let selected = 0;
      let outputBytes = 0;
      let failure = null;
      const unzip = new Unzip(file => {
        if (failure) return;
        const name = String(file.name || "").replace(/\\/g, "/");
        if (!name || name.endsWith("/") || name.split("/").includes("..") || !include(name)) return;
        if (++selected > maxEntries) { failure = new Error("This archive contains too many readable files."); return; }
        if (Number(file.originalSize) > maxEntryBytes) { failure = new Error("A file inside this archive is too large to read safely."); return; }
        const parts = [];
        let size = 0;
        file.ondata = (error, chunk, final) => {
          if (error) { failure ||= error; return; }
          if (chunk?.length) {
            size += chunk.length; outputBytes += chunk.length;
            if (size > maxEntryBytes || outputBytes > maxOutputBytes) {
              failure ||= new Error("This archive expands beyond the safe reading limit.");
              file.terminate();
              return;
            }
            parts.push(chunk);
          }
          if (final) {
            const bytesOut = new Uint8Array(size);
            let offset = 0;
            for (const part of parts) { bytesOut.set(part, offset); offset += part.length; }
            entries.push({ name, bytes: bytesOut });
          }
        };
        file.start();
      });
      unzip.register(UnzipInflate);
      unzip.register(UnzipPassThrough);

      try {
        const chunkSize = 512 * 1024;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          unzip.push(bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)), offset + chunkSize >= bytes.length);
          if (failure) break;
        }
        if (failure) reject(failure);
        else resolve(entries);
      } catch (error) {
        reject(failure || error);
      }
    });
  }

  async function extractOffice(bytes, ext, maxChars, onProgress) {
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("This office document is too large to read safely.");
    progress(onProgress, ext === "docx" ? "Reading Word document…" : "Reading presentation…");
    const include = ext === "docx"
      ? name => name === "word/document.xml"
      : name => /^ppt\/slides\/slide\d+\.xml$/i.test(name);
    const entries = await unzipEntries(bytes, include, { maxEntries: ext === "docx" ? 1 : 100, maxOutputBytes: MAX_ARCHIVE_OUTPUT_BYTES, maxEntryBytes: 12 * 1024 * 1024 });
    if (!entries.length) throw new Error("No readable text was found in this office document.");

    const ordered = entries.sort((a, b) => {
      const aNumber = Number(a.name.match(/slide(\d+)\.xml$/i)?.[1] || 0);
      const bNumber = Number(b.name.match(/slide(\d+)\.xml$/i)?.[1] || 0);
      return aNumber - bNumber;
    });
    const output = [];
    let chars = 0;
    let truncated = false;
    ordered.forEach((entry, index) => {
      const xmlText = new TextDecoder().decode(entry.bytes);
      const text = xmlParagraphText(xmlText, "p", "t");
      const label = ext === "docx" ? "Document" : `Slide ${index + 1}`;
      const section = `${label}\n${text}\n\n`;
      const remaining = Math.max(0, maxChars - chars);
      const clipped = section.slice(0, remaining);
      output.push(clipped); chars += clipped.length;
      if (clipped.length < section.length) truncated = true;
    });
    return {
      text: output.join("").trim(),
      kind: ext === "docx" ? "Word text" : "Slide text",
      summary: ext === "docx" ? "Text extracted" : `${ordered.length} slide${ordered.length === 1 ? "" : "s"}`,
      truncated
    };
  }

  function visibleHtmlText(bytes) {
    const html = new TextDecoder().decode(bytes);
    const parsed = new DOMParser().parseFromString(html, "text/html");
    parsed.querySelectorAll("script,style,noscript,template,svg,canvas,iframe,object,embed").forEach(node => node.remove());
    return String(parsed.body?.innerText || parsed.body?.textContent || "")
      .replace(/[\t\f\v ]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function parseBytes(name, bytes, options = {}) {
    const ext = extension(name);
    const maxChars = Math.max(0, Number(options.maxChars) || 0);
    const onProgress = options.onProgress;
    if (bytes.length > MAX_FILE_BYTES) throw new Error("This file is larger than Atlas’s 25 MB reading limit.");

    if (TEXT_EXTENSIONS.has(ext)) {
      progress(onProgress, "Extracting text…");
      const text = ext === "html" || ext === "htm" ? visibleHtmlText(bytes) : new TextDecoder().decode(bytes).trim();
      return { text: text.slice(0, maxChars), kind: ext === "html" || ext === "htm" ? "HTML text" : "Text", summary: "Text extracted", truncated: text.length > maxChars };
    }

    if (ext === "pdf") return extractPdf(bytes, maxChars, onProgress);
    if (ext === "docx" || ext === "pptx") return extractOffice(bytes, ext, maxChars, onProgress);
    if (IMAGE_EXTENSIONS.has(ext)) {
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const text = await extractImage(bytes, ext, mime, onProgress);
      return { text: text.slice(0, maxChars), kind: "English OCR", summary: text ? "Text detected with English OCR" : "No text detected", truncated: text.length > maxChars };
    }

    throw new Error("This file type is not supported yet.");
  }

  async function extractZip(bytes, maxChars, onProgress) {
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("ZIP files are limited to 15 MB for safe extraction.");
    progress(onProgress, "Opening ZIP safely…");
    const include = name => {
      const ext = extension(name);
      return TEXT_EXTENSIONS.has(ext) || ext === "pdf" || ext === "docx" || ext === "pptx" || IMAGE_EXTENSIONS.has(ext);
    };
    const entries = await unzipEntries(bytes, include, { maxEntries: MAX_ARCHIVE_ENTRIES, maxOutputBytes: MAX_ARCHIVE_OUTPUT_BYTES, maxEntryBytes: 20 * 1024 * 1024 });
    if (!entries.length) throw new Error("No supported text, document, presentation, PDF, or image files were found in this ZIP.");

    const output = [];
    let characters = 0;
    let readCount = 0;
    let truncated = false;
    for (const entry of entries) {
      if (characters >= maxChars) { truncated = true; break; }
      progress(onProgress, `Reading ${entry.name} from ZIP…`);
      try {
        const result = await parseBytes(entry.name, entry.bytes, {
          maxChars: Math.max(0, maxChars - characters - entry.name.length - 20),
          onProgress
        });
        const section = `File: ${entry.name}\n${result.text || "(No text detected.)"}\n\n`;
        const remaining = Math.max(0, maxChars - characters);
        const clipped = section.slice(0, remaining);
        output.push(clipped); characters += clipped.length; readCount++;
        truncated ||= result.truncated || clipped.length < section.length;
      } catch (error) {
        const section = `File: ${entry.name}\n(Could not read: ${String(error?.message || error).slice(0, 180)})\n\n`;
        const remaining = Math.max(0, maxChars - characters);
        const clipped = section.slice(0, remaining);
        output.push(clipped); characters += clipped.length; readCount++;
        truncated ||= clipped.length < section.length;
      }
    }

    return { text: output.join("").trim(), kind: "ZIP file text", summary: `${readCount} readable file${readCount === 1 ? "" : "s"}`, truncated };
  }

  async function parse(file, options = {}) {
    if (!(file instanceof Blob)) throw new Error("Choose a file Atlas can read.");
    if (file.size > MAX_FILE_BYTES) throw new Error("This file is larger than Atlas’s 25 MB reading limit.");
    const ext = extension(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (ext === "zip") return extractZip(bytes, Number(options.maxChars) || 0, options.onProgress);
    return parseBytes(file.name, bytes, options);
  }

  window.AtlasFiles = Object.freeze({ parse });
})();
