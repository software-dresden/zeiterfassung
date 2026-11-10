// Generates the two ready-to-use Word templates (MCT Systemhaus) into public/templates/.
// They are laid out like a German invoice (DIN 5008 style: logo and sender top right,
// sender line above the recipient, info block, title with number, salutation,
// positions table, totals, closing) but titled "Technikerbericht". They contain NO prices.
//
// They contain the placeholders the app fills in (see src/lib/templateData.ts), so
// they can be uploaded in the Admin section as they are, or opened in Word and
// adapted (keep the {placeholders}).
//
//   node scripts/generate-sample-templates.js
//
// Needs scripts/assets/mct-logo.png (3:1). No dependencies beyond jszip.

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const COMPANY = 'MCT Systemhaus GmbH';
const STREET = 'Enderstraße 59';
const CITY = '01277 Dresden';
const NAVY = '103170';
const MAGENTA = 'D50568';
const MUTED = '6C7568';
const LINE = 'D9DCE3';

const LOGO_PATH = path.join(__dirname, 'assets', 'mct-logo.png');
const OUT_DIR = path.join(__dirname, '..', 'public', 'templates');

// Logo in the header: 3:1 like the artwork, 5.1 x 1.7 cm (EMU: 360000 per cm).
const LOGO_W = Math.round(5.1 * 360000);
const LOGO_H = Math.round(1.7 * 360000);

// A4 in twips with DIN 5008 style margins (left 2.5 cm, right 2 cm).
const PAGE_W = 11906;
const MARGIN_L = 1418;
const MARGIN_R = 1134;
const CW = PAGE_W - MARGIN_L - MARGIN_R; // text width, 9354

const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- tiny OOXML helpers --------------------------------------------------------

// One run. Each {command} is kept inside a single run so Word never splits it.
const run = (text, o = {}) => {
  const props = [
    o.bold ? '<w:b/>' : '',
    o.underline ? '<w:u w:val="single"/>' : '',
    o.color ? `<w:color w:val="${o.color}"/>` : '',
    o.size ? `<w:sz w:val="${o.size}"/><w:szCs w:val="${o.size}"/>` : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
};

const para = (runs, o = {}) => {
  const props = [
    o.keepNext ? '<w:keepNext/>' : '',
    o.borderBottom
      ? `<w:pBdr><w:bottom w:val="single" w:sz="${o.borderBottom.size}" w:space="4" w:color="${o.borderBottom.color}"/></w:pBdr>`
      : '',
    o.borderTop
      ? `<w:pBdr><w:top w:val="single" w:sz="${o.borderTop.size}" w:space="6" w:color="${o.borderTop.color}"/></w:pBdr>`
      : '',
    o.before !== undefined || o.after !== undefined
      ? `<w:spacing w:before="${o.before ?? 0}" w:after="${o.after ?? 0}"/>`
      : '',
    // Hanging indent for list entries: the marker sits at left-hanging, the text at left.
    o.indent ? `<w:ind w:left="${o.indent.left}" w:hanging="${o.indent.hanging}"/>` : '',
    o.align ? `<w:jc w:val="${o.align}"/>` : '',
  ].join('');
  const body = Array.isArray(runs) ? runs.join('') : runs;
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${body}</w:p>`;
};

const cellBorders = (b) =>
  b
    ? `<w:tcBorders>${Object.entries(b)
        .map(([side, [size, color]]) => `<w:${side} w:val="single" w:sz="${size}" w:space="0" w:color="${color}"/>`)
        .join('')}</w:tcBorders>`
    : '';

const cell = (content, width, o = {}) => {
  const shd = o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : '';
  const margins = `<w:tcMar><w:top w:w="${o.padV ?? 60}" w:type="dxa"/><w:left w:w="${o.padL ?? 80}" w:type="dxa"/><w:bottom w:w="${o.padV ?? 60}" w:type="dxa"/><w:right w:w="${o.padR ?? 80}" w:type="dxa"/></w:tcMar>`;
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${cellBorders(o.borders)}${shd}${margins}${o.vAlign ? `<w:vAlign w:val="${o.vAlign}"/>` : ''}</w:tcPr>${content}</w:tc>`;
};

// Rows stay on one page unless o.split is set. A row with long notes MUST be allowed to
// split: a row taller than a page that cannot split runs into the footer in several
// viewers (phone apps in particular).
const row = (cells, o = {}) =>
  `<w:tr><w:trPr>${o.split ? '' : '<w:cantSplit/>'}${o.header ? '<w:tblHeader/>' : ''}</w:trPr>${cells.join('')}</w:tr>`;

// o.lines: 'invoice' = horizontal rules only; 'none' = invisible (layout tables).
const table = (rows, widths, o = {}) => {
  const rule = (side, size, color) => `<w:${side} w:val="single" w:sz="${size}" w:space="0" w:color="${color}"/>`;
  const none = (side) => `<w:${side} w:val="nil"/>`;
  const borders =
    o.lines === 'none'
      ? ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(none).join('')
      : rule('top', 8, NAVY) + none('left') + rule('bottom', 8, NAVY) + none('right') + rule('insideH', 4, LINE) + none('insideV');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>${o.right ? '<w:jc w:val="right"/>' : ''}` +
    `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`
  );
};

const spacer = (after = 120) => para('', { after });

// --- shared package parts ------------------------------------------------------

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const contentTypes =
  XML +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="png" ContentType="image/png"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
  '</Types>';

const rootRels =
  XML +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const documentRels =
  XML +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
  '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>' +
  '</Relationships>';

const styles =
  XML +
  `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/>' +
  '<w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="de-DE"/>' +
  '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '</w:styles>';

// Top right, like the letterhead of a German invoice: the logo. The sender details sit
// below it in partiesBlock, level with the recipient.
// This sits at the top of the document BODY, not in the page header: many viewers (phone
// apps, previews, Drive) do not draw images from a header, so the logo went missing there.
// The cost is that it appears on the first page only.
const letterhead =
  para(
    '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${LOGO_W}" cy="${LOGO_H}"/><wp:docPr id="1" name="Logo" descr="${COMPANY}"/>` +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="rId4"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${LOGO_W}" cy="${LOGO_H}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>',
    { align: 'right', after: 120 }
  );

// Word takes a field's formatting from its own runs, so every part carries the same
// small grey style as the surrounding "Seite ... von ..." text.
const FIELD_RPR = `<w:rPr><w:color w:val="${MUTED}"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>`;
const field = (instr) =>
  `<w:r>${FIELD_RPR}<w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r>${FIELD_RPR}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  `<w:r>${FIELD_RPR}<w:fldChar w:fldCharType="separate"/></w:r>` +
  `${run('1', { color: MUTED, size: 16 })}<w:r>${FIELD_RPR}<w:fldChar w:fldCharType="end"/></w:r>`;

const footer =
  XML +
  `<w:ftr ${NS}>` +
  para(run(`${COMPANY} · ${STREET} · ${CITY}`, { color: NAVY, bold: true, size: 17 }), {
    align: 'center',
    borderTop: { size: 6, color: MAGENTA },
  }) +
  para(
    [run('Seite ', { color: MUTED, size: 16 }), field('PAGE'), run(' von ', { color: MUTED, size: 16 }), field('NUMPAGES')],
    { align: 'center', before: 40 }
  ) +
  '</w:ftr>';

const sectPr =
  '<w:sectPr><w:footerReference w:type="default" r:id="rId3"/>' +
  `<w:pgSz w:w="${PAGE_W}" w:h="16838"/>` +
  `<w:pgMar w:top="964" w:right="${MARGIN_R}" w:bottom="1418" w:left="${MARGIN_L}" w:header="454" w:footer="567" w:gutter="0"/></w:sectPr>`;

const documentXml = (bodyXml) =>
  XML + `<w:document ${NS}><w:body>${letterhead}${bodyXml}${sectPr}</w:body></w:document>`;

// --- invoice building blocks -------------------------------------------------

// Recipient and sender side by side: the customer's name and address on the left, level
// with our company name and address on the right (the logo sits above, right aligned).
// The address only prints when the customer has one (IF in paragraphs of its own).
const partiesBlock = (nameTag, addressTag) => {
  const left = 5300;
  const right = CW - left;
  const recipient = cell(
    para(run(nameTag, { bold: true, size: 18 }), { after: 20 }) +
      para(run(`{IF ${addressTag}}`, { size: 2 })) +
      para(run(`{${addressTag}}`, { size: 17 })) +
      para(run('{END-IF}', { size: 2 })),
    left,
    { padL: 0, padV: 0 }
  );
  const sender = cell(
    para(run(COMPANY, { bold: true, color: NAVY, size: 18 }), { align: 'right', after: 20 }) +
      para(run(STREET, { color: MUTED, size: 17 }), { align: 'right' }) +
      para(run(CITY, { color: MUTED, size: 17 }), { align: 'right' }),
    right,
    { padR: 0, padV: 0 }
  );
  return table([row([recipient, sender])], [left, right], { lines: 'none' }) + spacer(200);
};

// Report number, date, ... right aligned under the company address (same edge as the logo), like Rechnungsnummer / Rechnungsdatum on an invoice.
const infoBlock = (infoLines) => {
  const left = 5300;
  const right = CW - left;
  const info = cell(
    infoLines
      .map(([label, tag]) =>
        para([run(`${label} `, { bold: true, color: NAVY, size: 18 }), run(tag, { size: 18 })], { align: 'right', after: 40 })
      )
      .join(''),
    right,
    { padR: 0, padV: 0 }
  );
  return table([row([cell(para(''), left, { padV: 0 }), info])], [left, right], { lines: 'none' });
};

// The note of a session, one paragraph per entry: headings, text, bullets and sub-points
// (see src/lib/notes.ts). FOR/END-FOR and each IF/END-IF sit in paragraphs of their own,
// which disappear from the output; the four IF blocks pick the layout of each entry.
const noteLines = (v, path, o = {}) => {
  const size = o.size ?? 20;
  const color = o.color;
  const ifBlock = (flag, inner) =>
    para(run(`{IF $${v}.${flag}}`, { size: 2 })) + inner + para(run('{END-IF}', { size: 2 }));
  const entry = (left) =>
    para([run(`{$${v}.marker}`, { size, color }), '<w:r><w:tab/></w:r>', run(`{$${v}.text}`, { size, color })], {
      indent: { left, hanging: 284 },
      after: 40,
    });
  return (
    para(run(`{FOR ${v} IN ${path}}`, { size: 2 })) +
    ifBlock('ueberschrift', para(run(`{$${v}.text}`, { bold: true, color: NAVY, size }), { before: 100, after: 40, keepNext: true })) +
    ifBlock('absatz', para(run(`{$${v}.text}`, { size, color }), { after: 60 })) +
    ifBlock('punkt', entry(284)) +
    ifBlock('unterpunkt', entry(568)) +
    para(run(`{END-FOR ${v}}`, { size: 2 }))
  );
};

const title = () =>
  para(run('Technikerbericht Nr. {nummer}', { bold: true, color: NAVY, size: 30 }), { before: 360, after: 200 });

const salutation = (introTag) =>
  para(run('Sehr geehrte Damen und Herren,'), { after: 100 }) + para(run(introTag), { after: 240 });

// Header of the positions table: bold navy text on the invoice rules.
const headCells = (labels, widths, rightFrom) =>
  labels.map((label, i) =>
    cell(
      para(run(label, { bold: true, color: NAVY, size: 18 }), { align: i >= rightFrom ? 'right' : 'left' }),
      widths[i],
      { fill: 'EEF1F7' }
    )
  );

const closing = () =>
  para(run('Mit freundlichen Grüßen'), { before: 400, after: 500, keepNext: true }) +
  para(run('{techniker}', { bold: true }), { keepNext: true }) +
  para(run(COMPANY, { color: MUTED }));

// Totals block on the right, like the sum lines of an invoice.
const totals = (lines) => {
  const w = [2500, 2100];
  const rows = lines.map(([label, tag, strong]) =>
    row([
      cell(para(run(label, { bold: strong, color: strong ? NAVY : undefined, size: strong ? 21 : 19 })), w[0], {
        fill: strong ? 'EEF1F7' : undefined,
        borders: strong ? { top: [8, NAVY] } : undefined,
      }),
      cell(para(run(tag, { bold: strong, color: strong ? NAVY : undefined, size: strong ? 21 : 19 }), { align: 'right' }), w[1], {
        fill: strong ? 'EEF1F7' : undefined,
        borders: strong ? { top: [8, NAVY] } : undefined,
      }),
    ])
  );
  return table(rows, w, { right: true, lines: 'none' });
};

// --- the two templates -------------------------------------------------------

// NO PRICES: a Word export is a Technikerbericht, not a bill. The data these templates
// receive contains no price at all (see TEMPLATE_ROOTS in src/lib/templateData.ts),
// so the positions table shows quantities and durations only.
const POS = [560, 1300, 4694, 1400, 1400]; // Pos., Datum, Leistung, Menge (AE), Dauer
const POS_HEAD = ['Pos.', 'Datum', 'Leistung', 'Menge (AE)', 'Dauer'];

const helperRow = (tag, widths) =>
  row([cell(para(run(tag, { size: 19 })), widths[0]), ...widths.slice(1).map((w) => cell(para(''), w))]);

const monthlyBody = () => {
  const text = (tag, o = {}) => para(run(tag, { size: 19, ...o }), { align: o.align });
  // Optional lines under a session: each {IF ...} / {END-IF} sits in a paragraph of its own.
  const optionalLine = (condition, content) =>
    para(run(`{IF ${condition}}`, { size: 16 })) + content + para(run('{END-IF}', { size: 16 }));

  const positions = table(
    [
      row(headCells(POS_HEAD, POS, 3), { header: true }),
      // Row loop: FOR and END-FOR each sit in a row of their own (these two rows
      // disappear from the output) and the row in between repeats per session.
      // (FOR and END-FOR inside ONE row would repeat the cells sideways instead.)
      helperRow('{FOR s IN $k.sessions}', POS),
      row([
        cell(text('{$s.pos}'), POS[0]),
        cell(text('{$s.datum}'), POS[1]),
        cell(
          para(run('{$s.typ}', { size: 19, bold: true })) +
            noteLines('z', '$s.notizen_zeilen', { size: 16, color: MUTED }) +
            optionalLine(
              '$s.material',
              para([run('Material: ', { size: 16, bold: true, color: NAVY }), run('{$s.material}', { size: 16 })])
            ) +
            optionalLine(
              '$s.fahrt',
              para([run('Fahrt: ', { size: 16, bold: true, color: NAVY }), run('{$s.fahrt}', { size: 16 })])
            ),
          POS[2]
        ),
        cell(text('{$s.ae}', { align: 'right' }), POS[3]),
        cell(text('{$s.stunden}', { align: 'right' }), POS[4]),
      ], { split: true }),
      helperRow('{END-FOR s}', POS),
    ],
    POS,
    { lines: 'invoice' }
  );

  return [
    partiesBlock('{kunde.name}', 'kunde.adresse'),
    infoBlock([
      ['Technikerbericht-Nr.:', '{nummer}'],
      ['Datum:', '{erstellt_am}'],
      ['Zeitraum:', '{zeitraum}'],
      ['Techniker:', '{techniker}'],
    ]),
    title(),
    salutation('nachfolgend erhalten Sie die Aufstellung der im Zeitraum {zeitraum} erbrachten Leistungen.'),
    // Customer loop: the two command paragraphs disappear from the output.
    para(run('{FOR k IN kunden}')),
    para(run('{$k.name}', { bold: true, color: NAVY, size: 22 }), { after: 20, keepNext: true }),
    para(run('{$k.sessionen} Sessionen · {$k.ae} AE · {$k.stunden} · Fahrt {$k.km}', { color: MUTED, size: 17 }), {
      after: 100,
      keepNext: true,
    }),
    positions,
    spacer(280),
    para(run('{END-FOR k}')),
    totals([
      ['Anzahl Sessionen', '{sessionen_gesamt}', false],
      ['Gefahrene Kilometer', '{km_gesamt}', false],
      ['Gesamtdauer', '{ae_gesamt} AE ({stunden_gesamt})', true],
    ]),
    closing(),
  ].join('');
};

const sessionBody = () => {
  const text = (tag, o = {}) => para(run(tag, { size: 19, ...o }), { align: o.align });

  const positions = table(
    [
      row(headCells(POS_HEAD, POS, 3), { header: true }),
      row([
        cell(text('1'), POS[0]),
        cell(text('{datum}'), POS[1]),
        cell(
          para(run('{typ}', { size: 19, bold: true })) +
            para(run('{beginn} – {ende} Uhr', { size: 16, color: MUTED })),
          POS[2]
        ),
        cell(text('{dauer_ae}', { align: 'right' }), POS[3]),
        cell(text('{dauer_stunden}', { align: 'right' }), POS[4]),
      ]),
    ],
    POS,
    { lines: 'invoice' }
  );

  // Material table: only shown when something was recorded (IF in its own paragraphs
  // around the heading and the table); one table row per material.
  const MAT = [CW - 2400, 2400];
  const material = [
    para(run('{IF hat_material}', { size: 16 })),
    para(run('Verwendetes Material', { bold: true, color: NAVY, size: 21 }), {
      before: 240,
      after: 80,
      keepNext: true,
      borderBottom: { size: 6, color: MAGENTA },
    }),
    table(
      [
        row(
          [
            cell(para(run('Bezeichnung', { bold: true, color: NAVY, size: 18 })), MAT[0], { fill: 'EEF1F7' }),
            cell(para(run('Menge', { bold: true, color: NAVY, size: 18 }), { align: 'right' }), MAT[1], {
              fill: 'EEF1F7',
            }),
          ],
          { header: true }
        ),
        helperRow('{FOR m IN materialien}', MAT),
        row([
          cell(text('{$m.name}'), MAT[0]),
          cell(text('{$m.menge}', { align: 'right' }), MAT[1]),
        ]),
        helperRow('{END-FOR m}', MAT),
      ],
      MAT,
      { lines: 'invoice' }
    ),
    para(run('{END-IF}', { size: 16 })),
  ].join('');

  // Fahrt (kilometers driven), only when recorded.
  const fahrt =
    para(run('{IF hat_fahrt}', { size: 16 })) +
    para([run('Fahrt: ', { bold: true, color: NAVY, size: 20 }), run('{fahrt}', { size: 20 })], {
      before: 200,
    }) +
    para(run('{END-IF}', { size: 16 }));

  // "Leistung bestätigt": a signature field per party, like a delivery note.
  const half = [Math.floor(CW / 2) - 150, Math.floor(CW / 2) - 150];
  const gap = CW - half[0] - half[1];
  const sigRule = { bottom: [6, NAVY] };
  const signatures = table(
    [
      row([
        cell(para(run('{IMAGE signatur_techniker}')), half[0], { vAlign: 'bottom', borders: sigRule }),
        cell(para(''), gap),
        cell(para(run('{IMAGE signatur_kunde}')), half[1], { vAlign: 'bottom', borders: sigRule }),
      ]),
      row([
        cell(
          para(run('Techniker: {techniker}', { bold: true, size: 18, color: NAVY })) +
            para(run('{status_techniker}', { size: 16, color: MUTED })),
          half[0]
        ),
        cell(para(''), gap),
        cell(
          para(run('Kunde: {kunde}', { bold: true, size: 18, color: NAVY })) +
            para(run('{status_kunde}', { size: 16, color: MUTED })),
          half[1]
        ),
      ]),
    ],
    [half[0], gap, half[1]],
    { lines: 'none' }
  );

  return [
    partiesBlock('{kunde}', 'kunde_adresse'),
    infoBlock([
      ['Technikerbericht-Nr.:', '{nummer}'],
      ['Datum:', '{datum}'],
      ['Techniker:', '{techniker}'],
    ]),
    title(),
    salutation('nachfolgend erhalten Sie den Nachweis über die am {datum} erbrachte Leistung.'),
    positions,
    material,
    fahrt,
    spacer(160),
    para(run('Beschreibung der Leistung', { bold: true, color: NAVY, size: 21 }), {
      after: 80,
      keepNext: true,
      borderBottom: { size: 6, color: MAGENTA },
    }),
    noteLines('z', 'notizen_zeilen', { size: 20 }),
    spacer(200),
    totals([['Gesamtdauer', '{dauer_ae} AE ({dauer_stunden})', true]]),
    para(run('Leistung bestätigt', { bold: true, color: NAVY, size: 21 }), { before: 360, after: 80, keepNext: true }),
    signatures,
    closing(),
  ].join('');
};

// --- build -------------------------------------------------------------------

const build = async (fileName, bodyXml) => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('word/document.xml', documentXml(bodyXml));
  zip.file('word/styles.xml', styles);
  zip.file('word/footer1.xml', footer);
  zip.file('word/_rels/document.xml.rels', documentRels);
  zip.file('word/media/logo.png', fs.readFileSync(LOGO_PATH));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, fileName), bytes);
  console.log(`wrote public/templates/${fileName} (${bytes.length} bytes)`);
};

(async () => {
  await build('MCT_Vorlage_Monatsbericht.docx', monthlyBody());
  await build('MCT_Vorlage_Session-Bericht.docx', sessionBody());
})();
