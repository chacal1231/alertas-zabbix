#!/bin/sh
set -eu

# Una sola instancia puede usar este volumen y su perfil de Chromium.
mkdir -p "$DATA_DIR"
exec 9>"$DATA_DIR/.runtime.lock"
if ! flock -n 9; then
  echo 'El volumen de WhatsApp está siendo usado por otra instancia.' >&2
  exit 1
fi

# Con el bloqueo exclusivo adquirido, los enlaces de un proceso anterior
# son obsoletos. No se borran cookies, credenciales ni archivos de sesión.
profile="$DATA_DIR/session/session"
for name in SingletonLock SingletonSocket SingletonCookie; do
  if [ -L "$profile/$name" ]; then
    rm -- "$profile/$name"
  fi
done
exec "$@"
