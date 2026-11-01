#!/bin/zsh
cd -- "${0:A:h}"
node scripts/companions-play.js
read -k 1 '?Press any key to close.'
