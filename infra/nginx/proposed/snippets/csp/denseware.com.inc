# Declared: denseware.com's .htaccess, which Apache would read and nginx never did.
# Enable after the injection check.
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'self'; form-action 'self'; upgrade-insecure-requests" always;
