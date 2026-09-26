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

### Novedades v3

- **Paleta de comandos** (`Ctrl/⌘ + K`, `Ctrl/⌘ + F` o `/`): busca en el texto del documento mientras escribes, salta a una página («p 12») o a una sección del índice, abre documentos de la biblioteca y ejecuta cualquier acción. Respeta las opciones de mayúsculas, palabra completa y expresiones regulares.
- **Notas adhesivas** (`N`): pega una nota en cualquier punto de la página, arrástrala para moverla y cámbiale el color. Se incluyen en la lista de anotaciones, en el deshacer y en las exportaciones.
- **Cuaderno** (`C`): apuntes libres para cada página, que siguen a la página que lees, más una nota general del documento y una vista con todas las notas. Las miniaturas marcan las páginas con notas.
- **Regla de lectura** (`G`): oscurece todo menos una franja que sigue al puntero; avanza con `↑`/`↓`.
- **Desplazamiento automático** (`A`): diez velocidades, pausa con espacio y cambio de página automático.
- **Estudio con repaso espaciado** (`E`): tarjetas creadas solas desde tus resaltados (ejercicios de huecos), desde notas escritas como `pregunta :: respuesta` (también en el cuaderno), desde una selección o generadas por la IA local; se programan con el algoritmo SM-2.
- **IA en un paso**: resumir la página, explicar la selección o generar tarjetas desde la paleta.
- **Página actual**: guardarla como PNG, copiar su imagen o su texto. El pie muestra el tiempo de lectura restante según tu ritmo.
- **Atajos** (`?`) y `Ctrl/⌘ + Z` para deshacer anotaciones.

### Novedades v5

- **Modo lectura continuo** (`L`): todo el PDF se convierte en texto adaptable que se lee de corrido; la tipografía, el interlineado, el ancho y las columnas se aplican al documento entero y conservan tu posición.
- **Asistente IA rediseñado** (`I`): ventana con conversación, ámbito visible (selección, página, todo el PDF o recorte) y acciones que se ejecutan con un toque: resumir, explicar, ideas clave, términos, preguntas y traducir.
- **Selección en cualquier vista**: el menú de selección con Explicar, Resumir y Preguntar funciona en página, doble página, scroll continuo y modo lectura.
- **Longitud controlada**: cada acción tiene un límite de palabras proporcional al texto; un resumen nunca es más largo que el original y la respuesta se recorta si el modelo se excede.
- Citas `p. N` clicables, copiar, guardar la respuesta en las notas de la página, regenerar, convertir preguntas en tarjetas de estudio y detener la respuesta en cualquier momento. La descarga del modelo local solo se hace tras pedir permiso.
- **Biblioteca renovada**: portadas reales (primera página de cada PDF), bloque «Continuar leyendo», filtros por estado (leyendo, sin empezar, terminados), vista de cuadrícula o lista, orden por fecha de apertura o de alta, añadir varios archivos a la vez y arrastrar PDFs o Markdown a cualquier parte de la ventana.

### Novedades v6

- **Tus datos, a salvo**: anotaciones, notas, tarjetas y ajustes se guardan en IndexedDB (antes en `localStorage`, que se llenaba con ~5 MB y dejaba de guardar sin avisar). Los datos de versiones anteriores se trasladan solos al abrir la app. Si una escritura falla, se avisa y se reintenta.
- **Cada PDF se reconoce por su contenido** (huella SHA-256): renombrarlo o volver a descargarlo ya no lo separa de sus anotaciones. Si tenías el mismo PDF dos veces, sus notas se combinan.
- **Almacenamiento protegido**: la app pide al navegador que no borre la biblioteca para liberar espacio.
- **Copia de seguridad completa** (biblioteca → icono de base de datos): un solo archivo `.paperbackup` con documentos, notas, tarjetas y ajustes, opcionalmente cifrado con contraseña, o solo las notas. Restaurar combina sin borrar nada.
- **Sincronización entre dispositivos** (Chrome/Edge de escritorio): a través de una carpeta que ya sincronice tu nube (Dropbox, Drive, OneDrive, iCloud), cifrada de extremo a extremo si quieres. Los cambios de dos dispositivos se combinan y los borrados se propagan.
- **Índice de texto guardado**: cada documento se analiza una vez; buscar en un libro de 1.000 páginas o en toda la biblioteca es instantáneo.
- **Vista previa al pasar el ratón** por enlaces internos, citas (`[12]`, «Smith et al., 2019»), figuras y tablas, sin salir de la página.
- **Citas** (panel lateral): título, autores, DOI y arXiv del documento; bibliografía extraída con enlaces a DOI/arXiv/Scholar; copiar cita o BibTeX; exportar `.bib` y `.ris` (Zotero, Mendeley, EndNote) o copiar los DOI para «Añadir por identificador» en Zotero. «Completar con doi.org» consulta solo el DOI.
- **Vista dividida** (`D`): un segundo lector a la derecha con otro documento o el mismo en otra página.
- **Abrir con Paper Reader**: instalada, aparece en «Abrir con» para PDF y Markdown y como destino al compartir en el móvil.
- **Móvil**: el scroll continuo ya no vuelve a la primera página al ampliar, girar u ocultarse la barra de direcciones; las páginas ampliadas no se deforman; deslizar solo pasa página cuando el gesto es claramente horizontal; tocar la página muestra u oculta los controles en cualquier modo y hay un botón fijo para salir del modo inmersivo.

### Novedades v7

- **Recorte en cualquier vista** (`X`): selecciona una fórmula, tabla o párrafo arrastrando sobre la página, también en doble página y en scroll continuo. La zona queda marcada con un recuadro numerado mientras está adjunta.
- **Menú de preguntas junto al recorte**: preguntas preparadas para artículos científicos (explicar paso a paso, definir los símbolos y su papel, por qué es importante en el argumento, en qué supuestos se basa y qué consecuencias tiene), «Añadir otra área» y «Preguntar otra cosa…». Se puede cambiar a un juego general (explicar, resumir, términos, traducir). El mismo menú está en «Más ▾» al seleccionar texto.
- **Varias áreas a la vez** (hasta 4): el asistente muestra «N áreas adjuntas» con miniaturas que se pueden quitar o ampliar. El modelo visual las recibe numeradas junto con el texto que el PDF tiene en esa zona; si el navegador no tiene IA con visión, se trabaja con ese texto.
- **Pizarra** (`W` o el botón junto al cuaderno): un panel a la derecha del documento para resolver ejercicios a mano mientras lees. Fondo oscuro o claro, liso, con puntos, rayado o cuadrícula; lápiz con presión en cinco colores y tres grosores, goma de trazos, deshacer/rehacer (`Ctrl+Z` / `Ctrl+Shift+Z`) y crece hacia abajo al escribir. Con lápiz óptico, el dedo desplaza y la palma no escribe. Pega recortes del PDF (botón de recorte, «Pegar en la pizarra» en el menú de un área o `Ctrl+V` con una imagen), que se mueven y se escalan con la herramienta de mover. Se guarda por documento, entra en copias y sincronización y se exporta como PNG. Comparte el ancho con la vista dividida y en móvil ocupa toda la pantalla.
- **Fórmulas bien escritas**: las respuestas muestran el LaTeX (`$…$`, `$$…$$`) con KaTeX, que se carga solo cuando aparece una fórmula.

### Novedades v8

- **Referencias matemáticas vivas**: al pasar el ratón (o tocar, en móvil y tableta) por «(6.1)», «Eq. 3», «Theorem 2.3», «Lema 4.1», «Definition 2», «Proposición 5», «Section 3.2» o «§4», aparece la ecuación, el enunciado o la sección tal como están en el PDF, sin salir de la página. Se distingue el enunciado («Theorem 2.3. Let…») de las menciones («by Theorem 2.3»), y la ecuación con su etiqueta a la derecha de la prosa que la cita.
- **Vistas previas al tocar**: citas, figuras, tablas y referencias internas se previsualizan también con el dedo; antes solo con ratón.
- **Volver**: tras saltar desde una vista previa aparece «Volver a la p. N» para regresar a donde leías.
- **Recortes nítidos**: la zona recortada se vuelve a dibujar desde el PDF a unos 1600 px de ancho, así que la IA y la pizarra reciben fórmulas legibles aunque la página se vea con poco zoom.

### Pruebas

```bash
node --test tests/storage.test.mjs tests/sync.test.mjs tests/references.test.mjs
```
