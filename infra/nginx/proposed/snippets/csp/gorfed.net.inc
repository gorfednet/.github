# Declared: the meta CSP build/shared_head.py writes on every gorfed.net page, with the
# contact page's web3forms connect-src folded in (the meta keeps the tighter policy per
# page). Enable only after the injection check in gorfed.net's e2e passes.
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'sha256-FGrAxLXUYaj5BOkXs9oFZXhXtXtY/WF7rgbMl8CumOc='; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.web3forms.com; worker-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests" always;
