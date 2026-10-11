# Every project exposes the same three targets so judges and CI run it the same way.
.PHONY: run test lint
# make run reads .env when there is one (Node 20.6 or later), so keys stay out of the shell history.
run:
	node $(if $(wildcard .env),--env-file=.env) src/server.js
test:
	node --test test/*.test.js
lint:
	for f in src/*.js; do node --check $$f || exit 1; done
