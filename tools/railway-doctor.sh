#!/usr/bin/env bash
# Collects Railway status, service settings (variables removed) and recent logs into
# railway-doctor.txt so they can be reviewed.   Usage:  bash tools/railway-doctor.sh
set -uo pipefail
cd "$(dirname "$0")/.."
R=".railway-cli/node_modules/.bin/railway"
[ -f "$R" ] || { echo "Run  bash tools/railway-deploy.sh  first (it installs the Railway tool)."; exit 1; }
OUT=railway-doctor.txt
{
  echo "### railway-doctor $(date)"
  echo; echo "### service status"
  for s in api emqx worker; do echo "--- $s"; "$R" service status --service "$s" 2>&1 | head -20; done
  echo; echo "### service settings (variables removed)"
  "$R" environment config --json 2>&1 | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const j=JSON.parse(s);
        const strip=o=>{ if(o&&typeof o==="object"){ for(const k of Object.keys(o)){ if(k==="variables"||k==="sharedVariables") o[k]="<removed>"; else strip(o[k]); } } };
        strip(j); console.log(JSON.stringify(j,null,1));
      } catch { console.log("(could not read config)\n"+s.split("\n").filter(l=>!/=/.test(l)).slice(0,40).join("\n")); }
    })'
  for s in api worker emqx; do
    echo; echo "### $s BUILD log (last 60 lines)"; "$R" logs --service "$s" --build --lines 60 2>&1 | tail -60
    echo; echo "### $s DEPLOY log (last 60 lines)"; "$R" logs --service "$s" --deployment --lines 60 2>&1 | tail -60
  done
} > "$OUT" 2>&1
echo "Saved $OUT ($(wc -l < "$OUT") lines). Tell Claude it's ready."
