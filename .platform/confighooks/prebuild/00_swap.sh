#!/bin/bash
# A t3.micro has 1 GB of RAM. On first start the server peaks at ~850 MB while the
# embedded PostgreSQL initialises and the demo data is seeded, which the kernel's
# out-of-memory killer stops (nginx then returns 502). A 2 GB swap file absorbs
# the start-up spike. Idempotent: safe on every deploy and config change.
set -euo pipefail
SWAPFILE=/var/swapfile
if swapon --show=NAME --noheadings | grep -qx "$SWAPFILE"; then
  echo "swap already active"
  exit 0
fi
if [ ! -f "$SWAPFILE" ]; then
  fallocate -l 2G "$SWAPFILE" || dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
fi
swapon "$SWAPFILE"
echo "swap enabled: $(swapon --show --noheadings)"
