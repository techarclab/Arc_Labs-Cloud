# Shared helpers: pick local PostgreSQL client tools if their major version is new enough,
# otherwise run them from the official Docker image of the server's version.
run_pg() {
  if [ "${PG_MODE:-local}" = docker ]; then
    local tool="$1"; shift
    docker run --rm -i --network host "postgres:${SERVER_MAJOR}" "$tool" "$@"
  else
    "$@"
  fi
}
pg_tools_for() {
  local url="$1"
  SERVER_MAJOR=""
  if command -v psql >/dev/null 2>&1; then
    SERVER_MAJOR=$(psql "$url" -Atqc "SELECT current_setting('server_version_num')::int / 10000" 2>/dev/null || true)
  fi
  if [ -z "$SERVER_MAJOR" ] && command -v docker >/dev/null 2>&1; then
    SERVER_MAJOR=$(docker run --rm --network host postgres:18 psql "$url" -Atqc "SELECT current_setting('server_version_num')::int / 10000")
  fi
  [ -n "$SERVER_MAJOR" ] || { echo "Can't reach the database (need psql or Docker)."; exit 1; }
  local local_major=0
  command -v pg_dump >/dev/null 2>&1 && local_major=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
  if [ "$local_major" -ge "$SERVER_MAJOR" ]; then PG_MODE=local; else PG_MODE=docker; fi
  export PG_MODE SERVER_MAJOR
}
pg_restore_major() {
  # Major version of the server the dump came from (from the dump header), default 16.
  local v
  v=$(pg_restore -l "$1" 2>/dev/null | grep -m1 'Dumped from database version' | grep -oE '[0-9]+' | head -1 || true)
  echo "${v:-16}"
}
