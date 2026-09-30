# Alertas de Zabbix a WhatsApp

Receptor HTTP con panel de login, vinculación por QR, selección de grupos, filtros y seguimiento de problemas y recuperaciones. Node.js, whatsapp-web.js y SQLite; un solo servicio Docker. Sin HTTPS.

## Preparación automática del servidor

En Ubuntu/Debian con systemd:

```sh
./preparar.sh
# Completa .env si el script acaba de crearlo.
./preparar.sh --iniciar
```

El script instala las herramientas necesarias, Docker Engine, Buildx y Compose; inicia Docker y valida las credenciales sin mostrarlas. Usa sudo cuando hace falta. Conserva el contenido de `.env` existente y deja el archivo con permisos `600` para el usuario que ejecutó el script. Si falta `.env`, copia la plantilla y termina para que completes las credenciales. Node.js, Chromium y las dependencias de la aplicación se instalan dentro de la imagen al usar `--iniciar`.

La instalación nueva utiliza el [repositorio oficial de Docker](https://docs.docker.com/engine/install/ubuntu/). Si detecta runtimes incompatibles, se detiene para que se revise la instalación existente. Se puede invocar desde cualquier directorio. No instala HTTPS.

## Despliegue

Necesitas Docker Engine y Docker Compose en un servidor con acceso a WhatsApp Web. Como presupuesto inicial de prueba, reserva 1 vCPU y 1–2 GB de RAM para una sesión; el uso real depende principalmente de Chromium.

```sh
cp .env.example .env
# Edita .env: usuario, contraseña de 12+ caracteres y token de 24+ caracteres.
docker compose up -d --build
```

Abre `http://IP_DEL_SERVIDOR:9012`, inicia sesión con las credenciales de `.env`, escanea el QR desde Dispositivos vinculados en WhatsApp, carga los grupos, selecciona los destinos y guarda. El número debe pertenecer a los grupos y poder enviar mensajes. No se envían alertas hasta configurar destinos. Los filtros se combinan: severidad mínima, texto del host y etiqueta exacta `clave=valor`.

El panel funciona por HTTP, tal como se solicitó. La cookie de sesión es HttpOnly y SameSite=Strict, compatible con HTTP. Hay protección CSRF y límite de intentos de login. La sesión caduca a las ocho horas y se invalida al reiniciar el servicio. Credenciales y token se configuran solo en `.env`.

## Configurar Zabbix 6.4

1. Importa `zabbix/media-type.xml` como tipo de medio nuevo **TVYMAS WhatsApp Alertas**. Está basado en el XML original y limitado a eventos de triggers.
2. Edita los parámetros del tipo de medio: `tvymasurl=http://IP_DEL_SERVIDOR:9012/zabbix-webhook` y `webhook_token` con el mismo valor de `.env`. Conserva las macros restantes, especialmente `event_id={EVENT.ID}`.
3. Asigna este medio a un usuario Zabbix con permisos de lectura sobre los hosts; puedes usar `whatsapp` en Enviar a, ya que los grupos se eligen en el panel. Habilita horario y severidades adecuados.
4. En la acción de triggers, configura una operación de problema y una **operación de recuperación** para enviar a ese usuario mediante este medio. Añade una operación de actualización si quieres notificar reconocimientos/comentarios. Usa los mensajes predeterminados: `Active` y `Resolved`.
5. Provoca un problema de prueba y después recupéralo. Verifica que el mismo ID pasa de Activo a Recuperado en el panel y que se reciben ambos mensajes.

El servicio hace seguimiento mediante los webhooks: **no consulta periódicamente la API de Zabbix ni detecta por sí solo una recuperación**. Sin una operación de recuperación en Zabbix, el incidente permanecerá activo. No hay recordatorios periódicos automáticos.

`zabbix/webhook.js` contiene el script legible, que ya está integrado en el XML. Corrige los comentarios de una sola línea del original y establece las cabeceras mediante `addHeader`. El receptor requiere `Authorization: Bearer TOKEN` y devuelve HTTP 200 después de guardar el evento y los trabajos de envío en una transacción, aunque WhatsApp esté desconectado. Un 200 confirma recepción durable, no entrega por WhatsApp.

## Seguimiento y reintentos

- Se correlaciona por el ID original del problema. Problema, actualización y recuperación tienen identidades separadas para deduplicar reintentos.
- Los destinos quedan fijados al recibir el primer evento del incidente. Un cambio de filtros o grupos se aplica a nuevos incidentes. Las recuperaciones se envían a los destinos originales, incluso si la nueva configuración los excluye.
- Un problema tardío no reabre un incidente recuperado. Una recuperación sin problema previo se registra y notifica según los filtros actuales.
- La cola persiste en SQLite. Procesa un envío a la vez, como máximo uno cada dos segundos. Espera a que WhatsApp esté conectado; reintenta errores hasta cinco veces con espera creciente.
- Se conserva el orden por incidente y destino mientras haya trabajos pendientes. Después de un fallo definitivo, la recuperación puede avanzar. El panel permite reintentar fallos, salvo estados anteriores a uno ya enviado.
- “Enviado” significa que la llamada a WhatsApp completó; no acredita lectura ni entrega al teléfono. Si el proceso termina después de enviar pero antes de registrar el resultado, puede repetirse el mensaje al arrancar: no se garantiza entrega exactamente una vez.
- Una desconexión intenta reconectar cada minuto. Si se revoca la sesión, puede requerirse volver a vincular mediante QR. Las sesiones WhatsApp se conservan en el volumen.
- El panel muestra los últimos 200 incidentes y envíos. La base conserva todo el historial: dimensiona el disco de acuerdo con el volumen de eventos.

## Operación

```sh
docker compose logs -f --tail=100
docker compose restart
# Detener conservando datos y sesión:
docker compose down
```

No uses `docker compose down -v` si quieres conservar datos. Respalda el volumen `alertas_data` con el servicio detenido para copiar de forma consistente SQLite y la sesión. Ejecuta solo una instancia por volumen/sesión WhatsApp. Chromium se ejecuta sin su sandbox interno dentro del contenedor, como usuario no root. El contenedor mantiene las restricciones de Docker por defecto.

whatsapp-web.js es una integración no oficial, dependiente de WhatsApp Web. El proyecto advierte de posibles bloqueos de cuenta; conviene mantener otro canal para alertas críticas.

## Desarrollo y pruebas

Node.js 22.13 o superior (usa `node:sqlite`).

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci
npm test
# Con Chromium instalado y credenciales en .env:
CHROMIUM_PATH=/usr/bin/chromium node --env-file=.env src/server.js
```

`MOCK_WHATSAPP=true` habilita un adaptador local para pruebas del panel/webhook sin vincular una cuenta; en este modo no se envía ningún mensaje real. No se activa en Docker Compose.

Referencias: [cliente de whatsapp-web.js](https://docs.wwebjs.dev/Client.html), [persistencia con LocalAuth](https://wwebjs.dev/guide/creating-your-bot/authentication.html), [SQLite de Node.js](https://nodejs.org/api/sqlite.html).

## Validación realizada

Las siete pruebas automatizadas pasan: login y restricciones de acceso, CSRF, token del webhook, persistencia tras reinicio, deduplicación, recuperación, destinos originales y orden de reintentos. También se verificó la sintaxis del backend y frontend. La integración HTTP se prueba con WhatsApp simulado.

Pendiente en un servidor de despliegue: construir la imagen Docker, importar el XML en Zabbix y verificar QR/envío real con una cuenta vinculada. El entorno de desarrollo no tiene Docker ni Chromium instalados.

La auditoría de dependencias reporta cinco entradas de severidad alta en la cadena whatsapp-web.js → Puppeteer → extract-zip, por extracción de archivos ZIP. La imagen desactiva las descargas de navegadores de Puppeteer y utiliza Chromium del sistema; esto evita esa ruta de descarga durante su instalación normal, pero no elimina el aviso de dependencia. Se conserva la versión de Puppeteer requerida por whatsapp-web.js para no introducir una actualización mayor sin verificar la vinculación real.
