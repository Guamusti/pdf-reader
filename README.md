# Paper Reader

PWA local para leer, estudiar y anotar PDFs con una experiencia limpia en escritorio y móvil.

Los PDF se guardan en IndexedDB del navegador. La aplicación no los sube a ningún servidor.

Incluye:

- Biblioteca local, búsqueda de texto, marcadores y reanudación automática.
- Zoom, ajuste al ancho y atajos de teclado para navegar sin fricción.
- Temas oscuro, claro y sepia; tamaño ajustable para los controles de la aplicación.
- Resaltado en amarillo, verde o rosa y subrayado de texto seleccionado. Las anotaciones se guardan localmente por documento y página.
- Asistente de lectura con IA local: pregunta sobre una selección sin enviar el PDF ni el fragmento a una API. Requiere un navegador con WebGPU y descarga un modelo de aproximadamente 900 MB en el primer uso.
- Previsualización de subrayado al seleccionar texto, índice navegable cuando el PDF lo ofrece, salto directo de página y exportación de anotaciones en JSON.
