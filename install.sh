#!/usr/bin/env bash
# Install the extension for the current user.
#
#   ./install.sh          symlink the repo into the extensions directory
#   ./install.sh --copy   copy the repo instead (for a stable install)
set -euo pipefail

SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UUID="$(python3 -c "import json; print(json.load(open('${SRC}/metadata.json'))['uuid'])")"
DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

mkdir -p "$(dirname -- "${DEST}")"
rm -rf -- "${DEST}"

if [[ "${1:-}" == "--copy" ]]; then
    cp -r -- "${SRC}" "${DEST}"
    echo "Copied ${SRC} -> ${DEST}"
else
    ln -s -- "${SRC}" "${DEST}"
    echo "Symlinked ${DEST} -> ${SRC}"
fi

echo
echo "Next steps:"
echo "  gnome-extensions enable ${UUID}"
echo "  # If it does not appear, restart the shell: press Alt+F2, type 'r', Enter (X11 only),"
echo "  # or log out and back in."
