# Servidor local de videos para Sala

Guarda los videos en tu mini PC o Raspberry Pi y los entrega a Sala:

- **En la escuela (red local):** abre `http://IP-DEL-EQUIPO:8787` y los videos viajan solo por tu red.
- **Desde fuera:** los clientes usan la dirección de Vercel y los videos llegan por un túnel seguro de Cloudflare.

Solo los miembros con sesión activa en Sala pueden reproducir los videos: cada reproducción usa un enlace firmado que vence en 6 horas.

## Requisitos
- Debian, Ubuntu o Raspberry Pi OS (64 bits recomendado)
- Un disco con espacio suficiente. Un USB externo funciona bien para muchos videos.
- Recomendado: conectar el equipo por cable de red, no por Wi-Fi

## 1. Instalar
```bash
git clone https://github.com/gr3t4/Sala.git
cd Sala/servidor-local
./instalar.sh
```
El script instala Node y ffmpeg si faltan, crea el archivo `.env` con una clave nueva y deja el servidor como servicio, para que arranque solo al prender el equipo.

Para guardar los videos en un disco externo, edita `.env`, pon `DATA_DIR=/ruta/del/disco` y reinicia el servicio con `sudo systemctl restart sala-local`.

## 2. Probar en la red local
Abre `http://IP-DEL-EQUIPO:8787` desde una computadora o celular conectado a la misma red e inicia sesión. En **Administrar → Videos** debe aparecer "Servidor local conectado".

## 3. Publicarlo en internet (túnel de Cloudflare)
Necesitas un dominio administrado en Cloudflare. Uno `.com` cuesta unos 10 USD al año.

```bash
# Raspberry Pi (ARM64). En una mini PC con Intel/AMD cambia arm64 por amd64
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb

cloudflared tunnel login                      # abre el navegador para autorizar tu dominio
cloudflared tunnel create sala
cloudflared tunnel route dns sala videos.TUDOMINIO.com
```
Crea `~/.cloudflared/config.yml`:
```yaml
tunnel: sala
credentials-file: /home/TU_USUARIO/.cloudflared/<ID-DEL-TUNEL>.json
ingress:
  - hostname: videos.TUDOMINIO.com
    service: http://localhost:8787
  - service: http_status:404
```
Y déjalo como servicio:
```bash
sudo cloudflared --config ~/.cloudflared/config.yml service install
```

**Prueba rápida sin dominio:** `cloudflared tunnel --url http://localhost:8787` te da una dirección `https://algo.trycloudflare.com`. Sirve para probar, pero cambia cada vez que reinicias.

## 4. Conectar Sala con el túnel
En `index.html` (en la raíz del repositorio) cambia:
```js
const MEDIA_URL = "https://videos.TUDOMINIO.com";
```
Sube el cambio a GitHub y Vercel lo publica solo.

## Uso diario
- **Subir:** en Sala → Administrar → Videos, elige "Subir a: Mi servidor local". La subida se hace por partes y se reanuda si se corta la conexión.
- **Procesamiento:** un MP4 en H.264 queda listo en segundos (`MODO=auto` lo copia sin convertir). Otros formatos se convierten a 720p; en una Raspberry Pi eso puede tardar más que la duración del video.
- **Registros:** `journalctl -u sala-local -f`
- **Actualizar:** `cd Sala && git pull && sudo systemctl restart sala-local`

## Capacidad
Cada persona viendo en 720p usa unos 3 Mbps de la **subida** de tu internet, y en 1080p unos 5 Mbps. Haz una prueba de velocidad para saber cuántos clientes pueden ver a la vez desde fuera. En la red local no hay ese límite.

Las condiciones del plan gratuito de Cloudflare no están pensadas para transmitir mucho video. Para pocos clientes normalmente no hay problema, pero si el tráfico crece considera Bunny Stream, que Sala ya soporta.
