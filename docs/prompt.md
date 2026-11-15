Actúa como un Arquitecto de Software Senior especializado en Web Audio API, sistemas offline de alto rendimiento y Svelte 5. 

Necesito construir el código base completo y funcional de una aplicación web progresiva (PWA) ultra-ligera llamada "GradMix", diseñada para funcionar como Auto-DJ continuo durante una fiesta de graduación de 10 horas seguidas (7:00 PM a 5:00 AM) sin cortes, sin sobrecalentamiento y 100% offline.

### STACK TECNOLÓGICO OBLIGATORIO:
- **Framework:** Svelte 5 (usando Runes: $state, $derived, $effect) + Vite + TypeScript.
- **Estilos:** Tailwind CSS (diseño oscuro OLED para ahorrar batería en la fiesta).
- **Motor de Audio:** Web Audio API nativa (CERO librerías pesadas externas).
- **Almacenamiento Local:** Origin Private File System (OPFS) para los archivos de audio (MP3, WAV, M4A, OGG) e IndexedDB (usando `idb-keyval` o nativo) para metadatos y playlists.
- **Integración Móvil:** Vite PWA Plugin (Service Worker offline-first + manifest.json) + configuración base lista para Capacitor (`@capacitor/core`).

### REQUISITOS TÉCNICOS CRÍTICOS (ARQUITECTURA DE 10 HORAS):
1. **Motor de Audio Doble Canal (Deck A / Deck B) con Gestión Estricta de Memoria:**
   - Usa un ÚNICO `AudioContext` continuo para evitar que iOS Safari o Android Chrome suspendan el audio en segundo plano.
   - Implementa carga bajo demanda (Streaming/Lazy Decoding desde OPFS): Mantén ÚNICAMENTE 2 pistas decodificadas en RAM al mismo tiempo (pista actual y pista siguiente). Al terminar el crossfade, desconecta (`.disconnect()`) y limpia de memoria (`null`) el `AudioBuffer` de la pista anterior para evitar fugas de memoria (memory leaks) tras horas de uso.
   - Implementa curvas de crossfade suaves (`exponentialRampToValueAtTime` o curva de potencia constante / equal-power crossfade) con duración ajustable por el usuario (de 2 a 15 segundos).
   - Incluye detección ligera de BPM en un Web Worker para mostrar el tempo de cada canción y permitir ordenar playlists por BPM.

2. **Almacenamiento Offline Masivo (OPFS):**
   - Crea un servicio `storage.ts` que permita seleccionar múltiples archivos o una carpeta completa de audio desde el dispositivo, guardarlos en OPFS y extraer su duración y metadatos básicos.
   - La app debe abrir y reproducir toda la música en Modo Avión.

3. **Supervivencia en Segundo Plano y Pantalla Bloqueada:**
   - Integra `navigator.mediaSession` para mostrar título, artista/álbum y controlar Play/Pause/Siguiente desde la pantalla de bloqueo y controles Bluetooth.
   - Implementa `navigator.wakeLock` junto con un "Modo Fiesta / Blackout" (pantalla negra OLED con reloj minimalista y pista actual) para evitar que el teléfono entre en suspensión profunda durante las 10 horas.

4. **Playlists y Compartir por WhatsApp:**
   - Permite crear y reordenar playlists (ej. "Calentamiento", "Fiesta Principal", "Cierre").
   - Incluye un botón de "Compartir Playlist por WhatsApp" que genere un texto formateado con el tracklist y un enlace web (`https://wa.me/?text=...`) o exporte un archivo `.json` ligero de la sesión.


### Ciclo de Vida de la Memoria (Estrategia Anti-Crash 10 Horas)
  - Para evitar que Safari (iOS) o Chrome (Android) cierren la aplicación por exceso de consumo de RAM (límite ~1.5 GB en iOS), el motor implementa un patrón de Ventana Deslizante de 2 Búferes.

  sequenceDiagram
    autonumber
    participant OPFS as Almacenamiento OPFS
    participant RAM as Memoria RAM (AudioBuffers)
    participant DeckA as Canal A (Sonando)
    participant DeckB as Canal B (Siguiente)
    participant Master as Salida Master

    Note over OPFS,Master: Estado Inicial: Canción 1 en reproducción
    DeckA->>Master: Reproduciendo Canción 1 (Gain: 1.0)
    
    Note over OPFS,RAM: Faltan 30s para terminar Canción 1 (Pre-carga)
    DeckB->>OPFS: Solicita archivo Canción 2
    OPFS-->>RAM: Decodifica Canción 2 (~40 MB WAV / ~5 MB MP3)
    RAM-->>DeckB: Asigna AudioBuffer a Deck B (Gain: 0.0)

    Note over DeckA,DeckB: Punto de Crossfade (ej. últimos 8 segundos)
    DeckB->>Master: Inicia reproducción sincronizada
    DeckA->>Master: Rampa exponencial de volumen (1.0 -> 0.0)
    DeckB->>Master: Rampa exponencial de volumen (0.0 -> 1.0)

    Note over RAM,DeckA: Limpieza Crítica tras finalizar Crossfade
    DeckA->>DeckA: stop() y disconnect() de nodos Web Audio
    DeckA->>RAM: audioBufferA = null (Libera RAM para Garbage Collector)
    Note over OPFS,Master: Ahora Deck B es el canal principal y Deck A queda libre para Canción 3

## Estructura de Directorios del Proyecto

gradmix-pwa/
├── public/
│   ├── icons/                  # Iconos PWA adaptativos (192x192, 512x512, maskable)
│   └── manifest.json           # Configuración instalable en iOS y Android
├── src/
│   ├── lib/
│   │   ├── audio/
│   │   │   ├── audioEngine.ts  # Motor Deck A/B, Equal-Power Crossfade y Compresor
│   │   │   ├── mediaSession.ts # Controles de pantalla bloqueada y relojes
│   │   │   └── wakeLock.ts     # Prevención de suspensión de pantalla
│   │   ├── storage/
│   │   │   ├── opfsStorage.ts  # Lectura/escritura binaria de MP3/WAV en OPFS
│   │   │   └── db.ts           # Gestión de playlists y metadatos en IndexedDB
│   │   ├── workers/
│   │   │   └── bpmWorker.ts    # Cálculo de BPM en hilo separado
│   │   └── utils/
│   │       └── whatsapp.ts     # Generador de enlaces y tracklists para compartir
│   ├── components/
│   │   ├── PlayerDeck.svelte   # Visualización de pista actual, siguiente y progreso
│   │   ├── CrossfadeControl.svelte # Selector de duración (2s - 15s) y curva
│   │   ├── PlaylistManager.svelte  # Subida de carpetas, orden por BPM y bloques
│   │   └── BlackoutOverlay.svelte  # Modo ahorro extremo OLED para la fiesta
│   ├── App.svelte              # Estado global reactivo (Svelte 5 Runes)
│   └── main.ts                 # Punto de entrada y registro de Service Worker
├── capacitor.config.ts         # Configuración para empaquetado nativo opcional
├── vite.config.ts              # Configuración Vite + VitePWA (Workbox offline)
├── tailwind.config.js          # Tema oscuro OLED (#000000)
└── package.json

### Especificaciones Técnicas por Módulo

*** Módulo: audioEngine.ts *** 
- Responsabilidad: Mezcla continua y control de hardware.
- Detalle Crítico de Implementación: Usa una curva de Potencia Constante (Equal-Power) mediante Math.cos y Math.sin sobre GainNode para evitar caídas de volumen a mitad de la transición. Incluye un DynamicsCompressorNode en la salida para nivelar canciones con distinto volumen de grabación.

*** Módulo: opfsStorage.ts	***
- Responsabilidad: Persistencia masiva de audio.	
- Detalle crítico de implementación: Utiliza navigator.storage.getDirectory() para guardar archivos sin límite de cuota de caché tradicional. Lee los archivos como ArrayBuffer solo cuando van a entrar en cola.

*** Módulo: bpmWorker.ts ***
- Responsabilidad: Detección de tempo sin latencia.	
- Detalle crítico de implementación: Analiza los picos de baja frecuencia (bombo/bajo entre 60Hz y 150Hz) en un Web Worker dedicado apenas se sube una canción, guardando el resultado en IndexedDB para no repetir el cálculo durante la fiesta.

*** Módulo: mediaSession.ts ***
- Responsabilidad: Supervivencia en segundo plano.	
- Detalle crítico de implementación: Actualiza navigator.mediaSession.metadata en cada cambio de pista y mantiene el AudioContext activo para evitar que iOS mate la pestaña al apagar la pantalla.

***Módulo: BlackoutOverlay.svelte ***

- Responsabilidad: Ahorro térmico y de batería.	
- Detalle crítico de implementación: Renderiza una capa #000000 (apaga los píxeles en pantallas OLED) mostrando solo la hora, batería y canción actual con opacidad al 20%, manteniendo activo navigator.wakeLock.request('screen').

*** Consejo para el desarrollo: No instales librerías de UI completas (como DaisyUI, Skeleton o Flowbite) ni reproductores de audio externos (como Howler.js o Tone.js). Howler.js carga todo el archivo en memoria sin control fino de nodos y Tone.js pesa demasiado para lo que necesitas; tu propio audioEngine.ts sobre Web Audio API nativa será mucho más estable durante las 10 horas de fiesta. ***

### ENTREGABLES QUE NECESITO EN TU RESPUESTA:
1. Estructura completa de carpetas del proyecto (ya detallada en este prompt)
2. Configuración de `vite.config.ts` (con `vite-plugin-pwa`) y `capacitor.config.ts`. 
3. Código completo y comentado de los módulos núcleo:
   - `src/lib/audioEngine.ts` (El motor Deck A/B, equal-power crossfade, limpieza de RAM y Media Session API).
   - `src/lib/opfsStorage.ts` (Guardado, lectura y eliminación de MP3/WAV en OPFS).
   - `src/lib/bpmWorker.ts` (Web Worker ligero para calcular BPM sin congelar la UI).
   - `src/App.svelte` (Interfaz móvil ultra-rápida con reproductor dual, gestor de playlists, control de crossfade, botón WhatsApp y Modo Blackout OLED).

Asegúrate de manejar explícitamente el desbloqueo del `AudioContext` en iOS tras el primer toque del usuario y evitar cualquier cuello de botella de memoria.

- Instala y reacomoda lo que hace falta, si ya existe no instales ni sobreescribas nada
