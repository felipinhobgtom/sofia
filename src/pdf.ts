import { fileURLToPath } from 'node:url';
import type { Canvas } from '@napi-rs/canvas';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { NodeCanvasFactory } from 'pdfjs-dist/types/src/display/node_utils.js';
import { UserInputError } from './types.ts';

export interface PdfPage {
  pageNumber: number;
  totalPages: number;
  dataUrl: string;
  text: string;
}

const MAX_PAGE_EDGE = 2000;
const PDF_NOTICE = 'Não consegui ler este PDF. Envie um PDF válido, completo e sem senha.';
const PDF_END = Buffer.from('%%EOF');
const PDF_ASSETS = new URL('./', import.meta.resolve('pdfjs-dist/package.json'));

function hasCompleteEnding(bytes: Buffer): boolean {
  let end = bytes.length;
  while (end > 0) {
    const byte = bytes[end - 1];
    if (byte !== 0 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13 && byte !== 32) break;
    end--;
  }
  return end >= PDF_END.length && bytes.subarray(end - PDF_END.length, end).equals(PDF_END);
}

async function renderPage(document: PDFDocumentProxy, pageNumber: number): Promise<PdfPage> {
  try {
    const page = await document.getPage(pageNumber);
    try {
      const original = page.getViewport({ scale: 1 });
      const longEdge = Math.max(original.width, original.height);
      if (!Number.isFinite(longEdge) || original.width <= 0 || original.height <= 0) {
        throw new UserInputError(PDF_NOTICE);
      }
      const viewport = page.getViewport({ scale: Math.min(2, MAX_PAGE_EDGE / longEdge) });
      // PDF.js selects its supported @napi-rs/canvas factory in Node; its public getter is typed Object.
      const factory = document.canvasFactory as NodeCanvasFactory;
      const target = factory.create(
        Math.min(MAX_PAGE_EDGE, Math.max(1, Math.ceil(viewport.width))),
        Math.min(MAX_PAGE_EDGE, Math.max(1, Math.ceil(viewport.height))),
      );
      try {
        await page.render({
          canvas: null,
          canvasContext: target.context,
          viewport,
          background: 'white',
        }).promise;
        const content = await page.getTextContent();
        // Preserve PDF.js text flow, bidi ordering and explicit line breaks rather than sorting glyphs.
        const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('').trim();
        const canvas: Canvas = target.context.canvas;
        return {
          pageNumber,
          totalPages: document.numPages,
          dataUrl: await canvas.toDataURLAsync('image/jpeg', 0.85),
          text,
        };
      } finally {
        factory.destroy(target);
      }
    } finally {
      page.cleanup();
    }
  } catch {
    throw new UserInputError(PDF_NOTICE);
  }
}

export async function* renderPdfPages(bytes: Buffer): AsyncGenerator<PdfPage> {
  // PDF.js can repair a missing trailer even with stopAtErrors; never silently accept a truncated file.
  if (!hasCompleteEnding(bytes)) throw new UserInputError(PDF_NOTICE);
  let loadingTask: PDFDocumentLoadingTask;
  try {
    loadingTask = getDocument({
      // PDF.js transfers ownership, so give it an independent array, never the caller's Buffer backing store.
      data: new Uint8Array(bytes),
      stopAtErrors: true,
      verbosity: VerbosityLevel.ERRORS,
      // Assets are bundled npm files. There is no document URL, resource fetch, XFA or scripting runtime.
      cMapUrl: fileURLToPath(new URL('cmaps/', PDF_ASSETS)),
      standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', PDF_ASSETS)),
      wasmUrl: fileURLToPath(new URL('wasm/', PDF_ASSETS)),
      useWorkerFetch: false,
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
    });
  } catch {
    throw new UserInputError(PDF_NOTICE);
  }
  try {
    let document: PDFDocumentProxy;
    try {
      document = await loadingTask.promise;
    } catch {
      throw new UserInputError(PDF_NOTICE);
    }
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      // The page and canvas are released before yielding; cancellation still runs document cleanup below.
      yield await renderPage(document, pageNumber);
    }
  } finally {
    try {
      await loadingTask.destroy();
    } catch {
      throw new UserInputError(PDF_NOTICE);
    }
  }
}
