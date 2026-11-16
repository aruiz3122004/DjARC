<script lang="ts">
  import AccordionList from './AccordionList.svelte';
  import type { AccordionItem } from '../lib/types';

  type FaqTopic = 'all' | 'usage' | 'licenses' | 'rooms' | 'storage';

  interface FaqEntry extends AccordionItem {
    topic: Exclude<FaqTopic, 'all'>;
  }

  let selectedTopic = $state<FaqTopic>('all');

  const TOPIC_TABS: ReadonlyArray<{ id: FaqTopic; label: string }> = [
    { id: 'all', label: 'Todas' },
    { id: 'usage', label: 'Uso y Auto-DJ' },
    { id: 'licenses', label: 'Licencias y Catálogo' },
    { id: 'rooms', label: 'Salas en Vivo' },
    { id: 'storage', label: 'Almacenamiento' },
  ];

  const FAQ_ITEMS: readonly FaqEntry[] = [
    {
      id: 'usage-offline',
      topic: 'usage',
      category: 'USO GENERAL · OFFLINE Y PWA',
      question: '¿Necesito internet para usar GradMix en un evento?',
      answer:
        'No para tu música guardada. GradMix es una PWA offline-first: todas las canciones que importes o descargues se almacenan localmente en tu dispositivo y siguen sonando con normalidad aunque se corte el internet.',
    },
    {
      id: 'usage-crossfade',
      topic: 'usage',
      category: 'USO GENERAL · AUTO-DJ Y DECKS',
      question: '¿Cómo funciona el doble deck y el Crossfade automático?',
      answer:
        'GradMix alterna automáticamente entre Deck A y Deck B para realizar mezclas sin silencios. Puedes elegir la duración del crossfade (4s, 8s o 12s) y dejar activado Auto-DJ para que la siguiente canción de la cola entre de forma continua antes de terminar la actual.',
    },
    {
      id: 'usage-install-pwa',
      topic: 'usage',
      category: 'USO GENERAL · INSTALAR EN CELULAR (PWA)',
      question: '¿Cómo instalo GradMix como aplicación real en Android o iPhone?',
      answer:
        'En Android Chrome, pulsa el botón "Instalar App" dentro de la app (o abre el menú ⋮ de Chrome y elige "Instalar aplicación" / "Añadir a pantalla de inicio → Instalar"; evita el ícono de flecha ↓ "Descargar página", ya que eso solo guarda una copia estática sin conexión). En iPhone/iPad abre gradmix.arc03.online en Safari, pulsa Compartir → "Añadir a pantalla de inicio".',
    },
    {
      id: 'usage-formats-export',
      topic: 'usage',
      category: 'USO GENERAL · FORMATOS Y RESPALDO',
      question: '¿Qué formatos de audio soporta y cómo exporto una playlist?',
      answer:
        'Puedes importar archivos locales MP3, M4A/AAC, WAV, FLAC y OGG, y la app analiza el BPM en segundo plano. Desde el módulo Playlists puedes exportar cualquier lista completa como un archivo ZIP para respaldarla o abrirla en otro equipo.',
    },
    {
      id: 'usage-blackout',
      topic: 'usage',
      category: 'USO GENERAL · MODO AHORRO',
      question: '¿Para qué sirve el botón Ahorro (Modo Blackout)?',
      answer:
        'El modo Ahorro oscurece/bloquea temporalmente la pantalla para reducir consumo energético y evitar toques accidentales durante una fiesta o presentación, mientras el audio continúa reproduciéndose sin interrupciones.',
    },
    {
      id: 'licenses-open-source',
      topic: 'licenses',
      category: 'CÓDIGO ABIERTO · PROYECTO',
      question: '¿GradMix es de código abierto y gratuito?',
      answer:
        'Sí. GradMix es una aplicación 100% de código abierto (open source) y gratuita: cualquiera puede auditar el código fuente completo del cliente PWA y del Worker de salas en GitHub (aruiz3122004/DjARC) para comprobar cómo se procesa el audio, el almacenamiento y la seguridad.',
    },
    {
      id: 'licenses-user-data',
      topic: 'licenses',
      category: 'PRIVACIDAD · DATOS DEL USUARIO',
      question: '¿Qué información del usuario recopila la aplicación?',
      answer:
        'GradMix no recopila ni vende información personal: no pide registro, correo ni teléfono, ni usa trackers o analíticas externas. Tu música, playlists y ajustes viven únicamente en tu dispositivo (OPFS/IndexedDB o carpeta autorizada). Solo si entras a una Sala colaborativa, se genera un ID técnico aleatorio en tu navegador y se comparte temporalmente el nombre que escribas para la sala y las canciones enviadas allí, eliminándose automáticamente al cerrar o expirar la sala.',
    },
    {
      id: 'licenses-catalog',
      topic: 'licenses',
      category: 'LICENCIAS Y DERECHOS · CATÁLOGO',
      question: '¿Qué licencias tienen las canciones del buscador y cómo usarlas legalmente?',
      answer:
        'El buscador público consulta el catálogo abierto de Audius (creadores independientes, remixes y lanzamientos autorizados para streaming/descarga en la plataforma). Si importas archivos propios o gestionas eventos comerciales, asegúrate de contar con las licencias o derechos correspondientes en tu país.',
    },
    {
      id: 'licenses-missing-songs',
      topic: 'licenses',
      category: 'LICENCIAS Y DERECHOS · REPERTORIO',
      question: '¿Por qué algunas canciones comerciales de Spotify o YouTube no aparecen?',
      answer:
        'Los sellos discográficos comerciales protegen sus lanzamientos con DRM exclusivo en plataformas cerradas. Para sonar cualquier tema que no esté en el catálogo abierto, impórtalo directamente desde tu almacenamiento (MP3, M4A, WAV o FLAC) en Playlists o súbelo a tu Sala.',
    },
    {
      id: 'licenses-privacy',
      topic: 'licenses',
      category: 'LICENCIAS Y PRIVACIDAD · DATOS',
      question: '¿GradMix sube mi biblioteca privada o historial a servidores externos?',
      answer:
        'No. Tu biblioteca, listas de reproducción, favoritos y pistas descargadas viven exclusivamente en tu navegador o en la carpeta local que autorices. Solo las pistas que compartes manualmente dentro de una Sala se transmiten de forma temporal hacia ese espacio.',
    },
    {
      id: 'rooms-how-it-works',
      topic: 'rooms',
      category: 'SALAS EN VIVO · CAPACIDAD Y ENLACE',
      question: '¿Cómo creo una Sala y cuántas personas pueden conectarse?',
      answer:
        'En el módulo Sala, ingresa tu nombre de Host y crea la sala para obtener un código de 4 dígitos y un botón directo de invitación por WhatsApp. Cada sala admite hasta 100 participantes conectados en tiempo real y se autodestruye automáticamente tras 1 hora de actividad máxima.',
    },
    {
      id: 'rooms-permissions-mute',
      topic: 'rooms',
      category: 'SALAS EN VIVO · PERMISOS Y AUDIO',
      question: '¿Qué puede controlar el Host y qué pueden hacer los invitados?',
      answer:
        'Los invitados escuchan en vivo lo que reproduce la sala y ven las siguientes 5 canciones en cola. Desde la tabla de Participantes, el Host decide por usuario si puede Saltar, Pausar, Añadir o Eliminar temas, o expulsarlo. Cada invitado cuenta además con un ícono local de silenciar (Mute) solo para su dispositivo.',
    },
    {
      id: 'rooms-host-pause-locked',
      topic: 'rooms',
      category: 'SALAS EN VIVO · CONTROLES',
      question: '¿Por qué al Host le aparece bloqueado el botón de Play/Pausa dentro de la Sala?',
      answer:
        'Dentro de la vista de Sala, ese botón solo muestra el estado actual que están recibiendo los invitados para evitar confusiones. El control real de reproducción, pausa, adelanto y mezcla del Host siempre se maneja desde el Reproductor principal o la barra inferior.',
    },
    {
      id: 'rooms-inactivity',
      topic: 'rooms',
      category: 'SALAS EN VIVO · DESCONEXIÓN',
      question: '¿Por qué la sala me expulsó por "inactividad"?',
      answer:
        'Para evitar usuarios duplicados o sesiones fantasma, la sala verifica la conexión activa mediante latidos en tiempo real. Si un invitado sale de la app y deja de recibir datos de audio durante 10 segundos continuos, el servidor lo retira automáticamente y muestra una alerta para regresar al reproductor.',
    },
    {
      id: 'storage-limit-10gb',
      topic: 'storage',
      category: 'ALMACENAMIENTO · LÍMITE Y ALERTAS',
      question: '¿Cuál es el límite de 10 GB del navegador y qué pasa al llenarlo?',
      answer:
        'Por defecto las descargas van al almacenamiento interno del navegador (OPFS), con un tope práctico de 10 GB. Al superar el 90% GradMix recomienda cambiar a Almacenamiento Interno de tu dispositivo; si alcanza el 99%, se bloquean nuevas descargas en el navegador hasta que liberes espacio o elijas una carpeta local.',
    },
    {
      id: 'storage-switch-safe',
      topic: 'storage',
      category: 'ALMACENAMIENTO · CARPETA LOCAL',
      question: '¿Si cambio a Almacenamiento Interno pierdo mis canciones anteriores?',
      answer:
        'No. Cambiar de almacenamiento no borra ni mueve lo que ya estaba guardado en el navegador: tus pistas previas siguen disponibles y únicamente las nuevas descargas o importaciones se escribirán en la carpeta que seleccionaste. En Monitoreo puedes consultar cómo elegirla en PC, Android e iOS.',
    },
  ];

  let filteredItems = $derived(
    selectedTopic === 'all' ? FAQ_ITEMS : FAQ_ITEMS.filter((item) => item.topic === selectedTopic)
  );
</script>

<section class="border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-900 dark:bg-zinc-950">
  <div class="mb-4">
    <h2 class="text-base font-semibold tracking-tight text-zinc-900 dark:text-white">
      Preguntas y Respuestas
    </h2>
    <p class="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
      Aplicación de código abierto: guía rápida sobre uso, privacidad, licencias musicales, salas colaborativas y almacenamiento local.
    </p>
  </div>

  <!-- Filtros por tema -->
  <div class="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Filtrar preguntas por tema">
    {#each TOPIC_TABS as tab (tab.id)}
      {@const active = selectedTopic === tab.id}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onclick={() => (selectedTopic = tab.id)}
        class="border px-2.5 py-1.5 text-[11px] font-medium transition {active
          ? 'border-zinc-900 bg-zinc-900 text-white dark:border-cyan-400 dark:bg-cyan-400 dark:text-black'
          : 'border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:bg-black dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'}"
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <div class="bg-white dark:bg-black">
    <AccordionList items={filteredItems} />
  </div>
</section>
