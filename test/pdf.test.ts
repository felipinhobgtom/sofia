import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderPdfPages } from '../src/pdf.ts';
import { UserInputError } from '../src/types.ts';

function stream(data: string, dictionary = ''): string {
  return `<< /Length ${Buffer.byteLength(data)} ${dictionary} >>\nstream\n${data}\nendstream`;
}

function pdfFixture(contents: string[], encrypted = false): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (globalThis.pdfScriptExecuted = true;) >> >>',
    `<< /Type /Pages /Count ${contents.length} /Kids [${contents.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('0000ffffff000000ff0000ff>', '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode'),
  ];
  for (const content of contents) {
    const contentId = objects.length + 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 1800] /Resources << /Font << /F1 3 0 R >> /XObject << /Scan 4 0 R >> >> /Contents ${contentId} 0 R >>`,
      stream(content),
    );
  }
  let encryption = '';
  if (encrypted) {
    // Standard revision-2 encryption, password "fixture", with a fixed file ID; the empty page needs no ciphertext.
    objects.push('<< /Filter /Standard /V 1 /R 2 /O <87f2144244ab0101b5792f083fb7902b1665671bdd8bd89ee01076c248489ffe> /U <065952d45cd33dcfdb63a0445b5f5c05f2dc0f03baaceba947fecbcf8c55807e> /P -4 >>');
    encryption = `/Encrypt ${objects.length} 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>]`;
  }
  let body = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const startxref = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(`${body}trailer\n<< /Size ${offsets.length} /Root 1 0 R ${encryption} >>\nstartxref\n${startxref}\n%%EOF\n`);
}

const firstPage = 'BT /F1 48 Tf 100 1650 Td (First line) Tj 0 -70 Td (Second line) Tj ET\n1 0 0 rg 100 600 300 800 re f\nq 400 0 0 800 600 600 cm /Scan Do Q';
const scannedPage = 'q 800 0 0 800 100 600 cm /Scan Do Q';

async function collectPages(bytes: Buffer) {
  const pages = [];
  for await (const page of renderPdfPages(bytes)) pages.push(page);
  return pages;
}

async function raster(dataUrl: string) {
  assert.ok(dataUrl.startsWith('data:image/jpeg;base64,'));
  const image = await loadImage(dataUrl);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    pixel: (x: number, y: number) => Array.from(context.getImageData(
      Math.floor(x * image.width), Math.floor(y * image.height), 1, 1,
    ).data),
    close: () => { canvas.width = canvas.height = 0; },
  };
}

test('renders every page with bounded white-backed JPEGs, native text, charts and scan-only pages', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Unexpected network access'); });
  const pages = await collectPages(pdfFixture([
    firstPage,
    scannedPage,
    'BT /F1 48 Tf 100 1650 Td (Third page) Tj ET',
    'BT /F1 48 Tf 100 1650 Td (Last page) Tj ET',
  ]));
  assert.deepEqual(pages.map(page => [page.pageNumber, page.totalPages]), [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.deepEqual(pages.map(page => page.text.split(/\s+/)), [
    ['First', 'line', 'Second', 'line'], [''], ['Third', 'page'], ['Last', 'page'],
  ]);
  for (const page of pages) {
    const image = await raster(page.dataUrl);
    try {
      assert.ok(image.width > 0 && image.width <= 2000 && image.height > 0 && image.height <= 2000);
      assert.deepEqual(image.pixel(0, 0), [255, 255, 255, 255]);
      if (page.pageNumber === 1) {
        const [red, green, blue] = image.pixel(0.2, 0.5);
        assert.ok(red > 220 && green < 30 && blue < 30, 'the chart remains visible alongside native text');
        const [scanRed, scanGreen, scanBlue] = image.pixel(0.55, 0.5);
        assert.ok(scanBlue > 220 && scanRed < 30 && scanGreen < 30, 'the embedded image remains visible alongside native text');
      } else if (page.pageNumber === 2) {
        const [red, green, blue] = image.pixel(0.2, 0.5);
        assert.ok(blue > 220 && red < 30 && green < 30, 'a scanned page is not replaced by empty extracted text');
      }
    } finally {
      image.close();
    }
  }
  assert.equal(requests, 0);
  assert.equal(Reflect.get(globalThis, 'pdfScriptExecuted'), undefined);
});

test('preserves a sliced input Buffer and its backing store across complete and cancelled iteration', async () => {
  const pdf = pdfFixture([firstPage, scannedPage]);
  const backing = Buffer.allocUnsafeSlow(pdf.length + 32).fill(0x5a);
  const bytes = backing.subarray(17, 17 + pdf.length);
  pdf.copy(bytes);
  const before = Buffer.from(backing);
  const iterator = renderPdfPages(bytes);
  const first = await iterator.next();
  assert.equal(first.value?.pageNumber, 1);
  await iterator.return(undefined);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.deepEqual(backing, before);
  assert.deepEqual((await collectPages(bytes)).map(page => page.pageNumber), [1, 2]);
  assert.deepEqual(backing, before);
});

test('cancellation does not render a later damaged page or replace the consumer error', async () => {
  const bytes = pdfFixture([firstPage, '/MissingImage Do']);
  const iterator = renderPdfPages(bytes);
  const first = await iterator.next();
  assert.equal(first.value?.pageNumber, 1);
  const consumerError = new Error('consumer stopped');
  await assert.rejects(iterator.throw(consumerError), error => error === consumerError);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  const fresh = renderPdfPages(bytes);
  assert.equal((await fresh.next()).value?.pageNumber, 1);
  await assert.rejects(fresh.next(), UserInputError);
  const image = await raster(first.value!.dataUrl);
  try {
    assert.deepEqual(image.pixel(0, 0), [255, 255, 255, 255]);
  } finally {
    image.close();
  }
});

test('invalid, truncated and password-protected PDFs fail safely without body logging', async t => {
  const logs: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  }
  const complete = pdfFixture([firstPage]);
  const invalid = Buffer.from('%PDF-1.7\nPRIVATE_PDF_BODY\n%%EOF\n');
  const truncated = complete.subarray(0, complete.lastIndexOf('startxref'));
  for (const bytes of [invalid, truncated, pdfFixture([''], true)]) {
    await assert.rejects(collectPages(bytes), error => {
      assert.ok(error instanceof UserInputError);
      assert.ok(!error.message.includes('PRIVATE_PDF_BODY'));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.deepEqual(logs, []);
});
