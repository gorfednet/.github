# Declared: anal0g.org's nginx-routes.conf in the repository (its backlog already says the
# file does not match the server). default-src 'none' is strict; the chat worker lives on
# *.workers.dev. Enable after the injection check.
add_header Content-Security-Policy "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self' https://anal0g.org https://*.anal0g.org https://*.workers.dev; img-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; manifest-src 'self'; upgrade-insecure-requests" always;
