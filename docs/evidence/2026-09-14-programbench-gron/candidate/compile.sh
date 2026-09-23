#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cp gron.py executable
if [ ! -x executable ]; then
    chmod +x executable
fi
