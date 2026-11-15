# Nota de Andrés: Quiero que este proyecto sea open source y que funcione en diferentes plataformas, como android, ios, windows, mac y linux. Además, quiero que sea fácil de instalar y usar por cualquier persona, sin necesidad de conocimientos técnicos. 
# La creé para una fiesta de graduación, para eliminar la necesidad de:
# 1- Contratar un dj y que funcionara de manera autómata 
# 2- Cambiar de canción todo el tiempo, asi que es indispensable añadir crossfade
# 3- Crear una playlist que funcione con la memoria del navegador, por lo que debe ser ligera, por eso opté usar Svelte 5 o  Preact. No debe almacenar canciones en el navegador.

# Despues de indagar con ayuda de google gemini, opté porque fuera de esta forma, considerando los riesgos y limitantes como la memoria del navegador, la integración con sistemas operativos, la asincronía, etc.



1. El Reto Crítico: Maratón de 10 Horas sin Cortes ni Sobrecalentamiento
Para que el sistema aguante desde las 7:00 PM del 18 de diciembre hasta las 5:00 AM del 19 de diciembre sin que el celular se apague, se quede sin RAM o corte la música al bloquear la pantalla:

Gestión estricta de RAM (Decodificación bajo demanda): Un set de 10 horas son ~150 a 180 canciones. Nunca se deben cargar todas en memoria. La app solo mantiene decodificadas en RAM 2 pistas a la vez (la que suena actualmente y la siguiente que va a entrar). Apenas termina una canción, su búfer se destruye de la memoria.

Cero fugas de memoria (Memory Leaks): Cada nodo de audio (AudioBufferSourceNode, GainNode) debe desconectarse (.disconnect()) explícitamente tras finalizar su crossfade.

Modo Ahorro de Pantalla (Blackout Mode): Un botón en la app que oscurece la pantalla al mínimo (negro puro OLED) mientras mantiene activo el Screen Wake Lock y el flujo de audio continuo para evitar que iOS o Android suspendan el proceso por inactividad.

2. Stack Tecnológico Seleccionado
Frontend: Svelte 5 + Vite + Tailwind CSS (sin Virtual DOM, actualiza a 60 FPS sin consumir CPU extra, dejando los recursos libres para el audio).

Motor de Audio: Web Audio API Nativa (un único AudioContext continuo con doble canal A/B, curvas de ganancia exponenciales para crossfade suave y detección ligera de BPM).

Almacenamiento Offline: OPFS (Origin Private File System) + IndexedDB. Guarda cientos de MP3/WAV localmente en el teléfono para funcionar 100% sin internet en el salón de eventos.

Empaquetado e Instalación: PWA (Service Worker + Manifest) para instalación directa desde el navegador y compartir vía WhatsApp, preparada con Capacitor por si se requiere acceso nativo directo a audio en iOS/Android.

Integración con el Sistema: Media Session API para controlar play/pausa/siguiente desde la pantalla de bloqueo o reloj inteligente.

3. Funcionalidades Clave del MVP
Carga Masiva de Álbum/Carpeta: Subir decenas de archivos (MP3, WAV, M4A, FLAC) de golpe y guardarlos en OPFS.

Playlists y Orden Inteligente: Organizar bloques musicales (ej. Cóctel -> Cena -> Hora Loca -> Remate) con opción de ordenar por BPM para evitar saltos bruscos de energía.

Auto-DJ con Crossfade Configurable: Transición automática entre pistas (ej. ajustable de 4 a 12 segundos) con sincronización básica de tiempo y curva de volumen profesional.

Compartir por WhatsApp: Exportar/compartir la playlist mediante enlace ligero web o archivo de configuración para que otros invitados puedan escuchar o aportar canciones.

