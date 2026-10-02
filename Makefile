UUID  := $(shell python3 -c "import json; print(json.load(open('metadata.json'))['uuid'])")
ZIP   := $(UUID).shell-extension.zip

.PHONY: install copy uninstall enable disable pack clean

install:
	./install.sh

copy:
	./install.sh --copy

uninstall:
	gnome-extensions disable $(UUID) || true
	rm -rf "$(HOME)/.local/share/gnome-shell/extensions/$(UUID)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

pack:
	mkdir -p dist
	gnome-extensions pack --force \
		--extra-source=icons \
		--extra-source=README.md \
		--extra-source=LICENSE \
		-o dist .
	@echo "Created dist/$(ZIP)"

clean:
	rm -rf dist
