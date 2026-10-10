# Every project exposes the same three targets so judges and CI run it the same way.
.PHONY: run test lint
run:
	node src/server.js
test:
	node --test test/*.test.js
lint:
	for f in src/*.js; do node --check $$f || exit 1; done
