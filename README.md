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
- Rotulador directo: activa el modo, selecciona texto y el resaltado se guarda al soltar. La biblioteca se abre desde Home para preservar una barra lateral centrada en el documento.
- Recorte visual para IA: permite capturar una zona concreta del PDF sin subirla. Cuando el equipo tiene WebGPU y unos 4,5 GB libres, se descarga bajo demanda Phi-3.5 Vision y analiza el recorte de forma local.
- Selección nativa azul como previsualización, índice navegable cuando el PDF lo ofrece, salto directo de página y resultados de búsqueda con coincidencias señaladas en la página.
- Modo enfoque, búsqueda cíclica entre todas las coincidencias y renderizado cancelable para una navegación más fluida.
- Índice editorial con jerarquía y página activa, más una tira inferior de miniaturas con carga diferida para recorrer el documento visualmente.
- Diseños de página: una página, doble página (libro) con página enfrentada y scroll continuo vertical con render diferido de las páginas visibles. El modo elegido se recuerda entre sesiones.
- Modo presentación a pantalla completa: avanza con flechas, barra espaciadora o clic (mitad derecha/izquierda), con una barra de control y salida con Esc.
- Historial de vistas atrás/adelante para volver al punto anterior tras saltar desde el índice, un enlace, la búsqueda o un marcador (botones en la barra, Alt+←/→ y botones laterales del ratón).
- Enlaces del PDF clicables: los internos saltan a su sección y las direcciones web se abren en una pestaña nueva.
- Copia del texto seleccionado desde el menú de selección.
- Búsqueda avanzada: distinguir mayúsculas, palabra completa y expresiones regulares, con contador de coincidencias y navegación anterior/siguiente entre todas las apariciones.
- Búsqueda en toda la biblioteca: encuentra un término en el texto de todos los PDFs guardados, con resultados agrupados por documento; al pulsar uno se abre el documento en la página correspondiente.
- Lectura en voz alta (Text-to-Speech) con la voz local del navegador: barra con reproducir/pausar, frase anterior/siguiente, velocidad y selección de voz. Lee frase a frase mostrando la actual como subtítulo y pasa de página automáticamente al terminar.
