#!/bin/bash
# Persistent folder for the embedded database and uploaded PDFs.
# Lives outside /var/app/current, so data survives each GitHub deploy
# (it is lost only if the EC2 instance itself is replaced).
set -euo pipefail
mkdir -p /var/app/granttrail-data
chown -R webapp:webapp /var/app/granttrail-data
chmod 700 /var/app/granttrail-data
