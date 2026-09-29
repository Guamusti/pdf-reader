// El motor PDF solo se importa y evalúa cuando hay un PDF que abrir.
// Biblioteca, notas y Markdown pueden arrancar aunque el CDN tarde.
// El service worker conserva su precaché para poder abrir PDFs sin conexión.
export let pdfjsLib = null;
let loading = null;

export function loadPdfEngine() {
  if (!loading) {
    loading = import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs")
      .then((engine) => {
        engine.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
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

export async function openPdfBlob(blob) {
  // Leer el archivo y cargar el motor en paralelo evita una espera adicional.
  const [engine, buffer] = await Promise.all([loadPdfEngine(), blob.arrayBuffer()]);
  return engine.getDocument({ data: new Uint8Array(buffer) }).promise;
}
