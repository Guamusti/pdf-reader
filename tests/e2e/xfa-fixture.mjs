// PDF con formulario XFA dinámico para las pruebas: la página «Please wait…»
// que ven los visores sin XFA y una plantilla con texto, campos y dos páginas.
import { PDFDocument, PDFName, PDFBool, PDFString, StandardFonts } from "pdf-lib";

const field = (name, y, caption) => `<field name="${name}" x="0.5in" y="${y}" w="5in" h="0.45in"><ui><textEdit/></ui><caption reserve="1.4in"><value><text>${caption}</text></value></caption><font typeface="Helvetica" size="11pt"/><border><edge stroke="solid" thickness="0.5pt"/></border></field>`;
const TEMPLATE = `<template xmlns="http://www.xfa.org/schema/xfa-template/2.5/">
<subform name="form1" layout="tb" locale="es_ES">
<pageSet><pageArea name="Pagina" id="Pagina"><contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/><medium stock="letter" short="8.5in" long="11in"/></pageArea></pageSet>
<subform name="datos" w="7.5in" h="9.5in">
<draw name="titulo" x="0.5in" y="0.3in" w="6.5in" h="0.6in"><ui><textEdit/></ui><value><text>Solicitud de prueba XFA</text></value><font typeface="Helvetica" size="20pt" weight="bold"/></draw>
<draw name="intro" x="0.5in" y="1.1in" w="6.5in" h="0.5in"><ui><textEdit/></ui><value><text>Formulario dinámico para comprobar el lector.</text></value><font typeface="Helvetica" size="11pt"/></draw>
${field("nombre", "2in", "Nombre")}
${field("ciudad", "2.8in", "Ciudad")}
<field name="acepto" x="0.5in" y="3.7in" w="4in" h="0.45in"><ui><checkButton/></ui><items><integer>1</integer><integer>0</integer></items><caption placement="right" reserve="3in"><value><text>Acepto las condiciones</text></value></caption><font typeface="Helvetica" size="11pt"/></field>
</subform>
<subform name="anexo" w="7.5in" h="9.5in"><breakBefore targetType="pageArea"/>
<draw name="tituloAnexo" x="0.5in" y="0.3in" w="6.5in" h="0.6in"><ui><textEdit/></ui><value><text>Anexo segunda página</text></value><font typeface="Helvetica" size="18pt" weight="bold"/></draw>
${field("observaciones", "1.4in", "Observaciones")}
</subform>
</subform>
</template>`;
const DATASETS = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><datos><nombre/><ciudad/><acepto>0</acepto></datos><anexo><observaciones/></anexo></form1></xfa:data></xfa:datasets>`;

export async function buildXfaPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Please wait...", { x: 72, y: 700, size: 18, font });
  page.drawText("If this message is not eventually replaced by the proper contents of the document,", { x: 72, y: 670, size: 10, font });
  page.drawText("your PDF viewer may not be able to display this type of document.", { x: 72, y: 655, size: 10, font });
  // Como los formularios reales: el XDP partido en trozos con nombre.
  const part = (text) => doc.context.register(doc.context.stream(new TextEncoder().encode(text)));
  const xfa = doc.context.obj([
    "preamble", part('<?xml version="1.0" encoding="UTF-8"?><xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'),
    "template", part(TEMPLATE),
    "datasets", part(DATASETS),
    "postamble", part("</xdp:xdp>"),
  ].map((item) => (typeof item === "string" ? PDFString.of(item) : item)));
  doc.catalog.set(PDFName.of("NeedsRendering"), PDFBool.True);
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [], XFA: xfa }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// Formulario rellenable normal (AcroForm): texto, casilla y lista.
export async function buildAcroFormPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Solicitud de prueba AcroForm", { x: 50, y: 780, size: 18, font });
  page.drawText("Nombre", { x: 50, y: 730, size: 11, font });
  page.drawText("Acepto", { x: 80, y: 672, size: 11, font });
  page.drawText("Provincia", { x: 50, y: 620, size: 11, font });
  const form = doc.getForm();
  const name = form.createTextField("nombre");
  name.addToPage(page, { x: 130, y: 722, width: 260, height: 22, font });
  const accept = form.createCheckBox("acepto");
  accept.addToPage(page, { x: 50, y: 668, width: 16, height: 16 });
  const province = form.createDropdown("provincia");
  province.addOptions(["Madrid", "Sevilla", "Valencia"]);
  province.addToPage(page, { x: 130, y: 612, width: 160, height: 22, font });
  return doc.save();
}

// PDF con dos capas (contenido opcional): «Cotas» visible y «Notas» visible.
export async function buildLayersPdf() {
  const { PDFOperator } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const context = doc.context;
  const ocg = (name) => context.register(context.obj({ Type: "OCG", Name: PDFString.of(name) }));
  const cotas = ocg("Cotas");
  const notas = ocg("Notas");
  page.drawText("Plano base", { x: 50, y: 780, size: 20, font });
  const layer = (key, draw) => {
    page.pushOperators(PDFOperator.of("BDC", [PDFName.of("OC"), PDFName.of(key)]));
    draw();
    page.pushOperators(PDFOperator.of("EMC"));
  };
  layer("LCotas", () => page.drawRectangle({ x: 50, y: 500, width: 200, height: 200, color: undefined, borderWidth: 0, opacity: 1 }));
  layer("LCotas", () => page.drawText("COTAS 12,50 m", { x: 60, y: 600, size: 22, font }));
  layer("LNotas", () => page.drawText("NOTAS del arquitecto", { x: 60, y: 300, size: 22, font }));
  page.node.Resources().set(PDFName.of("Properties"), context.obj({ LCotas: cotas, LNotas: notas }));
  doc.catalog.set(PDFName.of("OCProperties"), context.obj({ OCGs: [cotas, notas], D: { Order: [cotas, notas], ON: [cotas, notas] } }));
  return doc.save();
}

// PDF de más de 3 MB (se abre leyendo por trozos): texto normal más un
// adjunto grande que no se puede comprimir.
export async function buildBigPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) doc.addPage([595, 842]).drawText(`Documento grande, pagina ${i}`, { x: 50, y: 780, size: 20, font });
  const noise = new Uint8Array(4 * 1024 * 1024);
  let seed = 12345;
  for (let i = 0; i < noise.length; i++) noise[i] = (seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 24;
  await doc.attach(noise, "relleno.bin", { mimeType: "application/octet-stream" });
  return doc.save();
}

// Plano pesado: cada página tiene decenas de miles de trazos vectoriales
// (como un plano de arquitectura o un mapa), repartidos en dos capas.
export async function buildHeavyPdf(pages = 4, strokes = 60000) {
  const doc = await PDFDocument.create();
  const context = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ocg = (name) => context.register(context.obj({ Type: "OCG", Name: PDFString.of(name) }));
  const grid = ocg("Rejilla");
  const walls = ocg("Muros");
  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 8) / 16777216;
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([1191, 842]);
    page.drawText(`Plano pesado, hoja ${p}`, { x: 40, y: 800, size: 22, font });
    const parts = ["/OC /LGrid BDC 0.6 0.6 0.8 RG 0.3 w"];
    for (let i = 0; i < strokes * 0.6; i++) {
      const x = (rand() * 1191).toFixed(1), y = (rand() * 780).toFixed(1);
      parts.push(`${x} ${y} m ${(+x + rand() * 30).toFixed(1)} ${(+y + rand() * 30).toFixed(1)} l S`);
    }
    parts.push("EMC /OC /LWalls BDC 0.1 0.1 0.1 RG 1.2 w");
    for (let i = 0; i < strokes * 0.4; i++) {
      const x = (rand() * 1191).toFixed(1), y = (rand() * 780).toFixed(1);
      parts.push(`${x} ${y} m ${(+x + rand() * 80 - 40).toFixed(1)} ${(+y + rand() * 80 - 40).toFixed(1)} l ${(+x + rand() * 80 - 40).toFixed(1)} ${(+y + rand() * 80 - 40).toFixed(1)} l h S`);
    }
    parts.push("EMC");
    const stream = context.flateStream(parts.join("\n"));
    const ref = context.register(stream);
    const contents = page.node.Contents();
    page.node.set(PDFName.of("Contents"), context.obj([...(contents?.asArray?.() || [page.node.get(PDFName.of("Contents"))]), ref]));
    page.node.Resources().set(PDFName.of("Properties"), context.obj({ LGrid: grid, LWalls: walls }));
  }
  doc.catalog.set(PDFName.of("OCProperties"), context.obj({ OCGs: [grid, walls], D: { Order: [grid, walls], ON: [grid, walls] } }));
  return doc.save();
}
