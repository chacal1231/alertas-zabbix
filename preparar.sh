#!/usr/bin/env bash
# Prepara el despliegue Docker en Ubuntu/Debian. No ejecuta .env como código.
set -Eeuo pipefail
trap 'printf "Error en la línea %s. Revisa el mensaje anterior.\n" "$LINENO" >&2' ERR

usage() {
  cat <<'HELP'
Uso: ./preparar.sh [--iniciar]
  Sin argumentos: instala dependencias y valida la configuración.
  --iniciar: además construye la imagen y arranca el proyecto.
  --help: muestra esta ayuda.
Requiere Ubuntu/Debian, Internet y permisos sudo.
Conserva el contenido de .env si ya existe.
HELP
}
start=false
case "${1:-}" in
  '') ;;
  --iniciar) start=true ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"
for file in compose.yaml Dockerfile package-lock.json .env.example; do
  [[ -f "$file" ]] || { printf 'Falta el archivo %s\n' "$file" >&2; exit 1; }
done
[[ -f /etc/os-release ]] || { echo 'Sistema no compatible.' >&2; exit 1; }
# Archivo del sistema, no configuración proporcionada por el usuario.
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo 'Este script admite Ubuntu y Debian.' >&2; exit 1 ;; esac
command -v systemctl >/dev/null || { echo 'Se requiere systemd para iniciar Docker.' >&2; exit 1; }
admin=()
if [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null || { echo 'Instala sudo o ejecuta el script como root.' >&2; exit 1; }
  sudo -v
  admin=(sudo)
fi

printf '\nPreparando herramientas del sistema…\n'
"${admin[@]}" apt-get update
"${admin[@]}" apt-get install -y ca-certificates curl python3

if ! command -v docker >/dev/null; then
  # No retirar runtimes existentes: podrían usarlos otros servicios.
  conflicts=()
  for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    if [[ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" == 'install ok installed' ]]; then
      conflicts+=("$package")
    fi
  done
  if ((${#conflicts[@]})); then
    printf 'Hay paquetes que requieren revisión antes de instalar Docker CE: %s\n' "${conflicts[*]}" >&2
    exit 1
  fi
  codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  [[ -n "$codename" ]] || { echo 'No se pudo detectar la versión del sistema.' >&2; exit 1; }
  arch="$(dpkg --print-architecture)"
  # Verificar que el repositorio existe antes de añadirlo.
  curl -fsSL "https://download.docker.com/linux/$ID/dists/$codename/Release" -o /dev/null
  "${admin[@]}" install -m 0755 -d /etc/apt/keyrings
  "${admin[@]}" curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  "${admin[@]}" chmod 0644 /etc/apt/keyrings/docker.asc
  "${admin[@]}" tee /etc/apt/sources.list.d/docker.sources >/dev/null <<REPO
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
REPO
  "${admin[@]}" apt-get update
  "${admin[@]}" apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  printf 'Docker ya está instalado; conservando la instalación existente.\n'
  missing=()
  if ! "${admin[@]}" docker compose version >/dev/null 2>&1; then
    if [[ "$(dpkg-query -W -f='${Status}' docker.io 2>/dev/null || true)" == 'install ok installed' ]]; then
      missing+=(docker-compose-v2)
    else
      missing+=(docker-compose-plugin)
    fi
  fi
  if ! "${admin[@]}" docker buildx version >/dev/null 2>&1; then
    if [[ "$(dpkg-query -W -f='${Status}' docker.io 2>/dev/null || true)" == 'install ok installed' ]]; then
      missing+=(docker-buildx)
    else
      missing+=(docker-buildx-plugin)
    fi
  fi
  if ((${#missing[@]})); then
    "${admin[@]}" apt-get install -y "${missing[@]}"
  fi
fi
"${admin[@]}" systemctl enable --now docker
"${admin[@]}" docker info >/dev/null
"${admin[@]}" docker compose version
"${admin[@]}" docker buildx version

if [[ -L .env ]]; then
  echo '.env es un enlace simbólico. Usa un archivo regular para la configuración.' >&2
  exit 1
fi
created=false
if [[ ! -e .env ]]; then
  (umask 077; cp .env.example .env)
  created=true
fi
[[ -f .env ]] || { echo '.env debe ser un archivo regular.' >&2; exit 1; }
# Mantenerlo editable desde VS Code incluso si se invoca sudo ./preparar.sh.
owner="${SUDO_USER:-$(id -un)}"
if [[ "$owner" == root ]]; then owner="$(stat -c '%U' "$project_dir")"; fi
"${admin[@]}" chown "$owner:$(id -gn "$owner")" .env
"${admin[@]}" chmod 0600 .env
if $created; then
  printf '\nSe creó .env. Completa ADMIN_USER, ADMIN_PASSWORD (12+ caracteres) y WEBHOOK_TOKEN (24+ caracteres).\n'
  printf 'Después ejecuta: ./preparar.sh --iniciar\n'
  exit 0
fi

# Compose interpreta .env; no usar source ni imprimir credenciales.
compose=("${admin[@]}" docker compose --project-directory "$project_dir" --env-file "$project_dir/.env")
"${compose[@]}" config --format json | python3 -c '
import json,sys
c=json.load(sys.stdin)
e=c["services"]["alertas"]["environment"]
errors=[]
for name,minimum in [("ADMIN_USER",1),("ADMIN_PASSWORD",12),("WEBHOOK_TOKEN",24)]:
    if len(str(e.get(name) or ""))<minimum:
        errors.append(f"{name}: requiere al menos {minimum} caracteres")
if errors:
    print("Corrige .env:\n"+"\n".join(errors),file=sys.stderr)
    sys.exit(1)
print("Configuración válida.")
'
if $start; then
  "${compose[@]}" up -d --build --wait --wait-timeout 180
  "${compose[@]}" ps
  printf '\nProyecto iniciado por HTTP en el puerto PORT de .env (9012 por defecto).\n'
else
  printf '\nDependencias listas. Para construir y arrancar: ./preparar.sh --iniciar\n'
fi
