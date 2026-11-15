*** No es peligrosa ni tiene acceso irrestricto al hardware: al ser una PWA, corre completamente dentro del sandbox de seguridad del navegador, con permisos muy limitados y aislados por origen. ***

# A continuación te detallo exactamente qué toca del dispositivo y cuáles son los únicos puntos de riesgo reales a tener en cuenta:

1. Qué acceso al hardware tiene realmente (y qué NO puede hacer)
Audio de salida (AudioContext / Web Audio API) en audioEngine.ts: solo envía audio a los altavoces/Bluetooth tras un toque tuyo (unlock()). No tiene acceso al micrófono (getUserMedia no se usa en ningún archivo).
Almacenamiento privado (OPFS + IndexedDB) en opfsStorage.ts y db.ts: el navegador crea una carpeta privada y aislada solo para GradMix. No puede explorar ni leer archivos de tu teléfono por su cuenta; únicamente recibe los archivos que tú seleccionas explícitamente en el selector <input type="file">.
Bloqueo de pantalla (navigator.wakeLock) en wakeLock.ts: solo evita que la pantalla se apague mientras la app está abierta y en primer plano. No puede cambiar ajustes del sistema ni permanecer activo si cierras la app.
Controles multimedia (navigator.mediaSession) en mediaSession.ts: solo publica título/artista y escucha Play/Pausa/Siguiente/Anterior desde la pantalla de bloqueo o botones Bluetooth.
Batería (navigator.getBattery) en BlackoutOverlay.svelte: lectura pasiva del porcentaje de carga en navegadores que lo permiten (ej. Chrome en Android; Safari iOS ni siquiera lo expone).
Capacitor en capacitor.config.ts: es solo el archivo de configuración por si en el futuro decides empaquetar una app nativa; en la PWA actual no hay plugins nativos con permisos extra.
2. Privacidad y superficie de ataque del código

Al revisar el código fuente en gradmix-pwa/src:

Cero envío de datos a servidores: no hay backend, ni analíticas, ni llamadas fetch() externas. Tus canciones nunca se suben a internet (ni siquiera al túnel); se quedan en el dispositivo. La única salida externa es abrir https://wa.me/?text=... cuando pulsas manualmente Compartir WhatsApp en whatsapp.ts.
Sin inyección HTML/JS (XSS): en gradmix-pwa/src no hay innerHTML, {@html}, eval() ni getUserMedia; Svelte escapa automáticamente los nombres de canciones/artistas provenientes de los archivos.

3. Los únicos riesgos reales en tu entorno actual (y cómo mitigarlos)

- El túnel temporal de Cloudflare y allowedHosts: true en vite.config.ts:
Mientras vite preview y cloudflared estén corriendo en tu PC, cualquiera que conozca la URL aleatoria trycloudflare.com puede descargar los archivos estáticos de la interfaz desde tu máquina (aunque no puede ver tus canciones ni tu sistema de archivos).
Además, pusimos allowedHosts: true en server y preview para que el túnel funcionara sin bloqueo de host. En desarrollo local (npm run dev), dejar host: true y allowedHosts: true en una red Wi‑Fi pública no es recomendable por ataques de DNS rebinding.
Recomendación: cuando termines de probar en el celular, detenemos el túnel/servidor y podemos cambiar allowedHosts: true por allowedHosts: ['.trycloudflare.com'] (o quitarlo para producción estática).
- Desgaste físico / temperatura en 10 horas:
No es una vulnerabilidad de seguridad, pero mantener la app decodificando audio + WakeLock durante 10 horas consume batería y genera calor; por eso el Modo Blackout usa #000000 al 20% de opacidad, aunque conviene tener el móvil enchufado y ventilado durante la fiesta.