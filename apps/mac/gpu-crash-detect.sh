#!/bin/bash -e

LOG=/private/var/log/system.log
COUNT_FILE=/tmp/gpu-crash-count
CURRENT=$(grep -c DumpGPURestart $LOG)
APPSCRIPT='display notification "New gpu crashed log found" with title "GPU Crashed"'

echo "Check at $(date)"

if [[ -e $COUNT_FILE ]]; then
    OLD=$(<$COUNT_FILE)
    [[ $CURRENT != $OLD ]] && osascript -e "$APPSCRIPT"
else
    echo 'Init crash count'
fi

echo $CURRENT > $COUNT_FILE
