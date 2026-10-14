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
