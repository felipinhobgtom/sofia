import PDFDocument from 'pdfkit';
import { quoteStatusLabels } from './business-contract.ts';
import type { QuoteDocument } from './business-contract.ts';

function money(cents: number): string {
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  const reais = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0n ? '-' : ''}R$ ${reais},${(absolute % 100n).toString().padStart(2, '0')}`;
}

function quantity(milli: number): string {
  const value = BigInt(milli);
  const fraction = (value % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${value / 1000n}${fraction ? `,${fraction}` : ''}`;
}

export function quotePdfFilename(number: string): string {
  const safe = number.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 80);
  return `${safe || 'orcamento'}.pdf`;
}

// PDFKit's built-in table clamps a row taller than one page. Split wrapped cells ourselves
// so long descriptions remain complete, with their amounts shown only once.
function wrappedLines(pdf: PDFKit.PDFDocument, text: string, width: number): string[] {
  const paragraphs = text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').split('\n');
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (pdf.widthOfString(candidate) <= width) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      for (const character of word) {
        if (line && pdf.widthOfString(line + character) > width) { lines.push(line); line = ''; }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function renderQuotePdf(document: QuoteDocument): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const { quote, timeZone } = document;
  const pdf = new PDFDocument({
    autoFirstPage: false,
    size: 'A4',
    margins: { top: 48, right: 48, bottom: 52, left: 48 },
    lang: 'pt-BR',
    info: { Title: `Orçamento ${quote.number}`, Subject: quote.title },
  });
  const chunks: Buffer[] = [];
  let byteLength = 0;
  pdf.on('data', (chunk: Buffer) => { chunks.push(chunk); byteLength += chunk.length; });
  pdf.once('end', () => resolve(Buffer.concat(chunks, byteLength)));
  pdf.once('error', reject);

  try {
    const left = 48;
    const width = 499.28;
    const columns = [210.28, 35, 60, 97, 97];
    const padding = 6;
    const rowLineHeight = 12;
    let y = 48;
    let pageNumber = 0;
    const bottom = () => pdf.page.height - 52;

    const newPage = () => {
      pdf.addPage();
      pageNumber++;
      pdf.font('Helvetica').fontSize(8).fillColor('#64748b');
      pdf.text(`ORÇAMENTO ${quote.number}`, left, 25, { lineBreak: false });
      const footer = `Página ${pageNumber}`;
      pdf.text(footer, left + width - pdf.widthOfString(footer), pdf.page.height - 29, { lineBreak: false });
      y = 52;
    };
    const ensureSpace = (height: number) => { if (y + height > bottom()) newPage(); };
    const textBlock = (text: string, size = 10, bold = false, color = '#243247') => {
      pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
      const lines = wrappedLines(pdf, text, width);
      for (const line of lines) {
        ensureSpace(size * 1.4);
        pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
        pdf.text(line, left, y, { width, lineBreak: false });
        y += size * 1.4;
      }
    };
    const tableHeader = () => {
      pdf.rect(left, y, width, 27).fill('#173b45');
      pdf.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
      let x = left;
      for (const [column, label] of ['Descrição', 'Unid.', 'Qtde.', 'Preço unitário', 'Total'].entries()) {
        pdf.text(label, x + padding, y + 9, { width: columns[column] - padding * 2, align: column > 1 ? 'right' : 'left', lineBreak: false });
        x += columns[column];
      }
      y += 27;
    };

    newPage();
    textBlock('Orçamento', 25, true, '#173b45');
    y += 6;
    textBlock(quote.title, 14, true);
    y += 12;
    const emittedOn = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(quote.createdAt));
    textBlock(`Número: ${quote.number}`);
    textBlock(`Emitido em: ${emittedOn}   |   Situação: ${quoteStatusLabels[quote.status]}`);
    if (quote.validUntil) textBlock(`Válido até: ${quote.validUntil.split('-').reverse().join('/')}`);
    y += 16;
    textBlock('Cliente', 12, true, '#173b45');
    textBlock(quote.customer.name, 11, true);
    if (quote.customer.phone) textBlock(`Telefone: ${quote.customer.phone}`);
    if (quote.customer.email) textBlock(`E-mail: ${quote.customer.email}`);
    if (quote.customer.address) textBlock(`Endereço: ${quote.customer.address}`);
    y += 18;
    ensureSpace(65);
    tableHeader();

    for (const [index, item] of quote.items.entries()) {
      pdf.font('Helvetica').fontSize(8.5);
      const cells = [item.description, item.unit, quantity(item.quantityMilli), money(item.unitPriceCents), money(item.totalCents)]
        .map((value, column) => wrappedLines(pdf, value, columns[column] - padding * 2));
      const count = Math.max(...cells.map(lines => lines.length));
      let offset = 0;
      while (offset < count) {
        let available = Math.floor((bottom() - y - padding * 2) / rowLineHeight);
        if (available < 1) { newPage(); tableHeader(); available = Math.floor((bottom() - y - padding * 2) / rowLineHeight); }
        const lines = Math.min(count - offset, available);
        const height = lines * rowLineHeight + padding * 2;
        pdf.rect(left, y, width, height).fill(index % 2 ? '#f1f5f6' : '#ffffff');
        pdf.moveTo(left, y + height).lineTo(left + width, y + height).lineWidth(0.5).stroke('#d8e2e5');
        pdf.font('Helvetica').fontSize(8.5).fillColor('#243247');
        let x = left;
        for (const [column, values] of cells.entries()) {
          for (let line = 0; line < lines && offset + line < values.length; line++) {
            pdf.text(values[offset + line], x + padding, y + padding + line * rowLineHeight, {
              width: columns[column] - padding * 2, align: column > 1 ? 'right' : 'left', lineBreak: false,
            });
          }
          x += columns[column];
        }
        y += height;
        offset += lines;
        if (offset < count) { newPage(); tableHeader(); }
      }
    }

    y += 18;
    ensureSpace(100);
    const totals = [
      ['Subtotal', money(quote.subtotalCents)],
      ['Desconto', money(quote.discountCents)],
      ['Total', money(quote.totalCents)],
    ];
    for (const [index, [label, amount]] of totals.entries()) {
      const total = index === totals.length - 1;
      if (total) pdf.rect(left + 210, y - 5, width - 210, 30).fill('#e7f0ee');
      pdf.font(total ? 'Helvetica-Bold' : 'Helvetica').fontSize(total ? 12 : 10).fillColor('#173b45');
      pdf.text(label, left + 222, y, { width: 74, lineBreak: false });
      pdf.text(amount, left + 298, y, { width: width - 310, align: 'right', lineBreak: false });
      y += 27;
    }
    if (quote.notes) {
      y += 18;
      ensureSpace(45);
      textBlock('Observações', 12, true, '#173b45');
      y += 4;
      textBlock(quote.notes);
    }
    pdf.end();
  } catch (error) {
    pdf.destroy();
    reject(error);
  }
  return promise;
}
