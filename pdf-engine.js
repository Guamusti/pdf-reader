// El motor PDF solo se importa y evalúa cuando hay un PDF que abrir.
// Biblioteca, notas y Markdown pueden arrancar aunque el CDN tarde.
// El service worker conserva su precaché para poder abrir PDFs sin conexión.
export let pdfjsLib = null;
let loading = null;
let sharedWorker = null;

const PDFJS_VERSION = "4.10.38";
// Recursos que pdf.js pide solo cuando el documento los necesita: tablas de
// caracteres (CJK: chino, japonés, coreano) y las 14 fuentes estándar para
// los PDF que no las incrustan. Sin ellos ese texto sale vacío o con otra
// letra. El service worker los guarda al primer uso.
const PDFJS_ASSETS = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;

export function loadPdfEngine() {
  if (!loading) {
    loading = import(`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`)
      .then((engine) => {
        engine.GlobalWorkerOptions.workerSrc =
          `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;
        pdfjsLib = engine;
        return engine;
      })
      .catch((error) => {
        loading = null;
        throw error;
      });
  }
  return loading;
}

// Un único hilo de trabajo para todos los documentos: abrir el segundo PDF
// (otro libro, la vista dividida, las portadas) no arranca otro hilo ni
// vuelve a compilar el motor, y cerrar un documento no lo detiene.
function getSharedWorker(engine) {
  if (sharedWorker && !sharedWorker.destroyed) return sharedWorker;
  try {
    sharedWorker = new engine.PDFWorker({ name: "paper-reader" });
  } catch {
    sharedWorker = null;
  }
  return sharedWorker;
}

// Contraseñas escritas en esta sesión (no se guardan en disco). La huella
// identifica el archivo sin depender de su nombre.
const sessionPasswords = new Map();
function fingerprint(bytes) {
  let hash = "";
  for (let i = 0; i < Math.min(48, bytes.length); i += 3) hash += bytes[i].toString(16);
  return `${bytes.length}:${hash}`;
}

export class PdfPasswordCancelled extends Error {
  constructor() {
    super("Contraseña no introducida");
    this.name = "PdfPasswordCancelled";
  }
}

// Lectura por trozos: pdf.js pide solo las partes del archivo que necesita (la
// tabla de objetos y la página que se va a mostrar) y cada trozo se lee del
// disco en ese momento. Antes se cargaba el PDF entero en memoria antes de
// poder pintar nada: con un plano o un libro de cientos de MB eran segundos
// de espera y el doble de memoria.
const RANGE_CHUNK = 256 * 1024;
const RANGE_MIN_SIZE = 3 * 1024 * 1024;
function blobRangeTransport(engine, blob, initialData) {
  const transport = new engine.PDFDataRangeTransport(blob.size, initialData);
  transport.requestDataRange = (begin, end) => {
    blob
      .slice(begin, end)
      .arrayBuffer()
      .then((buffer) => transport.onDataRange(begin, new Uint8Array(buffer)))
      .catch((error) => console.warn("No se pudo leer un trozo del PDF", error));
  };
  return transport;
}

// `askPassword(retry)` → Promise<string|null>. Sin ella (portadas, búsqueda en
// la biblioteca…), un PDF protegido cuya contraseña no se conoce simplemente
// falla, sin preguntar nada.
export async function openPdfBlob(blob, { askPassword = null } = {}) {
  const ranged = blob.size >= RANGE_MIN_SIZE;
  // Leer el archivo (o su primer trozo) y cargar el motor en paralelo.
  const [engine, buffer] = await Promise.all([loadPdfEngine(), (ranged ? blob.slice(0, RANGE_CHUNK) : blob).arrayBuffer()]);
  const data = new Uint8Array(buffer);
  const print = `${blob.size}:${fingerprint(data).split(":")[1]}`;
  const source = ranged
    ? { range: blobRangeTransport(engine, blob, data), length: blob.size, rangeChunkSize: RANGE_CHUNK, disableAutoFetch: true, disableStream: true }
    : { data };
  // enableXfa: los formularios XFA dinámicos (los de «Please wait… your PDF
  // viewer may not be able to display this type of document») se abren con su
  // contenido real en lugar de esa página de aviso.
  const task = engine.getDocument({
    ...source,
    enableXfa: true,
    cMapUrl: `${PDFJS_ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
    worker: getSharedWorker(engine) || undefined,
  });
  let cancelled = false;
  let triedRemembered = false;
  let typed = null;
  task.onPassword = (update, reason) => {
    const remembered = sessionPasswords.get(print);
    if (remembered && !triedRemembered) {
      triedRemembered = true;
      return update(remembered);
    }
    if (!askPassword) {
      cancelled = true;
      return task.destroy();
    }
    Promise.resolve(askPassword(reason === engine.PasswordResponses.INCORRECT_PASSWORD))
      .then((password) => {
        if (password == null || password === "") {
          cancelled = true;
          task.destroy();
        } else {
          typed = password;
          update(password);
        }
      })
      .catch(() => {
        cancelled = true;
        task.destroy();
      });
  };
  try {
    const doc = await task.promise;
    if (typed) sessionPasswords.set(print, typed);
    return doc;
  } catch (error) {
    if (cancelled) throw new PdfPasswordCancelled();
    throw error;
  }
}
