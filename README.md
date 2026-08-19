# Paper Reader

PWA local para leer, estudiar y anotar PDFs con una experiencia limpia en escritorio y móvil.

Los PDF se guardan en IndexedDB del navegador. La aplicación no los sube a ningún servidor.

Incluye:

- Biblioteca local, búsqueda de texto, marcadores y reanudación automática.
- Zoom, ajuste al ancho y atajos de teclado para navegar sin fricción.
- Temas oscuro, claro y sepia; tamaño ajustable para los controles de la aplicación.
- Resaltado en amarillo, verde o rosa, subrayado y notas vinculadas al fragmento. Las anotaciones se guardan localmente por documento y página, se pueden borrar desde la barra lateral y exportar en JSON o Markdown.
- Asistente de lectura con IA local: consulta una selección sin enviar el PDF ni el fragmento a una API. Usa la IA integrada del navegador cuando está disponible o un modelo local WebGPU; el primer uso de este último descarga aproximadamente 900 MB.
- Panel de IA de lectura: fragmento y pregunta claramente separados, accesos de resumen, explicación o estudio y respuestas formateadas en títulos y listas en vez de Markdown en bruto.
- Selección nativa azul como previsualización, índice navegable cuando el PDF lo ofrece, salto directo de página y resultados de búsqueda con coincidencias señaladas en la página.
- Modo enfoque, búsqueda cíclica entre todas las coincidencias y renderizado cancelable para una navegación más fluida.
- Índice editorial con jerarquía y página activa, más una tira inferior de miniaturas con carga diferida para recorrer el documento visualmente.
