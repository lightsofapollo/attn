#!/bin/bash
# Generate color palette with Rampa
# Usage: ./generate.sh "#3b82f6" [options]

COLOR="${1:-#3b82f6}"
shift

npx @basiclines/rampa -C "$COLOR" "$@"
